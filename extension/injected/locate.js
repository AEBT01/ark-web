/* 本文件由 scripts/sync.js 从 semantic/locate.js 自动生成，请勿直接编辑 —— 改源码后重新运行同步。 */
/**
 * Ark Semantic Locate — 语义锚点定位脚本（注入页面执行）
 *
 * 职责：把「语义单元的路径/文本 + 交互元素条件」解析成页面上的真实元素，
 *       返回坐标与临时标记，供上层执行真实点击 / 输入。
 *
 * 设计约束：
 *  - 与 extractor.js 同源：零依赖、确定性、可降级（路径失效时按文本回退）
 *  - 不做决策：只回答"符合条件的元素是哪个、有几个、在哪"，选择由上层负责
 *  - 标记用 data-ark-sem 属性（可被 /reset-all 或下次定位清除）
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ArkSemanticLocate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INTERACTIVE_SEL = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick],[contenteditable="true"]';
  const MARK_ATTR = 'data-ark-sem';

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input' || tag === 'textarea') return 'input';
    if (tag === 'select') return 'select';
    return 'other';
  }

  function labelOf(el) {
    let s = '';
    try {
      s = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder'))) || el.innerText || el.value || '';
    } catch (e) { s = ''; }
    return norm(s);
  }

  /**
   * 定位单元元素：路径优先，失败时按文本前缀回退。
   * 路径命中但内容不匹配视为失效（页面结构性变化），同样回退。
   * 未提供任何线索时返回 document.body —— 全页范围定位（如"页面上任意位置的输入框"）。
   */
  function findUnit(spec) {
    if (!spec.path && !spec.textPrefix) return document.body;
    let el = null;
    if (spec.path) {
      try { el = document.querySelector(spec.path); } catch (e) { el = null; }
      if (el && spec.textPrefix) {
        const t = norm(el.innerText);
        if (t.indexOf(spec.textPrefix.slice(0, 24)) < 0) el = null;
      }
    }
    if (!el && spec.textPrefix) {
      const probe = spec.textPrefix.slice(0, 30);
      const all = document.querySelectorAll('body *');
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (!e.children.length) continue;                    // 只看容器，避免命中行内碎片
        const t = norm(e.innerText);
        if (t.indexOf(probe) >= 0 && t.length < probe.length * 4) { el = e; break; }
      }
    }
    return el;
  }

  /**
   * 主入口
   * spec = { path, textPrefix, criteria: { kind, labelIncludes, tag, index } }
   * 返回 { ok, unitText, candidateCount, candidates[], target{...} } 或 { ok:false, error }
   */
  function locate(spec) {
    const out = { ok: false };
    const unitEl = findUnit(spec || {});
    if (!unitEl) { out.error = 'unit-not-found'; return out; }
    out.unitText = norm(unitEl.innerText).slice(0, 60);

    const crit = (spec && spec.criteria) || {};
    let nodes = [];
    try { nodes = Array.prototype.slice.call(unitEl.querySelectorAll(INTERACTIVE_SEL)); } catch (e) { nodes = []; }
    if (unitEl.matches && unitEl.matches(INTERACTIVE_SEL)) nodes.unshift(unitEl);

    const total = nodes.length;
    if (crit.kind) {
      nodes = nodes.filter(function (n) { return kindOf(n) === crit.kind; });
    }
    if (crit.tag) {
      const want = String(crit.tag).toLowerCase();
      nodes = nodes.filter(function (n) { return n.tagName.toLowerCase() === want; });
    }
    if (crit.labelIncludes) {
      const needle = String(crit.labelIncludes).toLowerCase();
      nodes = nodes.filter(function (n) { return labelOf(n).toLowerCase().indexOf(needle) >= 0; });
    }
    if (typeof crit.index === 'number') {
      nodes = [nodes[crit.index]].filter(Boolean);
    }

    out.totalInteractive = total;
    out.candidateCount = nodes.length;
    out.candidates = nodes.slice(0, 8).map(function (n, i) {
      return { i: i, kind: kindOf(n), tag: n.tagName.toLowerCase(), label: labelOf(n).slice(0, 40) };
    });
    if (!nodes.length) { out.error = 'element-not-found'; return out; }

    const pick = nodes[0];
    try {
      const old = document.querySelectorAll('[' + MARK_ATTR + ']');
      for (let i = 0; i < old.length; i++) old[i].removeAttribute(MARK_ATTR);
    } catch (e) { /* ignore */ }
    pick.setAttribute(MARK_ATTR, '1');

    const r = pick.getBoundingClientRect();
    out.ok = true;
    out.target = {
      tag: pick.tagName.toLowerCase(),
      kind: kindOf(pick),
      label: labelOf(pick).slice(0, 40),
      value: pick.value !== undefined ? String(pick.value).slice(0, 60) : undefined,
      center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
      inViewport: r.top >= -1 && r.left >= -1 && r.bottom <= (window.innerHeight || 0) + 40,
      selector: '[' + MARK_ATTR + '="1"]'
    };
    return out;
  }

  return { locate: locate, MARK_ATTR: MARK_ATTR };
});
