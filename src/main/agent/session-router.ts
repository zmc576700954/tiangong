/**
 * 会话路由器
 * 职责：管理 sessionId 到 adapterName 的绑定关系
 */

import type { AgentAdapter } from '@shared/types'
import { AdapterRegistry } from './adapter-registry'
import { SessionNotFoundError, AdapterError } from '../errors'

export class SessionRouter {
  private sessionToAdapter = new Map<string, string>()
  /** 记录 fallback 映射：sessionId → { original: 原始适配器名, actual: 实际适配器名 } */
  private fallbackMap = new Map<string, { original: string; actual: string }>()

  constructor(private registry: AdapterRegistry) {}

  bind(sessionId: string, adapterName: string, originalAdapter?: string): void {
    this.sessionToAdapter.set(sessionId, adapterName)
    if (originalAdapter && originalAdapter !== adapterName) {
      this.fallbackMap.set(sessionId, { original: originalAdapter, actual: adapterName })
    }
  }

  unbind(sessionId: string): void {
    this.sessionToAdapter.delete(sessionId)
    this.fallbackMap.delete(sessionId)
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

  /** 获取 fallback 信息 */
  getFallbackInfo(sessionId: string): { original: string; actual: string } | undefined {
    return this.fallbackMap.get(sessionId)
  }

  /** 获取原始适配器名（用于前端显示） */
  getOriginalAdapterName(sessionId: string): string | undefined {
    return this.fallbackMap.get(sessionId)?.original
  }

  /** 返回所有活跃会话 ID */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessionToAdapter.keys())
  }
}
