/**
 * 能力域：network —— 网络观测与拦截
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

module.exports = {
  name: 'network',
  group: 'network',
  doc: "网络观测与拦截",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        srv.networkLogs = [];
        await srv.cmd('clear-network-logs', {}).catch(() => {});
        return { success: true };
      }
    };
    r['/network/clear'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-response-body', await srv.readBody(req));
      }
    };
    r['/network/response'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('block-urls', await srv.readBody(req));
      }
    };
    r['/network/block'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('unblock-urls', {});
      }
    };
    r['/network/unblock'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('set-network-conditions', await srv.readBody(req));
      }
    };
    r['/network/conditions'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('reset-network-conditions', {});
      }
    };
    r['/network/conditions/reset'] = H5;

    const H6 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('set-cache-disabled', await srv.readBody(req));
      }
    };
    r['/network/disable-cache'] = H6;

    const H7 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('bypass-csp', await srv.readBody(req));
      }
    };
    r['/bypass-csp'] = H7;

    const H8 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const filter = url.searchParams.get('filter');
          const tabId = url.searchParams.get('tabId');
          const type = url.searchParams.get('type');
          const limit = parseInt(url.searchParams.get('limit')) || 500;
          let logs = srv.networkLogs;
          if (tabId) logs = logs.filter(l => String(l.tabId) === String(tabId));
          if (filter) logs = logs.filter(l => (l.url || '').includes(filter));
          if (type) logs = logs.filter(l => l.type === type);
          result = logs.slice(-limit);
          break;
        }
      }
      return result;
    };
    r['/network'] = H8;

    return r;
  })()
};
