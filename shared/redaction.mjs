/**
 * 共享脱敏工具：Node CLI / bridge-server / 扩展运行时共用。
 * 目标是避免密码、Token、Cookie、请求体等敏感内容写入日志、回放或落盘副本。
 */

export const SENSITIVE_KEY = /^(text|value|file|files|filepath|path|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|proxyAuthorization|cookie|set-cookie|body|postdata|payload|expression|content|prompt|otp|api[_-]?key|client[_-]?secret|session[_-]?id|argv)$/i;
export const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token)$/i;

const MAX_STRING = 300;
const MAX_DEPTH = 6;

export function truncate(value, max = MAX_STRING) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}

/** 保留 URL 结构，隐藏 query 中的全部值。 */
export function redactUrl(value) {
  const s = String(value ?? '');
  try {
    const u = new URL(s);
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '«redacted»');
    return u.toString();
  } catch {
    return s.replace(/([?&][^=&#]+)=[^&#]*/g, '$1=«redacted»').slice(0, 500);
  }
}

/** 对任意文本做轻量级敏感键值脱敏；用于控制台/网络文本。 */
export function sanitizeText(value) {
  let s = String(value ?? '');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer «redacted»');
  s = s.replace(/((?:password|passwd|pwd|token|secret|authorization|cookie|api[-_]?key|otp|session[-_]?id)(?:["']?\s*[:=]\s*["']?))([^"'\s&,;}]+)/gi, '$1«redacted»');
  s = s.replace(/("(?:password|passwd|pwd|token|secret|authorization|cookie|api[-_]?key|otp|session[-_]?id)"\s*:\s*")[^"]*(")/gi, '$1«redacted»$2');
  return s;
}

function redactedFor(value) {
  if (typeof value === 'string') return `«redacted:${value.length}»`;
  if (Array.isArray(value)) return `«redacted:${value.length}»`;
  return '«redacted»';
}

/** 带键名的深度脱敏（保持普通结构）。 */
export function sanitizeValue(key, value, depth = 0) {
  if (value === undefined) return undefined;
  if (depth > MAX_DEPTH) return '«deep»';

  const k = String(key ?? '').toLowerCase();
  if (k === 'url' || k === 'href') return redactUrl(value);
  if (k === 'code') return truncate(sanitizeText(value), 200);
  if (SENSITIVE_KEY.test(k)) return redactedFor(value);

  if (Array.isArray(value)) return value.map((v) => sanitizeValue(null, v, depth + 1));
  if (value && typeof value === 'object') return sanitizeObject(value, depth + 1);
  if (typeof value === 'string') return truncate(sanitizeText(value));
  return value;
}

export function sanitizeObject(value, depth = 0) {
  if (!value || typeof value !== 'object') return sanitizeValue(null, value, depth);
  // HAR/header 数组常用 { name, value } 形式：按 header 名脱敏 value。
  if (!Array.isArray(value) && typeof value.name === 'string' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    if (SENSITIVE_HEADER.test(value.name.trim())) {
      return { ...value, value: redactedFor(value.value) };
    }
  }
  const out = Array.isArray(value) ? [] : {};
  for (const [key, v] of Object.entries(value)) {
    const next = sanitizeValue(key, v, depth);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

/** 生成可安全持久化的 net/console 记录：统一 URL、headers、正文和自由文本脱敏。 */
export function sanitizeForDisk(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = JSON.parse(JSON.stringify(value));
  const sanitized = sanitizeObject(copy, 0);
  // postData 已被 SENSITIVE_KEY 命中；这里仅补一个长文本提示，避免误以为是可回放原文。
  if (Object.prototype.hasOwnProperty.call(sanitized, 'postData') && typeof copy.postData === 'string') {
    sanitized.postData = `«redacted:${copy.postData.length}»`;
  }
  if (Object.prototype.hasOwnProperty.call(sanitized, 'text') && typeof copy.text === 'string') {
    sanitized.text = sanitizeText(copy.text);
  }
  return sanitized;
}

export function sanitizeArgs(args = {}, depth = 0) {
  if (!args || typeof args !== 'object') return args;
  return sanitizeObject(args, depth);
}

/** 生成可安全落盘的录制 argv：敏感参数值直接替换。 */
export function redactArgv(argv) {
  const sensitiveFlags = new Set([
    '--text', '--value', '--file', '--filename', '--body', '--postdata', '--expression',
    '--code', '--expression', '--params', '--add', '--url', '--query', '--prompt',
    '--password', '--token', '--secret', '--authorization', '--cookie'
  ]);
  const out = [];
  let redacted = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 2) {
      const flag = arg.slice(0, eq).toLowerCase();
      if (sensitiveFlags.has(flag)) {
        out.push(`${flag}=«redacted»`);
        redacted = true;
        continue;
      }
    }
    const lower = arg.toLowerCase();
    if (sensitiveFlags.has(lower)) {
      out.push(arg);
      if (i + 1 < argv.length) {
        out.push('«redacted»');
        i++;
        redacted = true;
      }
      continue;
    }
    // 命令行裸 URL 也可能带 token / session 参数，录制前统一脱敏 query 值。
    if (/[?&][^=&#\s]+=/.test(arg)) {
      out.push(redactUrl(arg));
      redacted = true;
      continue;
    }
    out.push(sanitizeText(arg));
  }
  return { argv: out, redacted };
}
