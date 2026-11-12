/**
 * 真机：`serve` 路径的「问了再放行」是否真的放行。
 *
 * 默认 SKIP —— 需要本机装 opencode CLI 且能访问模型。打开方式：
 *
 *   BIZGRAPH_OPENCODE_REAL=1 npx vitest run src/main/adapters/__tests__/opencode-serve-real.test.ts
 *
 * 它验的不是协议胶水（那在 `opencode-serve.test.ts` 里用假进程覆盖），而是
 * **整条装配线**：适配器装钩子 → 起 serve → 权限事件 → 钩子决策 → 回写 →
 * 工具真的执行 → 事件被翻译成 run 方言 → 轨迹与 token 落到输出里。
 *
 * 这条用例存在的理由：G7-3 之前欠的正是这一环。`run` 模式里同样写「允许」的
 * 代码会通过所有单测，但工具根本不会执行 —— 只有真机能分辨「放行」和
 * 「被 CLI 自己拒掉」。
 */

import { describe, expect, it } from 'vitest'
import type { AdapterRawEvent, AgentCommand, AgentOutput, AgentSessionConfig } from '@shared/types'
import { OpenCodeAdapter } from '../opencode'

const REAL = process.env.BIZGRAPH_OPENCODE_REAL === '1'
const WORKDIR = process.env.BIZGRAPH_OPENCODE_WORKDIR ?? '/tmp'
const MODEL = process.env.BIZGRAPH_OPENCODE_MODEL ?? 'opencode/deepseek-v4.1-flash-free'
const MARKER = 'serve-gate-ok-7f1c'

type JsonEvent = { type?: string; part?: Record<string, unknown> }

/** 从 raw 事件里抽出 `kind=json` 的那批（适配器把 serve 事件翻译后就是这么发的）。 */
function rawJsonEvents(raws: AdapterRawEvent[]): JsonEvent[] {
  const events: JsonEvent[] = []
  for (const raw of raws) {
    const payload = raw.payload as { kind?: string; event?: JsonEvent }
    if (payload.kind === 'json' && payload.event) events.push(payload.event)
  }
  return events
}

function makeConfig(): AgentSessionConfig {
  return {
    workingDirectory: WORKDIR,
    nodeTitle: 'serve gate',
    acceptanceCriteria: [],
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    model: MODEL,
  }
}

const command: AgentCommand = {
  type: 'fix_bug',
  description: `Run exactly this bash command and report its output: echo ${MARKER}`,
  targetNodeId: 'n1',
}

describe.skipIf(!REAL)('OpenCode serve 真机（G7-3）', () => {
  it('钩子放行后，bash 工具真的执行了', async () => {
    const adapter = new OpenCodeAdapter()
    // 内联子代理工具不是本用例的对象；不给它会在 runToolAwareLoop 前就报错
    adapter.setSubagentManager({ invoke: async () => ({ resultText: '' }) } as never)

    const session = await adapter.startSession(makeConfig())
    const raws: AdapterRawEvent[] = []
    const outputs: AgentOutput[] = []
    adapter.onRawEvent((event) => raws.push(event))
    adapter.onOutput((output) => outputs.push(output))

    const asked: string[] = []
    adapter.setTurnApprovalHooks(session.id, {
      canUseTool: async (toolName, input) => {
        asked.push(`${toolName}:${JSON.stringify(input)}`)
        return { behavior: 'allow' }
      },
    })

    try {
      await adapter.sendCommand(session.id, command)
    } finally {
      adapter.setTurnApprovalHooks(session.id, null)
    }

    // 1) 宿主确实被问了，而且拿到的是可执行的具体命令（不是「bash」这个类别）
    expect(asked.some((entry) => entry.startsWith('bash:') && entry.includes('echo'))).toBe(true)

    const events = rawJsonEvents(raws)

    // 2) 轨迹来自 serve 的事件流，且工具是「成功」而不是被拒
    const toolResult = events.find((event) => event.type === 'tool_use' && (event.part?.state as { status?: string })?.status === 'completed')
    expect(toolResult, '没有拿到 completed 的 tool_use：工具要么没执行、要么被拒').toBeTruthy()
    const state = toolResult?.part?.state as { output?: unknown; input?: unknown }
    expect(JSON.stringify(state?.input)).toContain('echo')
    expect(String(state?.output)).toContain(MARKER)

    // 3) token 是真的（serve 流里没有 step_finish，从会话终态取）
    const stepFinish = events.find((event) => event.type === 'step_finish')
    const tokens = (stepFinish?.part as { tokens?: { input?: number; output?: number } })?.tokens
    expect(tokens?.input ?? 0).toBeGreaterThan(0)

    // 4) 没有任何「被拒」的痕迹（reject 会以 error 事件出现）
    expect(outputs.some((output) => output.type === 'error')).toBe(false)
  }, 240_000)

  it('钩子拒绝后，命令没有执行（不是「静默放行」）', async () => {
    const adapter = new OpenCodeAdapter()
    adapter.setSubagentManager({ invoke: async () => ({ resultText: '' }) } as never)

    const session = await adapter.startSession(makeConfig())
    const raws: AdapterRawEvent[] = []
    adapter.onRawEvent((event) => raws.push(event))

    const asked: string[] = []
    adapter.setTurnApprovalHooks(session.id, {
      canUseTool: async (toolName) => {
        asked.push(toolName)
        return { behavior: 'deny', message: '这条命令不在授权范围' }
      },
    })

    try {
      await adapter.sendCommand(session.id, command)
    } finally {
      adapter.setTurnApprovalHooks(session.id, null)
    }

    expect(asked).toContain('bash')
    const events = rawJsonEvents(raws)

    // 拒绝的语义：**bash** 没有一次成功。别的工具成功不算问题 —— 读文件在
    // 规则集里本来就是 allow，模型被拒后会退而求其次去读，这是正常行为。
    const completedBash = events.filter(
      (event) =>
        event.type === 'tool_use' &&
        (event.part as { tool?: string })?.tool === 'bash' &&
        (event.part?.state as { status?: string })?.status === 'completed',
    )
    expect(completedBash).toHaveLength(0)

    const errored = events.filter(
      (event) =>
        event.type === 'tool_use' &&
        (event.part as { tool?: string })?.tool === 'bash' &&
        (event.part?.state as { status?: string })?.status === 'error',
    )
    // 模型被拒之后可能再试一次，所以不写死条数；关键是没有一次成功
    expect(errored.length).toBeGreaterThanOrEqual(1)
    for (const event of errored) {
      const state = event.part?.state as { error?: string; output?: unknown }
      expect(state.error).toContain('这条命令不在授权范围')
      // 没有输出 = 命令确实没跑（有 output 就说明「拒了但还是执行了」）
      expect(state.output).toBeUndefined()
    }
  }, 240_000)
})
