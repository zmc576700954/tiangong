/**
 * ContextCompactor — owns context compaction orchestration.
 *
 * Extracted from AgentManager in D1a. Owns:
 *  - dedup of concurrent compactContext calls on the same session
 *  - strategy resolution (explicit param → adapter's default → 'summary')
 *  - native/llm → summary fallback on failure
 *  - persistence to compact_history + chat_threads
 *  - waterline notification
 *  - broadcast of compact start/done messages
 *
 * AgentManager retains the responsibility of deciding WHEN to compact
 * (waterline.autoCompact threshold checks happen in resolveAndSendCommand).
 */

import type {
  CompactResult,
  CompactStrategy,
  CompactTrigger,
} from '@shared/types'
import { ADAPTER_REGISTRY } from '../adapters/registry'
import type { BaseAdapter } from '../adapters/base'
import { type AdapterRegistry } from './adapter-registry'
import { type OutputBroadcaster } from './output-broadcaster'
import { type SessionLifecycleManager } from './session-lifecycle-manager'
import { AgentError, ErrorCode } from '../errors'
import type { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type { ChatRepository } from '../repositories/chat-repository'
import type { ContextWaterline } from '../memory/context-waterline'
import type { SessionState } from './types'
import { createLogger } from '../shared/logger'

const logger = createLogger('ContextCompactor')

const VALID_STRATEGIES: readonly CompactStrategy[] = ['native', 'llm', 'summary']

export class ContextCompactor {
  /** Phase 3: dedup map for concurrent compactContext calls on the same session */
  private compactInflight = new Map<string, Promise<CompactResult>>()

  constructor(
    private registry: AdapterRegistry,
    private broadcaster: OutputBroadcaster,
    private lifecycle: SessionLifecycleManager,
  ) {}

  /** Inject dependencies from AgentManager setters. */
  setWaterline(wl: ContextWaterline | undefined): void { this.waterline = wl }
  setCompactHistoryRepo(repo: CompactHistoryRepository | undefined): void { this.compactHistoryRepo = repo }
  setChatRepo(repo: ChatRepository | undefined): void { this.chatRepo = repo }

  private waterline?: ContextWaterline
  private compactHistoryRepo?: CompactHistoryRepository
  private chatRepo?: ChatRepository
  /** Optional override for session-state lookup. Falls back to lifecycle. */
  private stateLookup?: (sessionId: string) => SessionState | undefined

  /**
   * Compact the context of a session. Dedups concurrent calls on the same
   * sessionId.
   */
  async compact(
    sessionId: string,
    strategy?: CompactStrategy,
    options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    const existing = this.compactInflight.get(sessionId)
    if (existing) return existing

    const promise = this._doCompact(sessionId, strategy, options)
    this.compactInflight.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.compactInflight.delete(sessionId)
    }
  }

  private async _doCompact(
    sessionId: string,
    strategy: CompactStrategy | undefined,
    options: { reason?: CompactTrigger } | undefined,
  ): Promise<CompactResult> {
    const state = this.resolveState(sessionId)
    if (!state) {
      throw new AgentError(`Session ${sessionId} not found`, ErrorCode.AGENT_SESSION_NOT_FOUND)
    }
    const adapter = this.registry.get(state.adapterName) as BaseAdapter | undefined
    if (!adapter) {
      throw new AgentError(
        `Adapter ${state.adapterName} not found`,
        ErrorCode.AGENT_ADAPTER_NOT_FOUND,
      )
    }
    const descriptor = ADAPTER_REGISTRY.find((d) => d.name === state.adapterName)
    const rawStrategy = strategy
      ?? (descriptor as { defaultCompactStrategy?: CompactStrategy } | undefined)?.defaultCompactStrategy
      ?? 'summary'
    const finalStrategy: CompactStrategy = VALID_STRATEGIES.includes(rawStrategy) ? rawStrategy : 'summary'
    const threadId = state.threadId

    // Broadcast "compacting" notification
    this.broadcaster.broadcast(state.broadcastName, {
      type: 'system',
      data: `Compacting context (${finalStrategy})...`,
      timestamp: Date.now(),
    }, sessionId)

    let result: CompactResult
    try {
      result = await adapter.compactContext(sessionId, finalStrategy, options)
    } catch (err) {
      if (finalStrategy === 'native' || finalStrategy === 'llm') {
        logger.warn(`[Compact] ${finalStrategy} failed, falling back to summary: ${err}`)
        this.broadcaster.broadcast(state.broadcastName, {
          type: 'system',
          data: `${finalStrategy} compaction failed, falling back to summary rewrite.`,
          timestamp: Date.now(),
        }, sessionId)
        result = await adapter.compactContext(sessionId, 'summary', options)
      } else {
        throw err
      }
    }

    // Persist history (non-blocking on error)
    // Skip for deferred compactions — the real reduction hasn't happened yet.
    if (!result.deferred && this.compactHistoryRepo) {
      try {
        await this.compactHistoryRepo.insert({
          threadId: threadId ?? null,
          sessionId,
          strategy: result.strategy,
          trigger: result.trigger,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          summary: result.summary ?? null,
          startedAt: result.startedAt,
          durationMs: result.durationMs,
        })
      } catch (err) {
        logger.warn(`[Compact] Failed to insert history: ${err}`)
      }
    }

    // Update thread waterline metadata (non-blocking on error)
    // Skip for deferred compactions — tokensAfter is not yet accurate.
    if (!result.deferred && this.chatRepo && threadId) {
      try {
        await this.chatRepo.setLastCompactedAt(threadId, result.startedAt)
        await this.chatRepo.resetContextTokens(threadId, result.tokensAfter)
      } catch (err) {
        logger.warn(`[Compact] Failed to update thread waterline: ${err}`)
      }
    }

    // Update waterline in-memory state
    // Skip for deferred compactions — will be updated when SDK reports real usage.
    if (!result.deferred && this.waterline && threadId) {
      this.waterline.onCompacted(threadId, result.tokensAfter, result.startedAt)
    }

    // Broadcast completion
    if (result.deferred) {
      this.broadcaster.broadcast(state.broadcastName, {
        type: 'system',
        data: `Native compact enabled — SDK will compact on next turn`,
        timestamp: Date.now(),
      }, sessionId)
    } else {
      this.broadcaster.broadcast(state.broadcastName, {
        type: 'system',
        data: `Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.durationMs}ms)`,
        timestamp: Date.now(),
      }, sessionId)
    }

    return result
  }

  /**
   * Clear any in-flight compact bookkeeping for a session. Called by
   * AgentManager on native-resume recovery so the resumed session can start
   * fresh compaction accounting.
   */
  clearInflightForSession(sessionId: string): void {
    this.compactInflight.delete(sessionId)
  }

  /**
   * Inject an alternate session-state source. AgentManager uses this so the
   * compactor can read state from the AgentManager-owned sessionStates map
   * even when the lifecycle manager was never told about the session
   * (typical for unit tests that seed via `sessionStates.set(...)`).
   */
  setSessionStateLookup(fn: (sessionId: string) => SessionState | undefined): void {
    this.stateLookup = fn
  }

  /** Test-only: number of in-flight compact calls per session. */
  get inflightCount(): number {
    return this.compactInflight.size
  }

  /** Test-only: in-flight compact promises keyed by sessionId. */
  get inflightMap(): Map<string, Promise<CompactResult>> {
    return this.compactInflight
  }

  private resolveState(sessionId: string): SessionState | undefined {
    if (this.stateLookup) {
      const resolved = this.stateLookup(sessionId)
      if (resolved) return resolved
    }
    return this.lifecycle.getSessionState(sessionId)
  }
}