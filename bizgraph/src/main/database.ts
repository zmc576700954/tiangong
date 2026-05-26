/**
 * BizGraph 数据库层
 * 使用 LibSQL (SQLite 超集) 实现本地单文件数据库
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

async function migrate(): Promise<void> {
  const db = getClient()

  // 图表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('production', 'development')),
      source_graph_id TEXT,
      target_placeholder_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  // 节点表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('module', 'process', 'rule', 'api', 'service', 'entity')),
      status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder')),
      title TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      graph_id TEXT NOT NULL,
      graph_type TEXT NOT NULL CHECK(graph_type IN ('production', 'development')),
      parent_id TEXT,
      placeholder_of TEXT,
      owner_role TEXT CHECK(owner_role IN ('product', 'developer', 'tester')),
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  // 边表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      label TEXT,
      graph_id TEXT NOT NULL
    )
  `)

  // Bug 节点表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS bug_nodes (
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

  // 快照表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      git_commit TEXT,
      created_at TEXT NOT NULL
    )
  `)

  // Agent 执行日志表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS agent_logs (
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

  // 创建索引
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_graph_id ON nodes(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_edges_graph_id ON edges(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bug_nodes_node_id ON bug_nodes(node_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bug_nodes_graph_id ON bug_nodes(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_snapshots_graph_id ON snapshots(graph_id)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_logs_session_id ON agent_logs(session_id)`)

  // 迁移：为存量表添加新字段（兼容升级）
  await migrateAddColumn('nodes', 'notes', 'TEXT')
  await migrateAddColumn('nodes', 'collapsed', 'INTEGER DEFAULT 0')
  await migrateAddColumn('nodes', 'style', 'TEXT')
  await migrateAddColumn('edges', 'edge_type', 'TEXT')
  await migrateAddColumn('edges', 'style', 'TEXT')
  await migrateAddColumn('edges', 'condition', 'TEXT')
  await migrateAddColumn('edges', 'marker_end', 'TEXT')
}

/**
 * 安全地为表添加列（如果列不存在）
 */
async function migrateAddColumn(table: string, column: string, type: string): Promise<void> {
  const db = getClient()
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  } catch (err) {
    // 如果列已存在，SQLite 会报错 "duplicate column name"，忽略即可
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('duplicate column name')) {
      console.error(`Failed to add column ${column} to ${table}:`, msg)
    }
  }
}
