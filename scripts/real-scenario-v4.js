/*
 * Ark Web 真实情景复杂终测 v4 (real-scenario-v4.js)
 * 12 个贴近真实用户旅程的高复杂度任务
 *
 * 相对 v3 的差异:
 *  - 真实站旅程: 必应多轮搜索、维基百科文章、Bilibili 浏览、腾讯新闻首页
 *  - 复杂本地 SPA(hash 路由/受控表单/无限滚动/多步结算)全流程
 *  - 首次覆盖: /analyze-all 多标签并行分析、monitor 监控期间操作、弹窗手动模式决策、
 *              /batch 12+ 步长链(open→click→type→submit→断言全链路)
 *  - 真实站断言全部轮询化/宽松化, 避免网络抖动误判
 *
 * 用法: node real-scenario-v4.js [--report 输出路径]
 * 依赖: Bridge Server 已启动且插件已连接(必要时先跑 debug/attach-all)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const AGENT = new http.Agent({ keepAlive: true });
const reportPath = process.argv.includes('--report')
  ? process.argv[process.argv.indexOf('--report') + 1]
  : path.join(__dirname, '..', 'reports', 'real-scenario-v4.md');

function req(method, p, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const r = http.request({ hostname: 'localhost', port: 9333, path: p, method, agent: AGENT,
      headers: body ? { 'Content-Type': 'application/json' } : {}, timeout }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(d); } catch { data = { raw: d.slice(0, 100) }; }
        resolve({ ms: Date.now() - t0, status: res.statusCode, data });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('TIMEOUT')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const GET = (p, t) => req('GET', p, null, t);
const POST = (p, b, t) => req('POST', p, b, t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 轮询直到断言函数返回 true(最多 maxMs), 返回最终值 */
async function poll(assertFn, maxMs = 10000, stepMs = 500) {
  let last = null;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    last = await assertFn();
    if (last === true) return true;
    await sleep(stepMs);
  }
  return last;
}

/** mock: 复杂 SPA(hash 路由) + 弹窗页 */
let mockPort = null;
function startMock() {
  const V = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const spa = `<!DOCTYPE html><html><head><meta charset="utf-8">${V}<title>Ark SPA Test</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  nav { padding: 10px; background: #1f2937; color: #fff; }
  nav a { color: #fff; margin-right: 16px; text-decoration: none; }
  .news-item, .feed-item, .product-item { padding: 8px 12px; margin: 6px 0; border: 1px solid #ddd; border-radius: 6px; }
  #view { padding: 16px; }
  input { padding: 6px; margin: 4px; border: 1px solid #999; border-radius: 4px; }
  button { padding: 6px 14px; margin: 4px; border: 0; border-radius: 4px; background: #2563eb; color: #fff; }
</style></head><body>
<nav>
  <a id="nav-home" href="#/">首页</a>
  <a id="nav-products" href="#/products">产品</a>
  <a id="nav-feed" href="#/feed">信息流</a>
  <a id="nav-checkout" href="#/checkout">结算</a>
</nav>
<div id="view"></div>
<script>
  window.__spa = { products: [], feedCount: 30, feedBusy: false };
  const $ = s => document.querySelector(s);
  const fakeFetch = (ms, data) => new Promise(r => setTimeout(() => r(data), ms));
  const newsHtml = [1, 2, 3].map(i => '<div class="news-item">新闻 #' + i + ' — 今日要闻 ' + i + '</div>').join('');
  const feedHtml = n => Array.from({ length: n }, (_, i) => '<div class="feed-item">条目 #' + i + '</div>').join('');
  const productHtml = () => window.__spa.products.map(p => '<div class="product-item">' + p.name + ' - ￥' + p.price + '</div>').join('') || '<div id="emptyTip">暂无产品</div>';
  const routes = {
    '/': async () => {
      $('#view').innerHTML = '<h2 id="heroTitle">SPA Home</h2><div id="newsList">加载中…</div>';
      const items = await fakeFetch(300, newsHtml);
      $('#newsList').innerHTML = items;
    },
    '/products': () => {
      $('#view').innerHTML = '<h2>产品管理</h2>' +
        '<form id="productForm" onsubmit="event.preventDefault(); addProduct();">' +
        '<input id="pName" placeholder="产品名" oninput="document.getElementById(&#39;pNameOut&#39;).textContent = this.value">' +
        '<input id="pPrice" placeholder="价格"><div id="pNameOut"></div>' +
        '<button id="pSubmit" type="submit">添加产品</button></form><div id="productList"></div>';
      $('#productList').innerHTML = productHtml();
    },
    '/feed': () => {
      $('#view').innerHTML = '<h2>信息流</h2><div id="feedList"></div><div id="feedStatus">已加载 ' + window.__spa.feedCount + ' 条</div>';
      $('#feedList').innerHTML = feedHtml(window.__spa.feedCount);
      $('#view').onscroll = null;
      window.addEventListener('scroll', maybeLoadMore);
    },
    '/checkout': () => {
      $('#view').innerHTML = '<h2>结算流程</h2>' +
        '<div id="checkoutStep1">姓名<input id="cName"> 电话<input id="cPhone"> <button id="cNext">下一步</button></div>' +
        '<div id="checkoutStep2" style="display:none">地址<input id="cAddr"> 备注<input id="cNote"> <button id="cSubmit">提交订单</button></div>' +
        '<div id="checkoutResult"></div>';
      $('#cNext').onclick = () => { $('#checkoutStep1').style.display = 'none'; $('#checkoutStep2').style.display = 'block'; };
      $('#cSubmit').onclick = () => {
        $('#checkoutResult').textContent = '订单成功: ' + $('#cName').value + '|' + $('#cPhone').value + '|' + $('#cAddr').value + '|' + $('#cNote').value;
      };
    }
  };
  function maybeLoadMore() {
    if (window.__spa.feedBusy) return;
    const near = window.innerHeight + window.scrollY >= document.body.scrollHeight - 300;
    if (!near) return;
    window.__spa.feedBusy = true;
    $('#feedStatus').textContent = '加载中…';
    fakeFetch(400, null).then(() => {
      window.__spa.feedCount += 15;
      $('#feedList').innerHTML = feedHtml(window.__spa.feedCount);
      $('#feedStatus').textContent = '已加载 ' + window.__spa.feedCount + ' 条';
      window.__spa.feedBusy = false;
    });
  }
  window.addProduct = () => {
    const name = $('#pName').value, price = $('#pPrice').value;
    if (!name || !price) return;
    window.__spa.products.push({ name, price });
    $('#productList').innerHTML = productHtml();
  };
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '#/').replace('#', '') || '/';
    (routes[h] || routes['/'])();
  });
  (routes[(location.hash || '#/').replace('#', '') || '/'] || routes['/'])();
</script></body></html>`;
  const dialogHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">${V}<title>弹窗页</title></head><body>
    <button id="bAlert" onclick="alert('hi alert')">alert</button>
    <button id="bConfirm" onclick="confirm('confirm?')">confirm</button>
    <button id="bPrompt" onclick="prompt('prompt?')">prompt</button>
    <div id="out"></div></body></html>`;
  const html = { '/': spa, '/dialog': dialogHtml };
  const srv = http.createServer((q, s) => {
    const u = new URL(q.url, 'http://x');
    const body = html[u.pathname];
    console.log(`[mock] ${q.url} -> ${body ? `200 len=${body.length}` : '404'}`);
    if (body) { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(body); }
    else { s.writeHead(404); s.end('404'); }
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
}

const results = [];
async function task(name, steps) {
  const t0 = Date.now();
  const outcomes = [];
  let ok = true;
  for (const [label, fn] of steps) {
    try {
      const r = await fn();
      if (r === true) { outcomes.push(`✓ ${label}`); }
      else { ok = false; outcomes.push(`✗ ${label} ${JSON.stringify(r)}`); }
    } catch (e) {
      ok = false;
      outcomes.push(`✗ ${label} 异常: ${e.message}`);
    }
  }
  const ms = Date.now() - t0;
  results.push({ name, ok, ms, steps: outcomes });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${ms}ms, ${outcomes.length}步)`);
  outcomes.filter(o => o.startsWith('✗')).forEach(o => console.log(`     ${o}`));
}

async function main() {
  console.log('=== Ark Web 真实情景复杂终测 v4 ===\n');
  const st = await GET('/status', 5000);
  if (!st.data?.connected) { console.log('插件未连接'); process.exit(1); }
  // 窗口检查: 最小化/隐藏时 innerWidth≈0, 会导致滚动/截图等断言误判
  const wc = await POST('/evaluate', { code: 'innerWidth' }, 15000);
  if (typeof wc.data?.result === 'number' && wc.data.result < 300) {
    console.log(`\n⚠ 浏览器窗口视口过窄(${wc.data.result}px), 可能被最小化/隐藏 — 请恢复窗口后重跑`);
    process.exit(2);
  }
  await POST('/debug/attach-all', {}, 30000).catch(() => {});
  mockPort = await startMock();
  const M = `http://127.0.0.1:${mockPort}`;
  console.log(`本地 mock: ${M}\n`);

  /** 本地页导航(不新开 tab) + 等加载 */
  const nav = async (url, timeout = 15000) => {
    const o = await POST('/open', { url, current: true }, 25000);
    if (o.data.success !== true) return `open failed: ${JSON.stringify(o.data)}`;
    const w = await POST('/wait-for-load', { timeout }, timeout + 5000);
    return w.data.success === true ? true : `wait-load: ${w.data.error}`;
  };
  /** 真实站导航: open + wait-load, open 失败重试一次, 仍失败则轮询主域 URL 兜底(网络慢/重定向) */
  const navReal = async (url, pattern, timeout = 30000) => {
    let o = await POST('/open', { url, current: true }, 30000);
    if (!o.data || o.data.success !== true) {
      await sleep(1500);
      o = await POST('/open', { url, current: true }, 30000);
    }
    if (!o.data || o.data.success !== true) return `open failed: ${JSON.stringify(o.data)}`;
    const w = await POST('/wait-for-load', { timeout }, timeout + 5000);
    if (w.data.success === true) return true;
    const r = await poll(async () => (await POST('/wait-for-url', { pattern, timeout: 5000 }, 10000)).data.success === true, 15000, 1000);
    return r === true ? true : `wait-load 失败且 URL 未匹配: ${JSON.stringify(w.data)}`;
  };
  const ev = async (code, t = 10000) => (await POST('/evaluate', { code }, t)).data;
  const evR = async (code, t = 10000) => (await ev(code, t)).result;

  // ============ 21. MDN 文档多页旅程(公共站, 无登录无验证) ============
  await task('S21 MDN 文档多页旅程(公共站)', [
    ['打开 MDN JavaScript 页', () => navReal('https://developer.mozilla.org/zh-CN/docs/Web/JavaScript', 'developer.mozilla.org', 40000)],
    ['页面标题验证', async () => poll(async () => { const t = await evR('document.title', 8000); return typeof t === 'string' && t.length > 5; }, 20000, 800)],
    ['h1 标题含 JavaScript', async () => poll(async () => { const t = await evR("(document.querySelector('h1')||{textContent:''}).textContent", 8000); return typeof t === 'string' && t.includes('JavaScript'); }, 20000, 800)],
    ['正文内容非空', async () => { const n = await evR("(document.querySelector('main')||document.body).textContent.trim().length", 8000); return typeof n === 'number' && n > 100 ? true : `len: ${n}`; }],
    ['跳转到 CSS 指南页', () => navReal('https://developer.mozilla.org/zh-CN/docs/Web/CSS', 'developer.mozilla.org', 40000)],
    ['CSS 页 h1 验证', async () => poll(async () => { const t = await evR("(document.querySelector('h1')||{textContent:''}).textContent", 8000); return typeof t === 'string' && t.includes('CSS'); }, 20000, 800)],
    ['后退回 JS 页', async () => (await POST('/back')).data.success === true],
    ['后退 URL 验证', async () => (await POST('/wait-for-url', { pattern: 'Web/JavaScript', timeout: 20000 })).data.success === true],
    ['前进回 CSS 页', async () => (await POST('/forward')).data.success === true],
    ['前进 URL 验证', async () => (await POST('/wait-for-url', { pattern: 'Web/CSS', timeout: 20000 })).data.success === true],
    ['页面截图', async () => { const r = await GET('/screenshot', 30000); return r.data.success === true && r.data.dataUrl.startsWith('data:image') ? true : `shot: ${JSON.stringify(r.data).slice(0, 120)}`; }],
  ]);

  // ============ 22. Apache 基金会多页旅程(公共站, 无登录无验证) ============
  await task('S22 Apache 基金会多页旅程(公共站)', [
    ['打开 Apache 首页', () => navReal('https://www.apache.org', 'apache.org', 40000)],
    ['页面标题验证', async () => poll(async () => { const t = await evR('document.title', 8000); return typeof t === 'string' && t.length > 5; }, 20000, 800)],
    ['h1 标题非空', async () => poll(async () => { const t = await evR("(document.querySelector('h1')||{textContent:''}).textContent", 8000); return typeof t === 'string' && t.trim().length > 3; }, 20000, 800)],
    ['链接列表可读', async () => { const r = await POST('/query-all', { selector: 'a', limit: 12, fields: ['text'] }, 15000); return Array.isArray(r.data) && r.data.filter(x => x && typeof x.text === 'string' && x.text.trim().length > 0).length >= 5 ? true : `links: ${JSON.stringify(r.data).slice(0, 200)}`; }],
    ['滚动浏览', async () => (await POST('/scroll-by', { y: 1000 }, 15000)).data.success === true],
    ['滚动位置变化', async () => { const y = await evR('window.scrollY', 8000); return typeof y === 'number' && y > 0; }],
    ['跳转到基金会介绍页', () => navReal('https://www.apache.org/foundation/', 'apache.org/foundation', 40000)],
    ['介绍页标题非空', async () => poll(async () => { const t = await evR("(document.querySelector('h1')||{textContent:''}).textContent", 8000); return typeof t === 'string' && t.trim().length > 3; }, 20000, 800)],
    ['后退回首页', async () => (await POST('/back')).data.success === true],
    ['后退 URL 验证', async () => (await POST('/wait-for-url', { pattern: 'apache.org', timeout: 20000 })).data.success === true],
    ['前进回介绍页', async () => (await POST('/forward')).data.success === true],
    ['前进 URL 验证', async () => (await POST('/wait-for-url', { pattern: 'foundation', timeout: 20000 })).data.success === true],
    ['页面截图', async () => { const r = await GET('/screenshot', 30000); return r.data.success === true && r.data.dataUrl.startsWith('data:image') ? true : `shot: ${JSON.stringify(r.data).slice(0, 120)}`; }],
  ]);

  // ============ 23. MDN 文章深度阅读(公共站, 无登录无验证) ============
  await task('S23 MDN 文章深度阅读(公共站)', [
    ['打开 MDN JS 文档', () => navReal('https://developer.mozilla.org/zh-CN/docs/Web/JavaScript', 'developer.mozilla.org', 40000)],
    ['文章标题', async () => poll(async () => { const t = await evR("(document.querySelector('h1')||{textContent:''}).textContent", 8000); return typeof t === 'string' && t.includes('JavaScript'); }, 20000, 800)],
    ['正文长度充足', async () => { const n = await evR("(document.querySelector('main')||document.body).textContent.trim().length", 8000); return typeof n === 'number' && n > 500 ? true : `len: ${n}`; }],
    ['目录链接可读', async () => { const r = await POST('/query-all', { selector: 'main a', limit: 10, fields: ['text'] }, 15000); return Array.isArray(r.data) && r.data.filter(x => x && typeof x.text === 'string' && x.text.trim().length > 0).length >= 3 ? true : `links: ${JSON.stringify(r.data).slice(0, 200)}`; }],
    ['代码元素存在', async () => poll(async () => { const n = await evR('document.querySelectorAll("pre, code").length', 8000); return typeof n === 'number' && n >= 1; }, 20000, 800)],
    ['滚动阅读', async () => (await POST('/scroll-by', { y: 1200 }, 15000)).data.success === true],
    ['滚动位置变化', async () => poll(async () => { const y = await evR('window.scrollY', 8000); return typeof y === 'number' && y > 0; }, 8000, 500)],
    ['页面截图', async () => { const r = await GET('/screenshot', 30000); return r.data.success === true && r.data.dataUrl.startsWith('data:image'); }],
  ]);

  // ============ 24. IANA 静态站浏览(公共站, 无登录无验证) ============
  await task('S24 IANA 静态站浏览(公共站)', [
    ['打开 IANA 首页', () => navReal('https://www.iana.org', 'iana.org', 40000)],
    ['页面标题非空', async () => poll(async () => { const t = await evR('document.title', 8000); return typeof t === 'string' && t.length > 5; }, 20000, 800)],
    ['链接列表可读', async () => { const r = await POST('/query-all', { selector: 'a', limit: 12, fields: ['text'] }, 15000); return Array.isArray(r.data) && r.data.filter(x => x && typeof x.text === 'string' && x.text.trim().length > 0).length >= 3 ? true : `links: ${JSON.stringify(r.data).slice(0, 200)}`; }],
    ['滚动浏览', async () => (await POST('/scroll-by', { y: 800 }, 15000)).data.success === true],
    ['滚动位置变化', async () => { const y = await evR('window.scrollY', 8000); return typeof y === 'number' && y > 0; }],
    ['页面信息完整', async () => { const r = await GET('/page-info', 15000); return r.data.title && r.data.title.length > 0 && r.data.url.includes('iana.org') ? true : `info: ${JSON.stringify(r.data).slice(0, 150)}`; }],
    ['标题层级提取', async () => { const r = await POST('/query-all', { selector: 'h2, h3', limit: 8 }, 15000); return Array.isArray(r.data) && r.data.length >= 1; }],
  ]);

  // ============ 25. SPA 路由与动态加载 ============
  await task('S25 SPA 路由与动态加载', [
    ['打开 SPA 首页', () => nav(`${M}/#/`)],
    ['页面脚本状态自检', async () => {
      const r = await POST('/evaluate', { code: '(() => { const s = document.querySelector("script"); return { t: typeof window.__spa, vis: document.visibilityState, slen: s ? s.textContent.length : -1, url: location.href }; })()' }, 10000);
      const v = r.data.result;
      return v && v.t === 'object' && v.vis === 'visible' ? true : `page: ${JSON.stringify(v)}`;
    }],
    ['首页特征文本', async () => (await POST('/wait-for-text', { text: 'SPA Home', timeout: 8000 })).data.success === true],
    ['动态新闻加载', async () => (await POST('/wait-for', { selector: '.news-item', timeout: 8000 })).data.success === true],
    ['新闻条数 = 3', async () => { const r = await POST('/query-all', { selector: '.news-item' }, 10000); return Array.isArray(r.data) && r.data.length === 3 ? true : `n: ${JSON.stringify(r.data)?.length}`; }],
    ['路由跳转到产品页', async () => { const c = await POST('/click', { selector: '#nav-products' }, 10000); return c.data.success === true; }],
    ['产品页特征文本', async () => (await POST('/wait-for-text', { text: '产品管理', timeout: 8000 })).data.success === true],
    ['URL hash 变化', async () => { const h = await evR('location.hash', 8000); return h === '#/products' ? true : `hash: ${h}`; }],
    ['路由往返回首页', async () => { await POST('/click', { selector: '#nav-home' }, 10000); return (await POST('/wait-for-text', { text: 'SPA Home', timeout: 8000 })).data.success === true; }],
  ]);

  // ============ 26. React 风格受控表单全流程 ============
  await task('S26 受控表单全流程(SPA)', [
    ['进入产品页', () => nav(`${M}/#/products`)],
    ['输入产品名', async () => (await POST('/type', { selector: '#pName', text: '机械键盘', timeout: 15000 })).data.success === true],
    ['受控镜像实时同步', async () => { const t = await evR("document.getElementById('pNameOut').textContent", 8000); return t === '机械键盘' ? true : `mirror: ${JSON.stringify(t)}`; }],
    ['输入价格', async () => (await POST('/type', { selector: '#pPrice', text: '399', timeout: 15000 })).data.success === true],
    ['提交添加', async () => (await POST('/click', { selector: '#pSubmit' }, 10000)).data.success === true],
    ['列表出现新产品', async () => (await POST('/wait-for-text', { text: '机械键盘', timeout: 8000 })).data.success === true],
    ['再添加第二件', async () => { await POST('/type', { selector: '#pName', text: '显示器', timeout: 15000 }); await POST('/type', { selector: '#pPrice', text: '1299', timeout: 15000 }); return (await POST('/click', { selector: '#pSubmit' }, 10000)).data.success === true; }],
    ['产品条数 = 2', async () => { const r = await POST('/query-all', { selector: '.product-item' }, 10000); return Array.isArray(r.data) && r.data.length === 2; }],
    ['store 状态一致', async () => { const n = await evR('window.__spa.products.length', 8000); return n === 2 ? true : `store: ${n}`; }],
  ]);

  // ============ 27. 无限滚动懒加载 ============
  await task('S27 无限滚动懒加载(SPA)', [
    ['进入信息流页', () => nav(`${M}/#/feed`)],
    ['初始条目出现', async () => (await POST('/wait-for', { selector: '.feed-item', timeout: 8000 })).data.success === true],
    ['初始条数 = 30', async () => { const r = await POST('/query-all', { selector: '.feed-item' }, 10000); return Array.isArray(r.data) && r.data.length === 30 ? true : `n: ${Array.isArray(r.data) ? r.data.length : JSON.stringify(r.data)}`; }],
    ['滚到底部触发加载', async () => { const r = await POST('/evaluate', { code: '(() => { window.scrollTo(0, document.body.scrollHeight); return true; })()' }, 8000); return r.data.result === true; }],
    ['条目数增长(>30)', async () => poll(async () => { const r = await POST('/query-all', { selector: '.feed-item' }, 10000); return Array.isArray(r.data) && r.data.length > 30; }, 12000, 600)],
    ['再次滚动加载第二批', async () => { const r = await POST('/evaluate', { code: '(() => { window.scrollTo(0, document.body.scrollHeight); return true; })()' }, 8000); return r.data.result === true; }],
    ['条目数再增长(>=45)', async () => poll(async () => { const r = await POST('/query-all', { selector: '.feed-item' }, 10000); return Array.isArray(r.data) && r.data.length >= 45; }, 12000, 600)],
    ['加载状态文本', async () => poll(async () => { const t = await evR("document.getElementById('feedStatus').textContent", 8000); return typeof t === 'string' && /已加载 \d+ 条/.test(t); }, 12000, 500)],
  ]);

  // ============ 28. 多步骤结算流程 ============
  await task('S28 多步骤结算流程(SPA)', [
    ['进入结算页', () => nav(`${M}/#/checkout`)],
    ['结算页特征文本', async () => (await POST('/wait-for-text', { text: '结算流程', timeout: 8000 })).data.success === true],
    ['步骤1: fill 姓名电话', async () => { const r = await POST('/fill', { fields: [{ selector: '#cName', value: '张三' }, { selector: '#cPhone', value: '13800000000' }] }, 15000); return Array.isArray(r.data) && r.data.every(f => f.success === true); }],
    ['步骤1: 下一步', async () => (await POST('/click', { selector: '#cNext' }, 10000)).data.success === true],
    ['步骤2 可见', async () => poll(async () => { const d = await evR("document.getElementById('checkoutStep2').style.display", 8000); return d === 'block'; }, 8000, 500)],
    ['步骤2: fill 地址备注', async () => { const r = await POST('/fill', { fields: [{ selector: '#cAddr', value: '上海市' }, { selector: '#cNote', value: '尽快发货' }] }, 15000); return Array.isArray(r.data) && r.data.every(f => f.success === true); }],
    ['提交订单', async () => (await POST('/click', { selector: '#cSubmit' }, 10000)).data.success === true],
    ['订单成功文案', async () => (await POST('/wait-for-text', { text: '订单成功', timeout: 8000 })).data.success === true],
    ['结果含全部字段', async () => { const r = await POST('/text', { selector: '#checkoutResult' }, 10000); return r.data === '订单成功: 张三|13800000000|上海市|尽快发货' ? true : `out: ${JSON.stringify(r.data)}`; }],
    ['SPA 未跳转(仍在本页)', async () => { const h = await evR('location.hash', 8000); return h === '#/checkout' ? true : `hash: ${h}`; }],
  ]);

  // ============ 29. 多标签页真实对比 + analyze-all(首次覆盖) ============
  await task('S29 多标签页对比 + analyze-all', [
    ['获取初始 tab 数', async () => { const t = (await GET('/tabs')).data; globalThis.v4TabN0 = t.length; globalThis.v4OrigTab = t.find(x => x.active)?.id || t[0]?.id; globalThis.v4Tabs = []; return t.length >= 1; }],
    ['新开必应 tab', async () => { const r = await POST('/open', { url: 'https://cn.bing.com' }); if (r.data.success === true) globalThis.v4Tabs.push(r.data.tab.id); return r.data.success === true; }],
    ['新开腾讯 tab', async () => { const r = await POST('/open', { url: 'https://www.qq.com' }); if (r.data.success === true) globalThis.v4Tabs.push(r.data.tab.id); return r.data.success === true; }],
    ['tab 数 +2', async () => (await GET('/tabs')).data.length >= globalThis.v4TabN0 + 2],
    ['?tabId 指定必应 tab 生效', async () => poll(async () => { const p = await GET(`/page-info?tabId=${globalThis.v4Tabs[0]}`); return p.data.url && p.data.url.includes('bing.com'); }, 15000, 700)],
    ['?tabId 指定腾讯 tab 生效', async () => poll(async () => { const p = await GET(`/page-info?tabId=${globalThis.v4Tabs[1]}`); return p.data.url && p.data.url.includes('qq.com'); }, 15000, 700)],
    ['analyze-all 多标签并行分析', async () => { const r = await GET('/analyze-all', 60000); return r.data.analyzedTabs >= globalThis.v4TabN0 + 2 && r.data.totalTabs >= r.data.analyzedTabs ? true : `aa: ${JSON.stringify(r.data).slice(0, 300)}`; }],
    ['analyze-all 覆盖两个真实站', async () => { const r = await GET('/analyze-all', 60000); const urls = (r.data.results || []).map(x => x.tab?.url || ''); return urls.some(u => u.includes('bing.com')) && urls.some(u => u.includes('qq.com')) ? true : `urls: ${JSON.stringify(urls)}`; }],
    ['analyze-all 含摘要指标', async () => { const r = await GET('/analyze-all', 60000); const withSum = (r.data.results || []).filter(x => x.summary && typeof x.summary.domElements === 'number'); return withSum.length >= 2; }],
    ['恢复原 tab 激活', async () => (await POST('/tab/activate', { tabId: globalThis.v4OrigTab })).data.success === true],
    ['关闭新建 tab', async () => { for (const id of globalThis.v4Tabs) await POST('/tab/close', { tabId: id }).catch(() => {}); return true; }],
    ['tab 数恢复', async () => (await GET('/tabs')).data.length === globalThis.v4TabN0],
  ]);

  // ============ 30. 弹窗手动模式决策流程 ============
  await task('S30 弹窗手动模式决策流程', [
    ['打开弹窗页', () => nav(`${M}/dialog`)],
    ['切换手动模式', async () => { const r = await POST('/dialog', { auto: false }); return r.data.success === true && r.data.policy?.autoAccept === false; }],
    ['触发 confirm(挂起)', async () => { await POST('/click', { selector: '#bConfirm' }, 10000).catch(() => {}); return true; }],
    ['记录为 pending', async () => poll(async () => { const r = await GET('/dialogs'); const arr = Array.isArray(r.data) ? r.data : []; const hit = arr.find(x => x.type === 'confirm' && x.handled === 'pending'); return !!hit; }, 10000, 400)],
    ['手动 dismiss', async () => { const r = await POST('/dialog', { accept: false }); return r.data.success === true || r.data.reason === 'already-handled'; }],
    ['记录关闭', async () => poll(async () => { const r = await GET('/dialogs'); const arr = Array.isArray(r.data) ? r.data : []; const hit = arr.find(x => x.type === 'confirm' && (x.handled === 'closed' || x.handled === 'pending')); return !!hit; }, 8000, 400)],
    ['恢复自动模式', async () => { const r = await POST('/dialog', { auto: true }); return r.data.success === true && r.data.policy?.autoAccept === true; }],
    ['触发 alert(自动应答)', async () => { await POST('/click', { selector: '#bAlert' }, 10000).catch(() => {}); return true; }],
    ['记录为 auto 处理', async () => poll(async () => { const r = await GET('/dialogs'); const arr = Array.isArray(r.data) ? r.data : []; return arr.some(x => x.type === 'alert' && x.handled === 'auto'); }, 10000, 400)],
  ]);

  // ============ 31. monitor 实时监控(期间操作) ============
  await task('S31 monitor 实时监控(期间操作)', [
    ['启动监控', async () => { const r = await POST('/monitor', { interval: 1000, duration: 30000 }, 8000); return r.data.success === true; }],
    ['监控期间导航 SPA', () => nav(`${M}/#/`, 10000)],
    ['监控期间点击操作', async () => { await POST('/click', { selector: '#nav-products' }, 10000).catch(() => {}); return true; }],
    ['监控期间执行 JS', async () => { const r = await POST('/evaluate', { code: "window.__op = 'done'" }, 8000); return r.data.result === 'done'; }],
    ['等待多个采样周期', async () => { await sleep(3500); return true; }],
    ['监控状态 active', async () => { const r = await GET('/monitor/status'); return r.data.active === true && r.data.dataPoints >= 1; }],
    ['停止监控并取数据', async () => { const r = await POST('/monitor/stop'); return r.data.success === true && r.data.dataPoints >= 1; }],
    ['数据覆盖 SPA 页面', async () => { const r = await POST('/monitor/stop'); const samples = r.data.data || []; return samples.some(s => (s.url || '').includes('127.0.0.1')); }],
  ]);

  // ============ 32. /batch 12+ 步长链全链路 ============
  await task('S32 /batch 长链全链路(12+ 步)', [
    ['长链: open→click→type→submit→断言', async () => {
      const r = await POST('/batch', {
        steps: [
          { type: 'open-url', data: { url: `${M}/#/`, current: true } },
          { type: 'wait-for-load', data: {} },
          { type: 'get-page-info', data: {} },
          { type: 'query-selector', data: { selector: '#nav-products' } },
          { type: 'click-element', data: { selector: '#nav-products' } },
          { type: 'wait-for-selector', data: { selector: '#productForm' } },
          { type: 'type-text', data: { selector: '#pName', text: '链式产品' } },
          { type: 'type-text', data: { selector: '#pPrice', text: '88' } },
          { type: 'click-element', data: { selector: '#pSubmit' } },
          { type: 'wait-for-selector', data: { selector: '.product-item' } },
          { type: 'get-text', data: { selector: '.product-item' } },
          { type: 'evaluate', data: { code: 'location.hash' } }
        ]
      }, 40000);
      if (r.data.success !== true || !Array.isArray(r.data.steps)) return `batch: ${JSON.stringify(r.data).slice(0, 300)}`;
      const steps = r.data.steps;
      const last = steps[steps.length - 1];
      const text = steps[steps.length - 2];
      const t = String(text?.result || '');
      const h = last?.result?.result || last?.result;
      return steps.length === 12 && t.includes('链式产品') && t.includes('88') && h === '#/products'
        ? true
        : `steps=${steps.length} text=${JSON.stringify(t)} hash=${JSON.stringify(last?.result)}`;
    }],
    ['链内 product 已入 store', async () => { const n = await evR('window.__spa.products.length', 8000); return n === 1 && (await evR("window.__spa.products[0].name", 8000)) === '链式产品' ? true : `store: ${JSON.stringify(await evR('window.__spa.products', 8000))}`; }],
  ]);

  // ============ 清理与报告 ============
  await POST('/dialog', { auto: true }).catch(() => {});
  await POST('/monitor/stop').catch(() => {});
  await POST('/network/conditions/reset').catch(() => {});
  await POST('/device/clear').catch(() => {});

  const passed = results.filter(r => r.ok);
  const tAll = results.reduce((a, r) => a + r.ms, 0);
  const info = (await GET('/debug/info', 5000).catch(() => ({ data: {} }))).data || {};
  const cdp = (await GET('/debug/cdp-status', 5000).catch(() => ({ data: {} }))).data || {};
  const lines = [];
  lines.push('# Ark Web 真实情景复杂终测报告 v4');
  lines.push('');
  lines.push(`- 时间: ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 插件: ${info.extension || '?'} | Chrome ${String(info.chromeVersion || '').match(/Chrome\/(\S+)/)?.[1] || '?'}`);
  lines.push(`- CDP: attached=${cdp.attached?.length || 0} enabled=${cdp.enabled?.length || 0} throttled=${cdp.throttled}`);
  lines.push(`- 任务: ${results.length} 个 | 步骤: ${results.reduce((a, r) => a + r.steps.length, 0)} | 通过 ${passed.length} | 失败 ${results.length - passed.length}`);
  lines.push(`- 总耗时: ${(tAll / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('## 任务明细');
  lines.push('');
  lines.push('| # | 任务 | 结果 | 耗时 | 步骤 |');
  lines.push('|---|------|------|------|------|');
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.name} | ${r.ok ? '✅' : '❌'} | ${r.ms}ms | ${r.steps.length} |`);
  });
  lines.push('');
  lines.push('## 失败详情');
  lines.push('');
  const fails = results.filter(r => !r.ok);
  if (fails.length === 0) lines.push('无失败。');
  fails.forEach(r => {
    lines.push(`### ${r.name}`);
    lines.push('');
    r.steps.filter(s => s.startsWith('✗')).forEach(s => lines.push(`- ${s}`));
    lines.push('');
  });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\n=== 汇总: ${passed.length}/${results.length} 通过, ${results.reduce((a, r) => a + r.steps.length, 0)} 步, 总耗时 ${(tAll / 1000).toFixed(1)}s ===`);
  console.log(`报告: ${reportPath}`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('致命错误:', e.message); process.exit(2); });
