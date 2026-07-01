// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVerificationFlow } from '../useVerificationFlow'
import type { ChatMessage, AgentOutput, VerificationReport } from '@shared/types'

const mockVerify = vi.fn()

Object.defineProperty(window, 'electronAPI', {
  value: {
    'agent:verify': mockVerify,
  },
  writable: true,
})

function makeThread(overrides?: { status?: string; messages?: ChatMessage[] }) {
  return {
    id: 'thread-1',
    status: overrides?.status ?? 'idle',
    messages: overrides?.messages ?? [],
  }
}

function makeNode(overrides?: { acceptanceCriteria?: string[] }) {
  return {
    id: 'node-1',
    acceptanceCriteria: overrides?.acceptanceCriteria ?? ['Works correctly'],
  }
}

describe('useVerificationFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has correct initial state', () => {
    const { result } = renderHook(() =>
      useVerificationFlow(makeThread(), makeNode(), [], '/project'),
    )

    expect(result.current.showVerification).toBe(false)
    expect(result.current.verificationReport).toBeNull()
    expect(result.current.verifying).toBe(false)
    expect(result.current.verifyError).toBeNull()
    expect(result.current.retryCount).toBe(0)
  })

  it('startVerification calls agent:verify and sets report', async () => {
    const report: VerificationReport = {
      passed: true,
      criteria: [{ criterion: 'Works correctly', passed: true, evidence: 'Test passed' }],
      summary: 'All criteria met',
    }
    mockVerify.mockResolvedValue(report)

    const { result } = renderHook(() =>
      useVerificationFlow(makeThread(), makeNode(), [], '/project'),
    )

    await act(async () => {
      await result.current.startVerification({
        nodeId: 'node-1',
        acceptanceCriteria: ['Works correctly'],
        messages: [],
        fileChanges: [],
        workingDirectory: '/project',
      })
    })

    expect(mockVerify).toHaveBeenCalledWith({
      nodeId: 'node-1',
      acceptanceCriteria: ['Works correctly'],
      messages: [],
      fileChanges: [],
      workingDirectory: '/project',
    })
    expect(result.current.showVerification).toBe(true)
    expect(result.current.verifying).toBe(false)
    expect(result.current.verificationReport).toEqual(report)
  })

  it('startVerification handles errors', async () => {
    mockVerify.mockRejectedValue(new Error('API error'))

    const { result } = renderHook(() =>
      useVerificationFlow(makeThread(), makeNode(), [], '/project'),
    )

    await act(async () => {
      await result.current.startVerification({
        nodeId: 'node-1',
        acceptanceCriteria: ['Works correctly'],
        messages: [],
        fileChanges: [],
        workingDirectory: '/project',
      })
    })

    expect(result.current.verifyError).toBe('Verification failed. Please try again manually.')
    expect(result.current.verifying).toBe(false)
  })

  it('resetVerification clears all state', async () => {
    mockVerify.mockResolvedValue({ passed: true, criteria: [], summary: 'ok' })

    const { result } = renderHook(() =>
      useVerificationFlow(makeThread(), makeNode(), [], '/project'),
    )

    await act(async () => {
      await result.current.startVerification({
        nodeId: 'node-1',
        acceptanceCriteria: [],
        messages: [],
        fileChanges: [],
        workingDirectory: '/project',
      })
    })

    act(() => result.current.resetVerification())

    expect(result.current.showVerification).toBe(false)
    expect(result.current.verificationReport).toBeNull()
    expect(result.current.verifyError).toBeNull()
  })

  it('setShowVerification toggles state', () => {
    const { result } = renderHook(() =>
      useVerificationFlow(makeThread(), makeNode(), [], '/project'),
    )

    act(() => result.current.setShowVerification(true))
    expect(result.current.showVerification).toBe(true)
  })

  it('setVerifyError sets error message', () => {
    const { result } = renderHook(() =>
      useVerificationFlow(makeThread(), makeNode(), [], '/project'),
    )

    act(() => result.current.setVerifyError('custom error'))
    expect(result.current.verifyError).toBe('custom error')
  })

  it('setRetryCount updates retry count', () => {
    const { result } = renderHook(() =>
      useVerificationFlow(makeThread(), makeNode(), [], '/project'),
    )

    act(() => result.current.setRetryCount(3))
    expect(result.current.retryCount).toBe(3)
  })

  it('pendingRetryRef is a ref object', () => {
    const { result } = renderHook(() =>
      useVerificationFlow(makeThread(), makeNode(), [], '/project'),
    )

    expect(result.current.pendingRetryRef).toBeDefined()
    expect(result.current.pendingRetryRef.current).toBe(false)
  })
})
