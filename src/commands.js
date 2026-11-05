/**
 * 命令实现
 *
 * 分工：
 *   frames.js  跨 frame 编排 + ref 分配
 *   refs.js    指纹与状态
 *   input.js   真实输入
 *   capture.js 截图
 *   本文件      业务语义与错误码
 *
 * 统一原则：**先验证、再动作、后确认**。任何一步拿不到证据就报错，绝不回一个假的 ok:true。
 */

import * as frames from './frames.js';
import * as refs from './refs.js';
import * as input from './input.js';
import { cdp, ensureAttached, enableDomains, forget, ensureFocusEmulation, rememberDeviceMetrics } from './cdp.js';
import { captureShot, probeViewport, imageDiff } from './capture.js';
import { STATE_AGENT } from './state-agent.js';

// 视觉回归：按「tab + 目标」记住上一张截图，--diff 时与之对比（最多 20 组，避免长驻吃内存）
const lastShot = new Map();
const MAX_SHOT_ITEMS = 20;
const MAX_SHOT_BYTES = 64 * 1024 * 1024;
let lastShotBytes = 0;
function rememberShot(key, b64) {
  const old = lastShot.get(key);
  if (old) lastShotBytes -= old.length;
  lastShot.set(key, b64);
  lastShotBytes += b64.length;
  while (lastShot.size > MAX_SHOT_ITEMS || lastShotBytes > MAX_SHOT_BYTES) {
    const firstKey = lastShot.keys().next().value;
    const first = lastShot.get(firstKey);
    lastShotBytes -= first.length;
    lastShot.delete(firstKey);
  }
}
import { watchNewTab } from './tabwatch.js';
import * as obs from './observers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按顶层分隔符切分，忽略 () [] {} 与引号内部的逗号（extract 的 :is(a,b) 等选择器） */
function splitTopLevel(text, sep = ',') {
  const out = [];
  let cur = '', depth = 0, quote = null, esc = false;
  for (const ch of String(text)) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { cur += ch; esc = true; continue; }
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { cur += ch; quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// coverage 是「开始→采集→结束」的有状态流程，按 tab 记录起点
const coverageState = new Map();

/** 标签关闭/导航时清理所有按 tab 缓存的状态，避免 diff/coverage 跨文档串味 */
export function forgetTabState(tabId) {
  lastSnap.delete(tabId);
  coverageState.delete(tabId);
  const prefix = `${tabId}|`;
  for (const key of [...lastShot.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const v = lastShot.get(key);
    lastShotBytes -= v ? v.length : 0;
    lastShot.delete(key);
  }
}

// 哪些错误「换个前置动作后重试可能成功」：调用方可据此自动恢复（activate / 重拍快照 / 关浮层），
// 而不是见到 ok:false 就整体放弃。参数类错误永远不可重试。
const RETRYABLE = new Set([
  'E_TAB_HIDDEN', 'E_OCCLUDED', 'E_TIMEOUT',
  'E_STALE_REF', 'E_UNKNOWN_REF',
  'E_NOT_VISIBLE', 'E_OFFSCREEN', 'E_COVERED',
  'E_FILL_FAILED', 'E_SELECT_FAILED', 'E_ASSERT',
  'E_EXT_DOWN', 'E_BRIDGE_DOWN'
]);
export const isRetryable = (code) => RETRYABLE.has(String(code || ''));

function fail(code, message, hint) {
  const e = new Error(message);
  e.code = code;
  e.retryable = RETRYABLE.has(code);
  if (hint) e.hint = hint;
  throw e;
}

// ── 标签页 ─────────────────────────────────────────────────────────────────
let lastTabId = null;

async function loadLastTab() {
  if (lastTabId != null) return;
  try {
    const got = await chrome.storage.session.get('ark:lastTab');
    if (typeof got['ark:lastTab'] === 'number') lastTabId = got['ark:lastTab'];
  } catch { /* 忽略 */ }
}
async function setLastTab(id) {
  lastTabId = id;
  try { await chrome.storage.session.set({ 'ark:lastTab': id }); } catch { /* 忽略 */ }
}

/**
 * 后台串行队列的 key：即使用户没写 --tab，也要按“当前默认标签”串行，
 * 否则 snapshot 与 click 会并发竞争 ref 注册表和输入焦点。
 */
export async function queueKeyFor(args = {}) {
  if (args && args.tabId != null) return `tab:${Number(args.tabId)}`;
  await loadLastTab();
  return lastTabId != null ? `tab:${lastTabId}` : 'global';
}

async function tabById(id) {
  await loadLastTab();
  if (id != null) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) fail('E_PARAM', `--tab 需要正整数，收到 "${id}"`, '先跑 tabs 看可用标签页 id');
    let tab = null;
    try { tab = await chrome.tabs.get(n); } catch { tab = null; }
    if (!tab) fail('E_NOT_FOUND', `标签页不存在：${n}`, '它可能已被关闭；跑 tabs 看当前列表');
    await setLastTab(n);
    return tab;
  }
  if (lastTabId != null) {
    try {
      const t = await chrome.tabs.get(lastTabId);
      if (t) return t;
    } catch { /* 已关闭 */ }
    lastTabId = null;
  }
  fail('E_NO_TAB', '未指定标签页，且没有可用的默认标签',
    '先 open <url>，或给命令加 --tab <id>。为避免误操作，不再默认使用你当前正在看的标签页');
}

function waitLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve(true);
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(finish);
    setTimeout(finish, timeoutMs || 30000);
  });
}

// ── 目标解析 ───────────────────────────────────────────────────────────────
async function resolveTarget(tabId, args, opts = {}) {
  if (args.ref != null) {
    const r = await frames.probeRef(tabId, args.ref, { force: args.force === true });
    if (r.drift && !opts.skipDrift) {
      fail('E_STALE_REF', `ref=${args.ref} 已失效：${r.drift}`,
        '页面在快照之后发生了变化（重渲染/列表更新）。重跑 snapshot 拿新编号；确认无误可加 --force 强制操作');
    }
    return { ref: Number(args.ref), frameId: r.entry.frameId, localRef: r.entry.localRef, info: r.info };
  }
  if (args.selector) {
    const c = await frames.collectAll(tabId, { selector: String(args.selector), limit: 20 });
    if (!c.elements.length) {
      fail('E_NOT_FOUND', `选择器未命中可交互元素：${args.selector}`,
        '先用 snapshot 看页面上有什么；只有「可交互元素」参与匹配，纯文本容器请用 attr/eval');
    }
    const el = c.elements[0];
    const r = await frames.probeRef(tabId, el.ref, { force: true });
    return { ref: el.ref, frameId: r.entry.frameId, localRef: r.entry.localRef, info: r.info };
  }
  fail('E_PARAM', '需要 --ref 或 --selector', '先跑 find --text "提交" 拿到 ref');
}

/** 把 frame 内视口坐标换算成顶层视口坐标（截图 / 编号层共用） */
async function rectInTopViewport(tabId, t) {
  if (!t || !t.info || !t.info.rect) return null;
  let off = { x: 0, y: 0 };
  if (Number(t.frameId) !== 0) {
    off = t.info.offset || await frames.frameOffsetOf(tabId, t.frameId).catch(() => null);
    if (!off) return null;
  }
  return {
    x: Math.round(t.info.rect.x + off.x),
    y: Math.round(t.info.rect.y + off.y),
    w: Math.round(t.info.rect.w),
    h: Math.round(t.info.rect.h)
  };
}

/** 在目标 frame 里挂一个 MutationObserver，用于判断动作有没有生效 */
async function armObserver(tabId, frameId) {
  return frames.callFrame(tabId, frameId, () => {
    try { if (window.__arkObs) window.__arkObs.disconnect(); } catch { /* 忽略 */ }
    window.__arkMut = 0;
    window.__arkObs = new MutationObserver((ms) => { window.__arkMut += ms.length; });
    try {
      window.__arkObs.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true
      });
    } catch { /* 忽略 */ }
    return true;
  }).catch(() => null);
}

async function mutationCount(tabId, frameId) {
  return frames.callFrame(tabId, frameId, () => window.__arkMut || 0).catch(() => 1);
}

/** 动作后确认：URL 变了 / DOM 变了 / 什么都没发生 */
async function confirmEffect(tabId, frameId, beforeUrl, opts = {}) {
  const out = { urlBefore: beforeUrl, urlAfter: beforeUrl, navigated: false, mutated: false, settled: false, waitedMs: 0 };
  const t0 = Date.now();
  for (const step of opts.steps || [140, 320, 620]) {
    await sleep(step);
    const cur = await chrome.tabs.get(tabId).catch(() => null);
    if (cur && beforeUrl && cur.url !== beforeUrl) {
      out.navigated = true;
      out.urlAfter = cur.url;
      out.settled = true;
      break;
    }
    const m = await mutationCount(tabId, frameId);
    if (m > 0) { out.mutated = true; out.settled = true; break; }
  }
  out.waitedMs = Date.now() - t0;
  return out;
}

/** 主路径：能算绝对坐标就用 CDP 真输入；算不出来（跨域子 frame）退化为页面内合成 */
async function dispatchClick(tabId, t, opts = {}) {
  const info = t.info;
  let absolute = null;
  // 同源 frame 的偏移由页面代理自己算；跨域拿不到时用 CDP 的 frame 几何补上，
  // 这样跨域 iframe 也能走真实输入，而不是退化成合成点击
  const off = info.offset || await frames.frameOffsetOf(tabId, t.frameId).catch(() => null);
  if (off) {
    const vp = frames.mainViewport(tabId) || { vw: 1e9, vh: 1e9 };
    const x = info.point.x + off.x;
    const y = info.point.y + off.y;
    if (x >= 0 && y >= 0 && x <= vp.vw && y <= vp.vh) absolute = { x, y };
  }
  if (absolute) {
    await ensureFocusEmulation(tabId);
    await input.mouseMove(tabId, absolute.x, absolute.y);
    // 悬停可能触发重排（悬浮菜单收起/展开、吸顶条下沉、动画位移），
    // 按下之前必须重新量一次，否则点的是「上一帧的位置」。
    try {
      const again = await frames.invoke(tabId, t.frameId, 'probe', [t.localRef, { scroll: false }]);
      const againOff = again && !again.missing ? (again.offset || off) : null;
      if (againOff) {
        const vp = frames.mainViewport(tabId) || { vw: 1e9, vh: 1e9 };
        const nx = again.point.x + againOff.x;
        const ny = again.point.y + againOff.y;
        const moved = Math.abs(nx - absolute.x) > 1 || Math.abs(ny - absolute.y) > 1;
        if (moved && nx >= 0 && ny >= 0 && nx <= vp.vw && ny <= vp.vh) {
          await input.mouseMove(tabId, nx, ny);
          absolute = { x: nx, y: ny };
        }
      }
    } catch { /* 量不到就按原坐标点 */ }
    await input.mouseClick(tabId, absolute.x, absolute.y, { count: opts.count || 1, holdMs: opts.holdMs, skipMove: true });
    return { via: 'cdp', point: absolute };
  }
  const r = await frames.invoke(tabId, t.frameId, 'clickLocal', [t.localRef]);
  if (!r || r.ok === false) {
    fail('E_ACTION', `子框架内点击失败：${(r && r.error) || '未知原因'}`,
      '跨域 iframe 只能使用页面内合成点击；若仍失败，尝试在该 iframe 的 URL 上直接打开');
  }
  return { via: 'synthetic', frame: t.frameId };
}

// ── 快照 ───────────────────────────────────────────────────────────────────
const lastSnap = new Map(); // tabId -> Map(ref -> text)

function stripElement(e) {
  const o = Object.assign({}, e);
  delete o.offset;
  delete o.frameId;
  delete o.localRef;
  delete o.prevRef;
  return o;
}

function computeDiff(tabId, elements, wantDiff) {
  const prev = lastSnap.get(tabId);
  const cur = new Map(elements.map((e) => [e.ref, e.text]));
  lastSnap.set(tabId, cur);
  if (!wantDiff) return null;
  const result = { mode: 'first', added: [], removed: [], changed: [] };
  if (prev) {
    result.mode = 'delta';
    for (const [ref, text] of cur) {
      if (!prev.has(ref)) result.added.push({ ref, text: String(text).slice(0, 40) });
      else if (prev.get(ref) !== text) result.changed.push({ ref, from: String(prev.get(ref)).slice(0, 40), to: String(text).slice(0, 40) });
    }
    for (const [ref, text] of prev) {
      if (!cur.has(ref)) result.removed.push({ ref, text: String(text).slice(0, 40) });
    }
  }
  result.counts = { added: result.added.length, removed: result.removed.length, changed: result.changed.length };
  result.added = result.added.slice(0, 20);
  result.removed = result.removed.slice(0, 20);
  result.changed = result.changed.slice(0, 20);
  return result;
}

// ── 命令表 ─────────────────────────────────────────────────────────────────
export async function dispatch(cmd, args) {
  switch (cmd) {
    case 'ping':
      return { pong: true, at: Date.now() };

    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId, status: t.status }));
    }

    case 'open': {
      if (!args.url) fail('E_PARAM', 'open 需要 url', '例：open https://example.com');
      const capture = args.capture !== false;
      const tab = await chrome.tabs.create({ url: capture ? 'about:blank' : args.url, active: args.active !== false });
      let capturing = false;
      let captureError = null;
      if (capture) {
        try {
          await ensureAttached(tab.id);
          obs.netBuf.set(tab.id, new Map());
          await chrome.tabs.update(tab.id, { url: args.url });
          capturing = true;
        } catch (e) {
          captureError = String(e && e.message || e);
          await chrome.tabs.update(tab.id, { url: args.url });
        }
      }
      if (args.waitLoad !== false) await waitLoad(tab.id, args.timeoutMs || 30000);
      const fresh = await chrome.tabs.get(tab.id);
      await setLastTab(tab.id);
      refs.reset(tab.id);
      lastSnap.delete(tab.id);
      await frames.prep(tab.id).catch(() => null);
      return { id: tab.id, url: fresh.url, title: fresh.title, capturing, ...(captureError ? { captureError } : {}), status: fresh.status };
    }

    case 'activate': {
      const tab = await tabById(args.tabId);
      await chrome.tabs.update(tab.id, { active: true });
      await setLastTab(tab.id);
      return { id: tab.id, url: tab.url };
    }

    case 'close': {
      const tab = await tabById(args.tabId);
      await chrome.tabs.remove(tab.id);
      forget(tab.id);
      refs.reset(tab.id);
      obs.clearTab(tab.id);
      lastSnap.delete(tab.id);
      if (lastTabId === tab.id) { lastTabId = null; try { await chrome.storage.session.remove('ark:lastTab'); } catch { /* 忽略 */ } }
      return { closed: tab.id };
    }

    case 'info': {
      const tab = await tabById(args.tabId);
      const vp = await probeViewport(tab.id);
      return { id: tab.id, url: tab.url, title: tab.title, status: tab.status, viewport: { w: vp.vw, h: vp.vh, dpr: vp.dpr, hidden: vp.vis === 'hidden' } };
    }

    case 'snapshot': {
      const tab = await tabById(args.tabId);
      const max = Math.max(1, Math.min(2000, Number(args.max) || 400));
      const limit = Math.max(1, Math.min(max, Number(args.limit) || 40));
      const c = await frames.collectAll(tab.id, { limit: max, hidden: args.hidden === true });
      let els = c.elements.slice(0, max);
      if (args.inView === true) els = els.filter((e) => e.inView);
      const diff = computeDiff(tab.id, els, args.diff === true);
      const reused = els.filter((e) => e.prevRef > 0).length;
      const out = {
        url: c.page.url, title: c.page.title,
        count: els.length,
        returned: Math.min(limit, els.length),
        truncated: els.length > limit,
        reused, assigned: els.length - reused,
        frames: c.multiFrame ? c.frames : undefined,
        viewport: { w: c.page.vw, h: c.page.vh, scrollY: c.page.scrollY },
        elements: els.slice(0, limit).map(stripElement),
        diff
      };
      if (args.shot === true) {
        // 跨域 frame 的页面代理拿不到偏移，编号层会画错位置：截图前用 CDP 补一次
        if (args.boxes === true) {
          const offCache = new Map();
          for (const e of els.slice(0, limit)) {
            if (!e.frameId || e.offset) continue;
            if (!offCache.has(e.frameId)) {
              offCache.set(e.frameId, await frames.frameOffsetOf(tab.id, e.frameId).catch(() => null));
            }
            e.offset = offCache.get(e.frameId);
          }
        }
        const labels = args.boxes === true
          ? els.slice(0, limit).map((e) => ({
            ref: e.ref,
            x: e.x + ((e.offset && e.offset.x) || 0),
            y: e.y + ((e.offset && e.offset.y) || 0),
            w: e.w, h: e.h,
            clickable: !e.disabled
          }))
          : null;
        const shot = await captureShot(tab.id, {
          format: args.format || 'webp', quality: args.quality || 80,
          full: args.full === true, labels,
          focus: args.focus === true,
          timeoutMs: args.timeoutMs,
          // 复用 collect 已经拿到的视口数据，省掉一次跨 frame 往返
          viewport: { vw: c.page.vw, vh: c.page.vh, dpr: c.page.dpr, vis: c.page.vis, sx: c.page.scrollX, sy: c.page.scrollY }
        });
        out.shot = { base64: shot.base64, format: shot.format, clip: shot.clip, viewportForced: shot.viewportForced, ...(shot.uniform ? { uniform: true } : {}) };
      }
      return out;
    }

    case 'find': {
      const tab = await tabById(args.tabId);
      const q = String(args.text == null ? '' : args.text);
      if (!q && !args.selector) fail('E_PARAM', 'find 需要 --text（要查找的文字）或 --selector', '例：find --text "登录"');
      const r = await frames.findAll(tab.id, q, {
        role: args.role || null,
        selector: args.selector || null,
        limit: Number(args.limit || 5),
        hidden: args.hidden === true
      });
      return {
        query: q, role: args.role || null,
        total: r.total, returned: r.items.length, truncated: r.total > r.items.length,
        frames: r.frames > 1 ? r.frames : undefined,
        items: r.items
      };
    }

    case 'click': {
      const tab = await tabById(args.tabId);
      const t = await resolveTarget(tab.id, args);
      const info = t.info;
      if (!info.visible) fail('E_NOT_VISIBLE', '目标元素不可见（宽高为 0 或 visibility:hidden）', '元素可能被折叠/隐藏；先展开父级容器，或用 find --hidden 确认是否存在');
      if (!info.enabled) fail('E_DISABLED', '目标元素处于禁用状态', '等待前置条件满足（如勾选协议、填完必填项）后再试');
      if (info.coveredBy && info.coveredBy !== 'offscreen' && args.force !== true) {
        fail('E_COVERED', `目标元素被遮挡：${info.coveredBy}`, '常见于弹层/遮罩未关闭。先关闭浮层，或用 find 找真正接收点击的元素；确认无恙可加 --force');
      }
      if (info.coveredBy === 'offscreen' && args.force !== true) {
        fail('E_OFFSCREEN', '目标元素在视口外，无法真实点击', '先 scroll 到该区域，或用 --force 走页面内合成点击');
      }

      await armObserver(tab.id, t.frameId);
      const before = (await chrome.tabs.get(tab.id).catch(() => ({}))).url;
      const watcher = watchNewTab(tab.id, 3000);
      let act;
      try {
        act = await dispatchClick(tab.id, t, args);
      } catch (e) {
        watcher.cancel();
        throw e;
      }
      const effect = args.confirm === false
        ? { settled: null, note: 'skipped' }
        : await confirmEffect(tab.id, t.frameId, before, {});

      // 不要为了“可能开新标签”固定等 1.5 秒：先给一个短窗口，只有效果仍未确认时才多等一点
      const tWatch = Date.now();
      let openedTab = await Promise.race([
        watcher.promise,
        sleep(args.confirm === false ? 260 : 420).then(() => null)
      ]);
      if (!openedTab && args.confirm !== false && effect.settled !== true) {
        openedTab = await Promise.race([watcher.promise, sleep(700).then(() => null)]);
      }
      watcher.cancel();

      if (effect.navigated) { refs.reset(tab.id); lastSnap.delete(tab.id); }
      if (openedTab) { await setLastTab(openedTab.id); }

      const out = Object.assign({ ref: t.ref, tag: info.tag, via: act.via }, effect);
      out.openedTabWaitMs = Date.now() - tWatch;
      if (openedTab) out.openedTab = { id: openedTab.id, url: openedTab.url, tracked: true };
      if (effect.settled === false) out.note = 'no-effect: DOM 与 URL 在 1.1 秒内均无变化，可能不是有效控件或被脚本拦截';
      return out;
    }

    case 'fill': {
      const tab = await tabById(args.tabId);
      const t = await resolveTarget(tab.id, args);
      const text = String(args.text == null ? '' : args.text);
      if (!t.info.editable) {
        if (/^(checkbox|radio|switch)$/.test(t.info.role || '')) {
          return await dispatch('click', { tabId: tab.id, ref: t.ref, force: args.force });
        }
        fail('E_NOT_EDITABLE', `目标元素不可编辑（role=${t.info.role}）`, '用 find --role textbox 定位输入框；下拉请用 select');
      }

      await frames.invoke(tab.id, t.frameId, 'focusLocal', [t.localRef, { selectAll: true }]);
      let via = 'dom';
      const fillOffset = t.frameId === 0
        ? { x: 0, y: 0 }
        : (t.info.offset || await frames.frameOffsetOf(tab.id, t.frameId).catch(() => null));
      const canReal = !!fillOffset;
      if (canReal) {
        await ensureFocusEmulation(tab.id);
        if (text === '') await input.pressKey(tab.id, 'Backspace');
        else if (args.type === true) await input.typeChars(tab.id, text, Number(args.delay || 25));
        else await input.insertText(tab.id, text);
        via = args.type === true ? 'cdp-type' : 'cdp-insert';
      }

      const checkValue = async () => frames.invoke(tab.id, t.frameId, 'verifyValue', [t.localRef, text]);
      let check = await checkValue();
      const okCheck = (c) => !!(c && c.ok && (text === '' || c.masked ? c.exact : (c.exact || c.contains)));
      let verified = okCheck(check);

      if (!verified) {
        await frames.invoke(tab.id, t.frameId, 'fillLocal', [t.localRef, text]);
        check = await checkValue();
        verified = okCheck(check);
        via = 'dom-fallback';
      }
      const after = await frames.invoke(tab.id, t.frameId, 'readLocal', [t.localRef]);
      const value = String((after && after.value) || '');
      if (!verified) {
        fail('E_FILL_FAILED', `填写后校验未通过（实际值 "${value.slice(0, 60)}"）`,
          '可能是富文本编辑器需要逐字符输入（加 --type）、或字段在输入后被框架重置');
      }

      if (args.submit === true) {
        await input.pressKey(tab.id, 'Enter');
        await sleep(150);
      }
      return {
        ref: t.ref, chars: text.length, value: value.slice(0, 200), via, verified,
        masked: !!(check && check.masked), submitted: args.submit === true
      };
    }

    case 'hover': {
      const tab = await tabById(args.tabId);
      const t = await resolveTarget(tab.id, args);
      const info = t.info;
      let via = 'synthetic';
      const off = info.offset || await frames.frameOffsetOf(tab.id, t.frameId).catch(() => null);
      if (off) {
        const vp = frames.mainViewport(tab.id) || { vw: 1e9, vh: 1e9 };
        const x = info.point.x + off.x;
        const y = info.point.y + off.y;
        if (x >= 0 && y >= 0 && x <= vp.vw && y <= vp.vh) {
          await ensureFocusEmulation(tab.id);
          await input.mouseMove(tab.id, x, y);
          via = 'cdp';
        }
      }
      if (via === 'synthetic') await frames.invoke(tab.id, t.frameId, 'hoverLocal', [t.localRef]);
      await sleep(180);
      const hs = await frames.invoke(tab.id, t.frameId, 'hoverState', [t.localRef]).catch(() => null);
      return { ref: t.ref, via, hoverActive: !!(hs && hs.hover), hoverChain: (hs && hs.chain) || 0 };
    }

    case 'press': {
      const tab = await tabById(args.tabId);
      let frameId = 0;
      if (args.ref != null || args.selector) {
        const t = await resolveTarget(tab.id, args);
        frameId = t.frameId;
        await frames.invoke(tab.id, t.frameId, 'focusLocal', [t.localRef]);
      }
      const before = (await chrome.tabs.get(tab.id).catch(() => ({}))).url;
      await armObserver(tab.id, frameId);
      await ensureFocusEmulation(tab.id);
      const r = await input.pressKey(tab.id, args.key || 'Enter');
      const effect = args.confirm === false ? {} : await confirmEffect(tab.id, frameId, before, { steps: [120, 300] });
      return Object.assign({ key: r.key, code: r.code, modifiers: r.modifiers }, effect);
    }

    case 'select': {
      const tab = await tabById(args.tabId);
      const t = await resolveTarget(tab.id, args);
      const values = Array.isArray(args.values) ? args.values : String(args.values == null ? '' : args.values).split(',').map((s) => s.trim()).filter(Boolean);
      if (!values.length) fail('E_PARAM', 'select 需要 --values', '例：select --ref 8 --values "CN"');

      const native = await frames.invoke(tab.id, t.frameId, 'selectLocal', [t.localRef, values]);
      if (native && native.ok) return { ref: t.ref, mode: 'native', picked: native.picked, value: native.value };
      if (native && native.error === 'option-not-found') {
        const available = (native.available || []).map((o) => o.value + (o.text && o.text !== o.value ? ` (${o.text})` : ''));
        fail('E_SELECT_FAILED', `原生 select 没有匹配的值：${values.join(' / ')}`,
          available.length ? `可选值：${available.slice(0, 30).join(', ')}` : '先 attr --ref 查看 option 列表');
      }

      // 非原生下拉：点击展开 → 按文本找选项 → 点击选项
      // 浮层渲染有延迟、也可能被误点关掉，所以用「轮询 + 必要时重新展开」而不是睡一个固定时长
      await armObserver(tab.id, t.frameId);
      await dispatchClick(tab.id, t, {});

      const looksLikeOption = (i) => /option|menuitem|treeitem|listitem|li|div|span|button/i.test(String(i.role) + ' ' + String(i.tag));
      let clicked = null;
      for (let round = 0; round < 2 && !clicked; round++) {
        if (round > 0) await dispatchClick(tab.id, t, {});   // 上一轮没命中，重新展开
        for (let attempt = 0; attempt < 6 && !clicked; attempt++) {
          await sleep(attempt === 0 ? 240 : 200);
          for (const v of values) {
            const found = await frames.findAll(tab.id, v, { limit: 15 });
            const cand = (found.items || []).find((i) => i.clickable && looksLikeOption(i));
            if (cand) {
              const info = await frames.probeRef(tab.id, cand.ref, { force: true });
              await dispatchClick(tab.id, { ref: cand.ref, frameId: info.entry.frameId, localRef: info.entry.localRef, info: info.info }, {});
              clicked = cand;
              break;
            }
          }
        }
      }
      await sleep(180);
      const now = await frames.invoke(tab.id, t.frameId, 'readLocal', [t.localRef]);
      if (!clicked) {
        fail('E_SELECT_FAILED', `自定义下拉里没找到可点选项：${values.join(' / ')}`,
          '选项可能在浮层里且文本不完全一致；先 snapshot 看展开后的选项列表，再用 click --ref 点');
      }
      const pickedText = String((now && (now.text || now.value)) || '');
      return {
        ref: t.ref, mode: 'custom',
        picked: [clicked.text],
        value: (now && now.value) || null,
        confirmed: values.some((v) => pickedText.includes(v))
      };
    }

    case 'shot': {
      const tab = await tabById(args.tabId);
      const shotOpts = {
        format: args.format || 'webp',
        quality: args.quality == null ? 85 : Number(args.quality),
        full: args.full === true,
        focus: args.focus === true,
        width: args.width,
        height: args.height,
        timeoutMs: args.timeoutMs
      };
      let rect = null;
      if (args.ref != null || args.selector) {
        const t = await resolveTarget(tab.id, args, { skipDrift: true });
        rect = await rectInTopViewport(tab.id, t);
        if (!rect || rect.w < 1 || rect.h < 1) {
          fail('E_NOT_VISIBLE', '元素渲染尺寸为 0，或无法换算跨域 frame 坐标，无法截图', '先展开父级容器；跨域 frame 可改用整页截图');
        }
      }
      let shot = await captureShot(tab.id, { ...shotOpts, rect });
      // 纯色帧通常是「刚滚动/刚布局，渲染器还没跟上」：重新测量坐标再拍一次，
      // 新坐标与新布局一致，比拿旧 clip 硬重拍可靠（旧 clip 可能已经指到空白区）
      if (shot.uniform && rect) {
        const t2 = await resolveTarget(tab.id, args, { skipDrift: true, force: true }).catch(() => null);
        const rect2 = t2 ? await rectInTopViewport(tab.id, t2) : null;
        if (rect2 && rect2.w > 0) {
          const again = await captureShot(tab.id, { ...shotOpts, rect: rect2 }).catch(() => null);
          if (again && !again.uniform) shot = again;
        }
      }
      let diff = null;
      if (args.diff === true) {
        const key = `${tab.id}|${args.ref != null ? 'ref:' + args.ref : args.selector ? 'sel:' + String(args.selector) : 'view'}`;
        const prev = lastShot.get(key);
        diff = prev ? await imageDiff(prev, shot.base64) : { firstRun: true, note: '没有上一张图可比；再跑一次同一目标即得到变化率' };
        rememberShot(key, shot.base64);
      }
      return {
        base64: shot.base64, format: shot.format, clip: shot.clip,
        viewportForced: shot.viewportForced, focused: shot.focused,
        vw: shot.vw, vh: shot.vh,
        ...(shot.uniform ? { uniform: true } : {}),
        ...(shot.blankRetries ? { blankRetries: shot.blankRetries } : {}),
        ...(diff ? { diff } : {})
      };
    }

    case 'eval': {
      const tab = await tabById(args.tabId);
      const code = String(args.code == null ? '' : args.code);
      if (!code) fail('E_PARAM', 'eval 需要一段 JS 表达式', '例：eval "document.title"');
      const evalTimeout = Math.max(1000, Math.min(60000, Number(args.timeoutMs || 15000)));
      const r = await cdp(tab.id, 'Runtime.evaluate', {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        timeout: evalTimeout
      });
      if (r.exceptionDetails) {
        const msg = r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || '执行异常';
        fail('E_EVAL', String(msg).split('\n')[0], '检查表达式语法；部分站点 CSP 会阻止 eval 类求值');
      }
      const v = r.result || {};
      return { value: v.value === undefined ? null : v.value, type: v.type, description: v.description || null };
    }

    case 'scroll': {
      const tab = await tabById(args.tabId);
      const dy = Number(args.dy == null ? 600 : args.dy);
      const dx = Number(args.dx == null ? 0 : args.dx);
      if (!Number.isFinite(dy) || !Number.isFinite(dx)) fail('E_PARAM', `--dy/--dx 需要数字`, '例：scroll --dy 600');
      const r = await frames.callMain(tab.id, (d) => {
        const before = { x: scrollX, y: scrollY };
        // behavior:'instant' 覆盖页面的 scroll-behavior:smooth，保证返回时位置已生效
        window.scrollTo({ left: before.x + d[0], top: before.y + d[1], behavior: 'instant' });
        return { before, after: { x: scrollX, y: scrollY }, max: document.documentElement.scrollHeight - innerHeight };
      }, [[dx, dy]]);
      return r || { before: null, after: null };
    }

    case 'attr': {
      const tab = await tabById(args.tabId);
      const t = await resolveTarget(tab.id, args);
      const r = await frames.invoke(tab.id, t.frameId, 'attrsOf', [t.localRef]);
      if (!r) fail('E_NOT_FOUND', '元素属性读取失败', '重跑 snapshot 后重试');
      return Object.assign({ ref: t.ref, frame: t.frameId === 0 ? 'main' : 'f' + t.frameId }, r);
    }

    case 'text': {
      const tab = await tabById(args.tabId);
      const maxLen = Math.max(500, Number(args.maxLen || 20000));
      await frames.prep(tab.id).catch(() => null);
      let results = [];
      try { results = await frames.invokeAll(tab.id, 'pageText', [maxLen]); }
      catch { results = []; }
      let usable = results.filter((r) => r.result && typeof r.result.text === 'string');
      if (!usable.length) {
        // 某些 sandbox iframe 不可注入时，至少保住主文档正文
        const one = await frames.callMain(tab.id, (m) => (window.__ark ? window.__ark.pageText(m) : null), [maxLen]).catch(() => null);
        if (one) usable = [{ frameId: 0, result: one }];
      }
      if (!usable.length) fail('E_INJECT', '正文抽取失败', '先 open 目标页面；chrome:// 等特权页不可注入');
      const main = usable.find((r) => r.frameId === 0) || usable[0];
      const multi = usable.length > 1;
      const frameMeta = [];
      let combined = '';
      for (const r of usable) {
        const t = r.result;
        frameMeta.push({ frameId: r.frameId, frame: frames.frameLabel(r.frameId), url: t.url, title: t.title, chars: t.chars });
        if (!t.text) continue;
        const label = multi
          ? `\n\n--- frame ${frames.frameLabel(r.frameId) || 'main'}${t.url ? ' · ' + t.url : ''} ---\n`
          : '';
        combined += label + t.text;
      }
      const text = combined.slice(0, maxLen);
      return {
        url: main.result.url, title: main.result.title,
        chars: text.length,
        truncated: combined.length > maxLen || usable.some((r) => r.result.chars >= maxLen),
        ...(multi ? { frames: frameMeta } : {}),
        text
      };
    }

    case 'console': {
      const tab = await tabById(args.tabId);
      await cdp(tab.id, 'Runtime.enable').catch(() => null);
      await obs.hydrateObservers(tab.id);   // SW 被回收过也能接回历史
      const buf = obs.consoleBuf.get(tab.id) || [];
      const filter = args.level ? String(args.level) : null;
      const matchedList = filter ? buf.filter((x) => x.level === filter) : buf;
      const limit = Math.max(1, Number(args.limit || 100));
      const items = matchedList.slice(-limit);
      if (args.clear === true) obs.consoleBuf.set(tab.id, []);
      return { tabId: tab.id, total: buf.length, matched: matchedList.length, returned: items.length, truncated: matchedList.length > items.length, items };
    }

    case 'network': {
      const tab = await tabById(args.tabId);
      await cdp(tab.id, 'Network.enable').catch(() => null);
      await obs.hydrateObservers(tab.id);   // SW 被回收过也能接回历史
      const m = obs.netBuf.get(tab.id) || new Map();
      let list = [...m.values()];
      const total = list.length;
      if (args.clear === true) m.clear();
      const filter = args.filter ? String(args.filter).toLowerCase() : '';
      const type = args.type ? String(args.type).toLowerCase() : '';
      if (filter) list = list.filter((e) => (e.url || '').toLowerCase().includes(filter));
      if (type) list = list.filter((e) => String(e.resourceType || e.type || '').toLowerCase() === type);
      if (args.errors === true) list = list.filter((e) => e.failed || (e.status && e.status >= 400));
      const matched = list.length;
      const limit = Math.max(1, Number(args.limit || 30));
      const items = list.slice(-limit).reverse().map((e) => ({
        requestId: e.requestId,
        method: e.method,
        url: e.url.length > 300 ? e.url.slice(0, 300) + '…' : e.url,
        status: e.status, type: e.resourceType || e.type, mime: e.mime,
        size: e.size, ms: e.ms, cached: e.fromCache, failed: e.failed,
        postData: e.postData || undefined
      }));
      return { tabId: tab.id, total, matched, returned: items.length, truncated: matched > items.length, intercepting: obs.interceptOn(tab.id), items };
    }

    case 'net-body': {
      const tab = await tabById(args.tabId);
      if (!args.requestId) fail('E_PARAM', 'net-body 需要 requestId', '先跑 net 拿 requestId');
      const r = await cdp(tab.id, 'Network.getResponseBody', { requestId: String(args.requestId) });
      const maxLen = Number(args.maxLen || 20000);
      const body = String(r.body || '');
      return {
        requestId: args.requestId,
        base64: r.base64Encoded === true,
        length: body.length,
        truncated: body.length > maxLen,
        body: body.slice(0, maxLen)
      };
    }

    case 'net-intercept': {
      const tab = await tabById(args.tabId);
      const on = args.on !== false;
      const r = await obs.setIntercept(tab.id, on);
      return { tabId: tab.id, intercepting: r.intercepting, enabled: on };
    }

    case 'net-rule': {
      if (args.clear === true) {
        obs.fetchRules.length = 0;
        return { cleared: true, rules: [] };
      }
      if (args.add) {
        let rule;
        try { rule = typeof args.add === 'string' ? JSON.parse(args.add) : args.add; }
        catch { fail('E_PARAM', '--add 需要合法 JSON', '例：--add \'{"pattern":"/api/user","action":"mock","status":200,"body":"{\\"ok\\":true}"}\''); }
        if (!rule.action) fail('E_PARAM', 'rule 需要 action', 'action: mock | abort | delay | header');
        obs.fetchRules.push(rule);
      }
      return { rules: obs.fetchRules, count: obs.fetchRules.length };
    }

    case 'net-har': {
      const tab = await tabById(args.tabId);
      await obs.hydrateObservers(tab.id);
      const m = obs.netBuf.get(tab.id) || new Map();
      const limit = Math.max(1, Number(args.limit || 200));
      const withBodies = args.bodies !== false;
      const maxBody = Math.max(0, Number(args.maxBody || 20000));
      const source = [...m.values()].slice(-limit);
      let bodiesIncluded = 0, bodiesFailed = 0;
      const entries = [];
      for (const e of source) {
        const content = { size: e.size || 0, mimeType: e.mime || '' };
        if (withBodies && e.status && !e.failed) {
          try {
            const r = await cdp(tab.id, 'Network.getResponseBody', { requestId: String(e.requestId) });
            const body = String(r.body || '');
            content.size = body.length;
            if (r.base64Encoded) content.encoding = 'base64';
            if (body.length > maxBody) {
              content.text = body.slice(0, maxBody);
              content.comment = `truncated:${body.length}`;
            } else {
              content.text = body;
            }
            bodiesIncluded++;
          } catch { bodiesFailed++; }
        }
        entries.push({
          startedDateTime: new Date(e.startedAt).toISOString(),
          time: e.ms || 0,
          request: { method: e.method, url: e.url, headers: Object.entries(e.headers || {}).map(([name, value]) => ({ name, value: String(value) })), postData: e.postData ? { text: e.postData } : undefined },
          response: { status: e.status || 0, statusText: '', headers: Object.entries(e.resHeaders || {}).map(([name, value]) => ({ name, value: String(value) })), content },
          cache: {}, timings: { wait: e.ms || 0 }
        });
      }
      return {
        log: { version: '1.2', creator: { name: 'ark-web', version: '5.1.0' }, pages: [], entries },
        bodiesIncluded, bodiesFailed, limit, withBodies
      };
    }

    case 'perf': {
      const tab = await tabById(args.tabId);
      await cdp(tab.id, 'Performance.enable').catch(() => null);
      const r = await cdp(tab.id, 'Performance.getMetrics');
      const all = {};
      for (const mm of (r.metrics || [])) all[mm.name] = mm.value;
      const pick = ['Documents', 'Frames', 'Nodes', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'JSHeapTotalSize', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
      const metrics = {};
      for (const k of pick) if (k in all) metrics[k] = all[k];

      const vitals = await frames.callMain(tab.id, () => {
        const nav = performance.getEntriesByType('navigation')[0];
        const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
        const lcp = performance.getEntriesByType('largest-contentful-paint');
        const res = performance.getEntriesByType('resource');
        const byType = {};
        for (const e of res) {
          const k = e.initiatorType || 'other';
          byType[k] = byType[k] || { count: 0, bytes: 0 };
          byType[k].count++;
          byType[k].bytes += e.transferSize || 0;
        }
        return {
          ttfb: nav ? Math.round(nav.responseStart) : null,
          domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          load: nav ? Math.round(nav.loadEventEnd) : null,
          fcp: paint['first-contentful-paint'] || null,
          lcp: lcp.length ? Math.round(lcp[lcp.length - 1].startTime) : null,
          resources: { total: res.length, bytes: res.reduce((s, e) => s + (e.transferSize || 0), 0), byType }
        };
      }).catch(() => null);

      // 交互与稳定性指标：buffered 观察器能拿到页面加载以来积压的条目（CLS/INP/LongTask/LCP 元素）
      const more = await cdp(tab.id, 'Runtime.evaluate', {
        awaitPromise: true, returnByValue: true, timeout: 4000,
        expression: `new Promise((resolve) => {
          const out = { cls: 0, clsShifts: 0, inp: null, longTasks: 0, longTaskMs: 0, lcpElement: null };
          const obs = [];
          const add = (cb, opt) => { try { const o = new PerformanceObserver(cb); o.observe(opt); obs.push(o); } catch (e) {} };
          add((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) { out.cls += e.value; out.clsShifts++; } } }, { type: 'layout-shift', buffered: true });
          add((l) => { for (const e of l.getEntries()) { if (e.duration > (out.inp || 0)) out.inp = Math.round(e.duration); } }, { type: 'event', buffered: true, durationThreshold: 16 });
          add((l) => { for (const e of l.getEntries()) { out.longTasks++; out.longTaskMs += e.duration; } }, { type: 'longtask', buffered: true });
          add((l) => { for (const e of l.getEntries()) {
            const el = e.element;
            out.lcpElement = el
              ? { tag: el.tagName, id: el.id || null, cls: el.className ? String(el.className).slice(0, 40) : null, text: String(el.innerText || '').slice(0, 40) }
              : out.lcpElement;
          } }, { type: 'largest-contentful-paint', buffered: true });
          setTimeout(() => {
            for (const o of obs) { try { o.disconnect(); } catch (e) {} }
            out.cls = Math.round(out.cls * 1000) / 1000;
            out.longTaskMs = Math.round(out.longTaskMs);
            resolve(out);
          }, 180);
        })`
      }).then((r) => (r && r.result && r.result.value) || null).catch(() => null);

      const merged = vitals ? { ...vitals, ...(more || {}) } : (more || null);
      return { tabId: tab.id, metrics, vitals: merged, ...(args.all === true ? { all } : {}) };
    }

    case 'emulate': {
      const tab = await tabById(args.tabId);
      const applied = {};
      const reset = args.reset === true;

      if (reset) {
        await cdp(tab.id, 'Emulation.clearDeviceMetricsOverride').catch(() => null);
        rememberDeviceMetrics(tab.id, null);
        await cdp(tab.id, 'Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => null);
        await cdp(tab.id, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => null);
        await cdp(tab.id, 'Emulation.setEmulatedMedia', { features: [] }).catch(() => null);
        await cdp(tab.id, 'Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => null);
        await cdp(tab.id, 'Emulation.setLocaleOverride', { locale: '' }).catch(() => null);
        await cdp(tab.id, 'Emulation.clearGeolocationOverride').catch(() => null);
        return { tabId: tab.id, reset: true };
      }

      if (args.device) {
        const raw = String(args.device).toLowerCase();
        const presets = {
          iphone: { width: 390, height: 844, dpr: 3, mobile: true },
          pixel: { width: 412, height: 915, dpr: 2.625, mobile: true },
          ipad: { width: 820, height: 1180, dpr: 2, mobile: true },
          desktop: { width: 1440, height: 900, dpr: 1, mobile: false }
        };
        let p = presets[raw];
        if (!p) {
          const m = raw.match(/^(\d{3,5})x(\d{3,5})$/);
          if (!m) fail('E_PARAM', `未知设备预设：${args.device}`, '可用 iphone|pixel|ipad|desktop 或 宽度x高度，如 375x812');
          p = { width: Number(m[1]), height: Number(m[2]), dpr: 1, mobile: Number(m[1]) < 600 };
        }
        await cdp(tab.id, 'Emulation.setDeviceMetricsOverride', {
          width: p.width, height: p.height, deviceScaleFactor: p.dpr, mobile: p.mobile
        });
        rememberDeviceMetrics(tab.id, {
          width: p.width, height: p.height, deviceScaleFactor: p.dpr, mobile: p.mobile
        });
        applied.device = p;
      }

      if (args.cpu) {
        const rate = Number(args.cpu);
        if (!Number.isFinite(rate) || rate < 1) fail('E_PARAM', '--cpu 需要 ≥1 的倍数（1=不降速，4=约 4 倍慢）', '例：emulate --cpu 4');
        await cdp(tab.id, 'Emulation.setCPUThrottlingRate', { rate });
        applied.cpu = rate;
      }

      if (args.network) {
        const presets = {
          offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
          slow3g: { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 },
          fast3g: { offline: false, latency: 150, downloadThroughput: 180000, uploadThroughput: 84375 },
          '4g': { offline: false, latency: 20, downloadThroughput: 4000000, uploadThroughput: 3000000 }
        };
        const p = presets[String(args.network).toLowerCase()];
        if (!p) fail('E_PARAM', `未知网络档：${args.network}`, '可用 offline|slow3g|fast3g|4g');
        await cdp(tab.id, 'Network.enable').catch(() => null);
        await cdp(tab.id, 'Network.emulateNetworkConditions', p);
        applied.network = { profile: String(args.network).toLowerCase(), ...p };
      }

      if (args.media) {
        const wanted = String(args.media).split(',').map((s) => s.trim()).filter(Boolean);
        const features = [];
        for (const w of wanted) {
          if (w === 'dark' || w === 'light') features.push({ name: 'prefers-color-scheme', value: w });
          else if (w === 'reduced-motion') features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
          else fail('E_PARAM', `未知媒体特性：${w}`, '可用 dark|light|reduced-motion，可逗号组合');
        }
        await cdp(tab.id, 'Emulation.setEmulatedMedia', { features });
        applied.media = wanted;
      }

      if (args.timezone) {
        await cdp(tab.id, 'Emulation.setTimezoneOverride', { timezoneId: String(args.timezone) });
        applied.timezone = String(args.timezone);
      }

      if (args.locale) {
        await cdp(tab.id, 'Emulation.setLocaleOverride', { locale: String(args.locale) });
        applied.locale = String(args.locale);
      }

      if (args.geo) {
        const m = String(args.geo).match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
        if (!m) fail('E_PARAM', '--geo 需要 "纬度,经度"', '例：emulate --geo 30.27,120.15');
        await cdp(tab.id, 'Emulation.setGeolocationOverride', { latitude: Number(m[1]), longitude: Number(m[2]), accuracy: 20 });
        applied.geo = { lat: Number(m[1]), lng: Number(m[2]) };
      }

      if (!Object.keys(applied).length) {
        fail('E_PARAM', 'emulate 需要至少一个开关', '可用：--device iphone --network slow3g --cpu 4 --media dark --timezone Asia/Tokyo --locale ja-JP --geo 35.68,139.76，或 --reset');
      }
      return { tabId: tab.id, applied };
    }

    case 'coverage': {
      const tab = await tabById(args.tabId);
      const mode = String(args.mode || 'report');

      if (mode === 'start') {
        if (coverageState.has(tab.id)) fail('E_PARAM', '该标签已经在采集中', '先跑 coverage --mode stop 汇总上一次，再重新 start');
        await cdp(tab.id, 'Profiler.enable').catch(() => null);
        await cdp(tab.id, 'Profiler.startPreciseCoverage', { callCount: false, detailed: false });
        await cdp(tab.id, 'DOM.enable').catch(() => null);
        await cdp(tab.id, 'CSS.enable').catch(() => null);
        await cdp(tab.id, 'CSS.startRuleUsageTracking').catch(() => null);
        coverageState.set(tab.id, { startedAt: Date.now(), url: tab.url });
        return { tabId: tab.id, started: true, note: '采集期间正常操作页面；coverage stop 时汇总' };
      }

      const st = coverageState.get(tab.id);
      if (!st) fail('E_PARAM', '还没有开始采集', '先跑 coverage --mode start，操作页面后再 coverage（或 --mode stop）');

      // 首选「整页 best-effort」：能覆盖 start 之前就已加载的脚本，这才是「哪些代码没跑」的答案
      const jsRaw = await cdp(tab.id, 'Profiler.getBestEffortCoverage').catch(() => null)
        || await cdp(tab.id, 'Profiler.takePreciseCoverage').catch(() => null);
      // CSS 覆盖率来自 ruleUsage；不存在 CSS.getAllStyleSheets 这个 CDP 方法
      const cssRaw = await cdp(tab.id, 'CSS.stopRuleUsageTracking').catch(() => null);
      coverageState.delete(tab.id);

      const jsFiles = [];
      let jsTotal = 0, jsUsed = 0;
      let skipped = 0;
      for (const s of (jsRaw && jsRaw.result) || []) {
        const url = s.url || `(inline:${String(s.scriptId)})`;
        // 统计页面的代码，不统计「别的扩展注入的脚本」——那不是被分析站点的一部分
        if (url.startsWith('chrome-extension://') || url.startsWith('devtools://')) { skipped++; continue; }
        let total = 0, used = 0;
        for (const f of s.functions || []) {
          for (const r of f.ranges || []) {
            const len = Math.max(0, (r.endOffset || 0) - (r.startOffset || 0));
            total += len;
            if (r.count > 0) used += len;
          }
        }
        if (total > 0) jsFiles.push({ url, size: total, used, pct: Math.round((used / total) * 100) });
        jsTotal += total; jsUsed += used;
      }

      let cssTotal = 0, cssUsed = 0;
      const bySheet = new Map();
      for (const r of (cssRaw && cssRaw.ruleUsage) || []) {
        const len = Math.max(0, (r.endOffset || 0) - (r.startOffset || 0));
        const rec = bySheet.get(r.styleSheetId) || { styleSheetId: r.styleSheetId, size: 0, used: 0 };
        rec.size += len;
        if (r.used) rec.used += len;
        bySheet.set(r.styleSheetId, rec);
        cssTotal += len;
        if (r.used) cssUsed += len;
      }
      const cssFiles = [...bySheet.values()].map((x) => ({
        styleSheetId: x.styleSheetId, size: x.size, used: x.used,
        pct: x.size ? Math.round((x.used / x.size) * 100) : 0
      }));

      const topN = Math.max(1, Number(args.top || 8));
      const byUnused = (a, b) => (b.size - b.used) - (a.size - a.used);
      const jsFilesSorted = jsFiles.filter((f) => f.size > 0).sort(byUnused).slice(0, topN);
      const cssFilesSorted = cssFiles.slice().sort(byUnused).slice(0, topN);
      const currentUrl = (await chrome.tabs.get(tab.id).catch(() => ({}))).url || '';
      return {
        tabId: tab.id,
        url: st.url || null,
        navigated: !!(st.url && currentUrl && currentUrl !== st.url),
        windowMs: Date.now() - st.startedAt,
        js: {
          totalChars: jsTotal,
          usedChars: jsUsed,
          pct: jsTotal ? Math.round((jsUsed / jsTotal) * 100) : null,
          skippedExtensionScripts: skipped,
          // 按「没跑到的字符数」降序：先看浪费最大的是什么
          files: jsFilesSorted
        },
        css: {
          totalChars: cssTotal,
          usedChars: cssUsed,
          pct: cssTotal ? Math.round((cssUsed / cssTotal) * 100) : null,
          sheets: cssFilesSorted
        }
      };
    }

    case 'dialog': {
      const tab = await tabById(args.tabId);
      await cdp(tab.id, 'Page.enable').catch(() => null);
      let dismissedOpen = false;
      if (args.policy) {
        const pol = String(args.policy);
        if (!['accept', 'dismiss', 'manual'].includes(pol)) fail('E_PARAM', 'policy 只能是 accept | dismiss | manual', '例：dialog --policy accept');
        obs.dialogPolicy.set(tab.id, pol);
        if (pol !== 'manual') {
          try { await cdp(tab.id, 'Page.handleJavaScriptDialog', { accept: pol === 'accept' }); dismissedOpen = true; } catch { /* 没有打开的弹窗 */ }
        }
      }
      const lg = obs.dialogLogOf(tab.id);
      const items = lg.slice(-Number(args.limit || 20));
      if (args.clear === true) obs.dialogLog.set(tab.id, []);
      const vp = await probeViewport(tab.id);
      const out = { tabId: tab.id, policy: obs.dialogPolicy.get(tab.id) || 'manual', total: lg.length, dismissedOpen, items };
      if (vp.vis === 'hidden') {
        out.tabHidden = true;
        out.note = 'tab-hidden: 后台标签的 JS 弹窗会被 Chrome 推迟，事件可能等到标签可见才到；用例前先 activate';
      }
      return out;
    }

    case 'upload': {
      const tab = await tabById(args.tabId);
      const files = Array.isArray(args.files) ? args.files : (args.file ? [String(args.file)] : []);
      if (!files.length) fail('E_PARAM', 'upload 需要 --file <路径> 或 --files <a,b>', '例：upload --selector "#file" --file D:\\a.pdf');
      const originalSelector = args.selector ? String(args.selector) : null;
      let selector = null;
      let frameId = 0;

      // 1) 定位到真正拥有 file input 的 frame，并在该元素上打唯一临时标记。
      //    这条路径同时覆盖主文档、iframe 和 open shadow root。
      if (originalSelector) {
        const marked = await frames.invokeAll(tab.id, 'markSelectorTmp', [originalSelector]).catch(() => []);
        const hit = marked.find((r) => r.result && r.result.selector);
        if (!hit) fail('E_NOT_FOUND', `未找到文件输入框：${originalSelector}`, '确认选择器指向 <input type=file>；隐藏的 input 也可以');
        frameId = hit.frameId;
        selector = hit.result.selector;
      } else {
        const t = await resolveTarget(tab.id, args);
        frameId = t.frameId;
        selector = await frames.invoke(tab.id, t.frameId, 'markTmp', [t.localRef]);
        if (!selector) fail('E_ACTION', '无法为 ref 生成临时定位', '改用 --selector 指定文件输入框');
      }

      const infoBefore = await frames.invoke(tab.id, frameId, 'fileInfo', [selector]).catch(() => null);
      if (!infoBefore || !infoBefore.found || !infoBefore.isFile) {
        await frames.invokeAll(tab.id, 'clearTmp', []).catch(() => null);
        fail('E_PARAM', `目标不是文件输入框：${originalSelector || args.ref}`, '选择器/ref 必须指向 <input type=file>');
      }

      const keyMatch = selector.match(/data-ark-tmp="([^"]+)"/);
      const tmpKey = keyMatch ? keyMatch[1] : null;
      const findTmpNode = (node) => {
        if (!node) return null;
        const attrs = node.attributes || [];
        for (let i = 0; i + 1 < attrs.length; i += 2) {
          if (attrs[i] === 'data-ark-tmp' && attrs[i + 1] === tmpKey) return node;
        }
        for (const k of ['children', 'shadowRoots']) {
          for (const child of node[k] || []) {
            const hit = findTmpNode(child);
            if (hit) return hit;
          }
        }
        return node.contentDocument ? findTmpNode(node.contentDocument) : null;
      };

      let input = null;
      try {
        await enableDomains(tab.id, ['DOM.enable']);
        const doc = await cdp(tab.id, 'DOM.getDocument', { depth: -1, pierce: true });
        const node = tmpKey ? findTmpNode(doc.root) : null;
        if (!node) fail('E_NOT_FOUND', 'CDP 未找到目标文件输入框', '确认 frame 可注入；必要时直接 open 该 iframe 的 URL');
        try {
          await cdp(tab.id, 'DOM.setFileInputFiles', { nodeId: node.nodeId, files });
        } catch (e) {
          fail('E_UPLOAD', `设置文件失败：${String(e && e.message || e)}`, '确认文件路径存在且有读取权限');
        }
        input = await frames.invoke(tab.id, frameId, 'fileInfo', [selector]).catch(() => null);
      } finally {
        // 无论成功失败都清掉所有 frame 里的临时属性
        await frames.invokeAll(tab.id, 'clearTmp', []).catch(() => null);
      }

      const verified = !!(input && input.found && input.isFile && input.count === files.length);
      return {
        tabId: tab.id, selector: originalSelector || selector,
        frame: frameId === 0 ? 'main' : frames.frameLabel(frameId),
        requested: files.length, input, verified
      };
    }

    case 'wait': {
      const tab = await tabById(args.tabId);
      const timeout = Number(args.timeoutMs || 15000);
      const started = Date.now();
      const selector = args.selector || null;
      const urlPart = args.urlPart || null;
      const textWant = args.text || null;
      const detach = args.mode === 'detach';
      if (!selector && !urlPart && !textWant) return { ok: true, elapsedMs: 0, note: '没有等待条件，立即返回' };
      if (selector) {
        const valid = await frames.callMain(tab.id, (s) => {
          try { document.querySelector(s); return true; } catch { return false; }
        }, [selector]).catch(() => true);
        if (!valid) fail('E_PARAM', `非法 CSS 选择器：${selector}`, '检查引号/括号是否配对');
      }

      // URL 条件：轮询极轻（一次 tabs 查询 ~1ms），没必要进页面
      if (urlPart) {
        let delay = 60;
        while (Date.now() - started < timeout) {
          const cur = await chrome.tabs.get(tab.id).catch(() => null);
          if (cur && String(cur.url || '').includes(urlPart)) return { ok: true, elapsedMs: Date.now() - started, mode: 'url', url: cur.url };
          await sleep(delay);
          delay = Math.min(300, Math.round(delay * 1.5));
        }
        return { ok: false, elapsedMs: Date.now() - started, timeoutMs: timeout, target: urlPart };
      }

      // 有子框架时内容可能在别的 frame，主文档观察器看不到 → 走跨 frame 轮询
      const frameCount = await cdp(tab.id, 'Runtime.evaluate', { expression: 'window.frames.length', returnByValue: true })
        .then((r) => Number(r && r.result && r.result.value) || 0).catch(() => 0);

      if (!(detach && frameCount > 0)) {
        // 先给主文档一个事件驱动窗口：有 iframe 时最多试 1.5s，再回退到跨 frame 轮询。
        // 这样主文档内的 wait 不再因为页面有广告 iframe 而永远走慢路径。
        // detach 且有 iframe 时不能用主文档结果（主文档没有不代表其它 frame 没有），直接走全 frame 轮询。
        const observerBudget = frameCount === 0 ? timeout : Math.min(1500, timeout);
        // 事件驱动：一次 evaluate 里挂 MutationObserver，条件成立立刻 resolve（零轮询）
        const expr = `new Promise((resolve) => {
          const sel = ${JSON.stringify(selector)};
          const want = ${JSON.stringify(textWant)};
          const detach = ${detach ? 'true' : 'false'};
          let mo = null, timer = null;
          const done = (v) => { try { if (mo) mo.disconnect(); } catch (e) {} if (timer) clearTimeout(timer); resolve(v); };
          const check = () => {
            try {
              if (sel) {
                const n = document.querySelectorAll(sel).length;
                if (detach ? n === 0 : n > 0) return done(true);
              }
              if (want && document.body && (document.body.innerText || '').includes(want)) return done(true);
            } catch (e) {}
          };
          try {
            mo = new MutationObserver(check);
            mo.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true, attributes: true });
          } catch (e) {}
          timer = setTimeout(() => done(false), ${Math.max(250, observerBudget - 120)});
          check();
        })`;
        const hit = await cdp(tab.id, 'Runtime.evaluate', {
          expression: expr, awaitPromise: true, returnByValue: true,
          timeout: Math.max(1000, observerBudget + 800)
        }).then((r) => r && r.result && r.result.value === true).catch(() => false);
        if (hit) {
          return {
            ok: true, elapsedMs: Date.now() - started, via: 'observer',
            mode: selector ? (detach ? 'detach' : 'attach') : 'text',
            ...(selector ? { selector } : { text: textWant })
          };
        }
      }

      // 回退：跨 frame 轮询（iframe 内容 / 观察器未命中）
      let delay = 80;
      while (Date.now() - started < timeout) {
        const rs = selector
          ? await frames.invokeAll(tab.id, 'assertLocal', [{ selector, count: detach ? 0 : 1 }]).catch(() => [])
          : await frames.invokeAll(tab.id, 'assertLocal', [{ selector: 'body', text: textWant }]).catch(() => []);
        const ok = selector && detach
          ? (rs.length > 0 && rs.every((r) => r.result && r.result.pass === true))
          : rs.some((r) => r.result && r.result.pass === true);
        if (ok) {
          return {
            ok: true, elapsedMs: Date.now() - started, via: 'frame-poll',
            mode: selector ? (detach ? 'detach' : 'attach') : 'text',
            ...(selector ? { selector } : { text: textWant })
          };
        }
        await sleep(delay);
        delay = Math.min(300, Math.round(delay * 1.5));
      }
      return { ok: false, elapsedMs: Date.now() - started, timeoutMs: timeout, target: selector || textWant };
    }

    case 'wait-idle': {
      const tab = await tabById(args.tabId);
      await cdp(tab.id, 'Network.enable').catch(() => null);
      const timeout = Number(args.timeoutMs || 15000);
      const idleMs = Number(args.idleMs || 600);
      const started = Date.now();
      let quietSince = null;
      while (Date.now() - started < timeout) {
        const n = obs.inflightOf(tab.id);
        if (n === 0) {
          if (quietSince == null) quietSince = Date.now();
          if (Date.now() - quietSince >= idleMs) {
            return { id: tab.id, idle: true, waitedMs: Date.now() - started, quietMs: Date.now() - quietSince };
          }
        } else {
          quietSince = null;
        }
        await sleep(100);
      }
      return { id: tab.id, idle: false, waitedMs: Date.now() - started, inflight: obs.inflightOf(tab.id), timeoutMs: timeout };
    }

    case 'extract': {
      const tab = await tabById(args.tabId);
      if (!args.selector) fail('E_PARAM', 'extract 需要 --selector <行容器选择器>', '例：--selector ".item"');
      if (!args.fields) fail('E_PARAM', 'extract 需要 --fields "name:sel[, name2:sel2@attr]"', '例：--fields "title:h3, link:a@href"');

      const fields = splitTopLevel(String(args.fields)).map((part) => {
        const s = part.trim();
        if (!s) return null;
        const i = s.indexOf(':');
        if (i < 0) return { name: s, sel: 'self', attr: null };
        const name = s.slice(0, i).trim();
        let rest = s.slice(i + 1).trim();
        let attr = null;
        const at = rest.indexOf('@');
        if (at >= 0) { attr = rest.slice(at + 1).trim() || null; rest = rest.slice(0, at).trim(); }
        return { name, sel: rest || 'self', attr };
      }).filter(Boolean);
      if (!fields.length) fail('E_PARAM', '--fields 解析为空', '例：--fields "name:h3, price:.price"');

      const limit = Number(args.limit || 50);
      const results = await frames.invokeAll(tab.id, 'rows', [String(args.selector), fields, limit, args.meta !== false]);
      const best = results
        .filter((r) => r.result && !r.result.__error)
        .sort((a, b) => (b.result.count || 0) - (a.result.count || 0))[0];
      if (!best) fail('E_EXTRACT', '抽取执行失败（页面可能未授权注入）', '先 open 目标页；特权页不可注入');
      const r = best.result;
      return {
        tabId: tab.id, frame: best.frameId, selector: args.selector,
        fields: fields.map((f) => f.name),
        count: r.count, returned: r.rows.length, truncated: r.count > r.rows.length,
        url: r.url, title: r.title, rows: r.rows
      };
    }

    case 'table': {
      const tab = await tabById(args.tabId);
      const idx = Number(args.index == null ? 0 : args.index);
      const lim = Number(args.limit == null ? 200 : args.limit);
      if (!Number.isInteger(idx) || idx < 0 || !Number.isFinite(lim) || lim < 1) {
        fail('E_PARAM', `table 的 index/limit 非法：index=${args.index} limit=${args.limit}`, 'index 从 0 开始；limit 为正整数');
      }
      const results = await frames.invokeAll(tab.id, 'table', [args.selector || null, idx, Math.floor(lim)]);
      const best = results.filter((r) => r.result && !r.result.__error && !r.result.error).sort((a, b) => (b.result.totalRows || 0) - (a.result.totalRows || 0))[0];
      if (!best) {
        const anyErr = results.find((r) => r.result && r.result.error);
        fail('E_NO_TABLE', anyErr ? anyErr.result.error : '页面上没找到表格',
          '先用 snapshot 或 eval 确认表格选择器；跨 iframe 的表格已支持，但需要页面允许注入');
      }
      const r = best.result;
      return {
        tabId: tab.id, frame: best.frameId, tablesFound: r.tablesFound, index: r.index,
        caption: r.caption || '', header: r.header, rowspanColspan: !!r.rowspanColspan,
        totalRows: r.totalRows, returned: r.rows.length, truncated: r.totalRows > r.rows.length,
        rows: r.rows
      };
    }

    case 'state': {
      const tab = await tabById(args.tabId);
      // 必须注入 MAIN world，页面自己的 __INITIAL_STATE__ 等全局才可见；
      // allFrames 让 iframe 里的 JSON-LD / 页面全局也能被汇总。
      let results = await frames.callAllWorld(tab.id, STATE_AGENT, [Number(args.maxLen || 6000)]).catch(() => []);
      let usable = results.filter((r) => r.result && Array.isArray(r.result.sources));
      if (!usable.length) {
        const one = await frames.callMainWorld(tab.id, STATE_AGENT, [Number(args.maxLen || 6000)]).catch(() => null);
        if (one && Array.isArray(one.sources)) usable = [{ frameId: 0, result: one }];
      }
      if (!usable.length) fail('E_STATE', '内嵌数据提取失败', '先 open 目标页面；chrome:// 等特权页不可注入');
      const main = usable.find((r) => r.frameId === 0) || usable[0];
      const sources = [];
      const frameMeta = [];
      for (const r of usable) {
        const d = r.result;
        frameMeta.push({ frameId: r.frameId, frame: frames.frameLabel(r.frameId), url: d.url, title: d.title, found: d.found || 0 });
        for (const s of d.sources) {
          sources.push({ ...s, frameId: r.frameId, frame: frames.frameLabel(r.frameId) || 'main', frameUrl: d.url });
        }
      }
      return {
        url: main.result.url, title: main.result.title,
        sources, meta: main.result.meta || {}, found: sources.length,
        ...(usable.length > 1 ? { frames: frameMeta } : {}),
        via: 'main-world'
      };
    }

    case 'assert': {
      const tab = await tabById(args.tabId);
      const spec = {
        selector: args.selector || null,
        text: args.text, value: args.value, attr: args.attr, equals: args.equals,
        count: args.count == null ? undefined : Number(args.count),
        visible: args.visible,
        exact: args.exact === true
      };
      if (spec.count === undefined) delete spec.count;
      if (args.ref != null) {
        const t = await resolveTarget(tab.id, args);
        spec.localRef = t.localRef;
        const r = await frames.invoke(tab.id, t.frameId, 'assertLocal', [spec]);
        return Object.assign({ ref: t.ref, pass: !!(r && r.pass) }, r || {});
      }
      // count 必须是整页汇总：逐 frame 的“任意一个通过”会让 count=0 在 iframe 有元素时误通过
      if (spec.count !== undefined && spec.selector) {
        const rs = await frames.invokeAll(tab.id, 'assertLocal', [{ selector: spec.selector, count: 0 }]);
        const actual = rs.reduce((s, r) => s + (r.result && Number(r.result.actual) || 0), 0);
        return { kind: 'count', pass: actual === Number(spec.count), actual, expected: Number(spec.count), frames: rs.length };
      }
      const results = await frames.invokeAll(tab.id, 'assertLocal', [spec]);
      const hits = results.filter((r) => r.result);
      const passed = hits.find((r) => r.result.pass === true);
      if (passed) return Object.assign({ frame: passed.frameId, pass: true }, passed.result);
      const first = hits[0];
      if (!first) fail('E_ASSERT', '断言执行失败', '确认选择器存在；跨 iframe 已支持');
      return Object.assign({ frame: first.frameId, pass: false }, first.result);
    }

    case 'session': {
      const mode = args.mode || 'list';
      const KEY = 'ark:session';
      const readIds = async () => {
        try {
          const g = await chrome.storage.session.get(KEY);
          return Array.isArray(g[KEY]) ? g[KEY] : [];
        } catch { return []; }
      };
      const writeIds = async (ids) => {
        try { await chrome.storage.session.set({ [KEY]: ids }); } catch { /* 忽略 */ }
      };

      if (mode === 'open') {
        const url = args.url || 'about:blank';
        const capture = args.capture !== false && url !== 'about:blank';
        const tab = await chrome.tabs.create({ url: capture ? 'about:blank' : url, active: args.active !== false });
        if (capture) {
          try {
            await ensureAttached(tab.id);
            obs.netBuf.set(tab.id, new Map());
            await chrome.tabs.update(tab.id, { url });
          } catch { /* 捕获失败仍继续打开 */ }
        }
        const ids = await readIds();
        ids.push(tab.id);
        await writeIds(ids);
        // 有 tabGroups 权限时顺手归组，没有就跳过——功能不依赖它
        let groupId = null;
        try {
          groupId = await chrome.tabs.group({ tabIds: [tab.id] });
          await chrome.tabGroups.update(groupId, { title: 'ark-web', color: 'blue' });
        } catch { groupId = null; }
        await setLastTab(tab.id);
        refs.reset(tab.id);
        if (args.waitLoad !== false) await waitLoad(tab.id, args.timeoutMs || 30000);
        await frames.prep(tab.id).catch(() => null);
        const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
        return { id: tab.id, url: fresh.url || tab.url || '', title: fresh.title || '', groupId };
      }

      const ids = await readIds();
      const alive = [];
      for (const id of ids) {
        try {
          const t = await chrome.tabs.get(id);
          alive.push({ id, url: t.url, title: t.title });
        } catch { /* 已被关闭 */ }
      }
      if (mode === 'close') {
        let closed = 0;
        for (const t of alive) {
          try { await chrome.tabs.remove(t.id); closed++; } catch { /* 忽略 */ }
        }
        await writeIds([]);
        return { closed };
      }
      await writeIds(alive.map((t) => t.id));
      return { count: alive.length, tabs: alive };
    }

    case 'cdp': {
      const tab = await tabById(args.tabId);
      if (!args.method) fail('E_PARAM', 'cdp 需要 method', '例: cdp Runtime.evaluate --params \'{"expression":"1+1"}\'');
      const r = await cdp(tab.id, String(args.method), args.params || {});
      const text = JSON.stringify(r == null ? null : r);
      const maxLen = Number(args.maxLen || 4000);
      return { tabId: tab.id, method: args.method, bytes: text.length, truncated: text.length > maxLen, result: text.length > maxLen ? text.slice(0, maxLen) + '…' : JSON.parse(text) };
    }

    default:
      fail('E_UNKNOWN_CMD', `未知命令: ${cmd}`, '跑 describe 看全部命令');
  }
}
