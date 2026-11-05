/**
 * 主世界状态提取器
 *
 * page-agent 注入在 isolated world，看不到页面自己设置的 window.__INITIAL_STATE__ /
 * __PRELOADED_STATE__ / __APOLLO_STATE__ 等全局。这个函数专门用 world:'MAIN' 注入，
 * 只读、无副作用，并且用 WeakSet 处理循环引用。
 */
export function STATE_AGENT(maxBytes) {
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : 6000;
  const out = [];
  const safeStringify = (v) => {
    if (typeof v === 'string') return v;
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, val) => {
        if (typeof val === 'bigint') return String(val);
        if (typeof val === 'function') return '[Function]';
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      });
    } catch (e) {
      try { return String(v); } catch { return '[unserializable]'; }
    }
  };
  const push = (kind, raw, extra) => {
    if (raw == null) return;
    const s = typeof raw === 'string' ? raw : safeStringify(raw);
    if (!s || s.length < 2) return;
    out.push(Object.assign({ kind, bytes: s.length, truncated: s.length > cap, data: s.slice(0, cap) }, extra || {}));
  };

  try {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) push('json-ld', s.textContent);
    const next = document.getElementById('__NEXT_DATA__');
    if (next) push('next-data', next.textContent);
    const nuxt = document.getElementById('__NUXT_DATA__') || document.getElementById('__NUXT__');
    if (nuxt) push('nuxt', nuxt.textContent);
    for (const key of ['__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__REDUX_STATE__', '__DATA__']) {
      try { if (window[key] != null) push('window.' + key, window[key]); } catch { /* getter 抛错 */ }
    }
  } catch { /* 页面异常时尽量返回已收集部分 */ }

  const meta = {};
  try {
    for (const m of document.querySelectorAll('meta[property^="og:"],meta[name="description"],meta[name="twitter:title"]')) {
      const k = m.getAttribute('property') || m.getAttribute('name');
      if (k) meta[k] = m.getAttribute('content');
    }
    const canon = document.querySelector('link[rel="canonical"]');
    if (canon) meta.canonical = canon.href;
  } catch { /* 忽略 */ }

  return { url: location.href, title: document.title, sources: out, meta, found: out.length, via: 'main-world' };
}
