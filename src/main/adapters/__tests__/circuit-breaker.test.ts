import { describe, test, expect, vi } from 'vitest'
import { AdapterCircuitBreaker } from '../circuit-breaker'

describe('AdapterCircuitBreaker', () => {
  test('starts in closed state', () => {
    const cb = new AdapterCircuitBreaker()
    expect(cb.getState('test')).toBe('closed')
    expect(cb.isCircuitOpen('test')).toBe(false)
  })

  test('opens after failure threshold', () => {
    const cb = new AdapterCircuitBreaker({ failureThreshold: 3, openDurationMs: 30000 })
    cb.recordFailure('test')
    cb.recordFailure('test')
    cb.recordFailure('test')
    expect(cb.getState('test')).toBe('open')
    expect(cb.isCircuitOpen('test')).toBe(true)
  })

  test('transitions to half-open after cooldown', () => {
    vi.useFakeTimers()
    const cb = new AdapterCircuitBreaker({ failureThreshold: 2, openDurationMs: 5000 })
    cb.recordFailure('test')
    cb.recordFailure('test')
    expect(cb.getState('test')).toBe('open')
    vi.advanceTimersByTime(5001)
    expect(cb.getState('test')).toBe('half-open')
    expect(cb.isCircuitOpen('test')).toBe(false)
    vi.useRealTimers()
  })

  test('closes after success in half-open', () => {
    const cb = new AdapterCircuitBreaker({ failureThreshold: 2, openDurationMs: 1000 })
    cb.recordFailure('test')
    cb.recordFailure('test')
    cb['_states'].get('test')!.state = 'half-open'
    cb.recordSuccess('test')
    expect(cb.getState('test')).toBe('closed')
  })

  test('re-opens on failure in half-open', () => {
    const cb = new AdapterCircuitBreaker({ failureThreshold: 2, openDurationMs: 1000 })
    cb.recordFailure('test')
    cb.recordFailure('test')
    cb['_states'].get('test')!.state = 'half-open'
    cb.recordFailure('test')
    expect(cb.getState('test')).toBe('open')
  })
})
