/**
 * 补充能力 —— 手写路由（非 switch 提取）
 *
 * 单独成文件的原因：capabilities/*.js 由 scripts/refactor-split.js 从原 switch 生成，
 * 重新生成会覆盖。手写的新路由必须放在生成器不触碰的地方，否则一次重跑就丢了。
 *
 * 这里放的是"原本就不是 switch 分支"或"提取后需要独立表达"的路由。
 */
module.exports = {
  name: 'extra',
  group: 'extra',
  doc: '自省清单 / 任务事件流 / 审计队列状态',

  routes: {
    /**
     * /bootstrap —— 新装的扩展副本自取令牌（多实例零手动接入，2026-10-02 新增）
     *
     * 背景：每个隔离实例用独立的 user-data-dir + 独立的扩展副本（路径唯一⇒extId唯一）。
     * 新 profile 里扩展的 chrome.storage 是空的 ⇒ 没有令牌 ⇒ 连不上 WS（wsTokenRequired）。
     * 过去要人工在 popup 里粘贴令牌，n 个实例就要 n 次手工。
     *
     * 安全模型（与 WS 来源校验同源，见 bridge-server.isAllowedWsOrigin）：
     *   · 无 Origin            → 本机进程（本来就能读令牌文件），放行
     *   · chrome-extension://  → 必须在扩展白名单里（labelMap 含其 extId），放行
     *   · http(s)://           → 网页，一律拒绝（WebSocket 不受 CORS 约束，HTTP 也不给）
     * 该路由已从令牌校验里豁免（http-shell），但**来源校验比令牌更严**，不构成降级。
     */
    '/bootstrap': async function (__ark) {
      const { req, send } = __ark;
      const srv = __ark.server;
      const origin = String((req && req.headers && req.headers.origin) || '');
      if (origin && !srv.isTrustedExtensionOrigin(origin)) {
        console.log('[ArkWeb] /bootstrap 拒绝来源: ' + origin);
        return send(403, { error: '403: 仅白名单扩展或本机进程可获取令牌', origin: origin });
      }
      const labels = (() => { try { return Object.keys(srv.labelMap()).length; } catch (e) { return 0; } })();
      return {
        token: srv.authToken || '',
        wsPort: srv.wsPort,
        httpPort: srv.port,
        wsTokenRequired: !!srv.wsTokenRequired,
        labelMapSize: labels,
        note: '把 token 存进 chrome.storage.local.arkWsToken 即可连接；连接名由扩展自行决定（manifest [名字] / popup / 内核名）',
      };
    },

    /**
     * 能力自省清单 —— 单一事实来源的对外出口。
     * 界面、文档、自检都从这里取"服务能做什么"，不再各自维护副本。
     */
    '/capabilities': async function (__ark) {
      return {
        stats: __ark.router.stats(),
        capabilities: __ark.router.catalog(),
        // 工具清单与路由清单一同构成"服务能做什么"的唯一出口：
        // 界面据此渲染动作名（label），不再自己维护一份中英对照表
        tools: __ark.router.tools().map(t => ({
          name: t.name, group: t.group, risk: t.risk, label: t.label, desc: t.desc
        })),
        endpoints: __ark.router.list(),
        drift: __ark.server.endpointDrift || null
      };
    },

    /**
     * 任务事件流（SSE）—— 任务在后台推进，界面借此实时观看。
     * 用 SSE 而非复用 9334 的 WebSocket：那条 WS 是插件控制通道（server→插件下发命令），
     * 混入观察者会污染命令路由。SSE 也让前端断线后用 ?from=N 精确续传。
     */
    '/agent/stream': async function (__ark) {
      const { req, res, url, send } = __ark;
      const srv = __ark.server;
      const sid = url.searchParams.get('id');
      const task = sid ? srv.tasks.get(sid) : null;
      if (!task) return send(404, { error: 'task not-found', id: sid || null });
      const from = Math.max(0, +url.searchParams.get('from') || 0);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const write = (ev, data) => {
        try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); return true; }
        catch (e) { return false; }
      };
      const finalPayload = (t) => ({
        id: task.id, status: t ? t.status : 'gone',
        answer: t ? t.answer : null, summary: t ? t.summary : null,
        error: t ? t.error : null, usage: t ? t.usage : null,
        turns: t ? t.trace.length : 0, endedAt: t ? t.endedAt : null
      });

      // 回放已有事件。?from=N 的语义是"我见过的最大 seq"（不是缓冲下标）——
      // 用下标会在短命事件计入客户端计数时错位，重连后静默丢事件（实测）。
      const backlog = srv.tasks.replaySince(task, from);
      write('snapshot', {
        id: task.id, goal: task.goal, status: task.status,
        createdAt: task.createdAt, startedAt: task.startedAt, endedAt: task.endedAt,
        turns: task.trace.length, total: task.seq || task.events.length, lastSeq: task.seq || 0
      });
      backlog.forEach(e => write('ev', e));

      if (srv.tasks.isFinal(task.status)) {
        write('final', finalPayload(task));
        return res.end();
      }

      let closed = false;
      const unsub = srv.tasks.subscribe(task.id, (e) => { if (!closed) write('ev', e); }, false);
      const beat = setInterval(() => { if (!write('ping', { at: Date.now() })) cleanup(); }, 15000);
      const watch = setInterval(() => {
        const t = srv.tasks.get(task.id);
        if (!t || srv.tasks.isFinal(t.status)) {
          write('final', finalPayload(t));
          cleanup();
        }
      }, 700);

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(beat); clearInterval(watch);
        try { unsub && unsub(); } catch (e) { /* ignore */ }
        try { res.end(); } catch (e) { /* ignore */ }
      }
      req.on('close', cleanup);
      console.log(`[ArkWeb] SSE 订阅任务 ${task.id} (from=${from}, 回放 ${backlog.length} 条)`);
    },

    /**
     * 高风险动作的人机协作端点：任务在等待确认时停住，由这里给出"批准/拒绝"。
     * 放在手写模块的原因：agent.js 由生成器产出，重新生成会覆盖。
     */
    '/agent/confirm': async function (__ark) {
      const body = await __ark.server.readBody(__ark.req);
      if (!body || !body.id) return __ark.send(400, { error: 'id is required' });
      return __ark.server.tasks.confirm(body.id, !!body.approve);
    },

    /**
     * 审计队列任务状态（原为 HTTP 外壳里的 startsWith 特判，现作正式路由归属到审计域）
     */
    '/audit/status/:id': async function (__ark) {
      return __ark.server.auditQueue.getStatus(__ark.params.id);
    }
  }
};
