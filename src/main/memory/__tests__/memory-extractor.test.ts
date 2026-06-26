import { describe, it, expect } from 'vitest'
import { MemoryExtractor } from '../memory-extractor'
import type { AgentOutput } from '@shared/types'

describe('MemoryExtractor', () => {
  const extractor = new MemoryExtractor()

  it('returns empty array for empty outputs', () => {
    const items = extractor.extract('s1', [], { adapterName: 'claude-code' })
    expect(items).toEqual([])
  })

  it('returns empty array for poisoned outputs', () => {
    const outputs: AgentOutput[] = [{ type: 'stdout', data: 'max tokens reached', timestamp: 1 }]
    const items = extractor.extract('s1', outputs, { adapterName: 'claude-code' })
    expect(items).toEqual([])
  })

  it('extracts file changes as fix memory', () => {
    const outputs: AgentOutput[] = [
      { type: 'file_change', data: 'content', timestamp: 1, filePath: 'src/auth.ts', changeType: 'modify' },
      { type: 'stdout', data: 'Implemented login flow', timestamp: 2 },
    ]
    const items = extractor.extract('s1', outputs, { adapterName: 'claude-code', commandType: 'implement' })
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].kind).toBe('fix')
    expect(items[0].files_modified).toContain('src/auth.ts')
  })

  it('extracts refactor file changes as pattern memory', () => {
    const outputs: AgentOutput[] = [
      { type: 'file_change', data: 'content', timestamp: 1, filePath: 'src/utils.ts', changeType: 'modify' },
      { type: 'stdout', data: 'Refactored utilities', timestamp: 2 },
    ]
    const items = extractor.extract('s1', outputs, { adapterName: 'claude-code', commandType: 'refactor' })
    expect(items[0].kind).toBe('pattern')
  })

  it('extracts error memory when errors present', () => {
    const outputs: AgentOutput[] = [
      { type: 'stdout', data: 'Something went wrong\nError: permission denied on src/file.ts', timestamp: 1 },
    ]
    const items = extractor.extract('s1', outputs, { adapterName: 'claude-code' })
    const fixItem = items.find((i) => i.kind === 'fix')
    expect(fixItem).toBeDefined()
    expect(fixItem!.narrative).toContain('permission denied')
  })

  it('extracts test results as investigation memory', () => {
    const outputs: AgentOutput[] = [
      { type: 'stdout', data: 'Tests: 5 passed, 2 failed, 7 total', timestamp: 1 },
    ]
    const items = extractor.extract('s1', outputs, { adapterName: 'claude-code', commandType: 'add_test' })
    const testItem = items.find((i) => i.kind === 'investigation')
    expect(testItem).toBeDefined()
    expect(testItem!.title).toContain('5/7')
  })

  it('classifies empty output as empty', () => {
    const health = extractor.classifyOutput([])
    expect(health).toBe('empty')
  })

  it('classifies truncation by trailing ellipsis', () => {
    const outputs: AgentOutput[] = [{ type: 'stdout', data: 'some output...', timestamp: 1 }]
    const health = extractor.classifyOutput(outputs)
    expect(health).toBe('truncated')
  })

  it('classifies valid output', () => {
    const outputs: AgentOutput[] = [{ type: 'stdout', data: 'Completed successfully.', timestamp: 1 }]
    const health = extractor.classifyOutput(outputs)
    expect(health).toBe('valid')
  })
})
