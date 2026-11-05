# Changelog

## v5.1.1 — 2026-11-06

### 安全

- HAR 的 URL、请求/响应 header、postData、响应正文统一脱敏；base64 正文先解码再处理
- `ARK_WEB_RECORD` 录制的 argv 默认脱敏，`replay` 默认拒绝含 `«redacted»` 的步骤
- 最近 200 条网络/控制台落 `storage.session` 前统一脱敏 URL query、凭据头、请求体和疑似密钥文本
- 缺少扩展白名单时只开放只读配对接口；`/cmd` 与 `/reload` 返回 `E_PAIRING_REQUIRED`
- HTTP 请求体改为按字节计算并限制 `Content-Length`；扩展请求 `timeoutMs` 限制在 1–120 秒；pending 上限 64
- WebSocket 共享密钥和 HTTP token 改为摘要后常数时间比较；`?token=` 不再接受
- 输出文件与录制文件使用 0600 权限；审计归档最多保留 10 个
- 拦截正则拒绝过长模式和灾难性嵌套量词；net-rule 最多 100 条

### 正确性

- 扩展代码指纹改为文件内容 SHA-256，避免仅 touch 触发热重载或同大小/mtime 漏检
- 同 URL 多个跨域 iframe 无法可靠映射时停止 CDP 几何猜测，退回页面内合成输入
- 自动启用的焦点仿真在动作/截图结束后恢复，避免页面长期被标记为可见
- 点击开新标签后默认不再自动切换 lastTab；显式传 `--follow` 才切换

### 工程

- 新增 `test/unit`（7 项），`npm run test:unit` 可单独执行
- 加入 `package-lock.json`，`npm ci` 可复现安装

## v5.1.0 — 2026-11-05

### 安全

- 扩展 WebSocket 通道增加共享密钥握手（`~/.ark-web/ws-secret` + 扩展目录 `ark-ws-secret.txt`）
- 只有完成 hello 的连接才进入可用扩展表；未握手连接 15 秒后关闭
- 响应必须来自请求实际发送到的连接，阻断本地其它 WS 抢答
- 白名单文件损坏时 fail-closed；`/status` 返回 `whitelistCorrupt`
- `/health` 与 `/ext/version` 放行扩展来源，修复 options 页面与 SW 轮询被 403 的问题
- HTTP 请求体上限 2MB、WS `maxPayload` 8MB；增加 ping/pong 心跳清理半开连接
- 审计深度脱敏：嵌套 params、URL query、token/password/body/expression 等；密码快照/属性/fill 返回全链路脱敏
- 网络/控制台历史落 `storage.session`，落盘副本移除 Cookie/Authorization

### 正确性

- `state` 改为 MAIN world 注入，能读到 `window.__INITIAL_STATE__` 等页面全局
- `text` / `state` 在导航后自动重注入页面代理；`text` 覆盖 open shadow root，并选正文量最大的容器
- `text` / `state` 跨 frame 聚合：iframe 正文、JSON-LD 和页面全局会带 frame 标识返回
- `upload` 支持 iframe / open shadow root 内的 file input（CDP 临时标记 + DOM 树穿透 + 回读校验）
- `net-har` 默认读取响应正文（支持 `--no-bodies` / `--max-body`，base64 正确标记）
- `table` 展开 rowspan/colspan、合并多行表头，并保证列名 key 唯一
- 多浏览器：服务端识别 Chrome/Edge、`status` 返回 browser、`tabs` 默认聚合、`--browser` 选择、`fanout` 并行、`--tab` 自动反查所属浏览器
- 密码框 `fill` 在页面内做布尔校验，不再因脱敏值导致必然失败
- contenteditable `fill` 默认替换而不是追加；`press` 只聚焦不清空
- `find` / selector 命令改为增量合并 ref，不再擦掉 snapshot 的旧编号
- ref 序号在 SPA 导航后防碰撞；页面元素池改 WeakRef，避免 detached DOM 泄漏
- 页面代理版本升到 7，热重载后旧代理会被探测并替换
- 跨 frame `assert --count` 汇总所有 frame；`wait --detach` 要求所有 frame 都不存在
- 原生 select 未命中返回 `E_SELECT_FAILED`，不再静默成功
- `emulate` 设备指标会被截图保留，截图失败/重试后恢复；iframe 元素截图使用 frame 偏移
- `click --no-confirm` 不再固定等 1.5 秒；新标签监听与效果确认做竞态
- `scroll` 使用 instant 覆盖 `scroll-behavior:smooth`
- `eval` 增加超时；`table` 参数校验；`extract` 字段解析支持 `:is(a,b)`
- observers inflight 按 requestId 集合计数，重定向/裁剪不再泄漏；hydrate 独立恢复 net/console
- `coverage` 移除不存在的 `CSS.getAllStyleSheets`，按未使用字符数正确排序
- `session` 恢复 tabGroups 权限，返回 `groupId`，并在加载前挂 CDP 捕获首屏网络
- `--ext <extId>` 支持多浏览器精确选择

### 性能与体验

- 同 tab 串行队列覆盖“未显式 --tab”的命令
- `wait` 先尝试主文档事件驱动，避免有 iframe 就永久走慢轮询
- `lastShot` 按条数与总字节双重上限；导航/关闭清理 diff/coverage 状态
- 截图在窗口最小化时立即给 `E_TAB_HIDDEN`，不再返回纯色假成功
- `net` / `console` 增加 `matched`；`net-body` 支持 base64 落盘
- CLI 修复 PowerShell 用法文档、chain 引号注入与 Windows 路径 tokenizer、human 输出

### 测试

- 新增 `test/regression.js`（41 项）
- `selftest.js` 49 项、`verify.js` 45 项，三套共 135 项全绿
- `npm test` 一次跑完三套
