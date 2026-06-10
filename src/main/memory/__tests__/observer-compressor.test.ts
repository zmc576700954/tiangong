/**
 * ObserverCompressor 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ObserverCompressor, DEFAULT_COMPRESSOR_CONFIG } from '../observer-compressor'
import type { AgentOutput } from '@shared/types'

describe('ObserverCompressor', () => {
  let compressor: ObserverCompressor

  /** Helper: create a stdout output */
  function stdout(data: string): AgentOutput {
    return { type: 'stdout', data, timestamp: Date.now() }
  }

  beforeEach(() => {
    compressor = new ObserverCompressor({
      compressThresholdTokens: 200, // low threshold for testing
      minCompressIntervalMs: 0,     // no interval for testing
      bufferRetentionRatio: 0.2,
      verbose: false,
    })
  })

  describe('feed', () => {
    it('accumulates text without triggering compression below threshold', () => {
      const result = compressor.feed(stdout('Short message'))
      expect(result).toBeNull()
      const stats = compressor.getStats()
      expect(stats.chunksProcessed).toBe(1)
    })

    it('triggers compression when buffer exceeds threshold', () => {
      // Generate enough text to exceed 200 token threshold (~800 chars)
      const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
      const result = compressor.feed(stdout(longText))
      expect(result).not.toBeNull()
      if (result) {
        expect(result.summary.length).toBeGreaterThan(0)
        expect(result.inputTokens).toBeGreaterThan(0)
        expect(result.keyTerms.length).toBeGreaterThan(0)
        expect(result.compressionRatio).toBeLessThanOrEqual(1)
      }
    })

    it('detects phase signals', () => {
      const text = 'Build success. All tests passed ✓. Task done. '.repeat(50)
      const result = compressor.feed(stdout(text))
      expect(result).not.toBeNull()
      expect(result?.phaseSignal).toBe('done')
    })

    it('detects error signals', () => {
      const text = 'Error: Compilation failed. Exception thrown. Some tests fail ❌. '.repeat(50)
      const result = compressor.feed(stdout(text))
      expect(result).not.toBeNull()
      expect(result?.phaseSignal).toBe('error')
    })

    it('ignores feed after finalize', () => {
      compressor.finalize()
      const result = compressor.feed(stdout('Some text after finalize'))
      expect(result).toBeNull()
      const stats = compressor.getStats()
      expect(stats.finalized).toBe(true)
    })

    it('extracts file changes from text', () => {
      const text = ('Modified: src/main/foo.ts\nChanged: src/shared/types.ts\n'.repeat(30))
      const result = compressor.feed(stdout(text))
      expect(result).not.toBeNull()
      if (result) {
        expect(result.filesChanged.length).toBeGreaterThan(0)
      }
    })

    it('extracts CamelCase terms', () => {
      const text = ('Using SessionRouter to route requests. AdapterRegistry handles registration. '.repeat(50))
      const result = compressor.feed(stdout(text))
      expect(result).not.toBeNull()
      if (result) {
        const hasCamelTerm = result.keyTerms.some((t) =>
          t === 'SessionRouter' || t === 'AdapterRegistry',
        )
        expect(hasCamelTerm).toBe(true)
      }
    })
  })

  describe('flush', () => {
    it('flushes remaining buffer', () => {
      compressor.feed(stdout('Some content that has been accumulating. '.repeat(5)))
      const stats = compressor.getStats()
      expect(stats.observationCount).toBe(0) // not enough to auto-compress

      const result = compressor.flush()
      expect(result).not.toBeNull()
      expect(compressor.getStats().observationCount).toBe(1)
    })

    it('returns null for empty buffer', () => {
      const result = compressor.flush()
      expect(result).toBeNull()
    })
  })

  describe('finalize', () => {
    it('returns all observations and marks as finalized', () => {
      // Feed enough to trigger multiple compressions
      const longText = 'Working on feature implementation. Module A processing. '.repeat(100)
      compressor.feed(stdout(longText))
      compressor.feed(stdout('Step 2: Testing. '.repeat(30)))

      const observations = compressor.finalize()
      expect(observations.length).toBeGreaterThan(0)
      expect(compressor.getStats().finalized).toBe(true)
    })

    it('finalize is idempotent', () => {
      const text = 'Some text to compress. '.repeat(40)
      compressor.feed(stdout(text))
      const first = compressor.finalize()
      const second = compressor.finalize()
      expect(first.length).toBe(second.length)
      expect(compressor.getStats().observationCount).toBe(first.length)
    })
  })

  describe('generateMemories', () => {
    it('generates MemoryItem list from observations', () => {
      const text = 'Modified: src/app.ts\nFixed bug in router. Architecture decision: use observer pattern. Task done. '.repeat(80)
      compressor.feed(stdout(text))
      compressor.finalize()

      const memories = compressor.generateMemories('session-123', {
        projectId: 'project-x',
        nodeId: 'node-1',
        adapterName: 'claude-code',
      })

      expect(memories.length).toBeGreaterThan(0)
      for (const mem of memories) {
        expect(mem.session_id).toBe('session-123')
        expect(mem.project_id).toBe('project-x')
        expect(mem.adapter_name).toBe('claude-code')
        expect(mem.title.startsWith('[Obs #')).toBe(true)
        expect(mem.narrative.length).toBeGreaterThan(0)
        expect(mem.facts.length).toBeGreaterThan(0)
        expect(mem.concepts.length).toBeGreaterThan(0)
        expect(mem.token_cost).toBeGreaterThan(0)
        expect(['investigation', 'fix', 'review_finding', 'pattern', 'lesson', 'decision']).toContain(mem.kind)
      }
    })

    it('skips observations with empty summary', () => {
      // Feed only short content, flush produces tiny summary
      compressor.feed(stdout('hi'))
      compressor.finalize()

      // The compressor may or may not produce an observation
      // depending on whether the short text triggers compression
      const memories = compressor.generateMemories('session-123', {
        adapterName: 'codex',
      })
      // For truly empty summaries (trimmed length 0), generateMemories skips them
      for (const mem of memories) {
        expect(mem.narrative.trim().length).toBeGreaterThan(0)
      }
    })
  })

  describe('reset', () => {
    it('clears all state', () => {
      const text = 'Data to be reset. '.repeat(100)
      compressor.feed(stdout(text))
      compressor.reset()

      const stats = compressor.getStats()
      expect(stats.chunksProcessed).toBe(0)
      expect(stats.observationCount).toBe(0)
      expect(stats.totalInputTokens).toBe(0)
      expect(stats.totalOutputTokens).toBe(0)
      expect(stats.finalized).toBe(false)
    })
  })

  describe('getStats', () => {
    it('returns correct statistics', () => {
      const text = 'Statistical analysis of the compression system. '.repeat(100)
      compressor.feed(stdout(text))
      compressor.finalize()

      const stats = compressor.getStats()
      expect(stats.chunksProcessed).toBeGreaterThan(0)
      expect(stats.observationCount).toBeGreaterThan(0)
      expect(stats.totalInputTokens).toBeGreaterThan(0)
      expect(stats.totalOutputTokens).toBeGreaterThan(0)
      expect(stats.overallCompressionRatio).toBeGreaterThan(0)
      expect(stats.overallCompressionRatio).toBeLessThanOrEqual(1)
      expect(stats.finalized).toBe(true)
    })
  })

  describe('default config', () => {
    it('uses sensible defaults', () => {
      expect(DEFAULT_COMPRESSOR_CONFIG.compressThresholdTokens).toBe(4000)
      expect(DEFAULT_COMPRESSOR_CONFIG.minCompressIntervalMs).toBe(5000)
      expect(DEFAULT_COMPRESSOR_CONFIG.bufferRetentionRatio).toBe(0.2)
    })
  })
})
