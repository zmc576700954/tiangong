/**
 * v36 / G3-6～G3-9：把 settings.json 的 `agentRuntime.timeouts` 解析成生效值。
 *
 * 单一解析入口——AgentManager / SubagentManager / WorkExecutionService /
 * send-and-wait 都从这里取，避免各自解释缺失值与非法值。
 * 未配置或非正值一律回落 DEFAULT_AGENT_TIMEOUTS（升级前行为不变）。
 */

import { DEFAULT_AGENT_TIMEOUTS } from '@shared/types/agent-runtime'
import type { AgentRuntimeTimeouts } from '@shared/types/agent-runtime'

export interface ResolvedAgentTimeouts {
  turnMs: number
  stepMs: number
  taskMs: number
  sendWaitMs: number
}

/** sendWaitMs 必须严格大于 turnMs（留 30s 收尾/落库余量）。 */
export const SEND_WAIT_OVER_TURN_MS = 30 * 1000

function positiveMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

export function resolveAgentTimeouts(
  config?: AgentRuntimeTimeouts | null,
): ResolvedAgentTimeouts {
  // turnMs 允许显式 0（沿用 F3-A「0 = 关闭 turn deadline」语义）；
  // 其余键不把 0 当合法预算，避免「配置成 0 变成立刻超时」。
  const turnMs =
    typeof config?.turnMs === 'number' &&
    Number.isFinite(config.turnMs) &&
    config.turnMs >= 0
      ? Math.floor(config.turnMs)
      : DEFAULT_AGENT_TIMEOUTS.turnMs

  return {
    turnMs,
    stepMs: positiveMs(config?.stepMs) ?? DEFAULT_AGENT_TIMEOUTS.stepMs,
    taskMs: positiveMs(config?.taskMs) ?? DEFAULT_AGENT_TIMEOUTS.taskMs,
    sendWaitMs: Math.max(
      positiveMs(config?.sendWaitMs) ?? DEFAULT_AGENT_TIMEOUTS.sendWaitMs,
      turnMs + SEND_WAIT_OVER_TURN_MS,
    ),
  }
}
