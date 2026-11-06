import type { Db } from './db'
import {
  EventLogCorruptError,
  NodeBusyError,
  type AgentEventEnvelope,
  type ApprovalDecisionValue,
  type ApprovalResolvedBy,
  type ApprovalRow,
  type RunStatus,
} from '../types'

export interface RunRow {
  id: string
  thread_id: string
  node_id: string
  graph_id: string | null
  backend: string
  backend_session_id: string | null
  loop_ownership: 'backend' | 'host'
  status: RunStatus
  budget_json: string | null
  idempotency_key: string
  created_at: number
  updated_at: number
}

export interface StepRow {
  id: string
  run_id: string
  turn_id: string
  seq: number
  kind: string
  tool_name: string | null
  tool_call_id: string | null
  status: string
  args_hash: string | null
  fidelity: string
  started_at: number | null
  ended_at: number | null
}

export interface CreateRunInput {
  id: string
  threadId: string
  nodeId: string
  graphId?: string
  backend: string
  backendSessionId?: string
  loopOwnership: 'backend' | 'host'
  idempotencyKey: string
  budgetJson?: string
  status?: RunStatus
}

export class RunRepository {
  constructor(readonly db: Db) {}

  createRun(input: CreateRunInput): { run: RunRow; created: boolean } {
    const now = Date.now()
    try {
      this.db
        .prepare(
          `INSERT INTO agent_runs
             (id, thread_id, node_id, graph_id, backend, backend_session_id,
              loop_ownership, status, budget_json, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.threadId,
          input.nodeId,
          input.graphId ?? null,
          input.backend,
          input.backendSessionId ?? null,
          input.loopOwnership,
          input.status ?? 'created',
          input.budgetJson ?? null,
          input.idempotencyKey,
          now,
          now,
        )
      return { run: this.getRun(input.id)!, created: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('idempotency_key')) {
        const existing = this.getRunByIdempotencyKey(input.idempotencyKey)
        if (existing) return { run: existing, created: false }
      }
      if (message.includes('node_id') || message.includes('ux_agent_runs_active_node')) {
        throw new NodeBusyError(input.nodeId)
      }
      throw err
    }
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as RunRow | undefined
  }

  getRunByIdempotencyKey(key: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM agent_runs WHERE idempotency_key = ?').get(key) as
      | RunRow
      | undefined
  }

  updateRunStatus(id: string, status: RunStatus, backendSessionId?: string | null): void {
    this.db
      .prepare('UPDATE agent_runs SET status = ?, updated_at = ?, backend_session_id = COALESCE(?, backend_session_id) WHERE id = ?')
      .run(status, Date.now(), backendSessionId ?? null, id)
  }

  listRunsByStatuses(statuses: readonly RunStatus[]): RunRow[] {
    const placeholders = statuses.map(() => '?').join(',')
    return this.db
      .prepare(`SELECT * FROM agent_runs WHERE status IN (${placeholders}) ORDER BY created_at, id`)
      .all(...statuses) as RunRow[]
  }

  createStep(input: {
    id: string
    runId: string
    turnId: string
    seq: number
    kind: string
    toolName?: string
    toolCallId?: string
    status: string
    argsHash?: string
    fidelity: string
    startedAt?: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_steps
           (id, run_id, turn_id, seq, kind, tool_name, tool_call_id, status, args_hash,
            fidelity, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.runId,
        input.turnId,
        input.seq,
        input.kind,
        input.toolName ?? null,
        input.toolCallId ?? null,
        input.status,
        input.argsHash ?? null,
        input.fidelity,
        input.startedAt ?? null,
      )
  }

  updateStepStatus(id: string, status: string): void {
    this.db.prepare('UPDATE agent_steps SET status = ? WHERE id = ?').run(status, id)
  }

  listSteps(runId: string): StepRow[] {
    return this.db
      .prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY seq')
      .all(runId) as StepRow[]
  }

  listEvents(runId: string): AgentEventEnvelope[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_events WHERE run_id = ? ORDER BY seq')
      .all(runId) as Array<{
      event_id: string
      run_id: string
      seq: number
      turn_id: string | null
      step_id: string | null
      type: string
      payload_json: string
      source: string
      fidelity: string
      created_at: number
    }>
    return rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      seq: row.seq,
      turnId: row.turn_id ?? '',
      stepId: row.step_id ?? undefined,
      type: row.type as AgentEventEnvelope['type'],
      ts: row.created_at,
      payload: JSON.parse(row.payload_json),
      source: row.source as AgentEventEnvelope['source'],
      fidelity: row.fidelity as AgentEventEnvelope['fidelity'],
      backend: { name: '' },
    }))
  }

  appendEvent(event: AgentEventEnvelope): void {
    const tx = this.db.transaction(() => appendEventRaw(this.db, event))
    tx()
  }

  nextSeq(runId: string): number {
    return nextSeq(this.db, runId)
  }

  // ---- approvals ----

  insertApproval(row: ApprovalRow): void {
    this.db
      .prepare(
        `INSERT INTO agent_approvals
           (approval_id, run_id, turn_id, tool_call_id, tool_name, input_json, risk,
            decision, resolved_by, expires_at, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.approvalId,
        row.runId,
        row.turnId,
        row.toolCallId,
        row.toolName,
        JSON.stringify(row.input),
        row.risk,
        row.decision,
        row.resolvedBy,
        row.expiresAt,
        row.createdAt,
        row.resolvedAt,
      )
  }

  getApproval(approvalId: string): ApprovalRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_approvals WHERE approval_id = ?')
      .get(approvalId) as
      | {
          approval_id: string
          run_id: string
          turn_id: string
          tool_call_id: string
          tool_name: string
          input_json: string
          risk: ApprovalRow['risk']
          decision: ApprovalDecisionValue | null
          resolved_by: ApprovalResolvedBy | null
          expires_at: number
          created_at: number
          resolved_at: number | null
        }
      | undefined
    if (!row) return undefined
    return {
      approvalId: row.approval_id,
      runId: row.run_id,
      turnId: row.turn_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      input: JSON.parse(row.input_json),
      risk: row.risk,
      decision: row.decision,
      resolvedBy: row.resolved_by,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }
  }

  listPendingApprovals(runId?: string): ApprovalRow[] {
    const rows = (
      runId
        ? this.db
            .prepare(
              'SELECT approval_id FROM agent_approvals WHERE decision IS NULL AND run_id = ? ORDER BY created_at',
            )
            .all(runId)
        : this.db
            .prepare('SELECT approval_id FROM agent_approvals WHERE decision IS NULL ORDER BY created_at')
            .all()
    ) as Array<{ approval_id: string }>
    return rows.map((r) => this.getApproval(r.approval_id)!).filter(Boolean)
  }
}

export function nextSeq(db: Db, runId: string): number {
  const row = db.prepare('SELECT MAX(seq) AS maxSeq FROM agent_events WHERE run_id = ?').get(runId) as {
    maxSeq: number | null
  }
  return (row.maxSeq ?? 0) + 1
}

/** 必须在事务内调用：校验 seq 连续后写入 append-only 日志 */
export function appendEventRaw(db: Db, event: AgentEventEnvelope): void {
  const expected = nextSeq(db, event.runId)
  if (event.seq !== expected) {
    throw new EventLogCorruptError(
      `run=${event.runId} expected seq=${expected} but got seq=${event.seq}`,
    )
  }
  db.prepare(
    `INSERT INTO agent_events
       (event_id, run_id, seq, turn_id, step_id, type, payload_json, source, fidelity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.eventId,
    event.runId,
    event.seq,
    event.turnId,
    event.stepId ?? null,
    event.type,
    JSON.stringify(event.payload),
    event.source,
    event.fidelity,
    event.ts,
  )
}
