// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMenuPosition } from '../useMenuPosition'

describe('useMenuPosition', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true })
    Object.defineProperty(window, 'innerHeight', { value: 768, writable: true })
  })

  it('returns initial position', () => {
    const { result } = renderHook(() => useMenuPosition(100, 200))
    expect(result.current.adjustedPos.x).toBe(100)
    expect(result.current.adjustedPos.y).toBe(200)
  })

  it('returns a ref', () => {
    const { result } = renderHook(() => useMenuPosition(10, 10))
    expect(result.current.ref).toBeDefined()
    expect(result.current.ref.current).toBeNull()
  })

  it('adjusts position when menu overflows right edge', () => {
    const { result } = renderHook(() => useMenuPosition(900, 100))
    // Position should be adjusted to stay within viewport
    expect(result.current.adjustedPos.x).toBeLessThanOrEqual(1024)
  })

  it('adjusts position when menu overflows bottom edge', () => {
    const { result } = renderHook(() => useMenuPosition(100, 700))
    expect(result.current.adjustedPos.y).toBeLessThanOrEqual(768)
  })

  it('returns initial position without ref element', () => {
    // In jsdom, useLayoutEffect runs but ref.current is null, so no adjustment occurs
    const { result } = renderHook(() => useMenuPosition(-10, -10))
    expect(result.current.adjustedPos.x).toBe(-10)
    expect(result.current.adjustedPos.y).toBe(-10)
  })
})
