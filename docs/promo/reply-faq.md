# ark-web — FAQ 回复弹药库（v2.9.0）

> 原则：只写括号内确认过的特性（MV3 插件 CDP + 本地 Node 桥 localhost:9333、117 端点、snapshot+SoM、?session 隔离、30+ 维审计、batch 链式、device/media/network 模拟、MIT、v2.9.0 英文 README+Pages 站 https://aebt01.github.io/ark-web/ ），不确定的写"以仓库为准"。每条可直接复制回复。

---

## Q1：和 browser-use / playwright-mcp 有什么区别？

A：定位不同（大体对照，细节以各仓库为准）：browser-use 自带 Chromium 跑 agent 循环，登录态要另配；playwright-mcp 是 MCP 协议的 Playwright 操作层；**ark-web 是"开你的真 Chrome"**：MV3 插件走 CDP + localhost:9333 本地桥，117 个 HTTP 端点，复用你的登录态和真渲染。视觉上是一次 snapshot 拿截图+SoM 坐标锚点，多智能体靠 `?session` 服务端隔离，还自带 30+ 维审计引擎出报告。想要"AI 用我正在用的浏览器"就选 ark-web；要纯代码跑 headless 流水线，Playwright 系更合适。

## Q2：要不要科学上网？

A：**不需要。** 全链路本地运行：Chrome 插件 + 本地 Node 桥（localhost:9333），不依赖境外服务。看文档站 https://aebt01.github.io/ark-web/ 正常上网就行。模型侧（你接哪个 AI）是否要联网，以你的模型为准。

## Q3：支不支持 Firefox？

A：**目前只支持 Chrome**（MV3 插件，走 `chrome.debugger` CDP）。Firefox 支持以仓库为准——当前版本请按"仅 Chrome"理解。

## Q4：我的数据会不会外发？

A：ark-web 本身是本地桥：流量在"你的 Chrome ↔ 本机 bridge（localhost:9333）"之间，不经过项目方的服务器（项目只是 MIT 开源代码）。但注意两点：① 你让 AI 访问的网站本身会收到正常访问流量；② 你的 AI 模型在哪跑，数据就到哪——用本地模型（如 ollama）就是全本地，用云端 API 模型则 prompt/截图会发给模型厂商。以仓库为准，自行抓包验证最稳。

## Q5：和 MCP 是什么关系？需要 MCP 客户端吗？

A：**不需要 MCP。** ark-web 对外是 117 个 HTTP 端点 + Skill 手册，`curl` / 任何 HTTP 客户端都能调，AI 读 `SKILL.md` 按手册调用即可。不经过 MCP 协议。如果你已有 MCP 基础设施，可以自己包一层，但官方路径就是 HTTP，以仓库为准。

## Q6：Windows 怎么装？

A：三步（以仓库为准）：① `chrome://extensions` 开开发者模式 → 加载 `extension/` → 点插件图标"启用调试"；② 启动桥：双击 `start.bat`，或 `cd server && npm install && node bridge-server.js`；③ 验证：`curl http://localhost:9333/status`（PowerShell 建议用 `Invoke-RestMethod` 传 JSON）。依赖只有 Node + Chrome，装完打开文档站对着 quickstart 走就行。

## Q7：Chrome 136+ 的调试授权是怎么回事？

A：Chrome 136 起对 `chrome.debugger` 这类强能力管得更严，所以每次（或按版本要求）要点插件图标手动"启用调试"授权——这是 Chrome 的安全机制，不是 bug。没点授权 bridge 连不上真浏览器，点了之后以仓库流程为准。这是真浏览器的代价：换来的是可信输入和真渲染。

## Q8：和 headless 有什么区别？

A：headless 是另起一个干净 Chromium：无登录态、指纹/字体/渲染可能和你的机器不一致，登录页/SSO/验证码要重来一遍。ark-web 跑的是**你正在用的真 Chrome**：登录态、Cookie、扩展、真字体真布局都在，CDP 可信输入，看到的 Web Vitals 就是用户看到的。代价是：必须有图形界面的本机 Chrome + 手动调试授权，不适合纯服务器无头批量跑。

## Q9：耗资源吗？

A：不另起浏览器进程，资源 ≈ 你的 Chrome 本身 + 一个轻量 Node 桥（HTTP 117 端点 + WebSocket）。对比"每个 agent 一个 Chromium"的方案反而更省：多智能体是 `?session` 共用一个 Chrome，标签页级隔离。snapshot 走二进制可省约 1/3 传输（以仓库为准）。机器太老的话，少开几个 session 即可。

## Q10：能商用吗？

A：**MIT 协议，可以商用**（保留 LICENSE 声明即可，具体以仓库 LICENSE 为准）。但商用前请注意：① localhost 无鉴权——商用部署必须自己加鉴权/隔离，不要裸奔；② 你经它访问的网站的 ToS（如反爬条款）自行负责；③ Chrome 调试授权等浏览器侧限制依然存在。大原则：代码随便用，线上用请先补安全功课。

---

## 备选标题（FAQ / 帖子二发用）

1. ark-web 十问十答：和 browser-use 的区别、Firefox 支持、数据外发，一次讲清
2. 关于"AI 开真浏览器"的 10 个高频问题（登录态/无鉴权/商用）
3. 先看这篇再装 ark-web：10 条 FAQ 避坑指南
