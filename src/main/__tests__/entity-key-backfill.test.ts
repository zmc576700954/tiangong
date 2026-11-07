/**
 * S1.3 entity_key 回填真库回归（session-map 蓝图 §2.2.2 S1-c / S1-f 判据 1）。
 *
 * 覆盖：精确签名配对（两侧共享键）、退化匹配、同名兄弟 ambiguous、占位节点、
 * 幂等（二次运行 0 变化）、I3 已有键永不改写、缺侧项目跳过、多图 duplicate 报告。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import {
  backfillProject,
  pairProjectGraphs,
  runEntityKeyBackfill,
  normalizeTitle,
} from '../map-migration/entity-key-backfill'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      project_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      graph_id TEXT NOT NULL,
      graph_type TEXT NOT NULL,
      parent_id TEXT,
      sort_index INTEGER,
      entity_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE map_migration_reports (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      stage         TEXT,
      schema_version INTEGER,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      owner_pid     INTEGER,
      status        TEXT NOT NULL,
      stats_json    TEXT,
      details_json  TEXT,
      error_json    TEXT
    );
  `)
  return db
}

let seq = 0
function insertGraph(db: BetterSqlite3.Database, opts: { type: string; projectPath: string; id?: string }): string {
  const id = opts.id ?? `g-${++seq}`
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    `graph-${id}`,
    opts.type,
    opts.projectPath,
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
  )
  return id
}

function insertNode(
  db: BetterSqlite3.Database,
  opts: { graphId: string; type?: string; title: string; parentId?: string | null; sortIndex?: number | null; entityKey?: string | null },
): string {
  const id = `n-${++seq}`
  db.prepare(
    'INSERT INTO nodes (id, type, title, graph_id, graph_type, parent_id, sort_index, entity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    opts.type ?? 'module',
    opts.title,
    opts.graphId,
    'online',
    opts.parentId ?? null,
    opts.sortIndex ?? null,
    opts.entityKey ?? null,
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
  )
  return id
}

function keysOf(db: BetterSqlite3.Database, graphId: string): Map<string, string | null> {
  const rows = db.prepare('SELECT id, entity_key FROM nodes WHERE graph_id = ?').all(graphId) as Array<{ id: string; entity_key: string | null }>
  return new Map(rows.map((r) => [r.id, r.entity_key]))
}

describe('pairProjectGraphs', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
    seq = 0
  })

  it('online/dev 各取第一张为基准，多余同类型图入 duplicate_graphs', () => {
    insertGraph(db, { type: 'online', projectPath: '/p1' })
    insertGraph(db, { type: 'dev', projectPath: '/p1' })
    const dupOnline = insertGraph(db, { type: 'online', projectPath: '/p1' })
    insertGraph(db, { type: 'online', projectPath: '/p2' }) // 缺 dev 侧 → 整项目跳过

    const pairs = pairProjectGraphs(db)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].project_path).toBe('/p1')
    expect(pairs[0].duplicate_graphs).toEqual([dupOnline])
  })
})

describe('backfillProject 匹配语义', () => {
  let db: BetterSqlite3.Database
  let online: string
  let dev: string

  beforeEach(() => {
    db = setupDb()
    seq = 0
    online = insertGraph(db, { type: 'online', projectPath: '/p1' })
    dev = insertGraph(db, { type: 'dev', projectPath: '/p1' })
  })

  it('对称结构 → 精确签名配对，两侧共享同一 entity_key', () => {
    const oRoot = insertNode(db, { graphId: online, type: 'project', title: '项目' })
    const oMod = insertNode(db, { graphId: online, title: '登录模块', parentId: oRoot, sortIndex: 0 })
    const dRoot = insertNode(db, { graphId: dev, type: 'project', title: '项目' })
    const dMod = insertNode(db, { graphId: dev, title: '登录模块', parentId: dRoot, sortIndex: 0 })

    const stats = backfillProject(db, { project_path: '/p1', online, dev, duplicate_graphs: [] })
    expect(stats.matched_exact).toBe(2)
    expect(stats.unmatched).toBe(0)
    expect(stats.ambiguous).toBe(0)
    expect(stats.null_after).toBe(0)

    const oKeys = keysOf(db, online)
    const dKeys = keysOf(db, dev)
    expect(oKeys.get(oMod)).toEqual(dKeys.get(dMod))
    expect(oKeys.get(oRoot)).toEqual(dKeys.get(dRoot))
    expect(oKeys.get(oRoot)).not.toEqual(oKeys.get(oMod))
  })

  it('幂等：第二次运行 0 行变化（I3 已有键永不改写）', () => {
    insertNode(db, { graphId: online, type: 'project', title: '项目' })
    insertNode(db, { graphId: dev, type: 'project', title: '项目' })
    backfillProject(db, { project_path: '/p1', online, dev, duplicate_graphs: [] })
    const first = keysOf(db, online)

    const stats2 = backfillProject(db, { project_path: '/p1', online, dev, duplicate_graphs: [] })
    expect(stats2.null_before).toBe(0)
    expect(stats2.matched_exact).toBe(0)
    expect(keysOf(db, online)).toEqual(first)
  })

  it('同名兄弟按 sibling_ordinal 精确配对（序号即消歧，§2.2）', () => {
    const oRoot = insertNode(db, { graphId: online, type: 'project', title: '项目' })
    const oS0 = insertNode(db, { graphId: online, title: '同名', parentId: oRoot, sortIndex: 0 })
    const oS1 = insertNode(db, { graphId: online, title: '同名', parentId: oRoot, sortIndex: 1 })
    const dRoot = insertNode(db, { graphId: dev, type: 'project', title: '项目' })
    const dS0 = insertNode(db, { graphId: dev, title: '同名', parentId: dRoot, sortIndex: 0 })
    const dS1 = insertNode(db, { graphId: dev, title: '同名', parentId: dRoot, sortIndex: 1 })

    const stats = backfillProject(db, { project_path: '/p1', online, dev, duplicate_graphs: [] })
    expect(stats.matched_exact).toBe(3)
    expect(stats.ambiguous).toBe(0)
    expect(stats.null_after).toBe(0)

    const oKeys = keysOf(db, online)
    const dKeys = keysOf(db, dev)
    // 同名兄弟按位置一一对应,互不串键
    expect(oKeys.get(oS0)).toEqual(dKeys.get(dS0))
    expect(oKeys.get(oS1)).toEqual(dKeys.get(dS1))
    expect(oKeys.get(oS0)).not.toEqual(oKeys.get(oS1))
  })

  it('sibling_ordinal 差异破坏精确签名时，退化匹配 (type,title,chain) 兜底', () => {
    const oRoot = insertNode(db, { graphId: online, type: 'project', title: '项目' })
    const oA = insertNode(db, { graphId: online, title: '模块A', parentId: oRoot, sortIndex: 0 })
    insertNode(db, { graphId: online, title: '模块B', parentId: oRoot, sortIndex: 1 })
    const dRoot = insertNode(db, { graphId: dev, type: 'project', title: '项目' })
    const dA = insertNode(db, { graphId: dev, title: '模块A', parentId: dRoot, sortIndex: 1 })
    insertNode(db, { graphId: dev, title: '模块B', parentId: dRoot, sortIndex: 0 })

    const stats = backfillProject(db, { project_path: '/p1', online, dev, duplicate_graphs: [] })
    // 全部签名因 ordinal 交换而不精确命中；退化层 (type,title,chain) 1v1 命中
    expect(stats.matched_exact).toBe(1) // 根（ordinal 无兄弟歧义 → 精确命中）
    expect(stats.matched_fallback).toBe(2)
    expect(keysOf(db, online).get(oA)).toEqual(keysOf(db, dev).get(dA))
  })

  it('占位节点（空标题 project 根）不参与配对，各自新键', () => {
    insertNode(db, { graphId: online, type: 'project', title: '   ' })
    insertNode(db, { graphId: dev, type: 'project', title: '' })

    const stats = backfillProject(db, { project_path: '/p1', online, dev, duplicate_graphs: [] })
    expect(stats.placeholders).toBe(2)
    const oKey = [...keysOf(db, online).values()][0]
    const dKey = [...keysOf(db, dev).values()][0]
    expect(oKey).toBeTruthy()
    expect(dKey).toBeTruthy()
    expect(oKey).not.toEqual(dKey)
  })

  it('未配对节点（单侧新增）各自新键，明细进 unmatched_details', () => {
    const oRoot = insertNode(db, { graphId: online, type: 'project', title: '项目' })
    insertNode(db, { graphId: online, title: '仅线上', parentId: oRoot })
    const dRoot = insertNode(db, { graphId: dev, type: 'project', title: '项目' })
    insertNode(db, { graphId: dev, title: '仅开发', parentId: dRoot })

    const stats = backfillProject(db, { project_path: '/p1', online, dev, duplicate_graphs: [] })
    expect(stats.matched_exact).toBe(1)
    expect(stats.unmatched).toBe(2)
    const details = (stats as unknown as { unmatched_details: Array<{ title: string }> }).unmatched_details
    expect(details.map((d) => d.title).sort()).toEqual(['仅开发', '仅线上'])
  })
})

describe('normalizeTitle', () => {
  it('去首尾空白、折叠连续空白、保持大小写', () => {
    expect(normalizeTitle('  登录   模块  ')).toBe('登录 模块')
    expect(normalizeTitle('Auth  Module')).toBe('Auth Module')
  })
})

describe('runEntityKeyBackfill 阶段集成', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
    seq = 0
  })

  it('阶段记录 ok，统计汇总正确；二次运行 0 变化', () => {
    const online = insertGraph(db, { type: 'online', projectPath: '/p1' })
    const dev = insertGraph(db, { type: 'dev', projectPath: '/p1' })
    const oRoot = insertNode(db, { graphId: online, type: 'project', title: '项目' })
    const dRoot = insertNode(db, { graphId: dev, type: 'project', title: '项目' })

    const stats = runEntityKeyBackfill(db, 26)
    expect(stats.projects_total).toBe(1)
    expect(stats.projects_ok).toBe(1)
    expect(stats.projects_failed).toBe(0)
    expect(stats.matched_exact).toBe(1)
    expect(stats.null_after).toBe(0)

    const report = db
      .prepare("SELECT * FROM map_migration_reports WHERE kind='entity_key_backfill' AND stage='S1.backfill'")
      .get() as Record<string, unknown>
    expect(report.status).toBe('ok')

    const first = keysOf(db, online)
    expect(first.get(oRoot)).toEqual(keysOf(db, dev).get(dRoot))

    const stats2 = runEntityKeyBackfill(db, 26)
    expect(stats2.null_before).toBe(0)
    expect(keysOf(db, online)).toEqual(first)
  })
})
