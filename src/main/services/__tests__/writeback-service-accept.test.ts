/**
 * WritebackService.accept 测试（真实内存库）
 * 真实 NodeRepository / EdgeRepository / WritebackRepository + WikiLinkService 落边。
 * nodes/edges 表 DDL 与生产 schema 同列，保证 repository 真实 SQL 可跑。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NodeRepository } from '../../repositories/node-repository'
import { EdgeRepository } from '../../repositories/edge-repository'
import { WritebackRepository } from '../../repositories/writeback-repository'
import { WritebackService, type NodeTitleSource, type WritebackRepoLike } from '../writeback-service'
import { WikiLinkService } from '../wiki-link-service'
import { IpcError } from '../../errors'
import type { GraphNode } from '@shared/types'
import type { WritebackItem } from '@shared/types/wiki'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE graphs (id TEXT PRIMARY KEY, name TEXT, type TEXT, project_path TEXT,
      writeback_disabled INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      graph_id TEXT NOT NULL,
      graph_type TEXT NOT NULL,
      parent_id TEXT,
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
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      label TEXT,
      edge_type TEXT,
      content TEXT,
      graph_id TEXT NOT NULL,
      description TEXT,
      data_flow TEXT,
      strength REAL,
      created_at TEXT,
      updated_at TEXT
    );
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
  return db
}

function fakeTitleSource(titles: string[] = []): NodeTitleSource {
  return { findExistingTitles: () => titles }
}

describe('WritebackService.accept', () => {
  let db: Database.Database
  let nodeRepo: NodeRepository
  let edgeRepo: EdgeRepository
  let writebackRepo: WritebackRepository
  let service: WritebackService

  function createWikiPage(title: string, wikiContent: string): GraphNode {
    return nodeRepo.create({
      type: 'wiki-page',
      status: 'confirmed',
      title,
      graphId: 'g1',
      graphType: 'online',
      position: { x: 100, y: 50 },
      wikiContent,
    })
  }

  beforeEach(() => {
    db = makeDb()
    nodeRepo = new NodeRepository(db)
    edgeRepo = new EdgeRepository(db)
    writebackRepo = new WritebackRepository(db)
    service = new WritebackService(writebackRepo, fakeTitleSource(), { nodeRepo, edgeRepo, db })
  })

  it('accept append-log appends section to node wikiContent and marks accepted', () => {
    const node = createWikiPage('页面A', '# 页面A\n\n原有内容。\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-07-30',
      content: '\n## 会话日志 · 2026-07-30\n\n- 发现 X\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
    })

    service.accept(item.id)

    const updated = nodeRepo.findById(node.id)!
    expect(updated.wikiContent).toContain('原有内容。')
    expect(updated.wikiContent).toContain('## 会话日志 · 2026-07-30')
    expect(updated.wikiContent).toContain('- 发现 X')
    const after = writebackRepo.findById(item.id)!
    expect(after.status).toBe('accepted')
    expect(after.resolvedAt).not.toBeNull()
  })

  it('accept append-log is idempotent when section already present', () => {
    // 场景一：同一 item 重复 accept —— 第二次因 status 非 pending 直接返回，不重复追加
    const node = createWikiPage('页面A', '# 页面A\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-07-30',
      content: '\n## 会话日志 · 2026-07-30\n\n- 发现 X\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
    })
    service.accept(item.id)
    const contentAfterFirst = nodeRepo.findById(node.id)!.wikiContent!
    service.accept(item.id) // no-op
    expect(nodeRepo.findById(node.id)!.wikiContent).toBe(contentAfterFirst)
    const occurrences = contentAfterFirst.split('## 会话日志 · 2026-07-30').length - 1
    expect(occurrences).toBe(1)

    // 场景二：新 pending item 小节标题行已存在于 wikiContent —— 跳过写入但仍标 accepted
    nodeRepo.update(node.id, {
      wikiContent: '# 页面A\n\n## 会话日志 · 2026-07-30\n\n- 旧条目\n',
    })
    const dup = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-07-30',
      content: '\n## 会话日志 · 2026-07-30\n\n- 重复条目不应写入\n',
      sourceSessionId: 'sess_2',
      confidence: 0.8,
    })
    service.accept(dup.id)
    const finalContent = nodeRepo.findById(node.id)!.wikiContent!
    expect(finalContent).not.toContain('重复条目不应写入')
    expect(finalContent.split('## 会话日志 · 2026-07-30').length - 1).toBe(1)
    expect(writebackRepo.findById(dup.id)!.status).toBe('accepted')
  })

  it('accept append-log still writes when title appears only in body text (not a section heading)', () => {
    const node = createWikiPage('页面A', '# 页面A\n\n今日总结见「会话日志 · 2026-07-30」一节。\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-07-30',
      content: '\n## 会话日志 · 2026-07-30\n\n- 新条目\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
    })
    service.accept(item.id)
    const content = nodeRepo.findById(node.id)!.wikiContent!
    expect(content).toContain('- 新条目')
    expect(writebackRepo.findById(item.id)!.status).toBe('accepted')
  })

  it('accept new-page creates wiki-page node + edge to source node', () => {
    const source = createWikiPage('源节点', '# 源节点\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'new-page',
      targetNodeId: source.id,
      title: 'auth-flow',
      content: '---\ntitle: "auth-flow"\n---\n\n# auth-flow\n\n- 源节点：[[源节点]]\n',
      sourceSessionId: 'sess_1',
      confidence: 0.75,
    })

    service.accept(item.id)

    const nodes = nodeRepo.listByGraph('g1')
    const created = nodes.find((n) => n.id !== source.id)
    expect(created).toBeDefined()
    expect(created!.type).toBe('wiki-page')
    expect(created!.status).toBe('confirmed')
    expect(created!.title).toBe('auth-flow')
    expect(created!.wikiContent).toBe(item.content)
    expect(created!.graphId).toBe('g1')
    expect(created!.graphType).toBe(source.graphType)
    // 位置偏移：源节点右下方
    expect(created!.position.x).toBe(source.position.x + 280)
    expect(created!.position.y).toBe(source.position.y + 120)

    // semantic 派生边：source → created
    const edges = edgeRepo.listByGraph('g1')
    const derived = edges.find((e) => e.edgeType === 'semantic' && e.label === 'writeback-derived')
    expect(derived).toBeDefined()
    expect(derived!.source).toBe(source.id)
    expect(derived!.target).toBe(created!.id)

    // 新页内容含 [[源节点]]，syncNodeLinks 应落一条 wiki-link 边
    const wikiLinks = edges.filter((e) => e.edgeType === 'wiki-link')
    expect(wikiLinks).toHaveLength(1)
    expect(wikiLinks[0].source).toBe(created!.id)
    expect(wikiLinks[0].target).toBe(source.id)

    expect(writebackRepo.findById(item.id)!.status).toBe('accepted')
  })

  it('accept new-page is idempotent when same-title wiki-page already exists', () => {
    const source = createWikiPage('源节点', '# 源节点\n')
    const item1 = writebackRepo.create({
      graphId: 'g1',
      kind: 'new-page',
      targetNodeId: source.id,
      title: 'auth-flow',
      content: '---\ntitle: auth-flow\n---\n\n# auth-flow\n',
      sourceSessionId: 'sess_1',
      confidence: 0.75,
    })
    service.accept(item1.id)

    // 第二个 pending item 标题与已创建的 wiki-page 相同
    const item2 = writebackRepo.create({
      graphId: 'g1',
      kind: 'new-page',
      targetNodeId: source.id,
      title: 'auth-flow',
      content: '---\ntitle: auth-flow\n---\n\n# auth-flow\n\n> second\n',
      sourceSessionId: 'sess_2',
      confidence: 0.75,
    })
    service.accept(item2.id)

    const pages = nodeRepo.listByGraph('g1').filter((n) => n.title === 'auth-flow' && n.type === 'wiki-page')
    expect(pages).toHaveLength(1)
    expect(writebackRepo.findById(item1.id)!.status).toBe('accepted')
    expect(writebackRepo.findById(item2.id)!.status).toBe('accepted')
  })

  it('accept new-page still succeeds and marks accepted when syncNodeLinks throws', () => {
    const spy = vi.spyOn(WikiLinkService, 'syncNodeLinks').mockImplementation(() => {
      throw new Error('boom')
    })
    const source = createWikiPage('源节点', '# 源节点\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'new-page',
      targetNodeId: source.id,
      title: 'sync-error-page',
      content: '---\ntitle: sync-error-page\n---\n\n# sync-error-page\n',
      sourceSessionId: 'sess_1',
      confidence: 0.75,
    })

    expect(() => service.accept(item.id)).not.toThrow()

    expect(writebackRepo.findById(item.id)!.status).toBe('accepted')
    const created = nodeRepo.listByGraph('g1').find((n) => n.title === 'sync-error-page')
    expect(created).toBeDefined()

    spy.mockRestore()
  })

  it('accept append-log still succeeds and marks accepted when syncNodeLinks throws', () => {
    const spy = vi.spyOn(WikiLinkService, 'syncNodeLinks').mockImplementation(() => {
      throw new Error('boom')
    })
    const node = createWikiPage('页面A', '# 页面A\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-07-30',
      content: '\n## 会话日志 · 2026-07-30\n\n- 发现 X\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
    })

    expect(() => service.accept(item.id)).not.toThrow()

    expect(nodeRepo.findById(node.id)!.wikiContent).toContain('发现 X')
    expect(writebackRepo.findById(item.id)!.status).toBe('accepted')

    spy.mockRestore()
  })

  it('accept throws when target node does not exist', () => {
    // writeback_items.target_node_id 是 ON DELETE CASCADE，真实删除节点会连带删除 item。
    // 用包装 repo 让 findById 返回指向不存在节点的 item，验证防御性检查。
    const ghost: WritebackItem = {
      id: 'writeback-ghost',
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: 'node_deleted',
      title: '会话日志 · 2026-07-30',
      content: '\n## 会话日志\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
      status: 'pending',
      createdAt: '2026-07-30T00:00:00Z',
      resolvedAt: null,
    }
    const wrappingRepo: WritebackRepoLike = {
      create: (d) => writebackRepo.create(d),
      findBySession: (sid) => writebackRepo.findBySession(sid),
      findById: (id) => (id === ghost.id ? ghost : writebackRepo.findById(id)),
      updateStatus: (id, status) => writebackRepo.updateStatus(id, status),
    }
    const svc = new WritebackService(wrappingRepo, fakeTitleSource(), { nodeRepo, edgeRepo })
    expect(() => svc.accept(ghost.id)).toThrow(IpcError)
    expect(() => svc.accept(ghost.id)).toThrow('目标节点已删除')
  })

  it('accept on already-accepted item is a no-op', () => {
    const node = createWikiPage('页面A', '# 页面A\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-07-30',
      content: '\n## 会话日志 · 2026-07-30\n\n- 发现 X\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
    })
    service.accept(item.id)
    expect(() => service.accept(item.id)).not.toThrow()
    const content = nodeRepo.findById(node.id)!.wikiContent!
    expect(content.split('## 会话日志 · 2026-07-30').length - 1).toBe(1)
  })

  it('accept throws for unknown item id', () => {
    expect(() => service.accept('writeback-nonexistent')).toThrow(IpcError)
    expect(() => service.accept('writeback-nonexistent')).toThrow('写回项不存在')
  })

  it('accept without deps throws', () => {
    const bare = new WritebackService(writebackRepo, fakeTitleSource())
    expect(() => bare.accept('any-id')).toThrow(IpcError)
    expect(() => bare.accept('any-id')).toThrow('nodeRepo/edgeRepo')
  })
})

describe('WritebackService.discard', () => {
  let db: Database.Database
  let nodeRepo: NodeRepository
  let writebackRepo: WritebackRepository
  let service: WritebackService

  beforeEach(() => {
    db = makeDb()
    nodeRepo = new NodeRepository(db)
    writebackRepo = new WritebackRepository(db)
    service = new WritebackService(writebackRepo, fakeTitleSource())
  })

  function seedPending(): string {
    const node = nodeRepo.create({
      type: 'wiki-page', status: 'confirmed', title: '页面A',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
    })
    return writebackRepo.create({
      graphId: 'g1', kind: 'append-log', targetNodeId: node.id,
      title: '会话日志 · 2026-07-31', content: '## 会话日志',
      sourceSessionId: 'sess_d', confidence: 0.5,
    }).id
  }

  it('discard pending marks discarded with resolvedAt', () => {
    const id = seedPending()
    service.discard(id)
    const item = writebackRepo.findById(id)!
    expect(item.status).toBe('discarded')
    expect(item.resolvedAt).not.toBeNull()
  })

  it('discard accepted item leaves it accepted (lifecycle guard)', () => {
    const id = seedPending()
    writebackRepo.updateStatus(id, 'accepted')
    service.discard(id)
    expect(writebackRepo.findById(id)!.status).toBe('accepted')
  })

  it('discard already-discarded item is a no-op', () => {
    const id = seedPending()
    writebackRepo.updateStatus(id, 'discarded')
    const before = writebackRepo.findById(id)!.resolvedAt
    service.discard(id)
    expect(writebackRepo.findById(id)!.status).toBe('discarded')
    expect(writebackRepo.findById(id)!.resolvedAt).toBe(before)
  })

  it('discard unknown id is a silent no-op', () => {
    expect(() => service.discard('writeback-nonexistent')).not.toThrow()
  })
})
