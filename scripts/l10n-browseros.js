/**
 * BrowserOS 汉化 · 第二步：渲染真实页面并采集用户可见文本
 * 采集源：innerText / placeholder / aria-label / title / 按钮
 * 用法: node scripts/l10n-browseros.js dump
 * 输出: scripts/l10n-visible.json（去重后的字符串清单，供人工翻译）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const NEO_ID = 'pjimfkbpehlcllblajnpfamdfjhhlgkc';
const FB_ID = 'adlpneommgkgeanpaekgoaolcpncohkf';
const PORT = 9110;

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const DUMP_EXPR = `(function(){
    var texts = new Set();
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var n;
      while ((n = walker.nextNode())) {
        var t = (n.textContent||'').trim();
        if (t && /[a-zA-Z]{2}/.test(t)) texts.add(t);
      }
    } catch(e){}
    ['placeholder','aria-label','title','data-tip'].forEach(function(attr){
      document.querySelectorAll('['+attr+']').forEach(function(el){
        var v = (el.getAttribute(attr)||'').trim();
        if (v && /[a-zA-Z]{2}/.test(v)) texts.add('[attr:'+attr+'] '+v);
      });
    });
    document.querySelectorAll('button, a, option, summary, [role=button], [role=tab], [role=menuitem]').forEach(function(el){
      var t = (el.textContent||'').trim();
      if (t && t.length < 80 && /[a-zA-Z]{2}/.test(t)) texts.add('[ctl] '+t);
    });
    return JSON.stringify({ url: location.href, title: document.title, count: texts.size, texts: Array.from(texts) });
  })()`;

  const out = {};
  for (const [label, url] of [['neo 新标签页', `chrome-extension://${NEO_ID}/newtab.html`], ['feedback 弹窗', `chrome-extension://${FB_ID}/popup.html`]]) {
    // 用 HTTP 端点开页，再直连该页自己的 WebSocket（浏览器级会话对扩展页的 Runtime 不可用）
    let created;
    try {
      created = await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?' + url, method: 'PUT' }, res => {
          const c = []; res.on('data', d => c.push(d));
          res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
        });
        r.on('error', reject); r.end();
      });
    } catch (e) { created = await httpJson('/json/new?' + url); }
    await new Promise(r => setTimeout(r, 3500));
    const list = await httpJson('/json/list');
    const page = list.find(t => t.id === created.id);
    if (!page || !page.webSocketDebuggerUrl) { out[label] = { error: '页面未找到或无调试口' }; continue; }
    const pageWs = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { pageWs.on('open', r); pageWs.on('error', j); });
    let seq = 0;
    const pageSend = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      const on = raw => {
        const m = JSON.parse(raw);
        if (m.id !== id) return;
        pageWs.off('message', on);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      };
      pageWs.on('message', on);
      pageWs.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { pageWs.off('message', on); reject(new Error(method + ' 超时')); }, 30000);
    });
    let dump;
    try {
      const r = await pageSend('Runtime.evaluate', { expression: DUMP_EXPR, returnByValue: true });
      dump = r.exceptionDetails ? { error: JSON.stringify(r.exceptionDetails).slice(0, 200) } : JSON.parse(r.result.value);
    } catch (e) { dump = { error: e.message }; }
    out[label] = dump;
    await httpJson('/json/close/' + created.id).catch(() => { });
    pageWs.close();
  }

  const outFile = path.join(__dirname, 'l10n-visible.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log('已写入', outFile);
  for (const [k, v] of Object.entries(out)) {
    console.log('\n=== ' + k + ' ===  title: ' + (v.title || '') + '  字符串数: ' + (v.count || 0) + (v.error ? ' | 错误: ' + v.error : ''));
    (v.texts || []).slice(0, 100).forEach(t => console.log('  ' + t));
  }
}
main().catch(e => { console.error('失败:', e.message); process.exit(1); });

/* ── 静态提取：从压缩包里筛出"疑似 UI 文案"的字符串字面量 ── */
function extractCandidates(root, out) {
  const seen = new Map();
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (/\.(js|html)$/.test(f)) files.push(p);
    }
  })(root);
  const NOISE = /(\u00|x1b|\\|=>|<\/|function|var |const |let |return|typeof|require\(|http:\/\/|https:\/\/|\.js|\.css|\.png|\.svg|woff|localhost|127\.0\.0\.1|chrome-extension|aria-|data-|^[a-z0-9_-]+$)/i;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // 双引号/单引号/反引号字符串字面量
    const re = /"((?:[^"\\n]|\.){3,120})"|'((?:[^'\\n]|\.){3,120})'/g;
    let m;
    while ((m = re.exec(src))) {
      let t = m[1] != null ? m[1] : m[2];
      // 还原常见转义
      t = t.replace(/\n/g, ' ').replace(/\\"/g, '"').replace(/\'/g, "'");
      const trimmed = t.trim();
      if (trimmed.length < 4 || trimmed.length > 90) continue;
      if (NOISE.test(trimmed)) continue;
      // UI 文案特征：至少两个英文单词，首词大写开头，或全部小写词组；且含空格
      if (!/ /.test(trimmed)) continue;
      const words = trimmed.split(/\s+/);
      if (words.length < 2 || words.length > 14) continue;
      if (!/^[A-Z]/.test(trimmed) && !/^(get|set|open|close|add|new|run|start|stop|use|how|what|try|your|the|this|no|not|to|for|with|from|enter|click|select|delete|remove|save|copy|edit|view|search|check|load|sign|import|export|are|is|we|it|my|need|must|should|please|welcome|waiting|working|failed|error|enable|disable|install|connect|disconnect|manage|read|write|paste|download|upload|update|create|choose|pick|show|hide|press|hold|drag|drop|scan|ask|review|confirm|cancel|continue|back|next|done|ready|last|first|see|more|less|all|none|by|on|off|in|out|up|down|left|right)\b/.test(trimmed)) continue;
      if (/[<>{}[\]]|\bif\b|\bfor\b|===|!==|\+\+|&&|\|\|/.test(trimmed)) continue;
      // 大小写混杂无空格的驼峰（代码标识符）排除：单词里大写占比>40%
      const upper = trimmed.replace(/[^A-Z]/g, '').length;
      if (upper / trimmed.length > 0.4) continue;
      const key = trimmed;
      if (seen.has(key)) { seen.set(key, seen.get(key) + 1); continue; }
      seen.set(key, 1);
      out.push({ text: trimmed });
    }
  }
}

if (process.argv.includes('extract')) {
  const NEO2 = path.join(os.homedir(), 'AppData', 'Local', 'BrowserClaw', 'User Data', 'Default', 'Extensions', 'pjimfkbpehlcllblajnpfamdfjhhlgkc', '0.2.17.0_0');
  const FB2 = path.join(os.homedir(), 'AppData', 'Local', 'BrowserClaw', 'User Data', 'Default', 'Extensions', 'adlpneommgkgeanpaekgoaolcpncohkf', '57.0.0.0_0');
  const out = [];
  extractCandidates(NEO2, out);
  extractCandidates(FB2, out);
  const outFile = path.join(__dirname, 'l10n-candidates.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1), 'utf8');
  console.log('候选字符串:', out.length, '→', outFile);
  out.slice(0, 400).forEach(c => console.log('  ' + c.text));
}
