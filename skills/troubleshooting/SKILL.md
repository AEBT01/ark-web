---
name: troubleshooting
description: 页面点不动、加载失败、工具报错时的系统排查路径
whenToUse: 工具连续报错、页面无响应、点击无效、内容加载不出来时
---

# 排障（troubleshooting）

排查的原则：**先确定故障层，再对症下药**。盲试是最大的时间黑洞。

## 层次与信号
| 症状 | 先查 | 结论 |
|---|---|---|
| 点击无反应 | `console_logs` | JS 报错 → 读错误文本，多数能直接定位 |
| 请求失败 | `network_log` | 看 status：4xx/5xx 是站点问题；blocked 是拦截 |
| 页面空白 | `page_info` + `evaluate` 读 readyState | 加载中 → `wait_load`；真空白看 console |
| 元素找不到 | `snapshot` | 在 DOM 里确实没有 → 页面结构变了或要滚动加载 |
| 工具报 no-page / 扩展报错 | `cdp_status` / `list_tabs` | 通道问题，换内核工具（见下） |
| 整站打不开 | `navigate` 后 `page_info` | 网络/DNS 问题，如实报告 |

## 通道降级
系统有两条控制通道，一条失效就换另一条，**不要在坏通道上反复重试**：
- **CDP 内核**（首选）：`cdp_eval` / `cdp_click` / `cdp_screenshot` / `cdp_targets`，不依赖扩展。
- **扩展通道**（兜底）：`query_all` / `click` / `read_text` 等，需要插件在线。
- 报 `Cannot access a chrome-extension:// ...` 或 `no-core` → 明确是通道/目标问题，换通道或换目标。

## 工具报错的读法
- `element-not-found`：选择器没命中。用 `snapshot` 找真实结构，不要原样重试。
- `unit-not-found`：语义 id 过期（页面变了）。重新 `semantic_find`。
- `needConfirm`：不是错误，是高风险请示。按安全规程 finish 等确认。
- `tool-failed` 带网络错误：可能是站点限流，等 2-3 秒再试一次；再失败就报告。

## 停止条件
同一修复尝试 ≥3 次失败 → `give_up`，写清：症状、已试过什么、怀疑的层次。给用户的信息要能让他自己做下一步决定。
