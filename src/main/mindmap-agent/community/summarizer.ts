/**
 * 社区摘要生成器
 *
 * 调用 Claude 为每个社区层级生成摘要。
 * 使用 map-reduce 模式：先独立生成各模块摘要，再聚合为项目级摘要。
 */

import { runClaude } from '../claude-runner'
import { buildCommunitySummaryPrompt, type CommunityCluster } from './clustering'
import type { ScanModule } from '@shared/types'

/**
 * 为单个社区生成摘要
 */
export async function generateSummary(
  cluster: CommunityCluster,
  context: string,
  projectPath: string,
): Promise<string> {
  const prompt = buildCommunitySummaryPrompt(cluster, context)

  const result = await runClaude(prompt, {
    cwd: projectPath,
    timeoutMs: 30_000,
    outputFormat: 'text',
  })

  if (result.exitCode !== 0 || result.timedOut) {
    // 降级：使用静态摘要
    return generateFallbackSummary(cluster, context)
  }

  return result.stdout || generateFallbackSummary(cluster, context)
}

/**
 * Map-Reduce 模式：先生成所有模块级摘要，再聚合为项目级
 */
export async function mapReduceSummarize(
  modules: ScanModule[],
  projectPath: string,
  projectName: string,
): Promise<Map<string, string>> {
  const summaries = new Map<string, string>()

  // Map 阶段：独立生成每个模块的摘要
  const modulePromises = modules.map(async (mod) => {
    const context = formatModuleContext(mod)
    const cluster: CommunityCluster = {
      id: `module_${mod.name}`,
      title: `${mod.name} 业务域`,
      nodeIds: [],
      filePaths: [],
      level: 1,
    }
    const summary = await generateSummary(cluster, context, projectPath)
    summaries.set(mod.name, summary)
    return { name: mod.name, summary }
  })

  const moduleResults = await Promise.all(modulePromises)

  // Reduce 阶段：聚合模块摘要为项目级摘要
  const projectContext = [
    `项目名称：${projectName}`,
    '',
    '各模块摘要：',
    ...moduleResults.map((r) => `- ${r.name}: ${r.summary}`),
  ].join('\n')

  const projectCluster: CommunityCluster = {
    id: 'project_root',
    title: `${projectName} 整体架构`,
    nodeIds: [],
    filePaths: [],
    level: 0,
  }
  const projectSummary = await generateSummary(projectCluster, projectContext, projectPath)
  summaries.set('__project__', projectSummary)

  return summaries
}

/**
 * 格式化模块上下文
 */
function formatModuleContext(mod: ScanModule): string {
  const lines: string[] = [`模块描述：${mod.description}`]

  for (const proc of mod.processes) {
    lines.push(`\n流程：${proc.name} - ${proc.description}`)
    for (const feat of proc.features) {
      lines.push(`  - ${feat.name}: ${feat.description}`)
    }
  }

  return lines.join('\n')
}

/**
 * 降级摘要（Claude 不可用时）
 */
function generateFallbackSummary(cluster: CommunityCluster, context: string): string {
  if (cluster.level === 0) {
    return `项目包含多个业务模块。${context.substring(0, 200)}`
  }
  return `${cluster.title}：${context.substring(0, 150)}`
}
