/**
 * A2A 任务内存缓存 + 计数器
 *
 * Phase D9 C4. 设计要点：
 *   - in-flight task 不设 TTL（保留直到 server destroy）
 *   - 已完成 task 设 A2A_TASK_TTL_MS（默认 1h）TTL 后被 sweep 清理
 *   - 计数器（activeTasks / completedTasks / failedTasks）用于 a2a:getServerStatus IPC
 *   - server restart 时，调用方从 chat_threads WHERE task_kind='a2a'
 *     重建 working→failed 标记；本模块不持久化
 *
 * **不**与 chat_threads 重复同步 — task-store 是运行时高频读写的热路径，
 * chat_threads 是审计源。两者通过外部 caller（如 message-stream 路由）
 * 显式同步。
 */

import type { A2AArtifact, A2AStatusState, A2ATaskRecord } from '@shared/types/a2a'
import {
  A2A_TASK_TTL_MS,
  A2A_TASK_SWEEP_MS,
} from '@shared/types/a2a'

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

  constructor() {
    this.startSweep()
  }

  put(record: A2ATaskRecord): void {
    this.tasks.set(record.taskId, { record })
  }

  get(taskId: string): A2ATaskRecord | undefined {
    return this.tasks.get(taskId)?.record
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
    if (state === 'completed') {
      entry.completedAt = Date.now()
      this.completedCount += 1
    } else if (state === 'failed') {
      entry.completedAt = Date.now()
      this.failedCount += 1
    }
  }

  /** 增量追加 artifact（用于流式输出累积）。 */
  appendArtifact(taskId: string, artifact: A2AArtifact): void {
    const entry = this.tasks.get(taskId)
    if (!entry) return
    entry.record.artifacts.push(artifact)
    entry.record.lastActivityAt = Date.now()
  }

  /** 删除 task（仅用于 cancel / 测试清理；正常终止走 setStatus 触发 TTL） */
  delete(taskId: string): void {
    this.tasks.delete(taskId)
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
      }
    }
  }
}
