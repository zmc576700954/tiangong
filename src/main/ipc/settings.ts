/**
 * Settings IPC Handlers
 * 配置管理：CLI 工具、API Key、模型设置、适配器偏好
 */

import type { TypedHandle } from './utils'

export function registerSettingsHandlers(typedHandle: TypedHandle): void {
  typedHandle('settings:read', async () => {
    const { readSettings } = await import('../settings')
    return readSettings()
  })

  typedHandle('settings:write', async (_, settings) => {
    const { writeSettings } = await import('../settings')
    await writeSettings(settings)
  })

  typedHandle('settings:refreshCli', async () => {
    const { refreshAllCliStatus } = await import('../settings')
    return refreshAllCliStatus()
  })

  typedHandle('settings:installCli', async (_, name) => {
    const { installCliTool } = await import('../settings')
    return installCliTool(name)
  })

  typedHandle('settings:setApiKey', async (_, provider, key, baseUrl) => {
    const { setApiKey } = await import('../settings')
    await setApiKey(provider, key, baseUrl ?? undefined)
  })

  typedHandle('settings:getAdapterPreferences', async () => {
    const { getAdapterPreferences } = await import('../settings')
    return getAdapterPreferences()
  })

  typedHandle('settings:setAdapterPreferences', async (_, prefs) => {
    const { setAdapterPreferences } = await import('../settings')
    await setAdapterPreferences(prefs)
  })
}
