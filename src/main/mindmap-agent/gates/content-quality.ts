/**
 * Gate 2: 内容质量验证（Self-RAG 模式）
 *
 * 对检索到的内容做三项评估：
 * - IsRel：内容是否与用户需求相关？
 * - IsSup：内容是否支撑后续代码生成？
 * - IsUse：内容是否提供了新的有用信息？
 *
 * 研究依据：自我纠正是主要改进来源 [CRAG ablation, Yan 2024]
 */

export interface ContentQualityScore {
  isRelevant: boolean
  isSupportive: boolean
  isUseful: boolean
  overallScore: number // 0-1
  filteredContent: string[]
  rejectedItems: Array<{ content: string; reason: string }>
}

/**
 * 评估检索内容质量
 */
export function evaluateContentQuality(
  query: string,
  retrievedItems: Array<{ title: string; content: string }>,
): ContentQualityScore {
  const queryTerms = extractTerms(query)
  const filtered: string[] = []
  const rejected: Array<{ content: string; reason: string }> = []

  let totalRelevance = 0
  let totalSupport = 0
  let totalUse = 0

  for (const item of retrievedItems) {
    const itemTerms = extractTerms(item.title + ' ' + item.content)

    // IsRel: 关键词重叠度
    const overlap = queryTerms.filter((t) => itemTerms.some((it) => it.includes(t) || t.includes(it)))
    const relevance = overlap.length / Math.max(queryTerms.length, 1)

    // IsSup: 是否包含可执行信息（代码签名、文件路径、API 等）
    const hasCode = /(?:function|class|interface|def |import |from |export )/.test(item.content)
    const hasPath = /(?:src\/|app\/|lib\/|\.ts|\.js|\.py|\.go)/.test(item.content)
    const hasApi = /(?:GET|POST|PUT|DELETE|fetch|axios|request)/.test(item.content)
    const support = (hasCode ? 0.4 : 0) + (hasPath ? 0.3 : 0) + (hasApi ? 0.3 : 0)

    // IsUse: 内容是否非空且非噪音
    const isNoise = /npm run|node_modules|eslint|prettier/i.test(item.content)
    const isUseful = !isNoise && item.content.length > 50

    totalRelevance += relevance
    totalSupport += support
    totalUse += isUseful ? 1 : 0

    if (relevance >= 0.3 && !isNoise) {
      filtered.push(item.content)
    } else {
      rejected.push({
        content: item.title,
        reason: isNoise ? '噪音内容' : relevance < 0.3 ? '与需求不相关' : '内容不足',
      })
    }
  }

  const count = Math.max(retrievedItems.length, 1)
  const overallScore = (totalRelevance / count + totalSupport / count + totalUse / count) / 3

  return {
    isRelevant: totalRelevance / count >= 0.3,
    isSupportive: totalSupport / count >= 0.2,
    isUseful: totalUse / count >= 0.5,
    overallScore,
    filteredContent: filtered,
    rejectedItems: rejected,
  }
}

/**
 * 提取关键词
 */
function extractTerms(text: string): string[] {
  // 分词：中文按字/词，英文按空格
  const words = text
    .toLowerCase()
    .split(/[\s,，.。;；:：（）()\-_/\\]+/)
    .filter((w) => w.length > 1)

  return [...new Set(words)]
}
