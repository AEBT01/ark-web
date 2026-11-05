#!/usr/bin/env node
/**
 * 手动触发扩展热重载（改完代码不想等文件监听时用）。
 *   node scripts/reload.js
 *   node scripts/reload.js --watch     持续监听，改一次推一次
 */

import { readFileSync, existsSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ARK_WEB_BASE || 'http://127.0.0.1:9333';
const TOKEN_FILE = path.join(os.homedir(), '.ark-web', 'token');

function token() {
  if (!existsSync(TOKEN_FILE)) throw new Error(`缺少令牌文件 ${TOKEN_FILE}`);
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

async function trigger(reason = 'cli') {
  const res = await fetch(`${BASE}/reload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}` }
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  console.log(`已推送重载 #${j.reloadSeq}  hash=${j.hash}  (${j.files} 个文件)`);
  return j;
}

const args = process.argv.slice(2);

if (args.includes('--watch')) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const IGNORE = new Set(['node_modules', '.git', 'logs', 'shots', 'server', 'client', 'scripts', 'test']);
  const WATCH_EXT = new Set(['.js', '.json', '.html', '.css', '.mjs']);
  console.log(`监听 ${ROOT} …（Ctrl+C 退出）`);
  let t = null;
  watch(ROOT, { recursive: true }, (_e, f) => {
    if (!f) return;
    const parts = String(f).split(/[\\/]/);
    if (parts.some((p) => IGNORE.has(p))) return;
    if (!WATCH_EXT.has(path.extname(String(f)).toLowerCase())) return;
    clearTimeout(t);
    t = setTimeout(() => trigger(String(f)).catch((e) => console.error(e.message)), 500);
  });
} else {
  await trigger().catch((e) => { console.error(`错误：${e.message}`); process.exit(1); });
}
