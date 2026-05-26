/**
 * 输出广播器
 * 职责：解耦适配器输出与具体的广播目标（如 BrowserWindow）
 */

import type { AgentOutput } from '@shared/types'

export class OutputBroadcaster {
  private handler?: (adapterName: string, output: AgentOutput) => void

  onBroadcast(handler: (adapterName: string, output: AgentOutput) => void): void {
    this.handler = handler
  }

  broadcast(adapterName: string, output: AgentOutput): void {
    this.handler?.(adapterName, output)
  }
}
