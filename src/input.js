/**
 * 真实输入层
 *
 * 全部走 CDP Input 域，事件 isTrusted=true、具备浏览器默认行为、
 * 能驱动 CSS :hover / :active 等伪类状态——这是与合成事件的根本差别。
 */

import { cdp } from './cdp.js';

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' }
};

/** 把 "Ctrl+Shift+A" / "Enter" 解析成 CDP 可用的按键描述 */
export function parseCombo(combo) {
  const parts = String(combo || 'Enter').split('+').map((s) => s.trim()).filter(Boolean);
  const raw = parts.pop() || 'Enter';
  let modifiers = 0;
  for (const p of parts) {
    const k = p.toLowerCase();
    if (k === 'ctrl' || k === 'control') modifiers |= MOD.ctrl;
    else if (k === 'alt' || k === 'option') modifiers |= MOD.alt;
    else if (k === 'shift') modifiers |= MOD.shift;
    else if (k === 'meta' || k === 'cmd' || k === 'command' || k === 'win') modifiers |= MOD.meta;
  }
  const named = KEYS[raw] || KEYS[raw.charAt(0).toUpperCase() + raw.slice(1)];
  if (named) return { ...named, modifiers, label: raw };

  if (raw.length === 1) {
    const ch = raw;
    const upper = ch.toUpperCase();
    const isLetter = /^[a-zA-Z]$/.test(ch);
    const isDigit = /^[0-9]$/.test(ch);
    return {
      key: ch,
      code: isLetter ? 'Key' + upper : isDigit ? 'Digit' + ch : '',
      vk: upper.charCodeAt(0),
      text: ch,
      modifiers,
      label: raw
    };
  }
  // 未知键名：按字面发送，至少不会静默失败
  return { key: raw, code: raw, vk: 0, modifiers, label: raw };
}

/** 单点点击：先移动（触发 hover 态）→ 按下 → 抬起 */
export async function mouseClick(tabId, x, y, opts = {}) {
  const px = Math.round(x), py = Math.round(y);
  const count = Math.max(1, Number(opts.count || 1));
  const button = opts.button || 'left';
  const holdMs = Number(opts.holdMs || 0);

  if (!opts.skipMove) {
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0
    });
  }
  for (let i = 1; i <= count; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: px, y: py, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4,
      clickCount: i
    });
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: px, y: py, button, buttons: 0,
      clickCount: i
    });
  }
  return { x: px, y: py, count, button };
}

/** 真实悬停：只发 mouseMoved，浏览器据此更新 :hover 伪类 */
export async function mouseMove(tabId, x, y) {
  const px = Math.round(x), py = Math.round(y);
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 });
  return { x: px, y: py };
}

/** 拖拽：从起点按住移动到终点再抬起 */
export async function mouseDrag(tabId, from, to, steps = 12) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + (to.x - from.x) * (i / steps));
    const y = Math.round(from.y + (to.y - from.y) * (i / steps));
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  }
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(to.x), y: Math.round(to.y), button: 'left', buttons: 0, clickCount: 1 });
  return { from, to, steps };
}

/** 整段插入文本：产生真实 beforeinput/input 事件，兼容 IME 与富文本 */
export async function insertText(tabId, text) {
  await cdp(tabId, 'Input.insertText', { text: String(text) });
  return { chars: String(text).length };
}

/** 逐字符敲键：慢速但更贴近真人（联想、字数统计、按键拦截都依赖） */
export async function typeChars(tabId, text, delayMs = 20) {
  for (const ch of String(text)) {
    const desc = parseCombo(ch);
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: desc.key, code: desc.code, text: desc.text ?? ch,
      windowsVirtualKeyCode: desc.vk, nativeVirtualKeyCode: desc.vk, modifiers: 0
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: desc.key, code: desc.code,
      windowsVirtualKeyCode: desc.vk, nativeVirtualKeyCode: desc.vk, modifiers: 0
    });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { chars: String(text).length };
}

/** 单次按键（含组合键与浏览器默认行为） */
export async function pressKey(tabId, combo) {
  const d = parseCombo(combo);
  const base = {
    key: d.key, code: d.code,
    windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk,
    modifiers: d.modifiers
  };
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', ...base,
    ...(d.text && d.modifiers === 0 ? { text: d.text } : {}),
    ...(d.modifiers === 0 ? {} : { text: undefined })
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  return { key: d.key, code: d.code, modifiers: d.modifiers, label: d.label };
}
