/**
 * S2 LinkService / 回填 / 巡检 真库回归（session-map 蓝图 §2.3.1）。
 *
 * 覆盖：方向矩阵（L5）/ 自链接与空键（L2）/ 跨项目拒绝（L1）/ 端点不可解析（L3）/
 * 唯一键幂等复用与 orphan 复活（L4）/ relates_to 字典序规范化 / 回填 derives_from
 * 幂等 / 巡检 orphan+stale 判定与幂等。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { LinkService, isLinkTypeAllowed } from '../map-migration/link-service'
import { runLinkBackfill, runLinkIntegrityCheck } from '../map-migration/link-backfill'

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
      parent_id TEXT, entity_key TEXT,
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
      UNIQUE(from_entity_key, to_entity_key, link_type)
    );
  `)
  return db
}

const NOW = '2026-01-01T00:00:00Z'
let seq = 0

function insertGraph(db: BetterSqlite3.Database, opts: { type: string; projectPath: string }): string {
  const id = `g-${++seq}`
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, `graph-${id}`, opts.type, opts.projectPath, NOW, NOW,
  )
  return id
}

function insertNode(db: BetterSqlite3.Database, opts: { graphId: string; title: string; entityKey: string }): string {
  const id = `n-${++seq}`
  // graph_type 从所属图派生——与生产 DDL 语义一致（节点级 graph_type 跟随图类型）
  const g = db.prepare('SELECT type FROM graphs WHERE id = ?').get(opts.graphId) as { type: string }
  db.prepare('INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, 'module', opts.title, opts.graphId, g.type, opts.entityKey, NOW, NOW,
  )
  return id
}

describe('isLinkTypeAllowed 方向矩阵（L5）', () => {
  it('derives_from/implements/verifies/covers 方向受限,其余任意', () => {
    expect(isLinkTypeAllowed('derives_from', 'dev', 'online')).toBe(true)
    expect(isLinkTypeAllowed('derives_from', 'test', 'online')).toBe(true)
    expect(isLinkTypeAllowed('derives_from', 'online', 'dev')).toBe(false)
    expect(isLinkTypeAllowed('implements', 'dev', 'online')).toBe(true)
    expect(isLinkTypeAllowed('implements', 'test', 'online')).toBe(false)
    expect(isLinkTypeAllowed('verifies', 'test', 'dev')).toBe(true)
    expect(isLinkTypeAllowed('verifies', 'dev', 'dev')).toBe(false)
    expect(isLinkTypeAllowed('covers', 'test', 'online')).toBe(true)
    expect(isLinkTypeAllowed('covers', 'dev', 'online')).toBe(false)
    expect(isLinkTypeAllowed('depends_on', 'online', 'dev')).toBe(true)
    expect(isLinkTypeAllowed('relates_to', 'dev', 'test')).toBe(true)
  })
})

describe('LinkService.create（L1-L6）', () => {
  let db: BetterSqlite3.Database
  let service: LinkService
  let online: string
  let dev: string
  const PROJECT = '/proj'

  beforeEach(() => {
    db = setupDb()
    seq = 0
    service = new LinkService(db)
    online = insertGraph(db, { type: 'online', projectPath: PROJECT })
    dev = insertGraph(db, { type: 'dev', projectPath: PROJECT })
  })

  it('创建 derives_from：两端解析、矩阵通过 → created；重复创建 → reused（幂等）', async () => {
    insertNode(db, { graphId: dev, title: 'd1', entityKey: 'k-dev-1' })
    insertNode(db, { graphId: online, title: 'o1', entityKey: 'k-online-1' })
    const first = await service.create({
      projectPath: PROJECT, linkType: 'derives_from',
      fromEntityKey: 'k-dev-1', fromGraphId: dev,
      toEntityKey: 'k-online-1', toGraphId: online,
      origin: 'human',
    })
    expect(first.outcome).toBe('created')
    expect(first.row.from_graph_type).toBe('dev')
    expect(first.row.direction).toBe('directed')

    const second = await service.create({
      projectPath: PROJECT, linkType: 'derives_from',
      fromEntityKey: 'k-dev-1', fromGraphId: dev,
      toEntityKey: 'k-online-1', toGraphId: online,
      origin: 'human',
    })
    expect(second.outcome).toBe('reused')
    expect(second.row.id).toBe(first.row.id)
    expect((db.prepare('SELECT COUNT(*) AS c FROM node_links').get() as { c: number }).c).toBe(1)
  })

  it('relates_to：端点按字典序规范化,symmetric 方向,反向创建复用同一行（L4）', async () => {
    insertNode(db, { graphId: dev, title: 'b', entityKey: 'k-b' })
    insertNode(db, { graphId: online, title: 'a', entityKey: 'k-a' })
    const a = await service.create({
      projectPath: PROJECT, linkType: 'relates_to',
      fromEntityKey: 'k-b', fromGraphId: dev,
      toEntityKey: 'k-a', toGraphId: online,
      origin: 'human',
    })
    const b = await service.create({
      projectPath: PROJECT, linkType: 'relates_to',
      fromEntityKey: 'k-a', fromGraphId: online,
      toEntityKey: 'k-b', toGraphId: dev,
      origin: 'human',
    })
    expect(b.outcome).toBe('reused')
    expect(b.row.id).toBe(a.row.id)
    expect(a.row.direction).toBe('symmetric')
  })

  it('orphan/stale 行经再次创建复活为 active（L4）', async () => {
    insertNode(db, { graphId: dev, title: 'n1', entityKey: 'k1' })
    insertNode(db, { graphId: online, title: 'n2', entityKey: 'k2' })
    const { outcome, row } = await service.create({
      projectPath: PROJECT, linkType: 'derives_from',
      fromEntityKey: 'k1', fromGraphId: dev,
      toEntityKey: 'k2', toGraphId: online,
      origin: 'import',
    })
    db.prepare("UPDATE node_links SET status = 'orphan' WHERE id = ?").run(row.id)
    const revived = await service.create({
      projectPath: PROJECT, linkType: 'derives_from',
      fromEntityKey: 'k1', fromGraphId: dev,
      toEntityKey: 'k2', toGraphId: online,
      origin: 'import',
    })
    expect(outcome).toBe('created')
    expect(revived.outcome).toBe('revived')
    expect((db.prepare('SELECT status FROM node_links WHERE id = ?').get(row.id) as { status: string }).status).toBe('active')
  })

  it('L2：空键/自链接拒绝', async () => {
    await expect(service.create({
      projectPath: PROJECT, linkType: 'relates_to',
      fromEntityKey: '', fromGraphId: dev, toEntityKey: 'k', toGraphId: online, origin: 'human',
    })).rejects.toMatchObject({ code: 'empty_key' })
    await expect(service.create({
      projectPath: PROJECT, linkType: 'relates_to',
      fromEntityKey: 'k1', fromGraphId: dev, toEntityKey: 'k1', toGraphId: dev, origin: 'human',
    })).rejects.toMatchObject({ code: 'self_link' })
  })

  it('L1：跨项目链接拒绝', async () => {
    const otherGraph = insertGraph(db, { type: 'dev', projectPath: '/other' })
    insertNode(db, { graphId: dev, title: 'd', entityKey: 'k1' })
    insertNode(db, { graphId: otherGraph, title: 'x', entityKey: 'k2' })
    await expect(service.create({
      projectPath: PROJECT, linkType: 'derives_from',
      fromEntityKey: 'k1', fromGraphId: dev, toEntityKey: 'k2', toGraphId: otherGraph, origin: 'human',
    })).rejects.toMatchObject({ code: 'cross_project' })
  })

  it('L3：端点在 nodes 不可解析 → 拒绝', async () => {
    await expect(service.create({
      projectPath: PROJECT, linkType: 'derives_from',
      fromEntityKey: 'k-missing', fromGraphId: dev,
      toEntityKey: 'k2', toGraphId: online,
      origin: 'human',
    })).rejects.toMatchObject({ code: 'end_unresolvable' })
  })

  it('L5：矩阵违规拒绝（online→dev 的 derives_from）', async () => {
    const kO = 'k-online-x'
    const kD = 'k-dev-x'
    insertNode(db, { graphId: online, title: 'o', entityKey: kO })
    insertNode(db, { graphId: dev, title: 'd', entityKey: kD })
    // from=online(有节点的图) → 该端 graph_type=online → online→dev 违规
    await expect(service.create({
      projectPath: PROJECT, linkType: 'derives_from',
      fromEntityKey: kO, fromGraphId: online,
      toEntityKey: kD, toGraphId: dev,
      origin: 'human',
    })).rejects.toMatchObject({ code: 'matrix_violation' })
  })
})

describe('S2 回填 + 巡检', () => {
  let db: BetterSqlite3.Database
  let online: string
  let dev: string

  beforeEach(() => {
    db = setupDb()
    seq = 0
    online = insertGraph(db, { type: 'online', projectPath: '/p' })
    dev = insertGraph(db, { type: 'dev', projectPath: '/p' })
  })

  it('回填：共享键节点 → derives_from(from=dev,to=online,import)；幂等', () => {
    insertNode(db, { graphId: online, title: '登录', entityKey: 'shared-1' })
    insertNode(db, { graphId: dev, title: '登录', entityKey: 'shared-1' })
    insertNode(db, { graphId: online, title: '仅线上', entityKey: 'only-online' })

    const r1 = runLinkBackfill(db, 27)
    expect(r1.inserted).toBe(1)
    const row = db.prepare("SELECT * FROM node_links WHERE link_type='derives_from'").get() as Record<string, unknown>
    expect(row.from_graph_type).toBe('dev')
    expect(row.to_graph_type).toBe('online')
    expect(row.origin).toBe('import')
    const report = db.prepare("SELECT * FROM map_migration_reports WHERE kind='link_backfill'").get() as Record<string, unknown>
    expect(report.status).toBe('ok')

    const r2 = runLinkBackfill(db, 27)
    expect(r2.inserted).toBe(0)
    expect(r2.skipped).toBe(1)
  })

  it('巡检：端点被删 → active 置 orphan；矩阵不再满足 → stale；幂等', () => {
    // 直接造一条孤儿链接：from 端节点不存在
    db.prepare(
      `INSERT INTO node_links (
         id, project_path, from_entity_key, from_graph_id, from_graph_type,
         to_entity_key, to_graph_id, to_graph_type, link_type, direction, origin, status, created_at, updated_at
       ) VALUES ('nl-x', '/p', 'ghost', ?, 'dev', 'k2', ?, 'online', 'derives_from', 'directed', 'import', 'active', ?, ?)`,
    ).run(dev, online, NOW, NOW)
    // 一条将因矩阵失配而 stale 的：两端可解析（dev 图内节点）但 verifies 要求 test→dev
    insertNode(db, { graphId: dev, title: 't3', entityKey: 'k3' })
    insertNode(db, { graphId: dev, title: 't4', entityKey: 'k4' })
    db.prepare(
      `INSERT INTO node_links (
         id, project_path, from_entity_key, from_graph_id, from_graph_type,
         to_entity_key, to_graph_id, to_graph_type, link_type, direction, origin, status, created_at, updated_at
       ) VALUES ('nl-y', '/p', 'k3', ?, 'dev', 'k4', ?, 'dev', 'verifies', 'directed', 'import', 'active', ?, ?)`,
    ).run(dev, dev, NOW, NOW)

    const stats = runLinkIntegrityCheck(db)
    expect(stats.checked).toBe(2)
    expect(stats.orphans).toBe(1)
    expect(stats.staled).toBe(1)
    expect((db.prepare("SELECT status FROM node_links WHERE id='nl-x'").get() as { status: string }).status).toBe('orphan')
    expect((db.prepare("SELECT status FROM node_links WHERE id='nl-y'").get() as { status: string }).status).toBe('stale')

    // 幂等：非 active 不再重扫
    const stats2 = runLinkIntegrityCheck(db)
    expect(stats2.checked).toBe(0)
    expect(stats2.orphans).toBe(0)
  })
})
