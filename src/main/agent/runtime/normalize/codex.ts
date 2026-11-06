/**
 * Codex 归一化（D-C：默认 runStreamed，C1–C7 同批交付）。
 *
 * C1 完成判定：turn.completed 即完成，不依赖迭代器结束。
 * C2 abort：未闭合 item 在 turn 中止时标 aborted，未知则 unknown。
 * C5 未知事件容错：不认识的事件类型直接忽略。
 * C7 file_change 无 diff：如实标记 diffUnavailable，不伪造 diff。
 */

import type { NormalizedEventEnvelope } from '@shared/types/agent-runtime'
import { EventSink, type NormalizeMeta } from './sink'

interface CodexItem {
  id?: string
  type: string
  text?: string
  path?: string
  change?: 'add' | 'modify' | 'delete'
  command?: string
  output?: string
  changes?: Array<{ path: string; kind: 'add' | 'modify' | 'delete' }>
}

interface CodexResult {
  thread_id?: string
  items?: CodexItem[]
  final_response?: string
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
}

interface CodexStreamEvent {
  type: string
  item?: CodexItem
  thread_id?: string
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
  error?: { message?: string } | string
  message?: string
}

interface OpenItem {
  stepId: string
  toolCallId: string
  itemType: string
}

/** 阻塞 run() 的结果（保留供旧夹具与兼容路径使用）。 */
export function normalizeCodexResult(raw: unknown, meta: NormalizeMeta): NormalizedEventEnvelope[] {
  const sink = new EventSink(meta)
  const result = raw as CodexResult

  sink.emit({
    type: 'run.started',
    fidelity: 'turn',
    source: 'synthetic',
    payload: { attempt: 1, resumeMode: 'fresh', backendSessionId: result.thread_id },
  })

  let messageCompleted = false
  let toolIndex = 0
  let lastText = ''

  for (const item of result.items ?? []) {
    if (item.type === 'agent_message' && item.text) {
      lastText = item.text
      sink.emit({
        type: messageCompleted ? 'message.delta' : 'message.completed',
        fidelity: 'turn',
        source: 'backend',
        payload: { role: 'assistant', text: item.text, mode: 'block' },
      })
      messageCompleted = true
      continue
    }

    if (item.type === 'file_change' || item.type === 'command_execution') {
      toolIndex += 1
      const stepId = `step-codex-${toolIndex}`
      const toolCallId = `call-codex-${toolIndex}`
      const input = item.type === 'file_change' ? { path: item.path, change: item.change } : { command: item.command }
      sink.emit({
        type: 'tool.requested',
        fidelity: 'turn',
        source: 'synthetic',
        stepId,
        payload: {
          toolCallId,
          toolName: item.type,
          input,
          risk: item.type === 'file_change' ? 'medium' : 'low',
          blocking: false,
          diffUnavailable: item.type === 'file_change',
        },
      })
      sink.emit({
        type: 'tool.result',
        fidelity: 'turn',
        source: 'synthetic',
        stepId,
        payload: {
          toolCallId,
          ok: true,
          output: item.output ?? `observed ${item.type}`,
          diffUnavailable: item.type === 'file_change',
        },
      })
    }
  }

  const usage = result.usage
    ? { inputTokens: result.usage.input_tokens ?? 0, outputTokens: result.usage.output_tokens ?? 0 }
    : undefined
  if (usage) sink.emit({ type: 'usage.updated', fidelity: 'turn', source: 'backend', payload: usage })

  sink.emit({
    type: 'run.completed',
    fidelity: 'turn',
    source: 'backend',
    payload: { status: 'completed', summary: result.final_response ?? lastText ?? 'done', usage },
  })

  return sink.snapshot()
}

/**
 * runStreamed 事件序列归一化器。
 * 传入完整事件数组即可得到与调用顺序一致的 turn 内事件。
 */
export class CodexStreamNormalizer {
  private readonly sink: EventSink
  private readonly openItems = new Map<string, OpenItem>()
  private stepIndex = 0
  private messageCount = 0
  private lastText = ''
  private completed = false
  private failed = false
  private usage: { inputTokens: number; outputTokens: number } | undefined

  constructor(meta: NormalizeMeta) {
    this.sink = new EventSink(meta)
  }

  feed(event: CodexStreamEvent): void {
    switch (event.type) {
      case 'thread.started':
        this.sink.emit({
          type: 'run.started',
          fidelity: 'turn',
          source: 'backend',
          payload: { attempt: 1, resumeMode: 'fresh', backendSessionId: event.thread_id },
        })
        break

      case 'turn.started':
        this.sink.emit({ type: 'turn.started', fidelity: 'turn', source: 'backend', payload: {} })
        break

      case 'item.started':
      case 'item.updated':
        this.trackOpenItem(event.item)
        break

      case 'item.completed':
        this.completeItem(event.item)
        break

      case 'turn.completed':
        this.usage = event.usage
          ? { inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 }
          : this.usage
        this.completed = true
        // C1：turn.completed 即完成；未闭合 item 标 aborted（不是假装成功）
        this.closeOpenItems('aborted')
        break

      case 'turn.failed':
        this.failed = true
        this.closeOpenItems('aborted')
        this.sink.emit({
          type: 'turn.failed',
          fidelity: 'turn',
          source: 'backend',
          payload: { message: errorText(event), failure: { class: 'permanent', code: 'CODEX_TURN_FAILED' } },
        })
        break

      case 'error':
        this.failed = true
        this.sink.emit({
          type: 'error',
          fidelity: 'turn',
          source: 'backend',
          payload: { message: errorText(event) },
        })
        break

      default:
        // C5：未知事件容错
        break
    }
  }

  /** 迭代器结束（无论是否已 turn.completed）后调用；补齐 open item 与 run 终态。 */
  finish(): NormalizedEventEnvelope[] {
    if (!this.completed && !this.failed) {
      // 迭代器结束但未收到 turn.completed：不能宣称成功（C1 的反面）
      this.closeOpenItems('unknown')
      this.sink.emit({
        type: 'turn.failed',
        fidelity: 'turn',
        source: 'kernel',
        payload: {
          message: 'Codex stream ended without turn.completed',
          failure: { class: 'permanent', code: 'CODEX_TURN_NOT_COMPLETED' },
        },
      })
    } else if (this.completed) {
      this.closeOpenItems('aborted')
      if (this.usage) {
        this.sink.emit({ type: 'usage.updated', fidelity: 'turn', source: 'backend', payload: this.usage })
      }
      this.sink.emit({
        type: 'run.completed',
        fidelity: 'turn',
        source: 'backend',
        payload: { status: 'completed', summary: this.lastText || 'done', usage: this.usage },
      })
    } else {
      this.sink.emit({
        type: 'run.failed',
        fidelity: 'turn',
        source: 'backend',
        payload: { status: 'failed', summary: 'codex turn failed', failure: { class: 'permanent', code: 'CODEX_TURN_FAILED' } },
      })
    }
    return this.sink.snapshot()
  }

  private trackOpenItem(item: CodexItem | undefined): void {
    if (!item) return
    const identity = item.id ?? `${item.type}-${this.stepIndex}`
    if (this.openItems.has(identity)) return
    if (item.type !== 'command_execution' && item.type !== 'file_change' && item.type !== 'mcp_tool_call') {
      return
    }
    this.stepIndex += 1
    const stepId = `step-codex-${this.stepIndex}`
    const toolCallId = item.id ?? `call-codex-${this.stepIndex}`
    this.openItems.set(identity, { stepId, toolCallId, itemType: item.type })
    this.sink.emit({
      type: 'tool.requested',
      fidelity: 'turn',
      source: 'synthetic',
      stepId,
      payload: {
        toolCallId,
        toolName: item.type,
        input: itemInput(item),
        risk: item.type === 'file_change' ? 'medium' : 'low',
        blocking: false,
        diffUnavailable: item.type === 'file_change',
      },
    })
  }

  private completeItem(item: CodexItem | undefined): void {
    if (!item) return
    if (item.type === 'agent_message' && item.text) {
      this.lastText = item.text
      this.sink.emit({
        type: this.messageCount === 0 ? 'message.completed' : 'message.delta',
        fidelity: 'turn',
        source: 'backend',
        payload: { role: 'assistant', text: item.text, mode: 'block' },
      })
      this.messageCount += 1
      return
    }

    const identity = item.id ?? `${item.type}-${this.stepIndex}`
    let open = this.openItems.get(identity)
    if (!open) {
      this.trackOpenItem(item)
      open = this.openItems.get(identity)
    }
    if (!open) return
    this.openItems.delete(identity)
    this.sink.emit({
      type: 'tool.result',
      fidelity: 'turn',
      source: 'synthetic',
      stepId: open.stepId,
      payload: {
        toolCallId: open.toolCallId,
        ok: true,
        output: item.output ?? `observed ${item.type}`,
        diffUnavailable: item.type === 'file_change',
      },
    })
    if (item.type === 'file_change') {
      for (const change of item.changes ?? (item.path ? [{ path: item.path, kind: item.change ?? 'modify' }] : [])) {
        this.sink.emit({
          type: 'file.change',
          fidelity: 'turn',
          source: 'synthetic',
          stepId: open.stepId,
          payload: { path: change.path, changeType: change.kind, diffUnavailable: true },
        })
      }
    }
  }

  private closeOpenItems(status: 'aborted' | 'unknown'): void {
    for (const open of this.openItems.values()) {
      this.sink.emit({
        type: status === 'aborted' ? 'tool.aborted' : 'tool.unknown',
        fidelity: 'turn',
        source: 'kernel',
        stepId: open.stepId,
        payload: { toolCallId: open.toolCallId, toolName: open.itemType, reason: status },
      })
    }
    this.openItems.clear()
  }

  snapshot(): NormalizedEventEnvelope[] {
    return this.sink.snapshot()
  }
}

function itemInput(item: CodexItem): Record<string, unknown> {
  if (item.type === 'file_change') return { path: item.path, change: item.change }
  if (item.type === 'command_execution') return { command: item.command }
  return { itemType: item.type }
}

function errorText(event: CodexStreamEvent): string {
  if (typeof event.error === 'string') return event.error
  if (event.error?.message) return event.error.message
  return event.message ?? 'codex error'
}

/** 入口：数组视作 runStreamed 事件序列；对象视作阻塞结果。 */
export function normalizeCodex(raw: unknown, meta: NormalizeMeta): NormalizedEventEnvelope[] {
  if (Array.isArray(raw)) {
    const normalizer = new CodexStreamNormalizer(meta)
    for (const event of raw as CodexStreamEvent[]) normalizer.feed(event)
    return normalizer.finish()
  }
  return normalizeCodexResult(raw, meta)
}

export type { CodexStreamEvent }
