# Ark Web

> [English](README.en.md) | 中文（本页） | [Live demo](docs/index.html)
>
> Control your **real** Chrome from AI — 117 endpoints, snapshot/SoM vision, session isolation, audit engine.

[![version](https://img.shields.io/badge/version-v2.9.0-blue)](https://github.com/AEBT01/ark-web)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![stars](https://img.shields.io/github/stars/AEBT01/ark-web?style=social)](https://github.com/AEBT01/ark-web)
[![last-commit](https://img.shields.io/github/last-commit/AEBT01/ark-web)](https://github.com/AEBT01/ark-web/commits)

> AI 浏览器调试桥接 — Chrome 插件 + Bridge Server + HTTP API = 真实浏览器控制

## English

**Ark Web** is a local bridge that lets AI agents control your *real* browser — the one you actually use, with your logins and real fingerprint. No puppeteer, no separate browser instance. An MV3 Chrome extension (CDP via `chrome.debugger`) connects over WebSocket to a local Node bridge exposing 117 HTTP endpoints: navigation, trusted mouse/keyboard, React-compatible form fill, screenshots & PDF, device/media/network emulation, network response bodies, an atomic vision `snapshot` (screenshot + SoM coordinate anchors) for multimodal models, server-enforced session isolation for parallel agents, and a 30+ rule weighted audit engine (performance / a11y / SEO / security / resources).

```bash
./start.sh                 # Windows: start.bat   (or: cd server && npm install && node bridge-server.js)
# 1. chrome://extensions → Developer mode → Load unpacked → extension/
# 2. Click the extension icon → "Enable Debug" (required on Chrome 136+)
curl http://localhost:9333/status
curl -X POST http://localhost:9333/open -d '{"url":"https://example.com"}'
curl "http://localhost:9333/snapshot?annotate=1"    # screenshot + element anchors, vision-model ready
```

AI agents should load `SKILL.md` — a unified manual with a self-gating step: multimodal models use the vision-first workflow (snapshot + coordinates), text-only models use selectors. CLI: `node client/browser-client.js --help`. Windows users: prefer PowerShell `Invoke-RestMethod` over curl.exe for JSON bodies. Localhost-only by design, **no authentication** — do not expose it or run in untrusted environments.

## 作为 Skill 使用(推荐)

把本仓库(或其子集)复制到 `%USERPROFILE%\.agents\skills\ark-web\`,AI 即可通过 `SKILL.md` 获得全部能力手册
(真实浏览器操控、17 站实测选择器、审计引擎、故障排查),并调用本仓库工具链执行。

> **统一 Skill v9 (文本+视觉二合一)**: `SKILL.md` 为唯一手册, 内置「模型自检门」——多模态模型自动启用视觉模块(`GET/POST /snapshot` 截图+坐标锚点+SoM 标注、`/snapshot/binary` 二进制直出、`POST /act` 一次 HTTP 高层意图), 纯文本模型走选择器工作流。原 `SKILL.vision.md` 与独立 Skill `ark-web-vision` 已合并, 旧版归档于 `legacy/`。

## 架构

```
┌─────────────────────┐     WebSocket     ┌─────────────────────┐     HTTP     ┌─────────────────────┐
│   Chrome 插件        │ ◄──────────────► │   Bridge Server     │ ◄──────────► │   AI / CLI / curl   │
│   (extension/)      │   ws://9334      │   (server/)         │   :9333      │                     │
│                     │                  │                     │              │  browser-client.js  │
│  • background: CDP  │                  │  • HTTP API (117)   │              │  ark.js (别名)      │
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

### 2. 启动 Bridge Server

```bash
# Windows
start.bat        # 或: cd server && npm install && node bridge-server.js

# macOS / Linux
./start.sh       # 或: cd server && npm install && node bridge-server.js
```

### 3. 验证

```bash
curl http://localhost:9333/status    # {"connected":true,...}
```

> 以下示例均为 curl, macOS/Linux 可直接使用; Windows PowerShell 建议 `Invoke-RestMethod` 或仓库 CLI。

## 用法示例

```bash
# 打开页面
curl -X POST http://localhost:9333/open -d '{"url":"https://example.com"}'

# 元素操作 (CDP 真实鼠标/键盘)
curl -X POST http://localhost:9333/click -d '{"selector":"#search-button"}'
curl -X POST http://localhost:9333/fill  -d '{"fields":[{"selector":"#q","value":"hello"}]}'
curl -X POST http://localhost:9333/type  -d '{"selector":"#q","text":"hello world"}'

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

- `POST /act {action, ...}` 一键：`snapshot`/`click`/`clickText`/`fill`/`type`/`extract`/`navigate`/`evaluate` 单 HTTP 往返（服务端 `snapshot→mouse` 仅 1 RTT，比客户端两跳省 1 RTT）
- `GET /fast/snapshot` 别名（默认 `fast:true`）+ `POST /fast/click|fill` 快路径
- `client/ark-fast.js`：`ArkFast` 类 `snapshot()/click()/clickText()/fill()/extract()/act()/batch()` 内置 `per-tab` + `400ms snapshotCache` + `binary`，`chain "act clickText 登录"` 支持；`node client/ark-fast.js snapshot --annotate --binary` 最快
- `http` 本地页 `http://127.0.0.1` 截图直走 `captureVisibleTab` 6s 快路径，不再 `Page.captureScreenshot` 15s 挂起

## 功能亮点 (v2.8 极速 · 视觉原生)

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

## 端点总览 (117, 以 `scripts/check-endpoints.js` 核对为准)

`GET  /status /tabs /full /clear-cache /page-info /dom /html /frames /layout /screenshot /screenshot/full /pdf /cookies /storage /network /console /dom-changes /performance /vitals /resources /security /a11y /seo /dialogs /history /analyze-all /monitor/status /debug/info /debug/cdp-status`

`POST /batch /open /navigate /reload /back /forward /tab/activate /tab/close /query /query-all /query-many /exists /text /attr /value /click /hover /dblclick /rightclick /drag /mouse /scroll /scroll-by /scroll-into-view /key /type /fill /select /check /clear /focus /evaluate /wait-for /wait-for-text /wait-for-url /wait-for-load /screenshot/element /upload /highlight /highlight/clear /dialog /auto-dark /js /hardware-concurrency /cookie /cookie/remove /storage /storage/remove /storage/clear /network/clear /network/response /network/block /network/unblock /network/conditions /network/conditions/reset /network/disable-cache /bypass-csp /cpu /device /device/clear /media /geo /locale /timezone /console/clear /dom-changes/clear /monitor /monitor/stop /audit /audit/run /debug/attach-all /debug/detach-all`

`GET  /audit/status/<id>`(审计任务状态)

所有端点支持 `?tabId=<id>` 指定标签页。详细参数见 `SKILL.md` (`~/.agents/skills/ark-web/`)。

## 目录结构

```
browser-debug-extension/
├── extension/            # Chrome 插件
│   ├── manifest.json     # v2.8.0
│   ├── background.js     # CDP 管理器 + 命令实现 + 审计采集
│   ├── content.js        # 控制台/DOM/Storage 监控
│   ├── popup.html/js     # 状态 + 调试授权
│   └── devtools.html/js
├── server/
│   ├── bridge-server.js  # HTTP API + WebSocket 桥 + 缓存
│   ├── audit.js          # 审计引擎: 评分/洞察/机会/预算
│   └── audit-report.js   # 报告渲染 + 趋势存储 + 批量队列
├── client/
│   └── browser-client.js # 唯一 CLI + API 库 (keep-alive, chain)
├── scripts/
│   ├── check-endpoints.js  # 端点声明一致性核对
│   ├── real-scenario-v3.js # 20 场景 202 步终测套件 (核心验证工具)
│   ├── real-scenario-v4.js # 复杂真实情景套件 (真实站 + SPA)
│   ├── smoke-test.js       # 端到端冒烟测试 (95 项)
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
├── SKILL.md              # AI 能力手册 (统一版 v9: 文本+视觉二合一, 模型自检门; 也可作为 skill 独立安装)
├── LICENSE
├── CHANGELOG.md
└── README.md
```

## 已知限制与技术债

- 历史技术债已全部清零(v2.3.1): server 并发竞态(ALS 隔离)、命令死锁恢复链、SW 保活(alarms + keepalive port)、device clear 自愈、日志上限
- 环境依赖: 改 background.js 后需手动重载插件; 改 server 后需重启 `node server/bridge-server.js`
- 浏览器兼容: Chrome / 夸克(Chromium)均通过全量测试; 夸克 UA 下必应结果页有 `b_ans/b_top` 答案卡片(测试已适配)

## 发布打包

```bash
node scripts/package.js
# → dist/ark-web-v2.8.2.zip (含扩展/服务端/客户端/测试/文档, 排除 node_modules 与 legacy)
```

> 完整版本历史见 `CHANGELOG.md`; AI 使用手册见 `SKILL.md`。

## 故障排查

| 问题 | 解决 |
|------|------|
| `connected: false` | 插件未装/Chrome 未开, `chrome://extensions` 重新加载 |
| 命令报 unknown/error | 插件旧版, 重新加载插件 |
| 调试功能报"需要 CDP" | 点击插件图标 → 「启用调试」 |
| 端口占用 `localhost:9333` | 结束占用进程, 或换端口启动: Windows `set BRIDGE_PORT=9335` / macOS·Linux `export BRIDGE_PORT=9335` 后再 `node bridge-server.js` |
| `http://127.0.0.1` 截图超时 | 已修 `v8.1` 直走 `captureVisibleTab` 6s，`throttled` 时自动降级 |

## 安全

本地调试工具, 绑定 localhost, 无鉴权。本机进程可完全控制浏览器, 请勿在不可信环境运行。
