import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cn, generateId, formatDate, formatTime, debounce, getNodeStatusClass } from '../../lib/utils'

describe('cn', () => {
  it('merges tailwind classes correctly', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
  })

  it('handles conditional classes', () => {
    const shouldHide = false
    expect(cn('base', shouldHide && 'hidden', 'block')).toBe('base block')
  })
})

describe('generateId', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue('550e8400-e29b-41d4-a716-446655440000') })
  })

  it('returns prefixed id without dashes', () => {
    expect(generateId('node')).toBe('node-550e8400e29b41d4a716446655440000')
  })
})

describe('formatDate', () => {
  it('formats a date string', () => {
    const result = formatDate('2024-01-15T08:30:00.000Z')
    expect(result).toContain('2024')
  })

  it('formats a Date object', () => {
    const result = formatDate(new Date('2024-01-15T08:30:00.000Z'))
    expect(result).toContain('2024')
  })
})

describe('formatTime', () => {
  it('formats a timestamp', () => {
    const result = formatTime(new Date('2024-01-15T08:30:00.000Z').getTime())
    expect(result).toMatch(/\d{2}:\d{2}/)
  })
})

describe('debounce', () => {
  it('delays execution', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const debounced = debounce(fn, 100)
    debounced(1)
    debounced(2)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(2)
    vi.useRealTimers()
  })
})

describe('getNodeStatusClass', () => {
  it('returns mapped class for known statuses', () => {
    expect(getNodeStatusClass('developing')).toBe('node-status-developing')
    expect(getNodeStatusClass('published')).toBe('node-status-published')
  })

  it('defaults to draft class for unknown status', () => {
    expect(getNodeStatusClass('unknown')).toBe('node-status-draft')
  })
})
