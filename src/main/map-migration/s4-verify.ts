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
 * 保证前后两次查询的列集一致。任一失配即抛错——migrate() 的大 SAVEPOINT
 * 整体回滚,启动阻断（fail-closed,§8.14）。
 */

import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('S4Verify')

/** v32 时点的共有列（重建前后一致的列集,显式列出保证可比）。 */
const GRAPH_COLS = 'id, name, type, lifecycle_state, project_path, writeback_disabled, created_at, updated_at'
const NODE_COLS = `id, type, status, title, description, acceptance_criteria, graph_id, graph_type,
  entity_key, parent_id, sort_index, collapsed, rules, metadata, owner_role,
  position_x, position_y, content, community_summary, community_level, community_id,
  context_refs, wiki_content, wiki_meta, created_at, updated_at`
const EDGE_COLS = 'id, source, target, label, edge_type, graph_id, content, description, data_flow, strength, updated_at'

export interface S4Baseline {
  graphs: number
  edges: number
  nodes: number
  entityKeyNonNull: number
  writebackDisabled: number
  contentHash: string
}

function hashRows(db: BetterSqlite3.Database): string {
  const hash = createHash('sha256')
  for (const [table, cols] of [
    ['graphs', GRAPH_COLS],
    ['nodes', NODE_COLS],
    ['edges', EDGE_COLS],
  ] as const) {
    const rows = db.prepare(`SELECT ${cols} FROM ${table} ORDER BY id`).all()
    hash.update(`${table}:${rows.length}:`)
    for (const row of rows) hash.update(JSON.stringify(row))
  }
  return hash.digest('hex')
}

/** 重建前快照。三表任一不存在（极老库）返回 null——调用方跳过校验。 */
export function captureS4Baseline(db: BetterSqlite3.Database): S4Baseline | null {
  try {
    const graphs = (db.prepare('SELECT COUNT(*) AS c FROM graphs').get() as { c: number }).c
    const edges = (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c
    const nodes = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c
    const entityKeyNonNull = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE entity_key IS NOT NULL').get() as { c: number }).c
    const writebackDisabled = (db.prepare('SELECT COUNT(*) AS c FROM graphs WHERE writeback_disabled = 1').get() as { c: number }).c
    return { graphs, edges, nodes, entityKeyNonNull, writebackDisabled, contentHash: hashRows(db) }
  } catch (err) {
    logger.warn('S4 baseline capture failed (表缺失或极老库,跳过校验):', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * 重建后校验（§8.6 逐项）。失配写报告并抛错——migrate 的 SAVEPOINT 整体回滚,
 * 启动阻断;不得部分修复后再启动。
 */
export function verifyS4PostRebuild(db: BetterSqlite3.Database, baseline: S4Baseline): void {
  const post = captureS4Baseline(db)
  if (!post) {
    throw new Error('S4 重建后基线采集失败（表缺失）——回滚处理')
  }
  const mismatches: string[] = []
  if (post.graphs !== baseline.graphs) mismatches.push(`graphs ${baseline.graphs}→${post.graphs}`)
  if (post.edges !== baseline.edges) mismatches.push(`edges ${baseline.edges}→${post.edges}`)
  if (post.nodes !== baseline.nodes) mismatches.push(`nodes ${baseline.nodes}→${post.nodes}`)
  if (post.entityKeyNonNull !== baseline.entityKeyNonNull) {
    mismatches.push(`entity_key 非空 ${baseline.entityKeyNonNull}→${post.entityKeyNonNull}`)
  }
  if (post.writebackDisabled !== baseline.writebackDisabled) {
    mismatches.push(`writeback_disabled=1 ${baseline.writebackDisabled}→${post.writebackDisabled}`)
  }
  if (post.contentHash !== baseline.contentHash) {
    mismatches.push('共有列内容哈希不一致')
  }

  const status = mismatches.length === 0 ? 'ok' : 'failed'
  const stats = JSON.stringify({ baseline, post: { ...post, contentHash: undefined }, match: mismatches.length === 0, mismatches })
  db.prepare(
    `INSERT INTO map_migration_reports
       (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, stats_json, error_json)
     VALUES (?, 'integrity_check', 'S4.rebuild', NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `s4_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    new Date().toISOString(), new Date().toISOString(), process.pid, status, stats,
    mismatches.length > 0 ? JSON.stringify({ mismatches }) : null,
  )

  if (mismatches.length > 0) {
    throw new Error(`S4 重建校验失配:${mismatches.join('; ')}——迁移整体回滚（§8.6:不要部分修复后再启动）`)
  }
  logger.info('S4 rebuild verification passed: 三表行数/entity_key/writeback_disabled/内容哈希全部一致')
}
