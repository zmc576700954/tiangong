/**
 * A2A 任务存储（内存态 + 可选持久化）
 *
 * Phase D9 C4. 设计要点：
 *   - in-flight task 不设 TTL（保留直到 server destroy）
 *   - 已完成 task 设 A2A_TASK_TTL_MS（默认 1h）TTL 后被 sweep 清理
 *   - 计数器（activeTasks / completedTasks / failedTasks）用于 a2a:getServerStatus IPC
 *   - 传入 persistence 时任务同时落到 chat_threads（metadata.task_kind='a2a'）：
 *     重启后历史任务仍可查，且重启前处于 working 的任务会被收敛为 failed
 *     （它们的 Agent 会话已随进程消失）
 *
 * 内存是运行时权威，持久化是审计源：持久化失败不影响内存态。
 */

import type { A2AArtifact, A2AStatusState, A2ATaskRecord } from '@shared/types/a2a'
import {
  A2A_TASK_TTL_MS,
  A2A_TASK_SWEEP_MS,
} from '@shared/types/a2a'
import { createLogger } from '../shared/logger'

const logger = createLogger('A2ATaskStore')

/** A2A 任务的持久化后端（chat_threads 实现见 task-persistence.ts）。 */
export interface A2ATaskPersistence {
  /** 新建或覆盖一条任务记录。 */
  upsert(record: A2ATaskRecord): void
  /** 状态 / artifact / history 变化后的落库。 */
  update(record: A2ATaskRecord): void
  delete(taskId: string): void
  /** 读取全部任务记录。 */
  listAll(): A2ATaskRecord[]
  find(taskId: string): A2ATaskRecord | null
}

interface TaskRecordInternal {
  record: A2ATaskRecord
  /** 完成时间（用于 TTL）；仅在终态（completed/failed/canceled）时设置 */
  completedAt?: number
}

export interface A2ATaskStoreStats {
  activeTasks: number
  completedTasks: number
  failedTasks: number
}

export class A2ATaskStore {
  private readonly tasks = new Map<string, TaskRecordInternal>()
  private completedCount = 0
  private failedCount = 0
  private sweepTimer: NodeJS.Timeout | null = null
  private readonly persistence: A2ATaskPersistence | null

  constructor(persistence: A2ATaskPersistence | null = null) {
    this.persistence = persistence
    this.startSweep()
    if (persistence !== null) this.reconcilePersisted()
  }

  put(record: A2ATaskRecord): void {
    this.tasks.set(record.taskId, { record })
    this.persist(record, 'upsert')
  }

  get(taskId: string): A2ATaskRecord | undefined {
    const cached = this.tasks.get(taskId)
    if (cached) return cached.record
    // 内存未命中 → 回落持久化（重启后查历史任务）。
    const persisted = this.safe(() => this.persistence?.find(taskId) ?? null)
    if (!persisted) return undefined
    this.tasks.set(taskId, { record: persisted, completedAt: this.completedAtOf(persisted) })
    return persisted
  }

  /** 更新 task 状态；若状态转为终态则记录 completedAt 以触发 TTL。 */
  setStatus(taskId: string, state: A2AStatusState, extras?: Partial<A2ATaskRecord>): void {
    const entry = this.tasks.get(taskId)
    if (!entry) return
    entry.record.status = state
    entry.record.lastActivityAt = Date.now()
    if (extras) {
      Object.assign(entry.record, extras)
    }
    const isTerminal = state === 'completed' || state === 'failed' || state === 'canceled'
    if (!isTerminal) {
      this.persist(entry.record, 'update')
      return
    }
    // 终态：记录完成时间以触发 TTL 清理。
    // 计数只在**首次**进入终态时累加 —— 重复 setStatus 同一终态不应重复计数。
    const firstTerminal = entry.completedAt === undefined
    if (firstTerminal) {
      entry.completedAt = Date.now()
      if (state === 'completed') {
        this.completedCount += 1
      } else if (state === 'failed') {
        this.failedCount += 1
      }
    }
    this.persist(entry.record, 'update')
  }

  /** 增量追加 artifact（用于流式输出累积）。 */
  appendArtifact(taskId: string, artifact: A2AArtifact): void {
    const entry = this.tasks.get(taskId)
    if (!entry) return
    entry.record.artifacts.push(artifact)
    entry.record.lastActivityAt = Date.now()
    this.persist(entry.record, 'update')
  }

  /** 删除 task（仅用于 cancel / 测试清理；正常终止走 setStatus 触发 TTL） */
  delete(taskId: string): void {
    this.tasks.delete(taskId)
    this.safe(() => this.persistence?.delete(taskId))
  }

  /** 列出 task，按 ?contextId / ?status 过滤。 */
  list(filter?: { contextId?: string; status?: A2AStatusState }): A2ATaskRecord[] {
    const out: A2ATaskRecord[] = []
    for (const { record } of this.tasks.values()) {
      if (filter?.contextId !== undefined && record.contextId !== filter.contextId) continue
      if (filter?.status !== undefined && record.status !== filter.status) continue
      out.push(record)
    }
    return out
  }

  /** 关闭 store，停止 sweep timer，丢弃所有 task。 */
  destroy(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.tasks.clear()
  }

  /** 内部使用：unit tests */
  size(): number {
    return this.tasks.size
  }

  /** 计数器快照（用于 IPC a2a:getServerStatus） */
  stats(): A2ATaskStoreStats {
    let active = 0
    for (const { record } of this.tasks.values()) {
      if (record.status === 'working' || record.status === 'input-required') active += 1
    }
    return {
      activeTasks: active,
      completedTasks: this.completedCount,
      failedTasks: this.failedCount,
    }
  }

  /**
   * 从持久化恢复历史任务，并把重启前仍在 working 的任务收敛为 failed。
   *
   * 收敛的理由：working 意味着「Agent 会话正在跑」。进程重启后那些会话
   * 已经不存在了 —— 不收敛的话，GET /v1/tasks 会一直报一个永远不会结束的
   * 任务，远端调用方只能等超时。
   */
  private reconcilePersisted(): void {
    const records = this.safe(() => this.persistence?.listAll() ?? [])
    if (!records) return
    for (const record of records) {
      const terminal = record.status === 'completed' || record.status === 'failed' || record.status === 'canceled'
      if (terminal) {
        this.tasks.set(record.taskId, { record, completedAt: this.completedAtOf(record) })
        if (record.status === 'completed') this.completedCount += 1
        else if (record.status === 'failed') this.failedCount += 1
        continue
      }
      const converged: A2ATaskRecord = {
        ...record,
        status: 'failed',
        lastActivityAt: Date.now(),
      }
      this.tasks.set(converged.taskId, { record: converged, completedAt: Date.now() })
      this.failedCount += 1
      this.persist(converged, 'update')
      logger.info(
        `A2A task ${converged.taskId} was '${record.status}' before restart — converged to failed`,
      )
    }
  }

  /** 终态记录的 TTL 起点：没有记录时间时退回 lastActivityAt。 */
  private completedAtOf(record: A2ATaskRecord): number | undefined {
    if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'canceled') {
      return undefined
    }
    return record.lastActivityAt || record.startedAt
  }

  /** 持久化失败只记日志 —— 内存态是运行时权威，不能因落库失败而中断任务。 */
  private persist(record: A2ATaskRecord, op: 'upsert' | 'update'): void {
    if (this.persistence === null) return
    this.safe(() => {
      if (op === 'upsert') this.persistence?.upsert(record)
      else this.persistence?.update(record)
    })
  }

  private safe<T>(fn: () => T): T | null {
    try {
      return fn()
    } catch (err) {
      logger.warn('A2A task persistence failed:', err)
      return null
    }
  }

  private startSweep(): void {
    this.sweepTimer = setInterval(() => this.sweep(), A2A_TASK_SWEEP_MS)
    // Don't keep Node alive solely for the sweep.
    this.sweepTimer.unref?.()
  }

  private sweep(): void {
    const now = Date.now()
    for (const [taskId, entry] of this.tasks.entries()) {
      if (entry.completedAt !== undefined && now - entry.completedAt > A2A_TASK_TTL_MS) {
        this.tasks.delete(taskId)
        // 内存清了就别在 DB 里留孤儿行。
        this.safe(() => this.persistence?.delete(taskId))
      }
    }
  }
}
