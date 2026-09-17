/**
 * 能力域：meta —— 存活探针 / 服务状态 / 缓存 / 批量
 *
 * 由 scripts/refactor-split.js 从 bridge-server.js 的 switch 机械提取（可重复生成，勿手改）。
 * 手写路由请放 capabilities/extra.js —— 本文件会被生成器覆盖。
 *
 * 提取原则（可证等价）：
 *   · 简单体：`result = X; break;` → `return X;`（单赋值单出口，语义相同）
 *   · 复杂体：分支体原样搬移，用标号 switch 承载其 result= / break; 的原语义，零改写
 *   · fallthrough 别名（case a: case b: 同体）注册为同一处理器，别名关系显式标注
 * 搬迁改写（三处，均为可验证的机械替换）：
 *   · `this` → `srv`（原 switch 里的 this 指向 server）
 *   · `__dirname` → `SERVER_DIR`（新文件深一层，照搬会让相对路径错位）
 *   · `require(./package.json)` → `require(../package.json)`
 * 处理器入口统一解构 req/res/url/pathname/tabId/sessionId/ttl/fresh/send，
 * 故体里对这些名字的引用与原文完全一致。
 */

const path = require('path');
const { TOKEN_FILE } = require('../core/paths');
const { SERVER_DIR } = require('../core/paths');


module.exports = {
  name: 'meta',
  group: 'meta',
  doc: "存活探针 / 服务状态 / 缓存 / 批量",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 免鉴权存活探针 + 自解释用法(便于新接入的 AI 立刻知道该用什么命令、令牌在哪)
        // 注意: 不含版本/tab/页面等实质数据; 服务仅监听回环地址, 因此返回本机路径是可接受的
        return {
          ok: true,
          connected: srv.connected,
          cli: path.join(SERVER_DIR, '..', 'client', 'browser-client.js'),
          tokenFile: srv.authTokenFile || TOKEN_FILE,
          tokenHeader: 'X-Ark-Token',
          usage: {
            preferred: `node "${path.join(SERVER_DIR, '..', 'client', 'browser-client.js')}" status   (CLI 会自动读取令牌, 推荐)`,
            http: 'HTTP 调用需带 X-Ark-Token 头; 令牌内容见 tokenFile(Windows PowerShell: Get-Content $env:USERPROFILE\\.ark-web\\token -Raw)',
            firstChecks: ['/health(免鉴权)', '/status(需令牌)', '/tabs'],
            docs: 'SKILL.md(视觉优先工作流) · references/protocol.md(全端点) · references/troubleshooting.md(排障)'
          }
        };
      }
    };
    r['/health'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return {
          connected: srv.connected,
          // 对外只认"最近说过话"的连接：只看 socket 存在会把"浏览器已被强杀"报成一切正常
          pluginConnected: (typeof srv.liveClients === 'function' ? srv.liveClients().length > 0 : srv.connected),
          clients: srv.clients.size,
          liveClients: (typeof srv.liveClients === 'function' ? srv.liveClients().length : srv.clients.size),
          // 连接健康: 有多个连接且其中存在近期超时的"可疑连接"时, 说明可能是僵尸连接残留
          connections: [...srv.clients.values()].map(i => ({
            version: i.version || null,
            browser: i.browser || null,
            label: i.label || null,
            // 代码指纹与"是否落后于磁盘"：浏览器跑旧脚本是排查成本最高的一类问题
            build: i.build || null,
            stale: !!i.stale,
            idleMs: Date.now() - (i.lastSeen || i.connectedAt || Date.now()),
            live: Date.now() - (i.lastSeen || i.connectedAt || 0) < 45000,
            suspect: Date.now() < (i.suspectUntil || 0),
            timeouts: i.timeouts || 0
          })),
          ...(srv.clients.size > 1 ? { connectionNote: `存在 ${srv.clients.size} 个插件连接(通常 1 个); 多余的可能是插件重载后的僵尸连接, 命令超时会自动换连接重试, 120s 静默后自动清理` } : {}),
          networkLogs: srv.networkLogs.length,
          consoleLogs: srv.consoleLogs.length,
          requests: srv.requestCount,
          uptime: Math.round((Date.now() - srv.startedAt) / 1000),
          version: 3,
          serverVersion: require('../package.json').version,
          // 插件侧版本: 与 manifest.json 对比即可判断"浏览器是否加载了最新代码"
          plugin: srv.lastRegistration || null,
          security: {
            host: srv.host,
            loopbackOnly: true,
            tokenAuth: srv.authToken ? true : false,
            tokenSource: srv.authSource,
            tokenFile: srv.authTokenFile,
            wsTokenRequired: srv.wsTokenRequired
          }
        };
      }
    };
    r['/status'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        srv.clearCache();
        return { success: true, message: 'Cache cleared' };
      }
    };
    r['/clear-cache'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req);
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
          const ctx2 = srv.als.getStore() || {};
          let fallback = ctx2.tabId != null ? ctx2.tabId : null;
          if (ctx2.sessionId != null) {
            const sess2 = srv.sessions.get(String(ctx2.sessionId));
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
        const batched = await srv.sendToPlugin({ type: 'batch', data: { steps } }, batchTimeout);
        // 批内含写操作则失效相关 tab 的只读与快照缓存(原 bypass cmd 导致脏缓存)
        try {
          const ctx2b = srv.als.getStore() || {};
          const affected = new Set();
          for (const s of (Array.isArray(steps) ? steps : [])) {
            if (srv.writeTypes.has(s.type)) {
              const tid = s.data?.tabId != null ? String(s.data.tabId) : String(ctx2b.tabId ?? srv.resolveCacheTab());
              affected.add(tid);
            }
          }
          for (const tid of affected) {
            for (const k of [...srv.cache.keys()]) if (k.endsWith(`:${tid}`)) srv.cache.delete(k);
            const pref = `snap:${tid}:`;
            for (const k of [...srv.snapshotCache.keys()]) if (k.startsWith(pref)) srv.snapshotCache.delete(k);
          }
        } catch {}
        // 失效逻辑执行完再返回。旧实现写成 `return await sendToPlugin(...)`，
        // 后面整段缓存失效代码因此不可达（重构引入的行为回归：批内写操作后读到脏缓存）
        return batched;
      }
    };
    r['/batch'] = H3;

      return r;
  })()
};
