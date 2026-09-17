# Ark Web

> **本仓只做一件事：浏览器扩展 + Bridge Server，让 AI 操控你正在用的真实浏览器。**
>
> 仓库内部有两个面，分界是**机制**而不是约定：
>
> | | 是什么 | 入口 |
> |---|---|---|
> | **技能接口** | agent 用它操控浏览器的能力面（`/tabs`、`/semantic/*`、`/evaluate`、工具清单…），语义与契约见 `SKILL.md` | `extension/` + `server/capabilities/*`（非 internal 的那些） |
> | **本机配置面** | 密钥 / 预算 / 敏感名单 / 令牌轮换 / 开机自启 / 打包发布 | `server/capabilities/settings.js`（标了 `internal: true`） |
>
> 配置面的隔断由 `server/core/internal-routes.js` 落实：它收集标了 `internal` 的能力域，
> 通用直通工具（`ark_api`）对这些端点直接拒绝，`/capabilities` 也带标记输出。

> 另有一个同名但**完全独立**的项目「Ark BrowserOS」（深改浏览器 + opencode 侧边栏），
> 与本仓同源但已分家、无代码依赖。见 `C:\Users\画扇\ark-browseros`。

> [English](README.en.md) | 中文（本页）
>
> Control your **real** Chrome from AI — 154 endpoints, snapshot/SoM vision, session isolation, audit engine.

[![version](https://img.shields.io/badge/version-v3.0.2-blue)](https://github.com/AEBT01/ark-web)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![stars](https://img.shields.io/github/stars/AEBT01/ark-web?style=social)](https://github.com/AEBT01/ark-web)
[![last-commit](https://img.shields.io/github/last-commit/AEBT01/ark-web)](https://github.com/AEBT01/ark-web/commits)

> AI 浏览器调试桥接 — 浏览器扩展 + Bridge Server + HTTP API = 真实浏览器控制
> 支持 Chrome 及 **夸克等 Chromium 内核套壳浏览器**（夸克实测可用，插件会如实上报真实内核）

## English

**Ark Web** is a local bridge that lets AI agents control your *real* browser — the one you actually use, with your logins and real fingerprint. No puppeteer, no separate browser instance. An MV3 Chrome extension (CDP via `chrome.debugger`) connects over WebSocket to a local Node bridge exposing 154 HTTP endpoints: navigation, trusted mouse/keyboard, React-compatible form fill, screenshots & PDF, device/media/network emulation, network response bodies, an atomic vision `snapshot` (screenshot + SoM coordinate anchors) for multimodal models, server-enforced session isolation for parallel agents, and a 30+ rule weighted audit engine (performance / a11y / SEO / security / resources).

```bash
./start.sh                 # Windows: start.bat   (or: cd server && npm install && node bridge-server.js)
# 1. chrome://extensions → Developer mode → Load unpacked → extension/
# 2. Click the extension icon → "Enable Debug" (required on Chrome 136+)
TOKEN=$(cat ~/.ark-web/token)                        # auto-generated on first start (shared across copies)
curl -H "X-Ark-Token: $TOKEN" http://127.0.0.1:9333/health
curl -H "X-Ark-Token: $TOKEN" http://127.0.0.1:9333/status
curl -H "X-Ark-Token: $TOKEN" -X POST http://127.0.0.1:9333/open -d '{"url":"https://example.com"}'
curl -H "X-Ark-Token: $TOKEN" "http://127.0.0.1:9333/snapshot?annotate=1"   # screenshot + numbered anchors
```

AI agents should load `SKILL.md` — a **vision-first** manual: look at a snapshot, then act on numbered elements (`clickRef`/`fillRef`) instead of guessing selectors. CLI: `node client/browser-client.js help`. Windows users: prefer PowerShell `Invoke-RestMethod` over curl.exe for JSON bodies, and always pass Chinese text via `--body-file`.
**Hardened by default**: bound to loopback only, token auth on every endpoint, plus Host/Origin validation. See [安全](#安全).

## 作为 Skill 使用(推荐)

本仓库的 `SKILL.md` 就是完整的 agent 能力手册（真实浏览器操控、视觉快照与编号操作、裁剪放大读小字、
审计引擎、故障排查）。让 AI 用上它有两种方式，选一种即可：

- **就地使用**（本机开发仓就是运行位置）：告诉 agent 读 `C:\Users\画扇\browser-debug-extension\SKILL.md`。
- **复制到 agent 的技能目录**：把本仓库（或其子集）复制到 `%USERPROFILE%\.agents\skills\ark-web\`，
  agent 按技能名 `ark-web` 自动发现。

### 其他 AI / 新环境接入要点（**踩坑第一名，必读**）

1. **先 cd 到这份仓库**：手册与脚本里的相对路径都以此为准
   ```powershell
   cd "$env:USERPROFILE\browser-debug-extension"   # 本机开发仓；复制到别处则 cd 到那一份
   ```
2. **优先用 CLI**：`node client/browser-client.js status` —— **自动读取令牌，不会 401**
3. **令牌不在 `server/.ark-token`**（旧路径已废弃），现在在 **`~/.ark-web/token`**：
   ```powershell
   curl.exe -H "X-Ark-Token: $(Get-Content "$env:USERPROFILE\.ark-web\token" -Raw)" http://127.0.0.1:9333/status
   ```
   唯一免鉴权端点是 `GET /health`（还会告诉你 CLI 绝对路径和令牌文件位置）。
4. **`connected: true` 但命令全部超时** = **僵尸连接**（插件重载/浏览器休眠后残留的旧连接）。
   v2.9.1 已内建自愈：超时自动换连接重试 + 120s 静默自动清理；仍不行就重启 server。详见 [故障排查](#故障排查)。
5. **浏览器是夸克也能用**：插件注册时会上报真实内核，`/status` 的 `plugin.browser` 显示 `quark`。个别 CDP 域在夸克内核下不生效，已在代码内做脚本兜底（详见 `references/troubleshooting.md`）。

> **Skill v10.2 (视觉优先)**: `SKILL.md` 为唯一手册, 主路径是「快照 → 按编号操作」:
> `GET /snapshot?annotate=1&compact=1&format=webp` 一次拿到截图 + SoM 编号锚点 + 元素语义(disabled/occluded/inViewport/value…),
> 再用 `POST /act {clickRef|hoverRef|fillRef|readText|zoom|find|refs}` 直接操作, **无需坐标换算, 滚动/位移后依然准确**。
> `compact`+`webp` 实测把单次快照载荷压到 **-77%~-90%**; 小字读不清用 `zoom` 放大 2-3 倍或 `readText` 直接取文本;
> 不想截图可用 `POST /snapshot/text` 直接"读"页面文本块。
> 详查资料已拆到 `references/`(协议表 / 故障排查 / evaluate 模板), 按需加载。

## 架构

```
┌─────────────────────┐     WebSocket     ┌─────────────────────┐     HTTP     ┌─────────────────────┐
│   Chrome 插件        │ ◄──────────────► │   Bridge Server     │ ◄──────────► │   AI / CLI / curl   │
│   (extension/)      │   ws://9334      │   (server/)         │   :9333      │                     │
│                     │                  │                     │              │  browser-client.js  │
│  • background: CDP  │                  │  • HTTP API (154)   │              │  ark.js (别名)      │
│  • content: 日志监控│                  │  • 日志聚合          │              │  直接 HTTP          │
│  • popup: 授权+状态 │                  │  • 缓存/keep-alive  │              │                     │
└─────────────────────┘                  └─────────────────────┘              └─────────────────────┘
```

## 快速开始

### 1. 安装 Chrome 插件

1. 打开 Chrome, 访问 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `extension/` 目录
4. 点击插件图标 → 「启用调试」(Chrome 136+ 必须, 开启 CDP 真实控制能力)
5. 若 server 使用自定义端口或启用了 `ARK_TOKEN`, 在插件 popup →「工具」→「连接配置」填好并保存重连

### 2. 启动 Bridge Server

```bash
# Windows
start.bat        # 或: cd server && npm install && node bridge-server.js

# macOS / Linux
./start.sh       # 或: cd server && npm install && node bridge-server.js
```

### 3. 验证

```bash
curl http://127.0.0.1:9333/health                                  # 免鉴权存活探针 {"ok":true,"connected":true}
curl -H "X-Ark-Token: $(cat ~/.ark-web/token)" http://127.0.0.1:9333/status
node client/browser-client.js status                               # CLI 自动读取令牌
```

> 以下示例均为 curl, macOS/Linux 可直接使用; Windows PowerShell 建议 `Invoke-RestMethod` 或仓库 CLI。

## 用法示例

```bash
# 打开页面
curl -X POST http://localhost:9333/open -d '{"url":"https://example.com"}'

# 视觉优先: 先拍快照拿编号, 再按编号操作(推荐)
curl -H "X-Ark-Token: $(cat ~/.ark-web/token)" "http://127.0.0.1:9333/snapshot?annotate=1&format=webp"
curl -H "X-Ark-Token: $(cat ~/.ark-web/token)" -X POST http://127.0.0.1:9333/act -d '{"action":"clickRef","ref":3}'
curl -H "X-Ark-Token: $(cat ~/.ark-web/token)" -X POST http://127.0.0.1:9333/act -d '{"action":"fillRef","ref":2,"value":"hello"}'
curl -H "X-Ark-Token: $(cat ~/.ark-web/token)" -X POST http://127.0.0.1:9333/act -d '{"action":"zoom","ref":5,"scale":3,"format":"webp"}'

# 选择器 / 原始鼠标(仍可用)
curl -X POST http://127.0.0.1:9333/click -d '{"selector":"#search-button"}'
curl -X POST http://127.0.0.1:9333/mouse -d '{"type":"click","x":668,"y":430}'
curl -X POST http://127.0.0.1:9333/fill  -d '{"fields":[{"selector":"#q","value":"hello"}]}'

# 批量执行 (一次往返多步)
curl -X POST http://localhost:9333/batch -d '{"steps":[
  {"type":"open-url","data":{"url":"https://example.com"}},
  {"type":"wait-for-load","data":{}},
  {"type":"get-page-info","data":{}}]}'

# 截图 / PDF (整页/PDF 需 CDP)
curl http://localhost:9333/screenshot
curl http://localhost:9333/screenshot/full
curl "http://localhost:9333/pdf" -o page.pdf.base64.json

# 真实设备/媒体/网络模拟 (需 CDP)
curl -X POST http://localhost:9333/device -d '{"device":"iPhone 14"}'
curl -X POST http://localhost:9333/media -d '{"features":[{"name":"prefers-color-scheme","value":"dark"}]}'
curl -X POST http://localhost:9333/network/conditions -d '{"offline":true}'

# 全量分析
curl http://localhost:9333/full
```

### CLI (唯一工具链)

```bash
node client/browser-client.js open https://example.com
node client/browser-client.js click "#search-button"
node client/browser-client.js screenshot report.png
node client/browser-client.js pdf report.pdf
node client/browser-client.js report report.json

# 链式 (一次 HTTP+WS 往返)
node client/browser-client.js chain "open https://example.com" "wait-load" "page-info" "screenshot shot.png"

# ark.js 是别名
node ark.js status
```

## 性能设计 (v8 极速)

- HTTP keep-alive 对齐: server 10s / client 8s，单连接复用 0 握手，`maxSockets 20` 并发无队头阻塞
- per-tab 队列 + 读写分离: 写串行/读并行，`/full` 7 路 `Promise.all` 真正并行；inflight 同键合并省 1 WS
- 紧凑 JSON: 无缩进输出, 省 ~30% 传输；`GET /snapshot/binary` 二进制省 33% base64
- 快照缓存 400ms: 高频 `snapshot` 命中 <5ms，写后自动失效；探针 4s 缓存省 30ms/点击，`mouseFlow fast` 节 25ms
- 只读端点缓存: page-info/dom/performance/vitals/security/a11y/seo/resources/full 缓存 1-5s, `?fresh=1`/`?ttl=0` 绕过；`?tabId`/`?session` 精确键
- `/batch` DAG: `_parallel` 连续只读块 `Promise.all` 3-5× 提速，批内 tab 跟踪不漂移
- 等待事件驱动: `waitForSelector/Text` `MutationObserver` 10-40ms，`waitForUrl/Load` 40ms 轮询；CDP 预热首命令省 100ms
- 插件断连: server 立即拒绝挂起请求, 不等待超时；monitor/analyze-all 3 并发限流

## Fast API 封装 (v8.1) — 一次 HTTP 完成高层意图

- `POST /act {action, ...}` 一键：`snapshot`/`clickRef`/`hoverRef`/`fillRef`/`readText`/`zoom`/`click`/`clickText`/`fill`/`type`/`extract`/`navigate`/`evaluate` 单 HTTP 往返（服务端 `snapshot→mouse` 仅 1 RTT，比客户端两跳省 1 RTT）
- `GET /fast/snapshot` 别名（默认 `fast:true`）+ `POST /fast/click|fill` 快路径
- `client/ark-fast.js`：`ArkFast` 类 `snapshot()/click()/clickText()/fill()/extract()/act()/batch()` 内置 `per-tab` + `400ms snapshotCache` + `binary`，`chain "act clickText 登录"` 支持；`node client/ark-fast.js snapshot --annotate --binary` 最快
- `http` 本地页 `http://127.0.0.1` 截图直走 `captureVisibleTab` 6s 快路径，不再 `Page.captureScreenshot` 15s 挂起

## 功能亮点 (v2.9 视觉增强 + 安全加固)

- **ref 系操作 (按 SoM 编号)**: `POST /act {clickRef|hoverRef|fillRef|readText, ref}` —— 快照时给元素打临时标记, 编号直接可用, **无坐标换算、滚动/元素位移后依然准确**; 下次快照或 `/reset-all` 自动清理标记
- **裁剪放大 / 读小字**: `POST /snapshot/zoom {ref|selector, scale(1-5), format}` —— CDP `clip` + `scale` 局部放大, 读小小字/图表细节; CDP 不可用时降级元素截图
- **元素语义增强**: 快照元素带 `disabled/checked/inputType/value/placeholder/href/expanded/inViewport/occluded`, 只在非默认值时输出以省 token; `occluded` 直接告诉你"点了会打到遮罩"
- **webp 格式**: `format=webp` 让截图体积进一步下降(视觉模型最省 token), `/snapshot/binary` 同步支持
- **安全默认加固**: 仅回环监听 + 全端点令牌鉴权 + Host/Origin 校验 + 移除 `ACAO: *`, 插件 WS 端口/令牌可在 popup 配置(详见 [安全](#安全))
- **专业审计引擎**: `POST /audit` — 采集 30+ 维度(Web Vitals/长任务/资源瀑布/图片字体/框架检测/DOM 复杂度/安全头),5 类别加权评分(0-100),确定性根因洞察 + ROI 排序优化机会
- **可视化报告**: HTML 单文件报告(评分环/指标卡/问题卡)+ Markdown 版 + AI 可读紧凑格式
- **趋势与批量**: JSONL 历史存储 + 前后对比,URL 队列异步审计,性能预算违规检测
- **弹窗事件驱动自动应答**: `Page.javascriptDialogOpening` 回调内同步自动确认(默认 autoAccept:true), 模态弹窗不再阻塞渲染线程与挂起命令; `POST /dialog {auto:false}` 切手动模式, 记录带 `handled: 'auto'|'pending'|'closed'`
- **地理位置 mock**: `POST /geo` — 注入 navigator.geolocation mock(主 world, 三级 fallback + permissions.query 配套), 跨导航/reload 生效, 免 CDP 权限域限制
- **键盘默认行为键**: Enter/End/Home/PageUp/PageDown/方向键/Tab/Backspace/Delete 走脚本合成路径(Enter→requestSubmit、End/Home→滚动、Tab→焦点等), 解决 trusted 注入与真实焦点强绑定问题
- 当前页导航: `POST /open {url, current: true}` — CDP Page.navigate, 可获取导航错误
- 自动暗色: `POST /auto-dark` / 禁用 JS: `POST /js` / 硬件并发: `POST /hardware-concurrency`
- iframe 树: `GET /frames` / 布局指标: `GET /layout`
- 禁用缓存: `POST /network/disable-cache` / 绕过 CSP: `POST /bypass-csp`
- **双测试套件**: `real-scenario-v3.js`(20 场景 202 步核心终测, 20/20) + `real-scenario-v4.js`(12 个复杂真实情景任务: 公共站旅程 MDN/apache/IANA + 本地 SPA 路由/受控表单/无限滚动/多步结算 + analyze-all/monitor 期间操作/弹窗手动模式/12 步 batch 长链, 12/12)

```bash
# 审计当前页面并生成 HTML 报告
node client/browser-client.js audit-html perf.html
# 批量审计多个 URL
node client/browser-client.js audit-run '["https://a.com","https://b.com"]'
# 查看趋势
node client/browser-client.js history https://a.com
```

## 端点总览 (154, 以 `scripts/check-endpoints.js` 核对为准)

`GET  /health(免鉴权) /status /tabs /full /clear-cache /page-info /dom /html /frames /layout /screenshot /screenshot/full /pdf /cookies /storage /network /console /dom-changes /performance /vitals /resources /security /a11y /seo /dialogs /history /analyze-all /monitor/status /debug/info /debug/cdp-status /snapshot /snapshot/binary /fast/snapshot`

`POST /batch /open /navigate /reload /back /forward /tab/activate /tab/close /query /query-all /query-many /exists /text /attr /value /click /hover /dblclick /rightclick /drag /mouse /scroll /scroll-by /scroll-into-view /key /type /fill /select /check /clear /focus /evaluate /wait-for /wait-for-text /wait-for-url /wait-for-load /screenshot/element /upload /highlight /highlight/clear /dialog /auto-dark /js /hardware-concurrency /cookie /cookie/remove /storage /storage/remove /storage/clear /network/clear /network/response /network/block /network/unblock /network/conditions /network/conditions/reset /network/disable-cache /bypass-csp /cpu /device /device/clear /media /geo /locale /timezone /console/clear /dom-changes/clear /monitor /monitor/stop /audit /audit/run /debug/attach-all /debug/detach-all`

`POST /snapshot /snapshot/zoom /snapshot/text /act /fast/act /wait-for-stable /reload-extension`

`GET  /audit/status/<id>`(审计任务状态)

所有端点支持 `?tabId=<id>` 指定标签页；除 `/health` 外均需 `X-Ark-Token`。完整参数与命令映射见 `references/protocol.md`。

## 目录结构

```
ark-web/
├── extension/            # Chrome 插件
│   ├── manifest.json     # v3.0.2
│   ├── background.js     # CDP 管理器 + 命令实现 + 视觉快照/ref/zoom
│   ├── content.js        # 控制台/DOM/Storage 监控
│   ├── popup.html/js     # 状态 + 调试授权 + 连接配置(WS 主机/端口/令牌)
│   └── devtools.html/js
├── server/
│   ├── bridge-server.js  # HTTP API + WebSocket 桥 + 缓存 + 安全层(令牌/Host/Origin)
│   ├── .ark-token        # [旧路径, 已废弃] 令牌现统一在 ~/.ark-web/token
│   ├── audit.js          # 审计引擎: 评分/洞察/机会/预算
│   └── audit-report.js   # 报告渲染 + 趋势存储 + 批量队列
├── references/           # 按需加载的详查资料(渐进式披露)
│   ├── protocol.md       # 完整端点表 + chain/batch 语法 + 命令映射
│   ├── troubleshooting.md# 故障排查(连接/鉴权/CDP/编码/站点限制)
│   └── evaluate-recipes.md # evaluate 穿透模板(Shadow DOM/React/Monaco)
├── client/
│   └── browser-client.js # 唯一 CLI + API 库 (keep-alive, chain)
├── scripts/
│   ├── check-endpoints.js  # 端点声明一致性核对
│   ├── doctor.js           # 环境自检: 多副本漂移 + 浏览器实际加载路径 + 插件版本
│   ├── sync.js             # 同步到浏览器实际加载的副本(自动备份)
│   ├── bench-snapshot.js   # 快照效率基准 (对象/紧凑 × png/webp)
│   ├── demo-vision-flow.js # 视觉闭环参考实现 (8 步全流程, 可照抄)
│   ├── real-scenario-v3.js # 20 场景 202 步终测套件 (核心验证工具)
│   ├── real-scenario-v4.js # 复杂真实情景套件 (真实站 + SPA)
│   ├── smoke-test.js       # 端到端冒烟测试 (94 项)
│   └── package.js          # 发布打包 (dist/*.zip)
├── data/                 # 审计历史 (history.jsonl, 运行时生成)
├── dist/                 # 发布产物
├── legacy/               # 历史脚本归档 (不再使用)
├── reports/
│   ├── real-scenario-v3.md # 最新终测报告 (测试时自动生成)
│   └── archive/            # 历史报告/截图归档
├── ark.js                # 快捷别名 (转发 browser-client)
├── start.bat             # Windows 启动脚本
├── start.sh              # macOS/Linux 启动脚本
├── SKILL.md              # AI 能力手册 (v10.2: 视觉优先; 也可作为 skill 独立安装)
├── LICENSE
├── CHANGELOG.md
└── README.md
```

## 上手与验证

- **产品使用说明书**：`docs/产品使用说明书.md`（安装四步、日常使用、设置逐条、常见问题、运维速查、附录）
  —— 改完文档跑 `node scripts/build-docs.js` 会生成 `docs/index.html`（双击即可看的单文件版，可直接打印）
- **一键验证**：`node scripts/verify-all.js`（按"需要什么条件"分层；缺条件的会明确跳过并给补齐命令）
- **打包发版**：`node scripts/bump-version.js <版本>` 统一版本 → `node scripts/package.js` 产出 `dist/`

## 已知限制与技术债

- 历史技术债已全部清零(v2.3.1): server 并发竞态(ALS 隔离)、命令死锁恢复链、SW 保活(alarms + keepalive port)、device clear 自愈、日志上限
- 环境依赖: 改 background.js 后需手动重载插件; 改 server 后需重启 `node server/bridge-server.js`
- 浏览器兼容: Chrome / 夸克(Chromium)均通过全量测试; 夸克 UA 下必应结果页有 `b_ans/b_top` 答案卡片(测试已适配)

## 发布打包

```bash
node scripts/package.js
# → dist/ark-web-v3.0.2.zip (含扩展/服务端/客户端/测试/文档, 排除 node_modules 与 legacy)
```

> 完整版本历史见 `CHANGELOG.md`; AI 使用手册见 `SKILL.md`。

## 故障排查

| 问题 | 解决 |
|------|------|
| `401: 缺少或错误的访问令牌` | HTTP 调用没带令牌。令牌在 **`~/.ark-web/token`**（Windows `Get-Content "$env:USERPROFILE\.ark-web\token" -Raw`）；**或直接用 CLI**（自动读取，永不 401） |
| **`connected: true` 但命令全部超时** | **僵尸连接**（插件重载/浏览器休眠后残留的旧 WS）。v2.9.1 已内建自愈：超时自动换连接重试(8s) + 120s 静默自动清理 + `/status.connections[]` 可观测(`suspect:true` 即可疑)。仍不行就重启 server |
| `connected: false` | 浏览器未开 / 插件未加载 → `chrome://extensions` 重新加载；夸克用户同理（夸克也支持加载解压扩展） |
| 命令报 unknown/error | 插件是旧版 → `node scripts/sync.js --yes` 同步后 `POST /reload-extension`（或手动重载插件） |
| 调试功能报"需要 CDP" | `node client/browser-client.js debug-on`（等价 `POST /debug/attach-all`，无需点 popup）；插件重载后需重新授权 |
| 插件版本与代码不一致 | `node scripts/doctor.js` —— 会列出所有副本、浏览器实际加载路径、插件上报版本 |
| 端口占用 `localhost:9333` | 结束占用进程, 或换端口启动: `$env:BRIDGE_PORT=9335; node server\bridge-server.js`（改了 WS 端口需在插件 popup 填同值） |
| 夸克下个别 CDP 域不生效 | 已知差异（如 `setLocaleOverride` 被忽略，已用脚本注入兜底）；截图超时已加 `fromSurface:false` 兜底。device clear 视口残留已改为"写回原始视口"软还原。详见 `references/troubleshooting.md` |
| 截图超时 | 整屏快照已改走渲染进程出图（~0.5s）；带 `clip` 的 `zoom`/元素截图受内核限制，会自动降级并返回 `degraded` |
| `wait-for-load` 返回 `partial:true` | 正常：页面第三方资源挂起（被墙/慢请求）导致 `load` 永不触发，v3.0.1 起超 `stallGrace`(默认 3s) 即按 DOM 就绪返回，可继续操作；确需等完整 load 可调大 `timeout` |
| 页面一直 loading / 卡 interactive | 通常是有挂起的外部资源（如国内网络下的 `cse.google.com`）→ `wait-for-load` 会自动部分返回；也可 `reload` 后重试 |

## 安全

本工具给调用方的是**整台浏览器的控制权**（含 `/evaluate` 任意 JS 执行），因此默认即按"不可信本机环境"加固：

| 机制 | 行为 |
|---|---|
| 仅回环监听 | HTTP(9333) 与 WS(9334) 都绑 `127.0.0.1`，局域网设备无法访问。确需对外用 `BRIDGE_HOST=0.0.0.0`，**必须**同时设置 `ARK_TOKEN` |
| 令牌鉴权 | 除 `GET /health` 外所有端点都要求 `X-Ark-Token` 头（或 `Authorization: Bearer`、`?token=`）。令牌首次启动自动生成写入 **`~/.ark-web/token`**(0600)，启动日志与 `/health` 都会给出路径；CLI 与测试脚本自动读取。多份项目副本共用同一令牌，避免"服务端与 CLI 令牌不一致"的 401 |
| Host 校验 | 拒绝非回环 Host → 挡 **DNS rebinding**（恶意域名解析到 127.0.0.1 后带自己的 Host 发请求） |
| Origin 校验 + 精确 CORS | 仅接受无 Origin(CLI)、`chrome-extension://` 扩展页面、本机页面来源；回显具体 Origin，**不再使用 `Access-Control-Allow-Origin: *`** → 挡**任意网页 CSRF 操控浏览器** |
| WS 来源校验 | **默认开启**：WebSocket 握手不受 CORS 约束，任意网页都能向 `ws://127.0.0.1:9334` 发起连接，因此默认拒绝一切 `http(s)://` 来源，只接受扩展页面与无 Origin 的本机进程。确需让本机页面走 WS 的老用法：`ARK_WS_ALLOW_LOCAL=1`（验证见 `verify/ws-guard.js`） |
| WS 令牌 | 设置 `ARK_TOKEN`(或 `ARK_WS_TOKEN`) 后，插件必须在 popup「连接配置」填入相同令牌，否则连接被拒 → 挡本机任意进程直连 9334 绕过 HTTP 鉴权 |

```bash
# 自定义令牌(可选)
ARK_TOKEN=my-strong-token node server/bridge-server.js
```

⚠️ `ARK_NO_AUTH=1` 可关闭鉴权以兼容旧用法 —— 此时本机任意进程与任意网页都能操控浏览器，**仅在完全可信环境使用**。

| 产品配置面 | `/settings/*`（密钥 / 预算 / 名单 / 令牌轮换）标为 `internal`，**agent 触不到**：通用直通工具调用它们会被拒并提示改由面板或 CLI 操作 |
| 连接健康口径 | "已连接"按最近 45 秒内是否真的说过话算（`liveClients`）：浏览器被强杀后 socket 可能还挂着，只看 socket 存在会把"命令全超时"报成一切正常 |

调试中避免输入真实密码；截图/PDF/响应体可能含敏感信息，注意脱敏。
