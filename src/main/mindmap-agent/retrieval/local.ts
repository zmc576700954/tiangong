/**
 * Local Retrieval — 单模块扇出检索
 *
 * 从目标节点出发，沿关系边扇出到邻居节点，加载摘要。
 * Token 预算 8K。按 strength 排序截断。
 */

import type { ScanModule, CommunitySummary } from '@shared/types'

export interface LocalRetrievalResult {
  /** 目标模块的完整内容 */
  targetModule: ScanModule
  /** 邻居模块摘要 */
  neighborSummaries: Array<{ title: string; summary: string }>
  /** 社区摘要 */
  communitySummary?: string
  tokenEstimate: number
}

import { estimateTokens } from '../../../shared/token-utils'

/**
 * 单模块检索：加载目标模块完整内容 + 邻居摘要
 */
export function localRetrieve(
  targetModuleName: string,
  allModules: ScanModule[],
  communitySummaries: CommunitySummary[] = [],
): LocalRetrievalResult | null {
  const TOKEN_BUDGET = 8000
  let usedTokens = 0

  // 1. 找到目标模块
  const targetModule = allModules.find((m) => m.name === targetModuleName)
  if (!targetModule) return null

  // 2. 加载完整模块内容
  const moduleText = formatModule(targetModule)
  usedTokens += estimateTokens(moduleText)

  // 3. 加载模块级社区摘要
  const moduleSummary = communitySummaries.find(
    (s) => s.level === 1 && s.title.includes(targetModuleName),
  )

  // 4. 扇出到邻居模块（按边强度排序，这里简化为按名称相关度）
  const neighborSummaries: Array<{ title: string; summary: string }> = []
  const otherModules = allModules.filter((m) => m.name !== targetModuleName)

  for (const neighbor of otherModules) {
    if (usedTokens >= TOKEN_BUDGET) break

    // 邻居只加载摘要
    const neighborSummary = communitySummaries.find(
      (s) => s.level === 1 && s.title.includes(neighbor.name),
    )
    const summary = neighborSummary?.summary || `${neighbor.name}: ${neighbor.description}`
    const tokens = estimateTokens(summary)

    if (usedTokens + tokens <= TOKEN_BUDGET) {
      neighborSummaries.push({ title: neighbor.name, summary })
      usedTokens += tokens
    }
  }

  return {
    targetModule,
    neighborSummaries,
    communitySummary: moduleSummary?.summary,
    tokenEstimate: usedTokens,
  }
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
