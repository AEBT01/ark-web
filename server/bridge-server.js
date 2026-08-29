/**
 * Ark Web — Bridge Server v3
 * 本地 WebSocket + HTTP 服务器，连接 Chrome 插件和 AI 终端
 *
 * 端口:
 *  - HTTP API: 9333 (AI 调用)
 *  - WebSocket: 9334 (Chrome 插件连接)
 *
 * v3 优化:
 *  - JSON 紧凑输出(无缩进, 省 ~30% 传输)
 *  - HTTP keep-alive
 *  - 只读端点缓存(键含 tabId, ?fresh=1 绕过)
 *  - /batch 一次 WS 往返执行多步命令
 *  - 插件断连时立即拒绝所有 pending 请求
 */

const WebSocket = require('ws');
const http = require('http');
const { AsyncLocalStorage } = require('async_hooks');
const auditEngine = require('./audit');
const auditReport = require('./audit-report');

class ArkWebServer {
  constructor(options = {}) {
    this.port = options.port || 9333;
    this.wsPort = options.wsPort || 9334;
    this.clients = new Map();
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.networkLogs = [];
    this.consoleLogs = [];
    this.connected = false;
    this.cache = new Map();
    this.monitorInterval = null;
    this.monitorData = [];
    this.monitorStartTime = 0;
    this.startedAt = Date.now();
    this.requestCount = 0;
    // 请求级 tabId 隔离: AsyncLocalStorage 随 await 链自动传播, 消除并发请求间实例字段竞态
    this.als = new AsyncLocalStorage();
    // 多 agent 会话: sessionId -> { id, tabIds:Set, createdAt }
    // 绑定后, 会话内请求只能操作本会话的标签页; 新开标签页自动归属会话(详见 /session 端点)
    this.sessions = new Map();
    this.nextSessionId = 1;
    // 审计队列: 支持请求级 ALS 上下文重放(ctx) —— 队列内导航/采集在原会话/tab 内执行, 不逃逸到用户活动标签页
    this.auditQueue = auditReport.createQueue((msg, ctx) => ctx
      ? this.als.run(ctx, () => this.cmd(msg.type, msg.data, 60000))
      : this.cmd(msg.type, msg.data, 60000));

    // 只读端点的缓存时长(秒), 演示与高频轮询友好
    // 注意: 仅缓存无参数的只读端点; 带 selector 等参数的 POST 端点不可缓存
    this.cacheTtl = {
      '/page-info': 2000, '/dom': 1000, '/performance': 2000,
      '/vitals': 5000, '/security': 5000, '/a11y': 5000,
      '/seo': 5000, '/resources': 5000
    };
    // v8 极速: per-tab 串行队列(同 tab 保序, 跨 tab 并行) + inflight 合并 + snapshot 缓存
    this.tabQueues = new Map(); // tabId(String) -> Promise tail
    this.inflight = new Map(); // key -> {promise, ts}
    this.snapshotCache = new Map(); // tabKey -> {data, time}
    // 写操作类型: 命中后失效 snapshot/只读缓存
    this.writeTypes = new Set(['click-element','hover-element','double-click','right-click','drag-element','mouse','scroll-page','scroll-into-view','scroll-by','simulate-key','type-text','fill-form','select-option','check-box','clear-field','focus-element','open-url','reload','back','forward','activate-tab','close-tab','highlight-elements','clear-highlights','evaluate','set-storage','remove-storage','clear-storage','set-cookie','remove-cookie','upload-file']);
    // Server keep-alive 调优(v8)
    // snapshot 缓存 400ms, 高频连续 snapshot 命中 <5ms
    this.snapshotTtl = 400;

    this.init();
  }

  // ============ 初始化 ============

  init() {
    this.wss = new WebSocket.Server({ port: this.wsPort }, () => {
      console.log(`[ArkWeb] WebSocket 服务器: ws://localhost:${this.wsPort}`);
    });

    this.wss.on('connection', (ws) => {
      console.log('[ArkWeb] Chrome 插件已连接');
      this.clients.set(ws, { connectedAt: Date.now(), version: '0.0.0' });
      this.connected = true;

      ws.on('message', (data) => {
        try {
          this.handlePluginMessage(JSON.parse(data.toString()), ws);
        } catch (e) {
          console.error('[ArkWeb] 消息解析错误:', e.message);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.connected = this.clients.size > 0;
        // 插件断开: 立即拒绝所有等待中的请求, 避免挂起 20s
        for (const { reject, timer } of this.pendingRequests.values()) {
          clearTimeout(timer);
          reject(new Error('Chrome 插件已断开连接, 请检查插件状态'));
        }
        this.pendingRequests.clear();
        console.log(`[ArkWeb] 插件已断开, 剩余连接: ${this.clients.size}`);
      });

      ws.on('error', (e) => console.error('[ArkWeb] WebSocket 错误:', e.message));
    });

    this.server = http.createServer((req, res) => this.handleHTTPRequest(req, res));
    // v8.1: keep-alive 与 client 8s 对齐，避免服务端 65s 空挂导致 ECONNRESET
    this.server.keepAliveTimeout = 10000;
    this.server.headersTimeout = 12000;
    this.server.maxHeadersCount = 100;
    this.server.requestTimeout = 0;
    this.server.listen(this.port, () => {
      console.log(`[ArkWeb] HTTP 服务器: http://localhost:${this.port}`);
      console.log('');
      console.log('[ArkWeb] 快速开始:');
      console.log('  1. Chrome 加载 extension/ 目录的插件');
      console.log('  2. 打开插件 popup, 点击「启用调试」(Chrome 136+ 必须)');
      console.log('  3. 现在可以由 AI 或 curl 调用 API');
      console.log('');
      console.log(`[ArkWeb] 端点列表 (${this.listEndpoints().length} 个):`);
      this.listEndpoints().forEach(e => console.log(`  ${e}`));
    });

    // 心跳(15s)
    setInterval(() => {
      for (const ws of this.clients.keys()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
  }

  listEndpoints() {
    return [
      'GET  /status', 'GET  /tabs', 'GET  /full', 'GET  /clear-cache',
      'POST /batch {steps:[{type,data}]}',
      'GET  /session', 'POST /session/create', 'POST /session/delete {sessionId, closeTabs?}',
      'POST /session/assign {sessionId,tabId}', 'POST /session/release {sessionId,tabId?}',
      'POST /session/tab {sessionId,url, active?}',
      'POST /open {url, current?}', 'POST /navigate {url}', 'POST /reload', 'POST /back', 'POST /forward',
      'POST /tab/activate {tabId}', 'POST /tab/close {tabId}',
      'GET  /page-info', 'GET  /dom', 'GET  /html', 'GET  /frames', 'GET  /layout',
      'POST /query {selector}',
      'POST /query-all {selector}', 'POST /query-many {selectors}',
      'POST /exists {selector}', 'POST /text {selector}',
      'POST /attr {selector,name}', 'POST /value {selector}',
      'POST /get-text {selector}', 'POST /get-attr {selector,name}', 'POST /get-value {selector} (插件命令名别名)',
      'POST /click {selector}', 'POST /hover {selector}', 'POST /dblclick {selector}',
      'POST /rightclick {selector}', 'POST /drag {selector,targetSelector|dx,dy}',
      'POST /mouse {type,x,y}', 'POST /scroll {x,y}', 'POST /scroll-by {x,y}', 'POST /scroll-into-view {selector}',
      'POST /key {key,modifiers}', 'POST /type {selector?,text,mode}',
      'POST /fill {fields:[{selector,value}]}',
      'POST /select {selector,value|text}', 'POST /check {selector,checked}',
      'POST /clear {selector}', 'POST /focus {selector}',
      'POST /evaluate {code,timeout}', 'POST /wait-for {selector,timeout,state}',
      'POST /wait-for-text {text}', 'POST /wait-for-url {pattern}', 'POST /wait-for-load',
      'GET  /screenshot?format=&quality=', 'GET  /screenshot/full',
      'POST /screenshot/element {selector}',
      'GET  /snapshot?format=&annotate=&full=&compact=&maxElements=&selector=&fast=', 'POST /snapshot {format,annotate,full,compact,maxElements,selector,fast}',
      'GET  /snapshot/binary?format=&annotate=&full=&compact=&selector=&fast=',
      'POST /fast/act {action,selector,text,fields,url,fast}', 'POST /act {action,...}',
      'GET  /fast/snapshot', 'POST /fast/click {selector,text,fast}', 'POST /fast/fill {fields}',
      'GET  /html', 'POST /html {selector}',
      'GET  /pdf?format=', 'POST /pdf {format,landscape,printBackground,margin}', 'POST /upload {selector,files}',
      'POST /highlight {selector,color}', 'POST /highlight/clear',
      'POST /dialog {accept,promptText,auto}', 'GET  /dialogs',
      'POST /auto-dark {enabled}',
      'POST /js {disabled}', 'POST /hardware-concurrency {count}',
      'GET  /cookies', 'POST /cookie {name,value,...}', 'POST /cookie/remove {name}',
      'GET  /storage?type=local|session', 'POST /storage {type,key,value}',
      'POST /storage/remove {type,key}', 'POST /storage/clear {type}',
      'GET  /network?filter=&limit=', 'POST /network/clear',
      'POST /network/response {urlPattern}',
      'POST /network/block {patterns}', 'POST /network/unblock',
      'POST /network/conditions {offline,latency,download,upload}',
      'POST /network/conditions/reset',
      'POST /network/disable-cache {disabled}', 'POST /bypass-csp {enabled}',
      'GET  /performance', 'GET  /vitals', 'GET  /resources',
      'POST /cpu {rate}',
      'POST /device {device|width,height,...}', 'POST /device/clear',
      'POST /reset-all (一键恢复全部模拟/策略影响: 设备/媒体/geo/时区/语言/CPU/JS/并发/网络/CSP/缓存/暗色/高亮/弹窗策略/滚动)',
      'POST /media {features}', 'POST /geo {latitude,longitude}',
      'POST /locale {locale}', 'POST /timezone {timezoneId}',
      'GET  /security', 'GET  /a11y', 'GET  /seo',
      'GET  /console?limit=', 'POST /console/clear',
      'GET  /dom-changes', 'POST /dom-changes/clear',
      'GET  /analyze-all', 'POST /monitor {interval,duration}',
      'POST /monitor/stop', 'GET  /monitor/status',
      'POST /debug/attach-all', 'POST /debug/detach-all', 'GET  /debug/info', 'GET  /debug/cdp-status',
      'POST /audit {url?,budget?,format?,save?}', 'GET  /history?url=&limit=',
      'POST /audit/run {urls,budget}', 'GET  /audit/status/<id>',
      '通用: 所有端点支持 ?tabId=<id> 指定标签页',
      '通用: 所有端点支持 ?session=<id> 会话隔离(只能操作本会话绑定的标签页)'
    ];
  }

  // ============ 插件消息 ============

  handlePluginMessage(message) {
    const { type, data, id } = message;

    switch (type) {
      case 'register':
        console.log('[ArkWeb] 插件注册:', JSON.stringify(data));
        // 记录注册信息, 供多实例时选择最新版本
        for (const [ws, info] of this.clients) {
          if (ws.readyState === WebSocket.OPEN) {
            info.version = data?.version || info.version;
          }
        }
        break;

      case 'response':
        if (id && this.pendingRequests.has(id)) {
          const { resolve, timer } = this.pendingRequests.get(id);
          clearTimeout(timer);
          resolve(data);
          this.pendingRequests.delete(id);
        }
        break;

      case 'error':
        if (id && this.pendingRequests.has(id)) {
          const { reject, timer } = this.pendingRequests.get(id);
          clearTimeout(timer);
          reject(new Error(data?.message || 'Plugin error'));
          this.pendingRequests.delete(id);
        }
        break;

      case 'network-request':
      case 'network-response':
        this.networkLogs.push({ ...data, type });
        if (this.networkLogs.length > 2000) this.networkLogs = this.networkLogs.slice(-1000);
        break;

      case 'console-log': {
        // 支持单条或批量(log 为数组)
        const logs = Array.isArray(data?.log) ? data.log : [data?.log];
        logs.forEach(l => {
          if (l) this.consoleLogs.push({ ...l, tabId: data?.tabId });
        });
        if (this.consoleLogs.length > 2000) this.consoleLogs = this.consoleLogs.slice(-1000);
        break;
      }

      case 'core-status':
        console.log('[ArkWeb] 插件核心域状态:', JSON.stringify(data));
        break;

      default:
        console.log('[ArkWeb] 未知消息类型:', type);
    }
  }

  /** 向插件发送命令(多实例时优先选择版本最高的连接) */
  sendToPlugin(message, timeout = 20000) {
    return new Promise((resolve, reject) => {
      let target = null;
      let bestVer = '0.0.0';
      for (const [ws, info] of this.clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const v = (info.version || '0.0.0').replace(/-.*$/, '');
        if (v > bestVer) { bestVer = v; target = ws; }
      }
      if (!target) {
        reject(new Error('Chrome 插件未连接。请: 1) 安装插件 2) 打开 Chrome 3) 点击插件图标确认连接'));
        return;
      }
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        const e = new Error(`插件命令超时(${timeout}ms): ${message.type} — 可能原因: ①页面有模态弹窗挂起(手动模式) ②页面渲染忙/冻结 ③CDP 授权过期`);
        e.code = 'PLUGIN_TIMEOUT';
        e.commandType = message.type;
        reject(e);
      }, timeout);
      this.pendingRequests.set(id, { resolve, reject, timer });
      target.send(JSON.stringify({ ...message, id }));
    });
  }

  // v8 per-tab 串行队列: 同 tab 保序, 跨 tab 完全并行
  _enqueue(tabId, fn) {
    const key = tabId != null ? String(tabId) : '__global__';
    const prev = this.tabQueues.get(key) || Promise.resolve();
    const cur = prev.then(() => fn());
    // 链不断裂, 错误不污染后续
    this.tabQueues.set(key, cur.catch(() => {}));
    return cur;
  }
  _inflightKey(type, tabId, data) {
    // 只对幂等只读命令合并, 写操作不合并
    const ro = new Set(['get-page-info','get-dom','get-html','get-performance','get-web-vitals','get-resources','security-check','a11y-check','seo-check','get-console-logs','get-dom-changes','query-selector','query-all','query-many','element-exists','get-text','get-attr','get-value','get-cookies','get-storage','get-tabs','get-browser-info','get-cdp-status','vision-snapshot','screenshot','screenshot-full']);
    if (!ro.has(type)) return null;
    try { return `${type}:${tabId ?? 'global'}:${JSON.stringify(data||{})}`; } catch { return null; }
  }
  _snapshotKey(tabId, data) {
    const ctx = this.als.getStore() || {};
    const tid = tabId != null ? tabId : (ctx.tabId != null ? ctx.tabId : (ctx.sessionId != null ? this.resolveCacheTab() : 'active'));
    // 区分不同参数: format/quality/selector/maxElements/fast/compact，annotate/full已在外层排除但仍纳入以防投毒
    const sig = data ? `${data.format||'png'}:${data.quality||80}:${data.maxElements||50}:${data.selector||''}:${data.fast||''}:${data.compact||''}:${data.annotate||''}:${data.full||''}` : '';
    return `snap:${String(tid)}:${sig}`;
  }

  async cmd(type, data = {}, timeout) {
    // 全局 ?tabId=<id> 注入到命令数据, 使所有端点真正支持指定标签页
    // 从请求级 ALS 上下文读取, 并发请求互不干扰(此前为实例字段, 存在竞态)
    const ctx = this.als.getStore() || {};
    let target = ctx.tabId != null ? ctx.tabId : null;
    // 会话约束: session 请求只能操作本会话绑定的标签页(多 agent 并行互不干扰的核心)
    if (ctx.sessionId != null) {
      const sess = this.sessions.get(String(ctx.sessionId));
      if (!sess) {
        const e = new Error(`session 不存在: ${ctx.sessionId}(请先 POST /session/create)`);
        e.statusCode = 404;
        throw e;
      }
      // 新建标签页命令(open-url 非 current)是会话建 tab 的入口, 允许空会话执行, 归属由调用方(/open、/session/tab)处理
      const isOpenNewTab = type === 'open-url' && data && data.current !== true;
      if (target != null) {
        if (!sess.tabIds.has(target)) {
          const e = new Error(`403: session ${ctx.sessionId} 未绑定标签页 ${target}(POST /session/assign 可绑定)`);
          e.statusCode = 403;
          throw e;
        }
      } else if (sess.tabIds.size === 1) {
        // 单标签页会话: 自动使用唯一 tab, 无需显式 ?tabId=
        target = [...sess.tabIds][0];
      } else if (sess.tabIds.size === 0) {
        if (!isOpenNewTab) {
          const e = new Error(`session ${ctx.sessionId} 尚未绑定任何标签页(POST /session/tab 或 /session/assign)`);
          e.statusCode = 400;
          throw e;
        }
      } else {
        const e = new Error(`session ${ctx.sessionId} 绑定 ${sess.tabIds.size} 个标签页, 必须显式指定 ?tabId=`);
        e.statusCode = 400;
        throw e;
      }
    }
    if (target != null && data && typeof data === 'object' && !Array.isArray(data)) {
      data.tabId = target;
    }
    // snapshot 读缓存(400ms 高频命中 <5ms) — 仅在无 pending 队列时快路径返回，保证同 tab 保序
    if (type === 'vision-snapshot' && !data.full && !data.annotate) {
      const store = this.als.getStore() || {};
      const isFresh = store.fresh || store.ttl === 0;
      if (!isFresh) {
        const qKey = String(target ?? this.resolveCacheTab());
        const hasPending = this.tabQueues.has(qKey);
        if (!hasPending) {
          const sk = this._snapshotKey(target, data);
          const hit = this.snapshotCache.get(sk);
          if (hit && Date.now() - hit.time < this.snapshotTtl) {
            return { ...hit.data, fromCache: true, cacheAge: Date.now() - hit.time };
          }
        }
      }
    }
    // inflight 合并: 并发同键只发一次 WS
    const ik = this._inflightKey(type, target, data);
    if (ik && this.inflight.has(ik)) return this.inflight.get(ik).promise;
    const exec = () => {
      if (type === 'vision-snapshot' && !data.full && !data.annotate) {
        const store2 = this.als.getStore() || {};
        const isFresh2 = store2.fresh || store2.ttl === 0;
        if (!isFresh2) {
          const sk2 = this._snapshotKey(target, data);
          const hit2 = this.snapshotCache.get(sk2);
          if (hit2 && Date.now() - hit2.time < this.snapshotTtl) return Promise.resolve({ ...hit2.data, fromCache: true, cacheAge: Date.now() - hit2.time });
        }
      }
      return this.sendToPlugin({ type, data }, timeout);
    };
    // v8.1: 读写分离 — 写串行 per-tab，读仅等待 pending 写后并行，解决 /full 7×串行回归
    let p;
    if (this.writeTypes.has(type)) {
      const queued = this._enqueue(target, exec);
      p = queued.then(r => {
        const ck = `${target ?? this.resolveCacheTab()}`;
        for (const k of [...this.cache.keys()]) if (k.endsWith(`:${ck}`)) this.cache.delete(k);
        const prefix = `snap:${String(target ?? this.resolveCacheTab())}:`;
        for (const k of [...this.snapshotCache.keys()]) if (k.startsWith(prefix) || k === `snap:${String(target ?? this.resolveCacheTab())}`) this.snapshotCache.delete(k);
        return r;
      });
    } else {
      // 读: 仅等待前序写完成，不与其他读串行
      const qKey = String(target ?? this.resolveCacheTab());
      const tail = this.tabQueues.get(qKey);
      const waitTail = tail ? tail.catch(() => {}) : Promise.resolve();
      if (type === 'vision-snapshot' && !data.full && !data.annotate) {
        p = waitTail.then(() => exec()).then(r => {
          if (r && r.success && r.dataUrl) {
            this.snapshotCache.set(this._snapshotKey(target, data), { data: r, time: Date.now() });
            if (this.snapshotCache.size > 50) {
              const first = this.snapshotCache.keys().next().value;
              this.snapshotCache.delete(first);
            }
          }
          return r;
        });
      } else {
        p = waitTail.then(() => exec());
      }
    }
    if (ik) {
      const entry = { promise: p, ts: Date.now() };
      this.inflight.set(ik, entry);
      // 清理链必须先接住 rejection: p.finally() 会派生新 Promise, 若 p 被拒绝且无人消费会触发 unhandledRejection 使进程崩溃
      p.catch(() => {}).finally(() => {
        // 保留 10ms 避免抖动, 随后清理
        setTimeout(() => { if (this.inflight.get(ik) === entry) this.inflight.delete(ik); }, 10);
      });
    }
    return p;
  }

  // ============ 缓存 ============

  getCache(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.time < item.ttl) return item.data;
    return null;
  }

  setCache(key, data, ttl) {
    this.cache.set(key, { data, time: Date.now(), ttl });
  }

  clearCache() {
    this.cache.clear();
  }

  // ============ HTTP 处理 ============

  async handleHTTPRequest(req, res) {
    this.requestCount++;
    const t0 = Date.now();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${this.port}`);
    const pathname = url.pathname;
    // 全局 tabId 参数: 所有端点支持 ?tabId=<id>
    // 请求级隔离(ALS): 并发请求的 ?tabId 互不覆盖, 修复此前的实例字段竞态
    const tabId = url.searchParams.get('tabId') ? +url.searchParams.get('tabId') : null;
    // 缓存 TTL 覆盖: ?ttl=<ms>(0=禁用缓存, 默认端点 TTL 见 cacheTtl)
    const ttlParam = url.searchParams.get('ttl');
    const ttl = ttlParam !== null ? +ttlParam : null;
    // 会话参数: ?session=<id> 或 X-Session 头; 会话内请求只能操作本会话绑定的标签页
    const sessionId = url.searchParams.get('session') || req.headers['x-session'] || null;
    const fresh = url.searchParams.get('fresh') === '1';
    return this.als.run({ tabId, sessionId, ttl: Number.isFinite(ttl) ? ttl : null, fresh }, async () => {

    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj)); // 紧凑输出
      if (status >= 400) {
        console.log(`[ArkWeb] ${req.method} ${pathname} -> ${status} (${Date.now() - t0}ms)`);
      }
    };

    // 会话预校验: 必须在只读缓存命中之前执行 —— 否则越权请求可借缓存直接返回目标 tab 数据绕过 403
    // 管理端点(/session*)自身不受此限制
    if (sessionId != null && !pathname.startsWith('/session')) {
      const sess = this.sessions.get(String(sessionId));
      if (!sess) return send(404, { error: `session 不存在: ${sessionId}(请先 POST /session/create)` });
      if (tabId != null && !sess.tabIds.has(tabId)) {
        return send(403, { error: `403: session ${sessionId} 未绑定标签页 ${tabId}(POST /session/assign 可绑定)` });
      }
      // 多标签页会话 + 未指定 tabId 的歧义请求: 直接 400(避免只读缓存短路 cmd() 的约束校验)
      // 全局端点(/tabs /network /analyze-all /monitor* /status /history /audit*)与 /open(建 tab 入口)豁免
      const globalOk = pathname === '/tabs' || pathname === '/network' || pathname === '/analyze-all'
        || pathname.startsWith('/monitor') || pathname === '/status' || pathname === '/clear-cache'
        || pathname === '/history' || pathname.startsWith('/audit/') || pathname === '/open';
      if (tabId == null && !globalOk && sess.tabIds.size > 1) {
        return send(400, { error: `session ${sessionId} 绑定 ${sess.tabIds.size} 个标签页, 必须显式指定 ?tabId=` });
      }
    }

    // 只读端点缓存
    const cached = this.getCachedResponse(pathname, fresh);
    if (cached !== null) return send(200, cached);

    // 审计任务状态查询: GET /audit/status/<id>
    if (pathname.startsWith('/audit/status/')) {
      const id = decodeURIComponent(pathname.split('/').pop());
      return send(200, this.auditQueue.getStatus(id));
    }

    try {
      let result;
      switch (pathname) {
        // ============ 基础 ============
        case '/status':
          result = {
            connected: this.connected,
            pluginConnected: this.connected,
            clients: this.clients.size,
            networkLogs: this.networkLogs.length,
            consoleLogs: this.consoleLogs.length,
            requests: this.requestCount,
            uptime: Math.round((Date.now() - this.startedAt) / 1000),
            version: 3
          };
          break;

        case '/clear-cache':
          this.clearCache();
          result = { success: true, message: 'Cache cleared' };
          break;

        case '/tabs': {
          result = await this.cmd('get-tabs');
          // 会话视角: 标注 owned, 并清理已关闭标签页的绑定
          if (sessionId != null) {
            const sess = this.sessions.get(String(sessionId));
            if (sess && Array.isArray(result)) {
              const alive = new Set(result.map(t => t.id));
              for (const id of [...sess.tabIds]) if (!alive.has(id)) sess.tabIds.delete(id);
              for (const t of result) t.owned = sess.tabIds.has(t.id);
            }
          }
          break;
        }

        // ============ 会话(多 agent 并行隔离) ============
        case '/session':
          result = {
            active: sessionId,
            sessions: [...this.sessions.entries()].map(([id, s]) => ({ id, tabIds: [...s.tabIds], createdAt: s.createdAt }))
          };
          break;

        case '/session/create': {
          const id = `s${this.nextSessionId++}-${Date.now().toString(36)}`;
          this.sessions.set(id, { id, tabIds: new Set(), createdAt: Date.now() });
          result = { success: true, sessionId: id, createdAt: Date.now() };
          break;
        }

        case '/session/delete': {
          const b = await this.readBody(req);
          const sid = String(b.sessionId || '');
          const sess = this.sessions.get(sid);
          if (!sess) { result = { error: `session 不存在: ${sid}` }; break; }
          const closedTabs = [];
          // 可选 closeTabs: 删除会话时同时关闭其标签页(并自动恢复该 tab 的全部模拟)
          // 安全: 永远保留浏览器 ≥1 个标签页(全部关闭会连带关闭窗口 → No current window)
          if (b.closeTabs === true && sess.tabIds.size) {
            const tabs = await this.cmd('get-tabs').catch(() => []);
            const alive = new Set((Array.isArray(tabs) ? tabs : []).map(t => t.id));
            for (const id of sess.tabIds) {
              if (alive.has(id)) {
                await this.cmd('close-tab', { tabId: id }).catch(() => {});
                closedTabs.push(id);
              }
            }
            // 若窗口只剩被关闭的标签页, 保留最后一个不关(防整窗关闭)
            const remaining = (await this.cmd('get-tabs').catch(() => [])).length;
            if (remaining === 0 && closedTabs.length) {
              const lastId = closedTabs.pop();
              await this.cmd('open-url', { url: 'about:blank', active: false }).catch(() => {});
            }
          }
          this.sessions.delete(sid);
          result = { success: true, sessionId: sid, closedTabs, hint: '标签页已关闭, 其模拟状态已随标签页销毁自动清除' };
          break;
        }

        case '/session/assign': {
          const b = await this.readBody(req);
          const sid = String(b.sessionId || '');
          const sess = this.sessions.get(sid);
          if (!sess) { result = { error: `session 不存在: ${sid}` }; break; }
          if (b.tabId == null) { result = { error: 'tabId is required' }; break; }
          sess.tabIds.add(+b.tabId);
          result = { success: true, sessionId: sid, tabId: +b.tabId, tabIds: [...sess.tabIds] };
          break;
        }

        case '/session/release': {
          const b = await this.readBody(req);
          const sid = String(b.sessionId || '');
          const sess = this.sessions.get(sid);
          if (!sess) { result = { error: `session 不存在: ${sid}` }; break; }
          if (b.tabId != null) sess.tabIds.delete(+b.tabId);
          else this.sessions.delete(sid);
          result = { success: true, sessionId: sid, tabIds: sess.tabIds.size ? [...sess.tabIds] : [] };
          break;
        }

        case '/session/tab': {
          // 会话专用开标签页: 新 tab 自动归属会话(不归属则后续命令 403)
          // 默认后台打开(active:false)不抢占用户焦点; 需要操作时才显式 active:true 或 /tab/activate
          const b = await this.readBody(req);
          const sid = String(b.sessionId || '');
          const sess = this.sessions.get(sid);
          if (!sess) { result = { error: `session 不存在: ${sid}` }; break; }
          if (!b.url) { result = { error: 'url is required' }; break; }
          const r = await this.cmd('open-url', { url: b.url, active: b.active === true });
          if (r?.tab?.id != null) {
            sess.tabIds.add(r.tab.id);
            r.sessionId = sid;
            r.hint = '标签页后台打开(不抢焦点); 需要交互时 POST /tab/activate 或重开 active:true';
          }
          result = r;
          break;
        }

        // ============ 批量(一次 WS 往返) ============
        case '/batch': {
          const body = await this.readBody(req);
          const steps = Array.isArray(body) ? body : body.steps;
          // 可选 timeout 字段: 整批总超时(默认 60s，自动按步超时总和扩展，避免整批504吞没已完成步骤)
          let batchTimeout = typeof body?.timeout === 'number' ? body.timeout : 60000;
          if (Array.isArray(steps)) {
            const sum = steps.reduce((a, s) => a + (typeof s.data?.timeout === 'number' ? s.data.timeout : 8000), 0);
            batchTimeout = Math.max(batchTimeout, Math.min(sum + 5000, 120000));
          }
          // 把请求级 tabId/session 约束注入每个 step: 否则 step 内无 tabId 时会 fallback 到
          // 插件侧"当前激活标签页", 多 agent 并行下产生竞态漂移
          if (Array.isArray(steps)) {
            const ctx2 = this.als.getStore() || {};
            let fallback = ctx2.tabId != null ? ctx2.tabId : null;
            if (ctx2.sessionId != null) {
              const sess2 = this.sessions.get(String(ctx2.sessionId));
              if (!sess2) {
                const e2 = new Error(`session 不存在: ${ctx2.sessionId}(请先 POST /session/create)`);
                e2.statusCode = 404;
                throw e2;
              }
              for (const s of steps) {
                const d = s.data || (s.data = {});
                if (d.tabId != null && !sess2.tabIds.has(d.tabId)) {
                  const e2 = new Error(`403: session ${ctx2.sessionId} 未绑定标签页 ${d.tabId}`);
                  e2.statusCode = 403;
                  throw e2;
                }
                if (d.tabId == null) {
                  if (sess2.tabIds.size === 1) {
                    d.tabId = [...sess2.tabIds][0];
                  } else if (sess2.tabIds.size === 0) {
                    // 新建标签页命令(open-url 非 current)允许空会话执行, 归属由 /open、/session/tab 处理
                    const isOpenNew = s.type === 'open-url' && d.current !== true;
                    if (!isOpenNew) {
                      const e2 = new Error(`session ${ctx2.sessionId} 尚未绑定任何标签页(POST /session/tab 或 /session/assign)`);
                      e2.statusCode = 400;
                      throw e2;
                    }
                  } else {
                    const e2 = new Error(`session ${ctx2.sessionId} 绑定 ${sess2.tabIds.size} 个标签页, batch 步骤必须显式指定 ?tabId=`);
                    e2.statusCode = 400;
                    throw e2;
                  }
                }
              }
            } else if (fallback != null) {
              for (const s of steps) {
                const d = s.data || (s.data = {});
                if (d.tabId == null) d.tabId = fallback;
              }
            }
          }
          // 步骤已逐条校验并注入, 直接发送(不走 cmd(), 避免多 tab 会话约束再次拦截 batch 本身)
          // 裸 batch(无 tabId/session)的批内 tab 跟踪由插件 runBatch 处理(open-url 新 tab 自动跟随)
          result = await this.sendToPlugin({ type: 'batch', data: { steps } }, batchTimeout);
          // 批内含写操作则失效相关 tab 的只读与快照缓存(原 bypass cmd 导致脏缓存)
          try {
            const ctx2b = this.als.getStore() || {};
            const affected = new Set();
            for (const s of (Array.isArray(steps) ? steps : [])) {
              if (this.writeTypes.has(s.type)) {
                const tid = s.data?.tabId != null ? String(s.data.tabId) : String(ctx2b.tabId ?? this.resolveCacheTab());
                affected.add(tid);
              }
            }
            for (const tid of affected) {
              for (const k of [...this.cache.keys()]) if (k.endsWith(`:${tid}`)) this.cache.delete(k);
              const pref = `snap:${tid}:`;
              for (const k of [...this.snapshotCache.keys()]) if (k.startsWith(pref)) this.snapshotCache.delete(k);
            }
          } catch {}
          break;
        }

        // ============ 页面 / 导航 ============
        case '/open': {
          const openBody = await this.readBody(req);
          result = await this.cmd('open-url', openBody);
          // current 导航未显式指定 tabId 时: 回显实际作用的目标 tab(防多标签漂移误判)
          if (openBody.current && result?.tabId != null && tabId == null) {
            result.usedTabId = result.tabId;
            result.hint = 'current 导航未指定 ?tabId=, 作用于当前激活标签页; 多标签场景请显式 ?tabId=<id>';
          }
          // 会话内新建标签页(current:false): 新 tab 自动归属会话, 免手动 assign
          if (sessionId != null && !openBody.current && result?.tab?.id != null) {
            const sess = this.sessions.get(String(sessionId));
            if (sess) {
              sess.tabIds.add(result.tab.id);
              result.sessionId = sessionId;
            }
          }
          break;
        }

        case '/navigate': {
          // 语义: 当前标签页导航(不新开 tab), 等价 /open {url, current: true}
          const navBody = await this.readBody(req);
          navBody.current = true;
          result = await this.cmd('open-url', navBody);
          break;
        }

        case '/reload':
          result = await this.cmd('reload', await this.readBody(req).catch(() => ({})));
          break;

        case '/back':
          result = await this.cmd('back', {});
          break;

        case '/forward':
          result = await this.cmd('forward', {});
          break;

        case '/tab/activate':
          result = await this.cmd('activate-tab', await this.readBody(req));
          break;

        case '/tab/close':
          result = await this.cmd('close-tab', await this.readBody(req));
          break;

        // ============ 页面信息 / DOM ============
        case '/page-info':
          result = await this.cmd('get-page-info');
          break;

        case '/dom':
          result = await this.cmd('get-dom');
          break;

        case '/html':
          result = await this.cmd('get-html', await this.readBody(req).catch(() => ({})));
          break;

        case '/frames':
          result = await this.cmd('get-frames', {});
          break;

        case '/layout':
          result = await this.cmd('get-layout', {});
          break;

        case '/query':
          result = await this.cmd('query-selector', await this.readBody(req));
          break;

        case '/query-all':
          result = await this.cmd('query-all', await this.readBody(req));
          break;

        case '/query-many':
          result = await this.cmd('query-many', await this.readBody(req));
          break;

        case '/exists':
          result = await this.cmd('element-exists', await this.readBody(req));
          break;

        // 插件命令名别名(与 CLI chain TYPE_MAP / /batch 对齐, 消除三方不一致):
        // /get-text=/text /get-attr=/attr /get-value=/value
        case '/get-text':
        case '/text':
          result = await this.cmd('get-text', await this.readBody(req).catch(() => ({})));
          break;

        case '/get-attr':
        case '/attr':
          result = await this.cmd('get-attr', await this.readBody(req));
          break;

        case '/get-value':
        case '/value':
          result = await this.cmd('get-value', await this.readBody(req));
          break;

        // ============ 元素操作 ============
        case '/click':
          result = await this.cmd('click-element', await this.readBody(req));
          break;

        case '/hover':
          result = await this.cmd('hover-element', await this.readBody(req));
          break;

        case '/dblclick':
          result = await this.cmd('double-click', await this.readBody(req));
          break;

        case '/rightclick':
          result = await this.cmd('right-click', await this.readBody(req));
          break;

        case '/drag':
          result = await this.cmd('drag-element', await this.readBody(req));
          break;

        case '/mouse':
          result = await this.cmd('mouse', await this.readBody(req));
          break;

        case '/scroll':
          result = await this.cmd('scroll-page', await this.readBody(req));
          break;

        case '/scroll-into-view':
          result = await this.cmd('scroll-into-view', await this.readBody(req));
          break;

        case '/scroll-by':
          result = await this.cmd('scroll-by', await this.readBody(req));
          break;

        // ============ 键盘 / 输入 ============
        case '/key':
          result = await this.cmd('simulate-key', await this.readBody(req));
          break;

        case '/type':
          result = await this.cmd('type-text', await this.readBody(req));
          break;

        case '/fill':
          result = await this.cmd('fill-form', await this.readBody(req));
          break;

        case '/select':
          result = await this.cmd('select-option', await this.readBody(req));
          break;

        case '/check':
          result = await this.cmd('check-box', await this.readBody(req));
          break;

        case '/clear':
          result = await this.cmd('clear-field', await this.readBody(req));
          break;

        case '/focus':
          result = await this.cmd('focus-element', await this.readBody(req));
          break;

        // ============ JS 执行 / 等待 ============
        case '/evaluate':
          result = await this.cmd('evaluate', await this.readBody(req));
          break;

        case '/wait-for':
          result = await this.cmd('wait-for-selector', await this.readBody(req));
          break;

        case '/wait-for-text':
          result = await this.cmd('wait-for-text', await this.readBody(req));
          break;

        case '/wait-for-url':
          result = await this.cmd('wait-for-url', await this.readBody(req));
          break;

        case '/wait-for-load':
          result = await this.cmd('wait-for-load', await this.readBody(req).catch(() => ({})));
          break;

        // ============ 截图 / PDF ============
        case '/screenshot':
          result = await this.cmd('screenshot', {
            format: url.searchParams.get('format') || 'png',
            quality: +url.searchParams.get('quality') || 80
          });
          break;

        case '/screenshot/full':
          // 插件端 guardedCommand 看门狗 25s + 内部 fallback 链最长可到 ~40s, server 超时必须 > 插件端, 否则退化环境下被提前 504
          result = await this.cmd('screenshot-full', {
            format: url.searchParams.get('format') || 'png',
            quality: +url.searchParams.get('quality') || 80
          }, 45000);
          break;

        case '/screenshot/element':
          // 元素截图插件端重试一次(2×15s+间隔), server 侧对齐
          result = await this.cmd('screenshot-element', await this.readBody(req), 35000);
          break;

        case '/snapshot':
        case '/snapshot/binary': {
          // 视觉快照: GET 用 query，POST 用 body，二者合并；/binary 或 ?binary=1 直接返回 image/* 二进制
          const isBinary = pathname.endsWith('/binary') || url.searchParams.get('binary') === '1';
          let snapParams = {};
          if (req.method === 'POST') {
            try { snapParams = await this.readBody(req); } catch { snapParams = {}; }
          }
          // query 覆盖/补充 body
          const q = (k) => url.searchParams.get(k);
          if (q('format')) snapParams.format = q('format');
          if (q('quality')) snapParams.quality = +q('quality');
          if (q('annotate') != null) snapParams.annotate = q('annotate') === '1' || q('annotate') === 'true';
          if (q('full') != null) snapParams.full = q('full') === '1' || q('full') === 'true';
          if (q('compact') != null) snapParams.compact = q('compact') !== '0' && q('compact') !== 'false';
          if (q('maxElements')) snapParams.maxElements = +q('maxElements');
          if (q('selector')) snapParams.selector = q('selector');
          if (q('fast') != null) snapParams.fast = q('fast') === '1' || q('fast') === 'true';
          if (q('speed') != null) snapParams.speed = q('speed');
          result = await this.cmd('vision-snapshot', snapParams, 25000);
          if (isBinary && result && result.dataUrl) {
            try {
              const b64 = result.dataUrl.split(',')[1] || result.dataUrl;
              const buf = Buffer.from(b64, 'base64');
              const ct = (snapParams.format === 'jpeg' || snapParams.format === 'jpg') ? 'image/jpeg' : 'image/png';
              // 元信息走 Header(截断防超限)，主图走 body，AI 仍可解析图 + 锚点
              const elsHeader = JSON.stringify(result.elements || []).slice(0, 8000);
              res.writeHead(200, {
                'Content-Type': ct,
                'Content-Length': buf.length,
                'X-Snapshot-Url': encodeURIComponent(result.url || ''),
                'X-Snapshot-Title': encodeURIComponent(result.title || ''),
                'X-Snapshot-Elements': encodeURIComponent(elsHeader),
                'X-Snapshot-Viewport': JSON.stringify(result.viewport || {}),
                'Cache-Control': 'no-store'
              });
              res.end(buf);
              // 已直接发送二进制，不再走外层 send
              return;
            } catch (e) {
              // 二进制失败回退 JSON
              result._binaryError = e.message;
            }
          }
          break;
        }

        case '/fast/snapshot': {
          // 快照快路径别名，默认 fast:true + 15s 超时
          let snapParams = { fast: true };
          if (req.method === 'POST') {
            try { Object.assign(snapParams, await this.readBody(req)); } catch {}
          }
          const q = (k) => url.searchParams.get(k);
          if (q('format')) snapParams.format = q('format');
          if (q('quality')) snapParams.quality = +q('quality');
          if (q('annotate') != null) snapParams.annotate = q('annotate') === '1' || q('annotate') === 'true';
          if (q('full') != null) snapParams.full = q('full') === '1' || q('full') === 'true';
          if (q('maxElements')) snapParams.maxElements = +q('maxElements');
          if (q('selector')) snapParams.selector = q('selector');
          result = await this.cmd('vision-snapshot', snapParams, 15000);
          break;
        }

        case '/fast/act':
        case '/act': {
          const body = await this.readBody(req);
          const { action, ...data } = body || {};
          if (!action) { result = { error: 'action is required (snapshot|click|clickText|fill|type|extract|navigate|evaluate)' }; break; }
          switch (action) {
            case 'snapshot': result = await this.cmd('vision-snapshot', { fast: true, ...data }, 15000); break;
            case 'click': result = await this.cmd('click-element', { fast: true, ...data }); break;
            case 'clickText': {
              // 视觉文本点击：snapshot 坐标优先，evaluate 兜底
              try {
                const snap = await this.cmd('vision-snapshot', { maxElements: 50, fast: true }, 8000);
                const hit = snap?.elements?.find(e => (e.text || '').includes(data.text) || (e.name || '').includes(data.text));
                if (hit && hit.center) {
                  result = await this.cmd('mouse', { type: 'click', x: hit.center.x, y: hit.center.y, fast: true });
                  if (result && !result.error) { result.method = 'fast-snapshot-text'; break; }
                }
              } catch {}
              const code = `return (()=>{ const els=[...document.querySelectorAll('a, button, [role="button"]')]; const t=${JSON.stringify(data.text||'')}; const hit=els.find(e=> (e.innerText||e.textContent||'').includes(t)); if(hit){ hit.click(); return {tag:hit.tagName, text:hit.innerText?.slice(0,50)} } return null; })()`;
              result = await this.cmd('evaluate', { code });
              break;
            }
            case 'fill': result = await this.cmd('fill-form', data); break;
            case 'type': result = await this.cmd('type-text', data); break;
            case 'extract': result = await this.cmd('query-many', { selectors: data.selectors || data.selectors }); break;
            case 'navigate': result = await this.cmd('open-url', { url: data.url, current: !!data.current }); break;
            case 'evaluate': result = await this.cmd('evaluate', data); break;
            default: result = { error: `unknown action: ${action}` }; break;
          }
          break;
        }

        case '/fast/click': {
          const body = await this.readBody(req);
          // fast/click 复用 act 逻辑
          result = await this.cmd('click-element', { fast: true, ...body });
          break;
        }

        case '/fast/fill': {
          const body = await this.readBody(req);
          result = await this.cmd('fill-form', body);
          break;
        }

        case '/pdf': {
          const pdfBody = await this.readBody(req);
          result = await this.cmd('print-to-pdf', {
            format: url.searchParams.get('format') || pdfBody.format || 'A4',
            landscape: pdfBody.landscape === true,
            printBackground: pdfBody.printBackground !== false,
            ...(pdfBody.margin ? { margin: pdfBody.margin } : {})
          });
          break;
        }

        case '/upload':
          result = await this.cmd('upload-file', await this.readBody(req));
          break;

        // ============ 高亮 ============
        case '/highlight':
          result = await this.cmd('highlight-elements', await this.readBody(req));
          break;

        case '/highlight/clear':
          result = await this.cmd('clear-highlights', {});
          break;

        // ============ 弹窗 ============
        case '/dialog':
          result = await this.cmd('dialog', await this.readBody(req));
          break;

        case '/dialogs':
          result = await this.cmd('get-dialogs', {});
          break;

        // ============ 环境模拟 ============
        case '/auto-dark':
          result = await this.cmd('auto-dark-mode', await this.readBody(req));
          break;

        case '/js':
          result = await this.cmd('set-script-disabled', await this.readBody(req));
          break;

        case '/hardware-concurrency':
          result = await this.cmd('set-hardware-concurrency', await this.readBody(req));
          break;

        // ============ Cookie ============
        case '/cookies':
          result = await this.cmd('get-cookies', {});
          break;

        case '/cookie':
          result = await this.cmd('set-cookie', await this.readBody(req));
          break;

        case '/cookie/remove':
          result = await this.cmd('remove-cookie', await this.readBody(req));
          break;

        // ============ Storage ============
        case '/storage':
          if (req.method === 'POST') {
            result = await this.cmd('set-storage', await this.readBody(req));
          } else {
            result = await this.cmd('get-storage', { type: url.searchParams.get('type') || 'local' });
          }
          break;

        case '/storage/remove':
          result = await this.cmd('remove-storage', await this.readBody(req));
          break;

        case '/storage/clear':
          result = await this.cmd('clear-storage', await this.readBody(req));
          break;

        // ============ 网络 ============
        case '/network': {
          const filter = url.searchParams.get('filter');
          const tabId = url.searchParams.get('tabId');
          const type = url.searchParams.get('type');
          const limit = parseInt(url.searchParams.get('limit')) || 500;
          let logs = this.networkLogs;
          if (tabId) logs = logs.filter(l => String(l.tabId) === String(tabId));
          if (filter) logs = logs.filter(l => (l.url || '').includes(filter));
          if (type) logs = logs.filter(l => l.type === type);
          result = logs.slice(-limit);
          break;
        }

        case '/network/clear':
          this.networkLogs = [];
          await this.cmd('clear-network-logs', {}).catch(() => {});
          result = { success: true };
          break;

        case '/network/response':
          result = await this.cmd('get-response-body', await this.readBody(req));
          break;

        case '/network/block':
          result = await this.cmd('block-urls', await this.readBody(req));
          break;

        case '/network/unblock':
          result = await this.cmd('unblock-urls', {});
          break;

        case '/network/conditions':
          result = await this.cmd('set-network-conditions', await this.readBody(req));
          break;

        case '/network/conditions/reset':
          result = await this.cmd('reset-network-conditions', {});
          break;

        case '/network/disable-cache':
          result = await this.cmd('set-cache-disabled', await this.readBody(req));
          break;

        case '/bypass-csp':
          result = await this.cmd('bypass-csp', await this.readBody(req));
          break;

        // ============ 性能 ============
        case '/performance':
          result = await this.cmd('get-performance');
          break;

        case '/vitals':
          result = await this.cmd('get-web-vitals', {}, 15000);
          break;

        case '/resources':
          result = await this.cmd('get-resources');
          break;

        case '/cpu':
          result = await this.cmd('set-cpu-throttling', await this.readBody(req));
          break;

        // ============ 模拟 ============
        case '/device':
          result = await this.cmd('simulate-device', await this.readBody(req));
          break;

        case '/device/clear':
          result = await this.cmd('clear-device', {});
          break;

        // 一键恢复全部模拟/策略影响(任务结束/中断后清理, 不干扰用户浏览)
        case '/reset-all':
          result = await this.cmd('reset-all-simulations', {});
          break;

        case '/media':
          result = await this.cmd('emulate-media', await this.readBody(req));
          break;

        case '/geo':
          result = await this.cmd('set-geolocation', await this.readBody(req));
          break;

        case '/locale':
          result = await this.cmd('set-locale', await this.readBody(req));
          break;

        case '/timezone':
          result = await this.cmd('set-timezone', await this.readBody(req));
          break;

        // ============ 检查 ============
        case '/security':
          result = await this.cmd('security-check');
          break;

        case '/a11y':
          result = await this.cmd('a11y-check');
          break;

        case '/seo':
          result = await this.cmd('seo-check');
          break;

        // ============ 控制台 / DOM 变化 ============
        case '/console': {
          const tabId = url.searchParams.get('tabId');
          const limit = parseInt(url.searchParams.get('limit')) || 500;
          if (tabId) {
            result = await this.cmd('get-console-logs', { tabId, limit });
          } else if (this.consoleLogs.length > 0) {
            result = this.consoleLogs.slice(-limit);
          } else {
            result = await this.cmd('get-console-logs', { limit });
          }
          break;
        }

        case '/console/clear':
          this.consoleLogs = [];
          await this.cmd('clear-console-logs', {}).catch(() => {});
          result = { success: true };
          break;

        case '/dom-changes':
          result = await this.cmd('get-dom-changes', {});
          break;

        case '/dom-changes/clear':
          result = await this.cmd('clear-dom-changes', {});
          break;

        // ============ 批量分析 / 监控 ============
        case '/full': {
          // 3s 缓存, ?fresh=1 绕过
          const fullCacheKey = `full:${this.resolveCacheTab()}`;
          const fullCached = fresh ? null : this.getCache(fullCacheKey);
          if (fullCached) { result = fullCached; break; }
          const [dom, performance, vitals, security, a11y, seo, pageInfo] = await Promise.all([
            this.cmd('get-dom').catch(e => ({ error: e.message })),
            this.cmd('get-performance').catch(e => ({ error: e.message })),
            this.cmd('get-web-vitals', {}, 15000).catch(e => ({ error: e.message })),
            this.cmd('security-check').catch(e => ({ error: e.message })),
            this.cmd('a11y-check').catch(e => ({ error: e.message })),
            this.cmd('seo-check').catch(e => ({ error: e.message })),
            this.cmd('get-page-info').catch(e => ({ error: e.message }))
          ]);
          result = { dom, performance, vitals, security, a11y, seo, pageInfo };
          this.setCache(fullCacheKey, result, 3000);
          break;
        }

        case '/analyze-all':
          result = await this.analyzeAllTabs();
          break;

        case '/monitor':
          result = this.startMonitoring(await this.readBody(req));
          break;

        case '/monitor/stop':
          result = this.stopMonitoring();
          break;

        case '/monitor/status':
          result = this.getMonitorStatus();
          break;

        // ============ 调试授权 ============
        case '/debug/attach-all':
          result = await this.cmd('cdp-attach-all');
          break;

        case '/debug/detach-all':
          result = await this.cmd('cdp-detach-all', {});
          break;

        case '/debug/info':
          result = await this.cmd('get-browser-info');
          break;

        case '/debug/cdp-status':
          result = await this.cmd('get-cdp-status', {});
          break;

        // ============ 审计引擎 ============
        case '/audit': {
          result = await this.runAudit(await this.readBody(req).catch(() => ({})));
          break;
        }

        case '/history': {
          const filterUrl = url.searchParams.get('url');
          const limit = parseInt(url.searchParams.get('limit')) || 10;
          result = auditReport.readHistory(filterUrl, limit);
          break;
        }

        case '/audit/run': {
          const body = await this.readBody(req);
          const { urls = [], budget, settleMs } = body;
          if (!Array.isArray(urls) || urls.length === 0) {
            result = { error: 'urls (array) is required' };
          } else {
            // 捕获请求级上下文(含会话约束), 队列内所有导航/采集在原 tab 内执行
            const ctx = this.als.getStore() || null;
            const id = await this.auditQueue.runTask({
              urls, budget, settleMs, ctx,
              onAudit: (url, data) => this.buildAudit(data, budget, url)
            });
            result = { success: true, taskId: id };
          }
          break;
        }

        default:
          return send(404, { error: `Unknown endpoint: ${pathname}`, hint: 'POST 端点需要 JSON body' });
      }
      this.setCachedResponse(pathname, result);
      send(200, result);
    } catch (e) {
      // 插件命令超时: 结构化错误(可被调用方识别为弹窗挂起等场景)
      if (e.code === 'PLUGIN_TIMEOUT') {
        send(504, {
          error: e.message,
          hint: 'GET /dialogs 查看是否有挂起弹窗; POST /dialog {auto:true} 可恢复自动应答',
          commandType: e.commandType
        });
      } else {
        send(e.statusCode || 500, { error: e.message });
      }
    }
    });
  }

  /**
   * 解析缓存用的目标 tab 标识: 会话内未显式 tabId 时解析为会话的唯一标签页,
   * 避免所有会话的只读缓存落到 'active' 同一键(会串会, 表现为"读到别的会话的页面")
   */
  resolveCacheTab() {
    const ctx = this.als.getStore() || {};
    if (ctx.tabId != null) return ctx.tabId;
    if (ctx.sessionId != null) {
      const sess = this.sessions.get(String(ctx.sessionId));
      if (sess && sess.tabIds.size === 1) return [...sess.tabIds][0];
    }
    return 'active';
  }

  /** 只读端点缓存读取(键含 tabId, 从 ALS 取请求级值); ?ttl=<ms> 覆盖默认缓存时长(0=禁用缓存) */
  getCachedResponse(pathname, fresh) {
    if (fresh) return null;
    const ctx = this.als.getStore() || {};
    const ttlOverride = ctx.ttl != null ? ctx.ttl : null;
    if (ttlOverride === 0) return null;
    const ttl = ttlOverride != null ? ttlOverride : this.cacheTtl[pathname];
    if (!ttl) return null;
    return this.getCache(`${pathname}:${this.resolveCacheTab()}`);
  }

  setCachedResponse(pathname, result) {
    const ctx = this.als.getStore() || {};
    const ttlOverride = ctx.ttl != null ? ctx.ttl : null;
    if (ttlOverride === 0) return;
    const ttl = ttlOverride != null ? ttlOverride : this.cacheTtl[pathname];
    if (!ttl) return;
    // 出错不缓存
    if (result == null) return;
    const isErr = typeof result === 'object'
      ? (result.error !== undefined || Object.values(result).some(v => v && typeof v === 'object' && v.error))
      : false;
    if (isErr) return;
    this.setCache(`${pathname}:${this.resolveCacheTab()}`, result, ttl);
  }

  // ============ 审计引擎 ============

  /** 执行一次审计: 可选先导航到 url, 采集 → 评分 → 洞察 → 机会 → 预算 */
  async runAudit({ url, current, budget, format = 'json', save = false }) {
    const t0 = Date.now();
    if (url && current !== false) {
      await this.cmd('open-url', { url, current: true }).catch(() => {});
      await this.cmd('wait-for-load', { timeout: 20000 }).catch(() => {});
    }
    // 无论是否导航, 统一等待 vitals 缓冲: 刚导航/当前页未稳定时 LCP/TTFB 缺失会导致预算违规检测空跑
    await new Promise(r => setTimeout(r, 2500));
    // 60s 超时与 auditQueue 对齐(默认 20s 在夸克慢环境下会掐断页面内 30s 采集)
    let raw = await this.cmd('audit-collect', {}, 60000);
    if (!raw.success) {
      // 采集失败(CDP 忙/超时): 自动重试一次
      raw = await this.cmd('audit-collect', {}, 60000);
    }
    if (!raw.success) return raw;
    const audit = this.buildAudit(raw.audit, budget, url);
    if (save) auditReport.saveHistory(audit);
    const out = { success: true, ...audit, durationMs: Date.now() - t0 };
    if (format === 'md') out.markdown = auditReport.renderMd(audit);
    if (format === 'html') out.html = auditReport.renderHtml(audit);
    return out;
  }

  /** 原始采集数据 → 完整审计结果 */
  buildAudit(data, budget, url) {
    const scores = auditEngine.score(data);
    const insights = auditEngine.insights(data, scores);
    const opportunities = auditEngine.opportunities(data);
    const metrics = auditEngine.metrics(data);
    const perfRules = scores.categories.find(c => c.id === 'performance').rules;
    metrics._lcp = perfRules.find(r => r.id === 'lcp').status;
    const audit = {
      meta: {
        url: url || data.url || 'current-tab',
        title: (data.seo && data.seo.title) || null,
        collectedAt: data.collectedAt || Date.now(),
        collectMs: data.collectMs || 0,
        framework: data.framework || {}
      },
      scores,
      insights,
      opportunities,
      metrics,
      budget: auditEngine.checkBudget(data, budget),
      ai: auditEngine.aiReport(data, scores, insights, opportunities, budget),
      raw: data
    };
    return audit;
  }

  // ============ 批量分析 ============

  /** 简单并发限流器: 限制同时进行中的 CDP 采集任务数, 防止大量 tab 瞬时打满插件通道
   *  (monitor/analyze-all 在 tab 多时并发 get-performance 等慢采集会相互拖慢) */
  async limitedParallel(items, worker, limit = 3) {
    const results = new Array(items.length);
    let next = 0;
    const run = async () => {
      while (next < items.length) {
        const i = next++;
        try { results[i] = await worker(items[i], i); }
        catch (e) { results[i] = { error: e.message }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  async analyzeAllTabs() {
    const tabs = await this.cmd('get-tabs');
    if (!Array.isArray(tabs) || tabs.length === 0) return { error: 'No tabs found' };
    const validTabs = tabs.filter(t => t.url && !t.url.startsWith('chrome://'));

    // 标签页并行分析(限流 3, 避免 CDP 通道打满)
    const results = await this.limitedParallel(validTabs, async (tab) => {
      try {
        const [dom, performance, security, seo] = await Promise.all([
          this.cmd('get-dom', { tabId: tab.id }).catch(e => ({ error: e.message })),
          this.cmd('get-performance', { tabId: tab.id }).catch(e => ({ error: e.message })),
          this.cmd('security-check', { tabId: tab.id }).catch(e => ({ error: e.message })),
          this.cmd('seo-check', { tabId: tab.id }).catch(e => ({ error: e.message }))
        ]);
        return {
          tab: { id: tab.id, url: tab.url, title: tab.title, active: tab.active },
          dom, performance, security, seo,
          summary: {
            domElements: dom?.elements || 0,
            loadTime: performance?.navigation?.loadComplete || 0,
            securityIssues: (Array.isArray(security) ? security.filter(s => !s.pass).length : 0),
            seoScore: (Array.isArray(seo) ? seo.filter(s => s.pass).length : 0)
          }
        };
      } catch (e) {
        return { tab: { id: tab.id, url: tab.url, title: tab.title }, error: e.message };
      }
    });

    return { totalTabs: tabs.length, analyzedTabs: results.length, results };
  }

  // ============ 监控 ============

  startMonitoring(options = {}) {
    const interval = options.interval || 5000;
    const duration = options.duration || 60000;

    if (this.monitorInterval) clearInterval(this.monitorInterval);

    this.monitorData = [];
    this.monitorStartTime = Date.now();

    this.monitorInterval = setInterval(async () => {
      try {
        const tabs = await this.cmd('get-tabs');
        const validTabs = (tabs || []).filter(t => t.url && !t.url.startsWith('chrome://'));
        // 并行采集(限流 3, 防多 tab 时 CDP 通道打满)
        const samples = await this.limitedParallel(validTabs, async (tab) => {
          const performance = await this.cmd('get-performance', { tabId: tab.id }).catch(() => null);
          if (!performance) return null;
          return {
            timestamp: Date.now(), tabId: tab.id, url: tab.url, title: tab.title, performance
          };
        }, 3);
        samples.filter(Boolean).forEach(s => this.monitorData.push(s));
      } catch (e) {
        console.error('[ArkWeb] 监控采集失败:', e.message);
      }
    }, interval);

    setTimeout(() => {
      if (this.monitorInterval) this.stopMonitoring();
    }, duration);

    return { success: true, message: `监控已启动: 间隔 ${interval}ms, 持续 ${duration / 1000}s` };
  }

  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    return { success: true, dataPoints: this.monitorData?.length || 0, data: this.monitorData || [] };
  }

  getMonitorStatus() {
    return {
      active: !!this.monitorInterval,
      dataPoints: this.monitorData?.length || 0,
      uptime: this.monitorStartTime ? Date.now() - this.monitorStartTime : 0
    };
  }

  // ============ 工具 ============

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', chunk => {
        chunks.push(chunk);
        total += chunk.length;
        if (total > 10 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Body too large'));
        }
      });
      req.on('end', () => {
        if (total === 0) { resolve({}); return; }
        // 显式 UTF-8 解码(避免隐式 toString 依赖默认编码)
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(text);
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch (e) {
          // 不再静默吞掉坏 JSON: 返回 400 结构化错误, 便于客户端(如 PowerShell 中文损坏)定位
          const err = new Error(`无效 JSON body: ${e.message} | 收到(前120字符): ${text.slice(0, 120)}`);
          err.statusCode = 400;
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }
}

module.exports = ArkWebServer;

if (require.main === module) {
  // 兜底: 未处理 rejection 只记日志, 不允许 Node 24 默认的 crash 退出
  process.on('unhandledRejection', (reason) => {
    console.error('[ArkWeb] 未处理的 Promise rejection(已拦截, 服务器继续运行):', (reason && reason.message) || reason);
  });
  // 兜底: 未捕获异常(如双开时 WS 端口被占的异步 EADDRINUSE)不静默退出
  process.on('uncaughtException', (err) => {
    console.error('[ArkWeb] 未捕获异常(已拦截, 服务器继续运行):', (err && (err.stack || err.message)) || err);
  });
  new ArkWebServer({
    port: parseInt(process.env.BRIDGE_PORT || '9333'),
    wsPort: parseInt(process.env.BRIDGE_WS_PORT || '9334')
  });
}
