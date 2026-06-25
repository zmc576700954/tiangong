/**
 * BizGraph 配置管理器
 * 参考 cc-switch 设计：统一 JSON 配置，一键管理 CLI 工具
 * 存储路径：userData/settings.json
 */

import { app, safeStorage } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawnSync, spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { isErrorWithCode } from './shared/errno'
import type {
  CliToolConfig,
  ApiKeyConfig,
  McpServerConfig,
  BizGraphSettings,
  AdapterPreferences,
} from '@shared/types'
import { BizGraphError, IpcError, ErrorCode } from './errors'
import { createLogger } from './shared/logger'

const logger = createLogger('Settings')

// Re-export types for backward compatibility
export type { CliToolConfig, ApiKeyConfig, McpServerConfig, BizGraphSettings, AdapterPreferences }

const DEFAULT_ADAPTER_PREFERENCES: AdapterPreferences = {
  defaultAdapter: 'claude-code',
  fallbackOrder: ['codex', 'opencode', 'cline', 'kilo-code', 'kimi-code', 'qwen-code', 'codebuddy', 'qoder', 'cursor', 'mcp'],
}

/** Known adapter names registered in the adapter registry.
 *  Kept in sync with src/main/adapters/registry.ts ADAPTER_REGISTRY.
 */
const KNOWN_ADAPTER_NAMES = new Set([
  'claude-code', 'codex', 'opencode', 'cline', 'kilo-code', 'kimi-code',
  'codebuddy', 'qoder', 'qwen-code', 'cursor', 'mcp', 'mindmap-internal',
])

const DEFAULT_SETTINGS: BizGraphSettings = {
  version: 1,
  cliTools: [
    {
      name: 'claude-code',
      npmPackage: '@anthropic-ai/claude-code',
      command: 'claude',
      installed: false,
    },
    {
      name: 'codex',
      npmPackage: '@openai/codex',
      command: 'codex',
      installed: false,
    },
    {
      name: 'opencode',
      npmPackage: 'opencode',
      command: 'opencode',
      installed: false,
    },
  ],
  apiKeys: [],
  defaultModel: 'claude-3-7-sonnet-20250219',
  mcpServers: [
    {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      enabled: true,
    },
    {
      name: 'git',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-git'],
      enabled: true,
    },
  ],
  adapterPreferences: DEFAULT_ADAPTER_PREFERENCES,
}

// ============================================
// API Key 加密
// ============================================

const API_KEY_PREFIX_ENC = 'enc:'
// SECURITY: fbk: keys use AES-256-CBC with a key derived from userData path + random salt.
// This is obfuscation, NOT real encryption against a local attacker who can read the salt file
// and the application path. It only raises the bar above plaintext storage. For real protection,
// rely on OS keychain (safeStorage) which is preferred when available.
const API_KEY_PREFIX_FALLBACK = 'fbk:'

/** 当 safeStorage 不可用时，使用基于随机盐 + 机器标识的密钥进行 AES 加密 */
let cachedFallbackKey: Buffer | null = null
async function getFallbackKey(): Promise<Buffer> {
  if (cachedFallbackKey) return cachedFallbackKey
  const saltPath = path.join(app.getPath('userData'), '.bizgraph-salt')
  let salt: Buffer
  try {
    salt = await fs.readFile(saltPath)
    if (salt.length < 16) throw new Error('salt too short')
  } catch {
    salt = randomBytes(32)
    await fs.writeFile(saltPath, salt, { mode: 0o600 })
  }
  // 密钥派生：userData 路径 + 随机盐，确保每台安装有唯一密钥
  const keyMaterial = app.getPath('userData') + ':' + salt.toString('base64')
  cachedFallbackKey = scryptSync(keyMaterial, salt, 32)
  return cachedFallbackKey
}

async function encryptFallback(plain: string): Promise<string> {
  const key = await getFallbackKey()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${API_KEY_PREFIX_FALLBACK}${iv.toString('base64')}:${encrypted.toString('base64')}`
}

async function decryptFallback(encrypted: string): Promise<string> {
  const payload = encrypted.slice(API_KEY_PREFIX_FALLBACK.length)
  const [ivB64, dataB64] = payload.split(':')
  if (!ivB64 || !dataB64) throw new BizGraphError('Invalid fallback encrypted format', ErrorCode.SETTINGS_INVALID_FORMAT)
  const key = await getFallbackKey()
  const iv = Buffer.from(ivB64, 'base64')
  if (iv.length !== 16) {
    throw new BizGraphError('Invalid IV length: AES-256-CBC requires 16 bytes', ErrorCode.SETTINGS_INVALID_FORMAT)
  }
  const encryptedData = Buffer.from(dataB64, 'base64')
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()])
  return decrypted.toString('utf8')
}

async function encryptApiKey(key: string): Promise<string> {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(key)
      return `${API_KEY_PREFIX_ENC}${encrypted.toString('base64')}`
    } catch (err) {
      logger.warn('safeStorage encryption failed, using fallback:', err)
      // safeStorage 在部分 Linux 环境下可能失败，回退到 fallback
    }
  }
  return encryptFallback(key)
}

async function decryptApiKey(encrypted: string): Promise<string> {
  if (encrypted.startsWith(API_KEY_PREFIX_ENC)) {
    try {
      const buf = Buffer.from(encrypted.slice(API_KEY_PREFIX_ENC.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch (err) {
      logger.warn('safeStorage decryption failed, trying fallback:', err)
      // safeStorage 解密失败，尝试 fallback（可能是从其他机器迁移的数据）
    }
  }
  if (encrypted.startsWith(API_KEY_PREFIX_FALLBACK)) {
    return decryptFallback(encrypted)
  }
  // SECURITY: plain: prefix returns the API key as base64-decoded plaintext.
  // This exists solely for backward compatibility with v0 configs. These keys should
  // never be logged, cached in plaintext, or exposed via IPC responses without masking.
  // 向后兼容：旧版 plain: 前缀（base64 编码的明文）
  if (encrypted.startsWith('plain:')) {
    try {
      return Buffer.from(encrypted.slice('plain:'.length), 'base64').toString('utf8')
    } catch (err) {
      logger.warn('Failed to decode plain: prefixed API key:', err)
      return ''
    }
  }
  // 向后兼容：裸明文 Key（旧版本直接存储）
  // 验证格式：只允许字母数字、连字符、下划线、点号（常见 API key 字符集）
  if (encrypted.length > 0) {
    if (!/^[\w\-./:=+]+$/.test(encrypted)) {
      logger.error('Unencrypted API key contains invalid characters, rejecting for security')
      return ''
    }
    logger.warn('Unencrypted API key detected. It will be re-encrypted on next save.')
    return encrypted
  }
  return ''
}

/**
 * 检测 API Key 是否为旧版未加密格式，需要迁移
 */
export function needsMigration(encrypted: string): boolean {
  return !encrypted.startsWith(API_KEY_PREFIX_ENC) && !encrypted.startsWith(API_KEY_PREFIX_FALLBACK) && encrypted !== ''
}

async function encryptSettings(settings: BizGraphSettings): Promise<BizGraphSettings> {
  return {
    ...settings,
    apiKeys: await Promise.all(settings.apiKeys.map(async (k) => ({
      ...k,
      key: await encryptApiKey(k.key),
    }))),
  }
}

async function decryptSettings(settings: BizGraphSettings): Promise<BizGraphSettings> {
  return {
    ...settings,
    apiKeys: await Promise.all(settings.apiKeys.map(async (k) => ({
      ...k,
      key: await decryptApiKey(k.key),
    }))),
  }
}

const SETTINGS_FILENAME = 'settings.json'

let cachedSettings: BizGraphSettings | null = null
let cachedAt = 0
const CACHE_TTL_MS = 30_000

/**
 * 轻量级 JSON 结构验证：确保解析后的对象符合 BizGraphSettings 基本结构，
 * 防止恶意或损坏的配置文件导致运行时异常。
 */
function validateSettingsShape(data: unknown): data is Partial<BizGraphSettings> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  const obj = data as Record<string, unknown>
  // version 必须是数字
  if (obj.version !== undefined && typeof obj.version !== 'number') return false
  // cliTools 必须是数组
  if (obj.cliTools !== undefined && !Array.isArray(obj.cliTools)) return false
  // apiKeys 必须是数组，且每个元素必须有 provider 和 key 字段
  if (obj.apiKeys !== undefined) {
    if (!Array.isArray(obj.apiKeys)) return false
    for (const item of obj.apiKeys) {
      if (item === null || typeof item !== 'object') return false
      const k = item as Record<string, unknown>
      if (typeof k.provider !== 'string' || typeof k.key !== 'string') return false
    }
  }
  // defaultModel 必须是字符串
  if (obj.defaultModel !== undefined && typeof obj.defaultModel !== 'string') return false
  // mcpServers 必须是数组
  if (obj.mcpServers !== undefined) {
    if (!Array.isArray(obj.mcpServers)) return false
    for (const item of obj.mcpServers) {
      if (item === null || typeof item !== 'object') return false
      const s = item as Record<string, unknown>
      if (typeof s.name !== 'string' || typeof s.command !== 'string') return false
    }
  }
  // adapterPreferences 必须是对象
  if (obj.adapterPreferences !== undefined) {
    if (obj.adapterPreferences === null || typeof obj.adapterPreferences !== 'object' || Array.isArray(obj.adapterPreferences)) return false
    const prefs = obj.adapterPreferences as Record<string, unknown>
    if (prefs.defaultAdapter !== undefined && typeof prefs.defaultAdapter !== 'string') return false
    if (prefs.fallbackOrder !== undefined && !Array.isArray(prefs.fallbackOrder)) return false
  }
  // customAgentTypes 必须是数组
  if (obj.customAgentTypes !== undefined && !Array.isArray(obj.customAgentTypes)) return false
  return true
}

// ============================================
// 配置读写
// ============================================

export async function getSettingsPath(): Promise<string> {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, SETTINGS_FILENAME)
}

export async function readSettings(): Promise<BizGraphSettings> {
  if (cachedSettings && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSettings
  const settingsPath = await getSettingsPath()
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    // 验证 JSON 结构合法性，防止恶意或损坏的配置导致运行时异常
    if (!validateSettingsShape(parsed)) {
      logger.warn('Settings file has invalid structure, using defaults')
      cachedSettings = { ...DEFAULT_SETTINGS }
      cachedAt = Date.now()
      return cachedSettings
    }
    const merged = mergeSettings(DEFAULT_SETTINGS, parsed)
    cachedSettings = await decryptSettings(merged)
    cachedAt = Date.now()
    return cachedSettings
  } catch (err) {
    const isEnoent = isErrorWithCode(err) && err.code === 'ENOENT'
    if (isEnoent) {
      // 首次启动：写入默认配置，后续读取不再触发 ENOENT
      logger.info('Settings file not found, creating with defaults')
      const defaults = { ...DEFAULT_SETTINGS }
      try { await writeSettings(defaults) } catch (e) { logger.warn('Failed to write initial default settings:', e) }
      cachedSettings = defaults
    } else {
      logger.warn('Failed to read settings file, using defaults:', err)
      cachedSettings = { ...DEFAULT_SETTINGS }
    }
    cachedAt = Date.now()
    return cachedSettings
  }
}

export async function writeSettings(settings: BizGraphSettings): Promise<void> {
  const settingsPath = await getSettingsPath()
  const encrypted = await encryptSettings(settings)
  await fs.writeFile(settingsPath, JSON.stringify(encrypted, null, 2), { encoding: 'utf-8', mode: 0o600 })
  cachedSettings = settings
}

function mergeSettings(
  defaults: BizGraphSettings,
  saved: Partial<BizGraphSettings>,
): BizGraphSettings {
  return {
    version: saved.version ?? defaults.version,
    cliTools: mergeCliTools(defaults.cliTools, saved.cliTools ?? []),
    apiKeys: saved.apiKeys ?? defaults.apiKeys,
    defaultModel: saved.defaultModel ?? defaults.defaultModel,
    mcpServers: saved.mcpServers ?? defaults.mcpServers,
    adapterPreferences: saved.adapterPreferences ?? defaults.adapterPreferences,
    customAgentTypes: saved.customAgentTypes ?? defaults.customAgentTypes,
    contextWaterline: saved.contextWaterline ?? defaults.contextWaterline,
  }
}

function mergeCliTools(
  defaults: CliToolConfig[],
  saved: CliToolConfig[],
): CliToolConfig[] {
  const result: CliToolConfig[] = []
  for (const def of defaults) {
    const found = saved.find((s) => s.name === def.name)
    result.push(found ? { ...def, ...found } : { ...def })
  }
  return result
}

// ============================================
// CLI 工具检测
// ============================================

export async function detectCliTool(name: string): Promise<{
  installed: boolean
  version?: string
  path?: string
}> {
  const settings = await readSettings()
  const tool = settings.cliTools.find((t) => t.name === name)
  if (!tool) return { installed: false }
  try {
    const result = spawnSync(tool.command, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return { installed: false }
    const version = (result.stdout ?? '').trim().split(/\r?\n/)[0]
    let cmdPath: string | undefined
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which'
      const whichResult = spawnSync(whichCmd, [tool.command], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      if (!whichResult.error && whichResult.status === 0) {
        cmdPath = (whichResult.stdout ?? '').trim().split(/\r?\n/)[0]
      }
    } catch (err) {
      logger.warn(`Failed to find path for ${tool.command}:`, err)
    }
    return { installed: true, version, path: cmdPath }
  } catch (err) {
    logger.warn(`Failed to detect CLI tool ${name}:`, err)
    return { installed: false }
  }
}

export async function refreshAllCliStatus(): Promise<CliToolConfig[]> {
  const settings = await readSettings()
  const updated = await Promise.all(
    settings.cliTools.map(async (tool) => {
      const detected = await detectCliTool(tool.name)
      return { ...tool, ...detected }
    }),
  )
  settings.cliTools = updated
  await writeSettings(settings)
  return updated
}

function validateNpmPackageName(pkg: string): boolean {
  // npm 包名格式验证：防命令注入
  return /^(@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/.test(pkg)
}

/** Resolve the absolute path to the npm executable without relying on shell resolution.
 *  Result is cached after the first call — npm location does not change at runtime. */
let _cachedNpmCmd: string | undefined
function resolveNpmCommand(): string {
  if (_cachedNpmCmd) return _cachedNpmCmd
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where', ['npm.cmd'], { encoding: 'utf-8' })
      if (result.status === 0) {
        _cachedNpmCmd = result.stdout.trim().split(/\r?\n/)[0]
        return _cachedNpmCmd
      }
    } catch {
      /* ignore */
    }
    _cachedNpmCmd = 'npm.cmd'
    return _cachedNpmCmd
  }
  try {
    const result = spawnSync('which', ['npm'], { encoding: 'utf-8' })
    if (result.status === 0) {
      _cachedNpmCmd = result.stdout.trim()
      return _cachedNpmCmd
    }
  } catch {
    /* ignore */
  }
  _cachedNpmCmd = 'npm'
  return _cachedNpmCmd
}

/** Reset the cached npm command path. Intended for test use only. */
export function _resetNpmCache(): void {
  _cachedNpmCmd = undefined
}

export async function installCliTool(name: string): Promise<{
  success: boolean
  message: string
}> {
  const settings = await readSettings()
  const tool = settings.cliTools.find((t) => t.name === name)
  if (!tool) return { success: false, message: `Unknown tool: ${name}` }

  if (!validateNpmPackageName(tool.npmPackage)) {
    return { success: false, message: `Invalid package name: ${tool.npmPackage}` }
  }

  // W3-FIX: 检测 npm 是否可用
  const npmCmd = resolveNpmCommand()
  const npmCheck = spawnSync(npmCmd, ['--version'], {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  if (npmCheck.error || npmCheck.status !== 0) {
    return {
      success: false,
      message: 'npm is not installed or not in PATH. Please install Node.js first: https://nodejs.org/',
    }
  }

  return new Promise((resolve) => {
    const proc = spawn(npmCmd, ['install', '-g', tool.npmPackage], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err: Error) => {
      // W3-FIX: 检测权限错误并提供提示
      const code = isErrorWithCode(err) ? err.code : undefined
      if (code === 'EACCES') {
        resolve({
          success: false,
          message: `Permission denied. Try: sudo npm install -g ${tool.npmPackage} (macOS/Linux) or run as Administrator (Windows)`,
        })
      } else {
        resolve({ success: false, message: `Install failed: ${err.message}` })
      }
    })

    proc.on('close', async (code: number | null) => {
      if (code !== 0) {
        const combined = stderr + stdout
        // W3-FIX: 检测常见权限错误信息
        if (combined.includes('EACCES') || combined.includes('permission denied') || combined.includes('Operation not permitted')) {
          resolve({
            success: false,
            message: `Permission denied. Try: sudo npm install -g ${tool.npmPackage} (macOS/Linux) or run as Administrator (Windows)`,
          })
        } else {
          resolve({ success: false, message: `Install failed: ${stderr.slice(0, 500)}` })
        }
        return
      }

      try {
        const detected = await detectCliTool(name)
        const idx = settings.cliTools.findIndex((t) => t.name === name)
        settings.cliTools[idx] = { ...tool, ...detected }
        await writeSettings(settings)
        resolve({
          success: detected.installed,
          message: detected.installed
            ? `${tool.name} installed successfully (${detected.version})`
            : `Install command ran but tool not detected`,
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        resolve({ success: false, message: `Install failed: ${msg}` })
      }
    })
  })
}

// ============================================
// API Key 管理
// ============================================

/** 遮蔽 API Key，仅保留前4位和后4位，中间用 **** 替代 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

export async function getApiKey(provider: string): Promise<string | undefined> {
  const settings = await readSettings()
  return settings.apiKeys.find((k) => k.provider === provider)?.key
}

const ALLOWED_PROVIDERS: ApiKeyConfig['provider'][] = ['anthropic', 'openai', 'deepseek', 'gemini']

export async function setApiKey(
  provider: string,
  key: string,
  baseUrl?: string,
): Promise<void> {
  if (!ALLOWED_PROVIDERS.includes(provider as ApiKeyConfig['provider'])) {
    throw new BizGraphError(`Invalid provider: ${provider}. Allowed: ${ALLOWED_PROVIDERS.join(', ')}`, ErrorCode.IPC_INVALID_ARGUMENT)
  }
  const settings = await readSettings()
  const idx = settings.apiKeys.findIndex((k) => k.provider === provider)
  if (idx >= 0) {
    settings.apiKeys[idx] = { provider: provider as ApiKeyConfig['provider'], key, baseUrl }
  } else {
    settings.apiKeys.push({ provider: provider as ApiKeyConfig['provider'], key, baseUrl })
  }
  await writeSettings(settings)
}

// ============================================
// MCP Server 管理
// ============================================

export async function updateMcpServer(
  server: McpServerConfig,
): Promise<void> {
  const settings = await readSettings()
  const idx = settings.mcpServers.findIndex((s) => s.name === server.name)
  if (idx >= 0) {
    settings.mcpServers[idx] = server
  } else {
    settings.mcpServers.push(server)
  }
  await writeSettings(settings)
}

// ============================================
// 适配器偏好管理
// ============================================

export async function getAdapterPreferences(): Promise<AdapterPreferences> {
  const settings = await readSettings()
  return settings.adapterPreferences ?? DEFAULT_ADAPTER_PREFERENCES
}

export async function setAdapterPreferences(prefs: AdapterPreferences): Promise<void> {
  if (!prefs.defaultAdapter || typeof prefs.defaultAdapter !== 'string') {
    throw new IpcError('defaultAdapter is required', ErrorCode.IPC_INVALID_ARGUMENT)
  }
  if (!KNOWN_ADAPTER_NAMES.has(prefs.defaultAdapter)) {
    throw new IpcError(`Unknown defaultAdapter: ${prefs.defaultAdapter}`, ErrorCode.IPC_INVALID_ARGUMENT)
  }
  if (!Array.isArray(prefs.fallbackOrder)) {
    throw new IpcError('fallbackOrder must be an array', ErrorCode.IPC_INVALID_ARGUMENT)
  }
  for (const name of prefs.fallbackOrder) {
    if (typeof name !== 'string' || !KNOWN_ADAPTER_NAMES.has(name)) {
      throw new IpcError(`Unknown adapter in fallbackOrder: ${name}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
  }
  const settings = await readSettings()
  settings.adapterPreferences = {
    defaultAdapter: prefs.defaultAdapter,
    fallbackOrder: prefs.fallbackOrder,
  }
  await writeSettings(settings)
}
