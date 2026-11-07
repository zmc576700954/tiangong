/**
 * S4 重建基线与校验（session-map 蓝图 §8.6）
 *
 * v33（CHECK 值域扩展,test 图）会触发 graphs/edges/nodes 三表重建。
 * 本模块提供：
 *  - captureS4Baseline：重建前对三表拍快照（行数 + 共有列内容哈希）;
 *  - verifyS4PostRebuild：重建后重拍并逐项比对——行数/entity_key 保留/
 *    writeback_disabled 保留/内容哈希一致（§8.6「行数、内容 hash、
 *    entity_key 保留、writeback_disabled 保留」）。
 *
 * 哈希列取**显式共有列清单**（v32 之前的列,新列 lifecycle_state 不参与）,
 * 保证前后两次查询的列集一致。极老库（v17,缺 entity_key / writeback_disabled
 * 等列）不再放弃校验：按「期望列 ∩ 实有列」取降级基线,并沿用同一列集在重建
 * 后比对,让「数据没丢」由机制证明。任一失配即抛错——migrate() 的大 SAVEPOINT
 * 整体回滚,启动阻断（fail-closed,§8.14）。
 *
 * 无论完整/降级/无数据,校验结论都写入 `map_migration_reports`
 * (kind='integrity_check', stage='S4.rebuild')：这是可查询的启动诊断项,
 * 不依赖人读日志。
 */

import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('S4Verify')

type S4Table = 'graphs' | 'nodes' | 'edges'

const S4_TABLES: readonly S4Table[] = ['graphs', 'nodes', 'edges']

/** v32 时点的期望共有列（重建前后一致的列集,显式列出保证可比）。 */
const EXPECTED_COLUMNS: Record<S4Table, readonly string[]> = {
  graphs: ['id', 'name', 'type', 'lifecycle_state', 'project_path', 'writeback_disabled', 'created_at', 'updated_at'],
  nodes: [
    'id', 'type', 'status', 'title', 'description', 'acceptance_criteria', 'graph_id', 'graph_type',
    'entity_key', 'parent_id', 'sort_index', 'collapsed', 'rules', 'metadata', 'owner_role',
    'position_x', 'position_y', 'content', 'community_summary', 'community_level', 'community_id',
    'context_refs', 'wiki_content', 'wiki_meta', 'created_at', 'updated_at',
  ],
  edges: ['id', 'source', 'target', 'label', 'edge_type', 'graph_id', 'content', 'description', 'data_flow', 'strength', 'updated_at'],
}

export interface S4Baseline {
  graphs: number
  edges: number
  nodes: number
  /** entity_key 列不存在（极老库）时为 null——表示无法比对,不当作 0。 */
  entityKeyNonNull: number | null
  /** writeback_disabled 列不存在时为 null。 */
  writebackDisabled: number | null
  contentHash: string
  /** 本次实际参与哈希的列（极老库为期望列与实有列的交集）。 */
  columns: Record<S4Table, string[]>
  /** 拍快照时三表是否存在。 */
  tablesPresent: Record<S4Table, boolean>
  /** 降级原因（缺表/缺列）；空数组 = 期望列齐全。 */
  degradedReasons: string[]
}

function tableExists(db: BetterSqlite3.Database, table: S4Table): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) != null
}

function actualColumns(db: BetterSqlite3.Database, table: S4Table): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

function hashRows(
  db: BetterSqlite3.Database,
  columns: Record<S4Table, string[]>,
  tablesPresent: Record<S4Table, boolean>,
): string {
  const hash = createHash('sha256')
  for (const table of S4_TABLES) {
    if (!tablesPresent[table]) {
      hash.update(`${table}:absent:`)
      continue
    }
    const cols = columns[table]
    const orderBy = cols.includes('id') ? '"id"' : 'rowid'
    const rows = cols.length === 0
      ? (db.prepare(`SELECT 1 AS present FROM ${table} ORDER BY ${orderBy}`).all() as unknown[])
      : db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table} ORDER BY ${orderBy}`).all()
    hash.update(`${table}:${rows.length}:`)
    for (const row of rows) hash.update(JSON.stringify(row))
  }
  return hash.digest('hex')
}

/**
 * 拍 S4 快照。缺表的极老库/首次建库不再直接放弃：缺列时按「期望列 ∩ 实有列」
 * 取降级基线（行数 + 共有列内容哈希）。
 * fixedColumns 供重建后使用：必须沿用重建前同一列集,否则新增列会让哈希不可比。
 */
function snapshot(db: BetterSqlite3.Database, fixedColumns?: Record<S4Table, string[]>): S4Baseline {
  const columns = {} as Record<S4Table, string[]>
  const tablesPresent = {} as Record<S4Table, boolean>
  const degradedReasons: string[] = []

  for (const table of S4_TABLES) {
    const exists = tableExists(db, table)
    tablesPresent[table] = exists
    if (!exists) {
      columns[table] = []
      degradedReasons.push(`${table} 表不存在`)
      continue
    }
    const actual = actualColumns(db, table)
    const expected = fixedColumns?.[table] ?? EXPECTED_COLUMNS[table]
    columns[table] = expected.filter((c) => actual.has(c))
    if (!fixedColumns) {
      const missing = EXPECTED_COLUMNS[table].filter((c) => !actual.has(c))
      if (missing.length > 0) degradedReasons.push(`${table} 缺少列: ${missing.join(', ')}`)
    }
  }

  const count = (table: S4Table): number =>
    tablesPresent[table]
      ? (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
      : 0

  const entityKeyNonNull =
    tablesPresent.nodes && columns.nodes.includes('entity_key')
      ? (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE entity_key IS NOT NULL').get() as { c: number }).c
      : null
  const writebackDisabled =
    tablesPresent.graphs && columns.graphs.includes('writeback_disabled')
      ? (db.prepare('SELECT COUNT(*) AS c FROM graphs WHERE writeback_disabled = 1').get() as { c: number }).c
      : null

  return {
    graphs: count('graphs'),
    nodes: count('nodes'),
    edges: count('edges'),
    entityKeyNonNull,
    writebackDisabled,
    contentHash: hashRows(db, columns, tablesPresent),
    columns,
    tablesPresent,
    degradedReasons,
  }
}

/** 重建前快照。极老库缺列时返回降级基线（不再返回 null 跳过整段校验）。 */
export function captureS4Baseline(db: BetterSqlite3.Database): S4Baseline {
  return snapshot(db)
}

/**
 * 重建后校验（§8.6 逐项）。失配写报告并抛错——migrate 的 SAVEPOINT 整体回滚,
 * 启动阻断;不得部分修复后再启动。无论结论如何都落一行可查询的启动诊断记录。
 */
export function verifyS4PostRebuild(db: BetterSqlite3.Database, baseline: S4Baseline): void {
  const post = snapshot(db, baseline.columns)
  const mismatches: string[] = []

  for (const table of S4_TABLES) {
    if (baseline.tablesPresent[table] && !post.tablesPresent[table]) {
      mismatches.push(`${table} 表重建后消失`)
      continue
    }
    const missing = baseline.columns[table].filter((c) => !post.columns[table].includes(c))
    if (missing.length > 0) mismatches.push(`${table} 重建后丢失列: ${missing.join(', ')}`)
  }

  if (post.graphs !== baseline.graphs) mismatches.push(`graphs ${baseline.graphs}→${post.graphs}`)
  if (post.edges !== baseline.edges) mismatches.push(`edges ${baseline.edges}→${post.edges}`)
  if (post.nodes !== baseline.nodes) mismatches.push(`nodes ${baseline.nodes}→${post.nodes}`)
  if (baseline.entityKeyNonNull !== null && post.entityKeyNonNull !== null && post.entityKeyNonNull !== baseline.entityKeyNonNull) {
    mismatches.push(`entity_key 非空 ${baseline.entityKeyNonNull}→${post.entityKeyNonNull}`)
  }
  if (baseline.writebackDisabled !== null && post.writebackDisabled !== null && post.writebackDisabled !== baseline.writebackDisabled) {
    mismatches.push(`writeback_disabled=1 ${baseline.writebackDisabled}→${post.writebackDisabled}`)
  }

  // 哈希两端必须同一口径：以「重建前已存在的表」为准。重建后新建成空表不得改变基线口径；
  // 重建前存在、重建后消失的表按 absent 参与，哈希自然失配。
  const effectivePresence = {} as Record<S4Table, boolean>
  for (const table of S4_TABLES) {
    effectivePresence[table] = baseline.tablesPresent[table] && post.tablesPresent[table]
  }
  const postHash = hashRows(db, post.columns, effectivePresence)
  if (postHash !== baseline.contentHash) mismatches.push('共有列内容哈希不一致')

  const mode: 'full' | 'degraded' | 'none' =
    !S4_TABLES.some((table) => baseline.tablesPresent[table])
      ? 'none'
      : baseline.degradedReasons.length > 0
        ? 'degraded'
        : 'full'

  const details =
    mode === 'none'
      ? 'S4 校验已跳过：graphs/nodes/edges 表在迁移前均不存在（首次建库），无历史数据可校验'
      : mode === 'degraded'
        ? `S4 校验以降级模式执行（极老库,仅比对各表迁移前已存在的列）：${baseline.degradedReasons.join('；')}`
        : null

  const status = mismatches.length === 0 ? 'ok' : 'failed'
  const stats = JSON.stringify({
    mode,
    skipped: mode === 'none',
    match: mismatches.length === 0,
    degradedReasons: baseline.degradedReasons,
    baseline,
    post: { ...post, contentHash: postHash },
    mismatches,
  })
  db.prepare(
    `INSERT INTO map_migration_reports
       (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, stats_json, details_json, error_json)
     VALUES (?, 'integrity_check', 'S4.rebuild', NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `s4_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    new Date().toISOString(), new Date().toISOString(), process.pid, status, stats, details,
    mismatches.length > 0 ? JSON.stringify({ mismatches }) : null,
  )

  if (mismatches.length > 0) {
    throw new Error(`S4 重建校验失配:${mismatches.join('; ')}——迁移整体回滚（§8.6:不要部分修复后再启动）`)
  }
  if (mode === 'none') {
    logger.warn(`S4 校验已跳过（首次建库/三表不存在,无历史数据）：${details}`)
  } else if (mode === 'degraded') {
    logger.warn(`S4 重建校验以降级模式通过（极老库）：${baseline.degradedReasons.join('；')}`)
  } else {
    logger.info('S4 rebuild verification passed: 三表行数/entity_key/writeback_disabled/内容哈希全部一致')
  }
}
