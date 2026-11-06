# Agent Core Spike：可机械判定的核心机制验证

本目录是独立可运行的 spike，用真实测试验证两份 Agent 设计文档中**可机械判定**的假设。
**未修改 `src/` 下任何代码，也未改动根 `node_modules/` 或 git 历史。**

- 旧文档：`docs/architecture/agent-system-design.md`
- 新文档：`AGENT_ARCHITECTURE_DESIGN.md`（命名与语义以新文档为准，冲突见下文）

## 结论速览

| 假设 | 结论 | 关键依据 |
| --- | --- | --- |
| V1 事件归一化 | **通过（有前提）** | Claude/Codex/OpenCode 三组夹具产出同一 checkpoint 序列，seq 连续；但 OpenCode 依赖 stdout 里存在工具轨迹，无轨迹时只保住最小契约 |
| V2 崩溃恢复对账 | **通过** | 真实 `SIGKILL` 子进程；三种写入窗口都给出确定 `RecoveryPlan`，清扫后无悬空 running |
| V4 并发不串台 | **通过** | 第二个并发 turn 立即 `SESSION_BUSY`；同调用链重入不死锁；同节点第二个非终态 run 被 `NODE_BUSY` 拒绝；事件归属零错误 |
| 锁开销 | **通过** | 1000 次加锁/释放 × 3 轮，均值 0.0032–0.0047 ms，P99 0.0127–0.0298 ms，远低于 5 ms 门槛 |
| V6 循环归属 | **通过** | backend-owned 与 host-owned（Kernel 执行工具并回填 `tool.result`）产出同一语义事件序列；混跑时状态按 runId 隔离，不互相卡住 |
| V7 fail-closed 审批 | **通过** | 重复决定幂等、超时默认拒绝、迟到 allow 不执行、重启后未决审批可重放且不自动批准；决定与事件同事务落库 |

基线测试：**6 个测试文件 / 24 个测试全部通过**（约 0.3 s）。

## 采用的命名口径

**最终采用 `AGENT_ARCHITECTURE_DESIGN.md` 的命名**，并按补充要求做了两处明确取舍：

1. 基本单位用 **`run`**，`AgentEventEnvelope.runId`；一次 `submit()` 建模为一个 run/turn。
2. 事件保真度用 **`token | turn | session`**，不用 `exact/derived/coarse`。
   - Claude → `token`，Codex → `turn`，OpenCode → `session`。
   - 事件是否由宿主合成，另用 `source: backend | kernel | synthetic` 表达，避免把“粒度”和“真伪”混成一个字段。
3. 信封类型名 **`AgentEventEnvelope`**；执行器包装 **`BackendDriver`**（[backend-driver.ts](src/loop/backend-driver.ts)）；能力声明 **`BackendCapabilities`**（[capabilities.ts](src/loop/capabilities.ts)）。

### 必要的字段扩展（已在代码注释标注）

- 新文档 §2.2 的 `AgentEventEnvelope` 示例**没有事件类型字段**。没有 `type` 无法落库、恢复与断言，spike 显式补 `type: AgentEventType`。
- 新文档 §2.2 信封不含 `sessionId/nodeId`；这些落在 `agent_runs` 上，spike 遵守新文档。
- `agent_steps` 是新文档没有显式列出的补表：spike 用它承载“哪些 step 已完成/未知/转人工”。新论文本语义是 steps 可由 event sourcing 重建，此表仅作为恢复判定缓存。

## 怎么跑

```bash
cd /Users/zhumingchen/tiangong

# 基线（应全绿）
npx vitest run --config spikes/agent-core/vitest.config.ts

# 或者
npm --prefix spikes/agent-core test

# 故破坏断言：每次注入一种 bug，确认套件变红
bash spikes/agent-core/scripts/sabotage.sh
```

单文件示例：

```bash
npx vitest run --config spikes/agent-core/vitest.config.ts tests/v2-recovery.test.ts
```

### 依赖说明

根目录的 `better-sqlite3` 是按 Electron ABI 编译的，Node 20 直接 `require` 会 ABI 不匹配；
Node 20 也没有 `node:sqlite`。因此本 spike 在 `spikes/agent-core/node_modules` 内安装了**同版本**
`better-sqlite3` 的 Node ABI 副本，**没有触碰根 `node_modules`**，也没有新增其他重型依赖。
测试运行器复用根目录的 vitest；`vitest.config.ts` 只把 `better-sqlite3` 外部化，避免 Vite 打包原生模块。

## 目录

```text
spikes/agent-core/
├── fixtures/                    # Claude JSONL / Codex 单结果 / OpenCode one-shot
├── src/
│   ├── types.ts                 # AgentEventEnvelope、BackendCapabilities、RecoveryPlan
│   ├── normalizer/              # 三个 BackendDriver 的归一化实现 + EventSink
│   ├── loop/                    # BackendDriver、能力矩阵、host-owned 循环、ToolRuntime、RunEngine
│   ├── db/                      # schema.sql、RunRepository、seq 连续性校验
│   ├── recovery/                # SIGKILL 子进程、清扫、RecoveryPlan
│   ├── concurrency/             # per-run 锁、SessionExecutor
│   └── approval/                # fail-closed ApprovalGateway
├── tests/                       # V1/V2/V4/V6/V7 + 锁开销
└── scripts/sabotage.sh          # 注入 mutation，确认测试会红
```

## 各假设的实测细节

### V1 事件归一化

三组夹具都包含“一段助手文本 + 一次工具调用 + 终态”，归一化后的 checkpoint 序列均为：

```text
run.started → message.completed → tool.requested → tool.result → run.completed
```

- Claude 事件数 8（含 2 个 `message.delta`、1 个 `usage.updated`），seq 1–8 连续。
- Codex 事件数 6，seq 1–6 连续；`run.started` 与 `tool.*` 标记为 `synthetic`。
- OpenCode 事件数 7，seq 1–7 连续；`tool.*` 从 stdout 轨迹推导，标记为 `synthetic`。
- fidelity 分别为 `token / turn / session`，全部事件归属（runId/turnId/backend.name）100% 正确。
- **前提**：OpenCode one-shot 只有在 stdout 里包含 `[tool]` / `[tool-result]` 轨迹时才能合成工具检查点。
  用 `fixtures/opencode/no-tools.txt` 验证了降级路径：只剩
  `run.started → message.completed → run.completed`，不会伪造 tool 事件。
  因此若真实 OpenCode CLI 不输出工具轨迹，V1 对第三种后端只能算**部分通过**。

### V2 崩溃恢复对账

崩溃不是“关库模拟”，而是子进程写入持久化现场后对自己 `SIGKILL`（WAL + `synchronous=FULL`）。
重启后 `sweepInterrupted()` 把 `created/running/awaiting_approval/cancelling` 一律收敛为 `interrupted`，
`step requested/running/approved` 一律转 `unknown`，待审批项保留；`assertNoDangling()` 验证不存在悬空 running。

三种窗口的 `RecoveryPlan`：

| 场景 | step 判定 | strategy | 说明 |
| --- | --- | --- | --- |
| 审批通过但写未落地（指定必测窗口） | `unknown-needs-rerun` | `replay` | 审批 `allow` 不等于副作用已执行；磁盘仍是旧内容 |
| 写落地且 `afterHash` 与磁盘一致 | `completed` | `resume-native` | 有 backend session id，可优先 native resume |
| 写后记录 hash 与磁盘不一致 | `needs-human` | `abandon` | 无法判定实际写入，转人工，不静默重跑 |

同一 `RecoveryPlan` 连续调用两次深度相等（确定性）；事件日志断号写入会抛 `EVENT_LOG_CORRUPT`。

### V4 并发不串台

- 同一 run 已有 turn 执行时，第二个 turn 立即抛 `SESSION_BUSY`，不排队。
- 同一异步调用链内二次加锁通过 `AsyncLocalStorage` 复用外层锁，实测无死锁。
- 同一 node 第二个非终态 run 被部分唯一索引拒绝（`NODE_BUSY`）；第一个完成后可再建。
- 两个 run 并发产生事件，持久化后每个 run 只含自己的 runId/turnId，零串台。

### 锁开销

1000 次 `submit`（加锁/释放）× 3 轮，每轮独立实例：

| 轮次 | 均值 | P50 | P99 | 总耗时 |
| --- | --- | --- | --- | --- |
| 1 | 0.0047 ms | 0.0025 ms | 0.0298 ms | 4.90 ms |
| 2 | 0.0036 ms | 0.0027 ms | 0.0127 ms | 3.73 ms |
| 3 | 0.0032 ms | 0.0027 ms | 0.0221 ms | 3.22 ms |

这是**纯进程内锁**的开销，不包含 SQLite 写入、Electron IPC 与调度成本；结论只适用于“锁本身不是主进程瓶颈”。

### V6 循环归属

- backend-owned（Claude 归一化事件）与 host-owned（Kernel 解析 `<tool_call>`、`ToolRuntime` 执行、
  回填 `tool.result`、再产出最终文本）都产出
  `run.started → message.completed → tool.requested → tool.result → run.completed`。
- host-owned 的 tool 事件 `source=kernel`；工具结果确实进入后续文本生成。
- 同一 `RunEngine` 内两个 runId 的状态互相隔离：host-owned 停在 `awaiting_approval` 时，
  backend-owned 仍保持 `completed`；放行后 host-owned 依次经过
  `created → running → awaiting_approval → running → completed`，没有“卡在同一个状态”。

### V7 fail-closed 审批

- **重复决定**：先 `allow` 并执行一次；再 `deny` 返回首次 `allow`（`idempotent=true`），不覆盖、
  不新增事件、不重复执行；`tool.approved` 恰 1 条、`tool.denied` 0 条。
- **超时**：30 ms 后自动 `deny`（`resolvedBy=timeout`）；迟到的 `allow` 返回 `deny` 且不执行；
  `tool.denied` 1 条、`tool.approved` 0 条。
- **拒绝后执行**：`deny` 下 execute 调用次数为 0。
- **重启重放**：重开 DB 后 `replayPending()` 仍返回未决审批，不自动批准；用户随后 `allow`
  时 DB 决定与 `tool.approved` 事件同时存在（同事务），不存在“已批准但未记录”。
- **重启时已过期**：迟到的 `allow` 按 `deny` 处理，不执行，留 `tool.denied` 痕迹。

## 测试真的会红吗？——故障注入结果

`scripts/sabotage.sh` 对同一套断言注入 bug，全部按预期变红（`exit=1`）：

| mutation | 破坏了什么 | 实际变红的测试 |
| --- | --- | --- |
| `seq-gap` | sink 在第 2 个事件后跳号 | 3 failed：V1 三后端序列、V1 OpenCode 降级、V4 归属 |
| `drop-tool-events` | sink 丢弃 tool.requested/result | 3 failed：V1 序列、V1 来源标注、V6 序列对齐 |
| `no-orphan-sweep` | 重启不收敛 running | 3 failed：V2 三个崩溃场景 |
| `optimistic-recovery` | 无证据也把 step 标 completed | 1 failed：V2 “审批通过但写未落地” |
| `no-lock` | 锁变成无操作 | 1 failed：V4 第二个并发 turn 应 `SESSION_BUSY` |
| `no-reentry` | 去掉 AsyncLocalStorage 重入识别 | 1 failed：V4 同调用链二次加锁 |
| `no-unique-index` | 删除节点部分唯一索引 | 1 failed：V4 第二个非终态 run 应 `NODE_BUSY` |
| `slow-lock` | 每次加锁人为延迟 6 ms | 1 failed：锁开销 P99 < 5 ms |
| `approval-overwrite` | 重复决定覆盖首次结果 | 2 failed：V7 幂等、V7 超时迟到决定 |
| `approval-always-allow` | 超时/过期时仍判 allow | 2 failed：V7 超时、V7 重启已过期 |

原始日志保留在 `spikes/agent-core/.artifacts/sabotage/`（可用脚本重新生成）。

## 两份文档的命名与语义冲突清单

| # | 冲突点 | 旧文档 | 新文档 | spike 实际实现与理由 |
| --- | --- | --- | --- | --- |
| 1 | 基本单位 | turn（`agent_turns`） | run（`agent_runs`，turn 在 run 内） | **按新文档用 run**；一次 submit = 一个 run，事件用 runId 归属 |
| 2 | 事件保真度词汇 | `exact/aggregate/synthesized/opaque`（表达能力/真伪） | §2.2 信封写 `exact/derived/coarse`，§3.1 能力位写 `token/turn/session`；**新文档内部即冲突** | 按补充指令统一用 **`token/turn/session`**，另加 `source` 表达 backend/kernel/synthetic |
| 3 | 信封字段 | `NormalizedEvent` 带 sessionId/nodeId/origin/ordering | `AgentEventEnvelope` 只有 runId/turnId/backend，且**漏了事件类型字段** | 采用新信封；补 `type`；session/node 放 `agent_runs` |
| 4 | 恢复承诺 | “从最后一条已持久化事件恢复”，unknown 重新执行 | 目标写“恢复到任意步骤”，但 §6.2 明确只能到“最后一条已持久化事件”，UI 不得宣称精确恢复 | **按“最后一条已持久化事件”实现**；spike 无法证明节点级精确恢复，新文档“任意步骤”措辞应删改 |
| 5 | 同 run 并发 | `SESSION_BUSY` fail-fast，queueDepth=1，不自动排队 | §7.1 第二个 turn 排队、不交错 | **按旧文档测 fail-fast**；新文档排队语义未验证，两者都可实现，需产品明确选择 |
| 6 | 节点唯一约束 | “一个节点最多一个非终态 turn”，DB 层强制 | 未明确写出该约束 | spike 增加 `ux_agent_runs_active_node` 部分唯一索引并验证 `NODE_BUSY`；建议新文档补上，否则并发防串台少一层保障 |
| 7 | 重启时未决审批 | 置 `expired`，需重新审批 | 保留待审批项并重新推送 renderer，不丢失 | **按新文档实现**：重启不清 pending，`replayPending()` 重放，但未决定前禁止执行 |
| 8 | 审批超时语义 | 超时=过期，要求重新审批 | fail-closed 默认拒绝 | 按新文档 `deny + resolvedBy=timeout`；迟到决定不改变结果 |
| 9 | 状态与事件命名 | `queued/waiting_approval`、`tool.completed` | `created/awaiting_approval/interrupted`、`tool.result` | 全部采用新文档命名 |
| 10 | 工具循环归属 | 适配器统一跑工具循环，未区分 | 区分 `backend`（Claude/Codex）与 `host`（OpenCode/CLI） | 按新文档实现；V6 证明 host-owned 能产出同一语义序列 |
| 11 | step 持久化 | 有 `agent_steps` 表 | 由 event sourcing 重建，未列 step 表 | spike 保留 `agent_steps` 作为恢复判定缓存；若采纳新文档，应明确“可由事件重建”或补表 |
| 12 | 锁粒度/错误码 | per-session，`SESSION_BUSY` | per-run，SessionExecutor 排队，无 busy 错误 | 锁实际按 runId；错误码保留 `SESSION_BUSY` 以对齐任务断言，文档需统一叫法 |

## 这些结论对设计文档意味着什么

### 对旧文档 `docs/architecture/agent-system-design.md`

1. **§12.1 V1 判据可以保留，但不能对 OpenCode 承诺工具检查点**。验证表明只有 stdout 带工具轨迹才
   能合成 `tool.requested/tool.result`；否则只能保证
   `turn.started → message.completed → turn.completed`。建议在 V1 判据里增加“可观测性降级”条款。
2. **§4.4 恢复表缺少“审批已通过但写未开始/未落地”这一格**。这是最危险窗口：spike 证明必须映射为
   `unknown-needs-rerun`，绝不能因审批 `allow` 就标 `completed`。建议把该行显式写入恢复矩阵。
3. **`RecoveryPlan` 需要 step 级处置结果**。旧文档只给策略与 `requiresUserConfirmation`，无法机械回答
   “哪些 step 完成、哪些未知、哪些转人工”。spike 扩展了 `stepOutcomes`，建议纳入正式契约。
4. **§12 V4 与 §7.1 重入方案可行**。fail-fast + AsyncLocalStorage 重入识别通过实测；节点唯一约束必须
   落在 DB 部分唯一索引，不能只靠内存检查。
5. **V8 的“锁不成为主进程瓶颈”成立**。进程内锁 P99 约 0.03 ms；但该数字不覆盖 SQLite 写入与 IPC，
   文档不应把整体调度开销也用这个结论背书。

### 对新文档 `AGENT_ARCHITECTURE_DESIGN.md`

1. **§2.2 与 §3.1 的 fidelity 词汇必须统一**。同一份文档里 `exact/derived/coarse` 与
   `token/turn/session` 不能同时作为事件保真度；spike 采用后者。建议信封也改为
   `fidelity: token|turn|session`，并由 `source` 表示合成/内核/后端来源。
2. **§2.2 信封需要补 `type` 字段**，否则无法落库、去重与恢复。另建议明确 `sessionId/nodeId`
   只存在于 run 表，事件通过 runId 关联。
3. **§6.2 的“恢复到任意步骤”应删除或降级**。spike 只能证明“最后一条已持久化事件”边界；
   节点级精确恢复依赖后端 checkpoint，当前不可验证。UI 文案应严格按文档自己的边界承诺。
4. **§7.1 需要明确“排队还是 fail-fast”**。旧文档的 `SESSION_BUSY` 与新文档的自动排队是互斥语义；
   spike 证明 fail-fast 可用，但排队版本未测。若采用排队，需要补队列持久化、重放与超时设计。
5. **§5.2 fail-closed 审批链可行**：重复决定幂等、超时拒绝、重启重放、决定/事件同事务均已通过。
   建议把“决定与事件必须同事务”写成强制不变量，而不是实现建议。
6. **host-owned 循环可行但只验证了 mock 链路**。`<tool_call>` 文本协议 + 白名单 + Kernel 执行 +
   `tool.result` 回填可以产出与 backend-owned 相同的语义序列；真实 CLI 的轨迹输出与审批时机仍需实测。

## 限制（不要把 spike 结论外推过头）

- 三种后端均为夹具/脚本，未真正 spawn Claude/Codex/OpenCode；真实 SDK 的异常、流式碎片、CLI 输出未覆盖。
- 崩溃测试杀的是 SQLite 写入子进程，不是真实 Electron 主进程；验证的是“已提交事件 + 重启重建”，
  不是完整桌面进程生命周期。
- 并发锁是进程内锁；未验证多窗口/多进程、Electron IPC 竞态。
- 审批超时用 30 ms 真定时器验证逻辑，未测 60 s 生产值与 renderer 推送链路。
- 未测量 SQLite 写入吞吐、事件表增长、快照体积。
