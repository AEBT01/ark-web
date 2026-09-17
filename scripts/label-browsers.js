#!/usr/bin/env node
/**
 * label-browsers.js —— 建立「扩展 ID → 浏览器名」映射，供多浏览器定向路由使用
 *
 * 为什么用扩展 ID 而不是 UA 或运行时探测：
 *   · BrowserOS 的 UA 与 Chrome 完全一样，认不出来；
 *   · 在扩展里调 chrome.management.getAll() 探测"同机装了哪些扩展"受服务线程启动时序影响，
 *     首连时经常拿不全（实测反复踩）；
 *   · 而扩展 ID 对"同一份解压目录"是**确定性**的（由路径派生），从浏览器配置里直接读得出来。
 * 于是：扩展注册时上报自己的 ID，服务端按本文件生成的映射给出连接名。
 *
 * 用法:
 *   node scripts/label-browsers.js            # 预演：列出将写入的映射
 *   node scripts/label-browsers.js --yes      # 写入 ~/.ark-web/browser-labels.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.homedir(), '.ark-web', 'browser-labels.json');
const YES = process.argv.includes('--yes');

/**
 * 浏览器用户数据目录 → 连接名 + 内核名。
 * kernel 用于消歧：同一份解压目录被两个浏览器加载时扩展 ID 相同（ID 由路径派生），
 * 光靠 ID 分不清是哪台机器上的哪个浏览器，加上扩展自己上报的内核名就能区分
 * （BrowserOS 的 UA 与 Chrome 同串，报 chrome；夸克报 quark）。
 */
const BROWSERS = [
  { dir: 'BrowserClaw', label: 'browseros', kernel: 'chrome', name: 'BrowserOS' },
  { dir: 'Quark', label: 'quark', kernel: 'quark', name: '夸克' },
  { dir: 'Google\\Chrome', label: 'chrome', kernel: 'chrome', name: 'Chrome' },
  { dir: 'Microsoft\\Edge', label: 'edge', kernel: 'edge', name: 'Edge' },
  { dir: 'Chromium', label: 'chromium', kernel: 'chromium', name: 'Chromium' },
  { dir: 'BraveSoftware\\Brave-Browser', label: 'brave', kernel: 'brave', name: 'Brave' }
];

/** 我们的扩展目录名 → 该目录是"桥接扩展" */
const BRIDGE_DIR_HINTS = ['browser-debug-extension', 'browser-debug-extension-bos'];

function profileFiles(base) {
  const out = [];
  let profiles;
  try { profiles = fs.readdirSync(base).filter((d) => d === 'Default' || /^Profile /.test(d)); } catch (e) { return out; }
  for (const p of profiles) {
    for (const f of ['Secure Preferences', 'Preferences']) {
      const abs = path.join(base, p, f);
      if (fs.existsSync(abs)) out.push(abs);
    }
  }
  return out;
}

function collect() {
  const found = [];
  const base = process.env.LOCALAPPDATA || '';
  for (const b of BROWSERS) {
    const dir = path.join(base, b.dir, 'User Data');
    if (!fs.existsSync(dir)) continue;
    for (const file of profileFiles(dir)) {
      let txt;
      try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
      let json;
      try { json = JSON.parse(txt); } catch (e) { continue; }
      const settings = (json.extensions && json.extensions.settings) || {};
      for (const [id, cfg] of Object.entries(settings)) {
        const p = String((cfg && cfg.path) || '');
        // 注意：配置里记的是扩展根目录（末级通常是 extension），要按"包含"匹配而不是按末级目录名
        if (!BRIDGE_DIR_HINTS.some((h) => p.toLowerCase().includes(h))) continue;
        found.push({ id, label: b.label, kernel: b.kernel, browserName: b.name, path: p });
      }
    }
  }
  // 同一 (ID, 内核) 可能被多个 profile 记录，去重
  const byKey = new Map();
  for (const f of found) {
    const k = f.id + '|' + f.kernel;
    if (!byKey.has(k)) byKey.set(k, f);
  }
  return [...byKey.values()];
}

function main() {
  const list = collect();
  console.log('扫描到的桥接扩展副本:');
  if (!list.length) console.log('  （无）—— 请先在浏览器里加载 extension/ 目录的插件');
  for (const x of list) console.log('  ' + x.id + '|' + x.kernel + '  →  ' + x.label + '（' + x.browserName + '）  ' + x.path);

  const map = {};
  for (const x of list) map[x.id + '|' + x.kernel] = x.label;
  console.log('');
  console.log('将写入 ' + OUT + ':');
  console.log(JSON.stringify(map, null, 2));
  if (!YES) { console.log('\n这是预演。加 --yes 才会写入。'); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(map, null, 2) + '\n', 'utf8');
  console.log('\n✓ 已写入。服务端会在下次插件注册时使用这些连接名（5 秒缓存内生效）。');
}

main();
