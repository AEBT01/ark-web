#!/usr/bin/env node
/**
 * ark-fast.js — Ark Web Fast API 封装 (v8.1)
 * 目标: 一次 HTTP 往返完成高层意图，内置 per-tab 队列 + snapshot 400ms 缓存 + inflight 合并 + binary 直出
 * 依赖: browser-client.js 的 BrowserClient (keep-alive 8s / 20 并发)
 *
 * 用法 (Node / AI):
 *   const { ArkFast } = require('./ark-fast');
 *   const fast = new ArkFast({ baseUrl: 'http://localhost:9333', session: 's1' });
 *   await fast.snapshot({ annotate: true }); // { dataUrl, elements, url, title }
 *   await fast.click('#btn', { fast: true }); // 坐标优先 + selector 兜底
 *   await fast.clickText('登录', { fast: true });
 *   await fast.fill([{selector:'#user', value:'alice'}]);
 *   await fast.extract(['#price', '.title']);
 *   await fast.act({ action: 'navigate', url: 'https://example.com' });
 *
 * CLI 快捷:
 *   node client/ark-fast.js snapshot --annotate
 *   node client/ark-fast.js click "#btn" --fast
 *   node client/ark-fast.js clickText "登录" --fast
 */
const BrowserClient = require('./browser-client');
const fs = require('fs');

class ArkFast {
  constructor(opts = {}) {
    this.client = opts.client || new BrowserClient({ baseUrl: opts.baseUrl, session: opts.session });
    if (opts.session) this.client.session = opts.session;
  }

  // —— 视觉 —— //
  async snapshot(opts = {}) {
    // fast 快照走 /fast/snapshot，binary 走二进制直出省 33%
    if (opts.binary) return this.client.snapshotBinary(opts);
    if (opts.fast !== false) {
      try {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(opts)) if (v != null) qs.set(k, String(v));
        const r = await this.client.request(`/fast/snapshot?${qs.toString()}`, { method: 'GET' });
        if (r && !r.error) return r;
      } catch {}
    }
    return this.client.snapshot(opts);
  }

  async snapshotBinary(opts = {}) {
    return this.client.snapshotBinary(opts);
  }

  // —— 交互（坐标优先，selector 兜底）—— //
  async click(selector, opts = {}) {
    // 一键 fast：/act 一次 HTTP 完成（服务端 snapshot→mouse 或 click），比客户端两跳快 1 RTT
    try {
      const r = await this.client.request('/act', { method: 'POST', body: { action: 'click', selector, fast: true } });
      if (r && !r.error) return r;
    } catch {}
    return this.client.request('/click', { method: 'POST', body: { selector, fast: true } });
  }

  async clickText(text, opts = {}) {
    // 一键文本点击：服务端 /act 一次 HTTP 完成 snapshot→mouse→evaluate 兜底
    try {
      const r = await this.client.request('/act', { method: 'POST', body: { action: 'clickText', text, fast: true } });
      if (r && (r.success || r.result)) return r;
    } catch {}
    // 客户端兜底（旧路径）
    try {
      const snap = await this.client.snapshot({ maxElements: 50, fast: true });
      const hit = (snap.elements || []).find(e => (e.text || '').includes(text) || (e.name || '').includes(text));
      if (hit && hit.center) {
        const r = await this.client.request('/mouse', { method: 'POST', body: { type: 'click', x: hit.center.x, y: hit.center.y, fast: true } });
        if (r && !r.error) return { success: true, method: 'snapshot-text', text, point: [hit.center.x, hit.center.y] };
      }
    } catch {}
    const code = `return (()=>{ const els=[...document.querySelectorAll('a, button, [role=\"button\"]')]; const t=${JSON.stringify(text)}; const hit=els.find(e=> (e.innerText||e.textContent||'').includes(t)); if(hit){ hit.click(); return {tag:hit.tagName, text:hit.innerText?.slice(0,50)} } return null; })()`;
    const r = await this.client.request('/evaluate', { method: 'POST', body: { code } });
    if (r && r.result) return { success: true, method: 'evaluate-text', ...r.result };
    return { success: false, error: `text not found: ${text}` };
  }

  async fill(fields, opts = {}) {
    // fast 批量一次往返，服务端 /act 统一走 per-tab 队列
    try {
      const r = await this.client.request('/act', { method: 'POST', body: { action: 'fill', fields } });
      if (r && !r.error) return r;
    } catch {}
    return this.client.request('/fill', { method: 'POST', body: { fields } });
  }

  async type(selector, text, opts = {}) {
    try {
      const r = await this.client.request('/act', { method: 'POST', body: { action: 'type', selector, text, mode: opts.mode || 'fast' } });
      if (r && !r.error) return r;
    } catch {}
    return this.client.request('/type', { method: 'POST', body: { selector, text, mode: opts.mode || 'fast' } });
  }

  async extract(selectors, opts = {}) {
    // 一键提取：/act 一次 HTTP 完成多选择器
    try {
      const r = await this.client.request('/act', { method: 'POST', body: { action: 'extract', selectors } });
      if (r && !r.error) return r;
    } catch {}
    if (Array.isArray(selectors)) {
      const r = await this.client.request('/query-many', { method: 'POST', body: { selectors } });
      if (r && !r.error) return r;
    }
    const snap = await this.client.snapshot({ maxElements: 50, fast: true });
    const out = {};
    for (const sel of selectors) {
      const hit = (snap.elements || []).find(e => e.text && sel.includes(e.text.slice(0, 10)));
      out[sel] = hit ? hit.text : null;
    }
    return out;
  }

  async navigate(url, opts = {}) {
    try {
      const r = await this.client.request('/act', { method: 'POST', body: { action: 'navigate', url, current: !!opts.current } });
      if (r && !r.error) return r;
    } catch {}
    return this.client.request('/open', { method: 'POST', body: { url, current: !!opts.current } });
  }

  async act(action, data = {}) {
    // 兼容两种入参: act('navigate', {url}) 与 act({action:'navigate', url})(文档示例为对象形式, 原实现会收到 [object Object])
    if (action && typeof action === 'object') { data = action; action = data.action; }
    // 统一走服务端 /act 一次 HTTP（1 RTT）完成，失败回退本地
    try {
      const r = await this.client.request('/act', { method: 'POST', body: { action, ...data } });
      if (r && !r.error) return r;
    } catch {}
    const map = {
      snapshot: () => this.snapshot(data),
      click: () => this.click(data.selector, data),
      clickText: () => this.clickText(data.text, data),
      fill: () => this.fill(data.fields, data),
      type: () => this.type(data.selector, data.text, data),
      extract: () => this.extract(data.selectors, data),
      navigate: () => this.navigate(data.url, data),
      evaluate: () => this.client.request('/evaluate', { method: 'POST', body: { code: data.code } }),
    };
    const fn = map[action];
    if (!fn) throw new Error(`unknown action: ${action}`);
    return fn();
  }

  // —— 批量快路径 —— //
  async batch(steps, opts = {}) {
    // 自动加 _parallel 对只读，fast 透传
    const norm = steps.map(s => {
      const isRead = ['get-page-info','get-dom','query-selector','query-all','get-text'].includes(s.type);
      if (isRead && opts.parallel !== false) s.data = { ...(s.data||{}), _parallel: true };
      if (opts.fast) s.data = { ...(s.data||{}), fast: true };
      return s;
    });
    return this.client.batch(norm, opts);
  }
}

module.exports = { ArkFast };

// —— CLI —— //
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const fast = new ArkFast();
  (async () => {
    let r;
    switch (cmd) {
      case 'snapshot': {
        const opts = {};
        if (args.includes('--annotate')) opts.annotate = true;
        if (args.includes('--fast')) opts.fast = true;
        if (args.includes('--binary')) r = await fast.snapshotBinary(opts);
        else r = await fast.snapshot(opts);
        const file = args.find(a => a.endsWith('.png') || a.endsWith('.jpg'));
        if (file && r.dataUrl) {
          const b64 = r.dataUrl.split(',')[1];
          fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          console.log(JSON.stringify({ success: true, file, elements: r.elements?.length, url: r.url }, null, 2));
        } else if (r.buffer) {
          const file2 = args.find(a => a.endsWith('.png')) || 'snapshot.png';
          fs.writeFileSync(file2, r.buffer);
          console.log(JSON.stringify({ success: true, file: file2, len: r.buffer.length }, null, 2));
        } else {
          console.log(JSON.stringify(r, null, 2).slice(0, 2000));
        }
        break;
      }
      case 'click': r = await fast.click(args[1], { fast: args.includes('--fast') }); console.log(JSON.stringify(r, null, 2)); break;
      case 'clickText': r = await fast.clickText(args[1], { fast: args.includes('--fast') }); console.log(JSON.stringify(r, null, 2)); break;
      case 'fill': r = await fast.fill(JSON.parse(args[1])); console.log(JSON.stringify(r, null, 2)); break;
      case 'extract': r = await fast.extract(JSON.parse(args[1])); console.log(JSON.stringify(r, null, 2)); break;
      default: console.log('usage: node ark-fast.js <snapshot|click|clickText|fill|extract> [...] [--fast] [--annotate] [--binary]');
    }
  })();
}
