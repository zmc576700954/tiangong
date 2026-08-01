// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WritebackPanel } from '../WritebackPanel'
import type { WritebackItem } from '@shared/types/wiki'

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

describe('WritebackPanel', () => {
  it('renders items with kind badges and titles', () => {
    render(
      <WritebackPanel
        items={[
          makeItem({ id: 'w1', kind: 'append-log', title: '追加到日志页' }),
          makeItem({ id: 'w2', kind: 'new-page', title: '新页面：部署流程' }),
        ]}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('审核队列')).toBeTruthy()
    expect(screen.getByText('待审核 2')).toBeTruthy()
    expect(screen.getByText('追加日志')).toBeTruthy()
    expect(screen.getByText('新页面')).toBeTruthy()
    expect(screen.getByText('追加到日志页')).toBeTruthy()
    expect(screen.getByText('新页面：部署流程')).toBeTruthy()
  })

  it('calls onAccept / onDiscard with item id when clicking action buttons', () => {
    const onAccept = vi.fn()
    const onDiscard = vi.fn()
    render(
      <WritebackPanel
        items={[makeItem({ id: 'w-accept' })]}
        onAccept={onAccept}
        onDiscard={onDiscard}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('采纳'))
    expect(onAccept).toHaveBeenCalledWith('w-accept')

    fireEvent.click(screen.getByText('丢弃'))
    expect(onDiscard).toHaveBeenCalledWith('w-accept')
  })

  it('renders empty state when items is empty', () => {
    render(
      <WritebackPanel
        items={[]}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('暂无待审核的写回项')).toBeTruthy()
    expect(screen.getByText('待审核 0')).toBeTruthy()
  })

  it('displays confidence as a percentage', () => {
    render(
      <WritebackPanel
        items={[makeItem({ confidence: 0.82 })]}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('82%')).toBeTruthy()
  })

  it('renders 0% when confidence is NaN', () => {
    render(
      <WritebackPanel
        items={[makeItem({ confidence: NaN as unknown as number })]}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('0%')).toBeTruthy()
  })

  it('append-log row 定位 button calls onNavigate with targetNodeId', () => {
    const onNavigate = vi.fn()
    render(
      <WritebackPanel
        items={[makeItem({ id: 'w1', kind: 'append-log', targetNodeId: 'n-target' })]}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onNavigate={onNavigate}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('定位'))
    expect(onNavigate).toHaveBeenCalledWith('n-target')
  })

  it('new-page row does not render 定位 button', () => {
    render(
      <WritebackPanel
        items={[makeItem({ id: 'w2', kind: 'new-page' })]}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByText('定位')).toBeNull()
  })

  it('action buttons are real buttons, focusable and receive keyboard events', () => {
    render(
      <WritebackPanel
        items={[makeItem({ id: 'w-kb' })]}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const acceptBtn = screen.getByText('采纳')
    const discardBtn = screen.getByText('丢弃')
    const navigateBtn = screen.getByText('定位')
    const closeBtn = screen.getByTitle('关闭')

    for (const btn of [acceptBtn, discardBtn, navigateBtn, closeBtn]) {
      expect(btn.tagName).toBe('BUTTON')
      expect((btn as HTMLButtonElement).type).toBe('button')
      btn.focus()
      expect(document.activeElement).toBe(btn)
      expect(fireEvent.keyDown(btn, { key: 'Enter' })).toBe(true)
    }
  })
})
