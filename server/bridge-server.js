/**
 * Ark Web Bridge Server
 *
 *   HTTP  : http://127.0.0.1:9333
 *   WS    : ws://127.0.0.1:9333/ext   （浏览器扩展接入）
 *
 * 端点：
 *   GET  /health          免鉴权，探活
 *   GET  /ext/version     免鉴权，扩展代码指纹（供扩展自更新比对）
 *   GET  /status          需鉴权，扩展是否在线 + 扩展 ID
 *   POST /cmd             { "cmd": "tabs", "args": {...} }  需鉴权
 *   POST /reload          需鉴权，手动触发热重载
 *
 * 鉴权：~/.ark-web/token，首次运行自动生成。CLI 直接读该文件。
 *       **不提供任何取令牌的端点**——令牌只存在于磁盘，避免本机任意进程自举。
 *       请求头 Authorization: Bearer <token> 或 ?token=<token>
 *
 * 安全：
 *   - 只绑 127.0.0.1
 *   - 拒绝带 Origin / Sec-Fetch-Site 的请求（网页无法直接驱动桥）
 *   - 扩展通道仅接受 chrome-extension:// 来源；若 ~/.ark-web/extensions.json
 *     登记了扩展 ID，则未登记的扩展一律拒绝握手
 */

import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, watch, readdirSync, statSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { sanitizeArgs, redactUrl, sanitizeText } from '../shared/redaction.mjs';

const VERSION = '5.1.2';
const PORT = Number(process.env.ARK_WEB_PORT || 9333);
const HOST = '127.0.0.1';
const EXT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_DIR = path.join(os.homedir(), '.ark-web');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token');
const WHITELIST_FILE = path.join(TOKEN_DIR, 'extensions.json');
const WS_SECRET_FILE = path.join(TOKEN_DIR, 'ws-secret');
const EXT_SECRET_COPY = path.join(EXT_ROOT, 'ark-ws-secret.txt');
const LOG_DIR = path.join(TOKEN_DIR, 'logs');
const MAX_BODY = Number(process.env.ARK_WEB_MAX_BODY || 2 * 1024 * 1024);
const MAX_PENDING = Number(process.env.ARK_WEB_MAX_PENDING || 64);
const MAX_AUDIT_ARCHIVES = Number(process.env.ARK_WEB_MAX_AUDIT_ARCHIVES || 10);
const EXT_TIMEOUT_MIN = 1000;
const EXT_TIMEOUT_MAX = 120000;
const HEARTBEAT_MS = 20000;

// ── 热重载：扩展代码指纹 ───────────────────────────────────────────────────
// 只对扩展自身的运行文件取指纹，排除依赖/日志/快照，避免自触发死循环。
// server/ client/ scripts/ test/ 是 Node 侧代码，不参与扩展运行，改它们不该触发扩展重载
const IGNORE = new Set(['node_modules', '.git', 'logs', 'shots', 'server', 'client', 'scripts', 'test']);
const WATCH_EXT = new Set(['.js', '.json', '.html', '.css', '.mjs']);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (WATCH_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

function fingerprint() {
  const files = walk(EXT_ROOT).sort();
  const h = createHash('sha256');
  let total = 0;
  for (const f of files) {
    try {
      const rel = path.relative(EXT_ROOT, f);
      const buf = readFileSync(f);          // 内容指纹：只 touch 不会误触发热重载
      total += buf.length;
      h.update(rel);
      h.update('\0');
      h.update(buf);
      h.update('\0');
    } catch { /* 文件刚被替换，跳过 */ }
  }
  return { hash: h.digest('hex').slice(0, 16), files: files.length, bytes: total };
}

let current = fingerprint();
let reloadSeq = 0;

function broadcastReload(reason) {
  const fp = fingerprint();
  if (fp.hash === current.hash && reason !== 'manual') return;
  const changed = fp.hash !== current.hash;
  current = fp;
  reloadSeq++;
  const payload = { type: 'reload', hash: fp.hash, files: fp.files, seq: reloadSeq, reason };
  let sent = 0;
  for (const e of liveExtensions()) {
    try { e.ws.send(JSON.stringify(payload)); sent++; } catch { /* 连接在检查后断开 */ }
  }
  log(`⟳ 热重载 #${reloadSeq}（${reason}${changed ? '' : '，强制'}）→ 已通知 ${sent} 个扩展  hash=${fp.hash}`);
}

mkdirSync(TOKEN_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

function loadToken() {
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim();
    try { chmodSync(TOKEN_FILE, 0o600); } catch { /* 尽力而为 */ }
    if (t.length >= 32) return t;
  }
  const t = randomBytes(32).toString('hex');
  writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  try { chmodSync(TOKEN_FILE, 0o600); } catch { /* Windows ACL 由用户目录保护 */ }
  return t;
}

/**
 * 扩展 ID 白名单。
 * - 文件不存在：未配置，放行（首次安装引导）
 * - 文件存在且合法但为空：显式清空，视为未启用白名单
 * - 文件存在但损坏：fail-closed，拒绝所有扩展（避免安全策略被静默绕过）
 */
function loadWhitelist() {
  if (!existsSync(WHITELIST_FILE)) return { ids: new Set(), configured: false, corrupt: false };
  try {
    const j = JSON.parse(readFileSync(WHITELIST_FILE, 'utf8'));
    if (!j || !Array.isArray(j.extensions)) return { ids: new Set(), configured: true, corrupt: true };
    return { ids: new Set(j.extensions.map((e) => e && e.id).filter(Boolean)), configured: true, corrupt: false };
  } catch {
    return { ids: new Set(), configured: true, corrupt: true };
  }
}

/** 缺少白名单时只开放只读配对接口，避免首装/清空白名单后默认放行所有扩展。 */
function pairingRequired() {
  if (process.env.ARK_WEB_ALLOW_UNLABELED === '1') return false;
  const wl = loadWhitelist();
  if (wl.corrupt) return false; // 损坏时 fail-closed，走原白名单逻辑
  return wl.ids.size === 0;
}

/**
 * 扩展通道共享密钥。
 * 服务端生成后同时写到扩展目录，扩展通过 chrome.runtime.getURL 读取并放进 hello。
 * 这样本地进程仅靠伪造 extId 已经无法接入；密钥文件与 token 同样只在本用户目录可读。
 */
function loadWsSecret() {
  let secret = '';
  try {
    if (existsSync(WS_SECRET_FILE)) secret = readFileSync(WS_SECRET_FILE, 'utf8').trim();
  } catch { /* 读不到就重建 */ }
  if (secret.length < 32) {
    secret = randomBytes(32).toString('hex');
    try { writeFileSync(WS_SECRET_FILE, secret, { mode: 0o600 }); chmodSync(WS_SECRET_FILE, 0o600); } catch { /* 权限问题下面仍会尝试 */ }
  } else {
    try { chmodSync(WS_SECRET_FILE, 0o600); } catch { /* 尽力而为 */ }
  }
  try { writeFileSync(EXT_SECRET_COPY, secret, { mode: 0o600 }); chmodSync(EXT_SECRET_COPY, 0o600); } catch { /* 扩展目录不可写时退回 ID 白名单 */ }
  return secret;
}

const TOKEN = loadToken();
const WS_SECRET = loadWsSecret();
const startedAt = Date.now();

function log(...a) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${a.join(' ')}`;
  console.log(line);
}

/** 从 UA 识别浏览器，便于多浏览器场景按名字选择 */
function browserName(ua) {
  const s = String(ua || '');
  if (/\bEdg\//.test(s)) return 'Edge';
  if (/\bOPR\//.test(s)) return 'Opera';
  if (/\bBrave\//.test(s)) return 'Brave';
  if (/\bChrome\//.test(s)) return 'Chrome';
  if (/\bChromium\//.test(s)) return 'Chromium';
  return 'Chromium';
}

// ── 扩展连接管理 ───────────────────────────────────────────────────────────
const extensions = new Map(); // id -> { ws, extId, name, version, since, verified }
let pending = new Map();      // reqId -> { resolve, reject, timer, extKey }
let reqSeq = 0;

// 扩展的 service worker 被浏览器回收时不会发 close 帧，TCP 半开连接会留很久。
// 结果是 extensions 表里堆一堆 readyState!==1 的死条目——功能不受影响（pickExt 只挑 OPEN），
// 但 health/status 会把它们当"已连接扩展"报出来，误导性极强（实测堆到 233 条）。
function sweepExtensions() {
  let removed = 0;
  for (const [id, e] of extensions) {
    if (!e.ws || e.ws.readyState !== 1) {
      extensions.delete(id);
      removed++;
    }
  }
  if (removed) log(`清理失效扩展连接 ${removed} 条，剩 ${extensions.size} 条`);
  return removed;
}

function liveExtensions() {
  const out = [];
  for (const [, e] of extensions) {
    if (e.verified && e.ws && e.ws.readyState === 1) out.push(e);
  }
  return out;
}

function pickExt(extId = null, connId = null) {
  const live = liveExtensions();
  // conn 是连接级唯一键：同一份扩展在 Chrome/Edge 中 extId 相同，必须优先用 conn
  if (connId) return live.find((e) => extractKeyOf(e) === connId) || null;
  if (extId) return live.find((e) => e.extId === extId) || null;
  return live.length ? live[0] : null;
}

function callExtension(cmd, args = {}, timeoutMs = 30000, extId = null, connId = null) {
  const ext = pickExt(extId, connId);
  if (!ext) {
    const err = new Error(connId
      ? `未找到指定扩展连接：${connId}`
      : extId
        ? `未找到指定扩展：${extId}`
        : '浏览器扩展未连接。请在 chrome://extensions 加载本目录并开启开发者模式');
    err.code = connId || extId ? 'E_EXT_NOT_FOUND' : 'E_EXT_DOWN';
    err.hint = connId
      ? '连接可能已断开；重跑 status 获取最新 conn'
      : extId
        ? `先跑 status 查看已连接扩展；可用：${liveExtensions().map((e) => `${e.browser}:${e.extId}@${extractKeyOf(e)}`).join(', ') || '(无)'}`
        : '确认扩展已启用，且桥接端口未被占用';
    return Promise.reject(err);
  }
  const id = `r${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const err = new Error(`扩展响应超时（${timeoutMs}ms）：${cmd}`);
      err.code = 'E_TIMEOUT';
      err.hint = '命令可能在页面里卡住（弹窗阻塞 / 页面无响应）。先 dialog --policy accept 再重试';
      reject(err);
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, extKey: extractKeyOf(ext) });
    ext.ws.send(JSON.stringify({ id, cmd, args }), (err) => {
      if (!err) return;
      pending.delete(id);
      clearTimeout(timer);
      const e = new Error(`扩展通道发送失败：${String(err.message || err)}`);
      e.code = 'E_EXT_DOWN';
      e.hint = '扩展可能刚断开；重试即可。若持续失败，重载扩展并确认 /status';
      reject(e);
    });
  });
}

/** 用对象身份找到它在 extensions 表里的 key，便于断开时精确 reject 该扩展的请求 */
function extractKeyOf(ext) {
  for (const [k, e] of extensions) if (e === ext) return k;
  return null;
}

/** 扩展连接断开：立刻 reject 挂在该扩展上的请求，别让调用方干等到超时 */
function rejectPendingOf(extKey, reason) {
  let n = 0;
  for (const [id, p] of pending) {
    if (p.extKey !== extKey) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    const err = new Error(reason);
    err.code = 'E_EXT_DOWN';
    err.hint = '扩展连接已断开，通常是后台 service worker 被回收或浏览器关闭了调试授权；重试即可';
    p.reject(err);
    n++;
  }
  if (n) log(`已中断 ${n} 个挂起请求（${reason}）`);
  return n;
}

// ── HTTP ───────────────────────────────────────────────────────────────────
function isBrowserOrigin(req) {
  return Boolean(req.headers.origin || req.headers['sec-fetch-site']);
}

function secretMatches(candidate) {
  const a = createHash('sha256').update(String(candidate ?? '')).digest();
  const b = createHash('sha256').update(WS_SECRET).digest();
  return timingSafeEqual(a, b);
}

function authOk(req, url) {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const given = bearer;
  if (!given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(TOKEN).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── 审计日志 ───────────────────────────────────────────────────────────────
// 每条命令写一行 JSONL：谁在什么时候让浏览器做了什么。参数由 shared/redaction.mjs 深度脱敏。

function audit(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, 'audit.jsonl');
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) {
      const archive = path.join(LOG_DIR, `audit-${Date.now()}.jsonl`);
      renameSync(file, archive);
      try { chmodSync(archive, 0o600); } catch { /* 尽力而为 */ }
      // 只保留最近 N 个归档，避免无限增长
      const archives = readdirSync(LOG_DIR)
        .filter((name) => /^audit-\d+\.jsonl$/.test(name))
        .map((name) => ({ name, path: path.join(LOG_DIR, name), mtime: statSync(path.join(LOG_DIR, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of archives.slice(MAX_AUDIT_ARCHIVES)) {
        try { unlinkSync(old.path); } catch { /* 清理失败不影响主流程 */ }
      }
    }
    appendFileSync(file, JSON.stringify(entry) + '\n');
    try { chmodSync(file, 0o600); } catch { /* 尽力而为 */ }
  } catch { /* 审计失败不影响主流程 */ }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer({ headersTimeout: 5000, requestTimeout: 15000, keepAliveTimeout: 5000, maxHeaderSize: 16 * 1024 }, async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); }
  catch { return json(res, 400, { error: '非法 URL' }); }

  // 浏览器来源一律拒绝，但扩展自身的探活/版本请求必须放行：
  // options 页面和 SW 轮询都从 chrome-extension:// 发起，旧逻辑会把它们一起 403。
  const origin = String(req.headers.origin || '');
  const extOrigin = origin.startsWith('chrome-extension://');
  const extSafePath = url.pathname === '/health' || url.pathname === '/ext/version';
  // 两个只读探活端点允许扩展来源；即使 Chrome 只发 Sec-Fetch-Site 不发 Origin 也能用。
  if (isBrowserOrigin(req) && !(extSafePath && (extOrigin || !origin))) {
    return json(res, 403, { error: '拒绝来自网页的请求（Origin/Sec-Fetch 存在）' });
  }

  if (url.pathname === '/health') {
    const stale = sweepExtensions();
    return json(res, 200, {
      ok: true,
      service: 'ark-web-bridge',
      version: VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      extensions: liveExtensions().length,
      pendingHandshakes: Math.max(0, extensions.size - liveExtensions().length),
      swept: stale,
      extHash: current.hash,
      pairingRequired: pairingRequired(),
      reloadSeq
    });
  }

  // 扩展自更新用：取扩展代码指纹（免鉴权，仅回环；不含任何敏感信息）
  if (url.pathname === '/ext/version') {
    return json(res, 200, { ...current, reloadSeq });
  }

  // 注意：这里没有 /token。令牌只在磁盘上，任何本机进程都必须自己有读权限才能用。
  if (!authOk(req, url)) {
    return json(res, 401, { error: '缺少或错误的令牌（~/.ark-web/token）' });
  }

  // 手动触发热重载
  if (url.pathname === '/reload' && req.method === 'POST') {
    if (pairingRequired()) return json(res, 403, { error: '尚未完成扩展登记，禁止热重载', code: 'E_PAIRING_REQUIRED', hint: '运行 node scripts/label-browsers.js --yes 登记扩展' });
    broadcastReload('manual');
    return json(res, 200, { ok: true, ...current, reloadSeq });
  }

  if (url.pathname === '/status') {
    sweepExtensions();
    const wl = loadWhitelist();
    const list = liveExtensions().map((e) => ({
      id: e.extId ?? null, name: e.name, version: e.version, browser: e.browser,
      since: e.since, conn: extractKeyOf(e), verified: true
    }));
    return json(res, 200, {
      connected: pickExt() !== null, extensions: list,
      whitelisted: wl.ids.size, whitelistCorrupt: wl.corrupt,
      pairingRequired: pairingRequired(),
      auth: WS_SECRET ? 'secret+whitelist' : 'whitelist'
    });
  }

  if (url.pathname === '/cmd' && req.method === 'POST') {
    if (pairingRequired()) return json(res, 403, { error: '尚未完成扩展登记，禁止执行浏览器操作', code: 'E_PAIRING_REQUIRED', hint: '运行 node scripts/label-browsers.js --yes 登记扩展' });
    const length = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(length) && length > MAX_BODY) return json(res, 413, { error: `请求体超过上限 ${MAX_BODY} 字节`, code: 'E_TOO_LARGE' });
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > MAX_BODY) {
          tooLarge = true;
          chunks.length = 0; // 继续消费但不再占内存，保证还能返回 413
          return;
        }
        chunks.push(buf);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
    if (tooLarge) return json(res, 413, { error: `请求体超过上限 ${MAX_BODY} 字节`, code: 'E_TOO_LARGE' });
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'body 不是合法 JSON' }); }
    const cmd = body.cmd;
    if (typeof cmd !== 'string') return json(res, 400, { error: '缺少 cmd 字段' });
    const t0 = Date.now();
    if (pending.size >= MAX_PENDING) {
      return json(res, 503, { ok: false, cmd, error: '扩展通道繁忙，待处理请求已达上限', code: 'E_OVERLOADED', hint: `稍后重试，或降低并发；上限 ${MAX_PENDING}` });
    }
    const rawTimeout = Number(body.timeoutMs ?? 30000);
    const timeoutMs = Number.isFinite(rawTimeout)
      ? Math.max(EXT_TIMEOUT_MIN, Math.min(EXT_TIMEOUT_MAX, Math.floor(rawTimeout)))
      : 30000;
    const wantedExtId = body.extId ? String(body.extId) : null;
    const wantedConn = body.conn ? String(body.conn) : null;
    const target = pickExt(wantedExtId, wantedConn);
    const meta = target ? { extId: target.extId ?? null, browser: target.browser || null, conn: extractKeyOf(target) } : {};
    try {
      const data = await callExtension(cmd, body.args ?? {}, timeoutMs, wantedExtId, wantedConn);
      const elapsedMs = Date.now() - t0;
      audit({ at: new Date().toISOString(), cmd, args: sanitizeArgs(body.args), ok: true, elapsedMs });
      return json(res, 200, { ok: true, cmd, data, ...meta, elapsedMs });
    } catch (e) {
      const elapsedMs = Date.now() - t0;
      const payload = { ok: false, cmd, error: String(e?.message ?? e), ...meta, elapsedMs };
      if (e?.code) payload.code = e.code;
      if (e?.hint) payload.hint = e.hint;
      if (typeof e?.retryable === 'boolean') payload.retryable = e.retryable;
      audit({ at: new Date().toISOString(), cmd, args: sanitizeArgs(body.args), ok: false, code: e?.code ?? null, elapsedMs });
      return json(res, 502, payload);
    }
  }

  json(res, 404, { error: '未知路径' });
});

// ── WS（扩展通道）──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ext', maxPayload: 8 * 1024 * 1024 });

function rejectHandshake(ws, id, reason, hint) {
  try {
    ws.send(JSON.stringify({ type: 'reject', reason, hint }));
  } catch { /* 连接可能已断 */ }
  extensions.delete(id);
  ws.close(1008, reason);
}

wss.on('connection', (ws, req) => {
  // 浏览器网页的 WS 一定带 Origin；扩展带 chrome-extension://；本地进程可以不带。
  // 不带 Origin 并不可信，所以真正的门禁是 hello.secret。
  if (req.headers.origin && !req.headers.origin.startsWith('chrome-extension://')) {
    log('拒绝非扩展来源的 WS 连接:', req.headers.origin);
    ws.close(1008, 'origin not allowed');
    return;
  }

  const id = randomBytes(4).toString('hex');
  const entry = { ws, extId: null, name: 'unknown', version: '?', browser: 'Chromium', since: Date.now(), verified: false };
  extensions.set(id, entry);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // 未完成握手的连接不能无限期挂在表里
  const handshakeTimer = setTimeout(() => {
    if (!entry.verified) {
      log(`握手超时，关闭 #${id}`);
      extensions.delete(id);
      try { ws.close(1008, 'handshake timeout'); } catch { /* 已断 */ }
    }
  }, 15000);
  log(`扩展通道已建立 #${id}（等待握手）`);

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === 'hello') {
      const extId = msg.extId ? String(msg.extId) : null;

      // 1) 共享密钥：服务端生成，扩展从自身目录的 ark-ws-secret.txt 读取
      if (!secretMatches(msg.secret)) {
        log(`拒绝握手：共享密钥不匹配 id=${extId ?? '?'}`);
        rejectHandshake(ws, id, 'bad-secret',
          '扩展未拿到 ark-ws-secret.txt。确认 bridge-server 已启动，然后重载扩展');
        return;
      }

      // 2) 白名单：损坏时 fail-closed
      const wl = loadWhitelist();
      if (wl.corrupt) {
        log('拒绝握手：extensions.json 损坏，白名单 fail-closed');
        rejectHandshake(ws, id, 'whitelist-corrupt',
          '修复 ~/.ark-web/extensions.json（或删除后重新 label-browsers --yes）');
        return;
      }
      if (wl.ids.size > 0 && (!extId || !wl.ids.has(extId))) {
        log(`拒绝未登记扩展 id=${extId ?? '?'}（白名单 ${wl.ids.size} 条）`);
        rejectHandshake(ws, id, 'ext-not-whitelisted',
          '运行 node scripts/label-browsers.js --yes 登记本扩展 ID');
        return;
      }

      clearTimeout(handshakeTimer);
      entry.verified = true;
      entry.name = msg.name ?? 'Ark Web Bridge';
      entry.version = msg.version ?? '?';
      entry.browser = browserName(msg.ua || '');
      entry.extId = extId;
      entry.since = Date.now();
      log(`握手成功：${entry.name} v${entry.version} id=${extId ?? '-'}${wl.ids.size === 0 ? '（白名单未启用）' : ''} hash=${current.hash}`);
      // 回告当前指纹，扩展据此判断自己是否已是最新
      try {
        ws.send(JSON.stringify({ type: 'welcome', hash: current.hash, reloadSeq, files: current.files }));
      } catch { /* 连接刚断 */ }
      return;
    }

    // 3) 响应必须来自请求实际发送到的那条连接，防止本地其它 WS 抢答
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      if (p.extKey !== id) {
        log(`忽略来自 #${id} 的跨连接响应 ${msg.id}（应来自 #${p.extKey}）`);
        return;
      }
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else {
        const err = new Error(msg.error || '扩展返回失败');
        if (msg.code) err.code = msg.code;
        if (msg.hint) err.hint = msg.hint;
        if (typeof msg.retryable === 'boolean') err.retryable = msg.retryable;
        if (msg.elapsedMs != null) err.elapsedMs = msg.elapsedMs;
        p.reject(err);
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(handshakeTimer);
    extensions.delete(id);
    rejectPendingOf(id, '扩展连接已断开');
    log(`扩展已断开 #${id}`);
  });
  ws.on('error', () => { /* close 会跟着来 */ });
});

// 半开 TCP 不会触发 close：用 ping/pong 主动清理，否则 /status 会一直显示“已连接”
const heartbeat = setInterval(() => {
  for (const [id, e] of extensions) {
    if (!e.ws || e.ws.readyState !== 1) { extensions.delete(id); continue; }
    if (!e.ws.isAlive) {
      log(`心跳超时，清理扩展连接 #${id}`);
      try { e.ws.terminate(); } catch { /* 已断 */ }
      extensions.delete(id);
      rejectPendingOf(id, '扩展连接心跳超时');
      continue;
    }
    e.ws.isAlive = false;
    try { e.ws.ping(); } catch { /* 下一轮清理 */ }
  }
}, HEARTBEAT_MS);

server.listen(PORT, HOST, () => {
  log(`bridge-server v${VERSION} 监听 http://${HOST}:${PORT}`);
  log(`令牌文件 ${TOKEN_FILE}（无 /token 端点，CLI 直读文件）`);
  log(`扩展目录 ${EXT_ROOT}`);
  const wl = loadWhitelist();
  if (wl.corrupt) log('⚠ 扩展白名单文件损坏：当前 fail-closed，所有扩展都会被拒绝');
  else log(wl.ids.size ? `扩展白名单 ${wl.ids.size} 条` : '扩展白名单未启用（运行 node scripts/label-browsers.js --yes 登记）');
  log(`扩展通道密钥 ${WS_SECRET_FILE}（已同步到 ark-ws-secret.txt）`);
  log(`代码指纹 ${current.hash}（${current.files} 个文件 / ${(current.bytes / 1024).toFixed(1)} KB）`);
  log('等待浏览器扩展接入（chrome://extensions → 加载已解压的扩展程序 → 选本目录）');

  // ── 文件监听：改完代码自动推送热重载 ──────────────────────────────────
  let debounce = null;
  try {
    watch(EXT_ROOT, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const parts = String(filename).split(/[\\/]/);
      if (parts.some((p) => IGNORE.has(p))) return;
      if (!WATCH_EXT.has(path.extname(String(filename)).toLowerCase())) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const fp = fingerprint();
        if (fp.hash !== current.hash) broadcastReload(`文件变更 ${filename}`);
      }, 700);
    });
    log('已开启文件监听（热重载就绪）');
  } catch (e) {
    log('文件监听不可用，改用轮询兜底:', String(e?.message ?? e));
  }
});

server.on('error', (e) => {
  log(`服务启动/运行错误：${String(e?.message ?? e)}`);
  if (e && e.code === 'EADDRINUSE') log(`端口 ${PORT} 被占用；先停掉旧 bridge-server 或设置 ARK_WEB_PORT`);
});
process.on('SIGINT', () => { clearInterval(heartbeat); log('停止'); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(heartbeat); log('停止'); process.exit(0); });
