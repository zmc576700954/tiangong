/**
 * SubagentManager
 *
 * Spawns ephemeral child agent sessions on behalf of a parent session's
 * dispatch_subagent tool call. Each invocation:
 *   1. Validates agent type + scope strategy
 *   2. Resolves child sandbox (independent, with allow-list per strategy)
 *   3. Inserts a subagent_invocations row (status='queued', then 'running')
 *   4. Starts a child session via AgentManager (no threadId → no DB thread)
 *   5. Sends the prompt via sendCommand
 *   6. Subscribes to child outputs; tags each with invocationId, re-broadcasts to parent
 *   7. Awaits complete/error
 *   8. Collects result text (assistant stdout) + file_changes + token usage
 *   9. Updates the row to completed/failed
 *  10. Terminates the child session
 *  11. Returns SubagentResult
 *
 * Write-intent serialisation: when two write-capable subagents under the same
 * parent have overlapping allowed_files, the later one waits for the earlier
 * one(s) to finish before spawning. Read-only subagents (inherit scope) skip
 * this gate entirely.
 */

import { EventEmitter } from 'events'
import type { AgentManager } from './agent-manager'
import type { SubagentInvocationRepository } from '../repositories/subagent-invocation-repository'
import type {
  AgentTypeDefinition,
  SubagentInvokeArgs,
  SubagentResult,
  AgentSessionConfig,
  AgentCommand,
  AgentOutput,
} from '@shared/types'
import { BUILT_IN_AGENT_TYPES } from '@shared/types'
import { AgentError, ErrorCode } from '../errors'
import { generateId } from '../shared/env'

/** Derived from AgentManager.getSessionState; the struct lives inside agent-manager.ts. */
type SessionState = NonNullable<ReturnType<AgentManager['getSessionState']>>

const DEFAULT_MAX_CONCURRENT = 5
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export interface SubagentProgressEvent {
  invocationId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  error?: string
}

interface ActiveInvocation {
  /** Child session id; undefined until the child session has started. */
  sessionId?: string
  /** Persisted invocation row id; undefined until repo.create() returns. */
  invocationId?: string
  parentSessionId: string
  /** Empty array if read-only / inherit-scope invocation. */
  allowedFiles: string[]
  /** True iff this invocation is write-capable (subset|fresh with non-empty allowed_files). */
  isWrite: boolean
  /** Resolves when the invocation finishes (success or failure). */
  donePromise: Promise<void>
  /** Resolver for donePromise. */
  resolveDone: () => void
  /**
   * Cancellation signal for this invocation. cancel() calls controller.abort() so
   * that any `await` in invoke()/_runInvocation which forwards the signal will throw,
   * and `signal.aborted` can be checked at each await boundary via _throwIfCancelled().
   * This replaces the older pattern of manually rechecking `entry.cancelled` after every
   * await — every new await now inherits cancellation semantics for free.
   */
  controller: AbortController
}

export class SubagentManager extends EventEmitter {
  private activeCount = new Map<string, number>() // parentSessionId → running count
  private activeInvocations = new Map<string, ActiveInvocation>()
  private customTypes = new Map<string, AgentTypeDefinition>()

  constructor(
    private agentManager: AgentManager,
    private repo: SubagentInvocationRepository,
    private maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    super()
  }

  /** Register a user-defined agent type (settings). */
  registerType(def: AgentTypeDefinition): void {
    this.customTypes.set(def.name, def)
  }

  /** List all available types (built-in + custom). */
  listTypes(): AgentTypeDefinition[] {
    return [...BUILT_IN_AGENT_TYPES, ...this.customTypes.values()]
  }

  getType(name: string): AgentTypeDefinition | undefined {
    return this.customTypes.get(name) ?? BUILT_IN_AGENT_TYPES.find((t) => t.name === name)
  }

  /**
   * A subagent has write intent when its scope strategy permits writes
   * AND it has a non-empty allow-list. 'inherit' is used by read-only
   * types (explore/review).
   */
  private isWriteCapable(def: AgentTypeDefinition, allowedFiles: string[]): boolean {
    return (
      (def.scopeStrategy === 'subset' || def.scopeStrategy === 'fresh') &&
      allowedFiles.length > 0
    )
  }

  /**
   * Throw an AgentError if the invocation's AbortController has fired.
   *
   * 覆盖范围：仅当显式调用时检查取消状态。目前用于 invoke() 中 startSession 之前的
   * 启动阶段 await 窗口（gate wait、repo.create）。执行期间的 await（sendCommand →
   * settlePromise）由 _runInvocation 中注册的 onAbort 中止监听器覆盖，而非本方法。
   *
   * 在 invoke() 的 startSession 与 _runInvocation 注册 settlePromise 中止监听器之间
   * 插入的新 await 必须显式调用本方法以保持取消安全；本方法不会自动覆盖所有 await 点。
   */
  private _throwIfCancelled(
    entry: ActiveInvocation | undefined,
    invocationId: string | undefined,
    where: string,
  ): void {
    if (entry?.controller.signal.aborted) {
      throw new AgentError(
        `Subagent invocation ${invocationId ?? '(pending)'} cancelled at ${where}`,
        ErrorCode.AGENT_SESSION_NOT_FOUND,
      )
    }
  }

  async invoke(args: SubagentInvokeArgs): Promise<SubagentResult> {
    const def = this.getType(args.agentType)
    if (!def) {
      throw new AgentError(`Unknown agent type: ${args.agentType}`, ErrorCode.AGENT_ADAPTER_ERROR)
    }

    // Resolve scope eagerly so the serialisation gate can compare against
    // currently-active invocations BEFORE we touch the concurrency cap.
    const parentState = this.agentManager.getSessionState(args.parentSessionId)
    if (!parentState) {
      throw new AgentError(
        `Parent session ${args.parentSessionId} not found`,
        ErrorCode.AGENT_SESSION_NOT_FOUND,
      )
    }
    const childAllowedFiles = this.resolveAllowedFiles(def, args, parentState.config)
    const isWrite = this.isWriteCapable(def, childAllowedFiles)

    // Serialisation gate: a write-capable invocation must wait for every
    // currently-active write-capable invocation under the SAME parent whose
    // allow-list overlaps. Read-only invocations skip the WAIT but still register
    // (so cancel() can find them).
    //
    // CRITICAL: registration into activeInvocations must happen SYNCHRONOUSLY,
    // in the same microtask as the gate evaluation. Parallel dispatch (Promise.all
    // over many invoke() calls in one tick) would otherwise let every write-capable
    // call pass the gate before any registers, defeating serialisation. We therefore
    // register immediately after evaluating the gate and before the first await.
    const registrationKey = generateId('subinv')
    let resolveDone!: () => void
    const donePromise = new Promise<void>((r) => {
      resolveDone = r
    })

    const conflicting: Promise<void>[] = []
    if (isWrite) {
      const childAllowedSet = new Set(childAllowedFiles)
      for (const active of this.activeInvocations.values()) {
        if (!active.isWrite) continue
        if (active.parentSessionId !== args.parentSessionId) continue
        const overlap = active.allowedFiles.some((f) => childAllowedSet.has(f))
        if (overlap) conflicting.push(active.donePromise)
      }
    }
    // Register synchronously so concurrently-dispatched siblings observe this invocation.
    const controller = new AbortController()
    this.activeInvocations.set(registrationKey, {
      parentSessionId: args.parentSessionId,
      allowedFiles: childAllowedFiles,
      isWrite,
      donePromise,
      resolveDone,
      controller,
    })

    try {
      if (conflicting.length > 0) {
        await Promise.all(conflicting)
      }

      // Concurrency cap per parent session — applied AFTER the gate so a
      // waiting subagent doesn't tie up a slot while it sits in the queue.
      const current = this.activeCount.get(args.parentSessionId) ?? 0
      if (current >= this.maxConcurrent) {
        throw new AgentError(
          `Subagent concurrency limit reached (${this.maxConcurrent}) for session ${args.parentSessionId}`,
          ErrorCode.AGENT_SESSION_LIMIT,
        )
      }
      this.activeCount.set(args.parentSessionId, current + 1)

      const startedAt = Date.now()

      let invocationId: string
      try {
        invocationId = await this.repo.create({
          parentSessionId: args.parentSessionId,
          parentMessageId: args.parentMessageId,
          agentType: args.agentType,
          description: args.description,
          prompt: args.prompt,
          adapterName: args.adapterName ?? def.defaultAdapter,
          nodeId: args.nodeId,
          allowedFiles: args.allowedFiles,
          startedAt,
        })
      } catch (err) {
        // Roll back concurrency reservation on persistence failure.
        const cnt = this.activeCount.get(args.parentSessionId) ?? 1
        this.activeCount.set(args.parentSessionId, Math.max(0, cnt - 1))
        throw err
      }

      // Backfill the invocationId onto the already-registered entry so cancel() can find it.
      const entry = this.activeInvocations.get(registrationKey)
      if (entry) entry.invocationId = invocationId

      // If cancel() fired during any await above (gate wait, repo.create), _throwIfCancelled
      // detects it via the shared AbortController and throws before we enter the running
      // path. Adding a new await above this point automatically inherits this guard, unlike
      // the old per-await `entry.cancelled` recheck which had to be duplicated every time.
      try {
        this._throwIfCancelled(entry, invocationId, 'pre-start')
      } catch (err) {
        // Pre-start cancel: roll back the concurrency reservation so the parent session
        // doesn't permanently lose a slot.  The inner try/finally that normally decrements
        // activeCount hasn't been entered yet at this point.
        const cnt = this.activeCount.get(args.parentSessionId) ?? 1
        this.activeCount.set(args.parentSessionId, Math.max(0, cnt - 1))
        throw err
      }

      this.emitProgress({ invocationId, status: 'queued' })

      try {
        await this.repo.updateStatus(invocationId, 'running')
        this.emitProgress({ invocationId, status: 'running' })

        const partial = await this._runInvocation(
          registrationKey,
          invocationId,
          args,
          def,
          parentState,
          childAllowedFiles,
          isWrite,
        )

        const finishedAt = Date.now()
        await this.repo.complete(invocationId, {
          resultText: partial.resultText,
          resultFiles: partial.resultFiles,
          tokensUsed: partial.tokensUsed,
          finishedAt,
        })
        this.emitProgress({ invocationId, status: 'completed' })

        return {
          invocationId,
          resultText: partial.resultText,
          resultFiles: partial.resultFiles,
          tokensUsed: partial.tokensUsed,
          durationMs: finishedAt - startedAt,
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        // If the error was raised because cancel() aborted the controller, cancel()
        // itself already transitions the DB row to 'cancelled' — don't overwrite it
        // with a 'failed' status here.  This is the reason we can safely add new awaits
        // above: cancellation cleanly threads through the shared signal.
        const cancelledByAbort = this.activeInvocations.get(registrationKey)?.controller.signal.aborted
        if (!cancelledByAbort) {
          try {
            await this.repo.fail(invocationId, { error: errorMsg, finishedAt: Date.now() })
          } catch {
            /* repo error already logged elsewhere */
          }
          this.emitProgress({ invocationId, status: 'failed', error: errorMsg })
        }
        throw err
      } finally {
        const cnt = this.activeCount.get(args.parentSessionId) ?? 1
        this.activeCount.set(args.parentSessionId, Math.max(0, cnt - 1))
      }
    } finally {
      // Always remove the registration and unblock any siblings waiting on this one,
      // regardless of which stage failed (gate wait, concurrency cap, repo.create, run).
      this.activeInvocations.delete(registrationKey)
      resolveDone()
    }
  }

  private async _runInvocation(
    registrationKey: string,
    invocationId: string,
    args: SubagentInvokeArgs,
    def: AgentTypeDefinition,
    parentState: SessionState,
    childAllowedFiles: string[],
    _isWrite: boolean,
  ): Promise<{ resultText: string; resultFiles: string[]; tokensUsed: number }> {
    const parentConfig = parentState.config
    const childAdapterName = args.adapterName ?? def.defaultAdapter ?? parentState.adapterName

    const childConfig: AgentSessionConfig = {
      ...parentConfig,
      allowedFiles: childAllowedFiles,
      parentSessionId: args.parentSessionId,
      swarmTaskId: invocationId,
      nodeId: args.nodeId,
      threadId: undefined, // no DB thread for subagents
      contextSummary: undefined, // child starts fresh
      resumeSessionId: undefined,
      // Phase 4: tool restriction for the child session
      subagentAllowedTools: def.allowedTools,
    }

    // Build the child task prompt — systemPromptAddon prepended for type-specific framing.
    const taskPrompt = def.systemPromptAddon
      ? `${def.systemPromptAddon}\n\nTask: ${args.prompt}`
      : args.prompt

    // Start child session
    const startResult = await this.agentManager.startSession(childAdapterName, childConfig)
    const childSessionId = startResult.sessionId

    // Backfill the child sessionId onto the entry registered synchronously in invoke()
    // (keyed by registrationKey). The donePromise/resolveDone live on that entry and are
    // settled in invoke()'s outer finally, unblocking any waiting siblings.
    const activeEntry = this.activeInvocations.get(registrationKey)
    if (activeEntry) activeEntry.sessionId = childSessionId

    // Close the cancel-during-start race: if cancel() fired while sessionId was still
    // undefined, controller.signal is aborted but no session was there to terminate yet.
    // Now that the child has started, honour the pending cancellation via terminate + throw.
    // Any *future* await inserted above this point (e.g. context resolution, memory
    // hydration) inherits the same guard by calling _throwIfCancelled — no per-await
    // bespoke flag rechecks needed.
    if (activeEntry?.controller.signal.aborted) {
      try {
        await this.agentManager.terminateSession(childSessionId, 'user')
      } catch {
        /* best-effort */
      }
      throw new AgentError(
        `Subagent invocation ${invocationId} cancelled before start`,
        ErrorCode.AGENT_SESSION_NOT_FOUND,
      )
    }

    // Subscribe to child outputs — tag with invocationId, re-broadcast to parent
    const outputBuffer: string[] = []
    const fileChanges: string[] = []
    // Token accounting: the authoritative source is SessionState.tokensUsed, updated
    // via the onUsage callback on the child session.  This local variable serves as a
    // preliminary counter before the session completes; it is overwritten with the
    // authoritative value from the child session state after the session ends (see
    // childState.tokensUsed assignment below).  The local value is returned to the
    // caller via the SubagentResult struct.
    let tokensUsed = 0
    let settled = false

    const outputHandler = (output: AgentOutput): void => {
      // Re-broadcast to parent session with invocationId tag
      const tagged: AgentOutput = { ...output, invocationId }
      this.agentManager.broadcastToSession(args.parentSessionId, tagged)

      if (output.type === 'stdout' || output.type === 'complete') {
        if (output.data) outputBuffer.push(output.data)
      }
      if (output.type === 'file_change' && output.filePath) {
        fileChanges.push(output.filePath)
      }
      if (output.type === 'complete' && !settled) {
        settled = true
        completeResolve?.()
      }
      if (output.type === 'error' && !settled) {
        settled = true
        completeReject?.(
          new AgentError(output.data || 'Subagent error', ErrorCode.AGENT_ADAPTER_ERROR),
        )
      }
    }

    let completeResolve: (() => void) | undefined
    let completeReject: ((err: Error) => void) | undefined
    const settlePromise = new Promise<void>((resolve, reject) => {
      completeResolve = resolve
      completeReject = reject
    })

    // Mid-execution cancel: when cancel() aborts the controller between sendCommand
    // and completion, reject the settle wait immediately so the outer finally cleans up
    // instead of blocking until timeout / natural completion.
    const onAbort = (): void => {
      if (!settled) {
        settled = true
        completeReject?.(
          new AgentError(
            `Subagent invocation ${invocationId} cancelled during execution`,
            ErrorCode.AGENT_SESSION_NOT_FOUND,
          ),
        )
      }
    }
    activeEntry?.controller.signal.addEventListener('abort', onAbort, { once: true })

    // Attach listener BEFORE sending the command so we don't miss early completions.
    this.agentManager.addSessionOutputListener(childSessionId, outputHandler)

    const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (!settled) {
        settled = true
        completeReject?.(
          new AgentError(
            `Subagent timeout after ${this.timeoutMs}ms`,
            ErrorCode.AGENT_ADAPTER_ERROR,
          ),
        )
      }
    }, this.timeoutMs)

    // The AgentCommand carries the task prompt via `description`. The adapter consumes
    // command.description as the user prompt (see BaseAdapter.doSendCommand). For Phase 4
    // we route systemPromptAddon + raw prompt through this field.
    const command: AgentCommand = {
      type: 'implement',
      description: taskPrompt,
      targetNodeId: args.nodeId ?? '',
    }

    try {
      await this.agentManager.sendCommand(childSessionId, command)
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      this.agentManager.removeSessionOutputListener(outputHandler)
      // Best-effort cleanup of the child session we just started.
      try {
        await this.agentManager.terminateSession(childSessionId, 'error')
      } catch {
        /* best-effort */
      }
      throw err
    }

    try {
      await settlePromise
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      this.agentManager.removeSessionOutputListener(outputHandler)
      activeEntry?.controller.signal.removeEventListener('abort', onAbort)
    }

    const resultText = outputBuffer.join('\n').trim() || '(no output)'

    // Pull authoritative token usage from the child session state before cleanup.
    const childState = this.agentManager.getSessionState(childSessionId)
    if (childState?.tokensUsed !== undefined) {
      tokensUsed = childState.tokensUsed
    }

    // Terminate child session (best-effort cleanup)
    try {
      await this.agentManager.terminateSession(childSessionId, 'user')
    } catch {
      /* best-effort */
    }

    return {
      resultText,
      resultFiles: fileChanges,
      tokensUsed,
    }
  }

  private resolveAllowedFiles(
    def: AgentTypeDefinition,
    args: SubagentInvokeArgs,
    parentConfig: AgentSessionConfig,
  ): string[] {
    switch (def.scopeStrategy) {
      case 'inherit':
        return parentConfig.allowedFiles
      case 'subset': {
        const child = args.allowedFiles ?? []
        const parentSet = new Set(parentConfig.allowedFiles)
        const invalid = child.filter((f) => !parentSet.has(f))
        if (invalid.length > 0) {
          throw new AgentError(
            `Subagent allowed_files not subset of parent: ${invalid.join(', ')}`,
            ErrorCode.AGENT_ADAPTER_ERROR,
          )
        }
        return child
      }
      case 'fresh': {
        const child = args.allowedFiles ?? []
        const parentSet = new Set(parentConfig.allowedFiles)
        // Intersect with the parent's allow-list so a fresh subagent cannot
        // escape the parent/project scope.
        return child.filter((f) => parentSet.has(f))
      }
    }
  }

  async cancel(invocationId: string): Promise<void> {
    // Entries are keyed by an internal registrationKey; locate by invocationId field.
    let active: ActiveInvocation | undefined
    for (const entry of this.activeInvocations.values()) {
      if (entry.invocationId === invocationId) {
        active = entry
        break
      }
    }
    if (active) {
      // Abort the signal FIRST so any await checking _throwIfCancelled sees it,
      // and so the settlePromise abort listener (installed inside _runInvocation)
      // wakes an in-flight command.  A pre-start cancel (sessionId still undefined)
      // is picked up by _runInvocation's post-startSession guard — cancellation is
      // never silently dropped.
      active.controller.abort()
      if (active.sessionId) {
        try {
          await this.agentManager.terminateSession(active.sessionId, 'user')
        } catch {
          /* best-effort */
        }
      }
    }
    await this.repo.cancel(invocationId, Date.now())
    this.emitProgress({ invocationId, status: 'cancelled' })
  }

  onProgress(handler: (event: SubagentProgressEvent) => void): () => void {
    this.on('progress', handler)
    return () => {
      this.off('progress', handler)
    }
  }

  private emitProgress(event: SubagentProgressEvent): void {
    this.emit('progress', event)
  }
}
