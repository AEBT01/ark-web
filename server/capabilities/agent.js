/**
 * 能力域：agent —— 云端大脑与 Agent 任务运行时
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

const brain = require('../brain');


module.exports = {
  name: 'agent',
  group: 'agent',
  doc: "云端大脑与 Agent 任务运行时",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return { model: brain.MODEL, hasKey: brain.hasKey() };
      }
    };
    r['/brain/status'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return { catalog: srv.toolRegistry.catalog(), count: srv.toolRegistry.all().length };
      }
    };
    r['/brain/tools'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return {
          stats: srv.tasks.stats(),
          tasks: srv.tasks.list({
            status: url.searchParams.get('status') || null,
            limit: +url.searchParams.get('limit') || 30,
            full: url.searchParams.get('full') === '1'
          })
        };
      }
    };
    r['/agent/tasks'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const id = url.searchParams.get('id');
        const t = srv.tasks.detail(id, {
          events: url.searchParams.get('events') === '1',
          from: +url.searchParams.get('from') || 0
        });
        return t || { error: 'not-found', id: id };
      }
    };
    r['/agent/task/detail'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req);
        return srv.tasks.cancel(body.id);
      }
    };
    r['/agent/cancel'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req, { allowEmpty: true });
        // 注意 keep=0 是合法值（清空全部已结束任务），不能用 || 兜底
        const keep = body.keep != null ? +body.keep : 50;
        return { removed: srv.tasks.prune(Number.isFinite(keep) ? keep : 50), keep: keep };
      }
    };
    r['/agent/prune'] = H5;

    const H6 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = await srv.readBody(req);
          if (!body.goal) { result = { error: 'goal is required' }; break; }
          const entry = await srv.semantic.ensure(srv._reqTabId(), body.fresh);
          result = await brain.plan(String(body.goal), {
            url: entry.url,
            title: entry.title,
            units: entry.units,
            limit: body.limit || 40
          });
          break;
        }
      }
      return result;
    };
    r['/brain/plan'] = H6;

    const H7 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = await srv.readBody(req);
          if (!body.goal) { result = { error: 'goal is required' }; break; }
          result = await brain.answer(String(body.goal), body.reads || [], { url: body.url || '' });
          break;
        }
      }
      return result;
    };
    r['/brain/answer'] = H7;

    const H8 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = await srv.readBody(req);
          if (!body.goal) { result = { error: 'goal is required' }; break; }
          const tabId = srv._reqTabId();
          const entry = await srv.semantic.ensure(tabId, true);
          const pageSummary = 'URL: ' + entry.url
            + '\n标题: ' + entry.title
            + '\n语义内容块: ' + entry.units.length + ' 个（类型分布 ' + JSON.stringify(entry.stats.typeCounts) + '）'
            + '\n提示: 用 semantic_find 检索内容块，或用 page_info / read_text / snapshot 观察页面。';
          result = await brain.agent(String(body.goal), {
            registry: srv.toolRegistry,
            ctx: { tabId: tabId, // confirmHigh 不再从请求体接受：agent 若能自开"全局授权"，门禁等于没有。
          // 该开关只由界面上的显式批准动作设置（见 task-runner 的 approvedSigs）。
          confirmHigh: false, core: srv.cdp },
            pageSummary: pageSummary,
            maxTurns: body.maxTurns || undefined,
            toolFilter: body.tools || null
          });
          break;
        }
      }
      return result;
    };
    r['/brain/agent'] = H8;

    const H9 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = await srv.readBody(req);
          if (!body.goal) { result = { error: 'goal is required' }; break; }
          // 任务视野：优先显式 targetId；否则用 url 在内核里解析（面板只有 chrome.tabs，
          // 拿不到 targetId，因此把 url 一起报上来 —— 这样整条链路完全不依赖扩展通道）
          let targetId = body.targetId || null;
          if (!targetId && body.url) {
            try {
              const pages = await srv.cdp.pages(true);
              const hit = pages.find(p => p.url === String(body.url));
              if (hit) targetId = hit.id;
            } catch (e) { /* 内核不可用则由运行时按"活动页"兜底 */ }
          }
          const t = srv.tasks.create(String(body.goal), {
            tabId: body.tabId != null ? body.tabId : srv._reqTabId(),
            targetId: targetId,
            maxTurns: body.maxTurns,
            // confirmHigh 不再从请求体接受：agent 若能自开"全局授权"，门禁等于没有。
          // 该开关只由界面上的显式批准动作设置（见 task-runner 的 approvedSigs）。
          confirmHigh: false,
          });
          result = { ok: true, taskId: t.id, status: t.status, goal: t.goal, targetId: t.targetId, tabId: t.tabId };
          break;
        }
      }
      return result;
    };
    r['/agent/task'] = H9;

    return r;
  })()
};
