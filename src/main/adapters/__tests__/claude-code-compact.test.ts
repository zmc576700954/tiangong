import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ClaudeCodeAdapter } from '../claude-code'
import type { AgentSession } from '@shared/types'

/**
 * Tests for Claude Code adapter's native compaction and usage parsing.
 *
 * The Agent SDK is dynamically imported, so we cannot easily mock it here.
 * Instead we test the public compaction surface and verify the internal
 * `autoCompactEnabledFor` flag transitions that gate `autoCompactEnabled` in
 * the next `query()` call.
 */
describe('ClaudeCodeAdapter compaction', () => {
  let adapter: ClaudeCodeAdapter
  const sessionId = 'cc-sess-1'

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter()
    const session: AgentSession = {
      id: sessionId,
      adapterName: 'claude-code',
      config: {
        workingDirectory: '/tmp',
        allowedFiles: [],
        forbiddenFiles: [],
        invariantRules: [],
        upstreamContext: '',
        downstreamContext: '',
        nodeTitle: '',
        acceptanceCriteria: [],
      },
      startTime: Date.now(),
    }
    // Bracket access bypasses private visibility — safe for test setup
    adapter['sessions'].set(sessionId, session)
  })

  describe('compactByNative', () => {
    it('sets the auto-compact flag and returns a deferred CompactResult', async () => {
      const result = await adapter.compactContext(sessionId, 'native')

      expect(result.strategy).toBe('native')
      expect(result.trigger).toBe('manual')
      expect(result.tokensBefore).toBeGreaterThanOrEqual(0)
      expect(result.tokensAfter).toBe(result.tokensBefore) // deferred — no immediate reduction
      expect(result.deferred).toBe(true)
      expect(result.summary).toMatch(/deferred/)
      expect(result.startedAt).toBeGreaterThan(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      // The auto-compact flag should be set so the next query() opts in
      expect(adapter['autoCompactEnabledFor'].has(sessionId)).toBe(true)
    })

    it('passes trigger reason through', async () => {
      const result = await adapter.compactContext(sessionId, 'native', { reason: 'auto-threshold' })
      expect(result.trigger).toBe('auto-threshold')
    })

    it('keeps the flag set after compactByNative is called twice', async () => {
      await adapter.compactContext(sessionId, 'native')
      await adapter.compactContext(sessionId, 'native')
      expect(adapter['autoCompactEnabledFor'].has(sessionId)).toBe(true)
    })

    it('throws for unknown session', async () => {
      await expect(adapter.compactContext('nope', 'native')).rejects.toThrow(/not found/)
    })
  })

  describe('auto-compact flag lifecycle', () => {
    it('clears the flag when doCloseQuery is called', () => {
      adapter['autoCompactEnabledFor'].add(sessionId)
      expect(adapter['autoCompactEnabledFor'].has(sessionId)).toBe(true)

      adapter['doCloseQuery'](sessionId)

      expect(adapter['autoCompactEnabledFor'].has(sessionId)).toBe(false)
    })
  })

  describe('reportUsage', () => {
    it('emits a usage event with the parsed input_tokens', () => {
      const handler = vi.fn()
      adapter.onUsage(handler)

      // Simulate what the result-message handler does after parsing usage.input_tokens
      adapter['reportUsage'](sessionId, 1234)

      expect(handler).toHaveBeenCalledWith({
        sessionId,
        inputTokens: 1234,
        maxTokens: undefined,
      })

      adapter.offUsage(handler)
    })

    it('supports optional maxTokens', () => {
      const handler = vi.fn()
      adapter.onUsage(handler)

      adapter['reportUsage'](sessionId, 1000, 200_000)

      expect(handler).toHaveBeenCalledWith({
        sessionId,
        inputTokens: 1000,
        maxTokens: 200_000,
      })

      adapter.offUsage(handler)
    })
  })
})
