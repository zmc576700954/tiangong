/**
 * G2-16 离线校准（§5.7 / II-18）回归：
 * 触发条件（20 run / 2 周）、样本不足不出报告、报告纯聚合可复算、
 * 只写报告行不改 plan_deviations、结构缺失时静默跳过。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS7Schema } from '../map/schema'
import {
  CALIBRATION_INTERVAL_MS,
  CALIBRATION_MIN_RUNS,
  aggregateCalibration,
  maybeRunCalibration,
} from '../map/plan-calibration'

const DAY = 24 * 60 * 60 * 1000

function createDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS7Schema(db)
  // 与 database.ts 同形；kind 的 CHECK 含 calibration（v49）。
  db.exec(`
    CREATE TABLE map_migration_reports (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL CHECK(kind IN (
        'entity_key_backfill','link_backfill','integrity_check','import_dedup',
        'derivation','cleanup','calibration')),
      stage         TEXT,
      schema_version INTEGER,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      owner_pid     INTEGER,
      status        TEXT NOT NULL CHECK(status IN ('running','ok','partial','failed')),
      stats_json    TEXT,
      details_json  TEXT,
      error_json    TEXT
    )
  `)
  return db
}

let seq = 0

function insertDeviation(
  db: BetterSqlite3.Database,
  overrides: Partial<{
    derivationVersion: string
    observedRuleVersion: string
    taskType: string
    agentType: string | null
    plannedFiles: number | null
    actualFiles: number | null
    plannedSubtasks: number | null
    actualSubtasks: number | null
    rework: number
    testFailures: number
    replan: number
    scopeViolation: number
    boundaryChanged: number
    computedAt: number
  }> = {},
): void {
  const o = {
    derivationVersion: 'dv1',
    observedRuleVersion: 'rv1',
    taskType: 'feature',
    agentType: 'claude-code',
    plannedFiles: 2,
    actualFiles: 3,
    plannedSubtasks: 2,
    actualSubtasks: 2,
    rework: 0,
    testFailures: 0,
    replan: 0,
    scopeViolation: 0,
    boundaryChanged: 0,
    computedAt: Date.now(),
    ...overrides,
  }
  db.prepare(
    `INSERT INTO plan_deviations
       (id, derivation_version, observed_rule_version, task_type, agent_type,
        planned_file_count, actual_file_count, planned_subtask_count, actual_subtask_count,
        rework_count, test_failures, replan_count, scope_violation, boundary_changed,
        computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `pd_${seq++}`,
    o.derivationVersion,
    o.observedRuleVersion,
    o.taskType,
    o.agentType,
    o.plannedFiles,
    o.actualFiles,
    o.plannedSubtasks,
    o.actualSubtasks,
    o.rework,
    o.testFailures,
    o.replan,
    o.scopeViolation,
    o.boundaryChanged,
    o.computedAt,
  )
}

function calibrationRows(db: BetterSqlite3.Database): Array<{ id: string; stage: string | null; stats_json: string }> {
  return db
    .prepare("SELECT id, stage, stats_json FROM map_migration_reports WHERE kind='calibration' ORDER BY id")
    .all() as Array<{ id: string; stage: string | null; stats_json: string }>
}

describe('G2-16 离线校准', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = createDb()
  })

  it('样本 < 20 run 且未满 2 周：不出报告', () => {
    for (let i = 0; i < CALIBRATION_MIN_RUNS - 1; i++) {
      insertDeviation(db, { computedAt: Date.now() - DAY })
    }
    const result = maybeRunCalibration(db)
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('trigger_not_met')
    expect(calibrationRows(db)).toHaveLength(0)
  })

  it('满 2 周但样本仍 < 20 run：触发条件满足也不出报告', () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      insertDeviation(db, { computedAt: now - CALIBRATION_INTERVAL_MS - DAY })
    }
    const result = maybeRunCalibration(db, new Date(now))
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('insufficient_sample')
    expect(calibrationRows(db)).toHaveLength(0)
  })

  it('新增 ≥ 20 run：写一份 calibration 报告并按归因分组聚合', () => {
    const now = Date.now()
    // A 组 12 条：planned 2 / actual 3 → 1.5 以上 → file_growth 信号
    for (let i = 0; i < 12; i++) {
      insertDeviation(db, { computedAt: now - DAY })
    }
    // B 组 8 条：另一 task_type，replan 中位数 3 → replan 信号
    for (let i = 0; i < 8; i++) {
      insertDeviation(db, {
        taskType: 'refactor',
        agentType: null,
        plannedFiles: 4,
        actualFiles: 4,
        replan: 3,
        scopeViolation: 1,
        computedAt: now - DAY,
      })
    }

    const result = maybeRunCalibration(db, new Date(now))
    expect(result.ran).toBe(true)
    expect(result.runCount).toBe(20)

    const rows = calibrationRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].stage).toBe('periodic')
    const stats = JSON.parse(rows[0].stats_json) as {
      run_count: number
      min_runs: number
      groups: Array<Record<string, unknown>>
    }
    expect(stats.run_count).toBe(20)
    expect(stats.min_runs).toBe(20)
    expect(stats.groups).toHaveLength(2)

    const feature = stats.groups.find((g) => g.taskType === 'feature')!
    expect(feature.runCount).toBe(12)
    expect(feature.fileRatio).toBe(1.5)
    expect(feature.signals).toEqual([])

    const refactor = stats.groups.find((g) => g.taskType === 'refactor')!
    expect(refactor.runCount).toBe(8)
    expect(refactor.replanMedian).toBe(3)
    expect(refactor.scopeViolationRate).toBe(1)
    expect(refactor.signals).toContain('replan_median_gt_2')
  })

  it('纯聚合可复算：同一批偏差行两次聚合结果一致', () => {
    const rows = [
      {
        derivation_version: 'dv1', observed_rule_version: 'rv1', task_type: 'feature', agent_type: 'a',
        planned_file_count: 2, actual_file_count: 5, planned_subtask_count: 2, actual_subtask_count: 3,
        rework_count: 1, test_failures: 2, replan_count: 4, scope_violation: 1, boundary_changed: 0,
      },
      {
        derivation_version: 'dv1', observed_rule_version: 'rv1', task_type: 'feature', agent_type: 'a',
        planned_file_count: 2, actual_file_count: 1, planned_subtask_count: null, actual_subtask_count: null,
        rework_count: 0, test_failures: 0, replan_count: 1, scope_violation: 0, boundary_changed: 1,
      },
    ]
    const first = aggregateCalibration(rows, 'a', 'b')
    const second = aggregateCalibration(rows, 'a', 'b')
    expect(second).toEqual(first)
    expect(first.groups[0].fileRatio).toBe(1.5)
    expect(first.groups[0].replanMedian).toBe(2.5)
    expect(first.groups[0].boundaryChangedRate).toBe(0.5)
  })

  it('只写报告行：不改 plan_deviations、不改阈值配置', () => {
    const now = Date.now()
    for (let i = 0; i < CALIBRATION_MIN_RUNS; i++) insertDeviation(db, { computedAt: now - DAY })
    const before = db.prepare('SELECT COUNT(*) AS n, MAX(computed_at) AS m FROM plan_deviations').get()

    expect(maybeRunCalibration(db, new Date(now)).ran).toBe(true)

    const after = db.prepare('SELECT COUNT(*) AS n, MAX(computed_at) AS m FROM plan_deviations').get()
    expect(after).toEqual(before)
    // 除报告行外没有新增其他 kind 的报告。
    const kinds = db
      .prepare('SELECT DISTINCT kind FROM map_migration_reports')
      .all() as Array<{ kind: string }>
    expect(kinds).toEqual([{ kind: 'calibration' }])
  })

  it('上次报告之后的增量不足 20 run：不重复出报告', () => {
    const now = Date.now()
    for (let i = 0; i < CALIBRATION_MIN_RUNS; i++) insertDeviation(db, { computedAt: now - DAY })
    expect(maybeRunCalibration(db, new Date(now)).ran).toBe(true)

    // 再补 3 条新 run：距上次报告不足 2 周，样本也不足。
    for (let i = 0; i < 3; i++) insertDeviation(db, { computedAt: now + 1000 + i })
    const second = maybeRunCalibration(db, new Date(now + 2000))
    expect(second.ran).toBe(false)
    expect(second.reason).toBe('trigger_not_met')
    expect(calibrationRows(db)).toHaveLength(1)
  })

  it('结构缺失（无 plan_deviations / 无报告表）：静默跳过', () => {
    const bare = new Database(':memory:') as unknown as BetterSqlite3.Database
    const result = maybeRunCalibration(bare)
    expect(result.ran).toBe(false)
    expect(result.reason).toBe('table_missing')
  })
})
