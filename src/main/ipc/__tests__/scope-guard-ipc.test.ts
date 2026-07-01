import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerScopeGuardHandlers } from '../scope-guard'
import type { ScopeGuard } from '../../scope-guard'
import type { AgentManager } from '../../agent/agent-manager'
import type { TypedHandle } from '../utils'

function makeMockScopeGuard(): ScopeGuard {
  return {
    rollbackFile: vi.fn().mockResolvedValue(undefined),
    commitChanges: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
  } as unknown as ScopeGuard
}

function makeMockAgentManager(sandbox: unknown = { id: 'sb-1' }): AgentManager {
  return {
    getSandbox: vi.fn().mockReturnValue(sandbox),
  } as unknown as AgentManager
}

describe('registerScopeGuardHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>
  let scopeGuard: ScopeGuard
  let agentManager: AgentManager

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    scopeGuard = makeMockScopeGuard()
    agentManager = makeMockAgentManager()
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerScopeGuardHandlers(scopeGuard, agentManager, typedHandle)
  })

  it('registers all handlers', () => {
    expect(handlers['scopeGuard:rollbackFile']).toBeDefined()
    expect(handlers['scopeGuard:commitSession']).toBeDefined()
    expect(handlers['scopeGuard:rollbackSession']).toBeDefined()
  })

  it('rollbackFile calls scopeGuard.rollbackFile', async () => {
    await handlers['scopeGuard:rollbackFile']({}, 'sess-1', 'src/file.ts')
    expect(scopeGuard.rollbackFile).toHaveBeenCalledWith({ id: 'sb-1' }, 'src/file.ts')
  })

  it('commitSession calls scopeGuard.commitChanges', async () => {
    await handlers['scopeGuard:commitSession']({}, 'sess-1')
    expect(scopeGuard.commitChanges).toHaveBeenCalledWith({ id: 'sb-1' })
  })

  it('rollbackSession calls scopeGuard.rollback', async () => {
    await handlers['scopeGuard:rollbackSession']({}, 'sess-1')
    expect(scopeGuard.rollback).toHaveBeenCalledWith({ id: 'sb-1' })
  })

  it('throws when no sandbox found', async () => {
    const noSandboxManager = makeMockAgentManager(null)
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerScopeGuardHandlers(scopeGuard, noSandboxManager, typedHandle)

    await expect(handlers['scopeGuard:rollbackFile']({}, 'sess-1', 'file.ts')).rejects.toThrow()
  })
})
