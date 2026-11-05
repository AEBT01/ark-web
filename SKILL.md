---
name: ark-web-browser
description: Ark Web 浏览器子系统的完整手册（v5）。MV3 扩展 + 本地桥接 + 面向 AI 的 CLI。真实输入（CDP Input）、跨 iframe/shadow DOM 的元素采集、带指纹的 ref 注册表、语义快照与 diff、视觉编号截图、请求拦截与 HAR、Web Vitals、断言与录制回放。改代码自动热重载。
---

# Ark Web 浏览器子系统 v5.1

> 这一版按「专业级 AI 浏览器操控与分析工具」重写：**先验证、再动作、后确认**，
> 任何一步拿不到证据就报错，绝不回一个假的 `ok:true`。

## 一、它解决的是什么问题

给 AI 用的浏览器工具，难点不在「能不能点」，而在四件事：

| 难点 | 旧实现的失败方式 | v5 的做法 |
|---|---|---|
| **状态一致性** | ref 存在 DOM 属性上，重渲染后静默点到别的元素 | ref 只存在扩展侧注册表 + 指纹（tag+文本），对不上报 `E_STALE_REF` |
| **输入真实性** | 合成事件，CSS `:hover` 不触发、`isTrusted=false` | 全部走 CDP `Input.*`，含「移动→重测→按下」防重排 |
| **页面模型** | 扁平元素列表，iframe/shadow 全盲 | 跨 frame 注入代理，区域 + 上下文 + diff |
| **可自证** | 动作完只回 `ok:true` | 回读校验（fill）、效果确认（click）、断言（assert） |

## 二、组成

| 路径 | 作用 |
|---|---|
| `manifest.json` | MV3 清单（tabs / debugger / scripting / alarms / storage） |
| `background.js` | service worker 入口：连接、消息分发、自更新 |
| `src/page-agent.js` | 注入每个 frame 的页面代理（采集/定位/动作/断言/抽取），**同步 API** |
| `src/frames.js` | 跨 frame 编排、ref 分配、注入守卫 |
| `src/refs.js` | ref 注册表与指纹，落 `chrome.storage.session` |
| `src/input.js` | CDP 真实输入：鼠标/键盘/文本/拖拽 |
| `src/capture.js` | 截图（文档坐标 clip、焦点仿真、后台标签兜底） |
| `src/observers.js` | 控制台/网络/WebSocket/弹窗/请求拦截 |
| `src/cdp.js` | 调试器会话与焦点仿真 |
| `src/commands.js` | 命令语义与错误码 |
| `server/bridge-server.js` | HTTP+WS 桥接，:9333，令牌 + 扩展白名单 |
| `client/browser-client.js` | CLI（42 个命令） |

## 三、启动

```powershell
cd "$env:USERPROFILE\browser-debug-extension"

node scripts\label-browsers.js --yes   # 首次：登记扩展 ID（启用白名单）
node server\bridge-server.js           # 桥接（计划任务 ArkWeb Bridge 开机自启）
node client\browser-client.js status   # connected: true 即通
node client\browser-client.js tabs
```

**加载扩展**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录。

> ### ⚠️ 重启桥接用 `server\restart.ps1`
> 不要用 `Start-ScheduledTask 'ArkWeb Bridge'`——计划任务的动作直接跑 node.exe，
> 且 `LogonType=Interactive`，每次启动都会在你当前会话弹一个黑窗（打游戏时会被打断）。
> `restart.ps1` 会停任务 → 清残留 → `-WindowStyle Hidden` 拉起 → 自检 `/health`。

## 四、命令表（42）

### 标签页

| 命令 | 说明 |
|---|---|
| `status` | 桥接/扩展连接状态、扩展 ID、白名单条数 |
| `tabs` / `info` / `activate` / `close` | 标签页管理 |
| `open <url> [--tab-bg] [--capture false]` | 打开；默认先挂 CDP 再导航，首个请求也能抓 |
| `session --mode open\|list\|close` | agent 自己的标签集合，可一键清理 |

多浏览器同时连接时，`status` 返回每个扩展的 `browser` / `id` / `conn`；`tabs` 默认聚合全部浏览器并标注 `browser`/`extId`/`conn`。任意命令可用 `--ext <extId|chrome|edge>`、`--browser <名字>` 或 `--conn <连接键>` 指定目标；`fanout "<命令>"` 在所有浏览器并行执行。同一份扩展在 Chrome/Edge 的 extId 相同，精确区分用 `--browser` 或 `--conn`。

**没有默认标签这回事**：不传 `--tab` 且没有「最近操作过的标签」时，直接报 `E_NO_TAB`。
旧版会回退到 `activeTab()`，等于在你正在写的页面上执行命令——这条已被删除。

### 观察

| 命令 | 说明 |
|---|---|
| `snapshot [file] [--shot]` | 语义快照：跨 iframe/shadow 采集，带 `context`（所属区块）、`inView`、`disabled`。**默认只回结构不截图**（快一个数量级），要视觉快照加 `--shot` |
| `snapshot --diff` | 与上次快照对比，只回 `added/removed/changed` |
| `snapshot --in-view` | 只要当前视口内元素（长页面省 token） |
| `snapshot --no-boxes` | 截图不带编号框（默认带：ref 直接烧进图里） |
| `find --text "提交" [--role button]` | 语义定位，回 `clickable`/`coveredBy`/`score`/`why` |
| `attr --ref N` | 元素全量属性、语义上下文、包围盒、遮挡情况 |
| `text [--max-len N]` | 正文 → Markdown；聚合所有 frame（带 frame 分隔），覆盖 open shadow root |
| `state` | 内嵌结构化数据：JSON-LD / `__NEXT_DATA__` / `__INITIAL_STATE__` / og:meta；主世界注入并跨 frame 聚合 |
| `assert --selector "#x" --text "…"` | 断言 `text\|value\|attr\|count\|visible`，失败抛 `E_ASSERT` |
| `eval "<js>"` | CDP `Runtime.evaluate`，等待 Promise |

### 动作

| 命令 | 说明 |
|---|---|
| `click --ref N \| --selector "…"` | 遮挡/禁用/可见预检 → 真实点击 → 效果确认 → 新标签追踪 |
| `click --force` | 跳过 ref 指纹与遮挡拦截（明确知道自己在做什么时才用） |
| `fill --ref N --text "…"` | `Input.insertText`；`--type` 逐字符（联想/字数统计/富文本） |
| `fill --submit` | 填完发真实 Enter（触发表单默认提交） |
| `hover --ref N` | 真实 `mouseMoved`，回 `hoverActive` 证明浏览器认了这次悬停 |
| `press --key "Ctrl+Enter"` | 真实按键，Tab/Escape/Enter 具备默认行为 |
| `select --ref N --values "a,b"` | 原生 select 直选；自定义下拉自动「点开→按文本点选项」 |
| `scroll --dy 600` / `shot <file> [--selector]` / `upload --file` | 滚动 / 截图 / 文件上传 |
| `shot --diff` | 与上一次同目标截图比较，回 `changedPct` 与变化区域（视觉回归） |
| `dialog --policy accept` | JS 弹窗策略（默认 `manual` 只记录，会阻塞页面） |
| `emulate --device iphone --network slow3g --cpu 4 --media dark` | 环境模拟：设备/网络/CPU 降速/暗色与减弱动效/时区/语言/地理；`--reset` 还原 |

### 采集

| 命令 | 说明 |
|---|---|
| `extract --selector "…" --fields "…"` | 单页抽取，跨 shadow DOM |
| `extract … --paginate --next "a.next"` | 翻页采集：跨页去重、`stopReason` 说明为什么停 |
| `extract … --scroll 6 --step 700` | 无限滚动 / 虚拟列表采集 |
| `table [--selector] [--out f.csv]` | HTML 表格 → 对象数组；展开 rowspan/colspan，多行表头合并 |
| `net [--errors] [--filter kw]` | 请求清单（含 postData），只含挂载后发出的 |
| `net-body <requestId>` | 响应正文 |
| `net-intercept [--on false]` | 请求拦截开关（`Fetch.enable`） |
| `net-rule --add '{...}'` | `mock` / `abort` / `delay` / `header` 规则 |
| `net-har --out h.har` | 导出 HAR 1.2，默认含响应正文（`--no-bodies` 可跳过，`--max-body` 限长） |
| `perf` | 节点/布局/JS 堆 + TTFB/FCP/LCP + **CLS/INP/LongTask/LCP 元素归属** + 资源分布 |
| `console [--level error]` | 控制台日志与未捕获异常 |
| `coverage --mode start\|stop` | JS/CSS 覆盖率：哪些代码根本没跑（导航前 start 才能覆盖整页） |

### 组合

| 命令 | 说明 |
|---|---|
| `wait --selector\|--text\|--url` | 等元素/文字/URL |
| `wait-idle` | 等在途请求归零（SPA 比 wait-load 可靠） |
| `chain "cmd1" "cmd2" --tab N` | 串联；顶层 `--tab` 会透传给每一步 |
| `replay flow.jsonl --tab N` | 回放录制的流程（`ARK_WEB_RECORD=flow.jsonl` 录制） |
| `fanout "<命令>" [--ext chrome,edge]` | 在每个浏览器并行执行同一条命令，返回分浏览器结果 |
| `cdp <method> --params '{...}'` | CDP 直通（页面级域） |

## 五、输出契约

```
成功  {"ok":true,  "cmd":"extract", "schemaVersion":2, "data":{...}, "elapsedMs":84}
失败  {"ok":false, "cmd":"extract", "schemaVersion":2,
       "error":{"code":"E_STALE_REF","message":"…","hint":"…","retryable":true}, "elapsedMs":61}
```

- `--json` 或 `ARK_WEB_JSON=1` 打开机器模式（AI 应当始终打开）
- `elapsedMs` 是桥接测得的真实往返耗时；`retryable` 表示「换个前置动作重试可能成功」
- 列表结果一律带 `count` / `returned` / `truncated`
- `hint` 是**可直接照做的修复动作**，不是解释
- **`data` 整包透传**：内层不得为了「输出好看」裁剪字段（曾经因为多层各自挑字段，
  截图的 `uniform` 标记被吃掉）。白名单只允许在最外层做一次

### 错误码

| 码 | 含义 | 典型处置 |
|---|---|---|
| `E_PARAM` | 参数错误（本地就拦下，不浪费往返） | 按 hint 改参数 |
| `E_NO_TAB` | 没有目标标签 | `open` 或加 `--tab` |
| `E_UNKNOWN_REF` | ref 不存在（导航后最常见） | 重跑 `snapshot` |
| `E_STALE_REF` | ref 指向的元素语义已变 | 重跑 `snapshot`；确认无误用 `--force` |
| `E_NOT_FOUND` / `E_NOT_VISIBLE` / `E_DISABLED` / `E_COVERED` / `E_OFFSCREEN` | 元素不可用 | 关浮层 / 展开父级 / 滚动到可见 |
| `E_FILL_FAILED` | 填写后回读校验不通过 | 加 `--type` 逐字符 |
| `E_SELECT_FAILED` | 自定义下拉没找到选项 | 先 `snapshot` 看展开后的列表 |
| `E_ASSERT` | 断言失败 | 前置动作没生效，或断言条件写错 |
| `E_TAB_HIDDEN` | 后台标签没有新帧 | `activate` 或加 `--focus` |
| `E_EXT_DOWN` | 扩展连接断开 | 重试；桥接会自动重连 |
| `E_BRIDGE_DOWN` | 桥接没起 | 启动 `bridge-server.js` |

## 六、几处关键设计

### 1. ref 不是 DOM 属性，是注册表 + 指纹

旧版把 `data-ark-ref` 写进页面，污染样式与框架 diff，且重渲染后会静默点到别的元素。
v5 里 ref 只活在扩展侧（`chrome.storage.session`），每条记录带 `tag + 文本指纹`：

```
点击 → 找到 ref 对应元素 → 重新读 tag/文本 → 与指纹比对 → 不一致就报 E_STALE_REF
```

代价是「动态文本」元素（倒计时、计数器）会误报，所以留了 `--force` 逃生口。

### 2. 真实输入，且防重排

`hover` 用 `Input.dispatchMouseEvent(mouseMoved)` 驱动真正的 `:hover`；
`click` 的序列是 **移动 → 重新测量 → 按下 → 抬起**。
中间那步「重新测量」很关键：悬浮菜单收起、吸顶条下沉都会让元素跳位，
不重测就会点在上一帧的坐标上（实测踩过）。

### 3. 跨 iframe 与 shadow DOM

页面代理注入到**每个 frame**（`allFrames: true`，跨域也覆盖），每个 frame 自己遍历 open shadow root。
主文档与子框架的元素在调用方看来完全一样：同一套 ref、同一套命令。

坐标换算：同源 frame 由 `window.frameElement` 链累加偏移；跨域 frame 改由 CDP 补几何——
`Page.getFrameTree` + `DOM.getFrameOwner` + `DOM.getBoxModel` 拿到 iframe 在父文档中的位置，
减去父 frame 滚动量后逐层累加。**click / fill / hover 共用同一套跨域几何兜底**（`via: "cdp"`），
只有在几何拿不到时（如 frame 未出现在 frame tree）才退回合成事件并如实标 `via: "synthetic"`；
元素截图也使用同一偏移，iframe 内元素不会再截到主页面空白区。

frame 会动态出现：每次调用前用「小探针 + 只补缺的」方式保证新 iframe 也有代理，
不会因为「注入过就跳过」而对后插入的 frame 失明。

### 4. 焦点仿真：被遮挡的窗口也能操作

浏览器窗口被 IDE 挡住时，Chrome 把页面标成 `visibilityState=hidden`——
于是 CDP 输入被丢弃、截图拿不到新帧、rAF 被节流。
检测到 hidden 就发 `Emulation.setFocusEmulationEnabled`，让页面「相信」自己可见。
（这解释了早期「命令成功但页面毫无反应」的诡异现象。）

### 5. 截图：坐标、编号、后台、emulation

- 元素截图的 `clip` 必须用**文档坐标**（视口坐标 + `scrollX/Y`），否则页面一滚就截到空白
- 默认把 ref 编号画进截图（`position:fixed` 覆盖层，截完即删），视觉模型才有锚点
- 后台标签 8 秒超时前就判断 `visibilityState`，直接给 `E_TAB_HIDDEN` 而不是干等
- 纯色帧（滚动竞态下渲染器没出帧）自动重试两次；仍纯色则结果带 `uniform: true` 返回，不误报成功
- 截图不再把 390px 的移动端模拟误判为“窗口过小”；已有的 `emulate` 设备指标会保留并在临时覆盖后恢复
- 默认不抢焦点；只有显式 `--focus` 才聚焦窗口

### 6. 并发、审计与脱敏

- **同 tab 串行**：命令按 `tabId` 在 service worker 里排队，避免 `click` 与 `snapshot` 并发
  竞争 ref 注册表与输入焦点；不带 tab 的命令（status/tabs/open）保持并行。
- **审计**：桥接把每条命令写入 `~/.ark-web/logs/audit.jsonl`（时间 / 命令 / 参数摘要 / 成败 / 耗时，
  5MB 轮转）。嵌套参数、URL query、`text`/`file`/`body`/token/password 等敏感键深度脱敏，
  `code` 只保留截断。
- **脱敏**：`input[type=password]` 的值在快照、属性、断言、fill 返回值里一律返回 `••••••`；
  fill 的匹配校验在页面内完成，不把明文带回扩展侧。
- **扩展通道**：ID 白名单 + `~/.ark-web/ws-secret` 共享密钥；未完成 hello 的连接不进入可用表，
  响应必须来自请求实际发送到的连接；白名单文件损坏时 fail-closed。

## 七、自检

```powershell
npm test                         # 三套全跑
node test\selftest.js            # 49 项：基础回归（连接/抽取/表格/表单/翻页/错误码）
node test\verify.js              # 45 项：专项验收（跨边界/跨域真输入/真实悬停/富文本/指纹/拦截/截图/覆盖率/模拟/视觉差异）
node test\regression.js          # 41 项：修复回归（跨 frame text/state/upload、HAR 正文、rowspan、多浏览器、密码/ref/WS 等）
node test\selftest.js -k extract # 只跑名字含 extract 的项
```

两套都自带夹具服务、不依赖外网，退出码 0 即全绿。`verify.js` 覆盖的是这一版修掉的缺陷，
改任何与元素、输入、截图相关的东西都应该跑它。

夹具：`test/fixture.html`（通用）、`test/probe.html`（专项：iframe、shadow、富文本、
自定义下拉、长页面、target=_blank、JSON-LD）。
`test/` 在热重载指纹排除表里，改测试不会触发扩展重载。

## 八、已知限制（诚实清单）

- **只支持 Chromium 系**（Chrome / Edge）
- 网络/控制台缓冲上限 800 条/标签页；最近 200 条落 `storage.session`（30 分钟时效），
  SW 被回收或扩展重载后仍能接回历史；落盘副本移除 Cookie/Authorization 头
- `coverage` 只能统计 `start` 之后编译的脚本：要覆盖整页，请在导航前 `coverage --mode start`（已加载页面可先 `eval "location.reload()"`）
- 截图在窗口被遮挡/最小化时**不再盲等**：分级探测（900→2500→8000ms）后直接给 `E_TAB_HIDDEN`/`E_OCCLUDED`，最坏约 3.5 秒
- 后台标签（`--tab-bg`）截图受 Chrome 合成节流：实测前台约 0.4s、后台约 3.5s；要快就先 `activate`
- 因此 `snapshot` 默认不截图：AI 的常规循环（看结构 → 定位 → 动作）不付出截图代价
- 跨域 iframe 走 CDP 真输入需要多算一次 frame 几何（约 50-100ms）；个别 OOPIF 不在 frame tree 里时仍会退回合成点击
- `extract` 只支持 CSS 选择器；虚拟列表需配合 `--scroll` 分轮采集
- `text` / `state` 会聚合可注入 frame；sandbox 到完全无法注入的 frame 会跳过并保留主文档结果
- `upload` 支持主文档、iframe、open shadow root 内的 file input；极端 OOPIF 若 DOM 树不可见会明确报错
- `table` 的 rowspan/colspan 以“重复填充”展开；合并单元格的语义标签不做额外推断
- 多浏览器同时连接时：`tabs` 默认聚合；普通命令用 `--ext`/`--browser` 指定；`fanout` 可并行；只给 `--tab` 时会自动反查所属浏览器，同号冲突则要求显式指定
- 元素截图已支持 iframe 偏移；几何完全拿不到的极少数 OOPIF 会明确报错而不是截空白
- 请求拦截开启后，`Fetch` 会暂停所有请求直到被放行；用完记得 `net-intercept --on false`
- 无 Lighthouse 级审计（`perf` 是 CDP metrics + Performance API）
- `chrome://`、扩展商店、PDF 内嵌等特权页不可操作
- 弹窗默认 `manual` 不自动处理——脚本里要显式设策略，否则页面会卡住
- `cdp` 直通只能发**页面目标**的方法，`Browser.*` 这类浏览器级域不可用

## 九、排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `connected: false` | 扩展没加载 / 桥接没起 | 起桥接，再看 `chrome://extensions` 图标 |
| 被桥接拒绝（badge `!`） | 扩展 ID 不在白名单 | `node scripts\label-browsers.js --yes` |
| 命令成功但页面没反应 | 窗口被遮挡，页面被判 hidden | v5 已自动焦点仿真；仍失败则 `activate` 或 `shot --focus` |
| `E_STALE_REF` 频繁 | 页面在持续重渲染 | 每一步前 `snapshot --diff`，或用 `--force` |
| 改了代码没生效 | 热重载护栏（2 分钟 3 次） | `node scripts\reload.js`（手动重载不受护栏限制） |
| 截图空白 | clip 用了视口坐标 | v5 已修；确认 `shot` 的 `clip.y` 与页面滚动一致 |
| 填了但校验不过 | 富文本/联想输入 | 加 `--type` 逐字符 |

## 十、与技能卡的关系

`ark-web` 技能卡的「浏览器子系统真源」指向本目录：`C:\Users\24584\browser-debug-extension`。
检索侧（`seek/`）与本子系统互补：**只用一次批量检索走 seek，要看/点/填/抓页面走这里**。
