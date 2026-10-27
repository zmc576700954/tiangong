/**
 * NodeRepository —— 层级相关行为
 *
 * 兄弟顺序（sort_index）、折叠标志（collapsed）、删父节点时子节点置根。
 *
 * 跑在**真实库**上（initDatabase() + electron mock）：
 * `rowToNode` 读了 20+ 列，手搓「最小 schema」不是「漏列」（no such column）
 * 就是「多列」（与真实 schema 漂移）。initDatabase() 给的是真表。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const electronPaths = vi.hoisted(() => ({ userData: '' }))

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-node-repo-test-' + process.pid)
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
import { NodeRepository } from '../node-repository'

describe('NodeRepository — 层级相关行为', () => {
  let db: ReturnType<typeof getClient>
  let nodeRepo: NodeRepository

  beforeAll(() => {
    // 清掉上一次运行残留的库文件，保证 fixture 从空表开始
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    initDatabase()
    db = getClient()
    nodeRepo = new NodeRepository(db)
    const now = new Date().toISOString()
    const ins = db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    ins.run('c1', 'process', 'draft', 'C1', 'g1', 'online', 'm1', 0, 0, now, now)
    ins.run('f1', 'feature', 'draft', 'F1', 'g1', 'online', 'c1', 0, 0, now, now)
  })

  afterAll(() => {
    closeDatabase()
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
  })

  it('orphans become root nodes when their parent is deleted', () => {
    nodeRepo.delete('c1')
    const row = db.prepare("SELECT parent_id FROM nodes WHERE id='f1'").get() as { parent_id: string | null }
    expect(row.parent_id).toBeNull()
  })

  it('round-trips the collapsed flag through update', () => {
    const updated = nodeRepo.update('f1', { collapsed: true })
    expect(updated.collapsed).toBe(true)
    const raw = db.prepare("SELECT collapsed FROM nodes WHERE id='f1'").get() as { collapsed: number }
    expect(raw.collapsed).toBe(1)
    const cleared = nodeRepo.update('f1', { collapsed: false })
    expect(cleared.collapsed).toBe(false)
  })

  it('assigns sort_index to a new child as max(siblings) + 1', () => {
    // spec §4.8：新建子节点时取父节点现有子节点中最大的 sort_index + 1
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run('p_sort', 'module', 'draft', 'P', 'g1', 'online', null, 0, 0, now, now)

    const mk = (title: string) => nodeRepo.create({
      type: 'feature', status: 'draft', title,
      graphId: 'g1', graphType: 'online', parentId: 'p_sort',
      position: { x: 0, y: 0 },
    })

    expect(mk('S1').sortIndex).toBe(0)
    expect(mk('S2').sortIndex).toBe(1)
    expect(mk('S3').sortIndex).toBe(2)
  })

  it('leaves sort_index unset for a root node', () => {
    const root = nodeRepo.create({
      type: 'project', status: 'confirmed', title: 'Root',
      graphId: 'g1', graphType: 'online',
      position: { x: 0, y: 0 },
    })
    expect(root.sortIndex).toBeUndefined()
  })

  // createBatch 的批内递增：同一父节点下的多个节点必须拿到**连续**的号。
  // 逐个查 MAX(sort_index) 会让每个节点都拿到同一个基准值 —— 那样兄弟顺序就乱了。
  it('gives batch siblings under one parent consecutive sort_index values', () => {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run('p_batch', 'module', 'draft', 'PB', 'g1', 'online', null, 0, 0, now, now)

    const created = nodeRepo.createBatch([
      { type: 'feature', status: 'draft', title: 'B1', graphId: 'g1', graphType: 'online', parentId: 'p_batch', position: { x: 0, y: 0 } },
      { type: 'feature', status: 'draft', title: 'B2', graphId: 'g1', graphType: 'online', parentId: 'p_batch', position: { x: 0, y: 0 } },
      { type: 'feature', status: 'draft', title: 'B3', graphId: 'g1', graphType: 'online', parentId: 'p_batch', position: { x: 0, y: 0 } },
    ])

    expect(created.map((n) => n.sortIndex)).toEqual([0, 1, 2])

    const rows = db
      .prepare("SELECT sort_index FROM nodes WHERE parent_id = 'p_batch' ORDER BY sort_index")
      .all() as { sort_index: number }[]
    expect(rows.map((r) => r.sort_index)).toEqual([0, 1, 2])
  })

  // 兄弟全为 NULL 时 MAX 返回 NULL，NULL + 1 在 SQLite 里仍是 NULL ——
  // COALESCE 把它变成 0。没有 COALESCE 的话新节点会落进布局的「排最后」兜底里。
  it('starts at 0 when every sibling has a NULL sort_index', () => {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run('p_null', 'module', 'draft', 'PN', 'g1', 'online', null, 0, 0, now, now)
    // 存量兄弟：sort_index 是 NULL
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run('legacy_child', 'feature', 'draft', 'Legacy', 'g1', 'online', 'p_null', 0, 0, now, now)

    const created = nodeRepo.create({
      type: 'feature', status: 'draft', title: 'New',
      graphId: 'g1', graphType: 'online', parentId: 'p_null',
      position: { x: 0, y: 0 },
    })
    expect(created.sortIndex).toBe(0)
  })

  // rowToNode：sort_index 是可空列 —— 根节点必须映射成 undefined，**不是 null**。
  it('maps a NULL sort_index to undefined rather than null', () => {
    const found = nodeRepo.findById('p_sort')
    expect(found).not.toBeNull()
    expect(found!.sortIndex).toBeUndefined()
    // collapsed 是 NOT NULL DEFAULT 0 —— 读回来是 false 而不是 undefined
    expect(found!.collapsed).toBe(false)
  })

  // collapsed **不是 create() 的输入**：这一列不在 INSERT 里，值由列默认值
  // （NOT NULL DEFAULT 0）决定。返回对象不能声称一个没写进去的状态 ——
  // 调用方传 collapsed: true 时，返回对象说「折叠中」，而刚写入的那一行是 0（展开）。
  it('never returns a collapsed flag the freshly written row does not have', () => {
    const created = nodeRepo.create({
      type: 'feature', status: 'draft', title: 'CallerWantsCollapsed',
      graphId: 'g1', graphType: 'online',
      position: { x: 0, y: 0 },
      collapsed: true,
    })

    // 返回对象 == 把刚写入的那一行读回来会得到什么
    expect(created.collapsed).toBe(false)
    // 库里那一行仍然是 0 —— INSERT 没有写这一列，行为没被改坏
    const row = db.prepare('SELECT collapsed FROM nodes WHERE id = ?').get(created.id) as { collapsed: number }
    expect(row.collapsed).toBe(0)
  })

  it('returns collapsed false when the caller does not pass it', () => {
    const created = nodeRepo.create({
      type: 'feature', status: 'draft', title: 'NoCollapsedFlag',
      graphId: 'g1', graphType: 'online',
      position: { x: 0, y: 0 },
    })
    expect(created.collapsed).toBe(false)
  })

  it('returns collapsed false for batch-created nodes too', () => {
    const created = nodeRepo.createBatch([
      { type: 'feature', status: 'draft', title: 'BatchCollapsed', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 }, collapsed: true },
      { type: 'feature', status: 'draft', title: 'BatchPlain', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } },
    ])

    expect(created[0].collapsed).toBe(false)
    expect(created[1].collapsed).toBe(false)
    const rows = db
      .prepare('SELECT collapsed FROM nodes WHERE id IN (?, ?) ORDER BY title')
      .all(created[0].id, created[1].id) as { collapsed: number }[]
    expect(rows.map((r) => r.collapsed)).toEqual([0, 0])
  })

  // ---- parentId 归一 ----
  //
  // `parent_id` 是 TEXT 列，而 better-sqlite3 把 JS number 一律绑成 REAL ——
  // SQLite 的 TEXT 亲和性把它转成 '12345.0'（**不是** '12345'）。
  // 于是 `WHERE parent_id = '12345'` 匹配不到任何一行 → 悬空父指针。
  // （实测：不归一时存进去的是 '12345.0'，用字符串 '12345' 查一条都查不到。）

  /** 建一个父节点（自身是根：parent_id = NULL） */
  function seedParent(id: string, title: string): void {
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(id, 'module', 'draft', title, 'g1', 'online', null, 0, 0, now, now)
  }

  it('stores a numeric parentId as a string on create', () => {
    seedParent('12345', 'NumericParent')

    const created = nodeRepo.create({
      type: 'feature', status: 'draft', title: 'NumericChild',
      graphId: 'g1', graphType: 'online',
      // 父节点 id 是 TEXT —— 数字型入参必须被归一，否则存进去的是 '12345.0'
      parentId: 12345 as unknown as string,
      position: { x: 0, y: 0 },
    })

    const row = db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(created.id) as { parent_id: string | null }
    expect(row.parent_id).toBe('12345')
    // 返回对象也必须带归一后的值 —— 渲染端用它派生层级线，数字/字符串对不上就画不出线
    expect(created.parentId).toBe('12345')
  })

  it('stores a numeric parentId as a string on createBatch', () => {
    seedParent('23456', 'NumericBatchParent')

    const created = nodeRepo.createBatch([
      {
        type: 'feature', status: 'draft', title: 'NumericBatchChild',
        graphId: 'g1', graphType: 'online',
        parentId: 23456 as unknown as string,
        position: { x: 0, y: 0 },
      },
    ])

    const row = db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(created[0].id) as { parent_id: string | null }
    expect(row.parent_id).toBe('23456')
    expect(created[0].parentId).toBe('23456')
  })

  it('gives batch siblings under a numeric parentId consecutive sort_index values', () => {
    // 父节点 '34567' 已经有一个子节点（sort_index = 0，parent_id 存的是字符串 '34567'）。
    // 批里再来两个 parentId 是**数字** 34567 的节点：
    //   - 不归一 → base 查不到既有兄弟（SQL 拿 '34567.0' 去比 '34567'）→ 拿到 0
    //             → 与既有兄弟**重号**；
    //   - 归一后 → base = 既有兄弟的最大号 + 1 → 接在后面，一个号都不重。
    seedParent('34567', 'NumericSortParent')
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, sort_index, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run('existing_child', 'feature', 'draft', 'Existing', 'g1', 'online', '34567', 0, 0, 0, now, now)

    const created = nodeRepo.createBatch([
      {
        type: 'feature', status: 'draft', title: 'NumericSibling1',
        graphId: 'g1', graphType: 'online',
        parentId: 34567 as unknown as string,
        position: { x: 0, y: 0 },
      },
      {
        type: 'feature', status: 'draft', title: 'NumericSibling2',
        graphId: 'g1', graphType: 'online',
        parentId: 34567 as unknown as string,
        position: { x: 0, y: 0 },
      },
    ])

    // 两个新节点彼此不重号
    expect(new Set(created.map((n) => n.sortIndex)).size).toBe(2)
    // 也不与既有兄弟重号 —— 接在既有兄弟之后
    expect(created.map((n) => n.sortIndex)).toEqual([1, 2])

    const rows = db
      .prepare('SELECT sort_index FROM nodes WHERE parent_id = ? ORDER BY sort_index')
      .all('34567') as { sort_index: number }[]
    expect(rows.map((r) => r.sort_index)).toEqual([0, 1, 2])
  })
})
