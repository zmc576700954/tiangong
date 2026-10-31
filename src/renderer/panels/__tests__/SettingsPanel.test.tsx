// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useToastStore } from '../../lib/toast'

/**
 * SettingsPanel「基础设置」页签的 API key 与 CLI 工具清单测试。
 *
 * 守的是三道防线：
 *  1. 输入框留空时点「保存」**不能**调 settings:setApiKey ——
 *     否则已存的密钥会被空串覆盖（用户什么都没改也点了保存）。
 *  2. provider 列表必须与后端白名单一致（ALLOWED_API_PROVIDERS）。
 *  3. 没有 npm 安装方式的工具（cursor）不能渲染「安装」按钮。
 */

const setApiKey = vi.fn().mockResolvedValue(undefined)
const installCli = vi.fn().mockResolvedValue({ success: true, message: 'ok' })

const mockElectronAPI = {
  'settings:read': vi.fn().mockResolvedValue({
    version: 1,
    locale: 'zh-CN',
    cliTools: [
      { name: 'claude-code', npmPackage: '@anthropic-ai/claude-code', command: 'claude', installed: false },
      // cursor 只能从官网下载，没有 npm 包
      { name: 'cursor', npmPackage: '', command: 'cursor', installed: false },
    ],
    // settings:read 返回的是遮蔽后的 key
    apiKeys: [{ provider: 'anthropic', key: 'sk-t****2345' }],
    mcpServers: [],
  }),
  'settings:write': vi.fn().mockResolvedValue(undefined),
  'settings:refreshCli': vi.fn().mockResolvedValue([]),
  'settings:installCli': installCli,
  'settings:setApiKey': setApiKey,
  'agent:getAdapterMarketplace': vi.fn().mockResolvedValue([]),
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
  setApiKey.mockClear()
  setApiKey.mockResolvedValue(undefined)
  installCli.mockClear()
  useToastStore.getState().clear()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = mockElectronAPI
})

// SettingsPanel 在模块加载时抓取 window.electronAPI——必须在 mock 就位之后再 import
async function mountSettingsPanel() {
  const { SettingsPanel } = await import('../SettingsPanel')
  const result = render(<SettingsPanel />)
  // settings:read 是异步的：它 resolve 时的 setState 不在 act() 里，
  // React 会打「not wrapped in act(...)」的警告。
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  await waitFor(() => expect(screen.getByTestId('api-key-input-anthropic')).toBeTruthy())
  return result
}

describe('SettingsPanel API key', () => {
  it('输入框留空时点保存不会调用 settings:setApiKey，并给出错误提示', async () => {
    await mountSettingsPanel()
    fireEvent.click(screen.getByTestId('api-key-save-anthropic'))
    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'error')).toBe(true)
    })
    // 已存的 key 不能被空串覆盖
    expect(setApiKey).not.toHaveBeenCalled()
  })

  it('有内容时点保存会调用 settings:setApiKey', async () => {
    await mountSettingsPanel()
    fireEvent.change(screen.getByTestId('api-key-input-anthropic'), {
      target: { value: 'sk-xxx' },
    })
    fireEvent.click(screen.getByTestId('api-key-save-anthropic'))
    await waitFor(() => expect(setApiKey).toHaveBeenCalledWith('anthropic', 'sk-xxx'))
  })

  it('provider 列表与后端白名单一致（含 gemini）', async () => {
    await mountSettingsPanel()
    for (const provider of ['anthropic', 'openai', 'deepseek', 'gemini']) {
      expect(screen.getByTestId(`api-key-input-${provider}`), provider).toBeTruthy()
    }
  })

  it('删除按钮二次确认后以空串调 settings:setApiKey', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      await mountSettingsPanel()
      fireEvent.click(screen.getByTestId('api-key-delete-anthropic'))
      await waitFor(() => expect(setApiKey).toHaveBeenCalledWith('anthropic', ''))
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('取消确认时不删除', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      await mountSettingsPanel()
      fireEvent.click(screen.getByTestId('api-key-delete-anthropic'))
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(setApiKey).not.toHaveBeenCalled()
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('没有存过 key 的 provider 不显示删除按钮', async () => {
    await mountSettingsPanel()
    expect(screen.queryByTestId('api-key-delete-openai')).toBe(null)
  })

  it('保存失败时给出错误提示（不能静默失败）', async () => {
    setApiKey.mockRejectedValueOnce(new Error('磁盘只读'))
    await mountSettingsPanel()
    fireEvent.change(screen.getByTestId('api-key-input-anthropic'), {
      target: { value: 'sk-xxx' },
    })
    fireEvent.click(screen.getByTestId('api-key-save-anthropic'))
    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'error')).toBe(true)
    })
  })
})

describe('SettingsPanel CLI 工具清单', () => {
  it('有 npm 包的工具显示安装按钮', async () => {
    await mountSettingsPanel()
    expect(screen.getByTestId('cli-install-claude-code')).toBeTruthy()
  })

  it('没有 npm 包的工具（cursor）不显示安装按钮', async () => {
    await mountSettingsPanel()
    // 点了必然失败并弹出「非法的包名」——所以干脆不给这个按钮
    expect(screen.queryByTestId('cli-install-cursor')).toBe(null)
  })
})
