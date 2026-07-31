// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LintPanel } from '../LintPanel'
import type { LintReport } from '@shared/types/wiki'

function makeReport(issues: LintReport['issues']): LintReport {
  return {
    issues,
    stats: { nodeCount: 3, edgeCount: 2, communityCount: 1 },
  }
}

describe('LintPanel', () => {
  it('renders grouped issues with counts and stats', () => {
    const report = makeReport([
      { kind: 'dangling-link', severity: 'warning', message: 'A 链接到 B 但 B 不存在', hint: '创建目标页面或移除链接', nodeId: 'n1' },
      { kind: 'orphan', severity: 'info', message: '页面 C 没有入链', hint: '从其他页面引用它', nodeId: 'n2' },
      { kind: 'community-singleton', severity: 'info', message: '社区只有一个节点', hint: '合并或扩展', nodeId: 'n3' },
    ])

    render(
      <LintPanel
        report={report}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
      />,
    )

    expect(screen.getByText(/图检查/)).toBeDefined()
    expect(screen.getByText(/页面 3/)).toBeDefined()
    expect(screen.getByText(/链接 2/)).toBeDefined()
    expect(screen.getByText(/社区 1/)).toBeDefined()

    expect(screen.getByText('断链')).toBeDefined()
    expect(screen.getByText('孤立页面')).toBeDefined()
    expect(screen.getByText('单节点社区')).toBeDefined()

    expect(screen.getByText(/A 链接到 B 但 B 不存在/)).toBeDefined()
    expect(screen.getByText(/页面 C 没有入链/)).toBeDefined()
  })

  it('calls onNavigate when clicking a row with nodeId', () => {
    const onNavigate = vi.fn()
    const report = makeReport([
      { kind: 'dangling-link', severity: 'warning', message: 'm', hint: 'h', nodeId: 'n-target' },
    ])

    render(
      <LintPanel
        report={report}
        onNavigate={onNavigate}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('m'))
    expect(onNavigate).toHaveBeenCalledWith('n-target')
  })

  it('does not call onNavigate when clicking a row without nodeId', () => {
    const onNavigate = vi.fn()
    const report = makeReport([
      { kind: 'community-oversized', severity: 'warning', message: '社区过大', hint: '拆分' },
    ])

    render(
      <LintPanel
        report={report}
        onNavigate={onNavigate}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('社区过大'))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('calls onRecompute when clicking the recompute button', () => {
    const onRecompute = vi.fn()
    render(
      <LintPanel
        report={makeReport([])}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onRecompute={onRecompute}
      />,
    )

    fireEvent.click(screen.getByTitle('重新计算社区'))
    expect(onRecompute).toHaveBeenCalled()
  })

  it('calls onClose when clicking the close button', () => {
    const onClose = vi.fn()
    render(
      <LintPanel
        report={makeReport([])}
        onNavigate={vi.fn()}
        onClose={onClose}
        onRecompute={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalled()
  })
})
