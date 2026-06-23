# CLI 适配器 Inline-Protocol 子智能体支持

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单次执行的 CLI 适配器（OpenCode）通过 prompt-based inline protocol 支持 `dispatch_subagent` 子智能体调用。

**Architecture:** 在 `BaseAdapter` 中实现通用的工具感知执行循环 `runToolAwareLoop`：向 LLM prompt 注入 `dispatch_subagent` 工具描述，解析 stdout 中的 `<tool_call>` 标记，调用 `SubagentManager.invoke()`，并将结果回注到下一轮 prompt 中重新 spawn CLI。OpenCodeAdapter 复用该循环。

**Tech Stack:** TypeScript, Node.js child_process, Vitest, Zod（schema 校验可选）

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/types/agent.ts` | 新增 `AdapterCapability.InlineTools` 枚举值 |
| `src/main/adapters/base.ts` | 新增 `buildSubagentToolPrompt`、`parseToolCalls`、`runToolAwareLoop` |
| `src/main/adapters/opencode.ts` | 改造 `doSendCommand` 使用 `runToolAwareLoop` |
| `src/main/adapters/registry.ts` | 为 OpenCode 注册 `InlineTools` capability |
| `src/main/adapters/__tests__/base-tool-loop.test.ts` | 测试通用 loop、解析、超时、失败降级 |
| `src/main/adapters/__tests__/opencode-subagent.test.ts` | 测试 OpenCode 完整子智能体派发流程 |

---

## Task 1: Add `AdapterCapability.InlineTools`

**Files:**
- Modify: `src/shared/types/agent.ts:493-505`

- [ ] **Step 1: Add enum value**

```typescript
export const AdapterCapability = {
  Resume: 'resume',
  Streaming: 'streaming',
  FileOps: 'fileOps',
  MultiTurn: 'multiTurn',
  ScopeGuard: 'scopeGuard',
  Tools: 'tools',
  NativeCompact: 'native-compact',
  LlmCompact: 'llm-compact',
  SummaryRewrite: 'summary-rewrite',
  SwarmCoordinator: 'swarm-coord',
} as const
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types/agent.ts
git commit -m "feat(adapter): add InlineTools capability enum"
```

---

## Task 2: Add `buildSubagentToolPrompt` to BaseAdapter

**Files:**
- Modify: `src/main/adapters/base.ts`

- [ ] **Step 1: Add method after `buildScopePromptForSession`**

```typescript
  /**
   * Phase 5: Build the inline tool prompt describing dispatch_subagent.
   * CLI adapters without native tool support inject this into their prompt.
   */
  protected buildSubagentToolPrompt(): string {
    const schema = DISPATCH_SUBAGENT_TOOL_SCHEMA.input_schema
    const required = schema.required ?? []
    const properties = schema.properties as Record<string, { type: string; description: string; enum?: string[]; items?: unknown }>

    const paramLines = Object.entries(properties).map(([name, def]) => {
      const isRequired = required.includes(name)
      const enumPart = def.enum ? ` (enum: ${def.enum.join(', ')})` : ''
      return `- ${name}${isRequired ? '' : ' (optional)'}: ${def.description}${enumPart}`
    })

    return [
      '## Available Tools',
      '',
      'You can call the following tool by emitting exactly one JSON object wrapped in `<tool_call>` and `</tool_call>` tags.',
      'After the tool executes, its result will be returned to you and you may continue thinking.',
      '',
      `Tool: ${DISPATCH_SUBAGENT_TOOL_NAME}`,
      `Description: ${DISPATCH_SUBAGENT_TOOL_SCHEMA.description}`,
      '',
      'Parameters:',
      ...paramLines,
      '',
      'Example call:',
      `<tool_call>{"tool": "${DISPATCH_SUBAGENT_TOOL_NAME}", "args": {"agent_type": "explore", "description": "Find usages", "prompt": "Find all usages of Foo in src/.", "allowed_files": ["src/foo.ts"]}}</tool_call>`,
      '',
    ].join('\n')
  }
```

- [ ] **Step 2: Run type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/adapters/base.ts
git commit -m "feat(adapter): buildSubagentToolPrompt for inline protocol"
```

---

## Task 3: Add `parseToolCalls` to BaseAdapter

**Files:**
- Modify: `src/main/adapters/base.ts`

- [ ] **Step 1: Add internal type and parser method**

```typescript
interface InlineToolCall {
  tool: string
  args: Record<string, unknown>
}

// Add near other constants in BaseAdapter
protected parseToolCalls(text: string): InlineToolCall[] {
  const calls: InlineToolCall[] = []
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1].trim()
    try {
      const parsed = JSON.parse(raw) as unknown
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).tool === 'string' &&
        typeof (parsed as Record<string, unknown>).args === 'object'
      ) {
        calls.push({
          tool: (parsed as Record<string, unknown>).tool as string,
          args: (parsed as Record<string, unknown>).args as Record<string, unknown>,
        })
      } else {
        this.logger.warn(`Invalid tool_call structure: ${raw}`)
      }
    } catch (err) {
      this.logger.warn(`Failed to parse tool_call JSON: ${raw}`, err)
    }
  }
  return calls
}
```

- [ ] **Step 2: Write the failing test**

Create `src/main/adapters/__tests__/base-tool-loop.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { BaseAdapter } from '../base'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'

class TestAdapter extends BaseAdapter {
  readonly name = 'test'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    return {
      id: 'test_session',
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }
  }

  protected async doSendCommand(): Promise<void> {}
}

describe('BaseAdapter parseToolCalls', () => {
  it('parses a single dispatch_subagent call', () => {
    const adapter = new TestAdapter()
    const text = `Some reasoning\n<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "Find usages", "prompt": "Find Foo"}}</tool_call>\nMore text`
    const calls = adapter['parseToolCalls'](text)
    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('dispatch_subagent')
    expect(calls[0].args.agent_type).toBe('explore')
  })

  it('returns empty array when no tool_call tags present', () => {
    const adapter = new TestAdapter()
    expect(adapter['parseToolCalls']('no calls here')).toEqual([])
  })

  it('ignores malformed JSON inside tags', () => {
    const adapter = new TestAdapter()
    const text = '<tool_call>not json</tool_call>'
    expect(adapter['parseToolCalls'](text)).toEqual([])
  })
})
```

- [ ] **Step 3: Run the failing test**

```bash
npx vitest run src/main/adapters/__tests__/base-tool-loop.test.ts
```

Expected: FAIL — `parseToolCalls` not yet implemented (or method does not exist).

- [ ] **Step 4: Run the passing test**

The method is already added in Step 1, so re-run:

```bash
npx vitest run src/main/adapters/__tests__/base-tool-loop.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/base.ts src/main/adapters/__tests__/base-tool-loop.test.ts
git commit -m "feat(adapter): parseToolCalls for inline protocol"
```

---

## Task 4: Add `runToolAwareLoop` to BaseAdapter

**Files:**
- Modify: `src/main/adapters/base.ts`

- [ ] **Step 1: Add constants and types**

```typescript
// Inside BaseAdapter class, near other constants
protected static readonly MAX_TOOL_ROUNDS = 5
protected static readonly TOOL_AWARE_LOOP_TIMEOUT_MS = 5 * 60 * 1000

interface InlineToolCall {
  tool: string
  args: Record<string, unknown>
}

type ToolHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; result: string }
```

- [ ] **Step 2: Add runToolAwareLoop method**

```typescript
  /**
   * Phase 5: Tool-aware execution loop for CLI adapters without native tool support.
   *
   * @param session - Active agent session
   * @param command - Original user command
   * @param spawnOnce - Function that runs the CLI once with the given full prompt and returns stdout
   */
  protected async runToolAwareLoop(
    session: AgentSession,
    command: AgentCommand,
    spawnOnce: (fullPrompt: string) => Promise<string>,
  ): Promise<void> {
    if (!this.subagentManager) {
      this.emitOutput({
        type: 'error',
        data: 'SubagentManager not injected; inline tool dispatch unavailable.',
        timestamp: Date.now(),
      })
      return
    }

    const history: ToolHistoryEntry[] = []
    const toolPrompt = this.buildSubagentToolPrompt()
    const basePrompt = `${this.buildScopePromptForSession(session)}\n${toolPrompt}\n${this.buildCommandPrompt(command)}`
    const startTime = Date.now()

    for (let round = 0; round < BaseAdapter.MAX_TOOL_ROUNDS; round++) {
      if (Date.now() - startTime > BaseAdapter.TOOL_AWARE_LOOP_TIMEOUT_MS) {
        this.emitOutput({
          type: 'error',
          data: `Inline tool loop timed out after ${BaseAdapter.TOOL_AWARE_LOOP_TIMEOUT_MS}ms`,
          timestamp: Date.now(),
        })
        return
      }

      const historyText = history.length > 0
        ? `\n## Tool Call History\n${history.map((h) => {
          if (h.role === 'assistant') return `Assistant: ${h.content}`
          return `Result of ${h.tool}:\n${h.result}`
        }).join('\n\n')}\n`
        : ''

      const fullPrompt = `${basePrompt}${historyText}\nPlease continue.`
      const stdout = await spawnOnce(fullPrompt)

      const calls = this.parseToolCalls(stdout)
      if (calls.length === 0) {
        this.emitOutput({ type: 'stdout', data: stdout, timestamp: Date.now() })
        this.emitOutput({ type: 'complete', data: 'OpenCode session completed', timestamp: Date.now() })
        return
      }

      this.emitOutput({ type: 'stdout', data: stdout, timestamp: Date.now() })
      history.push({ role: 'assistant', content: stdout })

      const results = await Promise.all(
        calls.map(async (call) => {
          if (call.tool !== DISPATCH_SUBAGENT_TOOL_NAME) {
            return { tool: call.tool, result: `Unknown tool: ${call.tool}` }
          }
          try {
            const args = call.args
            const result = await this.subagentManager!.invoke({
              parentSessionId: session.id,
              agentType: String(args.agent_type ?? ''),
              description: String(args.description ?? ''),
              prompt: String(args.prompt ?? ''),
              adapterName: args.adapter_name ? String(args.adapter_name) : undefined,
              nodeId: args.node_id ? String(args.node_id) : undefined,
              allowedFiles: Array.isArray(args.allowed_files) ? (args.allowed_files as string[]) : undefined,
            })
            return { tool: call.tool, result: result.resultText }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return { tool: call.tool, result: `Subagent failed: ${msg}` }
          }
        }),
      )

      for (const r of results) {
        history.push({ role: 'tool', tool: r.tool, result: r.result })
      }
    }

    this.emitOutput({
      type: 'error',
      data: `Inline tool loop reached max rounds (${BaseAdapter.MAX_TOOL_ROUNDS})`,
      timestamp: Date.now(),
    })
  }
```

- [ ] **Step 3: Add tests for runToolAwareLoop**

Append to `src/main/adapters/__tests__/base-tool-loop.test.ts`:

```typescript
describe('BaseAdapter runToolAwareLoop', () => {
  it('emits stdout and completes when no tool calls', async () => {
    const adapter = new TestAdapter()
    adapter['subagentManager'] = { invoke: vi.fn() } as unknown as import('../../agent/subagent-manager').SubagentManager

    const outputs: import('@shared/types').AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    await adapter['runToolAwareLoop'](
      { id: 's1', adapterName: 'test', config: { workingDirectory: '/tmp', allowedFiles: [], forbiddenFiles: [], invariantRules: [], upstreamContext: '', downstreamContext: '', nodeTitle: '', acceptanceCriteria: [] }, startTime: Date.now() },
      { type: 'implement', description: 'Do it', targetNodeId: 'n1' },
      async () => 'plain result',
    )

    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'plain result')).toBe(true)
    expect(outputs.some((o) => o.type === 'complete')).toBe(true)
  })

  it('invokes subagent and re-spawns with result', async () => {
    const adapter = new TestAdapter()
    const invoke = vi.fn().mockResolvedValue({ resultText: 'subagent done' })
    adapter['subagentManager'] = { invoke } as unknown as import('../../agent/subagent-manager').SubagentManager

    const outputs: import('@shared/types').AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    let secondCall = false
    await adapter['runToolAwareLoop'](
      { id: 's1', adapterName: 'test', config: { workingDirectory: '/tmp', allowedFiles: [], forbiddenFiles: [], invariantRules: [], upstreamContext: '', downstreamContext: '', nodeTitle: '', acceptanceCriteria: [] }, startTime: Date.now() },
      { type: 'implement', description: 'Do it', targetNodeId: 'n1' },
      async (prompt) => {
        if (secondCall) {
          expect(prompt).toContain('subagent done')
          return 'final result'
        }
        secondCall = true
        return '<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "x", "prompt": "y"}}</tool_call>'
      },
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'final result')).toBe(true)
    expect(outputs.some((o) => o.type === 'complete')).toBe(true)
  })

  it('stops at max rounds', async () => {
    const adapter = new TestAdapter()
    const invoke = vi.fn().mockResolvedValue({ resultText: 'again' })
    adapter['subagentManager'] = { invoke } as unknown as import('../../agent/subagent-manager').SubagentManager

    const outputs: import('@shared/types').AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    await adapter['runToolAwareLoop'](
      { id: 's1', adapterName: 'test', config: { workingDirectory: '/tmp', allowedFiles: [], forbiddenFiles: [], invariantRules: [], upstreamContext: '', downstreamContext: '', nodeTitle: '', acceptanceCriteria: [] }, startTime: Date.now() },
      { type: 'implement', description: 'Do it', targetNodeId: 'n1' },
      async () => '<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "x", "prompt": "y"}}</tool_call>',
    )

    expect(outputs.some((o) => o.type === 'error' && o.data.includes('max rounds'))).toBe(true)
  })
})
```

- [ ] **Step 4: Run the new tests**

```bash
npx vitest run src/main/adapters/__tests__/base-tool-loop.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/base.ts src/main/adapters/__tests__/base-tool-loop.test.ts
git commit -m "feat(adapter): runToolAwareLoop for inline protocol"
```

---

## Task 5: Update OpenCodeAdapter to Use `runToolAwareLoop`

**Files:**
- Modify: `src/main/adapters/opencode.ts`

- [ ] **Step 1: Replace doSendCommand implementation**

```typescript
  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const constraintSuffix = this.buildConstraintSuffix(session.config)

    await this.runToolAwareLoop(session, command, async (fullPrompt) => {
      const args: string[] = ['-q']

      const proc = spawn('opencode', args, {
        cwd: session.config.workingDirectory,
        env: this.buildSafeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      if (proc.stdin) {
        proc.stdin.on('error', (err) => {
          this.logger.warn(`stdin write error for session ${session.id}: ${err.message}`)
        })
      }

      const finalPrompt = constraintSuffix ? `${fullPrompt}\n${constraintSuffix}` : fullPrompt
      proc.stdin?.write(finalPrompt, (err) => {
        if (err) {
          this.logger.warn(`stdin write failed for session ${session.id}: ${err.message}`)
        }
      })
      proc.stdin?.end()

      this.processes.set(session.id, proc)

      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        proc.stdout?.on('data', (chunk) => chunks.push(chunk))
        proc.stderr?.on('data', (chunk) => {
          this.emitOutput({ type: 'stderr', data: chunk.toString('utf-8'), timestamp: Date.now() })
        })
        proc.on('error', reject)
        proc.on('exit', (code) => {
          if (code !== null && code !== 0) {
            this.logger.warn(`opencode exited with code ${code}`)
          }
          resolve(Buffer.concat(chunks).toString('utf-8'))
        })
      })
    })
  }
```

- [ ] **Step 2: Remove old buildConstraintSuffix dependency on explicit prompt building**

The old `doSendCommand` built `scopePrompt` and `commandPrompt` explicitly. Since `runToolAwareLoop` now builds the base prompt, `OpenCodeAdapter` only needs to append its custom `constraintSuffix`.

Keep `buildConstraintSuffix` as-is.

- [ ] **Step 3: Run type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/adapters/opencode.ts
git commit -m "feat(opencode): use runToolAwareLoop for inline subagent dispatch"
```

---

## Task 6: Register `Tools` Capability for OpenCode

**Files:**
- Modify: `src/main/adapters/registry.ts:115`

- [ ] **Step 1: Add capability**

```typescript
import { AdapterCapability } from '@shared/types'
// already imported

// In ADAPTER_REGISTRY opencode entry:
capabilities: [
  AdapterCapability.Streaming,
  AdapterCapability.FileOps,
  AdapterCapability.SummaryRewrite,
  AdapterCapability.Tools, // 新增：inline-protocol 子智能体工具
],
```

- [ ] **Step 2: Commit**

```bash
git add src/main/adapters/registry.ts
git commit -m "feat(registry): mark opencode as Tools capable via inline protocol"
```

---

## Task 7: Write OpenCode Subagent Integration Test

**Files:**
- Create: `src/main/adapters/__tests__/opencode-subagent.test.ts`

- [ ] **Step 1: Create test file**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenCodeAdapter } from '../opencode'
import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { AgentSessionConfig } from '@shared/types'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

function createMockProc(stdoutChunks: string[], stderrChunks: string[] = []): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess
  Object.assign(proc, {
    stdin: { write: vi.fn((data, cb) => cb?.()), end: vi.fn() },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    exitCode: null,
    pid: 1234,
  })

  setImmediate(() => {
    for (const chunk of stdoutChunks) (proc.stdout as EventEmitter).emit('data', Buffer.from(chunk))
    for (const chunk of stderrChunks) (proc.stderr as EventEmitter).emit('data', Buffer.from(chunk))
    proc.emit('exit', 0)
  })

  return proc
}

describe('OpenCodeAdapter inline subagent dispatch', () => {
  let adapter: OpenCodeAdapter

  beforeEach(() => {
    adapter = new OpenCodeAdapter()
    vi.mocked(spawn).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dispatches subagent when stdout contains tool_call', async () => {
    const invoke = vi.fn().mockResolvedValue({ resultText: 'exploration complete' })
    adapter.setSubagentManager({ invoke } as unknown as import('../../agent/subagent-manager').SubagentManager)

    const config: AgentSessionConfig = {
      workingDirectory: '/tmp',
      allowedFiles: ['src/foo.ts'],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test',
      acceptanceCriteria: [],
    }
    const session = await adapter.startSession(config)

    // First spawn emits tool call; second spawn returns final answer.
    let callCount = 0
    vi.mocked(spawn).mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return createMockProc([
          '<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "Find usages", "prompt": "Find Foo", "allowed_files": ["src/foo.ts"]}}</tool_call>',
        ])
      }
      return createMockProc(['final answer'])
    })

    const outputs: import('@shared/types').AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    await adapter.sendCommand(session.id, { type: 'implement', description: 'Find usages', targetNodeId: 'n1' })

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: session.id,
      agentType: 'explore',
      prompt: 'Find Foo',
      allowedFiles: ['src/foo.ts'],
    }))
    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'final answer')).toBe(true)
    expect(outputs.some((o) => o.type === 'complete')).toBe(true)
  })

  it('completes normally when no tool_call present', async () => {
    const config: AgentSessionConfig = {
      workingDirectory: '/tmp',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test',
      acceptanceCriteria: [],
    }
    const session = await adapter.startSession(config)
    vi.mocked(spawn).mockImplementation(() => createMockProc(['plain output']))

    const outputs: import('@shared/types').AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    await adapter.sendCommand(session.id, { type: 'implement', description: 'Do it', targetNodeId: 'n1' })

    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'plain output')).toBe(true)
    expect(outputs.some((o) => o.type === 'complete')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/main/adapters/__tests__/opencode-subagent.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/adapters/__tests__/opencode-subagent.test.ts
git commit -m "test(opencode): inline subagent dispatch integration"
```

---

## Task 8: Run Full Test Suite and Lint

- [ ] **Step 1: Run unit tests**

```bash
npm run test
```

Expected: PASS (existing + new tests).

- [ ] **Step 2: Run type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: no warnings/errors.

- [ ] **Step 4: Commit if clean**

```bash
git status
# If only expected files changed, no commit needed; otherwise commit fixes.
```

---

## Self-Review Checklist

- [ ] `AdapterCapability.InlineTools` added.
- [ ] `buildSubagentToolPrompt` generates tool description from schema.
- [ ] `parseToolCalls` extracts and parses `<tool_call>` blocks.
- [ ] `runToolAwareLoop` handles no-call, multi-call, max-rounds, timeout, failure.
- [ ] `OpenCodeAdapter` uses the loop and preserves constraint suffix.
- [ ] Registry marks OpenCode with `InlineTools`.
- [ ] Unit tests cover parser, loop, and OpenCode integration.
