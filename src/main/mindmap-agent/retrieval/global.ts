/**
 * Global Retrieval — 全项目 Map-Reduce 检索
 *
 * 对项目做社区聚类，为每个社区生成摘要，map-reduce 聚合。
 * 用于全项目初始化场景。
 */

import type { ScanModule } from '@shared/types'
import { runClaude } from '../claude-runner'
import { extractJson } from '../claude-runner'
import { collectContext } from '../context-collector'
import type { MindMapContext } from '../context-collector'
import { AgentError, ErrorCode } from '../../errors'

export interface GlobalRetrievalResult {
  /** AI 生成的模块列表 */
  modules: ScanModule[]
  /** 项目级社区摘要 */
  projectSummary: string
  /** 各模块摘要 */
  moduleSummaries: Map<string, string>
  tokenEstimate: number
}

/**
 * 全项目 Map-Reduce 检索
 */
export async function globalRetrieve(
  projectPath: string,
  projectName: string,
  framework: string,
): Promise<GlobalRetrievalResult> {
  // 1. 收集项目上下文
  const context = await collectContext(projectPath, projectName, framework)

  // 2. 构建全项目分析 prompt
  const prompt = buildGlobalPrompt(context)

  // 3. 调用 Claude
  const result = await runClaude(prompt, {
    cwd: projectPath,
    timeoutMs: 90_000,
    outputFormat: 'text',
  })

  if (result.exitCode !== 0 || result.timedOut || !result.stdout) {
    throw new AgentError(`Claude 调用失败: ${result.stderr || 'timeout'}`, ErrorCode.AGENT_PROCESS_ERROR)
  }

  // 4. 解析 JSON 输出
  const parsed = extractJson(result.stdout)
  const modules = normalizeModules(parsed)

  return {
    modules,
    projectSummary: context.memory.architecturePattern || `${projectName} 项目`,
    moduleSummaries: new Map(modules.map((m) => [m.name, m.description])),
    tokenEstimate: 8000, // 固定预算
  }
}

/**
 * 构建全项目分析 prompt
 */
export function buildGlobalPrompt(context: MindMapContext, recommendedDomains: string[] = []): string {
  const preferences = context.memory.preferences
  const avoidList = preferences.avoidPatterns.map((p) => `- ${p}`).join('\n')

  return `你是一个精准的业务架构分析师。你的任务是分析项目代码和文档，生成体现业务逻辑的思维导图结构。

## 规则
1. 模块 = 业务域（如"用户管理"、"订单系统"），不是技术层（如"服务层"、"数据层"）
2. 流程 = 业务流程（如"用户注册流程"、"商品下单流程"），不是技术分类（如"界面层"）
3. 功能点 = 具体业务功能（如"手机号注册"、"订单查询"），不是文件名或 npm 命令
4. 以下模式禁止出现：
${avoidList}
5. 模块数量 ${Math.max(3, preferences.maxModules - 2)}-${preferences.maxModules} 个
6. 命名风格：${preferences.namingStyle === 'business' ? '使用业务语言，不用技术术语' : preferences.namingStyle === 'technical' ? '使用技术语言' : '业务和技术结合'}
7. 每个模块下 2-4 个流程，每个流程下 2-5 个功能点
8. 如果项目是工具型/库型项目，模块应按"能力域"划分

${context.memory.businessDomains.length > 0 ? `\n## 已知业务域（来自之前分析）\n${context.memory.businessDomains.join(', ')}` : ''}
${recommendedDomains.length > 0 ? `\n## 推荐业务域（来自全局知识库）\n${recommendedDomains.join(', ')}` : ''}
${context.memory.refinements.length > 0 ? `\n## 用户偏好（从精炼历史学习）\n- 粒度偏好：${preferences.granularity}\n- 命名风格：${preferences.namingStyle}` : ''}

## 项目信息
项目名：${context.projectName}
框架：${context.framework}

### 目录结构
\`\`\`
${context.directoryTree}
\`\`\`

### package.json
\`\`\`
${context.packageJsonSummary}
\`\`\`

### README
${context.readmeContent}

### 入口文件
\`\`\`
${context.entryPointContent}
\`\`\`

### 关键文件
${context.keyFileSnippets}

## 输出要求
严格输出以下 JSON，不要包含任何其他内容：

\`\`\`json
{
  "modules": [
    {
      "name": "业务域名称",
      "description": "一句话说明该业务域做什么",
      "processes": [
        {
          "name": "业务流程名称",
          "description": "流程描述",
          "features": [
            {
              "name": "功能点名称",
              "description": "该功能点做什么"
            }
          ]
        }
      ]
    }
  ]
}
\`\`\``
}

/**
 * 标准化解析 Claude 输出为 ScanModule[]
 */
function normalizeModules(parsed: unknown): ScanModule[] {
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>
  const rawModules = Array.isArray(obj.modules) ? obj.modules : (Array.isArray(obj) ? obj : [])

  return rawModules
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      name: String(m.name || '').trim(),
      description: String(m.description || '').trim(),
      processes: Array.isArray(m.processes)
        ? m.processes
            .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
            .map((p) => ({
              name: String(p.name || '').trim(),
              description: String(p.description || '').trim(),
              features: Array.isArray(p.features)
                ? p.features
                    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
                    .map((f) => ({
                      name: String(f.name || '').trim(),
                      description: String(f.description || '').trim(),
                      type: 'feature' as const,
                    }))
                : [],
            }))
        : [],
    }))
    .filter((m) => m.name && m.processes.length > 0)
}
