/**
 * Yjs 远端写入路径的层级护栏（Task 7）
 *
 * 背景：`nodes.parent_id` 是父子关系的事实来源，本地变更入口唯一
 * （`graph:reparent` → HierarchyService，校验防环 / 跨图 / 父子类型）。
 * 但远端协作 peer 可以任意指定 parentId（spec §4.4.2），所以还有两条
 * 受控路径必须自己兜底：
 *
 * - `NodeRepository.update()` —— Yjs 远端**更新**与快照双向同步都经由它
 * - `YjsManager.insertRemoteNode()` —— Yjs 远端**插入**的裸 INSERT
 *
 * 这里只做**防环**（自环 + 成环）。父子类型 / 跨图校验刻意不加：
 * 那是 `graph:reparent` 的职责，远端路径按 spec §4.4.2 的取舍不做。
 *
 * 用真实 better-sqlite3（electron mock + initDatabase()）—— 防环要走
 * `nodes.parent_id` 逐级上溯，mock db 测不出来。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'

const electronPaths = vi.hoisted(() => ({ userData: '' }))

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-yjs-guard-' + process.pid)
electronPaths.userData = TEST_USER_DATA

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

import { initDatabase, closeDatabase } from '../../database'
import { NodeRepository } from '../../repositories/node-repository'
import { EdgeRepository } from '../../repositories/edge-repository'
import { YjsManager } from '../yjs-manager'
import { ErrorCode, HierarchyError } from '../../errors'

const GRAPH_ID = 'g_guard'

/** 断言抛出的错误是指定 code 的 HierarchyError */
function expectHierarchyError(fn: () => void, code: string): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(HierarchyError)
  expect((caught as HierarchyError).code).toBe(code)
}

/** 读库里的 parent_id */
function readParentId(db: BetterSqlite3.Database, id: string): string | null {
  const row = db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(id) as
    | { parent_id: string | null }
    | undefined
  return row?.parent_id ?? null
}

describe('Yjs 远端路径的 parent_id 护栏', () => {
  let db: BetterSqlite3.Database
  let nodeRepo: NodeRepository

  beforeAll(() => {
    db = initDatabase()
  })

  afterAll(() => {
    closeDatabase()
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
  })

  beforeEach(() => {
    const now = new Date().toISOString()
    db.prepare('DELETE FROM nodes').run()
    const insert = db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    // 层级：s1 → c1 → f1 （f1 是 c1 的后代）
    insert.run('s1', 'module', 'draft', 'S1', GRAPH_ID, 'online', null, 0, 0, now, now)
    insert.run('s2', 'module', 'draft', 'S2', GRAPH_ID, 'online', null, 0, 0, now, now)
    insert.run('c1', 'feature', 'draft', 'C1', GRAPH_ID, 'online', 's1', 0, 0, now, now)
    insert.run('f1', 'feature', 'draft', 'F1', GRAPH_ID, 'online', 'c1', 0, 0, now, now)
    nodeRepo = new NodeRepository(db)
  })

  it('拒绝把节点挂到自己的后代下面（成环），且不落库', () => {
    expectHierarchyError(
      () => nodeRepo.update('c1', { parentId: 'f1' }),
      ErrorCode.HIERARCHY_CYCLE,
    )
    expect(readParentId(db, 'c1')).toBe('s1')
  })

  it('拒绝节点把自己设为父节点（自环）', () => {
    expectHierarchyError(
      () => nodeRepo.update('c1', { parentId: 'c1' }),
      ErrorCode.HIERARCHY_SELF_PARENT,
    )
    expect(readParentId(db, 'c1')).toBe('s1')
  })

  it('允许改到一个合法的新父节点', () => {
    nodeRepo.update('c1', { parentId: 's2' })
    expect(readParentId(db, 'c1')).toBe('s2')
  })

  it('不带 parentId 的普通更新不受影响，parent_id 保持不变', () => {
    const updated = nodeRepo.update('c1', { title: 'x' })
    expect(updated.title).toBe('x')
    expect(readParentId(db, 'c1')).toBe('s1')
  })

  it('远端插入拒绝自环，且这一行不会落库', () => {
    const manager = new YjsManager({ db, nodeRepo, edgeRepo: new EdgeRepository(db) })
    const payload = {
      id: 'X',
      type: 'feature',
      status: 'draft',
      title: 'remote',
      graphId: GRAPH_ID,
      graphType: 'online',
      parentId: 'X',
      position: { x: 0, y: 0 },
    }
    expectHierarchyError(
      () => manager['insertRemoteNode'](payload),
      ErrorCode.HIERARCHY_SELF_PARENT,
    )
    const row = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get('X') as { n: number }
    expect(Number(row.n)).toBe(0)
  })

  it('远端插入经 handleRemoteNodeChange 时被 try/catch 接住，不写库也不外抛', () => {
    const manager = new YjsManager({ db, nodeRepo, edgeRepo: new EdgeRepository(db) })
    const payload = {
      id: 'Y',
      type: 'feature',
      status: 'draft',
      title: 'remote',
      graphId: GRAPH_ID,
      graphType: 'online',
      parentId: 'Y',
      position: { x: 0, y: 0 },
    }
    // 错误会被 manager 的 logger 记下来 —— 顺手断言「确实被 catch 到了」，
    // 同时把 console 噪声按下去，保证测试输出干净。
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    let loggedCount = 0
    try {
      expect(() => manager['handleRemoteNodeChange'](GRAPH_ID, 'create', payload)).not.toThrow()
      loggedCount = logged.mock.calls.length
    } finally {
      // mockRestore 会清掉调用记录 —— 计数必须在 restore 之前取
      logged.mockRestore()
    }
    expect(loggedCount).toBeGreaterThan(0)
    const row = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get('Y') as { n: number }
    expect(Number(row.n)).toBe(0)
  })
})
