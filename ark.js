#!/usr/bin/env node
/**
 * ark.js — Ark Web 快速层 v3 (兼容入口)
 *
 * 所有能力已统一到 client/browser-client.js (唯一 CLI + API 库),
 * 本文件仅为快捷别名, 转发到 browser-client。
 *
 * 用法:
 *   node ark.js status
 *   node ark.js open https://example.com
 *   node ark.js chain "open https://x" "wait-load" "page-info"
 */

const { spawnSync } = require('child_process');
const path = require('path');

const clientPath = path.join(__dirname, 'client', 'browser-client.js');
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('用法: node ark.js <命令> [参数...]   (等价于 node client/browser-client.js)');
  console.log('链式: node ark.js chain "cmd args" "cmd2 args" ...');
  process.exit(1);
}

const r = spawnSync(process.execPath, [clientPath, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
