/**
 * DRIFT Retrieval — 跨模块渐进式精炼检索
 *
 * 从匹配节点出发，渐进式探索关联模块。
 * 每轮生成后续问题方向，按 token 预算（12K）截断。
 * 研究依据：DRIFT 三阶段精炼比单次 Local 更全面 [Edge 2024]
 */

import type { ScanModule, CommunitySummary } from '@shared/types'

export interface DriftRetrievalResult {
  /** 所有收集到的模块内容 */
  collectedModules: Array<{ module: ScanModule; relevance: number }>
  /** 探索路径 */
  explorationPath: string[]
  /** 社区摘要 */
  communitySummary?: string
  tokenEstimate: number
}

import { estimateTokens } from '../../../shared/token-utils'

/**
 * DRIFT 渐进式检索
 *
 * Phase 1: 加载直接匹配模块
 * Phase 2: 基于关联边探索邻居模块
 * Phase 3: 按需深入二级邻居
 */
export function driftRetrieve(
  matchedDomains: string[],
  allModules: ScanModule[],
  communitySummaries: CommunitySummary[] = [],
  tokenBudget: number = 12000,
): DriftRetrievalResult {
  let usedTokens = 0
  const collectedModules: Array<{ module: ScanModule; relevance: number }> = []
  const explorationPath: string[] = []
  const visited = new Set<string>()

  // Phase 1: 加载直接匹配模块（完整内容）
  for (const domain of matchedDomains) {
    const mod = allModules.find((m) =>
      m.name.toLowerCase().includes(domain.toLowerCase()) ||
      domain.toLowerCase().includes(m.name.toLowerCase()),
    )
    if (mod && !visited.has(mod.name)) {
      const text = formatModule(mod)
      const tokens = estimateTokens(text)
      if (usedTokens + tokens <= tokenBudget) {
        collectedModules.push({ module: mod, relevance: 1.0 })
        visited.add(mod.name)
        usedTokens += tokens
        explorationPath.push(`[Phase1] 加载直接匹配模块: ${mod.name}`)
      }
    }
  }

  // Phase 2: 基于模块间关联探索邻居
  // 关联推断：描述中包含对方模块名、共享实体名等
  const candidates = allModules
    .filter((m) => !visited.has(m.name))
    .map((m) => ({
      module: m,
      relevance: computeRelevance(m, collectedModules),
    }))
    .sort((a, b) => b.relevance - a.relevance)

  for (const candidate of candidates) {
    if (usedTokens >= tokenBudget * 0.8) break // 留 20% 给 Phase 3
    if (candidate.relevance < 0.2) break // 关联度太低，停止探索

    const mod = candidate.module
    // 邻居只加载摘要级内容
    const summary = communitySummaries.find(
      (s) => s.level === 1 && s.title.includes(mod.name),
    )
    const text = summary
      ? `${mod.name}: ${summary.summary}`
      : `${mod.name}: ${mod.description}\n${mod.processes.map((p) => `  - ${p.name}`).join('\n')}`
    const tokens = estimateTokens(text)

    if (usedTokens + tokens <= tokenBudget * 0.8) {
      collectedModules.push({ module: mod, relevance: candidate.relevance })
      visited.add(mod.name)
      usedTokens += tokens
      explorationPath.push(`[Phase2] 探索关联模块: ${mod.name} (关联度: ${candidate.relevance.toFixed(2)})`)
    }
  }

  // Phase 3: 对高关联度邻居加载完整内容
  for (const collected of collectedModules) {
    if (collected.relevance >= 0.5 && collected.relevance < 1.0) {
      // 已经有摘要，检查是否需要升级为完整内容
      const fullText = formatModule(collected.module)
      const summaryText = `${collected.module.name}: ${collected.module.description}`
      const extraTokens = estimateTokens(fullText) - estimateTokens(summaryText)

      if (usedTokens + extraTokens <= tokenBudget) {
        usedTokens += extraTokens
        explorationPath.push(`[Phase3] 深入模块: ${collected.module.name}`)
      }
    }
  }

  return {
    collectedModules,
    explorationPath,
    tokenEstimate: usedTokens,
  }
}

/**
 * 计算模块与已收集模块的关联度
 */
function computeRelevance(
  candidate: ScanModule,
  collected: Array<{ module: ScanModule; relevance: number }>,
): number {
  let maxRelevance = 0

  for (const { module: collectedMod } of collected) {
    let similarity = 0

    // 名称相似度
    if (
      candidate.name.toLowerCase().includes(collectedMod.name.toLowerCase()) ||
      collectedMod.name.toLowerCase().includes(candidate.name.toLowerCase())
    ) {
      similarity += 0.3
    }

    // 描述交叉
    const candidateWords = new Set(candidate.description.toLowerCase().split(/\s+/))
    const collectedWords = new Set(collectedMod.description.toLowerCase().split(/\s+/))
    const intersection = new Set([...candidateWords].filter((w) => collectedWords.has(w) && w.length > 2))
    similarity += (intersection.size / Math.max(candidateWords.size, 1)) * 0.4

    // 功能点交叉
    const candidateFeatures = candidate.processes.flatMap((p) => p.features.map((f) => f.name.toLowerCase()))
    const collectedFeatures = collectedMod.processes.flatMap((p) => p.features.map((f) => f.name.toLowerCase()))
    const featureOverlap = candidateFeatures.filter((f) =>
      collectedFeatures.some((cf) => cf.includes(f) || f.includes(cf)),
    )
    similarity += (featureOverlap.length / Math.max(candidateFeatures.length, 1)) * 0.3

    maxRelevance = Math.max(maxRelevance, similarity)
  }

  return maxRelevance
}

function formatModule(mod: ScanModule): string {
  const lines = [`模块：${mod.name}`, `描述：${mod.description}`]
  for (const proc of mod.processes) {
    lines.push(`\n  流程：${proc.name} - ${proc.description}`)
    for (const feat of proc.features) {
      lines.push(`    - ${feat.name}: ${feat.description}`)
    }
  }
  return lines.join('\n')
}
