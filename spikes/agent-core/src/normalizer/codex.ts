import type {
  AgentEventEnvelope,
  MessagePayload,
  NormalizeMeta,
  RunStartedPayload,
  RunTerminalPayload,
  ToolRequestedPayload,
  ToolResultPayload,
  UsagePayload,
} from '../types'
import { EventSink } from './sink'

interface CodexItem {
  type: string
  text?: string
  path?: string
  change?: 'add' | 'modify' | 'delete'
  command?: string
  output?: string
}

interface CodexResult {
  thread_id?: string
  items?: CodexItem[]
  final_response?: string
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
}

/**
 * Codex 阻塞单结果：eventFidelity = turn，loopOwnership = backend。
 * run() 返回后才拿到 items；run.started 与 tool.* 为合成事件（source: synthetic）。
 */
export function normalizeCodex(raw: unknown, meta: NormalizeMeta): AgentEventEnvelope[] {
  const sink = new EventSink(meta)
  const result = raw as CodexResult

  sink.emit({
    type: 'run.started',
    fidelity: 'turn',
    source: 'synthetic',
    backendName: 'codex',
    backendSessionId: result.thread_id,
    nativeType: 'thread.run:start',
    payload: { attempt: 1, resumeMode: 'fresh' } satisfies RunStartedPayload,
  })

  let messageCompleted = false
  let toolIndex = 0
  let lastText = ''

  for (const item of result.items ?? []) {
    if (item.type === 'agent_message' && item.text) {
      lastText = item.text
      if (!messageCompleted) {
        sink.emit({
          type: 'message.completed',
          fidelity: 'turn',
          source: 'backend',
          backendName: 'codex',
          nativeType: 'item/agent_message',
          payload: { role: 'assistant', text: item.text, mode: 'block' } satisfies MessagePayload,
        })
        messageCompleted = true
      } else {
        sink.emit({
          type: 'message.delta',
          fidelity: 'turn',
          source: 'backend',
          backendName: 'codex',
          nativeType: 'item/agent_message',
          payload: { role: 'assistant', text: item.text, mode: 'block' } satisfies MessagePayload,
        })
      }
      continue
    }

    if (item.type === 'file_change' || item.type === 'command_execution') {
      toolIndex += 1
      const stepId = `step-codex-${toolIndex}`
      const toolCallId = `call-codex-${toolIndex}`
      const toolName = item.type
      const input =
        item.type === 'file_change'
          ? { path: item.path, change: item.change }
          : { command: item.command }

      sink.emit({
        type: 'tool.requested',
        fidelity: 'turn',
        source: 'synthetic',
        backendName: 'codex',
        nativeType: `item/${item.type}`,
        stepId,
        payload: {
          toolCallId,
          toolName,
          input,
          risk: item.type === 'file_change' ? 'medium' : 'low',
          blocking: false,
        } satisfies ToolRequestedPayload,
      })
      sink.emit({
        type: 'tool.result',
        fidelity: 'turn',
        source: 'synthetic',
        backendName: 'codex',
        nativeType: `item/${item.type}`,
        stepId,
        payload: {
          toolCallId,
          ok: true,
          output: item.output ?? `observed ${item.type}`,
        } satisfies ToolResultPayload,
      })
    }
  }

  const usage: UsagePayload | undefined = result.usage
    ? {
        inputTokens: result.usage.input_tokens ?? 0,
        outputTokens: result.usage.output_tokens ?? 0,
      }
    : undefined

  if (usage) {
    sink.emit({
      type: 'usage.updated',
      fidelity: 'turn',
      source: 'backend',
      backendName: 'codex',
      nativeType: 'result/usage',
      payload: usage,
    })
  }

  sink.emit({
    type: 'run.completed',
    fidelity: 'turn',
    source: 'backend',
    backendName: 'codex',
    backendSessionId: result.thread_id,
    nativeType: 'thread.run:end',
    payload: {
      status: 'completed',
      summary: result.final_response ?? lastText ?? 'done',
      usage,
    } satisfies RunTerminalPayload,
  })

  return sink.snapshot()
}
