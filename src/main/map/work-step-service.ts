/**
 * S5a 编排步状态机（session-map 蓝图 §4.7.4）。
 *
 * 职责边界：
 * - 只写 work_steps 一行，不驱动 Agent、不建 run（run 由 WorkRunService 负责）；
 * - 所有迁移一律条件更新；终态不可回退，重试是新 attempt；
 * - 步终态的写入时机由执行器保证（会话 terminate 之后），本服务不做时序假设；
 * - v34 起 work_steps 有失败/跳过归因列：失败分类本服务与 work_runs 同值域写入，
 *   级联阻断另立 `blocked_by_dependency`，与人工跳过（skip_reason）可区分。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { StepFailureClass, StepSkipReason, WorkStepRow } from './work-item-service'

export type { StepFailureClass, StepSkipReason } from './work-item-service'

export type WorkStepStatus = WorkStepRow['status']

/** 12 值（与 schema.ts work_steps.status CHECK 精确一致）。 */
export const WORK_STEP_STATUSES: readonly WorkStepStatus[] = [
  'planning',
  'pending',
  'waiting_approval',
  'running',
  'review',
  'needs_input',
  'paused',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'skipped',
]

/** 终态：不可回退。 */
export const WORK_STEP_TERMINAL: readonly WorkStepStatus[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'skipped',
]

/**
 * G2-18 声明式迁移表（12 值，唯一权威；§5.9.8）。
 *
 * 每行列出该状态的**全部**合法出边，写入方写在行尾注释里。所有迁移方法在写库前
 * 用 `assertDeclared` 复核自己的来源集合，改表不搬方法、加方法不改表都会撞测试。
 * `review` 当前**无生产写入方**（只有 complete() 允许写入，仓库内无调用方）；
 * 因此不为死状态补 `review → failed`，其出边只保留已实现的 succeeded/needs_input。
 */
export const WORK_STEP_TRANSITIONS: Readonly<Record<WorkStepStatus, readonly WorkStepStatus[]>> = {
  // activatePlanningSteps / failUnstarted(blocked_by_dependency) / cancel
  planning: ['pending', 'failed', 'cancelled'],
  // awaitApproval / start / skip / failUnstarted / cancel / pause
  pending: ['waiting_approval', 'running', 'skipped', 'failed', 'cancelled', 'paused'],
  // start / fail(timed_out) / cancel；G2-10：确认通过/驳回返工时回 pending
  waiting_approval: ['running', 'timed_out', 'cancelled', 'pending'],
  // complete / fail / cancel / pause
  running: ['review', 'succeeded', 'failed', 'timed_out', 'needs_input', 'paused', 'cancelled'],
  // complete / cancel / pause（无生产写入方进入 review，保留出边以便将来接 checker）
  review: ['succeeded', 'needs_input', 'paused', 'cancelled'],
  // resume(attempt+1) / settleNeedsInput / cancel
  needs_input: ['pending', 'succeeded', 'failed', 'cancelled'],
  // resume(attempt+1) / cancel
  paused: ['pending', 'cancelled'],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  skipped: [],
}

export function canTransitionStepStatus(from: WorkStepStatus, to: WorkStepStatus): boolean {
  return WORK_STEP_TRANSITIONS[from].includes(to)
}

/** G2-18：步级迁移事件（5 处 WorkStepService 构造点统一接入）。 */
export interface WorkStepChangeEvent {
  stepId: string
  workItemId: string
  revision: number
  status: WorkStepStatus
  /** 迁移标签，如 `pending → running`；写入方排查用。 */
  transition: string
}

export interface WorkStepServiceOptions {
  /** 迁移成功后的同步回调；回调抛错不影响已落库的迁移。 */
  onChanged?: (event: WorkStepChangeEvent) => void
}

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

/** 各迁移方法的来源集合（与 WORK_STEP_TRANSITIONS 交叉校验，禁止隐式越界）。 */
const SRC_ACTIVATE = ['planning'] as const
const SRC_START = ['pending', 'waiting_approval'] as const
const SRC_AWAIT = ['pending'] as const
const SRC_COMPLETE_SUCCEEDED = ['running', 'review'] as const
const SRC_COMPLETE_REVIEW = ['running'] as const
const SRC_COMPLETE_NEEDS_INPUT = ['running', 'review'] as const
const SRC_FAIL = ['running'] as const
const SRC_TIMEOUT = ['running', 'waiting_approval'] as const
const SRC_UNSTARTED = ['planning', 'pending'] as const
const SRC_SKIP = ['pending'] as const
const SRC_PAUSE = ['pending', 'running', 'review'] as const
const SRC_RESUME = ['needs_input', 'paused'] as const
const SRC_SETTLE = ['needs_input'] as const
const SRC_RETURN = ['waiting_approval'] as const

export class WorkStepService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly options: WorkStepServiceOptions = {},
  ) {}

  private inList(sources: readonly WorkStepStatus[]): string {
    return sources.map(() => '?').join(',')
  }

  /** G2-18：写库前复核来源集合与目标状态都在迁移表里，未声明即拒绝。 */
  private assertDeclared(sources: readonly WorkStepStatus[], target: WorkStepStatus): void {
    for (const from of sources) {
      if (!canTransitionStepStatus(from, target)) {
        throw new WorkStepConflictError(`INVALID_TRANSITION: 未声明 ${from} → ${target}（见迁移表）`)
      }
    }
  }

  private notify(row: WorkStepRow, transition: string): void {
    if (!this.options.onChanged) return
    try {
      this.options.onChanged({
        stepId: row.id,
        workItemId: row.work_item_id,
        revision: row.work_item_revision,
        status: row.status,
        transition,
      })
    } catch {
      // 事件消费方的异常不得回滚或掩盖已落库的迁移。
    }
  }

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
    this.assertDeclared(SRC_ACTIVATE, 'pending')
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM work_steps WHERE work_item_id = ? AND work_item_revision = ? AND status = 'planning'",
        )
        .all(workItemId, revision) as Array<{ id: string }>
    ).map((row) => row.id)
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'pending', updated_at = ?
          WHERE work_item_id = ? AND work_item_revision = ? AND status = 'planning'`,
      )
      .run(now, workItemId, revision)
    for (const id of ids) {
      const row = this.get(id)
      if (row?.status === 'pending') this.notify(row, 'planning → pending')
    }
    return result.changes
  }

  /** pending | waiting_approval → running（§4.7.4 第 6/8 行）。 */
  start(
    stepId: string,
    opts?: { invocationId?: string; deadlineAt?: number | null },
  ): WorkStepRow {
    this.assertDeclared(SRC_START, 'running')
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'running', started_at = COALESCE(started_at, ?),
           invocation_id = COALESCE(?, invocation_id), deadline_at = ?,
           updated_at = ?
          WHERE id = ? AND status IN (${this.inList(SRC_START)})`,
      )
      .run(now, opts?.invocationId ?? null, opts?.deadlineAt ?? null, now, stepId, ...SRC_START)
    return this.confirmed(stepId, result.changes, "pending|waiting_approval → running")
  }

  /**
   * pending → waiting_approval（§4.7.4 第 5 行；审批记录须已先落 agent_approvals）。
   * G2-10：步级确认闸复用同一状态，把确认点契约写进 `input_request_json`。
   */
  awaitApproval(stepId: string, inputRequestJson?: string): WorkStepRow {
    this.assertDeclared(SRC_AWAIT, 'waiting_approval')
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'waiting_approval',
           input_request_json = COALESCE(?, input_request_json), updated_at = ?
          WHERE id = ? AND status IN (${this.inList(SRC_AWAIT)})`,
      )
      .run(inputRequestJson ?? null, now, stepId, ...SRC_AWAIT)
    return this.confirmed(stepId, result.changes, "pending → waiting_approval")
  }

  /**
   * waiting_approval → pending（G2-10 确认通过/C4 驳回返工）。
   * `inputRequestJson` 显式覆盖：通过传 null 清空，驳回保留返工标记。
   */
  returnToPending(stepId: string, inputRequestJson: string | null = null): WorkStepRow {
    this.assertDeclared(SRC_RETURN, 'pending')
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'pending', input_request_json = ?, updated_at = ?
          WHERE id = ? AND status IN (${this.inList(SRC_RETURN)})`,
      )
      .run(inputRequestJson, now, stepId, ...SRC_RETURN)
    return this.confirmed(stepId, result.changes, "waiting_approval → pending")
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
        this.assertDeclared(SRC_COMPLETE_SUCCEEDED, 'succeeded')
        changes = this.db
          .prepare(
            `UPDATE work_steps SET status = 'succeeded', ended_at = ?, updated_at = ?
              WHERE id = ? AND status IN (${this.inList(SRC_COMPLETE_SUCCEEDED)})`,
          )
          .run(now, now, stepId, ...SRC_COMPLETE_SUCCEEDED).changes
      } else if (target === 'review') {
        this.assertDeclared(SRC_COMPLETE_REVIEW, 'review')
        changes = this.db
          .prepare(
            `UPDATE work_steps SET status = 'review', updated_at = ?
              WHERE id = ? AND status IN (${this.inList(SRC_COMPLETE_REVIEW)})`,
          )
          .run(now, stepId, ...SRC_COMPLETE_REVIEW).changes
      } else {
        this.assertDeclared(SRC_COMPLETE_NEEDS_INPUT, 'needs_input')
        changes = this.db
          .prepare(
            `UPDATE work_steps SET status = 'needs_input', input_request_json = ?, updated_at = ?
              WHERE id = ? AND status IN (${this.inList(SRC_COMPLETE_NEEDS_INPUT)})`,
          )
          .run(outcome.inputRequestJson, now, stepId, ...SRC_COMPLETE_NEEDS_INPUT).changes
      }
      return this.confirmed(stepId, changes, `running|review → ${target}`)
    })
    return txn()
  }

  /**
   * running → failed | timed_out；waiting_approval → timed_out（§4.7.4 第 11/13 行）。
   * 审批等待同样受 run deadline 约束：到期由 tick 的 deadline 扫描收口为 timed_out；
   * waiting_approval 不接 failed，避免把「未执行」记成执行失败。
   * v34：失败分类同时写本行 failure_class（run 级仍由 WorkRunService 写 work_runs），
   * 这样「步为什么失败」不必再跨表 join 最近一次 run。
   */
  fail(
    stepId: string,
    outcome: { status: 'failed' | 'timed_out'; failureClass: StepFailureClass },
  ): WorkStepRow {
    const sources = outcome.status === 'timed_out' ? SRC_TIMEOUT : SRC_FAIL
    this.assertDeclared(sources, outcome.status)
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = ?, failure_class = ?, ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN (${this.inList(sources)})`,
      )
      .run(outcome.status, outcome.failureClass, now, now, stepId, ...sources)
    return this.confirmed(stepId, result.changes, `${sources.join('|')} → ${outcome.status}`)
  }

  /**
   * 依赖阻断：未开始的步（planning/pending）→ failed + failure_class='blocked_by_dependency'。
   *
   * v34 之后仍不改成 skipped：虽然 skip_reason / failure_class 已能区分「人工跳过」
   * 与「被上游连带判负」，但 M2 的依赖语义是 `DEP_SATISFIED = {succeeded, skipped}`，
   * skipped 会被下游当成"依赖已满足"，级联无法沿依赖链继续传递；§5.5.1 聚合还会把
   * 全 skipped 的 item 收敛为 done，掩盖上游失败。改回 skipped 需要同时改依赖放行
   * 与聚合两处语义，属于行为变更；本轮只加归因列，用 failure_class 表达阻断来源，
   * 状态仍保持 failed（fail-closed）。
   *
   * 本方法不建 work_run——只表达"该步从未执行、因上游失败而不可达"。
   * 条件更新只命中 planning|pending：running / waiting_approval / review /
   * needs_input / paused 视为已开始，绝不异地改。
   */
  failUnstarted(stepId: string): WorkStepRow | undefined {
    this.assertDeclared(SRC_UNSTARTED, 'failed')
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'failed', failure_class = 'blocked_by_dependency',
           ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN (${this.inList(SRC_UNSTARTED)})`,
      )
      .run(now, now, stepId, ...SRC_UNSTARTED)
    if (result.changes !== 1) return undefined
    const row = this.get(stepId)
    if (row) this.notify(row, 'planning|pending → failed(blocked_by_dependency)')
    return row
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
   * pending → skipped（可选步条件不满足 / 人工跳过）。不得写 succeeded 伪装
   * （§4.7.4 第 18 行）。v34：原因落 skip_reason，与级联阻断的 failure_class 区分。
   */
  skip(stepId: string, reason: StepSkipReason): WorkStepRow {
    this.assertDeclared(SRC_SKIP, 'skipped')
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'skipped', skip_reason = ?, ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN (${this.inList(SRC_SKIP)})`,
      )
      .run(reason, now, now, stepId, ...SRC_SKIP)
    return this.confirmed(stepId, result.changes, "pending → skipped")
  }

  /** 任一非终态 → cancelled（§4.7.4 第 14/19 行）。 */
  cancel(stepId: string): WorkStepRow {
    this.assertDeclared(NON_TERMINAL, 'cancelled')
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'cancelled', ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN (${this.inList(NON_TERMINAL)})`,
      )
      .run(now, now, stepId, ...NON_TERMINAL)
    return this.confirmed(stepId, result.changes, "non-terminal → cancelled")
  }

  /** pending | running | review → paused（基础设施暂停；恢复走新 attempt）。 */
  pause(stepId: string): WorkStepRow {
    this.assertDeclared(SRC_PAUSE, 'paused')
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'paused', updated_at = ?
          WHERE id = ? AND status IN (${this.inList(SRC_PAUSE)})`,
      )
      .run(now, stepId, ...SRC_PAUSE)
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
    this.assertDeclared(SRC_RESUME, 'pending')
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = 'pending', attempt = attempt + 1,
           invocation_id = NULL, deadline_at = NULL, updated_at = ?
          WHERE id = ? AND status IN (${this.inList(SRC_RESUME)})`,
      )
      .run(now, stepId, ...SRC_RESUME)
    return this.confirmed(stepId, result.changes, "needs_input|paused → pending(attempt+1)")
  }

  /**
   * manual 验收确认后的收口：needs_input → succeeded，或 needs_input → failed(verify_fail)。
   *
   * 与 `resume`（needs_input → pending，attempt+1）的区别：工作已由原 turn 完成，
   * 人工确认只重算验收，不重跑 agent，因此不新开 attempt、不复用旧 run。
   */
  settleNeedsInput(
    stepId: string,
    outcome: { status: 'succeeded' } | { status: 'failed'; failureClass: StepFailureClass },
  ): WorkStepRow {
    this.assertDeclared(SRC_SETTLE, outcome.status)
    const now = Date.now()
    const failureClass = outcome.status === 'failed' ? outcome.failureClass : null
    const result = this.db
      .prepare(
        `UPDATE work_steps SET status = ?, failure_class = ?, ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN (${this.inList(SRC_SETTLE)})`,
      )
      .run(outcome.status, failureClass, now, now, stepId, ...SRC_SETTLE)
    return this.confirmed(stepId, result.changes, `needs_input → ${outcome.status}`)
  }

  /** 部分确认后仍在等待：needs_input → needs_input，只更新待确认条目。 */
  updateInputRequest(stepId: string, inputRequestJson: string): WorkStepRow {
    if (!inputRequestJson.trim()) {
      throw new WorkStepGuardError('input_request_json 不得为空')
    }
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE work_steps SET input_request_json = ?, updated_at = ?
          WHERE id = ? AND status = 'needs_input'`,
      )
      .run(inputRequestJson, now, stepId)
    return this.confirmed(stepId, result.changes, 'needs_input input_request_json update')
  }

  private confirmed(stepId: string, changes: number, transition: string): WorkStepRow {
    if (changes !== 1) {
      const current = this.get(stepId)
      throw new WorkStepConflictError(
        `work_step ${stepId}: ${transition} 未命中（当前 ${current?.status ?? 'missing'}）`,
      )
    }
    const row = this.get(stepId)!
    this.notify(row, transition)
    return row
  }
}
