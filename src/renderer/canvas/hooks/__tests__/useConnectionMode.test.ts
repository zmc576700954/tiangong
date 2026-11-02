// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useConnectionMode } from '../useConnectionMode'
import { useToastStore } from '../../../lib/toast'
import type * as ToastModule from '../../../lib/toast'

/**
 * useConnectionMode 的静默失败测试。
 *
 * 背景：连线在**画布上已经画出来了**，但持久化到数据库可能失败。此前失败只
 * 记 console.error —— 用户看着画布上的线以为连上了，下次打开图却发现没有。
 */

const { createEdge } = vi.hoisted(() => ({ createEdge: vi.fn() }))

vi.mock('../../../lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof ToastModule>()
  return { ...actual, toastError: vi.fn() }
})

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'zh-CN' }),
}))

describe('useConnectionMode — 连线持久化失败不再静默', () => {
  let container: HTMLElement

  beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.getState().clear()
    createEdge.mockResolvedValue({ id: 'edge1' })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('createEdge 失败 → 错误 toast（画布上的线会消失，下次打开图也没有）', async () => {
    createEdge.mockRejectedValueOnce(new Error('edge boom'))

    const { result } = renderHook(() =>
      useConnectionMode({
        graphEdges: [],
        createEdge,
        graphId: 'g1',
        setRfEdges: vi.fn(),
      }),
    )

    // 起手：选中源节点
    act(() => {
      result.current.startConnect('src1')
    })

    // 造一个代表目标节点的 DOM 元素并点击它
    const target = document.createElement('div')
    target.setAttribute('data-id', 'target1')
    container.appendChild(target)

    await act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    const { toastError } = await import('../../../lib/toast')
    const mocked = toastError as unknown as { mock: { calls: unknown[][] } }
    expect(mocked.mock.calls).toHaveLength(1)
    expect(String(mocked.mock.calls[0][1])).toContain('edge boom')
  })
})
