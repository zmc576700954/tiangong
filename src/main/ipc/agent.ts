/**
 * Agent IPC Handlers
 * Agent 适配器、会话、指令管理
 */

import type { AgentManager } from '../agent/agent-manager'
import type { TypedHandle } from './utils'

export function registerAgentHandlers(agentManager: AgentManager, typedHandle: TypedHandle): void {
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
}
