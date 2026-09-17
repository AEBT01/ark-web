#!/usr/bin/env node
/**
 * bump-version.js — 版本号统一与打版
 *
 * 用法:
 *   node scripts/bump-version.js                 # 只看当前一致性
 *   node scripts/bump-version.js 3.0.0           # 写入 VERSION 并同步三处清单
 *   node scripts/bump-version.js 3.0.1 --dry-run # 预演，不写文件
 *
 * 三处目标（桥接扩展清单 / 面板清单 / 服务端 package.json）必须一致，
 * 否则 package.js 会拒绝打包 —— 这是为了防止分发包版本与实际内容再对不上。
 */

const v = require('./lib/version');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const next = argv.find((a) => !a.startsWith('--'));

if (next && !v.VERSION_RE.test(next)) {
  console.error('✗ 版本号不合法（应形如 3.0.0 或 3.0.0-beta.1）: ' + next);
  process.exit(1);
}

if (next) {
  const r = v.stamp(next, { dryRun });
  console.log((dryRun ? '[预演] ' : '') + '版本 ' + r.version + ' 已写入 VERSION');
  console.log('同步的文件: ' + (r.changed.length ? r.changed.join(', ') : '（无需改动）'));
}

const c = v.check();
console.log('');
console.log('=== 版本一致性 ===');
console.log('  权威版本（VERSION）: ' + c.version);
for (const t of c.targets) {
  const mark = t.version === c.version ? '✓' : '✗';
  console.log('  ' + mark + ' ' + t.label.padEnd(24) + ' ' + (t.version || '读不到') + '   ' + t.file);
}
console.log('');
if (c.ok) {
  console.log('三处一致。下一步: node scripts/package.js');
} else {
  console.log('不一致。执行 node scripts/bump-version.js ' + c.version + ' 统一三处清单。');
  process.exitCode = 1;
}
