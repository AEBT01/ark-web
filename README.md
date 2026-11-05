# Ark Web Bridge（浏览器子系统 v5.1）

把本机 Chrome / Edge 的标签页能力，经本地 WebSocket 暴露给命令行与 agent。
面向 AI 设计：**真实输入、跨边界采集、可自证、零静默失败**。

## 组成

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单（tabs / debugger / scripting / alarms / storage） |
| `background.js` | service worker 入口：连接、分发、自更新 |
| `src/page-agent.js` | 注入每个 frame 的页面代理（同步 API） |
| `src/frames.js` | 跨 frame 编排与 ref 分配 |
| `src/refs.js` | ref 注册表 + 指纹（storage.session 持久化） |
| `src/input.js` | CDP 真实输入 |
| `src/capture.js` | 截图（文档坐标 clip / 编号叠加 / 焦点仿真） |
| `src/observers.js` | 控制台 / 网络 / WS / 弹窗 / 请求拦截 |
| `src/cdp.js` | 调试器会话 |
| `src/commands.js` | 命令语义与错误码 |
| `server/bridge-server.js` | HTTP+WS 桥接（:9333，令牌 + 扩展白名单） |
| `client/browser-client.js` | CLI（42 命令） |

## 安装（只需一次）

```powershell
cd "$env:USERPROFILE\browser-debug-extension"
node server\bridge-server.js       # 终端一，保持运行
```

1. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录
2. `node scripts\label-browsers.js --yes` 登记扩展 ID（启用白名单）
3. 验证：

```powershell
node client\browser-client.js status    # connected: true
node client\browser-client.js tabs
```

## 快速上手

```powershell
# PowerShell 不要用 & $c（带空格的字符串不会被拆成命令）；用函数最稳
function c { node client\browser-client.js @args }
c open https://example.com --tab-bg
c snapshot shot.webp --limit 40 --shot  # --shot 才会截图并把 ref 编号烧进图
c find --text "立即购买" --role button
c click --ref 12                        # 真实点击，回报是否生效
c fill --ref 8 --text "hello"           # 填完回读校验
c assert --selector "#total" --text "¥120"
c close --tab 12
```

## 多浏览器

同时开 Chrome / Edge 时：

```powershell
node client\browser-client.js status                 # 列出 browser / extId / conn
node client\browser-client.js tabs                   # 默认聚合所有浏览器，带 browser/extId
node client\browser-client.js open https://example.com --browser edge
node client\browser-client.js snapshot --ext chrome --shot
node client\browser-client.js fanout "snapshot --limit 20 --no-shot"   # 所有浏览器并行
```

- `--ext` 支持 extId、`chrome`/`edge` 名字，或逗号列表
- `--browser` 是 `--ext` 的语义别名；两者同时出现时 `--ext` 优先
- 同一份解压扩展在 Chrome/Edge 中 extId 相同；需要精确区分时用 `status` 里的 `conn=`，或直接 `--browser edge`
- 只有一个 `--tab` 但连接了多个浏览器时，会自动反查该 tab 属于哪个浏览器；若两边同号则要求显式 `--browser`/`--conn`
- `fanout` 每个浏览器起独立 CLI 进程，真正并行，避免全局 `--ext` 互相覆盖

## 自更新热重载

| 通路 | 触发 | 延迟 |
|---|---|---|
| 文件监听推送 | 扩展目录 sha256 指纹变化 | ~0.7 s |
| 轮询兜底 | 扩展每 8 s 拉 `/ext/version` | ≤8 s |
| 手动 | `node scripts\reload.js` | 立即（不受频次护栏限制） |

指纹只统计扩展运行文件，排除 `node_modules` / `.git` / `logs` / `shots` / `server` / `client` / `scripts` / `test`。

**唯一需手动的一次**：改 `manifest.json` 的 `permissions` / `host_permissions`。所以业务逻辑都写在 `src/` 与 `background.js` 里。

## 安全

- 只绑 `127.0.0.1`；网页来源（`http(s)://` Origin）一律拒绝，扩展来源仅放行 `/health` 与 `/ext/version`
- 令牌在 `~/.ark-web/token`，**没有任何取令牌的端点**；CLI 直读文件
- 扩展通道双重门禁：ID 白名单 + `~/.ark-web/ws-secret` 共享密钥（服务端同时写 `ark-ws-secret.txt` 供扩展读取）。未完成 hello 的连接不进入可用扩展表，响应必须来自请求实际发送到的连接
- 白名单文件损坏时 **fail-closed**（拒绝所有扩展），不会被静默绕过
- 无默认标签回退：没指定 `--tab` 且没有最近操作标签时报 `E_NO_TAB`，绝不误操作你正在看的页面
- 动作全部先验证再执行：可见性 / 禁用 / 遮挡 / 指纹，任一不满足就报错并给出修复动作
- 审计：每条命令写入 `~/.ark-web/logs/audit.jsonl`（时间/命令/参数摘要/成败/耗时，5MB 轮转）；嵌套参数、URL query、密码/token/body 等敏感键深度脱敏，`eval` 代码只留截断
- 脱敏：密码框的值在快照/属性/断言里一律返回 `••••••`，fill 校验在页面内完成，不回传明文
- 网络/控制台最近 200 条落 `storage.session`，落盘前移除 Cookie/Authorization 头
- 同 tab 命令串行执行（不带 `--tab` 时按最近操作标签入队），避免并发竞争 ref 注册表与输入焦点

## 测试

```powershell
npm test                 # 三套全跑
node test\selftest.js    # 49 项：基础回归（连接/抽取/表格/表单/翻页/错误码）
node test\verify.js      # 45 项：专项验收（跨边界/跨域真输入/真实悬停/富文本/指纹/拦截/截图/覆盖率/环境模拟/视觉差异）
node test\regression.js  # 41 项：修复回归（跨 frame text/state/upload、HAR 正文、rowspan、多浏览器、密码/ref/WS 等）
```

三套都自带夹具、不依赖外网；退出码 0 即全绿。

## 与技能卡的关系

`ark-web` 技能卡的「浏览器子系统真源」指向本目录，路径未变。
检索侧（`seek/`）负责「找」，本子系统负责「看懂并操作」。
