'use strict';
/**
 * 文件沙箱 —— agent 唯一的可读写区（默认 ~/.ark-web/workspace）
 *
 * 单独成模块的原因：沙箱规则必须只有一份。它原先只存在于工具层（read_file/write_file/list_dir），
 * 而"上传文件"走的是另一条路（CDP 的 DOM.setFileInputFiles 接受任意绝对路径），于是
 * agent 能把自己的令牌/密钥文件塞进页面再读回上下文 —— 沙箱形同虚设（已实测）。
 * 现在所有"接触本机文件"的入口都从这里判定。
 *
 * 判定采用"归一化到绝对路径再比对前缀"，并按入参形态区分三档，避免把 UNC、盘符、
 * 反斜杠、~、盘符相对路径（C:foo）当成沙箱内路径放过去。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FS_ROOT = path.join(os.homedir(), '.ark-web', 'workspace');

/** 明确越界的形态：UNC、设备路径、以及 Windows 的"盘符相对路径"（C:foo 不是绝对路径但会跳出） */
const SUSPECT_RE = /^(\\\\\\\\|[a-zA-Z]:[^\\/]|\\\\\?\\)/;

/**
 * 把入参解析为沙箱内的绝对路径；越界返回 null。
 *
 * 规则（精确，不做"静默重解释"）：
 *   · 相对路径（`notes/a.md`、`.spills/x.txt`）→ 解析到沙箱内，允许
 *   · 绝对路径 / UNC / `~/` / 盘符相对（`C:foo`）→ **只有本来就落在沙箱内才接受**，其余一律拒绝
 * 旧实现把绝对路径剥掉前缀后"塞回沙箱"（`C:/x/y` → `workspace/x/y`），
 * 后果是错误信息里出现 workspace\Users\... 这种看不懂的路径，排查成本极高。
 *
 * @param {string} p
 * @returns {string|null}
 */
function resolveSafe(p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) return FS_ROOT;

  // 盘符相对（C:foo）与 UNC 一律拒绝：它们在 Windows 上会跳出预期目录
  if (/^[a-zA-Z]:(?![\\/])/.test(raw) || /^[\\/]{2}/.test(raw) || /^\\\\/.test(raw)) return null;

  const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(raw) || /^[\\/]/.test(raw) || /^~\//.test(raw);
  if (looksAbsolute) {
    const expanded = raw.replace(/^~\//, os.homedir().replace(/\\/g, '/') + '/');
    const abs = path.resolve(expanded);
    return inside(abs) ? abs : null;
  }

  const abs = path.resolve(FS_ROOT, raw.replace(/\\/g, '/'));
  return inside(abs) ? abs : null;
}

/** 前缀判定（字符串层） */
function inside(abs) {
  const root = path.resolve(FS_ROOT);
  const norm = path.resolve(abs);
  return norm === root || norm.startsWith(root + path.sep);
}

/** 是否在沙箱内（对已存在的路径做真实路径校验，挡符号链接/目录联接逃逸） */
function isInsideReal(abs) {
  try {
    const realRoot = fs.realpathSync(FS_ROOT);
    // 目标不存在时向上找最近的存在祖先，再比对真实路径
    let probe = abs;
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(probe)) break;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = fs.realpathSync(probe);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch (e) {
    // 无法判定时保守拒绝（fail-closed）
    return false;
  }
}

/** 组合判定：字符串归一 + 真实路径（存在链接时也要拦住） */
function resolveInside(p) {
  try { fs.mkdirSync(FS_ROOT, { recursive: true }); } catch (e) { return null; }
  const abs = resolveSafe(p);
  if (!abs) return null;
  if (!isInsideReal(abs)) return null;
  return abs;
}

module.exports = { FS_ROOT, resolveSafe, isInsideReal, resolveInside };
