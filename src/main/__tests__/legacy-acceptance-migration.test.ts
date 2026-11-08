/**
 * v36 / W3 G3-5：存量自由文本 acceptance 迁移（Option B）回归。
 *
 * 覆盖：free-text → {type:'manual'}、id 保留/缺失/重复、空白丢弃、
 * 结构化/混合/终态/非法 JSON/空数组一律不动、原文存档可回滚、
 * `map_migration_reports` 审计行（kind/stage/版本/行数/依据）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, MAP_ACCEPTANCE_MIGRATION_ARCHIVE_SCHEMAS } from '../map/schema'
import {
  LEGACY_ACCEPTANCE_KIND,
  LEGACY_ACCEPTANCE_STAGE,
  LEGACY_FREE_TEXT_PROVENANCE,
  convertLegacyAcceptance,
  migrateLegacyAcceptance,
} from '../map-migration/legacy-acceptance'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  for (const schema of MAP_ACCEPTANCE_MIGRATION_ARCHIVE_SCHEMAS) {
    db.exec(schema.createSql)
  }
  // 与生产 DDL 的列集合一致（迁移只用到 start/complete 涉及的列）。
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
    )
  `)
  return db
}

function insertItem(
  db: BetterSqlite3.Database,
  input: {
    id: string
    status?: string
    acceptance: string
    archivedAt?: string | null
    createdAt?: string
  },
): void {
  db.prepare(
    `INSERT INTO work_items (
       id, lineage_id, revision, graph_id, title, acceptance_json,
       status, gate_status, origin, created_at, updated_at, archived_at
     ) VALUES (?, ?, 1, 'g1', '任务', ?, ?, 'incomplete', 'human', ?, ?, ?)`,
  ).run(
    input.id,
    input.id,
    input.acceptance,
    input.status ?? 'blocked',
    input.createdAt ?? '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    input.archivedAt ?? null,
  )
}

describe('migrateLegacyAcceptance（v36 / Option B）', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
  })

  it('自由文本保守转 manual：id 保留、缺失补位、重复加后缀、空白丢弃、来源可见', () => {
    insertItem(db, {
      id: 'wi-1',
      acceptance: JSON.stringify([
        { id: 'keep', text: '人工检查登录页' },
        { text: '确认无回归' },
        { text: '   ' },
        { id: 'keep', text: '重复 id 的条目' },
      ]),
    })

    const stats = migrateLegacyAcceptance(db, 36)
    expect(stats.migratedRows).toBe(1)
    expect(stats.migratedItems).toBe(3)

    const migrated = JSON.parse(
      (db.prepare('SELECT acceptance_json FROM work_items WHERE id = ?').get('wi-1') as {
        acceptance_json: string
      }).acceptance_json,
    ) as Array<Record<string, unknown>>
    expect(migrated).toHaveLength(3)
    expect(migrated[0]).toMatchObject({
      id: 'keep',
      type: 'manual',
      expected: '人工检查登录页',
      text: '人工检查登录页',
      provenance: LEGACY_FREE_TEXT_PROVENANCE,
    })
    expect(migrated[1]).toMatchObject({ id: 'acc_2', type: 'manual', expected: '确认无回归' })
    expect(migrated[2]).toMatchObject({ id: 'keep_2', type: 'manual' })
  })

  it('非结构化行以外的行一律不动：结构化/混合/终态/归档/非法 JSON/空数组', () => {
    const structured = JSON.stringify([
      { id: 'a', type: 'command', expected: 'npm test', timeoutMs: 1000 },
    ])
    const mixed = JSON.stringify([{ id: 'a', type: 'manual', expected: 'x' }, { text: 'y' }])
    const invalid = '{not-json'
    const emptyArray = '[]'

    insertItem(db, { id: 'wi-structured', acceptance: structured })
    insertItem(db, { id: 'wi-mixed', acceptance: mixed })
    insertItem(db, { id: 'wi-done', status: 'done', acceptance: JSON.stringify([{ text: '已完成任务' }]) })
    insertItem(db, {
      id: 'wi-archived',
      archivedAt: '2026-02-01T00:00:00.000Z',
      acceptance: JSON.stringify([{ text: '归档任务' }]),
    })
    insertItem(db, { id: 'wi-invalid', acceptance: invalid })
    insertItem(db, { id: 'wi-empty', acceptance: emptyArray })

    const stats = migrateLegacyAcceptance(db, 36)
    expect(stats.migratedRows).toBe(0)
    expect(stats.alreadyStructuredRows).toBe(1)
    expect(stats.skippedMixedRows).toBe(1)
    expect(stats.skippedTerminalRows).toBe(1)
    expect(stats.skippedInvalidJsonRows).toBe(1)
    expect(stats.skippedEmptyRows).toBe(1)

    const read = (id: string): string =>
      (db.prepare('SELECT acceptance_json FROM work_items WHERE id = ?').get(id) as {
        acceptance_json: string
      }).acceptance_json
    expect(read('wi-structured')).toBe(structured)
    expect(read('wi-mixed')).toBe(mixed)
    expect(read('wi-done')).toBe(JSON.stringify([{ text: '已完成任务' }]))
    expect(read('wi-archived')).toBe(JSON.stringify([{ text: '归档任务' }]))
    expect(read('wi-invalid')).toBe(invalid)
    expect(read('wi-empty')).toBe(emptyArray)
  })

  it('原文逐行存档，可按 archive 回滚（护栏 1）', () => {
    const original = JSON.stringify([{ id: 'x', text: '原文' }])
    insertItem(db, { id: 'wi-rollback', acceptance: original })

    migrateLegacyAcceptance(db, 36)

    const archived = db
      .prepare(
        'SELECT original_acceptance_json, migrated_acceptance_json, schema_version FROM map_acceptance_migration_archive WHERE work_item_id = ?',
      )
      .get('wi-rollback') as {
      original_acceptance_json: string
      migrated_acceptance_json: string
      schema_version: number
    }
    expect(archived.original_acceptance_json).toBe(original)
    expect(archived.schema_version).toBe(36)
    expect(archived.migrated_acceptance_json).not.toBe(original)

    // 文档中的回滚 SQL 原样执行。
    db.prepare(
      `UPDATE work_items
         SET acceptance_json = (
           SELECT a.original_acceptance_json
             FROM map_acceptance_migration_archive a
            WHERE a.work_item_id = work_items.id)
       WHERE id IN (SELECT work_item_id FROM map_acceptance_migration_archive)`,
    ).run()
    const restored = db.prepare('SELECT acceptance_json FROM work_items WHERE id = ?').get('wi-rollback') as {
      acceptance_json: string
    }
    expect(restored.acceptance_json).toBe(original)
  })

  it('写一行可审计报告：kind/stage/版本/行数/判定依据（护栏 2）', () => {
    insertItem(db, { id: 'wi-audit', acceptance: JSON.stringify([{ text: '检查' }]) })
    migrateLegacyAcceptance(db, 36, () => Date.UTC(2026, 10, 8))

    const report = db
      .prepare('SELECT * FROM map_migration_reports ORDER BY started_at DESC LIMIT 1')
      .get() as {
      kind: string
      stage: string
      schema_version: number
      status: string
      stats_json: string
      details_json: string
    }
    expect(report.kind).toBe(LEGACY_ACCEPTANCE_KIND)
    expect(report.stage).toBe(LEGACY_ACCEPTANCE_STAGE)
    expect(report.schema_version).toBe(36)
    expect(report.status).toBe('ok')
    const stats = JSON.parse(report.stats_json) as Record<string, unknown>
    expect(stats['migrated_rows']).toBe(1)
    expect(stats['migrated_items']).toBe(1)
    expect(stats['schema_version']).toBe(36)
    const details = JSON.parse(report.details_json) as Record<string, unknown>
    expect(String(details['basis'])).toContain('manual')
    expect(details['archive_table']).toBe('map_acceptance_migration_archive')
    expect(String(details['rollback'])).toContain('original_acceptance_json')
  })

  it('幂等：无新行可迁移时报告仍 ok，且不改写已迁移行', () => {
    insertItem(db, { id: 'wi-idem', acceptance: JSON.stringify([{ text: '检查' }]) })
    migrateLegacyAcceptance(db, 36)
    const first = db.prepare('SELECT acceptance_json FROM work_items WHERE id = ?').get('wi-idem') as {
      acceptance_json: string
    }
    const second = migrateLegacyAcceptance(db, 36)
    expect(second.migratedRows).toBe(0)
    const after = db.prepare('SELECT acceptance_json FROM work_items WHERE id = ?').get('wi-idem') as {
      acceptance_json: string
    }
    expect(after.acceptance_json).toBe(first.acceptance_json)
  })

  it('convertLegacyAcceptance：纯字符串条目也按原文迁移', () => {
    const entries = convertLegacyAcceptance(['第一项', '', '第二项'])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ id: 'acc_1', type: 'manual', expected: '第一项' })
    expect(entries[1]).toMatchObject({ id: 'acc_3', type: 'manual', expected: '第二项' })
  })
})
