import { EventSink } from '../normalizer/sink'
import type { AgentEventEnvelope, MessagePayload, NormalizeMeta, RunTerminalPayload } from '../types'
import type { ToolRuntime } from './tool-runtime'

export interface HostOwnedOptions {
  runId: string
  turnId: string
  backendSessionId?: string
  /** 第一段模型输出（可能含 <tool_call>）与工具结果回填后的第二段输出 */
  firstText: string
  finalText: string
  runtime: ToolRuntime
  requireApproval?: boolean
  /** 返回 allow/deny；由测试或 Kernel 审批网关驱动 */
  waitForApproval?: () => Promise<'allow' | 'deny'>
  onApprovalRequired?: (info: { toolCallId: string; toolName: string; input: unknown }) => void
}

/**
 * host-owned 循环：Kernel 解析模型文本 → 执行工具 → 把 tool_result 回填 → 继续下一轮。
 * 事件保真度只能是 session（OpenCode/CLI），工具事件 source=kernel。
 * 该生成器逐步 yield，便于测试在审批阻塞时观察状态机。
 */
export async function* hostOwnedEvents(
  opts: HostOwnedOptions,
): AsyncGenerator<AgentEventEnvelope> {
  const meta: NormalizeMeta = { runId: opts.runId, turnId: opts.turnId }
  const sink = new EventSink(meta)
  const backendName = 'opencode'
  const fidelity = 'session' as const

  const started = sink.emit({
    type: 'run.started',
    fidelity,
    source: 'synthetic',
    backendName,
    backendSessionId: opts.backendSessionId,
    nativeType: 'kernel:host-loop',
    payload: { attempt: 1, resumeMode: 'fresh' },
  })
  if (started) yield started

  const completedMessage = sink.emit({
    type: 'message.completed',
    fidelity,
    source: 'backend',
    backendName,
    nativeType: 'model/text',
    payload: { role: 'assistant', text: stripToolCall(opts.firstText), mode: 'block' } satisfies MessagePayload,
  })
  if (completedMessage) yield completedMessage

  const call = opts.runtime.parse(opts.firstText)
  if (!call) {
    const terminal = sink.emit({
      type: 'run.completed',
      fidelity,
      source: 'backend',
      backendName,
      nativeType: 'kernel:no-tool-call',
      payload: { status: 'completed', summary: opts.finalText } satisfies RunTerminalPayload,
    })
    if (terminal) yield terminal
    return
  }

  const stepId = 'step-host-1'
  const toolCallId = 'call-host-1'

  const requested = sink.emit({
    type: 'tool.requested',
    fidelity,
    source: 'kernel',
    backendName,
    nativeType: 'kernel:tool-requested',
    stepId,
    payload: {
      toolCallId,
      toolName: call.tool,
      input: call.input,
      risk: 'medium',
      blocking: true,
    },
  })
  if (requested) yield requested

  if (opts.requireApproval) {
    opts.onApprovalRequired?.({ toolCallId, toolName: call.tool, input: call.input })
    const approval = sink.emit({
      type: 'tool.approval_required',
      fidelity,
      source: 'kernel',
      backendName,
      nativeType: 'kernel:approval-required',
      stepId,
      payload: {
        approvalId: `approval-${opts.runId}-1`,
        toolCallId,
        toolName: call.tool,
        input: call.input,
        risk: 'medium',
        blocking: true,
        expiresAt: Date.now() + 60_000,
      },
    })
    if (approval) yield approval

    const decision = await (opts.waitForApproval?.() ?? Promise.resolve('deny' as const))
    const resolved = sink.emit({
      type: decision === 'allow' ? 'tool.approved' : 'tool.denied',
      fidelity,
      source: 'kernel',
      backendName,
      nativeType: 'kernel:approval-resolved',
      stepId,
      payload: { approvalId: `approval-${opts.runId}-1`, decision, resolvedBy: 'user' },
    })
    if (resolved) yield resolved
    if (decision !== 'allow') {
      const terminal = sink.emit({
        type: 'run.completed',
        fidelity,
        source: 'kernel',
        backendName,
        nativeType: 'kernel:denied',
        payload: { status: 'completed', summary: 'tool denied; no execution' } satisfies RunTerminalPayload,
      })
      if (terminal) yield terminal
      return
    }
  }

  const result = await opts.runtime.execute(call)
  const toolResult = sink.emit({
    type: 'tool.result',
    fidelity,
    source: 'kernel',
    backendName,
    nativeType: 'kernel:tool-result',
    stepId,
    payload: { ...result, toolCallId },
  })
  if (toolResult) yield toolResult

  // 把 tool_result 回填给模型，产生最终文本
  const finalDelta = sink.emit({
    type: 'message.delta',
    fidelity,
    source: 'backend',
    backendName,
    nativeType: 'model/text',
    payload: { role: 'assistant', text: opts.finalText, mode: 'block' } satisfies MessagePayload,
  })
  if (finalDelta) yield finalDelta

  const terminal = sink.emit({
    type: 'run.completed',
    fidelity,
    source: 'backend',
    backendName,
    nativeType: 'kernel:host-loop:end',
    payload: { status: 'completed', summary: opts.finalText } satisfies RunTerminalPayload,
  })
  if (terminal) yield terminal
}

function stripToolCall(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/, '').trim()
}
