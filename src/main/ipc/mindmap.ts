/**
 * MindMap Agent IPC Handlers
 *
 * 思维导图 AI 生成通过 AgentChat 执行：
 * 1. 先生成 prompt（本地计算，不调用 Claude）
 * 2. 通过 agent:sendCommand 发送到 AgentChat
 * 3. AgentChat 的 ClaudeCodeAdapter 处理并返回结果
 * 4. 解析结果并写入图谱
 */

import { MindMapAgent } from '../mindmap-agent'
import { buildDevPrompt, augmentWithRagExamples } from '../mindmap-agent/synthesis/prompt-builder'
import { collectContext } from '../mindmap-agent/context-collector'
import { buildGlobalPrompt } from '../mindmap-agent/retrieval/global'
import { directRetrieve } from '../mindmap-agent/retrieval/direct'
import { sendPromptViaAgent } from '../agent/send-and-wait'
import { extractJson } from '../mindmap-agent/claude-runner'
import { validateEnrichment } from '../mindmap-agent/schema-validator'
import { validateProjectPath } from './utils'
import type { TypedHandle } from './utils'
import type { NodeType, GraphNode, ContextRef } from '@shared/types'
import type { AgentManager } from '../agent/agent-manager'
import type { NodeRepository } from '../repositories/node-repository'
import type { EdgeRepository } from '../repositories/edge-repository'
import type { GraphRepository } from '../repositories/graph-repository'
import { IpcError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'

const logger = createLogger('MindMap')

export function registerMindmapHandlers(
  typedHandle: TypedHandle,
  agentManager: AgentManager,
  // 三个仓储是必需的：mindmap:buildDevPrompt 需要真实节点 / 边 / 图的
  // projectPath 才能组装上下文。做成可选参数的话，调用方漏传就会静默退回
  // 「空上下文 prompt」—— 不报错，只是生成的开发提示少了全部业务信息。
  nodeRepo: NodeRepository,
  edgeRepo: EdgeRepository,
  graphRepo: GraphRepository,
): void {
  /**
   * mindmap:generate — 生成全项目思维导图
   *
   * 不直接调用 Claude，而是：
   * 1. 生成 prompt
   * 2. 创建 AgentChat 会话
   * 3. 发送 prompt
   * 4. 收集输出
   * 5. 解析并返回 ScanModule[]
   */
  typedHandle('mindmap:generate', async (_, projectPath: string) => {
    const validatedPath = validateProjectPath(projectPath)
    const projectName = validatedPath.split(/[/\\]/).pop() || 'Project'

    // 1. 生成 prompt（本地计算）
    const context = await collectContext(validatedPath, projectName, '')
    const prompt = buildGlobalPrompt(context)
    logger.info(`Prompt 已生成, 长度: ${prompt.length}`)

    // 2. 通过 AgentManager 发送 prompt 并收集结果（输出实时显示在 AgentChat）
    const result = await sendPromptViaAgent(agentManager, validatedPath, prompt, {
      nodeTitle: '思维导图生成',
      adapterName: 'mindmap-internal',
    })
    logger.info(`收到结果, 长度: ${result.length}`)

    // 3. 解析结果
    const agent = new MindMapAgent(validatedPath)
    return agent.parseGenerationResult(result)
  })

  /**
   * mindmap:enrichNode — AI 补充节点详情（流式显示在 AgentChat）
   */
  typedHandle('mindmap:enrichNode', async (
    _,
    projectPath: string,
    _nodeId: string,
    nodeType: NodeType,
    nodeTitle: string,
    relatedFiles?: string[],
    contextRefs?: ContextRef[],
  ) => {
    const validatedPath = validateProjectPath(projectPath)

    let contextBlock = ''
    if (contextRefs && contextRefs.length > 0) {
      const textContexts = contextRefs.filter((c) => c.type === 'text' && c.content)
      const fileContexts = contextRefs.filter((c) => c.type === 'file')
      if (textContexts.length > 0) {
        contextBlock += '\n\n用户提供的额外上下文：\n' + textContexts.map((c) => `- ${c.label}: ${c.content}`).join('\n')
      }
      if (fileContexts.length > 0) {
        contextBlock += '\n\n关联文件：\n' + fileContexts.map((c) => `- ${c.label}`).join('\n')
      }
    }

    const retrieved = await directRetrieve(validatedPath, nodeTitle, nodeType, relatedFiles || [])
    const prompt = buildEnrichmentPromptLocal(nodeTitle, nodeType, retrieved.nodeContent || '') + contextBlock

    const result = await sendPromptViaAgent(agentManager, validatedPath, prompt, {
      nodeTitle: `补充详情: ${nodeTitle}`,
      timeoutMs: 120_000,
      adapterName: 'mindmap-internal',
    })

    return validateEnrichment(extractJson(result))
  })

  /**
   * mindmap:refine — 迭代精炼
   */
  typedHandle('mindmap:refine', async (
    _,
    projectPath: string,
    scope: 'project' | 'module' | 'node',
    targetId: string,
    feedback: string,
  ) => {
    const validatedPath = validateProjectPath(projectPath)
    const agent = new MindMapAgent(validatedPath, agentManager)
    const result = await agent.refine(scope, targetId, feedback)
    return result
  })

  /**
   * mindmap:buildDevPrompt — 从图谱生成开发 Prompt
   */
  typedHandle('mindmap:buildDevPrompt', async (
    _,
    nodeId: string,
    nodeTitle: string,
    nodeType: NodeType,
    taskType: 'feature' | 'bugfix' | 'refactor',
    graphId: string,
    contextRefs?: ContextRef[],
  ) => {
    let extraContext = ''
    if (contextRefs && contextRefs.length > 0) {
      const parts: string[] = []
      for (const ctx of contextRefs) {
        if (ctx.type === 'text' && ctx.content) {
          parts.push(`[${ctx.label}] ${ctx.content}`)
        } else if (ctx.type === 'file') {
          parts.push(`关联文件: ${ctx.label}`)
        }
      }
      if (parts.length > 0) {
        extraContext = '用户提供的额外上下文：\n' + parts.join('\n')
      }
    }

    const placeholderNode: GraphNode = {
      id: nodeId,
      type: nodeType,
      status: 'confirmed',
      title: nodeTitle,
      graphId,
      graphType: 'dev',
      position: { x: 0, y: 0 },
      contextRefs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // 必须从图谱加载真实节点与上下文：占位节点没有 parentId / description，
    // allNodes / allEdges 为空时祖先链、子节点、关联边、关联节点四段上下文
    // 永远为空，生成的开发 prompt 丢掉全部业务信息。
    const storedNode = nodeRepo.findById(nodeId) ?? null
    const contextGraphId = storedNode?.graphId ?? graphId
    const allNodes = nodeRepo.listByGraph(contextGraphId) ?? []
    const allEdges = edgeRepo.listByGraph(contextGraphId) ?? []

    const prompt = buildDevPrompt({
      node: storedNode ?? placeholderNode,
      taskType,
      allNodes,
      allEdges,
      extraContext: extraContext || undefined,
    })

    // RAG few-shot：从记忆库检索同类项目结构补进 prompt。
    // 记忆的 project_id 就是项目工作目录，据此把检索限定在当前项目内，
    // 语义检索才不会被其它项目的记忆污染。
    const projectPath = graphRepo.getProjectPath(contextGraphId)
    // 没有 project_path 的图（手工创建的图）无从判断记忆归属 —— 此时不检索。
    // 传 undefined 进去会让检索跨所有项目，把别的项目的历史当成本项目的先例。
    if (!projectPath) return prompt
    return augmentWithRagExamples(prompt, storedNode ?? placeholderNode, allNodes, allEdges, projectPath)
  })

  /**
   * mindmap:generateModule — AI 生成子节点
   */
  typedHandle('mindmap:generateModule', async (
    _,
    projectPath: string,
    _parentNodeId: string,
    parentNodeTitle: string,
    parentNodeType: NodeType,
  ) => {
    const labels: Record<string, string> = { module: '业务模块', process: '业务流程', feature: '功能点' }
    const childType: NodeType = parentNodeType === 'module' ? 'process' : 'feature'
    // projectPath 会成为 Agent 会话的 workingDirectory（CLI cwd + ScopeGuard 根），
    // 必须与其它 mindmap handler 一样先做校验。
    const validatedPath = validateProjectPath(projectPath)

    const prompt = `请为以下${labels[parentNodeType]}生成子${labels[childType]}列表。

父节点：${parentNodeTitle}（${labels[parentNodeType]}）

要求：
1. 每个子节点要有明确的业务含义
2. 使用业务语言命名，不使用技术术语
3. 每个子节点包含简短描述

输出 JSON：
\`\`\`json
{"children":[{"title":"子节点名称","description":"简短业务描述"}]}
\`\`\`

只输出 JSON，不要其他内容。`

    const result = await sendPromptViaAgent(agentManager, validatedPath, prompt, {
      nodeTitle: `AI 生成子节点: ${parentNodeTitle}`,
      timeoutMs: 60_000,
      adapterName: 'mindmap-internal',
    })

    const parsed = extractJson(result) as Record<string, unknown>
    if (!parsed || !Array.isArray(parsed.children)) {
      throw new IpcError('AI 返回格式错误', ErrorCode.IPC_HANDLER_ERROR)
    }

    const children: Array<{ title: string; description?: string }> = []
    for (const child of parsed.children) {
      if (!child || typeof child !== 'object') {
        throw new IpcError('AI 返回的子节点必须是对象', ErrorCode.IPC_HANDLER_ERROR)
      }
      const c = child as Record<string, unknown>
      if (typeof c.title !== 'string' || c.title.length === 0) {
        throw new IpcError('AI 返回的子节点 title 必须是有效字符串', ErrorCode.IPC_HANDLER_ERROR)
      }
      if (c.description !== undefined && typeof c.description !== 'string') {
        throw new IpcError('AI 返回的子节点 description 必须是字符串', ErrorCode.IPC_HANDLER_ERROR)
      }
      children.push({ title: c.title, description: c.description as string | undefined })
    }

    return {
      childType,
      children,
    }
  })
}

/** 内联 enrichment prompt 模板（原 MindMapAgent 的私有函数） */
function buildEnrichmentPromptLocal(nodeTitle: string, nodeType: NodeType, nodeContent: string): string {
  const labels: Record<string, string> = { module: '业务模块', process: '业务流程', feature: '功能点', bug: 'BUG点' }
  return `请为以下${labels[nodeType] || '节点'}补充详细内容。

节点：${nodeTitle}（${labels[nodeType] || nodeType}）
内容：
${nodeContent}

输出 JSON：
\`\`\`json
{"description":"详细业务描述","acceptanceCriteria":["验收标准"],"businessRules":[{"id":"r1","title":"规则","description":"描述","condition":"条件","action":"动作"}],"relatedFiles":["src/..."],"implementationHints":["要点"],"codeSignatures":["fn()"]}
\`\`\``
}
