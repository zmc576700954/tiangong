/**
 * 输出广播器
 * 职责：解耦适配器输出与具体的广播目标（如 BrowserWindow）
 * 支持多个监听器（AgentChat UI + MindMapAgent 等内部组件）
 */

import type { AgentOutput } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('OutputBroadcaster')

export class OutputBroadcaster {
  private handlers = new Set<(adapterName: string, output: AgentOutput) => void>()

  onBroadcast(handler: (adapterName: string, output: AgentOutput) => void): void {
    this.handlers.add(handler)
  }

  offBroadcast(handler: (adapterName: string, output: AgentOutput) => void): void {
    this.handlers.delete(handler)
  }

  broadcast(adapterName: string, output: AgentOutput): void {
    for (const handler of this.handlers) {
      try {
        handler(adapterName, output)
      } catch (err) {
        logger.error('handler error:', err)
      }
    }
  }
}
