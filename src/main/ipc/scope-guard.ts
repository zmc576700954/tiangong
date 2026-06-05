/**
 * ScopeGuard IPC Handlers
 * 文件回滚和提交操作
 */

import type { ScopeGuard } from '../scope-guard'
import type { AgentManager } from '../agent/agent-manager'
import type { TypedHandle } from './utils'

export function registerScopeGuardHandlers(
  scopeGuard: ScopeGuard,
  agentManager: AgentManager,
  typedHandle: TypedHandle,
): void {
  typedHandle('scopeGuard:rollbackFile', async (_, sessionId: string, filePath: string) => {
    const sandbox = agentManager.getSandbox(sessionId)
    if (!sandbox) {
      throw new Error(`No sandbox found for session ${sessionId}`)
    }
    return scopeGuard.rollbackFile(sandbox, filePath)
  })

  typedHandle('scopeGuard:commitSession', async (_, sessionId: string) => {
    const sandbox = agentManager.getSandbox(sessionId)
    if (!sandbox) {
      throw new Error(`No sandbox found for session ${sessionId}`)
    }
    return scopeGuard.commitChanges(sandbox)
  })
}
