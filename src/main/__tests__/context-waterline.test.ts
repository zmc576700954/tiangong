import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ContextWaterline } from '../memory/context-waterline'

describe('ContextWaterline', () => {
  let wl: ContextWaterline

  beforeEach(() => {
    wl = new ContextWaterline()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getRatio', () => {
    it('returns 0 for unknown threads', () => {
      expect(wl.getRatio('unknown')).toBe(0)
    })

    it('returns 0 when max is 0', () => {
      wl.onAdapterUsageReport('t1', 100, 0)
      expect(wl.getRatio('t1')).toBe(0)
    })

    it('capped at 1 when usage exceeds max', () => {
      wl.onAdapterUsageReport('t1', 300_000, 200_000)
      expect(wl.getRatio('t1')).toBe(1)
    })
  })

  describe('onMessagePersisted', () => {
    it('accumulates tokens', () => {
      wl.onMessagePersisted('t1', 42)
      const state = wl.getState('t1')!
      expect(state.tokensUsed).toBe(42)
    })

    it('emits change after throttle', () => {
      const handler = vi.fn()
      wl.onChange(handler)
      wl.onMessagePersisted('t1', 10)
      // hasn't fired yet — throttled
      expect(handler).not.toHaveBeenCalled()
      vi.advanceTimersByTime(600)
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('onAdapterUsageReport', () => {
    it('overrides estimated tokens with authoritative count', () => {
      wl.onMessagePersisted('t1', 10)
      wl.onAdapterUsageReport('t1', 500, 200_000)
      const state = wl.getState('t1')!
      expect(state.tokensUsed).toBe(500)
      expect(state.tokensMax).toBe(200_000)
    })
  })

  describe('onCompacted', () => {
    it('resets tokensUsed and stamps lastCompactedAt', () => {
      wl.onMessagePersisted('t1', 100)
      wl.onCompacted('t1', 300, 1_000_000)
      const state = wl.getState('t1')!
      expect(state.tokensUsed).toBe(300)
      expect(state.lastCompactedAt).toBe(1_000_000)
    })
  })

  describe('shouldAutoCompact', () => {
    it('returns false when disabled', () => {
      wl.autoCompactEnabled = false
      wl.onAdapterUsageReport('t1', 150_000, 200_000)
      expect(wl.shouldAutoCompact('t1')).toBe(false)
    })

    it('returns true when threshold exceeded', () => {
      wl.autoCompactEnabled = true
      wl.autoCompactThreshold = 0.5
      wl.onAdapterUsageReport('t1', 150_000, 200_000) // 75%
      expect(wl.shouldAutoCompact('t1')).toBe(true)
    })

    it('returns false when below threshold', () => {
      wl.autoCompactEnabled = true
      wl.autoCompactThreshold = 0.75
      wl.onAdapterUsageReport('t1', 100_000, 200_000) // 50%
      expect(wl.shouldAutoCompact('t1')).toBe(false)
    })

    it('respects minCompactInterval', () => {
      wl.autoCompactEnabled = true
      wl.autoCompactThreshold = 0.5
      wl.minCompactInterval = 999_999_999
      wl.onAdapterUsageReport('t1', 150_000, 200_000)
      wl.onCompacted('t1', 300, Date.now())
      expect(wl.shouldAutoCompact('t1')).toBe(false)
    })
  })

  describe('throttle', () => {
    it('coalesces multiple rapid changes into one event', () => {
      const handler = vi.fn()
      wl.onChange(handler)
      wl.onMessagePersisted('t1', 5)
      wl.onMessagePersisted('t1', 5)
      wl.onMessagePersisted('t1', 5)
      vi.advanceTimersByTime(600)
      expect(handler).toHaveBeenCalledTimes(1)
      // tokens should be accumulated (5+5+5)
      expect(wl.getState('t1')!.tokensUsed).toBe(15)
    })
  })

  describe('getState', () => {
    it('returns null for unknown thread', () => {
      expect(wl.getState('nonexistent')).toBeNull()
    })

    it('returns full ContextState for known thread', () => {
      wl.onAdapterUsageReport('t1', 100, 1000)
      const state = wl.getState('t1')!
      expect(state.threadId).toBe('t1')
      expect(state.tokensUsed).toBe(100)
      expect(state.tokensMax).toBe(1000)
      expect(state.ratio).toBeCloseTo(0.1)
      expect(state.lastCompactedAt).toBeNull()
      expect(state.updatedAt).toBeGreaterThan(0)
    })
  })

  describe('dbWriteback', () => {
    it('debounces dbWriteback on onMessagePersisted', () => {
      const writeback = vi.fn().mockResolvedValue(undefined)
      wl.setDbWriteback(writeback)
      wl.onMessagePersisted('t1', 42)
      // Not called yet — debounced
      expect(writeback).not.toHaveBeenCalled()
      vi.advanceTimersByTime(600)
      expect(writeback).toHaveBeenCalledWith('t1', 42)
    })

    it('debounces dbWriteback on onAdapterUsageReport', () => {
      const writeback = vi.fn().mockResolvedValue(undefined)
      wl.setDbWriteback(writeback)
      wl.onAdapterUsageReport('t1', 500, 200_000)
      // Not called yet — debounced
      expect(writeback).not.toHaveBeenCalled()
      vi.advanceTimersByTime(600)
      expect(writeback).toHaveBeenCalledWith('t1', 500)
    })

    it('calls dbWriteback immediately on onCompacted', () => {
      const writeback = vi.fn().mockResolvedValue(undefined)
      wl.setDbWriteback(writeback)
      wl.onCompacted('t1', 300, 1_000_000)
      // Compaction writes immediately — no debounce
      expect(writeback).toHaveBeenCalledWith('t1', 300)
    })

    it('coalesces rapid calls into one debounced write with latest value', () => {
      const writeback = vi.fn().mockResolvedValue(undefined)
      wl.setDbWriteback(writeback)
      wl.onMessagePersisted('t1', 10)
      wl.onMessagePersisted('t1', 10)
      wl.onAdapterUsageReport('t1', 500, 200_000)
      // Only one write after debounce, with the latest value (500)
      vi.advanceTimersByTime(600)
      expect(writeback).toHaveBeenCalledTimes(1)
      expect(writeback).toHaveBeenCalledWith('t1', 500)
    })

    it('onCompacted cancels pending debounced write', () => {
      const writeback = vi.fn().mockResolvedValue(undefined)
      wl.setDbWriteback(writeback)
      wl.onMessagePersisted('t1', 10)
      // Debounced write pending, but compaction writes immediately
      wl.onCompacted('t1', 300, 1_000_000)
      expect(writeback).toHaveBeenCalledTimes(1)
      expect(writeback).toHaveBeenCalledWith('t1', 300)
      // Advance timer — no additional write from the earlier debounce
      vi.advanceTimersByTime(600)
      expect(writeback).toHaveBeenCalledTimes(1)
    })

    it('does not call dbWriteback when not set', () => {
      // Should not throw
      wl.onMessagePersisted('t1', 42)
      expect(wl.getState('t1')!.tokensUsed).toBe(42)
    })
  })
})
