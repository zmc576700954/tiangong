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
    // F2：completed / failed / cancelled 都返回结果；失败与取消携带部分输出，
    // 用结构化 status/partial 字段区分，不靠 resultText 字符串前缀。
    if (!inv || inv.status === 'queued' || inv.status === 'running') return null
    const isPartial = inv.status !== 'completed'
    return {
      invocationId: inv.id,
      resultText: inv.resultText ?? '',
      resultFiles: inv.resultFiles ?? [],
      tokensUsed: inv.tokensUsed,
      durationMs: inv.finishedAt ? inv.finishedAt - inv.startedAt : 0,
      status: inv.status,
      error: inv.status === 'failed' ? (inv.error ?? undefined) : undefined,
      partial: isPartial && inv.resultText !== null,
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
