/**
 * I.8.F P2：C2 修订 diff / impact / 原因留痕的单元测试。
 *
 * 这里只验证服务端口径：
 * - 历史按 lineage + revision 读，is_current 语义不变；
 * - impact 三项只算可推导部分，推不出的进 missing（不拿「无变化」冒充「推不出」）；
 * - 审计表不接受 `workitem_revise` 时如实返回 traced=false（未留痕）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import {
  buildWorkItemDiff,
  listWorkItemRevisions,
  probeReviseReasonSink,
  recordReviseReason,
} from '../map/work-item-revision'

const dbs: BetterSqlite3.Database[] = []

function openDb(): BetterSqlite3.Database {
  const db = new Database(':memory:')
  applyMapS5aSchema(db)
  dbs.push(db)
  return db
}

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close()
})

interface ItemOverrides {
  id?: string
  revision?: number
  is_current?: number
  supersedes_id?: string | null
  title?: string
  goal?: string | null
  scope_files?: string
  acceptance_json?: string
  depends_on_json?: string
  verification_hint?: string | null
  status?: string
  gate_status?: string
  gate_missing_json?: string | null
}

function insertItem(db: BetterSqlite3.Database, overrides: ItemOverrides = {}): void {
  const row = {
    id: 'wi_1',
    lineage_id: 'ln_1',
    revision: 1,
    supersedes_id: null as string | null,
    is_current: 1,
    graph_id: 'g1',
    title: 'T1',
    goal: 'G1',
    scope_files: JSON.stringify(['a.ts', 'b.ts']),
    out_of_scope_files: null as string | null,
    acceptance_json: JSON.stringify([
      { id: 'ac1', type: 'manual', expected: 'x' },
      { id: 'ac2', type: 'manual', expected: 'y' },
    ]),
    verification_hint: null as string | null,
    status: 'draft',
    gate_status: 'incomplete',
    gate_missing_json: '[]',
    depends_on_json: JSON.stringify(['wi_0']),
    origin: 'human',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
  db.prepare(
    `INSERT INTO work_items (
       id, lineage_id, revision, supersedes_id, is_current, graph_id, title, goal,
       scope_files, out_of_scope_files, acceptance_json, verification_hint,
       status, gate_status, gate_missing_json, depends_on_json, origin, created_at, updated_at
     ) VALUES (
       @id, @lineage_id, @revision, @supersedes_id, @is_current, @graph_id, @title, @goal,
       @scope_files, @out_of_scope_files, @acceptance_json, @verification_hint,
       @status, @gate_status, @gate_missing_json, @depends_on_json, @origin, @created_at, @updated_at
     )`,
  ).run(row)
}

const okGate = { recheck: () => ({ ok: true, missing: [] as string[] }) }

describe('listWorkItemRevisions', () => {
  it('按 lineage 返回全部 revision（含旧行），is_current 原样投影', () => {
    const db = openDb()
    insertItem(db, { id: 'wi_r1', revision: 1, is_current: 0, status: 'superseded', title: '旧' })
    insertItem(db, { id: 'wi_r2', revision: 2, is_current: 1, supersedes_id: 'wi_r1', title: '新' })

    const rows = listWorkItemRevisions(db, 'ln_1')
    expect(rows.map((row) => row.revision)).toEqual([1, 2])
    expect(rows[0]).toMatchObject({ is_current: false, status: 'superseded', supersedes_id: null })
    expect(rows[1]).toMatchObject({ is_current: true, supersedes_id: 'wi_r1', title: '新' })
  })
})

describe('buildWorkItemDiff / impact 三项', () => {
  it('stored 模式：字段差异 + 写域/验收/依赖三项可推导部分', () => {
    const db = openDb()
    insertItem(db, { id: 'wi_r1', revision: 1, is_current: 0, status: 'superseded' })
    insertItem(db, {
      id: 'wi_r2',
      revision: 2,
      is_current: 1,
      supersedes_id: 'wi_r1',
      title: 'T2',
      scope_files: JSON.stringify(['b.ts', 'c.ts']),
      acceptance_json: JSON.stringify([
        { id: 'ac1', type: 'manual', expected: 'x2' },
        { id: 'ac3', type: 'manual', expected: 'z' },
      ]),
      depends_on_json: JSON.stringify(['wi_2']),
      gate_status: 'pass',
    })

    const diff = buildWorkItemDiff(db, okGate, { lineageId: 'ln_1', from: 1, to: 2 })
    expect(diff.to).toMatchObject({ id: 'wi_r2', revision: 2, stored: true })
    expect(diff.fields.find((field) => field.field === 'title')).toMatchObject({ changed: true })
    expect(diff.fields.find((field) => field.field === 'goal')).toMatchObject({ changed: false })

    const writeScope = diff.impact.find((item) => item.kind === 'writeScope')!
    expect(writeScope.detail).toEqual({ added: ['c.ts'], removed: ['a.ts'], unchanged: ['b.ts'] })
    // 集合相等不能被当成「文件不会被改动」。
    expect(writeScope.missing).toContain('filesActuallyChanged')

    const acceptance = diff.impact.find((item) => item.kind === 'acceptance')!
    expect(acceptance.detail).toEqual({ added: ['ac3'], removed: ['ac2'], modified: ['ac1'] })
    expect(acceptance.missing).toEqual([])

    const dependency = diff.impact.find((item) => item.kind === 'dependency')!
    expect(dependency.detail).toEqual({ added: ['wi_2'], removed: ['wi_0'] })
    expect(dependency.missing).toEqual(['invalidatedRuns', 'staleEvidence'])

    expect(diff.gateResult).toEqual({ status: 'stored', gateStatus: 'pass', missing: [] })
  })

  it('验收条目缺稳定 id 时整体标 missing，不按位置硬配', () => {
    const db = openDb()
    insertItem(db, {
      id: 'wi_r1',
      revision: 1,
      is_current: 0,
      status: 'superseded',
      acceptance_json: JSON.stringify([{ type: 'manual', expected: 'x' }]),
    })
    insertItem(db, { id: 'wi_r2', revision: 2, is_current: 1 })

    const diff = buildWorkItemDiff(db, okGate, { lineageId: 'ln_1', from: 1, to: 2 })
    const acceptance = diff.impact.find((item) => item.kind === 'acceptance')!
    expect(acceptance.status).toBe('missing')
    expect(acceptance.missing).toContain('acceptance_entry_without_stable_id')
    expect(acceptance.detail).toEqual({})
  })

  it('proposed 模式：旧 revision vs 拟修订内容，gate 走预检', () => {
    const db = openDb()
    insertItem(db, { id: 'wi_r1', revision: 1 })
    let seenTitle = ''
    const precheckGate = {
      recheck: (item: { title: string }) => {
        seenTitle = item.title
        return { ok: false, missing: ['scope_files_empty'] }
      },
    }

    const diff = buildWorkItemDiff(db, precheckGate, {
      lineageId: 'ln_1',
      from: 1,
      proposed: {
        title: 'T-new',
        scopeFiles: ['a.ts'],
        acceptance: [{ id: 'ac1', type: 'manual', expected: 'x' }],
      },
    })

    expect(seenTitle).toBe('T-new')
    expect(diff.to).toEqual({ id: null, revision: 2, stored: false })
    expect(diff.gateResult).toEqual({ status: 'precheck', gateStatus: 'incomplete', missing: ['scope_files_empty'] })
    expect(diff.fields.find((field) => field.field === 'title')).toMatchObject({ before: 'T1', after: 'T-new', changed: true })
  })
})

describe('修订原因留痕', () => {
  it('无审计表时返回未留痕', () => {
    const db = openDb()
    expect(probeReviseReasonSink(db).sink).toBeNull()
    const result = recordReviseReason(db, { lineageId: 'ln_1', from: 1, to: 2, reason: 'r' })
    expect(result.traced).toBe(false)
    expect(result.note).toContain('未留痕')
  })

  it('审计表 kind 值域不含 workitem_revise 时返回未留痕（不硬塞）', () => {
    const db = openDb()
    db.exec(`CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('derivation')),
      stage TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL, stats_json TEXT
    )`)
    const result = recordReviseReason(db, { lineageId: 'ln_1', from: 1, to: 2, reason: 'r' })
    expect(result.traced).toBe(false)
    expect(result.note).toContain('kind 值域不含')
    expect((db.prepare('SELECT COUNT(*) AS c FROM map_migration_reports').get() as { c: number }).c).toBe(0)
  })

  it('审计表接受 workitem_revise 时写入操作审计行', () => {
    const db = openDb()
    db.exec(`CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('derivation','workitem_revise')),
      stage TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL, stats_json TEXT
    )`)
    const result = recordReviseReason(db, { lineageId: 'ln_1', from: 1, to: 2, reason: '补验收' })
    expect(result.traced).toBe(true)
    expect(result.sink).toBe('map_migration_reports')
    const row = db.prepare('SELECT kind, stage, stats_json FROM map_migration_reports').get() as {
      kind: string
      stage: string
      stats_json: string
    }
    expect(row.kind).toBe('workitem_revise')
    expect(row.stage).toBe('workitem_revise:ln_1:r1->r2')
    expect(JSON.parse(row.stats_json)).toEqual({ lineageId: 'ln_1', from: 1, to: 2, reason: '补验收' })
  })
})
