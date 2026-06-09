/**
 * 适配器注册中心
 * 职责：管理所有 AgentAdapter 实例的注册与查询
 */

import type { AgentAdapter } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('AdapterRegistry')

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.name)) {
      logger.warn(`Adapter '${adapter.name}' is already registered, overwriting with new instance`)
    }
    this.adapters.set(adapter.name, adapter)
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name)
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values())
  }

  async checkAllInstalled(): Promise<{ name: string; version: string; installed: boolean }[]> {
    const adapters = this.list()
    const installedResults = await Promise.all(
      adapters.map((adapter) => adapter.checkInstalled()),
    )
    return adapters.map((adapter, i) => ({
      name: adapter.name,
      version: adapter.version,
      installed: installedResults[i],
    }))
  }
}
