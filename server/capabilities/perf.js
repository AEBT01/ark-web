/**
 * 能力域：perf —— 性能指标 / 控制台 / DOM 变化 / 监控
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
  name: 'perf',
  group: 'perf',
  doc: "性能指标 / 控制台 / DOM 变化 / 监控",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-performance');
      }
    };
    r['/performance'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-web-vitals', {}, 15000);
      }
    };
    r['/vitals'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-resources');
      }
    };
    r['/resources'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('set-cpu-throttling', await srv.readBody(req));
      }
    };
    r['/cpu'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        srv.consoleLogs = [];
        await srv.cmd('clear-console-logs', {}).catch(() => {});
        return { success: true };
      }
    };
    r['/console/clear'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return srv.startMonitoring(await srv.readBody(req));
      }
    };
    r['/monitor'] = H5;

    const H6 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return srv.stopMonitoring();
      }
    };
    r['/monitor/stop'] = H6;

    const H7 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return srv.getMonitorStatus();
      }
    };
    r['/monitor/status'] = H7;

    const H8 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const tabId = url.searchParams.get('tabId');
          const limit = parseInt(url.searchParams.get('limit')) || 500;
          if (tabId) {
            result = await srv.cmd('get-console-logs', { tabId, limit });
          } else if (srv.consoleLogs.length > 0) {
            result = srv.consoleLogs.slice(-limit);
          } else {
            result = await srv.cmd('get-console-logs', { limit });
          }
          break;
        }
      }
      return result;
    };
    r['/console'] = H8;

    return r;
  })()
};
