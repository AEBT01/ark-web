#!/usr/bin/env node
/* 动作数组执行器: 模型输出 [{"op","args"}] -> bridge (localhost:9333)
 * 用法:
 *   node exec-actions.js <actions.json 文件|JSON字符串>   # 执行全部动作
 *   echo "[...]" | node exec-actions.js -                 # stdin
 * 兼容: type 的 text/value 双 key(归一化 text 优先); 逐步输出结果, 失败不中断
 */
const BASE = 'http://localhost:9333';

async function api(path, body) {
  const r = await fetch(BASE + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  } : undefined);
  const j = await r.json().catch(() => ({}));
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MAP = {
  navigate:          a => ['/open',              { url: a.url, current: true }],
  type:              a => ['/type',              { selector: a.selector, text: a.text ?? a.value, mode: 'fast' }],
  click:             a => ['/click',             { selector: a.selector }],
  fill:              a => ['/fill',              { fields: [{ selector: a.selector, value: a.value ?? a.text }] }],
  select:            a => ['/select',            { selector: a.selector, value: a.value ?? a.text }],
  check:             a => ['/check',             { selector: a.selector, checked: a.checked }],
  key:               a => ['/key',               { key: a.key, modifiers: a.modifiers }],
  submit:            a => ['/key',               { key: 'Enter' }],
  query:             a => ['/query',             { selector: a.selector }],
  wait_for:          a => ['/wait-for',          { selector: a.selector, timeout: a.timeout_ms ?? 8000 }],
  wait_for_url:      a => ['/wait-for-url',      { pattern: a.url_contains ?? a.pattern, timeout: a.timeout_ms ?? 15000 }],
  scroll_into_view:  a => ['/scroll-into-view',  { selector: a.selector }],
  scroll_by:         a => ['/scroll-by',         { y: a.y ?? 800 }],
};

async function execOne(op, args) {
  const fn = MAP[op];
  if (!fn) return { ok: false, err: `未知 op: ${op}` };
  const [path, body] = fn(args);
  const r = await api(path, body);
  if (r && r.error && !r.success) return { ok: false, err: String(r.error).slice(0, 200) };
  return { ok: r && r.success !== false, detail: r };
}

(async () => {
  let raw;
  if (process.argv[2] === '-') {
    const buf = [];
    for await (const c of process.stdin) buf.push(c);
    raw = buf.join('');
  } else if (process.argv[2]) {
    raw = /^[\s\[]/.test(process.argv[2])
      ? process.argv[2]
      : require('fs').readFileSync(process.argv[2], 'utf8');
  } else {
    console.error('用法: node exec-actions.js <actions.json> | "-" 读 stdin');
    process.exit(1);
  }
  let actions;
  try { actions = JSON.parse(raw); }
  catch (e) { console.error('JSON 解析失败:', e.message); process.exit(1); }
  if (!Array.isArray(actions)) { console.error('需要 JSON 数组'); process.exit(1); }

  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const op = a.op ?? a.type, args = a.args ?? a;
    const t0 = Date.now();
    let r;
    try { r = await execOne(op, args); }
    catch (e) { r = { ok: false, err: e.message }; }
    r.ms = Date.now() - t0;
    results.push({ op, args, ...r });
    const status = r.ok ? 'OK ' : 'FAIL';
    console.log(`[${i + 1}/${actions.length}] ${status} ${op} ${JSON.stringify(args).slice(0, 80)}${r.err ? ' -> ' + r.err : ''}`);
    if (op === 'navigate') await sleep(1500);
    else if (op === 'wait_for' || op === 'wait_for_url') { /* 端点已阻塞等待 */ }
    else await sleep(300);
  }
  const ok = results.filter(r => r.ok).length;
  console.log(`\n完成: ${ok}/${results.length} 步成功`);
  if (results.some(r => !r.ok)) {
    console.log('失败明细:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.op}: ${r.err}`));
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
