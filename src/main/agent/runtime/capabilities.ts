/**
 * 适配器能力矩阵（如实声明，不粉饰）。
 *
 * 依据 agent-architecture.md §5：
 * - Claude：原生逐消息、可以 canUseTool 做执行前审批；
 * - Codex：runStreamed 后 item 级、turn.completed 完成判定、审批只能策略降级；
 * - OpenCode：one-shot stdout，工具轨迹是 synthetic；
 * - 长尾 CLI：toolEvents: none，不为其编写 parser。
 */

import type { DriverCapabilities } from '@shared/types/agent-runtime'

const CLAUDE_CAPABILITIES: DriverCapabilities = {
  toolEvents: 'exact',
  toolArgs: 'raw',
  toolLifecycle: 'exact',
  approval: 'pre-exec',
  fileChanges: 'hook',
  usage: 'token-snapshot',
  completion: 'iterator-end',
}

const CODEX_CAPABILITIES: DriverCapabilities = {
  toolEvents: 'exact',
  toolArgs: 'raw',
  toolLifecycle: 'exact',
  approval: 'policy-only',
  fileChanges: 'synthetic-snapshot',
  usage: 'turn-aggregate',
  completion: 'backend-turn-completed',
}

const OPENCODE_CAPABILITIES: DriverCapabilities = {
  toolEvents: 'none',
  toolArgs: 'none',
  toolLifecycle: 'none',
  approval: 'none',
  fileChanges: 'synthetic-snapshot',
  usage: 'turn-aggregate',
  completion: 'iterator-end',
}

const LONG_TAIL_CAPABILITIES: DriverCapabilities = {
  toolEvents: 'none',
  toolArgs: 'none',
  toolLifecycle: 'none',
  approval: 'none',
  fileChanges: 'none',
  usage: 'none',
  completion: 'iterator-end',
}

/**
 * M1 ②：没有工具事件、但可由宿主做工作区差分的长尾 CLI。
 *
 * toolEvents 仍然如实保持 none —— 证据走独立的 evidence.file_change 通道，
 * 不伪装成工具时间线。
 */
const LONG_TAIL_CLI_CAPABILITIES: DriverCapabilities = {
  ...LONG_TAIL_CAPABILITIES,
  fileChanges: 'synthetic-snapshot',
}

const LONG_TAIL_CLI_BACKENDS = new Set([
  'cline',
  'kilo-code',
  'kimi-code',
  'codebuddy',
  'qoder',
  'qwen-code',
])

export function getExecutorCapabilities(executor: string): DriverCapabilities {
  switch (executor) {
    case 'claude-code':
    case 'claude':
      return CLAUDE_CAPABILITIES
    case 'codex':
      return CODEX_CAPABILITIES
    case 'opencode':
      return OPENCODE_CAPABILITIES
    default:
      return LONG_TAIL_CLI_BACKENDS.has(executor) ? LONG_TAIL_CLI_CAPABILITIES : LONG_TAIL_CAPABILITIES
  }
}
