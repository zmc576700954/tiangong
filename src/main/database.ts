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

  await migrate()
  return client
}

/** 关闭数据库连接 */
export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.execute('PRAGMA optimize')
    // 如果客户端支持显式 close，优先调用以释放底层资源
    if (typeof (client as any).close === 'function') {
      await (client as any).close()
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
    // Schema is compatible — check for leftover backup table from a previous failed rebuild
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
      type TEXT NOT NULL CHECK(type IN ('module', 'process', 'feature', 'bug')),
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `, ['id', 'type', 'status', 'title', 'graph_id', 'graph_type', 'position_x', 'position_y', 'created_at', 'updated_at'])

  // Edges table
  await rebuildTableIfNeeded(db, 'edges', `
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      label TEXT,
      edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition')),
      graph_id TEXT NOT NULL
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
      node_id TEXT NOT NULL,
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

  // Create indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_graph_id ON nodes(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_edges_graph_id ON edges(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bug_nodes_node_id ON bug_nodes(node_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bug_nodes_graph_id ON bug_nodes(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_snapshots_graph_id ON snapshots(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_logs_session_id ON agent_logs(session_id)`)
}
