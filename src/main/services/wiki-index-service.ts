/**
 * Wiki 特殊页服务
 *
 * 为每个图自动创建并维护两个特殊 wiki-page 节点：
 * - Graph Index：索引页，包含指向 Graph Log 的 wikilink
 * - Graph Log：变更日志页
 *
 * 同时提供基于标题的 wikilink 解析能力。
 */

import type { GraphType, WikiNodeMeta } from '@shared/types'
import type { GraphNode } from '@shared/types'
import { GRAPH_INDEX_TITLE, GRAPH_LOG_TITLE, WIKI_PAGE_TYPE } from '@shared/constants'
import { normalizeWikiTitle, stringifyWikiMarkdown } from '../wiki/markdown-utils'

export interface CreateSpecialPagesResult {
  indexId: string
  logId: string
}

export interface WikiNodeRepository {
  create?(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode
  listByGraph(graphId: string): GraphNode[]
}

export class WikiIndexService {
  /**
   * 为指定图创建 Graph Index / Graph Log 两个 wiki-page 节点。
   * 调用方应确保图内尚不存在特殊页，否则会产生重复。
   */
  static async createSpecialPages(
    graphId: string,
    graphType: GraphType,
    nodeRepo: WikiNodeRepository,
  ): Promise<CreateSpecialPagesResult> {
    if (!nodeRepo.create) throw new TypeError('WikiNodeRepository.create is required for createSpecialPages')
    const indexId = this.createWikiPage(graphId, graphType, 'index', nodeRepo)
    const logId = this.createWikiPage(graphId, graphType, 'log', nodeRepo)
    return { indexId, logId }
  }

  /**
   * 确保指定图包含 Graph Index / Graph Log 两个特殊页。
   * 已存在的特殊页不会被重复创建。
   */
  static async ensureSpecialPages(
    graphId: string,
    graphType: GraphType,
    nodeRepo: WikiNodeRepository,
  ): Promise<CreateSpecialPagesResult> {
    if (!nodeRepo.create) throw new TypeError('WikiNodeRepository.create is required for ensureSpecialPages')
    const nodes = nodeRepo.listByGraph(graphId)
    const existing = new Map<'index' | 'log', string>()

    for (const node of nodes) {
      if (node.type !== WIKI_PAGE_TYPE) continue
      const special = (node.wikiMeta as WikiNodeMeta | undefined)?.specialPage
      if (special === 'index' || special === 'log') {
        existing.set(special, node.id)
      }
    }

    const indexId = existing.get('index') ?? this.createWikiPage(graphId, graphType, 'index', nodeRepo)
    const logId = existing.get('log') ?? this.createWikiPage(graphId, graphType, 'log', nodeRepo)

    return { indexId, logId }
  }

  /**
   * 在当前图的 wiki-page 节点中，按标题解析 wikilink 目标。
   * 标题会经过 normalizeWikiTitle 归一化后比较。
   *
   * @returns 目标节点 ID，未找到时返回 null
   */
  static resolveWikiLink(
    graphId: string,
    targetTitle: string,
    nodeRepo: WikiNodeRepository,
  ): string | null {
    const normalized = normalizeWikiTitle(targetTitle).toLowerCase()
    if (!normalized) return null

    const nodes = nodeRepo.listByGraph(graphId)
    for (const node of nodes) {
      if (node.type !== WIKI_PAGE_TYPE) continue
      if (normalizeWikiTitle(node.title).toLowerCase() === normalized) {
        return node.id
      }
    }

    return null
  }

  /** 仅 createSpecialPages / ensureSpecialPages 调用；二者入口已守卫 create 存在 */
  private static createWikiPage(
    graphId: string,
    graphType: GraphType,
    kind: 'index' | 'log',
    nodeRepo: WikiNodeRepository,
  ): string {
    const title = kind === 'index' ? GRAPH_INDEX_TITLE : GRAPH_LOG_TITLE
    const frontmatter: Record<string, unknown> = {
      title,
      specialPage: kind,
    }

    if (kind === 'index') {
      frontmatter.description = `Index of ${graphType} graph ${graphId}`
    }

    const body =
      kind === 'index'
        ? `# ${GRAPH_INDEX_TITLE}\n\n- Graph Log: [[${GRAPH_LOG_TITLE}]]`
        : `# ${GRAPH_LOG_TITLE}\n\n记录本图的变更日志。`

    const wikiContent = stringifyWikiMarkdown(frontmatter, body)
    const wikiMeta: WikiNodeMeta = {
      specialPage: kind,
      tags: ['special'],
    }

    const data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> = {
      type: WIKI_PAGE_TYPE,
      status: 'confirmed',
      title,
      graphId,
      graphType,
      position: { x: kind === 'index' ? 0 : 220, y: 0 },
      wikiContent,
      wikiMeta: wikiMeta as Record<string, unknown>,
    }

    const node = nodeRepo.create!(data)
    return node.id
  }
}
