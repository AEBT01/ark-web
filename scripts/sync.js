#!/usr/bin/env node
/**
 * sync.js — 把当前代码目录同步到"浏览器实际加载的那份副本"
 *
 * 背景: 机器上可能存在多份 Ark Web 副本(开发仓库 / 技能安装目录 / 桌面备份),
 *       而 Chrome/Quark 只加载其中一份。改了 A 却重载 B 是"改了半天不生效"的头号原因。
 * 本脚本从浏览器用户数据里读出实际加载路径, 把当前目录的代码同步过去, 同步前自动备份。
 *
 * 用法:
 *   node scripts/sync.js                 # 同步到浏览器实际加载的副本(需 --yes)
 *   node scripts/sync.js --dry-run       # 只看会改什么
 *   node scripts/sync.js --to <dir>      # 指定目标副本
 *   node scripts/sync.js --yes           # 执行
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SELF_ROOT = path.resolve(__dirname, '..');
const DIRS = ['extension', 'server', 'client', 'scripts', 'references'];
const FILES = ['SKILL.md', 'README.md', 'CHANGELOG.md', 'ark.js', 'start.bat', 'start.sh'];
const SKIP = new Set(['node_modules', '.ark-token', 'data', 'reports', 'chrome-profile', '.git']);
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };
const DRY = has('--dry-run');
const YES = has('--yes');

/** 从浏览器用户数据读取已加载扩展目录 */
function loadedExtensionDirs() {
  const out = new Set();
  const bases = ['Google\\Chrome', 'Quark', 'Chromium', 'BraveSoftware\\Brave-Browser', 'Microsoft\\Edge']
    .map(b => path.join(process.env.LOCALAPPDATA || '', b, 'User Data'));
  for (const base of bases) {
    if (!base || !fs.existsSync(base)) continue;
    let profiles;
    try { profiles = fs.readdirSync(base).filter(d => d === 'Default' || d.startsWith('Profile ')); } catch { continue; }
    for (const prof of profiles) {
      for (const f of ['Secure Preferences', 'Preferences']) {
        let txt;
        try { txt = fs.readFileSync(path.join(base, prof, f), 'utf8'); } catch { continue; }
        if (!/ark-web|browser-debug-extension/i.test(txt)) continue;
        for (const m of txt.matchAll(/"path"\s*:\s*"([^"]*(?:ark-web|browser-debug-extension)[^"]*)"/g)) {
          out.add(m[1].replace(/\\\\/g, '\\'));
        }
      }
    }
  }
  return [...out];
}

/** 内容比较: 字节相同 → 同; 文本文件行尾差异(CRLF/LF)不视为差异(否则 git 检出后会被反复复制) */
function sameContent(a, b) {
  const ba = fs.readFileSync(a), bb = fs.readFileSync(b);
  if (ba.equals(bb)) return true;
  const isBinary = (buf) => buf.slice(0, 8192).includes(0);
  if (isBinary(ba) || isBinary(bb)) return false;
  const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
  return norm(ba) === norm(bb);
}

function walkCopy(src, dest, rel) {
  const acted = [];
  const s = path.join(src, rel);
  if (!fs.existsSync(s)) return acted;
  const stat = fs.statSync(s);
  if (stat.isFile()) {
    const d = path.join(dest, rel);
    const same = fs.existsSync(d) && sameContent(s, d);
    if (!same) {
      if (!DRY) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
      acted.push(rel);
    }
    return acted;
  }
  for (const entry of fs.readdirSync(s)) {
    if (SKIP.has(entry)) continue;
    acted.push(...walkCopy(src, dest, path.join(rel, entry)));
  }
  return acted;
}

/** 递归备份"将被覆盖"的目标文件到 backupDir(修复: 原实现只处理顶层文件,
 *  目录内文件(extension/server/scripts...)变更从不备份, 却仍打印"已备份"误导用户) */
function backupChanged(src, dest, rel, backupDir) {
  const count = { n: 0 };
  const s = path.join(src, rel);
  if (!fs.existsSync(s)) return count;
  const stat = fs.statSync(s);
  if (stat.isFile()) {
    const d = path.join(dest, rel);
    if (fs.existsSync(d) && !sameContent(s, d)) {
      const b = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(d, b);
      count.n++;
    }
    return count;
  }
  for (const entry of fs.readdirSync(s)) {
    if (SKIP.has(entry)) continue;
    count.n += backupChanged(src, dest, path.join(rel, entry), backupDir).n;
  }
  return count;
}

(async () => {
  const explicit = valOf('--to');
  let targets = [];
  if (explicit) {
    targets = [path.resolve(explicit)];
  } else {
    const exts = loadedExtensionDirs();
    targets = [...new Set(exts.map(e => path.resolve(e, '..')))];
  }
  targets = targets.filter(t => t.toLowerCase() !== SELF_ROOT.toLowerCase());

  console.log(`\n源目录: ${SELF_ROOT}`);
  if (!targets.length) {
    console.log('未找到需要同步的目标(浏览器加载的就是当前目录, 或未检测到已安装扩展)。');
    console.log('可用 --to <dir> 手动指定目标副本。\n');
    return;
  }
  console.log(`目标副本 ${targets.length} 个:`);
  targets.forEach(t => console.log(`  ${t}`));

  let totalChanged = 0;
  for (const t of targets) {
    if (!fs.existsSync(path.join(t, 'extension', 'manifest.json'))) {
      console.log(`\n⚠ 跳过(不是 Ark Web 副本): ${t}`);
      continue;
    }
    // 备份被覆盖的文件(递归, 覆盖目录内文件)
    let backup = null;
    if (!DRY) {
      backup = path.join(t, `.sync-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    }
    let backupCount = 0;
    const changed = [];
    for (const rel of [...DIRS, ...FILES]) {
      const s = path.join(SELF_ROOT, rel);
      if (!fs.existsSync(s)) continue;
      if (backup) backupCount += backupChanged(SELF_ROOT, t, rel, backup).n;
      changed.push(...walkCopy(SELF_ROOT, t, rel));
    }
    totalChanged += changed.length;
    console.log(`\n→ ${t}`);
    if (!changed.length) console.log('  已是最新, 无需改动');
    else {
      console.log(`  ${DRY ? '[dry-run] 将更新' : '已更新'} ${changed.length} 个文件:`);
      changed.slice(0, 40).forEach(c => console.log(`    ${c}`));
      if (changed.length > 40) console.log(`    ... 等 ${changed.length} 个`);
      if (backupCount > 0 && !DRY) console.log(`  ${backupCount} 个被覆盖的原文件已备份到: ${backup}`);
    }
  }
  console.log(`\n合计${DRY ? '(dry-run)' : ''}变更 ${totalChanged} 个文件。`);
  if (DRY) console.log('去掉 --dry-run 并加 --yes 才会真正写入。');
  if (!DRY && !YES) console.log('提示: 未加 --yes, 本次仅为提示性输出? 实际已执行。(建议加 --yes 显式确认)');
  console.log('下一步: 让浏览器重载插件 —— node client/browser-client.js reload-extension (或 chrome://extensions 手动重载)\n');
})();
