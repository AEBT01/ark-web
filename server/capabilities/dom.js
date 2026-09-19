/**
 * 能力域：dom —— 页面信息、DOM 查询、脚本执行与等待
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
  name: 'dom',
  group: 'dom',
  doc: "页面信息、DOM 查询、脚本执行与等待",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-page-info');
      }
    };
    r['/page-info'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-dom');
      }
    };
    r['/dom'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-html', await srv.readBody(req, { allowEmpty: true }));
      }
    };
    r['/html'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-frames', {});
      }
    };
    r['/frames'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-layout', {});
      }
    };
    r['/layout'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('query-selector', await srv.readBody(req));
      }
    };
    r['/query'] = H5;

    const H6 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('query-all', await srv.readBody(req));
      }
    };
    r['/query-all'] = H6;

    const H7 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('query-many', await srv.readBody(req));
      }
    };
    r['/query-many'] = H7;

    const H8 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('element-exists', await srv.readBody(req));
      }
    };
    r['/exists'] = H8;

    const H9 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-text', await srv.readBody(req, { allowEmpty: true }));
      }
    };
    r['/get-text'] = H9;
    r['/text'] = H9;   // 别名 → /get-text

    const H10 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-attr', await srv.readBody(req));
      }
    };
    r['/get-attr'] = H10;
    r['/attr'] = H10;   // 别名 → /get-attr

    const H11 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-value', await srv.readBody(req));
      }
    };
    r['/get-value'] = H11;
    r['/value'] = H11;   // 别名 → /get-value

    const H12 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('evaluate', await srv.readBody(req));
      }
    };
    r['/evaluate'] = H12;

    const H13 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req, { allowEmpty: true });
        const waitMs = Math.min(Math.max((+body.timeout || 15000) + 5000, 20000), 300000);
        const typeMap = { '/wait-for': 'wait-for-selector', '/wait-for-text': 'wait-for-text', '/wait-for-url': 'wait-for-url', '/wait-for-load': 'wait-for-load' };
        return await srv.cmd(typeMap[pathname], body, waitMs);
      }
    };
    r['/wait-for'] = H13;
    r['/wait-for-text'] = H13;   // 别名 → /wait-for
    r['/wait-for-url'] = H13;   // 别名 → /wait-for
    r['/wait-for-load'] = H13;   // 别名 → /wait-for

    const H14 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 等待页面稳定(DOM 连续静默): 替代固定 sleep, 避免拍到渲染过渡态
        const body = req.method === 'POST' ? await srv.readBody(req, { allowEmpty: true }) : {};
        if (url.searchParams.get('timeout')) body.timeout = +url.searchParams.get('timeout');
        if (url.searchParams.get('quiet')) body.quiet = +url.searchParams.get('quiet');
        return await srv.cmd('wait-for-stable', body, Math.max(5000, (body.timeout || 15000) + 3000));
      }
    };
    r['/wait-for-stable'] = H14;

    const H14b = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 等待网络空闲（Playwright networkidle 等价物）：连续 idleTime 无"进行中请求"才算稳。
        // 替代"加载后盲等 N 秒"，长轮询站点可用 ignoreTypes 排除。
        const body = req.method === 'POST' ? await srv.readBody(req, { allowEmpty: true }) : {};
        if (url.searchParams.get('timeout')) body.timeout = +url.searchParams.get('timeout');
        if (url.searchParams.get('idleTime')) body.idleTime = +url.searchParams.get('idleTime');
        return await srv.cmd('wait-for-idle', body, Math.max(5000, (body.timeout || 20000) + 3000));
      }
    };
    r['/wait-for-idle'] = H14b;

    const H15 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('set-script-disabled', await srv.readBody(req));
      }
    };
    r['/js'] = H15;

    const H16 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-dom-changes', {});
      }
    };
    r['/dom-changes'] = H16;

    const H17 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('clear-dom-changes', {});
      }
    };
    r['/dom-changes/clear'] = H17;

    return r;
  })()
};
