import { describe, it, expect } from 'vitest'
import { evaluateMatch } from '../gates/node-matching'

describe('evaluateMatch', () => {
  it('returns high confidence for exact match', () => {
    const result = evaluateMatch('authentication', ['authentication'], [])
    expect(result.confidence).toBe('high')
    expect(result.score).toBe(1.0)
  })

  it('returns low confidence for no matches', () => {
    const result = evaluateMatch('authentication', [], ['auth', 'login'])
    expect(result.confidence).toBe('low')
    expect(result.score).toBe(0.1)
    expect(result.rewrittenQuery).toBeDefined()
  })

  it('returns ambiguous for partial match', () => {
    const result = evaluateMatch('auth system', ['authentication', 'authorization'], [])
    expect(result.confidence).toBe('ambiguous')
    expect(result.candidates).toBeDefined()
  })

  it('returns low for noise matches', () => {
    const result = evaluateMatch('build test', ['npm', 'build', 'test'], [])
    expect(result.confidence).toBe('low')
  })

  it('suggests rewrite with available domains', () => {
    const result = evaluateMatch('feature', [], ['auth', 'payment', 'user'])
    expect(result.rewrittenQuery).toContain('auth')
    expect(result.rewrittenQuery).toContain('payment')
  })

  it('suggests rewrite without domains when none available', () => {
    const result = evaluateMatch('feature', [], [])
    expect(result.rewrittenQuery).toContain('更具体的业务域名称')
  })

  it('handles single character domain', () => {
    const result = evaluateMatch('a', ['a'], [])
    expect(result.confidence).toBe('high')
  })
})
