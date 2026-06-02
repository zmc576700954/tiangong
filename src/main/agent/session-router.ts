/**
 * 会话路由器
 * 职责：管理 sessionId 到 adapterName 的绑定关系
 */

import type { AgentAdapter } from '@shared/types'
import { AdapterRegistry } from './adapter-registry'
import { SessionNotFoundError, AdapterError } from '../errors'

export class SessionRouter {
  private sessionToAdapter = new Map<string, string>()

  constructor(private registry: AdapterRegistry) {}

  bind(sessionId: string, adapterName: string): void {
    this.sessionToAdapter.set(sessionId, adapterName)
  }

  unbind(sessionId: string): void {
    this.sessionToAdapter.delete(sessionId)
  }

  resolve(sessionId: string): AgentAdapter {
    const adapterName = this.sessionToAdapter.get(sessionId)
    if (!adapterName) {
      throw new SessionNotFoundError(sessionId)
    }
    const adapter = this.registry.get(adapterName)
    if (!adapter) {
      throw new AdapterError(`Adapter ${adapterName} not found for session ${sessionId}`)
    }
    return adapter
  }

  getAdapterName(sessionId: string): string | undefined {
    return this.sessionToAdapter.get(sessionId)
  }

  /** 返回所有活跃会话 ID */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessionToAdapter.keys())
  }
}
