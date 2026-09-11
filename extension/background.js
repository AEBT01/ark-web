/**
 * Ark Web — Background Service Worker v4
 *
 * 架构：
 *  - WebSocket 桥接 Bridge Server (ws://localhost:9334)
 *  - CDP (chrome.debugger) 提供真实浏览器控制：
 *      真实鼠标/键盘事件(trusted)、真实设备/媒体模拟、整页截图、网络响应体、
 *      异步 evaluate、CPU/网络/地理/时区模拟、PDF 打印、文件上传
 *  - 无 CDP(未授权/Chrome 136+ 未激活)时自动降级到 chrome.scripting 等常规 API
 *  - 日志(console/network)节流批量转发给 Bridge Server 聚合
 *  - activeTabId 缓存避免每次命令查询
 *  - audit-collect: 一次 CDP 往返采集 30+ 维度的审计原始数据
 *
 * 注意：Chrome 136+ 的 chrome.debugger 需要用户在 popup 中点击「启用调试」授权。
 */

/** 审计采集脚本(在页面主 world 运行, 一次 evaluate 采集全部维度) */
const AUDIT_COLLECT_SCRIPT = `(async () => {
  const out = {};
  out.url = location.href;
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) {
    out.navigation = {
      ttfb: Math.round(nav.responseStart - nav.requestStart),
      domInteractive: Math.round(nav.domInteractive),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd),
      redirects: nav.redirectCount,
      protocol: nav.nextHopProtocol,
      transferKB: Math.round(nav.transferSize / 1024),
      decodedKB: Math.round(nav.decodedBodySize / 1024)
    };
  }
  const paint = performance.getEntriesByType('paint');
  const fcp = paint.find(p => p.name === 'first-contentful-paint');
  out.fcp = fcp ? Math.round(fcp.startTime) : null;

  // ---- Web Vitals ----
  out.vitals = { lcp: null, cls: 0, inp: null, lcpElement: null, lcpUrl: null, clsSources: [] };
  try {
    new PerformanceObserver(l => {
      const es = l.getEntries();
      const e = es[es.length - 1];
      out.vitals.lcp = Math.round(e.startTime);
      out.vitals.lcpElement = e.element ? e.element.tagName + '.' + String(e.element.className || '').split(' ')[0] : null;
      out.vitals.lcpUrl = e.url || null;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  let cls = 0;
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        cls += e.value;
        e.sources && e.sources.forEach(s => {
          if (s.node && out.vitals.clsSources.length < 5) {
            out.vitals.clsSources.push(s.node.tagName + '#' + (s.node.id || '') + (s.node.className ? '.' + String(s.node.className).split(' ')[0] : ''));
          }
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  out.vitals.cls = Math.round(cls * 1000) / 1000;
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        if (e.interactionId) { out.vitals.inp = Math.round(e.duration); break; }
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch {}

  // ---- 长任务 ----
  const lt = [];
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        if (e.duration > 50) lt.push({ ms: Math.round(e.duration), at: Math.round(e.startTime) });
      }
    }).observe({ entryTypes: ['longtask'], buffered: true });
  } catch {}
  out.longTasks = {
    count: lt.length,
    totalMs: lt.reduce((s, t) => s + t.ms, 0),
    maxMs: lt.length ? Math.max(...lt.map(t => t.ms)) : 0,
    list: lt.slice(-10)
  };

  // ---- 资源 ----
  const res = performance.getEntriesByType('resource');
  const byType = {}, byDomain = {};
  let totalSize = 0;
  res.forEach(r => {
    const t = r.initiatorType || 'other';
    byType[t] = byType[t] || { count: 0, size: 0 };
    byType[t].count++; byType[t].size += r.transferSize || 0;
    try {
      const d = new URL(r.name).hostname;
      byDomain[d] = byDomain[d] || { count: 0, size: 0 };
      byDomain[d].count++; byDomain[d].size += r.transferSize || 0;
    } catch {}
    totalSize += r.transferSize || 0;
  });
  out.resources = {
    total: res.length,
    totalKB: Math.round(totalSize / 1024),
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { count: v.count, kb: Math.round(v.size / 1024) }])),
    topDomains: Object.entries(byDomain).map(([d, v]) => ({ domain: d, count: v.count, kb: Math.round(v.size / 1024) })).sort((a, b) => b.kb - a.kb).slice(0, 10),
    heaviest: res.map(r => ({ url: r.name.split('?')[0], type: r.initiatorType, kb: Math.round((r.transferSize || 0) / 1024), ms: Math.round(r.duration) })).sort((a, b) => b.kb - a.kb).slice(0, 20),
    uncompressed: res
      .filter(r => r.transferSize && r.transferSize > 10240 && r.transferSize === r.decodedBodySize && !/\\.(png|jpe?g|gif|webp|avif|woff2?|mp4|webm|zip|gz)$/i.test(r.name))
      .map(r => ({ url: r.name.split('?')[0], kb: Math.round(r.transferSize / 1024) }))
      .slice(0, 10)
  };

  // ---- 脚本 / 样式 ----
  const scripts = Array.from(document.scripts);
  out.scripts = {
    total: scripts.length,
    inline: scripts.filter(s => !s.src).length,
    blocking: scripts.filter(s => s.src && !s.async && !s.defer).map(s => s.src.split('?')[0]).slice(0, 10)
  };
  out.styles = document.querySelectorAll('style, link[rel="stylesheet"]').length;

  // ---- 图片 ----
  const imgs = Array.from(document.images);
  out.images = {
    total: imgs.length,
    withoutAlt: imgs.filter(i => !i.alt).length,
    heavy: imgs.map(i => {
      const nw = i.naturalWidth, nh = i.naturalHeight;
      const r = i.getBoundingClientRect();
      return {
        src: (i.currentSrc || i.src).split('?')[0],
        natural: nw + 'x' + nh,
        display: Math.round(r.width) + 'x' + Math.round(r.height),
        oversized: r.width > 0 && nw > r.width * 2,
        lazy: i.loading === 'lazy',
        hasSrcset: !!i.srcset
      };
    }).filter(i => i.oversized).slice(0, 15)
  };

  // ---- 字体 ----
  const faces = [];
  try { document.fonts && document.fonts.forEach(f => faces.push({ family: f.family, weight: f.weight, status: f.status })); } catch {}
  out.fonts = { count: faces.length, faces: faces.slice(0, 10) };

  // ---- 框架检测 ----
  const w = window;
  out.framework = {
    next: !!w.__NEXT_DATA__,
    nuxt: !!w.__NUXT__,
    react: !!(w.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('#root, [data-reactroot]')),
    vue: !!(w.__VUE_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('#app, [data-v-app]')),
    jquery: !!w.jQuery,
    lodash: !!w._,
    analytics: !!(w.gtag || w.ga || w.dataLayer),
    sentry: !!(w.Sentry || w.Raven)
  };

  // ---- DOM 复杂度 ----
  const all = document.querySelectorAll('*');
  let maxDepth = 0;
  all.forEach(el => { let n = 0, p = el; while (p && n < 100) { n++; p = p.parentElement; } if (n > maxDepth) maxDepth = n; });
  out.dom = {
    elements: all.length,
    maxDepth,
    textKB: Math.round((document.body ? document.body.innerText.length : 0) / 102.4) / 10,
    iframes: document.querySelectorAll('iframe').length,
    tables: document.querySelectorAll('table').length
  };

  // ---- 安全 ----
  out.security = {
    https: location.protocol === 'https:',
    mixedContent: document.querySelectorAll('img[src^="http:"], script[src^="http:"], iframe[src^="http:"]').length,
    cspMeta: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
    forms: document.forms.length,
    insecurePasswordForms: [...document.querySelectorAll('form')].filter(f => f.method.toLowerCase() === 'get' && f.querySelector('input[type="password"]')).length
  };

  // ---- SEO ----
  out.seo = {
    title: document.title,
    titleLen: document.title.length,
    metaDescLen: (document.querySelector('meta[name="description"]')?.content || '').length,
    h1Count: document.querySelectorAll('h1').length,
    canonical: !!document.querySelector('link[rel="canonical"]'),
    ogComplete: ['title', 'description', 'image', 'url'].every(t => document.querySelector('meta[property="og:' + t + '"]')),
    structuredData: document.querySelectorAll('script[type="application/ld+json"]').length,
    viewport: !!document.querySelector('meta[name="viewport"]'),
    lang: document.documentElement.lang,
    links: document.links.length,
    internalLinks: [...document.querySelectorAll('a[href]')].filter(a => a.href.startsWith(location.origin) || a.href.startsWith('/')).length
  };

  // ---- A11y ----
  out.a11y = {
    imagesNoAlt: imgs.filter(i => !i.alt).length,
    inputsNoLabel: [...document.querySelectorAll('input:not([type="hidden"])')].filter(i => {
      const hasLabel = i.id && document.querySelector('label[for="' + i.id + '"]');
      return !hasLabel && !i.closest('label') && !i.getAttribute('aria-label') && !i.getAttribute('title');
    }).length,
    smallTargets: [...document.querySelectorAll('a, button')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
    }).length,
    missingLang: !document.documentElement.lang,
    ariaHiddenWithContent: [...document.querySelectorAll('[aria-hidden="true"]')].filter(el => el.textContent && el.textContent.trim()).length
  };

  // 等待 buffered 的 PerformanceObserver 回调执行完毕(否则 vitals 可能采不到)
  await new Promise(r => setTimeout(r, 50));

  return out;
})()`;

class CdpManager {
  constructor() {
    this.attachedTabs = new Set();
    this.failedTabs = new Set();
    this.netResponses = new Map();          // `${tabId}:${requestId}` -> meta
    this.enabled = new Set();               // 已启用核心域的 tabId
    this.throttled = false;                 // Chrome 136+ 授权窗口过期后的限速标记
    this.pendingAttach = new Map();         // tabId -> Promise 防止并发 attach 竞态
  }

  isAttached(tabId) { return this.attachedTabs.has(tabId); }

  attach(tabId) {
    return new Promise((resolve, reject) => {
      if (this.attachedTabs.has(tabId)) return resolve(true);
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          this.failedTabs.add(tabId);
          reject(new Error(`debugger attach 失败: ${chrome.runtime.lastError.message}`));
          return;
        }
        this.attachedTabs.add(tabId);
        this.failedTabs.delete(tabId);
        resolve(true);
      });
    });
  }

  /** 尝试 attach；失败静默。成功时自动启用核心域 — 并发去重 */
  async tryAttach(tabId) {
    if (this.attachedTabs.has(tabId)) return true;
    if (this.failedTabs.has(tabId)) return false;
    if (this.pendingAttach.has(tabId)) {
      try { await this.pendingAttach.get(tabId); return this.attachedTabs.has(tabId); } catch { return false; }
    }
    const p = (async () => {
      await this.attach(tabId);
      await this.enableCore(tabId);
    })();
    this.pendingAttach.set(tabId, p);
    try {
      await p;
      return true;
    } catch {
      return false;
    } finally {
      this.pendingAttach.delete(tabId);
    }
  }

  /** 启用核心 CDP 域(console 日志、网络响应记录、导航事件、弹窗拦截、输入焦点模拟)。
   *  全部成功才标记 enabled; 任一失败则下次命令自动重试。 */
  async enableCore(tabId) {
    if (this.enabled.has(tabId)) return;
    const fails = [];
    for (const m of ['Network.enable', 'Runtime.enable', 'Page.enable']) {
      try {
        await this.send(tabId, m);
      } catch (e) {
        fails.push(`${m}: ${e.message}`);
      }
    }
    // chrome-devtools-mcp 同款: 模拟"聚焦且激活"页面, 否则后台标签/失焦窗口下 Input 事件被丢弃
    try {
      await this.send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (e) {
      fails.push(`setFocusEmulationEnabled: ${e.message}`);
    }
    // 会话重放: detach/reattach 会清空 addScriptToEvaluateOnNewDocument, 需重注册 geo mock 等注入脚本
    const geoCfg = this._geoConfigs?.get(tabId);
    if (geoCfg) {
      try {
        const source = `(${this._geoInjectFn.toString()})(${JSON.stringify(geoCfg.latitude)}, ${JSON.stringify(geoCfg.longitude)}, ${JSON.stringify(geoCfg.accuracy)})`;
        const { identifier } = await this.send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source });
        this._geoScripts = this._geoScripts || new Map();
        this._geoScripts.set(tabId, identifier);
      } catch (e) {
        fails.push(`geo-replay: ${e.message}`);
      }
    }
    // locale mock 同样需要会话重放
    const localeCfg = this._localeConfigs?.get(tabId);
    if (localeCfg) {
      try {
        const source = `(${this._localeInjectFn.toString()})(${JSON.stringify(localeCfg.locale)})`;
        const { identifier } = await this.send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source });
        this._localeScripts = this._localeScripts || new Map();
        this._localeScripts.set(tabId, identifier);
      } catch (e) {
        fails.push(`locale-replay: ${e.message}`);
      }
    }
    if (fails.length) {
      console.log(`[ArkWeb] enableCore 部分失败 tab=${tabId}: ${fails.join(' | ')}`);
      this.send({ type: 'core-status', data: { tabId, fails } });
      return; // 不标记 enabled → 下次命令重试
    }
    this.enabled.add(tabId);
  }

  detach(tabId) {
    this.attachedTabs.delete(tabId);
    this.failedTabs.delete(tabId);
    this.enabled.delete(tabId);
    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        if (chrome.runtime.lastError) { /* 忽略 */ }
        resolve();
      });
    });
  }

  detachAll() {
    const ids = [...this.attachedTabs];
    this.attachedTabs.clear();
    this.enabled.clear();
    return Promise.all(ids.map(id => this.detach(id)));
  }

  send(tabId, method, params = {}) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      // 注意: sendCommand 的 target 参数必须是 Debuggee 对象 {tabId}, 不是数字
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        const ms = Date.now() - t0;
        // 限速检测: Chrome 136+ 授权窗口过期后, Input 命令约 5s/个, awaitPromise 约 1s
        if (ms > 1000 && (method.startsWith('Input.') || (method === 'Runtime.evaluate' && params.awaitPromise))) {
          this.throttled = true;
        }
        if (chrome.runtime.lastError) {
          reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
          return;
        }
        resolve(result || {});
      });
    });
  }

  /** CDP 命令超时包装: 个别命令(授权窗口过期后)可能不回调, 超时即抛错且不阻塞其他命令 */
  sendWithTimeout(tabId, method, params = {}, timeout = 4000) {
    return Promise.race([
      this.send(tabId, method, params),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} timeout after ${timeout}ms`)), timeout))
    ]);
  }

  /** 在页面中执行表达式(支持 await、自动包装、超时保护)。
   *  策略: 先按表达式包装; 语法错误时回退为语句块包装(覆盖 return/声明/混合语句)。 */
  async evaluate(tabId, code, timeout = 10000) {
    let r = await this.evalOnce(tabId, code, timeout, 'expr');
    if (!r.success && /SyntaxError|Unexpected token|Invalid or unexpected token/.test(r.error)) {
      r = await this.evalOnce(tabId, code, timeout, 'stmt');
    }
    return r;
  }

  async evalOnce(tabId, code, timeout, mode) {
    const expression = this.wrapExpression(code, timeout, mode);
    // 命令级超时: 页面冻结时页面内 setTimeout 不触发, 裸 send 会永久挂起(挂到 server 层 20s+)
    // 超时后由 runInPage 兜底(executeScript)接管
    const { result, exceptionDetails } = await this.sendWithTimeout(tabId, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, Math.min(6000 + timeout, 30000));
    if (exceptionDetails) {
      const desc = exceptionDetails.exception?.description
        || exceptionDetails.exception?.value
        || exceptionDetails.text
        || 'Unknown error';
      return { success: false, error: String(desc) };
    }
    return { success: true, result: result.value };
  }

  wrapExpression(code, timeout = 10000, mode = 'expr') {
    let trimmed = String(code || '').trim();
    if (!trimmed) return 'undefined';
    trimmed = trimmed.replace(/;\s*$/, '');
    const inner = mode === 'stmt'
      ? `(async () => { ${trimmed} })()`
      : `(async () => (${trimmed}))()`;
    // 超时保护: Promise.race 保证超时后 reject(注意: setTimeout 回调内 throw 无法影响外层 promise)
    return `(async () => {
      let timer;
      const timeoutPromise = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('evaluate timeout after ${timeout}ms')), ${timeout});
      });
      try {
        return await Promise.race([(${inner}), timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    })()`;
  }

  /** 从页面取元素信息 + 滚动到可视区 */
  async elementRect(tabId, selector) {
    const r = await this.evaluate(tabId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        x: rect.x + window.scrollX, y: rect.y + window.scrollY,
        cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2,
        width: rect.width, height: rect.height,
        visible: rect.width > 0 && rect.height > 0 &&
                 style.visibility !== 'hidden' && style.display !== 'none',
        tag: el.tagName, text: (el.textContent || '').slice(0, 80)
      };
    })()`);
    return r.success ? r.result : null;
  }

  /** 整页截图：captureBeyondViewport + clip 一次截全页 */
  async fullPageShot(tabId, format = 'png', quality = 80) {
    const dims = await this.evaluate(tabId, `(() => ({
      w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
      h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
    }))()`);
    if (!dims.success) throw new Error('无法获取页面尺寸');
    const { w, h } = dims.result;
    try {
      const shot = await this.sendWithTimeout(tabId, 'Page.captureScreenshot', {
        format, quality,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.max(1, w), height: Math.max(1, h), scale: 1 }
      }, 20000);
      return shot.data;
    } catch {
      // fallback: 临时放大视口截全页。所有 CDP 调用必须带超时, 否则渲染忙时会挂到请求层超时
      try {
        const before = await this.evaluate(tabId, `({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
        await this.sendWithTimeout(tabId, 'Emulation.setDeviceMetricsOverride', {
          width: Math.max(1, w), height: Math.max(1, h),
          deviceScaleFactor: before.result?.dpr || 1, mobile: false
        }, 5000);
        await new Promise(r => setTimeout(r, 300));
        const shot = await this.sendWithTimeout(tabId, 'Page.captureScreenshot', { format, quality }, 10000);
        try {
          await this.sendWithTimeout(tabId, 'Emulation.clearDeviceMetricsOverride', {}, 5000);
        } catch {
          // clear 失败 → detach 强制重置(防 override 残留污染后续视口), 下次命令会自动重新 attach
          try { await this.detach(tabId); } catch { /* ignore */ }
        }
        return shot.data;
      } catch (e2) {
        throw new Error(`fullPageShot fallback 失败: ${e2.message}`);
      }
    }
  }
}

class ArkWeb {
  constructor() {
    this.ws = null;
    // 连接配置: 默认与本机 server 对齐(127.0.0.1:9334, 无令牌);
    // 可在 popup 修改并持久化到 chrome.storage.local(键: arkWsHost / arkWsPort / arkWsToken)
    this.wsHost = '127.0.0.1';
    this.serverPort = 9334;
    this.wsToken = '';
    this.connected = false;
    this.requestId = 0;
    this._swStartedAt = Date.now();
    this._cdpEventCount = 0;
    this.networkLogs = new Map();
    this.consoleLogs = new Map();
    this.domChanges = new Map();
    this.cdp = new CdpManager();
    this.deviceOverrides = new Map();   // tabId -> {config, origUA}
    this._viewportProbe = new Map();    // tabId -> {ts, result}: 视口探测缓存(避免每条命令多一次 evaluate)
    this._pendingNav = new Map();       // tabId -> {url, ts}: 刚触发的导航, 供 wait-for-load 判定"新文档"而非旧文档
    this._activeTabId = null;
    this.consoleFlushTimers = new Map(); // tabId -> timer(节流转发)
    this.dialogLogs = new Map();        // tabId -> [{message, type, url, timestamp}]
    this.init();
  }

  init() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });

    // ============ SW 保活层 ============
    // 1) alarms 周期唤醒: 即使 SW 休眠, Chrome 也会唤醒执行 onAlarm(116+ 支持)
    try {
      chrome.alarms.create('ark-web-keepalive', { periodInMinutes: 1 });
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm?.name === 'ark-web-keepalive') {
          // no-op: 只需 SW 保持唤醒; 顺带重连 WebSocket(若断开)
          this.ensureConnected();
        }
      });
    } catch (e) {
      console.log('[ArkWeb] alarms 不可用:', e.message);
    }
    // 2) content script keepalive port: 有标签页打开时, 长连接端口持续保活 SW
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== 'ark-web-keepalive') return;
      const keep = () => { try { port.postMessage({ type: 'pong', t: Date.now() }); } catch { /* 端口已断 */ } };
      port.onMessage.addListener((msg) => { if (msg?.type === 'ping') keep(); });
      port.onDisconnect.addListener(() => { /* 页面关闭, 端口结束; alarms 兜底 */ });
    });

    if (chrome.webRequest) {
      chrome.webRequest.onBeforeRequest.addListener(
        (d) => this.onBeforeRequest(d),
        { urls: ['<all_urls>'] }, ['requestBody']
      );
      chrome.webRequest.onCompleted.addListener(
        (d) => this.onRequestCompleted(d),
        { urls: ['<all_urls>'] }
      );
    }

    chrome.debugger.onEvent.addListener((source, method, params) => {
      this.onCdpEvent(source.tabId, method, params);
    });
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId) {
        this.cdp.attachedTabs.delete(source.tabId);
        this.cdp.enabled.delete(source.tabId);
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.cdp.attachedTabs.delete(tabId);
      this.cdp.failedTabs.delete(tabId);
      this.cdp.enabled.delete(tabId);
      this.networkLogs.delete(tabId);
      this.consoleLogs.delete(tabId);
      this._dialogPolicies?.delete(tabId);
      if (this._activeTabId === tabId) this._activeTabId = null;
    });

    // activeTabId 缓存
    chrome.tabs.onActivated.addListener(({ tabId }) => { this._activeTabId = tabId; });
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.active) this._activeTabId = tab.id;
      // v8 预热: 新 tab 300ms 后尝试预 attach + enableCore, 使首个命令省 80-120ms
      if (tab.id && tab.url && !String(tab.url).startsWith('chrome://') && !String(tab.url).startsWith('chrome-extension://')) {
        setTimeout(() => this.cdp.tryAttach(tab.id).then(ok=>{ if(ok) this.cdp.enableCore(tab.id).catch(()=>{}); }).catch(()=>{}), 350);
      }
    });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.url || info.status === 'loading') {
        // 导航开始则失效探针缓存(窗口 focus/授权可能变化)与旧 snapshot 关联
        this._probeCache?.delete(tabId);
      }
      if (info.status === 'complete' && !this.cdp.attachedTabs.has(tabId)) {
        // 导航完成但未 attach 的 tab，后台预热
        setTimeout(() => this.cdp.tryAttach(tabId).then(ok=>{ if(ok) this.cdp.enableCore(tabId).catch(()=>{}); }).catch(()=>{}), 200);
      }
    });
    chrome.tabs.query({ active: true, currentWindow: true })
      .then(([t]) => { this._activeTabId = t?.id || null; })
      .catch(() => {});
    chrome.runtime.onStartup.addListener(() => this.connectToServer());

    // 连接配置变更(用户在 popup 改了端口/令牌) → 断开重连
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!['arkWsHost', 'arkWsPort', 'arkWsToken'].some(k => k in changes)) return;
      try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
      this.loadWsConfig().then(() => this.connectToServer());
    });

    this.loadWsConfig().then(() => this.connectToServer());
    setInterval(() => {
      if (!this.connected) this.connectToServer();
      else this.send({ type: 'ping' });
    }, 15000);
  }

  /** 识别真实浏览器内核: chrome / quark(夸克) / edge / brave / chromium
   *  (用于 /status 上报, 便于区分"插件没连上"与"夸克内核行为差异") */
  detectKernel() {
    try {
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      if (/Quark/i.test(ua)) return 'quark';
      if (/Edg\//i.test(ua)) return 'edge';
      if (/Brave/i.test(ua)) return 'brave';
      if (/Chrome\//i.test(ua)) return 'chrome';
      return 'chromium';
    } catch { return 'unknown'; }
  }

  // ============ 连接配置(popup 可改, 持久化) ============

  async loadWsConfig() {
    try {
      const cfg = await chrome.storage.local.get(['arkWsHost', 'arkWsPort', 'arkWsToken']);
      if (cfg.arkWsHost) this.wsHost = String(cfg.arkWsHost).trim();
      if (cfg.arkWsPort) this.serverPort = parseInt(cfg.arkWsPort, 10) || 9334;
      this.wsToken = cfg.arkWsToken ? String(cfg.arkWsToken).trim() : '';
    } catch { /* storage 不可用时用默认值 */ }
    return { host: this.wsHost, port: this.serverPort, token: this.wsToken };
  }

  async saveWsConfig(partial = {}) {
    const next = {
      ...(partial.host != null ? { arkWsHost: String(partial.host).trim() } : {}),
      ...(partial.port != null ? { arkWsPort: String(parseInt(partial.port, 10) || 9334) } : {}),
      ...(partial.token != null ? { arkWsToken: String(partial.token).trim() } : {})
    };
    await chrome.storage.local.set(next);
    await this.loadWsConfig();
    return { host: this.wsHost, port: this.serverPort, token: this.wsToken };
  }

  // ============ WebSocket 管理 ============

  /** alarms 唤醒入口: SW 休眠恢复后确保 WS 已连接(连接在则 no-op) */
  ensureConnected() {
    if (!this.connected) this.connectToServer();
    else this.send({ type: 'ping' });
  }

  connectToServer() {
    try {
      const host = this.wsHost || '127.0.0.1';
      // 令牌经查询串传递(仅本机回环链路; server 配置了 ARK_TOKEN 时必须一致)
      const qs = this.wsToken ? `?token=${encodeURIComponent(this.wsToken)}` : '';
      this.ws = new WebSocket(`ws://${host}:${this.serverPort}${qs}`);
      this.ws.onopen = () => {
        this.connected = true;
        this.send({
          type: 'register',
          data: {
            // 真实内核标识: 扩展本身跑在 chromium 内核上, 但用户实际可能用夸克/Edge 等套壳浏览器
            browser: this.detectKernel(),
            version: chrome.runtime.getManifest().version,
            cdp: true,
            timestamp: Date.now()
          }
        });
        this.notifyPopup({ type: 'connection-status', connected: true });
      };
      this.ws.onmessage = (event) => {
        try { this.handleServerMessage(JSON.parse(event.data)); }
        catch (e) { console.error('[ArkWeb] 消息解析错误:', e); }
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.notifyPopup({ type: 'connection-status', connected: false });
      };
      this.ws.onerror = () => { this.connected = false; };
    } catch { this.connected = false; }
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  // ============ 服务器消息处理 ============

  async handleServerMessage(message) {
    const { id, type, data } = message;
    try {
      const result = await this.dispatch(type, data || {});
      this.send({ id, type: 'response', data: result });
    } catch (e) {
      this.send({ id, type: 'error', data: { message: e.message } });
    }
  }

  /** 批量命令: 一次 WS 往返执行多个步骤, 返回结果数组 */
  async runBatch(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return { error: 'steps is required' };
    const t0 = Date.now();
    const results = [];
    // 批内 tab 跟踪: open-url 新建标签页后, 后续无 tabId 步骤自动跟随新 tab(不漂移到用户当前标签页)
    let trackedTab = null;
    // v8: 支持 _parallel 标记的连续只读步骤并行执行(同 WS 往返内 3-5 倍提速)
    // 例: [{type:'get-page-info', data:{_parallel:true}}, {type:'get-dom', data:{_parallel:true}}] → Promise.all
    let i = 0;
    while (i < steps.length) {
      const step = steps[i];
      const data = step.data || (step.data = {});
      const isPar = !!(data._parallel || step.parallel || data.parallel);
      if (isPar) {
        // 收集连续 _parallel 块
        const chunk = [];
        const idxs = [];
        const chunkStartTab = trackedTab;
        while (i < steps.length) {
          const s = steps[i];
          const d = s.data || (s.data = {});
          if (!(d._parallel || s.parallel || d.parallel)) break;
          // 冻结 chunk 起始的 trackedTab，避免并发写竞态
          if (d.tabId != null) {
            // 显式 tabId 的步骤不跟随，但更新后续 chunkStart 的锚定(仅串行时生效)
          } else if (chunkStartTab != null) d.tabId = chunkStartTab;
          // 清理标记避免污染插件 dispatch
          delete d._parallel; delete d.parallel;
          chunk.push(s); idxs.push(i);
          i++;
        }
        // 并行块内含写操作(open-url/activate-tab 等)则退化为串行，避免 trackedTab 竞态与 tab 漂移
        const writeInPar = chunk.some(s => ['open-url','activate-tab','close-tab','click-element','hover-element','double-click','right-click','drag-element','mouse','simulate-key','type-text','fill-form','select-option','check-box','clear-field','focus-element','reload','back','forward','highlight-elements','clear-highlights','evaluate','set-storage','remove-storage','clear-storage','set-cookie','remove-cookie','upload-file'].includes(s.type));
        if (writeInPar) {
          // 回退为串行逐条执行(保持保序)
          for (const s of chunk) {
            const sd = s.data || {};
            const s0 = Date.now();
            try {
              if (sd.tabId != null) trackedTab = sd.tabId;
              else if (trackedTab != null) sd.tabId = trackedTab;
              const tm = typeof sd.timeout === 'number' && sd.timeout > 0 ? sd.timeout : null;
              const r = tm ? await Promise.race([this.dispatch(s.type, sd), new Promise((_, rej) => setTimeout(() => rej(new Error(`步骤超时(${tm}ms)`)), tm))]) : await this.dispatch(s.type, sd);
              results.push({ type: s.type, result: r, _ms: Date.now() - s0 });
              if (s.type === 'open-url' && sd.current !== true && r?.tab?.id != null) trackedTab = r.tab.id;
              if (s.type === 'activate-tab' && r?.tabId != null) trackedTab = r.tabId;
            } catch (e) { results.push({ type: s.type, error: e.message, _ms: Date.now() - s0 }); }
          }
          continue;
        }
        const settled = await Promise.all(chunk.map(async (s) => {
          const sd = s.data || {};
          const tm = typeof sd.timeout === 'number' && sd.timeout > 0 ? sd.timeout : null;
          const s0 = Date.now();
          try {
            const r = tm ? await Promise.race([this.dispatch(s.type, sd), new Promise((_, rej) => setTimeout(() => rej(new Error(`步骤超时(${tm}ms)`)), tm))]) : await this.dispatch(s.type, sd);
            const out = { type: s.type, result: r, _ms: Date.now() - s0 };
            return out;
          } catch (e) { return { type: s.type, error: e.message, _ms: Date.now() - s0 }; }
        }));
        // 并行块结束后，若块内无写，则 trackedTab 保持 chunkStartTab；若有显式 tabId 的读，其 trackedTab 不更新(读不漂移)
        for (const r of settled) results.push(r);
        continue;
      }
      // 串行路径
      const s0 = Date.now();
      try {
        if (data.tabId != null) trackedTab = data.tabId;
        else if (trackedTab != null) data.tabId = trackedTab;
        delete data._parallel; delete data.parallel;
        const stepTimeout = typeof data.timeout === 'number' && data.timeout > 0 ? data.timeout : null;
        const r = stepTimeout
          ? await Promise.race([
              this.dispatch(step.type, data),
              new Promise((_, rej) => setTimeout(() => rej(new Error(`步骤超时(${stepTimeout}ms)`)), stepTimeout))
            ])
          : await this.dispatch(step.type, data);
        results.push({ type: step.type, result: r, _ms: Date.now() - s0 });
        if (step.type === 'open-url' && data.current !== true && r?.tab?.id != null) trackedTab = r.tab.id;
        if (step.type === 'activate-tab' && r?.tabId != null) trackedTab = r.tabId;
      } catch (e) {
        results.push({ type: step.type, error: e.message, _ms: Date.now() - s0 });
      }
      i++;
    }
    return { success: true, steps: results, total: Date.now() - t0 };
  }

  /** 命令分发：优先 CDP，失败自动降级 */
  async dispatch(type, data) {
    const tabId = data.tabId || await this.activeTabId();

    switch (type) {
      // ---------- 基础 ----------
      case 'ping': return { pong: true };
      case 'get-status': return this.getStatus();

      // ---------- 批量 ----------
      case 'batch': return this.runBatch(data.steps);

      // ---------- 标签页 ----------
      case 'get-tabs': return this.getTabs();
      case 'open-url': return this.openUrl(data);
      case 'activate-tab': return this.activateTab(data.tabId);
      case 'close-tab': return this.closeTab(data.tabId);

      // ---------- 导航 ----------
      case 'reload': {
        if (tabId != null && await this.cdp.tryAttach(tabId)) {
          try {
            await this.cdp.send(tabId, 'Page.reload', { ignoreCache: !!data.ignoreCache });
            return { success: true, method: 'cdp' };
          } catch { /* fallback */ }
        }
        if (tabId != null) { await chrome.tabs.reload(tabId); return { success: true, method: 'script' }; }
        return { error: 'No active tab' };
      }
      case 'navigate': return this.navigateCurrent(tabId, data);
      case 'back': case 'forward': {
        if (tabId != null && await this.cdp.tryAttach(tabId)) {
          try {
            const hist = await this.cdp.send(tabId, 'Page.getNavigationHistory');
            const idx = hist.currentIndex + (type === 'back' ? -1 : 1);
            const entry = hist.entries[idx];
            if (entry) {
              await this.cdp.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
              return { success: true, url: entry.url, method: 'cdp' };
            }
            return { success: false, error: 'No history' };
          } catch { /* fallback */ }
        }
        if (tabId == null) return { error: 'No active tab' };
        await chrome.scripting.executeScript({
          target: { tabId }, func: (d) => history[d === 'back' ? 'back' : 'forward'](), args: [type]
        });
        return { success: true, method: 'script' };
      }

      // ---------- 页面信息 / DOM ----------
      case 'get-page-info': return tabId != null ? this.getPageInfo(tabId) : { error: 'No active tab' };
      case 'get-dom': return tabId != null ? this.getDOM(tabId) : { error: 'No active tab' };
      case 'get-html': return tabId != null ? this.getHTML(tabId, data.selector) : { error: 'No active tab' };
      case 'get-frames': return this.getFrames(tabId);
      case 'get-layout': return this.getLayout(tabId);
      case 'query-selector': return this.querySelector(tabId, data);
      case 'query-all': return this.queryAll(tabId, data);
      case 'query-many': return this.queryMany(tabId, data);
      case 'element-exists': return this.elementExists(tabId, data.selector);
      case 'get-text': return this.getText(tabId, data.selector);
      case 'get-attr': return this.getAttr(tabId, data.selector, data.name);
      case 'get-value': return this.getValue(tabId, data.selector);

      // ---------- 元素操作 ----------
      case 'click-element': return this.clickElement(tabId, data);
      case 'hover-element': return this.hoverElement(tabId, data);
      case 'double-click': return this.doubleClick(tabId, data);
      case 'right-click': return this.rightClick(tabId, data);

      // ---------- 视觉 ref 操作(按 SoM 编号, 无需坐标) ----------
      case 'click-ref': return this.clickRef(tabId, data);
      case 'hover-ref': return this.hoverRef(tabId, data);
      case 'fill-ref': return this.fillRef(tabId, data);
      case 'read-text': return this.readTextRef(tabId, data);
      case 'zoom-shot': return this.zoomShot(tabId, data);
      case 'text-map': return this.textMap(tabId, data);
      case 'find-text': return this.findText(tabId, data);

      // ---------- 自更新 ----------
      case 'reload-extension': return this.reloadExtension();
      case 'drag-element': return this.dragElement(tabId, data);
      case 'mouse': return this.mouseEvent(tabId, data);
      case 'scroll-page': return this.scrollPage(tabId, data);
      case 'scroll-into-view': return this.scrollIntoView(tabId, data.selector, data);
      case 'scroll-by': return this.scrollBy(tabId, data);

      // ---------- 键盘 / 输入 ----------
      case 'simulate-key': return this.simulateKey(tabId, data);
      case 'type-text': return this.typeText(tabId, data);
      case 'fill-form': return this.fillForm(tabId, data);
      case 'select-option': return this.selectOption(tabId, data);
      case 'check-box': return this.checkBox(tabId, data);
      case 'clear-field': return this.clearField(tabId, data.selector);
      case 'focus-element': return this.focusElement(tabId, data.selector);

      // ---------- JS 执行 / 等待 ----------
      case 'evaluate': return this.evaluateJS(tabId, data);
      case 'wait-for-selector': return this.waitForSelector(tabId, data);
      case 'wait-for-text': return this.waitForText(tabId, data);
      case 'wait-for-url': return this.waitForUrl(tabId, data);
      case 'wait-for-load': return this.waitForLoad(tabId, data);
      case 'wait-for-stable': return this.waitForStable(tabId, data);

      // ---------- 截图 / PDF ----------
      case 'screenshot': return this.screenshot(tabId, data);
      case 'screenshot-full': return this.screenshotFull(tabId, data);
      case 'screenshot-element': return this.screenshotElement(tabId, data);
      case 'vision-snapshot':
      case 'get-snapshot':
      case 'snapshot': return this.visionSnapshot(tabId, data);
      case 'print-to-pdf': return this.printToPdf(tabId, data);
      case 'highlight-elements': return this.highlight(tabId, data);
      case 'clear-highlights': return this.clearHighlight(tabId);

      // ---------- 弹窗 ----------
      case 'dialog': return this.handleDialog(tabId, data);
      case 'get-dialogs': return this.getDialogs(tabId);

      // ---------- 模拟(环境) ----------
      case 'auto-dark-mode': return this.autoDarkMode(tabId, data);
      case 'set-script-disabled': return this.setScriptDisabled(tabId, data);
      case 'set-hardware-concurrency': return this.setHardwareConcurrency(tabId, data);
      case 'reset-all-simulations': return this.resetAllSimulations(tabId);

      // ---------- Cookie ----------
      case 'get-cookies': return this.getCookies(tabId);
      case 'set-cookie': return this.setCookie(data);
      case 'remove-cookie': return this.removeCookie(data);

      // ---------- Storage ----------
      case 'get-storage': return this.getStorage(tabId, data);
      case 'set-storage': return this.setStorage(tabId, data);
      case 'remove-storage': return this.removeStorage(tabId, data);
      case 'clear-storage': return this.clearStorage(tabId, data);
      case 'get-storage-changes': return this.getStorageChanges(tabId);

      // ---------- 网络 ----------
      case 'get-network-logs': return this.getNetworkLogs(tabId, data);
      case 'clear-network-logs': return this.clearNetworkLogs(tabId);
      case 'get-response-body': return this.getResponseBody(tabId, data);
      case 'block-urls': return this.blockUrls(tabId, data);
      case 'unblock-urls': return this.unblockUrls(tabId);
      case 'set-network-conditions': return this.setNetworkConditions(tabId, data);
      case 'reset-network-conditions': return this.resetNetworkConditions(tabId);
      case 'set-cache-disabled': return this.setCacheDisabled(tabId, data);
      case 'bypass-csp': return this.bypassCsp(tabId, data);

      // ---------- 性能 ----------
      case 'get-performance': return tabId != null ? this.getPerformance(tabId) : { error: 'No active tab' };
      case 'get-web-vitals': return tabId != null ? this.getWebVitals(tabId) : { error: 'No active tab' };
      case 'get-resources': return tabId != null ? this.getResources(tabId) : { error: 'No active tab' };
      case 'set-cpu-throttling': return this.setCpuThrottling(tabId, data);

      // ---------- 模拟 ----------
      case 'simulate-device': return this.simulateDevice(tabId, data);
      case 'clear-device': return this.clearDevice(tabId);
      case 'emulate-media': return this.emulateMedia(tabId, data);
      case 'set-geolocation': return this.setGeolocation(tabId, data);
      case 'set-locale': return this.setLocale(tabId, data);
      case 'set-timezone': return this.setTimezone(tabId, data);

      // ---------- 安全检查 ----------
      case 'security-check': return tabId != null ? this.securityCheck(tabId) : { error: 'No active tab' };
      case 'a11y-check': return tabId != null ? this.a11yCheck(tabId) : { error: 'No active tab' };
      case 'seo-check': return tabId != null ? this.seoCheck(tabId) : { error: 'No active tab' };

      // ---------- 控制台 / DOM 变化 ----------
      case 'get-console-logs': return this.getConsoleLogs(tabId, data);
      case 'clear-console-logs': return this.clearConsoleLogs(tabId);
      case 'get-dom-changes': return this.getDomChanges(tabId);
      case 'clear-dom-changes': return this.clearDomChanges(tabId);

      // ---------- 文件 ----------
      case 'upload-file': return this.uploadFile(tabId, data);

      // ---------- 审计 ----------
      case 'audit-collect': return this.auditCollect(tabId, data);

      // ---------- 浏览器级 ----------
      case 'cdp-attach-all': return this.attachAllTabs();
      case 'cdp-detach-all': return this.cdp.detachAll().then(() => ({ success: true }));
      case 'get-browser-info': return this.getBrowserInfo();
      case 'get-cdp-status': return {
        attached: [...this.cdp.attachedTabs],
        enabled: [...this.cdp.enabled],
        failed: [...this.cdp.failedTabs],
        throttled: this.cdp.throttled,
        eventCount: this._cdpEventCount || 0,
        swStartedAt: this._swStartedAt,
        dialogLogs: Object.fromEntries([...this.dialogLogs.entries()].map(([k, v]) => [k, v.length])),
        netResponses: this.cdp.netResponses.size
      };

      default: return { error: `Unknown command: ${type}` };
    }
  }

  // ============ 标签页 ============

  async activeTabId() {
    if (this._activeTabId != null) return this._activeTabId;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    this._activeTabId = tab?.id || null;
    return this._activeTabId;
  }

  async getTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({
      id: t.id, url: t.url, title: t.title,
      active: t.active, windowId: t.windowId, incognito: t.incognito
    }));
  }

  async openUrl(data) {
    const { url } = data;
    if (!url) return { error: 'URL is required' };
    // 当前标签页导航模式: 优先使用请求指定的 tabId, 仅在缺省时才回退 activeTabId。
    // 修复: 多标签并行时 current 导航曾错误作用到"当前激活标签页"而非请求目标。
    if (data.current) {
      const target = data.tabId != null ? data.tabId : await this.activeTabId();
      return this.navigateCurrent(target, data);
    }
    const tab = await chrome.tabs.create({ url, active: data.active !== false });
    // 仅在确实前台打开时更新 activeTabId 缓存。后台 tab(active:false)绝不能写缓存:
    // 否则污染活动标签页判定 → 截图兜底/默认路由全部指向错误 tab(实测会把用户当前页面截走)
    if (tab.active) this._activeTabId = tab.id;
    // 登记导航: 紧随其后的 wait-for-load 需等待【新文档】, 不能因旧文档已 complete 就返回
    this._pendingNav.set(tab.id, { url, ts: Date.now() });
    return { success: true, tab: { id: tab.id, url: tab.url, title: tab.title }, usedActive: data.active !== false };
  }

  /** 在当前标签页导航(不新开 tab)。CDP 优先, 可获取导航错误 */
  async navigateCurrent(tabId, data) {
    const { url } = data;
    if (!url) return { error: 'URL is required' };
    if (tabId == null) return { error: 'No active tab' };
    this._pendingNav.set(tabId, { url, ts: Date.now() });   // 同上: 供 wait-for-load 判定新文档
    if (await this.cdp.tryAttach(tabId)) {
      try {
        const r = await this.cdp.send(tabId, 'Page.navigate', { url });
        if (r.errorText) return { success: false, error: r.errorText };
        return { success: true, tabId, method: 'cdp' };
      } catch { /* fallback */ }
    }
    await chrome.tabs.update(tabId, { url });
    return { success: true, tabId, method: 'script' };
  }

  async activateTab(tabId) {
    if (!tabId) return { error: 'tabId is required' };
    await chrome.tabs.update(tabId, { active: true });
    this._activeTabId = tabId;
    return { success: true, tabId };
  }

  async closeTab(tabId) {
    if (!tabId) return { error: 'tabId is required' };
    await chrome.tabs.remove(tabId);
    return { success: true, tabId };
  }

  // ============ 页面信息 / DOM ============

  /** 在页面执行函数(双通道):
   *   1) CDP Runtime.evaluate(主 world, 毫秒级)优先 — executeScript 在授权窗口过期/Chrome 异常时可能挂起;
   *   2) chrome.scripting.executeScript(isolated world)兜底, 3s 超时保护。 */
  async runInPage(tabId, func, args = []) {
    if (tabId == null) throw new Error('No active tab');
    if (this.cdp.attachedTabs.has(tabId)) {
      const r = await this.cdp.evaluate(tabId, `(${func.toString()}).apply(null, ${JSON.stringify(args)})`, 6000);
      if (r.success) return r.result;
      if (!/timeout after/.test(r.error || '')) {
        throw new Error(`页面脚本错误: ${r.error}`);
      }
      // evaluate 超时(渲染进程繁忙): 落入 executeScript 兜底
    }
    const results = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func, args }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('executeScript timeout')), 3000))
    ]);
    const out = results[0];
    if (out?.error) {
      const msg = out.error.message || JSON.stringify(out.error);
      throw new Error(`页面脚本错误: ${msg}`);
    }
    return out?.result;
  }

  async getPageInfo(tabId) {
    return this.runInPage(tabId, () => ({
      url: location.href,
      title: document.title,
      charset: document.characterSet,
      readyState: document.readyState,
      doctype: document.doctype?.name || null,
      lang: document.documentElement.lang,
      referrer: document.referrer,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      meta: {
        description: document.querySelector('meta[name="description"]')?.content,
        keywords: document.querySelector('meta[name="keywords"]')?.content,
        viewport: document.querySelector('meta[name="viewport"]')?.content,
        robots: document.querySelector('meta[name="robots"]')?.content
      },
      counts: {
        links: document.links.length,
        scripts: document.scripts.length,
        styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
        forms: document.forms.length,
        inputs: document.querySelectorAll('input, textarea, select').length,
        iframes: document.querySelectorAll('iframe').length
      }
    }));
  }

  async getDOM(tabId) {
    return this.runInPage(tabId, () => ({
      url: location.href,
      title: document.title,
      elements: document.querySelectorAll('*').length,
      images: document.images.length,
      links: document.links.length,
      forms: document.forms.length,
      scripts: document.scripts.length,
      text: (document.body ? document.body.innerText : '').slice(0, 10000),
      meta_description: document.querySelector('meta[name="description"]')?.content,
      canonical: document.querySelector('link[rel="canonical"]')?.href,
      lang: document.documentElement.lang
    }));
  }

  async getHTML(tabId, selector) {
    return this.runInPage(tabId, (sel) => {
      if (sel) {
        const el = document.querySelector(sel);
        return el ? el.outerHTML : null;
      }
      return document.documentElement.outerHTML;
    }, [selector || null]);
  }

  /** iframe 树 (CDP Page.getFrameTree) */
  async getFrames(tabId) {
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    try {
      const { frameTree } = await this.cdp.send(tabId, 'Page.getFrameTree');
      return { success: true, frameTree };
    } catch (e) {
      return { error: e.message };
    }
  }

  /** 页面布局指标 (CDP Page.getLayoutMetrics) */
  async getLayout(tabId) {
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    try {
      return { success: true, ...(await this.cdp.send(tabId, 'Page.getLayoutMetrics')) };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ============ 弹窗处理 ============

  /**
   * 弹窗策略: 事件驱动自动应答(默认开启)。
   * 设计依据: 模态弹窗会阻塞渲染主线程, 点击命令的 mouseReleased 要等 dialog 关闭才返回(ferrum #430);
   * 在 Page.javascriptDialogOpening 回调内【同步自动应答】, 挂起的命令随后自然恢复, 不再死锁。
   * POST /dialog {auto:false} 可切手动模式; {auto:true, promptText} 设置策略与 prompt 默认文本。
   * 策略按 tabId 隔离(多标签并行时 A 切手动不影响 B 的自动应答); 未设置过的 tab 用全局默认。
   */
  getDialogPolicy(tabId) {
    const p = this._dialogPolicies?.get(tabId);
    if (p) return p;
    return this._dialogPolicy || (this._dialogPolicy = { autoAccept: true, promptText: null });
  }

  /** 幂等应答当前弹窗: 无弹窗时 -32602 视为已处理(看门狗核心原语) */
  async probeAndCloseDialog(tabId) {
    try {
      await this.cdp.sendWithTimeout(tabId, 'Page.handleJavaScriptDialog', { accept: true }, 5000);
      return { responded: true };
    } catch (e) {
      const code = e.message?.match(/-32602|No dialog is showing/) ? -32602 : null;
      return { responded: false, alreadyHandled: code === -32602, error: e.message };
    }
  }

  /** 手动应答(或设置策略) */
  async handleDialog(tabId, data) {
    const { accept = true, promptText, auto } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    // 策略切换
    if (auto !== undefined) {
      const p = this.getDialogPolicy(tabId);
      p.autoAccept = auto === true || auto === 'true';
      if (promptText !== undefined) p.promptText = String(promptText);
      // 按 tab 持久化策略(per-tab 隔离); 显式 tabId 才有意义, 无 tabId 时退化为全局默认策略
      if (tabId != null) {
        this._dialogPolicies = this._dialogPolicies || new Map();
        this._dialogPolicies.set(tabId, { autoAccept: p.autoAccept, promptText: p.promptText });
      }
      return { success: true, policy: { ...p }, perTab: tabId != null ? tabId : null };
    }
    try {
      // 手动应答: 弹窗出现有 ~百 ms 延迟(JS 调用到 CDP 事件), 短重试避免 "No dialog is showing" 竞态
      let lastErr = null;
      for (let i = 0; i < 5; i++) {
        try {
          await this.cdp.send(tabId, 'Page.handleJavaScriptDialog', {
            accept,
            ...(promptText != null ? { promptText: String(promptText) } : {})
          });
          return { success: true, accept, promptText: promptText != null ? String(promptText) : undefined };
        } catch (e) {
          lastErr = e;
          if (String(e.message).includes('No dialog is showing')) {
            await new Promise(r => setTimeout(r, 200 + i * 150));
            continue;
          }
          throw e;
        }
      }
      // 5 次重试后仍无弹窗: 语义化为已处理(可能是自动应答兜底或弹窗已关闭), 非致命
      return { success: false, reason: 'already-handled', error: lastErr.message };
    } catch (e) {
      return { error: e.message, hint: '没有正在显示的弹窗?' };
    }
  }

  /** 弹窗记录(含 handled 状态) */
  async getDialogs(tabId) {
    const logs = this.dialogLogs.get(tabId) || [];
    return logs.slice(-10);
  }

  // ============ 模拟(环境) ============

  /** 自动暗色模式(无 dark 媒体查询时的全局暗色渲染) */
  async autoDarkMode(tabId, data) {
    const { enabled } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    await this.cdp.send(tabId, 'Emulation.setAutoDarkModeOverride', enabled === undefined ? {} : { enabled: !!enabled });
    return { success: true, enabled: !!enabled };
  }

  /** 禁用/恢复页面脚本执行 */
  async setScriptDisabled(tabId, data) {
    const { disabled = true } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    await this.cdp.send(tabId, 'Emulation.setScriptExecutionDisabled', { value: !!disabled });
    return { success: true, disabled: !!disabled };
  }

  /** 模拟硬件并发数(navigator.hardwareConcurrency); count 为空或 <=0 时恢复为实际值 */
  async setHardwareConcurrency(tabId, data) {
    const { count } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    if (count == null || count <= 0) {
      const real = navigator.hardwareConcurrency || 4;
      await this.cdp.send(tabId, 'Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: real });
      return { success: true, count: real, restored: true };
    }
    await this.cdp.send(tabId, 'Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: count });
    return { success: true, count };
  }

  async querySelector(tabId, data) {
    const { selector } = data;
    if (!selector) return { error: 'selector is required' };
    return this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        found: true,
        tag: el.tagName, id: el.id, className: el.className,
        text: (el.textContent || '').slice(0, 500),
        innerText: (el.innerText || '').slice(0, 500),
        html: el.outerHTML.slice(0, 3000),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        styles: {
          color: style.color, backgroundColor: style.backgroundColor,
          fontSize: style.fontSize, fontFamily: style.fontFamily,
          display: style.display, position: style.position, zIndex: style.zIndex
        },
        attributes: Array.from(el.attributes).map(a => ({ name: a.name, value: a.value }))
      };
    }, [selector]);
  }

  async queryAll(tabId, data) {
    const { selector, limit = 50, fields = ['tag', 'text', 'className'] } = data;
    if (!selector) return { error: 'selector is required' };
    return this.runInPage(tabId, (sel, lim, fds) => {
      const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
      return els.map(el => {
        const rect = el.getBoundingClientRect();
        const out = {};
        if (fds.includes('tag')) out.tag = el.tagName;
        if (fds.includes('text')) out.text = (el.textContent || '').slice(0, 100);
        if (fds.includes('className')) out.className = el.className;
        if (fds.includes('href')) out.href = el.href;
        if (fds.includes('src')) out.src = el.src;
        if (fds.includes('value')) out.value = el.value;
        if (fds.includes('id')) out.id = el.id;
        if (fds.includes('rect')) out.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        return out;
      });
    }, [selector, limit, fields]);
  }

  /** 一次执行查询多个选择器, 返回 {selector: info} 映射 */
  async queryMany(tabId, data) {
    const { selectors = [] } = data;
    if (!Array.isArray(selectors) || selectors.length === 0) return { error: 'selectors is required' };
    return this.runInPage(tabId, (sels) => {
      const out = {};
      sels.forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        out[sel] = {
          found: true,
          tag: el.tagName,
          text: (el.innerText || el.textContent || '').trim().slice(0, 200),
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      });
      return out;
    }, [selectors]);
  }

  async elementExists(tabId, selector) {
    return this.runInPage(tabId, (sel) => !!document.querySelector(sel), [selector]);
  }

  async getText(tabId, selector) {
    return this.runInPage(tabId, (sel) => {
      const el = sel ? document.querySelector(sel) : document.body;
      return el ? (el.innerText || el.textContent || '').trim() : null;
    }, [selector || null]);
  }

  async getAttr(tabId, selector, name) {
    return this.runInPage(tabId, (sel, n) => document.querySelector(sel)?.getAttribute(n) ?? null, [selector, name]);
  }

  async getValue(tabId, selector) {
    return this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      if (el.tagName === 'SELECT') return { value: el.value, options: Array.from(el.options).map(o => ({ value: o.value, text: o.textContent })) };
      return { value: el.value, checked: el.checked };
    }, [selector]);
  }

  // ============ 元素操作(CDP 真实鼠标) ============

  /** 每 tab 注入一次主 world 鼠标投递计数器(mousemove) */
  async ensureMouseMonitor(tabId) {
    if (this._mouseMonitors?.has(tabId)) return;
    this._mouseMonitors = this._mouseMonitors || new Set();
    try {
      await this.runInPage(tabId, () => {
        if (window.__arkMouseVer !== undefined) return;
        window.__arkMouseVer = 0;
        window.addEventListener('mousemove', () => { window.__arkMouseVer++; }, { passive: true });
      });
      this._mouseMonitors.add(tabId);
    } catch { /* 忽略 */ }
  }

  /** CDP Input 投递探针: 发送单个 mouseMoved, 验证是否真实到达页面(授权过期/失焦时被静默丢弃或挂起) */
  async probeInputDelivery(tabId, x, y) {
    // v8: 4s 缓存, 连续点击省 2×evaluate + 1×dispatch (~30ms)
    try {
      this._probeCache = this._probeCache || new Map();
      const cached = this._probeCache.get(tabId);
      if (cached && Date.now() - cached.ts < 4000) return cached.ok;
      await this.ensureMouseMonitor(tabId);
      const before = (await this.cdp.evaluate(tabId, 'window.__arkMouseVer || 0')).result || 0;
      const dispatched = await Promise.race([
        this.cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), pointerType: 'mouse' }),
        new Promise(r => setTimeout(() => r('timeout'), 3000))
      ]);
      if (dispatched === 'timeout') {
        this._probeCache.set(tabId, { ok: false, ts: Date.now() });
        return false;
      }
      const after = (await this.cdp.evaluate(tabId, 'window.__arkMouseVer || 0')).result || 0;
      const ok = after > before;
      this._probeCache.set(tabId, { ok, ts: Date.now() });
      // 定期清理
      if (this._probeCache.size > 100) {
        const oldest = [...this._probeCache.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0];
        this._probeCache.delete(oldest[0]);
      }
      return ok;
    } catch { return false; }
  }

  async clickElement(tabId, data) {
    const { selector, fast, speed, steps: sSteps } = data || {};
    const fastSteps = fast || speed === 'fast' ? 4 : (Number(sSteps) || 8);
    if (!selector) return { error: 'selector is required' };
    await this.ensureViewport(tabId);
    // 手动模式弹窗挂起检查: 渲染线程被模态弹窗阻塞, evaluate/鼠标事件会超时; 直接返回可操作错误
    const pending = this.getPendingDialog(tabId);
    if (pending) {
      return {
        success: false,
        dialogPending: true,
        error: `弹窗挂起(手动模式): ${pending.type} "${(pending.message || '').slice(0, 60)}" — 请先 POST /dialog {accept, promptText} 应答`,
        hint: 'POST /dialog {auto:true} 可恢复自动应答'
      };
    }
    // CDP:真实点击(滚动 + 坐标 + 鼠标事件); 授权限速/窗口未聚焦/投递探针失败时自动降级 script
    if (tabId != null && !this.cdp.throttled && await this.hasPageFocus(tabId) && await this.cdp.tryAttach(tabId)) {
      try {
        const rect = await this.cdp.elementRect(tabId, selector);
        if (!rect) return { success: false, error: 'Element not found' };
        if (await this.probeInputDelivery(tabId, rect.cx, rect.cy)) {
          await this.mouseFlow(tabId, rect.cx, rect.cy, 'click', fastSteps);
          return { success: true, method: 'cdp', tag: rect.tag, text: rect.text, point: [Math.round(rect.cx), Math.round(rect.cy)] };
        }
        console.log('[ArkWeb] Input 投递探针失败(授权过期/失焦), 点击降级为脚本: ' + selector);
      } catch { /* fallback */ }
    }
    const r = await this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { tag: el.tagName, text: (el.textContent || '').slice(0, 50) };
    }, [selector]);
    if (!r) return { success: false, error: 'Element not found' };
    return { success: true, method: 'script', ...r };
  }

  /** 最近未应答弹窗(手动模式挂起判定): 最近 60 秒内 handled 为 pending 的记录
   *  (60s 与手动模式自动回退时限对齐; 旧值 10s 会导致挂起弹窗稍存续后新命令撞 12s 裸超时而非 dialogPending 提示) */
  getPendingDialog(tabId) {
    const logs = this.dialogLogs.get(tabId) || [];
    const recent = [...logs].reverse().find(l => l.handled === 'pending' && Date.now() - l.timestamp < 60000);
    return recent || null;
  }

  /** 看门狗: 命令疑似被模态弹窗阻塞时, 按策略处理并等待【原命令】恢复(绝不重发, 防 mousePressed/Released 双发)。
   *  自动模式(autoAccept): 幂等应答弹窗, 解除阻塞;
   *  手动模式(manual): 不自动应答, 等待用户 POST /dialog 应答(期间原命令自然恢复), 超时返回 dialogPending 提示。 */
  async guardedCommand(tabId, sendFn, timeout = 8000, grace = 3000) {
    const orig = sendFn();
    const blocked = () => new Promise((_, rej) => setTimeout(() => rej(new Error('CMD_BLOCKED')), timeout));
    try {
      return await Promise.race([orig, blocked()]);
    } catch (e) {
      if (!String(e.message).includes('CMD_BLOCKED')) throw e;
      const policy = this.getDialogPolicy(tabId);
      if (policy.autoAccept) {
        // 自动模式: 幂等应答(无弹窗即 -32602 视为已处理), 原命令在 dialog 关闭后自然恢复(ferrum #430)
        await this.probeAndCloseDialog(tabId);
        try {
          return await Promise.race([orig, new Promise((_, rej) => setTimeout(() => rej(new Error('CMD_DEADLOCK')), grace))]);
        } catch (e2) {
          // 恢复链 C 级: stopLoading 打断挂起的导航/加载; 仍无响应则 reload 重置渲染状态
          // (仅罕见死锁路径触发, 不重发原命令防 mousePressed/Released 双发)
          console.log(`[ArkWeb] guardedCommand 死锁, 执行恢复链 tab=${tabId}`);
          try { await this.cdp.send(tabId, 'Page.stopLoading', {}).catch(() => {}); } catch { /* ignore */ }
          try {
            return await Promise.race([orig, new Promise((_, rej) => setTimeout(() => rej(new Error('CMD_DEADLOCK_AFTER_STOP')), 2500))]);
          } catch (e3) {
            try { await this.cdp.send(tabId, 'Page.reload', { ignoreCache: false }).catch(() => {}); } catch { /* ignore */ }
            // 等待原命令 settle(上下文重置后通常会报错返回), 避免悬空 promise
            await Promise.race([orig, new Promise(r => setTimeout(r, 3000))]).catch(() => {});
            return { success: false, error: `命令死锁, 已执行恢复链(stopLoading→reload), 页面已刷新`, recovered: true, detail: String(e3.message) };
          }
        }
      }
      // 手动模式: 不自动应答。等待用户 POST /dialog 应答(20s 窗口), 原命令在弹窗关闭后自然恢复
      const manualWait = new Promise((_, rej) => setTimeout(() => rej(new Error('CMD_DIALOG_PENDING')), 20000));
      try {
        return await Promise.race([orig, manualWait]);
      } catch (e3) {
        if (!String(e3.message).includes('CMD_DIALOG_PENDING')) throw e3;
        // 弹窗仍挂起: 返回可操作的错误(调用方应 POST /dialog {accept, promptText}); 原命令后台 settle 防悬空
        orig.catch(() => {});
        return {
          success: false,
          error: '弹窗挂起(手动模式): 请先 POST /dialog {accept, promptText} 应答, 再重试该命令',
          dialogPending: true,
          hint: 'POST /dialog {auto:true} 可恢复自动应答'
        };
      }
    }
  }

  async hoverElement(tabId, data) {
    const { selector, fast, speed, steps: sSteps } = data || {};
    const fastSteps = fast || speed === 'fast' ? 4 : (Number(sSteps) || 8);
    const gP = this.getPendingDialog(tabId);
    if (gP) return { success: false, dialogPending: true, error: `弹窗挂起(手动模式): ${gP.type} — 请先 POST /dialog {accept, promptText} 应答`, hint: 'POST /dialog {auto:true} 可恢复自动应答' };
    if (tabId != null && !this.cdp.throttled && await this.hasPageFocus(tabId) && await this.cdp.tryAttach(tabId)) {
      try {
        const rect = await this.cdp.elementRect(tabId, selector);
        if (!rect) return { success: false, error: 'Element not found' };
        if (await this.probeInputDelivery(tabId, rect.cx, rect.cy)) {
          await this.mouseFlow(tabId, rect.cx, rect.cy, 'hover', fastSteps);
          return { success: true, method: 'cdp', point: [Math.round(rect.cx), Math.round(rect.cy)] };
        }
      } catch { /* fallback */ }
    }
    await this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    }, [selector]);
    return { success: true, method: 'script' };
  }

  async doubleClick(tabId, data) {
    const { selector, fast, speed, steps: sSteps } = data || {};
    const fastSteps = fast || speed === 'fast' ? 4 : (Number(sSteps) || 8);
    const gP = this.getPendingDialog(tabId);
    if (gP) return { success: false, dialogPending: true, error: `弹窗挂起(手动模式): ${gP.type} — 请先 POST /dialog {accept, promptText} 应答`, hint: 'POST /dialog {auto:true} 可恢复自动应答' };
    if (tabId != null && !this.cdp.throttled && await this.hasPageFocus(tabId) && await this.cdp.tryAttach(tabId)) {
      try {
        const rect = await this.cdp.elementRect(tabId, selector);
        if (!rect) return { success: false, error: 'Element not found' };
        if (await this.probeInputDelivery(tabId, rect.cx, rect.cy)) {
          await this.mouseFlow(tabId, rect.cx, rect.cy, 'dblclick', fastSteps);
          return { success: true, method: 'cdp' };
        }
      } catch { /* fallback */ }
    }
    await this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }, [selector]);
    return { success: true, method: 'script' };
  }

  async rightClick(tabId, data) {
    const { selector, fast, speed, steps: sSteps } = data || {};
    const fastSteps = fast || speed === 'fast' ? 4 : (Number(sSteps) || 8);
    const gP = this.getPendingDialog(tabId);
    if (gP) return { success: false, dialogPending: true, error: `弹窗挂起(手动模式): ${gP.type} — 请先 POST /dialog {accept, promptText} 应答`, hint: 'POST /dialog {auto:true} 可恢复自动应答' };
    if (tabId != null && !this.cdp.throttled && await this.hasPageFocus(tabId) && await this.cdp.tryAttach(tabId)) {
      try {
        const rect = await this.cdp.elementRect(tabId, selector);
        if (!rect) return { success: false, error: 'Element not found' };
        if (await this.probeInputDelivery(tabId, rect.cx, rect.cy)) {
          await this.mouseFlow(tabId, rect.cx, rect.cy, 'right', fastSteps);
          return { success: true, method: 'cdp' };
        }
      } catch { /* fallback */ }
    }
    await this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    }, [selector]);
    return { success: true, method: 'script' };
  }

  async dragElement(tabId, data) {
    const { selector, targetSelector, dx = 0, dy = 0, steps = 12, forceScript = false, fast, speed } = data;
    const effSteps = fast || speed === 'fast' ? Math.min(steps, 6) : steps;
    const gP = this.getPendingDialog(tabId);
    if (gP) return { success: false, dialogPending: true, error: `弹窗挂起(手动模式): ${gP.type} — 请先 POST /dialog {accept, promptText} 应答`, hint: 'POST /dialog {auto:true} 可恢复自动应答' };
    if (!forceScript && tabId != null && !this.cdp.throttled && await this.hasPageFocus(tabId) && await this.cdp.tryAttach(tabId)) {
      try {
        const src = await this.cdp.elementRect(tabId, selector);
        if (!src) return { success: false, error: 'Source not found' };
        let tx = src.cx, ty = src.cy;
        if (targetSelector) {
          const tgt = await this.cdp.elementRect(tabId, targetSelector);
          if (!tgt) return { success: false, error: 'Target not found' };
          tx = tgt.cx; ty = tgt.cy;
        } else { tx += dx; ty += dy; }
        if (!await this.probeInputDelivery(tabId, src.cx, src.cy)) {
          console.log('[ArkWeb] Input 投递探针失败, 拖拽降级为脚本: ' + selector);
        } else {
          const dSteps = effSteps;
          await this.mouseFlow(tabId, src.cx, src.cy, 'down', fast ? 2 : 4);
          await this.mouseFlow(tabId, tx, ty, 'move', dSteps);
          await this.mouseFlow(tabId, tx, ty, 'up', fast ? 2 : 4);
          return { success: true, method: 'cdp', from: [Math.round(src.cx), Math.round(src.cy)], to: [Math.round(tx), Math.round(ty)] };
        }
      } catch { /* fallback */ }
    }
    return this.runInPage(tabId, (sel, tgtSel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return { error: 'not found' };
        const tgt = tgtSel ? document.querySelector(tgtSel) : null;
        const target = tgt || el;
        const dataTransfer = new DataTransfer();
        el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
        el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
        return { success: true, method: 'script' };
      } catch (e) {
        return { error: `drag script failed: ${e.message}` };
      }
    }, [selector, targetSelector || null]);
  }

  /** 带轨迹的鼠标流(CDP Input.dispatchMouseEvent — trusted 事件) */
  async mouseFlow(tabId, tx, ty, action, steps = 8) {
    // 模拟聚焦 + 派发前确保会话可用(后台标签/失焦窗口下 Input 会被丢弃或挂起)
    await this.ensureInputReady(tabId);
    const opts = { x: Math.round(tx), y: Math.round(ty), button: 'left', pointerType: 'mouse' };
    const start = this._lastMouse || { x: Math.round(tx * 0.5), y: Math.round(ty * 0.5) };
    // Input 命令可能被模态弹窗阻塞(等 compositor 出帧): 统一看门狗, 弹窗应答后原命令自然恢复
    const send = (m, p) => this.guardedCommand(tabId, () => this.cdp.send(tabId, m, p), 8000, 4000);

    if (action === 'move' || action === 'click' || action === 'down' || action === 'dblclick' || action === 'right' || action === 'hover') {
      // 贝塞尔轨迹(少量步数, 快而自然)
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp1x = start.x + (tx - start.x) * 0.35 + (Math.random() - 0.5) * 8;
        const cp1y = start.y + (ty - start.y) * 0.15 + (Math.random() - 0.5) * 6;
        const cp2x = start.x + (tx - start.x) * 0.75 + (Math.random() - 0.5) * 6;
        const cp2y = start.y + (ty - start.y) * 0.85 + (Math.random() - 0.5) * 4;
        const x = Math.round(Math.pow(1 - t, 3) * start.x + 3 * Math.pow(1 - t, 2) * t * cp1x + 3 * (1 - t) * t * t * cp2x + t * t * t * tx);
        const y = Math.round(Math.pow(1 - t, 3) * start.y + 3 * Math.pow(1 - t, 2) * t * cp1y + 3 * (1 - t) * t * t * cp2y + t * t * t * ty);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
        // v8: fast 模式(steps<=4) 轨迹稀疏+更短停顿, 节省 ~25ms
        await new Promise(r => setTimeout(r, steps <= 4 ? 1 + Math.random() * 1.5 : 2 + Math.random() * 4));
      }
      this._lastMouse = opts;
    }

    if (action === 'hover') return;

    if (action === 'click' || action === 'down') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...opts, clickCount: 1 });
      if (action === 'click') {
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...opts, clickCount: 1 });
      }
      return;
    }
    if (action === 'dblclick') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...opts, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...opts, clickCount: 1 });
      await new Promise(r => setTimeout(r, 40));
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...opts, clickCount: 2 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...opts, clickCount: 2 });
      return;
    }
    if (action === 'right') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...opts, button: 'right', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...opts, button: 'right', clickCount: 1 });
      return;
    }
    if (action === 'up') {
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...opts, clickCount: 1 });
      return;
    }
  }

  /** 原始鼠标事件(坐标直接指定) */
  async mouseEvent(tabId, data) {
    const { type = 'click', x, y, button = 'left', steps = 8, fast, speed } = data;
    const effSteps = fast || speed === 'fast' ? 4 : Number(steps) || 8;
    if (x == null || y == null) return { error: 'x/y are required' };
    if (tabId == null) return { error: 'No active tab' };
    // 授权限速/窗口未聚焦/投递探针失败时: 降级为脚本合成事件(elementFromPoint 命中)
    if (this.cdp.throttled || !await this.hasPageFocus(tabId) || !await this.cdp.tryAttach(tabId)) {
      return this.runInPage(tabId, (xx, yy, tt, dx, dy) => {
        const el = document.elementFromPoint(xx, yy);
        if (!el) return { success: false, error: 'no element at point' };
        if (tt === 'move' || tt === 'hover') {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          return { success: true, method: 'script-move' };
        }
        if (tt === 'click') {
          el.click();
          return { success: true, method: 'script-click' };
        }
        if (tt === 'down') {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          return { success: true, method: 'script-down' };
        }
        if (tt === 'up') {
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return { success: true, method: 'script-up' };
        }
        if (tt === 'wheel') {
          // 脚本兜底的滚轮: 对命中元素的可滚动祖先或 window 滚动(throttled 下 CDP Input 不可靠)
          let n = el;
          while (n && n !== document.documentElement) {
            if (n.scrollHeight > n.clientHeight + 1) { n.scrollTop += dy; n.scrollLeft += dx; return { success: true, method: 'script-wheel' }; }
            n = n.parentElement;
          }
          window.scrollBy(dx, dy);
          return { success: true, method: 'script-wheel-window' };
        }
        return { success: false, error: `unsupported mouse type: ${tt}` };
      }, [x, y, type, data?.deltaX || 0, data?.deltaY || 0]);
    }
    if (type === 'move' || type === 'hover') {
      if (!await this.probeInputDelivery(tabId, x, y)) return this.runInPage(tabId, (xx, yy) => {
        const el = document.elementFromPoint(xx, yy);
        if (!el) return { success: false, error: 'no element at point' };
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { success: true, method: 'script-move' };
      }, [x, y]);
      await this.mouseFlow(tabId, x, y, 'hover', effSteps);
      return { success: true, method: 'cdp' };
    }
    if (type === 'click') {
      if (!await this.probeInputDelivery(tabId, x, y)) return this.runInPage(tabId, (xx, yy) => {
        const el = document.elementFromPoint(xx, yy);
        if (!el) return { success: false, error: 'no element at point' };
        el.click();
        return { success: true, method: 'script-click' };
      }, [x, y]);
      await this.mouseFlow(tabId, x, y, 'click', effSteps);
      return { success: true, method: 'cdp' };
    }
    if (type === 'down') {
      await this.mouseFlow(tabId, x, y, 'down', effSteps);
      return { success: true, method: 'cdp' };
    }
    if (type === 'up') {
      await this.cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, pointerType: 'mouse' });
      return { success: true, method: 'cdp' };
    }
    if (type === 'wheel') {
      const { deltaX = 0, deltaY = 0 } = data;
      await this.cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
      return { success: true, method: 'cdp' };
    }
    return { error: `Unknown mouse type: ${type}` };
  }

  async scrollPage(tabId, data) {
    const { x = 0, y = 0, behavior = 'smooth' } = data;
    await this.runInPage(tabId, (sx, sy, bh) => window.scrollTo({ left: sx, top: sy, behavior: bh }), [x, y, behavior]);
    return { success: true, position: { x, y } };
  }

  async scrollIntoView(tabId, selector, data = {}) {
    const r = await this.runInPage(tabId, (sel, block, behavior) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.scrollIntoView({ block: block || 'center', behavior: behavior || 'smooth' });
      return true;
    }, [selector, data.block, data.behavior]);
    return { success: !!r };
  }

  async scrollBy(tabId, data) {
    const { x = 0, y = 0 } = data;
    await this.runInPage(tabId, (sx, sy) => window.scrollBy(sx, sy), [x, y]);
    return { success: true };
  }

  // ============ 键盘 / 输入(CDP trusted) ============

  async simulateKey(tabId, data) {
    const { key, modifiers = [], text } = data;
    const gP = this.getPendingDialog(tabId);
    if (gP) return { success: false, dialogPending: true, error: `弹窗挂起(手动模式): ${gP.type} — 请先 POST /dialog {accept, promptText} 应答`, hint: 'POST /dialog {auto:true} 可恢复自动应答' };
    // 有页面级默认行为的键固定走脚本路径(脚本实现等价默认行为, 不依赖 CDP 投递/焦点状态):
    // Enter 提交表单; End/Home/PageUp/PageDown/方向键滚动; Tab 聚焦; Backspace/Delete 删字符
    const SCRIPT_ONLY_KEYS = ['Enter', 'End', 'Home', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace', 'Delete'];
    if (SCRIPT_ONLY_KEYS.includes(key)) {
      return this.keyScriptFallback(tabId, key, modifiers);
    }
    const modMap = { ctrl: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta' };
    const mods = (modifiers.includes('ctrl') ? 2 : 0) | (modifiers.includes('alt') ? 1 : 0) | (modifiers.includes('shift') ? 8 : 0) | (modifiers.includes('meta') ? 4 : 0);
    // 虚拟键码映射: 保证 Enter 提交表单 / Home/End 滚动 / 方向键等默认行为生效
    const VK = {
      Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
      Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
      ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
      F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
      F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
    };
    const vk = VK[key];
    const focused = await this.hasPageFocus(tabId);
    // 窗口未聚焦时 Chrome 会挂起/丢弃 Input 事件: 直接走脚本降级(含默认行为实现)
    // throttled(授权窗口过期)时 CDP 键盘约 5s/键, 直接走脚本降级避免慢路径与卡键
    if (!focused || this.cdp.throttled || !await this.cdp.tryAttach(tabId)) {
      return this.keyScriptFallback(tabId, key, modifiers);
    }
    try {
      // 注入一次性键盘投递计数器(主 world), 用于验证事件真实到达
      await this.ensureKeyMonitor(tabId);
      await this.ensureInputReady(tabId);
      const before = (await this.cdp.evaluate(tabId, 'window.__arkKeyVer || 0')).result || 0;
      try {
        for (const m of ['ctrl', 'alt', 'shift', 'meta']) {
          if (modifiers.includes(m)) {
            await this.cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: modMap[m], code: modMap[m], modifiers: 0, windowsVirtualKeyCode: m === 'ctrl' ? 17 : m === 'alt' ? 18 : m === 'shift' ? 16 : 91 });
          }
        }
        const keyEvent = {
          type: 'keyDown', key, code: key,
          text: key === 'Enter' ? '\r' : (text || undefined),
          modifiers: mods,
          ...(vk != null ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {})
        };
        await this.cdp.send(tabId, 'Input.dispatchKeyEvent', keyEvent);
        // Chromium 的表单提交/默认行为由 char 事件触发(如 Enter 提交表单)
        if (key === 'Enter') {
          await this.cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'char', key: 'Enter', text: '\r', unmodifiedText: '\r', modifiers: mods, windowsVirtualKeyCode: 13 });
        }
        await this.cdp.send(tabId, 'Input.dispatchKeyEvent', { ...keyEvent, type: 'keyUp' });
      } finally {
        // 严格配对: 即使中途失败也释放所有修饰键, 避免卡键(参考 chrome-devtools-mcp #2309/#2353)
        for (const m of ['ctrl', 'alt', 'shift', 'meta']) {
          if (modifiers.includes(m)) {
            await this.cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: modMap[m], code: modMap[m], modifiers: 0, windowsVirtualKeyCode: m === 'ctrl' ? 17 : m === 'alt' ? 18 : m === 'shift' ? 16 : 91 }).catch(() => {});
          }
        }
      }
      // 验证投递: 授权窗口过期等情况下 Chrome 会静默丢弃 Input 事件(命令仍返回成功)
      const after = (await this.cdp.evaluate(tabId, 'window.__arkKeyVer || 0')).result || 0;
      if (after > before) {
        return { success: true, method: 'cdp', key, modifiers };
      }
      console.log(`[ArkWeb] Input 事件被丢弃(窗口未聚焦或授权过期), 降级为脚本键: ${key}`);
      return this.keyScriptFallback(tabId, key, modifiers);
    } catch { /* fallback */ }
    return this.keyScriptFallback(tabId, key, modifiers);
  }

  /** 派发 Input 事件前确保页面处于"模拟聚焦"状态(后台标签/失焦窗口下 Input 会被丢弃) */
  async ensureInputReady(tabId) {
    try {
      await this.cdp.send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch { /* 忽略 */ }
  }

  /** 页面是否聚焦(Chrome 只向聚焦窗口派发 Input 事件) */
  async hasPageFocus(tabId) {
    if (tabId == null) return false;
    try {
      const r = await this.cdp.evaluate(tabId, 'document.hasFocus()', 3000);
      return r?.success === true && r.result === true;
    } catch { return false; }
  }

  /** 每 tab 注入一次主 world 键盘投递计数器 */
  async ensureKeyMonitor(tabId) {
    if (this._keyMonitors?.has(tabId)) return;
    this._keyMonitors = this._keyMonitors || new Set();
    try {
      await this.runInPage(tabId, () => {
        if (window.__arkKeyVer !== undefined) return;
        window.__arkKeyVer = 0;
        window.addEventListener('keydown', () => { window.__arkKeyVer++; });
      });
      this._keyMonitors.add(tabId);
    } catch { /* 忽略 */ }
  }

  /** 脚本降级按键: 合成事件 + 实现常见默认行为(Enter 提交表单 / End/Home/方向/翻页滚动) */
  async keyScriptFallback(tabId, key, modifiers) {
    if (tabId == null) return { error: 'No active tab' };
    const r = await this.runInPage(tabId, (k, mods) => {
      const codeMap = { F12: 123, F5: 116, F1: 112, F2: 113, F3: 114, F4: 115, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, Enter: 13, Escape: 27, Backspace: 8, Delete: 46, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
      const el = document.activeElement || document.body;
      const opts = { key: k, code: k, keyCode: codeMap[k] || 0, which: codeMap[k] || 0, bubbles: true, cancelable: true };
      if (mods.includes('ctrl')) opts.ctrlKey = true;
      if (mods.includes('shift')) opts.shiftKey = true;
      if (mods.includes('alt')) opts.altKey = true;
      if (mods.includes('meta')) opts.metaKey = true;
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      const done = { key: k, method: 'script' };
      // 实现默认行为(合成事件不会自动触发)
      if (k === 'Enter') {
        const form = el.form || el.closest?.('form');
        if (form) {
          form.requestSubmit ? form.requestSubmit() : form.submit();
          done.default = 'form-submit';
        } else {
          const btn = document.querySelector('button[type="submit"], input[type="submit"]');
          if (btn) { btn.click(); done.default = 'submit-click'; }
        }
      } else if (k === 'End' || k === 'Home' || k === 'PageUp' || k === 'PageDown' || k === 'ArrowUp' || k === 'ArrowDown') {
        const sc = document.scrollingElement || document.documentElement;
        const step = k === 'PageUp' || k === 'PageDown' ? innerHeight * 0.9 : k === 'ArrowUp' || k === 'ArrowDown' ? 120 : 0;
        if (k === 'Home' || k === 'ArrowUp' || k === 'PageUp') sc.scrollTop = k === 'Home' ? 0 : sc.scrollTop - step;
        else if (k === 'End') sc.scrollTop = sc.scrollHeight;
        else sc.scrollTop = sc.scrollTop + step;
        done.default = 'scroll';
      } else if (k === 'Tab') {
        const focusables = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'))
          .filter(e => !e.disabled && e.offsetParent !== null);
        const idx = focusables.indexOf(el);
        const next = mods.includes('shift') ? focusables[idx - 1] : focusables[idx + 1];
        if (next) { next.focus(); done.default = 'tab-focus'; }
      } else if (k === 'Backspace' || k === 'Delete') {
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          const sel = el.selectionStart ?? el.value.length;
          if (k === 'Backspace' && sel > 0) el.value = el.value.slice(0, sel - 1) + el.value.slice(el.selectionEnd ?? sel);
          else if (k === 'Delete') el.value = el.value.slice(0, sel) + el.value.slice((el.selectionEnd ?? sel) + 1);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          done.default = 'delete-char';
        }
      }
      return done;
    }, [key, modifiers]);
    return { success: true, method: 'script', key, modifiers, default: r?.default || null };
  }

  /** 输入文本: fast=Insert.text 一次插入, human=逐字符 */
  async typeText(tabId, data) {
    const { selector, text, mode = 'fast' } = data;
    if (text == null) return { error: 'text is required' };
    const gP = this.getPendingDialog(tabId);
    if (gP) return { success: false, dialogPending: true, error: `弹窗挂起(手动模式): ${gP.type} — 请先 POST /dialog {accept, promptText} 应答`, hint: 'POST /dialog {auto:true} 可恢复自动应答' };
    if (selector) {
      if (tabId == null) return { error: 'No active tab' };
      const ok = await this.runInPage(tabId, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.focus();
        el.scrollIntoView({ block: 'center' });
        return true;
      }, [selector]);
      if (!ok) return { error: `Element not found: ${selector}` };
      await new Promise(r => setTimeout(r, 60));
    }
    // throttled(授权窗口过期)时 CDP 输入约 5s/键, 直接走脚本输入避免慢路径
    if (tabId != null && !this.cdp.throttled && await this.cdp.tryAttach(tabId)) {
      try {
        if (mode === 'human') {
          for (const ch of String(text)) {
            await this.cdp.sendWithTimeout(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch }, 5000);
            await new Promise(r => setTimeout(r, 25 + Math.random() * 30));
          }
        } else {
          await this.cdp.sendWithTimeout(tabId, 'Input.insertText', { text: String(text) }, 5000);
        }
        // 回读校验: 部分内核(如夸克 Chromium 144)对 insertText 的非 ASCII 文本处理异常(中文变 '?' 或静默不写入)
        // 检测到损坏/未写入(值不变或为空)时自动降级为脚本设置(与 /fill 同路径, React 兼容)
        if (selector) {
          const readVal = async () => {
            const c = await this.cdp.evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.value : null; })()`).catch(() => null);
            return c?.result;
          };
          const oldVal = await readVal();
          const got = await readVal();
          const want = String(text);
          if (typeof got === 'string' && got !== want && (got.includes('?') || got === '' || got === oldVal)) {
            await this.runInPage(tabId, (sel, val) => {
              const el = document.querySelector(sel);
              if (!el) return false;
              el.focus();
              el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }, [selector, want]);
            return { success: true, method: 'script-fallback', mode, chars: want.length, reason: 'insertText 中文损坏或未写入, 已降级脚本输入' };
          }
        }
        return { success: true, method: 'cdp', mode, chars: String(text).length };
      } catch { /* fallback */ }
    }
    if (tabId == null) return { error: 'No active tab' };
    // 脚本降级: 优先写入 selector 目标(而非 document.activeElement —— 焦点不在输入框时
    // 旧实现会把文本静默写到 body 上, value 校验永远为空)
    await this.runInPage(tabId, (sel, txt) => {
      const el = sel ? document.querySelector(sel) : document.activeElement;
      if (!el) return false;
      el.focus();
      el.scrollIntoView({ block: 'center' });
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, el.value + txt);
      else el.value += txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, [selector || null, text]);
    return { success: true, method: 'script' };
  }

  /** 表单填充(React 受控组件兼容) */
  async fillForm(tabId, data) {
    const { fields } = data;
    if (!Array.isArray(fields) || fields.length === 0) return { error: 'fields is required' };
    if (tabId == null) return { error: 'No active tab' };
    const gP = this.getPendingDialog(tabId);
    if (gP) return { success: false, dialogPending: true, error: `弹窗挂起(手动模式): ${gP.type} — 请先 POST /dialog {accept, promptText} 应答`, hint: 'POST /dialog {auto:true} 可恢复自动应答' };
    const r = await this.runInPage(tabId, (flds) => {
      const results = [];
      flds.forEach(({ selector, value }) => {
        const el = document.querySelector(selector);
        if (!el) { results.push({ selector, success: false, error: 'not found' }); return; }
        try {
          const tag = el.tagName.toLowerCase();
          if (tag === 'select') {
            const opt = Array.from(el.options).find(o => o.value === String(value) || o.textContent === String(value));
            if (opt) el.value = opt.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.type === 'checkbox' || el.type === 'radio') {
            const want = value === true || value === 'true' || value === 1 || value === 'on';
            if (el.checked !== want) el.click();
          } else {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
              : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, String(value));
            else el.value = String(value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          results.push({ selector, success: true, tag, type: el.type });
        } catch (e) {
          results.push({ selector, success: false, error: e.message });
        }
      });
      return results;
    }, [fields]);
    return r || [];
  }

  async selectOption(tabId, data) {
    const { selector, value, text } = data;
    return this.runInPage(tabId, (sel, v, txt) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: 'not found' };
      const opt = Array.from(el.options).find(o => (v != null && o.value === String(v)) || (txt != null && o.textContent === String(txt)));
      if (!opt) return { success: false, error: 'option not found' };
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, value: opt.value, text: opt.textContent };
    }, [selector, value ?? null, text ?? null]);
  }

  async checkBox(tabId, data) {
    const { selector, checked = true } = data;
    return this.runInPage(tabId, (sel, want) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: 'not found' };
      if (el.checked !== !!want) el.click();
      return { success: true, checked: el.checked };
    }, [selector, checked]);
  }

  async clearField(tabId, selector) {
    return this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: 'not found' };
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    }, [selector]);
  }

  async focusElement(tabId, selector) {
    return this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: 'not found' };
      el.focus();
      return { success: true };
    }, [selector]);
  }

  // ============ JS 执行 ============

  async evaluateJS(tabId, data) {
    const { code, timeout = 10000 } = data;
    if (!code) return { error: 'code is required' };
    // CDP 优先; 失败自动降级到 executeScript
    if (tabId != null && await this.cdp.tryAttach(tabId)) {
      try {
        const r = await this.cdp.evaluate(tabId, code, timeout);
        if (r.success) return r;
        // 页面 CSP 阻止字符串求值(如百度的 script-src 无 unsafe-eval)时:
        // 自动 Page.setBypassCSP(per-tab) 后重试, 无需调用方感知。绕过对页内 eval 同样生效。
        if (/Content Security Policy|unsafe-eval|Evaluating a string as JavaScript/i.test(r.error || '')) {
          try {
            await this.cdp.send(tabId, 'Page.setBypassCSP', { enabled: true });
            const r2 = await this.cdp.evaluate(tabId, code, timeout);
            if (r2.success) return { ...r2, cspBypassed: true };
          } catch { /* 绕过失败则返回原始错误 */ }
        }
        return r; // 页面级错误(exceptionDetails)如实返回
      } catch (e) {
        // CDP 通道故障 → 降级
      }
    }
    if (tabId == null) return { error: 'No active tab' };
    const r = await this.runInPage(tabId, (c) => {
      try {
        const result = eval(c);
        return { success: true, result: safeSerialize(result) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }, [code]);
    if (r?.success) {
      try { return { success: true, result: JSON.parse(r.result) }; }
      catch { return { success: true, result: r.result }; }
    }
    return { success: false, error: r?.error };
  }

  // ============ 等待 ============

  async waitForSelector(tabId, data) {
    const { selector, timeout = 10000, state = 'visible' } = data;
    const start = Date.now();
    if (tabId == null) return { error: 'No active tab' };
    // v8: 事件驱动 — 页面内 MutationObserver 一次性订阅, 避免 120ms 轮询(最快 10ms 内响应)
    try {
      const r = await this.runInPage(tabId, (sel, st, ms) => new Promise(resolve => {
        const deadline = Date.now() + ms;
        const check = () => {
          const el = document.querySelector(sel);
          if (!el) return st === 'absent' ? true : false;
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const vis = rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
          if (st === 'visible') return vis;
          if (st === 'hidden') return !vis;
          if (st === 'attached') return true;
          if (st === 'absent') return false;
          return vis;
        };
        if (check()) { resolve({ ok: true, waited: 0 }); return; }
        const obs = new MutationObserver(() => { if (check()) { obs.disconnect(); resolve({ ok: true, waited: Date.now() - (deadline - ms) }); } });
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style','class','hidden'] });
        const iv = setInterval(() => { if (check()) { clearInterval(iv); obs.disconnect(); resolve({ ok: true, waited: Date.now() - (deadline - ms) }); } }, 40);
        setTimeout(() => { clearInterval(iv); obs.disconnect(); resolve({ ok: false }); }, ms);
      }), [selector, state, timeout]);
      if (r && r.ok) return { success: true, waited: Date.now() - start };
      return { success: false, error: `timeout waiting for ${selector} (${state})`, waited: Date.now() - start };
    } catch {}
    // 回退轮询(40ms, 原 120ms)
    const fallbackStart = start;
    while (Date.now() - fallbackStart < timeout) {
      try {
        const rr = await this.cdp.evaluate(tabId, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return 'absent';
          const s = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
          return visible ? 'visible' : 'hidden';
        })()`).catch(()=>null);
        const st = rr?.result;
        if (state === 'hidden' && st !== 'visible') return { success: true, waited: Date.now() - start };
        if (state === 'visible' && st === 'visible') return { success: true, waited: Date.now() - start };
        if (state === 'attached' && st !== 'absent') return { success: true, waited: Date.now() - start };
        if (state === 'absent' && st === 'absent') return { success: true, waited: Date.now() - start };
      } catch {}
      await new Promise(r => setTimeout(r, 40));
    }
    return { success: false, error: `timeout waiting for ${selector} (${state})`, waited: Date.now() - start };
  }

  async waitForText(tabId, data) {
    const { selector = 'body', text, timeout = 10000 } = data;
    const start = Date.now();
    if (tabId == null) return { error: 'No active tab' };
    // v8: 页面内 MutationObserver, 40ms 级响应
    try {
      const r = await this.runInPage(tabId, (sel, txt, ms) => new Promise(resolve => {
        const deadline = Date.now() + ms;
        const get = () => {
          const el = document.querySelector(sel);
          if (!el) return '';
          return el.innerText || el.textContent || '';
        };
        if (get().includes(txt)) { resolve(true); return; }
        const obs = new MutationObserver(() => { if (get().includes(txt)) { obs.disconnect(); resolve(true); } });
        const target = document.querySelector(sel) || document.body;
        if (target) obs.observe(target, { childList: true, subtree: true, characterData: true });
        setTimeout(() => { obs.disconnect(); resolve(false); }, ms);
      }), [selector, text, Math.min(timeout, 10000)]);
      if (r) return { success: true, waited: Date.now() - start };
      // 若 observer 超时但总 timeout 更长, 继续轮询剩余时间
      const elapsed = Date.now() - start;
      if (elapsed >= timeout) return { success: false, error: `timeout waiting for text "${text}"`, waited: elapsed };
    } catch {}
    while (Date.now() - start < timeout) {
      const t = await this.getText(tabId, selector).catch(() => null);
      if (t && t.includes(text)) return { success: true, waited: Date.now() - start };
      await new Promise(r => setTimeout(r, 60));
    }
    return { success: false, error: `timeout waiting for text "${text}"`, waited: Date.now() - start };
  }

  async waitForUrl(tabId, data) {
    const { pattern, timeout = 10000 } = data;
    const start = Date.now();
    if (tabId == null) return { error: 'No active tab' };
    // v8: 40ms 轮询(原 150ms), 首检立即
    while (Date.now() - start < timeout) {
      const info = await this.getPageInfo(tabId).catch(() => null);
      const url = info?.url || '';
      if (url.includes(pattern)) return { success: true, url, waited: Date.now() - start };
      await new Promise(r => setTimeout(r, 40));
    }
    return { success: false, error: `timeout waiting for URL ${pattern}`, waited: Date.now() - start };
  }

  /** 等待页面加载完成。
   *  关键点(实测竞态修复): 若刚发生过导航动作(open/navigate, 或调用方显式 afterAction),
   *  则"当前文档已 complete"不能作为完成依据 —— 那往往是【上一个文档】。
   *  此时必须观察到 新文档进入 loading 或 URL 命中目标, 才判定完成。
   *  v2.9.3 新增停滞宽限: 真实站点常引入永久挂起的第三方资源(如国内网络下的 cse.google.com),
   *  导致 load 事件永不触发(readyState 卡在 interactive)。DOM 就绪超时后按部分完成返回。 */
  async waitForLoad(tabId, data = {}) {
    const timeout = data?.timeout || 15000;
    const start = Date.now();
    if (tabId == null) return { error: 'No active tab' };
    const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/$/, '');
    // 导航标记: 由 openUrl/navigateCurrent 登记, 30s 内有效
    const nav = this._pendingNav?.get(tabId);
    const navFresh = nav && Date.now() - nav.ts < 30000;
    const navTarget = navFresh ? nav.url : null;
    if (nav && !navFresh) this._pendingNav.delete(tabId);
    const needTransition = !!navTarget || data.afterAction === true;
    let sawLoading = false;
    // 始终记录基线 URL: 快速导航可能在两次轮询之间就完成了(看不到 loading), 此时靠 URL 变化判定
    const b0 = await this.getPageInfo(tabId).catch(() => null);
    const baselineUrl = b0?.url || null;
    const graceNoNav = data.noNavGrace != null ? +data.noNavGrace : 1500;   // 点击类动作: 超过此时间仍无 URL 变化则视为"无导航", 直接返回(不空等超时)
    const stallGrace = data.stallGrace != null ? +data.stallGrace : 3000;   // DOM 就绪(interactive)后的宽限: 超过仍无 complete 则按部分完成返回
    let interactiveAt = null;
    let lastInfo = null;
    while (Date.now() - start < timeout) {
      const info = await this.getPageInfo(tabId).catch(() => null);
      if (info) {
        lastInfo = info;
        if (info.readyState === 'loading') sawLoading = true;
        const notSystem = info.url && !info.url.startsWith('chrome://') && !info.url.startsWith('about:blank');
        const complete = info.readyState === 'complete' && notSystem;
        const urlHit = navTarget ? norm(info.url) === norm(navTarget) : (baselineUrl ? info.url !== baselineUrl : false);
        if (complete && (!needTransition || sawLoading || urlHit)) {
          if (nav) this._pendingNav.delete(tabId);
          return {
            success: true, url: info.url, title: info.title, waited: Date.now() - start,
            ...(needTransition ? { transition: sawLoading ? 'loading-observed' : 'url-changed' } : {})
          };
        }
        // DOM 就绪但 load 长期未触发(有挂起资源): 超过 stallGrace 按部分完成返回, 不空等整个 timeout
        if (notSystem && info.readyState === 'interactive' && (!needTransition || sawLoading || urlHit)) {
          if (interactiveAt == null) {
            interactiveAt = Date.now();
          } else if (Date.now() - interactiveAt >= stallGrace) {
            if (nav) this._pendingNav.delete(tabId);
            return {
              success: true, partial: true, url: info.url, title: info.title,
              readyState: info.readyState, waited: Date.now() - start,
              note: `DOM 已就绪(interactive)但 load 事件超过 ${stallGrace}ms 未触发; 通常是有第三方资源挂起(被墙/慢请求), 已按可交互状态返回`
            };
          }
        } else {
          interactiveAt = null;
        }
        // 无导航目标的"动作后等待"(如点击按钮但不跳转): 短时间后不再空等
        if (!navTarget && data.afterAction === true && !sawLoading && Date.now() - start > graceNoNav) {
          return {
            success: true, url: info.url, title: info.title, waited: Date.now() - start,
            transition: 'no-navigation', note: `点击后 ${graceNoNav}ms 内未发生导航(可能是 AJAX 交互), 已按已完成返回`
          };
        }
      }
      await new Promise(r => setTimeout(r, 40));
    }
    return {
      success: false,
      error: 'timeout waiting for page load',
      waited: Date.now() - start,
      ...(lastInfo?.readyState === 'interactive' ? {
        partial: true, readyState: 'interactive', url: lastInfo.url,
        note: '页面始终处于 interactive(load 事件被挂起资源阻塞), 可加 stallGrace 参数提前返回'
      } : {}),
      hint: navTarget ? `等待目标 URL: ${navTarget}` : (data.afterAction ? '等待导航发生(未观察到 loading 或 URL 变化)' : undefined)
    };
  }

  // ============ 截图 / PDF ============

  async screenshot(tabId, data) {
    const format = this.normalizeImageFormat(data?.format || 'png');
    const quality = data?.quality || 80;
    const vpState = await this.ensureViewport(tabId);
    const windowInvisible = !!vpState?.applied;   // 窗口不可见: 截图改走 fromSurface:false
    // http 本地页: Page.captureScreenshot 在部分内核(http://127.0.0.1)可能挂起 → captureVisibleTab 快路径。
    // 但 captureVisibleTab 永远截【当前激活 tab】: 仅当目标 tab 就是激活 tab 时才允许走该路径,
    // 否则会把用户当前页面截走(串页+隐私)。后台 tab 一律走 CDP(Page.captureScreenshot 可精确指定 target)。
    let isLocalActive = false;
    try {
      const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
      const u = tab?.url || '';
      const isHttpLocal = u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost');
      isLocalActive = isHttpLocal && tab?.active === true;
    } catch {}
    if (tabId != null && !isLocalActive && await this.cdp.tryAttach(tabId)) {
      // 夸克内核 captureScreenshot 可能 >8s(渲染忙)且间歇性失败(渲染进程退化环境实测抖动明显), 8s 超时 + 重试一次再落守卫
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // 窗口不可见/最小化时, 从合成器(默认 fromSurface:true)取帧会一直等不到新帧 → 超时。
          // 第二轮(以及"已检测到窗口不可见"时)改为 fromSurface:false, 直接从渲染进程取图 —— 实测可稳定出图。
          const fromSurface = !(attempt > 0 || windowInvisible);
          const shot = await this.cdp.sendWithTimeout(tabId, 'Page.captureScreenshot', {
            format, quality, ...(fromSurface ? {} : { fromSurface: false })
          }, 8000);
          if (shot && typeof shot.data === 'string') {
            return { success: true, method: 'cdp', dataUrl: `data:image/${format};base64,${shot.data}`, format, fromSurface, timestamp: Date.now() };
          }
        } catch { /* 重试后仍失败 → 兜底守卫 */ }
        if (attempt === 0) await new Promise(r => setTimeout(r, 400));
      }
    }
    // captureVisibleTab 兜底仅对"目标=当前激活 tab"合法; 目标是后台 tab 时拒绝(防截到用户当前页面)。
    // 必须用实时查询而非 _activeTabId 缓存 —— 缓存可能过期/被污染, 判错就会把用户正在看的页面截走
    let activeId = null;
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeId = t?.id ?? null;
    } catch { /* ignore */ }
    if (tabId != null && activeId != null && tabId !== activeId) {
      return { success: false, method: 'failed', error: `截图失败: 目标 tab(${tabId}) 非当前激活 tab, captureVisibleTab 只能截激活 tab(已拒绝以防串页); 请启用 CDP 调试后重试` };
    }
    // fallback 包超时: captureVisibleTab 依赖窗口可见, 非前台时可能挂起; 失败返回结构化错误而非裸 throw
    try {
      // captureVisibleTab 只接受 jpeg/png(webp 会直接抛参数错误) → 兜底路径降级为 jpeg
      const fbFormat = (format === 'jpeg' || format === 'png') ? format : 'jpeg';
      const dataUrl = await Promise.race([
        chrome.tabs.captureVisibleTab(null, { format: fbFormat, quality }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('captureVisibleTab timeout after 6000ms')), 6000))
      ]);
      return { success: true, method: 'script', dataUrl, format: fbFormat, ...(fbFormat !== format ? { formatNote: `captureVisibleTab 不支持 ${format}, 已降级为 ${fbFormat}` } : {}), timestamp: Date.now() };
    } catch (e) {
      return { success: false, error: `截图失败(CDP 超时且 fallback 不可用, 可能窗口不可见): ${e.message}`, method: 'failed' };
    }
  }

  async screenshotFull(tabId, data) {
    const format = this.normalizeImageFormat(data?.format || 'png');
    const quality = data?.quality || 80;
    await this.ensureViewport(tabId);
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '整页截图需要 CDP(请在 popup 中启用调试)' };
    try {
      // 外层看门狗: 渲染忙/弹窗阻塞时自动恢复, 不悬空到请求层超时
      const base64 = await this.guardedCommand(tabId, () => this.cdp.fullPageShot(tabId, format, quality), 25000, 10000);
      return { success: true, dataUrl: `data:image/${format};base64,${base64}`, format, timestamp: Date.now() };
    } catch (e) {
      return { error: e.message };
    }
  }

  async screenshotElement(tabId, data) {
    const { selector } = data;
    if (!selector) return { error: 'selector is required' };
    await this.ensureViewport(tabId);
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '元素截图需要 CDP(请在 popup 中启用调试)' };
    const rect = await this.cdp.elementRect(tabId, selector);
    if (!rect) return { error: 'Element not found' };
    const doc = await this.cdp.evaluate(tabId, `({sx: scrollX, sy: scrollY})`);
    const sx = doc.result?.sx || 0, sy = doc.result?.sy || 0;
    const clip = {
      x: Math.max(0, rect.x - sx),
      y: Math.max(0, rect.y - sy),
      width: rect.width,
      height: rect.height,
      scale: 1
    };
    try {
      // 夸克退化环境: 元素截图同样可能间歇超时, 重试一次
      let shot = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // 带 clip 必须 fromSurface:true(内核限制), 故两次尝试参数一致, 仅重试
          shot = await this.cdp.sendWithTimeout(tabId, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, 15000);
          if (shot && typeof shot.data === 'string') break;
        } catch (e) {
          if (attempt === 1) return { error: e.message };
          await new Promise(r => setTimeout(r, 400));
        }
      }
      if (!shot || typeof shot.data !== 'string') return { success: false, error: '元素截图未返回数据(已重试)' };
      return { success: true, dataUrl: `data:image/png;base64,${shot.data}`, rect, timestamp: Date.now() };
    } catch (e) {
      return { error: e.message };
    }
  }

  /** 打印为 PDF (CDP Page.printToPDF) */
  async printToPdf(tabId, data) {
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: 'PDF 打印需要 CDP(请在 popup 中启用调试)' };
    const { format = 'A4', landscape = false, printBackground = true, margin } = data;
    try {
      const { data: base64 } = await this.cdp.sendWithTimeout(tabId, 'Page.printToPDF', {
        format, landscape, printBackground,
        ...(margin ? { marginTop: margin.top, marginBottom: margin.bottom, marginLeft: margin.left, marginRight: margin.right } : {})
      }, 8000);
      return { success: true, base64, mime: 'application/pdf', format, timestamp: Date.now() };
    } catch (e) {
      return { error: e.message };
    }
  }

  async highlight(tabId, data) {
    const { selector, color = '#ff0000', label } = data;
    if (!selector) return { error: 'selector is required' };
    if (tabId == null) return { error: 'No active tab' };
    const r = await this.runInPage(tabId, (sel, col, lbl) => {
      document.querySelectorAll('.ark-web-highlight').forEach(el => el.remove());
      const els = document.querySelectorAll(sel);
      let shown = 0;
      els.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const overlay = document.createElement('div');
        overlay.className = 'ark-web-highlight';
        overlay.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:2px solid ${col};background:${col}22;z-index:2147483647;pointer-events:none;`;
        const tag = document.createElement('div');
        tag.style.cssText = `position:absolute;top:-22px;left:0;background:${col};color:white;padding:1px 6px;font-size:11px;font-family:monospace;white-space:nowrap;`;
        tag.textContent = lbl ? `${lbl} #${i + 1}` : `#${i + 1}`;
        overlay.appendChild(tag);
        document.body.appendChild(overlay);
        shown++;
      });
      return { matched: els.length, shown };
    }, [selector, color, label || null]);
    return { success: true, ...r };
  }

  async clearHighlight(tabId) {
    await this.runInPage(tabId, () => document.querySelectorAll('.ark-web-highlight').forEach(el => el.remove()));
    return { success: true };
  }

  // ============ Vision Snapshot (v7-vision 原子级视觉上下文) ============
  /**
   * 原子级视觉快照：截图 + 交互锚点一次返回
   * - annotate=true 时叠加 SoM 编号气泡(1..N)，截图后自动清除，不污染后续
   * - full=false 视口截图(默认)；full=true 整页截图
   * - selector 可限定锚点范围；maxElements 限制数量(默认50, 上限120)
   */
  /** 最小化/不可见窗口的标签页 innerWidth=0 → 布局塌陷(元素尺寸全为 0、截图空白)。
   *  自动施加"虚拟视口"(仅作用于该 tab, 不改动用户可见窗口), 让视觉与坐标操作在窗口最小化时依然可用。
   *  实测夸克最小化时可能上报 45x14 等异常小值而非 0, 故以 <100 判定"不可见"。
   *  探测结果缓存 3s, 避免每条命令都多一次 evaluate。 */
  async ensureViewport(tabId, opts = {}) {
    if (tabId == null) return { applied: false };
    const now = Date.now();
    const cached = this._viewportProbe.get(tabId);
    if (!opts.force && cached && now - cached.ts < 3000) return cached.result;
    const TINY = 100;   // 视口任一维 <100 视为窗口不可见(最小化上报异常小值)
    let result = { applied: false };
    try {
      const probe = await this.evaluateJS(tabId, { code: '({ w: innerWidth, h: innerHeight })', timeout: 4000 });
      const vp = probe.success ? probe.result : null;
      if (vp && (vp.w === 0 || vp.h === 0 || vp.w < TINY || vp.h < TINY || opts.allowResidual)) {
        if (await this.cdp.tryAttach(tabId)) {
          const cfg = { width: opts.width || 1440, height: opts.height || 900, dpr: 1, mobile: false };
          await this.cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', {
            width: cfg.width, height: cfg.height, deviceScaleFactor: cfg.dpr, mobile: false
          });
          // 记入 deviceOverrides, 使 /device/clear 能走正常清理与校验路径
          this.deviceOverrides.set(tabId, { config: cfg, origUA: null, synthetic: true });
          result = { applied: true, viewport: cfg, reason: `窗口不可见(视口 ${vp.w}x${vp.h}), 已自动施加虚拟视口` };
          console.log(`[ArkWeb] ${result.reason} → ${cfg.width}x${cfg.height} (tab ${tabId})`);
        } else {
          result = { applied: false, warning: '窗口不可见且 CDP 未授权, 无法施加虚拟视口; 请在插件 popup 点「启用调试」' };
        }
      }
    } catch { /* 探测失败则按原流程 */ }
    this._viewportProbe.set(tabId, { ts: now, result });
    return result;
  }

  /** 等待页面"稳定"(替代固定 sleep): 连续 quiet 毫秒没有 DOM 变动且 readyState=complete 即认为稳定。
   *  实测价值: 百度等站点先渲染窄版布局再切桌面样式, 加载完成后立刻快照会拍到"过渡态"(元素坐标全错)。
   *  参数: timeout(默认15s) / quiet(默认500ms, 连续静默时长) / maxMutations(可选上限) */
  async waitForStable(tabId, data = {}) {
    if (tabId == null) return { error: 'No active tab' };
    const timeout = data.timeout || 15000;
    const quiet = Math.min(Math.max(+(data.quiet || 500), 100), 5000);
    const start = Date.now();
    try {
      await this.runInPage(tabId, () => {
        window.__arkMut = 0;
        try { if (window.__arkMO) window.__arkMO.disconnect(); } catch { /* ignore */ }
        window.__arkMO = new MutationObserver(() => { window.__arkMut = (window.__arkMut || 0) + 1; });
        window.__arkMO.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        return true;
      });
    } catch (e) {
      return { success: false, error: `注入变动观察器失败: ${e.message}` };
    }
    let lastMut = null;
    let lastChange = Date.now();
    while (Date.now() - start < timeout) {
      const r = await this.evaluateJS(tabId, { code: '({ m: (window.__arkMut || 0), rs: document.readyState })', timeout: 4000 }).catch(() => null);
      const mut = r?.success ? r.result?.m : null;
      const rs = r?.success ? r.result?.rs : null;
      if (mut !== lastMut) { lastMut = mut; lastChange = Date.now(); }
      const quietFor = Date.now() - lastChange;
      if (rs === 'complete' && quietFor >= quiet) {
        return { success: true, mutations: lastMut || 0, quietFor, waited: Date.now() - start };
      }
      if (data.maxMutations && (lastMut || 0) > data.maxMutations) {
        return { success: false, error: `页面变动过多(${lastMut}), 未稳定`, mutations: lastMut, waited: Date.now() - start };
      }
      await new Promise(r => setTimeout(r, 60));
    }
    return { success: false, error: 'timeout waiting for stable', mutations: lastMut || 0, waited: Date.now() - start };
  }

  /** 出错页/系统页守卫: chrome-error:// (拿不到站点时的错误页) 与 about:blank / chrome:// 页面
   *  的渲染进程状态异常, Runtime.evaluate 会一直挂到超时(实测 12s)。提前识别直接给可操作错误。 */
  async assertUsableTab(tabId) {
    if (tabId == null) return { ok: false, error: 'No active tab' };
    let url = '';
    try { const t = await chrome.tabs.get(tabId); url = t?.url || ''; } catch { return { ok: false, error: `标签页 ${tabId} 不存在(可能已关闭)` }; }
    if (url.startsWith('chrome-error://') || url.startsWith('chrome://') || url.startsWith('devtools://') || url === 'about:blank' || url === '') {
      return {
        ok: false,
        url,
        error: `目标标签页不可用于视觉采集: ${url || 'about:blank'}`,
        hint: url.startsWith('chrome-error')
          ? '这是浏览器的错误页(站点不可达/被拦截/域名解析失败)。换可达站点, 或先 POST /open + /wait-for-load 再采。'
          : '系统页 / 空白页不支持内容脚本与截图, 请先导航到目标页面。'
      };
    }
    return { ok: true, url };
  }

  async visionSnapshot(tabId, data = {}) {
    if (tabId == null) return { error: 'No active tab' };
    const usable = await this.assertUsableTab(tabId);
    if (!usable.ok) return usable;
    const vpFix = await this.ensureViewport(tabId);
    // settle=1: 先等页面稳定再采集(避免拍到"过渡态": 部分站点先渲染窄版布局再切桌面样式)
    let settleInfo = null;
    if (data.settle) {
      try {
        settleInfo = await this.waitForStable(tabId, { quiet: data.settleQuiet || 400, timeout: data.settleTimeout || 6000 });
      } catch { /* 稳定等待失败不阻断采集 */ }
    }
    const format = this.normalizeImageFormat(data.format);
    const quality = data.quality != null ? Math.min(Math.max(+data.quality, 10), 100) : 80;
    const annotate = !!(data.annotate || data.annotated);
    const full = !!data.full;
    const isFast = !!(data.fast || data.speed === 'fast');
    const maxElements = Math.min(Math.max(+(data.maxElements || (isFast ? 30 : 50)), 1), 120);
    const selector = data.selector || null;
    const t0 = Date.now();

    // 1) 采集 viewport/标题/锚点 + 可选 SoM 标注(单次 runInPage 原子完成)
    let collected;
    try {
      collected = await this.runInPage(tabId, (selStr, max, doAnnotate) => {
        document.querySelectorAll('.ark-vision-annotate').forEach(e => e.remove());
        // 清除上一轮 ref 标记: 保证 [data-ark-ref] 始终只对应最新一次快照
        document.querySelectorAll('[data-ark-ref]').forEach(e => e.removeAttribute('data-ark-ref'));
        const sel = selStr || 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], summary, [onclick], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
        let candidates;
        try { candidates = Array.from(document.querySelectorAll(sel)); }
        catch { candidates = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"]')); }
        const out = [];
        const seen = new Set();
        const picked = new Set();   // 已收录元素, 用于折叠嵌套噪声
        const PRIMARY = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
        let idx = 0;
        for (const el of candidates) {
          if (out.length >= max) break;
          // 去重(同一元素可能命中多选择器)
          if (seen.has(el)) continue;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width < 6 || rect.height < 6) continue;
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          // 视口过滤：允许轻微越界，但完全在视口外的不可见元素跳过(全页模式也仅取视口附近，避免 1k+ 噪声)
          if (rect.bottom < -40 || rect.top > window.innerHeight + 300 || rect.right < -40 || rect.left > window.innerWidth + 300) continue;
          // 折叠嵌套噪声: <button><span>登录</span></button> 这类会被查两次(外观重叠、编号翻倍、浪费 token)。
          // 规则: 非主要交互标签(A/BUTTON/INPUT/SELECT/TEXTAREA)若其祖先已被收录, 则跳过;
          //       主要交互标签始终保留(如 <div role=button> 里包着真正的 <a>, 链接语义不能丢)。
          if (!PRIMARY.has(el.tagName)) {
            let anc = el.parentElement, contained = false;
            while (anc) { if (picked.has(anc)) { contained = true; break; } anc = anc.parentElement; }
            if (contained) continue;
          }
          picked.add(el);
          // 额外可见性：elementFromPoint 抽样(中心点必须命中自身或子元素)
          // 轻量，不做全量 hit-test，仅过滤被完全遮挡的(被父容器 overflow hidden 裁掉的不算)
          idx++;
          const text = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName === 'INPUT' ? (el.type || 'input') : el.tagName.toLowerCase());
          const name = el.getAttribute('aria-label') || text || el.name || el.id || '';
          // ref 系操作依赖的临时标记: click-ref/fill-ref/hover-ref 直接查 [data-ark-ref="N"],
          // 因此即使页面滚动 / 遮罩变化 / full 模式下元素在视口外, ref 操作依然准确
          el.setAttribute('data-ark-ref', String(idx));
          const item = {
            ref: idx,
            tag: el.tagName,
            role,
            name: String(name).slice(0, 80),
            text: String(text).slice(0, 80),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
            visible: true
          };
          // ---- 语义补强: 只在非默认值时输出, 控制 token 体积 ----
          const type = (el.type || '').toLowerCase();
          if (el.disabled) item.disabled = true;
          if (el.tagName === 'INPUT' && type) item.inputType = type;
          if ((type === 'checkbox' || type === 'radio') && el.checked) item.checked = true;
          if (el.placeholder) item.placeholder = String(el.placeholder).slice(0, 40);
          if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value && type !== 'password') {
            item.value = String(el.value).slice(0, 40);
          }
          if ((el.tagName === 'A' && el.getAttribute('href') && el.getAttribute('href').length > 1) || el.getAttribute('aria-expanded') != null) {
            const href = el.getAttribute('href');
            if (href && href.length > 1 && !href.startsWith('javascript:')) item.href = href.slice(0, 120);
            const expanded = el.getAttribute('aria-expanded');
            if (expanded != null) item.expanded = expanded === 'true';
          }
          // 是否在视口内(不在则截图看不到, 需要先滚动)
          const inView = rect.top >= -20 && rect.bottom <= window.innerHeight + 20 && rect.left >= -20 && rect.right <= window.innerWidth + 20;
          if (!inView) item.inViewport = false;
          // 遮挡检测: 中心点最上层元素不是自己也不是自己的后代 → 被别的元素盖住(点了会打到遮罩)
          try {
            const px = Math.min(Math.max(rect.x + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0));
            const py = Math.min(Math.max(rect.y + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0));
            const hit = inView ? document.elementFromPoint(px, py) : null;
            if (hit && hit !== el && !el.contains(hit)) item.occluded = true;
          } catch { /* ignore */ }
          out.push(item);
          if (doAnnotate) {
            // 仅对视口内元素标注(否则气泡在视口外，截图不可见)
            if (rect.top >= -20 && rect.top <= window.innerHeight && rect.left >= -20 && rect.left <= window.innerWidth) {
              const overlay = document.createElement('div');
              overlay.className = 'ark-vision-annotate';
              overlay.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #ff3b30;background:rgba(255,59,48,0.08);z-index:2147483646;pointer-events:none;box-sizing:border-box;`;
              const badge = document.createElement('div');
              badge.textContent = String(idx);
              badge.style.cssText = `position:absolute;left:-2px;top:-22px;background:#ff3b30;color:white;padding:1px 7px;font-size:12px;font-family:monospace;font-weight:700;line-height:16px;border-radius:4px 4px 4px 0;box-shadow:0 1px 4px rgba(0,0,0,0.3);white-space:nowrap;`;
              overlay.appendChild(badge);
              document.body.appendChild(overlay);
            }
          }
        }
        return {
          url: location.href,
          title: document.title,
          viewport: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight), dpr: window.devicePixelRatio, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) },
          elements: out
        };
      }, [selector, maxElements, annotate && !full]);
    } catch (e) {
      return { success: false, error: `collect failed: ${e.message}` };
    }

    // full + annotate 互斥提示(整页截图的 SoM 仅视口部分可见)
    const annotateNote = (full && annotate) ? 'annotate 在 full 模式下仅视口元素可见，已自动降级为视口标注' : null;

    // 2) 截图(视口 / 整页)
    let shot;
    try {
      if (full) shot = await this.screenshotFull(tabId, { format, quality });
      else shot = await this.screenshot(tabId, { format, quality });
    } catch (e) {
      shot = { success: false, error: e.message };
    }

    // 3) 清理 SoM 叠加(截图已完成，不污染后续交互)
    if (annotate) {
      try { await this.runInPage(tabId, () => document.querySelectorAll('.ark-vision-annotate').forEach(e => e.remove())); } catch {}
    }

    if (!shot || !shot.success) {
      return { success: false, error: shot?.error || 'screenshot failed', url: collected?.url, title: collected?.title, viewport: collected?.viewport, elements: collected?.elements || [], annotateNote };
    }

    // 紧凑输出(compact): 元素由对象变为定长数组, 实测省 ~70% token。
    // 列顺序: ref, tag, role, x, y, w, h, flags, label
    // flags 字母含义: d=disabled c=checked o=occluded(被遮挡) v=不在视口 f=已填值
    const useCompact = !!(data.compact || data.som === 'compact');
    const body = {
      success: true,
      dataUrl: shot.dataUrl,
      format,
      url: collected.url,
      title: collected.title,
      viewport: collected.viewport,
      full: !!full,
      annotate: !!annotate && !full,
      ...(annotateNote ? { annotateNote } : {}),
      ...(vpFix.applied ? { autoViewport: vpFix.viewport, autoViewportNote: vpFix.reason } : {}),
      ...(settleInfo ? { settle: { success: settleInfo.success, mutations: settleInfo.mutations, quietFor: settleInfo.quietFor } } : {}),
      ...(vpFix.warning ? { viewportWarning: vpFix.warning } : {}),
      timestamp: Date.now(),
      elapsed: Date.now() - t0
    };
    if (useCompact) {
      body.elementsFormat = 'compact';
      body.columns = ['ref', 'tag', 'role', 'x', 'y', 'w', 'h', 'flags', 'label'];
      body.columnsNote = 'flags: d=disabled c=checked o=occluded v=非视口内 f=已填值';
      body.elements = collected.elements.map(e => {
        const f = (e.disabled ? 'd' : '') + (e.checked ? 'c' : '') + (e.occluded ? 'o' : '') + (e.inViewport === false ? 'v' : '') + (e.value ? 'f' : '');
        return [e.ref, e.tag, e.role, e.rect.x, e.rect.y, e.rect.width, e.rect.height, f, (e.text || e.name || '').slice(0, 60)];
      });
    } else {
      body.elements = collected.elements;
    }
    return body;
  }

  /** 重载插件代码(改完 extension/ 后自我更新): 先回响应再重载, 否则 WS 消息来不及发出。
   *  重载后 WS 会自动重连, 但 CDP 授权失效, 需在 popup 重新点「启用调试」。 */
  reloadExtension() {
    const version = chrome.runtime.getManifest().version;
    setTimeout(() => { try { chrome.runtime.reload(); } catch (e) { console.error('[ArkWeb] 重载失败:', e); } }, 400);
    return {
      success: true,
      message: '插件将在 400ms 后重载。WS 会自动重连(约数秒), CDP 授权失效需重新点 popup 的「启用调试」',
      currentVersion: version
    };
  }

  // ============ 视觉引用(ref)操作 —— 按 SoM 编号直接操作, 无需坐标换算 ============
  // 快照采集时会给每个元素打 [data-ark-ref="N"] 临时标记, 下列方法据此定位,
  // 因此页面滚动 / 元素位移 / 遮挡变化后依然准确; 标记会在下次快照时统一清除。

  /** 图片格式归一: png / jpeg / webp(webp 体积最小, 视觉模型最省 token) */
  normalizeImageFormat(fmt) {
    const f = String(fmt || '').toLowerCase();
    if (f === 'jpeg' || f === 'jpg') return 'jpeg';
    if (f === 'webp') return 'webp';
    return 'png';
  }

  /** ref 编号 → CSS 选择器 */
  refSelector(ref) {
    const n = parseInt(ref, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return `[data-ark-ref="${n}"]`;
  }

  /** ref → 选择器, 失败时返回带指引的错误对象 */
  resolveRef(data = {}, action = '操作') {
    const sel = this.refSelector(data.ref);
    if (!sel) {
      return {
        error: `ref 必须是快照返回的正整数编号(先拍一次 GET /snapshot?annotate=1, 用 elements[i].ref)`,
        hint: `拿到编号后: POST /act {action:"${action}", ref:3}`,
        ref: data.ref ?? null
      };
    }
    return { selector: sel };
  }

  async clickRef(tabId, data = {}) {
    const r = this.resolveRef(data, 'clickRef');
    if (r.error) return r;
    const out = await this.clickElement(tabId, { selector: r.selector, fast: data.fast, speed: data.speed });
    return { ...out, ref: +data.ref, refSelector: r.selector };
  }

  async hoverRef(tabId, data = {}) {
    const r = this.resolveRef(data, 'hoverRef');
    if (r.error) return r;
    const out = await this.hoverElement(tabId, { selector: r.selector, fast: data.fast });
    return { ...out, ref: +data.ref, refSelector: r.selector };
  }

  async fillRef(tabId, data = {}) {
    const r = this.resolveRef(data, 'fillRef');
    if (r.error) return r;
    if (data.value === undefined) return { error: 'value is required', hint: 'POST /act {action:"fillRef", ref:2, value:"alice"}' };
    // 复用 fill-form 的 React 受控输入兼容路径(原生 setter + input 事件)
    const out = await this.fillForm(tabId, { fields: [{ selector: r.selector, value: data.value }] });
    return { ...out, ref: +data.ref, refSelector: r.selector };
  }

  /** 读取 ref 指向元素的完整文本/值/关键属性 —— 小字读不清时比放大截图更省 token */
  async readTextRef(tabId, data = {}) {
    const r = this.resolveRef(data, 'readText');
    if (r.error) return r;
    const out = await this.runInPage(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const attr = (n) => el.getAttribute(n) || undefined;
      return {
        tag: el.tagName,
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
        value: el.value !== undefined && el.value !== null ? String(el.value).slice(0, 200) : undefined,
        disabled: el.disabled !== undefined ? !!el.disabled : undefined,
        checked: el.checked !== undefined ? !!el.checked : undefined,
        href: attr('href'), src: attr('src'), alt: attr('alt'), title: attr('title'), ariaLabel: attr('aria-label')
      };
    }, [r.selector]);
    if (!out) return { success: false, error: `ref ${data.ref} 对应元素已不存在(页面已变化, 请重新拍快照)`, ref: +data.ref };
    return { success: true, ref: +data.ref, refSelector: r.selector, ...out };
  }

  /** 裁剪放大截图: 读不清的小字/图表细节/图标含义。ref 或 selector 或显式坐标均可。
   *  scale 默认 2(最大 5); webp 格式最省 token。CDP 不可用时降级为元素截图(不放大)。 */
  async zoomShot(tabId, data = {}) {
    if (tabId == null) return { error: 'No active tab' };
    const vpZ = await this.ensureViewport(tabId);
    const invisibleZ = !!vpZ?.applied;
    const format = this.normalizeImageFormat(data.format);
    const quality = data.quality != null ? Math.min(Math.max(+data.quality, 10), 100) : 90;
    const scale = Math.min(Math.max(+(data.scale || 2), 1), 5);
    const sel = data.selector || this.refSelector(data.ref);
    if (!sel && data.x == null) return { error: '需要 ref / selector / x,y,width,height 之一', hint: 'POST /act {action:"zoom", ref:3, scale:3}' };

    // clip 采用与 screenshotElement 一致的视口坐标系(已 scrollIntoView, 元素必在视口内)
    let clip;
    let targetText;
    const clamp = (v, min) => Math.max(min, Math.round(v));
    if (sel) {
      const r = await this.evaluateJS(tabId, { code: `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height, text: (el.innerText || el.textContent || '').trim().slice(0, 60) };
      })()`, timeout: 6000 });
      if (!r.success || !r.result) return { success: false, error: `未找到目标元素(selector=${sel})`, ref: data.ref ?? null };
      const pad = 6; // 外扩, 防止文字贴边被裁
      clip = {
        x: clamp(r.result.x - pad, 0),
        y: clamp(r.result.y - pad, 0),
        width: Math.max(8, Math.round(r.result.width + pad * 2)),
        height: Math.max(8, Math.round(r.result.height + pad * 2)),
        scale
      };
      targetText = r.result.text;
    } else {
      clip = {
        x: clamp(+data.x, 0),
        y: clamp(+data.y, 0),
        width: Math.max(8, Math.round(+data.width || 240)),
        height: Math.max(8, Math.round(+data.height || 120)),
        scale
      };
    }

    try {
      if (!await this.cdp.tryAttach(tabId)) throw new Error('CDP 未授权(请在插件 popup 点「启用调试」)');
      // 注意: 带 clip 的截图必须 fromSurface:true(内核会拒绝 "Only screenshots from surface are allowed"),
      // 因此这里不能用 fromSurface:false 兜底最小化窗口, 只能重试。
      const base = { format, quality, clip, captureBeyondViewport: true };
      let shot = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          shot = await this.cdp.sendWithTimeout(tabId, 'Page.captureScreenshot', base, attempt > 0 ? 10000 : 20000);
          if (shot && typeof shot.data === 'string') break;
        } catch (e) { lastErr = e; }
        if (attempt === 0) await new Promise(r => setTimeout(r, 300));
      }
      if (!shot || typeof shot.data !== 'string') throw new Error(lastErr?.message || '截图未返回数据');
      return {
        success: true,
        dataUrl: `data:image/${format};base64,${shot.data}`,
        format, scale, clip,
        ...(targetText ? { text: targetText } : {}),
        timestamp: Date.now()
      };
    } catch (e) {
      // 降级: 元素截图(无法放大, 但至少给出该区域清爽裁剪)
      if (sel) {
        const fb = await this.screenshotElement(tabId, { selector: sel });
        if (fb && fb.success) return { ...fb, scale: 1, degraded: `CDP 裁剪放大失败(${e.message}), 已降级为元素截图` };
      }
      return { success: false, error: e.message };
    }
  }

  /** 可见文本块 + 紧致坐标(免截图"读"页面): 用于读小字/取文案/交叉校验截图理解。
   *  用 Range 取文本节点自身的紧致盒子(而非父容器), 因此坐标可直接与 /mouse 对齐。 */
  async textMap(tabId, data = {}) {
    if (tabId == null) return { error: 'No active tab' };
    await this.ensureViewport(tabId);
    const minLen = Math.min(Math.max(+(data.minLen || 2), 1), 50);
    const max = Math.min(Math.max(+(data.max || 200), 1), 1000);
    const out = await this.runInPage(tabId, (minL, maxN) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const rows = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const raw = node.nodeValue || '';
        const t = raw.replace(/\s+/g, ' ').trim();
        if (t.length < minL) continue;
        const el = node.parentElement;
        if (!el) continue;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
        let r;
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          r = range.getBoundingClientRect();
        } catch { continue; }
        if (r.width < 2 || r.height < 2) continue;
        rows.push({
          t: t.slice(0, 300),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          tag: el.tagName, fs: Math.round(parseFloat(st.fontSize) || 0),
          inView: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
        });
        if (rows.length >= maxN) break;
      }
      return rows;
    }, [minLen, max]);
    const blocks = out || [];
    return {
      success: true, count: blocks.length,
      blocks: (data.inViewOnly ? blocks.filter(b => b.inView) : blocks)
    };
  }

  /** 按可见文本查找元素(不点击): 返回最贴合文本的若干元素(面积最小者优先) + 快照 ref(若有) */
  async findText(tabId, data = {}) {
    if (tabId == null) return { error: 'No active tab' };
    const needle = String(data.text || data.query || '').trim();
    if (!needle) return { error: 'text is required', hint: 'POST /act {action:"find", text:"登录"}' };
    await this.ensureViewport(tabId);
    const limit = Math.min(Math.max(+(data.limit || 8), 1), 50);
    const out = await this.runInPage(tabId, (q, max, exact) => {
      const hits = [];
      for (const el of document.querySelectorAll('body *')) {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > q.length * 8) continue;          // 过长的容器文本直接跳过(噪声)
        if (exact ? t !== q : !t.includes(q)) continue;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const ref = el.getAttribute('data-ark-ref');
        hits.push({
          text: t.slice(0, 120), tag: el.tagName, role: el.getAttribute('role') || null,
          x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
          center: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
          ref: ref ? +ref : null,
          clickable: !!(el.onclick || el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'),
          area: r.width * r.height
        });
      }
      // 排序: 可点击优先 → 有 ref(即上次快照里出现过)优先 → 面积小者优先(越接近文本叶子节点)
      // 这样"按文本找按钮"时, 真正的可点元素总是排在最前面, 不会被同名容器 DIV 挤掉
      hits.sort((a, b) =>
        (b.clickable - a.clickable) ||
        ((b.ref ? 1 : 0) - (a.ref ? 1 : 0)) ||
        (a.area - b.area)
      );
      // 去重(同文本同位置)
      const seenKey = new Set();
      const dedup = [];
      for (const h of hits) {
        const k = `${h.text}|${h.x}|${h.y}`;
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        dedup.push(h);
        if (dedup.length >= max) break;
      }
      return dedup.map(({ area, ...rest }) => rest);
    }, [needle, limit, !!data.exact]);
    return { success: true, query: needle, matches: (out || []).length, results: out || [] };
  }

  // ============ Cookie ============

  async getCookies(tabId) {
    const url = await this.activeTabUrl(tabId);
    if (!url) return { error: 'No URL' };
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expirationDate, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite
    }));
  }

  async activeTabUrl(tabId) {
    if (tabId != null) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.url) return tab.url;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url;
  }

  async setCookie(data) {
    const { name, value, url, domain, path, secure, httpOnly, sameSite, expirationDate } = data;
    // 未显式给 url 时按请求目标 tab 解析(会话/?tabId 注入), 不能写死活动标签页 —— 否则会话内 set-cookie 泄漏到用户当前页面域
    const targetUrl = url || (await this.activeTabUrl(data.tabId != null ? data.tabId : null));
    if (!targetUrl) return { error: 'url is required' };
    await chrome.cookies.set({
      url: targetUrl, name, value,
      domain: domain || undefined, path: path || '/',
      secure: secure ?? undefined, httpOnly: httpOnly ?? undefined,
      sameSite: sameSite || undefined, expirationDate: expirationDate || undefined
    });
    return { success: true };
  }

  async removeCookie(data) {
    const { name, url, domain } = data;
    // 与 setCookie 同理: 按请求目标 tab 解析, 防止误删/误写用户当前页面的 cookie
    const targetUrl = url || (await this.activeTabUrl(data.tabId != null ? data.tabId : null));
    if (!name || !targetUrl) return { error: 'name and url are required' };
    await chrome.cookies.remove({ url: targetUrl, name });
    return { success: true };
  }

  // ============ Storage ============

  async getStorage(tabId, data) {
    const type = data?.type || 'local';
    return this.runInPage(tabId, (t) => {
      const store = t === 'session' ? sessionStorage : localStorage;
      const items = {};
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        items[k] = store.getItem(k);
      }
      return items;
    }, [type]);
  }

  async setStorage(tabId, data) {
    const { type = 'local', key, value } = data;
    if (key == null) return { error: 'key is required' };
    return this.runInPage(tabId, (t, k, v) => {
      const store = t === 'session' ? sessionStorage : localStorage;
      store.setItem(k, v == null ? 'null' : v);
      return { success: true };
    }, [type, key, value]);
  }

  async removeStorage(tabId, data) {
    const { type = 'local', key } = data;
    return this.runInPage(tabId, (t, k) => {
      const store = t === 'session' ? sessionStorage : localStorage;
      store.removeItem(k);
      return { success: true };
    }, [type, key]);
  }

  async clearStorage(tabId, data) {
    const { type = 'local' } = data;
    return this.runInPage(tabId, (t) => {
      const store = t === 'session' ? sessionStorage : localStorage;
      store.clear();
      return { success: true };
    }, [type]);
  }

  async getStorageChanges(tabId) {
    if (tabId == null) return [];
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'get-storage-changes' }).catch(() => null);
      if (Array.isArray(r)) return r;
    } catch {}
    return [];
  }

  // ============ 网络 ============

  onBeforeRequest(details) {
    if (details.tabId < 0) return;
    const log = {
      id: details.requestId, url: details.url, method: details.method, type: details.type,
      timestamp: details.timeStamp,
      postData: details.requestBody?.raw
        ? new TextDecoder().decode(details.requestBody.raw[0]?.bytes)
        : details.requestBody?.formData || null
    };
    if (!this.networkLogs.has(details.tabId)) this.networkLogs.set(details.tabId, []);
    this.networkLogs.get(details.tabId).push(log);
    this.send({ type: 'network-request', data: log });
  }

  onRequestCompleted(details) {
    if (details.tabId < 0) return;
    const logs = this.networkLogs.get(details.tabId) || [];
    const log = logs.find(l => l.id === details.requestId);
    if (log) {
      log.statusCode = details.statusCode;
      log.statusLine = details.statusLine;
    }
    this.send({ type: 'network-response', data: { ...log, statusCode: details.statusCode } });
  }

  getNetworkLogs(tabId, data) {
    const filter = data?.filter;
    const tab = data?.tabId || tabId;
    let logs = tab != null ? (this.networkLogs.get(tab) || []) : [];
    if (filter) {
      logs = logs.filter(l => (l.url || '').includes(filter));
    }
    return logs.slice(-(data?.limit || 500));
  }

  clearNetworkLogs(tabId) {
    if (tabId != null) {
      this.networkLogs.delete(tabId);
      for (const k of [...(this.bodyCache?.keys() || [])]) if (k.startsWith(`${tabId}:`)) this.bodyCache.delete(k);
    } else {
      this.networkLogs.clear();
      this.bodyCache?.clear();
    }
    return { success: true };
  }

  async getResponseBody(tabId, data) {
    const { requestId, urlPattern } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    let rid = requestId;
    // urlPattern 匹配: 优先用预缓存索引(tabId+url → requestId), 再回退 netResponses 元数据
    if (!rid && urlPattern) {
      for (const [key, val] of this.bodyCache || []) {
        if (String(key).startsWith(`${tabId}:`) && String(val?.url || '').includes(urlPattern)) { rid = String(key).split(':')[1]; break; }
      }
      if (!rid) {
        for (const [key, val] of this.cdp.netResponses) {
          if (key.startsWith(`${tabId}:`) && val.url.includes(urlPattern)) { rid = val.requestId; break; }
        }
      }
    }
    if (!rid) return { error: 'requestId or urlPattern is required (网络响应体需在请求发生后尽快获取)' };
    // 优先读预缓存(主动抓取, 不受 CDP 短暂缓存窗口限制)
    const cached = this.bodyCache?.get(`${tabId}:${rid}`);
    if (cached != null) {
      return { success: true, body: typeof cached === 'string' ? cached : cached.text, fromCache: 'prefetched', meta: this.cdp.netResponses.get(`${tabId}:${rid}`) || null };
    }
    try {
      const { body, base64Encoded } = await this.cdp.send(tabId, 'Network.getResponseBody', { requestId: rid });
      return {
        success: true,
        body: base64Encoded ? b64ToText(body) : body,
        base64Encoded,
        meta: this.cdp.netResponses.get(`${tabId}:${rid}`) || null
      };
    } catch (e) {
      return { error: e.message, hint: '响应体缓存可能已被释放,请在请求发生后立即获取' };
    }
  }

  /** 主动预缓存文本类响应体(html/json/js/css/xml/文本), 图片/字体/媒体跳过;
   *  限制: 单 body ≤2MB, 每 tab 最多 100 条(超出淘汰最旧); 失败重试一次(加载时序/大文件) */
  async prefetchResponseBody(tabId, requestId, meta, attempt = 0) {
    try {
      const mime = (meta.mimeType || '').toLowerCase();
      if (!/(html|json|javascript|ecmascript|xml|css|plain|text)/.test(mime)) return;
      const { body, base64Encoded } = await this.cdp.sendWithTimeout(tabId, 'Network.getResponseBody', { requestId }, 6000);
      if (body == null) return;
      const text = base64Encoded ? b64ToText(body) : String(body);
      if (text.length > 2 * 1024 * 1024) return;
      this.bodyCache = this.bodyCache || new Map();
      const key = `${tabId}:${requestId}`;
      // 存 {text, url}: url 供 urlPattern 检索(即使 netResponses 元数据被淘汰仍可按 URL 取)
      this.bodyCache.set(key, { text, url: meta.url || '' });
      const keys = [...this.bodyCache.keys()].filter(k => k.startsWith(`${tabId}:`));
      if (keys.length > 100) {
        keys.slice(0, keys.length - 100).forEach(k => this.bodyCache.delete(k));
      }
    } catch {
      // loadingFinished 后偶尔仍有短暂不可读窗口, 600ms 后重试一次
      if (attempt === 0) {
        setTimeout(() => this.prefetchResponseBody(tabId, requestId, meta, 1).catch(() => {}), 600);
      }
      /* 失败静默: 部分 body 抓取时序不可控(如 204/流式/Service Worker 拦截), 不影响主流程 */
    }
  }

  async blockUrls(tabId, data) {
    const { patterns = [] } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    await this.cdp.send(tabId, 'Network.setBlockedURLs', { urls: patterns });
    return { success: true, patterns };
  }

  async unblockUrls(tabId) {
    if (tabId != null && await this.cdp.tryAttach(tabId)) {
      try {
        await this.cdp.send(tabId, 'Network.setBlockedURLs', { urls: [] });
        return { success: true };
      } catch { /* fallback */ }
    }
    return { success: false, error: '需要 CDP' };
  }

  async setNetworkConditions(tabId, data) {
    const { offline = false, latency = 0, download, upload } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    await this.cdp.send(tabId, 'Network.emulateNetworkConditions', {
      offline,
      latency,
      downloadThroughput: download == null ? -1 : download,
      uploadThroughput: upload == null ? -1 : upload
    });
    return { success: true, conditions: { offline, latency, download, upload } };
  }

  async resetNetworkConditions(tabId) {
    if (tabId != null && await this.cdp.tryAttach(tabId)) {
      try {
        await this.cdp.send(tabId, 'Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
        });
        return { success: true };
      } catch { /* fallback */ }
    }
    return { success: false, error: '需要 CDP' };
  }

  /** 禁用/启用浏览器缓存 (Network.setCacheDisabled) */
  async setCacheDisabled(tabId, data) {
    const { disabled = true } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    await this.cdp.send(tabId, 'Network.setCacheDisabled', { cacheDisabled: !!disabled });
    return { success: true, disabled: !!disabled };
  }

  /** 绕过页面 CSP (调试用) */
  async bypassCsp(tabId, data) {
    const { enabled = true } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    await this.cdp.send(tabId, 'Page.setBypassCSP', { enabled: !!enabled });
    return { success: true, enabled: !!enabled };
  }

  // ============ 性能 ============

  async getPerformance(tabId) {
    return this.runInPage(tabId, () => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = performance.getEntriesByType('paint');
      const resources = performance.getEntriesByType('resource');
      const resourcesByType = {};
      let totalTransfer = 0;
      resources.forEach(r => {
        const t = r.initiatorType;
        if (!resourcesByType[t]) resourcesByType[t] = { count: 0, totalSize: 0 };
        resourcesByType[t].count++;
        resourcesByType[t].totalSize += r.transferSize || 0;
        totalTransfer += r.transferSize || 0;
      });
      return {
        navigation: nav ? {
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
          loadComplete: Math.round(nav.loadEventEnd),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          domInteractive: Math.round(nav.domInteractive),
          domContentLoadedEventEnd: Math.round(nav.domContentLoadedEventEnd),
          firstPaint: paint.find(p => p.name === 'first-paint')?.startTime || 0
        } : null,
        paint: paint.map(p => ({ name: p.name, startTime: Math.round(p.startTime) })),
        resources: {
          total: resources.length,
          totalTransferKB: Math.round(totalTransfer / 1024),
          byType: resourcesByType,
          thirdParty: resources.filter(r => {
            try { return new URL(r.name).hostname !== location.hostname; }
            catch { return false; }
          }).length
        },
        memory: performance.memory ? {
          usedMB: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
          totalMB: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024),
          limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024)
        } : null
      };
    });
  }

  async getWebVitals(tabId) {
    return this.runInPage(tabId, () => new Promise(resolve => {
      const vitals = {};
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          vitals.LCP = Math.round(entries[entries.length - 1]?.startTime || 0);
          vitals.LCPElement = entries[entries.length - 1]?.element?.tagName || null;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}
      let cls = 0;
      let clsShifts = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              cls += entry.value;
              clsShifts.push(Math.round(entry.value * 1000) / 1000);
            }
          }
          vitals.CLS = cls;
          vitals.CLSShifts = clsShifts;
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!vitals.FID) {
              vitals.FID = Math.round(entry.processingStart - entry.startTime);
              vitals.FIDEvent = entry.name;
            }
          }
        }).observe({ type: 'first-input', buffered: true });
      } catch {}
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) vitals.TTFB = Math.round(nav.responseStart - nav.requestStart);
      const paint = performance.getEntriesByType('paint');
      const fcp = paint.find(e => e.name === 'first-contentful-paint');
      if (fcp) vitals.FCP = Math.round(fcp.startTime);
      setTimeout(() => {
        vitals.summary = {
          LCP: vitals.LCP < 2500 ? 'good' : vitals.LCP < 4000 ? 'needs-improvement' : 'poor',
          FID: vitals.FID == null ? 'no-data' : vitals.FID < 100 ? 'good' : vitals.FID < 300 ? 'needs-improvement' : 'poor',
          CLS: (vitals.CLS || 0) < 0.1 ? 'good' : (vitals.CLS || 0) < 0.25 ? 'needs-improvement' : 'poor',
          TTFB: vitals.TTFB < 800 ? 'good' : vitals.TTFB < 1800 ? 'needs-improvement' : 'poor',
          FCP: vitals.FCP < 1800 ? 'good' : vitals.FCP < 3000 ? 'needs-improvement' : 'poor'
        };
        resolve(vitals);
      }, 1500);
    }), []);
  }

  async getResources(tabId) {
    return this.runInPage(tabId, () => performance.getEntriesByType('resource').map(r => ({
      url: r.name.split('?')[0],
      type: r.initiatorType,
      duration: Math.round(r.duration),
      sizeKB: r.transferSize ? Math.round(r.transferSize / 1024) : 0,
      ttfb: Math.round(r.responseStart - r.requestStart),
      protocol: r.nextHopProtocol,
      cached: r.transferSize === 0 && r.decodedBodySize > 0
    })).sort((a, b) => b.sizeKB - a.sizeKB));
  }

  async setCpuThrottling(tabId, data) {
    const { rate = 4 } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    await this.cdp.send(tabId, 'Emulation.setCPUThrottlingRate', { rate });
    return { success: true, rate };
  }

  // ============ 模拟(真实 CDP) ============

  async simulateDevice(tabId, data) {
    const { device } = data;
    const devices = {
      'iPhone 14': { width: 390, height: 844, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
      'iPhone 14 Pro Max': { width: 430, height: 932, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
      'iPhone SE': { width: 375, height: 667, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
      'iPad': { width: 820, height: 1180, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
      'iPad Pro': { width: 1024, height: 1366, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
      'Pixel 7': { width: 412, height: 915, dpr: 2.625, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36' },
      'Galaxy S23': { width: 360, height: 780, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36' },
      'Desktop': { width: 1440, height: 900, dpr: 1, mobile: false, ua: null }
    };
    // Chrome 151+: setDeviceMetricsOverride mobile:true 不再自动切换 UA, 需显式覆盖
    const DEFAULT_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    const config = devices[device] || (data.width ? {
      width: data.width, height: data.height || 900, dpr: data.dpr || 1,
      mobile: data.mobile || false,
      ua: data.userAgent || (data.mobile ? DEFAULT_MOBILE_UA : null)
    } : null);
    if (!config) return { error: `Unknown device: ${device}` };

    // 记录原始 UA 与视口供恢复(连续多次 set 后 clearDeviceMetricsOverride 可能失效, 需重新应用原始值)
    let origUA = null;
    let origViewport = null;
    if (tabId != null) {
      const r = await this.cdp.evaluate(tabId, 'navigator.userAgent').catch(() => null);
      origUA = r?.success ? r.result : null;
      try {
        const v = await this.cdp.evaluate(tabId, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scale: visualViewport ? visualViewport.scale : 1 })').catch(() => null);
        origViewport = v?.success ? v.result : null;
      } catch { /* 忽略 */ }
    }

    if (tabId != null && await this.cdp.tryAttach(tabId)) {
      try {
        await this.cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', {
          width: config.width, height: config.height,
          deviceScaleFactor: config.dpr, mobile: config.mobile
        });
        if (config.ua) {
          await this.cdp.send(tabId, 'Emulation.setUserAgentOverride', { userAgent: config.ua, platform: config.mobile ? 'iPhone' : 'Windows' });
        }
        await this.cdp.send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: config.mobile, maxTouchPoints: config.mobile ? 5 : 1 });
        this.deviceOverrides.set(tabId, { config, origUA, origViewport });
        return { success: true, method: 'cdp', device: config };
      } catch { /* fallback */ }
    }
    if (tabId == null) return { error: 'No active tab' };
    await chrome.tabs.setZoomSettings(tabId, { mode: 'manual', zoomFactor: config.dpr });
    this.deviceOverrides.set(tabId, { config, origUA, origViewport });
    return { success: true, method: 'zoom-fallback', device: config };
  }

  async clearDevice(tabId) {
    if (tabId == null) return { error: 'No active tab' };
    const prev = this.deviceOverrides.get(tabId);
    // 记录缺失(如 SW 重启/会话切换后): UA/视口 override 可能残留且无法精确恢复原始值
    // → 强制走 detach→attach→set→clear 路径( detach 会清空该 tab 全部 CDP Emulation override )
    const prevMissing = !prev;

    /** 成对清除(metrics + touch), 返回错误列表 */
    const pairClear = async () => {
      const errs = [];
      try {
        await this.cdp.send(tabId, 'Emulation.clearDeviceMetricsOverride');
      } catch (e) { errs.push(`metrics: ${e.message}`); }
      try {
        if (prev?.origUA) await this.cdp.send(tabId, 'Emulation.setUserAgentOverride', { userAgent: prev.origUA, platform: 'Windows' });
      } catch (e) { errs.push(`ua: ${e.message}`); }
      try {
        await this.cdp.send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      } catch (e) { errs.push(`touch: ${e.message}`); }
      return errs;
    };

    if (await this.cdp.tryAttach(tabId)) {
      let errors = await pairClear();
      // 校验语义: clearDevice 的目标是"移除设备模拟"(移动 UA / mobile / dpr)。
      // 夸克内核下 Emulation.clearDeviceMetricsOverride 可能不还原视口宽度(实测 UA/dpr 恢复了但视口残留
      // device 宽度), 窗口不可见时更不可靠。因此不以 innerWidth 是否变化作为成败判据, 而以"移动 UA 是否移除"
      // 为准; 视口可用性由下面的归一化步骤兜底保证。
      const mobileGone = async () => {
        try {
          const r = await this.cdp.evaluate(tabId, '({ ua: navigator.userAgent, w: innerWidth })').catch(() => null);
          const cur = r?.result;
          if (!cur || typeof cur.w !== 'number') return false;
          return !/iPhone|Android|Mobile|iPad/i.test(cur.ua || '');
        } catch { return false; }
      };
      // 自愈: prev 缺失(可能残留 UA/metrics)或移动 UA 未清除 → 用 detach 彻底重置 session 级 override
      if (errors.length === 0 && (!await mobileGone() || prevMissing)) {
        console.log('[ArkWeb] clearDevice 移动 UA 未清除或记录缺失, 执行 session 重置自愈(detach→attach→clear)');
        try {
          await this.cdp.detach(tabId);
          await new Promise(r => setTimeout(r, 300));
          if (await this.cdp.tryAttach(tabId)) {
            await new Promise(r => setTimeout(r, 200));
            errors = await pairClear();   // detach 已清 session 级 override, 这里再补一次成对 clear 兜底
            let restored = false;
            for (let i = 0; i < 10; i++) {
              if (await mobileGone()) { restored = true; break; }
              await new Promise(r => setTimeout(r, 400));
            }
            if (!restored) errors.push('self-heal: 移动 UA 未清除(该内核可能不支持完整清除设备模拟)');
          } else {
            errors.push('re-attach failed');
          }
        } catch (e) {
          errors.push(`self-heal: ${e.message}`);
        }
      }
      this.deviceOverrides.delete(tabId);
      if (errors.length) {
        console.log('[ArkWeb] clearDevice 部分失败:', errors.join(' | '));
        return { success: false, cleared: false, errors, prev: prev ? { config: prev.config, origViewport: prev.origViewport } : null };
      }
      // 视口还原校验: 夸克内核 Emulation.clearDeviceMetricsOverride 可能不还原视口宽高
      // (实测带 <meta viewport> 的页面首次 clear 残留设备宽度 390x844, UA/dpr 已恢复)。
      // 注意: 不可用 detach→attach 重置 —— 无用户手势时会使 CDP 授权失效(throttled),
      // 引发后续命令降级与 tab 路由异常。改用"写回原始视口"的软还原:
      // ① clear 后探测 → ② 可见但残留设备宽度则 setDeviceMetricsOverride 写回 set 前记录的
      // 原始视口(幂等: 再次 clear 不清掉也只停留在正确值) → ③ 窗口不可见或写回失败则虚拟视口兜底。
      let viewportFix = null;
      try {
        this._viewportProbe.delete(tabId);
        const probeVP = async () => {
          const p = await this.evaluateJS(tabId, { code: '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })', timeout: 3000 }).catch(() => null);
          return p?.success && p.result && typeof p.result.w === 'number' ? p.result : null;
        };
        const devW = prev?.config?.width;
        // 异常视口判定: 0/极小值(最小化上报异常小值, 实测夸克 45x14)或残留 device 宽度均视为需要修复
        const TINY = 100;
        const isBad = (v) => !!v && (v.w === 0 || v.h === 0 || v.w < TINY || v.h < TINY || (devW != null && v.w === devW));
        await new Promise(r => setTimeout(r, 350));
        let vp = await probeVP();
        // ② 可见但残留 device 宽度: 写回原始视口(软还原)
        if (isBad(vp) && vp.w !== 0) {
          const ow = prev?.origViewport?.w, oh = prev?.origViewport?.h, od = prev?.origViewport?.dpr;
          // 仅当记录的原始视口看起来有效(非最小化异常小值)时才写回; 否则交给 ③ 虚拟视口兜底
          if (ow > TINY && oh > TINY) {
            try {
              await this.cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', {
                width: ow, height: oh, deviceScaleFactor: od || 1, mobile: false
              });
              console.log(`[ArkWeb] clearDevice 视口残留 ${vp.w}x${vp.h}, 已写回原始视口 ${ow}x${oh} dpr=${od}`);
              viewportFix = { method: 'restore-original', viewport: { width: ow, height: oh, dpr: od } };
            } catch (e) { errors.push(`viewport: restore failed: ${e.message}`); }
          }
        }
        // ③ 仍残留(窗口不可见/无法写回): 虚拟视口兜底
        vp = await probeVP();
        if (isBad(vp)) {
          const got = await this.ensureViewport(tabId, { force: true, allowResidual: true });
          if (got?.applied) viewportFix = { method: 'virtual', viewport: got.viewport };
        }
      } catch { /* ignore */ }
      return { success: true, cleared: true, method: 'cdp', prev: prev ? { config: prev.config, origViewport: prev.origViewport } : null, ...(viewportFix ? { viewportRestore: viewportFix } : {}) };
    }
    try {
      await chrome.tabs.setZoomSettings(tabId, { mode: 'automatic' });
    } catch (e) { /* ignore */ }
    this.deviceOverrides.delete(tabId);
    return { success: true, cleared: true, method: 'zoom-fallback' };
  }

  /** 一键恢复全部模拟/策略影响(任务结束/中断后清理, 不影响用户正常浏览):
   *  设备视口+UA+touch → 媒体 → 地理 → 时区 → 语言 → CPU → JS 执行 → 硬件并发 → 网络条件
   *  → 禁用缓存 → CSP 绕过 → 自动暗色 → 高亮 → 弹窗策略(恢复 autoAccept) → 滚动位置(顶部)
   *  逐个容错执行, 返回每项结果; 全部幂等, 重复调用安全 */
  async resetAllSimulations(tabId) {
    if (tabId == null) return { error: 'No active tab' };
    const r = {};
    const safe = async (name, fn) => {
      try { r[name] = await fn(); }
      catch (e) { r[name] = { success: false, error: e.message }; }
    };
    await safe('device', () => this.clearDevice(tabId).then(x => x?.success ? { success: true, cleared: true } : x));
    // 视觉残留: SoM 编号气泡 + ref 标记(都不应留在页面上)
    await safe('visionRefs', async () => {
      const cleared = await this.runInPage(tabId, () => {
        document.querySelectorAll('.ark-vision-annotate').forEach(e => e.remove());
        const marked = document.querySelectorAll('[data-ark-ref]');
        marked.forEach(e => e.removeAttribute('data-ark-ref'));
        return marked.length;
      }).catch(() => null);
      return { success: true, cleared: cleared ?? 0 };
    });
    await safe('media', async () => {
      if (await this.cdp.tryAttach(tabId)) {
        await this.cdp.send(tabId, 'Emulation.setEmulatedMedia', { features: [] });
        return { success: true };
      }
      return { success: false, error: '需要 CDP' };
    });
    await safe('geo', async () => {
      this._geoConfigs?.delete(tabId);
      const scriptId = this._geoScripts?.get(tabId);
      if (scriptId != null) { try { await this.cdp.send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }); } catch { /* ignore */ } }
      this._geoScripts?.delete(tabId);
      return { success: true };
    });
    await safe('timezone', async () => {
      if (await this.cdp.tryAttach(tabId)) {
        await this.cdp.send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: '' });
        return { success: true };
      }
      return { success: false, error: '需要 CDP' };
    });
    await safe('locale', async () => {
      if (await this.cdp.tryAttach(tabId)) {
        await this.cdp.send(tabId, 'Emulation.setLocaleOverride', { locale: '' });
      }
      // 清除 locale mock 注入(脚本 + 实例影子属性)
      const locScriptId = this._localeScripts?.get(tabId);
      if (locScriptId != null) { try { await this.cdp.send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: locScriptId }); } catch { /* ignore */ } }
      this._localeScripts?.delete(tabId);
      this._localeConfigs?.delete(tabId);
      await this.runInPage(tabId, () => { delete navigator.language; delete navigator.languages; return true; }).catch(() => null);
      return { success: true };
    });
    await safe('cpu', async () => {
      if (await this.cdp.tryAttach(tabId)) {
        await this.cdp.send(tabId, 'Emulation.setCPUThrottlingRate', { rate: 1 });
        return { success: true };
      }
      return { success: false, error: '需要 CDP' };
    });
    await safe('js', async () => {
      if (await this.cdp.tryAttach(tabId)) {
        await this.cdp.send(tabId, 'Emulation.setScriptExecutionDisabled', { value: false });
        return { success: true };
      }
      return { success: false, error: '需要 CDP' };
    });
    await safe('hardwareConcurrency', async () => {
      if (await this.cdp.tryAttach(tabId)) {
        const real = navigator.hardwareConcurrency || 4;
        await this.cdp.send(tabId, 'Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: real });
        return { success: true, count: real, restored: true };
      }
      return { success: false, error: '需要 CDP' };
    });
    await safe('networkConditions', () => this.resetNetworkConditions(tabId));
    await safe('cache', () => this.setCacheDisabled(tabId, { disabled: false }));
    await safe('csp', () => this.bypassCsp(tabId, { enabled: false }));
    await safe('autoDark', () => this.autoDarkMode(tabId, { enabled: false }));
    await safe('highlight', async () => {
      await this.clearHighlight(tabId);
      // v7-vision: 同时清理 SoM 标注叠加
      try { await this.runInPage(tabId, () => document.querySelectorAll('.ark-vision-annotate').forEach(e => e.remove())); } catch {}
      return { success: true };
    });
    // 弹窗策略恢复自动应答(手动模式遗留时避免用户页面被弹窗卡死)
    const p = this.getDialogPolicy(tabId);
    if (p.autoAccept !== true) {
      p.autoAccept = true;
      this._dialogPolicies = this._dialogPolicies || new Map();
      this._dialogPolicies.set(tabId, { autoAccept: true, promptText: null });
      r.dialogPolicy = { success: true, restored: true };
    } else {
      r.dialogPolicy = { success: true, unchanged: true };
    }
    // 页面滚动位置恢复顶部(后台 tab 无感知)
    await safe('scroll', async () => {
      await this.runInPage(tabId, () => { window.scrollTo(0, 0); return true; }).catch(() => null);
      return { success: true };
    });
    return { success: true, tabId, restored: r };
  }

  async emulateMedia(tabId, data) {
    const { features = [] } = data;
    if (tabId != null && await this.cdp.tryAttach(tabId)) {
      try {
        await this.cdp.send(tabId, 'Emulation.setEmulatedMedia', { features });
        return { success: true, method: 'cdp', features };
      } catch { /* fallback */ }
    }
    if (tabId == null) return { error: 'No active tab' };
    await this.runInPage(tabId, (feats) => {
      document.getElementById('ark-web-media-emulation')?.remove();
      let css = '';
      feats.forEach(f => {
        if (f.name === 'prefers-color-scheme' && f.value === 'dark') css += `* { color-scheme: dark !important; }`;
        if (f.name === 'prefers-reduced-motion' && f.value === 'reduce') css += `*, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }`;
        if (f.name === 'prefers-contrast' && f.value === 'high') css += `* { filter: contrast(1.5) !important; }`;
      });
      if (css) {
        const style = document.createElement('style');
        style.id = 'ark-web-media-emulation';
        style.textContent = css;
        document.head.appendChild(style);
      }
      return { success: true, method: 'css-fallback', features: feats };
    }, [features]);
  }

  /** geolocation mock 注入函数(主 world): 跨导航生效, 由 addScriptToEvaluateOnNewDocument + loadEventFired 双通道注册。
   *  注意: 必须用箭头函数字段而非类方法 — 类方法 toString() 生成方法简写语法, 包成表达式是 SyntaxError, 注入源码会编译失败 */
  _geoInjectFn = (lat, lng, acc) => {
    window.__arkGeoMock = true;
    const pos = {
      coords: { latitude: lat, longitude: lng, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now()
    };
    const mock = {
      getCurrentPosition: (ok, err) => { if (ok) setTimeout(() => ok(pos), 0); else if (err) setTimeout(() => err({ code: 1, message: 'mock position unavailable' }), 0); },
      watchPosition: (ok, err) => { if (ok) setTimeout(() => ok(pos), 0); return 1; },
      clearWatch: () => {},
      getPosition: (ok, err) => { if (ok) setTimeout(() => ok(pos), 0); else if (err) setTimeout(() => err({ code: 1, message: 'mock position unavailable' }), 0); }
    };
    // 实例级 → 原型级 → 直接赋值, 三级 fallback(不同文档时机下属性配置不同)
    try { Object.defineProperty(navigator, 'geolocation', { value: mock, configurable: true, writable: true }); }
    catch (e1) {
      try { Object.defineProperty(Navigator.prototype, 'geolocation', { value: mock, configurable: true, writable: true }); }
      catch (e2) { navigator.geolocation = mock; }
    }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (desc) => {
          if (desc && desc.name === 'geolocation') return Promise.resolve({ state: 'granted', onchange: null });
          return origQuery(desc);
        };
      }
    } catch { /* 忽略 */ }
    return true;
  }

  async setGeolocation(tabId, data) {
    const { latitude, longitude, accuracy = 10 } = data;
    if (tabId == null) return { error: 'No active tab' };
    // 恢复模式: latitude 为空 → 移除注入脚本 + 清除 override
    if (latitude == null) {
      try {
        await this.cdp.send(tabId, 'Emulation.clearGeolocationOverride').catch(() => {});
        const scriptId = this._geoScripts?.get(tabId);
        if (scriptId) {
          await this.cdp.send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => {});
          this._geoScripts.delete(tabId);
        }
        this._geoConfigs?.delete(tabId);
      } catch { /* 忽略 */ }
      return { success: true, cleared: true };
    }
    const errors = [];
    // 1) CDP 坐标 override(尽力; 权限为 granted 时生效)
    try {
      await this.cdp.send(tabId, 'Emulation.setGeolocationOverride', { latitude, longitude, accuracy });
    } catch (e) {
      errors.push(`Emulation.setGeolocationOverride: ${e.message}`);
    }
    // 2) 权限不可通过 CDP 授予(Browser/Permissions 域不在 chrome.debugger 白名单)。
    //    注入 navigator.geolocation mock 到每次新文档(主 world, 可撤销) — tab 目标下唯一可靠路径
    try {
      this._geoConfigs = this._geoConfigs || new Map();
      this._geoConfigs.set(tabId, { latitude, longitude, accuracy });
      const source = `(${this._geoInjectFn.toString()})(${JSON.stringify(latitude)}, ${JSON.stringify(longitude)}, ${JSON.stringify(accuracy)})`;
      const prevId = this._geoScripts?.get(tabId);
      if (prevId) {
        await this.cdp.send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: prevId }).catch(() => {});
      }
      const { identifier } = await this.cdp.send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source });
      this._geoScripts = this._geoScripts || new Map();
      this._geoScripts.set(tabId, identifier);
      // 立即在当前文档也注入一次(页面已加载时无需等待导航), 复用同一注入函数保证行为一致
      await this.runInPage(tabId, this._geoInjectFn, [latitude, longitude, accuracy]).catch(() => null);
      return { success: true, location: { latitude, longitude }, method: 'mock', ...(errors.length ? { errors } : {}) };
    } catch (e) {
      errors.push(`inject-mock: ${e.message}`);
    }
    return { success: errors.length === 0, location: { latitude, longitude }, ...(errors.length ? { errors } : {}) };
  }

  /** locale mock 注入函数(主 world): 夸克内核忽略 Emulation.setLocaleOverride, 用实例属性影子化 navigator.language/languages。
   *  必须用箭头函数字段(类方法 toString 会生成方法简写, 注入源码编译失败)。清除时 delete 实例属性即可还原原型值 */
  _localeInjectFn = (lang) => {
    try {
      Object.defineProperty(navigator, 'language', { get: () => lang, configurable: true });
      Object.defineProperty(navigator, 'languages', { get: () => [lang], configurable: true });
      return true;
    } catch (e) { return false; }
  }

  async setLocale(tabId, data) {
    const { locale } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    // 清除模式: locale 为空 → 移除注入脚本 + delete 实例影子属性 + 清 CDP override
    if (locale == null || locale === '') {
      const scriptId = this._localeScripts?.get(tabId);
      if (scriptId) {
        try { await this.cdp.send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }); } catch { /* ignore */ }
        this._localeScripts.delete(tabId);
      }
      this._localeConfigs?.delete(tabId);
      try { await this.runInPage(tabId, () => { delete navigator.language; delete navigator.languages; return true; }); } catch { /* ignore */ }
      try { await this.cdp.send(tabId, 'Emulation.setLocaleOverride', { locale: '' }); } catch { /* ignore */ }
      return { success: true, cleared: true };
    }
    // 1) 标准 CDP override(真实 Chrome 生效; 夸克忽略, 保留以兼容)
    let overrideOk = true;
    try { await this.cdp.send(tabId, 'Emulation.setLocaleOverride', { locale }); } catch { overrideOk = false; }
    // 2) 注入 mock(夸克等内核的可靠路径): 当前文档立即生效 + addScriptToEvaluateOnNewDocument 跨导航重放
    try {
      this._localeConfigs = this._localeConfigs || new Map();
      this._localeConfigs.set(tabId, { locale });
      const source = `(${this._localeInjectFn.toString()})(${JSON.stringify(locale)})`;
      const prevId = this._localeScripts?.get(tabId);
      if (prevId) {
        try { await this.cdp.send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: prevId }); } catch { /* ignore */ }
      }
      const { identifier } = await this.cdp.send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source });
      this._localeScripts = this._localeScripts || new Map();
      this._localeScripts.set(tabId, identifier);
      await this.runInPage(tabId, this._localeInjectFn, [locale]).catch(() => null);
      return { success: true, locale, method: 'mock', ...(overrideOk ? {} : { overrideFailed: true }) };
    } catch (e) {
      return { success: overrideOk, locale, method: overrideOk ? 'cdp' : 'failed', error: overrideOk ? undefined : e.message };
    }
  }

  async setTimezone(tabId, data) {
    const { timezoneId } = data;
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '需要 CDP(请在 popup 中启用调试)' };
    await this.cdp.send(tabId, 'Emulation.setTimezoneOverride', { timezoneId });
    return { success: true, timezoneId };
  }

  // ============ 文件上传 ============

  async uploadFile(tabId, data) {
    const { selector, files } = data;
    if (!Array.isArray(files) || files.length === 0) return { error: 'files is required' };
    if (tabId == null || !await this.cdp.tryAttach(tabId)) return { error: '文件上传需要 CDP(请在 popup 中启用调试)' };
    const { root } = await this.cdp.send(tabId, 'DOM.getDocument');
    const node = await this.cdp.send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!node.nodeId) return { error: `Element not found: ${selector}` };
    await this.cdp.send(tabId, 'DOM.setFileInputFiles', { nodeId: node.nodeId, files });
    return { success: true, files };
  }

  // ============ 审计采集 ============

  /** 一次 CDP 往返采集 30+ 维度原始数据 */
  async auditCollect(tabId) {
    if (tabId == null || !await this.cdp.tryAttach(tabId)) {
      return { error: '审计需要 CDP(请在 popup 中启用调试)' };
    }
    const t0 = Date.now();
    try {
      const r = await this.cdp.evaluate(tabId, AUDIT_COLLECT_SCRIPT, 30000);
      if (!r.success) return { error: r.error };
      const payload = r.result || {};
      // 主文档响应头 + 网络元数据(来自 CDP Network 记录)
      const doc = this.findDocumentResponse(tabId);
      payload.network = {
        document: doc ? {
          status: doc.status,
          headers: doc.headers || {},
          mimeType: doc.mimeType,
          fromCache: doc.fromCache
        } : null
      };
      payload.collectedAt = Date.now();
      payload.collectMs = Date.now() - t0;
      return { success: true, audit: payload };
    } catch (e) {
      return { error: e.message };
    }
  }

  /** 从 CDP 记录中找主文档(html)响应 */
  findDocumentResponse(tabId) {
    let best = null;
    for (const [key, val] of this.cdp.netResponses) {
      if (!key.startsWith(`${tabId}:`)) continue;
      if (val.mimeType && val.mimeType.includes('text/html')) {
        if (!best || val.timestamp > best.timestamp) best = val;
      }
    }
    return best;
  }

  // ============ 安全检查 ============

  async securityCheck(tabId) {
    return this.runInPage(tabId, async () => {
      const checks = [];
      checks.push({ test: 'HTTPS', pass: location.protocol === 'https:', value: location.protocol });
      let headers = {};
      try {
        const resp = await fetch(location.href, { method: 'HEAD' });
        headers = {};
        resp.headers.forEach((v, k) => headers[k] = v);
      } catch {}
      const headerChecks = [
        ['content-security-policy', 'CSP'],
        ['x-content-type-options', 'X-Content-Type-Options'],
        ['x-frame-options', 'X-Frame-Options'],
        ['strict-transport-security', 'HSTS'],
        ['referrer-policy', 'Referrer-Policy'],
        ['permissions-policy', 'Permissions-Policy']
      ];
      headerChecks.forEach(([name, label]) => {
        checks.push({ test: label, pass: !!headers[name], value: headers[name] || 'MISSING' });
      });
      const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      if (!headers['content-security-policy']) {
        checks.push({ test: 'CSP Meta', pass: !!cspMeta, value: cspMeta?.content });
      }
      const insecureScripts = Array.from(document.querySelectorAll('script[src]')).filter(s => s.src.startsWith('http:'));
      checks.push({ test: 'Insecure Scripts', pass: insecureScripts.length === 0, count: insecureScripts.length });
      const mixedContent = Array.from(document.querySelectorAll('img[src^="http:"], script[src^="http:"], iframe[src^="http:"]')).length;
      checks.push({ test: 'Mixed Content', pass: mixedContent === 0, count: mixedContent });
      const forms = document.querySelectorAll('form');
      let insecureForms = 0;
      forms.forEach(f => {
        if (f.method.toLowerCase() === 'get' && f.querySelector('input[type="password"]')) insecureForms++;
      });
      checks.push({ test: 'Password Form Security', pass: insecureForms === 0, count: insecureForms });
      const iframes = document.querySelectorAll('iframe');
      const noSandbox = Array.from(iframes).filter(f => !f.hasAttribute('sandbox'));
      checks.push({ test: 'Iframe Sandbox', pass: noSandbox.length === 0, count: noSandbox.length });
      return checks;
    });
  }

  // ============ A11y ============

  async a11yCheck(tabId) {
    return this.runInPage(tabId, () => {
      const issues = [];
      document.querySelectorAll('img:not([alt])').forEach(img => {
        issues.push({ type: 'error', rule: 'img-alt', message: 'Image missing alt attribute', element: img.src?.slice(0, 80) });
      });
      document.querySelectorAll('input:not([type="hidden"])').forEach(input => {
        const hasLabel = input.id && document.querySelector(`label[for="${input.id}"]`);
        const parentLabel = input.closest('label');
        if (!hasLabel && !parentLabel && !input.getAttribute('aria-label') && !input.getAttribute('title')) {
          issues.push({ type: 'error', rule: 'input-label', message: `Input missing label (${input.name || input.type})` });
        }
      });
      document.querySelectorAll('a, button, [role="button"]').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
          issues.push({ type: 'warning', rule: 'target-size', message: `Target too small: ${Math.round(rect.width)}x${Math.round(rect.height)}`, element: el.outerHTML.slice(0, 100) });
        }
      });
      if (!document.documentElement.lang) {
        issues.push({ type: 'error', rule: 'html-lang', message: 'HTML missing lang attribute' });
      }
      document.querySelectorAll('[aria-hidden="true"]').forEach(el => {
        if (el.querySelector(':focus') || el.textContent?.trim()) {
          issues.push({ type: 'warning', rule: 'aria-hidden', message: 'Element with aria-hidden contains content', element: el.outerHTML.slice(0, 100) });
        }
      });
      const buttons = document.querySelectorAll('button');
      Array.from(buttons).filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).forEach(b => {
        issues.push({ type: 'warning', rule: 'button-name', message: 'Button without accessible name', element: b.outerHTML.slice(0, 100) });
      });
      return issues;
    });
  }

  // ============ SEO ============

  async seoCheck(tabId) {
    return this.runInPage(tabId, () => {
      const checks = [];
      const title = document.title;
      checks.push({ test: 'Title', pass: title.length > 0 && title.length < 60, value: title, length: title.length });
      const metaDesc = document.querySelector('meta[name="description"]');
      checks.push({ test: 'Meta Description', pass: !!metaDesc?.content && metaDesc.content.length > 0 && metaDesc.content.length < 160, value: metaDesc?.content || '', length: metaDesc?.content?.length || 0 });
      const h1s = document.querySelectorAll('h1');
      checks.push({ test: 'H1 Tag', pass: h1s.length === 1, count: h1s.length, value: h1s[0]?.textContent?.trim()?.slice(0, 80) });
      const canonical = document.querySelector('link[rel="canonical"]');
      checks.push({ test: 'Canonical URL', pass: !!canonical, value: canonical?.href });
      const og = ['title', 'description', 'image', 'url'];
      const ogPresent = og.every(t => document.querySelector(`meta[property="og:${t}"]`));
      checks.push({ test: 'Open Graph', pass: ogPresent, missing: og.filter(t => !document.querySelector(`meta[property="og:${t}"]`)) });
      const viewport = document.querySelector('meta[name="viewport"]');
      checks.push({ test: 'Mobile Viewport', pass: !!viewport, value: viewport?.content });
      const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
      checks.push({ test: 'Structured Data', pass: jsonLd.length > 0, count: jsonLd.length });
      const images = document.querySelectorAll('img');
      const noAlt = Array.from(images).filter(i => !i.alt);
      checks.push({ test: 'Image Alt', pass: noAlt.length === 0, total: images.length, missing: noAlt.length });
      const headings = ['h2', 'h3', 'h4'];
      headings.forEach(h => {
        const els = document.querySelectorAll(h);
        checks.push({ test: `${h.toUpperCase()} Headings`, pass: els.length > 0, count: els.length });
      });
      const links = document.querySelectorAll('a[href]');
      const internal = Array.from(links).filter(a => a.href.startsWith(location.origin) || a.href.startsWith('/'));
      const noText = Array.from(links).filter(a => !a.textContent.trim() && !a.getAttribute('aria-label') && !a.getAttribute('title'));
      checks.push({ test: 'Links', count: links.length, internal: internal.length, noText: noText.length });
      return checks;
    });
  }

  // ============ 控制台 / DOM 变化 ============

  getConsoleLogs(tabId, data) {
    const target = data?.tabId || tabId;
    const logs = this.consoleLogs.get(target) || [];
    if (logs.length === 0 && target != null) {
      try {
        chrome.tabs.sendMessage(target, { type: 'get-console-logs' }, (r) => {
          if (r && Array.isArray(r) && r.length > 0 && !this.consoleLogs.has(target)) {
            this.consoleLogs.set(target, r.slice(-500));
          }
        });
      } catch {}
    }
    return logs.slice(-(data?.limit || 500));
  }

  clearConsoleLogs(tabId) {
    if (tabId != null) this.consoleLogs.delete(tabId);
    else this.consoleLogs.clear();
    return { success: true };
  }

  async getDomChanges(tabId) {
    const memory = this.domChanges.get(tabId) || [];
    if (tabId != null) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'get-dom-changes' }).catch(() => null);
        if (Array.isArray(r)) return r;
      } catch {}
    }
    return memory;
  }

  clearDomChanges(tabId) {
    if (tabId != null) this.domChanges.delete(tabId);
    else this.domChanges.clear();
    return { success: true };
  }

  // ============ CDP 事件 ============

  onCdpEvent(tabId, method, params) {
    if (!tabId) return;
    this._cdpEventCount = (this._cdpEventCount || 0) + 1;
    try {
      switch (method) {
        case 'Runtime.consoleAPICalled': {
          const log = {
            type: params.type,
            args: (params.args || []).slice(0, 5).map(a => a.value != null ? String(a.value).slice(0, 300) : (a.description || a.type || '')),
            timestamp: Date.now()
          };
          if (!this.consoleLogs.has(tabId)) this.consoleLogs.set(tabId, []);
          const logs = this.consoleLogs.get(tabId);
          logs.push(log);
          if (logs.length > 1000) logs.splice(0, logs.length - 1000);
          this.forwardConsole(tabId);
          break;
        }
        case 'Runtime.exceptionThrown': {
          const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception';
          const log = { type: 'error', args: [String(desc).slice(0, 500)], timestamp: Date.now(), exception: true };
          if (!this.consoleLogs.has(tabId)) this.consoleLogs.set(tabId, []);
          this.consoleLogs.get(tabId).push(log);
          this.forwardConsole(tabId);
          break;
        }
        case 'Network.responseReceived': {
          const key = `${tabId}:${params.requestId}`;
          const meta = {
            requestId: params.requestId,
            url: params.response?.url,
            status: params.response?.status,
            statusText: params.response?.statusText,
            headers: params.response?.headers,
            mimeType: params.response?.mimeType,
            fromCache: params.response?.fromDiskCache || params.response?.fromPrefetchCache,
            timestamp: Date.now()
          };
          this.cdp.netResponses.set(key, meta);
          let n = 0;
          for (const k of this.cdp.netResponses.keys()) if (k.startsWith(`${tabId}:`)) n++;
          if (n > 200) {
            const keys = [...this.cdp.netResponses.keys()].filter(k => k.startsWith(`${tabId}:`)).slice(0, n - 200);
            keys.forEach(k => { this.cdp.netResponses.delete(k); this.bodyCache?.delete(k); });
          }
          // 主动预缓存文本类响应体(CDP 缓存窗口极短, reload/稍后即失效; 预缓存保证 /network/response 可读)
          // 注意: getResponseBody 需在 loadingFinished 之后才稳定可用, 这里仅记录元数据, 抓取交给 loadingFinished
          break;
        }
        case 'Network.loadingFinished': {
          // 加载完成后再抓 body(此时 CDP 才保证可读); 失败时 600ms 后重试一次(大文件/流式响应时序)
          const meta = this.cdp.netResponses.get(`${tabId}:${params.requestId}`);
          if (meta) this.prefetchResponseBody(tabId, params.requestId, meta);
          break;
        }
        case 'Page.javascriptDialogOpening': {
          if (!this.dialogLogs.has(tabId)) this.dialogLogs.set(tabId, []);
          const entry = {
            message: String(params.message || '').slice(0, 300),
            type: params.type,
            url: params.url,
            timestamp: Date.now()
          };
          this.dialogLogs.get(tabId).push(entry);
          if (this.dialogLogs.get(tabId).length > 50) this.dialogLogs.get(tabId).splice(0, this.dialogLogs.get(tabId).length - 50);
          // 事件驱动自动应答: 同步关闭弹窗, 解除渲染主线程阻塞, 挂起的 Input/evaluate 命令自然恢复
          // 策略按 tabId 隔离: 每个标签页独立 autoAccept(多 agent 并行时互不影响)
          const policy = this.getDialogPolicy(tabId);
          if (policy.autoAccept) {
            this.cdp.send(tabId, 'Page.handleJavaScriptDialog', {
              accept: true,
              ...(policy.promptText != null ? { promptText: policy.promptText } : {})
            }).then(() => { entry.handled = 'auto'; }).catch(() => { entry.handled = 'pending'; });
          } else {
            entry.handled = 'pending';
            // 手动模式安全回退: 弹窗挂起超过 60s(agent 失联/忘记应答)自动应答并恢复 autoAccept,
            // 避免模态弹窗无限阻塞用户页面(渲染线程卡死)
            entry._fallbackTimer = setTimeout(() => {
              const logs2 = this.dialogLogs.get(tabId) || [];
              const cur = logs2.find(l => l === entry);
              if (cur && cur.handled === 'pending') {
                this.cdp.send(tabId, 'Page.handleJavaScriptDialog', { accept: true })
                  .then(() => {
                    cur.handled = 'auto-fallback';
                    const p2 = this.getDialogPolicy(tabId);
                    p2.autoAccept = true;
                    this._dialogPolicies = this._dialogPolicies || new Map();
                    this._dialogPolicies.set(tabId, { autoAccept: true, promptText: p2.promptText });
                    console.log(`[ArkWeb] 手动弹窗 60s 超时自动回退(tab=${tabId}): 已应答并恢复自动模式`);
                  }).catch(() => { /* 弹窗已被其他方式关闭 */ });
              }
            }, 60000);
            entry._fallbackTimer.unref?.();
          }
          break;
        }
        case 'Page.javascriptDialogClosed': {
          const logs = this.dialogLogs.get(tabId);
          // 关闭事件对应最近一条"未标记关闭"的记录(手动应答/自动应答后都可能触发)
          if (logs && logs.length) {
            for (let i = logs.length - 1; i >= 0; i--) {
              const l = logs[i];
              if (l.handled === undefined || l.handled === 'pending') {
                l.handled = 'closed';
                if (l._fallbackTimer) { clearTimeout(l._fallbackTimer); l._fallbackTimer = null; }
                break;
              }
            }
          }
          break;
        }
        case 'Page.loadEventFired': {
          // 事件驱动重注入: 导航后确保 geo/locale mock 等注入脚本生效(addScriptToEvaluateOnNewDocument 可能不执行)
          const geoCfg = this._geoConfigs?.get(tabId);
          if (geoCfg) {
            this.runInPage(tabId, this._geoInjectFn, [geoCfg.latitude, geoCfg.longitude, geoCfg.accuracy]).catch(() => {});
          }
          const localeCfg2 = this._localeConfigs?.get(tabId);
          if (localeCfg2) {
            this.runInPage(tabId, this._localeInjectFn, [localeCfg2.locale]).catch(() => {});
          }
          break;
        }
      }
    } catch (e) {
      console.error('[ArkWeb] CDP 事件处理错误:', e);
    }
  }

  /** console 日志节流转发: 每个 tab 每 300ms 批量发送一次, 减少 WS 消息数 */
  forwardConsole(tabId) {
    if (this.consoleFlushTimers.has(tabId)) return;
    this.consoleFlushTimers.set(tabId, setTimeout(() => {
      this.consoleFlushTimers.delete(tabId);
      const logs = this.consoleLogs.get(tabId) || [];
      if (logs.length && this.connected) {
        this.send({ type: 'console-log', data: { tabId, log: logs.slice(-20) } });
      }
    }, 300));
  }

  // ============ 浏览器级 ============

  async attachAllTabs() {
    const tabs = await chrome.tabs.query({});
    // 用户授权(popup 点击)后重置限速标记
    this.cdp.throttled = false;
    const results = [];
    for (const tab of tabs) {
      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
        results.push({ tabId: tab.id, url: tab.url, attached: false, reason: 'unsupported page' });
        continue;
      }
      try {
        await this.cdp.attach(tab.id);
        await this.cdp.enableCore(tab.id);
        results.push({ tabId: tab.id, url: tab.url, attached: true });
      } catch (e) {
        results.push({ tabId: tab.id, url: tab.url, attached: false, reason: e.message });
      }
    }
    return { success: true, total: tabs.length, attached: results.filter(r => r.attached).length, results };
  }

  async getBrowserInfo() {
    const manifest = chrome.runtime.getManifest();
    return {
      extension: manifest.version,
      chromeVersion: navigator.userAgent,
      cdpAttachedTabs: [...this.cdp.attachedTabs],
      connected: this.connected,
      netResponses: this.cdp.netResponses?.size || 0,
      bodyCache: this.bodyCache?.size || 0
    };
  }

  async getStatus() {
    return {
      connected: this.connected,
      pluginConnected: this.connected,
      cdp: {
        attachedTabs: [...this.cdp.attachedTabs],
        failedTabs: [...this.cdp.failedTabs]
      },
      networkLogs: [...this.networkLogs.values()].reduce((s, l) => s + l.length, 0),
      consoleLogs: [...this.consoleLogs.values()].reduce((s, l) => s + l.length, 0)
    };
  }

  // ============ popup 消息 ============

  async handleMessage(message, sender, sendResponse) {
    const { type, data } = message;
    try {
      const tabId = data?.tabId || (await this.activeTabId());
      switch (type) {
        case 'get-status': sendResponse(await this.getStatus()); break;
        case 'get-tabs': sendResponse(await this.getTabs()); break;
        case 'get-page-info': sendResponse(await this.getPageInfo(tabId)); break;
        case 'get-dom': sendResponse(await this.getDOM(tabId)); break;
        case 'get-performance': sendResponse(await this.getPerformance(tabId)); break;
        case 'get-web-vitals': sendResponse(await this.getWebVitals(tabId)); break;
        case 'get-cookies': sendResponse(await this.getCookies(tabId)); break;
        case 'get-local-storage': sendResponse(await this.getStorage(tabId, { type: 'local' })); break;
        case 'get-console-logs': sendResponse(await this.getConsoleLogs(tabId, data || {})); break;
        case 'clear-console-logs': sendResponse(this.clearConsoleLogs()); break;
        case 'get-network-logs': sendResponse(this.getNetworkLogs(tabId, data || {})); break;
        case 'clear-network-logs': sendResponse(this.clearNetworkLogs()); break;
        case 'security-check': sendResponse(await this.securityCheck(tabId)); break;
        case 'a11y-check': sendResponse(await this.a11yCheck(tabId)); break;
        case 'seo-check': sendResponse(await this.seoCheck(tabId)); break;
        case 'screenshot': sendResponse(await this.screenshot(tabId, data || {})); break;
        case 'simulate-device': sendResponse(await this.simulateDevice(tabId, data || {})); break;
        case 'clear-device': sendResponse(await this.clearDevice(tabId)); break;
        case 'emulate-media': sendResponse(await this.emulateMedia(tabId, data || {})); break;
        case 'evaluate': sendResponse(await this.evaluateJS(tabId, data || {})); break;
        case 'highlight-elements': sendResponse(await this.highlight(tabId, data || {})); break;
        case 'clear-highlights': sendResponse(await this.clearHighlight(tabId)); break;
        case 'set-cookie': sendResponse(await this.setCookie(data || {})); break;
        case 'cdp-attach-all': sendResponse(await this.attachAllTabs()); break;
        case 'cdp-detach-all': sendResponse(await this.cdp.detachAll().then(() => ({ success: true }))); break;
        // 连接配置(popup 修改 WS 主机/端口/令牌)
        case 'get-config': sendResponse(await this.loadWsConfig()); break;
        case 'set-config': sendResponse(await this.saveWsConfig(data || {})); break;
        case 'content-script-loaded': sendResponse({ ok: true }); break;
        default: sendResponse({ error: `Unknown message type: ${type}` });
      }
    } catch (e) {
      sendResponse({ error: e.message });
    }
  }

  async notifyPopup(message) {
    try { await chrome.runtime.sendMessage(message); } catch {}
  }
}

// ============ 工具 ============

function safeSerialize(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (k, v) => {
    if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (typeof v === 'bigint') return `[BigInt ${v}]`;
    if (typeof v === 'undefined') return '[undefined]';
    if (typeof v === 'symbol') return '[Symbol]';
    if (v instanceof Error) return `[Error: ${v.message}]`;
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

/** Service Worker 环境没有 Node Buffer: base64 → UTF-8 文本(网络响应体解码, 修复 base64Encoded 响应静默失败) */
function b64ToText(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const bridge = new ArkWeb();
