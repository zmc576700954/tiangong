# Codex SDK 流式能力实测（是否默认启用 `runStreamed()`）

- 实测时间：2026-11-04
- SDK：`@openai/codex-sdk@0.135.0`（原生二进制 `@openai/codex@0.135.0`，`codex-cli 0.135.0`）
- 结论先行：**环境可真实运行**（不是纯静态分析）；**有条件支持默认开启 `runStreamed()`**
- 证据：本文档 + `results/*.json`（原始事件、时序、进程采样）+ 可重跑脚本

---

## 0. 环境可用性（实测，非推断）

`00-env-check.sh` 原始输出摘要：

| 检查项 | 结果 |
|---|---|
| `which codex` | **not found**（PATH 里没有全局 CLI） |
| SDK 依赖包内原生二进制 | 存在，`node_modules/@openai/codex-darwin-arm64/.../bin/codex`，189MB，可执行 |
| `codex --version`（经 `@openai/codex/bin/codex.js`） | `codex-cli 0.135.0` |
| `OPENAI_API_KEY` / `CODEX_API_KEY` 环境变量 | 均 unset |
| `~/.codex/auth.json` | 存在，字段为 `OPENAI_API_KEY`（`auth_mode=ApiKey`） |
| `~/.codex/config.toml` | `model_provider=custom`，`model=MiniMax-M3.1-Flash-Preview`，`base_url=https://api.minimaxi.com/v1`，`wire_api=responses` |

**结论：可以真实运行**，但有两个必须记录的前提：

1. **本机 `~/.codex/config.toml` 在 0.135.0 上直接解析失败**（不是 SDK 问题，是 CLI 配置校验）：
   ```
   Error: ~/.codex/config.toml:3:26: unknown variant `max`,
   expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
   in `model_reasoning_effort`
   ```
   并且 CLI 的 `--config model_reasoning_effort="high"` **无法覆盖**这个解析错误（文件解析在覆盖之前）。
   实验改用临时 `CODEX_HOME=/tmp/codex-home`（复用 `auth.json` + 一份最小可用 `config.toml`），脚本见 [`00b-setup-codex-home.sh`](./00b-setup-codex-home.sh)。**未修改 `~/.codex`，未修改 `src/`。**

2. 实际模型是**第三方 provider（MiniMax）**，不是 OpenAI 官方模型。因此：
   - 事件类型集合可能与官方模型不同（本机未观测到 `reasoning` / `item.updated`）；
   - token 数、耗时只代表本机这条链路，不能当作 OpenAI 侧的绝对值。

---

## 1. API 真实性（`.d.ts` 原文 + 行号）

来源：[`node_modules/@openai/codex-sdk/dist/index.d.ts`](../../node_modules/@openai/codex-sdk/dist/index.d.ts)

| 项 | 行号 | 原始签名 |
|---|---|---|
| `runStreamed` | **206** | `runStreamed(input: Input, turnOptions?: TurnOptions): Promise<StreamedTurn>` |
| `run` | **209** | `run(input: Input, turnOptions?: TurnOptions): Promise<Turn>` |
| `TurnOptions.signal` | **167-172** | `type TurnOptions = { outputSchema?: unknown; /** AbortSignal to cancel the turn. */ signal?: AbortSignal; }` |
| `StreamedTurn.events` | **183-185** | `type StreamedTurn = { events: AsyncGenerator<ThreadEvent> }` |
| `ThreadEvent` 联合 | **165** | `thread.started \| turn.started \| turn.completed \| turn.failed \| item.started \| item.updated \| item.completed \| error` |
| `ThreadItem` 联合 | **104** | `AgentMessageItem \| ReasoningItem \| CommandExecutionItem \| FileChangeItem \| McpToolCallItem \| WebSearchItem \| TodoListItem \| ErrorItem` |
| `CommandExecutionItem` | **6-17** | `{ id, type:"command_execution", command: string, aggregated_output: string, exit_code?: number, status:"in_progress"\|"completed"\|"failed" }` |
| `FileChangeItem` | **28-35** | `{ id, type:"file_change", changes: {path, kind:"add"\|"delete"\|"update"}[], status }` |
| `TurnCompletedEvent.usage` | **131-134** | `{ type:"turn.completed", usage: Usage }` |
| `Usage` | **120-129** | `input_tokens / cached_input_tokens / output_tokens / reasoning_output_tokens` |
| `CodexOptions.env` | **228-232** | `env?: Record<string,string>`，注释明确：**一旦传入就不再继承 `process.env`** |

实现侧（[`dist/index.js`](../../node_modules/@openai/codex-sdk/dist/index.js)）：

- `runStreamed` 只是把内部 generator 包一层：`return { events: this.runStreamedInternal(...) }`（**L51-53**）
- **`run()` 是建立在同一个 generator 上的**：`const generator = this.runStreamedInternal(input, turnOptions)`，逐个消费后只收集 `item.completed` 与 `turn.completed`（**L95-118**）
- 进程只 spawn **一次**，argv 组装在 **L172-230**，`spawn(this.executablePath, commandArgs, { env, signal: args.signal })` 在 **L250-253**

→ 关键推断（有代码依据）：**流式与非流式是同一进程、同一 turn、同一份 usage，不存在"流式多跑一次"的重复计费。** 该推断在 §3 被运行数据再次确认（每次 run 只 spawn 1 个进程、只有 1 个 `turn.completed`）。

---

## 2. 流式 item 粒度（真实运行）

任务：`创建 stream-probe.txt 并读回内容`。脚本 [`01-streamed.mjs`](./01-streamed.mjs)，原始数据 `results/01-streamed.json`。

事件序列（第二次运行，单位 ms，相对进程启动）：

```
[+ 105] thread.started
[+ 135] turn.started
[+1424] item.completed / agent_message
[+1719] item.started   / command_execution   status=in_progress
[+1719] item.completed / command_execution   status=completed exit_code=0
[+3551] item.completed / agent_message
[+3743] turn.completed  usage={input 21220, cached 10731, output 106, reasoning 0}
```

- 总条数 **7**；类型分布：`thread.started 1 / turn.started 1 / item.started 1 / item.completed 3 / turn.completed 1`
- 事件间隔（相邻）：`30, 1289, 295, 0, 1832, 192` ms —— **粒度是"按 item"，不是按 token**；最大的两段空档来自等模型
- `item.updated` **0 次**；`reasoning` item **0 次**（本机 provider 下）
- 同一条命令的 `item.started` 与 `item.completed` **时间戳相同（1719ms）**：说明 **stdout 不是增量推送**，`aggregated_output` 只在完成时一次性给出
- `command_execution` 携带的信息：
  ```json
  {"id":"item_1","status":"completed",
   "command":"/bin/zsh -lc \"printf 'hello-codex\\n' > stream-probe.txt && cat stream-probe.txt\"",
   "aggregated_output":"hello-codex\n","exit_code":0}
  ```
  → 有**完整命令行字符串**（含 `/bin/zsh -lc` 包装），但**没有 argv 数组、没有 cwd、没有起止时间/耗时**
- `file_change`：本条任务模型用 shell 重定向，**未触发**（0 次）。补做了 [`01b-filechange.mjs`](./01b-filechange.mjs)（强制走 `apply_patch`），11 个事件中出现 2 次 `file_change`：
  ```json
  {"id":"item_1","type":"file_change","status":"completed",
   "changes":[{"path":".../work/filechange/patch-probe.txt","kind":"add"}]}
  ```
  → **只有 path + kind，没有 diff/hunk 内容**（`.d.ts` L28-35 亦如此）。要展示改动内容必须自己再读文件或另存 patch。
- usage：**有**，只在 `turn.completed` 一次性出现。

---

## 3. 非流式对照（同任务，同配置）

脚本 [`02-blocking.mjs`](./02-blocking.mjs)，数据 `results/02-blocking.json`。

| 维度 | `runStreamed()` | `run()`（阻塞） |
|---|---|---|
| 事件/条目数 | 7 个事件 | 3 个 item（只保留 `item.completed`） |
| 是否看到 `in_progress` | 是（`item.started`） | **否**（被丢弃） |
| `command_execution` 字段 | id/command/aggregated_output/exit_code/status | 完全相同（字段一致） |
| `usage` | 21220 / 10731 / 106 / 0 | 21214 / 10735 / 109 / 0 |
| `finalResponse` | 需自己从最后一条 `agent_message` 取 | 直接给（最后一条 agent_message 文本） |
| 进程 spawn 次数 | 1 | 1 |
| 总耗时 | 13811ms（迭代器 13752ms） | 12499ms |

结论：
- **不丢字段**：阻塞版返回的 item 与流式版 `item.completed` 的字段集合完全一致（`itemFieldAudit` 可见：`agent_message: [id,text,type]`、`command_execution: [aggregated_output,command,exit_code,id,status,type]`）。
- **丢的是过程**：`item.started`（in_progress 状态、命令开始时刻）在阻塞版里不可见。
- **不重复计费**：每次调用只 spawn 1 个 codex 进程、只产生 1 个 `turn.completed`，usage 量级一致（输入 21220 vs 21214，差异属正常缓存命中波动）。

---

## 4. 取消行为（`TurnOptions.signal`）

脚本 [`03-abort.mjs`](./03-abort.mjs)，数据 `results/03-abort-r1..r4.json`。任务：`sleep 30`，6s 后 `controller.abort()`。

| 指标 | r1 | r2 | r3 | r4 |
|---|---|---|---|---|
| abort → 迭代器抛错 | **3ms** | 4ms | 3ms | 4ms |
| abort → codex 主进程消失 | **80ms** | 133ms | 79ms | 106ms |
| abort → 全部相关进程消失 | **25212ms** | 25900ms | 25901ms | 25685ms |
| abort 前已收到事件 | 4 | 4 | 4 | 4 |
| abort 后新增事件 | **0** | 0 | 0 | 0 |
| 未闭合的 item | `item_1` | `item_1` | `item_1` | `item_1` |

关键发现：

1. **抛错类型**：`AbortError: The operation was aborted`（`code: ABORT_ERR`），3-4ms 内到达。
2. **没有"中断标记"事件**：流里不会出现 `turn.failed` 或 `error`，也不会有任何显式 `aborted` 字段。中断信号只能由调用方推断（拿到 AbortError + 最后一个 item 只有 `item.started` 没有 `item.completed`）。
3. **中断时已产生的事件能保住**：4 条事件（`thread.started`、`turn.started`、1 条 `agent_message`、`item.started/command_execution`）均可读到，但该命令永远停在 `in_progress`。
4. **孙子进程不会被回收**：4 次运行全部在 abort 后观察到 `sleep 30` 变成孤儿（`ppid=1`），直到自然结束才消失（≈25s）。SDK 只对直接子进程做 `spawn(..., {signal})`，**不暴露 PID、也不杀进程组**。另 1 次补充运行（`results/03-abort.json`）未观测到残留（82ms 全清），说明这是**有竞态、非确定**的行为——最坏情况下会留下正在执行的命令。
5. 迭代器抛错 ≠ 进程退出：抛错 3ms，主进程回收 ~80-133ms。

---

## 5. 附加发现：流结束后的收尾开销（影响"完成"判定）

`01` 中 `turn.completed` 出现在 3743ms，但 **迭代器直到 13752ms 才结束**（空档 **10009ms**）。用原生 CLI 直接复测（[`04-cli-overhead.mjs`](./04-cli-overhead.mjs)，`results/04-cli-overhead.json`）：

```
lastEventToExitMs: 10015   (最后一行 JSONL → 进程 exit，code=0)
```

→ 这 **~10s 是 codex CLI 自身的关机开销**，不是 SDK 或本次脚本引入的；`run()` 阻塞模式同样要等这 10s（`02` 总耗时 12499ms ≈ 业务 2.5s + 10s）。

对编排器的含义：**"这一 turn 完成"必须以 `turn.completed` 事件为准，不能以迭代器结束/进程退出为准**，否则 UI 会凭空多等 10s。

---

## 6. 建议：是否默认启用 `runStreamed()`

**有条件支持（建议默认开启）**。

支持理由（均为本次实测）：
1. 信息量严格 **≥** 阻塞式（多出 `item.started` / `in_progress`，字段集合一致）。
2. **没有额外成本**：同一进程、同一 turn、同一份 usage（源码 L95-118 + 运行期只 spawn 1 次）。
3. 取消可用：`AbortError` 3-4ms 返回，主进程 ~80-133ms 回收，中断前事件可保留。
4. 是"上游"接口：`run()` 本身就是它的消费者，默认走流式不会引入新代码路径风险。

必须同时满足的条件（缺一不可）：

| # | 条件 | 依据 |
|---|---|---|
| C1 | **完成判定用 `turn.completed`**，不要等 `for await` 结束（迭代器会额外阻塞 ~10s） | §5 |
| C2 | **中断后必须把只有 `item.started` 没有 `item.completed` 的 item 标记为 `aborted/unknown`**，并入 `stepOutcomes` 对账；不要假设拿到 AbortError 就有终态事件 | §4.2 / §4.3 |
| C3 | **中断要自己兜底杀进程组**：SDK 不暴露 PID，实测会留下 `ppid=1` 的孤儿命令；桌面端需自行记录子进程/用进程组或容器化执行，至少在 UI 上标注"可能有残留进程" | §4.4 |
| C4 | **不要向 UI 承诺 token 级打字机效果**：本机 0 次 `item.updated`，`aggregated_output` 只在完成时一次性到达；粒度是 item | §2 |
| C5 | **对未知事件类型容错**：底层 flag 是 `--experimental-json`，schema 属实验性质；遇到未识别的 `type` 应跳过而非抛错 | `.d.ts` L165 + 源码 L172 |
| C6 | **启动前校验 `CODEX_HOME` 配置可解析**：本机 `~/.codex/config.toml` 直接让 CLI exit 1，且 CLI 级 `--config` 覆盖无效；桌面端应把这类 stderr 原样透出，而不是当成"模型失败" | §0 |
| C7 | 若产品需要 `file_change` 的 diff 展示，**另行实现**（SDK 只给 path + kind） | §2 |

不建议的做法：
- 用迭代器结束作为 turn 完成信号（会多等 ~10s，见 C1）。
- 中断后立刻认为子命令已停止（实测 4/5 次残留孤儿，见 C3）。
- 依赖 `reasoning` / `item.updated` 做实时思考展示（本机 provider 下完全缺失，见 §2 与 §0 的 provider 说明）。

---

## 复现方式

```bash
cd /Users/zhumingchen/tiangong

bash spikes/codex-stream/00-env-check.sh          # 环境探测（只读）
bash spikes/codex-stream/00b-setup-codex-home.sh  # 准备 /tmp/codex-home（不动 ~/.codex）

node spikes/codex-stream/01-streamed.mjs          # 流式事件粒度 / 时序
node spikes/codex-stream/01b-filechange.mjs       # file_change 是否带 diff
node spikes/codex-stream/02-blocking.mjs          # 非流式对照
node spikes/codex-stream/03-abort.mjs r1          # 取消行为（可跑 r1..r4）
node spikes/codex-stream/04-cli-overhead.mjs      # CLI 关机开销
```

产物：`spikes/codex-stream/results/*.json`（原始事件与采样）、`spikes/codex-stream/work/*`（任务副作用目录）。

> 说明：`work/` 与 `results/` 为实验产物，可随时删除重跑；未改动 `src/`，未改动 `~/.codex`，未动 git 历史。
