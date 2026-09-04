# ark-web v2.9.0 — Launch Pack (EN)

> Repo: https://github.com/AEBT01/ark-web · Docs site: https://aebt01.github.io/ark-web/ · License: MIT · Version: v2.9.0 (English README + Pages site; core unchanged — details per repo)

---

## 1. X Thread (5 posts, each < 270 chars)

**1/5 — Hook**
Your AI keeps opening a fresh Chromium with zero logins? ark-web drives YOUR real Chrome: MV3 extension (CDP) + local Node bridge on localhost:9333. 117 HTTP endpoints. MIT. 🚀 #AIagents #automation

**2/5 — Vision**
One call, full vision: atomic snapshot = screenshot + SoM coordinate anchors. Multimodal models click by coordinates — no selector archaeology. #LLM #ComputerVision

**3/5 — Multi-agent**
Parallel agents, zero collisions: `?session=` isolates tabs, cookies, nav & audit queues server-side. Run several agents on one Chrome. #MultiAgent #DevTools

**4/5 — Audit + emulation**
Plus: 30+ dimension audit engine (perf/a11y/SEO/security, scored HTML reports), batch chaining, device/media/network emulation. #WebPerf #SEO

**5/5 — Safety + links**
⚠️ Local-only by design: binds localhost, NO auth — never expose the port. Docs: https://aebt01.github.io/ark-web/ · Repo: github.com/AEBT01/ark-web ⭐ #opensource #selfhosted

---

## 2. Hacker News — Show HN

**Title:** Show HN: ark-web – Let AI drive your real Chrome (CDP bridge, snapshots, audits)

**Body:**

**What:** ark-web lets an AI agent drive the Chrome you actually use — with your logins and cookies — instead of a throwaway headless Chromium. A Chrome MV3 extension (CDP via `chrome.debugger`) talks to a local Node bridge on localhost:9333 exposing 117 HTTP endpoints: navigation, trusted input, form fill, screenshots/PDF, device/media/network emulation, and batch chaining.

**Why:** Logged-in sites, SSO, and paywalls "just work" because it's your real browser and real rendering. For multimodal models there's one atomic vision call: `snapshot` returns a screenshot plus SoM coordinate anchors, so the model clicks by coordinates. `?session=` gives server-enforced session isolation so multiple agents can share one Chrome. A 30+ dimension audit engine scores perf/a11y/SEO/security and emits an HTML report.

**Demo:** Load `extension/` in `chrome://extensions` → click "Enable Debug" → `node bridge-server.js` → `curl http://localhost:9333/status`, then `GET /snapshot?annotate=1`. Full tour: https://aebt01.github.io/ark-web/ — v2.9.0 adds the English README + Pages site (core unchanged).

**Ask:** I'd love feedback on (a) the snapshot/SoM vision workflow vs. selector-based approaches, (b) whether `?session` isolation matches how you run parallel agents, and (c) what audit dimensions you'd add. MIT licensed; issues and PRs welcome.

⚠️ **Security note:** local-only debug tool, no authentication by design — any local process can drive your browser. Do not expose the ports; localhost use only.

---

## 3a. Reddit — r/LocalLLaMA

**Title:** [Local-only] ark-web: let your local LLM drive your REAL Chrome — snapshot vision, session isolation, audit reports (MIT)

**Body:**

I run my agents locally and got tired of every framework spawning a fresh Chromium with no logins. So I published **ark-web** (MIT, v2.9.0): a Chrome MV3 extension + local Node bridge that lets an LLM drive the browser you actually use.

How it works (per repo):

- Extension uses CDP to control your real Chrome; bridge serves **117 HTTP endpoints** on `localhost:9333`
- **Atomic snapshot**: one call returns screenshot + SoM coordinate anchors — good fit for local VL models (e.g. point-and-click by coordinates, no selectors)
- **`?session` isolation**: multiple agents share one Chrome without stepping on each other's tabs/cookies/queues
- **Batch chaining**: chain steps in fewer round trips
- **30+ dimension audit engine**: scored perf/a11y/SEO/security report as HTML
- **Device/media/network emulation** for testing layouts, themes, throttling

Typical flow: load the extension → Enable Debug → start bridge → `GET /status`, `GET /snapshot?annotate=1`. Docs: https://aebt01.github.io/ark-web/

⚠️ **WARNING — local-only, NO auth:** binds localhost with no authentication by design. Any local process can drive your browser. Never expose the port, don't run on shared machines. (Details per repo.)

Happy to answer questions — especially from anyone wiring this to ollama / llama.cpp / local VLMs.

---

## 3b. Reddit — r/selfhosted

**Title:** ark-web v2.9.0 (MIT): self-hosted bridge that lets AI use your real Chrome — 117 endpoints, audits, session isolation

**Body:**

**What it is:** ark-web is a small self-hosted stack (Chrome MV3 extension + Node bridge on `localhost:9333`, MIT) that exposes **117 HTTP endpoints** so an AI agent — or a script — can drive your real Chrome: navigate, click/type, screenshots/PDF, batch-chained steps, device/media/network emulation, and a 30+ dimension audit engine with scored HTML reports.

**What it's good for (self-hosters):**

- Reuse your real browser profile: logged-in dashboards, router UIs, self-hosted apps — no re-login in a headless sandbox
- `?session` isolation: run parallel agents/jobs against one Chrome
- Atomic `snapshot`: screenshot + SoM coordinate anchors for vision-model automation
- Audit engine for before/after perf reports on your own sites

**Install (per repo):** load `extension/` via `chrome://extensions` → Enable Debug → `node bridge-server.js` (or start script) → `curl localhost:9333/status`. v2.9.0 = English README + Pages site (https://aebt01.github.io/ark-web/); core unchanged.

⚠️ **HEADS-UP — local-only, NO auth:** this is a localhost debug tool with no authentication. Any local process can fully drive your browser. Bind to loopback, firewall the ports, never expose to LAN/internet. If you need remote access, put your own auth/reverse-proxy in front — otherwise treat as "per repo" and keep it on the box.

---

## 4. Dev.to

**Cover title:** Let AI Drive Your Real Chrome: 117 Endpoints, Snapshot Vision, and Audit Reports — All Local

**Lede:** Headless browsers forget who you are. ark-web (MIT, v2.9.0) puts your AI behind the wheel of the Chrome you actually use — CDP-powered real input, one-call screenshot+coordinate snapshots, multi-agent session isolation, batch chaining, device/network emulation, and a 30+ dimension audit engine. Localhost only, by design. Here's how it works and how to try it in 3 steps.

---

## Alt titles (pick any)

1. Let AI Drive the Browser You Actually Use: ark-web v2.9.0
2. Your Chrome, Your Logins, Your AI: 117 Local Endpoints
3. Stop Giving Your Agent a Fresh Chromium — Give It Your Chrome
4. Snapshot Vision + Session Isolation + Audits: a Local Browser Bridge for AI
5. ark-web v2.9.0: Real-Browser Automation for AI Agents (MIT, Local-Only)
