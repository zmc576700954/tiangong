import { describe, it, expect, beforeEach } from 'vitest'
import { LintFixService } from '../lint-fix-service'
import { BizGraphError } from '../../errors'
import type { GraphEdge, GraphNode } from '@shared/types'
import type { LintFixAction } from '@shared/types/wiki'

function wikiNode(id: string, title: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, type: 'wiki-page', status: 'draft', title, graphId: 'g1', graphType: 'online',
    position: { x: 0, y: 0 }, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', ...extra,
  } as GraphNode
}

class MemNodeRepo {
  nodes = new Map<string, GraphNode>()
  findById = (id: string) => this.nodes.get(id) ?? null
  listByGraph = (gid: string) => [...this.nodes.values()].filter((n) => n.graphId === gid)
  create = (data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>) => {
    const id = `n_${Math.random().toString(36).slice(2, 9)}`
    const now = new Date().toISOString()
    const node: GraphNode = { ...data, id, createdAt: now, updatedAt: now }
    this.nodes.set(id, node)
    return node
  }
  update = (id: string, data: Partial<GraphNode>) => {
    const cur = this.nodes.get(id)
    if (!cur) throw new Error(`node ${id} not found`)
    const next: GraphNode = { ...cur, ...data, updatedAt: new Date().toISOString() }
    this.nodes.set(id, next)
    return next
  }
}
class MemEdgeRepo {
  edges: GraphEdge[] = []
  create = (data: Omit<GraphEdge, 'id'>) => {
    const id = `e_${Math.random().toString(36).slice(2, 9)}`
    const e: GraphEdge = { ...data, id }
    this.edges.push(e)
    return e
  }
  delete = (id: string) => {
    this.edges = this.edges.filter((e) => e.id !== id)
  }
  listByGraph = (gid: string) => this.edges.filter((e) => e.graphId === gid)
}

describe('LintFixService.apply', () => {
  let nodeRepo: MemNodeRepo
  let edgeRepo: MemEdgeRepo

  beforeEach(() => {
    nodeRepo = new MemNodeRepo()
    edgeRepo = new MemEdgeRepo()
  })

  describe('create-stub-page', () => {
    it('创建新 wiki-page 节点并同步源节点的 wiki-link 出边', () => {
      const src = wikiNode('a', '源页', { wikiContent: '见 [[目标]]' })
      nodeRepo.nodes.set(src.id, src)

      const action: LintFixAction = {
        kind: 'create-stub-page',
        payload: { sourceNodeId: 'a', targetTitle: '目标' },
      }
      const r = LintFixService.apply(action, nodeRepo, edgeRepo)
      expect(r.ok).toBe(true)
      expect(r.nodeId).toBeDefined()

      const newId = r.nodeId!
      const newNode = nodeRepo.findById(newId)!
      expect(newNode.type).toBe('wiki-page')
      expect(newNode.title).toBe('目标')
      expect(newNode.status).toBe('draft')
      expect(newNode.graphId).toBe('g1')
      expect(newNode.graphType).toBe('online')

      // 源节点应当出现到新节点的 wiki-link 出边
      const links = edgeRepo.edges.filter((e) => e.source === 'a' && e.target === newId && e.edgeType === 'wiki-link')
      expect(links.length).toBe(1)
    })

    it('同名页面已存在时直接视为已修复并返回已有节点 ID', () => {
      nodeRepo.nodes.set('a', wikiNode('a', '源页', { wikiContent: '见 [[目标]]' }))
      nodeRepo.nodes.set('existing', wikiNode('existing', '目标'))

      const action: LintFixAction = {
        kind: 'create-stub-page',
        payload: { sourceNodeId: 'a', targetTitle: '目标' },
      }
      const r = LintFixService.apply(action, nodeRepo, edgeRepo)
      expect(r.ok).toBe(true)
      expect(r.nodeId).toBe('existing')

      const links = edgeRepo.edges.filter((e) => e.source === 'a' && e.target === 'existing' && e.edgeType === 'wiki-link')
      expect(links.length).toBe(1)
    })

    it('sourceNodeId 缺失抛 BizGraphError', () => {
      expect(() =>
        LintFixService.apply(
          { kind: 'create-stub-page', payload: { targetTitle: 'x' } },
          nodeRepo, edgeRepo,
        ),
      ).toThrow(BizGraphError)
    })

    it('sourceNodeId 不存在抛 BizGraphError', () => {
      expect(() =>
        LintFixService.apply(
          { kind: 'create-stub-page', payload: { sourceNodeId: 'missing', targetTitle: 'x' } },
          nodeRepo, edgeRepo,
        ),
      ).toThrow(BizGraphError)
    })

    it('targetTitle 为空抛 BizGraphError', () => {
      nodeRepo.nodes.set('a', wikiNode('a', '源页'))
      expect(() =>
        LintFixService.apply(
          { kind: 'create-stub-page', payload: { sourceNodeId: 'a', targetTitle: '   ' } },
          nodeRepo, edgeRepo,
        ),
      ).toThrow(BizGraphError)
    })
  })

  describe('add-frontmatter', () => {
    it('为缺 frontmatter 的页面补 title + createdAt', () => {
      nodeRepo.nodes.set('a', wikiNode('a', 'A'))
      const r = LintFixService.apply(
        { kind: 'add-frontmatter', payload: { nodeId: 'a' } },
        nodeRepo, edgeRepo,
      )
      expect(r.ok).toBe(true)
      const fm = (nodeRepo.findById('a')!.wikiMeta as Record<string, unknown>).frontmatter as Record<string, unknown>
      expect(fm.title).toBe('A')
      expect(fm.createdAt).toBe('2024-01-01T00:00:00Z')
    })

    it('不覆盖已有 frontmatter 字段', () => {
      nodeRepo.nodes.set('a', wikiNode('a', 'A', {
        wikiMeta: { frontmatter: { title: 'Custom Title', tags: ['x'] } },
      }))
      LintFixService.apply(
        { kind: 'add-frontmatter', payload: { nodeId: 'a' } },
        nodeRepo, edgeRepo,
      )
      const fm = (nodeRepo.findById('a')!.wikiMeta as Record<string, unknown>).frontmatter as Record<string, unknown>
      expect(fm.title).toBe('Custom Title') // 已有 → 保留
      expect(fm.tags).toEqual(['x'])
      expect(fm.createdAt).toBe('2024-01-01T00:00:00Z') // 缺失 → 补
    })

    it('nodeId 不存在抛 BizGraphError', () => {
      expect(() =>
        LintFixService.apply(
          { kind: 'add-frontmatter', payload: { nodeId: 'missing' } },
          nodeRepo, edgeRepo,
        ),
      ).toThrow(BizGraphError)
    })
  })

  describe('normalize-case', () => {
    it('把标题归一化为小写，并替换全图 wikiContent 中的 [[OldTitle]]', () => {
      const a = wikiNode('a', 'Graph Index', { wikiContent: '见 [[Graph Index]]' })
      const b = wikiNode('b', 'Other', { wikiContent: '也见 [[Graph Index|指针]]' })
      nodeRepo.nodes.set(a.id, a)
      nodeRepo.nodes.set(b.id, b)

      const r = LintFixService.apply(
        { kind: 'normalize-case', payload: { nodeId: 'a', newTitle: 'graph index' } },
        nodeRepo, edgeRepo,
      )
      expect(r.ok).toBe(true)

      // 节点 a 的 title 已归一化
      expect(nodeRepo.findById('a')!.title).toBe('graph index')
      // a 的 wikiContent 中的 [[Graph Index]] → [[graph index]]
      expect(nodeRepo.findById('a')!.wikiContent).toContain('[[graph index]]')
      // b 的 wikiContent 中的 [[Graph Index|指针]] → [[graph index|指针]]
      expect(nodeRepo.findById('b')!.wikiContent).toContain('[[graph index|指针]]')
      // 原大小写不应残留
      expect(nodeRepo.findById('b')!.wikiContent).not.toMatch(/\[\[Graph Index/)
    })

    it('已经是目标形态时 noop', () => {
      nodeRepo.nodes.set('a', wikiNode('a', 'graph index'))
      LintFixService.apply(
        { kind: 'normalize-case', payload: { nodeId: 'a', newTitle: 'graph index' } },
        nodeRepo, edgeRepo,
      )
      expect(nodeRepo.findById('a')!.title).toBe('graph index')
    })

    it('newTitle 为空抛 BizGraphError', () => {
      nodeRepo.nodes.set('a', wikiNode('a', 'A'))
      expect(() =>
        LintFixService.apply(
          { kind: 'normalize-case', payload: { nodeId: 'a', newTitle: '' } },
          nodeRepo, edgeRepo,
        ),
      ).toThrow(BizGraphError)
    })

    it('正则元字符（括号 / 点）在标题中不破坏替换', () => {
      nodeRepo.nodes.set('a', wikiNode('a', 'Foo (v1.0)', { wikiContent: '见 [[Foo (v1.0)]]' }))
      LintFixService.apply(
        { kind: 'normalize-case', payload: { nodeId: 'a', newTitle: 'foo (v1.0)' } },
        nodeRepo, edgeRepo,
      )
      expect(nodeRepo.findById('a')!.title).toBe('foo (v1.0)')
      expect(nodeRepo.findById('a')!.wikiContent).toContain('[[foo (v1.0)]]')
      // 不应触发未转义正则导致的灾难性回溯/错误匹配
      expect(nodeRepo.findById('a')!.wikiContent).not.toMatch(/\[\[Foo \(/)
    })
  })

  it('未知的 fix.kind 抛 BizGraphError', () => {
    expect(() =>
      LintFixService.apply(
        // @ts-expect-error 故意传入非法 kind
        { kind: 'unknown-fix', payload: {} },
        nodeRepo, edgeRepo,
      ),
    ).toThrow(BizGraphError)
  })
})
