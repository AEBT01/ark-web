#!/usr/bin/env node
/**
 * check-endpoints.js — 路由与端点文档的一致性检查（双向）
 *
 * 历史教训：本脚本原先靠正则去抓 bridge-server.js 里的 `case '/x':` 与 listEndpoints()
 * 声明。重构把巨型 switch 拆成 capabilities/* 之后，两个正则都抓不到东西，
 * 于是它输出"switch 路由 0 个 / 声明 0 个 / ✓ 完全一致" —— 0 对 0 的空洞通过，
 * 还一直在 CI 里报绿。这类"检查本身失效"比没有检查更危险。
 *
 * 现在的做法：直接加载能力模块（它们只导出对象，无副作用），取真实路由表，
 * 与 server/core/endpoint-docs.js 双向比对：
 *   · 有路由没说明 → undocumented（要求补文档）
 *   · 有说明没路由 → stale（要求删说明）
 * 任一非空即失败（退出码 1）。
 *
 * 用法: node scripts/check-endpoints.js [--list]
 */

const path = require('path');

const caps = require(path.join(__dirname, '..', 'server', 'capabilities'));
const docs = require(path.join(__dirname, '..', 'server', 'core', 'endpoint-docs'));

/** 从文档行里取出路径，如 "GET  /status" → /status、"POST /agent/confirm {id,approve}" → /agent/confirm
 *  参数占位符两种写法都接受：文档里习惯写 <id>，注册表里是 :id —— 归一化后再比。 */
function docPath(line) {
  const m = /^(?:GET|POST|ANY|PUT|DELETE)\s+([^\s?]+)/i.exec(String(line || '').trim());
  if (!m) return null;
  return m[1].replace(/<([^>]+)>/g, ':$1');
}

function main() {
  const routes = new Map();   // path → capability
  for (const c of caps) {
    for (const p of Object.keys(c.routes || {})) {
      if (!routes.has(p)) routes.set(p, c.name);
    }
  }

  const documented = new Map();   // path → 原始说明行
  const nonPathLines = [];
  for (const line of docs) {
    const p = docPath(line);
    if (p) { if (!documented.has(p)) documented.set(p, line); }
    else nonPathLines.push(line);   // "通用: …" 这类说明行
  }

  if (process.argv.includes('--list')) {
    for (const [p, cap] of routes) console.log(p + '   [' + cap + ']');
    console.log('');
    console.log('路由 ' + routes.size + ' 个，文档 ' + documented.size + ' 条');
    return;
  }

  console.log('路由（能力模块声明）: ' + routes.size + ' 个，跨 ' + caps.length + ' 个能力域');
  console.log('端点文档            : ' + documented.size + ' 条（另有 ' + nonPathLines.length + ' 行通则说明）');
  console.log('');

  // 防御：任何一边为 0 都说明检查本身失效了（0 对 0 的假绿正是历史事故）
  if (!routes.size) { console.error('✗ 没取到任何路由 —— 提取逻辑已失效，检查无意义'); process.exit(1); }
  if (!documented.size) { console.error('✗ 没取到任何端点文档 —— 提取逻辑已失效，检查无意义'); process.exit(1); }

  const undocumented = [...routes.keys()].filter((p) => !documented.has(p));
  const stale = [...documented.keys()].filter((p) => !routes.has(p));

  let bad = 0;
  if (undocumented.length) {
    bad++;
    console.error('✗ ' + undocumented.length + ' 个路由缺少说明（请在 server/core/endpoint-docs.js 补上）:');
    for (const p of undocumented) console.error('    ' + p + '   [' + routes.get(p) + ']');
  }
  if (stale.length) {
    bad++;
    console.error('✗ ' + stale.length + ' 条说明已失效（无对应路由，请删除）:');
    for (const p of stale) console.error('    ' + p);
  }
  console.log(bad ? '' : '✓ 路由与端点文档完全一致（' + routes.size + ' 个，双向零漂移）');
  process.exit(bad ? 1 : 0);
}

main();
