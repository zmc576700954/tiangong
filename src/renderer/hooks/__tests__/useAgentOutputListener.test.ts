import { describe, it, expect } from 'vitest'
import { isHighRiskOperation, classifyRisk } from '../useAgentOutputListener'
import type { AgentOutput } from '@shared/types'

describe('isHighRiskOperation', () => {
  it('returns false for non-file_change output types', () => {
    const output: AgentOutput = { type: 'stdout', data: 'hello', timestamp: Date.now() }
    expect(isHighRiskOperation(output)).toBe(false)
  })

  it('returns true for file deletion', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '',
      timestamp: Date.now(),
      filePath: '/src/utils.ts',
      changeType: 'delete',
    }
    expect(isHighRiskOperation(output)).toBe(true)
  })

  it('returns true for .env file modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'KEY=val',
      timestamp: Date.now(),
      filePath: '/.env',
      changeType: 'modify',
    }
    expect(isHighRiskOperation(output)).toBe(true)
  })

  it('returns true for .env.production file modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'KEY=val',
      timestamp: Date.now(),
      filePath: '/.env.production',
      changeType: 'modify',
    }
    expect(isHighRiskOperation(output)).toBe(true)
  })

  it('returns true for tsconfig.json modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '{}',
      timestamp: Date.now(),
      filePath: '/tsconfig.json',
      changeType: 'modify',
    }
    expect(isHighRiskOperation(output)).toBe(true)
  })

  it('returns true for package.json modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '{}',
      timestamp: Date.now(),
      filePath: '/package.json',
      changeType: 'modify',
    }
    expect(isHighRiskOperation(output)).toBe(true)
  })

  it('returns true for vite.config.ts modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'export default {}',
      timestamp: Date.now(),
      filePath: '/vite.config.ts',
      changeType: 'modify',
    }
    expect(isHighRiskOperation(output)).toBe(true)
  })

  it('returns true for Dockerfile modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'FROM node:18',
      timestamp: Date.now(),
      filePath: '/Dockerfile',
      changeType: 'modify',
    }
    expect(isHighRiskOperation(output)).toBe(true)
  })

  it('returns false for regular source file modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'const x = 1',
      timestamp: Date.now(),
      filePath: '/src/components/Button.tsx',
      changeType: 'modify',
    }
    expect(isHighRiskOperation(output)).toBe(false)
  })

  it('returns false for regular source file addition', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: 'const x = 1',
      timestamp: Date.now(),
      filePath: '/src/utils/helper.ts',
      changeType: 'add',
    }
    expect(isHighRiskOperation(output)).toBe(false)
  })
})

describe('classifyRisk', () => {
  it('returns empty string for non-file_change output', () => {
    const output: AgentOutput = { type: 'stdout', data: 'hello', timestamp: Date.now() }
    expect(classifyRisk(output)).toBe('')
  })

  it('returns deletion reason for file deletion', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '',
      timestamp: Date.now(),
      filePath: '/src/old.ts',
      changeType: 'delete',
    }
    expect(classifyRisk(output)).toBe('File deletion: /src/old.ts')
  })

  it('returns config reason for config file modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '{}',
      timestamp: Date.now(),
      filePath: '/.env',
      changeType: 'modify',
    }
    expect(classifyRisk(output)).toBe('Config file modification: /.env')
  })

  it('returns config reason for package.json modification', () => {
    const output: AgentOutput = {
      type: 'file_change',
      data: '{}',
      timestamp: Date.now(),
      filePath: '/package.json',
      changeType: 'modify',
    }
    expect(classifyRisk(output)).toBe('Config file modification: /package.json')
  })
})
