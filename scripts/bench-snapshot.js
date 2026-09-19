#!/usr/bin/env node
/**
 * bench-snapshot.js — 快照效率基准（给视觉模型的成本算账）
 *
 * 对比: 对象格式 vs 紧凑格式(compact) × png vs webp, 以及 400ms 缓存命中
 * 指标: 元素 JSON 体积(直接决定 token)、图片 base64 体积、单次耗时
 *
 * 用法: node scripts/bench-snapshot.js [--max 60] [--tabId <id>]
 */
const BrowserClient = require('../client/browser-client');

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };
const MAX = +(val('--max') || 60);
const TAB = val('--tabId');

const client = new BrowserClient({ tabId: TAB });

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const est = (n) => '~' + Math.round(n / 3.6) + ' tok';   // 粗估: 1 token ≈ 3.6 字符(中英混排)

(async () => {
  const base = { annotate: true, maxElements: MAX, fresh: true };
  const cases = [
    { label: '对象格式 png', opts: { ...base, format: 'png' } },
    { label: '对象格式 webp', opts: { ...base, format: 'webp' } },
    { label: '紧凑格式 png', opts: { ...base, format: 'png', compact: true } },
    { label: '紧凑格式 webp', opts: { ...base, format: 'webp', compact: true } }
  ];
  const rows = [];
  for (const c of cases) {
    const t0 = Date.now();
    const r = await client.snapshot(c.opts);
    const ms = Date.now() - t0;
    if (r.error || r.success === false) { rows.push({ label: c.label, error: r.error || 'failed' }); continue; }
    const els = JSON.stringify(r.elements || []).length;
    const img = (r.dataUrl || '').length;
    rows.push({ label: c.label, n: (r.elements || []).length, els, img, ms, fmt: r.format, requested: r.requestedFormat || null, note: r.formatNote || null, compact: r.elementsFormat === 'compact' });
  }

  // 缓存命中(snapshot 400ms 缓存)
  const warm = { annotate: true, maxElements: MAX, format: 'webp', compact: true };
  await client.snapshot(warm);
  const t1 = Date.now();
  const cached = await client.snapshot(warm);
  const cacheMs = Date.now() - t1;

  console.log('\n=== 快照效率基准 ===');
  console.log(`目标标签页: ${TAB || '(活动标签页)'}   元素上限: ${MAX}\n`);
  if (rows[0]?.error) {
    console.log('采集失败:', rows[0].error);
    return;
  }
  console.log('方式'.padEnd(16) + '元素'.padStart(5) + '  元素JSON'.padStart(11) + '  估算token'.padStart(11) + '  图片base64'.padStart(12) + '  耗时'.padStart(9));
  console.log('-'.repeat(72));
  for (const r of rows) {
    if (r.error) {
      // 不再把失败行打印成 NaN：失败原因直接列出来，便于区分"环境抖动"与"功能坏了"
      console.log(r.label.padEnd(16) + '  采集失败: ' + String(r.error).slice(0, 90));
      continue;
    }
    console.log(
      r.label.padEnd(16) +
      String(r.n).padStart(5) + '  ' +
      kb(r.els).padStart(11) + '  ' +
      est(r.els).padStart(11) + '  ' +
      kb(r.img).padStart(12) + '  ' +
      (r.ms + 'ms').padStart(9) +
      (r.note ? '  [' + r.note + ']' : '')
    );
  }
  const obj = rows.find(r => r.label === '对象格式 png' && !r.error);
  const cmp = rows.find(r => r.label === '紧凑格式 webp' && !r.error);
  if (obj && cmp) {
    const elsSave = (1 - cmp.els / obj.els) * 100;
    const imgSave = (1 - cmp.img / obj.img) * 100;
    const totSave = (1 - (cmp.els + cmp.img) / (obj.els + obj.img)) * 100;
    console.log('\n结论(紧凑webp vs 对象png):');
    console.log(`  元素 JSON   -${elsSave.toFixed(1)}%`);
    console.log(`  图片数据    -${imgSave.toFixed(1)}%`);
    console.log(`  单次快照总载荷 -${totSave.toFixed(1)}%`);
  }
  console.log(`\n缓存命中: ${cacheMs}ms`);
  console.log('');
})();
