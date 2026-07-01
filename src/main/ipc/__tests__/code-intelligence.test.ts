import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vi.hoisted to ensure mocks are available when vi.mock factories run
const { mockQuerySymbols, mockGetRelatedFiles, mockInitTables, mockIndexProject, mockGeneratePlan } = vi.hoisted(() => ({
  mockQuerySymbols: vi.fn().mockResolvedValue([]),
  mockGetRelatedFiles: vi.fn().mockResolvedValue(new Map()),
  mockInitTables: vi.fn().mockResolvedValue(undefined),
  mockIndexProject: vi.fn().mockResolvedValue({ filesIndexed: 5, symbolsFound: 10, importsFound: 3 }),
  mockGeneratePlan: vi.fn().mockReturnValue({
    intent: 'implement',
    steps: ['step1'],
    estimatedComplexity: 'medium',
    requiresNewFiles: false,
    affectedSymbols: [],
  }),
}))

// Mock modules before import
vi.mock('../../code-intelligence/symbol-index', () => {
  class MockSymbolIndex {
    initTables = mockInitTables
    querySymbols = mockQuerySymbols
    getRelatedFiles = mockGetRelatedFiles
  }
  return { SymbolIndex: MockSymbolIndex }
})

vi.mock('../../code-intelligence/project-indexer', () => {
  class MockProjectIndexer {
    indexProject = mockIndexProject
  }
  return { ProjectIndexer: MockProjectIndexer }
})

vi.mock('../../code-intelligence/execution-planner', () => {
  class MockExecutionPlanner {
    generatePlan = mockGeneratePlan
  }
  return { ExecutionPlanner: MockExecutionPlanner }
})

vi.mock('../utils', () => ({
  validateProjectPath: (p: string) => p,
}))

import { registerCodeIntelHandlers, initCodeIntelligence, getSymbolIndex } from '../code-intelligence'
import type { TypedHandle } from '../utils'

describe('registerCodeIntelHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>

  beforeEach(async () => {
    vi.clearAllMocks()
    handlers = {}
    await initCodeIntelligence()
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerCodeIntelHandlers(typedHandle)
  })

  it('registers all handlers', () => {
    expect(handlers['codeIntel:indexProject']).toBeDefined()
    expect(handlers['codeIntel:querySymbols']).toBeDefined()
    expect(handlers['codeIntel:getRelatedFiles']).toBeDefined()
    expect(handlers['codeIntel:generatePlan']).toBeDefined()
  })

  it('initCodeIntelligence initializes symbol index', async () => {
    expect(mockInitTables).toHaveBeenCalled()
  })

  it('getSymbolIndex returns the initialized index', () => {
    const idx = getSymbolIndex()
    expect(idx).toBeDefined()
  })

  it('querySymbols calls symbolIndex.querySymbols', async () => {
    await handlers['codeIntel:querySymbols']({}, 'authenticate', {})
    expect(mockQuerySymbols).toHaveBeenCalledWith('authenticate', {})
  })

  it('generatePlan calls executionPlanner.generatePlan', async () => {
    const result = await handlers['codeIntel:generatePlan']({}, 'add login')
    expect(mockGeneratePlan).toHaveBeenCalledWith('add login')
    expect(result).toEqual({
      intent: 'implement',
      steps: ['step1'],
      estimatedComplexity: 'medium',
      requiresNewFiles: false,
      affectedSymbols: [],
    })
  })

  it('getRelatedFiles returns formatted results', async () => {
    mockGetRelatedFiles.mockResolvedValueOnce(new Map([['src/auth.ts', 1], ['src/user.ts', 2]]))
    const result = await handlers['codeIntel:getRelatedFiles']({}, 'src/auth.ts', 2)
    expect(result).toEqual([
      { filePath: 'src/auth.ts', distance: 1 },
      { filePath: 'src/user.ts', distance: 2 },
    ])
  })
})
