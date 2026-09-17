/**
 * HTTP 外壳 —— 唯一入口，只负责"传输层"的事
 *
 * 职责边界（本次重构的核心划分）：
 *   本模块：Host/Origin 校验 → CORS → 令牌 → 请求级上下文(ALS) → 只读缓存 → 会话约束
 *           → 交给 Router 分发 → 统一响应 / 错误 / 超时映射
 *   能力模块：只关心"这件事怎么做"，完全不碰鉴权、缓存、响应格式
 *
 * 与重构前的关系：这段逻辑原本内联在 bridge-server.js 的 handleHTTPRequest 中，
 * 与 143 个 case 的 switch 混在一起。现在 switch 拆成 capabilities/*，传输层独立成此文件。
 * 三道防线（回环 Host、受限 Origin、令牌）的判定顺序与错误文案逐条保持不变。
 */

/**
 * @param {object} server 组合根（提供 isLoopbackHost / isAllowedOrigin / requestToken /
 *                        tokenEquals / getCachedResponse / setCachedResponse / als 等）
 * @param {Router} router 能力注册表
 * @param {object} opt { authToken, authTokenFile, tokenFile, port }
 * @returns {(req, res) => Promise<void>}
 */
function createHttpShell(server, router, opt) {
  const o = opt || {};
  const port = o.port || 9333;

  return async function handleHTTPRequest(req, res) {
    server.requestCount++;
    const t0 = Date.now();

    // ---- 第 1 道: Host 校验（挡 DNS rebinding）----
    const hostOk = server.isLoopbackHost(req.headers.host);
    const origin = req.headers.origin || null;
    const originOk = server.isAllowedOrigin(origin);

    // ---- 第 2 道: CORS 头按来源精确回显，不使用通配 '*' ----
    if (origin && originOk) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ark-Token, X-Session, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    }

    if (!hostOk || !originOk) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: `403: 请求被安全策略拒绝(${!hostOk ? `Host=${req.headers.host} 非回环地址` : `Origin=${origin} 不被信任`})`,
        hint: '仅允许 127.0.0.1/localhost 的 Host, 且来源须为本机页面或浏览器扩展页面'
      }));
      return;
    }

    // 预检请求不携带自定义头，必须在令牌校验前放行
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // ---- 第 3 道: 令牌校验（挡本机其他进程 / 任意网页的 CSRF）----
    // 例外: /health 为免鉴权存活探针，只回极简状态，不含任何敏感数据
    if (o.authToken && pathname !== '/health') {
      const provided = server.requestToken(req, url);
      if (!server.tokenEquals(provided, o.authToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: '401: 缺少或错误的访问令牌',
          hint: `在请求头带上 X-Ark-Token(或 ?token=)。令牌见 ${o.authTokenFile || o.tokenFile}, server 启动日志也会打印。CLI 会自动读取并携带。`,
          tokenFile: o.authTokenFile || o.tokenFile
        }));
        console.log(`[ArkWeb] ${req.method} ${pathname} -> 401 (令牌校验失败)`);
        return;
      }
    }

    // 全局参数：所有端点支持 ?tabId=<id> / ?ttl=<ms> / ?session=<id> / ?fresh=1 / ?browser=<标签>
    // 请求级隔离(ALS)：并发请求的参数互不覆盖
    const tabId = url.searchParams.get('tabId') ? +url.searchParams.get('tabId') : null;
    const ttlParam = url.searchParams.get('ttl');
    const ttl = ttlParam !== null ? +ttlParam : null;
    const sessionId = url.searchParams.get('session') || req.headers['x-session'] || null;
    const fresh = url.searchParams.get('fresh') === '1';
    // 多浏览器定向：?browser=browseros 或 X-Ark-Browser 头（发给哪个浏览器的插件）
    const browser = url.searchParams.get('browser') || req.headers['x-ark-browser'] || null;

    return server.als.run({ tabId, sessionId, ttl: Number.isFinite(ttl) ? ttl : null, fresh, browser }, async () => {

      const send = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
        if (status >= 400) console.log(`[ArkWeb] ${req.method} ${pathname} -> ${status} (${Date.now() - t0}ms)`);
      };

      // 会话预校验：必须在只读缓存命中之前执行 —— 否则越权请求可借缓存直接返回目标 tab 数据绕过 403
      if (sessionId != null && !pathname.startsWith('/session')) {
        const sess = server.sessions.get(String(sessionId));
        if (!sess) return send(404, { error: `session 不存在: ${sessionId}(请先 POST /session/create)` });
        if (tabId != null && !sess.tabIds.has(tabId)) {
          return send(403, { error: `403: session ${sessionId} 未绑定标签页 ${tabId}(POST /session/assign 可绑定)` });
        }
        // 多标签页会话 + 未指定 tabId 的歧义请求：直接 400
        const globalOk = pathname === '/tabs' || pathname === '/network' || pathname === '/analyze-all'
          || pathname.startsWith('/monitor') || pathname === '/status' || pathname === '/clear-cache'
          || pathname === '/history' || pathname.startsWith('/audit/') || pathname === '/open';
        if (tabId == null && !globalOk && sess.tabIds.size > 1) {
          return send(400, { error: `session ${sessionId} 绑定 ${sess.tabIds.size} 个标签页, 必须显式指定 ?tabId=` });
        }
      }

      // 只读端点缓存
      const cached = server.getCachedResponse(pathname, fresh);
      if (cached !== null) return send(200, cached);

      const route = router.resolve(pathname);
      if (!route) return send(404, { error: `Unknown endpoint: ${pathname}`, hint: 'POST 端点需要 JSON body' });

      const ctx = {
        server,
        router,
        req, res, url, pathname,
        method: req.method,
        params: route.params,
        tabId, sessionId, ttl: Number.isFinite(ttl) ? ttl : null, fresh,
        capability: route.cap,
        routeKey: route.key,
        send,
        // 读取请求体（能力模块统一用它，避免各自解析）
        body: async (fallback) => {
          try { return await server.readBody(req); } catch (e) { if (fallback !== undefined) return fallback; throw e; }
        },
        // 服务内部自调用（带令牌与请求级 tabId）
        self: (method, path, body) => server.callSelf(method, path, body)
      };

      try {
        const result = await route.fn(ctx);
        // 处理器可能已自行写过响应（SSE、或直接 ctx.send）
        if (res.headersSent) return;
        server.setCachedResponse(pathname, result);
        send(200, result);
      } catch (e) {
        if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
        // 插件命令超时：结构化错误（可被调用方识别为弹窗挂起等场景）
        if (e && e.code === 'PLUGIN_TIMEOUT') {
          send(504, {
            error: e.message,
            hint: 'GET /dialogs 查看是否有挂起弹窗; POST /dialog {auto:true} 可恢复自动应答',
            commandType: e.commandType
          });
        } else {
          send((e && e.statusCode) || 500, { error: (e && e.message) || String(e) });
        }
      }
    });
  };
}

module.exports = { createHttpShell };
