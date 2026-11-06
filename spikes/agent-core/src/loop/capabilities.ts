import type { BackendCapabilities, BackendName } from '../types'

/**
 * 能力矩阵初值，直接取自 AGENT_ARCHITECTURE_DESIGN.md §3.3。
 * Claude 的 approval 标注 hook 仍是文档里的「待验证」，spike 只断言矩阵形态，
 * 不宣称 canUseTool 在 0.3.286 上真实可用。
 */
export const BACKEND_CAPABILITIES: Record<BackendName, BackendCapabilities> = {
  'claude-code': {
    eventFidelity: 'token',
    loopOwnership: 'backend',
    toolEvents: 'exact',
    approval: 'hook',
    cancel: 'abort',
    resume: 'native',
    reasoning: true,
    parallelToolCalls: true,
    streamingText: true,
  },
  codex: {
    eventFidelity: 'turn',
    loopOwnership: 'backend',
    toolEvents: 'derived',
    approval: 'policy-only',
    cancel: 'cooperative',
    resume: 'native',
    reasoning: false,
    parallelToolCalls: true,
    streamingText: false,
  },
  opencode: {
    eventFidelity: 'session',
    loopOwnership: 'host',
    toolEvents: 'derived',
    approval: 'hook',
    cancel: 'kill',
    resume: 'none',
    reasoning: false,
    parallelToolCalls: false,
    streamingText: true,
  },
}
