#!/usr/bin/env node
/**
 * Ark Web — Client v3 (唯一 CLI + API 库)
 * AI 终端使用的浏览器控制客户端: HTTP keep-alive、链式 batch、全部端点
 *
 * 用法:
 *   node browser-client.js <command> [args]
 *   node browser-client.js chain "cmd args" "cmd2 args" ...   (链式, 一次 HTTP 往返)
 *   node browser-client.js help
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 8000, maxFreeSockets: 10, timeout: 45000 });
keepAliveAgent.on('free', () => {}); // 占位，避免 freeSockets 泄漏告警

class BrowserClient {
  constructor(options = {}) {
    this.host = options.host || 'localhost';
    this.port = options.port || 9333;
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.session = options.session || null;
  }

  // ============ HTTP (keep-alive) ============

  async request(pathName, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathName, this.baseUrl);
      // 会话参数: 所有请求自动携带 ?session=<id>(多 agent 并行隔离)
      if (this.session) url.searchParams.set('session', this.session);
      const method = options.method || 'GET';
      const body = options.body;
      const timeout = options.timeout || 60000;

      const req = http.request({
        hostname: url.hostname,
        port: url.port || this.port,
        path: url.pathname + url.search,
        method,
        agent: keepAliveAgent,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        timeout
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ raw: data }); }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  get(p) { return this.request(p); }
  post(p, body) { return this.request(p, { method: 'POST', body }); }

  // ============ 状态 ============

  async getStatus() { return this.get('/status'); }
  async isConnected() {
    const s = await this.getStatus();
    return s.connected;
  }

  // ============ 批量(一次 HTTP + 一次 WS 往返) ============

  /** steps: [{type, data}...] */
  async batch(steps) { return this.post('/batch', { steps }); }

  // ============ 标签页 ============

  async getTabs() { return this.get('/tabs'); }
  async openUrl(url) { return this.post('/open', { url }); }
  async openCurrent(url) { return this.post('/open', { url, current: true }); }
  async activateTab(tabId) { return this.post('/tab/activate', { tabId }); }
  async closeTab(tabId) { return this.post('/tab/close', { tabId }); }

  // ============ 导航 ============

  async reload() { return this.post('/reload', {}); }
  async goBack() { return this.post('/back', {}); }
  async goForward() { return this.post('/forward', {}); }

  // ============ 页面信息 / DOM ============

  async getPageInfo() { return this.get('/page-info'); }
  async getDOM() { return this.get('/dom'); }
  async getHTML(selector = null) {
    return selector ? this.post('/html', { selector }) : this.get('/html');
  }
  async getFrames() { return this.get('/frames'); }
  async getLayout() { return this.get('/layout'); }
  async querySelector(selector) { return this.post('/query', { selector }); }
  async queryAll(selector, limit = 50, fields = null) {
    return this.post('/query-all', { selector, limit, ...(fields ? { fields } : {}) });
  }
  async queryMany(selectors) { return this.post('/query-many', { selectors }); }
  async elementExists(selector) { return this.post('/exists', { selector }); }
  async getText(selector = 'body') { return this.post('/text', { selector }); }
  async getAttr(selector, name) { return this.post('/attr', { selector, name }); }
  async getValue(selector) { return this.post('/value', { selector }); }

  // ============ 元素操作 ============

  async click(selector, tabId) {
    return this.post('/click', tabId != null ? { selector, tabId } : { selector });
  }
  async hover(selector) { return this.post('/hover', { selector }); }
  async doubleClick(selector) { return this.post('/dblclick', { selector }); }
  async rightClick(selector) { return this.post('/rightclick', { selector }); }
  async drag(selector, opts = {}) { return this.post('/drag', { selector, ...opts }); }
  async mouse(type, x, y, opts = {}) { return this.post('/mouse', { type, x, y, ...opts }); }
  async scrollTo(x = 0, y = 0, behavior = 'smooth') { return this.post('/scroll', { x, y, behavior }); }
  async scrollIntoView(selector) { return this.post('/scroll-into-view', { selector }); }
  async scrollBy(x = 0, y = 0) { return this.post('/scroll-by', { x, y }); }
  async scrollToTop() { return this.scrollTo(0, 0, 'auto'); }
  async scrollToBottom() { return this.scrollTo(0, 999999, 'auto'); }

  // ============ 键盘 / 输入 ============

  async key(key, modifiers = []) { return this.post('/key', { key, modifiers }); }
  async type(selector, text, mode = 'fast') {
    const body = text === undefined ? { text: selector } : { selector, text, mode };
    return this.post('/type', body);
  }
  async fillForm(fields) { return this.post('/fill', { fields }); }
  async selectOption(selector, opts = {}) { return this.post('/select', { selector, ...opts }); }
  async check(selector, checked = true) { return this.post('/check', { selector, checked }); }
  async clearField(selector) { return this.post('/clear', { selector }); }
  async focus(selector) { return this.post('/focus', { selector }); }

  // 快捷键
  async pressF12() { return this.key('F12'); }
  async pressF5() { return this.key('F5'); }
  async pressEnter() { return this.key('Enter'); }
  async pressEscape() { return this.key('Escape'); }
  async pressTab() { return this.key('Tab'); }
  async pressCtrlShiftI() { return this.key('I', ['ctrl', 'shift']); }

  // ============ JS 执行 / 等待 ============

  async evaluate(code, timeout = 10000) { return this.post('/evaluate', { code, timeout }); }
  async waitFor(selector, timeout = 10000, state = 'visible') {
    return this.post('/wait-for', { selector, timeout, state });
  }
  async waitForText(text, timeout = 10000, selector = 'body') {
    return this.post('/wait-for-text', { text, timeout, selector });
  }
  async waitForUrl(pattern, timeout = 10000) {
    return this.post('/wait-for-url', { pattern, timeout });
  }
  async waitForLoad(timeout = 15000) {
    return this.post('/wait-for-load', { timeout });
  }

  // ============ 截图 / PDF ============

  async screenshot(format = 'png', quality = 80) {
    return this.get(`/screenshot?format=${format}&quality=${quality}`);
  }
  async screenshotFull(format = 'png', quality = 80) {
    return this.get(`/screenshot/full?format=${format}&quality=${quality}`);
  }
  async screenshotElement(selector) { return this.post('/screenshot/element', { selector }); }

  // ============ 视觉快照 (v7-vision + v8 binary) ============
  async snapshot(options = {}) {
    // 支持 GET query 或 POST body；统一用 POST 以支持复杂参数
    // fast: true 时服务端尝试 probe 缓存 + reduced steps
    return this.post('/snapshot', options);
  }
  async snapshotBinary(options = {}) {
    // 二进制直出 image/*, 省 base64 30% + JSON 解析
    const qs = new URLSearchParams();
    for (const [k,v] of Object.entries(options)) if (v != null) qs.set(k, String(v));
    qs.set('binary','1');
    return new Promise((resolve, reject) => {
      const url = new URL(`/snapshot/binary?${qs.toString()}`, this.baseUrl);
      if (this.session) url.searchParams.set('session', this.session);
      const req = http.request({ hostname: url.hostname, port: url.port||this.port, path: url.pathname+url.search, method:'GET', agent: keepAliveAgent }, (res)=>{
        const chunks=[];
        res.on('data', c=>chunks.push(c));
        res.on('end', ()=>{
          const buf = Buffer.concat(chunks);
          if (res.headers['content-type']?.startsWith('image/')) {
            const els = (()=>{ try{ return JSON.parse(decodeURIComponent(res.headers['x-snapshot-elements']||'[]')); }catch{ return []; }})();
            resolve({ success:true, binary:true, buffer: buf, contentType: res.headers['content-type'], url: decodeURIComponent(res.headers['x-snapshot-url']||''), title: decodeURIComponent(res.headers['x-snapshot-title']||''), elements: els, viewport: (()=>{try{return JSON.parse(res.headers['x-snapshot-viewport']||'{}')}catch{return {}}})() });
          } else {
            try{ resolve(JSON.parse(buf.toString())); } catch{ resolve({ raw: buf.toString()}); }
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
  async snapshotToFile(filePath = 'snapshot.png', options = {}) {
    const r = await this.snapshot(options);
    if (!r?.dataUrl) return { error: r?.error || 'Snapshot failed', raw: r };
    const base64 = r.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { success: true, file: filePath, url: r.url, title: r.title, viewport: r.viewport, elements: r.elements, format: r.format, timestamp: r.timestamp };
  }
  async snapshotBinaryToFile(filePath = 'snapshot.png', options = {}) {
    const r = await this.snapshotBinary(options);
    if (!r?.buffer) return { error: r?.error || 'Binary snapshot failed', raw: r };
    fs.writeFileSync(filePath, r.buffer);
    return { success: true, file: filePath, url: r.url, title: r.title, viewport: r.viewport, elements: r.elements, contentType: r.contentType };
  }

  /** 截图并保存到本地文件, 返回文件路径 */
  async screenshotToFile(filePath = 'screenshot.png') {
    const shot = await this.screenshot();
    if (!shot?.dataUrl) return { error: shot?.error || 'Screenshot failed', shot };
    const base64 = shot.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { success: true, file: filePath };
  }

  /** 整页截图并保存到本地文件 */
  async screenshotFullToFile(filePath = 'full-page.png') {
    const shot = await this.screenshotFull();
    if (!shot?.dataUrl) return { error: shot?.error || 'Full screenshot failed', shot };
    const base64 = shot.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { success: true, file: filePath };
  }

  /** 当前页打印为 PDF 并保存 */
  async pdfToFile(filePath = 'page.pdf', format = 'A4') {
    const r = await this.get(`/pdf?format=${format}`);
    if (!r?.success) return r;
    fs.writeFileSync(filePath, Buffer.from(r.base64, 'base64'));
    return { success: true, file: filePath, format };
  }

  /** 文件上传到 input[type=file] (需 CDP) */
  async upload(selector, files) { return this.post('/upload', { selector, files }); }

  // ============ 高亮 ============

  async highlight(selector, color = '#ff0000', label = null) {
    return this.post('/highlight', { selector, color, ...(label ? { label } : {}) });
  }
  async clearHighlight() { return this.post('/highlight/clear', {}); }

  // ============ Cookie ============

  async getCookies() { return this.get('/cookies'); }
  async setCookie(cookie) { return this.post('/cookie', cookie); }
  async removeCookie(name, url) { return this.post('/cookie/remove', { name, ...(url ? { url } : {}) }); }

  // ============ Storage ============

  async getStorage(type = 'local') { return this.get(`/storage?type=${type}`); }
  async setStorage(key, value, type = 'local') { return this.post('/storage', { key, value, type }); }
  async removeStorage(key, type = 'local') { return this.post('/storage/remove', { key, type }); }
  async clearStorage(type = 'local') { return this.post('/storage/clear', { type }); }

  // ============ 网络 ============

  async getNetworkLogs(filter = null, limit = 500, type = null) {
    const q = [];
    if (filter) q.push(`filter=${encodeURIComponent(filter)}`);
    if (limit) q.push(`limit=${limit}`);
    if (type) q.push(`type=${encodeURIComponent(type)}`);
    return this.get(`/network${q.length ? '?' + q.join('&') : ''}`);
  }
  async clearNetworkLogs() { return this.post('/network/clear', {}); }
  async getResponseBody(urlPattern) { return this.post('/network/response', { urlPattern }); }
  async blockUrls(patterns) { return this.post('/network/block', { patterns }); }
  async unblockUrls() { return this.post('/network/unblock', {}); }
  async setNetworkConditions(conditions) { return this.post('/network/conditions', conditions); }
  async resetNetworkConditions() { return this.post('/network/conditions/reset', {}); }
  async disableCache(disabled = true) { return this.post('/network/disable-cache', { disabled }); }
  async bypassCsp(enabled = true) { return this.post('/bypass-csp', { enabled }); }

  // 预设网络条件
  async slow3G() {
    return this.setNetworkConditions({ offline: false, latency: 400, download: 400 * 1024, upload: 400 * 1024 });
  }
  async fast3G() {
    return this.setNetworkConditions({ offline: false, latency: 150, download: 1.5 * 1024 * 1024, upload: 750 * 1024 });
  }
  async offline() {
    return this.setNetworkConditions({ offline: true, latency: 0, download: 0, upload: 0 });
  }

  // ============ 性能 ============

  async getPerformance() { return this.get('/performance'); }
  async getWebVitals() { return this.get('/vitals'); }
  async getResources() { return this.get('/resources'); }
  async setCpuThrottling(rate = 4) { return this.post('/cpu', { rate }); }

  // ============ 模拟 ============

  async simulateDevice(device) { return this.post('/device', { device }); }
  async clearDevice() { return this.post('/device/clear', {}); }
  async emulateMedia(features) { return this.post('/media', { features }); }
  async darkMode(enable = true) {
    return this.emulateMedia(enable ? [{ name: 'prefers-color-scheme', value: 'dark' }] : []);
  }
  async reducedMotion(enable = true) {
    return this.emulateMedia(enable ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : []);
  }
  async setGeolocation(latitude, longitude, accuracy = 10) {
    return this.post('/geo', { latitude, longitude, accuracy });
  }
  async setLocale(locale) { return this.post('/locale', { locale }); }
  async setTimezone(timezoneId) { return this.post('/timezone', { timezoneId }); }
  async autoDarkMode(enabled = true) { return this.post('/auto-dark', { enabled }); }
  async setScriptDisabled(disabled = true) { return this.post('/js', { disabled }); }
  async setHardwareConcurrency(count) { return this.post('/hardware-concurrency', { count }); }

  // ============ 弹窗 ============

  async dialog(accept = true, promptText = null, auto = undefined) {
    return this.post('/dialog', { accept, ...(promptText != null ? { promptText } : {}), ...(auto !== undefined ? { auto } : {}) });
  }
  async getDialogs() { return this.get('/dialogs'); }

  // ============ 检查 ============

  async securityCheck() { return this.get('/security'); }
  async a11yCheck() { return this.get('/a11y'); }
  async seoCheck() { return this.get('/seo'); }

  // ============ 控制台 / DOM 变化 ============

  async getConsoleLogs(limit = 500) { return this.get(`/console?limit=${limit}`); }
  async clearConsoleLogs() { return this.post('/console/clear', {}); }
  async getDomChanges() { return this.get('/dom-changes'); }
  async clearDomChanges() { return this.post('/dom-changes/clear', {}); }

  // ============ 批量 / 监控 / 调试 ============

  async fullAnalysis() { return this.get('/full'); }
  async analyzeAllTabs() { return this.get('/analyze-all'); }
  async startMonitor(options = {}) { return this.post('/monitor', options); }
  async stopMonitor() { return this.post('/monitor/stop', {}); }
  async getMonitorStatus() { return this.get('/monitor/status'); }
  async attachDebugger() { return this.post('/debug/attach-all', {}); }
  async detachDebugger() { return this.post('/debug/detach-all', {}); }
  async getDebugInfo() { return this.get('/debug/info'); }

  // ============ 审计引擎 ============

  /** 审计当前页或指定 URL。format: json|md|html; save: 写入历史 */
  async audit(options = {}) { return this.post('/audit', options); }

  /** 审计并保存 HTML 报告到本地 */
  async auditToHtml(filePath = 'audit-report.html', options = {}) {
    const r = await this.audit({ ...options, format: 'html' });
    if (!r.success) return r;
    fs.writeFileSync(filePath, r.html);
    return { success: true, file: filePath, scores: r.scores, meta: r.meta };
  }

  /** 审计并保存 Markdown 报告 */
  async auditToMarkdown(filePath = 'audit-report.md', options = {}) {
    const r = await this.audit({ ...options, format: 'md' });
    if (!r.success) return r;
    fs.writeFileSync(filePath, r.markdown);
    return { success: true, file: filePath, scores: r.scores, meta: r.meta };
  }

  /** 历史趋势 */
  async auditHistory(url = null, limit = 10) {
    const q = [];
    if (url) q.push(`url=${encodeURIComponent(url)}`);
    q.push(`limit=${limit}`);
    return this.get(`/history?${q.join('&')}`);
  }

  /** 批量审计 URL 队列 */
  async auditRun(urls, budget = null) {
    return this.post('/audit/run', { urls, ...(budget ? { budget } : {}) });
  }
  async auditStatus(taskId) { return this.get(`/audit/status/${encodeURIComponent(taskId)}`); }

  // ============ 报告 ============

  async generateReport(outputPath) {
    const analysis = await this.fullAnalysis();
    const report = {
      metadata: {
        timestamp: new Date().toISOString(),
        url: analysis.pageInfo?.url,
        title: analysis.pageInfo?.title
      },
      performance: {
        webVitals: analysis.vitals,
        navigation: analysis.performance?.navigation,
        resources: analysis.performance?.resources,
        memory: analysis.performance?.memory
      },
      security: analysis.security,
      accessibility: analysis.a11y,
      seo: analysis.seo,
      summary: {
        domElements: analysis.dom?.elements,
        loadTime: analysis.performance?.navigation?.loadComplete,
        securityIssues: (Array.isArray(analysis.security) ? analysis.security.filter(s => !s.pass).length : 0),
        a11yIssues: (Array.isArray(analysis.a11y) ? analysis.a11y.length : 0),
        seoScore: (Array.isArray(analysis.seo) ? analysis.seo.filter(s => s.pass).length : 0)
      }
    };
    if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    return report;
  }
}

// ============ 命令行 ============

if (require.main === module) {
  // 全局参数: --session <id> 会话隔离; --body-file <path> 从 UTF-8 JSON 文件读取 POST body(中文安全通道,
  // 解决 PowerShell 5.1 命令行内嵌中文被 GBK 控制台损坏的问题)
  let sessionOpt = null;
  let bodyFile = null;
  const args = [];
  for (let i = 0; i < process.argv.slice(2).length; i++) {
    const a = process.argv.slice(2)[i];
    if (a === '--session' || a === '--session=') { sessionOpt = process.argv.slice(2)[++i]; continue; }
    if (a.startsWith('--session=')) { sessionOpt = a.slice('--session='.length); continue; }
    if (a === '--body-file' || a === '--body-file=') { bodyFile = process.argv.slice(2)[++i]; continue; }
    if (a.startsWith('--body-file=')) { bodyFile = a.slice('--body-file='.length); continue; }
    args.push(a);
  }
  const client = new BrowserClient({ session: sessionOpt || undefined });
    // body-file 覆盖: 除 /batch(chain) 外的所有 POST 请求 body 使用文件内容(UTF-8)
    // chain 场景: 文件内容含 steps 数组时直接用文件步骤(JSON 可完整表达嵌套, 绕开命令行转义)
    let bodyOverride = null;
    let chainFileSteps = null;
    if (bodyFile) {
      try {
        bodyOverride = JSON.parse(fs.readFileSync(bodyFile, 'utf8'));
        if (!bodyOverride || typeof bodyOverride !== 'object' || Array.isArray(bodyOverride)) {
          throw new Error('--body-file 必须指向 JSON 对象');
        }
        if (Array.isArray(bodyOverride.steps)) chainFileSteps = bodyOverride.steps;
      } catch (e) {
        console.error(JSON.stringify({ error: `--body-file 读取失败: ${e.message}` }, null, 2));
        process.exit(1);
      }
      const origPost = client.post.bind(client);
      client.post = (p, body) => origPost(p, (p === '/batch' || p.startsWith('/session')) ? body : bodyOverride);
      console.error(`[ark] --body-file 生效: POST 请求 body 来自 ${bodyFile}(/batch、/session* 除外)`);
    }
  const cmd = args[0];

  function parseJsonOrRaw(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  async function run() {
    try {
      let result;
      switch (cmd) {
        // 基础
        case 'status': result = await client.getStatus(); break;
        case 'tabs': result = await client.getTabs(); break;
        case 'full': result = await client.fullAnalysis(); break;

        // 会话(多 agent 并行隔离)
        case 'session': result = await client.get('/session'); break;
        case 'session-create': result = await client.post('/session/create', {}); break;
        case 'session-delete': result = await client.post('/session/delete', { sessionId: args[1], ...(args[2] === 'close' || args[2] === '--close' ? { closeTabs: true } : {}) }); break;
        case 'session-assign': result = await client.post('/session/assign', { sessionId: args[1], tabId: parseInt(args[2]) }); break;
        case 'session-release': result = await client.post('/session/release', { sessionId: args[1], ...(args[2] ? { tabId: parseInt(args[2]) } : {}) }); break;
        case 'session-tab': result = await client.post('/session/tab', { sessionId: args[1], url: args[2] }); break;

        // 链式
        case 'chain': {
          // node browser-client.js chain "open https://x" "wait-load" "page-info"
          // 或: node browser-client.js chain open https://x --- wait-load --- page-info
          // 或: node browser-client.js chain --body-file steps.json (文件含 {"steps":[...]}, 完整 JSON 免转义)
          if (chainFileSteps) {
            const t0 = Date.now();
            const r = await client.batch(chainFileSteps);
            result = { success: true, fileSteps: true, steps: r.steps || [], total: Date.now() - t0 };
            break;
          }
          const raw = args.slice(1).join(' ');
          const parts = raw.includes('---')
            ? raw.split('---').map(s => s.trim()).filter(Boolean)
            : args.slice(1).map(a => a.trim()).filter(Boolean);
          const steps = [];
          for (const p of parts) {
            const toks = p.split(/\s+/);
            const t = toks[0];
            const rest = toks.slice(1);
            steps.push({ type: t, data: { _raw: rest } });
          }
          // 简单映射: 纯命令步骤不携带参数映射, 交给 batch 前规范化
          result = await runChainSteps(steps);
          break;
        }

        // 导航
        case 'open': result = await client.openUrl(args[1]); break;
        case 'open-current': result = await client.openCurrent(args[1]); break;
        case 'reload': result = await client.reload(); break;
        case 'back': result = await client.goBack(); break;
        case 'forward': result = await client.goForward(); break;
        case 'tab': result = await client.activateTab(parseInt(args[1])); break;
        case 'close-tab': result = await client.closeTab(parseInt(args[1])); break;

        // 页面信息 / DOM
        case 'page-info': result = await client.getPageInfo(); break;
        case 'dom': result = await client.getDOM(); break;
        case 'html': result = await client.getHTML(args[1] || null); break;
        case 'frames': result = await client.getFrames(); break;
        case 'layout': result = await client.getLayout(); break;
        case 'query': result = await client.querySelector(args[1]); break;
        case 'query-all': result = await client.queryAll(args[1], parseInt(args[2]) || 50); break;
        case 'query-many': result = await client.queryMany(parseJsonOrRaw(args[1], [args[1]])); break;
        case 'exists': result = await client.elementExists(args[1]); break;
        case 'text': result = await client.getText(args[1] || 'body'); break;
        case 'attr': result = await client.getAttr(args[1], args[2]); break;
        case 'value': result = await client.getValue(args[1]); break;

        // 元素操作
        case 'click': result = await client.click(args[1]); break;
        case 'hover': result = await client.hover(args[1]); break;
        case 'dblclick': result = await client.doubleClick(args[1]); break;
        case 'rightclick': result = await client.rightClick(args[1]); break;
        case 'drag': {
          const opts = parseJsonOrRaw(args.slice(2).join(' '), { targetSelector: args[2] });
          result = await client.drag(args[1], typeof opts === 'object' ? opts : {});
          break;
        }
        case 'mouse': result = await client.mouse(args[1], parseInt(args[2]) || 0, parseInt(args[3]) || 0); break;
        case 'scroll': result = await client.scrollTo(parseInt(args[1]) || 0, parseInt(args[2]) || 0); break;
        case 'scroll-top': result = await client.scrollToTop(); break;
        case 'scroll-bottom': result = await client.scrollToBottom(); break;
        case 'scroll-into-view': result = await client.scrollIntoView(args[1]); break;
        case 'scroll-by': result = await client.scrollBy(parseInt(args[1]) || 0, parseInt(args[2]) || 0); break;
        case 'select': {
          const v = args.slice(2).join(' ');
          result = await client.selectOption(args[1], parseJsonOrRaw(v, { value: v }));
          break;
        }
        case 'check': result = await client.check(args[1], args[2] !== 'off' && args[2] !== 'false' && args[2] !== '0'); break;
        case 'clear-field': result = await client.clearField(args[1]); break;
        case 'focus': result = await client.focus(args[1]); break;

        // 键盘 / 输入
        case 'key': result = await client.key(args[1], args.slice(2)); break;
        case 'type': {
          if (args.length >= 3) result = await client.type(args[1], args.slice(2).join(' '));
          else result = await client.type(args[1]);
          break;
        }
        case 'fill': {
          const fields = parseJsonOrRaw(args[1], [{ selector: args[1], value: args.slice(2).join(' ') }]);
          result = await client.fillForm(Array.isArray(fields) ? fields : [fields]);
          break;
        }
        case 'f12': result = await client.pressF12(); break;
        case 'f5': result = await client.pressF5(); break;
        case 'enter': result = await client.pressEnter(); break;
        case 'escape': result = await client.pressEscape(); break;

        // JS / 等待
        case 'evaluate': result = await client.evaluate(args.slice(1).join(' ')); break;
        case 'wait-for': result = await client.waitFor(args[1], parseInt(args[2]) || 10000); break;
        case 'wait-for-text': result = await client.waitForText(args[1], parseInt(args[2]) || 10000, args[3]); break;
        case 'wait-for-url': result = await client.waitForUrl(args[1], parseInt(args[2]) || 10000); break;
        case 'wait-load': result = await client.waitForLoad(); break;

        // 截图 / PDF / 视觉快照(v7-vision)
        case 'screenshot': result = await client.screenshotToFile(args[1] || 'screenshot.png'); break;
        case 'screenshot-full': result = await client.screenshotFullToFile(args[1] || 'full-page.png'); break;
        case 'screenshot-element': result = await client.screenshotElement(args[1]); break;
        case 'snapshot': {
          // 用法: snapshot [file.png] [--annotate] [--full] [--format png] [--quality 80] [--selector "..."] [--max 50]
          // 位置参数 1 若含 .png/.jpg 则视为文件路径，其余为选项
          let file = null;
          const opts = {};
          for (let i = 1; i < args.length; i++) {
            const a = args[i];
            if (!file && /\.(png|jpe?g)$/i.test(a)) { file = a; continue; }
            if (a === '--annotate' || a === '--annotate=true' || a === '-a') opts.annotate = true;
            else if (a === '--full' || a === '--full=true') opts.full = true;
            else if (a.startsWith('--format=')) opts.format = a.split('=')[1];
            else if (a === '--format' && args[i+1]) opts.format = args[++i];
            else if (a.startsWith('--quality=')) opts.quality = +a.split('=')[1];
            else if (a === '--quality' && args[i+1]) opts.quality = +args[++i];
            else if (a.startsWith('--selector=')) opts.selector = a.slice('--selector='.length);
            else if (a === '--selector' && args[i+1]) opts.selector = args[++i];
            else if (a.startsWith('--max=')) opts.maxElements = +a.split('=')[1];
            else if (a === '--max' && args[i+1]) opts.maxElements = +args[++i];
          }
          // body-file 覆盖已在入口处理(POST /snapshot 的 body 来自文件)
          if (file) result = await client.snapshotToFile(file, opts);
          else {
            // 无文件则直接返回 JSON（含 dataUrl，适合多模态模型直接看）
            if (Object.keys(opts).length) result = await client.snapshot(opts);
            else result = await client.snapshot({});
          }
          break;
        }
        case 'pdf': result = await client.pdfToFile(args[1] || 'page.pdf', args[2] || 'A4'); break;
        case 'upload': result = await client.upload(args[1], parseJsonOrRaw(args[2], [args[2]])); break;

        // 高亮
        case 'highlight': result = await client.highlight(args[1], args[2] || '#ff0000', args[3] || null); break;
        case 'highlight-clear': result = await client.clearHighlight(); break;

        // Cookie / Storage
        case 'cookies': result = await client.getCookies(); break;
        case 'cookie-set': {
          const c = parseJsonOrRaw(args.slice(1).join(' '), { name: args[1], value: args[2] });
          result = await client.setCookie(typeof c === 'object' ? c : { name: args[1], value: args[2] });
          break;
        }
        case 'cookie-remove': result = await client.removeCookie(args[1], args[2] || undefined); break;
        case 'storage': result = await client.getStorage(args[1] || 'local'); break;
        case 'storage-set': result = await client.setStorage(args[1], args[2], args[3] || 'local'); break;
        case 'storage-remove': result = await client.removeStorage(args[1], args[2] || 'local'); break;
        case 'storage-clear': result = await client.clearStorage(args[1] || 'local'); break;

        // 网络
        case 'network': result = await client.getNetworkLogs(args[1] || null); break;
        case 'network-clear': result = await client.clearNetworkLogs(); break;
        case 'network-conditions': {
          const c = parseJsonOrRaw(args.slice(1).join(' '), { offline: args[1] === 'offline' });
          result = await client.setNetworkConditions(typeof c === 'object' ? c : {});
          break;
        }
        case 'network-reset': result = await client.resetNetworkConditions(); break;
        case 'block': {
          const b = parseJsonOrRaw(args.slice(1).join(' '), [args[1]]);
          result = await client.blockUrls(Array.isArray(b) ? b : [b]);
          break;
        }
        case 'unblock': result = await client.unblockUrls(); break;
        case 'response-body': result = await client.getResponseBody(args[1]); break;

        // 性能 / 检查
        case 'performance': result = await client.getPerformance(); break;
        case 'vitals': result = await client.getWebVitals(); break;
        case 'resources': result = await client.getResources(); break;
        case 'cpu': result = await client.setCpuThrottling(parseInt(args[1]) || 4); break;
        case 'a11y': result = await client.a11yCheck(); break;
        case 'seo': result = await client.seoCheck(); break;
        case 'security': result = await client.securityCheck(); break;
        case 'console': result = await client.getConsoleLogs(parseInt(args[1]) || 500); break;
        case 'console-clear': result = await client.clearConsoleLogs(); break;
        case 'dom-changes': result = await client.getDomChanges(); break;
        case 'dom-changes-clear': result = await client.clearDomChanges(); break;

        // 模拟
        case 'device': result = await client.simulateDevice(args.slice(1).join(' ')); break;
        case 'device-clear': result = await client.clearDevice(); break;
        case 'cleanup': result = await client.post('/reset-all', {}); break;
        case 'media': {
          const m = parseJsonOrRaw(args.slice(1).join(' '), [{ name: 'prefers-color-scheme', value: args[1] || 'dark' }]);
          result = await client.emulateMedia(Array.isArray(m) ? m : [m]);
          break;
        }
        case 'dark': result = await client.darkMode(); break;
        case 'dark-off': result = await client.darkMode(false); break;
        case 'auto-dark': result = await client.autoDarkMode(args[1] !== 'off'); break;
        case 'geo': result = await client.setGeolocation(parseFloat(args[1]), parseFloat(args[2]), args[3] ? parseFloat(args[3]) : 10); break;
        case 'locale': result = await client.setLocale(args[1]); break;
        case 'timezone': result = await client.setTimezone(args[1]); break;
        case 'js': result = await client.setScriptDisabled(args[1] !== 'off'); break;
        case 'cpu-count': result = await client.setHardwareConcurrency(parseInt(args[1])); break;
        case 'cache-off': result = await client.disableCache(args[1] !== 'off'); break;
        case 'csp': result = await client.bypassCsp(args[1] !== 'off'); break;

        // 弹窗
        case 'dialog':
          if (args[1] === 'auto') {
            const on = args[2] !== 'off' && args[2] !== 'false';
            result = await client.dialog(true, null, on);
          } else {
            result = await client.dialog(args[1] !== 'dismiss', args[2] || null);
          }
          break;
        case 'dialogs': result = await client.getDialogs(); break;

        // 批量 / 监控 / 调试
        case 'analyze-all': result = await client.analyzeAllTabs(); break;
        case 'monitor':
          result = await client.startMonitor({ interval: parseInt(args[1]) || 5000, duration: parseInt(args[2]) || 60000 });
          break;
        case 'monitor-stop': result = await client.stopMonitor(); break;
        case 'monitor-status': result = await client.getMonitorStatus(); break;
        case 'debug-on': result = await client.attachDebugger(); break;
        case 'debug-off': result = await client.detachDebugger(); break;
        case 'debug-info': result = await client.getDebugInfo(); break;
        case 'cdp-status': result = await client.get('/debug/cdp-status'); break;
        case 'report': result = await client.generateReport(args[1] || 'browser-report.json'); break;

        // 审计
        case 'audit':
          result = await client.audit({ url: args[1] || undefined });
          break;
        case 'audit-html':
          result = await client.auditToHtml(args[1] || 'audit-report.html', { url: args[2] || undefined });
          break;
        case 'audit-md':
          result = await client.auditToMarkdown(args[1] || 'audit-report.md', { url: args[2] || undefined });
          break;
        case 'history':
          result = await client.auditHistory(args[1] || null);
          break;
        case 'audit-run': {
          const urls = parseJsonOrRaw(args[1], [args[1]]);
          result = await client.auditRun(Array.isArray(urls) ? urls : [urls]);
          break;
        }
        case 'audit-status':
          result = await client.auditStatus(args[1]);
          break;

        default:
          return printHelp();
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(JSON.stringify({ error: e.message }, null, 2));
      process.exit(1);
    }
  }

  /** 链式步骤规范化: 将 CLI 名称映射为插件命令类型, 并组装 data */
  async function runChainSteps(steps) {
    // CLI 名称 → 插件命令类型 (batch 直接分发到插件 dispatch)
    const TYPE_MAP = {
      'open': 'open-url', 'goto': 'open-url',
      'open-current': 'open-url', 'navigate': 'open-url',
      'page-info': 'get-page-info', 'dom': 'get-dom', 'html': 'get-html',
      'frames': 'get-frames', 'layout': 'get-layout',
      'query': 'query-selector', 'query-all': 'query-all', 'query-many': 'query-many',
      'exists': 'element-exists', 'text': 'get-text', 'attr': 'get-attr', 'value': 'get-value',
      'click': 'click-element', 'hover': 'hover-element', 'dblclick': 'double-click',
      'rightclick': 'right-click', 'drag': 'drag-element', 'mouse': 'mouse',
      'scroll': 'scroll-page', 'scroll-into-view': 'scroll-into-view',
      'scroll-by': 'scroll-by', 'scroll-top': 'scroll-page', 'scroll-bottom': 'scroll-page',
      'key': 'simulate-key', 'type': 'type-text', 'fill': 'fill-form',
      'select': 'select-option', 'check': 'check-box', 'clear': 'clear-field', 'focus': 'focus-element',
      'f12': 'simulate-key', 'f5': 'simulate-key', 'enter': 'simulate-key', 'escape': 'simulate-key',
      'evaluate': 'evaluate', 'wait-for': 'wait-for-selector',
      'wait-for-text': 'wait-for-text', 'wait-for-url': 'wait-for-url', 'wait-load': 'wait-for-load',
      'snapshot': 'vision-snapshot', 'snapshot-annotate': 'vision-snapshot',
      'screenshot': 'screenshot', 'screenshot-full': 'screenshot-full',
      'screenshot-element': 'screenshot-element', 'pdf': 'print-to-pdf',
      'highlight': 'highlight-elements', 'highlight-clear': 'clear-highlights',
      'dialog': 'dialog', 'dialogs': 'get-dialogs',
      'cookies': 'get-cookies', 'cookie': 'set-cookie', 'cookie-remove': 'remove-cookie',
      'storage': 'get-storage', 'storage-set': 'set-storage',
      'storage-remove': 'remove-storage', 'storage-clear': 'clear-storage',
      'network': 'get-network-logs', 'block': 'block-urls', 'unblock': 'unblock-urls',
      'network-conditions': 'set-network-conditions', 'network-reset': 'reset-network-conditions',
      'cache-off': 'set-cache-disabled', 'csp': 'bypass-csp', 'response-body': 'get-response-body',
      'performance': 'get-performance', 'vitals': 'get-web-vitals', 'resources': 'get-resources',
      'cpu': 'set-cpu-throttling',
      'device': 'simulate-device', 'device-clear': 'clear-device', 'media': 'emulate-media',
      'geo': 'set-geolocation', 'locale': 'set-locale', 'timezone': 'set-timezone',
      'auto-dark': 'auto-dark-mode', 'js': 'set-script-disabled',
      'cleanup': 'reset-all-simulations',
      'cpu-count': 'set-hardware-concurrency',
      'security': 'security-check', 'a11y': 'a11y-check', 'seo': 'seo-check',
      'console': 'get-console-logs', 'console-clear': 'clear-console-logs',
      'dom-changes': 'get-dom-changes', 'dom-changes-clear': 'clear-dom-changes',
      'tabs': 'get-tabs', 'status': 'get-status', 'ping': 'ping',
      'reload': 'reload', 'back': 'back', 'forward': 'forward',
      'tab': 'activate-tab', 'close-tab': 'close-tab', 'upload': 'upload-file',
      'clear-cache': 'clear-cache'
    };
    // 客户端本地执行的步骤类型(不经 /batch, 直接调 HTTP 聚合端点)
    const CLIENT_STEPS = new Set(['full', 'analyze-all', 'monitor', 'monitor-stop', 'monitor-status', 'report', 'act', 'fast']);

    const norm = steps.map(({ type, data }) => {
      const raw = data?._raw || [];
      const d = {};
      const pluginType = TYPE_MAP[type] || type;
      switch (type) {
        case 'open': case 'goto': d.url = raw[0]; break;
        case 'open-current': case 'navigate': d.url = raw[0]; d.current = true; break;
        case 'click': case 'hover': case 'dblclick': case 'rightclick':
        case 'query': case 'exists': case 'value': case 'clear': case 'focus':
        case 'scroll-into-view': case 'screenshot-element': case 'highlight':
          d.selector = raw[0]; break;
        case 'drag': {
          d.selector = raw[0];
          const opts = parseJsonOrRaw(raw.slice(1).join(' '), {});
          if (typeof opts === 'object') Object.assign(d, opts);
          else if (raw[1]) d.targetSelector = raw[1];
          break;
        }
        case 'mouse': d.type = raw[0] || 'click'; d.x = +(raw[1] || 0); d.y = +(raw[2] || 0); break;
        case 'attr': d.selector = raw[0]; d.name = raw[1]; break;
        case 'type': {
          if (raw.length >= 2) { d.selector = raw[0]; d.text = raw.slice(1).join(' '); }
          else d.text = raw[0];
          break;
        }
        case 'key': d.key = raw[0]; d.modifiers = raw.slice(1); break;
        case 'f12': d.key = 'F12'; d.modifiers = []; break;
        case 'f5': d.key = 'F5'; d.modifiers = []; break;
        case 'enter': d.key = 'Enter'; d.modifiers = []; break;
        case 'escape': d.key = 'Escape'; d.modifiers = []; break;
        case 'fill': {
          d.fields = parseJsonOrRaw(raw[0], [{ selector: raw[0], value: raw.slice(1).join(' ') }]);
          if (!Array.isArray(d.fields)) d.fields = [d.fields];
          break;
        }
        case 'select': d.selector = raw[0]; {
          const v = raw.slice(1).join(' ');
          const parsed = parseJsonOrRaw(v, { value: v });
          if (typeof parsed === 'object') Object.assign(d, parsed);
          break;
        }
        case 'check': d.selector = raw[0]; d.checked = raw[1] !== 'off' && raw[1] !== 'false' && raw[1] !== '0'; break;
        case 'scroll': d.x = +(raw[0] || 0); d.y = +(raw[1] || 0); break;
        case 'scroll-top': d.x = 0; d.y = 0; break;
        case 'scroll-bottom': d.x = 0; d.y = 999999; break;
        case 'scroll-by': d.x = +(raw[0] || 0); d.y = +(raw[1] || 0); break;
        case 'evaluate': d.code = raw.join(' '); break;
        case 'wait-for': d.selector = raw[0]; d.timeout = +(raw[1] || 10000); break;
        case 'wait-for-text': d.text = raw[0]; d.timeout = +(raw[1] || 10000); if (raw[2]) d.selector = raw[2]; break;
        case 'wait-for-url': d.pattern = raw[0]; d.timeout = +(raw[1] || 10000); break;
        case 'text': d.selector = raw[0] || 'body'; break;
        case 'html': if (raw[0]) d.selector = raw[0]; break;
        case 'highlight': d.color = raw[1] || '#ff0000'; if (raw[2]) d.label = raw[2]; break;
        case 'device': d.device = raw.join(' '); break;
        case 'media': d.features = parseJsonOrRaw(raw[0], [{ name: 'prefers-color-scheme', value: raw[0] || 'dark' }]); break;
        case 'geo': d.latitude = parseFloat(raw[0]); d.longitude = parseFloat(raw[1]); if (raw[2]) d.accuracy = parseFloat(raw[2]); break;
        case 'timezone': d.timezoneId = raw[0]; break;
        case 'locale': d.locale = raw[0]; break;
        case 'auto-dark': d.enabled = raw[0] !== 'off'; break;
        case 'js': d.disabled = raw[0] !== 'off'; break;
        case 'cache-off': d.disabled = raw[0] !== 'off'; break;
        case 'csp': d.enabled = raw[0] !== 'off'; break;
        case 'cpu': d.rate = +(raw[0] || 4); break;
        case 'cpu-count': d.count = +(raw[0] || 4); break;
        case 'network-conditions': d = parseJsonOrRaw(raw.join(' '), { offline: raw[0] === 'offline' }); break;
        case 'block': d.patterns = parseJsonOrRaw(raw.join(' '), [raw[0]]); if (!Array.isArray(d.patterns)) d.patterns = [d.patterns]; break;
        case 'response-body': d.urlPattern = raw[0]; break;
        case 'cookie': d = parseJsonOrRaw(raw.join(' '), { name: raw[0], value: raw[1] }); break;
        case 'cookie-remove': d.name = raw[0]; if (raw[1]) d.url = raw[1]; break;
        case 'storage-set': d.key = raw[0]; d.value = raw[1]; d.type = raw[2] || 'local'; break;
        case 'storage-remove': d.key = raw[0]; d.type = raw[1] || 'local'; break;
        case 'storage-clear': d.type = raw[0] || 'local'; break;
        case 'storage': d.type = raw[0] || 'local'; break;
        case 'dialog': {
          if (raw[0] === 'auto') { d.auto = raw[1] !== 'off' && raw[1] !== 'false' && raw[1] !== '0'; if (raw[2]) d.promptText = raw[2]; }
          else { d.accept = raw[0] !== 'dismiss'; if (raw[1]) d.promptText = raw[1]; }
          break;
        }
        case 'tab': d.tabId = +raw[0]; break;
        case 'close-tab': d.tabId = +raw[0]; break;
        case 'upload': d.selector = raw[0]; d.files = parseJsonOrRaw(raw.slice(1).join(' '), [raw[1]]); if (!Array.isArray(d.files)) d.files = [d.files]; break;
        case 'snapshot': {
          // snapshot [file.png] [--annotate] [--full] [--fast] ...
          for (const a of raw) {
            if (/\.(png|jpe?g)$/i.test(a) && !d.file) d.file = a;
            else if (a === '--annotate' || a === '-a') d.annotate = true;
            else if (a === '--full') d.full = true;
            else if (a === '--fast') d.fast = true;
            else if (a === '--compact' || a.startsWith('--compact')) d.compact = true;
            else if (a.startsWith('--selector=')) d.selector = a.slice(11);
            else if (a.startsWith('--max=')) d.maxElements = +a.slice(6);
          }
          break;
        }
        case 'act':
        case 'fast': {
          const rawStr = raw.join(' ');
          try {
            const j = JSON.parse(rawStr);
            Object.assign(d, j);
            if (!d.action && j.action) d.action = j.action;
          } catch {
            d.action = raw[0];
            if (raw[1]) {
              try { Object.assign(d, JSON.parse(raw.slice(1).join(' '))); } catch { d.text = raw.slice(1).join(' '); if (raw[2]) d.selector = raw[1]; }
            }
          }
          d.act = true;
          // fast 别名默认 fast:true
          if (type === 'fast') d.fast = true;
          break;
        }
        case 'screenshot': case 'screenshot-full': case 'pdf':
          if (raw[0]) d.file = raw[0]; // 带文件名 → 该步骤单独执行并保存文件
          break;
        case 'sleep': {
          const ms = +(raw[0] || 1000);
          return { type: '_sleep', data: { ms } };
        }
        default: break; /* 无参数命令 */
      }
      if (CLIENT_STEPS.has(type)) return { type, data: d, _client: true, _raw: raw };
      return { type: pluginType, data: d };
    });

    // _sleep 与客户端本地步骤单独处理; 带 file 的截图/PDF 步骤单独执行(保存到本地)
    const batchSteps = norm.filter(s => !s._client && s.type !== '_sleep' && !s.data.file);
    const fileSteps = norm.filter(s => !s._client && s.type !== '_sleep' && s.data.file);
    const clientSteps = norm.filter(s => s._client);
    const sleeps = norm.filter(s => s.type === '_sleep');
    const results = [];
    if (batchSteps.length) {
      const r = await client.batch(batchSteps);
      results.push(...(r.steps || []));
    }
    for (const s of fileSteps) {
      const t0 = Date.now();
      try {
        let r;
        if (s.type === 'print-to-pdf') r = await client.pdfToFile(s.data.file);
        else if (s.type === 'screenshot-full') r = await client.screenshotFullToFile(s.data.file);
        else if (s.type === 'vision-snapshot' || s.type === 'snapshot') {
          const opts = { ...s.data }; delete opts.file;
          r = await client.snapshotToFile(s.data.file, opts);
        } else r = await client.screenshotToFile(s.data.file);
        results.push({ type: s.type, result: r, _ms: Date.now() - t0 });
      } catch (e) {
        results.push({ type: s.type, error: e.message, _ms: Date.now() - t0 });
      }
    }
    for (const s of clientSteps) {
      const t0 = Date.now();
      try {
        let r;
        switch (s.type) {
          case 'full': r = await client.fullAnalysis(); break;
          case 'analyze-all': r = await client.analyzeAllTabs(); break;
          case 'monitor': r = await client.startMonitor({ interval: +(s._raw?.[0] || 5000), duration: +(s._raw?.[1] || 60000) }); break;
          case 'monitor-stop': r = await client.stopMonitor(); break;
          case 'monitor-status': r = await client.getMonitorStatus(); break;
          case 'report': r = await client.generateReport(s._raw?.[0] || 'browser-report.json'); break;
          case 'act':
          case 'fast': {
            // 统一走 /act 一次 HTTP 完成高层意图
            const body = s.data.act ? s.data : { action: s.data.action || s._raw?.[0], ...s.data };
            // 如果 _raw 是 JSON，直接透传
            if (s._raw?.length === 1) {
              try { const j = JSON.parse(s._raw[0]); Object.assign(body, j); } catch {}
            }
            r = await client.request('/act', { method: 'POST', body });
            break;
          }
        }
        results.push({ type: s.type, result: r, _ms: Date.now() - t0 });
      } catch (e) {
        results.push({ type: s.type, error: e.message, _ms: Date.now() - t0 });
      }
    }
    for (const s of sleeps) {
      await new Promise(r => setTimeout(r, s.data.ms));
      results.push({ type: '_sleep', result: { slept: s.data.ms }, _ms: s.data.ms });
    }
    return { success: true, steps: results };
  }

  function printHelp() {
    console.log(`用法: node browser-client.js <command> [args]

基础:        status | tabs | full | debug-info | debug-on | debug-off | cdp-status
会话:        session | session-create | session-delete <id> [close] | session-assign <id> <tabId>
            session-release <id> [tabId] | session-tab <id> <url>
            (session-delete ... close: 同时关闭该会话标签页; session-tab 默认后台打开不抢焦点)
            (全局参数: --session <id> 使本次命令在会话内执行; --body-file <path> 从 UTF-8 JSON 读 POST body)
链式:        chain "cmd args" "cmd args" ...    (一次 HTTP+WS 往返, 支持 --- 分隔)
             chain --body-file steps.json       (文件含 {"steps":[插件命令...]}, 完整 JSON 免转义)
导航:        open <url> | open-current <url> | reload | back | forward | tab <id> | close-tab <id>
页面:        page-info | dom | html [sel] | frames | layout | query <sel> | query-all <sel> [n]
            query-many <json> | exists <sel> | text [sel] | attr <sel> <name> | value <sel>
操作:        click <sel> | hover <sel> | dblclick <sel> | rightclick <sel> | drag <sel> <json|target>
            mouse <type> <x> <y> | scroll <x> <y> | scroll-top | scroll-bottom
            scroll-into-view <sel> | scroll-by <x> <y>
输入:        type <sel|text> <text...> | key <key> [modifiers...] | fill <json>
            select <sel> <value|json> | check <sel> [on|off] | clear-field <sel> | focus <sel>
            f12 | f5 | enter | escape
JS/等待:    evaluate <code> | wait-for <sel> [ms] | wait-for-text <text> [ms] [sel]
            wait-for-url <pattern> [ms] | wait-load
 视觉:        snapshot [file] [--annotate] [--full] [--selector <sel>] [--max <n>]   (截图+锚点原子返回，视觉模型首选)
 截图/PDF:   screenshot [file] | screenshot-full [file] | screenshot-element <sel>
            pdf [file] [format] | upload <sel> <file...>
高亮:        highlight <sel> [color] [label] | highlight-clear
Cookie:      cookies | cookie-set <name> <value> | cookie-remove <name> [url]
            storage [local|session] | storage-set <key> <value> [type] | storage-remove <key> [type] | storage-clear [type]
网络:        network [filter] | network-clear | network-conditions <json|offline> | network-reset
            block <pattern...> | unblock | response-body <urlPattern> | cache-off [on|off] | csp [on|off]
性能:        performance | vitals | resources | cpu <rate>
检查:        a11y | seo | security | console [n] | console-clear | dom-changes | dom-changes-clear
模拟:        device <name|json> | device-clear | media <json> | dark | dark-off | auto-dark [on|off]
            geo <lat> <lng> [accuracy] | locale <locale> | timezone <tz>
            js [on|off] | cpu-count <n>
清理:        cleanup              (一键恢复: 设备/媒体/geo/时区/语言/CPU/JS/并发/网络/CSP/缓存/暗色/高亮/弹窗策略)
弹窗:        dialog [accept|dismiss] [promptText] | dialog auto [on|off] | dialogs (查看记录)
批量:        analyze-all | monitor [ms] [s] | monitor-stop | monitor-status
审计:        audit [url] | audit-html [file] [url] | audit-md [file] [url]
            history [url] | audit-run <json|url> | audit-status <taskId>
报告:        report [file.json]

示例:
  node browser-client.js open https://example.com
  node browser-client.js chain "open https://example.com" "wait-load" "page-info" "screenshot"
  node browser-client.js chain "open https://example.com" "click #btn" "dialog accept" "full"
  node browser-client.js evaluate "return document.title"
  node browser-client.js click "#search-button"
  node browser-client.js fill '[{"selector":"#user","value":"admin"},{"selector":"#pass","value":"123"}]'
  node browser-client.js pdf report.pdf
  node browser-client.js audit-html perf.html https://example.com
  node browser-client.js audit-run '["https://a.com","https://b.com"]'
`);
  }

  run();
}

module.exports = BrowserClient;
