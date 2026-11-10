/**
 * 进化 Layer1：run 终态后的记忆命中采集（G2-2 / II-04）。
 *
 * 采集口径（已裁决）：
 *  - 只写引用不写全文：`step` → `work_step:<id>`、`evidence` → `node_evidence:<id>`、
 *    `deviation` → `plan_deviation:<id>`。
 *  - `context` 不产：L1 没有稳定的上下文来源（妥协见蓝图 I.9.3，待 G2-4/ContextBundle）。
 *  - 每条命中必须带 `source_outcome`（五个终态之一）：取消/中断不是学习信号，
 *    G2-4 归因时按它剔除噪声。
 *  - 每 run 最多 50 条；幂等由 `memory_hits` 唯一索引保证。
 *  - 无 `project_path` 的 run 跳过（`memory_hits.project_path` 非空，且不跨项目聚合）。
 *
 * 本函数不吞异常：调用方（`WorkRunService`）负责 try/catch 与失败留痕，
 * 失败不得改变 run 终态。
 */

import type BetterSqlite3 from 'better-sqlite3'
import {
  MEMORY_HIT_PER_RUN_LIMIT,
  MemoryHitService,
  type MemoryHitKind,
  type SourceOutcome,
} from './memory-hit-service'

/** run 终态 → `source_outcome`；非终态返回 undefined（不采集）。 */
export const RUN_STATUS_TO_OUTCOME: Record<string, SourceOutcome> = {
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timeout',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
}

/** 证据等级 → 命中权重（固定等级权重，不是经验统计值）。 */
export const EVIDENCE_LEVEL_SCORE: Record<string, number> = {
  E1: 0.6,
  E2: 0.8,
  E3: 1,
  E4: 1,
}

interface RunForMemory {
  id: string
  work_item_id: string
  step_id: string | null
  status: string
  project_path: string | null
  graph_id: string
  anchor_node_id: string | null
}

/**
 * 采集一个 run 的记忆命中，返回本次实际写入条数（重复/超限/无项目路径为 0）。
 */
export function collectMemoryHitsForRun(
  db: BetterSqlite3.Database,
  runId: string,
  now: Date = new Date(),
): number {
  const run = db
    .prepare(
      `SELECT r.id, r.work_item_id, r.step_id, r.status,
              w.project_path, w.graph_id, w.anchor_node_id
         FROM work_runs r
         JOIN work_items w ON w.id = r.work_item_id
        WHERE r.id = ?`,
    )
    .get(runId) as RunForMemory | undefined
  if (!run) return 0

  const outcome = RUN_STATUS_TO_OUTCOME[run.status]
  if (!outcome) return 0

  const projectPath = run.project_path?.trim() ?? ''
  if (projectPath === '') return 0

  const candidates: Array<{ hitKind: MemoryHitKind; sourceRef: string; score: number }> = []

  if (run.step_id) {
    candidates.push({ hitKind: 'step', sourceRef: `work_step:${run.step_id}`, score: 1 })
  }

  const evidence = db
    .prepare(
      `SELECT id, evidence_level FROM node_evidence
        WHERE work_run_id = ? AND revoked_at IS NULL
        ORDER BY created_at ASC, id ASC`,
    )
    .all(runId) as Array<{ id: string; evidence_level: string }>
  for (const row of evidence) {
    candidates.push({
      hitKind: 'evidence',
      sourceRef: `node_evidence:${row.id}`,
      score: EVIDENCE_LEVEL_SCORE[row.evidence_level] ?? 0.8,
    })
  }

  const deviations = db
    .prepare(
      `SELECT id FROM plan_deviations
        WHERE work_run_id = ?
        ORDER BY computed_at ASC, id ASC`,
    )
    .all(runId) as Array<{ id: string }>
  for (const row of deviations) {
    candidates.push({ hitKind: 'deviation', sourceRef: `plan_deviation:${row.id}`, score: 1 })
  }

  const service = new MemoryHitService(db)
  let written = 0
  for (const hit of candidates.slice(0, MEMORY_HIT_PER_RUN_LIMIT)) {
    const result = service.record({
      projectPath,
      graphId: run.graph_id,
      nodeId: run.anchor_node_id,
      workItemId: run.work_item_id,
      runId: run.id,
      stepId: run.step_id,
      hitKind: hit.hitKind,
      sourceOutcome: outcome,
      sourceRef: hit.sourceRef,
      score: hit.score,
      now,
    })
    if (!result.reused) written++
  }
  return written
}
