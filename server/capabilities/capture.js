/**
 * 能力域：capture —— 截图 / 快照 / PDF
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
  name: 'capture',
  group: 'capture',
  doc: "截图 / 快照 / PDF",
  routes: (function () {
    const r = {};

    const H0 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        return await srv.cmd('screenshot', {
          format: url.searchParams.get('format') || 'png',
          quality: +url.searchParams.get('quality') || 80
        });
      }
    };
    r['/screenshot'] = H0;

    const H1 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 插件端 guardedCommand 看门狗 25s + 内部 fallback 链最长可到 ~40s, server 超时必须 > 插件端, 否则退化环境下被提前 504
        return await srv.cmd('screenshot-full', {
          format: url.searchParams.get('format') || 'png',
          quality: +url.searchParams.get('quality') || 80
        }, 45000);
      }
    };
    r['/screenshot/full'] = H1;

    const H2 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 元素截图插件端重试一次(2×15s+间隔), server 侧对齐
        return await srv.cmd('screenshot-element', await srv.readBody(req), 35000);
      }
    };
    r['/screenshot/element'] = H2;

    const H3 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 裁剪放大截图: 小字/细节读不清时用。ref 指 SoM 编号(需先拍一次 annotate snapshot)
        const body = req.method === 'POST' ? await srv.readBody(req, { allowEmpty: true }) : {};
        if (url.searchParams.get('ref')) body.ref = +url.searchParams.get('ref');
        if (url.searchParams.get('selector')) body.selector = url.searchParams.get('selector');
        if (url.searchParams.get('scale')) body.scale = +url.searchParams.get('scale');
        if (url.searchParams.get('format')) body.format = url.searchParams.get('format');
        if (url.searchParams.get('quality')) body.quality = +url.searchParams.get('quality');
        body.tabId = tabId ?? undefined;
        return await srv.cmd('zoom-shot', body, 25000);
      }
    };
    r['/snapshot/zoom'] = H3;

    const H4 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 可见文本块 + 紧致坐标(不用截图就能"读"页面): 读小字/取文案/交叉校验用
        const body = req.method === 'POST' ? await srv.readBody(req, { allowEmpty: true }) : {};
        if (url.searchParams.get('max')) body.max = +url.searchParams.get('max');
        if (url.searchParams.get('minLen')) body.minLen = +url.searchParams.get('minLen');
        return await srv.cmd('text-map', body, 15000);
      }
    };
    r['/snapshot/text'] = H4;

    const H5 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        // 快照快路径别名，默认 fast:true + 15s 超时
        let snapParams = { fast: true };
        if (req.method === 'POST') {
          try { Object.assign(snapParams, await srv.readBody(req)); } catch {}
        }
        const q = (k) => url.searchParams.get(k);
        if (q('format')) snapParams.format = q('format');
        if (q('quality')) snapParams.quality = +q('quality');
        if (q('annotate') != null) snapParams.annotate = q('annotate') === '1' || q('annotate') === 'true';
        if (q('full') != null) snapParams.full = q('full') === '1' || q('full') === 'true';
        if (q('maxElements')) snapParams.maxElements = +q('maxElements');
        if (q('selector')) snapParams.selector = q('selector');
        return await srv.cmd('vision-snapshot', snapParams, 15000);
      }
    };
    r['/fast/snapshot'] = H5;

    const H6 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      {
        const pdfBody = await srv.readBody(req);
        return await srv.cmd('print-to-pdf', {
          format: url.searchParams.get('format') || pdfBody.format || 'A4',
          landscape: pdfBody.landscape === true,
          printBackground: pdfBody.printBackground !== false,
          ...(pdfBody.margin ? { margin: pdfBody.margin } : {})
        });
      }
    };
    r['/pdf'] = H6;

    const H7 = async function (__ark) {
      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;
      const srv = __ark.server;
      let result;
      {
        legacy: switch (0) { default:
          // 视觉快照: GET 用 query，POST 用 body，二者合并；/binary 或 ?binary=1 直接返回 image/* 二进制
          const isBinary = pathname.endsWith('/binary') || url.searchParams.get('binary') === '1';
          let snapParams = {};
          if (req.method === 'POST') {
            try { snapParams = await srv.readBody(req); } catch { snapParams = {}; }
          }
          // query 覆盖/补充 body
          const q = (k) => url.searchParams.get(k);
          if (q('format')) snapParams.format = q('format');
          if (q('quality')) snapParams.quality = +q('quality');
          if (q('annotate') != null) snapParams.annotate = q('annotate') === '1' || q('annotate') === 'true';
          if (q('full') != null) snapParams.full = q('full') === '1' || q('full') === 'true';
          if (q('compact') != null) snapParams.compact = q('compact') !== '0' && q('compact') !== 'false';
          if (q('maxElements')) snapParams.maxElements = +q('maxElements');
          if (q('selector')) snapParams.selector = q('selector');
          if (q('fast') != null) snapParams.fast = q('fast') === '1' || q('fast') === 'true';
          if (q('speed') != null) snapParams.speed = q('speed');
          result = await srv.cmd('vision-snapshot', snapParams, 25000);
          if (isBinary && result && result.dataUrl) {
            try {
              const b64 = result.dataUrl.split(',')[1] || result.dataUrl;
              const buf = Buffer.from(b64, 'base64');
              const f = String(snapParams.format || '').toLowerCase();
              const ct = (f === 'jpeg' || f === 'jpg') ? 'image/jpeg' : f === 'webp' ? 'image/webp' : 'image/png';
              // 元信息走 Header(截断防超限)，主图走 body，AI 仍可解析图 + 锚点
              const elsHeader = JSON.stringify(result.elements || []).slice(0, 8000);
              res.writeHead(200, {
                'Content-Type': ct,
                'Content-Length': buf.length,
                'X-Snapshot-Url': encodeURIComponent(result.url || ''),
                'X-Snapshot-Title': encodeURIComponent(result.title || ''),
                'X-Snapshot-Elements': encodeURIComponent(elsHeader),
                'X-Snapshot-Viewport': JSON.stringify(result.viewport || {}),
                'Cache-Control': 'no-store'
              });
              res.end(buf);
              // 已直接发送二进制，不再走外层 send
              return;
            } catch (e) {
              // 二进制失败回退 JSON
              result._binaryError = e.message;
            }
          }
          break;
        }
      }
      return result;
    };
    r['/snapshot'] = H7;
    r['/snapshot/binary'] = H7;   // 别名 → /snapshot

    return r;
  })()
};
