/**
 * 设置能力 —— 让"配置"不用再靠改文件
 *
 * 之前的形态：模型密钥写在 ~/.ark-web/deepseek.key、名单写在 config/*.json、
 * 预算根本不存在，令牌硬编码在面板源码里。结果是产品跑得起来但没人能自己配。
 *
 * 本模块把这些配置收拢成一组带鉴权的端点，面板设置页与 CLI 都调它：
 *   GET  /settings                当前配置全貌（密钥只回打码提示，绝不回原文）
 *   POST /settings/api-key        写入模型密钥（写到 ~/.ark-web/deepseek.key）
 *   POST /settings/limits         预算上限与单价
 *   GET  /settings/sites          敏感站点名单（内置 + 项目 + 用户三层）
 *   POST /settings/sites          增删名单条目
 *   POST /settings/sites/test     用一条 URL 试名单命中
 *   POST /settings/token/rotate   轮换访问令牌（返回一次新令牌）
 *   GET  /settings/preflight      首次运行自检：把"能不能用"拆成可执行检查项
 *
 * 安全约定：所有端点都走 HTTP 外壳的令牌校验；密钥读取只返回打码形式；
 * 令牌轮换会把新令牌同时写回令牌文件，CLI 与同步脚本会自动跟上。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const limits = require('../core/limits');
const privacy = require('../agent/privacy');

const KEY_FILE = path.join(os.homedir(), '.ark-web', 'deepseek.key');
const USER_SITES = path.join(os.homedir(), '.ark-web', 'sensitive-sites.json');
const PROJECT_SITES = path.join(__dirname, '..', '..', 'config', 'sensitive-sites.json');
const TOKEN_FILE = path.join(os.homedir(), '.ark-web', 'token');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function maskKey(k) {
  const s = String(k || '').trim();
  if (!s) return null;
  if (s.length <= 8) return s[0] + '***';
  return s.slice(0, 4) + '…' + s.slice(-4) + '（长度 ' + s.length + '）';
}

function currentKey() {
  if (process.env.DEEPSEEK_API_KEY) return { source: 'env', key: process.env.DEEPSEEK_API_KEY };
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (k) return { source: 'file', key: k };
  } catch (e) { /* 未配置 */ }
  return { source: null, key: '' };
}

/** 开机自启状态（Windows 查「启动」文件夹里的启动项；其他平台给出指引） */
function autostartState() {
  const cmd = 'node ' + path.join(__dirname, '..', '..', 'scripts', 'install-autostart.js') + ' --yes';
  if (process.platform !== 'win32') {
    return { supported: false, installed: false, howTo: '非 Windows 平台：请用 systemd/launchd 自启，运行 ' + cmd + ' 可看到最小示例' };
  }
  const entry = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Ark Web 服务.vbs');
  const installed = fs.existsSync(entry);
  return {
    supported: true,
    installed,
    file: entry,
    howTo: installed ? '已随登录自启（隐藏窗口，日志写入 ~/.ark-web/server.log）' : '运行 ' + cmd + ' 安装自启'
  };
}

module.exports = {
  name: 'settings',
  group: 'settings',
  // internal: 这是产品面（本机配置），不是 agent 的浏览器能力。
  // 标记后：ark_api 之类的通用直通工具会拒绝调用，/capabilities 也会带标记输出，
  // 由面板设置页与 CLI 调用（见 server/core/internal-routes.js）。
  internal: true,
  doc: '配置读写（模型密钥 / 预算 / 敏感名单 / 令牌轮换 / 首启自检）',

  routes: {
    '/settings': async function (__ark) {
      const srv = __ark.server;
      const k = currentKey();
      const pol = privacy.summary();
      return {
        version: require('../version').read(),
        node: process.version,
        server: {
          http: 'http://127.0.0.1:' + srv.port,
          ws: 'ws://127.0.0.1:' + srv.wsPort,
          tokenFile: TOKEN_FILE,
          tokenRequired: srv.authSource !== 'disabled',
          wsTokenRequired: !!srv.wsTokenRequired
        },
        model: {
          provider: 'deepseek',
          base: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
          configured: !!k.key,
          source: k.source,
          keyHint: maskKey(k.key),
          keyFile: KEY_FILE
        },
        budget: limits.status(),
        privacy: {
          domainCount: pol.domains.length,
          ipPatternCount: pol.ipPatterns.length,
          sources: pol.sources
        },
        // 自启状态：面板读不到文件系统，由服务端代查（Windows 的「启动」文件夹 / 非 Windows 给指引）
        autostart: autostartState(),
        browsers: [...srv.clients.values()].map(i => ({ label: i.label || i.browser, version: i.version, browser: i.browser }))
      };
    },

    '/settings/api-key': async function (__ark) {
      const body = (await __ark.body({})) || {};
      const key = String(body.key || '').trim();
      if (!key) return { ok: false, error: 'key 不能为空' };
      if (key.length < 16 || /\s/.test(key)) return { ok: false, error: '密钥格式可疑（长度应大于 16 且不含空白字符）' };
      if (process.env.DEEPSEEK_API_KEY) {
        return { ok: false, error: '当前环境变量 DEEPSEEK_API_KEY 优先于文件，写入文件不会生效。请先清掉该环境变量。' };
      }
      fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
      fs.writeFileSync(KEY_FILE, key + '\n', { encoding: 'utf8', mode: 0o600 });
      try { require('../brain').resetKeyCache && require('../brain').resetKeyCache(); } catch (e) { /* 无缓存则忽略 */ }
      return { ok: true, keyHint: maskKey(key), file: KEY_FILE, note: '已写入并立即生效（无需重启服务）' };
    },

    '/settings/limits': async function (__ark) {
      const body = (await __ark.body({})) || {};
      const patch = {};
      const numOrNull = (v) => (v === null || v === '' || v === undefined) ? null : (Number.isFinite(+v) ? +v : undefined);
      for (const k of ['taskMaxTokens', 'dailyMaxTokens', 'taskMaxCost', 'dailyMaxCost', 'promptPricePerM', 'completionPricePerM']) {
        if (body[k] !== undefined) {
          const n = numOrNull(body[k]);
          if (n === undefined) return { ok: false, error: k + ' 必须是数字或 null' };
          if (n !== null && n < 0) return { ok: false, error: k + ' 不能为负' };
          patch[k] = n;
        }
      }
      if (body.currency !== undefined) patch.currency = String(body.currency);
      if (!Object.keys(patch).length) return { ok: false, error: '没有可更新的字段' };
      const next = limits.saveLimits(patch);
      return { ok: true, limits: next, priced: limits.priced(next), file: limits.LIMITS_FILE };
    },

    '/settings/sites': async function (__ark) {
      if (__ark.req.method === 'GET') {
        const pol = privacy.summary();
        return {
          domains: pol.domains,
          ipPatterns: pol.ipPatterns,
          builtinCount: (privacy.DEFAULTS.domains || []).length,
          userFile: USER_SITES,
          projectFile: PROJECT_SITES
        };
      }
      const body = (await __ark.body({})) || {};
      const add = Array.isArray(body.add) ? body.add.map(String) : [];
      const remove = Array.isArray(body.remove) ? body.remove.map(String) : [];
      if (!add.length && !remove.length) return { ok: false, error: '需要 add 或 remove 数组' };
      const cur = readJsonSafe(USER_SITES) || { comment: '用户级敏感站点名单（叠加在内置与项目名单之上）', domains: [] };
      let list = Array.isArray(cur.domains) ? cur.domains.slice() : [];
      for (const d of add) if (!list.includes(d)) list.push(d);
      if (remove.length) list = list.filter((d) => !remove.includes(d));
      fs.mkdirSync(path.dirname(USER_SITES), { recursive: true });
      fs.writeFileSync(USER_SITES, JSON.stringify(Object.assign({}, cur, { domains: list }), null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      const pol = privacy.summary();
      return { ok: true, userDomains: list, effectiveCount: pol.domains.length, file: USER_SITES };
    },

    '/settings/sites/test': async function (__ark) {
      const body = (await __ark.body({})) || {};
      const url = String(body.url || '').trim();
      if (!url) return { ok: false, error: 'url 不能为空' };
      return { ok: true, url: url, verdict: privacy.check(url) };
    },

    '/settings/token/rotate': async function (__ark) {
      const crypto = require('crypto');
      const next = crypto.randomBytes(24).toString('hex');
      fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
      fs.writeFileSync(TOKEN_FILE, next + '\n', { encoding: 'utf8', mode: 0o600 });
      const srv = __ark.server;
      if (srv) {
        srv.authToken = next;
        srv.wsExpectedToken = next;
      }
      const sync = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'sync-panel.js'), '--yes'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
      return {
        ok: true,
        token: next,
        tokenFile: TOKEN_FILE,
        panelSync: sync.status === 0 ? '面板副本已同步新令牌' : '面板同步失败：' + String(sync.stderr || '').slice(0, 200),
        note: 'CLI 会自动读取令牌文件；其他已保存令牌的调用方需要更新。此令牌只在此处返回一次。'
      };
    },

    /** 首次运行自检：把"能不能用"拆成可执行检查项，而不是让用户对着空白界面猜 */
    '/settings/preflight': async function (__ark) {
      const srv = __ark.server;
      const k = currentKey();
      const out = [];
      const add = (id, ok, label, hint, extra) => out.push(Object.assign({ id, ok, label, hint: ok ? null : hint }, extra || {}));

      add('server', true, '服务端在运行', null, { http: 'http://127.0.0.1:' + srv.port });

      // "已连接"按最近是否真的说过话算 —— 浏览器被强杀后 socket 可能还挂着，
      // 只看 clients.size 会得到"一切正常但命令全超时"的假象（实测）。
      const live = typeof srv.liveClients === 'function' ? srv.liveClients() : [...srv.clients.values()];
      const ext = live.length > 0;
      add('plugin', ext, '浏览器插件已连接',
        '打开浏览器 → 扩展管理页 → 确认「Ark Web」已加载且未被停用；再点插件图标看 popup 是否显示「已连接」',
        { browsers: live.map(i => i.label || i.browser), staleSockets: srv.clients.size - live.length });

      // 插件代码是否与磁盘一致：--load-extension 启动时浏览器会缓存服务工作线程脚本，
      // 于是"改了代码、重启了浏览器，跑的仍是旧脚本"。这类问题排查成本极高，必须自己报出来。
      if (ext) {
        const staleConns = [...srv.clients.values()].filter((i) => i.stale);
        add('plugin-build', staleConns.length === 0, '插件代码与磁盘一致',
          '浏览器里跑的是缓存的旧脚本。处理：关闭该浏览器 → 删除其 profile 下的 "Service Worker" 目录 → 重新启动'
            + '（或在扩展管理页重载该扩展）。否则改过的扩展代码不会生效。',
          { stale: staleConns.map((i) => (i.label || i.browser) + ' ' + (i.build || '?')) });
      }

      add('model-key', !!k.key, '模型密钥已配置',
        '在设置页填入 DeepSeek 密钥（或运行：node client/browser-client.js set-key <你的密钥>）',
        { source: k.source });

      // 内核（CDP 直连）：不强求，但影响"严格 CSP 站点"与"后台标签页"的能力。
      // 必须真去探测（probe 会 fetch /json/version）—— 早期写成"内核对象存在即通过"，
      // 于是 BrowserOS 没启动时也报"可用"，属于假绿。
      let kernel = { ok: false, reason: '未初始化' };
      try {
        if (srv.cdp && typeof srv.cdp.probe === 'function') kernel = await srv.cdp.probe();
        else if (srv.cdp) kernel = { ok: false, reason: '内核对象无 probe 方法' };
      } catch (e) { kernel = { ok: false, reason: String((e && e.message) || e) }; }
      add('kernel', !!kernel.ok, 'CDP 直连内核可用',
        '启动 BrowserOS 后重试 —— 它自带 9110 调试端口（其 Rust sidecar 就在用），无需额外参数。'
          + '不启用也能用：语义提取会走扩展的注入通道，只是后台标签页与截图会慢一些。',
        { optional: true, detail: kernel.ok ? (kernel.browser || 'ok') : (kernel.error || kernel.reason || 'unreachable') });

      const b = limits.check({});
      // label 用中性名称：面板会把"不通过的检查项"的 label 直接当提示条标题，
      // 若写成正向措辞（"预算未超限"）就会出现"标题说没问题、内容说已超限"的矛盾（实测）。
      add('budget', b.ok, '预算额度', b.message || '已超出当前预算上限', { optional: false });

      const day = limits.summaryOfDay();
      return {
        ok: out.every((x) => x.ok || x.optional),
        checks: out,
        usage: day,
        version: require('../version').read()
      };
    }
  }
};
