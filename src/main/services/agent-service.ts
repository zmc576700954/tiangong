/**
 * Agent Service
 * 处理 Agent 相关业务逻辑（当前为简单转发）
 */

import type { AgentSessionConfig, AgentCommand } from '@shared/types'
import { AgentManager } from '../agent/agent-manager'

export class AgentService {
  constructor(private agentManager: AgentManager) {}

  async checkInstalled(adapterName: string): Promise<boolean> {
    return this.agentManager.checkInstalled(adapterName)
  }

  async startSession(adapterName: string, config: AgentSessionConfig): Promise<{ sessionId: string; fallback?: boolean }> {
    return this.agentManager.startSession(adapterName, config)
  }

  async sendCommand(sessionId: string, command: AgentCommand): Promise<void> {
    return this.agentManager.sendCommand(sessionId, command)
  }

  async resolveAndSendCommand(
    sessionId: string,
    command: AgentCommand,
    contextRefs: import('@shared/types').ContextRef[],
    _nodeIds: string[],
  ): Promise<void> {
    return this.agentManager.resolveAndSendCommand(sessionId, command, contextRefs)
  }

  async terminateSession(sessionId: string): Promise<void> {
    return this.agentManager.terminateSession(sessionId)
  }

  async listAdapters(): Promise<{ name: string; version: string; installed: boolean }[]> {
    return this.agentManager.listAdapters()
  }
}
