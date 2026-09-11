# ark-web v2.9.0 — 中文宣发包

> 仓库：https://github.com/AEBT01/ark-web · 文档站：https://aebt01.github.io/ark-web/ · MIT 协议 · v2.9.0（新增英文 README + Pages 站，核心功能不变——不确定的以仓库为准）

---

## 1. 掘金

**标题：** 让 AI 开你正在用的真浏览器：ark-web v2.9.0 开源（复用登录态 + 中文 Skill 手册 + 审计出报告）

**正文：**

每次让 AI 操作网页，它都要新开一个没有登录态的 Chromium，又要扫码重登？**ark-web** 换了个思路：直接让 AI 开你正在用的真 Chrome。

它是 Chrome MV3 插件（走 CDP）+ 本地 Node 桥（localhost:9333，117 个 HTTP 端点），MIT 开源，v2.9.0 刚发布英文 README 和文档站。

几个真实卖点（均以仓库为准）：

- **复用登录态，不用重登**：跑的是你的真浏览器，Cookie、SSO、后台管理系统已登录的会话直接能用，真渲染、真输入。
- **中文 Skill 手册**：仓库自带中文说明 + `SKILL.md` 统一手册，AI 按手册一步步调接口，上手成本低。
- **审计出报告**：30+ 维度审计引擎，性能/可访问性/SEO/安全打分，直接生成 HTML 报告，前后优化对比看得见。
- **视觉 snapshot**：一次调用返回截图 + SoM 坐标锚点，多模态模型按坐标点，不用翻选择器。
- **`?session` 多智能体会话隔离**：多个 Agent 共用一个 Chrome，标签页互不串台。
- **batch 链式 + device/media/network 模拟**：多步操作一次发完，还能模拟设备、主题、弱网。

3 步跑起来（以仓库为准）：`chrome://extensions` 加载 `extension/` → 点「启用调试」→ 启动 bridge → `curl http://localhost:9333/status`。

⚠️ **安全提醒**：localhost 本地调试工具，**无鉴权设计**，本机任何进程都能操控浏览器。仅限本机使用，不要暴露端口，不要在共享电脑上跑。

v2.9.0 主要是英文 README + Pages 站（https://aebt01.github.io/ark-web/），核心不变。欢迎 Star 和提 Issue。

---

## 2. V2EX

**标题：** [开源] ark-web v2.9.0：让 AI 开你的真 Chrome，复用登录态，本地桥 MIT 协议

**正文：**

分享一个自用的小东西：**ark-web**，Chrome MV3 插件 + 本地 Node 桥，让 AI 直接操作你正在用的真浏览器，而不是 headless 新开一个。

- 桥跑在 localhost:9333，117 个 HTTP 端点（导航/点击/填表/截图/PDF/模拟等，以仓库为准）
- **复用登录态**：你的 Cookie 和登录会话都在，不用重登
- **中文 Skill 手册**：`SKILL.md` + 中文 README，照着调就行
- **审计出报告**：30+ 维度打分 + HTML 报告
- 原子视觉 snapshot（截图 + SoM 坐标锚点）、`?session` 多会话隔离、batch 链式、device/media/network 模拟
- MIT，v2.9.0：英文 README + https://aebt01.github.io/ark-web/

⚠️ 仅本机用：localhost 无鉴权，不要暴露端口。

求轻拍，欢迎提 Issue。

---

## 3. 知乎想法

**标题：** AI 不用重登就能用我的浏览器了？试了下 ark-web，真香但只能本机玩

**正文：**

试了个开源项目 ark-web（MIT），思路很对胃口：不给 AI 另开无痕 Chromium，而是让它直接开我正在用的 Chrome——登录态都在，Cookie、后台、SSO 全都不用重登。

原理是 MV3 插件走 CDP + 本地桥 localhost:9333，对外 117 个 HTTP 接口。AI 照着中文 Skill 手册（`SKILL.md`）调接口就行：截图定位靠 snapshot（截图+坐标锚点），多任务靠 `?session` 隔离，批量操作走 batch 链式，还能模拟设备/网络，最爽的是审计功能——30 多个维度打分直接出 HTML 报告，改完再跑一遍对比，优化效果一目了然。

v2.9.0 刚发了英文 README 和文档站：https://aebt01.github.io/ark-web/

泼盆冷水：它是 localhost 无鉴权设计，只能本机玩，千万别暴露端口。具体以仓库为准：https://github.com/AEBT01/ark-web

---

## 备选标题

1. AI 开真浏览器是什么体验？ark-web v2.9.0：复用登录态、审计出报告
2. 不用重登！让 AI 直接用你的 Chrome：开源 ark-web 上新
3. 给 AI 配个真浏览器：ark-web 中文手册 + 30 维审计报告
4. 一个人测 perf 太累？让 AI 开你的浏览器自动审计出报告
5. localhost 无鉴权的真香工具：ark-web 让 AI 复用你的登录态
