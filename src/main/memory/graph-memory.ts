/**
 * 图结构记忆 —— 将记忆表示为知识图谱中的节点和关系边
 *
 * 在现有 MindMap 图结构之上增加"记忆作为节点"的能力：
 *   每个 MemoryItem 对应一个"记忆节点"
 *   记忆之间通过"关系边"连接（如 caused_by, depends_on, supersedes）
 *
 * 核心能力:
 *   1. 将 MemoryItem 转换为记忆节点（MemoryNode）
 *   2. 自动推断记忆之间的因果关系和依赖边
 *   3. 支持图遍历查询（如"找出所有相关的修复"）
 *   4. 与现有 GraphService 集成，在可视化中展示记忆网络
 *
 * 边类型:
 *   - caused_by:   B 是由 A 引起的（A → B）
 *   - depends_on:  B 依赖于 A 的实现
 *   - supersedes:  B 替代/更新了 A
 *   - relates_to:  B 与 A 有一般关联
 *   - contradicts: B 与 A 矛盾
 *
 * 用法:
 *   const graph = new GraphMemory(memoryStore)
 *   const relations = graph.inferRelations(newMemory, existingMemories)
 *   const traversal = graph.traverse(memoryId, { depth: 2 })
 */

import type { MemoryItem } from '@shared/types'
import type { MemoryStore } from './memory-store'
import { createLogger } from '../shared/logger'

const logger = createLogger('GraphMemory')

// ============================================
// 类型定义
// ============================================

/** 记忆之间的关系类型 */
export type MemoryRelationType =
  | 'caused_by'
  | 'depends_on'
  | 'supersedes'
  | 'relates_to'
  | 'contradicts'

/** 记忆节点：MemoryItem 在图中的表示 */
export interface MemoryNode {
  /** 记忆 ID（与 MemoryItem.id 一致） */
  id: number
  /** 记忆项 */
  memory: MemoryItem
  /** 入边（指向此节点的关系） */
  incomingEdges: MemoryEdge[]
  /** 出边（从此节点指向其他节点的关系） */
  outgoingEdges: MemoryEdge[]
}

/** 记忆之间的关系边 */
export interface MemoryEdge {
  /** 关系类型 */
  relation: MemoryRelationType
  /** 源节点 ID（关系的发起方） */
  sourceId: number
  /** 目标节点 ID（关系的接收方） */
  targetId: number
  /** 关系推断的置信度 0-1 */
  confidence: number
  /** 关系推断的原因 */
  reason: string
}

/** 图遍历结果 */
export interface GraphTraversalResult {
  /** 起始节点 */
  root: MemoryNode
  /** 按距离分组的节点路径 */
  paths: MemoryNode[][]
  /** 总节点数 */
  totalNodes: number
  /** 总边数 */
  totalEdges: number
}

/** GraphMemory 配置 */
export interface GraphMemoryConfig {
  /** 推断关系的最大距离（跳数） */
  maxInferenceDepth: number
  /** 关系推断的最低置信度 */
  minRelationConfidence: number
  /** 遍历的最大深度 */
  maxTraversalDepth: number
}

const DEFAULT_CONFIG: GraphMemoryConfig = {
  maxInferenceDepth: 2,
  minRelationConfidence: 0.3,
  maxTraversalDepth: 3,
}

// ============================================
// GraphMemory 主类
// ============================================

export class GraphMemory {
  private config: GraphMemoryConfig
  private memoryStore: MemoryStore

  constructor(memoryStore: MemoryStore, config?: Partial<GraphMemoryConfig>) {
    this.memoryStore = memoryStore
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 将单个 MemoryItem 包装为 MemoryNode
   */
  wrapNode(memory: MemoryItem): MemoryNode {
    return {
      id: memory.id,
      memory,
      incomingEdges: [],
      outgoingEdges: [],
    }
  }

  /**
   * 自动推断新记忆与已有记忆之间的关系
   *
   * 推断规则（启发式）:
   *   1. caused_by: 一个 fix 前面有相关的 investigation → investigation → fix
   *   2. depends_on: 一个 fix 修改了之前某条记忆也修改过的文件
   *   3. supersedes: 同一文件的后续修改（更新的 fix 取代旧的 fix）
   *   4. relates_to: 共享相同概念标签的记忆
   *   5. contradicts: 两条记忆对同一问题的结论相反
   *
   * @param newMemory - 新产生的记忆
   * @param existingMemories - 已有的相关记忆（通常来自同项目最近记忆）
   */
  inferRelations(
    newMemory: MemoryItem,
    existingMemories: MemoryItem[],
  ): MemoryEdge[] {
    const edges: MemoryEdge[] = []

    for (const existing of existingMemories) {
      if (existing.id === newMemory.id) continue

      // 1. caused_by: fix 前面的 investigation
      if (
        newMemory.kind === 'fix' &&
        existing.kind === 'investigation' &&
        this._shareContext(newMemory, existing)
      ) {
        edges.push({
          relation: 'caused_by',
          sourceId: existing.id,
          targetId: newMemory.id,
          confidence: 0.7,
          reason: `Fix "${newMemory.title}" was likely caused by investigation "${existing.title}"`,
        })
      }

      // 2. depends_on: 修改了相同的文件
      const sharedFiles = this._intersectArrays(
        newMemory.files_modified,
        existing.files_modified,
      )
      if (sharedFiles.length > 0 && newMemory.kind === 'fix' && existing.kind === 'fix') {
        edges.push({
          relation: 'depends_on',
          sourceId: existing.id,
          targetId: newMemory.id,
          confidence: Math.min(0.8, 0.4 + sharedFiles.length * 0.2),
          reason: `Both modify: ${sharedFiles.slice(0, 3).join(', ')}`,
        })
      }

      // 3. supersedes: 同一文件的后续 fix 取代先前 fix
      if (
        sharedFiles.length > 0 &&
        newMemory.kind === 'fix' &&
        existing.kind === 'fix' &&
        newMemory.created_at > existing.created_at
      ) {
        edges.push({
          relation: 'supersedes',
          sourceId: newMemory.id,
          targetId: existing.id,
          confidence: 0.6,
          reason: `Newer fix supersedes older fix on same files`,
        })
      }

      // 4. relates_to: 共享概念标签
      const sharedConcepts = this._intersectArrays(
        newMemory.concepts,
        existing.concepts,
      )
      if (sharedConcepts.length > 0) {
        edges.push({
          relation: 'relates_to',
          sourceId: newMemory.id,
          targetId: existing.id,
          confidence: sharedConcepts.length / Math.max(newMemory.concepts.length, 1),
          reason: `Shared concepts: ${sharedConcepts.join(', ')}`,
        })
      }

      // 5. contradicts: 两条 review_finding 或 investigation 的结论相反
      if (
        (newMemory.kind === 'review_finding' || newMemory.kind === 'investigation') &&
        (existing.kind === 'review_finding' || existing.kind === 'investigation') &&
        this._seemContradictory(newMemory, existing)
      ) {
        edges.push({
          relation: 'contradicts',
          sourceId: newMemory.id,
          targetId: existing.id,
          confidence: 0.4,
          reason: `Potentially contradictory findings`,
        })
      }
    }

    // 过滤低置信度边
    const filtered = edges.filter((e) => e.confidence >= this.config.minRelationConfidence)

    if (filtered.length > 0) {
      logger.debug(`Inferred ${filtered.length} relations for memory #${newMemory.id}`)
    }

    return filtered
  }

  /**
   * 从记忆 ID 开始图遍历（BFS）
   *
   * @param memoryId - 起始记忆 ID
   * @param options - 遍历选项
   */
  async traverse(
    memoryId: number,
    options?: { depth?: number; relationFilter?: MemoryRelationType[] },
  ): Promise<GraphTraversalResult | null> {
    const depth = options?.depth ?? this.config.maxTraversalDepth
    const relationFilter = options?.relationFilter

    // 获取所有最近记忆作为候选池
    const allRecent = await this.memoryStore.getRecent({ limit: 200 })
    const rootMemory = allRecent.find((m) => m.id === memoryId)
    if (!rootMemory) {
      logger.warn(`Memory #${memoryId} not found for traversal`)
      return null
    }

    const root = this.wrapNode(rootMemory)
    const visited = new Set<number>([memoryId])
    const paths: MemoryNode[][] = [[root]]
    let totalEdges = 0

    // BFS 遍历
    let currentLevel = [root]
    for (let d = 0; d < depth; d++) {
      const nextLevel: MemoryNode[] = []

      for (const node of currentLevel) {
        // 推断与其他记忆的关系
        const relations = this.inferRelations(node.memory, allRecent)

        for (const edge of relations) {
          // 应用关系过滤器
          if (relationFilter && !relationFilter.includes(edge.relation)) continue

          const targetId = edge.targetId === node.memory.id
            ? edge.sourceId
            : edge.targetId
          const targetMemory = allRecent.find((m) => m.id === targetId)

          if (targetMemory && !visited.has(targetId)) {
            visited.add(targetId)
            const targetNode = this.wrapNode(targetMemory)

            // 添加边到节点
            if (edge.sourceId === node.memory.id) {
              node.outgoingEdges.push(edge)
              targetNode.incomingEdges.push(edge)
            } else {
              targetNode.outgoingEdges.push(edge)
              node.incomingEdges.push(edge)
            }

            totalEdges++
            nextLevel.push(targetNode)
          }
        }
      }

      if (nextLevel.length > 0) {
        paths.push(nextLevel)
        currentLevel = nextLevel
      } else {
        break
      }
    }

    return {
      root,
      paths,
      totalNodes: visited.size,
      totalEdges,
    }
  }

  /**
   * 查找与指定记忆相关的所有记忆（关系图）
   */
  async getRelationGraph(
    memoryId: number,
  ): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] } | null> {
    const traversal = await this.traverse(memoryId, { depth: 2 })
    if (!traversal) return null

    const nodes = traversal.paths.flat()
    const edges = new Map<string, MemoryEdge>()

    for (const node of nodes) {
      for (const edge of [...node.incomingEdges, ...node.outgoingEdges]) {
        const key = `${edge.sourceId}→${edge.relation}→${edge.targetId}`
        edges.set(key, edge)
      }
    }

    return {
      nodes: this._deduplicateNodes(nodes),
      edges: Array.from(edges.values()),
    }
  }

  /**
   * 生成整个项目记忆的可视化图结构
   */
  async generateProjectMemoryGraph(
    projectId: string,
    options?: { maxNodes?: number },
  ): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] }> {
    const maxNodes = options?.maxNodes ?? 100
    const recent = await this.memoryStore.getRecent({ projectId, limit: maxNodes })

    const nodes = recent.map((m) => this.wrapNode(m))
    const allEdges: MemoryEdge[] = []

    // 为每个节点推断关系
    for (let i = 0; i < nodes.length; i++) {
      const edges = this.inferRelations(nodes[i].memory, recent)
      for (const edge of edges) {
        // 添加边到源节点和目标节点
        const sourceNode = nodes.find((n) => n.id === edge.sourceId)
        const targetNode = nodes.find((n) => n.id === edge.targetId)
        if (sourceNode && targetNode) {
          sourceNode.outgoingEdges.push(edge)
          targetNode.incomingEdges.push(edge)
          allEdges.push(edge)
        }
      }
    }

    return { nodes, edges: this._deduplicateEdges(allEdges) }
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 检查两条记忆是否共享上下文（同一项目/节点）
   */
  private _shareContext(a: MemoryItem, b: MemoryItem): boolean {
    if (a.project_id && b.project_id && a.project_id === b.project_id) return true
    if (a.node_id && b.node_id && a.node_id === b.node_id) return true
    return false
  }

  /**
   * 检查两条记忆是否看起来矛盾
   * 简单启发式：同一类型的记忆，但标题中包含对立词汇
   */
  private _seemContradictory(a: MemoryItem, b: MemoryItem): boolean {
    const oppositePairs = [
      ['pass', 'fail'],
      ['success', 'error'],
      ['通过', '失败'],
      ['成功', '错误'],
      ['working', 'broken'],
      ['fixed', 'still broken'],
    ]

    const textA = (a.title + ' ' + a.narrative).toLowerCase()
    const textB = (b.title + ' ' + b.narrative).toLowerCase()

    for (const [pos, neg] of oppositePairs) {
      if (
        (textA.includes(pos) && textB.includes(neg)) ||
        (textA.includes(neg) && textB.includes(pos))
      ) {
        return true
      }
    }

    return false
  }

  /**
   * 计算两个数组的交集
   */
  private _intersectArrays(a: string[], b: string[]): string[] {
    const setB = new Set(b.map((s) => s.toLowerCase()))
    return a.filter((s) => setB.has(s.toLowerCase()))
  }

  /**
   * 去重图节点（按 ID）
   */
  private _deduplicateNodes(nodes: MemoryNode[]): MemoryNode[] {
    const seen = new Map<number, MemoryNode>()
    for (const node of nodes) {
      if (!seen.has(node.id)) {
        seen.set(node.id, node)
      }
    }
    return Array.from(seen.values())
  }

  /**
   * 去重边（按 sourceId + relation + targetId）
   */
  private _deduplicateEdges(edges: MemoryEdge[]): MemoryEdge[] {
    const seen = new Map<string, MemoryEdge>()
    for (const edge of edges) {
      const key = `${edge.sourceId}→${edge.relation}→${edge.targetId}`
      if (!seen.has(key)) {
        seen.set(key, edge)
      } else {
        // 保留置信度更高的
        const existing = seen.get(key)!
        if (edge.confidence > existing.confidence) {
          seen.set(key, edge)
        }
      }
    }
    return Array.from(seen.values())
  }
}

/** 将 MemoryEdge 转为人类可读的标签 */
export function formatEdgeLabel(edge: MemoryEdge): string {
  const labels: Record<MemoryRelationType, string> = {
    caused_by: '→ cause of',
    depends_on: '→ depends on',
    supersedes: '→ supersedes',
    relates_to: '→ relates to',
    contradicts: '↯ contradicts',
  }
  return labels[edge.relation] ?? '→'
}

/** 关系类型的视觉属性（供前端渲染图时使用） */
export function getEdgeStyle(relation: MemoryRelationType): { stroke: string; dash: string } {
  const styles: Record<MemoryRelationType, { stroke: string; dash: string }> = {
    caused_by: { stroke: '#e74c3c', dash: 'solid' },
    depends_on: { stroke: '#3498db', dash: '5,5' },
    supersedes: { stroke: '#2ecc71', dash: 'solid' },
    relates_to: { stroke: '#95a5a6', dash: '3,3' },
    contradicts: { stroke: '#e67e22', dash: '10,5' },
  }
  return styles[relation] ?? { stroke: '#666', dash: 'solid' }
}
