/**
 * 隐私策略 —— 敏感站点保护（用户早前明确提出、此前一直未落地的承诺）
 *
 * 规则：命中名单的站点，页面内容**绝不发送到云端**。
 *   · 不建语义索引（语义检索会把页面文本带给模型）
 *   · 工具层拒绝读取类调用（返回 privacy-blocked，让模型如实告知用户）
 *   · 运行时上下文快照里明示模型"该站点受保护"
 *
 * 名单来源（宽松覆盖用户级）：项目 config/sensitive-sites.json + ~/.ark-web/sensitive-sites.json
 * 三种匹配：精确域、后缀域（*.example.com）、正则。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_CONFIG = path.join(__dirname, '..', '..', 'config', 'sensitive-sites.json');
const USER_CONFIG = path.join(os.homedir(), '.ark-web', 'sensitive-sites.json');

/** 默认名单：用户当初点名要保护的类别 */
const DEFAULTS = {
  comment: '默认名单：银行/支付、邮箱、密码管理器、企业内网。可在 config/sensitive-sites.json 或 ~/.ark-web/sensitive-sites.json 调整。',
  domains: [
    // 银行 / 支付
    '**.bank', '**.bank.cn',
    'pay.weixin.qq.com', 'pay.weixin.qq.com', 'alipay.com', '**.alipay.com',
    'tenpay.com', '**.tenpay.com', 'pay.baidu.com', 'cashier.10086.cn',
    // 邮箱
    'mail.qq.com', 'mail.163.com', 'mail.126.com', 'mail.sina.com.cn', 'outlook.live.com',
    'mail.google.com', 'outlook.office.com', 'qiye.163.com', 'exmail.qq.com',
    // 密码管理器 / 身份
    'bitwarden.com', 'vault.bitwarden.com', '1password.com', 'my.1password.com',
    'password.qq.com', 'id.qq.com', 'accounts.google.com', 'login.live.com',
    // 企业内网常见形态（私有地址段由 ip 检查覆盖）
    '*.local', '*.lan', '*.internal', '*.corp', '*.intranet'
  ],
  ipPatterns: ['^10\\.', '^192\\.168\\.', '^172\\.(1[6-9]|2\\d|3[01])\\.', '^169\\.254\\.']
};

let cache = null;
let cacheAt = 0;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/** 合并三层名单（默认 → 项目 → 用户），5 秒缓存 */
function loadPolicy() {
  const now = Date.now();
  if (cache && now - cacheAt < 5000) return cache;
  const merged = { domains: DEFAULTS.domains.slice(), ipPatterns: DEFAULTS.ipPatterns.slice(), comment: DEFAULTS.comment };
  [PROJECT_CONFIG, USER_CONFIG].forEach(function (file) {
    const j = readJson(file);
    if (!j) return;
    if (Array.isArray(j.domains)) merged.domains = merged.domains.concat(j.domains);
    if (Array.isArray(j.ipPatterns)) merged.ipPatterns = merged.ipPatterns.concat(j.ipPatterns);
  });
  // 预编译：把 **.x.com / *.x.com 归一为后缀匹配；其余按精确/正则尝试
  const rules = merged.domains.map(function (raw) {
    const d = String(raw || '').toLowerCase();
    if (/^\/.+\/$/.test(d)) {
      try { return { kind: 'regex', re: new RegExp(d.slice(1, -1), 'i'), raw: raw }; } catch (e) { return null; }
    }
    const wildcard = d.startsWith('**.') || d.startsWith('*.');
    const base = wildcard ? d.replace(/^\*+\./, '') : d;
    return { kind: 'domain', base: base, subdomain: wildcard, raw: raw };
  }).filter(Boolean);
  const ipRes = merged.ipPatterns.map(function (p) {
    try { return new RegExp(p, 'i'); } catch (e) { return null; }
  }).filter(Boolean);
  cache = { rules: rules, ipRes: ipRes, raw: merged };
  cacheAt = now;
  return cache;
}

/** 判断一个 URL 是否命中敏感名单 */
function check(url) {
  let host = '';
  let isIp = false;
  try {
    const u = new URL(String(url || ''));
    host = (u.hostname || '').toLowerCase();
    isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  } catch (e) { return { matched: false, reason: 'invalid-url' }; }
  if (!host) return { matched: false };
  // 本机回环视为可信：这是 Ark 自己的服务与测试基建（127.0.0.1 上没有"别人的内网"）
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return { matched: false };

  const policy = loadPolicy();
  if (isIp) {
    for (const re of policy.ipRes) {
      if (re.test(host)) return { matched: true, site: host, rule: 'ip-pattern', reason: '内网/私有地址段' };
    }
    return { matched: false };
  }
  for (const r of policy.rules) {
    if (r.kind === 'regex') {
      if (r.re.test(host) || r.re.test(String(url))) return { matched: true, site: host, rule: r.raw };
      continue;
    }
    if (r.subdomain) {
      if (host === r.base || host.endsWith('.' + r.base)) return { matched: true, site: host, rule: r.raw };
    } else if (host === r.base) {
      return { matched: true, site: host, rule: r.raw };
    }
  }
  return { matched: false };
}

/** 当前名单（面板展示 / 自省用） */
function summary() {
  const p = loadPolicy();
  return { domains: p.raw.domains, ipPatterns: p.raw.ipPatterns, comment: p.raw.comment, sources: [PROJECT_CONFIG, USER_CONFIG] };
}

module.exports = { check: check, summary: summary, DEFAULTS: DEFAULTS };
