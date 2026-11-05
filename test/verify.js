#!/usr/bin/env node
/**
 * Ark Web v5 验收套件
 *
 *   node test/verify.js            跑全部
 *   node test/verify.js -k hover   只跑名字含 hover 的项
 *
 * 与 selftest.js 的分工：
 *   selftest  基础回归（连接/抽取/表格/表单/翻页/错误码）
 *   verify    专项验收（跨 iframe 与 shadow 采集、真实悬停、富文本、自定义下拉、
 *             参数校验、ref 指纹、滚动截图、新标签追踪、内嵌数据、断言、请求拦截）
 *
 * 自带夹具服务（test/probe.html + 分页 + /api/ping），不依赖任何外部服务。
 * 退出码 0 = 全绿。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'client', 'browser-client.js');
const PROBE = readFileSync(path.join(HERE, 'probe.html'), 'utf8');

let BASE = '';

function cli(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ARK_WEB_JSON: '1' },
      windowsHide: true
    });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: { code: 'E_VERIFY_TIMEOUT', message: `${timeoutMs}ms` } }); }, timeoutMs);
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
  results.push({ name, ok: !!cond, detail: cond ? '' : JSON.stringify(detail ?? '').slice(0, 220) });
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${cond ? '' : '  → ' + results.at(-1).detail}`);
}

function pagedPage(n) {
  const rows = { 1: [['A1', '10'], ['A2', '20'], ['A3', '30']], 2: [['A3', '30'], ['A4', '40'], ['A5', '50']], 3: [['A6', '60'], ['A7', '70']] }[n] ?? [];
  const next = n < 3 ? `<a class="next" href="/paged?page=${n + 1}">下一页</a>` : '';
  const items = rows.map(([name, price]) =>
    `<li class="item" data-id="${name}"><span class="name">${name}</span><span class="price">${price}</span></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>分页夹具 ${n}</title></head>`
    + `<body><h1>第 ${n} 页</h1><ul class="list">${items}</ul><div class="pager">${next}</div></body></html>`;
}

async function main() {
  const only = process.argv.includes('-k') ? process.argv[process.argv.indexOf('-k') + 1] : null;
  const should = (n) => !only || n.includes(only);
  const tmp = mkdtempSync(path.join(tmpdir(), 'arkv5-'));

  const server = createServer((req, res) => {
    if (req.url.startsWith('/paged')) {
      const q = new URL(req.url, 'http://x').searchParams;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pagedPage(Number(q.get('page') ?? 1)));
      return;
    }
    if (req.url.startsWith('/api/ping')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PROBE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  // 第二个 origin（端口不同 = 跨域），专门验证跨域 iframe 能不能走真实输入
  const xoServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8">
      <style>body{margin:0;font:14px sans-serif}#xoBtn{margin:40px;padding:18px 26px}</style>
      <button id="xoBtn" onclick="this.textContent='跨域已点击'">跨域按钮</button>`);
  });
  await new Promise((r) => xoServer.listen(0, '127.0.0.1', r));
  const XO = `http://127.0.0.1:${xoServer.address().port}`;
  console.log(`夹具服务: ${BASE}   跨域夹具: ${XO}\n`);

  let tab = null;
  try {
    // 清掉上次中断留下的夹具标签
    const t0 = await cli(['tabs']);
    for (const x of t0.data?.tabs ?? []) {
      if (String(x.url ?? '').startsWith(BASE)) await cli(['close', '--tab', String(x.id)]);
    }

    const opened = await cli(['open', `${BASE}/`, '--tab-bg']);
    tab = String(opened.data?.id ?? '');
    if (!tab) { check('打开探针页', false, opened); throw new Error('open 失败'); }
    const T = ['--tab', tab];
    await cli(['dialog', '--policy', 'accept', ...T]);
    await cli(['activate', ...T]);
    await new Promise((r) => setTimeout(r, 700));

    // ── 跨边界采集 ──
    if (should('cross')) {
      const snap = await cli(['snapshot', path.join(tmp, 'snap.webp'), '--shot', '--focus', '--limit', '60', ...T]);
      const els = snap.data?.elements ?? [];
      const has = (re) => els.some((e) => re.test(String(e.text)));
      check('cross: role=combobox 出现在快照中', has(/请选择城市/), els.map((e) => e.text).slice(0, 12));
      check('cross: shadow DOM 内按钮被采集', has(/Shadow 内按钮/), els.map((e) => e.text));
      check('cross: iframe 内元素被采集', has(/iframe 按钮/) || has(/iframe 内输入框/), els.map((e) => e.text));
      check('cross: 报告多个 frame', (snap.data?.frames?.length ?? 0) >= 2, snap.data?.frames);
      check('cross: 元素带语义上下文', els.some((e) => e.context), els[0]);
      check('cross: 截图落盘且带编号', existsSync(path.join(tmp, 'snap.webp')) && statSync(path.join(tmp, 'snap.webp')).size > 5000,
        existsSync(path.join(tmp, 'snap.webp')) ? statSync(path.join(tmp, 'snap.webp')).size : 0);
    }

    // ── 真实悬停 ──
    if (should('hover')) {
      const hov = await cli(['hover', '--selector', '#menuBtn', ...T]);
      // 子菜单可能带过渡：轮询到展开为止（最多 1.2s），避免固定 sleep 的时序抖动
      let display = null;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const d = await cli(['eval', 'getComputedStyle(document.getElementById("sub")).display', ...T]);
        display = d.data?.value;
        if (display === 'block') break;
      }
      check('hover: 触发 CSS :hover（子菜单展开）', display === 'block',
        { display, hoverActive: hov.data?.hoverActive, err: hov.error });
    }

    // ── 等待（事件驱动） ──
    if (should('wait')) {
      const t0 = Date.now();
      const w = await cli(['wait', '--selector', '#farTarget', ...T]);
      check('wait: 命中且给出通道', w.ok && !!w.data?.via, w.data || w.error);
      check('wait: 命中耗时 < 800ms', Date.now() - t0 < 800, { ms: Date.now() - t0 });
    }

    // ── 富文本填写 ──
    if (should('fill')) {
      const f1 = await cli(['fill', '--selector', '#rt', '--text', 'hello-rt', ...T]);
      const rt = await cli(['eval', 'document.getElementById("rt").textContent', ...T]);
      check('fill: contenteditable 填写并回读校验',
        f1.ok && f1.data?.verified === true && String(rt.data?.value).includes('hello-rt'),
        { ok: f1.ok, data: f1.data, err: f1.error, text: rt.data?.value });
    }

    // ── 下拉 ──
    if (should('select')) {
      const sCustom = await cli(['select', '--selector', '#combo', '--values', '上海', ...T]);
      const comboText = await cli(['eval', 'document.getElementById("combo").textContent', ...T]);
      check('select: 自定义下拉可选中', sCustom.ok && sCustom.data?.mode === 'custom' && String(comboText.data?.value).includes('上海'),
        { data: sCustom.data, err: sCustom.error, text: comboText.data?.value });
      const sNative = await cli(['select', '--selector', '#nat', '--values', 'b', ...T]);
      check('select: 原生 select 走直接赋值', sNative.ok && sNative.data?.mode === 'native', sNative.data || sNative.error);
    }

    // ── 参数校验 ──
    if (should('param')) {
      const bad1 = await cli(['scroll', '--dy', 'abc', ...T]);
      check('param: scroll --dy abc 返回 E_PARAM', bad1.ok === false && bad1.error?.code === 'E_PARAM', bad1.error);
      const bad2 = await cli(['click', '--ref', 'abc', ...T]);
      check('param: click --ref abc 返回 E_PARAM', bad2.ok === false && bad2.error?.code === 'E_PARAM', bad2.error);
      const chain = await cli(['chain', 'eval 1+1', '--tab', '999999']);
      check('param: chain 顶层 --tab 生效', chain.ok === false, chain.error || chain.data);
    }

    // ── ref 指纹 ──
    if (should('refs')) {
      const found = await cli(['find', '--text', '提交订单', '--role', 'button', ...T]);
      const dangerRef = found.data?.items?.[0]?.ref;
      await cli(['eval', `const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='提交订单');b.textContent='删除账户';b.onclick=()=>{document.getElementById('log').textContent='deleted'};"ok"`, ...T]);
      const drift = await cli(['click', '--ref', String(dangerRef), ...T]);
      const logAfter = await cli(['eval', 'document.getElementById("log").textContent', ...T]);
      check('refs: 语义漂移后拒绝点击（E_STALE_REF）', drift.ok === false && drift.error?.code === 'E_STALE_REF', drift.error);
      check('refs: 漂移元素确实没被点到', logAfter.data?.value !== 'deleted', logAfter.data?.value);

      const a = await cli(['snapshot', '--no-shot', ...T]);
      const b = await cli(['snapshot', '--no-shot', ...T]);
      check('refs: 二次快照复用编号', (b.data?.reused ?? 0) > 0, { reused: b.data?.reused, assigned: b.data?.assigned });
    }

    // ── 滚动后截图 ──
    if (should('shot')) {
      await cli(['scroll', '--dy', '3000', ...T]);
      const farFile = path.join(tmp, 'far.webp');
      const shot = await cli(['shot', farFile, '--selector', '#farTarget', '--focus', ...T]);
      const bytes = existsSync(farFile) ? statSync(farFile).size : 0;
      check('shot: 滚动后元素截图不空白', shot.ok && bytes > 3000, { bytes, clip: shot.data?.clip, err: shot.error });

      // 视觉回归：同目标第二次才拿得到变化率
      const d1 = await cli(['shot', path.join(tmp, 'd1.webp'), '--selector', '#farTarget', '--diff', '--focus', ...T]);
      const d2 = await cli(['shot', path.join(tmp, 'd2.webp'), '--selector', '#farTarget', '--diff', '--focus', ...T]);
      check('shot: 首次 --diff 无基线', d1.ok && d1.data?.diff?.firstRun === true, d1.data?.diff || d1.error);
      check('shot: 二次 --diff 给出变化率', d2.ok && typeof d2.data?.diff?.changedPct === 'number', d2.data?.diff || d2.error);
      await cli(['scroll', '--dy', '-3000', ...T]);
    }

    // ── 新标签追踪 ──
    if (should('tab')) {
      const blank = await cli(['click', '--selector', '#blankLink', ...T]);
      check('tab: 点击 target=_blank 回报新标签', blank.ok && !!blank.data?.openedTab, { data: blank.data, err: blank.error });
      if (blank.data?.openedTab?.id) await cli(['close', '--tab', String(blank.data.openedTab.id)]);
    }

    // ── 内嵌数据 / 断言 / 真实点击 ──
    if (should('state')) {
      const st = await cli(['state', ...T]);
      check('state: 提取 JSON-LD', st.ok && (st.data?.found ?? 0) > 0 && JSON.stringify(st.data).includes('探针商品'), st.data || st.error);
    }
    if (should('assert')) {
      const as1 = await cli(['assert', '--selector', '#h', '--text', '探针页', ...T]);
      check('assert: 通过路径', as1.ok && as1.data?.pass === true, as1.error);
      const as2 = await cli(['assert', '--selector', '#h', '--text', '不存在的文字', ...T]);
      check('assert: 失败路径返回 E_ASSERT', as2.ok === false && as2.error?.code === 'E_ASSERT', as2.error);
    }
    if (should('click')) {
      const c = await cli(['click', '--selector', '#mutateBtn', ...T]);
      check('click: 走 CDP 真输入（via=cdp）', c.ok && c.data?.via === 'cdp', c.data || c.error);
      check('click: 效果被确认', c.data?.mutated === true || c.data?.settled === true, c.data);
    }

    // ── 子框架可点 ──
    if (should('frame')) {
      const iframeBtn = await cli(['find', '--text', 'iframe 按钮', ...T]);
      const iref = iframeBtn.data?.items?.[0]?.ref;
      const iclick = iref ? await cli(['click', '--ref', String(iref), ...T]) : { ok: false, error: { code: 'E_NOT_FOUND' } };
      check('frame: 子框架元素可点击', iclick.ok === true, iclick.error || iclick.data);
    }

    // ── 网络与性能 ──
    if (should('net')) {
      const net = await cli(['net', '--limit', '5', ...T]);
      check('net: 网络捕获正常', net.ok === true, net.error);

      const real = await cli(['eval', 'fetch("/api/ping").then(r=>r.json()).then(j=>JSON.stringify(j))', ...T]);
      check('net: 真实响应可用', String(real.data?.value).includes('"ok":true'), real.data?.value);
      await cli(['net-intercept', ...T]);
      await cli(['net-rule', '--add', '{"pattern":"/api/ping","action":"mock","status":200,"body":"{\\"ok\\":true,\\"mocked\\":1}"}', ...T]);
      const mocked = await cli(['eval', 'fetch("/api/ping").then(r=>r.json()).then(j=>JSON.stringify(j))', ...T]);
      check('net: 拦截 mock 生效', String(mocked.data?.value).includes('mocked'), mocked.data?.value);
      await cli(['net-intercept', '--on', 'false', ...T]);
      await cli(['net-rule', '--clear', ...T]);
      const after = await cli(['eval', 'fetch("/api/ping").then(r=>r.json()).then(j=>JSON.stringify(j))', ...T]);
      check('net: 关闭拦截后恢复真实响应', !String(after.data?.value).includes('mocked'), after.data?.value);
    }
    if (should('perf')) {
      const perf = await cli(['perf', ...T]);
      const v = perf.data?.vitals;
      check('perf: 返回 Web Vitals', perf.ok && v?.ttfb != null, v || perf.error);
      check('perf: 带 CLS/INP/LongTask 字段', v && 'cls' in v && 'inp' in v && 'longTasks' in v, v);
    }

    // ── 跨域 iframe 真实输入 ──
    if (should('xo')) {
      await cli(['eval', `(() => {
        const old = document.getElementById('xoFrame'); if (old) old.remove();
        const f = document.createElement('iframe');
        f.id = 'xoFrame'; f.src = '${XO}/xo';
        f.style.cssText = 'width:420px;height:220px;border:1px solid #999';
        document.body.prepend(f);
        return 'inserted';
      })()`, ...T]);
      const w = await cli(['wait', '--selector', '#xoBtn', ...T]);
      check('xo: 跨域 iframe 已加载（等待中新 frame 能被发现）', w.ok, w.error || w.data);

      const f = await cli(['find', '--selector', '#xoBtn', ...T]);
      const hit = f.data?.items?.[0];
      check('xo: 能定位到跨域元素（带 frame 标记）', hit != null && String(hit.frame || '') !== '', hit || f.error);

      const c = await cli(['click', '--ref', String(hit?.ref), ...T]);
      check('xo: 跨域点击走真实输入（via=cdp）', c.ok && c.data?.via === 'cdp', c.data || c.error);

      const after = await cli(['find', '--text', '跨域已点击', ...T]);
      check('xo: 点击确实作用到跨域页面', (after.data?.total ?? 0) > 0, after.data || after.error);

      await cli(['eval', `document.getElementById('xoFrame')?.remove();'ok'`, ...T]);
    }

    // ── 环境模拟 ──
    if (should('emulate')) {
      const e1 = await cli(['emulate', '--device', 'iphone', '--cpu', '4', '--network', 'slow3g', '--media', 'dark', ...T]);
      check('emulate: 应用设备/CPU/网络/媒体', e1.ok && e1.data?.applied?.device?.width === 390 && e1.data.applied.cpu === 4,
        e1.data?.applied || e1.error);
      const e2 = await cli(['emulate', '--reset', ...T]);
      check('emulate: --reset 还原', e2.ok && e2.data?.reset === true, e2.data || e2.error);
    }

    // ── 覆盖率 ──
    if (should('coverage')) {
      const s = await cli(['coverage', '--mode', 'start', ...T]);
      check('coverage: start', s.ok && s.data?.started === true, s.data || s.error);
      await cli(['eval', '1+1', ...T]);
      const r = await cli(['coverage', '--mode', 'stop', ...T]);
      const d = r.data;
      check('coverage: 汇总 JS/CSS 使用率', r.ok && d && typeof d.js?.pct === 'number' && typeof d.css?.pct === 'number', d || r.error);
      check('coverage: 排除其它扩展脚本', r.ok && typeof d?.js?.skippedExtensionScripts === 'number', d?.js);
    }

    // ── chain 取值 ──
    if (should('chain')) {
      const c = await cli(['chain', 'find --selector #farTarget', 'attr --ref {{steps.0.items.0.ref}}', ...T]);
      check('chain: {{steps.N.…}} 取值生效', c.ok && c.data?.results?.[1]?.ok === true &&
        String(c.data.results[1].step).includes('attr --ref ') && !String(c.data.results[1].step).includes('{{'),
        c.data?.results?.[1] || c.error);
    }

    // ── diff ──
    if (should('diff')) {
      const d = await cli(['snapshot', '--no-shot', '--diff', ...T]);
      check('diff: 第二次快照返回 delta', d.data?.diff?.mode === 'delta', d.data?.diff);
    }

  } catch (e) {
    check('验收流程未异常中断', false, e && e.message);
  } finally {
    if (tab) await cli(['close', '--tab', tab]);
    try { server.closeAllConnections?.(); } catch { /* 老版本没有这个方法 */ }
    await new Promise((r) => server.close(r));
    try { xoServer.closeAllConnections?.(); } catch { /* 同上 */ }
    await new Promise((r) => xoServer.close(r));
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

main();
