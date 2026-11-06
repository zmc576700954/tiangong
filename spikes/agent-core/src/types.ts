/**
 * 命名口径：以 AGENT_ARCHITECTURE_DESIGN.md 为准。
 * - 基本单位是 run；一次 send() 对应一个 turn。
 * - 事件信封是 AgentEventEnvelope。
 * - 事件保真度采用 token | turn | session。
 * - 事件来源用 source: backend | kernel | synthetic 表达是否为宿主合成。
 *
 * 注意：新文档 §2.2 的信封示例仍写 exact|derived|coarse，与本文件的 token|turn|session
 * 存在文档内部冲突；spike 按补充指令采用后者，详见 README「命名与语义冲突清单」。
 */

export type BackendName = 'claude-code' | 'codex' | 'opencode'

export type EventFidelity = 'token' | 'turn' | 'session'
export type EventSource = 'backend' | 'kernel' | 'synthetic'

export type AgentEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.paused'
  | 'run.resumed'
  | 'run.interrupted'
  | 'turn.started'
  | 'turn.completed'
  | 'message.delta'
  | 'message.completed'
  | 'reasoning.delta'
  | 'reasoning.completed'
  | 'tool.requested'
  | 'tool.approval_required'
  | 'tool.approved'
  | 'tool.denied'
  | 'tool.started'
  | 'tool.result'
  | 'tool.failed'
  | 'usage.updated'
  | 'artifact.changed'
  | 'log.delta'

export interface BackendRef {
  /** claude-code / codex / opencode */
  name: string
  /** 后端原生会话 id（不是 BizGraph runId） */
  sessionId?: string
  /** SDK 原始 type/subtype，便于排障 */
  nativeType?: string
}

export interface AgentEventEnvelope<T = unknown> {
  eventId: string
  runId: string
  /** run 内单调递增，从 1 开始；连续性由持久化层校验 */
  seq: number
  turnId: string
  stepId?: string
  /**
   * 新文档 §2.2 的信封示例漏了事件类型字段；没有它无法落库与恢复。
   * spike 显式补上 type，作为最小必要扩展（README 已记录）。
   */
  type: AgentEventType
  ts: number
  payload: T
  source: EventSource
  fidelity: EventFidelity
  backend: BackendRef
}

export interface RunStartedPayload {
  attempt: number
  resumeMode: 'native' | 'replay' | 'fresh'
}

export interface MessagePayload {
  role: 'assistant'
  text: string
  mode: 'token' | 'block'
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface ToolRequestedPayload {
  toolCallId: string
  toolName: string
  input: unknown
  risk: RiskLevel
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

export interface UsagePayload {
  inputTokens?: number
  outputTokens?: number
  maxTokens?: number
  contextWindow?: number
}

export interface RunTerminalPayload {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  summary?: string
  failure?: { class: string; code: string; message: string }
  usage?: UsagePayload
}

export interface ApprovalRequiredPayload {
  approvalId: string
  toolCallId: string
  toolName: string
  input: unknown
  risk: RiskLevel
  blocking: boolean
  expiresAt: number
}

export interface ArtifactChangedPayload {
  path: string
  changeType: 'add' | 'modify' | 'delete'
  afterHash?: string
  postHoc: boolean
}

export type EventPayload =
  | RunStartedPayload
  | MessagePayload
  | ToolRequestedPayload
  | ToolResultPayload
  | UsagePayload
  | RunTerminalPayload
  | ApprovalRequiredPayload
  | ArtifactChangedPayload
  | Record<string, unknown>

/** 语义检查点：过滤 delta/usage/log 后的生命周期序列 */
export const CHECKPOINT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  'run.started',
  'turn.started',
  'message.completed',
  'tool.requested',
  'tool.approval_required',
  'tool.approved',
  'tool.denied',
  'tool.result',
  'tool.failed',
  'turn.completed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
])

export type RunStatus =
  | 'created'
  | 'running'
  | 'awaiting_approval'
  | 'cancelling'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'created',
  'running',
  'awaiting_approval',
  'cancelling',
  'interrupted',
]

export type StepDisposition = 'completed' | 'unknown-needs-rerun' | 'needs-human'

export type RecoveryStrategy = 'resume-native' | 'replay' | 'abandon'

export interface StepDispositionRecord {
  stepId: string
  seq: number
  toolName: string | null
  disposition: StepDisposition
  reason: string
}

export interface RecoveryPlan {
  runId: string
  nodeId: string
  strategy: RecoveryStrategy
  /** 新文档 §6.2：由用户选择 resume / abandon */
  requiresUserConfirmation: boolean
  stepOutcomes: StepDispositionRecord[]
  reason: string
}

export interface BackendCapabilities {
  /** 后可观测的最小粒度 */
  eventFidelity: 'token' | 'turn' | 'session'
  /** 谁拥有工具循环 */
  loopOwnership: 'backend' | 'host'
  /** 工具事件可得性 */
  toolEvents: 'exact' | 'derived' | 'none'
  approval: 'native' | 'hook' | 'policy-only'
  cancel: 'abort' | 'kill' | 'cooperative' | 'none'
  resume: 'native' | 'replay' | 'none'
  reasoning: boolean
  parallelToolCalls: boolean
  streamingText: boolean
}

export interface NormalizeMeta {
  runId: string
  turnId: string
  sessionId?: string
}

export interface SessionLockHandle {
  readonly key: string
  release(): void
}

export class SessionBusyError extends Error {
  readonly code = 'SESSION_BUSY'
  constructor(key: string) {
    super(`SESSION_BUSY: ${key}`)
    this.name = 'SessionBusyError'
  }
}

export class NodeBusyError extends Error {
  readonly code = 'NODE_BUSY'
  constructor(nodeId: string) {
    super(`NODE_BUSY: ${nodeId}`)
    this.name = 'NodeBusyError'
  }
}

export class EventLogCorruptError extends Error {
  readonly code = 'EVENT_LOG_CORRUPT'
  constructor(message: string) {
    super(`EVENT_LOG_CORRUPT: ${message}`)
    this.name = 'EventLogCorruptError'
  }
}

export type ApprovalDecisionValue = 'allow' | 'deny' | 'allow_session'
export type ApprovalResolvedBy = 'user' | 'timeout' | 'cancel'

export interface ApprovalRow {
  approvalId: string
  runId: string
  turnId: string
  toolCallId: string
  toolName: string
  input: unknown
  risk: RiskLevel
  decision: ApprovalDecisionValue | null
  resolvedBy: ApprovalResolvedBy | null
  expiresAt: number
  createdAt: number
  resolvedAt: number | null
}

export interface DecideResult {
  approvalId: string
  ok: boolean
  decision: ApprovalDecisionValue | null
  resolvedBy: ApprovalResolvedBy | null
  /** true 表示返回的是首次结果，未重复落库/落事件 */
  idempotent: boolean
}
