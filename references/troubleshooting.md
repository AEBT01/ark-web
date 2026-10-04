# Ark Web 故障排查

> 按需查阅。**排查顺序建议：① `/health` 看服务是否活 → ② `node client/browser-client.js status` 看连接与版本 → ③ 看下表的连接/僵尸连接两节。**

## 连接与鉴权（最高频）

| 症状 | 原因与解决 |
|------|-----------|
| `401: 缺少或错误的访问令牌` | 直接 HTTP 调用没带令牌。令牌在 **`~/.ark-web/token`**（Windows `%USERPROFILE%\.ark-web\token`）：`Get-Content "$env:USERPROFILE\.ark-web\token" -Raw`。带 `-H "X-Ark-Token: <令牌>"`；**或改用 CLI（自动读取，永不 401）** |
| 文档里看到的 `server/.ark-token` | 那是**旧路径**（v2.9.1 之前）。现已统一为用户级共享令牌 `~/.ark-web/token`，多份项目副本共用同一个，避免服务端与 CLI 令牌不一致 |
| `403: 请求被安全策略拒绝(Host=... 非回环地址)` | 用了非回环 Host（局域网 IP / 域名）→ 改用 `127.0.0.1` 或 `localhost`；确需外部访问要设 `BRIDGE_HOST=0.0.0.0` **且** `ARK_TOKEN` |
| `403: ... Origin=... 不被信任` | 从第三方网页发起调用被拦（设计如此，防 CSRF）→ 用 CLI/curl 或本机页面 |
| `插件未连接` / `connected: false` | ① 浏览器没开；② 插件没加载（`chrome://extensions` → 加载 `extension/`）；③ 扩展 ID 尚未登记 → 运行 `node scripts/label-browsers.js --yes`；④ popup 显示未连接 |
| 插件始终连不上 9334 | ① WS 端口与 server 不一致 → popup「连接配置」改成与 `BRIDGE_WS_PORT` 相同；② 若不是本机已登记的 Ark Web 扩展，填入 `~/.ark-web/token`；③ server 只监听回环，别填局域网 IP |
| 插件日志 `invalid token` | 非登记扩展或本机进程的令牌不正确 → 复制 `~/.ark-web/token` 内容填入 |
| server 重启后 `connected` 持续 false | ① 确认 `GET /health` 返回 `ok:true`；② 确认 `browser-labels.json` 包含当前扩展 ID；③ `chrome://extensions` 点「重新加载」或重启浏览器 |

## 僵尸连接 ⭐（"显示已连接但命令全部超时"的头号原因）

**症状**：`connected: true`，但 `tabs` / `snapshot` / 任何命令都返回
`插件命令超时(20000ms): <命令> — 可能原因: ...`。

**原因**：插件重载（或浏览器睡眠/唤醒）后，**旧的 WebSocket 连接仍留在 server 的 clients 里且 `readyState=OPEN`，但那个旧实例已不再处理消息**。server 按"版本最高"选连接时若选中僵尸，命令就石沉大海。

**已内建的自愈（v2.9.2）**：

1. **超时自动换连接重试** —— 多连接时首个连接只用 8s 探测超时，超时立刻换下一个连接重试；
2. **心跳清理** —— 每 15s 发 ping，连接静默 >120s 直接 terminate 并移出；
3. **可疑连接降权** —— 超时过的连接 30s 内排在候选末尾；
4. **可观测** —— `GET /status` 的 `connections[]` 给出每个连接的 `version/browser/idleMs/suspect/timeouts`。

**处置**：

```powershell
node client\browser-client.js status          # 看 connections[]: suspect:true 或 timeouts>0 即可疑
node client\browser-client.js chain "ping"    # 最轻量的连通性探针（注意: ping 是链式步骤, 没有同名顶层命令）
# 仍不行 → 重启 server（最彻底）
Get-NetTCPConnection -LocalPort 9333 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
node server\bridge-server.js
```

> 若用 curl 看连接健康：`curl.exe -s -H "X-Ark-Token: $(Get-Content "$env:USERPROFILE\.ark-web\token" -Raw)" http://127.0.0.1:9333/status`

## 夸克 / 非 Chrome 内核（Chromium 套壳浏览器）

插件是标准 MV3 扩展，**在夸克（Quark）上实测可用**；插件会在注册时上报真实内核，`/status` 的 `plugin.browser` 会显示 `quark`（而不是硬编码的 `chrome`）。

| 现象 | 说明与处置 |
|---|---|
| `plugin.browser` 显示 `quark` | 正常。说明确实是夸克内核，非代码问题 |
| **后台标签页截图慢（约 3s）或曾报"非当前激活 tab"** | 夸克实测：`fromSurface:false` 被内核直接拒绝（CDP `-32000 Only screenshots from surface are allowed`），所以只能走 `fromSurface:true`；而后台标签页的**首轮取帧几乎必超时**，紧接着重试必成功。v3.0.2 已按此修正：首轮超时 1.5s + 最多 3 次重试，实测 10/10 成功、平均 3.2s。若仍失败，响应里的 `cdpError` 会带每次尝试的真实错误（不再被静默吞掉）。要更快就把该标签页激活（`POST /tab/activate`）——激活页可走 `captureVisibleTab` 快路径（约 1s），但会切换用户视图 |
| 截图报 `Only screenshots from surface are allowed` | 夸克/部分 Chromium 套壳禁止 `fromSurface:false`。插件已自适应记忆该限制（不再浪费往返尝试），无需手动处理 |
| 个别 CDP 域不生效 | 夸克内核部分实现与官方 Chrome 有差异。已知：`Emulation.setLocaleOverride` 被忽略（本 skill 已改用脚本注入兜底 `navigator.language`） |
| 夸克窗口最小化后命令变慢/超时 | 夸克对不可见窗口的渲染进程调度更激进 → 先 `POST /tab/activate` 激活标签页；本 skill 已内建虚拟视口兜底（视口任一维 <100 即触发，含最小化时上报的 45×14 异常小值） |
| `device/clear` 后视口停留在设备宽度 | 夸克下 `Emulation.clearDeviceMetricsOverride` 可能不还原宽高（实测带 `<meta viewport>` 页面首次 clear 残留 390×844）。v2.9.3 已改为"写回 set 前记录的原始视口"软还原（响应带 `viewportRestore`），不再依赖 clear 命令本身；注意**不要**用 detach→attach 强清（会导致 CDP 授权失效 → throttled 降级） |
| 想确认自己用的是哪个浏览器 | `node scripts/doctor.js` 会列出**每个浏览器实际加载的扩展路径**（Chrome/Quark 都会列） |

## CDP 与交互

| 症状 | 原因与解决 |
|------|-----------|
| `需要 CDP` / debugger attach 失败 | Chrome 136+：点插件图标 →「启用调试」；**或直接 `node client/browser-client.js debug-on`**（等价 `POST /debug/attach-all`，无需点 popup）。插件重载/浏览器重启后授权必失效，需重新授权 |
| 点击/悬停突然每步 ~5s | **授权窗口过期**（CDP throttled）→ 已自动降级脚本事件（毫秒级）；`GET /debug/cdp-status` 看 throttled；恢复真实轨迹重开调试授权 |
| 点击无效但元素存在 | 被遮挡或后台标签页视口=0 → 看快照的 `occluded`/`inViewport` 字段；`/scroll-into-view` 或 `/tab/activate` 后重试 |
| `clickRef` 报"元素已不存在" | 页面已变化，快照过期 → 重新 `snapshot?annotate=1` 拿新编号 |
| 坐标点击无效 | 元素被遮挡/在视口外 → 看快照遮挡字段，`scroll-into-view` 后重拍；或改用 `ref` 操作（更稳） |
| 拖拽/滑块无反应 | 脚本合成事件对 jQuery UI / react-draggable 无效 → evaluate 自组 `mousedown→mousemove×N→mouseup`；校验看 `input.value` 而非显示框 |
| React/jQuery 控件不吃脚本事件 | evaluate 完整事件流 `pointerdown→mousedown→pointerup→mouseup→click`（Radix 需 `detail:1`）；输入用原生 setter + `input` 事件（`/fill`、`fillRef` 已内置） |
| 授权后首次点击 ~20s / `evaluate` 含 await ~1s | CDP 通道预热 / `awaitPromise` 固有轮询，正常现象 |
| annotate 编号与视觉不对应 | 页面滚动后位置变化 → 重新 `snapshot?annotate=1` |
| `zoom` 截出来空白/错位 | 目标元素在 iframe 或视口外 → 先 `/scroll-into-view` 再 `zoom`；iframe 内元素需用 `POST /frames` + evaluate 定位 |
| `fromSurface` 相关报错 `Only screenshots from surface are allowed` | 带 `clip` 的截图内核强制要求表面出图，不能用 `fromSurface:false` 绕过 → 抬高窗口/激活标签页重试，或改用 `/snapshot`（整屏，不受限） |
| 页面残留红色编号框 / `data-ark-ref` 属性 | 收尾执行 `POST /reset-all?tabId=`（会清理视觉残留）；下次快照也会自动清除 |

## 输入与编码

| 症状 | 原因与解决 |
|------|-----------|
| `400 无效 JSON body: ... 收到(前120字符)` | 命令行中文被 GBK 损坏 → 走 `--body-file`（UTF-8 无 BOM），见 SKILL §1.4 |
| 中文输入变 `?` | `type` 已自动回读降级；手动复现换 `/fill`；命令行中文永远走 `--body-file` |
| 读取中文结果乱码 | 控制台是显示层问题，数据是 UTF-8 → `... \| Out-File r.json -Encoding UTF8` 再看 |

## 页面与环境

| 症状 | 原因与解决 |
|------|-----------|
| 导航后页面没变 / 跑到别的标签页 | 确认请求带 `?tabId=`/`?session=`；CLI 用 `--tabId <id>` |
| `wait-for-load` 立刻返回旧页面 | 已修（导航标记 + URL 变化判定）。若仍异常，加 `POST /wait-for-stable` 再采集 |
| 快照元素坐标全错/数量异常少 | 拍到了渲染过渡态 → 加 `settle=1` 或先 `POST /wait-for-stable` |
| 会话内报 `必须显式指定 ?tabId=` | 多标签页会话 → 加 `?tabId=` |
| `403: session xxx 未绑定标签页 N` | 越权访问他会话标签页（正常防护）→ `/session/assign` 或换自己会话 |
| 弹窗卡住自动化 | 默认自动应答不应卡；手动模式用 `POST /dialog {accept}` 应答；`GET /dialogs` 看状态；60s 自动回退 |
| 控制台日志为空 | 页面加载早于插件启用 → 刷新页面 |
| `chrome-error://chromewebdata` / 页面打不开 | 站点不可达（网络/被墙）→ 换可达站点或本地 mock。响应会直接给"目标标签页不可用于视觉采集"而非空等 12s |
| 页面一直 loading | 通常是页面引用了永久挂起的第三方资源（被墙/慢请求，实测 IANA 首页的 `cse.google.com`）。v2.9.3 起 `wait-for-load` 在 DOM 就绪超 `stallGrace`(默认 3s) 后返回 `partial:true`（带原因说明），可直接继续操作；也可 `reload` 再等几秒 |
| `No current window` | 最后一个标签页被关连带关窗 → 开任意新标签页恢复 |
| snapshot 返回 `No active tab` / 全白 | 无标签页或页面未加载完 → `GET /tabs` 确认；先 `/wait-for-load` |
| 响应体获取失败 | 非文本类/超大（>2MB）不预缓存 → `GET /network` 确认 URL，换文本类请求 |
| `query-all` 拿不到 `alt` | `fields` 不支持 alt → 用 `/attr` 或 evaluate |
| `evaluate` 报 CSP/unsafe-eval | 已自动 `setBypassCSP` 重试（结果带 `cspBypassed`）；仍失败说明 CDP 通道故障 |
| batch 报 `Unknown command` | `/batch` 的 `type` 必须是插件命令名（`open-url`/...），CLI chain 会自动映射 → 见 `protocol.md` |

## 站点侧限制（如实记录，不伪造）

| 症状 | 处置 |
|------|------|
| 搜索引擎/电商限流、验证码、登录墙 | 属站点反自动化策略。等待 10-60s 重试、换等价入口、或直连详情页 URL。**如实记录结果，不要编造数据** |
| 站点用 Shadow DOM（部分文档站/图库） | 快照可能只看到宿主元素 → 用 `references/evaluate-recipes.md` 的穿透模板 |
| 搜索联想/自动补全干扰输入 | 改用 `/key Enter` 或直接用 URL 参数直达结果页 |
| 需登录才能看到的内容 | 若用户浏览器已登录则快照可见；未登录就记录"登录墙"，不要尝试绕过 |
