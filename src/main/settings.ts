/**
 * BizGraph 配置管理器
 * 参考 cc-switch 设计：统一 JSON 配置，一键管理 CLI 工具
 * 存储路径：userData/settings.json
 */

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execSync } from 'node:child_process'

// ============================================
// 配置类型定义
// ============================================

export interface CliToolConfig {
  name: string
  npmPackage: string
  command: string
  installed: boolean
  version?: string
  path?: string
}

export interface ApiKeyConfig {
  provider: 'anthropic' | 'openai' | 'deepseek' | 'gemini'
  key: string
  baseUrl?: string
}

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  enabled: boolean
}

export interface BizGraphSettings {
  version: number
  cliTools: CliToolConfig[]
  apiKeys: ApiKeyConfig[]
  defaultModel?: string
  mcpServers: McpServerConfig[]
}

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

const SETTINGS_FILENAME = 'settings.json'

let cachedSettings: BizGraphSettings | null = null

// ============================================
// 配置读写
// ============================================

export async function getSettingsPath(): Promise<string> {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, SETTINGS_FILENAME)
}

export async function readSettings(): Promise<BizGraphSettings> {
  if (cachedSettings) return cachedSettings
  const settingsPath = await getSettingsPath()
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as BizGraphSettings
    cachedSettings = mergeSettings(DEFAULT_SETTINGS, parsed)
    return cachedSettings
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS }
    return cachedSettings
  }
}

export async function writeSettings(settings: BizGraphSettings): Promise<void> {
  cachedSettings = settings
  const settingsPath = await getSettingsPath()
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
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
    const result = execSync(`${tool.command} --version`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const version = result.trim().split(/\r?\n/)[0]
    let cmdPath: string | undefined
    try {
      cmdPath = execSync(
        process.platform === 'win32' ? `where ${tool.command}` : `which ${tool.command}`,
        { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] },
      )
        .trim()
        .split(/\r?\n/)[0]
    } catch {}
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

export async function installCliTool(name: string): Promise<{
  success: boolean
  message: string
}> {
  const settings = await readSettings()
  const tool = settings.cliTools.find((t) => t.name === name)
  if (!tool) return { success: false, message: `Unknown tool: ${name}` }
  try {
    execSync(`npm install -g ${tool.npmPackage}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    })
    const detected = await detectCliTool(name)
    const idx = settings.cliTools.findIndex((t) => t.name === name)
    settings.cliTools[idx] = { ...tool, ...detected }
    await writeSettings(settings)
    return {
      success: detected.installed,
      message: detected.installed
        ? `${tool.name} installed successfully (${detected.version})`
        : `Install command ran but tool not detected`,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, message: `Install failed: ${msg}` }
  }
}

// ============================================
// API Key 管理
// ============================================

export async function getApiKey(provider: string): Promise<string | undefined> {
  const settings = await readSettings()
  return settings.apiKeys.find((k) => k.provider === provider)?.key
}

export async function setApiKey(
  provider: string,
  key: string,
  baseUrl?: string,
): Promise<void> {
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
