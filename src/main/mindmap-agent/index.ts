/**
 * MindMapAgent 主服务
 *
 * 直接调用 claude-runner（使用 process.env，与终端环境一致）。
 * 通过 AgentManager 的 session 做生命周期管理。
 *
 * 支持四种操作粒度：
 * - generateFull: 全项目初始化
 * - generateModule: 单模块生成
 * - enrichNode: 节点深化
 * - refine: 迭代精炼
 */

import { runClaude, extractJson } from './claude-runner'
import { readMemory, updateDomains, addRefinement } from './memory'
import { validateModules, validateEnrichment, type ValidatedEnrichment } from './schema-validator'
import { collectContext } from './context-collector'
import { classifyComplexity } from './complexity-classifier'
import { directRetrieve } from './retrieval/direct'
import { buildGlobalPrompt } from './retrieval/global'
import { buildDevPrompt } from './synthesis/prompt-builder'
import type { ScanModule, NodeType, GraphNode, GraphEdge } from '@shared/types'
import type { TaskType } from './synthesis/prompt-templates'

export class MindMapAgent {
  private projectPath: string

  constructor(projectPath: string) {
    this.projectPath = projectPath
  }

  // ========================================
  // 全项目生成
  // ========================================

  async generateFull(projectName: string, framework: string): Promise<ScanModule[]> {
    try {
      const context = await collectContext(this.projectPath, projectName, framework)
      const prompt = buildGlobalPrompt(context)

      console.log('[MindMapAgent] 开始生成，prompt 长度:', prompt.length)
      const result = await runClaude(prompt, {
        cwd: this.projectPath,
        timeoutMs: 120_000,
        outputFormat: 'text',
      })
      console.log('[MindMapAgent] Claude 返回，exitCode:', result.exitCode, 'timedOut:', result.timedOut, 'stdout 长度:', result.stdout.length)

      if (result.exitCode !== 0 || result.timedOut || !result.stdout) {
        throw new Error(`Claude 调用失败: exitCode=${result.exitCode} timedOut=${result.timedOut} stderr=${result.stderr}`)
      }

      const parsed = extractJson(result.stdout)
      const modules = validateModules(parsed)
      console.log('[MindMapAgent] 解析到', modules.length, '个模块')

      if (modules.length === 0) {
        throw new Error('未返回有效模块')
      }

      // 写入记忆
      await updateDomains(
        this.projectPath,
        modules.map((m) => m.name),
        context.memory.architecturePattern || `${projectName} 项目`,
      )

      return modules
    } catch (err) {
      console.error('[MindMapAgent] generateFull failed:', err)
      return []
    }
  }

  // ========================================
  // 单模块生成
  // ========================================

  async generateModule(moduleDir: string, _allModules: ScanModule[] = []): Promise<ScanModule | null> {
    try {
      const context = await collectContext(this.projectPath, moduleDir, '')
      const memory = await readMemory(this.projectPath)
      const prompt = buildModuleGenerationPrompt(moduleDir, context.directoryTree, memory.preferences)

      const result = await runClaude(prompt, { cwd: this.projectPath, timeoutMs: 60_000 })
      if (result.exitCode !== 0 || result.timedOut || !result.stdout) {
        throw new Error('Claude 调用失败')
      }

      const parsed = extractJson(result.stdout)
      return validateModules(parsed)[0] || null
    } catch (err) {
      console.error('[MindMapAgent] generateModule failed:', err)
      return null
    }
  }

  // ========================================
  // 节点深化
  // ========================================

  async enrichNode(
    nodeTitle: string,
    nodeType: NodeType,
    relatedFiles: string[] = [],
  ): Promise<ValidatedEnrichment | null> {
    const retrieved = await directRetrieve(this.projectPath, nodeTitle, nodeType, relatedFiles)
    const prompt = buildEnrichmentPrompt(nodeTitle, nodeType, retrieved.nodeContent)

    const result = await runClaude(prompt, { cwd: this.projectPath, timeoutMs: 60_000 })
    if (result.exitCode !== 0 || result.timedOut || !result.stdout) {
      throw new Error(
        `Claude 调用失败: exitCode=${result.exitCode} timedOut=${result.timedOut}` +
        (result.stderr ? ` stderr=${result.stderr.substring(0, 300)}` : '')
      )
    }

    const parsed = extractJson(result.stdout)
    const enrichment = validateEnrichment(parsed)
    if (!enrichment) {
      throw new Error(`Claude 输出校验失败: ${result.stdout.substring(0, 300)}`)
    }

    return enrichment
  }

  // ========================================
  // 迭代精炼
  // ========================================

  async refine(
    scope: 'project' | 'module' | 'node',
    targetId: string,
    feedback: string,
    _allModules: ScanModule[] = [],
  ): Promise<ScanModule[] | ScanModule | ValidatedEnrichment | null> {
    const memory = await readMemory(this.projectPath)
    classifyComplexity(feedback, memory.businessDomains)
    const prompt = buildRefinementPrompt(scope, targetId, feedback, _allModules, memory)

    const result = await runClaude(prompt, { cwd: this.projectPath, timeoutMs: 60_000 })
    if (result.exitCode !== 0 || result.timedOut || !result.stdout) {
      throw new Error(
        `Claude 调用失败: exitCode=${result.exitCode} timedOut=${result.timedOut}` +
        (result.stderr ? ` stderr=${result.stderr.substring(0, 300)}` : '')
      )
    }

    const parsed = extractJson(result.stdout)
    let output: ScanModule[] | ScanModule | ValidatedEnrichment | null = null
    if (scope === 'project') output = validateModules(parsed)
    else if (scope === 'module') output = validateModules(parsed)[0] || null
    else output = validateEnrichment(parsed)

    await addRefinement(this.projectPath, {
      scope, targetId,
      before: `[${scope}] ${targetId}`,
      after: JSON.stringify(output).substring(0, 200),
      userFeedback: feedback,
      reason: `用户精炼：${feedback.substring(0, 100)}`,
    })

    return output
  }

  // ========================================
  // 解析 AgentChat 返回的结果
  // ========================================

  /**
   * 解析 AgentChat 返回的原始输出为 ScanModule[]
   * 用于 mindmap:generate IPC（结果通过 AgentChat 收集）
   */
  parseGenerationResult(rawOutput: string): ScanModule[] {
    try {
      const parsed = extractJson(rawOutput)
      const modules = validateModules(parsed)
      console.log('[MindMapAgent] 解析到', modules.length, '个模块')

      if (modules.length > 0) {
        // 异步更新记忆，不阻塞结果返回
        void updateDomains(
          this.projectPath,
          modules.map((m) => m.name),
          '',
        ).catch((err) => {
          console.warn('[MindMapAgent] updateDomains failed:', err)
        })
      }

      return modules
    } catch (err) {
      console.error('[MindMapAgent] parseGenerationResult failed:', err)
      return []
    }
  }

  // ========================================
  // Prompt 生成（Graph → Prompt）
  // ========================================

  buildDevPromptForNode(
    node: GraphNode, taskType: TaskType,
    allNodes: GraphNode[], allEdges: GraphEdge[],
    options?: { bugDescription?: string; refactorGoal?: string },
  ): string {
    return buildDevPrompt({ node, taskType, allNodes, allEdges, ...options })
  }
}

// ========================================
// 内部 Prompt 构建
// ========================================

function buildModuleGenerationPrompt(
  moduleDir: string, directoryTree: string,
  preferences: { namingStyle: string; avoidPatterns: string[] },
): string {
  return `你是一个业务架构分析师。请分析以下目录，生成一个业务模块的思维导图结构。

目录：${moduleDir}
目录结构：
${directoryTree}

命名风格：${preferences.namingStyle === 'business' ? '使用业务语言' : '技术与业务结合'}
禁止：${preferences.avoidPatterns.join('、')}

输出 JSON：
\`\`\`json
{"name":"模块业务名称","description":"一句话描述","processes":[{"name":"业务流程名称","description":"流程描述","features":[{"name":"功能名","description":"功能描述"}]}]}
\`\`\``
}

function buildEnrichmentPrompt(nodeTitle: string, nodeType: NodeType, nodeContent: string): string {
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

function buildRefinementPrompt(
  scope: string, targetId: string, feedback: string,
  allModules: ScanModule[], memory: import('@shared/types').ProjectMemory,
): string {
  const ctx = scope === 'project'
    ? `模块列表：\n${allModules.map((m) => `- ${m.name}: ${m.description}`).join('\n')}`
    : scope === 'module'
      ? `模块：\n${JSON.stringify(allModules.find((m) => m.name === targetId), null, 2)}`
      : `节点：${targetId}`

  return `用户对思维导图提出精炼反馈。

当前状态：${ctx}
用户反馈：${feedback}
偏好：命名${memory.preferences.namingStyle}，粒度${memory.preferences.granularity}
禁止：${memory.preferences.avoidPatterns.join('、')}

基于反馈修改，输出修改后的 JSON。`
}
