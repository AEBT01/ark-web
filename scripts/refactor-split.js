/**
 * 重构辅助：把 bridge-server.js 的 150 分支 switch 按域提取为 capabilities/*.js
 *
 * 为什么用脚本而不是手抄：
 *   150 个分支体共约 1700 行，手抄必然引入偏差。脚本保证"体"逐字搬移，
 *   只做三类可验证的机械转换，并把无法自动判定的一律**报告出来**交人工处理。
 *
 * 用法：
 *   node scripts/refactor-split.js --dry      只分析并报告（默认）
 *   node scripts/refactor-split.js --emit     生成 capabilities/*.js
 *
 * 机械转换（仅此三类）：
 *   1) `result = X;`            → `return X;`
 *   2) 顶层 `break;`            → 删除（由 return 收尾）
 *   3) `this.`                  → `srv.`
 * 其余全部原样保留；闭包变量 req/res/url/pathname/tabId/sessionId/ttl/fresh/send
 * 由处理器入口解构获得，因此体里对这些名字的引用**无需改写**。
 */
const fs = require('fs');
const path = require('path');

const SRC = process.env.REFACTOR_SRC
  ? path.resolve(process.env.REFACTOR_SRC)
  : path.join(__dirname, '_legacy-bridge-server.js');   // 旧 switch 的快照（新建模块已不含 switch）
const OUT_DIR = path.join(__dirname, '..', 'server', 'capabilities');
const DRY = !process.argv.includes('--emit');

/* 域归属规则（按顺序匹配，先命中先归属） */
const DOMAINS = [
  ['meta', ['/health', '/status', '/clear-cache', '/batch']],
  ['session', ['/session']],
  ['tabs', ['/tabs', '/open', '/navigate', '/reload', '/back', '/forward', '/tab/activate', '/tab/close']],
  ['capture', ['/screenshot', '/snapshot', '/pdf', '/fast/snapshot']],
  ['act', ['/click', '/hover', '/dblclick', '/rightclick', '/drag', '/mouse', '/scroll', '/key', '/type', '/fill', '/select', '/check', '/clear', '/focus', '/highlight', '/dialog', '/upload', '/act', '/fast/act', '/fast/click', '/fast/fill']],
  ['dom', ['/page-info', '/dom', '/html', '/frames', '/layout', '/query', '/exists', '/get-text', '/text', '/get-attr', '/attr', '/get-value', '/value', '/evaluate', '/js', '/wait-for']],
  ['state', ['/cookies', '/cookie', '/storage']],
  ['network', ['/network', '/bypass-csp']],
  ['perf', ['/performance', '/vitals', '/resources', '/cpu', '/console', '/dom-changes', '/monitor']],
  ['emulate', ['/device', '/media', '/geo', '/locale', '/timezone', '/auto-dark', '/hardware-concurrency', '/reset-all']],
  ['inspect', ['/security', '/a11y', '/seo', '/full', '/analyze-all']],
  ['debug', ['/debug', '/reload-extension']],
  ['semantic', ['/semantic']],
  ['agent', ['/brain', '/agent']],
  ['kernel', ['/cdp']],
  ['audit', ['/audit', '/history']]
];

function domainOf(p) {
  for (const [name, prefixes] of DOMAINS) {
    if (prefixes.some(x => p === x || p.startsWith(x))) return name;
  }
  return null;
}

/* ---------- 1. 切出 switch 的每个 case 体 ---------- */
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split(/\r?\n/);

const switchLine = lines.findIndex(l => /^\s+switch \(pathname\) \{/.test(l));
if (switchLine < 0) throw new Error('找不到 switch (pathname)');
const switchIndent = lines[switchLine].match(/^\s*/)[0].length;
const caseIndent = switchIndent + 2;
const bodyIndent = switchIndent + 4;

// switch 结束：缩进回到 switchIndent 的 '}'
let switchEnd = -1;
for (let i = switchLine + 1; i < lines.length; i++) {
  if (lines[i] === ' '.repeat(switchIndent) + '}') { switchEnd = i; break; }
}
if (switchEnd < 0) throw new Error('找不到 switch 结束位置');

const caseRe = new RegExp('^' + ' '.repeat(caseIndent) + "case '([^']+)':");
const defaultRe = new RegExp('^' + ' '.repeat(caseIndent) + 'default:');

// 收集 case 标签位置
const labels = [];
for (let i = switchLine + 1; i < switchEnd; i++) {
  const m = caseRe.exec(lines[i]);
  if (m) labels.push({ path: m[1], line: i });
}

const cases = [];
for (let k = 0; k < labels.length; k++) {
  const startLabel = labels[k].line;
  // 连续吃 case 标签（fallthrough 别名）；不能先按"下一个标签"定边界，否则别名体被切成空
  const names = [];
  let i = startLabel;
  let m;
  while (i < switchEnd && (m = caseRe.exec(lines[i]))) { names.push(m[1]); i++; }
  if (!names.length) continue;
  const bodyStart = i;
  // 体结束于下一个 case 标签或 switch 的 default 子句（default 由 HTTP 外壳统一处理 404）
  let j = bodyStart;
  while (j < switchEnd && !caseRe.test(lines[j]) && !defaultRe.test(lines[j])) j++;
  const endExclusive = Math.min(j, switchEnd);

  // 跳过已被本次 fallthrough 消费掉的标签条目
  while (k + 1 < labels.length && labels[k + 1].line < bodyStart) k++;

  // 体尾的空行与注释（段注释 / 说明注释）不属于分支体，剥离
  let body = lines.slice(bodyStart, endExclusive);
  while (body.length && (!body[body.length - 1].trim() || /^\s*\/\//.test(body[body.length - 1]))) body.pop();

  cases.push({ names, body, line: startLabel + 1 });
}

/** 去掉字符串与行注释后的代码文本（用于可靠地数 token，避免把注释/文案里的词算进来） */
function codeOnly(joined) {
  return joined
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\/[^\n]*/g, '');
}

/* ---------- 2. 分析每个体 ---------- */
function analyze(c) {
  const b = c.body;
  const flags = {};
  const joined = b.join('\n');
  const code = codeOnly(joined);
  flags.assignments = (joined.match(/^\s*result = /gm) || []).length;
  flags.breaks = (joined.match(/^\s*break;\s*$/gm) || []).length;
  // 全篇 token 计数：简单体必须"恰好一次赋值、恰好一个 break、没有 return"
  flags.resultTokens = (code.match(/(?<![.\w$])result(?![\w$])/g) || []).length;
  flags.breakTokens = (code.match(/(?<![.\w$])break(?![\w$])/g) || []).length;
  flags.returnTokens = (code.match(/(?<![.\w$])return(?![\w$])/g) || []).length;
  flags.thisCount = (joined.match(/\bthis\./g) || []).length;
  // 逐行判断 this. 是否落在字符串里（不可跨行匹配，否则假阳性）
  flags.thisInString = b.some(l => {
    const stripped = l.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
    return /\bthis\./.test(stripped) !== /\bthis\./.test(l);
  });
  flags.declShadow = /^\s*(const|let|var)\s+(req|res|url|pathname|tabId|sessionId|ttl|fresh|send|result)\b/m.test(joined);
  flags.nestedFunction = /(^|[^.\w])function\s*\(/.test(joined);
  flags.multiAssign = flags.assignments > 1;
  const nonBlank = b.filter(l => l.trim());
  flags.empty = nonBlank.length === 0;
  // 尾部可能是 } 收口的块形态；取最后一个非 } 语句作为"尾语句"
  const tailIdx = (() => { for (let i = nonBlank.length - 1; i >= 0; i--) if (nonBlank[i].trim() !== '}') return i; return -1; })();
  flags.tail = tailIdx < 0 ? '(空体)' : nonBlank[tailIdx].trim();
  flags.simple = !flags.empty && !flags.thisInString && !flags.declShadow && !flags.multiAssign
    && flags.breaks === 1 && flags.tail === 'break;'
    && flags.resultTokens === 1 && flags.breakTokens === 1 && flags.returnTokens === 0;
  return flags;
}

/* ---------- 3. 报告 ---------- */
const byDomain = {};
const unassigned = [];
const complex = [];
for (const c of cases) {
  const f = analyze(c);
  c.flags = f;
  for (const n of c.names) {
    const d = domainOf(n);
    if (!d) unassigned.push(n);
    else (byDomain[d] = byDomain[d] || []).push(n);
  }
  if (!f.simple) complex.push({ path: c.names.join('|'), line: c.line, ...f });
}

console.log('switch 起止行:', switchLine + 1, '→', switchEnd + 1);
console.log('分支数（case 标签）:', labels.length, '| 分支体数:', cases.length);
console.log('\n=== 域归属 ===');
for (const [d, ps] of Object.entries(byDomain)) console.log(`  ${d.padEnd(10)} ${String(ps.length).padStart(3)}  ${ps.slice(0, 4).join(' ')}${ps.length > 4 ? ' …' : ''}`);
console.log('\n未归属:', unassigned.length ? unassigned.join(', ') : '（无）');
console.log('\n=== 需要人工处理的复杂体:', complex.length, '===');
for (const c of complex) {
  const why = [];
  if (c.thisInString) why.push('this出现在字符串');
  if (c.declShadow) why.push('重定义了闭包名');
  if (c.multiAssign) why.push('多次赋值result(' + c.assignments + ')');
  if (c.breaks !== 1) why.push('break数=' + c.breaks);
  if (c.tail !== "break;") why.push('结尾是「' + c.tail.slice(0, 40) + '」');
  console.log(`  L${c.line} ${c.path}  ← ${why.join(' / ')}`);
}
/* ---------- 4. 写出能力模块（实际调用在文件末尾，避免引用尚未初始化的常量） ---------- */
const DOMAIN_DOC = {
  meta: '存活探针 / 服务状态 / 缓存 / 批量',
  session: '多 agent 并行隔离的会话与标签页绑定',
  tabs: '标签页与导航',
  capture: '截图 / 快照 / PDF',
  act: '点击 / 输入 / 滚动的元素动作',
  dom: '页面信息、DOM 查询、脚本执行与等待',
  state: 'Cookie 与 Storage',
  network: '网络观测与拦截',
  perf: '性能指标 / 控制台 / DOM 变化 / 监控',
  emulate: '设备与环境模拟',
  inspect: '安全检查 / 无障碍 / SEO / 全量分析',
  debug: '调试授权',
  semantic: '语义层：页面消化 / 检索 / 锚点定位',
  agent: '云端大脑与 Agent 任务运行时',
  kernel: 'CDP 直连内核',
  audit: '审计引擎'
};

/** 按行去缩进；模板字符串内部逐字保留（去缩进会改字符串内容） */
function dedent(lines, n) {
  let inTpl = false;
  return lines.map(l => {
    const noEsc = l.replace(/\\`/g, '');
    const tplCount = (noEsc.match(/`/g) || []).length;
    const wasInTpl = inTpl;
    if (tplCount % 2 === 1) inTpl = !inTpl;
    if (wasInTpl) return l;                   // 模板字符串内部：原样保留
    const lead = (l.match(/^\s*/) || [''])[0];
    return l.slice(Math.min(n, lead.length));
  });
}

/** 唯一必需的改写：switch 里的 this 指向 server，搬出后改用 srv */
function rewriteThis(lines) {
  return lines.map(l => l.replace(/\bthis\./g, 'srv.'));
}

/** 块形态分支体自带的外层 { }（case 'x': { ... }）不承载语义，剥掉 */
function stripBlockBraces(body) {
  const b = body.slice();
  const first = b.findIndex(l => l.trim());
  if (first >= 0 && b[first].trim() === '{') b.splice(first, 1);
  for (let i = b.length - 1; i >= 0; i--) {
    if (!b[i].trim()) continue;
    if (b[i].trim() === '}') b.splice(i, 1);
    break;
  }
  return b;
}

function transformSimple(body) {
  const b = stripBlockBraces(body);
  const dropTrailing = (pred) => {
    for (let i = b.length - 1; i >= 0; i--) {
      if (!b[i].trim()) continue;
      if (pred(b[i])) b.splice(i, 1);
      return;
    }
  };
  dropTrailing(l => l.trim() === 'break;');
  // 唯一的 result = X  →  return X
  const pat = new RegExp('^' + ' '.repeat(bodyIndent) + 'result = ');
  const ai = b.findIndex(l => pat.test(l));
  if (ai >= 0) b[ai] = b[ai].replace(pat, ' '.repeat(bodyIndent) + 'return ');
  return b;
}

/**
 * 分支体引用的模块级名字 —— 搬迁后必须在新文件里可见，否则运行时才报 "xxx is not defined"
 * （静态语法检查发现不了；本次重构正是靠功能测试才抓到）。
 * 按"检测到什么就注入什么"生成前置声明，不做全量注入，保持依赖清晰。
 */
const PRELUDE_DEPS = [
  ['path', "const path = require('path');"],
  ['os', "const os = require('os');"],
  ['fs', "const fs = require('fs');"],
  ['crypto', "const crypto = require('crypto');"],
  ['WebSocket', "const WebSocket = require('ws');"],
  ['brain', "const brain = require('../brain');"],
  ['auditEngine', "const auditEngine = require('../audit');"],
  ['auditReport', "const auditReport = require('../audit-report');"],
  ['SERVER_DIR', "const { SERVER_DIR } = require('../core/paths');"],
  ['TOKEN_FILE', "const { TOKEN_FILE } = require('../core/paths');"],
  ['SHARED_TOKEN_FILE', "const { SHARED_TOKEN_FILE } = require('../core/paths');"],
  ['LEGACY_TOKEN_FILE', "const { LEGACY_TOKEN_FILE } = require('../core/paths');"],
  ['LOOPBACK_HOSTS', "const { LOOPBACK_HOSTS } = require('../core/paths');"],
  ['EXTENSION_PROTOCOLS', "const { EXTENSION_PROTOCOLS } = require('../core/paths');"]
];

const PATHS_DECL = "const { SERVER_DIR } = require('../core/paths');";

/** 分支体里是否以"独立标识符"形式用到某名字（排除属性访问与对象键） */
function usesName(code, name) {
  const re = new RegExp('(^|[^.\\w$])' + name + '(?![\\w$])(?!\\s*:)', 'm');
  return re.test(code);
}

/** 按实际使用情况生成该域的前置声明。__dirname 必须改写，故单独处理。 */
function buildPrelude(bodies) {
  const code = bodies.map(b => b.join('\n')).join('\n');
  const lines = [];
  const seen = new Set();
  const add = (name, decl) => { if (usesName(code, name) && !seen.has(decl)) { seen.add(decl); lines.push(decl); } };
  for (const [name, decl] of PRELUDE_DEPS) add(name, decl);
  // capabilities/ 比原位置深一层：照搬 __dirname 会让 path.join(__dirname,'..','client')
  // 指向 server/client。统一改写成 SERVER_DIR（= server/），与原语义一致。
  if (/__dirname/.test(code) && !seen.has(PATHS_DECL)) lines.push(PATHS_DECL);
  return lines;
}

/** 搬迁所需的逐行改写：this→srv 之外，只有这两处路径写法会错位 */
function rewriteLines(lines) {
  return lines.map(l => l
    .replace(/\b__dirname\b/g, 'SERVER_DIR')
    .replace(/require\('\.\/package\.json'\)/g, "require('../package.json')"));
}

/**
 * 生成一个分支体的处理器定义 + 路由挂载。
 * fallthrough 别名（case 'a': case 'b': 同一体）在 JS 里必须注册成同一处理器，
 * 因此生成 `const H n = ...` 再逐个挂载，别名关系因此显式可见。
 */
function routeEntry(names, body, complex, idx) {
  const fnName = 'H' + idx;
  const out = [];
  out.push('    const ' + fnName + " = async function (__ark) {");
  out.push('      const { req, res, url, pathname, tabId, sessionId, ttl, fresh, send } = __ark;');
  out.push('      const srv = __ark.server;');
  const lines = rewriteLines(rewriteThis(complex ? stripBlockBraces(body) : transformSimple(body)));
  // 简单体已到函数体层级（去 8 空格即可）；复杂体要再嵌两层，故整体去掉原缩进
  const ded = dedent(lines, complex ? bodyIndent : Math.max(0, bodyIndent - 8));
  if (complex) {
    // 结构复杂（嵌套 switch / 遮蔽闭包名）：原样搬移，用标号 switch 承载 result= / break; 的原语义
    out.push('      let result;');
    out.push('      {');
    out.push('        legacy: switch (0) { default:');
    ded.forEach(l => out.push(l.trim() ? '          ' + l : l));
    out.push('        }');
    out.push('      }');
    out.push('      return result;');
  } else {
    out.push('      {');
    if (!ded.filter(l => l.trim()).length) out.push('        return undefined;');
    else ded.forEach(l => out.push(l));
    out.push('      }');
  }
  out.push('    };');
  names.forEach((n, i) => {
    out.push(`    r['${n}'] = ${fnName};` + (i > 0 ? `   // 别名 → ${names[0]}` : ''));
  });
  return out.join('\n');
}

function emit() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const groups = {};
  for (const c of cases) {
    const d = domainOf(c.names[0]);
    if (!d) { console.log('跳过（未归属）:', c.names.join('|')); continue; }
    (groups[d] = groups[d] || []).push(c);
  }
  const files = [];
  for (const [d, list] of Object.entries(groups)) {
    const simple = list.filter(c => c.flags.simple);
    const hard = list.filter(c => !c.flags.simple);
    let idx = 0;
    const blocks = []
      .concat(simple.map(c => routeEntry(c.names, c.body, false, idx++)))
      .concat(hard.map(c => routeEntry(c.names, c.body, true, idx++)));
    const prelude = buildPrelude(list.map(c => c.body));
    const head = [
      '/**',
      ` * 能力域：${d} —— ${DOMAIN_DOC[d] || ''}`,
      ' *',
      ' * 由 scripts/refactor-split.js 从 bridge-server.js 的 switch 机械提取（可重复生成，勿手改）。',
      ' * 手写路由请放 capabilities/extra.js —— 本文件会被生成器覆盖。',
      ' *',
      ' * 提取原则（可证等价）：',
      ' *   · 简单体：`result = X; break;` → `return X;`（单赋值单出口，语义相同）',
      ' *   · 复杂体：分支体原样搬移，用标号 switch 承载其 result= / break; 的原语义，零改写',
      ' *   · fallthrough 别名（case a: case b: 同体）注册为同一处理器，别名关系显式标注',
      ' * 搬迁改写（三处，均为可验证的机械替换）：',
      ' *   · `this` → `srv`（原 switch 里的 this 指向 server）',
      ' *   · `__dirname` → `SERVER_DIR`（新文件深一层，照搬会让相对路径错位）',
      ' *   · `require(./package.json)` → `require(../package.json)`',
      ' * 处理器入口统一解构 req/res/url/pathname/tabId/sessionId/ttl/fresh/send，',
      ' * 故体里对这些名字的引用与原文完全一致。',
      ' */',
      ''
    ].concat(prelude.length ? prelude.concat(['', '']) : [])
      .concat([
        'module.exports = {',
        `  name: '${d}',`,
        `  group: '${d}',`,
        `  doc: ${JSON.stringify(DOMAIN_DOC[d] || '')},`,
        '  routes: (function () {',
        '    const r = {};',
        '',
        blocks.join('\n\n'),
        '',
        '    return r;',
        '  })()',
        '};',
        ''
      ]);
    fs.writeFileSync(path.join(OUT_DIR, d + '.js'), head.join('\n'));
    const aliases = list.reduce((n, c) => n + c.names.length, 0);
    files.push(`${d}(${list.length}体/${aliases}路由)`);
  }
  console.log('\n已写出 capabilities/:', files.join(' '));
  console.log('分支体数:', cases.length, '| 路由数（含别名）:', cases.reduce((n, c) => n + c.names.length, 0),
    '| 简单体:', cases.filter(c => c.flags.simple).length,
    '| 复杂体:', cases.filter(c => !c.flags.simple).length);
}

/* ---------- 5. 执行 ---------- */
if (DRY) console.log('\n（dry 模式：未写任何文件）');
else emit();
