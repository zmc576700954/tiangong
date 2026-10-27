/**
 * HierarchyService.reparent 测试
 *
 * 跑在**真实库**上（initDatabase() + electron mock）：
 * 真实的 nodes 表有 25 列、edges 表有 10 列，且带 CHECK 约束与外键 ——
 * 手搓「最小 schema」会让「测试绿、线上炸」这一类缺陷从缝里漏过去
 * （列名不对齐的 INSERT、非法 type/status/graph_type、悬空外键）。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'

const electronPaths = vi.hoisted(() => ({ userData: '' }))

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-hierarchy-test-' + process.pid)
electronPaths.userData = TEST_USER_DATA

// Mock electron —— initDatabase() 依赖 app.getPath('userData')
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return electronPaths.userData
      return os.tmpdir()
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../../database'
import { HierarchyService } from '../hierarchy-service'
import { ErrorCode, HierarchyError } from '../../errors'

/** fixture 的时间戳 —— 固定值，避免用例依赖「现在几点」 */
const NOW = '2026-01-01T00:00:00.000Z'

let db: BetterSqlite3.Database

/**
 * fixture：
 *
 *   p1 (project,  parent NULL)
 *   ├── m1 (project, parent p1)
 *   │   └── c1 (process, parent m1)
 *   │       └── f1 (feature, parent c1)
 *   ├── m2 (module,  parent p1)
 *   │   └── c3 (process, parent m2)
 *
 * c3 存在的唯一理由：给 m2 提供**另一个**子节点 —— 没有它，
 * 「平移后的子树不与目标父节点的其他子节点重叠」就是一条空断言。
 *
 * ⚠️ m1 的类型是 'project' 而不是 brief 写的 'module' —— brief 的 fixture 让
 * m2（module）挂到 m1（module）下，而权威类型规则（spec §4.6）**禁止**这件事：
 * module.allowedChildTypes = ['process','wiki-page']、module.allowedParentTypes = ['project']。
 * brief 的 9 个用例里有 3 个（'moves a node to a new parent'、
 * 'updates the hierarchical edge...'、'renumbers sibling sort_index'）依赖这次
 * 「成功的移动」，所以 fixture 必须调一处：把 m1 改成 'project'（project 能挂 module），
 * 9 个用例的调用与断言**全部原样保留**。
 *
 * 只改 m1 一处不是偷懒：穷举 6 种内置类型的全部 6^6 = 46656 种组合后，
 * **没有任何**组合能同时满足「9 个用例全过」与「fixture 的 5 条父子边全部类型合法」
 * —— module 能挂的子类型只有 process/wiki-page，而 process/wiki-page 的父类型里
 * 没有 module 能容纳的合法位置，二者互斥。
 */
function seedFixture(database: BetterSqlite3.Database): void {
  const insertNode = database.prepare(
    'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, sort_index, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  )
  // 同一父节点下的兄弟写显式 sort_index（0,1,2,…）——
  // 全是 NULL 的话 reparent 的 MAX 兜底取到 0，用例会失去区分度
  insertNode.run('p1', 'project', 'confirmed', 'P1', 'g1', 'online', null, null, 0, 0, NOW, NOW)
  insertNode.run('m1', 'project', 'confirmed', 'M1', 'g1', 'online', 'p1', 0, 0, 0, NOW, NOW)
  insertNode.run('m2', 'module', 'draft', 'M2', 'g1', 'online', 'p1', 1, 0, 0, NOW, NOW)
  insertNode.run('c1', 'process', 'draft', 'C1', 'g1', 'online', 'm1', 0, 0, 0, NOW, NOW)
  insertNode.run('f1', 'feature', 'draft', 'F1', 'g1', 'online', 'c1', 0, 0, 0, NOW, NOW)
  insertNode.run('c3', 'process', 'draft', 'C3', 'g1', 'online', 'm2', 0, 0, 0, NOW, NOW)

  const insertEdge = database.prepare(
    "INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES (?,?,?,?,?)"
  )
  insertEdge.run('e1', 'p1', 'm1', 'hierarchical', 'g1')
  insertEdge.run('e2', 'm1', 'c1', 'hierarchical', 'g1')
  insertEdge.run('e3', 'c1', 'f1', 'hierarchical', 'g1')
  insertEdge.run('e4', 'p1', 'm2', 'hierarchical', 'g1')
  insertEdge.run('e5', 'm2', 'c3', 'hierarchical', 'g1')
}

describe('HierarchyService.reparent', () => {
  beforeAll(() => {
    // 清掉上一次运行残留的库文件，保证 fixture 从空表开始
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    initDatabase()
    db = getClient()
  })

  afterAll(() => {
    closeDatabase()
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM edges').run()
    db.prepare('DELETE FROM nodes').run()
    seedFixture(db)
  })

  it('moves a node to a new parent', () => {
    const svc = new HierarchyService(db)
    const res = svc.reparent('m2', 'm1')
    expect(res.newParentId).toBe('m1')
    const row = db.prepare("SELECT parent_id FROM nodes WHERE id='m2'").get() as { parent_id: string }
    expect(row.parent_id).toBe('m1')
  })

  it('updates the hierarchical edge in the same transaction', () => {
    const svc = new HierarchyService(db)
    svc.reparent('m2', 'm1')
    const rows = db.prepare("SELECT source, target FROM edges WHERE edge_type='hierarchical'").all() as { source: string; target: string }[]
    expect(rows).toContainEqual({ source: 'm1', target: 'm2' })
    expect(rows).not.toContainEqual({ source: 'p1', target: 'm2' })
  })

  it('rejects reparenting a node under its own descendant', () => {
    const svc = new HierarchyService(db)
    expect(() => svc.reparent('m1', 'f1')).toThrow()
    try {
      svc.reparent('m1', 'f1')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(HierarchyError)
      expect((e as HierarchyError).code).toBe(ErrorCode.HIERARCHY_CYCLE)
    }
  })

  it('rejects reparenting a node under itself', () => {
    const svc = new HierarchyService(db)
    try {
      svc.reparent('m1', 'm1')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(HierarchyError)
      expect((e as HierarchyError).code).toBe(ErrorCode.HIERARCHY_SELF_PARENT)
    }
  })

  it('rejects a type-invalid reparent', () => {
    const svc = new HierarchyService(db)
    try {
      svc.reparent('f1', 'm1')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(HierarchyError)
      expect((e as HierarchyError).code).toBe(ErrorCode.HIERARCHY_TYPE_INVALID)
    }
  })

  it('rejects a cross-graph reparent', () => {
    const svc = new HierarchyService(db)
    db.prepare(
      "INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run('x1', 'feature', 'draft', '跨图', 'g2', 'dev', null, 0, 0, NOW, NOW)
    try {
      svc.reparent('x1', 'c1')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(HierarchyError)
      expect((e as HierarchyError).code).toBe(ErrorCode.HIERARCHY_CROSS_GRAPH)
    }
  })

  it('moves the whole subtree when reparenting', () => {
    const svc = new HierarchyService(db)
    const res = svc.reparent('c1', 'm2')
    const ids = res.movedPositions.map((p) => p.id).sort()
    expect(ids).toEqual(['c1', 'f1'])
  })

  it('renumbers sibling sort_index', () => {
    const svc = new HierarchyService(db)
    svc.reparent('m2', 'm1')
    const row = db.prepare("SELECT sort_index FROM nodes WHERE id='m2'").get() as { sort_index: number }
    expect(row.sort_index).toBeGreaterThan(0)
  })

  it('places the moved subtree clear of the new parent other children', () => {
    const svc = new HierarchyService(db)
    const res = svc.reparent('c1', 'm2')
    const sibling = db.prepare(
      "SELECT position_x, position_y FROM nodes WHERE id='c3'"
    ).get() as { position_x: number; position_y: number }
    for (const moved of res.movedPositions) {
      expect(moved.x === sibling.position_x && moved.y === sibling.position_y).toBe(false)
    }
  })

  // brief 的 9 个用例之外补的一条：旧父对上的层级边还是迁移前的 'default' 形态。
  // 该对上没有 'hierarchical' 边 → 它是层级边（不是语义边），改写成 'hierarchical' 并挪到新父。
  it('promotes a legacy default hierarchy edge on the old parent pair', () => {
    db.prepare("UPDATE edges SET edge_type = 'default' WHERE source = 'p1' AND target = 'm2'").run()
    const svc = new HierarchyService(db)
    svc.reparent('m2', 'm1')
    const rows = db
      .prepare("SELECT source, target, edge_type FROM edges WHERE target = 'm2'")
      .all() as { source: string; target: string; edge_type: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('m1')
    expect(rows[0].edge_type).toBe('hierarchical')
  })

  // 'default' 同时是**用户手画的语义边类型**（EdgeEditor 的 SUPPORTED_EDGE_TYPES 第一项）
  // 与 AI 写入路径的默认类型 —— 层级边的识别必须靠「父子关系」而不是 edge_type，
  // 否则这条语义边会被改类型或被删掉，用户的连线就从画布上消失。
  it('keeps a user-drawn default semantic edge on the new parent pair', () => {
    db.prepare(
      "INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES (?,?,?,?,?)"
    ).run('sem1', 'm1', 'm2', 'default', 'g1')
    const svc = new HierarchyService(db)
    svc.reparent('m2', 'm1')

    const semantic = db
      .prepare("SELECT source, target, edge_type FROM edges WHERE id = 'sem1'")
      .get() as { source: string; target: string; edge_type: string } | undefined
    expect(semantic).toBeDefined()
    expect(semantic?.source).toBe('m1')
    expect(semantic?.target).toBe('m2')
    expect(semantic?.edge_type).toBe('default')

    const hierarchy = db
      .prepare("SELECT id FROM edges WHERE source = 'm1' AND target = 'm2' AND edge_type = 'hierarchical'")
      .all() as { id: string }[]
    expect(hierarchy).toHaveLength(1)
  })

  it('keeps a user-drawn default semantic edge on the old parent pair', () => {
    // 旧父对 (p1,m2) 上已有 'hierarchical' 边 e4 → 同对的 'default' 边是语义边，原样保留
    db.prepare(
      "INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES (?,?,?,?,?)"
    ).run('sem2', 'p1', 'm2', 'default', 'g1')
    const svc = new HierarchyService(db)
    svc.reparent('m2', 'm1')

    const semantic = db
      .prepare("SELECT source, target, edge_type FROM edges WHERE id = 'sem2'")
      .get() as { source: string; target: string; edge_type: string } | undefined
    expect(semantic).toBeDefined()
    expect(semantic?.source).toBe('p1')
    expect(semantic?.target).toBe('m2')
    expect(semantic?.edge_type).toBe('default')
  })

  it('is a no-op when reparenting a node to its current parent', () => {
    // 给子树一个非原点坐标 —— fixture 默认全在 (0,0)，
    // 那样「坐标不变」与「坐标被写成 (0,0)」分不开，断言就没有意义
    db.prepare("UPDATE nodes SET position_x = 10, position_y = 20 WHERE id IN ('m2','c3')").run()
    const before = db.prepare("SELECT updated_at FROM nodes WHERE id='m2'").get() as { updated_at: string }

    const svc = new HierarchyService(db)
    const res = svc.reparent('m2', 'p1') // m2 的当前父节点就是 p1
    expect(res.oldParentId).toBe('p1')
    expect(res.newParentId).toBe('p1')

    const row = db
      .prepare("SELECT parent_id, sort_index FROM nodes WHERE id='m2'")
      .get() as { parent_id: string; sort_index: number }
    expect(row.parent_id).toBe('p1')
    expect(row.sort_index).toBe(1)

    const positions = db
      .prepare("SELECT id, position_x, position_y FROM nodes WHERE id IN ('m2','c3') ORDER BY id")
      .all() as { id: string; position_x: number; position_y: number }[]
    expect(positions).toEqual([
      { id: 'c3', position_x: 10, position_y: 20 },
      { id: 'm2', position_x: 10, position_y: 20 },
    ])

    // movedPositions 仍然列出该节点及其后代
    expect(res.movedPositions.map((p) => p.id).sort()).toEqual(['c3', 'm2'])
    expect(res.movedPositions.every((p) => p.x === 10 && p.y === 20)).toBe(true)

    // 一个字节都没写：边没动、时间戳没动
    const edges = db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type = 'hierarchical'")
      .get() as { n: number }
    expect(edges.n).toBe(5)
    const after = db.prepare("SELECT updated_at FROM nodes WHERE id='m2'").get() as { updated_at: string }
    expect(after.updated_at).toBe(before.updated_at)
  })
})
