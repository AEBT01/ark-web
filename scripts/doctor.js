#!/usr/bin/env node
/**
 * doctor.js — 环境自检（专治"我改了代码但浏览器没生效"）
 *
 * 做四件事:
 *   1. 找出机器上所有 Ark Web 项目副本, 并对关键文件做指纹比对(发现漂移)
 *   2. 从 Chrome / Quark 的用户数据里读出"浏览器实际加载的扩展目录是哪一个"
 *   3. 询问运行中的 server: 插件上报的版本 / 端口 / 安全状态
 *   4. 给出结论与修复动作
 *
 * 用法: node scripts/doctor.js [--json]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SELF_ROOT = path.resolve(__dirname, '..');
const HASH_FILES = [
  'extension/background.js',
  'extension/popup.js',
  'extension/popup.html',
  'extension/manifest.json',
  'server/bridge-server.js',
  'client/browser-client.js',
  'SKILL.md'
];
const SKIP_DIRS = new Set(['node_modules', 'AppData', 'Application Data', '.git', 'dist', 'legacy', 'chrome-profile', '.cache', '$Recycle.Bin']);

// 指纹统一按"行尾归一化(LF)"计算: 副本可能来自不同渠道(git 检出为 CRLF / sync 复制为 LF),
// 内容相同但行尾不同会造成假漂移, 不应误报
const hashOf = (f) => { try { const t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); return crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 8); } catch { return '--------'; } };
const isArkRoot = (dir) => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'extension', 'manifest.json'), 'utf8'));
    return /ark\s*web/i.test(m.name || '') || /ArkWeb|ark-web/i.test(m.description || '');
  } catch { return false; }
};

/** 1) 扫描项目副本(限定深度, 跳过重型目录) */
function findCopies() {
  const found = new Set();
  if (isArkRoot(SELF_ROOT)) found.add(SELF_ROOT);
  const roots = [os.homedir(), path.join(os.homedir(), 'Desktop')];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (isArkRoot(full)) { found.add(full); continue; }
      walk(full, depth + 1);
    }
  };
  for (const r of roots) walk(r, 1);
  return [...found];
}

/** 2) 浏览器实际加载的扩展目录 */
function findLoadedPaths() {
  const hits = [];
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Quark', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Chromium', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data')
  ];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const profile of ['Default', 'Profile 1', 'Profile 2', 'Profile 3']) {
      for (const file of ['Secure Preferences', 'Preferences']) {
        const p = path.join(root, profile, file);
        let txt;
        try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
        if (!/ark-web|browser-debug-extension/i.test(txt)) continue;
        // 浏览器名: 取 "<vendor>\\<Product>\\User Data" 里的 Product
        const parts = root.split(path.sep);
        const ui = parts.indexOf('User Data');
        const browser = parts[ui - 1] || 'Browser';
        const re = /"path"\s*:\s*"([^"]*(?:ark-web|browser-debug-extension)[^"]*)"/g;
        let m;
        while ((m = re.exec(txt)) !== null) {
          const dir = m[1].replace(/\\\\/g, '\\');
          if (!hits.some(h => h.dir === dir && h.browser === browser && h.profile === profile)) {
            hits.push({ browser, profile, dir });
          }
        }
      }
    }
  }
  return hits;
}

/** 3) 问运行中的 server */
function askServer() {
  return new Promise((resolve) => {
    let conn;
    try { conn = require('../client/browser-client').resolveConnection(); } catch { return resolve({ error: '无法加载 client' }); }
    const req = http.request({
      hostname: conn.host, port: conn.port, path: '/status', method: 'GET', timeout: 4000,
      headers: conn.token ? { 'X-Ark-Token': conn.token } : {}
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ port: conn.port, tokenSource: conn.tokenSource, ...JSON.parse(d) }); }
        catch { resolve({ error: '响应解析失败', raw: d.slice(0, 200) }); }
      });
    });
    req.on('error', e => resolve({ error: `server 未响应(${e.message})` }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'server 无响应(超时)' }); });
    req.end();
  });
}

(async () => {
  const asJson = process.argv.includes('--json');
  const copies = findCopies();
  const loaded = findLoadedPaths();
  const server = await askServer();

  const report = { selfRoot: SELF_ROOT, copies: [], loadedPaths: loaded, server: null, problems: [], actions: [] };

  // 副本指纹
  const selfHashes = {};
  for (const f of HASH_FILES) selfHashes[f] = hashOf(path.join(SELF_ROOT, f));
  for (const c of copies) {
    const row = { root: c, self: c === SELF_ROOT, manifestVersion: null, drift: [] };
    try { row.manifestVersion = JSON.parse(fs.readFileSync(path.join(c, 'extension', 'manifest.json'), 'utf8')).version; } catch {}
    for (const f of HASH_FILES) {
      const h = hashOf(path.join(c, f));
      if (!row.self && h !== selfHashes[f]) row.drift.push(f);
    }
    report.copies.push(row);
  }

  // server 侧
  if (server.error) {
    report.problems.push(`Bridge Server 未响应: ${server.error}`);
    report.actions.push('启动 server: node server/bridge-server.js');
  } else {
    report.server = { port: server.port, connected: server.connected, serverVersion: server.serverVersion, plugin: server.plugin || null, security: server.security || null, tokenSource: server.tokenSource };
    if (!server.connected) {
      report.problems.push('插件未连接到 server(WS 未建立)');
      report.actions.push('确认扩展已加载，并运行 node scripts/label-browsers.js --yes 登记本机扩展 ID');
    }
    const localVer = report.copies.find(c => c.self)?.manifestVersion;
    if (server.plugin?.version && localVer && server.plugin.version !== localVer) {
      report.problems.push(`插件运行版本(${server.plugin.version}) ≠ 本地代码版本(${localVer}) —— 浏览器里跑的不是最新代码`);
    }
  }

  // 浏览器加载路径 vs 各副本
  const loadedRoots = loaded.map(l => path.resolve(l.dir, '..'));
  for (const l of loaded) {
    const root = path.resolve(l.dir, '..');
    const known = report.copies.find(c => path.resolve(c.root).toLowerCase() === root.toLowerCase());
    if (!known) {
      report.problems.push(`${l.browser}(${l.profile}) 加载的目录不在已识别的副本列表中: ${l.dir}`);
    } else if (known.drift.length) {
      report.problems.push(`${l.browser} 加载的是另一份副本, 且与当前代码有 ${known.drift.length} 个文件不同: ${known.root}`);
      report.actions.push(`同步改动: node scripts/sync.js --yes   (或 robocopy "${SELF_ROOT}" "${known.root}" extension server client scripts references SKILL.md README.md CHANGELOG.md /E)`);
      report.actions.push('同步后执行 POST /reload-extension(或 chrome://extensions 手动重载)使新代码生效');
    } else {
      report.actions.push(`${l.browser} 已指向本目录; 改完 extension/ 后调用 POST /reload-extension 或手动重载插件`);
    }
  }
  const driftCopies = report.copies.filter(c => !c.self && c.drift.length);
  if (driftCopies.length && !loaded.length) {
    report.actions.push('存在与本地不同的副本(但未检测到浏览器加载路径): 手动确认 chrome://extensions 里的路径');
  }

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log('\n=== Ark Web Doctor ===\n');
  console.log(`当前代码目录: ${report.selfRoot}`);
  console.log(`\n[1] 发现 ${report.copies.length} 个项目副本:`);
  for (const c of report.copies) {
    const tag = c.self ? '(当前/skill)' : (c.drift.length ? `漂移 ${c.drift.length} 个文件` : '与当前一致');
    console.log(`  v${c.manifestVersion || '?'}  ${tag.padEnd(14)}  ${c.root}`);
    if (c.drift.length) console.log(`       差异: ${c.drift.join(', ')}`);
  }
  console.log(`\n[2] 浏览器实际加载的扩展目录:`);
  if (!loaded.length) console.log('  (未检测到; 可能是其他浏览器或未安装)');
  for (const l of loaded) console.log(`  ${l.browser} / ${l.profile}  →  ${l.dir}`);
  console.log(`\n[3] Bridge Server:`);
  if (report.server) {
    console.log(`  :${report.server.port}  connected=${report.server.connected}  server=v${report.server.serverVersion}  plugin=${report.server.plugin ? 'v' + report.server.plugin.version : '未注册'}`);
    if (report.server.security) console.log(`  安全: host=${report.server.security.host} token=${report.server.security.tokenAuth ? 'on' : 'OFF'} wsToken=${report.server.security.wsTokenRequired ? 'on' : 'off'} tokenSource=${report.server.security.tokenSource}`);
  } else {
    console.log(`  ${server.error}`);
  }
  console.log(`\n[4] 结论:`);
  if (!report.problems.length) console.log('  ✓ 未发现漂移, 浏览器加载的就是当前代码');
  else report.problems.forEach(p => console.log(`  ✗ ${p}`));
  if (report.actions.length) {
    console.log('\n[5] 建议动作:');
    report.actions.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
  }
  console.log('');
  process.exit(report.problems.length ? 1 : 0);
})();
