# Ark Web

> Control your **real** Chrome from AI: Chrome MV3 extension + Node Bridge — 117 endpoints, snapshot/SoM vision, session isolation, audit engine.

[![version](https://img.shields.io/badge/version-v2.8.2-blue)](https://github.com/AEBT01/ark-web)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![stars](https://img.shields.io/github/stars/AEBT01/ark-web?style=social)](https://github.com/AEBT01/ark-web)
[![last-commit](https://img.shields.io/github/last-commit/AEBT01/ark-web)](https://github.com/AEBT01/ark-web/commits)

**Ark Web** is a local bridge that lets AI agents drive the browser you actually use — with your logins, cookies, and real fingerprint. No Puppeteer, no throwaway Chromium. An MV3 extension (CDP via `chrome.debugger`) talks over WebSocket (`:9334`) to a local Node bridge exposing **117 HTTP endpoints** (`:9333`): navigation, trusted mouse/keyboard, React-compatible form fill, screenshots & PDF, device/media/network emulation, network response bodies, atomic vision `snapshot` (screenshot + SoM coordinate anchors) for multimodal models, server-enforced **session isolation** for parallel agents, and a 30+ rule weighted **audit engine** (performance / a11y / SEO / security / resources).

AI agents: load `SKILL.md` — the unified manual with a self-gating step (multimodal → vision workflow with snapshot + coordinates; text-only → selector workflow).

## Why real browser?

- **Your sessions, not a sandbox:** logged-in sites, SSO, paywalls, captchas-you-already-solved just work.
- **True input, true rendering:** CDP trusted mouse/keyboard, real layout, real fonts, real Web Vitals — what you see is what users get.
- **Vision-native:** one atomic `GET /snapshot?annotate=1` returns screenshot + clickable coordinate anchors (SoM). No selector archaeology for multimodal models.
- **Parallel-safe:** `?session=<id>` / `?tabId=<id>` isolates tabs, cookies, navigation, and audit queues across agents.
- **Zero headless drift:** no separate browser binary, no CDP port flags, no fingerprint mismatch.

## Features

- **Snapshot / SoM vision** — `GET /snapshot` (JSON: `dataUrl` + anchors), `GET /snapshot/binary` (raw `image/png`, saves ~33% base64), `POST /act` (one-HTTP high-level intent: `snapshot`/`click`/`clickText`/`fill`/`type`/`extract`/`navigate`).
- **117 endpoints** — navigation, click/hover/drag/scroll, type/fill/select/check, evaluate, wait-for (selector/text/url/load), screenshots (viewport/full/element), PDF, cookies/storage, console, DOM-changes, frames/layout, dialogs. Source of truth: `scripts/check-endpoints.js`.
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

# 3. Verify
curl http://localhost:9333/status
curl -X POST http://localhost:9333/open -d '{"url":"https://example.com"}'
curl "http://localhost:9333/snapshot?annotate=1"
```

CLI alternative:

```bash
node client/browser-client.js status
node client/browser-client.js open https://example.com
```

> Windows PowerShell: prefer `Invoke-RestMethod` over `curl.exe` for JSON bodies. Port via env: `BRIDGE_PORT=9335` (HTTP only — keep WS `9334` unless you also patch `background.js`).

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
| **ark-web** | ✅ your Chrome (CDP trusted input) | HTTP 117 + WS bridge | via bridge/CLI | ✅ atomic snapshot+anchors+binary | ✅ server-enforced per-tab/session | ✅ 30+ dims, scored, reports+trends | AI driving a lived-in browser + perf audits |
| **browser-use** | ⚠️ drives own Chromium | Python lib | ❌ | ⚠️ screenshot + model grounding | ⚠️ manual contexts | ❌ | scripted agent loops in fresh profiles |
| **playwright-mcp** | ⚠️ Playwright-managed browser | MCP over Playwright | ✅ | ⚠️ snapshot (a11y tree), no SoM coords | ⚠️ contexts | ❌ | MCP clients needing Playwright actions |
| **chrome-devtools-mcp** | ✅ local Chrome via CDP | MCP | ✅ | ⚠️ screenshot, no anchor map | ❌ single target | ⚠️ perf traces only | DevTools power users inside MCP |
| **stagehand** | ⚠️ own browser + AI act() | SDK/API | ❌ | ⚠️ AI-inferred act | ❌ | ❌ | `act("book a flight")` style autonomy |
| **puppeteer** | ⚠️ headless/owned Chromium | Node API | ❌ | ❌ manual screenshots | ❌ manual pages | ❌ | code-driven scraping/testing, not agents |

> Table is positioning, not a benchmark — verify against each project's current docs before citing.

## Repo structure

```
ark-web/
├── extension/            # Chrome MV3 plugin (manifest v2.8.2, background CDP + audit capture, content monitor, popup auth)
├── server/
│   ├── bridge-server.js  # HTTP API (117) + WebSocket bridge + cache/keep-alive/per-tab queues
│   ├── audit.js          # audit engine: scoring/insights/opportunities/budgets
│   └── audit-report.js   # report rendering + trend store + batch queue
├── client/
│   ├── browser-client.js # the one CLI + API lib (keep-alive, chain)
│   └── ark-fast.js       # ArkFast SDK (snapshot/click/clickText/fill/extract/act/batch)
├── scripts/
│   ├── check-endpoints.js# endpoint declaration consistency check
│   ├── real-scenario-v3.js # 20 scenarios / 202 steps core suite
│   ├── real-scenario-v4.js # 12 complex real-world scenarios
│   └── smoke-test.js     # 95-item end-to-end smoke test
├── SKILL.md              # AI manual (unified v9: text+vision, model self-gate)
├── CHANGELOG.md          # full version history (current v2.8.2)
├── start.bat / start.sh  # Windows / macOS+Linux launchers
└── ark.js                # shortcut alias → browser-client
```

## Security note

Local debug tool: binds **localhost**, **no authentication** by design. Any local process can fully drive your browser. Do **not** expose the port, do not run on shared/untrusted machines. Recommendation: bind explicitly to loopback (`127.0.0.1`) and firewall the bridge ports (`9333` HTTP / `9334` WS); change HTTP port with `BRIDGE_PORT` if anything else occupies it.

## 中文简介（第二语言节）

> AI 浏览器调试桥接 — Chrome 插件 + Bridge Server + HTTP API = 真实浏览器控制。

把本仓库（或其子集）复制到 `%USERPROFILE%\.agents\skills\ark-web\`，AI 即可通过 `SKILL.md`（统一 v9：文本+视觉二合一，模型自检门）获得全部能力手册。快速开始：`chrome://extensions` 加载 `extension/` → 点插件图标「启用调试」→ `start.bat`（或 `./start.sh`，或 `cd server && npm install && node bridge-server.js`）→ `curl http://localhost:9333/status`。本地 localhost、无鉴权设计，请勿暴露端口或在不可信环境运行。完整中文文档见原 `README.md`，版本历史见 `CHANGELOG.md`。

## License

MIT — see [LICENSE](../LICENSE).
