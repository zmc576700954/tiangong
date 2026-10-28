/**
 * 数据库迁移测试
 * 覆盖 migrate() 创建表、rebuildTableIfNeeded() 非破坏性迁移
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import BetterSqlite3 from 'better-sqlite3'

/**
 * electron app.getPath('userData') 的取值。
 * 可切换，用来模拟「另一个 userData 目录下的存量库」的升级场景。
 */
const electronPaths = vi.hoisted(() => ({ userData: '' }))

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-test-' + process.pid)
electronPaths.userData = TEST_USER_DATA

// Mock electron app
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

  it('schema_version 升级到 17', () => {
    const db = getClient()
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined
    expect(Number(row!.version)).toBeGreaterThanOrEqual(17)
  })

  it('accepts hierarchical edge_type and has the new node columns', () => {
    const db = getClient()
    // 必须先建两个真实节点：edges.source/target 有 REFERENCES nodes(id) 外键，
    // 且 foreign_keys 常态是 ON（database.ts:45），插入不存在的 id 会先报外键违规，
    // 根本走不到 CHECK 那一层
    const now = new Date().toISOString()
    const insertNode = db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    )
    insertNode.run('n_x1', 'module', 'draft', 'X1', 'g_x', 'online', 0, 0, now, now)
    insertNode.run('n_x2', 'feature', 'draft', 'X2', 'g_x', 'online', 0, 0, now, now)

    db.prepare("INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES ('x1','n_x1','n_x2','hierarchical','g_x')").run()
    const row = db.prepare("SELECT edge_type FROM edges WHERE id='x1'").get() as { edge_type: string }
    expect(row.edge_type).toBe('hierarchical')

    // CHECK 约束是活的：非法 edge_type 必须被拒（历史教训：约束漏值导致落边静默失效）
    expect(() =>
      db.prepare("INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES ('x2','n_x1','n_x2','not-a-type','g_x')").run(),
    ).toThrow()

    const cols = (db.pragma('table_info(nodes)') as { name: string }[]).map(c => c.name)
    expect(cols).toContain('sort_index')
    expect(cols).toContain('collapsed')
  })

  it('存量 v16 库升级到 v17：加列不丢数据、edges 重建保留数据、层级迁移生效', () => {
    const oldUserData = path.join(os.tmpdir(), 'bizgraph-old-schema-' + process.pid)
    fs.rmSync(oldUserData, { recursive: true, force: true })
    fs.mkdirSync(path.join(oldUserData, 'data'), { recursive: true })

    // 造一个 v16 形态的存量库：
    // - nodes 没有 sort_index / collapsed
    // - edges 的 CHECK 不含 'hierarchical'
    const oldDb = new BetterSqlite3(path.join(oldUserData, 'data', 'bizgraph.db'))
    oldDb.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (16);
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('project', 'module', 'process', 'feature', 'bug', 'wiki-page')),
        status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder')),
        title TEXT NOT NULL,
        description TEXT,
        acceptance_criteria TEXT,
        graph_id TEXT NOT NULL,
        graph_type TEXT NOT NULL CHECK(graph_type IN ('online', 'dev')),
        parent_id TEXT,
        rules TEXT,
        metadata TEXT,
        owner_role TEXT CHECK(owner_role IN ('product', 'developer', 'tester')),
        position_x REAL NOT NULL,
        position_y REAL NOT NULL,
        content TEXT,
        community_summary TEXT,
        community_level INTEGER,
        community_id TEXT,
        context_refs TEXT,
        wiki_content TEXT,
        wiki_meta TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        label TEXT,
        edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change', 'wiki-link')),
        graph_id TEXT NOT NULL,
        content TEXT,
        description TEXT,
        data_flow TEXT,
        strength REAL
      );
    `)
    const insertOldNode = oldDb.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    insertOldNode.run('n_old_p', 'project', 'confirmed', '父', 'g_old', 'online', null, 0, 0, 't', 't')
    insertOldNode.run('n_old_c1', 'module', 'draft', '子1', 'g_old', 'online', 'n_old_p', 0, 0, 't', 't')
    insertOldNode.run('n_old_c2', 'module', 'draft', '子2', 'g_old', 'online', 'n_old_p', 0, 0, 't', 't')
    oldDb.prepare(
      "INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES ('e_old_1','n_old_p','n_old_c1','default','g_old')",
    ).run()
    oldDb.close()

    // 让 initDatabase 指向存量库 —— 版本号 16 < 17，走慢路径（重建 + 增量迁移）
    electronPaths.userData = oldUserData
    closeDatabase()
    initDatabase()
    const db = getClient()

    try {
      // 1. nodes 走 ALTER TABLE 增量加列，存量行一条不少
      const cols = (db.pragma('table_info(nodes)') as { name: string }[]).map(c => c.name)
      expect(cols).toContain('sort_index')
      expect(cols).toContain('collapsed')
      const nodeRows = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }
      expect(Number(nodeRows.n)).toBe(3)

      // 2. edges 因 CHECK 变更被重建 —— 数据完整（1 条存量 + 1 条迁移补的）
      const edgeRows = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
      expect(Number(edgeRows.n)).toBe(2)

      // 3. default 层级边被改写为 hierarchical
      const rewritten = db.prepare("SELECT edge_type FROM edges WHERE id='e_old_1'").get() as { edge_type: string }
      expect(rewritten.edge_type).toBe('hierarchical')

      // 4. 只有 parent_id 没有边的子节点（手动建的那种）被补上层级边
      const inserted = db.prepare(
        "SELECT COUNT(*) AS n FROM edges WHERE source='n_old_p' AND target='n_old_c2' AND edge_type='hierarchical'",
      ).get() as { n: number }
      expect(Number(inserted.n)).toBe(1)

      // 5. sort_index 已回填
      const sortIndex = db.prepare("SELECT sort_index FROM nodes WHERE id='n_old_c1'").get() as { sort_index: number | null }
      expect(sortIndex.sort_index).toBe(0)

      // 6. 重建后的 edges 带新 CHECK —— 'hierarchical' 现在能写进去
      expect(() =>
        db.prepare(
          "INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES ('e_old_2','n_old_p','n_old_c2','hierarchical','g_old')",
        ).run(),
      ).not.toThrow()
    } finally {
      electronPaths.userData = TEST_USER_DATA
      closeDatabase()
      initDatabase()
    }
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

    // 这里要钉的是「v15 的 CHECK 已被重建」，不是迁移链的**终点**版本 ——
    // 链会继续往上走（结构编辑那条线又加了一版），所以用「至少 16」而不是「正好 16」。
    const version = migrated.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }
    expect(Number(version.version)).toBeGreaterThanOrEqual(16)
  })
})
