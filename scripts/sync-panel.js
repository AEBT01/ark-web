/**
 * Ark 助手（侧边栏面板）同步脚本
 *
 * 背景：浏览器加载的是运行副本（如 C:\Users\画扇\ark-panel），仓库里的 panel/ 才是源。
 *       面板的扩展 ID 由加载路径决定，换路径会丢 chrome.storage（工作页绑定、设置），
 *       所以约定「仓库为源、副本为运行位置」，用本脚本单向同步。
 *
 * 用法：
 *   node scripts/sync-panel.js                 # 提示性输出（列出目标与差异，不写入）
 *   node scripts/sync-panel.js --yes           # 执行同步
 *   node scripts/sync-panel.js --to=<dir> --yes # 指定目标（默认自动发现浏览器加载的副本）
 *   node scripts/sync-panel.js --json          # 机器可读输出（供 doctor/CI 用）
 *
 * 安全：仓库里的 panel/config.js 不含令牌；本脚本读取 ~/.ark-web/token 注入到副本，
 *       使运行副本可用而源码里永远没有秘密。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'panel');

/** 面板源码文件（只同步这些；副本里的其他文件不动、不删） */
const FILES = ['manifest.json', 'panel.html', 'panel.css', 'panel.js', 'bg.js', 'floating.js', 'config.js'];

/** 面板运行的扩展目录名（用于在浏览器配置里识别加载路径） */
const DIR_HINTS = ['ark-panel'];
const DIR_EXCLUDE = ['ark-panel-probe'];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => {
  const hit = argv.find((a) => a.startsWith(f + '='));
  return hit ? hit.slice(f.length + 1) : null;
};
const YES = has('--yes');
const JSON_OUT = has('--json');
const EXPLICIT = argOf('--to');

/** 浏览器配置目录：扫描 Preferences 里登记的未打包扩展路径 */
function candidateProfiles() {
  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'BrowserClaw', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Quark', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Chromium', 'User Data'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data')
  ];
  const out = [];
  for (const base of bases) {
    if (!base || !fs.existsSync(base)) continue;
    out.push(path.join(base, 'Default', 'Preferences'));
    out.push(path.join(base, 'Default', 'Secure Preferences'));
  }
  return out.filter((f) => fs.existsSync(f));
}

/** 从浏览器配置里找出面板的运行副本目录 */
function discoverTargets() {
  const found = new Set();
  for (const file of candidateProfiles()) {
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    for (const m of txt.matchAll(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      let p = '';
      try { p = JSON.parse('"' + m[1] + '"'); } catch (e) { continue; }
      const base = path.basename(p).toLowerCase();
      if (!DIR_HINTS.some((h) => base.includes(h))) continue;
      if (DIR_EXCLUDE.some((h) => base.includes(h))) continue;
      if (!fs.existsSync(path.join(p, 'manifest.json'))) continue;
      found.add(path.resolve(p));
    }
  }
  return [...found];
}

/** 确认目录确实是我们这个面板 */
function looksLikePanel(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return !!(m && (m.side_panel || /Ark\s*助手/.test(m.name || '')));
  } catch (e) { return false; }
}

function sharedToken() {
  const f = path.join(os.homedir(), '.ark-web', 'token');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    return t || '';
  } catch (e) { return ''; }
}

/** 源码 config.js + 注入令牌 → 目标文件内容 */
function configWithToken(token) {
  const src = fs.readFileSync(path.join(SRC, 'config.js'), 'utf8');
  if (!token) return src;
  return src.replace(/token\s*:\s*''/, "token: '" + token + "'");
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('找不到面板源码目录: ' + SRC);
    process.exit(1);
  }
  const missing = FILES.filter((f) => !fs.existsSync(path.join(SRC, f)));
  if (missing.length) {
    console.error('面板源码缺文件: ' + missing.join(', '));
    process.exit(1);
  }

  let targets = EXPLICIT ? [path.resolve(EXPLICIT)] : discoverTargets();
  targets = targets.filter((t) => t.toLowerCase() !== SRC.toLowerCase());
  const token = sharedToken();

  if (!JSON_OUT) {
    console.log('面板同步（仓库 panel/ → 浏览器加载的副本）');
    console.log('  源    : ' + SRC);
    console.log('  令牌  : ' + (token ? '已从 ~/.ark-web/token 读取（将注入副本 config.js）' : '未找到 ~/.ark-web/token（副本 config.js 将留空，面板会提示未配对）'));
    console.log('  目标  : ' + (targets.length ? targets.join(', ') : '未发现（用 --to=<dir> 指定）'));
  }

  if (!targets.length) {
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, reason: 'no-target', targets: [] }, null, 2));
    else console.log('\n未发现浏览器加载的面板副本。若面板尚未加载，请在浏览器 chrome://extensions 里「加载已解压的扩展程序」指向仓库的 panel/ 目录。');
    process.exit(EXPLICIT ? 1 : 0);
  }

  const bad = targets.filter((t) => !looksLikePanel(t));
  if (bad.length) {
    console.error('\n以下目录不像 Ark 助手面板，已跳过: ' + bad.join(', '));
  }
  const use = targets.filter((t) => looksLikePanel(t));
  if (!use.length) process.exit(1);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(ROOT, '.sync-backup-panel-' + stamp);
  const result = [];

  for (const dir of use) {
    const changed = [];
    for (const f of FILES) {
      const srcFile = path.join(SRC, f);
      const dstFile = path.join(dir, f);
      const next = f === 'config.js' ? configWithToken(token) : fs.readFileSync(srcFile, 'utf8');
      let prev = null;
      try { prev = fs.readFileSync(dstFile, 'utf8'); } catch (e) { prev = null; }
      if (prev === next) continue;
      changed.push(f);
      if (!YES) continue;
      if (prev !== null) {
        const bakDir = path.join(backupDir, path.basename(dir));
        fs.mkdirSync(bakDir, { recursive: true });
        fs.writeFileSync(path.join(bakDir, f), prev, 'utf8');
      }
      fs.writeFileSync(dstFile, next, 'utf8');
    }
    result.push({ dir, changed });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: YES, tokenFound: !!token, backupDir: YES ? backupDir : null, result }, null, 2));
    return;
  }

  console.log('');
  for (const r of result) {
    console.log('  ' + r.dir);
    console.log('    ' + (r.changed.length ? (YES ? '已更新: ' : '待更新: ') + r.changed.join(', ') : '已是最新'));
  }
  if (!YES) {
    console.log('\n这是预演。加 --yes 才会写入。');
    return;
  }
  const anyChanged = result.some((r) => r.changed.length);
  if (anyChanged) console.log('\n旧文件备份在: ' + backupDir);
  console.log('下一步: 在浏览器里重开侧边栏（改了 manifest.json 需在 chrome://extensions 重载面板扩展）。\n');
}

main();
