/**
 * 适配器注册中心
 * 职责：管理所有 AgentAdapter 实例的注册与查询
 */

import type { AgentAdapter } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('AdapterRegistry')

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()
  private _installCache = new Map<string, { installed: boolean; checkedAt: number }>()
  private _cacheTtlMs = 5 * 60 * 1000

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
    const now = Date.now()

    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const cached = this._installCache.get(adapter.name)
        if (cached && now - cached.checkedAt < this._cacheTtlMs) {
          return { name: adapter.name, version: adapter.version, installed: cached.installed }
        }
        const installed = await adapter.checkInstalled()
        this._installCache.set(adapter.name, { installed, checkedAt: now })
        return { name: adapter.name, version: adapter.version, installed }
      })
    )

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      return { name: adapters[i].name, version: adapters[i].version, installed: false }
    })
  }

  invalidateCache(adapterName?: string): void {
    if (adapterName) {
      this._installCache.delete(adapterName)
    } else {
      this._installCache.clear()
    }
  }
}
