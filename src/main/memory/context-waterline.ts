/**
 * ContextWaterline
 *
 * Tracks per-thread token usage and emits throttled change events.
 * DB is the source of truth for token counts. This class maintains an
 * in-memory mirror that is kept in sync via three input sources:
 *   1. onMessagePersisted — tokenCount from estimateTokens() at message-create time
 *   2. onAdapterUsageReport — authoritative usage from adapter (Phase 3+)
 *   3. onCompacted — reset after compaction (Phase 3+)
 *
 * DB writes are debounced to THROTTLE_MS for onMessagePersisted and
 * onAdapterUsageReport, so only the latest in-memory value reaches the DB.
 * This prevents out-of-order async overwrites when both fire in rapid
 * succession.  onCompacted writes immediately (critical state transition).
 *
 * Change events are throttled to 500ms to avoid UI churn.
 */

import { EventEmitter } from 'events'
import type { ContextState } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('ContextWaterline')

const THROTTLE_MS = 500
/** Safety margin for EventEmitter listeners (IPC push + UI components per thread) */
const MAX_LISTENERS = 20

/** Callback to persist token changes to the database */
export type DbWriteback = (threadId: string, tokensUsed: number) => Promise<void>

interface WaterlineState {
  threadId: string
  tokensUsed: number
  tokensMax: number
  lastCompactedAt: number | null
}

export class ContextWaterline {
  private state = new Map<string, WaterlineState>()
  private emitter = new EventEmitter().setMaxListeners(MAX_LISTENERS)
  private throttleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private dbDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private dbWriteback?: DbWriteback

  // ============ Configuration ============

  autoCompactEnabled = false           // Phase 2: false; Phase 3: true
  autoCompactThreshold = 0.75
  minCompactInterval = 60_000          // ms

  /** Set or update the DB writeback (called after db is available) */
  setDbWriteback(fn: DbWriteback): void {
    this.dbWriteback = fn
  }

  // ============ Input sources ============

  onMessagePersisted(threadId: string, tokenCount: number): void {
    const s = this.getOrInitState(threadId)
    s.tokensUsed += tokenCount
    this.emitChangeThrottled(threadId)
    this.persistTokensDebounced(threadId)
  }

  onAdapterUsageReport(threadId: string, used: number, max: number): void {
    const s = this.getOrInitState(threadId)
    s.tokensUsed = used
    s.tokensMax = max
    this.emitChangeThrottled(threadId)
    this.persistTokensDebounced(threadId)
  }

  onCompacted(threadId: string, tokensAfter: number, timestamp: number): void {
    const s = this.getOrInitState(threadId)
    s.tokensUsed = tokensAfter
    s.lastCompactedAt = timestamp
    this.emitChange(threadId)
    // Compaction is a critical state transition — write immediately
    this.persistTokensNow(threadId)
  }

  // ============ Queries ============

  getRatio(threadId: string): number {
    const s = this.state.get(threadId)
    if (!s || s.tokensMax === 0) return 0
    return Math.min(s.tokensUsed / s.tokensMax, 1)
  }

  shouldAutoCompact(threadId: string): boolean {
    if (!this.autoCompactEnabled) return false
    const s = this.state.get(threadId)
    if (!s) return false
    const ratio = this.getRatio(threadId)
    if (ratio < this.autoCompactThreshold) return false
    if (s.lastCompactedAt) {
      const elapsed = Date.now() - s.lastCompactedAt
      if (elapsed < this.minCompactInterval) return false
    }
    return true
  }

  getState(threadId: string): ContextState | null {
    const s = this.state.get(threadId)
    if (!s) return null
    return {
      threadId: s.threadId,
      tokensUsed: s.tokensUsed,
      tokensMax: s.tokensMax,
      ratio: this.getRatio(threadId),
      lastCompactedAt: s.lastCompactedAt,
      updatedAt: Date.now(),
    }
  }

  // ============ Event subscription ============

  onChange(handler: (state: ContextState) => void): () => void {
    this.emitter.on('change', handler)
    return () => this.emitter.off('change', handler)
  }

  // ============ Internal ============

  /**
   * Debounced DB write — cancels any pending write for this thread and
   * schedules a new one after THROTTLE_MS.  Only the latest in-memory
   * value reaches the DB, preventing out-of-order overwrites when
   * onMessagePersisted and onAdapterUsageReport fire in rapid succession.
   */
  private persistTokensDebounced(threadId: string): void {
    const existing = this.dbDebounceTimers.get(threadId)
    if (existing) clearTimeout(existing)
    this.dbDebounceTimers.set(threadId, setTimeout(() => {
      this.dbDebounceTimers.delete(threadId)
      this.persistTokensNow(threadId)
    }, THROTTLE_MS))
  }

  /** Immediate DB write — used for critical state transitions (compaction). */
  private persistTokensNow(threadId: string): void {
    // Cancel any debounced write since this immediate write supersedes it
    const pending = this.dbDebounceTimers.get(threadId)
    if (pending) {
      clearTimeout(pending)
      this.dbDebounceTimers.delete(threadId)
    }
    const s = this.state.get(threadId)
    if (!s) return
    this.dbWriteback?.(threadId, s.tokensUsed).catch(err => {
      logger.warn(`dbWriteback failed for thread ${threadId}:`, err)
    })
  }

  private getOrInitState(threadId: string): WaterlineState {
    let s = this.state.get(threadId)
    if (!s) {
      s = { threadId, tokensUsed: 0, tokensMax: 200_000, lastCompactedAt: null }
      this.state.set(threadId, s)
    }
    return s
  }

  private emitChangeThrottled(threadId: string): void {
    const existing = this.throttleTimers.get(threadId)
    if (existing) clearTimeout(existing)
    this.throttleTimers.set(threadId, setTimeout(() => {
      this.throttleTimers.delete(threadId)
      this.emitChange(threadId)
    }, THROTTLE_MS))
  }

  private emitChange(threadId: string): void {
    const s = this.getState(threadId)
    if (s) this.emitter.emit('change', s)
  }
}
