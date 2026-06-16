/**
 * Observer 压缩器 —— 借鉴 claude-mem 的后台记忆压缩调度器
 *
 * 核心设计:
 *   不同于 MemoryExtractor 的「执行后一次性提取」，
 *   ObserverCompressor 在 Agent 执行过程中持续观察输出流，
 *   当累积输出超过阈值时触发增量压缩，将长篇输出逐步折叠为结构化观察。
 *
 * 数据流:
 *   AgentOutput 流 → ObserverCompressor.feed(output)
 *     → 滑动窗口累积 → 超阈值时触发 _compress()
 *     → 增量压缩观测存储 → ObserverCompressor.observations[]
 *     → 会话结束时 merge() 合并最终记忆
 *
 * 压缩策略（不含 LLM 调用的纯启发式方法）:
 *   1. 文本分块: 按自然段落/代码块边界拆分
 *   2. 关键词提取: TF-IDF 启发式的术语/实体提取
 *   3. 变更摘要: 从 file_change 事件和 diff 模式中提取
 *   4. 进度追踪: 识别阶段性完成信号（"done", "✓", "complete"）
 *
 * 使用场景:
 *   - Agent 长时间运行（多轮对话或复杂任务），输出可能达到数万字
 *   - 需要实时观察进度，而非等到会话结束
 *   - 需要在 UI 中展示渐进式记忆构建过程
 */

import type { AgentOutput, MemoryItem, MemoryKind } from '@shared/types'
import { createLogger } from '../shared/logger'
import { estimateTokens } from '../shared/token-utils'

const logger = createLogger('ObserverCompressor')

// ============================================
// 类型定义
// ============================================

/** 单次压缩产生的观察记录 */
export interface CompressedObservation {
  /** 观察序号（全局单调递增） */
  seq: number
  /** 产生时间（ISO 时间戳） */
  timestamp: string
  /** 原始输出块的数量 */
  inputChunks: number
  /** 原始文本的估计 token 数 */
  inputTokens: number
  /** 压缩后摘要的估计 token 数 */
  outputTokens: number
  /** 压缩摘要 */
  summary: string
  /** 提取的关键术语 */
  keyTerms: string[]
  /** 检测到的文件变更 */
  filesChanged: string[]
  /** 检测到的阶段标记（done/error/...） */
  phaseSignal: 'progress' | 'done' | 'error' | 'info' | null
  /** 压缩比 = outputTokens / inputTokens */
  compressionRatio: number
}

/** ObserverCompressor 运行时状态 */
export interface CompressorState {
  /** 输出缓冲区（累积的原始文本） */
  buffer: string
  /** 缓冲区的估计 token 数 */
  bufferTokens: number
  /** 已生成的观察记录 */
  observations: CompressedObservation[]
  /** 总输入 token 数 */
  totalInputTokens: number
  /** 总输出 token 数（压缩后） */
  totalOutputTokens: number
  /** 全局观察序号 */
  observationSeq: number
  /** 累计的处理块数 */
  chunksProcessed: number
  /** 上次压缩时间 */
  lastCompressAt: string | null
  /** 是否已完成（会话结束标记） */
  finalized: boolean
}

/** ObserverCompressor 配置 */
export interface ObserverCompressorConfig {
  /** Token 累积阈值：超过此值触发压缩（默认 4000, ~1k words） */
  compressThresholdTokens: number
  /** 最小压缩间隔（毫秒）：避免过于频繁的压缩（默认 5000ms） */
  minCompressIntervalMs: number
  /** 压缩后缓冲区保留比例：保留最后 N% 的文本以保持上下文连续性（默认 0.2, 即 20%）*/
  bufferRetentionRatio: number
  /** 是否启用详细日志 */
  verbose: boolean
}

/** 默认配置 */
export const DEFAULT_COMPRESSOR_CONFIG: ObserverCompressorConfig = {
  compressThresholdTokens: 4000,
  minCompressIntervalMs: 5000,
  bufferRetentionRatio: 0.2,
  verbose: false,
}

// ============================================
// ObserverCompressor 主类
// ============================================

export class ObserverCompressor {
  private config: ObserverCompressorConfig
  private state: CompressorState

  constructor(config?: Partial<ObserverCompressorConfig>) {
    this.config = { ...DEFAULT_COMPRESSOR_CONFIG, ...config }
    this.state = this._freshState()
  }

  /** 创建初始状态 */
  private _freshState(): CompressorState {
    return {
      buffer: '',
      bufferTokens: 0,
      observations: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      observationSeq: 0,
      chunksProcessed: 0,
      lastCompressAt: null,
      finalized: false,
    }
  }

  /**
   * 喂入一个 AgentOutput 块
   * 如果累积超过阈值，自动触发压缩
   *
   * @returns 如果有新产生的观察记录，返回它；否则返回 null
   */
  feed(output: AgentOutput): CompressedObservation | null {
    if (this.state.finalized) {
      logger.warn('ObserverCompressor already finalized, ignoring feed')
      return null
    }

    // 只处理有实质内容的输出
    if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'complete') {
      const text = output.data
      if (text.trim().length > 0) {
        this.state.buffer += (this.state.buffer.length > 0 ? '\n' : '') + text
        const addedTokens = estimateTokens(text)
        this.state.bufferTokens += addedTokens
        this.state.totalInputTokens += addedTokens
        this.state.chunksProcessed++
      }
    }

    // 检查是否达到压缩阈值
    if (this.state.bufferTokens >= this.config.compressThresholdTokens) {
      // 二级阈值：超过 4 倍阈值即视为严重堆积，绕过 cooldown 强制压缩
      // 防止 cooldown 期间 stdout 高速涌入导致 buffer 无限增长 → OOM
      const hardCap = this.config.compressThresholdTokens * 4
      const overHardCap = this.state.bufferTokens >= hardCap

      if (!overHardCap && this.state.lastCompressAt) {
        const lastTime = new Date(this.state.lastCompressAt).getTime()
        const now = Date.now()
        if (now - lastTime < this.config.minCompressIntervalMs) {
          return null // 距离上次压缩太近，跳过
        }
      }

      return this._compress()
    }

    return null
  }

  /**
   * 手动触发压缩（即使缓冲区未达到阈值）
   * 在会话结束前调用以确保不丢失最后一段输出
   */
  flush(): CompressedObservation | null {
    if (this.state.finalized) return null
    if (this.state.buffer.trim().length === 0) return null

    return this._compress()
  }

  /**
   * 完成压缩（标记结束并执行最终 flush）
   * 返回所有观察记录（作为 MemoryItem 列表的输入源）
   */
  finalize(): CompressedObservation[] {
    if (this.state.finalized) return [...this.state.observations]

    // 最后一次 flush（将剩余缓冲压缩）
    const lastObs = this.flush()
    if (lastObs) {
      this.state.observations.push(lastObs)
    }

    this.state.finalized = true

    if (this.config.verbose) {
      logger.info('ObserverCompressor finalized', {
        chunks: this.state.chunksProcessed,
        observations: this.state.observations.length,
        totalInputTokens: this.state.totalInputTokens,
        totalOutputTokens: this.state.totalOutputTokens,
        avgCompressionRatio: this.state.totalInputTokens > 0
          ? (this.state.totalOutputTokens / this.state.totalInputTokens * 100).toFixed(1) + '%'
          : '0%',
      })
    }

    return [...this.state.observations]
  }

  /**
   * 从已完成的压缩观察列表中生成 MemoryItem 列表
   * 这是 Observer → MemoryStore 的桥接方法
   */
  generateMemories(
    sessionId: string,
    options: {
      projectId?: string
      nodeId?: string
      adapterName: string
    },
  ): Omit<MemoryItem, 'id'>[] {
    const items: Omit<MemoryItem, 'id'>[] = []

    for (const obs of this.state.observations) {
      if (obs.summary.trim().length === 0) continue

      // 确定记忆类型
      let kind: MemoryKind = 'investigation'
      if (obs.phaseSignal === 'done' && obs.filesChanged.length > 0) {
        kind = 'fix'
      } else if (obs.phaseSignal === 'error') {
        kind = 'review_finding'
      } else if (obs.keyTerms.some((t) => /^(?:architecture|design|pattern|decision)/i.test(t))) {
        kind = 'decision'
      }

      // 质量感知置信度：基于可观察的质量信号计算
      let confidence = 0.4  // 基线
      if (obs.filesChanged.length > 0) confidence += 0.15
      if (obs.keyTerms.length >= 3) confidence += 0.1
      if (obs.compressionRatio > 0.05 && obs.compressionRatio < 0.8) confidence += 0.1
      if (obs.phaseSignal === 'done' && obs.filesChanged.length > 0) confidence += 0.15
      if (obs.phaseSignal === 'error') confidence += 0.2
      confidence = Math.min(0.95, confidence)

      items.push({
        session_id: sessionId,
        kind,
        project_id: options.projectId ?? '',
        node_id: options.nodeId ?? null,
        title: `[Obs #${obs.seq}] ${obs.summary.substring(0, 80)}`,
        narrative: obs.summary,
        facts: [
          `Input tokens: ${obs.inputTokens}`,
          `Output tokens: ${obs.outputTokens}`,
          `Compression ratio: ${(obs.compressionRatio * 100).toFixed(1)}%`,
          `Chunks processed: ${obs.inputChunks}`,
        ],
        concepts: obs.keyTerms.slice(0, 10).map((t) => t.toLowerCase()),
        files_read: [],
        files_modified: obs.filesChanged,
        adapter_name: options.adapterName,
        token_cost: obs.inputTokens,
        confidence,
        created_at: obs.timestamp,
      })
    }

    return items
  }

  /**
   * 获取压缩统计信息
   */
  getStats(): {
    chunksProcessed: number
    observationCount: number
    totalInputTokens: number
    totalOutputTokens: number
    overallCompressionRatio: number
    finalized: boolean
  } {
    return {
      chunksProcessed: this.state.chunksProcessed,
      observationCount: this.state.observations.length,
      totalInputTokens: this.state.totalInputTokens,
      totalOutputTokens: this.state.totalOutputTokens,
      overallCompressionRatio: this.state.totalInputTokens > 0
        ? this.state.totalOutputTokens / this.state.totalInputTokens
        : 0,
      finalized: this.state.finalized,
    }
  }

  /**
   * 重置状态（用于同一会话的不同阶段）
   */
  reset(): void {
    if (this.config.verbose) {
      logger.info('ObserverCompressor reset')
    }
    this.state = this._freshState()
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 核心压缩逻辑
   *
   * 策略：
   *   1. 提取缓冲区中最后 retention 比例的文本作为"上下文尾"保留到下一轮
   *   2. 对剩余文本进行压缩摘要：
   *      a. 按自然段落分块
   *      b. 对每个段落提取关键词（TF-index 启发式）
   *      c. 生成压缩后的结构化摘要
   *   3. 检测阶段信号（done/error/progress）
   *   4. 提取文件变更列表
   */
  private _compress(): CompressedObservation | null {
    const buffer = this.state.buffer
    if (buffer.trim().length === 0) return null

    const now = new Date().toISOString()
    const inputTokens = this.state.bufferTokens

    // 1. 保留尾部上下文（保持连续性）
    //
    // 三种边界要 clamp，缺一不可：
    //   - retentionChars === 0      : slice(-0) 返回整个 buffer
    //   - retentionChars >= buffer.length : tail = 整个 buffer, mainText = '' → 触发无限压缩
    //   - bufferRetentionRatio 配错为 >=1 时 floor 也可能等于 buffer.length
    // 通过 clamp 到 [0, buffer.length - 1]，保证 mainText 至少有 1 个字符被消费。
    const rawRetention = Math.floor(buffer.length * this.config.bufferRetentionRatio)
    const retentionChars = Math.max(0, Math.min(rawRetention, buffer.length - 1))
    const tail = retentionChars > 0 ? buffer.slice(-retentionChars) : ''
    const mainText = retentionChars > 0 ? buffer.slice(0, -retentionChars) : buffer

    // 2. 提取摘要
    const summary = this._extractSummary(mainText)

    // 3. 提取关键词
    const keyTerms = this._extractKeyTerms(mainText)

    // 4. 检测阶段信号
    const phaseSignal = this._detectPhaseSignal(mainText)

    // 5. 提取文件变更
    const filesChanged = this._extractFileChanges(mainText)

    // 6. 计算输出 token
    const outputTokens = estimateTokens(summary)

    // 7. 跨观察去重：与前一条观察比较 Jaccard 相似度
    const prev = this.state.observations[this.state.observations.length - 1]
    if (prev && keyTerms.length > 0 && prev.keyTerms.length > 0) {
      const prevTerms = new Set(prev.keyTerms.map(t => t.toLowerCase()))
      const currTerms = new Set(keyTerms.map(t => t.toLowerCase()))
      const intersection = [...currTerms].filter(t => prevTerms.has(t)).length
      const union = new Set([...prevTerms, ...currTerms]).size
      if (union > 0 && intersection / union > 0.7) {
        // 合并到前一条观察而非新建
        prev.summary = prev.summary + '\n' + summary
        prev.keyTerms = [...new Set([...prev.keyTerms, ...keyTerms])].slice(0, 15)
        prev.filesChanged = [...new Set([...prev.filesChanged, ...filesChanged])].slice(0, 20)
        prev.outputTokens = estimateTokens(prev.summary)
        prev.inputChunks = this.state.chunksProcessed
        // 取更严重的阶段信号
        if (phaseSignal === 'error' || prev.phaseSignal === 'error') {
          prev.phaseSignal = 'error'
        } else if (phaseSignal === 'done' || prev.phaseSignal === 'done') {
          prev.phaseSignal = 'done'
        }
        prev.compressionRatio = prev.inputTokens > 0 ? prev.outputTokens / prev.inputTokens : 0

        // 更新状态（不 push 新观察）
        this.state.buffer = tail
        this.state.bufferTokens = estimateTokens(tail)
        this.state.totalOutputTokens += estimateTokens(summary)
        this.state.lastCompressAt = now

        if (this.config.verbose) {
          logger.debug(`Observer merged with previous: Jaccard >0.7, ${keyTerms.length} terms merged`)
        }
        return prev
      }
    }

    // 8. 生成新观察结果
    const observation: CompressedObservation = {
      seq: ++this.state.observationSeq,
      timestamp: now,
      inputChunks: this.state.chunksProcessed,
      inputTokens,
      outputTokens,
      summary,
      keyTerms,
      filesChanged,
      phaseSignal,
      compressionRatio: inputTokens > 0 ? outputTokens / inputTokens : 0,
    }

    // 9. 更新状态
    this.state.observations.push(observation)
    this.state.buffer = tail
    this.state.bufferTokens = estimateTokens(tail)
    this.state.totalOutputTokens += outputTokens
    this.state.lastCompressAt = now

    if (this.config.verbose) {
      logger.debug(`Observer compressed: ${inputTokens} → ${outputTokens} tokens ` +
        `(${(observation.compressionRatio * 100).toFixed(1)}%), ` +
        `${keyTerms.length} terms, phase=${phaseSignal ?? 'none'}`)
    }

    return observation
  }

  /**
   * 文本摘要提取
   *
   * 策略：
   *   1. 先按双换行（自然段落）拆分
   *   2. 对每段做重要性评分：
   *      - 含数字/百分比/错误信息的段 +3
   *      - 含文件路径的段 +2
   *      - 含关键决策词的段 +2
   *      - 含完成/进展信号的段 +1
   *      - 过短的段（<20 字符）: -2
   *   3. 选择得分最高的前 N 段组合为摘要（最多 ~200 tokens）
   */
  private _extractSummary(text: string): string {
    const targetTokens = 150 // 目标摘要约为 150 tokens (~600 chars)

    // 按段落拆分
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 5)

    if (paragraphs.length === 0) return text.substring(0, 600).trim()

    // 评分段落（含位置感知：首尾段落更重要）
    const scored = paragraphs.map((p, i) => {
      let score = 0
      if (/\d+/.test(p) || /error|fail|exception/i.test(p)) score += 3
      if (/[/\\][\w.-]+\.[a-z]{2,5}/i.test(p)) score += 2
      if (/(?:decided|chose|selected|architecture|design pattern)/i.test(p)) score += 2
      if (/(?:done|complete|success|finished|✓|✅)/i.test(p)) score += 1
      if (p.length < 20) score -= 2
      // 位置感知奖励：首段通常是引言，尾段通常是结论
      const position = i / (paragraphs.length - 1 || 1)
      if (position < 0.1) score += 2  // 前10%段落
      if (position > 0.9) score += 2  // 后10%段落
      return { text: p, score }
    })

    // 按得分降序
    scored.sort((a, b) => b.score - a.score)

    // 选择最相关的段落直到目标 token
    let result = ''
    let tokenCount = 0
    for (const { text: p } of scored) {
      const pt = estimateTokens(p)
      if (tokenCount + pt > targetTokens * 1.5) continue
      result += (result.length > 0 ? '\n\n' : '') + p
      tokenCount += pt
    }

    return result || text.substring(0, 600).trim()
  }

  /**
   * 关键词提取（纯启发式，无 LLM 调用）
   *
   * 策略：
   *   1. 按非字母数字符分词
   *   2. 过滤停用词
   *   3. 基于 TF-index（词频排名）取 top 15
   *   4. 识别大写开头的多词术语（如 "SessionRouter"、"AdapterRegistry"）
   */
  private _extractKeyTerms(text: string): string[] {
    // 停用词表（英文 + 中文）
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
      'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every',
      'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they',
      'we', 'you', 'i', 'me', 'my', 'our', 'your', 'his', 'her', 'their',
      '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一',
      '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
      '没有', '看', '好', '自己', '这',
    ])

    // 提取所有单词
    const words = text
      .toLowerCase()
      .split(/[^a-zA-Z0-9一-鿿]+/)
      .filter((w) => w.length > 1 && !stopWords.has(w))

    // 词频统计
    const freq = new Map<string, number>()
    for (const w of words) {
      freq.set(w, (freq.get(w) ?? 0) + 1)
    }

    // 按词频排序取 top 15
    const sorted = Array.from(freq.entries())
      .filter(([, count]) => count >= 2) // 至少出现 2 次
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word]) => word)

    // 额外提取大写开头的多词术语（如 "ScopeGuard", "MemoryStore"）
    // 总是保留原始大小写，优先于小写版本
    const camelTerms = new Set(
      text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g)?.slice(0, 5) ?? [],
    )
    for (const term of camelTerms) {
      const lowerTerm = term.toLowerCase()
      // 移除同一个小写版本，用原始大小写替换
      const idx = sorted.findIndex((w) => w === lowerTerm)
      if (idx >= 0) {
        sorted[idx] = term
      } else {
        sorted.push(term)
      }
    }

    return sorted.slice(0, 15)
  }

  /**
   * 检测阶段完成信号
   */
  private _detectPhaseSignal(text: string): CompressedObservation['phaseSignal'] {
    // 完成信号
    const doneMarkers = [
      /\b(?:done|complete|finished|success|accomplished)\b/i,
      /✓|✅|🎉/,
      /(?:all|全部)\s+(?:tests?|测试)\s+(?:pass|通过)/i,
      /(?:build|构建)\s+(?:success|成功)/i,
      /(?:任务|task)\s+(?:完成|done)/i,
    ]
    if (doneMarkers.some((m) => m.test(text))) return 'done'

    // 错误信号
    const errorMarkers = [
      /\b(?:error|fail|crash|timeout|exception)\b/i,
      /❌|⛔|💥/,
      /(?:tests?|测试)\s+(?:fail|失败)/i,
      /(?:build|构建)\s+(?:fail|失败)/i,
    ]
    if (errorMarkers.some((m) => m.test(text))) return 'error'

    // 进展信号
    const progressMarkers = [
      /\b(?:working|processing|loading|generating|compiling)\b/i,
      /⏳|🔄/,
      /(?:步骤|step)\s+\d+/i,
      /\d+%/,
    ]
    if (progressMarkers.some((m) => m.test(text))) return 'progress'

    return 'info'
  }

  /**
   * 从文本中提取文件路径变更
   */
  private _extractFileChanges(text: string): string[] {
    const patterns = [
      // "Modified: src/main/foo.ts"
      /(?:modif(?:y|ied)|change(?:d)?|edit(?:ed)?|wrote?|creat(?:e|ed)|add(?:ed)?|delet(?:e|ed)|update(?:d)?)\s*[:：]\s*([^\s\n]{5,200}\.\w{2,10})/gi,
      // Git diff 输出样式
      /(?:---|\+\+\+)\s+(?:a|b)\/([^\s\n]{5,200}\.\w{2,10})/g,
      // 绝对/相对路径
      /([\w./-]+\.[a-z]{2,10})(?:\s*[:：]\s*\d+)?(?:\s*[-–]\s*(?:modified|changed|updated|added|deleted|created))/gi,
    ]

    const files = new Set<string>()
    for (const pattern of patterns) {
      let match: RegExpExecArray | null
      pattern.lastIndex = 0
      while ((match = pattern.exec(text)) !== null) {
        const file = match[1].trim()
        if (file.length > 3 && file.length < 300 && !file.startsWith('.')) {
          files.add(file)
        }
      }
    }

    return Array.from(files).slice(0, 20)
  }

}
