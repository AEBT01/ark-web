# RELEASE v2.9.0 — Ark Web（宣发大版）

> 状态：**待发布（草稿）**。本文档只做发版准备，不代表已执行 bump / tag / push。
> 基线：本地 `C:\Users\画扇\Desktop\无\ark-web`，已发布 v2.8.2（tag 存在，GitHub release 2026/8/29），远端与本地同步，`git status` 干净。
> 下一版本：**v2.9.0**（minor 大版：宣发向 —— 英文 README + GitHub Pages + 徽章，区别于 v2.8.2 修补版）。
> 约束：本次任务**不要执行** bump / tag / push，**不要改**原文件；push / release 需用户执行（可能要鉴权）。

## 0. 版本号

- **v2.9.0**
- 版本号唯一来源：`extension/manifest.json` 的 `version`（CHANGELOG.md 头部亦有声明）。
- 当前基线：`extension/manifest.json` = `2.8.2`，`server/package.json` = `2.8.2`，manifest description 含 `Ark Web v2.8.2`。
- 发版时将两处 `2.8.2` → `2.9.0`（含 manifest description 内版本号）。

## 1. Highlights（本版卖点：宣发向，无功能破坏性）

v2.9.0 是**宣发大版**：代码行为不变，主打“让人发现、让人装上、让人用起来”。

1. **English README**：新增英文版 README（如 `README.en.md` + 主 README 顶部语言切换），面向海外用户 / 搜索引擎 / GitHub 探索流。
2. **GitHub Pages**：开通 Pages 落地页（安装 → 快速开始 → 端点速查 → 审计演示 → FAQ），配截图/动图，SEO 可索引。
3. **Badges（徽章）**：README 顶部徽章行 —— version / license / Pages / platform（Windows+macOS/Linux）/ endpoints:117 / last-release-date。
4. **SEO**：仓库 About / README / Pages 统一关键词：`ai browser automation`、`chrome cdp bridge`、`multimodal snapshot`、`browser audit`、`llm tool`；中英双语关键词各一份。
5. **Topics 建议**（GitHub → About → Topics，手动勾选，建议 8–12 个）：
   `ai-agents`、`browser-automation`、`chrome-extension`、`cdp`、`playwright-alternative`、`llm-tools`、`multimodal`、`web-audit`、`web-scraping`、`developer-tools`、`automation`、`mcp-like`
6. 区别于 v2.8.2：v2.8.2 是修补版（screenshot 串页 / activeTabId 污染 / SW Buffer / chain dialog / cookie 会话路由 / 审计会话逃逸等真实 bug × N + `start.sh` 跨平台）；v2.9.0 **不带行为变更**，纯宣发 + 文档 + 门面。

## 2. Upgrade notes（升级说明）

- **无破坏性变更**：端口 / WebSocket 协议 / 端点契约 / CLI 用法不变。
- Bridge Server 端口与 WS 消息格式不变；117 端点（以 `scripts/check-endpoints.js` 为准）全部兼容。
- Chrome 扩展 MV3 权限不变（仍需 `<all_urls>` + debugger 等）；升级即覆盖 `extension/` + `server/` 即可。
- 从 v2.8.2 升级：无需改脚本、无需清会话、无需重装依赖（`server` 仅依赖 `ws@^8.16.0`）。
- 回滚：直接装回 `dist/ark-web-v2.8.2.zip` 或 `git checkout v2.8.2` 重新打包即可。

## 3. Files（交付物）

打包脚本 `scripts/package.js` 以 `extension/manifest.json` 的 version 生成包名，bump 到 2.9.0 后执行 `node scripts/package.js` 预期产物：

- `dist/ark-web-v2.9.0.zip`（主交付物，挂到 GitHub Release Assets）
- `dist/ark-web-v2.9.0/`（staging 目录，30 个文件左右，详见 `scripts/package.js` INCLUDES）
- 终端会打印：版本 / 文件数 / 源文件 KB / ZIP KB / 路径 / SHA256 —— 把 **SHA256 贴进 Release 正文**（见 §5 模板的校验位）。

打包内容（`scripts/package.js` INCLUDES 现状，v2.9.0 若新增 `README.en.md` / `docs/` 落地页，记得同步追加进 INCLUDES，否则 zip 里没有英文 README）：

```text
extension/manifest.json, background.js, content.js, popup.html, popup.js,
devtools.html, devtools.js, icons/icon{16,48,128}.png,
server/bridge-server.js, audit.js, audit-report.js, package.json,
client/browser-client.js, ark-fast.js,
scripts/check-endpoints.js, smoke-test.js, real-scenario-v3.js, real-scenario-v4.js, package.js,
ark.js, start.bat, start.sh,
README.md, CHANGELOG.md, SKILL.md, LICENSE
+ （v2.9.0 建议新增：README.en.md、Pages 相关 docs/ 页面）
```

注意：`scripts/package.js` 会 `fs.rmSync(DIST)` 清空 dist 再打包，属正常行为。

## 4. Git 命令清单（按顺序，需用户执行 —— 可能要鉴权）

以下命令在 `C:\Users\画扇\Desktop\无\ark-web` 下执行。**不要提前执行**，发版当天一条条跑。

```powershell
# 0. 发版前检查（干净 + 同步 + 基线确认）
git status
git log --oneline -5
git tag --list "v*"
git remote -v

# 1. bump 版本号（两处 + description）
# extension/manifest.json: "version": "2.8.2" -> "2.9.0"
#   description 内 "Ark Web v2.8.2" -> "Ark Web v2.9.0"
# server/package.json: "version": "2.8.2" -> "2.9.0"

# 2. CHANGELOG 追加（文件顶部、版本声明行之后，仿 v2.8.2 格式）
# 标题建议：## v2.9.0 (2026-09-XX) — Promo release: English README + Pages + badges
# 条目：英文 README / Pages / 徽章 / SEO+topics / INCLUDES 若有新增文件一并注明

# 3. 打包验证（bump 后必跑，确认 zip 名与内容）
node scripts/package.js
# 预期：dist/ark-web-v2.9.0.zip 生成，记录 SHA256

# 4. 端点/冒烟（如仓库惯例要求，跑通再提交）
node scripts/check-endpoints.js
# 可选：node scripts/smoke-test.js（需浏览器+插件在线）

# 5. 提交
git add extension/manifest.json server/package.json CHANGELOG.md README.md README.en.md docs/ dist/ -A
git status
git commit -m "release: v2.9.0 (promo: English README + Pages + badges)"

# 6. 打 tag + 推送（需鉴权：SSH key / gh auth / 凭据管理器，失败就停在这里找用户）
git tag -a v2.9.0 -m "Ark Web v2.9.0 — Promo release: English README + Pages + badges"
git push origin main
git push origin v2.9.0

# 7. 建 GitHub Release（tag 推送成功后；二选一）
# A. CLI：
gh release create v2.9.0 "dist/ark-web-v2.9.0.zip" --title "v2.9.0 — Promo release" --notes-file docs/RELEASE-v2.9.0-NOTES.md
# B. 网页：GitHub → Releases → Draft new release → Choose tag v2.9.0 → 标题见 §5 → 正文粘 §5 英文模板 → 上传 dist/ark-web-v2.9.0.zip → Publish
```

鉴权提示：`push` / `gh release create` 若报 401/403/permission denied，**停下，不要改远端配置**，先 `gh auth status` / `gh auth login` 或确认 SSH key，再重跑第 6–7 步。

## 5. GitHub Release 正文（英文版，可直接粘贴）

> 标题：`v2.9.0 — Promo release: English README + Pages + badges`
> 附件：`dist/ark-web-v2.9.0.zip`（+ 下方 SHA256 替换为实测值）

```markdown
# Ark Web v2.9.0 — Promo release 🌍

v2.8.2 was a patch release (real bug fixes). **v2.9.0 is the promo release**: same stable core, brand-new front door for the world.

## ✨ Highlights

- 📖 **English README** — full English guide with language switcher, so global users can install in minutes.
- 🌐 **GitHub Pages site** — landing page with install → quickstart → endpoint tour → audit demo → FAQ, fully indexable.
- 🛡️ **Badges** — version / license / Pages / platform / 117 endpoints / release date, at a glance.
- 🔍 **SEO + topics** — unified keywords (`ai browser automation`, `chrome cdp bridge`, `multimodal snapshot`, `browser audit`, `llm tool`) in README, About and Pages.

## 📦 Install / Upgrade

- No breaking changes. Ports, WebSocket protocol, 117 endpoints and CLI usage are unchanged from v2.8.2.
- Upgrade: replace `extension/` + `server/`, reload the extension, restart the bridge server. No session reset, no dependency changes (`ws@^8.16.0` only).
- Rollback: reinstall `ark-web-v2.8.2.zip` or `git checkout v2.8.2`.

## 📁 Files

- `ark-web-v2.9.0.zip` — full toolchain (extension + bridge server + clients + scripts + docs). See SHA256 below.

**SHA256:** `<paste output of node scripts/package.js here>`

## 🙏 Thanks

If Ark Web saved you time, please ⭐ star the repo and share your audit screenshots — it helps more agent builders find us.
```

---

_维护注：本文档为发版草稿（`docs/RELEASE-v2.9.0.md`），发布成功后可归档或删除；真正的版本记录以 `CHANGELOG.md` + tag `v2.9.0` + GitHub Release 为准。_
