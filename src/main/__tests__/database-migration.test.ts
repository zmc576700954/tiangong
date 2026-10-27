/**
 * 数据库迁移测试
 * 覆盖 migrate() 创建表、rebuildTableIfNeeded() 非破坏性迁移
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-test-' + process.pid)

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return TEST_USER_DATA
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
import * as databaseModule from '../database'

type RebuildTableIfNeeded = (
  db: ReturnType<typeof getClient>,
  tableName: string,
  createSql: string,
  requiredColumns: string[],
) => void

/**
 * rebuildTableIfNeeded 是模块内部函数。通过命名空间导入取它，
 * 这样「还没导出」表现为单条用例失败，而不是整个测试文件 import 失败。
 */
const rebuildTableIfNeeded: RebuildTableIfNeeded = (...args) => {
  const fn = (databaseModule as unknown as { rebuildTableIfNeeded?: RebuildTableIfNeeded })
    .rebuildTableIfNeeded
  if (!fn) throw new Error('rebuildTableIfNeeded is not exported from ../database')
  fn(...args)
}

/** schema 校验和缓存 —— 它的失配等价于「代码里的 createSql 变过」 */
const schemaChecksumPath = path.join(TEST_USER_DATA, 'data', 'schema-checksum.json')

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

  it('列类型变更会触发重建（列名不变、类型变）', () => {
    const db = getClient()
    db.exec('CREATE TABLE type_drift_demo (id TEXT PRIMARY KEY, score TEXT NOT NULL)')
    db.prepare('INSERT INTO type_drift_demo (id, score) VALUES (?, ?)').run('a', '1')
    db.prepare('INSERT INTO type_drift_demo (id, score) VALUES (?, ?)').run('b', '2')

    rebuildTableIfNeeded(
      db,
      'type_drift_demo',
      'CREATE TABLE type_drift_demo (id TEXT PRIMARY KEY, score INTEGER NOT NULL)',
      ['id', 'score'],
    )

    const cols = db.pragma('table_info(type_drift_demo)') as Record<string, unknown>[]
    const score = cols.find((c) => c.name === 'score')
    expect(String(score?.type).toUpperCase()).toBe('INTEGER')

    // 重建是非破坏性的：行数不变
    const row = db.prepare('SELECT COUNT(*) AS n FROM type_drift_demo').get() as { n: number }
    expect(Number(row.n)).toBe(2)

    db.exec('DROP TABLE type_drift_demo')
  })

  it('改了 createSql 但没 bump 版本时，schema 变更仍然生效', () => {
    const db = getClient()
    // 模拟「代码里的 createSql 变了，但忘了 bump CURRENT_SCHEMA_VERSION」：
    // 库里留着旧定义（id 是 INTEGER），版本号仍是当前版本。
    db.exec('DROP TABLE IF EXISTS snapshots')
    db.exec(`CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY,
      graph_id TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      git_commit TEXT,
      created_at TEXT NOT NULL
    )`)

    // checksum 失配 = createSql 变过的等价信号 → 快路径失效，进入慢路径。
    // 版本号没动 —— 慢路径必须照样重建，否则这次 schema 变更静默失效。
    fs.rmSync(schemaChecksumPath, { force: true })

    closeDatabase()
    initDatabase()

    const cols = getClient().pragma('table_info(snapshots)') as Record<string, unknown>[]
    const id = cols.find((c) => c.name === 'id')
    expect(String(id?.type).toUpperCase()).toBe('TEXT')
  })

  it('chat_messages.status 接受 queued / sending / permanently_failed', () => {
    const db = getClient()
    // chat_messages.thread_id 外键指向 chat_threads —— 先建一条线程
    db.prepare(
      'INSERT INTO chat_threads (id, title, adapter_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)'
    ).run('t-status-check', 'T', 'claude-code', 'idle', Date.now(), Date.now())

    for (const status of ['queued', 'sending', 'permanently_failed']) {
      expect(() =>
        db.prepare(
          'INSERT INTO chat_messages (id, thread_id, role, content, adapter_name, status, created_at) VALUES (?,?,?,?,?,?,?)'
        ).run(`m-${status}`, 't-status-check', 'agent', 'x', 'claude-code', status, Date.now()),
      ).not.toThrow()
    }
  })

  it('schema_version 升级到 16', () => {
    const db = getClient()
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined
    expect(Number(row!.version)).toBeGreaterThanOrEqual(16)
  })

  it('老库（v15 的 chat_messages CHECK）升级到 v16：行数与 status 值不变，CHECK 已含 queued', () => {
    const db = getClient()

    // 造一个 v15 形状的 chat_messages：CHECK 只允许 5 个 status 值
    db.exec('DROP TABLE IF EXISTS chat_messages')
    db.exec(`
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),
        content TEXT NOT NULL,
        adapter_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error', 'pending', 'streaming', 'aborted')),
        error TEXT,
        session_id TEXT,
        context_refs TEXT,
        tool_calls TEXT,
        created_at INTEGER NOT NULL
      )
    `)
    db.prepare(
      'INSERT INTO chat_threads (id, title, adapter_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('t-old', 'T', 'claude-code', 'idle', Date.now(), Date.now())
    for (const [id, status] of [['m-1', 'success'], ['m-2', 'error'], ['m-3', 'aborted']]) {
      db.prepare(
        'INSERT INTO chat_messages (id, thread_id, role, content, adapter_name, status, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, 't-old', 'agent', 'x', 'claude-code', status, Date.now())
    }

    // 老库状态：版本号停在 15，checksum 缓存也失效
    db.prepare('INSERT OR REPLACE INTO schema_version (rowid, version) VALUES (1, ?)').run(15)
    fs.rmSync(schemaChecksumPath, { force: true })

    closeDatabase()
    initDatabase()

    const migrated = getClient()
    const rows = migrated.prepare('SELECT id, status FROM chat_messages ORDER BY id').all() as {
      id: string
      status: string
    }[]
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.status)).toEqual(['success', 'error', 'aborted'])

    // CHECK 已扩容到 8 值
    expect(() =>
      migrated.prepare(
        'INSERT INTO chat_messages (id, thread_id, role, content, adapter_name, status, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run('m-queued', 't-old', 'agent', 'x', 'claude-code', 'queued', Date.now()),
    ).not.toThrow()

    const version = migrated.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }
    expect(Number(version.version)).toBe(16)
  })
})
