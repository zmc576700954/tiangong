/**
 * S4 不可迁移彩排（§8.6）——常驻回归:
 * 构造 v32 形态的库（旧 CHECK 值域 + S1-S6a/S3 全部列）→ initDatabase 走
 * v32→33 慢路径（三表重建）→ 断言 §8.6 校验项:行数/entity_key 保留/
 * writeback_disabled 保留/共有列内容一致/lifecycle 保留/新值域生效。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import BetterSqlite3 from 'better-sqlite3'

const electronPaths = vi.hoisted(() => ({ userData: '' }))
const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-s4-' + process.pid)
electronPaths.userData = TEST_USER_DATA

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? electronPaths.userData : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../database'
import { captureS4Baseline, verifyS4PostRebuild } from '../map-migration/s4-verify'

/** S4 校验报告表（与正式 schema 同列集；降级用例直接用内存库）。 */
const REPORT_DDL = `
  CREATE TABLE map_migration_reports (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
    started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
    status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
  );
`

const dbPath = path.join(TEST_USER_DATA, 'data', 'bizgraph.db')

/** v32 形态的三表 DDL（S4 之前的 CHECK 值域;含 S1/S3 已有列）。 */
const PRE_V33 = `
  CREATE TABLE graphs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('online', 'dev')),
    lifecycle_state TEXT NOT NULL DEFAULT 'active'
      CHECK(lifecycle_state IN ('active','archived','merged','split')),
    project_path TEXT,
    writeback_disabled INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('project','module','process','feature','bug','wiki-page')),
    status TEXT NOT NULL CHECK(status IN ('draft','confirmed','developing','testing','review','published','placeholder')),
    title TEXT NOT NULL,
    description TEXT,
    acceptance_criteria TEXT,
    graph_id TEXT NOT NULL,
    graph_type TEXT NOT NULL CHECK(graph_type IN ('online','dev')),
    entity_key TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'active'
      CHECK(lifecycle_state IN ('active','archived','merged','split')),
    parent_id TEXT,
    sort_index INTEGER,
    collapsed INTEGER NOT NULL DEFAULT 0,
    rules TEXT,
    metadata TEXT,
    owner_role TEXT,
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    content TEXT,
    community_summary TEXT,
    community_level INTEGER,
    community_id TEXT,
    context_refs TEXT,
    wiki_content TEXT,
    wiki_meta TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE edges (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    label TEXT,
    edge_type TEXT CHECK(edge_type IN ('default','success','failure','condition','business-flow','semantic','dependency','co-change','wiki-link','hierarchical')),
    graph_id TEXT NOT NULL,
    content TEXT,
    description TEXT,
    data_flow TEXT,
    strength REAL,
    updated_at TEXT
  );
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE map_migration_reports (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
    started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
    status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
  );
`

describe('S4 CHECK 值域扩展——v32→v33 重建彩排（§8.6）', () => {
  beforeAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    fs.mkdirSync(path.join(TEST_USER_DATA, 'data'), { recursive: true })

    const db = new BetterSqlite3(dbPath)
    db.exec(PRE_V33)
    const now = '2026-01-01T00:00:00Z'
    // 种子:两张图（其一 writeback_disabled=1）+ 三节点（其一 archived,全带 entity_key）+ 两边
    db.prepare('INSERT INTO graphs (id, name, type, project_path, writeback_disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('g-online', '产品蓝图', 'online', '/p', 1, now, now)
    db.prepare('INSERT INTO graphs (id, name, type, project_path, writeback_disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('g-dev', '开发场景', 'dev', '/p', 0, now, now)
    const insNode = db.prepare('INSERT INTO nodes (id, type, status, title, graph_id, graph_type, entity_key, lifecycle_state, parent_id, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insNode.run('n1', 'module', 'confirmed', '登录模块', 'g-online', 'online', 'ek-1', 'active', null, 0, 0, now, now)
    insNode.run('n2', 'feature', 'draft', '登录功能', 'g-dev', 'dev', 'ek-2', 'active', null, 0, 20, now, now)
    insNode.run('n3', 'feature', 'published', '旧功能', 'g-online', 'online', 'ek-3', 'archived', null, 0, 40, now, now)
    const insEdge = db.prepare('INSERT INTO edges (id, source, target, edge_type, graph_id, content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insEdge.run('e1', 'n1', 'n2', 'dependency', 'g-dev', JSON.stringify({ note: '依赖' }), now)
    insEdge.run('e2', 'n1', 'n3', 'hierarchical', 'g-online', null, now)
    db.prepare('INSERT INTO schema_version (version) VALUES (32)').run()
    db.close()

    initDatabase()
  })

  afterAll(() => {
    closeDatabase()
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
  })

  it('重建后行数/entity_key/writeback_disabled 全部保留', () => {
    const db = getClient()
    expect((db.prepare('SELECT COUNT(*) AS c FROM graphs').get() as { c: number }).c).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c).toBe(3)
    expect((db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE entity_key IS NOT NULL').get() as { c: number }).c).toBe(3)
    expect((db.prepare('SELECT writeback_disabled FROM graphs WHERE id = ?').get('g-online') as { writeback_disabled: number }).writeback_disabled).toBe(1)
  })

  it('共有列内容一致:JSON 列/标题/生命周期原样', () => {
    const db = getClient()
    const edge = db.prepare('SELECT * FROM edges WHERE id = ?').get('e1') as Record<string, unknown>
    expect(JSON.parse(edge.content as string)).toEqual({ note: '依赖' })
    expect(edge.edge_type).toBe('dependency')
    const n3 = db.prepare('SELECT lifecycle_state, status FROM nodes WHERE id = ?').get('n3') as Record<string, unknown>
    expect(n3.lifecycle_state).toBe('archived')
    expect(n3.status).toBe('published')
  })

  it('新值域生效:test 图/test 节点/verifies 边可写入', () => {
    const db = getClient()
    const now = '2026-01-01T00:00:00Z'
    db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('g-test', '测试场景', 'test', '/p', now, now)
    db.prepare('INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('n-t', 'test-suite', 'draft', '登录套件', 'g-test', 'test', 0, 0, now, now)
    db.prepare('INSERT INTO edges (id, source, target, edge_type, graph_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('e-v', 'n-t', 'n2', 'verifies', 'g-test', now)
    expect(db.prepare('SELECT COUNT(*) AS c FROM graphs WHERE type = ?').get('test')).toMatchObject({ c: 1 })
  })

  it('S4 校验报告:stage=S4.rebuild 且 ok', () => {
    const db = getClient()
    const report = db
      .prepare("SELECT * FROM map_migration_reports WHERE stage = 'S4.rebuild' ORDER BY started_at DESC LIMIT 1")
      .get() as Record<string, unknown>
    expect(report.status).toBe('ok')
    const stats = JSON.parse(report.stats_json as string)
    expect(stats.match).toBe(true)
    expect(stats.mode).toBe('full')
  })
})

describe('S4 降级基线——极老库缺列（§8.6）', () => {
  /** v17 形态：三表都在，但缺 entity_key / writeback_disabled / lifecycle_state 等列。 */
  function createLegacyDb(): BetterSqlite3.Database {
    const db = new BetterSqlite3(':memory:')
    db.exec(`
      CREATE TABLE graphs (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, project_path TEXT,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, type TEXT, status TEXT, title TEXT, graph_id TEXT,
        graph_type TEXT, position_x REAL, position_y REAL, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, source TEXT, target TEXT, edge_type TEXT,
        graph_id TEXT, content TEXT, updated_at TEXT
      );
      ${REPORT_DDL}
    `)
    const now = '2026-01-01T00:00:00Z'
    db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('g1', '旧图', 'online', '/p', now, now)
    const insNode = db.prepare('INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insNode.run('n1', 'module', 'confirmed', '旧模块', 'g1', 'online', 0, 0, now, now)
    insNode.run('n2', 'feature', 'draft', '旧功能', 'g1', 'online', 0, 20, now, now)
    db.prepare('INSERT INTO edges (id, source, target, edge_type, graph_id, content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('e1', 'n1', 'n2', 'dependency', 'g1', JSON.stringify({ note: '旧关系' }), now)
    return db
  }

  it('缺 entity_key/writeback_disabled 时产出降级基线并通过校验（新增列不影响哈希）', () => {
    const db = createLegacyDb()
    const baseline = captureS4Baseline(db)

    expect(baseline.graphs).toBe(1)
    expect(baseline.nodes).toBe(2)
    expect(baseline.edges).toBe(1)
    expect(baseline.entityKeyNonNull).toBeNull()
    expect(baseline.writebackDisabled).toBeNull()
    expect(baseline.degradedReasons.join(' ')).toContain('entity_key')

    // 模拟重建新增列：哈希必须仍按重建前已存在的列集比对。
    db.exec('ALTER TABLE nodes ADD COLUMN entity_key TEXT')
    db.prepare('UPDATE nodes SET entity_key = ? WHERE id = ?').run('ek-1', 'n1')

    expect(() => verifyS4PostRebuild(db, baseline)).not.toThrow()

    const report = db
      .prepare("SELECT * FROM map_migration_reports WHERE stage = 'S4.rebuild' ORDER BY started_at DESC LIMIT 1")
      .get() as Record<string, unknown>
    expect(report.status).toBe('ok')
    const stats = JSON.parse(report.stats_json as string)
    expect(stats.mode).toBe('degraded')
    expect(stats.match).toBe(true)
    expect(report.details_json).toContain('降级模式')
    db.close()
  })

  it('降级模式下丢行仍然抛错（机制而非人工比对拦截）', () => {
    const db = createLegacyDb()
    const baseline = captureS4Baseline(db)
    db.prepare('DELETE FROM nodes WHERE id = ?').run('n2')

    expect(() => verifyS4PostRebuild(db, baseline)).toThrow(/nodes 2→1/)
    db.close()
  })

  it('三表不存在时记录显式 skipped 诊断项，而不是静默跳过', () => {
    const db = new BetterSqlite3(':memory:')
    db.exec(REPORT_DDL)

    const baseline = captureS4Baseline(db)
    expect(baseline.tablesPresent).toEqual({ graphs: false, nodes: false, edges: false })
    expect(() => verifyS4PostRebuild(db, baseline)).not.toThrow()

    const report = db
      .prepare("SELECT * FROM map_migration_reports WHERE stage = 'S4.rebuild' ORDER BY started_at DESC LIMIT 1")
      .get() as Record<string, unknown>
    const stats = JSON.parse(report.stats_json as string)
    expect(report.status).toBe('ok')
    expect(stats.mode).toBe('none')
    expect(stats.skipped).toBe(true)
    expect(report.details_json).toContain('校验已跳过')
    db.close()
  })
})
