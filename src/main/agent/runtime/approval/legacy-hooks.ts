import type { ClaudeTurnApprovalHooks } from '../../../adapters/claude-code'
import type { ApprovalGateway } from './gateway'
import { legacyRunId, legacyTurnId } from './legacy-ids'

export interface LegacyApprovalHooksInput {
  approvals: ApprovalGateway
  sessionId: string
  cwd: string
}

/** 能在宿主侧拦截工具调用的适配器（目前只有 claude-code 的 SDK 钩子）。 */
export interface HostApprovalCapableAdapter {
  setTurnApprovalHooks(sessionId: string, hooks: ClaudeTurnApprovalHooks | null): void
}

export function supportsHostApproval(adapter: unknown): adapter is HostApprovalCapableAdapter {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as { setTurnApprovalHooks?: unknown }).setTurnApprovalHooks === 'function'
  )
}

/**
 * 旧路径（非 kernel）的审批钩子：复用适配器内已有的 PreToolUse 写类强制 ask
 * 与 Bash 两档策略，最终放行统一回到 `ApprovalGateway.request`（与 kernel 同一套
 * 策略函数、会话级授权与 `agent_approvals` 落库）。
 *
 * 不复制任何规则：适配器在 `approvalHooks` 存在时就注册 PreToolUse，写类工具由它
 * 返回 'ask'，Bash 由同一份 `evaluateBashPolicy` 给出 allow/ask/deny。
 */
export function buildLegacyApprovalHooks(input: LegacyApprovalHooksInput): ClaudeTurnApprovalHooks {
  return {
    canUseTool: async (toolName, args) => {
      const outcome = await input.approvals.request({
        // run/turn_id 是 NOT NULL，自由聊天没有 turn；用可反解的旧路径标识，
        // 网关据此把「无 turn 审批」的兑现判据改为「本进程仍在等待」。
        runId: legacyRunId(input.sessionId),
        turnId: legacyTurnId(input.sessionId),
        sessionId: input.sessionId,
        toolName,
        args,
        cwd: input.cwd,
      })
      if (outcome.decision === 'deny') {
        const detail = outcome.reason ? `：${outcome.reason}` : ''
        return { behavior: 'deny', message: `Tool ${toolName} denied by ${outcome.decidedBy}${detail}` }
      }
      return { behavior: 'allow', updatedInput: args }
    },
  }
}
