/**
 * Agent IPC Handlers
 * Agent 适配器、会话、指令管理
 */

import type { AgentService } from '../services/agent-service'
import type { TypedHandle } from './utils'

export function registerAgentHandlers(agentService: AgentService, typedHandle: TypedHandle): void {
  typedHandle('agent:checkInstalled', async (_, adapterName) => {
    return agentService.checkInstalled(adapterName)
  })

  typedHandle('agent:startSession', async (_, adapterName, config) => {
    return agentService.startSession(adapterName, config)
  })

  typedHandle('agent:sendCommand', async (_, sessionId, command) => {
    return agentService.sendCommand(sessionId, command)
  })

  typedHandle('agent:resolveAndSendCommand', async (_, sessionId, command, contextRefs, nodeIds) => {
    return agentService.resolveAndSendCommand(sessionId, command, contextRefs, nodeIds)
  })

  typedHandle('agent:terminateSession', async (_, sessionId) => {
    return agentService.terminateSession(sessionId)
  })

  typedHandle('agent:listAdapters', async () => {
    return agentService.listAdapters()
  })
}
