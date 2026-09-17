#!/usr/bin/env node
/**
 * semantic-e2e.js — 语义层端到端验证（服务端链路）
 *
 * 流程：打开测试页 → /semantic/build → /semantic/query（已知答案对照）→ /semantic/run（动作链）
 * 用途：验证「检索 → 锚点定位 → 真实操作」完整链路；后续三类场景任务集在此基础上扩展。
 *
 * 设计说明：查询与断言写在源码里（UTF-8），不走命令行传参
 *           —— 命令行中文会被 GBK 损坏（AGENTS.md 记录的已知陷阱）。
 *
 * 用法: node scripts/semantic-e2e.js [--url <页面>] [--keep]
 */
const BrowserClient = require('../client/browser-client');

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };
const TARGET = val('--url') || 'http://127.0.0.1:8899/test-page.html';
const KEEP = args.includes('--keep');

const client = new BrowserClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

/** 检索用例（针对 test-page.html 的已知答案） */
const QUERIES = [
  { q: '太棒了', want: '这视频太棒了', topK: 3, note: '歧义：两条评论含此短语' },
  { q: '实验支撑', want: '缺少实验支撑', topK: 3 },
  { q: '开发板', want: 'ESP32-C3', topK: 3 },
  { q: '加入购物车', want: '加入购物车', topK: 4, note: '交互标签命中' },
  { q: '耗时 成本', want: '耗时', topK: 3 },
  { q: '语义索引', want: '语义索引', topK: 3 }
];

/** 动作链用例 */
const ACTIONS = [
  {
    name: '点击「回复」按钮（歧义场景的第 1 候选）',
    steps: [
      { op: 'find', query: '太棒了', topK: 2 },
      { op: 'click', unit: '$0', labelIncludes: '回复' }
    ],
    expect: (r) => r.ok && r.steps[1] && r.steps[1].ok && /回复/.test(r.steps[1].clicked || '')
  },
  {
    name: '读取商品单元文本',
    steps: [
      { op: 'find', query: 'STM32', topK: 1 },
      { op: 'read', unit: '$0' }
    ],
    expect: (r) => r.ok && r.steps[1] && /STM32/.test((r.steps[1].unit || {}).text || '')
  },
  {
    name: '高风险动作应被拦截（点击「提交订单」）',
    steps: [
      { op: 'find', query: '提交订单', topK: 1 },
      { op: 'click', unit: '$0', labelIncludes: '提交订单' }
    ],
    expect: (r) => r.steps.length === 2 && r.steps[1] && r.steps[1].needConfirm === true
  }
];

(async () => {
  console.log('\n=== 语义层端到端验证 ===');
  console.log('目标页面: ' + TARGET + '\n');

  // 1) 打开页面（加时间戳绕过浏览器缓存 —— 测试页改动需即时生效）
  const bustedUrl = TARGET + (TARGET.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
  const openRes = await client.post('/open', { url: bustedUrl });
  const tabId = (openRes.tab && openRes.tab.id) || openRes.tabId;
  if (!tabId) throw new Error('开页失败: ' + JSON.stringify(openRes).slice(0, 200));
  client.tabId = tabId;
  console.log('标签页: ' + tabId);
  await sleep(2500);

  // 2) 构建索引
  const build = await client.post('/semantic/build', {});
  console.log('\n--- 索引 ---');
  console.log('单元 ' + build.units + ' / 词表 ' + build.terms + ' / 提取 ' + build.extractMs + 'ms');
  console.log('级别: ' + JSON.stringify(build.levelCounts) + '  类型: ' + JSON.stringify(build.typeCounts));

  // 3) 检索用例
  console.log('\n--- 检索（' + QUERIES.length + ' 例）---');
  let qPass = 0;
  for (const c of QUERIES) {
    const r = await client.post('/semantic/query', { query: c.q, topK: c.topK });
    const hit = (r.hits || []).some((h) => (h.unit.text || '').indexOf(c.want) >= 0);
    if (hit) qPass++;
    console.log((hit ? '  OK  ' : ' FAIL ') + '"' + c.q + '" → ' + (r.total || 0) + ' 命中' + (c.note ? '   (' + c.note + ')' : ''));
    const top = (r.hits || [])[0];
    if (top) console.log('        #1 [分数' + top.score + '] ' + cut(top.unit.text.replace(/\n/g, ' '), 62));
  }
  console.log('检索通过: ' + qPass + '/' + QUERIES.length);

  // 4) 动作链用例
  console.log('\n--- 动作链（' + ACTIONS.length + ' 例）---');
  let aPass = 0;
  for (const c of ACTIONS) {
    const r = await client.post('/semantic/run', { steps: c.steps });
    const ok = c.expect(r);
    if (ok) aPass++;
    console.log((ok ? '  OK  ' : ' FAIL ') + c.name);
    (r.steps || []).forEach((s, i) => {
      const detail = s.ok
        ? (s.clicked ? 'clicked=' + cut(s.clicked, 30) : (s.unit ? 'read=' + cut((s.unit.text || '').replace(/\n/g, ' '), 40) : (s.total !== undefined ? 'hits=' + s.total : 'ok')))
        : ('error=' + (s.error || '') + (s.needConfirm ? ' needConfirm(risk=' + s.risk + ')' : ''));
      console.log('         step' + i + ' ' + s.op + ' → ' + detail);
    });
  }
  console.log('动作链通过: ' + aPass + '/' + ACTIONS.length);

  // 5) 高风险拦截专项：未确认应拦截、确认后应放行
  console.log('\n--- 高风险拦截专项 ---');
  const risky = await client.post('/semantic/run', {
    steps: [
      { op: 'find', query: '提交订单', topK: 1 },
      { op: 'click', unit: '$0', labelIncludes: '提交订单' }
    ]
  });
  const s1 = (risky.steps || [])[1] || {};
  const blocked = s1.needConfirm === true && s1.risk === 'high';
  console.log('  ' + (blocked ? 'OK   ' : ' FAIL') + '未确认 → 拦截: ' + JSON.stringify({ ok: s1.ok, needConfirm: s1.needConfirm, risk: s1.risk, plan: s1.plan }).slice(0, 190));

  const confirmed = await client.post('/semantic/run', {
    steps: [
      { op: 'find', query: '提交订单', topK: 1 },
      { op: 'click', unit: '$0', labelIncludes: '提交订单', confirmed: true }
    ]
  });
  const s2 = (confirmed.steps || [])[1] || {};
  console.log('  ' + (s2.ok ? 'OK   ' : ' FAIL') + '已确认 → 放行: ' + JSON.stringify({ ok: s2.ok, clicked: s2.clicked, risk: s2.risk }).slice(0, 170));

  // 6) 调试视图
  const dump = await client.get('/semantic/dump?limit=3');
  console.log('\n--- 「AI 眼中的页面」抽样（前 3 个单元）---');
  (dump.units || []).forEach((u) => console.log('  ' + u.id + ' [' + u.type + '] ' + u.charLen + '字 | ' + cut(u.text, 60)));

  if (!KEEP) {
    await client.post('/tab/close', { tabId: tabId }).catch(() => null);
  }
  console.log('\n完成。');
  console.log('');
})().catch((e) => { console.error('执行失败: ' + e.message); process.exit(1); });
