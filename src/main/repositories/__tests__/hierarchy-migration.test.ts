/**
 * 层级结构数据迁移测试
 *
 * 覆盖 runHierarchyMigration 的四步（顺序不可换）：
 *   清孤儿 → 回填 sort_index → default 边改写为 hierarchical → 补齐缺失的层级边
 *
 * 用真实 better-sqlite3（内存库）跑，不 mock repo。
 *
 * 本文件的 fixture 是**自包含**的最小表（`nodes` 取真实 `nodes` 表 25 列的一个子集），
 * 真实 schema 的覆盖在 `src/main/__tests__/database-migration.test.ts`（它用 `initDatabase()`
 * 的真表，存量升级那条用例会真跑一遍 `runHierarchyMigration`）。
 *
 * fixture 内的 INSERT 一律写全列名 —— 理由是**本文件自己的 fixture 会改**：
 * 一旦加列，位置写法会静默写错列而不报错。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runHierarchyMigration } from '../hierarchy-migration'

/**
 * fixture 的 `nodes` 列清单：真实 `nodes` 表 25 列的一个**子集**。
 * 迁移真正读写的列是 `id` / `parent_id` / `sort_index` / `created_at` / `graph_id`；
 * `type` / `status` / `title` / `graph_type` / `position_x` / `position_y` 在这里是为了
 * 满足 fixture 建表的 NOT NULL 约束（迁移本身不碰它们）；
 * 另带 `collapsed` 以对齐真实表的形状（真实表里它是 NOT NULL DEFAULT 0，
 * 迁移本身不碰它）。
 */
const NODE_COLUMNS =
  'id, type, status, title, graph_id, graph_type, parent_id, sort_index, collapsed, position_x, position_y, created_at, updated_at'

/** fixture 的 `edges` 列清单（真实 `edges` 表 10 列的子集） */
const EDGE_COLUMNS = 'id, source, target, edge_type, graph_id'

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
    `)
    const insertNode = db.prepare(
      `INSERT INTO nodes (${NODE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    insertNode.run('p1', 'project', 'confirmed', '项目', 'g1', 'online', null, null, 0, 0, 0, 't', 't')
    insertNode.run('m1', 'module', 'draft', '模块', 'g1', 'online', 'p1', null, 0, 0, 0, 't', 't')
    insertNode.run('c1', 'process', 'draft', '流程', 'g1', 'online', 'm1', null, 0, 0, 0, 't', 't')
    insertNode.run('orphan', 'feature', 'draft', '孤儿', 'g1', 'online', 'gone', null, 0, 0, 0, 't', 't')
    const insertEdge = db.prepare(
      `INSERT INTO edges (${EDGE_COLUMNS}) VALUES (?,?,?,?,?)`,
    )
    insertEdge.run('e1', 'p1', 'm1', 'default', 'g1')
    insertEdge.run('e2', 'm1', 'c1', 'default', 'g1')
    insertEdge.run('e3', 'p1', 'c1', 'business-flow', 'g1')
  })

  afterEach(() => { db.close() })

  /** 插一个子节点（默认：g1 图、module 类型、created_at='t'、sort_index 为 NULL） */
  const addChild = (
    id: string,
    options: {
      parentId?: string | null
      createdAt?: string
      sortIndex?: number | null
      graphId?: string
    } = {},
  ): void => {
    const parentId = options.parentId === undefined ? 'p1' : options.parentId
    const createdAt = options.createdAt ?? 't'
    const sortIndex = options.sortIndex ?? null
    const graphId = options.graphId ?? 'g1'
    db.prepare(
      `INSERT INTO nodes (${NODE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, 'module', 'draft', id, graphId, 'online', parentId, sortIndex, 0, 0, 0, createdAt, createdAt)
  }

  it('clears orphan parent_id', () => {
    runHierarchyMigration(db)
    const row = db.prepare("SELECT parent_id FROM nodes WHERE id='orphan'").get() as { parent_id: string | null }
    expect(row.parent_id).toBeNull()
  })

  it('clears orphan parent_id even when the nodes table holds a NULL id', () => {
    // SQLite 允许 PRIMARY KEY 列为 NULL。此时 NOT IN 的集合里含 NULL，
    // 整个谓词对每一行都变成 NULL —— 一个孤儿都清不掉。NOT EXISTS 不受影响。
    db.prepare(
      `INSERT INTO nodes (${NODE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(null, 'module', 'draft', '空 id', 'g1', 'online', null, null, 0, 0, 0, 't', 't')

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
    addChild('m2')
    runHierarchyMigration(db)
    const row = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type='hierarchical' AND source='p1' AND target='m2'").get() as { n: number }
    expect(row.n).toBe(1)
  })

  it('keeps the inserted hierarchical edge on the child graph', () => {
    addChild('m2')
    runHierarchyMigration(db)
    const row = db.prepare("SELECT source, target, edge_type, graph_id FROM edges WHERE target='m2'").get() as {
      source: string; target: string; edge_type: string; graph_id: string
    }
    expect(row.source).toBe('p1')
    expect(row.target).toBe('m2')
    expect(row.edge_type).toBe('hierarchical')
    expect(row.graph_id).toBe('g1')
  })

  it('does not add a hierarchical edge when the parent lives in another graph', () => {
    // 父节点在 g1、子节点在 g2 —— 存量脏数据。迁移不该「制造」一条跨图边。
    addChild('x1', { graphId: 'g2' })
    runHierarchyMigration(db)
    const row = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE target='x1'").get() as { n: number }
    expect(Number(row.n)).toBe(0)
  })

  it('orders siblings by the parent edge list', () => {
    addChild('s1')
    addChild('s2')
    db.prepare(`INSERT INTO edges (${EDGE_COLUMNS}) VALUES (?,?,?,?,?)`).run('e4', 'p1', 's1', 'default', 'g1')
    db.prepare(`INSERT INTO edges (${EDGE_COLUMNS}) VALUES (?,?,?,?,?)`).run('e5', 'p1', 's2', 'default', 'g1')
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
    addChild('s1', { createdAt: '2026-01-01' })
    addChild('s2', { createdAt: '2026-01-02' })
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

  it('does not overwrite an existing sort_index', () => {
    db.prepare("UPDATE nodes SET sort_index = 7 WHERE id = 'm1'").run()
    runHierarchyMigration(db)
    const row = db.prepare("SELECT sort_index FROM nodes WHERE id='m1'").get() as { sort_index: number }
    expect(row.sort_index).toBe(7)
  })

  it('appends newly filled siblings after the existing max sort_index', () => {
    db.prepare("UPDATE nodes SET sort_index = 3 WHERE id = 'm1'").run()
    addChild('s1')
    runHierarchyMigration(db)
    const rows = db.prepare(
      "SELECT id, sort_index FROM nodes WHERE parent_id='p1' ORDER BY sort_index"
    ).all() as { id: string; sort_index: number }[]
    expect(rows.map(r => r.id)).toEqual(['m1', 's1'])
    expect(rows.map(r => r.sort_index)).toEqual([3, 4])
  })

  it('is idempotent', () => {
    runHierarchyMigration(db)
    const firstNodes = db.prepare('SELECT id, parent_id, sort_index FROM nodes ORDER BY id').all()
    const firstEdges = db.prepare('SELECT id, source, target, edge_type FROM edges ORDER BY id').all()

    runHierarchyMigration(db)
    const secondNodes = db.prepare('SELECT id, parent_id, sort_index FROM nodes ORDER BY id').all()
    const secondEdges = db.prepare('SELECT id, source, target, edge_type FROM edges ORDER BY id').all()

    // 边行数是稳定的，比它更能暴露漂移的是 sort_index —— 必须一起比
    expect(secondNodes).toEqual(firstNodes)
    expect(secondEdges).toEqual(firstEdges)
  })

  it('is idempotent for a batch of children sharing one created_at', () => {
    // 一批**无层级边**的子节点，共用同一个 created_at —— AI 批量生成的形状
    // （graph-service.ts 给整批节点绑同一个 now）。兜底排序退化成对 id 的
    // 字典序比较，而补边按插入序 —— 两者不一致时两次启动会得到不同的 sort_index。
    //
    // ⚠️ 插入顺序与 id 字典序**故意错开**：真实批量子节点的 id 是随机 uuid，
    // 字典序与插入序几乎必然不一致。reviewer 量的 200/200 翻转正是这个形状。
    // 若按 id 升序插入（s0..s7），字典序恰好等于插入序，兜底序与补边序一致 ——
    // 翻转就被掩盖掉了，用例变成假绿。这里倒序插入把「不一致」确定性地钉住。
    const now = '2026-01-01T00:00:00.000Z'
    const ins = db.prepare(
      `INSERT INTO nodes (${NODE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (let i = 7; i >= 0; i--) {
      ins.run(`s${i}`, 'module', 'draft', `S${i}`, 'g1', 'online', 'p1', null, 0, 0, 0, now, now)
    }

    runHierarchyMigration(db)
    const first = db.prepare('SELECT id, sort_index FROM nodes ORDER BY id').all()
    const firstEdges = db.prepare('SELECT id, source, target, edge_type FROM edges ORDER BY id').all()

    runHierarchyMigration(db)
    const second = db.prepare('SELECT id, sort_index FROM nodes ORDER BY id').all()
    const secondEdges = db.prepare('SELECT id, source, target, edge_type FROM edges ORDER BY id').all()

    expect(second).toEqual(first)
    expect(secondEdges).toEqual(firstEdges)
  })

  it('keeps the sort_index a reparent wrote (reparent → next startup)', () => {
    // 端到端复现：reparent 把 b 从 p1 挂到 p2 下（追加到末尾），并改写旧层级边的
    // source（保留 rowid）。迁移下次启动时若按边顺序重新推导，b 会从末尾跳到最前。
    const reparentDb = new Database(':memory:')
    reparentDb.exec(`
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
      INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, sort_index, collapsed, position_x, position_y, created_at, updated_at) VALUES
        ('p1','project','confirmed','P1','g1','online',NULL,NULL,0,0,0,'t','t'),
        ('p2','project','confirmed','P2','g1','online',NULL,NULL,0,0,0,'t','t'),
        ('a','module','draft','A','g1','online','p1',NULL,0,0,0,'t','t'),
        ('b','module','draft','B','g1','online','p1',NULL,0,0,0,'t','t'),
        ('c','module','draft','C','g1','online','p2',NULL,0,0,0,'t','t'),
        ('d','module','draft','D','g1','online','p2',NULL,0,0,0,'t','t');
      INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES
        ('e1','p1','a','default','g1'),
        ('e2','p1','b','default','g1'),
        ('e3','p2','c','default','g1'),
        ('e4','p2','d','default','g1');
    `)

    runHierarchyMigration(reparentDb)

    // 模拟 reparent：把 b 挂到 p2 下。旧的层级边只改 source（保留 rowid）。
    reparentDb.prepare("UPDATE nodes SET parent_id = 'p2' WHERE id = 'b'").run()
    reparentDb.prepare("UPDATE edges SET source = 'p2' WHERE id = 'e2'").run()
    reparentDb.prepare("UPDATE nodes SET sort_index = 2 WHERE id = 'b'").run()

    const before = reparentDb.prepare(
      "SELECT id, sort_index FROM nodes WHERE parent_id='p2' ORDER BY sort_index"
    ).all()

    runHierarchyMigration(reparentDb)

    const after = reparentDb.prepare(
      "SELECT id, sort_index FROM nodes WHERE parent_id='p2' ORDER BY sort_index"
    ).all()

    reparentDb.close()
    expect(after).toEqual(before)
  })
})
