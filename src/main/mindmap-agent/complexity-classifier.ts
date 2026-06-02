/**
 * 查询复杂度分类器（Adaptive-RAG 模式）
 *
 * 在任何操作前，先分类复杂度决定检索策略。
 * 研究依据：Adaptive-RAG 分类器路由比固定策略更准确更高效 [Jeong et al., 2024]
 */

export type QueryComplexity = 'simple' | 'moderate' | 'complex' | 'global'

export interface ClassificationResult {
  complexity: QueryComplexity
  reason: string
  matchedDomains: string[]
  strategy: 'direct' | 'local' | 'drift' | 'global'
}

/**
 * 基于关键词和结构的复杂度分类（无需 LLM 调用，快速分类）
 */
export function classifyComplexity(
  query: string,
  availableDomains: string[],
): ClassificationResult {
  const lower = query.toLowerCase()

  // 全局：初始化 / 全项目扫描
  const globalPatterns = [
    /初始化.*(?:项目|思维导图|图谱)/,
    /生成.*(?:项目|整体|全部).*思维导图/,
    /扫描.*(?:项目|整体)/,
    /regenerate|generate.*full/i,
    /重新生成.*导图/,
  ]
  if (globalPatterns.some((p) => p.test(lower))) {
    return {
      complexity: 'global',
      reason: '全项目级别操作',
      matchedDomains: [],
      strategy: 'global',
    }
  }

  // 简单：单节点操作
  const simplePatterns = [
    /(?:查看|显示|读取).*单个.*(?:节点|功能|模块)/,
    /(?:enrich|补充|深化).*节点/,
    /(?:单个|单个).*详情/,
  ]
  if (simplePatterns.some((p) => p.test(lower))) {
    return {
      complexity: 'simple',
      reason: '单节点直查操作',
      matchedDomains: [],
      strategy: 'direct',
    }
  }

  // 尝试匹配已知业务域
  const matchedDomains = availableDomains.filter((d) =>
    lower.includes(d.toLowerCase()),
  )

  // 复杂：跨模块 / 模糊需求
  const complexIndicators = [
    matchedDomains.length >= 2, // 涉及多个域
    /(?:联动|关联|依赖|交互|跨)/.test(lower),
    /(?:优化|重构|改造|升级)/.test(lower) && !/单个|单模块/.test(lower),
    /(?:性能|安全|架构)/.test(lower),
    matchedDomains.length === 0 && lower.length > 10, // 模糊长需求
  ]

  if (complexIndicators.filter(Boolean).length >= 1) {
    return {
      complexity: 'complex',
      reason: matchedDomains.length >= 2
        ? `跨模块操作，涉及：${matchedDomains.join(', ')}`
        : '需求模糊或涉及全局',
      matchedDomains,
      strategy: 'drift',
    }
  }

  // 中等：单模块操作
  if (matchedDomains.length === 1) {
    return {
      complexity: 'moderate',
      reason: `单模块操作：${matchedDomains[0]}`,
      matchedDomains,
      strategy: 'local',
    }
  }

  // 默认中等
  return {
    complexity: 'moderate',
    reason: '默认分类',
    matchedDomains,
    strategy: 'local',
  }
}
