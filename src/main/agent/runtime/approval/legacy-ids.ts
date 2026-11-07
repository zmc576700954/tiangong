/**
 * 旧路径（非 kernel）审批的 run/turn 标识。
 *
 * `agent_approvals.run_id` / `turn_id` 是 NOT NULL，但自由聊天不产生 `agent_turns`
 * 行（D8）。这里用可反解的固定前缀标识"无 turn 的审批"，避免伪造真实 turn，
 * 也让网关能在重启后判定这类审批不可兑现（没有等待者）。
 */
export const LEGACY_RUN_PREFIX = 'legacy-run-'
export const LEGACY_TURN_PREFIX = 'legacy-turn-'

export function legacyRunId(sessionId: string): string {
  return `${LEGACY_RUN_PREFIX}${sessionId}`
}

export function legacyTurnId(sessionId: string): string {
  return `${LEGACY_TURN_PREFIX}${sessionId}`
}

/** 从审批行的 run/turn 标识反解旧路径 sessionId；不是旧路径标识则返回 undefined。 */
export function legacySessionIdOf(runId: string, turnId: string): string | undefined {
  if (!runId.startsWith(LEGACY_RUN_PREFIX) || !turnId.startsWith(LEGACY_TURN_PREFIX)) {
    return undefined
  }
  const fromRun = runId.slice(LEGACY_RUN_PREFIX.length)
  const fromTurn = turnId.slice(LEGACY_TURN_PREFIX.length)
  if (fromRun === '' || fromRun !== fromTurn) return undefined
  return fromTurn
}
