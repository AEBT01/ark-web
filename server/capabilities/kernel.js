/**
 * 能力域：kernel —— CDP 直连内核
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
  name: 'kernel',
  group: 'kernel',
  doc: "CDP 直连内核",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const info = await srv.cdp.probe();
        return info.ok
          ? { ok: true, browser: info.browser, protocol: info.protocol, port: srv.cdp.port }
          : { ok: false, port: srv.cdp.port, error: info.error || ('HTTP ' + info.status) };
      }
    };
    r['/cdp/status'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const pages = await srv.cdp.pages(true);
          const all = await srv.cdp.targets();
          result = {
            total: all.length,
            byType: all.reduce(function (m, t) { m[t.type] = (m[t.type] || 0) + 1; return m; }, {}),
            pages: pages
          };
          break;
        }
      }
      return result;
    };
    r['/cdp/targets'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = await srv.readBody(req);
          const targetId = body.targetId || (await srv.cdp.activePage() || {}).id;
          if (!targetId) { result = { error: '没有可用的页面 target' }; break; }
          result = { targetId: targetId, value: await srv.cdp.evaluate(String(body.code || 'return null'), targetId) };
          break;
        }
      }
      return result;
    };
    r['/cdp/eval'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = req.method === 'POST' ? await srv.readBody(req, { allowEmpty: true }) : {};
          const targetId = body.targetId || (await srv.cdp.activePage() || {}).id;
          if (!targetId) { result = { error: '没有可用的页面 target' }; break; }
          result = await srv.cdp.pageInfo(targetId);
          break;
        }
      }
      return result;
    };
    r['/cdp/page-info'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = req.method === 'POST' ? await srv.readBody(req, { allowEmpty: true }) : {};
          const targetId = body.targetId || (await srv.cdp.activePage() || {}).id;
          if (!targetId) { result = { error: '没有可用的页面 target' }; break; }
          const data = await srv.cdp.screenshot(targetId, body);
          result = { targetId: targetId, format: body.format || 'png', base64KB: Math.round(data.length / 1024), dataUrl: 'data:image/' + (body.format || 'png') + ';base64,' + data };
          break;
        }
      }
      return result;
    };
    r['/cdp/screenshot'] = H4;

    return r;
  })()
};
