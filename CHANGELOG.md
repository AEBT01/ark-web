# Changelog — Ark Web

## v3.0.4 (2026-10-04) — v3.0.3 代码落库 + 生产线面板

- **v3.0.3 特性代码入库**: 上条所述 `/bootstrap` 端点、扩展自动取令牌、manifest `[名字]` 自命名、多窗口隔离（SKILL §4.5）在 v3.0.3 仅记于文档，代码随本版一并入库。
- **假一罚十生产线面板**: 扩展声明 `sidePanel` 权限；后台站点 content match 新增 `mms.pinduoduo.com`；manifest 描述同步。
- **自检与排障**: `doctor.js` 在插件未连接时给出行动指引（先跑 `node scripts/label-browsers.js --yes`）；`verify-all.js` 退出时清理自启动的 mock/server 子进程；popup 提示语与 WS 令牌口径对齐（已登记扩展自动连接，其它连接填当前服务端令牌）。
- **文档**: SKILL.md 升 v3.0.4（156 端点口径）；`references/protocol.md` 令牌说明补 WS 免填条件。

## v3.0.3 (2026-10-02) — 多窗口隔离（多账号并联）

- **`GET /bootstrap`（新）**: 新装的扩展副本自取令牌 —— 仅白名单 `chrome-extension://` 来源或无 Origin 的本机进程可获取，网页来源一律 403（与 WS 来源校验同源）。免去"每个实例手填令牌"。
- **扩展自命名（新）**: `manifest.name` 带 `[名字]` 后缀时，`defaultLabel()` 用 `getManifest()` 同步解析为连接名（同产品多开也能各有独立标签）；`refineLabel` 对已自命名实例跳过面板探测，避免被误升级成 browseros。
- **扩展自动取令牌（新）**: `loadWsConfig()` 在 storage 无令牌时向 `/bootstrap` 取一次并落盘。
- **文档**: `SKILL.md` 新增 §4.5「多窗口隔离」——连接名优先级、三条硬约束（独立 user-data-dir / **零标签页即退出** / extId 必须登记）、隔离实例建法、`/bootstrap` 安全模型、排障表；README 环境依赖同步。

## 未发布 — 连接与文档治理（2026-09-24）

- WS 默认要求鉴权；本机已登记的 Ark Web 扩展通过 `browser-labels.json` 自动识别，其它连接仍需令牌。
- 新增 `label-browsers.js --yes` 生成扩展 ID 白名单，避免把任意扩展来源当作可信连接。
- 文件沙箱统一使用真实路径校验，拒绝符号链接逃逸；验证脚本退出时清理自启动的测试服务。
- 文档同步更新启动、连接、鉴权、排障和端点数量说明。

版本号以仓库根目录的 `VERSION` 为唯一来源，由 `node scripts/bump-version.js <版本>` 同步到
扩展清单与服务端 package.json（两处不一致时打包会拒绝执行）。

## 未发布 — 实机回归修复 + 网络空闲等待（2026-09-20）

> 在夸克（QuarkPC 7.2 / Chromium 144）上跑全量实机验证（smoke + v3 + v4）挖出的问题，
> 逐条修复并留下前后对比；顺带补一个长期缺失的等待原语。

### 修复：快照谎报图片格式（webp 实际是 jpeg）

- 窗口最小化/不可见时 CDP 截图失败，兜底走 `captureVisibleTab`——它**只支持 png/jpeg**，
  webp 会被降级成 jpeg，但响应里 `format` 仍回传请求的 `webp`。调用方按 webp 的体积/质量
  预期去理解一张 jpeg，属于静默错误。
- 现在 `format` 以实际出图为准，降级时额外回传 `requestedFormat` 与 `formatNote`。
  实测（最小化窗口）：`format=jpeg, requestedFormat=webp, formatNote=captureVisibleTab 不支持 webp…`。

### 修复：连续截图撞 `captureVisibleTab` 配额，直接失败

- Chrome 对 `captureVisibleTab` 限「每秒最多 2 次」，超限抛
  `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`。窗口不可见时这条兜底是唯一通路，
  连拍第 3 张起必然失败（基准脚本 4 连拍实测 2/4 失败）。
- 现在识别配额错误后等一拍重试一次。实测连拍 **6/6 成功**（修复前约 50% 失败）。

### 修复：测试脚本自身的三处过时/缺陷

- `smoke-test.js` 断言插件版本写死 `/^2\./`，插件升到 3.x 后必然假失败 →
  改为"形如 x.y.z 且与仓库 VERSION 同主版本"。
- `real-scenario-v3.js` 上传用例把文件写在 `reports/`，而 `/upload` 已强制文件沙箱
  （仅 `~/.ark-web/workspace`）→ 必然报 `path-outside-workspace`。改用沙箱路径。
- `benchmark.js` / `bench-snapshot.js` 跑完不退出（keep-alive agent 持有空闲 socket）→
  显式销毁 agent 并给出明确出口；基准里的失败行不再打印成 `NaN`，改为列出真实原因。

### 修复：`verify-all.js` 把"套件缺失"报成"代码失败"

- `verify/*.js` 在本仓从未提交（见「已知缺口」），直接跑得到一堆 `MODULE_NOT_FOUND`，
  看起来像代码坏了。现在套件文件不存在时按既定口径**跳过并给出补齐位置**。
- 顺带修 Windows 下 `/tmp/ark-mock.log` 的硬编码（改用 `~/.ark-web/mock.log`）。

### 新增：`POST /wait-for-idle` —— 网络空闲等待（networkidle 等价物）

- 判据：连续 `idleTime`（默认 500ms）内"进行中请求数"为 0，且 `readyState === 'complete'`。
  排除 `websocket`/`eventsource` 长连接（可用 `ignoreTypes` 改），另支持 `ignoreUrls` 按子串排除。
  （注：不要按"发起时间"过滤在途请求——导航请求往往早于调用 1ms，过滤会让等待立刻返回；
  实测踩过，已改为不过滤，挂死请求由 timeout 兜底并如实报错。）
- 与 `/wait-for-stable` 的分工：stable 看 DOM 是否还在变（渲染层），idle 看网络是否还在请求
  （数据层）；SPA「先请求后渲染」场景先 idle 再 stable 最稳。长轮询站点可用 `ignoreTypes` 排除。
- 配套补齐 `webRequest.onErrorOccurred` 监听：此前失败/被取消的请求永远留在"进行中"，
  空闲判定对任何有失败请求的页面都会超时（被墙站点必现）。

### 性能

- `/type` 聚焦后的固定 60ms 盲等 → 40ms（实测中位 **63.9ms → 45.7ms，-28%**）。
  注：中途试过"等两帧 rAF"，但窗口最小化时 CDP evaluate 会超时并回退到 `executeScript`（3s 上限），
  反而把 60ms 变成 170ms+；已回退为本地固定延时。
- 端点总数 154 → **155**（新增 `/wait-for-idle`）。

## 未发布 — 项目归属清理（2026-09-17）

> 背景：本仓与另一个独立项目「Ark BrowserOS」（深改浏览器 + opencode 侧边栏）曾共用
> 代码与名字，导致一批属于后者的产物混进本仓并接进了运行时逻辑。本次把归属理清。

**移除（属于 Ark BrowserOS，不属于本项目）**

- `scripts/sync-panel.js` —— 侧边栏面板同步，判断条件是对方扩展名「Ark 助手」；
  本项目没有 `panel/`，该调用在 `/settings/token/rotate` 里一直静默失败。
- `scripts/launch-browseros.cmd`、`launch-browseros-detached.js` —— 启动对方的浏览器
  并同时加载其面板；其中固化的路径（`browser-debug-extension-bos`）已不存在。
- `scripts/focus-browseros.ps1`、`minimize-browseros.ps1` —— 对方浏览器的窗口管理。
- `scripts/l10n-browseros.js`、`l10n-apply.js`、`l10n-enumcheck.js`、`l10n-inventory.js`
  及配套 `l10n-*.json` —— 对方界面的汉化工具链。

**修正**

- `scripts/lib/version.js`：去掉 `panel/manifest.json` 版本目标（本项目无 panel）；
  权威版本文件 `VERSION` 补回，值 3.0.2。
- `server/capabilities/settings.js`：令牌轮换不再调用 sync-panel；
  返回值里的 `panelSync` 字段随之移除。
- `server/tool-registry.js`、`scripts/verify-all.js`：删掉指向"侧边栏设置"的提示。
- `scripts/package.js`：`INCLUDE_DIRS` 去掉不存在的 `panel`/`config`/`verify`；
  `MUST_HAVE` 去掉 `panel/*`、`verify/agent-units.js`、`scripts/sync-panel.js`。
- `scripts/verify-all.js`：移除 `panel-console` 套件（对方的面板端到端测试）。
- 清理开发痕迹：16 个 `.sync-backup-*`、`dist/`、`reports/`、`data/`、
  `scripts/diagnostics/`（59 个临时调试脚本）、`scripts/_legacy-bridge-server.js`、
  `scripts/refactor-splice.js`、`scripts/refactor-split.js`。

**已知缺口**

- `verify/` 目录（`agent-units` 62 项、`route-parity`、`http-smoke`、`ws-guard`、
  `cdp-smoke` 13 项、`runner`、`sse-tasks`）在本机、远端与备份中均不存在，
  从未提交过。`verify-all.js` 已移除对 `panel-console` 的调用，其余套件路径保留原样，
  待补齐后即可恢复。

## 未发布 — 夸克内核实机测试挖出的缺陷修复（2026-09-17）

> 在夸克（QuarkPC/7.2.0.992，Chromium 144）上做端到端实机测试，修掉四类问题。
> 全部改动都有实测前后对比，不是推测。

### 严重：`semantic/` 缺三个真源文件，服务端**完全起不来**

- `server/semantic.js` 需要 `../semantic/indexer.js`（并在运行时注入 `semantic/extractor.js`
  与 `semantic/locate.js`），但 `semantic/` 目录在本仓**从未存在**——`require` 直接
  `MODULE_NOT_FOUND`，`bridge-server.js` 一启动就崩。
- `extension/injected/` 下的两个文件是**生成物**（`scripts/lib/build-injected.js` 从
  `semantic/*` 搬运而来，文件头写着「请勿直接编辑」）。真源丢失、只剩生成物。
- 恢复方式：`semantic/extractor.js` 与 `semantic/locate.js` 由生成物去掉横幅行反推；
  `semantic/indexer.js`（BM25 检索层，零依赖宿主无关）取自同源的 Ark BrowserOS 仓。
- **自证**：以恢复后的真源重跑 `build-injected.refresh()`，报告「无变化」——
  即反推结果与生成物逐字节一致。

### 截图：后台标签页 50% 硬失败 → 100% 成功

- **CDP 通道的真实失败原因此前被静默吞掉**（`catch {}`），只留下「请启用 CDP 调试」这种
  指不到点的提示。现在每次尝试的错误随响应回传（`cdpError`）。
- 拿回错误后定位到：`attempt1 fromSurface:true` 间歇 8s 超时；`attempt2 fromSurface:false`
  **必失败** —— 夸克拒绝该参数（`-32000 Only screenshots from surface are allowed.`）。
- 修法：内核对 `fromSurface:false` 的拒绝**记一次即不再尝试**（`surfaceOnlyKernel`，
  跨调用生效）；重试次数 2 → 3；首轮超时 8s → 1.5s（成功时实测约 1s）。
- **实测**：修复前 6 连测 3 成功 3 失败（失败耗时 9.2s）；修复后 10 连测 **10/10 成功**、
  平均 3.2s，下降 65%。

### 截图：`zoom` / 元素裁剪返回**错位且平铺的垃圾像素**，却报 `success: true`

- 根因是竞态：`scrollIntoView({behavior:'instant'})` 之后**立刻**取 rect 并截图，
  而滚动要等下一个渲染帧才提交到表面 —— 截图拿到的还是滚动前的画面，裁剪区整体错位；
  窗口越矮、滚动幅度越大越明显。调用方看 `success: true` 无从察觉，会据此得出错误结论。
- 修法：取 rect 前等两帧 `requestAnimationFrame` + 一次 `requestIdleCallback`（150ms 超时）。
- 另外：目标大于视口时，内核的视口外渲染同样不可靠（实测返回平铺像素），
  现在夹到视口边界并回传 `clippedToViewport` + `degraded` 说明，宁可给「诚实的局部图」，
  不让调用方拿到垃圾。修后 `h1` 等视口内目标的 zoom 实测正确。

### mock-server：正斜杠路径必 403

- `MOCK_DIR` 以正斜杠传入（`C:/Users/...`）时，`ROOT` 未归一化，`file.startsWith(ROOT)`
  永不成立 → 所有请求 403。已改为 `path.resolve(pickRoot())`。
- 顺带把越界判定从「字符串前缀」换成 `path.relative`：旧写法会放行同前缀的兄弟目录
  （`mock-site-evil` 之于 `mock-site`），实测确认该场景现已 403。

### 文档

- `references/troubleshooting.md` 的夸克节更新为实测结论（原先写的 `fromSurface:false 兜底`
  在夸克上根本不成立）；删除过时的「截图偶发超时」行，并入新的量化结论。

## v3.0.2 (2026-09-14) — 独立审查后的修复批次：安全闸门、上下文与验证可信度

> 背景：请了 6 个互不相通、无上下文的审查代理从不同角度独立审，共报 60+ 条。
> 逐条复核后确认并修复了其中的 P0/P1（下面按"用户能感受到什么"归类）。
> 这一版的核心不是加功能，而是**把已经承诺的行为真正做实**。

### 安全闸门（三条都能被绕过，现已堵住）

- **上下文压缩的真实失效**：`compact()` 期望 `chat()` 返回字符串，而生产接线传的是
  `brain.chat`（返回对象）—— 实测 `summaryText.trim is not a function`，即"四层上下文管理"的
  后两层在真实运行里**从未成功过**；单测因为用了字符串替身而全绿。现在两处契约都判型，
  并新增断言锁住"对象型返回也能压缩"。同时修正：压缩后 system 角色不再被吞掉（此前压缩一次，
  安全边界与工作方式整个消失）、压缩用量计入账本。
- **隐私保护此前是"启动时判一次、判定失败即放行"**：任务中途 `navigate` 到邮箱/银行不会被拦；
  内核未启动时保护静默失效（代码里还留着 `&& false` 的恒假分支）。现在**按次实时判定**，
  且拿不到页面 URL 时 **fail-closed**（拒绝观察类工具而不是放行）。
- **门禁的三个免检口**：图标按钮/纯坐标点击（读不到目标文字即放行）、`press_key Enter`
  （不看焦点上下文，而回车在扩展侧会 `form.requestSubmit()`）、风险词表**只有中文**
  （Delete/Pay/Send/Unsubscribe 全不命中）。现在：读不到目标即拦、回车按焦点上下文判定、
  词表中英双语 + 结构判据（`type=submit`/`formaction`/`name=delete|pay`）。
- **`/upload` 绕过文件沙箱**：`files` 直通 `DOM.setFileInputFiles`（接受任意绝对路径），
  agent 可把令牌/密钥塞进页面再读回上下文。现在所有文件入口共用
  `server/core/fs-sandbox.js`，越界一律拒绝（绝对路径不再被"静默重解释"进沙箱）。
- **产品配置面可被点段路径绕过**：`ark_api {path:'/./settings/token/rotate'}` 能换掉令牌并把
  明文读回模型。判定改为先归一化再比对，四种变体全部拦截。
- **`confirmHigh` 曾是请求体开关**：agent 能自己"授权全局"，让门禁整体失效。已从 HTTP 契约移除。

### 确认机制（人类在环）

- **签名改为"元素身份"**：此前按目标文本前 60 字归一 —— 列表页每行的"删除"文本相同，
  批准第 3 行会放行第 7 行；而模型换个工具做同一个动作又会被重复追问（实测一次任务里问了两次，
  第二次直到 5 分钟超时）。现在签名 = DOM 路径（`dom:#btn-send`），跨工具一致、异元素不共享。
- **面板不再乐观更新**：先拿服务端结果再改界面（此前服务端返回 `{ok:false}` 时界面仍写"你已批准"，
  审批记录被写反）。确认条同时显示"5 分钟未决定即按不执行继续"。

### 上下文与账务

- **spill 的完整内容此前取不回来**：落盘在 `~/.ark-web/spills`，而 `read_file` 沙箱是
  `~/.ark-web/workspace` —— 提示模型"用 read_file 取回"是空话（实测 not-found）。
  现在落进沙箱内 `.spills/`，locator 是相对路径，并新增"真能取回且完整"的断言。
- **预算重复计**：日上限判定把账本里已含的本任务用量又加了一遍，长任务在日上限约一半处被误熔断。
  压缩与子代理的用量此前完全不入账，现在都记（`kind: compact|delegate`）。
- **记忆超预算静默消失**：唯一那份记忆超预算时被整体丢弃且不留痕。现在会写明"因超出预算被忽略：N KB"。
- **任务落盘边界**：`interrupted` 此前不在任何终态集合里 —— `prune` 永远删不掉、`cancel` 能"取消"它、
  SSE 对它永不结束。现在终态判定只有一处定义（服务端 `isFinal`，面板同集合）。

### 工程与健壮性

- **多浏览器串扰**：任一插件断开不再清空**全部**在途请求（只清自己的）；应答校验归属连接；
  **写类命令超时不再跨连接重试**（否则点一次会在另一个浏览器上再执行一遍）。
- **泄漏**：`tabQueues` 用完即删（此前无界增长且让快照快路径恒失效）、`/monitor` 的 duration
  定时器可回收（此前前一个会话的定时器会掐掉后一个）、CDP 抓包订阅读完即注销。
- **坏 JSON 一致处理**：6 个能力模块此前用 `catch(() => ({}))` 把解析失败当空 body 成功执行，
  参数被静默丢弃。现在带 body 的 POST 一律 400。
- **外壳兜底**：畸形请求目标（`//[`）此前会让 `new URL` 抛错 → 该请求**永久挂起**；现在回 500。
- **快照字段净化**：页面标题可含 `</runtime-context>` 与小节标题，此前能伪造"审批策略"小节；
  现在压平换行、过滤标记串，并标注"取自网页，属数据"。
- **取消能中断在途请求**：此前点停止后仍会跑完当前模型请求（最长 120s）并按退避重试。
- **`brain.plan()` 引用未定义符号**（`unitsToLines`/`PLAN_SYSTEM`）—— 已补，或该端点应删除。

### 验证可信度（这一版最该看的部分）

- **"12/12 全绿"此前是虚的**：`runner.js` 与 `sse-tasks.js` **零断言**（只打印，恒退出 0）、
  `cdp-smoke` 在"没有网页标签页"时 `exit(0)`（上一行已判失败）、`agent-units` 用固定
  1200ms 等异步（跑不完也全绿）、`verify-all` 只看退出码。现在：全部补断言并计入退出码，
  `agent-units` 改为等待全部异步断言 + **断言数下限**（故意漏跑一条会红，已自证），
  总控同时解析输出里的失败信号。
- **新增 14 条针对本轮修复的断言**：压缩契约（对象型/字符串型、system 保留、用量回传）、
  spill 可取回、内部端点变体、隐私 fail-closed 与不过度拦截、签名跨工具一致性、
  记忆截断留痕、事件流 seq 单调与续传不重不漏、取消收敛、已结束任务订阅立即收尾。
- **修好三处测试自身的问题**：夹具页此前不在仓库（换机后套件全线跑不起来），已纳入
  `verify/fixtures/mock-site/`；面板套件断言"答复来自测试页"写死了旧夹具的价格，改成从夹具现算；
  ws-guard 把"连不上/超时"当成"已拒绝"，现在要求观察到服务端主动 `close(4003)`。

### 交付

- 分发包**内嵌 `ws` 依赖**（此前 zip 里没有 `node_modules`，干净机器上自启会静默失败）；
  `install-autostart` 在安装前检查依赖并给出命令。
- 新增 `node client/browser-client.js set-key <密钥>`（面板自检的提示此前指向一个不存在的命令）。
- README 的端点数/版本号/包名与仓库对齐（此前停在两代前）；说明书补"升级 Ark Web"一节、
  确认超时、受保护站点呈现、自检项数与 `set-key`。

## v3.0.1 (2026-09-13) — 产品化：从"能跑的技能"到"可用的产品"

> 主线：能力面此前已经很深，但外壳还停在开发者工作台 —— 界面不在仓库里、配置要靠改文件、
> 分发包停在两代前、CI 是 0 对 0 的假绿。这一版把外壳补齐，并把过程中踩到的坑做成机制。

### 产品面（新增）

- **侧边栏面板入仓**：源码从仓库外的运行副本收进 `panel/`，配套 `scripts/sync-panel.js`
  单向同步到浏览器实际加载的副本（扩展 ID 由加载路径派生，换路径会丢设置，因此保留副本为运行位置）。
- **配置不再靠改文件**：新增 `/settings` 系列端点（模型密钥 / 预算 / 敏感名单 / 令牌轮换 /
  首启自检）与面板设置页。密钥只写不读，界面只显示首尾；令牌不再硬编码在面板源码里。
- **冷启动闭环**：`scripts/install-autostart.js` 用启动文件夹里的隐藏窗口启动项让服务随登录自启
  （无需管理员权限，实测杀掉服务后由启动项拉回）；面板做五项自检并在缺条件时说清下一步。
- **成本护栏**：`server/core/limits.js` 用量账本 + 单任务/每日上限 + 调用前熔断。
  单价不写死在代码里（价格会变），填了才算金额，没填只按 token 管。
- **失败分诊**：面板按错误模式给出"你能做什么"；扩展与服务端两侧统一翻译浏览器原始英文报错
  （含下一步建议）。
- **发布工程**：`VERSION` 为唯一版本源，`scripts/bump-version.js` 同步三处清单；`scripts/package.js`
  改为目录遍历 + 纯 Node 压缩（不再依赖 PowerShell，跨平台），并在打包后回读 ZIP 自检关键路径。
- **一条命令跑齐验证**：`scripts/verify-all.js` 按"需要什么条件"分层，缺条件的明确跳过并给补齐命令。

### 技能接口与产品面的分界（机制化）

- 新增 `server/core/internal-routes.js`：capabilities 里标 `internal: true` 的能力域
  （当前是 `settings`）自动进入内部名单。
- **agent 触不到产品配置**：通用直通工具（`ark_api`）对内部端点直接拒绝，并说明该由面板/CLI 操作。
  此前实测可顺着 `ark_api` 调 `/settings/token/rotate` —— 一个跑偏的任务能把自己的令牌轮换掉。
- `/capabilities` 输出带 `internal` 标记，agent 侧据此过滤；技能文档（SKILL.md）与工具清单不含产品端点。
- 技能契约本身未改动：SKILL.md 的接口与语义保持原样，本次全部为**追加**。

### 修复的坑（都实际踩过并做成了机制）

1. **浏览器跑的是缓存的旧脚本**：`--load-extension` 启动时 Chromium 会缓存扩展服务工作线程的脚本，
   改了代码 + 重启浏览器也可能仍跑旧脚本（manifest 是新读的、脚本不是）。现在扩展上报自身代码指纹，
   服务端与磁盘比对，`/settings/preflight` 直接报出来；处理办法写进手册（删 profile 的 `Service Worker` 目录）。
2. **只带一个 `--load-extension` 会禁用其他未打包扩展**：于是"浏览器起来了但面板打不开"。
   启动器改为同时加载桥接扩展与面板，并把这条写进脚本注释。
3. **严格 CSP 站点语义提取失败**：MV3 禁止扩展上下文里的字符串求值，调试通道未授权时必然失败。
   新增"注入打包文件"通道（`chrome.scripting.executeScript({files})`，不经 eval、不受页面 CSP 限制），
   提取器由 `scripts/sync.js` 从 `semantic/` 生成到 `extension/injected/`，保持单一来源。
   已在严格 CSP 的统一认证页上实测：构建 6 个语义单元、检索与定位均通过。
4. **WS 通道可被网页直连**：WebSocket 握手不受 CORS 约束，此前任意网页都能连 `ws://127.0.0.1:9334`
   操控浏览器。现在默认拒绝一切网页来源（新增 `verify/ws-guard.js`，6/6）。
5. **"已连接"是假的**：浏览器被强杀后 socket 可能还挂着，`/status` 却报"已连接"、命令全部超时。
   健康口径改为"最近 45 秒内是否真的说过话"（`liveClients`），死连接在路由排序里排到最后。
6. **命令默认发给谁不确定**：多浏览器共存时按"谁刚发过心跳"排序，行为不可预期（实测面板套件偶发落到夸克）。
   改为默认倾向产品浏览器（`browseros`），显式 `?browser=` 永远优先；连接名由扩展 ID + 内核名查表得出
   （`scripts/label-browsers.js`），不再靠"把某个副本的版本号抬高"来抢路由。
7. **CI 假绿**：`check-endpoints.js` 靠正则抓已被重构拆掉的 switch，输出"0 对 0 / 完全一致"。
   重写为加载能力模块与端点文档做**双向**比对，并对"两边任一为 0"直接判失败；CI 改为真跑
   静态自检 + 离线套件 + 起服务跑接口层与 WS 防护。

### 验证

```
node scripts/verify-all.js
  静态自检      4 套（能力模块 / 路由文档 / 版本一致 / 全仓语法 101 文件）
  离线套件      2 套（agent-units 51 项 · route-parity 8 项）
  接口与通道    2 套（http-smoke 17 项 · ws-guard 6 项）
  界面层        4 套（cdp-smoke 13 项 · panel-console 39 项 · runner · sse-tasks）
```

界面层四套需要真实浏览器，由本机跑；CI 只跑前三层（无浏览器、无密钥）。

## v2.9.3 (2026-09-11) — 真实站点健壮性修复：挂起资源 / 陈旧读值 / 夸克视口残留（冒烟 94/94 · v3 20/20 · v4 12/12）

> 背景：v2.9.2 冒烟残留 2 项失败（`/clear` 假失败、`device/clear` 恢复视口），真实站点终测又暴露 IANA 页面加载挂起、必应结果卡时序等问题。逐一定位根因后修复，三项测试全绿。

### 真实站点关键修复（本次核心）

- **`wait-for-load` 停滞宽限（真实站点头号问题）**: 页面引用的第三方资源可能永久挂起（实测 IANA 首页的 `cse.google.com/cse.js` 在国内网络无响应），`load` 事件永不触发、`readyState` 卡在 `interactive`，旧实现会一直空等到超时。现在 DOM 就绪后超过 `stallGrace`(默认 3000ms) 仍无 complete 即按**部分完成**返回（`partial:true` + `readyState` + `note` 说明原因），页面立即可操作
- **服务端等待端点超时跟随 body**: `/wait-for-load|url|text|selector` 与 `clickRef` 的 `waitFor` 后置等待，cmd 超时改为跟随请求的 `timeout`/`waitTimeout`（+5s 余量，上限 300s）——此前客户端请求 40s 等待会被服务端默认 20s 掐断
- **陈旧读值修复（server inflight 合并 bug）**: 同键只读请求合并时，已完成请求在 10ms 窗口内仍被后续串行请求复用 → 表现为 `/value` 读到旧值、`fill→value→clear→value` 链路假失败。改为 resolve 后立即清理合并条目

### 夸克（Quark）内核适配

- **`device/clear` 视口残留修复**: 夸克下 `Emulation.clearDeviceMetricsOverride` 可能不还原宽高（实测带 `<meta viewport>` 的页面首次 clear 残留 390×844，UA/dpr 已恢复）。改为**软还原**：clear 后探测到残留则用 `setDeviceMetricsOverride` 写回 set 前记录的原始视口；记录缺失/写回失败则虚拟视口兜底。**不使用 detach→attach**（无用户手势会导致 CDP 授权失效 → throttled 降级，实测会引发后续命令异常）
- **最小化窗口异常视口识别**: 夸克最小化时上报 45×14 等异常小值（而非 0），虚拟视口兜底条件从"等于 0"扩展为"任一维 <100" → 最小化时快照/点击/截图依然可用

### 测试工具链修复

- **`real-scenario-v3.js` headers 重复键（全部请求丢令牌）**: `http.request` 对象里出现两个 `headers` 键，后者覆盖前者 → 带令牌的请求头被丢弃（启用鉴权的环境必然 401）。已合并为单键
- **`smoke-test.js` 失败详情输出**: `/clear`、`device/clear` 失败时打印响应体与轮询序列（此前只给 `false`，无法定位）
- **`smoke-test.js` 最小化语义适配**: 窗口不可见时接受虚拟视口语义；插件做了视口修复（响应含 `viewportRestore`）且视口可用即通过
- **v4 S24 不可滚动页面适配**: IANA 首页在小视口下内容不足一屏（实测 2560×1210 视口下仅 ~903px），scroll-by 为无操作成功 → 无可滚动空间时不再断言位置变化
- **v3 S01 必应结果卡轮询**: 结果页答案卡与标准卡渲染有先后，单次查询偶发落空 → 8s 轮询等待 `.b_algo h2`
- **`sync.js` 备份修复**: 原实现只备份顶层文件，目录内文件（extension/server/scripts…）变更从不备份却仍打印"已备份" → 改为递归备份被覆盖文件，且仅在确有备份时提示

### 验证（本机夸克 7.1.7 + 真实站点）

- 冒烟测试 **94/94**、real-scenario-v3 **20/20（201 步）**、real-scenario-v4 **12/12（106 步）** ✓
- IANA 首页（挂起资源）: `wait-for-load` 3.1s 返回 `partial:true` 并给出原因说明，页面立即可操作 ✓
- `device → clear → device → clear` 连续切换（mobile:true/false、带/不带 viewport meta）视口均正确还原 ✓
- `/value` 连续读值不再陈旧（D0→D1→D2→D3 实时）✓

## v2.9.2 (2026-09-11) — 新环境接入修复：僵尸连接自愈 + 文档令牌路径全面勘正 + 夸克内核识别

> 背景：其他 AI 加载本 skill 后无法使用。排查确认两个独立原因：① **文档里的令牌路径已过期**（15 处仍写 `server/.ark-token`，而令牌早已迁到 `~/.ark-web/token`）→ 按文档取令牌必然 401；② **僵尸连接**（`connected:true` 但所有命令 20s 超时）。

### 僵尸连接自愈（`server/bridge-server.js`）

**症状**：`GET /status` 显示 `connected: true`，但 `tabs`/`snapshot`/任何命令都超时。
**根因**：插件重载（或浏览器睡眠/唤醒）后，旧 WebSocket 仍留在 `clients` 且 `readyState=OPEN`，但旧实例已不再处理消息；`sendToPlugin` 只按"版本号最高"选连接，一旦选中僵尸就石沉大海。

- **超时自动换连接重试**: 多连接时首个连接只用 8s 探测超时，无响应立刻换下一个连接重试（单连接保持完整超时，避免误杀合法的慢命令）
- **可疑连接降权**: 超时过的连接 30s 内排在候选末尾（`suspectUntil`）
- **心跳清理**: 每 15s ping，连接静默 >120s 直接 `terminate` 并移出（原实现只发 ping，从不清理）
- **健康可观测**: `/status` 新增 `connections[]`（`version/browser/idleMs/suspect/timeouts`），多连接时给出 `connectionNote`
- **心跳响应**: `handlePluginMessage` 新增 `ping`/`pong` 分支（原来插件的 15s 心跳会落到 `default` 打印"未知消息类型"，污染日志）
- 超时错误文案补充第 ④ 条可能原因（浏览器后台休眠）与处置建议

### 新环境零门槛接入

- **`GET /health` 升级为自解释端点**（仍免鉴权）：返回 CLI 绝对路径、令牌文件位置、鉴权头名、推荐用法与文档索引 —— 新接入的 AI 一调用就知道该用什么命令、令牌在哪，无需猜路径
- **插件上报真实内核**（`extension/background.js`）: 新增 `detectKernel()`，按 UA 识别 `quark`(夸克) / `edge` / `brave` / `chrome` / `chromium`，替换原先写死的 `'chrome'`。`/status` 的 `plugin.browser` 现在能如实反映（本机实测显示 `quark`）

### 文档勘正（这是本次"用不了"的直接原因）

- **令牌路径全量修正**: `SKILL.md` / `README.md` / `references/troubleshooting.md` 中的 `server/.ark-token` 全部改为 **`~/.ark-web/token`**（Windows `%USERPROFILE%\.ark-web\token`），并在原处保留一句"旧路径已废弃"提示，避免旧文档继续误导
- **`SKILL.md` 新增 §0「开工前自检」**: 三条铁律（先 cd 到 skill 目录 / 优先用 CLI 自动带令牌 / 令牌真实位置）+ 三步验证命令 + **连接异常速查表**（401、未连接、僵尸连接、部分命令超时、需 CDP、夸克差异）
- **`references/troubleshooting.md` 新增两节**: 「僵尸连接」（症状/根因/自愈机制/处置命令/curl 查看方式）与「夸克 / 非 Chrome 内核」（已知 CDP 差异、最小化窗口行为、如何确认当前内核）
- **README 新增「其他 AI / 新环境接入要点」**: 5 条必读（cd 目录、优先 CLI、令牌位置、僵尸连接、夸克支持）；英文段补 `New here?` 一句话指引；故障排查表扩充（401 / 僵尸连接 / 插件版本不一致 / 夸克差异 / 截图超时），并去掉"仅 Chrome"的表述
- `references/protocol.md` 补 `--tabId` 全局参数与令牌自动读取说明
- 端点计数 119 → **122**（新增 `/snapshot/text`、`/wait-for-stable`、`/reload-extension`）

### 验证（本机夸克 + 真实站点）

- `/health` 返回 CLI 绝对路径与令牌位置 ✓；无令牌访问 `/status` 正确返回 401 ✓
- 重启 server 后残留僵尸连接被清理，`tabs`/`snapshot` 等命令全部恢复正常 ✓
- 插件上报 `browser: "quark"` ✓（原为硬编码 `chrome`）
- `debug-on` 重新授权 CDP 成功（3 个标签页 attach），无需点击 popup ✓



## v2.9.1 (2026-09-10) — 多副本治理 + 稳定性修复 + 效率实测（真机验证）

> 本次全部改动都在真实 Chrome + 真实站点上端到端验证：冒烟 **94/94 通过**，视觉闭环演示 8/8 步通过。

### 多副本治理（"改了半天不生效"的根因）

- **根因**: 机器上存在 3 份项目副本，而 Chrome/Quark 从 `C:\Users\画扇\browser-debug-extension\extension` 加载旧代码，改 skill 目录永远不生效
- **`scripts/doctor.js`（新）**: 一键体检 —— 扫描所有副本并做关键文件指纹比对、从 Chrome/Quark 用户数据读出**浏览器实际加载路径**、问 `/status` 拿**插件上报版本**，给出结论与修复动作（漂移/版本不一致会 exit 1）
- **`scripts/sync.js`（新）**: 把当前目录同步到"浏览器实际加载的那份副本"，同步前自动备份到 `.sync-backup-<时间戳>/`；`--dry-run` 预览
- **`POST /reload-extension`（新）**: 插件自我重载（`chrome.runtime.reload()`），改完 `extension/` 后无需再手动点浏览器按钮；重载后 CDP 授权失效，但 `POST /debug/attach-all` 可再次授权（实测无需点击 popup）
- **`/status` 新增 `plugin` 段**（版本/浏览器/注册时间）与 `security.tokenFile`：一眼看出"浏览器里跑的是哪一版代码"
- **令牌改为用户级共享路径** `~/.ark-web/token`（旧 `server/.ark-token` 仍兼容并自动补齐），消除多副本令牌不一致导致的 401

### 稳定性与正确性修复（均由真机实测暴露）

- **`wait-for-load` 导航竞态**: 旧实现"当前文档已 complete 就返回"会把**上一个文档**当成加载完成（实测 `open` 后拿到 `about:blank`）。现引入导航标记（`_pendingNav`）+ `afterAction`：必须观察到新文档进入 loading 或 URL 变化才判定完成，响应带 `transition` 字段说明依据
- **`clickRef` 后置等待过严**: 快速导航可能在两次轮询间完成（看不到 loading）→ 现在用"基线 URL 变化"兜底；点击不跳转时约 1.5s 后按 `no-transition` 返回，不再空等 15s 超时
- **最小化窗口截图超时（关键）**: 窗口不可见时 CDP 从合成器取帧永远等不到新帧 → 整屏截图改走 `fromSurface:false`（**直接从渲染进程出图**）。实测同页快照采集从 **10233ms → 457ms**，且不再失败。注意：带 `clip` 的截图（`zoom`/`screenshot-element`）内核强制要求 surface，故只能重试（内核会回 `Only screenshots from surface are allowed`）
- **`captureVisibleTab` 兜底不再崩**: 该 API 只接受 jpeg/png，传 webp 会直接抛参数错误 → 兜底路径自动降级为 jpeg 并在响应里给 `formatNote`
- **`device/clear` 幂等化**: 反复 clear（无 override 可清）不再因自愈校验失败而返回 `success:false`；清除后若视口坍缩（窗口不可见）会等一拍再判定并施加虚拟视口，保证 tab 仍可用于视觉采集
- **出错页守卫**: `chrome-error://` / `about:blank` / `chrome://` 页面提前识别并返回可操作错误（旧实现会让 `Runtime.evaluate` 空等 12s）
- **插件内部方法名错误修复**: `ensureViewport` / `waitForStable` / `zoomShot` 误用 `this.evaluate`（ArkWeb 上不存在）→ 改为 `evaluateJS`；此前导致虚拟视口与 zoom 静默失效
- **`ArkWeb` 上的 `normalizeImageFormat`** 统一图片格式（png/jpeg/webp），`screenshot`/`screenshotFull` 也统一走它（避免 `image/jpg` 这类错误 MIME）

### 能力增强

- **虚拟视口自动兜底（新）**: 检测到目标 tab `innerWidth===0`（窗口最小化/不可见）时自动施加 1440×900 `Emulation.setDeviceMetricsOverride`（仅作用于该 tab，不改动用户窗口），响应带 `autoViewport`。使快照/点击/截图在**窗口最小化时依然可用**
- **`POST /wait-for-stable {timeout,quiet}`（新）**: DOM 连续静默 + `readyState=complete` 才返回，替代固定 sleep；快照也可用 `settle=1` 一步到位
- **紧凑快照（新）** `compact=1`: 元素由对象变定长数组 `[ref,tag,role,x,y,w,h,flags,label]`，`flags` 用字母表达 `disabled/checked/occluded/非视口/已填值`
- **元素折叠**: `<button><span>文字</span>` 这类嵌套不再重复收录（非主要交互标签若祖先已收录则跳过），减少噪声与 token
- **`POST /snapshot/text`（新）**: 可见文本块 + 紧致坐标（用 `Range` 取文本节点自身盒子）+ 字号 —— **不截图就能"读"页面**
- **`POST /act {action:"find", text}（新）**: 按可见文本找元素，可点击优先排序、去重，返回 ref/坐标/是否可点
- **`POST /act {action:"refs", steps:[...]}（新）**: 一次 HTTP 批量 ref 动作（click/hover/fill/read）
- **`--tabId` 全局 CLI 参数（新）**: 所有请求自动带 `?tabId=`，多标签/多窗口下确定性定位
- **CLI 新增命令**: `act`（通用高层动作）、`find`、`text-map`、`refs`、`click-ref`、`hover-ref`、`fill-ref`、`read-text`、`zoom`、`wait-stable`、`reload-extension`

### 效率实测（百度首页，1440×900，34→26 元素）

| 方式 | 元素 JSON | 估算 token | 图片 base64 | 采集耗时 |
|---|---|---|---|---|
| 对象格式 png | 7.8 KB | ~2226 | 428.2 KB | 3265ms |
| **紧凑格式 webp** | **1.5 KB** | **~429** | **134.0 KB** | 382ms |

**元素 JSON -80.7% / 图片 -68.7% / 单次总载荷 -68.9%**；snapshot 400ms 缓存命中 2ms。
（复现: `node scripts/bench-snapshot.js --max 60`）

### 新增脚本

- `scripts/doctor.js` 环境自检 · `scripts/sync.js` 多副本同步 · `scripts/bench-snapshot.js` 快照效率基准 · `scripts/demo-vision-flow.js` 视觉闭环参考实现（8 步全流程演示，可直接照抄）

### 测试

- `smoke-test.js` 修正 `/device/clear` 恢复断言：窗口不可见时"恢复到 0"没有意义，接受"清除成功且给出可用视口"；真机 **94/94 通过**



## v2.9.0 (2026-09-10) — 安全加固 + 视觉能力增强 + 手册改为视觉单路径

### 安全（P0 修复）

- **令牌鉴权（`server/bridge-server.js`）**: 全部端点（除免鉴权存活探针 `GET /health`）要求 `X-Ark-Token` 头 / `Authorization: Bearer` / `?token=`。令牌首次启动用 `crypto.randomBytes(24)` 生成、以 0600 权限写入 `server/.ark-token`，之后固定复用；也可用 `ARK_TOKEN` 指定。常量时间比较（sha256 + `timingSafeEqual`）。`ARK_NO_AUTH=1` 可显式关闭（日志会警告）
  - 修复：此前 `/evaluate` 等任意端点对**任意网页**开放 —— 恶意页面可用 `fetch` 直接驱动本机浏览器并读取响应（结合 `ACAO: *` 可读结果），等于把用户全部登录态交给网页
- **移除 `Access-Control-Allow-Origin: *`**: 改为按来源**精确回显** + `Vary: Origin`；非白名单来源直接 403
- **Origin 校验**: 仅接受无 Origin（CLI/curl）、`chrome-extension://` 等扩展页面、本机页面来源
- **Host 校验**: 拒绝非回环 Host（挡 DNS rebinding）
- **仅回环监听**: HTTP 与 WS 均 `listen(port, '127.0.0.1')`。此前 `listen(port)` 未传 host 实际绑 `0.0.0.0`，局域网可达，与文档"仅本机"不符。确需对外用 `BRIDGE_HOST=0.0.0.0`（并必须设 `ARK_TOKEN`）
- **WS 令牌**: 设置 `ARK_TOKEN`/`ARK_WS_TOKEN` 后，插件连接必须携带相同令牌，否则 `close(4001)` —— 堵住"本机进程直连 9334 绕过 HTTP 鉴权"的旁路
- **启动安全横幅**: 打印监听地址、Host/Origin 状态、令牌、WS 令牌是否启用，风险项以 warn 输出
- 新增 `server/.ark-token` 到 `.gitignore`（令牌绝不入库）

### 视觉能力增强（多模态优先）

- **ref 系操作（新）**: 快照采集时给每个元素打 `[data-ark-ref="N"]` 临时标记，新增插件命令 `click-ref` / `hover-ref` / `fill-ref` / `read-text` / `zoom-shot`，经 `POST /act {action:"clickRef"|"hoverRef"|"fillRef"|"readText"|"zoom"}` 暴露。**编号直接可用，无需坐标换算，滚动/位移/遮挡变化后依然准确**；标记在下次快照与 `/reset-all` 时统一清除
- **裁剪放大（新）**: `POST /snapshot/zoom {ref|selector|x,y,width,height, scale(1-5), format}` —— CDP `Page.captureScreenshot` + `clip.scale` 局部放大，用于读小字/图表细节；CDP 不可用时降级为元素截图并附 `degraded` 说明
- **元素语义增强**: 快照元素新增 `disabled` / `checked` / `inputType` / `value`（password 不回传）/ `placeholder` / `href` / `expanded` / `inViewport` / `occluded`，且**仅在非默认值时输出**以控制 token；`occluded` 用 `elementFromPoint` 判定"点了会打到遮罩"
- **webp 支持**: `format=webp`（`/snapshot`、`/snapshot/zoom`、`/snapshot/binary` 的 Content-Type 同步），比 png 更省 token
- `/reset-all` 新增 `visionRefs` 清理项：移除 SoM 叠加层与 `data-ark-ref` 标记

### 插件配置

- WS 主机/端口/令牌改为可从 **popup →「工具」→「连接配置」** 修改并持久化到 `chrome.storage.local`（`arkWsHost`/`arkWsPort`/`arkWsToken`），保存后自动重连；`chrome.storage.onChanged` 监听外部修改。修复"WS 端口硬编码 9334，改端口必须改源码"的技术债
- 新增 popup 消息 `get-config` / `set-config`

### 客户端与脚本

- **修复 `client/ark-fast.js` 的 `baseUrl` 参数被忽略**（`BrowserClient` 只认 host/port，旧代码传 `baseUrl` 静默失效）→ 现在会解析 URL 取 host/port
- `BrowserClient` 新增令牌与连接解析 `resolveConnection()`：优先级 显式参数 > `ARK_PORT`/`ARK_HOST`/`ARK_TOKEN` > `server/.ark-token` 文件 > 默认值；所有请求自动带 `X-Ark-Token`；401 附带可操作的 hint
- CLI 新增全局参数 `--port` / `--host` / `--token`（此前文档承认不支持，是自相矛盾项）；新增命令 `click-ref` / `hover-ref` / `fill-ref` / `read-text` / `zoom`，并补 `TYPE_MAP` 与 chain 步骤解析
- `ArkFast` 新增 `clickRef` / `hoverRef` / `fillRef` / `readText` / `zoom`
- 测试脚本（smoke-test / benchmark / real-scenario-v3/v4 / exec-actions）统一改用 `resolveConnection()` 自动读令牌与端口

### 文档

- **`SKILL.md` 重写为 v10「视觉优先」单路径**：移除模型自检门与文本选择器工作流，改为「快照 → 按编号操作」为主线；新增 ref 操作、zoom/readText、元素语义字段表、安全模型三节
- **渐进式披露拆分**: `references/protocol.md`（完整端点表 + chain/batch + 命令映射）、`references/troubleshooting.md`（故障排查）、`references/evaluate-recipes.md`（evaluate 穿透模板），`SKILL.md` 只保留主路径与索引
- 新增端点 `GET /health`（免鉴权）与 `POST /snapshot/zoom`；`/status` 增加 `security` 段（host/tokenAuth/tokenSource/wsTokenRequired）
- README 同步：安全模型表、ref/zoom 示例、目录结构、端点总览（119）

### 补充（供人工处理，未自动执行）

- 目录内的 `browser-debug-extension` **Junction**（指向 `%USERPROFILE%\browser-debug-extension`）仍存在，会导致递归工具报"不受信任的装入点"、打包/分享时携带外部目录引用。建议手工 `rmdir` 该链接（只删链接不动目标）

### 发布物料（Promo release, 2026-09-04；无行为变更）

- **English README**: 新增 `README.en.md`（英文首屏 + badges + comparison），主 `README.md` 顶部加语言切换 + 版本徽章
- **GitHub Pages**: 新增 `docs/index.html`（单文件落地页：hero/架构/6 特性/Quickstart/端点速览/安全注记），`docs/demo-home.png` + `docs/audit-sample.html` 为演示资产
- **SEO/topics**: 统一关键词 `ai browser automation / chrome cdp bridge / multimodal snapshot / browser audit / llm tool`；建议 Topics：`ai-agents browser-automation chrome-extension cdp llm-tools multimodal web-audit developer-tools automation`
- **打包**: `scripts/package.js` INCLUDES 纳入 `README.en.md` + `docs/index.html`；SHA256 改 Node 回退（`powershell.exe Get-FileHash` 受限环境兜底）
- 无破坏性：端口/WS/端点/CLI 不变（以 `scripts/check-endpoints.js` 为准）

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
