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
})
