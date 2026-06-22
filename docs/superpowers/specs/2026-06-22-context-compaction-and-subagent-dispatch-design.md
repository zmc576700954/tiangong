# Context Compaction & Subagent Dispatch — Design

**Date:** 2026-06-22
**Status:** Approved, pending implementation plan
**Scope:** Strengthen context awareness and auto-compaction across all adapters, differentiate per-adapter compaction commands, and introduce a Claude Code–style subagent dispatch framework.

## Goals

1. **Visible, controllable context waterline** — surface live token usage per thread, expose manual `/compact`, and trigger automatic compaction before the window fills.
2. **Adapter-aware compaction** — replace today's single "buffer-summary" approach with three differentiated strategies (`native` / `llm` / `summary`) chosen per adapter capability.
3. **Subagent dispatch (Claude Code Task model)** — the parent session keeps full control; subagents are ephemeral workers spawned via a tool call, returning structured results that flow back into the parent's reasoning. Spawn paths are unified: parent-agent-via-tool is the only dispatch path; node "Fan-out" simply pre-fills a parent prompt.

## Non-goals

- Replacing the existing `ObserverCompressor` / `PromptOrchestrator` memory pipeline (they continue to back the waterline).
- Introducing an arbitrary DAG scheduler with explicit dependency graphs at the user level (the parent agent expresses ordering through repeated tool calls).
- Cross-session shared subagent caches.

---

## Module 1 — Shared Types & Database

### 1.1 Shared types

**`src/shared/types/agent.ts`** — new capability flags and config fields:

```ts
export enum AdapterCapability {
  Resume = 'resume',
  NativeCompact = 'native-compact',
  LlmCompact = 'llm-compact',
  SummaryRewrite = 'summary-rewrite',
  SwarmCoordinator = 'swarm-coord',
}

export type CompactStrategy = 'native' | 'llm' | 'summary';
export type CompactTrigger = 'manual' | 'auto-threshold' | 'auto-token-limit';

export interface CompactResult {
  sessionId: string;
  strategy: CompactStrategy;
  trigger: CompactTrigger;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  startedAt: number;
  durationMs: number;
}

export interface AgentSessionConfig {
  // …existing fields…
  parentSessionId?: string;
  swarmTaskId?: string;
}

export interface AgentThread {
  // …existing fields…
  parentThreadId?: string;            // reserved; not used by subagent flow
  contextTokensUsed?: number;
  contextWindowMax?: number;
  lastCompactedAt?: number;
}
```

**`src/shared/types/swarm.ts`** — left **unchanged**. The existing `SwarmTask` / `SwarmConfig` types are kept as future-compatibility surface but are **not used** by the dispatch flow described here. The runtime row for each subagent call is `subagent_invocations` (see 4.2). No `SwarmRunRecord` or `swarm_runs` table is introduced.

### 1.2 Database (`src/main/database.ts`)

Bump `CURRENT_SCHEMA_VERSION` from `3` to `4`.

**ALTER existing tables** (via `runIncrementalMigrations`):

```sql
ALTER TABLE chat_messages ADD COLUMN token_count INTEGER DEFAULT 0;
ALTER TABLE chat_threads  ADD COLUMN parent_thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL;
ALTER TABLE chat_threads  ADD COLUMN context_tokens_used INTEGER DEFAULT 0;
ALTER TABLE chat_threads  ADD COLUMN context_window_max INTEGER DEFAULT 200000;
ALTER TABLE chat_threads  ADD COLUMN last_compacted_at INTEGER;
```

**New tables:**

```sql
CREATE TABLE compact_history (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES chat_threads(id) ON DELETE CASCADE,
  session_id TEXT,
  strategy TEXT NOT NULL,
  trigger TEXT NOT NULL,
  tokens_before INTEGER NOT NULL,
  tokens_after INTEGER NOT NULL,
  summary TEXT,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE TABLE subagent_invocations (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  parent_message_id TEXT REFERENCES chat_messages(id),
  graph_id TEXT REFERENCES graphs(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  adapter_name TEXT,
  node_id TEXT,
  allowed_files TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  result_text TEXT,
  result_files TEXT,
  tokens_used INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX idx_subagent_inv_parent ON subagent_invocations(parent_session_id);
CREATE INDEX idx_subagent_inv_status ON subagent_invocations(status);
```

All new columns are nullable / have defaults so older code paths continue to function during a phased rollout.

---

## Module 2 — Context Waterline & Auto-trigger

### 2.1 `ContextWaterline` service

New file `src/main/memory/context-waterline.ts`. Tracks per-thread token usage as an in-memory map backed by `chat_threads` columns.

```ts
export class ContextWaterline {
  private state = new Map<string, ContextState>();
  private emitter = new EventEmitter();

  onMessagePersisted(threadId: string, message: ChatMessage): void;
  onAdapterUsageReport(sessionId: string, used: number, max: number): void;
  onCompacted(threadId: string, tokensAfter: number, summary?: string): void;

  getRatio(threadId: string): number;
  shouldAutoCompact(threadId: string): boolean;
  onChange(handler: (s: ContextState) => void): Unsubscribe;
}
```

Three input sources:
- **Estimation** — when a message lands in `chat_messages`, `estimateTokens(content)` fills `token_count` and increments `chat_threads.context_tokens_used`.
- **Authoritative usage** — adapters that receive a real `usage` payload (Claude Code SDK `system/init`, Codex SDK, MCP API responses) call `BaseAdapter.reportUsage()`, which **overrides** the estimate.
- **Compaction completion** — replaces `used` with `tokensAfter` and stamps `last_compacted_at`.

`context_window_max` is sourced from `ADAPTER_REGISTRY[].contextWindow` (model-aware default: 200 000 for Claude Sonnet/Opus 4, 128 000 for Codex, 64 000 for DeepSeek, etc.).

### 2.2 Auto-trigger logic

`AgentManager.resolveAndSendCommand` consults `ContextWaterline.shouldAutoCompact(threadId)` **before** invoking the adapter. When `true` and auto-compact is enabled:

1. Broadcast a `system`-type output to the parent thread: *"Compacting context (…)…"*.
2. `await adapter.compactContext(sessionId, defaultStrategy, { reason: 'auto-threshold' })`.
3. Broadcast a completion message: *"Compacted: 152k → 38k tokens"*.
4. Proceed with the original `sendCommand`.

The **"compact before send" ordering is intentional** so that the very next user turn always lands in a freshly-trimmed window.

### 2.3 Settings (`settings` IPC)

- `contextWaterline.autoCompactEnabled: boolean = true` (defaults false in Phase 2; true after Phase 3)
- `contextWaterline.autoCompactThreshold: number = 0.75` (range 0.5–0.95)
- `contextWaterline.minCompactInterval: number = 60_000` (ms since `last_compacted_at`)

### 2.4 IPC

```ts
'context:getWaterline'(threadId): Promise<ContextState>
'context:onWaterlineChange'(handler): Unsubscribe
'context:compactNow'(sessionId, strategy?): Promise<CompactResult>
'context:listHistory'(threadId): Promise<CompactHistoryEntry[]>
```

Renderer-side store subscribes once per visible thread; broadcasts are throttled to 500 ms to avoid UI churn.

### 2.5 UI (`ChatHeader.tsx`)

A new `ContextWaterlineBar` row:

```
▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░  76%  (152k / 200k)   [▼ 压缩]   ⏱ 5m
```

- Bar colour: green < 50 %, yellow 50–75 %, red > 75 %.
- "压缩" splits into a dropdown — entries are filtered by `AdapterCapability`; unsupported strategies are disabled with a tooltip.
- The `⏱ 5m` chip opens `CompactHistoryPopover` showing recent `compact_history` rows.

### 2.6 Token estimation precision

Phase 2 ships `estimateTokens()` (existing heuristic). Phase 3 adds optional model-aware tokenizers:
- `gpt-tokenizer` for OpenAI / Codex paths;
- Anthropic's published byte heuristic for Claude paths;
- fallback heuristic otherwise.

Authoritative usage reports take priority over any estimator.

---

## Module 3 — Adapter-differentiated Compaction

### 3.1 Adapter registry (`src/main/adapters/registry.ts`)

Each adapter declares `capabilities`, `contextWindow`, and `defaultCompactStrategy`:

| Adapter | Capabilities | Window | Default strategy |
|---|---|---|---|
| `claude-code` | Resume, NativeCompact, SwarmCoordinator | 200 000 | `native` |
| `codex` | Resume, NativeCompact | 128 000 | `native` |
| `cursor` | Resume, SummaryRewrite | 128 000 | `summary` |
| `mcp-adapter` | LlmCompact, SwarmCoordinator | 200 000 | `llm` |
| `opencode`, `cline`, `kilo-code`, `kimi-code`, `codebuddy`, `qoder`, `qwen-code` | SummaryRewrite | 128 000 | `summary` |

UI honours `capabilities` to decide which dropdown entries appear; `defaultCompactStrategy` is the preselected option.

### 3.2 `BaseAdapter` abstract method

```ts
abstract class BaseAdapter {
  abstract compactContext(
    sessionId: string,
    strategy: CompactStrategy,
    options?: { reason?: string }
  ): Promise<CompactResult>;

  protected async compactBySummaryRewrite(sessionId: string): Promise<CompactResult>;
  protected async compactByNative(sessionId: string): Promise<CompactResult> {
    throw new AdapterError('NATIVE_COMPACT_NOT_SUPPORTED');
  }
  protected async compactByLlm(sessionId: string): Promise<CompactResult> {
    throw new AdapterError('LLM_COMPACT_NOT_SUPPORTED');
  }

  protected reportUsage(sessionId: string, inputTokens: number, maxTokens?: number): void;
}
```

The `compactBySummaryRewrite` default delegates to the existing `buildAndStoreSummary(sessionId, buffer)` (`src/main/adapters/base.ts:700`), then returns a `CompactResult` filled from `sessionOutputBuffers` size deltas.

### 3.3 Per-adapter implementations

- **Claude Code (`claude-code.ts`)** — `compactByNative` sends `'/compact'` as a user message through the SDK, reuses `session.config.resumeSessionId`, listens for the next `system/init` `usage` to update the waterline.
- **Codex (`codex.ts`)** — `compactByNative` calls `thread.compact()` if exposed by the SDK; otherwise falls back to `compactBySummaryRewrite`. The fallback is decided at adapter construction (capability check), not per call.
- **MCP (`mcp-adapter.ts`)** — `compactByLlm` invokes a cheap model (Haiku-tier) with the in-memory `sessionMessages`, replaces them with `[{ role: 'system', content: summary }]`, recomputes token usage from the summary.
- **All other CLI adapters** — inherit `compactBySummaryRewrite` only.

### 3.4 `AgentManager.compactContext`

```ts
async compactContext(sessionId, strategy?, reason?): Promise<CompactResult> {
  // 1. Resolve adapter via SessionRouter.
  // 2. finalStrategy = strategy ?? adapter.descriptor.defaultCompactStrategy.
  // 3. Broadcast "Compacting context (…)…" system message.
  // 4. const result = await adapter.compactContext(sessionId, finalStrategy, { reason }).
  // 5. ContextWaterline.onCompacted(threadId, result.tokensAfter, result.summary).
  // 6. ChatRepository.insertCompactHistory(result).
  // 7. Broadcast "Compacted: <before> → <after> tokens" system message.
  // 8. Return result.
}
```

### 3.5 Errors & degradation

- Native failure → automatic fallback to `summary`, toast: *"Native compaction failed, fell back to summary rewrite."*
- Re-entrant call → `compactInflight: Map<sessionId, Promise<CompactResult>>` returns the in-flight promise.
- 30 s timeout → `AdapterError('COMPACT_TIMEOUT')`, session state unchanged.

---

## Module 4 — Subagent Dispatch (Claude Code Task model)

### 4.1 Paradigm

- Subagents are **ephemeral**. They do not own a `chat_thread`; their stdout streams to the parent session tagged with `invocationId`, and their final text becomes the parent's tool result.
- The **parent session is the only orchestrator**. There is no separate DAG scheduler exposed to the user; the parent agent expresses ordering by making sequential or simultaneous `dispatch_subagent` tool calls across turns.
- Spawn paths converge on one IPC entry: `parent agent's tool call → SubagentManager.invoke()`. Node "Fan-out" simply pre-fills a parent prompt; it does not bypass the parent agent.

### 4.2 Data model (already declared in Module 1)

The runtime row is `subagent_invocations`. `chat_threads.parent_thread_id` is reserved for future grouping but **unused** by this flow.

### 4.3 `AgentTypeDefinition` (`src/main/agent/agent-types.ts`)

```ts
export interface AgentTypeDefinition {
  name: string;
  displayName: string;
  description: string;
  allowedTools: ToolName[] | '*';
  defaultAdapter?: string;
  defaultModel?: string;
  systemPromptAddon?: string;
  scopeStrategy: 'inherit' | 'subset' | 'fresh';
  summarizeResult?: boolean;          // optional LLM-summarise result_text before returning to parent
}

export const BUILT_IN_AGENT_TYPES: AgentTypeDefinition[] = [
  { name: 'explore',   allowedTools: ['Read','Glob','Grep','WebFetch'], scopeStrategy: 'inherit',  /* … */ },
  { name: 'implement', allowedTools: ['Read','Edit','Write','Bash','Glob','Grep'], scopeStrategy: 'subset',   /* … */ },
  { name: 'review',    allowedTools: ['Read','Glob','Grep'],            scopeStrategy: 'inherit',  /* … */ },
  { name: 'fix',       allowedTools: ['Read','Edit','Bash'],            scopeStrategy: 'subset',   /* … */ },
  { name: 'general',   allowedTools: '*',                                scopeStrategy: 'subset',   /* … */ },
];
```

Users add custom types via `settings:setSubagentTypes`.

### 4.4 Tool exposure per adapter

| Adapter | Mechanism (`SubagentCapability`) |
|---|---|
| `claude-code` | `native-task` — register a `bizgraph.dispatchSubagent` tool through the SDK hook, intercept `tool_use` events. |
| `mcp-adapter` | `api-tool` — append a `dispatch_subagent` tool to the request payload's `tools` array; intercept in the existing tool loop. |
| CLI adapters (`opencode`, `cline`, `kilo-code`, `kimi-code`, `codebuddy`, `qoder`, `qwen-code`, `cursor`) | `inline-protocol` — append a contract to the scope prompt instructing the model to emit `<bizgraph:subagent>{…JSON…}</bizgraph:subagent>` blocks. `BaseAdapter`'s stdout parser intercepts them, runs the subagent, and replays the result via stdin if the adapter supports interactive replay; otherwise the result is appended to `contextSummary` for the next run. |

Phase 4 ships `native-task` + `api-tool`. `inline-protocol` is deferred to a later phase but the contract is reserved.

Tool schema (presented to the parent agent):

```jsonc
{
  "name": "dispatch_subagent",
  "description": "Spawn an ephemeral subagent for a focused task. Multiple calls may be issued in one turn to run in parallel.",
  "input_schema": {
    "type": "object",
    "properties": {
      "agent_type":   { "type": "string", "enum": ["explore","implement","review","fix","general", "<custom>"] },
      "description":  { "type": "string", "description": "3-5 word label" },
      "prompt":       { "type": "string", "description": "Full task instructions — the subagent only sees this." },
      "adapter_name": { "type": "string", "description": "Optional adapter override." },
      "node_id":      { "type": "string", "description": "Optional canvas node binding." },
      "allowed_files":{ "type": "array", "items": { "type": "string" } }
    },
    "required": ["agent_type","description","prompt"]
  }
}
```

### 4.5 `SubagentManager` (`src/main/agent/subagent-manager.ts`)

```ts
async invoke(args: SubagentInvokeArgs): Promise<SubagentResult> {
  // 1. Validate agentType + scopeStrategy.
  // 2. Resolve sandbox:
  //    - 'subset'  → allowedFiles ⊆ parent.allowedFiles (reject otherwise).
  //    - 'inherit' → reuse parent sandbox handle (read-only enforced via allowedTools).
  //    - 'fresh'   → new sandbox from args.allowedFiles.
  // 3. Insert subagent_invocations row, status='queued'.
  // 4. AgentManager.startSession({ adapterName, …, parentSessionId, swarmTaskId: invocationId }).
  // 5. AgentManager.resolveAndSendCommand({ prompt }) with allowedTools restriction injected into scope prompt.
  // 6. Await terminal output ('complete' event). Collect:
  //    - final assistant text → result_text
  //    - file_change events → result_files
  //    - usage → tokens_used
  // 7. Optionally summarise result_text via LLM if agentType.summarizeResult.
  // 8. Update row status='completed'; terminate session.
  // 9. Return SubagentResult { resultText, resultFiles, durationMs, tokensUsed }.
}

async cancel(invocationId: string): Promise<void>;
listActive(parentSessionId: string): SubagentInvocation[];
onProgress(handler): Unsubscribe;
```

Concurrency cap per parent session: `subagentMaxConcurrent` (default 5). Excess invocations queue.

Implicit serialisation: when two queued/running invocations have overlapping `allowed_files` (write intent), the later one waits for the earlier to finish. The check runs at enqueue time.

### 4.6 Parent session view

In the parent thread message list, an assistant message that contains a `dispatch_subagent` tool call renders as `SubagentInvocationCard` (instead of the generic tool-use bubble). Stream updates push through `subagent:onProgress`.

Completion frame embeds the `result_text` summary; the parent agent receives the full text as `tool_result` content and continues reasoning. Result text is **not** stored as a `chat_messages` row — it lives in `subagent_invocations.result_text` and is referenced via the parent message's `tool_calls` JSON.

### 4.7 Node status linkage

- Subagent starts with `node_id` set → `placeholder` → `developing`.
- Completion with `file_change` events intersecting `node.metadata.linkedFiles` → `developing` → `completed`.
- Failure records `node.metadata.lastSubagentError`; no state change.

### 4.8 IPC

```ts
'subagent:listTypes'(): Promise<AgentTypeDefinition[]>
'subagent:listInvocations'(parentSessionId): Promise<SubagentInvocation[]>
'subagent:cancel'(invocationId): Promise<void>
'subagent:onProgress'(parentSessionId, handler): Unsubscribe
'subagent:getResult'(invocationId): Promise<SubagentResult | null>
'adapter:getCapabilities'(adapterName): Promise<AdapterCapability[]>
'settings:getSubagentTypes'(): Promise<AgentTypeDefinition[]>
'settings:setSubagentTypes'(types): Promise<void>
'settings:getSubagentMaxConcurrent'(): Promise<number>
'settings:setSubagentMaxConcurrent'(n): Promise<void>
```

### 4.9 Node-driven Fan-out (template-only)

Canvas right-click `Fan-out → 派发子代理`:
1. Open `FanoutPromptDialog`.
2. Pre-fill the parent chat input with a template referencing selected nodes:
   ```
   请你为以下节点各派发一个 implement 子代理并行执行:
   - {node1.title} ({node1.id}, files: {linkedFiles})
   - …
   要求:对每个节点用 dispatch_subagent 工具发起任务,各任务允许并行,等所有完成后给我汇总。
   ```
3. User reviews/edits, presses Send. From that point the parent agent owns the dispatch decisions.

No separate scheduler, no separate `swarm:dispatch` IPC — fan-out is a UX shortcut, not a parallel runtime.

### 4.10 Scope guard interaction

- `subset` — child `allowedFiles` validated as subset of parent sandbox's allow-list; if parent has none, child uses its own allow-list to create a fresh sandbox.
- `inherit` — child reuses parent sandbox handle (no backup overhead); writes blocked by `allowedTools`.
- `fresh` — full-new sandbox; allow-list mandatory.
- Concurrent write intent overlap → enqueue-time serialisation (see 4.5).

---

## Module 5 — UI/UX, IPC catalogue, Testing, Rollout, Risks

### 5.1 UI changes

| File | Change |
|---|---|
| `ChatHeader.tsx` | Mount `ContextWaterlineBar`; mount `[Active subagents (n)]` toggle opening `SubagentInvocationsPanel`. |
| `ChatBubble.tsx` | Detect `tool_use` named `dispatch_subagent` → render `SubagentInvocationCard`. |
| `ChatInput.tsx` / `SlashCommandMenu.tsx` | Register `/compact`, `/clear`, `/dispatch` slashes. |
| `promptTemplates.ts` | Add the slashes plus template strings. |
| **New** `SubagentInvocationCard.tsx` | Live status, collapsible output, cancel button. |
| **New** `SubagentInvocationsPanel.tsx` | Side-drawer listing all invocations for the current parent session. |
| **New** `ContextWaterlineBar.tsx` | Progress + ratio + compact dropdown. |
| **New** `CompactHistoryPopover.tsx` | Recent `compact_history` rows on chip click. |
| **New** `FanoutPromptDialog.tsx` | Pre-fills the chat input from selected nodes. |
| Canvas right-click `useNodeContextMenu.ts` | New menu item *派发子代理…* |
| Project settings panel | New tabs: *子代理类型* and *上下文水位*. |
| `useAgentOutputListener.ts` | Route outputs carrying an `invocationId` tag to the matching invocation card instead of the main message list. |

Subagent output is broadcast via `OutputBroadcaster` carrying `{ invocationId }`. It does **not** create `chat_messages` rows; the final result text persists inside the parent message's `tool_calls` JSON for replay.

### 5.2 Full IPC catalogue (incremental over current preload + `ipc/agent.ts`)

```ts
// Context waterline
'context:getWaterline'(threadId): Promise<ContextState>
'context:onWaterlineChange'(handler): Unsubscribe
'context:compactNow'(sessionId, strategy?): Promise<CompactResult>
'context:listHistory'(threadId): Promise<CompactHistoryEntry[]>

// Subagents
'subagent:listTypes'(): Promise<AgentTypeDefinition[]>
'subagent:listInvocations'(parentSessionId): Promise<SubagentInvocation[]>
'subagent:cancel'(invocationId): Promise<void>
'subagent:onProgress'(parentSessionId, handler): Unsubscribe
'subagent:getResult'(invocationId): Promise<SubagentResult | null>

// Adapter capabilities (UI gating)
'adapter:getCapabilities'(adapterName): Promise<AdapterCapability[]>

// Settings
'settings:getContextWaterlineConfig'(): Promise<{ autoCompactEnabled, autoCompactThreshold, minCompactInterval }>
'settings:setContextWaterlineConfig'(cfg): Promise<void>
'settings:getSubagentTypes'(): Promise<AgentTypeDefinition[]>
'settings:setSubagentTypes'(types): Promise<void>
'settings:getSubagentMaxConcurrent'(): Promise<number>
'settings:setSubagentMaxConcurrent'(n): Promise<void>
```

`src/shared/types/ipc.ts` (window.electronAPI table) is updated in lockstep.

### 5.3 Testing strategy

**Unit (Vitest):**

- `context-waterline.test.ts` — accumulation, authoritative override, threshold + min-interval gating.
- `compact-strategies.test.ts` — three strategies' `BaseAdapter` behaviour.
- `subagent-manager.test.ts` — invoke / cancel, scopeStrategy variants, allowed_files ⊆ enforcement, concurrency cap, implicit serialisation.
- `claude-code-compact.test.ts` — native `/compact` injection + usage report.
- `mcp-compact.test.ts` — LLM summarisation replaces `sessionMessages`.
- `opencode-compact.test.ts` — `compactBySummaryRewrite` fallback.
- `subagent-tool-injection.test.ts` — `dispatch_subagent` exposure across the three capability modes.
- `agent-types.test.ts` — built-in + custom merge, `allowedTools` validation.

**Integration:**

- mcp-adapter parent session triggers auto-compact; verify `sendCommand` occurs only after the compact promise resolves.
- claude-code parent calls `dispatch_subagent('explore')`; verify subagent output routes to its invocation card, not the parent thread.
- Multiple subagents with overlapping write allow-lists execute serially.
- Cancelling the parent session cascades cancellation to all active invocations.

**E2E (Playwright, `tests/e2e/`):**

- `subagent-dispatch.spec.ts` — node right-click Fan-out → template → send → invocation card lifecycle → node state transitions.
- `auto-compact.spec.ts` — long conversation hits threshold, UI shows the compact system messages and the bar shrinks.

**Performance:**

- `ContextWaterline` broadcasts throttled to 500 ms.
- Subagent stdout broadcast throttled via RAF in the renderer.
- `subagent_invocations` row writes update full-row (existing repository style).

### 5.4 Rollout phases

Five PRs landing sequentially:

1. **Phase 1 — Shared types + DB v4.** Schema migration, repositories, types, unit tests. No UI, no behaviour change.
2. **Phase 2 — Context waterline + auto-compact scaffolding.** Service, token estimation, IPC, `ChatHeader` progress bar. Adapters only report usage; real compaction not yet wired. `autoCompactEnabled` defaults `false`.
3. **Phase 3 — Adapter-differentiated compaction.** `BaseAdapter` abstraction + three strategy implementations. Capability registry, UI button gating. `autoCompactEnabled` defaults `true`.
4. **Phase 4 — Subagent backend.** `AgentTypeDefinition`, `SubagentManager`, `subagent_invocations` table, `dispatch_subagent` tool exposed via `native-task` and `api-tool`. `inline-protocol` deferred. IPC + unit tests; no renderer UI yet.
5. **Phase 5 — Subagent UI + node Fan-out.** Invocation card, side panel, context menu entry, `FanoutPromptDialog`, settings tabs. E2E coverage.

Phases 1–3 ship a usable v1 (waterline + compaction) with no subagent surface. Phases 4–5 add subagents incrementally.

### 5.5 Rollback

Feature flags (in `settings`):

- `experimental.contextWaterline`
- `experimental.autoCompact`
- `experimental.subagentDispatch` (defaults `false` until Phase 5 validated)

Disabling any flag returns the system to its prior behaviour (existing `ObserverCompressor` + no subagent surface). The v4 DB schema is **not** rolled back; all new columns are nullable / default-valued so older code paths continue to read and write without modification.

### 5.6 Risks & mitigations

| Risk | Mitigation |
|---|---|
| Parent agent over-uses `dispatch_subagent` on mcp-adapter, runaway tokens. | `subagentMaxConcurrent`; each invocation contributes to its own waterline so parent+children stay observable. |
| Subagent infinite loop. | Per-invocation timeout 5 min → `failed` + force terminate. |
| Concurrent subagents writing the same file. | Implicit enqueue-time serialisation (4.5) + ScopeGuard's existing rollback as a safety net. |
| Native `/compact` SDK semantics unknown. | Phase 3 begins with a spike to characterise SDK behaviour; if unsupported, capability is downgraded and `summary` becomes the default. |
| Token estimator drift causes premature/late auto-compact. | Authoritative `reportUsage` overrides estimates; thresholds user-tunable; estimator upgraded in Phase 3. |
| Long subagent `result_text` re-pollutes parent context. | `AgentTypeDefinition.summarizeResult` runs a Haiku-tier summary before the value is returned as `tool_result`. |

---

## Open items deferred

- `inline-protocol` `dispatch_subagent` for adapters without bidirectional stdin replay (post Phase 5).
- Cross-thread subagent re-use (caching `explore` results across parent sessions) — explicitly out of scope for now.
- A dedicated DAG scheduler — the parent agent handles ordering through multi-turn reasoning.
