#!/usr/bin/env node
/**
 * verify-all.js —— 一条命令跑齐全部验证，并按"需要什么条件"自动分层
 *
 * 为什么需要它：验证套件有 9 套，各自的前置条件不同 ——
 *   · 静态检查：什么都不需要
 *   · 离线套件：只要能 require 代码
 *   · 接口层：需要服务端在跑（不需要浏览器）
 *   · 界面层：需要真实浏览器 + 已加载扩展 + 夹具页服务
 * 以前靠人记住"哪套要开什么"，结果就是浏览器那几套长期不跑。这个脚本把条件判断
 * 和"缺条件时该做什么"一起说清楚：能跑的跑，跑不了的明确跳过并给出补齐命令。
 *
 * 用法:
 *   node scripts/verify-all.js              # 全部（缺条件的自动跳过并说明）
 *   node scripts/verify-all.js --offline    # 只跑不需要服务/浏览器的部分
 *   node scripts/verify-all.js --no-browser # 含接口层，但不要求浏览器
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const OFFLINE_ONLY = argv.includes('--offline');
const NO_BROWSER = argv.includes('--no-browser') || OFFLINE_ONLY;

const results = [];
let serverProc = null;
let mockProc = null;

function probe(port, urlPath, ms) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: ms || 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitFor(fn, tries, gapMs) {
  for (let i = 0; i < (tries || 20); i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, gapMs || 500));
  }
  return false;
}

/** 跑一个套件，抓输出尾部；返回是否通过 */
function runSuite(title, script, opts) {
  const o = opts || {};
  process.stdout.write('  ▶ ' + title + ' … ');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT, encoding: 'utf8', timeout: o.timeoutMs || 600000,
    env: Object.assign({}, process.env, o.env || {})
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  // （失败信号判定见下）
  const tail = out.trim().split(/\r?\n/).slice(-3).join(' ｜ ');
  // 双重判定：退出码 + 输出里的失败信号。
  // 只信退出码会被"打印了失败却 exit 0"的套件骗过去（runner/cdp-smoke 历史上就是这样）。
  const failedInOutput = /(^|\n)\s*失败\s+\S/.test(out) || /✗\s*有\s*\d+\s*条?\s*(程序)?断言失败/.test(out) || /低于下限/.test(out);
  const ok = r.status === 0 && !failedInOutput;
  results.push({ title, ok, skipped: false, ms: Date.now() - t0, tail: tail.slice(0, 300) });
  console.log((ok ? '通过' : '失败') + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)  ' + tail.slice(0, 160));
  return ok;
}

function skip(title, reason, howto) {
  results.push({ title, ok: null, skipped: true, reason, howto });
  console.log('  ○ 跳过  ' + title + ' —— ' + reason + (howto ? '\n        补条件: ' + howto : ''));
}

async function main() {
  console.log('=== Ark Web 全量验证 ===');
  console.log('仓库: ' + ROOT);
  console.log('');

  /* ── 第 1 层：静态检查（无需任何前置条件）── */
  console.log('[1/4] 静态自检');
  runSuite('能力模块未声明标识符', 'scripts/check-capabilities.js');
  runSuite('路由与端点文档一致', 'scripts/check-endpoints.js');
  runSuite('版本号三处一致', 'scripts/bump-version.js');
  runSuite('全仓 JS 语法', 'scripts/check-syntax.js');

  /* ── 第 2 层：离线套件 ── */
  console.log('\n[2/4] 离线套件（智能体逻辑 / 安全 / 路由等价）');
  runSuite('agent-units（62 项）', 'verify/agent-units.js');
  runSuite('route-parity（路由等价）', 'verify/route-parity.js');

  if (OFFLINE_ONLY) return finish();

  /* ── 第 3 层：接口层（需要服务端，不需要浏览器）── */
  console.log('\n[3/4] 接口层与通道防护（需要服务端在跑）');
  let serverUp = await probe(9333, '/health');
  if (!serverUp) {
    console.log('  服务端未在跑，自动启动一个（日志: ~/.ark-web/server.log）…');
    const logFile = path.join(os.homedir(), '.ark-web', 'server.log');
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (e) { /* ignore */ }
    const fd = fs.openSync(logFile, 'a');
    serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'bridge-server.js')], {
      detached: true, stdio: ['ignore', fd, fd]
    });
    serverProc.unref();
    serverUp = await waitFor(() => probe(9333, '/health'), 30, 500);
  }
  if (serverUp) {
    runSuite('http-smoke（只读端点冒烟）', 'verify/http-smoke.js');
    runSuite('ws-guard（WS 来源防护）', 'verify/ws-guard.js');
  } else {
    skip('http-smoke / ws-guard', '服务端起不来（端口被占？）', 'node server/bridge-server.js 后重试');
  }

  if (NO_BROWSER) return finish();

  /* ── 第 4 层：界面层（需要浏览器 + 扩展 + 夹具页服务）── */
  console.log('\n[4/4] 界面层（需要浏览器已加载扩展）');
  // 插件探测要带重试：扩展的服务工作线程会休眠/重连，单次探测很容易撞在重连窗口上，
  // 于是"浏览器明明在跑"却报"没有插件连接"（实测踩过）。
  let pluginUp = false;
  const probePlugin = () => new Promise((resolve) => {
    let token;
    try { token = fs.readFileSync(path.join(os.homedir(), '.ark-web', 'token'), 'utf8').trim(); }
    catch (e) { return resolve(false); }
      const req = http.request({ host: '127.0.0.1', port: 9333, path: '/status', headers: { 'X-Ark-Token': token }, timeout: 2500 }, (res) => {
        let b = ''; res.on('data', (d) => (b += d));
        res.on('end', () => { try { resolve(!!JSON.parse(b).pluginConnected); } catch (e) { resolve(false); } });
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
  for (let i = 0; i < 12 && !pluginUp; i++) {          // 最多等约 24 秒（覆盖一次重连周期）
    pluginUp = await probePlugin();
    if (!pluginUp) await new Promise((r) => setTimeout(r, 2000));
  }

  let mockUp = await probe(8899, '/test-page.html');
  if (pluginUp && !mockUp) {
    console.log('  夹具页服务未在跑，自动启动（端口 8899）…');
    const fd2 = fs.openSync('/tmp/ark-mock.log', 'a');
    mockProc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-server.js')], { detached: true, stdio: ['ignore', fd2, fd2] });
    mockProc.unref();
    mockUp = await waitFor(() => probe(8899, '/test-page.html'), 20, 400);
  }

  if (!pluginUp) {
    skip('cdp-smoke / runner / sse-tasks', '没有浏览器插件连接',
      '在浏览器里加载 extension/ 并点扩展图标「Enable Debug」');
  } else {
    if (!mockUp) {
      skip('runner', '夹具页服务未能启动（8899）', 'node scripts/mock-server.js');
    }
    // 先把"目标页"准备好再跑需要它的套件 —— 包括 cdp-smoke：它现在没有 http 页面
    // 就会如实报失败（旧实现是 exit 0 静默跳过），而浏览器刚启动时通常只有内部页。
    if (mockUp) await ensureTarget('http://127.0.0.1:8899/test-page.html', /8899\/test-page/);
    runSuite('cdp-smoke（内核通道 13 项）', 'verify/cdp-smoke.js');
    if (mockUp) {
      runSuite('runner（工作页交互）', 'verify/runner.js', { timeoutMs: 600000 });
    }
    runSuite('sse-tasks（事件流与取消）', 'verify/sse-tasks.js', { timeoutMs: 600000 });
  }

  return finish();
}

/**
 * 确保某个页面在浏览器里开着（套件要按 target 找它）。
 * 已经开着就什么都不做；没开就用 HTTP 接口打开一个新标签页。
 * extensionId 为空时跳过（面板扩展 ID 由加载路径派生，可由 ARK_PANEL_ID 传入）。
 */
async function ensureTarget(url, matchRe, extensionId) {
  if (!url || (url.indexOf('chrome-extension://') === 0 && !extensionId)) return;
  try {
    const list = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: 9110, path: '/json/list', timeout: 2500 }, (res) => {
        let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
      });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (!list) return;                                   // 内核不可用：交给套件自己去处理
    if (list.some((t) => matchRe.test(t.url || ''))) return;   // 已经开着
    const token = fs.readFileSync(path.join(os.homedir(), '.ark-web', 'token'), 'utf8').trim();
    const body = JSON.stringify({ url: url, current: false });
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: 9333, path: '/open?browser=browseros', method: 'POST',
        headers: { 'X-Ark-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body); req.end();
    });
    await new Promise((r) => setTimeout(r, 1500));        // 等它加载出来
  } catch (e) { /* 尽力而为 */ }
}

function finish() {
  const ran = results.filter((r) => !r.skipped);
  const failed = ran.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);

  console.log('\n=== 汇总 ===');
  console.log('  执行 ' + ran.length + ' 项，通过 ' + (ran.length - failed.length) + '，失败 ' + failed.length
    + (skipped.length ? '，跳过 ' + skipped.length : ''));
  for (const f of failed) console.log('  ✗ ' + f.title + ' —— ' + (f.tail || '').slice(0, 200));
  for (const s of skipped) console.log('  ○ ' + s.title + '（未跑）');
  if (!failed.length) console.log('  ✓ 全部通过');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('验证脚本自身出错:', e.message); process.exit(2); });
