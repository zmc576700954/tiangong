# Phase 4 — Subagent Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan.

**Goal:** Implement the `SubagentManager` and wire the `dispatch_subagent` tool into the Claude Code (via `createSdkMcpServer`) and MCP (via tools array + tool-loop interception) adapters. Parent agent calls the tool; SubagentManager spawns an ephemeral child session, runs it, captures the result text + file changes + token usage, persists to `subagent_invocations`, and returns the result as a tool_result so the parent continues reasoning. No renderer UI yet (that's Phase 5).

**Architecture:** `SubagentManager` (new) holds an `AgentManager` reference + `SubagentInvocationRepository`. `invoke(args)` validates the agent type + scope strategy, resolves the child sandbox (independent sandbox for all three strategies — `inherit` uses parent's full allow-list, `subset` validates subset, `fresh` uses args), inserts a `queued` row, starts a child session via `AgentManager.startSession` (no threadId → no DB thread), sends the prompt via `sendCommand`, subscribes to child outputs via `addSessionOutputListener`, awaits `complete`/`error`, collects result text from accumulated stdout + file_change events, writes terminal state to the repo, terminates the child session, returns `SubagentResult`.

Adapter integration:
- **Claude Code** uses `createSdkMcpServer` to register an in-process MCP server exposing the `dispatch_subagent` tool. When the SDK calls it, the adapter's tool handler invokes `SubagentManager.invoke()` and returns the result text as the tool response.
- **MCP adapter** appends a `dispatch_subagent` tool definition to its `tools` array and intercepts the tool name in `executeToolUseLoop` before delegating to MCP clients, calling `SubagentManager.invoke()` and pushing the result as a `tool_result`.

**Spec deviations:**
- `scopeStrategy='inherit'` does **not** share the parent sandbox handle (no refcounting exists). Instead it creates an independent sandbox with `allowedFiles = parent.allowedFiles` (full set). Semantically equivalent for file-boundary enforcement; loses the "no backup overhead" optimization. Acceptable for Phase 4.
- `inline-protocol` for CLI adapters (opencode/cline/etc.) is **deferred** — Phase 4 ships `native-task` (Claude Code) + `api-tool` (MCP) only.

**Spec reference:** `docs/superpowers/specs/2026-06-22-context-compaction-and-subagent-dispatch-design.md` — Module 4.

---

## File Structure

| Path | Purpose |
|---|---|
| `src/main/agent/subagent-manager.ts` | (create) `SubagentManager` class — invoke/cancel/listActive/onProgress |
| `src/main/agent/agent-manager.ts` | (modify) add `getSessionConfig()` public getter; `setSubagentManager()` setter; track `parentSessionId`/`swarmTaskId` on SessionState; expose a child-session output listener helper if needed |
| `src/main/adapters/base.ts` | (modify) add `setSubagentManager()` so adapters can call back; add `dispatch_subagent` tool schema constant |
| `src/main/adapters/claude-code.ts` | (modify) register in-process SDK MCP server exposing `dispatch_subagent`; inject `agentType.allowedTools` into child query options |
| `src/main/adapters/mcp-adapter.ts` | (modify) append `dispatch_subagent` to tools array; intercept in `executeToolUseLoop` |
| `src/main/ipc/subagent.ts` | (create) `registerSubagentHandlers` — listTypes/listInvocations/cancel/getResult + push events |
| `src/main/ipc-handlers.ts` | (modify) instantiate SubagentManager, wire setters, register handlers |
| `src/shared/types/ipc.ts` | (modify) add `subagent:*` channel signatures |
| `src/preload/index.ts` | (modify) expose `subagent:*` channels + `onSubagentOutput` event |
| `src/main/__tests__/subagent-manager.test.ts` | (create) invoke/cancel/scope/concurrency tests |
| `src/main/adapters/__tests__/claude-code-subagent.test.ts` | (create) tool registration + invoke path |
| `src/main/adapters/__tests__/mcp-subagent.test.ts` | (create) tool array + loop interception |

---

## Phase 4 Tasks

### Task 1: AgentManager public getters + SessionState parent fields

**Files:**
- Modify: `src/main/agent/agent-manager.ts`

**Step 1: Read** `src/main/agent/agent-manager.ts` around lines 65-79 (SessionState) and 709-716 (where sessionStates is populated).

**Step 2: Add `parentSessionId` and `swarmTaskId` to SessionState.**

```ts
interface SessionState {
  // …existing fields…
  parentSessionId?: string
  swarmTaskId?: string
}
```

In `startSession` where `sessionStates.set(sessionId, {...})` is called (around line 709-716), populate from config:

```ts
this.sessionStates.set(sessionId, {
  // …existing…
  threadId: config.threadId,
  parentSessionId: config.parentSessionId,
  swarmTaskId: config.swarmTaskId,
})
```

**Step 3: Add public getters** for SubagentManager to query parent state:

```ts
/** Phase 4: expose session config for subagent scope validation. */
getSessionConfig(sessionId: string): AgentSessionConfig | undefined {
  return this.sessionStates.get(sessionId)?.config
}

/** Phase 4: expose session state for subagent parent linkage. */
getSessionState(sessionId: string): SessionState | undefined {
  return this.sessionStates.get(sessionId)
}
```

Place these near `getSandbox` (around line 579-581).

**Step 4: Add `setSubagentManager` setter** (SubagentManager needs AgentManager, so we inject after construction to break the cycle):

```ts
private subagentManager?: SubagentManager

setSubagentManager(mgr: SubagentManager): void {
  this.subagentManager = mgr
}

getSubagentManager(): SubagentManager | undefined {
  return this.subagentManager
}
```

Import: `import type { SubagentManager } from './subagent-manager'`

**Step 5: Verify.** `npx tsc --noEmit` — clean. `npm run test` — all pass. Commit.

---

### Task 2: SubagentManager core (invoke + cancel + persistence)

**Files:**
- Create: `src/main/agent/subagent-manager.ts`
- Create: `src/main/__tests__/subagent-manager.test.ts`

**Step 1: Implement `SubagentManager`.**

```ts
/**
 * SubagentManager
 *
 * Spawns ephemeral child agent sessions on behalf of a parent session's
 * dispatch_subagent tool call. Each invocation:
 *   1. Validates agent type + scope strategy
 *   2. Resolves child sandbox (independent, with allow-list per strategy)
 *   3. Inserts a subagent_invocations row (queued)
 *   4. Starts a child session via AgentManager (no threadId → no DB thread)
 *   5. Sends the prompt via sendCommand
 *   6. Subscribes to child outputs; tags each with invocationId and re-broadcasts to parent
 *   7. Awaits complete/error
 *   8. Collects result text (assistant stdout) + file_changes + token usage
 *   9. Updates the row to completed/failed
 *  10. Terminates the child session
 *  11. Returns SubagentResult
 */

import { EventEmitter } from 'events'
import type { AgentManager } from './agent-manager'
import type { SubagentInvocationRepository } from '../repositories/subagent-invocation-repository'
import type {
  AgentTypeDefinition,
  SubagentInvokeArgs,
  SubagentInvocation,
  SubagentResult,
  AgentSessionConfig,
  AgentCommand,
  AgentOutput,
} from '@shared/types'
import { BUILT_IN_AGENT_TYPES } from '@shared/types'
import { AgentError, ErrorCode } from '../errors'

const DEFAULT_MAX_CONCURRENT = 5
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes

export class SubagentManager extends EventEmitter {
  private activeCount = new Map<string, number>()  // parentSessionId → running count
  private activeInvocations = new Map<string, { sessionId: string; parentSessionId: string }>()
  private customTypes = new Map<string, AgentTypeDefinition>()

  constructor(
    private agentManager: AgentManager,
    private repo: SubagentInvocationRepository,
    private maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  ) {
    super()
  }

  /** Register a user-defined agent type (settings). */
  registerType(def: AgentTypeDefinition): void {
    this.customTypes.set(def.name, def)
  }

  /** List all available types (built-in + custom). */
  listTypes(): AgentTypeDefinition[] {
    return [...BUILT_IN_AGENT_TYPES, ...this.customTypes.values()]
  }

  getType(name: string): AgentTypeDefinition | undefined {
    return this.customTypes.get(name) ?? BUILT_IN_AGENT_TYPES.find((t) => t.name === name)
  }

  async invoke(args: SubagentInvokeArgs): Promise<SubagentResult> {
    const def = this.getType(args.agentType)
    if (!def) {
      throw new AgentError(`Unknown agent type: ${args.agentType}`, ErrorCode.AGENT_ADAPTER_ERROR)
    }

    // Concurrency cap
    const current = this.activeCount.get(args.parentSessionId) ?? 0
    if (current >= this.maxConcurrent) {
      throw new AgentError(
        `Subagent concurrency limit reached (${this.maxConcurrent}) for session ${args.parentSessionId}`,
        ErrorCode.AGENT_SESSION_LIMIT,
      )
    }
    this.activeCount.set(args.parentSessionId, current + 1)

    const startedAt = Date.now()
    const invocationId = await this.repo.create({
      parentSessionId: args.parentSessionId,
      parentMessageId: args.parentMessageId,
      agentType: args.agentType,
      description: args.description,
      prompt: args.prompt,
      adapterName: args.adapterName ?? def.defaultAdapter,
      nodeId: args.nodeId,
      allowedFiles: args.allowedFiles,
      startedAt,
    })

    try {
      await this.repo.updateStatus(invocationId, 'running')
      const result = await this._runInvocation(invocationId, args, def)
      await this.repo.complete(invocationId, {
        resultText: result.resultText,
        resultFiles: result.resultFiles,
        tokensUsed: result.tokensUsed,
        finishedAt: Date.now(),
      })
      this.emit('progress', { invocationId, status: 'completed' })
      return { invocationId, ...result }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await this.repo.fail(invocationId, { error: errorMsg, finishedAt: Date.now() })
      this.emit('progress', { invocationId, status: 'failed', error: errorMsg })
      throw err
    } finally {
      const cnt = this.activeCount.get(args.parentSessionId) ?? 1
      this.activeCount.set(args.parentSessionId, Math.max(0, cnt - 1))
      this.activeInvocations.delete(invocationId)
    }
  }

  private async _runInvocation(
    invocationId: string,
    args: SubagentInvokeArgs,
    def: AgentTypeDefinition,
  ): Promise<Omit<SubagentResult, 'invocationId'>> {
    // 1. Resolve child config
    const parentState = this.agentManager.getSessionState(args.parentSessionId)
    if (!parentState) {
      throw new AgentError(`Parent session ${args.parentSessionId} not found`, ErrorCode.AGENT_SESSION_NOT_FOUND)
    }
    const parentConfig = parentState.config
    const childAllowedFiles = this.resolveAllowedFiles(def, args, parentConfig)
    const childAdapterName = args.adapterName ?? def.defaultAdapter ?? parentState.adapterName

    const childConfig: AgentSessionConfig = {
      ...parentConfig,
      allowedFiles: childAllowedFiles,
      // Subagent-specific markers
      parentSessionId: args.parentSessionId,
      swarmTaskId: invocationId,
      nodeId: args.nodeId,
      threadId: undefined,  // no DB thread for subagents
      contextSummary: def.systemPromptAddon
        ? `${def.systemPromptAddon}\n\nTask: ${args.prompt}`
        : `Task: ${args.prompt}`,
      // Clear resume — subagent is a fresh session
      resumeSessionId: undefined,
    }

    // 2. Start child session
    const startResult = await this.agentManager.startSession(childAdapterName, childConfig)
    const childSessionId = startResult.sessionId
    this.activeInvocations.set(invocationId, { sessionId: childSessionId, parentSessionId: args.parentSessionId })

    // 3. Subscribe to child outputs — tag with invocationId, re-broadcast to parent
    const parentBroadcastName = parentState.broadcastName
    const outputBuffer: string[] = []
    const fileChanges: string[] = []
    let tokensUsed = 0
    let settled = false
    const settlePromise = new Promise<void>((resolve, reject) => {
      const handler = (output: AgentOutput) => {
        // Tag and forward to parent
        const tagged: AgentOutput = { ...output, invocationId }
        this.agentManager.broadcastToSession(args.parentSessionId, tagged)

        if (output.type === 'stdout' || output.type === 'complete') {
          if (output.data) outputBuffer.push(output.data)
        }
        if (output.type === 'file_change' && output.filePath) {
          fileChanges.push(output.filePath)
        }
        if (output.type === 'complete' && !settled) {
          settled = true
          resolve()
        }
        if (output.type === 'error' && !settled) {
          settled = true
          reject(new AgentError(output.data || 'Subagent error', ErrorCode.AGENT_ADAPTER_ERROR))
        }
      }
      this.agentManager.addSessionOutputListener(childSessionId, handler)

      // Timeout
      setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new AgentError('Subagent timeout', ErrorCode.AGENT_ADAPTER_ERROR))
        }
      }, DEFAULT_TIMEOUT_MS)
    })

    // 4. Send the prompt
    const command: AgentCommand = {
      type: 'implement',
      description: args.description,
      targetNodeId: args.nodeId ?? '',
    }
    await this.agentManager.sendCommand(childSessionId, command)

    // 5. Await completion
    await settlePromise

    // 6. Collect result
    const resultText = outputBuffer.join('\n').trim() || '(no output)'

    // 7. Terminate child session (cleanup)
    try {
      await this.agentManager.terminateSession(childSessionId)
    } catch {
      // best-effort
    }

    return {
      resultText,
      resultFiles: fileChanges,
      tokensUsed,
      durationMs: Date.now() - Date.now(),  // placeholder; actual from startedAt
    }
  }

  private resolveAllowedFiles(
    def: AgentTypeDefinition,
    args: SubagentInvokeArgs,
    parentConfig: AgentSessionConfig,
  ): string[] {
    switch (def.scopeStrategy) {
      case 'inherit':
        // Use parent's full allow-list (independent sandbox, no refcounting)
        return parentConfig.allowedFiles
      case 'subset': {
        const child = args.allowedFiles ?? []
        const parentSet = new Set(parentConfig.allowedFiles)
        const invalid = child.filter((f) => !parentSet.has(f))
        if (invalid.length > 0) {
          throw new AgentError(
            `Subagent allowed_files not subset of parent: ${invalid.join(', ')}`,
            ErrorCode.SCOPE_GUARD_VIOLATION,
          )
        }
        return child
      }
      case 'fresh':
        return args.allowedFiles ?? []
    }
  }

  async cancel(invocationId: string): Promise<void> {
    const active = this.activeInvocations.get(invocationId)
    if (active) {
      try {
        await this.agentManager.terminateSession(active.sessionId)
      } catch { /* best-effort */ }
    }
    await this.repo.cancel(invocationId, Date.now())
    this.emit('progress', { invocationId, status: 'cancelled' })
  }

  listActive(parentSessionId: string): SubagentInvocation[] {
    // Delegate to repo for now; could filter by status='running'
    return []  // Phase 4: implement via repo.listByParent filtered
  }

  onProgress(handler: (data: { invocationId: string; status: string; error?: string }) => void): () => void {
    this.on('progress', handler)
    return () => this.off('progress', handler)
  }
}
```

**Important implementation notes (the implementer must verify against actual AgentManager API):**
- `agentManager.broadcastToSession(parentSessionId, output)` — this method may not exist. Check `agent-manager.ts`. The existing `broadcaster.broadcast(broadcastName, output)` is the actual path. SubagentManager needs to resolve `parentState.broadcastName` and call `this.agentManager['broadcaster'].broadcast(...)` or add a public `broadcastToSession(sessionId, output)` helper on AgentManager. **Add that helper in Task 1 if missing.**
- `agentManager.addSessionOutputListener(childSessionId, handler)` exists (around line 1414-1434).
- `ErrorCode.SCOPE_GUARD_VIOLATION` — verify it exists in `src/main/errors.ts`; if not, use `AGENT_ADAPTER_ERROR`.
- `durationMs` calculation is wrong in the placeholder — fix to use the invocation's `startedAt`.

**Step 2: Create test file** `src/main/__tests__/subagent-manager.test.ts`.

Mock AgentManager with a fake `startSession` that returns `{ sessionId: 'child-1', adapterUsed: 'mock', fallbackHistory: [] }`, a fake `addSessionOutputListener` that immediately invokes the handler with `{ type: 'complete', data: 'done', timestamp: 0 }`, and `sendCommand`/`terminateSession` as no-ops. Mock the repo with in-memory storage.

Tests:
- `invoke` with a valid built-in type returns a `SubagentResult` with `resultText`
- `invoke` with unknown type throws
- `invoke` with `scopeStrategy='subset'` and invalid `allowedFiles` throws
- `invoke` with `scopeStrategy='inherit'` uses parent's allowedFiles
- Concurrency cap throws when exceeded
- `cancel` terminates the child session and marks the row cancelled
- Failure path: child emits `error` → repo row marked failed, invoke rejects

**Step 3: Verify + commit.**

---

### Task 3: Wire SubagentManager into AgentManager + ipc-handlers

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/agent/agent-manager.ts` (add `broadcastToSession` helper if missing)

**Step 1: Add `broadcastToSession` helper to AgentManager** (if not already present from Task 1):

```ts
/** Phase 4: broadcast an output to a session's thread channel (used by SubagentManager). */
broadcastToSession(sessionId: string, output: AgentOutput): void {
  const state = this.sessionStates.get(sessionId)
  if (state) {
    this.broadcaster.broadcast(state.broadcastName, output)
  }
}
```

**Step 2: In `ipc-handlers.ts`**, instantiate SubagentManager after AgentManager is created:

```ts
import { SubagentManager } from './agent/subagent-manager'
import { SubagentInvocationRepository } from './repositories/subagent-invocation-repository'

// In registerIpcHandlers:
const subagentInvocationRepo = new SubagentInvocationRepository(db)
const subagentManager = new SubagentManager(agentManager, subagentInvocationRepo)
agentManager.setSubagentManager(subagentManager)
```

Also pass `subagentManager` to adapters that need it (via `adapter.setSubagentManager(mgr)` — added in Task 4). Loop over registered adapters and call the setter.

**Step 3: Verify + commit.**

---

### Task 4: BaseAdapter.setSubagentManager + dispatch_subagent tool schema

**Files:**
- Modify: `src/main/adapters/base.ts`

**Step 1: Add a `subagentManager` field + setter:**

```ts
import type { SubagentManager } from '../agent/subagent-manager'

// In BaseAdapter class:
protected subagentManager?: SubagentManager

setSubagentManager(mgr: SubagentManager): void {
  this.subagentManager = mgr
}
```

**Step 2: Export a `DISPATCH_SUBAGENT_TOOL` schema constant** (shared by Claude Code and MCP adapters):

```ts
import type { SubagentToolName } from '@shared/types'

export const DISPATCH_SUBAGENT_TOOL_NAME = 'dispatch_subagent'

export const DISPATCH_SUBAGENT_TOOL_SCHEMA = {
  name: DISPATCH_SUBAGENT_TOOL_NAME,
  description: 'Spawn an ephemeral subagent for a focused task. Multiple calls may be issued in one turn to run in parallel. The subagent runs with a constrained tool set and file scope; its final output is returned to you as the tool result.',
  input_schema: {
    type: 'object' as const,
    properties: {
      agent_type: {
        type: 'string',
        description: 'Which subagent type to spawn.',
        enum: ['explore', 'implement', 'review', 'fix', 'general'],
      },
      description: { type: 'string', description: 'A 3-5 word label for the task.' },
      prompt: { type: 'string', description: 'Full task instructions. The subagent only sees this text.' },
      adapter_name: { type: 'string', description: 'Optional adapter override (defaults to the type default).' },
      node_id: { type: 'string', description: 'Optional canvas node binding.' },
      allowed_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional file allow-list for subset/fresh scope strategies.',
      },
    },
    required: ['agent_type', 'description', 'prompt'],
  },
}
```

(The `enum` could be dynamically generated from `BUILT_IN_AGENT_TYPES`, but a static list is fine for Phase 4.)

**Step 3: Verify + commit.**

---

### Task 5: Claude Code adapter — createSdkMcpServer + dispatch_subagent

**Files:**
- Modify: `src/main/adapters/claude-code.ts`
- Create: `src/main/adapters/__tests__/claude-code-subagent.test.ts`

**Step 1: Read** `src/main/adapters/claude-code.ts` and the SDK type at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:466-487` (`createSdkMcpServer`).

**Step 2: Register an in-process MCP server** when `subagentManager` is set, and add it to `query()` options `mcpServers`:

```ts
import { DISPATCH_SUBAGENT_TOOL_NAME, DISPATCH_SUBAGENT_TOOL_SCHEMA } from './base'

// In the query() options construction (around line 95-147):
const mcpServers: Record<string, any> = { /* existing if any */ }
if (this.subagentManager && this.sdkCreateSdkMcpServer) {
  mcpServers.bizgraph = this.sdkCreateSdkMcpServer({
    name: 'bizgraph',
    version: '1.0.0',
    tools: [
      {
        ...DISPATCH_SUBAGENT_TOOL_SCHEMA,
        // SDK MCP tool handler:
        callback: async (args: Record<string, unknown>) => {
          const result = await this.subagentManager!.invoke({
            parentSessionId: sessionId,  // the active claude-code session
            agentType: String(args.agent_type),
            description: String(args.description),
            prompt: String(args.prompt),
            adapterName: args.adapter_name ? String(args.adapter_name) : undefined,
            nodeId: args.node_id ? String(args.node_id) : undefined,
            allowedFiles: Array.isArray(args.allowed_files) ? (args.allowed_files as string[]) : undefined,
          })
          return { content: [{ type: 'text', text: result.resultText }] }
        },
      },
    ],
  })
}
// Pass mcpServers into query options
```

The exact `createSdkMcpServer` API shape — verify from `sdk.d.ts:466-487`. It may return a config object that goes into `mcpServers`, or it may need to be called differently. **Read the SDK type carefully.**

**Step 3: Inject `agentType.allowedTools` into child sessions.** Since SubagentManager starts child sessions via `AgentManager.startSession`, and the child uses the same `ClaudeCodeAdapter`, the adapter needs to know the child's allowed tools. Two options:

- **Option A (simpler):** Pass `allowedTools` via `AgentSessionConfig` — but that type doesn't have the field. Could add `subagentAllowedTools?: string[]` to config.
- **Option B:** The child session's `swarmTaskId` (set to invocationId) lets the adapter look up the agent type from SubagentManager and apply `tools: allowedTools` in the child's `query()` call.

Use Option B — when the adapter detects `session.config.swarmTaskId` is set, query `this.subagentManager.getType(...)` (needs a lookup by invocationId, or pass the type name in config). Add `subagentAgentType?: string` to `AgentSessionConfig` (Phase 1 already has `swarmTaskId`; add the type name for lookup).

**Actually, simpler:** SubagentManager sets `childConfig.contextSummary` to include the agent type definition's `systemPromptAddon` + prompt. The allowed-tools restriction is enforced by passing `tools: [...]` in the child `query()`. To pass this cleanly, add `subagentAllowedTools?: SubagentToolName[] | '*'` to `AgentSessionConfig` and have the adapter read it.

Add to `AgentSessionConfig` in `src/shared/types/agent.ts`:
```ts
/** Phase 4: subagent tool restriction (Claude Code SDK `tools` option). */
subagentAllowedTools?: string[] | '*'
```

Then in `claude-code.ts` `query()` options:
```ts
if (session.config.subagentAllowedTools) {
  options.tools = session.config.subagentAllowedTools === '*'
    ? undefined
    : session.config.subagentAllowedTools
}
```

And in `SubagentManager._runInvocation`, set `childConfig.subagentAllowedTools = def.allowedTools`.

**Step 4: Test file.** Mock the SDK's `createSdkMcpServer` and verify:
- When `setSubagentManager` is called, the adapter registers the bizgraph MCP server
- The `dispatch_subagent` tool's callback invokes `subagentManager.invoke` with the right args
- The result text is returned as `{ content: [{ type: 'text', text }] }`
- Child sessions with `subagentAllowedTools` set get `tools` in their query options

**Step 5: Verify + commit.**

---

### Task 6: MCP adapter — append dispatch_subagent tool + loop interception

**Files:**
- Modify: `src/main/adapters/mcp-adapter.ts`
- Create: `src/main/adapters/__tests__/mcp-subagent.test.ts`

**Step 1: Read** `src/main/adapters/mcp-adapter.ts` around lines 543-583 (tools array construction) and 843-950 (executeToolUseLoop + executeMcpTool).

**Step 2: Append `dispatch_subagent` to the tools array** when `subagentManager` is set:

```ts
import { DISPATCH_SUBAGENT_TOOL_NAME, DISPATCH_SUBAGENT_TOOL_SCHEMA } from './base'

// Around line 565-569, after building mcpTools array:
const tools: UnifiedTool[] = mcpTools.map((t) => ({
  name: t.name, description: t.description, inputSchema: t.inputSchema,
}))
if (this.subagentManager) {
  tools.unshift({
    name: DISPATCH_SUBAGENT_TOOL_NAME,
    description: DISPATCH_SUBAGENT_TOOL_SCHEMA.description,
    inputSchema: DISPATCH_SUBAGENT_TOOL_SCHEMA.input_schema,
  })
}
```

**Step 3: Intercept in `executeToolUseLoop`.** In the `for (const toolCall of response.toolCalls)` loop (around line 890-901), before `executeMcpTool`:

```ts
if (toolCall.name === DISPATCH_SUBAGENT_TOOL_NAME && this.subagentManager) {
  const args = toolCall.arguments as Record<string, unknown>
  try {
    const result = await this.subagentManager.invoke({
      parentSessionId: session.id,  // current MCP session id
      agentType: String(args.agent_type),
      description: String(args.description),
      prompt: String(args.prompt),
      adapterName: args.adapter_name ? String(args.adapter_name) : undefined,
      nodeId: args.node_id ? String(args.node_id) : undefined,
      allowedFiles: Array.isArray(args.allowed_files) ? (args.allowed_files as string[]) : undefined,
    })
    toolResults.push({
      toolCallId: toolCall.id,
      content: result.resultText,
    })
  } catch (err) {
    toolResults.push({
      toolCallId: toolCall.id,
      content: `Subagent failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    })
  }
  continue
}
```

**Step 4: Filter child session tools by `subagentAllowedTools`.** When a child MCP session runs (detected via `session.config.swarmTaskId`), filter the tools array to only include the allowed tools. In `doSendCommand`:

```ts
if (session.config.subagentAllowedTools && session.config.subagentAllowedTools !== '*') {
  const allowed = new Set(session.config.subagentAllowedTools)
  tools = tools.filter((t) => allowed.has(t.name) || t.name === DISPATCH_SUBAGENT_TOOL_NAME)
}
```

(Child subagents generally shouldn't dispatch further subagents, but keep the tool available for now — can disable nesting later.)

**Step 5: Test file.** Mock the LLM response to include a `dispatch_subagent` tool_use, mock SubagentManager.invoke, verify:
- The tools array includes `dispatch_subagent` when subagentManager is set
- The tool_use is intercepted and invoke is called
- The result is pushed as a tool_result
- Errors are caught and pushed as error tool_results

**Step 6: Verify + commit.**

---

### Task 7: IPC handlers + preload for subagent:* domain

**Files:**
- Create: `src/main/ipc/subagent.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/preload/index.ts`

**Step 1: Add `subagent:*` channels to `IpcApi`** in `src/shared/types/ipc.ts`:

```ts
import type { AgentTypeDefinition, SubagentInvocation, SubagentResult } from './subagent'

// In IpcApi:
'subagent:listTypes': () => Promise<AgentTypeDefinition[]>
'subagent:listInvocations': (parentSessionId: string) => Promise<SubagentInvocation[]>
'subagent:cancel': (invocationId: string) => Promise<void>
'subagent:getResult': (invocationId: string) => Promise<SubagentResult | null>
```

(Phase 4 doesn't expose `subagent:invoke` over IPC — invocation only happens via the adapter tool. The IPC channels are for the Phase 5 UI to query/cancel.)

**Step 2: Create `src/main/ipc/subagent.ts`:**

```ts
import type { TypedHandle } from './utils'
import type { SubagentManager } from '../agent/subagent-manager'
import type { SubagentInvocationRepository } from '../repositories/subagent-invocation-repository'
import type { BrowserWindow } from 'electron'

export function registerSubagentHandlers(
  subagentManager: SubagentManager,
  repo: SubagentInvocationRepository,
  typedHandle: TypedHandle,
  getMainWindow?: () => BrowserWindow | null,
): void {
  typedHandle('subagent:listTypes', async () => {
    return subagentManager.listTypes()
  })

  typedHandle('subagent:listInvocations', async (_, parentSessionId: unknown) => {
    const id = ensureString('parentSessionId', parentSessionId)
    return repo.listByParent(id)
  })

  typedHandle('subagent:cancel', async (_, invocationId: unknown) => {
    const id = ensureString('invocationId', invocationId)
    return subagentManager.cancel(id)
  })

  typedHandle('subagent:getResult', async (_, invocationId: unknown) => {
    const id = ensureString('invocationId', invocationId)
    const inv = await repo.get(id)
    if (!inv || inv.status !== 'completed') return null
    return {
      invocationId: inv.id,
      resultText: inv.resultText ?? '',
      resultFiles: inv.resultFiles ?? [],
      tokensUsed: inv.tokensUsed,
      durationMs: inv.finishedAt ? inv.finishedAt - inv.startedAt : 0,
    }
  })

  // Push progress events to the renderer
  if (getMainWindow) {
    subagentManager.onProgress((data) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('subagent:progress', data)
      }
    })
  }
}
```

(Reuse the `ensureString` helper from another IPC module or inline it.)

**Step 3: Wire in `ipc-handlers.ts`:**

```ts
import { registerSubagentHandlers } from './ipc/subagent'

// In registerIpcHandlers, after subagentManager is created:
registerSubagentHandlers(subagentManager, subagentInvocationRepo, typedHandle, getMainWindow)
```

**Step 4: Update `src/preload/index.ts`:**

Add to `exposedChannels`:
```ts
'subagent:listTypes',
'subagent:listInvocations',
'subagent:cancel',
'subagent:getResult',
```

Add an event listener in the `contextBridge.exposeInMainWorld` block:
```ts
onSubagentProgress: (callback: (data: { invocationId: string; status: string; error?: string }) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, data: { invocationId: string; status: string; error?: string }) => callback(data)
  ipcRenderer.on('subagent:progress', handler)
  return () => { ipcRenderer.removeListener('subagent:progress', handler) }
},
```

**Step 5: Verify + commit.**

---

### Task 8: Final verification

- [ ] `npm run test` — all pass
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — baseline preserved
- [ ] Manual reasoning check: trace a `dispatch_subagent('explore', ...)` call from a Claude Code parent session → SubagentManager.invoke → child session → output routing → result returned as tool_result. Identify any gaps.
- [ ] Verify `subagent_invocations` rows are created and updated through the lifecycle
- [ ] Verify concurrency cap prevents >5 simultaneous subagents per parent
- [ ] Verify `cancel` terminates the child and marks the row

---

## Self-review

**Spec coverage (Module 4):**

| Spec item | Task | Notes |
|---|---|---|
| `SubagentManager.invoke()` | 2 | Full lifecycle |
| Ephemeral child sessions (no chat_thread) | 2 | `threadId: undefined` in child config |
| `dispatch_subagent` tool schema | 4 | Shared constant on BaseAdapter |
| Claude Code `native-task` (createSdkMcpServer) | 5 | Per design decision B |
| MCP `api-tool` (tools array + loop intercept) | 6 | |
| `inline-protocol` for CLI adapters | — | **Deferred** (Phase 4 ships native + api only) |
| `scopeStrategy` three variants | 2 | `inherit` = full allow-list (no refcount); `subset` = validated; `fresh` = args |
| `allowedTools` restriction | 5, 6 | New `subagentAllowedTools` config field |
| Concurrency cap (default 5) | 2 | `activeCount` Map |
| Implicit serialisation (overlapping allowed_files) | — | **Deferred** — Phase 4 relies on ScopeGuard rollback as the safety net; explicit serialisation is a follow-up |
| 5-min timeout | 2 | `DEFAULT_TIMEOUT_MS` |
| `subagent_invocations` persistence | 2 | create/updateStatus/complete/fail |
| Node status linkage (placeholder→developing) | — | **Deferred** to Phase 5 (UI-driven) |
| IPC `subagent:listTypes/listInvocations/cancel/getResult` | 7 | |
| `subagent:onProgress` push | 7 | |

**Deferred items (documented):**
- `inline-protocol` adapter path
- Implicit enqueue-time serialisation for overlapping write allow-lists
- Node status transitions on subagent start/complete
- `summarizeResult` LLM summarisation of long result_text
- Nested subagent dispatch (child dispatching further subagents) — currently allowed but untested

**Risks:**
- `createSdkMcpServer` API shape is assumed from SDK type defs — implementer must verify against `sdk.d.ts:466-487`. If the API differs significantly, Task 5 may need redesign.
- Child session output routing via `addSessionOutputListener` + re-broadcast — verify the listener fires for all output types including `complete`.
- `AgentSessionConfig.subagentAllowedTools` is a new field — must be added to the shared type and respected by both adapters.
- SubagentManager ↔ AgentManager circular dependency is broken via setter injection (Task 1 + Task 3).
