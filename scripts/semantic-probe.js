#!/usr/bin/env node
/**
 * semantic-probe.js — 语义单元提取探测（语义层第一阶段验证）
 *
 * 把 semantic/extractor.js 注入目标页面执行（纯只读：不改 DOM、不点击、不导航），打印：
 *   - 提取统计：候选组、接受单元、按原因拒绝的噪声分类
 *   - 类型分布、耗时、单元样本
 *   - 数据量对照：语义索引 vs 全量快照（token 成本参考）
 *
 * 用法: node scripts/semantic-probe.js [--tabId <id>] [--max 10] [--json out.json] [--no-snap]
 */
const fs = require('fs');
const path = require('path');
const BrowserClient = require('../client/browser-client');

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };
const has = (f) => args.includes(f);
const TAB = val('--tabId');
const MAX = +(val('--max') || 10);
const OUT = val('--json');
const NO_SNAP = has('--no-snap');

const client = new BrowserClient({ tabId: TAB });
const SRC = fs.readFileSync(path.join(__dirname, '..', 'semantic', 'extractor.js'), 'utf8');

/** 检索基准用例（针对 test-page.html 的已知答案；最后一条故意是模糊语义，用于暴露关键词检索的短板） */
const BENCH_CASES = [
  { q: '太棒了', want: '这视频太棒了', note: '歧义场景：两条评论都含此短语' },
  { q: '实验支撑', want: '缺少实验支撑' },
  { q: '开发板', want: 'ESP32-C3 开发板' },
  { q: '索引的粒度', want: '索引的粒度直接决定' },
  { q: '加入购物车', want: '加入购物车', topK: 4, note: '交互标签命中' },
  { q: '耗时 成本 对比', want: '方案 耗时 成本' },
  { q: 'index.search 查询', want: 'const query' },
  { q: '最便宜的板子要多少钱', want: 'STM32', topK: 3, note: '模糊语义（预期偏弱，供是否上向量的决策依据）' }
];

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const est = (n) => '~' + Math.round(n / 3.6) + ' tok';   // 粗估: 1 token ≈ 3.6 字符(中英混排)
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

(async () => {
  const info = await client.get('/page-info').catch(() => null);
  console.log('\n=== 语义单元提取探测 ===');
  console.log('页面: ' + ((info && info.url) || '(未知)'));
  console.log('标题: ' + ((info && info.title) || ''));

  // ---- 注入提取器（只读执行） ----
  const opts = { maxTextLen: 1200 };
  const code = '(function(){\n' + SRC + '\nreturn ArkSemantic.extractSemanticUnits(document, ' + JSON.stringify(opts) + ');\n})()';
  const t0 = Date.now();
  const res = await client.evaluate(code, 60000);
  const rtt = Date.now() - t0;

  if (res && res.error) { console.log('\n提取失败: ' + res.error); process.exit(1); }
  const data = (res && res.result !== undefined) ? res.result : res;
  if (!data || !data.stats) { console.log('\n未拿到提取结果，返回原文: ' + JSON.stringify(res).slice(0, 300)); process.exit(1); }

  const s = data.stats;
  console.log('\n--- 提取统计 ---');
  console.log('页面内耗时: ' + s.elapsedMs + 'ms   端到端(含注入往返): ' + rtt + 'ms');
  console.log('候选组: ' + s.groups + '   接受单元: ' + s.accepted);
  console.log('类型分布: ' + JSON.stringify(s.typeCounts));

  const rej = Object.entries(s.rejected || {}).sort((a, b) => b[1] - a[1]);
  console.log('按原因拒绝的块数: ' + (rej.length ? rej.map(([k, v]) => k + '=' + v).join('  ') : '(无)'));

  if (data.noise && data.noise.length) {
    console.log('\n--- 被过滤的重复结构（Top 12，检查是否误伤） ---');
    data.noise.slice(0, 12).forEach((n) => {
      console.log('  [' + n.reason + '] ×' + String(n.count).padStart(4) + '  ' + n.signature);
    });
  }

  console.log('\n--- 单元样本（前 ' + MAX + ' 个） ---');
  data.units.slice(0, MAX).forEach((u) => {
    const it = u.interactives && u.interactives.length ? '  交互:' + u.interactives.length : '';
    console.log('  ' + u.id + ' [' + u.type + '] ' + u.charLen + '字' + it + ' | ' + cut(u.text.replace(/\n/g, ' '), 88));
  });

  // ---- 检索基准 ----
  if (has('--bench')) {
    const { buildIndex, search } = require('../semantic/indexer.js');
    const t1 = Date.now();
    const index = buildIndex(data.units);
    const buildMs = Date.now() - t1;
    console.log('\n--- 检索基准 ---');
    console.log('索引: ' + index.N + ' 单元 / 词表 ' + index.postings.size + ' 词 / 建索引 ' + buildMs + 'ms');
    let pass = 0;
    for (const c of BENCH_CASES) {
      const t2 = Date.now();
      const hits = search(index, c.q, { topK: c.topK || 3 });
      const ms = Date.now() - t2;
      const ok = hits.some((h) => h.unit.text.indexOf(c.want) >= 0);
      if (ok) pass++;
      console.log((ok ? '  OK  ' : ' FAIL ') + '"' + c.q + '" → ' + hits.length + ' 命中 / ' + ms + 'ms' + (c.note ? '   (' + c.note + ')' : ''));
      const top1 = hits[0];
      if (top1) {
        console.log('        #1 [分数' + top1.score + ' 覆盖' + top1.coverage + ' ' + top1.unit.type + '] ' + cut(top1.unit.text.replace(/\n/g, ' '), 68));
      } else {
        console.log('        (无命中)');
      }
    }
    console.log('检索通过: ' + pass + '/' + BENCH_CASES.length);
  }

  // ---- 数据量对照 ----
  const unitsJson = JSON.stringify(data.units).length;
  const textTotal = data.units.reduce((a, u) => a + u.charLen, 0);
  console.log('\n--- 数据量对照 ---');
  console.log('语义索引(全部 ' + data.units.length + ' 单元, JSON): ' + kb(unitsJson) + '  ' + est(unitsJson));
  console.log('其中纯文本总量: ' + kb(textTotal) + '  ' + est(textTotal));

  if (!NO_SNAP) {
    try {
      const snap = await client.snapshot({ annotate: false, maxElements: 120, format: 'webp', compact: true, fresh: true });
      const elsJson = JSON.stringify(snap.elements || []).length;
      const img = (snap.dataUrl || '').length;
      console.log('全量快照(现状, 视口内最多 ' + (snap.elements || []).length + ' 个元素): ' + kb(elsJson + img) + '  ' + est(elsJson + img) + '   (元素JSON ' + kb(elsJson) + ' + 图片 ' + kb(img) + ')');
      if (unitsJson + img > 0) {
        // 说明：快照只覆盖视口且仅元素锚点；语义索引覆盖整页内容。对比用于量级参考。
      }
    } catch (e) {
      console.log('快照对照失败: ' + e.message);
    }
  }

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1), 'utf8');
    console.log('\n完整结果已写入: ' + OUT);
  }
  console.log('');
})().catch((e) => { console.error('执行失败: ' + e.message); process.exit(1); });
