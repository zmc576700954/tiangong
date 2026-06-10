/**
 * MemoryStore 单元测试
 * 使用 LibSQL 内存数据库，真实验证 SQL 操作
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { MemoryStore } from '../memory-store'
import type { MemoryItem, MemoryKind } from '@shared/types'

describe('MemoryStore', () => {
  let db: Client
  let store: MemoryStore

  const mockItem = (overrides?: Partial<Omit<MemoryItem, 'id'>>): Omit<MemoryItem, 'id'> => ({
    session_id: 'session_001',
    kind: 'fix' as MemoryKind,
    project_id: '/projects/test-app',
    node_id: 'node_001',
    title: 'Fixed: session timeout in auth.ts',
    narrative: 'Fixed a race condition in the auth middleware that caused session timeouts.',
    facts: ['Files modified: 1', 'Root cause: race condition'],
    concepts: ['fix-applied', 'problem-solution'],
    files_read: [],
    files_modified: ['src/auth.ts'],
    adapter_name: 'claude-code',
    token_cost: 15500,
    confidence: 0.85,
    created_at: new Date().toISOString(),
    ...overrides,
  })

  /**
   * 为测试数据库创建必要的表结构（仿照 migrate() 中的 memory_items 定义）
   */
  async function setupSchema(client: Client): Promise<void> {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('investigation', 'fix', 'review_finding', 'decision', 'pattern', 'lesson')),
        project_id TEXT NOT NULL DEFAULT '',
        node_id TEXT,
        title TEXT NOT NULL,
        narrative TEXT NOT NULL DEFAULT '',
        facts TEXT NOT NULL DEFAULT '[]',
        concepts TEXT NOT NULL DEFAULT '[]',
        files_read TEXT NOT NULL DEFAULT '[]',
        files_modified TEXT NOT NULL DEFAULT '[]',
        adapter_name TEXT NOT NULL DEFAULT '',
        token_cost INTEGER DEFAULT 0,
        confidence REAL DEFAULT 0.0,
        created_at TEXT NOT NULL
      )
    `)
  }

  beforeAll(async () => {
    db = createClient({ url: ':memory:' })
    await setupSchema(db)
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    // 每个测试前清空数据，保持隔离
    await db.execute('DELETE FROM memory_items')
    store = new MemoryStore(db)
  })

  it('should store a memory item and return its id', async () => {
    const id = await store.store(mockItem())
    expect(id).toBeGreaterThan(0)
    expect(Number.isInteger(id)).toBe(true)
  })

  it('should retrieve recent memories', async () => {
    await store.store(mockItem({ created_at: '2025-01-01T00:00:00Z' }))
    await store.store(mockItem({
      session_id: 'session_002',
      kind: 'investigation' as MemoryKind,
      title: 'Investigated: race condition',
      created_at: '2025-01-02T00:00:00Z',
    }))

    const recent = await store.getRecent({ projectId: '/projects/test-app' })
    expect(recent.length).toBe(2)
    // 最新在前
    expect(recent[0].session_id).toBe('session_002')
  })

  it('should search memories by keyword', async () => {
    await store.store(mockItem({
      title: 'Fixed: session timeout',
      narrative: 'Fixed session timeout in auth middleware',
    }))
    await store.store(mockItem({
      session_id: 'session_003',
      title: 'Added rate limiting to API',
      narrative: 'Added express-rate-limit to all API routes',
    }))

    // LIKE fallback search
    const results = await store.search('session')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('should filter memories by kind', async () => {
    await store.store(mockItem({ kind: 'fix' as MemoryKind }))
    await store.store(mockItem({
      session_id: 'session_004',
      kind: 'review_finding' as MemoryKind,
      title: '[critical] SQL injection in user query',
    }))

    const fixes = await store.search('session', { kind: 'fix' as MemoryKind })
    expect(fixes.length).toBeGreaterThanOrEqual(1)
    for (const f of fixes) {
      expect(f.kind).toBe('fix')
    }
  })

  it('should retrieve memories by node', async () => {
    await store.store(mockItem({ node_id: 'node_A', created_at: '2025-01-01T00:00:00Z' }))
    await store.store(mockItem({
      session_id: 'session_005',
      node_id: 'node_A',
      title: 'Another fix for node A',
      created_at: '2025-01-02T00:00:00Z',
    }))
    await store.store(mockItem({
      session_id: 'session_006',
      node_id: 'node_B',
      title: 'Fix for node B',
      created_at: '2025-01-03T00:00:00Z',
    }))

    const nodeAMemories = await store.getByNode('node_A')
    expect(nodeAMemories.length).toBe(2)
    for (const m of nodeAMemories) {
      expect(m.node_id).toBe('node_A')
    }
  })

  it('should format compact summary', () => {
    const item: MemoryItem = {
      id: 42,
      ...mockItem(),
    }
    const summary = store.toCompactSummary(item)
    expect(summary).toContain('42')
    expect(summary).toContain('session timeout')
  })

  it('should return cross-adapter memories', async () => {
    await store.store(mockItem({ adapter_name: 'claude-code', created_at: '2025-01-01T00:00:00Z' }))
    await store.store(mockItem({
      session_id: 'session_007',
      adapter_name: 'codex',
      kind: 'pattern' as MemoryKind,
      title: 'Pattern: all API routes lack rate limiting',
      created_at: '2025-01-02T00:00:00Z',
    }))

    const crossAdapter = await store.getCrossAdapter('/projects/test-app', 'claude-code')
    expect(crossAdapter.length).toBeGreaterThanOrEqual(1)
    for (const m of crossAdapter) {
      expect(m.adapter_name).not.toBe('claude-code')
    }
  })

  it('should get stats by kind', async () => {
    await store.store(mockItem({ kind: 'fix' as MemoryKind, created_at: '2025-01-01T00:00:00Z' }))
    await store.store(mockItem({
      session_id: 'session_008',
      kind: 'investigation' as MemoryKind,
      title: 'Investigation 2',
      created_at: '2025-01-02T00:00:00Z',
    }))
    await store.store(mockItem({
      session_id: 'session_009',
      kind: 'review_finding' as MemoryKind,
      title: 'Finding 1',
      created_at: '2025-01-03T00:00:00Z',
    }))

    const stats = await store.getStats()
    expect(stats.length).toBeGreaterThanOrEqual(3)
    expect(stats.some((s) => s.kind === 'fix')).toBe(true)
  })

  it('should delete memories by session', async () => {
    await store.store(mockItem({ session_id: 'session_del', created_at: '2025-01-01T00:00:00Z' }))
    await store.store(mockItem({ session_id: 'session_del', title: 'Second', created_at: '2025-01-02T00:00:00Z' }))

    const deleted = await store.deleteBySession('session_del')
    expect(deleted).toBe(2)

    // 确认已删除
    const remaining = await store.getBySession('session_del')
    expect(remaining.length).toBe(0)
  })

  it('should return empty for non-existent project', async () => {
    const recent = await store.getRecent({ projectId: '/nonexistent' })
    expect(recent).toEqual([])
  })

  it('should batch store many memories', async () => {
    const items = [
      mockItem({ session_id: 'batch_1', created_at: '2025-01-01T00:00:00Z' }),
      mockItem({ session_id: 'batch_2', created_at: '2025-01-02T00:00:00Z' }),
      mockItem({ session_id: 'batch_3', created_at: '2025-01-03T00:00:00Z' }),
    ]
    const ids = await store.storeMany(items)
    expect(ids.length).toBe(3)
    expect(ids.every((id) => id > 0)).toBe(true)
  })

  it('should retrieve by session', async () => {
    await store.store(mockItem({ session_id: 'session_X', created_at: '2025-01-01T00:00:00Z' }))
    await store.store(mockItem({ session_id: 'session_X', title: 'Second fix', created_at: '2025-01-02T00:00:00Z' }))

    const memories = await store.getBySession('session_X')
    expect(memories.length).toBe(2)
    for (const m of memories) {
      expect(m.session_id).toBe('session_X')
    }
  })
})
