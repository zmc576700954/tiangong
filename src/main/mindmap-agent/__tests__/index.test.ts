/**
 * MindMapAgent 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MindMapAgent } from '../index'
import { AgentError, ErrorCode } from '../../errors'
import type { ScanModule, ProjectMemory } from '@shared/types'

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock('../claude-runner', () => ({
  runClaude: vi.fn(),
  extractJson: vi.fn(),
}))

vi.mock('../context-collector', () => ({
  collectContext: vi.fn(),
}))

vi.mock('../memory', () => ({
  readMemory: vi.fn(),
  updateDomains: vi.fn().mockResolvedValue(undefined),
  addRefinement: vi.fn().mockResolvedValue(undefined),
  recommendInitialDomains: vi.fn().mockResolvedValue([]),
  contributeToGlobalKnowledge: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../schema-validator', () => ({
  validateModules: vi.fn(),
  validateEnrichment: vi.fn(),
}))

vi.mock('../complexity-classifier', () => ({
  classifyComplexity: vi.fn(),
}))

describe('MindMapAgent', () => {
  let agent: MindMapAgent
  let runClaude: any
  let extractJson: any
  let collectContext: any
  let readMemory: any
  let updateDomains: any
  let validateModules: any
  let validateEnrichment: any

  const projectPath = '/tmp/test-project'

  beforeEach(async () => {
    agent = new MindMapAgent(projectPath)

    const runnerModule = await import('../claude-runner')
    runClaude = runnerModule.runClaude
    extractJson = runnerModule.extractJson

    const contextModule = await import('../context-collector')
    collectContext = contextModule.collectContext

    const memoryModule = await import('../memory')
    readMemory = memoryModule.readMemory
    updateDomains = memoryModule.updateDomains

    const validatorModule = await import('../schema-validator')
    validateModules = validatorModule.validateModules
    validateEnrichment = validatorModule.validateEnrichment

    vi.clearAllMocks()
  })

  describe('generateModule', () => {
    it('propagates AgentError instead of returning null', async () => {
      collectContext.mockResolvedValue({ directoryTree: 'src/' })
      readMemory.mockResolvedValue(createDefaultMemory())
      runClaude.mockRejectedValue(new AgentError('claude failed', ErrorCode.AGENT_PROCESS_ERROR))

      await expect(agent.generateModule('module-a')).rejects.toThrow(AgentError)
    })

    it('throws AgentError when no module is returned', async () => {
      collectContext.mockResolvedValue({ directoryTree: 'src/' })
      readMemory.mockResolvedValue(createDefaultMemory())
      runClaude.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: '{}' })
      extractJson.mockReturnValue({})
      validateModules.mockReturnValue([])

      await expect(agent.generateModule('module-a')).rejects.toThrow('未返回有效模块')
    })
  })

  describe('refine', () => {
    it('throws AgentError when validation returns empty/null', async () => {
      readMemory.mockResolvedValue(createDefaultMemory())
      runClaude.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: '{}' })
      extractJson.mockReturnValue({})
      validateModules.mockReturnValue([])
      validateEnrichment.mockReturnValue(null)

      await expect(agent.refine('project', 'target-1', 'feedback')).rejects.toThrow('未返回有效精炼结果')
    })
  })

  describe('parseGenerationResult', () => {
    it('returns modules and updates domains with a meaningful pattern', async () => {
      const modules: ScanModule[] = [createValidModule()]
      extractJson.mockReturnValue({ modules })
      validateModules.mockReturnValue(modules)

      const result = agent.parseGenerationResult('{"modules":[]}')

      expect(result).toEqual(modules)
      expect(updateDomains).toHaveBeenCalledWith(
        projectPath,
        modules.map((m) => m.name),
        expect.stringContaining('1 个业务模块'),
      )
    })

    it('does not call updateDomains for empty modules', async () => {
      extractJson.mockReturnValue({ modules: [] })
      validateModules.mockReturnValue([])

      agent.parseGenerationResult('{"modules":[]}')

      expect(updateDomains).not.toHaveBeenCalled()
    })

    it('propagates AgentError on parse/validation failure', async () => {
      extractJson.mockImplementation(() => {
        throw new Error('invalid json')
      })

      expect(() => agent.parseGenerationResult('bad')).toThrow(AgentError)
    })
  })
})

function createDefaultMemory(): ProjectMemory {
  return {
    projectId: '',
    projectPath: '/tmp/test-project',
    businessDomains: [],
    architecturePattern: '',
    coreUserFlows: [],
    techConstraints: [],
    refinements: [],
    preferences: {
      granularity: 'medium',
      namingStyle: 'business',
      maxModules: 6,
      avoidPatterns: [],
    },
    updatedAt: new Date().toISOString(),
  }
}

function createValidModule(): ScanModule {
  return {
    name: 'Auth',
    description: 'Authentication module',
    processes: [
      {
        name: 'Login',
        description: 'User login flow',
        features: [
          { name: 'Sign in', description: '', type: 'feature' },
        ],
      },
    ],
  }
}
