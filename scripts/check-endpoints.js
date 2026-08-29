#!/usr/bin/env node
/**
 * check-endpoints.js — 核对 server 路由表与 listEndpoints 声明是否一致
 * 用法: node scripts/check-endpoints.js
 */
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server', 'bridge-server.js');
const src = fs.readFileSync(serverPath, 'utf8');

// 提取 switch 中的 case 路由
const cases = new Set();
const re = /case\s+'(\/[^']+)':/g;
let m;
while ((m = re.exec(src)) !== null) cases.add(m[1]);

// 提取 listEndpoints 中的路径(仅路径部分, 忽略参数说明)
const listBlock = src.match(/listEndpoints\(\)\s*\{\s*return\s*\[([\s\S]*?)\]\s*;/);
const declared = new Set();
if (listBlock) {
  const re2 = /'(?:GET|POST)\s+(\/[^\s'?]+)/gi;
  let m2;
  while ((m2 = re2.exec(listBlock[1])) !== null) {
    declared.add(m2[1].replace(/\/$/, ''));
  }
}

let issues = 0;
// 前缀路由(带 <id> 等参数占位符): 验证源码中存在对应 startsWith 处理
for (const d of declared) {
  if (d.includes('<')) {
    const prefix = d.split('<')[0].replace(/\/$/, '');
    if (!src.includes(`startsWith('${prefix}`)) {
      console.log(`⚠ 前缀路由未实现: ${d}`);
      issues++;
    }
    continue;
  }
  if (!cases.has(d)) { console.log(`⚠ 已声明但未实现: ${d}`); issues++; }
}
for (const c of cases) {
  if (!declared.has(c)) { console.log(`⚠ 已实现但未声明: ${c}`); issues++; }
}

// 检查默认 404 情况
console.log(`\nswitch 路由: ${cases.size} 个`);
console.log(`listEndpoints 声明: ${declared.size} 个`);
if (issues === 0) {
  console.log('✓ 端点声明与实现完全一致');
} else {
  console.log(`✗ 发现 ${issues} 处不一致`);
  process.exit(1);
}
