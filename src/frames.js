/**
 * 跨 frame 编排层
 *
 * 页面代理（page-agent）注入到每个 frame，这里负责：
 *   - 把指令广播到所有 frame、把结果合并回一个视图
 *   - 分配全局唯一的 ref，并把编号回写给各 frame 的池
 *   - 通过 ref 反查它属于哪个 frame、在池里的哪个位置
 *
 * 有了这一层，跨域 iframe 与 shadow DOM 里的元素和主文档元素在调用方看来完全一样。
 */

import { PAGE_AGENT, AGENT_VERSION } from './page-agent.js';
import * as refs from './refs.js';
import { cdp } from './cdp.js';

const viewport = new Map(); // tabId -> { vw, vh }
const prepped = new Set();  // 已注入页面代理的 tab

export const mainViewport = (tabId) => viewport.get(tabId) || null;
export const frameLabel = (frameId) => (frameId === 0 ? '' : 'f' + frameId);

/** 导航后必须清掉注入标记，否则新文档里其实没有代理 */
export function resetInjection(tabId) {
  prepped.delete(tabId);
  viewport.delete(tabId);
}

/**
 * 确保每个 frame 都装了页面代理（导航后自动重装、后插入的 iframe 会被补装）。
 *
 * 不能「注入过就跳过」——那样后出现的 iframe 永远没有代理（实测踩过：
 * 页面弹出一个跨域 iframe 后，find/wait 全盲）。也不该每次重注入 31KB：
 * 先用极小的探针问每个 frame「有 __ark 吗」，只给缺的补装。
 * 全都有时，开销只是一次几毫秒的探测。
 */
export async function prep(tabId, force = false) {
  if (!force) {
    let missing = null;
    try {
      const probes = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (v) => !!(window.__ark && window.__ark.version === v),
        args: [AGENT_VERSION]
      });
      missing = (probes || []).filter((r) => !r || r.result !== true);
    } catch { missing = null; }   // 探测失败就退回全量注入
    if (missing && missing.length === 0) {
      prepped.add(tabId);
      return true;
    }
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: PAGE_AGENT });
    prepped.add(tabId);
    return true;
  } catch (e) {
    const err = new Error(`页面脚本注入失败：${String(e && e.message || e)}`);
    err.code = 'E_INJECT';
    err.hint = 'chrome:// 等特权页、扩展商店、PDF 内嵌页不可操作；先导航到普通网页再试';
    throw err;
  }
}

export async function callAll(tabId, fn, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: fn, args });
  return (res || [])
    .filter((r) => r && r.result !== null && r.result !== undefined)
    .map((r) => ({ frameId: r.frameId, result: r.result }));
}

export async function callMain(tabId, fn, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
  return res && res[0] ? res[0].result : null;
}

/** 在页面主世界执行只读函数（用于读取 __INITIAL_STATE__ 等页面全局） */
export async function callMainWorld(tabId, fn, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args, world: 'MAIN' });
  return res && res[0] ? res[0].result : null;
}

/** 在所有 frame 的主世界执行只读函数（state 跨 frame 聚合） */
export async function callAllWorld(tabId, fn, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: fn, args, world: 'MAIN' });
  return (res || [])
    .filter((r) => r && r.result !== null && r.result !== undefined)
    .map((r) => ({ frameId: r.frameId, result: r.result }));
}

export async function callFrame(tabId, frameId, fn, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fn, args });
  return res && res[0] ? res[0].result : null;
}

/** 统一的 ref 分配：复用 frame 里已有的编号，新增的从全局序号往后排 */
async function assign(tabId, frames, pickItems) {
  let seq = refs.nextSeq(tabId);
  const used = new Set();
  const pairsByFrame = new Map();
  const reg = new Map();
  const out = [];

  for (const f of frames) {
    const items = pickItems(f.result);
    if (!items || !items.length) continue;
    const pairs = [];
    for (const it of items) {
      let ref = it.prevRef && !used.has(it.prevRef) ? it.prevRef : 0;
      if (ref) {
        // 复用旧编号时同步推进序号，避免后续新编号与已复用的高位编号碰撞
        if (ref > seq) seq = ref;
      } else {
        do { ref = ++seq; } while (used.has(ref));
      }
      used.add(ref);
      pairs.push([it.localRef, ref]);
      reg.set(ref, {
        frameId: f.frameId, localRef: it.localRef,
        tag: it.tag, text: it.text, role: it.role || null, href: it.href || null,
        sig: refs.sigOf(it.tag, it.text), at: Date.now()
      });
      out.push(Object.assign({}, it, { ref, frameId: f.frameId, frame: frameLabel(f.frameId) }));
    }
    if (pairs.length) pairsByFrame.set(f.frameId, pairs);
  }

  refs.merge(tabId, reg);
  refs.bumpSeq(tabId, seq);

  await Promise.all(
    [...pairsByFrame.entries()].map(([fid, ps]) =>
      callFrame(tabId, fid, (list) => (window.__ark ? window.__ark.assignRefs(list) : 0), [ps]).catch(() => null)
    )
  );

  return out;
}

export async function collectAll(tabId, opts = {}) {
  await prep(tabId);
  const frames = await callAll(tabId, (o) => (window.__ark ? window.__ark.collect(o) : null), [opts]);
  const main = frames.find((f) => f.frameId === 0);
  const page = main && main.result
    ? {
      url: main.result.url, title: main.result.title,
      vw: main.result.vw, vh: main.result.vh,
      scrollX: main.result.scrollX, scrollY: main.result.scrollY,
      vis: main.result.vis, dpr: main.result.dpr
    }
    : { url: '', title: '', vw: 0, vh: 0, scrollX: 0, scrollY: 0, vis: 'visible', dpr: 1 };
  if (page.vw) viewport.set(tabId, { vw: page.vw, vh: page.vh });

  const elements = await assign(tabId, frames, (d) => (d && d.elements) || null);
  // 补上每个元素所属 frame 的偏移（用于把子 frame 坐标换算到顶层视口）
  const offs = new Map(frames.map((f) => [f.frameId, (f.result && f.result.offset) || null]));
  for (const e of elements) e.offset = offs.get(e.frameId) || null;

  const frameList = frames.map((f) => ({
    frameId: f.frameId,
    url: f.result && f.result.url,
    title: f.result && f.result.title,
    count: (f.result && f.result.count) || 0
  })).filter((f) => f.frameId === 0 || f.count > 0);

  return { page, elements, frames: frameList, multiFrame: frameList.length > 1 };
}

export async function findAll(tabId, q, opts = {}) {
  await prep(tabId);
  const frames = await callAll(tabId, (a) => (window.__ark ? window.__ark.find(a.q, a.o) : null), [{ q, o: opts }]);
  const items = await assign(tabId, frames, (d) => (d && d.items) || null);
  items.sort((a, b) => b.score - a.score);
  const total = frames.reduce((s, f) => s + ((f.result && f.result.total) || 0), 0);
  const limit = Math.max(1, Number(opts.limit || 5));
  return { items: items.slice(0, limit), total, frames: frames.length };
}

/** 按 ref 找到元素并取其实时状态；顺便做指纹校验 */
export async function probeRef(tabId, ref, opts = {}) {
  await refs.ensureLoaded(tabId);
  if (!prepped.has(tabId)) await prep(tabId);
  const entry = refs.get(tabId, ref);
  if (!entry) {
    const e = new Error(`未知 ref=${ref}`);
    e.code = 'E_UNKNOWN_REF';
    e.hint = '先跑 snapshot 或 find 拿最新编号；页面导航后 ref 会全部失效';
    throw e;
  }
  const info = await callFrame(tabId, entry.frameId, (i) => (window.__ark ? window.__ark.probe(i) : null), [entry.localRef]);
  if (!info || info.missing) {
    const e = new Error(`ref=${ref} 指向的元素已从页面移除`);
    e.code = 'E_NOT_FOUND';
    e.hint = entry.frameId === 0 ? '页面可能已重渲染，重跑 snapshot' : '子框架可能已卸载，重跑 snapshot';
    throw e;
  }
  const drift = opts.force ? null : refs.checkDrift(entry, info);
  return { entry, info, drift };
}

/**
 * 跨域 frame 的顶层视口偏移。
 *
 * 同源 frame 由页面代理沿着 window.frameElement 自己累加；跨域拿不到，只能靠 CDP：
 *   Page.getFrameTree  → 拿到 frame 树（CDP 的 frameId 是字符串）
 *   DOM.getFrameOwner  → frame 对应的 <iframe> 节点
 *   DOM.getBoxModel    → 该节点在**父文档坐标系**里的位置
 * 再减去父 frame 的滚动量、加上父 frame 自身的偏移，逐层累加到顶层。
 *
 * 难点是 chrome.scripting 的 frameId（整数）与 CDP 的 frameId（字符串）没有直接映射，
 * 这里用「frame 的 URL」对齐；同 URL 多个 frame 时按出现顺序取未使用的那个。
 * 每次动作现算（不缓存）：滚动/布局变化都会让偏移失效，几十毫秒换正确性值得。
 */
export async function frameOffsetOf(tabId, frameId) {
  if (Number(frameId) === 0) return { x: 0, y: 0 };
  try {
    const tree = await cdp(tabId, 'Page.getFrameTree');
    if (!tree || !tree.frameTree) return null;
    await cdp(tabId, 'DOM.enable').catch(() => null);

    const hrefs = await callAll(tabId, () => location.href).catch(() => []);
    const byUrl = new Map();
    for (const h of hrefs) {
      const k = String(h.result || '');
      if (!byUrl.has(k)) byUrl.set(k, []);
      byUrl.get(k).push(h.frameId);
    }

    const nodes = [];
    const walk = (n, parent) => {
      nodes.push({ cdpId: n.frame.id, url: n.frame.url || '', parent });
      for (const c of n.childFrames || []) walk(c, n.frame.id);
    };
    walk(tree.frameTree, null);

    const rootCdp = nodes[0].cdpId;
    const cdpToChrome = new Map([[rootCdp, 0]]);
    const usedChrome = new Set([0]);
    for (const n of nodes) {
      if (n.parent == null) continue;
      const pick = (byUrl.get(n.url) || []).find((id) => !usedChrome.has(id));
      if (pick != null) { cdpToChrome.set(n.cdpId, pick); usedChrome.add(pick); }
    }

    const offByCdp = new Map([[rootCdp, { x: 0, y: 0 }]]);
    for (const n of nodes) {
      if (n.parent == null) continue;
      const parentOff = offByCdp.get(n.parent);
      if (!parentOff) continue;
      const owner = await cdp(tabId, 'DOM.getFrameOwner', { frameId: n.cdpId }).catch(() => null);
      if (!owner || owner.backendNodeId == null) continue;
      const box = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }).catch(() => null);
      const content = box && box.model && box.model.content;
      if (!content || content.length < 2) continue;

      const parentChrome = cdpToChrome.get(n.parent);
      const sc = await callFrame(tabId, parentChrome, () => ({ x: scrollX, y: scrollY }))
        .catch(() => ({ x: 0, y: 0 }));
      const off = { x: parentOff.x + content[0] - (sc ? sc.x : 0), y: parentOff.y + content[1] - (sc ? sc.y : 0) };
      offByCdp.set(n.cdpId, off);
      const chromeId = cdpToChrome.get(n.cdpId);
      if (chromeId != null && chromeId === Number(frameId)) return off;
    }
    return null;
  } catch { return null; }
}

/** 在某个 frame 里执行页面代理的某个方法 */
export async function invoke(tabId, frameId, method, args = []) {
  const run = () => callFrame(tabId, frameId, (a) => {
    if (!window.__ark || typeof window.__ark[a.m] !== 'function') return null;
    try { return window.__ark[a.m](...a.args); } catch (e) { return { __error: String(e && e.message || e) }; }
  }, [{ m: method, args }]);
  // 每次都先 prep：后插入的 iframe 也要有代理；prep 内部先探测，没缺的就不重注入
  await prep(tabId);
  let r = await run();
  // null 说明这一帧还没有代理（探测/注入之间的竞态、导航中），强制装一次再来
  if (r === null) { await prep(tabId, true); r = await run(); }
  return r;
}

/** 广播到所有 frame 执行某方法 */
export async function invokeAll(tabId, method, args = []) {
  const run = () => callAll(tabId, (a) => {
    if (!window.__ark || typeof window.__ark[a.m] !== 'function') return null;
    try { return window.__ark[a.m](...a.args); } catch (e) { return { __error: String(e && e.message || e) }; }
  }, [{ m: method, args }]);
  // 同上：新出现的 iframe 必须能补上代理，否则轮询类命令永远看不到它
  await prep(tabId);
  let res = await run();
  if (!res.length) { await prep(tabId, true); res = await run(); }
  return res;
}
