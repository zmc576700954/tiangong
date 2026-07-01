/**
 * Settings IPC Handlers
 * 配置管理：CLI 工具、API Key、模型设置、适配器偏好
 */

import type { TypedHandle } from './utils'
import { IpcError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'
import type { ContextWaterline } from '../memory/context-waterline'

const logger = createLogger('SettingsIPC')

/**
 * Regex to detect masked API keys like `sk-****abcd` or `****`.
 * Requires at least 4 consecutive asterisks to avoid false positives on
 * legitimate short tokens that happen to contain `**` (e.g. `t0k**en1`).
 */
const MASKED_KEY_PATTERN = /^\S{0,4}\*{4,}\S{0,4}$/

/** 已知适配器名称白名单，防止 settings:installCli 执行任意命令 */
const KNOWN_ADAPTER_NAMES = new Set([
  'claude-code', 'codex', 'opencode', 'cline', 'kilo-code', 'kimi-code',
  'cursor', 'codebuddy', 'qoder', 'qwen-code', 'mcp', 'mindmap-internal',
])

/**
 * 安全命令令牌：仅允许字母、数字、点、下划线、连字符（可选携带平台扩展名）。
 * 拒绝路径分隔符、空格、shell 元字符——阻止渲染进程把 command 指向任意
 * 绝对路径可执行文件或注入 shell 元字符（H2）。PATH 解析的裸命令名仍可用。
 */
const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * 已知可直接执行内联代码的危险参数标志。
 * 即使 command 通过了白名单（node/python），这些 arg 也能在主进程中执行任意代码，
 * 因此一并拒绝（see finding #1 in code review）。
 *
 * node:   --eval / -e / --print / -p / --input-type=module（stdin eval）
 * python: -c
 * deno/bun: eval（子命令）
 */
const DANGEROUS_ARG_PATTERNS = [
  /^--eval$/i,
  /^--eval=/i,        // 带值形式：node --eval=<code>
  /^-e$/,
  /^--print$/i,
  /^--print=/i,       // 带值形式：node --print=<code>
  /^-p$/,
  /^-c$/,
  /^-c.+/,            // 紧跟 code 的形式：python -c<code>
  /^eval$/i,
  /^--input-type=/i,  // node --input-type=module 配合 stdin eval
]

function assertSafeCommand(command: unknown, context: string): void {
  if (typeof command !== 'string' || command.length === 0 || command.length > 128) {
    throw new IpcError(`${context}: command must be a non-empty string`, ErrorCode.IPC_INVALID_ARGUMENT)
  }
  if (!SAFE_COMMAND_PATTERN.test(command)) {
    throw new IpcError(
      `${context}: command must be a bare executable name (no paths or shell metacharacters)`,
      ErrorCode.IPC_INVALID_ARGUMENT,
    )
  }
}

function assertSafeArgs(args: string[], context: string): void {
  for (const arg of args) {
    if (arg.length > 1024) {
      throw new IpcError(`${context}: arg exceeds maximum length of 1024 characters`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
    // Null bytes and unescaped newlines are injection indicators
    if (arg.includes('\0') || arg.includes('\n') || arg.includes('\r')) {
      throw new IpcError(`${context}: arg contains invalid control characters`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
    // Block flags that allow inline code execution in common interpreter commands
    if (DANGEROUS_ARG_PATTERNS.some((p) => p.test(arg))) {
      throw new IpcError(
        `${context}: arg "${arg}" is not permitted (code-execution flag)`,
        ErrorCode.IPC_INVALID_ARGUMENT,
      )
    }
  }
}

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
    // 校验 CLI 工具命令：阻止渲染进程把 command 指向任意可执行文件（H2）
    if (settings.cliTools !== undefined) {
      if (!Array.isArray(settings.cliTools)) {
        throw new IpcError('cliTools must be an array', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      for (const tool of settings.cliTools) {
        if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') {
          throw new IpcError('Each cliTool must have a string name', ErrorCode.IPC_INVALID_ARGUMENT)
        }
        assertSafeCommand(tool.command, `cliTool '${tool.name}'`)
      }
    }
    // 校验 MCP server 命令与参数：command 必须安全、args 必须全为字符串
    if (settings.mcpServers !== undefined) {
      if (!Array.isArray(settings.mcpServers)) {
        throw new IpcError('mcpServers must be an array', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      for (const server of settings.mcpServers) {
        if (!server || typeof server !== 'object' || typeof server.name !== 'string') {
          throw new IpcError('Each mcpServer must have a string name', ErrorCode.IPC_INVALID_ARGUMENT)
        }
        assertSafeCommand(server.command, `mcpServer '${server.name}'`)
        if (!Array.isArray(server.args) || server.args.some((a: unknown) => typeof a !== 'string')) {
          throw new IpcError(`mcpServer '${server.name}': args must be an array of strings`, ErrorCode.IPC_INVALID_ARGUMENT)
        }
        assertSafeArgs(server.args as string[], `mcpServer '${server.name}'`)
      }
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
    const { setApiKey, readSettings } = await import('../settings')
    // 渲染进程只持有遮蔽后的 key（settings:read 返回的形式）。若把遮蔽值原样写回，
    // 会用 mask 字符串覆盖真实 key。检测到遮蔽值时保留现有真实 key（与 settings:write 一致）。
    if (typeof key === 'string' && MASKED_KEY_PATTERN.test(key)) {
      const current = await readSettings()
      const existing = current.apiKeys.find((k) => k.provider === provider)
      if (existing && existing.key) {
        // 已读取 current，直接复用以更新 baseUrl（如有变化），避免 setApiKey 二次 readSettings
        if (baseUrl !== undefined) {
          existing.baseUrl = baseUrl
        }
        const { writeSettings } = await import('../settings')
        await writeSettings(current)
        return
      }
      // 无现有真实 key 可保留：拒绝写入遮蔽值，避免污染存储
      throw new IpcError('Cannot set a masked API key value', ErrorCode.IPC_INVALID_ARGUMENT)
    }
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
