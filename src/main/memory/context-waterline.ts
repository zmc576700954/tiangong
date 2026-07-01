/**
 * ContextWaterline
 *
 * Tracks per-thread token usage and emits throttled change events.
 * DB is the source of truth for token counts. This class maintains an
 * in-memory mirror that is kept in sync via three input sources:
 *   1. onMessagePersisted — tokenCount from estimateTokens() at message-create time
 *   2. onAdapterUsageReport — authoritative usage from adapter (Phase 3+);
 *      takes the higher of accumulated estimate vs. adapter report to prevent regression
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
  private emitter: EventEmitter
  private throttleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private dbDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private dbWriteback?: DbWriteback
  /** Optional sync loader to hydrate persisted token state on first access (set after db is available). */
  private dbLoader?: (threadId: string) => { tokensUsed: number; tokensMax: number } | null
  /** Thread ids already hydrated from DB, to avoid repeated loads. */
  private hydrated = new Set<string>()

  constructor() {
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(MAX_LISTENERS)
  }

  // ============ Configuration ============

  autoCompactEnabled = false           // Phase 2: false; Phase 3: true
  autoCompactThreshold = 0.75
  minCompactInterval = 60_000          // ms

  /** Set or update the DB writeback (called after db is available) */
  setDbWriteback(fn: DbWriteback): void {
    this.dbWriteback = fn
  }

  /**
   * Set a synchronous loader used to hydrate persisted token state from the DB
   * the first time a thread's state is initialised. Without this, restarting the
   * process resets a long thread's accumulated tokens to 0, so shouldAutoCompact's
   * ratio is understated until the next adapter usage report arrives.
   */
  setDbLoader(fn: (threadId: string) => { tokensUsed: number; tokensMax: number } | null): void {
    this.dbLoader = fn
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
    // Adapter reports are authoritative but should never regress the
    // accumulated estimate — take the higher of the two values.
    s.tokensUsed = Math.max(s.tokensUsed, used)
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
      // Hydrate persisted token usage on first access so restarts don't reset to 0.
      // On success: cache the hydrated state and mark as done via hydrated.add.
      // On failure: return s WITHOUT caching it in this.state, so the next access
      // retries the DB load (the state.set call is deliberately inside the try block).
      if (this.dbLoader && !this.hydrated.has(threadId)) {
        try {
          const loaded = this.dbLoader(threadId)
          if (loaded) {
            s.tokensUsed = loaded.tokensUsed > 0 ? loaded.tokensUsed : s.tokensUsed
            s.tokensMax = loaded.tokensMax > 0 ? loaded.tokensMax : s.tokensMax
          }
          this.hydrated.add(threadId)
          this.state.set(threadId, s)
        } catch (err) {
          logger.warn(`Waterline DB hydrate failed for thread ${threadId}:`, err)
          // Do not cache state — next access will retry hydration.
          return s
        }
      } else {
        this.state.set(threadId, s)
      }
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
