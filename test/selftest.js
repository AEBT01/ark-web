#!/usr/bin/env node
/**
 * Ark Web 自检套件
 *
 *   node test/selftest.js           跑全部
 *   node test/selftest.js -k extract  只跑名字含 extract 的项
 *
 * 无外部网络依赖：起本地 HTTP 服务喂 fixture.html，逐条断言 CLI 的 JSON envelope。
 * 退出码 0 = 全绿，1 = 有失败。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'client', 'browser-client.js');
// 端口用 0 让系统分配：并发跑或用例中断时不会 EADDRINUSE
let PORT = 0;
let BASE = '';
const FIXTURE = readFileSync(path.join(HERE, 'fixture.html'), 'utf8');

function cli(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ARK_WEB_JSON: '1' },
      windowsHide: true
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: { code: 'E_SELFTEST_TIMEOUT', message: `${timeoutMs}ms` } }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: { code: 'E_NO_JSON', message: (err || out).slice(0, 200) } });
      }
    });
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail ?? '').slice(0, 200)) });
  const mark = cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  process.stdout.write(`  ${mark} ${name}${cond ? '' : `  → ${results.at(-1).detail}`}\n`);
}

async function main() {
  const only = process.argv.includes('-k') ? process.argv[process.argv.indexOf('-k') + 1] : null;
  const should = (n) => !only || n.includes(only);

  // 本地夹具服务
  // 分页夹具：3 页、页间有 1 条重复、末页无 next
  const pagedPage = (n) => {
    const rows = { 1: [['A1', '10'], ['A2', '20'], ['A3', '30']],
                   2: [['A3', '30'], ['A4', '40'], ['A5', '50']],
                   3: [['A6', '60'], ['A7', '70']] }[n] ?? [];
    const next = n < 3 ? `<a class="next" href="/paged?page=${n + 1}">下一页</a>` : '';
    const items = rows.map(([name, price]) =>
      `<li class="item" data-id="${name}"><span class="name">${name}</span><span class="price">${price}</span></li>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>分页夹具 ${n}</title></head>`
      + `<body><h1>第 ${n} 页</h1><ul class="list">${items}</ul><div class="pager">${next}</div></body></html>`;
  };

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
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`夹具服务: ${BASE}\n`);

  let tabId = null;
  try {
    // 开局清掉上次中断留下的夹具标签（可能带着未处理的 alert，会阻塞渲染器）
    const existing = await cli(['tabs']);
    for (const x of existing.data?.tabs ?? []) {
      if (String(x.url ?? '').startsWith(BASE)) await cli(['close', '--tab', String(x.id)]);
    }

    if (should('status')) {
      const r = await cli(['status']);
      check('status 返回 ok 且已连接', r.ok && r.data?.connected === true, r);
    }

    if (should('describe')) {
      const r = await cli(['describe']);
      check('describe 列出 ≥25 个命令', r.ok && r.data?.commands?.length >= 25, r.data?.commands?.length);
      const one = await cli(['describe', 'extract']);
      check('describe extract 带参数说明', one.ok && one.data?.params?.fields?.required === true, one);
    }

    // 以下两步是全部用例的前置（不参与 -k 过滤）
    {
      const r = await cli(['open', `${BASE}/`, '--tab-bg']);
      tabId = r.data?.id ?? null;
      check('open 拿到 tab 且开启捕获', r.ok && tabId && r.data?.capturing === true, r);
      // 立刻上弹窗策略：任何时刻弹窗都可能阻塞渲染器，导致后续所有命令超时
      if (tabId) await cli(['dialog', '--policy', 'accept', '--tab', String(tabId)]);
    }
    if (!tabId) {
      const t = await cli(['tabs']);
      tabId = t.data?.tabs?.find((x) => (x.url ?? '').startsWith(BASE))?.id ?? null;
    }
    if (!tabId) throw new Error('没有可用的测试标签页，open 步骤失败');

    if (should('wait-idle')) {
      const r = await cli(['wait-idle', '--timeout', '8000', '--tab', String(tabId)]);
      check('wait-idle 报告网络安静', r.ok && r.data?.idle === true, r);
    }

    if (should('eval')) {
      const r = await cli(['eval', 'document.title', '--tab', String(tabId)]);
      check('eval 读到页面标题', r.ok && r.data?.value === 'Ark Web 自检夹具', r);
    }

    if (should('extract')) {
      const r = await cli(['extract', '--selector', '.item',
        '--fields', 'name:.name, price:.price, link:.link@href, id:self@data-id',
        '--limit', '10', '--tab', String(tabId)]);
      const rows = r.data?.rows ?? [];
      check('extract 命中 4 行', r.ok && r.data?.count === 4 && rows.length === 4, r.data?.count);
      check('extract 取到文本字段', rows[0]?.name === 'Alpha' && rows[1]?.price === '￥240', rows[0]);
      check('extract 把 href 补成绝对地址', String(rows[0]?.link ?? '').startsWith(BASE), rows[0]?.link);
      check('extract 支持容器自身属性', rows[2]?.id === '3', rows[2]);

      const c = await cli(['extract', '--selector', '.item', '--fields', 'name:.name, price:.price',
        '--compact', '--tab', String(tabId)]);
      check('extract --compact 丢弃空字段', c.ok && !('price' in (c.data.rows[3] ?? {})), c.data?.rows?.[3]);
    }

    if (should('table')) {
      const r = await cli(['table', '--selector', '#prices', '--tab', String(tabId)]);
      const rows = r.data?.rows ?? [];
      check('table 识别表头', r.ok && r.data.header.join(',') === '名称,价格,库存', r.data?.header);
      check('table 解析 3 行', rows.length === 3 && rows[1]['价格'] === '240', rows[1]);
    }

    if (should('text')) {
      const r = await cli(['text', '--max-len', '500', '--tab', String(tabId)]);
      check('text 抽到正文', r.ok && r.data.text.includes('自检夹具'), r.data?.chars);
    }

    if (should('attr')) {
      const r = await cli(['attr', '--selector', '#title', '--tab', String(tabId)]);
      check('attr 读到元素文本', r.ok && r.data?.text === '自检夹具' && r.data?.visible === true, r.data?.text);
    }

    if (should('fill')) {
      const r = await cli(['fill', '--selector', '#kw', '--text', 'hello-ark', '--tab', String(tabId)]);
      const v = await cli(['eval', 'document.getElementById("kw").value', '--tab', String(tabId)]);
      check('fill 写入输入框', r.ok && v.data?.value === 'hello-ark', v.data?.value);
    }

    if (should('press')) {
      await cli(['press', '--selector', '#kw', '--key', 'Enter', '--tab', String(tabId)]);
      await cli(['wait', '--selector', '#echo:not(:empty)', '--timeout', '5000', '--tab', String(tabId)]);
      const v = await cli(['eval', 'document.getElementById("echo").textContent', '--tab', String(tabId)]);
      check('press Enter 触发表单提交', v.data?.value === 'hello-ark', v.data?.value);
    }

    if (should('select')) {
      await cli(['select', '--selector', '#sel', '--values', 'b', '--tab', String(tabId)]);
      const v = await cli(['eval', 'document.getElementById("sel").value', '--tab', String(tabId)]);
      check('select 选中指定值', v.data?.value === 'b', v.data?.value);
    }

    if (should('hover')) {
      await cli(['hover', '--selector', '#hoverBtn', '--tab', String(tabId)]);
      const v = await cli(['eval', 'document.getElementById("tip").classList.contains("hidden") ? "hidden" : "shown"', '--tab', String(tabId)]);
      check('hover 触发悬浮内容', v.data?.value === 'shown', v.data?.value);
    }

    if (should('find')) {
      const r1 = await cli(['find', '--text', '提交', '--role', 'button', '--tab', String(tabId)]);
      const top = r1.data?.items?.[0];
      check('find 按文字找到按钮', r1.ok && top?.text === '提交' && top?.clickable === true, r1.data?.items);
      check('find 给出可直接用的 ref', r1.ok && Number.isInteger(top?.ref) && top.ref > 0, top?.ref);

      const r2 = await cli(['find', '--text', '关键词', '--tab', String(tabId)]);
      check('find 命中 placeholder', r2.ok && (r2.data?.items ?? []).some((x) => x.tag === 'input'), r2.data?.items);

      const r3 = await cli(['find', '--text', '被遮挡', '--tab', String(tabId)]);
      const cov = r3.data?.items?.[0];
      check('find 检出被遮挡元素', r3.ok && !!cov?.coveredBy && cov?.clickable === false,
        { coveredBy: cov?.coveredBy, clickable: cov?.clickable });
    }

    if (should('covered')) {
      const r = await cli(['click', '--selector', '#coveredBtn', '--tab', String(tabId)]);
      check('点击被遮挡元素返回 E_COVERED', r.ok === false && r.error?.code === 'E_COVERED', r.error);
      check('E_COVERED 带修复建议', !!r.error?.hint, r.error?.hint);
    }

    if (should('confirm')) {
      const r = await cli(['click', '--selector', '#mutateBtn', '--tab', String(tabId)]);
      check('点击后确认 DOM 变化', r.ok && r.data?.mutated === true && r.data?.settled === true,
        { mutated: r.data?.mutated, settled: r.data?.settled, waited: r.data?.waitedMs });
      const echo = await cli(['eval', "document.getElementById('echo').textContent", '--tab', String(tabId)]);
      check('确认结果与页面实际一致', echo.data?.value === 'mutated', echo.data?.value);
    }

    if (should('refstable')) {
      const a = await cli(['snapshot', '--no-shot', '--tab', String(tabId)]);
      const b = await cli(['snapshot', '--no-shot', '--tab', String(tabId)]);
      const mapA = new Map((a.data?.elements ?? []).map((e) => [e.ref, e.text]));
      const drift = (b.data?.elements ?? []).filter((e) => mapA.has(e.ref) && mapA.get(e.ref) !== e.text);
      check('两次 snapshot 的 ref 复用', (b.data?.reused ?? 0) > 0, b.data?.reused);
      check('ref 复用后指向同一元素', drift.length === 0, drift.slice(0, 3));
    }

    if (should('dialog')) {
      // 后台标签的 alert 会被 Chrome 推迟显示，事件也迟迟不到；
      // activate 只在本窗口内切换标签，不会抢系统焦点。
      await cli(['activate', '--tab', String(tabId)]);
      await cli(['dialog', '--policy', 'accept', '--tab', String(tabId)]);
      await cli(['eval', 'setTimeout(()=>document.getElementById("alertBtn").click(),30);"ok"', '--tab', String(tabId)]);
      await new Promise((r) => setTimeout(r, 700));
      const r = await cli(['dialog', '--limit', '5', '--tab', String(tabId)]);
      const hit = (r.data?.items ?? []).some((x) => x.message === 'fixture-alert');
      check('dialog 捕获并自动确认', r.ok && hit, r.data?.items);
      await cli(['dialog', '--policy', 'manual', '--tab', String(tabId)]);
    }

    if (should('wait')) {
      const r = await cli(['wait', '--selector', '#delayedReady', '--timeout', '3000', '--tab', String(tabId)]);
      check('wait 等到延迟出现的内容', r.ok && r.data?.ok === true, r);
      const t = await cli(['wait', '--selector', '#never-exists', '--timeout', '600', '--tab', String(tabId)]);
      check('wait 超时返回 E_TIMEOUT', t.ok === false && t.error?.code === 'E_TIMEOUT', t.error);
    }

    if (should('net')) {
      const r = await cli(['net', '--filter', 'api', '--tab', String(tabId)]);
      const hit = (r.data?.items ?? []).find((e) => e.url.includes('/api/ping'));
      check('net 捕获到 XHR', r.ok && !!hit && hit.status === 200, r.data?.items);
      if (hit) {
        const b = await cli(['net-body', hit.requestId, '--tab', String(tabId)]);
        check('net-body 取到响应正文', b.ok && String(b.data?.body ?? '').includes('"ok":true'), b.data?.body);
      }
    }

    if (should('perf')) {
      const r = await cli(['perf', '--tab', String(tabId)]);
      check('perf 返回节点数', r.ok && (r.data?.metrics?.Nodes ?? 0) > 0, r.data?.metrics?.Nodes);
    }

    if (should('upload')) {
      const dir = mkdtempSync(path.join(tmpdir(), 'ark-'));
      const f = path.join(dir, 'up.txt');
      writeFileSync(f, 'ark upload\n');
      const r = await cli(['upload', '--selector', '#file', '--file', f, '--tab', String(tabId)]);
      check('upload 写入文件输入框', r.ok && r.data?.input?.count === 1, r.data);
    }

    if (should('shot')) {
      const dir = mkdtempSync(path.join(tmpdir(), 'arkshot-'));
      const f = path.join(dir, 'el.webp');
      const r = await cli(['shot', f, '--selector', '#prices', '--focus', '--tab', String(tabId)]);
      const size = existsSync(f) ? readFileSync(f).length : 0;
      check('shot 元素截图落盘且有内容', r.ok && size > 500, { size, clip: r.data?.clip });
    }

    if (should('chain')) {
      const r = await cli(['chain', 'eval 1+1', 'eval 2+2', '--tab', String(tabId)]);
      check('chain 串联 2 步', r.ok && r.data?.steps === 2, r.data?.steps);
    }

    if (should('error')) {
      const r = await cli(['click', '--selector', '#nope-not-here', '--tab', String(tabId)]);
      check('未知元素返回 ok:false + code', r.ok === false && !!r.error?.code, r.error);
      const u = await cli(['frobnicate']);
      check('未知命令返回 E_UNKNOWN_CMD', u.ok === false && u.error?.code === 'E_UNKNOWN_CMD', u.error);
      const p = await cli(['extract', '--tab', String(tabId)]);
      check('缺参数返回 E_PARAM', p.ok === false && p.error?.code === 'E_PARAM', p.error);
    }
    if (should('paginate')) {
      const o = await cli(['open', `${BASE}/paged?page=1`, '--tab-bg']);
      const pt = o.data?.id;
      check('分页夹具可打开', o.ok && !!pt, o);
      if (pt) {
        const r = await cli(['extract', '--selector', '.item',
          '--fields', 'name:.name, price:.price, id:self@data-id',
          '--paginate', '--next', 'a.next', '--max-pages', '5', '--delay', '300',
          '--tab', String(pt)], 180000);
        const rows = r.data?.rows ?? [];
        check('翻页走完 3 页', r.ok && r.data?.pages === 3, { pages: r.data?.pages, stop: r.data?.stopReason, err: r.error });
        check('翻页去重后 7 行', rows.length === 7 && r.data?.collected === 7, { got: rows.length, collected: r.data?.collected });
        check('翻页检出 1 条重复', r.data?.duplicates === 1, r.data?.duplicates);
        check('末页无 next 时停止', r.data?.stopReason === 'no-next', r.data?.stopReason);
        check('翻页后 _index 全局连续', rows[6]?._index === 6, rows[6]);
        check('pageDetail 记录每页真实 URL',
          String(r.data?.pageDetail?.[2]?.url ?? '').includes('page=3'),
          r.data?.pageDetail?.map((x) => x.url));
        const bad = await cli(['extract', '--selector', '.item', '--fields', 'name:.name',
          '--paginate', '--tab', String(pt)]);
        check('--paginate 缺 --next 返回 E_PARAM', bad.ok === false && bad.error?.code === 'E_PARAM', bad.error);
        await cli(['close', '--tab', String(pt)]);
      }
    }

  } catch (e) {
    check('自检流程未异常中断', false, e.message);
  } finally {
    if (tabId) await cli(['close', '--tab', String(tabId)]);
    // 浏览器会保持 keep-alive 连接，只调 close() 事件循环不会退出（会「跑完卡住」）
    try { server.closeAllConnections?.(); } catch { }
    await new Promise((r) => server.close(r));
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n通过 ${pass} · 失败 ${fail} · 共 ${results.length}`);
  if (fail) {
    console.log('\n失败明细：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  }
  // 显式退出：避免任何残留句柄让进程挂着
  process.exit(fail ? 1 : 0);
}

main();
