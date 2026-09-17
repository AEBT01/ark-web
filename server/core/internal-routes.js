'use strict';
/**
 * 内部端点（产品面）与技能接口（agent 面）的分界
 *
 * 为什么要单独一个模块：同一个服务里有两类端点，性质完全不同 ——
 *   · 技能接口：agent 干活用的浏览器能力（/tabs、/semantic/*、/evaluate …），
 *     它们出现在技能文档与工具清单里，是"技能契约"的一部分；
 *   · 内部端点：本机配置（模型密钥、预算、敏感名单、令牌轮换、自启状态），
 *     它们只该由**面板设置页与 CLI** 调用，agent 在任务中途不该碰 ——
 *     否则一个跑偏的任务可以顺手把自己的令牌轮换掉、把预算改成无限、或写入密钥。
 *
 * 分界靠"来源声明"而不是靠人记得：capabilities/*.js 里标了 internal: true 的模块，
 * 其全部路由自动进入内部名单；工具层的通用直通（ark_api）据此拒绝，
 * /capabilities 也带着这个标记输出，界面与自省脚本可以据此过滤。
 */

const caps = require('../capabilities');

/** 内部路由前缀（含精确路径） */
const PATHS = (() => {
  const out = [];
  for (const c of caps) {
    if (!c || !c.internal) continue;
    for (const r of Object.keys(c.routes || {})) out.push(r);
  }
  return out.sort();
})();

/**
 * 归一化到"路由看到的那个路径"，再做比对。
 *
 * 为什么必须归一化：判定发生在工具层（拿到的是模型给的原始字符串），而真正执行时
 * `new URL()` 会把点段与百分号编码解开。于是 `/./settings/token/rotate`、
 * `/x/../settings/token/rotate`、`/%2e/settings/token/rotate` 在判定处"不是内部端点"、
 * 到了路由却命中 —— agent 能借此轮换令牌并把明文读回上下文（实测已复现）。
 */
function normalize(p) {
  let path = String(p == null ? '' : p).split('?')[0].trim();
  if (!path.startsWith('/')) return path;
  try {
    // 用同样的 URL 解析规则归一（含 %2e 解码与点段折叠）
    path = new URL('http://x' + path).pathname;
  } catch (e) { /* 解析不了就按原样比对，宁可漏判由下面的兜底覆盖 */ }
  // 双保险：显式折叠一次点段（防某些实现对编码点段的处理差异）
  const parts = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

/** 该路径是否属于内部端点 */
function isInternal(p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw.startsWith('/')) return false;
  const path = normalize(raw);
  // 归一化后的路径与"原始路径中是否出现内部端点前缀"都算命中：
  // 后者用于挡住编码花招（例如 %2f 变体在归一化前后表现不一致的情况）
  if (path.startsWith('/settings') || raw.indexOf('settings') >= 0) {
    return PATHS.some(function (x) { return path === x || path.startsWith(x + '/') || raw.indexOf(x) >= 0; });
  }
  return PATHS.some((x) => path === x || path.startsWith(x + '/'));
}

/** 供报错信息与自省使用 */
function list() { return PATHS.slice(); }

module.exports = { isInternal, list, PATHS };
