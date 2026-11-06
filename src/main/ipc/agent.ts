/**
 * Agent IPC Handlers
 * Agent 适配器、会话、指令管理
 */

import type { AgentManager } from '../agent/agent-manager'
import type { AgentRuntime } from '../agent/runtime/runtime'
import { getExecutorCapabilities } from '../agent/runtime/capabilities'
import {
  getKernelBackends,
  isAgentKernelEnabled,
  isKernelUnsafeOverrideEnabled,
} from '../agent/runtime/feature-flags'
import { VerificationService } from '../agent/verification-service'
import { type AgentLogRepository } from '../repositories/agent-log-repository'
import type { NodeRepository } from '../repositories/node-repository'
import type { GraphNode, AgentOutput } from '@shared/types'
import type { SessionUsageView, GraphUsageView, AgentStorageStats } from '@shared/types/agent-runtime'
import type { TypedHandle } from './utils'
import { AgentError, IpcError, ErrorCode } from '../errors'
import { AgentRuntimeError } from '../agent/runtime/errors'
import { getIpcContext } from './context'
import { createLogger } from '../shared/logger'
import { buildMarketplaceItems } from '../adapters/registry'

const logger = createLogger('AgentIPC')

/**
 * 会话 → 发起窗口（webContents.id）绑定。
 *
 * 审批决议必须校验「发起方」：只校验 argsHash 时，任意窗口都能对同一 approval id
 * 下单。进程重启后恢复的会话没有窗口绑定（该 turn 也已不可兑现），此时跳过发起方校验，
 * 但 session/turn 归属校验仍然生效。
 */
const sessionWindowBindings = new Map<string, number>()

/** 已订阅 destroyed 的窗口 id，避免每次 startSession 重复挂监听。 */
const watchedSenders = new Set<number>()

export interface AgentHandlerBindingOptions {
  /** 订阅窗口销毁（生产实现：webContents.fromId(id)?.once('destroyed', cb)）。 */
  watchSender?: (senderId: number, onDestroyed: () => void) => void
  /** 绑定窗口是否仍存在（生产实现：webContents.fromId(id) 非空）。缺省视为存在，跨窗口仍拒绝。 */
  isSenderAlive?: (senderId: number) => boolean
}

export function registerAgentHandlers(
  agentManager: AgentManager,
  typedHandle: TypedHandle,
  agentLogRepo?: AgentLogRepository,
  nodeRepo?: NodeRepository,
  runtime?: AgentRuntime,
  bindingOptions?: AgentHandlerBindingOptions,
): void {
  const verificationService = new VerificationService()
  const watchSender = bindingOptions?.watchSender ?? (() => undefined)
  const isSenderAlive = bindingOptions?.isSenderAlive ?? (() => true)

  if (runtime) {
    // 不暴露 agent:runNode：renderer 直通 runtime 会绕过 AgentManager 的会话锁与审批前置。
    // 节点执行只能走 agent:sendCommand / agent:resolveAndSendCommand → sendCommandThroughKernel。

    typedHandle('agent:cancelTurn', async (_, turnId) => {
      if (typeof turnId !== 'string' || turnId.length === 0) {
        throw new IpcError('turnId must be a non-empty string', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      return runtime.cancelTurn(turnId)
    })

    typedHandle('agent:getPendingApprovals', async () => runtime.approvals.listPendingPayloads())

    typedHandle('agent:resolveApproval', async (_, input) => {
      if (!input || typeof input.approvalId !== 'string' || (input.decision !== 'allow' && input.decision !== 'deny') || typeof input.argsHash !== 'string') {
        throw new IpcError('resolveApproval requires approvalId, decision, argsHash', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      if (input.scope !== undefined && (input.scope !== 'once' && input.scope !== 'session')) {
        throw new IpcError('scope must be once or session', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      // 归属校验必填：审批必须带上所属会话/轮次，主进程才能确认「这次决议是给谁的」。
      if (typeof input.sessionId !== 'string' || typeof input.turnId !== 'string') {
        throw new IpcError(
          'resolveApproval requires sessionId and turnId for ownership validation',
          ErrorCode.IPC_INVALID_ARGUMENT,
        )
      }
      const senderId = getIpcContext().senderId
      const boundSender = sessionWindowBindings.get(input.sessionId)
      if (boundSender !== undefined && boundSender !== senderId) {
        // 原发起窗口已销毁：重绑当前窗口（继续走 session/turn 归属校验），
        // 否则重开窗口后合法审批会被误拒。
        if (!isSenderAlive(boundSender)) {
          sessionWindowBindings.set(input.sessionId, senderId)
          logger.info(`[approval] rebind session ${input.sessionId} from destroyed sender ${boundSender} to ${senderId}`)
        } else {
          throw new AgentRuntimeError(
            'APPROVAL_NOT_OWNED',
            `该审批属于其它窗口发起的会话（session=${input.sessionId}），当前窗口无权决议。`,
          )
        }
      }
      const outcome = runtime.approvals.decide({ ...input, senderId })
      return {
        approvalId: outcome.approvalId,
        decision: outcome.decision,
        decidedBy: outcome.decidedBy,
        sessionGranted: outcome.sessionGranted === true,
        grantSourceApprovalId: outcome.grantSourceApprovalId,
      }
    })

    // 渲染层查询 Kernel 路径状态（权威开关在主进程环境变量，按后端白名单门控）。
    typedHandle('agent:getRuntimeFlags', async () => ({
      kernelPath: isAgentKernelEnabled(),
      kernelBackends: getKernelBackends(),
      kernelUnsafeOverride: isKernelUnsafeOverrideEnabled(),
    }))

    // A1：停止按钮需要按会话取消当前 turn，否则 terminateSession 只会杀进程、turn 状态收不了口。
    typedHandle('agent:cancelSessionTurn', async (_, sessionId) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new IpcError('sessionId must be a non-empty string', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      return runtime.cancelActiveTurnBySession(sessionId)
    })

    // A2：会话级授权的可见性与手动撤销。
    typedHandle('agent:getSessionGrants', async () => runtime.approvals.listSessionGrants())

    typedHandle('agent:revokeSessionGrant', async (_, sessionId) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new IpcError('sessionId must be a non-empty string', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      return runtime.approvals.revokeSessionGrant(sessionId)
    })

    typedHandle('agent:getExecutorCapabilities', async (_, executor) => getExecutorCapabilities(executor))

    typedHandle('agent:getSessionRecovery', async (_, sessionId) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      return runtime.repo.getSessionRecovery(sessionId)
    })
  }

  typedHandle('agent:checkInstalled', async (_, adapterName) => {
    return agentManager.checkInstalled(adapterName)
  })

  typedHandle('agent:startSession', async (_, adapterName, config) => {
    // adapterName 为 null 时触发自动回退链
    const result = await agentManager.startSession(adapterName, config)
    // 记录会话的发起窗口：审批决议必须来自同一窗口（见 resolveApproval 归属校验）。
    const senderId = getIpcContext().senderId
    sessionWindowBindings.set(result.sessionId, senderId)
    if (!watchedSenders.has(senderId)) {
      watchedSenders.add(senderId)
      watchSender(senderId, () => {
        // 窗口销毁 → 清掉它发起的所有会话绑定，避免绑定永久指向不存在的窗口。
        for (const [sessionId, bound] of sessionWindowBindings) {
          if (bound === senderId) sessionWindowBindings.delete(sessionId)
        }
        watchedSenders.delete(senderId)
      })
    }
    return result
  })

  typedHandle('agent:sendCommand', async (_, sessionId, command) => {
    return agentManager.sendCommand(sessionId, command)
  })

  typedHandle('agent:resolveAndSendCommand', async (_, sessionId, command, contextRefs, nodeIds) => {
    if (nodeIds !== undefined) {
      if (!Array.isArray(nodeIds)) {
        throw new IpcError('nodeIds must be an array', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      for (const id of nodeIds) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new IpcError('Each nodeId must be a non-empty string', ErrorCode.IPC_INVALID_ARGUMENT)
        }
      }
    }
    const nodes = nodeRepo && nodeIds?.length
      ? (await Promise.all(nodeIds.map((id: string) => nodeRepo.findById(id)))).filter(Boolean) as GraphNode[]
      : undefined
    return agentManager.resolveAndSendCommand(sessionId, command, contextRefs, nodes)
  })

  typedHandle('agent:terminateSession', async (_, sessionId) => {
    // session 结束 → 会话级授权立即失效（不跨 session、不跨重启）。
    runtime?.endSession(sessionId)
    sessionWindowBindings.delete(sessionId)
    return agentManager.terminateSession(sessionId, 'user')
  })

  typedHandle('agent:listAdapters', async () => {
    return agentManager.listAdapters()
  })

  // D4 健康度面板：返回所有已记录样本的适配器健康评分（零样本的会被 monitor 过滤）。
  // 数据来自 AdapterHealthMonitor，mcp-adapter 在 connect/call 边界调用 recordCall。
  typedHandle('agent:getHealth', async () => {
    return agentManager.getAllAdapterHealth()
  })

  typedHandle('agent:getAdapterMarketplace', async () => {
    const adapters = await agentManager.listAdapters()
    const installedMap: Record<string, boolean> = {}
    for (const a of adapters) {
      installedMap[a.name] = a.installed
    }
    return buildMarketplaceItems(installedMap)
  })

  typedHandle('agent:verify', async (_, params) => {
    const { nodeId, acceptanceCriteria, messages, fileChanges, workingDirectory } = params
    const prompt = verificationService.buildVerificationPrompt(nodeId, acceptanceCriteria, messages, fileChanges)

    // Use available adapter for verification (lightweight, no CLI needed)
    const adapters = await agentManager.listAdapters()
    const installed = adapters.find((a) => a.installed)
    if (!installed) {
      throw new AgentError('No agent adapter available for verification', ErrorCode.AGENT_ADAPTER_NOT_FOUND)
    }

    const config = {
      workingDirectory: workingDirectory ?? '',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Verification',
      nodeId,
      acceptanceCriteria: [],
      verifyOnly: true,
    }

    const { sessionId } = await agentManager.startSession(installed.name, config)

    try {
      // Collect response — 使用会话级输出监听器，仅接收目标 session 的输出
      const response = await new Promise<string>((resolve) => {
        let collected = ''
        let settled = false
        const settle = (value: string) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          agentManager.removeSessionOutputListener(handler)
          resolve(value)
        }
        const handler = (output: AgentOutput) => {
          if (output.type === 'stdout') collected += output.data
          if (output.type === 'complete' || output.type === 'error') {
            settle(collected)
          }
        }
        agentManager.addSessionOutputListener(sessionId, handler)

        agentManager.sendCommand(sessionId, {
          type: 'implement',
          description: prompt,
          targetNodeId: nodeId,
        }).catch((err) => {
          const reason = err instanceof Error ? err.message : String(err)
          logger.warn(`Verification sendCommand failed for session ${sessionId}: ${reason}`)
          settle(collected)
        })

        // Timeout after 60s — 通过 settle 确保 timer 被清理
        const timeoutId = setTimeout(() => {
          settle(collected)
        }, 60000)
      })

      const results = verificationService.parseVerificationResponse(response, acceptanceCriteria)

      return {
        nodeId,
        results,
        passedCount: results.filter((r) => r.passed).length,
        totalCount: results.length,
        timestamp: Date.now(),
      }
    } finally {
      // Always terminate the verification session to prevent resource leaks
      try {
        await agentManager.terminateSession(sessionId, 'user')
      } catch (err) {
        // Session may already be terminated
        const reason = err instanceof Error ? err.message : String(err)
        logger.warn(`Failed to terminate verification session ${sessionId}: ${reason}`)
      }
    }
  })

  // ---------- Agent 日志查询 ----------
  typedHandle('agent:getLogsByNode', async (_, nodeId: string) => {
    if (!agentLogRepo) return []
    return agentLogRepo.listByNode(nodeId)
  })

  typedHandle('agent:getLogsByGraph', async (_, graphId: string) => {
    if (!agentLogRepo) return []
    return agentLogRepo.listByGraph(graphId)
  })

  // ---------- M1 用量查询（只读；与额度/熔断无关） ----------
  typedHandle('agent:getUsageBySession', async (_, sessionId: string, limit?: number): Promise<SessionUsageView> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new IpcError('sessionId must be a non-empty string', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0) ) {
      throw new IpcError('limit must be a positive integer', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    return agentManager.getUsageBySession(sessionId, limit)
  })

  typedHandle('agent:getUsageByGraph', async (_, graphId: string, days?: number): Promise<GraphUsageView> => {
    if (typeof graphId !== 'string' || graphId.length === 0) {
      throw new IpcError('graphId must be a non-empty string', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
      throw new IpcError('days must be a positive integer', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    return agentManager.getUsageByGraph(graphId, days)
  })

  // ---------- P0-2：事件存储统计（只读；不触发 VACUUM） ----------
  typedHandle('agent:getStorageStats', async (): Promise<AgentStorageStats> => {
    if (!runtime) {
      throw new IpcError('Agent runtime is not available', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    return runtime.getStorageStats()
  })

  // ---------- 批量关闭会话 ----------
  typedHandle('agent:closeAllSessions', async () => {
    const errors: Array<{ sessionId: string; error: string }> = []
    for (const sessionId of agentManager.getActiveSessionIds()) {
      try {
        await agentManager.terminateSession(sessionId, 'user')
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        logger.warn(`Failed to terminate session ${sessionId}: ${reason}`)
        errors.push({ sessionId, error: reason })
      }
    }
    if (errors.length > 0) {
      logger.error(`${errors.length} sessions failed to close`, errors)
    }
  })
}
