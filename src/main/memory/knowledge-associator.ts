import type { GraphNode, EdgeType } from '@shared/types'
import { QueryCache } from './query-cache'

export interface AssociationInput {
  dependencyEdges: Array<{ sourceId: string; targetId: string }>
  coChangeFreqMap: Map<string, number>
  threshold?: number
}

export interface AssociationResult {
  sourceId: string
  targetId: string
  score: number
  edgeType: EdgeType
  signals: { dependency: boolean; semantic: boolean; coChange: boolean }
}

const WEIGHTS = { dependency: 0.9, semantic: 0.7, coChange: 0.6 } as const

export class KnowledgeAssociator {
  private _embeddingService: { cosineSimilarity(a: number[], b: number[]): number; generateEmbedding(text: string): Promise<number[]> } | null = null
  private static _cache = new QueryCache<AssociationResult[]>({ maxSize: 100, ttlMs: 300_000 })

  setEmbeddingService(service: { cosineSimilarity(a: number[], b: number[]): number; generateEmbedding(text: string): Promise<number[]> }): void {
    this._embeddingService = service
  }

  computeAssociationScore(
    nodeA: GraphNode,
    nodeB: GraphNode,
    input: { dependencyEdges: Array<{ sourceId: string; targetId: string }>; coChangeFreq: number }
  ): number {
    let weightedSum = 0
    let totalWeight = 0

    const hasDep = input.dependencyEdges.some(
      e => (e.sourceId === nodeA.id && e.targetId === nodeB.id) ||
           (e.sourceId === nodeB.id && e.targetId === nodeA.id)
    )
    if (hasDep) { weightedSum += WEIGHTS.dependency }
    totalWeight += WEIGHTS.dependency

    if (input.coChangeFreq > 0) {
      const coChangeScore = Math.min(1, input.coChangeFreq / 10)
      weightedSum += WEIGHTS.coChange * coChangeScore
      totalWeight += WEIGHTS.coChange
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0
  }

  async findAssociations(nodes: GraphNode[], input: AssociationInput): Promise<AssociationResult[]> {
    const threshold = input.threshold ?? 0.6

    // Check cache — include input data fingerprint in key to avoid stale results
    const inputFingerprint = `${input.dependencyEdges.length}:${input.coChangeFreqMap.size}`
    const cacheKey = [...nodes.map((n) => n.id)].sort().join(':') + `|${inputFingerprint}`
    const cacheOptions = { depth: Math.round(threshold * 1000), relationFilter: [] as string[] }
    const cached = KnowledgeAssociator._cache.get(cacheKey, cacheOptions)
    if (cached) return cached

    const results: AssociationResult[] = []

    const embeddings = new Map<string, number[]>()
    if (this._embeddingService) {
      for (const node of nodes) {
        try {
          const text = `${node.title} ${node.description ?? ''}`
          const emb = await this._embeddingService.generateEmbedding(text)
          embeddings.set(node.id, emb)
        } catch { /* skip */ }
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        const pairKey = [a.id, b.id].sort().join(':')
        const coChangeFreq = input.coChangeFreqMap.get(pairKey) ?? 0
        const hasDep = input.dependencyEdges.some(
          e => (e.sourceId === a.id && e.targetId === b.id) ||
               (e.sourceId === b.id && e.targetId === a.id)
        )

        let weightedSum = 0
        let totalWeight = 0
        const signals = { dependency: false, semantic: false, coChange: false }

        if (hasDep) { weightedSum += WEIGHTS.dependency; signals.dependency = true; totalWeight += WEIGHTS.dependency }

        const embA = embeddings.get(a.id)
        const embB = embeddings.get(b.id)
        if (this._embeddingService && embA && embB) {
          const sim = this._embeddingService.cosineSimilarity(embA, embB)
          if (sim > 0.6) { weightedSum += WEIGHTS.semantic * sim; signals.semantic = true; totalWeight += WEIGHTS.semantic }
        }

        if (coChangeFreq > 0) {
          const coChangeScore = Math.min(1, coChangeFreq / 10)
          weightedSum += WEIGHTS.coChange * coChangeScore
          signals.coChange = true
          totalWeight += WEIGHTS.coChange
        }

        const score = totalWeight > 0 ? weightedSum / totalWeight : 0
        if (score >= threshold) {
          const edgeType = this._determineEdgeType(signals)
          results.push({ sourceId: a.id, targetId: b.id, score, edgeType, signals })
        }
      }
    }
    const sorted = results.sort((a, b) => b.score - a.score)
    KnowledgeAssociator._cache.set(cacheKey, cacheOptions, sorted)
    return sorted
  }

  private _determineEdgeType(signals: { dependency: boolean; semantic: boolean; coChange: boolean }): EdgeType {
    if (signals.dependency) return 'dependency'
    if (signals.semantic) return 'semantic'
    if (signals.coChange) return 'co-change'
    return 'default'
  }
}
