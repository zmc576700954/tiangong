/**
 * BizGraph database layer
 * Using LibSQL (SQLite superset) for local single-file database
 */

import { createClient, type Client } from '@libsql/client'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { DB_FILENAME } from '@shared/constants'
import { DatabaseError, ErrorCode } from './errors'

let client: Client | null = null
let keepaliveTimer: ReturnType<typeof setInterval> | null = null

/** 验证 SQLite 标识符是否合法（防止 SQL 注入） */
export function isValidIdentifier(name: string): boolean {
  // SQLite 标识符规则：以字母或下划线开头，后续可跟字母、数字、下划线
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)
}

/** 安全地包装标识符 */
export function safeIdentifier(name: string): string {
  if (!isValidIdentifier(name)) {
    throw new DatabaseError(`Invalid identifier: ${name}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }
  return `"${name.replace(/"/g, '""')}"`
}

export async function initDatabase(): Promise<Client> {
  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'data')
  await fs.mkdir(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, DB_FILENAME)

  client = createClient({
    url: `file:${dbPath}`,
  })

  // 启用 WAL 模式提升并发读性能
  await client.execute('PRAGMA journal_mode = WAL')
  // 启用外键约束
  await client.execute('PRAGMA foreign_keys = ON')
  // 设置 WAL 自动 checkpoint 阈略（Pages），防止 WAL 文件无限增长
  await client.execute('PRAGMA wal_autocheckpoint = 1000')

  await migrate()

  // 定期 WAL checkpoint，防止 WAL 文件膨胀（每 5 分钟）
  keepaliveTimer = setInterval(() => {
    if (!client) return
    client.execute('PRAGMA wal_checkpoint(PASSIVE)').catch((err) => {
      console.warn('[BizGraph] WAL checkpoint failed:', err)
    })
  }, 5 * 60 * 1000)
  // 不阻止进程退出
  if (keepaliveTimer.unref) keepaliveTimer.unref()

  return client
}

/** 关闭数据库连接 */
export async function closeDatabase(): Promise<void> {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
  if (client) {
    // 最终 WAL checkpoint，确保所有数据落盘
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {})
    await client.execute('PRAGMA optimize')
    // 如果客户端支持显式 close，优先调用以释放底层资源
    if ('close' in client && typeof (client as { close: unknown }).close === 'function') {
      await (client as { close: () => Promise<void> }).close()
    }
    client = null
  }
}

export function getClient(): Client {
  if (!client) {
    throw new DatabaseError('Database not initialized. Call initDatabase() first.', ErrorCode.DB_NOT_INITIALIZED)
  }
  return client
}

/**
 * Restore data from a backup table, handling enum value migrations
 */
async function restoreFromBackup(
  db: Client,
  tableName: string,
  tempTable: string,
): Promise<void> {
  // 验证标识符合法性
  if (!isValidIdentifier(tableName) || !isValidIdentifier(tempTable)) {
    throw new DatabaseError(`Invalid table identifier: ${tableName} or ${tempTable}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }

  try {
    const newColsResult = await db.execute(`PRAGMA table_info(${safeIdentifier(tableName)})`)
    const newCols = newColsResult.rows.map((r) => r.name as string).filter(isValidIdentifier)

    const oldColsResult = await db.execute(`PRAGMA table_info(${safeIdentifier(tempTable)})`)
    const oldCols = oldColsResult.rows.map((r) => r.name as string).filter(isValidIdentifier)

    const commonCols = newCols.filter((c) => oldCols.includes(c))

    if (commonCols.length > 0) {
      const colsStr = commonCols.map(safeIdentifier).join(', ')
      // Build SELECT clause with value transformations for renamed enum values
      const selectCols = commonCols.map((col) => {
        const safeCol = safeIdentifier(col)
        if (tableName === 'graphs' && col === 'type') {
          return `CASE ${safeCol} WHEN 'production' THEN 'online' WHEN 'development' THEN 'dev' ELSE ${safeCol} END AS ${safeCol}`
        }
        if (tableName === 'nodes' && col === 'graph_type') {
          return `CASE ${safeCol} WHEN 'production' THEN 'online' WHEN 'development' THEN 'dev' ELSE ${safeCol} END AS ${safeCol}`
        }
        if (tableName === 'nodes' && col === 'type') {
          // Old node types (rule/api/service/entity) mapped to new canonical types
          return `CASE ${safeCol} WHEN 'rule' THEN 'process' WHEN 'api' THEN 'feature' WHEN 'service' THEN 'feature' WHEN 'entity' THEN 'feature' ELSE ${safeCol} END AS ${safeCol}`
        }
        return safeCol
      }).join(', ')
      await db.execute(`INSERT INTO ${safeIdentifier(tableName)} (${colsStr}) SELECT ${selectCols} FROM ${safeIdentifier(tempTable)}`)
    }

    // Drop backup table
    await db.execute(`DROP TABLE ${safeIdentifier(tempTable)}`)
    console.log(`[BizGraph] Restored ${tableName} data from backup`)
  } catch (restoreErr) {
    console.warn(`[BizGraph] Failed to restore ${tableName} data:`, restoreErr)
    try {
      await db.execute(`DROP TABLE IF EXISTS ${safeIdentifier(tempTable)}`)
    } catch (cleanupErr) {
      console.warn(`[BizGraph] Failed to cleanup backup table ${tempTable}:`, cleanupErr)
    }
  }
}

/**
 * Check if table needs rebuilding (when schema changes)
 */
async function rebuildTableIfNeeded(
  db: Client,
  tableName: string,
  createSql: string,
  requiredColumns: string[],
): Promise<void> {
  // 验证标识符合法性
  if (!isValidIdentifier(tableName)) {
    throw new DatabaseError(`Invalid table identifier: ${tableName}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }

  // Check if table exists
  const tableInfo = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [tableName],
  })

  if (tableInfo.rows.length === 0) {
    // Table does not exist, create it
    await db.execute(createSql)
    return
  }

  // Table exists, check schema compatibility via PRAGMA table_info (non-intrusive)
  const colResult = await db.execute(`PRAGMA table_info(${safeIdentifier(tableName)})`)
  const existingCols = new Set(colResult.rows.map((r) => r.name as string).filter(isValidIdentifier))
  const hasAllColumns = requiredColumns.filter(isValidIdentifier).every((col) => existingCols.has(col))

  const tempTable = `${tableName}_backup`
  if (!isValidIdentifier(tempTable)) {
    throw new DatabaseError(`Invalid backup table identifier: ${tempTable}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }

  if (hasAllColumns) {
    // Schema columns match — but CHECK constraints may have changed.
    // Read the existing CREATE TABLE SQL and compare CHECK clauses with the expected one.
    const existingSqlResult = await db.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      args: [tableName],
    })
    const existingSql = (existingSqlResult.rows[0]?.sql as string) ?? ''

    // Extract CHECK(...) clauses from both SQLs and compare
    // 使用计数器处理嵌套括号，替代正则的 [^)] 匹配
    const extractChecks = (sql: string) => {
      const checks: string[] = []
      const lowerSql = sql.toLowerCase()
      let i = 0
      while (i < lowerSql.length) {
        const idx = lowerSql.indexOf('check(', i)
        if (idx === -1) break
        let depth = 1
        let j = idx + 6 // 'check('.length
        while (j < sql.length && depth > 0) {
          if (sql[j] === '(') depth++
          else if (sql[j] === ')') depth--
          j++
        }
        if (depth === 0) {
          checks.push(sql.slice(idx + 6, j - 1).replace(/\s+/g, ' ').trim().toLowerCase())
        }
        i = j
      }
      return checks.sort()
    }

    const existingChecks = extractChecks(existingSql).join('||')
    const expectedChecks = extractChecks(createSql).join('||')

    if (existingChecks === expectedChecks) {
      // Schema and constraints are compatible — check for leftover backup table
      const backupCheck = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        args: [tempTable],
      })
      if (backupCheck.rows.length > 0) {
        console.log(`[BizGraph] Found leftover backup ${tempTable}, restoring data...`)
        await restoreFromBackup(db, tableName, tempTable)
      }
      return
    }

    // CHECK constraints differ — need rebuild
    console.log(`[BizGraph] Table ${tableName} CHECK constraints changed, rebuilding...`)
  }

  // Missing columns, need to rebuild table — 使用事务保护
  console.log(`[BizGraph] Table ${tableName} schema outdated, rebuilding...`)

  // P0-9: 使用 SAVEPOINT 替代 BEGIN，避免嵌套事务崩溃
  await db.execute('SAVEPOINT rebuild_sp')
  try {
    // 1. Backup old table data
    await db.execute(`DROP TABLE IF EXISTS ${safeIdentifier(tempTable)}`)
    await db.execute(`CREATE TABLE ${safeIdentifier(tempTable)} AS SELECT * FROM ${safeIdentifier(tableName)}`)

    // 2. Drop old table
    await db.execute(`DROP TABLE ${safeIdentifier(tableName)}`)

    // 3. Create new table
    await db.execute(createSql)

    // 4. Try to restore data
    await restoreFromBackup(db, tableName, tempTable)

    await db.execute('RELEASE rebuild_sp')
    console.log(`[BizGraph] Table ${tableName} rebuilt successfully`)
  } catch (err) {
    await db.execute('ROLLBACK TO rebuild_sp').catch((rollbackErr) => {
      console.error(`[BizGraph] Rollback failed for ${tableName}:`, rollbackErr)
    })
    throw err
  }
}

async function migrate(): Promise<void> {
  const db = getClient()
  await db.execute('SAVEPOINT migrate_sp')
  try {
  // Graphs table (dual graph model: online / dev)
  await rebuildTableIfNeeded(db, 'graphs', `
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('online', 'dev')),
      project_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `, ['id', 'name', 'type', 'created_at', 'updated_at'])

  // Nodes table
  await rebuildTableIfNeeded(db, 'nodes', `
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('project', 'module', 'process', 'feature', 'bug')),
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
      context_refs TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `, ['id', 'type', 'status', 'title', 'graph_id', 'graph_type', 'position_x', 'position_y', 'created_at', 'updated_at'])

  // Edges table
  await rebuildTableIfNeeded(db, 'edges', `
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      label TEXT,
      edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition', 'business-flow')),
      graph_id TEXT NOT NULL,
      content TEXT,
      description TEXT,
      data_flow TEXT,
      strength REAL
    )
  `, ['id', 'source', 'target', 'graph_id'])

  // Bug nodes table
  await rebuildTableIfNeeded(db, 'bug_nodes', `
    CREATE TABLE bug_nodes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL CHECK(status IN ('open', 'fixed', 'verified')),
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      graph_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `, ['id', 'title', 'description', 'severity', 'status', 'node_id', 'graph_id', 'created_at', 'updated_at'])

  // Snapshots table
  await rebuildTableIfNeeded(db, 'snapshots', `
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      git_commit TEXT,
      created_at TEXT NOT NULL
    )
  `, ['id', 'graph_id', 'name', 'data', 'created_at'])

  // Agent logs table
  await rebuildTableIfNeeded(db, 'agent_logs', `
    CREATE TABLE agent_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      node_id TEXT NOT NULL,
      graph_id TEXT NOT NULL,
      command TEXT NOT NULL,
      outputs TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('success', 'failure', 'cancelled')),
      duration INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `, ['id', 'session_id', 'adapter_name', 'node_id', 'graph_id', 'command', 'outputs', 'result', 'duration', 'created_at'])

  // Chat threads table
  await rebuildTableIfNeeded(db, 'chat_threads', `
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      node_id TEXT,
      graph_id TEXT,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `, ['id', 'title', 'adapter_name', 'node_id', 'graph_id', 'session_id', 'status', 'created_at', 'updated_at'])

  // Chat messages table
  await rebuildTableIfNeeded(db, 'chat_messages', `
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
  `, ['id', 'thread_id', 'role', 'content', 'adapter_name', 'status', 'error', 'session_id', 'context_refs', 'tool_calls', 'created_at'])

  // Create indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_graph_id ON nodes(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_edges_graph_id ON edges(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bug_nodes_node_id ON bug_nodes(node_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bug_nodes_graph_id ON bug_nodes(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_snapshots_graph_id ON snapshots(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_logs_session_id ON agent_logs(session_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_threads_node_id ON chat_threads(node_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_threads_graph_id ON chat_threads(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_threads_updated_at ON chat_threads(updated_at)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON chat_messages(thread_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at)`)

  // Incremental migration: add new columns for MindMap Agent (safe if already exist)
  const addColumnSafe = async (table: string, column: string, type: string) => {
    if (!isValidIdentifier(table) || !isValidIdentifier(column)) {
      throw new DatabaseError(`Invalid identifier for migration: ${table}.${column}`, ErrorCode.DB_INVALID_IDENTIFIER)
    }
    const ALLOWED_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC'])
    if (!ALLOWED_TYPES.has(type.toUpperCase())) {
      throw new DatabaseError(`Unsupported column type: ${type}`, ErrorCode.DB_INVALID_IDENTIFIER)
    }
    const safeType = type.toUpperCase()
    try {
      await db.execute(`ALTER TABLE ${safeIdentifier(table)} ADD COLUMN ${safeIdentifier(column)} ${safeType}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('duplicate column') || msg.includes('already exists')) {
        return // 列已存在，安全忽略
      }
      throw new DatabaseError(`Failed to add column ${column} to ${table}: ${msg}`, ErrorCode.DB_QUERY_FAILED)
    }
  }
  await addColumnSafe('nodes', 'content', 'TEXT')
  await addColumnSafe('nodes', 'community_summary', 'TEXT')
  await addColumnSafe('nodes', 'community_level', 'INTEGER')
  await addColumnSafe('edges', 'content', 'TEXT')
  await addColumnSafe('edges', 'description', 'TEXT')
  await addColumnSafe('edges', 'data_flow', 'TEXT')
  await addColumnSafe('edges', 'strength', 'REAL')

    await db.execute('RELEASE migrate_sp')
  } catch (err) {
    await db.execute('ROLLBACK TO migrate_sp').catch(() => {})
    throw err
  }
}
