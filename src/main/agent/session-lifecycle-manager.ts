/**
 * SessionLifecycleManager — owns per-session state, output routing, and cleanup.
 *
 * Extracted from AgentManager in D1a to separate "session lifecycle" from
 * "adapter fallback / recovery / health monitoring". Lifecycle is the single
 * authority for session state maps, scope sandbox lifecycle, and cleanup
 * mutexes. Recovery and fallback are AgentManager's responsibility — it
 * subscribes via the optional LifecycleCallbacks hooks.
 *
 * Public surface:
 *   start()           — register a freshly-created session and apply scope sandbox
 *   terminate()       — Phase A cleanup (lock + adapter.terminate + scope commit) +
 *                        Phase B hook invocation (lock released first)
 *   terminateAll()    — best-effort terminate every active session
 *   cleanupSessionResources() — event-driven cleanup (scope rollback path)
 *   getSessionState / getSandbox / getSessionConfig / listActive
 *   broadcastToSession / addOutputListener / addSessionOutputListener
 *   attachAdapter()   — wire up output buffering + session-ended dispatch
 *   setScopeGuard()   — replace scope guard instance and rebind violation handler
 *   destroy()         — unbind all adapters and clear state
 */

import type {
  AgentAdapter,
  AgentCommand,
  AgentCommandType,
  AgentOutput,
  AgentSessionConfig,
  Sandbox,
  TerminationReason,
} from '@shared/types'
import { SessionNotFoundError, ScopeGuardError } from '../errors'
import { type AdapterRegistry } from './adapter-registry'
import { type SessionRouter } from './session-router'
import { type OutputBroadcaster, type BroadcastPayload } from './output-broadcaster'
import { type ScopeGuard } from '../scope-guard'
import { createLogger } from '../shared/logger'
import os from 'node:os'
import type {
  LifecycleCallbacks,
  LifecyclePhaseBCallback,
  SessionState,
} from './types'

const logger = createLogger('SessionLifecycleManager')

/** 清理异步操作（adapter 终止、沙箱回滚）的超时时间（毫秒） */
const CLEANUP_ASYNC_TIMEOUT_MS = 30_000

type SessionEndedHandler = (
  sessionId: string,
  reason: 'success' | 'crash' | 'error' | 'timeout' | 'idle',
  exitCode: number | null,
) => void

export class SessionLifecycleManager {
  /** sessionId → SessionState */
  private sessionStates = new Map<string, SessionState>()
  /** sessionId → broadcastName */
  private sessionBroadcastNames = new Map<string, string>()
  /** sessionId → 该会话注册的输出监听 handler 集合（用于 cleanupSessionResources 自动清理） */
  private sessionOutputListenerIndex = new Map<string, Set<(output: AgentOutput) => void>>()
  /** sandboxId → sessionId 反向索引（O(1) 查找越界会话，避免线性扫描） */
  private sandboxSessionIndex = new Map<string, string>()
  /** 清理互斥锁：防止 terminate 和 cleanup 并发导致双重清理 */
  private cleanupInProgress = new Set<string>()
  /** 会话输出缓冲区：sessionId → AgentOutput[]（用于记忆提取） */
  private sessionOutputBuffers = new Map<string, AgentOutput[]>()
  /** 全局输出监听器（用于 MindMapAgent 等内部组件收集输出） */
  private outputListeners = new Map<(output: AgentOutput) => void, (payload: BroadcastPayload) => void>()
  /** 会话级输出监听器：按 broadcastName 过滤，防止跨会话输出污染 */
  private sessionOutputListeners = new Map<(output: AgentOutput) => void, (payload: BroadcastPayload) => void>()
  /** 每个 adapter 绑定的输出 handler */
  private adapterOutputHandlers = new Map<string, (output: AgentOutput) => void>()
  /** 每个 adapter 绑定的 sessionEnded handler */
  private adapterSessionEndedHandlers = new Map<string, SessionEndedHandler>()
  /** 当前 scope guard 引用（支持 setScopeGuard 重新绑定） */
  private scopeGuardRef: ScopeGuard
  /** TTL 过期回调：孤立会话超时时自动清理沙箱等资源 */
  private ttlExpiredUnsub: (() => void) | null = null
  /** Lifecycle 回调（agent-manager 注入） */
  private callbacks: LifecycleCallbacks = {}
  /** 标记在 attachAdapter 中是否已绑定 ScopeGuard 越界处理 */
  private scopeViolationBound = false

  constructor(
    private registry: AdapterRegistry,
    private router: SessionRouter,
    private broadcaster: OutputBroadcaster,
    scopeGuard: ScopeGuard,
  ) {
    this.scopeGuardRef = scopeGuard
  }

  /**
   * Bind lifecycle hooks. AgentManager calls this once at construction.
   */
  setCallbacks(callbacks: LifecycleCallbacks): void {
    this.callbacks = callbacks
  }

  /**
   * Replace the ScopeGuard instance and rebind the violation handler.
   */
  setScopeGuard(scopeGuard: ScopeGuard): void {
    // 销毁旧实例的定时器和 watcher
    this.scopeGuardRef.destroy()
    this.scopeGuardRef = scopeGuard
    if (this.scopeViolationBound) {
      this.bindScopeGuardViolationHandler()
    }
  }

  /**
   * Initialize lifecycle: bind TTL + scope-guard violation handlers and attach
   * all currently-registered adapters. Call after AgentManager construction.
   */
  initialize(): void {
    // 注册 TTL 过期回调：孤立会话超时时自动清理沙箱等资源
    this.ttlExpiredUnsub = this.subscribeToTtlExpired((sessionId) => {
      logger.warn(`Session ${sessionId} TTL expired, cleaning up resources`)
      void this.cleanupSessionResources(sessionId)
    })

    // 注册 ScopeGuard 越界回调：通过反向索引 O(1) 定位对应 session 并自动终止
    this.bindScopeGuardViolationHandler()

    // 为每个已注册的适配器绑定输出监听
    for (const adapter of this.registry.list()) {
      this.attachAdapter(adapter)
    }
  }

  /**
   * Bind TTL-expired cleanup. Returns an unsubscribe function for tests.
   */
  private subscribeToTtlExpired(handler: (sessionId: string) => void): () => void {
    this.router.onTtlExpired(handler)
    return () => this.router.onTtlExpired(() => {})
  }

  /**
   * 绑定 ScopeGuard 越界事件处理器（抽取为独立方法，便于注入新实例时重新绑定）
   */
  private bindScopeGuardViolationHandler(): void {
    this.scopeGuardRef.onViolation(async (sandboxId, violations) => {
      logger.error('Scope violation detected:', violations)
      const sessionId = this.sandboxSessionIndex.get(sandboxId)
      if (!sessionId) {
        logger.warn(`No session found for sandbox ${sandboxId}, skipping termination`)
        return
      }
      try {
        await this.terminate(sessionId, 'error', undefined)
      } catch (err) {
        logger.warn('Failed to terminate session during scope violation cleanup:', err)
      }
    })
    this.scopeViolationBound = true
  }

  /**
   * Register a new adapter and wire its output + sessionEnded handlers.
   * Idempotent for the same adapter instance (overwrites existing handlers).
   */
  attachAdapter(adapter: AgentAdapter): void {
    // Detach any existing handlers for this adapter name to avoid leaks
    this.detachAdapter(adapter)

    // ---- Output handler: broadcast + per-turn complete callback ----
    const outputHandler = (output: AgentOutput) => {
      const sessionId = adapter.resolveOutputSession?.(output)
      if (sessionId) {
        const broadcastName = this.sessionStates.get(sessionId)?.broadcastName ?? adapter.name
        this.broadcaster.broadcast(broadcastName, output, sessionId)

        // Per-turn 'complete' → fire callback (AgentManager uses this to reset
        // recovery-attempt counters on SDK adapters that don't emit sessionEnded
        // per turn).
        if (
          output.type === 'complete' &&
          !this.cleanupInProgress.has(sessionId) &&
          this.sessionStates.has(sessionId)
        ) {
          this.callbacks.onTurnComplete?.(sessionId)
        }
        return
      }
      this.broadcaster.broadcast(adapter.name, output)
    }
    this.adapterOutputHandlers.set(adapter.name, outputHandler)
    adapter.onOutput(outputHandler)

    // ---- Session ended handler: dispatch to cleanup / recovery / idle path ----
    const sessionEndedHandler: SessionEndedHandler = async (sessionId, reason, exitCode) => {
      try {
        if (reason === 'crash' || reason === 'error' || reason === 'timeout') {
          logger.warn(`Session ${sessionId} ended abnormally (${reason}, exit ${exitCode}), cleaning up...`)
          const state = this.sessionStates.get(sessionId)
          const outputs = this.sessionOutputBuffers.get(sessionId) ?? []
          if (state) {
            state.terminationReason = reason
          }

          if (state && this.callbacks.onSessionAbnormalEnded) {
            // Run recovery while the original session state/output buffer is still intact.
            const outcome = await this.callbacks.onSessionAbnormalEnded(
              sessionId,
              exitCode,
              reason,
              state,
              outputs,
            )
            if (outcome === 'native') {
              // Native resume keeps the same sessionId active. Clear only transient
              // crash artifacts (output buffer + compactInflight) and leave the
              // session/router binding + session output listeners in place.
              this.sessionOutputBuffers.delete(sessionId)
              this.callbacks.onNativeResume?.(sessionId)
              return
            }
          }

          // For replacement sessions or unrecoverable crashes, clean up the original session.
          await this.cleanupSessionResources(sessionId)
          return
        }

        if (reason === 'success') {
          // Normal completion: clean up resources without running recovery.
          logger.info(`Session ${sessionId} completed successfully (exit ${exitCode}), cleaning up...`)
          const state = this.sessionStates.get(sessionId)
          if (state) {
            state.terminationReason = 'success'
          }
          await this.cleanupSessionResources(sessionId)
          return
        }

        if (reason === 'idle') {
          // SDK adapter idle-reaper fired: delegate to terminate('idle') so the
          // full lifecycle (memory pipeline, scope commit, Phase B hooks) runs.
          logger.info(`Session ${sessionId} reclaimed by idle reaper, delegating to terminate`)
          await this.terminate(sessionId, 'idle', this.callbacks.onPhaseB)
        }
      } catch (err) {
        logger.error(`Unhandled error in sessionEnded handler for ${sessionId}:`, err)
      }
    }
    this.adapterSessionEndedHandlers.set(adapter.name, sessionEndedHandler)
    adapter.on('sessionEnded', sessionEndedHandler)
  }

  /**
   * Detach output/sessionEnded handlers previously attached via attachAdapter.
   * Used internally for re-attach and destroy().
   */
  private detachAdapter(adapter: AgentAdapter): void {
    const prevOutput = this.adapterOutputHandlers.get(adapter.name)
    if (prevOutput) {
      adapter.offOutput(prevOutput)
      this.adapterOutputHandlers.delete(adapter.name)
    }
    const prevEnded = this.adapterSessionEndedHandlers.get(adapter.name)
    if (prevEnded) {
      adapter.off('sessionEnded', prevEnded)
      this.adapterSessionEndedHandlers.delete(adapter.name)
    }
  }

  /**
   * Start a new session: register the freshly-created session in lifecycle
   * maps, prepare the scope guard sandbox, and wire output buffering.
   *
   * Returns the broadcast name to use for this session (callers can use this
   * to log or surface to the renderer).
   */
  async start(args: {
    candidate: string
    adapter: AgentAdapter
    session: { id: string; startTime: number }
    config: AgentSessionConfig
    isFallback: boolean
    primaryAdapter: string
  }): Promise<{ broadcastName: string }> {
    const { config, isFallback, primaryAdapter, session } = args

    let sandbox: Sandbox | undefined
    // Prepare a sandbox for normal write sessions and for read-only verification
    // sessions. When verifyOnly is true, allowedFiles is empty, so any write is
    // treated as an out-of-bounds violation.
    if (config.allowedFiles.length > 0 || config.verifyOnly) {
      sandbox = await this.scopeGuardRef.prepareSandbox(
        config.allowedFiles,
        config.workingDirectory,
      )
      // 维护 sandboxId → sessionId 反向索引
      this.sandboxSessionIndex.set(sandbox.id, session.id)
    }

    const broadcastName = isFallback ? `${primaryAdapter}-fallback-${session.id.slice(-6)}` : args.candidate

    this.sessionStates.set(session.id, {
      config,
      broadcastName,
      adapterName: args.candidate,
      startTime: session.startTime,
      sandbox,
      threadId: config.threadId,
      parentSessionId: config.parentSessionId,
      swarmTaskId: config.swarmTaskId,
    })
    this.sessionBroadcastNames.set(session.id, broadcastName)

    // Initialize output buffer for this session (used by Phase B memory extraction).
    this.startOutputBuffering(session.id)

    return { broadcastName }
  }

  /**
   * Terminate a session. Acquires the cleanup lock, calls adapter.terminate,
   * unbind router entries, deletes lifecycle maps, then runs scope commit.
   * Releases the lock before invoking phaseB so subsequent sessionEnded
   * events can run cleanupSessionResources without deadlocking.
   *
   * The phaseB hook (when provided) runs AFTER the lock is released.
   * Hooks receive immutable snapshots of state + outputs and must NOT touch
   * lifecycle maps.
   */
  async terminate(
    sessionId: string,
    reason?: TerminationReason,
    phaseB?: LifecyclePhaseBCallback,
  ): Promise<void> {
    // 互斥检查：若 cleanup 已在清理，直接返回
    if (this.cleanupInProgress.has(sessionId)) {
      logger.info(`Session ${sessionId} already being cleaned up, skipping terminate`)
      return
    }
    // 标记清理中，防止后续 sessionEnded 事件触发 cleanup 并发清理
    this.cleanupInProgress.add(sessionId)

    // 阶段划分：
    //   阶段 A（持锁）—— adapter.terminate + Map 状态清理 + ScopeGuard 提交
    //     这些必须排他执行，避免 sessionEnded('crash') 事件重入 cleanupSessionResources
    //     与正在迭代 sessionStates/sandboxSessionIndex 的代码冲突。
    //   阶段 B（释放锁后）—— 记忆抽取/存储 + onSessionComplete 回调
    //     这些只依赖阶段 A 抓拍的局部变量，不再触碰共享 Map。
    let adapter: AgentAdapter | undefined
    let state: SessionState | undefined
    let nodeId: string | undefined
    let sandbox: SessionState['sandbox']
    let outputsForMemory: AgentOutput[] = []
    let scopeGuardError: Error | undefined

    try {
      try {
        adapter = this.router.resolve(sessionId)
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          // Session 已被清理（如进程异常退出时 cleanup 已执行）
          // 我们已经持有 cleanupInProgress 锁，直接调用 _doCleanupSessionResources，
          // 避免 cleanupSessionResources 的锁检查 short-circuit 导致残留状态未被释放。
          await this._doCleanupSessionResources(sessionId)
          return
        }
        throw err
      }

      // 提前提取 nodeId 和 sandbox（在状态被清除前读取）
      state = this.sessionStates.get(sessionId)
      nodeId = state?.config.nodeId
      sandbox = state?.sandbox
      // 抓拍 outputs，后续阶段 B 不再访问 sessionOutputBuffers
      outputsForMemory = this.sessionOutputBuffers.get(sessionId) ?? []

      // Persist the termination reason into state *before* deletion so that
      // the `abnormal` check in phase B (after the lock is released) can see it.
      // Default to 'error' when no reason is given — internal callers (timers, cleanup)
      // that omit reason are typically abnormal paths, not user-initiated termination.
      const terminationReason: TerminationReason = (
        reason === 'user' || reason === 'timeout' || reason === 'crash' || reason === 'error' || reason === 'idle'
      )
        ? reason
        : (
          state?.terminationReason === 'user' ||
          state?.terminationReason === 'timeout' ||
          state?.terminationReason === 'crash' ||
          state?.terminationReason === 'error' ||
          state?.terminationReason === 'idle'
        )
          ? state.terminationReason
          : 'error'
      if (state && reason) {
        state.terminationReason = reason
      }

      try {
        await adapter.terminateSession(sessionId, terminationReason)
      } finally {
        // 无论 terminateSession 是否成功，都确保清理路由和状态
        this.router.unbind(sessionId)
        this.sessionStates.delete(sessionId)
        this.sessionBroadcastNames.delete(sessionId)
        this.sessionOutputBuffers.delete(sessionId)
        // 清理 sandboxId → sessionId 反向索引
        if (sandbox) {
          this.sandboxSessionIndex.delete(sandbox.id)
        }
      }

      // ScopeGuard: 执行后验证并清理沙箱（仍在锁内，避免与异常退出回滚冲突）
      if (sandbox) {
        try {
          await this.scopeGuardRef.commitChanges(sandbox)
          if (nodeId) {
            // Push the 'testing' status update to the renderer through the
            // status-change hook AgentManager wired up via setStatusChangeHook.
            this.notifyTestingStatus?.(sessionId, nodeId)
          }
        } catch (err) {
          if (err instanceof ScopeGuardError) {
            logger.error(`ScopeGuard validation failed for session ${sessionId}:`, err.message)
            scopeGuardError = err
          } else if (err instanceof Error) {
            logger.error(`ScopeGuard cleanup failed for session ${sessionId}:`, err.message)
          }
        }
      }
    } finally {
      // 阶段 A 完成（共享 Map 已清理干净），尽早释放清理互斥锁，
      // 让随后到达的 sessionEnded('crash') 事件可以正常触发 cleanupSessionResources。
      // 阶段 B 的记忆抽取/持久化不再访问共享 Map，因此可安全脱锁执行。
      this.cleanupInProgress.delete(sessionId)
    }

    // 阶段 B：在锁外执行，由 AgentManager 提供实际实现
    if (phaseB && state) {
      try {
        await phaseB({
          sessionId,
          state,
          outputs: outputsForMemory,
          reason,
          scopeGuardError,
        })
      } catch (err) {
        logger.warn(`Phase B hook failed for session ${sessionId}:`, err)
      }
    }

    if (scopeGuardError) {
      throw scopeGuardError
    }
  }

  /**
   * Optional hook fired after a successful scope commit so AgentManager can
   * push the 'testing' status to the renderer. Lifecycle keeps this
   * indirection so status callbacks don't leak into the lifecycle types.
   */
  private notifyTestingStatus?: (sessionId: string, nodeId: string) => void

  /**
   * Bind the optional status-change hook used by terminate() after a
   * successful scope commit. AgentManager wires this from its constructor.
   */
  setStatusChangeHook(hook: (sessionId: string, nodeId: string) => void): void {
    this.notifyTestingStatus = hook
  }

  /**
   * Terminate every active session concurrently (best-effort).
   */
  async terminateAll(reason: TerminationReason = 'user'): Promise<void> {
    const sessionIds = this.router.getActiveSessionIds()
    await Promise.allSettled(
      sessionIds.map((id) => this.terminate(id, reason, this.callbacks.onPhaseB)),
    )
    this.sessionStates.clear()
  }

  /**
   * Cleanup resources for a session whose adapter reported an abnormal exit.
   * Uses scope rollback (not commit) since the session may have left partial
   * writes behind. Idempotent via cleanupInProgress mutex.
   */
  async cleanupSessionResources(sessionId: string): Promise<void> {
    if (this.cleanupInProgress.has(sessionId)) return
    this.cleanupInProgress.add(sessionId)
    try {
      await this._doCleanupSessionResources(sessionId)
    } finally {
      this.cleanupInProgress.delete(sessionId)
    }
  }

  /**
   * Inner cleanup that assumes the caller already holds the cleanup lock.
   * Always clears maps and rolls back any active sandbox.
   */
  private async _doCleanupSessionResources(sessionId: string): Promise<void> {
    const state = this.sessionStates.get(sessionId)

    const pendingOps: Promise<void>[] = []

    // 终止 adapter 会话（防止子进程泄漏）
    try {
      const adapterName = this.router.getAdapterName(sessionId)
      if (adapterName) {
        const adapter = this.registry.get(adapterName)
        if (adapter) {
          const cleanupReason: TerminationReason = (
            state?.terminationReason === 'user' ||
            state?.terminationReason === 'timeout' ||
            state?.terminationReason === 'crash' ||
            state?.terminationReason === 'error'
          )
            ? state.terminationReason
            : 'error'
          pendingOps.push(
            adapter.terminateSession(sessionId, cleanupReason).then(
              () => {},
              (err: unknown) => { logger.warn(`Failed to terminate adapter session ${sessionId}:`, err) },
            ),
          )
        }
      }
    } catch {
      // 路由条目可能已不存在，忽略
    }

    // ScopeGuard: 异常退出时回滚沙箱（带重试机制，防止临时文件系统错误导致资源泄漏）
    if (state?.sandbox) {
      const sandbox = state.sandbox
      this.sandboxSessionIndex.delete(sandbox.id)
      pendingOps.push(
        this.rollbackWithRetry(sessionId, sandbox, 2).catch((err: unknown) => {
          logger.error(`Failed to rollback sandbox for session ${sessionId} after retries:`, err)
        }),
      )
    }

    // Wait for all async operations (adapter terminate + sandbox rollback) to settle
    // before clearing state, so that resources are truly released before overlap is possible.
    // A hard timeout prevents a hanging operation from permanently blocking cleanup.
    const cleanupTimeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.error(`Session ${sessionId} cleanup exceeded ${CLEANUP_ASYNC_TIMEOUT_MS}ms; force-progressing state cleanup`)
        resolve()
      }, CLEANUP_ASYNC_TIMEOUT_MS)
    })
    await Promise.race([Promise.allSettled(pendingOps), cleanupTimeout])

    // 清理会话级输出监听器（sessionOutputListeners + sessionOutputListenerIndex）
    const listeners = this.sessionOutputListenerIndex.get(sessionId)
    if (listeners) {
      for (const handler of listeners) {
        const wrapped = this.sessionOutputListeners.get(handler)
        if (wrapped) {
          this.broadcaster.offBroadcast(wrapped)
          this.sessionOutputListeners.delete(handler)
        }
      }
      this.sessionOutputListenerIndex.delete(sessionId)
    }

    this.sessionStates.delete(sessionId)
    this.sessionBroadcastNames.delete(sessionId)
    this.sessionOutputBuffers.delete(sessionId)
    this.router.unbind(sessionId)
  }

  /**
   * Sandboxed rollback with exponential-backoff retry. Mirrors the previous
   * behaviour from AgentManager; see that file's history for rationale.
   */
  private async rollbackWithRetry(
    sessionId: string,
    sandbox: Sandbox,
    maxRetries: number,
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.scopeGuardRef.rollback(sandbox)
        if (attempt > 0) {
          logger.info(`Sandbox rollback succeeded on retry ${attempt} for session ${sessionId}`)
        }
        return
      } catch (err: unknown) {
        lastError = err
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn(`Sandbox rollback attempt ${attempt + 1}/${maxRetries + 1} failed for session ${sessionId}: ${errMsg}`)
        if (attempt < maxRetries) {
          const baseDelay = 100 * Math.pow(2, attempt)
          const jitter = Math.random() * baseDelay * 0.5
          await new Promise<void>((resolve) => setTimeout(resolve, baseDelay + jitter))
        }
      }
    }
    throw lastError
  }

  // ----- State accessors -----

  getSessionState(sessionId: string): SessionState | undefined {
    return this.sessionStates.get(sessionId)
  }

  getSandbox(sessionId: string): Sandbox | undefined {
    return this.sessionStates.get(sessionId)?.sandbox
  }

  getSessionConfig(sessionId: string): AgentSessionConfig | undefined {
    return this.sessionStates.get(sessionId)?.config
  }

  /** Returns the broadcast name for a session, if any. */
  getBroadcastName(sessionId: string): string | undefined {
    return this.sessionBroadcastNames.get(sessionId)
  }

  /** Returns all session IDs currently registered. */
  listActive(): string[] {
    return Array.from(this.sessionStates.keys())
  }

  /** Returns the adapter name for a session (via router). */
  getAdapterNameForSession(sessionId: string): string | undefined {
    return this.router.getAdapterName(sessionId)
  }

  /** Broadcast an output to a specific session's thread channel. */
  broadcastToSession(sessionId: string, output: AgentOutput): void {
    const state = this.sessionStates.get(sessionId)
    if (state) {
      this.broadcaster.broadcast(state.broadcastName, output, sessionId)
    }
  }

  // ----- Output listeners -----

  /**
   * Register a global output listener (no session filtering).
   */
  addOutputListener(handler: (output: AgentOutput) => void): void {
    const wrapped = (payload: BroadcastPayload) => handler(payload.output)
    this.outputListeners.set(handler, wrapped)
    this.broadcaster.onBroadcast(wrapped)
  }

  /**
   * Remove a global output listener.
   */
  removeOutputListener(handler: (output: AgentOutput) => void): void {
    const wrapped = this.outputListeners.get(handler)
    if (wrapped) {
      this.broadcaster.offBroadcast(wrapped)
      this.outputListeners.delete(handler)
    }
  }

  /**
   * Add a session-scoped output listener (filtered by broadcastName).
   * Returns true if the session is active and the listener was registered.
   */
  addSessionOutputListener(sessionId: string, handler: (output: AgentOutput) => void): boolean {
    const state = this.sessionStates.get(sessionId)
    if (!state) return false
    const targetName = state.broadcastName

    const filteredHandler = (payload: BroadcastPayload) => {
      if (payload.adapterName === targetName) {
        handler(payload.output)
      }
    }
    this.sessionOutputListeners.set(handler, filteredHandler)
    let indexSet = this.sessionOutputListenerIndex.get(sessionId)
    if (!indexSet) {
      indexSet = new Set()
      this.sessionOutputListenerIndex.set(sessionId, indexSet)
    }
    indexSet.add(handler)
    this.broadcaster.onBroadcast(filteredHandler)
    return true
  }

  /**
   * Remove a session-scoped output listener.
   */
  removeSessionOutputListener(handler: (output: AgentOutput) => void): void {
    const wrapped = this.sessionOutputListeners.get(handler)
    if (wrapped) {
      this.broadcaster.offBroadcast(wrapped)
      this.sessionOutputListeners.delete(handler)
      for (const [, handlers] of this.sessionOutputListenerIndex) {
        handlers.delete(handler)
      }
    }
  }

  /**
   * Initialise the per-session output buffer and register a listener that
   * captures substantive outputs (stdout / stderr / file_change / complete)
   * for memory extraction. Called automatically by start().
   */
  private startOutputBuffering(sessionId: string): void {
    if (!this.sessionOutputBuffers.has(sessionId)) {
      this.sessionOutputBuffers.set(sessionId, [])
    }
    this.addSessionOutputListener(sessionId, (output) => {
      if (
        output.type === 'stdout' ||
        output.type === 'stderr' ||
        output.type === 'file_change' ||
        output.type === 'complete'
      ) {
        const buffer = this.sessionOutputBuffers.get(sessionId)
        if (!buffer) return
        buffer.push(output)
        const cap = this.calculateOutputBufferCap()
        if (buffer.length > cap) {
          buffer.splice(0, buffer.length - cap)
        }
      }
    })
  }

  /**
   * Compute the adaptive output-buffer cap based on free memory.
   */
  private calculateOutputBufferCap(): number {
    try {
      const freeMemMB = os.freemem() / 1024 / 1024
      return Math.max(100, Math.min(2000, Math.floor(freeMemMB / 50)))
    } catch {
      return 500
    }
  }

  /**
   * Capture the immutable output buffer snapshot for a session. Used by
   * AgentManager's Phase B hook to feed the memory pipeline.
   */
  getOutputBuffer(sessionId: string): AgentOutput[] | undefined {
    return this.sessionOutputBuffers.get(sessionId)
  }

  /**
   * Return mutable state fields AgentManager needs to record prompt-quality
   * metrics (lastCommandType, promptTokenEstimate, contextCount, tokensUsed).
   * Returns undefined if the session is no longer active.
   */
  recordPromptMetrics(
    sessionId: string,
    fields: { promptTokenEstimate: number; contextCount: number },
  ): void {
    const state = this.sessionStates.get(sessionId)
    if (!state) return
    state.promptTokenEstimate = fields.promptTokenEstimate
    state.contextCount = fields.contextCount
  }

  /**
   * Record the last command sent to this session (for recovery re-send).
   * The AgentManager records this before invoking adapter.sendCommand so that
   * abnormal-end recovery can replay the original command on the new session.
   */
  recordLastCommand(sessionId: string, command: AgentCommand, commandType: AgentCommandType): void {
    const state = this.sessionStates.get(sessionId)
    if (!state) return
    state.lastCommand = command
    state.lastCommandType = commandType
  }

  // ----- Lifecycle hooks -----

  /**
   * Cleanup all adapters and clear maps. Called on application shutdown.
   */
  destroy(): void {
    for (const [name, handler] of this.adapterOutputHandlers) {
      const adapter = this.registry.get(name)
      if (adapter) {
        adapter.offOutput(handler)
      }
    }
    for (const [name, handler] of this.adapterSessionEndedHandlers) {
      const adapter = this.registry.get(name)
      if (adapter) {
        adapter.off('sessionEnded', handler)
      }
    }
    this.adapterOutputHandlers.clear()
    this.adapterSessionEndedHandlers.clear()
    this.sessionStates.clear()
    this.sessionBroadcastNames.clear()
    this.sandboxSessionIndex.clear()
    // 清理所有会话级输出监听器
    for (const wrapped of this.sessionOutputListeners.values()) {
      this.broadcaster.offBroadcast(wrapped)
    }
    this.sessionOutputListeners.clear()
    this.sessionOutputListenerIndex.clear()
    this.cleanupInProgress.clear()
    // 清理 ScopeGuard 所有定时器和 watcher
    this.scopeGuardRef.destroy()
    // 取消 TTL 回调订阅
    if (this.ttlExpiredUnsub) {
      this.ttlExpiredUnsub()
      this.ttlExpiredUnsub = null
    }
  }

  /** Expose for tests / AgentManager (kept private to other modules). */
  get scopeGuardInstance(): ScopeGuard {
    return this.scopeGuardRef
  }

  /** Test-only: inspect cleanup mutex state. */
  isCleanupInProgress(sessionId: string): boolean {
    return this.cleanupInProgress.has(sessionId)
  }

  /** Test-only: number of session states currently registered. */
  get activeSessionCount(): number {
    return this.sessionStates.size
  }

  /** Test-only: number of sessions currently being cleaned up. */
  get cleanupInProgressCount(): number {
    return this.cleanupInProgress.size
  }
}