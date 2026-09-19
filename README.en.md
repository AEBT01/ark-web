# Ark Web

> Control your **real** Chrome from AI: Chrome MV3 extension + Node Bridge — 155 endpoints, snapshot/SoM vision, session isolation, audit engine.

![version](https://img.shields.io/badge/version-v3.0.2-blue)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Ark Web** is a local bridge that lets AI agents drive the browser you actually use — with your logins, cookies, and real fingerprint. No Puppeteer, no throwaway Chromium. An MV3 extension (CDP via `chrome.debugger`) talks over WebSocket (`:9334`) to a local Node bridge exposing **155 HTTP endpoints** (`:9333`): navigation, trusted mouse/keyboard, React-compatible form fill, screenshots & PDF, device/media/network emulation, network response bodies, atomic vision `snapshot` (screenshot + SoM coordinate anchors) for multimodal models, server-enforced **session isolation** for parallel agents, and a 30+ rule weighted **audit engine** (performance / a11y / SEO / security / resources).

AI agents: load `SKILL.md` — a vision-first single-path manual: take a snapshot, then act on numbered elements (`clickRef`/`fillRef`) instead of guessing selectors.

## Why real browser?

- **Your sessions, not a sandbox:** logged-in sites, SSO, paywalls, captchas-you-already-solved just work.
- **True input, true rendering:** CDP trusted mouse/keyboard, real layout, real fonts, real Web Vitals — what you see is what users get.
- **Vision-native:** one atomic `GET /snapshot?annotate=1` returns screenshot + clickable coordinate anchors (SoM). No selector archaeology for multimodal models.
- **Parallel-safe:** `?session=<id>` / `?tabId=<id>` isolates tabs, cookies, navigation, and audit queues across agents.
- **Zero headless drift:** no separate browser binary, no CDP port flags, no fingerprint mismatch.

## Features

- **Snapshot / SoM vision** — `GET /snapshot` (JSON: `dataUrl` + anchors), `GET /snapshot/binary` (raw `image/png`, saves ~33% base64), `POST /act` (one-HTTP high-level intent: `snapshot`/`click`/`clickText`/`fill`/`type`/`extract`/`navigate`).
- **155 endpoints** — navigation, click/hover/drag/scroll, type/fill/select/check, evaluate, wait-for (selector/text/url/load), screenshots (viewport/full/element), PDF, cookies/storage, console, DOM-changes, frames/layout, dialogs. Source of truth: `scripts/check-endpoints.js`.
- **Session isolation** — AsyncLocalStorage tab routing; `?session=` / `?tabId=` on every endpoint; per-tab queues (writes serial, reads parallel); audit-run captures and replays ALS context so queued audits never hijack your active tab.
- **Audit engine** — `POST /audit`: 30+ dimensions (Web Vitals, long tasks, resource waterfall, images/fonts, framework detection, DOM complexity, security headers), 5 weighted category scores (0–100), deterministic root-cause insights + ROI-ranked opportunities; HTML single-file report + Markdown + compact AI format; JSONL history, before/after diff, async batch queue, performance budgets.
- **Batch / chain** — `POST /batch` DAG (`_parallel` read blocks run `Promise.all`, 3–5× faster); CLI `chain "open …" "wait-load" "page-info" "screenshot shot.png"` in one HTTP+WS round trip; `POST /act` saves one RTT vs client-side snapshot→mouse.
- **Device / media / network emulation** — `POST /device` (e.g. iPhone 14), `POST /media` (prefers-color-scheme etc.), `POST /network/conditions` (offline/throttle), `POST /geo` (geolocation mock), `POST /locale`/`/timezone`, `POST /network/block`, `GET /network/response` bodies, CPU throttle, bypass-CSP, disable-cache, auto-dark, disable-JS.

## Quickstart (3 steps)

```bash
# 1. Load the extension
# chrome://extensions → Developer mode → Load unpacked → extension/
# Click the extension icon → "Enable Debug" (required on Chrome 136+)

# 2. Start the bridge
cd server && npm install && node bridge-server.js
# Windows: start.bat   macOS/Linux: ./start.sh

# 3. Verify (only GET /health is unauthenticated; all other endpoints need the token)
curl http://localhost:9333/health
TOKEN=$(cat ~/.ark-web/token)   # auto-generated on first start
curl -H "X-Ark-Token: $TOKEN" http://localhost:9333/status
curl -H "X-Ark-Token: $TOKEN" -X POST http://localhost:9333/open -d '{"url":"https://example.com"}'
curl -H "X-Ark-Token: $TOKEN" "http://localhost:9333/snapshot?annotate=1"
```

CLI alternative:

```bash
node client/browser-client.js status
node client/browser-client.js open https://example.com
```

> Windows PowerShell: prefer `Invoke-RestMethod` over `curl.exe` for JSON bodies. Ports: HTTP via `BRIDGE_PORT`; WS host/port/token are editable in the extension popup → Tools → Connection Config (server reads `BRIDGE_WS_PORT`).

## CLI examples

```bash
node client/browser-client.js open https://example.com
node client/browser-client.js click "#search-button"
node client/browser-client.js fill "#q" "hello"        # React-compatible fill
node client/browser-client.js screenshot report.png
node client/browser-client.js pdf report.pdf
node client/browser-client.js report report.json       # /full dump

# Chain — one HTTP+WS round trip
node client/browser-client.js chain "open https://example.com" "wait-load" "page-info" "screenshot shot.png"

# Fast SDK (per-tab + 400ms snapshot cache + binary)
node client/ark-fast.js snapshot --annotate --binary

# Audit
node client/browser-client.js audit-html perf.html
node client/browser-client.js audit-run '["https://a.com","https://b.com"]'
node client/browser-client.js history https://a.com

# ark.js is an alias
node ark.js status
```

curl batch:

```bash
curl -X POST http://localhost:9333/batch -d '{"steps":[
  {"type":"open-url","data":{"url":"https://example.com"}},
  {"type":"wait-for-load","data":{}},
  {"type":"get-page-info","data":{}}]}'
```

## Comparison

|  | real browser? | protocol | MCP | visual (SoM) | session isolation | audit engine | best for |
|---|---|---|---|---|---|---|---|
| **ark-web** | ✅ your Chrome (CDP trusted input) | HTTP 155 + WS bridge | via bridge/CLI | ✅ atomic snapshot+anchors+binary | ✅ server-enforced per-tab/session | ✅ 30+ dims, scored, reports+trends | AI driving a lived-in browser + perf audits |
| **browser-use** | ⚠️ drives own Chromium | Python lib | ❌ | ⚠️ screenshot + model grounding | ⚠️ manual contexts | ❌ | scripted agent loops in fresh profiles |
| **playwright-mcp** | ⚠️ Playwright-managed browser | MCP over Playwright | ✅ | ⚠️ snapshot (a11y tree), no SoM coords | ⚠️ contexts | ❌ | MCP clients needing Playwright actions |
| **chrome-devtools-mcp** | ✅ local Chrome via CDP | MCP | ✅ | ⚠️ screenshot, no anchor map | ❌ single target | ⚠️ perf traces only | DevTools power users inside MCP |
| **stagehand** | ⚠️ own browser + AI act() | SDK/API | ❌ | ⚠️ AI-inferred act | ❌ | ❌ | `act("book a flight")` style autonomy |
| **puppeteer** | ⚠️ headless/owned Chromium | Node API | ❌ | ❌ manual screenshots | ❌ manual pages | ❌ | code-driven scraping/testing, not agents |

> Table is positioning, not a benchmark — verify against each project's current docs before citing.

## Repo structure

```
ark-web/
├── extension/            # Chrome MV3 plugin (manifest v3.0.2, background CDP + audit capture, content monitor, popup auth)
├── server/
│   ├── bridge-server.js  # HTTP API (155) + WebSocket bridge + cache/keep-alive/per-tab queues
│   ├── audit.js          # audit engine: scoring/insights/opportunities/budgets
│   └── audit-report.js   # report rendering + trend store + batch queue
├── client/
│   ├── browser-client.js # the one CLI + API lib (keep-alive, chain)
│   └── ark-fast.js       # ArkFast SDK (snapshot/click/clickText/fill/extract/act/batch)
├── scripts/
│   ├── check-endpoints.js# endpoint declaration consistency check
│   ├── real-scenario-v3.js # 20 scenarios / about 200 steps core suite
│   ├── real-scenario-v4.js # 12 complex real-world scenarios
│   └── smoke-test.js     # end-to-end smoke test (item count from run output)
├── SKILL.md              # AI manual (v3.0.2, vision-first)
├── CHANGELOG.md          # full version history (current v3.0.2; the VERSION file is the source of truth)
├── start.bat / start.sh  # Windows / macOS+Linux launchers
└── ark.js                # shortcut alias → browser-client
```

## Security note

Local debug tool: binds **loopback only** and **requires a token on every endpoint except `GET /health`**. The token is auto-generated at `~/.ark-web/token` (0600); send it as `X-Ark-Token` (the CLI reads it automatically). Host/Origin validation is on by default. Do **not** expose the port, do not run on shared/untrusted machines; firewall `9333` (HTTP) / `9334` (WS) and change the HTTP port with `BRIDGE_PORT` if it is occupied.

## 中文简介（第二语言节）

> AI 浏览器调试桥接 — Chrome 插件 + Bridge Server + HTTP API = 真实浏览器控制。
> 支持 Chrome 及**夸克等 Chromium 内核套壳浏览器**（夸克实测可用，插件会如实上报真实内核）。

**两步用起来**：① `chrome://extensions` 加载 `extension/` → 点插件图标「启用调试」；
② `start.bat`（或 `./start.sh`，或 `cd server && npm install && node bridge-server.js`）→
`curl http://127.0.0.1:9333/health`。

密钥与令牌：令牌自动生成在 `~/.ark-web/token`，除 `/health` 外所有端点需带 `X-Ark-Token`
（用 `node client/browser-client.js` 会自动读取，永不 401）。服务默认**只绑定回环地址**，
并叠加 Host / Origin 校验 —— 不要把它暴露到局域网或公网。

Agent 用法：让它读本仓库的 `SKILL.md`（v3.0.2 起为视觉优先的单一手册）。技能目录（如
`%USERPROFILE%\.agents\skills\ark-web\`）放入口卡（`SKILL.md`）与内置的 seek 检索子系统（子目录 seek）；浏览器完整手册与运行体都在本仓，就地使用。
完整中文文档见 `README.md`，版本历史见 `CHANGELOG.md`。

## License

MIT — see [LICENSE](LICENSE).
