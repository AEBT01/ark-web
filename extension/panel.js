/**
 * panel.js —— 生产线面板逻辑（去 AI：全部本地预设 + 自检 + 逻辑修复）
 *
 * 后端：本机生产服务 http://127.0.0.1:9336（端点见 tools/prod-server.js）
 * 面板只做三件事：显示状态、发指令、按预设规则重试。不做任何"判断"。
 */
const SRV = 'http://127.0.0.1:9336';
const $ = (id) => document.getElementById(id);
let PICKED = null;      // { cat, name, path }
let TREE = null;

async function api(p, opt) {
  const r = await fetch(SRV + p, Object.assign({ cache: 'no-store' }, opt || {}));
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/csv')) return { csv: await r.text() };
  try { return await r.json(); } catch (e) { return { error: 'HTTP ' + r.status }; }
}

/* ── 自检（启动即跑，预设规则）── */
async function selfCheck() {
  const el = $('selfcheck');
  try {
    const h = await api('/health');
    if (!h.ok) { el.innerHTML = '<span class="bad">✗ 生产服务异常</span>'; return; }
    const d = h.deps || {};
    const parts = [
      d.桥接 ? '<span class="ok">桥接✓</span>' : '<span class="bad">桥接✗</span>',
      '<span class="' + (d.插件连接数 > 0 ? 'ok' : 'warn') + '">插件 ' + d.插件连接数 + ' 个</span>',
      d.类目清单 ? '<span class="ok">类目✓</span>' : '<span class="bad">类目✗</span>',
      '<span class="k">缓存 ' + (d.判定缓存条数 || 0) + ' 条</span>',
      d.扫描进程 ? '<span class="ok">扫描进行中</span>' : '<span class="k">空闲</span>',
    ];
    el.innerHTML = parts.join(' · ');
  } catch (e) {
    el.innerHTML = '<span class="bad">✗ 连不上生产服务（' + SRV + '）—— 请确认 tools/prod-server.js 已启动</span>';
  }
}

/* ── ① 类目树 ── */
async function loadTree() {
  const t = $('tree');
  try {
    const r = await api('/categories');
    if (!r.tree) { t.innerHTML = '<span class="bad">类目树加载失败</span>'; return; }
    TREE = r.tree;
    $('catStat').textContent = '（' + (r.list ? r.list.total : '?') + ' 条 / 可扫 ' + (r.list ? r.list.leaf : '?') + '）';
    renderTree(TREE);
  } catch (e) { t.innerHTML = '<span class="bad">' + e + '</span>'; }
}
function renderTree(root, filter) {
  const box = $('tree');
  box.innerHTML = '';
  const kw = (filter || '').trim().toLowerCase();
  const match = (node) => {
    if (!kw) return true;
    if (node.name.toLowerCase().includes(kw)) return true;
    return (node.children || []).some(match);
  };
  const make = (node, depth) => {
    if (!match(node)) return null;
    const wrap = document.createElement('div');
    wrap.className = 'tnode';
    const row = document.createElement('div');
    row.className = 'trow' + (PICKED && PICKED.cat === node.cat ? ' sel' : '');
    row.style.paddingLeft = (4 + depth * 12) + 'px';
    const tgl = document.createElement('span');
    tgl.className = 'tgl';
    const kids = (node.children || []).filter(match);
    tgl.textContent = kids.length ? '▸' : '';
    row.appendChild(tgl);
    const label = document.createElement('span');
    label.textContent = node.name;
    if (node.cat) label.className = 'leaf';
    row.appendChild(label);
    if (node.cat) {
      const p = document.createElement('span');
      p.className = 'k';
      p.textContent = ' #' + node.cat;
      row.appendChild(p);
      row.onclick = () => { PICKED = { cat: node.cat, name: node.name }; $('catPicked').textContent = node.name + ' #' + node.cat; renderTree(TREE, $('catSearch').value); };
    } else {
      row.onclick = () => {
        const open = wrap.dataset.open === '1';
        wrap.dataset.open = open ? '0' : '1';
        tgl.textContent = open ? '▸' : '▾';
        body.style.display = open ? 'none' : 'block';
      };
    }
    wrap.appendChild(row);
    const body = document.createElement('div');
    if (kids.length) for (const k of kids) { const el = make(k, depth + 1); if (el) body.appendChild(el); }
    // 搜索时默认全展开
    body.style.display = kw ? 'block' : (wrap.dataset.open === '1' ? 'block' : 'none');
    if (!kw && kids.length) tgl.textContent = '▸';
    wrap.appendChild(body);
    return wrap;
  };
  for (const c of (root.children || [])) { const el = make(c, 0); if (el) box.appendChild(el); }
  if (!box.children.length) box.innerHTML = '<span class="k">无匹配</span>';
}

/* ── ② 账号 / 实例 ── */
async function loadAccounts() {
  const box = $('accList');
  try {
    const r = await api('/accounts');
    const acc = r.accounts || [];
    $('accStat').textContent = acc.length ? '（' + acc.length + ' 个实例）' : '（无）';
    if (!acc.length) { box.innerHTML = '<span class="k">没有已连接的窗口。点上面「开启新窗口」，并在新窗口里登录账号。</span>'; return; }
    box.innerHTML = acc.map((a) => {
      const dup = a.labelDup > 1 ? ' <span class="bad">⚠ 撞名×' + a.labelDup + '</span>' : '';
      const st = a.loggedIn ? '<span class="ok">已登录</span>' : '<span class="warn">未读到登录</span>';
      return '<div class="card"><b>' + (a.nick || '(未登录)') + '</b>' + dup + '<br>' +
        '<span class="k">连接名 ' + a.label + ' · ' + a.browser + ' · tab ' + (a.tab || '-') + ' · 指纹 ' + (a.fp || '-') + '</span><br>' + st + '</div>';
    }).join('');
  } catch (e) { box.innerHTML = '<span class="bad">' + e + '</span>'; }
}
async function spawnInstance() {
  const b = $('btnSpawn'); b.disabled = true; $('spawnHint').textContent = '正在创建沙盒隔离实例…';
  try {
    const r = await api('/spawn-instance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    $('spawnHint').innerHTML = (r.ok ? '<span class="ok">✓ 已启动新实例</span>' : '<span class="bad">✗ 启动失败</span>') +
      '<br><span class="k">' + (r.hint || '') + '</span>';
    setTimeout(loadAccounts, 6000);
  } catch (e) { $('spawnHint').innerHTML = '<span class="bad">' + e + '</span>'; }
  b.disabled = false;
}

/* ── ③ 检验 ── */
async function verify() {
  const out = $('verOut'); out.innerHTML = '<span class="k">检验中…（会逐个实例读登录身份）</span>';
  try {
    const r = await api('/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    $('verStat').textContent = r.pass ? '（✅ 通过）' : '（❌ 未通过）';
    out.innerHTML = (r.pass ? '<div class="ok"><b>✅ 生产准入通过</b></div>' : '<div class="bad"><b>❌ 未通过 —— 按下面提示修正</b></div>') +
      (r.checks || []).map((c) => '<div class="chk"><span class="' + (c.pass ? 'ok' : 'bad') + '">' + (c.pass ? '✅' : '❌') + '</span><span>' + c.name + ' <span class="k">' + c.detail + '</span></span></div>').join('') +
      '<pre>' + JSON.stringify(r.accounts || [], null, 1) + '</pre>';
  } catch (e) { out.innerHTML = '<span class="bad">' + e + '</span>'; }
}

/* ── ④ 扫描 ── */
let scanTimer = null;
async function startScan() {
  if (!PICKED) { $('scanOut').innerHTML = '<span class="warn">请先在 ① 选择类目</span>'; return; }
  $('scanOut').innerHTML = '<span class="k">启动中…</span>';
  try {
    const r = await api('/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cat: PICKED.cat }) });
    $('scanOut').innerHTML = r.ok ? '<span class="ok">✓ 已开始扫描 类目 ' + PICKED.cat + '（PID ' + r.pid + '）</span>' : '<span class="bad">✗ ' + (r.error || '启动失败') + '</span>';
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = setInterval(pollScan, 5000);
  } catch (e) { $('scanOut').innerHTML = '<span class="bad">' + e + '</span>'; }
}
async function pollScan() {
  if (!PICKED) return;
  const r = await api('/scan-state?cat=' + PICKED.cat);
  if (!r.exists) { $('scanOut').innerHTML = '<span class="k">等待扫描启动…</span>'; return; }
  const a = r.agg || {};
  const pct = a.total ? Math.min(100, Math.round(100 * a.cursor / a.total)) : 0;
  const enumTxt = (r.enum || []).map((e) => e.tag + ' ' + e.done + '/' + e.to + (e.ok ? '✓' : '')).join(' · ');
  $('scanStat').textContent = r.done ? '（✅ 完成）' : '（进行中 ' + pct + '%）';
  $('scanOut').innerHTML =
    '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
    '<div class="k">判定 ' + (a.cursor || 0) + '/' + (a.total || 0) + ' · 成功 ' + (a.ok || 0) + ' · 命中 ' + (a.hits || 0) + '</div>' +
    '<div class="k">枚举：' + (enumTxt || '-') + '</div>' +
    '<pre>' + JSON.stringify(r.shards || [], null, 1) + '</pre>';
  if (r.done) { clearInterval(scanTimer); scanTimer = null; $('scanOut').innerHTML += '<div class="ok">✅ 扫描完成 —— 点「导出 CSV」取交付</div>'; }
}
async function stopScan() {
  await api('/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  $('scanOut').innerHTML = '<span class="warn">已发送停止指令</span>';
}
async function exportCsv() {
  if (!PICKED) { $('scanOut').innerHTML = '<span class="warn">请先选择类目</span>'; return; }
  const r = await api('/report?cat=' + PICKED.cat + '&mode=brief');
  if (!r.csv) { $('scanOut').innerHTML = '<span class="bad">尚无交付文件（扫描未完成？）</span>'; return; }
  const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '强制假一赔十_' + PICKED.cat + '_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── 绑定 ── */
$('catSearch').addEventListener('input', () => TREE && renderTree(TREE, $('catSearch').value));
$('catClear').onclick = () => { PICKED = null; $('catPicked').textContent = '未选'; TREE && renderTree(TREE, $('catSearch').value); };
$('btnSpawn').onclick = spawnInstance;
$('btnRefresh').onclick = loadAccounts;
$('btnVerify').onclick = verify;
$('btnStart').onclick = startScan;
$('btnStop').onclick = stopScan;
$('btnReport').onclick = exportCsv;
document.querySelectorAll('.sec > .t').forEach((t) => {
  t.onclick = () => { const b = $('b-' + t.dataset.sec); if (b) b.classList.toggle('hidden'); };
});

/* 启动：自检 → 类目树 → 账号；之后每 15s 刷新账号（预设轮询，逻辑修复靠后端自愈） */
selfCheck();
loadTree();
loadAccounts();
setInterval(loadAccounts, 15000);
setInterval(selfCheck, 30000);
