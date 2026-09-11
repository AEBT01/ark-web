#!/usr/bin/env node
/**
 * demo-vision-flow.js — 视觉优先闭环演示(可直接当参考实现)
 *
 * 流程: 打开站点 → 紧凑快照(annotate+webp) → 从元素里挑输入框与搜索按钮 →
 *       fillRef 填值 → clickRef + 等待加载 → 再快照验证 → text-map 免截图读结果
 *
 * 用法: node scripts/demo-vision-flow.js [--url https://www.baidu.com] [--query "ark web"]
 */
const BrowserClient = require('../client/browser-client');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const URL = val('--url', 'https://www.baidu.com');
const QUERY = val('--query', 'ark web');

const client = new BrowserClient();
const kb = (n) => (n / 1024).toFixed(1) + 'KB';
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const ok = (b) => (b ? '✓' : '✗');

(async () => {
  const t0 = Date.now();

  step(1, `打开 ${URL}`);
  const open = await client.openUrl(URL);
  const tabId = open?.tab?.id;
  if (!tabId) { console.log('  打开失败:', JSON.stringify(open)); return; }
  client.tabId = tabId;                       // 后续所有请求固定打这个标签页
  const loaded = await client.waitForLoad(20000);
  console.log(`   ${ok(loaded.success)} tabId=${tabId} url=${loaded.url} 等待 ${loaded.waited}ms(判定依据: ${loaded.transition || 'n/a'})`);
  const stable = await client.waitForStable({ timeout: 8000, quiet: 500 });
  console.log(`   稳定判定 ${ok(stable.success)} 变动 ${stable.mutations} 次, 连续静默 ${stable.quietFor}ms`);

  step(2, '紧凑快照 (annotate + webp + compact)');
  const s1 = await client.snapshot({ annotate: true, maxElements: 40, compact: true, format: 'webp', fresh: true });
  if (!s1.success) { console.log('  快照失败:', s1.error); return; }
  console.log(`   元素 ${s1.elements.length} 个 | 元素 JSON ${kb(JSON.stringify(s1.elements).length)} | 图片 ${kb((s1.dataUrl || '').length)} | 采集 ${s1.elapsed}ms`);
  if (s1.autoViewport) console.log(`   自动虚拟视口: ${JSON.stringify(s1.autoViewport)}`);
  console.log(`   列定义: ${(s1.columns || []).join(', ')}`);
  s1.elements.slice(0, 6).forEach(r => console.log('     ', JSON.stringify(r)));

  step(3, '从快照里挑"输入框"和"搜索按钮"(纯视觉决策, 不写选择器)');
  const input = s1.elements.find(([ref, tag, role, , , , , flags]) =>
    (tag === 'INPUT' || tag === 'TEXTAREA') && !/hidden/.test(role) && !/d/.test(flags || ''));
  const btn = s1.elements.find(([ref, tag, , , , , , flags, label]) =>
    /搜索|百度一下|Search/i.test(label || '') && (tag === 'BUTTON' || tag === 'INPUT') && !/d/.test(flags || ''))
    || s1.elements.find(([ref, tag, , , , , , , label]) => tag === 'BUTTON' && label);
  console.log(`   输入框 ref=${input?.[0]} (${input?.[1]})  按钮 ref=${btn?.[0]} "${btn?.[8] || ''}"`);
  if (!input || !btn) { console.log('   未找到目标元素, 演示提前结束'); return; }

  step(4, `fillRef ${input[0]} ← "${QUERY}"  (React 兼容原生 setter)`);
  const filled = await client.fillRef(input[0], QUERY);
  console.log(`   ${ok(!filled.error)} ${JSON.stringify(filled).slice(0, 160)}`);

  step(5, `clickRef ${btn[0]} + 同一次调用里等待加载`);
  const clicked = await client.act('clickRef', { ref: btn[0], waitFor: 'load', waitTimeout: 15000 });
  console.log(`   点击 ${ok(clicked.success)} method=${clicked.method}  等待 ${ok(clicked.waited?.success)} url=${clicked.waited?.url || '-'} ${clicked.waited?.waited || 0}ms`);

  step(6, '再快照验证结果页(前后对比)');
  const s2 = await client.snapshot({ maxElements: 25, compact: true, format: 'webp' });
  console.log(`   url=${s2.url}\n   title=${s2.title}\n   元素 ${s2.elements.length} | 采集 ${s2.elapsed}ms`);

  step(7, 'text-map: 不截图直接"读"页面(视口内前 8 块)');
  const tm = await client.textMap({ max: 80 });
  (tm.blocks || []).filter(b => b.inView).slice(0, 8).forEach(b =>
    console.log(`     [${b.x},${b.y} ${b.fs}px] ${b.t.slice(0, 64)}`));
  console.log(`   文本块共 ${tm.count} 个`);

  step(8, 'zoom: 放大一块小字(scale=3, webp)');
  const z = await client.zoom({ ref: s2.elements[1]?.[0], scale: 3, format: 'webp' });
  console.log(`   ${ok(z.success)} scale=${z.scale} clip=${JSON.stringify(z.clip)} 图片 ${kb((z.dataUrl || '').length)}${z.degraded ? ' (' + z.degraded + ')' : ''}`);

  console.log(`\n总耗时 ${Date.now() - t0}ms`);
  console.log('提示: 演示打开了新标签页; 收尾可 POST /reset-all?tabId=' + tabId + ' 清理, 或 /session/delete 关闭');
})().catch(e => { console.error('演示失败:', e.message); process.exit(1); });
