/**
 * Ark Semantic — 服务端语义层 v1
 *
 * 职责：
 *  1. 在指定标签页构建语义索引（注入 semantic/extractor.js 执行，无需改扩展）
 *  2. 按意图检索（本地倒排索引 + BM25，宽进严出）
 *  3. 语义锚点定位与动作执行（检索结果 → 真实元素 → 真实点击 / 填值）
 *  4. 动作链执行（$N 引用上一步结果）与风险判定（高风险动作需确认）
 *
 * 设计约束：
 *  - 智能在云端、机械在本地：本模块只做确定性工作，不做规划、不调用模型
 *  - 通过现有 evaluate 通道注入脚本，不新增扩展命令（避免 reload-extension 与副本同步）
 *  - 索引常驻服务端内存，按标签页隔离；页面变化后由 fresh 参数触发重建
 */

const fs = require('fs');
const path = require('path');
const { buildIndex, search } = require('../semantic/indexer.js');

/**
 * 注入脚本热加载：改 extractor/locate 后无需重启 server（按 mtime 自动失效）
 * —— 开发期迭代提取规则时省去「每次改都重启 + 等扩展重连」的往返。
 */
const _srcCache = {};
function loadSrc(rel) {
  const p = path.join(__dirname, '..', rel);
  const st = fs.statSync(p);
  const c = _srcCache[rel];
  if (!c || c.mtime !== st.mtimeMs) {
    _srcCache[rel] = { mtime: st.mtimeMs, src: fs.readFileSync(p, 'utf8') };
  }
  return _srcCache[rel].src;
}

/** 高风险动作词来自唯一定义处（与工具层共用，避免两份副本给出不同结论） */
const { HIGH_RISK_RE } = require('./core/risk');

class SemanticLayer {
  constructor(server) {
    this.server = server;
    this.indexes = new Map();   // tabKey -> entry
  }

  key(tabId) {
    return String(tabId == null ? 'active' : tabId);
  }

  /**
   * 当前请求上下文里显式指定的 CDP targetId。
   * 由任务运行时注入（任务在创建时就把目标解析成 targetId），因此不再需要
   * "扩展 tabId → 查 URL → 回内核按 URL 匹配"这条依赖扩展的链路。
   */
  _reqTargetId() {
    try {
      const s = this.server.als && this.server.als.getStore();
      return s && s.targetId != null ? s.targetId : null;
    } catch (e) { return null; }
  }

  /**
   * 解析目标页：优先 CDP 内核（不依赖扩展），失败时回退扩展 tabId。
   * 返回 { targetId, tabId, strict }
   *   · targetId 为空且 strict=false → 只能走扩展通道
   *   · strict=true → 上下文已明确指定过目标但它已消失，此时**不允许**退回扩展通道
   *     （否则会误操作到另一个标签页，比直接失败更危险）
   */
  async resolveTarget(tabId) {
    const core = this.server.cdp;
    if (!core) return { targetId: null, tabId: tabId, strict: false };
    try {
      const pages = await core.pages(true);
      if (!pages.length) return { targetId: null, tabId: tabId, strict: false };

      // 1) 显式 targetId 最优先：精确、无歧义、不依赖扩展
      const explicit = this._reqTargetId();
      if (explicit) {
        const mine = pages.find(function (p) { return p.id === explicit; });
        return { targetId: mine ? mine.id : null, tabId: tabId, strict: true };
      }

      if (tabId == null) {
        const p = await core.activePage();
        return { targetId: p ? p.id : pages[0].id, tabId: tabId, strict: false };
      }
      // 2) 有扩展 tabId → 用扩展查 URL，再在 CDP target 里按 URL 匹配
      let url = null;
      try {
        const tabs = await this.server.cmd('get-tabs', {}, 8000);
        const list = Array.isArray(tabs) ? tabs : ((tabs && tabs.result) || []);
        const t = list.find(function (x) { return String(x.id) === String(tabId); });
        url = t && t.url;
      } catch (e) { /* 扩展不可用 —— 内核仍可能工作 */ }
      if (!url) return { targetId: null, tabId: tabId, strict: false };
      const hit = pages.find(function (p) { return p.url === url; });
      return { targetId: hit ? hit.id : null, tabId: tabId, strict: false };
    } catch (e) {
      return { targetId: null, tabId: tabId, strict: false };
    }
  }

  /**
   * 执行语义任务（extract / locate）—— 双阶段：
   *
   *   阶段一 runInPage：内核通道（server 自己的 CDP，Runtime.evaluate 不受页面 CSP 限制）；
   *                     内核不可用时落到扩展的字符串求值通道（需调试授权）。
   *   阶段二 注入通道：扩展用 chrome.scripting.executeScript({ files }) 注入打包好的提取器。
   *                     浏览器自己注入、不经 eval，所以严格 CSP 页面也能用，且不需要用户点「启用调试」。
   *
   * 两阶段都失败时报可操作原因，而不是把 CSP 原文丢给用户。
   */
  async runTask(task, payload, tabId) {
    const codeOf = () => task === 'extract'
      ? '(function(){\n' + loadSrc('semantic/extractor.js') + '\nreturn ArkSemantic.extractSemanticUnits(document, ' + JSON.stringify(payload.opts || {}) + ');\n})()'
      : '(function(){\n' + loadSrc('semantic/locate.js') + '\nreturn ArkSemanticLocate.locate(' + JSON.stringify(payload.spec) + ');\n})()';
    const errors = [];

    try {
      const data = await this.runInPage(codeOf(), tabId);
      if (data && !data.error) return { via: 'eval', data };
      errors.push('内核/求值通道: ' + ((data && data.error) || '无返回'));
    } catch (e) {
      errors.push('内核/求值通道: ' + (e && e.message));
    }

    try {
      const raw = await this.server.cmd('semantic-run', task === 'extract'
        ? { task: 'extract', opts: payload.opts || {} }
        : { task: 'locate', spec: payload.spec }, 60000);
      if (raw && raw.success) return { via: raw.via || 'inject', data: raw.result };
      errors.push('注入通道: ' + ((raw && raw.error) || '无返回'));
    } catch (e) {
      errors.push('注入通道: ' + (e && e.message));
    }

    const cspBlocked = /unsafe-eval|Content Security Policy/i.test(errors.join(' '));
    const hint = cspBlocked
      ? '（扩展侧字符串求值被 MV3 CSP 禁止，这是正常限制）请在插件 popup 点「启用调试」，或确认扩展副本是最新版（node scripts/sync.js --yes 后重载插件）—— 注入通道可绕开该限制。'
      : '';
    throw new Error('语义' + (task === 'extract' ? '提取' : '定位') + '失败。' + errors.join(' ｜ ') + ' ' + hint);
  }

  /**
   * 在页面里执行脚本并返回其返回值 —— 双通道：
   *   1) CDP 内核（首选：不依赖扩展、可注入 chrome:// 之外的任意 http 页）
   *   2) 扩展通道（兜底；注意 MV3 下字符串求值需要调试通道已授权）
   * 后台标签页未渲染时提取可能为空，会自动激活后重试一次。
   */
  async runInPage(code, tabId) {
    const core = this.server.cdp;
    if (core) {
      try {
        const rt = await this.resolveTarget(tabId);
        if (rt.targetId) {
          let v = await core.evaluate(code, rt.targetId);
          const emptyish = (v == null) || (Array.isArray(v.units) && !v.units.length) || (v.ok === false);
          if (emptyish) {
            await core.ensureVisible(rt.targetId).catch(function () { });
            v = await core.evaluate(code, rt.targetId);
          }
          return v;
        }
        // 明确指定过的目标已关闭：直接失败，不退回扩展通道（避免误操作别的标签页）
        if (rt.strict) throw new Error('目标任务已关闭（targetId 不存在）: ' + this._reqTargetId());
      } catch (e) {
        if (/目标任务已关闭/.test(String(e && e.message))) throw e;
        /* 内核失败 → 回退扩展 */
      }
    }
    const raw = await this.server.cmd('evaluate', { code, timeout: 60000 }, 70000);
    return (raw && raw.result !== undefined) ? raw.result : raw;
  }

  /** 注入提取器并建索引 */
  async build(tabId, opts) {
    const r = await this.runTask('extract', { opts: opts || {} }, tabId);
    const data = r.data;
    if (!data || !data.units) throw new Error('提取失败: ' + JSON.stringify(data).slice(0, 200));
    const entry = {
      index: buildIndex(data.units),
      units: data.units,
      stats: data.stats,
      url: data.url,
      title: data.title,
      builtAt: Date.now()
    };
    this.indexes.set(this.key(tabId), entry);
    return entry;
  }

  /** 取索引（缺失或 fresh 时重建） */
  async ensure(tabId, fresh) {
    const k = this.key(tabId);
    let e = this.indexes.get(k);
    if (!e || fresh) e = await this.build(tabId);
    return e;
  }

  /** 索引摘要（不回传全部单元） */
  summary(entry) {
    return {
      url: entry.url,
      title: entry.title,
      units: entry.units.length,
      terms: entry.index.postings.size,
      levelCounts: entry.stats.levelCounts,
      typeCounts: entry.stats.typeCounts,
      extractMs: entry.stats.elapsedMs,
      ageMs: Date.now() - entry.builtAt
    };
  }

  /** 检索 */
  async query(tabId, q, opts) {
    const o = opts || {};
    const entry = await this.ensure(tabId, o.fresh);
    const hits = search(entry.index, q, { topK: o.topK || 5 });
    return {
      url: entry.url,
      query: q,
      total: hits.length,
      hits: hits.map(function (h) {
        return { score: h.score, coverage: h.coverage, matched: h.matched, unit: h.unit };
      })
    };
  }

  /** 单元引用解析：id 字符串 / 文本片段 / 上一步结果对象 */
  resolveUnit(entry, ref) {
    if (!ref) return null;
    if (typeof ref === 'string') {
      const byId = entry.units.find(function (x) { return x.id === ref; });
      if (byId) return byId;
      const needle = ref.toLowerCase();
      return entry.units.find(function (x) { return (x.text || '').toLowerCase().indexOf(needle) >= 0; }) || null;
    }
    if (ref.unit) return ref.unit;
    if (ref.id) return this.resolveUnit(entry, ref.id);
    if (ref.text) return this.resolveUnit(entry, ref.text);
    return null;
  }

  /** 定位：语义单元 → 页面真实元素（未给单元线索时为全页范围，用于"页面上任意位置的输入框"这类目标） */
  async locate(tabId, unitRef, criteria) {
    const entry = await this.ensure(tabId);
    const unit = unitRef ? this.resolveUnit(entry, unitRef) : null;
    if (unitRef && !unit) throw new Error('未找到语义单元: ' + JSON.stringify(unitRef).slice(0, 80));
    const spec = unit
      ? { path: unit.path, textPrefix: (unit.text || '').slice(0, 30), criteria: criteria || {} }
      : { criteria: criteria || {} };
    const r = await this.runTask('locate', { spec }, tabId);
    const loc = r.data;
    return {
      unit: unit ? { id: unit.id, type: unit.type, level: unit.level, text: (unit.text || '').slice(0, 80) } : null,
      loc: loc
    };
  }

  /** 执行单个语义动作 */
  async act(tabId, action) {
    switch (action.op) {
      case 'find': {
        const r = await this.query(tabId, action.query, { topK: action.topK || 3, fresh: action.fresh });
        return { ok: r.total > 0, op: 'find', total: r.total, hits: r.hits };
      }

      case 'read': {
        const entry = await this.ensure(tabId, action.fresh);
        const unit = this.resolveUnit(entry, action.unit);
        if (!unit) return { ok: false, op: 'read', error: 'unit-not-found' };
        return { ok: true, op: 'read', unit: { id: unit.id, type: unit.type, level: unit.level, text: unit.text, charLen: unit.charLen } };
      }

      case 'click': {
        const r = await this.locate(tabId, action.unit, {
          kind: action.kind, labelIncludes: action.labelIncludes, tag: action.tag, index: action.index
        });
        if (!r.loc || !r.loc.ok) {
          return { ok: false, op: 'click', error: (r.loc && r.loc.error) || 'locate-failed', locate: r.loc, unit: r.unit };
        }
        const labelText = r.loc.target.label || r.loc.unitText || '';
        const highRisk = HIGH_RISK_RE.test(labelText);
        if (highRisk && !action.confirmed) {
          return {
            ok: false, op: 'click', needConfirm: true, risk: 'high',
            plan: { target: labelText.slice(0, 60), kind: r.loc.target.kind, selector: r.loc.target.selector },
            unit: r.unit
          };
        }
        if (!r.loc.target.inViewport) {
          await this.server.cmd('scroll-into-view', { selector: r.loc.target.selector }, 15000).catch(function () { });
        }
        await this.server.cmd('mouse', { type: 'click', x: r.loc.target.center.x, y: r.loc.target.center.y }, 15000);
        return { ok: true, op: 'click', clicked: labelText.slice(0, 60), kind: r.loc.target.kind, risk: highRisk ? 'high' : 'low', unit: r.unit };
      }

      case 'fill': {
        const r = await this.locate(tabId, action.unit, {
          kind: 'input', labelIncludes: action.labelIncludes, tag: action.tag, index: action.index
        });
        if (!r.loc || !r.loc.ok) {
          return { ok: false, op: 'fill', error: (r.loc && r.loc.error) || 'locate-failed', locate: r.loc, unit: r.unit };
        }
        await this.server.cmd('fill-form', { fields: [{ selector: r.loc.target.selector, value: String(action.text == null ? '' : action.text) }] }, 20000);
        return { ok: true, op: 'fill', filled: String(action.text || '').slice(0, 60), into: (r.loc.target.label || '').slice(0, 40), unit: r.unit };
      }

      default:
        return { ok: false, op: action.op, error: 'unknown-op' };
    }
  }

  /**
   * 步骤引用替换，支持三种写法：
   *   "$N"         第 N 步结果的第一个候选（find 步）或该步读到的单元
   *   "$N.M"       第 N 步结果的第 M 个候选（0 基）
   *   "$N[M]" / "$N.hits[M]"   同上（兼容写法）
   * 说明：契约里必须明示"$N"指第 N 步、"$N.M"指该步的第 M 个候选 ——
   *       模拟验证中大脑把 "$1"/"$2" 理解为"候选 1/2"，导致后续 read 全部回落到第一个候选。
   */
  resolveStepRefs(step, results) {
    const out = {};
    const keys = Object.keys(step || {});
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      let v = step[k];
      if (typeof v === 'string' && v.charAt(0) === '$') {
        const m = /^\$(\d+)(?:\.hits\[(\d+)\]|\.(\d+)|\[(\d+)\])?$/.exec(v);
        if (m) {
          const prev = results[+m[1]];
          const rawIdx = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
          const idx = rawIdx !== undefined ? +rawIdx : 0;
          if (prev) {
            if (prev.hits && prev.hits.length) {
              v = prev.hits[Math.min(idx, prev.hits.length - 1)];
            } else if (prev.unit) {
              v = prev;
            }
          }
        }
      }
      out[k] = v;
    }
    return out;
  }

  /** 执行动作链 */
  async run(tabId, steps, opts) {
    const results = [];
    const list = Array.isArray(steps) ? steps : [];
    for (let i = 0; i < list.length; i++) {
      const step = this.resolveStepRefs(list[i], results);
      let r;
      try {
        r = await this.act(tabId, step);
      } catch (e) {
        r = { ok: false, op: step && step.op, error: String(e.message || e) };
      }
      results.push(r);
      if (!r.ok) break;   // 失败即停，返回已完成步骤
    }
    const completed = results.filter(function (r) { return r.ok; }).length;
    return {
      ok: completed === list.length && list.length > 0,
      completed: completed,
      total: list.length,
      steps: results,
      stoppedAt: completed < list.length ? completed : null
    };
  }

  /** 清空索引 */
  clear(tabId) {
    if (tabId == null) this.indexes.clear();
    else this.indexes.delete(this.key(tabId));
  }

  /** 调试：查看「AI 眼中的页面」 */
  async dump(tabId, opts) {
    const o = opts || {};
    const entry = await this.ensure(tabId, o.fresh);
    const units = o.level
      ? entry.units.filter(function (u) { return (u.level || 'content') === o.level; })
      : entry.units;
    const limit = o.limit || 40;
    return {
      summary: this.summary(entry),
      units: units.slice(0, limit).map(function (u) {
        return { id: u.id, type: u.type, level: u.level, charLen: u.charLen, text: (u.text || '').slice(0, 100) };
      }),
      shown: Math.min(limit, units.length),
      totalMatching: units.length
    };
  }
}

module.exports = SemanticLayer;
