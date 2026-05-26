/**
 * BizGraph database layer
 * Using LibSQL (SQLite superset) for local single-file database
 */

import { createClient, type Client } from '@libsql/client'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { DB_FILENAME } from '@shared/constants'

let client: Client | null = null

export async function initDatabase(): Promise<Client> {
  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'data')
  await fs.mkdir(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, DB_FILENAME)

  client = createClient({
    url: `file:${dbPath}`,
  })

  await migrate()
  return client
}

export function getClient(): Client {
  if (!client) {
    throw new Error('Database not initialized. Call initDatabase() first.')
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
  try {
    const newColsResult = await db.execute(`PRAGMA table_info(${tableName})`)
    const newCols = newColsResult.rows.map((r) => r.name as string)

    const oldColsResult = await db.execute(`PRAGMA table_info(${tempTable})`)
    const oldCols = oldColsResult.rows.map((r) => r.name as string)

    const commonCols = newCols.filter((c) => oldCols.includes(c))

    if (commonCols.length > 0) {
      const colsStr = commonCols.join(', ')
      // Build SELECT clause with value transformations for renamed enum values
      const selectCols = commonCols.map((col) => {
        if (tableName === 'graphs' && col === 'type') {
          return `CASE ${col} WHEN 'production' THEN 'online' WHEN 'development' THEN 'dev' ELSE ${col} END AS ${col}`
        }
        if (tableName === 'nodes' && col === 'graph_type') {
          return `CASE ${col} WHEN 'production' THEN 'online' WHEN 'development' THEN 'dev' ELSE ${col} END AS ${col}`
        }
        if (tableName === 'nodes' && col === 'type') {
          // Old node types (rule/api/service/entity) mapped to new canonical types
          return `CASE ${col} WHEN 'rule' THEN 'process' WHEN 'api' THEN 'feature' WHEN 'service' THEN 'feature' WHEN 'entity' THEN 'feature' ELSE ${col} END AS ${col}`
        }
        return col
      }).join(', ')
      await db.execute(`INSERT INTO ${tableName} (${colsStr}) SELECT ${selectCols} FROM ${tempTable}`)
    }

    // Drop backup table
    await db.execute(`DROP TABLE ${tempTable}`)
    console.log(`[BizGraph] Restored ${tableName} data from backup`)
  } catch (restoreErr) {
    console.warn(`[BizGraph] Failed to restore ${tableName} data:`, restoreErr)
    try {
      await db.execute(`DROP TABLE IF EXISTS ${tempTable}`)
    } catch { /* ignore */ }
  }
}

/**
 * Check if table needs rebuilding (when schema changes)
 */
async function rebuildTableIfNeeded(
  db: Client,
  tableName: string,
  createSql: string,
): Promise<void> {
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

  // Table exists, check if schema is compatible by trying to insert with new constraints
  const tempTable = `${tableName}_backup`
  try {
    if (tableName === 'graphs') {
      await db.execute("BEGIN")
      await db.execute(`INSERT INTO ${tableName} (id, name, type, created_at, updated_at) VALUES ('_test_', '_test_', 'online', '2024-01-01', '2024-01-01')`)
      await db.execute("ROLLBACK")
    } else if (tableName === 'nodes') {
      await db.execute("BEGIN")
      await db.execute(`INSERT INTO ${tableName} (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at) VALUES ('_test_', 'module', 'draft', '_test_', '_test_', 'online', 0, 0, '2024-01-01', '2024-01-01')`)
      await db.execute("ROLLBACK")
    } else {
      // For other tables, assume compatible
      return
    }

    // Schema is compatible — check for leftover backup table from a previous failed rebuild
    const backupCheck = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [tempTable]
    )
    if (backupCheck.rows.length > 0) {
      console.log(`[BizGraph] Found leftover backup ${tempTable}, restoring data...`)
      await restoreFromBackup(db, tableName, tempTable)
    }
    return
  } catch {
    // Constraint mismatch, need to rebuild table
    console.log(`[BizGraph] Table ${tableName} schema outdated, rebuilding...`)

    // 1. Backup old table data
    try {
      await db.execute(`DROP TABLE IF EXISTS ${tempTable}`)
      await db.execute(`CREATE TABLE ${tempTable} AS SELECT * FROM ${tableName}`)
    } catch (backupErr) {
      console.warn(`[BizGraph] Failed to backup ${tableName}:`, backupErr)
    }

    // 2. Drop old table
    await db.execute(`DROP TABLE ${tableName}`)

    // 3. Create new table
    await db.execute(createSql)

    // 4. Try to restore data
    await restoreFromBackup(db, tableName, tempTable)
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
  `)

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
  `)

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
  `)

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
  `)

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
  `)

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
  `)

  // Create indexes
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_graph_id ON nodes(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_edges_graph_id ON edges(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bug_nodes_node_id ON bug_nodes(node_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bug_nodes_graph_id ON bug_nodes(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_snapshots_graph_id ON snapshots(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_logs_session_id ON agent_logs(session_id)`)
}
