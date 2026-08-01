/**
 * Graph Lint 服务：只读聚合断链、孤立节点、社区异常为 LintReport。
 * 不写库、不缓存、不修复。修复动作全部回到既有入口（建页/改链/重算社区）。
 */

import type { GraphEdge, GraphNode, WikiNodeMeta } from '@shared/types'
import type { LintIssue, LintReport } from '@shared/types/wiki'
import { WikiLinkService } from '../services/wiki-link-service'

export interface LintNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
}
export interface LintEdgeRepo {
  listByGraph(graphId: string): GraphEdge[]
}

const OVERSIZED_RATIO = 0.5

export class GraphLintService {
  static lint(graphId: string, nodeRepo: LintNodeRepo, edgeRepo: LintEdgeRepo): LintReport {
    const issues: LintIssue[] = []
    const pages = nodeRepo.listByGraph(graphId).filter((n) => n.type === 'wiki-page')
    const edges = edgeRepo.listByGraph(graphId).filter((e) => e.edgeType === 'wiki-link')
    // 社区页内容自动生成且不落边，其成员链接的断链报告是噪音（下次重算即再生）
    const communityPages = new Set(
      pages.filter((p) => (p.wikiMeta as WikiNodeMeta | undefined)?.specialPage === 'community').map((p) => p.id)
    )

    for (const d of WikiLinkService.findDanglingLinks(graphId, nodeRepo)) {
      if (communityPages.has(d.fromNodeId)) continue
      issues.push({
        kind: 'dangling-link', severity: 'warning', nodeId: d.fromNodeId,
        message: `「${d.fromTitle}」引用了不存在的页面 [[${d.targetTitle}]]`,
        hint: '创建该页面，或修正链接标题',
      })
    }

    const hasEdge = new Set<string>()
    // 自环边（页面只链接自己）不构成连通性，不计入 orphan 判定
    for (const e of edges) {
      if (e.source === e.target) continue
      hasEdge.add(e.source); hasEdge.add(e.target)
    }
    for (const p of pages) {
      if ((p.wikiMeta as WikiNodeMeta | undefined)?.specialPage) continue
      if (!hasEdge.has(p.id)) {
        issues.push({
          kind: 'orphan', severity: 'info', nodeId: p.id,
          message: `「${p.title}」没有任何 wikilink 连接`,
          hint: '在相关页面中添加指向它的 [[链接]]，或在它正文中链接到其他页面',
        })
      }
    }

    const byCommunity = new Map<string, GraphNode[]>()
    for (const p of pages) {
      if (!p.communityId) continue
      if (!byCommunity.has(p.communityId)) byCommunity.set(p.communityId, [])
      byCommunity.get(p.communityId)!.push(p)
    }
    const total = pages.length
    for (const [, members] of byCommunity) {
      if (members.length === 1) {
        issues.push({
          kind: 'community-singleton', severity: 'info', nodeId: members[0].id,
          message: `「${members[0].title}」自成一社区，疑似游离`,
          hint: '增加它与其它页面之间的 wikilink，重新计算社区',
        })
      } else if (total > 0 && members.length / total > OVERSIZED_RATIO) {
        const representative = members[0].title
        issues.push({
          kind: 'community-oversized', severity: 'warning',
          message: `社区「${representative}」含 ${members.length}/${total} 页（>${OVERSIZED_RATIO * 100}%），疑似未分化`,
          hint: '调高 Louvain resolution 细分，或检查是否有过度互联的枢纽页',
        })
      }
    }

    return {
      issues,
      stats: { nodeCount: pages.length, edgeCount: edges.length, communityCount: byCommunity.size },
    }
  }
}
