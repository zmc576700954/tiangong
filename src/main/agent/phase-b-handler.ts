/**
 * PhaseBHandler — orchestrates post-cleanup Phase B work after a session's
 * lifecycle lock is released.
 *
 * Extracted from AgentManager in D1a. Owns:
 *  - Memory pipeline (normalize → compress → extract → verify → compile →
 *    waterline → persist) via PipelineRunner
 *  - onSessionComplete callback firing with success/failure verdict
 *  - Prompt-quality feedback ring (bounded to 100 entries)
 *  - Recovery-attempt reset on healthy termination
 *  - File-change auto-association with bound node metadata
 *
 * AgentManager remains responsible for deciding WHEN to call run() — that
 * happens via the lifecycle.onPhaseB callback (see agent-manager.ts).
 */

import type { AgentOutput, NodeMetadata, TerminationReason } from '@shared/types'
import type { SessionLifecycleManager } from './session-lifecycle-manager'
import type { SessionState } from './types'
import { PipelineRunner } from '../memory/pipeline'
import { getClient } from '../database'
import { createLogger } from '../shared/logger'

const logger = createLogger('PhaseBHandler')

export interface PhaseBHandlerDeps {
  lifecycle: SessionLifecycleManager
  /** Bounded ring of (commandType, promptTokens, contextCount, outcome, duration). */
  promptOutcomeLog: Array<{ commandType: string; promptTokenEstimate: number; contextCount: number; outcome: 'success' | 'failure'; duration: number }>
  /** Reset recovery counters so future crashes can be recovered again. */
  sessionRecovery: { reset: (originSessionId: string) => void }
  /** Optional callback fired on session completion. */
  onSessionComplete?: (sessionId: string, adapterName: string, nodeId: string, result: 'success' | 'failure' | 'cancelled', duration: number) => void
}

export class PhaseBHandler {
  constructor(private readonly deps: PhaseBHandlerDeps) {}

  /** Late-bind the session-complete callback. */
  setOnSessionComplete(cb: ((sessionId: string, adapterName: string, nodeId: string, result: 'success' | 'failure' | 'cancelled', duration: number) => void) | undefined): void {
    this.deps.onSessionComplete = cb
  }

  /**
   * Run the full Phase B pipeline: memory → completion callback → prompt
   * quality feedback → recovery reset (if healthy) → file-node association.
   * Never throws — all errors are logged and swallowed because Phase B is
   * best-effort and must not break session termination.
   */
  async run(
    sessionId: string,
    state: SessionState,
    outputs: AgentOutput[],
    reason: TerminationReason | undefined,
    scopeGuardError: Error | undefined,
  ): Promise<void> {
    const abnormal = state.terminationReason === 'crash' || state.terminationReason === 'error' || state.terminationReason === 'timeout'

    await this.runMemoryPipeline(sessionId, state, outputs)
    this.fireCompletionCallback(sessionId, state, abnormal, scopeGuardError)
    this.recordPromptOutcome(state, abnormal, scopeGuardError)

    // Reset recovery attempts on healthy termination. 'idle' counts as healthy:
    // the adapter was alive and well, just hit the inactivity timeout.
    const effectiveReason = reason ?? state.terminationReason
    if (effectiveReason === 'success' || effectiveReason === 'user' || effectiveReason === 'idle') {
      this.deps.sessionRecovery.reset(state.originSessionId ?? sessionId)
    }

    await this.associateChangedFilesWithNode(state, outputs)
  }

  private async runMemoryPipeline(sessionId: string, state: SessionState, outputs: AgentOutput[]): Promise<void> {
    try {
      const pipeline = await PipelineRunner.createDefault()
      const result = await pipeline.run({
        outputs,
        sessionId,
        adapterName: state.adapterName,
        projectId: state.config.workingDirectory,
        nodeId: state.config.nodeId,
      })
      if (result.errors.length > 0) {
        logger.warn(`Pipeline completed with ${result.errors.length} errors`)
      }
    } catch (err) {
      logger.warn(`Memory pipeline failed for session ${sessionId}:`, err)
    }
  }

  private fireCompletionCallback(sessionId: string, state: SessionState, abnormal: boolean, scopeGuardError: Error | undefined): void {
    if (!this.deps.onSessionComplete) return
    const result: 'success' | 'failure' | 'cancelled' = scopeGuardError || abnormal ? 'failure' : 'success'
    this.deps.onSessionComplete(
      sessionId,
      state.adapterName,
      state.config.nodeId ?? '',
      result,
      Date.now() - state.startTime,
    )
  }

  /** Push outcome tuple onto the bounded feedback ring (max 100 entries). */
  private recordPromptOutcome(state: SessionState, abnormal: boolean, scopeGuardError: Error | undefined): void {
    this.deps.promptOutcomeLog.push({
      commandType: state.lastCommandType ?? 'implement',
      promptTokenEstimate: state.promptTokenEstimate ?? 0,
      contextCount: state.contextCount ?? 0,
      outcome: scopeGuardError || abnormal ? 'failure' : 'success',
      duration: Date.now() - state.startTime,
    })
    if (this.deps.promptOutcomeLog.length > 100) {
      this.deps.promptOutcomeLog.shift()
    }
  }

  /**
   * Task 2.4.2: Auto-associate file_change outputs with the bound node's
   * metadata.linkedFiles. If any changed path overlaps a linked file, bump
   * metadata.lastModified.
   */
  private async associateChangedFilesWithNode(state: SessionState, outputs: AgentOutput[]): Promise<void> {
    if (!state.config.nodeId) return
    try {
      const fileChangeOutputs = outputs.filter((o) => o.type === 'file_change' && o.filePath)
      if (fileChangeOutputs.length === 0) return

      const db = getClient()
      const changedPaths = fileChangeOutputs.map((o) => o.filePath!)
      const row = db.prepare('SELECT id, metadata FROM nodes WHERE id = ?').get(state.config.nodeId) as Record<string, unknown> | undefined
      if (!row) return

      try {
        const metadata: NodeMetadata & { linkedFiles?: string[]; lastModified?: number } = row.metadata ? JSON.parse(row.metadata as string) : {}
        const linkedFiles: string[] = metadata.linkedFiles ?? []
        const matchedFiles = changedPaths.filter((fp) =>
          linkedFiles.some((lf) => fp.endsWith(lf) || lf.endsWith(fp)),
        )
        if (matchedFiles.length === 0) return

        metadata.lastModified = Date.now()
        const { NodeRepository } = await import('../repositories/node-repository')
        const nodeRepo = new NodeRepository(db)
        await nodeRepo.update(state.config.nodeId, { metadata })
      } catch (e) {
        logger.warn('Failed to parse metadata for file-node association', { nodeId: state.config.nodeId, error: String(e) })
      }
    } catch (e) {
      logger.warn('File-node association failed during session termination', { error: String(e) })
    }
  }
}