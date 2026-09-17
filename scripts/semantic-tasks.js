#!/usr/bin/env node
/**
 * semantic-tasks.js — 三类场景任务集（大脑接口模拟验证 + 执行）
 *
 * 背景：真实云端大脑（DeepSeek）尚未接入。本脚本把"大脑"这一环留给外部扮演
 *      （人 / 子代理 / 将来的模型 API），用于在接入前打磨两个接口契约：
 *        · 「大脑输入包」= 任务目标 + 页面摘要 + 可用动作契约
 *        · 「大脑输出」  = 操作链 JSON（直接喂给 /semantic/run 执行）
 *
 * 模式：
 *   --prepare   打开测试页 → 建索引 → 为每个任务生成输入包 → 写 _brain-inbox.json
 *   --execute   读 _brain-outbox.json（大脑输出）→ 逐任务执行 → 写 _brain-result.json 并打印汇总
 *
 * 用法：
 *   node scripts/semantic-tasks.js --prepare
 *   node scripts/semantic-tasks.js --execute
 */
const fs = require('fs');
const path = require('path');
const BrowserClient = require('../client/browser-client');

const args = process.argv.slice(2);
const MODE = args.includes('--execute') ? 'execute' : 'prepare';
const TARGET = (args.indexOf('--url') > -1 ? args[args.indexOf('--url') + 1] : null) || 'http://127.0.0.1:8899/test-page.html';
const DIR = path.join(__dirname, '..', 'semantic');
const INBOX = path.join(DIR, '_brain-inbox.json');
const OUTBOX = path.join(DIR, '_brain-outbox.json');
const RESULT = path.join(DIR, '_brain-result.json');

const client = new BrowserClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 三类场景任务集（针对 test-page.html 的已知内容） */
const TASKS = [
  // —— 操作类：改变页面状态 ——
  { id: 'op-1', kind: '操作', goal: '回复说“太棒了”的那个人，内容是“谢谢”' },
  { id: 'op-2', kind: '操作', goal: '把“STM32 最小系统板”加入购物车' },
  { id: 'op-3', kind: '操作', goal: '给李四的评论点赞' },
  // —— 理解类：只读，产出信息 ——
  { id: 'und-1', kind: '理解', goal: '这篇文章主要讲了什么？用一句话总结' },
  { id: 'und-2', kind: '理解', goal: '四个商品里最便宜的是哪一个？多少钱？' },
  // —— 自动化类：多步/汇总 ——
  { id: 'auto-1', kind: '自动化', goal: '把四个商品的名字和价格整理成清单' },
  { id: 'auto-2', kind: '自动化', goal: '评论里有哪些人对文章观点提出了不同意见？分别是谁？' }
];

/** 可用动作契约（提供给大脑的动作清单） */
const ACTIONS = [
  { op: 'find', args: { query: '关键词', topK: '可选，默认 3' }, desc: '按内容检索页面单元，返回候选列表（按相关度排序）' },
  { op: 'read', args: { unit: '引用' }, desc: '读取指定单元全文' },
  { op: 'click', args: { unit: '引用', labelIncludes: '按钮文本片段(可选)', index: '可选：单元内第几个匹配控件(0 基，默认 0)' }, desc: '点击单元内按钮/链接（高风险动作会被拦截并要求确认）' },
  { op: 'fill', args: { unit: '引用(可省略=全页查找)', labelIncludes: '输入框标签片段(可选)', text: '要填入的文本' }, desc: '向输入框填值（不触发提交）' }
];

/** 引用语法（必须随输入包一起给大脑 —— 模拟验证中因未明示，大脑误解了 $N 的含义导致读取全部回落） */
const REF_SYNTAX = '引用写法：$N = 第 N 步结果的第 1 个候选；$N.M = 第 N 步结果的第 M 个候选（M 从 0 开始）。'
  + '例：第一步 {"op":"find","query":"太棒了"} 返回 3 个候选，则 "$0" 是第 1 个候选、"$0.1" 是第 2 个候选、"$0.2" 是第 3 个候选。'
  + '注意：$1 表示"第 1 步的结果"（即该 find 的第 1 个候选），不是"候选 1"；读取多个候选请写 $0、$0.1、$0.2。'
  + '理解类/自动化类任务通常需要读多个候选，请显式使用 $0.M 形式。';

async function prepare() {
  const bustedUrl = TARGET + (TARGET.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
  const openRes = await client.post('/open', { url: bustedUrl });
  const tabId = (openRes.tab && openRes.tab.id) || openRes.tabId;
  if (!tabId) throw new Error('开页失败: ' + JSON.stringify(openRes).slice(0, 200));
  client.tabId = tabId;
  await sleep(2500);

  const build = await client.post('/semantic/build', {});
  // 页面摘要：全部内容级单元（上限 40，附带 id/类型/摘要/交互元素标签）
  const dump = await client.get('/semantic/dump?level=content&limit=40');
  const units = (dump.units || []).map((u) => ({
    id: u.id,
    type: u.type,
    len: u.charLen,
    text: (u.text || '').slice(0, 140)
  }));

  const inbox = {
    page: { url: build.url, title: build.title, units: build.units, types: build.typeCounts },
    actions: ACTIONS,
    refSyntax: REF_SYNTAX,
    tasks: TASKS.map((t) => ({ id: t.id, kind: t.kind, goal: t.goal })),
    pageUnits: units,
    tabId: tabId
  };
  fs.writeFileSync(INBOX, JSON.stringify(inbox, null, 1), 'utf8');
  console.log('索引: ' + build.units + ' 单元 / ' + build.terms + ' 词 / ' + build.extractMs + 'ms');
  console.log('输入包已写入: ' + INBOX);
  console.log('（下一步：由"大脑"读输入包，为每个任务产出操作链，写入 _brain-outbox.json）');
}

async function execute() {
  if (!fs.existsSync(OUTBOX)) throw new Error('未找到大脑输出文件: ' + OUTBOX);
  const outbox = JSON.parse(fs.readFileSync(OUTBOX, 'utf8'));
  const inbox = fs.existsSync(INBOX) ? JSON.parse(fs.readFileSync(INBOX, 'utf8')) : null;
  const tabId = (inbox && inbox.tabId) || null;
  if (tabId) client.tabId = tabId;

  const results = [];
  for (const item of outbox.tasks || outbox) {
    const task = TASKS.find((t) => t.id === item.id) || { id: item.id, kind: '?', goal: item.goal };
    const steps = item.steps || [];
    let run;
    if (!steps.length) {
      run = { ok: false, completed: 0, total: 0, steps: [], error: '大脑未产出步骤' };
    } else {
      run = await client.post('/semantic/run', { steps: steps });
    }
    results.push({ id: task.id, kind: task.kind, goal: task.goal, steps: steps, result: run, answer: item.answer || null });
  }

  fs.writeFileSync(RESULT, JSON.stringify(results, null, 1), 'utf8');
  // —— 控制台汇总 ——
  // 通过判定：完整跑完 = 通过；因高风险动作被拦截而停止 = 符合预期（安全机制生效），单独标注
  const verdict = (res) => {
    if (!res) return 'fail';
    if (res.ok) return 'pass';
    const stopStep = res.stoppedAt != null ? res.steps[res.stoppedAt] : null;
    if (stopStep && stopStep.needConfirm) return 'guarded';
    return 'fail';
  };
  console.log('\n=== 任务执行汇总 ===');
  for (const r of results) {
    const v = verdict(r.result);
    const mark = v === 'pass' ? 'OK    ' : (v === 'guarded' ? 'OK*   ' : ' FAIL ');
    console.log(mark + ' [' + r.kind + '] ' + r.goal + (v === 'guarded' ? '   （末步为高风险动作，已按预期拦截）' : ''));
    (r.result.steps || []).forEach((s, i) => {
      const d = s.ok
        ? (s.clicked ? 'clicked=' + s.clicked : (s.filled ? 'filled=' + s.filled : (s.unit ? 'read=' + (s.unit.text || '').slice(0, 40) : ('hits=' + (s.total !== undefined ? s.total : '')))))
        : ('error=' + (s.error || '') + (s.needConfirm ? ' [需确认: ' + (s.plan && s.plan.target) + ']' : ''));
      console.log('        step' + i + ' ' + s.op + ' → ' + d);
    });
    if (r.answer) console.log('        答案: ' + String(r.answer).slice(0, 120));
  }
  const pass = results.filter((r) => verdict(r.result) !== 'fail').length;
  const guarded = results.filter((r) => verdict(r.result) === 'guarded').length;
  console.log('\n通过: ' + pass + '/' + results.length + (guarded ? '（其中 ' + guarded + ' 个末步按安全策略拦截，符合预期）' : '') + '   结果已写入: ' + RESULT);
}

(async () => {
  console.log('\n=== 语义任务集（' + MODE + '）===');
  if (MODE === 'prepare') await prepare();
  else await execute();
  console.log('');
})().catch((e) => { console.error('执行失败: ' + e.message); process.exit(1); });
