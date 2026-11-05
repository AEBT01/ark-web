/**
 * 新标签追踪
 *
 * 点击 target=_blank 链接、window.open、表单 target 都会开新标签。
 * 过去的实现只认「open 创建的标签」，于是点完之后 AI 以为还在原页面，
 * 后续操作全打在旧标签上。这里在动作前埋一个监听，动作后立刻知道新标签是谁。
 */

const watchers = new Set();

chrome.tabs.onCreated.addListener((tab) => {
  for (const w of watchers) {
    if (w.done) continue;
    if (w.opener != null && tab.openerTabId !== w.opener) continue;
    w.done = true;
    w.resolve(tab);
  }
});

/**
 * 在动作前调用。返回 Promise<tab|null>。
 * 若 opener 为 null，则接受任意新标签（用于无法确定 opener 的场景）。
 */
export function watchNewTab(openerTabId, ms = 1800) {
  const w = { opener: openerTabId == null ? null : openerTabId, resolve: null, done: false, timer: null };
  const p = new Promise((resolve) => {
    w.resolve = (tab) => {
      watchers.delete(w);
      if (w.timer) clearTimeout(w.timer);
      resolve(tab || null);
    };
    watchers.add(w);
    w.timer = setTimeout(() => { if (!w.done) { w.done = true; w.resolve(null); } }, ms);
  });
  return { promise: p, cancel: () => { w.done = true; watchers.delete(w); if (w.timer) clearTimeout(w.timer); } };
}
