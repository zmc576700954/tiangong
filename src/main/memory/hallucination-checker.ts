/**
 * 反幻觉验证器 —— 检测 Agent 输出中的事实错误和幻觉
 *
 * 在 Agent 会话结束后对输出进行验证，检测：
 *   1. 文件路径幻觉：引用了不存在的文件
 *   2. 功能实现幻觉：声称完成但无实际文件变更
 *   3. 测试结果幻觉：声称测试通过但无可验证的测试输出
 *   4. 内部矛盾：输出中的自相矛盾陈述
 *   5. 过度自信：高置信度但缺乏证据支持的断言
 *
 * 验证策略（纯启发式，无 LLM 调用）：
 *   - 文件路径验证：通过 fs.access 检查声称修改/读取的文件是否存在
 *   - 模式匹配：识别常见的幻觉信号（如"已成功完成"但无具体证据）
 *   - 交叉检查：将输出中的声明与实际 AgentOutput 事件进行对比
 *
 * 输出：
 *   HallucinationReport — 包含可疑声明列表、证据强度、风险等级
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentOutput } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('HallucinationChecker')

// ============================================
// 类型定义
// ============================================

/** 单个可疑声明 */
export interface SuspiciousClaim {
  /** 声明文本 */
  claim: string
  /** 幻觉类型 */
  type: 'file_not_found' | 'unsupported_claim' | 'internal_contradiction' | 'overconfident' | 'fake_success'
  /** 风险等级 */
  severity: 'low' | 'medium' | 'high' | 'critical'
  /** 证据（为什么可疑） */
  evidence: string
  /** 在原始输出中的位置（字符偏移） */
  offset: number
}

/** 反幻觉验证报告 */
export interface HallucinationReport {
  /** 是否通过验证（无 critical/high 严重问题） */
  passed: boolean
  /** 可疑声明列表 */
  claims: SuspiciousClaim[]
  /** 综合风险评分 0-100 */
  riskScore: number
  /** 输出总行数 */
  totalLines: number
  /** 输出中的总声明数量 */
  totalClaims: number
  /** 摘要 */
  summary: string
}

/** HallucinationChecker 配置 */
export interface HallucinationCheckerConfig {
  /** 项目工作目录（用于文件路径验证） */
  workingDirectory?: string
  /** 是否启用文件系统验证 */
  enableFileSystemCheck: boolean
  /** 最大检查的文件数量（避免过多 I/O） */
  maxFileChecks: number
  /** 风险评分阈值：超过此值标记为不通过 */
  riskThreshold: number
}

const DEFAULT_CONFIG: HallucinationCheckerConfig = {
  enableFileSystemCheck: true,
  maxFileChecks: 30,
  riskThreshold: 50,
}

// ============================================
// HallucinationChecker 主类
// ============================================

export class HallucinationChecker {
  private config: HallucinationCheckerConfig

  constructor(config?: Partial<HallucinationCheckerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 验证 Agent 输出流，生成反幻觉报告
   *
   * @param outputs - Agent 输出流
   * @param workingDirectory - 项目工作目录（用于文件系统验证）
   */
  async verify(
    outputs: AgentOutput[],
    workingDirectory?: string,
  ): Promise<HallucinationReport> {
    const claims: SuspiciousClaim[] = []
    const wd = workingDirectory ?? this.config.workingDirectory

    // 合并所有文本
    const fullText = outputs
      .filter((o) => o.type === 'stdout' || o.type === 'complete')
      .map((o) => o.data)
      .join('\n')

    const lines = fullText.split('\n')
    const allClaims = this._extractClaims(fullText)

    // 1. 检查文件路径幻觉
    if (this.config.enableFileSystemCheck && wd) {
      const fileClaims = await this._checkFileClaims(fullText, lines, wd)
      claims.push(...fileClaims)
    }

    // 2. 检查功能实现幻觉（声称完成但无文件变更）
    const fakeCompletions = this._checkFakeCompletions(fullText, outputs, lines)
    claims.push(...fakeCompletions)

    // 3. 检查测试结果幻觉
    const fakeTestResults = this._checkFakeTestResults(fullText, lines)
    claims.push(...fakeTestResults)

    // 4. 检查内部矛盾
    const contradictions = this._checkContradictions(fullText, lines)
    claims.push(...contradictions)

    // 5. 检查过度自信声明
    const overconfident = this._checkOverconfident(fullText, lines, outputs)
    claims.push(...overconfident)

    // 计算风险评分
    const riskScore = this._calculateRiskScore(claims, allClaims.length)

    const passed = riskScore <= this.config.riskThreshold

    if (claims.length > 0) {
      logger.warn(`Hallucination check found ${claims.length} suspicious claims, risk=${riskScore}`)
    }

    return {
      passed,
      claims,
      riskScore,
      totalLines: lines.length,
      totalClaims: allClaims.length,
      summary: this._generateSummary(claims, riskScore, passed),
    }
  }

  /**
   * 便捷方法：同步验证（不执行文件系统检查）
   */
  verifySync(outputs: AgentOutput[]): HallucinationReport {
    const claims: SuspiciousClaim[] = []

    const fullText = outputs
      .filter((o) => o.type === 'stdout' || o.type === 'complete')
      .map((o) => o.data)
      .join('\n')

    const lines = fullText.split('\n')
    const allClaims = this._extractClaims(fullText)

    // 仅执行不依赖文件系统的检查
    const fakeCompletions = this._checkFakeCompletions(fullText, outputs, lines)
    claims.push(...fakeCompletions)

    const fakeTestResults = this._checkFakeTestResults(fullText, lines)
    claims.push(...fakeTestResults)

    const contradictions = this._checkContradictions(fullText, lines)
    claims.push(...contradictions)

    const overconfident = this._checkOverconfident(fullText, lines, outputs)
    claims.push(...overconfident)

    const riskScore = this._calculateRiskScore(claims, allClaims.length)
    const passed = riskScore <= this.config.riskThreshold

    return {
      passed,
      claims,
      riskScore,
      totalLines: lines.length,
      totalClaims: allClaims.length,
      summary: this._generateSummary(claims, riskScore, passed),
    }
  }

  // ============================================
  // 检查方法
  // ============================================

  /**
   * 文件路径幻觉检查：验证声称修改/创建的文件是否确实存在
   */
  private async _checkFileClaims(
    fullText: string,
    _lines: string[],
    workingDirectory: string,
  ): Promise<SuspiciousClaim[]> {
    const claims: SuspiciousClaim[] = []

    // 提取所有文件路径
    const filePatterns = [
      /(?:modif(?:y|ied)|change(?:d)?|edit(?:ed)?|wrote?|creat(?:e|ed)|add(?:ed)?)\s*[:：]\s*([^\s\n]{3,300}\.\w{2,10})/gi,
      /(?:file|文件)\s*[:：]\s*([^\s\n]{3,300}\.\w{2,10})/gi,
      /(?:in|at)\s+([\w./-]{3,300}\.\w{2,10})(?:\s*[:：])?/gi,
    ]

    const filePaths = new Set<string>()
    for (const pattern of filePatterns) {
      let match: RegExpExecArray | null
      pattern.lastIndex = 0
      while ((match = pattern.exec(fullText)) !== null) {
        const fp = match[1].trim()
        if (fp.length > 3 && fp.length < 300) {
          filePaths.add(fp)
        }
      }
    }

    // 限制检查数量
    const toCheck = Array.from(filePaths).slice(0, this.config.maxFileChecks)

    for (const fp of toCheck) {
      try {
        const resolved = path.resolve(workingDirectory, fp)
        // 安全校验：确保路径在 workingDirectory 下
        if (!resolved.startsWith(path.resolve(workingDirectory))) continue

        await fs.access(resolved)
      } catch {
        const offset = fullText.indexOf(fp)
        claims.push({
          claim: fp,
          type: 'file_not_found',
          severity: 'medium',
          evidence: `File referenced in output does not exist: ${fp}`,
          offset: offset >= 0 ? offset : 0,
        })
      }
    }

    return claims
  }

  /**
   * 检查虚假完成声明：声称已完成任务但无实际文件变更
   */
  private _checkFakeCompletions(
    fullText: string,
    outputs: AgentOutput[],
    _lines: string[],
  ): SuspiciousClaim[] {
    const claims: SuspiciousClaim[] = []

    // 检测完成声明
    const completionPatterns = [
      /(?:task|任务)\s+(?:complete|done|finished|完成)/gi,
      /(?:successfully|已成功)\s+(?:implemented|fixed|resolved|created|完成)/gi,
      /(?:all|所有)\s+(?:changes?|修改|tasks?)\s+(?:have been|已经)?\s*(?:applied|made|完成)/gi,
      /✓\s*(?:done|complete|完成|成功)/gi,
    ]

    // 检查是否有实际的文件变更
    const hasFileChanges = outputs.some((o) => o.type === 'file_change' && o.filePath)
    const hasErrors = outputs.some((o) => o.type === 'stderr' && o.data.trim().length > 0)

    for (const pattern of completionPatterns) {
      let match: RegExpExecArray | null
      pattern.lastIndex = 0
      while ((match = pattern.exec(fullText)) !== null) {
        const claim = match[0]
        const offset = match.index

        // 如果声称完成但无文件变更且有错误
        if (!hasFileChanges && hasErrors) {
          claims.push({
            claim,
            type: 'fake_success',
            severity: 'high',
            evidence: 'Agent claims success but outputs contain errors and no file changes',
            offset,
          })
        } else if (!hasFileChanges && !hasErrors) {
          claims.push({
            claim,
            type: 'fake_success',
            severity: 'medium',
            evidence: 'Agent claims completion but no file changes detected',
            offset,
          })
        }
      }
    }

    return claims
  }

  /**
   * 检查虚假测试结果
   */
  private _checkFakeTestResults(
    fullText: string,
    _lines: string[],
  ): SuspiciousClaim[] {
    const claims: SuspiciousClaim[] = []

    // 检测测试通过声明
    const testPassPatterns = [
      /(?:all|所有)\s+(?:tests?|测试)\s+(?:pass|通过|passed)/gi,
      /✓\s*(?:\d+\s+)?(?:tests?|测试)\s+(?:pass|通过)/gi,
      /(?:test|测试)\s+(?:results?|结果)[:：]\s*(?:all\s+)?(?:pass|通过)/gi,
    ]

    for (const pattern of testPassPatterns) {
      let match: RegExpExecArray | null
      pattern.lastIndex = 0
      while ((match = pattern.exec(fullText)) !== null) {
        const claim = match[0]
        const offset = match.index

        // 检查是否有具体的测试数字支持
        const hasTestNumbers = /\d+\s+(?:tests?|测试)\s+(?:pass|通过)/i.test(fullText) ||
          /(?:passed|通过)[:：]\s*\d+/i.test(fullText)

        if (!hasTestNumbers) {
          claims.push({
            claim,
            type: 'unsupported_claim',
            severity: 'low',
            evidence: 'Test pass claim lacks specific test count or results',
            offset,
          })
        }
      }
    }

    return claims
  }

  /**
   * 检查输出中的内部矛盾
   * 例如：先说"修改了 3 个文件"，后续又说"修改了 5 个文件"
   */
  private _checkContradictions(
    fullText: string,
    lines: string[],
  ): SuspiciousClaim[] {
    const claims: SuspiciousClaim[] = []

    // 矛盾模式对
    const contradictionPairs: Array<{ a: RegExp; b: RegExp; label: string }> = [
      {
        a: /(?:modified|changed|edited)\s+(\d+)\s+files?/gi,
        b: /(?:modified|changed|edited)\s+(\d+)\s+files?/gi,
        label: 'Conflicting file count',
      },
      {
        a: /(?:error|错误)(?:s)?\s+(?:found|发现)[:：]?\s*(?:no|none|0|无)/gi,
        b: /(?:error|错误)(?:s)?\s+(?:found|发现)[:：]?\s*\d+/gi,
        label: 'Conflicting error reports',
      },
      {
        a: /(?:success|成功|pass|通过)/gi,
        b: /(?:fail|失败|error|错误)/gi,
        label: 'Mixed success/failure signals',
      },
    ]

    for (const pair of contradictionPairs) {
      pair.a.lastIndex = 0
      pair.b.lastIndex = 0

      const matchesA: Array<{ text: string; count: number; offset: number }> = []
      const matchesB: Array<{ text: string; count: number; offset: number }> = []

      let m: RegExpExecArray | null
      while ((m = pair.a.exec(fullText)) !== null) {
        matchesA.push({ text: m[0], count: m[1] ? parseInt(m[1], 10) : -1, offset: m.index })
      }
      while ((m = pair.b.exec(fullText)) !== null) {
        matchesB.push({ text: m[0], count: m[1] ? parseInt(m[1], 10) : -1, offset: m.index })
      }

      // 检查同一类型的矛盾声明是否有不同的数字
      if (pair.label === 'Conflicting file count' && matchesA.length >= 2) {
        const counts = matchesA.map((m) => m.count).filter((c) => c >= 0)
        const unique = new Set(counts)
        if (unique.size >= 2) {
          claims.push({
            claim: `File count inconsistency: ${Array.from(unique).join(' vs ')}`,
            type: 'internal_contradiction',
            severity: 'medium',
            evidence: `Agent reports conflicting file modification counts at lines: ${matchesA.map((m) => lines.findIndex((l) => l.includes(m.text)) + 1).join(', ')}`,
            offset: matchesA[0].offset,
          })
        }
      }
    }

    return claims
  }

  /**
   * 检查过度自信的声明
   * Agent 使用绝对化语言但缺乏证据支持
   */
  private _checkOverconfident(
    fullText: string,
    _lines: string[],
    outputs: AgentOutput[],
  ): SuspiciousClaim[] {
    const claims: SuspiciousClaim[] = []

    const overconfidentPatterns = [
      /(?:definitely|absolutely|certainly|无疑|绝对|肯定)/gi,
      /(?:no doubt|without question|毫无疑问)/gi,
      /(?:guaranteed|guarantee|保证)/gi,
      /(?:perfectly|完美)/gi,
    ]

    // 检查是否有足够的输出内容支持过度自信的声明
    const totalOutputLength = fullText.length
    const hasSubstantialContent = totalOutputLength > 1000
    const hasFileChanges = outputs.some((o) => o.type === 'file_change' && o.filePath)

    for (const pattern of overconfidentPatterns) {
      let match: RegExpExecArray | null
      pattern.lastIndex = 0
      while ((match = pattern.exec(fullText)) !== null) {
        const claim = match[0]
        const offset = match.index

        // 如果输出内容不足（< 1000 字符）但使用绝对化语言
        if (!hasSubstantialContent) {
          claims.push({
            claim,
            type: 'overconfident',
            severity: 'low',
            evidence: 'Absolute language used with limited output context',
            offset,
          })
        }
        // 如果无文件变更但使用绝对化语言声称修改
        if (!hasFileChanges) {
          const context = fullText.substring(Math.max(0, offset - 50), offset + 100)
          if (/modif|change|fix|implement|creat/i.test(context)) {
            claims.push({
              claim,
              type: 'overconfident',
              severity: 'medium',
              evidence: 'Overconfident claim about changes but no file modifications detected',
              offset,
            })
          }
        }
      }
    }

    return claims
  }

  // ============================================
  // 辅助方法
  // ============================================

  /**
   * 提取输出中的所有声明语句
   */
  private _extractClaims(text: string): string[] {
    const claims: string[] = []

    // 声明模式：以动词开头的完成性陈述
    const claimPatterns = [
      /(?:Modified|Changed|Added|Deleted|Created|Updated|Fixed|Implemented|Resolved)\s+.+?(?:\.|$)/gm,
      /(?:修改|更改|添加|删除|创建|更新|修复|实现|解决)了?.+?(?:[。.]|$)/gm,
      /(?:Tests?|测试)\s+(?:pass|通过|fail|失败).+?(?:\.|$)/gm,
      /(?:All|所有)\s+.+?(?:pass|通过|complete|完成|done).+?(?:\.|$)/gm,
    ]

    for (const pattern of claimPatterns) {
      let match: RegExpExecArray | null
      pattern.lastIndex = 0
      while ((match = pattern.exec(text)) !== null) {
        const claim = match[0].trim()
        if (claim.length > 10 && claim.length < 500) {
          claims.push(claim)
        }
      }
    }

    return claims
  }

  /**
   * 计算综合风险评分 0-100
   */
  private _calculateRiskScore(claims: SuspiciousClaim[], totalClaims: number): number {
    if (claims.length === 0) return 0

    let score = 0

    for (const claim of claims) {
      switch (claim.severity) {
        case 'critical': score += 30; break
        case 'high': score += 20; break
        case 'medium': score += 10; break
        case 'low': score += 5; break
      }
    }

    // 考虑声明密度：可疑声明占总声明的比例
    const density = totalClaims > 0 ? claims.length / totalClaims : 1
    score = Math.round(score * (0.5 + density * 0.5))

    return Math.min(100, score)
  }

  /**
   * 生成人类可读的摘要
   */
  private _generateSummary(claims: SuspiciousClaim[], riskScore: number, passed: boolean): string {
    if (claims.length === 0) {
      return 'No suspicious claims detected. Output appears consistent.'
    }

    const bySeverity = {
      critical: claims.filter((c) => c.severity === 'critical').length,
      high: claims.filter((c) => c.severity === 'high').length,
      medium: claims.filter((c) => c.severity === 'medium').length,
      low: claims.filter((c) => c.severity === 'low').length,
    }

    const byType = new Map<string, number>()
    for (const c of claims) {
      byType.set(c.type, (byType.get(c.type) ?? 0) + 1)
    }

    const parts: string[] = []
    parts.push(`Risk Score: ${riskScore}/100 (${passed ? 'PASS' : 'FAIL'})`)
    parts.push(`Found ${claims.length} suspicious claims:`)

    if (bySeverity.critical > 0) parts.push(`  ${bySeverity.critical} critical`)
    if (bySeverity.high > 0) parts.push(`  ${bySeverity.high} high`)
    if (bySeverity.medium > 0) parts.push(`  ${bySeverity.medium} medium`)
    if (bySeverity.low > 0) parts.push(`  ${bySeverity.low} low`)

    parts.push('\nBy type:')
    for (const [type, count] of byType) {
      parts.push(`  ${type}: ${count}`)
    }

    return parts.join('\n')
  }
}
