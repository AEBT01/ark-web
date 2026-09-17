#!/usr/bin/env node
/**
 * check-syntax.js —— 全仓 JS 语法检查（跨平台，替代 find|xargs 那套 shell 写法）
 *
 * 为什么单独成脚本：CI 里用 shell 拼的 find|xargs 在 Windows 上跑不了，
 * 而本机验证又想要同一条检查 —— 写成 Node 就两边一致。
 *
 * 用法: node scripts/check-syntax.js [--quiet]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.sync-backup-panel-2026', 'l10n-backup', 'evidence', 'chrome-profile']);
const SKIP_RE = [/^\.sync-backup/, /^dist$/, /^data$/, /^reports$/];

function walk(dir, out, rel) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const relChild = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || SKIP_RE.some((r) => r.test(ent.name))) continue;
      walk(path.join(dir, ent.name), out, relChild);
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      out.push({ rel: relChild, abs: path.join(dir, ent.name) });
    }
  }
}

function main() {
  const files = [];
  walk(ROOT, files, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f.abs], { encoding: 'utf8' });
    if (r.status !== 0) bad.push({ rel: f.rel, err: String(r.stderr || '').split('\n').slice(0, 3).join(' | ') });
  }

  if (bad.length) {
    console.error('✗ ' + bad.length + ' 个文件语法错误:');
    for (const b of bad) console.error('    ' + b.rel + '  →  ' + b.err.slice(0, 160));
    process.exit(1);
  }
  if (!QUIET) console.log('✓ ' + files.length + ' 个 JS 文件语法正确');
}

main();
