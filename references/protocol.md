# Ark Web 协议参考（完整端点表 / 批量语法 / 命令映射）

> 按需查阅。日常使用看 `SKILL.md` 即可。

## 1. 完整端点表

所有端点都支持 `?tabId=<id>` 与 `?session=<id>`。**⚡ = 需 CDP 调试授权**（未启用时自动降级脚本模拟）。

### 页面控制
| 端点 | 说明 |
|---|---|
| `POST /open {url, current?}` | 新开标签页；`current:true` 复用当前标签页 |
| `POST /navigate {url}` | 当前标签页导航 |
| `POST /reload` `/back` `/forward` | 导航控制 |
| `GET /tabs` | 标签页列表 |
| `POST /tab/activate {tabId}` `/tab/close {tabId}` | 激活/关闭 |
| `POST /wait-for-load` `/wait-for-url` `/wait-for-text` | 事件驱动等待（10-40ms 响应）。`wait-for-load` 会识别"刚发生过导航"，不再把旧文档的 complete 当成加载完成（`afterAction`/`_pendingNav` 机制）。**v2.9.3**：页面第三方资源挂起（`load` 永不触发）时，DOM 就绪超 `stallGrace`(默认 3000ms) 即返回 `{success:true, partial:true, readyState:'interactive', note}`；服务端 cmd 超时跟随 body 的 `timeout`(+5s 余量) |
| `POST /wait-for-stable {timeout,quiet}` | 等 DOM 连续静默 `quiet` 毫秒（默认 500）且 `readyState=complete`，替代固定 sleep |
| `POST /wait-for-idle {timeout,idleTime,ignoreTypes,ignoreUrls}` | 等网络空闲（`networkidle` 等价物）：连续 `idleTime`（默认 500ms）无"进行中请求"且 `readyState=complete`。默认排除 `websocket`/`eventsource`；`ignoreUrls` 按子串排除。与 `wait-for-stable` 分工：idle 看网络（数据层），stable 看 DOM（渲染层），SPA 先 idle 再 stable 最稳 |
| `POST /reload-extension` | 让浏览器重载插件代码（自我更新）；重载后 CDP 授权失效，需重跑 `POST /debug/attach-all` |
| `POST /batch {steps:[{type,data}]}` | 一次往返执行多步 |

### 视觉
| 端点 | 说明 |
|---|---|
| `GET/POST /snapshot` | 截图 + 元素锚点（`annotate/full/format/quality/maxElements/selector/fast/compact/settle`） |
| `GET /snapshot/binary` | 二进制直出（`X-Snapshot-*` 头带锚点） |
| `POST /snapshot/zoom` | 裁剪放大：`{ref｜selector｜x,y,width,height, scale(1-5), format, quality}` |
| `POST /snapshot/text` | 可见文本块 + 紧致坐标（Range 取文本自身盒子）+ 字号：`{minLen,max,inViewOnly}` |
| `POST /act` | 高层动作（见下） |
| `GET /fast/snapshot` | 快路径别名（默认 `fast:true`，15s 超时） |

`/snapshot` 的 `compact=1` 返回定长数组，列定义见响应里的 `columns`：
`[ref, tag, role, x, y, w, h, flags, label]`，`flags` 字母含义 `d`=disabled `c`=checked `o`=occluded `v`=非视口内 `f`=已填值。

元素对象格式（非 compact）字段：`ref/tag/role/name/text/rect/center/visible` +
按需出现的 `disabled/checked/inputType/value/placeholder/href/expanded/inViewport/occluded`。

`POST /act` 支持的 action：

| action | 参数 | 说明 |
|---|---|---|
| `snapshot` | 同 `/snapshot` | 快照（默认 `fast:true`） |
| `clickRef` / `hoverRef` | `ref` | 按 SoM 编号操作（推荐） |
| `fillRef` | `ref`, `value` | React 兼容填值 |
| `readText` | `ref` | 读完整文本/值/属性 |
| `zoom` | `ref｜selector`, `scale`, `format` | 裁剪放大 |
| `find` | `text`, `limit`, `exact` | 按可见文本找元素（可点击优先排序），返回 ref/坐标 |
| `refs` | `steps:[{op:'click'｜'hover'｜'fill'｜'read', ref, value?}]` | 一次 HTTP 批量 ref 动作 |

`clickRef` / `fillRef` 支持后置等待：`waitFor: 'load'｜'url'｜'text'｜'selector'`（配 `pattern`/`text`/`selector`、`waitTimeout`），
点击与等待合并成一次调用。`waitFor:'load'` 在无导航发生时约 1.5s 后按 `no-navigation` 返回，不会空等超时。
| `click` | `selector`, `fast` | 选择器点击 |
| `clickText` | `text` | 按可见文本点击（快照坐标优先，evaluate 兜底） |
| `fill` | `fields:[{selector,value}]` | 批量填表 |
| `type` | `selector`, `text`, `mode` | 输入 |
| `extract` | `selectors:[...]` | 批量取值 |
| `navigate` | `url`, `current` | 导航 |
| `evaluate` | `code` | 执行 JS |

### 元素操作 ⚡
| 端点 | 说明 |
|---|---|
| `POST /mouse {type, x, y}` | 真实鼠标：`click/dblclick/rightclick/hover/move/down/up/wheel`。`x,y` 为视口 CSS 像素，与快照 `center` 同坐标系 |
| `POST /click` `/hover` `/dblclick` `/rightclick` | 按选择器操作 |
| `POST /drag {selector, targetSelector｜dx,dy}` | 拖拽 |
| `POST /scroll` `/scroll-by` `/scroll-into-view` | 滚动 |
| `POST /wait-for {selector, timeout, state}` | 等元素状态 |

### 键盘输入 ⚡
| 端点 | 说明 |
|---|---|
| `POST /key {key, modifiers}` | 按键（`Enter`/`Escape`/`Tab`/组合键…） |
| `POST /type {selector?, text, mode: fast｜human}` | 输入（内置回读校验，非 ASCII 自动降级） |
| `POST /fill {fields:[{selector,value}]}` | React 受控输入兼容（原生 setter + input 事件） |
| `POST /select` `/check` `/clear` `/focus` | 下拉/勾选/清空/聚焦 |

### DOM 查询（取精确值、回读表单）
`GET /page-info` `/dom` `/html` `/frames`⚡ `/layout`⚡ · `POST /query` `/query-all` `/query-many` `/exists` `/text` `/attr` `/value`（后三者有 `/get-*` 别名）

`query-all` 的 `fields` 仅支持 `tag/text/className/href/src/value/id/rect`（不支持 `alt`，用 `/attr` 或 evaluate）。

### JS 执行
`POST /evaluate {code, timeout}` — 支持 `await`；表达式/语句块自动兼容包装；CSP 报错自动 `setBypassCSP` 重试（结果含 `cspBypassed`）。

### 截图 / PDF ⚡
`GET /screenshot` · `GET /screenshot/full`（45s 超时） · `POST /screenshot/element`（35s） · `GET/POST /pdf {format}` · `POST /upload {selector, files}`

### 网络
`GET /network?filter=&limit=` · `POST /network/response {urlPattern}`⚡（文本响应预缓存 ≤2MB×100 条/tab） · `/network/block` `/unblock` `/conditions`⚡ `/conditions/reset` `/disable-cache` `/bypass-csp`⚡ `/clear`

### 性能 / 检查 / 聚合
`GET /performance` `/vitals`（LCP/CLS/TTFB/FCP/FID + 评级） `/resources` · `POST /cpu {rate}`⚡
`GET /security` `/a11y` `/seo`
`GET /full`（一次拿 DOM+性能+vitals+安全+a11y+seo，3s 缓存） · `GET /analyze-all` · `POST /monitor {interval,duration}` → `/monitor/stop` `/monitor/status`

### Cookie / Storage / 控制台 / 弹窗
`GET /cookies` `POST /cookie` `/cookie/remove` · `GET /storage?type=` `POST /storage` `/storage/remove` `/storage/clear`
`GET /console?limit=` `POST /console/clear` · `GET /dom-changes`
`POST /dialog {accept, promptText, auto}` · `GET /dialogs`

### 模拟 ⚡
`POST /device {device｜{width,height,dpr,mobile,userAgent}}` `/device/clear` · `/media` · `/geo`（跨导航 mock） · `/locale` · `/timezone` · `/auto-dark` `/js` `/hardware-concurrency`

### 审计 / 调试 / 清理
`POST /audit {url,budget,format,save}` · `GET /history?url=&limit=` · `POST /audit/run {urls}` → `GET /audit/status/<id>`
`POST /debug/attach-all`（= popup 启用调试） `/debug/detach-all` · `GET /debug/info` `/debug/cdp-status`
`POST /reset-all?tabId=` — 一键恢复 15 项（设备/媒体/geo/时区/语言/CPU/JS/并发/网络/CSP/缓存/暗色/高亮/弹窗策略/滚动 + **视觉残留**），幂等

### 基础
`GET /health`（**免鉴权**，自解释端点：`{ok, connected}` + `cli` 绝对路径 / `tokenFile` / `tokenHeader` / `usage` 推荐用法） · `GET /status`（含 `security` 段） · `GET /clear-cache`

---

## 2. chain / batch 语法

```powershell
# CLI 链式（一次 HTTP+WS 往返）
node client\browser-client.js chain "open https://x" "wait-load" "snapshot s.png --annotate" "click-ref 3" "read-text 3"

# 复杂/中文步骤写 UTF-8 JSON 文件
# steps.json = {"steps":[{"type":"open-url","data":{"url":"https://x"}}]}
node client\browser-client.js chain --body-file steps.json
```

直接调 `/batch` 时 `type` 必须用**插件命令名**（右列），CLI chain 会自动映射：

| CLI 名 | 插件 type | CLI 名 | 插件 type |
|--------|-----------|--------|-----------|
| open/goto/open-current/navigate | open-url（`current:true` 为复用当前页） | click/hover/dblclick/rightclick | click-element/hover-element/double-click/right-click |
| **click-ref / hover-ref** | **click-ref / hover-ref** | **fill-ref / read-text / zoom** | **fill-ref / read-text / zoom-shot** |
| page-info/dom/html/frames/layout | get-page-info/get-dom/get-html/get-frames/get-layout | drag/mouse | drag-element/mouse |
| query/query-all/query-many/exists/text/attr/value | query-selector/query-all/query-many/element-exists/get-text/get-attr/get-value | scroll/scroll-into-view/scroll-by | scroll-page/scroll-into-view/scroll-by |
| key/type/fill | simulate-key/type-text/fill-form | select/check/clear/focus | select-option/check-box/clear-field/focus-element |
| evaluate/wait-for/wait-load | evaluate/wait-for-selector/wait-for-load | snapshot | vision-snapshot |
| device/media/geo/timezone/locale | simulate-device/emulate-media/set-geolocation/set-timezone/set-locale | dialog/dialogs | dialog/get-dialogs |
| security/a11y/seo | security-check/a11y-check/seo-check | performance/vitals/resources | get-performance/get-web-vitals/get-resources |
| block/unblock/csp | block-urls/unblock-urls/bypass-csp | highlight/highlight-clear | highlight-elements/clear-highlights |
| cookies/storage/cookie | get-cookies/get-storage/set-cookie | console/dom-changes | get-console-logs/get-dom-changes |
| auto-dark/js/cpu/cpu-count | auto-dark-mode/set-script-disabled/set-cpu-throttling/set-hardware-concurrency | cleanup | reset-all-simulations |

**客户端本地步骤**（不走 `/batch`）：`full` `analyze-all` `monitor*` `report` `act/fast` `sleep <ms>`，以及带文件名的 `screenshot`/`snapshot`/`zoom`/`pdf`（存本地文件）。

### 速度默认值（已内建）

- `/batch` 支持 `data._parallel:true`（连续只读块 `Promise.all`，3-5×）、整批 `{timeout}`、步骤级 `data.timeout`；裸 batch 内 open-url 新标签页后续自动跟随。
- 只读缓存：`/page-info` 2s · `/dom` 1s · `/vitals` 5s · `/full` 3s；`?fresh=1` 绕过，`?ttl=<ms>` 自定义（0=禁用）。
- snapshot 缓存 400ms（命中 <5ms），写操作后自动失效。
- HTTP keep-alive 复用，单命令通信开销 1-5ms；插件断连立即拒绝挂起请求。

---

## 3. CLI 全局参数

| 参数 | 说明 |
|---|---|
| `--port <n>` / `--host <h>` / `--token <t>` | 连接参数（也可用 `ARK_PORT`/`ARK_HOST`/`ARK_TOKEN`）。**令牌默认自动从 `~/.ark-web/token` 读取**，通常无需传 |
| `--tabId <id>` | 固定目标标签页（所有请求自动带 `?tabId=`），多标签/多窗口下确定性定位 |
| `--session <id>` | 会话隔离 |
| `--body-file <path>` | POST body 从 UTF-8 JSON 文件读（中文安全通道） |

`client/ark-fast.js` 提供 SDK：`snapshot / click / clickRef / hoverRef / fillRef / readText / zoom / clickText / fill / extract / act / batch`。
