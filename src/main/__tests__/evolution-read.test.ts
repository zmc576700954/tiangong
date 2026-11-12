/**
 * 进化层只读查询（v3.25）。
 *
 * 覆盖三类必测边界：
 *  - 表/视图不存在时返回 `available:false`（老库 v44/v46 未迁移），不抛错；
 *  - 过滤条件真的生效，且 limit 会被夹到上限（不让界面一次拉全库）；
 *  - 空值与脏值不被美化：`source_outcome` 为 null 归 `unknown`、
 *    `stats_json` 坏了留报告行并标 `parseError`。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import {
  applyMapS5aSchema,
  applyMapS6aSchema,
  applyMapViews,
  applyMemorySchema,
} from '../map/schema'
import {
  ATTRIBUTION_MIN_SAMPLE,
  EVOLUTION_MAX_LIMIT,
  listAttribution,
  listCalibrationReports,
  listMemoryHits,
} from '../map/evolution-read'

function bareDb(): BetterSqlite3.Database {
  return new Database(':memory:') as unknown as BetterSqlite3.Database
}

/** 只建 map S5a/S6a 需要的表 + 视图（不建 memory_hits，用于验证 available=false）。 */
function dbWithoutEvolutionTables(): BetterSqlite3.Database {
  const db = bareDb()
  applyMapS5aSchema(db)
  applyMapS6aSchema(db)
  db.exec(`
    CREATE TABLE graphs (id TEXT PRIMARY KEY, project_path TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL);
  `)
  applyMapViews(db)
  return db
}

function dbWithEvolutionTables(): BetterSqlite3.Database {
  const db = dbWithoutEvolutionTables()
  applyMemorySchema(db)
  return db
}

function seedReportTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE map_migration_reports (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      stage         TEXT,
      schema_version INTEGER,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      owner_pid     INTEGER,
      status        TEXT NOT NULL,
      stats_json    TEXT,
      details_json  TEXT,
      error_json    TEXT
    );
  `)
}

interface HitSeed {
  id?: string
  projectPath?: string
  graphId?: string
  runId?: string
  hitKind?: string
  sourceOutcome?: string | null
  sourceRef?: string
  createdAt?: string
}

let seq = 0
function seedHit(db: BetterSqlite3.Database, seed: HitSeed = {}): void {
  seq += 1
  db.prepare(
    `INSERT INTO memory_hits
       (id, project_path, graph_id, node_id, work_item_id, run_id, step_id,
        hit_kind, source_outcome, source_ref, score, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, 1.0, ?)`,
  ).run(
    seed.id ?? `hit_${seq}`,
    seed.projectPath ?? '/p/a',
    seed.graphId ?? 'g1',
    seed.runId ?? `run_${seq}`,
    seed.hitKind ?? 'context',
    seed.sourceOutcome === undefined ? 'completed' : seed.sourceOutcome,
    seed.sourceRef ?? `node_evidence:ev_${seq}`,
    seed.createdAt ?? '2026-11-12T00:00:00.000Z',
  )
}

describe('listMemoryHits', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = dbWithEvolutionTables()
  })

  it('表不存在时 available=false，不当成空列表', () => {
    const bare = dbWithoutEvolutionTables()
    const result = listMemoryHits(bare)
    expect(result.available).toBe(false)
    expect(result.rows).toEqual([])
    expect(result.total).toBe(0)
    bare.close()
  })

  it('按 projectPath / hitKind / runId 过滤，计数跟着过滤走', () => {
    seedHit(db, { projectPath: '/p/a', hitKind: 'context', runId: 'r1' })
    seedHit(db, { projectPath: '/p/a', hitKind: 'evidence', runId: 'r2' })
    seedHit(db, { projectPath: '/p/b', hitKind: 'context', runId: 'r3' })

    const scoped = listMemoryHits(db, { projectPath: '/p/a' })
    expect(scoped.available).toBe(true)
    expect(scoped.total).toBe(2)
    expect(scoped.byKind).toEqual([
      { key: 'context', count: 1 },
      { key: 'evidence', count: 1 },
    ])

    const byKind = listMemoryHits(db, { projectPath: '/p/a', hitKind: 'evidence' })
    expect(byKind.total).toBe(1)
    expect(byKind.rows[0].hitKind).toBe('evidence')

    const byRun = listMemoryHits(db, { runId: 'r3' })
    expect(byRun.rows).toHaveLength(1)
    expect(byRun.rows[0].projectPath).toBe('/p/b')
  })

  it('source_outcome 为 null 的存量行归到 unknown，不冒充满分终态', () => {
    seedHit(db, { sourceOutcome: null, runId: 'r_legacy' })
    seedHit(db, { sourceOutcome: 'failed', runId: 'r_failed' })
    const result = listMemoryHits(db)
    expect(result.rows.find((row) => row.runId === 'r_legacy')?.sourceOutcome).toBeNull()
    expect(result.byOutcome).toEqual([
      { key: 'failed', count: 1 },
      { key: 'unknown', count: 1 },
    ])
  })

  it('limit 被夹到上限，负数/非数回落默认值', () => {
    for (let i = 0; i < 5; i += 1) seedHit(db, { createdAt: `2026-11-12T00:00:0${i}.000Z` })
    const capped = listMemoryHits(db, { limit: EVOLUTION_MAX_LIMIT + 5000 })
    expect(capped.rows.length).toBeLessThanOrEqual(EVOLUTION_MAX_LIMIT)
    // 默认与非法值都不该把 5 条裁掉
    expect(listMemoryHits(db, { limit: -1 }).rows).toHaveLength(5)
    expect(listMemoryHits(db, { limit: Number.NaN }).rows).toHaveLength(5)
    // 最新在前
    expect(capped.rows[0].createdAt).toBe('2026-11-12T00:00:04.000Z')
  })
})

describe('listAttribution', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = dbWithEvolutionTables()
  })

  it('视图不存在时 available=false，汇总给 null 命中率而不是 0', () => {
    const bare = dbWithoutEvolutionTables()
    bare.exec('DROP VIEW IF EXISTS v_memory_attribution')
    const result = listAttribution(bare)
    expect(result.available).toBe(false)
    expect(result.summary.hitRate).toBeNull()
    expect(result.summary.minSample).toBe(ATTRIBUTION_MIN_SAMPLE)
    bare.close()
  })

  it('只统计 map_task 来源的 run，命中率与结论分布按视图口径', () => {
    // 视图要求：work_runs × work_items × node_session_links(session_origin='map_task')
    db.prepare(
      `INSERT INTO work_items (id, lineage_id, revision, project_path, graph_id, title, status, origin, is_current, created_at, updated_at)
       VALUES ('wi1', 'lin1', 1, '/p/a', 'g1', 'item', 'queued', 'human', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    ).run()
    const insertRun = db.prepare(
      `INSERT INTO work_runs
         (id, work_item_id, work_item_lineage_id, work_item_revision, run_seq,
          idempotency_key, executor_kind, status, created_at)
       VALUES (?, 'wi1', 'lin1', 1, ?, ?, 'agent', ?, 0)`,
    )
    insertRun.run('run_hit', 1, 'idem_hit', 'completed')
    insertRun.run('run_miss', 2, 'idem_miss', 'failed')
    const insertLink = db.prepare(
      `INSERT INTO node_session_links
         (id, project_path, graph_id, work_run_id, thread_id, link_role, session_origin, created_at)
       VALUES (?, '/p/a', 'g1', ?, ?, 'primary', ?, 0)`,
    )
    insertLink.run('l1', 'run_hit', 'th1', 'map_task')
    insertLink.run('l2', 'run_miss', 'th2', 'manual_panel')
    seedHit(db, { runId: 'run_hit', sourceOutcome: 'completed' })

    const result = listAttribution(db, { graphId: 'g1' })
    expect(result.available).toBe(true)
    // 只有 map_task 来源的 run 入视图
    expect(result.total).toBe(1)
    expect(result.rows[0].runId).toBe('run_hit')
    expect(result.rows[0].hitCount).toBe(1)
    expect(result.summary.runsWithHit).toBe(1)
    expect(result.summary.hitRate).toBe(1)
    expect(result.summary.groupsInsufficient).toBe(1)
  })
})

describe('listCalibrationReports', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = dbWithEvolutionTables()
  })

  it('没有 map_migration_reports 表时 available=false', () => {
    const result = listCalibrationReports(db)
    expect(result.available).toBe(false)
    expect(result.reports).toEqual([])
  })

  it('解析 stats_json 的 snake_case 外壳与驼峰分组，坏数据保留行并标 parseError', () => {
    seedReportTable(db)
    db.prepare(
      `INSERT INTO map_migration_reports (id, kind, stage, started_at, finished_at, status, stats_json)
       VALUES (?, 'calibration', 'periodic', ?, ?, 'ok', ?)`,
    ).run(
      'cal_ok',
      '2026-11-10T00:00:00.000Z',
      '2026-11-10T00:00:01.000Z',
      JSON.stringify({
        window_start: '2026-10-27T00:00:00.000Z',
        window_end: '2026-11-10T00:00:00.000Z',
        run_count: 24,
        min_runs: 20,
        groups: [
          {
            derivationVersion: 'd1',
            observedRuleVersion: 'd1',
            taskType: 'bugfix',
            agentType: null,
            runCount: 24,
            fileRatio: 1.8,
            subtaskRatio: 1.1,
            replanMedian: 3,
            reworkCount: 2,
            testFailures: 1,
            scopeViolationRate: 0.125,
            boundaryChangedRate: 0,
            signals: ['file_growth_gt_1_5'],
          },
        ],
      }),
    )
    db.prepare(
      `INSERT INTO map_migration_reports (id, kind, stage, started_at, finished_at, status, stats_json)
       VALUES (?, 'calibration', 'periodic', ?, ?, 'ok', ?)`,
    ).run('cal_broken', '2026-11-09T00:00:00.000Z', null, '{not json')

    // kind 不是 calibration 的报告不进这个列表
    db.prepare(
      `INSERT INTO map_migration_reports (id, kind, stage, started_at, status, stats_json)
       VALUES ('ic1', 'integrity_check', 'node_links', '2026-11-11T00:00:00.000Z', 'ok', NULL)`,
    ).run()

    const result = listCalibrationReports(db)
    expect(result.available).toBe(true)
    expect(result.reports.map((report) => report.id)).toEqual(['cal_ok', 'cal_broken'])

    const ok = result.reports[0]
    expect(ok.windowStart).toBe('2026-10-27T00:00:00.000Z')
    expect(ok.runCount).toBe(24)
    expect(ok.minRuns).toBe(20)
    expect(ok.groups).toHaveLength(1)
    expect(ok.groups[0]).toMatchObject({ taskType: 'bugfix', runCount: 24 })
    expect(ok.groups[0].signals).toEqual(['file_growth_gt_1_5'])
    expect(ok.parseError).toBeNull()

    const broken = result.reports[1]
    expect(broken.parseError).not.toBeNull()
    expect(broken.groups).toEqual([])
  })
})
