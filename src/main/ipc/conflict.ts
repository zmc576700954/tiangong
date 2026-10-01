/**
 * Conflict IPC handlers (D10d-3)
 *
 * 注册：
 *   - conflict:getRecentReports(graphId, limit?) → ConflictReport[]
 *   - conflict:clearReports(graphId) → void
 *
 * 推事件（不通过 handle 注册）：
 *   - conflict:onReported(report) — main 直接 webContents.send
 *
 * 复用 ipc-handlers.ts 已有的广播 helper；不引入新的事件总线。
 */

import type { TypedHandle } from './utils'
import { getConflictReporter } from '../services/conflict-reporter'

const MAX_ID_LEN = 128
const MAX_LIMIT = 200

function ensureString(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${name}: must be non-empty string`)
  }
  if (value.length > max) {
    throw new Error(`Invalid ${name}: length exceeds ${max}`)
  }
  return value
}

/** 注册冲突 IPC handler */
export function registerConflictHandlers(typedHandle: TypedHandle): void {
  typedHandle('conflict:getRecentReports', async (_, graphId: string, limit?: number) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    const reporter = getConflictReporter()
    if (typeof limit === 'number') {
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
        throw new Error(`Invalid limit: must be 0..${MAX_LIMIT}`)
      }
      return reporter.getRecentReports(graphId, limit)
    }
    return reporter.getRecentReports(graphId)
  })

  typedHandle('conflict:clearReports', async (_, graphId: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    getConflictReporter().clearReports(graphId)
  })
}