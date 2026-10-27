/**
 * 层级结构数据迁移测试
 *
 * 覆盖 runHierarchyMigration 的四步（顺序不可换）：
 *   清孤儿 → 回填 sort_index → default 边改写为 hierarchical → 补齐缺失的层级边
 *
 * 用真实 better-sqlite3（内存库）跑，不 mock repo。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runHierarchyMigration } from '../hierarchy-migration'

describe('runHierarchyMigration', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
        title TEXT NOT NULL, graph_id TEXT NOT NULL, graph_type TEXT NOT NULL,
        parent_id TEXT, sort_index INTEGER, collapsed INTEGER NOT NULL DEFAULT 0,
        position_x REAL NOT NULL, position_y REAL NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
        edge_type TEXT, graph_id TEXT NOT NULL
      );
      INSERT INTO nodes VALUES
        ('p1','project','confirmed','项目','g1','online',NULL,NULL,0,0,0,'t','t'),
        ('m1','module','draft','模块','g1','online','p1',NULL,0,0,0,'t','t'),
        ('c1','process','draft','流程','g1','online','m1',NULL,0,0,0,'t','t'),
        ('orphan','feature','draft','孤儿','g1','online','gone',NULL,0,0,0,'t','t');
      INSERT INTO edges VALUES
        ('e1','p1','m1','default','g1'),
        ('e2','m1','c1','default','g1'),
        ('e3','p1','c1','business-flow','g1');
    `)
  })

  afterEach(() => { db.close() })

  it('clears orphan parent_id', () => {
    runHierarchyMigration(db)
    const row = db.prepare("SELECT parent_id FROM nodes WHERE id='orphan'").get() as { parent_id: string | null }
    expect(row.parent_id).toBeNull()
  })

  it('migrates parent-child default edges to hierarchical', () => {
    runHierarchyMigration(db)
    const rows = db.prepare("SELECT id, edge_type FROM edges ORDER BY id").all() as { id: string; edge_type: string }[]
    expect(rows.find(r => r.id === 'e1')!.edge_type).toBe('hierarchical')
    expect(rows.find(r => r.id === 'e2')!.edge_type).toBe('hierarchical')
    expect(rows.find(r => r.id === 'e3')!.edge_type).toBe('business-flow')
  })

  it('backfills sort_index in sibling order', () => {
    runHierarchyMigration(db)
    const row = db.prepare("SELECT sort_index FROM nodes WHERE id='m1'").get() as { sort_index: number | null }
    expect(row.sort_index).toBe(0)
  })

  it('adds missing hierarchical edge for parented node', () => {
    db.prepare("INSERT INTO nodes VALUES ('m2','module','draft','模块2','g1','online','p1',NULL,0,0,0,'t','t')").run()
    runHierarchyMigration(db)
    const row = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='hierarchical' AND source='p1' AND target='m2'").get() as { n: number }
    expect(row.n).toBe(1)
  })

  it('is idempotent', () => {
    runHierarchyMigration(db)
    const before = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    runHierarchyMigration(db)
    const after = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('keeps the inserted hierarchical edge on the child graph', () => {
    db.prepare("INSERT INTO nodes VALUES ('m2','module','draft','模块2','g1','online','p1',NULL,0,0,0,'t','t')").run()
    runHierarchyMigration(db)
    const row = db.prepare("SELECT source, target, edge_type, graph_id FROM edges WHERE target='m2'").get() as {
      source: string; target: string; edge_type: string; graph_id: string
    }
    expect(row.source).toBe('p1')
    expect(row.target).toBe('m2')
    expect(row.edge_type).toBe('hierarchical')
    expect(row.graph_id).toBe('g1')
  })

  it('orders siblings by the parent edge list', () => {
    db.prepare("INSERT INTO nodes VALUES ('s1','module','draft','S1','g1','online','p1',NULL,0,0,0,'t','t')").run()
    db.prepare("INSERT INTO nodes VALUES ('s2','module','draft','S2','g1','online','p1',NULL,0,0,0,'t','t')").run()
    db.prepare("INSERT INTO edges VALUES ('e4','p1','s1','default','g1')").run()
    db.prepare("INSERT INTO edges VALUES ('e5','p1','s2','default','g1')").run()
    runHierarchyMigration(db)
    const rows = db.prepare(
      "SELECT id, sort_index FROM nodes WHERE parent_id='p1' ORDER BY sort_index"
    ).all() as { id: string; sort_index: number }[]
    // p1 的边列表顺序为 e1(m1) → e3(c1, 语义边) → e4(s1) → e5(s2)
    expect(rows.map(r => r.id)).toEqual(['m1', 's1', 's2'])
    expect(rows.map(r => r.sort_index)).toEqual([0, 1, 2])
  })

  it('falls back to created_at for children without an edge row', () => {
    // s1/s2 没有任何边，只能按 created_at 兜底；且它们的 created_at 比 m1 更早，
    // 但 m1 有边（位置确定），所以仍排在前面 —— 兜底不插队打乱既有顺序。
    db.prepare("INSERT INTO nodes VALUES ('s1','module','draft','S1','g1','online','p1',NULL,0,0,0,'2026-01-01','t')").run()
    db.prepare("INSERT INTO nodes VALUES ('s2','module','draft','S2','g1','online','p1',NULL,0,0,0,'2026-01-02','t')").run()
    runHierarchyMigration(db)
    const rows = db.prepare(
      "SELECT id, sort_index FROM nodes WHERE parent_id='p1' ORDER BY sort_index"
    ).all() as { id: string; sort_index: number }[]
    expect(rows.map(r => r.id)).toEqual(['m1', 's1', 's2'])
    expect(rows.map(r => r.sort_index)).toEqual([0, 1, 2])
  })

  it('leaves root nodes without a sort_index', () => {
    runHierarchyMigration(db)
    const row = db.prepare("SELECT sort_index FROM nodes WHERE id='p1'").get() as { sort_index: number | null }
    expect(row.sort_index).toBeNull()
  })

  it('leaves the orphan node without a sort_index once its parent is cleared', () => {
    runHierarchyMigration(db)
    const row = db.prepare("SELECT sort_index FROM nodes WHERE id='orphan'").get() as { sort_index: number | null }
    expect(row.sort_index).toBeNull()
  })
})
