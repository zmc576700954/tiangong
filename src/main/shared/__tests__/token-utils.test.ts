import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../token-utils'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('returns 0 for null/undefined-like empty', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates English text (~4 chars per token)', () => {
    const tokens = estimateTokens('hello world')
    // 11 chars / 4 = 2.75 → ceil = 3
    expect(tokens).toBe(3)
  })

  it('estimates Chinese text (~1.5 chars per token)', () => {
    const tokens = estimateTokens('你好世界测试')
    // 6 CJK chars / 1.5 = 4
    expect(tokens).toBe(4)
  })

  it('handles mixed CJK and English', () => {
    const tokens = estimateTokens('hello你好')
    // 5 English + 2 CJK = 5/4 + 2/1.5 = 1.25 + 1.33 = 2.58 → ceil = 3
    expect(tokens).toBe(3)
  })

  it('handles long text', () => {
    const text = 'a'.repeat(1000)
    const tokens = estimateTokens(text)
    expect(tokens).toBe(250) // 1000/4
  })

  it('handles text with only spaces', () => {
    const tokens = estimateTokens('    ')
    expect(tokens).toBe(1) // 4 spaces / 4 = 1
  })
})
