# evaluate 高频模板（视觉路径的补位手段）

> 视觉为主，`/evaluate` 用于**穿透**（Shadow DOM / Canvas / 框架内部）与**取精确值**两类场景。
> 用法：`POST /evaluate {code}`，支持 `await`；写法可以是表达式或语句块（自动包装）。

## 基础

```json
{"code": "return { title: document.title, cookies: document.cookie }"}
{"code": "await fetch('/api/user').then(r => r.json())"}
{"code": "return Array.from(document.querySelectorAll('img[alt]')).map(i => i.alt).filter(Boolean).slice(0, 20)"}
{"code": "return Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))"}
```

## 穿透 Shadow DOM（快照/查询看不到内部时）

```json
{"code": "const host = document.querySelector('my-component'); const inner = host.shadowRoot.querySelector('.target'); return inner ? inner.innerText : null"}
{"code": "const walk = (root, out = []) => { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }; return walk(document).length"}
```

多层 shadow（如兼容表）需要逐层 `shadowRoot` 下钻 + 滚动触发懒加载。

## React 受控输入（节流降级时脚本事件不生效）

```json
{"code": "const el = document.querySelector('#kw'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '天气'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value;"}
```

完整事件流（Radix 等组件需要 `detail:1`）：

```json
{"code": "const el = document.querySelector('[role=combobox]'); const opts = { bubbles: true, cancelable: true, detail: 1 }; el.dispatchEvent(new PointerEvent('pointerdown', opts)); el.dispatchEvent(new MouseEvent('mousedown', opts)); el.dispatchEvent(new PointerEvent('pointerup', opts)); el.dispatchEvent(new MouseEvent('mouseup', opts)); el.dispatchEvent(new MouseEvent('click', opts)); return true;"}
```

## 编辑器 / 复杂组件

```json
{"code": "monaco.editor.getModels()[0].setValue('const x = 42;'); return 'set';"}
{"code": "const ed = document.querySelector('.CodeMirror')?.CodeMirror; if (!ed) return null; ed.setValue('print(1)'); return 'set';"}
```

## 框架内部状态（调试用）

```json
{"code": "const el = document.querySelector('#app'); const k = Object.keys(el).find(k => k.startsWith('__reactFiber$')); return k ? 'react' : (el.__vue_parent_component ? 'vue' : 'unknown');"}
{"code": "return Object.keys(window).filter(k => { try { return window[k] && typeof window[k].getState === 'function'; } catch { return false; } })"}
```

## 网络与性能观测（页面内视角）

```json
{"code": "window.__wsMsgs=[]; const OWS=window.WebSocket; window.WebSocket=function(u,p){const ws=new OWS(u,p); ws.addEventListener('message',e=>window.__wsMsgs.push({t:Date.now(),data:e.data})); const s=ws.send.bind(ws); ws.send=d=>{window.__wsMsgs.push({t:Date.now(),send:true,data:d}); return s(d);}; return ws;}; return 'injected';"}
```

```json
{"code": "window.__lt=[]; new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(e.duration>50)window.__lt.push({ms:Math.round(e.duration),at:Math.round(e.startTime)})})).observe({entryTypes:['longtask']}); return 'observing';"}
```

> 注入类模板在导航后会失效，需重新注入（或用 `Page.addScriptToEvaluateOnNewDocument` 级别的能力，目前通过 evaluate + 会话重放实现）。

## Canvas / 图形内文字

Canvas 内容无法通过 DOM 取到 → 用 `POST /snapshot/zoom {ref, scale:3}` 放大截图后由模型直接读图。
