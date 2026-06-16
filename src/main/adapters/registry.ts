/**
 * 适配器描述符注册表
 *
 * 像VSCode插件市场一样，提供数据驱动的适配器目录。
 * 每个描述符包含适配器元信息（名称、描述、安装方式等），
 * 运行时动态检测安装状态，不再依赖硬编码。
 */

import type { InstallMethod, AdapterMarketplaceItem } from '@shared/types'
import { ClaudeCodeAdapter } from './claude-code'
import { CodexAdapter } from './codex'
import { OpenCodeAdapter } from './opencode'
import { CursorAdapter } from './cursor'
import { ClineAdapter } from './cline'
import { KiloCodeAdapter } from './kilo-code'
import { KimiCodeAdapter } from './kimi-code'
import { CodeBuddyAdapter } from './codebuddy'
import { QoderAdapter } from './qoder'
import { QwenCodeAdapter } from './qwen-code'
import { McpAdapter } from './mcp-adapter'
import { MindMapAdapter } from './mindmap-adapter'
import type { BaseAdapter } from './base'

export interface AdapterDescriptor {
  name: string
  displayName: string
  description: string
  type: 'cli' | 'sdk' | 'api'
  installMethods: InstallMethod[]
  detectCommand?: string
  detectArgs?: string[]
  sdkPackage?: string
  adapterClass: new () => BaseAdapter
  homepage: string
  /** 是否在市场中隐藏（内置适配器） */
  hidden?: boolean
}

const platform = process.platform

// 根据当前平台筛选推荐的安装方式
function getRecommendedInstallIndex(methods: InstallMethod[]): number {
  // 优先找当前平台的方法
  const platformMatch = methods.findIndex((m) => m.platform === platform)
  if (platformMatch >= 0) return platformMatch
  // 没有平台限制的方法
  const noRestriction = methods.findIndex((m) => !m.platform)
  return noRestriction >= 0 ? noRestriction : 0
}

export const ADAPTER_REGISTRY: AdapterDescriptor[] = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    description: 'Anthropic 的 AI 编码助手，支持多轮对话和文件操作',
    type: 'sdk',
    sdkPackage: '@anthropic-ai/claude-agent-sdk',
    installMethods: [
      { type: 'curl', command: 'curl -fsSL https://claude.ai/install.sh | bash', label: 'curl (macOS/Linux)', platform: 'darwin' },
      { type: 'brew', command: 'brew install --cask claude-code', label: 'Homebrew', platform: 'darwin' },
      { type: 'winget', command: 'winget install Anthropic.ClaudeCode', label: 'winget', platform: 'win32' },
      { type: 'curl', command: 'powershell -c "irm https://claude.ai/install.ps1 | iex"', label: 'PowerShell', platform: 'win32' },
      { type: 'npm', command: 'npm install -g @anthropic-ai/claude-code', label: 'npm (deprecated)' },
    ],
    adapterClass: ClaudeCodeAdapter,
    homepage: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  {
    name: 'codex',
    displayName: 'Codex',
    description: 'OpenAI 的轻量级编码代理，支持 ChatGPT 计划和 API Key',
    type: 'sdk',
    sdkPackage: '@openai/codex-sdk',
    installMethods: [
      { type: 'curl', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', label: 'curl (macOS/Linux)', platform: 'darwin' },
      { type: 'brew', command: 'brew install --cask codex', label: 'Homebrew', platform: 'darwin' },
      { type: 'curl', command: 'powershell -c "irm https://chatgpt.com/codex/install.ps1 | iex"', label: 'PowerShell', platform: 'win32' },
      { type: 'npm', command: 'npm install -g @openai/codex', label: 'npm' },
    ],
    adapterClass: CodexAdapter,
    homepage: 'https://github.com/openai/codex',
  },
  {
    name: 'opencode',
    displayName: 'OpenCode',
    description: '开源 AI 编码代理，支持多种模型提供商',
    type: 'cli',
    detectCommand: 'opencode',
    detectArgs: ['--version'],
    installMethods: [
      { type: 'curl', command: 'curl -fsSL https://opencode.ai/install | bash', label: 'curl (macOS/Linux)', platform: 'darwin' },
      { type: 'brew', command: 'brew install anomalyco/tap/opencode', label: 'Homebrew', platform: 'darwin' },
      { type: 'scoop', command: 'scoop install opencode', label: 'Scoop', platform: 'win32' },
      { type: 'choco', command: 'choco install opencode', label: 'Chocolatey', platform: 'win32' },
      { type: 'npm', command: 'npm i -g opencode-ai@latest', label: 'npm' },
    ],
    adapterClass: OpenCodeAdapter,
    homepage: 'https://opencode.ai',
  },
  {
    name: 'cline',
    displayName: 'Cline',
    description: '开源 AI 编码代理，支持 headless 模式和多 Agent 协作',
    type: 'cli',
    detectCommand: 'cline',
    detectArgs: ['--version'],
    installMethods: [
      { type: 'npm', command: 'npm i -g cline', label: 'npm' },
    ],
    adapterClass: ClineAdapter,
    homepage: 'https://cline.bot',
  },
  {
    name: 'kilo-code',
    displayName: 'Kilo Code',
    description: '支持 500+ AI 模型的终端编码代理，OpenCode 分支',
    type: 'cli',
    detectCommand: 'kilo',
    detectArgs: ['--version'],
    installMethods: [
      { type: 'npm', command: 'npm i -g @kilocode/cli', label: 'npm' },
      { type: 'npx', command: 'npx @kilocode/cli', label: 'npx (免安装)' },
    ],
    adapterClass: KiloCodeAdapter,
    homepage: 'https://kilo.ai',
  },
  {
    name: 'kimi-code',
    displayName: 'Kimi Code',
    description: 'Moonshot AI 出品的终端编码代理，支持 Kimi K2 模型',
    type: 'cli',
    detectCommand: 'kimi',
    detectArgs: ['--version'],
    installMethods: [
      { type: 'curl', command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', label: 'curl (macOS/Linux)', platform: 'darwin' },
      { type: 'brew', command: 'brew install kimi-code', label: 'Homebrew', platform: 'darwin' },
      { type: 'curl', command: 'powershell -c "irm https://code.kimi.com/kimi-code/install.ps1 | iex"', label: 'PowerShell', platform: 'win32' },
      { type: 'npm', command: 'npm i -g @moonshot-ai/kimi-code', label: 'npm' },
    ],
    adapterClass: KimiCodeAdapter,
    homepage: 'https://github.com/MoonshotAI/kimi-code',
  },
  {
    name: 'codebuddy',
    displayName: 'CodeBuddy',
    description: '腾讯出品的 AI 编码助手，支持代码理解和终端操作',
    type: 'cli',
    detectCommand: 'codebuddy',
    detectArgs: ['--version'],
    installMethods: [
      { type: 'npm', command: 'npm i -g @tencent-ai/codebuddy-code', label: 'npm' },
    ],
    adapterClass: CodeBuddyAdapter,
    homepage: 'https://github.com/Tencent/CodeBuddy',
  },
  {
    name: 'qoder',
    displayName: 'Qoder',
    description: '基于 Gemini 的 AI 编码助手',
    type: 'cli',
    detectCommand: 'qodercli',
    detectArgs: ['--version'],
    installMethods: [
      { type: 'npm', command: 'npm i -g @qoder-ai/qodercli', label: 'npm' },
    ],
    adapterClass: QoderAdapter,
    homepage: 'https://github.com/qoder-ai',
  },
  {
    name: 'qwen-code',
    displayName: 'Qwen Code',
    description: '阿里云出品的开源 AI 终端编码代理，优化 Qwen 系列模型',
    type: 'cli',
    detectCommand: 'qwen',
    detectArgs: ['--version'],
    installMethods: [
      { type: 'curl', command: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash', label: 'curl (macOS/Linux)', platform: 'darwin' },
      { type: 'brew', command: 'brew install qwen-code', label: 'Homebrew', platform: 'darwin' },
      { type: 'curl', command: 'powershell -c "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex"', label: 'PowerShell', platform: 'win32' },
      { type: 'npm', command: 'npm i -g @qwen-code/qwen-code@latest', label: 'npm' },
    ],
    adapterClass: QwenCodeAdapter,
    homepage: 'https://github.com/QwenLM/qwen-code',
  },
  {
    name: 'cursor',
    displayName: 'Cursor',
    description: 'Cursor IDE 的 AI 编码代理，需安装 Cursor IDE',
    type: 'cli',
    detectCommand: 'cursor',
    detectArgs: ['agent', '--version'],
    installMethods: [
      { type: 'manual', command: 'https://cursor.com', label: '官网下载', platform: 'win32' },
      { type: 'manual', command: 'https://cursor.com', label: '官网下载', platform: 'darwin' },
      { type: 'manual', command: 'https://cursor.com', label: '官网下载', platform: 'linux' },
    ],
    adapterClass: CursorAdapter,
    homepage: 'https://cursor.com',
  },
  {
    name: 'mcp',
    displayName: 'MCP / API',
    description: '基于 API 的通用适配器，通过 MCP 协议连接外部服务',
    type: 'api',
    installMethods: [
      { type: 'api-key', command: '', label: '在设置中添加 API Key' },
    ],
    adapterClass: McpAdapter,
    homepage: 'https://modelcontextprotocol.io',
  },
  {
    name: 'mindmap-internal',
    displayName: 'MindMap',
    description: '内置的思维导图生成适配器（自动可用）',
    type: 'cli',
    detectCommand: 'claude',
    detectArgs: ['--version'],
    installMethods: [],
    adapterClass: MindMapAdapter,
    homepage: '',
    hidden: true,
  },
]

/** 获取适配器市场数据（用于前端渲染） */
export async function buildMarketplaceItems(
  installedMap: Record<string, boolean>,
): Promise<AdapterMarketplaceItem[]> {
  return ADAPTER_REGISTRY
    .filter((d) => !d.hidden)
    .map((d) => ({
      name: d.name,
      displayName: d.displayName,
      description: d.description,
      type: d.type,
      installed: installedMap[d.name] ?? false,
      version: '1.0.0',
      installMethods: d.installMethods,
      homepage: d.homepage,
      recommendedInstallIndex: getRecommendedInstallIndex(d.installMethods),
    }))
}
