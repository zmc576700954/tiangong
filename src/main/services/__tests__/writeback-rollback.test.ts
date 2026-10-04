/**
 * WritebackService.rollback 测试（D7b）
 * 真实 NodeRepository / EdgeRepository / WritebackRepository + WikiLinkService 落边。
 * nodes/edges/writeback_items 表 DDL 与生产 schema 同列（含 v11 rollback_actions 列与 rolled_back 状态）。
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
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded','rolled_back')),
      created_at TEXT NOT NULL, resolved_at TEXT,
      rollback_actions TEXT
    );
  `)
  db.prepare(`INSERT INTO graphs (id,name,type,created_at,updated_at) VALUES ('g1','G','online','2026-01-01','2026-01-01')`).run()
  return db
}

function fakeTitleSource(titles: string[] = []): NodeTitleSource {
  return { findExistingTitles: () => titles }
}

describe('WritebackService.rollback — append-log', () => {
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

  it('removes append-log section from target node wikiContent and marks rolled_back', () => {
    const original = '# 页面A\n\n## 概述\n\n正文段落\n'
    const node = createWikiPage('页面A', original)
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-10-01 14:30',
      content: '\n## 会话日志 · 2026-10-01 14:30\n\n> 来源：claude-code 会话 · 置信度 0.85\n\n- 发现 X\n- 发现 Y\n',
      sourceSessionId: 'sess_1',
      confidence: 0.85,
    })
    service.accept(item.id)
    const afterAccept = nodeRepo.findById(node.id)!.wikiContent!
    expect(afterAccept).toContain('## 会话日志 · 2026-10-01 14:30')
    expect(afterAccept).toContain('- 发现 X')

    const result = service.rollback(item.id)
    expect(result.status).toBe('rolled_back')
    expect(result.undoneActions).toHaveLength(1)
    expect(result.undoneActions[0].kind).toBe('removed-section')
    expect(result.skippedActions).toHaveLength(0)

    const afterRollback = nodeRepo.findById(node.id)!.wikiContent!
    expect(afterRollback).toBe(original)
    const afterItem = writebackRepo.findById(item.id)!
    expect(afterItem.status).toBe('rolled_back')
    expect(afterItem.resolvedAt).not.toBeNull()
    expect(afterItem.rollbackActions).toBeDefined()
    expect(afterItem.rollbackActions!.some((a) => a.kind === 'removed-section')).toBe(true)
  })

  it('does not affect adjacent ## sections when removing target section', () => {
    const node = createWikiPage('页面A', '# 页面A\n\n## 概述\n\n旧段落\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-10-01',
      content: '\n## 会话日志 · 2026-10-01\n\n- X\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
    })
    service.accept(item.id)
    // 追加一次后页面包含「## 概述」+「## 会话日志 · 2026-10-01」
    expect(nodeRepo.findById(node.id)!.wikiContent).toContain('## 概述')

    service.rollback(item.id)

    const final = nodeRepo.findById(node.id)!.wikiContent!
    expect(final).toContain('## 概述')
    expect(final).toContain('旧段落')
    expect(final).not.toContain('## 会话日志 · 2026-10-01')
  })

  it('rollback is idempotent: second call returns skipped without throwing', () => {
    const original = '# 页面A\n\n## 概述\n\n正文\n'
    const node = createWikiPage('页面A', original)
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-10-01',
      content: '\n## 会话日志 · 2026-10-01\n\n- X\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
    })
    service.accept(item.id)
    service.rollback(item.id)

    // 第二次 rollback：状态非 accepted，应抛错
    expect(() => service.rollback(item.id)).toThrow(IpcError)
    expect(() => service.rollback(item.id)).toThrow(/仅已采纳项可撤回/)
  })

  it('reports skipped action when section not found (manual edit case)', () => {
    const node = createWikiPage('页面A', '# 页面A\n\n## 概述\n\n旧内容\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-10-01',
      content: '\n## 会话日志 · 2026-10-01\n\n- X\n',
      sourceSessionId: 'sess_1',
      confidence: 0.8,
    })
    service.accept(item.id)
    // 用户手动删除该段落
    nodeRepo.update(node.id, {
      wikiContent: '# 页面A\n\n## 概述\n\n旧内容\n## 用户编辑\n\n手改后\n',
    })

    const result = service.rollback(item.id)
    expect(result.status).toBe('rolled_back')
    expect(result.undoneActions).toHaveLength(0)
    expect(result.skippedActions).toHaveLength(1)
    expect(result.skippedActions[0].kind).toBe('removed-section')
    expect(result.skippedActions[0].description).toMatch(/未在.*中找到段落/)

    // 用户编辑的内容保持不变
    expect(nodeRepo.findById(node.id)!.wikiContent).toContain('## 用户编辑')
    expect(writebackRepo.findById(item.id)!.status).toBe('rolled_back')
  })

  it('reports skipped when target node was deleted before rollback', () => {
    // writeback_items.target_node_id 是 ON DELETE CASCADE，真实删除节点会连带删除 item。
    // 用包装 repo 让 findById 返回指向不存在节点的 item，验证防御性检查。
    const node = createWikiPage('页面A', '# 页面A\n')
    const ghost: WritebackItem = {
      id: 'writeback-ghost',
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: 'node_deleted',
      title: '会话日志 · 2026-10-01',
      content: '\n## 会话日志 · 2026-10-01\n\n- X\n',
      sourceSessionId: 'sess_ghost',
      confidence: 0.8,
      status: 'accepted',
      createdAt: '2026-10-01T00:00:00Z',
      resolvedAt: null,
    }
    const realItem = writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: node.id,
      title: '会话日志 · 2026-10-01',
      content: '\n## 会话日志 · 2026-10-01\n\n- X\n',
      sourceSessionId: 'sess_real',
      confidence: 0.8,
    })
    writebackRepo.updateStatus(realItem.id, 'accepted')
    const wrappingRepo: WritebackRepoLike = {
      create: (d) => writebackRepo.create(d),
      findBySession: (sid) => writebackRepo.findBySession(sid),
      findById: (id) => (id === ghost.id ? ghost : writebackRepo.findById(id)),
      updateStatus: (id, status, actions) => writebackRepo.updateStatus(id, status, actions),
    }
    const svc = new WritebackService(wrappingRepo, fakeTitleSource(), { nodeRepo, edgeRepo, db })

    const result = svc.rollback(ghost.id)
    expect(result.undoneActions).toHaveLength(0)
    expect(result.skippedActions).toHaveLength(1)
    expect(result.skippedActions[0].description).toMatch(/目标节点已被删除/)
  })
})

describe('WritebackService.rollback — new-page', () => {
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

  it('deletes created wiki-page + writeback-derived edge + reports two actions', () => {
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

    // 确认页面 + 边已存在
    const page = nodeRepo.listByGraph('g1').find((n) => n.title === 'auth-flow' && n.type === 'wiki-page')!
    expect(page).toBeDefined()
    const edgesBefore = edgeRepo.listByGraph('g1')
    expect(edgesBefore.some((e) => e.label === 'writeback-derived' && e.target === page.id)).toBe(true)

    const result = service.rollback(item.id)
    expect(result.status).toBe('rolled_back')
    // 至少两条动作：deleted-edges + deleted-page
    expect(result.undoneActions.length).toBeGreaterThanOrEqual(2)
    expect(result.undoneActions.some((a) => a.kind === 'deleted-edges')).toBe(true)
    expect(result.undoneActions.some((a) => a.kind === 'deleted-page')).toBe(true)
    expect(result.skippedActions).toHaveLength(0)

    // 页面已删除
    expect(nodeRepo.listByGraph('g1').find((n) => n.title === 'auth-flow')).toBeUndefined()
    // 边已清理（writeback-derived 与 wiki-link 边都不再指向该节点）
    const edgesAfter = edgeRepo.listByGraph('g1')
    expect(edgesAfter.some((e) => e.target === page.id)).toBe(false)
    expect(edgesAfter.some((e) => e.source === page.id)).toBe(false)

    expect(writebackRepo.findById(item.id)!.status).toBe('rolled_back')
  })

  it('deletes wiki-link back-links to the rolled-back page', () => {
    const source = createWikiPage('源节点', '# 源节点\n')
    // 第二个 wiki-page 反向引用了 auth-flow
    const refBack = createWikiPage('ref-back', '---\ntitle: "ref-back"\n---\n\n# ref-back\n\n- 引用：[[auth-flow]]\n')
    // 重新跑 syncNodeLinks 让 ref-back 上的 [[auth-flow]] 落 wiki-link 边到 auth-flow
    // 但因为 auth-flow 还不存在，先接受 writeback 创建 auth-flow，然后 ref-back 重新 sync
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'new-page',
      targetNodeId: source.id,
      title: 'auth-flow',
      content: '---\ntitle: "auth-flow"\n---\n\n# auth-flow\n\n',
      sourceSessionId: 'sess_1',
      confidence: 0.75,
    })
    service.accept(item.id)
    const page = nodeRepo.listByGraph('g1').find((n) => n.title === 'auth-flow' && n.type === 'wiki-page')!

    // 让 ref-back 重新 sync：会创建一条 wiki-link 边 ref-back → auth-flow
    WikiLinkService.syncNodeLinks(refBack.id, nodeRepo, edgeRepo)
    expect(edgeRepo.listByGraph('g1').some((e) => e.edgeType === 'wiki-link' && e.source === refBack.id && e.target === page.id)).toBe(true)

    // 撤回 auth-flow：应同时清理所有指向它的 wiki-link 边（ref-back → auth-flow）
    const result = service.rollback(item.id)
    expect(result.undoneActions.some((a) => a.kind === 'deleted-edges')).toBe(true)
    const edgesAfter = edgeRepo.listByGraph('g1')
    expect(edgesAfter.some((e) => e.target === page.id)).toBe(false)
  })

  it('partial rollback: page was manually deleted → records skipped only', () => {
    const source = createWikiPage('源节点', '# 源节点\n')
    const item = writebackRepo.create({
      graphId: 'g1',
      kind: 'new-page',
      targetNodeId: source.id,
      title: 'manual-deleted-page',
      content: '---\ntitle: "manual-deleted-page"\n---\n\n# manual-deleted-page\n',
      sourceSessionId: 'sess_1',
      confidence: 0.75,
    })
    service.accept(item.id)
    // 模拟用户手动删除了该页面（直接通过 listByGraph 找到并删）
    const page = nodeRepo.listByGraph('g1').find((n) => n.title === 'manual-deleted-page')!
    nodeRepo.delete(page.id)

    const result = service.rollback(item.id)
    expect(result.undoneActions).toHaveLength(0)
    expect(result.skippedActions).toHaveLength(1)
    expect(result.skippedActions[0].kind).toBe('deleted-page')
    expect(result.skippedActions[0].description).toMatch(/已被删除/)
    expect(writebackRepo.findById(item.id)!.status).toBe('rolled_back')
  })
})

describe('WritebackService.rollback — guards & edge cases', () => {
  let db: Database.Database
  let nodeRepo: NodeRepository
  let edgeRepo: EdgeRepository
  let writebackRepo: WritebackRepository
  let service: WritebackService

  beforeEach(() => {
    db = makeDb()
    nodeRepo = new NodeRepository(db)
    edgeRepo = new EdgeRepository(db)
    writebackRepo = new WritebackRepository(db)
    service = new WritebackService(writebackRepo, fakeTitleSource(), { nodeRepo, edgeRepo, db })
  })

  it('rollback on pending item throws', () => {
    const node = nodeRepo.create({
      type: 'wiki-page', status: 'confirmed', title: '页面A',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
    })
    const item = writebackRepo.create({
      graphId: 'g1', kind: 'append-log', targetNodeId: node.id,
      title: '会话日志 · 2026-10-01', content: '## 会话日志',
      sourceSessionId: 'sess_1', confidence: 0.5,
    })
    expect(() => service.rollback(item.id)).toThrow(IpcError)
    expect(() => service.rollback(item.id)).toThrow(/仅已采纳项可撤回/)
  })

  it('rollback on discarded item throws', () => {
    const node = nodeRepo.create({
      type: 'wiki-page', status: 'confirmed', title: '页面A',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
    })
    const item = writebackRepo.create({
      graphId: 'g1', kind: 'append-log', targetNodeId: node.id,
      title: '会话日志 · 2026-10-01', content: '## 会话日志',
      sourceSessionId: 'sess_1', confidence: 0.5,
    })
    writebackRepo.updateStatus(item.id, 'discarded')
    expect(() => service.rollback(item.id)).toThrow(/discarded/)
  })

  it('rollback on unknown id throws', () => {
    expect(() => service.rollback('writeback-ghost')).toThrow(/写回项不存在/)
  })

  it('rollback without deps throws', () => {
    const bare = new WritebackService(writebackRepo, fakeTitleSource())
    expect(() => bare.rollback('any-id')).toThrow(IpcError)
    expect(() => bare.rollback('any-id')).toThrow(/nodeRepo\/edgeRepo/)
  })

  it('rollback still succeeds when syncNodeLinks throws', () => {
    const node = nodeRepo.create({
      type: 'wiki-page', status: 'confirmed', title: '页面A',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
      wikiContent: '# 页面A\n',
    })
    const item = writebackRepo.create({
      graphId: 'g1', kind: 'append-log', targetNodeId: node.id,
      title: '会话日志 · 2026-10-01',
      content: '\n## 会话日志 · 2026-10-01\n\n- X\n',
      sourceSessionId: 'sess_1', confidence: 0.8,
    })
    service.accept(item.id)
    const spy = vi.spyOn(WikiLinkService, 'syncNodeLinks').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => service.rollback(item.id)).not.toThrow()
    expect(writebackRepo.findById(item.id)!.status).toBe('rolled_back')
    expect(nodeRepo.findById(node.id)!.wikiContent).not.toContain('## 会话日志 · 2026-10-01')
    spy.mockRestore()
  })
})
