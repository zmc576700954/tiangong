/**
 * Subagent IPC Handlers (Phase 4)
 * Exposes listTypes / listInvocations / cancel / getResult and pushes progress events.
 */

import type { TypedHandle } from './utils'
import { ensureString } from './utils'
import type { SubagentManager } from '../agent/subagent-manager'
import type { SubagentInvocationRepository } from '../repositories/subagent-invocation-repository'
import type { SubagentResult } from '@shared/types'
import type { BrowserWindow } from 'electron'

export function registerSubagentHandlers(
  subagentManager: SubagentManager,
  repo: SubagentInvocationRepository,
  typedHandle: TypedHandle,
  getMainWindow?: () => BrowserWindow | null,
): void {
  typedHandle('subagent:listTypes', async () => {
    return subagentManager.listTypes()
  })

  typedHandle('subagent:listInvocations', async (_, parentSessionId: unknown) => {
    const id = ensureString('parentSessionId', parentSessionId)
    return repo.listByParent(id)
  })

  typedHandle('subagent:cancel', async (_, invocationId: unknown) => {
    const id = ensureString('invocationId', invocationId)
    await subagentManager.cancel(id)
  })

  typedHandle('subagent:getResult', async (_, invocationId: unknown): Promise<SubagentResult | null> => {
    const id = ensureString('invocationId', invocationId)
    const inv = await repo.get(id)
    if (!inv || inv.status !== 'completed') return null
    return {
      invocationId: inv.id,
      resultText: inv.resultText ?? '',
      resultFiles: inv.resultFiles ?? [],
      tokensUsed: inv.tokensUsed,
      durationMs: inv.finishedAt ? inv.finishedAt - inv.startedAt : 0,
    }
  })

  // Push progress events to the renderer
  if (getMainWindow) {
    subagentManager.onProgress((data) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('subagent:progress', data)
      }
    })
  }
}
