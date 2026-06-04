/**
 * 共享工具函数：环境变量安全清理 + ID 生成
 * 供主进程各模块（adapters、mcp client 等）共用
 */

import { randomUUID } from 'node:crypto'

/**
 * 清理环境变量，防止敏感信息泄露给子进程。
 * 合并了 base.ts 和 mcp/client.ts 中两个独立实现的逻辑，
 * 使用更完整的 allowedKeys 列表（取两者并集）。
 */
export function buildSafeEnv(): NodeJS.ProcessEnv {
  const blockedPrefixes = ['BIZGRAPH_', 'ELECTRON_', 'NODE_', 'npm_']
  // 精确前缀：避免 CLAUDE_ 过宽匹配未来可能添加的敏感变量
  const allowedPrefixes = ['CLAUDE_CODE_', 'ANTHROPIC_']
  const allowedKeys = new Set([
    'PATH', 'Path', 'PATHEXT',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'TMPDIR', 'TMP', 'TEMP',
    'SHELL', 'COMSPEC', 'TERM',
    'LANG', 'LC_ALL', 'LC_CTYPE',
    'USER', 'USERNAME', 'LOGNAME',
    'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'SSH_AUTH_SOCK', 'GNOME_KEYRING_CONTROL',
    'DISPLAY', 'WAYLAND_DISPLAY',
    'CLICOLOR', 'FORCE_COLOR', 'NO_COLOR',
    // Java / JVM
    'JAVA_HOME', 'JDK_HOME', 'JRE_HOME',
    'MAVEN_HOME', 'M2_HOME', 'GRADLE_HOME',
    // Python
    'PYTHONPATH', 'PYTHONHOME', 'PYENV_ROOT', 'PYENV_VERSION',
    'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV',
    // Go
    'GOPATH', 'GOROOT', 'GOBIN', 'GOPROXY', 'GOSUMDB', 'GONOSUMDB', 'GONOPROXY',
    // Rust
    'CARGO_HOME', 'RUSTUP_HOME',
    // Ruby
    'GEM_HOME', 'GEM_PATH', 'RBENV_ROOT', 'RUBYOPT',
    // Node.js version managers
    'NVM_DIR', 'NVM_HOME', 'NVM_BIN', 'NVM_INC',
    'FNM_DIR', 'FNM_MULTISHELL_PATH',
    'VOLTA_HOME',
    'PNPM_HOME',
    // Android
    'ANDROID_HOME', 'ANDROID_SDK_ROOT',
    // General tools
    'EDITOR', 'VISUAL', 'PAGER', 'LESS', 'GIT_EDITOR',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
    // CI / build
    'CI', 'BUILD_NUMBER', 'BUILD_ID',
    // Anthropic / Claude CLI
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY',
  ])

  const safeEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (blockedPrefixes.some((p) => key.startsWith(p))) continue
    if (allowedPrefixes.some((p) => key.startsWith(p))) { safeEnv[key] = value; continue }
    if (allowedKeys.has(key)) { safeEnv[key] = value; continue }
    // 未在白名单中的变量不传递给子进程
  }
  return safeEnv
}

/**
 * 生成带前缀的唯一 ID，格式: {prefix}-{uuid-without-dashes}
 * 供各 Repository 和 Service 共用，替代分散定义的同名函数
 */
export function generateId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '')}`
}