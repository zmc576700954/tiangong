/**
 * ScopeGuard IPC Handlers
 * 文件回滚和提交操作
 */

import type { ScopeGuard } from '../scope-guard'
import type { AgentManager } from '../agent/agent-manager'
import type { TypedHandle } from './utils'
import { ScopeGuardError, ErrorCode } from '../errors'

export function registerScopeGuardHandlers(
  scopeGuard: ScopeGuard,
  agentManager: AgentManager,
  typedHandle: TypedHandle,
): void {
  function getSandboxOrThrow(sessionId: string) {
    const sandbox = agentManager.getSandbox(sessionId)
    if (!sandbox) {
      throw new ScopeGuardError(`No sandbox found for session ${sessionId}`, ErrorCode.SCOPE_OUT_OF_BOUNDS)
    }
    return sandbox
  }

  typedHandle('scopeGuard:rollbackFile', async (_, sessionId: string, filePath: string) => {
    const sandbox = getSandboxOrThrow(sessionId)
    return scopeGuard.rollbackFile(sandbox, filePath)
  })

  typedHandle('scopeGuard:commitSession', async (_, sessionId: string) => {
    const sandbox = getSandboxOrThrow(sessionId)
    return scopeGuard.commitChanges(sandbox)
  })

  typedHandle('scopeGuard:rollbackSession', async (_, sessionId: string) => {
    const sandbox = getSandboxOrThrow(sessionId)
    await scopeGuard.rollback(sandbox)
  })
}
