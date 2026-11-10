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
import { MapMigrationStore, preflightStartup, pruneMapMigrationReports } from './map-migration/migration-state'
import { runEntityKeyBackfill } from './map-migration/entity-key-backfill'
import { ImportDedupService } from './map-migration/import-dedup'
import { scanStaleE3All, scanExpiredE4All, scanCoverageChangedE4All } from './map/evidence-service'
import { ProposalService } from './map/proposal-service'
import { pruneMemoryHits } from './map/memory-hit-service'
import { runLinkBackfill, runLinkIntegrityCheck } from './map-migration/link-backfill'
import { captureS4Baseline, verifyS4PostRebuild } from './map-migration/s4-verify'
import {
  MAP_S5A_TABLE_SCHEMAS, MAP_S5A_INDEX_SQLS, MAP_S6A_TABLE_SCHEMAS, MAP_S6A_INDEX_SQLS,
  MAP_S7_TABLE_SCHEMAS, MAP_S7_INDEX_SQLS,
  MAP_S8_TABLE_SCHEMAS, MAP_S8_INDEX_SQLS,
  LEGACY_ACCEPTANCE_APPROVAL_TOOL, MAP_ACCEPTANCE_TABLE_SCHEMAS, MAP_ACCEPTANCE_INDEX_SQLS,
  MAP_ACCEPTANCE_MIGRATION_ARCHIVE_SCHEMAS,
  MAP_MEMORY_TABLE_SCHEMAS, MAP_MEMORY_INDEX_SQLS,
  MAP_VIEW_SCHEMAS, applyMapViews,
} from './map/schema'
import { migrateLegacyAcceptance } from './map-migration/legacy-acceptance'
import { AGENT_INDEX_SQLS, AGENT_TABLE_SCHEMAS, type AgentTableSchema } from './agent/runtime/db/schema'

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

  try {
    migrate()
  } catch (err) {
    // 拒绝打开（含版本高于当前代码上限的 fail-closed）时关闭连接并清空模块状态，
    // 避免半开连接/后台定时器残留。
    try {
      db.close()
    } catch {
      /* 已关闭则忽略 */
    }
    db = null
    throw err
  }

  // S1 迁移状态机启动预检（§8.14.1，fail-closed）：integrity/FK/半迁移/孤儿备份
  // 任一失败都拒绝启动——不得带着半迁移库继续读写，也不降级只读。
  // map_migration_reports 尚不存在（极老库首次升上来）时预检自动跳过阶段类检查。
  try {
    preflightStartup(db, new MapMigrationStore(db))
  } catch (err) {
    try {
      db.close()
    } catch {
      /* 已关闭则忽略 */
    }
    throw err
  }

  // map_migration_reports 治理：启动和每日任务都追加报告行，按 (kind,stage) 保留最近 N 行。
  // 必须在预检之后执行——预检读的是各组最新一行，裁剪不改变结论；running 行永不被裁。
  try {
    pruneMapMigrationReports(db)
  } catch (err) {
    logger.warn('map_migration_reports prune failed:', err)
  }

  // S1.3（§2.2.2 S1-c）：entity_key 回填。幂等（只写 NULL 行）；单项目失败已在
  // 阶段内降级为 partial 并写入报告表，这里只兜住结构性异常——回填失败只影响
  // 实体身份（节点保持 entity_key NULL、可查询、下次启动重试），不该让应用打不开。
  try {
    runEntityKeyBackfill(db, CURRENT_SCHEMA_VERSION)
  } catch (err) {
    logger.warn('entity_key backfill failed; startup continues with unresolved identities (retry next launch):', err)
  }

  // S1.5 尾项 + S1.6（§8.3 第 6/7 步）：导入决策 90 天保留（启动期一次;每日调度
  // 随 L1 交付）+ 历史 lineage 报告（只报告不删不并）。卫生任务失败只告警,
  // 不阻断启动（与结构迁移的 fail-closed 不同层）。
  try {
    const dedup = new ImportDedupService(db)
    dedup.runRetention()
    dedup.reportHistoricalDuplicateLineages()
  } catch (err) {
    logger.warn('import dedup post-migration tasks failed:', err)
  }

  // S2 回填（§2.3.1）：dev→online 按 entity_key 建 derives_from。链接是派生数据，
  // 失败时保留阶段诊断并在下次启动重试（幂等），不阻断应用启动。
  try {
    runLinkBackfill(db, CURRENT_SCHEMA_VERSION)
  } catch (err) {
    logger.warn('link backfill failed; startup continues (retry next launch):', err)
  }

  // S2 巡检（§2.3.1）：启动后一次 + 每日一次（unref 不阻止退出）；手动触发随
  // admin IPC 交付。巡检只报告不删除,失败不阻断启动。
  try {
    runLinkIntegrityCheck(db)
  } catch (err) {
    logger.warn('link integrity check failed:', err)
  }

  // S6a E3 stale 扫描（§3.7.5:启动后 + 每小时）。L1 无 E3 行 → 早退休眠。
  try {
    scanStaleE3All(db)
  } catch (err) {
    logger.warn('E3 stale scan failed:', err)
  }
  // E4 到期扫描（§3.7.5:启动后 + 每日一次）。E4 是人工签收（code_version NULL），
  // 到期后置 stale,避免节点长期挂着 signed_off。
  try {
    scanExpiredE4All(db)
  } catch (err) {
    logger.warn('E4 expiry scan failed:', err)
  }
  // G1-9：E4 覆盖变化扫描（启动后 + 每日一次）。与到期扫描是两条独立判据：
  // 这里比对签收基线（逐文件 sha256 + 范围快照），变化置 stale 并区分 stale_reason。
  try {
    scanCoverageChangedE4All(db)
  } catch (err) {
    logger.warn('E4 coverage scan failed:', err)
  }
  // G1-14：阻塞提案等待超 24h 自动取消（启动后一次 + 每日随巡检执行）。
  // 只改 work_items 里的提案状态，不触碰 online 图。
  try {
    new ProposalService(db).expireStale()
  } catch (err) {
    logger.warn('proposal expiry sweep failed:', err)
  }
  // G2-3：memory_hits 保留治理（180 天 / 单项目 20 万），启动后一次 + 每日。
  try {
    pruneMemoryHits(db)
  } catch (err) {
    logger.warn('memory_hits prune failed:', err)
  }
  const e3ScanTimer = setInterval(() => {
    if (!db) return
    try {
      scanStaleE3All(db)
    } catch (err) {
      logger.warn('hourly E3 stale scan failed:', err)
    }
  }, 60 * 60 * 1000)
  if (e3ScanTimer.unref) e3ScanTimer.unref()

  const linkCheckTimer = setInterval(() => {
    if (!db) return
    try {
      runLinkIntegrityCheck(db)
      new ImportDedupService(db).runRetention()
      // §3.7.5：E4 到期每日扫描一次（到期置 stale 并派生 stale）
      scanExpiredE4All(db)
      // G1-9：E4 覆盖变化每日扫描（独立判据，失败不影响到期扫描）
      scanCoverageChangedE4All(db)
      // G1-14：阻塞提案 24h 超时取消（与 E4 到期同频）。
      new ProposalService(db).expireStale()
      // G2-3：memory_hits 保留治理（180 天 / 单项目 20 万）。
      pruneMemoryHits(db)
    } catch (err) {
      logger.warn('daily map integrity/retention task failed:', err)
    }
    try {
      pruneMapMigrationReports(db)
    } catch (err) {
      logger.warn('daily map_migration_reports prune failed:', err)
    }
  }, 24 * 60 * 60 * 1000)
  if (linkCheckTimer.unref) linkCheckTimer.unref()

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

/** 关闭期兜底：DB 已 close 后,定时任务不得再触达连接。 */
export function isDatabaseOpen(): boolean {
  return db?.open === true
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
        if (tableName === 'agent_usage' && col === 'source') {
          // v21：source 语义重定义 'executor' → 'provider'（真实用量 vs 估算分列）
          return `CASE ${safeCol} WHEN 'executor' THEN 'provider' ELSE ${safeCol} END AS ${safeCol}`
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

interface UniqueConstraintSpec {
  columns: string[]
  canonical: string
}

/**
 * 从表 DDL 提取内联 UNIQUE 约束（表级 `UNIQUE(...)` 与列级 `col ... UNIQUE`）。
 * 只按列清单做规范化比较：列顺序与大小写影响语义，空白不影响。
 */
function extractInlineUniqueConstraints(createSql: string): UniqueConstraintSpec[] {
  const specs: UniqueConstraintSpec[] = []

  // 表级 UNIQUE(...)（含 `CONSTRAINT x UNIQUE(...)`）
  const re = /\bunique\s*\(/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(createSql))) {
    const open = match.index + match[0].length - 1
    const close = findMatchingParen(createSql, open)
    if (close === -1) break
    const columns = splitTopLevel(createSql.slice(open + 1, close), ',')
      .map((c) => c.trim().replace(/\s+/g, ' ').toLowerCase())
      .filter(Boolean)
    if (columns.length > 0) {
      specs.push({ columns, canonical: `unique(${columns.join(',')})` })
    }
    re.lastIndex = close + 1
  }

  // 列级 UNIQUE（不带括号）
  const bodyOpen = createSql.indexOf('(')
  const bodyClose = bodyOpen === -1 ? -1 : findMatchingParen(createSql, bodyOpen)
  if (bodyOpen !== -1 && bodyClose !== -1) {
    for (const part of splitTopLevel(createSql.slice(bodyOpen + 1, bodyClose), ',')) {
      const def = part.trim()
      if (!def || TABLE_CONSTRAINT_PREFIX.test(def)) continue
      const withoutQuoted = def.replace(/'[^']*'/g, "''")
      if (!/\bunique\b(?!\s*\()/i.test(withoutQuoted)) continue
      const name = /^["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/.exec(def)?.[1]
      if (name) {
        const col = name.toLowerCase()
        specs.push({ columns: [col], canonical: `unique(${col})` })
      }
    }
  }

  return specs
}

function canonicalUniques(specs: UniqueConstraintSpec[]): string {
  return specs.map((s) => s.canonical).sort().join('||')
}

/**
 * 重建/建唯一索引前的只读体检：目标键存在重复即 fail-closed。
 * 返回的重复组数按 SQLite UNIQUE 语义计算（键列含 NULL 的行不参与，允许多个 NULL）。
 */
function assertNoDuplicateUniqueKeys(
  db: BetterSqlite3.Database,
  tableName: string,
  specs: UniqueConstraintSpec[],
  context: string,
  whereSql?: string,
): void {
  for (const spec of specs) {
    const cols = spec.columns
    if (cols.length === 0 || !cols.every(isValidIdentifier)) continue // 表达式键交由 SQLite 报错
    const colList = cols.map(safeIdentifier).join(', ')
    const notNull = cols.map((c) => `${safeIdentifier(c)} IS NOT NULL`).join(' AND ')
    const where = whereSql ? `(${whereSql}) AND ${notNull}` : notNull
    const dup = db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT 1 FROM ${safeIdentifier(tableName)} WHERE ${where}
           GROUP BY ${colList} HAVING COUNT(*) > 1
         )`,
      )
      .get() as { c: number }
    const groups = Number(dup.c)
    if (groups === 0) continue
    const sample = db
      .prepare(
        `SELECT ${colList} FROM ${safeIdentifier(tableName)} WHERE ${where}
         GROUP BY ${colList} HAVING COUNT(*) > 1 ORDER BY 1 LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined
    throw new DatabaseError(
      `${context}中止：表 ${tableName} 的 UNIQUE(${cols.join(', ')}) 存在 ${groups} 组重复键` +
        `（示例 ${sample ? JSON.stringify(sample) : '{}'}）。` +
        `拒绝按新约束重建以避免静默丢行；请先清理重复数据或回退该 schema 变更。`,
      ErrorCode.DB_MIGRATION_FAILED,
    )
  }
}

interface ParsedIndexStatement {
  name: string
  table: string
  columns: string[]
  unique: boolean
  where: string | null
  normalized: string
  sql: string
}

function normalizeIndexSql(sql: string): string {
  return sql
    .replace(/\s+if\s+not\s+exists\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function parseIndexStatement(sql: string): ParsedIndexStatement | null {
  const head = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*(?=\()/i.exec(sql)
  if (!head) return null
  const open = sql.indexOf('(', head.index + head[0].length)
  if (open === -1) return null
  const close = findMatchingParen(sql, open)
  if (close === -1) return null
  const columns = splitTopLevel(sql.slice(open + 1, close), ',')
    .map((c) => c.trim())
    .filter(Boolean)
  const tail = sql.slice(close + 1).trim()
  const where = /^WHERE\s+/i.test(tail) ? tail.replace(/^WHERE\s+/i, '').trim() : null
  return {
    name: head[2],
    table: head[3],
    columns,
    unique: Boolean(head[1]),
    where,
    normalized: normalizeIndexSql(sql),
    sql: sql.trim(),
  }
}

/**
 * 索引对账：独立唯一索引（`CREATE UNIQUE INDEX`）与内联约束一样纳入比较。
 * 定义变化时先 DROP 再按当前定义重建（`IF NOT EXISTS` 不会替换同名旧定义）；
 * 唯一索引重建前同样做重复键体检。checksum 已包含 INDEX_SQLS，任一变化都会走慢路径。
 */
export function reconcileSchemaIndexes(
  db: BetterSqlite3.Database,
  indexSqls: string[] = INDEX_SQLS,
): void {
  for (const sql of indexSqls) {
    const parsed = parseIndexStatement(sql)
    if (!parsed) {
      db.exec(sql)
      continue
    }
    const existing = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
      .get(parsed.name) as { sql: string | null } | undefined
    if (existing && existing.sql && normalizeIndexSql(existing.sql) === parsed.normalized) continue
    if (existing) {
      if (!isValidIdentifier(parsed.name)) {
        throw new DatabaseError(`Invalid index identifier: ${parsed.name}`, ErrorCode.DB_INVALID_IDENTIFIER)
      }
      logger.info(`Index ${parsed.name} definition changed, rebuilding...`)
      db.exec(`DROP INDEX ${safeIdentifier(parsed.name)}`)
    }
    if (parsed.unique && parsed.columns.every(isValidIdentifier)) {
      assertNoDuplicateUniqueKeys(
        db,
        parsed.table,
        [{ columns: parsed.columns, canonical: `unique(${parsed.columns.join(',')})` }],
        `索引 ${parsed.name} 创建`,
        parsed.where ?? undefined,
      )
    }
    db.exec(parsed.sql)
  }
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

    // UNIQUE 也是约束语义的一部分：只在列集合/类型/CHECK 上比较会让"仅改 UNIQUE"
    // 静默失效（IF NOT EXISTS 不换约束，旧表原封不动）。
    const existingUniques = canonicalUniques(extractInlineUniqueConstraints(existingSql))
    const expectedUniques = canonicalUniques(extractInlineUniqueConstraints(createSql))

    if (existingChecks === expectedChecks && existingUniques === expectedUniques && columnTypesMatch(db, tableName, createSql)) {
      const backupCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tempTable)
      if (backupCheck) {
        logger.info(`Found leftover backup ${tempTable}, restoring data...`)
        restoreFromBackup(db, tableName, tempTable)
      }
      return
    }

    logger.info(`Table ${tableName} CHECK/UNIQUE constraints or column types changed, rebuilding...`)
  }

  logger.info(`Table ${tableName} schema outdated, rebuilding...`)

  // 重建前只读体检：新 UNIQUE 键在旧数据上已有重复 → fail-closed，绝不闷头重建丢行。
  const expectedUniqueSpecs = extractInlineUniqueConstraints(createSql).filter((spec) =>
    spec.columns.every((c) => existingCols.has(c)),
  )
  assertNoDuplicateUniqueKeys(db, tableName, expectedUniqueSpecs, `表 ${tableName} 重建`)

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

/**
 * node_execution_state.is_reproducible 的规范值域是 E3=1 / E4=0 / E0–E2=NULL（§3.7.4）。
 * 旧 DDL 为 `NOT NULL DEFAULT 0`，无法写入 NULL，且 rebuildTableIfNeeded 只比较
 * 列集合/类型/CHECK，不会因 NOT NULL 变化触发重建。该表是可整表重建的派生缓存
 * （§7.2），检测到旧约束时直接按当前 createSql 重建；不升 schema 版本、
 * 不触碰任何用户数据，缓存行由 overlay:get 惰性重算。
 */
function rebuildNullableReproducibleCache(db: BetterSqlite3.Database): void {
  const schema = MAP_S6A_TABLE_SCHEMAS.find((s) => s.name === 'node_execution_state')
  if (!schema) return
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='node_execution_state'")
    .get() as { sql: string } | undefined
  if (!row) return
  if (!/is_reproducible\s+INTEGER\s+NOT\s+NULL/i.test(row.sql)) return

  logger.info('node_execution_state.is_reproducible 旧约束为 NOT NULL，重建派生缓存…')
  db.exec('DROP TABLE node_execution_state')
  db.exec(schema.createSql)
  // 缓存行随表清空，下次 node_execution_state 读取时按新值域重算
}

/**
 * 当前 Schema 版本号，每次迁移时递增。
 * v21：agent_usage 成本账本扩展（M1）。
 * v22：agent_events 增加 step_id（按步骤 join 策略/审批事件；历史行留 NULL）。
 * v23：agent_usage 增加 cost_status / tokens_reported（可查的分类字段；
 *      历史行留 NULL，不从 attribution_note 文本反推）。
 * v24：schema 对齐 —— 把 runIncrementalMigrations 补出的列正式写进 createSql，
 *      避免表重建时 restoreFromBackup 只恢复公共列而丢值：
 *      graphs.writeback_disabled、edges.updated_at、
 *      chat_threads.parent_thread_id / context_tokens_used / context_window_max /
 *      last_compacted_at / metadata、chat_messages.token_count。
 *      纯 createSql 变更，不改列类型与 CHECK，不触发重建。
 * v25：F3-A 新增部分索引 idx_agent_turns_deadline（agent_turns.deadline_at
 *      WHERE status='running'，DeadlineReaper 扫描用）。索引变更不改表结构，
 *      不触发重建；bump 版本号防止旧二进制因 checksum 失配误判重建。
 * v26：S1 身份层 —— ①nodes.createSql 增加可空 entity_key（不进 requiredColumns，
 *      I1；columnTypesMatch 只比既有列，不触发重建）；②新建导入查重三表
 *      project_fingerprints / import_rejections / import_allowances + 迁移
 *      状态机表 map_migration_reports；③索引 ux_nodes_graph_entity_key 等 5 条。
 *      回填与导入查重逻辑见 map-migration/ 模块（§8.14.1 / §2.2.2 / §2.6）。
 * v27：S2 新增 node_links（跨图对应，§2.3/§7.2）+ 索引 5 条。不建到 nodes 的
 *      外键（L6）。
 * v28：S5a 新增六表 work_items/work_steps/work_runs/node_session_links/
 *      change_sets/routing_decisions（§7.2 逐字）+ 索引。work_items 13 值与
 *      work_steps 12 值一次建齐（D2,§8.7 不得留 ALTER/重建）。
 * v29：S6a 新增 node_evidence（E3/E4 字段级 CHECK 硬约束）+ node_execution_state
 *      （派生缓存,可整表重建）+ 索引/部分唯一索引（§7.2 逐字）。
 * v30：S3 归档语义 —— graphs/nodes 增加 lifecycle_state（NOT NULL DEFAULT 'active'
 *      + CHECK）。CHECK 变化会触发两表重建（restoreFromBackup 共有列恢复,
 *      旧行安全落默认值,§8.5「重建可安全补默认值」）。
 * v31：S7 新增 boundary_candidates / plan_drafts / plan_deviations（§7.2 逐字）
 *      + 索引（含 ux_plan_drafts_current 部分唯一）。
 * v32：S8 前置 —— test_* 五表（§7.2 逐字）+ agent_approvals subject 扩展
 *      （run_id/turn_id 放宽可空 + subject_type/subject_id,D6 不建 test_approvals;
 *      回填 UPDATE subject_id=turn_id 见 runIncrementalMigrations）。
 * v33：S4 不可逆 —— CHECK 值域扩展（test 图）：graphs.type / nodes.type /
 *      nodes.graph_type / edges.edge_type。三表重建
 *      （graphs→edges→nodes 顺序由 TABLE_SCHEMAS 决定）+ S4 基线/校验
 *      （captureS4Baseline/verifyS4PostRebuild,失败整体回滚启动阻断,§8.6）。
 * v34：失败/跳过归因 —— work_steps 增加 skip_reason / failure_class,
 *      work_items 增加 cancel_reason。**纯加列,不重建表**：三列都写进 createSql
 *      （新库/重建路径）但**不进** requiredColumns（否则旧库缺列会触发重建）;
 *      存量库由 runIncrementalMigrations 走 ALTER TABLE 补列。版本递增同时封住
 *      「旧二进制按同版本 createSql 回退 DDL」：旧二进制读到 v34 会被
 *      DB_SCHEMA_TOO_NEW 拦住，而不是静默重建。
 * v35：manual 验收确认事实独立建表 —— 新建 acceptance_confirmations
 *      （一次确认一行/条目，batch_id 分组，source 标记迁移来源）。`9852b77`
 *      复用 agent_approvals 记录人工验收的做法废止：agent_approvals 只承载
 *      工具调用审批。存量库若有 tool_name='acceptance_manual_confirm' 的行，
 *      由 runIncrementalMigrations 搬入新表（保留 legacy_approval_id 可追溯），
 *      不静默删除。
 * v36：W3 执行守卫 —— ①`work_items.priority` 可空列（不进 requiredColumns，
 *      存量库 ALTER TABLE 补列；候选排序 `priority DESC NULLS LAST, created_at`）；
 *      ②存量自由文本 acceptance（`[{id,text}]`）自动迁移为
 *      `{type:'manual', expected, provenance:'legacy_free_text'}`，迁移前原文
 *      逐行存入 `map_acceptance_migration_archive`，并写一行
 *      `map_migration_reports(kind='derivation', stage='legacy_acceptance')` 审计。
 *      两件事同版本的理由：它们同属 W3「让存量任务可调度」的同一事务边界——
 *      加列与数据迁移在同一次启动迁移里完成，要么都成立、要么整体回滚；
 *      拆成两个版本会让「列已加、数据未迁」的中间态成为可启动状态。
 *      纯加列 + 数据迁移，**不重建表**。
 * v37：W2 G1-10/G5-8 —— 新建 `evidence_suggestions`（session-map 蓝图 §7.2 逐字）。
 *      Agent/系统推断只写建议；接受时在**同一事务**内转写 `node_evidence` 并回填
 *      `status='accepted' / resolved_at / resolved_by`。纯建表 + 建索引，无数据迁移、
 *      不改既有列；旧库启动时由 `rebuildTableIfNeeded` 的「表不存在即建」路径补齐。
 * v38：G2-14 只读视图 `v_plan_deviations_file_domain`（§7.2 明细展开）。
 *      视图不存数据，CREATE/DROP 幂等；纳入 checksum 并在快/慢路径都对账。
 *      回滚：`DROP VIEW IF EXISTS v_plan_deviations_file_domain`，无表/数据变更。
 * v39：G2-13 published 软阻断 —— `nodes.published_waiver_json`（可空 TEXT）。
 *      仅 ALTER 补列，不重建表；回滚：`ALTER TABLE nodes DROP COLUMN`（SQLite ≥3.35），
 *      或保留空列不读（历史节点该列为 NULL）。
 * v40：G1-14 提案机制 —— ①`work_items.metadata`（可空 TEXT，仅 ALTER 补列，
 *      不进 requiredColumns）；②部分唯一索引 `ux_work_items_open_proposal`
 *      （只约束带 proposal 载荷的行，同实体仅一个 open）；③只读视图
 *      `v_online_proposals`（含 stale 判定）。不新增表、不改既有列语义。
 *      回滚：`DROP VIEW IF EXISTS v_online_proposals` + `DROP INDEX IF EXISTS
 *      ux_work_items_open_proposal`；`metadata` 列可保留不读（历史行全 NULL）。
 * v41：G2-1 五通道/模式库 —— `routing_decisions.mode_id`（可空 TEXT，仅 ALTER 补列，
 *      不进 requiredColumns；NULL = 历史决策）。模式定义在代码常量
 *      `src/main/map/mode-registry.ts`，**不建表**。回滚：列可保留不读。
 * v42：G11-10 tree-hash 等级 —— `node_evidence.tree_hash`（可空 TEXT，仅 ALTER 补列，
 *      不进 requiredColumns）。只记录 E3 执行树，**不改 E3/E4 的 CHECK 语义与
 *      gate 判定**；回滚：列可保留不读（历史行全 NULL）。
 * v43：G1-9 E4 覆盖变化扫描 —— `node_evidence.coverage_baseline_json`（签收基线）与
 *      `stale_reason`（过期原因），均可空、仅 ALTER 补列、不进 requiredColumns。
 *      回滚：列可保留不读；扫描入口摘除即回到「只有时间过期」判据。
 * v44：G2-3 进化 Layer1 记录表 —— 新建 `memory_hits`（只存引用不存全文）+ 索引
 *      `idx_memory_hits_project_created` / 唯一 `ux_memory_hits_run_kind_ref`。
 *      纯建表 + 建索引，无数据迁移、不改既有列；旧库启动时由 `rebuildTableIfNeeded`
 *      的「表不存在即建」路径补齐。保留治理（180 天 / 单项目 20 万）由
 *      `pruneMemoryHits` 在启动与每日任务执行。
 *      回滚：`DROP TABLE IF EXISTS memory_hits`（记录层可丢，不影响任务/证据）。
 * v45：G2-2 进化 Layer1 —— `memory_hits.source_outcome` 可空列（completed/failed/
 *      timeout/cancelled/interrupted），仅 ALTER 补列、不重建；写入方为
 *      `WorkRunService` 五个终态方法，采集失败写 `map_migration_reports(kind='integrity_check',
 *      stage='memory:<runId>')`，不回滚 run。
 *      回滚：列可保留不读；停用 `collectMemoryHitsForRun` 调用即停止产生新记录。
 */
const CURRENT_SCHEMA_VERSION = 45

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
        type TEXT NOT NULL CHECK(type IN ('online', 'dev', 'test')),
        -- S3（§8.5）：图级生命周期（归档语义;值域与 nodes 对齐）。
        lifecycle_state TEXT NOT NULL DEFAULT 'active'
          CHECK(lifecycle_state IN ('active','archived','merged','split')),
        project_path TEXT,
        -- 必须留在 createSql 里：该列由 runIncrementalMigrations 补出，
        -- 不在 createSql 会导致表重建时 restoreFromBackup 丢掉该值，
        -- 用户「关闭写回」的项目设置会被重置为 0。
        writeback_disabled INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    requiredColumns: ['id', 'name', 'type', 'lifecycle_state', 'created_at', 'updated_at'],
  },
  {
    name: 'nodes',
    createSql: `
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('project', 'module', 'process', 'feature', 'bug', 'wiki-page', 'test-suite', 'test-case')),
        status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder')),
        title TEXT NOT NULL,
        description TEXT,
        acceptance_criteria TEXT,
        graph_id TEXT NOT NULL,
        graph_type TEXT NOT NULL CHECK(graph_type IN ('online', 'dev', 'test')),
        -- S1（session-map 蓝图 §2.1/§7.1）：项目内稳定身份。必须可空、**不进**
        -- requiredColumns（I1）：旧库迁移走「建列 → 回填 → 建唯一索引」，写 NOT NULL
        -- 或进 requiredColumns 都会迫使 rebuildTableIfNeeded 走重建路径。
        -- 必须留在 createSql（而非只靠 addColumnSafe）：任何一次 nodes 重建
        -- 都会把该列值静默丢弃。
        entity_key TEXT,
        -- S3（§2.4/§8.5）：生命周期。进 createSql 且 CHECK 变化 → 老库重建
        -- （restoreFromBackup 共有列恢复，新列旧行安全落 DEFAULT 'active'）。
        lifecycle_state TEXT NOT NULL DEFAULT 'active'
          CHECK(lifecycle_state IN ('active','archived','merged','split')),
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
        -- v39 / G2-13：test-case 无通过记录发布时的人工豁免（JSON）。
        -- 可空、**不进 requiredColumns**：存量库用 ALTER TABLE 补列，不能触发重建。
        published_waiver_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    requiredColumns: ['id', 'type', 'status', 'title', 'graph_id', 'graph_type', 'lifecycle_state', 'position_x', 'position_y', 'created_at', 'updated_at', 'wiki_content', 'wiki_meta'],
  },
  {
    name: 'edges',
    createSql: `
      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        label TEXT,
        edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change', 'wiki-link', 'hierarchical', 'verifies', 'covers')),
        graph_id TEXT NOT NULL,
        content TEXT,
        description TEXT,
        data_flow TEXT,
        strength REAL,
        -- 同上：由增量迁移补出，必须进 createSql 才能在重建时保留。
        updated_at TEXT
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
        -- 以下 5 列由 runIncrementalMigrations 补出，必须进 createSql：
        -- 否则 chat_threads 一旦重建（如未来扩展 status CHECK），
        -- context 水位与 metadata.task_kind（A2A 任务过滤依赖）会被静默清空。
        parent_thread_id TEXT,
        context_tokens_used INTEGER DEFAULT 0,
        context_window_max INTEGER DEFAULT 0,
        last_compacted_at INTEGER,
        metadata TEXT DEFAULT '{}',
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
        -- 同上：由增量迁移补出，必须进 createSql 才能在重建时保留 token 计数。
        token_count INTEGER DEFAULT 0,
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
  // v26：S1 导入查重三表 + 迁移报告表（session-map 蓝图 §7.2 DDL 逐字对齐）。
  {
    name: 'project_fingerprints',
    createSql: `
      CREATE TABLE project_fingerprints (
        id                TEXT PRIMARY KEY,
        project_name      TEXT,
        dir_name          TEXT NOT NULL,
        root_path         TEXT NOT NULL,
        last_modified_at  INTEGER,
        sample_files_json TEXT NOT NULL,
        sample_count      INTEGER NOT NULL,
        signature_hash    TEXT,
        graph_ids_json    TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        last_seen_at      TEXT NOT NULL,
        UNIQUE(root_path)
      )
    `,
    requiredColumns: ['id', 'dir_name', 'root_path', 'sample_files_json', 'sample_count', 'graph_ids_json', 'created_at', 'last_seen_at'],
  },
  {
    // 表名沿用"拒绝"语义，但同时记录 allowed_branch / allowed_with_warning 放行决策。
    name: 'import_rejections',
    createSql: `
      CREATE TABLE import_rejections (
        id                     TEXT PRIMARY KEY,
        attempted_root_path    TEXT NOT NULL,
        attempted_name         TEXT,
        attempted_dir_name     TEXT,
        matched_fingerprint_id TEXT,
        matched_signals_json   TEXT NOT NULL,
        decision               TEXT NOT NULL CHECK(decision IN (
          'rejected','allowed_branch','allowed_with_warning')),
        allowance_source       TEXT CHECK(allowance_source IN ('this_time','remembered_rule')),
        reason                 TEXT,
        created_at             TEXT NOT NULL
      )
    `,
    requiredColumns: ['id', 'attempted_root_path', 'matched_signals_json', 'decision', 'created_at'],
  },
  {
    // 记住的分支/副本放行规则（仅用户显式勾选"对同一指纹记住"时写入；撤销置 revoked_at 不删行）
    name: 'import_allowances',
    createSql: `
      CREATE TABLE import_allowances (
        id              TEXT PRIMARY KEY,
        fingerprint_id  TEXT NOT NULL REFERENCES project_fingerprints(id) ON DELETE CASCADE,
        dir_name        TEXT NOT NULL,
        granted_by      TEXT NOT NULL,
        granted_at      TEXT NOT NULL,
        note            TEXT,
        revoked_at      TEXT,
        revoked_by      TEXT,
        UNIQUE(fingerprint_id, dir_name)
      )
    `,
    requiredColumns: ['id', 'fingerprint_id', 'dir_name', 'granted_by', 'granted_at'],
  },
  {
    // S1 迁移状态机（§8.14.1）：阶段记录 running/ok/partial/failed + 心跳 + owner_pid；
    // 每个阶段独立一行，重跑新建行不覆盖历史。不新增表，所有阶段记录复用本表。
    name: 'map_migration_reports',
    createSql: `
      CREATE TABLE map_migration_reports (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL CHECK(kind IN (
          'entity_key_backfill','link_backfill','integrity_check','import_dedup',
          'derivation','cleanup')),
        stage         TEXT,
        schema_version INTEGER,
        started_at    TEXT NOT NULL,
        finished_at   TEXT,
        heartbeat_at  TEXT,
        owner_pid     INTEGER,
        status        TEXT NOT NULL CHECK(status IN ('running','ok','partial','failed')),
        stats_json    TEXT,
        details_json  TEXT,
        error_json    TEXT
      )
    `,
    requiredColumns: ['id', 'kind', 'started_at', 'status'],
  },
  {
    // v27 / S2（session-map 蓝图 §2.3 + §7.2 DDL 逐字对齐）：跨图对应关系。
    // 存 entity_key 不存 node id 为主键语义（id 会变键不变）；**不建到 nodes 的外键**
    // （L6：节点/图删除不得级联删链接，损坏表现为 status='orphan' 而非静默消失）。
    name: 'node_links',
    createSql: `
      CREATE TABLE node_links (
        id              TEXT PRIMARY KEY,
        project_path    TEXT NOT NULL,
        from_entity_key TEXT NOT NULL,
        from_graph_id   TEXT NOT NULL,
        from_graph_type TEXT NOT NULL CHECK(from_graph_type IN ('online','dev','test')),
        from_node_id    TEXT,
        to_entity_key   TEXT NOT NULL,
        to_graph_id     TEXT NOT NULL,
        to_graph_type   TEXT NOT NULL CHECK(to_graph_type IN ('online','dev','test')),
        to_node_id      TEXT,
        link_type       TEXT NOT NULL CHECK(link_type IN (
          'derives_from','implements','verifies','covers','depends_on',
          'split_from','merged_into','supersedes','relates_to')),
        direction       TEXT NOT NULL DEFAULT 'directed'
                        CHECK(direction IN ('directed','symmetric')),
        confidence      REAL NOT NULL DEFAULT 1.0,
        origin          TEXT NOT NULL CHECK(origin IN ('human','derived','import')),
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','stale','orphan')),
        reason          TEXT,
        metadata        TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        -- entity_key 在 online/dev 之间共享：同一对键可能在不同图组合下各有一条
        -- 合法链接，去重必须带两端 graph_id，否则会复用别图的 from/to_graph_id。
        UNIQUE(from_graph_id, to_graph_id, from_entity_key, to_entity_key, link_type)
      )
    `,
    requiredColumns: [
      'id', 'project_path', 'from_entity_key', 'from_graph_id', 'from_graph_type',
      'to_entity_key', 'to_graph_id', 'to_graph_type', 'link_type', 'direction',
      'origin', 'status', 'created_at', 'updated_at',
    ],
  },
  // v28 / S5a 六表(work_items/work_steps/work_runs/node_session_links/change_sets/
  // routing_decisions)。DDL 单一权威在 map/schema.ts(§7.2 逐字;状态值域一次建齐 D2)。
  ...MAP_S5A_TABLE_SCHEMAS,
  // v29 / S6a 双表(node_evidence 含 E3/E4 字段级 CHECK / node_execution_state 派生缓存)。
  ...MAP_S6A_TABLE_SCHEMAS,
  // v31 / S7 三表(boundary_candidates/plan_drafts/plan_deviations,§7.2 逐字)。
  ...MAP_S7_TABLE_SCHEMAS,
  // v32 / S8 前置五表(test_specs/test_plans/test_plan_items/test_runs/test_results)。
  ...MAP_S8_TABLE_SCHEMAS,
  // v35 / manual 验收确认事实（替代 agent_approvals 复用，§M5.11）。
  ...MAP_ACCEPTANCE_TABLE_SCHEMAS,
  // v36 / W3 G3-5：存量 acceptance 迁移的原文存档（回滚凭据，非运行期依赖）。
  ...MAP_ACCEPTANCE_MIGRATION_ARCHIVE_SCHEMAS,
  // v44 / G2-3：进化 Layer1 记录表 memory_hits。
  ...MAP_MEMORY_TABLE_SCHEMAS,
  // v18：Agent Runtime 9 张表（D1）。DDL 单一权威在 agent/runtime/db/schema.ts。
  ...(AGENT_TABLE_SCHEMAS as AgentTableSchema[]),
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
  // v26：S1（session-map 蓝图 §2.1/§7.2）。唯一约束按 (graph_id, entity_key)——
  // online 与 dev 是不同 graph_id，同一实体可共享键。
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_nodes_graph_entity_key ON nodes(graph_id, entity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_entity_key ON nodes(entity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_project_fingerprints_dir ON project_fingerprints(dir_name)`,
  `CREATE INDEX IF NOT EXISTS idx_import_rejections_time ON import_rejections(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_import_allowances_fp ON import_allowances(fingerprint_id)`,
  // v27 / S2：node_links 查询索引（§7.2）
  `CREATE INDEX IF NOT EXISTS idx_node_links_from ON node_links(from_entity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_node_links_to ON node_links(to_entity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_node_links_project ON node_links(project_path, status)`,
  `CREATE INDEX IF NOT EXISTS idx_node_links_from_node ON node_links(from_node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_node_links_to_node ON node_links(to_node_id)`,
  ...MAP_S5A_INDEX_SQLS,
  ...MAP_S6A_INDEX_SQLS,
  ...MAP_S7_INDEX_SQLS,
  ...MAP_S8_INDEX_SQLS,
  ...MAP_ACCEPTANCE_INDEX_SQLS,
  ...MAP_MEMORY_INDEX_SQLS,
  // v18: Agent Runtime（含 ux_turns_active 节点互斥部分唯一索引）
  ...AGENT_INDEX_SQLS,
]

function getSchemaChecksumPath(): string {
  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'data')
  fs.mkdirSync(dbDir, { recursive: true })
  return path.join(dbDir, 'schema-checksum.json')
}

function computeSchemaChecksum(): string {
  // 内联 UNIQUE 随 createSql 进入 tables，独立 UNIQUE 索引随 INDEX_SQLS 进入 indexes；
  // 两类 UNIQUE 定义的任何变化都会让 checksum 失配 → 走慢路径，不会漏掉已有库。
  // v38 起 view 定义也纳入 checksum：视图增删/改口径同样触发慢路径对账。
  const payload = JSON.stringify({
    version: CURRENT_SCHEMA_VERSION,
    tables: TABLE_SCHEMAS.map((s) => s.createSql.trim()),
    indexes: INDEX_SQLS,
    views: MAP_VIEW_SCHEMAS.map((v) => v.createSql.trim()),
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

  // fail-closed（§8.2.1）：库被更高版本的代码写过时拒绝打开，不得按旧 schema 重建。
  // 否则慢路径会用本版本的 createSql 重建表，restoreFromBackup 只恢复共有列，
  // 新版本的列/约束被静默丢弃，随后又把 schema_version 回写成当前（更低）版本，
  // 造成不可逆的数据退化。这里不提供启动期自动"降级"；需要降级必须显式操作并留痕。
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new DatabaseError(
      `数据库 schema 版本为 v${currentVersion}，高于本应用支持的 v${CURRENT_SCHEMA_VERSION}。` +
        `为避免按旧 schema 重建并静默丢弃新版本写入的列，已拒绝打开（库文件：${db.name}）。` +
        `请使用不低于该库版本的 BizGraph 打开，或从备份恢复；旧版本不会自动降级该库。`,
      ErrorCode.DB_SCHEMA_TOO_NEW,
    )
  }

  // 同一版本域的第二个标记：schema-checksum.json 由更高版本写就时，快路径必然失配、
  // 慢路径会按本版本的 createSql 重建。即使库记录尚未 bump（异常/文件混用），也拒绝打开。
  if (checksumCache && checksumCache.version > CURRENT_SCHEMA_VERSION) {
    throw new DatabaseError(
      `schema 校验缓存记录的版本为 v${checksumCache.version}，高于本应用支持的 v${CURRENT_SCHEMA_VERSION}` +
        `（缓存文件：${getSchemaChecksumPath()}，库记录 v${currentVersion}）。` +
        `该数据目录曾被更高版本使用；为避免按旧 schema 重建，已拒绝打开。` +
        `请使用新版应用，或按备份流程恢复库并显式处理该缓存文件；旧版本不会自动降级。`,
      ErrorCode.DB_SCHEMA_TOO_NEW,
    )
  }

  // Fast path: schema version and checksum are both current — skip expensive rebuild/index checks.
  if (currentVersion >= CURRENT_SCHEMA_VERSION && checksumCache?.version === CURRENT_SCHEMA_VERSION && checksumCache?.checksum === checksum) {
    runIncrementalMigrations(db, currentVersion)
    // 视图是派生对象，快路径也做一次对账：手工 DROP/定义漂移不会留到下次慢路径。
    applyMapViews(db)
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
    // S4（§8.6）：v32→33 的 CHECK 值域扩展会重建 graphs/edges/nodes——
    // 重建前拍基线（行数/entity_key/writeback_disabled/共有列内容哈希）,
    // 重建后逐项校验,失配即整体回滚+启动阻断。
    // 取证边界必须止于「重建」本身：后续 runIncrementalMigrations 会**合法改写/新增**
    // 数据（如 v16→v17 插入层级边、default 改 hierarchical）,纳入比对标尺会误报。
    const s4Baseline = currentVersion < 33 ? captureS4Baseline(db) : null

    // 慢路径（版本落后 **或** checksum 失配）一律尝试重建。
    // 只按版本号门禁会让「改了 createSql 但忘了 bump CURRENT_SCHEMA_VERSION」的
    // schema 变更静默失效：checksum 已经失配，却因为版本号没变而跳过重建。
    // rebuildTableIfNeeded 内部只在列集合 / 列类型 / CHECK 变化时才真正重建，
    // 无变化时仅做几次 pragma 查询，代价可忽略。
    for (const schema of TABLE_SCHEMAS) {
      rebuildTableIfNeeded(db, schema.name, schema.createSql, schema.requiredColumns)
    }

    // 派生缓存列约束（NOT NULL → 可空）不在 rebuildTableIfNeeded 的比对范围，
    // 单独按当前 createSql 重建；纯缓存表，无数据损失。
    rebuildNullableReproducibleCache(db)

    // S4 重建后校验——紧跟重建循环,先于增量迁移（失配抛错 → SAVEPOINT 整体回滚 → 启动阻断）
    if (s4Baseline) {
      verifyS4PostRebuild(db, s4Baseline)
    }

    // 增量补列必须先于索引创建：Phase D9 的表达式索引依赖
    // chat_threads.metadata（由 addColumnSafe 补齐），老库上先建索引会因列不存在而失败。
    runIncrementalMigrations(db, currentVersion)

    // 索引对账：新增/改定义的索引先 DROP 再建（IF NOT EXISTS 不替换旧定义）；
    // 唯一索引重建前做重复键体检（fail-closed）。
    reconcileSchemaIndexes(db)

    // v38：只读视图对账（G2-14）。DROP+CREATE，失败随 SAVEPOINT 整体回滚。
    applyMapViews(db)

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
 * v35（§M5.11）：把 `9852b77` 写入 agent_approvals 的人工验收确认事实搬进
 * acceptance_confirmations。逐行保留 legacy_approval_id 以可追溯；解析不了的
 * 历史行不删、只告警（不静默丢失）。迁移后 agent_approvals 不再有
 * tool_name='acceptance_manual_confirm' 的非工具审批行。
 */
function migrateLegacyAcceptanceConfirmations(db: BetterSqlite3.Database): void {
  const hasTarget = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='acceptance_confirmations'")
    .get()
  const hasSource = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_approvals'")
    .get()
  if (!hasTarget || !hasSource) {
    logger.info('acceptance_confirmations 或 agent_approvals 不存在，跳过历史人工确认迁移')
    return
  }

  const rows = db
    .prepare(
      `SELECT id, subject_id, step_id, decided_by, decided_at, decision_note, args_json, created_at
         FROM agent_approvals WHERE tool_name = ?`,
    )
    .all(LEGACY_ACCEPTANCE_APPROVAL_TOOL) as Array<{
    id: string
    subject_id: string | null
    step_id: string | null
    decided_by: string | null
    decided_at: number | null
    decision_note: string | null
    args_json: string
    created_at: number
  }>

  if (rows.length === 0) {
    logger.info('历史人工验收确认行 0 条（agent_approvals 无需迁移）')
    return
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO acceptance_confirmations
       (id, batch_id, work_item_id, step_id, entry_id, decided_by, decided_at,
        decision_note, source, legacy_approval_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'legacy_agent_approval', ?, ?)`,
  )
  const remove = db.prepare('DELETE FROM agent_approvals WHERE id = ? AND tool_name = ?')

  let migratedRows = 0
  let migratedEntries = 0
  let keptRows = 0

  const txn = db.transaction(() => {
    for (const row of rows) {
      let entryIds: string[] = []
      let argsStepId = ''
      try {
        const parsed = JSON.parse(row.args_json) as { entryIds?: unknown; stepId?: unknown }
        if (Array.isArray(parsed.entryIds)) {
          entryIds = parsed.entryIds.filter(
            (id): id is string => typeof id === 'string' && id.trim() !== '',
          )
        }
        if (typeof parsed.stepId === 'string') argsStepId = parsed.stepId
      } catch {
        // 历史 args_json 损坏：保留原行并告警，不当成已迁移。
      }

      const stepId = row.step_id ?? (argsStepId || null)
      const workItemId = row.subject_id
      if (!stepId || !workItemId || entryIds.length === 0) {
        keptRows += 1
        logger.warn(
          `历史人工验收确认行无法迁移，已保留原行 id=${row.id}（step=${stepId ?? 'NULL'}, item=${workItemId ?? 'NULL'}, entries=${entryIds.length}）`,
        )
        continue
      }

      const batchId = `legacy:${row.id}`
      const decidedAt = row.decided_at ?? row.created_at
      const decidedBy = row.decided_by ?? 'user'
      let insertedAll = true
      for (const entryId of entryIds) {
        const result = insert.run(
          `ac_${crypto.randomUUID()}`,
          batchId,
          workItemId,
          stepId,
          entryId,
          decidedBy,
          decidedAt,
          row.decision_note,
          row.id,
          row.created_at,
        )
        if (result.changes > 0) migratedEntries += 1
        else insertedAll = false // 新表已有同条目确认：仍然搬走，避免旧语义残留
      }
      remove.run(row.id, LEGACY_ACCEPTANCE_APPROVAL_TOOL)
      migratedRows += 1
      if (!insertedAll) {
        logger.info(`历史确认行 id=${row.id} 部分条目已存在于新表，按幂等跳过重复行`)
      }
    }
  })
  txn()

  logger.info(
    `历史人工验收确认迁移完成：${migratedRows} 行/${migratedEntries} 条目迁入 acceptance_confirmations，` +
      `${keptRows} 行因信息不全保留在 agent_approvals`,
  )
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

  // v34：失败/跳过归因列（§4.7.4 / §5.5.1）。纯加列，不重建表：
  // 三列已同步写进 map/schema.ts 的 createSql（新库/重建路径），但**不进**
  // requiredColumns——requiredColumns 缺列会让 rebuildTableIfNeeded 走 DROP TABLE
  // 重建，违背「纯增量」；存量库在这里用 ALTER TABLE 补列。
  if (currentVersion < 34) {
    addColumnSafe('work_steps', 'skip_reason', 'TEXT')
    addColumnSafe('work_steps', 'failure_class', 'TEXT')
    addColumnSafe('work_items', 'cancel_reason', 'TEXT')
  }

  // v35：历史人工验收确认从 agent_approvals 搬到 acceptance_confirmations。
  // 新表已由 TABLE_SCHEMAS 建好；这里只搬数据（解析不了的旧行保留并告警）。
  if (currentVersion < 35) {
    migrateLegacyAcceptanceConfirmations(db)
  }

  // v36：W3 G3-4 优先级列（纯加列，不重建表；不进 requiredColumns）。
  if (currentVersion < 36) {
    addColumnSafe('work_items', 'priority', 'INTEGER')
  }

  // v36：W3 G3-5 存量自由文本 acceptance → manual。非结构化行以外的行一律不动；
  // 单事务内完成（本函数已在 migrate 的 SAVEPOINT 里）；存档表由 TABLE_SCHEMAS 建好。
  if (currentVersion < 36) {
    migrateLegacyAcceptance(db, CURRENT_SCHEMA_VERSION)
  }

  // v26 / S1.2（session-map 蓝图 §2.2.2）：nodes.entity_key 身份列。createSql 已含该列
  // （新建库/重建路径）；这里为存量库兜底补列——必须在 ux_nodes_graph_entity_key
  // 索引创建之前执行（migrate() 的顺序保证：先增量补列，后建索引）。
  addColumnSafe('nodes', 'entity_key', 'TEXT')

  // v32 / S8（§7.1）：agent_approvals 审批主体回填——历史行的 subject_id
  // 取 turn_id（subject_type 默认 'agent_turn'）。表不存在（极老夹具）则跳过。
  try {
    const hasApprovals = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_approvals'")
      .get()
    if (hasApprovals) {
      db.prepare("UPDATE agent_approvals SET subject_id = turn_id WHERE subject_id IS NULL AND turn_id IS NOT NULL").run()
    }
  } catch (err) {
    logger.warn('agent_approvals subject backfill failed:', err)
  }

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

  // v39：G2-13 published 软阻断 —— 发布豁免 JSON，可空，仅 ALTER 补列。
  if (currentVersion < 39) {
    addColumnSafe('nodes', 'published_waiver_json', 'TEXT')
  }

  // v40：G1-14 提案载荷（metadata.proposal），纯加列；不进 requiredColumns。
  if (currentVersion < 40) {
    addColumnSafe('work_items', 'metadata', 'TEXT')
  }

  // v41：G2-1 执行模式 id，纯加列；不进 requiredColumns（NULL = 历史决策）。
  if (currentVersion < 41) {
    addColumnSafe('routing_decisions', 'mode_id', 'TEXT')
  }

  // v42：G11-10 E3 执行树绑定，纯加列；不进 requiredColumns（NULL = 未采集/历史证据）。
  if (currentVersion < 42) {
    addColumnSafe('node_evidence', 'tree_hash', 'TEXT')
  }

  // v43：G1-9 E4 覆盖基线 + stale 原因，纯加列；不进 requiredColumns（NULL = 无基线）。
  if (currentVersion < 43) {
    addColumnSafe('node_evidence', 'coverage_baseline_json', 'TEXT')
    addColumnSafe('node_evidence', 'stale_reason', 'TEXT')
  }

  // v45：G2-2 Layer1 记忆命中记录 run 终态来源，纯加列；不进 requiredColumns
  // （NULL = v44 空表或来源未采集）。
  if (currentVersion < 45) {
    addColumnSafe('memory_hits', 'source_outcome', 'TEXT')
  }

  // v17：层级结构数据迁移（清孤儿 → 回填 sort_index → default 边改写 → 补齐层级边）。
  // 必须排在上面 addColumnSafe 之后 —— 迁移要回填 sort_index，列不存在会直接报错。
  runHierarchyMigration(db)
}
