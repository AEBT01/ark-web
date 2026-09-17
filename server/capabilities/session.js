/**
 * 能力域：session —— 多 agent 并行隔离的会话与标签页绑定
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
  name: 'session',
  group: 'session',
  doc: "多 agent 并行隔离的会话与标签页绑定",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return {
          active: sessionId,
          sessions: [...srv.sessions.entries()].map(([id, s]) => ({ id, tabIds: [...s.tabIds], createdAt: s.createdAt }))
        };
      }
    };
    r['/session'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const id = `s${srv.nextSessionId++}-${Date.now().toString(36)}`;
          srv.sessions.set(id, { id, tabIds: new Set(), createdAt: Date.now() });
          result = { success: true, sessionId: id, createdAt: Date.now() };
          break;
        }
      }
      return result;
    };
    r['/session/create'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const b = await srv.readBody(req);
          const sid = String(b.sessionId || '');
          const sess = srv.sessions.get(sid);
          if (!sess) { result = { error: `session 不存在: ${sid}` }; break; }
          const closedTabs = [];
          // 可选 closeTabs: 删除会话时同时关闭其标签页(并自动恢复该 tab 的全部模拟)
          // 安全: 永远保留浏览器 ≥1 个标签页(全部关闭会连带关闭窗口 → No current window)
          if (b.closeTabs === true && sess.tabIds.size) {
            const tabs = await srv.cmd('get-tabs').catch(() => []);
            const alive = new Set((Array.isArray(tabs) ? tabs : []).map(t => t.id));
            for (const id of sess.tabIds) {
              if (alive.has(id)) {
                await srv.cmd('close-tab', { tabId: id }).catch(() => {});
                closedTabs.push(id);
              }
            }
            // 若窗口只剩被关闭的标签页, 保留最后一个不关(防整窗关闭)
            const remaining = (await srv.cmd('get-tabs').catch(() => [])).length;
            if (remaining === 0 && closedTabs.length) {
              const lastId = closedTabs.pop();
              await srv.cmd('open-url', { url: 'about:blank', active: false }).catch(() => {});
            }
          }
          srv.sessions.delete(sid);
          result = { success: true, sessionId: sid, closedTabs, hint: '标签页已关闭, 其模拟状态已随标签页销毁自动清除' };
          break;
        }
      }
      return result;
    };
    r['/session/delete'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const b = await srv.readBody(req);
          const sid = String(b.sessionId || '');
          const sess = srv.sessions.get(sid);
          if (!sess) { result = { error: `session 不存在: ${sid}` }; break; }
          if (b.tabId == null) { result = { error: 'tabId is required' }; break; }
          sess.tabIds.add(+b.tabId);
          result = { success: true, sessionId: sid, tabId: +b.tabId, tabIds: [...sess.tabIds] };
          break;
        }
      }
      return result;
    };
    r['/session/assign'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const b = await srv.readBody(req);
          const sid = String(b.sessionId || '');
          const sess = srv.sessions.get(sid);
          if (!sess) { result = { error: `session 不存在: ${sid}` }; break; }
          if (b.tabId != null) sess.tabIds.delete(+b.tabId);
          else srv.sessions.delete(sid);
          result = { success: true, sessionId: sid, tabIds: sess.tabIds.size ? [...sess.tabIds] : [] };
          break;
        }
      }
      return result;
    };
    r['/session/release'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          // 会话专用开标签页: 新 tab 自动归属会话(不归属则后续命令 403)
          // 默认后台打开(active:false)不抢占用户焦点; 需要操作时才显式 active:true 或 /tab/activate
          const b = await srv.readBody(req);
          const sid = String(b.sessionId || '');
          const sess = srv.sessions.get(sid);
          if (!sess) { result = { error: `session 不存在: ${sid}` }; break; }
          if (!b.url) { result = { error: 'url is required' }; break; }
          const r = await srv.cmd('open-url', { url: b.url, active: b.active === true });
          if (r?.tab?.id != null) {
            sess.tabIds.add(r.tab.id);
            r.sessionId = sid;
            r.hint = '标签页后台打开(不抢焦点); 需要交互时 POST /tab/activate 或重开 active:true';
          }
          result = r;
          break;
        }
      }
      return result;
    };
    r['/session/tab'] = H5;

    return r;
  })()
};
