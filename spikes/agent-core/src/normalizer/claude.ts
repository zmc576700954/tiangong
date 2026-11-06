import type {
  AgentEventEnvelope,
  NormalizeMeta,
  RunStartedPayload,
  RunTerminalPayload,
  UsagePayload,
} from '../types'
import { EventSink } from './sink'
import type { MessagePayload, ToolRequestedPayload, ToolResultPayload } from '../types'

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface ClaudeMessage {
  type?: string
  subtype?: string
  model?: string
  session_id?: string
  message?: { content?: ClaudeContentBlock[] }
  usage?: { input_tokens?: number; output_tokens?: number }
  result?: string
  is_error?: boolean
}

/**
 * Claude 逐消息流：eventFidelity = token，loopOwnership = backend。
 * run.started 来自 system:init；tool_use/tool_result 一比一映射为 tool.requested/tool.result。
 */
export function normalizeClaude(raws: unknown[], meta: NormalizeMeta): AgentEventEnvelope[] {
  const sink = new EventSink(meta)
  let messageCompleted = false
  let finalText = ''
  const toolNames = new Map<string, string>()

  for (const raw of raws) {
    const msg = raw as ClaudeMessage

    if (msg.type === 'system' && msg.subtype === 'init') {
      sink.emit({
        type: 'run.started',
        fidelity: 'token',
        source: 'backend',
        backendName: 'claude-code',
        backendSessionId: msg.session_id,
        nativeType: 'system/init',
        payload: { attempt: 1, resumeMode: 'fresh' } satisfies RunStartedPayload,
      })
      continue
    }

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          if (!messageCompleted) {
            sink.emit({
              type: 'message.delta',
              fidelity: 'token',
              source: 'backend',
              backendName: 'claude-code',
              nativeType: 'assistant/text',
              payload: { role: 'assistant', text: block.text, mode: 'block' } satisfies MessagePayload,
            })
            sink.emit({
              type: 'message.completed',
              fidelity: 'token',
              source: 'backend',
              backendName: 'claude-code',
              nativeType: 'assistant/text',
              payload: { role: 'assistant', text: block.text, mode: 'block' } satisfies MessagePayload,
            })
            messageCompleted = true
          } else {
            finalText = block.text
            sink.emit({
              type: 'message.delta',
              fidelity: 'token',
              source: 'backend',
              backendName: 'claude-code',
              nativeType: 'assistant/text',
              payload: { role: 'assistant', text: block.text, mode: 'block' } satisfies MessagePayload,
            })
          }
        } else if (block.type === 'thinking' && block.thinking) {
          sink.emit({
            type: 'reasoning.delta',
            fidelity: 'token',
            source: 'backend',
            backendName: 'claude-code',
            nativeType: 'assistant/thinking',
            payload: { text: block.thinking },
          })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          toolNames.set(block.id, block.name)
          const args = block.input as Record<string, unknown> | undefined
          const affectedPath = typeof args?.file_path === 'string' ? args.file_path : undefined
          sink.emit({
            type: 'tool.requested',
            fidelity: 'token',
            source: 'backend',
            backendName: 'claude-code',
            nativeType: 'assistant/tool_use',
            stepId: `step-${block.id}`,
            payload: {
              toolCallId: block.id,
              toolName: block.name,
              input: block.input,
              risk: affectedPath ? 'medium' : 'low',
              blocking: true,
            } satisfies ToolRequestedPayload,
          })
        }
      }
      continue
    }

    if (msg.type === 'user') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          sink.emit({
            type: 'tool.result',
            fidelity: 'token',
            source: 'backend',
            backendName: 'claude-code',
            nativeType: 'user/tool_result',
            stepId: `step-${block.tool_use_id}`,
            payload: {
              toolCallId: block.tool_use_id,
              ok: true,
              output: summarize(block.content),
            } satisfies ToolResultPayload,
          })
        }
      }
      continue
    }

    if (msg.type === 'result') {
      const usage: UsagePayload | undefined = msg.usage
        ? { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 }
        : undefined
      if (usage) {
        sink.emit({
          type: 'usage.updated',
          fidelity: 'token',
          source: 'backend',
          backendName: 'claude-code',
          nativeType: 'result/usage',
          payload: usage,
        })
      }
      if (msg.is_error) {
        sink.emit({
          type: 'run.failed',
          fidelity: 'token',
          source: 'backend',
          backendName: 'claude-code',
          nativeType: 'result/error',
          payload: {
            status: 'failed',
            summary: msg.result ?? 'claude error',
            failure: { class: 'permanent', code: 'CLAUDE_ERROR', message: msg.result ?? 'unknown' },
          } satisfies RunTerminalPayload,
        })
      } else {
        sink.emit({
          type: 'run.completed',
          fidelity: 'token',
          source: 'backend',
          backendName: 'claude-code',
          nativeType: 'result/success',
          payload: {
            status: 'completed',
            summary: finalText || msg.result || 'done',
            usage,
          } satisfies RunTerminalPayload,
        })
      }
    }
  }

  return sink.snapshot()
}

function summarize(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 200)
  if (Array.isArray(content)) {
    const texts = content
      .map((c) =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
    if (texts.length > 0) return texts.join(' ').slice(0, 200)
  }
  return JSON.stringify(content).slice(0, 200)
}
