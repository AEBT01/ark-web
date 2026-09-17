/**
 * 技能系统 —— 照搬 DeepSeek Harness 的 skill 机制
 * （源码：packages/skill/tool-skill/src/index.ts、packages/skill/skill-filesystem/src/index.ts）
 *
 * 核心设计（与 DSH 一致）：
 *   · **目录与正文分离**：每轮只注入一个"技能目录"（每条摘要限长），模型判断需要时
 *     用 skill 工具加载正文 —— 比把所有知识塞进 system prompt 省一个数量级的上下文
 *   · **digest 去重**：目录内容不变则不重发（sha256 比对），变化时发"替换目录"
 *   · **发现顺序**：项目级技能优先于用户级（DSH 的 rank 语义）
 *
 * 目录形态（沿用 DSH 的标记结构，模型对这类标记的遵循是训练过的）：
 *   <system-reminder>
 *   技能是可复用的任务做法说明。本会话可用：
 *   <available_skills>
 *   - `name`: description
 *   </available_skills>
 *   ... 使用指引 ...
 *   </system-reminder>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** 目录里每条描述的长度上限（DSH 的 catalogDescriptionMaxLength 默认 500） */
const CATALOG_DESC_MAX = 500;

/** 技能根目录：rank 小者优先（与 DSH 的"项目覆盖用户"一致） */
function skillRoots() {
  const roots = [];
  // 项目级：ark-web/skills（随 skill 仓库分发，rank 100）
  roots.push(path.join(__dirname, '..', '..', 'skills'));
  // 用户级：~/.ark-web/skills（用户自建，rank 400）
  try { roots.push(path.join(os.homedir(), '.ark-web', 'skills')); } catch (e) { /* ignore */ }
  return roots;
}

/** 解析 SKILL.md 的 frontmatter（--- 包裹的 key: value 简单形式） */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  m[1].split(/\r?\n/).forEach(function (line) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
  });
  return { meta: meta, body: raw.slice(m[0].length) };
}

/** 列出某技能目录下的附属资源（正文里用相对路径引用） */
function listResources(dir, mainFile) {
  try {
    return fs.readdirSync(dir).filter(function (f) { return f !== mainFile && !f.startsWith('.'); });
  } catch (e) { return []; }
}

/** 扫描所有技能根目录，返回 [{ name, description, whenToUse, source, dir, body }] */
function discover() {
  const byName = new Map();
  const RANKS = [[0, 'project'], [1, 'user']];   // 数组序即优先级：先到先得
  skillRoots().forEach(function (root, rankIdx) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter(function (d) { return !d.startsWith('.'); }); } catch (e) { return; }
    for (const d of dirs) {
      const dir = path.join(root, d);
      const main = path.join(dir, 'SKILL.md');
      let raw = '';
      try { raw = fs.readFileSync(main, 'utf8'); } catch (e) { continue; }
      const parsed = parseFrontmatter(raw);
      const name = parsed.meta.name || d;
      if (byName.has(name)) continue;   // 同名"最近作用域胜出"（先扫的是项目级）
      byName.set(name, {
        name: name,
        description: parsed.meta.description || '',
        whenToUse: parsed.meta.whenToUse || '',
        source: RANKS[rankIdx] ? RANKS[rankIdx][1] : 'project',
        dir: dir,
        body: parsed.body.trim()
      });
    }
  });
  return Array.from(byName.values());
}

/** 单条描述限长（超出截断并标注） */
function capDesc(s) {
  const t = String(s || '').trim();
  if (t.length <= CATALOG_DESC_MAX) return t;
  return t.slice(0, CATALOG_DESC_MAX - 20) + ' …[描述已截断]';
}

/** 渲染目录条目（每条限长后拼行） */
function catalogEntries(skills) {
  return skills.map(function (s) {
    const desc = [s.description, s.whenToUse ? '适用：' + s.whenToUse : '']
      .filter(Boolean).join('。');
    return { name: s.name, desc: capDesc(desc) };
  });
}

/** 目录 digest（内容不变 → 不重发） */
function catalogDigest(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/** 首次目录消息 */
function renderCatalog(entries) {
  return [
    '<system-reminder>',
    '技能是一组可复用的任务做法说明。本会话可用技能：',
    '',
    '<available_skills>',
    ...entries.map(function (e) { return '- `' + e.name + '`: ' + e.desc; }),
    '</available_skills>',
    '',
    '如果用户点名了某个技能，或任务与某个技能的描述明显匹配，先调用 `skill` 工具加载它（传准确的技能名），再执行任务；可以加载多个适用技能。此目录只含摘要——在加载之前，不要凭摘要猜测或遵循技能的做法。',
    '</system-reminder>'
  ].join('\n');
}

/** 目录更新消息（技能集合变化时替换旧目录） */
function renderCatalogUpdate(entries) {
  const avail = entries.length === 0
    ? '当前没有可用技能。不要使用早前技能目录里出现过的名字。'
    : '只使用本目录里的名字。若用户点名或任务明显匹配某技能，先调用 `skill` 工具加载再执行。';
  return [
    '<system-reminder>',
    '技能目录已更新，以下替换早前目录：',
    '',
    '<available_skills>',
    ...entries.map(function (e) { return '- `' + e.name + '`: ' + e.desc; }),
    '</available_skills>',
    '',
    avail,
    '</system-reminder>'
  ].join('\n');
}

/** 加载技能正文（含附属资源清单） */
function load(name) {
  const hit = discover().find(function (s) { return s.name === name; });
  if (!hit) return null;
  return {
    name: hit.name,
    body: hit.body,
    resources: listResources(hit.dir, 'SKILL.md')
  };
}

/** 正文包裹（模型看到的形式） */
function renderLoaded(loaded) {
  return [
    '<skill_content name="' + loaded.name + '">',
    loaded.resources.length ? '<skill_resources>' + loaded.resources.join(', ') + '</skill_resources>' : '',
    '<skill_instructions>',
    loaded.body,
    '</skill_instructions>',
    '</skill_content>'
  ].filter(Boolean).join('\n');
}

module.exports = {
  discover: discover,
  catalogEntries: catalogEntries,
  catalogDigest: catalogDigest,
  renderCatalog: renderCatalog,
  renderCatalogUpdate: renderCatalogUpdate,
  load: load,
  renderLoaded: renderLoaded,
  CATALOG_DESC_MAX: CATALOG_DESC_MAX
};
