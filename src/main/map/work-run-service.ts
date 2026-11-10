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
import { WORK_ITEM_TERMINAL, WorkItemService, type WorkItemStatus } from './work-item-service'
import { WorkStepService, isTerminalStepStatus } from './work-step-service'
import { scheduleRecomputeForWorkItem } from './execution-state'
import { assertKnownMode } from './mode-registry'

const logger = createLogger('WorkRunService')

/**
 * 陈旧 queued run 的启动兜底阈值（24h）。依据：L1/L2 单进程串行执行，队列在进程内
 * 即排即取；单用户场景不存在 24h 仍合法的排队等待。结构性僵尸（item 已被
 * supersede/终态/不存在）不依赖该阈值，启动时立即取消。
 */
export const QUEUED_STALE_MS = 24 * 60 * 60 * 1000

export interface RunReconcileReport {
  interruptedRunning: number
  /** 因 run interrupted 而一并收敛为终态的 step 数（保证 run/step/item 三者一致）。 */
  interruptedSteps: number
  cancelledStaleQueued: number
  /** 因 stale queued run 被取消而一并收敛的 step 数。 */
  cancelledSteps: number
  interruptedItems: number
  queuedStaleMs: number
}

export type WorkRunStatus =
  | 'queued' | 'running' | 'awaiting_approval' | 'blocked'
  | 'completed' | 'failed' | 'cancelled' | 'superseded'
  | 'interrupted' | 'timed_out'

/** 状态全集（IPC 只读查询的参数校验用）。 */
export const WORK_RUN_STATUSES: readonly WorkRunStatus[] = [
  'queued', 'running', 'awaiting_approval', 'blocked',
  'completed', 'failed', 'cancelled', 'superseded',
  'interrupted', 'timed_out',
]

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
   * 只读列表（IPC 查询用）：按 item / step / graph / status 过滤，run_seq 升序。
   * 不改任何状态、不触发派生重算。选择器至少给一个由调用方保证；limit 由 IPC 层夹取。
   */
  list(filter: {
    workItemId?: string
    stepId?: string
    graphId?: string
    status?: WorkRunStatus
    limit?: number
  }): WorkRunRow[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.workItemId) {
      where.push('r.work_item_id = ?')
      params.push(filter.workItemId)
    }
    if (filter.stepId) {
      where.push('r.step_id = ?')
      params.push(filter.stepId)
    }
    if (filter.graphId) {
      where.push('i.graph_id = ?')
      params.push(filter.graphId)
    }
    if (filter.status) {
      where.push('r.status = ?')
      params.push(filter.status)
    }
    const sql = `SELECT r.* FROM work_runs r
                   JOIN work_items i ON i.id = r.work_item_id
                  ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY r.run_seq ASC LIMIT ?`
    params.push(filter.limit ?? 100)
    return this.db.prepare(sql).all(...params) as WorkRunRow[]
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
      | { lineage_id: string; revision: number; is_current: number; status: WorkItemStatus }
      | undefined
    if (!item) throw new Error(`work_item ${input.workItemId} 不存在`)
    // 入队守卫：被修订/替代的 revision、以及终态 item 都不得再起 run。
    // 这些状态在 L1 只有测试可达，L2 接线后会变成活路径，必须在入口拦住。
    if (item.is_current !== 1) {
      throw new WorkRunConflictError(`work_item ${input.workItemId} 不是当前 revision（已被修订/替代），不得入队`)
    }
    if (WORK_ITEM_TERMINAL.includes(item.status)) {
      throw new WorkRunConflictError(`work_item ${input.workItemId} 已终态（${item.status}），不得入队`)
    }

    let attempt = 1
    let stepSeq = 0
    if (input.stepId) {
      const step = this.db.prepare('SELECT work_item_id, work_item_revision, seq, attempt FROM work_steps WHERE id = ?').get(input.stepId) as
        | { work_item_id: string; work_item_revision: number; seq: number; attempt: number }
        | undefined
      if (!step) throw new Error(`work_step ${input.stepId} 不存在`)
      // 旧 revision 的 step 不能被新 revision 复用（幂等键会错位）。
      if (step.work_item_id !== input.workItemId || step.work_item_revision !== item.revision) {
        throw new WorkRunConflictError(`work_step ${input.stepId} 不属于 work_item ${input.workItemId} 的当前 revision`)
      }
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
    const result = txn()
    // queued/running run 存在 → 派生 in_progress;每次入队都排一次（同节点合并）。
    scheduleRecomputeForWorkItem(this.db, input.workItemId)
    return result
  }

  /** run 状态变化后按锚定节点排重算（debounce + inputs_hash 未变跳过）。 */
  private scheduleForRun(run: WorkRunRow | undefined): void {
    if (run) scheduleRecomputeForWorkItem(this.db, run.work_item_id)
  }

  /**
   * 执行期回填：route_decision_id / session_id / thread_id。
   * 只对未终态 run 生效；COALESCE 保留先写值（崩溃重放的第二次调用幂等）。
   * 返回 undefined 表示 run 已终态（调用方不得继续执行）。
   */
  attachExecution(
    id: string,
    input: { routeDecisionId?: string; sessionId?: string; threadId?: string },
  ): WorkRunRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE work_runs SET
           route_decision_id = COALESCE(route_decision_id, ?),
           session_id = COALESCE(session_id, ?),
           thread_id = COALESCE(thread_id, ?)
         WHERE id = ? AND status IN ('queued','running')`,
      )
      .run(
        input.routeDecisionId ?? null,
        input.sessionId ?? null,
        input.threadId ?? null,
        id,
      )
    return result.changes === 1 ? this.get(id) : undefined
  }

  /** queued → running（claim;changes=0 → 已被取消/其他 worker claim,返回 false）。 */
  claim(id: string): WorkRunRow | undefined {
    const result = this.db
      .prepare("UPDATE work_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .run(Date.now(), id)
    const row = result.changes === 1 ? this.get(id) : undefined
    this.scheduleForRun(row)
    return row
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
    const row = result.changes === 1 ? this.get(id) : undefined
    this.scheduleForRun(row)
    return row
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
    const row = result.changes === 1 ? this.get(id) : undefined
    this.scheduleForRun(row)
    return row
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
    const row = result.changes === 1 ? this.get(id) : undefined
    this.scheduleForRun(row)
    return row
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
    const row = result.changes === 1 ? this.get(id) : undefined
    this.scheduleForRun(row)
    return row
  }

  /** 启动对账：running → interrupted（保留 partial;不自动重跑）。 */
  markInterrupted(id: string): WorkRunRow | undefined {
    const result = this.db
      .prepare("UPDATE work_runs SET status = 'interrupted' WHERE id = ? AND status = 'running'")
      .run(id)
    const row = result.changes === 1 ? this.get(id) : undefined
    this.scheduleForRun(row)
    return row
  }

  /** 重启对账扫描：所有 running 的 run（§4.7.5 重启对账）。 */
  listRunning(): WorkRunRow[] {
    return this.db.prepare("SELECT * FROM work_runs WHERE status = 'running'").all() as WorkRunRow[]
  }

  /**
   * tick 第 6 步的孤儿扫描：run 已 claim（running）但 step 从未启动（仍 pending）。
   * 本进程串行执行，这种状态只可能来自「claim 与 startStep 之间崩溃」。
   */
  listOrphanedClaims(): WorkRunRow[] {
    return this.db
      .prepare(
        `SELECT r.* FROM work_runs r
           JOIN work_steps s ON s.id = r.step_id
          WHERE r.status = 'running' AND s.status = 'pending'`,
      )
      .all() as WorkRunRow[]
  }

  /**
   * 孤儿回收：running → queued（条件更新，**不计 attempt**，§5.9.9 第 6 步）。
   * 只回收 step 仍为 pending 的 run；已启动的 running step 不会被改写。
   */
  requeueOrphan(id: string): WorkRunRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE work_runs SET status = 'queued', started_at = NULL
          WHERE id = ? AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM work_steps s
               WHERE s.id = work_runs.step_id AND s.status = 'pending'
            )`,
      )
      .run(id)
    const row = result.changes === 1 ? this.get(id) : undefined
    this.scheduleForRun(row)
    return row
  }

  /**
   * 启动对账（§4.7.5）：清偿进程崩溃/重启留下的僵尸 run，避免派生把节点永久钉在
   * `in_progress`（`in_progress` 只看 work_runs 的 queued/running）。
   *
   * 判定：
   * 1. `running` → `interrupted`：本进程不可能创建这些 run，重启后必为僵尸；保留 partial，
   *    不自动重跑（与 agent runtime 的 reconcile 语义一致）。
   * 2. `queued` 结构性僵尸 → 立即 `cancelled(shutdown)`：item 不存在 / 已非当前 revision
   *    （被 supersede）/ item 已终态——这些 run 永远不会再被合法 claim。
   * 3. `queued` 时间性兜底 → `cancelled(shutdown)`：`created_at < now - QUEUED_STALE_MS`。
   *    阈值取 24h：L1/L2 单进程串行执行，队列在进程内即排即取；单用户场景不存在
   *    24h 仍合法的排队等待，超过即视为遗弃。结构性判定优先，阈值只做兜底，
   *    避免对合法积压（重启后仍会被调度器 claim）造成误杀。
   * 4. step 收敛：run 落 interrupted/cancelled 时，其 `step_id` 若仍是非终态 → `cancelled`。
   *    只收敛上层会让 step 永久停在 running，与 run/item 不一致。
   * 5. item 收敛：受影响 item 若仍为 `running` 且已无 queued/running run → `interrupted`。
   *
   * 全程条件更新、幂等，可重复执行；结果写 `map_migration_reports(kind='cleanup',
   * stage='work_runs_reconcile')` 以便查询。
   */
  reconcileOnStartup(options?: { now?: number; queuedStaleMs?: number }): RunReconcileReport {
    const now = options?.now ?? Date.now()
    const queuedStaleMs = options?.queuedStaleMs ?? QUEUED_STALE_MS
    const cutoff = now - queuedStaleMs
    const affectedItemIds = new Set<string>()
    // 上下层必须一起收敛：run 置 interrupted / cancelled 后，它的 step 若仍停在
    // running 等非终态，就会留下「run/item 已收敛、step 永远 running」的孤儿。
    const stepSvc = new WorkStepService(this.db)

    let interruptedRunning = 0
    let interruptedSteps = 0
    for (const run of this.listRunning()) {
      if (this.markInterrupted(run.id)) {
        interruptedRunning++
        if (this.convergeStepOnReconcile(stepSvc, run.step_id)) interruptedSteps++
        affectedItemIds.add(run.work_item_id)
      }
    }

    const staleQueued = this.db
      .prepare(
        `SELECT r.id, r.work_item_id, r.step_id FROM work_runs r
           LEFT JOIN work_items i ON i.id = r.work_item_id
          WHERE r.status = 'queued'
            AND (i.id IS NULL OR i.is_current = 0
                 OR i.status IN ('done','failed','cancelled','superseded')
                 OR r.created_at < ?)`,
      )
      .all(cutoff) as Array<{ id: string; work_item_id: string; step_id: string | null }>

    let cancelledStaleQueued = 0
    let cancelledSteps = 0
    for (const run of staleQueued) {
      if (this.cancel(run.id, 'shutdown')) {
        cancelledStaleQueued++
        if (this.convergeStepOnReconcile(stepSvc, run.step_id)) cancelledSteps++
        affectedItemIds.add(run.work_item_id)
      }
    }

    // 存量修复：旧版本只收敛了 run/item，已 interrupted 的 run 可能仍挂着非终态 step。
    // 该 step 既无 queued/running run 可再驱动，就永远不会自行收敛，这里一并补齐。
    const orphanInterruptedSteps = this.db
      .prepare(
        `SELECT s.id FROM work_steps s
          WHERE s.status NOT IN ('succeeded','failed','timed_out','cancelled','skipped')
            AND EXISTS (SELECT 1 FROM work_runs r WHERE r.step_id = s.id AND r.status = 'interrupted')
            AND NOT EXISTS (SELECT 1 FROM work_runs r WHERE r.step_id = s.id AND r.status IN ('queued','running'))`,
      )
      .all() as Array<{ id: string }>
    for (const row of orphanInterruptedSteps) {
      if (this.convergeStepOnReconcile(stepSvc, row.id)) interruptedSteps++
    }

    const itemSvc = new WorkItemService(this.db)
    let interruptedItems = 0
    for (const itemId of affectedItemIds) {
      const remaining = this.db
        .prepare("SELECT COUNT(*) AS c FROM work_runs WHERE work_item_id = ? AND status IN ('queued','running')")
        .get(itemId) as { c: number }
      if (remaining.c > 0) continue
      const item = this.db.prepare('SELECT status FROM work_items WHERE id = ?').get(itemId) as { status: string } | undefined
      if (item?.status === 'running') {
        itemSvc.markInterrupted(itemId)
        interruptedItems++
      }
    }

    const report: RunReconcileReport = {
      interruptedRunning,
      interruptedSteps,
      cancelledStaleQueued,
      cancelledSteps,
      interruptedItems,
      queuedStaleMs,
    }
    this.recordReconcileReport(report, now)
    logger.info('work_runs startup reconciliation:', report)
    return report
  }

  /** 启动对账时把 run 对应的非终态 step 收敛为 cancelled；终态不动。 */
  private convergeStepOnReconcile(stepSvc: WorkStepService, stepId: string | null): boolean {
    if (!stepId) return false
    const step = stepSvc.get(stepId)
    if (!step || isTerminalStepStatus(step.status)) return false
    try {
      stepSvc.cancel(stepId)
      return true
    } catch {
      // 并发下已被其它路径置终态：保留既有事实。
      return false
    }
  }

  private recordReconcileReport(report: RunReconcileReport, now: number): void {
    try {
      const exists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='map_migration_reports'")
        .get()
      if (!exists) return
      const ts = new Date(now).toISOString()
      this.db
        .prepare(
          `INSERT INTO map_migration_reports
             (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, stats_json)
           VALUES (?, 'cleanup', 'work_runs_reconcile', NULL, ?, ?, ?, 'ok', ?)`,
        )
        .run(`mmr_${now}_reconcile`, ts, ts, process.pid, JSON.stringify(report))
    } catch (err) {
      logger.warn('failed to record work_runs reconciliation report:', err)
    }
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
  /** v41 / G2-1：命中的执行模式（NULL = v41 前的历史决策）。 */
  mode_id: string | null
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
    /** G2-1：模式 id；未知值 fail-closed（mode-registry）。 */
    modeId?: string
    confidence?: number
    reason?: string
  }): RoutingDecisionRow {
    if (!input.chosenAdapter || input.chosenAdapter.trim() === '') {
      throw new Error('routing_decisions.chosen_adapter 不允许空串（路由失败不写半条行,§4.7.8）')
    }
    // 未知 mode_id 直接拒绝，避免半条行落库后无法解释路由来源。
    if (input.modeId !== undefined) assertKnownMode(input.modeId)
    const id = `rd_${Date.now()}_${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO routing_decisions (
           id, work_item_id, work_run_id, chosen_adapter, candidate_json, reason, policy, mode_id, confidence, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.workItemId ?? null, input.workRunId ?? null, input.chosenAdapter,
        JSON.stringify(input.candidates), input.reason ?? null, input.policy,
        input.modeId ?? null, input.confidence ?? null, Date.now(),
      )
    return this.db.prepare('SELECT * FROM routing_decisions WHERE id = ?').get(id) as RoutingDecisionRow
  }
}
