#!/usr/bin/env node
/**
 * 修复回归套件（v5.1）
 *
 *   node test/regression.js
 *
 * 覆盖本次审查确认过的高风险点：
 *   state 主世界、导航后 text、密码 fill、contenteditable 替换、find 不清 ref、
 *   click --no-confirm 延迟、跨 frame assert count、select 非法值、
 *   emulate 后截图不摧毁模拟、匿名 WS 不进入扩展表、Origin 策略。
 *
 * 依赖正在运行的 bridge-server 与已加载扩展；夹具全部本地，不依赖外网。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'client', 'browser-client.js');
const BASE = process.env.ARK_WEB_BASE || 'http://127.0.0.1:9333';
const TOKEN = readFileSync(path.join(homedir(), '.ark-web', 'token'), 'utf8').trim();

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>regression</title>
<script type="application/ld+json">{"@type":"Thing","name":"REG-LD"}</script>
<script>window.__INITIAL_STATE__={marker:"GLOBAL-MARK"};</script>
<style>html{scroll-behavior:smooth} body{font:14px sans-serif} input,select,button,#rt{margin:6px;padding:4px} #hov:hover{color:rgb(255,0,0)}</style>
<label>pw <input id="pw" type="password" value="secret"></label>
<div id="rt" contenteditable="true">abc</div>
<select id="nat"><option value="a">A</option><option value="b">B</option></select>
<button id="b" onclick="document.getElementById('out').textContent=' clicked '">Go</button>
<button id="hov">Hover me</button>
<div id="out"></div>
<iframe id="fr" srcdoc="<div class='item'>frame-item</div><div class='frame-only'>only-in-frame</div><p>FRAME-TEXT</p><script type='application/ld+json'>{&quot;@type&quot;:&quot;Thing&quot;,&quot;name&quot;:&quot;FRAME-LD&quot;}</script><input id='frameFile' type='file'>"></iframe>
<div class="item"><h2>H2-MARK</h2><h3>H3-MARK</h3></div>
<table id="span"><tr><th rowspan="2">Name</th><th colspan="2">Prices</th></tr><tr><th>A</th><th>B</th></tr><tr><td rowspan="2">X</td><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>
<div id="host"></div>
<div style="height:2200px">tall</div>
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<p>SHADOW-MARK</p>';</script>`;
const NEXT = `<!doctype html><meta charset="utf-8"><title>next</title><p>next page body</p>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ARK_WEB_JSON: '1' },
      windowsHide: true
    });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: { code: 'E_TEST_TIMEOUT', message: `${timeoutMs}ms` } }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: { code: 'E_NO_JSON', message: (err || out).slice(0, 240) } }); }
    });
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? '' : JSON.stringify(detail ?? '').slice(0, 300) });
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${cond ? '' : '  → ' + results.at(-1).detail}`);
}

async function status() {
  const r = await fetch(BASE + '/status', { headers: { authorization: `Bearer ${TOKEN}` } });
  return r.json();
}

async function main() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ark-reg-'));
  const server = createServer((req, res) => {
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { location: '/api/ping' });
      res.end();
      return;
    }
    if (req.url.startsWith('/api/body')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ marker: 'HAR-BODY-MARK' }));
      return;
    }
    if (req.url.startsWith('/api/ping')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/next') ? NEXT : PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let tab = null;

  try {
    const before = await status();
    if (should('ext')) {
      const extId = before.extensions?.[0]?.id;
      const ts = await cli(['tabs', '--ext', extId]);
      check('--ext 能指定已连接扩展', !!extId && ts.ok && Array.isArray(ts.data?.tabs), ts.error || ts.data);
    }

    if (should('multi')) {
      const tabsAll = await cli(['tabs']);
      check('tabs 默认聚合并标记浏览器', tabsAll.ok && (tabsAll.data?.tabs || []).every((t) => !!t.browser && !!t.extId && !!t.conn), tabsAll.data || tabsAll.error);
    }
    const opened = await cli(['open', url, '--tab-bg']);
    tab = String(opened.data?.id ?? '');
    if (!tab) { check('open 夹具页', false, opened); throw new Error('open failed'); }
    const T = ['--tab', tab];
    check('open 创建标签并开启捕获', opened.ok && opened.data?.capturing === true, opened.data || opened.error);

    if (should('multi')) {
      const browser = before.extensions?.[0]?.browser;
      const byBrowser = await cli(['eval', '1+1', '--browser', browser, ...T]);
      check('--browser 能按浏览器名选择', byBrowser.ok && byBrowser.data?.value === 2, byBrowser.error || byBrowser.data);
      const fan = await cli(['fanout', 'eval 1+1', ...T], 180000);
      check('fanout 在所有浏览器并行执行', fan.ok && fan.data?.count >= 1 && fan.data?.browsers?.[0]?.data?.value === 2, fan.data || fan.error);
    }

    if (should('state')) {
      const st = await cli(['state', ...T]);
      check('state 读到主世界 __INITIAL_STATE__', st.ok && JSON.stringify(st.data).includes('GLOBAL-MARK'), st.data || st.error);
      check('state 仍读得到 JSON-LD', st.ok && JSON.stringify(st.data).includes('REG-LD'), st.data || st.error);
      check('state 聚合 iframe JSON-LD', st.ok && JSON.stringify(st.data).includes('FRAME-LD') && (st.data?.frames?.length || 0) >= 2, st.data || st.error);
    }

    if (should('password')) {
      const f = await cli(['fill', '--selector', '#pw', '--text', 'newpass', ...T]);
      const real = await cli(['eval', "document.getElementById('pw').value", ...T]);
      check('密码框 fill 成功且返回脱敏值', f.ok && f.data?.masked === true && String(f.data?.value).includes('••'), f.data || f.error);
      check('密码框实际值已写入', real.ok && real.data?.value === 'newpass', real.data || real.error);
      const snap = await cli(['snapshot', '--no-shot', ...T]);
      const pwEl = (snap.data?.elements || []).find((e) => e.tag === 'input');
      check('快照不泄漏密码明文', !!pwEl && !JSON.stringify(pwEl).includes('newpass') && String(pwEl.value).includes('••'), pwEl);
    }

    if (should('contenteditable')) {
      const f = await cli(['fill', '--selector', '#rt', '--text', 'xyz', ...T]);
      const v = await cli(['eval', "document.getElementById('rt').textContent", ...T]);
      check('contenteditable fill 是替换而非追加', f.ok && v.data?.value === 'xyz', { fill: f.data, text: v.data?.value });
    }

    if (should('refs')) {
      const snap = await cli(['snapshot', '--no-shot', '--limit', '30', ...T]);
      const pw = (snap.data?.elements || []).find((e) => e.tag === 'input');
      const ref = pw?.ref;
      const fnd = await cli(['find', '--text', 'Go', '--role', 'button', ...T]);
      check('find 能定位按钮', fnd.ok && fnd.data?.items?.length > 0, fnd.data || fnd.error);
      const at = await cli(['attr', '--ref', String(ref), ...T]);
      check('find 之后 snapshot 的旧 ref 仍可用', at.ok === true, { ref, err: at.error, data: at.data });
    }

    if (should('upload')) {
      const up = path.join(tmp, 'frame-upload.txt');
      writeFileSync(up, 'iframe upload\n', 'utf8');
      const u = await cli(['upload', '--selector', '#frameFile', '--file', up, ...T]);
      check('upload 支持 iframe 内 file input 并回读校验',
        u.ok && u.data?.verified === true && u.data?.input?.count === 1 && String(u.data?.input?.files?.[0]?.name) === 'frame-upload.txt',
        u.data || u.error);
    }

    if (should('table-span')) {
      const tb = await cli(['table', '--selector', '#span', ...T]);
      check('table 处理 rowspan/colspan 表头',
        tb.ok && tb.data?.header?.join('|') === 'Name|Prices / A|Prices / B' && tb.data?.totalRows === 2,
        tb.data || tb.error);
      check('table rowspan 数据行被正确填充',
        tb.ok && tb.data?.rows?.[0]?.['Name'] === 'X' && tb.data?.rows?.[1]?.['Prices / A'] === '3',
        tb.data?.rows || tb.error);
    }

    if (should('extract')) {
      const ex = await cli(['extract', '--selector', '.item', '--fields', 't::is(h2,h3)', ...T]);
      check('extract 字段选择器支持逗号 :is(...)', ex.ok && String(ex.data?.rows?.[0]?.t || '').includes('H2-MARK'), ex.data || ex.error);
    }

    if (should('select')) {
      const s = await cli(['select', '--selector', '#nat', '--values', 'ZZ', ...T]);
      check('原生 select 非法值返回 E_SELECT_FAILED', s.ok === false && s.error?.code === 'E_SELECT_FAILED', s.error || s.data);
    }

    if (should('count')) {
      const a = await cli(['assert', '--selector', '.item', '--count', '0', ...T]);
      check('跨 frame assert count=0 不再误通过', a.ok === false && a.error?.code === 'E_ASSERT', a.error || a.data);
      const a2 = await cli(['assert', '--selector', '.item', '--count', '2', ...T]);
      check('跨 frame assert count 正确汇总', a2.ok === true && a2.data?.actual === 2, a2.data || a2.error);
    }

    if (should('click')) {
      const t0 = Date.now();
      const c = await cli(['click', '--selector', '#b', '--no-confirm', ...T]);
      const ms = Date.now() - t0;
      check('click --no-confirm 不再固定等 1.5s',
        c.ok && ms < 1600 && Number(c.data?.openedTabWaitMs) < 700,
        { ms, waited: c.data?.openedTabWaitMs, data: c.data, err: c.error });
    }

    if (should('scroll')) {
      const s1 = await cli(['scroll', '--dy', '600', ...T]);
      check('scroll 在 smooth 页面上仍是即时生效', s1.ok && s1.data?.after?.y === 600, s1.data || s1.error);
      await cli(['scroll', '--dy', '-600', ...T]);
    }

    if (should('idle')) {
      await cli(['eval', "fetch('/redirect').then(r=>r.text())", ...T]);
      await sleep(150);
      const idle = await cli(['wait-idle', '--timeout', '5000', '--idle-ms', '200', ...T], 15000);
      check('重定向请求不会让 wait-idle 永久卡住', idle.ok && idle.data?.idle === true, idle.data || idle.error);
    }

    if (should('hover')) {
      const h = await cli(['hover', '--selector', '#hov', ...T]);
      check('hoverActive 只认真实悬停目标', h.ok && h.data?.hoverActive === true, h.data || h.error);
    }

    if (should('wait-detach')) {
      const w = await cli(['wait', '--selector', '.frame-only', '--detach', '--timeout', '700', ...T], 15000);
      check('wait --detach 要求所有 frame 都不存在', w.ok === false && w.error?.code === 'E_TIMEOUT', w.error || w.data);
      const bad = await cli(['wait', '--selector', '[', '--timeout', '500', ...T], 10000);
      check('wait 非法选择器返回 E_PARAM', bad.ok === false && bad.error?.code === 'E_PARAM', bad.error || bad.data);
    }

    if (should('net-har')) {
      await cli(['eval', "fetch('/api/body').then(r=>r.text())", ...T]);
      const har = await cli(['net-har', '--limit', '30', ...T], 90000);
      const entry = (har.data?.log?.entries || []).find((e) => String(e.request?.url || '').includes('/api/body'));
      check('net-har 包含响应正文', har.ok && entry && String(entry.response?.content?.text || '').includes('HAR-BODY-MARK'), entry || har.error || har.data);
    }

    if (should('emulate')) {
      const em = await cli(['emulate', '--device', 'iphone', ...T]);
      check('emulate 应用 iPhone 设备指标', em.ok && em.data?.applied?.device?.width === 390, em.data || em.error);
      const beforeW = await cli(['eval', 'innerWidth', ...T]);
      check('emulate 后 innerWidth=390', beforeW.data?.value === 390, beforeW.data || beforeW.error);
      const file = path.join(tmp, 'mobile.webp');
      const shot = await cli(['shot', file, '--focus', ...T], 90000);
      const afterW = await cli(['eval', 'innerWidth', ...T]);
      check('emulate 后截图保持移动视口', shot.ok && shot.data?.vw === 390 && !shot.data?.viewportForced, shot.data || shot.error);
      check('emulate 后截图不摧毁模拟', beforeW.data?.value === 390 && afterW.data?.value === 390, { before: beforeW.data?.value, after: afterW.data?.value });
    }

    if (should('text')) {
      const t0 = await cli(['text', ...T]);
      check('text 覆盖 open shadow root 正文', t0.ok && String(t0.data?.text || '').includes('SHADOW-MARK'), t0.data || t0.error);
      check('text 聚合 iframe 正文', t0.ok && String(t0.data?.text || '').includes('FRAME-TEXT') && (t0.data?.frames?.length || 0) >= 2, t0.data || t0.error);
      await cli(['eval', "location.href='/next'", ...T]);
      await sleep(1200);
      const t = await cli(['text', ...T]);
      check('导航后 text 成功', t.ok === true && String(t.data?.text || '').includes('next page'), t.data || t.error);
    }

    if (should('ws')) {
      const beforeWs = await status();
      const sock = new WebSocket('ws://127.0.0.1:9333/ext');
      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        sock.onopen = fin; sock.onerror = fin; setTimeout(fin, 1200);
      });
      await sleep(250);
      const during = await status();
      check('匿名 WS 不进入已验证扩展表', during.extensions.length === beforeWs.extensions.length, { before: beforeWs.extensions.length, during: during.extensions.length });
      try { sock.close(); } catch { /* 忽略 */ }
      await sleep(250);
      const after = await status();
      check('匿名 WS 断开后状态恢复', after.extensions.length === beforeWs.extensions.length, after.extensions);
    }

    if (should('session')) {
      const so = await cli(['session', '--mode', 'open', '--url', url, '--tab-bg']);
      check('session 打开并归入 tab group', so.ok && typeof so.data?.groupId === 'number', so.data || so.error);
      const sc = await cli(['session', '--mode', 'close']);
      check('session close 清理干净', sc.ok && sc.data?.closed >= 1, sc.data || sc.error);
    }

    if (should('origin')) {
      const h = await fetch(BASE + '/health', { headers: { Origin: 'chrome-extension://hhgfgbmegniicpmgaclncepjfcbccjdc' } });
      check('扩展来源 /health 放行', h.status === 200, h.status);
      const evil = await fetch(BASE + '/health', { headers: { Origin: 'https://evil.example' } });
      check('网页来源 /health 仍拒绝', evil.status === 403, evil.status);
    }

  } catch (e) {
    check('回归流程未异常中断', false, e && e.stack || e);
  } finally {
    if (tab) await cli(['close', '--tab', tab]).catch(() => {});
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n通过 ${pass} · 失败 ${fail} · 共 ${results.length}`);
  if (fail) {
    console.log('\n失败明细：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  }
  process.exit(fail ? 1 : 0);
}

function should(n) { return !process.argv.includes('-k') || n.includes(process.argv[process.argv.indexOf('-k') + 1]); }

main();
