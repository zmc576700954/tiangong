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

/**
 * Check if table needs rebuilding (when schema changes)
 */
function rebuildTableIfNeeded(
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

    if (existingChecks === expectedChecks) {
      const backupCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tempTable)
      if (backupCheck) {
        logger.info(`Found leftover backup ${tempTable}, restoring data...`)
        restoreFromBackup(db, tableName, tempTable)
      }
      return
    }

    logger.info(`Table ${tableName} CHECK constraints changed, rebuilding...`)
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
const CURRENT_SCHEMA_VERSION = 4

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
    `,
    requiredColumns: ['id', 'type', 'status', 'title', 'graph_id', 'graph_type', 'position_x', 'position_y', 'created_at', 'updated_at'],
  },
  {
    name: 'edges',
    createSql: `
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
        status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error', 'pending', 'streaming', 'aborted')),
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

  db.exec('SAVEPOINT migrate_sp')
  try {
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      // Full rebuild path: table definitions may have changed.
      for (const schema of TABLE_SCHEMAS) {
        rebuildTableIfNeeded(db, schema.name, schema.createSql, schema.requiredColumns)
      }
    }

    // Create indexes idempotently (cheap even when up-to-date).
    for (const sql of INDEX_SQLS) {
      db.exec(sql)
    }

    runIncrementalMigrations(db, currentVersion)

    db.prepare('INSERT OR REPLACE INTO schema_version (rowid, version) VALUES (1, ?)').run(CURRENT_SCHEMA_VERSION)

    db.exec('RELEASE migrate_sp')
    writeSchemaChecksumCache(checksum)
    logger.info(`Schema migrated to v${CURRENT_SCHEMA_VERSION}`)
  } catch (err) {
    try { db.exec('ROLLBACK TO migrate_sp') } catch (rollbackErr) {
      logger.warn('ROLLBACK TO migrate_sp failed:', rollbackErr)
    }
    throw err
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
  addColumnSafe('edges', 'content', 'TEXT')
  addColumnSafe('edges', 'description', 'TEXT')
  addColumnSafe('edges', 'data_flow', 'TEXT')
  addColumnSafe('edges', 'strength', 'REAL')
  addColumnSafe('edges', 'updated_at', 'TEXT')

  if (currentVersion < 3) {
    addColumnSafe('memory_items', 'version', 'INTEGER', '1')
    addColumnSafe('memory_items', 'parent_version', 'INTEGER', 'NULL')
    addColumnSafe('memory_items', 'embedding', 'TEXT', 'NULL')
  }

  if (currentVersion < 4) {
    addColumnSafe('chat_messages', 'token_count', 'INTEGER', '0')
    addColumnSafe('chat_threads', 'parent_thread_id', 'TEXT')
    addColumnSafe('chat_threads', 'context_tokens_used', 'INTEGER', '0')
    addColumnSafe('chat_threads', 'context_window_max', 'INTEGER', '200000')
    addColumnSafe('chat_threads', 'last_compacted_at', 'INTEGER')
  }
}
