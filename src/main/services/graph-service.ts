/**
 * Graph Service
 * 组合 Repository，处理业务逻辑和事务
 */

import type { Client } from '@libsql/client'
import type { Graph, GraphType, NodeType, ProjectScanResult, ScanModule } from '@shared/types'
import { nodeTypeRegistry } from '../shared/node-type-registry'
import type { AgentManager } from '../agent/agent-manager'
import type { SymbolIndex } from '../code-intelligence/symbol-index'
import { GraphRepository } from '../repositories/graph-repository'
import { ProjectScanner } from '../project-scanner'
import { ProjectAnalyzer, type ProjectGraphResult } from '../project-analyzer'
import { generateId } from '../shared/env'
import { MindMapAgent } from '../mindmap-agent'
import { collectContext } from '../mindmap-agent/context-collector'
import { buildGlobalPrompt } from '../mindmap-agent/retrieval/global'
import { sendPromptViaAgent } from '../agent/send-and-wait'
import { createLogger } from '../shared/logger'

const logger = createLogger('GraphService')

export const VALID_NODE_TYPES: NodeType[] = ['project', 'module', 'process', 'feature', 'bug']

export interface InitFromProjectResult {
  onlineGraph: Graph
  devGraph: Graph
  modules: ProjectScanResult['modules']
}

export class GraphService {
  private graphRepo: GraphRepository
  private cachedProjectPaths: string[] | null = null
  private symbolIndex?: SymbolIndex
  constructor(
    private db: Client,
    private agentManager?: AgentManager,
  ) {
    this.graphRepo = new GraphRepository(db)
  }

  /** 注入 SymbolIndex（由 ipc-handlers 初始化后调用） */
  setSymbolIndex(symbolIndex: SymbolIndex): void {
    this.symbolIndex = symbolIndex
  }

  private invalidateProjectPathsCache(): void {
    this.cachedProjectPaths = null
  }

  async createGraph(data: { name: string; type: GraphType }): Promise<Graph> {
    const result = await this.graphRepo.create(data)
    this.invalidateProjectPathsCache()
    return result
  }

  /** 从已有在线图派生开发图 */
  async deriveGraph(sourceGraphId: string, name?: string): Promise<Graph> {
    const sourceData = await this.graphRepo.get(sourceGraphId)
    if (!sourceData) {
      throw new Error(`Source graph not found: ${sourceGraphId}`)
    }
    if (sourceData.graph.type !== 'online') {
      throw new Error('Can only derive dev graph from an online graph')
    }

    const devGraph = await this.graphRepo.create({
      name: name ?? `${sourceData.graph.name} - 开发场景`,
      type: 'dev',
      projectPath: sourceData.graph.projectPath,
    })

    await this.graphRepo.cloneGraphNodes(sourceGraphId, devGraph.id, 'dev')
    this.invalidateProjectPathsCache()
    return devGraph
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
        logger.info(`Prompt 已生成, 长度: ${prompt.length}`)

        const rawOutput = await sendPromptViaAgent(this.agentManager, projectPath, prompt, {
          nodeTitle: '思维导图生成',
          timeoutMs: 300_000,
          adapterName: 'mindmap-internal',
        })

        const agent = new MindMapAgent(projectPath, this.agentManager)
        const aiModules = agent.parseGenerationResult(rawOutput)
        if (aiModules.length > 0) {
          modules = aiModules
          logger.info(`MindMapAgent 生成 ${aiModules.length} 个业务模块`)
        } else {
          logger.info('MindMapAgent 返回空结果，使用原 scanner 输出')
        }
      } catch (err) {
        logger.warn('MindMapAgent 失败，降级使用原 scanner:', err)
      }
    } else {
      logger.info('AgentManager 不可用，跳过 AI 增强')
    }

    // 3. 用模块列表替换 scanResult 的 modules（后续分析基于此）
    const enrichedScanResult: ProjectScanResult = {
      ...scanResult,
      modules,
    }

    // 4. 分析生成节点和边（dagre 布局在 analyzer 内部完成）
    const analyzer = new ProjectAnalyzer()
    const graphResult = analyzer.analyze(enrichedScanResult)

    // 5. 创建图和节点（事务保护，确保数据一致性）
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
      // 校验 AI 生成的 type 值，非法值降级为 'feature'（同时支持注册表扩展类型）
      if (!VALID_NODE_TYPES.includes(nodeData.type) && !nodeTypeRegistry.has(nodeData.type)) {
        logger.warn(`Invalid node type "${nodeData.type}", falling back to "feature"`)
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
        logger.warn(`Edge dropped: sourceTempId="${edgeData.sourceTempId}" or targetTempId="${edgeData.targetTempId}" not found in tempIdMap`)
      }
    }
  }

  async getProjectPaths(): Promise<string[]> {
    if (this.cachedProjectPaths === null) {
      this.cachedProjectPaths = await this.graphRepo.getProjectPaths()
    }
    return this.cachedProjectPaths
  }

  /**
   * 基于代码 import 关系自动建议边
   * 扫描图中节点的 fileAssociations，查询 SymbolIndex 中的 import 关系，
   * 返回可以创建的边建议列表。
   */
  async suggestEdges(graphId: string): Promise<Array<{
    sourceId: string
    targetId: string
    label: string
    edgeType: 'default'
    description: string
    dataFlow: string
    strength: number
  }>> {
    if (!this.symbolIndex) {
      logger.warn('suggestEdges: SymbolIndex not available')
      return []
    }

    // 获取图中所有带 fileAssociations 的节点
    const result = await this.db.execute({
      sql: 'SELECT id, metadata FROM nodes WHERE graph_id = ? AND metadata IS NOT NULL',
      args: [graphId],
    })

    // 构建 filePath → nodeId 映射
    const fileToNode = new Map<string, string>()
    const nodeFiles = new Map<string, string[]>()

    for (const row of result.rows) {
      const nodeId = String((row as Record<string, unknown>).id)
      const metadataStr = String((row as Record<string, unknown>).metadata)
      try {
        const metadata = JSON.parse(metadataStr)
        const files = metadata.fileAssociations?.map((f: { path: string }) => f.path) ?? []
        nodeFiles.set(nodeId, files)
        for (const file of files) {
          fileToNode.set(file, nodeId)
        }
      } catch {
        // 忽略无效 metadata
      }
    }

    // 查询已存在的边，避免重复建议
    const existingEdges = await this.db.execute({
      sql: 'SELECT source, target FROM edges WHERE graph_id = ?',
      args: [graphId],
    })
    const edgeSet = new Set(existingEdges.rows.map((r) => {
      const row = r as Record<string, unknown>
      return `${String(row.source)}->${String(row.target)}`
    }))

    // 遍历每个节点的关联文件，查询 import 关系
    const suggestions: Array<{
      sourceId: string; targetId: string; label: string;
      edgeType: 'default'; description: string; dataFlow: string; strength: number
    }> = []

    for (const [nodeId, files] of nodeFiles) {
      for (const file of files) {
        const imports = await this.symbolIndex.getImports(file)
        for (const imp of imports) {
          const targetNodeId = fileToNode.get(imp.toFile)
          if (!targetNodeId || targetNodeId === nodeId) continue
          const key = `${nodeId}->${targetNodeId}`
          if (edgeSet.has(key)) continue
          edgeSet.add(key) // 去重

          suggestions.push({
            sourceId: nodeId,
            targetId: targetNodeId,
            label: 'import',
            edgeType: 'default' as const,
            description: `${file.split('/').pop()} imports from ${imp.toFile.split('/').pop()}`,
            dataFlow: imp.importedNames.join(', '),
            strength: Math.min(imp.importedNames.length * 0.2, 1.0),
          })
        }
      }
    }

    logger.info(`suggestEdges: found ${suggestions.length} edge suggestions for graph ${graphId}`)
    return suggestions
  }
}
