#!/usr/bin/env node
/**
 * mock-server.js — 本地 mock 测试场(免登录复杂操作)
 *
 * 静态目录按顺序取第一个存在的：
 *   1. MOCK_DIR 环境变量（自定义夹具）
 *   2. verify/fixtures/mock-site —— 随仓库分发的夹具，新机器上直接可跑
 *   3. data/mock-site —— 老的运行时目录（早期只放在 gitignore 里，换机后套件全线跑不起来）
 * 端口默认 8899（验证套件断言的就是这个地址），可用 MOCK_PORT 覆盖。
 * 用法: node scripts/mock-server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function pickRoot() {
  const cands = [
    process.env.MOCK_DIR,
    path.join(__dirname, '..', 'verify', 'fixtures', 'mock-site'),
    path.join(__dirname, '..', 'data', 'mock-site')
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch (e) { /* 试下一个 */ }
  }
  return cands[cands.length - 1];
}
const ROOT = pickRoot();
const PORT = parseInt(process.env.MOCK_PORT || '8899', 10);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 not found: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] http://127.0.0.1:${PORT}  <- ${ROOT}`);
});
