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
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const auditEngine = require('./audit');
const auditReport = require('./audit-report');
const SemanticLayer = require('./semantic');
const brain = require('./brain');
const { createRegistry } = require('./tool-registry');
const { CdpCore } = require('./browser-core');
const { TaskRunner } = require('./task-runner');
const { Router } = require('./core/router');
const { createHttpShell } = require('./core/http-shell');
const ENDPOINT_DOCS = require('./core/endpoint-docs');
const capabilities = require('./capabilities');

// 令牌文件: 首次启动自动生成并落盘(权限 0600), 之后固定复用 —— CLI/脚本据此自动带上 X-Ark-Token
// 目录里可能同时存在多份项目副本(开发仓库 / 技能安装目录), 各自生成令牌会导致"服务端与 CLI 令牌不一致"的 401。
// 因此令牌默认落在用户级共享路径, 所有副本读同一个文件; 旧位置的 server/.ark-token 仍兼容读取。
const SHARED_TOKEN_DIR = path.join(os.homedir(), '.ark-web');
const SHARED_TOKEN_FILE = path.join(SHARED_TOKEN_DIR, 'token');
const LEGACY_TOKEN_FILE = path.join(__dirname, '.ark-token');
const TOKEN_FILE = SHARED_TOKEN_FILE;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:', 'safari-web-extension:']);

class ArkWebServer {
  constructor(options = {}) {
    this.port = options.port || 9333;
    this.wsPort = options.wsPort || 9334;
    // ============ 安全基线 ============
    // 1) 默认只绑回环地址(127.0.0.1): 局域网其他设备无法访问, 端口不会暴露给外部
    // 2) 默认启用令牌鉴权(X-Ark-Token): 阻止本机其他进程 / 任意网页(CSRF / DNS rebinding) 操控浏览器
    // 3) Host / Origin 双重校验: 仅接受回环 Host 与本机页面或扩展页面来源
    this.host = options.host || process.env.BRIDGE_HOST || '127.0.0.1';
    const auth = this.resolveAuth(options.token);
    this.authToken = auth.token;
    this.authSource = auth.source;
    this.authTokenFile = auth.tokenFile || null;
    // WS 侧令牌默认复用 HTTP 鉴权令牌；ARK_WS_TOKEN / ARK_TOKEN 可单独覆盖
    this.wsExpectedToken = process.env.ARK_WS_TOKEN || process.env.ARK_TOKEN || this.authToken;
    this.wsTokenRequired = !!this.wsExpectedToken;
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
    this.writeTypes = new Set(['click-element','hover-element','double-click','right-click','drag-element','mouse','click-ref','hover-ref','fill-ref','zoom-shot','scroll-page','scroll-into-view','scroll-by','simulate-key','type-text','fill-form','select-option','check-box','clear-field','focus-element','open-url','reload','back','forward','activate-tab','close-tab','highlight-elements','clear-highlights','evaluate','set-storage','remove-storage','clear-storage','set-cookie','remove-cookie','upload-file']);
    // Server keep-alive 调优(v8)
    // snapshot 缓存 400ms, 高频连续 snapshot 命中 <5ms
    this.snapshotTtl = 400;
    // 语义层: 页面消化 + 检索 + 锚点定位/动作执行(按标签页隔离, 索引常驻内存)
    this.semantic = new SemanticLayer(this);
    // CDP 直连内核: 直连 BrowserOS 自带的调试端口(默认 9110), 提供不依赖扩展的完整控制通道
    // (扩展通道受 API 白名单裁剪、且受扩展生命周期影响; 内核通道能力面 = 完整 CDP 协议)
    // 必须先于工具注册表创建：风险门禁要靠内核读元素文本（不能依赖扩展通道）
    this.cdp = new CdpCore({ port: +(process.env.ARK_CDP_PORT || 9110) });
    // 工具插件注册表: 能力以插件形式注册(schema + 风险等级 + 处理器), 供大脑按需调用/裁剪
    this.toolRegistry = createRegistry({
      cmd: (type, data, timeout) => this.cmd(type, data, timeout),
      semantic: this.semantic,
      rawApi: (method, path, body) => this.callSelf(method, path, body),
      // 内核引用供风险门禁读元素文本：门禁不能依赖扩展通道（扩展不可用时门禁会失明）
      core: this.cdp,
      // 技能系统：skill 工具按需加载正文（目录与正文分离）
      skills: require('./agent/skills')
    });
    // 后置依赖：子代理委派需要 loop 与模型（loop 又依赖注册表，构成闭环，由 setDeps 解开）
    this.toolRegistry.setDeps({
      loop: require('./agent/loop'),
      registryRef: this.toolRegistry,
      model: { chat: brain.chat, chatStream: brain.chatStream }
    });
    // 自调用令牌: 供工具插件触达任意原生端点(审计/检查/聚合等), 与 CLI 共用同一令牌文件
    try { this._selfToken = fs.readFileSync(SHARED_TOKEN_FILE, 'utf8').trim(); }
    catch (e) { this._selfToken = process.env.ARK_TOKEN || ''; }
    // Agent 任务运行时: Agent 是主体, 浏览器是它的能力 —— 任务可后台执行、并行、取消、回放
    this.__brain = brain;   // 供 TaskRunner 调用推理循环
    this.tasks = new TaskRunner(this, { maxConcurrent: +(process.env.ARK_MAX_TASKS || 2) });

    // ============ 能力组装（架构分层）============
    // 路由不再写在本文件的 switch 里，而是由 capabilities/* 各自声明、此处统一注册。
    // 传输层（鉴权/CORS/缓存/响应）在 core/http-shell.js，本类只做组合根。
    this.router = new Router();
    for (const cap of capabilities) this.router.use(cap);
    // 工具也纳入同一份清单：/capabilities 因此是"服务能做什么"的唯一出口
    this.router.setToolSource(() => this.toolRegistry.manifest());
    this.handleHTTPRequest = createHttpShell(this, this.router, {
      authToken: this.authToken,
      authTokenFile: this.authTokenFile,
      tokenFile: TOKEN_FILE,
      port: this.port
    });

    this.init();
  }

  // ============ 初始化 ============

  init() {
    this.wss = new WebSocket.Server({ port: this.wsPort, host: this.host }, () => {
      console.log(`[ArkWeb] WebSocket 服务器: ws://${this.host}:${this.wsPort}`);
    });

    this.wss.on('connection', (ws, req) => {
      // 来源校验（先于令牌）：挡「任意网页直连 ws://127.0.0.1:9334 操控浏览器」
      const origin = String((req && req.headers && req.headers.origin) || '');
      if (!this.isAllowedWsOrigin(origin)) {
        console.warn(`[ArkWeb] 拒绝来源不明的 WS 连接: Origin=${origin}（网页不允许直连 WS；本机脚本请不带 Origin，扩展请确认来源为 chrome-extension://）`);
        try { ws.close(4003, 'origin not allowed'); } catch { /* ignore */ }
        return;
      }
      const trustedExtension = this.isTrustedExtensionOrigin(origin);
      if (this.wsTokenRequired && !trustedExtension) {
        let provided = null;
        try { provided = new URL(req?.url || '', 'http://localhost').searchParams.get('token'); } catch { /* ignore */ }
        if (!this.tokenEquals(provided, this.wsExpectedToken)) {
          console.warn('[ArkWeb] 拒绝未授权 WS 连接(令牌不匹配)。请在插件 popup 填写当前服务端访问令牌。');
          try { ws.close(4001, 'invalid token'); } catch { /* ignore */ }
          return;
        }
      }
      console.log('[ArkWeb] 插件已连接');
      this.clients.set(ws, { connectedAt: Date.now(), version: '0.0.0', lastSeen: Date.now(), timeouts: 0, suspectUntil: 0 });
      this.connected = true;

      ws.on('message', (data) => {
        // lastSeen 用于心跳判断连接是否僵死(僵尸连接表现为 readyState=OPEN 但不再回任何消息)
        const info = this.clients.get(ws);
        if (info) info.lastSeen = Date.now();
        try {
          this.handlePluginMessage(JSON.parse(data.toString()), ws);
        } catch (e) {
          console.error('[ArkWeb] 消息解析错误:', e.message);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.connected = this.clients.size > 0;
        // 插件断开：只拒绝**属于这条连接**的在途请求（旧实现清空全局表，
        // 另一个浏览器上正在跑的长命令会被误杀并报成"插件已断开"）
        for (const [rid, entry] of [...this.pendingRequests]) {
          if (entry.ws !== ws) continue;
          clearTimeout(entry.timer);
          entry.reject(new Error('Chrome 插件已断开连接, 请检查插件状态'));
          this.pendingRequests.delete(rid);
        }
        console.log(`[ArkWeb] 插件已断开, 剩余连接: ${this.clients.size}`);
      });

      ws.on('error', (e) => console.error('[ArkWeb] WebSocket 错误:', e.message));
    });

    this.server = http.createServer((req, res) => {
      // 前置段（URL 解析、缓存、路由）出错时也必须给响应：
      // 旧实现没有兜底，畸形请求目标会让 new URL 抛错 → 该请求永久挂起（requestTimeout=0）
      const p = this.handleHTTPRequest(req, res);
      if (p && typeof p.catch === 'function') {
        p.catch((e) => {
          console.error('[ArkWeb] 请求处理异常:', (e && e.message) || e);
          try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'internal-error', message: String((e && e.message) || e).slice(0, 200) })); } } catch (x) { /* ignore */ }
        });
      }
    });
    // v8.1: keep-alive 与 client 8s 对齐，避免服务端 65s 空挂导致 ECONNRESET
    this.server.keepAliveTimeout = 10000;
    this.server.headersTimeout = 12000;
    this.server.maxHeadersCount = 100;
    this.server.requestTimeout = 0;
    this.server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error('[ArkWeb] 启动失败：端口 ' + this.port + ' 已被占用（可能已有一个 Ark 服务在运行）。如需重启请先结束旧进程。');
        process.exit(1);
      }
      console.error('[ArkWeb] HTTP 服务器错误:', (err && err.message) || err);
    });
    this.server.listen(this.port, this.host, () => {
      console.log(`[ArkWeb] HTTP 服务器: http://${this.host}:${this.port}  (仅回环地址, 局域网不可达)`);
      console.log('');
      console.log('[ArkWeb] 快速开始:');
      console.log('  1. Chrome 加载 extension/ 目录的插件');
      console.log('  2. 打开插件 popup, 点击「启用调试」(Chrome 136+ 必须)');
      console.log('  3. 现在可以由 AI 或 curl 调用 API');
      console.log('');
      this.printSecurityBanner();
      console.log(`[ArkWeb] 端点列表 (${this.listEndpoints().length} 个, 能力域 ${this.router.stats().capabilities} 个):`);
      this.listEndpoints().forEach(e => console.log(`  ${e}`));
      this.reportEndpointDrift();
    });

    // 心跳(15s): 顺带清理僵死连接(僵尸连接会让后续命令全部超时, 是"服务在线但用不了"的头号原因)
    setInterval(() => {
      const now = Date.now();
      for (const [ws, info] of [...this.clients]) {
        if (ws.readyState !== WebSocket.OPEN) { this.clients.delete(ws); continue; }
        const idle = now - (info.lastSeen || info.connectedAt || now);
        if (idle > 120000) {
          console.warn(`[ArkWeb] 清理僵死连接(静默 ${Math.round(idle / 1000)}s, 版本 ${info.version || '?'})`);
          try { ws.terminate(); } catch { /* ignore */ }
          this.clients.delete(ws);
          this.connected = this.clients.size > 0;
          continue;
        }
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
      }
    }, 15000);
  }

  /**
   * 端点清单 —— 由"注册表（权威）+ 说明文档（补充参数）"合成，并双向比对。
   *
   * 为什么不是删掉这份说明：说明里有每个端点的参数与用途，路由本身不携带这些信息。
   * 为什么不再会漂移：此处以注册表为准，逐条比对——
   *   · 注册了但没有说明 → 标注 [未文档化]
   *   · 有说明但没有注册 → 标注 [已失效]
   * 漂移从"静默不一致"变成启动时可见的告警。
   */
  listEndpoints() {
    const docs = new Map();
    for (const s of ENDPOINT_DOCS) {
      const m = /^([A-Z]+)\s+(\/\S+?)(?:\s|\?|$)/.exec(s);
      if (!m) continue;
      // 说明里用 <id> 写占位符，路由用 :id —— 归一化后再比对，避免把写法差异误报为漂移
      docs.set(m[2].replace(/<([^>]+)>/g, ':$1'), s);
    }
    const registered = this.router.routes();
    const seen = new Set();
    const out = [];
    for (const r of registered) {
      seen.add(r.path);
      out.push(docs.get(r.path) || `ANY  ${r.path}   [未文档化 · 能力: ${r.cap}]`);
    }
    this.endpointDrift = {
      undocumented: registered.filter(r => !docs.has(r.path)).map(r => r.path),
      stale: [...docs.keys()].filter(p => !seen.has(p))
    };
    return out;
  }

  /** 启动时打印漂移告警（有漂移才说话，避免噪音） */
  reportEndpointDrift() {
    const d = this.endpointDrift || { undocumented: [], stale: [] };
    if (d.undocumented.length) console.log(`[ArkWeb] 注意: ${d.undocumented.length} 个端点缺少说明 → ${d.undocumented.join(', ')}`);
    if (d.stale.length) console.log(`[ArkWeb] 注意: ${d.stale.length} 条说明已失效(无对应路由) → ${d.stale.join(', ')}`);
  }

  // ============ 插件消息 ============

  handlePluginMessage(message, ws) {
    const { type, data, id } = message;

    switch (type) {
      case 'register': {
        console.log('[ArkWeb] 插件注册:', JSON.stringify(data));
        // 只更新「本条消息来源连接」自身的信息。
        // 注意：早期实现遍历所有连接写入，导致每个连接的 version 被覆盖成"最后注册的插件版本"，
        // 多浏览器共存时版本排序全部平局 → 命令总是发给最早注册的连接，无法按版本定向。
        const regInfo = this.clients.get(ws);
        if (regInfo) {
          regInfo.version = data?.version || regInfo.version;
          regInfo.browser = data?.browser || regInfo.browser;
          regInfo.extId = data?.extId || regInfo.extId;
          // 连接名的优先级：扩展自己给的 > (ID,内核) 查表 > 内核名
          regInfo.label = data?.label || this.browserLabelOf(regInfo.extId, regInfo.browser) || regInfo.label || regInfo.browser;
          regInfo.registeredAt = data?.timestamp || regInfo.registeredAt;
          // 代码指纹：磁盘上的 extension/background.js 与浏览器里实际运行的是否一致
          if (data?.build) {
            const want = this.expectedBuildHash();
            regInfo.build = data.build;
            regInfo.stale = !!(want && data.build !== want);
            if (regInfo.stale && !this._staleWarned) {
              this._staleWarned = true;
              console.warn('[ArkWeb] 注意: 浏览器里运行的扩展代码与磁盘不一致（插件 ' + data.build + ' vs 磁盘 ' + want + '）——'
                + '常见原因是 --load-extension 启动方式下服务工作线程脚本被缓存。'
                + '处理: 关闭该浏览器后删除其 profile 下的 "Service Worker" 目录再启动，或在扩展管理页重载该扩展。');
            }
          }
        }
        // 单独记一份最近注册信息: /status 用它判断"浏览器里跑的是哪版插件代码"
        this.lastRegistration = {
          version: data?.version || null,
          browser: data?.browser || null,
          label: regInfo?.label || data?.label || null,
          extId: data?.extId || null,
          registeredAt: data?.timestamp || null
        };
        break;
      }

      case 'response':
        if (id && this.pendingRequests.has(id)) {
          const entry = this.pendingRequests.get(id);
          // 归属校验：只接受"发出这条请求的那个连接"的应答，避免多浏览器下串答/伪造
          if (entry.ws && entry.ws !== ws) {
            console.warn('[ArkWeb] 忽略来自其他连接的应答 id=' + id);
            break;
          }
          clearTimeout(entry.timer);
          entry.resolve(data);
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

      case 'ping':
        // 插件心跳(每 15s): 视为存活信号, 静默回 pong, 不打印日志
        try { ws?.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
        break;

      case 'pong':
        break;

      default:
        console.log('[ArkWeb] 未知消息类型:', type);
    }
  }

  /** 扩展 ID → 浏览器连接名 的映射（由 scripts/label-browsers.js 生成，5 秒缓存）
   *
   *  为什么要这张表：多浏览器共存时得知道"哪个连接是谁"。UA 认不出 BrowserOS（与 Chrome 同串），
   *  在扩展里运行时探测又受服务线程启动时序影响。而扩展 ID 对同一份解压目录是确定的，
   *  于是改为"扩展上报 ID、服务端查表"，稳定且可离线生成。 */
  labelMap() {
    const now = Date.now();
    if (!this._labelMap || now - (this._labelMapAt || 0) > 5000) {
      try {
        this._labelMap = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ark-web', 'browser-labels.json'), 'utf8'));
      } catch (e) { this._labelMap = {}; }
      this._labelMapAt = now;
    }
    return this._labelMap || {};
  }

  browserLabelOf(extId, kernel) {
    if (!extId) return null;
    const map = this.labelMap();
    return map[String(extId) + '|' + String(kernel || '')] || map[String(extId)] || null;
  }

  isTrustedExtensionOrigin(origin) {
    if (!origin) return false;
    try {
      const u = new URL(origin);
      if (!EXTENSION_PROTOCOLS.has(u.protocol)) return false;
      const id = u.hostname || u.pathname.replace(/^\/+/, '');
      return Object.keys(this.labelMap()).some((key) => key === id || key.startsWith(id + '|'));
    } catch {
      return false;
    }
  }

  /** 磁盘上 extension/background.js 的指纹前 8 位（按 mtime 缓存），与插件上报的 build 比对 */
  expectedBuildHash() {
    try {
      const f = path.join(__dirname, '..', 'extension', 'background.js');
      const st = fs.statSync(f);
      if (this._buildHash && this._buildHash.mtimeMs === st.mtimeMs) return this._buildHash.hash;
      const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 8);
      this._buildHash = { mtimeMs: st.mtimeMs, hash: h };
      return h;
    } catch (e) { return null; }
  }

  /** 心跳间隔是 15s，"静默超过 45s"即可视为该连接已死（浏览器被关掉时 socket 未必立刻收到 close）。
   *
   *  为什么需要它：浏览器进程被强杀/崩溃后，WS 可能保持 OPEN 一段时间 —— 期间
   *  /status 会报"已连接"、面板自检会说"一切正常"，而命令全部超时。健康状态必须
   *  按"最近有没有真的说过话"算，不能只看 socket 存在。 */
  liveClients(maxIdleMs) {
    const max = maxIdleMs || 45000;
    const now = Date.now();
    return [...this.clients.values()].filter((i) => now - (i.lastSeen || i.connectedAt || 0) < max);
  }

  /** 向插件发送命令。
   *
   *  多浏览器同时连接时的挑选顺序（历史教训：曾用版本号高低当唯一信号，于是有人把某个
   *  副本的版本人为抬到 2.9.4 只为了让命令优先发给它 —— 用版本号表达路由意图是错的）：
   *    1) 明确指定（?browser= / X-Ark-Browser 头 / opt.prefer）—— 指定了就必须匹配，否则报错
   *    2) 环境默认偏好 ARK_PREFER_BROWSER（按连接标签或内核名做子串匹配）
   *    3) 健康连接优先（跳过近期超时的可疑连接）
   *    4) 最近有活动者优先（用户真正在用的那个浏览器）
   *    5) 版本号只作为最后的平局裁决
   */
  sendToPlugin(message, timeout = 20000, opt) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const cmpVer = (a, b) => String(a || '0').replace(/-.*$/, '')
        .localeCompare(String(b || '0').replace(/-.*$/, ''), undefined, { numeric: true });
      const ctx = this.als ? (this.als.getStore() || {}) : {};
      const prefer = (opt && opt.prefer) || ctx.browser || process.env.ARK_PREFER_BROWSER || '';
      const matches = (info) => {
        if (!prefer) return true;
        const p = String(prefer).toLowerCase();
        return String(info.label || '').toLowerCase().includes(p) || String(info.browser || '').toLowerCase().includes(p);
      };
      const all = [...this.clients.entries()].filter(([ws]) => ws.readyState === WebSocket.OPEN);
      let pool = all;
      if (prefer) {
        const hit = all.filter(([, info]) => matches(info));
        if (!hit.length) {
          const avail = all.map(([, i]) => (i.label || i.browser || '未知') + '(v' + (i.version || '?') + ')').join(', ');
          reject(new Error(`指定的浏览器 "${prefer}" 未连接。当前连接: ${avail || '无'}。检查该浏览器的 Ark 插件是否已加载并连接，或用 ?browser= 指定其中一个。`));
          return;
        }
        pool = hit;
      }
      const candidates = pool
        .sort((a, b) => {
          // 0) 死连接排最后：静默超过心跳周期的连接（浏览器已退出但 socket 还在）不该被优先尝试
          const da = now - (a[1].lastSeen || 0) > 45000 ? 1 : 0;
          const db = now - (b[1].lastSeen || 0) > 45000 ? 1 : 0;
          if (da !== db) return da - db;
          // 1) 默认倾向产品浏览器：两个浏览器都连着时，命令默认发给 BrowserOS，
          //    否则"发给谁"取决于谁刚发过心跳，行为不可预期（实测踩过：面板验证时命令偶发落到夸克）。
          //    显式 ?browser= / ARK_PREFER_BROWSER 永远优先于这个默认值（上面已过滤）。
          const pa = String(a[1].label || '').toLowerCase() === 'browseros' ? 0 : 1;
          const pb = String(b[1].label || '').toLowerCase() === 'browseros' ? 0 : 1;
          if (pa !== pb) return pa - pb;
          const sa = now < (a[1].suspectUntil || 0) ? 0 : 1;   // 近期超时的连接排到最后
          const sb = now < (b[1].suspectUntil || 0) ? 0 : 1;
          if (sa !== sb) return sb - sa;
          const la = a[1].lastSeen || 0, lb = b[1].lastSeen || 0;
          if (la !== lb) return lb - la;                        // 最近有活动者优先
          return cmpVer(b[1].version, a[1].version);
        })
        .map(([ws]) => ws);
      if (!candidates.length) {
        reject(new Error('插件未连接。请检查: 1) 浏览器已打开 2) 已加载 extension/ 目录的插件 3) 插件 popup 显示已连接并已点「启用调试」'));
        return;
      }
      // 多连接时才用"短超时探测"(8s)尽快绕过僵尸; 单连接保持完整超时, 避免误杀合法的慢命令
      const probeTimeout = candidates.length > 1 ? Math.min(timeout, 8000) : timeout;
      this._sendAttempt(candidates, 0, message, timeout, probeTimeout, resolve, reject);
    });
  }

  /** 单次发送尝试; 超时/发送失败时若还有其他连接则自动换一个重试 */
  _sendAttempt(candidates, idx, message, timeout, currentTimeout, resolve, reject) {
    const ws = candidates[idx];
    const id = ++this.requestId;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.pendingRequests.delete(id);
      const info = this.clients.get(ws);
      if (info) { info.timeouts = (info.timeouts || 0) + 1; info.suspectUntil = Date.now() + 30000; }
      // 写类命令（点击/输入/导航/批量）**不跨连接重试**：同一份命令在另一个浏览器上再执行一次
      // 会产生不可撤销的副作用（点一次提交两次）。只读命令才允许换连接重试。
      const nonIdempotent = this.writeTypes.has(message.type) || message.type === 'batch';
      if (idx + 1 < candidates.length && !nonIdempotent) {
        console.warn(`[ArkWeb] 连接 #${idx + 1} 对 ${message.type} 无响应(${currentTimeout}ms), 自动换下一个连接重试(活跃连接 ${this.clients.size} 个)`);
        return this._sendAttempt(candidates, idx + 1, message, timeout, timeout, resolve, reject);
      }
      if (nonIdempotent && idx + 1 < candidates.length) {
        console.warn(`[ArkWeb] 写类命令 ${message.type} 超时，为避免重复副作用不换连接重试`);
      }
      const e = new Error(`插件命令超时(${timeout}ms): ${message.type} — 可能原因: ①页面有模态弹窗挂起(手动模式) ②页面渲染忙/冻结 ③CDP 授权过期 ④浏览器后台休眠(可 POST /tab/activate 激活标签页, 或在插件 popup 重新连接)`);
      e.code = 'PLUGIN_TIMEOUT';
      e.commandType = message.type;
      reject(e);
    }, currentTimeout);
    this.pendingRequests.set(id, {
      ws: ws,   // 归属：断开/应答校验用（旧实现全局一张表，任一插件断开就误杀别人的在途请求）
      resolve: (d) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const info = this.clients.get(ws);
        if (info) { info.timeouts = 0; info.suspectUntil = 0; info.lastSeen = Date.now(); }
        resolve(d);
      },
      reject: (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); },
      timer
    });
    try {
      ws.send(JSON.stringify({ ...message, id }));
    } catch (e) {
      clearTimeout(timer);
      this.pendingRequests.delete(id);
      if (settled) return;
      settled = true;
      if (idx + 1 < candidates.length) return this._sendAttempt(candidates, idx + 1, message, timeout, timeout, resolve, reject);
      reject(e);
    }
  }

  // v8 per-tab 串行队列: 同 tab 保序, 跨 tab 完全并行
  _enqueue(tabId, fn) {
    const key = tabId != null ? String(tabId) : '__global__';
    const prev = this.tabQueues.get(key) || Promise.resolve();
    const cur = prev.then(() => fn());
    // 链不断裂, 错误不污染后续
    const tail = cur.catch(() => {});
    this.tabQueues.set(key, tail);
    // 队列尾结束后把自己摘掉：旧实现只写不删，tabQueues 无界增长（tab id 单调递增），
    // 而且 hasPending 因此恒真 —— 注释承诺的"快照缓存 400ms 快速路径"再也不触发。
    tail.then(() => {
      if (this.tabQueues.get(key) === tail) this.tabQueues.delete(key);
    });
    return cur;
  }
  _inflightKey(type, tabId, data) {
    // 只对幂等只读命令合并, 写操作不合并
    const ro = new Set(['get-page-info','get-dom','get-html','get-performance','get-web-vitals','get-resources','security-check','a11y-check','seo-check','get-console-logs','get-dom-changes','query-selector','query-all','query-many','element-exists','get-text','get-attr','get-value','get-cookies','get-storage','get-tabs','get-browser-info','get-cdp-status','vision-snapshot','screenshot','screenshot-full']);
    if (!ro.has(type)) return null;
    try { return `${type}:${tabId ?? 'global'}:${JSON.stringify(data||{})}`; } catch { return null; }
  }
  /** 与具体标签页无关的命令：多标签会话下也不该被"必须显式指定 tabId"拦住。
   *  外壳（http-shell 的 globalOk）早已把它们当全局命令放行，而 cmd() 这里一律抛错 ——
   *  两层判定矛盾导致 /tabs?session=X 直接 500、/monitor 显示"已启动"却永远没有数据点。 */
  static get SESSION_GLOBAL_TYPES() {
    return new Set(['get-tabs', 'get-browser-info', 'get-cdp-status', 'audit-collect', 'open-url', 'clear-cache', 'batch']);
  }

  /** 请求级 tabId（语义层索引按标签页隔离；返回 null 表示"活动标签页"） */
  _reqTabId() {
    const ctx = this.als.getStore() || {};
    return ctx.tabId != null ? ctx.tabId : null;
  }

  /** 请求级 CDP targetId（由任务运行时/任务端点注入；精确锁定目标页，不依赖扩展通道） */
  _reqTargetId() {
    const ctx = this.als.getStore() || {};
    return ctx.targetId != null ? ctx.targetId : null;
  }

  /**
   * 内部自调用：把请求转发给本机的端点处理逻辑（自动带上令牌与当前 tabId / session）。
   * 用途：工具插件用它触达任意原生端点（审计 / 检查 / 聚合 / 模拟 …），
   *       从而无需为 120+ 个端点各写一个专用工具。
   */
  async callSelf(method, path, body) {
    const ctx = this.als.getStore() || {};
    let p = String(path || '');
    if (ctx.tabId != null && p.indexOf('tabId=') < 0) {
      p += (p.indexOf('?') >= 0 ? '&' : '?') + 'tabId=' + encodeURIComponent(String(ctx.tabId));
    }
    if (ctx.sessionId != null && p.indexOf('session=') < 0) {
      p += (p.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(String(ctx.sessionId));
    }
    const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (this._selfToken) opts.headers['X-Ark-Token'] = this._selfToken;
    if (method === 'POST') opts.body = JSON.stringify(body || {});
    let res;
    try {
      res = await fetch('http://127.0.0.1:' + this.port + p, Object.assign(opts, { signal: AbortSignal.timeout(60000) }));
    } catch (e) {
      return { error: 'self-call-failed', path: p, message: String((e && e.message) || e) };
    }
    const text = await res.text();
    if (res.status === 401) return { error: 'self-call-unauthorized', path: p, hint: '令牌缺失或不匹配' };
    try { return JSON.parse(text); } catch (e) { return { status: res.status, raw: String(text).slice(0, 3000) }; }
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
        // 全局命令（列表/状态/批量等与具体标签页无关）直接放行，避免与外壳的 globalOk 判定自相矛盾
      if (BridgeServer.SESSION_GLOBAL_TYPES.has(type)) return this.sendToPlugin({ type, data }, timeout);
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
        // resolve/reject 后立即清理(此前保留 10ms): 10ms 窗口内的串行只读请求(如 fill→value→clear→value)
        // 会复用已完成请求的旧响应, 表现为"读到陈旧值"(冒烟 POST /clear 假失败的真凶)
        if (this.inflight.get(ik) === entry) this.inflight.delete(ik);
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

  /**
   * HTTP 请求处理已移至 core/http-shell.js（传输层）与 capabilities/*（业务层）。
   * 本方法由构造函数装配：this.handleHTTPRequest = createHttpShell(this, this.router, {...})。
   * 之所以保留这个占位，是为了让"入口在哪"有据可查，而不是留下一个隐形的实例属性。
   */

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
    if (this.monitorTimer) { clearTimeout(this.monitorTimer); this.monitorTimer = null; }
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

  // ============ 安全 ============

  /** 令牌来源优先级: ARK_TOKEN 环境变量 > 共享令牌文件(~/.ark-web/token) > 旧位置 server/.ark-token > 自动生成 */
  resolveAuth(explicitToken) {
    if (process.env.ARK_NO_AUTH === '1' || process.env.ARK_NO_AUTH === 'true') {
      return { token: null, source: 'disabled' };
    }
    if (explicitToken) return { token: String(explicitToken), source: 'options' };
    if (process.env.ARK_TOKEN) return { token: String(process.env.ARK_TOKEN), source: 'env' };
    const candidates = [
      { file: SHARED_TOKEN_FILE, label: '共享文件(~/.ark-web/token)' },
      { file: LEGACY_TOKEN_FILE, label: '文件(server/.ark-token)' }
    ];
    for (const c of candidates) {
      try {
        const t = fs.readFileSync(c.file, 'utf8').trim();
        if (t) {
          // 若命中的是旧位置, 顺便补齐共享文件, 让其他副本的 CLI 也能读到同一令牌
          if (c.file !== SHARED_TOKEN_FILE) {
            try {
              fs.mkdirSync(SHARED_TOKEN_DIR, { recursive: true });
              fs.writeFileSync(SHARED_TOKEN_FILE, t + '\n', { mode: 0o600 });
            } catch { /* 无法写入共享位置时忽略, 继续用旧位置 */ }
          }
          return { token: t, source: c.label, tokenFile: c.file };
        }
      } catch { /* 不存在则继续 */ }
    }
    const generated = crypto.randomBytes(24).toString('hex');
    let written = null;
    try {
      fs.mkdirSync(SHARED_TOKEN_DIR, { recursive: true });
      fs.writeFileSync(SHARED_TOKEN_FILE, generated + '\n', { mode: 0o600 });
      written = SHARED_TOKEN_FILE;
    } catch {
      try { fs.writeFileSync(LEGACY_TOKEN_FILE, generated + '\n', { mode: 0o600 }); written = LEGACY_TOKEN_FILE; } catch { /* 只读目录: 仅日志提示 */ }
    }
    return { token: generated, source: '自动生成', tokenFile: written };
  }

  /** 常量时间比较(先哈希对齐长度, 避免长度差异泄露) */
  tokenEquals(a, b) {
    if (!a || !b) return false;
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  /** 从 X-Ark-Token 头 / Authorization: Bearer / ?token= 提取令牌 */
  requestToken(req, url) {
    const header = req.headers['x-ark-token'];
    if (header) return String(header);
    const auth = req.headers.authorization;
    if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    return url?.searchParams?.get('token') || null;
  }

  /** Host 头解析: 支持 [::1]:9333 这种 IPv6 带端口形式 */
  hostnameOf(hostHeader) {
    const h = String(hostHeader || '').trim().toLowerCase();
    if (!h) return '';
    if (h.startsWith('[')) {
      const end = h.indexOf(']');
      return end > 0 ? h.slice(1, end) : h;
    }
    return h.split(':')[0];
  }

  /** 仅接受回环 Host —— 挡 DNS rebinding 与外部网卡直连 */
  isLoopbackHost(hostHeader) {
    return LOOPBACK_HOSTS.has(this.hostnameOf(hostHeader));
  }

  /** 允许的来源: 无 Origin(curl/CLI) / 浏览器扩展页面 / 本机页面 */
  isAllowedOrigin(origin) {
    if (!origin) return true;
    try {
      const u = new URL(origin);
      if (EXTENSION_PROTOCOLS.has(u.protocol)) return true;
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const hn = u.hostname.toLowerCase();
        return hn === '127.0.0.1' || hn === 'localhost' || hn === '::1' || hn === '[::1]';
      }
      return false;
    } catch {
      return false;
    }
  }

  /** WS 的来源校验：比 HTTP 更严。
   *
   *  为什么必须单独挡：WebSocket 握手不受 CORS 约束，任意网页都能向 ws://127.0.0.1:9334
   *  发起连接（Chrome 的私网访问限制只在部分场景生效）。默认策略：
   *    · 无 Origin        → 本机进程（CLI/脚本），放行
   *    · chrome-extension://（含 moz-/safari-web-extension）→ 浏览器扩展，放行
   *    · http(s)://       → 网页，一律拒绝（含本机页面 —— 本机页面已可用带令牌的 HTTP 通道）
   *  确需让本机页面走 WS 的老用法：ARK_WS_ALLOW_LOCAL=1。
   */
  isAllowedWsOrigin(origin) {
    if (!origin) return true;
    try {
      const u = new URL(origin);
      if (EXTENSION_PROTOCOLS.has(u.protocol)) return this.isTrustedExtensionOrigin(origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        if (process.env.ARK_WS_ALLOW_LOCAL === '1') return true;
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  printSecurityBanner() {
    console.log('[ArkWeb] 安全状态:');
    console.log(`  · 监听地址: ${this.host}:${this.port} / ws ${this.host}:${this.wsPort} (仅回环, 局域网不可达)`);
    console.log('  · Host/Origin 校验: 已启用(仅回环 Host + 本机/扩展来源)');
    console.log('  · WS 来源校验: 已启用(网页来源一律拒绝, 仅扩展与无 Origin 的本机进程可连)');
    if (this.authSource === 'disabled') {
      console.warn('  · 令牌鉴权: 已禁用(ARK_NO_AUTH=1) —— 本机任意进程与任意网页均可操控浏览器, 请勿在不可信环境使用!');
    } else {
      console.log(`  · 令牌鉴权: 已启用(来源: ${this.authSource})`);
      console.log('  · 访问令牌: 不写入日志，请从令牌文件读取');
      console.log('    (请求需带 X-Ark-Token 头或 ?token=; client/browser-client.js 会自动读取并携带)');
    }
    if (this.wsTokenRequired) {
      console.log('  · WS 令牌: 已启用(已登记扩展可免填；其它连接需令牌)');
    } else {
      console.log('  · WS 令牌: 未启用。网页来源已被来源校验挡住; 同机其他用户/进程仍可直连 9334 ——');
      console.log('    多人共用或不可信本机环境下, 设置 ARK_TOKEN 并在插件 popup 填同一令牌即可完全关闭。');
    }
    console.log('');
  }

  // ============ 工具 ============

  /** 动作后置等待(省往返): data.waitFor = 'load'|'url'|'text'|'selector' */
  async maybeWaitAfter(data = {}, r) {
    const w = data.waitFor;
    if (!w || !r || r.error) return r;
    const cmd = { load: 'wait-for-load', url: 'wait-for-url', text: 'wait-for-text', selector: 'wait-for-selector' }[w];
    if (!cmd) return { ...r, waitError: `unknown waitFor: ${w}(可用 load|url|text|selector)` };
    try {
      const wd = {
        timeout: data.waitTimeout || 8000,
        // 点击后等待: 必须观察到导航发生(loading/URL 变化), 否则会误判"旧文档已 complete"
        ...(w === 'load' ? { afterAction: true } : {}),
        ...(data.pattern ? { pattern: data.pattern } : {}),
        ...(data.text ? { text: data.text } : {}),
        ...(data.selector ? { selector: data.selector } : {}),
        ...(data.state ? { state: data.state } : {})
      };
      const waitMs = data.waitTimeout || 8000;
      return { ...r, waited: await this.cmd(cmd, wd, Math.min(waitMs + 5000, 120000)) };
    } catch (e) {
      return { ...r, waitError: e.message };
    }
  }

  /**
   * 读取并解析请求体。
   * @param {object} req
   * @param {{allowEmpty?: boolean}} [opts]
   *   allowEmpty: 解析失败时返回 {} 而不是抛 400。
   *   只有"GET 等本来就不带 body"的场合才该用它；带 body 的 POST 解析失败必须报 400 ——
   *   否则参数被静默丢弃、调用方以为参数生效了（历史上 6 个能力模块用 catch(()=>({})) 吞过）。
   */
  readBody(req, opts) {
    const allowEmpty = !!(opts && opts.allowEmpty);
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
          if (allowEmpty) { resolve({}); return; }
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
    wsPort: parseInt(process.env.BRIDGE_WS_PORT || '9334'),
    // 默认 127.0.0.1(仅本机); 确需局域网访问才设 BRIDGE_HOST=0.0.0.0, 并务必同时设置 ARK_TOKEN
    host: process.env.BRIDGE_HOST || '127.0.0.1'
  });
}
