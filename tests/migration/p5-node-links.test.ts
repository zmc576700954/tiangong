/**
 * P5 — `node_links` 完整性（session-map 蓝图 §8.11 / §2.4）。
 *
 * 断言：
 *   - 删除节点 / 删除图 → 巡检把链接标 `orphan`（软删，行不物理消失）；
 *   - 拆分（`split_from`）/ 合并（`merged_into`）→ 旧链接可追溯、新链接可解析；
 *   - 重复创建同一条链接 → `reused`，唯一键拦截第二行；
 *   - 孤儿扫描误报 0（有效链接保持 `active`）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { LinkService } from '../../src/main/map-migration/link-service'
import { runLinkIntegrityCheck } from '../../src/main/map-migration/link-backfill'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      project_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
      graph_id TEXT NOT NULL, graph_type TEXT NOT NULL,
      parent_id TEXT, entity_key TEXT, lifecycle_state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
      status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
    );
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
      direction       TEXT NOT NULL DEFAULT 'directed' CHECK(direction IN ('directed','symmetric')),
      confidence      REAL NOT NULL DEFAULT 1.0,
      origin          TEXT NOT NULL CHECK(origin IN ('human','derived','import')),
      status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','stale','orphan')),
      reason          TEXT,
      metadata        TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(from_graph_id, to_graph_id, from_entity_key, to_entity_key, link_type)
    );
  `)
  return db
}

const NOW = '2026-01-01T00:00:00Z'
let seq = 0

function insertGraph(db: BetterSqlite3.Database, type: string, projectPath: string): string {
  const id = `g-${++seq}`
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, `graph-${id}`, type, projectPath, NOW, NOW,
  )
  return id
}

function insertNode(db: BetterSqlite3.Database, graphId: string, key: string, type = 'online'): string {
  const id = `n-${++seq}`
  db.prepare(
    'INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'module', key, graphId, type, key, NOW, NOW)
  return id
}

describe('P5 node_links 完整性', () => {
  const PROJECT = '/proj'
  let db: BetterSqlite3.Database
  let service: LinkService
  let g: string

  beforeEach(() => {
    db = setupDb()
    seq = 0
    service = new LinkService(db)
    g = insertGraph(db, 'online', PROJECT)
  })

  it('重复创建同一条链接 → reused，唯一键不产生第二行；有效链接孤儿扫描误报 0', async () => {
    insertNode(db, g, 'k-a')
    insertNode(db, g, 'k-b')
    const input = {
      projectPath: PROJECT, linkType: 'depends_on' as const,
      fromEntityKey: 'k-a', fromGraphId: g,
      toEntityKey: 'k-b', toGraphId: g,
      origin: 'human' as const,
    }
    const first = await service.create(input)
    const second = await service.create(input)
    expect(first.outcome).toBe('created')
    expect(second.outcome).toBe('reused')
    expect((db.prepare('SELECT COUNT(*) AS c FROM node_links').get() as { c: number }).c).toBe(1)
    expect(runLinkIntegrityCheck(db)).toMatchObject({ checked: 1, orphans: 0, staled: 0 })
  })

  it('删除节点 → 链接软删为 orphan，行仍可追溯', async () => {
    const a = insertNode(db, g, 'k-a')
    insertNode(db, g, 'k-b')
    await service.create({
      projectPath: PROJECT, linkType: 'depends_on',
      fromEntityKey: 'k-a', fromGraphId: g, toEntityKey: 'k-b', toGraphId: g, origin: 'human',
    })
    db.prepare('DELETE FROM nodes WHERE id = ?').run(a)

    const stats = runLinkIntegrityCheck(db)
    expect(stats.orphans).toBe(1)
    const row = db.prepare('SELECT status FROM node_links').get() as { status: string }
    expect(row.status).toBe('orphan')
    // 软删：行保留，可按键反查（生产 listByEntityKey 只列 active）
    expect((db.prepare("SELECT COUNT(*) AS c FROM node_links WHERE status='orphan'").get() as { c: number }).c).toBe(1)
  })

  it('删除图（连带节点）→ 链接软删为 orphan', async () => {
    const g2 = insertGraph(db, 'dev', PROJECT)
    insertNode(db, g, 'k-online')
    insertNode(db, g2, 'k-dev', 'dev')
    await service.create({
      projectPath: PROJECT, linkType: 'implements',
      fromEntityKey: 'k-dev', fromGraphId: g2, toEntityKey: 'k-online', toGraphId: g, origin: 'derived',
    })
    db.prepare('DELETE FROM nodes WHERE graph_id = ?').run(g)
    db.prepare('DELETE FROM graphs WHERE id = ?').run(g)

    expect(runLinkIntegrityCheck(db).orphans).toBe(1)
    expect((db.prepare('SELECT status FROM node_links').get() as { status: string }).status).toBe('orphan')
  })

  it('拆分/合并后旧链接仍可追溯、新链接可解析', async () => {
    insertNode(db, g, 'k-old')
    insertNode(db, g, 'k-split')
    insertNode(db, g, 'k-merged')
    await service.create({
      projectPath: PROJECT, linkType: 'split_from',
      fromEntityKey: 'k-split', fromGraphId: g, toEntityKey: 'k-old', toGraphId: g, origin: 'human',
    })
    await service.create({
      projectPath: PROJECT, linkType: 'merged_into',
      fromEntityKey: 'k-old', fromGraphId: g, toEntityKey: 'k-merged', toGraphId: g, origin: 'human',
    })

    // 归档旧节点不删除链接：仍可按键追溯
    db.prepare("UPDATE nodes SET lifecycle_state = 'archived' WHERE entity_key = 'k-old'").run()
    // 新键仍可作为端点解析
    const again = await service.create({
      projectPath: PROJECT, linkType: 'relates_to',
      fromEntityKey: 'k-split', fromGraphId: g, toEntityKey: 'k-merged', toGraphId: g, origin: 'human',
    })
    expect(again.outcome).toBe('created')
    expect(service.listByEntityKey(PROJECT, 'k-old').length).toBeGreaterThanOrEqual(1)
    expect(runLinkIntegrityCheck(db).orphans).toBe(0)
  })
})
