/**
 * OpenCode 归一化。两个入口，按「CLI 到底吐了什么」分流：
 *
 * 1. `normalizeOpenCodeStream`（v3.30 新增，**默认路径**）
 *    `opencode run --format json` 的 JSONL 事件流。真实 CLI 1.19.x 只认这个：
 *    每条 `tool_use` 带 `part.state.{status,input,output,error}`，`step_finish`
 *    带真实 token 与 cost。工具轨迹来自 CLI 自己，不是从人读文本里猜的。
 *
 * 2. `normalizeOpenCode`（V1 基线，**仅作回退**）
 *    解析 `[tool] name {json}` 这类文本行。这条协议**真实 CLI 从不输出**，
 *    是早期基线自己对 stdout 的假设；保留只为兼容旧夹具与降级路径，
 *    不要再用它判断「有没有轨迹」。
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

// ============================================================
// 结构化流（`opencode run --format json`）
// ============================================================

/**
 * CLI 一行 JSON 的形状。字段名照抄实机输出（1.19.5），不做猜测：
 *
 * ```json
 * {"type":"tool_use","part":{"type":"tool","tool":"write","callID":"…",
 *   "state":{"status":"completed","input":{…},"output":"…","error":"…"}}}
 * ```
 *
 * 事件类型只有 `step_start` / `text` / `tool_use` / `step_finish` / `error`
 * 这几种（见 v3.30 实机抓包），未知类型静默忽略 —— CLI 加字段不该让回合失败。
 */
export interface OpenCodeEvent {
  type?: string
  sessionID?: string
  timestamp?: number
  part?: OpenCodePart
  /**
   * 实机形状（1.19.5）不是 `{message}`，而是被包了一层：
   *
   * ```json
   * {"name":"UnknownError","data":{"message":"Unexpected server error…","ref":"err_…"}}
   * ```
   *
   * 只认 `message` 会把这唯一一句原因丢掉，界面就只能显示「exit code 1」。
   * `ref` 是官方要你拿去查 server 日志的凭据，也一并保留。
   */
  error?: { name?: string; message?: string; data?: { message?: string; ref?: string } } | string
}

interface OpenCodePart {
  id?: string
  type?: string
  text?: string
  /** 实机字段：同一条消息的多个 part 共享它，这里只做形状记录 */
  messageID?: string
  sessionID?: string
  tool?: string
  callID?: string
  reason?: string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; total?: number }
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    error?: unknown
    title?: string
    metadata?: Record<string, unknown>
  }
}

/** 写类工具要给 runtime 一个不高于 medium 的风险档，读类给 low。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch'])
const EXEC_TOOLS = new Set(['bash', 'shell', 'terminal'])

/**
 * 一条轨迹对应一个 step：`tool.requested` 与 `tool.result` 必须共用 stepId，
 * 否则 runtime 里工具检查点会对不上（approval / 审计都按 stepId 归并）。
 */
export class OpenCodeStreamNormalizer {
  private readonly sink: EventSink
  /** callID → 已开过的 step；重复上报同一 callID 时不重复开 step */
  private readonly steps = new Map<string, string>()
  /** 已进入终态（result/failed）的 callID，防止 state 更新刷出第二条结果 */
  private readonly settled = new Set<string>()
  private started = false
  private failed = false
  /** CLI 给出的最后一条错误文本（含 ref），`run.failed` 的 summary 直接用它 */
  private lastError: string | undefined
  private messageCount = 0
  private lastText = ''
  private inputTokens = 0
  private outputTokens = 0
  private cost = 0

  constructor(meta: NormalizeMeta) {
    this.sink = new EventSink(meta)
  }

  feed(event: OpenCodeEvent): void {
    if (!event || typeof event !== 'object') return
    this.ensureStarted()

    switch (event.type) {
      case 'text':
        this.onText(event.part)
        break
      case 'tool_use':
        this.onTool(event.part)
        break
      case 'step_finish':
        this.onStepFinish(event.part)
        break
      case 'error':
        this.failed = true
        this.lastError = errorTextOf(event.error) ?? 'opencode 报告了一个错误'
        this.sink.emit({
          type: 'error',
          fidelity: 'turn',
          source: 'backend',
          payload: { message: this.lastError },
        })
        break
      default:
        // step_start 与未知类型：起始事件已在 ensureStarted 里补过
        break
    }
  }

  /**
   * 进程退出后调用。
   *
   * 只有 `exitCode === 0` 才算跑完。`null` 表示被信号杀掉（超时/取消/崩溃），
   * 同一时刻还没有任何 `error` 事件 —— 这种情况**不能**读成成功，
   * 否则界面会把一个被杀掉的回合显示为「已完成」。
   */
  finish(exitCode: number | null = 0): NormalizedEventEnvelope[] {
    this.ensureStarted()

    const usage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    }

    if (this.failed || exitCode !== 0) {
      // 原因必须进 summary：CLI 的 `error` 事件与退出码是两条独立信息，
      // 只报「exit code 1」会让用户对着一个能自解释的错误（模型名不存在、
      // 凭据无效）无从下手，也和之前 Codex「假成功」是同一类信息丢失。
      const summary = this.lastError ?? `opencode exited with code ${exitCode ?? 'unknown'}`
      this.sink.emit({ type: 'usage.updated', fidelity: 'turn', source: 'backend', payload: usage })
      this.sink.emit({
        type: 'run.failed',
        fidelity: 'turn',
        source: 'backend',
        payload: {
          status: 'failed',
          summary,
          failure: {
            class: 'permanent',
            code: 'OPENCODE_RUN_FAILED',
            ...(this.lastError ? { message: this.lastError } : {}),
          },
          usage,
        },
      })
      return this.sink.snapshot()
    }

    this.sink.emit({ type: 'usage.updated', fidelity: 'turn', source: 'backend', payload: usage })
    this.sink.emit({
      type: 'run.completed',
      fidelity: 'turn',
      source: 'backend',
      payload: { status: 'completed', summary: this.lastText || 'done', usage },
    })
    return this.sink.snapshot()
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    this.sink.emit({
      type: 'run.started',
      fidelity: 'turn',
      source: 'backend',
      payload: { attempt: 1, resumeMode: 'fresh' },
    })
    this.sink.emit({ type: 'turn.started', fidelity: 'turn', source: 'backend', payload: {} })
  }

  private onText(part: OpenCodePart | undefined): void {
    const text = part?.text
    if (!text) return
    this.lastText = text
    this.sink.emit({
      type: this.messageCount === 0 ? 'message.completed' : 'message.delta',
      fidelity: 'turn',
      source: 'backend',
      payload: { role: 'assistant', text, mode: 'block' },
    })
    this.messageCount += 1
  }

  private onTool(part: OpenCodePart | undefined): void {
    if (!part) return
    const callId = part.callID ?? part.id
    if (!callId) return

    const name = part.tool ?? 'unknown'
    const state = part.state ?? {}
    const stepId = this.ensureStep(callId, name, state.input)

    if (this.settled.has(callId)) return

    const status = state.status ?? 'completed'
    if (status === 'pending') {
      // 无头 run 模式下 CLI 会直接 auto-reject（stderr 有 `auto-rejecting`），
      // 这里的 pending 只在有交互通道时出现；如实标记，不假装已执行。
      this.sink.emit({
        type: 'approval.required',
        fidelity: 'turn',
        source: 'backend',
        stepId,
        payload: { toolCallId: callId, toolName: name, input: state.input ?? {} },
      })
      return
    }

    if (status === 'running') {
      this.sink.emit({
        type: 'tool.executing',
        fidelity: 'turn',
        source: 'backend',
        stepId,
        payload: { toolCallId: callId, toolName: name },
      })
      return
    }

    this.settled.add(callId)
    if (status === 'error') {
      this.sink.emit({
        type: 'tool.failed',
        fidelity: 'turn',
        source: 'synthetic',
        stepId,
        payload: {
          toolCallId: callId,
          toolName: name,
          ok: false,
          output: errorTextOf(state.error) ?? 'opencode 工具调用失败（未给出原因）',
        },
      })
      return
    }

    this.sink.emit({
      type: 'tool.result',
      fidelity: 'turn',
      source: 'synthetic',
      stepId,
      payload: {
        toolCallId: callId,
        toolName: name,
        ok: true,
        output: outputText(state.output),
      },
    })

    // 写类工具补一条 file.change：界面与证据链都靠它显示「改了哪个文件」。
    if (WRITE_TOOLS.has(name)) {
      const filePath = pickPath(state.input)
      if (filePath) {
        this.sink.emit({
          type: 'file.change',
          fidelity: 'turn',
          source: 'synthetic',
          stepId,
          payload: { path: filePath, changeType: 'modify', diffUnavailable: true },
        })
      }
    }
  }

  private ensureStep(callId: string, name: string, input: unknown): string {
    const existing = this.steps.get(callId)
    if (existing) return existing

    const stepId = `step-oc-${this.steps.size + 1}`
    this.steps.set(callId, stepId)
    this.sink.emit({
      type: 'tool.requested',
      fidelity: 'turn',
      source: 'synthetic',
      stepId,
      payload: {
        toolCallId: callId,
        toolName: name,
        input: (input ?? {}) as Record<string, unknown>,
        risk: WRITE_TOOLS.has(name) ? 'medium' : EXEC_TOOLS.has(name) ? 'high' : 'low',
        blocking: false,
        diffUnavailable: WRITE_TOOLS.has(name),
      },
    })
    return stepId
  }

  private onStepFinish(part: OpenCodePart | undefined): void {
    if (!part) return
    // 多步回合里 input 只在第一步是「提示词规模」，后续步的 input 是增量；
    // 累加 output、取首个非零 input，避免把缓存命中的重复计数读成真实增长。
    const input = part.tokens?.input ?? 0
    if (this.inputTokens === 0 && input > 0) this.inputTokens = input
    this.outputTokens += part.tokens?.output ?? 0
    this.cost += part.cost ?? 0
  }
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output == null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/**
 * 从错误体里取一句可读的话。
 *
 * 实机（1.19.5）把真原因放在 `data.message`，顶层只有 `name`；`data.ref`
 * 是官方让你去查 server 日志的定位串，丢了就等于没了排障入口，所以拼在括号里。
 * 导出给适配器用：`emitOutput` 的排障文本要和人看到的一致，不要各写一套。
 */
export function errorTextOf(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const record = error as { message?: unknown; name?: unknown; data?: { message?: unknown; ref?: unknown } }
    const inner = record.data
    const message =
      typeof inner?.message === 'string' && inner.message
        ? inner.message
        : typeof record.message === 'string' && record.message
          ? record.message
          : undefined
    const ref = typeof inner?.ref === 'string' && inner.ref ? inner.ref : undefined
    if (message) return ref ? `${message} (ref=${ref})` : message
    // 没有可读 message 时退回序列化整块，至少别把原因彻底吞掉
    try {
      return JSON.stringify(error)
    } catch {
      return typeof record.name === 'string' ? record.name : undefined
    }
  }
  return String(error)
}

/** `write` 的 `filePath`、`edit` 的 `filePath` / `path`，取到一个就够。 */
function pickPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of ['filePath', 'file_path', 'path', 'file']) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}
