#!/usr/bin/env node
/**
 * package.js — Ark Web 发布打包
 * 生成 dist/ark-web-v<版本>.zip, 含扩展、面板、服务端、技能、验证套件与文档。
 *
 * 用法: node scripts/package.js [--list]
 * 输出: dist/ark-web-vX.Y.Z/ + dist/ark-web-vX.Y.Z.zip + SHA256 + 内容自检
 *
 * 设计要点:
 *   1. 按目录遍历而非硬编码文件清单 —— 历史事故: 硬编码清单导致重构后的
 *      server/agent、capabilities、skills 一行都没进分发包，且无人察觉。
 *   2. 打包前强制版本一致 —— 版本号与实际内容对不上是发布事故的常见形态。
 *   3. 打包后回读 ZIP 中央目录自检关键路径存在 —— 只"写出成功"不等于"内容正确"。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const zipfile = require('./lib/zipfile');
const ver = require('./lib/version');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** 整包纳入的目录（相对 ROOT） */
const INCLUDE_DIRS = ['extension', 'panel', 'server', 'client', 'skills', 'scripts', 'references', 'docs', 'config', 'verify'];

/** 顶层单文件 */
const INCLUDE_FILES = ['ark.js', 'start.bat', 'start.sh', 'README.md', 'README.en.md', 'CHANGELOG.md', 'SKILL.md', 'LICENSE', 'VERSION'];

/**
 * 排除规则（相对 ROOT 的正斜杠路径）。
 * 只排除"体积大 / 本机专属 / 生成物"，不排除任何源码。
 */
const EXCLUDE_RES = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.sync-backup/,
  /(^|\/)\.zcode(\/|$)/,
  /(^|\/)\.github(\/|$)/,
  /^dist\//,
  /^data\//,
  /^reports\//,
  /^chrome-profile\//,
  /^verify\/evidence\//,
  /^scripts\/l10n-backup\//,
  /^scripts\/agent-traces\//,
  /^scripts\/diagnostics\//,
  /^scripts\/_legacy-/,
  /\.log$/,
  /\.pdf$/,
  /\.zip$/,
  /\.png$/,
  /\.webp$/,
  /\.map$/
];

const isExcluded = (rel) => EXCLUDE_RES.some((re) => re.test(rel));

/** 运行时依赖（唯一依赖 ws）：分发包里带上它，干净机器解压即可跑。
 *  只收这一个包而不是整个 node_modules —— 体积可控、内容可预期。 */
const VENDOR = ['server/node_modules/ws'];

/** 自检：这些路径必须出现在产物里（少一个就说明打包又退化了） */
const MUST_HAVE = [
  'extension/manifest.json',
  'panel/manifest.json',
  'panel/panel.js',
  'server/bridge-server.js',
  'server/agent/loop.js',
  'server/agent/compaction.js',
  'server/agent/skills.js',
  'server/capabilities/index.js',
  'server/core/router.js',
  'skills/browser-ops/SKILL.md',
  'verify/agent-units.js',
  'scripts/sync-panel.js',
  'client/browser-client.js',
  'VERSION'
];

function collect() {
  const files = [];
  for (const rel of INCLUDE_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error('✗ 缺少必需文件: ' + rel);
      process.exit(1);
    }
    files.push({ rel, abs });
  }
  for (const dir of INCLUDE_DIRS) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) {
      console.error('✗ 缺少必需目录: ' + dir);
      process.exit(1);
    }
    for (const f of zipfile.walk(absDir, { skip: (rel) => isExcluded(dir + '/' + rel) })) {
      // walk 的 rel 是相对 absDir 的，必须补回目录前缀，否则文件会被摊平到包根目录
      files.push({ rel: dir + '/' + f.rel, abs: f.abs });
    }
  }
  // 带上被排除规则挡住的运行时依赖
  for (const v of VENDOR) {
    const abs = path.join(ROOT, v);
    if (!fs.existsSync(abs)) { console.error('✗ 缺少运行时依赖: ' + v + '（先在 server/ 目录 npm install）'); process.exit(1); }
    for (const f2 of zipfile.walk(abs, {})) {
      const rel = v + '/' + f2.rel;
      if (files.some((x) => x.rel === rel)) continue;
      files.push({ rel, abs: f2.abs, vendor: true });
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

function main() {
  const listOnly = process.argv.includes('--list');

  // 0. 版本一致性守卫
  const vc = ver.check();
  if (!vc.ok) {
    console.error('✗ 版本号不一致，拒绝打包（防止分发包版本与内容对不上）:');
    for (const t of vc.mismatches) console.error('    ' + t.label + ' = ' + (t.version || '读不到') + '  ' + t.file);
    console.error('  先执行: node scripts/bump-version.js ' + vc.version);
    process.exit(1);
  }

  // 打包前重建 HTML 说明书 —— 发出去的文档不能是旧的
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'build-docs.js')], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) console.warn('⚠ 说明书重建失败（继续打包）: ' + String(r.stderr || '').slice(0, 120));
  } catch (e) { console.warn('⚠ 说明书重建异常（继续打包）: ' + e.message); }

  const files = collect();
  if (listOnly) {
    for (const f of files) console.log(f.rel);
    console.log('');
    console.log('共 ' + files.length + ' 个文件');
    return;
  }

  const outName = 'ark-web-v' + vc.version;
  const stageDir = path.join(DIST, outName);
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // 1. 落盘到 staging
  let rawBytes = 0;
  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    const dest = path.join(stageDir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    rawBytes += data.length;
  }

  // 2. 产物清单（内含各组件版本，便于排障时确认对方装的是哪一版）
  const distManifest = {
    name: 'Ark Web',
    version: vc.version,
    builtAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    components: {
      extension: JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).version,
      panel: JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'manifest.json'), 'utf8')).version,
      server: JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'package.json'), 'utf8')).version
    },
    files: files.length,
    unpackedBytes: rawBytes
  };
  const manifestRel = 'DIST-MANIFEST.json';
  fs.writeFileSync(path.join(stageDir, manifestRel), JSON.stringify(distManifest, null, 2) + '\n', 'utf8');

  // 3. 压缩（纯 Node，跨平台）
  const zipPath = path.join(DIST, outName + '.zip');
  const entries = zipfile.walk(stageDir, {}).map((f) => ({ name: f.rel, abs: f.abs }));
  const zr = zipfile.writeZip(zipPath, entries);

  // 4. 自检：回读中央目录
  const names = new Set(zipfile.listZip(zipPath));
  const missing = MUST_HAVE.filter((r) => !names.has(r));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex').toUpperCase();
  const zipSize = fs.statSync(zipPath).size;

  console.log('');
  console.log('=== 打包完成 ===');
  console.log('版本:      ' + vc.version);
  console.log('文件数:    ' + zr.files + '（含清单 ' + manifestRel + '）');
  console.log('源文件:    ' + (rawBytes / 1024).toFixed(1) + ' KB');
  console.log('ZIP:       ' + (zipSize / 1024).toFixed(1) + ' KB');
  console.log('输出:      ' + zipPath);
  console.log('SHA256:    ' + hash);
  console.log('自检:      ' + (missing.length ? '✗ 缺少 ' + missing.join(', ') : '✓ ' + MUST_HAVE.length + ' 个关键路径全部在包内'));
  console.log('');
  if (missing.length) process.exit(1);
}

main();
