import { describe, it, expect } from 'vitest'
import { PromptAssembler } from '../prompt-assembler'
import type { AgentSessionConfig, SymbolQueryResult } from '@shared/types'
import type { ResolvedCodeContext } from '../smart-context-resolver'

function makeConfig(overrides?: Partial<AgentSessionConfig>): AgentSessionConfig {
  return {
    workingDirectory: '/project',
    nodeTitle: 'Test Node',
    acceptanceCriteria: [],
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    ...overrides,
  }
}

function makeSymbolResult(name: string, overrides?: Partial<SymbolQueryResult>): SymbolQueryResult {
  return {
    symbol: {
      name,
      kind: 'function',
      filePath: 'src/index.ts',
      line: 10,
      signature: `function ${name}()`,
      sourceCode: `function ${name}() { return true; }`,
      jsDoc: '',
      ...overrides,
    } as SymbolQueryResult['symbol'],
    score: 0.95,
    matchedBy: 'name',
    ...overrides,
  } as SymbolQueryResult
}

describe('PromptAssembler', () => {
  const assembler = new PromptAssembler()

  it('assembles basic prompt with scope and command', () => {
    const result = assembler.assemble({
      sessionConfig: makeConfig({ nodeTitle: 'Auth Module' }),
      userCommand: 'Add login',
    })

    expect(result).toContain('# 任务范围')
    expect(result).toContain('## 目标节点: Auth Module')
    expect(result).toContain('# 任务指令')
    expect(result).toContain('Add login')
  })

  it('includes acceptance criteria when present', () => {
    const result = assembler.assemble({
      sessionConfig: makeConfig({
        nodeTitle: 'Auth',
        acceptanceCriteria: ['Handle errors', 'Validate input'],
      }),
      userCommand: 'Do it',
    })

    expect(result).toContain('## 验收标准')
    expect(result).toContain('1. Handle errors')
    expect(result).toContain('2. Validate input')
  })

  it('includes allowed files when present', () => {
    const result = assembler.assemble({
      sessionConfig: makeConfig({
        allowedFiles: ['src/auth.ts', 'src/user.ts'],
      }),
      userCommand: 'Fix bug',
    })

    expect(result).toContain('## 允许修改的文件')
    expect(result).toContain('- src/auth.ts')
    expect(result).toContain('- src/user.ts')
  })

  it('includes forbidden files when present', () => {
    const result = assembler.assemble({
      sessionConfig: makeConfig({
        forbiddenFiles: ['src/legacy.ts'],
      }),
      userCommand: 'Fix bug',
    })

    expect(result).toContain('## 禁止修改的文件')
    expect(result).toContain('- src/legacy.ts')
  })

  it('includes invariant rules when present', () => {
    const result = assembler.assemble({
      sessionConfig: makeConfig({
        invariantRules: ['Do not break API'],
      }),
      userCommand: 'Refactor',
    })

    expect(result).toContain('## 不变规则')
    expect(result).toContain('- Do not break API')
  })

  it('includes code context when provided', () => {
    const context: ResolvedCodeContext = {
      summary: 'Found auth module',
      primarySymbols: [makeSymbolResult('authenticate')],
      relatedSymbols: [makeSymbolResult('validateToken')],
      relatedFiles: [{
        filePath: 'src/types.ts',
        reason: 'import',
        content: 'export interface User { id: string }',
      }],
      importGraph: [{ from: 'src/auth.ts', to: 'src/types.ts' }],
    }

    const result = assembler.assemble({
      sessionConfig: makeConfig(),
      codeContext: context,
      userCommand: 'Fix auth',
    })

    expect(result).toContain('# 代码上下文')
    expect(result).toContain('## 分析摘要')
    expect(result).toContain('Found auth module')
    expect(result).toContain('## 核心代码')
    expect(result).toContain('authenticate')
    expect(result).toContain('## 相关代码')
    expect(result).toContain('validateToken')
    expect(result).toContain('## 相关文件')
    expect(result).toContain('src/types.ts')
    expect(result).toContain('## 文件依赖关系')
    expect(result).toContain('src/auth.ts -> src/types.ts')
  })

  it('formats symbol with full details in primary', () => {
    const context: ResolvedCodeContext = {
      summary: '',
      primarySymbols: [makeSymbolResult('authenticate', {
        signature: 'async function authenticate(): Promise<User>',
        jsDoc: 'Authenticates user',
      })],
      relatedSymbols: [],
      relatedFiles: [],
      importGraph: [],
    }

    const result = assembler.assemble({
      sessionConfig: makeConfig(),
      codeContext: context,
      userCommand: 'Fix',
    })

    expect(result).toContain('### authenticate (function')
    expect(result).toContain('签名: async function authenticate(): Promise<User>')
    expect(result).toContain('注释: Authenticates user')
  })

  it('formats related symbols in compact mode', () => {
    const context: ResolvedCodeContext = {
      summary: '',
      primarySymbols: [],
      relatedSymbols: [makeSymbolResult('helper')],
      relatedFiles: [],
      importGraph: [],
    }

    const result = assembler.assemble({
      sessionConfig: makeConfig(),
      codeContext: context,
      userCommand: 'Fix',
    })

    expect(result).toContain('## 相关代码')
    expect(result).toContain('### helper')
  })

  it('truncates related symbols to 10', () => {
    const symbols = Array.from({ length: 15 }, (_, i) => makeSymbolResult(`fn${i}`))
    const context: ResolvedCodeContext = {
      summary: '',
      primarySymbols: [],
      relatedSymbols: symbols,
      relatedFiles: [],
      importGraph: [],
    }

    const result = assembler.assemble({
      sessionConfig: makeConfig(),
      codeContext: context,
      userCommand: 'Fix',
    })

    expect(result).toContain('fn0')
    expect(result).toContain('fn9')
    expect(result).not.toContain('fn10')
  })

  it('handles empty config gracefully', () => {
    const result = assembler.assemble({
      sessionConfig: makeConfig(),
      userCommand: 'Test',
    })

    expect(result).toContain('# 任务范围')
    expect(result).toContain('# 任务指令')
    expect(result).toContain('Test')
  })
})
