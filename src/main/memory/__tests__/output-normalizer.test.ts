/**
 * OutputNormalizer 单元测试
 */

import { describe, it, expect } from 'vitest'
import { OutputNormalizer } from '../output-normalizer'
import type { AgentOutput } from '@shared/types'

describe('OutputNormalizer', () => {
  const normalizer = new OutputNormalizer()

  /** Helper: create a stdout output */
  function stdout(data: string): AgentOutput {
    return { type: 'stdout', data, timestamp: Date.now() }
  }

  /** Helper: create a stderr output */
  function stderr(data: string): AgentOutput {
    return { type: 'stderr', data, timestamp: Date.now() }
  }

  /** Helper: create an error output */
  function errorOutput(data: string): AgentOutput {
    return { type: 'error', data, timestamp: Date.now() }
  }

  it('strips ANSI escape codes', () => {
    const input = stdout('\x1B[32mSuccess\x1B[0m: all \x1B[1;34mfiles\x1B[0m done')
    const result = normalizer.normalize(input)
    expect(result.data).toBe('Success: all files done')
  })

  it('strips progress bar lines', () => {
    const input = stdout('Building...\n[=====>    ] 45%\nCompiling...\n[========>  ] 80%\nDone!')
    const result = normalizer.normalize(input)
    expect(result.data).toBe('Building...\nCompiling...\nDone!')
  })

  it('strips timestamp prefixes', () => {
    const input = stdout('[2024-01-15 10:30:25] Starting build\n[2024/01/15 10:30:26] Build complete')
    const result = normalizer.normalize(input)
    expect(result.data).toBe('Starting build\nBuild complete')
  })

  it('strips duplicate consecutive lines', () => {
    const input = stdout('Compiling...\nCompiling...\nCompiling...\nLinking...\nDone!')
    const result = normalizer.normalize(input)
    expect(result.data).toBe('Compiling...\nLinking...\nDone!')
  })

  it('preserves error output unchanged', () => {
    const errData = '\x1B[31mError\x1B[0m: something \r\n went wrong [====>  ] 50%'
    const err = stderr(errData)
    const result = normalizer.normalize(err)
    expect(result.data).toBe(errData)

    const errorOut = errorOutput(errData)
    const result2 = normalizer.normalize(errorOut)
    expect(result2.data).toBe(errData)
  })

  it('normalizes line endings to LF', () => {
    const input = stdout('line1\r\nline2\rline3\nline4')
    const result = normalizer.normalize(input)
    expect(result.data).toBe('line1\nline2\nline3\nline4')
    // No CR or CRLF should remain
    expect(result.data).not.toContain('\r')
  })

  describe('normalizeAll', () => {
    it('batch normalizes multiple outputs', () => {
      const outputs: AgentOutput[] = [
        stdout('\x1B[32mOK\x1B[0m'),
        stderr('do not touch'),
        stdout('[2024-01-01 00:00:00] hello\r\nhello'),
      ]
      const results = normalizer.normalizeAll(outputs)
      expect(results[0].data).toBe('OK')
      expect(results[1].data).toBe('do not touch')
      // timestamp stripped, then line ending normalized, then consecutive dedup
      // "hello\nhello" → consecutive dedup removes second "hello"
      expect(results[2].data).toBe('hello')
    })
  })

  describe('identity optimization', () => {
    it('returns same object reference when no change is needed', () => {
      const input = stdout('clean text already')
      const result = normalizer.normalize(input)
      expect(result).toBe(input)
    })
  })

  describe('adapter-specific noise', () => {
    it('filters cursor noise lines', () => {
      const input = stdout('useful output\nAnalyzing...\nmore useful output')
      const result = normalizer.normalizeWithAdapter(input, 'cursor')
      expect(result.data).toBe('useful output\nmore useful output')
    })

    it('filters opencode noise lines', () => {
      const input = stdout('useful output\nOpenCode: thinking\nmore useful output')
      const result = normalizer.normalizeWithAdapter(input, 'opencode')
      expect(result.data).toBe('useful output\nmore useful output')
    })

    it('filters mindmap-internal noise lines', () => {
      const input = stdout('useful output\nmindmap-internal: status update\nmore useful output')
      const result = normalizer.normalizeWithAdapter(input, 'mindmap-internal')
      expect(result.data).toBe('useful output\nmore useful output')
    })
  })
})
