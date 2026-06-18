import type { GraphNode, GraphEdge } from '@shared/types'
import type { KnowledgeAssociator } from '../memory/knowledge-associator'
import { createLogger } from '../shared/logger'

const logger = createLogger('graph-sync-service')

export interface GraphSyncDeps {
  graphService: { getNodes(graphId: string): Promise<GraphNode[]>; getEdges(graphId: string): Promise<GraphEdge[]> }
  knowledgeAssociator: KnowledgeAssociator
  pushSuggestedEdges: (graphId: string, edges: Array<{ sourceId: string; targetId: string; edgeType: string; score: number }>) => void
  updateEdge?: (edgeId: string, data: Partial<GraphEdge>) => void
  deleteEdge?: (edgeId: string) => void
  scanIntervalMs?: number
}

export class GraphSyncService {
  private _deps: GraphSyncDeps
  private _timers = new Map<string, ReturnType<typeof setInterval>>()
  private _scanIntervalMs: number

  constructor(deps: GraphSyncDeps) {
    this._deps = deps
    this._scanIntervalMs = deps.scanIntervalMs ?? 30_000
  }

  start(graphId: string): void {
    if (this._timers.has(graphId)) return
    const timer = setInterval(() => this._runAssociationScan(graphId), this._scanIntervalMs)
    this._timers.set(graphId, timer)
    logger.info(`GraphSyncService started for graph ${graphId}`)
  }

  stop(graphId: string): void {
    const timer = this._timers.get(graphId)
    if (timer) {
      clearInterval(timer)
      this._timers.delete(graphId)
      logger.info(`GraphSyncService stopped for graph ${graphId}`)
    }
  }

  isRunning(graphId: string): boolean {
    return this._timers.has(graphId)
  }

  confirmSuggestedEdge(edgeId: string): void {
    this._deps.updateEdge?.(edgeId, { content: { suggested: false } } as Partial<GraphEdge>)
  }

  rejectSuggestedEdge(edgeId: string): void {
    this._deps.deleteEdge?.(edgeId)
  }

  private async _runAssociationScan(graphId: string): Promise<void> {
    try {
      const nodes = await this._deps.graphService.getNodes(graphId)
      const edges = await this._deps.graphService.getEdges(graphId)

      const dependencyEdges = edges
        .filter(e => e.edgeType === 'dependency' || e.edgeType === 'default')
        .map(e => ({ sourceId: e.source, targetId: e.target }))

      const coChangeFreqMap = new Map<string, number>()

      const associations = await this._deps.knowledgeAssociator.findAssociations(nodes, {
        dependencyEdges,
        coChangeFreqMap,
        threshold: 0.6
      })

      const existingPairs = new Set(edges.map(e => [e.source, e.target].sort().join(':')))
      const newAssociations = associations.filter(
        a => !existingPairs.has([a.sourceId, a.targetId].sort().join(':'))
      )

      if (newAssociations.length > 0) {
        this._deps.pushSuggestedEdges(graphId, newAssociations)
      }
    } catch (error) {
      logger.warn(`Association scan failed for graph ${graphId}:`, error)
    }
  }

  destroy(): void {
    for (const graphId of this._timers.keys()) {
      this.stop(graphId)
    }
  }
}
