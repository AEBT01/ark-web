/**
 * 一次性剪接：从 bridge-server.js 中删除已拆解为 capabilities/* 的 handleHTTPRequest 巨型方法
 * 定位方式：从 `async handleHTTPRequest(req, res) {` 到其后第一个"独立两空格 `}`"（即下一个方法前的收尾）
 */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'server', 'bridge-server.js');
const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);

const start = lines.findIndex(l => /^\s{2}async handleHTTPRequest\(req, res\) \{$/.test(l));
if (start < 0) throw new Error('找不到 handleHTTPRequest');

// 结束锚点：下一个方法 resolveCacheTab 之前的第一个独立 `  }`
const anchor = lines.findIndex((l, i) => i > start && /^\s{2}resolveCacheTab\(\) \{$/.test(l));
if (anchor < 0) throw new Error('找不到 resolveCacheTab 锚点');

let end = -1;
for (let i = anchor - 1; i > start; i--) {
  if (lines[i] === '  }') { end = i; break; }
}
if (end < 0) throw new Error('找不到方法结束位置');

const removed = end - start + 1;
const head = lines.slice(0, start);
const tail = lines.slice(end + 1);
const stub = [
  '  /**',
  '   * HTTP 请求处理已移至 core/http-shell.js（传输层）与 capabilities/*（业务层）。',
  '   * 本方法由构造函数装配：this.handleHTTPRequest = createHttpShell(this, this.router, {...})。',
  '   * 之所以保留这个占位，是为了让"入口在哪"有据可查，而不是留下一个隐形的实例属性。',
  '   */'
];
fs.writeFileSync(FILE, head.concat(stub, tail).join('\n'));
console.log(`已删除 handleHTTPRequest：第 ${start + 1} 行 → 第 ${end + 1} 行，共 ${removed} 行`);
console.log(`文件行数：${lines.length} → ${head.length + stub.length + tail.length}`);
