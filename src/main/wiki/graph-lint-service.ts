/**
 * Graph Lint 服务：只读聚合断链、孤立节点、社区异常、frontmatter/标题问题为 LintReport。
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

/**
 * 判断 wiki 节点是否"缺少有效 frontmatter"。
 *
 * 规则：
 * - wikiContent 为空 → 视为缺（连 frontmatter 都写不进去）
 * - wikiMeta.frontmatter 不存在 / 不是对象 / 为空对象 → 视为缺
 * - 特殊页（Graph Index / Log / Community）由调用方在循环里提前 skip，这里不再判断
 */
function hasUsableFrontmatter(node: GraphNode): boolean {
  const meta = node.wikiMeta as WikiNodeMeta | undefined
  const fm = meta?.frontmatter
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return false
  return Object.keys(fm).length > 0
}

/**
 * 判定标题是否"大小写不规范"——归一化（trim + 全角空格 → 半角 + 合并空白 + 小写）后与原文不同。
 * 例：`"Graph Index"` → `"graph index"`，原文首字母大写被认为不规范。
 */
function hasInconsistentTitleCase(title: string): boolean {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ')
  return title !== normalized && title.trim().length > 0
}

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
        kind: 'dangling-link',
        code: 'dangling-link',
        severity: 'warning',
        nodeId: d.fromNodeId,
        location: { file: d.fromNodeId },
        message: `「${d.fromTitle}」引用了不存在的页面 [[${d.targetTitle}]]`,
        hint: '创建该页面，或修正链接标题',
        fixable: true,
        fix: {
          kind: 'create-stub-page',
          payload: { sourceNodeId: d.fromNodeId, targetTitle: d.targetTitle },
        },
      })
    }

    const hasEdge = new Set<string>()
    // 自环边（页面只链接自己）不构成连通性，不计入 orphan 判定
    for (const e of edges) {
      if (e.source === e.target) continue
      hasEdge.add(e.source); hasEdge.add(e.target)
    }

    const isSpecial = (p: GraphNode): boolean =>
      Boolean((p.wikiMeta as WikiNodeMeta | undefined)?.specialPage)

    for (const p of pages) {
      if (isSpecial(p)) continue

      // orphan
      if (!hasEdge.has(p.id)) {
        issues.push({
          kind: 'orphan',
          code: 'orphan',
          severity: 'info',
          nodeId: p.id,
          location: { file: p.id },
          message: `「${p.title}」没有任何 wikilink 连接`,
          hint: '在相关页面中添加指向它的 [[链接]]，或在它正文中链接到其他页面',
          fixable: false,
        })
      }

      // missing-frontmatter：仅对普通 wiki 页生效
      if (!hasUsableFrontmatter(p)) {
        issues.push({
          kind: 'missing-frontmatter',
          code: 'missing-frontmatter',
          severity: 'warning',
          nodeId: p.id,
          location: { file: p.id },
          message: `「${p.title}」缺少 frontmatter（title / createdAt 等元信息）`,
          hint: '补一份最小 frontmatter（含 title 与 createdAt）',
          fixable: true,
          fix: {
            kind: 'add-frontmatter',
            payload: { nodeId: p.id },
          },
        })
      }

      // inconsistent-case：标题与归一化（小写 + 合并空白）形态不同
      if (hasInconsistentTitleCase(p.title)) {
        const normalized = p.title.trim().toLowerCase().replace(/\s+/g, ' ')
        issues.push({
          kind: 'inconsistent-case',
          code: 'inconsistent-case',
          severity: 'info',
          nodeId: p.id,
          location: { file: p.id },
          message: `「${p.title}」大小写或空白不规范，建议统一为「${normalized}」`,
          hint: '归一化标题为小写，避免 wikilink 大小写错配',
          fixable: true,
          fix: {
            kind: 'normalize-case',
            payload: { nodeId: p.id, newTitle: normalized },
          },
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
          kind: 'community-singleton',
          code: 'community-singleton',
          severity: 'info',
          nodeId: members[0].id,
          location: { file: members[0].id },
          message: `「${members[0].title}」自成一社区，疑似游离`,
          hint: '增加它与其它页面之间的 wikilink，重新计算社区',
          fixable: false,
        })
      } else if (total > 0 && members.length / total > OVERSIZED_RATIO) {
        const representative = members[0].title
        issues.push({
          kind: 'community-oversized',
          code: 'community-oversized',
          severity: 'warning',
          message: `社区「${representative}」含 ${members.length}/${total} 页（>${OVERSIZED_RATIO * 100}%），疑似未分化`,
          hint: '调高 Louvain resolution 细分，或检查是否有过度互联的枢纽页',
          fixable: false,
        })
      }
    }

    return {
      issues,
      stats: { nodeCount: pages.length, edgeCount: edges.length, communityCount: byCommunity.size },
    }
  }
}
