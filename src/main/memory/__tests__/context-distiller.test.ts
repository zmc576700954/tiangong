/**
 * ContextDistiller 单元测试
 */

import { describe, it, expect } from 'vitest'
import { ContextDistiller } from '../context-distiller'
import type { ContextFragment } from '../context-distiller'

describe('ContextDistiller', () => {
  const distiller = new ContextDistiller()

  it('removes highly similar paragraphs keeping latest', async () => {
    const sharedCore =
      'The authentication module uses JWT tokens for session management. ' +
      'Tokens are signed with RS256 algorithm and expire after 24 hours. ' +
      'The module validates tokens on every request to protected endpoints. ' +
      'Session creation involves generating a new token pair and storing them securely.'

    const early: ContextFragment = {
      content: sharedCore,
      source: 'memory-1',
      tokens: 30,
    }

    const late: ContextFragment = {
      content: sharedCore + ' Refresh tokens are also supported.',
      source: 'memory-2',
      tokens: 33,
    }

    const unique: ContextFragment = {
      content: 'Database connection pooling is configured with a max of 10 connections.',
      source: 'memory-3',
      tokens: 12,
    }

    const result = await distiller.distill([early, late, unique], 200)

    // The early fragment should be removed (high Jaccard sim with late)
    // The late fragment (memory-2) should be kept (later index)
    expect(result.kept.some((f) => f.source === 'memory-1')).toBe(false)
    expect(result.kept.some((f) => f.source === 'memory-2')).toBe(true)
    expect(result.kept.some((f) => f.source === 'memory-3')).toBe(true)
    expect(result.removed.some((f) => f.source === 'memory-1')).toBe(true)
  })

  it('sorts by information density (unique entities / total tokens)', async () => {
    // Low density: repetitive words, few unique entities
    const lowDensity: ContextFragment = {
      content: 'the the the the the the the the the the data data data data data',
      source: 'low-density',
      tokens: 15,
    }

    // High density: many unique entities
    const highDensity: ContextFragment = {
      content: 'AuthService TokenValidator SessionManager RefreshHandler',
      source: 'high-density',
      tokens: 5,
    }

    // Both general type, so priority is equal; sort by density
    const result = await distiller.distill([lowDensity, highDensity], 200)

    // Both should be kept (budget is ample)
    expect(result.kept.length).toBe(2)

    // high-density should come first (higher density)
    const sources = result.kept.map((f) => f.source)
    const highIdx = sources.indexOf('high-density')
    const lowIdx = sources.indexOf('low-density')
    expect(highIdx).toBeLessThan(lowIdx)
  })

  it('preserves first-occurrence concept definitions (type=definition gets priority 3)', async () => {
    const definition: ContextFragment = {
      content: 'A closure is a function that captures variables from its enclosing scope.',
      source: 'def-1',
      tokens: 12,
      type: 'definition',
    }

    const generalImportant: ContextFragment = {
      content:
        'Refactoring improved performance by eliminating redundant database queries ' +
        'and adding proper indexing on the user_accounts table.',
      source: 'gen-1',
      tokens: 18,
      type: 'general',
    }

    const decision: ContextFragment = {
      content: 'Decided to use Redis for caching instead of in-memory cache.',
      source: 'dec-1',
      tokens: 10,
      type: 'decision',
    }

    // Tight budget: only one can fit
    const result = await distiller.distill([generalImportant, definition, decision], 12)

    // definition should be kept (priority 3 > others)
    expect(result.kept.some((f) => f.source === 'def-1')).toBe(true)
    // definition should come first in kept
    expect(result.kept[0].source).toBe('def-1')
  })

  it('trims to budget by removing low-priority fragments', async () => {
    const fragments: ContextFragment[] = [
      {
        content: 'Critical error: database connection failed with timeout.',
        source: 'err-1',
        tokens: 50,
        type: 'error',
      },
      {
        content: 'Chose PostgreSQL over MySQL for better JSON support.',
        source: 'dec-1',
        tokens: 40,
        type: 'decision',
      },
      {
        content: 'The weather is nice today and the team had a good lunch.',
        source: 'gen-1',
        tokens: 60,
        type: 'general',
      },
      {
        content: 'Another general note about the project status update meeting.',
        source: 'gen-2',
        tokens: 50,
        type: 'general',
      },
    ]

    // Budget that fits error + decision but not the generals
    const result = await distiller.distill(fragments, 95)

    // High-priority fragments should be kept
    expect(result.kept.some((f) => f.source === 'err-1')).toBe(true)
    expect(result.kept.some((f) => f.source === 'dec-1')).toBe(true)

    // Low-priority general fragments should be removed (or at least not all kept)
    const keptSources = result.kept.map((f) => f.source)
    const keptGenerals = keptSources.filter((s) => s.startsWith('gen-'))
    // At least one general should be trimmed
    expect(keptGenerals.length).toBeLessThan(2)

    // Removed should contain the trimmed fragments
    expect(result.removed.length).toBeGreaterThan(0)

    // savingsPct should be positive
    expect(result.savingsPct).toBeGreaterThan(0)

    // totalTokens should equal sum of all input fragments
    const expectedTotal = fragments.reduce((sum, f) => sum + f.tokens, 0)
    expect(result.totalTokens).toBe(expectedTotal)
  })
})
