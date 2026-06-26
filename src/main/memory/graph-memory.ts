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
import { QueryCache } from './query-cache'

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
  private _cache = new QueryCache<GraphTraversalResult>({ maxSize: 100, ttlMs: 5 * 60 * 1000 })

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
    const now = Date.now()

    /**
     * Apply exponential time decay to confidence.
     * Half-life = 90 days. If created_at is missing, skip decay.
     */
    const applyTimeDecay = (confidence: number, memory: MemoryItem): number => {
      if (!memory.created_at) return confidence
      const createdMs = new Date(memory.created_at).getTime()
      if (isNaN(createdMs)) return confidence
      const ageDays = (now - createdMs) / (1000 * 60 * 60 * 24)
      return confidence * Math.exp(-ageDays / 90)
    }

    for (const existing of existingMemories) {
      if (existing.id === newMemory.id) continue

      // 1. caused_by: fix 前面的 investigation
      if (
        newMemory.kind === 'fix' &&
        existing.kind === 'investigation' &&
        this._shareContext(newMemory, existing)
      ) {
        const rawConfidence = 0.7
        edges.push({
          relation: 'caused_by',
          sourceId: existing.id,
          targetId: newMemory.id,
          confidence: applyTimeDecay(rawConfidence, existing),
          reason: `Fix "${newMemory.title}" was likely caused by investigation "${existing.title}"`,
        })
      }

      // 2. depends_on: 修改了相同的文件
      const sharedFiles = this._intersectArrays(
        newMemory.files_modified,
        existing.files_modified,
      )
      if (sharedFiles.length > 0 && newMemory.kind === 'fix' && existing.kind === 'fix') {
        const rawConfidence = Math.min(0.8, 0.4 + sharedFiles.length * 0.2)
        edges.push({
          relation: 'depends_on',
          sourceId: existing.id,
          targetId: newMemory.id,
          confidence: applyTimeDecay(rawConfidence, existing),
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
        const rawConfidence = 0.6
        edges.push({
          relation: 'supersedes',
          sourceId: newMemory.id,
          targetId: existing.id,
          confidence: applyTimeDecay(rawConfidence, existing),
          reason: `Newer fix supersedes older fix on same files`,
        })
      }

      // 4. relates_to: 共享概念标签
      const sharedConcepts = this._intersectArrays(
        newMemory.concepts,
        existing.concepts,
      )
      if (sharedConcepts.length > 0) {
        const rawConfidence = sharedConcepts.length / Math.max(newMemory.concepts.length, 1)
        edges.push({
          relation: 'relates_to',
          sourceId: newMemory.id,
          targetId: existing.id,
          confidence: applyTimeDecay(rawConfidence, existing),
          reason: `Shared concepts: ${sharedConcepts.join(', ')}`,
        })
      }

      // 5. contradicts: 两条 review_finding 或 investigation 的结论相反
      if (
        (newMemory.kind === 'review_finding' || newMemory.kind === 'investigation') &&
        (existing.kind === 'review_finding' || existing.kind === 'investigation') &&
        this._seemContradictory(newMemory, existing)
      ) {
        const rawConfidence = 0.4
        edges.push({
          relation: 'contradicts',
          sourceId: newMemory.id,
          targetId: existing.id,
          confidence: applyTimeDecay(rawConfidence, existing),
          reason: `Potentially contradictory findings`,
        })
      }
    }

    // 过滤低置信度边
    const filtered = edges.filter((e) => e.confidence >= this.config.minRelationConfidence)

    if (filtered.length > 0) {
      logger.debug(`Inferred ${filtered.length} relations for memory #${newMemory.id}`)
    }

    // Invalidate cached traversal results for affected memories
    this._cache.invalidate(String(newMemory.id))
    for (const existing of existingMemories) {
      this._cache.invalidate(String(existing.id))
    }

    return filtered
  }

  /**
   * 从记忆 ID 开始图遍历（BFS）
   *
   * 性能优化：
   *   - 旧实现对 BFS 每个节点都对全量 allRecent 调用 inferRelations，
   *     复杂度 O(depth × levelSize × N × pairwise)，N=200 时主进程可阻塞数秒。
   *   - 新实现一次性预计算所有候选记忆之间的边，按 sourceId/targetId 建索引，
   *     BFS 只查表，复杂度退化为 O(N²) 一次 + O(visited × avg_degree) 遍历。
   *   - 同时用 edgeKey Set 去重，避免同一对节点多种关系重复入图。
   */
  async traverse(
    memoryId: number,
    options?: { depth?: number; relationFilter?: MemoryRelationType[] },
  ): Promise<GraphTraversalResult | null> {
    const cached = this._cache.get(String(memoryId), {
      depth: options?.depth,
      relationFilter: options?.relationFilter as string[] | undefined,
    })
    if (cached) return cached

    const depth = options?.depth ?? this.config.maxTraversalDepth
    const relationFilter = options?.relationFilter

    // Performance guard: when depth > 3, cap visited nodes at 200
    const visitLimit = depth > 3 ? 200 : Infinity

    // 获取所有最近记忆作为候选池
    const allRecent = await this.memoryStore.getRecent({ limit: 200 })
    const rootMemory = allRecent.find((m) => m.id === memoryId)
    if (!rootMemory) {
      logger.warn(`Memory #${memoryId} not found for traversal`)
      return null
    }

    // 一次性预计算：对每个 memory 调用 inferRelations，按 source/target 建索引
    // inferRelations(a, allRecent) 返回 a 与候选池中其他记忆推断出的边集合
    //
    // 对称关系（如 relates_to / contradicts）会从两端被分别推断出来——
    // A 处理时产生 (A,relates_to,B)，B 处理时产生 (B,relates_to,A)——
    // 仅按 `${source}→${rel}→${target}` 作 key 无法去重，会让 BFS 看到双倍边。
    // 通过 SYMMETRIC_RELATIONS 集合识别对称类型，把 sourceId/targetId 排序后再入 key。
    const SYMMETRIC_RELATIONS = new Set<MemoryRelationType>(['relates_to', 'contradicts'])
    const outgoingIndex = new Map<number, MemoryEdge[]>()
    const incomingIndex = new Map<number, MemoryEdge[]>()
    const seenEdge = new Set<string>()

    // Performance guard: limit candidate set for pairwise inference to avoid O(N^2) blowup
    const MAX_PAIRWISE_CANDIDATES = 30
    const candidates = allRecent.slice(0, MAX_PAIRWISE_CANDIDATES)
    const YIELD_EVERY_N = 10
    let processedCount = 0

    for (const mem of candidates) {
      const edges = this.inferRelations(mem, candidates)
      for (const edge of edges) {
        const key = SYMMETRIC_RELATIONS.has(edge.relation)
          ? `${Math.min(edge.sourceId, edge.targetId)}↔${edge.relation}↔${Math.max(edge.sourceId, edge.targetId)}`
          : `${edge.sourceId}→${edge.relation}→${edge.targetId}`
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        if (!outgoingIndex.has(edge.sourceId)) outgoingIndex.set(edge.sourceId, [])
        outgoingIndex.get(edge.sourceId)!.push(edge)
        if (!incomingIndex.has(edge.targetId)) incomingIndex.set(edge.targetId, [])
        incomingIndex.get(edge.targetId)!.push(edge)
      }

      processedCount++
      if (processedCount % YIELD_EVERY_N === 0 && candidates.length > YIELD_EVERY_N) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    const nodeCache = new Map<number, MemoryNode>()
    const getNode = (mem: typeof rootMemory): MemoryNode => {
      let n = nodeCache.get(mem.id)
      if (!n) {
        n = this.wrapNode(mem)
        nodeCache.set(mem.id, n)
      }
      return n
    }

    const root = getNode(rootMemory)
    const visited = new Set<number>([memoryId])
    const paths: MemoryNode[][] = [[root]]
    let totalEdges = 0

    let currentLevel = [root]
    for (let d = 0; d < depth; d++) {
      if (visited.size >= visitLimit) {
        logger.info(`Traversal visit limit (${visitLimit}) reached at depth ${d}, stopping`)
        break
      }

      const nextLevel: MemoryNode[] = []

      for (const node of currentLevel) {
        // 仅遍历方向正确的邻居（区分出边/入边，不再把所有边视作双向）
        const outEdges = outgoingIndex.get(node.memory.id) ?? []
        const inEdges = incomingIndex.get(node.memory.id) ?? []

        for (const edge of outEdges) {
          if (visited.size >= visitLimit) break
          if (relationFilter && !relationFilter.includes(edge.relation)) continue
          const targetMemory = allRecent.find((m) => m.id === edge.targetId)
          if (!targetMemory || visited.has(edge.targetId)) continue
          visited.add(edge.targetId)
          const targetNode = getNode(targetMemory)
          node.outgoingEdges.push(edge)
          targetNode.incomingEdges.push(edge)
          totalEdges++
          nextLevel.push(targetNode)
        }

        for (const edge of inEdges) {
          if (visited.size >= visitLimit) break
          if (relationFilter && !relationFilter.includes(edge.relation)) continue
          const sourceMemory = allRecent.find((m) => m.id === edge.sourceId)
          if (!sourceMemory || visited.has(edge.sourceId)) continue
          visited.add(edge.sourceId)
          const sourceNode = getNode(sourceMemory)
          sourceNode.outgoingEdges.push(edge)
          node.incomingEdges.push(edge)
          totalEdges++
          nextLevel.push(sourceNode)
        }
      }

      if (nextLevel.length > 0) {
        paths.push(nextLevel)
        currentLevel = nextLevel
      } else {
        break
      }
    }

    const result = {
      root,
      paths,
      totalNodes: visited.size,
      totalEdges,
    }

    this._cache.set(String(memoryId), {
      depth: options?.depth,
      relationFilter: options?.relationFilter as string[] | undefined,
    }, result)

    return result
  }

  /**
   * 批量遍历多个记忆节点
   */
  async traverseBatch(
    memoryIds: number[],
    options?: { depth?: number; relationFilter?: MemoryRelationType[] },
  ): Promise<Map<number, GraphTraversalResult | null>> {
    const results = new Map<number, GraphTraversalResult | null>()
    await Promise.all(
      memoryIds.map(async (id) => {
        const result = await this.traverse(id, options)
        results.set(id, result)
      }),
    )
    return results
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
    // Build a Map<id, MemoryNode> for O(1) lookups instead of O(N) nodes.find()
    const nodeMap = new Map<number, MemoryNode>()
    for (const node of nodes) {
      nodeMap.set(node.id, node)
    }
    const allEdges: MemoryEdge[] = []

    // 为每个节点推断关系
    for (let i = 0; i < nodes.length; i++) {
      const edges = this.inferRelations(nodes[i].memory, recent)
      for (const edge of edges) {
        // 添加边到源节点和目标节点
        const sourceNode = nodeMap.get(edge.sourceId)
        const targetNode = nodeMap.get(edge.targetId)
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
