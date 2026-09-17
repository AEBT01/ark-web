'use strict';
/**
 * 生成 extension/injected/ —— 语义提取器与定位器的「可注入副本」
 *
 * 背景：MV3 扩展上下文禁止字符串求值（CSP 无 unsafe-eval），所以把源码拼成字符串再 eval
 * 的注入方式，在调试通道不可用时会失败。chrome.scripting.executeScript({ files }) 由浏览器
 * 自己注入文件，不经 eval，因此必须有一份文件形态的提取器躺在扩展目录里。
 *
 * 单一来源：semantic/extractor.js 与 semantic/locate.js 是唯一真源，本模块只做搬运，
 * 并在生成的文件头写明「请勿直接编辑」。sync.js 与 package.js 都会先调用它。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_DIR = path.join(ROOT, 'extension', 'injected');
const SOURCES = [
  { from: 'semantic/extractor.js', to: 'extractor.js' },
  { from: 'semantic/locate.js', to: 'locate.js' }
];

const BANNER = (rel) =>
  '/* 本文件由 scripts/sync.js 从 ' + rel + ' 自动生成，请勿直接编辑 —— 改源码后重新运行同步。 */\n';

/** @returns {{changed:string[], files:string[]}} */
function refresh(opt) {
  const o = opt || {};
  const changed = [];
  const files = [];
  if (!fs.existsSync(TARGET_DIR)) {
    if (!o.dryRun) fs.mkdirSync(TARGET_DIR, { recursive: true });
  }
  for (const s of SOURCES) {
    const src = path.join(ROOT, s.from);
    if (!fs.existsSync(src)) throw new Error('缺少源文件: ' + s.from);
    const body = BANNER(s.from) + fs.readFileSync(src, 'utf8');
    const dst = path.join(TARGET_DIR, s.to);
    const rel = 'extension/injected/' + s.to;
    files.push(rel);
    let prev = null;
    try { prev = fs.readFileSync(dst, 'utf8'); } catch (e) { prev = null; }
    if (prev === body) continue;
    changed.push(rel);
    if (!o.dryRun) fs.writeFileSync(dst, body, 'utf8');
  }
  return { changed, files };
}

module.exports = { refresh, TARGET_DIR, SOURCES };
