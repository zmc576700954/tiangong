/**
 * S2 回填与巡检（session-map 蓝图 §2.3.1 S2 回填 + 孤儿巡检）
 *
 * 回填：对每个项目（online/dev 基准图配对与 S1 一致），凡 dev 侧节点与 online
 * 侧节点共享 entity_key → 插入 derives_from（from=dev, to=online, origin='import'）。
 * 幂等：唯一键命中即跳过；冲突不覆盖人工链接。测试图未上线前不回填
 * verifies/covers（S4 后由测试资产创建流程补）。
 *
 * 巡检（启动后一次 + 每日一次 + 手动）：status='active' 但任一端
 * (graph_id, entity_key) 不可解析 → 置 orphan 并计数；不再满足 link_type 矩阵 →
 * 置 stale。只报告、不自动删除；幂等（状态不变时不更新行）。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import { runMigrationStage } from './migration-state'
import { pairProjectGraphs } from './entity-key-backfill'
import { isLinkTypeAllowed } from './link-service'
import type { NodeLinkRow, GraphTypeValue, LinkType } from './link-service'

const logger = createLogger('LinkBackfill')

/** S2 回填（§2.3.1）：dev→online 按 entity_key 建 derives_from,幂等。 */
export function runLinkBackfill(db: BetterSqlite3.Database, schemaVersion: number): { inserted: number; skipped: number } {
  let result = { inserted: 0, skipped: 0 }
  runMigrationStage(db, {
    kind: 'link_backfill',
    stage: 'S2',
    schemaVersion,
    work: () => {
      const pairings = pairProjectGraphs(db)
      let inserted = 0
      let skipped = 0
      for (const pairing of pairings) {
        // 每项目一个事务；键冲突（已有链接）→ 跳过，不覆盖人工链接
        const run = db.transaction((): { inserted: number; skipped: number } => {
          const pairs = db
            .prepare(
              `SELECT o.entity_key AS key, o.id AS online_node_id, d.id AS dev_node_id
                 FROM nodes o
                 JOIN nodes d ON d.entity_key = o.entity_key AND d.graph_id = ?
                WHERE o.graph_id = ? AND o.entity_key IS NOT NULL`,
            )
            .all(pairing.dev, pairing.online) as Array<{ key: string; online_node_id: string; dev_node_id: string }>
          let ins = 0
          let skip = 0
          for (const p of pairs) {
            const existing = db
              .prepare(
                "SELECT id FROM node_links WHERE from_entity_key = ? AND to_entity_key = ? AND link_type = 'derives_from'",
              )
              .get(p.key, p.key)
            if (existing) {
              skip += 1
              continue
            }
            const now = new Date().toISOString()
            db.prepare(
              `INSERT INTO node_links (
                 id, project_path, from_entity_key, from_graph_id, from_graph_type, from_node_id,
                 to_entity_key, to_graph_id, to_graph_type, to_node_id,
                 link_type, direction, confidence, origin, status, created_at, updated_at
               ) VALUES (?, ?, ?, ?, 'dev', ?, ?, ?, 'online', ?, 'derives_from', 'directed', 1.0, 'import', 'active', ?, ?)`,
            ).run(
              `nl_${Date.now()}_${p.key.slice(0, 8)}_${Math.random().toString(36).slice(2, 6)}`,
              pairing.project_path,
              p.key,
              pairing.dev,
              p.dev_node_id,
              p.key,
              pairing.online,
              p.online_node_id,
              now,
              now,
            )
            ins += 1
          }
          return { inserted: ins, skipped: skip }
        })
        const r = run()
        inserted += r.inserted
        skipped += r.skipped
      }
      result = { inserted, skipped }
      return { stats: result }
    },
  })
  return result
}

export interface IntegrityCheckStats {
  checked: number
  orphans: number
  staled: number
}

/**
 * 巡检（§2.3.1 孤儿与失效）：幂等——只有状态真正变化才更新 updated_at。
 * 每轮写 map_migration_reports(kind='integrity_check', stage='node_links')。
 */
export function runLinkIntegrityCheck(db: BetterSqlite3.Database): IntegrityCheckStats {
  const links = db
    .prepare("SELECT * FROM node_links WHERE status = 'active'")
    .all() as NodeLinkRow[]
  const now = new Date().toISOString()
  let orphans = 0
  let staled = 0

  const resolveType = (graphId: string, key: string): GraphTypeValue | null => {
    const row = db
      .prepare('SELECT graph_type FROM nodes WHERE graph_id = ? AND entity_key = ?')
      .get(graphId, key) as { graph_type: GraphTypeValue } | undefined
    return row?.graph_type ?? null
  }

  const update = db.prepare('UPDATE node_links SET status = ?, updated_at = ?, reason = COALESCE(?, reason) WHERE id = ? AND status = ?')
  for (const link of links) {
    const fromType = resolveType(link.from_graph_id, link.from_entity_key)
    const toType = resolveType(link.to_graph_id, link.to_entity_key)
    if (fromType == null || toType == null) {
      // 任一端不可解析 → orphan（§2.4：只由巡检/删除路径写）
      const r = update.run('orphan', now, 'integrity_check: 端点不可解析', link.id, 'active')
      if (r.changes > 0) orphans += 1
      continue
    }
    if (!isLinkTypeAllowed(link.link_type as LinkType, fromType, toType)) {
      const r = update.run('stale', now, 'integrity_check: 不再满足 link_type 方向矩阵', link.id, 'active')
      if (r.changes > 0) staled += 1
    }
  }

  const stats: IntegrityCheckStats = { checked: links.length, orphans, staled }
  db.prepare(
    `INSERT INTO map_migration_reports
       (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, stats_json)
     VALUES (?, 'integrity_check', 'node_links', NULL, ?, ?, ?, 'ok', ?)`,
  ).run(
    `ic_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    now,
    now,
    process.pid,
    JSON.stringify(stats),
  )
  if (orphans > 0 || staled > 0) {
    logger.warn(`link integrity check: ${orphans} orphan(s), ${staled} stale(s) — marked, not deleted`)
  }
  return stats
}
