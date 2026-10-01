// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LintPanel } from '../LintPanel'
import type { LintReport, LintIssue } from '@shared/types/wiki'

function makeReport(issues: LintIssue[]): LintReport {
  return {
    issues,
    stats: { nodeCount: 3, edgeCount: 2, communityCount: 1 },
  }
}

/** 构造一条最小可用 issue（默认 fixable=false） */
function makeIssue(overrides: Partial<LintIssue> & { kind: LintIssue['kind'] }): LintIssue {
  return {
    code: overrides.kind,
    severity: 'info',
    fixable: false,
    message: 'msg',
    hint: 'hint',
    ...overrides,
  } as LintIssue
}

describe('LintPanel', () => {
  it('renders grouped issues with counts and stats', () => {
    const report = makeReport([
      makeIssue({ kind: 'dangling-link', severity: 'warning', message: 'A 链接到 B 但 B 不存在', hint: '创建目标页面或移除链接', nodeId: 'n1' }),
      makeIssue({ kind: 'orphan', severity: 'info', message: '页面 C 没有入链', hint: '从其他页面引用它', nodeId: 'n2' }),
      makeIssue({ kind: 'community-singleton', severity: 'info', message: '社区只有一个节点', hint: '合并或扩展', nodeId: 'n3' }),
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

  it('按严重度分组：错误 > 警告 > 提示', () => {
    const report = makeReport([
      makeIssue({ kind: 'dangling-link', severity: 'warning', message: 'warn-issue', nodeId: 'n1' }),
      makeIssue({ kind: 'missing-frontmatter', severity: 'warning', message: 'fm-issue', nodeId: 'n2' }),
      makeIssue({ kind: 'orphan', severity: 'info', message: 'info-issue', nodeId: 'n3' }),
    ])

    render(
      <LintPanel
        report={report}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
      />,
    )

    const badges = screen.getAllByText(/^(警告|提示)$/)
    // 警告 应排在 提示 之前
    expect(badges[0].textContent).toBe('警告')
    expect(badges[1].textContent).toBe('提示')
  })

  it('calls onNavigate when clicking a row with nodeId', () => {
    const onNavigate = vi.fn()
    const report = makeReport([
      makeIssue({ kind: 'dangling-link', severity: 'warning', message: 'm', hint: 'h', nodeId: 'n-target' }),
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
      makeIssue({ kind: 'community-oversized', severity: 'warning', message: '社区过大', hint: '拆分' }),
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

  it('navigates via keyboard Enter and Space on a focused row', () => {
    const onNavigate = vi.fn()
    const report = makeReport([
      makeIssue({ kind: 'dangling-link', severity: 'warning', message: 'kbd-row', hint: 'h', nodeId: 'n-kbd' }),
    ])

    render(
      <LintPanel
        report={report}
        onNavigate={onNavigate}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
      />,
    )

    const row = screen.getByRole('button', { name: /kbd-row/ })
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('n-kbd')
    fireEvent.keyDown(row, { key: ' ' })
    expect(onNavigate).toHaveBeenCalledTimes(2)
    expect(onNavigate).toHaveBeenLastCalledWith('n-kbd')
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

  it('fixable issue 显示「修复」按钮，点击触发 onApplyFix', () => {
    const onApplyFix = vi.fn().mockResolvedValue(undefined)
    const issue: LintIssue = makeIssue({
      kind: 'dangling-link',
      severity: 'warning',
      message: 'dangling',
      nodeId: 'n1',
      fixable: true,
      fix: { kind: 'create-stub-page', payload: { sourceNodeId: 'n1', targetTitle: '目标' } },
    })

    render(
      <LintPanel
        report={makeReport([issue])}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
        onApplyFix={onApplyFix}
      />,
    )

    const fixBtn = screen.getByRole('button', { name: /一键修复：dangling/ })
    fireEvent.click(fixBtn)
    expect(onApplyFix).toHaveBeenCalledTimes(1)
    expect(onApplyFix).toHaveBeenCalledWith(issue)
  })

  it('fixable=false 时不显示修复按钮', () => {
    render(
      <LintPanel
        report={makeReport([
          makeIssue({ kind: 'orphan', severity: 'info', message: 'orphan-issue', nodeId: 'n1', fixable: false }),
        ])}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
        onApplyFix={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.queryByRole('button', { name: /一键修复/ })).toBeNull()
  })

  it('修复成功后 issue 从列表移除并显示成功 toast', async () => {
    const onApplyFix = vi.fn().mockResolvedValue(undefined)
    const issue: LintIssue = makeIssue({
      kind: 'missing-frontmatter',
      severity: 'warning',
      message: '缺 fm 的页面',
      nodeId: 'n1',
      fixable: true,
      fix: { kind: 'add-frontmatter', payload: { nodeId: 'n1' } },
    })

    render(
      <LintPanel
        report={makeReport([issue])}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
        onApplyFix={onApplyFix}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /一键修复/ }))

    await waitFor(() => {
      expect(screen.queryByText('缺 fm 的页面')).toBeNull()
    })
    expect(await screen.findByText(/已修复/)).toBeDefined()
  })

  it('修复失败时显示错误 toast，issue 保留在列表中', async () => {
    const onApplyFix = vi.fn().mockRejectedValue(new Error('boom'))
    const issue: LintIssue = makeIssue({
      kind: 'inconsistent-case',
      severity: 'info',
      message: 'case-issue',
      nodeId: 'n1',
      fixable: true,
      fix: { kind: 'normalize-case', payload: { nodeId: 'n1', newTitle: 'x' } },
    })

    render(
      <LintPanel
        report={makeReport([issue])}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onRecompute={vi.fn()}
        onApplyFix={onApplyFix}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /一键修复/ }))

    await waitFor(() => {
      expect(screen.getByText(/修复失败：boom/)).toBeDefined()
    })
    expect(screen.getByText('case-issue')).toBeDefined()
  })
})
