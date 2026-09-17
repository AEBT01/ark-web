/**
 * 能力域：audit —— 审计引擎
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

const auditReport = require('../audit-report');


module.exports = {
  name: 'audit',
  group: 'audit',
  doc: "审计引擎",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.runAudit(await srv.readBody(req).catch(() => ({})));
      }
    };
    r['/audit'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const filterUrl = url.searchParams.get('url');
        const limit = parseInt(url.searchParams.get('limit')) || 10;
        return auditReport.readHistory(filterUrl, limit);
      }
    };
    r['/history'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = await srv.readBody(req);
          const { urls = [], budget, settleMs } = body;
          if (!Array.isArray(urls) || urls.length === 0) {
            result = { error: 'urls (array) is required' };
          } else {
            // 捕获请求级上下文(含会话约束), 队列内所有导航/采集在原 tab 内执行
            const ctx = srv.als.getStore() || null;
            const id = await srv.auditQueue.runTask({
              urls, budget, settleMs, ctx,
              onAudit: (url, data) => srv.buildAudit(data, budget, url)
            });
            result = { success: true, taskId: id };
          }
          break;
        }
      }
      return result;
    };
    r['/audit/run'] = H2;

    return r;
  })()
};
