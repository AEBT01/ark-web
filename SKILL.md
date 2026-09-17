---
name: ark-web
description: 视觉优先的浏览器操控技能。通过浏览器扩展 + 本机 Bridge Server 真实操控 Chrome/夸克等 Chromium 浏览器：截图理解页面、按编号直接点击/填表、放大读小字、视觉 QA、性能审计、数据抓取、多标签并行。当需要打开网页、点击、填表、截图、抓取页面数据、测试网页、排查页面问题、做性能/可访问性审计时使用。
---

# Ark Web — AI 浏览器控制技能 v3.0.2（视觉优先）

> 真实浏览器（Chrome / 夸克等 Chromium 内核）+ 真实鼠标键盘。工作方式是**看图决策**：先截图拿到页面与可交互元素编号，再按编号操作，不依赖猜测 CSS 选择器。
> 能力覆盖：导航 / 点击 / 填表 / 上传 / 截图放大 / PDF / 网络响应体 / 设备与媒体模拟 / Web Vitals / 30+ 维度审计 / 多标签并行。

## 兄弟技能引导：检索先行（ark-seek）

- **本技能（ark-web）管"逛"**：浏览器交互、登录态页面、渲染后动态内容、视觉 QA、审计。
- **兄弟技能 ark-seek 管"查"**（`C:\Users\画扇\.agents\skills\ark-seek`）：直连 40+ 官方 API 免费检索（学术文献/网页/新闻/图片/专利/财报/数据集/行情/科学数据），快、稳、免登录、带缓存与 SSRF 防护——**凡是要"查信息"而不需要浏览器交互的，先走 ark-seek，别开浏览器**。

```powershell
& "$env:USERPROFILE\.agents\skills\ark-seek\scripts\lit.ps1" -Cmd search -Src openalex -Q "query" -N 10   # 学术
& "$env:USERPROFILE\.agents\skills\ark-seek\scripts\web.ps1" -Cmd search -Src bing -Q "query" -N 10       # 网页/新闻/代码
```

- **典型降级链**：ark-seek 检索（返回 `meta.failed` 如实报告）→ 场景属反爬/登录墙/无 API（OpenReview/Google Scholar/知网/百度学术/Google Patents 网页/反向图搜）→ 才用本技能只读浏览兜底。
- 两者平级独立、互不依赖；安全红线同源（只读优先、登录墙/验证码如实报告并停止、不伪造结果）。

## 0. 开工前自检（必做，30 秒）


### 0.1 三条铁律

1. **先 cd 到项目目录**（本手册所有相对路径都以它为准）：
   ```powershell
   cd "$env:USERPROFILE\browser-debug-extension"     # Windows
   ```
   ```bash
   cd ~/browser-debug-extension                       # macOS / Linux
   ```
   本机固定位置就是这里；若你把仓库复制到别处（例如 agent 的技能目录），cd 到那一份即可。
   不想 cd 就用绝对路径调 CLI（`/health` 会返回该绝对路径）。

2. **优先用 CLI**：`node client/browser-client.js`（或别名 `node ark.js`）**会自动读取令牌**，永不 401。
   直接用 HTTP / curl 时才需要手工带令牌。

3. **令牌位置**（不是 `server/.ark-token`，那是旧路径）：
   ```powershell
   Get-Content "$env:USERPROFILE\.ark-web\token" -Raw    # Windows
   ```
   ```bash
   cat ~/.ark-web/token                                   # macOS / Linux
   ```
   所有 HTTP 请求带 `-H "X-Ark-Token: <令牌>"`（或 `Authorization: Bearer <令牌>`、`?token=<令牌>`）。
   **唯一免鉴权端点**：`GET /health`。

### 0.2 三步验证（复制即可）

```powershell
curl.exe -s http://127.0.0.1:9333/health                    # ① 免鉴权; 返回 connected/cli 绝对路径/令牌位置/推荐用法
node client\browser-client.js status                        # ② 需令牌但 CLI 自动带 → 看 connected: true
node client\browser-client.js tabs                          # ③ 能列出标签页即完全可用
```

`/health` 返回示例（**新接入的 AI 先读它，就知道该用什么命令、令牌在哪**；`cli` 实际输出当前运行 server 的绝对路径，会随部署位置变化，以下仅为示例）：

```json
{ "ok": true, "connected": true,
  "cli": "<运行中 server 的绝对路径>\\client\\browser-client.js",
  "tokenFile": "C:\\Users\\<你>\\.ark-web\\token", "tokenHeader": "X-Ark-Token",
  "usage": { "preferred": "node \"...\\browser-client.js\" status   (CLI 会自动读取令牌, 推荐)" } }
```

服务没起时：`node server\bridge-server.js`（或 `start.bat` / `./start.sh`）。

### 0.3 连接异常速查（**先看这张表再怀疑代码**）

| 症状 | 原因 | 处置 |
|---|---|---|
| `401: 缺少或错误的访问令牌` | 直接 HTTP 调用没带令牌 | 带上 `X-Ark-Token`；或改用 CLI（自动带） |
| `插件未连接` / `connected: false` | 浏览器没开 / 插件没加载 / 未点「启用调试」 | 打开浏览器 → `chrome://extensions` 加载 `extension/` → popup 点「启用调试」 |
| **`connected: true` 但命令全部超时** | **僵尸连接**：插件重载或浏览器休眠后残留的旧连接 | ① 已内建自愈：超时会自动换连接重试（8s），120s 静默自动清理；② 仍不行则重启 server；③ 看 `/status` 的 `connections[]`（`suspect:true` 即可疑连接） |
| 只有部分命令超时 | 页面被模态弹窗阻塞 / 渲染忙 | `GET /dialogs` 看弹窗；`POST /dialog {auto:true}`；`POST /tab/activate` 激活标签页 |
| 命令报 `需要 CDP` | 调试授权过期（插件重载/浏览器重启后必失效） | `node client/browser-client.js debug-on`（等价 `POST /debug/attach-all`，**无需点 popup**） |
| 夸克浏览器下行为差异 | 夸克内核（Chromium 套壳）个别 CDP 域不支持 | 见 `references/troubleshooting.md`「夸克 / 非 Chrome 内核」节；插件上报的 `browser` 字段可确认真实内核 |

## 1. 视觉工作流（核心）

### 1.1 Snapshot —— 原子级视觉上下文 ⭐

一次请求 = **截图 + 可交互元素锚点 + 页面元数据**。

| 能力 | 端点 |
|------|------|
| 视觉快照 | `GET /snapshot?annotate=&full=&format=&quality=&maxElements=&selector=&fast=&compact=&settle=` · `POST /snapshot {同参数}` |
| SoM 标注 | `?annotate=1` → 截图叠加 **1..N 编号气泡**，`elements[i].ref` 即气泡编号 |
| 整页快照 | `?full=1`（布局/长页面用） |
| **紧凑输出** | `?compact=1` → 元素变定长数组 `[ref,tag,role,x,y,w,h,flags,label]`，实测**元素 JSON 省 77~81%** |
| **稳定后再拍** | `?settle=1` → 先等 DOM 稳定再采集，避免拍到"过渡态"（部分站点先渲染窄版再切桌面） |
| 二进制直出 | `GET /snapshot/binary`（省 33% base64，锚点在 `X-Snapshot-Elements` 头） |
| 放大读小字 | `POST /snapshot/zoom {ref｜selector｜x,y,width,height, scale, format}` |
| **免截图读页面** | `POST /snapshot/text {minLen,max}` → 可见文本块 + 紧致坐标 + 字号 |
| CLI | `node client\browser-client.js snapshot snap.png --annotate --compact --format webp` |

返回结构（`compact` 关闭时）：

```json
{ "dataUrl": "data:image/webp;base64,...",
  "url": "...", "title": "...",
  "viewport": { "width": 1440, "height": 900, "dpr": 1, "scrollX": 0, "scrollY": 320 },
  "elements": [
    { "ref": 1, "tag": "BUTTON", "role": "button", "name": "登录", "text": "登录",
      "rect": { "x": 620, "y": 412, "width": 96, "height": 36 },
      "center": { "x": 668, "y": 430 }, "visible": true } ] }
```

`compact=1` 时 `elements` 为 `[ref,tag,role,x,y,w,h,flags,label]`，列定义见响应里的 `columns`。
`flags` 字母：`d`=disabled、`c`=checked、`o`=occluded（被遮挡）、`v`=不在视口内、`f`=已填值。

**元素字段里的决策信号**（对象格式下仅在非默认值时出现，便于省 token）：

| 字段 | 含义与应对 |
|---|---|
| `disabled` | 按钮不可用 → 别点，先满足前置条件 |
| `checked` / `inputType` | 复选框已勾选 / 输入框类型（password 不回传值） |
| `value` | 输入框已有内容（回读表单状态用） |
| `inViewport: false` | 元素在视口外，截图里看不到 → 先 scroll 或直接用 `ref` 操作 |
| `occluded: true` | 中心点被别的元素盖住（弹层/遮罩）→ 先关掉遮挡物再操作 |
| `href` / `expanded` | 链接真实地址 / 折叠面板展开状态 |

**参数默认值**：`format` png｜jpeg｜webp（**webp 最省 token，长任务建议显式指定**）；`maxElements` 默认 50（`fast:true` 时 30，上限 120）；同参数 **400ms 缓存**（命中 <5ms），写操作后自动失效，`?fresh=1` 强制刷新。
窗口最小化/不可见时（`innerWidth=0`）**自动施加 1440×900 虚拟视口**并返回 `autoViewport`，截图与坐标操作照常可用。

### 1.2 ref 操作 —— 推荐方式（无需坐标）

拍完快照后，用编号直接操作。**刷新页面/滚动/元素位移都不会错位**，因为定位基于元素标记而非像素坐标。

```
POST /act { "action": "clickRef",  "ref": 3 }
POST /act { "action": "hoverRef",  "ref": 7 }
POST /act { "action": "fillRef",   "ref": 2, "value": "alice" }
POST /act { "action": "readText",  "ref": 5 }          # 读完整文本/值/属性(小字读不清时比放大截图省 token)
POST /act { "action": "zoom",      "ref": 5, "scale": 3, "format": "webp" }   # 裁剪放大, 读细节
POST /act { "action": "find",      "text": "登录" }     # 按可见文本找元素, 返回 ref/坐标(可点击优先)
POST /act { "action": "refs",      "steps": [{"op":"fill","ref":2,"value":"a"},{"op":"click","ref":3}] }  # 批量
```

`clickRef` / `fillRef` 还支持**后置等待**，把两次往返压成一次：`waitFor: 'load'｜'url'｜'text'｜'selector'`（配 `pattern`/`text`/`selector`、`waitTimeout`）。

坐标操作仍可用（`elements[i].center` 与 `POST /mouse {type:"click", x, y}` 同坐标系，无需换算）：

```
POST /mouse { "type": "click", "x": 668, "y": 430 }
```

> 选择原则：**ref 优先**（稳、可读、抗滚动）；需模拟真实轨迹/拖拽/滚轮时用 `/mouse`；表单填值用 `fillRef` 或 `/fill`（React 兼容）。

### 1.3 标准闭环

```
1. GET  /health 或 /status        # 连接确认
2. POST /open {url}               # 或 {url, current:true} 复用当前标签页
3. POST /wait-for-load            # 事件驱动, 别用 sleep; 页面有挂起资源时提前返回 partial:true(正常, 可继续); 再 POST /wait-for-stable 等 DOM 静默
4. GET  /snapshot?annotate=1&compact=1&format=webp   # ← 看图决策
5. POST /act {action:"clickRef", ref:N, waitFor:"load"}
6. GET  /snapshot?compact=1       # ← 前后对比验证(或 readText 校值)
7. POST /reset-all?tabId=         # 收尾: 恢复全部模拟 + 清理 ref 标记
```

一步到位的链式调用（一次 HTTP 往返）：

```powershell
node client\browser-client.js chain "open https://example.com" "wait-load" "wait-stable" "snapshot s1.webp --annotate --compact --format webp" "click-ref 3" "snapshot s2.webp"
```

### 1.4 交互铁律

1. **先看再动**：导航/点击/输入后必先 snapshot 看真实渲染，不盲猜 DOM。
2. **编号会过期**：`annotate` 的编号对应"最近一次快照"；页面变了就重新拍。
3. **首屏用视口快照，长页面用 `?full=1`**；小字/图标含义读不清时用 `zoom`（`scale` 2-3 足够）或 `readText`。
4. **遮挡先处理**：看到弹层/Toast/下拉 → 先 `key Escape`、点空白处或 `scroll`，再操作目标（`occluded` 字段会提示）。
5. **表单双通道**：输入用 `fillRef`/`/fill`（原生 setter，React 兼容）；提交后 snapshot 看成功态。
6. **验证用状态而非 sleep**：排序/翻页看 URL（`first=11`、`s=stars&o=desc`），登录看标题变化。
7. **失败即数据**：登录墙/限流/验证码截图直接可见 → 如实记录，不伪造。
8. **中文参数不进命令行**：PowerShell 5.1 会把中文转成 GBK 损坏。用 `--body-file kw.json`（UTF-8 无 BOM），或把中文写进 JSON 文件再 POST。

### 1.5 成本与稳定性要诀（实测）

| 场景 | 做法 | 实测收益 |
|---|---|---|
| 长任务省 token | 快照加 `compact=1&format=webp` | 元素 JSON **-77%~-81%**，图片 **-69%~-90%**，单次总载荷最高 **-90%** |
| 页面刚加载完就拍 | 加 `settle=1`（或先 `POST /wait-for-stable`） | 避免拍到过渡态导致坐标全错 |
| 窗口最小化/不可见 | **无需处理**：自动施加虚拟视口（视口任一维 <100 即触发，如最小化时夸克上报 45×14；仅影响该 tab），响应带 `autoViewport` | 最小化也能截图/点击 |
| `wait-for-load` 返回 `partial:true` | 正常：DOM 已就绪但第三方资源挂起（被墙/慢请求），`load` 事件不再空等（超 `stallGrace` 默认 3s 即返回） | 直接继续操作；确需等完整 load 可调大 `timeout`/`stallGrace` |
| 读到小字/图标含义 | 先 `POST /snapshot/text`；仍不够用 `POST /act {action:"zoom", scale:3}` | 免截图读页面，省 token |
| 多标签页/多窗口 | CLI 加 `--tabId <id>` | 避免"打到活动标签页"漂移 |
| 想省一次往返 | `clickRef` 带 `waitFor`；多步用 `refs` | 各省一次 HTTP |
| 站点不可达 | 响应直接给 `目标标签页不可用于视觉采集: chrome-error://...`（不再空等 12s） | 快速失败，便于换站点 |

> 注意：**带 clip 的截图（`zoom` / `screenshot-element`）必须由合成器出图**，窗口最小化时可能超时（会返回 `degraded` 并降级为元素截图）；`/snapshot` 整屏截图已改用渲染进程出图（实测 ~0.5s）。

## 2. 能力速查（154 端点）

**⚡ = 需 CDP 调试授权**（未启用时自动降级为脚本模拟）

| 域 | 端点 |
|----|------|
| 页面控制 | `POST /open {url, current?}` `/navigate` `/reload` `/back` `/forward` · `GET /tabs` · `POST /tab/activate` `/tab/close` · `/wait-for-load` `/wait-for-url` `/wait-for-text` · **`/wait-for-stable`** · `/batch` |
| 视觉 | `GET/POST /snapshot`（`compact`/`settle`） · `/snapshot/binary` · `/snapshot/zoom` · **`/snapshot/text`** · `/act` · `GET /fast/snapshot` |
| 自更新 | **`POST /reload-extension`**（改完 `extension/` 后让浏览器重载插件；重载后 CDP 授权失效需重跑 `/debug/attach-all`） |
| 元素操作⚡ | `POST /act {clickRef,hoverRef,fillRef,readText,zoom,find,refs}` · `/mouse` · `/click` `/hover` `/dblclick` `/rightclick` `/drag` · `/scroll` `/scroll-into-view` `/scroll-by` · `/wait-for` |
| 键盘输入⚡ | `POST /key` · `/type` · `/fill {fields:[{selector,value}]}`（React 兼容） · `/select` `/check` `/clear` `/focus` |
| DOM 精确值 | `GET /page-info` `/dom` `/html` `/layout`⚡ · `POST /query` `/query-all` `/query-many` `/text` `/attr` `/value` |
| JS 执行 | `POST /evaluate {code, timeout}` 支持 await，CSP 自动 bypass 重试 |
| 截图/PDF⚡ | `GET /screenshot` `/screenshot/full` · `POST /screenshot/element` · `GET/POST /pdf` · `POST /upload` |
| 网络 | `GET /network?filter=&limit=` · `POST /network/response {urlPattern}`⚡ · `/block` `/unblock` `/conditions` `/disable-cache` `/bypass-csp` |
| 性能 | `GET /performance` `/vitals`（LCP/CLS/TTFB/FCP+FID+评级） `/resources` · `POST /cpu {rate}`⚡ |
| 模拟⚡ | `POST /device {device}` `/device/clear` · `/media` · `/geo` · `/locale` `/timezone` · `/auto-dark` `/js` `/hardware-concurrency` |
| 检查 | `GET /security` `/a11y` `/seo` |
| 聚合 | `GET /full`（DOM+性能+Vitals+安全+a11y+seo，3s 缓存） · `GET /analyze-all` · `POST /monitor` → `/monitor/stop` `/monitor/status` |
| Cookie/Storage | `GET /cookies` `POST /cookie` `/cookie/remove` · `GET /storage?type=` `POST /storage` `/storage/remove` `/storage/clear` |
| 控制台 | `GET /console?limit=` `POST /console/clear` · `GET /dom-changes` |
| 弹窗⚡ | `POST /dialog {accept, promptText, auto}` · `GET /dialogs` |
| 调试/清理 | `POST /debug/attach-all` `/debug/detach-all` · `GET /health`（免鉴权） `/status` · `POST /reset-all?tabId=` |

设备预设：iPhone 14 / 14 Pro Max / SE、iPad、iPad Pro、Pixel 7、Galaxy S23、Desktop，或自定义 `{width,height,dpr,mobile,userAgent}`。

> 完整端点表、CLI↔插件命令映射、chain/batch 语法 → `references/protocol.md`

## 3. 批量与速度

```powershell
node client\browser-client.js chain "open https://x" "wait-load" "snapshot s.webp --annotate --compact" "click-ref 2"
node client\browser-client.js chain --body-file steps.json      # 复杂/中文步骤走 UTF-8 JSON 文件
```

- `/batch` 一次往返多步；步骤加 `data._parallel:true` 让连续只读块并行（3-5×）。
- 只读端点有 1-5s 缓存（`/page-info` 2s、`/vitals` 5s、`/full` 3s），`?fresh=1` 绕过，`?ttl=<ms>` 自定义。
- **反模式**：固定 sleep 等待（用 `wait-*`）、循环单查（用 `query-many` 或一次 `/full`）、相同参数重复拍 snapshot（有缓存）、看到小字就整页重拍（用 `zoom` + `readText`）。

## 4. 多标签并行与会话隔离

```
POST /session/create → {sessionId}
POST /session/tab {sessionId, url}      # 后台开页不抢焦点
GET  /session                           # 会话 + tabIds
POST /session/delete {sessionId, closeTabs:true}
```

带 `?session=<id>` 即进入隔离：越权访问他会话标签页返回 403；单 tab 会话免传 tabId，多 tab 会话必须显式 `?tabId=`；设备/媒体/弹窗策略均 per-tab 隔离。**任务结束必须清理**：会话用 `/session/delete`，共享标签页用 `/reset-all?tabId=`。

## 5. 弹窗

默认 `autoAccept:true`：事件驱动同步自动确认，**不卡流程，无需预处理**。需人工决策时 `POST /dialog {auto:false}` → 交互命令返回 `{dialogPending:true}` → `POST /dialog {accept, promptText}` 应答；60s 无应答自动回退（防 agent 失联卡死用户页面）。

## 6. 审计引擎（30+ 维度加权评分）

```powershell
POST /audit {url?, budget?, format?: json|md|html, save?}    # 采集→5类加权评分→洞察→ROI 机会
GET  /history?url=&limit=                                    # 趋势对比
node client\browser-client.js audit-html report.html https://target
```

评分构成：性能 30% / 可访问性 20% / 安全 20% / SEO 15% / 资源效率 15%（阈值参考 Lighthouse）。返回含 `scores`、`insights`（确定性根因）、`opportunities`（ROI 排序+预估节省）、`ai`（AI 可读紧凑格式）。
工作流：`{save:true}` 审计 → 读 `ai` 字段出修复方案 → 修复后重审 + `/history` 对比；可叠加 `GET /snapshot?full=1` 作定性证据。

## 7. 安全与配置

| 机制 | 说明 |
|---|---|
| **仅回环监听** | HTTP/WS 都绑 `127.0.0.1`，局域网设备无法访问（确需对外用 `BRIDGE_HOST=0.0.0.0`，**必须**同时设 `ARK_TOKEN`） |
| **令牌鉴权** | 除 `/health` 外所有端点需 `X-Ark-Token` / `Authorization: Bearer` / `?token=`。令牌在 **`~/.ark-web/token`**（Windows：`%USERPROFILE%\.ark-web\token`），0600 权限；启动日志与 `/health` 都会给出路径 |
| **Host 校验** | 拒绝非回环 Host → 挡 DNS rebinding |
| **Origin 校验** | 仅接受无 Origin（CLI）、浏览器扩展页面、本机页面来源；**不回显 `ACAO: *`** → 挡任意网页 CSRF 操控浏览器 |
| **WS 令牌** | 设 `ARK_TOKEN`（或 `ARK_WS_TOKEN`）后，插件必须在 popup「连接配置」填相同令牌，否则拒绝连接 |

```powershell
$env:ARK_TOKEN='my-strong-token'; node server\bridge-server.js   # 自定义令牌(可选; 不设则自动生成)
node client\browser-client.js status                              # CLI 自动读令牌
curl.exe -H "X-Ark-Token: $(Get-Content "$env:USERPROFILE\.ark-web\token" -Raw)" http://127.0.0.1:9333/status
```

⚠️ `ARK_NO_AUTH=1` 可关闭鉴权（兼容旧用法）：此时本机任意进程与任意网页都能操控浏览器，**仅在完全可信环境使用**。

**配置项**

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_PORT` | 9333 | HTTP API 端口 |
| `BRIDGE_WS_PORT` | 9334 | WebSocket 端口（改了需在插件 popup「连接配置」填同值） |
| `BRIDGE_HOST` | 127.0.0.1 | 监听地址（改 `0.0.0.0` 必须配 `ARK_TOKEN`） |
| `ARK_TOKEN` | 自动生成 | HTTP/WS 访问令牌（存 `~/.ark-web/token`） |
| `ARK_NO_AUTH` | — | `=1` 关闭鉴权（不安全） |
| `ARK_PORT` / `ARK_HOST` | — | 客户端侧（CLI/脚本）连接参数 |

插件侧连接（主机/端口/令牌）在 **popup → 工具 → 连接配置** 修改并持久化。

## 8. 故障排查

常见症状与处置见 `references/troubleshooting.md`（连接/僵尸连接/鉴权/CDP/夸克内核差异/点击无效/拖拽/中文编码/限流登录墙/弹窗 等 50+ 条）。

## 参考文档

| 文件 | 何时读 |
|---|---|
| `references/protocol.md` | 查完整端点表、CLI↔插件命令映射、chain/batch 语法 |
| `references/troubleshooting.md` | 出问题时（连接、鉴权、夸克内核、编码…） |
| `references/evaluate-recipes.md` | 需要穿透 Shadow DOM / React / Monaco / 拦截 WebSocket 时 |

## 版本

- 运行时版本以 `extension/manifest.json` 为准（本手册对应 v3.0.2）；`/status` 会同时给出 **server 版本**与**插件上报版本**，两者不一致说明浏览器里跑的不是最新代码。
- 改了 `extension/` 后：`node scripts/sync.js --yes` → `POST /reload-extension` → `POST /debug/attach-all`。
- 历史见 `CHANGELOG.md`；环境体检 `node scripts/doctor.js`。
