/**
 * OutputNormalizer —— Agent 输出标准化
 *
 * 在 Agent 输出进入记忆提取或上下文编译之前，对文本进行标准化清理，
 * 消除终端噪声，减少后续处理的无效 token：
 *   1. 统一行尾（CRLF / CR → LF）
 *   2. 剥离 ANSI 转义序列
 *   3. 剥离进度条行（如 [====>  ] 45%）
 *   4. 剥离时间戳前缀（如 [2024-01-15 10:30:25]）
 *   5. 去除连续重复行
 *
 * stderr / error 类型输出保持原样不做修改。
 */

import type { AgentOutput } from '@shared/types'

// ============================================
// 正则预编译
// ============================================

/** ANSI 转义序列：颜色、光标移动、清屏等 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B\].*?(?:\x07|\x1B\\)/g

/** 进度条行：含 [===  ] 或 ===> 等进度模式且带百分比/数字 */
const PROGRESS_BAR_RE = /^\s*\[=*[-+> ]*\]\s*\d+%/m

/** 行首时间戳前缀：[2024-01-15 10:30:25] 或 [2024/01/15 10:30:25] */
const TIMESTAMP_PREFIX_RE = /^\s*\[\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*/

/** CRLF → LF, CR → LF */
const CRLF_RE = /\r\n/g
const CR_RE = /\r/g

// ============================================
// OutputNormalizer 主类
// ============================================

export class OutputNormalizer {
  /**
   * 标准化单条 AgentOutput
   *
   * stderr / error 类型输出保持原样不做修改；
   * 仅对 stdout / complete 类型的 data 字段执行标准化。
   */
  normalize(output: AgentOutput): AgentOutput {
    if (this._shouldPreserve(output)) {
      return output
    }

    const normalized = this._normalizeText(output.data)

    // 如果标准化后数据无实质变化，直接返回原对象（减少对象分配）
    if (normalized === output.data) {
      return output
    }

    return { ...output, data: normalized }
  }

  /**
   * 批量标准化
   */
  normalizeAll(outputs: AgentOutput[]): AgentOutput[] {
    return outputs.map((o) => this.normalize(o))
  }

  // ============================================
  // 内部方法
  // ============================================

  /**
   * 判断该输出是否应保持原样（stderr / error 不做修改）
   */
  private _shouldPreserve(output: AgentOutput): boolean {
    return output.type === 'stderr' || output.type === 'error'
  }

  /**
   * 对文本依次执行五步标准化
   */
  private _normalizeText(text: string): string {
    let result = text

    // 1. 统一行尾
    result = this._normalizeLineEndings(result)

    // 2. 剥离 ANSI 转义序列
    result = this._stripAnsi(result)

    // 3. 剥离进度条行
    result = this._stripProgressBars(result)

    // 4. 剥离时间戳前缀
    result = this._stripTimestamps(result)

    // 5. 去除连续重复行
    result = this._deduplicateConsecutiveLines(result)

    return result
  }

  /** 统一行尾：CRLF → LF, CR → LF */
  private _normalizeLineEndings(text: string): string {
    return text.replace(CRLF_RE, '\n').replace(CR_RE, '\n')
  }

  /** 剥离 ANSI 转义序列 */
  private _stripAnsi(text: string): string {
    return text.replace(ANSI_RE, '')
  }

  /** 剥离进度条行 */
  private _stripProgressBars(text: string): string {
    const lines = text.split('\n')
    const filtered = lines.filter((line) => !PROGRESS_BAR_RE.test(line))
    return filtered.join('\n')
  }

  /** 剥离行首时间戳前缀（逐行处理，确保每行都被匹配） */
  private _stripTimestamps(text: string): string {
    const lines = text.split('\n')
    return lines.map((line) => line.replace(TIMESTAMP_PREFIX_RE, '')).join('\n')
  }

  /** 去除连续重复行 */
  private _deduplicateConsecutiveLines(text: string): string {
    const lines = text.split('\n')
    if (lines.length <= 1) return text

    const result: string[] = [lines[0]]
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] !== lines[i - 1]) {
        result.push(lines[i])
      }
    }
    return result.join('\n')
  }
}
