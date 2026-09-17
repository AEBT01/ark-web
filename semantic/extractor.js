/**
 * Ark Semantic — 语义单元提取器 v1
 *
 * 职责：把页面 DOM 翻译成「语义单元」数组 —— 一次「预消化」，供检索与语义锚点使用。
 *
 * 设计约束（来自架构决策）：
 *  - 纯确定性规则，不含任何模型推理（智能在云端，机械在本地）
 *  - 零依赖、不触碰 chrome.* / Electron API，任何 DOM 环境可直接注入执行
 *  - 判定可测试、可回退：识别不出内容时降级为纯文本块，不抛错
 *
 * 用法：
 *   Node:  const { extractSemanticUnits } = require('./semantic/extractor.js')
 *   注入:  <源码>; return ArkSemantic.extractSemanticUnits(document, opts)
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ArkSemantic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  /** 默认参数（可被 opts 覆盖） */
  const DEFAULTS = {
    maxTextLen: 1200,     // 单元文本上限（超出截断；charLen 保留原长）
    minTextLen: 6,        // 单元文本下限，低于此且无交互元素 → 判为噪声
    maxUnits: 8000,        // 单元总数硬上限（仅极端保护，正常页面远低于此）
    maxContentUnits: 3000, // 内容级上限（宽进严出：精选发生在检索层，索引层截断会永久丢信息）
    maxNavUnits: 1000,     // 导航级上限（同上）
    repeatThreshold: 3,   // 非语义标签的容器：同签名兄弟 >= N 才视为重复结构组
    maxPathDepth: 4,      // 定位路径最大层级
    maxInteractives: 6,   // 每个单元最多收集的可交互元素数
    maxNoiseDetail: 40    // noise 明细最多保留多少组
  };

  // ---- 标签规则 ----

  // 注意：全部加 i 标志 —— HTML 元素 tagName 为大写，但 SVG 子元素（path/circle/g…）为小写

  /** 完全不参与的内容无关标签 */
  const NON_CONTENT_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|META|LINK|HEAD|TITLE|BASE|BR|HR|WBR|IFRAME|CANVAS|VIDEO|AUDIO|SOURCE|TRACK|MAP|AREA|OBJECT|EMBED|PARAM|FORM|SELECT|OPTION)$/i;

  /** 图形/装饰用 SVG 系标签 */
  const GRAPHIC_TAGS = /^(SVG|PATH|CIRCLE|RECT|LINE|POLYGON|POLYLINE|ELLIPSE|USE|SYMBOL|DEFS|G|TEXT|TSPAN|MASK|CLIPPATH|PATTERN|MARKER|FILTER|LINEARGRADIENT|RADIALGRADIENT|STOP)$/i;

  /**
   * 语义标签：本身承载独立语义，不依赖「重复出现」即可成为候选
   * 注意：LI 大量出现于导航菜单，仍需过噪声判定；INPUT/TEXTAREA 靠 placeholder/aria-label 承载语义
   */
  const SEMANTIC_TAGS = /^(P|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE|PRE|FIGCAPTION|FIGURE|DT|DD|SUMMARY|CAPTION|TD|TH|TR|ARTICLE|BUTTON|INPUT|TEXTAREA)$/i;

  /** 装饰性类名（配合短文本判定为噪声；文本较长时保留） */
  const DECORATION_CLASS_RE = /(^|[-_\s])(icon|ico|svg|avatar|badge|divider|spacer|separator|gutter|scrollbar|thumb|shadow|overlay|backdrop|ripple|focus-ring|placeholder|skeleton|spinner|caret|arrow|chevron|bullet|mask|gradient|watermark|logo|dot|banner-bg)([-_\s]|$)/i;

  /** 代码高亮 token 类名（这些块无独立语义，应被其 PRE/CODE 祖先吸收） */
  const CODE_TOKEN_CLASS_RE = /(^|[-_\s])(token|hljs|prism|language-|lineno|line-number|code-line|highlight)([-_\s]|$)/i;

  /** 哈希化类名 token（构建工具生成，如 c08e6e93 / sc-bdVaJa / css-1x2y3z） */
  const HASH_TOKEN_RES = [
    /^(css|sc|jsx|svelte|emotion)-?[a-zA-Z0-9]{4,}$/,
    /^[a-z]?[0-9a-f]{6,}$/i,
    /^[a-z]+_[a-zA-Z0-9]{5,}$/i
  ];

  const INTERACTIVE_SEL = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[onclick],[contenteditable="true"]';

  /** 标签 → 单元类型的默认映射 */
  const TYPE_BY_TAG = {
    P: 'paragraph', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading',
    H5: 'heading', H6: 'heading', LI: 'list-item', BLOCKQUOTE: 'quote', PRE: 'code',
    FIGCAPTION: 'caption', FIGURE: 'figure', DT: 'term', DD: 'definition',
    SUMMARY: 'summary', CAPTION: 'table-caption', TD: 'table-cell', TH: 'table-header',
    TR: 'table-row', ARTICLE: 'article', BUTTON: 'button', INPUT: 'input', TEXTAREA: 'input'
  };

  // ================= 基础工具 =================

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /** 归一化：合并空白、去零宽字符 */
  function normalizeText(s) {
    return String(s || '')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getClass(el) {
    const c = el.className;
    if (typeof c === 'string') return c;
    if (c && typeof c.baseVal === 'string') return c.baseVal;   // SVG 元素
    return el.getAttribute ? (el.getAttribute('class') || '') : '';
  }

  function isHashToken(t) {
    for (let i = 0; i < HASH_TOKEN_RES.length; i++) {
      if (HASH_TOKEN_RES[i].test(t)) return true;
    }
    return false;
  }

  /** 类指纹：剔除哈希 token 后排序拼接 —— 让「同结构不同哈希」的兄弟落到同一签名 */
  function classFingerprint(el) {
    const cls = getClass(el);
    if (!cls) return '';
    return cls.split(/\s+/).filter(function (t) { return t && !isHashToken(t); }).sort().join('.');
  }

  /** 结构签名：标签 + 类指纹 + 子元素标签骨架（前 6 个） */
  function structureSignature(el) {
    const kids = el.children;
    const parts = [];
    for (let i = 0; i < kids.length && i < 6; i++) parts.push(kids[i].tagName);
    return el.tagName + '|' + classFingerprint(el) + '|' + parts.join(',');
  }

  /**
   * 读可见文本：只用 innerText（它天然排除 script/style/隐藏元素与 SVG 内部）
   * 注意：不要回退 textContent —— 实测会把 <script> 源码当页面文本读进来（豆瓣页曾混入 2419 字 JS 源码）
   * 表单控件例外：用 aria-label / placeholder / 当前值作为其语义文本（空输入框否则无文本可判）
   */
  function readText(el) {
    const tag = el.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      let s = '';
      try {
        s = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '');
      } catch (e) { s = ''; }
      return normalizeText(s);
    }
    let t = '';
    try { t = el.innerText || ''; } catch (e) { t = ''; }
    return normalizeText(t);
  }

  /** 元素是否在 PRE/CODE 内部（代码 token 判定用；元素自身是 PRE/CODE 时不算） */
  function isInsideCode(el) {
    const self = el.tagName;
    if (self === 'PRE' || self === 'CODE') return false;
    let p = el.parentElement;
    let depth = 0;
    while (p && depth++ < 8) {
      if (p.tagName === 'PRE' || p.tagName === 'CODE') return true;
      p = p.parentElement;
    }
    return false;
  }

  /** 生成简短定位路径（id 优先，其次 class 链 + nth-of-type） */
  function quickPath(el, maxDepth) {
    if (el.id) return '#' + el.id;
    const parts = [];
    let cur = el;
    let n = 0;
    while (cur && cur.nodeType === 1 && n++ < maxDepth) {
      let s = cur.tagName.toLowerCase();
      const cls = classFingerprint(cur);
      if (cls) s += '.' + cls.split('.').slice(0, 2).join('.');
      const p = cur.parentElement;
      if (p) {
        const sibs = [];
        for (let i = 0; i < p.children.length; i++) {
          if (p.children[i].tagName === cur.tagName) sibs.push(p.children[i]);
        }
        if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(s);
      cur = p;
    }
    return parts.join(' > ');
  }

  /** 自身即交互元素的标签（querySelectorAll 不含自身，判定时必须单独算） */
  const SELF_INTERACTIVE_RE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/;

  /** 导航语境特征（类名 / id 命中即视为导航区） */
  const NAV_CONTEXT_RE = /(^|[-_\s])(nav|navbar|menu|sidebar|toc|breadcrumb|toolbar|pagination|pager|tabbar|tabs|site-?map|skip|social|share|language|lang-switch|footer|header|masthead|topbar|utility|drawer|offcanvas)([-_\s]|$)/i;

  /** 统计元素内可交互元素数（含元素自身） */
  function countInteractive(el) {
    let n = 0;
    const tag = el.tagName.toUpperCase();
    if (SELF_INTERACTIVE_RE.test(tag)) n++;
    else if (el.getAttribute && (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' || el.getAttribute('onclick'))) n++;
    try { n += el.querySelectorAll(INTERACTIVE_SEL).length; } catch (e) { /* ignore */ }
    return n;
  }

  /**
   * 导航语境判定：元素位于 nav/header/footer/aside 内，或祖先链上有导航特征类名/id/role
   * 用途：把「导航菜单/侧边栏/工具条/页脚」里的单元标为 nav 级，与内容级分开（检索默认只查内容级）
   */
  function isNavContext(el) {
    let cur = el;
    let depth = 0;
    while (cur && depth++ < 10) {
      const tag = cur.tagName.toUpperCase();
      if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') return true;
      if (cur.getAttribute && cur.getAttribute('role') === 'navigation') return true;
      const cls = getClass(cur);
      if (cls && NAV_CONTEXT_RE.test(cls)) return true;
      if (cur.id && NAV_CONTEXT_RE.test(cur.id)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /** 链接集合判定：块内链接文字之和占块文本 80% 以上且链接数 >= 3（说明整块就是一堆链接） */
  function isLinkCollection(el, textLen) {
    let nodes;
    try { nodes = el.querySelectorAll('a[href]'); } catch (e) { return false; }
    if (nodes.length < 3) return false;
    let linkLen = 0;
    for (let i = 0; i < nodes.length; i++) {
      let t = '';
      try { t = nodes[i].innerText || ''; } catch (e) { t = ''; }
      linkLen += normalizeText(t).length;
    }
    return textLen > 0 && linkLen / textLen >= 0.8;
  }

  /** 收集单元内的可交互元素摘要（为将来的语义锚点替换预留） */
  function collectInteractives(el, max) {
    const out = [];
    let nodes;
    try { nodes = el.querySelectorAll(INTERACTIVE_SEL); } catch (e) { nodes = []; }
    for (let i = 0; i < nodes.length && out.length < max; i++) {
      const n = nodes[i];
      let kind = n.tagName.toLowerCase();
      if (kind === 'a') kind = 'link';
      else if (kind === 'input' || kind === 'textarea') kind = 'input';
      const label = normalizeText(
        n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('placeholder') ||
        (n.innerText || n.value || '')
      ).slice(0, 60);
      out.push({ kind: kind, label: label, path: quickPath(n, 2) });
    }
    return out;
  }

  // ================= 候选收集 =================

  /** 选内容根：main/article 覆盖了 body 主要文本时用它，否则用 body */
  function pickRoot(doc) {
    const body = doc.body || doc.documentElement;
    if (!body) return null;
    const total = (body.textContent || '').length;
    if (total < 200) return body;
    const sel = ['main', '[role="main"]', 'article'];
    for (let i = 0; i < sel.length; i++) {
      const node = doc.querySelector(sel[i]);
      if (node && (node.textContent || '').length >= total * 0.35) return node;
    }
    return body;
  }

  /**
   * 收集候选并按「组」聚合：
   *   key = 父节点 → 结构签名 → 元素数组
   * 语义标签：单个即候选；普通容器：组大小 >= repeatThreshold 才候选
   */
  function collectGroups(root, cfg) {
    const all = root.querySelectorAll('*');
    const byParent = new Map();
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const tag = el.tagName;
      if (NON_CONTENT_TAGS.test(tag) || GRAPHIC_TAGS.test(tag)) continue;
      const parent = el.parentElement;
      if (!parent) continue;
      let m = byParent.get(parent);
      if (!m) { m = new Map(); byParent.set(parent, m); }
      const sig = structureSignature(el);
      let arr = m.get(sig);
      if (!arr) { arr = []; m.set(sig, arr); }
      arr.push(el);
    }
    return byParent;
  }

  // ================= 噪声判定 =================

  /**
   * 组级判定：只探测组内首个元素（同签名组结构一致，避免全量 innerText 的开销）
   * 返回 null 表示通过，否则返回拒因字符串
   */
  function rejectReason(probe, sig, cfg) {
    const tag = probe.tagName;

    // 1) 代码高亮 token：类名命中，或位于 PRE/CODE 内部
    if (CODE_TOKEN_CLASS_RE.test(sig)) return 'code-token';
    if (isInsideCode(probe)) return 'code-token';

    // 2) 取文本（可见文本）
    const text = readText(probe);
    const textLen = text.length;

    // 3) 文本过短：无内容又无交互元素 → 装饰/空块
    //    标题与独立控件放宽到 2 字（「评论」这类短标题、「提交订单」这类短按钮本身是有效语义）
    const tagU = tag.toUpperCase();
    const minLen = (/^H[1-6]$/.test(tagU) || tagU === 'BUTTON' || tagU === 'A' || tagU === 'INPUT' || tagU === 'TEXTAREA') ? 2 : cfg.minTextLen;
    if (textLen < minLen) return 'too-short';

    // 3b) 表格单元格：只保留「长单元格」（整行的语义由 TR 承担；短单元格独立成单元会与所在行重复）
    if ((tag === 'TD' || tag === 'TH') && textLen < 30) return 'small-cell';

    // 4) 装饰性类名 + 短文本 → 装饰块（图标、按钮皮、遮罩等）
    if (DECORATION_CLASS_RE.test(sig) && textLen < 60) return 'decoration';

    // 5) 交互堆：整块几乎全是可交互元素且文本很短（菜单/工具条/按钮组）
    //    注意：元素自身就是单个控件（如 <button>提交订单</button>）不算"堆"，否则独立按钮会被误杀
    const interCount = countInteractive(probe);
    if (interCount > 0 && textLen < 40) {
      const innerEls = probe.querySelectorAll('*').length;
      const selfIsControl = SELF_INTERACTIVE_RE.test(tag.toUpperCase());
      if (!(selfIsControl && innerEls <= 2) && interCount / (innerEls + 1) > 0.5) return 'interactive-only';
    }

    // 5b) 导航语境里的短控件（无障碍跳转链接、社交按钮、语言切换等）
    //     正文里的短列表项不受影响（它们不在导航语境、自身也不是控件）
    if (textLen < 25 && isNavContext(probe)) return 'nav-control';

    // 5c) 链接集合：块内文本几乎全由链接文字构成（页眉/页脚链接堆、导航条、标签云）
    if (textLen >= 40 && isLinkCollection(probe, textLen)) return 'link-list';

    // 6) 重复度兜底：同一文本在同一页面出现极多次的短块（分页符/分隔符之类）
    if (textLen < 12 && tag !== 'LI' && tag !== 'TD' && tag !== 'TH') {
      // 交给调用方按组大小处理（这里不拦，保持规则可解释）
    }

    return null;
  }

  // ================= 单元构造 =================

  function buildUnit(el, type, level, cfg, idSeq) {
    const full = readText(el);
    const unit = {
      id: 'u' + idSeq,
      type: type,
      level: level,
      text: full.length > cfg.maxTextLen ? full.slice(0, cfg.maxTextLen) : full,
      charLen: full.length,
      path: quickPath(el, cfg.maxPathDepth)
    };
    const interactives = collectInteractives(el, cfg.maxInteractives);
    if (interactives.length) unit.interactives = interactives;
    return { unit: unit, el: el };
  }

  /** 类型推断：语义标签直接用映射表；重复组容器按内部特征猜 */
  function guessContainerType(el) {
    if (el.tagName === 'TR') return 'table-row';
    try {
      const links = el.querySelectorAll('a[href]');
      // 导航/菜单/链接列表：链接数 >= 3 且平均每链接文本很短（页脚栏目、产品菜单等）
      if (links.length >= 3) {
        const textLen = readText(el).length;
        if (textLen / links.length < 20) return 'nav';
      }
      if (el.querySelector('time') || /comment|review|reply|post\b|feed-item/i.test(getClass(el))) return 'comment';
      if (links.length && el.querySelector('h1,h2,h3,h4,h5,h6')) return 'card';
      if (el.querySelector('img') && links.length) return 'card';
    } catch (e) { /* ignore */ }
    return 'block';
  }

  // ================= 去嵌套 =================

  /** 结构化单元类型：整块即一个完整语义单元，应吸收其内部的文本块子单元 */
  const STRUCT_TYPES = { comment: 1, card: 1, nav: 1, 'table-row': 1, figure: 1 };

  /**
   * 去重（父子只保留一层）：
   *  规则 1（丢父）：父单元文本 ≥ 80% 由其已保留的后代贡献 → 父是纯容器，丢弃
   *  规则 2（丢子）：结构化单元（comment/card/nav 等）吸收其内部、文本被自身包含的后代单元
   * 从深到浅处理，后代优先进入保留集
   */
  function dedupeNested(entries) {
    const sorted = entries.slice().sort(function (a, b) { return b.depth - a.depth; });
    const keep = [];
    for (let i = 0; i < sorted.length; i++) {
      const cand = sorted[i];
      let covered = 0;
      for (let j = 0; j < keep.length; j++) {
        const k = keep[j];
        if (isAncestorOf(cand.el, k.el)) covered += k.unit.charLen;   // cand 是否为 k 的祖先
      }
      // 纯容器丢弃；table-row 豁免（「行」的文本天然来自单元格，它不是纯容器，而是记录的载体）
      if (cand.unit.type !== 'table-row' && cand.unit.charLen > 0 && covered / cand.unit.charLen >= 0.8) continue;

      if (STRUCT_TYPES[cand.unit.type]) {
        const head = cand.unit.text.slice(0, 40);
        for (let j = keep.length - 1; j >= 0; j--) {
          const k = keep[j];
          if (!isAncestorOf(cand.el, k.el)) continue;
          const kHead = k.unit.text.slice(0, 40);
          if (kHead && head && head.indexOf(kHead) >= 0) keep.splice(j, 1);   // 子文本已被父包含 → 丢子
        }
      }
      keep.push(cand);
    }
    return keep;
  }

  function isAncestorOf(ancestor, el) {
    if (ancestor === el) return false;
    try { return ancestor.contains(el); } catch (e) { return false; }
  }

  function depthOf(el) {
    let d = 0;
    let p = el.parentElement;
    while (p && d < 64) { d++; p = p.parentElement; }
    return d;
  }

  // ================= 主入口 =================

  function extractSemanticUnits(doc, opts) {
    const t0 = now();
    const cfg = {};
    for (const k in DEFAULTS) cfg[k] = DEFAULTS[k];
    if (opts) for (const k in opts) if (opts[k] !== undefined) cfg[k] = opts[k];

    const root = pickRoot(doc);
    const out = {
      version: SCHEMA_VERSION,
      url: (doc.location && doc.location.href) || '',
      title: doc.title || '',
      units: [],
      stats: {
        candidates: 0, accepted: 0, groups: 0, elapsedMs: 0,
        rejected: {}, typeCounts: {}, levelCounts: {}, truncated: 0
      },
      noise: []
    };
    if (!root) { out.stats.elapsedMs = Math.round(now() - t0); return out; }

    const byParent = collectGroups(root, cfg);
    const accepted = [];
    let idSeq = 0;

    byParent.forEach(function (sigMap, parent) {
      sigMap.forEach(function (els, sig) {
        const probe = els[0];
        const tag = probe.tagName;
        const isSemantic = SEMANTIC_TAGS.test(tag);
        if (!isSemantic && els.length < cfg.repeatThreshold) return;   // 单个普通容器：跳过
        out.stats.groups++;

        const reason = rejectReason(probe, sig, cfg);
        if (reason) {
          out.stats.rejected[reason] = (out.stats.rejected[reason] || 0) + els.length;
          if (out.noise.length < cfg.maxNoiseDetail) {
            out.noise.push({ signature: sig.slice(0, 80), count: els.length, reason: reason });
          }
          return;
        }

        const type = TYPE_BY_TAG[tag.toUpperCase()] || guessContainerType(probe);
        const level = (type === 'nav' || isNavContext(probe)) ? 'nav' : 'content';
        const limit = cfg.maxUnits - accepted.length;
        const take = Math.min(els.length, Math.max(0, limit));
        for (let i = 0; i < take; i++) {
          const built = buildUnit(els[i], type, level, cfg, ++idSeq);
          built.depth = depthOf(els[i]);
          accepted.push(built);
        }
      });
    });

    out.stats.candidates = accepted.length;

    let kept = dedupeNested(accepted);

    // 规模控制（宽进严出）：索引层只做极端保护；精选发生在检索层（top-K + 按级别过滤）。
    // 仅在超过硬上限时按「类型权重 + 文本长度」优先保留，截断数量在 stats.truncated 中如实报告。
    const TYPE_WEIGHT = {
      article: 5, paragraph: 5, comment: 5, card: 5, quote: 4, code: 4,
      heading: 3, figure: 3, 'table-row': 3, 'list-item': 3, summary: 2, block: 2,
      nav: 1, 'table-cell': 1, 'table-header': 1, 'table-caption': 1, caption: 1, term: 1, definition: 1
    };
    function pickByLimit(entries, max) {
      if (entries.length <= max) return entries;
      const sorted = entries.slice().sort(function (a, b) {
        const sa = (TYPE_WEIGHT[a.unit.type] || 2) * 1000 + Math.min(a.unit.charLen, 800);
        const sb = (TYPE_WEIGHT[b.unit.type] || 2) * 1000 + Math.min(b.unit.charLen, 800);
        return sb - sa;
      });
      return sorted.slice(0, max);
    }
    const contentEntries = kept.filter(function (e) { return e.unit.level !== 'nav'; });
    const navEntries = kept.filter(function (e) { return e.unit.level === 'nav'; });
    out.stats.truncated = Math.max(0, contentEntries.length - cfg.maxContentUnits)
      + Math.max(0, navEntries.length - cfg.maxNavUnits);
    kept = pickByLimit(contentEntries, cfg.maxContentUnits).concat(pickByLimit(navEntries, cfg.maxNavUnits));
    kept.sort(function (a, b) { return a.depth - b.depth; });

    for (let i = 0; i < kept.length; i++) {
      const u = kept[i].unit;
      out.units.push(u);
      out.stats.typeCounts[u.type] = (out.stats.typeCounts[u.type] || 0) + 1;
      const lv = u.level || 'content';
      out.stats.levelCounts[lv] = (out.stats.levelCounts[lv] || 0) + 1;
    }
    out.stats.accepted = out.units.length;
    out.stats.noiseGroups = out.noise.length;
    out.stats.elapsedMs = Math.round((now() - t0) * 10) / 10;
    return out;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    extractSemanticUnits: extractSemanticUnits
  };
});
