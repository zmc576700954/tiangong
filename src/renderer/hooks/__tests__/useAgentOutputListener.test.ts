import { describe, it, expect } from 'vitest'
import { classifyRiskLevel } from '../useAgentOutputListener'
import type { AgentOutput } from '@shared/types'

describe('classifyRiskLevel', () => {
  // ---- High risk: file deletion ----

  it('returns high for file deletion', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '',
      timestamp: Date.now(),
      filePath: '/src/utils.ts',
      changeType: 'delete',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('high')
    expect(reason).toBe('File deletion: /src/utils.ts')
  })

  // ---- Medium risk: config file modification ----

  it('returns medium for .env file modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'KEY=val',
      timestamp: Date.now(),
      filePath: '/.env',
      changeType: 'modify',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('medium')
    expect(reason).toBe('Config file modification: /.env')
  })

  it('returns medium for tsconfig.json modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '{}',
      timestamp: Date.now(),
      filePath: '/tsconfig.json',
      changeType: 'modify',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('medium')
    expect(reason).toBe('Config file modification: /tsconfig.json')
  })

  it('returns medium for vite.config.ts modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'export default {}',
      timestamp: Date.now(),
      filePath: '/vite.config.ts',
      changeType: 'modify',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('medium')
    expect(reason).toBe('Config file modification: /vite.config.ts')
  })

  it('returns medium for .prettierrc modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '{}',
      timestamp: Date.now(),
      filePath: '/.prettierrc',
      changeType: 'modify',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('medium')
    expect(reason).toBe('Config file modification: /.prettierrc')
  })

  it('returns medium for jest.config.ts modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'export default {}',
      timestamp: Date.now(),
      filePath: '/jest.config.ts',
      changeType: 'modify',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('medium')
    expect(reason).toBe('Config file modification: /jest.config.ts')
  })

  it('returns medium for .eslintrc modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '{}',
      timestamp: Date.now(),
      filePath: '/.eslintrc',
      changeType: 'modify',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('medium')
    expect(reason).toBe('Config file modification: /.eslintrc')
  })

  // ---- Low risk: everything else ----

  it('returns low for non-file_change output types', () => {
    const output: AgentOutput = { type: 'stdout', data: 'hello', timestamp: Date.now() }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('low')
    expect(reason).toBe('')
  })

  it('returns low for regular source file modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'const x = 1',
      timestamp: Date.now(),
      filePath: '/src/components/Button.tsx',
      changeType: 'modify',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('low')
    expect(reason).toBe('')
  })

  it('returns low for regular source file addition', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'const x = 1',
      timestamp: Date.now(),
      filePath: '/src/utils/helper.ts',
      changeType: 'add',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('low')
    expect(reason).toBe('')
  })

  it('returns low for file with no path', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'content',
      timestamp: Date.now(),
      changeType: 'modify',
    }
    const { level, reason } = classifyRiskLevel(output)
    expect(level).toBe('low')
    expect(reason).toBe('')
  })
})
