/**
 * Gate 3: 最终 Prompt 检查
 *
 * 验证生成的 Prompt 包含必要元素：
 * ✅ 至少一个业务规则或验收标准
 * ✅ 明确的范围约束（文件列表）
 * ✅ 任务描述与节点内容一致
 * ❌ 无噪音信息
 */

export interface FinalCheckResult {
  passed: boolean
  score: number // 0-1
  issues: string[]
  suggestions: string[]
}

/**
 * 最终检查：验证 Prompt 完整性
 */
export function finalCheck(
  prompt: string,
  nodeTitle: string,
  taskType: 'feature' | 'bugfix' | 'refactor',
): FinalCheckResult {
  const issues: string[] = []
  const suggestions: string[] = []
  let score = 1.0

  // 检查 1: 包含业务规则或验收标准
  const hasRules = /(?:业务规则|BusinessRule|条件|condition|触发)/.test(prompt)
  const hasCriteria = /(?:验收标准|acceptance|验收条件|完成标准)/.test(prompt)
  if (!hasRules && !hasCriteria) {
    issues.push('缺少业务规则或验收标准')
    suggestions.push('请为节点补充业务规则或验收标准')
    score -= 0.3
  }

  // 检查 2: 包含范围约束
  const hasScope = /(?:范围约束|允许修改|相关文件|relatedFiles|src\/)/.test(prompt)
  if (!hasScope) {
    issues.push('缺少明确的文件范围约束')
    suggestions.push('请指定允许修改的文件列表')
    score -= 0.3
  }

  // 检查 3: 包含任务描述
  const taskKeywords = {
    feature: ['实现', '功能', '开发', 'implement', 'feature'],
    bugfix: ['修复', 'bug', '问题', 'fix', 'error'],
    refactor: ['重构', '优化', 'refactor', 'improve'],
  }
  const keywords = taskKeywords[taskType] || taskKeywords.feature
  const hasTask = keywords.some((k) => prompt.toLowerCase().includes(k.toLowerCase()))
  if (!hasTask) {
    issues.push('缺少明确的任务描述')
    score -= 0.2
  }

  // 检查 4: 无噪音
  const noisePatterns = [
    /npm run \w+/g,
    /node_modules/g,
    /eslint.*config/g,
    /prettier.*config/g,
  ]
  const noiseCount = noisePatterns.reduce(
    (count, p) => count + (prompt.match(p)?.length || 0),
    0,
  )
  if (noiseCount > 0) {
    issues.push(`包含 ${noiseCount} 处噪音信息`)
    score -= 0.1 * noiseCount
  }

  // 检查 5: 节点标题在 prompt 中出现
  if (!prompt.includes(nodeTitle)) {
    issues.push(`节点标题"${nodeTitle}"未在 Prompt 中出现`)
    score -= 0.1
  }

  return {
    passed: score >= 0.5,
    score: Math.max(0, score),
    issues,
    suggestions,
  }
}
