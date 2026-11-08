/**
 * gate 逐道诊断的落库（D12 2026-11-08 修订）。
 *
 * 载体复用既有报告表 `map_migration_reports`（该表在 §8.14.1 就定义为
 * 「所有阶段记录复用本表」，不为诊断新增表）：
 * - kind='integrity_check'：G1–G6 是准入完整性判定，语义最近的既有 kind；
 * - stage='gate_eval:<workItemId>'：按任务分组，启动预检只关心 failed/running/partial，
 *   本模块只写 status='ok'，因此不影响任何迁移/preflight 结论；
 * - stats_json：评估器版本、G4 阈值快照、最终结论、缺失数量；
 * - details_json：逐道结果（G1..G6 的 ok/missing）与豁免、引擎异常。
 *
 * 边界：纯诊断。不写 work_items/work_steps/work_runs/node_evidence，不进入用户可见
 * 状态；写失败只告警，绝不阻断 tick（诊断不能让执行停摆）。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import type { GateRecheckResult, GateDiagnostics } from './gate-recheck'

const logger = createLogger('GateDiagnostics')

export const GATE_EVAL_KIND = 'integrity_check' as const
export const GATE_EVAL_STAGE_PREFIX = 'gate_eval:'

/** 报告行 id 的进程内单调计数：同毫秒多次评估保证 `started_at DESC, id DESC` 排序稳定。 */
let reportIdSeq = 0

export interface GateEvaluationRecordInput {
  itemId: string
  lineageId: string
  revision: number
  /** 评估前库里的 gate_status（仅记录，便于对比重跑结论）。 */
  gateStatusBefore: string
  result: GateRecheckResult
  /** 引擎抛异常时的原文（裁剪后写入，便于区分「引擎坏了」与「确实没过」）。 */
  engineError?: string
}

export interface GateEvaluationRecord {
  workItemId: string
  verdict: 'pass' | 'waived' | 'incomplete'
  diagnostics: GateDiagnostics | null
  missing: string[]
}

/** 结论归一：waived 优先于 pass（两者 ok 都为 true）。 */
export function verdictOf(result: GateRecheckResult): GateEvaluationRecord['verdict'] {
  if (!result.ok) return 'incomplete'
  return result.waived ? 'waived' : 'pass'
}

/**
 * 写入一次 gate 评估的逐道诊断。返回写入内容（调用方/测试可断言）；
 * 表不存在或写入失败时返回 null 并告警，不影响 tick。
 */
export function recordGateEvaluation(
  db: BetterSqlite3.Database,
  input: GateEvaluationRecordInput,
): GateEvaluationRecord | null {
  const record: GateEvaluationRecord = {
    workItemId: input.itemId,
    verdict: verdictOf(input.result),
    diagnostics: input.result.diagnostics ?? null,
    missing: input.result.missing,
  }

  try {
    const tableReady = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='map_migration_reports'")
      .get()
    if (!tableReady) {
      logger.warn(`map_migration_reports 不存在，跳过 gate 诊断 item=${input.itemId}`)
      return null
    }

    const id = `mmr_${Date.now()}_${(reportIdSeq++).toString(36).padStart(4, '0')}`
    const now = new Date().toISOString()
    const stats = {
      work_item_id: input.itemId,
      revision: input.revision,
      verdict: record.verdict,
      missing_count: input.result.missing.length,
      evaluator_version: input.result.diagnostics?.evaluatorVersion ?? 'gate_engine_unavailable',
      thresholds: input.result.diagnostics?.thresholds ?? null,
      engine_error: input.engineError ?? null,
    }
    const details = {
      work_item_id: input.itemId,
      lineage_id: input.lineageId,
      revision: input.revision,
      gate_status_before: input.gateStatusBefore,
      gates: input.result.diagnostics?.gates ?? [],
      missing: input.result.missing,
      waived: input.result.waived ?? null,
    }

    db.prepare(
      `INSERT INTO map_migration_reports
         (id, kind, stage, schema_version, started_at, finished_at, heartbeat_at,
          owner_pid, status, stats_json, details_json)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 'ok', ?, ?)`,
    ).run(
      id,
      GATE_EVAL_KIND,
      `${GATE_EVAL_STAGE_PREFIX}${input.itemId}`,
      now,
      now,
      process.pid,
      JSON.stringify(stats),
      JSON.stringify(details),
    )
    return record
  } catch (error) {
    logger.warn(`gate 诊断写入失败 item=${input.itemId}：${String(error)}`)
    return null
  }
}
