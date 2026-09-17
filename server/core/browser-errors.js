'use strict';
/**
 * 浏览器原始错误的翻译与分诊（服务端侧）
 *
 * 为什么要有第二份（第一份在扩展里）：错误有两条来源 ——
 *   ① 扩展通道（chrome.scripting / chrome.tabs 抛的错）
 *   ② 内核通道（自带 CDP 连接抛的错）
 * 只翻译其中一条，另一条就会把 "Cannot access a chrome-extension:// URL of different
 * extension" 这类英文原文丢给模型和用户，既看不懂也不知道下一步做什么（实测踩过）。
 * 这里按同一条规则统一翻译，两条通道都过一遍。
 */

const RULES = [
  { re: /Cannot access a chrome-extension:\/\/ URL of different extension/i,
    text: '目标页面是另一个扩展的页面，扩展无法在其上执行操作。',
    hint: '把工作页切到普通网页（http/https），或指定 tabId/url 指向要操作的页面。' },
  { re: /Cannot access contents of (the )?url "?(chrome|edge|about|devtools)[^"]*"?/i,
    text: '目标页面是浏览器内部页面（chrome:// 等），浏览器禁止扩展在此类页面上操作。',
    hint: '换到 http/https 页面。' },
  { re: /The extensions gallery cannot be scripted|chrome\.google\.com\/webstore/i,
    text: 'Chrome 应用商店页面禁止扩展操作。',
    hint: '换到 http/https 页面。' },
  { re: /No tab with id|Invalid tab ID|Invalid parameters/i,
    text: '目标标签页已关闭或参数无效。',
    hint: '先用 list_tabs 取当前可用标签页，再用返回的 id 重试。' },
  { re: /No target with given id|target.*closed/i,
    text: '目标标签页已关闭。',
    hint: '重新用 list_tabs / 打开页面后再试。' },
  { re: /Frame with ID .* was removed|No frame with given id/i,
    text: '目标 iframe 已被移除或重新加载。',
    hint: '重新定位元素后再试。' },
  { re: /Receiving end does not exist/i,
    text: '页面里的插件脚本未就绪（页面刚导航或插件刚重载）。',
    hint: '等待页面加载完成（wait_load）或刷新后重试。' },
  { re: /Cannot find context with specified id|Execution context was destroyed/i,
    text: '页面上下文已失效（导航或重载导致）。',
    hint: '重新读取页面后再操作。' },
  { re: /net::ERR_|NS_ERROR_|Failed to fetch/i,
    text: '网络层失败（资源不可达或连接被中断）。',
    hint: '确认目标地址可达，必要时重试。' }
];

/** 翻译成中文说明；未命中规则时原样返回 */
function translate(msg) {
  const s = String(msg == null ? '' : msg);
  if (!s) return s;
  for (const r of RULES) {
    if (r.re.test(s)) return r.text + '（原始信息: ' + s.slice(0, 160) + '）';
  }
  return s;
}

/** 配套的下一步建议；没有把握时返回 null（不硬凑） */
function hint(msg) {
  const s = String(msg == null ? '' : msg);
  for (const r of RULES) {
    if (r.re.test(s)) return r.hint;
  }
  return null;
}

/** 结果对象里的 message/error 字段就地翻译（工具返回值直通链路用） */
function translateResult(res) {
  if (!res || typeof res !== 'object') return res;
  const out = Object.assign({}, res);
  const raw = out.message || out.error;
  if (typeof raw === 'string' && raw) {
    const t = translate(raw);
    if (t !== raw) {
      out.message = t;
      const h = hint(raw);
      if (h) out.hint = h;
    }
  }
  return out;
}

module.exports = { translate, hint, translateResult, RULES };
