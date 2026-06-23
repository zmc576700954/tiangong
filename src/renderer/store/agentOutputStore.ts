import { create } from 'zustand'
import type { AgentOutput } from '@shared/types'

/** 单个 thread 的输出上限，防止长时间运行导致内存膨胀 */
const MAX_OUTPUTS_PER_THREAD = 1000

/** 全局输出总量预算，超出时淘汰非活跃 thread 的最旧输出 */
const MAX_TOTAL_OUTPUTS = 5000

/** 批处理缓冲区 - 不在 store state 中，避免触发渲染 */
let outputBuffer: Array<{ threadId: string; output: AgentOutput }> = []
let flushScheduled = false
const BATCH_INTERVAL = 16 // ~1 frame at 60fps

/** 已清理的 thread 集合，防止 flush 时写入已清空的 thread（TOCTOU 修复） */
const clearedThreads = new Set<string>()

/** 计算所有 thread 输出的总量 */
function countTotalOutputs(outputs: Record<string, AgentOutput[]>): number {
  let total = 0
  for (const arr of Object.values(outputs)) {
    total += arr.length
  }
  return total
}

interface AgentOutputState {
  threadOutputs: Record<string, AgentOutput[]>

  /** 将输出追加到指定 thread 的缓冲区（立即或批量 flush） */
  appendOutput: (threadId: string, output: AgentOutput) => void
  /** 立即清空指定 thread 的输出 */
  clearThreadOutputs: (threadId: string) => void
  /** 裁剪非活跃 thread 的输出到保留上限 */
  trimInactiveThreadOutputs: (activeThreadId: string) => void
  /** 获取指定 thread 的所有输出 */
  getOutputs: (threadId: string) => AgentOutput[]
}

/** 将缓冲区中的输出批量写入 store，合并为一次状态更新 */
function flushOutputBuffer(set: (fn: (state: AgentOutputState) => Partial<AgentOutputState>) => void) {
  flushScheduled = false
  if (outputBuffer.length === 0) return

  // 快照并清除已清理的 thread 集合，防止本次 flush 写入已清空的 thread
  const skip = new Set(clearedThreads)
  clearedThreads.clear()

  const batch = outputBuffer
  outputBuffer = []

  set((state) => {
    const newOutputs = { ...state.threadOutputs }
    const errorThreadIds = new Set<string>()

    for (const { threadId, output } of batch) {
      if (skip.has(threadId)) continue
      const existing = newOutputs[threadId] ?? []
      newOutputs[threadId] = [...existing, output].slice(-MAX_OUTPUTS_PER_THREAD)
      if (output.type === 'error') {
        errorThreadIds.add(threadId)
      }
    }

    // 全局内存预算：超出时淘汰非活跃 thread 的最旧输出
    const currentThreadId: string | undefined = undefined // TODO: pass from store for correct memory trimming
    let total = countTotalOutputs(newOutputs)
    if (total > MAX_TOTAL_OUTPUTS) {
      const threadIds = Object.keys(newOutputs)
        .filter((tid) => tid !== currentThreadId)
        .sort((a, b) => (newOutputs[b]?.length ?? 0) - (newOutputs[a]?.length ?? 0))
      for (const tid of threadIds) {
        if (total <= MAX_TOTAL_OUTPUTS) break
        const arr = newOutputs[tid]
        if (!arr || arr.length <= 50) continue // 保留最少 50 条
        const trimTo = Math.max(50, Math.floor(arr.length / 2))
        total -= arr.length - trimTo
        newOutputs[tid] = arr.slice(-trimTo)
      }
    }

    return { threadOutputs: newOutputs }
  })
}

/** 调度一次 flush（如果尚未调度） */
function scheduleFlush(set: (fn: (state: AgentOutputState) => Partial<AgentOutputState>) => void) {
  if (flushScheduled) return
  flushScheduled = true
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => flushOutputBuffer(set))
  } else {
    setTimeout(() => flushOutputBuffer(set), BATCH_INTERVAL)
  }
}

export const useAgentOutputStore = create<AgentOutputState>((_set, get) => ({
  threadOutputs: {},

  appendOutput: (threadId, output) => {
    // 对 error 类型输出立即 flush，确保错误状态不延迟显示
    if (output.type === 'error') {
      outputBuffer.push({ threadId, output })
      flushOutputBuffer(_set)
      return
    }
    outputBuffer.push({ threadId, output })
    scheduleFlush(_set)
  },

  clearThreadOutputs: (threadId) => {
    // 标记为已清理，防止并发 flush 写回已清空的 thread
    clearedThreads.add(threadId)
    // 同时清理缓冲区中对应 thread 的条目
    outputBuffer = outputBuffer.filter((entry) => entry.threadId !== threadId)
    _set((state) => {
      if (!(threadId in state.threadOutputs)) return state
      const { [threadId]: _removed, ...rest } = state.threadOutputs
      return { threadOutputs: rest }
    })
  },

  trimInactiveThreadOutputs: (activeThreadId) => {
    const TRIM_TO = 100
    _set((state) => {
      let changed = false
      const updated: Record<string, AgentOutput[]> = {}
      for (const [tid, outputs] of Object.entries(state.threadOutputs)) {
        if (tid !== activeThreadId && outputs.length > TRIM_TO) {
          updated[tid] = outputs.slice(-TRIM_TO)
          changed = true
        }
      }
      return changed
        ? { threadOutputs: { ...state.threadOutputs, ...updated } }
        : state
    })
  },

  getOutputs: (threadId) => {
    return get().threadOutputs[threadId] ?? []
  },
}))
