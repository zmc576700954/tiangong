/**
 * 会话路由器
 * 职责：管理 sessionId 到 adapterName 的绑定关系
 */

import type { AgentAdapter } from '@shared/types'
import { AdapterRegistry } from './adapter-registry'

export class SessionRouter {
  private sessionToAdapter = new Map<string, string>()

  constructor(private registry: AdapterRegistry) {}

  bind(sessionId: string, adapterName: string): void {
    this.sessionToAdapter.set(sessionId, adapterName)
  }

  unbind(sessionId: string): void {
    this.sessionToAdapter.delete(sessionId)
  }

  resolve(sessionId: string): AgentAdapter | undefined {
    const adapterName = this.sessionToAdapter.get(sessionId)
    if (!adapterName) return undefined
    return this.registry.get(adapterName)
  }

  getAdapterName(sessionId: string): string | undefined {
    return this.sessionToAdapter.get(sessionId)
  }
}
