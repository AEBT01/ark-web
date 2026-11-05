#!/usr/bin/env node
/**
 * 登记本机已加载的 Ark Web 扩展 ID。
 *
 * 用法：
 *   node scripts/label-browsers.js           列出已登记的扩展
 *   node scripts/label-browsers.js --yes     扫描并登记当前连接的扩展
 *   node scripts/label-browsers.js --add <id>  手动登记一个扩展 ID
 *   node scripts/label-browsers.js --clear   清空登记
 *
 * 登记信息写在 ~/.ark-web/extensions.json。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.ark-web');
const FILE = path.join(DIR, 'extensions.json');
const BASE = process.env.ARK_WEB_BASE || 'http://127.0.0.1:9333';
const TOKEN_FILE = path.join(DIR, 'token');

function token() {
  return existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '';
}

function load() {
  if (!existsSync(FILE)) return { extensions: [] };
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { extensions: [] }; }
}

function save(o) {
  writeFileSync(FILE, JSON.stringify(o, null, 2), 'utf8');
}

async function status() {
  const res = await fetch(`${BASE}/status`, { headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) throw new Error(`bridge-server 返回 ${res.status}（先启动 server/bridge-server.js）`);
  return res.json();
}

const argv = process.argv.slice(2);

if (argv.includes('--clear')) {
  save({ extensions: [] });
  console.log('已清空登记');
  process.exit(0);
}

const addIdx = argv.indexOf('--add');
if (addIdx >= 0) {
  const id = argv[addIdx + 1];
  if (!id) { console.error('用法: --add <扩展ID>'); process.exit(1); }
  const o = load();
  if (!o.extensions.some((e) => e.id === id)) {
    o.extensions.push({ id, label: `ext-${o.extensions.length + 1}`, addedAt: new Date().toISOString() });
    save(o);
  }
  console.log(`已登记 ${id}`);
  process.exit(0);
}

const s = await status().catch((e) => { console.error(`错误：${e.message}`); process.exit(1); });

if (argv.includes('--yes')) {
  const o = load();
  let added = 0;
  for (const e of s.extensions) {
    // 关键：登记的是**扩展 ID**（安全标识），不是 name@version——
    // 后者任何人都能伪造，拿它做白名单等于没有白名单。
    if (!e.id) {
      console.warn(`跳过 ${e.name} v${e.version}：扩展未上报 ID（版本过旧，需重载扩展）`);
      continue;
    }
    if (!o.extensions.some((x) => x.id === e.id)) {
      o.extensions.push({
        id: e.id,
        name: e.name,
        version: e.version,
        label: `ext-${o.extensions.length + 1}`,
        addedAt: new Date().toISOString()
      });
      added++;
    }
  }
  save(o);
  console.log(`登记完成：新增 ${added} 个，共 ${o.extensions.length} 个`);
}

const o = load();
console.log(`bridge-server: ${BASE}`);
console.log(`扩展在线: ${s.connected}（${s.extensions.length} 个连接，白名单 ${s.whitelisted ?? 0} 条）`);
for (const e of s.extensions) console.log(`  - ${e.name} v${e.version}  id=${e.id ?? '(未上报)'}`);
console.log('');
console.log(`已登记 ${o.extensions.length} 个：`);
for (const e of o.extensions) console.log(`  ${e.label ?? '-'}  ${e.id ?? e.key}  ${e.addedAt ?? ''}`);
