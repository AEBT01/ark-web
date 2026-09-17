'use strict';
/**
 * 用量账本与预算护栏
 *
 * 为什么需要它：模型是云端按量计费，而 agent 会在一个任务里连续调用几十轮。
 * 用户给自己开的口子是"成本不计"，产品不能把这句话当成默认值 —— 必须有可见的
 * 用量、可设的上限、以及超限时明确的熔断行为（而不是默默把账单刷上去）。
 *
 * 三个概念分清：
 *   · 账本（ledger）：每次模型调用的 token 用量流水，落盘 JSONL，用于按天汇总与排障。
 *   · 预算（limits）：上限配置，按"单个任务"和"自然日"两个维度分别管 token 与金额。
 *   · 熔断（check）：调用前判断"再跑一轮是否超限"，超限即停并给出可操作说明。
 *
 * 关于金额：单价不写死在代码里 —— 各家价格会变，写死必然过期。默认只按 token 管，
 * 用户在设置里填入单价后才计算与限制金额。宁可不算，也不报一个错的钱数。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.ark-web');
const LEDGER = path.join(DIR, 'usage.jsonl');
const LIMITS_FILE = path.join(DIR, 'limits.json');
const PROJECT_LIMITS = path.join(__dirname, '..', '..', 'config', 'limits.json');

/** 默认上限：不设金额上限（未填单价），token 上限给一个宽松但存在的安全网 */
const DEFAULTS = {
  taskMaxTokens: 400000,      // 单任务上限（约几十轮对话的量级）
  dailyMaxTokens: 2000000,    // 自然日上限
  taskMaxCost: null,          // 单任务金额上限（元）—— 需先填单价
  dailyMaxCost: null,         // 自然日金额上限（元）
  promptPricePerM: null,      // 输入单价（元 / 百万 token）
  completionPricePerM: null,  // 输出单价（元 / 百万 token）
  currency: 'CNY'
};

let _cache = null;
let _cacheAt = 0;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/** 合并后的生效配置（默认 → 项目 → 用户） */
function limits() {
  const now = Date.now();
  if (_cache && now - _cacheAt < 3000) return _cache;
  const out = Object.assign({}, DEFAULTS);
  for (const f of [PROJECT_LIMITS, LIMITS_FILE]) {
    const j = readJson(f);
    if (!j) continue;
    for (const k of Object.keys(DEFAULTS)) {
      if (j[k] !== undefined) out[k] = j[k];
    }
  }
  _cache = out;
  _cacheAt = now;
  return out;
}

function saveLimits(patch) {
  const cur = readJson(LIMITS_FILE) || {};
  const next = Object.assign({}, cur, patch || {});
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(LIMITS_FILE, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  _cache = null;
  return limits();
}

/** 单价是否已配置（未配置则只按 token 管，不显示金额） */
function priced(l) {
  const c = l || limits();
  return typeof c.promptPricePerM === 'number' && typeof c.completionPricePerM === 'number'
    && c.promptPricePerM >= 0 && c.completionPricePerM >= 0;
}

/** 按当前单价把用量折算成金额；未配单价返回 null（宁可不算，也不报错的钱） */
function costOf(usage, l) {
  const c = l || limits();
  if (!priced(c) || !usage) return null;
  const p = (usage.prompt_tokens || 0) / 1e6 * c.promptPricePerM;
  const q = (usage.completion_tokens || 0) / 1e6 * c.completionPricePerM;
  return +(p + q).toFixed(6);
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 记一笔用量（追加写；失败不影响任务） */
function record(entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const row = Object.assign({ ts: Date.now(), day: today() }, entry || {});
    if (row.cost == null) row.cost = costOf(row.usage);
    fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (e) { /* 账本写失败不能拖垮任务 */ }
  return entry;
}

/**
 * 汇总某一天的用量。只读文件尾部若干行 —— 账本会长期增长，但不该让汇总变慢。
 * @param {string} day 形如 2026-09-13，默认今天
 * @param {number} maxBytes 从尾部最多读多少字节（默认 512KB）
 */
function summaryOfDay(day, maxBytes) {
  const want = day || today();
  const cap = maxBytes || 512 * 1024;
  let text = '';
  try {
    const st = fs.statSync(LEDGER);
    const start = Math.max(0, st.size - cap);
    const fd = fs.openSync(LEDGER, 'r');
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);   // 丢掉被截断的首行
  } catch (e) { return { day: want, calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: priced() ? 0 : null, truncated: false }; }

  const out = { day: want, calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: priced() ? 0 : null, truncated: fs.existsSync(LEDGER) && fs.statSync(LEDGER).size > cap };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch (e) { continue; }
    if (row.day !== want) continue;
    out.calls++;
    const u = row.usage || {};
    out.prompt_tokens += u.prompt_tokens || 0;
    out.completion_tokens += u.completion_tokens || 0;
    out.total_tokens += u.total_tokens || 0;
    if (row.cost != null) out.cost = +((out.cost || 0) + row.cost).toFixed(6);
  }
  return out;
}

/** 最近 N 天的汇总（面板展示用） */
function recentDays(n) {
  const days = [];
  const d = new Date();
  for (let i = 0; i < (n || 7); i++) {
    const p = (x) => String(x).padStart(2, '0');
    days.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
    d.setDate(d.getDate() - 1);
  }
  return days.reverse().map((day) => summaryOfDay(day));
}

/**
 * 熔断判定：在"即将调用模型"之前问一句"还能不能跑"。
 * @param {{taskUsage?:object, projectedTokens?:number}} o
 * @returns {{ok:boolean, reason?:string, message?:string, scope?:string, used?:number, limit?:number}}
 */
function check(o) {
  const opt = o || {};
  const l = limits();
  const taskU = opt.taskUsage || {};
  const proj = opt.projectedTokens || 0;

  if (l.taskMaxTokens != null) {
    const used = (taskU.total_tokens || 0) + proj;
    if (used > l.taskMaxTokens) {
      return {
        ok: false, scope: 'task', used: used, limit: l.taskMaxTokens,
        reason: 'task-tokens',
        message: '本任务已用 ' + used + ' tokens，超过单任务上限 ' + l.taskMaxTokens
          + '。任务已停止以免继续产生费用；可在设置里调高上限，或把任务拆小后重试。'
      };
    }
  }
  if (l.taskMaxCost != null && priced(l)) {
    const c = (costOf(taskU, l) || 0) + (l.promptPricePerM || 0) / 1e6 * proj;
    if (c > l.taskMaxCost) {
      return {
        ok: false, scope: 'task', used: +c.toFixed(6), limit: l.taskMaxCost,
        reason: 'task-cost',
        message: '本任务费用已达 ' + c.toFixed(4) + ' 元，超过单任务上限 ' + l.taskMaxCost + ' 元。任务已停止。'
      };
    }
  }
  const day = summaryOfDay();
  // 注意：账本(summaryOfDay)里**已经包含本任务此前每一轮**的用量（loop 每轮 record 一次），
  // 所以这里不能再加 taskU —— 加了就是重复计，长任务会在日上限约一半处被误熔断（实测口径）。
  if (l.dailyMaxTokens != null) {
    const used = day.total_tokens + proj;
    if (used > l.dailyMaxTokens) {
      return {
        ok: false, scope: 'day', used: used, limit: l.dailyMaxTokens,
        reason: 'day-tokens',
        message: '今天已用 ' + used + ' tokens，超过每日上限 ' + l.dailyMaxTokens
          + '。今日不再接受新任务；可在设置里调高上限。'
      };
    }
  }
  if (l.dailyMaxCost != null && priced(l)) {
    const c = (day.cost || 0) + (l.promptPricePerM || 0) / 1e6 * proj;   // 同上：账本已含本任务
    if (c > l.dailyMaxCost) {
      return {
        ok: false, scope: 'day', used: +c.toFixed(6), limit: l.dailyMaxCost,
        reason: 'day-cost',
        message: '今天费用已达 ' + c.toFixed(4) + ' 元，超过每日上限 ' + l.dailyMaxCost + ' 元。今日不再接受新任务。'
      };
    }
  }
  return { ok: true };
}

/** 面板展示用：当前配置 + 今日用量 + 判定结论 */
function status() {
  const l = limits();
  const day = summaryOfDay();
  return {
    limits: l,
    priced: priced(l),
    today: day,
    week: recentDays(7),
    verdict: check({})
  };
}

module.exports = {
  DEFAULTS, LEDGER, LIMITS_FILE,
  limits, saveLimits, priced, costOf, record, summaryOfDay, recentDays, check, status
};
