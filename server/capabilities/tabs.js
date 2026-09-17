/**
 * 能力域：tabs —— 标签页与导航
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
  name: 'tabs',
  group: 'tabs',
  doc: "标签页与导航",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 语义: 当前标签页导航(不新开 tab), 等价 /open {url, current: true}
        const navBody = await srv.readBody(req);
        navBody.current = true;
        return await srv.cmd('open-url', navBody);
      }
    };
    r['/navigate'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('reload', await srv.readBody(req, { allowEmpty: true }));
      }
    };
    r['/reload'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('back', {});
      }
    };
    r['/back'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('forward', {});
      }
    };
    r['/forward'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('activate-tab', await srv.readBody(req));
      }
    };
    r['/tab/activate'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('close-tab', await srv.readBody(req));
      }
    };
    r['/tab/close'] = H5;

    const H6 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 让浏览器重载插件代码(改完插件后用来自我更新; 重载后 CDP 授权失效需重新「启用调试」)
        return await srv.cmd('reload-extension', {}, 8000);
      }
    };
    r['/reload-extension'] = H6;

    const H7 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          result = await srv.cmd('get-tabs');
          // 会话视角: 标注 owned, 并清理已关闭标签页的绑定
          if (sessionId != null) {
            const sess = srv.sessions.get(String(sessionId));
            if (sess && Array.isArray(result)) {
              const alive = new Set(result.map(t => t.id));
              for (const id of [...sess.tabIds]) if (!alive.has(id)) sess.tabIds.delete(id);
              for (const t of result) t.owned = sess.tabIds.has(t.id);
            }
          }
          break;
        }
      }
      return result;
    };
    r['/tabs'] = H7;

    const H8 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const openBody = await srv.readBody(req);
          result = await srv.cmd('open-url', openBody);
          // current 导航未显式指定 tabId 时: 回显实际作用的目标 tab(防多标签漂移误判)
          if (openBody.current && result?.tabId != null && tabId == null) {
            result.usedTabId = result.tabId;
            result.hint = 'current 导航未指定 ?tabId=, 作用于当前激活标签页; 多标签场景请显式 ?tabId=<id>';
          }
          // 会话内新建标签页(current:false): 新 tab 自动归属会话, 免手动 assign
          if (sessionId != null && !openBody.current && result?.tab?.id != null) {
            const sess = srv.sessions.get(String(sessionId));
            if (sess) {
              sess.tabIds.add(result.tab.id);
              result.sessionId = sessionId;
            }
          }
          break;
        }
      }
      return result;
    };
    r['/open'] = H8;

    return r;
  })()
};
