import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerContextHandlers } from '../context-waterline'
import type { ContextWaterline } from '../../memory/context-waterline'
import type { CompactHistoryRepository } from '../../repositories/compact-history-repository'
import type { AgentManager } from '../../agent/agent-manager'
import type { TypedHandle } from '../utils'

function makeMockWaterline(): ContextWaterline {
  return {
    getState: vi.fn().mockResolvedValue({ threadId: 't1', tokenUsage: 100 }),
    onChange: vi.fn(),
  } as unknown as ContextWaterline
}

function makeMockAgentManager(): AgentManager {
  return {
    compactContext: vi.fn().mockResolvedValue({ strategy: 'summary', savedTokens: 50 }),
  } as unknown as AgentManager
}

function makeMockCompactRepo(): CompactHistoryRepository {
  return {
    listByThread: vi.fn().mockResolvedValue([]),
  } as unknown as CompactHistoryRepository
}

describe('registerContextHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>
  let waterline: ContextWaterline
  let agentManager: AgentManager

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    waterline = makeMockWaterline()
    agentManager = makeMockAgentManager()
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerContextHandlers(waterline, agentManager, typedHandle)
  })

  it('registers all handlers', () => {
    expect(handlers['context:getWaterline']).toBeDefined()
    expect(handlers['context:listHistory']).toBeDefined()
    expect(handlers['context:compactNow']).toBeDefined()
  })

  it('getWaterline calls waterline.getState', async () => {
    const result = await handlers['context:getWaterline']({}, 'thread-1')
    expect(waterline.getState).toHaveBeenCalledWith('thread-1')
    expect(result).toEqual({ threadId: 't1', tokenUsage: 100 })
  })

  it('listHistory returns empty when no repo', async () => {
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerContextHandlers(waterline, agentManager, typedHandle)
    const result = await handlers['context:listHistory']({}, 'thread-1')
    expect(result).toEqual([])
  })

  it('listHistory calls repo.listByThread when repo provided', async () => {
    const repo = makeMockCompactRepo()
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerContextHandlers(waterline, agentManager, typedHandle, repo)
    await handlers['context:listHistory']({}, 'thread-1')
    expect(repo.listByThread).toHaveBeenCalledWith('thread-1')
  })

  it('compactNow calls agentManager.compactContext', async () => {
    await handlers['context:compactNow']({}, 'sess-1', 'summary')
    expect(agentManager.compactContext).toHaveBeenCalledWith('sess-1', 'summary', { reason: 'manual' })
  })

  it('compactNow handles undefined strategy', async () => {
    await handlers['context:compactNow']({}, 'sess-1', undefined)
    expect(agentManager.compactContext).toHaveBeenCalledWith('sess-1', undefined, { reason: 'manual' })
  })

  it('compactNow ignores invalid strategy', async () => {
    await handlers['context:compactNow']({}, 'sess-1', 'invalid')
    expect(agentManager.compactContext).toHaveBeenCalledWith('sess-1', undefined, { reason: 'manual' })
  })

  it('registers onChange handler when getMainWindow provided', () => {
    const getMainWindow = vi.fn()
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerContextHandlers(waterline, agentManager, typedHandle, undefined, getMainWindow)
    expect(waterline.onChange).toHaveBeenCalled()
  })
})
