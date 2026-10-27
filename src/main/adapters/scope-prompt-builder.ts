/**
 * 范围约束提示词构建器
 * 从 BaseAdapter 中提取，降低单文件复杂度
 *
 * 将 AgentSessionConfig 转换为自然语言约束说明，
 * 注入到 Agent prompt 中限制文件修改范围。
 */

import type { AgentSessionConfig, ResolvedContext } from '@shared/types'
import { estimateTokens } from '../shared/token-utils'

const MAX_USER_INPUT_LENGTH = 500

/**
 * scope 段标题的唯一字面量来源。
 *
 * 生产者（buildScopePrompt）与消费者（PromptOrchestrator 的压缩分级）必须共用这份常量——
 * 历史上生产者输出中文标题、消费者按英文标题匹配，导致所有段落都落进 'other'，
 * 分级压缩形同虚设，只剩硬截断。
 */
export const SCOPE_SECTION_HEADINGS = {
  acceptance: '## 验收标准',
  allowedFiles: '## 允许修改的文件（白名单）',
  forbiddenFiles: '## 禁止修改的文件（黑名单）',
  invariants: '## 业务不变量',
  upstream: '## 上游契约',
  downstream: '## 下游契约',
  bugs: '## 待修复 Bug',
  additionalContexts: '## 附加上下文',
  projectMemory: '## 项目记忆',
} as const

/** 基本的用户输入清理：截断长度 + 移除常见的 prompt injection 模式 */
function sanitizeUserInput(input: string): string {
  let sanitized = input.slice(0, MAX_USER_INPUT_LENGTH)
  // 移除常见的 prompt injection 指令
  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|rules|constraints)/gi,
    /you\s+are\s+now\s+(?:a|an)\s+/gi,
    /disregard\s+(?:all\s+)?(?:previous|above)\s+/gi,
    /forget\s+(?:all\s+)?(?:previous|above)\s+/gi,
    /new\s+instructions?\s*:/gi,
    /system\s*:\s*/gi,
    /<\/?(?:system|assistant|user)>/gi,
  ]
  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '[filtered]')
  }
  return sanitized
}

/**
 * 构建范围约束提示词
 * @param config - 会话配置
 * @param resolvedContexts - 已解析的上下文列表
 */
export function buildScopePrompt(
  config: AgentSessionConfig,
  resolvedContexts?: ResolvedContext[],
): string {
  const lines: string[] = []

  lines.push(`# 业务节点：<node-title>${sanitizeUserInput(config.nodeTitle)}</node-title>`)
  lines.push('')

  if (config.acceptanceCriteria.length > 0) {
    lines.push(SCOPE_SECTION_HEADINGS.acceptance)
    for (const criteria of config.acceptanceCriteria) {
      lines.push(`- <criteria>${sanitizeUserInput(criteria)}</criteria>`)
    }
    lines.push('')
  }

  const isValidFilePath = (p: string) => p.length > 0 && p.length < 500 && !p.includes('\n') && !p.includes('\0')
  const safeAllowed = config.allowedFiles.filter(isValidFilePath)
  const safeForbidden = config.forbiddenFiles.filter(isValidFilePath)

  if (safeAllowed.length > 0) {
    lines.push(SCOPE_SECTION_HEADINGS.allowedFiles)
    for (const file of safeAllowed) {
      lines.push(`- ${file}`)
    }
    lines.push('')
  }

  if (safeForbidden.length > 0) {
    lines.push(SCOPE_SECTION_HEADINGS.forbiddenFiles)
    for (const file of safeForbidden) {
      lines.push(`- ${file}`)
    }
    lines.push('')
  }

  if (config.invariantRules.length > 0) {
    lines.push(SCOPE_SECTION_HEADINGS.invariants)
    for (const rule of config.invariantRules) {
      lines.push(`- <invariant>${sanitizeUserInput(rule)}</invariant>`)
    }
    lines.push('')
  }

  if (config.upstreamContext) {
    lines.push(SCOPE_SECTION_HEADINGS.upstream)
    lines.push(config.upstreamContext)
    lines.push('')
  }

  if (config.downstreamContext) {
    lines.push(SCOPE_SECTION_HEADINGS.downstream)
    lines.push(config.downstreamContext)
    lines.push('')
  }

  if (config.bugContext && config.bugContext.length > 0) {
    lines.push(SCOPE_SECTION_HEADINGS.bugs)
    for (const bug of config.bugContext) {
      lines.push(`### ${sanitizeUserInput(bug.title)} [${bug.severity}]`)
      lines.push(bug.description)
      lines.push('')
    }
  }

  // 注入已解析的上下文
  if (resolvedContexts && resolvedContexts.length > 0) {
    lines.push(SCOPE_SECTION_HEADINGS.additionalContexts)
    for (const ctx of resolvedContexts) {
      lines.push(`### ${ctx.label} (${ctx.type})`)
      lines.push(ctx.content)
      lines.push('')
    }
  }

  return lines.join('\n')
}

/**
 * 压缩 Scope Prompt 至指定 Token 预算内
 * 三级策略：
 *   1. 去多余空行
 *   2. 截断各 section 内容（保留标题 + 前3行）
 *   3. 硬截断 + 省略号
 */
export function compressScopePrompt(
  prompt: string,
  maxTokens: number,
): string {
  const currentTokens = estimateTokens(prompt)
  if (currentTokens <= maxTokens) return prompt

  // 策略1：去除多余空行
  let compressed = prompt.replace(/\n{3,}/g, '\n\n')
  if (estimateTokens(compressed) <= maxTokens) return compressed

  // 策略2：截断各 section 内容（保留标题 + 前3行正文）
  const sections = compressed.split(/^(?=## )/m)
  const header = sections[0]
  const bodySections = sections.slice(1)

  const trimmedSections = bodySections.map(section => {
    const lines = section.split('\n')
    const title = lines[0]
    const body = lines.slice(1).join('\n')
    // 保留标题 + 前3行正文
    const trimmedBody = body.split('\n').slice(0, 3).join('\n')
    const suffix = body.split('\n').length > 3 ? '\n  [...truncated]' : ''
    return `${title}\n${trimmedBody}${suffix}`
  })

  compressed = header + '\n' + trimmedSections.join('\n')
  if (estimateTokens(compressed) <= maxTokens) return compressed

  // 策略3：硬截断 + 省略号
  const ratio = maxTokens / currentTokens
  const charBudget = Math.floor(compressed.length * ratio * 0.9)
  return compressed.slice(0, charBudget) + '\n\n[...prompt compressed...]'
}
