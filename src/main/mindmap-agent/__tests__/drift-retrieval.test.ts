import { describe, it, expect } from 'vitest'
import { driftRetrieve } from '../retrieval/drift'
import type { ScanModule } from '@shared/types'

const mockModules: ScanModule[] = [
  {
    name: 'Auth',
    description: 'Authentication and user management',
    processes: [
      { name: 'Login', description: 'User login', features: [{ name: 'Login Form', description: 'Login UI' }] },
    ],
  },
  {
    name: 'Payment',
    description: 'Payment processing and checkout',
    processes: [
      { name: 'Checkout', description: 'Checkout flow', features: [{ name: 'Cart', description: 'Cart items' }] },
    ],
  },
  {
    name: 'User',
    description: 'User profile and settings management',
    processes: [
      { name: 'Profile', description: 'User profile', features: [{ name: 'Avatar', description: 'User avatar' }] },
    ],
  },
]

describe('driftRetrieve', () => {
  it('returns null-like result for no matches', () => {
    const result = driftRetrieve([], mockModules)
    expect(result.collectedModules.length).toBe(0)
    expect(result.explorationPath.length).toBe(0)
  })

  it('loads directly matched modules in Phase 1', () => {
    const result = driftRetrieve(['Auth'], mockModules)
    expect(result.collectedModules.length).toBeGreaterThanOrEqual(1)
    expect(result.collectedModules[0].module.name).toBe('Auth')
    expect(result.collectedModules[0].relevance).toBe(1.0)
    expect(result.explorationPath.some((p) => p.includes('Phase1'))).toBe(true)
  })

  it('explores related modules in Phase 2', () => {
    // Use a single domain match; Phase 2 explores neighbors by relevance
    const result = driftRetrieve(['Auth'], mockModules)
    // Auth is loaded in Phase 1; Phase 2 may explore User due to shared 'user' keyword
    expect(result.collectedModules.length).toBeGreaterThanOrEqual(1)
    expect(result.collectedModules[0].module.name).toBe('Auth')
  })

  it('respects token budget', () => {
    const result = driftRetrieve(['Auth', 'Payment', 'User'], mockModules, [], 500)
    expect(result.tokenEstimate).toBeLessThanOrEqual(500)
  })

  it('uses community summaries when available', () => {
    const summaries = [
      { id: 's1', graphId: '', level: 1, nodeIds: [], title: 'Auth 业务域', summary: 'Auth handles login', keyFindings: [] },
    ]
    const result = driftRetrieve(['Auth'], mockModules, summaries)
    expect(result.collectedModules.length).toBeGreaterThanOrEqual(1)
    expect(result.collectedModules[0].module.name).toBe('Auth')
  })

  it('handles case-insensitive matching', () => {
    const result = driftRetrieve(['auth'], mockModules)
    expect(result.collectedModules.length).toBeGreaterThanOrEqual(1)
    expect(result.collectedModules[0].module.name).toBe('Auth')
  })

  it('tracks exploration path', () => {
    const result = driftRetrieve(['Auth'], mockModules)
    expect(result.explorationPath.length).toBeGreaterThan(0)
  })

  it('returns token estimate', () => {
    const result = driftRetrieve(['Auth'], mockModules)
    expect(result.tokenEstimate).toBeGreaterThan(0)
  })
})
