/**
 * G2-10 步级确认闸（C3/C4）与确认事实读写。
 *
 * 口径（I.4 D-18/D-19/D-20）：
 * - 只对 `test` / `human` 步建闸；`agent` 步返回 null，继续走 runtime 逐工具审批。
 * - 风险两档，唯一 high 线是 G4 的 20 文件 / 800 行。
 * - 通过决策落 `acceptance_confirmations`（entry_id = 确认点）；驳回不写该表——
 *   表语义是「已确认」，且 `(work_item_id, step_id, entry_id)` 唯一索引会占掉后续
 *   确认名额——驳回事实写回 `work_steps.input_request_json`（复用现有列）。
 * - 不新建表、不加列、不做 v50。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import {
  CONFIRMATION_POINTS,
  assertConfirmationDisplay,
  classifyStepConfirmation,
  deriveStepRisk,
  parseStepConfirmationRequest,
  serializeStepConfirmationRequest,
  type StepConfirmationInputRequest,
  type StepConfirmationPoint,
  type StepRiskAssessment,
  type StepRiskLevel,
} from './confirmation-points'
import { WorkItemService, type WorkItemRow } from './work-item-service'
import {
  WorkStepService,
  type WorkStepChangeEvent,
  type WorkStepStatus,
} from './work-step-service'

export type ConfirmationDecisionValue = 'approve' | 'reject'

export interface ConfirmationDecision {
  decision: ConfirmationDecisionValue
  decidedBy: string
  decidedAt: number
  note: string | null
  risk: StepRiskLevel
  reasons: string[]
}

export interface StepConfirmationView {
  stepId: string
  workItemId: string
  workItemRevision: number
  stepKind: string
  point: StepConfirmationPoint | null
  status: WorkStepStatus
  /** 高风险且尚无决策 = 需要确认。 */
  required: boolean
  /** 是否正停在确认闸上（waiting_approval）。 */
  waiting: boolean
  risk: StepRiskAssessment | null
  requiredDisplay: readonly string[]
  trigger: string | null
  rejectPath: string | null
  decision: ConfirmationDecision | null
  request: StepConfirmationInputRequest | null
}

export interface StepConfirmationDecideInput {
  stepId: string
  decision: ConfirmationDecisionValue
  /** 必填展示项的实际值；缺项即拒绝。 */
  display: Record<string, unknown>
  note?: string
  decidedBy?: string
}

export interface StepConfirmationOptions {
  onChanged?: (event: WorkStepChangeEvent) => void
  /** G4 行数代理；缺省 = 不可预估（只按文件数判定）。 */
  estimateLines?: (files: string[], projectPath: string | null) => number | null
}

export class StepConfirmationError extends Error {
  constructor(
    readonly code:
      | 'STEP_NOT_FOUND'
      | 'ITEM_NOT_FOUND'
      | 'NOT_STEP_CONFIRMATION'
      | 'STEP_NOT_WAITING'
      | 'ALREADY_DECIDED'
      | 'CONFIRMATION_DISPLAY_MISSING',
    message: string,
  ) {
    super(message)
    this.name = 'StepConfirmationError'
  }
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** 驳回事实的标记（复用 input_request_json，不新增列）。 */
interface RejectionMarker {
  decision: 'reject'
  decided_by: string
  decided_at: number
  note: string | null
  risk: StepRiskLevel
  reasons: string[]
}

export class StepConfirmationService {
  private readonly steps: WorkStepService
  private readonly items: WorkItemService

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly options: StepConfirmationOptions = {},
  ) {
    this.steps = new WorkStepService(db, { onChanged: options.onChanged })
    this.items = new WorkItemService(db)
  }

  /** 只读视图：渲染层（G8-3）唯一数据源，不得自行复算风险。 */
  inspect(stepId: string): StepConfirmationView | null {
    const step = this.steps.get(stepId)
    if (!step) return null
    const item = this.items.get(step.work_item_id)
    return this.buildView(
      {
        id: step.id,
        work_item_id: step.work_item_id,
        work_item_revision: step.work_item_revision,
        step_kind: step.step_kind,
        status: step.status,
        scope_files_json: step.scope_files_json,
        input_request_json: step.input_request_json,
        updated_at: step.updated_at,
      },
      item,
    )
  }

  listForItem(workItemId: string, revision: number): StepConfirmationView[] {
    const item = this.items.get(workItemId)
    if (!item) return []
    return this.steps.listByItem(workItemId, revision).map((step) => this.buildView(step, item))
  }

  /**
   * tick 前置：高风险 test/human 步在 pending 时进入确认闸。
   * 返回 true = 本次已把步挂到 waiting_approval（调用方应跳过执行）。
   */
  maybeGate(stepId: string): boolean {
    const step = this.steps.get(stepId)
    if (!step || step.status !== 'pending') return false
    const item = this.items.get(step.work_item_id)
    const view = this.buildView(step, item)
    if (!view.required || !view.point || !view.risk) return false
    this.steps.awaitApproval(
      stepId,
      serializeStepConfirmationRequest(view.point, view.risk, Date.now()),
    )
    return true
  }

  /**
   * 记录确认决策并推进步状态：
   * - approve → waiting_approval → pending；
   * - reject + C3 → waiting_approval → cancelled；
   * - reject + C4 → waiting_approval → pending（返工，不消耗 attempt）。
   */
  decide(input: StepConfirmationDecideInput): StepConfirmationView {
    const step = this.steps.get(input.stepId)
    if (!step) throw new StepConfirmationError('STEP_NOT_FOUND', `找不到步 ${input.stepId}`)
    const item = this.items.get(step.work_item_id)
    if (!item) throw new StepConfirmationError('ITEM_NOT_FOUND', `找不到任务 ${step.work_item_id}`)
    const point = classifyStepConfirmation(step.step_kind)
    if (!point) {
      throw new StepConfirmationError('NOT_STEP_CONFIRMATION', `agent 步不走计划期确认：${step.id}`)
    }
    if (step.status !== 'waiting_approval') {
      throw new StepConfirmationError(
        'STEP_NOT_WAITING',
        `步不在确认闸上（当前 ${step.status}），拒绝重复决策`,
      )
    }
    if (this.readApproval(step, point)) {
      throw new StepConfirmationError('ALREADY_DECIDED', `步 ${step.id} 的 ${point} 已决策`)
    }
    try {
      assertConfirmationDisplay(point, input.display)
    } catch (err) {
      const missing = (err as { missing?: readonly string[] }).missing ?? []
      throw new StepConfirmationError(
        'CONFIRMATION_DISPLAY_MISSING',
        `缺少必填展示项：${missing.join(', ')}`,
      )
    }

    const risk = this.assess(step, item)
    const decidedBy = input.decidedBy?.trim() || 'user'
    const decidedAt = Date.now()
    const note = input.note?.trim() || null

    if (input.decision === 'approve') {
      this.db
        .prepare(
          `INSERT INTO acceptance_confirmations
             (id, batch_id, work_item_id, step_id, entry_id, decided_by, decided_at,
              decision_note, source, legacy_approval_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', NULL, ?)`,
        )
        .run(
          `cf_${randomUUID()}`,
          `cfb_${randomUUID()}`,
          step.work_item_id,
          step.id,
          point,
          decidedBy,
          decidedAt,
          JSON.stringify({ decision: 'approve', point, risk: risk.level, reasons: risk.reasons, note }),
          decidedAt,
        )
      this.steps.returnToPending(step.id, null)
    } else {
      const marker: RejectionMarker = {
        decision: 'reject',
        decided_by: decidedBy,
        decided_at: decidedAt,
        note,
        risk: risk.level,
        reasons: risk.reasons,
      }
      const parsedRequest = parseStepConfirmationRequest(step.input_request_json)
      const payload = JSON.stringify({
        kind: 'step_confirmation',
        point,
        required_display: CONFIRMATION_POINTS[point].requiredDisplay,
        requested_at: parsedRequest?.requested_at ?? decidedAt,
        ...marker,
      })
      if (point === 'C3') {
        this.setInputRequest(step.id, payload)
        this.steps.cancel(step.id)
      } else {
        this.steps.returnToPending(step.id, payload)
      }
    }

    const view = this.inspect(step.id)
    if (!view) throw new StepConfirmationError('STEP_NOT_FOUND', `决策后找不到步 ${step.id}`)
    return view
  }

  private setInputRequest(stepId: string, json: string): void {
    this.db.prepare('UPDATE work_steps SET input_request_json = ? WHERE id = ?').run(json, stepId)
  }

  private buildView(
    step: {
      id: string
      work_item_id: string
      work_item_revision: number
      step_kind: string
      status: WorkStepStatus
      scope_files_json: string
      input_request_json: string | null
      updated_at: number
    },
    item: WorkItemRow | undefined,
  ): StepConfirmationView {
    const point = classifyStepConfirmation(step.step_kind)
    const request = parseStepConfirmationRequest(step.input_request_json)
    if (!point) {
      return {
        stepId: step.id,
        workItemId: step.work_item_id,
        workItemRevision: step.work_item_revision,
        stepKind: step.step_kind,
        point: null,
        status: step.status,
        required: false,
        waiting: false,
        risk: null,
        requiredDisplay: [],
        trigger: null,
        rejectPath: null,
        decision: null,
        request: null,
      }
    }

    const scopeFiles = this.resolveScopeFiles(step.scope_files_json, item)
    const risk = this.assessFromFiles(scopeFiles, item)
    const approval = this.readApproval(step, point)
    const rejection = readRejection(step.input_request_json)
    const decision = approval ?? rejection
    const spec = CONFIRMATION_POINTS[point]

    return {
      stepId: step.id,
      workItemId: step.work_item_id,
      workItemRevision: step.work_item_revision,
      stepKind: step.step_kind,
      point,
      status: step.status,
      required: risk.level === 'high' && !decision,
      waiting: step.status === 'waiting_approval',
      risk,
      requiredDisplay: spec.requiredDisplay,
      trigger: spec.trigger,
      rejectPath: spec.rejectPath,
      decision,
      request,
    }
  }

  private assess(
    step: { scope_files_json: string },
    item: WorkItemRow | undefined,
  ): StepRiskAssessment {
    return this.assessFromFiles(this.resolveScopeFiles(step.scope_files_json, item), item)
  }

  private assessFromFiles(scopeFiles: string[], item: WorkItemRow | undefined): StepRiskAssessment {
    const estimatedLines = this.options.estimateLines
      ? this.options.estimateLines(scopeFiles, item?.project_path ?? null)
      : null
    return deriveStepRisk({ scopeFiles, estimatedLines })
  }

  /** 步未声明写域时回退到任务 scope（计划期两者同源，回退可避免漏判）。 */
  private resolveScopeFiles(stepScopeJson: string, item: WorkItemRow | undefined): string[] {
    const own = parseStringArray(stepScopeJson)
    if (own.length > 0) return own
    return parseStringArray(item?.scope_files)
  }

  private readApproval(
    step: { work_item_id: string; id: string },
    point: StepConfirmationPoint,
  ): ConfirmationDecision | null {
    const row = this.db
      .prepare(
        `SELECT * FROM acceptance_confirmations
          WHERE work_item_id = ? AND step_id = ? AND entry_id = ?
          ORDER BY decided_at DESC, created_at DESC LIMIT 1`,
      )
      .get(step.work_item_id, step.id, point) as
      | { decided_by: string; decided_at: number; decision_note: string | null }
      | undefined
    if (!row) return null
    let parsed: {
      decision?: string
      note?: string | null
      risk?: string
      reasons?: string[]
    } = {}
    try {
      parsed = row.decision_note ? (JSON.parse(row.decision_note) as typeof parsed) : {}
    } catch {
      // 旧的人工确认行是纯文本备注，按 approve 处理。
    }
    return {
      decision: parsed.decision === 'reject' ? 'reject' : 'approve',
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      note: parsed.note ?? null,
      risk: parsed.risk === 'high' ? 'high' : 'low',
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    }
  }
}

function readRejection(json: string | null): ConfirmationDecision | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<RejectionMarker> & { kind?: string }
    if (parsed.decision !== 'reject') return null
    return {
      decision: 'reject',
      decidedBy: typeof parsed.decided_by === 'string' ? parsed.decided_by : 'user',
      decidedAt: typeof parsed.decided_at === 'number' ? parsed.decided_at : 0,
      note: typeof parsed.note === 'string' ? parsed.note : null,
      risk: parsed.risk === 'high' ? 'high' : 'low',
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    }
  } catch {
    return null
  }
}
