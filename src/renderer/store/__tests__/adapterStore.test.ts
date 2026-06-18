import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAdapterStore } from '../adapterStore'

vi.stubGlobal('window', {
  electronAPI: {
    'agent:listAdapters': vi.fn().mockResolvedValue([
      { name: 'claude-code', version: '1.0.0', installed: true },
    ]),
    'settings:getAdapterPreferences': vi.fn().mockResolvedValue({
      defaultAdapter: 'claude-code',
      fallbackOrder: ['codex', 'opencode', 'mcp'],
    }),
    'settings:setAdapterPreferences': vi.fn().mockResolvedValue(undefined),
    'agent:getAdapterMarketplace': vi.fn().mockResolvedValue([
      { name: 'claude-code', installed: true, installMethod: 'npm' },
    ]),
  },
})

describe('adapterStore', () => {
  beforeEach(() => {
    useAdapterStore.setState({
      adapters: [],
      adapterPreferences: { defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode', 'mcp'] },
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
