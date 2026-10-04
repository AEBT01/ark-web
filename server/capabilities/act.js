/**
 * 能力域：act —— 点击 / 输入 / 滚动的元素动作
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
  name: 'act',
  group: 'act',
  doc: "点击 / 输入 / 滚动的元素动作",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('click-element', await srv.readBody(req));
      }
    };
    r['/click'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('hover-element', await srv.readBody(req));
      }
    };
    r['/hover'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('double-click', await srv.readBody(req));
      }
    };
    r['/dblclick'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('right-click', await srv.readBody(req));
      }
    };
    r['/rightclick'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('drag-element', await srv.readBody(req));
      }
    };
    r['/drag'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('mouse', await srv.readBody(req));
      }
    };
    r['/mouse'] = H5;

    const H6 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('scroll-page', await srv.readBody(req));
      }
    };
    r['/scroll'] = H6;

    const H7 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('scroll-into-view', await srv.readBody(req));
      }
    };
    r['/scroll-into-view'] = H7;

    const H8 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('scroll-by', await srv.readBody(req));
      }
    };
    r['/scroll-by'] = H8;

    const H9 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('simulate-key', await srv.readBody(req));
      }
    };
    r['/key'] = H9;

    const H10 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('type-text', await srv.readBody(req));
      }
    };
    r['/type'] = H10;

    const H11 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('fill-form', await srv.readBody(req));
      }
    };
    r['/fill'] = H11;

    const H12 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('select-option', await srv.readBody(req));
      }
    };
    r['/select'] = H12;

    const H13 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('check-box', await srv.readBody(req));
      }
    };
    r['/check'] = H13;

    const H14 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('clear-field', await srv.readBody(req));
      }
    };
    r['/clear'] = H14;

    const H15 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('focus-element', await srv.readBody(req));
      }
    };
    r['/focus'] = H15;

    const H16 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req);
        // fast/click 复用 act 逻辑
        return await srv.cmd('click-element', { fast: true, ...body });
      }
    };
    r['/fast/click'] = H16;

    const H17 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req);
        return await srv.cmd('fill-form', body);
      }
    };
    r['/fast/fill'] = H17;

    const H18 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const body = await srv.readBody(req);
        // 上传文件必须过沙箱：files 直通 CDP 的 DOM.setFileInputFiles（接受任意绝对路径），
        // 不校验就等于给 agent 开了"本地任意文件读" —— 可以把自己的令牌/密钥塞进页面再读回上下文。
        // 只允许 ~/.ark-web/workspace 内的文件（与 read_file/write_file 同一沙箱）。
        const files = Array.isArray(body && body.files) ? body.files : (body && body.file ? [body.file] : []);
        if (files.length) {
          const sandbox = require('../core/fs-sandbox');
          const out = [];
          for (const f of files) {
            const r = sandbox.resolveInside(f);
            if (!r) {
              return { error: 'path-outside-workspace', file: f,
                message: '上传只允许工作区（~/.ark-web/workspace）内的文件；越界路径被拒绝。',
                hint: '先把文件放进工作区，或由用户手动在页面上选择文件。' };
            }
            out.push(r);
          }
          return await srv.cmd('upload-file', Object.assign({}, body, { files: out }));
        }
        return await srv.cmd('upload-file', body);
      }
    };
    r['/upload'] = H18;

    const H19 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('highlight-elements', await srv.readBody(req));
      }
    };
    r['/highlight'] = H19;

    const H20 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('clear-highlights', {});
      }
    };
    r['/highlight/clear'] = H20;

    const H21 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('dialog', await srv.readBody(req));
      }
    };
    r['/dialog'] = H21;

    const H22 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('get-dialogs', {});
      }
    };
    r['/dialogs'] = H22;

    const H23 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          const body = await srv.readBody(req);
          const { action, ...data } = body || {};
          if (!action) { result = { error: 'action is required (snapshot|click|clickRef|hoverRef|fillRef|readText|zoom|clickText|fill|type|extract|navigate|evaluate)' }; break; }
          switch (action) {
            case 'snapshot': result = await srv.cmd('vision-snapshot', { fast: true, ...data }, 15000); break;
            case 'click': result = await srv.cmd('click-element', { fast: true, ...data }); break;
            // ---- 视觉优先: 直接按 SoM 编号(ref)操作, 无需坐标换算, 滚动后仍安全 ----
            // 支持 waitFor: 'load'|'url'|'text'|'selector' —— 点击后立即等条件成立, 省一次往返
            case 'clickRef': result = await srv.maybeWaitAfter(data, await srv.cmd('click-ref', { fast: true, ...data })); break;
            case 'hoverRef': result = await srv.cmd('hover-ref', { ...data }); break;
            case 'fillRef': result = await srv.maybeWaitAfter(data, await srv.cmd('fill-ref', { ...data })); break;
            case 'readText': result = await srv.cmd('read-text', { ...data }); break;
            case 'zoom': result = await srv.cmd('zoom-shot', { ...data }, 25000); break;
            // 按可见文本查找元素(不点击), 返回 ref/坐标/上下文 —— 快照里没看清时的定点工具
            case 'find': result = await srv.cmd('find-text', { ...data }); break;
            // 批量 ref 动作: 一次 HTTP 完成多步 [{op:'click',ref:3},{op:'fill',ref:2,value:'x'}]
            case 'refs': {
              const steps = Array.isArray(data.steps) ? data.steps : [];
              if (!steps.length) { result = { error: 'steps is required: [{op:"click"|"hover"|"fill"|"read", ref, value?}]' }; break; }
              const opMap = { click: 'click-ref', hover: 'hover-ref', fill: 'fill-ref', read: 'read-text', readText: 'read-text' };
              const out = [];
              for (const s of steps) {
                const cmd = opMap[s.op];
                if (!cmd) { out.push({ op: s.op, error: `unknown op: ${s.op}` }); continue; }
                try {
                  const r = await srv.cmd(cmd, { ...s, ...(s.tabId != null ? {} : {}) });
                  out.push({ op: s.op, ref: s.ref, result: r });
                } catch (e) { out.push({ op: s.op, ref: s.ref, error: e.message }); }
              }
              result = { success: out.every(o => !o.error), steps: out };
              break;
            }
            case 'clickText': {
              // 视觉文本点击：snapshot 坐标优先，evaluate 兜底
              try {
                const snap = await srv.cmd('vision-snapshot', { maxElements: 50, fast: true }, 8000);
                const hit = snap?.elements?.find(e => (e.text || '').includes(data.text) || (e.name || '').includes(data.text));
                if (hit && hit.center) {
                  result = await srv.cmd('mouse', { type: 'click', x: hit.center.x, y: hit.center.y, fast: true });
                  if (result && !result.error) { result.method = 'fast-snapshot-text'; break; }
                }
              } catch {}
              const code = `return (()=>{ const els=[...document.querySelectorAll('a, button, [role="button"]')]; const t=${JSON.stringify(data.text||'')}; const hit=els.find(e=> (e.innerText||e.textContent||'').includes(t)); if(hit){ hit.click(); return {tag:hit.tagName, text:hit.innerText?.slice(0,50)} } return null; })()`;
              result = await srv.cmd('evaluate', { code });
              break;
            }
            case 'fill': result = await srv.cmd('fill-form', data); break;
            case 'type': result = await srv.cmd('type-text', data); break;
            case 'extract': result = await srv.cmd('query-many', { selectors: data.selectors || data.selectors }); break;
            case 'navigate': result = await srv.cmd('open-url', { url: data.url, current: !!data.current }); break;
            case 'evaluate': result = await srv.cmd('evaluate', data); break;
            default: result = { error: `unknown action: ${action}` }; break;
          }
          break;
        }
      }
      return result;
    };
    r['/fast/act'] = H23;
    r['/act'] = H23;   // 别名 → /fast/act

    return r;
  })()
};
