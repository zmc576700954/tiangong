# BizGraph Agent 体系设计方案（可落地版）

> 已被 [docs/architecture/agent-architecture.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md) 取代（保留追溯）

- 仓库：`/Users/zhumingchen/tiangong`（包名 `bizgraph`，版本 `0.1.0`）
- 日期：2026-11-04
- 性质：**设计稿**。本文不修改任何业务源码；M0 如需实验代码，放在独立目录或独立 spike 分支。
- 证据约定：引用本仓库代码用 `file:///` + 行号；引用外部调研用 `agent-framework-research-2026-11-04.md` 的章节号。
- 诚实标记：`[已有代码证据]` / `[官方文档]` / `[推断]` / **待验证**。凡是需要实测才能确认的，正文一律标注「待验证」，不写成已成立。

---

## 0. 结论先行

1. **不要做「万能 Agent 框架」，要做「回合级编排器 + 自有执行日志」。** 外部调研的核心边界是：执行器能可靠编排 **turn**，不能可靠编排 **turn 内部的工具步骤**（调研 §0.2、§2.3.4）。因此本方案把「节点执行」定义为一个 turn，把「工具步骤」降级为**可观测但不承诺可恢复**的审计事件。
2. **执行器 session 只能当句柄，不能当状态源。** 现状是 `SessionState` 只在主进程内存、DB 无 `agent_sessions` 表、`thread.sessionId` 在重启后悬空 `[已有代码证据：AI_AGENT_ARCHAEOLOGY.md §2.2、§6]`。新体系用 `agent_sessions/agent_turns/agent_steps/agent_events` 持有权威状态，`executor_handle` 可丢可重建。
3. **分层按「变化原因」切，不按「后端厂商」切。** 六层：执行器适配层 / 事件归一化层 / 会话-节点编排层 / 审批与策略层 / 持久化层 / UI 投影层。依赖方向严格向下，任何 vendor schema 不得越过归一化层。
4. **与现有代码是「共存 + 绞杀」，不是推倒重写。** `AgentManager` 保留为对外门面，内部逐步委托给新编排器；`BaseAdapter` 保留为执行器实现细节，通过 `LegacyAdapterExecutor` 适配成新 `Executor` 契约；`AdapterRegistry` 只增加能力位（审批粒度 / 事件粒度 / 可中断性），不换掉。
5. **M0 的最小可验证切片就做四件事：事件归一化 + 每会话串行锁 + step/event 持久化 + 一条写前审批通道。** 这四件事同时验证了本项目最不确定的四个假设，且不需要改 UI 信息架构。
6. **审批必须是「写前拦截」，做不到的后端必须显式降级，并让 UI 说真话。** 现有 `ConfirmationDialog` 消费的是 PostToolUse 的 `file_change`，属于「写后记账」`[已有代码证据：claude-code.ts L237-L268；调研 §6 表#10]`。本方案规定：没有写前拦截能力的后端，所有写入标记为 `unverified_post_hoc`，不允许展示带「确认后才执行」暗示的 UI。
7. **节点粒度取「节点 = 一个 turn 尝试（attempt）」，节点可以有多个 turn（group）。** 收益是可恢复、可计费、可审批；代价是长任务重跑贵、节点内步骤不可断点。表达多 turn 节点用 `group_id`，表达节点内分支用 `parent_turn_id` + 工作区 fork，且分支必须同时 fork 工作区。
8. **恢复的承诺只能是「状态可对账、副作用可审计」，不是「重放完全一致」。** 模型非确定、工具副作用不可逆，这是外部调研 §6.5 明确要求接受的事实。
9. **方案最大的失效风险不是架构选错，而是 Claude 的写前审批钩子在实际 SDK 版本上不可用。** 必须先用 spike 证伪/证实，再决定 M0 是否能把「审批在写前生效」作为验收项（见 §12 验证清单 V3 与 §11 风险 R1）。

---

## 1. 问题定性：现有链路的四个结构性缺口

| # | 缺口 | 代码证据 | 对新体系意味着什么 |
|---|---|---|---|
| G1 | 会话状态只在内存，DB 无 `agent_sessions`；`nodeThreadMap` 每节点只留最后一个 thread | `[已有代码证据：database.ts L367-L660 无 agent_sessions；threadStore.ts L56-L62]` | 必须有 step/event 级持久化，不能靠 resume |
| G2 | 三种后端事件粒度不对等：Claude 逐消息、Codex 阻塞单结果、OpenCode 退出才输出 | `[已有代码证据：claude-code.ts L272-L337；codex.ts L109-L109；opencode.ts L49-L86]` | 必须有归一化层与「保真度」字段，不能假装三后端等价 |
| G3 | 无工具审批 IPC；Claude 用 `acceptEdits` 自动接受；确认弹窗是写后记账 | `[已有代码证据：ipc.ts L109-L150 无审批 channel；claude-code.ts L229；useAgentOutputListener.ts L120-L185]` | 必须新增双向审批 RPC + 策略层 + 后端能力降级矩阵 |
| G4 | 同一 session 无在途锁；`RequestQueue` 存在但未接入派发路径 | `[已有代码证据：base.ts L184-L224；agent-manager.ts L562-L613；request-queue.ts L40-L219 仅测试引用]` | 必须实现 per-session 串行锁，且两条派发路径共享同一把锁 |

另外两个必须正面承认的事实：

- **`AgentOutput` 不足以承载 Agent 循环。** 它是展示型事件（10 种 type、单一 `data: string`），没有 `seq`、没有 turn id、没有工具生命周期、没有 `args_hash` `[已有代码证据：agent.ts L93-L117]`。
- **`agent_logs` 是会话级结果日志，不是 event sourcing。** 它把整段 `outputs` 塞进一行 `[已有代码证据：database.ts L463-L476]`，无法按 step 回放或对账。

---

## 2. 分层架构

### 2.1 六层与依赖方向

```
┌────────────────────────────────────────────────────────────────────┐
│ L6 UI 投影层（src/renderer）                                        │
│  节点执行态 / turn 时间线 / diff 审阅 / 审批卡片 / 成本归因          │
│  只消费 NormalizedEvent + 投影快照，不 import 任何 SDK              │
└───────────────────────────▲────────────────────────────────────────┘
                            │ preload 白名单 IPC（事件 + 命令）
┌───────────────────────────┴────────────────────────────────────────┐
│ L5 审批与策略层（src/main/agent/policy）                            │
│  PolicyEngine / ApprovalStateMachine / 风险分级 / fail-closed       │
│  只在 main 做最终判定；renderer 只回传「用户点了什么」                │
└───────────────────────────▲────────────────────────────────────────┘
                            │ ApprovalRequest / ApprovalDecision
┌───────────────────────────┴────────────────────────────────────────┐
│ L4 会话-节点编排层（src/main/agent/runtime）                        │
│  NodeExecutor / TurnScheduler / SessionLockRegistry / BudgetGuard   │
│  RecoveryPlanner / WorkspaceLease / 取消传播                         │
└───────────────────────────▲────────────────────────────────────────┘
                            │ RawExecutorEvent
┌───────────────────────────┴────────────────────────────────────────┐
│ L3 事件归一化层（src/main/agent/normalize）                         │
│  每 vendor 一个 EventNormalizer；seq 分配；保真度/来源标注            │
│  产出 NormalizedEvent（唯一允许跨层传播的事件类型）                   │
└───────────────────────────▲────────────────────────────────────────┘
                            │ AsyncIterable<RawExecutorEvent>
┌───────────────────────────┴────────────────────────────────────────┐
│ L2 执行器适配层（src/main/agent/executors）                         │
│  Executor 契约 + LegacyAdapterExecutor（包 BaseAdapter）            │
│  ClaudeExecutor / CodexExecutor / OpenCodeExecutor / AcpExecutor    │
└───────────────────────────▲────────────────────────────────────────┘
                            │ spawn / SDK / JSON-RPC
┌───────────────────────────┴────────────────────────────────────────┐
│ L1 执行器（进程外或库内）：Claude Agent SDK / Codex CLI / OpenCode   │
└────────────────────────────────────────────────────────────────────┘

横切：L0 持久化层（src/main/repositories/agent-*）
     被 L4/L5 调用；append-only 事件日志是审计与恢复的唯一依据。
```

**依赖规则（必须写进 lint / code review checklist）：**

1. `src/renderer` 不得 import `@anthropic-ai/*`、`@openai/*`、`node:child_process`。
2. 归一化层以下（L2/L1）不得 import React、Zustand、任何 renderer store。
3. L4 不得直接读取 vendor payload；只能读 `NormalizedEvent`。
4. L5 的拒绝判定必须发生在 `Executor.runTurn` 之前或工具的 permission callback 内，不得只在 UI 层做。
5. 持久化层不得反向依赖编排层（只暴露 repository 接口）。

### 2.2 为什么这样切

| 层 | 变化原因 | 如果混在一起会怎样 |
|---|---|---|
| L2 适配层 | 换 vendor / SDK 升级 | Claude 0.3.142 移除 V2 API 这类破坏性变更会渗透到 UI（调研 §5 P1-7） |
| L3 归一化 | vendor 事件 schema 改 | 三后端差异会被上层「按最弱能力」压平，Claude 的 tool_use 永远拿不到 |
| L4 编排 | 产品语义变（预算、重试、DAG） | 调度逻辑散进适配器，`lastCommandType` 式归属错误会重复出现 |
| L5 审批 | 安全策略变 | 出现「renderer 决定是否放行」的越权模型 |
| L0 持久化 | 查询/迁移变 | 恢复逻辑要改时必须动适配器 |

### 2.3 与现有 `AgentManager` / `AdapterRegistry` / `BaseAdapter` 的演进关系

**结论：共存 + 绞杀（strangler），不替换。**

| 现有组件 | 处置 | 具体做法 | 退出条件 |
|---|---|---|---|
| `AgentManager` | **保留门面** | 保留 `startSession / sendCommand / resolveAndSendCommand` 签名；内部新增 `runtime` 分支。M0 起所有 `sendCommand` 先过 `SessionLockRegistry`，再走原适配器 | M2 后 `AgentManager` 只剩参数校验与转发，编排逻辑全在 `agent/runtime` |
| `BaseAdapter` + 13 个 CLI 适配器 | **保留为实现细节** | 新增 `LegacyAdapterExecutor implements Executor`：`startSession → adapter.startSession`，`runTurn → adapter.sendCommand + 订阅 onOutput`，`cancelTurn → adapter.terminateSession` | 新写的高价值后端（ACP）直接实现 `Executor`；老的 10 个 CLI 适配器长期走 shim |
| `AdapterRegistry` | **扩展能力位** | 增加 `eventGranularity`、`approvalGranularity`、`interruptibility`、`sessionPersistence` 四个描述字段；`ADAPTER_REGISTRY` 的 `capabilities` 不动 | 能力位成为路由与 UI 降级提示的唯一来源 |
| `SessionRouter` / `SessionLifecycleManager` | **保留** | 新 runtime 复用其 session→adapter 绑定与会话生命周期；不另造映射 | 无 |
| `RequestQueue` | **改造并接入** | 其 per-adapter 串行 drain 逻辑可复用；但锁的粒度必须是 **per-session**（现状按 adapterName 分组 `[已有代码证据：request-queue.ts L143-L150]`） | M0 接入或明确废弃（二选一，不允许继续悬空） |
| `SessionRecoveryManager` / `RecoveryOrchestrator` | **降级为兜底** | 只处理「进程还活着时的崩溃」；跨重启恢复由 `RecoveryPlanner` 接管 | M1 后 native resume 只作为 RecoveryPlanner 的一种 strategy |
| `send-and-wait` 旁路 | **必须接入锁与 scope** | 它创建默认 `claude-code` 会话、`allowedFiles: []` `[已有代码证据：send-and-wait.ts L27-L61]`；新体系下旁路也要走 `TurnRequest`，保留 `transparentForward` 语义 | M0 起旁路不允许绕过事件与锁 |

**不替换的理由**：13 个适配器里只有 3 个是主路径，其余是长尾 CLI。一次性重写的风险远大于收益；而 `AgentAdapter` 接口本身已经具备 `startSession / sendCommand / onOutput / terminate / getResumeSessionId` `[已有代码证据：agent.ts L239-L286]`，足以被 shim 包住。

### 2.4 一个 turn 的完整时序（含审批）

```
NodeExecutor.runNode(node)
  └─ TurnScheduler.reserve()                       // 全局/每执行器/每工作区配额
      └─ SessionLockRegistry.acquire(sessionKey)   // 每会话串行
          └─ PolicyEngine.preTurn(scope, command)  // 静态策略：黑名单/网络/只读
              └─ Executor.startSession() 或复用 handle
                  └─ Executor.runTurn(turn, ctx)
                      ├─ RawEvent → Normalizer → NormalizedEvent
                      │     ├─ 写 agent_events（append-only，seq 单调）
                      │     ├─ 更新 agent_steps
                      │     └─ 投影广播（preload 白名单）
                      ├─ [若能写前拦截] ToolRequested
                      │     └─ ApprovalStateMachine.request()
                      │         ├─ PolicyEngine.decide()
                      │         ├─ 需要人：广播 agent:onApprovalRequest
                      │         ├─ renderer 回 agent:resolveApproval
                      │         └─ allow / deny / timeout→deny
                      ├─ UsageReported → BudgetGuard.check()
                      └─ TurnTerminal → 落库 + 释放锁 + 释放配额
```

关键点：**审批通道与取消通道都不是「等锁」的路径**。审批挂起时锁仍被 turn 持有，但取消/审批回复通过独立的 token 通道进入，避免死锁。

---

## 3. 核心接口与类型草案（可编译级别）

> 以下均为 `src/shared/types/agent-runtime.ts` 的候选内容；命名空间独立于现有 `agent.ts`，避免一次性改动 600+ 行既有类型。

### 3.1 归一化事件（唯一跨层事件类型）

```ts
export type ExecutorId = 'claude-code' | 'codex' | 'opencode' | 'acp' | (string & {})

/** 事件保真度：明确承认三后端不对等 */
export type EventFidelity =
  | 'exact'       // vendor 原生给出 step 级事件与顺序
  | 'aggregate'   // vendor 只在回合结束给出，但内容真实
  | 'synthesized' // 由宿主从 diff / ScopeGuard 等旁路推导，非 vendor 产物
  | 'opaque'      // 只有 turn 开始/结束

/** 顺序保真度：seq 是宿主分配的，不代表 vendor 真实顺序 */
export type EventOrdering = 'native' | 'reconstructed'

export type EventOrigin = 'native' | 'reconciled' | 'system'

export interface NormalizedEventBase {
  /** 幂等键：UI 与回放按此去重 */
  readonly eventId: string
  /** turn 内单调递增，从 1 开始；连续性由持久化层校验 */
  readonly seq: number
  readonly turnId: string
  readonly sessionId: string
  readonly nodeId?: string
  readonly executor: ExecutorId
  /** 采集时间，仅作信息；排序只认 seq（对齐 AG-UI 规范：timestamp 不用于排序，调研 §3.7） */
  readonly at: number
  readonly origin: EventOrigin
  readonly fidelity: EventFidelity
  readonly ordering: EventOrdering
}

export interface TurnStartedEvent extends NormalizedEventBase {
  kind: 'turn.started'
  attempt: number
  resumeMode: 'native' | 'context-injection' | 'fresh'
  executorHandlePresent: boolean
}

export interface MessageDeltaEvent extends NormalizedEventBase {
  kind: 'message.delta'
  text: string
}

export interface MessageCompletedEvent extends NormalizedEventBase {
  kind: 'message.completed'
  text: string
}

export interface ReasoningEvent extends NormalizedEventBase {
  kind: 'reasoning.delta'
  text: string
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface ToolCallDescriptor {
  stepId: string
  toolName: string
  args: unknown
  /** 审批与执行绑定的参数指纹；审批后参数被改必须重批 */
  argsHash: string
  affectedPaths?: string[]
  risk: RiskLevel
}

export interface ToolRequestedEvent extends NormalizedEventBase {
  kind: 'tool.requested'
  call: ToolCallDescriptor
  /** blocking=true 表示执行器真的能在此暂停；false 表示只能事后观测 */
  blocking: boolean
}

export interface ApprovalRequestedEvent extends NormalizedEventBase {
  kind: 'approval.requested'
  approvalId: string
  stepId: string
  call: ToolCallDescriptor
  expiresAt: number
}

export interface ApprovalResolvedEvent extends NormalizedEventBase {
  kind: 'approval.resolved'
  approvalId: string
  decision: 'allow_once' | 'allow_for_turn' | 'deny' | 'expired'
  decidedBy: 'user' | 'policy' | 'timeout' | 'system'
}

export interface ToolCompletedEvent extends NormalizedEventBase {
  kind: 'tool.completed' | 'tool.failed'
  stepId: string
  summary: string
  resultRef?: string
}

export interface FileChangeRecordedEvent extends NormalizedEventBase {
  kind: 'file.changed'
  filePath: string
  changeType: 'add' | 'modify' | 'delete'
  /** 关键：postHoc=true 表示这不是写前审批，而是写后记录 */
  postHoc: boolean
  beforeHash?: string
  afterHash?: string
}

export interface UsageSnapshot {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  costUsd: number
  isEstimate: boolean
}

export interface UsageReportedEvent extends NormalizedEventBase {
  kind: 'usage.reported'
  usage: UsageSnapshot
}

export type FailureClass = 'transient' | 'permanent' | 'needs_human' | 'cancelled'

export interface TurnFailure {
  class: FailureClass
  code: string
  message: string
  retryable: boolean
  suggestedAction?: string
  evidence?: string[] // eventId 列表
}

export interface TurnTerminalEvent extends NormalizedEventBase {
  kind: 'turn.completed' | 'turn.failed' | 'turn.cancelled'
  status: 'completed' | 'failed' | 'cancelled'
  summary?: string
  failure?: TurnFailure
  usage?: UsageSnapshot
}

export type NormalizedEvent =
  | TurnStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ReasoningEvent
  | ToolRequestedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ToolCompletedEvent
  | FileChangeRecordedEvent
  | UsageReportedEvent
  | TurnTerminalEvent
```

### 3.2 turn 生命周期与请求/结果

```ts
export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned' // 进程死亡时未终结，重启后由 RecoveryPlanner 处理

export interface TurnBudget {
  maxSteps: number
  maxDurationMs: number
  maxInputTokens: number
  maxCostUsd: number
}

export interface ScopePolicy {
  allowedFiles: string[]
  forbiddenFiles: string[]
  /** 例如 .env / **/.ssh/** / *.pem，必须走 deny 规则而非提示词 */
  deniedPatterns: string[]
  networkAllowed: boolean
  /** 只读模式下所有写工具直接 deny */
  readOnly: boolean
}

export type ApprovalMode = 'step_blocking' | 'turn_policy' | 'none'

export interface ApprovalPolicyRef {
  policyId: string
  mode: ApprovalMode
  /** 无写前能力时的兜底：拒绝高风险工具，而不是假装审批 */
  failClosedForRisk: RiskLevel
}

export interface ResumeIntent {
  mode: 'native' | 'context-injection' | 'fresh'
  executorHandle?: string
  /** context-injection 模式必填：上游产物的摘要 + 已知 artifact 引用 */
  summary?: string
  priorArtifacts?: ArtifactRef[]
}

export interface TurnRequest {
  turnId: string
  graphId: string
  nodeId: string
  /** 幂等键：同一次用户意图重复投递不产生第二个 turn */
  idempotencyKey: string
  attempt: number
  sessionId: string
  executor: ExecutorId
  prompt: { stable: string; turn: string; command: string }
  scope: ScopePolicy
  budget: TurnBudget
  approvalPolicy: ApprovalPolicyRef
  resume: ResumeIntent
  /** 多 turn 节点 / 节点内分支 */
  groupId?: string
  parentTurnId?: string
  /** 节点内分支的名称（仅 M2 + worktree 隔离时可用） */
  branchLabel?: string
  deadlineAt?: number
}

export interface ArtifactRef {
  artifactId: string
  kind: 'diff' | 'file_snapshot' | 'command_output' | 'summary' | 'test_report'
  path?: string
  contentHash: string
  storageRef: string
}

export interface TurnOutcome {
  turnId: string
  status: 'completed' | 'failed' | 'cancelled'
  failure?: TurnFailure
  artifacts: ArtifactRef[]
  usage: UsageSnapshot
  approvalStats: {
    requested: number
    allowed: number
    denied: number
    expired: number
  }
  /** 供下一次 turn 续接；可能为空（后端无原生会话） */
  executorHandle?: string
  lastSeq: number
}
```

**不变量（持久化层强制）：**

- `TurnStatus.cancelling` 之后只能进入 `cancelled` 或 `failed`，不能回到 `running`。
- 一个 `nodeId` 同时最多一个非终态 turn（DB partial unique index，见 §4.2）。
- `TurnOutcome.lastSeq` 必须等于 `agent_events` 中该 turn 的最大 seq；否则视为事件日志损坏。

### 3.3 Executor 契约（适配层唯一向外暴露的接口）

```ts
export interface ExecutorCapabilities {
  /** token=逐 token；message=逐消息；turn-only=只有最终结果 */
  turnStreaming: 'token' | 'message' | 'turn-only'
  /** blocking=能在工具执行前暂停等审批；observational=只能事后看到；none=看不到 */
  toolEvents: 'blocking' | 'observational' | 'none'
  nativeResume: boolean
  /** hard=能立刻中断；soft=只能等当前阻塞调用返回；none=做不到 */
  interrupt: 'hard' | 'soft' | 'none'
  sessionPersistence: 'executor' | 'none'
  subagents: boolean
  /** 工具定义能否被宿主注入（MCP / 自定义工具） */
  injectableTools: boolean
}

export interface ExecutorSessionHandle {
  readonly executor: ExecutorId
  /** BizGraph 运行时会话 id（主进程内唯一；不落库为主键） */
  readonly runtimeSessionId: string
  /** vendor 不透明句柄：Claude SDK session_id / Codex thread.id / ACP sessionId；可丢 */
  readonly executorHandle?: string
  readonly capabilities: ExecutorCapabilities
}

export interface RawExecutorEvent {
  vendor: ExecutorId
  receivedAt: number
  /** 未信任的 vendor schema，只允许 Normalizer 读取 */
  payload: unknown
  correlation?: { turnId?: string; toolCallId?: string }
}

export interface ExecutorRunContext {
  signal: AbortSignal
  approvalBridge?: ApprovalBridge
  onExecutorHandle?: (handle: string) => void
}

export interface Executor {
  readonly id: ExecutorId
  readonly capabilities: ExecutorCapabilities
  startSession(req: {
    runtimeSessionId: string
    workingDirectory: string
    resume?: ResumeIntent
    env?: Record<string, string>
  }): Promise<ExecutorSessionHandle>
  runTurn(
    handle: ExecutorSessionHandle,
    turn: TurnRequest,
    ctx: ExecutorRunContext,
  ): AsyncIterable<RawExecutorEvent>
  cancelTurn(
    handle: ExecutorSessionHandle,
    turnId: string,
    reason: 'user' | 'timeout' | 'budget' | 'shutdown',
  ): Promise<CancelOutcome>
  dispose(handle: ExecutorSessionHandle, reason: 'idle' | 'shutdown' | 'error'): Promise<void>
  /** 仅对 toolEvents='blocking' 的实现有意义 */
  setApprovalBridge?(bridge: ApprovalBridge): void
}
```

### 3.4 审批请求/响应

```ts
export interface ApprovalRequestPayload {
  approvalId: string
  turnId: string
  sessionId: string
  nodeId?: string
  stepId: string
  call: ToolCallDescriptor
  reason: string
  risk: RiskLevel
  /** 超时即拒绝，默认 60s；不允许无限挂起 */
  expiresAt: number
  preview?:
    | { kind: 'diff'; unified: string }
    | { kind: 'command'; command: string }
    | { kind: 'paths'; paths: string[] }
}

export interface ApprovalDecision {
  approvalId: string
  turnId: string
  /** 回传 argsHash，防止「批的是 A、执行的是 B」 */
  argsHash: string
  decision: 'allow_once' | 'allow_for_turn' | 'deny'
  decidedBy: 'user' | 'policy'
  decidedAt: number
}

export interface ApprovalBridge {
  request(payload: ApprovalRequestPayload, signal: AbortSignal): Promise<ApprovalDecision>
}
```

**main 侧校验顺序（缺一不可）：**

1. `approvalId` 存在且 `status === 'pending'`；
2. `turnId` 仍处于 `waiting_approval`；
3. `argsHash` 与请求时一致；
4. `Date.now() < expiresAt`；
5. 决策者身份（renderer 传来的只是「用户点了什么」，不是权威判定）。

任何一条不满足 → `deny`。

### 3.5 取消与恢复

```ts
export interface CancelOutcome {
  turnId: string
  requestedAt: number
  /** 是否真的已经停止执行；false 时必须由调用方决定升级手段 */
  effective: boolean
  effectiveAt?: number
  mechanism: 'foreign-callback' | 'abort-controller' | 'process-kill' | 'dispose-only'
  /** 例如「Codex SDK 不支持中断，已 dispose 句柄并等待 run() 返回」 */
  note?: string
}

export type RecoveryStrategy =
  | 'resume-native'        // 执行器能续接，且工作区未变
  | 'reconcile-then-rerun' // 先按 artifact hash 对账，再重跑 turn
  | 'rerun'                // 直接重跑（turn 未产生副作用或已确认可重放）
  | 'abandon'              // 无法安全恢复，交人工

export interface RecoveryPlan {
  turnId: string
  strategy: RecoveryStrategy
  /** 需要用户在 UI 上确认后才执行 */
  requiresUserConfirmation: boolean
  expectedArtifacts: ArtifactRef[]
  reason: string
}

export interface RecoveryPlanner {
  plan(orphan: OrphanedTurn): Promise<RecoveryPlan>
  apply(plan: RecoveryPlan): Promise<TurnOutcome>
}
```

### 3.6 编排层契约（节点 = turn 的入口）

```ts
export interface WorkspaceLease {
  id: string
  rootPath: string
  mode: 'shared' | 'worktree'
  /** 同一 workspace 的并发写租约 */
  leaseToken: string
}

export interface NodeExecutionRequest {
  graphId: string
  nodeId: string
  /** 一次显式执行请求的 id，用于幂等与重试归一 */
  runId: string
  executorPreference: ExecutorId | null
  prompt: TurnRequest['prompt']
  scope: ScopePolicy
  budget: TurnBudget
  approvalPolicy: ApprovalPolicyRef
  workspace: WorkspaceLease
  resumeFromTurnId?: string
}

export interface NodeExecutionResult {
  nodeId: string
  runId: string
  turnIds: string[]
  status: 'completed' | 'failed' | 'cancelled' | 'needs_attention'
  outcome: TurnOutcome
}

export interface NodeExecutor {
  runNode(req: NodeExecutionRequest): Promise<NodeExecutionResult>
  cancelNode(runId: string, reason: 'user' | 'shutdown'): Promise<CancelOutcome>
  recoverTurn(turnId: string, plan?: RecoveryPlan): Promise<TurnOutcome>
}

export interface SessionLockRegistry {
  acquire(
    key: string,
    opts: { turnId: string; timeoutMs?: number; priority?: number },
  ): Promise<LockHandle>
  isBusy(key: string): boolean
}

export interface LockHandle {
  readonly key: string
  readonly turnId: string
  release(): void
}
```

---

## 4. 数据模型

### 4.1 新增表（SQLite / better-sqlite3）

> 迁移方式沿用现有 `database.ts` 的「建表 + 列补齐」模式 `[已有代码证据：database.ts L367-L680、L905-L913]`。新表只新增，不改动 `chat_threads/chat_messages` 既有列。

```sql
-- 运行时会话：权威状态在这里，不在适配器内存
CREATE TABLE agent_sessions (
  id                 TEXT PRIMARY KEY,
  graph_id           TEXT,
  node_id            TEXT,
  thread_id          TEXT,                          -- 桥接 chat_threads，不设 FK
  executor           TEXT NOT NULL,
  runtime_session_id TEXT,                          -- 主进程内 id；重启后不保证存在
  executor_handle    TEXT,                          -- vendor 不透明句柄；可空、可丢
  status             TEXT NOT NULL DEFAULT 'starting'
                     CHECK(status IN ('starting','active','idle','orphaned','closed')),
  workspace_mode     TEXT NOT NULL DEFAULT 'shared'
                     CHECK(workspace_mode IN ('shared','worktree')),
  workspace_path     TEXT,
  last_turn_id       TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_agent_sessions_node ON agent_sessions(node_id, created_at DESC);
CREATE INDEX idx_agent_sessions_thread ON agent_sessions(thread_id);
CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);

-- turn：一次节点执行尝试
CREATE TABLE agent_turns (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  graph_id         TEXT,
  node_id          TEXT,
  group_id         TEXT,                            -- 多 turn 节点
  parent_turn_id   TEXT,                            -- 节点内分支 / 重试来源
  attempt          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL
                   CHECK(status IN ('queued','running','waiting_approval','cancelling',
                                    'completed','failed','cancelled','orphaned')),
  resume_mode      TEXT NOT NULL
                   CHECK(resume_mode IN ('native','context-injection','fresh')),
  idempotency_key  TEXT NOT NULL,
  input_json       TEXT NOT NULL,                   -- TurnRequest 快照（含 prompt，供重跑；不含 env/凭证）
  output_json      TEXT,
  failure_class    TEXT,
  error_code       TEXT,
  started_at       INTEGER,
  ended_at         INTEGER,
  deadline_at      INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE(idempotency_key)
);
CREATE INDEX idx_agent_turns_session ON agent_turns(session_id, created_at DESC);
CREATE INDEX idx_agent_turns_node ON agent_turns(node_id, created_at DESC);
CREATE INDEX idx_agent_turns_group ON agent_turns(group_id, created_at);
-- 同一节点最多一个非终态 turn
CREATE UNIQUE INDEX ux_agent_turns_active_node
  ON agent_turns(node_id)
  WHERE status IN ('queued','running','waiting_approval','cancelling');

-- step：turn 内可审计的执行单元（工具步骤能拿到多少算多少）
CREATE TABLE agent_steps (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL
              CHECK(kind IN ('message','reasoning','tool_call','file_change','command','usage','system')),
  tool_name   TEXT,
  status      TEXT NOT NULL
              CHECK(status IN ('requested','awaiting_approval','approved','denied',
                               'running','done','failed','unknown')),
  args_hash   TEXT,
  result_ref  TEXT,
  fidelity    TEXT NOT NULL CHECK(fidelity IN ('exact','aggregate','synthesized','opaque')),
  started_at  INTEGER,
  ended_at    INTEGER,
  UNIQUE(turn_id, seq)
);

-- 事件：append-only，审计与回放的唯一依据
CREATE TABLE agent_events (
  id           TEXT PRIMARY KEY,
  turn_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK(origin IN ('native','reconciled','system')),
  fidelity     TEXT NOT NULL CHECK(fidelity IN ('exact','aggregate','synthesized','opaque')),
  ordering     TEXT NOT NULL CHECK(ordering IN ('native','reconstructed')),
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(turn_id, seq)
);
CREATE INDEX idx_agent_events_turn ON agent_events(turn_id, seq);
CREATE INDEX idx_agent_events_kind ON agent_events(kind, created_at DESC);

-- 审批：状态机 + 审计
CREATE TABLE agent_approvals (
  id               TEXT PRIMARY KEY,
  turn_id          TEXT NOT NULL,
  step_id          TEXT,
  tool_name        TEXT NOT NULL,
  args_json        TEXT NOT NULL,
  args_hash        TEXT NOT NULL,
  risk             TEXT NOT NULL CHECK(risk IN ('low','medium','high','critical')),
  policy_decision  TEXT NOT NULL CHECK(policy_decision IN ('allow','deny','ask')),
  status           TEXT NOT NULL
                   CHECK(status IN ('pending','allowed','denied','expired','superseded')),
  decided_by       TEXT CHECK(decided_by IN ('user','policy','timeout','system')),
  decided_at       INTEGER,
  expires_at       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_agent_approvals_turn ON agent_approvals(turn_id, status);
CREATE INDEX idx_agent_approvals_pending ON agent_approvals(status, expires_at)
  WHERE status = 'pending';

-- 产物：diff / 文件快照 / 命令输出 / 摘要
CREATE TABLE agent_artifacts (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT NOT NULL,
  node_id       TEXT,
  kind          TEXT NOT NULL
                CHECK(kind IN ('diff','file_snapshot','command_output','summary','test_report')),
  path          TEXT,
  content_hash  TEXT,
  base_hash     TEXT,                               -- 用于恢复时对账
  storage       TEXT NOT NULL CHECK(storage IN ('inline','file','git')),
  storage_ref   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_agent_artifacts_turn ON agent_artifacts(turn_id);
CREATE INDEX idx_agent_artifacts_node ON agent_artifacts(node_id, created_at DESC);

-- 用量：turn 级归因；is_estimate 明确标注
CREATE TABLE agent_usage (
  id                  TEXT PRIMARY KEY,
  turn_id             TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  executor            TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  is_estimate         INTEGER NOT NULL DEFAULT 1,
  source              TEXT NOT NULL CHECK(source IN ('executor','estimated')),
  recorded_at         INTEGER NOT NULL
);
CREATE INDEX idx_agent_usage_turn ON agent_usage(turn_id);
CREATE INDEX idx_agent_usage_session ON agent_usage(session_id, recorded_at);
```

### 4.2 不变量与索引意图

| 不变量 | 落地方式 | 违反时的处理 |
|---|---|---|
| 同一节点最多一个非终态 turn | `ux_agent_turns_active_node` | 第二次插入失败 → 返回 `NODE_BUSY`，不排队（排队由调度层决定） |
| turn 内事件 seq 单调且连续 | `UNIQUE(turn_id, seq)` + 写入前 `max(seq)+1` 事务 | 冲突 → 拒绝写入并标记 `event_log_corrupt`，暂停该 session |
| 幂等投递 | `UNIQUE(idempotency_key)` | 重复请求返回既有 turn，不再启动执行器 |
| 事件不可变 | repository 只提供 `append`，无 `update` | 代码审查 + 单测断言 |
| 审批 fail-closed | `expires_at NOT NULL`，超时由定时器写 `expired` | 未终结审批在重启时统一置 `expired` |

**事件日志的保留策略**（避免无限膨胀）：终态事件与 `turn.started/approval.*/file.changed/usage.*` 永久保留；`message.delta` 超过 30 天归档为 `message.completed` 摘要；归档写入独立表或压缩 blob，不影响主查询。保留策略必须在 M1 落库前确定，否则 `agent_events` 会以会话速率增长。

### 4.3 节点 DAG 与 turn 的映射

```
Graph（graphs/edges，既有）
 └─ Node（nodes，既有；业务生命周期 draft→published）
     └─ NodeExecution（一次调度请求，runId）
         └─ Turn（agent_turns；一个执行尝试，attempt）
             ├─ Step（agent_steps；工具/消息单元）
             ├─ Event（agent_events；append-only）
             ├─ Approval（agent_approvals）
             └─ Artifact（agent_artifacts）
```

**映射规则：**

1. `nodes` 表**不新增执行状态列**。业务状态 `NodeStatus`（`draft/confirmed/...`）与执行状态是两套语义；现状 `startSession` 会把 `placeholder` 自动推进到 `developing` `[已有代码证据：agent-manager.ts L494-L519]`，新体系保留这条业务规则，但执行态由 `agent_turns` 投影得出，不写回 `nodes.status`。
2. 节点执行态是**派生投影**：
   - 无 turn → `not_started`
   - 有非终态 turn → `running` / `waiting_approval` / `cancelling`
   - 最新终态 turn → `succeeded` / `failed` / `cancelled`
   - 存在 `orphaned` → `needs_attention`
3. 一次「运行整张图」不是新增一张表，而是调度层按 DAG 拓扑序为每个节点调用 `runNode`；DAG 依赖判定仍以 `edges` 为唯一来源。
4. `chat_threads.node_id` 继续作为 UI 的会话落点；`agent_sessions.thread_id` 反向桥接。旧数据不需要重写：新体系读不到 `agent_sessions` 时按「遗留 thread」处理。

### 4.4 恢复语义：哪些可重放、哪些必须重跑

| 对象 | 语义 | 恢复动作 | 理由 |
|---|---|---|---|
| `message.delta` / `reasoning.delta` | 只影响 UI | **可重放**到 UI | 不产生副作用；重放用于断线重连 |
| `message.completed` / `turn.terminal` | 审计事实 | **只读**，不重放执行 | 模型输出非确定，重放不等于重演 |
| `usage.reported` | 已发生计费 | **只读**，不重算 | 重算会重复归因 |
| `file.changed`（postHoc） | 可能已发生 | **先对账**（`after_hash` 与磁盘比对） | 写后记录，不能证明未执行 |
| `approval.pending` | 未决 | 重启时置 `expired`，需要重新审批 | fail-closed；不能替用户批准 |
| `tool.running` / `step.status=running` | 执行中 | 视为 `unknown` → **对账后重跑或转人工** | 无法证明副作用是否落地 |
| `turn.status=running` | 进程死亡 | `orphaned` → RecoveryPlanner | 不能静默续跑 |
| `turn.status=completed` 且 artifacts 校验通过 | 可信 | **不重跑**；下游可直接使用 | 避免重复副作用 |
| `turn.status=failed(transient)` | 可重试 | **重跑 turn（新 attempt）**，重跑前对账 | 失败可能已产生部分写入 |
| `turn.status=failed(permanent)` | 不可重试 | 终止，人工介入 | 鉴权/策略/安装问题重跑无意义 |

**「恢复到指定节点」的真实含义**：从用户选定的节点/ turn 重新开始执行，输入使用该 turn 的 `input_json` 快照 + 上游已知 artifacts 摘要，**执行器会话重建**。它不是时间旅行，不会把磁盘回滚到该节点。若用户要「回滚磁盘」，必须显式使用 artifact 快照（M1 起提供），两者不能混为一谈。

### 4.5 与既有 `chat_threads` / `chat_messages` 的兼容

- 保留 `chat_threads/chat_messages` 作为「人读的聊天记录」，`agent_events` 作为「机器审计日志」。两者不做双向同步，避免双写不一致。
- `thread.sessionId` 的语义修正为 **`agent_sessions.id`**，不再存 vendor handle；vendor handle 存 `agent_sessions.executor_handle`。这解决考古报告 §6 表#4/#7 的混用问题。
- 旧数据迁移：启动时扫描 `chat_threads.session_id` 非空但无对应 `agent_sessions` 的行，标记为 `legacy_dangling`，UI 显示「此会话已失效，可重新开始」；不自动删除、不自动重发。

---

## 5. 节点粒度的取舍：「节点 = 一个 turn」

### 5.1 收益与代价

| 维度 | 收益 | 代价 |
|---|---|---|
| 恢复 | checkpoint 边界清晰：turn 记录全部输入/审批/产物 | turn 内崩溃必须整 turn 重跑（对齐 LangGraph 节点边界语义，调研 §3.4） |
| 审批 | 审批作用域天然是「这个节点这次执行」 | 长 turn 里审批会阻塞整个节点 |
| 计费 | 成本可按 turn→node→graph 归因 | 执行器只给会话/回合级用量，节点内细分只能估算 `[调研 §2.3.3]` |
| 重试 | attempt 自增，历史可审计 | 长任务重跑成本高 |
| UI | turn 时间线清晰，可回放 | 节点内工具步骤的「实时可视化」受后端能力限制 |
| 任务表达 | 单节点职责单一，符合「小节点」原则 | 需要多轮澄清/迭代的任务会被切成多个节点或 group |

### 5.2 需要「多 turn 节点」时的表达

```ts
// 同一节点的多次 turn 用 group_id 串联
{ nodeId: 'n1', groupId: 'g-n1-20261104', parentTurnId: undefined, attempt: 1 }
{ nodeId: 'n1', groupId: 'g-n1-20261104', parentTurnId: 't1',      attempt: 2 }
```

- **节点完成判定**：group 内最后一个 turn `completed` 且满足节点 acceptance criteria（可由 VerificationService 承担，现状已有 `agent:verify`）。
- **何时使用 group**：任务需要「提问→回答→再执行」的交互式循环，或单个 prompt 必然超预算时。
- **何时不使用**：能用子节点表达的阶段划分，优先用 DAG 子节点，因为子节点可独立并行、独立审批、独立重试。

### 5.3 需要「节点内分支」时的表达与硬约束

```ts
{ nodeId: 'n1', parentTurnId: 't1', groupId: 'g-n1', attempt: 2, branchLabel: 'plan-b' }
```

**硬约束（不可妥协）：** 分支必须同时 fork 工作区。Claude 的 `forkSession` 只分叉对话、不分叉文件系统 `[调研 §3.4.2 陷阱 2]`。因此：

- M0/M1：**不提供节点内分支**，只提供「重试」；重试前必须对账。
- M2：分支必须绑定 `WorkspaceLease{mode:'worktree'}`；没有 worktree 时按钮置灰并说明原因。

---

## 6. 并发与隔离

### 6.1 per-session 串行锁

- **锁键**：`agent_sessions.id`（新路径）；遗留路径使用 BizGraph `sessionId`。两个 key 通过 `SessionLockRegistry` 的别名表映射到同一把锁。
- **语义**：默认 `queueDepth = 1`；已有 turn 在途时，第二次派发立即返回 `SESSION_BUSY`（不自动排队），由 UI 提供「排队」选项时才入队（最多 1 个等待项）。
- **防死锁**：`AgentManager.sendCommand` 持锁 → 调用 `BaseAdapter.sendCommand` 时通过 `AsyncLocalStorage` 识别「已在锁内」，内层不再重复 acquire。**不允许**在持锁路径里再同步等待审批的锁。
- **审批准入**：审批回复不经过 `sendCommand`，走独立 `agent:resolveApproval`，因此不会与串行锁冲突。
- **锁的超时**：`timeoutMs` 默认 0（不超时），但 turn 自身有 `deadlineAt`；`deadlineAt` 到期由 `BudgetGuard` 触发 `cancelTurn`，而不是由锁超时触发。
- **现状对照**：`BaseAdapter.sendCommand` 只有 `idleReapingSessions` 的「半终止」保护，没有在途命令保护 `[已有代码证据：base.ts L184-L224]`；`RequestQueue` 按 adapterName 分组，天然不能保证 session 串行 `[已有代码证据：request-queue.ts L143-L150]`。

### 6.2 跨节点并行

并行不是默认开启，必须同时满足：

| 条件 | 默认 | 说明 |
|---|---|---|
| 全局并发上限 | `min(4, cpus*2)`，沿用 `MAX_PROCESSES` 思路 `[已有代码证据：agent-manager.ts L115-L117]` | 超限入队，不新建 |
| 每执行器并发上限 | Claude/Codex 默认 2，OpenCode 默认 1 | OpenCode 每次一个新进程，成本最高 |
| 每工作区并发 | **1（串行）** | 同一 `workingDirectory` 默认只允许一个写 turn |
| 隔离要求 | `worktree` 才能 >1 | 共享工作区并行会互相覆盖 `[调研 §5 P1-5]` |
| allowlist 冲突 | 两个节点的 `allowedFiles` 交集非空则禁止并行 | 即使 worktree 也建议禁止跨分支同文件并行合并 |

### 6.3 取消传播

```
用户点停止
  └─ IPC agent:cancelTurn(runId)
      └─ NodeExecutor.cancelNode
          ├─ 标记 turn.status = cancelling（立即落库，UI 可见）
          ├─ 触发 AbortSignal（父 → 子：subagent / 工具调用）
          ├─ Executor.cancelTurn()
          │    ├─ Claude：AbortController.abort()（hard）
          │    ├─ Codex：SDK 无中断 → dispose 句柄 + 等 run() 返回（soft/none）
          │    └─ OpenCode：kill 进程树（hard）
          └─ deadline（默认 10s）后仍未生效 → 强制：dispose / kill / 标记 orphaned
```

**诚实规则**：`CancelOutcome.effective=false` 时，UI 必须显示「已请求取消，执行器不支持立即中断」，不能显示「已取消」。这正是修掉 `doCloseQuery` 只清 Map、不中断在途 `run()` 的问题 `[已有代码证据：codex.ts L179-L183]`。

### 6.4 资源上限

| 资源 | 配置 | 触发动作 |
|---|---|---|
| 会话数 | 沿用 `MAX_SESSIONS` | 拒绝新建，返回 `AGENT_SESSION_LIMIT` |
| 进程数 | 沿用 `MAX_PROCESSES` | 拒绝新建，返回 `AGENT_RESOURCE_EXHAUSTED` |
| turn 时长 | `TurnBudget.maxDurationMs` 默认 15 分钟 | `cancelTurn('timeout')` |
| turn token | `maxInputTokens` | `cancelTurn('budget')` + `BUDGET_EXCEEDED` |
| turn 金额 | `maxCostUsd` | 同上；仅在 `is_estimate=true` 时给「预算警告」而非硬停（避免估算误差误杀） |
| turn 步数 | `maxSteps` | 观测到超限即取消；**对 Codex/OpenCode 只能事后取消** |
| 事件日志 | 单 turn 最大事件数（默认 5000） | 截断 `message.delta`，保留 `message.completed` 摘要 |

---

## 7. 审批与权限

### 7.1 写前拦截设计

**三道闸门：**

1. **pre-turn 静态策略**（所有后端都可用）：`ScopePolicy` 的 `forbiddenFiles` / `deniedPatterns` / `readOnly` / `networkAllowed` 在执行前判定。无法写前拦截的后端，靠这一层把风险压到最低（例如高风险任务直接只读或拒绝启动）。
2. **step 级动态审批**（仅 `toolEvents='blocking'` 的后端）：`canUseTool` / `session/request_permission` / `PreToolUse` hook。
3. **post-turn 对账**（所有后端都有）：artifact hash + ScopeGuard 校验，用于发现越界与不一致，但**明确标注为 post-hoc，不作为审批**。

**关键实现约束（Claude）：**

- 不能同时使用 `permissionMode: 'acceptEdits'` 与写前审批。`acceptEdits` 会自动批准编辑，`canUseTool` 只有在前面几层未决定时才会被询问 `[调研 §3.2.2 权限评估顺序]`。M0 的 Claude 执行器必须改为 `default` + 显式 allow 规则，或 `dontAsk` + allowlist。
- 必须排除 `bypassPermissions`：它会连 `allowedTools` 一起绕过，且会被子 agent 继承 `[调研 §3.2.2 三个细节]`。
- 若当前 SDK 版本的 `canUseTool` 与 `PreToolUse` hook 行为与文档不一致，按 §12 V3 的失败分支处理（降级为 turn_policy，而不是假装成功）。

### 7.2 后端能力降级矩阵

| 后端 | 事件粒度 | 写前审批能力 | 可中断 | 原生续接 | **产品必须怎么讲** |
|---|---|---|---|---|---|
| Claude Agent SDK | 逐消息（`assistant` / `result`）；当前代码丢弃 `tool_use/tool_result` `[已有代码证据：claude-code.ts L281-L293]` | **理论支持** `canUseTool` / `PreToolUse`；当前代码用 `acceptEdits` 等于关闭 `[已有代码证据：claude-code.ts L229]` | `AbortController`（hard）`[已有代码证据：claude-code.ts L340-L346]` | 有（SDK session_id，仅内存）`[已有代码证据：claude-code.ts L275-L278]` | 「写前审批可用；若实测不可用则自动降级并告知」 |
| Codex SDK | 回合级：`thread.run()` 返回 items `[已有代码证据：codex.ts L109-L156]` | **不支持进程内回调**；只能通过 CLI `config` 预设策略 `[调研 §2.3.4、§3.2]` | **不支持**（`doCloseQuery` 只清 Map）`[已有代码证据：codex.ts L179-L183]`，待验证是否有底层中断 | 有 `resumeThread`（thread id 仅内存）`[已有代码证据：codex.ts L91-L107]` | 「审批是回合前策略，不是逐工具；所有写入为写后记录」 |
| OpenCode CLI | one-shot：stdout 退出才输出 `[已有代码证据：opencode.ts L49-L86]` | 无（宿主未注入审批回调；CLI 自身能力未确认）`[考古报告 §1.4、§7-4]` | kill 进程（hard） | 无 | 「无逐工具审批；默认只读/沙箱，写入需事后审阅」 |
| ACP（M2） | 协议通知 `session/update` | **支持** `session/request_permission` `[调研 §3.7]` | `session/cancel` | `session/load` | 「写前审批可用」 |

**矩阵是产品契约，不是实现细节。** UI 必须根据 `ApprovalMode` 渲染不同文案与不同按钮语义。

### 7.3 默认策略（fail-closed）

| 场景 | 默认决策 |
|---|---|
| 读取工作区内文件 | allow（无需审批） |
| 写 allowlist 内文件，风险 low | allow（记审计） |
| 写 allowlist 内文件，风险 medium/high | ask |
| 写 allowlist 外 / 命中 deniedPatterns | deny（硬拒，不给「仅此一次」） |
| `.env`、`*.pem`、`~/.ssh`、凭证目录 | deny（不可覆盖） |
| 网络请求 / 安装依赖 | 默认 deny；需显式策略开启并按 high 风险审批 |
| 破坏性命令（`rm -rf`、`git push --force`、`git reset --hard`） | ask（critical） |
| 审批超时（默认 60s） | deny |
| 审批期间窗口关闭 / renderer 崩溃 | deny（重启后置 expired） |
| 后端无写前能力但策略要求 step 审批 | **拒绝启动该 turn**，返回 `APPROVAL_UNSUPPORTED`，提示换后端或切只读 |

### 7.4 用户可见的确定性行为

| 用户动作 | 系统必须保证 |
|---|---|
| 点「允许」 | 写入发生在点击之后；点击前文件 hash 不变（仅 `step_blocking` 后端可承诺） |
| 点「拒绝」 | 该工具调用不执行；turn 继续或按策略终止，UI 明确说明 |
| 什么都不点 | 超时后 deny，UI 显示「已超时，未执行」 |
| 重复点击 | 第二次无效（approval 已终态），不产生第二次执行 |
| 后端不支持写前审批 | UI 明确显示「该后端不支持逐工具审批，本次变更为写后记录」 |
| 审批后参数变化 | `argsHash` 不匹配 → 自动 deny，要求重新审批 |

---

## 8. 错误与可观测性

### 8.1 失败分类

| 类别 | 典型错误 | 重试 | 处理 |
|---|---|---|---|
| `transient` | 进程崩溃、限流、临时网络失败、SDK 异常 | 是，最多 3 次，指数退避 | 重跑前先对账；不重复已确认的副作用 |
| `permanent` | 适配器未安装、鉴权失败、模型不存在、策略 deny | 否 | 直接终止，给出可操作提示 |
| `needs_human` | 审批超时、对账不一致、副作用不确定、验收失败 | 否（等待人工） | 节点置 `needs_attention`，保留现场 |
| `cancelled` | 用户取消 / 预算 / 超时 | 否 | 记录取消机制与是否生效 |

错误码映射保留现有 `ErrorCode`（`AGENT_CRASH` 等）`[已有代码证据：errors.ts]`，新增：`SESSION_BUSY`、`NODE_BUSY`、`APPROVAL_UNSUPPORTED`、`BUDGET_EXCEEDED`、`RECONCILE_MISMATCH`、`EVENT_LOG_CORRUPT`、`ORPHANED_TURN`。

### 8.2 成本归因

- 每次 `usage.reported` 写一行 `agent_usage`；`source='executor'` 或 `'estimated'`，`is_estimate` 显式标注。
- 聚合：`turn → node → graph → 日`；UI 显示「本节点估算成本」并带「估算」标识。
- 预算：`BudgetGuard` 在每个 `usage` 事件后与 turn/node/graph 三级预算比对；金额预算只告警不硬停（估算误差），token/时长预算硬停。
- 全局熔断：日成本超阈值 → 新 turn 需显式确认（默认拒绝）。

### 8.3 日志与追踪

- 现有 OpenTelemetry `withSpan` 保留 `[已有代码证据：agent-manager.ts L403-L414、L577-L612]`；新增 `bizgraph.turn`、`bizgraph.step`、`bizgraph.approval` 三个 span。
- 结构化日志字段：`graphId / nodeId / sessionId / turnId / stepId / executor / attempt / eventSeq`。
- **不记录 prompt 正文**（沿用现有做法：只记 type/id）`[已有代码证据：agent-manager.ts L583-L587]`。
- 审计查询：按 `turn_id` 取事件序列，按 `node_id` 取历史 turn，按 `status` 取待审批/孤儿。

---

## 9. 分期落地

### M0：最小可验证切片（不改 UI 信息架构）

**目标：证明四个最不确定的假设。**

1. 新增 migration 与 5 张表（`agent_sessions/agent_turns/agent_steps/agent_events/agent_approvals`），只需 `usage` 与 `artifacts` 的建表可放到 M1。
2. `SessionLockRegistry`（per-session 串行）+ 接入 `AgentManager.sendCommand` 与 `BaseAdapter.sendCommand`（双层防护，`AsyncLocalStorage` 防重入）。
3. `LegacyAdapterExecutor` + 三个 `EventNormalizer`（Claude/Codex/OpenCode），产出 `NormalizedEvent` 并落 `agent_events/agent_steps`；Codex/OpenCode 的缺失步骤标 `fidelity='aggregate'|'opaque'`。
4. 一条写前审批通道：`agent:onApprovalRequest`（main→renderer）+ `agent:resolveApproval`（renderer→main）+ main 侧校验；仅 Claude 走 `canUseTool`/`PreToolUse`，Codex/OpenCode 声明 `ApprovalMode='turn_policy'` 并渲染降级文案。
5. `TurnRequest/TurnOutcome` + `runNode` 的最小实现：一个节点 = 一个 turn。

**M0 验收标准（全部可机械判定）：**

- 同一脚本任务分别在 Claude / Codex / OpenCode 上跑，产出的语义检查点（`turn.started → message.completed → turn.completed`）全部匹配；允许 `fidelity` 不同，不允许 `seq` 断号。
- 审批：Claude 的写工具在「允许」前文件 hash 不变；「拒绝」后不产生写入；超时 60s 后自动 deny。
- 串行：同一 session 并发两次 `sendCommand`，第二次返回 `SESSION_BUSY`；不同 session 并发互不影响，事件归属 100% 正确。
- 崩溃：`kill -9` 主进程后重启，未终结 turn 变为 `orphaned`；不出现「UI 显示运行中但实际无进程」的悬空态。
- 取消：Codex 长任务收到取消后，10s 内要么终止、要么 `CancelOutcome.effective=false` 且 UI 如实显示。

### M1：DAG 调度 + 恢复 + 工作区隔离

1. `TurnScheduler`：DAG 拓扑序、跨节点并行、配额与背压。
2. `RecoveryPlanner` + artifact 对账（`after_hash` 与磁盘比对）+ `resume-native / rerun / abandon` 三条策略。
3. `WorkspaceLease`：`worktree` 模式，按节点分配；同工作区默认串行。
4. 预算三级（turn/node/graph）+ `BudgetGuard`。
5. 审批策略配置：按节点/工具/路径；策略编辑器最小版。
6. UI：turn 时间线、审批卡片、成本归因、`needs_attention` 队列。

**M1 验收：**

- 两个节点并行（worktree 隔离）不互相覆盖；无隔离时自动串行而非报错。
- 崩溃恢复：对每个 step 边界注入 kill，重启后每个 orphan 都有确定的 `RecoveryPlan`；`reconcile` 不一致时绝不自动重跑。
- 预算：token 超限在 1 个事件周期内终止 turn（Claude/OpenCode 可通过 abort/kill 保证；Codex 标注为事后）。
- 审批策略：同一工具在不同节点可配置不同策略，且 deny 规则不可被节点配置覆盖。

### M2：第二执行器协议化 + 存量绞杀 + 评测

1. `AcpExecutor`（支持 `session/request_permission` / `session/cancel`）。
2. 聊天路径迁到 `runtime`；`AgentManager` 变薄；`RequestQueue` 明确删除或改造为 `TurnScheduler` 的内部队列。
3. 多 turn 节点（`group_id`）与节点内分支（强制 worktree）。
4. 评测 harness：golden tasks + 轨迹 + 成功率/成本/时长基线。
5. 事件归档与保留策略上线。

**M2 验收：**

- 同一节点换执行器，UI 不出现分支代码；差异只体现在能力位与降级文案。
- golden tasks ≥ 20 条，成功率/成本/时长有基线，改动后可对比。
- 旧 thread 数据 100% 可读，无静默丢失。

---

## 10. 被否决的方案

### 方案 A：直接用 LangGraph 作为编排核心

**曾认真考虑的点**：checkpointer、时间旅行、`interrupt` HITL 原语成熟，能省掉恢复状态机。

**否决理由：**

1. **粒度不对**：LangGraph checkpoint 在节点边界，节点内崩溃整节点重跑 `[调研 §3.4.2 陷阱 3、§7 说法 4]`。这和本方案 M0 的 turn 粒度完全一致，等于付出一个重依赖换来我们本来就要实现的语义。
2. **不解决真正的问题**：它不提供跨 vendor 事件归一化，也不提供执行器审批桥接；而这两项才是本项目的主要复杂度（调研 §2.3.3）。
3. **模型冲突**：我们的「节点」是用户可视化的业务节点（`nodes` 表，带 `status` 生命周期与 `edges` DAG），与 LangGraph 的图节点不是同一层概念。强行映射会造成「业务状态」和「执行状态」两套图，正好踩中考古报告 §2.3 的状态混用问题。
4. **演进风险**：`@langchain/langgraph` 1.5.3 仍在快速演进，引入后 SDK 升级与 Electron 打包都是新的风险面（调研 §5 P1-7）。
5. **可借鉴不引入**：它的 `recursion_limit`、节点边界恢复、`interrupt` 思路可以吸收，但不作为运行时依赖。

### 方案 B：把执行器 session 当唯一状态源（resume 即恢复）

**曾认真考虑的点**：Claude 有 `resume`、Codex 有 `resumeThread`，似乎可以直接续接，省掉持久化。

**否决理由：**

1. **现状已证伪**：DB 无 `agent_sessions`；Codex thread id 只在内存 Map；OpenCode 无会话 `[已有代码证据：codex.ts L34-L35、opencode.ts L49-L86]`。重启后 `thread.sessionId` 悬空 `[考古报告 §2.2、§6 表#4]`。
2. **resume ≠ 状态恢复**：它恢复的是对话历史，不是工作区；磁盘若被外部改动，模型认知与事实不一致 `[调研 §3.4.2 陷阱 1]`。
3. **无法恢复到任意节点**：执行器只有「一条对话」，没有「一张图」；`[调研 §2.3.3]`。
4. **无法审计**：审批、工具参数、产物 hash 都不在 vendor session 里，合规与成本归因无法完成。
5. **降级路径缺失**：一旦 vendor 会话失效，没有可对账的替代状态，只能整段重跑或放弃。

### 方案 C：立即采用 Vercel AI SDK 7 `HarnessAgent` / `WorkflowAgent` 作为基座

**曾认真考虑的点**：它官方提供 Claude Code/Codex/OpenCode 适配、`toolApproval`（含 HMAC 令牌）、`WorkflowAgent` 持久化执行，看起来「正好是我们要的」。

**否决理由：**

1. **运行时要求未验证**：AI SDK 7 要求 Node ≥ 22 且纯 ESM `[调研 §1.2]`；本项目 Electron 33 的主进程 Node 版本必须实测，不能从文档推断（调研标 `[未核实]`）。
2. **大版本破坏性升级**：7.x 是 CJS 不兼容的大版本，引入即意味着构建链改造，与本项目「先验证核心假设」的节奏冲突。
3. **仍然不提供节点图**：`WorkflowAgent` 是它的 workflow，不是我们的业务 DAG；仍然要自己做节点/turn 映射。
4. **可逆性差**：一旦 UI/事件模型绑到它的类型上，后续替换成本高。
5. **保留观察**：M2 之后可以把它的 `toolApproval` / HMAC 审批令牌思想作为参考；若要接它，应作为**又一个 Executor 实现**，而不是基座。

---

## 11. 风险清单（按「会不会让方案失效」排序）

| # | 风险 | 触发条件 | 影响 | 兜底方案 |
|---|---|---|---|---|
| R1 | Claude 写前审批钩子在实际 SDK 版本上不可用或行为不符 | `canUseTool` 在 `default` 模式下未按期回调，或 `PreToolUse` 不能 deny | **「审批在写前生效」这一核心卖点失效** | 先做 V3 spike；失败则 Claude 降级为 `turn_policy` + 只读/allowlist 硬隔离，UI 改文案，M0 验收项降级为「写后对账」 |
| R2 | Codex 无法中断在途 `run()` | SDK 0.135.0 无 interrupt API（调研标 `[未核实]`） | 「取消」退化为「请求取消」 | 记录 `effective=false`；用 10s deadline 后 dispose 句柄；必要时杀子进程树；验收只承诺有界终止 |
| R3 | 三后端无法产出同一语义序列 | Codex/OpenCode 只有回合级信息，工具事件缺失 | 「统一事件模型」名存实亡 | 定义**最低公共契约**（turn/message/usage/terminal 必须一致；tool 事件可选），UI 按 `fidelity` 分级展示；不做「假步骤」 |
| R4 | `better-sqlite3` 同步写入成为主进程瓶颈 | 高频 `message.delta` 逐条落库 | UI 卡顿、IPC 延迟、turn 超时 | 批量写（按 50ms/批次）+ WAL + 事件表独立 db 文件；先做压测（V10）再定批量策略 |
| R5 | 跨节点并行写冲突 | 两个节点共享同一工作区 | 文件互相覆盖、回滚误删 | 默认同工作区串行；并行强制 worktree；allowlist 交集检测 |
| R6 | 节点=turn 粒度太粗，真实任务重跑成本爆炸 | 单节点任务 >15 分钟或 > 50 步 | 可用性下降、成本上升 | `groupId` 多 turn；节点拆分指引；预算分级；长任务默认只读规划 + 分阶段执行 |
| R7 | SDK 版本漂移 | 声明 `^0.3.160`，实际 0.3.286，上游 0.3.312 `[已有代码证据：package.json L29；调研 §1.2]` | 编译失败、事件字段改名、打包二进制缺失 | 锁精确版本；适配层隔离类型；升级前跑契约测试（事件 schema + 会话行为） |
| R8 | 崩溃时审批 / 工具执行状态不确定，恢复后误判 | 进程在「已批未执行」「执行中」死亡 | 静默漏执行或重复执行 | 重启一律把 `pending` 置 `expired`、`running` 步骤置 `unknown`；对账不一致 → `needs_attention`，绝不自动重跑 |
| R9 | 遗留派发路径绕过锁 | `sendAndWait` / subagent / A2A 未接入 | 并发串台 | 锁下沉到 `BaseAdapter.sendCommand` 作为最后一道闸；新增派发路径必须走 `NodeExecutor` |
| R10 | 迁移破坏旧数据 | 新表迁移/回填失败 | 聊天记录丢失 | 只新增表、不改旧表；迁移前备份；旧 `thread.sessionId` 标 `legacy_dangling` 不删 |
| R11 | A2A 透明转发语义被破坏 | 新编排层统一注入 scope/memory | 违反 `transparentForward` 契约 `[已有代码证据：agent.ts L59-L64、CLAUDE.md L150]` | `TurnRequest` 增加 `transparentForward` 分支，pre-turn 注入短路；单测覆盖 |
| R12 | Electron 打包时 SDK/CLI 二进制缺失 | `asar` 打包未解包 optionalDependencies | 运行时 spawn 失败（调研 §1.2） | `asarUnpack` / `extraResources`；打包后 smoke test |

---

## 12. 验证方案（可证伪清单）

> 原则：每条都写成「假设 → 手段 → 通过标准 → 失败时怎么改」。通过标准必须可机械判定；不接受「看起来正常」。
> 记录纪律：每个条件至少跑 3 次，报告全部结果与波动，不挑最好的一次。

### 12.1 必测的五个核心假设

| # | 假设 | 验证手段 | 通过标准 | 失败时方案怎么改 |
|---|---|---|---|---|
| **V1** | 三后端事件归一化能产出**同一语义序列** | ① 用录制好的 vendor payload 夹具跑 3 个 Normalizer（单测，mock）；② 真实跑 Claude/Codex/OpenCode 各 5 个固定脚本任务（spike） | 每个任务都出现 `turn.started → message.completed → turn.completed` 且 `seq` 连续无断号；`turnId/sessionId/nodeId` 归属 100% 正确；允许 `fidelity` 不同 | 若 Codex/OpenCode 连 `message.completed` 都无法保证 → 把公共契约收缩到 `turn.started/terminal + usage`；tool 事件改为可选能力；UI 明确标「仅回合级」 |
| **V2** | 进程崩溃后可恢复到**指定节点** | 故障注入：在 turn 的每个 step 边界与 turn 结束前 `kill -9`；重启后调用 `RecoveryPlanner`；对比 `agent_artifacts` hash 与磁盘 | 每个 orphan turn 都能得到确定的 `RecoveryPlan`；无「UI 显示运行中」的悬空态；对账不一致时必须 `needs_attention`；选择指定 turn 能以其 `input_json` 重跑并产生新 attempt | 若 artifact 对账不可靠（后端不产 hash）→ 只承诺「重跑 turn」，强制用户确认；不承诺直接续跑 |
| **V3** | 审批在**写前**生效 | 真实 Claude 会话，脚本触发 `Write` 工具；在审批卡片出现时读取目标文件 hash；分别执行 allow / deny / 超时；Codex/OpenCode 走降级路径 | allow 前文件 hash 不变且不存在；deny 后不产生文件；超时 60s 自动 deny；`argsHash` 被篡改时 deny；后端无能力时 UI 不改口 | 若 `canUseTool`/`PreToolUse` 不可用 → Claude 降级为 turn 级策略 + 只读/allowlist；把「写前审批」从 M0 验收移到 M2（ACP）；**不允许**保留自动 `acceptEdits` 还宣称有审批 |
| **V4** | 并发派发不串台 | 压测：同一 session 20 次并发 `sendCommand`（其中 1 次执行中、19 次应拒绝）；3 个 session × 5 个节点并发；断言事件归属 | 同 session 任意时刻 ≤1 个非终态 turn；第二次返回 `SESSION_BUSY`；不同 session 事件的 `sessionId/turnId/stepId` 归属零错误；无事件丢失 | 收紧锁：把 acquire 下沉到 `BaseAdapter.sendCommand`，并在事件上携带 `correlationToken`；若仍有错归属，禁止跨 session 复用 adapter 实例 |
| **V5** | Codex 阻塞模型下取消有界 | 启动长 Codex turn（>3 分钟），在 5s/30s/60s 三个时刻分别取消；观察进程树与 turn 状态 | 在不支持硬中断时，10s 内 `CancelOutcome.effective=false` 且 UI 如实显示；进程在 30s 内被回收、无僵尸；turn 最终进入终态，无后续事件归属 | 若无人能回收子进程 → 显式声明「Codex 不支持取消」，只提供超时；把 Codex 从「可编排节点」降为「建议节点」 |

### 12.2 补充验证（覆盖其余机制）

| # | 假设 | 手段 | 通过标准 | 失败时改法 |
|---|---|---|---|---|
| V6 | 事件回放能重建 UI 状态 | 运行中重载 renderer；重连后按 `seq` 重建 | 重建后的消息/工具/审批顺序与 id 与落库一致；无重复渲染 | 引入 snapshot 事件（`turn.snapshot`）作为重连基线 |
| V7 | 预算能约束成本 | 将 token 预算设为 1000，跑长任务 | 超限后 1 个事件周期内进入 `cancelling → cancelled`，错误码 `BUDGET_EXCEEDED`；费用归因行存在 | 若无法实时获取 usage → 预算改为「回合后结算 + 告警」，调整产品表述 |
| V8 | 串行锁开销可接受 | 100 个 session、每 session 10 次派发，测 P50/P99 | 锁 acquire/release P99 < 5ms；派发吞吐不低于现状的 80% | 改用轻量 keyed promise 队列；避免 `AsyncLocalStorage` 热路径开销 |
| V9 | 迁移对旧数据无损 | 用真实旧库副本跑迁移；统计 `chat_threads/chat_messages/agent_logs` 行数与内容 hash | 行数不变、内容 hash 不变；旧 `sessionId` 标记可查询 | 迁移回滚脚本 + 备份；只新增表 |
| V10 | 事件写入不阻塞主进程 | 录制 10k 事件回放，测主进程事件循环延迟与写放大 | 主进程最长同步阻塞 < 16ms；写放大可控 | 批量写 + 独立 DB 连接 + 大事件 offload 到 worker |
| V11 | 降级文案不说谎 | 对三类后端逐一核对 UI 按钮与文案 | 无写前能力的后端不出现「确认后执行」；取消未生效时显示「已请求」 | 能力位驱动 UI；增加快照测试防回归 |
| V12 | A2A 透明转发未被注入 | 构造 `transparentForward=true` 的入站 turn | 不含 scope/memory/项目上下文；不暴露工具 | turn 构造短路 + 单测断言 prompt 内容 |

### 12.3 必须真实环境验证 vs 可先 mock

| 类别 | 项 | 原因 |
|---|---|---|
| **必须真实环境** | V3 Claude 写前审批行为；V5 Codex 取消与进程回收；OpenCode CLI 的权限行为；V9 Electron 重启与 SQLite 实库；V10 主进程阻塞；SDK/CLI 打包可用性 | 这些取决于具体 SDK 版本、Electron 运行时与进程模型，文档与推断都不可替代 |
| **可先 mock 先验** | V1 Normalizer 映射（用真实录制夹具）；V4 锁与调度；V6 回放；V7 预算计数；V8 锁开销；V11 文案；V12 透明转发 | 纯逻辑，可用 fake Executor + 内存/临时 SQLite 覆盖 |
| **半真实** | V1 的真实端到端跑；V2 崩溃注入 | 需要真实执行器，但故障注入可用计划任务脚本控制 |

### 12.4 验证资产清单（M0 就要建）

- `tests/fixtures/executors/claude/*.jsonl`、`codex/*.json`、`opencode/*.txt`：真实录制的 vendor payload。
- `FakeExecutor`：实现 `Executor` 契约，可脚本化产生 `RawExecutorEvent`（用于锁/调度/恢复/预算）。
- `ScriptedNodeTask` × 5：读取文件 → 修改文件 → 运行测试 → 汇总；用于三后端同语义对比。
- 故障注入脚本：`kill -9` 主进程（CI 用子进程 harness；Electron 用 Playwright electron 配置）。
- 基线记录表：任务 / 执行器 / 成功率 / 平均时长 / 成本 / `fidelity` 分布。

---

## 13. 待验证 / 未确认事项（不得写成已成立）

1. **Claude Agent SDK 0.3.286 的 `canUseTool` / `PreToolUse` 在 `default` 模式下是否按文档回调**：调研基于 0.3.312 文档，本项目实际 0.3.286 `[已有代码证据：考古报告 §1.6]`。**待验证（V3）**。
2. **Codex SDK 0.135.0 是否存在底层中断接口**：考古报告 §7-3 标「未能确认」，调研 §8 标 `[未核实]`。**待验证（V5）**。
3. **Codex `result.items` 的完整类型集合**：当前代码只消费 `agent_message` / `file_change` `[已有代码证据：codex.ts L129-L148]`；是否有 `command_execution` 等可映射为工具事件，**待验证**。
4. **OpenCode CLI 的权限/事件协议**：宿主只确认 spawn + stdin/stdout `[已有代码证据：opencode.ts L49-L86]`；CLI 自身是否支持审批或结构化事件，**未确认**。
5. **Electron 33 主进程 Node 版本是否满足未来引入 AI SDK 7**：**待实测**；本方案不依赖它。
6. **`better-sqlite3` 在事件高频写入下的实际吞吐与主线程影响**：**待压测（V10）**。
7. **Claude 0.3.286 是否支持 `forkSession` / `resumeSessionAt`**：调研基于更高版本；本方案不依赖 fork，**待验证**。
8. **`AgentChatPanel.tsx` 的 JSX 多根是否已导致编译错误**：考古报告 §7-7 未运行 `tsc`，**未确认**；本设计不假设它可编译。

---

## 14. 引用索引

**本仓库代码（`file:///` 绝对路径）**

- `src/shared/types/agent.ts` — `AgentOutput`、`AgentSessionConfig`、`AgentAdapter`、`PromptContext`
- `src/main/adapters/base.ts#L184-L224` — `sendCommand` 无在途锁
- `src/main/adapters/claude-code.ts#L219-L268` — SDK options / `acceptEdits` / PostToolUse hook
- `src/main/adapters/claude-code.ts#L272-L337` — 事件消费（只取 text/result）
- `src/main/adapters/codex.ts#L91-L109` — `resumeThread` / 阻塞 `thread.run()`
- `src/main/adapters/codex.ts#L179-L183` — `doCloseQuery` 只清 Map
- `src/main/adapters/opencode.ts#L49-L86` — one-shot spawn / stdout 缓冲
- `src/main/agent/agent-manager.ts#L115-L117` — `MAX_SESSIONS` / `MAX_PROCESSES`
- `src/main/agent/agent-manager.ts#L562-L613` — `sendCommand` 无锁、`lastCommandType` 注释
- `src/main/agent/request-queue.ts#L40-L219` — 队列实现与按 adapterName 分组
- `src/main/database.ts#L367-L680` — 现有表结构（无 `agent_sessions`）
- `src/shared/types/ipc.ts#L109-L150` — 现有 IPC 通道（无审批）
- `src/preload/index.ts#L17-L99` — preload 白名单
- `AI_AGENT_ARCHAEOLOGY.md` — 项目考古报告（含全部行号证据）

**外部调研（`/Users/zhumingchen/Documents/Trae-CN/temp_20261104_01/agent-framework-research-2026-11-04.md`）**

- §0 结论先行（执行器编排边界）
- §1.2 版本基线
- §2.3.3 / §2.3.4 SDK 已给 / 必须自建 / 抽象边界
- §3.2.2 权限评估顺序与 `bypassPermissions` 陷阱
- §3.4 resume / fork 语义陷阱
- §3.7 ACP / AG-UI 协议定位
- §5 P0-1..P2-9 坑清单
- §6.2 推荐四层架构、§6.5 必须接受的事实
