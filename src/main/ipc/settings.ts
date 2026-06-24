/**
 * Settings IPC Handlers
 * 配置管理：CLI 工具、API Key、模型设置、适配器偏好
 */

import type { TypedHandle } from './utils'
import { IpcError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'
import type { ContextWaterline } from '../memory/context-waterline'

const logger = createLogger('SettingsIPC')

/** Regex to detect masked API keys like `sk-****abcd` or `****` */
const MASKED_KEY_PATTERN = /^\S{0,4}\*{2,}\S{0,4}$/

/** 已知适配器名称白名单，防止 settings:installCli 执行任意命令 */
const KNOWN_ADAPTER_NAMES = new Set([
  'claude-code', 'codex', 'opencode', 'cline', 'kilo-code', 'kimi-code',
  'cursor', 'codebuddy', 'qoder', 'qwen-code', 'mcp', 'mindmap',
])

export function registerSettingsHandlers(
  typedHandle: TypedHandle,
  waterline?: ContextWaterline,
): void {
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
      // Preserve real keys when the renderer sends back masked values.
      // The renderer only sees masked keys (e.g. "sk-****abcd"), so writing them
      // back would overwrite the real values. Read the current decrypted keys and
      // keep the existing value for any masked entry.
      const { readSettings } = await import('../settings')
      const current = await readSettings()
      for (const incoming of settings.apiKeys) {
        if (MASKED_KEY_PATTERN.test(incoming.key)) {
          const existingPlain = current.apiKeys.find((k) => k.provider === incoming.provider)
          if (existingPlain && existingPlain.key) {
            // writeSettings will handle encryption
            incoming.key = existingPlain.key
          }
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
    const { readSettings } = await import('../settings')
    const settings = await readSettings()
    return {
      autoCompactEnabled: settings.contextWaterline?.autoCompactEnabled ?? true,
      autoCompactThreshold: settings.contextWaterline?.autoCompactThreshold ?? 0.75,
      minCompactInterval: settings.contextWaterline?.minCompactInterval ?? 60_000,
    }
  })

  typedHandle('settings:setContextWaterlineConfig', async (_, cfg) => {
    if (!cfg || typeof cfg !== 'object') {
      throw new IpcError('contextWaterline config must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (cfg.autoCompactEnabled !== undefined && typeof cfg.autoCompactEnabled !== 'boolean') {
      throw new IpcError('autoCompactEnabled must be a boolean', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (cfg.autoCompactThreshold !== undefined) {
      if (typeof cfg.autoCompactThreshold !== 'number' || cfg.autoCompactThreshold < 0 || cfg.autoCompactThreshold > 1) {
        throw new IpcError('autoCompactThreshold must be a number between 0 and 1', ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
    if (cfg.minCompactInterval !== undefined) {
      if (typeof cfg.minCompactInterval !== 'number' || cfg.minCompactInterval < 0) {
        throw new IpcError('minCompactInterval must be a non-negative number', ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }

    const { readSettings, writeSettings } = await import('../settings')
    const settings = await readSettings()
    settings.contextWaterline = { ...(settings.contextWaterline ?? {}), ...cfg }
    await writeSettings(settings)

    // Apply to runtime ContextWaterline instance
    if (waterline) {
      if (cfg.autoCompactEnabled !== undefined) waterline.autoCompactEnabled = cfg.autoCompactEnabled
      if (cfg.autoCompactThreshold !== undefined) waterline.autoCompactThreshold = cfg.autoCompactThreshold
      if (cfg.minCompactInterval !== undefined) waterline.minCompactInterval = cfg.minCompactInterval
    } else {
      logger.warn('Waterline config persisted but no runtime ContextWaterline instance was provided')
    }
  })
}
