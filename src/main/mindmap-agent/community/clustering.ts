/**
 * 社区聚类与摘要生成
 *
 * 简化版 Leiden：基于目录结构 + 文件关联做社区聚类。
 * 生成分层社区摘要，用于 GraphRAG 式渐进式检索。
 */

import path from 'node:path'
import type { CommunitySummary, ScanModule } from '@shared/types'
import { generateId } from '../../shared/env'

export interface CommunityCluster {
  id: string
  title: string
  nodeIds: string[]
  filePaths: string[]
  level: number // 0=项目级, 1=模块级, 2=流程级
}

/**
 * 基于目录结构的社区聚类
 *
 * 策略：
 * - Level 0: 整个项目 = 1 个社区
 * - Level 1: src/ 下的一级子目录各为 1 个社区
 * - Level 2: 每个一级子目录下的二级子目录各为 1 个社区
 */
export async function clusterCommunities(
  projectPath: string,
  modules: ScanModule[],
): Promise<CommunityCluster[]> {
  const clusters: CommunityCluster[] = []

  // Level 0: 项目级
  clusters.push({
    id: generateId('community'),
    title: `${path.basename(projectPath)} 整体架构`,
    nodeIds: modules.flatMap((m) => m.processes.flatMap((p) => p.features.map(() => `placeholder`))),
    filePaths: [],
    level: 0,
  })

  // Level 1: 模块级（直接从 ScanModule 映射）
  for (const mod of modules) {
    clusters.push({
      id: generateId('community'),
      title: `${mod.name} 业务域`,
      nodeIds: mod.processes.flatMap((p) => p.features.map(() => `placeholder`)),
      filePaths: [],
      level: 1,
    })
  }

  // Level 2: 流程级
  for (const mod of modules) {
    for (const proc of mod.processes) {
      clusters.push({
        id: generateId('community'),
        title: `${mod.name} > ${proc.name}`,
        nodeIds: proc.features.map(() => `placeholder`),
        filePaths: [],
        level: 2,
      })
    }
  }

  return clusters
}

/**
 * 为社区生成摘要（调用 Claude）
 *
 * 从模块结构信息生成：
 * - 项目级：整体架构概览
 * - 模块级：模块职责、包含的流程、核心约束
 * - 流程级：流程描述、包含的功能点
 */
export function buildCommunitySummaryPrompt(cluster: CommunityCluster, context: string): string {
  if (cluster.level === 0) {
    return `你是一个业务架构分析师。请根据以下项目信息，生成一段简洁的项目架构摘要（150字以内）。

${context}

要求：
- 描述项目的整体业务目标和核心能力
- 列出主要业务域（3-6个）
- 说明技术架构模式

直接输出摘要文本，不要 JSON。`
  }

  if (cluster.level === 1) {
    return `你是一个业务架构分析师。请根据以下模块信息，生成一段简洁的模块摘要（100字以内）。

模块名称：${cluster.title}

${context}

要求：
- 描述该模块的核心业务职责
- 列出包含的主要业务流程
- 说明与其他模块的关键关联

直接输出摘要文本，不要 JSON。`
  }

  // level 2
  return `你是一个业务架构分析师。请根据以下流程信息，生成一段简洁的流程摘要（80字以内）。

流程名称：${cluster.title}

${context}

要求：
- 描述该流程的业务目的
- 列出包含的关键功能点

直接输出摘要文本，不要 JSON。`
}

/**
 * 将聚类结果转换为 CommunitySummary 类型
 */
export function toCommunitySummary(
  cluster: CommunityCluster,
  summary: string,
  findings: string[] = [],
): CommunitySummary {
  return {
    id: cluster.id,
    graphId: '', // 由调用方填充
    level: cluster.level,
    nodeIds: cluster.nodeIds,
    title: cluster.title,
    summary,
    keyFindings: findings,
  }
}
