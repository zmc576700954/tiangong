/**
 * P1 — `entity_key` 回填正确且幂等（session-map 蓝图 §8.11）。
 *
 * 断言：
 *   - 覆盖率 100%：回填后 `entity_key IS NULL` 为 0；
 *   - 匹配率/错配 0：对称图里 online/dev 同构节点拿到同一键，不同节点不同键；
 *   - 幂等：第二次回填 0 行变化；
 *   - 唯一索引存在且拒绝重复键。
 *
 * 前提缺口：§8.11 要求“真实 DB 副本跑两次启动”。CI 不携带生产库副本，
 * 这里用合成夹具覆盖判定逻辑；真实副本的耗时/数据量归入 P2（同样标注）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { backfillProject, pairProjectGraphs } from '../../src/main/map-migration/entity-key-backfill'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      project_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
      graph_id TEXT NOT NULL, graph_type TEXT NOT NULL, parent_id TEXT,
      sort_index INTEGER, entity_key TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
      status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
    );
    CREATE UNIQUE INDEX idx_nodes_entity_key
      ON nodes(graph_id, entity_key) WHERE entity_key IS NOT NULL;
  `)
  return db
}

let seq = 0
function insertGraph(db: BetterSqlite3.Database, type: string, projectPath: string): string {
  const id = `g-${++seq}`
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, `graph-${id}`, type, projectPath, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
  )
  return id
}

function insertNode(
  db: BetterSqlite3.Database,
  opts: { graphId: string; title: string; parentId?: string | null; sortIndex?: number | null; type?: string },
): string {
  const id = `n-${++seq}`
  db.prepare(
    'INSERT INTO nodes (id, type, title, graph_id, graph_type, parent_id, sort_index, entity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
  ).run(
    id, opts.type ?? 'module', opts.title, opts.graphId, 'online', opts.parentId ?? null,
    opts.sortIndex ?? null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
  )
  return id
}

function keysOf(db: BetterSqlite3.Database, graphId: string): Map<string, string | null> {
  const rows = db.prepare('SELECT id, entity_key FROM nodes WHERE graph_id = ?').all(graphId) as Array<{ id: string; entity_key: string | null }>
  return new Map(rows.map((r) => [r.id, r.entity_key]))
}

describe('P1 entity_key 回填', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
    seq = 0
  })

  it('通过判据：覆盖率 100%、对称节点同键、错配 0、二次启动 0 变化', () => {
    const online = insertGraph(db, 'online', '/p1')
    const dev = insertGraph(db, 'dev', '/p1')
    const oRoot = insertNode(db, { graphId: online, type: 'project', title: '项目' })
    const oA = insertNode(db, { graphId: online, title: '登录', parentId: oRoot, sortIndex: 0 })
    const oB = insertNode(db, { graphId: online, title: '同名', parentId: oRoot, sortIndex: 1 })
    const oC = insertNode(db, { graphId: online, title: '同名', parentId: oRoot, sortIndex: 2 })
    const dRoot = insertNode(db, { graphId: dev, type: 'project', title: '项目' })
    const dA = insertNode(db, { graphId: dev, title: '登录', parentId: dRoot, sortIndex: 0 })
    const dB = insertNode(db, { graphId: dev, title: '同名', parentId: dRoot, sortIndex: 1 })
    const dC = insertNode(db, { graphId: dev, title: '同名', parentId: dRoot, sortIndex: 2 })

    const pairs = pairProjectGraphs(db)
    expect(pairs).toHaveLength(1)
    const stats = backfillProject(db, pairs[0])

    // 覆盖率：没有残留 NULL（null_after=0 → 覆盖率 100%）
    expect(stats.null_after).toBe(0)
    expect(stats.ambiguous).toBe(0)
    expect(stats.matched_exact).toBe(4)

    const oKeys = keysOf(db, online)
    const dKeys = keysOf(db, dev)
    // 同构节点同键（错配 0）
    expect(oKeys.get(oRoot)).toBe(dKeys.get(dRoot))
    expect(oKeys.get(oA)).toBe(dKeys.get(dA))
    expect(oKeys.get(oB)).toBe(dKeys.get(dB))
    expect(oKeys.get(oC)).toBe(dKeys.get(dC))
    // 不同节点不同键
    expect(new Set(oKeys.values()).size).toBe(oKeys.size)

    // 幂等：第二次 0 变化
    const before = { online: keysOf(db, online), dev: keysOf(db, dev) }
    const stats2 = backfillProject(db, pairs[0])
    expect(stats2.matched_exact).toBe(0)
    expect(stats2.null_before).toBe(0)
    expect({ online: keysOf(db, online), dev: keysOf(db, dev) }).toEqual(before)
  })

  it('通过判据：唯一索引存在且拒绝重复键', () => {
    const g = insertGraph(db, 'online', '/p1')
    insertNode(db, { graphId: g, title: 'a' })
    const row = db.prepare('SELECT id FROM nodes LIMIT 1').get() as { id: string }
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nodes_entity_key'")
      .get()
    expect(exists).toBeTruthy()

    expect(() =>
      db.prepare('UPDATE nodes SET entity_key = ? WHERE id = ?').run('k-dup', row.id),
    ).not.toThrow()
    // 同图第二个节点写相同键 → 唯一索引冲突
    db.prepare(
      'INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
    ).run('n-dup', 'module', 'b', g, 'online', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    expect(() =>
      db.prepare('UPDATE nodes SET entity_key = ? WHERE id = ?').run('k-dup', 'n-dup'),
    ).toThrow(/UNIQUE/)
  })
})
