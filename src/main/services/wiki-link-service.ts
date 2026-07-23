/**
 * Wiki 链接服务
 *
 * wikilink 的唯一权威：解析（复用 markdown-utils）、按标题解析目标、
 * 将已解析链接持久化为 edges 表 edge_type='wiki-link' 的边、反向链接查询、
 * 全图断链扫描。悬空链接不入库，由 parseContent 实时标记。
 */

import type { GraphEdge, GraphNode } from '@shared/types'
import { extractWikiLinks, normalizeWikiTitle, parseWikiMarkdown } from '../wiki/markdown-utils'
import { WikiIndexService } from './wiki-index-service'

export interface WikiNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
}

export interface WikiEdgeRepo {
  create(data: Omit<GraphEdge, 'id'>): GraphEdge
  delete(id: string): void
  listByGraph(graphId: string): GraphEdge[]
}

export interface SyncLinksResult {
  added: GraphEdge[]
  removed: GraphEdge[]
  dangling: string[]
}

export interface WikiLinkResolution {
  targetTitle: string
  displayText?: string
  resolved: boolean
  nodeId?: string
}

export interface ParsedWikiContent {
  frontmatter: Record<string, unknown>
  title?: string
  links: WikiLinkResolution[]
}

export interface DanglingLink {
  fromNodeId: string
  fromTitle: string
  targetTitle: string
}

export class WikiLinkService {
  /**
   * 同步某个 wiki-page 节点的 wiki-link 出边。
   * 解析 wikiContent → 提取 wikilinks → 按标题解析目标 →
   * 与该节点现有 wiki-link 出边 diff → 增删。
   * 非 wiki-page 节点或不存在的节点返回空结果。
   */
  static syncNodeLinks(nodeId: string, nodeRepo: WikiNodeRepo, edgeRepo: WikiEdgeRepo): SyncLinksResult {
    const empty: SyncLinksResult = { added: [], removed: [], dangling: [] }
    const node = nodeRepo.findById(nodeId)
    if (!node || node.type !== 'wiki-page') return empty

    const targetIds = new Set<string>()
    const danglingTitles = new Set<string>()
    if (node.wikiContent) {
      for (const link of extractWikiLinks(node.wikiContent)) {
        const resolvedId = WikiIndexService.resolveWikiLink(node.graphId, link.targetTitle, nodeRepo)
        if (resolvedId) targetIds.add(resolvedId)
        else danglingTitles.add(normalizeWikiTitle(link.targetTitle))
      }
    }

    const existing = edgeRepo
      .listByGraph(node.graphId)
      .filter((e) => e.edgeType === 'wiki-link' && e.source === nodeId)
    const existingTargets = new Map(existing.map((e) => [e.target, e]))

    const added: GraphEdge[] = []
    for (const targetId of targetIds) {
      if (!existingTargets.has(targetId)) {
        added.push(edgeRepo.create({ source: nodeId, target: targetId, edgeType: 'wiki-link', graphId: node.graphId }))
      }
    }
    const removed: GraphEdge[] = []
    for (const [targetId, edge] of existingTargets) {
      if (!targetIds.has(targetId)) {
        edgeRepo.delete(edge.id)
        removed.push(edge)
      }
    }

    return { added, removed, dangling: [...danglingTitles] }
  }

  /** 实时解析（不落库），供前端渲染 wikilink 与 frontmatter */
  static parseContent(graphId: string, content: string, nodeRepo: WikiNodeRepo): ParsedWikiContent {
    const parsed = parseWikiMarkdown(content)
    const links: WikiLinkResolution[] = []
    const seen = new Set<string>()
    for (const link of extractWikiLinks(content)) {
      const key = normalizeWikiTitle(link.targetTitle).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const nodeId = WikiIndexService.resolveWikiLink(graphId, link.targetTitle, nodeRepo)
      links.push({
        targetTitle: link.targetTitle,
        ...(link.displayText ? { displayText: link.displayText } : {}),
        resolved: nodeId !== null,
        ...(nodeId ? { nodeId } : {}),
      })
    }
    return { frontmatter: parsed.frontmatter, title: parsed.title, links }
  }

  /** 反向链接：指向目标节点的 wiki-link 源页面 */
  static getBacklinks(nodeId: string, nodeRepo: WikiNodeRepo, edgeRepo: WikiEdgeRepo): GraphNode[] {
    const node = nodeRepo.findById(nodeId)
    if (!node) return []
    const sourceIds = edgeRepo
      .listByGraph(node.graphId)
      .filter((e) => e.edgeType === 'wiki-link' && e.target === nodeId)
      .map((e) => e.source)
    return [...new Set(sourceIds)]
      .map((id) => nodeRepo.findById(id))
      .filter((n): n is GraphNode => n !== null)
  }

  /** 全图断链扫描（Graph Lint 基础） */
  static findDanglingLinks(graphId: string, nodeRepo: WikiNodeRepo): DanglingLink[] {
    const result: DanglingLink[] = []
    for (const node of nodeRepo.listByGraph(graphId)) {
      if (node.type !== 'wiki-page' || !node.wikiContent) continue
      for (const link of extractWikiLinks(node.wikiContent)) {
        if (WikiIndexService.resolveWikiLink(graphId, link.targetTitle, nodeRepo) === null) {
          result.push({ fromNodeId: node.id, fromTitle: node.title, targetTitle: normalizeWikiTitle(link.targetTitle) })
        }
      }
    }
    return result
  }
}
