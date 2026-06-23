/**
 * Settings IPC Handlers
 * 配置管理：CLI 工具、API Key、模型设置、适配器偏好
 */

import type { TypedHandle } from './utils'
import { IpcError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'

const logger = createLogger('SettingsIPC')

/** 已知适配器名称白名单，防止 settings:installCli 执行任意命令 */
const KNOWN_ADAPTER_NAMES = new Set([
  'claude-code', 'codex', 'opencode', 'cline', 'kilo-code', 'kimi-code',
  'cursor', 'codebuddy', 'qoder', 'qwen-code', 'mcp', 'mindmap',
])

export function registerSettingsHandlers(typedHandle: TypedHandle): void {
  typedHandle('settings:read', async () => {
    const { readSettings, maskApiKey } = await import('../settings')
    const settings = await readSettings()
    // 渲染进程不持有完整 API Key，返回遮蔽版本
    return {
      ...settings,
      apiKeys: settings.apiKeys.map((k) => ({
        ...k,
        key: k.key ? maskApiKey(k.key) : '',
      })),
    }
  })

  typedHandle('settings:write', async (_, settings) => {
    if (!settings || typeof settings !== 'object') {
      throw new IpcError('settings must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (settings.apiKeys && !Array.isArray(settings.apiKeys)) {
      throw new IpcError('apiKeys must be an array', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (Array.isArray(settings.apiKeys)) {
      for (const k of settings.apiKeys) {
        if (!k || typeof k !== 'object' || typeof k.provider !== 'string' || typeof k.key !== 'string') {
          throw new IpcError('Each apiKey must have {provider: string, key: string}', ErrorCode.IPC_INVALID_ARGUMENT)
        }
      }
    }
    const { writeSettings } = await import('../settings')
    await writeSettings(settings)
  })

  typedHandle('settings:refreshCli', async () => {
    const { refreshAllCliStatus } = await import('../settings')
    return refreshAllCliStatus()
  })

  typedHandle('settings:installCli', async (_, name) => {
    if (typeof name !== 'string' || !KNOWN_ADAPTER_NAMES.has(name)) {
      throw new IpcError(`Unknown CLI tool name: ${name}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
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

  typedHandle('settings:getContextWaterlineConfig', async () => {
    return {
      autoCompactEnabled: false,
      autoCompactThreshold: 0.75,
      minCompactInterval: 60_000,
    }
  })

  typedHandle('settings:setContextWaterlineConfig', async (_, cfg) => {
    // Phase 2: log but don't persist. Phase 3 will hook this up to:
    // 1) update ContextWaterline runtime config
    // 2) persist to settings.json
    logger.info('Waterline config update received (not yet persisted):', cfg)
  })
}
