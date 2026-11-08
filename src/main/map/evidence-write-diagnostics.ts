/**
 * 证据写入失败的诊断落库（2026-11-08，node_evidence 写入面 W 包）。
 *
 * 边界：证据本身只能经 `EvidenceService.create` 写入；本模块只记录「那次写入失败」，
 * 不复刻任何 node_evidence 字段、不重试、不改变 step/run 终态。
 * 载体复用既有报告表 `map_migration_reports`（不新增表）：
 * - kind='integrity_check'：证据写入与验收/gate 同属准入完整性判定；
 * - stage='evidence_write:<stepId>'：与 acceptance_eval 分组区分；
 * - status='ok'：启动预检只关心 failed/running/partial，本行不参与任何迁移结论。
 *
 * 写失败只告警（诊断自身不能反过来阻断业务收口）。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('EvidenceWriteDiagnostics')

export const EVIDENCE_WRITE_STAGE_PREFIX = 'evidence_write:'

/** 报告行 id 的进程内单调计数：同毫秒多次写入保证排序稳定。 */
let reportIdSeq = 0

export interface EvidenceWriteFailureInput {
  /** 写入来源：agent 回合完成 / 人工验收确认。 */
  source: 'agent_turn' | 'acceptance_confirmation'
  level: 'E2' | 'E4'
  evidenceType: 'session_turn' | 'human_confirm'
  workItemId?: string | null
  stepId?: string | null
  workRunId?: string | null
  nodeEntityKey?: string | null
  /** 原始异常文案（保留可读原因，便于区分校验拒绝与库错误）。 */
  error: string
}

/**
 * 记录一次证据写入失败。返回是否落库成功（测试可断言）；
 * 表不存在或写入失败时返回 false 并告警。
 */
export function recordEvidenceWriteFailure(
  db: BetterSqlite3.Database,
  input: EvidenceWriteFailureInput,
): boolean {
  try {
    const tableReady = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='map_migration_reports'")
      .get()
    if (!tableReady) {
      logger.warn(`map_migration_reports 不存在，跳过证据写入诊断 step=${input.stepId ?? 'unknown'}`)
      return false
    }

    const id = `mmr_evw_${Date.now()}_${(reportIdSeq++).toString(36).padStart(4, '0')}`
    const now = new Date().toISOString()
    const stats = {
      source: input.source,
      evidence_level: input.level,
      evidence_type: input.evidenceType,
      work_item_id: input.workItemId ?? null,
      step_id: input.stepId ?? null,
      work_run_id: input.workRunId ?? null,
      node_entity_key: input.nodeEntityKey ?? null,
      error: input.error,
      recorded_at: now,
    }

    db.prepare(
      `INSERT INTO map_migration_reports
         (id, kind, stage, schema_version, started_at, finished_at, heartbeat_at,
          owner_pid, status, stats_json, details_json)
       VALUES (?, 'integrity_check', ?, NULL, ?, ?, NULL, ?, 'ok', ?, NULL)`,
    ).run(
      id,
      `${EVIDENCE_WRITE_STAGE_PREFIX}${input.stepId ?? 'unknown'}`,
      now,
      now,
      process.pid,
      JSON.stringify(stats),
    )
    return true
  } catch (error) {
    logger.warn(`证据写入诊断落库失败 step=${input.stepId ?? 'unknown'}：${String(error)}`)
    return false
  }
}
