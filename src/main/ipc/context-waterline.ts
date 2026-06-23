/**
 * Context Waterline IPC Handlers
 * Phase 2: getWaterline, listHistory, compactNow (stub), and waterline:change push events.
 *
 * Note: This module is named `context-waterline.ts` to avoid clashing with the existing
 * `./context.ts`, which provides the AsyncLocalStorage-based IpcContext.
 */

import type { BrowserWindow } from 'electron'
import type { TypedHandle } from './utils'
import { ensureString } from './utils'
import type { ContextWaterline } from '../memory/context-waterline'
import type { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type { AgentManager } from '../agent/agent-manager'
import type { ContextState, CompactHistoryEntry, CompactStrategy, CompactResult } from '@shared/types'

const VALID_STRATEGIES: readonly CompactStrategy[] = ['native', 'llm', 'summary']

export function registerContextHandlers(
  waterline: ContextWaterline,
  agentManager: AgentManager,
  typedHandle: TypedHandle,
  compactHistoryRepo?: CompactHistoryRepository,
  getMainWindow?: () => BrowserWindow | null,
): void {
  typedHandle('context:getWaterline', async (_, threadId: unknown): Promise<ContextState | null> => {
    const id = ensureString('threadId', threadId)
    return waterline.getState(id)
  })

  typedHandle('context:listHistory', async (_, threadId: unknown): Promise<CompactHistoryEntry[]> => {
    if (!compactHistoryRepo) return []
    const id = ensureString('threadId', threadId)
    return compactHistoryRepo.listByThread(id)
  })

  // Phase 3: actually invoke AgentManager.compactContext with the resolved strategy.
  typedHandle('context:compactNow', async (_, sessionId: unknown, strategy: unknown): Promise<CompactResult> => {
    const sid = ensureString('sessionId', sessionId)
    const strat: CompactStrategy | undefined = strategy === undefined || strategy === null
      ? undefined
      : VALID_STRATEGIES.includes(strategy as CompactStrategy)
        ? (strategy as CompactStrategy)
        : undefined
    return agentManager.compactContext(sid, strat, { reason: 'manual' })
  })

  // Push waterline change events to the main window
  if (getMainWindow) {
    waterline.onChange((state: ContextState) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('waterline:change', state)
      }
    })
  }
}
