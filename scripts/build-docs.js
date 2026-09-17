#!/usr/bin/env node
/**
 * build-docs.js —— 把 Markdown 文档渲染成单文件 HTML（自包含、可打印）
 *
 * 为什么要有它：说明书要能直接双击打开看（还能 Ctrl+P 打出来），
 * 但正文必须只维护一份 —— 否则 Markdown 与 HTML 两边的措辞一会儿就不一样了。
 * 于是以 Markdown 为唯一真源，本脚本负责渲染；每次改完文档跑一次即可。
 *
 * 支持的 Markdown 子集（够用就好）：标题 h1-h4、段落、表格、围栏代码块、
 * 有序/无序列表、引用块、分隔线；行内：粗体、行内代码、链接（含页内锚点）。
 * 先整体转义再生成白名单标签 —— 文档里出现 HTML 也不会被当成标签执行。
 *
 * 用法:
 *   node scripts/build-docs.js                     # 渲染 README.md → docs/README.html
 *   node scripts/build-docs.js --in=<md> --out=<html>
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argOf = (n) => { const hit = process.argv.find((a) => a.startsWith(n + '=')); return hit ? hit.slice(n.length + 1) : null; };
const IN = path.join(ROOT, argOf('--in') || 'README.md');
const OUT = path.join(ROOT, argOf('--out') || path.join('docs', 'README.html'));

/* ── 行内格式 ── */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((#[^)\s]+|https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/* ── 锚点：与 Markdown 里的 (#...) 对齐（中文标题同样处理） ── */
function slug(text) {
  return String(text).trim().toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-');
}

function render(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const toc = [];
  let i = 0;

  while (i < lines.length) {
    const ln = lines[i];

    // 围栏代码块
    if (/^```/.test(ln)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;   // 跳过收尾的 ```
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<div class="tw"><table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (h) {
      const lv = h[1].length;
      const id = slug(h[2]);
      if (lv === 2 || lv === 3) toc.push({ lv, id, text: h[2] });
      out.push('<h' + lv + ' id="' + id + '">' + inline(h[2]) + '</h' + lv + '>');
      i++;
      continue;
    }

    // 分隔线
    if (/^---+\s*$/.test(ln)) { out.push('<hr>'); i++; continue; }

    // 引用
    if (/^>\s?/.test(ln)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push('<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>');
      continue;
    }

    // 列表（有序 / 无序）
    if (/^\s*([-*+]|\d+\.)\s+/.test(ln)) {
      const ordered = /^\s*\d+\./.test(ln);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      }
      out.push('<' + (ordered ? 'ol' : 'ul') + '>'
        + items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
      continue;
    }

    // 空行
    if (!ln.trim()) { i++; continue; }

    // 段落
    const para = [ln];
    i++;
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,4}\s|```|>|\s*\|)/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push('<p>' + para.map(inline).join('<br>') + '</p>');
  }

  return { body: out.join('\n'), toc };
}

const CSS = `
:root{--bg:#f7f8fa;--surface:#fff;--border:#e8eaed;--text:#1a1d21;--text2:#5f6672;--text3:#9aa1ac;
--blue:#2563eb;--blue-soft:#eef4ff;--blue-border:#c7daff;--warn-soft:#fdf6ec;--warn-border:#f3d9a8;
--sans:"Schibsted Grotesk","Inter",system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
--serif:"Newsreader",Georgia,"Times New Roman","Songti SC",serif;
--mono:"JetBrains Mono",ui-monospace,"SF Mono",Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.75 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:860px;margin:0 auto;padding:44px 26px 90px}
h1{font-size:30px;letter-spacing:-.01em;margin:0 0 10px}
h1 em{font-family:var(--serif);font-style:italic}
h2{font-size:20px;margin:42px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--border)}
h3{font-size:16px;margin:28px 0 8px}
h4{font-size:14px;margin:20px 0 6px;color:var(--text2)}
p{margin:0 0 13px}
a{color:var(--blue);text-decoration:none;border-bottom:1px solid var(--blue-border)}
a:hover{border-bottom-color:var(--blue)}
code{font-family:var(--mono);font-size:12.5px;background:rgba(16,24,40,.055);padding:1.5px 5px;border-radius:5px}
pre{background:#0f1420;color:#e6edf7;padding:14px 16px;border-radius:10px;overflow:auto;margin:0 0 16px}
pre code{background:none;padding:0;color:inherit;font-size:12.5px;line-height:1.7}
blockquote{margin:0 0 16px;padding:10px 14px;background:var(--blue-soft);border:1px solid var(--blue-border);
border-left-width:3px;border-radius:8px;color:var(--text2)}
blockquote strong{color:var(--text)}
.tw{overflow-x:auto;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:13.5px;background:var(--surface)}
th,td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}
th{background:#fbfcfd;font-weight:600;white-space:nowrap}
hr{border:none;border-top:1px solid var(--border);margin:30px 0}
ul,ol{margin:0 0 16px;padding-left:22px}
li{margin:4px 0}
.hero{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 24px;margin:0 0 26px;
box-shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)}
.hero .meta{color:var(--text3);font-size:13px;margin-top:6px}
.toc{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin:0 0 30px}
.toc__t{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-bottom:8px}
.toc a{display:block;border:none;padding:2px 0;color:var(--text2)}
.toc a:hover{color:var(--blue)}
.toc a.h3{padding-left:16px;font-size:13.5px}
.foot{margin-top:56px;padding-top:16px;border-top:1px solid var(--border);color:var(--text3);font-size:12.5px}
@media print{
  body{background:#fff;font-size:12pt}
  .wrap{max-width:none;padding:0}
  .toc{page-break-after:always}
  h2{page-break-after:avoid}
  pre,table,blockquote{page-break-inside:avoid}
  a{border:none;color:var(--text)}
}
`;

function main() {
  if (!fs.existsSync(IN)) {
    console.error('找不到输入文件: ' + IN);
    console.error('  用法: node scripts/build-docs.js [--in=<markdown>] [--out=<html>]（默认 README.md → docs/README.html）');
    process.exit(1);
  }
  const md = fs.readFileSync(IN, 'utf8');
  const { body, toc } = render(md);

  // 文档自带「## 目录」章节时不再生成目录卡片 —— 否则页面上会出现两个"目录"
  const hasOwnToc = /^##\s+目录\s*$/m.test(md);
  const tocHtml = (toc.length && !hasOwnToc)
    ? '<nav class="toc"><div class="toc__t">目录</div>'
      + toc.map((t) => '<a class="h' + t.lv + '" href="#' + t.id + '">' + esc(t.text) + '</a>').join('')
      + '</nav>'
    : '';

  const title = (md.match(/^#\s+(.*)$/m) || [, '文档'])[1];
  const html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + esc(title) + '</title>\n<style>' + CSS + '</style>\n</head>\n<body>\n<div class="wrap">\n'
    + '<div class="hero"><h1>' + inline(title) + '</h1>'
    + '<div class="meta">由 <code>node scripts/build-docs.js</code> 从 <code>'
    + path.relative(ROOT, IN).split(path.sep).join('/') + '</code> 生成 —— 改文档请改 Markdown，不要直接编辑本页。</div></div>\n'
    + tocHtml + '\n' + body + '\n'
    + '<div class="foot">Ark Web · 生成于 ' + new Date().toISOString().slice(0, 10) + ' · Ctrl+P 可直接打印</div>\n'
    + '</div>\n</body>\n</html>\n';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  console.log('已生成: ' + OUT);
  console.log('  源文件: ' + path.relative(ROOT, IN) + '（' + (md.length / 1024).toFixed(1) + ' KB）');
  console.log('  输出  : ' + (html.length / 1024).toFixed(1) + ' KB，目录 ' + toc.length + ' 条');
}

main();
