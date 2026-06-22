import { describe, it, expect, beforeEach } from 'vitest'
import { BaseAdapter } from '../base'
import type { AgentSession } from '@shared/types'

// Minimal test subclass
class TestAdapter extends BaseAdapter {
  readonly name = 'test'
  readonly version = '0.0.1'

  async checkInstalled(): Promise<boolean> { return true }
  protected async doSendCommand(): Promise<void> { /* noop */ }
  protected async doTerminate(): Promise<void> { /* noop */ }
  async startSession(): Promise<AgentSession> { throw new Error('not needed') }
}

describe('BaseAdapter compaction', () => {
  let adapter: TestAdapter
  const sessionId = 'test-sess-1'

  beforeEach(() => {
    adapter = new TestAdapter()
    // Manually set up a session like startSession would
    const session: AgentSession = {
      id: sessionId,
      adapterName: 'test',
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
    adapter['sessions'].set(sessionId, session)
  })

  describe('compactBySummaryRewrite', () => {
    it('returns a summary CompactResult and clears the buffer', async () => {
      adapter['sessionOutputBuffers'].set(sessionId, [
        'Started analysing the codebase',
        'Found relevant file at src/app.ts',
        'Modified the auth flow',
      ])

      const result = await adapter.compactContext(sessionId, 'summary')

      expect(result.strategy).toBe('summary')
      expect(result.trigger).toBe('manual')
      expect(result.tokensBefore).toBeGreaterThan(0)
      expect(result.startedAt).toBeGreaterThan(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      // Buffer was cleared
      expect(adapter['sessionOutputBuffers'].get(sessionId)).toEqual([])
    })

    it('passes trigger reason through', async () => {
      adapter['sessionOutputBuffers'].set(sessionId, ['some output'])
      const result = await adapter.compactContext(sessionId, 'summary', { reason: 'auto-threshold' })
      expect(result.trigger).toBe('auto-threshold')
    })

    it('throws for unknown session', async () => {
      await expect(adapter.compactContext('nope', 'summary')).rejects.toThrow()
    })
  })

  describe('compactByNative', () => {
    it('throws by default', async () => {
      await expect(adapter.compactContext(sessionId, 'native')).rejects.toThrow(/NATIVE_COMPACT_NOT_SUPPORTED/)
    })
  })

  describe('compactByLlm', () => {
    it('throws by default', async () => {
      await expect(adapter.compactContext(sessionId, 'llm')).rejects.toThrow(/LLM_COMPACT_NOT_SUPPORTED/)
    })
  })

  describe('onUsage/offUsage', () => {
    it('subscribes and emits usage events', () => {
      const events: Array<{ sessionId: string; inputTokens: number }> = []
      const handler = (data: { sessionId: string; inputTokens: number }) => events.push(data)
      adapter.onUsage(handler)
      adapter['reportUsage']('s1', 5000)
      expect(events).toEqual([{ sessionId: 's1', inputTokens: 5000, maxTokens: undefined }])
      adapter.offUsage(handler)
      adapter['reportUsage']('s1', 6000)
      expect(events).toHaveLength(1)
    })
  })
})