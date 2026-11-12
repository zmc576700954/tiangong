// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useToastStore } from '../../lib/toast'

/**
 * SettingsPanel「默认值」页签的面板层测试。
 *
 * 组件层测试（DefaultsTab.test.tsx）把 onSave mock 掉了，看不见面板真正怎么写盘 ——
 * 这一层专门守住面板与主进程之间的那道浅合并防线。
 */

const writeSettings = vi.fn().mockResolvedValue(undefined)

/** 实时检测的默认结果：claude-code 与 mcp 已装，codex 没装。 */
const DEFAULT_MARKETPLACE = [
  { name: 'claude-code', installed: true },
  { name: 'codex', installed: false },
  { name: 'mcp', installed: true },
]

const mockElectronAPI = {
  'settings:read': vi.fn().mockResolvedValue({
    version: 1,
    locale: 'zh-CN',
    // cliTools 的 installed 标记只有手动点「刷新状态」后才更新 —— 这里刻意是陈旧的 false
    cliTools: [
      { name: 'claude-code', npmPackage: '@anthropic-ai/claude-code', command: 'claude', installed: false },
    ],
    apiKeys: [],
    mcpServers: [],
    defaultModels: { claudeCode: '', codex: 'gpt-5', mcp: '' },
    compactModel: 'haiku',
  }),
  'settings:write': writeSettings,
  'settings:refreshCli': vi.fn().mockResolvedValue([]),
  'settings:installCli': vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  'settings:setApiKey': vi.fn().mockResolvedValue(undefined),
  // 实时检测（agent:getAdapterMarketplace 内部走 registry.checkAllInstalled）
  'agent:getAdapterMarketplace': vi.fn().mockResolvedValue(DEFAULT_MARKETPLACE),
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
  writeSettings.mockResolvedValue(undefined)
  const marketplace = mockElectronAPI['agent:getAdapterMarketplace']
  marketplace.mockReset()
  marketplace.mockResolvedValue(DEFAULT_MARKETPLACE)
  useToastStore.getState().clear()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = mockElectronAPI
})

// SettingsPanel 在模块加载时抓取 window.electronAPI——必须在 mock 就位之后再 import
async function mountSettingsPanel() {
  const { SettingsPanel } = await import('../SettingsPanel')
  const result = render(<SettingsPanel />)
  // settings:read / agent:getAdapterMarketplace 是异步的：它们 resolve 时的
  // setState 不在 act() 里，React 会打「not wrapped in act(...)」的警告。
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return result
}

// Radix 的 TabsTrigger 在 **mousedown** 上切换页签（不是 click）——测试必须照做，
// 否则页签根本没切换，断言会假绿。
function switchTab(label: string): void {
  fireEvent.mouseDown(screen.getByText(label))
}

async function openDefaultsTab() {
  await mountSettingsPanel()
  await waitFor(() => expect(screen.getByText('默认值')).toBeTruthy())
  switchTab('默认值')
}

describe('SettingsPanel 默认值页签', () => {
  it('默认适配器下拉用实时检测结果，cliTools 的陈旧 installed 标记不能让它变禁用', async () => {
    await openDefaultsTab()
    await waitFor(() => {
      const select = screen.getByTestId('defaults-default-adapter') as HTMLSelectElement
      expect(select.disabled).toBe(false)
    })
    const select = screen.getByTestId('defaults-default-adapter') as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    // 实时检测到的已安装适配器
    expect(values).toContain('claude-code')
    expect(values).toContain('mcp')
    // 没装的不该出现
    expect(values).not.toContain('codex')
    // 实时检测到了 claude-code，就不该再提示用户去安装它
    expect(screen.queryByText(/未检测到已安装的 CLI 工具/)).toBe(null)
    // 激活时面板必须可见
    const panel = select.closest('[role="tabpanel"]')
    expect(panel?.hasAttribute('hidden')).toBe(false)
  })

  it('保存默认模型时 settings:write 收到全部三个档位（浅合并的最后一环）', async () => {
    await openDefaultsTab()
    fireEvent.change(screen.getByTestId('defaults-model-claudeCode'), {
      target: { value: 'sonnet-4-5' },
    })
    fireEvent.click(screen.getByTestId('defaults-models-save'))
    await waitFor(() => expect(writeSettings).toHaveBeenCalled())
    const written = writeSettings.mock.calls[0][0] as {
      defaultModels?: Record<string, string>
    }
    expect(Object.keys(written.defaultModels ?? {}).sort()).toEqual(['claudeCode', 'codex', 'mcp'])
    expect(written.defaultModels?.claudeCode).toBe('sonnet-4-5')
    // 另一个档位不能被清空
    expect(written.defaultModels?.codex).toBe('gpt-5')
  })

  it('保存一个区块不会清空另一个区块未保存的输入', async () => {
    await openDefaultsTab()
    const compact = screen.getByTestId('defaults-compact-model') as HTMLInputElement
    fireEvent.change(compact, { target: { value: 'draft-compact-model' } })
    // 去保存「默认模型」区块
    fireEvent.click(screen.getByTestId('defaults-models-save'))
    await waitFor(() => expect(writeSettings).toHaveBeenCalled())
    expect((screen.getByTestId('defaults-compact-model') as HTMLInputElement).value)
      .toBe('draft-compact-model')
  })

  it('切到别的页签再切回来，未保存的输入还在', async () => {
    await openDefaultsTab()
    fireEvent.change(screen.getByTestId('defaults-compact-model'), {
      target: { value: 'draft-compact-model' },
    })
    switchTab('基础设置')
    // forceMount 的面板必须被藏起来，否则「默认值」的内容会一直显示在「基础设置」旁边
    const panel = screen.getByTestId('defaults-default-adapter').closest('[role="tabpanel"]')
    expect(panel?.hasAttribute('hidden')).toBe(true)
    switchTab('默认值')
    expect((screen.getByTestId('defaults-compact-model') as HTMLInputElement).value)
      .toBe('draft-compact-model')
  })

  it('保存失败时报错，不能弹「已保存」的成功提示', async () => {
    writeSettings.mockRejectedValueOnce(new Error('磁盘只读'))
    await openDefaultsTab()
    fireEvent.click(screen.getByTestId('defaults-models-save'))
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts
      expect(toasts.some((toast) => toast.kind === 'error')).toBe(true)
    })
    expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'success')).toBe(false)
  })
})

describe('SettingsPanel 默认值页签 · 安装检测的失败路径', () => {
  it('探测永不 settle 时，面板照常渲染，且不谎称「一个都没装」', async () => {
    // CLI 的 --version 探测可能永远不返回（认证向导、装坏的 CLI……）
    mockElectronAPI['agent:getAdapterMarketplace'].mockImplementation(() => new Promise(() => {}))
    await mountSettingsPanel()
    // 首屏没有被外部 CLI 探测卡住
    await waitFor(() => expect(screen.getByText('界面语言')).toBeTruthy())
    switchTab('默认值')
    expect(screen.queryByText(/未检测到已安装的 CLI 工具/)).toBe(null)
    // 只能说「还在检测」，不能说「一个都没装」
    expect(screen.getAllByText(/正在检测已安装的 CLI 工具/).length).toBeGreaterThan(0)
  })

  it('探测失败时提示「无法确认」，而不是谎称「一个都没装」', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockElectronAPI['agent:getAdapterMarketplace'].mockRejectedValueOnce(new Error('boom'))
      await mountSettingsPanel()
      await waitFor(() => expect(screen.getByText(/安装检测失败或超时/)).toBeTruthy())
      expect(screen.queryByText(/未检测到已安装的 CLI 工具/)).toBe(null)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('探测超时后转为「无法确认」，面板不停在 spinner 上', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockElectronAPI['agent:getAdapterMarketplace'].mockImplementation(() => new Promise(() => {}))
      const { SettingsPanel } = await import('../SettingsPanel')
      render(<SettingsPanel />)
      // 推进超过检测上界
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(screen.getByText(/安装检测失败或超时/)).toBeTruthy()
      expect(screen.queryByText(/未检测到已安装的 CLI 工具/)).toBe(null)
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('可以在页签内重试：状态会更新，且不丢未保存的输入', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const marketplace = mockElectronAPI['agent:getAdapterMarketplace']
      marketplace.mockReset()
      marketplace.mockRejectedValueOnce(new Error('boom'))
      marketplace.mockResolvedValue(DEFAULT_MARKETPLACE)
      await mountSettingsPanel()
      await waitFor(() => expect(screen.getByText(/安装检测失败或超时/)).toBeTruthy())
      // 先在页签里留一个未保存的输入
      fireEvent.change(screen.getByTestId('defaults-compact-model'), {
        target: { value: 'draft-compact-model' },
      })
      // 页签内的重试入口
      fireEvent.click(screen.getByTestId('defaults-detection-retry'))
      // 状态标签必须更新
      await waitFor(() => expect(screen.queryByText(/安装检测失败或超时/)).toBe(null))
      expect(screen.queryByText(/正在检测已安装的 CLI 工具/)).toBe(null)
      // 下拉恢复
      const select = screen.getByTestId('defaults-default-adapter') as HTMLSelectElement
      expect(Array.from(select.options).map((o) => o.value)).toContain('claude-code')
      // 未保存的输入不能丢
      expect((screen.getByTestId('defaults-compact-model') as HTMLInputElement).value)
        .toBe('draft-compact-model')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('卸载后不留悬挂定时器：探测挂死也不会在卸载后触发任何输出', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockElectronAPI['agent:getAdapterMarketplace'].mockImplementation(() => new Promise(() => {}))
      const { SettingsPanel } = await import('../SettingsPanel')
      const { unmount } = render(<SettingsPanel />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      unmount()
      // 卸载后再推进超过检测上界：定时器已被清掉，不该有任何日志或 setState
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
