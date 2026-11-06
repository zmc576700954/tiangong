// @vitest-environment jsdom
/**
 * M1 ②：合成文件变更证据卡片的文案测试。
 *
 * 关键断言：明确「非工具调用记录」、不出现伪造工具名、截断如实标注。
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FileChangeEvidenceCard } from '../FileChangeEvidenceCard'
import type { FileChangeEvidence } from '@shared/types/agent'

function evidence(overrides: Partial<FileChangeEvidence> = {}): FileChangeEvidence {
  return {
    kind: 'workspace-snapshot-diff',
    changes: [
      { path: 'src/new.ts', changeType: 'add' },
      { path: 'src/app.ts', changeType: 'modify' },
      { path: 'src/old.ts', changeType: 'delete' },
    ],
    totalCount: 3,
    displayedCount: 3,
    limit: 50,
    truncated: false,
    scanTruncated: false,
    scannedFiles: 120,
    unhashedFiles: 0,
    durationMs: 34,
    root: '/tmp/project',
    toolAttribution: 'unknown',
    outOfWorkspaceChanges: 'not-included',
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('FileChangeEvidenceCard', () => {
  it('states it is inferred from workspace diff, not tool-call records', () => {
    render(<FileChangeEvidenceCard evidence={evidence()} />)

    expect(screen.getByTestId('file-change-evidence')).toBeTruthy()
    expect(screen.getByText(/依据工作区差分推断，非工具调用记录/)).toBeTruthy()
    expect(screen.getByTestId('file-change-evidence-source').textContent).toContain('synthetic')
    expect(screen.getByTestId('file-change-evidence-source').textContent).toContain('turn')
    expect(screen.getByTestId('file-change-evidence-limitation').textContent).toContain('不能证明是哪个工具修改的')
    expect(screen.getByTestId('file-change-evidence-limitation').textContent).toContain('/tmp')
  })

  it('never fabricates tool names', () => {
    render(<FileChangeEvidenceCard evidence={evidence()} />)
    const text = screen.getByTestId('file-change-evidence').textContent ?? ''
    expect(text).not.toMatch(/\bEdit\b/)
    expect(text).not.toMatch(/\bWrite\b/)
    expect(text).not.toMatch(/\bBash\b/)
  })

  it('labels truncation and scan truncation honestly', () => {
    render(
      <FileChangeEvidenceCard
        evidence={evidence({
          totalCount: 60,
          displayedCount: 50,
          truncated: true,
          scanTruncated: true,
          scanTruncatedReason: 'time_budget',
        })}
      />,
    )

    expect(screen.getByTestId('file-change-evidence-truncated').textContent).toContain('仅显示前 50 个')
    expect(screen.getByTestId('file-change-evidence-truncated').textContent).toContain('共 60 个')
    expect(screen.getByTestId('file-change-evidence-scan-truncated').textContent).toContain('time_budget')
  })
})
