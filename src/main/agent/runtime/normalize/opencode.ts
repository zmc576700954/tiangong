/**
 * OpenCode one-shot 归一化（V1 基线移植）。
 *
 * - fidelity: session（stdout 到进程退出才整体可读）
 * - [tool]/[tool-result] 只是人读轨迹 → source: synthetic
 * - 真实 CLI 不输出轨迹时，工具检查点不存在（不伪造）
 */

import type { NormalizedEventEnvelope } from '@shared/types/agent-runtime'
import { EventSink, type NormalizeMeta } from './sink'

interface ParsedLine {
  kind: 'text' | 'tool' | 'tool-result'
  body: string
}

function parseLines(stdout: string): ParsedLine[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith('[tool-result]')) return { kind: 'tool-result' as const, body: line.slice(13).trim() }
      if (line.startsWith('[tool]')) return { kind: 'tool' as const, body: line.slice(6).trim() }
      if (line.startsWith('[text]')) return { kind: 'text' as const, body: line.slice(6).trim() }
      return { kind: 'text' as const, body: line }
    })
}

export function normalizeOpenCode(stdout: string, meta: NormalizeMeta): NormalizedEventEnvelope[] {
  const sink = new EventSink(meta)
  const lines = parseLines(stdout)

  sink.emit({
    type: 'run.started',
    fidelity: 'session',
    source: 'synthetic',
    payload: { attempt: 1, resumeMode: 'fresh' },
  })

  let messageCompleted = false
  let trailingText = ''
  let toolIndex = 0
  let currentStepId: string | undefined
  let currentToolCallId: string | undefined

  for (const line of lines) {
    if (line.kind === 'text') {
      if (!messageCompleted) {
        sink.emit({
          type: 'message.completed',
          fidelity: 'session',
          source: 'backend',
          payload: { role: 'assistant', text: line.body, mode: 'block' },
        })
        messageCompleted = true
      } else {
        trailingText = line.body
        sink.emit({
          type: 'message.delta',
          fidelity: 'session',
          source: 'backend',
          payload: { role: 'assistant', text: line.body, mode: 'block' },
        })
      }
      continue
    }

    if (line.kind === 'tool') {
      toolIndex += 1
      const [toolName, jsonPart] = splitToolLine(line.body)
      currentStepId = `step-oc-${toolIndex}`
      currentToolCallId = `call-oc-${toolIndex}`
      let input: unknown = { raw: jsonPart }
      try {
        input = JSON.parse(jsonPart)
      } catch {
        // 保留 raw
      }
      sink.emit({
        type: 'tool.requested',
        fidelity: 'session',
        source: 'synthetic',
        stepId: currentStepId,
        payload: {
          toolCallId: currentToolCallId,
          toolName,
          input,
          risk: 'low',
          blocking: false,
        },
      })
      continue
    }

    if (line.kind === 'tool-result') {
      if (!currentStepId || !currentToolCallId) continue
      sink.emit({
        type: 'tool.result',
        fidelity: 'session',
        source: 'synthetic',
        stepId: currentStepId,
        payload: {
          toolCallId: currentToolCallId,
          ok: true,
          output: line.body.slice(0, 200),
        },
      })
      currentStepId = undefined
      currentToolCallId = undefined
    }
  }

  if (!messageCompleted) {
    sink.emit({
      type: 'message.completed',
      fidelity: 'session',
      source: 'backend',
      payload: { role: 'assistant', text: trailingText, mode: 'block' },
    })
  }

  const usage = {
    inputTokens: 0,
    outputTokens: Math.ceil(stdout.length / 4),
  }
  sink.emit({ type: 'usage.updated', fidelity: 'session', source: 'synthetic', payload: usage })
  sink.emit({
    type: 'run.completed',
    fidelity: 'session',
    source: 'backend',
    payload: { status: 'completed', summary: trailingText || 'done', usage },
  })

  return sink.snapshot()
}

function splitToolLine(body: string): [string, string] {
  const idx = body.indexOf(' ')
  if (idx === -1) return [body, '']
  return [body.slice(0, idx), body.slice(idx + 1).trim()]
}
