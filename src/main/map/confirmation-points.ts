/**
 * C1–C4 人工确认点契约（G2-10，蓝图 II-12 / §5.6）。
 *
 * 三条已定口径（I.4 的 D-18/D-19/D-20，均为对 D-13 的补充）：
 * - 确认点只在 `test` / `human` 步上做；`agent` 步不设计划期确认点，继续依赖
 *   运行时逐工具审批（`classifyToolRisk`）。不给步新增「不可逆」声明字段——
 *   计划期不存在该信息，硬造只会得到大量 unknown 并 fail-closed。
 * - `risk_level` 只有两档（low/high），高风险线**直接复用 G4 的 20 文件 / 800 行**，
 *   不引入三档量表、不加新枚举值。
 * - 确认事实落 `acceptance_confirmations`：`entry_id` 记确认点（C1–C4），
 *   `decision_note` 记 JSON 决策；不新建表、不做 v50。
 *
 * 本模块只做纯函数：不读库、不落库、不弹 UI。判定结果供 `StepConfirmationService`
 * 与 renderer（G8-3）只读消费；渲染层不得复算风险等级。
 */

import { G4_HIGH_RISK_FILES, G4_HIGH_RISK_LINES } from './gate-engine'
import type { WorkStepStatus } from './work-step-service'

export type ConfirmationPoint = 'C1' | 'C2' | 'C3' | 'C4'

/** 步级确认点（只覆盖 test/human；agent 返回 null）。 */
export type StepConfirmationPoint = Extract<ConfirmationPoint, 'C3' | 'C4'>

export interface ConfirmationPointSpec {
  point: ConfirmationPoint
  title: string
  /** 触发条件（写给人和 UI 看，不参与判定）。 */
  trigger: string
  /** 拒绝后落到哪个现有状态；不新造状态。 */
  rejectPath: string
  /** 服务层必填展示项：缺任意一项即拒绝确认。 */
  requiredDisplay: readonly string[]
}

/**
 * 四类确认点的唯一契约表。
 * 展示项取 §5.6 的展示列的键名，具体文案由 renderer（G8-3）负责。
 */
export const CONFIRMATION_POINTS: Readonly<Record<ConfirmationPoint, ConfirmationPointSpec>> = {
  C1: {
    point: 'C1',
    title: '计划批准',
    trigger: '计划草稿 confirm 前——一旦确认即生成 work_items，不可原地回退',
    rejectPath: 'plan_drafts.status=rejected；不生成 work_items（不进入步状态机）',
    requiredDisplay: [
      'subtasks',
      'scopeFiles',
      'acceptance',
      'dependencies',
      'candidateScore',
      'gateMissing',
      'excludedItems',
      'anchorStates',
    ],
  },
  C2: {
    point: 'C2',
    title: '执行中修订',
    trigger: 'workitem:revise 生成新 revision 前——旧 revision 将被置 superseded',
    rejectPath: '不创建新 revision；旧 revision 保持 is_current=1，继续按原计划执行',
    requiredDisplay: ['diff', 'impact', 'reason', 'gateResult'],
  },
  C3: {
    point: 'C3',
    title: '测试计划批准',
    trigger: 'test 步 pending 且写域达到 G4 高风险线（20 文件 / 800 行）',
    rejectPath: 'step waiting_approval → cancelled（与 test_plans denied 同向，不执行）',
    requiredDisplay: ['commands', 'worktree', 'affectedFiles', 'policies', 'planHash', 'durationLimit'],
  },
  C4: {
    point: 'C4',
    title: '完成认定',
    trigger: 'human 步 pending 且写域达到 G4 高风险线（20 文件 / 800 行）',
    rejectPath: 'step waiting_approval → pending（返工，不消耗 attempt；补充后再提交）',
    requiredDisplay: [
      'executionState',
      'evidence',
      'staleEvidence',
      'unmetAcceptance',
      'suggestions',
      'statusDiff',
    ],
  },
}

export class ConfirmationDisplayError extends Error {
  readonly code = 'CONFIRMATION_DISPLAY_MISSING'
  constructor(
    readonly point: ConfirmationPoint,
    readonly missing: readonly string[],
  ) {
    super(`确认点 ${point} 缺少必填展示项：${missing.join(', ')}`)
    this.name = 'ConfirmationDisplayError'
  }
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  // boolean / number / object 视为已展示（false、0 都是合法展示结果）。
  return true
}

/** 服务层必填展示项校验：缺项即拒绝确认，不允许「什么都没看就点确认」。 */
export function assertConfirmationDisplay(
  point: ConfirmationPoint,
  display: Record<string, unknown> | null | undefined,
): void {
  const spec = CONFIRMATION_POINTS[point]
  const missing = spec.requiredDisplay.filter((key) => !isPresent(display?.[key]))
  if (missing.length > 0) throw new ConfirmationDisplayError(point, missing)
}

/** 风险两档；G2-10 不引入第三档。 */
export type StepRiskLevel = 'low' | 'high'

export interface StepRiskAssessment {
  level: StepRiskLevel
  /** 参与判定的写域文件数（步缺省回退到任务 scope）。 */
  files: number
  /** G4 行数代理；null = 不可预估（按文件数判定，不 fail-closed 到 high）。 */
  estimatedLines: number | null
  /** 可读原因（UI 直接展示，不由渲染层复算）。 */
  reasons: string[]
}

export interface StepRiskInput {
  scopeFiles: readonly string[]
  estimatedLines: number | null
}

/**
 * 步风险判定：只用 G4 的两条线（≥20 文件 或 ≥800 行）判 high。
 * `estimatedLines === null` 时只按文件数判定——行数不可预估不等于高风险，
 * 也不等于低风险；原因文本会显式写出这一限制。
 */
export function deriveStepRisk(input: StepRiskInput): StepRiskAssessment {
  const files = input.scopeFiles.length
  const estimatedLines = input.estimatedLines
  const reasons: string[] = []
  let high = false

  if (files >= G4_HIGH_RISK_FILES) {
    high = true
    reasons.push(`写域 ${files} 个文件，达到 G4 高风险线 ${G4_HIGH_RISK_FILES}`)
  } else {
    reasons.push(`写域 ${files} 个文件，未达 G4 高风险线 ${G4_HIGH_RISK_FILES}`)
  }

  if (estimatedLines === null) {
    reasons.push('预估行数不可用（按文件数判定）')
  } else if (estimatedLines >= G4_HIGH_RISK_LINES) {
    high = true
    reasons.push(`预估 ${estimatedLines} 行，达到 G4 高风险线 ${G4_HIGH_RISK_LINES}`)
  } else {
    reasons.push(`预估 ${estimatedLines} 行，未达 G4 高风险线 ${G4_HIGH_RISK_LINES}`)
  }

  return { level: high ? 'high' : 'low', files, estimatedLines, reasons }
}

/**
 * 步级确认点分类：test → C3，human → C4，agent → null。
 * 与 D-18 一致：agent 步的计划期确认点不存在，控制在 runtime 逐工具审批。
 */
export function classifyStepConfirmation(stepKind: string): StepConfirmationPoint | null {
  if (stepKind === 'test') return 'C3'
  if (stepKind === 'human') return 'C4'
  return null
}

/** 步级确认的 input_request_json 契约（复用现有列，不新增字段）。 */
export interface StepConfirmationInputRequest {
  kind: 'step_confirmation'
  point: StepConfirmationPoint
  risk: StepRiskLevel
  reasons: string[]
  required_display: readonly string[]
  requested_at: number
}

export function serializeStepConfirmationRequest(
  point: StepConfirmationPoint,
  risk: StepRiskAssessment,
  requestedAt: number,
): string {
  const payload: StepConfirmationInputRequest = {
    kind: 'step_confirmation',
    point,
    risk: risk.level,
    reasons: risk.reasons,
    required_display: CONFIRMATION_POINTS[point].requiredDisplay,
    requested_at: requestedAt,
  }
  return JSON.stringify(payload)
}

/** 从 input_request_json 解析（未知/旧格式返回 null，调用方按普通 needs_input 处理）。 */
export function parseStepConfirmationRequest(json: string | null): StepConfirmationInputRequest | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<StepConfirmationInputRequest> | null
    if (!parsed || parsed.kind !== 'step_confirmation') return null
    if (parsed.point !== 'C3' && parsed.point !== 'C4') return null
    return {
      kind: 'step_confirmation',
      point: parsed.point,
      risk: parsed.risk === 'high' ? 'high' : 'low',
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter((r): r is string => typeof r === 'string') : [],
      required_display: Array.isArray(parsed.required_display)
        ? parsed.required_display.filter((r): r is string => typeof r === 'string')
        : CONFIRMATION_POINTS[parsed.point].requiredDisplay,
      requested_at: typeof parsed.requested_at === 'number' ? parsed.requested_at : 0,
    }
  } catch {
    return null
  }
}

/** 只读视图里暴露的步状态（与 12 值状态机一致）。 */
export type ConfirmationStepStatus = WorkStepStatus
