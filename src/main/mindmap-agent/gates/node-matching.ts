/**
 * Gate 1: 节点匹配验证（CRAG 模式）
 *
 * 对检索结果做置信度评分：
 * - 高置信度（>0.8）→ 直接通过
 * - 低置信度（<0.5）→ 触发查询重写
 * - 模糊（0.5-0.8）→ 请求用户确认
 */

export type MatchConfidence = 'high' | 'low' | 'ambiguous'

export interface MatchResult {
  confidence: MatchConfidence
  score: number
  /** 建议的查询重写（低置信度时） */
  rewrittenQuery?: string
  /** 需要用户确认的候选（模糊时） */
  candidates?: string[]
}

/**
 * 评估节点匹配置信度
 */
export function evaluateMatch(
  query: string,
  matchedDomains: string[],
  availableDomains: string[],
): MatchResult {
  if (matchedDomains.length === 0) {
    return {
      confidence: 'low',
      score: 0.1,
      rewrittenQuery: suggestRewrite(query, availableDomains),
    }
  }

  // 计算匹配质量
  const queryLower = query.toLowerCase()
  let totalScore = 0

  for (const domain of matchedDomains) {
    const domainLower = domain.toLowerCase()

    // 精确匹配
    if (queryLower.includes(domainLower)) {
      totalScore += 1.0
    }
    // 部分匹配
    else if (
      domainLower.split('').some((c) => queryLower.includes(c)) &&
      domainLower.length > 2
    ) {
      totalScore += 0.5
    }
  }

  const avgScore = totalScore / matchedDomains.length

  // 检查是否有噪音匹配
  const noisePatterns = ['npm', 'run', 'build', 'test', 'lint', 'start', 'dev']
  const hasNoise = matchedDomains.some((d) =>
    noisePatterns.some((n) => d.toLowerCase() === n),
  )
  if (hasNoise) {
    return {
      confidence: 'low',
      score: 0.3,
      rewrittenQuery: suggestRewrite(query, availableDomains),
    }
  }

  if (avgScore >= 0.8) {
    return { confidence: 'high', score: avgScore }
  }

  if (avgScore >= 0.5) {
    return {
      confidence: 'ambiguous',
      score: avgScore,
      candidates: matchedDomains,
    }
  }

  return {
    confidence: 'low',
    score: avgScore,
    rewrittenQuery: suggestRewrite(query, availableDomains),
  }
}

/**
 * 查询重写建议
 */
function suggestRewrite(query: string, availableDomains: string[]): string {
  if (availableDomains.length === 0) {
    return `${query}（请提供更具体的业务域名称）`
  }
  return `${query}（可选业务域：${availableDomains.join('、')}）`
}
