---
name: semantic-locating
description: 语义检索的细节：query 怎么写、候选怎么读、id 怎么用、失败怎么降级
whenToUse: 需要按内容描述定位页面元素，或 semantic_find 结果不符合预期时
---

# 语义定位（semantic-locating）

语义层把页面切成"内容块"并建倒排索引。你写的是**意图**，它负责对齐文字。

## query 的写法
- 用页面会出现的**词**，不要用抽象概念："最便宜 商品 价格" 好于 "价格最低的选项"。
- 想找控件时带上它的功能词："评论 输入框"、"发送 按钮"、"搜索"。
- 找不到时换词再试一次（同义词、更短的关键词），但**同一个 query 不要超过两次**。

## 读候选
- 返回 `hits[]`，每条含 `id`（如 u13）、`type`（paragraph/heading/button/card…）、`text` 摘要、`interactives[]`（块内控件标签）。
- `text` 是摘要不是全文；要全文用 `semantic_read {unit_id}`。
- `interactives` 只是标签（如"加入购物车"），要真的点用 `semantic_click {unit_id}` —— 不需要知道 CSS 选择器。

## id 的生命周期
- id 只在**当前页面的本次索引**内有效。导航/刷新后索引会重建，旧 id 作废。
- 跨页面不要复用 id：先对新页面 `semantic_find`。

## 失败降级路径（按顺序）
1. 换 query 关键词，再 `semantic_find` 一次。
2. `query_all` 用 CSS 选择器找（如 `input[type=search]`）。
3. `read_text` 通读全文，人工推断位置。
4. `snapshot` 看整页结构。
5. 以上都不行，且任务是操作类 → `give_up` 说明页面结构超出定位能力。

## 何时不用语义层
- 目标有稳定选择器且你在做批量机械操作（轮询读价签）→ `query_all` 更直接。
- 需要页面视觉信息（布局、图片）→ `snapshot` / `screenshot`。
