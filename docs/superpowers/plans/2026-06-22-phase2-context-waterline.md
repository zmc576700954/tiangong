# Phase 2 — Context Waterline & Auto-compact Scaffolding

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface live token usage per thread — backend service, IPC push, and a UI progress bar in ChatHeader. Wire `token_count` into message persistence. Set up auto-compact threshold checking (gated off by default). Phase 2 is **observability scaffolding** — no real compaction logic (that's Phase 3).

**Architecture:** A new `ContextWaterline` service in `src/main/memory/context-waterline.ts` maintains an in-memory `Map<threadId, ContextState>`. It receives inputs from three paths: (1) `onMessagePersisted` estimates tokens at message-create time, (2) `onAdapterUsageReport` will later accept real usage from adapters, (3) `onCompacted` will reset after compaction. State changes are emitted via an event emitter, picked up by an IPC handler that pushes to the renderer.

**Spec reference:** `docs/superpowers/specs/2026-06-22-context-compaction-and-subagent-dispatch-design.md` — Module 2.

---

## File Structure

| Path | Purpose |
|---|---|
| `src/shared/types/agent.ts` | (modify) extend `AgentOutput` with optional `invocationId`, add `ContextState` interface |
| `src/shared/types/ipc.ts` | (modify) add `context:*` channels to `IpcApi` |
| `src/main/memory/context-waterline.ts` | (create) `ContextWaterline` service |
| `src/main/adapters/base.ts` | (modify) add `reportUsage()` skeleton + `.emit('usage', ...)` |
| `src/main/adapters/registry.ts` | (modify) add `contextWindow` to `AdapterDescriptor` |
| `src/main/agent/agent-manager.ts` | (modify) hold `ContextWaterline` ref, wire into session lifecycle |
| `src/main/ipc/context.ts` | (create) `registerContextHandlers` — getWaterline, compactNow, listHistory |
| `src/main/ipc-handlers.ts` | (modify) instantiate `ContextWaterline`, register handlers |
| `src/main/services/chat-service.ts` | (modify) compute `token_count` during saveMessage |
| `src/main/repositories/chat-repository.ts` | (modify) extend `saveMessage` with `tokenCount`, extend `ChatThreadRow` with waterline columns |
| `src/preload/index.ts` | (modify) expose `context:*` channels + `onWaterlineChange` event |
| `src/renderer/components/agent/ChatHeader.tsx` | (modify) mount `ContextWaterlineBar` between title and right buttons |
| `src/renderer/components/agent/ContextWaterlineBar.tsx` | (create) progress bar + ratio + chip |
| `src/renderer/hooks/useWaterline.ts` | (create) subscribe to `onWaterlineChange`, expose state for current thread |
| `src/main/__tests__/context-waterline.test.ts` | (create) unit tests |
| `settings` config | (modify) register `contextWaterline.*` keys |

Phase 2 produces **no change to adapter compaction behaviour**. `autoCompactEnabled` defaults `false`.

---

## Phase 2 Tasks

### Task 1: Extend shared types for waterline (AgentOutput + ContextState)

**Files:**
- Modify: `src/shared/types/agent.ts`

Extend `AgentOutput` with an optional dispatch tag:

```ts
// Inside AgentOutput, add before closing brace:
invocationId?: string   // Phase 2: subagent output routing tag
```

Add a new interface at end of file:

```ts
// ============================================
// Context waterline (Phase 2)
// ============================================

/** Runtime waterline state for one thread. */
export interface ContextState {
  threadId: string
  tokensUsed: number
  tokensMax: number
  ratio: number                // 0.0–1.0, derived
  lastCompactedAt: number | null
  updatedAt: number
}
```

**Files:**
- Modify: `src/shared/types/ipc.ts`

In `IpcApi` interface, add the `context:*` channels:

```ts
'context:getWaterline'(threadId: string): Promise<ContextState | null>
'context:listHistory'(threadId: string): Promise<CompactHistoryEntry[]>
```

Also ensure `IpcApi` includes the event-only push channel (documentation type — actual runtime registration is in preload):

```ts
// Event push (preload registration only)
onWaterlineChange: (callback: (state: ContextState) => void) => () => void
```

Add to `IpcApi` the settings channels for waterline:

```ts
'settings:getContextWaterlineConfig'(): Promise<{
  autoCompactEnabled: boolean
  autoCompactThreshold: number
  minCompactInterval: number
}>
'settings:setContextWaterlineConfig'(cfg: {
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  minCompactInterval?: number
}): Promise<void>
```

- [ ] Type-check: `npx tsc --noEmit`
- [ ] Commit

---

### Task 2: Extend ChatRepository with token_count + waterline columns

**Files:**
- Modify: `src/main/repositories/chat-repository.ts`

**Step 1: Extend `ChatThreadRow` with waterline fields:**

```ts
export interface ChatThreadRow {
  // …existing fields…
  parent_thread_id: string | null
  context_tokens_used: number
  context_window_max: number
  last_compacted_at: number | null
}
```

All new fields are in the DB already (Phase 1 schema v4). We just need to add them to the row type and SELECT/INSERT.

**Step 2: Update `toChatThreadRow` mapper** to read the new columns:

```ts
function toChatThreadRow(row: Row): ChatThreadRow {
  return {
    // …existing fields…
    parent_thread_id: row.parent_thread_id != null ? String(row.parent_thread_id) : null,
    context_tokens_used: Number(row.context_tokens_used ?? 0),
    context_window_max: Number(row.context_window_max ?? 200000),
    last_compacted_at: row.last_compacted_at != null ? Number(row.last_compacted_at) : null,
  }
}
```

**Step 3: Update all SELECT queries** to include the 4 new columns in column lists — `getThread`, `listThreads`, `searchThreads`.

**Step 4: Add method to increment context_tokens_used:**

```ts
async incrementContextTokens(threadId: string, tokens: number): Promise<void> {
  await this.db.execute({
    sql: `UPDATE chat_threads
          SET context_tokens_used = context_tokens_used + ?, updated_at = ?
          WHERE id = ?`,
    args: [tokens, Date.now(), threadId],
  })
}

async setContextWindowMax(threadId: string, max: number): Promise<void> {
  await this.db.execute({
    sql: `UPDATE chat_threads SET context_window_max = ? WHERE id = ?`,
    args: [max, threadId],
  })
}

async setLastCompactedAt(threadId: string, timestamp: number): Promise<void> {
  await this.db.execute({
    sql: `UPDATE chat_threads SET last_compacted_at = ? WHERE id = ?`,
    args: [timestamp, threadId],
  })
}
```

**Step 5: Extend `saveMessage` input to accept `tokenCount`:**

Add `tokenCount?: number` to `saveMessage()`'s data param, and extend the SQL INSERT to include `token_count` column when present.

- [ ] Run existing repo tests: must pass
- [ ] Commit

---

### Task 3: ContextWaterline service

**Files:**
- Create: `src/main/memory/context-waterline.ts`

```ts
/**
 * ContextWaterline
 *
 * Tracks per-thread token usage and emits change events.
 * Three input sources:
 *   1. onMessagePersisted — estimateTokens() at message-create time
 *   2. onAdapterUsageReport — authoritative usage from adapter (Phase 3+)
 *   3. onCompacted — reset after compaction (Phase 3+)
 *
 * Change events are throttled to avoid UI churn.
 */

import { EventEmitter } from 'events'
import type { ContextState, CompactHistoryEntry } from '@shared/types'
import { estimateTokens } from '../shared/token-utils'
import type { CompactHistoryRepository } from '../repositories/compact-history-repository'

const THROTTLE_MS = 500

interface WaterlineState {
  threadId: string
  tokensUsed: number
  tokensMax: number
  lastCompactedAt: number | null
}

export class ContextWaterline {
  private state = new Map<string, WaterlineState>()
  private emitter = new EventEmitter()
  private compactHistoryRepo?: CompactHistoryRepository
  private throttleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ============ Configuration (from settings) ============

  autoCompactEnabled = false           // Phase 2: false; Phase 3: true
  autoCompactThreshold = 0.75
  minCompactInterval = 60_000          // ms

  constructor(compactHistoryRepo?: CompactHistoryRepository) {
    this.compactHistoryRepo = compactHistoryRepo
  }

  // ============ Input sources ============

  onMessagePersisted(threadId: string, content: string): void {
    const tokens = estimateTokens(content)
    const s = this.getOrInitState(threadId)
    s.tokensUsed += tokens
    this.emitChangeThrottled(threadId)
  }

  onAdapterUsageReport(threadId: string, used: number, max: number): void {
    const s = this.getOrInitState(threadId)
    s.tokensUsed = used
    s.tokensMax = max
    this.emitChangeThrottled(threadId)
  }

  onCompacted(threadId: string, tokensAfter: number, timestamp: number): void {
    const s = this.getOrInitState(threadId)
    s.tokensUsed = tokensAfter
    s.lastCompactedAt = timestamp
    this.emitChange(threadId)
  }

  // ============ Queries ============

  getRatio(threadId: string): number {
    const s = this.state.get(threadId)
    if (!s || s.tokensMax === 0) return 0
    return Math.min(s.tokensUsed / s.tokensMax, 1)
  }

  shouldAutoCompact(threadId: string): boolean {
    if (!this.autoCompactEnabled) return false
    const s = this.state.get(threadId)
    if (!s) return false
    const ratio = this.getRatio(threadId)
    if (ratio < this.autoCompactThreshold) return false
    if (s.lastCompactedAt) {
      const elapsed = Date.now() - s.lastCompactedAt
      if (elapsed < this.minCompactInterval) return false
    }
    return true
  }

  getState(threadId: string): ContextState | null {
    const s = this.state.get(threadId)
    if (!s) return null
    return {
      threadId: s.threadId,
      tokensUsed: s.tokensUsed,
      tokensMax: s.tokensMax,
      ratio: this.getRatio(threadId),
      lastCompactedAt: s.lastCompactedAt,
      updatedAt: Date.now(),
    }
  }

  // ============ Event subscription ============

  onChange(handler: (state: ContextState) => void): () => void {
    this.emitter.on('change', handler)
    return () => this.emitter.off('change', handler)
  }

  // ============ Internal ============

  private getOrInitState(threadId: string): WaterlineState {
    let s = this.state.get(threadId)
    if (!s) {
      s = { threadId, tokensUsed: 0, tokensMax: 200_000, lastCompactedAt: null }
      this.state.set(threadId, s)
    }
    return s
  }

  private emitChangeThrottled(threadId: string): void {
    const existing = this.throttleTimers.get(threadId)
    if (existing) clearTimeout(existing)
    this.throttleTimers.set(threadId, setTimeout(() => {
      this.throttleTimers.delete(threadId)
      this.emitChange(threadId)
    }, THROTTLE_MS))
  }

  private emitChange(threadId: string): void {
    const s = this.getState(threadId)
    if (s) this.emitter.emit('change', s)
  }
}
```

**Test file:** `src/main/__tests__/context-waterline.test.ts`

Create at least these tests (follow existing `t.mock` patterns):

```ts
describe('ContextWaterline', () => {
  it('starts at ratio 0 for unknown threads', () => {
    const wl = new ContextWaterline()
    expect(wl.getRatio('unknown')).toBe(0)
  })

  it('accumulates tokens via onMessagePersisted', () => {
    const wl = new ContextWaterline()
    wl.onMessagePersisted('t1', 'hello')
    expect(wl.getState('t1')!.tokensUsed).toBeGreaterThan(0)
  })

  it('usage report overrides estimated tokens', () => {
    const wl = new ContextWaterline()
    wl.onMessagePersisted('t1', 'hello world') // estimate ~10
    wl.onAdapterUsageReport('t1', 500, 200_000)
    expect(wl.getState('t1')!.tokensUsed).toBe(500)
  })

  it('onCompacted resets tokensUsed and stamps lastCompactedAt', () => {
    const wl = new ContextWaterline()
    wl.onMessagePersisted('t1', 'some long text')
    wl.onCompacted('t1', 300, 1000)
    const s = wl.getState('t1')!
    expect(s.tokensUsed).toBe(300)
    expect(s.lastCompactedAt).toBe(1000)
  })

  it('shouldAutoCompact returns false when disabled', () => {
    const wl = new ContextWaterline()
    wl.autoCompactEnabled = false
    expect(wl.shouldAutoCompact('t1')).toBe(false)
  })

  it('shouldAutoCompact returns true when threshold exceeded', () => {
    const wl = new ContextWaterline()
    wl.autoCompactEnabled = true
    wl.autoCompactThreshold = 0.5
    wl.onAdapterUsageReport('t1', 150_000, 200_000)  // 75% > 50%
    expect(wl.shouldAutoCompact('t1')).toBe(true)
  })

  it('shouldAutoCompact respects minCompactInterval', () => {
    const wl = new ContextWaterline()
    wl.autoCompactEnabled = true
    wl.autoCompactThreshold = 0.5
    wl.minCompactInterval = 999_999_999
    wl.onAdapterUsageReport('t1', 150_000, 200_000)  // 75%
    wl.onCompacted('t1', 300, Date.now())
    expect(wl.shouldAutoCompact('t1')).toBe(false)    // too soon
  })

  it('onChange fires with throttled coalesce', (done) => {
    const wl = new ContextWaterline()
    let callCount = 0
    wl.onChange(() => { callCount++ })
    wl.onMessagePersisted('t1', 'a')
    wl.onMessagePersisted('t1', 'b')
    setTimeout(() => {
      expect(callCount).toBe(1) // coalesced
      done()
    }, 600)
  })
})
```

**Note:** The mock for `EventEmitter` / `setTimeout` is needed — use `vi.spyOn(global, 'setTimeout')` or real timers (600ms timeout is fine for tests with `{ timeout: 2000 }`).

- [ ] `npx vitest run src/main/__tests__/context-waterline.test.ts` — PASS
- [ ] `npx tsc --noEmit` — PASS
- [ ] Commit

---

### Task 4: Wire waterline into AgentManager

**Files:**
- Modify: `src/main/agent/agent-manager.ts`

**Step 1: Add `ContextWaterline` dependency.** Add a field (not in constructor — use setter pattern like existing deps):

```ts
// At the beginning of the class fields (~agent-manager.ts:81-127), add:
private waterline?: ContextWaterline

// Add a setter at the end of the set... block (~agent-manager.ts:528):
setWaterline(wl: ContextWaterline): void {
  this.waterline = wl
}
```

**Step 2: Wire waterline into `resolveAndSendCommand`.** Before the adapter call at the end of the method, add the auto-compact check:

For now, just add a TODO comment + the check call (no actual compacting since compactContext isn't implemented until Phase 3):

```ts
// Added near the top of resolveAndSendCommand (after resolving sessionId):
if (this.waterline?.shouldAutoCompact(sessionId)) {
  // Phase 3: emit system message and await compactContext.
  // Phase 2: just log that we would compact.
  logger.info(`[Waterline] Thread ${sessionId} above threshold, would auto-compact`)
}
```

The `sessionId` may not correspond to a `threadId`. The waterline works per **threadId**. The session→thread mapping lives in `SessionRouter` or on `AgentSessionConfig`. Since `resolveAndSendCommand` receives `sessionId` only, we'll need to resolve the threadId:

```ts
const state = this.sessions.get(sessionId)
const threadId = state?.threadId
if (threadId && this.waterline?.shouldAutoCompact(threadId)) {
  // Phase 3 stub
}
```

Add `threadId` field to the internal session state type if it's not already there (check what `AgentSession` includes — `agent-manager.ts` stores sessions in `Map<string, AgentSession>`; verify `threadId` is available on state).

**Step 3: Call `waterline.onMessagePersisted` after each message persist.**

Since AgentManager doesn't hold ChatRepository, we can't directly call it from there. Instead, the `chat-service.ts` will call `waterline.onMessagePersisted()` directly (Task 5). But for the auto-compact check, `AgentManager` needs the `waterline` reference.

- [ ] Type-check: `npx tsc --noEmit`
- [ ] Commit

---

### Task 5: Token estimation during message persistence

**Files:**
- Modify: `src/main/services/chat-service.ts`

**Step 1: Inject `ContextWaterline` into ChatService:**

Add a constructor parameter or setter for `ContextWaterline`.

```ts
export class ChatService {
  constructor(
    private repo: ChatRepository,
    private waterline?: ContextWaterline,
  ) {}
```

**Step 2: Compute token_count during saveMessage:**

```ts
async saveMessage(threadId: string, message: ChatMessage): Promise<void> {
  // …existing logic…
  const tokenCount = estimateTokens(message.content)
  await this.repo.saveMessage({
    ...data,
    tokenCount,
  })
  this.waterline?.onMessagePersisted(threadId, message.content)
}
```

Also wire the increment in `saveMessage`:

```ts
// After saveMessage succeeds:
await this.repo.incrementContextTokens(threadId, tokenCount)
```

**Step 3: Wire in ipc-handlers.ts:**

In `createCoreDependencies()` or inline in `registerIpcHandlers()`, pass the waterline instance to `ChatService`.

- [ ] Run `npx vitest run src/main/__tests__/chat-service.test.ts` — PASS
- [ ] Type-check + lint
- [ ] Commit

---

### Task 6: Add contextWindow to registry + BaseAdapter usage report skeleton

**Files:**
- Modify: `src/main/adapters/registry.ts`

**Step 1: Add `contextWindow` to `AdapterDescriptor`:**

```ts
export interface AdapterDescriptor {
  // …existing fields…
  /** Default context window for this adapter, in tokens. Used by ContextWaterline. */
  contextWindow?: number
}
```

**Step 2: Update `ADAPTER_REGISTRY` entries** with `contextWindow` values:

| Adapter | contextWindow |
|---|---|
| `claude-code` | 200_000 |
| `codex` | 128_000 |
| `cursor` | 128_000 |
| `mcp-adapter` | 200_000 |
| `opencode` | 128_000 |
| `cline`, `kilo-code`, `kimi-code`, `codebuddy`, `qoder`, `qwen-code` | 128_000 |

This is used by the waterline to set `context_window_max` for a thread when the adapter is first chosen.

**Files:**
- Modify: `src/main/adapters/base.ts`

**Step 3: Add `reportUsage` skeleton:**

```ts
// Add at end of BaseAdapter class:
/**
 * Report authoritative token usage from the adapter/SDK.
 * Phase 2: skeleton; Phase 3: claude-code/codex/mcp-adapter call this.
 */
protected reportUsage(sessionId: string, inputTokens: number, maxTokens?: number): void {
  this.emit('usage', { sessionId, inputTokens, maxTokens })
}
```

The `BaseAdapter` needs to also import and emit the `usage` typed event. Add to the `EventEmitter` event signatures inline (TypeScript won't enforce this through the emitter — `this.emit('usage', ...)` works at runtime).

**Step 4: Expose `reportUsage` via the adapter interface if needed**, but since it's protected on `BaseAdapter`, it's fine — subclasses call it, and `AgentManager` can listen on the event.

- [ ] Type-check: `npx tsc --noEmit`
- [ ] Commit

---

### Task 7: IPC handlers + preload for context:* domain

**Files:**
- Create: `src/main/ipc/context.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ipc.ts`

**Step 1: Create `src/main/ipc/context.ts`:**

```ts
import type { TypedHandle } from './utils'
import type { ContextWaterline } from '../memory/context-waterline'
import type { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type { ContextState, CompactHistoryEntry } from '@shared/types'
import type { BrowserWindow } from 'electron'

export function registerContextHandlers(
  waterline: ContextWaterline,
  typedHandle: TypedHandle,
  compactHistoryRepo?: CompactHistoryRepository,
  getWindow?: () => BrowserWindow | null,
): void {
  typedHandle('context:getWaterline', async (_, threadId: string): Promise<ContextState | null> => {
    return waterline.getState(threadId)
  })

  typedHandle('context:listHistory', async (_, threadId: string): Promise<CompactHistoryEntry[]> => {
    if (!compactHistoryRepo) return []
    return compactHistoryRepo.listByThread(threadId)
  })

  // Phase 2: compactNow is a no-op (skeleton). Phase 3 will implement actual compaction.
  typedHandle('context:compactNow', async (_, _sessionId: string, _strategy?: string): Promise<{ status: string }> => {
    return { status: 'not_available' }
  })

  // Push waterline changes to renderer
  if (getWindow) {
    waterline.onChange((state: ContextState) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('waterline:change', state)
      }
    })
  }
}
```

**Step 2: Register in `ipc-handlers.ts`:**

Add `import { registerContextHandlers } from './ipc/context'` and call it in `registerIpcHandlers` after the `createCoreDependencies` call.

**Step 3: Update `preload/index.ts`:**

Add `'context:getWaterline'`, `'context:listHistory'`, `'context:compactNow'` to `exposedChannels`.

Add a new event listener:

```ts
onWaterlineChange: (callback: (state: ContextState) => void) => {
  const handler = (_event: IpcRendererEvent, state: ContextState) => callback(state)
  ipcRenderer.on('waterline:change', handler)
  return () => { ipcRenderer.removeListener('waterline:change', handler) }
}
```

- [ ] Type-check: `npx tsc --noEmit`
- [ ] Commit

---

### Task 8: ContextWaterlineBar component + integration in ChatHeader

**Files:**
- Create: `src/renderer/components/agent/ContextWaterlineBar.tsx`
- Create: `src/renderer/hooks/useWaterline.ts`
- Modify: `src/renderer/components/agent/ChatHeader.tsx`

**Step 1: Create `useWaterline` hook:**

```ts
// src/renderer/hooks/useWaterline.ts
import { useState, useEffect, useCallback } from 'react'
import type { ContextState } from '@shared/types'

export function useWaterline(threadId: string | null): ContextState | null {
  const [state, setState] = useState<ContextState | null>(null)

  useEffect(() => {
    if (!threadId) return

    // Load initial state
    window.electronAPI['context:getWaterline'](threadId).then(setState)

    // Subscribe to push updates
    const cleanup = window.electronAPI.onWaterlineChange((newState: ContextState) => {
      if (newState.threadId === threadId) {
        setState(newState)
      }
    })

    return () => cleanup()
  }, [threadId])

  return state
}
```

**Step 2: Create `ContextWaterlineBar` component:**

```tsx
// src/renderer/components/agent/ContextWaterlineBar.tsx
import type { ContextState } from '@shared/types'

interface Props {
  state: ContextState | null
}

export function ContextWaterlineBar({ state }: Props) {
  if (!state) return null

  const pct = Math.round(state.ratio * 100)
  const color = state.ratio < 0.5 ? 'bg-green-500'
    : state.ratio < 0.75 ? 'bg-yellow-500'
    : 'bg-red-500'

  const lastCompact = state.lastCompactedAt
    ? `${Math.round((Date.now() - state.lastCompactedAt) / 60000)}m ago`
    : null

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground px-2 min-w-0">
      <div className="flex-1 min-w-[80px] max-w-[200px] h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${color}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="tabular-nums whitespace-nowrap">
        {pct}% ({formatTokens(state.tokensUsed)} / {formatTokens(state.tokensMax)})
      </span>
      {lastCompact && (
        <span className="text-muted-foreground whitespace-nowrap">⏱ {lastCompact}</span>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}
```

**Step 3: Integrate into `ChatHeader.tsx`:**

Find the slot between the thread title and the right-side button group. Add:

```tsx
<ContextWaterlineBar state={waterlineState} />
```

Import `useWaterline` and call it with the current thread ID from props or store.

- [ ] `npx tsc --noEmit` — PASS
- [ ] `npm run test` — PASS
- [ ] Commit

---

### Task 9: Settings wiring + waterline config UI

**Files:**
- Modify: `src/main/ipc/settings.ts` or equivalent
- Modify: `src/renderer/store/settingsStore.ts` (or equivalent)

**Step 1: Implement settings IPC handlers:**

```ts
typedHandle('settings:getContextWaterlineConfig', async () => {
  return {
    autoCompactEnabled: true,     // Phase 2: stub; Phase 3: read from settings
    autoCompactThreshold: 0.75,
    minCompactInterval: 60_000,
  }
})

typedHandle('settings:setContextWaterlineConfig', async (_, cfg) => {
  // Phase 2 stub: log but don't persist
  logger.info('Waterline config update (not yet persisted):', cfg)
})
```

Full persistence of waterline settings is deferred to Phase 3 when auto-compact is enabled.

**Step 2: Renderer store:** Add `getContextWaterlineConfig` / `setContextWaterlineConfig` to the settings store.

- [ ] Type-check + lint
- [ ] Commit

---

### Task 10: Final verification

- [ ] `npm run test` — all tests pass
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — 0 new warnings (baseline at 69)
- [ ] Confirm `autoCompactEnabled` defaults `false` in code
- [ ] Verify no changes to adapter compaction behaviour
- [ ] Verify `ChatHeader` shows the waterline bar when thread is loaded
- [ ] Verify `waterline:change` events are sent to renderer and picked up by `useWaterline`

---

## Self-review

**Spec coverage (Module 2):**

| Spec item | Task |
|---|---|
| `ContextWaterline` service | 3 |
| Three input sources: estimation, report, compaction | 3 |
| `getRatio()`, `shouldAutoCompact()` | 3 |
| `onChange` subscription | 3, 7 |
| `compact before send` ordering (scaffolding) | 4 (Phase 3 TODO) |
| Settings: `autoCompactEnabled`, `threshold`, `minCompactInterval` | 9 |
| IPC: `context:getWaterline`, `context:onWaterlineChange`, `context:compactNow`, `context:listHistory` | 7 |
| `ChatHeader` waterline progress bar | 8 |
| `estimateTokens()` fills `chat_messages.token_count` | 2, 5 |
| Authoritative usage report overrides estimate | 3 (skeleton), 6 |
| `context_window_max` from registry | 6 |
| Phase 2: `autoCompactEnabled` defaults false | 3 (class default), 10 |

**Placeholder scan:** `compactNow` IPC returns `{ status: 'not_available' }` — intentional for Phase 2. All other code is concrete.