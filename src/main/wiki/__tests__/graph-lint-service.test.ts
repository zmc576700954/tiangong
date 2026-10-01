import { describe, it, expect, beforeEach } from 'vitest'
import { GraphLintService } from '../graph-lint-service'
import type { GraphNode, GraphEdge } from '@shared/types'

function wikiNode(id: string, title: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, type: 'wiki-page', status: 'draft', title, graphId: 'g1', graphType: 'online',
    position: { x: 0, y: 0 }, createdAt: '', updatedAt: '', ...extra,
  } as GraphNode
}
class MemNodeRepo {
  nodes = new Map<string, GraphNode>()
  findById = (id: string) => this.nodes.get(id) ?? null
  listByGraph = (gid: string) => [...this.nodes.values()].filter((n) => n.graphId === gid)
}
class MemEdgeRepo {
  edges: GraphEdge[] = []
  listByGraph = (gid: string) => this.edges.filter((e) => e.graphId === gid)
}

describe('GraphLintService.lint', () => {
  let nodeRepo: MemNodeRepo
  let edgeRepo: MemEdgeRepo
  beforeEach(() => { nodeRepo = new MemNodeRepo(); edgeRepo = new MemEdgeRepo() })

  it('断链 → dangling-link', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { wikiContent: '见 [[不存在的页]]' }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'dangling-link')).toBe(true)
  })

  it('社区页的断链是噪音被排除；普通页指向社区页同名的断链仍报', () => {
    nodeRepo.nodes.set('comm', wikiNode('comm', '社区：X', {
      wikiContent: '成员：[[不存在的成员]]',
      wikiMeta: { specialPage: 'community' },
    }))
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { wikiContent: '见 [[也不存在]]' }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    const dangling = r.issues.filter((i) => i.kind === 'dangling-link')
    expect(dangling.length).toBe(1)
    expect(dangling[0].nodeId).toBe('a')
  })

  it('无入边无出边的普通页 → orphan；特殊页不计', () => {
    nodeRepo.nodes.set('a', wikiNode('a', '孤儿页'))
    nodeRepo.nodes.set('idx', wikiNode('idx', 'Graph Index', {
      wikiMeta: { specialPage: 'index' },
    }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    const orphans = r.issues.filter((i) => i.kind === 'orphan')
    expect(orphans.length).toBe(1)
    expect(orphans[0].nodeId).toBe('a')
  })

  it('有边的页面不算 orphan', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A'))
    nodeRepo.nodes.set('b', wikiNode('b', 'B'))
    edgeRepo.edges.push({ id: 'e1', source: 'a', target: 'b', edgeType: 'wiki-link', graphId: 'g1' })
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'orphan')).toBe(false)
  })

  it('只有自环边的页面仍算 orphan', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A'))
    edgeRepo.edges.push({ id: 'e1', source: 'a', target: 'a', edgeType: 'wiki-link', graphId: 'g1' })
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    const orphans = r.issues.filter((i) => i.kind === 'orphan')
    expect(orphans.length).toBe(1)
    expect(orphans[0].nodeId).toBe('a')
  })

  it('单节点社区 → community-singleton', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { communityId: 'c1', communityLevel: 2 }))
    nodeRepo.nodes.set('b', wikiNode('b', 'B', { communityId: 'c2', communityLevel: 2 }))
    nodeRepo.nodes.set('c', wikiNode('c', 'C', { communityId: 'c2', communityLevel: 2 }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'community-singleton')).toBe(true)
  })

  it('超大社区（>50%）→ community-oversized', () => {
    for (let i = 0; i < 4; i++) nodeRepo.nodes.set(`n${i}`, wikiNode(`n${i}`, `N${i}`, { communityId: 'big' }))
    nodeRepo.nodes.set('x', wikiNode('x', 'X', { communityId: 'small' }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'community-oversized')).toBe(true)
  })

  it('stats 正确统计节点/边/社区数', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { communityId: 'c1' }))
    nodeRepo.nodes.set('b', wikiNode('b', 'B', { communityId: 'c1' }))
    edgeRepo.edges.push({ id: 'e1', source: 'a', target: 'b', edgeType: 'wiki-link', graphId: 'g1' })
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.stats.nodeCount).toBe(2)
    expect(r.stats.edgeCount).toBe(1)
    expect(r.stats.communityCount).toBe(1)
  })

  it('wikiContent 不空且 frontmatter 为空 → missing-frontmatter', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { wikiContent: '正文' }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    const fm = r.issues.filter((i) => i.kind === 'missing-frontmatter')
    expect(fm.length).toBe(1)
    expect(fm[0].fixable).toBe(true)
    expect(fm[0].fix?.kind).toBe('add-frontmatter')
  })

  it('wikiMeta.frontmatter 是非空对象 → 不报 missing-frontmatter', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', {
      wikiContent: '正文',
      wikiMeta: { frontmatter: { title: 'A' } },
    }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'missing-frontmatter')).toBe(false)
  })

  it('标题大小写不规范 → inconsistent-case（fixable=true）', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'Graph Index'))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    const ic = r.issues.filter((i) => i.kind === 'inconsistent-case')
    expect(ic.length).toBe(1)
    expect(ic[0].fixable).toBe(true)
    expect(ic[0].fix?.kind).toBe('normalize-case')
  })

  it('标题已全部小写 → 不报 inconsistent-case', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'graph index'))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'inconsistent-case')).toBe(false)
  })

  it('断链 issue 携带 fixable=true 与 create-stub-page 修复动作', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { wikiContent: '见 [[missing]]' }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    const dl = r.issues.filter((i) => i.kind === 'dangling-link')
    expect(dl.length).toBe(1)
    expect(dl[0].fixable).toBe(true)
    expect(dl[0].fix?.kind).toBe('create-stub-page')
    expect((dl[0].fix?.payload as { targetTitle?: string }).targetTitle).toBe('missing')
    expect(dl[0].location?.file).toBe('a')
  })

  it('orphan issue fixable=false（无一键修复）', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A'))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    const o = r.issues.filter((i) => i.kind === 'orphan')
    expect(o.length).toBe(1)
    expect(o[0].fixable).toBe(false)
  })
})
