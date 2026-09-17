/**
 * 能力域：semantic —— 语义层：页面消化 / 检索 / 锚点定位
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
  name: 'semantic',
  group: 'semantic',
  doc: "语义层：页面消化 / 检索 / 锚点定位",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req, { allowEmpty: true });
        return srv.semantic.summary(await srv.semantic.build(srv._reqTabId(), body.opts || body));
      }
    };
    r['/semantic/build'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = req.method === 'POST' ? await srv.readBody(req, { allowEmpty: true }) : {};
        const q = body.query || url.searchParams.get('query') || url.searchParams.get('q') || '';
        return await srv.semantic.query(srv._reqTabId(), q, {
          topK: +body.topK || +url.searchParams.get('topK') || 5,
          fresh: body.fresh === true || url.searchParams.get('fresh') === '1'
        });
      }
    };
    r['/semantic/query'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req);
        return await srv.semantic.act(srv._reqTabId(), body);
      }
    };
    r['/semantic/act'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req);
        return await srv.semantic.run(srv._reqTabId(), body.steps, body);
      }
    };
    r['/semantic/run'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.semantic.dump(srv._reqTabId(), {
          level: url.searchParams.get('level') || undefined,
          limit: +url.searchParams.get('limit') || 40,
          fresh: url.searchParams.get('fresh') === '1'
        });
      }
    };
    r['/semantic/dump'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        srv.semantic.clear(srv._reqTabId());
        return { success: true };
      }
    };
    r['/semantic/clear'] = H5;

    return r;
  })()
};
