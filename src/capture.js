/**
 * 截图
 *
 * 四个坑这次一次填平：
 *  1. 元素截图的 clip 必须用**文档坐标**（视口坐标 + 滚动量），否则页面一滚动就截到空白区。
 *  2. 后台/最小化标签不出帧：分级超时（900→2500→8000ms）+ 窗口状态预判，直接给 E_TAB_HIDDEN。
 *  3. 默认不抢焦点；只有显式 focus:true 才聚焦窗口。
 *  4. 纯色帧（渲染器没出帧的竞态）自动重试，仍纯色则带 uniform 标记返回，不误报错误。
 */

import { cdp, ensureFocusEmulation, releaseFocusEmulation, getDeviceMetrics } from './cdp.js';
import { callMain, invoke } from './frames.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 纯色帧检测：滚动后渲染器可能还没出帧，截到的是一张纯色图（实测 824 字节的 webp）。
 * 解码后缩到 128x128 算亮度极差，≈0 即纯色；解码失败按非纯色处理（宁可多等不误报）。
 */
async function isUniform(base64) {
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return false;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes]));
    const S = 128;
    const canvas = new OffscreenCanvas(S, S);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, S, S);
    bmp.close();
    const d = ctx.getImageData(0, 0, S, S).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (l < min) min = l;
      if (l > max) max = l;
    }
    return max - min < 6;
  } catch { return false; }
}

/**
 * 视觉差异：把两张截图缩到 160x160 逐像素比，返回变化百分比与归一化包围盒。
 * 用于「改完样式/操作之后画面到底变没变」——比肉眼看两份截图可靠。
 */
export async function imageDiff(aB64, bB64) {
  try {
    const toBitmap = async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return createImageBitmap(new Blob([bytes]));
    };
    const [A, B] = await Promise.all([toBitmap(aB64), toBitmap(bB64)]);
    const S = 160;
    const ca = new OffscreenCanvas(S, S);
    const cb = new OffscreenCanvas(S, S);
    const xa = ca.getContext('2d', { willReadFrequently: true });
    const xb = cb.getContext('2d', { willReadFrequently: true });
    xa.drawImage(A, 0, 0, S, S);
    xb.drawImage(B, 0, 0, S, S);
    A.close(); B.close();
    const da = xa.getImageData(0, 0, S, S).data;
    const db = xb.getImageData(0, 0, S, S).data;

    let changed = 0;
    let minX = S, minY = S, maxX = -1, maxY = -1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        if (d > 24) {
          changed++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    const total = S * S;
    return {
      changedPct: Math.round((changed / total) * 1000) / 10,
      changedPixels: changed,
      bbox: maxX >= 0
        ? { x: +(minX / S).toFixed(3), y: +(minY / S).toFixed(3), w: +((maxX - minX + 1) / S).toFixed(3), h: +((maxY - minY + 1) / S).toFixed(3) }
        : null
    };
  } catch { return null; }
}

export async function probeViewport(tabId) {
  return callMain(tabId, () => ({
    vw: innerWidth, vh: innerHeight,
    dpr: window.devicePixelRatio || 1,
    vis: document.visibilityState,
    sx: window.scrollX, sy: window.scrollY
  })).catch(() => ({ vw: 0, vh: 0, dpr: 1, vis: 'visible', sx: 0, sy: 0 }));
}

export async function captureShot(tabId, args = {}) {
  const fmt = args.format || 'webp';
  const quality = args.quality == null ? 80 : Number(args.quality);
  const allowFocus = args.focus === true;

  let forced = null;
  let kicked = null;
  // 调用方（snapshot）已经把视口数据算过了就复用，省一次跨 frame 往返
  let vp = args.viewport && args.viewport.vw
    ? { vw: args.viewport.vw, vh: args.viewport.vh, dpr: args.viewport.dpr || 1, vis: args.viewport.vis || 'visible', sx: args.viewport.sx || 0, sy: args.viewport.sy || 0 }
    : await probeViewport(tabId);

  // 窗口最小化时合成器一定不产帧：不要拿到上一帧纯色图就误报成功。
  // 这一步必须在任何设备覆盖之前，否则失败路径会留下临时 metrics override。
  let winMin = false;
  try {
    const t = await chrome.tabs.get(tabId);
    const w = await chrome.windows.get(t.windowId);
    winMin = w && w.state === 'minimized';
  } catch { /* 拿不到窗口状态就按正常流程走 */ }

  if (winMin) {
    if (!allowFocus) {
      const err = new Error('浏览器窗口处于最小化状态，Chrome 不为最小化窗口合成新帧');
      err.code = 'E_TAB_HIDDEN';
      err.hint = '先 activate 该标签切到前台；或加 --focus 让扩展临时聚焦窗口截图';
      throw err;
    }
    try {
      await chrome.tabs.update(tabId, { active: true });
      const t = await chrome.tabs.get(tabId);
      if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true, state: 'normal' });
      await sleep(420);
      vp = await probeViewport(tabId);
      winMin = false;
    } catch { /* 聚焦失败就继续尝试截图 */ }
  }

  // 已有 emulate 设备覆盖时，390×844 是用户要的移动端尺寸，不是“窗口过小”。
  // 绝不能用视口尺寸作为最小化代理，否则一次截图就会把模拟清掉。
  const existingOverride = getDeviceMetrics(tabId);
  if (!existingOverride && vp.vw && (vp.vw < 400 || vp.vh < 200)) {
    const W = Number(args.width || 1440);
    const H = Number(args.height || 900);
    try {
      await cdp(tabId, 'Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 0, mobile: false });
      forced = { width: W, height: H, from: { w: vp.vw, h: vp.vh } };
      await sleep(320);
      vp = await probeViewport(tabId);
    } catch { /* 特权页忽略 */ }
  }

  let hidden = vp.vis === 'hidden';
  // 窗口被遮挡时页面被判为 hidden：先让页面「相信」自己可见，截图与输入才成立
  if (hidden) await ensureFocusEmulation(tabId);

  let clip = null;
  let labelItems = null;

  try {
    if (args.full === true) {
      // 整页：用布局度量拿文档尺寸，clip 用文档坐标
      try {
        const m = await cdp(tabId, 'Page.getLayoutMetrics');
        const size = m.cssContentSize || m.contentSize || { width: vp.vw, height: vp.vh };
        clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      } catch { clip = null; }
    } else if (args.rect && args.rect.w > 0 && args.rect.h > 0) {
      // 元素截图：视口坐标 + 滚动量 = 文档坐标（旧实现漏了这一步）
      clip = {
        x: Math.max(0, args.rect.x + vp.sx),
        y: Math.max(0, args.rect.y + vp.sy),
        width: Math.max(1, args.rect.w),
        height: Math.max(1, args.rect.h),
        scale: Number(args.rect.scale || 1)
      };
    }

    // 元素截图常发生在「刚滚动到目标」之后：给合成器一点出帧时间，避免拿到上一帧
    if (args.rect) await sleep(120);

    // 视觉编号只在「视口截图」时叠加：整页/元素截图里 fixed 定位的编号会错位
    if (Array.isArray(args.labels) && args.labels.length && !clip) {
      labelItems = args.labels;
      await invoke(tabId, 0, 'label', [labelItems, {}]).catch(() => null);
      await sleep(60);
    }

    // 分级超时：以前一律盲等 8 秒，被遮挡时最坏累计 27 秒才回错。
    // 现在先 900ms 快探（正常窗口足够出帧），失败才升级；最小化窗口直接跳过快探。
    const userTimeout = Number(args.timeoutMs || 0);
    const T1 = userTimeout || 900;
    const T2 = userTimeout || 2500;
    const T3 = userTimeout || 8000;

    const doCapture = (timeoutMs, extra = {}) => Promise.race([
      cdp(tabId, 'Page.captureScreenshot', {
        format: fmt,
        quality,
        captureBeyondViewport: !!clip,
        ...(clip ? { clip } : {}),
        ...extra
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
    ]);

    // 纯色帧 = 渲染器没出帧（滚动竞态/被遮挡）。重试两次；仍纯色就带 uniform 标记返回，
    // 不报错——元素本身可能就是纯色的（空按钮、色块），误报比多等 300ms 更糟。
    const finish = async (r, extra = {}, retryTimeout = T2) => {
      // 极小的 webp（<200 字符）通常意味着空帧/1px 图；即使解码失败也按可疑帧重试，
      // 避免把“渲染器还没出帧”当成成功返回。
      const suspicious = (x) => !x || x.length < 200;
      let uniform = suspicious(r.data) || await isUniform(r.data);
      let retried = 0;
      while (uniform && retried < 2) {
        retried++;
        await sleep(150);
        try { r = await doCapture(retryTimeout); uniform = suspicious(r.data) || await isUniform(r.data); } catch { break; }
      }
      return {
        base64: r.data, format: fmt, clip, viewportForced: forced,
        vw: vp.vw, vh: vp.vh, dpr: vp.dpr, hidden,
        ...(uniform ? { uniform: true } : {}),
        ...(retried ? { blankRetries: retried } : {}),
        ...extra
      };
    };

    try {
      const r = await doCapture(winMin ? T2 : T1);
      return await finish(r, { focused: false }, T2);
    } catch (e1) {
      const isTimeout = String(e1 && e1.message) === 'timeout';

      // 被遮挡的窗口即使页面自认可见，合成器也可能不产新帧。
      // 强制一次设备度量覆盖 = 触发一次布局提交，通常能把渲染器叫醒。
      if (isTimeout) {
        try {
          const W = Math.max(800, vp.vw || 1440);
          const H = Math.max(600, vp.vh || 900);
          await cdp(tabId, 'Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 0, mobile: false });
          kicked = { width: W, height: H };
          await sleep(260);
          const r2 = await doCapture(T2);
          return await finish(r2, { focused: false, kicked: true }, T2);
        } catch { /* 继续走后面的兜底 */ }
      }

      // 最小化/后台：合成器确定不出帧，再等下去只是浪费调用方的时间
      if (isTimeout && (winMin || hidden) && !allowFocus) {
        const err = new Error(winMin
          ? '浏览器窗口处于最小化状态，Chrome 不为最小化窗口合成新帧'
          : '标签页在后台（visibilityState=hidden），Chrome 不为隐藏页合成新帧');
        err.code = 'E_TAB_HIDDEN';
        err.hint = '先 activate 该标签切到前台；或加 --focus 让扩展临时聚焦窗口截图';
        throw err;
      }
      if (!isTimeout || !allowFocus) {
        if (isTimeout) {
          const err = new Error('截图超时：浏览器窗口被遮挡，渲染器不产新帧（已尝试快探与唤醒）');
          err.code = 'E_OCCLUDED';
          err.hint = '把浏览器窗口切到前台，或加 --focus 让扩展临时聚焦（会打断当前操作）';
          throw err;
        }
        throw e1;
      }
      try {
        await chrome.tabs.update(tabId, { active: true });
        const t = await chrome.tabs.get(tabId);
        if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true, state: 'normal' });
        await sleep(420);
      } catch { /* 聚焦失败就继续尝试截图 */ }
      const r = await doCapture(userTimeout || T3);
      return await finish(r, { focused: true }, T2);
    }
  } finally {
    await releaseFocusEmulation(tabId).catch(() => null);
    if (labelItems) await invoke(tabId, 0, 'clearLabels', []).catch(() => null);
    // 只恢复自己动过的覆盖：有 emulate 时恢复原参数，没有才清空
    if (kicked || forced) {
      if (existingOverride) {
        await cdp(tabId, 'Emulation.setDeviceMetricsOverride', existingOverride).catch(() => {});
      } else {
        await cdp(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
    }
  }
}
