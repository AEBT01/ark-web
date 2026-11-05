/**
 * Ark Web Bridge — MV3 service worker（v5.0）
 *
 * 这一层只做三件事：维持与本地桥接的 WebSocket、把命令转给命令层、处理自更新。
 * 所有业务逻辑都在 src/ 下：
 *   src/commands.js   命令语义与错误码
 *   src/frames.js     跨 frame 编排与 ref 分配
 *   src/page-agent.js 注入页面的代理（采集/定位/动作/断言）
 *   src/refs.js       ref 注册表与指纹
 *   src/input.js      CDP 真实输入
 *   src/capture.js    截图
 *   src/observers.js  控制台/网络/WS/弹窗/拦截
 *   src/cdp.js        调试器会话
 */

import { dispatch, isRetryable, queueKeyFor, forgetTabState } from './src/commands.js';
import { installObservers, clearTab } from './src/observers.js';
import { forget } from './src/cdp.js';
import { reset as resetRefs } from './src/refs.js';
import { resetInjection } from './src/frames.js';

const BRIDGE_URL = 'ws://127.0.0.1:9333/ext';
const VERSION_URL = 'http://127.0.0.1:9333/ext/version';
const SECRET_URL = chrome.runtime.getURL('ark-ws-secret.txt');
const RECONNECT_MIN = 800;
const RECONNECT_MAX = 15000;
const POLL_MS = 8000;
const RELOAD_GUARD_MS = 120000;
const RELOAD_MAX_IN_WINDOW = 3;

let socket = null;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let connecting = false;
let wsSecret = null;

async function getWsSecret() {
  if (wsSecret) return wsSecret;
  try {
    const r = await fetch(SECRET_URL, { cache: 'no-store' });
    if (r.ok) {
      const t = (await r.text()).trim();
      if (t.length >= 32) wsSecret = t;
    }
  } catch { /* bridge 未启动或文件未生成，稍后重连再试 */ }
  return wsSecret;
}

function log(...a) { console.log('[ark-web]', ...a); }

// ── 同标签页串行化 ─────────────────────────────────────────────────────────
// 并发命令会竞争 ref 注册表、观察者缓冲与输入焦点（例如 click 与 snapshot 同时跑），
// 这里按 tabId 排队；不带 tab 的命令（status/tabs/open）保持并行。
const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

// ── 连接 ───────────────────────────────────────────────────────────────────
async function connect() {
  // 单飞：已有 OPEN / CONNECTING 的连接就不再新建。
  // 缺这个守卫时，每条旧连接 onclose 都会再开一条，形成指数级重连风暴（实测 20 秒堆到 233 条）。
  if (connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  connecting = true;
  const secret = await getWsSecret();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    connecting = false;
    return;
  }

  let ws;
  try { ws = new WebSocket(BRIDGE_URL); } catch { connecting = false; scheduleReconnect(); return; }
  socket = ws;
  connecting = false;

  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN;
    log('已连接 bridge');
    send({
      type: 'hello',
      name: 'Ark Web Bridge',
      version: chrome.runtime.getManifest().version,
      extId: chrome.runtime.id,
      ua: navigator.userAgent,
      secret: secret || ''
    });
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'reload') {
      log(`收到重载指令 hash=${msg.hash} 原因=${msg.reason || '-'}`);
      await safeReload(msg.hash, msg.reason || 'push');
      return;
    }
    if (msg.type === 'welcome') {
      await rememberHash(msg.hash);
      log(`已同步版本指纹 ${msg.hash}`);
      return;
    }
    if (msg.type === 'reject') {
      log(`被桥接拒绝：${msg.reason} ${msg.hint || ''}`);
      if (msg.reason === 'bad-secret') wsSecret = null; // 服务端密钥可能是新建的，下次重连重新读取
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      return;
    }
    if (!msg || !msg.id) return;

    const run = async () => {
      const t0 = Date.now();
      try {
        const data = await dispatch(msg.cmd, msg.args || {});
        send({ id: msg.id, ok: true, data, elapsedMs: Date.now() - t0 });
      } catch (e) {
        // code / hint / retryable 必须一起回传：否则 AI 只看到一句话，没法知道该怎么改
        const code = (e && e.code) || null;
        send({
          id: msg.id, ok: false,
          error: String((e && e.message) || e),
          code,
          hint: (e && e.hint) || null,
          retryable: typeof (e && e.retryable) === 'boolean' ? e.retryable : isRetryable(code),
          elapsedMs: Date.now() - t0
        });
      }
    };
    const tabKey = await queueKeyFor(msg.args || {}).catch(() => 'global');
    serialize(tabKey, run);
  };

  // 只有「当前这条」关闭才重连。被替换掉的旧连接关闭时什么都不做。
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    log('连接断开');
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose 会跟着触发 */ };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

// ── 生命周期清理 ───────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  forget(tabId);
  clearTab(tabId);
  resetRefs(tabId);
  forgetTabState(tabId);
  queues.delete(`tab:${tabId}`);
});

// 导航会让所有 ref 失效：在 loading 阶段就清掉，避免拿旧编号点新页面
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    resetRefs(tabId);
    resetInjection(tabId);
    forgetTabState(tabId);
  }
});

// ── 自更新热重载 ───────────────────────────────────────────────────────────
async function rememberHash(hash) {
  if (!hash) return;
  await chrome.storage.local.set({ arkHash: hash, arkHashAt: Date.now() });
}

async function safeReload(hash, reason) {
  const { arkReloadTimes = [] } = await chrome.storage.local.get('arkReloadTimes');
  const now = Date.now();
  const recent = arkReloadTimes.filter((t) => now - t < RELOAD_GUARD_MS);
  // 护栏只拦「文件监听风暴」这类自动触发；手动/CLI 显式重载一律放行，
  // 否则改完代码连着验证几次就会被自己的护栏锁住，排查起来极其费时。
  if (recent.length >= RELOAD_MAX_IN_WINDOW && reason !== 'manual') {
    log('重载过于频繁，已暂停自动重载；多半是 manifest 权限变更，需手动重新加载');
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }
  recent.push(now);
  await chrome.storage.local.set({ arkReloadTimes: recent, arkHash: hash || '' });
  log('执行热重载…');
  setTimeout(() => chrome.runtime.reload(), 120);
}

async function pollVersion() {
  try {
    const res = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    const { arkHash } = await chrome.storage.local.get('arkHash');
    if (j.hash && arkHash && j.hash !== arkHash) {
      log(`检测到代码变更 ${arkHash} → ${j.hash}`);
      await safeReload(j.hash);
    } else if (j.hash && !arkHash) {
      await rememberHash(j.hash);
    }
  } catch { /* 桥接没起，忽略 */ }
}

// ── 启动 ───────────────────────────────────────────────────────────────────
installObservers();
connect();

setInterval(pollVersion, POLL_MS);

chrome.alarms?.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((a) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) connect();
  if (a && a.name === 'keepalive') pollVersion();
});
