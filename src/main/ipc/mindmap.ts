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
import { buildDevPrompt } from '../mindmap-agent/synthesis/prompt-builder'
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
import { IpcError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'

const logger = createLogger('MindMap')

export function registerMindmapHandlers(typedHandle: TypedHandle, agentManager: AgentManager): void {
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
    return buildDevPrompt({ node: placeholderNode, taskType, allNodes: [], allEdges: [], extraContext: extraContext || undefined })
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

    const result = await sendPromptViaAgent(agentManager, projectPath, prompt, {
      nodeTitle: `AI 生成子节点: ${parentNodeTitle}`,
      timeoutMs: 60_000,
      adapterName: 'mindmap-internal',
    })

    const parsed = extractJson(result) as Record<string, unknown>
    if (!parsed || !Array.isArray(parsed.children)) {
      throw new IpcError('AI 返回格式错误', ErrorCode.IPC_HANDLER_ERROR)
    }

    return {
      childType,
      children: parsed.children as Array<{ title: string; description?: string }>,
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
