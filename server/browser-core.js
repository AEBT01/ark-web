/**
 * Ark Browser Core — CDP 直连控制内核
 *
 * 为什么存在：
 *   BrowserOS 自带 CDP 调试端口（127.0.0.1:9110，它自己的 Rust sidecar 就用它驱动浏览器）。
 *   直连内核意味着：
 *     · 不再受扩展 API 的白名单裁剪（扩展拿不到 chrome:// 页、拿不到 Browser 域）
 *     · 不依赖扩展生命周期（重载/休眠/僵尸连接都不再影响控制能力）
 *     · 能力面 = 完整 CDP 协议（Target/Page/Runtime/Input/DOM/Network/Emulation/Storage…）
 *
 * 架构位置：本模块是**控制层内核**，位于能力插件（tool-registry）之下、浏览器之上。
 *           工具插件可以直接调用它，也可以继续走扩展通道 —— 两条通道并存、按需选择。
 *
 * 设计约束：
 *   · 零依赖外部 CDP 库（仅用 ws，server 已有）；协议封装保持薄、透明、可调试
 *   · 每个能力都返回"可直接交给模型"的紧凑结果（不含巨大的 base64、不含内部字段）
 *   · 连接自愈：断开后下次调用自动重连
 */
const WebSocket = require('ws');

const DEFAULT_TIMEOUT = 30000;

class CdpCore {
  constructor(opts) {
    const o = opts || {};
    this.host = o.host || '127.0.0.1';
    this.port = o.port || 9110;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();     // id -> { resolve, reject, timer }
    this.sessions = new Map();    // targetId -> sessionId
    this.handlers = new Map();    // method -> [fn]
    this.connecting = null;
    // 后台标签页的视口覆盖（见 ensureVisible）：不改前台状态，只改该 target 的布局视口
    this.overrideSize = {
      width: o.overrideWidth || 1280,
      height: o.overrideHeight || 900,
      dsf: o.overrideScale || 1
    };
    this.overridden = new Set();  // 当前被施加覆盖的 targetId，用于收尾清理
  }

  // ─────────────── 连接管理 ───────────────

  get httpBase() { return 'http://' + this.host + ':' + this.port; }

  /** 探测端点是否可用（BrowserOS 是否在运行） */
  async probe() {
    try {
      const r = await fetch(this.httpBase + '/json/version', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return { ok: false, status: r.status };
      const j = await r.json();
      return { ok: true, browser: j.Browser, protocol: j['Protocol-Version'], wsUrl: j.webSocketDebuggerUrl };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const info = await this.probe();
      if (!info.ok || !info.wsUrl) {
        throw new Error('CDP 不可用（BrowserOS 未运行或未开启调试端口 ' + this.port + '）：' + (info.error || ('HTTP ' + info.status)));
      }
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(info.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
        const fail = (e) => { reject(new Error('CDP 连接失败: ' + ((e && e.message) || e))); };
        ws.once('open', () => { this.ws = ws; resolve(); });
        ws.once('error', fail);
        ws.on('message', (d) => this._onMessage(d));
        ws.on('close', () => {
          this.ws = null;
          this.sessions.clear();
          for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP 连接已断开')); }
          this.pending.clear();
        });
      });
      return this;
    })();
    try { await this.connecting; } finally { this.connecting = null; }
    return this;
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error((msg.error && msg.error.message) || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const hs = this.handlers.get(msg.method);
      if (hs) hs.forEach((h) => { try { h(msg.params, msg.sessionId); } catch (e) { /* ignore */ } });
    }
  }

  /** 发送 CDP 命令（sessionId 缺省为浏览器级） */
  async send(method, params, sessionId) {
    await this.connect();
    const id = ++this.msgId;
    const payload = { id: id, method: method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 命令超时（' + method + '）'));
      }, DEFAULT_TIMEOUT);
      this.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => {
      const arr = this.handlers.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** 等待某事件一次（带超时） */
  once(method, timeout) {
    return new Promise((resolve) => {
      const off = this.on(method, (params) => { off(); resolve(params); });
      if (timeout) setTimeout(() => { off(); resolve(null); }, timeout);
    });
  }

  // ─────────────── Target（标签页）───────────────

  async targets() {
    const r = await this.send('Target.getTargets');
    return r.targetInfos || [];
  }

  /** 页面类 target（真实网页，排除扩展页与工作线程） */
  async pages(includeInternal) {
    const list = await this.targets();
    return list.filter(function (t) {
      if (t.type !== 'page') return false;
      if (includeInternal) return true;
      return /^https?:/i.test(t.url || '');
    }).map(function (t) {
      return { id: t.targetId, url: t.url, title: t.title, attached: !!t.attached, type: t.type };
    });
  }

  /** 附加到 target，返回 sessionId（后续命令都带它） */
  async attach(targetId) {
    if (this.sessions.has(targetId)) return this.sessions.get(targetId);
    await this.connect();
    const r = await this.send('Target.attachToTarget', { targetId: targetId, flatten: true });
    this.sessions.set(targetId, r.sessionId);
    return r.sessionId;
  }

  async detach(targetId) {
    const sid = this.sessions.get(targetId);
    if (sid) {
      this.sessions.delete(targetId);
      await this.send('Target.detachFromTarget', { sessionId: sid }).catch(function () { });
    }
  }

  async createTarget(url) {
    const r = await this.send('Target.createTarget', { url: url || 'about:blank' });
    return r.targetId;
  }

  async closeTarget(targetId) {
    await this.send('Target.closeTarget', { targetId: targetId });
    this.sessions.delete(targetId);
    return true;
  }

  async activateTarget(targetId) { return this.send('Target.activateTarget', { targetId: targetId }); }

  /**
   * 确保目标页处于可渲染状态 —— **不抢占前台**。
   *
   * 问题：后台标签页被浏览器节流，视口变为 0×0，导致 captureScreenshot 挂起、
   * getBoundingClientRect 返回布局坐标而非视口坐标（真实点击会打偏）。
   *
   * 过去用 Target.activateTarget 解决 —— 但那会把标签页切到前台、抢走用户当前的工作焦点。
   * Agent 在后台干活时打扰用户是不可接受的，因此改为给目标页施加**设备度量覆盖**：
   * 这是 CDP 的 Emulation 域能力，只影响该 target 的布局视口，不改变前台状态。
   *
   * 覆盖是"按需施加、用完即清"（见 clearViewportOverride）：不清的话，
   * 用户之后手动切到该标签页会看到被改过尺寸的渲染。
   */
  async ensureVisible(targetId) {
    const sid = await this.attach(targetId);
    const r = await this.send('Runtime.evaluate', { expression: 'innerWidth*innerHeight', returnByValue: true }, sid);
    if (((r.result && r.result.value) || 0) > 0) return { ok: true, alreadyVisible: true };

    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.overrideSize.width,
      height: this.overrideSize.height,
      deviceScaleFactor: this.overrideSize.dsf,
      mobile: false
    }, sid);
    await new Promise(function (x) { setTimeout(x, 250); });

    const r2 = await this.send('Runtime.evaluate', { expression: 'innerWidth*innerHeight', returnByValue: true }, sid);
    const ok = ((r2.result && r2.result.value) || 0) > 0;
    if (ok) this.overridden.add(targetId);
    return { ok: ok, viaOverride: true, size: this.overrideSize.width + 'x' + this.overrideSize.height };
  }

  /**
   * 撤销由 ensureVisible 施加的设备度量覆盖（对未被覆盖的 target 是空操作）。
   * 主动调用场景：任务结束、端点响应完成、或用户显式要求切回前台时。
   */
  async clearViewportOverride(targetId) {
    if (!this.overridden.has(targetId)) return { ok: true, changed: false };
    try {
      const sid = await this.attach(targetId);
      await this.send('Emulation.clearDeviceMetricsOverride', {}, sid);
    } catch (e) { /* target 可能已关闭，忽略 */ }
    this.overridden.delete(targetId);
    return { ok: true, changed: true };
  }

  /** 批量撤销（任务收尾用） */
  async clearAllViewportOverrides() {
    const ids = [...this.overridden];
    for (const id of ids) await this.clearViewportOverride(id).catch(function () { });
    return { cleared: ids.length };
  }

  /**
   * 在"必要的视口保障"下执行一次操作，结束后撤销为保障而施加的覆盖。
   *
   * 为什么按次清除：覆盖若长期挂着，用户之后手动切到该标签页会看到被改过尺寸的渲染。
   * 后台标签页此时不参与显示，因此"施加→操作→撤销"这几百毫秒对用户不可见。
   * 已在覆盖中的 target（同一操作链的后续步骤）不会被提前撤销。
   */
  async withViewport(targetId, fn) {
    const hadOverride = this.overridden.has(targetId);
    await this.ensureVisible(targetId);
    try {
      return await fn();
    } finally {
      if (!hadOverride && this.overridden.has(targetId)) {
        await this.clearViewportOverride(targetId).catch(function () { });
      }
    }
  }

  /** 找到 label（用户视角）最匹配的页面：活动页优先 */
  async activePage() {
    const list = await this.targets();
    const http = list.filter(function (t) { return t.type === 'page' && /^https?:/i.test(t.url || ''); });
    const active = http.find(function (t) { return t.attached; }) || http[0];
    return active ? { id: active.targetId, url: active.url, title: active.title } : null;
  }

  // ─────────────── Page ───────────────

  async navigate(url, targetId, timeout) {
    const sid = await this.attach(targetId);
    await this.send('Page.enable', {}, sid).catch(function () { });
    const load = this.once('Page.loadEventFired', timeout || 25000);
    const r = await this.send('Page.navigate', { url: url }, sid);
    if (r.errorText) throw new Error('导航失败: ' + r.errorText);
    await load;
    return { url: url, frameId: r.frameId };
  }

  async reload(targetId) {
    const sid = await this.attach(targetId);
    const load = this.once('Page.loadEventFired', 25000);
    await this.send('Page.reload', {}, sid);
    await load;
    return { ok: true };
  }

  async goBack(targetId) {
    const sid = await this.attach(targetId);
    const h = await this.send('Page.getNavigationHistory', {}, sid);
    if (!h || h.currentIndex <= 0) return { ok: false, error: '没有上一页' };
    const entry = h.entries[h.currentIndex - 1];
    const load = this.once('Page.loadEventFired', 25000);
    await this.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sid);
    await load;
    return { ok: true, url: entry.url };
  }

  /** 页面可见文本（走 DOM 而非 innerText：更快且不触发重排） */
  async visibleText(targetId, selector) {
    const sid = await this.attach(targetId);
    const expr = selector
      ? '(()=>{const e=document.querySelector(%s);return e?e.innerText:null})()'.replace('%s', JSON.stringify(selector))
      : 'document.body?document.body.innerText:""';
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
    return (r.result && r.result.value) || '';
  }

  async pageInfo(targetId) {
    const sid = await this.attach(targetId);
    const r = await this.send('Runtime.evaluate', {
      expression: 'JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,lang:document.documentElement.lang,vw:innerWidth,vh:innerHeight,dpr:devicePixelRatio,links:document.links.length,forms:document.forms.length,inputs:document.querySelectorAll("input,textarea,select").length})',
      returnByValue: true
    }, sid);
    try { return JSON.parse(r.result.value); } catch (e) { return { url: '', title: '' }; }
  }

  async screenshot(targetId, opts) {
    const o = opts || {};
    // 后台标签页会让截图挂起：用视口覆盖保障，操作后撤销（不切前台、不打扰用户）
    return this.withViewport(targetId, async () => {
      const sid = await this.attach(targetId);
      const params = { format: o.format || 'png' };
      if (o.quality && (o.format === 'jpeg' || o.format === 'webp')) params.quality = o.quality;
      if (o.full) params.captureBeyondViewport = true;
      if (o.clip) params.clip = o.clip;
      // 长期后台的标签页即使有视口覆盖也可能不产帧（渲染器被节流）。
      // captureBeyondViewport 直接离屏渲染，不依赖合成器出帧 —— 对后台页可靠得多。
      if (this.overridden.has(targetId) || o.full) params.captureBeyondViewport = true;
      // 带超时的竞速：万一渲染器仍不出帧，返回明确错误而不是挂死整个调用链
      const shot = await Promise.race([
        this.send('Page.captureScreenshot', params, sid),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Page.captureScreenshot 超时（后台标签页渲染停滞）')), o.timeout || 20000))
      ]);
      return shot.data;   // base64
    });
  }

  // ─────────────── Runtime（JS 执行）───────────────

  async evaluate(code, targetId, opts) {
    const o = opts || {};
    const sid = await this.attach(targetId);
    // 自动包装：支持 return 语句块
    let expr = String(code || '');
    if (!/^\s*(\(|async|function|\[|\{|"|'|[0-9]|true|false|null|undefined|new |await )/.test(expr)) {
      expr = '(function(){' + expr + '})()';
    }
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: o.await !== false,
      userGesture: true,
      includeCommandLineAPI: true
    }, sid);
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      throw new Error('JS 异常: ' + ((ex.exception && (ex.exception.description || ex.exception.value)) || ex.text));
    }
    return r.result ? r.result.value : undefined;
  }

  // ─────────────── DOM（精确几何）───────────────

  /** 元素盒模型（视口坐标，可直接用于真实点击） */
  async boxOf(selector, targetId) {
    const sid = await this.attach(targetId);
    const doc = await this.send('DOM.getDocument', { depth: -1, pierce: true }, sid);
    const q = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: selector }, sid);
    if (!q || !q.nodeId) return null;
    const box = await this.send('DOM.getBoxModel', { nodeId: q.nodeId }, sid).catch(function () { return null; });
    if (!box || !box.model) return null;
    const c = box.model.content;   // [x1,y1, x2,y2, x3,y3, x4,y4]
    const xs = [c[0], c[2], c[4], c[6]], ys = [c[1], c[3], c[5], c[7]];
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    return {
      x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2),
      w: Math.round(maxX - minX), h: Math.round(maxY - minY),
      left: Math.round(minX), top: Math.round(minY)
    };
  }

  /** 元素文本（用于风险判定 / 定位校验） */
  async textOf(selector, targetId) {
    const sid = await this.attach(targetId);
    const r = await this.send('Runtime.evaluate', {
      expression: '(()=>{const e=document.querySelector(%s);return e?((e.innerText||e.value||e.getAttribute("aria-label")||"")+"").trim():null})()'.replace('%s', JSON.stringify(selector)),
      returnByValue: true
    }, sid);
    return r.result ? r.result.value : null;
  }

  async scrollIntoView(selector, targetId) {
    const sid = await this.attach(targetId);
    await this.send('Runtime.evaluate', {
      expression: '(()=>{const e=document.querySelector(%s);if(e)e.scrollIntoView({block:"center",inline:"center"});return !!e})()'.replace('%s', JSON.stringify(selector)),
      returnByValue: true
    }, sid);
    await new Promise(function (r) { setTimeout(r, 250); });
    return true;
  }

  // ─────────────── Input（真实事件）───────────────

  async clickAt(x, y, targetId, opts) {
    const o = opts || {};
    // 视口为 0 时坐标无意义：用视口覆盖保障，点击后撤销（不切前台）
    return this.withViewport(targetId, async () => {
      const sid = await this.attach(targetId);
      const button = o.button || 'left';
      const count = o.clickCount || 1;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' }, sid).catch(function () { });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: button, clickCount: count, buttons: button === 'left' ? 1 : 2 }, sid);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: button, clickCount: count, buttons: 0 }, sid);
      return { ok: true, x: x, y: y };
    });
  }

  async hoverAt(x, y, targetId) {
    const sid = await this.attach(targetId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, button: 'none' }, sid);
    return { ok: true };
  }

  async scrollAt(x, y, dy, targetId) {
    const sid = await this.attach(targetId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x, y: y, deltaX: 0, deltaY: dy }, sid);
    return { ok: true };
  }

  /** 输入文本（insertText 对中文/emoji 更稳，避免逐键丢失） */
  async insertText(text, targetId) {
    const sid = await this.attach(targetId);
    await this.send('Input.insertText', { text: String(text == null ? '' : text) }, sid);
    return { ok: true, chars: String(text || '').length };
  }

  /** 按键（含组合键） */
  async pressKey(key, targetId) {
    const sid = await this.attach(targetId);
    const parts = String(key || 'Enter').split('+');
    const main = parts.pop();
    const mods = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
    let modifiers = 0;
    parts.forEach(function (m) { modifiers |= mods[m.toLowerCase()] || 0; });
    const keyMap = {
      Enter: { code: 'Enter', keyCode: 13, text: '\r' },
      Escape: { code: 'Escape', keyCode: 27 },
      Tab: { code: 'Tab', keyCode: 9 },
      Backspace: { code: 'Backspace', keyCode: 8 },
      Delete: { code: 'Delete', keyCode: 46 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      ' ': { code: 'Space', keyCode: 32, text: ' ' }
    };
    const k = keyMap[main] || { code: main.length === 1 ? 'Key' + main.toUpperCase() : main, keyCode: main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0, text: main.length === 1 ? main : undefined };
    const common = { modifiers: modifiers, key: main, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    if (k.text && !modifiers) common.text = k.text;
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: k.text && !modifiers ? 'keyDown' : 'rawKeyDown' }, common), sid);
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, common), sid);
    return { ok: true, key: key };
  }

  /** 聚焦元素（点击其中心） */
  async focusSelector(selector, targetId) {
    const box = await this.boxOf(selector, targetId);
    if (!box) throw new Error('未找到元素: ' + selector);
    await this.clickAt(box.x, box.y, targetId);
    return box;
  }

  // ─────────────── Network / Emulation / Storage ───────────────

  /** 启用网络观测并收集请求（返回取消函数与缓冲读取） */
  async startNetworkCapture(targetId) {
    const sid = await this.attach(targetId);
    const buffer = [];
    await this.send('Network.enable', {}, sid);
    const off = this.on('Network.responseReceived', function (p, s) {
      if (s !== sid) return;
      buffer.push({ url: p.response && p.response.url, status: p.response && p.response.status, mime: p.response && p.response.mimeType, size: p.response && p.response.encodedDataLength });
      if (buffer.length > 400) buffer.shift();
    });
    this._netCaps = this._netCaps || new Map();
    const list = this._netCaps.get(targetId) || [];
    list.push({ stop: function () { off(); } });
    this._netCaps.set(targetId, list);
    return { stop: function () { off(); return buffer; }, buffer: buffer };
  }

  /** 注销某 target 的抓包订阅（工具读完即调用）。
   *  旧实现只加不减：每次 cdp_net_capture 都新增一个 handler，每个网络事件被 N 个 handler
   *  各处理一遍，buffer 也无界 —— 长驻进程里是实打实的泄漏。 */
  stopNetworkCapture(targetId) {
    const caps = this._netCaps && this._netCaps.get(targetId);
    if (!caps) return false;
    caps.forEach(function (c) { try { c.stop(); } catch (e) { /* ignore */ } });
    this._netCaps.delete(targetId);
    return true;
  }

  async getCookies(targetId, urls) {
    const sid = await this.attach(targetId);
    const r = await this.send('Network.getCookies', urls ? { urls: urls } : {}, sid);
    return (r.cookies || []).map(function (c) { return { name: c.name, domain: c.domain, value: String(c.value || '').slice(0, 60), httpOnly: c.httpOnly }; });
  }

  async getStorage(targetId, type) {
    const sid = await this.attach(targetId);
    const store = type === 'session' ? 'sessionStorage' : 'localStorage';
    const r = await this.send('Runtime.evaluate', {
      expression: 'JSON.stringify(Object.fromEntries(Object.keys(' + store + ').map(k=>[k,' + store + '.getItem(k)])))',
      returnByValue: true
    }, sid);
    try { return JSON.parse(r.result.value); } catch (e) { return {}; }
  }

  async setDeviceMetrics(targetId, m) {
    const sid = await this.attach(targetId);
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: m.width, height: m.height, deviceScaleFactor: m.dpr || 1, mobile: !!m.mobile
    }, sid);
    return { ok: true };
  }

  async clearDeviceMetrics(targetId) {
    const sid = await this.attach(targetId);
    await this.send('Emulation.clearDeviceMetricsOverride', {}, sid);
    return { ok: true };
  }

  async setTimezone(targetId, tz) {
    const sid = await this.attach(targetId);
    await this.send('Emulation.setTimezoneOverride', { timezoneId: tz }, sid);
    return { ok: true };
  }

  async performance(targetId) {
    const sid = await this.attach(targetId);
    await this.send('Performance.enable', {}, sid).catch(function () { });
    const r = await this.send('Performance.getMetrics', {}, sid).catch(function () { return { metrics: [] }; });
    const out = {};
    (r.metrics || []).forEach(function (m) { out[m.name] = Math.round(m.value * 1000) / 1000; });
    return out;
  }

  /** 控制台日志（订阅后累积） */
  async startConsoleCapture(targetId) {
    const sid = await this.attach(targetId);
    const buffer = [];
    await this.send('Runtime.enable', {}, sid).catch(function () { });
    await this.send('Log.enable', {}, sid).catch(function () { });
    const off1 = this.on('Runtime.consoleAPICalled', function (p, s) {
      if (s !== sid) return;
      buffer.push({ type: p.type, text: (p.args || []).map(function (a) { return a.value != null ? a.value : (a.description || a.type); }).join(' ') });
      if (buffer.length > 300) buffer.shift();
    });
    const off2 = this.on('Log.entryAdded', function (p, s) {
      if (s !== sid) return;
      buffer.push({ type: (p.entry && p.entry.level) || 'log', text: (p.entry && p.entry.text) || '' });
      if (buffer.length > 300) buffer.shift();
    });
    return { stop: function () { off1(); off2(); return buffer; }, buffer: buffer };
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.ws = null;
    this.sessions.clear();
  }
}

module.exports = { CdpCore: CdpCore, DEFAULT_PORT: 9110 };
