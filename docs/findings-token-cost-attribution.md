# 338 万 token 到底花在哪：同任务跨 harness 对照

同一句任务、同一个 bot（同 SOUL、`computer: vm`、`browser: true`、`approvalMode: full`），只换跑它的实例：

> 把当前 Firefox 的地址栏导航到 https://example.com，确认真的加载后，报告窗口标题和页面上那条关于 documentation examples 的英文原句。做完就停。

| | 本地 Qwen3.8-Flash-Next（codex harness） | Devin swe-2-high（devinAgent harness） |
|---|---|---|
| 步数 | 32 | 10 |
| 输入 token 合计 | 3,377,900 | 38,920 |
| 每步输入均值 | 105,559 | 3,892 |
| 输出 token 合计 | 2,619（每步 82） | 311（每步 31） |
| 结果 | 成功，但先走了 11 次 `exec_command` 弯路（开 macOS Firefox、把 `mcp__computer__*` 当 shell 命令跑、手敲 `xdotool`），最后靠 hotkey + type_text 纠回 | 成功，无弯路（`list_windows` → `get_window_state` → `run_steps`） |

数据来源：`~/.openmausbot/usage/2026-11.jsonl`（按 threadId 聚合）；本地轮 rollout 为 `~/.openmausbot/codex-local-home/sessions/2026/11/21/rollout-2026-11-21T21-53-17-*.jsonl`。

## 归因：两个乘数，相乘得到 87 倍

338 万 / 3.9 万 ≈ 87 倍。拆开看：

- **每步上下文 27 倍**（105,559 vs 3,892）。若本地模型只跑 32 步、但每步只有 3.9k，总消耗约 12.5 万。
- **步数 3.2 倍**（32 vs 10）。若本地模型保持 105k/步、但只跑 10 步，总消耗约 105 万。

两者相乘 ≈ 87 倍，与实测吻合。所以「338 万 = 上下文基线 × 步数效率」，两个因子都要治，但量级上**每步上下文是大头（约 96%）**。

## 每步 8.2 万基线是什么

同日 6 个会话首调用输入：80,920 / 81,037 / 81,070 / 82,188 / 82,375 / 82,481；其中一个只回答一句话、零工具调用的会话首输入也是 82,481。拆开：

- Codex CLI 自身系统提示 `base_instructions`：20,751 字符 ≈ 6.5k token
- SOUL（生效 1,840 字符）+ 记忆（约 11k 字符）≈ 4k token
- 剩下约 **70k token 是工具定义**（computer MCP + browser MCP 等全部 schema 原样展开）

Devin 同一个任务每步只有 3.9k，说明工具面本身不必这么贵——贵在「把全部 schema 逐字塞进每一轮请求」，不在「有这些工具」。

## 结论

1. **Codex 核心没问题**：路由、函数调用、纠错、任务完成都正常（终点截图证实 example.com 正文加载、原句读对）。
2. **8.2 万基线是产品配置问题，不是模型问题**：70k 的工具 schema 全量重发是放大器，而且它送的是「定义」不是「能力」，有压缩空间而不削弱能力（例如按需挂载/摘要化 schema、按场景裁剪工具面）。
3. **本地模型确实是第二因素**：同一任务 32 步 vs 10 步，且证据显示它在「工具是函数调用」与「工具是 shell 命令」之间分不清，把 `mcp__computer__get_window_state` 拼进 `exec_command`，还默认桌面在 macOS。这是可修的（工具以一等函数名暴露、环境事实前移、SOUL 约束），但换更小的模型只会更差——这一层不是参数量能换来的。

## 因此

- 改吞吐/成本：先压工具 schema 的每轮体积（保能力），收益约 20 倍量级。
- 改步数效率：把 MCP 工具以原生函数名暴露、并在首屏明确「容器桌面 vs 宿主 shell」，减少「拿 shell 试工具」的弯路。
- 换更小模型不是解药：步数因子会从 3.2 倍往 5~10 倍走。
