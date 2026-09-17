'use strict';
/**
 * 版本号的单一来源
 *
 * 产品里有两处必须一致的版本号：桥接扩展清单、服务端 package.json。
 * 历史教训：版本号曾各自漂到 2.9.3 / 0.1.0 / 2.9.4，而 2.9.4 只是为了让命令优先路由到
 * BrowserOS 的人为抬升 —— 用版本号当路由信号是错的，路由改由 ARK_PREFER_BROWSER
 * 与连接标签决定（见 bridge-server.js 的 sendToPlugin）。版本号从此只表示"发布内容"。
 *
 * 权威文件是仓库根的 VERSION；其余各处在 stamp() 时写入。
 * 注：曾有一处 "侧边栏面板清单"（panel/manifest.json）目标，那是另一个项目
 * （BrowserOS 深改版）的产物，本项目没有 panel/，故已移除。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION_FILE = path.join(ROOT, 'VERSION');

const TARGETS = [
  { file: 'extension/manifest.json', label: '桥接扩展清单' },
  { file: 'server/package.json', label: '服务端 package.json' }
];

/** 版本号规范：主.次.修订，可带 -后缀 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

function read() {
  try {
    const v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    if (v) return v;
  } catch (e) { /* 回退到扩展清单 */ }
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).version || '0.0.0';
  } catch (e) { return '0.0.0'; }
}

/** 读各处目标当前的版本号（文件的第一个 "version" 字段） */
function readTargets() {
  return TARGETS.map((t) => {
    const abs = path.join(ROOT, t.file);
    let version = null;
    try {
      const txt = fs.readFileSync(abs, 'utf8');
      const m = /"version"\s*:\s*"([^"]+)"/.exec(txt);
      if (m) version = m[1];
    } catch (e) { version = null; }
    return { file: t.file, label: t.label, version, exists: fs.existsSync(abs) };
  });
}

/** 一致性检查 */
function check() {
  const version = read();
  const targets = readTargets();
  const mismatches = targets.filter((t) => t.version !== version);
  return { version, targets, mismatches, ok: mismatches.length === 0 };
}

/**
 * 把 version 写进各处目标。
 * 用定点替换而非 JSON 重排，避免把清单文件整体重新格式化。
 * 同时替换文件里出现的旧版本字面量（如描述里的 "Ark Web v2.9.3"）。
 */
function stamp(version, opt) {
  const o = opt || {};
  if (!VERSION_RE.test(version)) throw new Error('版本号不合法（应形如 3.0.0 或 3.0.0-beta.1）: ' + version);
  const changed = [];
  for (const t of TARGETS) {
    const abs = path.join(ROOT, t.file);
    if (!fs.existsSync(abs)) continue;
    let txt = fs.readFileSync(abs, 'utf8');
    const before = txt;
    // 该文件自己的旧版本号：既用于替换 version 字段，也用于替换描述里的 "v2.9.3" 这类字面量
    const m = /"version"\s*:\s*"([^"]+)"/.exec(txt);
    const filePrev = m ? m[1] : null;
    txt = txt.replace(/("version"\s*:\s*")([^"]+)(")/, (mm, a, _v, c) => a + version + c);
    if (filePrev && filePrev !== version) {
      txt = txt.split(filePrev).join(version);
    }
    if (txt !== before) {
      if (!o.dryRun) fs.writeFileSync(abs, txt, 'utf8');
      changed.push(t.file);
    }
  }
  if (!o.dryRun) fs.writeFileSync(VERSION_FILE, version + '\n', 'utf8');
  return { version, changed };
}

module.exports = { ROOT, VERSION_FILE, TARGETS, VERSION_RE, read, readTargets, check, stamp };
