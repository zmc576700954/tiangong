/**
 * Graph Service
 * 组合 Repository，处理业务逻辑和事务
 */

import type { Client } from '@libsql/client'
import type { Graph, GraphType, ProjectScanResult } from '@shared/types'
import { GraphRepository } from '../repositories/graph-repository'
import { ProjectScanner } from '../project-scanner'
import { ProjectAnalyzer, computeOptimalLayout, type ProjectGraphResult } from '../project-analyzer'
import { generateId } from '../shared/env'

export interface InitFromProjectResult {
  onlineGraph: Graph
  devGraph: Graph
  modules: ProjectScanResult['modules']
}

export class GraphService {
  private graphRepo: GraphRepository
  constructor(private db: Client) {
    this.graphRepo = new GraphRepository(db)
  }

  async createGraph(data: { name: string; type: GraphType }): Promise<Graph> {
    return this.graphRepo.create(data)
  }

  async listGraphs(): Promise<Graph[]> {
    return this.graphRepo.list()
  }

  async getGraph(id: string) {
    return this.graphRepo.get(id)
  }

  async deleteGraph(id: string): Promise<void> {
    return this.graphRepo.delete(id)
  }

  async initFromProject(data: { projectPath: string; projectName: string }): Promise<InitFromProjectResult> {
    const { projectPath, projectName } = data
    const now = new Date().toISOString()

    // 1. 扫描项目（事务外：纯计算/IO 操作）
    const scanner = new ProjectScanner()
    const scanResult = await scanner.scan(projectPath)

    // 2. 分析生成节点和边（事务外：纯计算操作）
    const layout = computeOptimalLayout(scanResult)
    const analyzer = new ProjectAnalyzer(layout)
    const graphResult = analyzer.analyze(scanResult)

    // 3. 创建图和节点（事务保护，确保数据一致性）
    const onlineGraphId = generateId('graph-online')
    const devGraphId = generateId('graph-dev')

    let committed = false
    await this.db.execute('BEGIN TRANSACTION')
    try {
      // 创建 online 图（产品蓝图）
      await this.db.execute({
        sql: 'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [onlineGraphId, `${projectName} - 产品蓝图`, 'online', projectPath, now, now],
      })

      // 创建 dev 图（开发场景）
      await this.db.execute({
        sql: 'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [devGraphId, `${projectName} - 开发场景`, 'dev', projectPath, now, now],
      })

      await this.createNodes(onlineGraphId, 'online', graphResult, now)
      await this.createNodes(devGraphId, 'dev', graphResult, now)

      await this.db.execute('COMMIT')
      committed = true
    } finally {
      if (!committed) {
        await this.db.execute('ROLLBACK').catch(() => {})
      }
    }

    return {
      onlineGraph: {
        id: onlineGraphId,
        name: `${projectName} - 产品蓝图`,
        type: 'online' as const,
        projectPath,
        createdAt: now,
        updatedAt: now,
      },
      devGraph: {
        id: devGraphId,
        name: `${projectName} - 开发场景`,
        type: 'dev' as const,
        projectPath,
        createdAt: now,
        updatedAt: now,
      },
      modules: scanResult.modules,
    }
  }

  private async createNodes(
    graphId: string,
    graphType: 'online' | 'dev',
    graphResult: ProjectGraphResult,
    now: string,
  ): Promise<void> {
    const tempIdMap = new Map<string, string>()

    // 第一轮：创建所有节点，记录 tempId -> realId 映射
    for (const nodeData of graphResult.nodes) {
      const nodeId = generateId('node')
      tempIdMap.set(nodeData.tempId, nodeId)

      // dev 图中，feature 节点为 placeholder
      const status = graphType === 'dev' && nodeData.type === 'feature'
        ? 'placeholder'
        : nodeData.status

      await this.db.execute({
        sql: `INSERT INTO nodes (
          id, type, status, title, description, acceptance_criteria,
          graph_id, graph_type, parent_id, rules, metadata, owner_role,
          position_x, position_y, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          nodeId,
          nodeData.type,
          status,
          nodeData.title,
          nodeData.description ?? null,
          nodeData.acceptanceCriteria ? JSON.stringify(nodeData.acceptanceCriteria) : null,
          graphId,
          graphType,
          null, // parent_id 第二轮更新
          nodeData.rules ? JSON.stringify(nodeData.rules) : null,
          nodeData.metadata ? JSON.stringify(nodeData.metadata) : null,
          nodeData.ownerRole ?? null,
          nodeData.position.x,
          nodeData.position.y + (graphType === 'dev' ? 20 : 0),
          now,
          now,
        ],
      })
    }

    // 第二轮：更新 parent_id
    for (const nodeData of graphResult.nodes) {
      if (nodeData.parentTempId) {
        const nodeId = tempIdMap.get(nodeData.tempId)
        const parentId = tempIdMap.get(nodeData.parentTempId)
        if (nodeId && parentId) {
          await this.db.execute({
            sql: 'UPDATE nodes SET parent_id = ? WHERE id = ?',
            args: [parentId, nodeId],
          })
        }
      }
    }

    // 第三轮：创建边
    for (const edgeData of graphResult.edges) {
      const sourceId = tempIdMap.get(edgeData.sourceTempId)
      const targetId = tempIdMap.get(edgeData.targetTempId)
      if (sourceId && targetId) {
        const edgeId = generateId('edge')
        await this.db.execute({
          sql: 'INSERT INTO edges (id, source, target, label, edge_type, graph_id) VALUES (?, ?, ?, ?, ?, ?)',
          args: [edgeId, sourceId, targetId, edgeData.label ?? null, edgeData.edgeType ?? 'default', graphId],
        })
      }
    }
  }

  async getProjectPaths(): Promise<string[]> {
    return this.graphRepo.getProjectPaths()
  }
}
