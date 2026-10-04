/**
 * CompactionManager — 上下文压缩管理器
 *
 * 职责：
 * 1. 在同一 session 上并发压缩调用去重（compactInflight）
 * 2. 解析压缩策略（显式参数 → 适配器默认 → 'summary' fallback；非法值兜底）
 * 3. 调用 adapter.compactContext 执行压缩；native/llm 失败时降级到 summary
 * 4. 持久化压缩事件（CompactHistoryRepository）
 * 5. 更新会话线程水位线（ChatRepository.resetContextTokens + setLastCompactedAt）
 * 6. 更新内存水位线（ContextWaterline.onCompacted）
 * 7. 广播 system 消息：开始 / 完成 / 降级 / deferred
 *
 * 此模块替代 AgentManager.compactContext 与 _doCompactContext 的实现。
 * AgentManager 仅保留 facade：调用 CompactionManager.compact + 委托 repo 注入。
 */

import type { AgentOutput, CompactResult, CompactStrategy, CompactTrigger } from '@shared/types'
import type { BaseAdapter } from '../adapters/base'
import type { AdapterRegistry } from './adapter-registry'
import type { OutputBroadcaster } from './output-broadcaster'
import type { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type { ChatRepository } from '../repositories/chat-repository'
import type { ContextWaterline } from '../memory/context-waterline'
import { ADAPTER_REGISTRY } from '../adapters/registry'
import { AgentError, ErrorCode } from '../errors'
import type { RecoverySessionState } from './recovery-orchestrator'
import { createLogger } from '../shared/logger'

const logger = createLogger('CompactionManager')

const VALID_STRATEGIES: readonly CompactStrategy[] = ['native', 'llm', 'summary']

export class CompactionManager {
  /** 同 session 并发压缩去重（pending Promise map） */
  private compactInflight = new Map<string, Promise<CompactResult>>()

  /** 压缩历史持久化（注入式，可选） */
  private compactHistoryRepo?: CompactHistoryRepository
  /** 聊天线程水位线持久化（注入式，可选） */
  private chatRepo?: ChatRepository
  /** 内存水位线（注入式，可选） */
  private waterline?: ContextWaterline

  constructor(
    private readonly sessionStates: Map<string, RecoverySessionState>,
    private readonly registry: AdapterRegistry,
    private readonly broadcaster: OutputBroadcaster,
  ) {}

  setCompactHistoryRepo(repo: CompactHistoryRepository): void {
    this.compactHistoryRepo = repo
  }

  setChatRepo(repo: ChatRepository): void {
    this.chatRepo = repo
  }

  setWaterline(wl: ContextWaterline): void {
    this.waterline = wl
  }

  /** 暴露 compactInflight（兼容 AgentManager.compactInflight） */
  get inflightMap(): Map<string, Promise<CompactResult>> {
    return this.compactInflight
  }

  /**
   * 入口方法（同 session 并发压缩去重）
   */
  async compact(
    sessionId: string,
    strategy?: CompactStrategy,
    options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    const existing = this.compactInflight.get(sessionId)
    if (existing) return existing

    const promise = this.doCompact(sessionId, strategy, options)
    this.compactInflight.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.compactInflight.delete(sessionId)
    }
  }

  private async doCompact(
    sessionId: string,
    strategy: CompactStrategy | undefined,
    options: { reason?: CompactTrigger } | undefined,
  ): Promise<CompactResult> {
    const state = this.sessionStates.get(sessionId)
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
    const rawStrategy =
      strategy ??
      (descriptor as { defaultCompactStrategy?: CompactStrategy } | undefined)?.defaultCompactStrategy ??
      'summary'
    const finalStrategy: CompactStrategy = VALID_STRATEGIES.includes(rawStrategy) ? rawStrategy : 'summary'
    const threadId = state.threadId

    this.broadcaster.broadcast(
      state.broadcastName,
      {
        type: 'system',
        data: `Compacting context (${finalStrategy})...`,
        timestamp: Date.now(),
      } as AgentOutput,
      sessionId,
    )

    let result: CompactResult
    try {
      result = await adapter.compactContext(sessionId, finalStrategy, options)
    } catch (err) {
      if (finalStrategy === 'native' || finalStrategy === 'llm') {
        logger.warn(`[Compact] ${finalStrategy} failed, falling back to summary: ${err}`)
        this.broadcaster.broadcast(
          state.broadcastName,
          {
            type: 'system',
            data: `${finalStrategy} compaction failed, falling back to summary rewrite.`,
            timestamp: Date.now(),
          } as AgentOutput,
          sessionId,
        )
        result = await adapter.compactContext(sessionId, 'summary', options)
      } else {
        throw err
      }
    }

    // 持久化历史（deferred 跳过 —— 真实减额尚未发生）
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

    // 更新线程水位线（deferred 跳过 —— tokensAfter 尚未准确）
    if (!result.deferred && this.chatRepo && threadId) {
      try {
        await this.chatRepo.setLastCompactedAt(threadId, result.startedAt)
        await this.chatRepo.resetContextTokens(threadId, result.tokensAfter)
      } catch (err) {
        logger.warn(`[Compact] Failed to update thread waterline: ${err}`)
      }
    }

    // 更新内存水位线
    if (!result.deferred && this.waterline && threadId) {
      this.waterline.onCompacted(threadId, result.tokensAfter, result.startedAt)
    }

    // 广播完成
    if (result.deferred) {
      this.broadcaster.broadcast(
        state.broadcastName,
        {
          type: 'system',
          data: `Native compact enabled — SDK will compact on next turn`,
          timestamp: Date.now(),
        } as AgentOutput,
        sessionId,
      )
    } else {
      this.broadcaster.broadcast(
        state.broadcastName,
        {
          type: 'system',
          data: `Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.durationMs}ms)`,
          timestamp: Date.now(),
        } as AgentOutput,
        sessionId,
      )
    }

    return result
  }
}