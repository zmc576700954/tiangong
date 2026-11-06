/**
 * D3：BackendDriver —— 对现有 12 个适配器的薄包装。
 *
 * 职责边界：
 * - 只读取适配器已有输出/新增的原始事件旁路，不改变旧路径行为；
 * - 三套归一化器分别处理 Claude / Codex / OpenCode；
 * - AgentOutput 仍由适配器原样广播（旧 UI 行为不变），Runtime 只多做一份事件落库。
 */

import type { AgentAdapter, AgentCommand, AgentOutput } from '@shared/types'
import type {
  BackendDriver,
  DriverCapabilities,
  DriverExecuteContext,
  DriverExecuteRequest,
  DriverExecuteResult,
  DriverUsage,
  NormalizedEventEnvelope,
} from '@shared/types/agent-runtime'
import type { AdapterRawEvent } from '@shared/types/agent'
import { isWriteScopedTool } from '../approval/gateway'
import type { BashPolicyDecision } from '../approval/bash-readonly'
import { bashPolicyForTool } from '../approval/bash-readonly'
import { getExecutorCapabilities } from '../capabilities'
import { normalizeClaude } from '../normalize/claude'
import { CodexStreamNormalizer } from '../normalize/codex'
import { normalizeOpenCode } from '../normalize/opencode'
import { CodexHealthChecker } from './codex-health'
import { hashArgs } from '../util'
import { waitForProcRegistryRecord } from '../../../shared/process-supervisor'

interface ClaudeApprovalCapable {
  setTurnApprovalHooks?: (
    sessionId: string,
    hooks: {
      canUseTool?: (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID: string },
      ) => Promise<{ behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }>
      onPreToolUse?: (toolName: string, toolInput: Record<string, unknown>, toolUseId?: string) => void | Promise<void>
      /** P3：Bash 只读白名单决策回调（审计 + 步骤状态） */
      onBashPolicy?: (decision: BashPolicyDecision, toolUseId?: string) => void | Promise<void>
    } | null,
  ) => void
}

export interface AdapterBackendDriverOptions {
  adapter: AgentAdapter
  executor: string
  codexHealthChecker?: CodexHealthChecker
  /** 测试/无 CLI 环境可关闭前置校验 */
  skipHealthCheck?: boolean
}

export class AdapterBackendDriver implements BackendDriver {
  readonly name: BackendDriver['name']
  readonly capabilities: DriverCapabilities
  private readonly adapter: AgentAdapter
  private readonly executor: string
  private readonly codexHealthChecker: CodexHealthChecker | undefined
  private readonly skipHealthCheck: boolean

  constructor(options: AdapterBackendDriverOptions) {
    this.adapter = options.adapter
    this.executor = options.executor
    this.capabilities = getExecutorCapabilities(options.executor)
    this.codexHealthChecker = options.codexHealthChecker
    this.skipHealthCheck = options.skipHealthCheck === true
    this.name = (['claude', 'codex', 'opencode'].includes(options.executor)
      ? options.executor
      : 'claude') as BackendDriver['name']
  }

  async execute(request: DriverExecuteRequest, context: DriverExecuteContext): Promise<DriverExecuteResult> {
    if (this.executor === 'codex' && !this.skipHealthCheck) {
      // C6：配置前置校验（不修改用户 config；失败给可读报错）
      await (this.codexHealthChecker ?? new CodexHealthChecker()).assertHealthy()
    }

    const rawEvents: AdapterRawEvent[] = []
    const outputs: AgentOutput[] = []
    let rawHandler: ((event: AdapterRawEvent) => void) | undefined
    let outputHandler: ((output: AgentOutput) => void) | undefined
    let spawnHandler: ((sessionId: string, proc: { pid: number; pgid?: number }) => void) | undefined
    let claudeHooksApplied = false

    try {
      if (this.adapter.onRawEvent) {
        rawHandler = (event) => {
          if (event.sessionId === request.agentSessionId) rawEvents.push(event)
        }
        this.adapter.onRawEvent(rawHandler)
      }
      outputHandler = (output) => {
        const sessionId = this.adapter.resolveOutputSession?.(output)
        if (sessionId === request.agentSessionId) outputs.push(output)
      }
      this.adapter.onOutput(outputHandler)

      // P0-1：只登记适配器自己真正 spawn 的句柄；回收时按登记杀自己的进程树
      if (this.adapter.onProcessSpawn) {
        spawnHandler = (sessionId, proc) => {
          if (sessionId === request.agentSessionId) {
            context.registerProcess({ pid: proc.pid, pgid: proc.pgid })
          }
        }
        this.adapter.onProcessSpawn(spawnHandler)
      }
      this.adapter.setEnvMarker?.(request.agentSessionId, context.envMarker)
      // P1-B：只有 Runtime/Kernel 路径需要流式原始事件；旧 AgentOutput 路径保持原语义。
      this.adapter.setRawStreamMode?.(request.agentSessionId, true)
      // D5：要求适配器用自有进程组拉起 CLI，并把真实 pid/pgid 报给 Runtime 落库。
      this.adapter.setProcessSupervision?.(request.agentSessionId, true)

      if (this.executor === 'claude-code' || this.executor === 'claude') {
        claudeHooksApplied = this.installClaudeApprovalHooks(request, context)
      }

      // D5：Codex 的真实 PID 由监督 shim 自注册得到；SDK 不暴露 pid，必须并发轮询。
      let finished = false
      const registryWatcher =
        this.executor === 'codex'
          ? waitForProcRegistryRecord(context.envMarker, 5000)
              .then((record) => {
                if (!record || finished) return
                context.registerProcess({
                  pid: record.pid,
                  pgid: record.pgid,
                  startedAt: record.startedAt,
                  startedAtHiRes: record.startedAtHiRes,
                  command: record.command,
                })
              })
              .catch(() => undefined)
          : undefined

      try {
        await this.adapter.sendCommand(request.agentSessionId, {
          type: (request.commandType as AgentCommand['type']) || 'implement',
          description: request.prompt,
          targetNodeId: request.nodeId,
        })
      } finally {
        finished = true
        // 轮询可能仍在等待；不等它，避免阻塞收尾（超时后自行退出）
        void registryWatcher
      }
    } finally {
      if (rawHandler && this.adapter.offRawEvent) this.adapter.offRawEvent(rawHandler)
      if (outputHandler) this.adapter.offOutput(outputHandler)
      if (spawnHandler && this.adapter.offProcessSpawn) this.adapter.offProcessSpawn(spawnHandler)
      this.adapter.setEnvMarker?.(request.agentSessionId, null)
      this.adapter.setRawStreamMode?.(request.agentSessionId, false)
      this.adapter.setProcessSupervision?.(request.agentSessionId, false)
      if (claudeHooksApplied) {
        ;(this.adapter as unknown as ClaudeApprovalCapable).setTurnApprovalHooks?.(request.agentSessionId, null)
      }
    }

    const meta = { runId: request.runId, turnId: request.turnId, sessionId: request.agentSessionId }
    let normalized: NormalizedEventEnvelope[] = []
    if (this.executor === 'claude-code' || this.executor === 'claude') {
      normalized = normalizeClaude(rawEvents.map((event) => event.payload), meta)
    } else if (this.executor === 'codex') {
      const normalizer = new CodexStreamNormalizer(meta)
      for (const event of rawEvents) normalizer.feed(event.payload as never)
      normalized = normalizer.finish()
    } else if (this.executor === 'opencode') {
      const text = rawEvents
        .map((event) => {
          const payload = event.payload as { kind?: string; text?: string }
          return payload.kind === 'stdout' ? payload.text ?? '' : ''
        })
        .join('')
      normalized = normalizeOpenCode(text, meta)
    } else {
      normalized = synthesizeFromOutputs(outputs, meta)
    }

    for (const event of normalized) {
      context.record([event])
    }

    const errorOutput = outputs.find((output) => output.type === 'error')
    const aborted = context.signal.aborted || errorOutput?.errorCode === 'AGENT_ABORTED'
    const failed = !aborted && (errorOutput !== undefined || !hasTerminalSuccess(normalized))
    const usage = extractUsage(rawEvents, this.executor)

    return {
      status: aborted ? 'cancelled' : failed ? 'failed' : 'completed',
      usage,
      errorCode: errorOutput?.errorCode,
      errorMessage: errorOutput?.data,
      completionSignal: this.capabilities.completion,
    }
  }

  async cancel(request: DriverExecuteRequest): Promise<void> {
    await this.adapter.terminateSession(request.agentSessionId, 'user')
  }

  private installClaudeApprovalHooks(request: DriverExecuteRequest, context: DriverExecuteContext): boolean {
    const capable = this.adapter as unknown as ClaudeApprovalCapable
    if (typeof capable.setTurnApprovalHooks !== 'function') return false

    // 序号由 Runtime.record 统一分配；这里只需保证 eventId 进程内唯一。
    let auditSeq = 0
    const emitAudit = (
      type: 'approval.required' | 'approval.resolved' | 'bash.policy',
      payload: Record<string, unknown>,
      stepId: string | undefined,
    ) => {
      auditSeq += 1
      context.record([
        {
          eventId: `evt_${request.turnId}_${type.replace(/\./g, '_')}_${auditSeq}`,
          runId: request.runId,
          turnId: request.turnId,
          seq: 0,
          type,
          source: 'kernel',
          fidelity: 'token',
          payloadVersion: 1,
          payload,
          timestamp: Date.now(),
          ...(stepId ? { stepId } : {}),
        },
      ])
    }

    capable.setTurnApprovalHooks(request.agentSessionId, {
      canUseTool: async (toolName, input, options) => {
        const stepId = `step-${options.toolUseID}`
        // Bash 的 step argsHash 与 bash.policy 事件保持同一份输入（只有 command），
        // 避免 description/timeout 等附带字段导致同一条命令出现两个 hash，审计无法对齐。
        const policy = bashPolicyForTool(toolName, input)
        const stepArgs = policy ? { command: policy.command } : input
        context.step.ensure(stepId, {
          kind: 'tool',
          toolName,
          argsHash: hashArgs(toolName, stepArgs),
          fidelity: 'token',
          status: 'awaiting_approval',
        })
        // 命中会话级授权时不产生 approval.required：语义上本次并不需要用户再决定。
        const peeked = context.approvals.peek?.({ toolName, args: input, stepId, cwd: request.workingDirectory })
        if (!peeked) {
          emitAudit(
            'approval.required',
            {
              toolName,
              input,
              // 审批卡片必须说明「命中的是哪条危险规则」，而不是只写「高风险」。
              ...(policy ? { policyRule: policy.rule, policyReason: policy.reason, risk: policy.risk } : {}),
            },
            stepId,
          )
        }
        const outcome = await context.approvals.request({
          toolName,
          args: input,
          stepId,
          mode: 'interactive',
          cwd: request.workingDirectory,
        })
        emitAudit(
          'approval.resolved',
          {
            approvalId: outcome.approvalId,
            decision: outcome.decision,
            decidedBy: outcome.decidedBy,
            ...(outcome.sessionGranted ? { scope: 'session' } : {}),
            ...(outcome.grantSourceApprovalId
              ? { grantSourceApprovalId: outcome.grantSourceApprovalId, autoGranted: outcome.autoGranted === true }
              : {}),
          },
          stepId,
        )
        if (outcome.decision === 'deny') {
          context.step.update(stepId, 'denied')
          return { behavior: 'deny', message: `Tool ${toolName} denied by ${outcome.decidedBy}` }
        }
        context.step.update(stepId, 'approved', { approvedAt: Date.now() })
        return { behavior: 'allow', updatedInput: input }
      },
      onPreToolUse: (toolName, toolInput, toolUseId) => {
        if (!toolUseId) return
        const stepId = `step-${toolUseId}`
        // 写类工具被 PreToolUse 强制 'ask' 后，真正的放行要等 canUseTool/网关决定：
        // 此处不能提前标记 approved/running，否则审计会出现「批准时间早于用户决定」。
        const waitsForDecision = isWriteScopedTool(toolName)
        context.step.ensure(stepId, {
          kind: 'tool',
          toolName,
          argsHash: hashArgs(toolName, toolInput),
          fidelity: 'token',
          status: waitsForDecision ? 'awaiting_approval' : 'approved',
        })
        if (!waitsForDecision) {
          // executing_at 写在工具真正执行之前（三阶段审计）
          context.step.update(stepId, 'running', { executingAt: Date.now() })
        }
      },
      onBashPolicy: (decision, toolUseId) => {
        const stepId = toolUseId ? `step-${toolUseId}` : undefined
        if (stepId) {
          // 两档语义：allow 免弹直接执行；ask 由 canUseTool/网关决定；
          // blocked-empty 是唯一例外（空命令），没有内容可审批，直接终态为 denied。
          const status =
            decision.decision === 'allow'
              ? 'approved'
              : decision.decision === 'blocked-empty'
                ? 'denied'
                : 'awaiting_approval'
          context.step.ensure(stepId, {
            kind: 'tool',
            toolName: 'Bash',
            argsHash: hashArgs('Bash', { command: decision.command }),
            fidelity: 'token',
            status,
          })
          if (decision.decision === 'allow') {
            context.step.update(stepId, 'running', { executingAt: Date.now() })
          } else if (decision.decision === 'blocked-empty') {
            context.step.update(stepId, 'denied')
          }
        }
        // 审计：allow / ask / blocked-empty 都记完整命令、命中规则与风险等级，
        // 之后可由同一 stepId 关联到 approval.required / approval.resolved。
        emitAudit(
          'bash.policy',
          {
            command: decision.command,
            decision: decision.decision,
            rule: decision.rule,
            reason: decision.reason,
            risk: decision.risk,
          },
          stepId,
        )
      },
    })
    return true
  }
}

function hasTerminalSuccess(events: NormalizedEventEnvelope[]): boolean {
  return events.some((event) => event.type === 'run.completed')
}

function extractUsage(rawEvents: AdapterRawEvent[], executor: string): DriverUsage | undefined {
  if (executor === 'claude-code' || executor === 'claude') {
    const payloads = rawEvents.map((event) => event.payload as Record<string, unknown>)
    const result = payloads
      .filter((payload) => payload.type === 'result' && payload.usage)
      .pop() as
      | {
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        }
      | undefined
    if (result?.usage) {
      // 计价维度：result 消息不带 model，从最近的 assistant 消息取（缺省则缺价 → NULL）
      const assistant = payloads
        .filter((payload) => payload.type === 'assistant')
        .pop() as { message?: { model?: unknown } } | undefined
      const model = typeof assistant?.message?.model === 'string' ? assistant.message.model : undefined
      return {
        inputTokens: result.usage.input_tokens ?? 0,
        outputTokens: result.usage.output_tokens ?? 0,
        cachedInputTokens: result.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: result.usage.cache_creation_input_tokens ?? 0,
        model,
        isEstimate: false,
        source: 'provider',
      }
    }
    return undefined
  }
  if (executor === 'codex') {
    const completed = rawEvents
      .map((event) => event.payload as { type?: string; usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } })
      .filter((payload) => payload.type === 'turn.completed' && payload.usage)
      .pop()
    if (completed?.usage) {
      return {
        inputTokens: completed.usage.input_tokens ?? 0,
        outputTokens: completed.usage.output_tokens ?? 0,
        cachedInputTokens: completed.usage.cached_input_tokens ?? 0,
        isEstimate: false,
        source: 'provider',
      }
    }
    return undefined
  }
  return undefined
}

/** 长尾适配器：不解析工具事件，只把 stdout/error 映射为最小 turn 级事件。 */
function synthesizeFromOutputs(
  outputs: AgentOutput[],
  meta: { runId: string; turnId: string; sessionId: string },
): NormalizedEventEnvelope[] {
  const events: NormalizedEventEnvelope[] = []
  let seq = 0
  let lastText = ''
  for (const output of outputs) {
    if (output.type === 'stdout' && output.data.trim()) {
      lastText = output.data
      seq += 1
      events.push({
        eventId: `evt_${meta.turnId}_${seq}`,
        runId: meta.runId,
        turnId: meta.turnId,
        seq,
        type: seq === 1 ? 'message.completed' : 'message.delta',
        source: 'backend',
        fidelity: 'session',
        payloadVersion: 1,
        payload: { role: 'assistant', text: output.data, mode: 'block' },
        timestamp: output.timestamp,
      })
    } else if (output.type === 'file_change_evidence' && output.fileChangeEvidence) {
      // M1 ②：合成证据走独立事件类型，绝不伪装成 tool.* 事件
      seq += 1
      events.push({
        eventId: `evt_${meta.turnId}_${seq}`,
        runId: meta.runId,
        turnId: meta.turnId,
        seq,
        type: 'evidence.file_change',
        source: 'synthetic',
        fidelity: 'turn',
        payloadVersion: 1,
        payload: {
          ...output.fileChangeEvidence,
          origin: 'workspace-diff',
          proves: 'files_changed_not_tool',
        },
        timestamp: output.timestamp,
      })
    }
  }
  const hasError = outputs.some((output) => output.type === 'error')
  seq += 1
  events.push({
    eventId: `evt_${meta.turnId}_${seq}`,
    runId: meta.runId,
    turnId: meta.turnId,
    seq,
    type: hasError ? 'run.failed' : 'run.completed',
    source: 'kernel',
    fidelity: 'session',
    payloadVersion: 1,
    payload: { status: hasError ? 'failed' : 'completed', summary: lastText || 'done' },
    timestamp: outputs[outputs.length - 1]?.timestamp ?? Date.now(),
  })
  return events
}
