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
import type {
  CliToolConfig,
  ApiKeyConfig,
  McpServerConfig,
  BizGraphSettings,
} from '@shared/types'
import { BizGraphError, ErrorCode } from './errors'

// Re-export types for backward compatibility
export type { CliToolConfig, ApiKeyConfig, McpServerConfig, BizGraphSettings }

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
}

// ============================================
// API Key 加密
// ============================================

const API_KEY_PREFIX_ENC = 'enc:'
const API_KEY_PREFIX_FALLBACK = 'fbk:'

/** 当 safeStorage 不可用时，使用基于用户数据路径的密钥进行 AES 加密 */
let cachedFallbackKey: Buffer | null = null
function getFallbackKey(): Buffer {
  if (cachedFallbackKey) return cachedFallbackKey
  const salt = 'bizgraph-fallback-salt-v1'
  cachedFallbackKey = scryptSync(app.getPath('userData'), salt, 32)
  return cachedFallbackKey
}

function encryptFallback(plain: string): string {
  const key = getFallbackKey()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${API_KEY_PREFIX_FALLBACK}${iv.toString('base64')}:${encrypted.toString('base64')}`
}

function decryptFallback(encrypted: string): string {
  const payload = encrypted.slice(API_KEY_PREFIX_FALLBACK.length)
  const [ivB64, dataB64] = payload.split(':')
  if (!ivB64 || !dataB64) throw new BizGraphError('Invalid fallback encrypted format', ErrorCode.SETTINGS_INVALID_FORMAT)
  const key = getFallbackKey()
  const iv = Buffer.from(ivB64, 'base64')
  if (iv.length !== 16) {
    throw new BizGraphError('Invalid IV length: AES-256-CBC requires 16 bytes', ErrorCode.SETTINGS_INVALID_FORMAT)
  }
  const encryptedData = Buffer.from(dataB64, 'base64')
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()])
  return decrypted.toString('utf8')
}

function encryptApiKey(key: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(key)
      return `${API_KEY_PREFIX_ENC}${encrypted.toString('base64')}`
    } catch {
      // safeStorage 在部分 Linux 环境下可能失败，回退到 fallback
    }
  }
  return encryptFallback(key)
}

function decryptApiKey(encrypted: string): string {
  if (encrypted.startsWith(API_KEY_PREFIX_ENC)) {
    try {
      const buf = Buffer.from(encrypted.slice(API_KEY_PREFIX_ENC.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      // safeStorage 解密失败，尝试 fallback（可能是从其他机器迁移的数据）
    }
  }
  if (encrypted.startsWith(API_KEY_PREFIX_FALLBACK)) {
    return decryptFallback(encrypted)
  }
  // 向后兼容：旧版 plain: 前缀（base64 编码的明文）
  if (encrypted.startsWith('plain:')) {
    try {
      return Buffer.from(encrypted.slice('plain:'.length), 'base64').toString('utf8')
    } catch {
      console.warn('[BizGraph] Failed to decode plain: prefixed API key')
      return ''
    }
  }
  // 向后兼容：裸明文 Key（旧版本直接存储）
  // 标记为需要迁移，但暂不阻断使用
  if (encrypted.length > 0) {
    console.warn('[BizGraph] Unencrypted API key detected. It will be re-encrypted on next save.')
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

function encryptSettings(settings: BizGraphSettings): BizGraphSettings {
  return {
    ...settings,
    apiKeys: settings.apiKeys.map((k) => ({
      ...k,
      key: encryptApiKey(k.key),
    })),
  }
}

function decryptSettings(settings: BizGraphSettings): BizGraphSettings {
  return {
    ...settings,
    apiKeys: settings.apiKeys.map((k) => ({
      ...k,
      key: decryptApiKey(k.key),
    })),
  }
}

const SETTINGS_FILENAME = 'settings.json'

let cachedSettings: BizGraphSettings | null = null
let cachedAt = 0
const CACHE_TTL_MS = 30_000

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
    const parsed = JSON.parse(raw) as BizGraphSettings
    const merged = mergeSettings(DEFAULT_SETTINGS, parsed)
    cachedSettings = decryptSettings(merged)
    cachedAt = Date.now()
    return cachedSettings
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS }
    cachedAt = Date.now()
    return cachedSettings
  }
}

export async function writeSettings(settings: BizGraphSettings): Promise<void> {
  const settingsPath = await getSettingsPath()
  const encrypted = encryptSettings(settings)
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
      console.warn(`[BizGraph] Failed to find path for ${tool.command}:`, err)
    }
    return { installed: true, version, path: cmdPath }
  } catch {
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
  const npmCheck = spawnSync('npm', ['--version'], {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  })
  if (npmCheck.error || npmCheck.status !== 0) {
    return {
      success: false,
      message: 'npm is not installed or not in PATH. Please install Node.js first: https://nodejs.org/',
    }
  }

  return new Promise((resolve) => {
    const proc = spawn('npm', ['install', '-g', tool.npmPackage], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      shell: process.platform === 'win32', // Windows 上需要 shell 来找到 npm.cmd
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
      const code = (err as NodeJS.ErrnoException).code
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
