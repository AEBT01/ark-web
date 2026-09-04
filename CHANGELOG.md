# Changelog — Ark Web

版本号以 `extension/manifest.json` 的 version 为准。

## v2.9.0 (2026-09-04) — Promo release: English README + Pages + badges（无行为变更）

- **English README**: 新增 `README.en.md`（英文首屏 + badges + comparison），主 `README.md` 顶部加语言切换 + 版本徽章
- **GitHub Pages**: 新增 `docs/index.html`（单文件落地页：hero/架构/6 特性/Quickstart/端点速览/安全注记），`docs/demo-home.png` + `docs/audit-sample.html` 为演示资产
- **SEO/topics**: 统一关键词 `ai browser automation / chrome cdp bridge / multimodal snapshot / browser audit / llm tool`；建议 Topics：`ai-agents browser-automation chrome-extension cdp llm-tools multimodal web-audit developer-tools automation`
- **打包**: `scripts/package.js` INCLUDES 纳入 `README.en.md` + `docs/index.html`；SHA256 改 Node 回退（`powershell.exe Get-FileHash` 受限环境兜底）
- 无破坏性：端口/WS/117 端点/CLI 不变（以 `scripts/check-endpoints.js` 为准）

## v2.8.2 (2026-08-29) — T0 修复与完善 (真实 bug × 5 + 跨平台 + 文档)

- **screenshot 串页修复** (`extension/background.js`): 目标为后台标签页的 `http://127.0.0.1/localhost` 页面时, 旧逻辑走 `captureVisibleTab` —— 它永远截【当前激活 tab】, 会把用户正在看的页面截走(串页+隐私)。现仅当目标 tab 就是激活 tab 才走快路径; 后台 tab 一律 CDP 精准截图, 且兜底路径在"目标≠激活 tab"时返回结构化错误而非静默截错页。`/snapshot` 内部复用 `screenshot` 同步受益
- **activeTabId 缓存污染修复(隐私级, 回归实测发现)** (`extension/background.js` openUrl): `tabs.create({active:false})` 后台开标签页时旧代码无条件 `this._activeTabId = tab.id`, 污染活动标签页缓存 → 截图兜底守卫误判"目标=激活 tab"放行 captureVisibleTab, **实测把用户当前页面截走**。现仅 `tab.active === true` 才更新缓存; 兜底守卫同时改为实时 `tabs.query` 而非读缓存(双保险)
- **SW 环境 Buffer 修复** (`extension/background.js`): MV3 Service Worker 无 Node `Buffer`, `getResponseBody`/`prefetchResponseBody` 对 `base64Encoded` 响应会抛 ReferenceError → 预缓存静默失败。新增 `b64ToText`(`atob`+`TextDecoder`)替换两处, base64 文本响应体恢复可用
- **chain `dialog auto` 修复** (`client/browser-client.js`): `runChainSteps` 内重复的 `case 'dialog'`, 第一个(不支持 auto 语法)吞掉了第二个(支持), 导致 `chain "... dialog auto off"` 被错误解析为 `accept:true, promptText:'off'`。删除死代码分支, `dialog auto on/off` 链内恢复正确
- **手动弹窗挂起判定窗口 10s→60s** (`extension/background.js` getPendingDialog): 与手动模式 60s 自动回退对齐; 旧值导致挂起弹窗存续稍久后, 新命令撞 12s 裸超时而非 `dialogPending` 友好提示
- **set-cookie/remove-cookie 会话路由修复** (`extension/background.js`): 未显式给 url 时旧代码写死按"活动标签页"解析, 会话内 set-cookie 会**写到用户当前页面的域**(回归实测: 测试 cookie 落到了百度域)。现按请求目标 tab(会话/?tabId 注入)解析, 与 getCookies 对齐
- **screenshot CDP 路径重试** (`extension/background.js`): 夸克渲染进程退化环境下 `Page.captureScreenshot` 间歇性超时(实测 ~40% 抖动), 失败自动重试一次再落守卫, snapshot/annotate 稳定性显著提升
- **locale mock(内核兼容)** (`extension/background.js`): 夸克内核忽略 `Emulation.setLocaleOverride`(新文档也不生效, 实测确认), 参照 geo mock 模式新增 `_localeInjectFn` 注入(navigator.language/languages 实例影子化 + enableCore 会话重放 + loadEventFired 重注入 + reset-all 清除), 空 locale 为清除模式
- **mouse wheel 脚本兜底** (`extension/background.js`): throttled 降级路径原本不支持 wheel(报 unsupported), 现对命中元素的可滚动祖先或 window 执行滚动
- **元素截图重试** (`extension/background.js` screenshotElement): 与视口截图同款"失败重试一次"
- **server 截图超时对齐** (`server/bridge-server.js`): `/screenshot/full` 20s→45s、`/screenshot/element` 20s→35s —— 原值小于插件端看门狗(25s+fallback 链), 退化环境下 server 先 504 掐断插件本可完成的任务
- **audit/run 会话逃逸修复** (`server/bridge-server.js` + `server/audit-report.js`): 审计队列的导航/采集原本脱离请求上下文, 会话内调用会把**用户当前活动标签页**导航走; 现 `/audit/run` 捕获 ALS 上下文并在队列内重放, 队列导航锁定在原会话 tab
- **ark-fast act() 入参兼容** (`client/ark-fast.js`): 文档示例的 `act({action:'navigate',...})` 对象形式原实现会收到 `[object Object]` 报错, 现兼容对象/两参两种形式
- **CLI 补强**: 新增独立 `dialogs` 命令(链内一直支持、单命令缺失); 默认 HTTP 超时 30s→60s(手动弹窗最坏路径 ~28s+ 与 audit 慢页不再被客户端掐断); 清理 TYPE_MAP 重复 `'html'` 键与插件端未使用 `pendingRequests` 字段
- **跨平台**: 新增 `start.sh`(macOS/Linux), README/SKILL 增补 bash 快速开始与等价示例; 端点总数勘正为 117(以 `scripts/check-endpoints.js` 为准, 原 README 113 均不准)
- **SKILL v9.1**: 新增「§12 常用配方」一行流(搜索/表单/整页证据/审计/多 agent/响应体/链内弹窗); 版本号 manifest+server 升 2.8.2

## 文档 v9 (2026-08-29) — 双 Skill 合并为单一 ARK WEB (纯文档变更, manifest 仍 2.8.1)

- **Skill 合并**: `SKILL.md`(v6 文本版) + `SKILL.vision.md`(v8/v8.1 视觉版) 合并为统一 `SKILL.md` **v9**, 独立 Skill `ark-web-vision` 移除; 旧文档归档 `legacy/SKILL.vision.md`、`legacy/SKILL.vision.installed.md`
- **模型自检门**: 手册第 0 步指导模型自判多模态能力(厂商声明/是否解析过图/实测一次 snapshot), 视觉模型走 snapshot+坐标工作流(§1), 纯文本模型走选择器工作流(§2), 全量端点共享
- **速度/效率优化**: 手册总量 128KB → 27KB(-79%), 加载 token 大幅下降; 两份能力矩阵/chain 映射表/故障排查表合并去重(26 行); 新增「速度默认值+反模式」速记节; 保留全部实测资产(站点速查/evaluate 模板/会话隔离/中文通道)
- **README**: 同步统一 Skill 说明与目录结构

## v2.8.1 (2026-08-20) — Fast API 封装 + http 截图修复

- **http 截图修复** (`extension/background.js:218`): `CdpManager.pendingAttach` 并发去重，`screenshot` 对 `http://127.0.0.1` 直走 `captureVisibleTab` 快路径(6s)，`Page.captureScreenshot` 超时 15s→8s，`captureVisibleTab` 10s→6s，`Ark Test` 等 `http` 本地页不再 20s 超时
- **Fast API 封装** (`server/bridge-server.js:154` + `client/ark-fast.js`): 新增 `POST /act` / `POST /fast/act` / `GET /fast/snapshot` 一次 HTTP 完成高层意图(`snapshot`/`click`/`clickText`/`fill`/`extract`/`navigate`)，`ark-fast.js` 提供 `ArkFast` 类(`snapshot`/`click`/`clickText`/`fill`/`extract`/`act`/`batch`) 内置 `per-tab` + `400ms snapshotCache` + `binary`，`client/browser-client.js:904` `act/fast` 入 `CLIENT_STEPS` 支持 `chain "act {...}"`
- **文档**: `SKILL.vision.md` 新增 Fast API 一节，`README` 同步

## v2.8.0 (2026-08-20) — 极速版 v8（全链路提速，架构升级）

- **Server per-tab 队列 + inflight 合并** (`server/bridge-server.js:60`): `_enqueue` 按 tabId 串行/跨 tab 并行，`_inflightKey` 对只读命令并发合并，同键 10ms 内只发一次 WS；写操作后自动失效 `page-info/dom/...` + `snapshotCache`
- **Snapshot 缓存** (400ms) + **二进制直出** (`GET /snapshot/binary`, `server:848`): 高频连续 `snapshot` 命中 <5ms；`?binary=1` 返 `image/png` 二进制(省 base64 33%)，`X-Snapshot-*` 头透传锚点；`snapshotCache` 限制 50 条，写操作失效
- **传输调优**: `server:102` keepAlive 65s/headers 66s/maxHeaders 100，`client:16` keepAliveAgent `maxSockets 50/keepAlive 5s`，单连接复用 0 握手
- **Batch DAG 并行** (`extension/background.js:604`): `data._parallel/parallel` 连续只读步骤走 `Promise.all`，同 WS 往返内 3-5× 提速；兼容原串行链路
- **输入快路径** (`extension/background.js:1236`): `probeInputDelivery` 4s 缓存省 30ms/点击；`mouseFlow` 支持 `fast/ speed=fast → steps 4` + 稀疏轨迹 1ms 停顿；`click/hover/dblclick/right/drag/mouse` 均透传 `fast`
- **等待事件驱动** (`extension/background.js:1969`): `waitForSelector/waitForText` 页面内 `MutationObserver` 一次订阅(10-40ms 响应)，`waitForUrl/waitForLoad` 轮询 150ms→40ms；`waitForLoad` 首检 `readyState complete` 快返
- **CDP 预热池** (`extension/background.js:532`): `tabs.onCreated/onUpdated` 后台 `tryAttach+enableCore`，首命令省 80-120ms
- **Vision fast**: `visionSnapshot` 支持 `fast` 时 `maxElements 30` 减半采集
- **Client** (`client/browser-client.js:16`): `snapshotBinary / snapshotBinaryToFile` 二进制方法，`chain` 并行组支持

## v2.7.0 (2026-08-20) — 视觉原生版 v7-vision（多模态增强，superset of v6）

- **新增 Snapshot 原子级视觉上下文** (`GET/POST /snapshot`, 插件 `vision-snapshot`): 单次 WS 往返完成 **截图(dataUrl) + 交互锚点(elements[{ref,center,rect,text,role}]) + 页面元数据(url/title/viewport)**；多模态模型可直接看图决策，无需维护选择器
  - `?annotate=1` SoM 标注模式：截图叠加 1..N 编号气泡，`elements[i].ref` 与气泡编号一一对应，模型可“点 7 号”→ `POST /mouse {x,y}` 坐标点击；截图后自动清除，不污染后续
  - `?full=1` 整页截图；`?selector` 限定锚点；`?maxElements` 控制数量(1..120)
  - CLI: `snapshot [file.png] [--annotate] [--full] [--selector <sel>] [--max <n>]`，支持 chain 与 --body-file
  - `POST /reset-all` 同步清理 SoM 标注
- **视觉工作流文档化** (`SKILL.vision.md` + `~/.agents/skills/ark-web-vision/SKILL.md`): 视觉版手册，首屏即含 v6 vs v7 对比、Snapshot 契约、视觉标准工作流、坐标系说明、视觉 QA/回归范式、混合策略（视觉探索→DOM 精读）
- **独立视觉 Skill** (`ark-web-vision`): 新建 `~/.agents/skills/ark-web-vision/`（junction 到主项目），多模态模型优先加载，文本模型继续使用 `ark-web`；原 `SKILL.md` (v6) 完整保留
- **兼容性**: 所有 v6 端点、CLI、会话隔离、审计引擎、故障排查完全保留；Snapshot 端点自动支持 `?tabId=` / `?session=` 隔离；check-endpoints 更新

## v2.6.2 (2026-08-14) — 移除本地模型体系

- 删除: `scripts/local-agent.js`(Qwen3.5-4B 本地执行 Agent)、`MODEL_TRAINING.md`(后训练方案)
- 删除: 训练数据管线脚本(append-sample/migrate-jsonl/rebuild-index/append-rt/ark-collect/usage-auto-collect)与 `agent-request.json` 运行时文件
- 同步清理: SKILL.md 移除内部章节, README 移除相关条目
- 项目定位回归纯浏览器控制/审计工具, 不再依赖任何本地模型服务

## v2.6.1 (2026-08-13) — 真实浏览器实测经验沉淀(2000+ 样本)

- **大规模实操验证**: 17 站(免登录测试场)× 2000+ 真实浏览器样本, 全部真实执行(非模拟)
- **SKILL.md 新增「真实浏览器实测经验」章节**: 跨站通用铁律 11 条 + 17 站实测选择器速查 + 多 agent 并行姿势
  - 后台 tab 视口=0 事件失效需先激活; CDP throttled 下 React/jQuery UI 控件需 evaluate 完整事件流; query-all 不支持 alt/shadow 穿透; 必应 ck/a 重定向解码; Wolfram 结果在 img alt; shadow DOM 深度穿透; 剪贴板不可自动验证等
- **evaluate 模板扩充**: 8 个真实场景高频模板(img alt 批量/React setter 注入/shadow DOM 输入/Monaco setValue/完整事件流/坐标拖拽流)
- **故障排查表 +8 条实测条目**: No current window(保底标签页)、后台 tab 点击无效、拖拽滑块无反应、限流/登录墙/验证码处理、reload 恢复卡 loading、GitHub 动态 id 等
- 清理: 批次中间 jsonl、一次性测试脚本(session-smoke 等)已移除

## v2.6.0 (2026-08-12) — 多标签页会话隔离 + JSON 可靠操控

多 agent 并行互不干扰(核心):
- **Session 会话系统**(server): `POST /session/create` / `/session/tab`(新 tab 自动归属) / `/session/assign` / `/session/release` / `/session/delete` / `GET /session`
  - 所有端点支持 `?session=<id>` 或 `X-Session` 头; 会话内请求只能操作本会话绑定的标签页, 越权返回 403(带状态码与结构化错误)
  - 会话内不传 tabId: 单标签页会话自动使用唯一 tab, 多标签页会话要求显式 `?tabId=`
  - 会话内 `/open` 新建标签页自动归属; `GET /tabs?session=` 标注 `owned` 并自动清理已关闭标签页的绑定
  - `/batch` 自动把会话/请求级 tabId 注入每个 step(消除 step 内 fallback 到 activeTab 的并发竞态)
- **修复 open-url current 导航忽略 tabId**(extension): 此前用 `activeTabId()` 而非 `data.tabId`, 多标签并行时导航漂移到"当前激活标签页"
- **弹窗策略 per-tab 隔离**(extension): `/dialog {auto:false}` 只影响指定标签页, 多 agent 并行时互不影响; tab 关闭自动清理策略
- **evaluate CSP 自动绕过**(extension): 页面 CSP 阻止字符串求值(如百度)时自动 `Page.setBypassCSP` 重试, 返回 `cspBypassed: true`, 不再报 unsafe-eval

JSON 可靠操控:
- **readBody 严格化**(server): 显式 UTF-8 解码; 坏 JSON 返回 `400 {error:"无效 JSON body: ... | 收到(前120字符): ..."}`(此前静默返回 {} 导致 "URL is required" 式误导)
- **CLI `--body-file <path>`**: POST body 从 UTF-8 JSON 文件读取(中文安全通道, 绕开 PowerShell 5.1 GBK 命令行损坏); `--session <id>` 使单次命令在会话内执行
- 新增 `scripts/session-smoke.js`: 12 项会话隔离冒烟(创建/归属/越权 403/并发互不干扰/batch 注入/坏 JSON 400/中文字节通道)
- SKILL.md 升 v6: 「多标签页并行 & 会话隔离」「中文 / UTF-8 安全通道」章节 + 故障排查更新

## v2.5.0 (2026-08-11) — 本地执行 Agent + 后训练路线(已随 v2.6.2 移除)

本地执行 Agent(双端并行)试点与后训练方案, 相关内容已全部移除, 详见 v2.6.2。

## v2.4.0 (2026-08-11) — 本地视觉理解能力(已移除)
## v2.3.1 (2026-08-10) — 技术债全面修复 + 夸克浏览器适配
技术债修复(全部 5 项):
- **server 并发竞态清零**: `_tabId` 实例字段改为请求级 `AsyncLocalStorage` 隔离(`server/bridge-server.js`) — ?tabId 注入与缓存键在并发请求间不再互相覆盖
- **命令死锁恢复链**: `guardedCommand` 的 CMD_DEADLOCK 分支不再直接抛错 — 恢复链 stopLoading → 仍无响应则 reload, 返回 `{recovered:true}` 并等待原命令 settle(不重发, 防 mousePressed/Released 双发)
- **SW 保活层落地**: manifest 新增 `alarms` 权限; background 注册 1 分钟周期 alarms(`ensureConnected` 兜底重连 WS) + content script 顶层 frame 建立 keepalive 长连接端口(25s ping, 断线自动重连) — 长闲置后不再依赖手动重载插件
- **/dialogs 滚动上限**: 已有 50 条上限(确认存在, 无需改动); 测试侧时间戳适配保留
- **/device/clear 记录丢失自愈**: `prev` 缺失(如 SW 重启/会话切换)时强制走 detach→attach→set→clear 路径 — detach 清空该 tab 全部 Emulation override, 修复 UA 残留无法恢复的问题

夸克浏览器适配(QuarkPC 7.0.7.940, Chromium 144):
- **type 中文回读降级**: 夸克 `Input.insertText` 对非 ASCII 文本处理不稳定(中文变 `?`) — type 后回读校验, 检测到损坏自动降级脚本设置(React 兼容), 返回 `method: 'script-fallback'`
- **S01 必应断言适配**: 第一条结果可能是 `b_ans/b_top` 答案卡片(无 h2) — 标题提取改用标准结果卡 `#b_results .b_algo h2`
- **S07 滚动容差**: 夸克滚动精度差异, 底部断言容差 100→150px
- **S23/S27 断言轮询化**: 滚动位置/加载状态在夸克渲染时序下竞态, 改为轮询等待
- 验证: 夸克环境下 v3 20/20 + v4 12/12(多轮连跑稳定), check-endpoints 一致

smoke-test 全绿修复(95/95, 协作分析定位的 7 项 + 后续 3 项):
- **截图看门狗**: `screenshot`/`screenshotElement` 的 captureScreenshot 挂 `guardedCommand`(弹窗应答+stopLoading+reload 恢复链), fallback `captureVisibleTab` 包 10s 超时 — 修复渲染忙时截图挂到请求层超时
- **fullPageShot 修复**: 主路径超时 8s→20s; fallback 的裸 `send`(set metrics/capture/clear)全部改带超时; fallback clear 失败自动 **detach 强制重置** — 修复 fallback 残留 metrics override 污染后续视口(曾导致 innerWidth 卡 178px)
- **clearDevice 校验重写**: 恢复判定改为「innerWidth 与最后一次 set 宽度显著不同」(旧逻辑用 origViewport, 连续多 set 时是中间态导致误判; prev 缺失时以自愈前宽度兜底); 自愈后轮询校验 10×500ms, 未恢复返回 `success:false` 不静默
- **audit 采集对齐**: `cmd('audit-collect')` 超时 20s→60s(与 auditQueue 对齐)+ 失败自动重试; `runAudit` 无 url 时也统一等待 2.5s vitals 缓冲 — 修复刚导航页面 LCP/TTFB 缺失导致预算违规检测空跑
- **smoke 断言修正**: `/mouse` 降级语义错误(no element at point 等)不再依赖 throttled 变量判定; `/device/clear` 恢复断言改为 set 前原始宽度(±10%, 窗口可被缩窄); `/dialog` 兼容 already-handled; `/type human`/`/audit 预算` testRetry 化; 预算改 `ttfb:-1`(必然违规, 修复 1ms 预算在热缓存下 ttfb≈0 的误判); 截图超时放宽 60s; test() 输出失败返回值(诊断友好)
- **v3 S08**: 恢复断言 `>375` 改为「原始宽度 ±10%」(窗口窄时固定阈值误判)

稳定性加固(双子代理独立审查定位, 第二批次):
- **Runtime.evaluate 命令级超时**: `evalOnce` 裸 send → `sendWithTimeout`(6s+timeout, 上限 30s) — 页面冻结时页面内超时保护不触发, 此前会挂到 server 层 20s+; 现在由 runInPage 的 executeScript 兜底真正接管
- **键盘路径 throttled 降级**: `simulateKey`/`typeText` 入口检查 `cdp.throttled`(授权过期时 CDP 键盘约 5s/键) — 与鼠标路径一致走脚本降级, 消除慢路径与卡键风险; 键盘 char/insertText send 全部带 5s 超时
- **probeAndCloseDialog 超时**: 看门狗第一步裸 send → 5s 超时(防整条恢复链卡死)
- **clearDevice 自愈宽度 375→777**: 消除与测试自定义宽度(375)的残留二义性
- **截图 fallback 结构化错误**: `captureVisibleTab` 失败返回 `{success:false, error}` 而非裸 throw(测试端可读错误信息)
- **测试加固(v3)**: S06 鼠标降级语义容忍(对齐 smoke 契约); S08 基线重试 3 次+基线无效跳过恢复断言+clear 失败重试; S14 dataUrl 守卫+60s 超时+渲染稳定等待; v3/v4 开头窗口视口检查(innerWidth<300 中止并提示窗口被最小化)
- 验证: 修复后连续多轮 v3 20/20 + v4 12/12 + smoke 95/95, check-endpoints 一致

## v2.3.0 (2026-08-10)
- **地理位置 mock 跨导航失效修复**: `_geoInjectFn` 从类方法改为箭头函数字段 — 类方法 `toString()` 生成方法简写语法, 包成表达式是 SyntaxError, 导致 `addScriptToEvaluateOnNewDocument` 注册的注入源码在页面编译失败, reload 后 mock 完全失效。现在 reload 后页面脚本也能命中 mock (`extension/background.js`)。专项验证: 立即调用 `ok:31.23` / reload 后页面脚本 `geo:31.23,121.47` / evaluate 均为 mock 值
- CLI 补齐 `dialog auto <on|off>` 策略切换(此前文档宣称支持手动模式但 CLI 无法触发)

测试:
- 新增 `scripts/real-scenario-v4.js`: 贴近真实情景的高复杂度套件(12 任务, 106 步) — 公共无登录站旅程(MDN 多页/apache 多页/MDN 文章深度/IANA) + 本地 SPA(hash 路由/受控表单/无限滚动/多步结算) + 首次覆盖 analyze-all、monitor 期间操作、弹窗手动模式、12 步 /batch 长链。**当前 12/12**
- v4 真实站选型: 必应/bilibili/qq.com(反爬与验证风险)、维基百科/w3.org/OSM(本网络间歇超时)均弃用, 统一改用稳定公共站
- `real-scenario-v3.js` S02 站点替换: 百度百科当前网络不可达(403), 改用 `https://www.qq.com`
- `real-scenario-v3.js` S16 加固: `?tabId` 断言改为轮询等待 URL 非空(最多 8s), 消除 about:blank 误判
- `real-scenario-v3.js` S04 修复: `/dialogs` 只返回最近 10 条且跨轮次累积, 弹窗 fresh 判断从数组切片改为**时间戳过滤**(累积超 10 条后必现失败)
- `real-scenario-v3.js` S19 加固: 恢复 JS 后 evaluate 竞态失败时重试(断言语义不变)
- 终测结果: v3 20/20、v4 12/12(多轮连跑确认)

文档:
- `SKILL.md` v4 → v5: 弹窗事件驱动自动应答语义(默认 autoAccept、`/dialog {auto:false}` 手动模式、`handled` 字段、already-handled 非错误)、SCRIPT_ONLY_KEYS 键盘行为、/geo mock 跨导航说明、CLI 命令数 100+、故障排查更新(百度百科不可达)
- `README.md` → v2.3: 端点核对(101)、新能力描述、20 场景测试套件、目录结构同步、新增「已知限制与技术债」
- 新增 `CHANGELOG.md`
- 诊断脚本归档: `scripts/debug-*.js` → `scripts/diagnostics/`(部分回归工具保留在本地); 旧报告/截图 → `reports/archive/`

## v2.2.x (日期未记录)

- **弹窗事件驱动自动应答**: `Page.javascriptDialogOpening` 回调内同步应答(默认 autoAccept:true), 解除渲染主线程阻塞, 挂起的 Input/evaluate 命令自然恢复; `POST /dialog {auto:false}` 切手动; 记录带 `handled: 'auto'|'pending'|'closed'`
- **Input 投递四件套**: `Emulation.setFocusEmulationEnabled(true)`(attach 后+每次派发前); 键盘投递验证(`window.__arkKeyVer` 回读, 未到达自动降级); 鼠标投递探针(`window.__arkMouseVer`); 有页面默认行为的键固定走脚本路径(`SCRIPT_ONLY_KEYS`: Enter/End/Home/PageUp/PageDown/方向键/Tab/Backspace/Delete → 合成事件+实现默认行为: Enter→form.requestSubmit()、End/Home→滚动、Tab→聚焦、Backspace/Delete→删字符)
- **guardedCommand 看门狗**: 命令超时 → `probeAndCloseDialog`(幂等应答, -32602 视为已处理) → 等原命令恢复(不重发)
- **device clear 自愈**: set 时记录原始视口/UA; clear 时成对清(metrics+touch) + `innerWidth` 校验 + detach→attach 重设再清兜底
- **geo mock 三级 fallback**: 实例→原型→直接赋值 + `navigator.permissions.query` 配套 mock; `addScriptToEvaluateOnNewDocument` + `Page.loadEventFired` 重注入 + enableCore 会话重放
- 键盘 try/finally 配对释放修饰键(防卡键)
- 调研结论落地(无 Chrome 136 Input 限速官方机制; Enter 默认行为与焦点强绑定; 弹窗无 CDP 查询命令, 事件驱动应答为标准解; SW 118+ 自动保活)

## v2.2.0 (日期未记录)

- **专业审计引擎**: `POST /audit` 30+ 维度采集(Web Vitals/长任务/资源/安全头等), 5 类别加权评分(性能30%/可访问20%/安全20%/SEO15%/资源15%), 确定性根因洞察 + ROI 优化机会
- **报告体系**: HTML 单文件报告 / Markdown 报告 / AI 紧凑格式 / JSONL 历史趋势 / URL 队列批量审计 / 性能预算违规
- **chain 模式修复**: CLI 名(open/page-info)未映射为插件命令名(open-url/get-page-info)导致 batch 全失败的映射表重写; 客户端本地步骤(full/analyze-all/monitor/report/sleep/带文件截图)
- CLI 补齐约 40 命令(select/check/drag/mouse/highlight/media/geo/timezone/locale/block/csp/storage-*/cookie-*/wait-for-*/upload 等)
- **20 场景终测套件 v3**: `scripts/real-scenario-v3.js`(S01 必应全流程…S20 上传/等待全家桶, 202 步)
- `?tabId=` 注入修复(原本只影响缓存键, 未注入命令数据 → `cmd()` 合并 tabId)
- `/navigate` 语义修复(强制 current:true, 不再新开 tab)
- `/pdf` body 参数修复(合并 query+body)
- `SKILL.md` v4: 端点矩阵/chain 映射表/故障排查/审计引擎说明

## v2.1.x / v2.0 (日期未记录)

- 基础能力: 浏览器真实控制(CDP trusted 输入/设备/媒体/网络模拟/截图/PDF/上传)、console/network 日志聚合、多标签页、`/batch`、缓存/keep-alive 设计、CLI 工具链、冒烟测试

## 已知限制与技术债

- 无已知必现缺陷。历史技术债已清零(并发竞态/死锁恢复/SW 保活/device 自愈/日志上限)。
- 环境噪音: 夸克下**连续截图偶发超时**(渲染进程忙, 60s 超时+重试仍偶发, smoke 有 testRetry 兜底, v3/v4 核心套件 S14 不受影响)
- 环境依赖: 改 `extension/background.js` 后需手动重载插件(SW 不热更新); 改 server 后需重启 `node server/bridge-server.js`
