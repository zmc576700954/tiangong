/**
 * 原生会话 id 的可信判据（P1-1）。
 *
 * 背景：本仓库的 Agent 会话 id 是内部 id（`generateId('claude')` → `claude-<uuid>`），
 * 它只在本进程的 adapter session map 里有意义，绝不是 CLI/SDK 的 resume id。
 * 把它传给 Claude `--resume` / Codex `resumeThread` 会被底层拒绝。
 *
 * 规则：
 *  1. 原生 id 只能来自可信来源（`agent_events.run.started` 的 `payload.backendSessionId`，
 *     即 SDK 回报的 session_id / thread_id），不得来自 `agent_sessions.runtime_session_id`；
 *  2. 形如内部前缀（claude- / codex- / sess- / sess_ ...）的一律判为不可用；
 *  3. 过短的字符串（< 8）判为不可用。
 */

const INTERNAL_SESSION_ID_PREFIXES = [
  'claude-',
  'codex-',
  'cursor-',
  'opencode-',
  'mcp-',
  'adapter-',
  'agent-',
  'sess-',
  'session-',
  'swarm-',
  'subagent-',
]

/** 是否是本仓库生成的内部会话 id（绝不可作为原生 resume id）。 */
export function isInternalAgentSessionId(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.startsWith('sess_')) return true
  return INTERNAL_SESSION_ID_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * 是否可作为原生 resume id 使用。
 * 注意：该函数只做「排除内部 id + 基本形态」校验，来源可信性由调用方保证
 * （restore 路径只读 `run.started.backendSessionId`）。
 */
export function isTrustedNativeSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 8 && !isInternalAgentSessionId(value)
}
