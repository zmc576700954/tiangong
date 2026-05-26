/**
 * Graph IPC Handlers
 * 图、节点、边、Bug 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import { GraphService } from '../services/graph-service'
import { NodeRepository } from '../repositories/node-repository'
import { EdgeRepository } from '../repositories/edge-repository'
import { BugRepository } from '../repositories/bug-repository'
import type { TypedHandle } from './utils'

export function registerGraphHandlers(db: Client, typedHandle: TypedHandle): void {
  const graphService = new GraphService(db)
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

  // ---------- 节点操作 ----------
  typedHandle('node:create', async (_, data) => {
    return nodeRepo.create(data)
  })

  typedHandle('node:update', async (_, id, data) => {
    return nodeRepo.update(id, data)
  })

  typedHandle('node:delete', async (_, id) => {
    await nodeRepo.delete(id)
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

  typedHandle('bug:update', async (_, id, data) => {
    return bugRepo.update(id, data)
  })

  typedHandle('bug:delete', async (_, id) => {
    await bugRepo.delete(id)
    return true
  })

  typedHandle('bug:listByNode', async (_, nodeId) => {
    return bugRepo.listByNode(nodeId)
  })

  // ---------- 从项目初始化图 ----------
  typedHandle('graph:initFromProject', async (_, data) => {
    return graphService.initFromProject(data)
  })
}
