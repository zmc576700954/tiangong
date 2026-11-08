/**
 * manual 验收人工确认入口（2026-11-08，接续 D2 最小闭环）。
 *
 * 职责：
 * - 接收 step（或 item 下的等待步）+ 待确认条目 id；
 * - 把「谁在何时确认了哪些条目」写入独立的 `acceptance_confirmations`（v35）；
 *   `agent_approvals` 只承载工具调用审批，不再混入人工验收事实（`9852b77` 做法已废止）；
 * - 确认后重算确定性验收：仍有非 manual 失败 → verify_fail；仍有未确认 manual → 继续等待；
 *   全部通过 → 步/任务终态收敛。
 *
 * 与蓝图 §4.7.4 的差异（显式记录）：manual 确认不新开 attempt、不重跑 agent；
 * 原 turn 已完成，确认只重算验收并直接收口。原因见文档 §M5.11。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import {
  evaluateAcceptance,
  type AcceptancePendingItem,
  type AcceptanceVerdict,
} from './acceptance-executor'
import { WorkItemService, type WorkItemRow, type WorkItemStatus, type WorkStepRow } from './work-item-service'
import { WorkStepService, type WorkStepStatus } from './work-step-service'

/** input_request_json 的契约形状（kind + 待确认条目）。 */
export interface AcceptanceInputRequest {
  kind: 'acceptance_manual_confirm'
  work_item_id: string
  step_id: string
  requested_at: number
  entries: AcceptancePendingItem[]
}

export type AcceptanceConfirmationErrorCode =
  | 'CONFIRM_INPUT_REQUIRED'
  | 'ITEM_NOT_FOUND'
  | 'STEP_NOT_FOUND'
  | 'STEP_NOT_WAITING'
  | 'STEP_AMBIGUOUS'
  | 'ENTRY_NOT_PENDING'
  | 'STEP_STATE_CHANGED'
  | 'ACCEPTANCE_RECHECK_FAILED'

export class AcceptanceConfirmationError extends Error {
  constructor(
    readonly code: AcceptanceConfirmationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AcceptanceConfirmationError'
  }
}

export interface ConfirmAcceptanceInput {
  /** 等待步 id；与 workItemId 至少给一个。 */
  stepId?: string
  /** 任务 id；只给 item 时按待确认条目匹配唯一等待步。 */
  workItemId?: string
  /** 本次确认的条目 id（允许部分确认）。 */
  entryIds: string[]
  note?: string
  /** 操作者标识（当前没有账号体系，默认 user）。 */
  confirmedBy?: string
}

export interface ConfirmAcceptanceResult {
  stepId: string
  workItemId: string
  stepStatus: WorkStepStatus
  itemStatus: WorkItemStatus
  /** 仍待确认的条目（空数组表示已收口）。 */
  remainingEntryIds: string[]
  /** 本次确认事实批次 id（acceptance_confirmations.batch_id）。 */
  confirmationBatchId: string
  /** 本次实际写入的确认事实行 id（每个条目一行）。 */
  confirmationIds: string[]
  lineageId: string
  revision: number
}

function parseRequest(json: string | null): AcceptanceInputRequest | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<AcceptanceInputRequest> | null
    if (!parsed || parsed.kind !== 'acceptance_manual_confirm' || !Array.isArray(parsed.entries)) {
      return null
    }
    const entries = parsed.entries.filter(
      (entry): entry is AcceptancePendingItem =>
        !!entry && typeof entry.id === 'string' && entry.id.trim() !== '' && typeof entry.expected === 'string',
    )
    if (entries.length === 0) return null
    return {
      kind: 'acceptance_manual_confirm',
      work_item_id: typeof parsed.work_item_id === 'string' ? parsed.work_item_id : '',
      step_id: typeof parsed.step_id === 'string' ? parsed.step_id : '',
      requested_at: typeof parsed.requested_at === 'number' ? parsed.requested_at : 0,
      entries,
    }
  } catch {
    return null
  }
}

function serializeRequest(base: AcceptanceInputRequest, entries: AcceptancePendingItem[]): string {
  return JSON.stringify({ ...base, entries })
}

export class AcceptanceConfirmationService {
  private readonly items: WorkItemService
  private readonly steps: WorkStepService

  constructor(private readonly db: BetterSqlite3.Database) {
    this.items = new WorkItemService(db)
    this.steps = new WorkStepService(db)
  }

  async confirm(input: ConfirmAcceptanceInput): Promise<ConfirmAcceptanceResult> {
    const entryIds = [...new Set((input.entryIds ?? []).filter((id) => typeof id === 'string' && id.trim() !== ''))]
    if (entryIds.length === 0) {
      throw new AcceptanceConfirmationError('CONFIRM_INPUT_REQUIRED', 'entryIds 不能为空')
    }
    if (!input.stepId && !input.workItemId) {
      throw new AcceptanceConfirmationError('CONFIRM_INPUT_REQUIRED', 'stepId 或 workItemId 必填')
    }

    const step = this.resolveStep(input, entryIds)
    const item = this.items.get(step.work_item_id)
    if (!item) {
      throw new AcceptanceConfirmationError('ITEM_NOT_FOUND', `work_item ${step.work_item_id} 不存在`)
    }
    const request = parseRequest(step.input_request_json)
    if (!request) {
      throw new AcceptanceConfirmationError(
        'STEP_NOT_WAITING',
        `step ${step.id} 不是 manual 验收等待态（input_request_json=${step.input_request_json ?? 'NULL'}）`,
      )
    }
    const pendingIds = new Set(request.entries.map((entry) => entry.id))
    const unknown = entryIds.filter((id) => !pendingIds.has(id))
    if (unknown.length > 0) {
      throw new AcceptanceConfirmationError(
        'ENTRY_NOT_PENDING',
        `条目 ${unknown.join(',')} 不在 step ${step.id} 的待确认列表`,
      )
    }

    // 历史已确认条目（部分确认可能发生多次）。
    const previouslyConfirmed = this.listConfirmedEntryIds(step.id)
    const confirmedIds = [...new Set([...previouslyConfirmed, ...entryIds])]

    const verdict = await evaluateAcceptance({
      acceptanceJson: item.acceptance_json,
      projectPath: item.project_path,
      confirmedManualEntryIds: confirmedIds,
    })

    const decidedAt = Date.now()
    const decidedBy = input.confirmedBy ?? 'user'
    const note = input.note?.trim() ? input.note.trim() : null

    const txn = this.db.transaction((): ConfirmAcceptanceResult => {
      // 并发守卫：确认期间 input_request_json 被其他确认改过，则不覆盖，要求调用方重试。
      const current = this.steps.get(step.id)
      if (!current || current.status !== 'needs_input' || current.input_request_json !== step.input_request_json) {
        throw new AcceptanceConfirmationError(
          'STEP_STATE_CHANGED',
          `step ${step.id} 已变更（当前 ${current?.status ?? 'missing'}），请刷新后重试`,
        )
      }

      const batchId = `acb_${Date.now()}_${randomUUID().slice(0, 8)}`
      const confirmationIds = this.insertConfirmations({
        batchId,
        workItemId: item.id,
        stepId: step.id,
        entryIds,
        decidedBy,
        decidedAt,
        note,
      })

      const settled = this.applyVerdict(item, step, request, verdict)
      const finalItem = this.items.get(item.id)!
      return {
        stepId: step.id,
        workItemId: item.id,
        stepStatus: settled.stepStatus,
        itemStatus: finalItem.status,
        remainingEntryIds: settled.remainingEntryIds,
        confirmationBatchId: batchId,
        confirmationIds,
        lineageId: finalItem.lineage_id,
        revision: finalItem.revision,
      }
    })
    return txn()
  }

  /** 写入确认事实（每条目一行，batch_id 分组）；重复条目按唯一索引幂等。 */
  private insertConfirmations(input: {
    batchId: string
    workItemId: string
    stepId: string
    entryIds: string[]
    decidedBy: string
    decidedAt: number
    note: string | null
  }): string[] {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO acceptance_confirmations
         (id, batch_id, work_item_id, step_id, entry_id, decided_by, decided_at,
          decision_note, source, legacy_approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', NULL, ?)`,
    )
    const ids: string[] = []
    for (const entryId of input.entryIds) {
      const id = `ac_${Date.now()}_${randomUUID().slice(0, 8)}`
      const result = stmt.run(
        id,
        input.batchId,
        input.workItemId,
        input.stepId,
        entryId,
        input.decidedBy,
        input.decidedAt,
        input.note,
        input.decidedAt,
      )
      if (result.changes > 0) ids.push(id)
    }
    return ids
  }

  private resolveStep(input: ConfirmAcceptanceInput, entryIds: string[]): WorkStepRow {
    if (input.stepId) {
      const step = this.steps.get(input.stepId)
      if (!step) throw new AcceptanceConfirmationError('STEP_NOT_FOUND', `work_step ${input.stepId} 不存在`)
      if (input.workItemId && step.work_item_id !== input.workItemId) {
        throw new AcceptanceConfirmationError(
          'STEP_NOT_FOUND',
          `work_step ${input.stepId} 不属于 work_item ${input.workItemId}`,
        )
      }
      if (step.status !== 'needs_input') {
        throw new AcceptanceConfirmationError(
          'STEP_NOT_WAITING',
          `work_step ${step.id} 当前 ${step.status}，不在等待确认`,
        )
      }
      return step
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM work_steps
          WHERE work_item_id = ? AND status = 'needs_input'
          ORDER BY seq ASC`,
      )
      .all(input.workItemId) as WorkStepRow[]
    const matches = rows.filter((row) => {
      const request = parseRequest(row.input_request_json)
      return request !== null && request.entries.some((entry) => entryIds.includes(entry.id))
    })
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) {
      throw new AcceptanceConfirmationError(
        'STEP_NOT_WAITING',
        `work_item ${input.workItemId} 没有包含条目 ${entryIds.join(',')} 的等待步`,
      )
    }
    throw new AcceptanceConfirmationError(
      'STEP_AMBIGUOUS',
      `work_item ${input.workItemId} 有多个等待步匹配，请显式传 stepId`,
    )
  }

  private listConfirmedEntryIds(stepId: string): string[] {
    const rows = this.db
      .prepare('SELECT entry_id FROM acceptance_confirmations WHERE step_id = ?')
      .all(stepId) as Array<{ entry_id: string }>
    return [...new Set(rows.map((row) => row.entry_id).filter((id) => id.trim() !== ''))]
  }

  /**
   * 按重算结果收口：
   * - 硬失败：item needs_input → queued，step → failed(verify_fail)，再收敛 item；
   * - 仍有未确认 manual：只更新 input_request_json，item/step 保持 needs_input；
   * - 全部通过：item needs_input → queued，step → succeeded，再收敛 item。
   */
  private applyVerdict(
    item: WorkItemRow,
    step: WorkStepRow,
    request: AcceptanceInputRequest,
    verdict: AcceptanceVerdict,
  ): { stepStatus: WorkStepStatus; remainingEntryIds: string[] } {
    if (verdict.missing.length > 0) {
      this.items.answerNeedsInput(item.id)
      this.steps.settleNeedsInput(step.id, { status: 'failed', failureClass: 'verify_fail' })
      this.items.convergeIfTerminal(item.id)
      return { stepStatus: 'failed', remainingEntryIds: [] }
    }
    if (verdict.pendingItems.length > 0) {
      const remaining = verdict.pendingItems
      this.steps.updateInputRequest(step.id, serializeRequest(request, remaining))
      return { stepStatus: 'needs_input', remainingEntryIds: remaining.map((entry) => entry.id) }
    }
    this.items.answerNeedsInput(item.id)
    this.steps.settleNeedsInput(step.id, { status: 'succeeded' })
    this.items.convergeIfTerminal(item.id)
    return { stepStatus: 'succeeded', remainingEntryIds: [] }
  }
}
