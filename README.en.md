# Ark Web Bridge v5.1

> Control your **real** Chromium browser from AI agents — MV3 extension + local Node bridge + AI-oriented CLI.
> 中文主文档见 [README.md](README.md)。

Ark Web connects to the browser you actually use (chrome/edge/quark), with your existing logins and profile. It does **not** start a separate automation browser.

## What it provides

- **Real CDP input**: mouse/keyboard/text through `Input.*`, not synthetic DOM events
- **Cross-frame & shadow DOM**: every frame gets a page agent; refs work across iframes
- **Ref registry with fingerprints**: stale refs fail loudly instead of clicking the wrong element
- **Self-verifying actions**: fill read-back, click effect confirmation, assertions
- **Visual snapshots**: refs burned into screenshots for multimodal models
- **Network / console / HAR / request interception**
- **Coverage, Web Vitals, device/network/CPU emulation**
- **Multi-browser**: aggregate tabs, select by `--browser` / `--conn`, parallel `fanout`
- **Security**: loopback-only, token auth, extension shared-secret handshake, whitelist fail-closed
- **Hot reload** for extension code; format-preserving audit with redaction

## Quick start

```powershell
cd browser-debug-extension
node server\bridge-server.js
# chrome://extensions -> Developer mode -> Load unpacked -> this directory
node scripts\label-browsers.js --yes
node client\browser-client.js status
node client\browser-client.js open https://example.com --tab-bg
node client\browser-client.js snapshot shot.webp --shot
node client\browser-client.js find --text "Sign in" --role button
node client\browser-client.js click --ref 12
```

CLI: `node client\browser-client.js describe` for the full 42-command surface.
Agent manual: [SKILL.md](SKILL.md). Tests: `npm test` (135 checks; requires a running bridge + loaded extension).

## Multi-browser

```powershell
node client\browser-client.js tabs                 # Chrome + Edge, with browser/extId/conn
node client\browser-client.js open https://example.com --browser edge
node client\browser-client.js fanout "snapshot --limit 20 --no-shot"
```

The same unpacked extension has the same extId in Chrome and Edge; use `--browser` or `--conn` for precise targeting.

## Security

- Binds `127.0.0.1` only; browser-origin requests are rejected except extension health/version probes
- Token at `~/.ark-web/token`; no token endpoint
- Extension channel: ID whitelist + shared secret (`~/.ark-web/ws-secret` + `ark-ws-secret.txt`)
- Unverified connections never enter the usable extension table; responses are bound to the connection
- Audit log redacts nested params, URL queries, passwords, tokens and bodies

## License

MIT. See [LICENSE](LICENSE).
