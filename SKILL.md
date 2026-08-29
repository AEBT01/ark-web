---
name: ark-web
description: AI 浏览器控制统一技能（文本 + 视觉二合一）。Chrome 插件 + Bridge Server (localhost:9333) 真实操控浏览器：导航/真实点击/表单填充/截图/PDF/网络模拟与响应体/设备媒体模拟/Web Vitals/30+ 维度审计引擎，117 端点。内置模型自检门——多模态模型启用视觉模块（snapshot 截图+坐标锚点+SoM 标注，无需选择器），纯文本模型走选择器工作流。使用场景：让 AI 操作浏览器、测试网页、抓取数据、视觉 QA、性能审计、多标签并行。
---

# Ark Web — AI 浏览器控制统一技能 v9（文本 + 视觉二合一）

> Chrome 插件 + Bridge Server 让 AI 真正操控浏览器并做专业级分析:真实鼠标键盘、真实设备/媒体模拟、整页截图、PDF、网络响应体、异步 JS、多标签并行、批量执行,以及 30+ 维度加权审计引擎。全部能力直接可跑,不依赖 puppeteer/CDP 端口。
> 本手册是唯一手册, 同时覆盖视觉与文本两种工作路径。

## 第 0 步 · 模型自检门(开工前必做, 决定你的工作路径)

**你是多模态模型吗?** 判据(任一成立即"是"): ①你的厂商文档/系统提示声明支持图像输入; ②你此前成功解析过图片。
也可直接实测: 发一次 `GET /snapshot`(见 §1.1), 若你能解读返回的 `dataUrl` 截图, 你就是视觉模型。

| 自检结果 | 工作路径 | 第一上下文 | 操作方式 |
|---|---|---|---|
| **多模态** | **视觉工作流 §1**(启用视觉模块) | `GET /snapshot` 截图+锚点 | 看图决策 → 坐标 `POST /mouse` / `POST /act` |
| **纯文本** | **文本工作流 §2** | `GET /page-info` + `POST /query-many` | 维护 CSS 选择器 → `POST /click {selector}` |

两条路径**共享全部端点/CLI/会话隔离/审计**, 随时混用: 视觉模型需要精确值/表单回读时用 DOM 端点补位(§1.4); 文本模型需要"看"布局时也可拍一张 snapshot 留证。多标签场景所有端点支持 `?tabId=<id>` 与 `?session=<id>`。

## 架构与文件位置

```
Chrome 插件 (extension/)  ◄──WS:9334──►  Bridge Server (server/)  ◄──HTTP:9333──►  AI / CLI / curl
  ├ background.js: CDP(chrome.debugger) 真实控制 + scripting 自动降级 + vision-snapshot 原子采集
  ├ content.js:    控制台/DOM/Storage 监控 + SW 保活
  └ popup:         连接状态 + 调试授权开关
```

- 插件: `extension/` (chrome://extensions 加载) · 服务器: `server/bridge-server.js` (+ `audit.js`/`audit-report.js`)
- 唯一 CLI: `client/browser-client.js` · Fast SDK: `client/ark-fast.js` · 别名: `ark.js` · 启动: `start.bat`
- 自检: `scripts/check-endpoints.js`(端点核对) `smoke-test.js`(95 项冒烟) `real-scenario-v3.js`(20 场景终测) `real-scenario-v4.js`(12 复杂情景)

## 快速开始 (三步)

```powershell
node server\bridge-server.js                      # 1. 启动服务器
Invoke-RestMethod http://localhost:9333/status    # 2. → connected: true (Chrome 已开且插件已装)
# 3. 点插件图标 → 「启用调试」(Chrome 136+ 必须, 开启 CDP 真实控制)
```

```bash
# macOS / Linux 等价
node server/bridge-server.js                      # 或 ./start.sh
curl http://localhost:9333/status
```

> server 重启后插件靠 alarms+keepalive 自动重连; 不生效时去 chrome://extensions 点「重新加载」。

## 配置 (端口 / 环境变量)

端口通过**环境变量**控制(不是命令行参数), 默认 `HTTP 9333` / `WS 9334`。**推荐只改 HTTP 端口, WS 端口保持默认** —— 插件后台 `extension/background.js:477` 硬编码连 `ws://localhost:9334`, 不读环境变量, 改了 WS 端口插件就 `connected:false`:

```bash
# macOS / Linux: 只改 HTTP 端口(推荐), WS 保持 9334
export BRIDGE_PORT=9335        # HTTP API (AI/CLI/curl 调用的端口)
node server/bridge-server.js   # 插件仍连 ws://localhost:9334, 不受影响

# 若确实要改 WS 端口: 必须同步改插件源码 background.js 的 this.serverPort=9334 → 新端口, 再重载插件
```

```powershell
# Windows PowerShell: 只改 HTTP 端口
$env:BRIDGE_PORT=9335; node server\bridge-server.js
```

改端口后: ① 用如上环境变量启动; ② 所有 curl 调用的 `:9333` 换成新端口; ③ **WS 端口(9334)保持默认**, 插件即可正常连接。若出现持续 `connected:false` 且已重载插件, 多半是 WS 端口被改了。
**注意**: CLI `browser-client.js` **不支持 `--port`**, 其入口固定用 `new BrowserClient({session})`(port 恒 9333)。若你的 CLI 换了 HTTP 端口, 需改用底层 `BrowserClient` 类构造时传 `{host, port}` 或直接 curl 到新端口, 不能用当前 CLI 传参调整。

**依赖安装**: 首次需 `cd server && npm install`(start.bat/start.sh 已自动执行)。依赖只在 `server/` 目录, 改端口不影响依赖。

> 更多运行时默认值(缓存 TTL、超时、会话轮询)见 §4 / §5, 无需配置, 已内建。

---

## §1 视觉工作流 (多模态模型首选)

### 1.1 Snapshot — 原子级视觉上下文 ⭐

一次 WS 往返 = **截图(dataUrl) + 交互元素锚点 + 页面元数据**, 等价旧式 `query-all + highlight + screenshot` 三合一。

| 能力 | 端点 | 说明 |
|------|------|------|
| 视觉快照 | `GET /snapshot?annotate=&full=&format=&quality=&maxElements=&selector=&fast=` / `POST /snapshot {同参数}` | 返回 `{dataUrl, url, title, viewport, elements:[{ref, tag, role, name, text, rect, center, visible}]}` |
| SoM 标注 | `?annotate=1` | 截图叠加 **1..N 编号气泡**, `elements[i].ref` === 气泡编号; 截图后自动清除不污染页面 |
| 整页快照 | `?full=1` | captureBeyondViewport 整页(布局/回归用); full+annotate 时标注仅视口可见 |
| 二进制直出 | `GET /snapshot/binary` | 返回 `image/*` 省 33% base64, 锚点在 `X-Snapshot-Elements` 头 |
| CLI | `node client/browser-client.js snapshot snap.png --annotate [--full] [--max 50] [--format jpeg]` | 存文件 + 打印 elements 映射 |

- **坐标系**: `elements[].rect/center` 为视口 CSS 像素, 与 `POST /mouse {x,y}` 完全一致, 无需换算。
- `maxElements` 默认 50(`fast:true` 时 30), 上限 120; `selector` 可限定锚点范围。
- **400ms 缓存**: 同参数连续 snapshot 命中 <5ms; 任何写操作后自动失效。需强制新鲜加 `?fresh=1`。
- `annotate` 滚动/操作后编号会失效 → 重新拍一张再决策。

### 1.2 标准闭环 (每次交互后重新看图)

```
1. GET /status                        # 插件连接确认
2. POST /open {url}                   # 或 /open {url, current:true}?tabId= 不新开 tab
3. POST /wait-for-load                # 事件驱动轮询 40ms
4. GET /snapshot?annotate=1           # ← 看图决策(模型直接读 dataUrl)
5. POST /mouse {type:"click", x, y}   # ← 用 elements[i].center; 表单仍用 /fill 最稳
6. GET /snapshot                      # ← 前后图对比验证 + 必要时 /get-value 校值
7. 任务结束 POST /reset-all?tabId=     # 一键恢复全部模拟
```

最小闭环(chain 一次往返):
```powershell
node client\browser-client.js chain "open https://www.bing.com" "wait-load" "snapshot snap1.png --annotate" "mouse click 640 518" "snapshot snap2.png"
```

### 1.3 Fast API — 一次 HTTP 完成高层意图 (最快路径)

| 能力 | 端点 | 说明 |
|------|------|------|
| 一键行为 | `POST /act {action, ...}` | action: `snapshot / click / clickText / fill / type / extract / navigate / evaluate`, 单 HTTP 往返; 服务端 `snapshot→mouse` 只 1 RTT |
| 文本点击 | `POST /act {action:"clickText", text:"登录"}` | 服务端 snapshot 找文本→坐标点击, evaluate 兜底 |
| 批量提取 | `POST /act {action:"extract", selectors:["#price",".title"]}` | 1 WS |
| 快照别名 | `GET /fast/snapshot` | 默认 `fast:true` 15s |
| JS SDK | `client/ark-fast.js` → `new ArkFast()` `.snapshot() .click() .clickText() .fill() .extract() .act()` | 内置 per-tab + 400ms 缓存 + binary |

### 1.4 混合策略 (视觉为主, DOM 补位)

| 场景 | 首选 | 原因 |
|------|------|------|
| 首屏理解/找按钮/判断加载完成 | snapshot | 一眼可见, 不猜选择器 |
| 表单填值/读精确数值/隐藏字段 | `POST /fill` + `POST /get-value` 回读 | DOM 值比视觉精确 |
| 视觉缺陷(错位/遮挡/溢出/配色/响应式) | snapshot 前后对比 + `?full=1` | DOM 无法感知 |
| Shadow DOM / Canvas / 复杂组件 | snapshot 定位 + `evaluate` 穿透 | `el.shadowRoot.querySelector` |
| 需固化 CI 脚本 | snapshot 探索 → 沉淀 selector | 探索期视觉, 沉淀期选择器 |

响应式/暗色等视觉 QA: `POST /device {device:"iPhone 14"}` → snapshot → `/device/clear` → snapshot 对比; `POST /media {features:[{name:"prefers-color-scheme",value:"dark"}]}` 同理。

### 1.5 视觉推理铁律

1. **先看再动**: 导航/点击/输入后先 snapshot 看真实渲染, 不盲猜 DOM。
2. **坐标即真理**: `center` 与 `/mouse` 同坐标系; `annotate` 编号与 `ref` 一一对应。
3. **首屏用视口 snapshot, 布局/长列表用 `?full=1`**。
4. **视觉验证优先, URL 参数二次校验**(排序/翻页看 URL: `first=11`、`s=stars&o=desc`)。
5. **遮挡先处理**: 截图见弹层/下拉/Toast → `mouse` 点空白 / `key Escape` / `scroll`, 再操作目标。
6. **表单双通道**: 输入用 `fill`(React 兼容), 视觉确认; 提交后 snapshot 看成功态。
7. **失败即数据**: 登录墙/限流/验证码截图直接可见, 如实记录, 不伪造。

---

## §2 文本工作流 (纯文本模型 / CI 脚本沉淀)

```
1. GET /status → 2. GET /page-info → 3. POST /query-many {selectors:[...]}   # 一次拿多个元素状态
4. POST /click / /fill / /type / /key → 5. GET /page-info 验证 → 6. 失败恢复: POST /wait-for / /wait-for-url
```

**选择器铁律(实测沉淀)**:
1. **先探后写**: 任何站先 `/query-all` 拿真实结构, 旧文档选择器大量已失效。
2. **验证用 URL/DOM 状态而非 sleep**: 排序看 `s=stars&o=desc`, 翻页看 `first=11`, 登录看标题。
3. `query-all` 的 fields 仅支持 `tag/text/className/href/src/value/id/rect`(**不支持 alt/url**, 用 `/attr` 或 evaluate)。
4. 点击/填充前 `/query` 确认 `found/visible`; 无效时 `/scroll-into-view` 后重试。
5. **shadow DOM 站点**(MDN/unsplash): query 查不到, 用 evaluate `el.shadowRoot.querySelector` 深度穿透。
6. React 受控输入不要 evaluate 直接改 value: 用 `/fill`(原生 setter + input 事件)。
7. 重定向链接(必应 `ck/a`+`u=a1` base64url)解码后 `open {current:true}` 直连; `target=_blank` 新 tab 不属会话。
8. 后台 tab 视口=0 时点击/滚动静默失效 → 先 `POST /tab/activate?tabId=`。
9. 节流/降级时 React/jQuery UI 控件不吃脚本事件: evaluate 自组完整事件流 `pointerdown→mousedown→pointerup→mouseup→click`(Radix 需 `detail:1`)。
10. 失败也是数据: 登录墙/限流/验证码如实记录, 不伪造。

---

## §3 能力速查 (统一端点表, 117 个)

**⚡ = 需 CDP 调试授权**(未启用自动降级脚本模拟)

| 域 | 端点 |
|----|------|
| 页面控制 | `POST /open {url, current?}` · `/navigate` · `/reload` · `/back` `/forward` · `GET /tabs` · `POST /tab/activate` `/tab/close` · `/wait-for-load` `/wait-for-url` `/wait-for-text` · `/batch` |
| DOM 查询 | `GET /page-info` `/dom` `/html` `/frames`⚡ `/layout`⚡ · `POST /query` `/query-all` `/query-many` `/exists` `/text` `/attr` `/value`(后三名有 `/get-*` 别名) |
| 元素操作⚡ | `POST /click` `/hover` `/dblclick` `/rightclick` `/drag {selector,targetSelector\|dx,dy}` · `/mouse {type,x,y}`(视觉首选) · `/scroll` `/scroll-by` `/scroll-into-view` · `/wait-for {selector,timeout,state}` |
| 键盘输入⚡ | `POST /key {key,modifiers}` · `/type {selector?,text,mode:fast\|human}` · `/fill {fields:[{selector,value}]}`(React 兼容) · `/select` `/check` `/clear` `/focus` |
| JS 执行 | `POST /evaluate {code,timeout}` 支持 await, CSP 自动 bypass 重试 |
| 截图/PDF⚡ | `GET /screenshot` `/screenshot/full` · `POST /screenshot/element` · `GET/POST /pdf` · `POST /upload {selector,files}`⚡ |
| 视觉 | `GET/POST /snapshot` · `/snapshot/binary` · `/fast/snapshot` · `/act` |
| 弹窗⚡ | `POST /dialog {accept?,promptText?,auto?}` · `GET /dialogs` — 默认事件驱动自动应答 |
| 高亮 | `POST /highlight {selector,color,label}` · `/highlight/clear` |
| Cookie/Storage | `GET /cookies` `POST /cookie` `/cookie/remove` · `GET /storage?type=` `POST /storage` `/storage/remove` `/storage/clear` |
| 网络 | `GET /network?filter=&limit=` · `POST /network/response {urlPattern}`⚡(文本响应预缓存 ≤2MB×100条/tab) · `/network/block` `/unblock` `/conditions`⚡ `/conditions/reset` `/disable-cache` `/bypass-csp`⚡ `/clear` |
| 性能 | `GET /performance` `/vitals`(LCP/CLS/TTFB/FCP/FID+评级) `/resources` · `POST /cpu {rate}`⚡ |
| 模拟⚡ | `POST /device {device\|自定义}` `/device/clear` · `/media` · `/geo`(跨导航 mock) `/locale` `/timezone` · `/auto-dark` `/js` `/hardware-concurrency` |
| 检查 | `GET /security`(HTTPS/CSP/HSTS/混合内容) `/a11y`(alt/label/目标尺寸) `/seo`(title/OG/结构化数据) |
| 控制台 | `GET /console?limit=`(CDP 捕获) `POST /console/clear` · `GET /dom-changes` |
| 聚合 | `GET /full`(DOM+性能+vitals+安全+a11y+seo 一次, 3s 缓存) · `GET /analyze-all`(全 tab 并行限流3) · `POST /monitor {interval,duration}` → `/monitor/stop` `/monitor/status` |
| 调试 | `POST /debug/attach-all`(=popup 启用调试) `/debug/detach-all` · `GET /debug/info` `/debug/cdp-status`(throttled 查看) |
| 清理 | `POST /reset-all?tabId=` 一键恢复 15 项(设备/媒体/geo/时区/语言/CPU/JS/并发/网络/CSP/缓存/暗色/高亮/弹窗策略/滚动), 幂等 |

设备预设: iPhone 14 / 14 Pro Max / SE、iPad、iPad Pro、Pixel 7、Galaxy S23、Desktop + 自定义 `{width,height,dpr,mobile,userAgent}`。

---

## §4 chain / batch 与速度

```powershell
# CLI 链式(一次 HTTP+WS 往返; CLI 名自动映射插件命令)
node client\browser-client.js chain "open https://x" "wait-load" "page-info" "screenshot shot.png"
# 复杂/中文步骤写 UTF-8 JSON 文件: steps.json = {"steps":[{"type":"open-url","data":{...}}]}
node client\browser-client.js chain --body-file steps.json
# 直接 /batch: type 必须用插件命令名(open-url/get-page-info/click-element/vision-snapshot/mouse...)
curl -X POST http://localhost:9333/batch -d '{"steps":[{"type":"get-page-info"},{"type":"evaluate","data":{"code":"return document.title"}}]}'
```

CLI 名 → 插件 type 映射(直接 /batch 必须用右列):

| CLI 名 | 插件 type | CLI 名 | 插件 type |
|--------|-----------|--------|-----------|
| open/goto | open-url | click/hover/dblclick/rightclick | click-element/hover-element/double-click/right-click |
| open-current/navigate | open-url(current:true) | drag/mouse | drag-element/mouse |
| page-info/dom/html | get-page-info/get-dom/get-html | scroll/scroll-into-view/scroll-by | scroll-page/scroll-into-view/scroll-by |
| query/query-all/query-many | query-selector/query-all/query-many | key/type/fill | simulate-key/type-text/fill-form |
| exists/text/attr/value | element-exists/get-text/get-attr/get-value | select/check/clear/focus | select-option/check-box/clear-field/focus-element |
| evaluate/wait-for/wait-load | evaluate/wait-for-selector/wait-for-load | snapshot | vision-snapshot |
| device/media/geo/timezone/locale | simulate-device/emulate-media/set-geolocation/set-timezone/set-locale | dialog/dialogs | dialog/get-dialogs |
| security/a11y/seo | security-check/a11y-check/seo-check | performance/vitals/resources | get-performance/get-web-vitals/get-resources |
| block/unblock/csp | block-urls/unblock-urls/bypass-csp | highlight/highlight-clear | highlight-elements/clear-highlights |
| cookies/storage/cookie | get-cookies/get-storage/set-cookie | console/dom-changes | get-console-logs/get-dom-changes |
| auto-dark/js/cpu/cpu-count | auto-dark-mode/set-script-disabled/set-cpu-throttling/set-hardware-concurrency | cleanup | reset-all-simulations |

客户端本地步骤(不走 /batch): `full` `analyze-all` `monitor*` `report` `act/fast` `sleep <ms>` 及带文件名的 `screenshot/snapshot/pdf`(存本地)。

**速度默认值(已内建, 无需配置)**:
- `/batch` 一次往返多步; 步骤 `data._parallel:true` 连续只读块 `Promise.all` 3-5×; 支持 `{timeout}` 整批 + 步骤级 `data.timeout`; 裸 batch 内 open-url 新 tab 后续自动跟随。
- snapshot 400ms 缓存命中 <5ms; 只读端点缓存 1-5s(`/page-info` 2s `/dom` 1s `/vitals` 等 5s `/full` 3s), `?fresh=1` 绕过, `?ttl=<ms>` 自定义(0=禁用); 写操作自动失效相关缓存。
- `waitFor*` 事件驱动 10-40ms 响应; HTTP keep-alive 复用, 单命令通信开销 1-5ms; 插件断连立即拒绝挂起请求。
- **反模式**: 不要固定 sleep 等待(用 wait-*); 不要循环单查(用 query-many/一次 /full); 视觉模型不要先 query-many 探针(直接 snapshot); 相同参数 snapshot 不必重复拍(有缓存)。

---

## §5 多标签并行 & 会话隔离 (多子代理互不干扰)

```
POST /session/create                    → {sessionId}
POST /session/tab {sessionId, url}      → 新开标签页自动归属会话(默认后台打开不抢焦点)
POST /session/assign {sessionId, tabId} → 绑定已有标签页
GET  /session                           → 会话列表 + tabIds
POST /session/release {sessionId, tabId?} → 解绑
POST /session/delete {sessionId, closeTabs?} → 删除会话(closeTabs:true 连标签页一起关, 自动保留 ≥1 个标签页防整窗关闭)
```

规则(server 硬保证, 无需调用方自觉): 带 `?session=<id>`(或 `X-Session` 头)的请求**只能操作本会话标签页**, 越权 403; 单 tab 会话免传 tabId 自动路由, 多 tab 会话必须显式 `?tabId=`; 会话内 `/open`(新建)自动归属; `/batch` 自动注入会话 tabId 到每步; 弹窗策略/设备/媒体/CSP 均 per-tab 隔离。

- **不干扰用户浏览**: `session/tab` 后台开页 + focus emulation 下点击/输入均可执行, 用户当前标签页焦点不被抢占; 需交互才 `/tab/activate`; 手动模式弹窗 60s 自动回退不卡死页面。
- **任务结束必清理**: `POST /session/delete {closeTabs:true}`(会话场景) 或 `POST /reset-all?tabId=`(共享 tab 场景)。

---

## §6 中文 / UTF-8 安全通道

PowerShell 5.1 命令行中文会被 GBK 损坏(表现为 `400 无效 JSON body` 或输入变 `?`)。**中文一律不进命令行**:

```powershell
# kw.json (UTF-8 无 BOM) = {"selector":"#kw","text":"天气"}
node client\browser-client.js type --body-file kw.json          # 推荐: --body-file
# PowerShell 字节流:
$b = [System.Text.Encoding]::UTF8.GetBytes((Get-Content -Raw -Encoding UTF8 kw.json))
Invoke-RestMethod http://localhost:9333/type -Method Post -Body $b -ContentType 'application/json; charset=utf-8'
```

- 读取中文结果存文件再看: `... | ConvertTo-Json -Depth 5 | Out-File r.json -Encoding UTF8`(bash 控制台乱码是显示层, 数据是 UTF-8)。
- `type` 已内置回读校验: 中文损坏自动降级脚本路径(夸克内核 insertText 对非 ASCII 不稳定), 无需处理; 联想下拉干扰时改 `/key Enter` 或 URL 直达。
- `POST /batch` 的坏 JSON 返回 `400 {error, 收到(前120字符)}` 可直接排障。

---

## §7 弹窗处理 ⚡ (事件驱动)

- 默认 `autoAccept:true`: `Page.javascriptDialogOpening` 事件内同步自动确认, 不阻塞渲染线程, 挂起命令自然恢复 — **不卡流程, 无需预处理**。
- 需人工决策: `POST /dialog {auto:false}` 切手动(per-tab 隔离) → 弹窗挂起, 交互命令返回 `{dialogPending:true}` 友好错误 → `POST /dialog {accept, promptText}` 应答; 60s 无应答自动回退自动模式(防 agent 失联卡死用户页面)。
- `GET /dialogs` 每条带 `handled: auto|pending|closed|auto-fallback`; 对已处理弹窗再 POST 返回 `{reason:'already-handled'}`(非错误)。

## §8 审计引擎 (30+ 维度加权评分)

```powershell
POST /audit {url?, budget?, format?: json|md|html, save?}   # 采集→5类加权评分(0-100)→洞察→ROI机会
GET  /history?url=&limit=                                    # JSONL 趋势对比
POST /audit/run {urls:[...]} → GET /audit/status/<id>        # URL 队列异步审计
node client\browser-client.js audit-html perf.html           # HTML 单文件报告
```

评分构成: 性能 30% / 可访问性 20% / 安全 20% / SEO 15% / 资源效率 15%, 30+ 规则(参考 Lighthouse 阈值)。结果含 `scores`(每规则明细) `insights`(确定性根因, 如 "TTFB 慢→查后端与 CDN") `opportunities`(ROI 排序+预估节省) `ai`(AI 可读紧凑格式) `metrics`(趋势快照)。预算: `budget:{lcp,ttfb,cls,totalKB,requests}` 超限产生 violations。
AI 工作流: `POST /audit {save:true}` → 读 `ai` 字段出修复方案 → 修复后重审 + `GET /history` 对比。视觉模型叠加 `GET /snapshot?full=1` 作定性证据。

---

## §9 evaluate 高频模板

```json
{"code": "return { title: document.title, cookies: document.cookie }"}
{"code": "await fetch('/api/user').then(r => r.json())"}
{"code": "return Array.from(document.querySelectorAll('img[alt]')).map(i => i.alt).filter(Boolean).slice(0, 20)"}
```

React 受控输入(节流降级时) / shadow DOM / Monaco 编辑器:
```json
{"code": "const el = document.querySelector('#kw'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(el,'天气'); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value;"}
{"code": "const t = document.querySelector('mdn-search-modal'); const inp = t.shadowRoot.querySelector('input[name=q]'); /* 同上 setter+input */ return inp.value;"}
{"code": "monaco.editor.getModels()[0].setValue('const x = 42;'); return 'set';"}
{"code": "window.__wsMsgs=[]; const OWS=window.WebSocket; window.WebSocket=function(u,p){const ws=new OWS(u,p); ws.addEventListener('message',e=>window.__wsMsgs.push({t:Date.now(),data:e.data})); const s=ws.send.bind(ws); ws.send=d=>{window.__wsMsgs.push({t:Date.now(),send:true,data:d}); return s(d);}; return ws;}; return 'injected';"}
{"code": "window.__lt=[]; new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(e.duration>50)window.__lt.push({ms:Math.round(e.duration),at:Math.round(e.startTime)})})).observe({entryTypes:['longtask']}); return 'observing';"}
```
框架调试: React fiber `__reactFiber$` / props `__reactProps$`; Vue `el.__vue_parent_component?.setupState`; Zustand/Redux `Object.keys(window).filter(k => window[k]?.getState)`; localStorage 全量 `Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]))`。

---

## §10 站点实测速查 (2026-08 有效选择器, 2000+ 样本沉淀)

- **百度**: `#kw`/`#su`, 结果 `h3`(首位常是聚合/广告卡); 联想干扰用 Enter 或 URL `/s?wd=` 直达
- **必应**: 结果 `li.b_algo h2 a`; 翻页 `#b_results nav a`(first 偏移以实际 href 为准); 时间筛选 `filters=ex1:"ez1..ez5"` 链接直达
- **GitHub**: 搜索直达 `/search?q=&type=repositories`, 结果 `h3 a`; star `a[href$="/stargazers"]`; 排序按钮 `data-testid="sort-button"`(验证 `s=stars&o=desc`); 语言 chip id 会话随机先查后点
- **IMDb**: 榜单 `li.ipc-metadata-list-summary-item` 一条拿全; 评分 `[data-testid=hero-rating-bar__aggregate-rating__score]`; 详情页双套 DOM 按可见性过滤
- **MDN**: 搜索在 shadow DOM(`mdn-search-modal` + 原型 setter); 结果 `dialog ul a`; 兼容表双层 shadow 需滚动懒加载
- **Wolfram**: 结果值在 `img[alt]`(evaluate 遍历); 唯一 textarea 先 clear; 知识查询等 10-15s
- **saucedemo**: standard_user/secret_sauce; 按钮 `button[data-test*=<slug>]`; 排序 `/fill` 触发 React onChange
- **demoqa**: 左菜单 `a[href="/xxx"]`; radio 点 `label[for=]`; 拖拽自组事件流; dragabble 页 URL 是 `/dragabble`
- **douban**: 搜索"错误103"限流(换中文词); 详情直连 `subject/<id>`; 评分 `.rating_num`
- **amazon**: 结果 `div[data-component-type="s-search-result"] h2 span`; 详情 `#productTitle`/`.a-price .a-offscreen`; `/sspa/` 广告跳过
- **其余**: rottentomatoes `[data-qa]`(shadow); typescriptlang `#run-button`+Monaco; pypi 裸 `h1` 含版本(验证 URL `o=-created`); w3schools Tryit CodeMirror `.setValue()`+`#runbtn`+`#iframeResult`; unsplash alt 用 evaluate, 详情直达 `/photos/<slug>`; dev.to 反应数 `#reaction_total_count`; 小红书/知乎/淘宝/B站/京东: 搜索 URL 直达 + 登录墙如实记录

---

## §11 故障排查 (合并去重版)

| 症状 | 原因与解决 |
|------|-----------|
| `Chrome 插件未连接` | 插件未装/Chrome 未开/server 未启动 → `GET /status` 看 connected |
| `400 无效 JSON body: ... 收到(前120字符)` | 命令行中文被 GBK 损坏 → 走 §6 文件通道 |
| `403: session xxx 未绑定标签页 N` | 越权访问他会话 tab(正常防护) → `/session/assign` 或换自己会话 |
| 会话内报 `必须显式指定 ?tabId=` | 多标签页会话 → 加 `?tabId=` |
| 导航后页面没变/跑到别的 tab | 确认请求带 `?tabId=`/`?session=`; 插件旧版则重载 |
| server 重启后 connected 持续 false | SW 休眠重连未运行 → chrome://extensions「重新加载」 |
| `需要 CDP` / debugger attach 失败 | Chrome 136+: 点插件图标 →「启用调试」; 重载插件/重启浏览器后授权失效需重开 |
| 点击/悬停突然每步 ~5s | **授权窗口过期**(CDP throttled) → 已自动降级脚本事件(毫秒级); `GET /debug/cdp-status` 看 throttled; 恢复真实轨迹重开「启用调试」 |
| 点击无效但元素存在 | 被遮挡或后台 tab 视口=0 → `/query` 看 visible, `/scroll-into-view`, 必要时 `/tab/activate` |
| 拖拽/滑块无反应 | 脚本合成事件对 jQuery UI/react-draggable 无效 → evaluate 自组 mousedown→mousemove×N→mouseup; 校验看 `input.value` 而非显示框 |
| React/jQuery 控件不吃脚本事件 | evaluate 完整事件流 pointerdown→mousedown→pointerup→mouseup→click(Radix 需 detail:1); 输入用原生 setter+input 事件 |
| `evaluate` 报 CSP/unsafe-eval | 已自动 setBypassCSP 重试(结果带 cspBypassed); 仍失败说明 CDP 通道故障 |
| batch 报 `Unknown command` | /batch 的 type 必须是插件命令名(open-url/...), CLI chain 会自动映射 |
| 中文输入变 `?` | type 已自动回读降级; 手动复现换 `/fill`; 命令行中文永远走 `--body-file` |
| 弹窗卡住自动化 | 默认自动应答不应卡; 手动模式用 `POST /dialog {accept}` 应答; `GET /dialogs` 看状态; 60s 自动回退 |
| 响应体获取失败 | 非文本类/超大(>2MB)不预缓存 → `GET /network` 确认 URL, 换文本类请求 |
| 控制台日志为空 | 页面加载早于插件启用 → 刷新页面 |
| `No current window` | 最后一个标签页被关连带关窗 → 开任意新标签页恢复 |
| snapshot 返回 `No active tab` / 全白 | 无标签页或页面未加载完 → `GET /tabs` 确认; 先 `/wait-for-load` |
| annotate 编号与视觉不对应 | 页面滚动后位置变化 → 重新 `snapshot?annotate=1` |
| 坐标点击无效 | 元素被遮挡/视口外 → 看 snapshot 遮挡, `scroll-into-view` 后重拍 |
| `chrome-error://chromewebdata` | 站点不可达(网络/被墙) → 换 MDN/apache/iana 或本地 mock |
| 站点限流/登录墙/验证码 | 豆瓣"错误103"换词重试、京东登录墙、CF 拦截: 如实记录, 等待 10-60s 可恢复 |
| 页面一直 loading | `reload` + 等 6s 是通用恢复手段(必应/amazon 实测) |
| `query-all` 拿不到 alt/shadow 元素 | fields 不支持 alt; shadow 不穿透 → `/attr`、evaluate 深穿透 |
| 授权后首次点击 ~20s / evaluate 含 await ~1s | CDP 通道预热 / awaitPromise 固有轮询, 正常现象 |

---

## §12 常用配方 (一行流, 直接可用)

```bash
# 搜索并取结果标题(文本路径): chain 一次往返
node client/browser-client.js chain "open https://www.bing.com/search?q=ark+web" "wait-load" "query-all li.b_algo h2 a 10"
# 表单登录/提交: 中文走文件, 提交后 URL 验证
node client/browser-client.js fill --body-file f.json && node client/browser-client.js chain "click #submit" "wait-for-url dashboard"
# 整页证据/视觉回归: 前后各一张 full 快照对比
node client/browser-client.js snapshot before.png --full
# 性能体检: 审计 + HTML 报告(加 save:true 写入趋势历史, 见 §8)
node client/browser-client.js audit-html report.html https://target
# 多 agent 并行: 建会话→后台开页→--session 全程隔离→结束删会话
node client/browser-client.js session-create
# 抓接口响应体: 先看网络日志定位 URL, 再按 urlPattern 取 body
node client/browser-client.js network filter api && node client/browser-client.js response-body /api/list
# 页面弹窗不卡流程(默认自动应答); 需人工决策时链内切手动再应答
node client/browser-client.js chain "click #del" "dialog auto off" "dialog accept" "dialog auto on"
```

---

## §13 安全须知

- Bridge Server 绑定 localhost **无鉴权**: 本机任意进程可完全控制浏览器与 `/evaluate` 任意代码执行 — 仅本机可信环境使用, 不要在不可信环境运行。
- 调试中避免输入真实密码; 截图/PDF/响应体可能含敏感信息, 注意脱敏。

## 版本说明

- **v9(本文件)**: 单一手册覆盖视觉与文本双工作流, 模型按第 0 步自检门自行选择路径。
- 运行时版本以 `extension/manifest.json` 为准; 升级只需 `chrome://extensions` 重载插件 + 重启 server, 历史见 `CHANGELOG.md`。
