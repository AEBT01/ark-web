/**
 * Agent 主循环 —— 照搬 DeepSeek Harness 的 ReactLoopAgent 骨架
 * （源码：packages/core/agent-loop/src/agent.ts、tool-calls.ts、llm/llm-retry）
 *
 * 与旧版 brain.agent 的区别：
 *   · **流式**：模型输出逐 delta 到达并广播（onEvent token/thought），面板打字机式可见
 *   · **重试**：指数退避 + 抖动 + 尊重 Retry-After；context overflow 时强制压缩后再试
 *   · **技能目录**：system 之后注入 <available_skills> 摘要目录，digest 不变不重发
 *   · **运行时上下文**：工作页/隐私/审批走独立 user 快照（内容不变不重发，保住缓存前缀）
 *   · **上下文管理**：每轮做压力检查，超阈值触发结构化检查点压缩（compaction.js 四层）
 *   · **并行工具**：声明了 isConcurrencySafe 的只读工具可并行执行，其余保持串行屏障
 *   · **终止**：无 tool_calls / finish / give_up / 取消 / 安全上限（不再用 24 这种紧上限，
 *     DSH 靠自然终止 + 压缩，我们保留一个高安全网）
 */
const prompt = require('./prompt');
const skills = require('./skills');
const rtctx = require('./runtime-context');
const compaction = require('./compaction');
const limits = require('../core/limits');

const SAFETY_MAX_TURNS = +(process.env.ARK_AGENT_MAX_TURNS || 80);
const WINDOW_TOKENS = +(process.env.ARK_CONTEXT_TOKENS || 65536);
const TOOL_MSG_CAP = 8000;   // 工具消息的最终护栏（裁剪/落盘之后）

function cut(s, n) { return String(s == null ? '' : s).slice(0, n); }

/** 稳定 stringify（键排序）—— 重复调用检测用，参数顺序不同视为同一调用 */
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
  }
  return JSON.stringify(v);
}

function isAbortError(e) {
  return e && (e.name === 'AbortError' || e.name === 'TimeoutError' ||
    /aborted|abort/i.test(String(e && e.message)));
}

/** 可取消的延迟 */
function delay(ms, ctx) {
  return new Promise(function (resolve) {
    const t = setTimeout(resolve, ms);
    if (ctx && typeof ctx.isCancelled === 'function') {
      const iv = setInterval(function () {
        if (ctx.isCancelled()) { clearTimeout(t); clearInterval(iv); resolve(); }
      }, 200);
      setTimeout(function () { clearInterval(iv); }, ms + 50);
    }
  });
}

/**
 * 带重试的模型请求（照搬 llm-retry：指数退避 + 抖动 + Retry-After，可审计、可取消）。
 * context overflow 不属于"重试"：由调用方强制压缩后再来。
 */
async function requestWithRetry(fn, o) {
  const maxRetries = o.maxRetries != null ? o.maxRetries : 3;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      const status = e && e.status;
      const msg = String((e && e.message) || e);
      const overflow = /context length|maximum context|too long|context_length/i.test(msg);
      if (overflow) { e.contextOverflow = true; throw e; }
      const retryable = !isAbortError(e) && (
        e.name === 'TypeError' || /fetch failed|network|ECONN|socket|timed? ?out/i.test(msg) ||
        status === 408 || status === 429 || status >= 500
      );
      if (!retryable || attempt > maxRetries) throw e;
      const backoff = Math.min(800 * Math.pow(2, attempt - 1) + Math.random() * 250, 8000);
      const waitMs = e.retryAfter ? Math.max(e.retryAfter * 1000, backoff) : backoff;
      if (o.onEvent) o.onEvent({ type: 'retry', attempt: attempt, delayMs: Math.round(waitMs), error: cut(msg, 140) });
      await delay(waitMs, o.ctx);
    }
  }
}

/**
 * @param {string} goal 用户意图
 * @param {object} opts {
 *   registry, ctx, model: {chat, chatStream}, runtime: {workPage, privacy, approval},
 *   maxTurns, onTurn, onEvent, toolFilter, systemVars
 * }
 */
async function runAgent(goal, opts) {
  const o = opts || {};
  const registry = o.registry;
  const model = o.model;
  if (!registry || typeof registry.execute !== 'function') throw new Error('runAgent 需要 registry');
  if (!model || typeof model.chatStream !== 'function') throw new Error('runAgent 需要 model.chatStream');
  const ctx = o.ctx || {};
  const onTurn = o.onTurn || function () { };
  const onEvent = o.onEvent || function () { };
  const maxTurns = Math.min(o.maxTurns || SAFETY_MAX_TURNS, SAFETY_MAX_TURNS);
  const tools = registry.schemas(o.toolFilter);

  const trace = [];
  const usageAcc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let answer = null, summary = null;
  let catalogDigest = null;
  let lastPromptTokens = 0;   // 上一轮的输入规模：预算护栏用它估计下一轮的下限

  function addUsage(u) {
    if (!u) return;
    usageAcc.prompt_tokens += u.prompt_tokens || 0;
    usageAcc.completion_tokens += u.completion_tokens || 0;
    usageAcc.total_tokens += u.total_tokens || 0;
  }

  /** 压缩结果落地：换进新消息、补回被压掉的技能目录、把摘要调用的用量入账。
   *
   *  为什么要在压缩后再补目录：目录/记忆是历史里的 user 消息，会被压进检查点，
   *  而"digest 不变就不重发"的判定让它们从此再不出现 —— 技能目录永久失联。 */
  function applyCompaction(c) {
    messages.length = 0; Array.prototype.push.apply(messages, c.messages);
    if (catalogEntriesCache && catalogEntriesCache.length && !messages.some(function (m) { return m._catalog; })) {
      messages.push({ role: 'user', content: skills.renderCatalog(catalogEntriesCache), _catalog: true });
    }
    if (c.usage) {
      addUsage(c.usage);
      limits.record({ taskId: ctx.taskId || null, turn: turn, model: 'deepseek-flash', usage: c.usage, kind: 'compact' });
    }
  }

  /* ── 初始消息：system（分段渲染） + 记忆 + 技能目录 + 任务 ── */
  // system 文本在任务内固定：压缩/摘要都用它，不要在循环里重读 messages[0]
  //（压缩后 messages[0] 可能已不是 system，重读会拿检查点当 system 去摘要，形成"摘要的摘要"）
  const systemText = prompt.renderPrompt(Object.assign({ model: 'deepseek-flash' }, o.systemVars || {}));
  const messages = [{ role: 'system', content: systemText }];
  let catalogEntriesCache = null;

  // 记忆（AGENTS.md 家族）：用户的长期偏好与约定，字节预算内注入；内容变化由 digest 判定
  let memoryDigest = null;
  try {
    const mem = require('./memory').load();
    if (mem.text) {
      memoryDigest = mem.digest;
      messages.push({ role: 'user', content: mem.text, _memory: true });
    }
  } catch (e) { /* 记忆读取失败不阻塞任务 */ }

  // 技能目录（只含摘要；正文按需用 skill 工具加载）
  const skillList = skills.discover().filter(function (s) { return s.body; });
  if (skillList.length) {
    const entries = skills.catalogEntries(skillList);
    catalogEntriesCache = entries;
    catalogDigest = skills.catalogDigest(entries);
    messages.push({ role: 'user', content: skills.renderCatalog(entries), _catalog: true });
  }

  messages.push({
    role: 'user',
    content: '【用户请求】\n' + goal + '\n\n请开始。任务完成时调用 finish。'
  });

  // 运行时上下文快照（独立 user 消息；内容不变不重发）
  const rt = rtctx.merge(messages, rtctx.render(Object.assign({
    approval: { confirmHigh: !!ctx.confirmHigh }
  }, o.runtime || {})));
  if (rt.changed) { messages.length = 0; Array.prototype.push.apply(messages, rt.messages); }

  const repeatSeen = {};

  /* ── 主循环 ── */
  for (let turn = 0; turn < maxTurns; turn++) {
    // 任务级取消：每轮进入前检查
    if (ctx.isCancelled && ctx.isCancelled()) {
      return { ok: false, answer: '（任务已取消）', turns: turn, trace: trace, usage: usageAcc, cancelled: true };
    }

    // 运行时上下文刷新（工作页可能变化）
    const rtNow = rtctx.merge(messages, rtctx.render(Object.assign({
      approval: { confirmHigh: !!ctx.confirmHigh }
    }, typeof o.runtime === 'function' ? o.runtime() : (o.runtime || {}))));
    if (rtNow.changed) { messages.length = 0; Array.prototype.push.apply(messages, rtNow.messages); }

    // 技能目录刷新（技能集合变化才重发）
    const list = skills.discover().filter(function (s) { return s.body; });
    if (list.length) {
      const entries = skills.catalogEntries(list);
      const dig = skills.catalogDigest(entries);
      if (dig !== catalogDigest) {
        const ci = messages.findIndex(function (m) { return m._catalog; });
        const text = (catalogDigest == null) ? skills.renderCatalog(entries) : skills.renderCatalogUpdate(entries);
        const msg = { role: 'user', content: text, _catalog: true };
        if (ci >= 0) messages[ci] = msg; else messages.splice(1, 0, msg);
        catalogDigest = dig;
        onEvent({ type: 'catalog', changed: true, count: entries.length });
      }
    } else if (catalogDigest != null) {
      const ci = messages.findIndex(function (m) { return m._catalog; });
      if (ci >= 0) messages.splice(ci, 1);
      catalogDigest = null;
      onEvent({ type: 'catalog', changed: true, count: 0 });
    }

    // 上下文压力检查（层三：结构化压缩）
    let compacted = false;

    // ── 预算护栏：在花钱之前先问一句"还能不能跑" ──
    // 这一层必须在模型调用之前，否则"超限"只能事后发现 —— 账单已经产生了。
    {
      const v = limits.check({
        taskUsage: usageAcc,
        projectedTokens: lastPromptTokens || 0   // 上一轮的输入规模即下一轮的下界估计
      });
      if (!v.ok) {
        trace.push({ turn: turn, kind: 'budget', text: v.message });
        onEvent({ type: 'budget:stop', scope: v.scope, used: v.used, limit: v.limit, message: v.message });
        return {
          ok: false, answer: v.message, turns: turn, trace: trace, usage: usageAcc,
          budgetStopped: true, model: 'deepseek-flash'
        };
      }
    }

    try {
      const c = await compaction.compact({
        messages: messages, system: systemText, tools: tools,
        chat: model.chat, windowTokens: WINDOW_TOKENS,
        onEvent: onEvent
      });
      if (c.compacted) {
        applyCompaction(c);
        compacted = true;
        onTurn({ turn: turn, kind: 'compact', text: '已压缩早期上下文' });
      }
    } catch (e) { onEvent({ type: 'compact:failed', error: cut(e.message, 120) }); }

    // ── 模型请求（流式 + 重试）──
    let r = null;
    let forceCompactTried = false;
    for (;;) {
      try {
        r = await requestWithRetry(function () {
          return model.chatStream(messages, {
            tools: tools,
            onText: function (delta, full) { onEvent({ type: 'token', delta: delta, turn: turn }); },
            // finish.answer 的增量（完整已到达文本，面板替换渲染即可）
            onAnswerDelta: function (full) { onEvent({ type: 'answer-delta', text: full, turn: turn }); },
            onThought: function (delta) { onEvent({ type: 'thought', delta: delta, turn: turn }); },
            signal: ctx.signal, timeout: o.requestTimeout
          });
        }, { onEvent: onEvent, ctx: ctx });
        break;
      } catch (e) {
        // 层四：provider 明确报超窗 → 绕过阈值强制压缩一次，再试
        if (e.contextOverflow && !forceCompactTried) {
          forceCompactTried = true;
          onEvent({ type: 'compact:forced', turn: turn });
          const c = await compaction.compact({
            messages: messages, system: systemText, tools: tools,
            chat: model.chat, windowTokens: WINDOW_TOKENS, force: true, onEvent: onEvent
          });
          if (c.compacted) { applyCompaction(c); continue; }
        }
        trace.push({ turn: turn, error: String(e.message || e), fatal: true });
        return { ok: false, answer: '大脑调用失败：' + String(e.message || e), turns: turn, trace: trace, usage: usageAcc };
      }
    }
    addUsage(r.usage);
    lastPromptTokens = (r.usage && r.usage.prompt_tokens) || lastPromptTokens;
    // 账本：每一轮都记，任务中途崩了也能查出钱花在哪
    limits.record({
      taskId: ctx.taskId || null,
      turn: turn,
      model: 'deepseek-flash',
      usage: r.usage,
      workPage: (o.runtime && o.runtime.workPage && o.runtime.workPage.url) || null
    });

    // 模型没调用工具 → 视为完成（harness 的终止条件）
    const toolCalls = (r.toolCalls || []).map(function (c) {
      const args = c._parsed != null ? c._parsed : (function () { try { return JSON.parse(c.function.arguments || '{}'); } catch (e) { return {}; } })();
      return { id: c.id, name: c.function.name, args: args, rawArgs: c.function.arguments || '{}' };
    });
    if (!toolCalls.length) {
      answer = String(r.content || '').trim() || '（没有更多要做的了）';
      trace.push({ turn: turn, kind: 'done', text: cut(answer, 300) });
      onTurn({ turn: turn, kind: 'done', text: cut(answer, 300) });
      return { ok: true, answer: answer, turns: turn + 1, trace: trace, usage: usageAcc, model: 'deepseek-flash' };
    }

    // 助手消息（含 tool_calls）先入历史，否则后续 tool 消息无处挂载
    messages.push({
      role: 'assistant',
      content: r.content || null,
      tool_calls: toolCalls.map(function (c) {
        return { id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs } };
      })
    });

    const thought = String(r.content || '').trim();

    /** 执行并落一条工具调用（finish/give_up 在此直接返回） */
    const runOne = async function (c) {
      const info = { turn: turn, tool: c.name, args: c.args, kind: 'tool', thought: thought && trace.every(function (x) { return x.tool !== c.name; }) ? thought : '' };
      trace.push(info);

      if (c.name === 'finish') {
        answer = String(c.args.answer || '').trim();
        summary = String(c.args.summary || '');
        info.kind = 'finish'; info.result = { ok: true };
        onTurn(info);
        return 'finish';
      }
      if (c.name === 'give_up') {
        answer = '无法完成：' + String(c.args.reason || '') + (c.args.tried ? '（已尝试：' + c.args.tried + '）' : '');
        info.kind = 'give_up'; info.result = { ok: true };
        onTurn(info);
        return 'give_up';
      }

      // 重复调用提醒（3/5/8，只提醒不否决 —— 照搬 guard/repeat-tool-reminder）
      const sig = c.name + '|' + stableStringify(c.args);
      repeatSeen[sig] = (repeatSeen[sig] || 0) + 1;
      const n = repeatSeen[sig];
      const remind = (n === 3 || n === 5 || n === 8)
        ? '（提醒：这是第 ' + n + ' 次完全相同的调用，结果不太可能变化。请换方法，或调用 finish/give_up 收尾。）'
        : '';

      let result = await registry.execute(c.name, c.args, ctx);

      // 子代理的用量算在父任务头上：账本要能反映"这次任务一共花了多少"，
      // 否则任务级护栏看不见子任务消耗。字段摘掉后再进上下文，避免重复计入。
      if (result && result.usage) {
        addUsage(result.usage);
        limits.record({ taskId: ctx.taskId || null, turn: turn, model: 'deepseek-flash', usage: result.usage, kind: 'delegate' });
        delete result.usage;
      }

      // 高风险请示（照搬：门禁命中 → 停下来问人）
      if (result && (result.needConfirm || result.need_confirm) && typeof ctx.onNeedConfirm === 'function') {
        let approved = false;
        try {
          approved = await ctx.onNeedConfirm({
            tool: c.name, args: c.args,
            // plan 里带着目标身份（selector / 坐标 / targetId），确认签名要用它 —— 只传文本
            // 会让"同一段文字的另一个按钮"复用授权
            plan: result.plan || null,
            target: cut((result.plan && result.plan.target) || result.text || result.target || '', 80),
            reason: result.risk === 'high' ? '该操作属于高风险动作（支付/删除/发布一类）' : '该操作需要确认',
            step: turn
          });
        } catch (e) { approved = false; }
        info.needConfirm = true;
        info.confirmed = !!approved;
        if (approved) {
          const prev = ctx.confirmHigh;
          ctx.confirmHigh = true;
          try { result = await registry.execute(c.name, c.args, ctx); }
          finally { ctx.confirmHigh = prev; }
        } else {
          result = Object.assign({}, result, { error: '用户未批准该高风险动作，已跳过', declined: true });
        }
      } else if (result && (result.needConfirm || result.need_confirm)) {
        result = Object.assign({}, result, {
          guidance: '该动作被安全策略拦截，必须由用户确认后才能执行。不要重复调用，也不要改用 evaluate / ark_api / cdp_* 等方式绕过；请立即调用 finish，说明"已完成前置步骤，等待用户确认后再执行该动作"。'
        });
      }

      info.result = result;
      onTurn(info);

      // 工具消息：先确定性裁剪，超长落盘（可寻址截断），最终护栏截断
      const raw = JSON.stringify(result);
      let text;
      if (Buffer.byteLength(raw, 'utf8') > compaction.SPILL_THRESHOLD_BYTES) {
        const sp = compaction.spill(raw, c.name);
        text = sp.text;
        if (sp.spilled) onEvent({ type: 'spill', tool: c.name, locator: sp.locator, bytes: sp.bytes, turn: turn });
      } else {
        text = compaction.pruneText(raw).text;
      }
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: cut(text, TOOL_MSG_CAP) + (remind ? '\n' + remind : '')
      });
      return null;
    };

    // 并行分组：连续的 isConcurrencySafe 调用可并行，其余串行（DSH 的 exclusive 屏障语义）
    let i = 0;
    let control = null;
    while (i < toolCalls.length && !control) {
      const c = toolCalls[i];
      if (c.name === 'finish' || c.name === 'give_up') { control = await runOne(c); i++; continue; }
      if (registry.isConcurrencySafe && registry.isConcurrencySafe(c.name)) {
        const group = [];
        while (i < toolCalls.length && toolCalls[i].name !== 'finish' && toolCalls[i].name !== 'give_up'
          && registry.isConcurrencySafe(toolCalls[i].name)) {
          group.push(toolCalls[i]); i++;
        }
        if (group.length > 1) onEvent({ type: 'tools:parallel', count: group.length, turn: turn });
        await Promise.all(group.map(runOne));
      } else {
        control = await runOne(c); i++;
      }
    }
    if (control === 'finish') return { ok: true, answer: answer, summary: summary, turns: turn + 1, trace: trace, usage: usageAcc, model: 'deepseek-flash' };
    if (control === 'give_up') return { ok: false, answer: answer, turns: turn + 1, trace: trace, usage: usageAcc, model: 'deepseek-flash' };
  }

  return {
    ok: false, answer: '任务在 ' + maxTurns + ' 步内没有完成，我停下来了。你可以把任务拆得更小，或者换个说法。',
    turns: maxTurns, trace: trace, usage: usageAcc, exhausted: true, model: 'deepseek-flash'
  };
}

module.exports = { runAgent: runAgent, stableStringify: stableStringify, requestWithRetry: requestWithRetry };
