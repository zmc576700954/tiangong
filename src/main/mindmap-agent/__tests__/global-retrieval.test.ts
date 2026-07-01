import { describe, it, expect } from 'vitest'
import { buildGlobalPrompt } from '../retrieval/global'
import type { MindMapContext } from '../context-collector'

function makeContext(overrides?: Partial<MindMapContext>): MindMapContext {
  return {
    projectName: 'TestProject',
    projectPath: '/test',
    framework: 'Node.js',
    directoryTree: 'test/\n  src/',
    packageJsonSummary: 'name: test',
    readmeContent: '# Test',
    entryPointContent: 'console.log("hi")',
    memory: {
      projectName: 'TestProject',
      preferences: {
        namingStyle: 'business',
        granularity: 'medium',
        maxModules: 6,
        avoidPatterns: ['npm run'],
        businessDomains: [],
        technicalDomains: [],
        refinements: [],
      },
      refinements: [],
      modules: [],
      architecturePattern: '',
      businessDomains: [],
    },
    keyFileSnippets: '[auth] Auth module',
    ...overrides,
  }
}

describe('buildGlobalPrompt', () => {
  it('includes project name and framework', () => {
    const prompt = buildGlobalPrompt(makeContext())
    expect(prompt).toContain('TestProject')
    expect(prompt).toContain('Node.js')
  })

  it('includes directory tree', () => {
    const prompt = buildGlobalPrompt(makeContext())
    expect(prompt).toContain('test/')
    expect(prompt).toContain('src/')
  })

  it('includes package.json summary', () => {
    const prompt = buildGlobalPrompt(makeContext())
    expect(prompt).toContain('name: test')
  })

  it('includes README content', () => {
    const prompt = buildGlobalPrompt(makeContext())
    expect(prompt).toContain('# Test')
  })

  it('includes avoid patterns', () => {
    const prompt = buildGlobalPrompt(makeContext())
    expect(prompt).toContain('npm run')
  })

  it('includes business domains when present', () => {
    const ctx = makeContext({
      memory: {
        ...makeContext().memory,
        businessDomains: ['用户管理', '订单系统'],
        preferences: { ...makeContext().memory.preferences, businessDomains: ['用户管理', '订单系统'] },
      },
    })
    const prompt = buildGlobalPrompt(ctx)
    expect(prompt).toContain('用户管理')
    expect(prompt).toContain('订单系统')
  })

  it('includes recommended domains', () => {
    const prompt = buildGlobalPrompt(makeContext(), ['Auth', 'Payment'])
    expect(prompt).toContain('Auth')
    expect(prompt).toContain('Payment')
  })

  it('includes output JSON format instruction', () => {
    const prompt = buildGlobalPrompt(makeContext())
    expect(prompt).toContain('JSON')
    expect(prompt).toContain('modules')
  })

  it('includes naming style instruction', () => {
    const prompt = buildGlobalPrompt(makeContext())
    expect(prompt).toContain('业务语言')
  })
})
