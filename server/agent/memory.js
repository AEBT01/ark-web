/**
 * 记忆系统 —— 照搬 DeepSeek Harness 的 agent-instructions（AGENTS.md 家族）
 * （源码：packages/context/agent-instructions）
 *
 * 设计：
 *   · 两级：用户级 ~/.ark-web/AGENTS.md（最宽泛）→ 项目级 <skill仓>/AGENTS.md（更具体）
 *   · 注入顺序"从宽到具体"；**字节预算**：超预算先整体丢弃最宽泛的文件，
 *     仍超则对最具体的做二分截断，并写明截断量（DSH 的 render 语义）
 *   · 内容变化以 sha256 判定，不重发（由 loop 的目录/快照机制同理处理）
 *   · 用户可在面板或直接编辑文件更新记忆 —— 这是"跨会话偏好"的载体
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** 用户级记忆（全局） */
function userMemoryFile() {
  try { return path.join(os.homedir(), '.ark-web', 'AGENTS.md'); } catch (e) { return null; }
}
/** 项目级记忆（随 skill 仓库走） */
function projectMemoryFile() {
  return path.join(__dirname, '..', '..', 'AGENTS.md');
}

function readIfExists(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (e) { return null; }
}

/**
 * 收集记忆并按预算渲染。
 * @param {object} o { maxBytes?: number } 默认 16384
 * @returns {{ text: string, digest: string, files: string[], truncated: boolean }}
 */
function load(o) {
  const maxBytes = (o && o.maxBytes) || 16384;
  const files = [];
  const parts = [];
  // 从宽到具体
  [userMemoryFile(), projectMemoryFile()].forEach(function (file, idx) {
    if (!file) return;
    const text = readIfExists(file);
    if (!text || !text.trim()) return;
    files.push(file);
    parts.push({ file: file, label: idx === 0 ? '用户记忆（全局）' : '项目记忆', text: text });
  });
  if (!parts.length) return { text: '', digest: '', files: files, truncated: false };

  let truncated = false;
  let budget = maxBytes;
  const kept = [];
  const notes = [];
  // 先整文件丢弃（从最宽泛开始 —— 数组前面的是更宽泛的）
  for (let i = 0; i < parts.length; i++) {
    const size = Buffer.byteLength(parts[i].text, 'utf8');
    if (size > budget) {
      truncated = true;
      // 必须留痕：旧实现直接 continue，唯一那份记忆超预算时会被"静默忽略"——
      // 用户以为写进去的约定生效了，实际一个字都没进上下文（本机单文件场景必现）
      notes.push('[' + parts[i].label + '因超出预算被整体忽略：' + Math.round(size / 1024) + ' KB > 预算 '
        + Math.round(maxBytes / 1024) + ' KB；请精简该文件]');
      continue;
    }
    budget -= size;
    kept.push(parts[i]);
  }
  // 仍超预算则对最具体的（最后一个 kept）做二分截断
  if (truncated && kept.length) {
    const last = kept[kept.length - 1];
    const allowance = Math.max(0, maxBytes - kept.reduce(function (a, p) { return a + Buffer.byteLength(p.text, 'utf8'); }, 0) + Buffer.byteLength(last.text, 'utf8') - 400);
    if (Buffer.byteLength(last.text, 'utf8') > allowance) {
      // 按字节二分（保 UTF-8 边界：用 code point 估算再回切）
      let lo = 0, hi = last.text.length, best = 0;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (Buffer.byteLength(last.text.slice(0, mid), 'utf8') <= allowance) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      last.text = last.text.slice(0, best) + '\n\n[记忆因超出预算被截断：' + best + ' / ' + last.text.length + ' 字符]';
      truncated = true;
    }
  }

  const text = kept.length
    ? ['<memory>', '以下是用户与项目层面的长期记忆（用户的偏好与约定，优先遵守；与安全规则冲突时以安全规则为准）：', '',
      ...kept.map(function (p) { return '## ' + p.label + '\n' + p.text.trim(); }),
      ...notes.map(function (n) { return '\n' + n; }), '</memory>'].join('\n')
    // 全部被丢弃时也要把说明交给模型，否则"记忆为空"与"记忆被丢弃"无法区分
    : (notes.length ? notes.join('\n') : '');
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  return { text: text, digest: digest, files: files, truncated: truncated };
}

module.exports = { load: load, userMemoryFile: userMemoryFile, projectMemoryFile: projectMemoryFile };
