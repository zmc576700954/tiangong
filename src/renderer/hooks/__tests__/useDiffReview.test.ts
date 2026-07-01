// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDiffReview } from '../useDiffReview'

// Mock useAgentStore
const mockUpdateToolCallAccepted = vi.fn()
const mockUpdateAllToolCallsAccepted = vi.fn()

vi.mock('../../store/agentStore', () => ({
  useAgentStore: (selector: (s: { updateToolCallAccepted: typeof mockUpdateToolCallAccepted; updateAllToolCallsAccepted: typeof mockUpdateAllToolCallsAccepted }) => unknown) =>
    selector({
      updateToolCallAccepted: mockUpdateToolCallAccepted,
      updateAllToolCallsAccepted: mockUpdateAllToolCallsAccepted,
    }),
}))

// Mock window.electronAPI
const mockRollbackFile = vi.fn().mockResolvedValue(undefined)
const mockRollbackSession = vi.fn().mockResolvedValue(undefined)

Object.defineProperty(window, 'electronAPI', {
  value: {
    'scopeGuard:rollbackFile': mockRollbackFile,
    'scopeGuard:rollbackSession': mockRollbackSession,
  },
  writable: true,
})

describe('useDiffReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has correct initial state', () => {
    const { result } = renderHook(() => useDiffReview())

    expect(result.current.showDiffReview).toBe(false)
    expect(result.current.committing).toBe(false)
    expect(result.current.commitError).toBeNull()
  })

  it('setShowDiffReview toggles state', () => {
    const { result } = renderHook(() => useDiffReview())

    act(() => result.current.setShowDiffReview(true))
    expect(result.current.showDiffReview).toBe(true)

    act(() => result.current.setShowDiffReview(false))
    expect(result.current.showDiffReview).toBe(false)
  })

  it('setCommitting toggles state', () => {
    const { result } = renderHook(() => useDiffReview())

    act(() => result.current.setCommitting(true))
    expect(result.current.committing).toBe(true)
  })

  it('setCommitError sets error', () => {
    const { result } = renderHook(() => useDiffReview())

    act(() => result.current.setCommitError('some error'))
    expect(result.current.commitError).toBe('some error')
  })

  it('handleAcceptFile calls updateToolCallAccepted with true', () => {
    const { result } = renderHook(() => useDiffReview())

    act(() => result.current.handleAcceptFile('thread-1', 0, 1))

    expect(mockUpdateToolCallAccepted).toHaveBeenCalledWith('thread-1', 0, 1, true)
  })

  it('handleRejectFile calls updateToolCallAccepted with false', async () => {
    const { result } = renderHook(() => useDiffReview())

    await act(async () => {
      await result.current.handleRejectFile('thread-1', 0, 1, 'src/file.ts')
    })

    expect(mockUpdateToolCallAccepted).toHaveBeenCalledWith('thread-1', 0, 1, false)
  })

  it('handleRejectFile calls rollbackFile when sessionId provided', async () => {
    const { result } = renderHook(() => useDiffReview())

    await act(async () => {
      await result.current.handleRejectFile('thread-1', 0, 1, 'src/file.ts', 'sess-1')
    })

    expect(mockRollbackFile).toHaveBeenCalledWith('sess-1', 'src/file.ts')
  })

  it('handleRejectFile does not call rollbackFile without sessionId', async () => {
    const { result } = renderHook(() => useDiffReview())

    await act(async () => {
      await result.current.handleRejectFile('thread-1', 0, 1, 'src/file.ts')
    })

    expect(mockRollbackFile).not.toHaveBeenCalled()
  })

  it('handleAcceptAll calls updateAllToolCallsAccepted with true', () => {
    const { result } = renderHook(() => useDiffReview())

    act(() => result.current.handleAcceptAll('thread-1'))

    expect(mockUpdateAllToolCallsAccepted).toHaveBeenCalledWith('thread-1', true)
  })

  it('handleRejectAll calls updateAllToolCallsAccepted with false', async () => {
    const { result } = renderHook(() => useDiffReview())

    await act(async () => {
      await result.current.handleRejectAll('thread-1')
    })

    expect(mockUpdateAllToolCallsAccepted).toHaveBeenCalledWith('thread-1', false)
  })

  it('handleRejectAll calls rollbackSession when sessionId provided', async () => {
    const { result } = renderHook(() => useDiffReview())

    await act(async () => {
      await result.current.handleRejectAll('thread-1', 'sess-1')
    })

    expect(mockRollbackSession).toHaveBeenCalledWith('sess-1')
  })

  it('handleRejectAll does not call rollbackSession without sessionId', async () => {
    const { result } = renderHook(() => useDiffReview())

    await act(async () => {
      await result.current.handleRejectAll('thread-1')
    })

    expect(mockRollbackSession).not.toHaveBeenCalled()
  })

  it('handleRejectFile handles rollback error gracefully', async () => {
    mockRollbackFile.mockRejectedValueOnce(new Error('network error'))
    const { result } = renderHook(() => useDiffReview())

    // Should not throw
    await act(async () => {
      await result.current.handleRejectFile('thread-1', 0, 1, 'src/file.ts', 'sess-1')
    })

    expect(mockUpdateToolCallAccepted).toHaveBeenCalledWith('thread-1', 0, 1, false)
  })
})
