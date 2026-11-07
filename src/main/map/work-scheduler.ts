/**
 * L2 调度入口（session-map 蓝图 §5.9 tick 第 1–6 步）：
 * - claimNext(projectPath)：按优先级找可运行的 (item, step)；
 * - startStep(stepId)：校验依赖 → 幂等绑定 run → claim run → 步置 running。
 *
 * 边界（M2）：
 * - 不驱动 Agent、不接 IPC、不写证据；
 * - gate 只复核已持久化的 gate_status（G1-G6 引擎未实现，见蓝图 L3-f），不重跑 gate；
 * - 写闸/路由未实现，候选按 item 创建顺序串行，不并行；
 * - 幂等键由 WorkRunService 生成（lineage:revision:stepSeq:attempt），重放复用既有 run。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { WorkItemService, type WorkItemRow, type WorkStepRow } from './work-item-service'
import { WorkRunService, type WorkRunRow } from './work-run-service'
import { WorkStepService, WorkStepConflictError } from './work-step-service'

export class WorkSchedulerGuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WorkSchedulerGuardError'
  }
}

export interface SchedulerOptions {
  projectPath?: string
  graphId?: string
  executorKind?: 'agent' | 'test' | 'human'
  adapterName?: string
  /** 0/缺省 = 不设 deadline（F3：L2 编排层可选给值，kernel 不设默认） */
  deadlineAt?: number | null
}

export interface ClaimedStep {
  item: WorkItemRow
  step: WorkStepRow
  run: WorkRunRow
  reused: boolean
}

/** 依赖满足：succeeded 或 skipped（skip 不阻断后续）。 */
const DEP_SATISFIED = new Set(['succeeded', 'skipped'])
const STEP_RUNNABLE = new Set(['pending'])

export class WorkScheduler {
  private readonly items: WorkItemService
  private readonly steps: WorkStepService
  private readonly runs: WorkRunService

  constructor(private readonly db: BetterSqlite3.Database) {
    this.items = new WorkItemService(db)
    this.steps = new WorkStepService(db)
    this.runs = new WorkRunService(db)
  }

  /**
   * 领取下一个可运行步。没有可领的步时按 §5.5.1 收敛 item，再返回 null。
   *
   * 两种"没有就绪步"必须区分：
   * - 还有非终态步（依赖未满足 / 正在跑 / 等审批）：**等**，不改 item；
   * - 当前 revision 所有步都已终态：聚合 item（≥1 failed→failed；有 cancelled→cancelled；
   *   全 succeeded/skipped→done），并由 `WorkItemService.convergeIfTerminal` 做条件更新。
   *
   * 候选顺序：queued 优先于 running → item.created_at → seq。
   */
  claimNext(opts: SchedulerOptions = {}): ClaimedStep | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_items
          WHERE is_current = 1 AND archived_at IS NULL AND status IN ('queued','running')
            AND (? IS NULL OR project_path = ?)
            AND (? IS NULL OR graph_id = ?)
          ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, created_at ASC, revision ASC
          LIMIT 50`,
      )
      .all(opts.projectPath ?? null, opts.projectPath ?? null, opts.graphId ?? null, opts.graphId ?? null) as WorkItemRow[]

    for (const item of rows) {
      // 上游失败/超时/取消后，先把依赖链上未开始的步级联置 failed（running 不受影响），
      // 否则 item 会因下游永久 pending 而卡在 running、永不收敛。
      this.steps.blockUnstartedDependents(item.id, item.revision)
      for (const step of this.steps.listByItem(item.id, item.revision)) {
        if (!this.isReady(item, step)) continue
        try {
          return this.startStep(step.id, opts)
        } catch (error) {
          // 并发下被别人先领：继续看下一个候选；守卫/终态竞态同样跳过。
          if (error instanceof WorkSchedulerGuardError || error instanceof WorkStepConflictError) continue
          throw error
        }
      }
      // 该 item 没有就绪步：只有"全部步终态"才收敛；还有非终态步说明在等，保持不动。
      this.items.convergeIfTerminal(item.id)
    }
    return null
  }

  /**
   * 启动指定步。事务内完成：claim item（queued→running）、幂等入队、claim run、步置 running。
   * 任一步失败整体回滚，不留下 running item + 无 run 的半状态。
   */
  startStep(stepId: string, opts: SchedulerOptions = {}): ClaimedStep {
    const txn = this.db.transaction((): ClaimedStep => {
      const step = this.steps.get(stepId)
      if (!step) throw new WorkSchedulerGuardError('STEP_NOT_FOUND', `work_step ${stepId} 不存在`)
      let item = this.items.get(step.work_item_id)
      if (!item) throw new WorkSchedulerGuardError('ITEM_NOT_FOUND', `work_item ${step.work_item_id} 不存在`)
      if (item.is_current !== 1 || item.revision !== step.work_item_revision) {
        throw new WorkSchedulerGuardError('ITEM_REVISION_STALE', 'step 不属于当前 revision')
      }
      // gate 复核（只读已落库值；不重跑 gate 引擎）。
      if (item.gate_status !== 'pass' && item.gate_status !== 'waived') {
        throw new WorkSchedulerGuardError('GATE_NOT_PASSED', `gate_status=${item.gate_status}`)
      }
      if (!STEP_RUNNABLE.has(step.status)) {
        throw new WorkSchedulerGuardError('STEP_NOT_PENDING', `step status=${step.status}`)
      }
      this.assertDeps(item, step)

      if (item.status === 'queued') {
        item = this.items.claim(item.id)
      } else if (item.status !== 'running') {
        throw new WorkSchedulerGuardError('ITEM_NOT_RUNNABLE', `work_item status=${item.status}`)
      }

      const { run, reused } = this.runs.enqueue({
        workItemId: item.id,
        stepId,
        executorKind: opts.executorKind ?? 'agent',
        adapterName: opts.adapterName,
        deadlineAt: opts.deadlineAt ?? undefined,
      })
      if (reused) {
        if (run.status === 'running') {
          // 崩溃恢复：run 已 running 但步尚未置 running，直接沿用，不再新建。
          const started = this.steps.start(stepId, { deadlineAt: run.deadline_at })
          return { item, step: started, run, reused: true }
        }
        if (run.status !== 'queued') {
          throw new WorkSchedulerGuardError('RUN_TERMINAL', `既有 run 状态=${run.status}，需走 resume`)
        }
      }
      const claimed = this.runs.claim(run.id)
      if (!claimed) throw new WorkSchedulerGuardError('RUN_CLAIM_LOST', 'run 已被其他 worker 领取')
      const started = this.steps.start(stepId, { deadlineAt: claimed.deadline_at })
      return { item, step: started, run: claimed, reused }
    })
    return txn()
  }

  /** 依赖全部 succeeded/skipped；缺依赖或未终态一律不可运行。 */
  private assertDeps(item: WorkItemRow, step: WorkStepRow): void {
    const raw = step.depends_on_step_ids_json
    if (!raw) return
    let deps: unknown
    try {
      deps = JSON.parse(raw)
    } catch {
      throw new WorkSchedulerGuardError('DEPS_INVALID', `step ${step.id} depends_on_step_ids_json 非 JSON`)
    }
    if (!Array.isArray(deps)) {
      throw new WorkSchedulerGuardError('DEPS_INVALID', `step ${step.id} 依赖不是数组`)
    }
    for (const depId of deps) {
      if (typeof depId !== 'string') {
        throw new WorkSchedulerGuardError('DEPS_INVALID', `step ${step.id} 依赖含非字符串`)
      }
      const dep = this.steps.get(depId)
      if (!dep || dep.work_item_id !== item.id || dep.work_item_revision !== item.revision) {
        throw new WorkSchedulerGuardError('DEP_NOT_FOUND', `依赖 ${depId} 不属于当前任务 revision`)
      }
      if (!DEP_SATISFIED.has(dep.status)) {
        throw new WorkSchedulerGuardError('DEP_NOT_SATISFIED', `依赖 ${depId} status=${dep.status}`)
      }
    }
  }

  /** 只读就绪判定，供 claimNext 过滤候选；崩溃残留 run 允许复用，故不查活动 run。 */
  private isReady(item: WorkItemRow, step: WorkStepRow): boolean {
    if (!STEP_RUNNABLE.has(step.status)) return false
    if (item.gate_status !== 'pass' && item.gate_status !== 'waived') return false
    try {
      this.assertDeps(item, step)
    } catch {
      return false
    }
    return true
  }
}
