/**
 * Ark Task Runner — Agent 任务运行时
 *
 * 设计转变（主体性反转）：
 *   旧形态：浏览器是主体，AI 是它的侧边栏助手 —— 一问一答、绑定当前标签页、用完即走
 *   新形态：**Agent 是主体，浏览器是它的能力之一** ——
 *     · 任务（task）：一个目标驱动的持续运行实例，有自己的视野、上下文与产物
 *     · 后台执行：任务在后台推进，用户可以继续浏览，界面通过事件流实时观看
 *     · 生命周期：queued → running →（waiting / done / failed / cancelled）
 *     · 并行：多任务同时推进，各自独立（互不干扰），并发受控
 *     · 可观测：每一步（思考/工具/结果）都记录并可回放，失败可诊断
 *
 * 与 brain.agent 的关系：本模块负责"调度与生命周期"，brain.agent 负责"单任务内的推理循环"。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const EVENTS_KEEP = 400;   // 每任务保留的事件上限（供回放）
/** 任务终态：唯一真源（见 isFinal） */
const FINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const CONFIRM_TIMEOUT = 5 * 60 * 1000;   // 高风险动作等待用户决定的时长；超时按"不批准"处理
const privacy = require('./agent/privacy');   // 敏感站点判定：命中则不建索引、不送云端

/** 短命事件：只推给实时订阅者，不进回放缓冲。
 *  否则一条任务的思考流（几百个 delta）会把队列里真正重要的
 *  needConfirm / confirmed / end 事件挤出环形缓冲（实测发生过）。 */
const EPHEMERAL_EVENTS = new Set(['task:token', 'task:thought', 'task:answer-delta']);

let SEQ = 0;
function nextId() {
  SEQ += 1;
  return 't' + Date.now().toString(36) + '-' + SEQ;
}
function cut(s, n) { return String(s == null ? '' : s).slice(0, n); }

const TASKS_KEEP = 60;   // 落盘保留的任务数（超出淘汰最旧的已结束任务）

class TaskRunner {
  constructor(server, opts) {
    const o = opts || {};
    this.server = server;
    this.tasks = new Map();
    this.maxConcurrent = o.maxConcurrent || 2;
    this.running = 0;
    this.queue = [];
    // 持久化：任务与事件落盘，进程重启后恢复历史（进行中的任务标记为 interrupted）
    this.storeFile = path.join(os.homedir(), '.ark-web', 'store', 'tasks.json');
    this._saveTimer = null;
    this._restore();
  }

  /** 从磁盘恢复任务历史 */
  _restore() {
    try {
      const raw = fs.readFileSync(this.storeFile, 'utf8');
      const j = JSON.parse(raw);
      const list = Array.isArray(j.tasks) ? j.tasks : [];
      let restored = 0, interrupted = 0;
      for (const t of list) {
        const wasLive = ['queued', 'running', 'waiting', 'cancelling'].includes(t.status);
        const task = Object.assign({}, t, {
          status: wasLive ? 'interrupted' : t.status,
          // 恢复的是历史快照：恢复后不可再取消/订阅，只供查看
          events: Array.isArray(t.events) ? t.events : [],
          trace: Array.isArray(t.trace) ? t.trace : [],
          approvedSigs: new Set(),
          subscribers: undefined
        });
        if (wasLive) interrupted += 1;
        this.tasks.set(task.id, task);
        restored += 1;
      }
      if (restored) console.log('[ArkWeb] 已恢复 ' + restored + ' 个历史任务（其中中断 ' + interrupted + ' 个）');
      // 重置内存序号，避免与恢复的 id 冲突
      for (const t of this.tasks.values()) {
        const m = /^t([0-9a-z]+)-(\d+)$/.exec(t.id);
        if (m) { const seq = parseInt(m[2], 10); if (seq > SEQ) SEQ = seq; }
      }
    } catch (e) { /* 首次启动没有存档，属正常 */ }
  }

  /** 落盘（防抖 600ms；只存需要留痕的字段） */
  _persist() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const dir = path.dirname(this.storeFile);
        fs.mkdirSync(dir, { recursive: true });
        const all = Array.from(this.tasks.values())
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, TASKS_KEEP);
        const tasks = all.map((t) => ({
          id: t.id, goal: t.goal, status: t.status,
          createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
          tabId: t.tabId, targetId: t.targetId,
          turns: t.trace ? t.trace.length : 0,
          answer: t.answer, summary: t.summary, error: t.error, usage: t.usage,
          events: (t.events || []).slice(-100),
          trace: (t.trace || []).slice(-60)
        }));
        const tmp = this.storeFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), tasks: tasks }, null, 0), 'utf8');
        fs.renameSync(tmp, this.storeFile);
      } catch (e) { /* 落盘失败不影响运行 */ }
    }, 600);
  }

  /** 建任务并入队 */
  create(goal, opts) {
    const o = opts || {};
    const task = {
      id: nextId(),
      goal: String(goal || '').trim(),
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      tabId: o.tabId != null ? o.tabId : null,   // 任务自己的视野（null = 提交时的活动页）
      targetId: o.targetId || null,              // CDP 目标（精确锁定页面，不依赖扩展通道）
      maxTurns: o.maxTurns || 24,
      confirmHigh: !!o.confirmHigh,
      trace: [],
      events: [],
      seq: 0,                    // 事件单调序号（续传游标，见 _emit）
      approvedSigs: new Set(),   // 本任务内已获批的高风险动作签名（避免同一动作被反复追问）
      answer: null,
      summary: null,
      usage: null,
      error: null,
      cancelled: false
    };
    if (!task.goal) throw new Error('任务目标不能为空');
    this.tasks.set(task.id, task);
    this._emit(task, { type: 'task:queued', goal: task.goal });
    this._persist();
    // 内存上界：超出保留额自动清理最旧的已结束任务
    if (this.tasks.size > TASKS_KEEP + 40) this.prune(TASKS_KEEP);
    this.queue.push(task.id);
    this._pump();
    return task;
  }

  _pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.cancelled) continue;
      this.running += 1;
      this._run(task).catch((e) => {
        task.status = 'failed';
        task.error = String((e && e.message) || e);
        task.endedAt = Date.now();
        this._emit(task, { type: 'task:error', error: task.error });
      }).finally(() => {
        this.running -= 1;
        this._pump();
      });
    }
  }

  /** 后台执行一个任务（不阻塞调用方） */
  async _run(task) {
    const self = this;
    task.status = 'running';
    task.startedAt = Date.now();
    this._emit(task, { type: 'task:start', tabId: task.tabId, targetId: task.targetId });

    const server = this.server;
    const brain = server.__brain;
    const tabId = task.tabId;

    // 整个任务运行在它自己的请求上下文里：语义层/工具层都能直接读到 tabId 与 targetId，
    // 无需层层传参，也不会与"当前活动标签页"混淆 —— 这正是"任务有独立视野"的实现基础。
    const runCtx = { tabId: tabId, targetId: task.targetId, sessionId: null, ttl: null, fresh: false };

    // 流式事件缓冲：token 事件按 ~300ms 节流发往界面（面板打字机式渲染）
    let tokenBuf = '';
    let lastTokenAt = 0;
    let answerSoFar = '';
    let lastAnswerAt = 0;
    let lastAnswerLen = 0;
    const flushTokens = function (force) {
      if (!tokenBuf) return;
      const now = Date.now();
      if (!force && now - lastTokenAt < 300) return;
      self._emit(task, { type: 'task:token', turn: null, delta: tokenBuf });
      tokenBuf = '';
      lastTokenAt = now;
    };
    const onEvent = function (ev) {
      if (ev.type === 'token') { tokenBuf += ev.delta || ''; flushTokens(false); return; }
      // 最终答复的流式增量：完整已到达文本，面板替换渲染
      if (ev.type === 'answer-delta') {
        const now = Date.now();
        if (now - lastAnswerAt > 250 || String(ev.text || '').length - lastAnswerLen > 40) {
          lastAnswerAt = now; lastAnswerLen = String(ev.text || '').length;
          self._emit(task, { type: 'task:answer-delta', turn: ev.turn, text: String(ev.text || '') });
        }
        answerSoFar = String(ev.text || '');
        return;
      }
      if (ev.type === 'thought') { self._emit(task, { type: 'task:thought', turn: ev.turn, delta: String(ev.delta || '') }); return; }
      if (ev.type === 'retry') { self._emit(task, { type: 'task:notice', kind: 'retry', text: '模型请求失败，' + Math.round(ev.delayMs / 100) / 10 + 's 后第 ' + ev.attempt + ' 次重试' }); return; }
      if (ev.type === 'compact:start') { self._emit(task, { type: 'task:notice', kind: 'compact', text: '上下文接近上限，压缩早期对话…' }); return; }
      if (ev.type === 'compact:end') { self._emit(task, { type: 'task:notice', kind: 'compact', text: '已压缩：' + ev.spanMessages + ' 条 → 1 份检查点' }); return; }
      if (ev.type === 'spill') { self._emit(task, { type: 'task:notice', kind: 'spill', text: '超长结果已存盘（' + ev.bytes + ' 字节），上下文保留预览' }); return; }
      if (ev.type === 'tools:parallel') { self._emit(task, { type: 'task:notice', kind: 'parallel', text: '并行执行 ' + ev.count + ' 个只读操作' }); return; }
      if (ev.type === 'catalog') { self._emit(task, { type: 'task:notice', kind: 'catalog', text: '技能目录已更新（' + ev.count + ' 项）' }); return; }
    };

    // 取消要能中断"正在进行"的模型请求：旧实现只在轮次边界检查 cancelled，
    // 用户点了停止后仍会跑完当前请求（最长 120s）并继续按退避重试。
    const ac = new AbortController();
    task.abortController = ac;
    const body = async () => {
      // 任务视野与隐私判定：先看工作页是否命中敏感名单 —— 命中就不建索引、不让页面文本上云。
      // 注意这只是"起点的快路径"：真正的拦截在门禁里按次实时判定（任务中途 navigate 到
      // 邮箱/银行站点也会被拦），这里的结论只用于避免多余的索引构建与给界面发事件。
      let work = { url: null, title: null, semanticUnits: null };
      let privacyHit = { matched: false };
      try {
        // 内核可用时按 targetId 精确取；否则退回扩展通道问当前页 URL（旧实现第二个 find 是
        // `&& false` 的恒假分支，等于"拿不到就不判定"，保护会静默失效）
        let pageUrl = null, pageTitle = null;
        if (server.cdp) {
          const pages = await server.cdp.pages(true);
          const mine = task.targetId != null ? pages.find(function (p) { return p.id === task.targetId; }) : null;
          if (mine) { pageUrl = mine.url; pageTitle = mine.title; }
        }
        if (!pageUrl && typeof server.cmd === 'function') {
          const info = await server.cmd('get-page-info', {}, 8000).catch(function () { return null; });
          const v = (info && info.result !== undefined) ? info.result : info;
          if (v && v.url) { pageUrl = v.url; pageTitle = v.title || null; }
        }
        if (pageUrl) {
          work = { url: pageUrl, title: pageTitle, semanticUnits: null };
          privacyHit = privacy.check(pageUrl);
        }
      } catch (e) { /* 拿不到就走门禁的 fail-closed 路径 */ }

      if (privacyHit.matched) {
        self._emit(task, { type: 'task:privacy', matched: true, site: privacyHit.site, reason: privacyHit.reason || privacyHit.rule || 'sensitive-site' });
      } else if (tabId != null || task.targetId) {
        // 构建该页的语义索引（作为 agent 的起始观察）；索引本身在本机，不发云端
        try {
          const entry = await server.semantic.ensure(tabId, true);
          work.semanticUnits = entry.units.length;
        } catch (e) { /* 索引失败不阻塞任务，agent 可自行重试 */ }
      }

      return brain.agent(task.goal, {
        registry: server.toolRegistry,
        ctx: {
          tabId: tabId,
          targetId: task.targetId,
          confirmHigh: task.confirmHigh,
          core: server.cdp,
          // 隐私保护：工作页命中敏感名单时，观察类工具一律拒绝（页面内容不出本机）。
          // privacyBlocked 只是"起点已知命中"的快速路径；门禁每次都会按当前页实时复核
          //（任务中途导航到敏感站点也会被拦）。
          privacyBlocked: !!(privacyHit && privacyHit.matched),
          workPageUrl: work.url || null,
          // 任务级取消检查：每次工具执行前判断，实现"随时可停"
          isCancelled: function () { return task.cancelled; },
          signal: ac.signal,
          /**
           * 高风险动作请示：把任务置为 waiting 并挂起这一轮，等界面上的用户决定。
           * 超时未决按"不批准"处理，避免任务永久挂住。
           */
          onNeedConfirm: function (info) {
            // 签名按"动作作用的元素"归一化，而不是按工具入参。
            // 原因：模型重试同一动作时入参会变（label_includes:'发送' ↔ unit_id:'u34'），
            // 按入参做签名会把同一个动作当成两件事，反复追问，任务在 waiting 打转。
            // 签名 = 目标身份 + 文本摘要。旧实现只用文本前 60 字，列表页里每行的
            // "删除"按钮文本相同 → 批准第 3 行后第 7 行直接放行（实测可复现）。
            const p0 = info.plan || info;
            // 元素键优先：同一元素（哪怕模型换了工具表达）只问一次；
            // 没有元素键时退回 selector/坐标/unit；都没有才用工具+入参。
            const identity = p0.element ? ('el:' + p0.element)
              : (p0.selector ? ('sel:' + p0.selector)
                : (p0.point ? ('pt:' + p0.point.x + ',' + p0.point.y)
                  : (p0.unit ? ('unit:' + p0.unit) : (info.tool + '|' + JSON.stringify(info.args || {}).slice(0, 80)))));
            const sig = 'target:' + identity + '|' + String(info.target || '').slice(0, 40);
            // 同一动作已获批过就不再追问：否则模型重试同一动作会被反复拦下，任务在 waiting 打转
            if (task.approvedSigs.has(sig)) return Promise.resolve(true);
            return new Promise(function (resolve) {
              if (task.cancelled) return resolve(false);
              task.status = 'waiting';
              task.pendingConfirm = Object.assign({ at: Date.now(), timeoutMs: CONFIRM_TIMEOUT, signature: sig }, info);
              self._emit(task, { type: 'task:needConfirm', confirm: task.pendingConfirm });
              const timer = setTimeout(function () {
                if (!task.confirmResolver) return;
                task.confirmResolver = null;
                task.pendingConfirm = Object.assign({}, task.pendingConfirm, { timedOut: true });
                self._emit(task, { type: 'task:confirmTimeout', id: task.id });
                resolve(false);
              }, CONFIRM_TIMEOUT);
              task.confirmResolver = function (approved) {
                clearTimeout(timer);
                task.confirmResolver = null;
                task.pendingConfirm = null;
                if (approved) task.approvedSigs.add(sig);
                if (task.status === 'waiting') task.status = 'running';
                self._emit(task, { type: 'task:confirmed', approved: !!approved, signature: sig });
                resolve(!!approved);
              };
            });
          }
        },
        pageSummary: undefined,
        runtime: {
          workPage: work,
          privacy: privacyHit,
          approval: { confirmHigh: !!task.confirmHigh }
        },
        maxTurns: task.maxTurns,
        onEvent: onEvent,
        onTurn: function (info) {
          flushTokens(true);   // 下一动作开始前，把残留在缓冲里的流式文本推完
          // 答复增量也要推完（finish 的最后一段可能还没到节流点）
          if (answerSoFar && answerSoFar.length > lastAnswerLen) {
            lastAnswerLen = answerSoFar.length;
            self._emit(task, { type: 'task:answer-delta', turn: info.turn, text: answerSoFar });
          }
          task.trace.push({
            turn: info.turn, kind: info.kind, tool: info.tool, args: info.args,
            thought: info.thought, result: info.result, error: info.error || null,
            // 高风险交涉的结果必须进轨迹：否则"被拦截""已批准"在事后完全不可见
            needConfirm: !!info.needConfirm, confirmed: !!info.confirmed
          });
          this._emit(task, {
            type: 'task:turn', turn: info.turn, tool: info.tool || info.kind, args: info.args,
            thought: info.thought, result: info.result,
            needConfirm: !!info.needConfirm, confirmed: !!info.confirmed
          });
        }.bind(this)
      });
    };

    const result = await server.als.run(runCtx, body);

    // 兜底：撤销任务期间为后台操作施加的视口覆盖（正常路径已按次清理）。
    // 不做这一步，用户之后切到该标签页可能看到被改过尺寸的渲染。
    try { await server.cdp.clearAllViewportOverrides(); } catch (e) { /* 内核不可用时忽略 */ }

    task.usage = result.usage;
    if (task.cancelled) {
      task.status = 'cancelled';
      task.answer = '（已取消）';
    } else if (result.ok) {
      task.status = 'done';
      task.answer = result.answer;
      task.summary = result.summary;
    } else {
      task.status = 'failed';
      task.answer = result.answer;
      task.error = result.exhausted ? '达到最大步数' : '任务未完成';
    }
    task.endedAt = Date.now();
    this._emit(task, { type: 'task:end', status: task.status, answer: task.answer, usage: task.usage, turns: result.turns });
    this._persist();
  }

  _emit(task, ev) {
    const e = Object.assign({ at: Date.now(), taskId: task.id }, ev);
    // 单调序号：**每条事件都发号**（含短命事件），但只有非短命事件入回放缓冲。
    // 这样"续传游标"是一个有定义的值：客户端只需回传"我见过的最大 seq"，
    // 服务端按 seq > from 过滤即可不重不漏。
    // 旧实现让客户端回传"已见事件数"当缓冲下标，而两者分母不同（短命事件计入客户端、
    // 不计入缓冲），重连时 from 常常越过缓冲长度 → 静默丢事件（实测）。
    e.seq = ++task.seq;
    if (!EPHEMERAL_EVENTS.has(e.type)) {
      task.events.push(e);
      if (task.events.length > EVENTS_KEEP) task.events.shift();
    }
    const subs = task.subscribers;
    if (subs) subs.forEach(function (fn) { try { fn(e); } catch (x) { /* ignore */ } });
  }

  /** 按 seq 取回放事件（from 为"已见的最大 seq"；0/undefined 表示要全部） */
  replaySince(task, from) {
    const since = Number.isFinite(+from) ? +from : 0;
    return task.events.filter(function (e) { return (e.seq || 0) > since; });
  }

  /** 订阅任务事件（新订阅者会先收到已有事件回放） */
  subscribe(id, fn, replay) {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.subscribers = task.subscribers || new Set();
    task.subscribers.add(fn);
    if (replay !== false) task.events.forEach(function (e) { try { fn(e); } catch (x) { /* ignore */ } });
    return function () { task.subscribers.delete(fn); };
  }

  get(id) { return this.tasks.get(id) || null; }

  /** 列表（默认只给摘要，避免大载荷） */
  list(opts) {
    const o = opts || {};
    const limit = o.limit || 30;
    const all = Array.from(this.tasks.values()).sort(function (a, b) { return b.createdAt - a.createdAt; });
    const slice = o.status ? all.filter(function (t) { return t.status === o.status; }) : all;
    return slice.slice(0, limit).map(function (t) {
      return {
        id: t.id, goal: t.goal, status: t.status,
        createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
        turns: t.trace.length,
        answer: o.full ? t.answer : cut(t.answer, 160),
        error: t.error,
        tokens: t.usage ? t.usage.total_tokens : null
      };
    });
  }

  detail(id, opts) {
    const o = opts || {};
    const t = this.tasks.get(id);
    if (!t) return null;
    return {
      id: t.id, goal: t.goal, status: t.status,
      createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
      tabId: t.tabId, turns: t.trace.length,
      answer: t.answer, summary: t.summary, error: t.error,
      usage: t.usage,
      // 等待用户确认高风险动作时，把请示内容一并给出（界面据此渲染确认条）
      pendingConfirm: t.pendingConfirm || null,
      // 事件流（实时观看/断线续传用）：?from=N 的语义是"已见的最大 seq"，与 SSE 端点一致。
      // 旧实现把它当数组下标（t.events.slice(from)），与客户端"已见事件数"分母不同 —— 续传会丢事件。
      events: o.events ? this.replaySince(t, o.from || 0) : undefined,
      eventCount: t.events.length,
      lastSeq: t.seq || 0,
      trace: t.trace.map(function (x) {
        return {
          turn: x.turn, kind: x.kind, tool: x.tool, args: x.args, thought: x.thought,
          // 高风险交涉结果必须透出：否则"被拦截""已批准"在事后与界面里都看不到
          needConfirm: !!x.needConfirm, confirmed: !!x.confirmed,
          result: x.result && JSON.stringify(x.result).length > 800 ? { preview: JSON.stringify(x.result).slice(0, 800), truncated: true } : x.result,
          error: x.error
        };
      })
    };
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: 'not-found' };
    // 终态集合统一（此前漏了 interrupted：对"已中断"的任务还能返回 cancelling=true，
    // 界面于是显示"停止中"且永不收敛）
    if (this.isFinal(t.status)) {
      return { ok: false, error: 'already-' + t.status };
    }
    t.cancelled = true;
    // 正等着用户确认时取消：先把挂起的请示按"不批准"解开，否则这一轮会一直挂着
    if (typeof t.confirmResolver === 'function') {
      const r = t.confirmResolver; t.confirmResolver = null;
      try { r(false); } catch (e) { /* ignore */ }
    }
    if (t.status === 'queued') {
      t.status = 'cancelled';
      t.endedAt = Date.now();
      this._emit(t, { type: 'task:end', status: 'cancelled', answer: '（已取消）' });
      this._persist();
      return { ok: true, id: id, status: t.status };
    }
    // 运行中（或等待确认中）是协作式取消：等当前轮工具返回后收敛。
    // 用 cancelling 明确告知界面"正在停"，避免界面把 running 误读为"取消没生效"。
    this._emit(t, { type: 'task:cancelling', id: id });
    return { ok: true, id: id, status: t.status, cancelling: true };
  }

  /**
   * 用户对"高风险动作请示"的决定 —— 决定权在人手里，agent 停在这一步等。
   * @param {string} id 任务 id
   * @param {boolean} approve 是否批准
   */
  confirm(id, approve) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: 'not-found' };
    if (typeof t.confirmResolver !== 'function') {
      return { ok: false, error: '该任务当前没有待确认的高风险动作', status: t.status };
    }
    const r = t.confirmResolver;
    t.confirmResolver = null;
    r(!!approve);
    this._persist();
    return { ok: true, id: id, approved: !!approve };
  }

  /** 终态判定：唯一定义处。
   *  流端点、prune、cancel 都问它 —— 之前各处写死 `['done','failed','cancelled']`，
   *  恢复出来的 interrupted 任务于是三处行为都不对（流永不结束、prune 删不掉、cancel 假装在停）。 */
  isFinal(status) { return FINAL_STATUSES.has(String(status || '')); }

  /** 清理已结束任务（保留最近 N 个；N=0 即清空全部已结束任务） */
  prune(keep) {
    const k = keep != null ? +keep : 50;   // 注意 0 是合法值，不能用 || 兜底
    const lim = Number.isFinite(k) && k >= 0 ? k : 50;
    const done = Array.from(this.tasks.values())
      // 判"已结束"用终态集合而不是 endedAt != null：恢复出来的 interrupted 任务
      // 旧数据里 endedAt 为 null，于是任何 keep 都删不掉，跨重启越积越多（实测）。
      .filter((t) => (t.endedAt != null || this.isFinal(t.status)))
      .sort(function (a, b) { return (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt); });
    const removed = [];
    done.slice(lim).forEach(function (t) { this.tasks.delete(t.id); removed.push(t.id); }, this);
    return removed;
  }

  stats() {
    const all = Array.from(this.tasks.values());
    const by = {};
    all.forEach(function (t) { by[t.status] = (by[t.status] || 0) + 1; });
    return { total: all.length, running: this.running, queued: this.queue.length, byStatus: by, maxConcurrent: this.maxConcurrent };
  }
}

module.exports = { TaskRunner: TaskRunner };
