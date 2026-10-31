import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAdapterStore } from '../adapterStore'
import { DEFAULT_ADAPTER_PREFERENCES } from '@shared/adapter-defaults'

/** 后端返回的偏好 —— 刻意与 DEFAULT_ADAPTER_PREFERENCES 不同，方便区分两者。 */
const BACKEND_PREFS = {
  defaultAdapter: 'claude-code',
  fallbackOrder: ['codex', 'opencode', 'mcp'],
}

const getAdapterPreferences = vi.fn().mockResolvedValue(BACKEND_PREFS)

vi.stubGlobal('window', {
  electronAPI: {
    'agent:listAdapters': vi.fn().mockResolvedValue([
      { name: 'claude-code', version: '1.0.0', installed: true },
    ]),
    'settings:getAdapterPreferences': getAdapterPreferences,
    'settings:setAdapterPreferences': vi.fn().mockResolvedValue(undefined),
    'agent:getAdapterMarketplace': vi.fn().mockResolvedValue([
      { name: 'claude-code', installed: true, installMethod: 'npm' },
    ]),
  },
})

describe('adapterStore', () => {
  beforeEach(() => {
    getAdapterPreferences.mockReset()
    getAdapterPreferences.mockResolvedValue(BACKEND_PREFS)
    useAdapterStore.setState({
      adapters: [],
      adapterPreferences: DEFAULT_ADAPTER_PREFERENCES,
      lastFallbackHistory: [],
      marketplaceItems: [],
      openSettingsPanel: false,
    })
  })

  it('initial state has empty adapters and default preferences', () => {
    const state = useAdapterStore.getState()
    expect(state.adapters).toEqual([])
    expect(state.adapterPreferences.defaultAdapter).toBe('claude-code')
    expect(state.lastFallbackHistory).toEqual([])
    expect(state.marketplaceItems).toEqual([])
    expect(state.openSettingsPanel).toBe(false)
  })

  it('setOpenSettingsPanel toggles the flag', () => {
    useAdapterStore.getState().setOpenSettingsPanel(true)
    expect(useAdapterStore.getState().openSettingsPanel).toBe(true)
    useAdapterStore.getState().setOpenSettingsPanel(false)
    expect(useAdapterStore.getState().openSettingsPanel).toBe(false)
  })

  it('loadAdapters fetches adapters from IPC', async () => {
    await useAdapterStore.getState().loadAdapters()
    const state = useAdapterStore.getState()
    expect(state.adapters).toHaveLength(1)
    expect(state.adapters[0].name).toBe('claude-code')
    expect(state.adapters[0].installed).toBe(true)
  })

  it('loadAdapterPreferences fetches preferences from IPC', async () => {
    await useAdapterStore.getState().loadAdapterPreferences()
    const state = useAdapterStore.getState()
    expect(state.adapterPreferences.defaultAdapter).toBe('claude-code')
    expect(state.adapterPreferences.fallbackOrder).toEqual(['codex', 'opencode', 'mcp'])
  })

  it('loadAdapterPreferences 用后端返回值覆盖默认占位，而不是硬编码字面量', async () => {
    getAdapterPreferences.mockResolvedValue({
      defaultAdapter: 'codex',
      fallbackOrder: ['claude-code', 'mcp'],
    })
    await useAdapterStore.getState().loadAdapterPreferences()
    const state = useAdapterStore.getState()
    expect(state.adapterPreferences.defaultAdapter).toBe('codex')
    expect(state.adapterPreferences.fallbackOrder).toEqual(['claude-code', 'mcp'])
    // 不能停在默认占位上
    expect(state.adapterPreferences).not.toEqual(DEFAULT_ADAPTER_PREFERENCES)
  })

  it('setAdapterPreferences saves and updates state', async () => {
    const newPrefs = { defaultAdapter: 'codex', fallbackOrder: ['claude-code', 'mcp'] }
    await useAdapterStore.getState().setAdapterPreferences(newPrefs)
    expect(useAdapterStore.getState().adapterPreferences.defaultAdapter).toBe('codex')
    expect(window.electronAPI['settings:setAdapterPreferences']).toHaveBeenCalledWith(newPrefs)
  })

  it('loadMarketplaceItems fetches items from IPC', async () => {
    await useAdapterStore.getState().loadMarketplaceItems()
    const state = useAdapterStore.getState()
    expect(state.marketplaceItems).toHaveLength(1)
    expect(state.marketplaceItems[0].name).toBe('claude-code')
  })
})
