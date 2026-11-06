/**
 * D1 仓储层：9 张 Agent 表的读写。
 *
 * 所有方法都接收显式的 run/turn/session 标识，不做隐式「当前上下文」推断。
 * 时间戳统一使用毫秒整数。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { eventIdFor, localDayKey, newId } from '../util'
import { redactArgsJson, redactPayload, REDACTION_META_KEY } from '../../../shared/redaction'
import type {
  AgentUsageRecord,
  ApprovalStatus,
  DecidedBy,
  Fidelity,
  GraphDayUsageSummary,
  NormalizedEventEnvelope,
  RecoveryPlan,
  ResidualRisk,
  RiskLevel,
  RunStatus,
  StepStatus,
  TurnStatus,
  UsageCostStatus,
  UsageSummary,
} from '@shared/types/agent-runtime'

export type AgentUsageRow = AgentUsageRecord
export type { GraphDayUsageSummary, UsageSummary } from '@shared/types/agent-runtime'

/** agent_usage 的统一聚合列：缺价行单独计数，绝不把 NULL 当 0 混进金额。 */
const USAGE_SUMMARY_COLUMNS = `
  COUNT(*) AS totalRows,
  COALESCE(SUM(cost_micros), 0) AS knownCostMicros,
  COALESCE(SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END), 0) AS unknownCostRows,
  COALESCE(SUM(CASE WHEN cost_micros IS NULL AND source != 'unknown' THEN 1 ELSE 0 END), 0) AS unpricedRows,
  COALESCE(SUM(CASE WHEN source = 'provider' THEN 1 ELSE 0 END), 0) AS providerRows,
  COALESCE(SUM(CASE WHEN source = 'estimated' THEN 1 ELSE 0 END), 0) AS estimatedRows,
  COALESCE(SUM(CASE WHEN source = 'unknown' THEN 1 ELSE 0 END), 0) AS unknownRows,
  COALESCE(SUM(CASE WHEN cost_status = 'priced' THEN 1 ELSE 0 END), 0) AS pricedRows,
  COALESCE(SUM(CASE WHEN cost_status = 'missing_price' THEN 1 ELSE 0 END), 0) AS missingPriceRows,
  COALESCE(SUM(CASE WHEN cost_status = 'not_reported' THEN 1 ELSE 0 END), 0) AS notReportedRows,
  COALESCE(SUM(CASE WHEN cost_status IS NULL THEN 1 ELSE 0 END), 0) AS costStatusUnknownRows,
  COALESCE(SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknownTokenRows,
  COALESCE(SUM(CASE WHEN tokens_reported = 1 THEN 1 ELSE 0 END), 0) AS tokensReportedRows,
  COALESCE(SUM(CASE WHEN tokens_reported = 0 THEN 1 ELSE 0 END), 0) AS tokensNotReportedRows,
  COALESCE(SUM(CASE WHEN tokens_reported IS NULL THEN 1 ELSE 0 END), 0) AS tokensReportedUnknownRows,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens
`

export interface AgentRunRow {
  id: string
  thread_id: string
  node_id: string | null
  graph_id: string | null
  executor: string
  status: RunStatus
  created_at: number
  updated_at: number
}

export interface AgentSessionRow {
  id: string
  graph_id: string | null
  node_id: string | null
  thread_id: string | null
  executor: string
  runtime_session_id: string | null
  executor_handle: string | null
  executor_pid: number | null
  executor_pgid: number | null
  executor_started_at: string | null
  executor_cmd: string | null
  executor_env_marker: string | null
  residual_risk: ResidualRisk
  status: 'starting' | 'active' | 'idle' | 'orphaned' | 'closed'
  workspace_mode: 'shared' | 'worktree'
  workspace_path: string | null
  last_turn_id: string | null
  last_recovery_at: number | null
  recovery_kills: number
  recovery_note: string | null
  created_at: number
  updated_at: number
}

export interface AgentTurnRow {
  id: string
  run_id: string
  session_id: string
  graph_id: string | null
  node_id: string
  group_id: string | null
  parent_turn_id: string | null
  branch_key: string
  attempt: number
  status: TurnStatus
  resume_mode: 'native' | 'replay' | 'fresh'
  idempotency_key: string
  input_json: string
  output_json: string | null
  failure_class: string | null
  error_code: string | null
  started_at: number | null
  ended_at: number | null
  deadline_at: number | null
  created_at: number
  /** @deprecated 遗留列：无生产写入方，保留策略不看它（保留仅为兼容旧库）。 */
  retention_hold: number
}

export interface AgentStepRow {
  id: string
  turn_id: string
  seq: number
  kind: string
  tool_name: string | null
  status: StepStatus
  args_hash: string | null
  result_ref: string | null
  fidelity: Fidelity
  test_disposition: string | null
  approved_at: number | null
  executing_at: number | null
  started_at: number | null
  ended_at: number | null
}

export interface AgentApprovalRow {
  id: string
  run_id: string
  turn_id: string
  step_id: string | null
  tool_name: string
  args_json: string
  args_hash: string
  risk: RiskLevel
  policy_decision: 'allow' | 'deny' | 'ask'
  status: ApprovalStatus
  decided_by: DecidedBy | null
  decided_at: number | null
  /** 决策原因（如启动对账将陈旧 pending 置为 denied 的说明） */
  decision_note: string | null
  expires_at: number
  mode: 'interactive' | 'unattended'
  timeout_ms: number
  /** 请求时的会话工作目录（会话级授权的路径作用域根） */
  cwd: string | null
  /** 本次允许来自会话级授权时的来源 approval id */
  grant_source: string | null
  created_at: number
}

export interface InsertTurnInput {
  id?: string
  runId: string
  sessionId: string
  graphId?: string
  nodeId: string
  groupId?: string
  parentTurnId?: string
  branchKey?: string
  attempt?: number
  status?: TurnStatus
  resumeMode: 'native' | 'replay' | 'fresh'
  idempotencyKey: string
  input: Record<string, unknown>
  deadlineAt?: number
}

export interface InsertApprovalInput {
  id?: string
  runId: string
  turnId: string
  stepId?: string
  toolName: string
  argsJson: string
  argsHash: string
  risk: RiskLevel
  policyDecision?: 'allow' | 'deny' | 'ask'
  status?: ApprovalStatus
  expiresAt: number
  mode: 'interactive' | 'unattended'
  timeoutMs: number
  cwd?: string
  /** 会话级授权的来源 approval id（自动放行时写入，供审计） */
  grantSource?: string
}

// ---------------------------------------------------------
// P0-2：事件保留策略
// ---------------------------------------------------------

export interface EventRetentionPolicy {
  /** 已终态 turn 的事件保留天数（默认 90） */
  retentionDays: number
  /** 单批删除行数上限（默认且最大 500，避免长事务阻塞） */
  batchSize: number
}

export const DEFAULT_EVENT_RETENTION: EventRetentionPolicy = { retentionDays: 90, batchSize: 500 }
/** 硬上限：无论配置多大，单条 DELETE 都不超过 500 行。 */
export const MAX_RETENTION_BATCH_SIZE = 500
/**
 * 续接锚点事件：`run.started` 的 payload 里的 `backendSessionId` 是 native resume 的
 * 唯一来源（Claude conversation id / Codex thread id）。清理永远跳过该类型，
 * 保证「事件保留 90 天」与「会话可续接」解耦。
 */
const RESUME_ANCHOR_EVENT_TYPE = 'run.started'

export type RetentionSkipReason =
  | 'not-terminal'
  | 'pending-approval'
  | 'irreconcilable'

export interface EventRetentionSkip {
  turnId: string
  reason: RetentionSkipReason
  /** 该 turn 中已超过保留期、但因跳过而未删除的事件行数 */
  eventRows: number
}

export interface EventRetentionResult {
  cutoff: number
  retentionDays: number
  batchSize: number
  deletedRows: number
  /** DELETE 语句执行次数（用于断言「分批而非一次性持锁」） */
  batches: number
  oldestDeletedAt: number | null
  newestDeletedAt: number | null
  skipped: EventRetentionSkip[]
  eligibleTurnCount: number
}

export interface EventStorageStats {
  eventRows: number
  /** agent_events 占用估算（字节） */
  estimatedBytes: number
  oldestEventAt: number | null
  newestEventAt: number | null
  /** 估算来源：dbstat=SQLite 页统计；payload=序列化字节 + 行开销估算 */
  estimation: 'dbstat' | 'payload'
}

const DAY_MS = 24 * 60 * 60 * 1000

const ACTIVE_TURN_STATUSES: TurnStatus[] = ['running', 'waiting_approval', 'cancelling']
const OPEN_STEP_STATUSES: StepStatus[] = ['requested', 'awaiting_approval', 'approved', 'running']
const TERMINAL_TURN_STATUSES: TurnStatus[] = ['completed', 'failed', 'cancelled', 'orphaned']

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** 后端确实上报了该 token 维度（有限数字）；null/undefined 都算「没报」，不是 0。 */
function isReportedToken(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

export class AgentRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  // ---------------------------------------------------------
  // Runs
  // ---------------------------------------------------------
  insertRun(input: {
    id?: string
    threadId: string
    nodeId?: string
    graphId?: string
    executor: string
    status?: RunStatus
    now?: number
  }): AgentRunRow {
    const now = input.now ?? Date.now()
    const id = input.id ?? newId('run')
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, thread_id, node_id, graph_id, executor, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.threadId, input.nodeId ?? null, input.graphId ?? null, input.executor, input.status ?? 'created', now, now)
    return this.getRun(id)!
  }

  getRun(runId: string): AgentRunRow | null {
    return (this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as AgentRunRow | undefined) ?? null
  }

  updateRunStatus(runId: string, status: RunStatus, now = Date.now()): void {
    this.db.prepare('UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, runId)
  }

  /** 由 turns 投影 run 状态，返回投影后的状态。 */
  projectRunStatus(runId: string, now = Date.now()): RunStatus {
    const turns = this.listTurnsByRun(runId)
    let status: RunStatus
    if (turns.length === 0) {
      status = 'created'
    } else if (turns.some((t) => t.status === 'cancelling')) {
      status = 'cancelling'
    } else if (turns.some((t) => t.status === 'waiting_approval')) {
      status = 'awaiting_approval'
    } else if (turns.some((t) => ACTIVE_TURN_STATUSES.includes(t.status))) {
      status = 'running'
    } else if (turns.every((t) => t.status === 'completed')) {
      status = 'completed'
    } else if (turns.some((t) => t.status === 'orphaned')) {
      status = 'interrupted'
    } else if (turns.some((t) => t.status === 'failed')) {
      status = 'failed'
    } else if (turns.every((t) => t.status === 'cancelled')) {
      status = 'cancelled'
    } else {
      status = 'interrupted'
    }
    this.updateRunStatus(runId, status, now)
    return status
  }

  // ---------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------
  insertSession(input: {
    id?: string
    graphId?: string
    nodeId?: string
    threadId?: string
    executor: string
    runtimeSessionId?: string
    executorEnvMarker?: string
    status?: AgentSessionRow['status']
    workspacePath?: string
    now?: number
  }): AgentSessionRow {
    const now = input.now ?? Date.now()
    const id = input.id ?? newId('sess')
    this.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, graph_id, node_id, thread_id, executor, runtime_session_id, executor_env_marker, status, workspace_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.graphId ?? null,
        input.nodeId ?? null,
        input.threadId ?? null,
        input.executor,
        input.runtimeSessionId ?? null,
        input.executorEnvMarker ?? null,
        input.status ?? 'starting',
        input.workspacePath ?? null,
        now,
        now,
      )
    return this.getSession(id)!
  }

  getSession(sessionId: string): AgentSessionRow | null {
    return (this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId) as AgentSessionRow | undefined) ?? null
  }

  updateSessionStatus(sessionId: string, status: AgentSessionRow['status'], now = Date.now()): void {
    this.db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, now, sessionId)
  }

  /**
   * 写入本轮进程句柄与归属证据。
   *
   * 关键语义：**pid 一旦给出，就是「本轮新句柄快照」**——pid/pgid/started_at/cmd
   * 必须整体覆盖，不能借 COALESCE 让上一轮的陈旧值存活（P0-A/P0-2）。
   * 只有单独设置 envMarker（无 pid）时才走 COALESCE，避免抹掉已有句柄。
   */
  updateSessionProcess(
    sessionId: string,
    proc: {
      pid?: number | null
      pgid?: number | null
      command?: string | null
      startedAt?: string | null
      envMarker?: string | null
    },
    now = Date.now(),
  ): void {
    if (proc.pid !== undefined && proc.pid !== null) {
      this.db
        .prepare(
          `UPDATE agent_sessions
              SET executor_pid = ?,
                  executor_pgid = ?,
                  executor_started_at = ?,
                  executor_cmd = ?,
                  executor_env_marker = COALESCE(?, executor_env_marker),
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          proc.pid,
          proc.pgid ?? null,
          proc.startedAt ?? null,
          proc.command ?? null,
          proc.envMarker ?? null,
          now,
          sessionId,
        )
      return
    }
    this.db
      .prepare(
        `UPDATE agent_sessions
            SET executor_env_marker = COALESCE(?, executor_env_marker),
                updated_at = ?
          WHERE id = ?`,
      )
      .run(proc.envMarker ?? null, now, sessionId)
  }

  /** turn 终态：显式清空句柄与归属证据，禁止陈旧句柄进入下一轮取消/重启回收路径。 */
  clearSessionProcess(sessionId: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE agent_sessions
            SET executor_pid = NULL,
                executor_pgid = NULL,
                executor_started_at = NULL,
                executor_cmd = NULL,
                executor_env_marker = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(now, sessionId)
  }

  touchSessionTurn(sessionId: string, turnId: string, now = Date.now()): void {
    this.db.prepare('UPDATE agent_sessions SET last_turn_id = ?, updated_at = ? WHERE id = ?').run(turnId, now, sessionId)
  }

  /** 启动清扫结果落库（可在 UI/日志之外被后续会话审计）。 */
  recordSessionRecovery(
    sessionId: string,
    input: { kills: number; note: string; clearProc?: boolean; residualRisk?: ResidualRisk },
    now = Date.now(),
  ): void {
    const clear = input.clearProc ? 1 : 0
    this.db
      .prepare(
        `UPDATE agent_sessions
            SET last_recovery_at = ?,
                recovery_kills = ?,
                recovery_note = ?,
                residual_risk = ?,
                executor_pid = CASE WHEN ? THEN NULL ELSE executor_pid END,
                executor_pgid = CASE WHEN ? THEN NULL ELSE executor_pgid END,
                executor_started_at = CASE WHEN ? THEN NULL ELSE executor_started_at END,
                executor_cmd = CASE WHEN ? THEN NULL ELSE executor_cmd END,
                executor_env_marker = CASE WHEN ? THEN NULL ELSE executor_env_marker END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        now,
        input.kills,
        input.note,
        input.residualRisk ?? 'none',
        clear,
        clear,
        clear,
        clear,
        clear,
        now,
        sessionId,
      )
  }

  /** 会话恢复状态投影（renderer 头部徽标 / IPC 只读）。 */
  getSessionRecovery(sessionId: string): {
    sessionId: string
    residualRisk: ResidualRisk
    recoveryNote: string | null
    recoveryKills: number
    lastRecoveryAt: number | null
  } | null {
    const row = this.getSession(sessionId)
    if (!row) return null
    return {
      sessionId: row.id,
      residualRisk: row.residual_risk,
      recoveryNote: row.recovery_note,
      recoveryKills: row.recovery_kills,
      lastRecoveryAt: row.last_recovery_at,
    }
  }

  listSessionsByStatus(status: AgentSessionRow['status']): AgentSessionRow[] {
    return this.db.prepare('SELECT * FROM agent_sessions WHERE status = ? ORDER BY updated_at DESC').all(status) as AgentSessionRow[]
  }

  // ---------------------------------------------------------
  // Turns
  // ---------------------------------------------------------
  insertTurn(input: InsertTurnInput): AgentTurnRow {
    const now = Date.now()
    const id = input.id ?? newId('turn')
    const branchKey = input.branchKey ?? ''
    const status = input.status ?? 'running'
    try {
      this.db
        .prepare(
          `INSERT INTO agent_turns
             (id, run_id, session_id, graph_id, node_id, group_id, parent_turn_id, branch_key,
              attempt, status, resume_mode, idempotency_key, input_json, deadline_at, created_at, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.runId,
          input.sessionId,
          input.graphId ?? null,
          input.nodeId,
          input.groupId ?? null,
          input.parentTurnId ?? null,
          branchKey,
          input.attempt ?? 1,
          status,
          input.resumeMode,
          input.idempotencyKey,
          JSON.stringify(input.input),
          input.deadlineAt ?? null,
          now,
          status === 'running' || status === 'waiting_approval' || status === 'cancelling' ? now : null,
        )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('ux_turns_active') || message.includes('agent_turns.node_id')) {
        // 由调用方映射成 NodeBusyError（仓储不依赖领域错误类型，保持薄）
        const wrapped = new Error(`NODE_BUSY:${input.nodeId}:${branchKey}`)
        ;(wrapped as Error & { cause?: unknown }).cause = err
        throw wrapped
      }
      throw err
    }
    return this.getTurn(id)!
  }

  getTurn(turnId: string): AgentTurnRow | null {
    return (this.db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(turnId) as AgentTurnRow | undefined) ?? null
  }

  /**
   * 按幂等键查 turn。
   *
   * 传 sessionId 时额外限定会话：幂等键本身含 session 前缀（见 AgentRuntime.runNode），
   * 这里再加一道会话过滤，保证跨会话绝不命中复用。
   */
  findTurnByIdempotencyKey(key: string, sessionId?: string): AgentTurnRow | null {
    const row = sessionId
      ? this.db
          .prepare('SELECT * FROM agent_turns WHERE idempotency_key = ? AND session_id = ?')
          .get(key, sessionId)
      : this.db.prepare('SELECT * FROM agent_turns WHERE idempotency_key = ?').get(key)
    return (row as AgentTurnRow | undefined) ?? null
  }

  listTurnsByRun(runId: string): AgentTurnRow[] {
    return this.db.prepare('SELECT * FROM agent_turns WHERE run_id = ? ORDER BY created_at ASC').all(runId) as AgentTurnRow[]
  }

  listTurnsBySession(sessionId: string): AgentTurnRow[] {
    return this.db.prepare('SELECT * FROM agent_turns WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as AgentTurnRow[]
  }

  /**
   * 进程重启恢复：把 runtime_session_id 对齐到重建后的适配器句柄 id。
   * 只更新既有行，**不新增 agent_sessions**（重启重复恢复也不会产生重复行）。
   */
  updateSessionRuntimeSessionId(sessionId: string, runtimeSessionId: string, now = Date.now()): void {
    this.db.prepare('UPDATE agent_sessions SET runtime_session_id = ?, updated_at = ? WHERE id = ?').run(runtimeSessionId, now, sessionId)
  }

  /**
   * 取该会话最近一次 run.started 里记录的底层会话 id（Claude conversation id /
   * Codex thread id 等），用于进程重启后的原生续接。没有则返回 null。
   */
  getLatestBackendSessionId(sessionId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT e.payload_json AS payloadJson
           FROM agent_events e
           JOIN agent_turns t ON t.id = e.turn_id
          WHERE t.session_id = ? AND e.type = 'run.started'
          ORDER BY e.created_at DESC, e.seq DESC
          LIMIT 1`,
      )
      .get(sessionId) as { payloadJson: string } | undefined
    if (!row) return null
    try {
      const payload = JSON.parse(row.payloadJson) as { backendSessionId?: unknown }
      return typeof payload.backendSessionId === 'string' && payload.backendSessionId.length > 0
        ? payload.backendSessionId
        : null
    } catch {
      return null
    }
  }

  listActiveTurns(): AgentTurnRow[] {
    return this.db
      .prepare(`SELECT * FROM agent_turns WHERE status IN ('running','waiting_approval','cancelling') ORDER BY created_at ASC`)
      .all() as AgentTurnRow[]
  }

  listAllNonTerminalTurns(): AgentTurnRow[] {
    return this.db
      .prepare(`SELECT * FROM agent_turns WHERE status IN ('queued','running','waiting_approval','cancelling') ORDER BY created_at ASC`)
      .all() as AgentTurnRow[]
  }

  updateTurnStatus(
    turnId: string,
    status: TurnStatus,
    extra?: { endedAt?: number; output?: Record<string, unknown>; errorCode?: string; failureClass?: string },
    now = Date.now(),
  ): void {
    const ended = extra?.endedAt ?? (TERMINAL_TURN_STATUSES.includes(status) ? now : null)
    this.db
      .prepare(
        `UPDATE agent_turns
            SET status = ?,
                ended_at = COALESCE(?, ended_at),
                output_json = COALESCE(?, output_json),
                error_code = COALESCE(?, error_code),
                failure_class = COALESCE(?, failure_class)
          WHERE id = ?`,
      )
      .run(
        status,
        ended,
        extra?.output ? JSON.stringify(extra.output) : null,
        extra?.errorCode ?? null,
        extra?.failureClass ?? null,
        turnId,
      )
  }

  countActiveTurnsByNode(nodeId: string, branchKey = ''): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_turns
          WHERE node_id = ? AND branch_key = ? AND status IN ('running','waiting_approval','cancelling')`,
      )
      .get(nodeId, branchKey) as { count: number }
    return row.count
  }

  // ---------------------------------------------------------
  // Steps
  // ---------------------------------------------------------
  nextStepSeq(turnId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_steps WHERE turn_id = ?').get(turnId) as { seq: number }
    return row.seq + 1
  }

  /** 幂等 upsert：同 id 只更新状态与时间戳，不改变 seq。 */
  upsertStep(input: {
    id: string
    turnId: string
    kind: string
    toolName?: string
    status: StepStatus
    argsHash?: string
    fidelity: Fidelity
    executingAt?: number
    approvedAt?: number
    startedAt?: number
    endedAt?: number
    resultRef?: string
  }): AgentStepRow {
    const now = Date.now()
    const existing = this.db.prepare('SELECT * FROM agent_steps WHERE id = ?').get(input.id) as AgentStepRow | undefined
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO agent_steps
             (id, turn_id, seq, kind, tool_name, status, args_hash, result_ref, fidelity,
              approved_at, executing_at, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.turnId,
          this.nextStepSeq(input.turnId),
          input.kind,
          input.toolName ?? null,
          input.status,
          input.argsHash ?? null,
          input.resultRef ?? null,
          input.fidelity,
          input.approvedAt ?? null,
          input.executingAt ?? null,
          input.startedAt ?? now,
          input.endedAt ?? null,
        )
    } else {
      this.db
        .prepare(
          `UPDATE agent_steps
              SET status = ?, tool_name = COALESCE(?, tool_name), args_hash = COALESCE(?, args_hash),
                  result_ref = COALESCE(?, result_ref),
                  approved_at = COALESCE(?, approved_at),
                  executing_at = COALESCE(?, executing_at),
                  started_at = COALESCE(?, started_at),
                  ended_at = COALESCE(?, ended_at)
            WHERE id = ?`,
        )
        .run(
          input.status,
          input.toolName ?? null,
          input.argsHash ?? null,
          input.resultRef ?? null,
          input.approvedAt ?? null,
          input.executingAt ?? null,
          input.startedAt ?? null,
          input.endedAt ?? null,
          input.id,
        )
    }
    return this.db.prepare('SELECT * FROM agent_steps WHERE id = ?').get(input.id) as AgentStepRow
  }

  updateStepStatus(
    stepId: string,
    status: StepStatus,
    extra?: { executingAt?: number; approvedAt?: number; endedAt?: number; resultRef?: string },
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE agent_steps
            SET status = ?,
                executing_at = COALESCE(?, executing_at),
                approved_at = COALESCE(?, approved_at),
                ended_at = COALESCE(?, ended_at),
                result_ref = COALESCE(?, result_ref)
          WHERE id = ?`,
      )
      .run(
        status,
        extra?.executingAt ?? null,
        extra?.approvedAt ?? null,
        extra?.endedAt ?? (TERMINAL_STEP_STATUSES.includes(status) ? now : null),
        extra?.resultRef ?? null,
        stepId,
      )
  }

  listSteps(turnId: string): AgentStepRow[] {
    return this.db.prepare('SELECT * FROM agent_steps WHERE turn_id = ? ORDER BY seq ASC').all(turnId) as AgentStepRow[]
  }

  listOpenSteps(turnId: string): AgentStepRow[] {
    return this.listSteps(turnId).filter((step) => OPEN_STEP_STATUSES.includes(step.status))
  }

  /** 写入恢复处置（§5.5 五行判定结果）。 */
  setStepDisposition(stepId: string, disposition: string): void {
    this.db.prepare('UPDATE agent_steps SET test_disposition = ? WHERE id = ?').run(disposition, stepId)
  }

  /** 将未闭合步骤置为 aborted，并写入确定处置（默认 unknown-needs-rerun，不宣称成功）。 */
  abortOpenSteps(turnId: string, now = Date.now(), disposition = 'unknown-needs-rerun'): number {
    return this.db
      .prepare(
        `UPDATE agent_steps SET status = 'aborted', ended_at = ?, test_disposition = ?
          WHERE turn_id = ? AND status IN ('requested','awaiting_approval','approved','running','unknown')`,
      )
      .run(now, disposition, turnId).changes
  }

  // ---------------------------------------------------------
  // Events
  // ---------------------------------------------------------
  /**
   * 批量追加事件：run 级 seq 在同一事务内连续分配；turn_seq 保留归一化器给的局部 seq。
   * 返回落库后的 run 级 seq 映射。
   */
  appendEvents(events: NormalizedEventEnvelope[]): number[] {
    if (events.length === 0) return []
    const runIds = new Set(events.map((event) => event.runId))
    if (runIds.size !== 1) throw new Error('appendEvents requires a single runId per batch')
    const runId = events[0].runId
    const insert = this.db.prepare(
      `INSERT INTO agent_events
         (id, run_id, turn_id, seq, turn_seq, type, source, fidelity, payload_version, payload_json, created_at, step_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    const write = this.db.transaction((batch: NormalizedEventEnvelope[]) => {
      const current = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_events WHERE run_id = ?').get(runId) as { seq: number }
      let seq = current.seq
      const assigned: number[] = []
      for (const event of batch) {
        seq += 1
        assigned.push(seq)
        // 隐私：只对落库副本脱敏（不修改 event 对象，审批卡片/实时旁路仍拿到原文）。
        const redacted = redactPayload(event.payload)
        const storedPayload =
          redacted.meta === null ? redacted.payload : { ...redacted.payload, [REDACTION_META_KEY]: redacted.meta }
        insert.run(
          event.eventId || eventIdFor(event.turnId, event.seq),
          event.runId,
          event.turnId,
          seq,
          event.seq,
          event.type,
          event.source,
          event.fidelity,
          event.payloadVersion,
          JSON.stringify(storedPayload),
          event.timestamp,
          event.stepId ?? null,
        )
      }
      return assigned
    })

    return write(events)
  }

  listEvents(runId: string): Array<Omit<AgentEventRow, 'payload_json'> & { payload: Record<string, unknown> }> {
    return (this.db.prepare('SELECT * FROM agent_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as AgentEventRow[]).map(
      (row) => ({ ...row, payload: parseJson<Record<string, unknown>>(row.payload_json, {}) }),
    )
  }

  listTurnEvents(turnId: string): Array<Omit<AgentEventRow, 'payload_json'> & { payload: Record<string, unknown> }> {
    return (this.db.prepare('SELECT * FROM agent_events WHERE turn_id = ? ORDER BY turn_seq ASC').all(turnId) as AgentEventRow[]).map(
      (row) => ({ ...row, payload: parseJson<Record<string, unknown>>(row.payload_json, {}) }),
    )
  }

  /**
   * P3：按 stepId 直接取得该步骤的完整事件序列（策略规则、工具请求/结果、审批决策都在内）。
   * stepId 与 agent_approvals.step_id 同一口径（`<turnId>:<localStepId>`），调用方无需拼 turn_id + seq。
   * 历史事件 step_id 为 NULL，自然不进入任何步骤结果集。
   */
  listStepEvents(stepId: string): Array<Omit<AgentEventRow, 'payload_json'> & { payload: Record<string, unknown> }> {
    return (this.db.prepare('SELECT * FROM agent_events WHERE step_id = ? ORDER BY turn_seq ASC').all(stepId) as AgentEventRow[]).map(
      (row) => ({ ...row, payload: parseJson<Record<string, unknown>>(row.payload_json, {}) }),
    )
  }

  // ---------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------
  insertApproval(input: InsertApprovalInput): AgentApprovalRow {
    const id = input.id ?? newId('appr')
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO agent_approvals
           (id, run_id, turn_id, step_id, tool_name, args_json, args_hash, risk, policy_decision,
            status, decided_by, decided_at, expires_at, mode, timeout_ms, cwd, grant_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.turnId,
        input.stepId ?? null,
        input.toolName,
        redactArgsJson(input.argsJson),
        input.argsHash,
        input.risk,
        input.policyDecision ?? 'ask',
        input.status ?? 'pending',
        input.policyDecision === 'allow' ? 'policy' : input.policyDecision === 'deny' ? 'policy' : null,
        input.policyDecision === 'allow' || input.policyDecision === 'deny' ? now : null,
        input.expiresAt,
        input.mode,
        input.timeoutMs,
        input.cwd ?? null,
        input.grantSource ?? null,
        now,
      )
    return this.getApproval(id)!
  }

  getApproval(approvalId: string): AgentApprovalRow | null {
    return (this.db.prepare('SELECT * FROM agent_approvals WHERE id = ?').get(approvalId) as AgentApprovalRow | undefined) ?? null
  }

  /** 原子决策：仅 pending → allowed/denied；已决策的行原样返回（幂等）。 */
  decideApproval(
    approvalId: string,
    decision: 'allow' | 'deny',
    decidedBy: DecidedBy,
    now = Date.now(),
    note?: string,
  ): AgentApprovalRow | null {
    const existing = this.getApproval(approvalId)
    if (!existing) return null
    if (existing.status !== 'pending') return existing
    const nextStatus: ApprovalStatus = decision === 'allow' ? 'allowed' : 'denied'
    this.db
      .prepare(
        `UPDATE agent_approvals
            SET status = ?, decided_by = ?, decided_at = ?, decision_note = COALESCE(?, decision_note)
          WHERE id = ? AND status = 'pending'`,
      )
      .run(nextStatus, decidedBy, now, note ?? null, approvalId)
    return this.getApproval(approvalId)
  }

  listPendingApprovals(): AgentApprovalRow[] {
    return this.db
      .prepare(`SELECT * FROM agent_approvals WHERE status = 'pending' ORDER BY created_at ASC`)
      .all() as AgentApprovalRow[]
  }

  listExpiredApprovals(now = Date.now()): AgentApprovalRow[] {
    return this.db
      .prepare(`SELECT * FROM agent_approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY created_at ASC`)
      .all(now) as AgentApprovalRow[]
  }

  listApprovalsByTurn(turnId: string): AgentApprovalRow[] {
    return this.db.prepare('SELECT * FROM agent_approvals WHERE turn_id = ? ORDER BY created_at ASC').all(turnId) as AgentApprovalRow[]
  }

  /** 重启重推：保留 pending 行，重置有效期并重新计时。 */
  refreshApprovalExpiry(approvalId: string, expiresAt: number, timeoutMs: number): void {
    this.db
      .prepare("UPDATE agent_approvals SET expires_at = ?, timeout_ms = ? WHERE id = ? AND status = 'pending'")
      .run(expiresAt, timeoutMs, approvalId)
  }

  // ---------------------------------------------------------
  // Artifacts
  // ---------------------------------------------------------
  insertArtifact(input: {
    id?: string
    turnId: string
    nodeId?: string
    kind: 'diff' | 'file_snapshot' | 'command_output' | 'summary' | 'test_report'
    path?: string
    contentHash?: string
    baseHash?: string
    storage: 'inline' | 'file' | 'git'
    storageRef?: string
  }): string {
    const id = input.id ?? newId('art')
    this.db
      .prepare(
        `INSERT INTO agent_artifacts (id, turn_id, node_id, kind, path, content_hash, base_hash, storage, storage_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.turnId,
        input.nodeId ?? null,
        input.kind,
        input.path ?? null,
        input.contentHash ?? null,
        input.baseHash ?? null,
        input.storage,
        input.storageRef ?? null,
        Date.now(),
      )
    return id
  }

  listArtifacts(turnId: string): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM agent_artifacts WHERE turn_id = ? ORDER BY created_at ASC').all(turnId) as Array<Record<string, unknown>>
  }

  // ---------------------------------------------------------
  // Usage（graph × 本地日双层）
  // ---------------------------------------------------------
  recordUsage(input: {
    turnId?: string | null
    sessionId: string
    executor: string
    graphId?: string | null
    nodeId?: string | null
    model?: string | null
    dayKey?: string
    inputTokens?: number | null
    outputTokens?: number | null
    cachedInputTokens?: number | null
    cacheCreationInputTokens?: number | null
    currency?: string
    costUsd?: number
    costMicros?: number | null
    priceVersion?: string | null
    isEstimate?: boolean
    source?: 'provider' | 'estimated' | 'unknown'
    /** 定价分类；省略时按 source + costMicros 推导（新写入不留 NULL） */
    costStatus?: UsageCostStatus | null
    /** 1/0 = 是否上报 token；null = 该调用无 token 概念；省略时按 token 字段推导 */
    tokensReported?: number | null
    attributionNote?: string | null
    dedupeKey?: string | null
    recordedAt?: number
  }): AgentUsageRow {
    const id = newId('usage')
    const now = input.recordedAt ?? Date.now()
    const source = input.source ?? 'estimated'
    const costMicros = input.costMicros ?? null
    const costStatus: UsageCostStatus | null =
      input.costStatus === undefined
        ? source === 'unknown'
          ? 'not_reported'
          : costMicros === null
            ? 'missing_price'
            : 'priced'
        : input.costStatus
    const tokensReported: number | null =
      input.tokensReported === undefined
        ? source === 'unknown' ||
          ![input.inputTokens, input.outputTokens, input.cachedInputTokens, input.cacheCreationInputTokens].some(
            isReportedToken,
          )
          ? 0
          : 1
        : input.tokensReported
    this.db
      .prepare(
        `INSERT INTO agent_usage
           (id, turn_id, session_id, executor, graph_id, node_id, model, day_key,
            input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens,
            currency, cost_usd, cost_micros, price_version, is_estimate, source,
            cost_status, tokens_reported, attribution_note, dedupe_key, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.turnId ?? null,
        input.sessionId,
        input.executor,
        input.graphId ?? null,
        input.nodeId ?? null,
        input.model ?? null,
        input.dayKey ?? localDayKey(now),
        // 显式 null = 后端未上报（unknown）；省略（undefined）按旧语义默认 0
        input.inputTokens === undefined ? 0 : input.inputTokens,
        input.outputTokens === undefined ? 0 : input.outputTokens,
        input.cachedInputTokens === undefined ? 0 : input.cachedInputTokens,
        // 新增列：省略 = 后端未上报该维度（NULL，区别于 0）
        input.cacheCreationInputTokens === undefined ? null : input.cacheCreationInputTokens,
        input.currency ?? 'USD',
        input.costUsd ?? 0,
        costMicros,
        input.priceVersion ?? null,
        input.isEstimate === false ? 0 : 1,
        source,
        costStatus,
        tokensReported,
        input.attributionNote ?? null,
        input.dedupeKey ?? null,
        now,
      )
    return this.db.prepare('SELECT * FROM agent_usage WHERE id = ?').get(id) as AgentUsageRow
  }

  findUsageByDedupeKey(dedupeKey: string): AgentUsageRow | null {
    return (
      (this.db.prepare('SELECT * FROM agent_usage WHERE dedupe_key = ?').get(dedupeKey) as AgentUsageRow | undefined) ??
      null
    )
  }

  /** 幂等升级路径：estimated/unknown 行被迟到的 provider 真实用量覆盖。 */
  updateUsage(
    id: string,
    fields: {
      turnId?: string | null
      nodeId?: string | null
      model?: string | null
      inputTokens?: number | null
      outputTokens?: number | null
      cachedInputTokens?: number | null
      cacheCreationInputTokens?: number | null
      currency?: string
      costUsd?: number
      costMicros?: number | null
      priceVersion?: string | null
      isEstimate?: boolean
      source?: 'provider' | 'estimated' | 'unknown'
      costStatus?: UsageCostStatus | null
      tokensReported?: number | null
      attributionNote?: string | null
    },
  ): AgentUsageRow {
    this.db
      .prepare(
        `UPDATE agent_usage
            SET turn_id = COALESCE(?, turn_id),
                node_id = COALESCE(?, node_id),
                model = COALESCE(?, model),
                input_tokens = ?,
                output_tokens = ?,
                cached_input_tokens = ?,
                cache_creation_input_tokens = COALESCE(?, cache_creation_input_tokens),
                currency = COALESCE(?, currency),
                cost_usd = COALESCE(?, cost_usd),
                cost_micros = ?,
                price_version = ?,
                is_estimate = COALESCE(?, is_estimate),
                source = COALESCE(?, source),
                cost_status = ?,
                tokens_reported = ?,
                attribution_note = ?
          WHERE id = ?`,
      )
      .run(
        fields.turnId ?? null,
        fields.nodeId ?? null,
        fields.model ?? null,
        fields.inputTokens ?? null,
        fields.outputTokens ?? null,
        fields.cachedInputTokens ?? null,
        fields.cacheCreationInputTokens ?? null,
        fields.currency ?? null,
        fields.costUsd ?? null,
        fields.costMicros ?? null,
        fields.priceVersion ?? null,
        fields.isEstimate === undefined ? null : fields.isEstimate ? 1 : 0,
        fields.source ?? null,
        fields.costStatus ?? null,
        fields.tokensReported ?? null,
        fields.attributionNote ?? null,
        id,
      )
    return this.db.prepare('SELECT * FROM agent_usage WHERE id = ?').get(id) as AgentUsageRow
  }

  /** 只读查询：某图某日的汇总（真假用量分列，供用量视图使用）。 */
  summarizeUsageByGraphDay(graphId: string, dayKey = localDayKey()): GraphDayUsageSummary {
    return {
      graphId,
      dayKey,
      ...this.summarizeUsage('graph_id = ? AND day_key = ?', [graphId, dayKey]),
    }
  }

  /** 只读查询：某会话的汇总。 */
  summarizeUsageBySession(sessionId: string): UsageSummary {
    return this.summarizeUsage('session_id = ?', [sessionId])
  }

  /** 只读查询：某 turn 的汇总。 */
  summarizeUsageByTurn(turnId: string): UsageSummary {
    return this.summarizeUsage('turn_id = ?', [turnId])
  }

  /**
   * 图级按日列表（day_key 由 localDayKey 生成的 Asia/Shanghai 本地日，原样返回）。
   * 只返回有记录的日期；没有记录的日期不会以 0 出现在列表里。
   */
  listUsageDaysByGraph(graphId: string, limit = 30): GraphDayUsageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT day_key AS dayKey, ${USAGE_SUMMARY_COLUMNS}
           FROM agent_usage WHERE graph_id = ? GROUP BY day_key ORDER BY day_key DESC LIMIT ?`,
      )
      .all(graphId, limit) as Array<UsageSummary & { dayKey: string }>
    return rows.map((row) => ({ graphId, ...row }))
  }

  /** 会话明细（最近优先）；缺价行 cost_micros 保持 NULL，由 UI 显示「价格未知」。 */
  listUsageBySession(sessionId: string, limit = 200): AgentUsageRow[] {
    return this.db
      .prepare('SELECT * FROM agent_usage WHERE session_id = ? ORDER BY recorded_at DESC LIMIT ?')
      .all(sessionId, limit) as AgentUsageRow[]
  }

  private summarizeUsage(whereSql: string, params: Array<string | number>): UsageSummary {
    return this.db
      .prepare(`SELECT ${USAGE_SUMMARY_COLUMNS} FROM agent_usage WHERE ${whereSql}`)
      .get(...params) as UsageSummary
  }

  sumCostMicrosForGraph(graphId: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS total FROM agent_usage WHERE graph_id = ?').get(graphId) as { total: number }
    return row.total
  }

  listUsageByTurn(turnId: string): AgentUsageRow[] {
    return this.db.prepare('SELECT * FROM agent_usage WHERE turn_id = ? ORDER BY recorded_at ASC').all(turnId) as AgentUsageRow[]
  }

  // ---------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------
  saveSnapshot(runId: string, state: Record<string, unknown>, now = Date.now()): number {
    const next = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_snapshots WHERE run_id = ?').get(runId) as { seq: number }
    this.db
      .prepare('INSERT INTO agent_snapshots (run_id, seq, state_json, created_at) VALUES (?, ?, ?, ?)')
      .run(runId, next.seq, JSON.stringify(state), now)
    return next.seq
  }

  latestSnapshot(runId: string): { run_id: string; seq: number; state: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT * FROM agent_snapshots WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(runId) as
      | { run_id: string; seq: number; state_json: string; created_at: number }
      | undefined
    if (!row) return null
    return { run_id: row.run_id, seq: row.seq, state: parseJson(row.state_json, {}) }
  }

  // ---------------------------------------------------------
  // Recovery（由 planner 调用，保持事务边界清晰）
  // ---------------------------------------------------------
  applyRecoveryPlan(plan: RecoveryPlan, now = Date.now()): void {
    switch (plan.action) {
      case 'abort_turn':
        if (!plan.turnId) return
        this.abortOpenSteps(plan.turnId, now)
        // P0-2：step 级处置必须真正落库，而不是只出现在报告里
        for (const outcome of plan.stepOutcomes ?? []) {
          this.setStepDisposition(outcome.stepId, outcome.disposition)
          if (outcome.disposition === 'completed') {
            this.updateStepStatus(outcome.stepId, 'done', { endedAt: now, resultRef: 'recovery:snapshot-match' }, now)
          }
        }
        this.updateTurnStatus(plan.turnId, 'orphaned', { endedAt: now, failureClass: 'crash' }, now)
        this.projectRunStatus(plan.runId, now)
        break
      case 'mark_session_orphaned':
        if (plan.sessionId) this.updateSessionStatus(plan.sessionId, 'orphaned', now)
        break
      case 'mark_run_interrupted':
        this.updateRunStatus(plan.runId, 'interrupted', now)
        break
      case 'project_run_completed':
        this.projectRunStatus(plan.runId, now)
        break
      case 'keep_pending_approval':
        // 重启重推由 ApprovalGateway 负责，不在这里改写事实
        break
    }
  }

  // ---------------------------------------------------------
  // P0-2：事件保留策略 + 存储统计
  // ---------------------------------------------------------
  /**
   * 清理已终态 turn 的过期事件。
   *
   * 安全边界（宁可留证据，也不删到无法对账）：
   * - 只碰 `agent_events`；`agent_usage` / `agent_approvals` / `agent_turns` / `agent_sessions` 永不清理；
   * - `run.started` 是**续接锚点**（唯一保存 `backendSessionId` 的地方），永不清理；
   *   若清掉它，该会话之后的 native resume 会永久丢失底层会话 id；
   * - 非终态 turn、有待审批的 turn → 永不清理；
   * - 步骤仍有未落定状态（requested/awaiting_approval/approved/running/unknown）的 turn →
   *   视为 stepOutcomes 缺对账依据，跳过并留痕；
   * - 每批 DELETE ≤ `MAX_RETENTION_BATCH_SIZE` 行，批与批之间释放锁。
   */
  runEventRetention(
    policy: EventRetentionPolicy = DEFAULT_EVENT_RETENTION,
    now = Date.now(),
  ): EventRetentionResult {
    const retentionDays =
      Number.isFinite(policy.retentionDays) && policy.retentionDays > 0
        ? Math.floor(policy.retentionDays)
        : DEFAULT_EVENT_RETENTION.retentionDays
    const batchSize = Math.min(
      Math.max(1, Math.floor(policy.batchSize || DEFAULT_EVENT_RETENTION.batchSize)),
      MAX_RETENTION_BATCH_SIZE,
    )
    const cutoff = now - retentionDays * DAY_MS

    const rows = this.db
      .prepare(
        `SELECT e.turn_id AS turnId, COUNT(*) AS eventRows
           FROM agent_events e
           JOIN agent_turns t ON t.id = e.turn_id
          WHERE e.created_at < ?
            AND e.type <> '${RESUME_ANCHOR_EVENT_TYPE}'
          GROUP BY e.turn_id`,
      )
      .all(cutoff) as Array<{ turnId: string; eventRows: number }>

    const eligibleTurnIds: string[] = []
    const skipped: EventRetentionSkip[] = []
    for (const row of rows) {
      const turn = this.getTurn(row.turnId)
      if (!turn) {
        // 没有 turn 行（如系统事件）→ 无法证明可对账，保留
        skipped.push({ turnId: row.turnId, reason: 'irreconcilable', eventRows: row.eventRows })
        continue
      }
      if (!TERMINAL_TURN_STATUSES.includes(turn.status)) {
        skipped.push({ turnId: row.turnId, reason: 'not-terminal', eventRows: row.eventRows })
        continue
      }
      if (this.hasPendingApproval(turn.id)) {
        skipped.push({ turnId: row.turnId, reason: 'pending-approval', eventRows: row.eventRows })
        continue
      }
      if (this.hasUnsettledStep(turn.id)) {
        skipped.push({ turnId: row.turnId, reason: 'irreconcilable', eventRows: row.eventRows })
        continue
      }
      eligibleTurnIds.push(row.turnId)
    }

    let deletedRows = 0
    let batches = 0
    let oldestDeletedAt: number | null = null
    let newestDeletedAt: number | null = null

    if (eligibleTurnIds.length > 0) {
      const placeholders = eligibleTurnIds.map(() => '?').join(',')
      const pickBatch = this.db.prepare(
        `SELECT id, created_at
           FROM agent_events
          WHERE created_at < ? AND type <> '${RESUME_ANCHOR_EVENT_TYPE}'
            AND turn_id IN (${placeholders})
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      const deleteIds = (ids: string[]): void => {
        const idPlaceholders = ids.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM agent_events WHERE id IN (${idPlaceholders})`).run(...ids)
      }

      while (true) {
        const batch = pickBatch.all(cutoff, ...eligibleTurnIds, batchSize) as Array<{ id: string; created_at: number }>
        if (batch.length === 0) break
        // 每批一个短事务：写完立即释放锁，避免长时间阻塞其它写入
        this.db.transaction(() => deleteIds(batch.map((row) => row.id)))()
        batches += 1
        deletedRows += batch.length
        for (const row of batch) {
          if (oldestDeletedAt === null || row.created_at < oldestDeletedAt) oldestDeletedAt = row.created_at
          if (newestDeletedAt === null || row.created_at > newestDeletedAt) newestDeletedAt = row.created_at
        }
        if (batch.length < batchSize) break
      }
    }

    return {
      cutoff,
      retentionDays,
      batchSize,
      deletedRows,
      batches,
      oldestDeletedAt,
      newestDeletedAt,
      skipped,
      eligibleTurnCount: eligibleTurnIds.length,
    }
  }

  /** 事件行数、占用估算与时间跨度（供 `agent:getStorageStats` 使用；不做 VACUUM）。 */
  getEventStorageStats(): EventStorageStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS eventRows,
                MIN(created_at) AS oldestEventAt,
                MAX(created_at) AS newestEventAt
           FROM agent_events`,
      )
      .get() as { eventRows: number; oldestEventAt: number | null; newestEventAt: number | null }

    let estimatedBytes: number | null = null
    let usedDbstat = false
    try {
      const stat = this.db
        .prepare(`SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = 'agent_events'`)
        .get() as { bytes: number } | undefined
      if (stat && stat.bytes > 0) {
        estimatedBytes = stat.bytes
        usedDbstat = true
      }
    } catch {
      // 构建未启用 dbstat → 回退到 payload 估算
    }

    if (estimatedBytes === null) {
      const payload = this.db
        .prepare(
          `SELECT COALESCE(SUM(
             length(payload_json) + length(id) + length(run_id) + length(turn_id) +
             length(type) + length(source) + length(fidelity) +
             COALESCE(length(step_id), 0)
           ), 0) AS bytes
           FROM agent_events`,
        )
        .get() as { bytes: number }
      // 每行另有固定开销（页头/行头/索引），按 100B 粗估
      estimatedBytes = payload.bytes + row.eventRows * 100
    }

    return {
      eventRows: row.eventRows,
      estimatedBytes,
      oldestEventAt: row.oldestEventAt,
      newestEventAt: row.newestEventAt,
      estimation: usedDbstat ? 'dbstat' : 'payload',
    }
  }

  private hasPendingApproval(turnId: string): boolean {
    return Boolean(
      this.db.prepare(`SELECT 1 FROM agent_approvals WHERE turn_id = ? AND status = 'pending' LIMIT 1`).get(turnId),
    )
  }

  private hasUnsettledStep(turnId: string): boolean {
    // done/failed/aborted/denied 之外（含 unknown）都视为尚未落定：事件是唯一证据，保留。
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM agent_steps
            WHERE turn_id = ? AND status NOT IN ('done','failed','aborted','denied')
            LIMIT 1`,
        )
        .get(turnId),
    )
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }
}

interface AgentEventRow {
  id: string
  run_id: string
  turn_id: string
  seq: number
  turn_seq: number
  type: string
  source: string
  fidelity: string
  payload_version: number
  payload_json: string
  created_at: number
  /** 与 agent_approvals.step_id 同一口径（turn 作用域）；历史行为 NULL */
  step_id: string | null
}

const TERMINAL_STEP_STATUSES: StepStatus[] = ['done', 'failed', 'aborted', 'denied', 'unknown']
