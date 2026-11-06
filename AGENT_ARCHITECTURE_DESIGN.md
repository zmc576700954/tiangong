# BizGraph Agent 体系核心架构与统一适配层设计

> 已被 [docs/architecture/agent-architecture.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md) 取代（保留追溯）

> 依据：[AI_AGENT_ARCHAEOLOGY.md](file:///Users/zhumingchen/tiangong/AI_AGENT_ARCHAEOLOGY.md) 的事实与硬约束
> 目标：在现有 AI 链路上叠加 Agent 体系；不重写适配器，而是包一层可观测、可恢复、可审批的 Kernel。
> 状态：设计方案，未改代码。

---

## 0. 设计结论（先给答案）

1. **不要试图把三个后端改造成同一种执行模型**。Claude SDK / Codex SDK 自身就带工具循环（backend-owned loop），OpenCode 和现有 `<tool_call>` 协议是宿主驱动（host-owned loop）。强行统一会破坏后端能力。
2. **统一的是「事件协议」，不是「循环归属」**。所有后端输出归一到 `AgentEvent`，并携带 `fidelity: exact | derived | coarse`，上层据此决定能依赖什么。
3. **Kernel 是监督者（supervisor），不是唯一的工具执行者**。对 backend-owned 后端，Kernel 做审批、预算、审计、恢复；对 host-owned 后端，Kernel 额外承担工具执行。
4. **恢复必须建立在自有的 Event Store 上**，不能依赖适配器内存或 `thread.sessionId`。Event sourcing + 快照，才能支持「恢复到任意步骤」。
5. **审批必须是 fail-closed 的跨进程 RPC**。后端没有原生审批钩子时，只能「预授权 + 沙箱回滚」，不能假装有审批门。
6. **并发必须收敛到 `SessionExecutor`**：一个 run 串行执行 turn，全局资源上限继续复用 `MAX_SESSIONS` / `MAX_PROCESSES`。

---

## 1. 总体分层

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer                                                     │
│  AgentChatPanel / RunTimeline / ApprovalDialog               │
│  ↑ agent:event / agent:approvalRequested                     │
│  ↓ agent:startRun / agent:cancelRun / agent:approvalDecision │
├──────────────────────────────────────────────────────────────┤
│ Preload（白名单 IPC）                                         │
├──────────────────────────────────────────────────────────────┤
│ Main: Agent Kernel                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ RunEngine    │  │ SessionExec  │  │ ApprovalGateway      │ │
│  │ (状态机/预算) │  │ (串行/取消)   │  │ (RPC/超时/幂等)       │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘ │
│         │                 │                     │             │
│  ┌──────▼─────────────────▼─────────────────────▼───────────┐ │
│  │ EventNormalizer（原生事件 → 规范事件，标注 fidelity）       │ │
│  └──────┬───────────────────────────────────────────────────┘ │
│         │                                                     │
│  ┌──────▼───────────────────────────────────────────────────┐ │
│  │ BackendDriver 层（薄封装，不承载业务循环）                  │ │
│  │  ClaudeDriver | CodexDriver | OpenCodeDriver | CLIDriver  │ │
│  └──────┬───────────────────────────────────────────────────┘ │
│         │                                                     │
│  ┌──────▼───────────────────────────────────────────────────┐ │
│  │ RunStore（event sourcing + snapshot + approval 持久化）    │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 各层职责

| 层 | 职责 | 不负责 |
|---|---|---|
| `AgentKernel` | run 生命周期、turn 调度、预算、策略、审批、恢复、事件广播 | 不直接调用 SDK |
| `SessionExecutor` | 单 run 串行、取消令牌树、command 幂等 | 不做全局容量决策 |
| `BackendDriver` | 启动/发送/取消/审批回填/销毁；只做协议翻译 | 不做审批决策、不做上下文组装 |
| `EventNormalizer` | 原生消息 → 规范事件；为粗粒度后端合成边界事件 | 不改语义，只标注保真度 |
| `RunStore` | append-only 事件、快照、待审批项、run 元数据 | 不存瞬时进程对象 |
| `ApprovalGateway` | 跨进程审批请求/决定、超时、持久化、幂等 | 不做风险判定（策略层做） |
| `ToolRuntime` | host-owned loop 的工具注册、执行、结果归一 | 不执行 backend-owned 的工具 |
| `ContextEngine` | stable/turn prompt、水位线、记忆 | 不感知后端差异 |

---

## 2. 统一事件模型（核心）

### 2.1 规范事件类型

```ts
export type AgentEventType =
  // 生命周期
  | 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled'
  | 'run.paused' | 'run.resumed' | 'run.interrupted'
  // 轮次
  | 'turn.started' | 'turn.completed'
  // 内容
  | 'message.delta' | 'message.completed' | 'reasoning.delta' | 'reasoning.completed'
  // 工具
  | 'tool.requested' | 'tool.approval_required'
  | 'tool.approved' | 'tool.denied'
  | 'tool.started' | 'tool.result' | 'tool.failed'
  // 观测
  | 'usage.updated' | 'artifact.changed' | 'log.delta'
```

### 2.2 事件信封

```ts
export interface AgentEventEnvelope<T = unknown> {
  eventId: string
  runId: string
  seq: number                 // run 内单调递增，用于恢复/去重
  turnId: string
  stepId?: string
  ts: number
  payload: T
  source: 'backend' | 'kernel' | 'synthetic'
  /** 该事件相对后端真实语义的保真度 */
  fidelity: 'exact' | 'derived' | 'coarse'
  backend: {
    name: string              // claude-code / codex / opencode
    sessionId?: string        // 后端原生会话 id（不是 BizGraph sessionId）
    nativeType?: string       // SDK 原始 type/subtype，便于排障
  }
}
```

`fidelity` 是解决「事件模型不对等」的关键：

| 值 | 含义 | 典型来源 |
|---|---|---|
| `exact` | 后端原生事件的一比一映射 | Claude `assistant` / `result` / `system:init` |
| `derived` | 从结果反推的中间事件 | Codex 从最终 items 推导 tool.result |
| `coarse` | 只有边界事件，细节不可得 | OpenCode one-shot 进程、纯文本输出 |

上层规则：**只有 `exact` 事件可用于审批/强一致 UI；`derived` 可用于时间线与审计；`coarse` 只能用于最终状态与文本展示。**

### 2.3 关键事件负载

```ts
export interface ToolRequestedPayload {
  toolCallId: string
  toolName: string
  input: unknown
  risk: 'low' | 'medium' | 'high'
  /** 该后端是否能在执行前阻塞 */
  blocking: boolean
}

export interface ToolResultPayload {
  toolCallId: string
  ok: boolean
  output?: unknown
  error?: string
  artifactRefs?: string[]
}

export interface MessageDeltaPayload {
  role: 'assistant'
  text: string
  /** token 级增量 or 整段 */
  mode: 'token' | 'block'
}

export interface UsagePayload {
  inputTokens?: number
  outputTokens?: number
  maxTokens?: number
  contextWindow?: number
}
```

### 2.4 与现有 `AgentOutput` 的关系

- `AgentOutput` **保留**，作为兼容渲染层的投影（projection）。`EventNormalizer` 同时产出 `AgentEvent` 与旧 `AgentOutput`。
- 新增渲染组件优先消费 `agent:event`；旧 `AgentChatPanel` 继续消费 `agent:onOutput`，避免一次性重写 UI。
- `AgentOutput` 中的 `file_change` 映射为 `artifact.changed`；`progress/thinking/tool_call/context_injection` 分别映射为 `turn` 元事件、`reasoning.*`、`tool.*`、`log.delta`。

---

## 3. BackendDriver 统一适配层

### 3.1 Driver 契约

```ts
export interface BackendCapabilities {
  /** 后可观测的最小粒度 */
  eventFidelity: 'token' | 'turn' | 'session'
  /** 谁拥有工具循环 */
  loopOwnership: 'backend' | 'host'
  /** 工具事件可得性 */
  toolEvents: 'exact' | 'derived' | 'none'
  /** 审批能力 */
  approval: 'native' | 'hook' | 'policy-only'
  /** 取消能力 */
  cancel: 'abort' | 'kill' | 'cooperative' | 'none'
  /** 恢复能力 */
  resume: 'native' | 'replay' | 'none'
  reasoning: boolean
  parallelToolCalls: boolean
  streamingText: boolean
}

export interface BackendDriver {
  readonly name: string
  readonly capabilities: BackendCapabilities

  start(input: DriverStartInput): Promise<DriverHandle>
  /** 一次 send = 一个 turn；以 AsyncIterable 暴露规范化事件 */
  send(handle: DriverHandle, input: DriverInput): AsyncIterable<AgentEventEnvelope>
  cancel(handle: DriverHandle, reason: TerminationReason): Promise<void>
  /** 仅 approval='native' | 'hook' 时实现 */
  decideApproval?(handle: DriverHandle, decision: ApprovalDecision): Promise<void>
  dispose(handle: DriverHandle): Promise<void>
}
```

设计要求：

- Driver **不组装 prompt、不做 scope、不做审批策略**；这些在 Kernel/ContextEngine。
- Driver 必须把后端原生 session id 放进 `DriverHandle.backendSessionId`，与 BizGraph `runId` 严格分离。
- `send` 的迭代器结束即 `turn.completed`；异常必须转成 `run.failed` 事件后结束，不向上抛裸错误。

### 3.2 三类 Driver 的实现策略

#### A. ClaudeDriver（`eventFidelity: token`，`loopOwnership: backend`）

现有代码只消费 `system/init`、`assistant.text`、`result`，忽略 `tool_use/tool_result/thinking`（[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L272-L337)）。改造点：

- `system:init` → `run.started`，记录 `backend.sessionId = message.session_id`（不再写进 `AgentSessionConfig.resumeSessionId`）。
- `assistant` 内容块：
  - `text` → `message.delta`（`mode: 'block'`）。
  - `thinking` → `reasoning.delta`。
  - `tool_use` → `tool.requested`；若策略要求审批，Kernel 先发 `tool.approval_required` 并等待 `decideApproval`。
  - `tool_result` → `tool.result`。
- `result` → `usage.updated` + `turn.completed` 或 `run.failed`。
- `AbortController` 保留，`cancel` 映射为 `abort`。
- 审批钩子：优先使用 SDK 的 `canUseTool` 类回调（**需在 0.3.286 上验证签名，未能确认**）；不可用时降级为 `policy-only`，即预授权 + `ScopeGuard` 事后回滚（[scope-guard.ts](file:///Users/zhumingchen/tiangong/src/main/scope-guard.ts#L276-L288)）。

#### B. CodexDriver（`eventFidelity: turn`，`loopOwnership: backend`）

`thread.run()` 阻塞到结束（[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L109-L109)），无中间事件。改造点：

- `send` 开始时立即合成 `turn.started`（`source: 'synthetic'`）。
- `run()` 返回后：把最终条目映射为 `message.completed`；若条目含工具记录，则补发 `tool.requested` / `tool.result`，`fidelity: 'derived'`。
- 不可能支持执行前审批：`approval: 'policy-only'`。Kernel 只能依赖 `sandboxMode: 'workspace-write'` 与 ScopeGuard。
- `cancel: 'cooperative'` 或 `none`：现有 `doCloseQuery` 不断开在途 run（[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L179-L179)）。Driver 必须如实声明；Kernel 对 `cancel: 'none'` 的 run 禁止并发派发新 turn。

#### C. OpenCodeDriver（`eventFidelity: session`，`loopOwnership: host`）

`spawn('opencode', ['-q'])`，stdout 缓冲到退出（[opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L49-L76)）。改造点：

- `send` 启动进程后，stdout chunk → `message.delta`（`mode: 'token'` 但 `fidelity: 'coarse'`，因为无法区分工具输出与正文）。
- 进程退出 → `turn.completed`；非零退出 → `run.failed`。
- 工具调用走宿主内联协议（`<tool_call>`），因此 `toolEvents: 'derived'`，`approval: 'hook'`，`cancel: 'kill'`。
- 写入磁盘的 scope 由 Kernel 在 `DriverInput` 中注入，Driver 不自行拼 scope。

#### D. 通用 CLIDriver（Cline / Kilo / Kimi / CodeBuddy / Qoder / Qwen / Cursor）

这些适配器的实现细节本次未逐一考古。统一按「one-shot / 文本流」处理，默认 `eventFidelity: session`、`loopOwnership: host`、`toolEvents: none`，并在能力矩阵中显式声明，避免上层误判。

### 3.3 能力矩阵（建议初始值）

| Backend | eventFidelity | loopOwnership | toolEvents | approval | cancel | resume |
|---|---|---|---|---|---|---|
| claude-code | token | backend | exact | hook（待验证）/ policy-only | abort | native |
| codex | turn | backend | derived | policy-only | cooperative/none | native（thread id） |
| opencode | session | host | derived | hook | kill | none |
| 其他 CLI | session | host | none | policy-only | kill | none |
| mcp | session | host | exact | hook | kill | replay |

矩阵来源应同时保留 `AdapterDescriptor.capabilities`（[registry.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/registry.ts#L25-L45)）作为静态声明，并在 `start()` 后做一次**运行时校验**，不一致时以运行时为准并告警。

---

## 4. Run 状态机与循环归属

### 4.1 状态机

```
created
  → running
      → (tool.requested + 需要审批) → awaiting_approval
          → approved → running
          → denied   → running（把拒绝结果回填给模型）
      → (用户取消) → cancelling → cancelled
      → (后端失败) → failed
      → (预算/步数耗尽) → failed(budget_exceeded)
  → completed
```

- 状态持久化到 `agent_runs.status`。
- 任何状态迁移必须写 `agent_events`，事件是唯一事实源。
- 进程重启时，所有 `running/awaiting_approval` 的 run 标记为 `interrupted`，由用户选择 `resume（重放）` 或 `abandon`。

### 4.2 两种循环归属

| | backend-owned | host-owned |
|---|---|---|
| 谁决定下一步 | 后端 SDK | Kernel |
| Kernel 角色 | 监督、审批、预算、审计、恢复 | 执行工具、回填结果、驱动循环 |
| 工具执行位置 | 后端进程内（Claude/Codex） | 主进程 `ToolRuntime` |
| 审批可行性 | 取决于后端钩子 | Kernel 完全可控 |
| 典型后端 | Claude、Codex | OpenCode、CLI 系、MCP |

**关键约束**：Kernel 的 `RunEngine` 必须有两种策略实现，不能假设自己能拦住 backend-owned 的每一次工具调用。对 `approval: 'policy-only'` 的后端，UI 必须明示「该后端仅支持事后回滚」。

### 4.3 预算与终止条件

- `maxTurns`、`maxToolCalls`、`maxTokens`、`maxWallClockMs`。
- 任一超限 → `run.failed`，错误码 `BUDGET_EXCEEDED`，并触发 ScopeGuard 的 `commitChanges` 策略（默认回滚）。
- 这些预算由 Kernel 统一执行，不依赖后端。

---

## 5. 审批通道设计（跨进程、可恢复）

### 5.1 IPC 契约（新增）

| Channel | 方向 | 参数 | 返回 |
|---|---|---|---|
| `agent:approvalRequested` | main → renderer | `{ approvalId, runId, turnId, toolName, input, risk, blocking, expiresAt }` | — |
| `agent:approvalDecision` | renderer → main | `{ approvalId, decision: 'allow' \| 'deny' \| 'allow_session', remember?: boolean }` | `{ ok: boolean }` |
| `agent:approvalResolved` | main → renderer | `{ approvalId, decision, resolvedBy: 'user' \| 'timeout' \| 'cancel' }` | — |
| `agent:getPendingApprovals` | renderer → main | `runId?` | `PendingApproval[]` |

### 5.2 Kernel 侧语义

```ts
interface ApprovalRequest {
  approvalId: string
  runId: string
  turnId: string
  toolCallId: string
  toolName: string
  input: unknown
  risk: 'low' | 'medium' | 'high'
  expiresAt: number
}
```

- **fail-closed**：超时（默认 60s）或 run 取消 → `deny`。
- **幂等**：同一 `approvalId` 的重复决定返回首次结果。
- **可恢复**：待审批项落 `agent_approvals`；重启后 `awaiting_approval` 的 run 重新向 renderer 推送，不丢失。
- **`allow_session`**：在 run 生命周期内记住 `(toolName, scopeKey)`，减少重复弹窗；不跨 run 复用。
- **后端分发**：
  - `approval: 'native' | 'hook'` → 调用 `driver.decideApproval`，由后端继续/中止。
  - `approval: 'policy-only'` → Kernel 不阻塞（也拦不住），只记录 `tool.requested` 与审计事件，并立即依赖 ScopeGuard；UI 必须显示「事后回滚模式」。

### 5.3 与现有 ConfirmationDialog 的关系

现有 `ConfirmationDialog` + `pendingConfirmations` 是纯前端记账，且 `file_change` 来自 Claude 的 **PostToolUse** hook（[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L241-L268)），本质是「写后确认」。新设计保留它作为**低风险变更的审计 UI**，但真正的执行前审批走 `ApprovalGateway`，两者不混用。

---

## 6. 持久化与恢复（Event Sourcing）

### 6.1 表设计（新增，不改现有表）

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,                 -- BizGraph runId
  thread_id TEXT NOT NULL,
  node_id TEXT,
  graph_id TEXT,
  backend TEXT NOT NULL,
  backend_session_id TEXT,             -- 后端原生会话 id
  loop_ownership TEXT NOT NULL,        -- backend | host
  status TEXT NOT NULL,                -- created/running/awaiting_approval/interrupted/completed/failed/cancelled
  budget_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  step_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  fidelity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE agent_approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  decision TEXT,                       -- allow/deny/allow_session/null
  resolved_by TEXT,                    -- user/timeout/cancel
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE agent_snapshots (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, seq)
);
```

### 6.2 恢复算法

```
loadLatestSnapshot(runId)
  → replay agent_events where seq > snapshot.seq
  → 重建：当前 turn、已完成步骤、待审批项、token 预算余额
  → 若 run 原状态为 running/awaiting_approval → 标记 interrupted
  → 用户选择：
      resume：对可 replay 的后端重放最后一个未完成 turn（或 native resume）
      abandon：写 run.cancelled，触发 ScopeGuard
```

恢复能力分级：

| 后端 | 恢复方式 | 说明 |
|---|---|---|
| claude-code | native resume + replay | 有后端 session id 时优先 native；否则从事件重建 prompt 重发 |
| codex | replay | thread id 仅在内存，重启用事件重建 |
| opencode / CLI | replay | 无状态，只能重发最后一个 turn |
| mcp | replay | 无状态，注入最近上下文 |

**明确承诺边界**：Event Store 能恢复到「最后一条已持久化事件」；不能恢复后端进程内的未上报中间态。UI 不得宣称「精确恢复任意节点」。

### 6.3 `thread.sessionId` 的定位调整

- `chat_threads.session_id` 继续保留，但语义改为「最近一次 run 的 BizGraph runId」，不再当作后端会话 id。
- 后端原生 id 放 `agent_runs.backend_session_id`。
- 这解决现有混用问题（[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L264-L267) + [agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L40-L40)）。

---

## 7. 并发、隔离与取消

### 7.1 SessionExecutor

```ts
interface SessionExecutor {
  submit(runId: string, turn: TurnInput, idempotencyKey: string): Promise<TurnResult>
  cancelRun(runId: string): Promise<void>
  cancelTurn(runId: string, turnId: string): Promise<void>
}
```

- 每个 `runId` 一个串行队列；同 run 的第二个 turn 在前一个未结束时排队，不交错。
- 幂等键 `runId + turnId + commandHash`，重复提交返回同一结果。
- 取消令牌树：`run → turn → tool`；`cancelRun` 先 abort 当前 turn，再清理后续排队项。
- 资源上限继续复用 `MAX_SESSIONS` / `MAX_PROCESSES`（[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L115-L117)），由 Kernel 统一申请/释放。

### 7.2 隔离

- **数据隔离**：每个 run 只读写自己的 `agent_events` / `agent_approvals`；跨 run 共享只读 Context。
- **文件隔离**：ScopeGuard sandbox 按 run 创建（现有能力，[scope-guard.ts](file:///Users/zhumingchen/tiangong/src/main/scope-guard.ts#L276-L288)）。
- **后端隔离**：`SessionRouter` 继续负责 sessionId → adapterName（[session-router.ts](file:///Users/zhumingchen/tiangong/src/main/agent/session-router.ts#L83-L95)），但 Kernel 只通过 runId 寻址，不直接持有 adapter。
- **禁止**：Renderer 直接决定后端或 config 绕过 Kernel（现有 `agent:startSession` 透传问题，[ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L25-L28)）。

### 7.3 取消语义表

| cancel 能力 | Kernel 行为 |
|---|---|
| `abort` | 立即 abort，发 `run.cancelled` |
| `kill` | 杀进程/会话，发 `run.cancelled` |
| `cooperative` | 发取消请求，等待 turn.completed 或超时后标记 `cancelled（未确认）` |
| `none` | 不允许并发新 turn；UI 明示「不可取消，只能等待」 |

---

## 8. IPC 增量设计

保留现有 `agent:*` 通道，新增 run 级通道，避免破坏旧 UI：

| Channel | 参数 | 返回/事件 |
|---|---|---|
| `agent:startRun` | `{ threadId, nodeId?, backend?, config, input }` | `{ runId }` |
| `agent:sendTurn` | `{ runId, input, contextRefs }` | `{ turnId }` |
| `agent:cancelRun` | `{ runId }` | `void` |
| `agent:getRunState` | `{ runId }` | `RunState` |
| `agent:listEvents` | `{ runId, afterSeq?, limit? }` | `AgentEventEnvelope[]` |
| `agent:resumeRun` | `{ runId, mode: 'native' \| 'replay' }` | `{ ok }` |
| `agent:approvalDecision` | `{ approvalId, decision, remember? }` | `{ ok }` |
| `agent:getPendingApprovals` | `{ runId? }` | `PendingApproval[]` |
| `agent:event` | main → renderer | `AgentEventEnvelope` |
| `agent:approvalRequested` | main → renderer | `ApprovalRequest` |
| `agent:runStateChanged` | main → renderer | `{ runId, status }` |

旧通道迁移：`agent:startSession` → `agent:startRun` 的兼容包装；`agent:sendCommand` → `agent:sendTurn`；`agent:onOutput` 继续作为 `agent:event` 的投影。

---

## 9. 与现有代码的映射（改造清单）

### 新增

| 文件 | 内容 |
|---|---|
| `src/shared/types/agent-events.ts` | `AgentEventType`、`AgentEventEnvelope`、各 payload、`RunState` |
| `src/shared/types/agent-capabilities.ts` | `BackendCapabilities`、能力矩阵常量 |
| `src/main/agent/kernel/run-engine.ts` | 状态机、预算、turn 调度 |
| `src/main/agent/kernel/session-executor.ts` | 串行队列、幂等、取消令牌 |
| `src/main/agent/kernel/event-normalizer.ts` | 事件归一与 fidelity 标注 |
| `src/main/agent/kernel/approval-gateway.ts` | 审批 RPC、超时、幂等 |
| `src/main/agent/kernel/tool-runtime.ts` | host-owned 工具执行 |
| `src/main/agent/drivers/claude-driver.ts` | 包 `claude-code.ts` |
| `src/main/agent/drivers/codex-driver.ts` | 包 `codex.ts` |
| `src/main/agent/drivers/opencode-driver.ts` | 包 `opencode.ts` |
| `src/main/agent/drivers/cli-driver.ts` | 通用 CLI |
| `src/main/repositories/agent-run-repository.ts` | run/event/approval/snapshot |

### 修改（渐进）

| 文件 | 改动 |
|---|---|
| `src/main/adapters/base.ts` | 抽出 `emit*` 为可注入的 `EventSink`；保留旧 `AgentOutput` 兼容 |
| `src/main/agent/agent-manager.ts` | 把 `sendCommand` 路径改为委托 `SessionExecutor`；保留公开方法兼容 |
| `src/main/ipc-handlers.ts` | 注册新 IPC；旧 `agent:*` 保留 |
| `src/main/database.ts` | 新增 4 张表 + 索引（不修改现有表） |
| `src/preload/index.ts` | 暴露新通道与事件 |
| `src/renderer/store/sessionStore.ts` | 新 run 模型接入；修掉 `resumeSessionId` 混用 |
| `src/renderer/components/agent/AgentChatPanel.tsx` | 修复 JSX 多根问题；接入 RunTimeline / ApprovalDialog |
| `src/renderer/store/threadStore.ts` | thread 状态改为订阅 Kernel 事件，不再本地硬改 |

### 不改

- `src/shared/types/agent.ts` 的 `AgentSessionConfig` / `AgentOutput` 保留（兼容层）。
- `ScopeGuard`、`ContextWaterline`、`FallbackRouter`、`AdapterRegistry` 继续复用。
- 现有 12 个适配器类不重写，只被 Driver 包装。

---

## 10. 迁移路径（4 个可独立交付的阶段）

### Phase 1：事件归一（不改行为）

- 新增 `agent-events.ts`、`EventNormalizer`。
- Driver 层先以「包装现有 adapter」的方式产出规范事件；Kernel 旁路记录，不接管调度。
- 渲染层可选消费 `agent:event`，旧的 `agent:onOutput` 不变。
- 验收：Claude/Codex/OpenCode 三种事件都能落在同一信封里，`fidelity` 正确。

### Phase 2：持久化 + 审批

- 新增 4 张表与 `agent-run-repository`。
- `ApprovalGateway` + `agent:approvalDecision` / `agent:approvalRequested`。
- Claude 接入原生审批钩子（若验证通过）；Codex/OpenCode 明确 `policy-only` / `hook`。
- 验收：高风险工具调用能阻塞并等待用户；待审批项重启不丢。

### Phase 3：Kernel 接管调度

- `SessionExecutor` 接管 `sendCommand`；per-run 串行；幂等与取消令牌树。
- `thread.sessionId` 语义迁移到 runId；`agent_runs.backend_session_id` 记录原生 id。
- 验收：同 run 并发发送不交错；应用重启后 `interrupted` 状态正确。

### Phase 4：恢复与多后端循环

- 快照 + replay；`agent:resumeRun`。
- host-owned 工具运行时；backend-owned 监督策略。
- 验收：从任意已持久化事件恢复；Codex/OpenCode 能重放最后一个 turn。

---

## 11. 硬约束 → 设计映射

| 报告硬约束 | 设计落点 |
|---|---|
| 必须跨进程 | Kernel/Driver/RunStore 全在 `src/main`；renderer 仅 IPC |
| 必须自带持久化执行状态 | `agent_runs` / `agent_events` / `agent_snapshots` |
| 必须区分三种会话 id | `runId`（BizGraph）、`backendSessionId`（DriverHandle）、`thread.session_id`（仅最近 run 指针） |
| 必须兼容多后端 SDK 差异 | `BackendCapabilities` + `fidelity` + 三种 Driver 策略 |
| 必须新增工具审批 RPC | `ApprovalGateway` + 4 个新 IPC |
| 必须 per-session 串行 | `SessionExecutor` 单 run 队列 |
| 必须把 scope 绑定所有投递路径 | `ContextEngine` 统一注入；旁路 `send-and-wait` 走同一 Kernel |
| 必须保留 A2A 透明转发 | `DriverInput.transparentForward` 透传；Kernel 不加内部上下文 |
| 必须限定恢复承诺 | 恢复只到「最后持久化事件」；UI 文案与状态机显式标注 |
| 必须让 thread 状态权威 | Kernel 写 `agent_runs.status`，renderer 订阅 `agent:runStateChanged` |

---

## 12. 风险与待验证项

1. **Claude SDK 审批钩子签名**：`canUseTool` 类回调在 `0.3.286` 上的确切签名与阻塞语义**未能确认**；未验证前 Claude 只能先按 `policy-only` 设计，审批 UI 标注「事后回滚」。
2. **Codex SDK 是否可中断 / 是否有审批模式**：`doCloseQuery` 只清 Map（[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L179-L179)），SDK 是否暴露 abort **未能确认**。设计按 `cancel: 'cooperative' | 'none'` 保守处理。
3. **OpenCode 工具事件协议**：宿主只看到 stdout，无法区分正文与工具输出；`toolEvents: 'derived'` 是保守假设。
4. **Claude SDK 内部工具循环的审批插入点**：如果 SDK 在内部并行执行多个 tool_use，`decideApproval` 需要支持并发审批；设计需准备 `approval` 的批量/并发语义。
5. **现有 `<tool_call>` 文本协议的可伪造性**：host-owned 工具调用来自模型文本，必须做 schema 校验与白名单，不能直接执行任意工具。
6. **`AgentChatPanel` 的 JSX 多根问题**：接入新 UI 前必须先修复，否则新组件无法稳定挂载（[AgentChatPanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/AgentChatPanel.tsx#L657-L668)）。

---

## 13. 非目标（避免过度设计）

- 不重写 12 个适配器；Driver 是包装层。
- 不引入外部工作流引擎；RunEngine 用现有 TypeScript + better-sqlite3。
- 不做「跨后端完全一致的 token 级流式」；只保证事件协议一致、保真度可查询。
- 不承诺 backend-owned 后端可以逐工具阻塞审批；能力矩阵如实暴露。
- 不把现有 `AgentOutput` 一次性删除；先双写，再按 UI 迁移逐步下线。
