import { describe, it, expect, beforeEach } from 'vitest'
import { GraphComputeService } from '../graph-compute-service'
import type { GraphNode, GraphEdge } from '@shared/types'

function makeNode(id: string, title: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, type: 'wiki-page', status: 'draft', title,
    graphId: 'g1', graphType: 'online',
    position: { x: 0, y: 0 },
    createdAt: '', updatedAt: '',
    ...extra,
  } as GraphNode
}

class MemNodeRepo {
  nodes = new Map<string, GraphNode>()
  findById = (id: string) => this.nodes.get(id) ?? null
  listByGraph = (gid: string) => [...this.nodes.values()].filter((n) => n.graphId === gid)
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
    const n = { ...data, id: `n${this.nodes.size}`, createdAt: '', updatedAt: '' } as GraphNode
    this.nodes.set(n.id, n)
    return n
  }
  update(id: string, data: Partial<GraphNode>): GraphNode {
    const n = this.nodes.get(id)!
    const u = { ...n, ...data }
    this.nodes.set(id, u)
    return u
  }
  delete(id: string) { this.nodes.delete(id) }
}
class MemEdgeRepo {
  edges = new Map<string, GraphEdge>()
  private seq = 0
  create(data: Omit<GraphEdge, 'id'>): GraphEdge {
    const e = { ...data, id: `e${this.seq++}` } as GraphEdge
    this.edges.set(e.id, e)
    return e
  }
  delete(id: string) { this.edges.delete(id) }
  listByGraph = (gid: string) => [...this.edges.values()].filter((e) => e.graphId === gid)
}

describe('GraphComputeService.computeCommunities', () => {
  let nodeRepo: MemNodeRepo
  let edgeRepo: MemEdgeRepo
  beforeEach(() => { nodeRepo = new MemNodeRepo(); edgeRepo = new MemEdgeRepo() })

  function link(a: string, b: string) {
    edgeRepo.create({ source: a, target: b, edgeType: 'wiki-link', graphId: 'g1' })
  }

  it('空图 / 节点数<2 返回空结果且不写回', () => {
    nodeRepo.nodes.set('a', makeNode('a', 'A'))
    const r = GraphComputeService.computeCommunities('g1', nodeRepo, edgeRepo)
    expect(r.communityCount).toBe(0)
    expect(nodeRepo.nodes.get('a')!.communityId).toBeUndefined()
  })

  it('两团各成社区并写回 communityId，且生成社区页', () => {
    ;['a', 'b', 'c', 'd', 'e', 'f'].forEach((id) => nodeRepo.nodes.set(id, makeNode(id, id.toUpperCase())))
    link('a', 'b'); link('b', 'c'); link('a', 'c')
    link('d', 'e'); link('e', 'f'); link('d', 'f')
    link('c', 'd')
    const r = GraphComputeService.computeCommunities('g1', nodeRepo, edgeRepo)
    expect(r.communityCount).toBe(2)
    expect(nodeRepo.nodes.get('a')!.communityId).toBe(nodeRepo.nodes.get('b')!.communityId)
    expect(nodeRepo.nodes.get('a')!.communityId).not.toBe(nodeRepo.nodes.get('d')!.communityId)
    const communityPages = [...nodeRepo.nodes.values()].filter(
      (n) => (n.wikiMeta as { specialPage?: string } | undefined)?.specialPage === 'community',
    )
    expect(communityPages.length).toBe(2)
  })

  it('幂等：连跑两次 communityId 稳定、社区页不重复', () => {
    ;['a', 'b', 'c', 'd', 'e', 'f'].forEach((id) => nodeRepo.nodes.set(id, makeNode(id, id.toUpperCase())))
    link('a', 'b'); link('b', 'c'); link('a', 'c')
    link('d', 'e'); link('e', 'f'); link('d', 'f')
    link('c', 'd')
    const r1 = GraphComputeService.computeCommunities('g1', nodeRepo, edgeRepo)
    const firstIds = new Map([...nodeRepo.nodes.values()].map((n) => [n.id, n.communityId]))
    const r2 = GraphComputeService.computeCommunities('g1', nodeRepo, edgeRepo)
    expect(r2.communityCount).toBe(r1.communityCount)
    const communityPages = [...nodeRepo.nodes.values()].filter(
      (n) => (n.wikiMeta as { specialPage?: string } | undefined)?.specialPage === 'community',
    )
    expect(communityPages.length).toBe(2)
    for (const [id, cid] of firstIds) {
      if (cid) expect(nodeRepo.nodes.get(id)!.communityId).toBe(cid)
    }
  })
})
