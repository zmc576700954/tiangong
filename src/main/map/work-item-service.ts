/**
 * WorkItemService（S5a,session-map 蓝图 §4.1 + §4.7 施工细则）
 *
 * 唯一写入方：UI/planner 只能发命令,状态迁移一律走本服务。
 *  - 每次迁移一条条件更新 `UPDATE ... WHERE id=? AND status IN (…)`,
 *    受影响行数必须为 1,否则 CONFLICT（终态不可回退,不重试写）。
 *  - revision 语义（§4.7.3）：每 revision 一行不可变;修订事务内校验旧 revision
 *    无 running run → 旧行 is_current=0/superseded → 新行 revision+1 → 复制 steps。
 *  - gate（§4.7.3）：结果只存 pass/incomplete/waived;waived 必须三字段齐全,
 *    缺一即 incomplete;具体缺项写 gate_missing_json。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import { WorkStepService, isTerminalStepStatus } from './work-step-service'
import type { FailureClass } from './work-run-service'
import { scheduleRecomputeForWorkItem } from './execution-state'

const logger = createLogger('WorkItemService')

export type WorkItemStatus =
  | 'draft' | 'awaiting_confirm' | 'queued' | 'running' | 'blocked'
  | 'needs_input' | 'needs_human' | 'paused' | 'interrupted'
  | 'done' | 'failed' | 'cancelled' | 'superseded'

export const WORK_ITEM_TERMINAL: readonly WorkItemStatus[] = ['done', 'failed', 'cancelled', 'superseded']

/**
 * work_items.cancel_reason（v34）：cancelled 的归因。
 * - `user`：人工取消（UI cancel / needs_human 裁决 cancel）；
 * - `partial_cancel`：终态聚合出的取消——无失败、至少一步被取消（§5.5.1）。
 */
export type WorkItemCancelReason = 'user' | 'partial_cancel'

/** 可被用户取消/被 superseded 的非终态集合（§4.7.2 取消与完成竞态）。 */
const CANCELLABLE: readonly WorkItemStatus[] = ['queued', 'running', 'needs_input', 'needs_human', 'paused', 'interrupted']

export type GateStatus = 'incomplete' | 'pass' | 'waived'

export interface WorkItemRow {
  id: string
  lineage_id: string
  revision: number
  supersedes_id: string | null
  is_current: number
  project_path: string | null
  graph_id: string
  anchor_entity_key: string | null
  anchor_node_id: string | null
  parent_work_item_id: string | null
  depth: number
  title: string
  goal: string | null
  scope_files: string
  out_of_scope_files: string | null
  acceptance_json: string
  verification_hint: string | null
  status: WorkItemStatus
  cancel_reason: WorkItemCancelReason | null
  gate_status: GateStatus
  gate_missing_json: string | null
  gate_waived_by: string | null
  gate_waived_at: number | null
  gate_waive_reason: string | null
  depends_on_json: string
  origin: 'human' | 'derived_plan' | 'imported'
  plan_id: string | null
  candidate_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

/**
 * work_steps.failure_class（v34）：与 work_runs 同值域，另加「被上游连带判负」。
 * work_steps.skip_reason（v34）：人工跳过与条件不满足必须可区分。
 */
export type StepFailureClass = FailureClass | 'blocked_by_dependency'
export type StepSkipReason = 'condition_unmet' | 'optional_not_required' | 'human'

export interface WorkStepRow {
  id: string
  work_item_id: string
  work_item_revision: number
  seq: number
  title: string
  step_kind: 'agent' | 'test' | 'human'
  scope_files_json: string
  depends_on_step_ids_json: string | null
  output_schema_json: string | null
  consults_json: string | null
  checker_work_item_id: string | null
  deadline_at: number | null
  attempt: number
  invocation_id: string | null
  input_request_json: string | null
  status:
    | 'planning' | 'pending' | 'waiting_approval' | 'running' | 'review'
    | 'needs_input' | 'paused' | 'succeeded' | 'failed' | 'timed_out'
    | 'cancelled' | 'skipped'
  skip_reason: StepSkipReason | null
  failure_class: StepFailureClass | null
  started_at: number | null
  ended_at: number | null
  created_at: number
  updated_at: number
}

export interface CreateWorkItemInput {
  projectPath?: string
  graphId: string
  anchorEntityKey?: string
  anchorNodeId?: string
  parentWorkItemId?: string
  title: string
  goal?: string
  scopeFiles?: string[]
  acceptance?: Array<Record<string, unknown>>
  verificationHint?: string
  dependsOn?: string[]
  origin?: 'human' | 'derived_plan' | 'imported'
  createdBy?: string
  /** 初始步骤（L1 人工单任务：通常 1..N 个手工步骤）；不传则创建 1 个默认 agent 步。 */
  steps?: Array<{ title: string; stepKind?: 'agent' | 'test' | 'human'; scopeFiles?: string[] }>
}

/** 状态迁移被拒：条件更新未命中（终态/竞态）——调用方不得重试写。 */
export class WorkItemConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkItemConflictError'
  }
}

/** 守卫条件不满足（如 confirm 时 gate 未过）。 */
export class WorkItemGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkItemGuardError'
  }
}

export class WorkItemService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  private now(): string {
    return new Date().toISOString()
  }

  get(id: string): WorkItemRow | undefined {
    return this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined
  }

  getCurrentByLineage(lineageId: string): WorkItemRow | undefined {
    return this.db
      .prepare('SELECT * FROM work_items WHERE lineage_id = ? AND is_current = 1')
      .get(lineageId) as WorkItemRow | undefined
  }

  listSteps(workItemId: string, revision: number): WorkStepRow[] {
    return this.db
      .prepare('SELECT * FROM work_steps WHERE work_item_id = ? AND work_item_revision = ? ORDER BY seq ASC')
      .all(workItemId, revision) as WorkStepRow[]
  }

  // ---------------------------------------------------------
  // 创建 / gate
  // ---------------------------------------------------------

  createDraft(input: CreateWorkItemInput): WorkItemRow {
    if (!input.title || input.title.trim() === '') {
      throw new WorkItemGuardError('title 必填')
    }
    const now = this.now()
    const id = `wi_${Date.now()}_${randomUUID().slice(0, 8)}`
    const lineageId = `wl_${Date.now()}_${randomUUID().slice(0, 8)}`
    const depth = input.parentWorkItemId ? (this.get(input.parentWorkItemId)?.depth ?? 0) + 1 : 0

    const insert = this.db.transaction((): WorkItemRow => {
      this.db
        .prepare(
          `INSERT INTO work_items (
             id, lineage_id, revision, is_current, project_path, graph_id,
             anchor_entity_key, anchor_node_id, parent_work_item_id, depth,
             title, goal, scope_files, acceptance_json, verification_hint,
             depends_on_json, origin, created_by, created_at, updated_at
           ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, lineageId, input.projectPath ?? null, input.graphId,
          input.anchorEntityKey ?? null, input.anchorNodeId ?? null, input.parentWorkItemId ?? null, depth,
          input.title.trim(), input.goal ?? null,
          JSON.stringify(input.scopeFiles ?? []),
          JSON.stringify(input.acceptance ?? []),
          input.verificationHint ?? null,
          JSON.stringify(input.dependsOn ?? []),
          input.origin ?? 'human', input.createdBy ?? null, now, now,
        )
      const steps = input.steps && input.steps.length > 0 ? input.steps : [{ title: `${input.title} 执行`, stepKind: 'agent' as const }]
      this.insertSteps(id, 1, steps, Date.now())
      return this.get(id)!
    })
    const row = insert()
    scheduleRecomputeForWorkItem(this.db, row.id)
    return row
  }

  private insertSteps(
    workItemId: string,
    revision: number,
    steps: NonNullable<CreateWorkItemInput['steps']>,
    nowMs: number,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO work_steps (
         id, work_item_id, work_item_revision, seq, title, step_kind, scope_files_json,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)`,
    )
    steps.forEach((s, i) => {
      stmt.run(
        `ws_${nowMs}_${randomUUID().slice(0, 8)}`, workItemId, revision, i + 1,
        s.title, s.stepKind ?? 'agent', JSON.stringify(s.scopeFiles ?? []),
        nowMs, nowMs,
      )
    })
  }

  /**
   * gate 结果落库（§4.7.3）：waived 必须 waivedBy/waivedAt/waiveReason 三字段齐全。
   * L1 无 G1-G6 引擎,gate 由人工/上游检查写入。
   */
  setGateResult(
    id: string,
    result: Exclude<GateStatus, 'incomplete'> | 'incomplete',
    opts?: { waivedBy?: string; waiveReason?: string; missing?: string[] },
  ): void {
    const now = this.now()
    if (result === 'waived') {
      if (!opts?.waivedBy || !opts?.waiveReason) {
        // 缺一即 incomplete（§4.7.3：缺任一字段 → 拒绝为 waived）
        this.db
          .prepare("UPDATE work_items SET gate_status = 'incomplete', gate_missing_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(['waived_requires_waived_by_and_reason']), now, id)
        throw new WorkItemGuardError('waived 需要 gate_waived_by 与 gate_waive_reason（缺一即 incomplete）')
      }
      this.db
        .prepare(
          `UPDATE work_items SET gate_status = 'waived', gate_waived_by = ?, gate_waived_at = ?,
             gate_waive_reason = ?, gate_missing_json = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(opts.waivedBy, Date.now(), opts.waiveReason, now, id)
      scheduleRecomputeForWorkItem(this.db, id)
      return
    }
    this.db
      .prepare('UPDATE work_items SET gate_status = ?, gate_missing_json = ?, gate_waived_by = NULL, gate_waived_at = NULL, gate_waive_reason = NULL, updated_at = ? WHERE id = ?')
      .run(result, result === 'incomplete' ? JSON.stringify(opts?.missing ?? []) : null, now, id)
    scheduleRecomputeForWorkItem(this.db, id)
  }

  // ---------------------------------------------------------
  // 状态迁移（条件更新,changes!==1 → CONFLICT）
  // ---------------------------------------------------------

  private transition(
    id: string,
    from: readonly WorkItemStatus[],
    to: WorkItemStatus,
    cancelReason: WorkItemCancelReason | null = null,
  ): WorkItemRow {
    const placeholders = from.map(() => '?').join(',')
    const result = this.db
      .prepare(
        `UPDATE work_items SET status = ?, cancel_reason = ?, updated_at = ?
          WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, cancelReason, this.now(), id, ...from)
    if (result.changes !== 1) {
      const current = this.get(id)?.status ?? '<missing>'
      throw new WorkItemConflictError(`work_item ${id}: ${current} → ${to} 不合法（条件更新未命中,CONFLICT）`)
    }
    const row = this.get(id)!
    logger.info(`work_item ${id}: → ${to}`)
    // 状态变化影响自身锚定节点与直接依赖者；schedule 在事务内排队，500ms 后执行。
    scheduleRecomputeForWorkItem(this.db, id)
    return row
  }

  /** draft → awaiting_confirm。守卫:至少 1 个 step。 */
  submitForConfirm(id: string): WorkItemRow {
    const item = this.get(id)
    if (!item) throw new WorkItemGuardError(`work_item ${id} 不存在`)
    const steps = this.listSteps(id, item.revision)
    if (steps.length === 0) {
      throw new WorkItemGuardError('提交确认前至少需要 1 个 step（§4.7.2）')
    }
    return this.transition(id, ['draft'], 'awaiting_confirm')
  }

  /** awaiting_confirm → queued。守卫:gate=pass 或（waived 且三字段齐）。 */
  confirm(id: string): WorkItemRow {
    const item = this.get(id)
    if (!item) throw new WorkItemGuardError(`work_item ${id} 不存在`)
    if (item.gate_status === 'incomplete') {
      throw new WorkItemGuardError('gate 未通过（gate_status=incomplete）,不得入队（§4.7.2）')
    }
    // 父/子 revision 一致性守卫（§4.7.2 确认通过）
    if (item.parent_work_item_id) {
      const parent = this.get(item.parent_work_item_id)
      if (!parent || parent.is_current !== 1) {
        throw new WorkItemGuardError('父 work_item 不存在或非当前 revision')
      }
    }
    // awaiting_confirm → queued，并在同事务内激活步（§4.7.4 第 1 行：planning → pending）。
    // 否则确认后的任务没有任何可被调度器 claim 的步。
    const nowMs = Date.now()
    const txn = this.db.transaction((): WorkItemRow => {
      const row = this.transition(id, ['awaiting_confirm'], 'queued')
      new WorkStepService(this.db).activatePlanningSteps(id, row.revision, nowMs)
      return row
    })
    return txn()
  }

  /** queued → running（调度器 claim）。 */
  claim(id: string): WorkItemRow {
    return this.transition(id, ['queued'], 'running')
  }

  /** queued → blocked（门禁失效/依赖失败）。gate 置 incomplete,解除前必须重跑。 */
  markBlocked(id: string, missing: string[]): WorkItemRow {
    this.db
      .prepare("UPDATE work_items SET gate_status = 'incomplete', gate_missing_json = ? WHERE id = ?")
      .run(JSON.stringify(missing), id)
    return this.transition(id, ['queued'], 'blocked')
  }

  /** blocked → queued。守卫:必须先重跑 gate（不信任旧结果,§4.7.2）。 */
  unblock(id: string): WorkItemRow {
    const item = this.get(id)
    if (!item) throw new WorkItemGuardError(`work_item ${id} 不存在`)
    if (item.gate_status === 'incomplete') {
      throw new WorkItemGuardError('blocked → queued 前必须重跑 gate 并通过（不信任旧结果,§4.7.2）')
    }
    return this.transition(id, ['blocked'], 'queued')
  }

  /** running → done（全部叶子成功;L1 人工单任务由人工/执行器确认）。 */
  complete(id: string): WorkItemRow {
    return this.transition(id, ['running'], 'done')
  }

  /** running → failed（≥1 叶子失败且全部叶子终态）。 */
  fail(id: string): WorkItemRow {
    return this.transition(id, ['running'], 'failed')
  }

  /**
   * 父任务终态聚合（§5.5.1 / §4.7.2 行 923-924）。
   *
   * 只在**当前 revision 的所有步都进入终态**时收敛；返回 undefined 表示"还该等"
   * （存在 pending/running/waiting_approval/planning/review/needs_input/paused 等非终态步），
   * 或者并发下已被别人收敛/置终态。规则：
   * - ≥1 failed/timed_out → failed（优先级最高，混合 succeeded+cancelled 也落 failed）
   * - 无失败且有 cancelled → cancelled
   * - 全部 succeeded/skipped → done
   *
   * v34：收敛为 cancelled 时写 `cancel_reason='partial_cancel'`（无失败、至少一步被
   * 取消），与人工 cancel() 写入的 `user` 区分；失败/完成路径写 NULL。
   */
  convergeIfTerminal(id: string): WorkItemRow | undefined {
    const item = this.get(id)
    if (!item || item.is_current !== 1) return undefined
    if (item.status !== 'queued' && item.status !== 'running') return undefined
    const steps = this.listSteps(id, item.revision)
    // 零步任务无法证明"完成"：保持等待，不伪造 done。
    if (steps.length === 0) return undefined
    if (steps.some((s) => !isTerminalStepStatus(s.status))) return undefined

    const hasFailure = steps.some((s) => s.status === 'failed' || s.status === 'timed_out')
    const hasCancelled = steps.some((s) => s.status === 'cancelled')
    const target: WorkItemStatus = hasFailure ? 'failed' : hasCancelled ? 'cancelled' : 'done'
    // target=cancelled 当且仅当「无失败且有取消」——即 §5.5.1 的 partial_cancel。
    const cancelReason: WorkItemCancelReason | null = target === 'cancelled' ? 'partial_cancel' : null

    const result = this.db
      .prepare(
        `UPDATE work_items SET status = ?, cancel_reason = ?, updated_at = ?
          WHERE id = ? AND is_current = 1 AND status IN ('queued','running')`,
      )
      .run(target, cancelReason, this.now(), id)
    if (result.changes !== 1) return undefined

    if (hasFailure && hasCancelled) {
      logger.info(`work_item ${id}: 混合失败与取消 → failed（§5.5.1 失败优先）`)
    } else if (hasCancelled) {
      logger.info(`work_item ${id}: 部分取消 → cancelled（cancel_reason=partial_cancel）`)
    }
    logger.info(`work_item ${id}: 全部步终态 → ${target}`)
    scheduleRecomputeForWorkItem(this.db, id)
    return this.get(id)
  }

  /** running → needs_input（写 work_steps.input_request_json 同事务,§4.7.2）。 */
  needsInput(id: string, stepId: string, requestJson: string): WorkItemRow {
    const txn = this.db.transaction((): WorkItemRow => {
      const row = this.transition(id, ['running'], 'needs_input')
      const result = this.db
        .prepare('UPDATE work_steps SET input_request_json = ?, status = ? WHERE id = ? AND status = ?')
        .run(requestJson, 'needs_input', stepId, 'running')
      if (result.changes !== 1) {
        throw new WorkItemConflictError(`step ${stepId}: needs_input 写入未命中`)
      }
      return row
    })
    return txn()
  }

  /** needs_input → queued（回答提交,新 attempt）。 */
  answerNeedsInput(id: string): WorkItemRow {
    return this.transition(id, ['needs_input'], 'queued')
  }

  /** running → needs_human。 */
  needsHuman(id: string): WorkItemRow {
    return this.transition(id, ['running'], 'needs_human')
  }

  /** needs_human → queued / cancelled（审批记录先落库由审批层负责）。 */
  resolveHuman(id: string, decision: 'release' | 'cancel'): WorkItemRow {
    return decision === 'release'
      ? this.transition(id, ['needs_human'], 'queued')
      : this.transition(id, ['needs_human'], 'cancelled', 'user')
  }

  /** running → paused（基础设施暂停;原因由调用方事件/日志承载,§4.7.2）。 */
  pause(id: string): WorkItemRow {
    return this.transition(id, ['running'], 'paused')
  }

  /** 只由启动对账写（§4.7.2）。 */
  markInterrupted(id: string): WorkItemRow {
    return this.transition(id, ['running'], 'interrupted')
  }

  /** paused/interrupted → queued（恢复;不自动续跑旧 attempt）。 */
  resume(id: string): WorkItemRow {
    return this.transition(id, ['paused', 'interrupted'], 'queued')
  }

  /**
   * 用户取消（任一非终态）。守卫:draft/awaiting_confirm 须无 running run
   * （由调用方先核;queued+ 状态由本条件更新覆盖）。
   */
  cancel(id: string): WorkItemRow {
    const item = this.get(id)
    if (!item) throw new WorkItemGuardError(`work_item ${id} 不存在`)
    if (item.status === 'draft' || item.status === 'awaiting_confirm') {
      const running = this.db
        .prepare("SELECT COUNT(*) AS c FROM work_runs WHERE work_item_id = ? AND status = 'running'")
        .get(id) as { c: number }
      if (running.c > 0) {
        throw new WorkItemGuardError('存在 running run,取消被拒（§4.7.2 取消守卫）')
      }
    }
    return this.transition(id, [...CANCELLABLE, 'draft', 'awaiting_confirm', 'blocked'], 'cancelled', 'user')
  }

  // ---------------------------------------------------------
  // revision 修订（§4.7.3）
  // ---------------------------------------------------------

  /**
   * 修订：校验旧 revision 无 running run → 旧行 is_current=0 + superseded →
   * 新行 revision+1（supersedes_id 指向旧行）→ 复制 steps（status='pending',
   * 清 invocation_id/deadline_at）。同一事务;并发修订由 ux_work_items_current
   * 唯一索引兜底（第二个 is_current=1 插入即失败回滚）。
   */
  revise(
    id: string,
    changes: Partial<Pick<WorkItemRow, 'title' | 'goal' | 'scope_files' | 'acceptance_json' | 'verification_hint' | 'depends_on_json'>> & {
      steps?: NonNullable<CreateWorkItemInput['steps']>
    },
  ): WorkItemRow {
    const now = this.now()
    const nowMs = Date.now()
    const txn = this.db.transaction((): WorkItemRow => {
      const old = this.get(id)
      if (!old) throw new WorkItemGuardError(`work_item ${id} 不存在`)
      if (old.is_current !== 1) throw new WorkItemGuardError('只能修订当前 revision')
      const running = this.db
        .prepare("SELECT COUNT(*) AS c FROM work_runs WHERE work_item_id = ? AND status = 'running'")
        .get(id) as { c: number }
      if (running.c > 0) {
        throw new WorkItemGuardError('旧 revision 存在 running run,修订被拒（§4.7.3）')
      }
      // 旧行退位（条件更新防竞态双修订）
      const demote = this.db
        .prepare("UPDATE work_items SET is_current = 0, status = 'superseded', updated_at = ? WHERE id = ? AND is_current = 1")
        .run(now, id)
      if (demote.changes !== 1) {
        throw new WorkItemConflictError('并发修订冲突（旧行已被其他修订退位）')
      }
      const newId = `wi_${nowMs}_${randomUUID().slice(0, 8)}`
      this.db
        .prepare(
          `INSERT INTO work_items (
             id, lineage_id, revision, supersedes_id, is_current, project_path, graph_id,
             anchor_entity_key, anchor_node_id, parent_work_item_id, depth,
             title, goal, scope_files, out_of_scope_files, acceptance_json, verification_hint,
             gate_status, depends_on_json, origin, plan_id, candidate_id, created_by, created_at, updated_at
           ) SELECT ?, lineage_id, revision + 1, ?, 1, project_path, graph_id,
             anchor_entity_key, anchor_node_id, parent_work_item_id, depth,
             ?, ?, scope_files, out_of_scope_files, acceptance_json, verification_hint,
             'incomplete', depends_on_json, origin, plan_id, candidate_id, created_by, ?, ?
           FROM work_items WHERE id = ?`,
        )
        .run(
          newId, old.id,
          changes.title?.trim() ?? old.title,
          changes.goal !== undefined ? changes.goal : old.goal,
          now, now, id,
        )
      if (changes.scope_files !== undefined) {
        this.db.prepare('UPDATE work_items SET scope_files = ? WHERE id = ?').run(JSON.stringify(changes.scope_files), newId)
      }
      if (changes.acceptance_json !== undefined) {
        this.db.prepare('UPDATE work_items SET acceptance_json = ? WHERE id = ?').run(changes.acceptance_json, newId)
      }
      if (changes.verification_hint !== undefined) {
        this.db.prepare('UPDATE work_items SET verification_hint = ? WHERE id = ?').run(changes.verification_hint, newId)
      }
      if (changes.depends_on_json !== undefined) {
        this.db.prepare('UPDATE work_items SET depends_on_json = ? WHERE id = ?').run(changes.depends_on_json, newId)
      }
      // 复制 steps（pending,清 invocation_id/deadline_at）;显式给出 steps 则整体替换
      if (changes.steps) {
        this.insertSteps(newId, old.revision + 1, changes.steps, nowMs)
      } else {
        const oldSteps = this.listSteps(id, old.revision)
        const stmt = this.db.prepare(
          `INSERT INTO work_steps (
             id, work_item_id, work_item_revision, seq, title, step_kind, scope_files_json,
             depends_on_step_ids_json, output_schema_json, consults_json, checker_work_item_id,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        for (const s of oldSteps) {
          stmt.run(
            `ws_${nowMs}_${randomUUID().slice(0, 8)}`, newId, old.revision + 1, s.seq,
            s.title, s.step_kind, s.scope_files_json,
            s.depends_on_step_ids_json, s.output_schema_json, s.consults_json, s.checker_work_item_id,
            nowMs, nowMs,
          )
        }
      }
      return this.get(newId)!
    })
    const row = txn()
    // 当前 revision 切换：旧行 superseded、新行 draft；按新行触发锚定节点重算。
    scheduleRecomputeForWorkItem(this.db, row.id)
    return row
  }
}
