/**
 * Graph Service
 * 组合 Repository，处理业务逻辑和事务
 */

import type { Client } from '@libsql/client'
import type { Graph, GraphType, NodeType, ProjectScanResult, ScanModule } from '@shared/types'
import type { AgentManager } from '../agent/agent-manager'
import { GraphRepository } from '../repositories/graph-repository'
import { ProjectScanner } from '../project-scanner'
import { ProjectAnalyzer, type ProjectGraphResult } from '../project-analyzer'
import { generateId } from '../shared/env'
import { MindMapAgent } from '../mindmap-agent'
import { collectContext } from '../mindmap-agent/context-collector'
import { buildGlobalPrompt } from '../mindmap-agent/retrieval/global'
import { sendPromptViaAgent } from '../agent/send-and-wait'

const VALID_NODE_TYPES: NodeType[] = ['project', 'module', 'process', 'feature', 'bug']

export interface InitFromProjectResult {
  onlineGraph: Graph
  devGraph: Graph
  modules: ProjectScanResult['modules']
}

export class GraphService {
  private graphRepo: GraphRepository
  private cachedProjectPaths: string[] | null = null
  constructor(
    private db: Client,
    private agentManager?: AgentManager,
  ) {
    this.graphRepo = new GraphRepository(db)
  }

  private invalidateProjectPathsCache(): void {
    this.cachedProjectPaths = null
  }

  async createGraph(data: { name: string; type: GraphType }): Promise<Graph> {
    const result = await this.graphRepo.create(data)
    this.invalidateProjectPathsCache()
    return result
  }

  async listGraphs(): Promise<Graph[]> {
    return this.graphRepo.list()
  }

  async getGraph(id: string) {
    return this.graphRepo.get(id)
  }

  async deleteGraph(id: string): Promise<void> {
    await this.graphRepo.delete(id)
    this.invalidateProjectPathsCache()
  }

  async initFromProject(data: { projectPath: string; projectName: string }): Promise<InitFromProjectResult> {
    const { projectPath, projectName } = data
    const now = new Date().toISOString()

    // 1. L1/L2 扫描（始终执行，作为 AI 的上下文输入）
    const scanner = new ProjectScanner()
    const scanResult = await scanner.scan(projectPath)

    // 2. L3 AI 增强：通过 AgentManager 生成业务语义化的模块
    let modules: ScanModule[] = scanResult.modules
    if (this.agentManager) {
      try {
        const context = await collectContext(projectPath, projectName, scanResult.framework)
        const prompt = buildGlobalPrompt(context)
        console.log(`[GraphService] Prompt 已生成, 长度: ${prompt.length}`)

        const rawOutput = await sendPromptViaAgent(this.agentManager, projectPath, prompt, {
          nodeTitle: '思维导图生成',
          timeoutMs: 300_000,
          adapterName: 'mindmap-internal',
        })

        const agent = new MindMapAgent(projectPath, this.agentManager)
        const aiModules = agent.parseGenerationResult(rawOutput)
        if (aiModules.length > 0) {
          modules = aiModules
          console.log(`[GraphService] MindMapAgent 生成 ${aiModules.length} 个业务模块`)
        } else {
          console.log('[GraphService] MindMapAgent 返回空结果，使用原 scanner 输出')
        }
      } catch (err) {
        console.warn('[GraphService] MindMapAgent 失败，降级使用原 scanner:', err)
      }
    } else {
      console.log('[GraphService] AgentManager 不可用，跳过 AI 增强')
    }

    // 3. 用模块列表替换 scanResult 的 modules（后续分析基于此）
    const enrichedScanResult: ProjectScanResult = {
      ...scanResult,
      modules,
    }

    // 4. 分析生成节点和边（dagre 布局在 analyzer 内部完成）
    const analyzer = new ProjectAnalyzer()
    const graphResult = analyzer.analyze(enrichedScanResult)

    // 3. 创建图和节点（事务保护，确保数据一致性）
    const onlineGraphId = generateId('graph-online')
    const devGraphId = generateId('graph-dev')

    const tx = await this.db.transaction('write')
    try {
      // 创建 online 图（产品蓝图）
      await tx.execute({
        sql: 'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [onlineGraphId, `${projectName} - 产品蓝图`, 'online', projectPath, now, now],
      })

      // 创建 dev 图（开发场景）
      await tx.execute({
        sql: 'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [devGraphId, `${projectName} - 开发场景`, 'dev', projectPath, now, now],
      })

      await this.createNodes(onlineGraphId, 'online', graphResult, now, tx)
      await this.createNodes(devGraphId, 'dev', graphResult, now, tx)

      await tx.commit()
    } catch (err) {
      await tx.rollback()
      throw err
    }

    this.invalidateProjectPathsCache()

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
      modules: enrichedScanResult.modules,
    }
  }

  private async createNodes(
    graphId: string,
    graphType: 'online' | 'dev',
    graphResult: ProjectGraphResult,
    now: string,
    executor: Pick<Client, 'execute'> = this.db,
  ): Promise<void> {
    const tempIdMap = new Map<string, string>()

    // 第一轮：创建所有节点，记录 tempId -> realId 映射
    for (const nodeData of graphResult.nodes) {
      // 校验 AI 生成的 type 值，非法值降级为 'feature'
      if (!VALID_NODE_TYPES.includes(nodeData.type)) {
        console.warn(`[GraphService] Invalid node type "${nodeData.type}", falling back to "feature"`)
        nodeData.type = 'feature'
      }

      const nodeId = generateId('node')
      tempIdMap.set(nodeData.tempId, nodeId)

      // dev 图中，feature 节点为 placeholder
      const status = graphType === 'dev' && nodeData.type === 'feature'
        ? 'placeholder'
        : nodeData.status

      await executor.execute({
        sql: `INSERT INTO nodes (
          id, type, status, title, description, acceptance_criteria,
          graph_id, graph_type, parent_id, rules, metadata, owner_role,
          position_x, position_y, content, community_summary, community_level,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          nodeData.content ? JSON.stringify(nodeData.content) : null,
          nodeData.communitySummary ?? null,
          nodeData.communityLevel ?? null,
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
          await executor.execute({
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
        await executor.execute({
          sql: 'INSERT INTO edges (id, source, target, label, edge_type, graph_id, description, data_flow, strength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          args: [edgeId, sourceId, targetId, edgeData.label ?? null, edgeData.edgeType ?? 'default', graphId, edgeData.description ?? null, edgeData.dataFlow ?? null, edgeData.strength ?? null],
        })
      } else {
        console.warn(`[GraphService] Edge dropped: sourceTempId="${edgeData.sourceTempId}" or targetTempId="${edgeData.targetTempId}" not found in tempIdMap`)
      }
    }
  }

  async getProjectPaths(): Promise<string[]> {
    if (this.cachedProjectPaths === null) {
      this.cachedProjectPaths = await this.graphRepo.getProjectPaths()
    }
    return this.cachedProjectPaths
  }
}
