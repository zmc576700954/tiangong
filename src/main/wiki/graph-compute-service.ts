/**
 * 图计算服务：编排 Louvain 社区发现 + 写回 + 社区页差量维护。
 *
 * 仅基于 edge_type='wiki-link' 的边构图。社区页规则化生成（非 LLM），
 * 采用差量更新：新社区建页、已存在重写正文、消失的社区删页，避免
 * 引用社区页的 wikilink 断裂。注入内存 repo 即可单测。
 */

import type { GraphEdge, GraphNode, WikiNodeMeta } from '@shared/types'
import type { CommunityInfo, ComputeResult } from '@shared/types/wiki'
import { louvain } from './louvain'
import { stringifyWikiMarkdown } from './markdown-utils'

export interface ComputeNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode
  update(id: string, data: Partial<GraphNode>): GraphNode
  delete(id: string): void
}
export interface ComputeEdgeRepo {
  create(data: Omit<GraphEdge, 'id'>): GraphEdge
  delete(id: string): void
  listByGraph(graphId: string): GraphEdge[]
}

const COMMUNITY_PAGE_TAG = 'community'

export class GraphComputeService {
  static computeCommunities(graphId: string, nodeRepo: ComputeNodeRepo, edgeRepo: ComputeEdgeRepo): ComputeResult {
    const pages = nodeRepo
      .listByGraph(graphId)
      .filter((n) => n.type === 'wiki-page' && (n.wikiMeta as WikiNodeMeta | undefined)?.specialPage !== COMMUNITY_PAGE_TAG)
    const edges = edgeRepo.listByGraph(graphId).filter((e) => e.edgeType === 'wiki-link')

    const empty: ComputeResult = { communityCount: 0, nodeCount: pages.length, modularity: 0, communities: [] }
    if (pages.length < 2 || edges.length === 0) return empty

    const pageIds = new Set(pages.map((p) => p.id))
    const louvainEdges = edges
      .filter((e) => pageIds.has(e.source) && pageIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, weight: e.strength ?? 1 }))

    const assignment = louvain({ nodeIds: [...pageIds], edges: louvainEdges }, { seed: 42 })
    const communityIds = assignment.communities()
    if (communityIds.length === 0) return empty

    const members = new Map<string, string[]>()
    for (const cid of communityIds) members.set(cid, [])
    for (const pid of pageIds) {
      const cid = assignment.communityOf(pid)
      if (cid) members.get(cid)!.push(pid)
    }

    const total = pageIds.size
    for (const [cid, ids] of members) {
      const ratio = ids.length / total
      const level = ratio > 0.5 ? 0 : ratio > 0.1 ? 1 : 2
      for (const id of ids) {
        nodeRepo.update(id, { communityId: cid, communityLevel: level })
      }
    }

    const communities: CommunityInfo[] = []
    for (const [cid, ids] of members) {
      let internal = 0
      let external = 0
      const idSet = new Set(ids)
      for (const e of edges) {
        if (idSet.has(e.source) && idSet.has(e.target)) internal++
        else if (idSet.has(e.source) || idSet.has(e.target)) external++
      }
      communities.push({ id: cid, memberIds: ids, size: ids.length, internalEdges: internal, externalEdges: external })
    }

    this.syncCommunityPages(graphId, pages, communities, members, nodeRepo)

    return { communityCount: communityIds.length, nodeCount: total, modularity: assignment.modularity(), communities }
  }

  private static syncCommunityPages(
    graphId: string,
    pages: GraphNode[],
    communities: CommunityInfo[],
    members: Map<string, string[]>,
    nodeRepo: ComputeNodeRepo,
  ): void {
    const titleOf = new Map(pages.map((p) => [p.id, p.title]))
    const existingCommunityPages = nodeRepo
      .listByGraph(graphId)
      .filter((n) => (n.wikiMeta as WikiNodeMeta | undefined)?.specialPage === COMMUNITY_PAGE_TAG)
    const byCommunityId = new Map(
      existingCommunityPages.map((n) => [((n.wikiMeta as WikiNodeMeta).frontmatter?.communityId as string) ?? '', n]),
    )

    const aliveIds = new Set(communities.map((c) => c.id))
    for (const [cid, page] of byCommunityId) {
      if (cid && !aliveIds.has(cid)) nodeRepo.delete(page.id)
    }

    for (const c of communities) {
      const ids = members.get(c.id)!
      const repTitle = ids.map((id) => titleOf.get(id) ?? id).sort()[0] ?? c.id
      const memberLinks = ids
        .map((id) => `- [[${titleOf.get(id) ?? id}]]`)
        .sort()
        .join('\n')
      const frontmatter: Record<string, unknown> = {
        title: `社区 · ${repTitle}`,
        specialPage: 'community',
        communityId: c.id,
      }
      const body = `# 社区 · ${repTitle}\n\n> 本页由图计算自动生成，请勿手工编辑。\n\n## 成员（${c.size}）\n${memberLinks}\n\n## 统计\n- 内部链接：${c.internalEdges} · 外部链接：${c.externalEdges}`
      const wikiContent = stringifyWikiMarkdown(frontmatter, body)

      const existing = byCommunityId.get(c.id)
      const wikiMeta: WikiNodeMeta = { specialPage: 'community', frontmatter, tags: ['special', 'community'] }
      if (existing) {
        nodeRepo.update(existing.id, { title: `社区 · ${repTitle}`, wikiContent, wikiMeta: wikiMeta as Record<string, unknown> })
      } else {
        nodeRepo.create({
          type: 'wiki-page', status: 'confirmed', title: `社区 · ${repTitle}`,
          graphId, graphType: pages[0]?.graphType ?? 'online',
          position: { x: 0, y: 0 }, wikiContent,
          wikiMeta: wikiMeta as Record<string, unknown>,
        })
      }
    }
  }
}
