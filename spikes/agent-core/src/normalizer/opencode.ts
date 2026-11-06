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
      if (line.startsWith('[tool-result]'))
        return { kind: 'tool-result' as const, body: line.slice(13).trim() }
      if (line.startsWith('[tool]')) return { kind: 'tool' as const, body: line.slice(6).trim() }
      if (line.startsWith('[text]')) return { kind: 'text' as const, body: line.slice(6).trim() }
      return { kind: 'text' as const, body: line }
    })
}

/**
 * OpenCode one-shot：eventFidelity = session，loopOwnership = host。
 * stdout 到进程退出才整体可读；[tool]/[tool-result] 只是人读轨迹，
 * 工具事件必须标记 source: synthetic。真实 CLI 若不输出轨迹，工具检查点无法合成。
 */
export function normalizeOpenCode(stdout: string, meta: NormalizeMeta): AgentEventEnvelope[] {
  const sink = new EventSink(meta)
  const lines = parseLines(stdout)

  sink.emit({
    type: 'run.started',
    fidelity: 'session',
    source: 'synthetic',
    backendName: 'opencode',
    nativeType: 'spawn:start',
    payload: { attempt: 1, resumeMode: 'fresh' } satisfies RunStartedPayload,
  })

  let messageCompleted = false
  let trailingText = ''
  let toolIndex = 0
  let currentStepId: string | undefined
  let currentToolCallId: string | undefined
  let currentToolName: string | undefined

  for (const line of lines) {
    if (line.kind === 'text') {
      if (!messageCompleted) {
        sink.emit({
          type: 'message.completed',
          fidelity: 'session',
          source: 'backend',
          backendName: 'opencode',
          nativeType: 'stdout/text',
          payload: { role: 'assistant', text: line.body, mode: 'block' } satisfies MessagePayload,
        })
        messageCompleted = true
      } else {
        trailingText = line.body
        sink.emit({
          type: 'message.delta',
          fidelity: 'session',
          source: 'backend',
          backendName: 'opencode',
          nativeType: 'stdout/text',
          payload: { role: 'assistant', text: line.body, mode: 'block' } satisfies MessagePayload,
        })
      }
      continue
    }

    if (line.kind === 'tool') {
      toolIndex += 1
      const [toolName, jsonPart] = splitToolLine(line.body)
      currentStepId = `step-oc-${toolIndex}`
      currentToolCallId = `call-oc-${toolIndex}`
      currentToolName = toolName
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
        backendName: 'opencode',
        nativeType: 'stdout/tool-trace',
        stepId: currentStepId,
        payload: {
          toolCallId: currentToolCallId,
          toolName,
          input,
          risk: 'low',
          blocking: false,
        } satisfies ToolRequestedPayload,
      })
      continue
    }

    if (line.kind === 'tool-result') {
      if (!currentStepId || !currentToolCallId) continue
      sink.emit({
        type: 'tool.result',
        fidelity: 'session',
        source: 'synthetic',
        backendName: 'opencode',
        nativeType: 'stdout/tool-trace',
        stepId: currentStepId,
        payload: {
          toolCallId: currentToolCallId,
          ok: true,
          output: line.body.slice(0, 200),
        } satisfies ToolResultPayload,
      })
      currentStepId = undefined
      currentToolCallId = undefined
      currentToolName = undefined
    }
  }

  if (!messageCompleted) {
    // 降级路径：没有工具轨迹时至少保住 run.started → message.completed → run.completed
    sink.emit({
      type: 'message.completed',
      fidelity: 'session',
      source: 'backend',
      backendName: 'opencode',
      nativeType: 'stdout/text',
      payload: { role: 'assistant', text: trailingText, mode: 'block' } satisfies MessagePayload,
    })
  }

  const usage: UsagePayload = {
    inputTokens: 0,
    outputTokens: Math.ceil(stdout.length / 4),
  }
  sink.emit({
    type: 'usage.updated',
    fidelity: 'session',
    source: 'synthetic',
    backendName: 'opencode',
    nativeType: 'stdout/estimate',
    payload: usage,
  })

  sink.emit({
    type: 'run.completed',
    fidelity: 'session',
    source: 'backend',
    backendName: 'opencode',
    nativeType: 'spawn:end',
    payload: {
      status: 'completed',
      summary: trailingText || 'done',
      usage,
    } satisfies RunTerminalPayload,
  })

  return sink.snapshot()
}

function splitToolLine(body: string): [string, string] {
  const idx = body.indexOf(' ')
  if (idx === -1) return [body, '']
  return [body.slice(0, idx), body.slice(idx + 1).trim()]
}
