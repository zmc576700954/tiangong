import { describe, it, expect } from 'vitest'
import { localRetrieve } from '../retrieval/local'
import type { ScanModule } from '@shared/types'

const mockModules: ScanModule[] = [
  {
    name: 'Auth',
    description: 'Authentication module',
    processes: [
      {
        name: 'Login',
        description: 'Login process',
        features: [{ name: 'Login Form', description: 'Login UI' }],
      },
    ],
  },
  {
    name: 'Payment',
    description: 'Payment module',
    processes: [
      {
        name: 'Checkout',
        description: 'Checkout process',
        features: [{ name: 'Cart', description: 'Cart management' }],
      },
    ],
  },
]

describe('localRetrieve', () => {
  it('returns null for non-existent module', () => {
    const result = localRetrieve('NonExistent', mockModules)
    expect(result).toBeNull()
  })

  it('returns target module with full content', () => {
    const result = localRetrieve('Auth', mockModules)
    expect(result).not.toBeNull()
    expect(result!.targetModule.name).toBe('Auth')
    expect(result!.targetModule.description).toBe('Authentication module')
  })

  it('includes neighbor summaries', () => {
    const result = localRetrieve('Auth', mockModules)
    expect(result!.neighborSummaries.length).toBe(1)
    expect(result!.neighborSummaries[0].title).toBe('Payment')
  })

  it('returns token estimate', () => {
    const result = localRetrieve('Auth', mockModules)
    expect(result!.tokenEstimate).toBeGreaterThan(0)
  })

  it('uses community summary when available', () => {
    const summaries = [
      { id: 's1', graphId: '', level: 1, nodeIds: [], title: 'Auth 业务域', summary: 'Auth summary', keyFindings: [] },
    ]
    const result = localRetrieve('Auth', mockModules, summaries)
    expect(result!.communitySummary).toBe('Auth summary')
  })

  it('handles single module', () => {
    const result = localRetrieve('Auth', [mockModules[0]])
    expect(result).not.toBeNull()
    expect(result!.neighborSummaries.length).toBe(0)
  })
})
