/**
 * audit.js — Ark Web 专业审计引擎
 * 评分规则 + 洞察生成 + 性能预算
 * 数据采集由插件端 audit-collect 完成(一次 CDP 往返)
 */

const GOOD = 'good', WARN = 'needs-improvement', POOR = 'poor';

/** 每条规则的权重(按影响程度) */
const RULE_WEIGHTS = {
  lcp: 4, fcp: 3, ttfb: 3, cls: 3, inp: 3, longTasks: 2, totalSize: 2, blockingScripts: 2, compression: 2,
  imgAlt: 3, inputLabel: 3, targetSize: 2, htmlLang: 2, ariaHidden: 1,
  title: 2, metaDesc: 2, h1: 1.5, canonical: 1, og: 1, structuredData: 1, viewport: 1, lang: 1, internalLinks: 0.5,
  https: 3, mixedContent: 2, csp: 2, hsts: 1.5, contentTypeOptions: 1, passwordForms: 1.5,
  imageSizing: 2, lazyLoading: 1, fonts: 1.5, domComplexity: 2
};

function grade(score, status) { return { score, status }; }

function gradeOf(value, [g, w]) {
  if (value == null) return grade(0, 'no-data');
  if (value <= g) return grade(100, GOOD);
  if (value <= w) return grade(50, WARN);
  return grade(0, POOR);
}

const CATEGORIES = [
  { id: 'performance', name: '性能', weight: 30 },
  { id: 'accessibility', name: '可访问性', weight: 20 },
  { id: 'seo', name: 'SEO', weight: 15 },
  { id: 'security', name: '安全与最佳实践', weight: 20 },
  { id: 'resources', name: '资源效率', weight: 15 }
];

const RULES = {
  performance(data) {
    const v = data.vitals || {};
    const nav = data.navigation || {};
    const lt = data.longTasks || {};
    const res = data.resources || {};
    const s = data.scripts || {};
    return [
      { id: 'lcp', name: 'LCP 最大内容绘制', ...gradeOf(v.lcp, [2500, 4000]), value: v.lcp == null ? 'no-data' : v.lcp + 'ms', detail: v.lcpElement ? `元素: ${v.lcpElement}` : undefined },
      { id: 'fcp', name: 'FCP 首次内容绘制', ...gradeOf(data.fcp, [1800, 3000]), value: data.fcp == null ? 'no-data' : data.fcp + 'ms' },
      { id: 'ttfb', name: 'TTFB 服务端响应', ...gradeOf(nav.ttfb, [800, 1800]), value: nav.ttfb == null ? 'no-data' : nav.ttfb + 'ms' },
      { id: 'cls', name: 'CLS 布局稳定性', ...gradeOf(v.cls == null ? null : v.cls, [0.1, 0.25]), value: v.cls == null ? 'no-data' : String(v.cls) },
      v.inp != null
        ? { id: 'inp', name: 'INP 交互响应', ...gradeOf(v.inp, [200, 500]), value: v.inp + 'ms' }
        : { id: 'inp', name: 'INP 交互响应', score: 0, status: 'no-data', value: '无交互数据', detail: '未检测到用户交互, 建议在真实使用中观察' },
      {
        id: 'longTasks', name: '长任务',
        ...(() => {
          const c = lt.count || 0;
          if (c <= 2) return grade(100, GOOD);
          if (c <= 5) return grade(70, WARN);
          if (c <= 10) return grade(40, POOR);
          return grade(10, POOR);
        })(),
        value: `${lt.count || 0} 个 / 共 ${lt.totalMs || 0}ms`, detail: lt.maxMs ? `最长 ${lt.maxMs}ms` : undefined
      },
      {
        id: 'totalSize', name: '总资源体积',
        ...(() => {
          const kb = res.totalKB || 0;
          if (kb < 1500) return grade(100, GOOD);
          if (kb < 3000) return grade(70, WARN);
          if (kb < 5000) return grade(40, POOR);
          return grade(10, POOR);
        })(),
        value: `${res.totalKB || 0} KB / ${res.total || 0} 个请求`
      },
      {
        id: 'blockingScripts', name: '阻塞渲染脚本',
        ...(() => {
          const n = (s.blocking || []).length;
          if (n === 0) return grade(100, GOOD);
          if (n <= 3) return grade(70, WARN);
          if (n <= 8) return grade(40, POOR);
          return grade(10, POOR);
        })(),
        value: `${(s.blocking || []).length} 个`, detail: (s.blocking || []).slice(0, 3).join(', ')
      },
      {
        id: 'compression', name: '传输压缩',
        ...(() => {
          const n = (res.uncompressed || []).length;
          if (n === 0) return grade(100, GOOD);
          if (n <= 3) return grade(70, WARN);
          if (n <= 8) return grade(40, POOR);
          return grade(10, POOR);
        })(),
        value: `${(res.uncompressed || []).length} 个文本资源未压缩`
      }
    ];
  },

  accessibility(data) {
    const a = data.a11y || {};
    const imgs = data.images || {};
    return [
      {
        id: 'imgAlt', name: '图片 alt 属性',
        ...(() => {
          const n = a.imagesNoAlt ?? imgs.withoutAlt ?? 0;
          if (n === 0) return grade(100, GOOD);
          if (n <= 3) return grade(70, WARN);
          if (n <= 10) return grade(40, POOR);
          return grade(10, POOR);
        })(),
        value: `${a.imagesNoAlt ?? imgs.withoutAlt ?? 0} 张图片缺少 alt`
      },
      {
        id: 'inputLabel', name: '表单标签',
        ...(() => {
          const n = a.inputsNoLabel || 0;
          if (n === 0) return grade(100, GOOD);
          if (n <= 3) return grade(70, WARN);
          return grade(30, POOR);
        })(),
        value: `${a.inputsNoLabel || 0} 个输入框无标签`
      },
      {
        id: 'targetSize', name: '点击目标尺寸',
        ...(() => {
          const n = a.smallTargets || 0;
          if (n === 0) return grade(100, GOOD);
          if (n <= 5) return grade(70, WARN);
          return grade(40, POOR);
        })(),
        value: `${a.smallTargets || 0} 个目标 < 44x44px`
      },
      { id: 'htmlLang', name: '页面语言属性', ...(a.missingLang ? grade(0, POOR) : grade(100, GOOD)), value: a.missingLang ? '缺少 lang 属性' : 'ok' },
      {
        id: 'ariaHidden', name: 'aria-hidden 使用',
        ...(() => {
          const n = a.ariaHiddenWithContent || 0;
          return n === 0 ? grade(100, GOOD) : grade(50, WARN);
        })(),
        value: `${a.ariaHiddenWithContent || 0} 处含内容的隐藏区域`
      }
    ];
  },

  seo(data) {
    const s = data.seo || {};
    const tl = s.titleLen || 0;
    const md = s.metaDescLen || 0;
    return [
      {
        id: 'title', name: '标题',
        ...(() => {
          if (tl >= 10 && tl <= 60) return grade(100, GOOD);
          if (tl >= 1 && tl <= 69) return grade(60, WARN);
          return grade(20, POOR);
        })(),
        value: tl ? `"${s.title}" (${tl} 字符)` : '缺少 title'
      },
      {
        id: 'metaDesc', name: 'Meta 描述',
        ...(() => {
          if (md >= 50 && md <= 160) return grade(100, GOOD);
          if (md >= 1 && md <= 320) return grade(60, WARN);
          return grade(20, POOR);
        })(),
        value: md ? `${md} 字符` : '缺少 description'
      },
      {
        id: 'h1', name: 'H1 标题',
        ...(() => {
          const n = s.h1Count || 0;
          if (n === 1) return grade(100, GOOD);
          if (n > 1) return grade(70, WARN);
          return grade(30, POOR);
        })(),
        value: `${s.h1Count || 0} 个`
      },
      { id: 'canonical', name: 'Canonical URL', ...(s.canonical ? grade(100, GOOD) : grade(0, POOR)), value: s.canonical ? '已设置' : '缺失' },
      { id: 'og', name: 'Open Graph', ...(s.ogComplete ? grade(100, GOOD) : grade(30, POOR)), value: s.ogComplete ? '完整' : '不完整' },
      {
        id: 'structuredData', name: '结构化数据',
        ...(() => {
          const n = s.structuredData || 0;
          return n >= 1 ? grade(100, GOOD) : grade(40, WARN);
        })(),
        value: `${s.structuredData || 0} 个 JSON-LD`
      },
      { id: 'viewport', name: '移动端 Viewport', ...(s.viewport ? grade(100, GOOD) : grade(0, POOR)), value: s.viewport ? '已设置' : '缺失' },
      { id: 'lang', name: '语言属性', ...(s.lang ? grade(100, GOOD) : grade(0, POOR)), value: s.lang || '缺失' },
      {
        id: 'internalLinks', name: '内链',
        ...(() => {
          const n = s.internalLinks || 0;
          if (n >= 3) return grade(100, GOOD);
          if (n >= 1) return grade(60, WARN);
          return grade(30, POOR);
        })(),
        value: `${s.internalLinks || 0} 个内链 / ${s.links || 0} 个总链接`
      }
    ];
  },

  security(data) {
    const sec = data.security || {};
    const hdrs = (data.network && data.network.document && data.network.document.headers) || {};
    const h = (k) => (hdrs[k] || hdrs[k.toLowerCase()] || '');
    return [
      { id: 'https', name: 'HTTPS', ...(sec.https ? grade(100, GOOD) : grade(0, POOR)), value: sec.https ? 'https' : '非 https' },
      {
        id: 'mixedContent', name: '混合内容',
        ...(() => {
          const n = sec.mixedContent || 0;
          return n === 0 ? grade(100, GOOD) : grade(30, POOR);
        })(),
        value: `${sec.mixedContent || 0} 处`
      },
      {
        id: 'csp', name: 'CSP 内容安全策略',
        ...(() => {
          const has = !!h('content-security-policy');
          return has ? grade(100, GOOD) : (sec.cspMeta ? grade(70, WARN) : grade(30, POOR));
        })(),
        value: h('content-security-policy') ? '响应头已设置' : (sec.cspMeta ? '仅 meta 标签' : '缺失')
      },
      {
        id: 'hsts', name: 'HSTS 强制传输安全',
        ...(() => {
          const v = h('strict-transport-security');
          return v ? grade(100, GOOD) : grade(50, WARN);
        })(),
        value: h('strict-transport-security') ? '已设置' : '缺失'
      },
      {
        id: 'contentTypeOptions', name: 'X-Content-Type-Options',
        ...(() => {
          const v = h('x-content-type-options');
          return v ? grade(100, GOOD) : grade(60, WARN);
        })(),
        value: h('x-content-type-options') ? '已设置' : '缺失'
      },
      {
        id: 'passwordForms', name: '密码表单安全',
        ...(() => {
          const n = sec.insecurePasswordForms || 0;
          return n === 0 ? grade(100, GOOD) : grade(20, POOR);
        })(),
        value: `${sec.insecurePasswordForms || 0} 个 GET 密码表单`
      }
    ];
  },

  resources(data) {
    const imgs = data.images || {};
    const fonts = data.fonts || {};
    const dom = data.dom || {};
    const rules = [];
    // 图片过度放大
    const oversized = (imgs.heavy || []).length;
    rules.push({
      id: 'imageSizing', name: '图片尺寸优化',
      ...(() => {
        if (oversized === 0) return grade(100, GOOD);
        if (oversized <= 3) return grade(70, WARN);
        return grade(40, POOR);
      })(),
      value: oversized ? `${oversized} 张图片放大显示` : '无放大图片'
    });
    // 懒加载
    const totalImgs = imgs.total || 0;
    if (totalImgs > 5) {
      const lazyCount = (imgs.heavy || []).filter(i => i.lazy).length;
      const lazyRatio = lazyCount / totalImgs;
      rules.push({
        id: 'lazyLoading', name: '图片懒加载',
        ...(() => {
          if (lazyRatio >= 0.8) return grade(100, GOOD);
          if (lazyRatio >= 0.5) return grade(70, WARN);
          return grade(40, POOR);
        })(),
        value: `${Math.round(lazyRatio * 100)}% 图片使用懒加载`
      });
    }
    // 字体
    const faceCount = fonts.count || 0;
    rules.push({
      id: 'fonts', name: '字体效率',
      ...(() => {
        if (faceCount <= 3) return grade(100, GOOD);
        if (faceCount <= 6) return grade(70, WARN);
        return grade(40, POOR);
      })(),
      value: `${faceCount} 种字体`
    });
    // DOM 复杂度
    const elements = dom.elements || 0;
    rules.push({
      id: 'domComplexity', name: 'DOM 复杂度',
      ...(() => {
        if (elements < 1500) return grade(100, GOOD);
        if (elements < 5000) return grade(70, WARN);
        if (elements < 10000) return grade(40, POOR);
        return grade(10, POOR);
      })(),
      value: `${elements} 个元素`, detail: dom.maxDepth ? `最大深度 ${dom.maxDepth}` : undefined
    });
    return rules;
  }
};

/** 计算完整评分 */
function score(data) {
  const categories = CATEGORIES.map(cat => {
    const rules = RULES[cat.id](data);
    const weighted = rules.reduce((s, r) => s + r.score * (RULE_WEIGHTS[r.id] || 1), 0);
    const totalW = rules.reduce((s, r) => s + (RULE_WEIGHTS[r.id] || 1), 0);
    const scoreVal = totalW > 0 ? Math.round((weighted / totalW) * 10) / 10 : 0;
    return {
      id: cat.id,
      name: cat.name,
      weight: cat.weight,
      score: scoreVal,
      rating: ratingOf(scoreVal),
      rules
    };
  });
  const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
  const total = Math.round((categories.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight) * 10) / 10;
  return { categories, total: Math.round(total * 10) / 10, rating: ratingOf(total) };
}

function ratingOf(score) {
  if (score >= 90) return GOOD;
  if (score >= 50) return WARN;
  return POOR;
}

/** 提取用于趋势对比的关键指标 */
function metrics(data) {
  const v = data.vitals || {};
  const nav = data.navigation || {};
  const res = data.resources || {};
  const lt = data.longTasks || {};
  return {
    lcp: v.lcp, fcp: data.fcp, ttfb: nav.ttfb, cls: v.cls, inp: v.inp,
    totalKB: res.totalKB || 0, requests: res.total || 0,
    longTasks: lt.count || 0,
    domElements: (data.dom || {}).elements || 0
  };
}

/** 确定性洞察: 根因分析 */
function insights(data, scores) {
  const out = [];
  const v = data.vitals || {};
  const nav = data.navigation || {};
  const lt = data.longTasks || {};
  const res = data.resources || {};
  const s = data.scripts || {};

  if (nav.ttfb != null && nav.ttfb >= 800) {
    out.push({ type: 'warning', title: '服务端响应慢', message: `TTFB ${nav.ttfb}ms ≥ 800ms。优先检查后端处理耗时、数据库查询与 CDN/边缘缓存配置。` });
  }
  if (v.lcp != null && v.lcp >= 2500) {
    if (v.lcpElement && /IMG|PICTURE/i.test(v.lcpElement)) {
      out.push({ type: 'warning', title: 'LCP 由图片驱动', message: `LCP 元素是 ${v.lcpElement}(${v.lcp}ms)。为 LCP 图片添加 preload、使用现代格式并压缩。` });
    }
    if ((s.blocking || []).length > 0) {
      out.push({ type: 'warning', title: '渲染被阻塞脚本拖慢', message: `${(s.blocking || []).length} 个同步脚本阻塞渲染, 添加 async/defer 或内联关键路径。` });
    }
  }
  if (v.cls != null && v.cls >= 0.25) {
    out.push({
      type: 'warning', title: '布局抖动明显',
      message: `CLS ${v.cls}。来源: ${(v.clsSources || []).join(', ') || '未知'}。为图片/广告预留尺寸, 避免内容插入顶部。`
    });
  }
  if (lt.count > 0 && lt.count <= 5) {
    out.push({ type: 'info', title: '主线程有长任务', message: `${lt.count} 个长任务(共 ${lt.totalMs}ms), 可考虑代码分割与推迟非关键 JS。` });
  }
  if (lt.count > 5) {
    out.push({ type: 'warning', title: '主线程繁忙', message: `${lt.count} 个长任务(共 ${lt.totalMs}ms, 最长 ${lt.maxMs}ms)。严重阻塞交互, 建议拆分任务并减少主包体积。` });
  }
  if ((res.uncompressed || []).length > 0) {
    out.push({ type: 'warning', title: '缺少传输压缩', message: `${(res.uncompressed || []).length} 个文本资源未压缩(如 ${(res.uncompressed[0] || {}).url})。启用 gzip/brotli 通常可省 60-80% 体积。` });
  }
  if ((res.topDomains || []).length > 1) {
    const third = (res.topDomains || []).slice(1).reduce((sum, d) => sum + (d.kb || 0), 0);
    if (third > 300) {
      out.push({ type: 'info', title: '第三方脚本成本高', message: `第三方域名合计约 ${third} KB。评估其必要性, 延迟加载或自托管。` });
    }
  }
  if (scores && scores.categories) {
    const sec = scores.categories.find(c => c.id === 'security');
    if (sec && sec.score < 70) {
      out.push({ type: 'warning', title: '安全头不完整', message: '缺少 CSP/HSTS 等关键安全头, 见安全类别明细。' });
    }
  }
  const fw = data.framework || {};
  if (fw.react) out.push({ type: 'info', title: '框架: React', message: '检测到 React。React 应用常见优化: memo/useMemo、React.lazy 代码分割、SSR 流式渲染。' });
  if (fw.vue) out.push({ type: 'info', title: '框架: Vue', message: '检测到 Vue。Vue 应用常见优化: defineAsyncComponent、keep-alive 策略、编译时优化。' });
  if (fw.next) out.push({ type: 'info', title: '框架: Next.js', message: '检测到 Next.js。建议启用 ISR/SSG、图片优化组件、动态导入。' });
  if (fw.analytics) out.push({ type: 'info', title: '检测到分析脚本', message: '页面加载了分析脚本(GA/GTM 类), 注意其对性能的影响, 可延迟加载。' });

  if (out.length === 0) {
    out.push({ type: 'good', title: '总体健康', message: '未发现显著问题, 各项指标处于良好区间。' });
  }
  return out;
}

/** ROI 排序的优化机会 */
function opportunities(data) {
  const out = [];
  const res = data.resources || {};
  const imgs = data.images || {};
  const s = data.scripts || {};
  const fonts = data.fonts || {};
  const dom = data.dom || {};

  if ((res.uncompressed || []).length > 0) {
    const kb = (res.uncompressed || []).reduce((sum, r) => sum + (r.kb || 0), 0);
    out.push({ title: `为 ${(res.uncompressed || []).length} 个文本资源启用 gzip/brotli 压缩`, estimateKB: Math.round(kb * 0.7), impact: 'high', effort: 'low' });
  }
  const oversized = (imgs.heavy || []).filter(i => !i.lazy);
  if (oversized.length > 0) {
    out.push({ title: `压缩/响应式处理 ${oversized.length} 张过度放大图片`, estimateKB: '视图片而定', impact: 'high', effort: 'medium' });
  }
  if ((s.blocking || []).length > 0) {
    out.push({ title: `为 ${(s.blocking || []).length} 个同步脚本添加 async/defer`, estimateKB: '0 KB(时间收益)', impact: 'medium', effort: 'low' });
  }
  if ((res.heaviest || []).length > 0) {
    const big = (res.heaviest || [])[0];
    if (big.kb > 200) {
      out.push({ title: `分析并分割大体积资源 ${big.url} (${big.kb} KB)`, estimateKB: Math.round(big.kb * 0.5), impact: 'medium', effort: 'medium' });
    }
  }
  if ((fonts.count || 0) > 4) {
    out.push({ title: `字体子集化/合并 (${fonts.count} 种字体)`, estimateKB: '通常 50-200 KB', impact: 'medium', effort: 'medium' });
  }
  if ((dom.elements || 0) > 3000) {
    out.push({ title: `简化 DOM (${dom.elements} 个元素, 最大深度 ${dom.maxDepth})`, estimateKB: '0 KB(渲染时间收益)', impact: 'medium', effort: 'high' });
  }
  if ((res.totalKB || 0) > 2000) {
    out.push({ title: `总资源 ${res.totalKB} KB 偏大: 代码分割 + 按需加载`, estimateKB: Math.round((res.totalKB || 0) * 0.3), impact: 'high', effort: 'medium' });
  }
  return out;
}

/** 性能预算检查 */
function checkBudget(data, budget) {
  if (!budget || typeof budget !== 'object') return { passed: true, violations: [] };
  const m = metrics(data);
  const violations = [];
  const checks = [
    ['lcp', m.lcp, 'LCP'], ['ttfb', m.ttfb, 'TTFB'], ['cls', m.cls, 'CLS'],
    ['inp', m.inp, 'INP'], ['totalKB', m.totalKB, '总资源体积'], ['requests', m.requests, '请求数']
  ];
  for (const [key, val, label] of checks) {
    if (budget[key] != null && val != null && val > budget[key]) {
      violations.push({ metric: label, value: val, budget: budget[key] });
    }
  }
  return { passed: violations.length === 0, violations };
}

/** AI 可读紧凑格式 */
function aiReport(data, scores, ins, opps, budget) {
  const v = data.vitals || {};
  const nav = data.navigation || {};
  const res = data.resources || {};
  return {
    url: (data.seo && data.seo.url) || undefined,
    title: (data.seo && data.seo.title) || undefined,
    totalScore: scores.total,
    categories: Object.fromEntries(scores.categories.map(c => [c.id, c.score])),
    vitals: { lcp: v.lcp, fcp: data.fcp, ttfb: nav.ttfb, cls: v.cls, inp: v.inp },
    resources: { totalKB: res.totalKB, requests: res.total, uncompressed: (res.uncompressed || []).length, topDomains: (res.topDomains || []).slice(0, 3) },
    framework: data.framework || {},
    keyIssues: ins.filter(i => i.type === 'warning').map(i => ({ title: i.title, message: i.message })),
    opportunities: opps.slice(0, 5),
    budget: budget || null
  };
}

module.exports = {
  CATEGORIES, RULES, score, metrics, insights, opportunities, checkBudget, aiReport,
  ratingOf, GOOD, WARN, POOR
};
