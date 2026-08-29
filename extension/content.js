/**
 * Ark Web — Content Script
 * 在页面中运行，提供页面内调试能力
 */

(function() {
  'use strict';

  // 防止重复注入
  if (window.__arkWebLoaded) return;
  window.__arkWebLoaded = true;

  console.log('[ArkWeb] Content script loaded');

  // ============ 页面状态监控 ============

  // 监控 console 输出
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
    assert: console.assert.bind(console)
  };

  window.__browserDebugConsoleLogs = [];

  ['log', 'warn', 'error', 'info', 'debug', 'assert'].forEach(method => {
    console[method] = function(...args) {
      originalConsole[method]?.apply(console, args);
      window.__browserDebugConsoleLogs.push({
        type: method === 'assert' ? 'error' : method,
        args: args.map(a => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return String(a); }
        }),
        timestamp: Date.now()
      });
      // 上限 1000 条, 防止内存无限增长
      if (window.__browserDebugConsoleLogs.length > 1000) {
        window.__browserDebugConsoleLogs.splice(0, window.__browserDebugConsoleLogs.length - 1000);
      }
    };
  });

  // 监控错误
  window.addEventListener('error', (event) => {
    window.__browserDebugConsoleLogs.push({
      type: 'error',
      args: [event.message, event.filename, event.lineno, event.colno],
      timestamp: Date.now(),
      isError: true
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    window.__browserDebugConsoleLogs.push({
      type: 'error',
      args: [`Unhandled rejection: ${event.reason}`],
      timestamp: Date.now(),
      isError: true
    });
  });

  // ============ DOM 变化监控 ============

  window.__browserDebugDomChanges = [];
  const domObserver = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      window.__browserDebugDomChanges.push({
        type: m.type,
        added: m.addedNodes.length,
        removed: m.removedNodes.length,
        target: m.target.tagName,
        timestamp: Date.now()
      });
    });
    if (window.__browserDebugDomChanges.length > 2000) {
      window.__browserDebugDomChanges.splice(0, window.__browserDebugDomChanges.length - 2000);
    }
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true
  });

  // ============ Storage 变化监控 ============

  window.__browserDebugStorageChanges = [];
  window.addEventListener('storage', (event) => {
    window.__browserDebugStorageChanges.push({
      key: event.key,
      oldValue: event.oldValue,
      newValue: event.newValue,
      url: event.url,
      storageArea: event.storageArea === localStorage ? 'localStorage' : 'sessionStorage',
      timestamp: Date.now()
    });
    if (window.__browserDebugStorageChanges.length > 500) {
      window.__browserDebugStorageChanges.splice(0, window.__browserDebugStorageChanges.length - 500);
    }
  });

  // ============ 网络请求拦截 ============

  // 拦截 fetch
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const startTime = performance.now();
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

    return originalFetch.apply(this, args).then(response => {
      const duration = performance.now() - startTime;
      window.__browserDebugConsoleLogs.push({
        type: 'network',
        args: ['fetch', url, response.status, `${Math.round(duration)}ms`],
        timestamp: Date.now()
      });
      return response;
    });
  };

  // 拦截 XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__browserDebugUrl = url;
    this.__browserDebugMethod = method;
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const startTime = performance.now();
    const xhr = this;

    xhr.addEventListener('load', () => {
      const duration = performance.now() - startTime;
      window.__browserDebugConsoleLogs.push({
        type: 'network',
        args: ['xhr', xhr.__browserDebugMethod, xhr.__browserDebugUrl, xhr.status, `${Math.round(duration)}ms`],
        timestamp: Date.now()
      });
    });

    return originalXHRSend.apply(this, arguments);
  };

  // ============ Performance 监控 ============

  window.__browserDebugPerformance = {
    getMetrics: () => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = performance.getEntriesByType('paint');
      const resources = performance.getEntriesByType('resource');

      return {
        navigation: nav ? {
          ttfb: Math.round(nav.responseStart),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
          loadComplete: Math.round(nav.loadEventEnd)
        } : null,
        paint: paint.map(p => ({ name: p.name, time: Math.round(p.startTime) })),
        resources: resources.length,
        memory: performance.memory ? {
          used: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
          total: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024)
        } : null
      };
    }
  };

  // ============ 消息监听 ============

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, data } = message;

    switch (type) {
      case 'get-console-logs':
        sendResponse(window.__browserDebugConsoleLogs || []);
        break;

      case 'clear-console-logs':
        window.__browserDebugConsoleLogs = [];
        sendResponse({ success: true });
        break;

      case 'get-dom-changes':
        sendResponse(window.__browserDebugDomChanges || []);
        break;

      case 'clear-dom-changes':
        window.__browserDebugDomChanges = [];
        sendResponse({ success: true });
        break;

      case 'get-storage-changes':
        sendResponse(window.__browserDebugStorageChanges || []);
        break;

      case 'clear-storage-changes':
        window.__browserDebugStorageChanges = [];
        sendResponse({ success: true });
        break;

      case 'evaluate':
        try {
          const result = eval(data.code);
          sendResponse({ success: true, result: JSON.stringify(result) });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      case 'get-performance':
        sendResponse(window.__browserDebugPerformance.getMetrics());
        break;

      case 'highlight-elements':
        const elements = document.querySelectorAll(data.selector);
        elements.forEach((el, i) => {
          const rect = el.getBoundingClientRect();
          const overlay = document.createElement('div');
          overlay.className = 'ark-web-highlight';
          overlay.style.cssText = `
            position: fixed;
            left: ${rect.x}px;
            top: ${rect.y}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            border: 2px solid ${data.color || '#ff0000'};
            background: ${data.color || '#ff0000'}22;
            z-index: 2147483647;
            pointer-events: none;
          `;
          const tag = document.createElement('div');
          tag.style.cssText = `
            position: absolute;
            top: -20px;
            left: 0;
            background: ${data.color || '#ff0000'};
            color: white;
            padding: 1px 6px;
            font-size: 11px;
            font-family: monospace;
          `;
          tag.textContent = `#${i + 1}`;
          overlay.appendChild(tag);
          document.body.appendChild(overlay);
        });
        sendResponse({ success: true, count: elements.length });
        break;

      case 'clear-highlights':
        document.querySelectorAll('.ark-web-highlight').forEach(el => el.remove());
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: `Unknown content script message: ${type}` });
    }

    return true;
  });

  // ============ 通知 background 已加载 ============

  chrome.runtime.sendMessage({ type: 'content-script-loaded', url: location.href });

  // ============ SW 保活: keepalive 长连接端口(仅顶层 frame, 避免重复) ============
  // 只要任意标签页打开, 端口即保持 SW 活跃; 配合 background 的 alarms 周期唤醒兜底
  if (window === window.top) {
    let keepalivePort = null;
    const connectKeepalive = () => {
      try {
        keepalivePort = chrome.runtime.connect({ name: 'ark-web-keepalive' });
        keepalivePort.postMessage({ type: 'ping' });
        keepalivePort.onDisconnect.addListener(() => {
          // SW 休眠/插件重载后端口断开, 稍后重连
          setTimeout(connectKeepalive, 3000);
        });
      } catch { /* ignore */ }
    };
    connectKeepalive();
    // 定期 ping, 保持端口活跃
    setInterval(() => {
      if (keepalivePort) {
        try { keepalivePort.postMessage({ type: 'ping' }); } catch { /* ignore */ }
      }
    }, 25000);
  }

  console.log('[ArkWeb] Content script 初始化完成');
})();
