#!/usr/bin/env node
/**
 * benchmark.js — Ark Web 原子操作性能基准 v2
 * 分两类:
 *  - 真实链路: ?fresh=1 绕过缓存, 完整 HTTP+WS+CDP 往返
 *  - 缓存命中: 常规调用(服务端缓存)
 * 写操作在本地测试页上执行, 避免失败路径
 * 用法: node scripts/benchmark.js [--rounds 15]
 */
const http = require('http');

const HOST = 'localhost', PORT = 9333;
const ROUNDS = parseInt(process.argv[process.argv.indexOf('--rounds') + 1] || 15, 10);
const agent = new http.Agent({ keepAlive: true, maxSockets: 10 });

const TEST_HTML = `<!DOCTYPE html><html><head><title>Bench</title></head><body>
<h1>Benchmark Page</h1><p class="para">para one</p><p class="para">para two</p>
<input id="user"><button id="btn">Go</button>
<script>window.__bench = 1;</script></body></html>`;

let testServer = null;
function startTestServer() {
  return new Promise((resolve) => {
    testServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(TEST_HTML);
    });
    testServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${testServer.address().port}/`));
  });
}

function req(method, path, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const r = http.request({ hostname: HOST, port: PORT, path, method, agent,
      headers: body ? { 'Content-Type': 'application/json' } : {}, timeout }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        try { resolve({ ms, data: JSON.parse(d) }); }
        catch { resolve({ ms, data: d }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const GET = (p) => req('GET', p);
const POST = (p, b) => req('POST', p, b);

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function bench(name, fn, rounds = ROUNDS) {
  for (let i = 0; i < 2; i++) await fn();
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const r = await fn();
    if (r.ms < 30000) times.push(r.ms);
  }
  const med = median(times);
  console.log(`${name.padEnd(30)} 中位 ${med.toFixed(2).padStart(8)}ms  最快 ${Math.min(...times).toFixed(2).padStart(7)}ms  最慢 ${Math.max(...times).toFixed(2).padStart(8)}ms`);
  return med;
}

async function main() {
  console.log(`=== Ark Web 性能基准 v2 (${ROUNDS} 轮中位) ===\n`);
  const st = await GET('/status');
  if (!st.data?.connected) { console.log('插件未连接'); process.exit(1); }

  const testUrl = await startTestServer();
  await POST('/open', { url: testUrl, current: true });
  await new Promise(r => setTimeout(r, 2500));

  const lines = [];
  console.log('--- 真实链路 (fresh=1 绕缓存, 完整往返) ---');
  lines.push(['GET /status', await bench('GET /status', () => GET('/status'))]);
  lines.push(['GET /page-info (fresh)', await bench('GET /page-info?fresh=1', () => GET('/page-info?fresh=1'))]);
  lines.push(['GET /dom (fresh)', await bench('GET /dom?fresh=1', () => GET('/dom?fresh=1'))]);
  lines.push(['POST /query', await bench('POST /query', () => POST('/query', { selector: 'h1' }))]);
  lines.push(['POST /query-all (10)', await bench('POST /query-all', () => POST('/query-all', { selector: 'p', limit: 10 }))]);
  lines.push(['POST /query-many (5)', await bench('POST /query-many', () => POST('/query-many', { selectors: ['h1', 'p', 'a', 'img', 'input'] }))]);
  lines.push(['POST /exists', await bench('POST /exists', () => POST('/exists', { selector: '#btn' }))]);
  lines.push(['POST /text', await bench('POST /text', () => POST('/text', { selector: 'h1' }))]);
  lines.push(['POST /html (片段)', await bench('POST /html', () => POST('/html', { selector: 'h1' }))]);
  lines.push(['GET /frames', await bench('GET /frames', () => GET('/frames'))]);
  lines.push(['GET /layout', await bench('GET /layout', () => GET('/layout'))]);
  lines.push(['GET /performance (fresh)', await bench('GET /performance?fresh=1', () => GET('/performance?fresh=1'))]);
  lines.push(['GET /security (fresh)', await bench('GET /security?fresh=1', () => GET('/security?fresh=1'))]);
  lines.push(['GET /a11y (fresh)', await bench('GET /a11y?fresh=1', () => GET('/a11y?fresh=1'))]);
  lines.push(['GET /seo (fresh)', await bench('GET /seo?fresh=1', () => GET('/seo?fresh=1'))]);

  console.log('\n--- JS 执行 ---');
  lines.push(['POST /evaluate 简单', await bench('POST /evaluate 简单', () => POST('/evaluate', { code: 'document.title' }))]);
  lines.push(['POST /evaluate DOM 遍历', await bench('POST /evaluate DOM 遍历', () => POST('/evaluate', { code: `return [...document.querySelectorAll('*')].length` }))]);
  lines.push(['POST /evaluate 异步 await', await bench('POST /evaluate 异步', () => POST('/evaluate', { code: 'await new Promise(r=>setTimeout(r,10)).then(()=>1)' }))]);

  console.log('\n--- 写操作 (真实元素) ---');
  lines.push(['POST /fill (2 字段)', await bench('POST /fill', () => POST('/fill', { fields: [
    { selector: '#user', value: 'bench-user' }, { selector: '#btn', value: 'x' }
  ] }))]);
  lines.push(['POST /type fast', await bench('POST /type', () => POST('/type', { selector: '#user', text: 'hello world' }))]);
  lines.push(['POST /key', await bench('POST /key', () => POST('/key', { key: 'Enter' }))]);
  lines.push(['POST /scroll (auto)', await bench('POST /scroll', () => POST('/scroll', { x: 0, y: 500, behavior: 'auto' }))]);
  lines.push(['POST /click (真实轨迹)', await bench('POST /click', () => POST('/click', { selector: '#btn' }))]);

  console.log('\n--- 重操作 ---');
  lines.push(['GET /screenshot', await bench('GET /screenshot', () => GET('/screenshot', 30000), Math.min(ROUNDS, 5))]);
  lines.push(['POST /batch (3 步)', await bench('POST /batch', () => POST('/batch', { steps: [
    { type: 'get-page-info', data: {} },
    { type: 'evaluate', data: { code: 'return document.title.length' } },
    { type: 'exists', data: { selector: '#btn' } }
  ] }))]);

  console.log('\n--- 缓存命中 (常规调用) ---');
  lines.push(['GET /page-info (缓存)', await bench('GET /page-info', () => GET('/page-info'))]);
  lines.push(['GET /dom (缓存)', await bench('GET /dom', () => GET('/dom'))]);

  lines.sort((a, b) => a[1] - b[1]);
  const total = lines.reduce((s, r) => s + r[1], 0);
  console.log(`\n=== 汇总 ===`);
  console.log(`总中位和: ${total.toFixed(0)}ms / ${lines.length} 操作 (均值 ${(total / lines.length).toFixed(1)}ms)`);
  console.log(`真实链路均值(排除截图): ${((total - 80) / (lines.length - 1)).toFixed(1)}ms`);
  console.log('\n最慢 5 个:');
  lines.slice(-5).reverse().forEach(r => console.log(`  ${r[0]}: ${r[1].toFixed(1)}ms`));
  console.log('\n最快 5 个:');
  lines.slice(0, 5).forEach(r => console.log(`  ${r[0]}: ${r[1].toFixed(1)}ms`));

  testServer.close();
}

main().catch(e => { console.error('异常:', e.message); process.exit(1); });
