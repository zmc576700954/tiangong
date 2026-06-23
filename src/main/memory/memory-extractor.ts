/**
 * 记忆提取器
 *
 * 从 Agent 输出流和执行结果中提取结构化记忆
 * 借鉴 claude-mem 的 Observer 压缩思路，但简化为「执行后一次性提取」，
 * 不需要长生命周期的 Observer Agent
 *
 * 提取策略:
 *   - 调查结果 → investigation 记忆（根因 + 逻辑链）
 *   - 修复结果 → fix 记忆（修改文件 + 变更摘要）
 *   - 审查发现 → review_finding 记忆（high/critical 单独记录）
 *   - 关键决策 → decision 记忆（架构/工具选型）
 *   - 经验教训 → lesson 记忆（避免重复踩坑）
 */

import type { AgentOutput, MemoryItem, MemoryKind, OutputHealth, AgentCommandType } from '@shared/types'
import { createLogger } from '../shared/logger'
import { estimateTokens } from '../shared/token-utils'

const logger = createLogger('MemoryExtractor')

export class MemoryExtractor {
  /**
   * 从 AgentOutput 流中提取记忆
   * 启发式规则提取，无需额外 LLM 调用
   *
   * @param sessionId - 会话 ID
   * @param outputs - Agent 输出流
   * @param context - 提取上下文（含指令类型，用于语义区分）
   */
  extract(
    sessionId: string,
    outputs: AgentOutput[],
    context: {
      projectId?: string
      nodeId?: string
      adapterName: string
      commandDescription?: string
      /** AgentCommand.type，用于语义区分提取策略 */
      commandType?: AgentCommandType
    },
  ): Omit<MemoryItem, 'id'>[] {
    // Check output health
    const health = this.classifyOutput(outputs)
    if (health === 'poisoned') {
      logger.warn(`Session ${sessionId} output is poisoned, skipping extraction`)
      return []
    }
    if (health === 'empty') {
      return []
    }

    const items: Omit<MemoryItem, 'id'>[] = []
    const now = new Date().toISOString()

    // 合并所有文本输出
    const fullText = outputs
      .filter((o) => o.type === 'stdout' || o.type === 'complete')
      .map((o) => o.data)
      .join('\n')

    if (fullText.length < 20) return items // 无实质内容

    const cmdType = context.commandType
    const cmdLabel = context.commandDescription ?? 'Agent session'

    // 1. 提取文件变更记录（语义区分：refactor → pattern，fix_bug → fix）
    const fileChanges = this._extractFileChanges(outputs)
    if (fileChanges.length > 0) {
      const isRefactor = cmdType === 'refactor'
      items.push({
        session_id: sessionId,
        kind: (isRefactor ? 'pattern' : 'fix') as MemoryKind,
        project_id: context.projectId ?? '',
        node_id: context.nodeId ?? null,
        title: `Modified ${fileChanges.length} file(s): ${fileChanges.slice(0, 3).map((f) => f.path).join(', ')}${fileChanges.length > 3 ? '...' : ''}`,
        narrative: `Task: ${cmdLabel}. Modified files: ${fileChanges.map((f) => `${f.path} (${f.changeType})`).join(', ')}.`,
        facts: [
          `Files modified: ${fileChanges.length}`,
          `Command type: ${cmdType ?? 'unknown'}`,
        ],
        concepts: [isRefactor ? 'how-it-works' : 'fix-applied'],
        files_read: [],
        files_modified: fileChanges.map((f) => f.path),
        adapter_name: context.adapterName,
        token_cost: estimateTokens(fullText),
        confidence: isRefactor ? 0.6 : 0.8,
        created_at: now,
      })
    }

    // 2. 提取错误/修复模式
    const errors = this._extractErrors(fullText)
    if (errors.length > 0) {
      items.push({
        session_id: sessionId,
        kind: 'fix' as MemoryKind,
        project_id: context.projectId ?? '',
        node_id: context.nodeId ?? null,
        title: `Encountered ${errors.length} error(s): ${errors[0].substring(0, 60)}`,
        narrative: errors.map((e, i) => `${i + 1}. ${e}`).join('\n'),
        facts: [`Error count: ${errors.length}`],
        concepts: ['problem-solution'],
        files_read: [],
        files_modified: fileChanges.map((f) => f.path),
        adapter_name: context.adapterName,
        token_cost: estimateTokens(fullText),
        confidence: 0.7,
        created_at: now,
      })
    }

    // 3. 提取测试相关结果（语义区分：add_test → 更高置信度）
    const testResults = this._extractTestResults(fullText)
    if (testResults) {
      items.push({
        session_id: sessionId,
        kind: 'investigation' as MemoryKind,
        project_id: context.projectId ?? '',
        node_id: context.nodeId ?? null,
        title: `Tests: ${testResults.passed}/${testResults.total} passed`,
        narrative: `Test execution: ${testResults.passed} passed, ${testResults.failed} failed, ${testResults.total} total.`,
        facts: [`Passed: ${testResults.passed}`, `Failed: ${testResults.failed}`, `Total: ${testResults.total}`],
        concepts: ['verification'],
        files_read: testResults.files ?? [],
        files_modified: [],
        adapter_name: context.adapterName,
        token_cost: estimateTokens(fullText),
        confidence: cmdType === 'add_test' ? 0.95 : 0.9,
        created_at: now,
      })
    }

    // 4. 提取关键决策/模式
    const patterns = this._extractPatterns(fullText)
    for (const pattern of patterns) {
      items.push({
        session_id: sessionId,
        kind: 'pattern' as MemoryKind,
        project_id: context.projectId ?? '',
        node_id: context.nodeId ?? null,
        title: `Pattern: ${pattern.substring(0, 80)}`,
        narrative: pattern,
        facts: [],
        concepts: ['how-it-works'],
        files_read: [],
        files_modified: [],
        adapter_name: context.adapterName,
        token_cost: estimateTokens(fullText),
        confidence: 0.5,
        created_at: now,
      })
    }

    // 5. 提取关键决策（architecture/tool/library 选型）
    const decisions = this._extractDecisions(fullText)
    for (const decision of decisions) {
      items.push({
        session_id: sessionId,
        kind: 'decision' as MemoryKind,
        project_id: context.projectId ?? '',
        node_id: context.nodeId ?? null,
        title: `Decision: ${decision.substring(0, 80)}`,
        narrative: decision,
        facts: [],
        concepts: ['decision-made'],
        files_read: [],
        files_modified: [],
        adapter_name: context.adapterName,
        token_cost: estimateTokens(fullText),
        confidence: 0.55,
        created_at: now,
      })
    }

    // 6. 提取经验教训（避免重复踩坑）
    const lessons = this._extractLessons(fullText)
    for (const lesson of lessons) {
      items.push({
        session_id: sessionId,
        kind: 'lesson' as MemoryKind,
        project_id: context.projectId ?? '',
        node_id: context.nodeId ?? null,
        title: `Lesson: ${lesson.substring(0, 80)}`,
        narrative: lesson,
        facts: [],
        concepts: ['lesson-learned'],
        files_read: [],
        files_modified: [],
        adapter_name: context.adapterName,
        token_cost: estimateTokens(fullText),
        confidence: 0.45,
        created_at: now,
      })
    }

    // Fix token cost N-fold inflation: when multiple memories are extracted
    // from one session, each claims the full estimateTokens(fullText) cost.
    // Divide by the number of items produced so each shares the cost fairly.
    const itemCount = items.length || 1
    items.forEach(item => { item.token_cost = Math.round(item.token_cost / itemCount) })

    logger.debug(`Extracted ${items.length} memory items from session ${sessionId}`)
    return items
  }

  /**
   * 分类 Agent 输出的健康状态
   * 借鉴 claude-mem 的输出分类器：检测截断、中毒、空白输出
   */
  classifyOutput(outputs: AgentOutput[]): OutputHealth {
    if (outputs.length === 0) return 'empty'

    const fullText = outputs
      .filter((o) => o.type === 'stdout' || o.type === 'complete')
      .map((o) => o.data)
      .join('\n')
      .trim()

    // 空白输出
    if (fullText.length === 0) return 'empty'

    // 截断检测：
    //   - 锚点型（必须出现在文本末尾，如 "...", "[", "("）只检查尾部 200 字符；
    //   - 关键词型（"truncat"/"token limit"/"context length exceeded" 等）需要全文扫描，
    //     因为 Agent 收到"max tokens reached"提示后可能继续 dump 大段输出，
    //     让标志远离 tail。为避免在十几 MB 输出上做无意义的全文 regex，
    //     超过 1 MB 时退化为对首尾各 5000 字符做扫描——这覆盖了绝大多数实际产生场景
    //     （信号一般出现在 Agent 任务启动声明或退出收尾）。
    const tailWindow = fullText.slice(-200)
    const trailingMarkers = [
      /\.\.\.\s*$/,                    // 省略号结尾
      /\[\s*$/,                         // 未闭合的方括号
      /\(\s*$/,                         // 未闭合的圆括号
    ]
    if (trailingMarkers.some((m) => m.test(tailWindow))) {
      return 'truncated'
    }
    const scanText = this._scanWindow(fullText)
    const truncationKeywordMarkers = [
      /(?:truncat|limit|exceed)/i,
      /(?:token|context).*(?:limit|budget|exhausted)/i,
    ]
    if (truncationKeywordMarkers.some((m) => m.test(scanText))) {
      return 'truncated'
    }

    // 中毒检测（上下文耗尽信号）：全文扫描（同样做大小退化）
    const poisonMarkers = [
      /context length exceeded/i,
      /max tokens reached/i,
      /output truncated/i,
      /length limit exceeded/i,
      /too many tokens/i,
    ]
    if (poisonMarkers.some((m) => m.test(scanText))) {
      return 'poisoned'
    }

    return 'valid'
  }

  /**
   * 为大文本截取扫描窗口：小文本直接返回；超过 1 MB 时取首 5000 + 尾 5000 字符拼接，
   * 兼顾性能与"截断/中毒信号通常出现在任务开头声明或收尾"的实际分布。
   */
  private _scanWindow(text: string): string {
    const HEAD_TAIL_THRESHOLD = 1_000_000 // 1 MB
    const HEAD_TAIL_LEN = 5000
    if (text.length <= HEAD_TAIL_THRESHOLD) return text
    return text.slice(0, HEAD_TAIL_LEN) + '\n' + text.slice(-HEAD_TAIL_LEN)
  }

  /**
   * 从 Agent 输出中提取文件变更信息
   */
  private _extractFileChanges(outputs: AgentOutput[]): Array<{ path: string; changeType: string }> {
    const fileChangeOutputs = outputs.filter(
      (o) => o.type === 'file_change' && o.filePath,
    )
    const seen = new Set<string>()
    const changes: Array<{ path: string; changeType: string }> = []

    for (const o of fileChangeOutputs) {
      if (o.filePath && !seen.has(o.filePath)) {
        seen.add(o.filePath)
        changes.push({
          path: o.filePath,
          changeType: o.changeType ?? 'modify',
        })
      }
    }

    // 也从 stdout 文本中匹配文件路径
    for (const o of outputs.filter((o) => o.type === 'stdout')) {
      const text = o.data
      const fileMatches = text.match(/(?:create|modify|delete|add|write|edit)[ed]?\s*[:：]?\s*(\S+\.\w{2,5})/gi)
      if (fileMatches) {
        for (const m of fileMatches) {
          const pathPart = m.replace(/^[a-z]+(?:ed)?\s*[:：]?\s*/i, '').trim()
          if (pathPart.length > 0 && pathPart.length < 300 && !seen.has(pathPart)) {
            seen.add(pathPart)
            changes.push({ path: pathPart, changeType: 'modify' })
          }
        }
      }
    }

    return changes
  }

  /** 错误关键词列表（扩展版：覆盖更多常见错误模式） */
  private static readonly ERROR_KEYWORDS = [
    'error', '失败', 'exception', 'panic', 'fatal', 'crash',
    'timeout', 'refused', 'enoent', 'econnrefused', 'permission denied',
    'stack overflow', 'out of memory', 'segfault', 'abort',
    'undefined is not', 'cannot read', 'typeerror', 'referenceerror',
    'syntaxerror', 'rangeerror',
  ]

  /**
   * 从文本中提取错误信息
   */
  private _extractErrors(text: string): string[] {
    const errors: string[] = []
    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase()
      if (
        MemoryExtractor.ERROR_KEYWORDS.some(kw => lineLower.includes(kw)) &&
        lines[i].trim().length > 15 &&
        lines[i].trim().length < 500
      ) {
        // 取上下文 3 行
        const contextStart = Math.max(0, i - 1)
        const contextEnd = Math.min(lines.length, i + 2)
        const snippet = lines.slice(contextStart, contextEnd).join('\n').trim()
        if (snippet.length > 20 && snippet.length < 600) {
          errors.push(snippet)
        }
      }
    }

    // 去重（基于前 40 字符相似度）
    const unique: string[] = []
    const seenPrefixes = new Set<string>()
    for (const e of errors) {
      const prefix = e.substring(0, 40).toLowerCase()
      if (!seenPrefixes.has(prefix)) {
        seenPrefixes.add(prefix)
        unique.push(e)
      }
    }

    return unique.slice(0, 5) // 最多 5 条错误
  }

  /**
   * 提取测试结果统计
   */
  private _extractTestResults(text: string): {
    passed: number
    failed: number
    total: number
    files: string[]
  } | null {
    // 匹配常见的测试输出格式
    // "Tests: 5 passed, 2 failed, 7 total"
    const testResultMatch = text.match(
      /(?:Tests?|测试)[:：]\s*(\d+)\s*(?:passed|通过).*?(\d+)\s*(?:failed|失败).*?(\d+)\s*(?:total|总计)/i,
    )
    if (testResultMatch) {
      return {
        passed: parseInt(testResultMatch[1], 10),
        failed: parseInt(testResultMatch[2], 10),
        total: parseInt(testResultMatch[3], 10),
        files: [],
      }
    }

    // "✓ 5 tests passed" 格式
    const checkMatch = text.match(/(\d+)\s+tests?\s+passed/i)
    if (checkMatch) {
      const passed = parseInt(checkMatch[1], 10)
      const failedMatch = text.match(/(\d+)\s+tests?\s+failed/i)
      const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0
      return { passed, failed, total: passed + failed, files: [] }
    }

    return null
  }

  /**
   * 识别代码模式和架构决策
   */
  private _extractPatterns(text: string): string[] {
    const patterns: string[] = []

    // 识别"遵循 X 模式"或"使用 Y 设计"
    const patternHints = [
      /pattern[:：]\s*(.+)/gi,
      /(?:follow|use|adopt)[ing]?\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:pattern|design)/gi,
      /(?:模式|设计)[:：]\s*(.+)/gi,
      /(?:注意|最佳实践)[:：]\s*(.+)/gi,
    ]

    for (const hint of patternHints) {
      let match: RegExpExecArray | null
      hint.lastIndex = 0
      while ((match = hint.exec(text)) !== null) {
        const pattern = match[1].trim()
        if (pattern.length > 5 && pattern.length < 200) {
          patterns.push(pattern)
        }
      }
    }

    return patterns.slice(0, 3)
  }

  /**
   * 识别关键决策（架构/工具/库选型）
   * 匹配 "decided to", "chose X over Y", "opted for", "决定使用" 等模式
   */
  private _extractDecisions(text: string): string[] {
    const decisions: string[] = []

    const decisionHints = [
      // 添加 m 标志，让 $ 匹配行尾；同时使用 \n 作为终止符之一，
      // 防止 (.+?) 跨多段贪婪吃掉整个段落
      /(?:decided|chose|opted|went)\s+(?:to|for|with)\s+(.+?)(?:\.|because|since|as|\n|$)/gim,
      /(?:decision|选择|决定)[:：]\s*(.+?)(?:\n|$)/gim,
      /(?:use|using|switch to|migrate to)\s+(?:the\s+)?([A-Z][a-zA-Z.]{2,40}(?:\s+[A-Z][a-zA-Z.]{2,40})*)(?:\.|\s+because|\s+since|\s+as|\n|$)/gm,
      /(?:recommend|suggest)\s+(?:using|to use|adopting)\s+(.+?)(?:\.|because|since|as|\n|$)/gim,
      /(?:over|instead of|rather than)\s+(.+?)(?:\.|because|since|as|\n|$)/gim,
      /(?:选择|采用|迁移到|替换为)\s*(.+?)(?:[。，,.\n]|$)/gim,
    ]

    for (const hint of decisionHints) {
      let match: RegExpExecArray | null
      hint.lastIndex = 0
      while ((match = hint.exec(text)) !== null) {
        const decision = match[1].trim()
        if (decision.length > 8 && decision.length < 300) {
          decisions.push(decision)
        }
      }
    }

    // 去重
    return [...new Set(decisions)].slice(0, 3)
  }

  /**
   * 识别经验教训（避免重复踩坑）
   * 匹配 "learned that", "important to note", "注意", "教训" 等模式
   */
  private _extractLessons(text: string): string[] {
    const lessons: string[] = []

    const lessonHints = [
      // 同上：加 m 标志 + \n 终止符，避免跨段落贪婪
      /(?:learned|realized|noticed|found)\s+that\s+(.+?)(?:\.|\n|$)/gim,
      /(?:important|critical|crucial|key)\s+(?:to )?(?:note|remember|know|understand)[:：]?\s+(.+?)(?:\.|\n|$)/gim,
      /(?:watch out for|beware of|be careful with)\s+(.+?)(?:\.|\n|$)/gim,
      /(?:教训|经验|踩坑|注意|坑)[:：]\s*(.+?)(?:\n|$)/gim,
      /(?:避免|不要|小心|谨慎)\s*(.+?)(?:[。，,.\n]|$)/gim,
      /(?:下次|以后|更好的做法是)\s*(.+?)(?:[。，,.\n]|$)/gim,
      /(?:turns out|it appears that|the issue was|the problem was)\s+(.+?)(?:\.|\n|$)/gim,
    ]

    for (const hint of lessonHints) {
      let match: RegExpExecArray | null
      hint.lastIndex = 0
      while ((match = hint.exec(text)) !== null) {
        const lesson = match[1].trim()
        if (lesson.length > 10 && lesson.length < 300) {
          lessons.push(lesson)
        }
      }
    }

    // 去重（基于前 50 字符相似度）
    const unique: string[] = []
    const seen = new Set<string>()
    for (const l of lessons) {
      const prefix = l.substring(0, 50).toLowerCase()
      if (!seen.has(prefix)) {
        seen.add(prefix)
        unique.push(l)
      }
    }

    return unique.slice(0, 3)
  }

}
