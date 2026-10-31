// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DefaultsTab } from '../DefaultsTab'
import { ToastContainer, useToastStore } from '../../lib/toast'
import type { BizGraphSettings } from '@shared/types'

/**
 * DefaultsTab 渲染层测试（最小覆盖）：
 *   - 默认适配器下拉只列出「已安装」的适配器
 *   - 回退顺序上移后保存 → patch 含 adapterPreferences
 *   - 改默认模型后保存 → patch 含 defaultModels（**三个档位键都要在**）
 *   - 保存失败 → 全局 toast 出现 error
 *
 * 反馈走全局 Toast（src/renderer/lib/toast.tsx），故测试里挂 <ToastContainer />。
 * 本仓库未配置 @testing-library/jest-dom，断言全部用原生写法。
 */

function renderWithToast(ui: React.ReactElement) {
  return render(
    <>
      {ui}
      <ToastContainer />
    </>,
  )
}

function clearToasts(): void {
  useToastStore.getState().clear()
}

function makeSettings(overrides: Partial<BizGraphSettings> = {}): BizGraphSettings {
  return {
    version: 1,
    cliTools: [],
    apiKeys: [],
    mcpServers: [],
    ...overrides,
  }
}

describe('DefaultsTab', () => {
  beforeEach(() => { clearToasts() })

  it('默认适配器下拉只列出已安装的适配器', () => {
    renderWithToast(
      <DefaultsTab
        settings={makeSettings({
          adapterPreferences: { defaultAdapter: 'claude-code', fallbackOrder: ['mcp'] },
        })}
        installedAdapters={['claude-code']}
        onSave={vi.fn()}
      />,
    )
    // 未安装的适配器不出现在下拉里
    expect(screen.queryByText('codex')).toBe(null)
    const select = screen.getByTestId('defaults-default-adapter') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['claude-code'])
  })

  it('一个适配器都没装时禁用下拉并给出提示', () => {
    renderWithToast(
      <DefaultsTab
        settings={makeSettings()}
        installedAdapters={[]}
        onSave={vi.fn()}
      />,
    )
    const select = screen.getByTestId('defaults-default-adapter') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(screen.getByText(/未检测到已安装的 CLI 工具/)).toBeTruthy()
  })

  it('上移回退顺序后保存，patch 含 adapterPreferences', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderWithToast(
      <DefaultsTab
        settings={makeSettings({
          adapterPreferences: { defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode'] },
        })}
        installedAdapters={['claude-code', 'codex', 'opencode']}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByTestId('defaults-fallback-up-opencode'))
    fireEvent.click(screen.getByTestId('defaults-fallback-save'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const patch = onSave.mock.calls[0][0] as Partial<BizGraphSettings>
    expect(patch.adapterPreferences?.fallbackOrder).toEqual(['opencode', 'codex'])
    expect(patch.adapterPreferences?.defaultAdapter).toBe('claude-code')
  })

  it('改默认模型后保存，patch 含 defaultModels 三个档位（其余档位不能被清空）', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderWithToast(
      <DefaultsTab
        settings={makeSettings({
          defaultModels: { claudeCode: '', codex: 'gpt-5', mcp: '' },
        })}
        installedAdapters={['claude-code']}
        onSave={onSave}
      />,
    )
    fireEvent.change(screen.getByTestId('defaults-model-claudeCode'), {
      target: { value: 'xxx' },
    })
    fireEvent.click(screen.getByTestId('defaults-models-save'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const patch = onSave.mock.calls[0][0] as Partial<BizGraphSettings>
    expect(patch.defaultModels?.claudeCode).toBe('xxx')
    expect(patch.defaultModels?.codex).toBe('gpt-5')
    // 键不能少：settings:write 是浅合并，少一个键就等于把那一档清空
    expect(Object.keys(patch.defaultModels ?? {}).sort()).toEqual(['claudeCode', 'codex', 'mcp'])
  })

  it('保存压缩模型，patch 含 compactModel', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderWithToast(
      <DefaultsTab
        settings={makeSettings({ compactModel: 'haiku' })}
        installedAdapters={['claude-code']}
        onSave={onSave}
      />,
    )
    fireEvent.change(screen.getByTestId('defaults-compact-model'), {
      target: { value: 'sonnet-4-5' },
    })
    fireEvent.click(screen.getByTestId('defaults-compact-save'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const patch = onSave.mock.calls[0][0] as Partial<BizGraphSettings>
    expect(patch.compactModel).toBe('sonnet-4-5')
  })

  it('保存失败时通过 toast 报错', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('磁盘只读'))
    renderWithToast(
      <DefaultsTab
        settings={makeSettings({ compactModel: 'haiku' })}
        installedAdapters={['claude-code']}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByTestId('defaults-compact-save'))
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts
      expect(toasts.some((toast) => toast.kind === 'error')).toBe(true)
    })
    expect(screen.getByTestId('toast-error')).toBeTruthy()
  })

  it('MCP 档位旁提示自建网关必须填网关自己的模型 id', () => {
    renderWithToast(
      <DefaultsTab
        settings={makeSettings()}
        installedAdapters={['claude-code']}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByText(/自建网关/)).toBeTruthy()
  })
})
