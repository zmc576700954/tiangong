/**
 * Graph IPC Handlers
 * 图、节点、边、Bug 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { GraphService } from '../services/graph-service'
import { NodeRepository } from '../repositories/node-repository'
import { EdgeRepository } from '../repositories/edge-repository'
import { BugRepository } from '../repositories/bug-repository'
import { SnapshotRepository } from '../repositories/snapshot-repository'
import type { TypedHandle } from './utils'
import type { GraphNode, BugNode } from '@shared/types'
import { validateTransition, validateBugTransition } from '@shared/state-machine'
import { VALID_NODE_TYPES } from '../services/graph-service'
import { IpcError, ErrorCode } from '../errors'

export function registerGraphHandlers(db: Client, typedHandle: TypedHandle, graphService: GraphService, snapshotRepo: SnapshotRepository): void {
  const nodeRepo = new NodeRepository(db)
  const edgeRepo = new EdgeRepository(db)
  const bugRepo = new BugRepository(db)

  // ---------- 图操作 ----------
  typedHandle('graph:create', async (_, data) => {
    return graphService.createGraph(data)
  })

  typedHandle('graph:list', async () => {
    return graphService.listGraphs()
  })

  typedHandle('graph:get', async (_, id) => {
    return graphService.getGraph(id)
  })

  typedHandle('graph:delete', async (_, id) => {
    await graphService.deleteGraph(id)
    return true
  })

  typedHandle('graph:derive', async (_, sourceGraphId: string, name?: string) => {
    return graphService.deriveGraph(sourceGraphId, name)
  })

  // ---------- 节点操作 ----------
  typedHandle('node:create', async (_, data) => {
    if (!VALID_NODE_TYPES.includes(data.type)) {
      throw new IpcError(`Invalid node type: ${data.type}. Allowed: ${VALID_NODE_TYPES.join(', ')}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
    return nodeRepo.create(data)
  })

  typedHandle('node:createBatch', async (_, nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => {
    for (const data of nodesData) {
      if (!VALID_NODE_TYPES.includes(data.type)) {
        throw new IpcError(`Invalid node type: ${data.type}. Allowed: ${VALID_NODE_TYPES.join(', ')}`, ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
    return nodeRepo.createBatch(nodesData)
  })

  typedHandle('node:update', async (_, id: string, data: Partial<GraphNode>) => {
    if (data.status !== undefined) {
      const currentStatus = await nodeRepo.getStatus(id)
      if (currentStatus !== null && currentStatus !== data.status) {
        validateTransition(currentStatus, data.status)
      }
    }
    return nodeRepo.update(id, data)
  })

  typedHandle('node:delete', async (_, id) => {
    await nodeRepo.delete(id)
    return true
  })

  typedHandle('node:batchUpdatePositions', async (_, updates) => {
    await nodeRepo.batchUpdatePositions(updates as Array<{ id: string; x: number; y: number }>)
    return true
  })

  // ---------- 边操作 ----------
  typedHandle('edge:create', async (_, data) => {
    return edgeRepo.create(data)
  })

  typedHandle('edge:update', async (_, id, data) => {
    return edgeRepo.update(id, data)
  })

  typedHandle('edge:delete', async (_, id) => {
    await edgeRepo.delete(id)
    return true
  })

  // ---------- Bug 操作 ----------
  typedHandle('bug:create', async (_, data) => {
    return bugRepo.create(data)
  })

  typedHandle('bug:update', async (_, id: string, data: Partial<BugNode>) => {
    if (data.status !== undefined) {
      const currentStatus = await bugRepo.getStatus(id)
      if (currentStatus !== null && currentStatus !== data.status) {
        validateBugTransition(currentStatus, data.status)
      }
    }
    return bugRepo.update(id, data)
  })

  typedHandle('bug:delete', async (_, id) => {
    await bugRepo.delete(id)
    return true
  })

  typedHandle('bug:listByNode', async (_, nodeId) => {
    return bugRepo.listByNode(nodeId)
  })

  // ---------- 快照操作 ----------
  typedHandle('snapshot:create', async (_, graphId: string, name: string) => {
    const graphData = await graphService.getGraph(graphId)
    if (!graphData) throw new IpcError('Graph not found', ErrorCode.IPC_HANDLER_ERROR)
    return snapshotRepo.create(graphId, name, graphData.nodes, graphData.edges)
  })

  typedHandle('snapshot:list', async (_, graphId: string) => {
    return snapshotRepo.listByGraph(graphId)
  })

  typedHandle('snapshot:load', async (_, id: string) => {
    return snapshotRepo.load(id)
  })

  typedHandle('snapshot:delete', async (_, id: string) => {
    await snapshotRepo.delete(id)
    return true
  })

  // 注意: graph:initFromProject 已在 ipc/project.ts 中注册（含路径校验），此处不重复注册
}
