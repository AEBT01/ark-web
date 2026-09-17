/**
 * 生成代码的自由标识符检查（capabilities/*.js）
 *
 * 为什么需要它：`node --check` 只验证语法，**不验证标识符是否存在**。
 * 本次重构把 143 个分支体从 bridge-server.js 搬到 capabilities/*，
 * 体里引用的模块级名字（path / brain / auditReport / TOKEN_FILE / __dirname 相对路径 …）
 * 在新文件里可能不存在或指向错位置 —— 语法检查全过，运行时才 500。
 * 这个检查器就是为了在"跑功能测试之前"抓出这类错误。
 *
 * 做法：剥离字符串与注释后，取出所有标识符，减去
 *   · 本文件声明名（const/let/var/function/class/参数/解构）
 *   · 属性访问（前面带 . 的）与对象字面量键（后面跟 : 的）
 *   · 语言内置与宿主全局
 * 剩下的即为"需要外部提供"的名字，逐条列出。
 *
 * 用法: node scripts/check-capabilities.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'server', 'capabilities');

const GLOBALS = new Set([
  // 语言
  'undefined', 'null', 'true', 'false', 'this', 'super', 'new', 'typeof', 'instanceof', 'void', 'delete', 'in', 'of',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch',
  'finally', 'throw', 'function', 'class', 'extends', 'const', 'let', 'var', 'async', 'await', 'yield', 'import',
  'export', 'from', 'as', 'static', 'get', 'set', 'debugger', 'with',
  // 运行时 / 宿主
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console', 'globalThis', 'Buffer',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'AbortController', 'AbortSignal',
  'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'structuredClone', 'performance', 'crypto',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'escape', 'unescape', 'eval', 'Function', 'ArrayBuffer', 'Uint8Array', 'DataView', 'WebSocket'
]);

/** 去掉字符串、模板串与注释，避免把文案里的词当成标识符 */
function codeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = null;           // null | "'" | '"' | '`' | '//' | '/*'
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (state === null) {
      if (c === '/' && d === '/') { state = '//'; i += 2; continue; }
      if (c === '/' && d === '*') { state = '/*'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (state === '//') { if (c === '\n') { state = null; out += c; } i++; continue; }
    if (state === '/*') { if (c === '*' && d === '/') { state = null; i += 2; } else i++; continue; }
    // 字符串/模板串
    if (c === '\\') { i += 2; continue; }
    if (c === state) { state = null; i++; continue; }
    // 模板串里的 ${...} 视为代码（粗略处理：整体跳过内容，避免误报）
    i++;
  }
  return out;
}

function analyze(file) {
  const src = fs.readFileSync(file, 'utf8');
  const code = codeOnly(src);

  const declared = new Set();
  const declRe = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(declRe)) declared.add(m[1]);
  // 函数参数（含嵌套解构参数，如 .map(([id, s]) => ...)）
  // 参数区间内出现的标识符一律算已声明 —— 宁可少报也不误报，避免把工具本身变成噪音源
  const paramRe = /(?:function\s*[A-Za-z_$\w]*\s*)?\(([^()]*)\)\s*(?:=>|\{)/g;
  for (const m of code.matchAll(paramRe)) {
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) declared.add(id[0]);
  }
  // 解构声明：用括号配平扫描，避免 `const { a = [], b } = x` 这种嵌套在首个 ] 处被截断
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([{[])/g)) {
    const open = m[1];
    const close = open === '{' ? '}' : ']';
    let depth = 0, end = -1;
    for (let i = m.index + m[0].length - 1; i < code.length; i++) {
      if (code[i] === open) depth++;
      else if (code[i] === close) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const span = code.slice(m.index, end + 1);
    // 该模式里出现的标识符一律视为"已声明"（对 `{a: b}` 会把 a 也算进来，属安全的方向性偏差）
    for (const id of span.matchAll(/[A-Za-z_$][\w$]*/g)) declared.add(id[0]);
  }
  // 箭头函数单参：x => ...
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
  // catch (e)
  for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  // legacy: 标号
  for (const m of code.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:switch|for|while|\{)/gm)) declared.add(m[1]);

  const free = new Map();   // name -> 出现次数
  // 关键：标识符末尾必须用"不可回溯"的边界，否则 (?!\s*:) 会让贪婪匹配回退一位，
  // 把 name / case / error 截成 nam / cas / erro，产出满屏假阳性。
  const idRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*:)/g;
  for (const m of code.matchAll(idRe)) {
    const name = m[2];
    if (GLOBALS.has(name) || declared.has(name)) continue;
    free.set(name, (free.get(name) || 0) + 1);
  }
  return { declared: declared.size, free };
}

let bad = 0;
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js') && f !== 'index.js').sort();
for (const f of files) {
  const { declared, free } = analyze(path.join(DIR, f));
  if (free.size === 0) { console.log(`  通过  ${f}（声明 ${declared} 个，无外部依赖）`); continue; }
  bad++;
  console.log(`  失败  ${f} —— 引用了本文件未声明的名字:`);
  for (const [name, n] of [...free].sort((a, b) => b[1] - a[1])) console.log(`          ${name}  (${n} 次)`);
}
console.log(`\n${files.length - bad}/${files.length} 个能力模块无未声明标识符`);
process.exit(bad === 0 ? 0 : 1);
