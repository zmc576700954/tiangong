/**
 * ContextWaterline
 *
 * Tracks per-thread token usage and emits throttled change events.
 * Three input sources:
 *   1. onMessagePersisted — estimateTokens() at message-create time
 *   2. onAdapterUsageReport — authoritative usage from adapter (Phase 3+)
 *   3. onCompacted — reset after compaction (Phase 3+)
 *
 * Change events are throttled to 500ms to avoid UI churn.
 */

import { EventEmitter } from 'events'
import type { ContextState } from '@shared/types'
import { estimateTokens } from '../shared/token-utils'

const THROTTLE_MS = 500

interface WaterlineState {
  threadId: string
  tokensUsed: number
  tokensMax: number
  lastCompactedAt: number | null
}

export class ContextWaterline {
  private state = new Map<string, WaterlineState>()
  private emitter = new EventEmitter()
  private throttleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ============ Configuration ============

  autoCompactEnabled = false           // Phase 2: false; Phase 3: true
  autoCompactThreshold = 0.75
  minCompactInterval = 60_000          // ms

  // ============ Input sources ============

  onMessagePersisted(threadId: string, content: string): void {
    const tokens = estimateTokens(content)
    const s = this.getOrInitState(threadId)
    s.tokensUsed += tokens
    this.emitChangeThrottled(threadId)
  }

  onAdapterUsageReport(threadId: string, used: number, max: number): void {
    const s = this.getOrInitState(threadId)
    s.tokensUsed = used
    s.tokensMax = max
    this.emitChangeThrottled(threadId)
  }

  onCompacted(threadId: string, tokensAfter: number, timestamp: number): void {
    const s = this.getOrInitState(threadId)
    s.tokensUsed = tokensAfter
    s.lastCompactedAt = timestamp
    this.emitChange(threadId)
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
