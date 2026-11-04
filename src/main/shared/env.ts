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
export function buildSafeEnv(adapterType?: string): NodeJS.ProcessEnv {
  const blockedPrefixes = ['BIZGRAPH_', 'ELECTRON_', 'NODE_', 'npm_']
  // 精确前缀：仅 CLAUDE_CODE_ 允许宽匹配（CLI 自身环境变量）
  const allowedPrefixes = ['CLAUDE_CODE_']
  // 但宿主会话管道变量必须拦下：Claude 桌面 App 注入的这些变量声明「认证由
  // 宿主管理」（CLAUDE_CODE_HOST_AUTH_ENV_VAR / PROVIDER_MANAGED_BY_HOST /
  // SDK_HAS_HOST_AUTH_REFRESH），被生成的 claude CLI 继承后会放弃自身认证
  // （settings.json 的网关 env、keychain），直接报 "Not logged in" exit 1
  // —— 思维导图生成等子进程流程全部静默降级。其余是父会话身份/通讯管道，
  // 对子进程同样是噪音。其余 CLAUDE_CODE_* 配置类变量照常放行。
  const blockedKeys = new Set([
    'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_HOST_SESSION_ID',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_AUTO_MODE_SERVER',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_STARTUP_FAILURE_RESULTS',
    'CLAUDE_CODE_DIAGNOSTICS_FILE',
    'CLAUDE_CODE_SIMPLE',
  ])
  // 仅对已知一方适配器暴露 ANTHROPIC_ 密钥，防止第三方 MCP 服务器窃取
  const FIRST_PARTY_ADAPTERS = new Set(['claude-code', 'codex', 'opencode', 'mcp'])
  const includeAnthropic = FIRST_PARTY_ADAPTERS.has(adapterType ?? '')
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
  ])
  // Anthropic 密钥仅对一方适配器暴露
  if (includeAnthropic) {
    allowedKeys.add('ANTHROPIC_AUTH_TOKEN')
    allowedKeys.add('ANTHROPIC_BASE_URL')
    allowedKeys.add('ANTHROPIC_API_KEY')
  }

  const safeEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (blockedPrefixes.some((p) => key.startsWith(p))) continue
    if (blockedKeys.has(key)) continue
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
  return `${prefix}-${randomUUID().replaceAll('-', '')}`
}