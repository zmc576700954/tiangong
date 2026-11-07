/**
 * WorkRunService / NodeSessionLinkService / ChangeSetService / RoutingDecisionRepository
 * （S5a,session-map 蓝图 §4.2-§4.4 + §4.7.5-§4.7.8 施工细则）
 *
 * work_runs：入队与 run_seq 同事务（MAX+1,UNIQUE(work_item_id,run_seq) 兜底）;
 * claim/终态一律条件更新;取消先行成功时完成更新 changes=0,保留 cancelled 与 partial。
 * partial_output_ref 统一 JSON,单字段 16KB/总量 64KB 截断（F2 的 subagent partial 直接映射）。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('WorkRunService')

export type WorkRunStatus =
  | 'queued' | 'running' | 'awaiting_approval' | 'blocked'
  | 'completed' | 'failed' | 'cancelled' | 'superseded'
  | 'interrupted' | 'timed_out'

export type FailureClass =
  | 'infra' | 'busy' | 'turn_fail' | 'verify_fail' | 'test_fail'
  | 'env_fail' | 'timeout' | 'cancel' | 'denied'

export type CancelReason = 'user' | 'upstream_cancelled' | 'deadline' | 'shutdown' | 'approval_denied'

export interface WorkRunRow {
  id: string
  work_item_id: string
  work_item_lineage_id: string
  work_item_revision: number
  step_id: string | null
  run_seq: number
  attempt: number
  idempotency_key: string
  executor_kind: 'agent' | 'test' | 'human'
  adapter_name: string | null
  route_decision_id: string | null
  status: WorkRunStatus
  session_id: string | null
  thread_id: string | null
  agent_run_id: string | null
  invocation_id: string | null
  started_at: number | null
  deadline_at: number | null
  ended_at: number | null
  result_summary: string | null
  outputs_json: string | null
  output_parse: 'ok' | 'fallback' | null
  output_extra_keys: string | null
  partial_output_ref: string | null
  failure_class: FailureClass | null
  cancel_requested_at: number | null
  cancel_reason: CancelReason | null
  created_at: number
}

export class WorkRunConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkRunConflictError'
  }
}

/** partial 字段上限：单字段 16KB、总量 64KB（§4.7.5,可配默认）。 */
export const PARTIAL_FIELD_MAX_BYTES = 16 * 1024
export const PARTIAL_TOTAL_MAX_BYTES = 64 * 1024

export interface PartialOutput {
  stdout_tail?: string
  stderr_tail?: string
  file_changes?: string[]
  errors?: string[]
  artifact_refs?: string[]
  captured_at: number
  truncated: boolean
}

function capString(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false }
  let out = s.slice(0, max)
  while (Buffer.byteLength(out, 'utf8') > max && out.length > 0) {
    out = out.slice(0, Math.max(1, Math.floor(out.length * (max / Buffer.byteLength(out, 'utf8')))))
  }
  return { text: out, truncated: true }
}

/** 收敛 partial 到字段/总量上限（§4.7.5）。 */
export function normalizePartial(input: Omit<PartialOutput, 'captured_at' | 'truncated'> & { captured_at?: number }): PartialOutput {
  let truncated = false
  let budget = PARTIAL_TOTAL_MAX_BYTES
  const capField = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined
    const capped = capString(s, Math.min(PARTIAL_FIELD_MAX_BYTES, budget))
    if (capped.truncated) truncated = true
    budget -= Buffer.byteLength(capped.text, 'utf8')
    return capped.text
  }
  const stdout = capField(input.stdout_tail)
  const stderr = capField(input.stderr_tail)
  const fileChanges = input.file_changes ?? []
  const errors = input.errors ?? []
  const artifactRefs = input.artifact_refs ?? []
  return {
    stdout_tail: stdout,
    stderr_tail: stderr,
    file_changes: fileChanges,
    errors,
    artifact_refs: artifactRefs,
    captured_at: input.captured_at ?? Date.now(),
    truncated,
  }
}

export class WorkRunService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(id: string): WorkRunRow | undefined {
    return this.db.prepare('SELECT * FROM work_runs WHERE id = ?').get(id) as WorkRunRow | undefined
  }

  /**
   * 入队（§4.7.5）：BEGIN IMMEDIATE → run_seq = MAX+1 → INSERT queued。
   * attempt 取该步当前 attempt（§4.7.4:work_runs.attempt 必须等于同次 step attempt）。
   * 幂等键 UNIQUE 冲突 → 返回既有 run（不新建）。
   */
  enqueue(input: {
    workItemId: string
    stepId?: string
    executorKind: 'agent' | 'test' | 'human'
    adapterName?: string
    routeDecisionId?: string
    sessionId?: string
    threadId?: string
    deadlineAt?: number
  }): { run: WorkRunRow; reused: boolean } {
    const item = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(input.workItemId) as
      | { lineage_id: string; revision: number }
      | undefined
    if (!item) throw new Error(`work_item ${input.workItemId} 不存在`)

    let attempt = 1
    let stepSeq = 0
    if (input.stepId) {
      const step = this.db.prepare('SELECT seq, attempt FROM work_steps WHERE id = ?').get(input.stepId) as
        | { seq: number; attempt: number }
        | undefined
      if (!step) throw new Error(`work_step ${input.stepId} 不存在`)
      stepSeq = step.seq
      attempt = step.attempt
    }

    const txn = this.db.transaction((): { run: WorkRunRow; reused: boolean } => {
      const seqRow = this.db
        .prepare('SELECT COALESCE(MAX(run_seq), 0) + 1 AS next FROM work_runs WHERE work_item_id = ?')
        .get(input.workItemId) as { next: number }
      const id = `wr_${Date.now()}_${randomUUID().slice(0, 8)}`
      const idempotencyKey = `${item.lineage_id}:${item.revision}:${stepSeq}:${attempt}`
      try {
        this.db
          .prepare(
            `INSERT INTO work_runs (
               id, work_item_id, work_item_lineage_id, work_item_revision, step_id,
               run_seq, attempt, idempotency_key, executor_kind, adapter_name,
               route_decision_id, status, session_id, thread_id, deadline_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
          )
          .run(
            id, input.workItemId, item.lineage_id, item.revision, input.stepId ?? null,
            seqRow.next, attempt, idempotencyKey, input.executorKind, input.adapterName ?? null,
            input.routeDecisionId ?? null, input.sessionId ?? null, input.threadId ?? null,
            input.deadlineAt ?? null, Date.now(),
          )
        return { run: this.get(id)!, reused: false }
      } catch (err) {
        if (/UNIQUE constraint failed: work_runs\.idempotency_key/.test(err instanceof Error ? err.message : String(err))) {
          const existing = this.db
            .prepare('SELECT * FROM work_runs WHERE idempotency_key = ?')
            .get(idempotencyKey) as WorkRunRow
          return { run: existing, reused: true }
        }
        throw err
      }
    })
    return txn()
  }

  /** queued → running（claim;changes=0 → 已被取消/其他 worker claim,返回 false）。 */
  claim(id: string): WorkRunRow | undefined {
    const result = this.db
      .prepare("UPDATE work_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .run(Date.now(), id)
    return result.changes === 1 ? this.get(id) : undefined
  }

  /** running → completed（条件更新;取消先行时 changes=0 返回 undefined,保留 cancelled）。 */
  complete(id: string, data?: { resultSummary?: string; outputs?: Record<string, unknown>; outputParse?: 'ok' | 'fallback'; outputExtraKeys?: string[] }): WorkRunRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE work_runs SET status = 'completed', ended_at = ?, result_summary = ?,
           outputs_json = COALESCE(?, outputs_json), output_parse = COALESCE(?, output_parse),
           output_extra_keys = COALESCE(?, output_extra_keys)
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        Date.now(), data?.resultSummary ?? null,
        data?.outputs ? JSON.stringify(data.outputs) : null,
        data?.outputParse ?? null,
        data?.outputExtraKeys ? JSON.stringify(data.outputExtraKeys) : null,
        id,
      )
    return result.changes === 1 ? this.get(id) : undefined
  }

  /** running → failed（failure_class 必填;partial 先落库——§4.2 失败不等于丢弃）。 */
  fail(id: string, data: { failureClass: FailureClass; partial?: Parameters<typeof normalizePartial>[0]; resultSummary?: string }): WorkRunRow | undefined {
    const partial = data.partial ? JSON.stringify(normalizePartial(data.partial)) : null
    const result = this.db
      .prepare(
        `UPDATE work_runs SET status = 'failed', ended_at = ?, failure_class = ?,
           partial_output_ref = COALESCE(?, partial_output_ref), result_summary = COALESCE(?, result_summary)
         WHERE id = ? AND status = 'running'`,
      )
      .run(Date.now(), data.failureClass, partial, data.resultSummary ?? null, id)
    return result.changes === 1 ? this.get(id) : undefined
  }

  /** running → timed_out（超时控制器;partial 先落库）。 */
  timeout(id: string, partial?: Parameters<typeof normalizePartial>[0]): WorkRunRow | undefined {
    const partialJson = partial ? JSON.stringify(normalizePartial(partial)) : null
    const result = this.db
      .prepare(
        `UPDATE work_runs SET status = 'timed_out', ended_at = ?, failure_class = 'timeout',
           partial_output_ref = COALESCE(?, partial_output_ref)
         WHERE id = ? AND status = 'running'`,
      )
      .run(Date.now(), partialJson, id)
    return result.changes === 1 ? this.get(id) : undefined
  }

  /**
   * 取消（running/queued → cancelled）：cancel_requested_at 先持久化,再写终态;
   * 与完成竞态用条件更新,失败方保留（终态唯一）。
   */
  cancel(id: string, reason: CancelReason): WorkRunRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE work_runs SET status = 'cancelled', ended_at = ?, failure_class = 'cancel',
           cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_reason = ?
         WHERE id = ? AND status IN ('queued','running')`,
      )
      .run(Date.now(), Date.now(), reason, id)
    return result.changes === 1 ? this.get(id) : undefined
  }

  /** 启动对账：running → interrupted（保留 partial;不自动重跑）。 */
  markInterrupted(id: string): WorkRunRow | undefined {
    const result = this.db
      .prepare("UPDATE work_runs SET status = 'interrupted' WHERE id = ? AND status = 'running'")
      .run(id)
    return result.changes === 1 ? this.get(id) : undefined
  }

  /** 重启对账扫描：所有 running 的 run（§4.7.5 重启对账）。 */
  listRunning(): WorkRunRow[] {
    return this.db.prepare("SELECT * FROM work_runs WHERE status = 'running'").all() as WorkRunRow[]
  }
}

// ---------------------------------------------------------
// node_session_links（§4.7.6）
// ---------------------------------------------------------

export interface NodeSessionLinkRow {
  id: string
  project_path: string
  graph_id: string
  node_entity_key: string | null
  node_id: string | null
  work_item_id: string | null
  work_run_id: string | null
  thread_id: string
  session_id: string | null
  agent_run_id: string | null
  turn_id: string | null
  link_role: 'primary' | 'supporting' | 'review' | 'test' | 'investigation'
  session_origin: 'map_task' | 'manual_panel' | 'subagent' | 'test'
  started_at: number | null
  ended_at: number | null
  created_at: number
}

export class NodeSessionLinkService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** 挂载（幂等）：同一 (thread, node, role) 已存在 → 返回既有行;项目级 NULL 用部分唯一索引。 */
  attach(input: {
    projectPath: string
    graphId: string
    nodeEntityKey?: string
    nodeId?: string
    workItemId?: string
    workRunId?: string
    threadId: string
    sessionId?: string
    linkRole?: NodeSessionLinkRow['link_role']
    sessionOrigin: NodeSessionLinkRow['session_origin']
  }): { row: NodeSessionLinkRow; reused: boolean } {
    const role = input.linkRole ?? 'primary'
    const existing = input.nodeEntityKey
      ? this.db
          .prepare('SELECT * FROM node_session_links WHERE thread_id = ? AND node_entity_key = ? AND link_role = ?')
          .get(input.threadId, input.nodeEntityKey, role)
      : this.db
          .prepare('SELECT * FROM node_session_links WHERE thread_id = ? AND node_entity_key IS NULL AND link_role = ?')
          .get(input.threadId, role)
    if (existing) return { row: existing as NodeSessionLinkRow, reused: true }

    const id = `nsl_${Date.now()}_${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO node_session_links (
           id, project_path, graph_id, node_entity_key, node_id, work_item_id, work_run_id,
           thread_id, session_id, link_role, session_origin, started_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.projectPath, input.graphId, input.nodeEntityKey ?? null, input.nodeId ?? null,
        input.workItemId ?? null, input.workRunId ?? null, input.threadId, input.sessionId ?? null,
        role, input.sessionOrigin, Date.now(), Date.now(),
      )
    return { row: this.db.prepare('SELECT * FROM node_session_links WHERE id = ?').get(id) as NodeSessionLinkRow, reused: false }
  }

  /** 会话结束：只写 ended_at,不删行（§4.7.6）。 */
  end(threadId: string): void {
    this.db
      .prepare('UPDATE node_session_links SET ended_at = ? WHERE thread_id = ? AND ended_at IS NULL')
      .run(Date.now(), threadId)
  }

  /** 节点时间线（§9.5-3：一个节点多个会话 → threadIds[],由 UI 保留全部）。 */
  timelineForNode(graphId: string, nodeEntityKey: string): NodeSessionLinkRow[] {
    return this.db
      .prepare(
        'SELECT * FROM node_session_links WHERE graph_id = ? AND node_entity_key = ? ORDER BY created_at ASC',
      )
      .all(graphId, nodeEntityKey) as NodeSessionLinkRow[]
  }
}

// ---------------------------------------------------------
// change_sets（§4.7.7）
// ---------------------------------------------------------

export interface ChangeFileEntry {
  path: string
  change: 'added' | 'modified' | 'deleted' | 'renamed'
  old_path?: string
  additions: number
  deletions: number
}

export interface ChangeSetRow {
  id: string
  project_path: string
  graph_id: string | null
  work_run_id: string | null
  session_id: string | null
  base_commit: string | null
  head_commit: string | null
  dirty: number
  dirty_tree_hash: string | null
  files_json: string
  file_count: number
  line_additions: number
  line_deletions: number
  captured_at: number
}

/** git 命令执行器（依赖注入,测试用 fake）。 */
export interface GitRunner {
  revParseHEAD(cwd: string): string | null
  statusPorcelain(cwd: string): string[] | null
}

export class ChangeSetService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly git: GitRunner,
  ) {}

  /** run claim 时采集 base：HEAD + dirty 标记。采集失败返回 undefined,不写空行（§4.7.7）。 */
  captureBase(input: { projectPath: string; graphId?: string; workRunId?: string; sessionId?: string }): ChangeSetRow | undefined {
    let baseCommit: string | null = null
    let dirty = 0
    try {
      baseCommit = this.git.revParseHEAD(input.projectPath)
      const porcelain = this.git.statusPorcelain(input.projectPath)
      dirty = porcelain && porcelain.length > 0 ? 1 : 0
    } catch (err) {
      logger.warn(`change_set base capture failed: ${err instanceof Error ? err.message : String(err)}`)
      return undefined // 采集失败不写空行假装"无变更"
    }
    const id = `cs_${Date.now()}_${randomUUID().slice(0, 8)}`
    try {
      this.db
        .prepare(
          `INSERT INTO change_sets (
             id, project_path, graph_id, work_run_id, session_id, base_commit, dirty, files_json, captured_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
        )
        .run(id, input.projectPath, input.graphId ?? null, input.workRunId ?? null, input.sessionId ?? null, baseCommit, dirty, Date.now())
    } catch (err) {
      // UNIQUE(work_run_id)：重试不重复插入,保留首条（§4.7.7）
      if (/UNIQUE constraint failed: change_sets\.work_run_id/.test(err instanceof Error ? err.message : String(err))) {
        return this.getByWorkRun(input.workRunId!)
      }
      throw err
    }
    return this.get(id)
  }

  /** run 终态时采集 head：head commit + 文件面 + dirty_tree_hash。 */
  captureHead(
    workRunId: string,
    data: { headCommit: string | null; files: ChangeFileEntry[]; dirtyTreeHash?: string | null; dirty?: boolean },
  ): ChangeSetRow | undefined {
    const row = this.getByWorkRun(workRunId)
    if (!row) {
      logger.warn(`change_set head capture: no base row for run ${workRunId} — skip（不写无 base 的孤儿行）`)
      return undefined
    }
    const additions = data.files.reduce((s, f) => s + f.additions, 0)
    const deletions = data.files.reduce((s, f) => s + f.deletions, 0)
    this.db
      .prepare(
        `UPDATE change_sets SET head_commit = ?, files_json = ?, file_count = ?,
           line_additions = ?, line_deletions = ?, dirty_tree_hash = COALESCE(?, dirty_tree_hash),
           dirty = CASE WHEN ? THEN 1 ELSE dirty END
         WHERE id = ?`,
      )
      .run(
        data.headCommit, JSON.stringify(data.files), data.files.length,
        additions, deletions, data.dirtyTreeHash ?? null, data.dirty ? 1 : 0, row.id,
      )
    return this.get(row.id)
  }

  get(id: string): ChangeSetRow | undefined {
    return this.db.prepare('SELECT * FROM change_sets WHERE id = ?').get(id) as ChangeSetRow | undefined
  }

  getByWorkRun(workRunId: string): ChangeSetRow | undefined {
    return this.db.prepare('SELECT * FROM change_sets WHERE work_run_id = ?').get(workRunId) as ChangeSetRow | undefined
  }
}

// ---------------------------------------------------------
// routing_decisions（§4.7.8）
// ---------------------------------------------------------

export interface RoutingDecisionRow {
  id: string
  work_item_id: string | null
  work_run_id: string | null
  chosen_adapter: string
  candidate_json: string
  reason: string | null
  policy: 'single_agent' | 'manual_override' | 'fallback'
  confidence: number | null
  created_at: number
}

export class RoutingDecisionRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * run 创建时写一条。路由失败（无候选/能力不足）**不写半条行**——chosen_adapter
   * 必填非空,空即抛错（§4.7.8：失败原因由调用方写 work_item.gate_missing_json 或事件）。
   */
  record(input: {
    workItemId?: string
    workRunId?: string
    chosenAdapter: string
    candidates: Array<{ adapter: string; score: number; capabilities?: string[]; gaps?: string[] }>
    policy: RoutingDecisionRow['policy']
    confidence?: number
    reason?: string
  }): RoutingDecisionRow {
    if (!input.chosenAdapter || input.chosenAdapter.trim() === '') {
      throw new Error('routing_decisions.chosen_adapter 不允许空串（路由失败不写半条行,§4.7.8）')
    }
    const id = `rd_${Date.now()}_${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO routing_decisions (
           id, work_item_id, work_run_id, chosen_adapter, candidate_json, reason, policy, confidence, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.workItemId ?? null, input.workRunId ?? null, input.chosenAdapter,
        JSON.stringify(input.candidates), input.reason ?? null, input.policy,
        input.confidence ?? null, Date.now(),
      )
    return this.db.prepare('SELECT * FROM routing_decisions WHERE id = ?').get(id) as RoutingDecisionRow
  }
}
