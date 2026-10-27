/**
 * BizGraph database layer
 * Using better-sqlite3 for local single-file database (full arch support)
 */

import BetterSqlite3 from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DB_FILENAME } from '@shared/constants'
import { DatabaseError, ErrorCode } from './errors'
import { createLogger } from './shared/logger'
import { runHierarchyMigration } from './repositories/hierarchy-migration'

const logger = createLogger('Database')

let db: BetterSqlite3.Database | null = null
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

export function initDatabase(): BetterSqlite3.Database {
  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'data')
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, DB_FILENAME)

  db = new BetterSqlite3(dbPath)

  // 启用 WAL 模式提升并发读性能
  db.pragma('journal_mode = WAL')
  // 启用外键约束
  db.pragma('foreign_keys = ON')
  // 设置 WAL 自动 checkpoint 阈值（Pages），防止 WAL 文件无限增长
  db.pragma('wal_autocheckpoint = 1000')

  migrate()

  // 定期 WAL checkpoint，防止 WAL 文件膨胀（每 5 分钟）
  keepaliveTimer = setInterval(() => {
    if (!db) return
    try {
      db.pragma('wal_checkpoint(PASSIVE)')
    } catch (err) {
      logger.warn('WAL checkpoint failed:', err)
    }
  }, 5 * 60 * 1000)
  // 不阻止进程退出
  if (keepaliveTimer.unref) keepaliveTimer.unref()

  return db
}

/** 关闭数据库连接 */
export function closeDatabase(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (err) {
      logger.warn('Final WAL checkpoint failed during close:', err)
    }
    try {
      db.pragma('optimize')
    } catch (err) {
      logger.warn('PRAGMA optimize failed during close:', err)
    }
    db.close()
    db = null
  }
}

export function getClient(): BetterSqlite3.Database {
  if (!db) {
    throw new DatabaseError('Database not initialized. Call initDatabase() first.', ErrorCode.DB_NOT_INITIALIZED)
  }
  return db
}

/**
 * Restore data from a backup table, handling enum value migrations
 */
function restoreFromBackup(
  db: BetterSqlite3.Database,
  tableName: string,
  tempTable: string,
): void {
  if (!isValidIdentifier(tableName) || !isValidIdentifier(tempTable)) {
    throw new DatabaseError(`Invalid table identifier: ${tableName} or ${tempTable}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }

  try {
    const newColsResult = db.pragma(`table_info(${safeIdentifier(tableName)})`) as Record<string, unknown>[]
    const newCols = newColsResult.map((r) => r.name as string).filter(isValidIdentifier)

    const oldColsResult = db.pragma(`table_info(${safeIdentifier(tempTable)})`) as Record<string, unknown>[]
    const oldCols = oldColsResult.map((r) => r.name as string).filter(isValidIdentifier)

    const commonCols = newCols.filter((c: string) => oldCols.includes(c))

    if (commonCols.length > 0) {
      const colsStr = commonCols.map(safeIdentifier).join(', ')
      const selectCols = commonCols.map((col: string) => {
        const safeCol = safeIdentifier(col)
        if (tableName === 'graphs' && col === 'type') {
          return `CASE ${safeCol} WHEN 'production' THEN 'online' WHEN 'development' THEN 'dev' ELSE ${safeCol} END AS ${safeCol}`
        }
        if (tableName === 'nodes' && col === 'graph_type') {
          return `CASE ${safeCol} WHEN 'production' THEN 'online' WHEN 'development' THEN 'dev' ELSE ${safeCol} END AS ${safeCol}`
        }
        if (tableName === 'nodes' && col === 'type') {
          return `CASE ${safeCol} WHEN 'rule' THEN 'process' WHEN 'api' THEN 'feature' WHEN 'service' THEN 'feature' WHEN 'entity' THEN 'feature' ELSE ${safeCol} END AS ${safeCol}`
        }
        return safeCol
      }).join(', ')
      db.exec(`INSERT INTO ${safeIdentifier(tableName)} (${colsStr}) SELECT ${selectCols} FROM ${safeIdentifier(tempTable)}`)
    }

    db.exec(`DROP TABLE ${safeIdentifier(tempTable)}`)
    logger.info(`Restored ${tableName} data from backup`)
  } catch (restoreErr) {
    logger.error(`Failed to restore ${tableName} data, will rollback:`, restoreErr)
    throw restoreErr
  }
}

/** 表级约束（不是列定义）：PRIMARY KEY (...) / FOREIGN KEY (...) / UNIQUE / CHECK / CONSTRAINT */
const TABLE_CONSTRAINT_PREFIX = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i

/** 列定义里类型之后可能出现的约束关键字 —— 类型声明在第一个关键字处结束 */
const COLUMN_CONSTRAINT_KEYWORD =
  /\b(NOT\s+NULL|NULL|PRIMARY\s+KEY|PRIMARY|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|GENERATED|AS|CONSTRAINT)\b/i

/** 合法的声明类型：TEXT / INTEGER / DOUBLE PRECISION / VARCHAR(255) 等 */
const DECLARED_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*[^()]*\))?$/

/** 找到与 openIdx 处 '(' 配对的 ')' 下标；找不到返回 -1 */
function findMatchingParen(sql: string, openIdx: number): number {
  let depth = 0
  let inString = false
  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i]
    if (inString) {
      if (ch === "'") inString = false
      continue
    }
    if (ch === "'") {
      inString = true
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 按分隔符切分，忽略括号内与引号内的分隔符 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      current += ch
      if (ch === "'") inString = false
      continue
    }
    if (ch === "'") {
      inString = true
      current += ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(current)
      current = ''
      i += separator.length - 1
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * 从 CREATE TABLE 语句解析出「列名 -> 声明类型」。
 * 只解析顶层括号内按逗号切分的片段，跳过表级约束。
 * 解析不出类型的列不进结果 —— 调用方据此跳过该列的类型比对，
 * 宁可漏判也不因解析失败误判重建。
 */
function parseDeclaredColumnTypes(createSql: string): Map<string, string> {
  const types = new Map<string, string>()
  const open = createSql.indexOf('(')
  if (open === -1) return types
  const close = findMatchingParen(createSql, open)
  if (close === -1) return types

  for (const segment of splitTopLevel(createSql.slice(open + 1, close), ',')) {
    const trimmed = segment.trim()
    if (!trimmed || TABLE_CONSTRAINT_PREFIX.test(trimmed)) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]*)$/.exec(trimmed)
    if (!match) continue
    const type = extractDeclaredType(match[2])
    if (type) types.set(match[1], type)
  }
  return types
}

/** 取列声明里类型部分（去掉 NOT NULL / PRIMARY KEY / DEFAULT 等修饰），归一化为大写 */
function extractDeclaredType(rest: string): string | undefined {
  const cut = rest.search(COLUMN_CONSTRAINT_KEYWORD)
  const typePart = (cut === -1 ? rest : rest.slice(0, cut)).trim()
  if (!typePart) return undefined
  if (!DECLARED_TYPE_PATTERN.test(typePart)) return undefined
  return typePart.replace(/\s+/g, ' ').trim().toUpperCase()
}

/**
 * 比对实际表结构与 createSql 的列类型。
 * 类型比较忽略大小写与首尾空白。解析不出的列跳过比对（不误判重建）。
 */
function columnTypesMatch(
  db: BetterSqlite3.Database,
  tableName: string,
  createSql: string,
): boolean {
  const declared = parseDeclaredColumnTypes(createSql)
  if (declared.size === 0) return true

  const colResult = db.pragma(`table_info(${safeIdentifier(tableName)})`) as Record<string, unknown>[]
  for (const row of colResult) {
    const name = row.name as string
    const expected = declared.get(name)
    // 表里多出来的列：列名集合由 requiredColumns 负责，这里不比类型
    if (expected === undefined) continue
    const actual = String(row.type ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
    if (actual !== expected) return false
  }
  return true
}

/**
 * Check if table needs rebuilding (when schema changes)
 */
export function rebuildTableIfNeeded(
  db: BetterSqlite3.Database,
  tableName: string,
  createSql: string,
  requiredColumns: string[],
): void {
  if (!isValidIdentifier(tableName)) {
    throw new DatabaseError(`Invalid table identifier: ${tableName}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }

  const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName)

  if (!tableInfo) {
    db.exec(createSql)
    return
  }

  const colResult = db.pragma(`table_info(${safeIdentifier(tableName)})`) as Record<string, unknown>[]
  const existingCols = new Set(colResult.map((r) => r.name as string).filter(isValidIdentifier))
  const hasAllColumns = requiredColumns.filter(isValidIdentifier).every((col) => existingCols.has(col))

  const tempTable = `${tableName}_backup`
  if (!isValidIdentifier(tempTable)) {
    throw new DatabaseError(`Invalid backup table identifier: ${tempTable}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }

  if (hasAllColumns) {
    const existingSqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { sql: string } | undefined
    const existingSql = (existingSqlRow?.sql as string) ?? ''

    const extractChecks = (sql: string) => {
      const checks: string[] = []
      const lowerSql = sql.toLowerCase()
      let i = 0
      while (i < lowerSql.length) {
        const idx = lowerSql.indexOf('check(', i)
        if (idx === -1) break
        let depth = 1
        let j = idx + 6
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

    if (existingChecks === expectedChecks && columnTypesMatch(db, tableName, createSql)) {
      const backupCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tempTable)
      if (backupCheck) {
        logger.info(`Found leftover backup ${tempTable}, restoring data...`)
        restoreFromBackup(db, tableName, tempTable)
      }
      return
    }

    logger.info(`Table ${tableName} CHECK constraints or column types changed, rebuilding...`)
  }

  logger.info(`Table ${tableName} schema outdated, rebuilding...`)

  db.exec('SAVEPOINT rebuild_sp')
  try {
    db.exec(`DROP TABLE IF EXISTS ${safeIdentifier(tempTable)}`)
    db.exec(`CREATE TABLE ${safeIdentifier(tempTable)} AS SELECT * FROM ${safeIdentifier(tableName)}`)
    db.exec(`DROP TABLE ${safeIdentifier(tableName)}`)
    db.exec(createSql)
    restoreFromBackup(db, tableName, tempTable)
    db.exec('RELEASE rebuild_sp')
    logger.info(`Table ${tableName} rebuilt successfully`)
  } catch (err) {
    try { db.exec('ROLLBACK TO rebuild_sp') } catch (rollbackErr) {
      logger.error(`Rollback failed for ${tableName}:`, rollbackErr)
    }
    throw err
  }
}

/** 当前 Schema 版本号，每次迁移时递增 */
const CURRENT_SCHEMA_VERSION = 17

interface TableSchema {
  name: string
  createSql: string
  requiredColumns: string[]
}

const TABLE_SCHEMAS: TableSchema[] = [
  {
    name: 'graphs',
    createSql: `
      CREATE TABLE graphs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('online', 'dev')),
        project_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    requiredColumns: ['id', 'name', 'type', 'created_at', 'updated_at'],
  },
  {
    name: 'nodes',
    createSql: `
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
        sort_index INTEGER,
        collapsed INTEGER NOT NULL DEFAULT 0,
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
      )
    `,
    requiredColumns: ['id', 'type', 'status', 'title', 'graph_id', 'graph_type', 'position_x', 'position_y', 'created_at', 'updated_at', 'wiki_content', 'wiki_meta'],
  },
  {
    name: 'edges',
    createSql: `
      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        label TEXT,
        edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change', 'wiki-link', 'hierarchical')),
        graph_id TEXT NOT NULL,
        content TEXT,
        description TEXT,
        data_flow TEXT,
        strength REAL
      )
    `,
    requiredColumns: ['id', 'source', 'target', 'graph_id'],
  },
  {
    name: 'bug_nodes',
    createSql: `
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
    `,
    requiredColumns: ['id', 'title', 'description', 'severity', 'status', 'node_id', 'graph_id', 'created_at', 'updated_at'],
  },
  {
    name: 'snapshots',
    createSql: `
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        git_commit TEXT,
        created_at TEXT NOT NULL
      )
    `,
    requiredColumns: ['id', 'graph_id', 'name', 'data', 'created_at'],
  },
  {
    name: 'agent_logs',
    createSql: `
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
    `,
    requiredColumns: ['id', 'session_id', 'adapter_name', 'node_id', 'graph_id', 'command', 'outputs', 'result', 'duration', 'created_at'],
  },
  {
    name: 'chat_threads',
    createSql: `
      CREATE TABLE chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        adapter_name TEXT NOT NULL,
        node_id TEXT,
        graph_id TEXT,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'error', 'reviewed', 'active', 'archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'title', 'adapter_name', 'node_id', 'graph_id', 'session_id', 'status', 'created_at', 'updated_at'],
  },
  {
    name: 'chat_messages',
    createSql: `
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),
        content TEXT NOT NULL,
        adapter_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error', 'pending', 'streaming', 'aborted', 'queued', 'sending', 'permanently_failed')),
        error TEXT,
        session_id TEXT,
        context_refs TEXT,
        tool_calls TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'thread_id', 'role', 'content', 'adapter_name', 'status', 'error', 'session_id', 'context_refs', 'tool_calls', 'created_at'],
  },
  {
    name: 'memory_items',
    createSql: `
      CREATE TABLE memory_items (
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
    `,
    requiredColumns: ['id', 'session_id', 'kind', 'project_id', 'title', 'narrative', 'created_at'],
  },
  {
    name: 'compact_history',
    createSql: `
      CREATE TABLE compact_history (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES chat_threads(id) ON DELETE CASCADE,
        session_id TEXT,
        strategy TEXT NOT NULL,
        trigger TEXT NOT NULL,
        tokens_before INTEGER NOT NULL,
        tokens_after INTEGER NOT NULL,
        summary TEXT,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      )
    `,
    requiredColumns: ['id', 'strategy', 'trigger', 'tokens_before', 'tokens_after', 'started_at', 'duration_ms'],
  },
  {
    name: 'subagent_invocations',
    createSql: `
      CREATE TABLE subagent_invocations (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        parent_message_id TEXT REFERENCES chat_messages(id),
        graph_id TEXT REFERENCES graphs(id) ON DELETE CASCADE,
        agent_type TEXT NOT NULL,
        description TEXT NOT NULL,
        prompt TEXT NOT NULL,
        adapter_name TEXT,
        node_id TEXT,
        allowed_files TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
        result_text TEXT,
        result_files TEXT,
        tokens_used INTEGER DEFAULT 0,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT
      )
    `,
    requiredColumns: ['id', 'parent_session_id', 'agent_type', 'description', 'prompt', 'status', 'started_at'],
  },
  {
    name: 'writeback_items',
    createSql: `
      CREATE TABLE writeback_items (
        id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('append-log','new-page')),
        target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        details TEXT,
        narrative TEXT,
        source_node_ids TEXT,
        target_node_title TEXT,
        source_session_id TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded','rolled_back')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        rollback_actions TEXT,
        created_node_id TEXT
      )
    `,
    requiredColumns: ['id', 'graph_id', 'kind', 'target_node_id', 'title', 'content', 'source_session_id', 'confidence', 'status', 'created_at'],
  },
  // v10: Recipes（YAML 可分享工作流）
  // recipes 表存储已加载的 recipe 快照（source_path + yaml_text + 解析后字段）
  // recipe_runs 表存储每次执行的完整记录（步骤 + 输出 + 状态），便于审计与重放。
  {
    name: 'recipes',
    createSql: `
      CREATE TABLE recipes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT,
        tags TEXT,
        source TEXT NOT NULL CHECK(source IN ('user','project','builtin')),
        source_path TEXT NOT NULL,
        yaml_text TEXT NOT NULL,
        inputs_schema TEXT,
        steps_json TEXT NOT NULL,
        default_adapter TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    requiredColumns: ['id', 'name', 'version', 'source', 'source_path', 'yaml_text', 'steps_json', 'created_at', 'updated_at'],
  },
  {
    name: 'recipe_runs',
    createSql: `
      CREATE TABLE recipe_runs (
        id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        recipe_version TEXT NOT NULL,
        session_id TEXT,
        graph_id TEXT,
        node_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
        inputs_json TEXT NOT NULL DEFAULT '{}',
        steps_json TEXT NOT NULL DEFAULT '[]',
        outputs_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      )
    `,
    requiredColumns: ['id', 'recipe_id', 'recipe_version', 'status', 'inputs_json', 'steps_json', 'outputs_json', 'started_at'],
  },
  // v11：Yjs 文档快照（Y.Doc 二进制持久化层）
  // 每张图一行；doc_state 是 Y.encodeStateAsUpdate() 输出的 BLOB。
  // schema_version 写入侧规则版本（字段语义变化时 +1，老数据读 path 不一致会被拒）。
  // 老 nodes/edges 表保留作为只读 fallback 以兼容既有 query；启动时由 SnapshotStore 一次性回填。
  {
    name: 'yjs_snapshots',
    createSql: `
      CREATE TABLE yjs_snapshots (
        graph_id TEXT PRIMARY KEY,
        doc_state BLOB NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (graph_id) REFERENCES graphs(id) ON DELETE CASCADE
      )
    `,
    requiredColumns: ['graph_id', 'doc_state', 'schema_version', 'updated_at'],
  },
]

const INDEX_SQLS: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_nodes_graph_id ON nodes(graph_id)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_graph_id ON edges(graph_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bug_nodes_node_id ON bug_nodes(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bug_nodes_graph_id ON bug_nodes(graph_id)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_graph_id ON snapshots(graph_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_logs_session_id ON agent_logs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_node_id ON chat_threads(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_graph_id ON chat_threads(graph_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_updated_at ON chat_threads(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON chat_messages(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at)`,
  // v10 recipes
  `CREATE INDEX IF NOT EXISTS idx_recipes_source ON recipes(source)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_runs_recipe_id ON recipe_runs(recipe_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_runs_status ON recipe_runs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_runs_session_id ON recipe_runs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_items_session_id ON memory_items(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_items_project ON memory_items(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_items_kind ON memory_items(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_items_node ON memory_items(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_items_created ON memory_items(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_items_project_adapter ON memory_items(project_id, adapter_name)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_graph_id_type ON nodes(graph_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_graph_id_status ON nodes(graph_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_adapter_status ON chat_threads(adapter_name, status)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_status ON chat_messages(thread_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_items_project_created ON memory_items(project_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_compact_history_thread ON compact_history(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_compact_history_started ON compact_history(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_subagent_inv_parent ON subagent_invocations(parent_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subagent_inv_status ON subagent_invocations(status)`,
  `CREATE INDEX IF NOT EXISTS idx_writeback_graph_status ON writeback_items(graph_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_writeback_session ON writeback_items(source_session_id)`,
  // v11: yjs_snapshots
  `CREATE INDEX IF NOT EXISTS idx_yjs_snapshots_updated_at ON yjs_snapshots(updated_at DESC)`,
  // Phase D9: A2A 任务查询 — json_extract 表达式索引加速 task_kind='a2a' 过滤。
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_task_kind ON chat_threads(json_extract(metadata, '$.task_kind'))`,
]

function getSchemaChecksumPath(): string {
  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'data')
  fs.mkdirSync(dbDir, { recursive: true })
  return path.join(dbDir, 'schema-checksum.json')
}

function computeSchemaChecksum(): string {
  const payload = JSON.stringify({
    version: CURRENT_SCHEMA_VERSION,
    tables: TABLE_SCHEMAS.map((s) => s.createSql.trim()),
    indexes: INDEX_SQLS,
  })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

function readSchemaChecksumCache(): { checksum: string; version: number } | null {
  try {
    const raw = fs.readFileSync(getSchemaChecksumPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.checksum === 'string' && typeof parsed.version === 'number') {
      return { checksum: parsed.checksum, version: parsed.version }
    }
  } catch {
    // cache missing or corrupt
  }
  return null
}

function writeSchemaChecksumCache(checksum: string): void {
  try {
    fs.writeFileSync(
      getSchemaChecksumPath(),
      JSON.stringify({ checksum, version: CURRENT_SCHEMA_VERSION, createdAt: new Date().toISOString() }, null, 2),
    )
  } catch (err) {
    logger.warn('Failed to write schema checksum cache:', err)
  }
}

function migrate(): void {
  const db = getClient()

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `)

  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined
  const currentVersion = versionRow?.version ?? 0
  const checksum = computeSchemaChecksum()
  const checksumCache = readSchemaChecksumCache()

  // Fast path: schema version and checksum are both current — skip expensive rebuild/index checks.
  if (currentVersion >= CURRENT_SCHEMA_VERSION && checksumCache?.version === CURRENT_SCHEMA_VERSION && checksumCache?.checksum === checksum) {
    runIncrementalMigrations(db, currentVersion)
    return
  }

  logger.info(`Migrating schema from v${currentVersion} to v${CURRENT_SCHEMA_VERSION}...`)

  // 外键必须在事务开始前关闭：事务内 PRAGMA foreign_keys 是 no-op。
  // 若保持开启，rebuildTableIfNeeded 里的 `DROP TABLE` 会触发 ON DELETE CASCADE，
  // 级联清空依赖表（如 nodes → edges / bug_nodes），且这些行不会被 restoreFromBackup 恢复，
  // 造成静默数据丢失。遵循 SQLite 官方表重建配方：OFF → 重建 → foreign_key_check → ON。
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1
  if (fkWasOn) db.pragma('foreign_keys = OFF')

  db.exec('SAVEPOINT migrate_sp')
  try {
    // 慢路径（版本落后 **或** checksum 失配）一律尝试重建。
    // 只按版本号门禁会让「改了 createSql 但忘了 bump CURRENT_SCHEMA_VERSION」的
    // schema 变更静默失效：checksum 已经失配，却因为版本号没变而跳过重建。
    // rebuildTableIfNeeded 内部只在列集合 / 列类型 / CHECK 变化时才真正重建，
    // 无变化时仅做几次 pragma 查询，代价可忽略。
    for (const schema of TABLE_SCHEMAS) {
      rebuildTableIfNeeded(db, schema.name, schema.createSql, schema.requiredColumns)
    }

    // 增量补列必须先于索引创建：Phase D9 的表达式索引依赖
    // chat_threads.metadata（由 addColumnSafe 补齐），老库上先建索引会因列不存在而失败。
    runIncrementalMigrations(db, currentVersion)

    // Create indexes idempotently (cheap even when up-to-date).
    for (const sql of INDEX_SQLS) {
      db.exec(sql)
    }

    db.prepare('INSERT OR REPLACE INTO schema_version (rowid, version) VALUES (1, ?)').run(CURRENT_SCHEMA_VERSION)

    // 重建期间外键未强制，提交前校验完整性，及早发现迁移引入的悬空引用。
    const fkViolations = db.pragma('foreign_key_check') as unknown[]
    if (Array.isArray(fkViolations) && fkViolations.length > 0) {
      throw new DatabaseError(
        `Foreign key violations after migration: ${JSON.stringify(fkViolations.slice(0, 10))}`,
        ErrorCode.DB_MIGRATION_FAILED,
      )
    }

    db.exec('RELEASE migrate_sp')
    writeSchemaChecksumCache(checksum)
    logger.info(`Schema migrated to v${CURRENT_SCHEMA_VERSION}`)
  } catch (err) {
    // 必须完全退出事务，否则下方恢复 foreign_keys 的 PRAGMA 会被当作 no-op。
    // ROLLBACK TO 和 RELEASE 分开 try/catch：若两者在同一块，RELEASE 抛出时
    // savepoint 泄漏，导致 finally 中的 PRAGMA foreign_keys = ON 仍为 no-op。
    try { db.exec('ROLLBACK TO migrate_sp') } catch (rollbackErr) {
      logger.warn('ROLLBACK TO migrate_sp failed:', rollbackErr)
    }
    try { db.exec('RELEASE migrate_sp') } catch (releaseErr) {
      logger.warn('RELEASE migrate_sp (after rollback) failed:', releaseErr)
    }
    throw err
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON')
  }
}

/**
 * 校验 ALTER TABLE 的 DEFAULT 值，防止 SQL 注入
 * 仅允许：数值字面量、单引号字符串、NULL、CURRENT_TIMESTAMP
 */
function validateDefaultValue(value: string): string {
  if (value.includes(';')) {
    throw new DatabaseError(`Invalid default value (contains semicolon): ${value}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }
  const trimmed = value.trim()
  const SAFE_PATTERNS = [
    /^-?\d+(\.\d+)?$/,                    // numeric literals: 0, 1, -1, 3.14
    /^'.*'$/,                              // quoted string literals: 'text'
    /^NULL$/i,                             // NULL
    /^CURRENT_TIMESTAMP$/i,               // CURRENT_TIMESTAMP
  ]
  if (SAFE_PATTERNS.some((p) => p.test(trimmed))) return trimmed
  throw new DatabaseError(`Invalid default value (not a safe literal): ${value}`, ErrorCode.DB_INVALID_IDENTIFIER)
}

/**
 * 增量迁移：安全添加新列（幂等操作，可重复执行）
 */
function runIncrementalMigrations(db: BetterSqlite3.Database, currentVersion = 0): void {
  const addColumnSafe = (table: string, column: string, type: string, defaultValue?: string) => {
    if (!isValidIdentifier(table) || !isValidIdentifier(column)) {
      throw new DatabaseError(`Invalid identifier for migration: ${table}.${column}`, ErrorCode.DB_INVALID_IDENTIFIER)
    }
    const ALLOWED_TYPES = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC'])
    if (!ALLOWED_TYPES.has(type.toUpperCase())) {
      throw new DatabaseError(`Unsupported column type: ${type}`, ErrorCode.DB_INVALID_IDENTIFIER)
    }
    const safeType = type.toUpperCase()
    const defaultClause = defaultValue !== undefined ? ` DEFAULT ${validateDefaultValue(defaultValue)}` : ''
    try {
      db.exec(`ALTER TABLE ${safeIdentifier(table)} ADD COLUMN ${safeIdentifier(column)} ${safeType}${defaultClause}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('duplicate column') || msg.includes('already exists')) {
        return
      }
      throw new DatabaseError(`Failed to add column ${column} to ${table}: ${msg}`, ErrorCode.DB_QUERY_FAILED)
    }
  }

  addColumnSafe('nodes', 'content', 'TEXT')
  addColumnSafe('nodes', 'community_summary', 'TEXT')
  addColumnSafe('nodes', 'community_level', 'INTEGER')
  addColumnSafe('nodes', 'community_id', 'TEXT')
  addColumnSafe('edges', 'content', 'TEXT')
  addColumnSafe('edges', 'description', 'TEXT')
  addColumnSafe('edges', 'data_flow', 'TEXT')
  addColumnSafe('edges', 'strength', 'REAL')
  addColumnSafe('edges', 'updated_at', 'TEXT')
  addColumnSafe('graphs', 'writeback_disabled', 'INTEGER', '0')

  // v17：结构编辑 —— 兄弟顺序 + 子树折叠状态（0=展开 / 1=折叠，跨会话保留）。
  // 走 addColumnSafe 的 ALTER TABLE 路径：这两列**不能**进 nodes 的 requiredColumns，
  // 加进去会让 rebuildTableIfNeeded 走 DROP TABLE 重建 nodes，风险远大于收益。
  addColumnSafe('nodes', 'sort_index', 'INTEGER')
  addColumnSafe('nodes', 'collapsed', 'INTEGER', '0')

  if (currentVersion < 3) {
    addColumnSafe('memory_items', 'version', 'INTEGER', '1')
    addColumnSafe('memory_items', 'parent_version', 'INTEGER', 'NULL')
    addColumnSafe('memory_items', 'embedding', 'TEXT', 'NULL')
  }

  if (currentVersion < 5) {
    addColumnSafe('nodes', 'wiki_content', 'TEXT')
    addColumnSafe('nodes', 'wiki_meta', 'TEXT')
  }

  // ChatRepository 读取这些列时要求存在（requireNumber），必须保证任何升级路径都会补齐
  addColumnSafe('chat_messages', 'token_count', 'INTEGER', '0')
  addColumnSafe('chat_threads', 'parent_thread_id', 'TEXT', 'NULL')
  addColumnSafe('chat_threads', 'context_tokens_used', 'INTEGER', '0')
  addColumnSafe('chat_threads', 'context_window_max', 'INTEGER', '0')
  addColumnSafe('chat_threads', 'last_compacted_at', 'INTEGER', 'NULL')

  // Phase D9: A2A 任务复用 chat_threads；metadata.task_kind='a2a' 区分本地任务。
  // TEXT 默认 '{}' 以便现有查询无需兼容 null。
  addColumnSafe('chat_threads', 'metadata', 'TEXT', "'{}'")

  // v9：writeback_items 拆分 details / narrative / source_node_ids / target_node_title
  // 旧 content 已内嵌 <details> 折叠块；新 schema 让前端按字段渲染，
  // 旧 item.content 仍可读（旧数据向前兼容），新生成的写入新字段。
  addColumnSafe('writeback_items', 'details', 'TEXT')
  addColumnSafe('writeback_items', 'narrative', 'TEXT')
  addColumnSafe('writeback_items', 'source_node_ids', 'TEXT')
  addColumnSafe('writeback_items', 'target_node_title', 'TEXT')

  // v10：recipes + recipe_runs 由 TABLE_DEFINITIONS 首次创建；增量迁移仅做"已存在老库"补列。
  // 注：recipes / recipe_runs 是全新表，老 schema 没创建过它们，故 runIncrementalMigrations 不补。
  // 任何 v<10 → v10 升级由 migrate() 在首次冷启动时通过 TABLE_DEFINITIONS 完整 CREATE。

  // v13：writeback rollback（D7b）— 新增 rolled_back 状态 + rollback_actions 审计列。
  // CHECK 约束扩展由 rebuildTableIfNeeded 检测；老库升级路径上补 rollback_actions 列。
  addColumnSafe('writeback_items', 'rollback_actions', 'TEXT')

  // v15：记录 new-page 采纳时**实际创建**的节点 id。
  // 没有它，撤回只能按标题找同名 wiki-page —— 会把同名但并非本项创建的
  // 页面一起删掉（数据丢失）。
  addColumnSafe('writeback_items', 'created_node_id', 'TEXT')

  // v17：层级结构数据迁移（清孤儿 → 回填 sort_index → default 边改写 → 补齐层级边）。
  // 必须排在上面 addColumnSafe 之后 —— 迁移要回填 sort_index，列不存在会直接报错。
  runHierarchyMigration(db)
}
