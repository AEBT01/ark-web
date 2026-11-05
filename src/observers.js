/**
 * CDP 事件观察者
 *
 * 把控制台、网络、WebSocket 帧、JS 弹窗统一收在一处。
 * 注意：这些缓冲都在 service worker 内存里，SW 被回收即丢——
 * 所以对外一律用「本次会话内可见」来描述，不承诺跨回收持久化。
 */

import { cdp } from './cdp.js';

export const consoleBuf = new Map(); // tabId -> [{level,text,at}]
export const netBuf = new Map();     // tabId -> Map(requestId -> entry)
export const wsBuf = new Map();      // tabId -> [{dir,op,payload,at}]
export const inflight = new Map();   // tabId -> Set(requestId)，按请求 id 去重，重定向不会重复计数
export const dialogPolicy = new Map();
export const dialogLog = new Map();

const CONSOLE_MAX = 800;
const NET_MAX = 800;
const WS_MAX = 200;
const DIALOG_MAX = 80;

// ── Fetch 拦截 ─────────────────────────────────────────────────────────────
export const fetchRules = [];
const intercepting = new Set();

export function interceptOn(tabId) { return intercepting.has(tabId); }

export async function setIntercept(tabId, on) {
  if (on) {
    await cdp(tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    intercepting.add(tabId);
  } else {
    try { await cdp(tabId, 'Fetch.disable'); } catch { /* 已关闭 */ }
    intercepting.delete(tabId);
  }
  return { intercepting: intercepting.has(tabId) };
}

function matchRule(rule, url) {
  if (!rule) return false;
  if (rule.method && rule.method !== '*') {
    // method 在 requestPaused 里判断，这里只看 URL
  }
  if (!rule.pattern) return true;
  try {
    if (rule.regex) return new RegExp(rule.pattern).test(url);
    return url.includes(rule.pattern);
  } catch { return false; }
}

function b64(s) {
  try { return btoa(unescape(encodeURIComponent(s))); } catch { return ''; }
}

// ── 缓冲工具 ───────────────────────────────────────────────────────────────
const bufOf = (map, tabId) => {
  if (!map.has(tabId)) map.set(tabId, []);
  return map.get(tabId);
};
const netOf = (tabId) => {
  if (!netBuf.has(tabId)) netBuf.set(tabId, new Map());
  return netBuf.get(tabId);
};
const activeSet = (tabId) => {
  if (!inflight.has(tabId)) inflight.set(tabId, new Set());
  return inflight.get(tabId);
};
const trimNet = (tabId) => {
  const m = netOf(tabId);
  if (m.size <= NET_MAX) return;
  const extra = m.size - NET_MAX;
  const active = activeSet(tabId);
  let i = 0;
  for (const [k, e] of m) {
    if (i++ >= extra) break;
    if (!e.finished && !e.failed) active.delete(k);
    m.delete(k);
  }
  if (active.size === 0) inflight.delete(tabId);
};
export const inflightOf = (tabId) => (inflight.get(tabId) || new Set()).size;
export const dialogLogOf = (tabId) => bufOf(dialogLog, tabId);

// ── 跨 SW 回收的持久化 ─────────────────────────────────────────────────────
// service worker 空闲会被回收，网络/控制台历史随之消失；AI 常用的顺序恰恰是
// 「先操作、后查日志」，一丢就等于白干。这里把最近 200 条落 storage.session，
// SW 重启后接回来（同一浏览器会话内有效，关浏览器清空）。
const PERSIST_KEY = (tabId) => `ark:obs:${tabId}`;
const PERSIST_MAX = 200;
const persistTimers = new Map();
const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

/** 落盘前移除凭据类头；内存里仍保留完整数据供 net-har 本次会话使用 */
function forDisk(e) {
  const o = { ...e };
  if (o.headers) {
    o.headers = Object.fromEntries(Object.entries(o.headers).filter(([k]) => !SENSITIVE_HEADER.test(k)));
  }
  if (o.resHeaders) {
    o.resHeaders = Object.fromEntries(Object.entries(o.resHeaders).filter(([k]) => !SENSITIVE_HEADER.test(k)));
  }
  return o;
}

function schedulePersist(tabId) {
  if (persistTimers.has(tabId)) return;
  persistTimers.set(tabId, setTimeout(async () => {
    persistTimers.delete(tabId);
    try {
      const net = [...netOf(tabId).values()].slice(-PERSIST_MAX).map(forDisk);
      const con = (consoleBuf.get(tabId) || []).slice(-PERSIST_MAX);
      await chrome.storage.session.set({ [PERSIST_KEY(tabId)]: { net, con, at: Date.now() } });
    } catch { /* 配额或权限问题不影响主流程 */ }
  }, 1200));
}

/** SW 重启后接回历史：net 与 console 各自独立恢复，互不被对方的“有新数据”阻塞 */
export async function hydrateObservers(tabId) {
  const hasNet = (netBuf.get(tabId) || new Map()).size > 0;
  const hasCon = (consoleBuf.get(tabId) || []).length > 0;
  if (hasNet && hasCon) return;
  try {
    const got = await chrome.storage.session.get(PERSIST_KEY(tabId));
    const d = got[PERSIST_KEY(tabId)];
    if (!d || !d.at || Date.now() - d.at > 30 * 60 * 1000) return;   // 超过 30 分钟的历史不再接
    if (!hasNet && Array.isArray(d.net) && d.net.length) {
      const m = netOf(tabId);
      for (const e of d.net) if (e && e.requestId) m.set(e.requestId, e);
    }
    if (!hasCon && Array.isArray(d.con) && d.con.length) consoleBuf.set(tabId, d.con);
  } catch { /* 忽略 */ }
}

// ── 事件安装 ───────────────────────────────────────────────────────────────
export function installObservers() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;

    // 控制台
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || []).map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return a.type || '?';
      }).join(' ');
      const b = bufOf(consoleBuf, tabId);
      b.push({ level: params.type || 'log', text: text.slice(0, 2000), at: Date.now() });
      if (b.length > CONSOLE_MAX) b.splice(0, b.length - CONSOLE_MAX);
      schedulePersist(tabId);
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      const b = bufOf(consoleBuf, tabId);
      b.push({
        level: 'exception',
        text: String(d.exception && d.exception.description || d.text || 'unknown').slice(0, 2000),
        at: Date.now()
      });
      if (b.length > CONSOLE_MAX) b.splice(0, b.length - CONSOLE_MAX);
      return;
    }

    // 网络
    if (method === 'Network.requestWillBeSent') {
      const m = netOf(tabId);
      const active = activeSet(tabId);
      // 重定向复用 requestId：只保留一个在途标记，不重复 +1
      const existed = m.has(params.requestId);
      active.add(params.requestId);
      m.set(params.requestId, {
        requestId: params.requestId,
        url: (params.request && params.request.url) || '',
        method: (params.request && params.request.method) || 'GET',
        type: params.type || 'Other',
        headers: (params.request && params.request.headers) || {},
        postData: String((params.request && params.request.postData) || '').slice(0, 2000) || null,
        startTs: existed ? (m.get(params.requestId) || {}).startTs : params.timestamp,
        startedAt: existed ? (m.get(params.requestId) || {}).startedAt : Date.now(),
        status: null, mime: '', size: 0, ms: null, failed: null, fromCache: false
      });
      trimNet(tabId);
      schedulePersist(tabId);
      return;
    }
    if (method === 'Network.responseReceived') {
      const e = netOf(tabId).get(params.requestId);
      if (e) {
        e.status = (params.response && params.response.status) || null;
        e.mime = (params.response && params.response.mimeType) || '';
        e.fromCache = !!(params.response && (params.response.fromDiskCache || params.response.fromServiceWorker));
        if (params.response && params.response.headers) e.resHeaders = params.response.headers;
        e.resourceType = params.type || e.type;
      }
      return;
    }
    if (method === 'Network.loadingFinished') {
      const e = netOf(tabId).get(params.requestId);
      const active = activeSet(tabId);
      active.delete(params.requestId);
      if (active.size === 0) inflight.delete(tabId);
      if (e) {
        e.size = params.encodedDataLength || 0;
        e.ms = e.startTs != null && params.timestamp != null ? Math.round((params.timestamp - e.startTs) * 1000) : Date.now() - e.startedAt;
        e.finished = true;
        schedulePersist(tabId);
      }
      return;
    }
    if (method === 'Network.loadingFailed') {
      const e = netOf(tabId).get(params.requestId);
      const active = activeSet(tabId);
      active.delete(params.requestId);
      if (active.size === 0) inflight.delete(tabId);
      if (e) {
        e.failed = params.errorText || 'failed';
        e.ms = e.startTs != null && params.timestamp != null ? Math.round((params.timestamp - e.startTs) * 1000) : Date.now() - e.startedAt;
        schedulePersist(tabId);
      }
      return;
    }
    if (method === 'Network.webSocketCreated') {
      const b = bufOf(wsBuf, tabId);
      b.push({ dir: 'open', url: params.url, at: Date.now() });
      if (b.length > WS_MAX) b.splice(0, b.length - WS_MAX);
      return;
    }
    if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const b = bufOf(wsBuf, tabId);
      b.push({
        dir: method.endsWith('Sent') ? 'send' : 'recv',
        op: (params.response && params.response.opcode) || 1,
        payload: String((params.response && params.response.payloadData) || '').slice(0, 2000),
        at: Date.now()
      });
      if (b.length > WS_MAX) b.splice(0, b.length - WS_MAX);
      return;
    }

    // JS 弹窗
    if (method === 'Page.javascriptDialogOpening') {
      const policy = dialogPolicy.get(tabId) || 'manual';
      const lg = dialogLogOf(tabId);
      lg.push({ type: params.type, message: (params.message || '').slice(0, 500), at: Date.now(), action: policy });
      if (lg.length > DIALOG_MAX) lg.splice(0, lg.length - DIALOG_MAX);
      if (policy === 'accept' || policy === 'dismiss') {
        cdp(tabId, 'Page.handleJavaScriptDialog', {
          accept: policy === 'accept',
          ...(params.type === 'prompt' ? { promptText: params.defaultPrompt || '' } : {})
        }).catch(() => {});
      }
      return;
    }

    // Fetch 拦截
    if (method === 'Fetch.requestPaused') {
      const url = (params.request && params.request.url) || '';
      const rule = fetchRules.find((r) => matchRule(r, url) && (!r.method || r.method === '*' || r.method === (params.request && params.request.method)));
      const reqId = params.requestId;
      const resume = () => cdp(tabId, 'Fetch.continueRequest', { requestId: reqId }).catch(() => {});
      if (!rule) { resume(); return; }
      if (rule.action === 'abort') {
        cdp(tabId, 'Fetch.failRequest', { requestId: reqId, errorReason: rule.errorReason || 'aborted' })
          .catch(resume);
        return;
      }
      if (rule.action === 'mock') {
        const headers = Object.entries(rule.headers || { 'content-type': 'application/json' })
          .map(([name, value]) => ({ name, value: String(value) }));
        const body = typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body == null ? '' : rule.body);
        cdp(tabId, 'Fetch.fulfillRequest', {
          requestId: reqId,
          responseCode: Number(rule.status) || 200,
          responseHeaders: headers,
          body: b64(body)
        }).catch(resume);
        return;
      }
      if (rule.action === 'header') {
        const headers = Object.entries(rule.headers || {}).map(([name, value]) => ({ name, value: String(value) }));
        cdp(tabId, 'Fetch.continueRequest', { requestId: reqId, headers }).catch(resume);
        return;
      }
      if (rule.action === 'delay') {
        setTimeout(() => { resume(); }, Math.max(0, Number(rule.delayMs || 1000)));
        return;
      }
      resume();
    }
  });

  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) intercepting.delete(source.tabId);
  });
}

/** 页面被关闭 / 导航时清掉该 tab 的所有缓冲 */
export function clearTab(tabId) {
  consoleBuf.delete(tabId);
  netBuf.delete(tabId);
  wsBuf.delete(tabId);
  inflight.delete(tabId);
  dialogPolicy.delete(tabId);
  dialogLog.delete(tabId);
  intercepting.delete(tabId);
  const timer = persistTimers.get(tabId);
  if (timer) { clearTimeout(timer); persistTimers.delete(tabId); }
  try { chrome.storage.session.remove(PERSIST_KEY(tabId)); } catch { /* 忽略 */ }
}
