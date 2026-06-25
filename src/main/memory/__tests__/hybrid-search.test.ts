/**
 * HybridSearchEngine 单元测试
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import * as database from '../../database'
import { HybridSearchEngine } from '../hybrid-search'
import { MemoryStore } from '../memory-store'
import type { EmbeddingService } from '../embedding-service'
import type { MemoryItem, MemoryKind } from '@shared/types'

describe('HybridSearchEngine', () => {
  let db: BetterSqlite3.Database
  let store: MemoryStore

  const mockItem = (overrides?: Partial<Omit<MemoryItem, 'id'>>): Omit<MemoryItem, 'id'> => ({
    session_id: 'session_001',
    kind: 'fix' as MemoryKind,
    project_id: '/projects/test-app',
    node_id: 'node_001',
    title: 'authentication bug fix',
    narrative: 'Resolved a race condition in the auth middleware.',
    facts: ['Root cause: race condition'],
    concepts: ['auth', 'bugfix'],
    files_read: [],
    files_modified: ['src/auth.ts'],
    adapter_name: 'claude-code',
    token_cost: 1000,
    confidence: 0.85,
    created_at: new Date().toISOString(),
    ...overrides,
  })

  function setupSchema(database: BetterSqlite3.Database): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('investigation', 'fix', 'review_finding', 'decision', 'pattern', 'lesson', 'waterline')),
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
        version INTEGER DEFAULT 1,
        parent_version INTEGER DEFAULT NULL,
        embedding TEXT DEFAULT NULL,
        created_at TEXT NOT NULL
      )
    `)
  }

  beforeAll(() => {
    db = new BetterSqlite3(':memory:')
    setupSchema(db)
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    db.prepare('DELETE FROM memory_items').run()
    store = new MemoryStore(db)
    vi.spyOn(database, 'getClient').mockReturnValue(db)
  })

  it('falls back to embedding search when FTS5 returns no candidates', async () => {
    const embedding: number[] = [1, 0, 0, 0]

    store.store(
      mockItem({
        project_id: 'proj-1',
        title: 'unrelated title',
        narrative: 'unrelated narrative',
        facts: [],
        concepts: [],
        embedding,
      }),
    )

    const engine = new HybridSearchEngine(store)
    // 注入一个伪造的 embedding service，返回与存储项相同的向量，使余弦相似度为 1
    const fakeEmbeddingService = {
      isReady: () => true,
      generateEmbedding: async () => embedding,
    } as unknown as EmbeddingService
    ;(engine as unknown as { _embeddingEnabled: boolean })._embeddingEnabled = true
    ;(engine as unknown as { _embeddingService: EmbeddingService })._embeddingService = fakeEmbeddingService

    // 查询词与任何 FTS 索引文本都不匹配，FTS5 应返回空，触发嵌入召回
    const results = await engine.search('xyzsemanticquery', { projectId: 'proj-1', limit: 5 })

    expect(results.length).toBe(1)
    expect(results[0].embeddingScore).toBeCloseTo(1, 5)
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('returns empty when FTS5 and embedding both have no results', async () => {
    const engine = new HybridSearchEngine(store)
    const results = await engine.search('nonexistentterm', { projectId: 'proj-1', limit: 5 })
    expect(results).toEqual([])
  })
})
