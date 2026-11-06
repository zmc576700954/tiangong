/**
 * Claude 逐消息归一化（V1 基线移植）。
 *
 * - fidelity: token（assistant text / tool_use 都是逐块到达）
 * - run.started 来自 system:init
 * - tool_use/tool_result 一比一映射，与审批步骤共用 `step-${toolUseID}`
 */

import type { NormalizedEventEnvelope } from '@shared/types/agent-runtime'
import { EventSink, type NormalizeMeta } from './sink'

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
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

export function normalizeClaude(raws: unknown[], meta: NormalizeMeta): NormalizedEventEnvelope[] {
  const sink = new EventSink(meta)
  let messageCompleted = false
  let finalText = ''

  for (const raw of raws) {
    const msg = raw as ClaudeMessage

    if (msg.type === 'system' && msg.subtype === 'init') {
      sink.emit({
        type: 'run.started',
        fidelity: 'token',
        source: 'backend',
        payload: { attempt: 1, resumeMode: 'fresh', backendSessionId: msg.session_id },
      })
      continue
    }

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          finalText = block.text
          if (!messageCompleted) {
            // 首块只发 completed：同时发 delta + completed 会让消费端把同一段文本计两次
            sink.emit({
              type: 'message.completed',
              fidelity: 'token',
              source: 'backend',
              payload: { role: 'assistant', text: block.text, mode: 'block' },
            })
            messageCompleted = true
          } else {
            sink.emit({
              type: 'message.delta',
              fidelity: 'token',
              source: 'backend',
              payload: { role: 'assistant', text: block.text, mode: 'block' },
            })
          }
        } else if (block.type === 'thinking' && block.thinking) {
          sink.emit({
            type: 'reasoning.delta',
            fidelity: 'token',
            source: 'backend',
            payload: { text: block.thinking },
          })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          const args = block.input as Record<string, unknown> | undefined
          const affectedPath = typeof args?.file_path === 'string' ? args.file_path : undefined
          sink.emit({
            type: 'tool.requested',
            fidelity: 'token',
            source: 'backend',
            stepId: `step-${block.id}`,
            payload: {
              toolCallId: block.id,
              toolName: block.name,
              input: block.input,
              risk: affectedPath ? 'medium' : 'low',
              blocking: true,
            },
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
            stepId: `step-${block.tool_use_id}`,
            payload: {
              toolCallId: block.tool_use_id,
              ok: block.is_error !== true,
              output: summarize(block.content),
            },
          })
        }
      }
      continue
    }

    if (msg.type === 'result') {
      const usage = msg.usage
        ? { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 }
        : undefined
      if (usage) {
        sink.emit({
          type: 'usage.updated',
          fidelity: 'token',
          source: 'backend',
          payload: usage,
        })
      }
      if (msg.is_error) {
        sink.emit({
          type: 'run.failed',
          fidelity: 'token',
          source: 'backend',
          payload: {
            status: 'failed',
            summary: msg.result ?? 'claude error',
            failure: { class: 'permanent', code: 'CLAUDE_ERROR', message: msg.result ?? 'unknown' },
          },
        })
      } else {
        sink.emit({
          type: 'run.completed',
          fidelity: 'token',
          source: 'backend',
          payload: {
            status: 'completed',
            summary: finalText || msg.result || 'done',
            usage,
          },
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
      .map((item) =>
        typeof item === 'object' && item !== null && 'text' in item
          ? String((item as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
    if (texts.length > 0) return texts.join(' ').slice(0, 200)
  }
  return JSON.stringify(content).slice(0, 200)
}
