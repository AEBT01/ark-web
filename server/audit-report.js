/**
 * audit-report.js — 报告渲染 + 趋势存储 + 批量审计队列
 * 无外部依赖, 纯 Node
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

const STATUS_LABEL = { good: '优秀', 'needs-improvement': '需改进', poor: '较差', 'no-data': '无数据' };
const STATUS_COLOR = { good: '#22c55e', 'needs-improvement': '#f59e0b', poor: '#ef4444', 'no-data': '#94a3b8' };
const STATUS_BAR = { good: '██████████', 'needs-improvement': '█████░░░░░', poor: '██░░░░░░░░', 'no-data': '░░░░░░░░░░' };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ratingOf(score) {
  if (score >= 90) return 'good';
  if (score >= 50) return 'needs-improvement';
  return 'poor';
}

/** Markdown 报告 */
function renderMd(audit) {
  const { scores, insights, opportunities, metrics } = audit;
  const lines = [];
  lines.push(`# 审计报告: ${audit.meta.title || audit.meta.url}`);
  lines.push('');
  lines.push(`- URL: ${audit.meta.url}`);
  lines.push(`- 时间: ${new Date(audit.meta.collectedAt).toLocaleString()}`);
  lines.push(`- 采集耗时: ${audit.meta.collectMs}ms`);
  if (audit.meta.framework && Object.keys(audit.meta.framework).filter(k => audit.meta.framework[k]).length) {
    const fws = Object.keys(audit.meta.framework).filter(k => audit.meta.framework[k]).join(', ');
    lines.push(`- 框架: ${fws}`);
  }
  lines.push('');
  lines.push(`## 总分: ${scores.total}/100 (${STATUS_LABEL[scores.rating]})`);
  lines.push('');
  lines.push('| 类别 | 得分 | 评级 |');
  lines.push('|------|------|------|');
  for (const c of scores.categories) {
    lines.push(`| ${c.name} | ${c.score}/100 | ${STATUS_LABEL[c.rating]} |`);
  }
  lines.push('');
  lines.push('## 核心指标');
  lines.push('');
  lines.push(`| 指标 | 值 | 评级 |`);
  lines.push(`|------|-----|------|`);
  const m = metrics;
  lines.push(`| LCP | ${m.lcp ?? 'no-data'} ms | ${STATUS_LABEL[m._lcp] ?? ''} |`);
  lines.push(`| FCP | ${m.fcp ?? 'no-data'} ms | |`);
  lines.push(`| TTFB | ${m.ttfb ?? 'no-data'} ms | |`);
  lines.push(`| CLS | ${m.cls ?? 'no-data'} | |`);
  lines.push(`| INP | ${m.inp ?? 'no-data'} ms | |`);
  lines.push(`| 总资源 | ${m.totalKB} KB / ${m.requests} 请求 | |`);
  lines.push(`| 长任务 | ${m.longTasks} 个 | |`);
  lines.push('');
  lines.push('## 洞察');
  lines.push('');
  for (const i of insights) {
    const icon = i.type === 'warning' ? '⚠️' : i.type === 'good' ? '✅' : '💡';
    lines.push(`- ${icon} **${i.title}**: ${i.message}`);
  }
  lines.push('');
  if (opportunities && opportunities.length) {
    lines.push('## 优化机会 (按 ROI 排序)');
    lines.push('');
    lines.push('| 机会 | 预估节省 | 影响 | 难度 |');
    lines.push('|------|---------|------|------|');
    for (const o of opportunities) {
      lines.push(`| ${o.title} | ${o.estimateKB} | ${o.impact} | ${o.effort} |`);
    }
    lines.push('');
  }
  lines.push('## 明细');
  lines.push('');
  for (const c of scores.categories) {
    lines.push(`### ${c.name} (${c.score}/100)`);
    lines.push('');
    lines.push('| 规则 | 得分 | 值 | 说明 |');
    lines.push('|------|------|-----|------|');
    for (const r of c.rules) {
      lines.push(`| ${r.name} | ${r.score}/100 (${STATUS_LABEL[r.status]}) | ${r.value} | ${r.detail || ''} |`);
    }
    lines.push('');
  }
  if (audit.budget && !audit.budget.passed) {
    lines.push('## 性能预算违规');
    lines.push('');
    for (const v of audit.budget.violations) {
      lines.push(`- ${v.metric}: ${v.value} > 预算 ${v.budget}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** HTML 单文件报告(内联样式, 无外部依赖) */
function renderHtml(audit) {
  const { scores, insights, opportunities } = audit;
  const m = audit.metrics;
  const totalPct = Math.round(scores.total);

  const ring = (score) => {
    const pct = Math.max(0, Math.min(100, score));
    const col = STATUS_COLOR[ratingOf(score)];
    return `<div class="ring" style="background:conic-gradient(${col} ${pct}%, #1e293b 0)"><div class="ring-inner"><div class="ring-val">${score}</div><div class="ring-max">/100</div></div></div>`;
  };

  const metricCard = (label, value, rating) => `
    <div class="metric">
      <div class="m-label">${label}</div>
      <div class="m-value">${value ?? 'no-data'}</div>
      ${rating ? `<span class="tag ${rating}">${STATUS_LABEL[rating]}</span>` : ''}
    </div>`;

  const insightHtml = insights.map(i => `
    <div class="insight ${i.type}">
      <strong>${i.type === 'warning' ? '⚠️' : i.type === 'good' ? '✅' : '💡'} ${esc(i.title)}</strong>
      <div>${esc(i.message)}</div>
    </div>`).join('');

  const oppHtml = (opportunities || []).map((o, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${esc(o.title)}</td>
      <td class="num">${o.estimateKB}</td>
      <td><span class="tag impact-${o.impact}">${o.impact}</span></td>
      <td><span class="tag effort-${o.effort}">${o.effort}</span></td>
    </tr>`).join('');

  const catHtml = scores.categories.map(c => `
    <section><h2>${esc(c.name)} (${c.score}/100)</h2>
      ${c.rules.map(r => `
        <div class="rule">
          <div class="rule-head">
            <span class="rule-name">${esc(r.name)}</span>
            <span class="rule-score">${r.score}<small>分</small></span>
            <span class="tag ${r.status}">${STATUS_LABEL[r.status]}</span>
          </div>
          <div class="rule-bar"><div class="bar-fill ${r.status}" style="width:${r.score}%"></div></div>
          <div class="rule-value">${esc(r.value)}${r.detail ? ' — ' + esc(r.detail) : ''}</div>
        </div>`).join('')}
    </section>`).join('');

  const fw = audit.meta.framework || {};
  const fwNames = Object.keys(fw).filter(k => fw[k]);

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>审计报告 - ${esc(audit.meta.title || audit.meta.url)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;max-width:1000px;margin:0 auto}
h1{font-size:22px;margin-bottom:4px;color:#f8fafc}
.sub{color:#94a3b8;font-size:13px;margin-bottom:20px}
.head{display:flex;gap:24px;align-items:center;background:#1e293b;border-radius:12px;padding:20px;margin-bottom:20px;flex-wrap:wrap}
.ring{width:120px;height:120px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ring-inner{width:88px;height:88px;border-radius:50%;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring-val{font-size:32px;font-weight:700;color:#f8fafc}
.ring-max{font-size:12px;color:#64748b}
.head-info{flex:1;min-width:220px}
.head-info .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.metric{background:#1e293b;border-radius:10px;padding:12px}
.m-label{font-size:11px;color:#94a3b8;margin-bottom:4px}
.m-value{font-size:20px;font-weight:600}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.tag.good{background:#14532d;color:#4ade80}
.tag.needs-improvement{background:#451a03;color:#fbbf24}
.tag.poor{background:#450a0a;color:#f87171}
.tag.no-data{background:#1e293b;color:#94a3b8}
.tag.impact-high{background:#7f1d1d;color:#fca5a5}
.tag.impact-medium{background:#78350f;color:#fcd34d}
.tag.impact-low{background:#134e4a;color:#5eead4}
.tag.effort-low{background:#14532d;color:#4ade80}
.tag.effort-medium{background:#78350f;color:#fcd34d}
.tag.effort-high{background:#7f1d1d;color:#fca5a5}
section{background:#1e293b;border-radius:12px;padding:18px;margin-bottom:20px}
section h2{font-size:16px;margin-bottom:12px;color:#f1f5f9}
.insight{background:#0f172a;border-left:3px solid #64748b;border-radius:6px;padding:10px 12px;margin-bottom:8px;font-size:13px;line-height:1.6}
.insight.warning{border-color:#f59e0b}
.insight.good{border-color:#22c55e}
.insight div{margin-top:2px;color:#cbd5e1}
.cat{margin-bottom:16px}
.cat-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.cat-name{font-weight:600;font-size:15px}
.cat-score{font-size:22px;font-weight:700;color:#f8fafc}
.cat-score small{font-size:11px;color:#64748b;font-weight:400}
.rule{background:#0f172a;border-radius:8px;padding:10px 12px;margin-bottom:6px}
.rule-head{display:flex;align-items:center;gap:10px;font-size:13px}
.rule-name{flex:1}
.rule-score{font-weight:600;color:#cbd5e1}
.rule-score small{font-size:10px;color:#64748b}
.rule-bar{height:4px;background:#334155;border-radius:2px;margin:6px 0}
.bar-fill{height:100%;border-radius:2px}
.bar-fill.good{background:#22c55e}
.bar-fill.needs-improvement{background:#f59e0b}
.bar-fill.poor{background:#ef4444}
.bar-fill.no-data{background:#475569}
.rule-value{font-size:12px;color:#94a3b8}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #334155}
th{color:#94a3b8;font-weight:500;font-size:12px}
td.num{font-variant-numeric:tabular-nums}
.budget-ok{color:#4ade80;font-weight:600}
.budget-bad{color:#f87171;font-weight:600}
.footer{text-align:center;color:#475569;font-size:12px;margin-top:8px}
</style></head><body>
<h1>${esc(audit.meta.title || '页面审计报告')}</h1>
<div class="sub">${esc(audit.meta.url)} · ${new Date(audit.meta.collectedAt).toLocaleString()} · 采集 ${audit.meta.collectMs}ms${fwNames.length ? ' · ' + esc(fwNames.join(', ')) : ''} · Ark Web Audit v1</div>
<div class="head">
  ${ring(totalPct)}
  <div class="head-info">
    <div style="font-size:28px;font-weight:700">${scores.total}<small style="color:#64748b;font-size:14px;font-weight:400"> / 100</small></div>
    <div class="tag ${scores.rating}" style="font-size:13px;padding:4px 12px">${STATUS_LABEL[scores.rating]}</div>
    <div class="row">${scores.categories.map(c => `<span class="tag ${c.rating}">${esc(c.name)} ${c.score}</span>`).join('')}</div>
  </div>
</div>
<div class="metrics">
  ${metricCard('LCP', m.lcp != null ? m.lcp + ' ms' : null, m._lcp)}
  ${metricCard('FCP', m.fcp != null ? m.fcp + ' ms' : null)}
  ${metricCard('TTFB', m.ttfb != null ? m.ttfb + ' ms' : null)}
  ${metricCard('CLS', m.cls != null ? m.cls : null)}
  ${metricCard('INP', m.inp != null ? m.inp + ' ms' : null)}
  ${metricCard('资源', m.totalKB + ' KB')}
  ${metricCard('请求', m.requests)}
  ${metricCard('长任务', m.longTasks)}
  ${metricCard('DOM', m.domElements)}
</div>
<section><h2>洞察</h2>${insightHtml || '<div style="color:#94a3b8">无</div>'}</section>
${opportunities && opportunities.length ? `<section><h2>优化机会 (按 ROI)</h2>
<table><tr><th>#</th><th>机会</th><th>预估节省</th><th>影响</th><th>难度</th></tr>${oppHtml}</table></section>` : ''}
${catHtml}
${audit.budget && audit.budget.violations.length ? `<section><h2>性能预算违规</h2>
${audit.budget.violations.map(v => `<div class="budget-bad">✗ ${esc(v.metric)}: ${v.value} &gt; 预算 ${v.budget}</div>`).join('')}</section>` : ''}
<div class="footer">由 Ark Web 生成 · audit.js v1</div>
</body></html>`;
}

// ============ 趋势存储 ============

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 追加一条历史记录 */
function saveHistory(audit) {
  try {
    ensureDataDir();
    const rec = {
      timestamp: audit.meta.collectedAt,
      url: audit.meta.url,
      title: audit.meta.title,
      scores: audit.scores,
      metrics: audit.metrics
    };
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(rec) + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

/** 读取历史记录(按 URL 过滤, 支持 limit) */
function readHistory(url, limit = 10) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    let recs = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    if (url) recs = recs.filter(r => r.url === url);
    recs.sort((a, b) => a.timestamp - b.timestamp);
    const out = recs.slice(-Math.max(1, limit));
    // 趋势对比: 最近两次
    let trend = null;
    if (out.length >= 2) {
      const last = out[out.length - 1];
      const prev = out[out.length - 2];
      const diff = {};
      for (const k of ['totalKB', 'requests', 'ttfb', 'lcp', 'cls', 'longTasks']) {
        if (last.metrics[k] != null && prev.metrics[k] != null) {
          diff[k] = Math.round((last.metrics[k] - prev.metrics[k]) * 100) / 100;
        }
      }
      trend = {
        scoreNow: last.scores.total,
        scoreBefore: prev.scores.total,
        scoreDiff: Math.round((last.scores.total - prev.scores.total) * 100) / 100,
        metricsDiff: diff
      };
    }
    return { records: out, trend };
  } catch {
    return { records: [], trend: null };
  }
}

// ============ 批量审计队列 ============

function createQueue(dispatchCollect) {
  const tasks = new Map();
  let taskSeq = 0;

  /** urls: [], budget: {}, settleMs: 加载后稳定等待(默认 2500ms 让 vitals 缓冲)
   *  ctx: 请求级 ALS 上下文(tabId/sessionId), 在队列内重放 —— 否则导航会逃逸到用户当前活动标签页 */
  async function runTask({ urls, budget = null, settleMs = 2500, ctx = null, onAudit }) {
    const id = 'task-' + (++taskSeq);
    const task = { id, urls, status: 'running', progress: { done: 0, total: urls.length }, results: [], error: null, startedAt: Date.now() };
    tasks.set(id, task);
    (async () => {
      try {
        for (const url of urls) {
          try {
            await dispatchCollect({ type: 'open-url', data: { url, current: true } }, ctx);
            await dispatchCollect({ type: 'wait-for-load', data: { timeout: 20000 } }, ctx);
            await new Promise(r => setTimeout(r, settleMs));
            const raw = await dispatchCollect({ type: 'audit-collect', data: {} }, ctx);
            if (!raw.success) throw new Error(raw.error || 'audit-collect failed');
            const audited = onAudit ? onAudit(url, raw.audit) : null;
            task.results.push({ url, ...(audited || {}) });
          } catch (e) {
            task.results.push({ url, error: e.message });
          }
          task.progress.done++;
        }
        task.status = 'done';
        task.finishedAt = Date.now();
      } catch (e) {
        task.status = 'error';
        task.error = e.message;
      }
    })();
    return id;
  }

  return {
    tasks,
    runTask,
    getStatus(id) {
      const t = tasks.get(id);
      if (!t) return { error: 'Task not found' };
      return {
        id: t.id, status: t.status, progress: t.progress,
        results: t.status === 'done' ? t.results : t.results,
        error: t.error, startedAt: t.startedAt, finishedAt: t.finishedAt
      };
    }
  };
}

module.exports = { renderMd, renderHtml, saveHistory, readHistory, createQueue, STATUS_LABEL };
