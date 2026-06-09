/**
 * Agent Swarm 领域类型定义
 * 包含 Swarm 任务编排、配置与执行结果相关类型
 */

import type { AgentOutput } from './agent'

// ============================================
// Swarm 任务类型
// ============================================

/** Swarm 任务类型 */
export type SwarmTaskType = 'implement' | 'test' | 'review' | 'refactor'

/** Swarm 任务状态 */
export type SwarmTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

/** Swarm 单个任务 */
export interface SwarmTask {
  /** 任务唯一标识 */
  id: string
  /** 父任务 ID（用于子任务层级关系） */
  parentTaskId?: string
  /** 任务自然语言描述 */
  description: string
  /** 任务类型 */
  taskType: SwarmTaskType
  /** 当前执行状态 */
  status: SwarmTaskStatus
  /** 依赖的其他任务 ID 列表（DAG 依赖） */
  dependencies: string[]
  /** 分配的适配器名称 */
  assignedAdapter?: string
  /** 任务执行结果摘要 */
  result?: string
  /** 创建时间戳 */
  createdAt: number
  /** 完成时间戳 */
  completedAt?: number
}

// ============================================
// Swarm 配置类型
// ============================================

/** Swarm 执行策略 */
export type SwarmStrategy = 'parallel' | 'sequential' | 'dag'

/** Swarm 配置 */
export interface SwarmConfig {
  /** 任务列表 */
  tasks: SwarmTask[]
  /** 并行执行上限（默认 3） */
  parallelLimit: number
  /** 执行策略 */
  strategy: SwarmStrategy
}

// ============================================
// Swarm 执行结果类型
// ============================================

/** Swarm 执行结果 */
export interface SwarmExecutionResult {
  /** 整体是否成功（所有任务完成且无失败） */
  success: boolean
  /** 已完成的任务 ID 列表 */
  completedTasks: string[]
  /** 失败的任务 ID 列表 */
  failedTasks: string[]
  /** 每个任务的 Agent 输出记录 */
  outputs: Record<string, AgentOutput[]>
}
