/**
 * Wiki Ingest 服务（规则式文件导入）
 *
 * 把本地 markdown/txt 文件编译为 wiki-page 节点：
 * - 标题：frontmatter.title > 首个 H1 > 文件名（去扩展名）
 * - 同标题已存在 → 追加内容并标注来源分隔线；否则创建 draft 节点
 * - 批量先全部建/改完节点，再统一 syncNodeLinks（同批互链可解析）
 * - 单文件失败不阻塞整批
 *
 * readFile 以函数注入，便于测试且不绑定 fs 实现。
 *
 * 性能说明：第二遍逐节点 syncNodeLinks 每次会 listByGraph 全图扫描，
 * 复杂度 O(N²)。IPC 层限制单批 ≤100 文件，实测开销可接受；
 * 若未来放开批量上限，需先优化为批量同步（共享一次 listByGraph 结果）。
 */

import type { GraphEdge, GraphNode, GraphType } from '@shared/types'
import type { IngestResult } from '@shared/types/wiki'
import { basename } from 'path'
import { normalizeWikiTitle, parseWikiMarkdown } from './markdown-utils'
import { WikiLinkService } from '../services/wiki-link-service'

export interface IngestNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode
  update(id: string, data: Partial<GraphNode>): GraphNode
}

export interface IngestEdgeRepo {
  create(data: Omit<GraphEdge, 'id'>): GraphEdge
  delete(id: string): void
  listByGraph(graphId: string): GraphEdge[]
}

export type ReadFileFn = (path: string) => Promise<string>

/** 导入节点网格布局参数 */
const GRID_START_X = 0
const GRID_START_Y = 0
const GRID_COLS = 4
const GRID_GAP_X = 260
const GRID_GAP_Y = 180

function fileBaseName(filePath: string): string {
  return basename(filePath).replace(/\.(md|markdown|txt)$/i, '')
}

function gridPosition(index: number): { x: number; y: number } {
  return {
    x: GRID_START_X + (index % GRID_COLS) * GRID_GAP_X,
    y: GRID_START_Y + Math.floor(index / GRID_COLS) * GRID_GAP_Y,
  }
}

export class IngestService {
  static async ingestFiles(
    graphId: string,
    filePaths: string[],
    graphType: GraphType,
    nodeRepo: IngestNodeRepo,
    edgeRepo: IngestEdgeRepo,
    readFile: ReadFileFn,
  ): Promise<IngestResult> {
    const result: IngestResult = { created: [], updated: [], failed: [] }
    const touchedNodeIds: string[] = []

    // 第一遍：逐文件解析并创建/更新节点
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i]
      try {
        const markdown = await readFile(filePath)
        const parsed = parseWikiMarkdown(markdown)
        const rawTitle = parsed.title ?? fileBaseName(filePath)
        const title = normalizeWikiTitle(rawTitle)
        if (!title) {
          result.failed.push({ file: filePath, error: '无法确定页面标题（无 frontmatter.title、无 H1、文件名为空）' })
          continue
        }

        const existing = nodeRepo
          .listByGraph(graphId)
          .find((n) => n.type === 'wiki-page' && normalizeWikiTitle(n.title).toLowerCase() === title.toLowerCase())

        if (existing) {
          const separator = `\n\n---\n> 导入自 ${filePath} · ${new Date().toISOString()}\n\n`
          const appended = `${existing.wikiContent ?? ''}${separator}${parsed.body}`
          nodeRepo.update(existing.id, {
            wikiContent: appended,
            wikiMeta: { ...(existing.wikiMeta ?? {}), frontmatter: parsed.frontmatter, sourceFile: filePath, importedAt: new Date().toISOString() },
          })
          result.updated.push({ id: existing.id, title: existing.title })
          touchedNodeIds.push(existing.id)
        } else {
          const node = nodeRepo.create({
            type: 'wiki-page',
            status: 'draft',
            title,
            graphId,
            graphType,
            position: gridPosition(i),
            acceptanceCriteria: [],
            wikiContent: markdown,
            wikiMeta: { frontmatter: parsed.frontmatter, sourceFile: filePath, importedAt: new Date().toISOString() },
          })
          result.created.push({ id: node.id, title: node.title })
          touchedNodeIds.push(node.id)
        }
      } catch (err) {
        result.failed.push({ file: filePath, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 第二遍：统一落边（此时同批节点已全部入库，互链可解析）
    for (const nodeId of touchedNodeIds) {
      WikiLinkService.syncNodeLinks(nodeId, nodeRepo, edgeRepo)
    }

    return result
  }
}
