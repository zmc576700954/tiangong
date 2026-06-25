/**
 * 数据库迁移测试
 * 覆盖 migrate() 创建表、rebuildTableIfNeeded() 非破坏性迁移
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return path.join(os.tmpdir(), 'bizgraph-test-' + process.pid)
      return os.tmpdir()
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../database'

describe('Database Migration', () => {
  beforeAll(() => {
    initDatabase()
  })

  afterAll(() => {
    closeDatabase()
  })

  it('should create all 8 tables on fresh init', () => {
    const db = getClient()
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Record<string, unknown>[]
    const tables = rows.map((r) => r.name as string)

    expect(tables).toContain('graphs')
    expect(tables).toContain('nodes')
    expect(tables).toContain('edges')
    expect(tables).toContain('bug_nodes')
    expect(tables).toContain('snapshots')
    expect(tables).toContain('agent_logs')
    expect(tables).toContain('chat_threads')
    expect(tables).toContain('chat_messages')
    expect(tables.length).toBeGreaterThanOrEqual(8)
  })

  it('should have schema_version metadata', () => {
    const db = getClient()
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined
    expect(row).toBeDefined()
    const version = Number(row!.version)
    expect(version).toBeGreaterThan(0)
  })

  it('should have correct columns in graphs table', () => {
    const db = getClient()
    const cols = db.pragma('table_info(graphs)') as Record<string, unknown>[]
    const columns = cols.map((r) => r.name as string)

    expect(columns).toContain('id')
    expect(columns).toContain('project_path')
    expect(columns).toContain('name')
    expect(columns).toContain('type')
    expect(columns).toContain('created_at')
    expect(columns).toContain('updated_at')
  })

  it('should have correct columns in nodes table', () => {
    const db = getClient()
    const cols = db.pragma('table_info(nodes)') as Record<string, unknown>[]
    const columns = cols.map((r) => r.name as string)

    expect(columns).toContain('id')
    expect(columns).toContain('graph_id')
    expect(columns).toContain('parent_id')
    expect(columns).toContain('type')
    expect(columns).toContain('title')
    expect(columns).toContain('status')
  })

  it('should have correct columns in chat_threads table', () => {
    const db = getClient()
    const cols = db.pragma('table_info(chat_threads)') as Record<string, unknown>[]
    const columns = cols.map((r) => r.name as string)

    expect(columns).toContain('id')
    expect(columns).toContain('adapter_name')
    expect(columns).toContain('node_id')
    expect(columns).toContain('title')
  })

  it('should have correct columns in chat_messages table', () => {
    const db = getClient()
    const cols = db.pragma('table_info(chat_messages)') as Record<string, unknown>[]
    const columns = cols.map((r) => r.name as string)

    expect(columns).toContain('id')
    expect(columns).toContain('thread_id')
    expect(columns).toContain('role')
    expect(columns).toContain('content')
  })

  it('should be idempotent — calling initDatabase again does not throw', () => {
    expect(() => initDatabase()).not.toThrow()
  })

  it('schema_version should be at least 4 after migration', () => {
    const db = getClient()
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined
    const version = Number(row!.version)
    expect(version).toBeGreaterThanOrEqual(4)
  })

  it('chat_messages should have token_count column', () => {
    const db = getClient()
    const cols = db.pragma('table_info(chat_messages)') as Record<string, unknown>[]
    const columns = cols.map((r) => r.name as string)
    expect(columns).toContain('token_count')
  })

  it('chat_threads should have waterline columns', () => {
    const db = getClient()
    const cols = db.pragma('table_info(chat_threads)') as Record<string, unknown>[]
    const columns = cols.map((r) => r.name as string)
    expect(columns).toContain('parent_thread_id')
    expect(columns).toContain('context_tokens_used')
    expect(columns).toContain('context_window_max')
    expect(columns).toContain('last_compacted_at')
  })

  it('should create compact_history table with expected columns', () => {
    const db = getClient()
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='compact_history'"
    ).all() as Record<string, unknown>[]
    expect(tables.length).toBe(1)

    const cols = db.pragma('table_info(compact_history)') as Record<string, unknown>[]
    const columns = cols.map((r) => r.name as string)
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'thread_id', 'session_id', 'strategy', 'trigger',
      'tokens_before', 'tokens_after', 'summary',
      'started_at', 'duration_ms',
    ]))
  })

  it('should create subagent_invocations table with expected columns', () => {
    const db = getClient()
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_invocations'"
    ).all() as Record<string, unknown>[]
    expect(tables.length).toBe(1)

    const cols = db.pragma('table_info(subagent_invocations)') as Record<string, unknown>[]
    const columns = cols.map((r) => r.name as string)
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'parent_session_id', 'parent_message_id', 'graph_id',
      'agent_type', 'description', 'prompt',
      'adapter_name', 'node_id', 'allowed_files',
      'status', 'result_text', 'result_files', 'tokens_used',
      'started_at', 'finished_at', 'error',
    ]))
  })

  it('should index subagent_invocations by parent_session_id and status', () => {
    const db = getClient()
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='subagent_invocations'"
    ).all() as Record<string, unknown>[]
    const indexNames = rows.map((r) => r.name as string)
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_subagent_inv_parent',
      'idx_subagent_inv_status',
    ]))
  })
})
