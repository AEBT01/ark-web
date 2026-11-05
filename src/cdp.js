/**
 * CDP 会话管理
 *
 * 把「挂调试器 + 开常用域」收敛到一处。任何需要 CDP 的能力都从这里取会话，
 * 避免各处重复 attach 造成重复开域或状态不一致。
 */

const attached = new Set();
const attaching = new Map();

export const attachedTabs = () => attached;
export const isAttached = (tabId) => attached.has(tabId);

export async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);

  const p = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      const msg = String(e && e.message || e);
      const err = new Error(`无法附加调试器：${msg}`);
      if (/another debugger|already attached|另一个调试器/i.test(msg)) {
        err.code = 'E_DEBUGGER';
        err.hint = '该标签页已被 DevTools 或其它扩展占用。关闭 DevTools / 点掉“正在调试”提示条后重试';
      } else {
        err.code = 'E_ATTACH';
        err.hint = '确认标签页仍然存在；chrome:// 等特权页不可附加；必要时重载扩展';
      }
      throw err;
    }
    attached.add(tabId);
    // 挂载即开域：避免「调用时才开」丢掉挂载之前的请求/日志
    for (const m of ['Network.enable', 'Page.enable', 'Performance.enable', 'Runtime.enable']) {
      try { await chrome.debugger.sendCommand({ tabId }, m, {}); } catch { /* 特权页可能不支持某些域 */ }
    }
  })();

  attaching.set(tabId, p);
  try { await p; } finally { attaching.delete(tabId); }
}

export async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/** 开额外域（Dom / Overlay 等），失败不抛 */
export async function enableDomains(tabId, domains = []) {
  await ensureAttached(tabId);
  for (const m of domains) {
    try { await chrome.debugger.sendCommand({ tabId }, m, {}); } catch { /* 忽略 */ }
  }
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* 可能已被浏览器断开 */ }
}

export function forget(tabId) {
  attached.delete(tabId);
  attaching.delete(tabId);
  focusEmulated.delete(tabId);
  deviceMetrics.delete(tabId);
}

// 调试器被浏览器/用户断开时，必须同步清理本地状态。
// 否则 ensureAttached 会误以为还挂着，后面所有 CDP 命令都报 "Debugger is not attached"。
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) {
    attached.delete(source.tabId);
    focusEmulated.delete(source.tabId);
  }
});

// 记录用户通过 emulate 设置的设备覆盖，截图时不要误清掉它
const deviceMetrics = new Map();
export function rememberDeviceMetrics(tabId, params) {
  if (params) deviceMetrics.set(tabId, params);
  else deviceMetrics.delete(tabId);
}
export function getDeviceMetrics(tabId) {
  return deviceMetrics.get(tabId) || null;
}

// ── 焦点仿真 ───────────────────────────────────────────────────────────────
// 浏览器窗口被遮挡/最小化时，Chrome 把页面标成 visibilityState=hidden，
// 于是：CDP 的输入事件被丢弃（点了没反应）、截图拿不到新帧、rAF 被节流。
// 用 Emulation.setFocusEmulationEnabled 让页面「相信」自己是可见且聚焦的。
// 只在检测到 hidden 时启用，避免不必要地改变页面行为。
const focusEmulated = new Set();

export async function ensureFocusEmulation(tabId) {
  if (focusEmulated.has(tabId)) return true;
  let vis = null;
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.visibilityState });
    vis = r && r[0] ? r[0].result : null;
  } catch { return false; }
  if (vis !== 'hidden') return false;
  try {
    await ensureAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    focusEmulated.add(tabId);
    return true;
  } catch { return false; }
}
