import { create } from 'zustand'
import type { AdapterPreferences, AdapterFallbackAttempt, AdapterMarketplaceItem } from '@shared/types'

export interface AdapterState {
  adapters: { name: string; version: string; installed: boolean }[]
  adapterPreferences: AdapterPreferences
  /** 最近一次 startSession 的回退历史（用于 UI 展示） */
  lastFallbackHistory: AdapterFallbackAttempt[]
  /** 适配器市场数据（含安装状态和安装方式） */
  marketplaceItems: AdapterMarketplaceItem[]
  /** 是否需要打开设置面板（跨面板通信标志） */
  openSettingsPanel: boolean

  loadAdapters: () => Promise<void>
  loadAdapterPreferences: () => Promise<void>
  setAdapterPreferences: (prefs: AdapterPreferences) => Promise<void>
  loadMarketplaceItems: () => Promise<void>
  setOpenSettingsPanel: (open: boolean) => void
}

export const useAdapterStore = create<AdapterState>((set) => ({
  adapters: [],
  adapterPreferences: { defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode', 'cline', 'kilo-code', 'kimi-code', 'qwen-code', 'codebuddy', 'qoder', 'cursor', 'mcp'] },
  lastFallbackHistory: [],
  marketplaceItems: [],
  openSettingsPanel: false,

  loadAdapters: async () => {
    const adapters = await window.electronAPI['agent:listAdapters']()
    set({ adapters })
  },

  loadAdapterPreferences: async () => {
    try {
      const prefs = await window.electronAPI['settings:getAdapterPreferences']()
      set({ adapterPreferences: prefs })
    } catch (err) {
      console.error('[adapterStore] Failed to load adapter preferences:', err)
    }
  },

  setAdapterPreferences: async (prefs) => {
    try {
      await window.electronAPI['settings:setAdapterPreferences'](prefs)
      set({ adapterPreferences: prefs })
    } catch (err) {
      console.error('[adapterStore] Failed to save adapter preferences:', err)
    }
  },

  loadMarketplaceItems: async () => {
    try {
      const items = await window.electronAPI['agent:getAdapterMarketplace']()
      set({ marketplaceItems: items })
    } catch (err) {
      console.error('[adapterStore] Failed to load marketplace items:', err)
    }
  },

  setOpenSettingsPanel: (open) => {
    set({ openSettingsPanel: open })
  },
}))
