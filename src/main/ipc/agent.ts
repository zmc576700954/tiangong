/**
 * Agent IPC Handlers
 * Agent 适配器、会话、指令管理
 */

import type { AgentManager } from '../agent/agent-manager'
import { VerificationService } from '../agent/verification-service'
import type { TypedHandle } from './utils'

export function registerAgentHandlers(agentManager: AgentManager, typedHandle: TypedHandle): void {
  const verificationService = new VerificationService()

  typedHandle('agent:checkInstalled', async (_, adapterName) => {
    return agentManager.checkInstalled(adapterName)
  })

  typedHandle('agent:startSession', async (_, adapterName, config) => {
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
    const { nodeId, acceptanceCriteria, messages, fileChanges } = params
    const prompt = verificationService.buildVerificationPrompt(nodeId, acceptanceCriteria, messages, fileChanges)

    // Use available adapter for verification (lightweight, no CLI needed)
    const adapters = await agentManager.listAdapters()
    const installed = adapters.find((a) => a.installed)
    if (!installed) {
      throw new Error('No agent adapter available for verification')
    }

    const config = {
      workingDirectory: '',
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

    // Collect response
    const response = await new Promise<string>((resolve) => {
      let collected = ''
      const handler = (output: import('@shared/types').AgentOutput) => {
        if (output.type === 'stdout') collected += output.data
        if (output.type === 'complete' || output.type === 'error') {
          agentManager.removeOutputListener(handler)
          resolve(collected)
        }
      }
      agentManager.addOutputListener(handler)

      agentManager.sendCommand(sessionId, {
        type: 'implement',
        description: prompt,
        targetNodeId: nodeId,
      }).catch(() => resolve(collected))

      // Timeout after 60s
      setTimeout(() => {
        agentManager.removeOutputListener(handler)
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
  })
}
