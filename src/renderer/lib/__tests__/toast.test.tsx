// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ToastContainer, useToastStore, pushToast, toastSuccess, toastError, toastInfo } from '../toast'

describe('Toast system', () => {
  beforeEach(() => {
    useToastStore.getState().clear()
  })

  it('pushToast 推入一条 success toast', () => {
    render(<ToastContainer />)
    act(() => {
      pushToast({ kind: 'success', title: '采纳成功' })
    })
    expect(screen.getByTestId('toast-success').textContent).toContain('采纳成功')
  })

  it('便捷方法 toastSuccess / toastError / toastInfo 都触发 push', () => {
    render(<ToastContainer />)
    act(() => {
      toastSuccess('OK')
      toastError('失败', '数据库不可达')
      toastInfo('提示')
    })
    expect(screen.getByTestId('toast-success').textContent).toContain('OK')
    expect(screen.getByTestId('toast-error').textContent).toContain('失败')
    expect(screen.getByTestId('toast-error').textContent).toContain('数据库不可达')
    expect(screen.getByTestId('toast-info').textContent).toContain('提示')
  })

  it('点击关闭按钮移除 toast', () => {
    render(<ToastContainer />)
    act(() => {
      toastSuccess('待关闭')
    })
    const closeBtn = screen.getByLabelText('关闭通知')
    fireEvent.click(closeBtn)
    expect(screen.queryByText('待关闭')).toBeNull()
  })

  it('auto-dismiss 在 durationMs 后自动消失', () => {
    vi.useFakeTimers()
    render(<ToastContainer />)
    act(() => {
      pushToast({ kind: 'info', title: '自动消失', durationMs: 1000 })
    })
    expect(screen.getByText('自动消失')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1100)
    })
    expect(screen.queryByText('自动消失')).toBeNull()
    vi.useRealTimers()
  })

  it('durationMs = 0 表示不自动消失', () => {
    vi.useFakeTimers()
    render(<ToastContainer />)
    act(() => {
      pushToast({ kind: 'info', title: '持久', durationMs: 0 })
    })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.getByText('持久')).toBeTruthy()
    vi.useRealTimers()
  })

  it('clear() 清空所有 toast', () => {
    render(<ToastContainer />)
    act(() => {
      toastSuccess('A')
      toastInfo('B')
    })
    expect(useToastStore.getState().toasts).toHaveLength(2)
    act(() => {
      useToastStore.getState().clear()
    })
    expect(screen.queryByText('A')).toBeNull()
    expect(screen.queryByText('B')).toBeNull()
  })
})