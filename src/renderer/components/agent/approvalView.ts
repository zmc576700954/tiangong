/**
 * 审批卡片的展示辅助（聊天内弹窗与全局入口共用，避免两处各自解析参数）。
 */

import type { ApprovalRequestPayload } from '@shared/types/agent-runtime'

/**
 * Bash 的 argsJson 是 `{"command":"..."}`；卡片必须展示**命令原文**（不截断），
 * 否则用户可能只看到 `printf` 而批准了 `printf ... > ~/.zshrc`。
 */
export function displayCommand(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { command?: unknown }).command === 'string'
    ) {
      return (parsed as { command: string }).command
    }
  } catch {
    // 非 JSON（其他工具的参数）按原样展示
  }
  return argsJson
}

export interface ApprovalSourcePart {
  key: 'agent.approval.inbox.sourceTask' | 'agent.approval.inbox.sourceStep' | 'agent.approval.inbox.sourceSession'
  value: string
}

/** 来源三元组：任务 / 步骤 / 会话（缺失项不渲染，避免空标签）。 */
export function approvalSourceParts(payload: ApprovalRequestPayload): ApprovalSourcePart[] {
  const parts: ApprovalSourcePart[] = []
  if (payload.workItemId) parts.push({ key: 'agent.approval.inbox.sourceTask', value: payload.workItemId })
  if (payload.stepId) parts.push({ key: 'agent.approval.inbox.sourceStep', value: payload.stepId })
  if (payload.sessionId) parts.push({ key: 'agent.approval.inbox.sourceSession', value: payload.sessionId })
  return parts
}
