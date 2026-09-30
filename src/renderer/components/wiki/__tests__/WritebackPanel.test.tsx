// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WritebackPanel } from '../WritebackPanel'
import type { WritebackItem } from '@shared/types/wiki'

/** 本仓库未配置 @testing-library/jest-dom，自行实现最小断言。 */
function expectDisabled(el: HTMLElement): void {
  expect(el.hasAttribute('disabled')).toBe(true)
}

function makeItem(overrides: Partial<WritebackItem> = {}): WritebackItem {
  return {
    id: 'w1',
    graphId: 'g1',
    kind: 'append-log',
    targetNodeId: 'n1',
    title: '会话日志 2026-08-01',
    content: '本次会话完成了登录功能的开发与测试。',
    sourceSessionId: 's1',
    confidence: 0.82,
    status: 'pending',
    createdAt: '2026-08-01T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  }
}

interface RenderOptions {
  items?: WritebackItem[]
  pendingIds?: Set<string>
  lastError?: string | null
  onAccept?: (id: string) => void
  onDiscard?: (id: string) => void
  onBatchAccept?: (ids: string[]) => void
  onBatchDiscard?: (ids: string[]) => void
  onNavigate?: (id: string) => void
  onClose?: () => void
  onDismissError?: () => void
}

function renderPanel(opts: RenderOptions = {}) {
  const onAccept = opts.onAccept ?? vi.fn()
  const onDiscard = opts.onDiscard ?? vi.fn()
  const onBatchAccept = opts.onBatchAccept ?? vi.fn()
  const onBatchDiscard = opts.onBatchDiscard ?? vi.fn()
  const onNavigate = opts.onNavigate ?? vi.fn()
  const onClose = opts.onClose ?? vi.fn()
  const onDismissError = opts.onDismissError ?? vi.fn()
  const result = render(
    <WritebackPanel
      items={opts.items ?? [makeItem()]}
      pendingIds={opts.pendingIds ?? new Set()}
      lastError={opts.lastError}
      onAccept={onAccept}
      onDiscard={onDiscard}
      onBatchAccept={onBatchAccept}
      onBatchDiscard={onBatchDiscard}
      onNavigate={onNavigate}
      onClose={onClose}
      onDismissError={onDismissError}
    />,
  )
  return { ...result, onAccept, onDiscard, onBatchAccept, onBatchDiscard, onNavigate, onClose, onDismissError }
}

describe('WritebackPanel — basics', () => {
  it('renders items with kind badges and titles', () => {
    renderPanel({
      items: [
        makeItem({ id: 'w1', kind: 'append-log', title: '追加到日志页' }),
        makeItem({ id: 'w2', kind: 'new-page', title: '新页面：部署流程' }),
      ],
    })

    expect(screen.getByText('审核队列')).toBeTruthy()
    expect(screen.getByText(/待审核 2/)).toBeTruthy()
    expect(screen.getByText('追加日志')).toBeTruthy()
    expect(screen.getByText('新页面')).toBeTruthy()
    expect(screen.getByText('追加到日志页')).toBeTruthy()
    expect(screen.getByText('新页面：部署流程')).toBeTruthy()
  })

  it('calls onAccept / onDiscard with item id when clicking action buttons', () => {
    const { onAccept, onDiscard } = renderPanel({
      items: [makeItem({ id: 'w-accept' })],
    })

    fireEvent.click(screen.getByText('采纳'))
    expect(onAccept).toHaveBeenCalledWith('w-accept')

    fireEvent.click(screen.getByText('丢弃'))
    expect(onDiscard).toHaveBeenCalledWith('w-accept')
  })

  it('renders empty state when items is empty', () => {
    renderPanel({ items: [] })

    expect(screen.getByText('暂无待审核的写回项')).toBeTruthy()
    expect(screen.getByText(/待审核 0/)).toBeTruthy()
  })

  it('displays confidence as a percentage', () => {
    renderPanel({ items: [makeItem({ confidence: 0.82 })] })

    expect(screen.getByText('82%')).toBeTruthy()
  })

  it('renders 0% when confidence is NaN', () => {
    renderPanel({ items: [makeItem({ confidence: NaN as unknown as number })] })

    expect(screen.getByText('0%')).toBeTruthy()
  })

  it('append-log row 定位 button calls onNavigate with targetNodeId', () => {
    const { onNavigate } = renderPanel({
      items: [makeItem({ id: 'w1', kind: 'append-log', targetNodeId: 'n-target' })],
    })

    fireEvent.click(screen.getByText('定位'))
    expect(onNavigate).toHaveBeenCalledWith('n-target')
  })

  it('new-page row does not render 定位 button', () => {
    renderPanel({ items: [makeItem({ id: 'w2', kind: 'new-page' })] })

    expect(screen.queryByText('定位')).toBeNull()
  })

  it('action buttons are real buttons, focusable and receive keyboard events', () => {
    const { onAccept } = renderPanel({ items: [makeItem({ id: 'w-kb' })] })

    const acceptBtn = screen.getByText('采纳')
    const discardBtn = screen.getByText('丢弃')
    const navigateBtn = screen.getByText('定位')
    const closeBtn = screen.getByTitle('关闭')

    for (const btn of [acceptBtn, discardBtn, navigateBtn, closeBtn]) {
      expect(btn.tagName).toBe('BUTTON')
      expect((btn as HTMLButtonElement).type).toBe('button')
      btn.focus()
      expect(document.activeElement).toBe(btn)
    }
    fireEvent.keyDown(acceptBtn, { key: 'Enter' })
    fireEvent.click(acceptBtn)
    expect(onAccept).toHaveBeenCalledWith('w-kb')
  })
})

describe('WritebackPanel — preview & structured fields', () => {
  it('renders content as Markdown (h2 heading shown, bullet list shown)', () => {
    renderPanel({
      items: [
        makeItem({
          id: 'w-md',
          content: '## 子标题\n\n- 第一条\n- 第二条\n',
        }),
      ],
    })

    // react-markdown 渲染 h2 + ul/li
    expect(screen.getByRole('heading', { level: 2, name: '子标题' })).toBeTruthy()
    expect(screen.getByText('第一条')).toBeTruthy()
    expect(screen.getByText('第二条')).toBeTruthy()
  })

  it('expands to show details when 展开详情 clicked', () => {
    renderPanel({
      items: [
        makeItem({
          id: 'w-expand',
          details: '### 子项\n\n细节内容',
          narrative: '会话叙事 TL;DR',
        }),
      ],
    })

    // 初始折叠
    expect(screen.queryByText('细节内容')).toBeNull()

    fireEvent.click(screen.getByText('展开详情'))

    // 展开后可见
    expect(screen.getByRole('heading', { level: 3, name: '子项' })).toBeTruthy()
    expect(screen.getByText('细节内容')).toBeTruthy()
    // narrative 折叠时也展示一行 TL;DR；展开后仍在展开区可见
    expect(screen.getAllByText(/会话叙事 TL;DR/).length).toBeGreaterThanOrEqual(1)
  })

  it('renders source node chips for new-page items when expanded', () => {
    const { onNavigate } = renderPanel({
      items: [
        makeItem({
          id: 'w-src',
          kind: 'new-page',
          sourceNodeIds: ['node_alpha', 'node_beta'],
          targetNodeTitle: '源节点标题',
        }),
      ],
    })

    fireEvent.click(screen.getByText('展开详情'))

    const chipAlpha = screen.getByTitle('定位到 node_alpha')
    const chipBeta = screen.getByTitle('定位到 node_beta')
    expect(chipAlpha).toBeTruthy()
    expect(chipBeta).toBeTruthy()
    expect(screen.getByText('源节点标题')).toBeTruthy()

    fireEvent.click(chipAlpha)
    expect(onNavigate).toHaveBeenCalledWith('node_alpha')
  })
})

describe('WritebackPanel — batch selection', () => {
  it('shows selection count when items selected', () => {
    renderPanel({
      items: [makeItem({ id: 'w1' }), makeItem({ id: 'w2' })],
    })

    // 初始未选
    expect(screen.queryByText(/已选/)).toBeNull()

    // 选择第一项
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    expect(screen.getByText(/已选 1/)).toBeTruthy()
  })

  it('全选 按钮 选中所有可选项', () => {
    const { onBatchAccept } = renderPanel({
      items: [makeItem({ id: 'w1' }), makeItem({ id: 'w2' }), makeItem({ id: 'w3' })],
    })

    fireEvent.click(screen.getByText('全选'))
    expect(screen.getByText(/已选 3/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('batch-accept'))
    expect(onBatchAccept).toHaveBeenCalledWith(['w1', 'w2', 'w3'])
  })

  it('全选 后再点切到 全不选', () => {
    renderPanel({
      items: [makeItem({ id: 'w1' }), makeItem({ id: 'w2' })],
    })

    fireEvent.click(screen.getByText('全选'))
    expect(screen.getByText(/已选 2/)).toBeTruthy()

    fireEvent.click(screen.getByText('全不选'))
    expect(screen.queryByText(/已选/)).toBeNull()
  })

  it('批量丢弃 仅触发 onBatchDiscard（不含 onDiscard 单项）', () => {
    const { onBatchDiscard, onDiscard } = renderPanel({
      items: [makeItem({ id: 'w1' }), makeItem({ id: 'w2' })],
    })

    fireEvent.click(screen.getByText('全选'))
    fireEvent.click(screen.getByTestId('batch-discard'))

    expect(onBatchDiscard).toHaveBeenCalledWith(['w1', 'w2'])
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('batch buttons are disabled when nothing selected', () => {
    renderPanel({
      items: [makeItem({ id: 'w1' })],
    })

    expectDisabled(screen.getByTestId('batch-accept'))
    expectDisabled(screen.getByTestId('batch-discard'))
  })
})

describe('WritebackPanel — in-flight 守卫', () => {
  it('pending 项目禁用 checkbox 和按钮', () => {
    const { onAccept } = renderPanel({
      items: [makeItem({ id: 'w-pending' })],
      pendingIds: new Set(['w-pending']),
    })

    const checkbox = screen.getByRole('checkbox')
    expectDisabled(checkbox)

    // 按钮变为「处理中…」文案 + disabled
    const acceptBtn = screen.getByTestId('accept-w-pending')
    const discardBtn = screen.getByTestId('discard-w-pending')
    expectDisabled(acceptBtn)
    expectDisabled(discardBtn)
    expect(acceptBtn.textContent).toContain('处理中')

    fireEvent.click(acceptBtn)
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('未在 pendingIds 中的项目仍可点击', () => {
    const { onAccept } = renderPanel({
      items: [
        makeItem({ id: 'w-busy' }),
        makeItem({ id: 'w-free' }),
      ],
      pendingIds: new Set(['w-busy']),
    })

    fireEvent.click(screen.getByTestId('accept-w-free'))
    expect(onAccept).toHaveBeenCalledWith('w-free')
  })
})

describe('WritebackPanel — 错误展示', () => {
  it('shows lastError banner when provided', () => {
    renderPanel({ lastError: '目标节点已被删除' })

    const banner = screen.getByTestId('writeback-error-banner')
    expect(banner.textContent).toContain('目标节点已被删除')
  })

  it('clicking X in banner calls onDismissError', () => {
    const { onDismissError } = renderPanel({ lastError: 'Boom' })

    fireEvent.click(screen.getByLabelText('关闭错误提示'))
    expect(onDismissError).toHaveBeenCalled()
  })

  it('does not show banner when lastError is null/undefined', () => {
    renderPanel({ lastError: null })

    expect(screen.queryByTestId('writeback-error-banner')).toBeNull()
  })
})

describe('WritebackPanel — 选中状态清理', () => {
  it('item 不再在列表时从 selected 集合移除', () => {
    const items1 = [makeItem({ id: 'w1' }), makeItem({ id: 'w2' })]
    const items2 = [makeItem({ id: 'w1' })] // w2 已不存在

    const { rerender } = render(
      <WritebackPanel
        items={items1}
        pendingIds={new Set()}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onBatchAccept={vi.fn()}
        onBatchDiscard={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('全选'))
    expect(screen.getByText(/已选 2/)).toBeTruthy()

    rerender(
      <WritebackPanel
        items={items2}
        pendingIds={new Set()}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onBatchAccept={vi.fn()}
        onBatchDiscard={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    // 只剩 1 个 item，selected 应只剩 w1
    expect(screen.getByText(/已选 1/)).toBeTruthy()
  })
})