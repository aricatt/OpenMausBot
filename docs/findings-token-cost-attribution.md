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

## 续：同基座模型、两套 harness（MiMo 2.6 对照）

第一轮对照混着两个变量（模型 + harness）。为把 harness 单独拎出来，把基座模型固定成 `mimo-v2.6-pro`：

- `codexMimo`：`driver: codex`，`config.endpoint = {url: https://token-plan-cn.xiaomimimo.com/v1, models: [mimo-v2.6-pro]}`（该网关原生支持 Responses API）。
- `claude` 实例 + `mimo-v2.6-pro`：`claudeAgent` driver（Anthropic 兼容端点 `https://token-plan-cn.xiaomimimo.com/anthropic`）。

同一个 bot 配置（同 SOUL、`computer: vm`、`browser: true`、`approvalMode: full`），同一句任务，目标换成本网络可达的站点：

> 把当前 Firefox 的地址栏导航到 https://www.baidu.com，确认页面真的加载后，报告窗口标题，以及百度热搜里第一条热搜的标题。做完就停。

| | codex + MiMo 2.6 | claudeAgent + MiMo 2.6 |
|---|---|---|
| 步数 | 11 | 8 |
| 工具调用 | 10 | 7 |
| 输入 token | 1,215,915 | 193,815 |
| 每步输入 | ~110.5k | ~24.2k |
| 输出 token | 3,189 | 9,058 |
| 结果 | 成功（标题 + 首条热搜正确） | 成功（并额外指出置顶条与排名第 1 的区别） |

同一基座模型、同一任务、同一工具面，**codex 路径每步上下文是 claudeAgent 的 4.5 倍左右，总 token 6.3 倍**。工具集没变，差别在注入方式：codex 把 MCP 工具 schema 全量塞进每个 turn，claudeAgent 走的是更紧凑的工具面。

### 三组数据放在一起（注意任务页不同，仅同一类任务）

| 组合 | 步数 | 输入 token | 每步输入 |
|---|---|---|---|
| codex + Qwen3.8-Flash（example.com） | 32 | 3,377,900 | ~105.6k |
| codex + MiMo 2.6（baidu） | 11 | 1,215,915 | ~110.5k |
| claudeAgent + MiMo 2.6（baidu） | 8 | 193,815 | ~24.2k |
| devinAgent + swe-2-high（example.com） | 10 | 38,920 | ~3.9k |

- **模型维度（同 codex harness）**：Qwen 32 步/338 万 → MiMo 11 步/122 万，步数 2.9 倍差、token 2.8 倍差。本地模型确实弱一档，这一项是模型问题。
- **harness 维度（同 MiMo）**：110.5k/步 → 24.2k/步，6.3 倍差。这一项与模型无关，是注入方式问题。

### 附带发现

codex 的 endpoint 模式默认会带 `web_search` 工具声明，MiMo 网关直接回 `responses_feature_not_supported: tool type 'web_search' is not supported`，导致整个 bot 起不了。已在 `server/drivers/codex-endpoint-config.ts` 的 `endpointCodexArgs` 加 `web_search="disabled"`（与 `codex-background-text.ts` 的既有做法一致）。

## 差异的来源：零工具探针

同一 bot、同一 `mimo-v2.6-pro`、同一个问句「不要调用任何工具，只用一行回答：1+1 等于几？」：

| | 首调用输入 token |
|---|---|
| codex harness | 104,925 |
| claudeAgent harness | 17,429 |

两者 SOUL、记忆、MCP 工具集完全相同。codex 自身系统提示 6.5k、SOUL 0.6k、记忆约 3~4k，剩下约 **90k 量级都在工具定义上**——codex 把 MCP 工具 schema 随每个 turn 全量发送；claudeAgent 的 activity 里能看到 `ToolSearch` 这一前置动作，说明它是按需发现工具，请求里只带一个小的工具索引。

所以 110.5k/步 vs 24.2k/步 的 6.3 倍差，不是模型差，是**每轮请求里工具说明书的厚度差**。

## 按工具面拆账（codex + MiMo，零工具探针）

同一 bot、同一句「1+1 等于几，不要用工具」，只改挂载的工具面：

| 挂载 | 首调用输入 |
|---|---|
| `computer: vm` + `browser: true`（现状） | 104,925 |
| `computer: vm` + `browser: false` | 104,198 |
| `computer: off` + `browser: false` | 38,369 |
| `computer: off` + `browser: true` | 38,411 |

拆出来：

- **computer MCP 工具定义 ≈ 66k token（占现状 63%）** ——真正的账在这儿。
- browser MCP ≈ 0.7k，几乎不占。
- 剩下的 38k：codex 自身提示 6.5k + SOUL 0.6k + 记忆，再加 OMB 固定注入（技能目录、三个小 MCP：textstat/time/calc 等）。

真实任务上摘掉 browser（`computer: vm`、`browser: false`）跑百度那条：

| | browser on | browser off |
|---|---|---|
| 步数 | 11 | 7 |
| 输入 token | 1,215,915 | 758,313 |
| 结果 | 正确 | 正确（标题 + 首条热搜一致） |

省 38%，且能力没丢——动作全靠 computer MCP 的 `list_windows` / `get_window_state` / `run_steps`。步数也从 11 降到 7，说明一部分省下来的不是工具面，而是少走的弯路（有离群方差，单次样本）。

## 三类任务对照：同一模型 MiMo 2.6，两套 harness

同一 bot 配置、同一模型、同一句指令，只换 harness；每个任务跑前重置工作目录。质量由人工核对（测试是否真的过、改动是否真到位、引用是否真在原文里）。

| 任务 | codex 步数 / 输入 | claudeAgent 步数 / 输入 | 质量 |
|---|---|---|---|
| 桌面动作（百度标题 + 首条热搜） | 11 / 1,215,915 | 8 / 193,815 | 两边都对；claude 额外区分了置顶条与排名第 1 |
| 代码修复（修正 `clip` 的钳位顺序，跑通测试） | 4 / 425,171 | 7 / 94,195 | 两边都改对同一处，测试真实 PASS |
| 文档汇总（4 个 md → 3 条行动项 + 出处） | 4 / 426,985 | 6 / 56,592 | 两边都正确引用；claude 的排序理由与"为什么不是别的"更完整 |
| **合计** | **2,067,000** | **344,600** | 质量 3/3 持平 |

- 同模型、同任务、质量持平的前提下，claudeAgent **约 6 倍省**。
- 步数上 codex 反而更少（代码/文档任务是 4 步 vs 7/6 步）——它一次 shell 就能把活干完；贵在每步 105k，不在走得多。
- 这一组是单次样本，代码任务是单行修复，不能外推成"所有代码工程任务"的结论。

结论：**默认走 claudeAgent 更划算；codex 仍适合它原生的重度 shell/仓库改造场景，但需要接受每步 ~105k 的固定开销。**

## 升级记录：claude CLI 2.1.312 → 2.1.330

- 升级命令：`/opt/homebrew/bin/npm install -g --prefix /opt/homebrew @anthropic-ai/claude-code@2.1.330`
- 备份：`/tmp/omb/claude-code-2.1.312.bak`（回滚：`npm install -g --prefix /opt/homebrew @anthropic-ai/claude-code@2.1.312`）
- 注意：PATH 上的 `npm` 是豆包沙箱那份（prefix 在 sandbox_runtime），必须先指定 `--prefix /opt/homebrew`，否则升的不是 OMB 用的那个二进制。

升级后冒烟：

| 检查 | 2.1.312 | 2.1.330 |
|---|---|---|
| 零工具首调用输入 | 17,429 | 18,001（+3%） |
| 动作任务是否仍先 `ToolSearch` | 是 | 是（2 次） |
| 动作任务结果 | 正确 | 正确（并区分置顶条与排名第 1） |

动作任务 token 这次是 341,047/10 步（上次 193,815/8 步），但本轮多了 hotkey/type_text/press_key 三步、页面上热搜也换了，属单次样本波动，不能当回归信号；要判断得再跑 2~3 次。
