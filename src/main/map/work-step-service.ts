/**
 * S5a 编排步状态机（session-map 蓝图 §4.7.4）。
 *
 * 职责边界：
 * - 只写 work_steps 一行，不驱动 Agent、不建 run（run 由 WorkRunService 负责）；
 * - 所有迁移一律条件更新；终态不可回退，重试是新 attempt；
 * - 步终态的写入时机由执行器保证（会话 terminate 之后），本服务不做时序假设；
 * - work_steps 无 failure_class 列，失败分类落在 work_runs.failure_class。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { WorkStepRow } from './work-item-service'

export type WorkStepStatus = WorkStepRow['status']

/** 终态：不可回退。 */
export const WORK_STEP_TERMINAL: readonly WorkStepStatus[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'skipped',
]

/** 非终态（可被取消/暂停）。 */
const NON_TERMINAL: readonly WorkStepStatus[] = [
  'planning',
  'pending',
  'waiting_approval',
  'running',
  'review',
  'needs_input',
  'paused',
]

/** 条件更新未命中（终态/竞态）：调用方不得重试写，按冲突处理。 */
export class WorkStepConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkStepConflictError'
  }
}

/** 前置条件不满足（如旧 run 未终态）。 */
export class WorkStepGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkStepGuardError'
  }
}

export function isTerminalStepStatus(status: WorkStepStatus): boolean {
  return WORK_STEP_TERMINAL.includes(status)
}

const RUN_TERMINAL = ['completed', 'failed', 'cancelled', 'superseded', 'interrupted', 'timed_out']

export class WorkStepService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(id: string): WorkStepRow | undefined {
    return this.db.prepare('SELECT * FROM work_steps WHERE id = ?').get(id) as WorkStepRow | undefined
  }

  listByItem(workItemId: string, revision: number): WorkStepRow[] {
    return this.db
      .prepare('SELECT * FROM work_steps WHERE work_item_id = ? AND work_item_revision = ? ORDER BY seq ASC')
      .all(workItemId, revision) as WorkStepRow[]
  }

  /**
   * 计划确认（§4.7.4 第 1 行）：planning → pending。
   * 供 WorkItemService.confirm 在同一事务内调用；重复调用幂等（仅命中 planning）。
   */
  activatePlanningSteps(workItemId: string, revision: number, now = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'pending', updated_at = ?
          WHERE work_item_id = ? AND work_item_revision = ? AND status = 'planning'`,
      )
      .run(now, workItemId, revision)
    return result.changes
  }

  /** pending | waiting_approval → running（§4.7.4 第 6/8 行）。 */
  start(
    stepId: string,
    opts?: { invocationId?: string; deadlineAt?: number | null },
  ): WorkStepRow {
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'running', started_at = COALESCE(started_at, ?),
           invocation_id = COALESCE(?, invocation_id), deadline_at = ?,
           updated_at = ?
          WHERE id = ? AND status IN ('pending','waiting_approval')`,
      )
      .run(now, opts?.invocationId ?? null, opts?.deadlineAt ?? null, now, stepId)
    return this.confirmed(stepId, result.changes, "pending|waiting_approval → running")
  }

  /** pending → waiting_approval（§4.7.4 第 5 行；审批记录须已先落 agent_approvals）。 */
  awaitApproval(stepId: string): WorkStepRow {
    const now = Date.now()
    const result = this.db
      .prepare("UPDATE work_steps SET status = 'waiting_approval', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, stepId)
    return this.confirmed(stepId, result.changes, "pending → waiting_approval")
  }

  /**
   * running → succeeded | review | needs_input；review → succeeded。
   * needs_input 与 input_request_json 同一事务写入（§4.7.4 第 12 行）。
   */
  complete(
    stepId: string,
    outcome:
      | { status: 'succeeded' }
      | { status: 'review' }
      | { status: 'needs_input'; inputRequestJson: string },
  ): WorkStepRow {
    const target = outcome.status
    if (target === 'needs_input' && !outcome.inputRequestJson.trim()) {
      throw new WorkStepGuardError('needs_input 必须提供非空 input_request_json')
    }
    const now = Date.now()
    const txn = this.db.transaction((): WorkStepRow => {
      let changes = 0
      if (target === 'succeeded') {
        changes = this.db
          .prepare(
            `UPDATE work_steps SET status = 'succeeded', ended_at = ?, updated_at = ?
              WHERE id = ? AND status IN ('running','review')`,
          )
          .run(now, now, stepId).changes
      } else if (target === 'review') {
        changes = this.db
          .prepare("UPDATE work_steps SET status = 'review', updated_at = ? WHERE id = ? AND status = 'running'")
          .run(now, stepId).changes
      } else {
        changes = this.db
          .prepare(
            `UPDATE work_steps SET status = 'needs_input', input_request_json = ?, updated_at = ?
              WHERE id = ? AND status IN ('running','review')`,
          )
          .run(outcome.inputRequestJson, now, stepId).changes
      }
      return this.confirmed(stepId, changes, `running|review → ${target}`)
    })
    return txn()
  }

  /** running → failed | timed_out（§4.7.4 第 11/13 行）。失败分类写 work_runs。 */
  fail(stepId: string, outcome: { status: 'failed' | 'timed_out' }): WorkStepRow {
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = ?, ended_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(outcome.status, now, now, stepId)
    return this.confirmed(stepId, result.changes, `running → ${outcome.status}`)
  }

  /**
   * 依赖阻断：未开始的步（planning/pending）→ failed。
   *
   * 为什么不是 skipped：M2 的依赖语义是 `DEP_SATISFIED = {succeeded, skipped}`，
   * skipped 会被下游当成"依赖已满足"，级联无法沿依赖链继续传递；且 schema 无
   * skip_reason 列，无法区分人工跳过与阻断跳过。failed 既能传递阻断，也能让 §5.5.1
   * 聚合把 item 落到 failed（被连带判负）。
   *
   * 本方法不建 work_run，也不写 failure_class（列只在 work_runs 上）——只表达
   * "该步从未执行、因上游失败而不可达"。条件更新只命中 planning|pending：
   * running / waiting_approval / review / needs_input / paused 视为已开始，绝不异地改。
   */
  failUnstarted(stepId: string): WorkStepRow | undefined {
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'failed', ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('planning','pending')`,
      )
      .run(now, now, stepId)
    if (result.changes !== 1) return undefined
    return this.get(stepId)
  }

  /**
   * 沿依赖链级联阻断：上游进入 failed/timed_out/cancelled 后，下游所有**未开始**的步
   * 置 failed（fixpoint，多级传递）。已 running 的步不在条件更新范围内，不会被改写。
   *
   * 返回本轮实际阻断的 step id；空数组表示无可级联项。
   */
  blockUnstartedDependents(workItemId: string, revision: number): string[] {
    const BLOCKING: ReadonlySet<WorkStepStatus> = new Set(['failed', 'timed_out', 'cancelled'])
    const blocked: string[] = []
    for (;;) {
      const list = this.listByItem(workItemId, revision)
      const byId = new Map(list.map((s) => [s.id, s]))
      const candidates = list.filter((s) => s.status === 'planning' || s.status === 'pending')
      const newly = candidates.filter((s) => {
        let deps: string[]
        try {
          const parsed = JSON.parse(s.depends_on_step_ids_json ?? '[]') as unknown
          deps = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
        } catch {
          // 依赖列损坏交给 startStep 的 DEPS_INVALID 守卫，不在级联里猜。
          return false
        }
        return deps.some((id) => {
          const dep = byId.get(id)
          return dep !== undefined && BLOCKING.has(dep.status)
        })
      })
      if (newly.length === 0) break
      for (const s of newly) {
        // 并发下已被启动 → 更新未命中，绝不改写 running。
        if (this.failUnstarted(s.id)) blocked.push(s.id)
      }
    }
    return blocked
  }

  /**
   * pending → skipped（可选步条件不满足）。schema 无 skip_reason 列，
   * 原因由调用方事件承载；不得写 succeeded 伪装（§4.7.4 第 18 行）。
   */
  skip(stepId: string): WorkStepRow {
    const now = Date.now()
    const result = this.db
      .prepare("UPDATE work_steps SET status = 'skipped', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, now, stepId)
    return this.confirmed(stepId, result.changes, "pending → skipped")
  }

  /** 任一非终态 → cancelled（§4.7.4 第 14/19 行）。 */
  cancel(stepId: string): WorkStepRow {
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'cancelled', ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN (${NON_TERMINAL.map(() => '?').join(',')})`,
      )
      .run(now, now, stepId, ...NON_TERMINAL)
    return this.confirmed(stepId, result.changes, "non-terminal → cancelled")
  }

  /** pending | running | review → paused（基础设施暂停；恢复走新 attempt）。 */
  pause(stepId: string): WorkStepRow {
    const now = Date.now()
    const result = this.db
      .prepare(
        "UPDATE work_steps SET status = 'paused', updated_at = ? WHERE id = ? AND status IN ('pending','running','review')",
      )
      .run(now, stepId)
    return this.confirmed(stepId, result.changes, "pending|running|review → paused")
  }

  /**
   * needs_input | paused → pending，attempt+1（§4.7.4 第 16/17 行）。
   * 守卫：该步最新 run 必须已终态，恢复不得复用旧 run id。
   */
  resume(stepId: string): WorkStepRow {
    const step = this.get(stepId)
    if (!step) throw new WorkStepConflictError(`work_step ${stepId} 不存在`)
    const latestRun = this.db
      .prepare('SELECT status FROM work_runs WHERE step_id = ? ORDER BY run_seq DESC LIMIT 1')
      .get(stepId) as { status: string } | undefined
    if (latestRun && !RUN_TERMINAL.includes(latestRun.status)) {
      throw new WorkStepGuardError(`step ${stepId}: 旧 run 状态 ${latestRun.status} 未终态，不得恢复`)
    }
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'pending', attempt = attempt + 1,
           invocation_id = NULL, deadline_at = NULL, updated_at = ?
          WHERE id = ? AND status IN ('needs_input','paused')`,
      )
      .run(now, stepId)
    return this.confirmed(stepId, result.changes, "needs_input|paused → pending(attempt+1)")
  }

  private confirmed(stepId: string, changes: number, transition: string): WorkStepRow {
    if (changes !== 1) {
      const current = this.get(stepId)
      throw new WorkStepConflictError(
        `work_step ${stepId}: ${transition} 未命中（当前 ${current?.status ?? 'missing'}）`,
      )
    }
    return this.get(stepId)!
  }
}
