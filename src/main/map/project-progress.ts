/**
 * G5-10 项目进度查询（session-map 蓝图 II-25）。
 *
 * 只读：查询 `v_project_progress`（v47），不做缓存、不触发派生重算。
 * 项目不存在时返回 null，由调用方标注 `available=false`，不阻塞其它查询。
 */

import type BetterSqlite3 from 'better-sqlite3'

export interface ProjectProgress {
  projectPath: string
  nodesTotal: number
  nodesVerified: number
  itemsDone: number
  itemsFailed: number
  /** 证据分级计数（E1–E4 键可能缺省；未知级别按原样保留）。 */
  evidenceByLevel: Record<string, number>
}

interface ProgressRow {
  project_path: string
  nodes_total: number
  nodes_verified: number
  items_done: number
  items_failed: number
  evidence_by_level_json: string | null
}

function parseEvidenceLevels(raw: string | null): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

export function getProjectProgress(
  db: BetterSqlite3.Database,
  projectPath: string,
): ProjectProgress | null {
  if (!projectPath) return null
  const row = db
    .prepare(
      `SELECT project_path, nodes_total, nodes_verified, items_done, items_failed,
              evidence_by_level_json
         FROM v_project_progress
        WHERE project_path = ?`,
    )
    .get(projectPath) as ProgressRow | undefined
  if (!row) return null
  return {
    projectPath: row.project_path,
    nodesTotal: row.nodes_total,
    nodesVerified: row.nodes_verified,
    itemsDone: row.items_done,
    itemsFailed: row.items_failed,
    evidenceByLevel: parseEvidenceLevels(row.evidence_by_level_json),
  }
}
