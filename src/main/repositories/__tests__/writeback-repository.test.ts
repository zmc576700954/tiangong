import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { WritebackRepository } from '../writeback-repository'

// 建真实内存库并跑最小建表（只建本测试依赖的 graphs/nodes/writeback_items）
function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE graphs (id TEXT PRIMARY KEY, name TEXT, type TEXT, project_path TEXT,
      writeback_disabled INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT, title TEXT);
    CREATE TABLE writeback_items (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('append-log','new-page')),
      target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content TEXT NOT NULL,
      details TEXT, narrative TEXT, source_node_ids TEXT, target_node_title TEXT,
      source_session_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded')),
      created_at TEXT NOT NULL, resolved_at TEXT
    );
  `)
  db.prepare(`INSERT INTO graphs (id,name,type,created_at,updated_at) VALUES ('g1','G','online','2026-01-01','2026-01-01')`).run()
  db.prepare(`INSERT INTO nodes (id,graph_id,title) VALUES ('n1','g1','Node A')`).run()
  return db
}

describe('WritebackRepository', () => {
  let db: Database.Database
  let repo: WritebackRepository
  beforeEach(() => { db = makeDb(); repo = new WritebackRepository(db) })

  it('create + listPending round-trips all fields', () => {
    repo.create({
      graphId: 'g1', kind: 'append-log', targetNodeId: 'n1',
      title: '会话日志 · 2026-07-30', content: '## 会话日志',
      sourceSessionId: 'sess_1', confidence: 0.82,
    })
    const items = repo.listPending('g1')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('append-log')
    expect(items[0].targetNodeId).toBe('n1')
    expect(items[0].confidence).toBeCloseTo(0.82)
    expect(items[0].status).toBe('pending')
    expect(items[0].id).toMatch(/^writeback-/)
    expect(items[0].resolvedAt).toBeNull()
  })

  it('findBySession finds existing pending/accepted items for dedup', () => {
    repo.create({ graphId: 'g1', kind: 'new-page', targetNodeId: 'n1', title: 'T', content: 'C', sourceSessionId: 'sess_1', confidence: 0.5 })
    expect(repo.findBySession('sess_1')).toHaveLength(1)
    expect(repo.findBySession('sess_other')).toHaveLength(0)
  })

  it('findBySession includes discarded items (session dedup survives discard-all)', () => {
    const item = repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'T', content: 'C', sourceSessionId: 'sess_d', confidence: 0.5 })
    expect(repo.findBySession('sess_d')).toHaveLength(1)
    repo.updateStatus(item.id, 'discarded')
    expect(repo.findBySession('sess_d')).toHaveLength(1)
  })

  it('updateStatus sets status + resolvedAt; listPending excludes resolved', () => {
    const item = repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'T', content: 'C', sourceSessionId: 's', confidence: 0.5 })
    repo.updateStatus(item.id, 'accepted')
    expect(repo.listPending('g1')).toHaveLength(0)
    expect(repo.countPending('g1')).toBe(0)
  })

  it('countPending counts only pending', () => {
    repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'A', content: 'C', sourceSessionId: 's1', confidence: 0.5 })
    repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'B', content: 'C', sourceSessionId: 's2', confidence: 0.5 })
    expect(repo.countPending('g1')).toBe(2)
  })

  it('graph delete cascades writeback_items', () => {
    repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'T', content: 'C', sourceSessionId: 's', confidence: 0.5 })
    // 真实 schema 中 nodes.graph_id 没有 REFERENCES，本 fixture 也沿用该行为。
    // 删除 graph 时，只有 writeback_items.graph_id 的 ON DELETE CASCADE 会清理 writeback_items。
    db.prepare(`DELETE FROM graphs WHERE id='g1'`).run()
    const nodeCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c
    expect(nodeCount).toBe(1)
    expect(repo.listPending('g1')).toHaveLength(0)
  })

  describe('v9 structured fields', () => {
    it('create + listPending round-trips details / narrative / sourceNodeIds / targetNodeTitle', () => {
      repo.create({
        graphId: 'g1',
        kind: 'new-page',
        targetNodeId: 'n1',
        title: 'auth-flow',
        content: '# auth-flow',
        details: undefined, // new-page 不需要 details
        narrative: undefined,
        sourceNodeIds: ['n1', 'n2'],
        targetNodeTitle: '源节点',
        sourceSessionId: 'sess_v9',
        confidence: 0.75,
      })
      const items = repo.listPending('g1')
      expect(items).toHaveLength(1)
      const it = items[0]
      expect(it.details).toBeUndefined()
      expect(it.narrative).toBeUndefined()
      expect(it.sourceNodeIds).toEqual(['n1', 'n2'])
      expect(it.targetNodeTitle).toBe('源节点')
    })

    it('append-log 写入 details / narrative 后可读回', () => {
      const created = repo.create({
        graphId: 'g1',
        kind: 'append-log',
        targetNodeId: 'n1',
        title: 'T',
        content: '## 会话日志',
        details: '### 子项\n\n细节',
        narrative: '会话叙事 TL;DR',
        sourceSessionId: 's',
        confidence: 0.5,
      })
      const fetched = repo.findById(created.id)!
      expect(fetched.details).toBe('### 子项\n\n细节')
      expect(fetched.narrative).toBe('会话叙事 TL;DR')
    })

    it('corrupt source_node_ids JSON 降级为 undefined 不抛异常', () => {
      db.prepare(`INSERT INTO writeback_items
        (id, graph_id, kind, target_node_id, title, content, source_node_ids,
         source_session_id, confidence, status, created_at, resolved_at)
        VALUES ('w_corrupt','g1','append-log','n1','T','C','not-json',
                's',0.5,'pending','2026-01-01',NULL)`).run()
      const it = repo.findById('w_corrupt')!
      expect(it.sourceNodeIds).toBeUndefined()
    })

    it('空数组的 source_node_ids 也视为 undefined', () => {
      repo.create({
        graphId: 'g1', kind: 'append-log', targetNodeId: 'n1',
        title: 'T', content: 'C', sourceNodeIds: [],
        sourceSessionId: 's', confidence: 0.5,
      })
      const items = repo.listPending('g1')
      expect(items[0].sourceNodeIds).toBeUndefined()
    })
  })
})
