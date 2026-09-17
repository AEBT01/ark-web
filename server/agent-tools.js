/**
 * Ark Agent Tools — 工具执行器（本地机械层）
 *
 * 职责：把大脑输出的 {"tool":"...","args":{...}} 映射到 ark-web 的真实能力
 *       （插件命令 / 语义层），并把原始返回裁成模型可读的紧凑结构。
 *
 * 设计约束：
 *  · 不含任何决策 —— 只做确定性执行与结果整形（决策全在云端大脑）
 *  · 结果必须裁剪：ark-web 有些端点会返回整篇 DOM / 图片 base64，直接回灌会让上下文爆炸
 *  · 语义工具走 SemanticLayer（本项目核心能力），通用交互走插件命令（完整复现 ark-web 能力面）
 */

/** 结果裁剪：按工具把原始返回压成紧凑结构（模型读得下、信息不丢关键） */
function trimResult(tool, raw) {
  const R = (raw && raw.result !== undefined) ? raw.result : raw;
  if (R == null) return { ok: false, empty: true };
  if (typeof R !== 'object') return { value: String(R).slice(0, 1000) };

  switch (tool) {
    case 'page_info':
      return {
        url: R.url, title: R.title, readyState: R.readyState,
        viewport: R.viewport, counts: R.counts
      };

    case 'snapshot':
      // 文本模型不读图：只回元素清单，明确省略图片数据
      return {
        url: R.url, title: R.title, viewport: R.viewport,
        elements: (R.elements || []).slice(0, 40),
        note: '图片数据已省略（文本模型不读图；需要看版面请用 read_text / semantic_find）'
      };

    case 'read_text':
      return { text: String(R.text || R.value || R || '').slice(0, 3000) };

    case 'query_all': {
      const list = Array.isArray(R) ? R : (R.items || R.elements || []);
      return { count: list.length, items: list.slice(0, 25) };
    }

    case 'evaluate':
      return { value: JSON.stringify(R).slice(0, 2500) };

    case 'console_logs': {
      const logs = Array.isArray(R) ? R : (R.logs || []);
      return { count: logs.length, logs: logs.slice(-25) };
    }

    case 'network_log': {
      const reqs = Array.isArray(R) ? R : (R.requests || R.logs || []);
      return { count: reqs.length, requests: reqs.slice(-25) };
    }

    case 'semantic_find':
      return {
        total: R.total,
        hits: (R.hits || []).slice(0, 6).map(function (h) {
          return {
            id: h.unit && h.unit.id,
            type: h.unit && h.unit.type,
            score: h.score,
            text: String((h.unit && h.unit.text) || '').slice(0, 240),
            interactives: ((h.unit && h.unit.interactives) || []).map(function (x) { return x.label; })
          };
        })
      };

    case 'semantic_read':
      return R.unit
        ? { id: R.unit.id, type: R.unit.type, text: String(R.unit.text || '').slice(0, 2000) }
        : { error: R.error || 'unit-not-found' };

    case 'semantic_click':
      return R.ok
        ? { ok: true, clicked: R.clicked, kind: R.kind, risk: R.risk, on: R.unit && R.unit.id }
        : { ok: false, error: R.error, needConfirm: !!R.needConfirm, plan: R.plan, locate: R.locate };

    case 'semantic_fill':
      return R.ok
        ? { ok: true, filled: R.filled, into: R.into }
        : { ok: false, error: R.error, locate: R.locate };

    case 'list_tabs': {
      const list = Array.isArray(R) ? R : [];
      return {
        count: list.length,
        tabs: list.map(function (t) { return { id: t.id, active: !!t.active, title: String(t.title || '').slice(0, 60), url: String(t.url || '').slice(0, 100) }; })
      };
    }

    case 'get_cookies': {
      const list = Array.isArray(R) ? R : (R.cookies || []);
      return { count: list.length, cookies: list.slice(0, 20).map(function (c) { return { name: c.name, domain: c.domain, value: String(c.value || '').slice(0, 40) }; }) };
    }

    case 'get_storage': {
      const obj = (R && typeof R === 'object' && !Array.isArray(R)) ? R : {};
      const keys = Object.keys(obj);
      const out = {};
      keys.slice(0, 30).forEach(function (k) { out[k] = String(obj[k]).slice(0, 120); });
      return { count: keys.length, items: out };
    }

    case 'screenshot':
    case 'screenshot_full':
      return { note: '截图已生成（文本模型不读图，仅确认操作成功）', url: R.url, bytes: R.bytes || null };

    case 'highlight':
      return { ok: true, highlighted: R.count || R.highlighted || 'done' };

    default:
      return JSON.parse(JSON.stringify(R, function (k, v) {
        if (typeof v === 'string' && v.length > 800) return v.slice(0, 800) + '…';
        return v;
      }));
  }
}

/**
 * 创建工具执行器。
 * @param {object} server   BridgeServer 实例（提供 cmd）
 * @param {object} semantic SemanticLayer 实例
 * @param {function} reqTabId 取请求级 tabId 的函数
 */
function createExecutor(server, semantic, reqTabId) {
  const cmd = function (type, data, timeout) { return server.cmd(type, data || {}, timeout); };

  return async function executeTool(action) {
    const tool = action && action.tool;
    const a = (action && action.args) || {};
    const tabId = reqTabId();
    let raw;

    switch (tool) {
      // ── 观测 ──
      case 'page_info':
        raw = await cmd('get-page-info', {}, 15000); break;
      case 'snapshot':
        raw = await cmd('vision-snapshot', { annotate: !!a.annotate, compact: true, maxElements: 60, format: 'webp' }, 30000); break;
      case 'read_text':
        raw = await cmd('get-text', a.selector ? { selector: a.selector } : {}, 20000); break;
      case 'query_all':
        raw = await cmd('query-all', { selector: a.selector, limit: a.limit || 20 }, 15000); break;
      case 'evaluate':
        raw = await cmd('evaluate', { code: String(a.code || 'return null'), timeout: 15000 }, 20000); break;
      case 'console_logs':
        raw = await cmd('get-console-logs', { limit: a.limit || 50 }, 15000); break;
      case 'network_log':
        raw = await cmd('get-network-logs', { filter: a.filter || '', limit: a.limit || 40 }, 15000); break;

      // ── 语义理解（本项目核心）──
      case 'semantic_find':
        raw = await semantic.query(tabId, String(a.query || ''), { topK: a.topK || 5 }); break;
      case 'semantic_read': {
        const entry = await semantic.ensure(tabId);
        const unit = semantic.resolveUnit(entry, a.unit);
        raw = unit ? { unit: { id: unit.id, type: unit.type, level: unit.level, text: unit.text, charLen: unit.charLen } } : { error: 'unit-not-found' };
        break;
      }
      case 'semantic_click':
        raw = await semantic.act(tabId, { op: 'click', unit: a.unit, labelIncludes: a.labelIncludes, index: a.index }); break;
      case 'semantic_fill':
        raw = await semantic.act(tabId, { op: 'fill', unit: a.unit, labelIncludes: a.labelIncludes, text: a.text }); break;

      // ── 导航与标签页 ──
      case 'navigate':
        raw = await cmd('open-url', { url: a.url, current: true }, 35000); break;
      case 'open_tab':
        raw = await cmd('open-url', { url: a.url }, 35000); break;
      case 'list_tabs':
        raw = await cmd('get-tabs', {}, 15000); break;
      case 'activate_tab':
        raw = await cmd('activate-tab', { tabId: a.tabId }, 15000); break;
      case 'close_tab':
        raw = await cmd('close-tab', { tabId: a.tabId }, 15000); break;
      case 'history_go':
        raw = await cmd(a.direction === 'forward' ? 'forward' : 'back', {}, 25000); break;
      case 'reload':
        raw = await cmd('reload', {}, 35000); break;
      case 'wait_load':
        raw = await cmd('wait-for-load', { timeout: a.timeout || 15000 }, (a.timeout || 15000) + 6000); break;

      // ── 通用交互 ──
      case 'click':
        raw = await cmd('click-element', { selector: a.selector }, 20000); break;
      case 'type_text':
        raw = await cmd('type-text', { selector: a.selector, text: String(a.text == null ? '' : a.text) }, 25000); break;
      case 'press_key':
        raw = await cmd('simulate-key', { key: a.key }, 15000); break;
      case 'scroll':
        if (a.selector) raw = await cmd('scroll-into-view', { selector: a.selector }, 15000);
        else if (a.to === 'top' || a.to === 'bottom') raw = await cmd('scroll-page', { to: a.to }, 15000);
        else raw = await cmd('scroll-by', { x: 0, y: a.dy != null ? a.dy : 600 }, 15000);
        break;
      case 'hover':
        raw = await cmd('hover-element', { selector: a.selector }, 15000); break;
      case 'select_option':
        raw = await cmd('select-option', { selector: a.selector, value: a.value }, 15000); break;
      case 'wait_for':
        raw = a.text
          ? await cmd('wait-for-text', { text: a.text, timeout: a.timeout || 10000 }, (a.timeout || 10000) + 6000)
          : await cmd('wait-for-selector', { selector: a.selector, timeout: a.timeout || 10000 }, (a.timeout || 10000) + 6000);
        break;

      // ── 存储 ──
      case 'get_cookies':
        raw = await cmd('get-cookies', a.url ? { url: a.url } : {}, 15000); break;
      case 'set_cookie':
        raw = await cmd('set-cookie', { name: a.name, value: a.value, url: a.url }, 15000); break;
      case 'get_storage':
        raw = await cmd('get-storage', { type: a.type || 'local' }, 15000); break;
      case 'set_storage':
        raw = await cmd('set-storage', { key: a.key, value: a.value, type: a.type || 'local' }, 15000); break;

      // ── 反馈与呈现 ──
      case 'highlight':
        raw = await cmd('highlight-elements', { selector: a.selector, label: a.label || '' }, 15000); break;
      case 'screenshot':
        raw = a.full ? await cmd('screenshot-full', { format: 'webp' }, 45000)
          : await cmd('screenshot', { format: 'webp' }, 30000);
        break;

      default:
        return { error: 'unknown-tool', tool: tool, hint: '请使用工具清单里的工具名' };
    }

    return trimResult(tool, raw);
  };
}

module.exports = { createExecutor: createExecutor, trimResult: trimResult };
