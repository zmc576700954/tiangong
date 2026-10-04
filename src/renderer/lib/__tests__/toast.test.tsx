// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, screen, fireEvent, renderHook } from '@testing-library/react'
import { useToastStore, useToast } from '../toast'
import { ToastContainer } from '../../components/ui/ToastContainer'

/**
 * Toast 系统测试 — 覆盖显示/消失/error 持续/手动 dismiss 四个核心场景。
 *
 * 注：vitest + @testing-library/react 在基座版 renderer 测试栈中已可用。
 */

beforeEach(() => {
  // 每个 case 独立 store 状态
  useToastStore.setState({ toasts: [] })
  vi.useFakeTimers()
})

describe('useToast hook', () => {
  it('pushes a success toast and auto-removes it after default duration', () => {
    const { result } = renderHook(() => useToast())
    act(() => {
      result.current.success('Saved!')
    })
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(useToastStore.getState().toasts[0].kind).toBe('success')

    // success 默认 3000ms
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('shows an error toast with longer default duration', () => {
    const { result } = renderHook(() => useToast())
    act(() => {
      result.current.error('Boom')
    })
    expect(useToastStore.getState().toasts[0].kind).toBe('error')
    expect(useToastStore.getState().toasts[0].durationMs).toBe(5000)

    // 4999ms 时仍在
    act(() => vi.advanceTimersByTime(4999))
    expect(useToastStore.getState().toasts).toHaveLength(1)

    // 5000ms 时消失
    act(() => vi.advanceTimersByTime(1))
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('respects manual dismiss call', () => {
    const { result } = renderHook(() => useToast())
    let id = ''
    act(() => {
      id = result.current.info('Hello', 10000)
    })
    expect(useToastStore.getState().toasts).toHaveLength(1)
    act(() => {
      result.current.dismiss(id)
    })
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('renders message text inside ToastContainer', () => {
    const { result } = renderHook(() => useToast())
    render(<ToastContainer />)
    act(() => {
      result.current.info('hello-world-marker')
    })
    expect(screen.getByText('hello-world-marker')).toBeTruthy()

    // 点关闭按钮消失
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' })
    act(() => {
      fireEvent.click(dismissBtn)
    })
    expect(screen.queryByText('hello-world-marker')).toBeNull()
  })
})