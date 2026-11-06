// @vitest-environment jsdom
/**
 * P1-3 回归：陈旧审批的失败原因必须可见，不能「弹窗消失 + 什么都没执行」。
 * 同时保证正常审批流程不受影响。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApprovalRequestDialog } from '../ApprovalRequestDialog'
import type { ApprovalRequestPayload } from '@shared/types/agent-runtime'

const payload: ApprovalRequestPayload = {
  approvalId: 'appr-1',
  runId: 'run-1',
  turnId: 'turn-1',
  toolName: 'Write',
  argsJson: '{"file_path":"/tmp/x.txt"}',
  argsHash: 'hash-1',
  risk: 'high',
  status: 'pending',
  expiresAt: Date.now() + 120_000,
  createdAt: Date.now(),
  mode: 'interactive',
  timeoutMs: 120_000,
  sessionGrantable: true,
}

function installApi(resolveApproval: ReturnType<typeof vi.fn>, request: ApprovalRequestPayload = payload) {
  const api = {
    'agent:getPendingApprovals': vi.fn().mockResolvedValue([request]),
    'agent:resolveApproval': resolveApproval,
    onApprovalRequest: vi.fn().mockReturnValue(() => {}),
    onApprovalResolved: vi.fn().mockReturnValue(() => {}),
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
  return api
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('ApprovalRequestDialog 错误可见性', () => {
  it('陈旧审批（APPROVAL_STALE）：卡片关闭后错误横幅仍可见且说明未执行', async () => {
    installApi(
      vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'APPROVAL_STALE',
          message: '该审批所属轮次已结束，批准不会执行（已自动置为 denied）。请重新发送命令以触发新的审批。',
        },
      }),
    )
    render(<ApprovalRequestDialog />)

    const allow = await screen.findByText('允许一次')
    fireEvent.click(allow)

    await waitFor(() => {
      expect(screen.queryByText('允许一次')).toBeNull()
    })
    const banner = screen.getByTestId('approval-error')
    expect(banner.textContent).toContain('该审批已失效')
    expect(banner.textContent).toContain('不会执行')
  })

  it('正常审批：批准成功后卡片消失且不显示错误横幅', async () => {
    installApi(vi.fn().mockResolvedValue(undefined))
    render(<ApprovalRequestDialog />)

    const deny = await screen.findByText('拒绝')
    fireEvent.click(deny)

    await waitFor(() => {
      expect(screen.queryByText('拒绝')).toBeNull()
    })
    expect(screen.queryByTestId('approval-error')).toBeNull()
  })

  it('重启重放（argsRedacted）：明确提示历史参数已脱敏，且不提供还原原文', async () => {
    installApi(vi.fn().mockResolvedValue(undefined), {
      ...payload,
      argsJson: '{"command":"curl --token=***REDACTED(40 chars)"}',
      argsRedacted: true,
    })
    render(<ApprovalRequestDialog />)

    await screen.findByText('拒绝')
    const notice = screen.getByTestId('approval-redacted-notice')
    expect(notice.textContent).toContain('已脱敏')
    expect(notice.textContent).toContain('重新发起')
    // 只保留脱敏后的参数，没有任何「还原原文」入口
    expect(screen.queryByText(/还原/)).toBeNull()
    expect(screen.queryByText(/查看原文/)).toBeNull()
  })

  it('正常待审批（实时内存原文）：不显示脱敏提示', async () => {
    installApi(vi.fn().mockResolvedValue(undefined))
    render(<ApprovalRequestDialog />)

    await screen.findByText('拒绝')
    expect(screen.queryByTestId('approval-redacted-notice')).toBeNull()
    expect(screen.getByText(/\/tmp\/x\.txt/)).toBeTruthy()
  })
})

/**
 * 阻断项：UI 文案必须与实际权限一致。
 * Bash 的「允许本会话」不能出现——它不会给 Bash 免审，却会（修复前）给写类工具授权。
 */
describe('ApprovalRequestDialog 会话授权入口与工具类型一致', () => {
  it('写类工具（Write）：显示「允许本次会话」', async () => {
    installApi(vi.fn().mockResolvedValue(undefined))
    render(<ApprovalRequestDialog />)

    await screen.findByText('拒绝')
    expect(screen.getByText('允许本次会话')).toBeTruthy()
    expect(screen.queryByTestId('approval-session-unavailable')).toBeNull()
  })

  it('Bash（sessionGrantable=false）：不显示会话按钮，只保留逐次允许并说明原因', async () => {
    installApi(vi.fn().mockResolvedValue(undefined), {
      ...payload,
      toolName: 'Bash',
      argsJson: '{"command":"npm test"}',
      sessionGrantable: false,
    })
    render(<ApprovalRequestDialog />)

    await screen.findByText('拒绝')
    expect(screen.queryByText('允许本次会话')).toBeNull()
    expect(screen.getByText('允许一次')).toBeTruthy()
    const note = screen.getByTestId('approval-session-unavailable')
    expect(note.textContent).toContain('不支持')
    expect(note.textContent).toContain('只覆盖')
    expect(note.textContent).toContain('逐次')
  })

  it('P3-5：sessionGrantable 缺省（undefined）不等于可授权，按严格布尔隐藏入口', async () => {
    const { sessionGrantable: _omitted, ...legacyPayload } = payload
    installApi(vi.fn().mockResolvedValue(undefined), legacyPayload)
    render(<ApprovalRequestDialog />)

    await screen.findByText('拒绝')
    expect(screen.queryByText('允许本次会话')).toBeNull()
    expect(screen.getByTestId('approval-session-unavailable')).toBeTruthy()
  })

  it('决议回传 sessionId/turnId 供主进程做归属校验', async () => {
    const resolveApproval = vi.fn().mockResolvedValue(undefined)
    installApi(resolveApproval, { ...payload, sessionId: 's1' })
    render(<ApprovalRequestDialog />)

    await screen.findByText('拒绝')
    fireEvent.click(screen.getByText('允许一次'))
    await waitFor(() => expect(resolveApproval).toHaveBeenCalled())
    expect(resolveApproval.mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      turnId: 'turn-1',
      decision: 'allow',
      scope: 'once',
    })
  })
})
