/**
 * 能力域：inspect —— 安全检查 / 无障碍 / SEO / 全量分析
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
  name: 'inspect',
  group: 'inspect',
  doc: "安全检查 / 无障碍 / SEO / 全量分析",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('security-check');
      }
    };
    r['/security'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('a11y-check');
      }
    };
    r['/a11y'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('seo-check');
      }
    };
    r['/seo'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.analyzeAllTabs();
      }
    };
    r['/analyze-all'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          // 3s 缓存, ?fresh=1 绕过
          const fullCacheKey = `full:${srv.resolveCacheTab()}`;
          const fullCached = fresh ? null : srv.getCache(fullCacheKey);
          if (fullCached) { result = fullCached; break; }
          const [dom, performance, vitals, security, a11y, seo, pageInfo] = await Promise.all([
            srv.cmd('get-dom').catch(e => ({ error: e.message })),
            srv.cmd('get-performance').catch(e => ({ error: e.message })),
            srv.cmd('get-web-vitals', {}, 15000).catch(e => ({ error: e.message })),
            srv.cmd('security-check').catch(e => ({ error: e.message })),
            srv.cmd('a11y-check').catch(e => ({ error: e.message })),
            srv.cmd('seo-check').catch(e => ({ error: e.message })),
            srv.cmd('get-page-info').catch(e => ({ error: e.message }))
          ]);
          result = { dom, performance, vitals, security, a11y, seo, pageInfo };
          srv.setCache(fullCacheKey, result, 3000);
          break;
        }
      }
      return result;
    };
    r['/full'] = H4;

    return r;
  })()
};
