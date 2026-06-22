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
      wl.onMessagePersisted('t1', 'hello')
      const state = wl.getState('t1')!
      expect(state.tokensUsed).toBeGreaterThan(0)
    })

    it('emits change after throttle', () => {
      const handler = vi.fn()
      wl.onChange(handler)
      wl.onMessagePersisted('t1', 'hello world')
      // hasn't fired yet — throttled
      expect(handler).not.toHaveBeenCalled()
      vi.advanceTimersByTime(600)
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('onAdapterUsageReport', () => {
    it('overrides estimated tokens with authoritative count', () => {
      wl.onMessagePersisted('t1', 'hello world')
      wl.onAdapterUsageReport('t1', 500, 200_000)
      const state = wl.getState('t1')!
      expect(state.tokensUsed).toBe(500)
      expect(state.tokensMax).toBe(200_000)
    })
  })

  describe('onCompacted', () => {
    it('resets tokensUsed and stamps lastCompactedAt', () => {
      wl.onMessagePersisted('t1', 'some long text')
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
      wl.onMessagePersisted('t1', 'a')
      wl.onMessagePersisted('t1', 'b')
      wl.onMessagePersisted('t1', 'c')
      vi.advanceTimersByTime(600)
      expect(handler).toHaveBeenCalledTimes(1)
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
})
