/**
 * Agent IPC Handlers
 * Agent 适配器、会话、指令管理
 */

import type { AgentManager } from '../agent/agent-manager'
import { VerificationService } from '../agent/verification-service'
import { type AgentLogRepository } from '../repositories/agent-log-repository'
import type { NodeRepository } from '../repositories/node-repository'
import type { GraphNode, AgentOutput } from '@shared/types'
import type { TypedHandle } from './utils'
import { AgentError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'
import { buildMarketplaceItems } from '../adapters/registry'

const logger = createLogger('AgentIPC')

export function registerAgentHandlers(agentManager: AgentManager, typedHandle: TypedHandle, agentLogRepo?: AgentLogRepository, nodeRepo?: NodeRepository): void {
  const verificationService = new VerificationService()

  typedHandle('agent:checkInstalled', async (_, adapterName) => {
    return agentManager.checkInstalled(adapterName)
  })

  typedHandle('agent:startSession', async (_, adapterName, config) => {
    // adapterName 为 null 时触发自动回退链
    return agentManager.startSession(adapterName, config)
  })

  typedHandle('agent:sendCommand', async (_, sessionId, command) => {
    return agentManager.sendCommand(sessionId, command)
  })

  typedHandle('agent:resolveAndSendCommand', async (_, sessionId, command, contextRefs, nodeIds) => {
    const nodes = nodeRepo && nodeIds?.length
      ? (await Promise.all(nodeIds.map((id: string) => nodeRepo.findById(id)))).filter(Boolean) as GraphNode[]
      : undefined
    return agentManager.resolveAndSendCommand(sessionId, command, contextRefs, nodes)
  })

  typedHandle('agent:terminateSession', async (_, sessionId) => {
    return agentManager.terminateSession(sessionId)
  })

  typedHandle('agent:listAdapters', async () => {
    return agentManager.listAdapters()
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
        await agentManager.terminateSession(sessionId)
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

  // ---------- 批量关闭会话 ----------
  typedHandle('agent:closeAllSessions', async () => {
    const errors: Array<{ sessionId: string; error: string }> = []
    for (const sessionId of agentManager.getActiveSessionIds()) {
      try {
        await agentManager.terminateSession(sessionId)
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
