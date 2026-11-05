#!/usr/bin/env node
/**
 * Ark Web 浏览器 CLI —— 面向 AI 的接口（v5.0）
 *
 * 设计原则：
 *   1. 稳定 envelope：成功 {ok:true, cmd, data}；失败 {ok:false, cmd, error:{code,message,hint}}
 *   2. 自描述：describe 返回全部命令 schema，AI 无需读文档即可发现能力
 *   3. token 经济：列表类结果一律带 count/returned/truncated，截断必须显式
 *   4. 可自愈：错误带 code + hint，参数错误在本地就拦下，不浪费一次往返
 *   5. 无交互：绝不等待 stdin、绝不弹确认
 *
 * 输出模式：默认人读文本；--json 或 ARK_WEB_JSON=1 输出 envelope（AI 用这个）。
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const VERSION = '5.1.0';
const BASE = process.env.ARK_WEB_BASE || 'http://127.0.0.1:9333';
const TOKEN_FILE = path.join(os.homedir(), '.ark-web', 'token');
const SELF = fileURLToPath(import.meta.url);

// ── 基础设施 ───────────────────────────────────────────────────────────────
function token() {
  if (process.env.ARK_WEB_TOKEN) return process.env.ARK_WEB_TOKEN.trim();
  if (!existsSync(TOKEN_FILE)) {
    const e = new Error(`找不到令牌文件 ${TOKEN_FILE}`);
    e.code = 'E_TOKEN';
    e.hint = '先启动 server/bridge-server.js 生成令牌';
    throw e;
  }
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

async function api(pathname, opts = {}) {
  let res;
  try {
    res = await fetch(BASE + pathname, {
      ...opts,
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...(opts.headers || {}) }
    });
  } catch (e) {
    const err = new Error(`连不上桥接 ${BASE}：${e.message}`);
    err.code = 'E_BRIDGE_DOWN';
    err.hint = '确认 server/bridge-server.js 在跑（curl ' + BASE + '/health）';
    throw err;
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(body.error ?? text.slice(0, 300));
    err.code = body.code ?? (res.status === 401 ? 'E_AUTH' : 'E_BACKEND');
    err.hint = body.hint ?? (res.status === 401 ? '令牌不匹配，检查 ~/.ark-web/token' : undefined);
    if (typeof body.retryable === 'boolean') err.retryable = body.retryable;
    if (body.elapsedMs != null) err.elapsedMs = body.elapsedMs;
    throw err;
  }
  return body;
}

// 最近一次桥接往返耗时（含扩展执行），随 envelope 回给调用方
let lastElapsedMs = null;

async function cmd(name, args = {}, timeoutMs = 30000, extOverride = null) {
  const t0 = Date.now();
  const sel = extOverride || global.__ARK_EXT_SEL__ || (global.__ARK_EXT__ ? { extId: global.__ARK_EXT__ } : null);
  const extId = typeof sel === 'string' ? sel : sel && sel.extId;
  const conn = sel && typeof sel === 'object' ? sel.conn : null;
  const r = await api('/cmd', {
    method: 'POST',
    body: JSON.stringify({
      cmd: name, args, timeoutMs,
      ...(extId ? { extId } : {}),
      ...(conn ? { conn } : {})
    })
  });
  lastElapsedMs = r.elapsedMs != null ? r.elapsedMs : Date.now() - t0;
  if (r.extId) global.__ARK_LAST_EXT__ = { extId: r.extId, browser: r.browser, conn: r.conn };
  return r.data;
}

async function listExtensions() {
  const st = await api('/status');
  return st.extensions || [];
}

/** --ext / --browser 的统一解析：all、逗号列表、extId、浏览器名都支持 */
async function resolveExts(spec) {
  const list = await listExtensions();
  if (!spec || spec === 'all' || spec === true) {
    if (!list.length) fail('E_EXT_DOWN', '没有已连接扩展', '启动 bridge-server 并在 chrome://extensions 加载扩展');
    return list;
  }
  const wanted = String(spec).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = [];
  for (const w of wanted) {
    const hits = list.filter((e) =>
      String(e.id || '').toLowerCase() === w ||
      String(e.browser || '').toLowerCase() === w ||
      String(e.name || '').toLowerCase().includes(w)
    );
    if (!hits.length) fail('E_EXT_NOT_FOUND', `没有匹配的扩展/浏览器：${w}`, `可用：${list.map((e) => `${e.browser}:${e.id}`).join(', ') || '(无)'}`);
    for (const hit of hits) if (!picked.some((x) => x.conn === hit.conn)) picked.push(hit);
  }
  return picked;
}

/** 多浏览器时按 tabId 反查所属浏览器；唯一命中才自动绑定 */
async function resolveExtForTab(tabId) {
  const list = await listExtensions();
  if (list.length <= 1) return null;
  const matches = [];
  for (const e of list) {
    try {
      const tabs = await cmd('tabs', {}, 30000, { extId: e.id, conn: e.conn });
      if (Array.isArray(tabs) && tabs.some((t) => Number(t.id) === Number(tabId))) matches.push(e);
    } catch { /* 单个浏览器查询失败不影响其它 */ }
  }
  if (matches.length === 1) {
    global.__ARK_EXT_SEL__ = { extId: matches[0].id, conn: matches[0].conn };
    return matches[0];
  }
  if (matches.length > 1) {
    fail('E_AMBIGUOUS_TAB', `tabId ${tabId} 在多个浏览器中存在`, `用 --ext <id|browser> 明确指定：${matches.map((e) => `${e.browser}:${e.id}`).join(', ')}`);
  }
  return null;
}

/** fanout 用：子进程跑同一条 CLI，避免全局 --ext 在并发中互相覆盖 */
function runSelfJson(argv, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SELF, ...argv, '--json'], {
      env: { ...process.env, ARK_WEB_JSON: '1' },
      windowsHide: true
    });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: { code: 'E_FANOUT_TIMEOUT', message: `${timeoutMs}ms` } }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      try { resolve(JSON.parse(line)); }
      catch { resolve({ ok: false, error: { code: 'E_NO_JSON', message: (err || out).slice(0, 240) } }); }
    });
  });
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, opts };
}

function fail(code, message, hint) {
  const e = new Error(message);
  e.code = code;
  if (hint) e.hint = hint;
  throw e;
}

// ── chain 取值插值：{{steps.0.items.0.ref}} / {{last.data.x}} ─────────────────
function jpath(obj, path) {
  const segs = [];
  for (const raw of String(path).split('.')) {
    const m = raw.match(/^([A-Za-z_$][\w$]*)((?:\[\d+\])*)$/);
    if (m) {
      segs.push(m[1]);
      for (const idx of m[2].match(/\d+/g) || []) segs.push(Number(idx));
    } else if (/^\d+$/.test(raw)) {
      segs.push(Number(raw));          // steps.0.items.0.ref 这种纯数字下标
    } else {
      return undefined;
    }
  }
  let cur = obj;
  for (const s of segs) { if (cur == null) return undefined; cur = cur[s]; }
  return cur;
}

function interpolate(text, ctx) {
  return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
    const v = jpath(ctx, expr);
    if (v === undefined) return whole;            // 取不到就原样保留，方便定位写错的地方
    if (v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // 始终加引号并转义，避免页面文本里的空格/引号/换行注入额外参数
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
  });
}

/** 支持双引号、单引号与必要转义的轻量 tokenizer（不吞 Windows 路径里的反斜杠） */
function tokenize(text) {
  const s = String(text);
  const out = [];
  let cur = '';
  let quote = null;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      cur += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      const next = s[i + 1];
      if (next && /["'\\nt ]/.test(next)) { esc = true; continue; }
      cur += ch;                 // D:\a.pdf 这类路径保留反斜杠
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (esc) cur += '\\';
  if (cur) out.push(cur);
  return out;
}

const num = (v, d, name) => {
  if (v === undefined) return d;
  if (v === true) fail('E_PARAM', `--${name || 'value'} 需要一个数字，但没有给值`, '例：--limit 40');
  const n = Number(v);
  if (!Number.isFinite(n)) fail('E_PARAM', `--${name || 'value'} 需要数字，收到 "${v}"`, '检查参数取值');
  return n;
};
const positiveInt = (v, name) => {
  const n = num(v, undefined, name);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n <= 0) fail('E_PARAM', `--${name} 需要正整数，收到 "${v}"`, '例：--ref 12');
  return n;
};
const bool = (v) => v === true || v === 'true' || v === '1';
const str = (v) => (v === undefined || v === true ? undefined : String(v));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compact(obj) {
  if (Array.isArray(obj)) return obj.map(compact);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = (v && typeof v === 'object') ? compact(v) : v;
  }
  return out;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

const tabArgs = (opts) => (opts.tab !== undefined ? { tabId: positiveInt(opts.tab, 'tab') } : {});

// ── 命令注册表 ─────────────────────────────────────────────────────────────
const P = (type, desc, extra = {}) => ({ type, desc, ...extra });

const COMMANDS = {
  status: {
    summary: '桥接与扩展的连接状态；AI 每次开始操作前先跑这个',
    params: {},
    run: async () => api('/status')
  },

  describe: {
    summary: '列出全部命令及其参数（机器可读），或用 describe <cmd> 看单个命令',
    params: { cmd: P('string', '要查看的命令名；省略则返回全部') },
    run: async (pos) => {
      const want = pos[0];
      if (want) {
        const c = COMMANDS[want];
        if (!c) fail('E_UNKNOWN_CMD', `没有命令 ${want}`, '先跑 describe 看可用命令');
        return { name: want, summary: c.summary, params: c.params, example: c.example ?? null };
      }
      return {
        version: VERSION,
        transport: BASE,
        envelope: { ok: '{ok, cmd, data}', error: '{ok, cmd, error:{code,message,hint}}' },
        output: { human: '默认', json: '--json 或 ARK_WEB_JSON=1' },
        commands: Object.entries(COMMANDS)
          .filter(([n]) => n !== 'help')
          .map(([n, c]) => ({ name: n, summary: c.summary, params: c.params }))
      };
    }
  },

  tabs: {
    summary: '列出全部标签页；多浏览器时自动聚合，可用 --ext/--browser 过滤',
    params: { ext: P('string', 'all | extId | 浏览器名（chrome/edge），省略=全部') },
    run: async (pos, opts) => {
      const exts = opts.conn
        ? (await listExtensions()).filter((e) => e.conn === String(opts.conn))
        : await resolveExts(opts.ext || opts.browser);
      if (!exts.length) fail('E_EXT_NOT_FOUND', `没有匹配的连接：${opts.conn}`, '重跑 status 获取最新 conn');
      const errors = [];
      const batches = await Promise.all(exts.map(async (e) => {
        try {
          const list = await cmd('tabs', {}, 30000, { extId: e.id, conn: e.conn });
          return (Array.isArray(list) ? list : []).map((t) => ({ ...t, extId: e.id, browser: e.browser, conn: e.conn }));
        } catch (err) {
          errors.push({ extId: e.id, browser: e.browser, code: err.code || 'E_TABS', message: err.message });
          return [];
        }
      }));
      const tabs = batches.flat();
      return {
        count: tabs.length, tabs,
        ...(exts.length > 1 ? { browsers: exts.map((e) => ({ extId: e.id, browser: e.browser })) } : {}),
        ...(errors.length ? { errors } : {})
      };
    }
  },

  open: {
    summary: '打开页面；默认先挂 CDP 再导航，网络从第一字节就能抓',
    params: {
      url: P('string', '目标 URL', { required: true }),
      'tab-bg': P('flag', '后台打开，不切换当前标签'),
      capture: P('bool', '是否开网络捕获，默认 true'),
      wait: P('bool', '是否等加载完成，默认 true'),
      timeout: P('number', '加载超时 ms', { default: 30000 })
    },
    example: 'open https://example.com --tab-bg',
    run: async (pos, opts) => {
      const url = pos[0];
      if (!url) fail('E_PARAM', '缺少 url', '用法: open <url> [--tab-bg] [--capture false]');
      return cmd('open', {
        url,
        waitLoad: opts.wait !== 'false',
        timeoutMs: num(opts.timeout, 30000, 'timeout'),
        active: opts['tab-bg'] !== true,
        capture: opts.capture !== 'false'
      }, 90000);
    }
  },

  close: {
    summary: '关闭标签页',
    params: { id: P('number', '标签页 id'), tab: P('number', '同 id，--tab 形式') },
    run: async (pos, opts) => {
      const id = opts.tab ?? pos[0];
      if (id == null) fail('E_PARAM', '缺少标签页 id', '用法: close --tab <id>');
      return cmd('close', { tabId: positiveInt(id, 'tab') });
    }
  },

  activate: {
    summary: '切换到指定标签页（会更新默认操作标签）',
    params: { id: P('number', '标签页 id'), tab: P('number', '同 id') },
    run: async (pos, opts) => {
      const id = opts.tab ?? pos[0];
      if (id == null) fail('E_PARAM', '缺少标签页 id', '用法: activate --tab <id>');
      return cmd('activate', { tabId: positiveInt(id, 'tab') });
    }
  },

  info: {
    summary: '当前标签页信息（id/url/title/status/视口）',
    params: { tab: P('number', '标签页 id；省略用最近操作的标签') },
    run: async (pos, opts) => cmd('info', { ...tabArgs(opts) })
  },

  snapshot: {
    summary: '语义快照：跨 iframe/shadow 采集元素（带上下文与 ref），可选截图并把编号烧进图里',
    params: {
      file: P('string', '截图保存路径', { default: 'snapshot.webp' }),
      limit: P('number', '返回元素数上限', { default: 40 }),
      max: P('number', '采集上限', { default: 400 }),
      format: P('string', 'webp|png|jpeg', { default: 'webp' }),
      quality: P('number', '1-100', { default: 80 }),
      full: P('flag', '整页截图'),
      shot: P('flag', '同时截图（默认只回结构，不截图更快；需要视觉快照时才加）'),
      focus: P('flag', '截图时允许临时聚焦浏览器窗口（最小化/被遮挡时用）'),
      'no-shot': P('flag', '兼容旧用法：强制不截图'),
      timeout: P('number', '截图超时毫秒（默认自动分级 900/2500/8000）'),
      'no-boxes': P('flag', '截图不带编号框'),
      'in-view': P('flag', '只要当前视口内的元素'),
      diff: P('flag', '与上次快照对比，只回变化'),
      hidden: P('flag', '包含不可见元素（排查用）'),
      tab: P('number', '标签页 id')
    },
    example: 'snapshot s.webp --limit 60 --diff',
    run: async (pos, opts) => {
      const file = pos[0] ?? 'snapshot.webp';
      const format = opts.format ?? (file.endsWith('.png') ? 'png' : 'webp');
      const shot = opts.shot === true && opts['no-shot'] !== true;
      const data = await cmd('snapshot', {
        ...tabArgs(opts),
        limit: num(opts.limit, 40, 'limit'),
        max: num(opts.max, 400, 'max'),
        inView: bool(opts['in-view']),
        diff: opts.diff === true,
        hidden: opts.hidden === true,
        shot,
        focus: opts.focus === true,
        boxes: opts['no-boxes'] !== true,
        format,
        quality: num(opts.quality, 80, 'quality'),
        full: opts.full === true,
        timeoutMs: opts.timeout == null ? undefined : num(opts.timeout, 0, 'timeout')
      }, 120000);
      if (data.shot && data.shot.base64) {
        const buf = Buffer.from(data.shot.base64, 'base64');
        writeFileSync(file, buf);
        data.shot = {
          file, bytes: buf.length, format: data.shot.format, clip: data.shot.clip, viewportForced: data.shot.viewportForced,
          ...(data.shot.uniform ? { uniform: true } : {})
        };
      }
      return data;
    }
  },

  find: {
    summary: '语义定位：按文字/占位符/aria 找元素，直接告诉你「能不能点、为什么不能点」',
    params: {
      text: P('string', '要查找的文字/aria-label/placeholder/title/name/id 片段'),
      role: P('string', '限定角色：button|link|textbox|combobox|menuitem|tab|checkbox'),
      selector: P('string', '只在这个选择器范围内找'),
      limit: P('number', '最多返回几个候选', { default: 5 }),
      hidden: P('flag', '包含不可见元素（排查用）'),
      tab: P('number', '标签页 id')
    },
    example: 'find --text "提交订单" --role button',
    run: async (pos, opts) => {
      if (!opts.text && !opts.selector) {
        fail('E_PARAM', '需要 --text', '例：find --text "登录"；也可 find --selector ".btn" 检查可点性');
      }
      return cmd('find', {
        ...tabArgs(opts),
        text: str(opts.text) ?? '',
        role: str(opts.role) ?? null,
        selector: str(opts.selector) ?? null,
        limit: num(opts.limit, 5, 'limit'),
        hidden: opts.hidden === true
      }, 45000);
    }
  },

  click: {
    summary: '真实点击（CDP 输入域）：预检遮挡/禁用，点完自动判断跳转/DOM 变化/无反应，并追踪新标签',
    params: {
      ref: P('number', 'SoM 编号（snapshot 或 find 得到）'),
      selector: P('string', 'CSS 选择器'),
      force: P('flag', '跳过 ref 指纹校验与遮挡拦截'),
      'no-confirm': P('flag', '不等效果确认（省 1 秒，但拿不到「点没点上」的判断）'),
      count: P('number', '连击次数', { default: 1 }),
      'hold-ms': P('number', '按下保持毫秒（长按场景）'),
      tab: P('number', '标签页 id')
    },
    example: 'click --ref 12   →  {settled:true, mutated:true, via:"cdp"}',
    run: async (pos, opts) => {
      if (opts.ref == null && !opts.selector) {
        fail('E_PARAM', '需要 --ref 或 --selector', '先跑 find --text "提交" 拿 ref');
      }
      return cmd('click', {
        ...tabArgs(opts),
        ref: positiveInt(opts.ref, 'ref'),
        selector: str(opts.selector) ?? null,
        force: opts.force === true,
        confirm: opts['no-confirm'] !== true,
        count: num(opts.count, 1, 'count'),
        holdMs: num(opts['hold-ms'], 0, 'hold-ms')
      }, 60000);
    }
  },

  fill: {
    summary: '填写输入框/富文本（真实 insertText，填完回读校验）；--type 逐字符输入',
    params: {
      ref: P('number', 'SoM 编号'),
      selector: P('string', 'CSS 选择器'),
      text: P('string', '要填的文本'),
      'body-file': P('string', '从文件读取文本，避免命令行编码问题'),
      type: P('flag', '逐字符输入（联想/字数统计/富文本更可靠）'),
      delay: P('number', '逐字符间隔 ms', { default: 25 }),
      submit: P('flag', '填完回车提交'),
      force: P('flag', '跳过 ref 指纹校验'),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      let text = opts.text;
      if (opts['body-file']) text = readFileSync(String(opts['body-file']), 'utf8');
      if (text === undefined) fail('E_PARAM', '缺少 --text 或 --body-file', '例：fill --ref 3 --text "hello"');
      return cmd('fill', {
        ...tabArgs(opts),
        ref: positiveInt(opts.ref, 'ref'),
        selector: str(opts.selector) ?? null,
        text: String(text),
        type: opts.type === true,
        delay: num(opts.delay, 25, 'delay'),
        submit: opts.submit === true,
        force: opts.force === true
      }, 60000);
    }
  },

  hover: {
    summary: '真实悬停（驱动 CSS :hover）；回 hoverActive 证明浏览器认了这次移动',
    params: {
      ref: P('number', 'SoM 编号'), selector: P('string', 'CSS 选择器'), tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      if (opts.ref == null && !opts.selector) fail('E_PARAM', '需要 --ref 或 --selector', '例：hover --ref 5');
      return cmd('hover', { ...tabArgs(opts), ref: positiveInt(opts.ref, 'ref'), selector: str(opts.selector) ?? null });
    }
  },

  press: {
    summary: '真实按键/组合键（含 Tab/Escape/Enter 等默认行为）',
    params: {
      key: P('string', '如 Enter、Escape、Ctrl+Enter', { default: 'Enter' }),
      ref: P('number', '先聚焦该元素'),
      selector: P('string', '先聚焦该元素'),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => cmd('press', {
      ...tabArgs(opts),
      ref: positiveInt(opts.ref, 'ref'),
      selector: str(opts.selector) ?? null,
      key: String(opts.key ?? 'Enter')
    }, 45000)
  },

  select: {
    summary: '下拉选择：原生 select 直接选；自定义下拉自动「点开→按文本点选项」',
    params: {
      ref: P('number', 'SoM 编号'),
      selector: P('string', 'CSS 选择器'),
      values: P('string', '逗号分隔的值或选项文本'),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      const vals = str(opts.values) ?? str(opts.value);
      if (!vals) fail('E_PARAM', '缺少 --values', '例：select --ref 8 --values "CN"');
      return cmd('select', {
        ...tabArgs(opts),
        ref: positiveInt(opts.ref, 'ref'),
        selector: str(opts.selector) ?? null,
        values: String(vals).split(',').map((s) => s.trim()).filter(Boolean)
      }, 60000);
    }
  },

  shot: {
    summary: '截图保存到文件；带 --selector/--ref 只截该元素（滚动后坐标仍然准确）',
    params: {
      file: P('string', '保存路径', { default: 'shot.webp' }),
      selector: P('string', '元素选择器，截该元素'),
      ref: P('number', '元素 SoM 编号'),
      format: P('string', 'webp|png|jpeg'),
      quality: P('number', '1-100', { default: 85 }),
      full: P('flag', '整页'),
      focus: P('flag', '允许临时聚焦浏览器窗口（默认不抢焦点）'),
      timeout: P('number', '超时毫秒（默认自动分级 900/2500/8000）'),
      diff: P('flag', '与上一次同目标截图比较，返回变化率与包围盒'),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      const file = pos[0] ?? 'shot.webp';
      const format = opts.format ?? (file.endsWith('.png') ? 'png' : 'webp');
      const r = await cmd('shot', {
        ...tabArgs(opts),
        format,
        quality: num(opts.quality, 85, 'quality'),
        full: opts.full === true,
        selector: str(opts.selector) ?? null,
        ref: positiveInt(opts.ref, 'ref'),
        focus: opts.focus === true,
        diff: opts.diff === true,
        timeoutMs: opts.timeout == null ? undefined : num(opts.timeout, 0, 'timeout')
      }, 90000);
      const buf = Buffer.from(r.base64, 'base64');
      writeFileSync(file, buf);
      return {
        file, bytes: buf.length, format, clip: r.clip, viewportForced: r.viewportForced, focused: r.focused,
        vw: r.vw, vh: r.vh,
        ...(r.uniform ? { uniform: true } : {}),
        ...(r.blankRetries ? { blankRetries: r.blankRetries } : {}),
        ...(r.diff ? { diff: r.diff } : {})
      };
    }
  },

  eval: {
    summary: '在页面上下文执行 JS 表达式（CDP Runtime.evaluate，等待 Promise）',
    params: { code: P('string', 'JS 表达式', { required: true }), tab: P('number', '标签页 id') },
    example: 'eval "document.title"',
    run: async (pos, opts) => {
      const code = pos[0] ?? str(opts.code);
      if (!code) fail('E_PARAM', '缺少 JS 代码', '用法: eval "document.title"');
      return cmd('eval', { ...tabArgs(opts), code: String(code) }, 45000);
    }
  },

  scroll: {
    summary: '滚动页面',
    params: { dy: P('number', '纵向像素', { default: 600 }), dx: P('number', '横向像素'), tab: P('number', '标签页 id') },
    run: async (pos, opts) => cmd('scroll', {
      ...tabArgs(opts),
      dy: num(opts.dy, 600, 'dy'),
      dx: num(opts.dx, 0, 'dx')
    }, 45000)
  },

  attr: {
    summary: '读元素全部属性、语义上下文、可见性与包围盒',
    params: { ref: P('number', 'SoM 编号'), selector: P('string', 'CSS 选择器'), tab: P('number', '标签页 id') },
    run: async (pos, opts) => {
      if (opts.ref == null && !opts.selector) fail('E_PARAM', '需要 --ref 或 --selector', '例：attr --ref 12');
      return cmd('attr', { ...tabArgs(opts), ref: positiveInt(opts.ref, 'ref'), selector: str(opts.selector) ?? null });
    }
  },

  text: {
    summary: '抽取页面正文（Markdown 风格），适合让 AI 读内容',
    params: {
      'max-len': P('number', '最大字符数', { default: 20000 }),
      out: P('string', '写入文件'),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      const maxLen = num(opts['max-len'], 20000, 'max-len');
      const r = await cmd('text', { ...tabArgs(opts), maxLen }, 60000);
      const data = {
        url: r.url, title: r.title, chars: r.chars, text: r.text, truncated: r.truncated,
        ...(r.frames ? { frames: r.frames } : {})
      };
      if (opts.out) { writeFileSync(String(opts.out), r.text, 'utf8'); data.file = String(opts.out); }
      return data;
    }
  },

  extract: {
    summary: '结构化抽取：列表页 → 行数组（跨 shadow DOM），可翻页采集',
    params: {
      selector: P('string', '每行容器的 CSS 选择器', { required: true }),
      fields: P('string', '字段表 "name:sel, name2:sel2@attr"，self 表示容器自身，@href/@src 自动补绝对地址', { required: true }),
      limit: P('number', '每页最多行数', { default: 50 }),
      paginate: P('flag', '翻页采集（必须配 --next）'),
      next: P('string', '下一页控件选择器'),
      'max-pages': P('number', '最多翻几页（含首页）', { default: 5 }),
      delay: P('number', '翻页后每轮探测等待毫秒', { default: 800 }),
      scroll: P('number', '改为「滚动加载」模式：滚几轮（每轮采一次，自动去重）'),
      step: P('number', '滚动模式下每轮滚动像素', { default: 700 }),
      dedupe: P('string', '按该字段去重；省略则按整行内容去重'),
      out: P('string', '写入文件（.json 或 .csv）'),
      'no-meta': P('flag', '去掉 _index 元字段'),
      compact: P('flag', '丢弃空字段'),
      tab: P('number', '标签页 id')
    },
    example: 'extract --selector ".item" --fields "title:h3, link:a@href" --paginate --next "a.next"',
    run: async (pos, opts) => {
      if (!opts.selector) fail('E_PARAM', '缺少 --selector', '例：--selector ".item"');
      if (!opts.fields) fail('E_PARAM', '缺少 --fields', '例：--fields "title:h3, link:a@href"');

      const meta = opts['no-meta'] !== true;
      const perPage = num(opts.limit, 50, 'limit');
      const grab = () => cmd('extract', {
        ...tabArgs(opts), selector: String(opts.selector), fields: String(opts.fields), limit: perPage, meta
      }, 90000);
      const grabRetry = async (tries = 3) => {
        let last;
        for (let i = 0; i < tries; i++) {
          try { return await grab(); } catch (e) { last = e; await sleep(400 + 400 * i); }
        }
        throw last;
      };
      const dump = (rows, data) => {
        if (!opts.out) return data;
        const f = String(opts.out);
        if (f.endsWith('.csv')) writeFileSync(f, toCsv(rows), 'utf8');
        else writeFileSync(f, JSON.stringify(rows, null, 2), 'utf8');
        data.file = f;
        data.fileBytes = Buffer.byteLength(JSON.stringify(rows));
        return data;
      };

      if (opts.paginate !== true && opts.scroll !== undefined && opts.scroll !== false) {
        // 无限滚动 / 虚拟列表：滚一段采一段，按整行内容去重，连续两轮没新行就停
        const rounds = Math.max(1, Math.min(60, num(opts.scroll === true ? 6 : opts.scroll, 6, 'scroll')));
        const seen = new Set();
        const all = [];
        const detail = [];
        let head = null;
        for (let i = 0; i < rounds; i++) {
          const r = await grabRetry();
          if (!head) head = r;
          let added = 0;
          for (const row of r.rows) {
            const k = JSON.stringify(row);
            if (seen.has(k)) continue;
            seen.add(k); all.push(row); added++;
          }
          detail.push({ round: i + 1, matched: r.count, added, url: r.url });
          if (i > 0 && added === 0) break;
          if (i < rounds - 1) {
            await cmd('scroll', { ...tabArgs(opts), dy: num(opts.step, 700, 'step') });
            await sleep(450);
          }
        }
        if (meta) all.forEach((row, i) => { row._index = i; });
        const rows = opts.compact === true ? compact(all) : all;
        return dump(rows, {
          url: head.url, title: head.title, fields: head.fields,
          mode: 'scroll', rounds: detail.length, pageDetail: detail,
          count: all.length, returned: rows.length, truncated: false, rows
        });
      }

      if (opts.paginate !== true) {
        const r = await grabRetry();
        const rows = opts.compact === true ? compact(r.rows) : r.rows;
        return dump(rows, {
          url: r.url, title: r.title, frame: r.frame,
          count: r.count, returned: r.returned, truncated: r.truncated,
          fields: r.fields, rows
        });
      }

      if (!opts.next) fail('E_PARAM', '--paginate 需要 --next <下一页控件选择器>', '例：--next "a.next"');
      const nextSel = String(opts.next);
      const maxPages = Math.max(1, num(opts['max-pages'], 5, 'max-pages'));
      const delay = Math.max(200, num(opts.delay, 800, 'delay'));
      const dedupeField = str(opts.dedupe) ?? null;

      const strip = (row) => { const o = { ...row }; delete o._index; return o; };
      const keyOf = (row) => (dedupeField ? String(row[dedupeField] ?? '') : JSON.stringify(strip(row)));
      const sigOf = (rows) => rows.slice(0, 3).map((r) => JSON.stringify(strip(r))).join('|');

      let cur = await grabRetry();
      const head = { url: cur.url, title: cur.title, fields: cur.fields };
      const pages = [];
      const seen = new Set();
      const all = [];
      let duplicates = 0;
      let stopReason = 'max-pages';

      for (let p = 1; ; p++) {
        let added = 0;
        for (const row of cur.rows) {
          const k = keyOf(row);
          if (seen.has(k)) { duplicates++; continue; }
          seen.add(k); all.push(row); added++;
        }
        pages.push({ page: p, url: cur.url, matched: cur.count, returned: cur.rows.length, added });
        if (p >= maxPages) { stopReason = 'max-pages'; break; }

        let el = null;
        try { el = await cmd('attr', { ...tabArgs(opts), selector: nextSel }); } catch { el = null; }
        if (!el) { stopReason = 'no-next'; break; }
        if (el.visible === false) { stopReason = 'next-hidden'; break; }
        if (el.enabled === false || (el.attrs && el.attrs['aria-disabled'] === 'true')) { stopReason = 'next-disabled'; break; }

        const beforeUrl = cur.url;
        const beforeSig = sigOf(cur.rows);
        try { await cmd('click', { ...tabArgs(opts), selector: nextSel, confirm: false }); }
        catch (e) {
          stopReason = 'click-failed';
          pages[pages.length - 1].note = String(e.message || e).slice(0, 120);
          break;
        }

        let nxt = null;
        const deadline = Date.now() + Math.max(6000, delay * 8);
        while (Date.now() < deadline) {
          await sleep(Math.max(250, Math.min(delay, 900)));
          try {
            const r = await grab();
            if (r.url !== beforeUrl || sigOf(r.rows) !== beforeSig) { nxt = r; break; }
          } catch { /* 导航中，继续等 */ }
        }
        if (!nxt) { stopReason = 'stalled'; break; }
        cur = nxt;
      }

      if (meta) all.forEach((row, i) => { row._index = i; });
      const rows = opts.compact === true ? compact(all) : all;
      const matched = pages.reduce((s, x) => s + x.matched, 0);
      return dump(rows, {
        url: head.url, title: head.title, fields: head.fields,
        pages: pages.length, pageDetail: pages,
        count: matched, collected: all.length, duplicates,
        returned: rows.length,
        truncated: pages.some((x) => x.matched > x.returned),
        stopReason, rows
      });
    }
  },

  table: {
    summary: 'HTML 表格 → 对象数组（自动识别表头，跨 iframe/shadow）',
    params: {
      selector: P('string', '表格选择器，省略取第一个 table'),
      index: P('number', '第几个表格，从 0 开始', { default: 0 }),
      limit: P('number', '最大行数', { default: 200 }),
      out: P('string', '写入 .json / .csv'),
      tab: P('number', '标签页 id')
    },
    example: 'table --selector "#prices" --out prices.csv',
    run: async (pos, opts) => {
      const r = await cmd('table', {
        ...tabArgs(opts),
        selector: str(opts.selector) ?? null,
        index: num(opts.index, 0, 'index'),
        limit: num(opts.limit, 200, 'limit')
      }, 90000);
      const data = {
        tablesFound: r.tablesFound, index: r.index, caption: r.caption ?? '',
        header: r.header, totalRows: r.totalRows, returned: r.returned, truncated: r.truncated, rows: r.rows
      };
      if (opts.out) {
        const f = String(opts.out);
        if (f.endsWith('.csv')) writeFileSync(f, toCsv(r.rows), 'utf8');
        else writeFileSync(f, JSON.stringify(r.rows, null, 2), 'utf8');
        data.file = f;
      }
      return data;
    }
  },

  state: {
    summary: '提取页面内嵌结构化数据：JSON-LD / __NEXT_DATA__ / __INITIAL_STATE__ / og:meta',
    params: { 'max-len': P('number', '每个来源最多字符数', { default: 6000 }), tab: P('number', '标签页 id') },
    example: 'state --max-len 3000',
    run: async (pos, opts) => cmd('state', { ...tabArgs(opts), maxLen: num(opts['max-len'], 6000, 'max-len') }, 45000)
  },

  assert: {
    summary: '断言页面状态（文本/值/属性/可见性/数量），让 AI 能自证操作成功',
    params: {
      selector: P('string', '目标选择器'),
      ref: P('number', '目标 ref'),
      text: P('string', '期望包含的文本'),
      value: P('string', '期望的输入值'),
      attr: P('string', '期望存在的属性名'),
      equals: P('string', '配合 --attr 的期望值'),
      count: P('number', '期望匹配数量'),
      visible: P('bool', '期望可见/不可见'),
      exact: P('flag', '文本精确匹配'),
      tab: P('number', '标签页 id')
    },
    example: 'assert --selector "#total" --text "¥120"',
    run: async (pos, opts) => {
      if (!opts.selector && opts.ref == null) fail('E_PARAM', 'assert 需要 --selector 或 --ref', '例：assert --selector "#total" --text "¥120"');
      const r = await cmd('assert', {
        ...tabArgs(opts),
        selector: str(opts.selector) ?? null,
        ref: positiveInt(opts.ref, 'ref'),
        text: str(opts.text),
        value: str(opts.value),
        attr: str(opts.attr),
        equals: str(opts.equals),
        count: opts.count === undefined ? undefined : num(opts.count, undefined, 'count'),
        visible: opts.visible === undefined ? undefined : bool(opts.visible),
        exact: opts.exact === true
      }, 30000);
      if (r.pass !== true) {
        const e = new Error(`断言失败（${r.kind || 'unknown'}）：实际 ${JSON.stringify(r.actual)}，期望 ${JSON.stringify(r.expected)}`);
        e.code = 'E_ASSERT';
        e.hint = '如果页面确实如此，说明前置操作没生效；否则放宽断言条件';
        e.data = r;
        throw e;
      }
      return r;
    }
  },

  console: {
    summary: '读控制台日志（含未捕获异常）',
    params: {
      level: P('string', '按级别过滤：log|warning|error|exception'),
      limit: P('number', '返回条数', { default: 100 }),
      clear: P('flag', '读完清空缓冲'),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => cmd('console', {
      ...tabArgs(opts),
      level: str(opts.level) ?? null,
      limit: num(opts.limit, 100, 'limit'),
      clear: opts.clear === true
    }, 45000)
  },

  net: {
    summary: '网络请求清单（方法/状态/大小/耗时/postData），只含挂载后发出的请求',
    params: {
      limit: P('number', '返回条数（最新在前）', { default: 30 }),
      filter: P('string', 'URL 关键词过滤'),
      type: P('string', '类型过滤：document|xhr|script|image|stylesheet|fetch'),
      errors: P('flag', '只看失败与 4xx/5xx'),
      clear: P('flag', '读前清空缓冲'),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => cmd('network', {
      ...tabArgs(opts),
      limit: num(opts.limit, 30, 'limit'),
      filter: str(opts.filter) ?? null,
      type: str(opts.type) ?? null,
      errors: opts.errors === true,
      clear: opts.clear === true
    }, 45000)
  },

  'net-body': {
    summary: '取某个请求的响应正文（requestId 来自 net）',
    params: {
      requestId: P('string', '请求 id', { required: true }),
      'max-len': P('number', '最大字符数', { default: 20000 }),
      out: P('string', '写入文件'),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      const requestId = pos[0] ?? str(opts.requestId);
      if (!requestId) fail('E_PARAM', '缺少 requestId', '先跑 net 拿 requestId');
      const r = await cmd('net-body', {
        ...tabArgs(opts), requestId, maxLen: num(opts['max-len'], 20000, 'max-len')
      }, 45000);
      if (opts.out) {
        const f = String(opts.out);
        if (r.base64) writeFileSync(f, Buffer.from(r.body, 'base64'));
        else writeFileSync(f, r.body, 'utf8');
        r.file = f;
        r.fileBytes = Buffer.byteLength(r.base64 ? Buffer.from(r.body, 'base64') : r.body);
      }
      return r;
    }
  },

  'net-intercept': {
    summary: '开启/关闭请求拦截（开启后可 mock/改包/延迟/中断）',
    params: { on: P('bool', '默认 true；--on false 关闭'), tab: P('number', '标签页 id') },
    run: async (pos, opts) => cmd('net-intercept', { ...tabArgs(opts), on: opts.on !== 'false' }, 45000)
  },

  'net-rule': {
    summary: '拦截规则：mock（返回假响应）/ abort（中断）/ delay（延迟）/ header（加头）',
    params: {
      add: P('string', '规则 JSON，如 \'{"pattern":"/api/user","action":"mock","status":200,"body":"{}"}\''),
      clear: P('flag', '清空全部规则')
    },
    example: 'net-rule --add \'{"pattern":"/api/user","action":"mock","status":200,"body":"{\\"ok\\":true}"}\'',
    run: async (pos, opts) => cmd('net-rule', { add: str(opts.add) ?? null, clear: opts.clear === true }, 30000)
  },

  'net-har': {
    summary: '把当前网络缓冲导出成 HAR 1.2（默认包含响应正文）',
    params: {
      out: P('string', '写入文件'),
      limit: P('number', '最多导出多少条', { default: 200 }),
      'no-bodies': P('flag', '不读取响应正文（更快）'),
      'max-body': P('number', '单条正文最大字符数', { default: 20000 }),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      const r = await cmd('net-har', {
        ...tabArgs(opts),
        limit: num(opts.limit, 200, 'limit'),
        bodies: opts['no-bodies'] !== true,
        maxBody: num(opts['max-body'], 20000, 'max-body')
      }, 90000);
      const meta = { entries: r.log.entries.length, bodiesIncluded: r.bodiesIncluded, bodiesFailed: r.bodiesFailed };
      if (opts.out) { writeFileSync(String(opts.out), JSON.stringify(r, null, 2), 'utf8'); return { ...meta, file: String(opts.out) }; }
      return { ...meta, log: r.log };
    }
  },

  perf: {
    summary: '性能指标 + Web Vitals（TTFB/FCP/LCP + CLS/INP/LongTask/LCP 元素归属 + 资源分布）',
    params: { all: P('flag', '返回全部 CDP 指标'), tab: P('number', '标签页 id') },
    run: async (pos, opts) => cmd('perf', { ...tabArgs(opts), all: opts.all === true }, 45000)
  },

  emulate: {
    summary: '环境模拟：设备尺寸/网络档/CPU 降速/暗色与减弱动效/时区/语言/地理；--reset 一次还原',
    params: {
      device: P('string', 'iphone|pixel|ipad|desktop 或 375x812'),
      network: P('string', 'offline|slow3g|fast3g|4g'),
      cpu: P('number', 'CPU 降速倍数（1=不降速）'),
      media: P('string', 'dark|light|reduced-motion，逗号组合'),
      timezone: P('string', '如 Asia/Tokyo'),
      locale: P('string', '如 ja-JP'),
      geo: P('string', '"纬度,经度"'),
      reset: P('flag', '清除全部模拟'),
      tab: P('number', '标签页 id')
    },
    example: 'emulate --device iphone --network slow3g --cpu 4 --media dark',
    run: async (pos, opts) => cmd('emulate', {
      ...tabArgs(opts),
      device: str(opts.device) ?? null,
      network: str(opts.network) ?? null,
      cpu: opts.cpu == null ? null : num(opts.cpu, 1, 'cpu'),
      media: str(opts.media) ?? null,
      timezone: str(opts.timezone) ?? null,
      locale: str(opts.locale) ?? null,
      geo: str(opts.geo) ?? null,
      reset: opts.reset === true
    }, 20000)
  },

  coverage: {
    summary: 'JS/CSS 覆盖率：start 后照常操作，再跑一次（或 --mode stop）拿未使用代码占比',
    params: {
      mode: P('string', 'start|stop|report', { default: 'report' }),
      top: P('number', '各返回多少个最没被用到的文件/表', { default: 8 }),
      tab: P('number', '标签页 id')
    },
    example: 'coverage --mode start   …操作…   coverage --mode stop',
    run: async (pos, opts) => cmd('coverage', {
      ...tabArgs(opts),
      mode: String(opts.mode ?? 'report'),
      top: num(opts.top, 8, 'top')
    }, 60000)
  },

  dialog: {
    summary: 'JS 弹窗策略与记录；默认 manual 只记录不处理（会阻塞页面）',
    params: {
      policy: P('string', 'accept|dismiss|manual'),
      clear: P('flag', '清空记录'),
      limit: P('number', '返回条数', { default: 20 }),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => cmd('dialog', {
      ...tabArgs(opts),
      policy: str(opts.policy) ?? null,
      clear: opts.clear === true,
      limit: num(opts.limit, 20, 'limit')
    }, 45000)
  },

  upload: {
    summary: '给文件输入框设置文件（绕过系统选择框）',
    params: {
      ref: P('number', '文件输入框的 SoM 编号'),
      selector: P('string', '文件输入框 CSS'),
      file: P('string', '单个文件路径'),
      files: P('string', '多个文件，逗号分隔'),
      tab: P('number', '标签页 id')
    },
    example: 'upload --selector "#file" --file D:\\a.pdf',
    run: async (pos, opts) => {
      const files = opts.files ? String(opts.files).split(',').map((s) => s.trim()).filter(Boolean)
        : (opts.file ? [String(opts.file)] : []);
      if (!files.length) fail('E_PARAM', '缺少文件', '用法: upload --ref N --file <路径>');
      return cmd('upload', {
        ...tabArgs(opts),
        ref: positiveInt(opts.ref, 'ref'),
        selector: str(opts.selector) ?? null,
        files
      }, 90000);
    }
  },

  wait: {
    summary: '等待条件成立：元素出现/消失、URL 变化、或页面出现某段文字',
    params: {
      selector: P('string', '等待的 CSS 选择器'),
      detach: P('flag', '改为等待元素消失'),
      url: P('string', '等待 URL 包含该片段'),
      text: P('string', '等待页面出现这段文字'),
      timeout: P('number', '超时 ms', { default: 15000 }),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      const timeout = num(opts.timeout, 15000, 'timeout');
      const r = await cmd('wait', {
        ...tabArgs(opts),
        selector: str(opts.selector) ?? null,
        mode: opts.detach === true ? 'detach' : 'attach',
        urlPart: str(opts.url) ?? null,
        text: str(opts.text) ?? null,
        timeoutMs: timeout
      }, timeout + 8000);
      if (!r.ok) fail('E_TIMEOUT', `等待超时（${r.elapsedMs}ms）：${opts.selector ?? opts.url ?? opts.text}`, '加大 --timeout，或先 snapshot 确认选择器');
      return r;
    }
  },

  'wait-idle': {
    summary: '等网络安静（在途请求归零并持续一段时间），比 wait-load 更适合 SPA',
    params: {
      timeout: P('number', '超时 ms', { default: 15000 }),
      'idle-ms': P('number', '需要持续安静多久', { default: 600 }),
      tab: P('number', '标签页 id')
    },
    example: 'wait-idle --timeout 20000',
    run: async (pos, opts) => cmd('wait-idle', {
      ...tabArgs(opts),
      timeoutMs: num(opts.timeout, 15000, 'timeout'),
      idleMs: num(opts['idle-ms'], 600, 'idle-ms')
    }, num(opts.timeout, 15000, 'timeout') + 8000)
  },

  session: {
    summary: '隔离会话：把 agent 的标签页收进独立 tab group，任务结束一键清理',
    params: {
      mode: P('string', 'open|list|close', { default: 'list' }),
      url: P('string', 'mode=open 时打开的地址'),
      wait: P('bool', '是否等加载完成，默认 true'),
      tab: P('number', '保留参数，兼容统一解析')
    },
    example: 'session --mode open --url https://example.com   →  session --mode close',
    run: async (pos, opts) => {
      const mode = String(opts.mode ?? (pos[0] || 'list'));
      return cmd('session', {
        mode,
        url: str(opts.url) ?? null,
        active: opts['tab-bg'] !== true,
        waitLoad: opts.wait !== 'false'
      }, 90000);
    }
  },

  cdp: {
    summary: 'CDP 直通（仅页面级域），用于排障或调用未封装的能力',
    params: {
      method: P('string', '如 Page.captureScreenshot', { required: true }),
      params: P('string', 'JSON 字符串参数'),
      'max-len': P('number', '返回结果最大字符数', { default: 4000 }),
      tab: P('number', '标签页 id')
    },
    run: async (pos, opts) => {
      const method = pos[0] ?? str(opts.method);
      if (!method) fail('E_PARAM', '缺少 method', '例: cdp Runtime.evaluate --params \'{"expression":"1+1"}\'');
      let params = {};
      if (opts.params) {
        try { params = JSON.parse(String(opts.params)); }
        catch { fail('E_PARAM', '--params 不是合法 JSON', '用单引号包裹 JSON，或写成文件后传入'); }
      }
      return cmd('cdp', {
        ...tabArgs(opts), method, params, maxLen: num(opts['max-len'], 4000, 'max-len')
      }, 60000);
    }
  },

  replay: {
    summary: '回放录制过的命令序列：一条命令跑完整流程，省 token 也省推理',
    params: {
      file: P('string', '录制文件（JSONL）', { required: true }),
      tab: P('number', '把所有步骤重定向到该标签页'),
      'stop-on-error': P('bool', '遇错即停，默认 true'),
      dry: P('flag', '只列出将要执行的步骤，不真的跑')
    },
    example: 'ARK_WEB_RECORD=flow.jsonl node client/browser-client.js ...（正常跑一遍）；之后 replay flow.jsonl --tab 12',
    run: async (pos, opts) => {
      const file = pos[0] ?? str(opts.file);
      if (!file) fail('E_PARAM', 'replay 需要录制文件', '先设置 ARK_WEB_RECORD=flow.jsonl 跑一遍流程');
      if (!existsSync(file)) fail('E_NOT_FOUND', `录制文件不存在：${file}`, '确认路径；录制开关是环境变量 ARK_WEB_RECORD');
      const lines = readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) fail('E_PARAM', '录制文件是空的', '确认 ARK_WEB_RECORD 指向的是本次录制的文件');
      const steps = [];
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!Array.isArray(rec.argv) || !rec.argv.length) continue;
        steps.push([...rec.argv]);
      }
      const out = [];
      for (const argv of steps) {
        // 指定了 --tab 就意味着「在这张标签上重跑这段流程」，
        // 因此录制里的 open 步骤应当跳过，否则会另开一张新标签，跑到别处去。
        if (opts.tab !== undefined && opts.tab !== true && argv[0] === 'open') {
          out.push({ step: argv.join(' '), skipped: 'open（已用 --tab 指定目标标签）' });
          continue;
        }
        if (opts.tab !== undefined && opts.tab !== true) {
          const i = argv.indexOf('--tab');
          if (i >= 0) argv.splice(i, 2);
          argv.push('--tab', String(opts.tab));
        }
        if (opts.dry === true) { out.push({ step: argv.join(' '), dry: true }); continue; }
        const name = argv[0];
        try {
          const { positional, opts: o } = parseArgs(argv.slice(1));
          await dispatch(name, { positional, opts: o }, { nested: true });
          out.push({ step: argv.join(' '), ok: true });
        } catch (e) {
          out.push({
            step: argv.join(' '), ok: false,
            error: { code: e.code ?? 'E_UNKNOWN', message: e.message, ...(e.hint ? { hint: e.hint } : {}) }
          });
          if (opts['stop-on-error'] !== 'false') break;
        }
      }
      return { steps: out.length, results: out };
    }
  },

  chain: {
    summary: '串联多条子命令；支持 {{steps.N.字段}} 取上一步结果与 --on-error continue，顶层 --tab 透传给每一步',
    params: {
      steps: P('string[]', '每条一个子命令字符串'),
      'on-error': P('string', 'stop（默认）| continue', { default: 'stop' })
    },
    example: 'chain "find --text 登录" "click --ref {{steps.0.items.0.ref}}" "wait --text 欢迎" --tab 12',
    run: async (pos, opts) => {
      const results = [];
      const onError = String(opts['on-error'] ?? 'stop');
      for (const rawStep of pos) {
        const ctx = { steps: results.map((r) => r.data), last: results.length ? results.at(-1).data : null };
        const step = interpolate(rawStep, ctx);
        const parts = tokenize(step);
        if (!parts.length) continue;
        const t0 = Date.now();
        try {
          const { positional: stepPos, opts: stepOpts } = parseArgs(parts.slice(1));
          // 顶层 --tab 透传：子命令自己没写 --tab 时继承，避免「chain 里 tab 被静默丢弃」
          if (stepOpts.tab === undefined && opts.tab !== undefined) stepOpts.tab = opts.tab;
          const out = await dispatch(parts[0], { positional: stepPos, opts: stepOpts }, { nested: true });
          results.push({ step, ok: true, ms: Date.now() - t0, data: out });
        } catch (e) {
          results.push({
            step, ok: false, ms: Date.now() - t0,
            error: {
              code: e.code ?? 'E_UNKNOWN', message: e.message,
              ...(e.hint ? { hint: e.hint } : {}),
              ...(e.retryable !== undefined ? { retryable: e.retryable } : {})
            }
          });
          if (onError !== 'continue') {
            // 中止但保留已完成的步骤，调用方才知道停在哪、已经发生了什么
            e.data = { steps: results.length, results };
            throw e;
          }
        }
      }
      return { steps: results.length, results };
    }
  },

  fanout: {
    summary: '在多个浏览器上并行执行同一条命令；默认全部浏览器',
    params: {
      cmd: P('string', '要执行的子命令（一条完整命令字符串）', { required: true }),
      ext: P('string', 'all | extId | 浏览器名（可逗号分隔），省略=全部'),
      timeout: P('number', '每个浏览器的超时 ms', { default: 180000 })
    },
    example: 'fanout "snapshot --limit 20 --no-shot" --ext chrome,edge',
    run: async (pos, opts) => {
      const raw = pos.join(' ').trim();
      if (!raw) fail('E_PARAM', 'fanout 需要一条子命令', '例：fanout "snapshot --limit 20 --no-shot"');
      const tokens = tokenize(raw);
      if (!tokens.length) fail('E_PARAM', 'fanout 子命令为空', '例：fanout "tabs"');
      if (tokens[0] === 'fanout') fail('E_PARAM', 'fanout 不能嵌套 fanout', '直接写目标子命令');
      if (tokens.includes('--ext') || tokens.includes('--conn')) fail('E_PARAM', 'fanout 的子命令不要再写 --ext/--conn', '把选择条件放在 fanout 外层');
      const exts = await resolveExts(opts.ext || opts.browser);
      const timeoutMs = Math.max(5000, num(opts.timeout, 180000, 'timeout'));
      const results = await Promise.all(exts.map(async (e) => {
        const r = await runSelfJson([...tokens, '--conn', e.conn], timeoutMs);
        return {
          extId: e.id, browser: e.browser,
          ok: !!r.ok, ...(r.ok ? { data: r.data } : { error: r.error })
        };
      }));
      return { cmd: tokens.join(' '), count: results.length, browsers: results };
    }
  },

  help: { summary: '帮助', params: {}, run: async () => ({ help: HELP }) }
};

// ── 输出层 ─────────────────────────────────────────────────────────────────
const JSON_MODE = () => process.env.ARK_WEB_JSON === '1' || global.__ARK_JSON__ === true;

const HUMAN = {
  status: (d) => `connected: ${d.connected}\nextensions: ${d.extensions.length}` +
    (d.whitelisted ? `\nwhitelisted: ${d.whitelisted}` : '\nwhitelisted: 0（未启用白名单）') + '\n' +
    d.extensions.map((e) => `  - ${e.browser || '?'} · ${e.name} v${e.version}${e.id ? '  id=' + e.id : ''}${e.conn ? '  conn=' + e.conn : ''}`).join('\n'),

  tabs: (d) => `共 ${d.count} 个标签页` + (d.browsers ? `（${d.browsers.length} 个浏览器）` : '') + '\n' + d.tabs.map((t) =>
    `  ${String(t.id).padStart(6)}  ${t.active ? '●' : ' '} ${String(t.browser || '?').padEnd(8)} ${String(t.title ?? '').slice(0, 40)}  ${t.url ?? ''}`).join('\n'),

  open: (d) => `tab=${d.id}  ${d.title ?? ''}  ${d.url ?? ''}${d.capturing ? '  [网络捕获中]' : ''}`,
  close: (d) => `已关闭 tab=${d.closed}`,
  activate: (d) => `已切到 tab=${d.id}  ${d.url ?? ''}`,
  info: (d) => `tab=${d.id}  ${d.status}\n${d.title}\n${d.url}\n视口 ${d.viewport?.w}×${d.viewport?.h} @${d.viewport?.dpr}${d.viewport?.hidden ? '（后台）' : ''}`,

  snapshot: (d) => {
    const head = [
      `URL  ${d.url}`, `标题 ${d.title}`,
      `元素 ${d.count} 个${d.truncated ? `（返回前 ${d.returned}）` : ''}${d.frames ? ` · ${d.frames.length} 个框架` : ''}`
    ];
    if (d.diff && d.diff.mode === 'delta') {
      head.push(`变化 +${d.diff.counts.added} -${d.diff.counts.removed} ~${d.diff.counts.changed}`);
    }
    const lines = d.elements.map((e) => {
      const ctx = e.context ? `  «${e.context}»` : '';
      const val = e.value ? `  = ${String(e.value).slice(0, 30)}` : '';
      const flag = e.disabled ? ' [禁用]' : (!e.inView ? ' [视口外]' : '');
      return `  [${String(e.ref).padStart(3)}] ${(e.role || e.tag).padEnd(10)} ${String(e.text || '').slice(0, 44)}${val}${ctx}${flag}`;
    });
    if (d.shot) lines.push(`截图 ${d.shot.file} (${d.shot.format}, ${d.shot.bytes} B)${d.shot.clip ? '  元素级' : ''}`);
    return head.concat(lines).join('\n');
  },

  find: (d) => `query="${d.query}"  共 ${d.total} 个匹配，返回 ${d.items.length} 个\n` +
    d.items.map((x) => {
      const state = x.clickable ? '✓可点' : '✗' + (x.coveredBy ? `被 ${x.coveredBy} 遮挡` : !x.enabled ? '禁用' : '不可见');
      return `  [${String(x.ref).padStart(3)}] ${(x.tag + '/' + x.role).padEnd(18)} ${state.padEnd(24)} ${String(x.score).padStart(4)}  ${String(x.text || '').slice(0, 40)}`;
    }).join('\n'),

  click: (d) => `已点击 ${d.tag}  via=${d.via}  等待 ${d.waitedMs}ms  ` +
    (d.navigated ? `跳转到 ${d.urlAfter}` : d.mutated ? 'DOM 已变化' : '无变化（no-effect）') +
    (d.openedTab ? `\n新标签 tab=${d.openedTab.id} ${d.openedTab.url}` : '') +
    (d.ref && d.via ? '' : ''),

  fill: (d) => d.chars == null
    ? `已处理 ${d.tag || '元素'}  via=${d.via}${d.mutated ? '  DOM 已变化' : d.settled === false ? '  无变化' : ''}`
    : `已填写 ${d.chars} 字符  via=${d.via}  校验=${d.verified ? '通过' : '未通过'}${d.masked ? '（密码值已脱敏）' : ''}\n当前值：${d.value}`,
  hover: (d) => `已悬停 via=${d.via}  :hover 命中 ${d.hoverActive ? '是' : '否'}${d.hoverActive ? '' : '（可能是纯 CSS 效果或元素无 hover 态）'}`,
  press: (d) => `已发送 ${d.key}${d.modifiers ? ` (modifiers=${d.modifiers})` : ''}` + (d.navigated ? `  跳转到 ${d.urlAfter}` : d.mutated ? '  DOM 已变化' : ''),

  select: (d) => d.mode === 'native'
    ? `已选择 ${d.picked.join(',')}（原生 select）`
    : `已选择「${d.picked.join(',')}」（自定义下拉）`,

  scroll: (d) => `滚动 ${d.before?.y} → ${d.after?.y}${d.max != null ? `（可滚动上限 ${d.max}）` : ''}`,

  text: (d) => `URL  ${d.url}\n标题 ${d.title}\n字数 ${d.chars}${d.truncated ? '（已截断）' : ''}\n---\n${d.text}`,

  extract: (d) => `匹配 ${d.count} 行，返回 ${d.returned} 行${d.truncated ? '（已截断）' : ''}\n` +
    d.rows.slice(0, 10).map((r, i) => `  ${i + 1}. ` + Object.entries(r).filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `${k}=${String(v).slice(0, 36)}`).join(' | ')).join('\n') +
    (d.rows.length > 10 ? `\n  … 另有 ${d.rows.length - 10} 行` : ''),

  table: (d) => `表头: ${d.header.join(' | ')}\n共 ${d.totalRows} 行，返回 ${d.returned} 行${d.truncated ? '（已截断）' : ''}\n` +
    d.rows.slice(0, 10).map((r) => '  ' + Object.values(r).join(' | ')).join('\n'),

  state: (d) => `内嵌数据源 ${d.found} 个${d.via ? `（${d.via}）` : ''}\n` + (d.sources || []).map((s) => `  ${String(s.kind).padEnd(24)} ${String(s.bytes).padStart(7)} B${s.truncated ? ' (截断)' : ''}`).join('\n') +
    (Object.keys(d.meta || {}).length ? `\nmeta: ${Object.keys(d.meta).join(', ')}` : ''),

  assert: (d) => `✓ 断言通过（${d.kind}）  实际 ${JSON.stringify(d.actual)}`,

  console: (d) => `缓冲 ${d.total} 条，返回 ${d.returned} 条\n` + d.items.map((it) =>
    `  ${new Date(it.at).toLocaleTimeString('zh-CN', { hour12: false })}  [${it.level}]  ${it.text}`).join('\n'),

  net: (d) => `共 ${d.total} 条，返回 ${d.returned} 条${d.intercepting ? '  [拦截中]' : ''}\n` + d.items.map((e) => {
    const st = e.failed ? 'ERR' : (e.status ?? '-');
    const sz = e.size > 1024 ? `${(e.size / 1024).toFixed(1)}K` : `${e.size ?? 0}B`;
    return `  ${String(st).padEnd(5)} ${String(e.method).padEnd(4)} ${String(e.type).padEnd(9)} ${sz.padStart(8)} ${String(e.ms ?? '-').padStart(6)}ms  ${e.url}`;
  }).join('\n'),

  'net-body': (d) => d.file
    ? `已写入 ${d.file}（${d.fileBytes ?? d.length} 字节）`
    : d.base64 ? `(base64，长度 ${d.length}；加 --out 可落盘)`
      : d.body,
  'net-intercept': (d) => d.intercepting ? '拦截已开启（记得用完关闭）' : '拦截已关闭',
  'net-rule': (d) => `规则 ${d.count} 条\n` + d.rules.map((r, i) => `  ${i + 1}. ${r.action}  ${r.pattern || '*'}${r.status ? ' → ' + r.status : ''}`).join('\n'),
  'net-har': (d) => `HAR 条目 ${d.entries} 条（正文 ${d.bodiesIncluded ?? 0}，失败 ${d.bodiesFailed ?? 0}）${d.file ? ` → ${d.file}` : ''}`,

  perf: (d) => {
    const m = d.metrics || {};
    const v = d.vitals || {};
    const kb = (x) => (x == null ? '-' : `${(x / 1024).toFixed(1)} MB`);
    const ms = (x) => (x == null ? '-' : `${Math.round(x)} ms`);
    return [
      `节点数 ${m.Nodes ?? '-'}   布局 ${m.LayoutCount ?? '-'} 次   重算样式 ${m.RecalcStyleCount ?? '-'} 次`,
      `JS 堆 ${kb(m.JSHeapUsedSize)} / ${kb(m.JSHeapTotalSize)}   脚本 ${ms((m.ScriptDuration || 0) * 1000)}`,
      `TTFB ${ms(v.ttfb)}   FCP ${ms(v.fcp)}   LCP ${ms(v.lcp)}   加载 ${ms(v.load)}`,
      `资源 ${v.resources?.total ?? '-'} 个 / ${kb(v.resources?.bytes)}`
    ].join('\n');
  },

  emulate: (d) => d.reset
    ? '已还原全部模拟'
    : '已应用：' + Object.entries(d.applied || {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  '),

  coverage: (d) => d.started
    ? '已开始采集（要在导航前 start 才能覆盖整页；已加载页面可先 eval "location.reload()"）'
    : [
      `JS  使用率 ${d.js.pct ?? '-'}%（${d.js.usedChars}/${d.js.totalChars} 字符，已跳过 ${d.js.skippedExtensionScripts || 0} 个扩展脚本）`,
      ...d.js.files.map((f) => `  ${String(f.pct).padStart(3)}%  未用 ${f.size - f.used} 字  ${f.url}`),
      `CSS 使用率 ${d.css.pct ?? '-'}%（${d.css.usedChars}/${d.css.totalChars} 字符）`
    ].join('\n'),

  dialog: (d) => `策略 ${d.policy}  记录 ${d.total} 条\n` + d.items.map((x) =>
    `  [${new Date(x.at).toLocaleTimeString()}] ${x.type}  ${x.message}  -> ${x.action}`).join('\n') + (d.note ? `\n${d.note}` : ''),

  upload: (d) => `已设置 ${d.requested} 个文件` + (d.input ? `\n输入框现有 ${d.input.count} 个: ${d.input.files.map((f) => f.name).join(', ')}` : '\n警告: 读不到 input.files'),

  wait: (d) => `✓ 命中（${d.elapsedMs}ms）${d.selector ? '  ' + d.selector : d.url ? '  ' + d.url : ''}`,
  'wait-idle': (d) => d.idle ? `✓ 网络安静（${d.waitedMs}ms）` : `✗ 仍有余量（在途 ${d.inflight}）`,

  session: (d) => d.closed !== undefined
    ? `已清理 ${d.closed} 个标签`
    : d.id != null
      ? `已加入会话 tab=${d.id}  ${d.title || ''}  ${d.url || ''}`
      : `会话内 ${d.count ?? 0} 个标签` + (d.tabs || []).map((t) => `\n  ${t.id}  ${t.url}`).join(''),

  attr: (d) => JSON.stringify(d, null, 2),
  shot: (d) => `已保存 ${d.file}（${d.bytes} B）` + (d.clip ? `  元素 ${Math.round(d.clip.width)}×${Math.round(d.clip.height)}` : '') + (d.focused ? '  [已聚焦]' : '') +
    (d.uniform ? '  [纯色帧]' : '') +
    (d.diff ? (d.diff.firstRun ? '\n差异：' + d.diff.note : `\n与上次相比：变化 ${d.diff.changedPct}%` + (d.diff.bbox ? `  区域 x${d.diff.bbox.x} y${d.diff.bbox.y} ${d.diff.bbox.w}×${d.diff.bbox.h}` : '')) : ''),
  eval: (d) => (d.value && typeof d.value === 'object' ? JSON.stringify(d.value, null, 2) : String(d.value)),
  cdp: (d) => typeof d.result === 'object' ? JSON.stringify(d.result, null, 2) : String(d.result),

  describe: (d) => d.commands
    ? `共 ${d.commands.length} 个命令\n` + d.commands.map((c) => `  ${c.name.padEnd(15)} ${c.summary}`).join('\n') + `\n\n用 describe <cmd> 看单个命令的参数。`
    : `${d.name}: ${d.summary}\n参数:\n` + Object.entries(d.params).map(([k, v]) =>
      `  --${k.padEnd(14)} ${String(v.type).padEnd(9)} ${v.desc}${v.required ? ' [必填]' : v.default !== undefined ? ` [默认 ${v.default}]` : ''}`).join('\n'),

  fanout: (d) => `并行 ${d.count} 个浏览器：${d.cmd}\n` + d.browsers.map((b) =>
    `  ${b.ok ? '✓' : '✗'} ${String(b.browser || '?').padEnd(8)} ${b.extId}${b.ok ? '' : '  → ' + (b.error?.code || '') + ' ' + (b.error?.message || '')}`).join('\n'),
  chain: (d) => d.results.map((r, i) => `  ${i + 1}. ✓ ${r.step}`).join('\n'),
  replay: (d) => `执行 ${d.steps} 步\n` + d.results.map((r, i) => {
    const err = r.error && typeof r.error === 'object' ? `${r.error.code || ''} ${r.error.message || ''}`.trim() : r.error;
    return `  ${i + 1}. ${r.skipped ? '↷' : (r.ok || r.dry ? '✓' : '✗')} ${r.step}${err ? '  → ' + err : ''}${r.skipped ? '  → ' + r.skipped : ''}`;
  }).join('\n'),

  help: (d) => d.help
};

// ── 分发 ───────────────────────────────────────────────────────────────────
async function dispatch(command, { positional, opts }, ctx = {}) {
  const spec = COMMANDS[command];
  if (!spec) fail('E_UNKNOWN_CMD', `没有命令 ${command}`, '跑 describe 看全部命令');
  if (!ctx.nested && opts.json === true) global.__ARK_JSON__ = true;
  const data = await spec.run(positional, opts);
  if (!ctx.nested) {
    if (JSON_MODE()) {
      const env = { ok: true, cmd: command, schemaVersion: 2, data };
      if (lastElapsedMs != null) env.elapsedMs = lastElapsedMs;
      process.stdout.write(JSON.stringify(env) + '\n');
    }
    else {
      const fmt = HUMAN[command];
      process.stdout.write((fmt ? fmt(data) : JSON.stringify(data, null, 2)) + '\n');
    }
  }
  return data;
}

const HELP = `Ark Web 浏览器 CLI v${VERSION}（加 --json 输出 envelope；describe 查看能力）

  连接与标签（多浏览器）
    status                              连接状态（浏览器 / 扩展 ID / 白名单）
    tabs                                聚合所有浏览器的标签（带 browser/extId）
    info | open <url> | close | activate 配合 --ext <id|chrome|edge> 使用
    session --mode open|list|close      隔离会话（可一键清理 agent 的标签）
    fanout "snapshot --limit 20"        在全部浏览器并行执行同一条命令

  观察（都跨 iframe 与 shadow DOM）
    snapshot [--limit 40] [--diff] [--in-view] [--shot]
                                        语义快照；默认只回结构（快），--shot 才截图并把编号烧进图里
    find --text "提交" [--role button]   语义定位（返回可点性、遮挡者、上下文）
    attr --ref N | --selector "…"       元素全量属性与语义上下文
    text [--max-len N] [--out f.md]     正文（Markdown 风格）
    state [--max-len N]                 内嵌数据（JSON-LD / __NEXT_DATA__ / __INITIAL_STATE__）
    assert --selector "#x" --text "…"   断言：text|value|attr|count|visible
    eval "<js>"                         在页面求值（等待 Promise）

  动作（全部走 CDP 真实输入）
    click --ref N | --selector "…"      点击：遮挡预检 + 效果确认 + 新标签追踪
    fill  --ref N --text "…" [--type]   填写：真实 insertText/逐字符，填完回读校验
    hover --ref N                       真实悬停（驱动 CSS :hover）
    press --key "Ctrl+Enter"            真实按键（含 Tab/Escape 默认行为）
    select --ref N --values "a,b"       原生 select 直选 / 自定义下拉点开选
    scroll --dy 600 | shot <file> [--selector "…"] | upload --file …
    dialog --policy accept|dismiss|manual

  数据采集
    extract --selector "…" --fields "…" 单页抽取
      [--paginate --next "a.next"]      翻页采集（跨页去重、自动判停）
      [--scroll 6 --step 700]           无限滚动/虚拟列表采集
    table [--selector table] [--out f.csv]
    net [--errors] [--filter kw]        网络清单（含 postData）
    net-body <id> | net-har --out h.har
    net-intercept [--on false]          请求拦截开关
    net-rule --add '{...}'              mock|abort|delay|header 规则
    perf                                节点/堆 + TTFB/FCP/LCP/CLS/INP/LongTask/资源分布
    console [--level error] [--clear]
    coverage --mode start|stop          JS/CSS 覆盖率（导航前 start 才能覆盖整页）
    emulate --device iphone --network slow3g --cpu 4 --media dark
      [--timezone Asia/Tokyo] [--locale ja-JP] [--geo 35.68,139.76] [--reset]

  组合与复用
    wait --selector "…" | --text "…" | --url "…" | --detach
                                        事件驱动（MutationObserver），不再轮询
    wait-idle                           等网络安静（SPA 更可靠）
    chain "cmd1" "cmd2" --tab N         串联；支持 {{steps.0.items.0.ref}} 取值与 --on-error continue
    replay flow.jsonl --tab N           回放录制流程（ARK_WEB_RECORD 录制）
    cdp <method> --params '{...}'       CDP 直通

多浏览器：tabs 默认聚合；任意命令加 --ext <extId|chrome|edge>、--browser <名字> 或 --conn <连接键> 指定目标；
         fanout "<命令>" 在所有浏览器并行执行。
环境变量：ARK_WEB_BASE / ARK_WEB_TOKEN / ARK_WEB_JSON=1 / ARK_WEB_RECORD=<文件>
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  if (command === '-h' || command === '--help') {
    process.stdout.write(HELP);
    return;
  }
  const { positional, opts } = parseArgs(argv.slice(1));
  // 录制：设置 ARK_WEB_RECORD=flow.jsonl 后，每条命令都会追加进去，供 replay 复用
  const rec = process.env.ARK_WEB_RECORD;
  if (rec && command !== 'replay') {
    try { appendFileSync(rec, JSON.stringify({ argv, at: Date.now() }) + '\n'); } catch { /* 忽略录制失败 */ }
  }
  try {
    if (opts.conn !== undefined && opts.conn !== true) {
      global.__ARK_EXT_SEL__ = { conn: String(opts.conn) };
    }
    // --ext 支持 extId / 浏览器名 / 逗号列表；单个命令必须唯一
    if (opts.ext !== undefined && opts.ext !== true && opts.ext !== 'all' && !['tabs', 'fanout'].includes(command)) {
      const picked = await resolveExts(opts.ext);
      if (picked.length !== 1) {
        fail('E_AMBIGUOUS_EXT', `--ext ${opts.ext} 匹配到多个浏览器`, `用 --conn 精确指定：${picked.map((e) => `${e.browser}@${e.conn}`).join(', ')}`);
      }
      global.__ARK_EXT_SEL__ = { extId: picked[0].id, conn: picked[0].conn };
    }
    if (opts.ext === 'all') global.__ARK_EXT__ = 'all';
    // --browser 既支持 top-level，也支持在没有任何 --ext 时自动解析
    if (!opts.ext && opts.conn === undefined && opts.browser !== undefined && opts.browser !== true && !['tabs', 'fanout'].includes(command)) {
      const byBrowser = await resolveExts(opts.browser);
      if (byBrowser.length !== 1) {
        fail('E_AMBIGUOUS_EXT', `--browser ${opts.browser} 匹配到多个扩展`, `用 --ext 精确指定：${byBrowser.map((e) => e.id).join(', ')}`);
      }
      global.__ARK_EXT_SEL__ = { extId: byBrowser[0].id, conn: byBrowser[0].conn };
    }
    // 多浏览器下，只有 tabId 没有 --ext 时自动找唯一所属浏览器
    if (opts.tab !== undefined && opts.tab !== true && !opts.ext && !opts.conn && !global.__ARK_EXT__ && !global.__ARK_EXT_SEL__) {
      await resolveExtForTab(positiveInt(opts.tab, 'tab'));
    }
    await dispatch(command, { positional, opts });
  } catch (e) {
    const payload = {
      ok: false,
      cmd: command,
      schemaVersion: 2,
      error: {
        code: e.code ?? 'E_UNKNOWN',
        message: e.message,
        ...(e.hint ? { hint: e.hint } : {}),
        ...(e.retryable !== undefined ? { retryable: e.retryable } : {}),
        ...(e.data ? { data: e.data } : {})
      },
      ...(lastElapsedMs != null ? { elapsedMs: lastElapsedMs } : {})
    };
    if (JSON_MODE()) process.stdout.write(JSON.stringify(payload) + '\n');
    else process.stderr.write(`错误：${e.message}${e.hint ? `\n提示：${e.hint}` : ''}\n`);
    process.exitCode = e.code === 'E_PARAM' ? 2 : 1;
  }
}

main();
