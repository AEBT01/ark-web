/**
 * 能力注册表（Router）—— Ark Agent 的单一事实来源
 *
 * 这个模块存在的理由，是消灭"同一份能力被写在四个地方"的结构病：
 *   过去：路由在 bridge-server 的 150 分支 switch、工具 schema 在 tool-registry.js、
 *         中文标签在面板 panel.js、端点说明在 SKILL.md —— 四份手工同步的副本。
 *   现在：一个能力模块同时声明 routes（给人/程序调用）与 tools（给模型 function-calling），
 *         并由本注册表统一导出 catalog（给界面与文档）。
 *
 * 设计取舍：
 *   · 路由键支持三种形态：精确 `/tabs`、参数 `/audit/status/:id`、前缀 `/monitor*`
 *     —— 与迁移前 switch + startsWith 的判定顺序保持一致（先精确，再按注册顺序）。
 *   · 处理器签名为 `(ctx) => result`，ctx 由 HTTP 外壳构造。处理器若已自行写过响应
 *     （如 SSE、或直接调用 ctx.send），返回 undefined 即可，外壳以 headersSent 判定。
 */

class Router {
  constructor() {
    this.caps = new Map();       // name -> capability
    this.exact = new Map();      // path -> { cap, key, fn }
    this.patterns = [];          // [{ re, keys, cap, key, fn, order }]
    this.order = 0;
  }

  /** 注册一个能力模块 */
  use(cap) {
    if (!cap || !cap.name) throw new Error('能力模块必须有 name');
    if (this.caps.has(cap.name)) throw new Error('能力已注册: ' + cap.name);
    this.caps.set(cap.name, cap);
    const routes = cap.routes || {};
    for (const [key, fn] of Object.entries(routes)) {
      if (typeof fn !== 'function') throw new Error(`${cap.name} 的路由 ${key} 不是函数`);
      const entry = { cap: cap.name, key, fn, order: this.order++ };
      if (key.includes('*')) {
        const base = key.replace(/\*+$/, '');
        this.patterns.push(Object.assign({ type: 'prefix', base }, entry));
      } else if (key.includes(':')) {
        const names = [];
        const re = new RegExp('^' + key.replace(/:[A-Za-z_$][\w$]*/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
        this.patterns.push(Object.assign({ type: 'param', re, names }, entry));
      } else {
        if (this.exact.has(key)) throw new Error(`路由冲突: ${key}（${this.exact.get(key).cap} 与 ${cap.name}）`);
        this.exact.set(key, entry);
      }
    }
    if (typeof cap.init === 'function') cap.init(this);
    return this;
  }

  /** 解析请求路径 → 路由 */
  resolve(pathname) {
    const hit = this.exact.get(pathname);
    if (hit) return { cap: hit.cap, key: hit.key, fn: hit.fn, params: {} };
    for (const p of this.patterns) {
      if (p.type === 'prefix') {
        if (pathname.startsWith(p.base)) return { cap: p.cap, key: p.key, fn: p.fn, params: {} };
      } else {
        const m = p.re.exec(pathname);
        if (m) {
          const params = {};
          p.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
          return { cap: p.cap, key: p.key, fn: p.fn, params };
        }
      }
    }
    return null;
  }

  has(pathname) { return !!this.resolve(pathname); }

  /** 全部路由（用于生成端点清单，替代手工维护的 listEndpoints） */
  routes() {
    const out = [];
    for (const [path, e] of this.exact) out.push({ path, cap: e.cap, doc: (this.caps.get(e.cap) || {}).doc || '' });
    for (const p of this.patterns) out.push({ path: p.type === 'prefix' ? p.base + '*' : p.key, cap: p.cap, doc: (this.caps.get(p.cap) || {}).doc || '' });
    return out;
  }

  /** 端点清单文本（启动时打印 / 供自省） */
  list() {
    return this.routes().map(r => `ANY  ${r.path}`).sort();
  }

  /** 汇总所有能力声明的 agent 工具 */
  tools() {
    const out = [];
    for (const cap of this.caps.values()) {
      for (const t of (cap.tools || [])) out.push(Object.assign({ capability: cap.name }, t));
    }
    return out.concat(this._toolSource ? this._toolSource() : []);
  }

  /**
   * 注入工具来源（工具注册表）—— 路由与工具是"服务能做什么"的两个侧面，
   * 由本注册表统一出口，界面/文档只问一处，不必分别对接。
   */
  setToolSource(fn) { this._toolSource = typeof fn === 'function' ? fn : null; return this; }

  /** 能力目录：界面/文档据此渲染，不再手工维护标签 */
  catalog() {
    return Array.from(this.caps.values()).map(cap => ({
      name: cap.name,
      group: cap.group || cap.name,
      doc: cap.doc || '',
      // 产品面（本机配置）与技能接口的分界：调用方据此过滤（agent 侧只看非 internal 的）
      internal: !!cap.internal,
      routes: Object.keys(cap.routes || {}),
      tools: (cap.tools || []).map(t => ({ name: t.name, risk: t.risk || 'low', desc: t.desc || '', label: t.label || '' }))
    }));
  }

  stats() {
    return {
      capabilities: this.caps.size,
      routes: this.exact.size + this.patterns.length,
      tools: this.tools().length
    };
  }
}

module.exports = { Router };
