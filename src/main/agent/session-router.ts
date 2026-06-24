/**
 * 会话路由器
 * 职责：管理 sessionId 到 adapterName 的绑定关系
 */

import type { AgentAdapter } from '@shared/types'
import { type AdapterRegistry } from './adapter-registry'
import { SessionNotFoundError, AdapterError } from '../errors'
import { createLogger } from '../shared/logger'

const logger = createLogger('SessionRouter')

/** 会话 TTL：30 分钟，超时后自动清理孤立会话 */
const SESSION_TTL_MS = 30 * 60 * 1000

/** TTL 检查间隔：每 5 分钟检查一次 */
const TTL_CHECK_INTERVAL_MS = 5 * 60 * 1000

/** TTL 过期回调类型：通知上层清理会话资源 */
type TtlExpiredHandler = (sessionId: string) => void

export class SessionRouter {
  private sessionToAdapter = new Map<string, { adapterName: string; originalAdapter?: string; timestamp: number }>()
  /** TTL 定期清理定时器 */
  private ttlCheckTimer: ReturnType<typeof setInterval> | null = null
  /** TTL 过期回调（通知 AgentManager 清理沙箱等资源） */
  private ttlExpiredHandler: TtlExpiredHandler | null = null
  /** 上次 TTL 检查以来活跃的会话集合（用于防止误杀活跃会话） */
  private activeSinceLastCheck = new Set<string>()

  constructor(private registry: AdapterRegistry) {
    this.startTtlCheck()
  }

  /**
   * 注册 TTL 过期回调，用于通知 AgentManager 清理会话资源（沙箱、广播名等）
   */
  onTtlExpired(handler: TtlExpiredHandler): void {
    this.ttlExpiredHandler = handler
  }

  /**
   * 启动定期 TTL 检查，清理孤立会话
   */
  private startTtlCheck(): void {
    if (this.ttlCheckTimer) return
    this.ttlCheckTimer = setInterval(() => {
      const now = Date.now()
      const expired: string[] = []
      for (const [sessionId, entry] of this.sessionToAdapter) {
        // 跳过自上次检查以来活跃的会话（已通过 resolve/touch 刷新时间戳）
        if (this.activeSinceLastCheck.has(sessionId)) {
          continue
        }
        if (now - entry.timestamp > SESSION_TTL_MS) {
          expired.push(sessionId)
        }
      }
      // 清空活跃标记
      this.activeSinceLastCheck.clear()
      for (const sessionId of expired) {
        logger.warn(`Session ${sessionId} exceeded TTL, cleaning up`)
        this.unbind(sessionId)
        // 通知 AgentManager 清理沙箱、广播名等资源
        this.ttlExpiredHandler?.(sessionId)
      }
    }, TTL_CHECK_INTERVAL_MS)
    if (this.ttlCheckTimer && typeof this.ttlCheckTimer === 'object' && 'unref' in this.ttlCheckTimer) {
      (this.ttlCheckTimer as ReturnType<typeof setInterval> & { unref(): void }).unref()
    }
  }

  /**
   * 停止 TTL 检查（用于销毁时）
   */
  stopTtlCheck(): void {
    if (this.ttlCheckTimer) {
      clearInterval(this.ttlCheckTimer)
      this.ttlCheckTimer = null
    }
  }

  bind(sessionId: string, adapterName: string, originalAdapter?: string): void {
    this.sessionToAdapter.set(sessionId, {
      adapterName,
      originalAdapter: originalAdapter !== adapterName ? originalAdapter : undefined,
      timestamp: Date.now(),
    })
  }

  unbind(sessionId: string): void {
    this.sessionToAdapter.delete(sessionId)
  }

  resolve(sessionId: string): AgentAdapter {
    const entry = this.sessionToAdapter.get(sessionId)
    if (!entry) {
      throw new SessionNotFoundError(sessionId)
    }
    // 刷新活跃时间戳，防止活跃会话被 TTL 误杀
    entry.timestamp = Date.now()
    this.activeSinceLastCheck.add(sessionId)
    const adapter = this.registry.get(entry.adapterName)
    if (!adapter) {
      throw new AdapterError(`Adapter ${entry.adapterName} not found for session ${sessionId}`)
    }
    return adapter
  }

  /** 刷新会话活跃时间戳（供 sendCommand 等操作调用） */
  touch(sessionId: string): void {
    const entry = this.sessionToAdapter.get(sessionId)
    if (entry) {
      entry.timestamp = Date.now()
      this.activeSinceLastCheck.add(sessionId)
    }
  }

  getAdapterName(sessionId: string): string | undefined {
    return this.sessionToAdapter.get(sessionId)?.adapterName
  }

  /** 获取 fallback 信息 */
  getFallbackInfo(sessionId: string): { original: string; actual: string } | undefined {
    const entry = this.sessionToAdapter.get(sessionId)
    if (!entry?.originalAdapter) return undefined
    return { original: entry.originalAdapter, actual: entry.adapterName }
  }

  /** 获取原始适配器名（用于前端显示） */
  getOriginalAdapterName(sessionId: string): string | undefined {
    return this.sessionToAdapter.get(sessionId)?.originalAdapter
  }

  /** 返回所有活跃会话 ID */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessionToAdapter.keys())
  }
}
