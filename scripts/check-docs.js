#!/usr/bin/env node
/**
 * check-docs.js — 文档口径一致性检查（防止数字与口径漂移回潮）
 *
 * 背景：README.md / README.en.md / SKILL.md 长期存在"数字与口径漂移"。
 * 本脚本把关键口径固定成可执行检查，本地与巡检直接跑：
 *   1. 版本一致性     VERSION ↔ package.json version
 *   2. 文档版本号     README(中/英) 与 SKILL 中所有 vX.Y.Z 声明 == 当前版本
 *   3. 技能安装口径   必须含「入口卡 / entry card」，不得回潮"复制进技能目录"旧说法
 *   4. 端点数字       README(中/英) 的端点总数声明互相一致，并与真实路由数一致
 *   5. 命令示例       README 中 node scripts/xxx.js 引用的脚本必须存在
 *   6. 文件引用       README 的 markdown 链接与反引号路径不得是死链
 *
 * 防假绿（同 check-endpoints.js 的历史教训）：每项检查带"零命中防御"，
 * 如果提取逻辑抓不到任何东西，直接判失败，而不是 0 对 0 通过。
 *
 * 约定：
 *   · 历史引用（如 "v2.9.2 已内建自愈"、"v2.9.3 起超…"）不算当前版本声明；
 *   · 生成物路径（dist/ 下、`→` 指向的产物）不算死链；
 *   · 仅使用 node 内置模块，零依赖，跨平台路径用 path.join。
 *
 * 用法: node scripts/check-docs.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERSION_DOCS = ['README.md', 'README.en.md', 'SKILL.md'];
const ENDPOINT_DOCS = ['README.md', 'README.en.md'];
const INSTALL_DOCS = ['README.md', 'README.en.md'];

/* ---------- 通用工具 ---------- */

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function toRel(p) {
  return String(p).replace(/\\/g, '/');
}

function findPackageJson() {
  for (const c of ['package.json', path.join('server', 'package.json')]) {
    if (exists(c)) return toRel(c);
  }
  return null;
}

/* ---------- 检查 1：版本一致性 ---------- */

function checkVersionConsistency() {
  const pkgRel = findPackageJson();
  if (!pkgRel) return { problems: ['未找到 package.json（根目录或 server/ 下都没有）'] };

  let pkg;
  try {
    pkg = JSON.parse(readText(pkgRel));
  } catch (e) {
    return { problems: [pkgRel + ' 不是合法 JSON：' + e.message] };
  }
  if (!exists('VERSION')) return { problems: ['缺少 VERSION 文件'] };

  const v = readText('VERSION').trim();
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(v)) problems.push('VERSION 内容不是 x.y.z 形式：' + JSON.stringify(v));
  if (pkg.version !== v) problems.push('VERSION ' + v + ' ≠ ' + pkgRel + ' version ' + String(pkg.version));
  return { problems, note: 'VERSION = ' + pkgRel + ' = ' + v };
}

/* ---------- 检查 2：文档中的版本号 ---------- */

const HISTORY_NEAR = /历史|旧版|旧路径|已废弃|legacy|deprecated/i;
const HISTORY_AFTER = /^[ \t]{0,3}(?:已|起|since\b|onwards|introduced\b|added\b|renamed\b|replaced\b)/i;

function checkDocVersions(version) {
  const problems = [];
  const notes = [];

  for (const rel of VERSION_DOCS) {
    const lines = readText(rel).split(/\r?\n/);
    let declared = 0;
    let skipped = 0;

    lines.forEach((line, idx) => {
      const re = /v(\d+\.\d+\.\d+)/g;
      let m;
      while ((m = re.exec(line))) {
        const num = m[1];
        // 历史引用不算"当前版本声明"：版本号正后方（"已/起"）或邻域内出现历史标记
        const after = line.slice(m.index + m[0].length, m.index + m[0].length + 14);
        const near = line.slice(Math.max(0, m.index - 32), m.index + m[0].length + 14);
        if (HISTORY_NEAR.test(near) || HISTORY_AFTER.test(after)) { skipped++; continue; }

        declared++;
        if (num !== version) {
          problems.push(rel + ':' + (idx + 1) + ' 出现 v' + num + '（当前 v' + version + '）：' + line.trim().slice(0, 80));
        }
      }
    });

    if (!declared) problems.push(rel + ' 未发现任何 vX.Y.Z 版本声明 —— 提取逻辑可能失效');
    notes.push(rel + ' ' + declared + ' 处' + (skipped ? '（另 ' + skipped + ' 处历史引用已排除）' : ''));
  }
  return { problems, note: notes.join('；') };
}

/* ---------- 检查 3：技能安装口径 ---------- */

function checkInstallContract() {
  const problems = [];
  const notes = [];

  for (const rel of INSTALL_DOCS) {
    const text = readText(rel);
    const zh = /入口卡/.test(text);
    const en = /entry\s*card/i.test(text);
    if (!zh && !en) problems.push(rel + ' 未包含「入口卡 / entry card」安装口径');
    else notes.push(rel + '=' + (zh ? '入口卡' : 'entry card'));
  }

  // 旧说法防回归：邻近三行窗口内同时出现 path + 复制/拷贝，且无否定语
  for (const rel of INSTALL_DOCS) {
    const lines = readText(rel).split(/\r?\n/);
    const flagged = new Set();
    for (let i = 0; i < lines.length; i++) {
      const win = [lines[i - 1] || '', lines[i], lines[i + 1] || ''].join(' ');
      if (!/skills[\\/]+ark-web/i.test(win)) continue;
      if (!/复制|拷贝|\bcopy(?:ing|ied)?\b/i.test(win)) continue;
      if (/无需|不用|不需要|不再|不得|禁止|不要|未|替代|no\s+need|do\s+not|don'?t|instead|without/i.test(win)) continue;
      if (!flagged.has(i + 1)) {
        flagged.add(i + 1);
        problems.push(rel + ':' + (i + 1) + ' 出现旧安装口径（复制/拷贝到 skills/ark-web 一类）');
      }
    }
  }
  return { problems, note: notes.join('，') };
}

/* ---------- 检查 4：端点数字 ---------- */

const ENDPOINT_PATTERNS = [
  /(\d{2,4})\s+(?:HTTP\s+)?endpoints?\b/gi,   // "154 endpoints" / "154 HTTP endpoints"
  /HTTP\s+API\s*\((\d{2,4})\)/gi,             // "HTTP API (154)"
  /HTTP\s+(\d{2,4})\s*\+\s*WS/gi,             // "HTTP 154 + WS bridge"
  /端点总览[^0-9\n]{0,12}(\d{2,4})/g,          // "端点总览 (154, …)"
];

function collectEndpointClaims(rel) {
  const claims = [];
  const lines = readText(rel).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of ENDPOINT_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) claims.push({ line: i + 1, value: Number(m[1]) });
    }
  });
  return claims;
}

function realRouteCount() {
  const script = path.join(ROOT, 'scripts', 'check-endpoints.js');
  if (!fs.existsSync(script)) return { error: '缺少 scripts/check-endpoints.js' };

  const parse = (out) => {
    const m = /路由[^:：]*[:：]\s*(\d+)\s*个/.exec(String(out || ''));
    return m ? Number(m[1]) : null;
  };

  try {
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 });
    const n = parse(out);
    return n === null ? { error: '无法从 check-endpoints.js 输出解析路由数量' } : { count: n };
  } catch (e) {
    const n = parse((e && e.stdout) || '');
    if (n !== null) return { count: n, degraded: 'check-endpoints.js 自身退出码非 0（其检测到路由/文档漂移）' };
    return { error: 'check-endpoints.js 运行失败：' + ((e && e.message) || e) };
  }
}

function checkEndpointNumbers() {
  const problems = [];
  const claimsByFile = {};
  for (const rel of ENDPOINT_DOCS) {
    claimsByFile[rel] = collectEndpointClaims(rel);
    if (!claimsByFile[rel].length) problems.push(rel + ' 未提取到任何端点总数声明 —— 提取逻辑可能失效');
  }

  const values = new Set();
  for (const rel of ENDPOINT_DOCS) for (const c of claimsByFile[rel]) values.add(c.value);
  if (values.size > 1) {
    for (const rel of ENDPOINT_DOCS) {
      for (const c of claimsByFile[rel]) problems.push(rel + ':' + c.line + ' 声明 ' + c.value + '（文档间总数不一致）');
    }
  }

  const real = realRouteCount();
  if (real.count === undefined) {
    return {
      problems,
      note: '未获取到真实路由数，仅做文档间一致性检查（' + real.error + '）',
    };
  }
  for (const rel of ENDPOINT_DOCS) {
    for (const c of claimsByFile[rel]) {
      if (c.value !== real.count) {
        problems.push(rel + ':' + c.line + ' 声明 ' + c.value + ' ≠ 真实路由数 ' + real.count);
      }
    }
  }
  if (real.degraded) problems.push('注意：' + real.degraded);
  return {
    problems,
    note: '真实路由数 ' + real.count + '；' + ENDPOINT_DOCS.map((r) => r + ' ' + claimsByFile[r].length + ' 处声明').join('，'),
  };
}

/* ---------- 检查 5：命令示例中的脚本存在性 ---------- */

function checkScriptCommands() {
  const problems = [];
  const lines = readText('README.md').split(/\r?\n/);
  let hits = 0;

  lines.forEach((line, i) => {
    const re = /\bnode\s+(scripts[\\/][A-Za-z0-9._-]+\.js)\b/g;
    let m;
    while ((m = re.exec(line))) {
      hits++;
      const rel = toRel(m[1]);
      if (!exists(rel)) problems.push('README.md:' + (i + 1) + ' 引用了不存在的脚本 ' + rel);
    }
  });

  if (!hits) problems.push('README.md 未发现 node scripts/... 命令 —— 提取逻辑可能失效');
  return { problems, note: hits + ' 处命令，' + (problems.length ? '有缺失' : '全部存在') };
}

/* ---------- 检查 6：README 文件引用有效性 ---------- */

const KNOWN_EXT = /\.(?:md|markdown|json|js|mjs|cjs|html|htm|css|txt|ya?ml|sh|bat|cmd|ps1|py|ts)$/i;
const SEARCH_DIRS = ['', 'scripts', 'client', 'server', 'server/core', 'server/capabilities', 'references', 'docs', 'extension', 'semantic', 'skills'];
const DIR_WAIVER = /未提交|未补齐|已知缺口|不存在|已删除|不再使用/;

function resolveRepoPath(rel) {
  if (exists(rel)) return true;
  if (rel.includes('/')) return false; // 带目录前缀的不做模糊搜索
  for (const dir of SEARCH_DIRS) {
    if (exists(dir ? dir + '/' + rel : rel)) return true;
  }
  return false;
}

function checkFileRefs() {
  const problems = [];
  const rel = 'README.md';
  const lines = readText(rel).split(/\r?\n/);
  let checked = 0;

  const dead = (raw, lineNo) => problems.push(rel + ':' + lineNo + ' 引用不存在：' + raw);

  const verifyPath = (raw, lineNo, opts) => {
    opts = opts || {};
    let p = String(raw).trim();
    if (!p) return;
    if (/^(?:https?:|mailto:|chrome-extension:|chrome:|data:|ws:|wss:)/i.test(p)) return;
    if (/[<>*?|$%{}"'=;,&()\[\]]/.test(p)) return;
    p = toRel(p);
    if (p.startsWith('/') || p.startsWith('~')) return;
    if (/^[A-Za-z]:\//.test(p)) return; // 盘符绝对路径
    p = p.replace(/^\.\//, '').replace(/[)），。；;]+$/, '');
    if (!p) return;
    if (p.startsWith('dist/')) return; // 发布生成物

    const isDir = /[\\/]$/.test(raw);
    if (isDir && opts.dirWaived) return;
    if (!isDir && !opts.anyFile && !KNOWN_EXT.test(p)) return;

    checked++;
    if (isDir) {
      if (!exists(p.replace(/\/+$/, ''))) dead('`' + raw + '`（目录）', lineNo);
      return;
    }
    if (!resolveRepoPath(p)) dead('`' + raw + '`', lineNo);
  };

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    let m;

    // markdown 链接
    const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    while ((m = linkRe.exec(line))) {
      const t = m[1];
      if (t.startsWith('#') || /^[a-z]+:/i.test(t)) continue;
      let p = t.split('#')[0];
      try { p = decodeURIComponent(p); } catch (e) { /* 保留原样 */ }
      verifyPath(p, lineNo, { anyFile: true });
    }

    // 行内反引号：纯路径 token + node 命令里的路径
    const tickRe = /`([^`\n]+)`/g;
    while ((m = tickRe.exec(line))) {
      const raw = m[1].trim();
      if (/旧路径|已废弃|deprecated/i.test(line)) continue;
      const before = line.slice(Math.max(0, m.index - 6), m.index);
      if (/→\s*$/.test(before)) continue; // `→` 指向的是生成物
      const dirWaived = DIR_WAIVER.test(line);
      if (!/\s/.test(raw)) verifyPath(raw, lineNo, { dirWaived });
      const cmdRe = /\bnode\s+([^\s'"]+)/g;
      let c;
      while ((c = cmdRe.exec(raw))) verifyPath(c[1], lineNo, { dirWaived });
    }
  });

  if (!checked) problems.push(rel + ' 未检查到任何文件引用 —— 提取逻辑可能失效');
  return { problems, note: '已核 ' + checked + ' 条路径' };
}

/* ---------- 主流程 ---------- */

function main() {
  let currentVersion = null;
  let versionError = null;
  try {
    currentVersion = readText('VERSION').trim();
    if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) throw new Error('VERSION 内容不是 x.y.z：' + JSON.stringify(currentVersion));
  } catch (e) {
    versionError = (e && e.message) || String(e);
  }

  const checks = [
    ['版本一致性（VERSION ↔ package.json）', () => checkVersionConsistency()],
    ['文档版本号声明', () => (versionError
      ? { problems: ['当前版本不可用，无法核对：' + versionError] }
      : checkDocVersions(currentVersion))],
    ['技能安装口径（入口卡）', () => checkInstallContract()],
    ['端点数字一致性', () => checkEndpointNumbers()],
    ['命令示例脚本存在性', () => checkScriptCommands()],
    ['README 文件引用有效性', () => checkFileRefs()],
  ];

  let pass = 0;
  let fail = 0;
  for (const [name, fn] of checks) {
    let result;
    try {
      const r = fn() || {};
      result = { problems: Array.isArray(r) ? r : (r.problems || []), note: r.note || '' };
    } catch (e) {
      result = { problems: ['检查执行异常：' + ((e && e.stack) || e)], note: '' };
    }
    if (result.problems.length === 0) {
      pass++;
      console.log('✓ ' + name + (result.note ? '（' + result.note + '）' : ''));
    } else {
      fail++;
      console.log('✗ ' + name + ' — ' + result.problems[0]);
      for (const p of result.problems.slice(1)) console.log('    · ' + p);
    }
  }

  console.log('');
  console.log('通过 ' + pass + ' · 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main();
