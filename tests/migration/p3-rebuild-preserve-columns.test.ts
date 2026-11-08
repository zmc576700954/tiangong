/**
 * P3 — 重建不丢非 `createSql` 列（session-map 蓝图 §8.11，已由 v24 修复）。
 *
 * 断言：重建前写 `graphs.writeback_disabled=1` 与 `edges.updated_at` 标记值，
 * 重建后两者原样保留；重建后 `nodes.entity_key` 不被重置。
 *
 * 做法：用真实 `initDatabase()` 建库，从 `sqlite_master` 取当前 createSql，
 * 注入一个无害的 `CHECK (1)` 强制走重建路径（等价于 CHECK 值域变化）。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const electronPaths = vi.hoisted(() => ({ userData: '' }))
const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-p3-' + process.pid)
electronPaths.userData = TEST_USER_DATA

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? electronPaths.userData : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient, rebuildTableIfNeeded } from '../../src/main/database'

function forceRebuildSql(sql: string): string {
  const idx = sql.lastIndexOf(')')
  if (idx < 0) throw new Error('unexpected createSql')
  return `${sql.slice(0, idx)}\n  CHECK (1)\n${sql.slice(idx)}`
}

describe('P3 重建保留非 createSql 列', () => {
  beforeAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    initDatabase()
  })

  afterAll(() => {
    closeDatabase()
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
  })

  it('writeback_disabled / edges.updated_at / nodes.entity_key 重建后保留', () => {
    const db = getClient()
    db.prepare(
      'INSERT INTO graphs (id, name, type, project_path, writeback_disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('g-p3', 'P3', 'online', '/p3', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, entity_key, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('n-p3', 'module', 'draft', 'N', 'g-p3', 'online', 'key-p3', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    db.prepare(
      'INSERT INTO edges (id, source, target, edge_type, graph_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('e-p3', 'n-p3', 'n-p3', 'default', 'g-p3', '2026-02-02T00:00:00Z')

    const graphsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='graphs'").get() as { sql: string }).sql
    const edgesSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='edges'").get() as { sql: string }).sql
    expect(graphsSql).toContain('writeback_disabled')
    expect(edgesSql).toContain('updated_at')

    // 与 migrate 一致：重建期间关 FK，避免 DROP 触发级联清空依赖表
    db.pragma('foreign_keys = OFF')
    rebuildTableIfNeeded(db, 'graphs', forceRebuildSql(graphsSql), ['id', 'name', 'type', 'lifecycle_state', 'created_at', 'updated_at'])
    rebuildTableIfNeeded(db, 'edges', forceRebuildSql(edgesSql), ['id', 'source', 'target', 'graph_id'])
    db.pragma('foreign_keys = ON')

    const graph = db.prepare('SELECT writeback_disabled FROM graphs WHERE id = ?').get('g-p3') as { writeback_disabled: number }
    const edge = db.prepare('SELECT updated_at FROM edges WHERE id = ?').get('e-p3') as { updated_at: string }
    const node = db.prepare('SELECT entity_key FROM nodes WHERE id = ?').get('n-p3') as { entity_key: string }
    expect(graph.writeback_disabled).toBe(1)
    expect(edge.updated_at).toBe('2026-02-02T00:00:00Z')
    expect(node.entity_key).toBe('key-p3')
  })
})
