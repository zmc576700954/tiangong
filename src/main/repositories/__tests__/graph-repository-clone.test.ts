/**
 * GraphRepository.cloneGraphNodes 的真实库测试。
 *
 * 这里必须用真实的 better-sqlite3，而不是 `src/main/__tests__/graph-repository.test.ts`
 * 里那种 mock db —— 克隆路径是多语句的读写序列（Pass 1 插节点 / Pass 2 重映射 parent_id /
 * Pass 3 复制边），mock 掉 `prepare` 之后测不出任何真实行为。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-graph-clone-test-' + process.pid)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? TEST_USER_DATA : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../../database'
import { GraphRepository } from '../graph-repository'

describe('GraphRepository.cloneGraphNodes — 新列与层级边', () => {
  let db: ReturnType<typeof getClient>
  let repo: GraphRepository

  beforeAll(() => {
    // 清掉可能残留的旧库：目录名带 pid，pid 复用时可能命中上一次的库，
    // 导致 `INSERT INTO graphs` 撞 UNIQUE 约束。用例应当是确定性的。
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    initDatabase()
    db = getClient()
    repo = new GraphRepository(db)
    const now = new Date().toISOString()
    const insGraph = db.prepare(
      'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?,?,?,?,?,?)'
    )
    insGraph.run('g_on', 'Online', 'online', '/p', now, now)
    insGraph.run('g_dev', 'Dev', 'dev', '/p', now, now)

    const ins = db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, sort_index, collapsed, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    ins.run('p1', 'project', 'confirmed', 'P1', 'g_on', 'online', null, null, 0, 0, 0, now, now)
    ins.run('m1', 'module', 'draft', 'M1', 'g_on', 'online', 'p1', 0, 1, 0, 0, now, now)
    ins.run('m2', 'module', 'draft', 'M2', 'g_on', 'online', 'p1', 1, 0, 0, 0, now, now)

    const insEdge = db.prepare(
      'INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES (?,?,?,?,?)'
    )
    insEdge.run('e1', 'p1', 'm1', 'hierarchical', 'g_on')
    insEdge.run('e2', 'p1', 'm2', 'hierarchical', 'g_on')
  })

  beforeEach(() => {
    // `cloneGraphNodes` 是**追加**语义 —— 它不清空目标图（生产里目标图每次都是新建的，
    // 所以没人踩到）。但测试里两个用例共用同一个 db、同一个固定的 'g_dev' 图 id：
    // 第二个用例会看到第一个用例克隆出来的残留 → 边数翻倍 →
    // 断言「dev 图里有 2 条 hierarchical 边」必红（4 ≠ 2）。
    // 所以每个用例前先把 dev 图清空；edges 靠 nodes 的 ON DELETE CASCADE 一起清掉
    // （`PRAGMA foreign_keys = ON` 在 `initDatabase()` 里已开）。
    db.prepare("DELETE FROM nodes WHERE graph_id = 'g_dev'").run()
  })

  afterAll(() => { closeDatabase() })

  it('clones sort_index but resets collapsed', () => {
    repo.cloneGraphNodes('g_on', 'g_dev', 'dev')
    const rows = db.prepare(
      "SELECT title, sort_index, collapsed FROM nodes WHERE graph_id='g_dev'"
    ).all() as { title: string; sort_index: number | null; collapsed: number }[]
    const p1 = rows.find((r) => r.title === 'P1')!
    const m1 = rows.find((r) => r.title === 'M1')!
    const m2 = rows.find((r) => r.title === 'M2')!
    expect(m1.sort_index).toBe(0)
    expect(m2.sort_index).toBe(1)
    // 源图 M1 的 collapsed 是 1，克隆到 dev 图必须重置为 0（折叠是开发者视角）
    expect(m1.collapsed).toBe(0)
    // 根节点的 sort_index 在源图是 NULL，克隆后必须**保留 NULL** ——
    // 根节点没有兄弟，序号对它没有意义，不能被 `?? 0` 之类的兜底改成 0。
    expect(p1.sort_index).toBeNull()
  })

  it('remaps hierarchical edges to the cloned node ids', () => {
    repo.cloneGraphNodes('g_on', 'g_dev', 'dev')
    const devNodes = db.prepare(
      "SELECT id, title, parent_id FROM nodes WHERE graph_id='g_dev'"
    ).all() as { id: string; title: string; parent_id: string | null }[]
    const titleById = new Map(devNodes.map((n) => [n.id, n.title]))
    const edges = db.prepare(
      "SELECT source, target FROM edges WHERE graph_id='g_dev' AND edge_type='hierarchical'"
    ).all() as { source: string; target: string }[]

    expect(edges).toHaveLength(2)
    for (const e of edges) {
      // 边的两端必须是 dev 图里的节点（id 被重映射过），且与 parent_id 自洽
      expect(titleById.get(e.source)).toBe('P1')
      const child = devNodes.find((n) => n.id === e.target)!
      expect(child.parent_id).toBe(e.source)
    }
  })

  it('normalizes a parent_id that is not a real node into a root', () => {
    // 第三个用例自带一对图（'g_on2' → 'g_dev2'）与第三张图（'g_other'），
    // 完全不动前两个用例的 'g_on' / 'g_dev' —— 悬挂节点留在源图里也不会影响它们。
    const now = new Date().toISOString()
    const insGraph = db.prepare(
      'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?,?,?,?,?,?)'
    )
    insGraph.run('g_other', 'Other', 'online', '/p', now, now)
    insGraph.run('g_on2', 'Online2', 'online', '/p', now, now)
    insGraph.run('g_dev2', 'Dev2', 'dev', '/p', now, now)

    const ins = db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, sort_index, collapsed, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    // 父节点住在**另一张图**里 —— parent_id 没有外键，这种脏数据是可能存在的
    ins.run('x_other', 'project', 'confirmed', 'XOther', 'g_other', 'online', null, null, 0, 0, 0, now, now)
    ins.run('x1', 'module', 'draft', 'X1', 'g_on2', 'online', 'x_other', 0, 0, 0, 0, now, now)
    // 父节点是**空串** —— 也不是真实节点 id。空串在正常写入路径上可达
    // （node-repository 的 `data.parentId ?? null` / `String(data.parentId)` 都放行 ''），
    // 而 hierarchy-service 的子节点查询没有 graph_id 过滤 → `WHERE parent_id = ''`
    // 会命中每一张图里父 id 为空串的节点。
    ins.run('x2', 'module', 'draft', 'X2', 'g_on2', 'online', '', 0, 0, 0, 0, now, now)

    repo.cloneGraphNodes('g_on2', 'g_dev2', 'dev')

    const devNodes = db.prepare(
      "SELECT title, parent_id FROM nodes WHERE graph_id='g_dev2'"
    ).all() as { title: string; parent_id: string | null }[]
    const x1 = devNodes.find((n) => n.title === 'X1')!
    const x2 = devNodes.find((n) => n.title === 'X2')!
    // 源图的 parent_id 指向另一张图的节点 → 克隆节点在 dev 图里必须是根节点。
    // 否则 hierarchy-service.collectDescendants（子节点查询没有 graph_id 过滤）
    // 会顺着这条悬挂关系走进 online 图。
    expect(x1.parent_id).toBeNull()
    // 空串同样不是真实父 id → 克隆后归一为 NULL（根节点）
    expect(x2.parent_id).toBeNull()
  })
})
