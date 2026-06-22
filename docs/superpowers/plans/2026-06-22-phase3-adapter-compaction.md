# Phase 3 — Adapter-differentiated Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan.

**Goal:** Implement actual compaction with adapter-aware strategies (`native` for Claude Code via SDK auto-compact opt-in, `llm` for MCP via LLM summarisation, `summary` rewrite for everyone else). Wire it into `AgentManager.compactContext()`, expose via IPC, and add a UI compact button. Auto-compact gets turned on (`autoCompactEnabled: true` by default).

**Architecture:** A new abstract `compactContext()` method on `BaseAdapter`. Three concrete strategies — `compactBySummaryRewrite` (default, reuses existing `buildAndStoreSummary`), `compactByNative` (Claude Code only — toggles SDK `autoCompactEnabled`), and `compactByLlm` (MCP adapter only — synthesises a summary via an extra LLM call and stores it as `contextSummary`). `AgentManager.compactContext()` is the orchestrator: resolves strategy, broadcasts a system message, calls the adapter, writes to `compact_history`, updates the waterline, dedups concurrent calls via `compactInflight: Set<sessionId>`.

**Spec deviations from original design:**
- **Native compaction for Claude Code** is now "enable SDK auto-compact opt-in" rather than "send `/compact` slash command" — the SDK has no slash-command API. The result: SDK handles compaction internally when its own window threshold trips. The adapter's `compactContext(native)` toggles `autoCompactEnabled=true` for the active session via `applyFlagSettings` (SDK feature) and reports the request as completed. The `compact_history` row records the toggle event.
- **MCP `llm` strategy** doesn't have cross-turn conversation history to summarise (the adapter builds messages per-request). Phase 3 implements it as: capture session output buffer (existing `sessionOutputBuffers`), summarise via LLM, store as `contextSummary` (same backing store as `summary-rewrite` but using LLM instead of heuristics).
- **Native `result_text` extraction from Codex `runStreamed`** is required for Phase 4 subagent integration, but Phase 3 only needs `usage` reporting (which Codex returns in `TurnCompletedEvent.usage`).

**Spec reference:** `docs/superpowers/specs/2026-06-22-context-compaction-and-subagent-dispatch-design.md` — Module 3.

---

## Prerequisites (must land before strategies)

1. `threadId` must reach the adapter layer. Phase 3 adds `threadId` to `AgentSessionConfig` and `SessionState`, populated at `startSession` from the renderer.
2. `AgentOutput.type` must include `'system'` so compaction status messages can be broadcast through the existing pipeline.
3. `AgentManager` must hold `CompactHistoryRepository` and `ChatRepository` references to write history and call `setLastCompactedAt`.

---

## File Structure

| Path | Purpose |
|---|---|
| `src/shared/types/agent.ts` | (modify) add `'system'` to `AgentOutput.type`; add `threadId?: string` to `AgentSessionConfig`; widen `BaseAdapter.compactContext` abstract method |
| `src/shared/types/ipc.ts` | (modify) `agent:startSession` config param now includes `threadId` |
| `src/main/agent/agent-manager.ts` | (modify) add `compactContext()` method; track `threadId` in `SessionState`; inject repos |
| `src/main/adapters/base.ts` | (modify) add abstract `compactContext()`, protected `compactBySummaryRewrite()`, `reportUsage` now real |
| `src/main/adapters/claude-code.ts` | (modify) implement `compactContext()` native path via `applyFlagSettings`; parse `result.usage` and call `reportUsage` |
| `src/main/adapters/codex.ts` | (modify) parse `TurnCompletedEvent.usage`; falls back to `compactBySummaryRewrite` for native |
| `src/main/adapters/mcp-adapter.ts` | (modify) implement `compactByLlm()`; parse response `usage` |
| `src/main/adapters/registry.ts` | (modify) populate adapter capabilities (`NativeCompact`, `LlmCompact`, `SummaryRewrite`) + `defaultCompactStrategy` |
| `src/main/ipc/context-waterline.ts` | (modify) wire `compactNow` IPC to `AgentManager.compactContext()` |
| `src/main/ipc/settings.ts` | (modify) waterline config now reads/writes real settings + applies to `ContextWaterline` |
| `src/main/agent/agent-manager.ts` | (modify) `resolveAndSendCommand` actually awaits `compactContext` when auto-compact triggers |
| `src/renderer/store/sessionStore.ts` | (modify) pass `threadId` in startSession config |
| `src/renderer/components/agent/ContextWaterlineBar.tsx` | (modify) add manual "Compact" button + strategy dropdown |
| `src/renderer/hooks/useAgentOutputListener.ts` | (modify) handle `output.type === 'system'` — render as system chat bubble |
| `src/main/__tests__/agent-manager-compact.test.ts` | (create) tests for `compactContext` orchestration |
| `src/main/adapters/__tests__/base-compact.test.ts` | (create) tests for `compactBySummaryRewrite` default |
| `src/main/adapters/__tests__/mcp-compact.test.ts` | (create) tests for `compactByLlm` |
| `src/main/adapters/__tests__/claude-code-compact.test.ts` | (create) tests for native flag toggle |

---

## Phase 3 Tasks

### Task 1: Prerequisites — threadId on SessionState + 'system' output type

**Files:**
- Modify: `src/shared/types/agent.ts`
- Modify: `src/main/agent/agent-manager.ts`
- Modify: `src/renderer/store/sessionStore.ts`
- Modify: `src/renderer/hooks/useAgentOutputListener.ts`

**Step 1:** Add `'system'` to `AgentOutput.type` union (`src/shared/types/agent.ts` around line 68):

```ts
export interface AgentOutput {
  type: 'stdout' | 'stderr' | 'file_change' | 'error' | 'complete' | 'system'
  // …rest unchanged…
}
```

**Step 2:** Add `threadId?: string` to `AgentSessionConfig`:

```ts
export interface AgentSessionConfig {
  // …existing fields…
  /** Phase 3: thread to bind for waterline tracking & history persistence. */
  threadId?: string
}
```

**Step 3:** Track `threadId` in `AgentManager.SessionState`. Read `src/main/agent/agent-manager.ts` around line 60-72 (SessionState type). Add:

```ts
interface SessionState {
  // …existing fields…
  threadId?: string
}
```

In `startSession` (around line 585), populate from config:
```ts
this.sessionStates.set(sessionId, {
  // …existing…
  threadId: config.threadId,
})
```

**Step 4:** In `resolveAndSendCommand` (around line 807), replace the Phase 2 stub with real threadId lookup:

```ts
const sessionState = this.sessionStates.get(sessionId)
const threadId = sessionState?.threadId
if (threadId && this.waterline?.shouldAutoCompact(threadId)) {
  // Phase 3: actually compact before sending
  try {
    await this.compactContext(sessionId, undefined, { reason: 'auto-threshold' })
  } catch (err) {
    logger.warn(`[Waterline] Auto-compact failed for ${sessionId}:`, err)
    // Continue sending command despite failure
  }
}
```

**Step 5:** Renderer — `sessionStore.ts` passes `threadId` when starting session:

Find the `agent:startSession` call (around line 66-68). Update the config to include the current threadId:

```ts
const config: AgentSessionConfig = {
  // …existing…
  threadId: thread.id,
}
```

**Step 6:** Renderer — `useAgentOutputListener.ts` handles `'system'`:

Around line 50 (the `output.type` switch), add:

```ts
} else if (output.type === 'system') {
  // System messages (e.g., compaction status) are appended as a system role chat bubble.
  const ownerThread = store.findThreadBySessionId(_sessionId)
  if (!ownerThread) return
  const systemMsg: ChatMessage = {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    content: output.data,
    timestamp: output.timestamp,
    status: 'success',
  }
  store.appendChatMessage(ownerThread.id, systemMsg)
}
```

**Step 7:** Verify.

- `npx tsc --noEmit` — clean.
- `npm run test` — all pass.
- Commit.

---

### Task 2: BaseAdapter abstract compactContext + summaryRewrite implementation

**Files:**
- Modify: `src/main/adapters/base.ts`

**Step 1: Read** `src/main/adapters/base.ts` to find:
- The `buildAndStoreSummary` method (around line 700-763)
- The `sessionOutputBuffers` Map (line 48)
- The class structure

**Step 2: Add abstract `compactContext` method + concrete `compactBySummaryRewrite` helper:**

Inside the `BaseAdapter` class:

```ts
/**
 * Compact the session's context using the chosen strategy.
 * Subclasses MUST implement. Most CLI adapters delegate to compactBySummaryRewrite.
 */
abstract compactContext(
  sessionId: string,
  strategy: CompactStrategy,
  options?: { reason?: CompactTrigger }
): Promise<CompactResult>

/**
 * Default summary-rewrite implementation. Reads from sessionOutputBuffers,
 * builds a heuristic summary, stores it in session.config.contextSummary,
 * and returns a CompactResult.
 */
protected async compactBySummaryRewrite(
  sessionId: string,
  options?: { reason?: CompactTrigger }
): Promise<CompactResult> {
  const session = this.sessions.get(sessionId)
  if (!session) {
    throw new AdapterError(`Session ${sessionId} not found`, ErrorCode.AGENT_SESSION_NOT_FOUND, this.name)
  }
  const buffer = this.sessionOutputBuffers.get(sessionId) ?? []
  const before = estimateTokens(buffer.join('\n'))
  const startedAt = Date.now()
  // Reuse existing buildAndStoreSummary which writes session.config.contextSummary
  await this.buildAndStoreSummary(sessionId)
  const summary = session.config.contextSummary ?? ''
  const after = estimateTokens(summary)
  // Clear the buffer so next compact has fresh content
  this.sessionOutputBuffers.set(sessionId, [])
  return {
    sessionId,
    strategy: 'summary',
    trigger: options?.reason ?? 'manual',
    tokensBefore: before,
    tokensAfter: after,
    summary,
    startedAt,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Native compact — subclasses override. Default rejects.
 */
protected async compactByNative(
  _sessionId: string,
  _options?: { reason?: CompactTrigger }
): Promise<CompactResult> {
  throw new AdapterError('NATIVE_COMPACT_NOT_SUPPORTED', ErrorCode.AGENT_ADAPTER_ERROR, this.name)
}

/**
 * LLM compact — subclasses override (e.g., MCP adapter).
 */
protected async compactByLlm(
  _sessionId: string,
  _options?: { reason?: CompactTrigger }
): Promise<CompactResult> {
  throw new AdapterError('LLM_COMPACT_NOT_SUPPORTED', ErrorCode.AGENT_ADAPTER_ERROR, this.name)
}
```

Imports needed at top of file:
```ts
import { estimateTokens } from '../shared/token-utils'
import type { CompactResult, CompactStrategy, CompactTrigger } from '@shared/types'
import { AdapterError, ErrorCode } from '../errors'
```

**Step 3: `reportUsage` becomes real.** It already exists from Phase 2 as a skeleton. Add a `'usage'` event listener registration helper:

```ts
onUsage(handler: (data: { sessionId: string; inputTokens: number; maxTokens?: number }) => void): void {
  this.on('usage', handler)
}
offUsage(handler: (data: { sessionId: string; inputTokens: number; maxTokens?: number }) => void): void {
  this.off('usage', handler)
}
```

This lets `AgentManager` subscribe and forward usage to `ContextWaterline.onAdapterUsageReport(threadId, tokens, max)`.

**Step 4:** Add an error code if missing. Open `src/main/errors.ts`, find `ErrorCode` constants. Add if not present:
```ts
AGENT_COMPACT_FAILED: 'AGENT_COMPACT_FAILED'
```

**Step 5:** Add a default `compactContext` that delegates to the three branches based on strategy:

```ts
// Replace the abstract with a concrete default that subclasses can override:
async compactContext(
  sessionId: string,
  strategy: CompactStrategy,
  options?: { reason?: CompactTrigger }
): Promise<CompactResult> {
  switch (strategy) {
    case 'native':  return this.compactByNative(sessionId, options)
    case 'llm':     return this.compactByLlm(sessionId, options)
    case 'summary': return this.compactBySummaryRewrite(sessionId, options)
  }
}
```

This way, subclasses only override `compactByNative` / `compactByLlm` for their supported strategies, and the dispatch is centralised.

**Step 6:** Add a test file `src/main/adapters/__tests__/base-compact.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BaseAdapter } from '../base'
// Use a minimal subclass for testing
class TestAdapter extends BaseAdapter {
  readonly name = 'test'
  readonly version = '0.0.1'
  async checkInstalled(): Promise<boolean> { return true }
  async doSendCommand(): Promise<void> { /* noop */ }
  protected async doTerminate(): Promise<void> { /* noop */ }
}

describe('BaseAdapter compaction', () => {
  let adapter: TestAdapter
  beforeEach(() => { adapter = new TestAdapter() })

  it('compactBySummaryRewrite returns a CompactResult with the existing summary', async () => {
    // Set up a fake session
    const sessionId = 'test-sess-1'
    // @ts-expect-error - access protected for test
    adapter.sessions.set(sessionId, {
      id: sessionId,
      adapterName: 'test',
      config: { workingDirectory: '/tmp', allowedFiles: [], forbiddenFiles: [], invariantRules: [], upstreamContext: '', downstreamContext: '', nodeTitle: '', acceptanceCriteria: [] },
      startTime: Date.now(),
    })
    // @ts-expect-error - protected
    adapter.sessionOutputBuffers.set(sessionId, ['hello world', 'lots of output'])

    const result = await adapter.compactContext(sessionId, 'summary')
    expect(result.strategy).toBe('summary')
    expect(result.tokensBefore).toBeGreaterThan(0)
    expect(result.startedAt).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('compactByNative throws by default', async () => {
    // @ts-expect-error
    adapter.sessions.set('s2', { id: 's2', adapterName: 'test', config: {} as any, startTime: 0 })
    await expect(adapter.compactContext('s2', 'native')).rejects.toThrow(/NATIVE_COMPACT_NOT_SUPPORTED/)
  })

  it('compactByLlm throws by default', async () => {
    // @ts-expect-error
    adapter.sessions.set('s3', { id: 's3', adapterName: 'test', config: {} as any, startTime: 0 })
    await expect(adapter.compactContext('s3', 'llm')).rejects.toThrow(/LLM_COMPACT_NOT_SUPPORTED/)
  })
})
```

- Run tests, tsc, lint.
- Commit.

---

### Task 3: AgentManager.compactContext orchestrator

**Files:**
- Modify: `src/main/agent/agent-manager.ts`
- Create: `src/main/__tests__/agent-manager-compact.test.ts`

**Step 1: Inject `CompactHistoryRepository` and `ChatRepository`.**

Add setters:
```ts
private compactHistoryRepo?: CompactHistoryRepository
private chatRepo?: ChatRepository

setCompactHistoryRepo(repo: CompactHistoryRepository): void {
  this.compactHistoryRepo = repo
}
setChatRepo(repo: ChatRepository): void {
  this.chatRepo = repo
}
```

Wire in `ipc-handlers.ts`:
```ts
agentManager.setCompactHistoryRepo(compactHistoryRepo)
agentManager.setChatRepo(new ChatRepository(db))
```

**Step 2: Add `compactInflight` deduplication.**

```ts
private compactInflight = new Map<string, Promise<CompactResult>>()
```

**Step 3: Implement `compactContext`:**

```ts
async compactContext(
  sessionId: string,
  strategy?: CompactStrategy,
  options?: { reason?: CompactTrigger }
): Promise<CompactResult> {
  // Dedup concurrent calls
  const existing = this.compactInflight.get(sessionId)
  if (existing) return existing

  const promise = this._doCompactContext(sessionId, strategy, options)
  this.compactInflight.set(sessionId, promise)
  try { return await promise }
  finally { this.compactInflight.delete(sessionId) }
}

private async _doCompactContext(
  sessionId: string,
  strategy?: CompactStrategy,
  options?: { reason?: CompactTrigger }
): Promise<CompactResult> {
  const state = this.sessionStates.get(sessionId)
  if (!state) {
    throw new AgentError(`Session ${sessionId} not found`, ErrorCode.AGENT_SESSION_NOT_FOUND)
  }
  const adapter = this.registry.get(state.adapterName)
  if (!adapter) {
    throw new AgentError(`Adapter ${state.adapterName} not found`, ErrorCode.AGENT_ADAPTER_NOT_FOUND)
  }
  const descriptor = ADAPTER_REGISTRY.find((d) => d.name === state.adapterName)
  const finalStrategy = strategy ?? descriptor?.defaultCompactStrategy ?? 'summary'
  const threadId = state.threadId

  // Broadcast "compacting" system message
  this.broadcaster.broadcast(state.broadcastName, {
    type: 'system',
    data: `Compacting context (${finalStrategy})...`,
    timestamp: Date.now(),
  })

  let result: CompactResult
  try {
    result = await adapter.compactContext(sessionId, finalStrategy, options)
  } catch (err) {
    // Native fallback to summary
    if (finalStrategy === 'native' || finalStrategy === 'llm') {
      logger.warn(`[Compact] ${finalStrategy} failed, falling back to summary:`, err)
      this.broadcaster.broadcast(state.broadcastName, {
        type: 'system',
        data: `Native compaction failed, falling back to summary rewrite.`,
        timestamp: Date.now(),
      })
      result = await adapter.compactContext(sessionId, 'summary', options)
    } else {
      throw err
    }
  }

  // Persist to history
  if (this.compactHistoryRepo && threadId) {
    try {
      await this.compactHistoryRepo.insert({
        threadId,
        sessionId,
        strategy: result.strategy,
        trigger: result.trigger,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        summary: result.summary ?? null,
        startedAt: result.startedAt,
        durationMs: result.durationMs,
      })
    } catch (err) {
      logger.warn('[Compact] Failed to insert history:', err)
    }
  }

  // Update thread.last_compacted_at
  if (this.chatRepo && threadId) {
    try {
      await this.chatRepo.setLastCompactedAt(threadId, result.startedAt)
      await this.chatRepo.resetContextTokens(threadId, result.tokensAfter)
    } catch (err) {
      logger.warn('[Compact] Failed to update thread waterline:', err)
    }
  }

  // Update waterline state
  if (this.waterline && threadId) {
    this.waterline.onCompacted(threadId, result.tokensAfter, result.startedAt)
  }

  // Broadcast completion
  this.broadcaster.broadcast(state.broadcastName, {
    type: 'system',
    data: `Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.durationMs}ms)`,
    timestamp: Date.now(),
  })

  return result
}
```

**Step 4: Subscribe to adapter `'usage'` events** in `registerAdapter`. Read the existing `registerAdapter` (around line 191). Add:

```ts
// Listen for usage events from this adapter
if (adapter instanceof BaseAdapter) {
  adapter.onUsage(({ sessionId, inputTokens, maxTokens }) => {
    const state = this.sessionStates.get(sessionId)
    if (state?.threadId && this.waterline) {
      this.waterline.onAdapterUsageReport(state.threadId, inputTokens, maxTokens ?? 200_000)
    }
  })
}
```

(If `BaseAdapter` import isn't available — adjust to use a duck-type check via `'onUsage' in adapter`.)

**Step 5: Create test file** `src/main/__tests__/agent-manager-compact.test.ts`:

Cover at minimum:
- Successful compact: orchestrator calls adapter, persists to repo, updates waterline
- Concurrent calls dedup via `compactInflight`
- Native fails → falls back to summary
- Missing session → throws
- No threadId → still compacts, just skips DB writes

Use mocked dependencies (mock the adapter's `compactContext` to return a fake `CompactResult`).

**Step 6:** Verify + commit.

---

### Task 4: Claude Code adapter — native via autoCompactEnabled + usage parsing

**Files:**
- Modify: `src/main/adapters/claude-code.ts`
- Create: `src/main/adapters/__tests__/claude-code-compact.test.ts`

**Step 1:** Implement `compactByNative` and `compactByLlm` (LLM unsupported for claude-code).

```ts
protected async compactByNative(
  sessionId: string,
  options?: { reason?: CompactTrigger }
): Promise<CompactResult> {
  const session = this.sessions.get(sessionId)
  if (!session) {
    throw new AdapterError(`Session ${sessionId} not found`, ErrorCode.AGENT_SESSION_NOT_FOUND, this.name)
  }
  const startedAt = Date.now()
  // Enable SDK's auto-compact for this session
  session.config = { ...session.config, /* SDK option marker */ }
  // The session's next query() call will apply autoCompactEnabled.
  // For an immediate effect, we'd need an active Query handle to call applyFlagSettings on.
  // Phase 3: signal completion; actual compaction happens on next query.
  const before = this.getEstimatedSessionTokens(sessionId)
  return {
    sessionId,
    strategy: 'native',
    trigger: options?.reason ?? 'manual',
    tokensBefore: before,
    tokensAfter: before,   // SDK will reduce on next query
    summary: '(deferred — SDK auto-compact enabled for next turn)',
    startedAt,
    durationMs: Date.now() - startedAt,
  }
}

private getEstimatedSessionTokens(sessionId: string): number {
  const buf = this.sessionOutputBuffers.get(sessionId) ?? []
  return estimateTokens(buf.join('\n'))
}
```

Set a session-config flag that the `query()` call will read:

```ts
// In session.config or a parallel map:
this.autoCompactEnabledFor.add(sessionId)
```

Where `autoCompactEnabledFor` is a `Set<string>` field. In the `query()` call (around line 95-100), check this set:

```ts
const options: QueryOptions = {
  // …existing options…
  autoCompactEnabled: this.autoCompactEnabledFor.has(sessionId) ? true : undefined,
}
```

**Step 2:** Parse `result.usage` and call `reportUsage`.

In the message loop (around line 139-181), when handling the `result` message:

```ts
if (message.type === 'result') {
  // …existing…
  if (message.usage) {
    const inputTokens = message.usage.input_tokens ?? 0
    this.reportUsage(sessionId, inputTokens)
  }
}
```

Check the SDK type — `result.usage.input_tokens` should be the right field.

**Step 3:** Test file `src/main/adapters/__tests__/claude-code-compact.test.ts`:

Mock the SDK and verify:
- `compactByNative` enables the flag for that sessionId
- Subsequent `query()` calls receive `autoCompactEnabled: true` in options
- `reportUsage` is called when a result message has `usage`

**Step 4:** Verify + commit.

---

### Task 5: MCP adapter — LLM summarisation strategy + usage parsing

**Files:**
- Modify: `src/main/adapters/mcp-adapter.ts`
- Create: `src/main/adapters/__tests__/mcp-compact.test.ts`

**Step 1:** Implement `compactByLlm`:

```ts
protected async compactByLlm(
  sessionId: string,
  options?: { reason?: CompactTrigger }
): Promise<CompactResult> {
  const session = this.sessions.get(sessionId)
  if (!session) {
    throw new AdapterError(`Session ${sessionId} not found`, ErrorCode.AGENT_SESSION_NOT_FOUND, this.name)
  }
  const buffer = this.sessionOutputBuffers.get(sessionId) ?? []
  const conversationText = buffer.join('\n').slice(0, 64_000) // cap input size
  const before = estimateTokens(conversationText)
  const startedAt = Date.now()

  // Use existing infrastructure to call LLM for a summary
  const summary = await this.summariseViaLlm(conversationText, session)
  const after = estimateTokens(summary)

  // Store as contextSummary so subsequent commands include it
  session.config.contextSummary = summary
  this.sessionOutputBuffers.set(sessionId, [])

  return {
    sessionId,
    strategy: 'llm',
    trigger: options?.reason ?? 'manual',
    tokensBefore: before,
    tokensAfter: after,
    summary,
    startedAt,
    durationMs: Date.now() - startedAt,
  }
}

private async summariseViaLlm(text: string, session: AgentSession): Promise<string> {
  // Build a minimal messages array for summarisation
  const summaryPrompt = `Summarise this conversation history concisely, preserving:
- Key decisions made
- Files modified
- Outstanding questions
- Recent context the next turn needs

Conversation:
${text}

Provide a clean text summary (max 1KB). No preamble.`

  // Use existing callLlmUnified (no tools needed for summary)
  // …call existing internal LLM helper with summaryPrompt…
  // Return the response text
}
```

Actual implementation: use the existing `callLlmUnified` / `callLlmWithToolSupport` helpers (`mcp-adapter.ts:786, 750`). Construct messages: `[{ role: 'system', content: 'You are a conversation summariser.' }, { role: 'user', content: summaryPrompt }]`. No tools needed.

**Step 2:** Parse response `usage`. In the response parsers (around line 65-150), extract `usage.input_tokens` (Anthropic) or `usage.prompt_tokens` (OpenAI/DeepSeek):

```ts
// In parseAnthropicResponse:
return {
  text,
  toolCalls,
  stopReason,
  usage: response.usage,   // { input_tokens, output_tokens, ... }
}
```

In `doSendCommand`, after receiving the parsed response, call `reportUsage`:

```ts
if (parsed.usage) {
  this.reportUsage(sessionId, parsed.usage.input_tokens, /* max */ 200_000)
}
```

**Step 3:** Test file `src/main/adapters/__tests__/mcp-compact.test.ts`:

Mock the `fetch` HTTP call, verify:
- `compactByLlm` produces a non-empty summary and stores it in `session.config.contextSummary`
- The HTTP request body for summarisation uses the right prompt format
- `tokensAfter` is less than `tokensBefore`

**Step 4:** Verify + commit.

---

### Task 6: Codex adapter — usage parsing only (no native compact)

**Files:**
- Modify: `src/main/adapters/codex.ts`

Codex SDK has no compaction method. The default `compactBySummaryRewrite` (from BaseAdapter) is sufficient for `summary` strategy. Native and LLM remain unsupported (throws).

**Step 1:** Parse `TurnCompletedEvent.usage`. In the message loop (around codex.ts:91 — `await thread.run(...)`):

```ts
const result = await thread.run(prompt)
if (result.usage) {
  const inputTokens = (result.usage.input_tokens ?? 0) + (result.usage.cached_input_tokens ?? 0)
  this.reportUsage(sessionId, inputTokens)
}
```

If `result.usage` isn't directly on the return, check `result.items` for `TurnCompletedEvent` entries (`event.type === 'turn_completed'`).

**Step 2:** Verify + commit.

---

### Task 7: Registry capabilities + default strategies

**Files:**
- Modify: `src/main/adapters/registry.ts`

Add `defaultCompactStrategy: CompactStrategy` to `AdapterDescriptor`. Populate `capabilities` + `defaultCompactStrategy` for each:

| Adapter | Add to `capabilities` | `defaultCompactStrategy` |
|---|---|---|
| `claude-code` | `NativeCompact`, `SummaryRewrite` | `'native'` |
| `codex` | `SummaryRewrite` | `'summary'` |
| `cursor`, `opencode`, `cline`, `kilo-code`, `kimi-code`, `codebuddy`, `qoder`, `qwen-code` | `SummaryRewrite` | `'summary'` |
| `mcp` | `LlmCompact`, `SummaryRewrite` | `'llm'` |

Also add `contextWindow` defaults if not already present from Phase 2 Task 24.

**Step 2:** Verify + commit.

---

### Task 8: Wire compactNow IPC

**Files:**
- Modify: `src/main/ipc/context-waterline.ts`

Replace the Phase 2 stub:

```ts
typedHandle('context:compactNow', async (_, sessionId: unknown, strategy: unknown): Promise<CompactResult> => {
  const sid = ensureString('sessionId', sessionId)
  const strat = strategy === undefined ? undefined : ensureString('strategy', strategy) as CompactStrategy
  return agentManager.compactContext(sid, strat, { reason: 'manual' })
})
```

This requires the IPC handler to receive an `AgentManager` reference. Update `registerContextHandlers` signature to take `agentManager`:

```ts
export function registerContextHandlers(
  waterline: ContextWaterline,
  agentManager: AgentManager,
  typedHandle: TypedHandle,
  compactHistoryRepo?: CompactHistoryRepository,
  getMainWindow?: () => BrowserWindow | null,
): void { /* … */ }
```

And update the call site in `ipc-handlers.ts`.

Also update the IPC channel return type in `src/shared/types/ipc.ts`:

```ts
'context:compactNow': (sessionId: string, strategy?: string) => Promise<CompactResult>
```

(`CompactResult` is already exported from `@shared/types`.)

**Step 2:** Verify + commit.

---

### Task 9: UI — Compact button + system message rendering

**Files:**
- Modify: `src/renderer/components/agent/ContextWaterlineBar.tsx`
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

**Step 1:** Add a "Compact" button to `ContextWaterlineBar`. Receive a callback prop:

```tsx
interface Props {
  state: ContextState | null
  capabilities?: AdapterCapability[]
  onCompact?: (strategy?: CompactStrategy) => void
}
```

Append after the timestamp chip:

```tsx
{onCompact && (
  <button
    onClick={() => onCompact()}
    className="text-[10px] px-1.5 py-0.5 rounded hover:bg-muted border border-border"
    title="Compact context now"
  >
    Compact
  </button>
)}
```

For strategy selection — Phase 3 ships a simple button; the dropdown is a follow-up (cosmetic).

**Step 2:** In `AgentChatPanel.tsx`, wire `onCompact`:

```tsx
const handleCompact = useCallback(async (strategy?: CompactStrategy) => {
  if (!currentThread?.sessionId) return
  try {
    await window.electronAPI['context:compactNow'](currentThread.sessionId, strategy)
  } catch (err) {
    console.error('Compact failed:', err)
  }
}, [currentThread?.sessionId])

// pass to ChatHeader:
<ChatHeader
  // …existing…
  onCompact={handleCompact}
/>
```

Update `ChatHeader.tsx` to forward `onCompact` to `<ContextWaterlineBar />`.

**Step 3:** Verify + commit.

---

### Task 10: Settings persistence — autoCompactEnabled defaults true

**Files:**
- Modify: `src/main/ipc/settings.ts`

Replace the Phase 2 stub with real read/write that persists to `settings.json` and updates the `ContextWaterline` runtime config.

Read existing settings infrastructure (likely `src/main/settings-store.ts` or similar). Add a section for waterline config. Default `autoCompactEnabled: true` for Phase 3.

```ts
typedHandle('settings:getContextWaterlineConfig', async () => {
  const settings = await loadSettings()
  return {
    autoCompactEnabled: settings.contextWaterline?.autoCompactEnabled ?? true,
    autoCompactThreshold: settings.contextWaterline?.autoCompactThreshold ?? 0.75,
    minCompactInterval: settings.contextWaterline?.minCompactInterval ?? 60_000,
  }
})

typedHandle('settings:setContextWaterlineConfig', async (_, cfg) => {
  const settings = await loadSettings()
  settings.contextWaterline = { ...settings.contextWaterline, ...cfg }
  await saveSettings(settings)
  // Apply to runtime
  if (cfg.autoCompactEnabled !== undefined) waterline.autoCompactEnabled = cfg.autoCompactEnabled
  if (cfg.autoCompactThreshold !== undefined) waterline.autoCompactThreshold = cfg.autoCompactThreshold
  if (cfg.minCompactInterval !== undefined) waterline.minCompactInterval = cfg.minCompactInterval
})
```

The `waterline` reference comes via dependency injection in the handler registration.

On startup, load settings and apply to `ContextWaterline`:
```ts
const settings = loadSettings()
waterline.autoCompactEnabled = settings.contextWaterline?.autoCompactEnabled ?? true
// ...
```

**Step 2:** Verify + commit.

---

### Task 11: Final verification

- [ ] `npm run test` — all pass
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — baseline preserved
- [ ] Manual: verify the Compact button in ChatHeader triggers a real compaction
- [ ] Verify auto-compact fires at 75% threshold (set `autoCompactEnabled = true` in settings)
- [ ] Verify compact_history rows are persisted in DB
- [ ] Verify "Compacted: X → Y tokens" appears as a system bubble in chat

---

## Self-review

**Spec coverage (Module 3):**

| Spec item | Task | Notes |
|---|---|---|
| `BaseAdapter.compactContext` abstract | 2 | Concrete dispatch + three strategy methods |
| `compactBySummaryRewrite` default | 2 | Reuses existing `buildAndStoreSummary` |
| Claude Code native via SDK `/compact` | 4 | **Revised:** SDK has no slash-command API; uses `autoCompactEnabled` flag instead |
| MCP `compactByLlm` | 5 | Summarises buffer via extra LLM call, stores as `contextSummary` |
| Codex native | 6 | **Revised:** SDK has no compact method; only `summary` available |
| `AgentManager.compactContext` orchestrator | 3 | Dedup, broadcast, persist, waterline update, fallback |
| Adapter capability registry | 7 | NativeCompact / LlmCompact / SummaryRewrite + defaultCompactStrategy |
| Auto-compact in `resolveAndSendCommand` | 1 | "Compact before send" — actually awaits now |
| Error fallback (native → summary) | 3 | try/catch around adapter call |
| `compactInflight` dedup | 3 | `Map<sessionId, Promise>` |
| 30s timeout | — | Deferred — can add later if needed |
| IPC `context:compactNow` real | 8 | Calls `AgentManager.compactContext` |
| UI compact button | 9 | Single button (strategy dropdown is a follow-up) |
| Settings: `autoCompactEnabled` default `true` | 10 | Phase 3 default; persistence to settings.json |
| `output.type='system'` for status messages | 1 | Added to AgentOutput union + handler |
| `threadId` on SessionState | 1 | From AgentSessionConfig at startSession |
| Usage reporting (Claude / Codex / MCP) | 4, 5, 6 | reportUsage → ContextWaterline |

**Placeholder scan:** Several spec details simplified for Phase 3 ship:
- No strategy dropdown UI (single button only)
- No `--force` fallback strategy override beyond native→summary
- No 30s timeout enforcement (relies on caller timeout)

These are documented and can ship as follow-ups.

**Risks:**
- Claude SDK's `autoCompactEnabled` is a per-query option, not a runtime-toggleable flag. The "native compact" effectively means "next query will use auto-compact" — there's no immediate token reduction. This is honestly reflected in the `summary: '(deferred — SDK auto-compact enabled for next turn)'` text. Users wanting immediate compaction should pick `summary` strategy.
- MCP `compactByLlm` reads from `sessionOutputBuffers` which is heuristic — it captures stdout, not structured messages. The summary quality depends on what was buffered. Acceptable for Phase 3.
- Session→thread mapping now requires renderer to pass `threadId` in startSession config. If any existing code path bypasses this, the waterline won't track. Phase 3 Task 1 documents this requirement.