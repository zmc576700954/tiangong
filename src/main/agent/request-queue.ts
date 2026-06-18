import { createLogger } from '../shared/logger'

const logger = createLogger('request-queue')

export enum RequestPriority {
  System = 0,
  Retry = 1,
  User = 2,
}

export interface QueueRequest {
  id: string
  adapterName: string
  command: string
  nodeId?: string
  priority: RequestPriority
  enqueuedAt?: number
  abortController?: AbortController
}

export interface QueueResult {
  success: boolean
  error?: Error
}

export interface RequestQueueConfig {
  maxConcurrent: number
  executor: (req: QueueRequest) => Promise<QueueResult>
  dedupWindowMs?: number
}

interface QueuedItem {
  request: QueueRequest
  status: 'queued' | 'executing'
}

export class RequestQueue {
  private _queues = new Map<string, QueuedItem[]>()
  private _config: RequestQueueConfig
  private _dedupMap = new Map<string, number>()
  private _dedupWindowMs: number

  constructor(config: RequestQueueConfig) {
    this._config = config
    this._dedupWindowMs = config.dedupWindowMs ?? 30_000
  }

  enqueue(req: QueueRequest): boolean {
    if (req.nodeId) {
      const dedupKey = `${req.nodeId}:${req.command}`
      const lastTime = this._dedupMap.get(dedupKey)
      const effectiveWindow = this.getEffectiveDedupWindowMs()
      if (lastTime && Date.now() - lastTime < effectiveWindow) {
        logger.debug(`Dedup: skipping ${req.id} (same nodeId+command within ${effectiveWindow}ms)`)
        return false
      }
      this._dedupMap.set(dedupKey, Date.now())
    }

    const item: QueuedItem = {
      request: { ...req, enqueuedAt: Date.now(), abortController: req.abortController ?? new AbortController() },
      status: 'queued'
    }

    const queue = this._getQueue(req.adapterName)
    queue.push(item)
    queue.sort((a, b) => b.request.priority - a.request.priority)
    return true
  }

  peekNext(adapterName: string): QueueRequest | undefined {
    const queue = this._getQueue(adapterName)
    return queue.find(i => i.status === 'queued')?.request
  }

  async drain(): Promise<void> {
    const allAdapters = Array.from(this._queues.keys())
    await Promise.all(allAdapters.map(a => this._drainAdapter(a)))
  }

  cancel(requestId: string): boolean {
    for (const [, queue] of this._queues) {
      const idx = queue.findIndex(i => i.request.id === requestId && i.status === 'queued')
      if (idx !== -1) {
        queue.splice(idx, 1)
        return true
      }
    }
    return false
  }

  size(): number {
    let total = 0
    for (const queue of this._queues.values()) {
      total += queue.filter(i => i.status === 'queued').length
    }
    return total
  }

  /**
   * 获取系统负载等级
   *
   * 基于待处理 + 执行中的请求数量判断负载:
   *   < 2: 'low'    — 系统空闲，无特殊行为
   *   2-5: 'medium' — 正常负载
   *   > 5: 'high'   — 高负载，自动延长队列超时
   */
  getSystemLoad(): 'low' | 'medium' | 'high' {
    let count = 0
    for (const queue of this._queues.values()) {
      count += queue.filter(i => i.status === 'queued' || i.status === 'executing').length
    }
    if (count < 2) return 'low'
    if (count <= 5) return 'medium'
    return 'high'
  }

  /**
   * 获取当前去重窗口超时（根据系统负载自适应）
   *
   * 高负载时从 30s 延长到 60s，减少重复请求的执行压力；
   * 低/中负载使用默认 30s。
   */
  getEffectiveDedupWindowMs(): number {
    return this.getSystemLoad() === 'high'
      ? this._dedupWindowMs * 2
      : this._dedupWindowMs
  }

  private _getQueue(adapterName: string): QueuedItem[] {
    let queue = this._queues.get(adapterName)
    if (!queue) {
      queue = []
      this._queues.set(adapterName, queue)
    }
    return queue
  }

  private async _drainAdapter(adapterName: string): Promise<void> {
    const queue = this._getQueue(adapterName)
    const maxConcurrent = this._config.maxConcurrent
    let active = 0

    while (queue.some(i => i.status === 'queued')) {
      if (active >= maxConcurrent) break
      const next = queue.find(i => i.status === 'queued')
      if (!next) break
      next.status = 'executing'
      active++
      try {
        await this._config.executor(next.request)
      } catch (error) {
        logger.warn(`Request ${next.request.id} failed:`, error)
      } finally {
        active--
        const idx = queue.indexOf(next)
        if (idx !== -1) queue.splice(idx, 1)
      }
    }
  }
}
