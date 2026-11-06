# BizGraph Agent 体系架构（单一权威文档）

> 本文取代以下两份并存设计，后续实现只认本文：
> [agent-system-design.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design.md)（骨干，记为 **A**）、
> [AGENT_ARCHITECTURE_DESIGN.md](file:///Users/zhumingchen/tiangong/AGENT_ARCHITECTURE_DESIGN.md)（补充，记为 **B**）。
> 裁决过程见 [agent-system-design-review.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design-review.md) §6。

**边界摘要（先看这三行）**

- **已验证（spike 实测）**：三后端事件归一化、真 SIGKILL 崩溃恢复、`SESSION_BUSY`/`NODE_BUSY` fail-fast、锁开销、循环归属、审批 fail-closed、Codex 流式粒度与取消真机行为、reaper 跨会话隔离（自发性误杀 12/12、C12 六类伪造 6/6）（见 §16）。
- **未验证 / 有限能力**：Codex 官方 provider 的事件差异、OpenCode 工具轨迹、打包、`better-sqlite3` 高负载、Claude 真 token 增量（见 §16）。**跨重启进程回收只在「可证明归属（≥2 项证据且含 1 项内容证据）」时成立**：macOS 上 env marker 不可见，无法证明归属时只告警、不回收。**同 uid 恶意进程不在防御范围**（实测可读 0600 密钥伪造记录并触发 kill）；仅对**其他本地 uid** 承诺不可伪造、不可重放（见 §6.5）。
- **需产品决策**：是否要排队（`queueDepth=1`）、审批超时时长、Codex 是否默认 `runStreamed`、成本上限口径、长尾 CLI 是否投入工具事件（见 §13）。

> 类型唯一来源 = [spikes/agent-core/src/types.ts](file:///Users/zhumingchen/tiangong/spikes/agent-core/src/types.ts)（已编译通过）。本文只做增量补丁，**不重新定义**信封与枚举，避免再次出现 TS2304。

---

## 0. 结论先行

1. **编排单位是 turn。** 执行器能可靠编排一次 turn，不能可靠编排 turn 内部的工具步骤（调研 §0.2、§2.3.4）。工具步骤只做可观测、可审计。
2. **`run` 是聚合账本，`turn` 是状态机原子。** 持锁、占配额、进唯一索引、被恢复的对象都是 turn；`agent_runs.status` 由 turn 派生，只有投影写入（映射见 §5.2）。
3. **执行器 session 只当句柄。** **M0 前现状**：`SessionState` 只在主进程内存、DB 无 `agent_sessions`、`thread.sessionId` 重启后悬空 `[代码：database.ts L367-L680；threadStore.ts L56-L62]`。M0 已新增 `agent_sessions`（见 §4.2），该问题不再是现状。
4. **审批必须写前拦截；做不到的后端显式降级，UI 说真话。** 现有 `ConfirmationDialog` 消费 `PostToolUse` 的 `file_change`，是写后记账 `[代码：claude-code.ts L237-L268]`。`postHoc=true` 的事件永远不能支撑「确认后执行」的 UI。
5. **事件归属由显式 `correlation` 决定，禁止用栈顶推断。** 现状 `outputSessionStack` 取栈顶 `[代码：base.ts L53-L55、L459-L461]`，且每个 adapter 名全进程单实例 `[代码：ipc-handlers.ts L116-L131]`。
6. **恢复边界 = 最后一个已持久化事件 + `stepOutcomes` 对账。** 不承诺「恢复到任意步骤」（B §0.4 的该承诺已被 spike 否定）。
7. **并发以 fail-fast 为准。** 第二个并发 turn 立即 `SESSION_BUSY`；同节点第二个非终态 turn 立即 `NODE_BUSY`。排队不是既定行为。
8. **共存 + 绞杀，不重写。** `AgentManager` 保留门面；12 个适配器保留，由 `AdapterBackendDriver` 包装（`LegacyAdapterExecutor` 仍是计划抽象，未建文件）；`RequestQueue` 废弃。
9. **完成信号以后端 `turn.completed` 为准，不以迭代器结束为准。** Codex 实测在最后一条事件后仍有 ~10s 关机开销（阻塞式同样存在）；等流结束会白等 10 秒。

---

## 1. 术语（唯一口径，与 spike 一致）

| 术语 | 定义 |
|---|---|
| `run` | 一次执行请求，`agent_runs` 聚合行，**不是状态机** |
| `turn` | 执行器的一次 `send`，**状态机唯一原子** |
| `attempt` | 同一节点同一 `branch_key` 的第 N 次执行 |
| `step` | turn 内可审计执行单元（不承诺可恢复） |
| `seq` | run 内全序（信封字段，恢复回放用） |
| `turn_seq` | turn 内局部序号（仅落库，幂等与断号校验用） |
| `fidelity` | `token \| turn \| session`：**粒度**，不是真实度 |
| `source` | `backend \| kernel \| synthetic`：**谁产生的** |
| `event.type` | 信封判别字段（spike 已补，B 的信封漏了） |

**为什么用 `fidelity = token|turn|session` 而不是四个「真实度」值**

早前评审建议 `exact/aggregate/synthesized/opaque`，但 spike 的 `types.ts` 已经用 `token|turn|session` 落地并通过编译。两套并存必然产生第三个口径，所以本文以 spike 为准，并用 `source` 承担「谁产生」这一维：

| 组合 | 含义 |
|---|---|
| `source=backend + fidelity=token` | 后端原生给出回合内增量（逐 token / 逐块 / 逐 item） |
| `source=backend + fidelity=turn` | 后端只在回合结束给出一整块 |
| `source=synthetic + fidelity=turn` | 宿主从磁盘 diff / ScopeGuard 推导，非 vendor 产物 |
| `source=kernel` | 宿主生命周期事件（`turn.started`、审批、对账结果） |
| `fidelity=session` | 只有会话级信息，连回合边界都不清晰 |

这不是降级——`token|turn|session` 描述「能看见多细」，`source` 描述「谁说的」，两者合起来比原来的四值枚举表达力更强，且少一个漂移字段。

---

## 2. 分层与依赖规则

```
L6 UI 投影（src/renderer）            只消费 AgentEventEnvelope + 投影快照，不 import SDK
L5 审批与策略（src/main/agent/runtime/approval） PolicyEngine / ApprovalStateMachine / fail-closed
L4 编排（src/main/agent/runtime）      AgentRuntime / LockRegistry / RecoveryPlanner
L3 归一化（src/main/agent/runtime/normalize）  3 个 Normalizer + sink：分配 seq、标注 fidelity/source
L2 执行器（src/main/agent/runtime/executors）  AdapterBackendDriver（`LegacyAdapterExecutor` 为计划）
L1 执行器（进程外/库内）               Claude SDK / Codex SDK / OpenCode / 12 个适配器
L0 持久化（src/main/agent/runtime/db）  append-only 事件日志是审计与恢复的唯一依据
```

依赖规则：renderer 不 import SDK/child_process；L1/L2 不 import renderer；L4 只读 `AgentEventEnvelope`；L5 的拒绝必须在 `runTurn` 之前或 permission callback 内；L0 不得反向依赖 L4/L5。

| 现有组件 | 处置 |
|---|---|
| `AgentManager` | 保留门面；`sendCommand` 前置 `tryAcquire`，再走 shim |
| `BaseAdapter` + 12 适配器 | 保留；当前由 `AdapterBackendDriver` 包装（`LegacyAdapterExecutor` 为计划） |
| `AdapterRegistry` | 只扩 `AgentCapabilities` |
| `RequestQueue` | **废弃**（按 adapterName 分组，且仅测试引用 `[代码：request-queue.ts L143-L150]`） |
| `send-and-wait` 旁路 | 必须走 `TurnRequest` 并保留 `transparentForward` `[代码：send-and-wait.ts L27-L61；agent.ts L59-L64]` |

---

## 3. 类型

### 3.1 唯一来源（spike，逐字）

```ts
// spikes/agent-core/src/types.ts（已通过编译；此处只摘核心）
export type BackendName = 'claude-code' | 'codex' | 'opencode'
export type EventFidelity = 'token' | 'turn' | 'session'
export type EventSource = 'backend' | 'kernel' | 'synthetic'

export interface BackendRef {
  name: string
  sessionId?: string
  nativeType?: string
}

export interface AgentEventEnvelope<T = unknown> {
  eventId: string
  runId: string
  /** run 内单调递增，从 1 开始；连续性由持久化层校验 */
  seq: number
  turnId: string
  stepId?: string
  type: AgentEventType            // spike 显式补上，B 信封漏了判别字段
  ts: number
  payload: T
  source: EventSource
  fidelity: EventFidelity
  backend: BackendRef
}

export interface BackendCapabilities {
  eventFidelity: EventFidelity
  loopOwnership: 'backend' | 'host'
  toolEvents: 'exact' | 'derived' | 'none'
  approval: 'native' | 'hook' | 'policy-only'
  cancel: 'abort' | 'kill' | 'cooperative' | 'none'
  resume: 'native' | 'replay' | 'none'
  reasoning: boolean
  parallelToolCalls: boolean
  streamingText: boolean
}
```

`AgentEventType` 与 `CHECKPOINT_TYPES` 见 spike 文件；checkpoint 序列由 harness 断言，不在本文重复。

### 3.2 增量补丁（本文新增，已随 spike 类型编译通过）

```ts
import type {
  AgentEventEnvelope, BackendCapabilities, RiskLevel,
  ApprovalDecisionValue, ApprovalResolvedBy, StepDispositionRecord, RecoveryPlan,
} from './types'

export type TurnStatus =
  | 'queued' | 'running' | 'waiting_approval' | 'cancelling'
  | 'completed' | 'failed' | 'cancelled' | 'orphaned'

export interface TurnCorrelation {
  readonly runId: string
  readonly turnId: string
  readonly sessionId: string
  readonly nodeId?: string
  readonly stepId?: string
}

/** 归属必填：由执行器上下文给出，不允许由栈顶推断 */
export interface RawExecutorEvent {
  vendor: string
  receivedAt: number
  payload: unknown
  readonly correlation: TurnCorrelation
}

/** 只在 spike 的 BackendCapabilities 上补两个正交轴，不重复定义枚举 */
export interface AgentCapabilities extends BackendCapabilities {
  toolExecution: 'backend' | 'host'
  sessionPersistence: 'executor' | 'none'
}

export interface ExecutorSessionHandle {
  readonly executor: string
  readonly sessionId: string          // = agent_sessions.id
  readonly executorHandle?: string    // vendor 句柄：Claude session_id / Codex thread.id
  readonly capabilities: AgentCapabilities
  readonly pid?: number               // 宿主可拿到时必须暴露
  readonly pgid?: number              // 用于取消时 kill 整个进程组
  readonly startedAt?: number         // 跨重启归属校验：pid 启动时间
  readonly command?: string           // 跨重启归属校验：启动命令行
  readonly envMarker?: string         // 仅同进程关联，不作跨重启凭证
}

/** 步骤级状态：中断后没有终态事件的 item 收纳为 aborted；连 started 都没有的极端情况为 unknown */
export type StepStatus =
  | 'requested' | 'awaiting_approval' | 'approved' | 'denied'
  | 'running' | 'done' | 'failed' | 'aborted' | 'unknown'

export type TurnCancelReason = 'user' | 'timeout' | 'shutdown'

/**
 * BackendDriver 契约（Codex 真机实测后新增的三条硬约束）
 * 1. completionSignal='backend-turn-completed'：后端给了 turn.completed 就必须以它为准，
 *    不得等待 AsyncIterable 结束或进程退出（Codex 实测迭代器额外阻塞 ~10s）。
 * 2. cancel 必须在流没有自然结束时也返回；残留由宿主按真实句柄兜底，SDK 后端只承诺收敛并标 residualRisk。
 * 3. 能拿到 pid/pgid/启动时间/命令行时必须暴露；SDK 不暴露时只能记录 env marker 供同进程排障，
 *    跨重启不得用它做认领凭证（§6.5）。
 */
export interface BackendDriverContract {
  readonly name: string
  readonly capabilities: AgentCapabilities
  readonly completionSignal: 'backend-turn-completed' | 'iterator-end'
  cancel(handle: ExecutorSessionHandle, reason: TurnCancelReason): Promise<void>
  /** 可选：同进程内按真实 pid/pgid 回收；不得按持久化裸 pid 或 env marker 跨重启认领 */
  reap?(handle: ExecutorSessionHandle): Promise<void>
}

export interface TurnRequest {
  turnId: string
  runId: string
  graphId: string
  nodeId: string
  idempotencyKey: string
  attempt: number
  sessionId: string
  executor: string
  prompt: { stable: string; turn: string; command: string }
  scope: ScopePolicy
  budget: TurnBudget
  approvalPolicy: ApprovalPolicyRef
  resume: ResumeIntent
  groupId?: string
  parentTurnId?: string
  branchKey: string
  deadlineAt?: number
  /** A2A 透明转发：true 时 pre-turn 不得注入 scope / memory / 项目上下文 */
  transparentForward?: boolean
}

export interface TurnOutcome {
  turnId: string
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  /** 恢复对账的唯一输入，来自 spike 的 StepDispositionRecord */
  stepOutcomes: StepDispositionRecord[]
  artifacts: ArtifactRef[]
  usage?: UsageSnapshot               // M0 无 usage 表时为空，不得用 0 伪造
  approvalStats: { requested: number; allowed: number; denied: number; timedOut: number }
  executorHandle?: string
  lastSeq: number
}

export interface ApprovalDecisionInput {
  approvalId: string
  turnId: string
  argsHash: string                    // spike 的 ApprovalRow 缺此列，必须补
  decision: ApprovalDecisionValue
}

export interface ApprovalDecision {
  approvalId: string
  turnId: string
  argsHash: string
  decision: ApprovalDecisionValue
  decidedBy: ApprovalResolvedBy | 'policy' | 'system'
  decidedAt: number
}

export interface ApprovalBridge {
  request(payload: ApprovalRequestPayload, signal: AbortSignal): Promise<ApprovalDecision>
}

export interface ExecutorRunContext {
  readonly correlation: TurnCorrelation
  readonly signal: AbortSignal
  readonly approvalBridge?: ApprovalBridge
  readonly onExecutorHandle?: (handle: string) => void
  readonly onBeforeToolExecute?: (stepId: string) => Promise<void>
}

export interface LockHandle {
  readonly key: string
  readonly turnId: string
  readonly nested: boolean            // true=真正的重入，release 为空操作
  release(): void
}

export interface SessionLockRegistry {
  tryAcquire(key: string, turnId: string): LockHandle | null
  acquire(key: string, opts: { turnId: string; timeoutMs: number }): Promise<LockHandle>
  isBusy(key: string): boolean
}

export interface RecoveryPlanV2 extends RecoveryPlan {
  expectedArtifacts: ArtifactRef[]
}

export interface OrphanedTurn {
  turnId: string
  runId: string
  lastSeq: number
  lastStepId?: string
  approvedStepIds: string[]
  executingStepIds: string[]
}
```

`ScopePolicy` / `TurnBudget` / `ApprovalPolicyRef` / `ArtifactRef` / `ResumeIntent` / `ApprovalRequestPayload` / `WorkspaceLease` / `NodeExecutor` 等见补丁全文，字段与本文 §4–§9 一一对应。

### 3.3 编译验证

```
tsc --noEmit --strict --target ES2022 --lib ES2022,DOM --module esnext --moduleResolution bundler patch-check.ts
→ EXIT=0
```

`patch-check.ts` 直接 `import type` 自 spike 的 `types.ts`，证明补丁**不重新定义**信封、不引入未定义标识符（这正是 B 的 11 处 TS2304 的成因）。

---

## 4. 数据模型

### 4.1 迁移（必须先做对）

`database.ts` 是版本化迁移：**当前 `CURRENT_SCHEMA_VERSION = 23`** `[代码：database.ts L366]`（v21 成本账本、v22 `agent_events.step_id`、v23 `cost_status/tokens_reported`）、checksum 文件 `[L722-L746]`、迁移事务内关 FK `[L768-L779]`。历史版本：M0 起点 v17 → D1 落地 v20 → M1 到 v23。迁移五步：新表入 `TABLE_SCHEMAS`；索引入 `INDEX_SQLS`；不改旧表列；用真实旧库副本跑并断言旧表行数与 hash 不变；逐版本增量迁移（见 §4.4.3）。

### 4.2 DDL

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, node_id TEXT, graph_id TEXT,
  executor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK(status IN ('created','running','awaiting_approval','cancelling',
                     'interrupted','completed','failed','cancelled')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, graph_id TEXT, node_id TEXT, thread_id TEXT,
  executor TEXT NOT NULL, runtime_session_id TEXT, executor_handle TEXT,
  executor_pid INTEGER, executor_pgid INTEGER,   -- 仅同进程回收用；终态必须清空
  executor_started_at TEXT, executor_cmd TEXT,   -- 跨重启归属校验（pid 复用防护）
  executor_env_marker TEXT,                      -- 仅同进程轮次关联/日志，不作跨重启凭证
  residual_risk TEXT NOT NULL DEFAULT 'none'
    CHECK(residual_risk IN ('none','possible','unconfirmed')),
  recovery_note TEXT,                            -- 无法确认残留时的可读说明
  status TEXT NOT NULL DEFAULT 'starting'
    CHECK(status IN ('starting','active','idle','orphaned','closed')),
  workspace_mode TEXT NOT NULL DEFAULT 'shared'
    CHECK(workspace_mode IN ('shared','worktree')),
  workspace_path TEXT, last_turn_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,              -- 指向 agent_sessions.id
  graph_id TEXT, node_id TEXT NOT NULL,
  group_id TEXT, parent_turn_id TEXT,
  branch_key TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN (
    'queued','running','waiting_approval','cancelling',
    'completed','failed','cancelled','orphaned')),
  resume_mode TEXT NOT NULL CHECK(resume_mode IN ('native','replay','fresh')),
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL, output_json TEXT,
  failure_class TEXT, error_code TEXT,
  started_at INTEGER, ended_at INTEGER, deadline_at INTEGER,
  created_at INTEGER NOT NULL,
  retention_hold INTEGER NOT NULL DEFAULT 0, -- 遗留列：已无生产写入方，保留清理策略不看它（§4.7）
  UNIQUE(idempotency_key)
);

CREATE TABLE agent_steps (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL, tool_name TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'requested','awaiting_approval','approved','denied','running','done','failed','aborted','unknown')),
  args_hash TEXT, result_ref TEXT,
  fidelity TEXT NOT NULL CHECK(fidelity IN ('token','turn','session')),
  test_disposition TEXT,                  -- spike 的 StepDispositionRecord 落库位
  approved_at INTEGER, executing_at INTEGER, started_at INTEGER, ended_at INTEGER,
  UNIQUE(turn_id, seq)
);

CREATE TABLE agent_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                   -- 信封 seq（run 内全序）
  turn_seq INTEGER NOT NULL,              -- turn 内局部序号
  type TEXT NOT NULL,                     -- 信封 type
  source TEXT NOT NULL CHECK(source IN ('backend','kernel','synthetic')),
  fidelity TEXT NOT NULL CHECK(fidelity IN ('token','turn','session')),
  payload_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(run_id, seq), UNIQUE(turn_id, turn_seq)
);

CREATE TABLE agent_approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn_id TEXT NOT NULL, step_id TEXT,
  tool_name TEXT NOT NULL, args_json TEXT NOT NULL,
  args_hash TEXT NOT NULL,                -- 审批与参数绑定；缺此列则 TOCTOU 不可检测
  risk TEXT NOT NULL CHECK(risk IN ('low','medium','high','critical')),
  policy_decision TEXT NOT NULL CHECK(policy_decision IN ('allow','deny','ask')),
  status TEXT NOT NULL CHECK(status IN ('pending','allowed','denied','superseded')),
  decided_by TEXT CHECK(decided_by IN ('user','policy','timeout','system','startup')),
  decided_at INTEGER, decision_note TEXT,
  expires_at INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'interactive' CHECK(mode IN ('interactive','unattended')),
  timeout_ms INTEGER NOT NULL DEFAULT 120000,
  cwd TEXT,                               -- 会话级授权的路径边界（realpath 归一后写入）
  grant_source TEXT,                      -- 自动放行的授权来源；用户单次决定时为 NULL
  created_at INTEGER NOT NULL
);

CREATE TABLE agent_artifacts (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, node_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('diff','file_snapshot','command_output','summary','test_report')),
  path TEXT, content_hash TEXT,
  base_hash TEXT,                         -- turn 起始快照；用于检测「钩子未触发」
  storage TEXT NOT NULL CHECK(storage IN ('inline','file','git')),
  storage_ref TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE agent_usage (
  id TEXT PRIMARY KEY,
  turn_id TEXT,                             -- legacy 路径无 turn，可空（不瞎猜归属）
  session_id TEXT NOT NULL, executor TEXT NOT NULL,
  graph_id TEXT, node_id TEXT, model TEXT,  -- 归属 + 计价维度
  day_key TEXT NOT NULL,                    -- 本地日，时区固定 Asia/Shanghai（见下）
  input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,  -- NULL=后端未上报
  cache_creation_input_tokens INTEGER,                                        -- 写缓存，单列（不与读缓存合并）
  currency TEXT NOT NULL DEFAULT 'USD',
  cost_usd REAL NOT NULL DEFAULT 0,         -- 兼容列（UI 沿用）
  cost_micros INTEGER,                      -- NULL=缺价 unknown，不产生错误金额
  price_version TEXT,                       -- 计价所用价格表版本，事后可解释
  is_estimate INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK(source IN ('provider','estimated','unknown')),
  cost_status TEXT CHECK(cost_status IN ('priced','missing_price','not_reported')),  -- v23：可查的定价分类；历史行留 NULL
  tokens_reported INTEGER,                  -- v23：1 上报 / 0 未上报 / NULL 无 token 概念或历史未标注
  attribution_note TEXT,                    -- thread_not_bound / missing_price:* / backend_reports_no_usage
  dedupe_key TEXT,                          -- 幂等键：turn:<id> / bev:<adapter>:<eventId>
  recorded_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_agent_usage_dedupe ON agent_usage(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_agent_usage_graph_day ON agent_usage(graph_id, day_key);
CREATE INDEX idx_agent_usage_turn ON agent_usage(turn_id);

CREATE TABLE agent_snapshots (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  state_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, seq)
);

CREATE INDEX idx_turns_node ON agent_turns(node_id, created_at DESC);
CREATE INDEX idx_events_kind ON agent_events(type, created_at DESC);
CREATE INDEX idx_approvals_pending ON agent_approvals(turn_id, status, expires_at)
  WHERE status='pending';
```

**不设外键。** 现有连接已 `foreign_keys = ON` `[代码：database.ts L46]`，B 的 `ON DELETE CASCADE` 会级联删除事件、审批与快照，摧毁审计事实。

### 4.3 节点互斥：M0 只做 fail-fast

M0 唯一索引：

```sql
CREATE UNIQUE INDEX ux_turns_active ON agent_turns(node_id, branch_key)
  WHERE status IN ('running','waiting_approval','cancelling');
```

第二个非终态 turn 插入即失败 → 返回 `NODE_BUSY`（spike V4 已实测）。`branch_key` 是普通列，主干为 `''`，M2 的分支可用不同值并行。

### 4.4 成本账本（M1）

**前提（如实承认）**：M1 之前不存在 turn 级 usage 落库，历史成本不可回填；账本从上线时刻开始记，之前是空白。

**字段为何现在就要有**（后补任意一个都要迁表）：

- `graph_id / node_id / session_id / turn_id / day_key`：额度（graph × day 双层）与成本归属的最小维度集；`turn_id` 可空——legacy 路径没有 turn 概念，归不上就如实留空。
- `input/output/cached_input_tokens` 三列分列且可空（NULL=后端未上报，与 0 区分）；缓存命中与全新输入价格不同，合并成一列就无法计价。`cache_creation_input_tokens`（Claude 写缓存）单独一列，不与 `cached_input_tokens`（读缓存）合并；内置价表没有 cache-write 档位时按输入单价计。
- `cost_micros INTEGER` 可空：整数微单位避免浮点误差；**NULL=缺价 unknown**——查不到价格时绝不拿别的模型价格瞎算。
- `currency` + `price_version`：每次计价记录所用价格表版本（`builtin-2026-11-05` / `settings:rates` / `settings:rates:<executor>:<model>` / 外部文件版本），否则日后无法解释「这轮为什么是这个钱」。
- `source`：`provider`=后端上报的真实用量 / `estimated`=估算 / `unknown`=后端未上报。三者在汇总里分列，报表看得出真假。
- `attribution_note`：归属与缺价原因留痕（`thread_not_bound`、`missing_price:<executor>/<model>`、`backend_reports_no_usage`），不许瞎猜。
- `dedupe_key`：幂等键，部分唯一索引（`WHERE dedupe_key IS NOT NULL`）防重复上报重复计费。

**day_key 时区**：固定 `Asia/Shanghai`（`Intl.DateTimeFormat` 指定，不随运行机器时区漂移）。同一笔用量在任何机器上落入同一本地日，额度/报表口径一致。

**计价优先级（2026-11-05 修正）**：查价分三层，由 `resolvePrice()` 按顺序命中：

| 优先级 | 来源 | 命中条件 | 写入 `price_version` |
|---|---|---|---|
| 1（最高） | `settings.agentRuntime.costRates` | 按 `models[]` 精确/前缀匹配，或全局 `inputPerMillion`/`outputPerMillion`（等价 `executor:'*', model:'*'`） | `settings:rates`（全局）/ `settings:rates:<executor>:<model>`（按模型） |
| 2 | `BIZGRAPH_PRICING_PATH` 指向的 JSON | 文件合法时整体替换内置表 | 文件里的 `version` |
| 3 | 内置表 `BUILTIN_PRICING` | 精确 → dated 前缀 | `builtin-2026-11-05` |
| — | 都没命中 | — | `NULL` + `cost_micros=NULL` + `missing_price` |

- **用户配置优先于内置表**：同一 (executor, model) 两层都有价时取用户配置，`price_version` 以 `settings:rates` 开头，事后能分辨这行按谁的价格算的。
- **未配置的模型回落**：`costRates.models` 只覆盖列出的模型，其余落在第 2/3 层；不是拿一个配置价套所有模型。
- **两层都缺不猜价**：`cost_micros=NULL` + `cost_status='missing_price'`，汇总不计入 `knownCostMicros`，UI 显示「价格未知」。
- 历史行的 `price_version` 里可能还留有已废弃的 `runtime-rates`（旧实现把用户单价当成整体替换表），它同样是「用户配置」来源，读旧数据时按用户价理解即可。

**计价**：`cost/pricing.ts` 负责按 (executor, model) 匹配（精确 → dated 前缀），**内置表无通配兜底**；`BIZGRAPH_PRICING_PATH` 可指向 JSON 整体覆盖内置表；`settings.agentRuntime.costRates` 作为最高优先级层叠加在上面（见上表）。缺价 → `cost_micros=NULL` + `missing_price` 标注。

**幂等与升级**：`UsageLedger.record()` 命中 `dedupe_key` 时——已有 provider 行直接返回；已有 estimated/unknown 行被迟到的 provider 真实用量**升级覆盖同一行**（kernel 路径先落 unknown、result 事件再带真实 usage 的场景）。

**落库链路**：kernel 路径由 `AgentRuntime` 在 turn 完成时写（`turn:<turnId>` 去重）；legacy 路径由 `SessionLifecycleManager` 订阅适配器 `onUsage` → `AgentManager.recordAdapterUsage` 归属 `chat_threads.session_id → graph_id/node_id` 后写入。**同一轮只允许一个记账 owner**：kernel 正在为某会话执行时（`AgentRuntime.hasActiveTurn(sessionId)`，内核用 `Map<sessionId, count>` 引用计数——只有 0→1 登记、1→0 清理；重叠调用/`SESSION_BUSY` 失败不得清掉在途标记），适配器仍会透传的 legacy 上报被直接丢弃，不靠 dedupe 合并两条不同 key 的记录（legacy key 是 `legacy:<adapter>:<session>:<turnSeq>` / `bev:<adapter>:<eventId>`，与 `turn:<turnId>` 天然不同）；kernel 未在执行的会话照常走 legacy，不同轮不会互相误合并。适配器一轮结束未上报 usage 时，lifecycle 合成 `source=unknown` 占位——不静默丢。**kernel 侧同样不落 0 值行**：result 的四项 token 全 0 视为「后端没给用量」，按 `source=unknown`（`backend_reports_no_usage`、token 列 NULL）处理，与 legacy 口径一致，避免 0 值行被 UI 当成「真实 $0.00」。

**只读查询**：`summarizeGraphDay(graphId, dayKey)`（knownCostMicros / unknownCostRows / provider / estimated / unknown 行数分列）与 `listByTurn(turnId)`，另有 `listEvents` / `listStepEvents` 供时间线使用。全部只读，不参与是否放行的判断。

#### 4.4.1 产品决定：M1 只记账，不熔断（2026-11-05）

**决定**：M1 阶段账本只记录、只展示，**不做任何强制限额、不拒单、不中断 turn**。界面文案不得出现「限额」「剩余额度」「超限」「可用额度」等字样；只能出现「用量」「估算」「价格未知」「后端未上报」「历史行未标注」这类事实描述。这条是产品已定的口径，不是待办。

**为什么现在不熔断**：

- 账本从上线时刻才开始有数据，样本里既有 provider 实测、estimated、unknown，也有 NULL 分类的历史行，**没有可信的真实成本分布**；
- 在分布未知时定阈值，只会把阈值定错：定高了等于没有，定低了会在正常使用中误杀 turn，且用户无法用现有数据解释「为什么被拦」；
- 熔断是**不可逆的用户体验动作**（打断正在执行的任务），错误代价远高于晚做几步。

**已删除的成本准入分支（2026-11-05）**：`AgentRuntime` 的 `limits` 构造参数、`assertCostAdmission` 预检、`CostLimitExceededError`、`settings.agentRuntime.limits` 字段均已删除；`ipc-handlers` 不再透传 limits。旧 `settings.json` 里若残留 `agentRuntime.limits`，读取时会被忽略，不会导致启动失败。当前**不存在任何成本准入拦截**：账本只记录，`runNode` 不会因成本拒绝新 turn（守护测试：`never rejects a turn for cost, even when a legacy limits config is injected`）。

**重新评估的触发条件**（满足任一条才重新讨论熔断，届时用真实数据定阈值）：

| 触发条件 | 占位 / 判定方式 |
|---|---|
| 连续记录满 **N 天**（`N = TBD`，上线后按数据回填具体天数） | 统计 `agent_usage` 中出现 `cost_status='priced'` 的日数 |
| 单图单日金额超过 **X**（`X = TBD`，以真实分布的高分位为候选） | 用 `summarizeGraphDay` 的 `knownCostMicros` 观测，先记录不拦截 |
| 用户显式要求配额/告警 | 产品需求驱动，直接进入评估 |
| 出现可复现的成本失控事件 | 人工上报 + 账本复核 |

以上 N / X 均为**明确占位**，不写「后续再说」这类空话；在触发前，M1 的行为就是只记账。

#### 4.4.2 账本当前的已知空白（如实列出）

1. **上线前的历史不可回填**：M1 之前没有 turn 级 usage 落库，此前花费永远是空白，不做任何估算补值。
2. **未上报 model 的后端缺价 → 金额为 NULL**：查不到 (executor, model) 价格时刻意不套用近似价格，`cost_micros=NULL`，UI 显示「价格未知」而不是 `$0.00`。
3. **失败 turn 若未上报即不记**：后端在失败路径没有回传 usage 时不写行，账本上就是没有这笔，不推测。
4. **legacy 行无 `turn_id`**：legacy 路径没有 turn 概念，`turn_id=NULL`；UI 显示「未归属 turn」，不伪造 id。
5. **后端不报 token 时 token 不可知**：`input/output/cached_input_tokens` 为 NULL，`tokens_reported=0`；不等于 0 token，UI 不补 0。
6. **历史行的分类列可以是 NULL**：v23 之前写下的旧行 `cost_status` / `tokens_reported` 为 NULL，不从 `attribution_note` 文本反推；UI 统一显示「历史行未标注 …」，并单独计数，绝不并入「已定价」「已上报」。

**仍然缺省的展示语义**：`cost_status IS NULL` 的行即使有 `cost_micros`（旧行确实可能带金额），也只展示金额 + 「历史行未标注定价状态」，不宣称它是 `priced`。

#### 4.4.3 v23 迁移证据（真实构建产物 + 真实 Electron）

- **旧库形态**：`schema_version=21`；`agent_usage` 4 行（含 priced / 缺价 / unknown / 无 `turn_id` 各一条）；`agent_events` 无 `step_id`；`agent_turns`、`agent_sessions`、`agent_steps`、`agent_approvals` 均缺后加列。
- **运行方式**：Playwright `_electron` 启动 `dist-electron/main/index.js`（非测试替身，真实构建产物），`--user-data-dir` 指向临时目录；主进程日志显示 `Migrating schema from v21 to v23` → 逐表 rebuild + restore → `Schema migrated to v23`。
- **结果**：`version=23`、`integrity_check=ok`、`foreign_key_check=[]`；`agent_usage 4→4`、`agent_events 2→2`、`agent_turns 1→1`、`agent_sessions 1→1`；`cost_micros 6000/1000`、`price_version=test-v1`、token 数值、`turn_id`（含 NULL）逐条一致；`cost_status` / `tokens_reported` / `step_id` 在旧行上为 NULL；`idx_agent_events_step`、`idx_agent_usage_graph_day` 等索引存在；`listEvents` 返回 2 条、`listStepEvents` 返回 0 条不报错；列驱动聚合 `costStatusUnknownRows=4`、`tokensReportedUnknownRows=4`、`knownCostMicros=7000`。
- **幂等**：同一 userData 第二次启动无 migrate / rebuild 日志（仅 `YjsRealtime legacy migration: 0 backfilled / 1 skipped`），checksum 版本 23。
- **证据文件**：[m1-migration-before-v21.db](file:///Users/zhumingchen/tiangong/docs/architecture/evidence/m1-migration-before-v21.db)、[m1-migration-after-v23.db](file:///Users/zhumingchen/tiangong/docs/architecture/evidence/m1-migration-after-v23.db)、[m1-migration-inspect.json](file:///Users/zhumingchen/tiangong/docs/architecture/evidence/m1-migration-inspect.json)、[m1-migration-launch-1.log](file:///Users/zhumingchen/tiangong/docs/architecture/evidence/m1-migration-launch-1.log)、[m1-migration-launch-2.log](file:///Users/zhumingchen/tiangong/docs/architecture/evidence/m1-migration-launch-2.log)、`m1-migration-ui-01/02/03*.png`。
- **证据使用说明**：会话级截图（`ui-02`）用的是迁移后 userData 的副本，仅把 `chat_threads.status` 从 `idle` 改为 `active`（`thread:list` 只返回 active），**未改动任何用量行**；其余日志、DB 快照、概览截图均来自未手工修改的迁移产物。缺价的 `gpt-99-nonexistent` 旧行迁移后 `cost_status=NULL`，UI 按设计显示「历史行未标注定价状态」——这是「历史不回填」的直接体现，不是缺价被吞掉。

**排队是 Phase 2 的可选项，不是既定行为。** 若要排队，两条部分唯一索引可同时表达「每节点每分支 1 个活跃 + 1 个等待」：

```sql
CREATE UNIQUE INDEX ux_turns_queue ON agent_turns(node_id, branch_key) WHERE status='queued';
```

实测 `[实测 sqlite3 3.51]`：`running + queued` 通过；第二条 `queued` 被拒；把 `queued` 直接改 `running`（旧 turn 未终结）被拒；不同 `branch_key` 可并行。晋升必须在**同一事务**内「先把旧 turn 置终态，再把 queued 置 running」。**该行为未在 spike 中验证，是否上线待产品定调（§13）。**

### 4.4.4 锁序与事务边界

加锁顺序固定：`WorkspaceLease` → `SessionLock` → DB 事务。四条硬规则：

1. DB 事务内不得 `await`（`better-sqlite3` 同步 API）；
2. 父 turn 派发子 session 允许嵌套持锁，但必须做祖先环检测：目标 key 已在 `held` 中 → 抛 `LOCK_CYCLE`；
3. 不允许持 A 锁等待 B 锁，除非 B 是 A 的后代；
4. `seq` 在写事务内分配，不在缓冲时分配（见 §9.4）。

### 4.5 幂等键

```
# 调用方显式给了 idempotencyKey（重试同一请求）：
key = agentSessionId + ':' + idempotencyKey

# 否则（每次派发都是新执行）：
key = dispatchScope + ':' + agentSessionId + ':' + nodeId + ':' + branchKey
      + ':' + attempt + ':' + sha256(prompt)
其中 dispatchScope = runId（有 run 时）或 `dispatch:<uuid>`（无 run 时）
```

- **会话前缀强制存在**：即使调用方复用同一 `idempotencyKey`，跨会话也不会命中（查找同样带 `session_id` 过滤，是第二道防线）。
- `dispatchScope` 为一次性 UUID：kernel 每次派发（`command.id` 或随机 UUID）落入其中，**同会话同 prompt 的第二次发送必然产生新 turn**，不会被上一次已终态 turn 静默复用。
- `attempt` 入键：重跑是新 turn，同 attempt 的重投才去重；
- `executor` 入键：换后端就是新执行（当前 runtime 以 adapter executor 决定驱动，键里保留节点/分支维度即可复现等价语义）；
- attempt 分配与 INSERT 在同一 `BEGIN IMMEDIATE` 内，避免并发抢同一 attempt。

### 4.6 Bash 两档策略（P3）

Bash 的放行判断不再交给 Claude SDK/CLI 内部的分级，改由宿主自己的规则在 `PreToolUse` hook 给出显式决定（`src/main/agent/runtime/approval/bash-readonly.ts`）。产品口径是**危险决定交给用户，软件不做限制**：

| 判定 | 输出 | 行为 |
|---|---|---|
| 命中「命令 + 参数」白名单 | `permissionDecision: 'allow'` | 免弹直接执行（**不再返回 `{}` 让 SDK 决定**） |
| 其余一切（含危险参数、危险构造、不可解析） | `permissionDecision: 'ask'` | 强制回到我们的审批网关（`canUseTool`），用户决定 |
| 唯一例外：空命令/空白命令 | `permissionDecision: 'deny'`（策略值 `blocked-empty`） | 没有内容可审批，不放行并记审计 `empty-command` |

白名单只含确定性只读命令：`ls/pwd/cat/head/tail/wc/grep/rg/stat/file/du/df/which/whoami/uname/date/echo/find`、`node --check`、git 读子命令（`status/log/diff/show/rev-parse/blame/ls-files/…`，`branch/remote/stash/tag` 仅放行列举形态）。

**`git grep` 已从白名单移除（一律 ask）**：它的语义本身允许把命中文件交给外部 pager 执行（`-O` / `--open-files-in-pager`），而短选项可簇写成 `-iOcat` / `-nOcat` / `-wOcat`，用正则枚举短选项簇修一次漏一次。代价只是多弹一次窗，因此整条子命令走 `git-grep`（critical）。同理 `git -p` / `git --paginate`（强制调用 `core.pager`）ask；`git --no-pager` 只是关闭分页、不执行外部程序，放行并继续判定其后的子命令。

**白名单里其它「名字像只读、语义能执行/写盘」的复核结论**：

| 命令/选项 | 判定 | 理由 |
|---|---|---|
| `git diff/show/log --textconv`、`--ext-diff`、`--filters` | 已在危险参数表 → ask | 会调用 `diff.<driver>.textconv` / `GIT_EXTERNAL_DIFF` / filter 进程 |
| `git -c`、`--config-env` | 已在危险参数表 → ask | 可覆盖 `core.pager`/`diff.external`/`core.fsmonitor` |
| `git --exec-path` / `--upload-pack` / `--receive-pack` | 已在危险参数表 → ask | 指定外部可执行 |
| `git grep`（任何参数） | 移出白名单 → ask | 见上，`-O` 家族无法靠枚举覆盖 |
| `git -p` / `--paginate` | 新增 → ask | 强制 pager |
| `git log/show --show-signature` | 新增 → ask（`git-show-signature`） | 会拉起 `gpg` 验证签名 |
| `git help <cmd>` / `--help <cmd>` / `help -w/-m/-i` | 收紧为 ask | 调 man/browser；`--web` 会按仓库/用户配置执行 browser 命令 |
| `rg --pre`、`rg -z`/`--search-zip` | 已在危险参数表 → ask | 逐文件执行外部程序 / 解压程序 |
| `find -exec*`/`-delete`/`-fprint*`/`-fls` | 已在危险参数表 → ask | 执行 / 写盘 |
| `node --check` | **仅严格形态 allow** | 只放行 `node --check <file>`（恰好两个参数）；多出任何参数一律 ask |
| `file -C`/`--compile`、`date -s`/`--set` | 已在危险参数表 → ask | 写 magic 文件 / 改系统时间 |
| `echo`/`cat`/`head`/`tail`/`wc`/`stat`/`du`/`df`/`which`/`whoami`/`uname` | 保留 allow | 无外部程序调用、无写盘路径（重定向由 shell 元字符规则拦截） |

**`node --check` 只按严格形态放行**：`--check` 本身只做语法解析，但只要多出参数就可能先加载代码再检查——实测 `node --check -r <file>`，以及 `node --check --env-file <env>`（env 内写 `NODE_OPTIONS=--require`）都会执行探针并写 marker；`--loader` 在 `--check` 下未执行 loader，但同一入口没有理由放行。因此不做选项枚举：只有 `args.length === 2 && args[0] === '--check'` 才 allow，其余（`-r`/`--require`/`--import`/`--loader`/`--env-file`/多文件）一律 `node:run` ask。

**短选项簇按「簇内标志字符」判定**：`isFlagInShortCluster()` 从 `arg[1]` 起逐字符扫描——命中目标标志字符即 ask；遇到「需要取值」的短选项（`SHORT_OPTIONS_WITH_VALUE`，按各命令 `--help` 登记）则剩余字符是它的取值，立即停止扫描。实测边界：`file -bC` / `-cC` / `-zC` → `file-compile`，`rg -nz` / `-iz` / `-wz` / `-lz` / `-Uz` → `rg-search-zip`；而 `file -mC`（C 是 magic 文件名）、`file -bPC`（C 是 `-P` 的参数）、`rg -eC`（C 是 pattern）、`rg -rnz`（`-r` 取值 `nz`，实测 `printf 'abc\n' | rg -rnz abc` 输出 `nz`）仍 allow。

**长选项按「唯一前缀缩写」判定**：GNU `getopt_long` 接受无歧义前缀。实测 `file --comp -m test.magic` / `file --compil -m test.magic` 与 `--compile` 等价（exit 0，写出 7,273,344B `magic.mgc`）。`isAbbreviatedLongFlag()` 的判定是：双方都以 `--` 开头（排除单个 `-` 短选项）、`specFlag.startsWith(flagName)`、且 `flagName.length > 2`；`--flag=value` 先 `split('=')[0]` 取选项名；**大小写敏感**（这些工具的长选项均区分大小写）。

长度下限取 `> 2`（即最短 `--x`，总长 3）的理由：

- `--` 本身长度恰为 2，必须排除（它是选项结束分隔符，不是选项）；
- 长度 3 已能表达任意单字母缩写，而实测 `file --co`（长度 4）就必须覆盖，否则漏判；
- 更长的下限（如 4）会漏掉 `file --c`（实测 file 判为歧义并报错，但策略按「宁可多弹」仍 ask）；下限放到 2 会把 `--` 拉进来并产生无意义匹配，故取 3。

实测唯一前缀接受情况（决定是否真能被绕过）：

| 登记项 | 工具/子命令 | 唯一前缀实测 | 结论 |
|---|---|---|---|
| `file --compile` | file（GNU/BSD） | `--compile`/`--compil`/`--comp`/`--com`/`--co` 均接受；`--c` 报歧义 | **真实绕过，已覆盖** |
| `git fsck --lost-found` | git fsck（parse-options） | `--lost-f` / `--lost` 接受 | **真实绕过，已覆盖** |
| `git --textconv`/`--ext-diff`/`--filters`/`--output=` | git diff/log/show | `--textc`/`--ext`/`--fi`/`--outp=` 均 invalid/unrecognized | 不支持缩写；统一前缀规则只多弹一次 |
| `git --show-signature` | git log/show | `--show-sig` unrecognized | 同上 |
| `git --paginate`/`--config-env`/`--exec-path`/`--upload-pack`/`--receive-pack` | git 全局选项（手写解析） | `--pag`/`--config-en`/`--exec-p`/`--upload-p`/`--receive-p` 均 unknown | 同上 |
| `rg --pre`/`--search-zip` | ripgrep | `--pr`/`--sea`/`--se` unrecognized | 同上 |
| `find -delete` 等 | find | `-del`/`--delete` unknown | 同上 |
| `date --set` | BSD date / GNU date | BSD date 直接 illegal option；GNU date 接受唯一前缀 | 保守按前缀 ask |
| `git --open-files-in-pager` | git grep | N/A | 整条 `git grep` 已移出白名单 |

需要显式 acknowledge 的过严面：`git diff --text` 是独立真实选项（不是 `--textconv`），会被前缀规则多弹一次；这属于安全侧成本，不是漏判。

**`git -c` 按「必须带赋值」收紧**：`git` 全局 `-c` 的真实语义是 `-c <name>=<value>`，不带等号的 `-c` 是子命令选项（`git log -c` = combined diff，只读）。`DangerousArgSpec.requiresAssignment` 标记后，判定会同时看选项自身与紧邻的下一个 token：含 `=` 才按 `git-config-override` ask，否则回落子命令规则。实测 `git -c core.pager=cat status` / `git -ccore.pager=cat status` → ask，`git log -c -1` / `git diff -c` / `git show -c` → allow。缺少等号时 git 自身会报错，因此不会放走任何真实配置覆盖。


**判定是「命令名 + 参数」两段式，不是命令名匹配**（`DANGEROUS_ARGS_BY_COMMAND` + `WHITELIST_COMMANDS`）：

| 命令 | 危险参数（命中即 ask） | 规则 | 风险 |
|---|---|---|---|
| `rg` | `--pre`（含 `--pre=`）、`-z`/`--search-zip` | `rg-pre` / `rg-search-zip` | critical / high |
| `git` | `--output=`、`--ext-diff`、`--textconv`、`--filters` | `git-output-file` / `git-ext-diff` / `git-textconv` / `git-filters` | high |
| `git` | `fsck --lost-found` 及其唯一前缀（`--lost-f` 起） | `git-lost-found` | high |
| `git` | `log/show --show-signature` 及其唯一前缀 | `git-show-signature` | high |
| `git` | `-O` 家族不再单列：`git grep` 整条子命令已移出白名单（`git-grep`, critical） | `git-grep` | critical |
| `git` | `-c`（**仅 `name=value` 形态**）、`--config-env`（可覆盖 `core.pager`/`diff.external`/`core.fsmonitor`；`git log -c` 是 combined diff，不误伤） | `git-config-override` | high |
| `git` | `--exec-path`、`--upload-pack`、`--receive-pack` | `git-exec-path` / `git-upload-pack` / `git-receive-pack` | high / critical |
| `git branch` | 任何位置参数（分支名）= 创建分支；写标志（`-d/-D/-m/-M/-c/-C/-u/-f/--delete/…`） | `git-branch-create` / `git-branch-write` | high |
| `find` | `-delete`、`-exec`、`-execdir`、`-ok`、`-okdir`、`-fprint`、`-fprintf`、`-fls`、`-fprint0` | `find-dangerous` | high |
| `file` | `-C`、`--compile` 及其唯一前缀缩写（`--co` 起；短选项簇 `-bC` 等） | `file-compile` | high |
| `date` | `-s`、`--set`（改系统时间） | `date-set` | high |

覆盖测试 `bash-readonly.test.ts` 会断言 `WHITELIST_COMMANDS`（从实际白名单派生）与 `DANGEROUS_ARGS_BY_COMMAND` **双向一致**，且登记的每个危险参数确实能触发 ask —— 以后新增白名单命令若忘记登记危险参数，测试直接失败。

诚实边界（参数面）：

- `sort -o`、`uniq -o`、`xxd -o`、`awk` 的 `system()`/`print >`、`tar -x`/`--to-command`/`--checkpoint-action`、`less`/`more` 的 `!` **本来就不在白名单**（命令级已是 ask），参数面收紧不改变结论；
- `grep -f` 只是「从文件读取 pattern」，不写盘也不执行程序 → 保持 allow；
- 参数里出现 `$()`、反引号、未闭合引号 → `shell-escape`/`unparseable` → ask；
- **仓库自带配置/钩子不在参数面覆盖范围**：`core.fsmonitor`（`git status` 会调用）、repo hook 等由仓库/用户配置触发，白名单只保证「命令行参数本身不主动执行外部程序」；已通过 `-c`/`--config-env` ask 挡住「在同一条命令里注入配置」的路径；
- 规则是保守的：宁可多弹一次，也不猜参数语义。

其余命令按**危险规则**转审批，规则名与风险等级写入审计与审批卡片：

| 规则 | 触发 | 风险 |
|---|---|---|
| `fetch-and-exec` | `curl/wget … \| sh/bash/python/node/…` | critical |
| `shell-escape` / `shell-escape:<cmd>` | `$()`、反引号；`sudo/su/doas/sh/bash/zsh/eval/exec/xargs/env/…` | critical |
| `pipe` / `redirect` / `and-chain` / `or-chain` / `command-chain` / `background` / `newline` / `subshell` | shell 元字符（整条命令一起审批） | high |
| `write-command:<cmd>` | `rm/dd/truncate/shred`（递归/强制形态 critical，其余 high）、`mv/cp/tee/chmod/…` | critical / high |
| `sed-in-place`、`find-dangerous` | `sed -i`、`find -delete/-exec/-ok/-fprint*` | high |
| `git-write-subcommand:<sub>`、`git-branch-write`、`git-remote-write`、`git-stash-write`、`git-tag-write` | git 写操作 | high |
| `unparseable` | 引号未闭合等无法安全解析 | high |
| `not-in-whitelist:<cmd>` / `node:run` / `git:unknown:*` | 未命中白名单 | medium |

审批卡片要求：必须展示 **rule 名 + policyReason + 完整命令原文（不截断）**，不能只写「高风险」；`ApprovalRequestPayload.policyRule/policyReason` 由同一套确定性规则在网关侧还原（重启重放同样可得）。命令以原始字符串展示（`argsJson.command` 解包），保证 `printf … > ~/.zshrc` 这类关键尾部不会被折叠或省略。

审计：每个决定写入 `agent_events.type='bash.policy'`，payload 含 `command/decision/rule/reason/risk`；对应 step 同步状态（allow→running、ask→awaiting_approval、blocked-empty→denied）。`agent_events` 自 v22 起带 `step_id`（turn 作用域，与 `agent_approvals.step_id` 同一口径，历史行 NULL）：`bash.policy`、`tool.requested/tool.result`、`approval.required/approval.resolved` 都写入同一个 stepId，可由 `AgentRepository.listStepEvents(stepId)` 一次返回该步骤完整序列，不需要调用方拼 `turn_id + seq`。索引为 `(step_id)` 与 `(turn_id, step_id, turn_seq)`。

**诚实边界**：这是可解释、可测试的规则，不是完备沙箱。只约束 Claude 的 Bash 工具入口；不阻止 CLI 经其他工具（如自定义 MCP）执行命令，也不阻止用户在审批卡片上批准任何命令。**旧路径（`BIZGRAPH_AGENT_KERNEL=0`）没有审批网关，仍沿用 SDK 自身策略**——这套两档策略只在内核路径生效。

### 4.7 事件保留与存储统计（P0-2）

**只清事件，不动台账**：

| 表 | 保留策略 |
|---|---|
| `agent_events` | 仅清理**已终态 turn** 中超过保留期的事件 |
| `agent_usage` / `agent_approvals` / `agent_turns` / `agent_sessions` | **永不清理**（成本账本与审计台账必须长期保留） |

清理规则（`AgentRepository.runEventRetention`）：

- 保留期默认 **90 天**，按 `agent_events.created_at` 判定；单批 `DELETE ≤ 500` 行（配置值超过 500 也会被硬压到 500），批与批之间释放锁，避免长事务阻塞其它写入。
- 时间点：启动对账完成后执行一次，之后每 **24h** 一次（`AgentRuntime.startEventRetention`）。
- 永不清理：**续接锚点 `agent_events.type='run.started'`**（唯一保存 `backendSessionId` 的地方，清掉它该会话的 native resume 就永久丢失）、非终态 turn（`queued/running/waiting_approval/cancelling`）、存在 `agent_approvals.status='pending'` 的 turn。
- **续接锚点与事件清理解耦**：`run.started` 在「候选统计」和「取批删除」两条 SQL 里都被排除（`type <> 'run.started'`），所以即使没有单独的 hold 标记，它也不会被删。其它过期事件（`message.completed` 等）照常清理；`getLatestBackendSessionId(sessionId)` 不依赖被清理的事件行之外的任何状态。
- **不可对账即跳过**：turn 的 `agent_steps` 仍有未落定状态（`done/failed/aborted/denied` 之外，含 `unknown`）时，事件是 `stepOutcomes` 的唯一证据 → 跳过该 turn，并在结果与日志中记录 `irreconcilable`。恢复证据优先于体积。
- 每次执行都写日志（删除行数、批次、cutoff、删除时间范围、跳过清单）和一条 `agent_events.type='retention.cleanup'` 系统事件（payload 同上）。该系统事件没有对应 `agent_turns` 行，因此自身永不被清理。

配置：`settings.agentRuntime.retention = { enabled?, retentionDays?, batchSize? }`（默认 `enabled=true / 90 / 500`）。人工 hold（`agent_turns.retention_hold` / `setTurnRetentionHold`）已移除：它没有生产调用点，且续接锚点由事件类型豁免保证，不需要额外标记。

**存储统计 IPC `agent:getStorageStats`**：返回事件行数、`agent_events` 占用估算（优先 SQLite `dbstat` 页统计，构建不可用时回退为 payload 字节 + 行开销估算）、最早/最新事件时间与当前策略。**不做自动 `VACUUM`**：SQLite 会复用空闲页，删除后的空间会被后续写入复用；`VACUUM` 需要整库重写并长时间持写锁，不能在后台定时任务里做。

### 4.8 敏感入参脱敏（P1 隐私）

模块：`src/main/shared/redaction.ts`（事件、审批表、日志共用同一套规则）。脱敏发生在**落库/写出副本**上，内存对象不改。

#### 4.8.1 事件与审批表

- `AgentRepository.appendEvents`：payload 落库前 `redactPayload`，`_redaction` 元数据写回落库 payload 副本。
- `AgentRepository.insertApproval`：`args_json` 落库前 `redactArgsJson`，同样保留 `_redaction`；**`args_hash` 在脱敏前用原文计算**（网关先 `hashArgs(toolName, args)` 再 insert），所以重启重放时 hash 校验不会失配。
- **展示与落库分离**：实时待审批（进程未重启）的卡片 payload 用内存原文（`JSON.stringify(input.args)`），不受落库脱敏影响；重启重放只有 `args_json`（已脱敏），payload 带 `argsRedacted: true`，UI 显示「历史审批记录中的敏感内容已脱敏，这里不是完整命令。若无法判断，请拒绝并让 Agent 重新发起该操作」，不提供「还原原文」。重放时因参数已不完整，也不再展示策略规则（避免误导）。
- `agent_approvals` 仍不参与事件保留清理，但内容已脱敏。

#### 4.8.2 日志

- `createLogger`（主进程日志）在输出前对每个参数过同一套规则：字符串走文本规则，对象/数组递归脱敏，`Error` 保留 name+message（message 脱敏）。
- `AgentLogRepository.create` 落库前脱敏 `command` 与 `outputs`（stdout/stderr 缓冲都在这两个字段里），密钥不会随日志落盘。
- 排障信息（错误码、路径、耗时）不脱敏。

**规则表**（可识别模式）：

| 规则名 | 识别对象 | 示例 |
|---|---|---|
| `authorization-header` | `Authorization: Bearer/Basic …` | `Authorization: Bearer ***REDACTED(34 chars)` |
| `bearer-token` | 独立 `Bearer <token>` | `Bearer ***REDACTED(34 chars)` |
| `url-credentials` | URL 的 `user:pass@` | `postgres://app:***REDACTED(11 chars)@db.internal` |
| `flag-secret` | `--token/--password/--api-key/--secret/--access-token/…` | `--token=***REDACTED(40 chars)` |
| `secret-assignment` | `password=`、`api_key=`、`AWS_SECRET_ACCESS_KEY=`、`"password": "…"` | 键名保留，值替换 |
| `provider-token` | `sk-`、`ghp_/gho_/ghs_/ghu_`、`github_pat_`、`glpat-`、`xox[baprs]-`、`AKIA…` | `***REDACTED(40 chars)` |
| `sensitive-key` | 键名即敏感（`password/token/api_key/secret/authorization/credentials/private_key/cookie/…`） | 整值替换（对象/数组则逐项替换） |

**可审计性**：值替换为 `***REDACTED(N chars)`（保留参数名/键名与原始长度）；每个被脱敏字段的路径、命中规则与次数写入同一 payload 的 `_redaction.fields`（如 `{ path: '$.input.args[1]', rules: ['flag-secret'], occurrences: 1 }`）。

**展示与落库分离**：脱敏只发生在落库副本上 —— `appendEvents` 复制 payload 后再处理，传入的事件对象不被修改；`AgentRuntime.onEvent`（实时旁路/审批卡片）拿到的仍是原文，用户能看见自己要批准的命令。`bash.policy` 的 `command`、`approval.required` 的 `input` 都走同一入口。

**覆盖边界（诚实说明）**：

- 只覆盖上表可识别模式；**自定义格式的密钥无法识别**（例如裸 40 位 base64、私有前缀、图片/二进制里的密钥、自然语言里的口令），会原样落库；
- 键名识别是启发式的：`token` 这类键名会整值脱敏，可能误伤非秘密字段（保守优先）；
- **崩溃转储与堆栈不脱敏**：`crashReporter` 转储、进程 core、异常堆栈由系统/框架直接写出，无法可靠识别其中的密钥，且排障需要原始信息；因此崩溃转储可能含敏感内容，**不应外发**（不要贴进工单/聊天/外部服务）。

---

## 5. 状态机与崩溃窗口

### 5.1 turn 状态机（权威）

| 当前 | 允许转入 | 触发 |
|---|---|---|
| `queued` | `running`、`cancelled` | 晋升 / 撤销（Phase 2） |
| `running` | `waiting_approval`、`cancelling`、`completed`、`failed`、`orphaned` | 需审批 / 取消 / 终态 / 启动对账 |
| `waiting_approval` | `running`、`cancelling`、`failed`、`orphaned` | 决策 / 取消 / 策略终止 / 对账 |
| `cancelling` | `cancelled`、`failed`、`orphaned` | 生效 / 超时强制 / 对账 |
| 终态（4 个） | 无 | — |

状态转移由 repository 断言 + 单测保证，**不宣称由 DB 强制**：SQL `CHECK` 只能约束枚举值，无法阻止 `cancelling` 被写成 `running`（已实测该 SQL 不报错）。

**中断收纳（Codex 实测，`spikes/codex-stream/README.md §4`）**：收到 `AbortError` 或流在无终态事件时关闭，turn 进入 `cancelled`；所有只有 `item.started` 没有 `item.completed` 的 step 一律写 `status='aborted'`，并同时写 `test_disposition='unknown-needs-rerun'`——因为**无法证明副作用已经停止**。`unknown` 只用于「步骤已落库但连 started 都没收到」的极端情况。对账时 `aborted` 与 `unknown` 都必须走 `replay` 或 `needs-human`，**不得投影为成功**。`aborted`/`unknown` 只存在于 step 级，不新增 turn 终态（turn 仍是 `cancelled`），避免出现第二个状态机。

**「残留无法确认」不是 turn 状态**：turn 只到 `cancelled` / `failed`，**不得为了等进程回到 `running`**。无法确认归属的残留写成 session 级 `residual_risk='unconfirmed'` + `recovery_note`（取值与 UI 见 §6.5），恢复摘要里可见；它不阻塞新 turn，但新 turn 启动时提示一次。

### 5.2 run 状态是投影（不是第二个状态机）

| turn 情况 | `agent_runs.status` |
|---|---|
| 无 turn 且未启动 | `created` |
| 有 turn `running` | `running` |
| 任一 turn `waiting_approval` | `awaiting_approval` |
| 任一 turn `cancelling` | `cancelling` |
| 全部 turn `orphaned` 且无活跃 | `interrupted` |
| 终态且无失败 | `completed` |
| 终态且有 `failed` | `failed` |
| 终态且全部 `cancelled` | `cancelled` |

只允许 `projectRunStatus(runId)` 一处写入；任何别处直接写 `agent_runs.status` 都算 bug。

### 5.3 启动对账（M0 交付，一次事务）

```
BEGIN IMMEDIATE
UPDATE agent_sessions SET status='orphaned', updated_at=?
  WHERE status IN ('starting','active');
UPDATE agent_turns SET status='orphaned', ended_at=?
  WHERE status IN ('running','waiting_approval','cancelling');
UPDATE agent_steps SET status='unknown'
  WHERE status='running' OR (status='approved' AND executing_at IS NOT NULL);
COMMIT
-- 注意：agent_approvals 的 pending 保持不动，重启后逐条重推（见 §7.4）
```

对账后按 §5.5 计算每个 orphan 的 `RecoveryPlan`，并广播一次全量快照。M0 验收「无悬空 running」由这一步交付。同一入口随后执行 §6.5 的残留进程扫描（并入 D5）。

### 5.4 `executing_at` 三阶段（写前标记）

| 阶段 | 写入时机 | 写入者 |
|---|---|---|
| `approved_at` | 审批通过时 | `ApprovalStateMachine` |
| `executing_at` | **调用工具之前**（同一 tick，先落库再调用） | `onBeforeToolExecute` |
| `ended_at` | 工具返回后 | normalizer |

`approval === 'native' | 'hook'` 且 `interception='pre'` 的后端**必须**调用 `onBeforeToolExecute`，未调用即拒绝执行该工具。`interception='post'` 的后端禁止写 `executing_at`（恒为 `NULL`）。

### 5.5 崩溃窗口判定（spike V2 已实测）

turn 开始时对 `scope.allowedFiles` 生成 `file_snapshot`，把 hash 记入 `agent_artifacts.base_hash`。重启后按下表判定，**hash 不一致一律不自动重跑**：

| `approved_at` | `executing_at` | 磁盘 vs `base_hash` | disposition（spike 实测） | 动作 |
|---|---|---|---|---|
| 有 | 无 | 任意 | `unknown-needs-rerun` | `replay`：安全重跑（审批通过但写未落地） |
| 有 | 有 | 一致 | `completed` | `resume-native`，补写 `done`，不重跑 |
| 有 | 有 | 不一致 / 不可读 | `needs-human` | `abandon`，禁止自动重跑 |
| 无（post-hoc 后端） | 无 | 一致 | `unknown-needs-rerun` | `replay` |
| 无（post-hoc 后端） | 无 | 不一致 | `needs-human` | `abandon`（钩子未触发、但可能已写） |

第一行是 spike 实测新增的一行：**审批 allow 但写未落地**必须能被识别为可安全重跑，否则会永远卡在「已批准」。
`stepOutcomes` 逐 step 记录 `completed | unknown-needs-rerun | needs-human` 与 `reason`，直接落 `agent_steps.test_disposition`，并作为 `RecoveryPlan` 的输入与 UI 展示依据。

**「执行了但钩子未触发」的唯一检测机制**是「turn 起始快照 hash ≠ 当前磁盘 hash 且无对应 `artifact.changed`」；没有起始快照就无法判定，这是 `agent_artifacts` 必须进 M0 的原因。

---

## 6. 并发、归属与锁

### 6.1 归属三原则

1. 归属由 `TurnCorrelation` 显式传入，`RawExecutorEvent.correlation` 必填；normalizer 拒绝无 correlation 的原始事件。
2. 禁止用 adapter 的 `outputSessionStack` 推断归属 `[代码：base.ts L53-L55、L197-L204、L251-L296、L459-L461]`。
3. 同一 adapter 实例同一时刻只允许一个 turn（M0），M1 再考虑 per-session 实例。

### 6.2 各场景的归属来源

| 场景 | 上下文来源 | 做法 |
|---|---|---|
| 普通 IPC 派发 | handler 用 `sessionId` 查 `agent_sessions` 构造 correlation | 显式传给 `runTurn` |
| 多窗口 | 每个 `ipcMain.handle` 是独立 async 根 | correlation 来自入参 + DB，不来自 ALS |
| 定时器 / 恢复巡检 | 从 `agent_turns/agent_approvals` 读 orphan | 不依赖 ALS，正常 `tryAcquire` |
| subagent 派发 | 父 turn 的 `held` 集合派生新 store | 子 session 新建 `agent_sessions` 行；环检测 |
| CLI 型后端 | 进程 per-turn | 进程句柄 → correlation，天然精确 |
| SDK 型后端 | session 级 client | M0 并发 1；M1 per-session 实例 |

### 6.3 `tryAcquire` + ALS 键控

```ts
interface LockStore { readonly held: ReadonlySet<string> }
const lockStore = new AsyncLocalStorage<LockStore>()

function tryAcquire(key: string, turnId: string): LockHandle | null {
  const held = lockStore.getStore()?.held
  if (held?.has(key)) return { key, turnId, nested: true, release: () => {} }
  const h = registry.tryTake(key, turnId)          // 非阻塞
  if (!h) return null
  return { key, turnId, nested: false, release: h.release }
}

function withLock<T>(key: string, turnId: string, fn: () => Promise<T>): Promise<T> {
  const h = tryAcquire(key, turnId)
  if (!h) throw new SessionBusyError(key)
  const next = new Set(lockStore.getStore()?.held ?? [])
  next.add(key)
  return lockStore.run({ held: next }, async () => {
    try { return await fn() } finally { h.release() }
  })
}
```

- `tryAcquire` 不等待，占用即 `null` → 立即 `SESSION_BUSY`；
- store 必须是 `Set<sessionKey>`，不是布尔（布尔会让父 turn 内的子 session 跳过自己的锁）；
- store 缺失 ≠ 已在锁内：定时器 / IPC 等新 async 根必须正常加锁。

### 6.4 实测并发语义（以 spike 为准）

| 场景 | 实测结果 |
|---|---|
| 同 session 并发第二个 run | 立即 `SESSION_BUSY` |
| 同节点第二个非终态 run | `NODE_BUSY` |
| 重入（同一 turn 内再次派发同 key） | 不死锁，`nested=true` |
| 事件归属 | 零错误 |
| 锁开销（1000 次 × 3 轮） | 均值 0.0032–0.0047 ms；P99 0.0127–0.0298 ms |

M0 验收阈值据此收紧为「P99 < 0.1 ms」，不再保留原来的 5 ms 宽阈值。

### 6.5 进程回收与孤儿清理（Codex 真机 + M0 二轮复核实测，一级风险）

实测数据（`spikes/codex-stream/README.md §4`、`docs/architecture/agent-m0-verification.md` §7–§9）：

| 指标 | 实测 |
|---|---|
| `AbortError` 到达 | 3–4 ms |
| CLI 主进程消失 | 79–133 ms |
| 全部相关进程消失 | 25.2–25.9 s（子命令自然结束） |
| 取消后新增事件 | 0 |
| 子命令变孤儿（`ppid=1`） | **4/4 次复现**（1 次补充未复现，属竞态） |
| env marker 跨重启被 `ps` 看见 | **否**（macOS `ps -axo command` 不含环境变量；探针 E 命中 0） |
| 按裸持久化 pid 回收 | **误杀无关进程**（探针 H，PID 复用） |

**Claude** 由宿主受控 spawn，PID 与进程组可控；**Codex SDK** 只对直接子进程 `spawn(..., { signal })`，**不暴露 PID、不杀进程组**。因此对 Codex「abort 成功」不等于「命令已停止」；「落库过 pid」也不等于「这个 pid 现在还是我的」。

**回收承诺分三层，逐层收紧：**

a) **同进程内（可验证）**：只对宿主自己 spawn、且持有真实句柄的进程按内存中的 `pid/pgid` 回收：`SIGTERM` → 500 ms → `SIGKILL`。异常退出路径回收**本轮已登记**的句柄（`finally` 中执行，M0 第二轮已补用例）；正常完成只 `forget`，不做启发式扫描。**Claude** 由宿主受控 `spawn(..., { detached: true })` 包裹 CLI，`pid/pgid/started_at/command` 当场可知，取消走本轮真实句柄（真机多数 `residual_risk=none`）。**Codex SDK** 取消只保证「abort 已发出、turn 收敛、`cancel()` 返回」，**不保证子进程已退出**；Kernel + shim 路径由 shim 自注册句柄，旧路径没有句柄。

b) **跨进程 / 跨重启（仅在可证明归属时回收）**：归属证据必须 **≥2 项，且至少 1 项是内容证据**。内容证据 = 完整命令行精确匹配（不是只比可执行名）、带 HMAC 的自注册记录且能在 DB 找到对应 turn/marker；非内容证据 = `pid`、`startedAt`。**只有 `pid` + `startedAt`、或只有 `startedAt` 一项，一律判 `insufficient-proof`，不杀**；写 `residual_risk='unconfirmed'` + `recovery_note` 并告警。宁可漏杀，不可误杀。

c) **威胁模型（跨用户 / 同 uid）**：对**其他本地 uid** 承诺不可伪造、不可重放（HMAC + 0600 密钥 + 0700 目录 + DB marker 门控）；**同 uid 恶意进程不在防御范围**，不承诺防伪造（见下表）。

**展开如下（口径不得扩大）**：

| 对手 | 承诺 | 证据 |
|---|---|---|
| **其他本地 uid** | **不可伪造、不可重放**：注册记录 HMAC-SHA256、密钥 0600、目录 0700、只认 DB 已知 marker；伪造/篡改/重放/未知 marker 均 kill=0 | C12 六类 6/6 PASS；C13 目录/密钥 symlink 与 0644 均拒绝 |
| **同 uid 恶意进程** | **不在防御范围**：同 uid 本可直接 `kill` 同 uid 进程，读 0600 密钥伪造记录**不构成权限提升**；实测可铸造合法记录并触发 kill（`-24238 SIGTERM`），密钥被同名文件替换后同样成功 | C14 / C14b（攻击成功，按事实记录） |
| 自发性误杀（并发 / 取消 / 崩溃重启 / PID 复用） | **在该威胁模型下已消除**：12 条契约 12/12、C4b PASS、C16 竞态 4/4 | `spikes/reaper-isolation/README.md` §8 |

因此对外只能写「**在跨用户威胁模型下不可伪造、不可重放**」，**不得宣称绝对不可伪造**。若要防同 uid，需要系统钥匙串 + 仅本应用可解的 ACL 或内核级 attestation，当前用户态 HMAC 方案不达标。

**实现红线：禁止按裸持久化 `pid/pgid` 直接 kill**。PID 会被操作系统复用，崩溃窗口或跨轮陈旧句柄会把无关进程当成自己的子进程杀掉（探针 H 已实测）。跨重启读取 pid 时必须带启动时间/命令行/签名校验；turn 终态必须清空 `executor_pid/pgid`，不得让上一轮句柄进入下一轮取消路径。

**已知未修复面（M0 内不承诺）**：

1. **shim 同名 symlink 抢占（C13b，修复中）**：0700 注册目录内预置 `codex-supervisor.cjs -> victim` 会被 `writeFileSync` 顺链覆盖受害文件；属同 uid 残余面，不构成跨用户权限提升。
2. **组长先死、组员仍存活**：不对 `-pgid` 补刀，只记 `missing`，**不承诺回收存活组员**（C16b：`signalsToLong=[]`、`longAlive=true`）。`unsigned` 身份仅在 `ppid === 1` 时放行，且仍需 ≥2 项证据含内容证据（C15），不是无条件信任。
3. **Codex 旧路径无句柄**：SDK 不暴露 PID，旧路径也没有 shim 自注册，只标 `residual_risk='unconfirmed'`，不做任何 kill。Claude 已受控 spawn，仅在「CLI 尚未 spawn 就取消」或「登记缺失导致 spawn 失败」时才是 `unconfirmed`（真机报告 §3.3）。
4. **Windows / Linux 未实测**：当前进程组、`ps` 字段与权限行为只在 macOS 验证。

**env marker 的定位**：`BIZGRAPH_TURN_ID` 只用于**同进程内的轮次关联、日志与排障**，**不作为跨重启认领依据**（macOS `ps` 不可见）。它写入 `executor_env_marker` 是为了事后排查，不是回收凭证。

**「残留无法确认」是显式可见状态，不是静默**：

- 归属：它是 **session 级标记**，不是 turn 状态。turn 已经是 `cancelled` / `failed`，**不得回到 `running`**。
- 取值：`residual_risk = none | possible | unconfirmed`（`none` 无迹象；`possible` 有可证明归属但未确认退出；`unconfirmed` 有线索但无法证明归属）。
- 落库：`agent_sessions.residual_risk` + `agent_sessions.recovery_note`；同时进恢复摘要。
- UI：会话头部显示常驻徽标「可能有残留进程（无法确认）」，展开显示 `recovery_note` 与已尝试的动作；不阻塞新 turn，但新 turn 启动时再提示一次。**不得显示「已停止」**。

**验收口径（按后端分档）**：

| 后端 | 验收 |
|---|---|
| OpenCode（宿主自 spawn） | 取消后 2 s 内本 turn 残留进程数为 **0** |
| Claude（宿主受控 spawn） | 取消后 2 s 内返回、turn 收敛；同进程按本轮真实句柄回收，跨重启按 §6.5(b)；多数路径 `residual_risk=none`，只有未登记句柄才 `unconfirmed` |
| Codex（SDK 无句柄；Kernel 依赖 shim） | 旧路径只断言：取消 2 s 内返回、turn 收敛、`residual_risk` 已写入且 UI 可见；**不承诺 0 残留**；Kernel + shim 路径按 shim 登记句柄回收 |
| 跨重启（所有后端） | 断言「无法证明归属时 kill 调用数 = 0」，**不是**「残留为 0」 |
| 自发性误杀（并发 / 取消 / 崩溃 / PID 复用） | 契约 12/12、C4b PASS、C16 4/4；对不同 session/turn 的 pid 与组信号均为 0 |
| 跨用户伪造 / 重放 | C12 六类 6/6 kill=0；C13 目录/密钥权限收紧与 symlink 拒绝 PASS |
| 同 uid 恶意进程 | **不承诺**；C14/C14b 实测可伪造并触发 kill，只记录事实、不写成已防御 |

不这样做的后果：按裸 pid 回收会误杀用户机器上的任意进程；把 env marker 当跨重启凭证，则回收永远命中 0、却让人误以为已清理；两者都比「明确不承诺」更危险。

---

## 7. 审批

### 7.1 三段式 IPC

| 方向 | 通道 | 载荷 |
|---|---|---|
| main → renderer | `agent:onApprovalRequest` | `ApprovalRequestPayload` |
| renderer → main | `agent:resolveApproval` | `ApprovalDecisionInput` |
| main → renderer | `agent:onApprovalResolved` | `ApprovalResolvedNotice` |
| renderer → main | `agent:getPendingApprovals` | `{ threadId?: string }` |

命名沿用仓库既有 `agent:onXxx` 事件前缀 `[代码：preload/index.ts L17-L118]`。preload 必须同步改 4 处：`IpcApi` 类型、`exposedChannels`、事件白名单、main handler。

**节点执行不暴露 renderer 直通口**：`agent:runNode` 已删除。renderer 无法把 `RunNodeRequest` 直接交给 `AgentRuntime`——那样会绕过 `AgentManager` 的会话锁、`SESSION_BUSY` fail-fast 与审批前置。唯一入口是 `agent:sendCommand` / `agent:resolveAndSendCommand` → `AgentManager.sendCommandThroughKernel`，由 manager 负责锁、幂等键与审批网关。

### 7.2 校验顺序（main 唯一权威）

1. `approvalId` 存在；
2. **归属校验**：`turnId` / `runId` / `sessionId` 必须与审批行（及其所属 turn）一致；若该会话由某个 `webContents` 发起，决议方必须是同一窗口（`sessionWindowBindings`），否则返回 `APPROVAL_NOT_OWNED`（可读错误，不静默）。
   - **窗口绑定生命周期**：`agent:startSession` 记录 `sessionId → senderId`，并向该 sender 订阅一次 `webContents.destroyed`；窗口销毁时清掉它绑定的所有会话，避免绑定永久指向不存在的窗口。
   - **重开窗口的合法路径**：决议时若绑定窗口已不存在（`webContents.fromId(id)` 为空或已销毁），把会话重绑到当前 sender 后继续走 session/turn 校验，而不是直接拒绝；原窗口仍存活时，跨窗口决议一律 `APPROVAL_NOT_OWNED`。
3. `argsHash` 与 `args_hash` 一致（不一致 → `deny` + `ARGS_MISMATCH`）；
4. `now < expires_at`（超时一律写 `denied` + `decided_by='timeout'`，不新增 `expired` 状态）；
5. 决策值合法、turn 未终结、未取消。

任一条不满足即拒绝（fail-closed）；归属失败绝不写决策、绝不放行。审批决定**绝不写回 SDK 的持久权限**（Claude 的 `updatedPermissions` 一律不返回）。用户在弹窗选择「允许本次会话」时进入 §7.6 的会话级授权；选择「允许一次」只在当前这一次调用有效。

### 7.3 后端分发

| 后端 | 机制 | 语义 |
|---|---|---|
| Claude（Kernel 默认） | `permissionMode:'default'` + `PreToolUse` 写类强制 `ask` + `canUseTool` 回调内 `approvalBridge.request()` | 写前拦截（spike V7 已验）；`PreToolUse` 防用户 `permissions.allow` 短路；两者必须同装 |
| Claude（旧路径，未装钩子） | `permissionMode:'acceptEdits'` + 事后 `PostToolUse` 提示 | 没有写前拦截；UI 只能显示「已修改，仅提示」 |
| Codex | `approvalPolicy` 预设 + `sandboxMode` | 无逐工具回调 → `approval:'policy-only'`，UI 明示「回合前策略」 |
| OpenCode / 长尾 CLI | prompt 前置约束 + 事后对账 | `interception:'post'`，写入标 `postHoc=true` |
| mcp（API 兜底） | 宿主执行工具 | `interception:'pre'`，逐工具可拦 |

### 7.4 生命周期：pending 保留 + 重启重推 + 超时拒绝

- 超时（交互 **120s** / 无人值守 **30s**，按 `mode` 取值；spike 用 30ms 验证时序）：写 `denied` + `decided_by='timeout'`，且**迟到的 allow 不执行**（V7 已实测）。
- 重启：`pending` **不置 expired**，启动后一次性重推给 renderer；若其所属 turn 已 `orphaned`，用户批准后不直接执行，而是进入 `RecoveryPlan`（`replay`）重跑该 turn。
- 重复决定：幂等，只执行 1 次（V7 已实测）。
- 决定与 `approval.resolved` 事件**同一事务**写入（V7 已实测）。
- 窗口销毁 / renderer 崩溃：该窗口 `pending` → `deny(system)` 并广播 resolved，随后取消对应 turn（进程还活着，不走 `orphaned`）。

### 7.5 降级文案（唯一来源是能力位）

`agent_sessions.capabilities_json` 存 `AgentCapabilities`，renderer 只读它：

- `interception:'post'|'none'` → 按钮只能是「执行并记录」，禁止「确认后执行」；
- `cancel.effective === false` → 「已请求取消」，禁止「已取消」；
- `eventFidelity:'turn'` → 不显示逐 token 打字机。

### 7.6 会话级授权（M1 已落地）

用户在写前审批弹窗选择「允许本次会话」后，同一会话内的后续写类操作不再重复弹窗。边界是硬性的：

- **授权只能由写类工具建立（阻断项修复）**：`ApprovalGateway.decide()` 只有在 `isWriteScopedTool(审批行.toolName)` 时才会创建 `toolScope='write'` 的会话授权。Bash / 网络 / MCP 等非写类工具即使 UI 传入 `scope='session'`，也按「仅本次」执行，**不会产生任何写类授权**。`matchSessionGrant` 另有防御：授权记录里的 `toolName` 不是写类工具时一律不命中（防止旧版本遗留的非法授权）。
- **UI 与权限一致**：非写类工具的审批 payload 带 `sessionGrantable=false`，渲染层**只有在严格 `=== true` 时才显示**「允许本次会话」按钮，否则隐藏并改显「该工具不支持…只能逐次允许」的说明（`undefined` 也按不可授权处理）。写类工具为显式 `true`，保留按钮。不存在「文案说本会话、实际拿到写权限」或「字段缺省被误当授权」的组合。
- **范围**：只覆盖写类工具（Write / Edit / MultiEdit）。**Bash 不覆盖**——每条 Bash 仍按 §4.6 两档策略判定；网络、MCP、非写类工具也不覆盖。
- **作用域**：per-session。同一会话内跨 turn 生效；**跨会话不继承，重启不继承**。
- **留痕**：自动放行仍写 `agent_approvals`，字段为 `policy_decision='allow'`、`decided_by='policy'`、`grant_source=<授权来源>`、`cwd=<会话工作目录>`；审批事件与步骤事件带 `step_id`。审计上不出现「无记录的放行」。
- **路径边界**：只对会话 `cwd` 内、且经 `realpath` 归一后的路径生效（macOS `/tmp` → `/private/tmp` 别名已处理）。
- **每次命中都重新校验（P0-1，不缓存 realpath）**：会话级授权是「作用域凭证」，不是「一次批准 = 任意写」。命中前逐项检查：
  1. 工具属于写类集合（写类之外一律不命中，Bash / 网络 / MCP 永远回到审批）；
  2. 本次调用的**每个**目标路径都做 `realpath` 后仍在授权 `cwd` 内（多路径任一越界即整体不命中；解析最近已存在祖先的 realpath，因此「工作区内 symlink 指向外部目录」同样会被识别；尾部分隔符与 macOS 大小写变体统一归一）；
  3. 授权未被撤销（`agent:revokeSessionGrant`）；
  4. 会话仍存活（`agent_sessions.status ∈ starting/active/idle`，`closed/orphaned` 视为失效）。
  任一不满足 → **回到审批（`ask`）而不是静默 deny**，让用户看见「这次跑出了授权范围」，并写 `agent_events.type='approval.grant_miss'`（payload：`sessionId/toolName/reason/targets`，reason=`tool|path|revoked|session`）。未命中授权时不落任何自动放行审批行。
- **残余时间窗（诚实说明）**：路径校验与真正写入之间仍存在 TOCTOU 窗口——外部进程可在两次调用之间替换 symlink/硬链接。逐次 realpath + 中间目录解析只能缩小窗口，不能完全消除；这不是「授权越权」路径（每次都必须重新通过校验），但也不是原子保证。
- **失效与撤销**：会话结束即失效；`agent:revokeSessionGrant` 可随时撤销；授权本身只存主进程内存，**不落库**，因此重启后必然回到「每次弹窗」。
- **实现边界**：非写类工具不在覆盖范围；用户 `~/.claude/settings.json` 的 allow 规则仍可能让部分**非写类**工具免弹（见 §17.4），但这不影响写类强制 `ask`。

---

## 8. 归一化契约

### 8.1 最小公共契约

```
run.started → turn.started → (message.completed)* → turn.completed → run.completed
```

工具/推理/用量是可选能力，由 `fidelity` + `source` 表达，**不允许伪造步骤补齐**。

**完成判定（Codex 实测，全局规则）**：后端若原生提供 `turn.completed`，归一化层必须在收到该事件时立即产出具名 `turn.completed`、推进状态机并释放锁，**不得等待 `AsyncIterable` 结束或进程退出**。Codex CLI 在最后一条事件后仍有 ~10 s 关机开销（`lastEventToExitMs=10015`，阻塞式同样存在，`spikes/codex-stream/README.md §5`）；以流结束为完成信号会白等 10 秒，并把锁多占 10 秒。只有 `completionSignal='iterator-end'` 的后端（无完成事件的长尾 CLI）才允许以流结束为完成信号。**完成判定不等待进程退出；进程是否仍在跑由 §6.5 单独记录，二者不得相互阻塞。**

**未知事件与中断**：底层可能是实验性 JSON schema，遇到未识别的 `type` 一律跳过并记 `log.delta`，不得抛错终止 turn；收到 `AbortError` 后**不要等待 `turn.failed` / `error`**（Codex 实测不会出现），按 §5.1 的中断收纳规则处理。

**OpenCode 降级规则（spike 明确要求补）**：当 OpenCode 无工具轨迹（stdout 无结构化工具事件）时，只保证上述最小契约，`toolEvents:'none'`，`interception:'post'`；UI 不展示工具时间线，只展示消息与产物 diff。

### 8.2 `source` 与 `fidelity` 的正确用法

| 事件 | 正确标注 |
|---|---|
| Claude `assistant` 整块消息 | `source=backend, fidelity=token`（block 级；真 token 增量需 `includePartialMessages`） |
| Codex `run()` 的最终结果 | `source=backend, fidelity=turn` |
| Codex `runStreamed()` 的 item | `source=backend, fidelity=turn`（item 级，**非 token**；实测 `item.updated` 0 次） |
| Codex `turn.completed` | `source=backend, fidelity=turn`；**唯一完成信号**（不等迭代器结束） |
| Codex `command_execution` | `source=backend, fidelity=turn`；有完整 `command` 字符串，**无 argv / cwd / 耗时** |
| Codex `file_change` | `source=backend, fidelity=turn` + `postHoc=true`；只有 path + kind，**无 diff** |
| Codex 中断后无终态的 item | `source=kernel, fidelity=turn`；step=`aborted` + `unknown-needs-rerun` |
| OpenCode stdout 汇总 | `source=backend, fidelity=turn` |
| `file.changed`（ScopeGuard 磁盘比对） | `source=synthetic, fidelity=turn` + `postHoc=true` |
| `turn.started` / 审批 / 对账 | `source=kernel` |
| 长尾 CLI 纯文本 | `source=backend, fidelity=turn` |

**下游误用防护**：`TurnStartedPayload` 增加 `fidelityFloor`（本 turn 的下限），UI 不得因某条事件是 `token` 就假设工具事件完整。

### 8.3 断号

- `seq` 跨 turn 全序，用于恢复回放；`turn_seq` 只在 turn 内连续，用于幂等与断号校验。
- **当前逐条写入**：每条事件在写事务内同步分配并提交 `seq`。**50ms 批写未实现**，属性能优化（M2），不得据此承诺「崩溃最多丢尾部」。
- 归档会把 `message.delta` 合并为 `message.completed`，此时允许 `turn_seq` 有洞；读取侧用 `(turn_id, turn_seq)` 唯一键 + 归档表补齐。因此「不断号」只承诺给未归档 turn。

---

## 9. 恢复

1. **恢复只依赖事件回放**：读取该 run 最后一个已持久化事件（`seq ≤ orphan.lastSeq`），配合 `stepOutcomes` 对账重建宿主已知状态；
2. `agent_snapshots` 表已在 schema 中，但**当前没有生产写入路径**（`saveSnapshot` 仅仓储方法与单测调用），恢复**不读取快照**；快照压缩/加速列为 **M2 计划**，不是 M0 已实现能力；
3. replay 只重建宿主已知状态，不重建厂商进程内的未上报中间态；
4. 策略由 `stepOutcomes` 决定（§5.5），`hash` 不一致一律 `needs-human → abandon`；
5. 对外只承诺「恢复到最后一个已持久化事件 + step 级对账」，**不承诺恢复到任意步骤**；
6. **进程回收不属于恢复承诺**：恢复只保证 turn/step 状态对账，不保证操作系统进程被回收，也不承诺跨重启清理 SDK 子进程（边界见 §6.5）。

---

## 10. 能力矩阵（12 个适配器，按代码修正）

注册表实际 12 条 `[实测：registry.ts L61-L272]`：10 个外部 agent 适配器 + `mcp` + `mindmap-internal`。A 的「13 个」是错的。

| 适配器 | eventFidelity | loopOwnership | toolEvents | approval | interception | cancel | resume |
|---|---|---|---|---|---|---|---|
| claude-code | `token`（block 级；真 token 需 `includePartialMessages`，可选实验） | backend | exact（若消费 tool_use） | native | **pre** | abort | native |
| codex | `turn`（`runStreamed()` 仍是 item 级，非 token；实测 `item.updated` 0 次） | backend | derived | policy-only | none | **abort**（SDK 无句柄；旧路径不承诺回收，Kernel + shim 才按登记句柄回收） | native（thread id 仅内存） |
| opencode | `turn` | **backend** | none/derived | policy-only | **post** | kill | none |
| mcp | `token` | host | exact | native | pre | abort | replay |
| mindmap-internal | `turn` | backend | none | policy-only | none | kill | none |
| cline / kilo-code / kimi-code / codebuddy / qoder / qwen-code / cursor | `turn` | backend | none | policy-only | post | kill | none |

**三处被代码推翻的旧说法**

- B「OpenCode `loopOwnership: host`」✗：宿主 `<tool_call>` 只用于 subagent/recipe 派发 `[代码：base.ts L978-L1049]`，文件写入由 CLI 自己完成。
- B「Claude `eventFidelity: token`」✗（默认）：未开 `includePartialMessages`，实际是 block 级。
- A/B「Codex 无中断、只有回合结果」✗：`TurnOptions.signal` 与 `runStreamed()` 均存在 `[SDK 类型]`。

**Codex `toolEvents=derived` 的字段边界（实测）**：`command_execution` 只有完整 `command` 字符串，没有 argv、cwd、起止时间与耗时；`file_change` 只有 path + kind，没有 diff/hunk。审批若需要 argv 或审计需要 diff，由宿主自行补齐。**Codex 的 UI 只能按 item / 消息块更新，不得渲染逐 token 打字机效果**（实测 `item.updated` 0 次、`item.started` 与 `item.completed` 同一时间戳）。

| 需求 | 补齐方案 | 拿不到时的降级 |
|---|---|---|
| argv | 宿主不解析 shell 字符串；改由受控 wrapper 执行，或按命令白名单前缀匹配 | 审批只按整条 `command` 串判定，UI 明示「无法按参数授权」 |
| cwd / 耗时 | 由宿主在 `onBeforeToolExecute` / `tool.result` 前后记时间戳与 scope 路径 | 标 `unavailable`，不得填 0 或估算冒充 |
| diff | `file_change` 后读文件并与 turn 起始快照 `base_hash` 对比，产出 synthetic diff | 只显示「文件已变更」，不显示 diff |

**后端配置前置校验（Codex 实测，不得静默失败）**：

1. 启动前读 `CODEX_HOME/config.toml` 并校验关键枚举，至少包括 `model_reasoning_effort ∈ {none,minimal,low,medium,high,xhigh}`。本机把它写成 `"max"` 时 CLI 直接 `exit 1`，SDK 侧只表现为启动失败（`spikes/codex-stream/README.md §0`）。
2. **CLI 的 `--config` 覆盖不了文件解析错误**（解析发生在覆盖之前，实测）。所以不能用「加参数兜底」，只能改文件或使用独立 `CODEX_HOME`。
3. 错误分类必须可读：配置/认证错误 → `CONFIG_INVALID` / `AUTH_INVALID`，模型或网络错误 → `MODEL_FAILED`；把后端 stderr 原样透出并附修复项，不得统一显示「模型失败」。
4. 失败落 `agent_turns.error_code`，turn 进 `failed`；UI 给出可操作的修复文案（例如允许值的枚举），不重试同一配置。

---

## 11. 落地改动

**M0/M1 已落地**（均在 `src/main/agent/runtime/` 下）：`db/{schema,repository}.ts`、`runtime.ts`、`locks/session-lock.ts`、`normalize/{claude,codex,opencode,sink}.ts`、`executors/{adapter-driver,codex-health}.ts`、`approval/{gateway,bash-readonly}.ts`、`process/reaper.ts`、`recovery/planner.ts`、`cost/{ledger,pricing}.ts`、`evidence/workspace-snapshot.ts`、`capabilities.ts`、`feature-flags.ts`；类型在 `src/shared/types/agent-runtime.ts`。**仍为计划、尚未建文件**：`startup-reconciler.ts`（当前对账由 `AgentManager` 启动路径调用仓储实现）、`locks/workspace-lease.ts`、`executors/legacy-adapter-executor.ts`。**注意**：`src/main/repositories/agent-*.ts` 只存在既有 `agent-log-repository.ts`，新仓储在 `runtime/db/repository.ts`。

**修改（点对点）**：

| 文件 | 改动 |
|---|---|
| `src/main/database.ts` | 17→20（M1 再到 v23）；9 表 + 索引；checksum |
| `src/shared/types/ipc.ts` | 4 个审批通道 + `agent:onRuntimeEvent` |
| `src/preload/index.ts` | 白名单 4 处 |
| `src/main/ipc/agent.ts` | 注册 handler；构造 `sessionId` |
| `src/main/agent/agent-manager.ts` | `sendCommand` 前置 `tryAcquire`；构造 correlation |
| `src/main/adapters/base.ts` | 可选 `correlation` 参数；统一走 `emitOutputForSession` |
| `src/main/index.ts` | 启动跑启动对账（当前由 `AgentManager` 启动路径调用仓储实现，无独立 `startup-reconciler.ts`）；窗口销毁批量 deny |

**spike 迁移**：`spikes/agent-core/src/types.ts` 直接搬到 `src/shared/types/agent-runtime.ts` 并加 §3.2 补丁；spike 里已验证的逻辑（审批幂等、`executing_at`、部分唯一索引、崩溃对账）不改写。

---

## 12. 分期

### M0（5 个交付物，D3/D5 因 Codex 实测扩围）

| # | 交付物 | 对应验收 |
|---|---|---|
| D1 | 类型迁移 + 迁移 17→20（M1 再到 v23）+ 9 表 + 活跃唯一索引 + 进程登记列 + `residual_risk` | 旧库副本行数/hash 不变；单测全绿 |
| D2 | `SessionLockRegistry`（`tryAcquire`/`acquire`/ALS/环检测）+ 显式归属 | `SESSION_BUSY`/`NODE_BUSY`、重入不死锁、归属零错误、P99 < 0.1 ms |
| D3 | 3 个 Normalizer + 最小契约 + OpenCode 无工具轨迹降级 + **`turn.completed` 完成判定** | 三后端 checkpoint 序列一致、seq 连续；Codex 在 `turn.completed` 后 100 ms 内完成，不等迭代器 |
| D4 | 审批三段式 + `argsHash` + fail-closed + pending 重推 | 幂等只执行 1 次、超时后迟到 allow 不执行、重启重放不自动批准 |
| D5 | 启动对账（`AgentManager` 调用仓储）+ `executing_at` 三阶段 + turn 起始快照 + `stepOutcomes` + **分层进程回收** | 真 SIGKILL 后零悬空；五行判定全部命中；OpenCode 取消后 2 s 残留为 0；Claude 按本轮真实句柄回收（只有未登记句柄才 `unconfirmed`）；Codex 旧路径不承诺 0 残留但 `residual_risk` 可见；无法证明归属时 kill 调用数 = 0；同 uid 不作防伪造验收；`aborted` step 全部进 `stepOutcomes` |

依赖顺序：**D1 → D2 → D3（可与 D4 并行）→ D4 → D5**。D5 依赖 D2 的锁与 D4 的审批行，必须在最后；分层进程回收与启动扫描（仅可证明归属）并入 D5，不单独新增编号。

### M1

**已交付（2026-11-05）**：`agent_usage` 落库与只读用量视图；v23 增加 `cost_status` / `tokens_reported` 两列（历史行留 NULL）；legacy 路径用量上报归一；v21 → v23 迁移在真实 Electron + 真实构建产物上验证通过（证据见 `docs/architecture/evidence/m1-migration-*`）。

**本阶段明确不做**：

| 未做项 | 原因 |
|---|---|
| 排队（`queueDepth`） | 产品未定调；M0/M1 维持 `NODE_BUSY` fail-fast，行为可解释 |
| 额度熔断 / 预算三级 | 产品已定「只记账，不熔断」（§4.4.1）；无真实成本分布，阈值会定错 |
| 长尾 CLI 逐 CLI parser | 各 CLI 没有稳定的结构化工具事件，逐家硬解析会把噪声当事实；当前只保留 `file_change_evidence` 合成通道：只有文件级变更、无工具名、`source=synthetic`、`postHoc`，扫描截断会如实标注；precision/recall 未实测 |
| `RecoveryPlanner` 完整策略、`WorkspaceLease` worktree、策略编辑器 | M1 剩余项，不影响账本与迁移结论 |

### M2

`AcpExecutor`、聊天路径迁入 runtime、`RequestQueue` 删除、多 turn（`group_id`）与分支（`branch_key` + worktree）、评测 harness、归档策略。

---

## 13. 需产品决策

| # | 决策 | 现状 | 影响 |
|---|---|---|---|
| 1 | 是否需要排队（`queueDepth=1`） | M0 为 `NODE_BUSY` fail-fast；排队未验证 | 若要排队，启用 §4.3 第二条部分唯一索引 + 晋升事务 |
| 2 | 审批超时时长 | 已定：交互 120s / 无人值守 30s（`mode` 决定）；spike 用 30ms 验证时序 | 太长会占锁；太短会误拒 |
| 3 | Codex 是否默认 `runStreamed()` | **已实测支持默认开启**（`spikes/codex-stream/`）；条件是完成判定用 `turn.completed`、自己杀进程组、不承诺 token 打字机、file_change 不承诺 diff | 需产品确认首版是否默认开启；开启后 Codex 可进工具时间线（无 argv/diff） |
| 4 | 成本上限口径 | **已定：M1 只记账、不熔断**（§4.4.1）；阈值触发条件以 N 天 / X 金额占位，等真实分布回填 | 成本准入分支已删除（2026-11-05），任何配置都不会拒单；重新评估前需先满足 §4.4.1 的触发条件 |
| 5 | 长尾 CLI 是否投入工具事件 | 现为 `none` | 决定 7 个适配器的 UI 能力 |

---

## 14. 风险

| # | 风险 | 兜底 |
|---|---|---|
| **R0（一级）** | **进程回收误杀 / 漏杀 / 伪造**：裸 pid kill 会误杀；env marker 跨重启不可见；同 uid 可读密钥伪造记录 | §6.5 三层承诺：同进程按真实句柄、跨重启仅可证明归属（≥2 项含内容证据）、禁止裸 pid；同 uid **不承诺**防伪造（C14）；C13b 修复中；无法确认 → `residual_risk='unconfirmed'` + 告警 |
| R1 | Claude `canUseTool` 运行时行为与文档不符 | 已加 `PreToolUse` 写类强制 `ask` 防 `permissions.allow` 短路（真机 r9 验证）；若 CLI 版本导致 hook 语义变化，降级 `policy-only` + 只读/allowlist，UI 改文案 |
| R2 | 共享 adapter 实例归属串台 | M0 并发 1 + 显式 correlation；M1 per-session 实例 |
| R3 | `better-sqlite3` 阻塞主进程 | WAL 已启用；**50ms 批量写未实现**（当前逐条写），高事件量阻塞未实测 |
| R4 | 崩溃窗口误判 | §5.5 五行判定；hash 不一致一律 `needs-human` |
| R5 | 迁移漏 bump 版本 | §4.1 五步 + 旧库副本验证 |
| R6 | 打包缺 SDK/CLI 二进制 | `asarUnpack` + 打包 smoke |
| R7 | A2A 透明转发被注入 | `TurnRequest.transparentForward` + pre-turn 短路 + 单测 |
| R8 | 排队上线后与活跃索引冲突 | 晋升必须单事务；启用前先跑 spike |
| R9 | 未具备写前审批的后端（codex / opencode / 长尾 CLI） | 只在回合前策略或事后对账；UI 必须按能力位显示「执行并记录」，**不得宣称已保护**（§17.4） |
| R10 | 会话级授权只覆盖写类，Bash / 网络 / MCP 不覆盖 | §7.6 硬边界；每条 Bash 仍走两档策略；用户可能误以为「授权了就不弹」 |
| R11 | 长尾合成证据误报 / 漏报 | `source=synthetic` + `postHoc`，扫描截断如实标注；precision/recall 未实测（见 §12 M1） |
| R12 | 用量账本错记 / 缺价 | `cost_status` 三态 + `tokens_reported` 如实表达；M1 只记账不熔断，错记不会阻断用户，但也不会自动纠正 |

---

## 15. 给第一次做 Agent 开发的人

1. **先分清「谁拥有循环」。** 后端拥有循环（Claude/Codex/OpenCode 的文件工具）意味着你只能观测；宿主拥有循环（mcp 兜底、自建 ToolRuntime）才能逐工具审批。分不清就会做出「UI 有审批按钮、实际拦不住」的假功能，比没有审批更危险。
2. **`fidelity` 是「看得多细」，`source` 是「谁说的」。** 一条 `token` 事件只说明粒度细，不说明工具调用完整；一条 `synthetic` 事件是宿主推导的 diff，不是厂商事实。把两者混着讲，UI 就会在恢复时展示一份看似完整、实际缺步骤的时间线。
3. **状态机只认 `turn`，`run` 只是账本。** 给 `run` 也建状态机，就会出现两处各写 `status`，崩溃时不一致且没人知道信谁。`run.status` 只能由 `projectRunStatus` 一处投影。
4. **审批必须在工具执行之前；写后确认只能叫审计。** 现有 `PostToolUse` 拿到的 `file_change` 已经落盘了。把它改名叫「审批」，用户会以为点拒绝能阻止写入。`pre` 后端在 `canUseTool`/`onBeforeToolExecute` 拦；`post` 后端只显示「已执行，是否回滚」。
5. **恢复的边界是「最后一条已持久化事件 + step 对账」。** 承诺「任意步骤恢复」的两种结局都更糟：伪造状态骗用户，或在恢复时重复写文件。
6. **锁的粒度是 session。** 锁在 adapter 上会让不同会话无谓排队；锁在 node 上会让同一会话的两个节点并发写同一目录。
7. **`seq` 是宿主记账，不是因果顺序。** 用它推断「先改文件后读文件」会得出错误结论，尤其是 `turn` 级后端。
8. **「完成」不是「流结束」，「取消」不是「进程死了」。** Codex 实测：`turn.completed` 后还有 ~10s 关机；abort 3ms 返回，但子命令可能变 `ppid=1` 继续跑 25s。把这两个信号混为一谈，要么白白多占 10 秒锁，要么让命令在用户以为已取消后继续写盘。

---

## 16. §实测结论（spike 回报，2026-11-04）

> 未关闭的验证项集中在 [verification-ledger.md](file:///Users/zhumingchen/tiangong/docs/architecture/verification-ledger.md)：16 项，其中 U2/U4/U6/U9/U10/U11/U12 会影响用户可见行为；本节只记已跑过的结论，两处冲突时以台账的“未验证”标注为准。

测试与代码：`spikes/agent-core/`（`tests/` 下 24 个测试全绿；10 种故障注入全部变红，日志 `.artifacts/sabotage/`）。

| # | 结论 | 关键数据 | 对设计的影响 |
|---|---|---|---|
| V1 | **归一化通过（有条件）** | 三后端 checkpoint 序列一致：`run.started → message.completed → tool.requested → tool.result → run.completed`；seq 连续 | 补 §8.1 的「OpenCode 无工具轨迹 → 最小契约」降级 |
| V2 | **崩溃恢复通过（真 SIGKILL）** | allow 但写未落地 → `unknown-needs-rerun + replay`；写落地且 hash 一致 → `completed + resume-native`；hash 不一致 → `needs-human + abandon`；清扫后零悬空 running | §5.5 增加第 1 行；`RecoveryPlan` 引入 step 级 `stepOutcomes` |
| V4 | **并发通过** | 第二个并发 run 立即 `SESSION_BUSY`；重入不死锁；同节点第二非终态 run → `NODE_BUSY`；事件归属零错误；锁均值 0.0032–0.0047 ms，P99 0.0127–0.0298 ms（1000 次 × 3 轮） | M0 并发阈值收紧到 P99 < 0.1 ms；排队降级为 Phase 2 |
| V6 | **循环归属通过** | backend-owned 与 host-owned 序列同构；混跑按 runId 隔离，host 停在 `awaiting_approval` 不影响 backend `completed` | run 状态投影保留 `awaiting_approval` |
| V7 | **fail-closed 通过** | 重复决定幂等只执行 1 次；超时 30ms 后迟到 allow 不执行；重启重放不自动批准；决定与事件同事务 | §7.4 采用「pending 保留 + 重启重推 + 超时拒绝」 |
| V8 | **Codex 流式真机通过（有条件）** | item 级非 token（`item.updated`=0）；`turn.completed` → 迭代器结束 **10009–10015 ms**；abort 3–4 ms、主进程 79–133 ms、子命令 **4/4 成孤儿**（`ppid=1`）继续跑 25.2–25.9 s；`command_execution` 有 `command` 无 argv/cwd/耗时，`file_change` 无 diff；`model_reasoning_effort="max"` 使 CLI exit 1 且 `--config` 无法覆盖 | 新增 §3.2 `BackendDriverContract`、§5.1 中断收纳、§6.5 进程回收、§8.1 完成判定；M0 扩大 D3/D5 |
| V9 | **reaper 跨会话隔离通过（限定威胁模型）** | 契约 12/12、C4b PASS、C12 六类伪造/篡改/重放 6/6 kill=0、C13 目录/密钥收紧 PASS、C16 竞态 4/4、sabotage 3/3 变红；**C13b FAIL（修复中）**；**C14/C14b 同 uid 可伪造并触发 kill**（`-24238 SIGTERM`） | 新增 §6.5 三层边界、威胁模型与已知未修复面；对外仅承诺「跨用户不可伪造、不可重放」 |
| — | **测试有效性** | 24 测试全绿 + 10 种故障注入全部变红 | 结论可信度可复核 |

**V8 数据来源与环境限制**：原始事件与时序在 `spikes/codex-stream/results/*.json`，方法见 `spikes/codex-stream/README.md`；环境为 `@openai/codex-sdk@0.135.0`（`codex-cli 0.135.0`）+ **第三方 provider**（MiniMax，`wire_api=responses`），使用临时 `CODEX_HOME`，未改 `~/.codex`。因此 token 数值与耗时只代表本机这条链路，**不代表 OpenAI 官方侧绝对值**；`item.updated` / `reasoning` 未出现可能是 provider 差异，不能写成「Codex 不支持」。

**仍未验证（不得写成已成立）**

| # | 条目 | 需要的实测 |
|---|---|---|
| U1 | Codex **官方 provider** 下是否出现 `item.updated` / `reasoning`（本机第三方 provider 实测为 0） | 换官方 key 录制真实会话 |
| U2 | OpenCode CLI 是否存在结构化工具事件或权限协议 | 真实 CLI 跑 |
| U3 | `better-sqlite3` 高事件量下主进程阻塞 | 10k 事件回放 |
| U4 | 打包后 SDK/CLI 二进制可用性 | `electron-builder` 产物 smoke |
| U5 | Claude 开 `includePartialMessages` 后能否稳定给出 token 级增量 | 可选实验 |
| U6 | 排队（`queueDepth=1`）的晋升事务在并发下是否安全 | 启用前单独 spike |
| U7 | 进程组回收在非 macOS / 打包环境下的行为（当前仅在 macOS 实测） | Windows / 打包产物跑取消用例 |
| U8 | 跨重启回收的「可证明归属」证据（`pid` + 启动时间 + 命令行）在 macOS/打包环境能否稳定取到 | 构造残留进程，跑启动扫描并断言 kill 数为 0 或命中 |
| U9 | 用**真实第二 uid** 验证 0600 密钥不可读、0700 目录不可写（当前只断言权限位与同 uid 行为） | 建测试用户跑一次跨 uid 攻击 |

每条回填必须附「测了几次 / 全部结果 / 波动范围」，不得只报最好的一次。

---

## 17. 默认开启与后端能力门控（2026-11-05）

Kernel 路径自第六轮起**默认开启**，但不是一刀切：只有「已具备写前强制审批」的后端默认进入。

### 17.1 后端矩阵（默认配置，不设任何环境变量）

| 适配器 | 后端家族 | 默认路径 | 写前审批 | 说明 |
|---|---|---|---|---|
| `claude-code` / `claude` | claude | **kernel** | ✅ PreToolUse 对写类工具强制 `ask` → `canUseTool` → 网关 | 唯一默认受保护的后端 |
| `codex` | codex | 旧路径 | ❌ 未启用 | 启动日志标注「旧路径（该后端尚未启用写前审批）」 |
| `opencode` | opencode | 旧路径 | ❌ 未启用 | 同上 |
| 其余适配器（cursor/qwen/mcp/…） | 自身 | 旧路径 | ❌ 未启用 | 同上 |

可信来源：`src/main/agent/runtime/feature-flags.ts` 的 `KERNEL_APPROVAL_CAPABLE_BACKENDS`。启动时逐后端打印一行 `[kernel] <adapter>: ...`，并汇总总开关与白名单。

### 17.2 开关与环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `BIZGRAPH_AGENT_KERNEL` | 未设置 = on | 总开关。`0/false/off/no` → 全部回旧路径 |
| `BIZGRAPH_AGENT_KERNEL_BACKENDS` | `claude` | **完全指定（替换）**：设置后该列表即全部允许进 kernel 的后端集合，未列出的能力后端同样回退；不会让 Codex 获得审批能力 |
| `BIZGRAPH_AGENT_KERNEL_UNSAFE` | 未设置 | 逃生口。`1` 才允许**未具备审批能力**的后端强制走 kernel，且标记 `degraded`、启动日志「降级运行」、运行期 `[kernel-degraded]` warn。对已具备审批的后端无影响 |

#### 启动日志 reason 三类（不得混写）

| reasonKind | 触发条件 | 启动日志 |
|---|---|---|
| `switch-disabled` | `BIZGRAPH_AGENT_KERNEL=0` | `[kernel] <adapter>: 旧路径（BIZGRAPH_AGENT_KERNEL=0 总开关关闭）` |
| `whitelist-excluded` | 后端具备审批但未被 `..._BACKENDS` 列出 | `[kernel] <adapter>: 旧路径（因 BIZGRAPH_AGENT_KERNEL_BACKENDS 未列出而回退；该变量为完全指定…）` |
| `no-approval-capability` | 后端本身没有写前强制审批（codex/opencode/长尾） | `[kernel] <adapter>: 旧路径（该后端尚未启用写前审批）` |
| `unsafe-degraded` | 无审批能力 + `UNSAFE=1` | `[kernel] <adapter>: …（降级运行）`（warn） |
| `enabled` | 具备审批且在列表内 | `[kernel] <adapter>: kernel 路径已启用（写前强制审批）` |

### 17.3 回退（两条）

1. 代码回退（一行）：`isAgentKernelEnabled()` 改为 `return false`，重新构建。
2. 运行时回退：`BIZGRAPH_AGENT_KERNEL=0` 后重启。

**回退语义（不是「所有会话瞬间可用」）**：
- **新会话**：直接走旧路径；
- **既有会话**：旧路径会尝试恢复（`agent_sessions` + 可信原生 id → 续接原对话；同进程仅路由丢失 → 内存态重绑）；
- **不可续接**（旧路径自建会话，从未持久化原生 id）：明确返回「原会话不可续接」+「新建会话可继续」，UI 同时解除该 thread 的会话绑定，下一次发送即新建，**不会**报「适配器不可用」，也不会让用户的所有会话一起坏掉。

回归测试：`总开关 BIZGRAPH_AGENT_KERNEL=0：sendCommand 全部回旧适配器路径`、`KERNEL=0 + 有 agent_sessions 且原生 id 可信：旧路径续接原会话并继续发送`、`KERNEL=0 + 只有 chat_thread 记录（旧路径自建会话）：明确告知不可续接并提示新建`、`KERNEL=0 + 同进程内仅路由条目丢失：从内存态重新绑定，不重放、不新建`。

### 17.4 已知风险

- 未具备审批的后端（codex/opencode）在 kernel 关闭审批能力时仍可正常工作，但**不受写前拦截**；UI/日志必须如实标注，不能宣称「已保护」。
- `UNSAFE=1` 属降级运行：审计里只有 warn 与 `degraded` 原因，没有审批行；不得用于默认发布。
- Bash 的命令级风险分级由**宿主 `bash-readonly.ts` 两档策略**决定（Kernel 路径：只读放行 / 写类弹窗；真机 7/7）；旧路径仍沿用 SDK/CLI 分级，用户 `permissions.allow` 可让部分 Bash 命令免弹（写类工具已由强制 ask 封堵）。
- 新建会话的内存判据按平台区分：macOS 的 `os.freemem()` 只统计完全空闲页，因此仅保留 64MB 硬下限；其他平台按总内存 2% 计算并 clamp 到 128MB–2GB，避免绝对阈值误伤真实用户。
