# Agent 体系 M0（D1–D5）施工报告

- 施工日期：2026-11-04
- 权威口径：`docs/architecture/agent-architecture.md`（冲突时以此为准）、`agent-rollout.md`、`agent-decisions.md`
- 基线参考：`spikes/agent-core/`、`spikes/codex-stream/`（未修改任何 spike 断言）
- 工作区状态：改动全部保留在原处，**未执行 `git commit`、未改 git 配置**

## 0. 结论速览

| 交付项 | 状态 | 说明 |
|---|---|---|
| D1 表结构 + 迁移 + 仓储层 | 完成 | 9 张表、schema v20（新增 `executor_started_at` / `executor_cmd` / `residual_risk` 归属证据链与 step 复合唯一键）、任务要求的扩展列与 `ux_turns_active` 部分唯一索引均有实测用例 |
| D2 per-session 串行锁 | 完成 | 显式 `LockContext` 传参、`tryAcquire`/`acquire` 语义拆分、防重入；锁 owner 改为每次派发唯一 id；同节点并发映射为 `NODE_BUSY` |
| D3 Driver + 归一化 + 双写 | 完成（后端侧） | Claude/Codex/OpenCode 三套 normalizer + `AdapterBackendDriver`；旧 `AgentOutput` 路径未改语义；长尾仅声明 `toolEvents:none`，未写 parser |
| D4 审批通道 | 完成 | 主进程网关、IPC、preload、Claude 写前拦截、能力降级矩阵，以及 renderer 审批 UI（`ApprovalRequestDialog`）均已接入；PostToolUse 提示已降级为“已修改，仅提示” |
| D5 `runNode` + 对账 + 进程回收 | 完成（有已知边界） | 三层回收承诺：同进程只回收本轮登记句柄；跨重启仅回收「started_at + cmd」可证明归属的残留；证据不足只告警并写 `residual_risk`。**已无裸 pid/pgid kill**；SDK 边界见 §6.5 / §9 |

## 1. 环境、基线与验收命令结果

### 1.1 测试环境关键事实

- macOS，Node 20。
- 根 `node_modules/better-sqlite3` 是 Electron ABI（NODE_MODULE_VERSION 130），Node 测试进程需要 115，导致依赖 sqlite 的既有用例无法加载。
- 处理方式：**未 rebuild、未改根依赖**；新增测试 helper `src/main/agent/runtime/__tests__/helpers/test-db.ts` 优先加载根依赖，失败时回退到 spike 自带的 Node ABI 副本。旧用例不做任何修改。

### 1.2 基线（改动前）

| 检查 | 基线结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | 24 errors / 0 warnings，全部是 `spikes/**` 的 Parsing error（spike 为未跟踪目录，parser 未覆盖其 TS 语法） |
| `npx vitest run` | 27 个测试文件 / 174 个用例失败，失败原因全部为 `NODE_MODULE_VERSION 130 vs 115` |

### 1.3 改动后实测

| 检查 | 结果 | 与基线对比 |
|---|---|---|
| `npx tsc --noEmit` | exit 0，无输出 | 持平 |
| `npm run lint` | 24 errors / 0 warnings，仍全部位于 `spikes/**`；`src/**` 0 error 0 warning | 持平，未修改 spike 以“让 lint 变绿” |
| `npx vitest run` | 26 个文件 / 173 个用例失败，**非 ABI 失败 0 个**；2865 passed / 3128 total | 比基线少 1 个失败文件、少 1 个失败用例 |
| runtime 测试 | 9 个文件 / 67 个用例全绿 | 第二轮新增 7 个进程/恢复用例 |
| `agent-manager.test.ts` | 41 个用例全绿（含新增同会话并发 fail-fast） | 新增 1 个 |

> 说明：全量 vitest 仍有 ABI 失败，这是仓库既有环境问题，本次未修；本次改动未引入任何非 ABI 失败。8 个 JSON 报告里未携带错误文本的失败文件已单独复跑确认，全部为 `NODE_MODULE_VERSION`。

## 2. D1：表结构、迁移与仓储层

### 实现

- 新增 `src/main/agent/runtime/db/schema.ts`：
  - 9 张表：`agent_runs`、`agent_sessions`、`agent_turns`、`agent_steps`、`agent_events`、`agent_approvals`、`agent_artifacts`、`agent_usage`、`agent_snapshots`。
  - `agent_sessions` 含 `executor_pid` / `executor_pgid` / `executor_env_marker`。
  - `agent_steps.status` CHECK 含 `aborted` / `unknown`。
  - `agent_usage` 含 `graph_id` / `day_key` / `cost_micros` / `is_estimate` / `source`。
  - `agent_approvals` 含 `args_hash`、`mode`、`timeout_ms`、`decided_by`、`expires_at`。
  - 索引含 `CREATE UNIQUE INDEX ... ux_turns_active ON agent_turns(node_id, branch_key) WHERE status IN ('running','waiting_approval','cancelling')`。
- 修改 `src/main/database.ts`：`CURRENT_SCHEMA_VERSION` 17 → 18，`TABLE_SCHEMAS` / `INDEX_SQLS` 追加 agent schema；沿用既有迁移框架（逐版本建表、补列、建索引）。
- 新增 `src/main/agent/runtime/db/repository.ts`：全量 CRUD、run 级 seq 分配、turn_seq 保留、状态投影、审批原子幂等决策、用量 graph×day 聚合、恢复计划落库。

### 证据

- `db-schema.test.ts`
  - `creates exactly the 9 M0 tables`
  - `exposes the M0 extensions required by the task`
  - `creates ux_turns_active as a partial unique index on active turns`
  - `adds agent tables to a legacy database without touching existing rows`
- `repository.test.ts`
  - `round-trips run/session/turn/step/artifact/snapshot`
  - `allocates run-level seq and keeps turn-local seq continuous across batches`
  - `enforces one active turn per node/branch (ux_turns_active)`
  - `allows a new turn after the previous turn is terminal`
  - `projects run status from turns`
  - `aggregates usage by graph × local day and by day alone`
  - `keeps approval decisions idempotent and persists timeout metadata`

## 3. D2：per-session 串行锁

### 实现

- 新增 `src/main/agent/runtime/locks/session-lock.ts`：
  - `ROOT_LOCK_CONTEXT`、`sessionLockKey`、`nodeLockKey`、`SessionLockRegistry`。
  - `tryAcquire` 忙时返回 `null`（不抛错）；`acquire` 忙时抛 `SessionBusyError`（消息含 `SESSION_BUSY`）。
  - 归属只认显式 `LockContext`：伪造/过期上下文不会绕过互斥；同一 turn 重入不提前释放外层；引用计数释放。
  - 同 turn 的 session 锁 → node 锁通过 `withLock` 派生 `sessionCtx`，不依赖 ALS 栈顶推断。
- `AgentRuntime.runNode`：
  - session 锁冲突 → `SessionBusyError`；
  - node 锁冲突（`isBusy` 同步检查，检查与加锁之间无 await）→ `NodeBusyError`；
  - `agent_turns` 插入再兜底 `ux_turns_active`，失败同样映射 `NODE_BUSY`。
  - 会话行改为**拿到节点锁并通过预检后**才创建，fail-fast 不再留下悬空 active 会话。
- `AgentManager.sendCommand` 拆为外层 session 锁 + `sendCommandInner`；runtime 未装配时行为与原来一致。

### 证据

- `session-lock.test.ts`
  - `tryAcquire returns null instead of throwing when busy`
  - `acquire throws SESSION_BUSY (fail-fast, no queueing)`
  - `uses explicit context for attribution and allows reentry`
  - `does not infer ownership from an unrelated stale context`
  - `supports independent node locks and reentrant release counting`
  - `frees the lock even when the guarded function throws`
- `run-node.test.ts`
  - `fails fast with SESSION_BUSY when the same session has an in-flight turn`
  - `fails fast with NODE_BUSY for concurrent turns on the same node (different sessions)`

## 4. D3：BackendDriver、归一化与双写

### 实现

- 新增 `src/main/agent/runtime/executors/adapter-driver.ts`：薄包装现有适配器，只订阅 `onOutput` / `onRawEvent`，**不改适配器原有广播内容**。
  - Claude：注入 `canUseTool` 与 `PreToolUse` 钩子；`PreToolUse` 作为“即将执行”审计，步骤 ensure/update。
  - Codex：消费流式事件。
  - OpenCode：消费 one-shot stdout 原始事件。
  - 长尾：`synthesizeFromOutputs` 仅做输出映射，能力矩阵声明 `toolEvents:none`，没有写 parser。
- 新增归一化器：
  - `normalize/claude.ts`：逐 SDK 消息归一化，`stepId = step-${toolUseID}`，`system:init` → `run.started`，`result` → usage/`run.completed`/`run.failed`。
  - `normalize/codex.ts`：`CodexStreamNormalizer` 实现 C1（`turn.completed` 即完成，不等待迭代器/关机）、C2（未闭合 item 标 `aborted` / `unknown`）、C5（未知事件忽略）、C7（file_change 无 diff 标 `diffUnavailable`）；`normalizeCodexResult` 保留阻塞夹具兼容。
  - `normalize/opencode.ts`：解析 `[text]/[tool]/[tool-result]`，工具事件 `source: synthetic`。
  - `normalize/sink.ts`：turn 内 `seq` 从 1 连续。
- 适配器侧仅做**新增能力**，不改变既有输出：
  - `src/main/adapters/base.ts`：新增 `onRawEvent` / `offRawEvent` / `emitRawEvent`（无监听时零开销）。
  - `src/main/adapters/claude-code.ts`：新增 `setTurnApprovalHooks`，query 注入 `canUseTool` 与 `PreToolUse`；消息循环首行转发原始事件。
  - `src/main/adapters/codex.ts`：改为 `thread.runStreamed()`；`turn.completed` 即发 `complete` 并退出；`turn.failed`/缺 `turn.completed` 发错误；未知事件忽略；关闭时 abort。
  - `src/main/adapters/opencode.ts`：退出时转发 stdout 原始事件。
  - 其余 10 个适配器零改动。
- 归一化事件由 `AgentRuntime.record` 统一 renumber 后落 `agent_events`，`turn_seq` 保持 turn 内连续。

### 关于 `codex.test.ts` 的修改（如实披露）

`runStreamed()` 是 M0 明确要求的变更，既有 mock 只提供 `run()`，导致 7 个 Codex 适配器用例失败。处理方式是**更新 mock**：为 `mockThread` 增加 `runStreamed`，用既有 `mockRun` 结果拼出 `thread.started/turn.started/item.completed/turn.completed` 流；`mockRun` 的调用次数与入参断言保持原样。仅删除一条“`finalResponse` 也要广播”的旧断言，因为流式语义下最终文本来自 `agent_message`（C4 不承诺额外通道）。**没有为了通过测试而放宽 C1**。

### 证据

- `normalizers.test.ts`
  - `maps SDK messages one-by-one with continuous seq`（Claude）
  - `uses turn.completed as completion, ignores unknown events, keeps seq continuous`（Codex C1/C5）
  - `marks open items aborted when turn ends early`（Codex C2）
  - `does not claim success when the stream ends without turn.completed`
  - `still normalizes blocking run() results for legacy fixtures`
  - `maps one-shot stdout with continuous seq`（OpenCode）
  - `produces the same canonical sequence shape as a turn with no tools`（三后端形状一致）
  - `emits run.failed for an error result`
- `codex-health.test.ts`
  - `reports the config.load failure with readable notes`
  - `accepts a passing config.load check`
  - `treats missing checks["config.load"] as invalid`
- 本机真实 C6 验证（只读，不修改 `~/.codex/config.toml`）：
  - `node node_modules/@openai/codex/bin/codex.js doctor --json` → `exit=1`，`overallStatus=fail`，`checks["config.load"].status=fail`，notes 含 `failed to load Codex config`；解析器给出可读 reason。

## 5. D4：审批通道

### 实现

- `approval/gateway.ts`：
  - 固定常量：交互 120s、无人值守 30s；`request` 阻塞调用方直到决策。
  - 决策必须携带 `argsHash`，不匹配抛 `APPROVAL_ARGS_MISMATCH`，且 pending 保留（TOCTOU 防护）。
  - `decide` 幂等：重复决定不产生第二条 resolved 事件；超时写 `status=denied, decided_by='timeout'`。
  - `replayPending` 重启后重推 pending 并按重启时刻重新计时；`sweepExpired` 清理过期行。
  - `classifyToolRisk` 保守分级（Bash=critical、Write=high、Read=low 等）。
- IPC / preload：
  - `agent:onApprovalRequest`、`agent:resolveApproval`、`agent:onApprovalResolved`、`agent:getPendingApprovals`、`agent:getExecutorCapabilities`、`agent:cancelTurn`、`agent:runNode`。
  - `src/main/ipc/agent.ts` 做入参校验；`src/preload/index.ts` 暴露 invoke 与事件监听。
- 能力矩阵 `capabilities.ts`：Claude `approval: pre-exec`；Codex `policy-only`；OpenCode `none`；长尾 `none`。UI 若按能力渲染，Codex/OpenCode 不会显示成“执行前审批”。

### 证据

- `approval-gateway.test.ts`
  - `exposes the fixed timeouts (interactive 120s / unattended 30s)`
  - `blocks the caller until an allow decision, then resolves`
  - `rejects a decision whose argsHash does not match (TOCTOU)`
  - `is idempotent for repeated decisions (no duplicate resolved event)`
  - `times out to denied + decided_by=timeout`
  - `re-emits pending approvals after restart and re-arms timeout`
  - `sweeps expired pending rows to denied/timeout`
  - `classifies tool risk conservatively`

### 复核修复后的 UI

- 新增 `src/renderer/components/agent/ApprovalRequestDialog.tsx`：订阅 `agent:onApprovalRequest` / `agent:onApprovalResolved`，启动时拉取 `agent:getPendingApprovals`；按钮调用 `agent:resolveApproval`（回传请求时的 `argsHash`）。该界面只在真正的写前拦截请求出现时展示，明确标注“工具尚未执行”。
- `ConfirmationDialog.tsx` 降级为事后提示：标题改为“已修改，仅提示”，只保留“知道了”，移除了“确认/拒绝”按钮与暗示写前拦截的文案。
- capability 降级：Codex/OpenCode 不产生 pre-exec 请求，因此不会出现审批框；它们的事后提示使用降级文案，不会被误认为写前审批。

## 6. D5：`runNode`、启动对账与进程回收

### 实现

- `runtime.ts`：
  - 一节点一 turn：session 锁 + node 锁 + `ux_turns_active`。
  - 幂等键：`runId:node:branch:attempt:promptHash`，可显式传入；命中非终态 → `SESSION_BUSY`，命中终态 → `reused: true` 不重复执行。
  - 成本准入：graph × 本地日；无配置 → 不限额但记录（`cost_micros=0, is_estimate=1, source='estimated'`）；有 rates → 按配置计算；单价/汇率不硬编码。
  - 取消：**只按本轮内存中真实登记、且归属可证明的句柄**回收 → 再 abort driver → 写 `cancelled`、`abortOpenSteps`（同时写 `test_disposition='unknown-needs-rerun'`）、投影 run。绝不读取落库 pid/pgid。正常完成路径不调用 `reap`。
  - 异常退出（driver throw）：`finally` 中回收本轮已登记句柄，避免自己 spawn 的子进程泄漏；终态显式 `clearSessionProcess`（pid/pgid/started_at/cmd/marker 全置 NULL）。
  - 启动对账：只把持久化 `pid + executor_started_at + executor_cmd` 作为候选证据；至少两项匹配才回收，否则只告警并写 `residual_risk`（`none|possible|unconfirmed`）与 `recovery_note` → 结果落库（`agent_sessions.recovery_*`）→ `planRecovery` → `applyRecoveryPlan`（逐 step 写入 `test_disposition`）→ `assertNoDangling` → `replayPending`。
- `recovery/planner.ts`：非终态 turn → `orphaned`，open step → `aborted`；每条 step 按 §5.5 五行判定产出 `stepOutcomes`（`completed` / `unknown-needs-rerun` / `needs-human`）并落库；不自动重放任何工具。
- `process/reaper.ts`：`ps -axo pid,pgid,stat,lstart,command`（`LC_ALL=C` 解析 `lstart` 为 startedAt）；`proveOwnership` 要求 `startedAt` / `command`（或可执行路径）/ marker 中**至少两项**成立；`killRegistered` 只接受 `ProcIdentity[]`，不提供 `number[]` 入口，pgid 不再作为 kill 依据；`residualCount` / `scanResidual` 仅诊断，不参与 kill。**已删除厂商正则、baseline 认领与 `reclaimResidual` 启发式扫描**。
- `ipc-handlers.ts`：创建 `AgentRuntime`，注册 claude-code / codex / opencode driver，读取 `settings.agentRuntime` 的 rates/limits，启动 `reconcileOnStartup()`。

### 证据

- `run-node.test.ts`
  - `persists a turn with continuous run seq and turn seq, then projects run completed`
  - `computes cost from configured rates instead of hard-coded prices`
  - `reuses a finished turn for the same idempotency key (no second execution)`
  - `cancels an in-flight SDK turn: aborted steps + residual_risk unconfirmed (no zero-residual claim)`
  - `reclaims this turn’s registered handle when the driver throws (abnormal exit)`
  - `terminal turns clear persisted handles so a later cancel never reuses the previous pid (P0-A)`
  - `startup reclaim kills a residual whose persisted identity is provable (P0-2)`
  - `startup reclaim refuses to kill an unrelated process occupying a persisted pid (P0-A)`
  - `SDK sessions without a provable handle report residual_risk instead of claiming zero residual`
  - `admits turns until the configured day budget is exhausted`
- `recovery.test.ts`
  - `plans orphaned turn + aborted open step for a crashed running turn`
  - `leaves no dangling running turn or open step after apply`
  - `keeps pending approvals (re-emitted later, never auto-allowed)`
  - `orphans a starting session that never produced a turn`
  - `is idempotent: second pass plans nothing and can be re-applied`
  - `does not touch already terminal turns and releases the node lock slot`
  - `assertNoDangling fails loudly when recovery was skipped`
- `process-reaper.test.ts`（真实子进程 + 真实 `ps`，不用 argv 伪造 marker 命中）
  - `reaps only the registered process tree after proving ownership (same-process)`
  - `refuses to kill an unrelated process that occupies a previously recorded pid (PID reuse)`
  - `refuses to kill a bare persisted pid that has no ownership evidence`
  - `marker visible only in the command line is not enough to claim a process`
  - `cross-restart reclaim succeeds only when started_at and command both match`
  - `does not claim or kill processes that were never registered for this turn`
  - `two concurrent turns of the same vendor: reaping A must not touch B`

## 6.5 复核修复记录（问题 → 改法 → 测试）

| 编号 | 问题 | 改法 | 对应测试 |
|---|---|---|---|
| P0-1 | 正常完成也 `reap`；`vendor regex + baseline` 无主认领，A 会话杀掉 B 会话同厂商 CLI | `AgentAdapter.onProcessSpawn` + `DriverExecuteContext.registerProcess` → `agent_sessions.executor_pid/pgid/env_marker` 真正落库；`ProcessReaper` 删除 baseline/正则，只杀登记的 pid 树、登记 pgid、或该 session 持久化 marker；正常完成只 `forget` 不 reap，reap 仅取消与启动清扫 | `run-node.test.ts` › `A completing normally must not reap B (same vendor, concurrent sessions) (P0-1)`；`process-reaper.test.ts` › `two concurrent turns of the same vendor: reaping A must not touch B`、`does not claim or kill processes that were never registered for this turn` |
| P0-2 | `RecoveryPlan` 无 step 级结果；`test_disposition` 从未写入；启动扫描只计数 | `RecoveryPlan.stepOutcomes` + `evaluateStepDisposition`（§5.5 五行）；`applyRecoveryPlan` 逐 step 写 `test_disposition`，completed 行回填 `done`；启动 `reclaimResidual(marker)` 实杀并把结果写入 `agent_sessions.recovery_kills/recovery_note/last_recovery_at` 且打日志 | `recovery.test.ts` › `writes a determinate stepOutcome for every persisted step (P0-2)`、`covers all five §5.5 rows and persists each outcome (P0-2)`；`run-node.test.ts` › `startup reclaim kills residual by persisted marker and persists the result (P0-2)`（第二轮已替换为带归属证据的用例，见 §6.6） |
| P0-3 | step 主键全局递增/按 turn 重置，第二轮 upsert 覆盖第一轮 | Runtime 统一用 `<turnId>:<localStepId>` 作用域事件与 step 主键（normalizer/approval/step 三处入口），schema 增 `ux_agent_steps_turn_id(turn_id,id)` 兜底 | `run-node.test.ts` › `keeps step rows from two consecutive turns of the same node (P0-3)` |
| P1-4 | `sendCommand` 用 `sessionId` 当锁 owner，同会话并发两次 `tryAcquire` 都成功 | owner 改为每次派发唯一的 `dispatch:<uuid>`，第二次并发立即 `SESSION_BUSY` | `agent-manager.test.ts` › `fails fast when the same session is dispatched twice concurrently (P1-4)` |
| P1-5 | `unknown` 被归一化成 `tool.failed` 并落 `failed` | 新增 `tool.unknown` 事件；Codex `closeOpenItems('unknown')` 发 `tool.unknown`；Runtime 落 `step.status='unknown'` 与 `needs-human` 处置 | `normalizers.test.ts` › `(codex) unresolved open item ...`（断言存在 `tool.unknown` 且无 `tool.failed`）；`run-node.test.ts` › `maps unresolved tool existence to unknown, not failed (C2)` |
| P1-6 | Claude 首块 delta+completed 重复；Codex 最终文本重复 | Claude 首块只发 `message.completed`，后续块发 `message.delta` | `normalizers.test.ts` › `(claude) maps assistant text/tool_use …`（文本事件恰好 1 条） |
| P1-7 | `ConfirmationDialog` 事后提示却写“确认”，拒绝不可撤销；renderer 无审批 UI | 事后提示改为“已修改，仅提示”+“知道了”，移除确认/拒绝；新增 `ApprovalRequestDialog`：订阅 `onApprovalRequest/onApprovalResolved`、拉取 pending、按 `argsHash` 调 `resolveApproval`，仅在真正写前拦截时展示 | 组件级接线无独立单测（renderer 现有测试套件全绿）；详见“未验证项” |

### 6.6 第二轮复核修复记录（问题 → 改法 → 测试）

| 编号 | 问题 | 改法 | 对应测试 |
|---|---|---|---|
| P0-A | 按落库裸 `executor_pid/pgid` 直接 kill，PID 复用场景杀掉无关进程（probe H） | 删除 `killRegistered(pids[], pgids[])` 与 `reclaimResidual`；`killRegistered` 只接受 `ProcIdentity[]`，`proveOwnership` 要求 `startedAt` / `command`（或可执行路径）/ marker 至少两项成立；取消只读本轮内存登记；证据不足 → 不杀 + `residual_risk='unconfirmed'` + `recovery_note` | `process-reaper.test.ts` › `refuses to kill an unrelated process that occupies a previously recorded pid (PID reuse)` / `refuses to kill a bare persisted pid that has no ownership evidence` / `marker visible only in the command line is not enough to claim a process`；`run-node.test.ts` › `startup reclaim refuses to kill an unrelated process occupying a persisted pid (P0-A)` |
| P0-A/3 | `updateSessionProcess` 无调用者；`COALESCE` 让陈旧句柄跨 turn 存活；终态不清 pid | `context.registerProcess` 抓取 `startedAt/command` 并调用 `updateSessionProcess`；pid 快照整体覆盖（不再 COALESCE）；`finally` 对所有终态 `clearSessionProcess` | `run-node.test.ts` › `terminal turns clear persisted handles so a later cancel never reuses the previous pid (P0-A)` |
| P0-2 | env marker 在 macOS `ps` 不可见；旧用例把 marker 塞进 argv 伪造跨重启命中 | 承认现实：marker 仅同进程诊断，**不用于跨重启判定**；跨重启只回收 `started_at + cmd` 可证明归属的残留 | `process-reaper.test.ts` › `cross-restart reclaim succeeds only when started_at and command both match`；`run-node.test.ts` › `startup reclaim kills a residual whose persisted identity is provable (P0-2)` |
| P0-2/SDK | Claude/Codex 无句柄时被错误宣称「残留 0」 | 无句柄/证据不足写 `residual_risk='unconfirmed'`；`RecoveryReport.residualRiskSessions` 投影；不承诺 SDK 残留 0 | `run-node.test.ts` › `SDK sessions without a provable handle report residual_risk instead of claiming zero residual` / `cancels an in-flight SDK turn: aborted steps + residual_risk unconfirmed (no zero-residual claim)` |
| P0-2/5 | driver throw 时本轮登记句柄不回收（probe C 泄漏） | `finally` 对非 completed 终态执行 `reap`（本轮登记、归属校验）；正常完成仍只 `forget` | `run-node.test.ts` › `reclaims this turn’s registered handle when the driver throws (abnormal exit)` |
| P1-B | Codex 旧 `AgentOutput` 路径被改成 `runStreamed()`，删了 `finalResponse` 广播并改写测试 | 双路径：旧路径保持 `thread.run()` 与 `finalResponse` 广播；仅 Runtime/Kernel 路径在 `setRawStreamMode(true)` 后走 `runStreamed()` | `codex.test.ts` › `doSendCommand emits agent messages as stdout`（`All done` 广播恢复）/ `uses runStreamed and raw events only in runtime mode (P1-B)` |
| 验收/4 | `residual_risk` 无可见状态 | DDL `none|possible|unconfirmed`；`SessionRecoveryInfo` + IPC；`ChatHeader` 徽标；`RecoveryReport` 投影 | `db-schema.test.ts` › `exposes the M0 extensions required by the task`（含三列）；`run-node.test.ts` › 上述 residual 用例 |

### 本节未验证项（如实标注）

- 真实 Claude 审批钩子：单测覆盖了 `canUseTool` 注入与网关幂等/超时，但未在真实 Claude CLI 上跑通端到端弹窗。
- 跨平台 PGID：**已不再按 pgid kill**；`process.kill(-pgid)` 不再存在于回收路径；Windows 未验证。
- Codex/Claude SDK 不暴露子进程 PID：仅 OpenCode 通过 `emitProcessSpawn` 上报真实句柄；Codex/Claude 只落 env marker。macOS `ps` 读不到 env，故 marker **明确不用于跨重启判定**；SDK 残留只能写 `residual_risk='unconfirmed'`，不宣称残留为 0。
- PID 复用：已通过 `started_at + cmd` 两项证据校验；证据不足只告警不杀（见 §6.6 P0-A）。

## 7. 改动文件清单（按模块）

### 新增：运行时核心

- `src/shared/types/agent-runtime.ts`
- `src/main/agent/runtime/runtime.ts`
- `src/main/agent/runtime/capabilities.ts`
- `src/main/agent/runtime/errors.ts`
- `src/main/agent/runtime/util.ts`
- `src/main/agent/runtime/db/schema.ts`
- `src/main/agent/runtime/db/repository.ts`
- `src/main/agent/runtime/locks/session-lock.ts`
- `src/main/agent/runtime/normalize/{sink,claude,codex,opencode}.ts`
- `src/main/agent/runtime/approval/gateway.ts`
- `src/main/agent/runtime/recovery/planner.ts`
- `src/main/agent/runtime/process/reaper.ts`
- `src/main/agent/runtime/executors/{adapter-driver,codex-health}.ts`

### 新增：测试

- `src/main/agent/runtime/__tests__/helpers/test-db.ts`
- `src/main/agent/runtime/__tests__/{db-schema,repository,session-lock,normalizers,approval-gateway,recovery,run-node,process-reaper,codex-health}.test.ts`

### 修改：装配与契约

- `src/main/database.ts`（schema v20 + 9 表/索引 + session 归属证据列）
- `src/main/ipc-handlers.ts`（runtime 装配、driver 注册、启动对账）
- `src/main/ipc/agent.ts`（新增 IPC handlers）
- `src/main/agent/agent-manager.ts`（session 锁包装 + 每次派发唯一锁 owner + `setRuntime`）
- `src/preload/index.ts`（新通道与事件监听）
- `src/main/adapters/base.ts`（`onProcessSpawn` / `setEnvMarker` / `buildSessionEnv` / `setRawStreamMode` 可选旁路）
- `src/main/adapters/{opencode,claude-code,codex}.ts`（spawn 上报与 marker env；Codex P1-B 双路径）
- `src/shared/i18n/resources/domains/agent.ts`（事后提示、写前审批、残留状态文案）
- `src/renderer/components/agent/ApprovalRequestDialog.tsx`（新增，D4 UI）
- `src/renderer/components/agent/ConfirmationDialog.tsx`（降级为事后提示）
- `src/renderer/components/agent/AgentChatPanel.tsx`（挂载审批 UI + 拉取会话残留状态）
- `src/renderer/components/agent/ChatHeader.tsx`（会话级 `residual_risk` 徽标）
- `src/shared/types/ipc.ts`、`src/shared/types/agent.ts`、`src/shared/types.ts`（新增类型与可选能力）

### 修改：适配器（仅新增能力，Codex 按 M0 要求改造）

- `src/main/adapters/base.ts`（raw event 订阅）
- `src/main/adapters/claude-code.ts`（审批钩子 + raw event）
- `src/main/adapters/codex.ts`（P1-B 双路径：旧 `run()` + 新 `runStreamed()`；C1–C7 仅新路径）
- `src/main/adapters/opencode.ts`（raw event）
- `src/main/__tests__/codex.test.ts`（旧路径断言恢复 + 新路径流式用例）

## 8. 验收项 → 测试映射

| 验收项 | 测试文件 / 用例名 | 结果 |
|---|---|---|
| 9 张表 + 扩展列 + 部分唯一索引 | `db-schema.test.ts::creates exactly the 9 M0 tables` / `exposes the M0 extensions required by the task` / `creates ux_turns_active as a partial unique index on active turns` | PASS |
| 旧库升级不改既有数据 | `db-schema.test.ts::adds agent tables to a legacy database without touching existing rows` | PASS |
| 三后端归一化序列一致且 seq 连续 | `normalizers.test.ts::produces the same canonical sequence shape as a turn with no tools` / `maps SDK messages one-by-one with continuous seq` / `maps one-shot stdout with continuous seq` | PASS |
| Codex C1 完成判定 | `normalizers.test.ts::uses turn.completed as completion...` | PASS |
| Codex C2 未闭合 item | `normalizers.test.ts::marks open items aborted when turn ends early` | PASS |
| Codex C5 未知事件容错 | `normalizers.test.ts::uses turn.completed as completion, ignores unknown events...` | PASS |
| Codex C7 diff 不伪造 | 实现于 `normalize/codex.ts`（`diffUnavailable`）；断言在 `normalizers.test.ts::uses turn.completed as completion...`（`file.change` 的 `payload.diffUnavailable === true`） | PASS |
| Codex C6 `checks["config.load"]` | `codex-health.test.ts` 3 用例 + 本机真实 `codex doctor --json`（exit=1，config.load=fail） | PASS |
| SESSION_BUSY fail-fast | `run-node.test.ts::fails fast with SESSION_BUSY...` / `session-lock.test.ts::acquire throws SESSION_BUSY...` | PASS |
| NODE_BUSY fail-fast | `run-node.test.ts::fails fast with NODE_BUSY...` / `repository.test.ts::enforces one active turn per node/branch` | PASS |
| 审批幂等 | `approval-gateway.test.ts::is idempotent for repeated decisions` / `repository.test.ts::keeps approval decisions idempotent...` | PASS |
| 审批超时 denied/timeout | `approval-gateway.test.ts::times out to denied + decided_by=timeout` / `sweeps expired pending rows to denied/timeout` | PASS |
| 审批重启重放 | `approval-gateway.test.ts::re-emits pending approvals after restart and re-arms timeout` | PASS |
| argsHash 参与匹配 | `approval-gateway.test.ts::rejects a decision whose argsHash does not match (TOCTOU)` | PASS |
| 崩溃后 RecoveryPlan 无悬空 running | `recovery.test.ts::leaves no dangling running turn or open step after apply` / `assertNoDangling fails loudly when recovery was skipped` | PASS |
| 同进程真实句柄取消后 2s 残留=0 | `process-reaper.test.ts::reaps only the registered process tree after proving ownership (same-process)` / `run-node.test.ts::A completing normally...`（取消后 2s `!alive` + `residual_risk='none'`） | PASS |
| 跨重启可证明归属 → 回收 | `process-reaper.test.ts::cross-restart reclaim succeeds only when started_at and command both match` / `run-node.test.ts::startup reclaim kills a residual whose persisted identity is provable (P0-2)` | PASS |
| 无法证明归属 → kill 调用数 0 + residualRisk | `process-reaper.test.ts::refuses to kill an unrelated process... (PID reuse)` / `refuses to kill a bare persisted pid...` / `run-node.test.ts::startup reclaim refuses to kill... (P0-A)` | PASS |
| 终态清空句柄 / 双轮取消不复用旧 pid | `run-node.test.ts::terminal turns clear persisted handles so a later cancel never reuses the previous pid (P0-A)` | PASS |
| driver 异常退出回收本轮句柄 | `run-node.test.ts::reclaims this turn’s registered handle when the driver throws (abnormal exit)` | PASS |
| SDK 只承诺收敛 + residual_risk | `run-node.test.ts::SDK sessions without a provable handle...` / `cancels an in-flight SDK turn...no zero-residual claim` | PASS |
| 跨会话不误杀 | `process-reaper.test.ts::two concurrent turns of the same vendor: reaping A must not touch B` / `run-node.test.ts::A completing normally must not reap B (same vendor, concurrent sessions) (P0-1)` | PASS |
| 成本可配置、不硬编码、无配置不限额但记录 | `run-node.test.ts::computes cost from configured rates instead of hard-coded prices` / `persists a turn with continuous run seq...` / `admits turns until the configured day budget is exhausted` | PASS |
| 旧 `AgentOutput` 路径不变（P1-B） | `codex.test.ts::doSendCommand emits agent messages as stdout`（恢复 `All done` finalResponse 广播）/ `creates Codex instance and calls startThread once`（断言未走 `runStreamed`）/ `uses runStreamed and raw events only in runtime mode (P1-B)` | PASS |

## 9. 未完成、未验证与风险（如实列出）

1. **D4 renderer UI 已接入，但真实 Electron 未验证**：`ApprovalRequestDialog` 已订阅/决策；未在真实窗口验证推送与决策往返。
2. **真实 Electron 端到端未验证**：未启动 Electron、未验证 `broadcastToWindows` 在真实窗口下的审批推送与 `agent:onEvent` 频率/体积。
3. **真实 Claude 审批钩子未验证**：`canUseTool` / `PreToolUse` 只在类型和装配层完成，未对真实 Claude Code CLI 触发过“写前拦截”；标为未验证。
4. **真实 Codex / OpenCode 流式执行未跑**：只有夹具与 spike 结论；本机 `~/.codex/config.toml` 的 `model_reasoning_effort="max"` 会让 CLI exit 1，本次只验证了 `codex doctor` 的失败解析，未修改用户配置。
5. **跨重启进程回收边界（D5 已修复，见 §11）**：OpenCode 通过 `emitProcessSpawn` 上报真实 pid；Claude 走 `spawnClaudeCodeProcess`、Codex 走监督 shim 自注册，均已能真实落库 `pid/pgid/started_at/command` 并按自有进程组回收。仅在「身份不可证明」时写 `residual_risk='unconfirmed'`。真实 Electron 端到端与真实 Codex 任务仍属未验证（见 §11.8）。
6. **`residual_risk` 徽标未在真实 Electron 窗口验证**：DDL/IPC/renderer 接线已完成且类型检查通过，但未启动真实窗口；与 D4 审批 UI 同类未验证。
7. **启动时间格式依赖 `ps lstart`**：已强制 `LC_ALL=C` 并归一化为 `Mon DD HH:MM:SS YYYY`；Linux/Windows 未验证（本机 macOS 实测通过）。
8. **PID 复用已按要求处理**：取消与启动回收都先做归属证明（started_at + cmd 至少两项）；证据不足只告警不杀。跨会话误杀由「只回收本轮登记句柄」保证。
9. **C7 覆盖强度一般**：`file_change` 的 `diffUnavailable` 有断言，但只在一条综合用例里，没有独立的“无 diff 文件变更”用例；后续补强。
10. **启动对账与新 turn 的竞态**：`reconcileOnStartup` 异步执行，极端情况下新请求先到，会看到旧的非终态 turn 而得到 `NODE_BUSY`（fail-fast 可重试，但体验上会失败一次）。
11. **成本配置仅启动时读取**：`settings.agentRuntime` 在 `registerIpcHandlers` 读取一次，修改设置后需重启生效，未做热更新。
12. **lint 未全绿**：24 个 Parsing error 全在未跟踪的 `spikes/**`；按纪律未改 spike 去迎合 lint。`src/**` 本次改动 0 error 0 warning。

## 10. 下一步（M1 入口）

1. ~~Renderer 审批面~~ **已完成**（复核修复）：`ApprovalRequestDialog` 已订阅 `agent:onApprovalRequest` / `agent:onApprovalResolved` 并调用 `resolveApproval`；后续只需真实 Electron 联调。
2. **真实链路联调**：Electron 内跑 Claude 写前拦截（构造一次 Write 工具审批）、Codex 流式完成、OpenCode one-shot 归一化，记录 `agent_events` 的 seq/turn_seq。
3. **进程回收增强**：~~Claude/Codex launcher shim~~ 已完成（见 §11）；剩余为真实 Electron 端到端联调、组长消失后的组员孤儿认领，以及把启动对账改为“先对账后开放 runNode”的启动屏障。
4. **C7 用例增强**：把 `file_change` 无 diff 的 `diffUnavailable` 拆成独立断言，覆盖 add/modify/delete。
5. **成本配置热更新 + 预算告警**：在设置变更后重建/更新 `AgentRuntime` 的 rates/limits。
6. **对账与新请求的顺序**：把 `reconcileOnStartup` 变为可 await 的启动屏障，或在 `runNode` 入口等待首次对账完成。

## 11. D5 恢复承诺修复（跨重启回收从「只能 unconfirmed」变为「可证明、可执行」）

> 本节对应任务「D5 恢复承诺不可兑现」+ 追加的 C4b 误杀修复。权威口径仍是 `agent-architecture.md`（未修改）；本节只记录实现与实测。

### 11.1 机制选型：选方案 A（自有进程组 + 受控 spawn / 监督 shim）

| 维度 | 方案 A：监督进程 / 受控 spawn（选定） | 方案 B：启动瞬间进程树快照 |
|---|---|---|
| 归属来源 | 我们亲自 `spawn(..., { detached: true })`，`pid`/`pgid` 当场可知；Codex 由 shim 自注册落盘 | spawn 后枚举后代再登记，归属是**推断** |
| 同厂商两会话并发 | 每个会话各自一个进程组，天然隔离；不会把「新出现的子进程」认成自己的 | 快照窗口内两个会话同样在 spawn，无法区分新后代属于谁（P0 风险） |
| 跨重启 | 自有组组长 pid + `lstart` + 完整命令行三要素可证明；Codex 还有自注册文件 | 只能靠事后进程树猜测，重启后树已断 |
| 对 SDK 侵入 | Claude：官方 `spawnClaudeCodeProcess` 钩子；Codex：官方 `codexPathOverride` + env，均为公开能力 | 需要在 SDK 内部 spawn 后抢时序，无官方钩子 |
| stdio/退出码/信号 | 完全透传（shim 转发 stdin/stdout/stderr、退出码，信号转 `kill(-child.pid)`） | 不改变 SDK，但快照本身无收益 |
| 失败模式 | shim 自身崩溃 → 自注册文件仍在，重启按磁盘身份回收；注册失败 → 退回 `unconfirmed` | 窗口错过 → 永久无法证明归属；窗口重叠 → 误认 |
| 复杂度 | 中（一个 ~100 行 shim + 两个适配器钩子 + 注册表读写） | 中高（时序、并发、PID 复用同时处理） |

**结论**：A 没有硬障碍。Electron 主进程里 `detached: true` 正常；Claude SDK 的 `spawnClaudeCodeProcess`、Codex SDK 的 `codexPathOverride` 都是公开 API，实测可跑。B 在两会话并发下无法做归属区分，正是第一轮 P0-1 的根因形态，因此不选。

### 11.2 实现要点

1. **新机制文件** `src/main/shared/process-supervisor.ts`
   - `spawnInOwnGroup()`：`spawn(command, args, { stdio: ['pipe','pipe','pipe'], detached: true, signal })`，子进程即组长（`pgid === pid`）。
   - `ensureCodexSupervisorScript()`：生成 `codex-supervisor.cjs`（`0o755`）。shim 先 `spawn(process.execPath, [realCodex, ...args], { detached: true })`，再以**原子写**（tmp→rename）把 `{marker,pid,pgid,startedAt,startedAtHiRes,command,shimPid,createdAt}` 写到 `<registryDir>/<encodeURIComponent(marker)>.json`；随后双向透传 stdio、转发信号到 `-pid`、透传退出码。
   - shim 用 `ps -o lstart= -p <pid>` / `ps -o command= -p <pid>`（`LC_ALL=C`）取身份；Linux 额外读 `/proc/<pid>/stat` 第 22 字段生成 `linux-starttime:<ticks>`。
   - macOS `ps` 读不到 env marker，所以**跨重启凭证是自注册文件，不是 env**。
2. **Claude 适配器**：只在 Runtime 路径开启 supervision；`spawnClaudeCodeProcess` 中走 `spawnInOwnGroup`，并通过 `emitProcessSpawn({ pid, pgid })` 上报 → Runtime 立刻用实时 `ps` 补全 `command/startedAt` 落库。
3. **Codex 适配器**：supervision 时每轮新建 `Codex` 实例，`codexPathOverride = shim`，env 注入 `registryDir` + `realCodex`；Driver 并发轮询自注册文件，拿到真实 `pid/pgid/startedAt/command` 后 `registerProcess` 落库。
4. **回收（`reaper.ts`）**
   - 归属证明：**≥2 项不同证据，且至少 1 项为内容证据（`command` / `marker`）**；`startedAt` 在 Windows 不计；`marker` 若已包含在登记命令中不重复计数；`groupLeader` 不是证据。
   - 只有 `identity.pgid === identity.pid` **且**实时 `current.pgid === identity.pid` 才 `kill(-pgid)` 整组回收；否则退回进程树回收。
   - `terminateGroup` 额外拒绝：`leaderPid <= 1`、`leaderPid === process.pid`、以及 `self.pgid === leaderPid`（**绝不对宿主所在组发整组信号**）。
   - 启动清扫与取消两条路径都走同一 `reclaim`；SQLite 落库身份 + 自注册文件兜底，正常完成的轮次只清台账不杀。
5. **双路径保持**：旧 `AgentOutput` 路径不调用 `setProcessSupervision`，行为不变（`codex.test.ts` 旧路径用例仍绿）。

### 11.3 C4b 根除说明（实测误杀入口）

- **旧缺陷链**：`commandMatches` 在整串不相等时退化为「只比可执行文件名」；叠加秒级 `startedAt`，在「PID 复用 + 同秒启动 + 同可执行名」下凑够 2 项 → `-pgid` SIGTERM 打死无关 canary。
- **根除方式（三处同时收紧）**：
  1. `commandMatches` 只做**完整命令行**规范化空白后的精确相等，**basename 退路已删除**；无法精确匹配即不产生 `command` 证据。
  2. 证据规则显式：`matched` 中每项最多一次；必须 `≥2` 项且 `hasContent`（`command`/`marker` 至少其一）。于是「同秒 + 同可执行名」最多只有 `startedAt` 一项 → `insufficient-proof`，kill=0。
  3. `marker` 去重：若登记命令里已含 marker，marker 不再单独计项；`groupLeader` 仅用于选择回收范围，不参与凑项（曾短暂误加，现已撤销）。
- **startedAt 来源**：
  - POSIX：`ps -o lstart=`（`LC_ALL=C`）归一化为 `Mon DD HH:MM:SS YYYY` 后**原始字符串精确比较**，不再解析/重排。
  - Linux：额外用 `/proc/<pid>/stat` 第 22 字段 `starttime` ticks（`linux-starttime:<ticks>`）；存在则必须匹配，秒级 lstart 不再兜底。
  - macOS：无 sub-second 公开等价来源（`proc_pidinfo` 需原生调用，未引入）；使用 lstart 精确串比较，且**单独永远不能证明**（必须配内容证据）。
  - Windows：明确 `return false`，`startedAt` **不计入**证据（只有 command/marker 内容证据可用）。
- **已知边界**：`startedAtHiRes` 目前只在同一生命周期内使用；SQLite 未新增列，跨重启的 DB 身份仍是 `lstart + 完整命令行`。Codex 的自注册文件在 Linux 上会带 hi-res，可跨重启使用。

### 11.4 C5b 组归属结论

- 组回收的充要条件是「登记时 `pgid === pid`（说明我们创建了该组）**且** 实时 `current.pgid === identity.pid`（说明该 pid 仍是该组组长）」。任一不满足 → 只做进程树回收。
- 额外守卫：`terminateGroup` 若发现 `self.pgid === leaderPid` 直接拒绝（宿主 Electron 与 CLI 共享组时绝不整组杀）。
- 实测结论：非 `detached` 子进程与测试进程共享组（`observedPgid ≠ pid`）时，伪造「`pgid === pid` 自有组长」身份也只能树杀；负 pid 信号计数 = 0，宿主存活。独立测试台 C5b（`pgid ≠ pid`）也 PASS。

### 11.5 问题 → 机制 → 测试名 → 实测证据

| 问题 | 机制 | 测试名（文件） | 证据类型 |
|---|---|---|---|
| SDK 路径 pid/pgid/started_at/cmd 为空 | 受控 spawn（Claude 钩子 / Codex shim 自注册） | `Claude SDK spawns the CLI into our own process group and the group is reclaimable`（real-cli-supervised.integration） | **真实运行**（真 Claude CLI，`pgid===pid`，startedAt/command 均非空） |
| Codex 不暴露 PID | shim 原子写自注册文件 + Driver 轮询 | `Codex shim self-registers a real pid/pgid/startedAt/command...`（process-supervisor） | 真实进程（shim + 长驻 fake-CLI 模拟 SDK spawn 形态）；另 `Codex SDK + supervisor shim...` 为**真实 Codex SDK**（见 11.6 限制） |
| 同厂商两会话并发，A 取消/崩溃不影响 B（P0） | 每会话自有进程组 + 只回收本轮/本文件身份 | `two concurrent turns of the same vendor: reaping A must not touch B`（process-reaper）+ 真机双 Claude 实验 | 单测真实进程；双会话为**真实 Claude 真机实验**（见 11.6） |
| 跨重启回收残留 CLI | 落库身份 + 磁盘自注册文件，重启后 `killRegistered` | `cross-restart reclaim succeeds only when started_at and command both match`（process-reaper）/ `startup reclaim kills a residual whose persisted identity is provable (P0-2)`（run-node）/ `startup sweep reclaims a residual group from the process self-registry (D5)`（run-node） | 真实进程（真 detached 子进程）；宿主 kill -9 实验见 11.6 |
| 取消路径没有内存句柄（Codex） | `reap(turnId, registryIdentity)` 合并磁盘身份 | `cancel reclaims a group recorded only in the self-registry (no in-memory handle)`（run-node） | 真实进程 |
| PID 复用误杀 | 精确命令行 + 内容证据必选 | `refuses to kill an unrelated process that occupies a previously recorded pid (PID reuse)`（process-reaper） | 真实进程 |
| **C4b**「PID 复用 + 同秒 + 同可执行名」 | 删除 basename 退化 + `≥2 且含内容证据` | `C4b: PID reuse + same-second start + same executable name must not be claimed`（process-reaper，kill=0）；`C4b（加强）可执行名退化匹配不得单独凑成归属证据`（spike known-gaps，现绿） | 真实 canary 进程 + 真实 `ps` |
| C4b 正向对照 | 精确身份仍可回收 | `C4b control: a genuine residual with exact command is still reclaimed`（process-reaper） | 真实进程 |
| **C5b** 宿主共享组不得整组杀 | `pgid===pid` 双条件 + 拒绝 self 组 | `C5b: a host-shared process group must never be reclaimed as our own group`（process-reaper，负 pid 信号=0）；`C5b guard: terminateGroup refuses the caller’s own process group`（注入进程表的逻辑守卫）；spike `C5b` | 前一为真实共享组；后一为**逻辑级（注入表）** |
| 正常完成不触发回收、终态清空 | 只 `forget` + 终态清 `executor_pid` | `terminal turns clear persisted handles...` / `A completing normally must not reap B...`（run-node） | 真实进程 |
| 旧 AgentOutput 路径不变 | supervision 仅在 Runtime driver 开启 | `codex.test.ts` 旧路径用例（全量套件中通过） | 既有测试 |

### 11.6 实测数据（真实运行 / 等价实验分开标注）

**A. 真实 Claude 真机（macOS 26.1，`claude-agent-sdk` 0.3.286 + CLI 2.1.316）**
- 简单任务：真实 CLI `pid/pgid` 相同（`pgid===pid`），`startedAt` 形如 `Nov 4 23:07:09 2026`，`command` 为完整 CLI 命令行；正常完成自行退出，无残留。耗时 6.2s。
- 中途回收（Bash `sleep 20` 进行中）：`killRegistered` 整组回收，`killedGroups` 命中本组，5s 内组内无残留，`stillAlive=[]`。耗时 857ms。
- **真·宿主 kill -9 → 重启回收**（真实宿主进程 + 真 Claude，不是 mock）：
  - 宿主 `67321` 经 `spawnClaudeCodeProcess` 拉起 CLI `67324`（`pgid=67324`）；
  - `kill -9 67321` 后 CLI 成为孤儿（`ppid=1`，仍在自有组）；
  - 全新进程只凭落库身份 `{pid:67324, pgid:67324, startedAt:"Nov 4 23:07:09 2026", command:".../claude --output-format stream-json ..."}` 回收：
    `killed=1, killedGroups=[67324], unresolved=[], missing=[], stillAlive=[], 组内剩余=0`，耗时 **775ms**。
- **同厂商两会话并发（真 Claude，两组独立）**：A `pgid=67531`、B `pgid=67530`；kill -9 A 宿主并回收 A 组后，B 进程仍存活；再回收 B 组 `killedGroups=[67530]`；最终两组均无残留，**误杀计数 0**。

**B. 真实 Codex SDK（受本机全局配置阻塞）**
- 真实 Codex CLI 0.135.0 经 shim 自注册成功：记录含真实 `pid/pgid/startedAt/command`（command 含 `codex.js`），证明 shim 路径能落库。
- 但 `~/.codex/config.toml` 的 `model_reasoning_effort="max"` 被 CLI 判为非法值：真实执行 `codex exec` 返回 `EXIT code=1` + `Error loading config.toml: unknown variant 'max' ...`。按纪律未修改用户配置，因此真实 Codex 任务无法在本机完成；该路径的回收验证用**真实 shim + 长驻 fake-CLI**（模拟 SDK spawn 形态，非 mock SDK）与注册表磁盘回收完成，报告中**不把 fake-CLI 说成真 Codex 任务**。

**C. 独立对抗测试台 `spikes/reaper-isolation`（未改其断言/实现）**
- 契约 C1–C11：**12/12 PASS**（含 C5b `pgid≠pid` 退回树杀、C3 重启清扫不误杀 B）。
- 缺口 `npm run test:gaps`：C4b 由 FAIL → **PASS**（信号数 0，canary 存活）。
- 对照 `test:sabotage-detection`：3/3 PASS（坏实现仍能被契约抓到，说明测试台未失效）。

**D. 全量验收**
- `npx tsc --noEmit`：0 error。
- `npx eslint src`：0 error / 0 warning。
- `npx vitest run`（全量）：**230 文件 / 2876 用例通过，93 skipped；26 文件 / 173 用例失败**。逐条核对失败栈：全部为既有 `better-sqlite3` ABI 不匹配（模块按 `NODE_MODULE_VERSION 130` 编译，本机 Node 20 需 `115`）及其 `Database not initialized` 级联，**无一条位于本次新增/修改文件**。
  - 本次新增/修改对应测试：`process-reaper` 11/11、`process-supervisor` 4/4、`run-node` 17/17、真实 CLI 集成 4/4（`BIZGRAPH_REAL_CLI_TEST=1`）→ **0 失败**。
  - 既有 ABI 失败：**26 文件 / 173 用例**（未修复，属环境依赖，不属本次范围）。

### 11.7 平台边界（如实标注）

| 平台 | 状态 | 说明 |
|---|---|---|
| macOS | **实测通过** | `detached` 自有组、`ps -o lstart=/command=`、整组 `kill(-pgid)`、真 Claude 宿主 kill -9 回收、双会话隔离均实测。 |
| Linux | **代码已实现，未在本机实测** | `/proc/<pid>/stat` 高精度 starttime；其余路径与 POSIX 相同。`startedAtHiRes` 未落 SQLite（仅同生命周期使用），Codex 注册表可跨重启携带。 |
| Windows | **代码已实现，未在 Windows 实测** | 回收走 `taskkill /PID <pid> /T /F`；`startedAt` 明确不计证据；Codex shim 为 `.cjs` 依赖 shebang，Windows 无法直接 spawn，故 supervision 在 Windows 关闭（退回 SDK 默认 + 树杀）。Job Object 未实现。 |

### 11.8 未覆盖与风险

1. 真实 Electron 宿主内的端到端（DB 落库 → 崩溃 → 重启清扫）未跑；本次用独立宿主进程 + 落库身份做了等价实验。
2. 真实 Codex 任务未能完成（全局配置非法值）；只验证到 shim 自注册与回收机制，真实 Codex 的「长任务中途崩溃」未验证。
3. 组长先于组员退出、组员成为孤儿的场景：当前 `reclaim` 见 leader missing 只记 `missing`，不按组回收（spike C3 已如实记录该边界）。
4. `startedAtHiRes` 未持久化；跨重启在 Linux 上仍以 `lstart + 完整命令行` 证明。
5. Windows Job Object 未实现、未实测。
6. 旧 `AgentOutput` 路径与 Runtime 路径的 supervision 开关靠适配器实例状态，未做并发压测。

### 11.9 文档待改点（`agent-architecture.md` 由另一会话维护，本节不改）

1. §6.5 b「started_at + cmd 两项」应改为显式证据模型：**≥2 项不同证据 + 至少 1 项内容证据（command/marker）**；`startedAt` 在 Windows 不计；Linux 优先 `/proc` ticks；marker 不得与 command 重复计数；`groupLeader` 不是证据。
2. §6.5 需新增「自有进程组」承诺：SDK 路径由宿主受控 spawn（Claude 官方钩子 / Codex shim），`pgid === pid` 且实时组长匹配才允许 `kill(-pgid)`，并拒绝宿主自身组。
3. §4.2 应注明 SDK 路径现在**会**真实落库 `executor_pid/executor_pgid/executor_started_at/executor_cmd`；`started_at` 是 POSIX `lstart` 归一化字符串（非 epoch），Windows 不提供证据。另建议新增 `executor_started_at_hi_res`（可选）以持久化 Linux ticks。
4. §8 完成判定：SDK 会话不再默认 `residual_risk='unconfirmed'`；「有可证明身份 → 回收」「无身份 → unconfirmed」需按新证据模型重述；并补充「组长已消失但组员存活」的明确边界（当前只记 `missing`）。
5. 建议在 §6.5 增加 Codex 自注册文件的格式与目录约定（`BIZGRAPH_PROC_REGISTRY_DIR`、`<encodeURIComponent(marker)>.json`），以及原子写/删除时机。

## 12. C12/C13 修复：自注册记录的信任边界（D5 追加）

### 12.1 问题与根因

- **C12（伪造自注册记录）**：旧恢复路径遍历注册目录后，把记录里的 `pid/pgid/startedAt/command` 当作唯一凭证。这些字段全部可从 `ps` 读到，本地任何能写该目录的进程都能伪造一份「完全匹配」的记录，导致 `killRegistered` 整组误杀可观测进程（实测 `killed=1`、`-86524 SIGTERM`、canary 被杀）。
- **C13（注册目录抢注）**：旧 `ensureCodexSupervisorScript` 直接复用已存在的目录，预创建 `0777` 目录会让 shim 落在组/其他用户可写位置（实测 `dirMode=777`），为 C12 提供写入入口。
- 根因是**记录本身没有被认证**，且恢复路径没有要求「记录必须对应 DB 中已知的 turn/session」。只加权限校验不够，必须同时补齐「记录 ↔ 运行实例」的密码学绑定与「记录 ↔ DB 身份」的映射。

### 12.2 修法（均为「不更松」方向）

1. **目录隔离与属主独占**
   - 默认目录改为 `os.tmpdir()/bizgraph-agent-proc-<uid>`（不同用户/实例天然隔离）；仍支持 `BIZGRAPH_PROC_REGISTRY_DIR` 覆盖。
   - 新建强制 `0700`；已存在时 `lstat` 校验：symlink / 非目录 → 抛错；属主不是当前用户 → 抛错；`mode & 0o077 != 0` 时仅允许属主本人收紧到 `0700`，收紧失败 → 抛错。**绝不静默沿用**。
   - shim 文件原子创建、`0700`、写后用 `fchmod`；shim 内 `mkdir` 后校验真实目录/属主并强制 `chmod(0700)`。
2. **记录认证：跨用户不可伪造 + 不可重放（nonce + HMAC）**
   - 安装级密钥：`os.tmpdir()/bizgraph-agent-secret-<uid>`，`0600`、属主当前用户、拒绝 symlink/宽权限；`BIZGRAPH_REGISTRY_SECRET` 可覆盖（仅经 env 注入，`ps` 不可见）。
   - 每次 spawn 生成随机 `nonce`，**同时**写入 shim env（`BIZGRAPH_SUPERVISOR_NONCE`）和注册记录；shim 缺 nonce/secret 直接 `fail(127)`。
   - 记录用 `HMAC-SHA256(secret, canonical(keys-sorted k=v))` 生成 `sig`；记录文件 `0600`、非 symlink、属主当前用户，验签用 `timingSafeEqual`。
   - 恢复时只有「验签通过 + 文件属性合规」的记录才会被铸造成可信身份；篡改/无 nonce 一律拒绝。生产中 nonce 与 shim 实际环境一致（同一 `spawn` 注入），本地可可靠校验。
   - **威胁模型边界（如实声明）**：保证是「跨用户不可伪造、不可重放」，**不是**「绝对不可伪造」。同 uid 攻击者可读取 `0600` 安装密钥并铸造合法签名（spike C14/C14b 实测 PASS），这属于同 uid 威胁模型内能力，不构成权限提升；跨用户读不到密钥、也写不进 `0700` 目录。
3. **只认已知**
   - `runtime.reconcileOnStartup` 只处理 marker 能映射到 `sessions.executor_env_marker`（或 `bizgraph-turn:<id>` 且 `repo.getTurn(id)` 存在）的记录；未知 marker 仅 `warn` 后跳过。
   - 取消路径 `registryIdentity(turnId)` 只读本轮固定 marker 的记录，不遍历目录。
4. **防重放**
   - 启动清扫在 `killedPids.length > 0 || missing.length > 0` 后立即删除记录文件；取消/异常收口也在 turn 结束时删除。
   - 身份层再加一道：进程已消失（missing）时重复回收不会产生第二次 kill；实测重放 `killed=0, missing=[pid]`。
5. **信任门（进程层兜底）**
   - 身份签名 `attestation` 三态：`trusted` / `tampered`（拒绝）/ `unsigned`（**仅当目标 `ppid === 1` 已孤儿化**才允许）。伪造记录瞄准仍被宿主持有的进程时必然被挡下。
   - 仅对 `trusted` 身份允许「结构性绑定」放宽：`startedAt` 精确匹配 + `pgid === pid` + 实时仍是组长，可覆盖 Codex exec 换镜像后 `ps` 命令行变化（`(node)`）的情况；无签名/伪造记录不享受该放宽。

### 12.3 问题 → 改法 → 测试名 → 实测信号计数

| 问题 | 改法 | 测试名（文件） | 实测信号计数 |
|---|---|---|---|
| C12 伪造 JSON（字段真实、无 nonce/签名） | 验签 + 文件属性 + 信任门 | `C12: a forged record with real ps fields but no nonce/signature must not kill`（registry-hardening） | `killed=0`、`killedGroups=[]`、canary 存活；spike C12 同口径：`killed=0`、`signalsToCanary=[]`、`canaryAlive=true` |
| C12 记录文件权限宽于 0600 | `verifyProcRegistryFile` 检查 `mode & 0o077` | `a signed record readable by group/other is rejected (must be 0600)`（registry-hardening） | 签名有效 = true；文件校验 = false |
| C12 记录 symlink 指向外部文件 | `lstat` 拒绝 symlink | `a symlinked record file is rejected even if its target is signed`（registry-hardening） | 签名有效 = true；文件校验 = false |
| C12 签名字段被篡改 | HMAC 覆盖全部字段 | `a tampered signed record fails verification and never kills`（registry-hardening） | 验签 = false、`killed=0`、canary 存活 |
| C13 预创建 0777 目录 | 属主本人收紧到 0700 | `C13: a pre-created 0777 registry dir is tightened to 0700 and the shim is not group/other writable`（registry-hardening） | 目录 `777 → 700`；shim `mode & 0o022 = 0`；spike C13：`dirMode=700`、`shimMode=700`、`groupOrOtherWritable*=false` |
| C13 注册目录为 symlink | 拒绝使用并报错 | `C13: a symlinked registry dir is rejected instead of reused`（registry-hardening） | 抛 `not a real directory` |
| 未知 marker 记录 | 只认 DB 已知 turn/session | `startup sweep ignores registry records whose marker is unknown to the DB (C12)`（run-node） | `registryKills=0`、子进程存活、记录保留 |
| 已验证记录被重放 | 回收后删除记录 + 身份层 missing | `replaying an already reclaimed identity produces no second kill`（registry-hardening） | 首次 `killed>=1`、`killedGroups` 含 pgid；重放 `killed=0`、`missing` 含 pid |
| 正向对照（真实残留） | 签名记录仍可回收 | 同上（正向段）/ `startup sweep reclaims a residual group from the process self-registry (D5)`（run-node） | 首次回收 `killedGroups` 含 pgid；启动清扫 `groups=<pid>` |
| 真实 Codex shim 记录 | 验签后铸造身份 | `Codex SDK + supervisor shim writes a real self-registry record`（real-cli-supervised.integration，`BIZGRAPH_REAL_CLI_TEST=1`） | `verifyProcRegistryFile=true`；记录含真实 `pid/pgid/startedAt/command`；回收或 `missing` 均无残留 |

补充：记录「属主不是当前用户」由 `verifyProcRegistryFile` 的 `stat.uid !== getuid()` 检查覆盖。本机测试以同一用户运行，无法在不使用 root 的情况下构造属主不符的文件，故该分支为**代码级校验**，未做运行时用例。

### 12.4 验收数据（本轮）

- `npx tsc --noEmit`：0 error。
- `npx eslint src`：0 error / 0 warning。
- `npx vitest run`（全量）：**26 文件 / 173 用例失败，231 文件 / 2884 用例通过，93 skipped**。逐条核对失败栈，全部为既有 `better-sqlite3` ABI 不匹配（模块按 `NODE_MODULE_VERSION 130` 编译，本机 Node 20 需 `115`）及其 `Database not initialized` 级联；**无一条位于本次新增/修改文件**。
  - 本次新增/修改：`registry-hardening` 7/7、`process-reaper` 11/11、`process-supervisor` 4/4、`run-node` 18/18、runtime 全套 12 文件 / 86 用例通过（3 skipped 为 opt-in 真机门）。
  - 真实 CLI（`BIZGRAPH_REAL_CLI_TEST=1`）：4/4 通过（真 Claude 2 条 + 真 Codex shim 1 条 + gate 1 条）。
  - 既有 ABI 失败：**26 文件 / 173 用例**（环境依赖，不属本次范围）。
- 独立测试台 `spikes/reaper-isolation`（未改断言/实现）：
  - `test:attack`：**2/2 PASS**（C12、C13）。
  - `test:contracts`：**12/12 PASS**（C1–C11 + C5b）。
  - `test:hardening`：**1/1 PASS**（C4b 加强）。
  - `test:sabotage-detection`：**3/3 PASS**（坏实现仍能被抓到，测试台未失效）。

### 12.5 平台边界与未覆盖

- macOS：本轮实测（目录 0700、记录 0600、验签、伪造拒绝、重放、真实 shim/Claude 路径）。
- Linux：代码路径同 POSIX；`/proc` hi-res 逻辑未在本机实测。Linux 下 `chmod`/`kill(-pgid)` 行为一致。
- Windows：目录/文件权限位语义不同（Node 的 `mode` 在 Windows 上不可靠），当前校验以属主/存在性为主；`kill(-pgid)` 已由 `taskkill /T` 替代。**未在 Windows 实测**。
- 属主不符（需 root 构造）、跨用户抢注目录的真实对抗未实测；代码在 `uid` 可得时强制校验，`uid` 不可得（Windows）时依赖路径隔离与签名。
- 同 uid 威胁模型内：攻击者可读安装密钥并伪造合法签名（spike C14/C14b 明确按「预期残余面」记录，PASS）；`unsigned` 身份仍只在 `ppid === 1` 时放行，现状保持不变。

### 12.6 文档待改点（`agent-architecture.md` 由另一会话维护，本节不改）

1. §6.5 需新增自注册记录的**信任模型**：安装级密钥 + 每 spawn nonce + HMAC + 文件 `0600`/属主校验 + 目录 `0700`/symlink 拒绝。
2. 启动清扫必须写明「只处理能映射到 DB 已知 turn/session 的 marker；未知记录仅告警」。
3. 回收成功后必须删除/失效记录，禁止重放；取消路径只读本轮固定 marker，不遍历目录。
4. 记录格式补充 `nonce`、`sig` 字段与 canonical 序列化规则（键排序、`k=v`、缺失字段空串）。

## 13. C13b 修复：shim/记录文件创建不跟随 symlink

### 13.1 问题与根因

- 旧 `ensureCodexSupervisorScript` 直接用 `fs.writeFileSync(target, source, { mode: 0o700 })`。若注册目录内已存在同名 symlink，`writeFileSync` **跟随链接**写入其目标，实测 `victimOverwritten=true`，攻击者可借同 uid 预置链接覆盖任意可写文件。
- shim 自身的记录写入使用固定 `.<pid>.tmp` 名 + `writeFileSync`，同样存在被预置 symlink/临时文件抢占的风险。
- 根因：创建路径没有 `lstat` 预检、没有 `O_EXCL|O_NOFOLLOW`、没有临时文件原子替换，且权限用路径 `chmod` 而非 `fchmod`。

### 13.2 修法

1. **shim 写入**：统一走 `writeFileNoFollow`：
   - 目标已存在且是 symlink → **只删除链接本身**（不触碰其目标文件），随后用原子临时文件重建真实 shim（与 spike C13b 的「链接被替换、受害者不变」断言一致）；
   - 目标已存在且是普通文件 → 仅当「属主当前用户 + 权限 `& 0o077 === 0` + 内容与期望完全一致」时幂等复用，否则拒绝覆盖；
   - 目标已存在且非普通文件 → 拒绝。
2. **临时文件防抢占**：同目录、随机名 `.<name>.<pid>.<16hex>.tmp`，以 `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` 打开；写后 `fchmod`；`rename` 前再次 `lstat` 校验临时文件（普通文件/属主/权限）与目标（被并发创建则拒绝）。
3. **权限**：shim `0700`、记录 `0600`，均用 `fchmod(fd)`；目录仍在创建后 `chmod 0700` 并校验属主。
4. **shim 内记录写入**：内嵌同构 `writeRecordNoFollow`（目标已存在一律拒绝）；shim 启动时对注册目录再做 `lstat`（symlink/非目录/属主不符 → 拒绝写），失败只告警不中断 CLI。
5. **密钥创建**：同样改为 `writeFileNoFollow(0600)`，并发首次创建时重读合法文件。

### 13.3 问题 → 改法 → 测试名 → 实测结果

| 问题 | 改法 | 测试名（registry-hardening） | 实测结果 |
|---|---|---|---|
| 预置同名 symlink 指向受害者 | 删除链接本身 + 原子重建，绝不 follow | `C13b: a pre-placed same-name symlink is replaced without touching the victim` | `victimOverwritten=false`、`shimIsSymbolicLink=false`、shim `mode=700`；spike C13b 同为 PASS |
| 预置同名普通文件 | 内容/属主/权限不匹配 → 拒绝覆盖 | `C13b: a pre-placed same-name regular file is rejected without overwrite` | 抛 `refusing to overwrite existing file`，文件内容保持 `PRE-EXISTING` |
| 预置只读目录（`0500`） | 临时文件 `open` 失败即拒绝 | `C13b: a read-only registry dir is rejected and existing content is untouched` | 抛出 `EACCES`，目录内 `victim.txt` 内容不变 |
| 预置记录路径 symlink | shim 记录写入 `O_EXCL|O_NOFOLLOW` + 目标存在即拒绝 | `C13b: a pre-placed record symlink is rejected by the shim without touching the victim` | 受害者内容 `ORIGINAL` 不变、记录路径仍是 symlink |
| 正向对照 | 干净目录原子创建 + 幂等复用 | `C13b control: a clean registry dir creates the shim atomically and is idempotent` | shim `0700`、内容含 `bizgraph-codex-supervisor`、二次调用同一路径 |

### 13.4 验收数据（本轮）

- `npx tsc --noEmit`：0 error；`npx eslint src`：0 error / 0 warning。
- 本次新增/修改：runtime 全套 **12 文件 / 91 passed / 3 skipped**；`registry-hardening` **12/12**；真实 CLI **4/4**。
- 全量 `npx vitest run`：**26 文件 / 173 用例失败，231 文件 / 2889 用例通过，93 skipped**；失败仍全部为既有 `better-sqlite3` ABI（`NODE_MODULE_VERSION 130` vs 本机 `115`），无本次修改文件。
- 独立测试台：`test:attack` **12/12 PASS**（含 C13b、C14、C14b、C15、C16a–d）、`test:contracts` **12/12 PASS**、`test:hardening` **1/1 PASS**、`test:sabotage-detection` **3/3 PASS**。

### 13.5 已知边界（不在本轮「解决」）

- 同 uid 攻击者可读取 `0600` 安装密钥并铸造合法签名（spike C14/C14b 预期 PASS）。保证仅为「跨用户不可伪造、不可重放」；同 uid 为同一信任域，不构成权限提升。
- `unsigned` 身份仍只在 `ppid === 1` 放行，保持现状。
- `lstat` 与 `rename` 之间仍有极小 TOCTOU 窗口；`rename` 本身原子替换链接名、不会跟随 symlink 写入目标，且同 uid 已属威胁模型内。
- Windows：`O_NOFOLLOW` 语义/权限位不可靠，**未实测**；当前主要依赖 `O_EXCL`、属主存在性校验与签名。

## 14. C17-a 修复：回收动作审计记账

### 14.1 问题

C17-a 中 driver spawn 后抛错，`reap` 实际回收了本轮进程（`killed=1`），但旧逻辑只在 `residualRisk !== 'none'` 时才调用 `recordSessionRecovery`，导致 `recoveryKills=0`、`recoveryNote=null`、`residualRisk=none`。**动作发生了却没有账**，事后无法审计。

### 14.2 修法

1. **计数口径**：异常/取消路径只要执行过 `reap`，无论 `residualRisk` 是否为 `none`，都调用 `recordSessionRecovery`，`kills=report.killed`、`note` 始终写入。
2. **独立审计事件**：复用既有 append-only `agent_events`，新增类型 `process.reclaimed`（不新增大表）。事件与 `residualRisk` 解耦：只要有 kill 或 unresolved，就写一条。
3. **覆盖三条路径**：
   - 取消路径（`cancelTurn`，reason=`cancel`）；
   - 异常退出（`runNode` 的 finally，reason=`abnormal-exit`，含 C17-a）；
   - 启动清扫（session 持久化身份 + 自注册记录，reason=`startup-reclaim`）。
4. **字段（payload）**：`sessionId / turnId / reason / method('pid-tree'|'pgid'|'none') / pids / pgids / success / unresolved[{pid,reason,matched}] / durationMs / evidence[{pid,matched}]`；信封使用既有 `eventId/runId/turnId/seq/type/source='kernel'/fidelity='turn'/payloadVersion=1/timestamp`。
5. **脱敏**：payload 不包含 `command`、路径、密钥、nonce、`sig`；`evidence` 只保留证据项枚举（`startedAt`/`command`/`marker`），不是命令行内容。审计写入失败只记内部告警，不影响回收。
6. **不可证明时**：`success=false`、`method='none'`、`pids=[]`、`unresolved` 明确给出 pid 与 `insufficient-proof`/`unverifiable-record`，不伪造「已回收」。

### 14.3 C17-a 修复后的实测口径

- `recoveryKills = 1`（与实际 `killed=1` 一致）。
- `recoveryNote = "turn failed reclaim: killed=1 unresolved=- missing=- durationMs=<实测> residualRisk=none"`（非空）。
- `residualRisk = none`。
- `agent_events` 中恰好 1 条 `process.reclaimed`，`reason='abnormal-exit'`、`method='pgid'`、`pids/pgids` 含该 pid、`success=true`、`evidence.matched` 至少含 `startedAt` 与 `command`。

### 14.4 问题 → 改法 → 测试名 → 实测结果

| 场景 | 改法 | 测试名（run-node） | 实测结果 |
|---|---|---|---|
| 取消路径 | finally 统一记账 + 审计 | `cancel reclaims a group recorded only in the self-registry (no in-memory handle)` | `recovery_kills=1`、note 非空、恰好 1 条 `reason=cancel`、`method=pgid`、`success=true` |
| 异常退出（复刻 C17-a） | 不再以 residualRisk 作为记账条件 | `reclaims this turn’s registered handle when the driver throws (abnormal exit)` | `recovery_kills=1`、note 非空、`residual_risk=none`、恰好 1 条 `reason=abnormal-exit`、`pids/pgids` 含 pid、证据两项 |
| 启动清扫（可证明） | 每次 `killRegistered` 后按结果审计 | `startup reclaim kills a residual whose persisted identity is provable (P0-2)` | 1 条 `reason=startup-reclaim`、`success=true`、`pids` 含 pid、证据 ≥2 项 |
| 启动清扫（不可证明） | 只写「未回收原因」 | `startup reclaim refuses to kill an unrelated process occupying a persisted pid (P0-A)` | 1 条 `success=false`、`method=none`、`pids=[]`、`unresolved` 含 `insufficient-proof` |
| 正常完成（反向对照） | 不跑 `reap`，不写审计 | `A completing normally must not reap B (same vendor, concurrent sessions) (P0-1)` | `process.reclaimed` 事件数为 **0** |
| 脱敏 | payload 白名单 + 不含命令行 | 同上异常退出用例内断言 | 序列化 payload 不含 `setTimeout`、`process.execPath`、`command:`、`nonce`、`sig`、`secret` |

### 14.5 验收数据

- `npx tsc --noEmit`：0 error；`npx eslint src`：0 error / 0 warning。
- 本次新增/修改：runtime 全套 **12 文件 / 91 passed / 3 skipped**；`run-node` **18/18**；真实 CLI **4/4**。
- 全量 `npx vitest run`：**26 文件 / 173 用例失败，231 文件 / 2889 用例通过，93 skipped**；失败仍全部为既有 `better-sqlite3` ABI（`NODE_MODULE_VERSION 130` vs 本机 `115`），无本次修改文件。
- 未改 `spikes/` 断言、未 commit。

### 14.6 是否可上真机

可以。审计只复用既有事件流，回收路径与信任门未改变；真机 Claude/Codex 4/4 已通过。剩余全量失败为既有数据库 ABI 环境问题，与本轮改动无关。

## 15. 默认开启生效记录（2026-11-05）

- **生效范围**：第六轮真机 5/5 通过后，Kernel 路径默认开启；但只对 `KERNEL_APPROVAL_CAPABLE_BACKENDS = ['claude']` 生效，Codex / OpenCode / 其余后端默认继续走旧路径。
- **实现**：`feature-flags.ts` 新增 `BIZGRAPH_AGENT_KERNEL_BACKENDS`（默认 `claude`，只能收窄）与 `BIZGRAPH_AGENT_KERNEL_UNSAFE`（显式逃生口；强制未具备审批的后端进 kernel 时标 `degraded` 并打 `[kernel-degraded]` warn）；`isAgentKernelEnabled()` 未设置时返回 `true`。`agent-manager` 的两处路由（`sendCommand` / `resolveAndSendCommand`）改为按后端执行器名查策略，未命中白名单即回旧路径。
- **启动日志**：每个后端打印 `[kernel] <adapter>: kernel 路径已启用（写前强制审批）` 或 `[kernel] <adapter>: 旧路径（该后端尚未启用写前审批）`，并汇总总开关/白名单。
- **回退**：`BIZGRAPH_AGENT_KERNEL=0` 重启即可全部回旧路径；代码级一行回退为 `isAgentKernelEnabled()` 直接 `return false`。
- **测试**：`feature-flags-rollout.test.ts` 5 条 + `agent-manager.test.ts` 默认矩阵（claude kernel / codex 旧路径）+ 总开关 0 回归；`agent-manager-restore.test.ts` 的 opencode 恢复用例改为显式 `UNSAFE=1` 才进入 kernel。
- **风险**：codex/opencode 默认仍无写前审批；`UNSAFE` 不得进默认发布；Bash 命令级分级仍属 SDK/CLI。

