import type { AgentEventEnvelope, RunStatus } from '../types'

export type RunPhase = RunStatus

/**
 * 最小状态机：状态按 runId 分桶，不同 run 的状态互不影响。
 * 迁移规则对齐新文档 §4.1；事件是唯一驱动源。
 */
export class RunEngine {
  private readonly states = new Map<string, RunPhase>()
  private readonly traces = new Map<string, RunPhase[]>()

  constructor() {
    this.consume = this.consume.bind(this)
  }

  ensure(runId: string): RunPhase {
    if (!this.states.has(runId)) {
      this.states.set(runId, 'created')
      this.traces.set(runId, ['created'])
    }
    return this.states.get(runId)!
  }

  consume(event: AgentEventEnvelope): RunPhase {
    this.ensure(event.runId)
    const current = this.states.get(event.runId)!
    const next = transition(current, event.type)
    if (next && next !== current) {
      this.states.set(event.runId, next)
      this.traces.get(event.runId)!.push(next)
    }
    return this.states.get(event.runId)!
  }

  getState(runId: string): RunPhase {
    return this.ensure(runId)
  }

  getTrace(runId: string): RunPhase[] {
    return [...(this.traces.get(runId) ?? [])]
  }
}

function transition(current: RunPhase, type: AgentEventEnvelope['type']): RunPhase | undefined {
  if (current === 'completed' || current === 'failed' || current === 'cancelled') return undefined
  switch (type) {
    case 'run.started':
      return 'running'
    case 'tool.approval_required':
      return 'awaiting_approval'
    case 'tool.approved':
    case 'tool.denied':
      return 'running'
    case 'run.completed':
      return 'completed'
    case 'run.failed':
      return 'failed'
    case 'run.cancelled':
      return 'cancelled'
    case 'run.interrupted':
      return 'interrupted'
    default:
      return undefined
  }
}
