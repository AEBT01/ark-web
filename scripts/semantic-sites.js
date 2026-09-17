#!/usr/bin/env node
/**
 * semantic-sites.js — 多站点语义提取验证
 *
 * 对一批真实站点逐个执行：会话内后台开页 → CDP 授权 → 注入提取器 → 记录统计 → 关页
 * 产出：终端汇总表 + semantic/sites-data/<name>.json（完整单元数据，供人工核对质量）
 *
 * 用法: node scripts/semantic-sites.js [--only <名称>] [--keep]
 *   --only  只跑指定站点（便于单站迭代规则）
 *   --keep  保留标签页不关闭（人工查看用）
 */
const fs = require('fs');
const path = require('path');
const BrowserClient = require('../client/browser-client');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'semantic', 'extractor.js'), 'utf8');
const OUT_DIR = path.join(__dirname, '..', 'semantic', 'sites-data');

/** 站点清单：混合中英文、静态/SPA、不同内容形态 */
const SITES = [
  { name: 'wikipedia-en', url: 'https://en.wikipedia.org/wiki/Web_browser', kind: '百科(内容密集)' },
  { name: 'mdn-docs', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', kind: '文档(代码块密集)' },
  { name: 'github-issues', url: 'https://github.com/microsoft/vscode/issues', kind: 'SPA列表' },
  { name: 'hn-front', url: 'https://news.ycombinator.com/', kind: '社区列表(极简)' },
  { name: 'stackoverflow', url: 'https://stackoverflow.com/questions', kind: '问答列表' },
  { name: 'v2ex', url: 'https://www.v2ex.com/', kind: '中文社区' },
  { name: 'juejin', url: 'https://juejin.cn/', kind: '中文内容(SPA)' },
  { name: 'douban-book', url: 'https://book.douban.com/subject/1084336/', kind: '图书详情(卡片)' }
];

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };
const ONLY = val('--only');
const KEEP = args.includes('--keep');

const client = new BrowserClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

const opts = { maxTextLen: 1200 };
const CODE = '(function(){\n' + SRC + '\nreturn ArkSemantic.extractSemanticUnits(document, ' + JSON.stringify(opts) + ');\n})()';

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sess = await client.post('/session/create', {});
  const sid = sess.sessionId;
  console.log('\n=== 多站点语义提取验证 ===');
  console.log('会话: ' + sid + '   站点数: ' + (ONLY ? 1 : SITES.length) + '\n');

  const rows = [];
  for (const site of SITES) {
    if (ONLY && site.name !== ONLY) continue;
    const row = { name: site.name, kind: site.kind, url: site.url, tabId: null };
    let tabId = null;
    const t0 = Date.now();
    try {
      // 1) 会话内后台开页（不抢焦点）；tabId 直接取返回的 tab.id
      //    （不要轮询匹配 URL：后台标签页的 url 字段填充有延迟，会匹配失败）
      const openRes = await client.post('/session/tab', { sessionId: sid, url: site.url });
      tabId = (openRes.tab && openRes.tab.id) || null;
      if (!tabId) throw new Error('开页未返回 tabId: ' + JSON.stringify(openRes).slice(0, 100));
      row.tabId = tabId;
      client.tabId = tabId;

      // 3) 等加载 + 授权 + 提取
      await client.post('/wait-for-load', { timeout: 25000 }).catch(() => null);
      await sleep(1200);
      await client.post('/debug/attach-all', {}).catch(() => null);
      const res = await client.evaluate(CODE, 90000);
      const data = (res && res.result !== undefined) ? res.result : res;
      if (!data || !data.stats) throw new Error('提取返回异常: ' + JSON.stringify(res).slice(0, 120));

      row.units = data.stats.accepted;
      row.groups = data.stats.groups;
      row.types = data.stats.typeCounts;
      row.rejected = data.stats.rejected;
      row.pageMs = data.stats.elapsedMs;
      row.totalMs = Date.now() - t0;
      row.title = data.title;
      row.topUnits = data.units.slice(0, 3).map((u) => ({ type: u.type, len: u.charLen, text: cut(u.text.replace(/\n/g, ' '), 60) }));
      fs.writeFileSync(path.join(OUT_DIR, site.name + '.json'), JSON.stringify(data, null, 1), 'utf8');
    } catch (e) {
      row.error = String(e.message || e).slice(0, 200);
      row.totalMs = Date.now() - t0;
    }
    rows.push(row);

    // 4) 关页（--keep 时保留）
    if (tabId && !KEEP) {
      try { await client.post('/tab/close', { tabId: tabId }); } catch (e) { /* ignore */ }
    }
    client.tabId = null;
    console.log((row.error ? '✗ ' : '✓ ') + site.name.padEnd(16) + (row.error ? row.error : row.units + ' 单元 / ' + row.pageMs + 'ms'));
  }

  // ---- 汇总表 ----
  console.log('\n' + '='.repeat(104));
  console.log('站点'.padEnd(16) + '形态'.padEnd(20) + '单元'.padStart(6) + '  页面内耗时'.padStart(10) + '  噪声拒绝(按原因)');
  console.log('-'.repeat(104));
  for (const r of rows) {
    if (r.error) { console.log(r.name.padEnd(16) + (r.kind || '').padEnd(20) + '  失败: ' + r.error); continue; }
    const rej = Object.entries(r.rejected || {}).map(([k, v]) => k + '=' + v).join(' ');
    console.log(
      r.name.padEnd(16) + (r.kind || '').padEnd(20) +
      String(r.units).padStart(6) + '  ' + (r.pageMs + 'ms').padStart(10) + '  ' + rej
    );
  }
  console.log('='.repeat(104));

  // ---- 类型分布 ----
  console.log('\n类型分布：');
  for (const r of rows) {
    if (r.error) continue;
    const t = Object.entries(r.types || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join('  ');
    console.log('  ' + r.name.padEnd(16) + t);
  }

  // ---- 抽检样本 ----
  console.log('\n质量抽检（每站前 3 个单元）：');
  for (const r of rows) {
    if (r.error) continue;
    console.log('  [' + r.name + '] ' + (r.title || '').slice(0, 50));
    (r.topUnits || []).forEach((u) => console.log('     ' + u.type.padEnd(12) + u.len + '字  ' + u.text));
  }

  await client.post('/session/delete', { sessionId: sid, closeTabs: false }).catch(() => null);
  console.log('\n数据已存至 semantic/sites-data/');
  console.log('');
})().catch((e) => { console.error('执行失败: ' + e.message); process.exit(1); });
