// @vitest-environment jsdom
/**
 * 方案一回归：审批入口不依赖聊天线程。
 *
 * 编排 runtime 的 kernel turn 不会在 renderer 建 thread，历史上审批卡片因此没有任何挂载点。
 * 这里直接向全局队列投递请求（模拟事件流），验证「非 Agent 页面」也能看到来源并决议。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApprovalInbox } from '../ApprovalInbox'
import { useApprovalStore } from '../../../store/approvalStore'
import type { ApprovalRequestPayload } from '@shared/types/agent-runtime'

const mapTurnApproval: ApprovalRequestPayload = {
  approvalId: 'appr-map-1',
  runId: 'wr_1',
  turnId: 'turn_map_1',
  sessionId: 'sess_map_1',
  stepId: 'ws_1',
  workItemId: 'wi_1',
  toolName: 'Bash',
  argsJson: '{"command":"printf hi > /tmp/drill/out.txt"}',
  argsHash: 'hash-map-1',
  risk: 'high',
  status: 'pending',
  expiresAt: Date.now() + 120_000,
  createdAt: Date.now(),
  mode: 'interactive',
  timeoutMs: 120_000,
  sessionGrantable: false,
}

function installApi(resolveApproval: ReturnType<typeof vi.fn>) {
  const api = {
    'agent:resolveApproval': resolveApproval,
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
  return api
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  useApprovalStore.setState({ pending: [], busy: {}, error: null })
})

describe('ApprovalInbox 全局审批入口', () => {
  it('无 pending 时不渲染任何入口（不打扰）', () => {
    installApi(vi.fn())
    render(<ApprovalInbox />)
    expect(screen.queryByTestId('approval-inbox')).toBeNull()
  })

  it('编排 turn 的审批可见：工具名、命令原文、来源三元组', () => {
    installApi(vi.fn())
    useApprovalStore.getState().upsert(mapTurnApproval)
    render(<ApprovalInbox />)

    expect(screen.getByTestId('approval-inbox')).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.getByText(/printf hi > \/tmp\/drill\/out.txt/)).toBeTruthy()
    const source = screen.getByTestId('approval-inbox-source').textContent ?? ''
    expect(source).toContain('任务 wi_1')
    expect(source).toContain('步骤 ws_1')
    expect(source).toContain('会话 sess_map_1')
  })

  it('允许一次后队列即时减少，并按归属字段回传主进程', async () => {
    const resolveApproval = vi.fn().mockResolvedValue(undefined)
    installApi(resolveApproval)
    useApprovalStore.getState().upsert(mapTurnApproval)
    render(<ApprovalInbox />)

    fireEvent.click(screen.getByTestId('approval-inbox-allow'))

    await waitFor(() => {
      expect(screen.queryByTestId('approval-inbox')).toBeNull()
    })
    expect(resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'appr-map-1',
        decision: 'allow',
        scope: 'once',
        sessionId: 'sess_map_1',
        turnId: 'turn_map_1',
        argsHash: 'hash-map-1',
      }),
    )
    expect(useApprovalStore.getState().pending).toHaveLength(0)
  })
})
