// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const writeSettings = vi.fn().mockResolvedValue(undefined)

const mockElectronAPI = {
  'settings:read': vi.fn().mockResolvedValue({
    locale: 'zh-CN',
    cliTools: [],
    apiKeys: [],
    mcpServers: [],
  }),
  'settings:write': writeSettings,
  'settings:refreshCli': vi.fn().mockResolvedValue([]),
  'settings:installCli': vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  'settings:setApiKey': vi.fn().mockResolvedValue(undefined),
  'settings:getContextWaterlineConfig': vi.fn().mockResolvedValue({
    autoCompactEnabled: true,
    autoCompactThreshold: 0.75,
    minCompactInterval: 60_000,
  }),
  'settings:setContextWaterlineConfig': vi.fn().mockResolvedValue(undefined),
  locale: 'zh-CN',
  onLocaleChanged: () => () => {},
}

beforeEach(() => {
  writeSettings.mockClear()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = mockElectronAPI
})

// SettingsPanel 在模块加载时抓取 window.electronAPI——必须在 mock 就位之后再 import
async function mountSettingsPanel() {
  const { SettingsPanel } = await import('../SettingsPanel')
  return render(<SettingsPanel />)
}

describe('SettingsPanel language dropdown', () => {
  it('shows a language selector in the general tab', async () => {
    await mountSettingsPanel()
    await waitFor(() => expect(screen.getByText('界面语言')).toBeTruthy())
  })

  it('persists the chosen locale', async () => {
    await mountSettingsPanel()
    await waitFor(() => expect(screen.getByText('界面语言')).toBeTruthy())
    const select = screen.getByTestId('language-select')
    fireEvent.change(select, { target: { value: 'en-US' } })
    await waitFor(() => expect(writeSettings).toHaveBeenCalled())
    expect(writeSettings.mock.calls[0][0].locale).toBe('en-US')
  })
})
