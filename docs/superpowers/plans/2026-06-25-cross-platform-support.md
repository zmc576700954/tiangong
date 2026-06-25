# Cross-Platform Full Architecture Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BizGraph run natively on all 6 desktop targets (macOS arm64/x64, Windows x64/arm64, Linux x64/arm64) by replacing @libsql/client with better-sqlite3 (full architecture coverage), extending build configs, updating CI, and extracting a platform abstraction layer.

**Architecture:** Two parallel tracks — (1) immediate build/CI changes for all 6 targets, (2) database migration from libsql async API to better-sqlite3 sync API across 31 files, plus a PlatformProvider abstraction for 12 platform-specific code sites.

**Tech Stack:** Electron, better-sqlite3, electron-builder, GitHub Actions, Vitest

---

## File Structure

### New files
- `src/main/platform/platform-provider.ts` — PlatformProvider interface + getPlatformProvider() factory
- `src/main/platform/darwin-provider.ts` — macOS implementation
- `src/main/platform/win32-provider.ts` — Windows implementation
- `src/main/platform/linux-provider.ts` — Linux (incl. WSL) implementation
- `src/main/platform/index.ts` — barrel export
- `src/main/__tests__/platform-provider.test.ts` — PlatformProvider mock tests

### Modified files (database migration)
- `src/main/database.ts` — core: createClient → new Database, async→sync
- `src/main/repositories/node-repository.ts` — async→sync, batch→transaction
- `src/main/repositories/edge-repository.ts` — async→sync
- `src/main/repositories/graph-repository.ts` — async→sync, batch→transaction, Promise.all→sequential
- `src/main/repositories/chat-repository.ts` — async→sync, batch→transaction, Row→Row object, rowsAffected→changes
- `src/main/repositories/bug-repository.ts` — async→sync
- `src/main/repositories/snapshot-repository.ts` — async→sync
- `src/main/repositories/agent-log-repository.ts` — async→sync
- `src/main/repositories/compact-history-repository.ts` — async→sync, Row→Row object
- `src/main/repositories/subagent-invocation-repository.ts` — async→sync, Row→Row object
- `src/main/services/graph-service.ts` — async→sync, transaction rewrite
- `src/main/services/chat-service.ts` — type Client→Database
- `src/main/memory/memory-store.ts` — async→sync, batch→transaction, lastInsertRowid/rowsAffected
- `src/main/memory/hybrid-search.ts` — async→sync
- `src/main/memory/waterline-sync.ts` — async→sync, batch→transaction
- `src/main/memory/pipeline.ts` — async→sync, batch→transaction
- `src/main/ipc/graph.ts` — type Client→Database
- `src/main/ipc-handlers.ts` — type Client→Database, getClient return type
- `src/main/agent/agent-manager.ts` — type ResultSet→RunResult, async→sync
- `src/main/code-intelligence/symbol-index.ts` — type Client→Database, async→sync
- `src/main/index.ts` — initDatabase/closeDatabase sync

### Modified files (platform abstraction — Batch 1)
- `src/main/ipc/utils.ts` — delegate to provider.pathsEqual/isSystemPath
- `src/main/ipc-handlers.ts` — delegate to provider.pathsEqual
- `src/main/ipc/fs.ts` — delegate to provider.isWithinParent
- `src/main/ipc/git.ts` — delegate to provider.pathsEqual
- `src/main/scope-guard.ts` — delegate to provider.pathsEqual/isWithinParent

### Modified files (platform abstraction — Batch 2)
- `src/main/adapters/base.ts` — delegate to provider.killProcess/getShellConfig
- `src/main/adapters/mindmap-adapter.ts` — delegate to provider.getShellConfig
- `src/main/settings.ts` — delegate to provider.whichCommand

### Modified files (platform abstraction — Batch 3)
- `src/main/index.ts` — delegate to provider.isMac
- `src/main/scope-guard.ts` — delegate to provider.isWsl/getWatcherOptions
- `src/main/project-scanner/dir-scanner.ts` — delegate to provider.isSystemPath

### Modified files (config)
- `package.json` — deps + build targets
- `vite.config.ts` — external list
- `.github/workflows/ci.yml` — 6-node matrix

### Modified files (tests)
- `src/main/__tests__/chat-repository.test.ts` — mock rewrite
- `src/main/__tests__/bug-repository.test.ts` — mock rewrite
- `src/main/__tests__/edge-repository.test.ts` — mock rewrite
- `src/main/__tests__/compact-history-repository.test.ts` — mock rewrite
- `src/main/__tests__/subagent-invocation-repository.test.ts` — mock rewrite
- `src/main/__tests__/database-migration.test.ts` — createClient→new Database
- `src/main/memory/__tests__/memory-store.test.ts` — createClient→new Database
- `src/main/code-intelligence/__tests__/symbol-index.test.ts` — createClient→new Database

---

## Task 1: Dependency Swap — Replace @libsql/client with better-sqlite3

**Files:**
- Modify: `package.json:28`
- Modify: `vite.config.ts:24`

- [ ] **Step 1: Remove @libsql/client, add better-sqlite3**

In `package.json`, remove `@libsql/client` and add better-sqlite3 + types:

```json
// REMOVE this line:
"@libsql/client": "^0.14.0",

// ADD these lines:
"better-sqlite3": "^12.11.1",
"@types/better-sqlite3": "^7.6.13",
```

- [ ] **Step 2: Update vite.config.ts external list**

In `vite.config.ts` line 24, replace `@libsql/client` with `better-sqlite3`:

```typescript
external: ['electron', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', 'onnxruntime-node', 'sharp'],
```

- [ ] **Step 3: Install dependencies and verify prebuild download**

```bash
cd D:/xiangmu/TianGong && npm install
```

Expected: npm installs better-sqlite3 and downloads prebuild binary. No errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vite.config.ts
git commit -m "chore: replace @libsql/client with better-sqlite3 for full arch support"
```

---

## Task 2: Rewrite database.ts Core — Async to Sync

**Files:**
- Modify: `src/main/database.ts`

This is the foundational change. All downstream repositories depend on the new `getClient()` returning `Database` from better-sqlite3.

- [ ] **Step 1: Write the failing test for sync initDatabase**

Add test to `src/main/__tests__/database-migration.test.ts` — but since the test file already uses `createClient`, we'll rewrite it entirely in Task 6. For now, verify the current test fails after the import swap by running:

```bash
npx vitest run src/main/__tests__/database-migration.test.ts
```

Expected: FAIL — `@libsql/client` no longer installed.

- [ ] **Step 2: Rewrite database.ts imports and state**

Replace lines 1-17 of `src/main/database.ts`:

```typescript
/**
 * BizGraph database layer
 * Using better-sqlite3 for local single-file database (full arch support)
 */

import BetterSqlite3 from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { DB_FILENAME } from '@shared/constants'
import { DatabaseError, ErrorCode } from './errors'
import { createLogger } from './shared/logger'

const logger = createLogger('Database')

let db: BetterSqlite3.Database | null = null
let keepaliveTimer: ReturnType<typeof setInterval> | null = null
```

- [ ] **Step 3: Rewrite initDatabase() — sync**

Replace the `initDatabase` function (lines 33-63):

```typescript
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
```

- [ ] **Step 4: Rewrite closeDatabase() — sync**

Replace the `closeDatabase` function (lines 65-85):

```typescript
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
```

- [ ] **Step 5: Rewrite getClient() return type**

Replace lines 87-92:

```typescript
export function getClient(): BetterSqlite3.Database {
  if (!db) {
    throw new DatabaseError('Database not initialized. Call initDatabase() first.', ErrorCode.DB_NOT_INITIALIZED)
  }
  return db
}
```

- [ ] **Step 6: Rewrite restoreFromBackup() — sync**

Replace the `restoreFromBackup` function (lines 94-144). Change all `await db.execute()` to `db.prepare().run/get/all()` and `result.rows[0]` to row objects:

```typescript
function restoreFromBackup(
  db: BetterSqlite3.Database,
  tableName: string,
  tempTable: string,
): void {
  if (!isValidIdentifier(tableName) || !isValidIdentifier(tempTable)) {
    throw new DatabaseError(`Invalid table identifier: ${tableName} or ${tempTable}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }

  try {
    const newColsResult = db.pragma(`table_info(${safeIdentifier(tableName)})`)
    const newCols = newColsResult.map((r: Record<string, unknown>) => r.name as string).filter(isValidIdentifier)

    const oldColsResult = db.pragma(`table_info(${safeIdentifier(tempTable)})`)
    const oldCols = oldColsResult.map((r: Record<string, unknown>) => r.name as string).filter(isValidIdentifier)

    const commonCols = newCols.filter((c) => oldCols.includes(c))

    if (commonCols.length > 0) {
      const colsStr = commonCols.map(safeIdentifier).join(', ')
      const selectCols = commonCols.map((col) => {
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
```

- [ ] **Step 7: Rewrite rebuildTableIfNeeded() — sync**

Replace the `rebuildTableIfNeeded` function (lines 146-262). Key changes: `await db.execute()` → `db.prepare().run/get/all()` or `db.exec()`, PRAGMA calls via `db.pragma()`, and SAVEPOINT via `db.exec()`:

```typescript
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

  const colResult = db.pragma(`table_info(${safeIdentifier(tableName)})`)
  const existingCols = new Set(colResult.map((r: Record<string, unknown>) => r.name as string).filter(isValidIdentifier))
  const hasAllColumns = requiredColumns.filter(isValidIdentifier).every((col) => existingCols.has(col))

  const tempTable = `${tableName}_backup`
  if (!isValidIdentifier(tempTable)) {
    throw new DatabaseError(`Invalid backup table identifier: ${tempTable}`, ErrorCode.DB_INVALID_IDENTIFIER)
  }

  if (hasAllColumns) {
    const existingSqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName)
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
```

- [ ] **Step 8: Rewrite migrate() — sync**

Replace the `migrate` function (lines 267-528). Change signature from `async function migrate()` to `function migrate()`. Replace all `await db.execute()` / `await rebuildTableIfNeeded()` / `await db.execute('SAVEPOINT ...')` with sync calls:

```typescript
function migrate(): void {
  const db = getClient()

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `)

  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined
  const currentVersion = versionRow?.version ?? 0

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    runIncrementalMigrations(db, currentVersion)
    return
  }

  logger.info(`Migrating schema from v${currentVersion} to v${CURRENT_SCHEMA_VERSION}...`)

  db.exec('SAVEPOINT migrate_sp')
  try {
    // All rebuildTableIfNeeded calls — identical signatures, just sync now
    rebuildTableIfNeeded(db, 'graphs', `
      CREATE TABLE graphs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('online', 'dev')),
        project_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `, ['id', 'name', 'type', 'created_at', 'updated_at'])

    rebuildTableIfNeeded(db, 'nodes', `
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

    rebuildTableIfNeeded(db, 'edges', `
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

    rebuildTableIfNeeded(db, 'bug_nodes', `
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

    rebuildTableIfNeeded(db, 'snapshots', `
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        git_commit TEXT,
        created_at TEXT NOT NULL
      )
    `, ['id', 'graph_id', 'name', 'data', 'created_at'])

    rebuildTableIfNeeded(db, 'agent_logs', `
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

    rebuildTableIfNeeded(db, 'chat_threads', `
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
    `, ['id', 'title', 'adapter_name', 'node_id', 'graph_id', 'session_id', 'status', 'created_at', 'updated_at'])

    rebuildTableIfNeeded(db, 'chat_messages', `
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

    rebuildTableIfNeeded(db, 'memory_items', `
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
    `, ['id', 'session_id', 'kind', 'project_id', 'title', 'narrative', 'created_at'])

    rebuildTableIfNeeded(db, 'compact_history', `
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
    `, ['id', 'strategy', 'trigger', 'tokens_before', 'tokens_after', 'started_at', 'duration_ms'])

    rebuildTableIfNeeded(db, 'subagent_invocations', `
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
    `, ['id', 'parent_session_id', 'agent_type', 'description', 'prompt', 'status', 'started_at'])

    // Create indexes
    const indexes = [
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
    for (const sql of indexes) {
      db.exec(sql)
    }

    runIncrementalMigrations(db, currentVersion)

    db.prepare('INSERT OR REPLACE INTO schema_version (rowid, version) VALUES (1, ?)').run(CURRENT_SCHEMA_VERSION)

    db.exec('RELEASE migrate_sp')
    logger.info(`Schema migrated to v${CURRENT_SCHEMA_VERSION}`)
  } catch (err) {
    try { db.exec('ROLLBACK TO migrate_sp') } catch (rollbackErr) {
      logger.warn('ROLLBACK TO migrate_sp failed:', rollbackErr)
    }
    throw err
  }
}
```

- [ ] **Step 9: Rewrite runIncrementalMigrations() — sync**

Replace `runIncrementalMigrations` (lines 552-597). Change `async function` to `function`, `await db.execute()` → `db.prepare().run()`, `await addColumnSafe(...)` → `addColumnSafe(...)`:

```typescript
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
```

- [ ] **Step 10: Run tests and verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: Type errors in downstream files (repositories, services, etc.) because `getClient()` now returns `BetterSqlite3.Database` instead of `Client`. These will be fixed in subsequent tasks.

- [ ] **Step 11: Commit**

```bash
git add src/main/database.ts
git commit -m "refactor(db): rewrite database.ts from libsql async to better-sqlite3 sync"
```

---

## Task 3: Rewrite Repository Layer — 8 Files Async→Sync

**Files:**
- Modify: `src/main/repositories/node-repository.ts`
- Modify: `src/main/repositories/edge-repository.ts`
- Modify: `src/main/repositories/graph-repository.ts`
- Modify: `src/main/repositories/chat-repository.ts`
- Modify: `src/main/repositories/bug-repository.ts`
- Modify: `src/main/repositories/snapshot-repository.ts`
- Modify: `src/main/repositories/agent-log-repository.ts`
- Modify: `src/main/repositories/compact-history-repository.ts`
- Modify: `src/main/repositories/subagent-invocation-repository.ts`

Each repository follows the same pattern. The key changes for every file:

1. `import type { Client } from '@libsql/client'` → `import type BetterSqlite3 from 'better-sqlite3'`
2. `constructor(private db: Client)` → `constructor(private db: BetterSqlite3.Database)`
3. Remove all `async` / `await` keywords from methods
4. `await this.db.execute({ sql, args })` → `this.db.prepare(sql).run(...args)` (for INSERT/UPDATE/DELETE) or `.get(...args)` (for SELECT single) or `.all(...args)` (for SELECT multiple)
5. `await this.db.batch(statements, 'write')` → `this.db.transaction(() => { for (const stmt of statements) { this.db.prepare(stmt.sql).run(...stmt.args) } })()`
6. `result.rows` → result of `.all()`
7. `result.rows[0]` → result of `.get()`
8. `result.rowsAffected` → `info.changes` (from `.run()` return)
9. `result.lastInsertRowid` → `info.lastInsertRowid` (from `.run()` return)
10. `type Row` from libsql → direct property access on row objects
11. `row.column_name` access stays the same (better-sqlite3 returns plain objects with column names as keys)

- [ ] **Step 1: Rewrite node-repository.ts**

Replace the entire file content. Key changes: remove `Client` import, add `BetterSqlite3` import, make all methods sync, convert `batch()` to `db.transaction()`, `execute()` to `prepare().run/get/all()`:

```typescript
import type BetterSqlite3 from 'better-sqlite3'
import type { GraphNode } from '@shared/types'
import { assertNodeType, assertNodeStatus, assertGraphType } from '@shared/type-guards'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import { DatabaseError, ErrorCode } from '../errors'

export class NodeRepository {
  constructor(private db: BetterSqlite3.Database) {}

  private rowToNode(row: Record<string, unknown>): GraphNode {
    return {
      id: row.id as string,
      type: assertNodeType(row.type as string),
      status: assertNodeStatus(row.status as string),
      title: row.title as string,
      description: row.description as string | undefined,
      acceptanceCriteria: safeJsonParse<GraphNode['acceptanceCriteria']>(row.acceptance_criteria as string | null, []),
      graphId: row.graph_id as string,
      graphType: assertGraphType(row.graph_type as string, 'graphType'),
      parentId: row.parent_id as string | undefined,
      rules: safeJsonParse<GraphNode['rules']>(row.rules as string | null, undefined),
      metadata: safeJsonParse<GraphNode['metadata']>(row.metadata as string | null, undefined),
      contextRefs: safeJsonParse<GraphNode['contextRefs']>(row.context_refs as string | null, undefined),
      ownerRole: row.owner_role as GraphNode['ownerRole'],
      position: { x: row.position_x as number, y: row.position_y as number },
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    } as GraphNode
  }

  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
    const id = generateId('node')
    const now = new Date().toISOString()

    this.db.prepare(`INSERT INTO nodes (
      id, type, status, title, description, acceptance_criteria,
      graph_id, graph_type, parent_id, rules, metadata, owner_role,
      position_x, position_y, context_refs, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, data.type, data.status, data.title,
      data.description ?? null,
      data.acceptanceCriteria ? JSON.stringify(data.acceptanceCriteria) : null,
      data.graphId, data.graphType, data.parentId ?? null,
      data.rules ? JSON.stringify(data.rules) : null,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.ownerRole ?? null,
      data.position.x, data.position.y,
      data.contextRefs ? JSON.stringify(data.contextRefs) : null,
      now, now,
    )

    return { ...data, id, createdAt: now, updatedAt: now }
  }

  createBatch(nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]): GraphNode[] {
    if (nodesData.length === 0) return []
    const now = new Date().toISOString()
    const created: GraphNode[] = []
    const insertStmt = this.db.prepare(`INSERT INTO nodes (
      id, type, status, title, description, acceptance_criteria,
      graph_id, graph_type, parent_id, rules, metadata, owner_role,
      position_x, position_y, context_refs, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

    const insertMany = this.db.transaction(() => {
      for (const data of nodesData) {
        const id = generateId('node')
        created.push({ ...data, id, createdAt: now, updatedAt: now })
        insertStmt.run(
          id, data.type, data.status, data.title,
          data.description ?? null,
          data.acceptanceCriteria ? JSON.stringify(data.acceptanceCriteria) : null,
          data.graphId, data.graphType, data.parentId ?? null,
          data.rules ? JSON.stringify(data.rules) : null,
          data.metadata ? JSON.stringify(data.metadata) : null,
          data.ownerRole ?? null,
          data.position.x, data.position.y,
          data.contextRefs ? JSON.stringify(data.contextRefs) : null,
          now, now,
        )
      }
    })

    insertMany()
    return created
  }

  update(id: string, data: Partial<GraphNode>): GraphNode {
    const now = new Date().toISOString()
    const updates: string[] = []
    const args: (string | number | null)[] = []

    if (data.type !== undefined) { updates.push('type = ?'); args.push(data.type) }
    if (data.status !== undefined) { updates.push('status = ?'); args.push(data.status) }
    if (data.title !== undefined) { updates.push('title = ?'); args.push(data.title) }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description) }
    if (data.acceptanceCriteria !== undefined) { updates.push('acceptance_criteria = ?'); args.push(JSON.stringify(data.acceptanceCriteria)) }
    if (data.parentId !== undefined) { updates.push('parent_id = ?'); args.push(data.parentId) }
    if (data.rules !== undefined) { updates.push('rules = ?'); args.push(JSON.stringify(data.rules)) }
    if (data.metadata !== undefined) { updates.push('metadata = ?'); args.push(JSON.stringify(data.metadata)) }
    if (data.contextRefs !== undefined) { updates.push('context_refs = ?'); args.push(JSON.stringify(data.contextRefs)) }
    if (data.ownerRole !== undefined) { updates.push('owner_role = ?'); args.push(data.ownerRole) }
    if (data.position !== undefined) { updates.push('position_x = ?, position_y = ?'); args.push(data.position.x, data.position.y) }

    updates.push('updated_at = ?')
    args.push(now)
    args.push(id)

    this.db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`).run(...args)

    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) {
      throw new DatabaseError(`Node not found: ${id}`, ErrorCode.DB_QUERY_FAILED)
    }
    return this.rowToNode(row)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id)
  }

  getStatus(id: string): string | null {
    const row = this.db.prepare('SELECT status FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return assertNodeStatus(row.status as string)
  }

  findById(id: string): GraphNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this.rowToNode(row)
  }

  updateParentId(nodeId: string, parentId: string | null): void {
    this.db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(parentId, nodeId)
  }

  batchUpdatePositions(updates: Array<{ id: string; x: number; y: number }>): void {
    if (updates.length === 0) return
    const now = new Date().toISOString()
    const stmt = this.db.prepare('UPDATE nodes SET position_x = ?, position_y = ?, updated_at = ? WHERE id = ?')
    this.db.transaction(() => {
      for (const { id, x, y } of updates) {
        stmt.run(x, y, now, id)
      }
    })()
  }
}
```

- [ ] **Step 2: Rewrite edge-repository.ts**

Same pattern: `Client` → `BetterSqlite3.Database`, remove async/await, `.execute()` → `.prepare().run/get/all()`:

```typescript
import type BetterSqlite3 from 'better-sqlite3'
import type { GraphEdge } from '@shared/types'
import { assertEdgeType } from '@shared/type-guards'
import { DatabaseError, ErrorCode } from '../errors'
import { generateId } from '../shared/env'
import { createLogger } from '../shared/logger'

const logger = createLogger('EdgeRepo')

function parseEdgeRow(row: Record<string, unknown>): GraphEdge {
  let content: GraphEdge['content']
  if (row.content) {
    try {
      content = JSON.parse(row.content as string)
    } catch {
      logger.warn('Failed to parse edge content:', row.content)
      content = undefined
    }
  }
  return {
    id: row.id as string,
    source: row.source as string,
    target: row.target as string,
    label: row.label as string | undefined,
    graphId: row.graph_id as string,
    edgeType: row.edge_type ? assertEdgeType(row.edge_type as string) : undefined,
    description: row.description as string | undefined,
    dataFlow: row.data_flow as string | undefined,
    strength: typeof row.strength === 'number' ? row.strength : undefined,
    content,
  }
}

export class EdgeRepository {
  constructor(private db: BetterSqlite3.Database) {}

  create(data: Omit<GraphEdge, 'id'>): GraphEdge {
    const id = generateId('edge')
    this.db.prepare(`INSERT INTO edges (id, source, target, label, edge_type, content, graph_id, description, data_flow, strength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, data.source, data.target,
      data.label ?? null, data.edgeType ?? null,
      data.content ? JSON.stringify(data.content) : null,
      data.graphId, data.description ?? null,
      data.dataFlow ?? null, data.strength ?? null,
    )
    return { ...data, id }
  }

  update(id: string, data: Partial<GraphEdge>): GraphEdge {
    const updates: string[] = []
    const args: (string | number | null)[] = []

    if (data.label !== undefined) { updates.push('label = ?'); args.push(data.label) }
    if (data.edgeType !== undefined) { updates.push('edge_type = ?'); args.push(data.edgeType) }
    if (data.content !== undefined) { updates.push('content = ?'); args.push(data.content ? JSON.stringify(data.content) : null) }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description ?? null) }
    if (data.dataFlow !== undefined) { updates.push('data_flow = ?'); args.push(data.dataFlow ?? null) }
    if (data.strength !== undefined) { updates.push('strength = ?'); args.push(data.strength ?? null) }

    if (updates.length > 0) {
      updates.push('updated_at = ?')
      args.push(new Date().toISOString())
      args.push(id)
      this.db.prepare(`UPDATE edges SET ${updates.join(', ')} WHERE id = ?`).run(...args)
    }

    const row = this.db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) {
      throw new DatabaseError(`Edge not found: ${id}`, ErrorCode.DB_QUERY_FAILED)
    }
    return parseEdgeRow(row)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM edges WHERE id = ?').run(id)
  }

  listByGraph(graphId: string): GraphEdge[] {
    return (this.db.prepare('SELECT * FROM edges WHERE graph_id = ?').all(graphId) as Record<string, unknown>[]).map(parseEdgeRow)
  }
}
```

- [ ] **Step 3: Rewrite graph-repository.ts**

Key differences: `Promise.all` for parallel SELECT becomes sequential (better-sqlite3 is sync, no benefit to parallelism). `batch()` → `db.transaction()`. `Row` type removed.

Full rewrite following the same pattern — `Client` → `BetterSqlite3.Database`, remove async/await, convert all API calls. The `get()` method changes from `Promise.all([4 queries])` to 4 sequential `.prepare().all()` calls (sync, no parallelism benefit). The `delete()` and `cloneGraphNodes()` methods convert `db.batch()` to `db.transaction()`.

- [ ] **Step 4: Rewrite chat-repository.ts**

Key differences: Replace `type Row` from libsql with direct `Record<string, unknown>` property access. Replace `result.rowsAffected` → `info.changes`. Replace `db.batch()` → `db.transaction()`. The `toChatThreadRow(row: Row)` and `toChatMessageRow(row: Row)` functions change their parameter type to `Record<string, unknown>`.

- [ ] **Step 5: Rewrite bug-repository.ts, snapshot-repository.ts, agent-log-repository.ts**

Same pattern as edge-repository — straightforward sync conversion.

- [ ] **Step 6: Rewrite compact-history-repository.ts, subagent-invocation-repository.ts**

Same pattern as chat-repository — convert `Row` type usage to `Record<string, unknown>`.

- [ ] **Step 7: Verify type-check passes for repository layer**

```bash
npx tsc --noEmit 2>&1 | grep "repositories" | head -20
```

Expected: No errors from repository files (services/errors expected, fixed next).

- [ ] **Step 8: Commit**

```bash
git add src/main/repositories/
git commit -m "refactor(repos): migrate all repositories from libsql async to better-sqlite3 sync"
```

---

## Task 4: Rewrite Service + Memory + IPC + Agent + SymbolIndex Layer — 8 Files

**Files:**
- Modify: `src/main/services/graph-service.ts`
- Modify: `src/main/services/chat-service.ts`
- Modify: `src/main/memory/memory-store.ts`
- Modify: `src/main/memory/hybrid-search.ts`
- Modify: `src/main/memory/waterline-sync.ts`
- Modify: `src/main/memory/pipeline.ts`
- Modify: `src/main/ipc/graph.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/agent/agent-manager.ts`
- Modify: `src/main/code-intelligence/symbol-index.ts`

The most complex change is in `graph-service.ts`: the `transaction('write')` pattern with manual `commit()/rollback()` must become `db.transaction(() => { ... })` where the function body is the same logic but throws on error (auto-rollback) and returns on success (auto-commit).

- [ ] **Step 1: Rewrite graph-service.ts**

Replace `Client` → `BetterSqlite3.Database`. Rewrite `initFromProject()`:
```typescript
// Before:
const tx = await this.db.transaction('write')
try {
  await tx.execute(...)
  await this.createNodes(..., tx)
  await tx.commit()
} catch { await tx.rollback() }

// After:
this.db.transaction(() => {
  this.db.prepare(...).run(...)
  this.createNodes(...)
})()
```

Change `createNodes()` executor signature from `Pick<Client, 'execute'>` to accepting `BetterSqlite3.Database` directly. All internal execute calls become `.prepare().run()`.

- [ ] **Step 2: Rewrite chat-service.ts**

Replace `Client` type with `BetterSqlite3.Database`. No direct DB calls — delegates to ChatRepository.

- [ ] **Step 3: Rewrite memory-store.ts**

Replace `Client` → `BetterSqlite3.Database`. Convert `batch()` calls to `db.transaction()`. Convert `result.lastInsertRowid` → `info.lastInsertRowid`. Convert `result.rowsAffected` → `info.changes`. FTS5 creation stays the same (db.exec for CREATE VIRTUAL TABLE, db.prepare for triggers).

- [ ] **Step 4: Rewrite hybrid-search.ts, waterline-sync.ts, pipeline.ts**

Replace all `await db.execute()` → `db.prepare().run/get/all()`. Replace `await db.batch()` → `db.transaction()`. Remove dynamic `import('../database')` — call `getClient()` directly since it's sync now.

- [ ] **Step 5: Rewrite ipc/graph.ts and ipc-handlers.ts**

Replace `Client` type references with `BetterSqlite3.Database`. In `ipc-handlers.ts`, `const db = getClient()` remains but now returns `BetterSqlite3.Database`.

- [ ] **Step 6: Rewrite agent-manager.ts**

Replace `import type { ResultSet } from '@libsql/client'` — the 3 direct `db.execute()` calls become `db.prepare().run/get/all()`. Replace `(result as ResultSet).rowsAffected` → `info.changes` from `.run()`.

- [ ] **Step 7: Rewrite symbol-index.ts**

Replace `Client` → `BetterSqlite3.Database`. Convert `execute()` calls. SAVEPOINT blocks stay but use sync API.

- [ ] **Step 8: Update src/main/index.ts**

Change `await initDatabase()` → `initDatabase()` and `await closeDatabase()` → `closeDatabase()` (both are now sync).

- [ ] **Step 9: Verify type-check passes**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: Only test file type errors remaining (fixed in Task 6).

- [ ] **Step 10: Commit**

```bash
git add src/main/services/ src/main/memory/ src/main/ipc/ src/main/agent/ src/main/code-intelligence/ src/main/index.ts
git commit -m "refactor: migrate services, memory, IPC, agent, symbol-index to better-sqlite3 sync"
```

---

## Task 5: Build Config — Extend Targets for All 6 Architectures + MSIX

**Files:**
- Modify: `package.json` (build section)

- [ ] **Step 1: Update Windows build targets**

In `package.json` build section, replace the `win` target:

```json
"win": {
  "target": [
    { "target": "nsis", "arch": ["x64", "arm64"] },
    { "target": "msix", "arch": ["x64", "arm64"] }
  ]
},
"msix": {
  "identityName": "com.bizgraph.app",
  "publisher": "CN=BizGraph",
  "publisherDisplayName": "BizGraph",
  "languages": ["zh-CN", "en-US"],
  "store": false
}
```

- [ ] **Step 2: Update Linux build targets**

Replace the `linux` target:

```json
"linux": {
  "target": [
    { "target": "AppImage", "arch": ["x64", "arm64"] }
  ],
  "category": "Development"
}
```

- [ ] **Step 3: Add build scripts**

Add to `package.json` scripts:

```json
"build:win:msix": "electron-builder --win msix",
"build:all": "electron-builder --mac --win --linux"
```

- [ ] **Step 4: Verify build config is valid**

```bash
npx electron-builder --config --win --dry-run 2>&1 | head -20
```

Expected: No errors, prints configuration.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat(build): add arm64 targets for all platforms + MSIX format"
```

---

## Task 6: Rewrite All Test Files — 8 Files

**Files:**
- Modify: `src/main/__tests__/database-migration.test.ts`
- Modify: `src/main/__tests__/chat-repository.test.ts`
- Modify: `src/main/__tests__/bug-repository.test.ts`
- Modify: `src/main/__tests__/edge-repository.test.ts`
- Modify: `src/main/__tests__/compact-history-repository.test.ts`
- Modify: `src/main/__tests__/subagent-invocation-repository.test.ts`
- Modify: `src/main/memory/__tests__/memory-store.test.ts`
- Modify: `src/main/code-intelligence/__tests__/symbol-index.test.ts`

- [ ] **Step 1: Rewrite database-migration.test.ts**

Replace `import { createClient, type Client } from '@libsql/client'` with `import BetterSqlite3 from 'better-sqlite3'`. Replace `createClient({ url: 'file:...' })` → `new BetterSqlite3(path)`. Replace all `await client.execute()` → `db.prepare().get/all/run()`. Remove async/await. Replace `client.close()` → `db.close()`.

- [ ] **Step 2: Rewrite the 5 mock-based repository tests**

For each test file, replace the libsql mock:
```typescript
// Before:
import type { Client, Row, ResultSet } from '@libsql/client'
function createMockDb(): Client {
  return { execute: vi.fn().mockResolvedValue(mockRows), batch: vi.fn(), close: vi.fn() } as unknown as Client
}

// After:
import type BetterSqlite3 from 'better-sqlite3'
function createMockDb(): BetterSqlite3.Database {
  return {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn((fn) => () => fn()),
    exec: vi.fn(),
    pragma: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as BetterSqlite3.Database
}
```

Update each test case to remove `async/await` and match the new sync method signatures.

- [ ] **Step 3: Rewrite memory-store.test.ts**

Replace `createClient({ url: ':memory:' })` → `new BetterSqlite3(':memory:')`. Remove async/await. Replace `.execute()` calls with `.prepare().run/get/all()`.

- [ ] **Step 4: Rewrite symbol-index.test.ts**

Same pattern as memory-store.test.ts.

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/__tests__/ src/main/memory/__tests__/ src/main/code-intelligence/__tests__/
git commit -m "test: migrate all tests from libsql to better-sqlite3 sync API"
```

---

## Task 7: CI Matrix — 6-Node Build + 3-Node E2E

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Rewrite CI build matrix**

Replace the existing `strategy.matrix` in the build job with:

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint
      - run: npx tsc --noEmit

  build:
    needs: lint
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14
            arch: arm64
          - os: macos-13
            arch: x64
          - os: windows-latest
            arch: x64
          - os: windows-11-arm
            arch: arm64
          - os: ubuntu-latest
            arch: x64
          - os: ubuntu-24.04-arm
            arch: arm64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: BizGraph-${{ matrix.os }}-${{ matrix.arch }}
          path: release/**/*

  e2e:
    needs: lint
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-13]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium
      - name: Run E2E tests (Linux)
        if: runner.os == 'Linux'
        run: npx xvfb-run npm run test:e2e
      - name: Run E2E tests (macOS/Windows)
        if: runner.os != 'Linux'
        run: npm run test:e2e
```

- [ ] **Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
```

Expected: No output (valid YAML).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: expand matrix to 6-node build + 3-node E2E for full arch coverage"
```

---

## Task 8: Platform Abstraction Layer — Batch 1 (Path Operations)

**Files:**
- Create: `src/main/platform/platform-provider.ts`
- Create: `src/main/platform/darwin-provider.ts`
- Create: `src/main/platform/win32-provider.ts`
- Create: `src/main/platform/linux-provider.ts`
- Create: `src/main/platform/index.ts`
- Create: `src/main/__tests__/platform-provider.test.ts`
- Modify: `src/main/ipc/utils.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/ipc/fs.ts`
- Modify: `src/main/ipc/git.ts`
- Modify: `src/main/scope-guard.ts`

- [ ] **Step 1: Write the failing test for PlatformProvider**

Create `src/main/__tests__/platform-provider.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import type { PlatformProvider } from '../platform/platform-provider'
import { getPlatformProvider, setPlatformProviderForTest } from '../platform/platform-provider'

// Mock implementations
function createMockProvider(overrides: Partial<PlatformProvider> = {}): PlatformProvider {
  return {
    platform: 'win32',
    arch: 'x64',
    isMac: false,
    isWindows: true,
    isLinux: false,
    isArm64: false,
    isWsl: false,
    normalizePath: (p: string) => p.replace(/\//g, '\\'),
    pathsEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
    isSystemPath: (p: string) => p.toLowerCase().startsWith('c:\\windows'),
    isWithinParent: (_child: string, _parent: string) => false,
    killProcess: vi.fn(),
    getShellConfig: vi.fn().mockReturnValue({ shell: true }),
    whichCommand: vi.fn().mockReturnValue(null),
    getWatcherOptions: vi.fn().mockReturnValue({}),
    ...overrides,
  } as PlatformProvider
}

describe('PlatformProvider', () => {
  afterEach(() => {
    setPlatformProviderForTest(null)
  })

  it('win32 provider: pathsEqual is case-insensitive', () => {
    setPlatformProviderForTest(createMockProvider({ platform: 'win32', isWindows: true, pathsEqual: (a, b) => a.toLowerCase() === b.toLowerCase() }))
    const provider = getPlatformProvider()
    expect(provider.pathsEqual('C:\\Users', 'c:\\users')).toBe(true)
  })

  it('darwin provider: pathsEqual is case-sensitive', () => {
    setPlatformProviderForTest(createMockProvider({ platform: 'darwin', isMac: true, pathsEqual: (a, b) => a === b }))
    const provider = getPlatformProvider()
    expect(provider.pathsEqual('/Users/Test', '/Users/test')).toBe(false)
  })

  it('win32: isSystemPath blocks Windows system directories', () => {
    setPlatformProviderForTest(createMockProvider({ isSystemPath: (p) => /^c:\\windows/i.test(p) || /^c:\\program files/i.test(p) }))
    const provider = getPlatformProvider()
    expect(provider.isSystemPath('C:\\Windows\\System32')).toBe(true)
    expect(provider.isSystemPath('C:\\Users\\dev')).toBe(false)
  })

  it('linux: isSystemPath blocks Unix system directories', () => {
    setPlatformProviderForTest(createMockProvider({ platform: 'linux', isLinux: true, isSystemPath: (p) => /^(\/etc|\/usr|\/bin|\/sbin|\/boot|\/lib)/.test(p) }))
    const provider = getPlatformProvider()
    expect(provider.isSystemPath('/etc/passwd')).toBe(true)
    expect(provider.isSystemPath('/home/user/project')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/main/__tests__/platform-provider.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement PlatformProvider interface + factory**

Create `src/main/platform/platform-provider.ts`:

```typescript
import { type ChildProcess } from 'node:child_process'
import path from 'node:path'

export interface PlatformProvider {
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly arch: 'x64' | 'arm64'
  readonly isMac: boolean
  readonly isWindows: boolean
  readonly isLinux: boolean
  readonly isArm64: boolean
  readonly isWsl: boolean

  normalizePath(p: string): string
  pathsEqual(a: string, b: string): boolean
  isSystemPath(p: string): boolean
  isWithinParent(child: string, parent: string): boolean

  killProcess(proc: ChildProcess): void
  getShellConfig(): Partial<import('node:child_process').SpawnOptions>

  whichCommand(cmd: string): string | null

  getWatcherOptions(): Record<string, unknown>
}

let instance: PlatformProvider | null = null
let testInstance: PlatformProvider | null = null

export function setPlatformProviderForTest(provider: PlatformProvider | null): void {
  testInstance = provider
}

export function getPlatformProvider(): PlatformProvider {
  if (testInstance) return testInstance
  if (instance) return instance
  const platform = process.platform as 'darwin' | 'win32' | 'linux'
  const arch = process.arch as 'x64' | 'arm64'
  const isWsl = platform === 'linux' && !!process.env.WSL_DISTRO_NAME

  switch (platform) {
    case 'darwin':
      instance = new DarwinProvider(arch)
      break
    case 'win32':
      instance = new Win32Provider(arch)
      break
    case 'linux':
      instance = new LinuxProvider(arch, isWsl)
      break
    default:
      throw new Error(`Unsupported platform: ${platform}`)
  }
  return instance
}

// --- Darwin ---

class DarwinProvider implements PlatformProvider {
  readonly platform = 'darwin' as const
  readonly isMac = true
  readonly isWindows = false
  readonly isLinux = false
  readonly isWsl = false

  constructor(public readonly arch: 'x64' | 'arm64') {}
  get isArm64() { return this.arch === 'arm64' }

  normalizePath(p: string) { return p }
  pathsEqual(a: string, b: string) { return a === b }

  isSystemPath(p: string): boolean {
    const resolved = path.resolve(p)
    return /^(\/etc|\/usr|\/bin|\/sbin|\/boot|\/lib|\/var)/.test(resolved) || resolved === '/'
  }

  isWithinParent(child: string, parent: string): boolean {
    const rel = path.relative(parent, child)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  killProcess(proc: ChildProcess): void { proc.kill('SIGTERM') }
  getShellConfig(): Partial<import('node:child_process').SpawnOptions> { return {} }
  whichCommand(cmd: string): string | null {
    try { return require('child_process').execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> { return {} }
}

// --- Win32 ---

class Win32Provider implements PlatformProvider {
  readonly platform = 'win32' as const
  readonly isMac = false
  readonly isWindows = true
  readonly isLinux = false
  readonly isWsl = false

  constructor(public readonly arch: 'x64' | 'arm64') {}
  get isArm64() { return this.arch === 'arm64' }

  normalizePath(p: string) { return p.replace(/\//g, '\\') }
  pathsEqual(a: string, b: string) { return a.toLowerCase() === b.toLowerCase() }

  isSystemPath(p: string): boolean {
    const lower = p.toLowerCase()
    return lower.startsWith('c:\\windows') ||
      lower.startsWith('c:\\program files') ||
      lower.startsWith('c:\\program files (x86)') ||
      lower.startsWith('c:\\programdata')
  }

  isWithinParent(child: string, parent: string): boolean {
    const rel = path.relative(parent, child)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  killProcess(proc: ChildProcess): void { proc.kill() }
  getShellConfig(): Partial<import('node:child_process').SpawnOptions> { return { shell: true } }
  whichCommand(cmd: string): string | null {
    try { return require('child_process').execSync(`where ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> { return {} }
}

// --- Linux (incl. WSL) ---

class LinuxProvider implements PlatformProvider {
  readonly platform = 'linux' as const
  readonly isMac = false
  readonly isWindows = false
  readonly isLinux = true

  constructor(public readonly arch: 'x64' | 'arm64', public readonly isWsl: boolean) {}
  get isArm64() { return this.arch === 'arm64' }

  normalizePath(p: string) { return p }
  pathsEqual(a: string, b: string) { return a === b }

  isSystemPath(p: string): boolean {
    const resolved = path.resolve(p)
    return /^(\/etc|\/usr|\/bin|\/sbin|\/boot|\/lib|\/var)/.test(resolved) || resolved === '/'
  }

  isWithinParent(child: string, parent: string): boolean {
    const rel = path.relative(parent, child)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  killProcess(proc: ChildProcess): void { proc.kill('SIGTERM') }
  getShellConfig(): Partial<import('node:child_process').SpawnOptions> { return {} }
  whichCommand(cmd: string): string | null {
    try { return require('child_process').execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> {
    return this.isWsl ? { usePolling: true } : {}
  }
}
```

- [ ] **Step 4: Create barrel export**

Create `src/main/platform/index.ts`:
```typescript
export { type PlatformProvider, getPlatformProvider, setPlatformProviderForTest } from './platform-provider'
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/main/__tests__/platform-provider.test.ts
```

Expected: PASS

- [ ] **Step 6: Delegate path operations in ipc/utils.ts**

In `src/main/ipc/utils.ts`, replace the inline `process.platform === 'win32'` check in `isBlockedSystemPath()` with a call to `provider.isSystemPath()` and `provider.pathsEqual()`. Import `getPlatformProvider` from `../platform`.

- [ ] **Step 7: Delegate path operations in remaining Batch 1 files**

Apply the same delegation in `ipc-handlers.ts`, `ipc/fs.ts`, `ipc/git.ts`, and `scope-guard.ts`. Each file imports `getPlatformProvider` and calls `provider.pathsEqual()` or `provider.isSystemPath()` or `provider.isWithinParent()` instead of inline platform checks.

- [ ] **Step 8: Run full test suite**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/platform/ src/main/__tests__/platform-provider.test.ts src/main/ipc/ src/main/ipc-handlers.ts src/main/scope-guard.ts
git commit -m "refactor(platform): add PlatformProvider abstraction (Batch 1: path operations)"
```

---

## Task 9: Platform Abstraction Layer — Batch 2 (Process Management)

**Files:**
- Modify: `src/main/adapters/base.ts`
- Modify: `src/main/adapters/mindmap-adapter.ts`
- Modify: `src/main/settings.ts`

- [ ] **Step 1: Delegate killProcess in base.ts**

Replace `process.platform === 'win32'` checks in `forceKillProcess()` and `doTerminate()` with `provider.killProcess(proc)`.

- [ ] **Step 2: Delegate shell config in mindmap-adapter.ts**

Replace `shell: true` Windows conditional with `provider.getShellConfig()`.

- [ ] **Step 3: Delegate whichCommand in settings.ts**

Replace `process.platform === 'win32' ? 'where' : 'which'` with `provider.whichCommand(cmd)`.

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/ src/main/settings.ts
git commit -m "refactor(platform): delegate process management to PlatformProvider (Batch 2)"
```

---

## Task 10: Platform Abstraction Layer — Batch 3 (Remaining)

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/scope-guard.ts`
- Modify: `src/main/project-scanner/dir-scanner.ts`

- [ ] **Step 1: Delegate isMac in index.ts**

Replace `process.platform === 'darwin'` with `provider.isMac` in `buildMenu()` and window-all-closed handler.

- [ ] **Step 2: Delegate WSL + watcher config in scope-guard.ts**

Replace `process.platform === 'linux' && process.env.WSL_DISTRO_NAME` with `provider.isWsl`, and move `usePolling` logic to `provider.getWatcherOptions()`.

- [ ] **Step 3: Delegate isSystemPath in dir-scanner.ts**

Replace duplicated system path logic with `provider.isSystemPath()`.

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/main/scope-guard.ts src/main/project-scanner/
git commit -m "refactor(platform): delegate remaining platform checks to PlatformProvider (Batch 3)"
```

---

## Task 11: Final Integration Verification

- [ ] **Step 1: Full type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 2: Full lint**

```bash
npm run lint
```

Expected: 0 warnings, 0 errors.

- [ ] **Step 3: Full unit test suite**

```bash
npm run test
```

Expected: All tests PASS.

- [ ] **Step 4: Dev mode smoke test**

```bash
npm run dev
```

Verify: App starts, mind map canvas loads, no libsql-related errors in console.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: cross-platform full architecture support complete"
```
