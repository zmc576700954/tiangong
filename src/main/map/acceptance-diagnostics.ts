/**
 * 验收评估的逐条诊断落库（2026-11-08，接续 gate 逐道诊断 D12 的做法）。
 *
 * 载体复用既有报告表 `map_migration_reports`（不为诊断新增表）：
 * - kind='integrity_check'：验收与 gate 同属准入完整性判定；
 * - stage='acceptance_eval:<stepId>'：按步骤分组，启动预检只关心 failed/running/partial，
 *   本模块只写 status='ok'，因此不影响任何迁移/preflight 结论；
 * - stats_json：判定来源（turn 完成 / 人工确认重算 / 评估器异常）、结论、缺失/待确认数量、
 *   已判定条目数、耗时；
 * - details_json：逐条结果（type/id/outcome/codes）、缺失码、待确认码与条目明细。
 *
 * 边界：执行器保持只读纯函数；落库只发生在调用处。纯诊断，不写
 * work_items/work_steps/work_runs/node_evidence，写失败只告警、绝不阻断验收收口。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import type { AcceptanceVerdict } from './acceptance-executor'

const logger = createLogger('AcceptanceDiagnostics')

export const ACCEPTANCE_EVAL_KIND = 'integrity_check' as const
export const ACCEPTANCE_EVAL_STAGE_PREFIX = 'acceptance_eval:'
export const ACCEPTANCE_EVALUATOR_VERSION = 'acceptance-executor@1'

/** 报告行 id 的进程内单调计数：同毫秒多次评估保证排序稳定。 */
let reportIdSeq = 0

/** 判定来源：turn 自然完成后的验收 / 人工确认后的重算 / 评估器异常。 */
export type AcceptanceEvaluationSource = 'turn_completed' | 'manual_confirmation' | 'verifier_error'

export interface AcceptanceEvaluationRecordInput {
  workItemId: string
  stepId: string
  source: AcceptanceEvaluationSource
  durationMs: number
  /** 评估器异常时为空（没有逐条结果），只记录 error 原文。 */
  verdict?: AcceptanceVerdict
  /** 人工确认重算时本次已确认的条目 id（仅记录，便于对照）。 */
  confirmedEntryIds?: string[]
  verifierError?: string
}

export interface AcceptanceEvaluationRecord {
  workItemId: string
  stepId: string
  source: AcceptanceEvaluationSource
  verdict: 'pass' | 'incomplete' | 'pending' | 'error'
  missing: string[]
  pending: string[]
  /** 可选条目（required:false）的失败/待确认码：不阻塞，仅展示。 */
  optionalFailures: string[]
  durationMs: number
}

/** 结论归一：待人工确认优先于 incomplete；执行器异常单独成档。 */
export function verdictOf(verdict: AcceptanceVerdict | undefined, verifierError?: string): AcceptanceEvaluationRecord['verdict'] {
  if (verifierError !== undefined) return 'error'
  if (!verdict) return 'error'
  if (verdict.ok) return 'pass'
  const items = Array.isArray(verdict.items) ? verdict.items : []
  if (items.some((item) => item.outcome === 'pending')) return 'pending'
  return 'incomplete'
}

/**
 * 写入一次验收评估的逐条诊断。返回写入内容（调用方/测试可断言）；
 * 表不存在或写入失败时返回 null 并告警，不影响验收收口。
 */
export function recordAcceptanceEvaluation(
  db: BetterSqlite3.Database,
  input: AcceptanceEvaluationRecordInput,
): AcceptanceEvaluationRecord | null {
  const record: AcceptanceEvaluationRecord = {
    workItemId: input.workItemId,
    stepId: input.stepId,
    source: input.source,
    verdict: verdictOf(input.verdict, input.verifierError),
    missing: input.verdict?.missing ?? [],
    pending: input.verdict?.pending ?? [],
    optionalFailures: input.verdict?.optionalFailures ?? [],
    durationMs: input.durationMs,
  }

  try {
    const tableReady = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='map_migration_reports'")
      .get()
    if (!tableReady) {
      logger.warn(`map_migration_reports 不存在，跳过验收诊断 step=${input.stepId}`)
      return null
    }

    const id = `mmr_acc_${Date.now()}_${(reportIdSeq++).toString(36).padStart(4, '0')}`
    const now = new Date().toISOString()
    const stats = {
      work_item_id: input.workItemId,
      step_id: input.stepId,
      source: input.source,
      verdict: record.verdict,
      missing_count: record.missing.length,
      pending_count: record.pending.length,
      optional_failure_count: record.optionalFailures.length,
      item_count: input.verdict?.items?.length ?? 0,
      checked: input.verdict?.checked ?? 0,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      evaluator_version: ACCEPTANCE_EVALUATOR_VERSION,
      confirmed_entry_ids: input.confirmedEntryIds ?? [],
      verifier_error: input.verifierError ?? null,
    }
    const details = {
      work_item_id: input.workItemId,
      step_id: input.stepId,
      source: input.source,
      items: input.verdict?.items ?? [],
      missing: record.missing,
      pending: record.pending,
      optional_failures: record.optionalFailures,
      pending_items: input.verdict?.pendingItems ?? [],
    }

    db.prepare(
      `INSERT INTO map_migration_reports
         (id, kind, stage, schema_version, started_at, finished_at, heartbeat_at,
          owner_pid, status, stats_json, details_json)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 'ok', ?, ?)`,
    ).run(
      id,
      ACCEPTANCE_EVAL_KIND,
      `${ACCEPTANCE_EVAL_STAGE_PREFIX}${input.stepId}`,
      now,
      now,
      process.pid,
      JSON.stringify(stats),
      JSON.stringify(details),
    )
    return record
  } catch (error) {
    logger.warn(`验收诊断写入失败 step=${input.stepId}：${String(error)}`)
    return null
  }
}
