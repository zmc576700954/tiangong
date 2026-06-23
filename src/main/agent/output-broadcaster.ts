/**
 * 输出广播器
 * 职责：解耦适配器输出与具体的广播目标（如 BrowserWindow）
 * 支持多个监听器（AgentChat UI + MindMapAgent 等内部组件）
 */

import type { AgentOutput } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('OutputBroadcaster')

export interface BroadcastPayload {
  adapterName: string
  sessionId?: string
  output: AgentOutput
}

export class OutputBroadcaster {
  private handlers = new Set<(payload: BroadcastPayload) => void>()

  onBroadcast(handler: (payload: BroadcastPayload) => void): void {
    this.handlers.add(handler)
  }

  offBroadcast(handler: (payload: BroadcastPayload) => void): void {
    this.handlers.delete(handler)
  }

  broadcast(adapterName: string, output: AgentOutput, sessionId?: string): void {
    const payload: BroadcastPayload = { adapterName, sessionId, output }
    for (const handler of this.handlers) {
      try {
        handler(payload)
      } catch (err) {
        logger.error('handler error:', err)
      }
    }
  }
}
