/**
 * ref 注册表
 *
 * ref 只存在于扩展侧，不写进页面 DOM——页面样式、框架 diff、outerHTML 都不受影响。
 * 每条记录带「指纹」（tag + 归一化文本），动作执行前比对；对不上就判 E_STALE_REF，
 * 而不是照着旧编号点下去。这是从「静默错点」手里夺回控制权的关键。
 *
 * 状态落在 chrome.storage.session：service worker 被回收后仍能恢复。
 */

const regs = new Map();   // tabId -> Map(ref -> entry)
const seqs = new Map();   // tabId -> number
const loaded = new Set();
const loading = new Map();
const dirty = new Set();
const MAX_REFS = 5000;
let flushTimer = null;

const REG_KEY = (tabId) => `ark:reg:${tabId}`;
const SEQ_KEY = (tabId) => `ark:seq:${tabId}`;

export function sigOf(tag, text) {
  return String(tag || '') + '|' + String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 60);
}

export async function ensureLoaded(tabId) {
  if (loaded.has(tabId)) return;
  if (loading.has(tabId)) return loading.get(tabId);
  const p = (async () => {
    try {
      const keys = [REG_KEY(tabId), SEQ_KEY(tabId)];
      const got = await chrome.storage.session.get(keys);
      const reg = got[REG_KEY(tabId)];
      if (reg && Array.isArray(reg)) regs.set(tabId, new Map(reg));
      else if (reg && typeof reg === 'object') regs.set(tabId, new Map(Object.entries(reg)));
      const seq = got[SEQ_KEY(tabId)];
      if (typeof seq === 'number') seqs.set(tabId, seq);
    } catch { /* storage 不可用时退化为纯内存 */ }
    loaded.add(tabId);
  })();
  loading.set(tabId, p);
  try { await p; } finally { loading.delete(tabId); }
}

export function get(tabId, ref) {
  const m = regs.get(tabId);
  return m ? m.get(Number(ref)) : undefined;
}

export function all(tabId) {
  return regs.get(tabId) || new Map();
}

export function setAll(tabId, map) {
  regs.set(tabId, map);
  loaded.add(tabId);
  markDirty(tabId);
}

/**
 * 增量合并：find / selector / select 只会补充本次看到的元素，不擦除之前的 ref。
 * 旧元素如果已被移除，probeRef 会返回 E_NOT_FOUND；导航时再整体 reset。
 */
export function merge(tabId, map) {
  const cur = regs.get(tabId) || new Map();
  for (const [k, v] of map) cur.set(k, v);
  if (cur.size > MAX_REFS) {
    const oldest = [...cur.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (let i = 0; i < oldest.length - MAX_REFS; i++) cur.delete(oldest[i][0]);
  }
  regs.set(tabId, cur);
  loaded.add(tabId);
  markDirty(tabId);
}

export function nextSeq(tabId) {
  return seqs.get(tabId) || 0;
}

export function bumpSeq(tabId, to) {
  const cur = seqs.get(tabId) || 0;
  if (to > cur) { seqs.set(tabId, to); markDirty(tabId); }
}

export function reset(tabId) {
  regs.delete(tabId);
  seqs.delete(tabId);
  loaded.delete(tabId);
  dirty.delete(tabId);
  try {
    chrome.storage.session.remove([REG_KEY(tabId), SEQ_KEY(tabId)]);
  } catch { /* 忽略 */ }
}

function markDirty(tabId) {
  dirty.add(tabId);
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 400);
}

async function flush() {
  flushTimer = null;
  const tabs = [...dirty];
  dirty.clear();
  for (const tabId of tabs) {
    try {
      const reg = regs.get(tabId);
      const payload = reg ? [...reg.entries()] : [];
      await chrome.storage.session.set({
        [REG_KEY(tabId)]: payload,
        [SEQ_KEY(tabId)]: seqs.get(tabId) || 0
      });
    } catch { /* 配额或权限问题，不影响内存态 */ }
  }
}

/**
 * 指纹校验。
 * 返回 null 表示通过；否则返回描述差异的字符串。
 */
export function checkDrift(entry, probe) {
  if (!entry) return 'no-entry';
  const wantTag = String(entry.tag || '').toLowerCase();
  const gotTag = String(probe.tag || '').toLowerCase();
  if (wantTag && gotTag && wantTag !== gotTag) return `tag ${wantTag} → ${gotTag}`;
  if (entry.role && probe.role && entry.role !== probe.role) return `role ${entry.role} → ${probe.role}`;
  if (entry.href && probe.href && entry.href !== probe.href) {
    return `href ${String(entry.href).slice(0, 60)} → ${String(probe.href).slice(0, 60)}`;
  }
  const want = sigOf(entry.tag, entry.text);
  const got = sigOf(probe.tag, probe.text);
  if (entry.sig && want === entry.sig && got !== entry.sig) {
    return `text "${String(entry.text || '').slice(0, 40)}" → "${String(probe.text || '').slice(0, 40)}"`;
  }
  return null;
}
