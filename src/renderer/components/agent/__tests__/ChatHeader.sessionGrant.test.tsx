// @vitest-environment jsdom
/**
 * A2：会话级授权必须在 UI 可见，且可手动撤销（不能悄悄不再问）。
 */

import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatHeader } from '../ChatHeader'

function renderHeader(overrides: Partial<ComponentProps<typeof ChatHeader>> = {}) {
  return render(
    <ChatHeader
      adapterName="claude-code"
      adapters={[{ name: 'claude-code', installed: true }]}
      threadTitle="test thread"
      viewMode="chat"
      expanded={false}
      onSelectAdapter={() => {}}
      onNewThread={() => {}}
      onToggleThreads={() => {}}
      onToggleView={() => {}}
      onToggleExpand={() => {}}
      {...overrides}
    />,
  )
}

describe('ChatHeader session grant badge (A2)', () => {
  it('无授权时不显示徽标', () => {
    renderHeader()
    expect(screen.queryByTestId('session-grant-badge')).toBeNull()
  })

  it('存在授权时显示「本次会话已授权」，点击可撤销', () => {
    const onRevoke = vi.fn()
    renderHeader({
      sessionGrant: {
        sessionId: 's1',
        approvalId: 'appr-1',
        grantedAt: Date.now(),
        toolName: 'Write',
        toolScope: 'write',
        cwd: '/project',
      },
      onRevokeSessionGrant: onRevoke,
    })

    expect(screen.getByTestId('session-grant-badge')).toBeTruthy()
    expect(screen.getByTestId('session-grant-badge').textContent).toContain('本次会话已授权')
    fireEvent.click(screen.getByTestId('session-grant-revoke'))
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })
})
