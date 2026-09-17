/**
 * Ark Semantic — 检索层 v1（宿主无关，零依赖）
 *
 * 职责：对语义单元集建立倒排索引，按查询返回 top-K 命中（供语义锚点替换使用）。
 *
 * 设计约束：
 *  - 纯确定性算法，零模型（分词用浏览器原生的 Intl.Segmenter，降级为 bigram）
 *  - 打分用 BM25 简化式 + 查询覆盖度加权；返回候选列表而非单一结果（歧义交上层决策）
 *  - 不触碰 chrome.* / Electron API，Node 与页面环境均可运行
 *
 * 用法：
 *   Node:  const { buildIndex, search } = require('./semantic/indexer.js')
 *   注入:  <源码>; return ArkSemanticIndex.search(ArkSemanticIndex.buildIndex(units), '关键词')
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ArkSemanticIndex = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  /** 高频虚词：不参与打分（中英混排常见项） */
  const STOPWORDS = {};
  ['的', '了', '是', '在', '和', '与', '我', '你', '他', '她', '它', '这', '那', '就', '都', '也', '有', '个',
    '要', '对', '把', '被', '而', '但', '等', '之', '为', '以', '及', '中', '上', '下', '不', '很', '会', '能',
    'the', 'a', 'an', 'of', 'to', 'is', 'are', 'was', 'in', 'on', 'for', 'and', 'or', 'it', 'that', 'this'
  ].forEach(function (w) { STOPWORDS[w] = 1; });

  // ---- 分词 ----

  /** Intl.Segmenter 优先（原生中文分词）；不可用时降级为「英文按词 + 中文 bigram」 */
  function makeTokenizer() {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const seg = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
        return function (text) {
          const out = [];
          const it = seg.segment(String(text));
          for (const s of it) {
            if (s.isWordLike) {
              const w = s.segment.toLowerCase();
              if (w.length > 1 || /[\u4e00-\u9fff]/.test(w)) out.push(w);
            }
          }
          return out;
        };
      } catch (e) { /* 降级 */ }
    }
    return function (text) {
      const out = [];
      const parts = String(text).toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (/^[a-z0-9]+$/.test(p)) { out.push(p); continue; }
        if (p.length === 1) { out.push(p); continue; }
        for (let j = 0; j < p.length - 1; j++) out.push(p.slice(j, j + 2));   // bigram
      }
      return out;
    };
  }

  // ---- 索引 ----

  /**
   * 建索引：每个单元作为一篇"文档"
   * 文档字段 = 正文文本 + 交互元素标签（后者权重体现在词频上：标签词只计 1 次）
   */
  function buildIndex(units, opts) {
    const cfg = opts || {};
    const tokenize = makeTokenizer();
    const docs = [];
    const postings = new Map();
    let totalLen = 0;

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const textTokens = tokenize(unit.text || '');
      const labelText = (unit.interactives || []).map(function (x) { return x.label || ''; }).join(' ');
      const labelTokens = labelText ? tokenize(labelText) : [];
      const all = textTokens.concat(labelTokens);

      const tf = new Map();
      for (let j = 0; j < all.length; j++) {
        const t = all[j];
        tf.set(t, (tf.get(t) || 0) + 1);
      }
      docs.push({ id: i, unit: unit, tf: tf, tokens: tf, len: all.length || 1 });
      totalLen += all.length;

      tf.forEach(function (n, t) {
        let p = postings.get(t);
        if (!p) { p = new Map(); postings.set(t, p); }
        p.set(i, n);
      });
    }

    return {
      version: SCHEMA_VERSION,
      docs: docs,
      postings: postings,
      N: docs.length,
      avgLen: docs.length ? (totalLen / docs.length) : 1,
      tokenize: tokenize,
      builtAt: Date.now()
    };
  }

  // ---- 检索 ----

  /**
   * BM25 简化打分（k1=1.2, b=0.75）+ 查询覆盖度加权
   * 返回 [{ unit, score, coverage, matched }] 按分数降序，默认 topK=5
   */
  function search(index, query, opts) {
    const cfg = opts || {};
    const topK = cfg.topK || 5;
    const minScore = cfg.minScore || 0;
    const raw = index.tokenize(String(query || ''));
    const qTokens = [];
    const seen = {};
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      if (STOPWORDS[t] || seen[t]) continue;
      seen[t] = 1;
      qTokens.push(t);
    }
    if (!qTokens.length) return [];

    const scores = new Map();
    for (let i = 0; i < qTokens.length; i++) {
      const p = index.postings.get(qTokens[i]);
      if (!p) continue;
      const idf = Math.log(1 + (index.N - p.size + 0.5) / (p.size + 0.5));
      p.forEach(function (tf, docId) {
        const doc = index.docs[docId];
        const norm = 1 - 0.75 + 0.75 * (doc.len / index.avgLen);
        const s = idf * (tf * 2.2) / (tf + 1.2 * norm);
        scores.set(docId, (scores.get(docId) || 0) + s);
      });
    }

    const out = [];
    scores.forEach(function (score, docId) {
      const doc = index.docs[docId];
      let hit = 0;
      const matched = [];
      for (let i = 0; i < qTokens.length; i++) {
        if (doc.tokens.has(qTokens[i])) { hit++; matched.push(qTokens[i]); }
      }
      const coverage = hit / qTokens.length;
      const final = score * (0.5 + 0.5 * coverage);
      if (final < minScore) return;
      out.push({ unit: doc.unit, score: Math.round(final * 1000) / 1000, coverage: Math.round(coverage * 100) / 100, matched: matched });
    });

    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, topK);
  }

  /** 便捷方法：一次性查询（内部建索引，适合小规模或一次性场景） */
  function query(units, q, opts) {
    return search(buildIndex(units), q, opts);
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    buildIndex: buildIndex,
    search: search,
    query: query
  };
});
