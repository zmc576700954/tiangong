// @vitest-environment jsdom
/**
 * 导入查重确认框（S1 §2.6 / §9.2）行为回归。
 *
 * 覆盖点都是"用户路径真的能不能走通"，不是渲染快照：
 * - reject 形态没有确认按钮（服务端硬拒绝，界面不许假装能绕过）
 * - allow_with_warning 能继续导入
 * - allow_branch_variant 必须先勾选「确认是分支/副本」，否则确认键禁用
 * - 「记住放行」只在分支形态下随确认一起回传
 * - 放行规则可查看、可撤销；读取失败不能显示成"没有规则"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ImportAllowanceRow, ImportPreviewResult } from '@shared/types/ipc'

const listAllowances = vi.fn<() => Promise<ImportAllowanceRow[]>>()
const revokeAllowance = vi.fn<(id: string, by?: string) => Promise<void>>()

const mockElectronAPI = {
  'project:import:allowance:list': listAllowances,
  'project:import:allowance:revoke': revokeAllowance,
}

beforeEach(() => {
  listAllowances.mockReset().mockResolvedValue([])
  revokeAllowance.mockReset().mockResolvedValue(undefined)
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = mockElectronAPI
})

// ImportDedupDialog 在模块加载时抓 window.electronAPI —— 必须先 mock 再 import
async function mountDialog(props: {
  preview: ImportPreviewResult
  onConfirm?: (options: { allowBranchVariant: boolean; rememberForFingerprint: boolean }) => void
  onCancel?: () => void
}) {
  const { ImportDedupDialog } = await import('../ImportDedupDialog')
  const result = render(
    <ImportDedupDialog
      open
      projectName="tiangong"
      preview={props.preview}
      onCancel={props.onCancel ?? (() => {})}
      onConfirm={props.onConfirm ?? (() => {})}
    />,
  )
  // 打开即异步拉一次放行规则；不等它落地，状态更新会落在 act 之外刷警告。
  await act(async () => {})
  return result
}

function preview(overrides: Partial<ImportPreviewResult> = {}): ImportPreviewResult {
  return {
    action: 'allow',
    step: '3c',
    reason: '新项目（无任何匹配信号）',
    dirName: 'tiangong',
    signals: { dirNameSame: false, nameSame: null, similarity: 0.12, sampleCount: 12 },
    remembered: false,
    ...overrides,
  }
}

describe('ImportDedupDialog', () => {
  it('硬拒绝只给关闭出口，并说明不可绕过', async () => {
    const onConfirm = vi.fn()
    await mountDialog({
      preview: preview({
        action: 'reject',
        step: '2a',
        reason: '同一项目重导（同名目录且内容相似度 0.92 ≥ 0.6）',
        signals: { dirNameSame: true, nameSame: true, similarity: 0.92, sampleCount: 12 },
      }),
      onConfirm,
    })

    expect(screen.getByTestId('import-dedup-title').textContent).toContain('无法导入')
    expect(screen.getByTestId('import-reject-note')).toBeTruthy()
    expect(screen.queryByTestId('import-dedup-confirm')).toBeNull()

    fireEvent.click(screen.getByTestId('import-dedup-close'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('同名但内容差异大：可直接继续导入，且不带分支放行选项', async () => {
    const onConfirm = vi.fn()
    await mountDialog({
      preview: preview({
        action: 'allow_with_warning',
        step: '2b',
        reason: '同名目录但内容差异大（相似度 0.3 < 0.6），可能是另一个项目',
        signals: { dirNameSame: true, nameSame: true, similarity: 0.3, sampleCount: 12 },
      }),
      onConfirm,
    })

    fireEvent.click(screen.getByTestId('import-dedup-confirm'))
    expect(onConfirm).toHaveBeenCalledWith({ allowBranchVariant: false, rememberForFingerprint: false })
  })

  it('分支/副本：未勾选确认时确认键禁用，勾选后才放行', async () => {
    const onConfirm = vi.fn()
    await mountDialog({
      preview: preview({
        action: 'allow_branch_variant',
        step: '3a-this_time',
        reason: '同一仓库的不同分支/副本（用户显式确认放行）',
        signals: { dirNameSame: false, nameSame: true, similarity: 0.88, sampleCount: 12 },
      }),
      onConfirm,
    })

    const confirm = screen.getByTestId('import-dedup-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('import-branch-ack'))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith({ allowBranchVariant: true, rememberForFingerprint: false })
  })

  it('分支/副本 + 记住放行：两个选项一起回传', async () => {
    const onConfirm = vi.fn()
    await mountDialog({
      preview: preview({
        action: 'allow_branch_variant',
        step: '3a-this_time',
        reason: '同一仓库的不同分支/副本（用户显式确认放行）',
        signals: { dirNameSame: false, nameSame: true, similarity: 0.88, sampleCount: 12 },
      }),
      onConfirm,
    })

    fireEvent.click(screen.getByTestId('import-branch-ack'))
    fireEvent.click(screen.getByTestId('import-remember'))
    fireEvent.click(screen.getByTestId('import-dedup-confirm'))
    expect(onConfirm).toHaveBeenCalledWith({ allowBranchVariant: true, rememberForFingerprint: true })
  })

  it('放行规则可查看、可撤销，撤销后重拉列表', async () => {
    listAllowances.mockResolvedValue([
      {
        id: 'ia_1',
        fingerprintId: 'pf_1',
        dirName: 'tiangong-copy',
        projectName: 'tiangong',
        rootPath: '/work/tiangong-copy',
        grantedBy: 'local-user',
        grantedAt: '2026-11-12T00:00:00.000Z',
      },
    ])
    await mountDialog({ preview: preview({ action: 'allow_branch_variant', step: '3a-this_time' }) })

    await waitFor(() => expect(screen.getByTestId('import-allowance-ia_1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('import-allowance-revoke-ia_1'))

    await waitFor(() => expect(revokeAllowance).toHaveBeenCalledWith('ia_1', 'local-user'))
    // 撤销后必须真的重读，而不是本地删行（否则下一次打开又"复活"）
    await waitFor(() => expect(listAllowances.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('规则读取失败显示错误，不伪装成空列表', async () => {
    listAllowances.mockRejectedValue(new Error('IPC timeout'))
    await mountDialog({ preview: preview({ action: 'allow_branch_variant', step: '3a-this_time' }) })

    await waitFor(() => expect(screen.getByTestId('import-allowance-error')).toBeTruthy())
    expect(screen.getByTestId('import-allowance-error').textContent).toContain('IPC timeout')
  })
})
