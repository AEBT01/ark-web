/**
 * 上下文管理 —— 照搬 DeepSeek Harness 的四层设计
 * （源码：packages/compaction/compaction-tool-result-pruner、compaction/compaction-basic、
 *        packages/spill/spill-policy、packages/llm/llm-retry）
 *
 * 四层，从便宜到贵：
 *   1. 确定性裁剪（无模型调用）：超长工具结果保留头/尾、中段替换标记，按 Unicode code point 切
 *   2. 可寻址截断（spill）：完整结果落私有文件，上下文只留预览 + locator + 取回提示
 *   3. 结构化检查点压缩（模型调用）：达窗口阈值触发，保留最近尾部，绝不劈开 tool 配对
 *   4. 强制压缩：provider 明确报超窗时绕过阈值压一次再重试
 *
 * 为什么按这个顺序：1/2 几乎零成本且 replay-safe，能避免绝大多数不必要的 3；
 * 3 有模型调用成本，只在真正压力下发生。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ══════════════ 层一：确定性工具结果裁剪 ══════════════
   预算与 DSH 默认一致：threshold 8192 / head 4096 / tail 1024 */

const PRUNER = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
// 默认标记用于"裁掉且取不回"的场合：**不能提 spill**，否则模型会去找一个不存在的文件
// （曾经两处共用一句"完整内容见下方 spill 提示"，而 8193–12288 字符区间结果既不落盘、又被裁剪）
const PRUNE_MARK = '\n\n[... 中段已裁剪，原始 {n} 字符，该结果未落盘、无法取回 ...]\n\n';
// 落盘前的预览环节才用它（此时确实有 locator 可取）
const PRUNE_MARK_SPILLED = '\n\n[... 中段已省略，完整内容见下方存储位置 ...]\n\n';

/** 按 Unicode code point 切（避免劈开代理对，如 emoji） */
function sliceByCodePoints(str, start, end) {
  const arr = Array.from(str);
  return arr.slice(start, end).join('');
}
function codePointLength(str) { return Array.from(str).length; }

/**
 * 确定性裁剪一个字符串。
 * @returns {{ text: string, pruned: boolean, originalChars: number }}
 */
function pruneText(text, opts) {
  const o = Object.assign({}, PRUNER, opts || {});
  const s = String(text == null ? '' : text);
  const len = codePointLength(s);
  if (len <= o.thresholdChars) return { text: s, pruned: false, originalChars: len };
  const head = sliceByCodePoints(s, 0, o.headChars);
  const tail = sliceByCodePoints(s, len - o.tailChars, len);
  const mark = (o.mark || PRUNE_MARK).replace('{n}', String(len));
  return {
    text: head + mark + tail,
    pruned: true,
    originalChars: len
  };
}

/* ══════════════ 层二：可寻址截断（spill）══════════════ */

// 关键：spill 必须落在 agent 能读到的沙箱里（见 core/paths.js 的说明）。
// 曾落在 ~/.ark-web/spills，导致提示模型"用 read_file 取回"是一句空话 —— 实测取不回。
const { SPILL_DIR, WORKSPACE_DIR } = require('../core/paths');
/** 内联阈值：超过才落文件（预留提示文本的空间） */
const SPILL_THRESHOLD_BYTES = 12 * 1024;
const SPILL_PREVIEW_CHARS = 1600;

function ensureSpillDir() {
  try { fs.mkdirSync(SPILL_DIR, { recursive: true, mode: 0o700 }); } catch (e) { /* ignore */ }
  return SPILL_DIR;
}

/**
 * 把超长结果落盘，返回"预览 + locator + 取回提示"的替换文本。
 * 失败是 best-effort：落盘失败时退回纯确定性裁剪（绝不把成功调用变成报错）。
 * @returns {{ text: string, spilled: boolean, locator?: string, bytes?: number }}
 */
function spill(text, label) {
  const s = String(text == null ? '' : text);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= SPILL_THRESHOLD_BYTES) return { text: s, spilled: false, bytes: bytes };

  let locator = null;
  try {
    ensureSpillDir();
    const name = 'spill-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.txt';
    const file = path.join(ensureSpillDir(), name);
    fs.writeFileSync(file, s, { mode: 0o600 });
    // locator 用"沙箱内相对路径"：它既是 read_file 能直接用的入参，也不会把本机绝对路径写进上下文
    locator = path.posix.join('.spills', name);
  } catch (e) {
    // 落盘失败：退回确定性裁剪
    const pr = pruneText(s);
    return { text: pr.text, spilled: false, bytes: bytes };
  }

  const preview = pruneText(s, { thresholdChars: SPILL_PREVIEW_CHARS + 1024, headChars: SPILL_PREVIEW_CHARS, tailChars: 600 });
  const hint = '如需完整内容，用 read_file 读取该路径（不要凭预览下结论）。';
  return {
    text: preview.text + '\n\n[完整结果已存盘: ' + locator + ' | ' + bytes + ' 字节。' + hint + ']',
    spilled: true,
    locator: locator,
    bytes: bytes
  };
}

/* ══════════════ 层三/四：结构化检查点压缩 ══════════════ */

/**
 * token 估算：按字符类加权。
 *
 * 旧实现用 length/2.4，对中文是**低估**（DeepSeek 上中文约 0.6 token/字 ≈ 1.7 字符/token），
 * 于是 0.8 的阈值在中文页面上实际已接近甚至超过真实窗口 —— 只能靠层四兜底。
 * 现在 CJK 与其余字符分开算，并把 tools 定义也计入总量，宁可早压不可超窗。
 */
function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  let cjk = 0, other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)
      || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.62 + other / 3.6);
}

/** 估算整段消息（含 tool_calls 等结构开销）的 token 量 */
function estimateMessages(messages, tools) {
  let n = 0;
  for (const m of (messages || [])) n += estimateTokens(JSON.stringify(m)) + 4;   // 每条消息的固定开销
  if (tools && tools.length) n += estimateTokens(JSON.stringify(tools));          // 工具定义同样占窗口
  return n;
}

/** 压缩指令（照搬 DSH 的 COMPACTION_INSTRUCTION，模板小节保持结构不变） */
const COMPACTION_INSTRUCTION = [
  '你现在充当本 AI 助手的压缩引擎。把上方的对话浓缩成一份结构化检查点，让另一个模型能在不丢失关键上下文的前提下继续这项工作。',
  '',
  '严格按下面的 Markdown 结构输出：保留每个小节、顺序不变。用简短的条目，不要写成段落。空的小节写"(无)"——绝不能省略小节。',
  '',
  '## Primary Request and Intent',
  '- [用户的原始目标与演进目标；措辞重要时逐字引用]',
  '',
  '## Key Technical Concepts',
  '- [涉及的技术、站点、页面结构、约定]',
  '',
  '## Files and Code',
  '- [精确的 URL / 选择器 / 单元 id：它是什么、状态如何、关键片段]',
  '',
  '## Errors and Fixes',
  '- [错误：如何解决的，以及用户的反馈与纠正]',
  '',
  '## Pending Jobs',
  '- [已明确要做但尚未完成的事]',
  '',
  '## Current Work',
  '- [检查点时刻正在做什么，精确描述]',
  '',
  '## Next Step',
  '- [下一个动作，直接对齐最近一次请求；没有就写"(无)"]',
  '',
  '## Critical Context',
  '- [决定及其理由、约束、用户偏好、悬而未决的问题、继续工作所需的数据]',
  '',
  '规则：',
  '- 用简体中文工程记叙，但**逐字保留**精确的 URL、命令、报错原文、标识符、数值、选择器、函数签名。',
  '- 忠实记录用户的反馈与明确指示，尤其是纠正。',
  '- 不要提及本次摘要请求本身，也不要说上下文被压缩过。',
  '- 只输出检查点文本：不要调用任何工具，不要做任何其他动作。',
  '- 若对话中已存在 <compacted-summary> 块，那是**上一次**的检查点：不要照抄，保留仍然成立的事实、丢弃过时的，合并成一份新的同结构摘要。'
].join('\n');

/** 检查点的包装（让替换进来的消息成为"既定背景"而非需要回应的对象） */
const CHECKPOINT_PREAMBLE = '这是一份自动生成的检查点，浓缩了对话较早的部分以腾出上下文。把其中的内容当作既定背景直接沿用，不要复述，也不要回应本检查点——直接从其后的消息继续任务。';

/** 判断一条消息是否含工具调用 / 工具结果（用于"绝不劈开配对"） */
function msgRole(m) {
  if (!m) return 'other';
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return 'assistant-toolcall';
  if (m.role === 'tool') return 'tool';
  return 'other';
}

/**
 * 选压缩区间：从尾部往前保留 keepTokens 的消息；区间右端必须落在"配对完整"的边界上
 * （assistant(tool_calls) 与其全部 tool 结果要么都在保留区，要么都被压缩）。
 * @returns {{ startIdx: number, keepFromIdx: number }}
 */
function chooseRegion(messages, keepTokens) {
  const n = messages.length;
  // 1) 从尾部累加，确定保留起点
  let acc = 0, keepFromIdx = n;
  for (let i = n - 1; i >= 0; i--) {
    acc += estimateTokens(JSON.stringify(messages[i]));
    keepFromIdx = i;
    if (acc >= keepTokens) break;
  }
  // 2) 向前扩，保证配对完整：保留区里不能出现"tool 结果在、发起调用的 assistant 不在"
  while (keepFromIdx > 0) {
    const m = messages[keepFromIdx];
    if (msgRole(m) === 'tool') { keepFromIdx--; continue; }   // 工具结果不能当保留区开头
    break;
  }
  // 3) 压缩区间 [0, keepFromIdx) 还必须是配对完整的：区间末尾若是 assistant-toolcall，扩到含其全部 tool 结果
  let end = keepFromIdx;
  while (end > 0 && msgRole(messages[end - 1]) === 'assistant-toolcall') {
    const ids = new Set((messages[end - 1].tool_calls || []).map(function (c) { return c.id; }));
    let j = end;
    while (j < n && msgRole(messages[j]) === 'tool' && ids.has(messages[j].tool_call_id)) j++;
    end = j;
    keepFromIdx = end;
  }
  return { startIdx: 0, keepFromIdx: keepFromIdx };
}

/**
 * 对 messages 做结构化压缩（层三/四）。
 *
 * 两处曾经出错、现已固化的约定：
 *   ① **system 不参与压缩**：旧实现从下标 0 开始压，压缩后 system 角色整个消失，
 *      安全边界与工作方式随之丢失，还会把检查点当成 system 用（"摘要的摘要"）。
 *   ② **chat 的返回值两种形态都接受**：生产接线传进来的是 brain.chat，返回
 *      `{content, usage, ...}` 对象；单测替身传的是字符串。旧实现只按字符串处理，
 *      于是真实运行里 `summaryText.trim is not a function` 必然抛出（实测），
 *      压缩从未成功过，而单测因为用字符串而全绿。
 *
 * @param {object} o { messages, system, tools, chat: (messages,opts)=>Promise<string|{content,usage}>,
 *                     windowTokens, force, onEvent }
 * @returns {Promise<{ messages: Array, compacted: boolean, usage?: object, error?: string }>}
 */
async function compact(o) {
  const messages = o.messages || [];
  const windowTokens = o.windowTokens || 65536;
  const threshold = Math.floor(windowTokens * 0.8);
  const keep = Math.floor(windowTokens * 0.16);

  // 压力检查（含 tools 定义）
  const total = estimateMessages(messages, o.tools);
  if (!o.force && total < threshold) return { messages: messages, compacted: false };

  // ① 摘出 system，压缩区间只作用于其后
  const sys = (messages[0] && messages[0].role === 'system') ? messages[0] : null;
  const body = sys ? messages.slice(1) : messages;

  const region = chooseRegion(body, keep);
  // 至少要有一条可压缩的消息；保留区必须还存在
  if (region.keepFromIdx < 1) return { messages: messages, compacted: false, error: '没有可压缩区间' };

  const span = body.slice(region.startIdx, region.keepFromIdx);
  const spanTokens = estimateMessages(span);

  if (o.onEvent) o.onEvent({ type: 'compact:start', spanMessages: span.length, spanTokens: spanTokens });

  // 摘要调用复用对话自己的 system + tools + 被压区间作为前缀（DSH：让 KV cache 命中），
  // 压缩指令只追加在末尾。
  const raw = await o.chat(
    [{ role: 'system', content: o.system || '' }]
      .concat(span)
      .concat([{ role: 'user', content: COMPACTION_INSTRUCTION }]),
    { tools: o.tools, maxTokens: 8192 }
  );

  // ② 契约判型：字符串直接用；对象取 content
  const summaryText = typeof raw === 'string' ? raw : String((raw && raw.content) || '');
  const usage = (raw && typeof raw === 'object' && raw.usage) ? raw.usage : null;

  if (!summaryText.trim() || estimateTokens(summaryText) >= spanTokens) {
    if (o.onEvent) o.onEvent({ type: 'compact:failed', reason: '摘要不比原文小' });
    return { messages: messages, compacted: false, usage: usage, error: '摘要不比原文小，放弃压缩' };
  }

  const merged = CHECKPOINT_PREAMBLE + '\n\n<compacted-summary>\n' + summaryText.trim() + '\n</compacted-summary>';
  const kept = body.slice(region.keepFromIdx);
  const checkpointMsg = { role: 'user', content: merged, _checkpoint: true };
  const next = (sys ? [sys] : []).concat([checkpointMsg], kept);

  if (o.onEvent) o.onEvent({ type: 'compact:end', spanMessages: span.length, summaryTokens: estimateTokens(merged) });
  return { messages: next, compacted: true, usage: usage };
}

module.exports = {
  pruneText: pruneText,
  spill: spill,
  estimateTokens: estimateTokens,
  chooseRegion: chooseRegion,
  compact: compact,
  COMPACTION_INSTRUCTION: COMPACTION_INSTRUCTION,
  CHECKPOINT_PREAMBLE: CHECKPOINT_PREAMBLE,
  PRUNER: PRUNER,
  SPILL_THRESHOLD_BYTES: SPILL_THRESHOLD_BYTES
};
