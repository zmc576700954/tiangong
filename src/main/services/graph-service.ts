/**
 * Graph Service
 * 组合 Repository，处理业务逻辑和事务
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { Graph, GraphType, NodeType, ProjectScanResult, ScanModule, GraphFetchOptions, ChatMessage, AgentOutput } from '@shared/types'
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
import { createAgentSessionForPrompt } from '../agent/send-and-wait'
import type { ChatService } from './chat-service'
import { estimateTokens } from '../shared/token-utils'
import { createLogger } from '../shared/logger'

const logger = createLogger('GraphService')

export const VALID_NODE_TYPES: NodeType[] = ['project', 'module', 'process', 'feature', 'bug', 'wiki-page']

export interface InitFromProjectResult {
  onlineGraph: Graph
  devGraph: Graph
  modules: ProjectScanResult['modules']
  threadId?: string
}

export class GraphService {
  private graphRepo: GraphRepository
  private cachedProjectPaths: string[] | null = null
  private symbolIndex?: SymbolIndex
  constructor(
    private db: BetterSqlite3.Database,
    private agentManager?: AgentManager,
    private chatService?: ChatService,
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

  createGraph(data: { name: string; type: GraphType }): Graph {
    const result = this.graphRepo.create(data)
    this.invalidateProjectPathsCache()
    return result
  }

  /** 从已有在线图派生开发图 */
  deriveGraph(sourceGraphId: string, name?: string): Graph {
    const sourceData = this.graphRepo.get(sourceGraphId)
    if (!sourceData) {
      throw new Error(`Source graph not found: ${sourceGraphId}`)
    }
    if (sourceData.graph.type !== 'online') {
      throw new Error('Can only derive dev graph from an online graph')
    }

    const devGraph = this.graphRepo.create({
      name: name ?? `${sourceData.graph.name} - 开发场景`,
      type: 'dev',
      projectPath: sourceData.graph.projectPath,
    })

    this.graphRepo.cloneGraphNodes(sourceGraphId, devGraph.id, 'dev')
    this.invalidateProjectPathsCache()
    return devGraph
  }

  listGraphs(): Graph[] {
    return this.graphRepo.list()
  }

  getGraph(id: string, options?: GraphFetchOptions) {
    return this.graphRepo.get(id, options)
  }

  deleteGraph(id: string): void {
    this.graphRepo.delete(id)
    this.invalidateProjectPathsCache()
  }

  async initFromProject(data: { projectPath: string; projectName: string }): Promise<InitFromProjectResult> {
    const { projectPath, projectName } = data
    const now = new Date().toISOString()

    // 创建 Chat 线程（阶段 1：协议与数据层入口）
    let threadId: string | undefined
    if (this.chatService) {
      const thread = await this.chatService.createThread({
        adapterName: 'mindmap-internal',
      })
      threadId = thread.id
      await this.chatService.updateThread(threadId, {
        title: `生成思维导图：${projectName}`,
        status: 'running',
      })
    }

    const progress = async (
      stage: string,
      label: string,
      extra?: { current?: number; total?: number; tokenEstimate?: number },
    ) => {
      if (!this.chatService || !threadId) return
      const message: ChatMessage = {
        id: generateId('msg'),
        role: 'system',
        content: label,
        timestamp: Date.now(),
        adapterName: 'mindmap-internal',
        status: 'success',
        stage,
        structuredContent: [
          {
            type: 'progress',
            data: { stage, label, ...(extra ?? {}) },
          },
        ],
        tokenEstimate: extra?.tokenEstimate,
      }
      await this.chatService.saveMessage(threadId, message)
    }

    const writeWarning = async (message: string, raw?: string) => {
      if (!this.chatService || !threadId) return
      await this.chatService.saveMessage(threadId, {
        id: generateId('msg'),
        role: 'system',
        content: message,
        timestamp: Date.now(),
        adapterName: 'mindmap-internal',
        status: 'success',
        stage: 'calling_agent',
        structuredContent: [
          {
            type: 'text',
            data: { level: 'warning', message, raw },
          },
        ],
      })
    }

    const writeError = async (message: string, raw?: string) => {
      if (!this.chatService || !threadId) return
      await this.chatService.saveMessage(threadId, {
        id: generateId('msg'),
        role: 'system',
        content: message,
        timestamp: Date.now(),
        adapterName: 'mindmap-internal',
        status: 'error',
        error: {
          code: 'MINDMAP_GENERATION_FAILED',
          message,
          raw,
        },
      })
      await this.chatService.updateThread(threadId, { status: 'error' })
    }

    try {
      // 1. 扫描阶段
      await progress('scanning', `开始扫描项目：${projectName}`)
      const scanner = new ProjectScanner()
      const scanResult = await scanner.scan(projectPath)
      await progress(
        'scanning',
        `扫描完成，框架：${scanResult.framework}，识别到 ${scanResult.modules.length} 个模块`,
        { current: scanResult.modules.length, total: scanResult.modules.length },
      )

      // 2. L3 AI 增强：通过 AgentManager 生成业务语义化的模块
      let modules: ScanModule[] = scanResult.modules
      if (this.agentManager) {
        try {
          await progress('collecting_context', '正在收集项目上下文…')
          const context = await collectContext(projectPath, projectName, scanResult.framework)
          await progress(
            'building_prompt',
            '正在构建全局分析 Prompt…',
            { tokenEstimate: estimateTokens(JSON.stringify(context)) },
          )

          const prompt = buildGlobalPrompt(context)
          const promptTokens = estimateTokens(prompt)
          await progress(
            'building_prompt',
            `Prompt 已生成，长度 ${prompt.length}，预估 ${promptTokens} tokens`,
            { tokenEstimate: promptTokens },
          )

          // 启动 Agent 会话并实时消费输出
          await progress('calling_agent', '正在调用 Agent 生成业务模块…')
          const sessionId = await createAgentSessionForPrompt(this.agentManager, projectPath, prompt, {
            nodeTitle: '思维导图生成',
            timeoutMs: 300_000,
            adapterName: 'mindmap-internal',
            threadId,
          })

          const agentMessageId = generateId('msg')
          let agentContent = ''
          let agentStatus: ChatMessage['status'] = 'streaming'

          const updateAgentMessage = async () => {
            if (!this.chatService || !threadId) return
            await this.chatService.saveMessage(threadId, {
              id: agentMessageId,
              role: 'agent',
              content: agentContent,
              timestamp: Date.now(),
              adapterName: 'mindmap-internal',
              status: agentStatus,
              sessionId,
            })
          }

          const rawOutput = await new Promise<string>((resolve, reject) => {
            const chunks: string[] = []
            let settled = false
            const startTime = Date.now()
            const timeoutMs = 300_000

            const timeoutId = setTimeout(() => {
              if (!settled) {
                settled = true
                this.agentManager!.removeSessionOutputListener(handler)
                this.agentManager!.terminateSession(sessionId, 'timeout').catch((err) => {
                  logger.warn('Failed to terminate session on timeout:', err)
                })
                if (chunks.length > 0) {
                  logger.info('超时但有部分输出，使用已收到的内容')
                  resolve(chunks.join('\n'))
                } else {
                  reject(new Error(`timeout: ${Math.round(timeoutMs / 1000)}s 内未收到任何输出`))
                }
              }
            }, timeoutMs)

            const handler = async (output: AgentOutput) => {
              if (output.type === 'stdout' || output.type === 'file_change') {
                chunks.push(output.data)
                agentContent += output.data
                await updateAgentMessage()
              } else if (output.type === 'stderr') {
                // stderr 追加到 Agent 消息中，便于排查
                agentContent += `\n[stderr] ${output.data}`
                await updateAgentMessage()
              } else if (output.type === 'error') {
                agentContent += `\n[error] ${output.data}`
                await updateAgentMessage()
                if (!settled) {
                  settled = true
                  clearTimeout(timeoutId)
                  this.agentManager!.removeSessionOutputListener(handler)
                  this.agentManager!.terminateSession(sessionId, 'error').catch((err) => {
                    logger.warn('Failed to terminate session on error output:', err)
                  })
                  reject(new Error(output.data || 'Agent error'))
                }
              } else if (output.type === 'complete') {
                if (!settled) {
                  settled = true
                  clearTimeout(timeoutId)
                  this.agentManager!.removeSessionOutputListener(handler)
                  agentStatus = 'success'
                  await updateAgentMessage()
                  logger.info(`完成, 耗时 ${Math.round((Date.now() - startTime) / 1000)}s, 输出 ${chunks.length} 块`)
                  resolve(chunks.join('\n'))
                }
              }
            }

            this.agentManager!.addSessionOutputListener(sessionId, handler)

            this.agentManager!.sendCommand(sessionId, {
              type: 'implement',
              description: prompt,
              targetNodeId: '',
            }).catch((err) => {
              if (!settled) {
                settled = true
                clearTimeout(timeoutId)
                this.agentManager!.removeSessionOutputListener(handler)
                reject(err)
              }
            })
          })

          await progress('parsing_result', '正在解析 Agent 返回结果…')
          const agent = new MindMapAgent(projectPath, this.agentManager)
          const aiModules = agent.parseGenerationResult(rawOutput)
          if (aiModules.length > 0) {
            modules = aiModules
            logger.info(`MindMapAgent 生成 ${aiModules.length} 个业务模块`)
          } else {
            logger.info('MindMapAgent 返回空结果，使用原 scanner 输出')
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          logger.warn('MindMapAgent 失败，降级使用原 scanner:', err)
          await writeWarning(`AI 增强失败：${reason}`, reason)
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
      await progress('creating_graph', `正在创建 online/dev 图（${modules.length} 个模块）…`)
      const onlineGraphId = generateId('graph-online')
      const devGraphId = generateId('graph-dev')

      // better-sqlite3 transaction: auto-commit on normal return, auto-rollback on exception
      this.db.transaction(() => {
        // 创建 online 图（产品蓝图）
        this.db.prepare(
          'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(onlineGraphId, `${projectName} - 产品蓝图`, 'online', projectPath, now, now)

        // 创建 dev 图（开发场景）
        this.db.prepare(
          'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(devGraphId, `${projectName} - 开发场景`, 'dev', projectPath, now, now)

        this.createNodes(onlineGraphId, 'online', graphResult, now, this.db)
        this.createNodes(devGraphId, 'dev', graphResult, now, this.db)
      })()

      this.invalidateProjectPathsCache()

      const featureCount = modules.reduce(
        (sum, m) =>
          sum +
          m.processes.reduce(
            (pSum, p) => pSum + p.features.length,
            0,
          ),
        0,
      )

      if (this.chatService && threadId) {
        await this.chatService.saveMessage(threadId, {
          id: generateId('msg'),
          role: 'system',
          content: `思维导图创建成功：${modules.length} 个模块，${featureCount} 个功能点`,
          timestamp: Date.now(),
          adapterName: 'mindmap-internal',
          status: 'success',
          stage: 'creating_graph',
          structuredContent: [
            {
              type: 'text',
              data: {
                graphId: onlineGraphId,
                moduleCount: modules.length,
                featureCount,
              },
            },
          ],
        })
        await this.chatService.updateThread(threadId, { status: 'idle' })
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
        modules: enrichedScanResult.modules,
        threadId,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.error('initFromProject failed:', err)
      await writeError(`生成思维导图失败：${reason}`, reason)
      throw err
    }
  }

  private createNodes(
    graphId: string,
    graphType: 'online' | 'dev',
    graphResult: ProjectGraphResult,
    now: string,
    executor: BetterSqlite3.Database = this.db,
  ): void {
    const tempIdMap = new Map<string, string>()

    const insertNodeStmt = executor.prepare(`INSERT INTO nodes (
      id, type, status, title, description, acceptance_criteria,
      graph_id, graph_type, parent_id, rules, metadata, owner_role,
      position_x, position_y, content, community_summary, community_level,
      wiki_content, wiki_meta, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

    const updateParentStmt = executor.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?')

    const insertEdgeStmt = executor.prepare('INSERT INTO edges (id, source, target, label, edge_type, graph_id, description, data_flow, strength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')

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

      insertNodeStmt.run(
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
        nodeData.wikiContent ?? null,
        nodeData.wikiMeta ? JSON.stringify(nodeData.wikiMeta) : null,
        now,
        now,
      )
    }

    // 第二轮：更新 parent_id
    for (const nodeData of graphResult.nodes) {
      if (nodeData.parentTempId) {
        const nodeId = tempIdMap.get(nodeData.tempId)
        const parentId = tempIdMap.get(nodeData.parentTempId)
        if (nodeId && parentId) {
          updateParentStmt.run(parentId, nodeId)
        }
      }
    }

    // 第三轮：创建边
    for (const edgeData of graphResult.edges) {
      const sourceId = tempIdMap.get(edgeData.sourceTempId)
      const targetId = tempIdMap.get(edgeData.targetTempId)
      if (sourceId && targetId) {
        const edgeId = generateId('edge')
        insertEdgeStmt.run(
          edgeId, sourceId, targetId, edgeData.label ?? null,
          edgeData.edgeType ?? 'default', graphId, edgeData.description ?? null,
          edgeData.dataFlow ?? null, edgeData.strength ?? null,
        )
      } else {
        logger.warn(`Edge dropped: sourceTempId="${edgeData.sourceTempId}" or targetTempId="${edgeData.targetTempId}" not found in tempIdMap`)
      }
    }
  }

  getProjectPaths(): string[] {
    if (this.cachedProjectPaths === null) {
      this.cachedProjectPaths = this.graphRepo.getProjectPaths()
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
    const rows = this.db.prepare(
      'SELECT id, metadata FROM nodes WHERE graph_id = ? AND metadata IS NOT NULL'
    ).all(graphId)

    // 构建 filePath → nodeId 映射
    const fileToNode = new Map<string, string>()
    const nodeFiles = new Map<string, string[]>()

    for (const row of rows) {
      const nodeId = String((row as Record<string, unknown>).id)
      const metadataStr = String((row as Record<string, unknown>).metadata)
      try {
        const metadata = JSON.parse(metadataStr)
        if (!metadata || typeof metadata !== 'object') continue
        const files = metadata.fileAssociations?.map((f: { path: string }) => f.path) ?? []
        nodeFiles.set(nodeId, files)
        for (const file of files) {
          fileToNode.set(file, nodeId)
        }
      } catch (err) {
        logger.debug(`Invalid metadata JSON for node ${nodeId}`, err)
      }
    }

    // 查询已存在的边，避免重复建议
    const existingEdgeRows = this.db.prepare(
      'SELECT source, target FROM edges WHERE graph_id = ?'
    ).all(graphId)
    const edgeSet = new Set(existingEdgeRows.map((r) => {
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
