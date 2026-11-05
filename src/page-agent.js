/**
 * Ark Web 页面代理（Page Agent）
 *
 * 这段代码会被注入到每个 frame 的 isolated world，常驻并提供统一的 DOM 访问面：
 * 采集、定位、探测、点击、填写、断言、内嵌数据提取、表格与正文抽取。
 *
 * 设计约束（务必遵守）：
 *  1. 这个函数会被 chrome.scripting.executeScript 序列化后注入，**不能引用任何外部变量/import**。
 *  2. MV3 的 executeScript 不会 await 注入函数返回的 Promise，因此这里所有 API 必须是**同步**的。
 *  3. 不向真实 DOM 写入任何标记（ref 只存在于扩展侧），避免污染页面样式与框架 diff。
 *  4. 所有跨边界（shadow root / iframe）遍历都在这里完成，SW 侧只负责编排。
 */

export const AGENT_VERSION = 7;

export function PAGE_AGENT() {
  const V = 7;
  if (window.__ark && window.__ark.version === V) return { ok: true, version: V, fresh: false };

  // ── 基础 ────────────────────────────────────────────────────────────────
  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const SEL = 'a[href],button,input,textarea,select,summary,label,[role],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head']);

  /** 向上回溯：普通 DOM 走 parentElement，跨出 shadow root 走 host */
  const up = (node) => {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return root && root.host ? root.host : null;
  };

  const isOurUI = (el) => {
    try { return !!(el.closest && el.closest('[data-ark-ui]')); } catch { return false; }
  };

  /** 收集所有可遍历的根：document + 所有 open shadow root */
  const roots = () => {
    const out = [document];
    const scan = (root) => {
      let all;
      try { all = root.querySelectorAll('*'); } catch { return; }
      for (const el of all) {
        if (el.shadowRoot) { out.push(el.shadowRoot); scan(el.shadowRoot); }
      }
    };
    scan(document);
    return out;
  };

  /** 跨 shadow root 的 querySelectorAll */
  const deepAll = (selector, rootList) => {
    const rs = rootList || roots();
    const out = [];
    const seen = new Set();
    for (const r of rs) {
      let list;
      try { list = r.querySelectorAll(selector); } catch { continue; }
      for (const el of list) {
        if (seen.has(el) || isOurUI(el) || SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out;
  };

  // ── 可见性与几何 ────────────────────────────────────────────────────────
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch { return false; }
    if (r.width <= 1 || r.height <= 1) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch { return false; }
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch { /* 老版本参数不识别，忽略 */ }
    }
    return true;
  };

  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      cx: r.left + r.width / 2, cy: r.top + r.height / 2
    };
  };

  /** 取某坐标上真正接收事件的元素，穿透 shadow root */
  const pointOwner = (x, y) => {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    let el = document.elementFromPoint(x, y);
    let hops = 0;
    while (el && el.shadowRoot && hops++ < 6) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  /** 返回遮挡者描述；null 表示没被遮挡 */
  const coveredBy = (el, b) => {
    const at = pointOwner(b.cx, b.cy);
    if (!at) return 'offscreen';
    if (at === el) return null;
    try { if (el.contains(at) || at.contains(el)) return null; } catch { /* 跨 root 的 contains 不可靠 */ }
    let node = at, hops = 0;
    while (node && hops++ < 8) {
      if (node === el) return null;
      node = up(node);
    }
    const tag = (at.tagName || '').toLowerCase();
    return tag + (at.id ? '#' + at.id : '') + (at.className && typeof at.className === 'string' ? '.' + at.className.trim().split(/\s+/)[0] : '');
  };

  /** 本 frame 相对顶层视口的偏移；跨域时返回 null（此时只能退化为合成事件） */
  const frameOffset = () => {
    let x = 0, y = 0, w = window, hops = 0;
    while (w && w !== w.parent && hops++ < 8) {
      let fe;
      try { fe = w.frameElement; } catch { return null; }
      if (!fe) return null;
      const r = fe.getBoundingClientRect();
      x += r.left;
      y += r.top;
      try { w = w.parent; } catch { return null; }
    }
    return { x: Math.round(x), y: Math.round(y) };
  };

  // ── 语义属性 ────────────────────────────────────────────────────────────
  const INPUT_ROLE = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    submit: 'button', button: 'button', reset: 'button', image: 'button',
    search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    password: 'textbox', text: 'textbox', file: 'button', color: 'button'
  };

  const roleOf = (el) => {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) {
      const first = norm(r).split(' ')[0].toLowerCase();
      if (first === 'none' || first === 'presentation') { /* 继续按标签推断 */ }
      else return first;
    }
    const t = el.tagName.toLowerCase();
    if (t === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'button') return 'button';
    if (t === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'summary') return 'button';
    if (t === 'label') return 'label';
    if (t === 'input') return INPUT_ROLE[el.type] || 'textbox';
    if (el.isContentEditable) return 'textbox';
    return t;
  };

  const labelText = (el) => {
    const aria = norm(el.getAttribute && el.getAttribute('aria-label'));
    if (aria) return aria;
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? norm(n.innerText) : '';
      }).join(' ');
      if (norm(t)) return norm(t);
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map((l) => norm(l.innerText)).join(' ');
      if (norm(t)) return norm(t);
    }
    return '';
  };

  /** 元素的可读名称：给 AI 看的，不是给屏幕阅读器的完整算法，但覆盖 95% 场景 */
  const nameOf = (el) => {
    const lab = labelText(el);
    if (lab) return lab.slice(0, 160);
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.type === 'password') {
        // 密码值绝不能通过 text / value / attrs 任一路径泄漏
        return String(el.value || '').length ? '••••••' : (norm(el.getAttribute('placeholder')) || '密码框');
      }
      const v = el.tagName === 'SELECT'
        ? norm(Array.from(el.selectedOptions || []).map((o) => o.text).join(' '))
        : norm(el.value);
      if (el.type === 'checkbox' || el.type === 'radio') {
        return v ? '[' + (el.checked ? 'x' : ' ') + '] ' + v : (el.checked ? '已选中' : '');
      }
      const ph = norm(el.getAttribute('placeholder'));
      const ti = norm(el.getAttribute('title'));
      return (v ? v.slice(0, 80) : '') || ph || ti || norm(el.getAttribute('name'));
    }
    const t = norm(el.innerText || el.textContent);
    if (t) return t.slice(0, 160);
    return norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.id);
  };

  /** 元素所处的语义区块：最近一层带 aria-label 或带标题的祖先 */
  const contextOf = (el) => {
    let node = el, hops = 0;
    while (node && hops++ < 14) {
      const parent = up(node);
      if (!parent) break;
      if (parent.getAttribute) {
        const aria = norm(parent.getAttribute('aria-label'));
        if (aria) return aria.slice(0, 60);
      }
      let head = null;
      try {
        head = parent.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > legend,:scope > caption,:scope > [role=heading]');
      } catch { /* :scope 在个别环境不可用 */ }
      if (head) {
        const t = norm(head.innerText);
        if (t) return t.slice(0, 60);
      }
      node = parent;
    }
    return '';
  };

  const isEditable = (el) => {
    const t = el.tagName;
    if (t === 'TEXTAREA') return true;
    if (t === 'INPUT') return !/^(button|submit|reset|checkbox|radio|file|range|color|image)$/i.test(el.type || 'text');
    return el.isContentEditable === true;
  };

  const valueOf = (el) => {
    const t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'true' : 'false';
      // 密码框永不回传明文：快照/日志/审计里都不能出现
      if (el.type === 'password') return '••••••';
      return String(el.value == null ? '' : el.value).slice(0, 200);
    }
    if (t === 'SELECT') return Array.from(el.selectedOptions || []).map((o) => o.value).join(',');
    if (el.isContentEditable) return norm(el.innerText).slice(0, 200);
    return '';
  };

  // ── 堆池：localRef 的载体 ───────────────────────────────────────────────
  // 用「只增不减的池 + WeakMap 索引」代替把编号写进 DOM：
  // collect 与 find 共用同一个池，因此上一次 find 拿到的 localRef 本次仍然可用。
  // WeakRef 避免 pool 永久持有已脱离文档的 DOM 子树（长期 SPA 必备）；
  // 编号仍然稳定，只是元素被 GC 后 at(i) 返回 undefined。
  const useWeak = typeof WeakRef === 'function';
  const pool = [];
  const elIdx = new WeakMap();
  const elRefs = new WeakMap(); // el -> 扩展侧分配的全局 ref

  const idxOf = (el) => {
    let i = elIdx.get(el);
    if (i === undefined) {
      i = pool.length;
      pool.push(useWeak ? { w: new WeakRef(el) } : { v: el });
      elIdx.set(el, i);
    }
    return i;
  };
  const at = (i) => {
    const x = pool[i];
    if (!x) return undefined;
    return x.w ? x.w.deref() : x.v;
  };

  // ── 采集 ────────────────────────────────────────────────────────────────
  const collect = (opts) => {
    opts = opts || {};
    const limit = opts.limit || 400;
    const wantHidden = opts.hidden === true;
    const rootList = roots();
    const all = deepAll(opts.selector || SEL, rootList);
    const vw = innerWidth, vh = innerHeight;
    const out = [];
    for (const el of all) {
      const vis = visible(el);
      if (!vis && !wantHidden) continue;
      const b = boxOf(el);
      const inView = b.y + b.h > 0 && b.y < vh && b.x + b.w > 0 && b.x < vw;
      out.push({
        localRef: idxOf(el),
        prevRef: elRefs.get(el) || 0,
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        type: el.type || null,
        text: nameOf(el),
        context: contextOf(el),
        href: el.tagName === 'A' ? el.href : null,
        value: valueOf(el) || null,
        disabled: !!(el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')),
        visible: vis,
        inView,
        x: b.x, y: b.y, w: b.w, h: b.h
      });
      if (out.length >= limit) break;
    }
    return {
      url: location.href, title: document.title,
      vw, vh, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
      vis: document.visibilityState, dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
      count: out.length, elements: out,
      offset: frameOffset(), total: all.length
    };
  };

  // ── 语义定位（find）─────────────────────────────────────────────────────
  const scoreOf = (el, needle, wantRole) => {
    const text = norm(el.innerText || el.textContent).toLowerCase();
    const attrs = {
      aria: norm(el.getAttribute('aria-label')).toLowerCase(),
      ph: norm(el.getAttribute('placeholder')).toLowerCase(),
      title: norm(el.getAttribute('title')).toLowerCase(),
      name: norm(el.getAttribute('name')).toLowerCase(),
      id: norm(el.id).toLowerCase(),
      testid: norm(el.getAttribute('data-testid')).toLowerCase()
    };
    const role = roleOf(el);
    if (wantRole && role !== wantRole) return null;
    let score = 0;
    const why = [];
    if (needle) {
      const hit = (v, w, label) => {
        if (!v) return;
        if (v === needle) { score += w; why.push(label + ':exact'); }
        else if (v.startsWith(needle)) { score += w * 0.85; why.push(label + ':prefix'); }
        else if (v.includes(needle)) { score += w * 0.6; why.push(label + ':contains'); }
      };
      hit(text, 100, 'text');
      hit(attrs.aria, 95, 'aria');
      hit(attrs.ph, 85, 'placeholder');
      hit(attrs.testid, 75, 'testid');
      hit(attrs.title, 60, 'title');
      hit(attrs.name, 50, 'name');
      hit(attrs.id, 40, 'id');
      if (score <= 0) return null;
    }
    return { score, why, role, text };
  };

  const find = (q, opts) => {
    opts = opts || {};
    const needle = norm(q).toLowerCase();
    const wantRole = opts.role ? String(opts.role).toLowerCase() : null;
    const limit = Math.max(1, opts.limit || 5);
    const includeHidden = opts.hidden === true;
    const rootList = roots();
    const poolList = opts.selector ? deepAll(opts.selector, rootList) : deepAll(SEL, rootList);
    const items = [];
    for (const el of poolList) {
      const s = scoreOf(el, needle, wantRole);
      if (!s) continue;
      const vis = visible(el);
      if (!vis && !includeHidden) continue;
      const b = boxOf(el);
      const cov = vis ? coveredBy(el, b) : null;
      const enabled = !(el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
      let score = s.score;
      if (vis) score += 20; else score -= 40;
      if (enabled) score += 10; else score -= 30;
      if (cov) score -= 35;
      items.push({
        localRef: idxOf(el),
        prevRef: elRefs.get(el) || 0,
        tag: el.tagName.toLowerCase(),
        role: s.role,
        href: el.tagName === 'A' ? el.href : null,
        text: nameOf(el).slice(0, 100),
        context: contextOf(el),
        score: Math.round(score),
        why: s.why.join(','),
        visible: vis,
        enabled,
        coveredBy: cov,
        clickable: vis && enabled && !cov,
        rect: { x: b.x, y: b.y, w: b.w, h: b.h }
      });
    }
    items.sort((a, b) => b.score - a.score);
    return { query: q, role: wantRole, total: items.length, items: items.slice(0, limit), offset: frameOffset() };
  };

  // ── 探测单个元素 ────────────────────────────────────────────────────────
  const probe = (i, opts) => {
    const el = at(i);
    if (!el) return { missing: true };
    if (!el.isConnected) return { missing: true, detached: true };
    // 悬停后重测只需要新坐标，不要再次滚动页面（scroll:false）
    if (!opts || opts.scroll !== false) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
      catch { try { el.scrollIntoView(); } catch { /* 忽略 */ } }
    }
    const b = boxOf(el);
    const vis = visible(el);
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      href: el.tagName === 'A' ? el.href : null,
      text: nameOf(el).slice(0, 160),
      visible: vis,
      enabled: !(el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')),
      coveredBy: vis ? coveredBy(el, b) : null,
      rect: { x: b.x, y: b.y, w: b.w, h: b.h },
      point: { x: Math.round(b.cx), y: Math.round(b.cy) },
      inViewport: b.cx >= 0 && b.cy >= 0 && b.cx <= innerWidth && b.cy <= innerHeight,
      offset: frameOffset(),
      value: valueOf(el),
      editable: isEditable(el),
      kind: el.tagName === 'SELECT' ? 'select' : (isEditable(el) ? 'editable' : 'plain')
    };
  };

  // ── 动作（供跨域/降级路径使用；主路径走 CDP 真输入）────────────────────
  const clickLocal = (i) => {
    const el = at(i);
    if (!el || !el.isConnected) return { ok: false, error: '元素已失效' };
    try {
      el.click();
      return { ok: true, tag: el.tagName.toLowerCase() };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  };

  const hoverLocal = (i) => {
    const el = at(i);
    if (!el || !el.isConnected) return { ok: false, error: '元素已失效' };
    const b = boxOf(el);
    const o = { bubbles: true, cancelable: true, clientX: b.cx, clientY: b.cy, view: window };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      el.dispatchEvent(type.startsWith('pointer') && window.PointerEvent
        ? new PointerEvent(type, o)
        : new MouseEvent(type, o));
    }
    return { ok: true, tag: el.tagName.toLowerCase() };
  };

  const selectContents = (el) => {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch { return false; }
  };

  const focusLocal = (i, opts) => {
    const el = at(i);
    if (!el || !el.isConnected) return { ok: false, error: '元素已失效' };
    el.focus();
    if (el.isContentEditable) {
      // 只有 fill 需要“先全选再替换”；press 只聚焦，不应清空原有内容
      if (opts && opts.selectAll === true) selectContents(el);
    } else {
      try { if (el.select && el.tagName !== 'SELECT') el.select(); } catch { /* 忽略 */ }
    }
    return { ok: true, focused: document.activeElement === el || el.isContentEditable };
  };

  const fillLocal = (i, text) => {
    const el = at(i);
    if (!el || !el.isConnected) return { ok: false, error: '元素已失效' };
    if (!isEditable(el)) return { ok: false, error: '元素不可编辑' };
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      try {
        if (setter && setter.set) setter.set.call(el, text); else el.value = text;
      } catch { el.value = text; }
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      } catch { el.dispatchEvent(new Event('input', { bubbles: true })); }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      let done = false;
      try {
        selectContents(el);
        done = document.execCommand('insertText', false, text);
      } catch { done = false; }
      if (!done) el.textContent = text;
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      } catch { el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    return { ok: true, value: valueOf(el), via: 'dom' };
  };

  const selectLocal = (i, values) => {
    const el = at(i);
    if (!el || !el.isConnected) return { ok: false, error: '元素已失效' };
    if (el.tagName !== 'SELECT') return { ok: false, error: 'not-native-select', role: roleOf(el) };
    const want = (Array.isArray(values) ? values : [values]).map(String);
    const picked = [];
    for (const opt of el.options) {
      let on = want.includes(opt.value) || want.includes(norm(opt.text));
      if (on && !el.multiple && picked.length > 0) on = false; // 单选只取第一个命中
      opt.selected = on;
      if (on) picked.push(opt.value);
    }
    if (!picked.length) {
      return {
        ok: false, error: 'option-not-found',
        available: Array.from(el.options).slice(0, 50).map((o) => ({ value: o.value, text: norm(o.text) }))
      };
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, picked, value: valueOf(el) };
  };

  const hoverState = (i) => {
    const el = at(i);
    if (!el || !el.isConnected) return { ok: false, hover: false, chain: 0 };
    let chain = 0, n = el, hops = 0;
    try { chain = document.querySelectorAll(':hover').length; } catch { /* 忽略 */ }
    while (n && hops++ < 20) {
      try { if (n.matches && n.matches(':hover')) return { ok: true, hover: true, chain }; } catch { /* 忽略 */ }
      n = up(n);
    }
    return { ok: true, hover: false, chain };
  };

  const readLocal = (i) => {
    const el = at(i);
    if (!el || !el.isConnected) return { ok: false, error: '元素已失效' };
    return { ok: true, value: valueOf(el), text: nameOf(el).slice(0, 400), tag: el.tagName.toLowerCase() };
  };

  /**
   * 在页面内比较填写结果，不把密码明文带回扩展侧。
   * exact 用于 input/textarea，contains 用于富文本（浏览器可能规范化空白）。
   */
  const verifyValue = (i, text) => {
    const el = at(i);
    if (!el || !el.isConnected) return { ok: false, error: '元素已失效' };
    const want = String(text == null ? '' : text);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return {
        ok: true, exact: String(el.value) === want, contains: String(el.value).includes(want),
        length: String(el.value).length, masked: el.type === 'password'
      };
    }
    const got = norm(el.innerText || el.textContent);
    const w = norm(want);
    return { ok: true, exact: got === w, contains: got.includes(w), length: got.length, masked: false };
  };

  /** 元素属性全量（attr 命令） */
  const attrsOf = (i) => {
    const el = at(i);
    if (!el || !el.isConnected) return null;
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    if (String(el.type || attrs.type || '').toLowerCase() === 'password' && attrs.value != null) attrs.value = '••••••';
    const b = boxOf(el);
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      attrs,
      text: nameOf(el).slice(0, 500),
      value: valueOf(el),
      context: contextOf(el),
      box: { x: b.x, y: b.y, w: b.w, h: b.h },
      visible: visible(el),
      enabled: !(el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')),
      coveredBy: visible(el) ? coveredBy(el, b) : null
    };
  };

  // ── 断言 ────────────────────────────────────────────────────────────────
  const assertOn = (el, spec) => {
    if (!el) return { pass: false, kind: 'missing', actual: null, expected: spec.text ?? spec.value ?? spec.attr ?? spec.count };
    if (spec.text != null) {
      const actual = norm(el.innerText || el.textContent);
      const expected = norm(spec.text);
      const pass = spec.exact ? actual === expected : actual.includes(expected);
      return { pass, kind: 'text', actual: actual.slice(0, 300), expected };
    }
    if (spec.value != null) {
      const actual = valueOf(el);
      return { pass: actual === String(spec.value), kind: 'value', actual, expected: String(spec.value) };
    }
    if (spec.attr != null) {
      const actual = el.getAttribute(spec.attr);
      const expected = spec.equals == null ? null : String(spec.equals);
      const pass = expected == null ? actual != null : actual === expected;
      return { pass, kind: 'attr', attr: spec.attr, actual, expected };
    }
    if (spec.visible != null) {
      const actual = visible(el);
      return { pass: actual === (spec.visible === true || spec.visible === 'true'), kind: 'visible', actual, expected: spec.visible };
    }
    return { pass: true, kind: 'exists', actual: true, expected: true };
  };

  const assertLocal = (spec) => {
    spec = spec || {};
    if (spec.selector) {
      const list = deepAll(spec.selector);
      if (spec.count != null) {
        return { pass: list.length === Number(spec.count), kind: 'count', actual: list.length, expected: Number(spec.count) };
      }
      return assertOn(list[0] || null, spec);
    }
    if (spec.localRef != null) return assertOn(at(spec.localRef), spec);
    return { pass: false, kind: 'param', error: 'assert 需要 selector 或 ref' };
  };

  // ── 内嵌结构化数据（SPA 的金矿）─────────────────────────────────────────
  const state = (maxBytes) => {
    const cap = maxBytes || 6000;
    const out = [];
    const push = (kind, raw, extra) => {
      if (raw == null) return;
      const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (!s || s.length < 2) return;
      out.push(Object.assign({ kind, bytes: s.length, truncated: s.length > cap, data: s.slice(0, cap) }, extra || {}));
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) push('json-ld', s.textContent);
    const next = document.getElementById('__NEXT_DATA__');
    if (next) push('next-data', next.textContent);
    const nuxt = document.getElementById('__NUXT_DATA__') || document.getElementById('__NUXT__');
    if (nuxt) push('nuxt', nuxt.textContent);
    for (const key of ['__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__REDUX_STATE__', '__DATA__']) {
      try { if (window[key] != null) push('window.' + key, window[key]); } catch { /* 忽略 */ }
    }
    const meta = {};
    for (const m of document.querySelectorAll('meta[property^="og:"],meta[name="description"],meta[name="twitter:title"]')) {
      const k = m.getAttribute('property') || m.getAttribute('name');
      if (k) meta[k] = m.getAttribute('content');
    }
    const canon = document.querySelector('link[rel="canonical"]');
    if (canon) meta.canonical = canon.href;
    return { url: location.href, title: document.title, sources: out, meta, found: out.length };
  };

  // ── 结构化抽取（跨 shadow）──────────────────────────────────────────────
  const rows = (containerSel, fieldSpecs, limit, includeMeta) => {
    const nodes = deepAll(containerSel);
    const out = nodes.slice(0, limit).map((el, idx) => {
      const row = includeMeta ? { _index: idx } : {};
      for (const f of fieldSpecs) {
        let target = el;
        if (f.sel && f.sel !== 'self') {
          try { target = el.querySelector(f.sel); } catch { target = null; }
          if (!target && el.shadowRoot) {
            try { target = el.shadowRoot.querySelector(f.sel); } catch { /* 忽略 */ }
          }
        }
        if (!target) { row[f.name] = null; continue; }
        if (f.attr) {
          if (f.attr === 'html') { row[f.name] = target.innerHTML.slice(0, 2000); continue; }
          if (f.attr === 'text') { row[f.name] = norm(target.innerText || target.textContent); continue; }
          let v = target.getAttribute(f.attr);
          if (f.attr === 'href' && target.href) v = target.href;
          if (f.attr === 'src' && target.src) v = target.src;
          row[f.name] = v;
        } else {
          row[f.name] = norm(target.innerText || target.textContent);
        }
      }
      return row;
    });
    return { count: nodes.length, rows: out, url: location.href, title: document.title };
  };

  const table = (sel, idx, limit) => {
    const tables = sel && sel !== 'all' ? deepAll(sel) : deepAll('table');
    const info = { tablesFound: tables.length };
    if (!tables.length) return Object.assign(info, { error: 'no table found' });
    const index = Math.min(Math.max(0, Number(idx) || 0), tables.length - 1);
    const t = tables[index];
    const rows = Array.from(t.rows || []);
    if (!rows.length) return Object.assign(info, { error: 'table has no rows' });

    // 先展开成二维网格：rowspan 向下填充，colspan 向右填充。
    const grid = [];
    const textOf = (c) => norm(c.innerText || c.textContent);
    for (let r = 0; r < rows.length; r++) {
      const tr = rows[r];
      if (!grid[r]) grid[r] = [];
      let col = 0;
      for (const cell of Array.from(tr.cells || [])) {
        while (grid[r][col] !== undefined) col++;
        const txt = textOf(cell);
        const rowspan = Math.max(1, Number(cell.rowSpan) || 1);
        const colspan = Math.max(1, Number(cell.colSpan) || 1);
        for (let i = 0; i < rowspan; i++) {
          if (!grid[r + i]) grid[r + i] = [];
          for (let j = 0; j < colspan; j++) {
            if (grid[r + i][col + j] === undefined) grid[r + i][col + j] = txt;
          }
        }
        col += colspan;
      }
    }

    // 连续的表头行：从第一行开始，直到某行不再含 TH。
    let headerCount = 0;
    for (const tr of rows) {
      if (Array.from(tr.cells || []).some((c) => String(c.tagName).toLowerCase() === 'th')) headerCount++;
      else break;
    }
    if (headerCount === 0) headerCount = Math.min(1, grid.length);
    headerCount = Math.max(1, Math.min(headerCount, grid.length));

    const maxCols = grid.reduce((n, r) => Math.max(n, r.length), 0);
    const headerRaw = [];
    for (let c = 0; c < maxCols; c++) {
      const parts = [];
      for (let r = 0; r < headerCount; r++) {
        const v = grid[r] && grid[r][c];
        if (v && !parts.includes(v)) parts.push(v);
      }
      headerRaw.push(parts.join(' / ') || ('col' + (c + 1)));
    }
    // 多行表头/colspan 可能产生重复列名，追加序号保证对象 key 唯一
    const header = [];
    const used = new Set();
    for (let i = 0; i < headerRaw.length; i++) {
      let key = headerRaw[i];
      if (used.has(key)) key = key + '#' + (i + 1);
      used.add(key);
      header.push(key);
    }

    const dataRows = grid.slice(headerCount).filter((r) => r && r.some((v) => v !== undefined && v !== ''));
    const out = dataRows.slice(0, Math.max(0, Number(limit) || 200)).map((row) => {
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = row[c] === undefined ? '' : row[c];
      return obj;
    });
    return Object.assign(info, {
      index, header, rows: out,
      totalRows: dataRows.length,
      rowspanColspan: true,
      caption: norm(t.caption && t.caption.innerText)
    });
  };

  // ── 正文抽取（Markdown 风格）────────────────────────────────────────────
  const pageText = (maxLen) => {
    const cap = Number(maxLen) > 0 ? Number(maxLen) : 20000;
    // 选“文本量最大”的候选容器，而不是 DOM 里第一个 article（很多站点第一个是侧栏卡片）
    let root = document.body;
    let best = -1;
    for (const c of document.querySelectorAll('article, main, [role=main]')) {
      const n = norm(c.innerText || c.textContent || '').length;
      if (n > best) { best = n; root = c; }
    }
    if (!root) return { url: location.href, title: document.title, text: '', chars: 0 };

    const lines = [];
    let budget = 0;
    const add = (t) => { if (!t) return; lines.push(t); budget += t.length; };
    const walk = (node) => {
      if (!node || budget > cap) return;
      for (const child of node.children || []) {
        if (budget > cap) break;
        // 递归进入 open shadow root：正文在 Web Component 里也能抽到
        if (child.shadowRoot) { walk(child.shadowRoot); continue; }
        const tag = (child.tagName || '').toLowerCase();
        if (!tag || SKIP_TAGS.has(tag) || tag === 'iframe' || tag === 'svg') continue;
        if (/^h[1-6]$/.test(tag)) {
          const t = norm(child.innerText);
          if (t) add('\n' + '#'.repeat(Number(tag[1])) + ' ' + t + '\n');
          continue;
        }
        if (tag === 'li') {
          const t = norm(child.innerText);
          if (t) add('- ' + t);
          continue;
        }
        if (['p', 'div', 'section', 'article', 'blockquote', 'pre', 'td', 'th', 'figcaption'].includes(tag)) {
          const direct = Array.from(child.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => norm(n.textContent))
            .filter(Boolean)
            .join(' ');
          if (direct) add(direct);
          walk(child);
          continue;
        }
        const t = norm(child.innerText || '');
        if (t && !(child.children || []).length) add(t);
        else walk(child);
      }
    };
    walk(root);
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, cap);
    return { url: location.href, title: document.title, chars: text.length, text };
  };

  // ── 视觉编号层（SoM：把 ref 画进截图）──────────────────────────────────
  let overlay = null;
  const clearLabels = () => {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    return { cleared: true };
  };
  const label = (items, opts) => {
    clearLabels();
    opts = opts || {};
    const host = document.createElement('div');
    host.setAttribute('data-ark-ui', '1');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const sr = host.attachShadow({ mode: 'closed' });
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0;font:11px/1 ui-monospace,monospace;';
    sr.appendChild(wrap);
    let n = 0;
    for (const it of items) {
      if (it.w < 3 || it.h < 3) continue;
      const box = document.createElement('div');
      const hot = it.clickable !== false;
      box.style.cssText = 'position:absolute;left:' + it.x + 'px;top:' + it.y + 'px;width:' + it.w + 'px;height:' + it.h +
        'px;border:1.5px solid ' + (hot ? '#0a84ff' : '#8e8e93') + ';border-radius:3px;background:' +
        (hot ? 'rgba(10,132,255,.08)' : 'rgba(142,142,147,.08)') + ';';
      const tag = document.createElement('span');
      tag.textContent = String(it.ref);
      tag.style.cssText = 'position:absolute;left:-1px;top:-15px;background:' + (hot ? '#0a84ff' : '#8e8e93') +
        ';color:#fff;padding:1px 4px;border-radius:3px 3px 3px 0;font-weight:600;';
      box.appendChild(tag);
      wrap.appendChild(box);
      n++;
    }
    document.documentElement.appendChild(host);
    overlay = host;
    return { labeled: n };
  };

  // ── 临时标记（给 CDP DOM.setFileInputFiles 之类需要选择器的场景用）────────
  let tmpSeq = 0;
  const markTmp = (i) => {
    const el = at(i);
    if (!el) return null;
    const key = 'k' + (++tmpSeq) + '-' + Date.now().toString(36);
    el.setAttribute('data-ark-tmp', key);
    return '[data-ark-tmp="' + key + '"]';
  };
  const markSelectorTmp = (sel) => {
    let list;
    try { list = deepAll(String(sel)); } catch { list = []; }
    const el = list[0];
    if (!el) return null;
    const key = 's' + (++tmpSeq) + '-' + Date.now().toString(36);
    el.setAttribute('data-ark-tmp', key);
    return { selector: '[data-ark-tmp="' + key + '"]', tag: el.tagName.toLowerCase(), type: el.type || null };
  };
  const clearTmp = () => {
    for (const el of deepAll('[data-ark-tmp]')) {
      try { el.removeAttribute('data-ark-tmp'); } catch { /* 忽略 */ }
    }
    return true;
  };
  const fileInfo = (sel) => {
    let list;
    try { list = deepAll(String(sel)); } catch { list = []; }
    const el = list[0];
    if (!el) return { found: false };
    if (!el.files) return { found: true, isFile: false, tag: el.tagName.toLowerCase() };
    return {
      found: true, isFile: true,
      count: el.files.length,
      files: Array.from(el.files).map((f) => ({ name: f.name, size: f.size, type: f.type || '' }))
    };
  };

  window.__ark = {
    version: V,
    collect, find, probe,
    clickLocal, hoverLocal, hoverState, focusLocal, fillLocal, selectLocal, readLocal, verifyValue, attrsOf,
    markTmp, markSelectorTmp, clearTmp, fileInfo,
    assignRefs: (pairs) => {
      let n = 0;
      for (const p of pairs || []) {
        const el = at(p[0]);
        if (el) { elRefs.set(el, p[1]); n++; }
      }
      return n;
    },
    assertLocal, state, rows, table, pageText, label, clearLabels,
    // 便于排查：返回当前池大小与页面基本信息
    info: () => ({ url: location.href, title: document.title, pool: pool.length, vw: innerWidth, vh: innerHeight })
  };

  return { ok: true, version: V, fresh: true };
}
