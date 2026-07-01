import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSubagentHandlers } from '../subagent'
import type { SubagentManager } from '../../agent/subagent-manager'
import type { SubagentInvocationRepository } from '../../repositories/subagent-invocation-repository'
import type { TypedHandle } from '../utils'

function makeMockManager(): SubagentManager {
  return {
    listTypes: vi.fn().mockResolvedValue([{ type: 'explore', description: 'Explore codebase' }]),
    cancel: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn(),
  } as unknown as SubagentManager
}

function makeMockRepo(): SubagentInvocationRepository {
  return {
    listByParent: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  } as unknown as SubagentInvocationRepository
}

describe('registerSubagentHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>
  let manager: SubagentManager
  let repo: SubagentInvocationRepository

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    manager = makeMockManager()
    repo = makeMockRepo()
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerSubagentHandlers(manager, repo, typedHandle)
  })

  it('registers subagent:listTypes handler', () => {
    expect(handlers['subagent:listTypes']).toBeDefined()
  })

  it('listTypes returns types', async () => {
    const result = await handlers['subagent:listTypes']({})
    expect(result).toEqual([{ type: 'explore', description: 'Explore codebase' }])
  })

  it('listInvocations calls repo.listByParent', async () => {
    await handlers['subagent:listInvocations']({}, 'parent-1')
    expect(repo.listByParent).toHaveBeenCalledWith('parent-1')
  })

  it('cancel calls manager.cancel', async () => {
    await handlers['subagent:cancel']({}, 'inv-1')
    expect(manager.cancel).toHaveBeenCalledWith('inv-1')
  })

  it('getResult returns null for non-existent invocation', async () => {
    const result = await handlers['subagent:getResult']({}, 'inv-1')
    expect(result).toBeNull()
  })

  it('getResult returns result for completed invocation', async () => {
    vi.mocked(repo.get).mockResolvedValue({
      id: 'inv-1',
      status: 'completed',
      resultText: 'done',
      resultFiles: ['file.ts'],
      tokensUsed: 100,
      startedAt: 1000,
      finishedAt: 2000,
    } as any)

    const result = await handlers['subagent:getResult']({}, 'inv-1')
    expect(result).toEqual({
      invocationId: 'inv-1',
      resultText: 'done',
      resultFiles: ['file.ts'],
      tokensUsed: 100,
      durationMs: 1000,
    })
  })

  it('getResult returns null for non-completed invocation', async () => {
    vi.mocked(repo.get).mockResolvedValue({
      id: 'inv-1',
      status: 'running',
    } as any)

    const result = await handlers['subagent:getResult']({}, 'inv-1')
    expect(result).toBeNull()
  })
})
