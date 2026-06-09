/**
 * Agent IPC Handlers
 * Agent 适配器、会话、指令管理
 */

import type { AgentManager } from '../agent/agent-manager'
import { VerificationService } from '../agent/verification-service'
import { AgentLogRepository } from '../repositories/agent-log-repository'
import type { TypedHandle } from './utils'
import { AgentError, ErrorCode } from '../errors'

export function registerAgentHandlers(agentManager: AgentManager, typedHandle: TypedHandle, agentLogRepo?: AgentLogRepository): void {
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

  typedHandle('agent:resolveAndSendCommand', async (_, sessionId, command, contextRefs, _nodeIds) => {
    return agentManager.resolveAndSendCommand(sessionId, command, contextRefs)
  })

  typedHandle('agent:terminateSession', async (_, sessionId) => {
    return agentManager.terminateSession(sessionId)
  })

  typedHandle('agent:listAdapters', async () => {
    return agentManager.listAdapters()
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
        const handler = (output: import('@shared/types').AgentOutput) => {
          if (output.type === 'stdout') collected += output.data
          if (output.type === 'complete' || output.type === 'error') {
            agentManager.removeSessionOutputListener(handler)
            resolve(collected)
          }
        }
        agentManager.addSessionOutputListener(sessionId, handler)

        agentManager.sendCommand(sessionId, {
          type: 'implement',
          description: prompt,
          targetNodeId: nodeId,
        }).catch(() => {
          agentManager.removeSessionOutputListener(handler)
          resolve(collected)
        })

        // Timeout after 60s
        setTimeout(() => {
          agentManager.removeSessionOutputListener(handler)
          resolve(collected)
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
      } catch {
        // Session may already be terminated
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
}
