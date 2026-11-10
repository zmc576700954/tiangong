/**
 * G5-10 项目进度查询（蓝图 II-25 验收）。
 *
 * 覆盖：按项目聚合节点总数/已验证节点/任务完成与失败/证据分级；
 * 任务缺 project_path 时回退图；非当前版本任务不计入；撤销证据不计入；
 * 未知项目返回 null（调用方标注 available=false）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapS6aSchema, applyMapViews } from '../map/schema'
import { getProjectProgress } from '../map/project-progress'

const NOW = '2026-11-10T08:00:00.000Z'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  applyMapS6aSchema(db)
  // base 表由 database.ts 主 schema 创建；视图测试只需要被引用的列为最小集。
  db.exec(`
    CREATE TABLE graphs (id TEXT PRIMARY KEY, project_path TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL);
  `)
  applyMapViews(db)
  return db
}

function seedGraph(db: BetterSqlite3.Database, id: string, projectPath: string | null): void {
  db.prepare('INSERT INTO graphs (id, project_path) VALUES (?, ?)').run(id, projectPath)
}

function seedNode(db: BetterSqlite3.Database, id: string, graphId: string): void {
  db.prepare('INSERT INTO nodes (id, graph_id) VALUES (?, ?)').run(id, graphId)
}

function seedState(
  db: BetterSqlite3.Database,
  graphId: string,
  entityKey: string,
  level: string,
): void {
  db.prepare(
    `INSERT INTO node_execution_state
       (graph_id, node_entity_key, execution_state, evidence_level, evidence_count, stale_count,
        derivation_version, computed_at)
     VALUES (?, ?, 'verified', ?, 1, 0, 1, 0)`,
  ).run(graphId, entityKey, level)
}

interface ItemSeed {
  id: string
  projectPath: string | null
  graphId: string
  status: string
  isCurrent?: number
}

function seedItem(db: BetterSqlite3.Database, seed: ItemSeed): void {
  db.prepare(
    `INSERT INTO work_items
       (id, lineage_id, revision, is_current, project_path, graph_id, title, status,
        gate_status, origin, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, 'T', ?, 'incomplete', 'human', ?, ?)`,
  ).run(
    seed.id,
    `lin_${seed.id}`,
    seed.isCurrent ?? 1,
    seed.projectPath,
    seed.graphId,
    seed.status,
    NOW,
    NOW,
  )
}

interface EvidenceSeed {
  id: string
  projectPath: string | null
  graphId: string
  level: string
  revokedAt?: string | null
}

function seedEvidence(db: BetterSqlite3.Database, seed: EvidenceSeed): void {
  db.prepare(
    `INSERT INTO node_evidence
       (id, project_path, graph_id, graph_type, node_entity_key, evidence_level,
        evidence_type, ref_json, produced_by, created_at, revoked_at)
     VALUES (?, ?, ?, 'dev', 'k1', ?, 'session_turn', '{}', 'agent', ?, ?)`,
  ).run(seed.id, seed.projectPath, seed.graphId, seed.level, NOW, seed.revokedAt ?? null)
}

describe('getProjectProgress', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
    seedGraph(db, 'g1', '/repo/a')
    seedGraph(db, 'g2', '/repo/b')
    seedNode(db, 'n1', 'g1')
    seedNode(db, 'n2', 'g1')
    seedNode(db, 'n3', 'g1')
    seedNode(db, 'n4', 'g2')

    seedState(db, 'g1', 'k1', 'E2')
    seedState(db, 'g1', 'k2', 'E4')
    seedState(db, 'g1', 'k3', 'E1')
    seedState(db, 'g2', 'k4', 'E3')

    seedItem(db, { id: 'w1', projectPath: '/repo/a', graphId: 'g1', status: 'done' })
    seedItem(db, { id: 'w2', projectPath: '/repo/a', graphId: 'g1', status: 'failed' })
    // 缺 project_path → 回退图的 /repo/a。
    seedItem(db, { id: 'w3', projectPath: null, graphId: 'g1', status: 'done' })
    // 非当前版本不计入。
    seedItem(db, { id: 'w4', projectPath: '/repo/a', graphId: 'g1', status: 'done', isCurrent: 0 })
    seedItem(db, { id: 'w5', projectPath: '/repo/a', graphId: 'g1', status: 'running' })

    seedEvidence(db, { id: 'e1', projectPath: '/repo/a', graphId: 'g1', level: 'E2' })
    seedEvidence(db, { id: 'e2', projectPath: null, graphId: 'g1', level: 'E2' })
    seedEvidence(db, {
      id: 'e3',
      projectPath: '/repo/a',
      graphId: 'g1',
      level: 'E2',
      revokedAt: NOW,
    })
  })

  it('按项目聚合节点、任务与证据分级', () => {
    const progress = getProjectProgress(db, '/repo/a')
    expect(progress).toEqual({
      projectPath: '/repo/a',
      nodesTotal: 3,
      nodesVerified: 2,
      itemsDone: 2,
      itemsFailed: 1,
      evidenceByLevel: { E2: 2 },
    })
  })

  it('按项目隔离，不串到其它项目', () => {
    const other = getProjectProgress(db, '/repo/b')
    expect(other).toEqual({
      projectPath: '/repo/b',
      nodesTotal: 1,
      nodesVerified: 1,
      itemsDone: 0,
      itemsFailed: 0,
      evidenceByLevel: {},
    })
  })

  it('未知项目返回 null（调用方标注 available=false）', () => {
    expect(getProjectProgress(db, '/repo/missing')).toBeNull()
    expect(getProjectProgress(db, '')).toBeNull()
  })
})
