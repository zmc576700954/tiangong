/**
 * Session lifecycle shared types
 *
 * Types extracted from agent-manager.ts as part of D1a (lifecycle separation).
 * These are internal types used by SessionLifecycleManager + AgentManager and
 * are re-exported for downstream consumers (e.g. SubagentManager).
 *
 * Note: NOT exported via @shared/types — these structs hold internal references
 * (sandbox, broadcastName) that the renderer never needs.
 */

import type {
  AgentCommand,
  AgentCommandType,
  AgentOutput,
  AgentSessionConfig,
  AdapterUsageReport,
  Sandbox,
  TerminationReason,
} from '@shared/types'

/**
 * Per-session state tracked by SessionLifecycleManager.
 *
 * Mutated through lifecycle methods only. Read by AgentManager for prompt
 * assembly (lastCommandType, promptTokenEstimate, contextCount) and post-termination
 * bookkeeping (originSessionId for recovery accounting).
 */
export interface SessionState {
  config: AgentSessionConfig
  broadcastName: string
  adapterName: string
  startTime: number
  sandbox?: Sandbox
  /** 最后一次发送的指令类型（用于记忆提取的语义区分） */
  lastCommandType?: AgentCommandType
  /** Prompt Token 估算值（用于质量反馈环） */
  promptTokenEstimate?: number
  /** 注入的上下文数量（用于质量反馈环） */
  contextCount?: number
  /** thread bound to this session — used for waterline lookup & history persistence. */
  threadId?: string
  /** parent session if this is a subagent child session. */
  parentSessionId?: string
  /** subagent_invocations row id if this is a subagent child session. */
  swarmTaskId?: string
  /** Cumulative input tokens reported by the adapter for this session. */
  tokensUsed?: number
  /** Reason the adapter session ended (crash / error / timeout / user / success). */
  terminationReason?: 'success' | 'crash' | 'error' | 'timeout' | 'user' | 'idle'
  /** Last user command sent to this session; used for recovery re-send. */
  lastCommand?: AgentCommand
  /** Original sessionId for replacement sessions created by recovery, used to keep retry accounting across sessionIds. */
  originSessionId?: string
}

/**
 * Result returned from AgentManager.startSession. Includes information about
 * any fallback that occurred during session creation.
 */
export interface StartSessionResult {
  sessionId: string
  fallback?: boolean
  adapterUsed: string
  fallbackHistory: Array<{ adapter: string; reason: string; success: boolean }>
}

/**
 * LifecyclePhaseBCallback — invoked after the cleanup lock is released.
 * Carries immutable snapshots of the session state, output buffer, and any
 * scope-guard error that surfaced during Phase A. The hook must NOT touch
 * lifecycle-owned maps (cleanup is complete by the time it runs).
 */
export type LifecyclePhaseBCallback = (args: {
  sessionId: string
  state: SessionState
  outputs: AgentOutput[]
  reason: TerminationReason | undefined
  scopeGuardError: Error | undefined
}) => Promise<void> | void

/**
 * Abnormal-end callback — invoked when the underlying adapter reports
 * 'crash' | 'error' | 'timeout'. The callback is responsible for running
 * any recovery strategy. Returning 'native' tells lifecycle to keep the
 * session state in its maps (native resume). Returning 'replacement' or
 * 'none' tells lifecycle to clean up resources.
 */
export type LifecycleAbnormalEndCallback = (
  sessionId: string,
  exitCode: number | null,
  reason: 'crash' | 'error' | 'timeout',
  state: SessionState,
  outputs: AgentOutput[],
) => Promise<'native' | 'replacement' | 'none'>

/**
 * Per-turn-complete callback — fired when the adapter emits a 'complete'
 * output. Used by AgentManager to reset session-recovery retry counters
 * (SDK adapters don't emit sessionEnded per turn, only the 'complete' signal).
 */
export type LifecycleTurnCompleteCallback = (sessionId: string) => void

/**
 * 会话资源清理完成后的回调。
 *
 * outcome 区分「正常收尾」与「异常退出」：
 *   - 'success'   —— 会话跑完（agent 正常结束），恢复链路的重试计数应当清零
 *   - 'abnormal'  —— 崩溃 / 超时 / 主动终止，重试计数必须保留（否则会无限重试）
 */
export type LifecycleSessionCleanedUpCallback = (
  sessionId: string,
  outcome: 'success' | 'abnormal',
) => void

/**
 * SG-1：一次 ScopeGuard 越界拦截（sandbox → session 已解析完成）。
 * 记录方（map 层）据此落 `node_scope_violations`；`nodeId` 来自会话配置，
 * 为空表示该会话未绑定节点（记录方应跳过而非造伪行）。
 */
export interface ScopeViolationEvent {
  sandboxId: string
  sessionId: string
  nodeId?: string
  violations: string[]
  workingDirectory: string
}

/** SG-1：越界拦截后 sandbox 回滚的结果（用于回填处置状态）。 */
export interface ScopeRollbackEvent {
  sandboxId: string
  sessionId: string
  /** 仅 true 时回填 `rolled_back`；false 表示仍 `pending`（面板显示「未处置」）。 */
  success: boolean
}

/** SG-1：越界记账 sink（由 map 层实现并注入；两个钩子都必须吞掉自身异常）。 */
export interface ScopeViolationSink {
  onViolation?: (event: ScopeViolationEvent) => void
  onRollback?: (event: ScopeRollbackEvent) => void
}

/**
 * LifecycleCallbacks — set of optional hooks AgentManager provides so the
 * lifecycle manager can stay free of fallback/recovery logic. Lifecycle
 * always degrades safely when callbacks are absent (no recovery, no reset).
 */
export interface LifecycleCallbacks {
  /** Called on per-turn 'complete' output. */
  onTurnComplete?: LifecycleTurnCompleteCallback
  /** Called on sessionEnded abnormal event. Return 'native' to keep state. */
  onSessionAbnormalEnded?: LifecycleAbnormalEndCallback
  /** Phase B hook called after lifecycle's cleanup lock is released. */
  onPhaseB?: LifecyclePhaseBCallback
  /**
   * Called after a native-resume recovery successfully re-establishes the
   * session. Lifecycle has cleared transient crash artifacts (output buffer,
   * session output listeners); use this hook to clear any AgentManager-owned
   * per-session caches (e.g. compactInflight).
   */
  onNativeResume?: (sessionId: string) => void
  /**
   * Called after the lifecycle released every per-session resource.
   * AgentManager uses it to drop its own session-state mirror — without it
   * the mirror keeps entries for every session that ended on its own.
   */
  onSessionCleanedUp?: LifecycleSessionCleanedUpCallback
  /**
   * M1 成本账本：适配器上报 usage（含 unknown 占位，complete 无 usage 时由
   * lifecycle 合成）。AgentManager 负责归属 chat_threads 并写入 UsageLedger。
   */
  onAdapterUsage?: (adapterName: string, data: AdapterUsageReport) => void
  /**
   * SG-1：越界拦截发生时调用（在 terminate 之前）。实现方负责落库，**不得抛**——
   * lifecycle 的越界处置不能被记账失败拖住。
   */
  onScopeViolation?: (event: ScopeViolationEvent) => void
  /**
   * SG-1：越界后的 sandbox 回滚收尾。`success=false` 时记录应留在 pending，
   * 不得回填成「已回滚」。
   */
  onScopeRollback?: (event: ScopeRollbackEvent) => void
}