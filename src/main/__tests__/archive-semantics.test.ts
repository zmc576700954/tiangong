/**
 * S3 归档语义真库回归（session-map 蓝图 §2.4 / §8.5）。
 *
 * 覆盖:有历史节点删除 → 归档(行/边保留,links active);无依赖 → 硬删
 * (子节点置根);图删除前置校验(running run/未完成 work_item 拒);
 * 允许删图 → 相关 links 标 orphan + 证据标 stale(不物理删除)。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { NodeRepository } from '../repositories/node-repository'
import { GraphRepository } from '../repositories/graph-repository'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  const now = '2026-01-01T00:00:00Z'
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      project_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      graph_id TEXT NOT NULL, graph_type TEXT NOT NULL, lifecycle_state TEXT NOT NULL DEFAULT 'active',
      parent_id TEXT, entity_key TEXT,
      position_x REAL NOT NULL, position_y REAL NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      graph_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE bug_nodes (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL);
    CREATE TABLE writeback_items (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, status TEXT);
    CREATE TABLE snapshots (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL);
    CREATE TABLE agent_logs (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL);
    CREATE TABLE node_links (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL,
      from_entity_key TEXT NOT NULL, from_graph_id TEXT NOT NULL, from_graph_type TEXT NOT NULL,
      from_node_id TEXT,
      to_entity_key TEXT NOT NULL, to_graph_id TEXT NOT NULL, to_graph_type TEXT NOT NULL,
      to_node_id TEXT,
      link_type TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'directed',
      origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE node_evidence (
      id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, graph_type TEXT NOT NULL,
      node_entity_key TEXT NOT NULL, node_id TEXT, evidence_level TEXT NOT NULL, evidence_type TEXT NOT NULL,
      ref_json TEXT NOT NULL, freshness TEXT NOT NULL DEFAULT 'fresh', produced_by TEXT NOT NULL,
      created_at TEXT NOT NULL, stale_at TEXT, revoked_at TEXT
    );
    CREATE TABLE node_session_links (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, graph_id TEXT NOT NULL,
      node_id TEXT, thread_id TEXT NOT NULL, link_role TEXT NOT NULL,
      session_origin TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      is_current INTEGER NOT NULL DEFAULT 1, graph_id TEXT NOT NULL,
      anchor_node_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
      gate_status TEXT NOT NULL DEFAULT 'incomplete', origin TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE work_runs (
      id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, run_seq INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT NOT NULL,
      executor_kind TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('g1', '图', 'dev', '/p', now, now)
  return db
}

function insertNode(db: BetterSqlite3.Database, opts: { id: string; parentId?: string }): void {
  const now = '2026-01-01T00:00:00Z'
  db.prepare(
    'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(opts.id, 'feature', 'draft', `节点${opts.id}`, 'g1', 'dev', opts.parentId ?? null, 0, 0, now, now)
}

describe('S3 节点删除:归档语义（§2.4）', () => {
  let db: BetterSqlite3.Database
  let repo: NodeRepository

  beforeEach(() => {
    db = setupDb()
    repo = new NodeRepository(db)
  })

  it('有链接历史 → 归档:行保留、lifecycle_state=archived、边保留', () => {
    insertNode(db, { id: 'n1' })
    const now = '2026-01-01T00:00:00Z'
    db.prepare(
      `INSERT INTO node_links (id, project_path, from_entity_key, from_graph_id, from_graph_type,
         to_entity_key, to_graph_id, to_graph_type, link_type, origin, created_at, updated_at)
       VALUES ('nl1', '/p', 'k1', 'g1', 'dev', 'k2', 'g2', 'online', 'derives_from', 'import', ?, ?)`,
    ).run(now, now)
    db.prepare('UPDATE node_links SET from_node_id = ? WHERE id = ?').run('n1', 'nl1')
    db.prepare("INSERT INTO edges (id, source, target, graph_id, created_at, updated_at) VALUES ('e1', 'n1', 'n1', 'g1', ?, ?)").run(now, now)

    repo.delete('n1')

    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n1') as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row.lifecycle_state).toBe('archived')
    // 边保留（归档不级联）
    expect(db.prepare('SELECT COUNT(*) AS c FROM edges').get()).toMatchObject({ c: 1 })
    // 链接保持 active（仍可解析）
    expect((db.prepare("SELECT status FROM node_links WHERE id = 'nl1'").get() as { status: string }).status).toBe('active')
  })

  it('有 work_item 锚定 → 归档;有会话挂载 → 归档;有证据 → 归档', () => {
    for (const [id, table, sql] of [
      ['n-wi', 'work_items', "INSERT INTO work_items (id, lineage_id, graph_id, anchor_node_id, title, status, origin, created_at, updated_at) VALUES ('wi1', 'wl1', 'g1', 'n-wi', 't', 'queued', 'human', 'x', 'x')"],
      ['n-ss', 'node_session_links', "INSERT INTO node_session_links (id, project_path, graph_id, node_id, thread_id, link_role, session_origin, created_at) VALUES ('ss1', '/p', 'g1', 'n-ss', 'th1', 'primary', 'manual_panel', 0)"],
      ['n-ev', 'node_evidence', "INSERT INTO node_evidence (id, graph_id, graph_type, node_entity_key, node_id, evidence_level, evidence_type, ref_json, produced_by, created_at) VALUES ('ev1', 'g1', 'dev', 'k', 'n-ev', 'E1', 'session_turn', '{}', 'human', 'x')"],
    ] as const) {
      db = setupDb()
      repo = new NodeRepository(db)
      insertNode(db, { id })
      db.exec(sql)
      repo.delete(id)
      expect((db.prepare('SELECT lifecycle_state FROM nodes WHERE id = ?').get(id) as { lifecycle_state: string }).lifecycle_state).toBe('archived')
      void table
    }
  })

  it('无依赖 → 硬删:行没了、子节点置根、边级联', () => {
    insertNode(db, { id: 'parent' })
    insertNode(db, { id: 'child', parentId: 'parent' })
    const now = '2026-01-01T00:00:00Z'
    db.prepare("INSERT INTO edges (id, source, target, graph_id, created_at, updated_at) VALUES ('e1', 'parent', 'child', 'g1', ?, ?)").run(now, now)

    repo.delete('parent')

    expect(db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE id = ?').get('parent')).toMatchObject({ c: 0 })
    // 子节点置根
    expect((db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get('child') as { parent_id: string | null }).parent_id).toBeNull()
    // FK 级联删边
    expect(db.prepare('SELECT COUNT(*) AS c FROM edges').get()).toMatchObject({ c: 0 })
  })

  it('已归档再删保持 archived（幂等,不转硬删）', () => {
    insertNode(db, { id: 'n1' })
    db.prepare("UPDATE nodes SET lifecycle_state = 'archived' WHERE id = 'n1'").run()
    repo.delete('n1')
    expect((db.prepare('SELECT lifecycle_state FROM nodes WHERE id = ?').get('n1') as { lifecycle_state: string }).lifecycle_state).toBe('archived')
  })
})

describe('S3 图删除:前置校验 + orphan/stale（§2.4）', () => {
  let db: BetterSqlite3.Database
  let repo: GraphRepository

  beforeEach(() => {
    db = setupDb()
    repo = new GraphRepository(db)
  })

  it('未完成 work_item → 拒绝', () => {
    db.exec("INSERT INTO work_items (id, lineage_id, graph_id, title, status, origin, created_at, updated_at) VALUES ('wi1', 'wl1', 'g1', 't', 'queued', 'human', 'x', 'x')")
    expect(() => repo.delete('g1')).toThrow(/未完成 work_item/)
    expect(db.prepare('SELECT COUNT(*) AS c FROM graphs').get()).toMatchObject({ c: 1 })
  })

  it('running work_run → 拒绝', () => {
    db.exec("INSERT INTO work_items (id, lineage_id, graph_id, title, status, origin, created_at, updated_at) VALUES ('wi1', 'wl1', 'g1', 't', 'done', 'human', 'x', 'x')")
    db.prepare("INSERT INTO work_runs (id, work_item_id, run_seq, attempt, idempotency_key, executor_kind, status, created_at) VALUES ('wr1', 'wi1', 1, 1, 'k1', 'agent', 'running', 0)").run()
    expect(() => repo.delete('g1')).toThrow(/未完结 work_run/)
  })

  it('无任务 → 允许删:相关 links 标 orphan、证据标 stale、行全清', () => {
    insertNode(db, { id: 'n1' })
    const now = '2026-01-01T00:00:00Z'
    db.prepare(
      `INSERT INTO node_links (id, project_path, from_entity_key, from_graph_id, from_graph_type,
         to_entity_key, to_graph_id, to_graph_type, link_type, origin, created_at, updated_at)
       VALUES ('nl1', '/p', 'k1', 'g1', 'dev', 'k2', 'g2', 'online', 'derives_from', 'import', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO node_evidence (id, graph_id, graph_type, node_entity_key, evidence_level, evidence_type, ref_json, produced_by, created_at)
       VALUES ('ev1', 'g1', 'dev', 'k1', 'E2', 'changed_files', '{}', 'system', 'x')`,
    ).run()

    repo.delete('g1')

    // 图与节点全清
    expect(db.prepare('SELECT COUNT(*) AS c FROM graphs').get()).toMatchObject({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM nodes').get()).toMatchObject({ c: 0 })
    // 链接标 orphan 不删除
    expect((db.prepare("SELECT status FROM node_links WHERE id = 'nl1'").get() as { status: string }).status).toBe('orphan')
    // 证据标 stale 不物理删除
    const ev = db.prepare('SELECT * FROM node_evidence WHERE id = ?').get('ev1') as Record<string, unknown>
    expect(ev.freshness).toBe('stale')
    expect(ev.stale_at).toBeTruthy()
  })
})
