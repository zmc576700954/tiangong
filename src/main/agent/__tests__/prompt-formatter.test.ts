/**
 * PromptFormatter 单元测试
 *
 * 覆盖：
 * - formatMemoryContext: 有内容时生成 Markdown、空记忆返回 undefined、preferences 渲染
 * - formatSessionHistoryContext: 无记忆返回 undefined、跨适配器记忆注入、调用 memoryStore.toCompactSummary
 * - formatCodeContext: 摘要/主符号/相关符号/相关文件/importGraph 渲染
 * - getOptimalPromptBudget: 数据不足用默认值、success 平均值 * 1.2、上下限钳位
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PromptFormatter } from '../prompt-formatter'
import type { MemoryStore } from '../../memory'
import type { ProjectMemory, SymbolQueryResult } from '@shared/types'
import type { ResolvedCodeContext } from '../../code-intelligence/smart-context-resolver'

function makeMemoryStore(overrides?: Partial<MemoryStore>): MemoryStore {
  return {
    getRecent: vi.fn(() => []),
    getCrossAdapter: vi.fn(() => []),
    toCompactSummary: vi.fn((item: any) => `summary:${item.id}`),
    ...overrides,
  } as unknown as MemoryStore
}

function makeMemory(overrides?: Partial<ProjectMemory>): ProjectMemory {
  return {
    businessDomains: [],
    architecturePattern: '',
    coreUserFlows: [],
    techConstraints: [],
    preferences: undefined,
    ...overrides,
  } as ProjectMemory
}

function makeSymbolResult(name: string, score: number, matchedBy = 'name'): SymbolQueryResult {
  return {
    symbol: {
      name,
      kind: 'function',
      filePath: `/src/${name}.ts`,
      line: 10,
      signature: `${name}(): void`,
      sourceCode: `function ${name}() {}`,
    },
    score,
    matchedBy,
  } as SymbolQueryResult
}

function makeRelatedFile(path: string, reason: string, content = 'export const x = 1'): {
  filePath: string
  distance: number
  reason: string
  content: string
} {
  return { filePath: path, distance: 1, reason, content }
}

function makeImportEdge(from: string, to: string): { from: string; to: string } {
  return { from, to }
}

function makeCodeContext(overrides?: Partial<ResolvedCodeContext>): ResolvedCodeContext {
  return {
    summary: '',
    primarySymbols: [],
    relatedSymbols: [],
    relatedFiles: [],
    importGraph: [],
    ...overrides,
  } as ResolvedCodeContext
}

describe('PromptFormatter', () => {
  let promptOutcomeLog: Array<{
    commandType: string
    promptTokenEstimate: number
    contextCount: number
    outcome: 'success' | 'failure'
    duration: number
  }>

  beforeEach(() => {
    promptOutcomeLog = []
  })

  describe('formatMemoryContext', () => {
    it('returns undefined when the memory has no substantive content', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const mem = makeMemory()
      expect(f.formatMemoryContext(mem)).toBeUndefined()
    })

    it('formats businessDomains, architecturePattern, coreUserFlows, techConstraints', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const mem = makeMemory({
        businessDomains: ['订单', '支付'],
        architecturePattern: '分层架构',
        coreUserFlows: ['下单', '支付'],
        techConstraints: ['TypeScript'],
      })
      const out = f.formatMemoryContext(mem)!
      expect(out).toContain('# 项目记忆')
      expect(out).toContain('## 业务域')
      expect(out).toContain('订单, 支付')
      expect(out).toContain('## 架构模式')
      expect(out).toContain('分层架构')
      expect(out).toContain('## 核心用户流程')
      expect(out).toContain('- 下单')
      expect(out).toContain('## 技术约束')
      expect(out).toContain('- TypeScript')
    })

    it('renders preferences when present, including avoidPatterns when non-empty', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const mem = makeMemory({
        businessDomains: ['X'],
        preferences: {
          namingStyle: 'business',
          granularity: 'medium',
          maxModules: 10,
          avoidPatterns: ['god-object', 'magic-numbers'],
        },
      })
      const out = f.formatMemoryContext(mem)!
      expect(out).toContain('## 用户偏好')
      expect(out).toContain('命名风格: business')
      expect(out).toContain('避免模式: god-object, magic-numbers')
    })

    it('omits avoidPatterns line when preferences.avoidPatterns is empty', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const mem = makeMemory({
        businessDomains: ['X'],
        preferences: {
          namingStyle: 'business',
          granularity: 'medium',
          maxModules: 10,
          avoidPatterns: [],
        },
      })
      const out = f.formatMemoryContext(mem)!
      expect(out).toContain('## 用户偏好')
      expect(out).not.toContain('避免模式:')
    })

    it('returns a string when only architecturePattern is set', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const out = f.formatMemoryContext(makeMemory({ architecturePattern: '事件驱动' }))
      expect(out).toContain('## 架构模式')
      expect(out).toContain('事件驱动')
    })
  })

  describe('formatSessionHistoryContext', () => {
    it('returns undefined when there are no recent memory items', async () => {
      const ms = makeMemoryStore({
        getRecent: vi.fn(() => []),
        getCrossAdapter: vi.fn(() => []),
      })
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const out = await f.formatSessionHistoryContext('/project')
      expect(out).toBeUndefined()
      expect(ms.getRecent).toHaveBeenCalledWith({
        projectId: '/project',
        nodeId: undefined,
        limit: 5,
      })
    })

    it('formats recent memories via toCompactSummary', async () => {
      const ms = makeMemoryStore({
        getRecent: vi.fn(() => [{ id: 'm1' }, { id: 'm2' }] as any),
        getCrossAdapter: vi.fn(() => []),
      })
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const out = await f.formatSessionHistoryContext('/project', 'node_1')
      expect(out).toContain('# 会话历史记忆')
      expect(out).toContain('summary:m1')
      expect(out).toContain('summary:m2')
      expect(ms.toCompactSummary).toHaveBeenCalledTimes(2)
    })

    it('appends cross-adapter discoveries when getCrossAdapter returns items', async () => {
      const ms = makeMemoryStore({
        getRecent: vi.fn(() => [{ id: 'r1' }] as any),
        getCrossAdapter: vi.fn(() => [{ id: 'c1', adapter_name: 'codex' }] as any),
      })
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const out = await f.formatSessionHistoryContext('/project')
      expect(out).toContain('## 其他 Agent 的发现')
      expect(out).toContain('[codex] summary:c1')
    })

    it('passes nodeId and currentSessionId through to the store', async () => {
      const ms = makeMemoryStore({
        getRecent: vi.fn(() => [{ id: 'r1' }] as any),
      })
      const f = new PromptFormatter(ms, promptOutcomeLog)
      await f.formatSessionHistoryContext('/project', 'node_42', 's1')
      expect(ms.getRecent).toHaveBeenCalledWith({
        projectId: '/project',
        nodeId: 'node_42',
        limit: 5,
      })
    })
  })

  describe('formatCodeContext', () => {
    it('renders summary when present', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const out = f.formatCodeContext(makeCodeContext({ summary: '核心模块是 X' }))
      expect(out).toContain('# 代码上下文')
      expect(out).toContain('## 分析摘要')
      expect(out).toContain('核心模块是 X')
    })

    it('renders primarySymbols with score and matchedBy, including source code block', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const ctx = makeCodeContext({
        primarySymbols: [makeSymbolResult('login', 0.92, 'name')],
      })
      const out = f.formatCodeContext(ctx)
      expect(out).toContain('## 核心代码')
      expect(out).toContain('### login')
      expect(out).toContain('匹配度: 92%')
      expect(out).toContain('name')
      expect(out).toContain('- 签名: login(): void')
      expect(out).toContain('/src/login.ts:10')
      expect(out).toContain('```typescript')
      expect(out).toContain('function login() {}')
    })

    it('caps relatedSymbols output to 10 entries', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const ctx = makeCodeContext({
        relatedSymbols: Array.from({ length: 15 }, (_, i) =>
          makeSymbolResult(`sym${i}`, 0.5 + i * 0.01),
        ),
      })
      const out = f.formatCodeContext(ctx)
      const matches = out.match(/^- sym\d+ /gm) ?? []
      expect(matches.length).toBe(10)
    })

    it('renders relatedFiles with reason and content capped at 3000 chars', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const longContent = 'x'.repeat(5000)
      const ctx = makeCodeContext({
        relatedFiles: [makeRelatedFile('/src/big.ts', 'entrypoint', longContent)],
      })
      const out = f.formatCodeContext(ctx)
      expect(out).toContain('## 相关文件')
      expect(out).toContain('### /src/big.ts (entrypoint)')
      // Truncation: content.slice(0, 3000) — verify only the truncated portion was emitted,
      // not the full 5000-char body.
      expect(out).not.toContain('x'.repeat(3001))
      expect(out).toContain('x'.repeat(3000))
    })

    it('renders importGraph edges as "from -> to"', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const ctx = makeCodeContext({
        importGraph: [makeImportEdge('/a.ts', '/b.ts'), makeImportEdge('/b.ts', '/c.ts')],
      })
      const out = f.formatCodeContext(ctx)
      expect(out).toContain('## 文件依赖关系')
      expect(out).toContain('/a.ts -> /b.ts')
      expect(out).toContain('/b.ts -> /c.ts')
    })

    it('returns just the header when context has no fields populated', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      const out = f.formatCodeContext(makeCodeContext())
      expect(out).toBe('# 代码上下文')
    })
  })

  describe('getOptimalPromptBudget', () => {
    it('returns default budget for known commandType when log is empty', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      expect(f.getOptimalPromptBudget('fix_bug')).toBe(6000)
      expect(f.getOptimalPromptBudget('implement')).toBe(12000)
    })

    it('returns 8000 default for unknown commandType', () => {
      const ms = makeMemoryStore()
      const f = new PromptFormatter(ms, promptOutcomeLog)
      expect(f.getOptimalPromptBudget('unknown_type')).toBe(8000)
    })

    it('still uses default when fewer than 5 entries exist', () => {
      const ms = makeMemoryStore()
      promptOutcomeLog.push(
        { commandType: 'fix_bug', promptTokenEstimate: 1000, contextCount: 1, outcome: 'success', duration: 100 },
        { commandType: 'fix_bug', promptTokenEstimate: 1000, contextCount: 1, outcome: 'success', duration: 100 },
        { commandType: 'fix_bug', promptTokenEstimate: 1000, contextCount: 1, outcome: 'success', duration: 100 },
      )
      const f = new PromptFormatter(ms, promptOutcomeLog)
      expect(f.getOptimalPromptBudget('fix_bug')).toBe(6000)
    })

    it('returns avg(success) * 1.2 clamped to [4000, 16000]', () => {
      const ms = makeMemoryStore()
      // 6 entries with avg 8000 → expected 9600
      for (let i = 0; i < 6; i++) {
        promptOutcomeLog.push({
          commandType: 'implement',
          promptTokenEstimate: 8000,
          contextCount: 1,
          outcome: 'success',
          duration: 100,
        })
      }
      const f = new PromptFormatter(ms, promptOutcomeLog)
      expect(f.getOptimalPromptBudget('implement')).toBe(9600)
    })

    it('clamps the upper bound to 16000', () => {
      const ms = makeMemoryStore()
      // avg = 20000 → expected clamp to 16000
      for (let i = 0; i < 6; i++) {
        promptOutcomeLog.push({
          commandType: 'implement',
          promptTokenEstimate: 20000,
          contextCount: 1,
          outcome: 'success',
          duration: 100,
        })
      }
      const f = new PromptFormatter(ms, promptOutcomeLog)
      expect(f.getOptimalPromptBudget('implement')).toBe(16000)
    })

    it('clamps the lower bound to 4000', () => {
      const ms = makeMemoryStore()
      // avg = 1000 → expected clamp to 4000
      for (let i = 0; i < 6; i++) {
        promptOutcomeLog.push({
          commandType: 'fix_bug',
          promptTokenEstimate: 1000,
          contextCount: 1,
          outcome: 'success',
          duration: 100,
        })
      }
      const f = new PromptFormatter(ms, promptOutcomeLog)
      expect(f.getOptimalPromptBudget('fix_bug')).toBe(4000)
    })

    it('ignores failure entries when computing the average', () => {
      const ms = makeMemoryStore()
      for (let i = 0; i < 5; i++) {
        promptOutcomeLog.push({
          commandType: 'fix_bug',
          promptTokenEstimate: 10000,
          contextCount: 1,
          outcome: 'failure',
          duration: 100,
        })
      }
      promptOutcomeLog.push({
        commandType: 'fix_bug',
        promptTokenEstimate: 5000,
        contextCount: 1,
        outcome: 'success',
        duration: 100,
      })
      const f = new PromptFormatter(ms, promptOutcomeLog)
      // Only 1 success → avg=5000, *1.2=6000
      expect(f.getOptimalPromptBudget('fix_bug')).toBe(6000)
    })

    it('returns default when all relevant entries are failures', () => {
      const ms = makeMemoryStore()
      for (let i = 0; i < 6; i++) {
        promptOutcomeLog.push({
          commandType: 'fix_bug',
          promptTokenEstimate: 5000,
          contextCount: 1,
          outcome: 'failure',
          duration: 100,
        })
      }
      const f = new PromptFormatter(ms, promptOutcomeLog)
      expect(f.getOptimalPromptBudget('fix_bug')).toBe(6000)
    })
  })
})