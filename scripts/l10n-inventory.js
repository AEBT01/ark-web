/**
 * 盘点 BrowserOS 已装扩展的本地化状态与英文 UI 字符串规模
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.EXT_BASE;
if (!BASE) { console.error('需要 EXT_BASE 环境变量'); process.exit(1); }

for (const id of fs.readdirSync(BASE)) {
  const dir = path.join(BASE, id);
  if (!fs.statSync(dir).isDirectory()) continue;
  const versions = fs.readdirSync(dir).filter(v => fs.statSync(path.join(dir, v)).isDirectory());
  const ver = versions[0];
  const root = path.join(dir, ver);
  console.log('==== ' + id + '  (' + ver + ') ====');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); }
  catch (e) { console.log('  manifest 读取失败:', e.message); continue; }

  // 名称可能是 __MSG_xxx__ 引用
  let name = manifest.name || '?';
  const nameRef = /^__MSG_(.+)__$/.exec(name);
  if (nameRef && manifest.default_locale) {
    try {
      const msg = JSON.parse(fs.readFileSync(path.join(root, '_locales', manifest.default_locale, 'messages.json'), 'utf8'));
      name = (msg[nameRef[1]] || {}).message || name;
    } catch (e) { }
  }
  console.log('  名称:', name, '| default_locale:', manifest.default_locale || '(无 i18n)');

  // _locales 语言清单
  const locDir = path.join(root, '_locales');
  if (fs.existsSync(locDir)) console.log('  _locales 语言:', fs.readdirSync(locDir).join(', '));

  // HTML/JS 文件清单 + 英文字符串粗测
  const uiFiles = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (f !== 'node_modules' && f[0] !== '.') walk(p); continue; }
      if (/\.(html|js)$/.test(f)) uiFiles.push(p);
    }
  })(root);
  let enCount = 0, cnCount = 0, totalText = 0;
  const enSamples = [];
  for (const f of uiFiles) {
    const src = fs.readFileSync(f, 'utf8');
    // 粗测：抽出 HTML 文本节点与 JS 字符串里的英文单词序列
    const cn = (src.match(/[\u4e00-\u9fff]/g) || []).length;
    const enWords = (src.match(/>[^<>{}]*[A-Za-z]{3}[^<>{}]*</g) || []).concat(src.match(/['"`][A-Z][a-z]+ [a-z][^'"`]{3,}['"`]/g) || []);
    cnCount += cn;
    enCount += enWords.length;
    totalText += src.length;
    if (enWords.length > 5 && enSamples.length < 8) {
      enSamples.push({ file: path.relative(root, f), sample: enWords.slice(0, 3).map(x => x.slice(0, 60)) });
    }
  }
  console.log('  UI 文件数:', uiFiles.length, '| 中文字符:', cnCount, '| 疑似英文字符串:', enCount, '| 总大小:', Math.round(totalText / 1024) + 'KB');
  enSamples.forEach(s => console.log('    e.g.', s.file, '→', JSON.stringify(s.sample)));
}
