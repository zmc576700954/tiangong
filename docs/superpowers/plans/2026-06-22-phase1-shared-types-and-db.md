# Phase 1 — Shared Types & DB v4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the type and storage foundation for context compaction + subagent dispatch — DB schema v4, new shared types, two new repositories — without changing any runtime behaviour.

**Architecture:** Schema is upgraded via the existing `runIncrementalMigrations` pattern (ALTER for nullable columns) plus two new `CREATE TABLE` statements inside the `migrate()` rebuild block. Two new repositories (`CompactHistoryRepository`, `SubagentInvocationRepository`) follow the existing `ChatRepository` style (private `Client`, row mapper functions, plain async methods). Shared types are extended in place: `AdapterCapability` already exists as a `const` object — we extend it; new types are added to `agent.ts`. No service touches these until Phase 2/3/4.

**Tech Stack:** LibSQL (`@libsql/client`), TypeScript strict mode, Vitest with `vi.mock('electron')`, ESLint max 0 warnings.

**Spec reference:** `docs/superpowers/specs/2026-06-22-context-compaction-and-subagent-dispatch-design.md` — Module 1.

---

## File Structure

| Path | Purpose |
|---|---|
| `src/shared/types/agent.ts` | (modify) extend `AdapterCapability` const, add `CompactStrategy`, `CompactTrigger`, `CompactResult`, `CompactHistoryEntry`, extend `AgentSessionConfig` + `AgentThread` |
| `src/shared/types/subagent.ts` | (create) `AgentTypeDefinition`, `SubagentScopeStrategy`, `SubagentCapability`, `SubagentInvocation`, `SubagentResult`, `SubagentInvokeArgs`, `BUILT_IN_AGENT_TYPES` |
| `src/shared/types.ts` | (modify) re-export the new subagent module |
| `src/main/database.ts` | (modify) bump `CURRENT_SCHEMA_VERSION` to `4`; add new tables to `migrate()`; add v4 incremental migrations |
| `src/main/repositories/compact-history-repository.ts` | (create) CRUD for `compact_history` |
| `src/main/repositories/subagent-invocation-repository.ts` | (create) CRUD for `subagent_invocations` |
| `src/main/__tests__/compact-history-repository.test.ts` | (create) unit tests |
| `src/main/__tests__/subagent-invocation-repository.test.ts` | (create) unit tests |
| `src/main/__tests__/database-migration.test.ts` | (modify) add v4 column/table assertions |

Each file holds one responsibility; the two new repos mirror `ChatRepository`'s shape exactly so reviewers can pattern-match.

---

## Conventions referenced

- ID generation: `generateId(prefix: string)` from `src/main/shared/env.ts:71` returns `"<prefix>-<uuidNoHyphens>"`.
- Token estimation: `estimateTokens(text)` from `src/main/shared/token-utils.ts:5`.
- Row mapper pattern: see `toChatThreadRow`/`toChatMessageRow` in `src/main/repositories/chat-repository.ts:40-72`.
- Migration test fixture: `vi.mock('electron')` block at `src/main/__tests__/database-migration.test.ts:11-23`.
- Run a single test file: `npx vitest run src/main/__tests__/<file>.test.ts`.
- Run lint: `npm run lint` (must end with 0 warnings).
- Run type-check: `npx tsc --noEmit`.

---

## Task 1: Extend `AdapterCapability` and add compaction types

**Files:**
- Modify: `src/shared/types/agent.ts` (around line 464–472)

`AdapterCapability` is **already** a `const` object + same-name type at lines 464–472. We extend it (do **not** introduce a new `enum`).

- [ ] **Step 1: Add new capability keys**

Edit `src/shared/types/agent.ts` lines 464-472. Replace the existing block with:

```ts
/** 适配器能力枚举 */
export const AdapterCapability = {
  Resume: 'resume',
  Streaming: 'streaming',
  FileOps: 'fileOps',
  MultiTurn: 'multiTurn',
  ScopeGuard: 'scopeGuard',
  Tools: 'tools',
  // Phase 1 additions — context compaction & subagent dispatch
  NativeCompact: 'native-compact',
  LlmCompact: 'llm-compact',
  SummaryRewrite: 'summary-rewrite',
  SwarmCoordinator: 'swarm-coord',
} as const
export type AdapterCapability = typeof AdapterCapability[keyof typeof AdapterCapability]
```

- [ ] **Step 2: Add compaction types at end of file**

Append to `src/shared/types/agent.ts` (after the last `export`, before EOF):

```ts
// ============================================
// Context compaction (Phase 1 of context-compaction-and-subagent-dispatch)
// ============================================

/** Compaction strategy chosen by the adapter for one compact call. */
export type CompactStrategy = 'native' | 'llm' | 'summary'

/** What triggered a compaction. */
export type CompactTrigger = 'manual' | 'auto-threshold' | 'auto-token-limit'

/** Result of a compact call — returned by AgentManager and persisted to compact_history. */
export interface CompactResult {
  sessionId: string
  strategy: CompactStrategy
  trigger: CompactTrigger
  tokensBefore: number
  tokensAfter: number
  summary?: string
  startedAt: number
  durationMs: number
}

/** Persisted compact_history row (renderer-facing shape). */
export interface CompactHistoryEntry {
  id: string
  threadId: string | null
  sessionId: string | null
  strategy: CompactStrategy
  trigger: CompactTrigger
  tokensBefore: number
  tokensAfter: number
  summary: string | null
  startedAt: number
  durationMs: number
}
```

- [ ] **Step 3: Extend `AgentSessionConfig` and `AgentThread`**

Edit `src/shared/types/agent.ts` `AgentSessionConfig` (around line 13–42) — append the two new optional fields **before the closing brace**:

```ts
  /** 父 session（子代理 invocation 时回链）；Phase 1 仅占位，Phase 4 起用 */
  parentSessionId?: string
  /** SubagentInvocation.id — Phase 1 仅占位，Phase 4 起用 */
  swarmTaskId?: string
}
```

Edit `AgentThread` (around line 136–147) — append before the closing brace:

```ts
  /** 父 thread 引用（reserved；Phase 1 仅占位，subagent flow 不使用） */
  parentThreadId?: string
  /** 当前 thread 已用 token（来自 ContextWaterline；Phase 2 起填值） */
  contextTokensUsed?: number
  /** 当前 thread 的 token 窗口上限（来自 ADAPTER_REGISTRY；Phase 2 起填值） */
  contextWindowMax?: number
  /** 最近一次压缩的时间戳；Phase 3 起填值 */
  lastCompactedAt?: number
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: PASS with 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/agent.ts
git commit -m "feat(types): extend AdapterCapability and add compaction types

Adds NativeCompact/LlmCompact/SummaryRewrite/SwarmCoordinator
capability keys, plus CompactStrategy/Trigger/Result/HistoryEntry
types. Extends AgentSessionConfig and AgentThread with optional
fields used by Phases 2-4.

No runtime behaviour change.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Create shared subagent types

**Files:**
- Create: `src/shared/types/subagent.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Create the file**

Write `src/shared/types/subagent.ts`:

```ts
/**
 * Subagent dispatch — shared types
 *
 * Phase 1 of the context-compaction-and-subagent-dispatch design.
 * Runtime wiring lives in Phase 4 (SubagentManager); UI in Phase 5.
 */

/** How a subagent's sandbox relates to its parent's. */
export type SubagentScopeStrategy = 'inherit' | 'subset' | 'fresh'

/** Which mechanism the host adapter uses to expose dispatch_subagent. */
export type SubagentCapability = 'native-task' | 'api-tool' | 'inline-protocol'

/** Persisted lifecycle status of one subagent_invocations row. */
export type SubagentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Built-in tool names used by the allowedTools list. */
export type SubagentToolName =
  | 'Read'
  | 'Glob'
  | 'Grep'
  | 'WebFetch'
  | 'Edit'
  | 'Write'
  | 'Bash'

/** Definition of one subagent type (built-in or user-defined). */
export interface AgentTypeDefinition {
  /** Stable machine name, lower-kebab-case. */
  name: string
  /** Human-readable label. */
  displayName: string
  /** What the parent agent reads when deciding which type to dispatch. */
  description: string
  /** '*' = full tool set; otherwise an explicit whitelist. */
  allowedTools: SubagentToolName[] | '*'
  /** Optional adapter override. */
  defaultAdapter?: string
  /** Optional model override. */
  defaultModel?: string
  /** Appended to the scope prompt of the child session. */
  systemPromptAddon?: string
  /** Sandbox derivation strategy. */
  scopeStrategy: SubagentScopeStrategy
  /** If true, run a cheap LLM summary on result_text before returning to parent. */
  summarizeResult?: boolean
}

/** Arguments accepted by SubagentManager.invoke() — also the dispatch_subagent tool schema. */
export interface SubagentInvokeArgs {
  parentSessionId: string
  parentMessageId?: string
  agentType: string
  description: string
  prompt: string
  adapterName?: string
  nodeId?: string
  allowedFiles?: string[]
}

/** Persisted subagent_invocations row (renderer-facing shape). */
export interface SubagentInvocation {
  id: string
  parentSessionId: string
  parentMessageId: string | null
  graphId: string | null
  agentType: string
  description: string
  prompt: string
  adapterName: string | null
  nodeId: string | null
  allowedFiles: string[] | null
  status: SubagentStatus
  resultText: string | null
  resultFiles: string[] | null
  tokensUsed: number
  startedAt: number
  finishedAt: number | null
  error: string | null
}

/** Final result returned by SubagentManager.invoke(). */
export interface SubagentResult {
  invocationId: string
  resultText: string
  resultFiles: string[]
  tokensUsed: number
  durationMs: number
}

/** Built-in agent types — registry seed. */
export const BUILT_IN_AGENT_TYPES: AgentTypeDefinition[] = [
  {
    name: 'explore',
    displayName: '探索者',
    description: 'Read-only multi-file search. Returns a structured report of locations and findings. Use for: locating code, mapping a subsystem, gathering context before edits.',
    allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch'],
    scopeStrategy: 'inherit',
  },
  {
    name: 'implement',
    displayName: '实现者',
    description: 'Implements a feature or change within a constrained file set. Use for: small-to-medium feature work where the file list is known.',
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    scopeStrategy: 'subset',
  },
  {
    name: 'review',
    displayName: '审查者',
    description: 'Read-only review of specified files. Returns a problem list. Use for: code review, static checks, security scans.',
    allowedTools: ['Read', 'Glob', 'Grep'],
    scopeStrategy: 'inherit',
  },
  {
    name: 'fix',
    displayName: '修复者',
    description: 'Locates and fixes a specific bug. Use for: bug nodes with reproducible symptoms.',
    allowedTools: ['Read', 'Edit', 'Bash'],
    scopeStrategy: 'subset',
  },
  {
    name: 'general',
    displayName: '通用',
    description: 'Full-tool generalist. Use when no specialised type fits.',
    allowedTools: '*',
    scopeStrategy: 'subset',
  },
]
```

- [ ] **Step 2: Re-export from `src/shared/types.ts`**

Open `src/shared/types.ts`. After the existing `export * from './types/swarm'` line (around line 62–63 per the codebase exploration), add:

```ts
export * from './types/subagent'
```

If the existing re-export line is laid out differently, place the new line alongside the other `./types/*` re-exports.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/subagent.ts src/shared/types.ts
git commit -m "feat(types): add subagent dispatch shared types

Introduces AgentTypeDefinition, SubagentScopeStrategy,
SubagentCapability, SubagentStatus, SubagentInvokeArgs,
SubagentInvocation, SubagentResult, and BUILT_IN_AGENT_TYPES.

These are consumed by Phase 4 (SubagentManager) and Phase 5 (UI).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Extend the migration test for schema v4 (failing test first)

**Files:**
- Modify: `src/main/__tests__/database-migration.test.ts`

This test will fail until Task 4 lands the schema change. That is intentional.

- [ ] **Step 1: Add the new assertions at the end of the `describe('Database Migration', ...)` block**

Open `src/main/__tests__/database-migration.test.ts`. Append the following `it(...)` blocks **inside** the `describe('Database Migration', ...)` block, before its closing `})`:

```ts
  it('schema_version should be at least 4 after migration', async () => {
    const client = getClient()
    const result = await client.execute('SELECT version FROM schema_version LIMIT 1')
    const version = Number((result.rows[0] as unknown as { version: number }).version)
    expect(version).toBeGreaterThanOrEqual(4)
  })

  it('chat_messages should have token_count column', async () => {
    const client = getClient()
    const result = await client.execute('PRAGMA table_info(chat_messages)')
    const columns = result.rows.map((r) => (r as unknown as { name: string }).name)
    expect(columns).toContain('token_count')
  })

  it('chat_threads should have waterline columns', async () => {
    const client = getClient()
    const result = await client.execute('PRAGMA table_info(chat_threads)')
    const columns = result.rows.map((r) => (r as unknown as { name: string }).name)
    expect(columns).toContain('parent_thread_id')
    expect(columns).toContain('context_tokens_used')
    expect(columns).toContain('context_window_max')
    expect(columns).toContain('last_compacted_at')
  })

  it('should create compact_history table with expected columns', async () => {
    const client = getClient()
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='compact_history'"
    )
    expect(tables.rows.length).toBe(1)

    const info = await client.execute('PRAGMA table_info(compact_history)')
    const columns = info.rows.map((r) => (r as unknown as { name: string }).name)
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'thread_id', 'session_id', 'strategy', 'trigger',
      'tokens_before', 'tokens_after', 'summary',
      'started_at', 'duration_ms',
    ]))
  })

  it('should create subagent_invocations table with expected columns', async () => {
    const client = getClient()
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_invocations'"
    )
    expect(tables.rows.length).toBe(1)

    const info = await client.execute('PRAGMA table_info(subagent_invocations)')
    const columns = info.rows.map((r) => (r as unknown as { name: string }).name)
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'parent_session_id', 'parent_message_id', 'graph_id',
      'agent_type', 'description', 'prompt',
      'adapter_name', 'node_id', 'allowed_files',
      'status', 'result_text', 'result_files', 'tokens_used',
      'started_at', 'finished_at', 'error',
    ]))
  })

  it('should index subagent_invocations by parent_session_id and status', async () => {
    const client = getClient()
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='subagent_invocations'"
    )
    const indexNames = result.rows.map((r) => (r as unknown as { name: string }).name)
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_subagent_inv_parent',
      'idx_subagent_inv_status',
    ]))
  })
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/main/__tests__/database-migration.test.ts`
Expected: The six new tests **FAIL** (column / table not found). Pre-existing tests still PASS.

- [ ] **Step 3: Commit (failing tests included intentionally)**

```bash
git add src/main/__tests__/database-migration.test.ts
git commit -m "test(db): assert schema v4 columns and tables exist

Adds failing assertions for token_count, chat_threads waterline
columns, compact_history table, and subagent_invocations table.
The implementation in the next commit makes them pass.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Implement schema v4 in `database.ts`

**Files:**
- Modify: `src/main/database.ts:265` and `src/main/database.ts:491-526`

- [ ] **Step 1: Bump the schema version**

Open `src/main/database.ts`. Change line 265:

```ts
const CURRENT_SCHEMA_VERSION = 3
```
to:
```ts
const CURRENT_SCHEMA_VERSION = 4
```

- [ ] **Step 2: Add the two new tables to `migrate()`**

In `src/main/database.ts`, locate the block that creates `memory_items` (around lines 423-444). **After** that `rebuildTableIfNeeded` call **and before** the `// Create indexes` comment at ~line 446, insert:

```ts
    // Compact history (Phase 1 of context-compaction design)
    await rebuildTableIfNeeded(db, 'compact_history', `
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
      )
    `, ['id', 'strategy', 'trigger', 'tokens_before', 'tokens_after', 'started_at', 'duration_ms'])

    // Subagent invocations (Phase 1 of subagent-dispatch design)
    await rebuildTableIfNeeded(db, 'subagent_invocations', `
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
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
        result_text TEXT,
        result_files TEXT,
        tokens_used INTEGER DEFAULT 0,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT
      )
    `, ['id', 'parent_session_id', 'agent_type', 'description', 'prompt', 'status', 'started_at'])
```

- [ ] **Step 3: Add indexes for the new tables**

In the same file, in the index block that begins at ~line 447 (`await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_graph_id ...`), append **before** the call to `runIncrementalMigrations(db, currentVersion)` (~line 471):

```ts
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_compact_history_thread ON compact_history(thread_id)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_compact_history_started ON compact_history(started_at DESC)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_subagent_inv_parent ON subagent_invocations(parent_session_id)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_subagent_inv_status ON subagent_invocations(status)`)
```

- [ ] **Step 4: Add v4 incremental migrations for ALTER columns**

In the same file, locate `runIncrementalMigrations` (line 491). After the existing `v3` block (ending at line 525, the `addColumnSafe('memory_items', 'embedding', ...)` line), append **before** the closing `}` of `runIncrementalMigrations`:

```ts
  // v4: context-compaction & subagent-dispatch (Phase 1)
  if (currentVersion < 4) {
    await addColumnSafe('chat_messages', 'token_count', 'INTEGER', '0')
    await addColumnSafe('chat_threads', 'parent_thread_id', 'TEXT')
    await addColumnSafe('chat_threads', 'context_tokens_used', 'INTEGER', '0')
    await addColumnSafe('chat_threads', 'context_window_max', 'INTEGER', '200000')
    await addColumnSafe('chat_threads', 'last_compacted_at', 'INTEGER')
  }
```

The two new `CREATE TABLE` calls inside `migrate()` cover fresh installs. The ALTER block here handles **upgrades** from v3 (where chat tables already exist with old columns).

- [ ] **Step 5: Run the migration test and confirm it passes**

Each test run uses a fresh in-memory DB seeded by the mocked `userData` path. Delete any stale fixture first:

Run:
```bash
rm -rf "$TMP/bizgraph-test-$$" 2>/dev/null; npx vitest run src/main/__tests__/database-migration.test.ts
```
(On Windows `bash`: `rm -rf /tmp/bizgraph-test-* ; npx vitest run src/main/__tests__/database-migration.test.ts`.)

Expected: All migration tests PASS, including the six new ones from Task 3.

- [ ] **Step 6: Run the full test suite to catch regressions**

Run: `npm run test`
Expected: All tests PASS.

- [ ] **Step 7: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS for both.

- [ ] **Step 8: Commit**

```bash
git add src/main/database.ts
git commit -m "feat(db): schema v4 — compact_history + subagent_invocations

Bumps CURRENT_SCHEMA_VERSION to 4. Adds:
- compact_history table (id, thread_id, session_id, strategy,
  trigger, tokens_before/after, summary, started_at, duration_ms)
- subagent_invocations table (full lifecycle row)
- ALTER columns on chat_messages (token_count) and chat_threads
  (parent_thread_id, context_tokens_used, context_window_max,
  last_compacted_at).

All new columns are nullable or have defaults so v3 callers
continue to work.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: `CompactHistoryRepository` — failing test first

**Files:**
- Create: `src/main/__tests__/compact-history-repository.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type { Client, Row, ResultSet } from '@libsql/client'

function createMockDb(): Client {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  } as unknown as Client
}

function mockRows(rows: Record<string, unknown>[]): ResultSet {
  return {
    rows: rows as unknown as Row[],
    columns: [],
    columnTypes: [],
    rowsAffected: 0,
    lastInsertRowid: 0n,
    toJSON: () => ({}),
  }
}

describe('CompactHistoryRepository', () => {
  let db: Client
  let repo: CompactHistoryRepository

  beforeEach(() => {
    db = createMockDb()
    repo = new CompactHistoryRepository(db)
  })

  describe('insert', () => {
    it('persists a CompactResult and returns the generated id', async () => {
      const id = await repo.insert({
        threadId: 't1',
        sessionId: 's1',
        strategy: 'native',
        trigger: 'manual',
        tokensBefore: 150_000,
        tokensAfter: 30_000,
        summary: 'short summary',
        startedAt: 1_700_000_000_000,
        durationMs: 1234,
      })

      expect(id).toMatch(/^compact-/)
      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO compact_history'),
      }))
    })

    it('accepts null thread_id and session_id and null summary', async () => {
      const id = await repo.insert({
        threadId: null,
        sessionId: null,
        strategy: 'summary',
        trigger: 'auto-threshold',
        tokensBefore: 10,
        tokensAfter: 5,
        summary: null,
        startedAt: 0,
        durationMs: 0,
      })
      expect(id).toMatch(/^compact-/)
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.args[1]).toBeNull() // thread_id
      expect(call.args[2]).toBeNull() // session_id
      expect(call.args[7]).toBeNull() // summary
    })
  })

  describe('listByThread', () => {
    it('returns rows ordered by started_at DESC', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([
        {
          id: 'compact-aaa', thread_id: 't1', session_id: 's1',
          strategy: 'native', trigger: 'manual',
          tokens_before: 100, tokens_after: 50,
          summary: 's', started_at: 2, duration_ms: 10,
        },
        {
          id: 'compact-bbb', thread_id: 't1', session_id: 's1',
          strategy: 'summary', trigger: 'auto-threshold',
          tokens_before: 80, tokens_after: 40,
          summary: null, started_at: 1, duration_ms: 5,
        },
      ]))

      const rows = await repo.listByThread('t1')

      expect(rows).toHaveLength(2)
      expect(rows[0].id).toBe('compact-aaa')
      expect(rows[0].threadId).toBe('t1')
      expect(rows[0].tokensBefore).toBe(100)
      expect(rows[1].summary).toBeNull()
      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('ORDER BY started_at DESC'),
      }))
    })

    it('respects limit', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([]))
      await repo.listByThread('t1', 5)
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.args).toEqual(['t1', 5])
    })
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/main/__tests__/compact-history-repository.test.ts`
Expected: FAIL — `Cannot find module '../repositories/compact-history-repository'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/main/__tests__/compact-history-repository.test.ts
git commit -m "test(compact-history-repo): add unit tests (failing)

Tests insert with full + null fields, and listByThread ordering
and limit. Implementation lands in the next commit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Implement `CompactHistoryRepository`

**Files:**
- Create: `src/main/repositories/compact-history-repository.ts`

- [ ] **Step 1: Write the repository**

```ts
/**
 * CompactHistoryRepository
 * 持久化 compact_history 表。Phase 1 落地骨架，Phase 3 起被 AgentManager.compactContext 使用。
 */

import type { Client, Row } from '@libsql/client'
import { generateId } from '../shared/env'
import type {
  CompactHistoryEntry,
  CompactStrategy,
  CompactTrigger,
} from '@shared/types'

export interface CompactHistoryInsert {
  threadId: string | null
  sessionId: string | null
  strategy: CompactStrategy
  trigger: CompactTrigger
  tokensBefore: number
  tokensAfter: number
  summary: string | null
  startedAt: number
  durationMs: number
}

function toEntry(row: Row): CompactHistoryEntry {
  return {
    id: String(row.id ?? ''),
    threadId: row.thread_id != null ? String(row.thread_id) : null,
    sessionId: row.session_id != null ? String(row.session_id) : null,
    strategy: String(row.strategy ?? 'summary') as CompactStrategy,
    trigger: String(row.trigger ?? 'manual') as CompactTrigger,
    tokensBefore: Number(row.tokens_before ?? 0),
    tokensAfter: Number(row.tokens_after ?? 0),
    summary: row.summary != null ? String(row.summary) : null,
    startedAt: Number(row.started_at ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
  }
}

export class CompactHistoryRepository {
  constructor(private db: Client) {}

  /** Insert a compaction record. Returns the generated id. */
  async insert(data: CompactHistoryInsert): Promise<string> {
    const id = generateId('compact')
    await this.db.execute({
      sql: `INSERT INTO compact_history (
              id, thread_id, session_id, strategy, trigger,
              tokens_before, tokens_after, summary,
              started_at, duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.threadId,
        data.sessionId,
        data.strategy,
        data.trigger,
        data.tokensBefore,
        data.tokensAfter,
        data.summary,
        data.startedAt,
        data.durationMs,
      ],
    })
    return id
  }

  /** List recent compactions for a thread, newest first. Default limit 50. */
  async listByThread(threadId: string, limit = 50): Promise<CompactHistoryEntry[]> {
    const result = await this.db.execute({
      sql: `SELECT id, thread_id, session_id, strategy, trigger,
                   tokens_before, tokens_after, summary,
                   started_at, duration_ms
            FROM compact_history
            WHERE thread_id = ?
            ORDER BY started_at DESC
            LIMIT ?`,
      args: [threadId, limit],
    })
    return result.rows.map(toEntry)
  }
}
```

- [ ] **Step 2: Run the repo test**

Run: `npx vitest run src/main/__tests__/compact-history-repository.test.ts`
Expected: PASS.

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS for both.

- [ ] **Step 4: Commit**

```bash
git add src/main/repositories/compact-history-repository.ts
git commit -m "feat(repo): CompactHistoryRepository

Mirrors ChatRepository style: private Client, row mapper,
generateId('compact') for new rows. Two public methods:
insert() and listByThread(). Not yet wired into IPC — Phase
3 will call insert() from AgentManager.compactContext.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: `SubagentInvocationRepository` — failing test first

**Files:**
- Create: `src/main/__tests__/subagent-invocation-repository.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubagentInvocationRepository } from '../repositories/subagent-invocation-repository'
import type { Client, Row, ResultSet } from '@libsql/client'

function createMockDb(): Client {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  } as unknown as Client
}

function mockRows(rows: Record<string, unknown>[]): ResultSet {
  return {
    rows: rows as unknown as Row[],
    columns: [],
    columnTypes: [],
    rowsAffected: 0,
    lastInsertRowid: 0n,
    toJSON: () => ({}),
  }
}

describe('SubagentInvocationRepository', () => {
  let db: Client
  let repo: SubagentInvocationRepository

  beforeEach(() => {
    db = createMockDb()
    repo = new SubagentInvocationRepository(db)
  })

  describe('create', () => {
    it('inserts a queued invocation and returns the generated id', async () => {
      const id = await repo.create({
        parentSessionId: 'p1',
        agentType: 'explore',
        description: 'find auth',
        prompt: 'Look for auth entry points',
        startedAt: 1_700_000_000_000,
      })

      expect(id).toMatch(/^inv-/)
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('INSERT INTO subagent_invocations')
      // status defaults to 'queued'
      const queuedIndex = call.args.indexOf('queued')
      expect(queuedIndex).toBeGreaterThanOrEqual(0)
    })

    it('serialises allowed_files as JSON', async () => {
      await repo.create({
        parentSessionId: 'p1',
        agentType: 'implement',
        description: 'edit',
        prompt: 'do it',
        allowedFiles: ['src/a.ts', 'src/b.ts'],
        startedAt: 0,
      })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const args = call.args as unknown[]
      const allowedFilesArg = args.find((v) => typeof v === 'string' && v.startsWith('['))
      expect(allowedFilesArg).toBe(JSON.stringify(['src/a.ts', 'src/b.ts']))
    })
  })

  describe('updateStatus', () => {
    it('updates status only', async () => {
      await repo.updateStatus('inv-xx', 'running')
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('UPDATE subagent_invocations SET status = ?')
      expect(call.args).toEqual(['running', 'inv-xx'])
    })
  })

  describe('complete', () => {
    it('writes terminal fields and status=completed', async () => {
      await repo.complete('inv-xx', {
        resultText: 'done',
        resultFiles: ['src/x.ts'],
        tokensUsed: 1234,
        finishedAt: 1_700_000_100_000,
      })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('UPDATE subagent_invocations')
      expect(call.sql).toContain('status = ?')
      expect(call.sql).toContain('result_text = ?')
      expect(call.sql).toContain('result_files = ?')
      expect(call.sql).toContain('tokens_used = ?')
      expect(call.sql).toContain('finished_at = ?')
      // Last arg is the id.
      const args = call.args as unknown[]
      expect(args[args.length - 1]).toBe('inv-xx')
      // 'completed' status was passed.
      expect(args).toContain('completed')
      // result_files JSON-encoded.
      expect(args).toContain(JSON.stringify(['src/x.ts']))
    })
  })

  describe('fail', () => {
    it('writes error and status=failed', async () => {
      await repo.fail('inv-xx', { error: 'boom', finishedAt: 1 })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const args = call.args as unknown[]
      expect(args).toContain('failed')
      expect(args).toContain('boom')
    })
  })

  describe('listByParent', () => {
    it('returns deserialised rows', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([
        {
          id: 'inv-1', parent_session_id: 'p1', parent_message_id: null,
          graph_id: 'g1', agent_type: 'explore', description: 'd', prompt: 'p',
          adapter_name: 'claude-code', node_id: null,
          allowed_files: '["src/a.ts"]',
          status: 'completed', result_text: 'r', result_files: '["src/a.ts"]',
          tokens_used: 100, started_at: 1, finished_at: 2, error: null,
        },
      ]))

      const rows = await repo.listByParent('p1')
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('inv-1')
      expect(rows[0].allowedFiles).toEqual(['src/a.ts'])
      expect(rows[0].resultFiles).toEqual(['src/a.ts'])
      expect(rows[0].status).toBe('completed')
    })

    it('handles malformed JSON in allowed_files gracefully', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([
        {
          id: 'inv-2', parent_session_id: 'p1', parent_message_id: null,
          graph_id: null, agent_type: 'fix', description: 'd', prompt: 'p',
          adapter_name: null, node_id: null,
          allowed_files: 'not-json',
          status: 'queued', result_text: null, result_files: null,
          tokens_used: 0, started_at: 0, finished_at: null, error: null,
        },
      ]))
      const rows = await repo.listByParent('p1')
      expect(rows[0].allowedFiles).toBeNull()
    })
  })

  describe('get', () => {
    it('returns null when not found', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([]))
      const row = await repo.get('inv-missing')
      expect(row).toBeNull()
    })
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/main/__tests__/subagent-invocation-repository.test.ts`
Expected: FAIL — `Cannot find module '../repositories/subagent-invocation-repository'`.

- [ ] **Step 3: Commit failing test**

```bash
git add src/main/__tests__/subagent-invocation-repository.test.ts
git commit -m "test(subagent-inv-repo): add unit tests (failing)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Implement `SubagentInvocationRepository`

**Files:**
- Create: `src/main/repositories/subagent-invocation-repository.ts`

- [ ] **Step 1: Write the repository**

```ts
/**
 * SubagentInvocationRepository
 * 持久化 subagent_invocations 表。
 *
 * Phase 1 落地骨架；Phase 4 起 SubagentManager 调用 create/updateStatus/
 * complete/fail；Phase 5 渲染层通过 IPC listByParent/get 拉取数据。
 */

import type { Client, Row } from '@libsql/client'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import type { SubagentInvocation, SubagentStatus } from '@shared/types'

export interface SubagentInvocationCreate {
  parentSessionId: string
  parentMessageId?: string
  graphId?: string
  agentType: string
  description: string
  prompt: string
  adapterName?: string
  nodeId?: string
  allowedFiles?: string[]
  startedAt: number
}

export interface SubagentInvocationComplete {
  resultText: string
  resultFiles: string[]
  tokensUsed: number
  finishedAt: number
}

export interface SubagentInvocationFail {
  error: string
  finishedAt: number
}

function parseStringArray(raw: unknown): string[] | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return null
  const parsed = safeJsonParse<unknown>(raw, null)
  if (!Array.isArray(parsed)) return null
  return parsed.filter((v): v is string => typeof v === 'string')
}

function toInvocation(row: Row): SubagentInvocation {
  return {
    id: String(row.id ?? ''),
    parentSessionId: String(row.parent_session_id ?? ''),
    parentMessageId: row.parent_message_id != null ? String(row.parent_message_id) : null,
    graphId: row.graph_id != null ? String(row.graph_id) : null,
    agentType: String(row.agent_type ?? ''),
    description: String(row.description ?? ''),
    prompt: String(row.prompt ?? ''),
    adapterName: row.adapter_name != null ? String(row.adapter_name) : null,
    nodeId: row.node_id != null ? String(row.node_id) : null,
    allowedFiles: parseStringArray(row.allowed_files),
    status: String(row.status ?? 'queued') as SubagentStatus,
    resultText: row.result_text != null ? String(row.result_text) : null,
    resultFiles: parseStringArray(row.result_files),
    tokensUsed: Number(row.tokens_used ?? 0),
    startedAt: Number(row.started_at ?? 0),
    finishedAt: row.finished_at != null ? Number(row.finished_at) : null,
    error: row.error != null ? String(row.error) : null,
  }
}

export class SubagentInvocationRepository {
  constructor(private db: Client) {}

  /** Insert a new invocation with status='queued'. Returns the generated id. */
  async create(data: SubagentInvocationCreate): Promise<string> {
    const id = generateId('inv')
    await this.db.execute({
      sql: `INSERT INTO subagent_invocations (
              id, parent_session_id, parent_message_id, graph_id,
              agent_type, description, prompt,
              adapter_name, node_id, allowed_files,
              status, result_text, result_files, tokens_used,
              started_at, finished_at, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.parentSessionId,
        data.parentMessageId ?? null,
        data.graphId ?? null,
        data.agentType,
        data.description,
        data.prompt,
        data.adapterName ?? null,
        data.nodeId ?? null,
        data.allowedFiles ? JSON.stringify(data.allowedFiles) : null,
        'queued',
        null,
        null,
        0,
        data.startedAt,
        null,
        null,
      ],
    })
    return id
  }

  /** Update just the status column (e.g. queued → running). */
  async updateStatus(id: string, status: SubagentStatus): Promise<void> {
    await this.db.execute({
      sql: 'UPDATE subagent_invocations SET status = ? WHERE id = ?',
      args: [status, id],
    })
  }

  /** Mark a row as completed and write terminal fields. */
  async complete(id: string, data: SubagentInvocationComplete): Promise<void> {
    await this.db.execute({
      sql: `UPDATE subagent_invocations
            SET status = ?, result_text = ?, result_files = ?, tokens_used = ?, finished_at = ?
            WHERE id = ?`,
      args: [
        'completed',
        data.resultText,
        JSON.stringify(data.resultFiles),
        data.tokensUsed,
        data.finishedAt,
        id,
      ],
    })
  }

  /** Mark a row as failed and write the error message. */
  async fail(id: string, data: SubagentInvocationFail): Promise<void> {
    await this.db.execute({
      sql: `UPDATE subagent_invocations
            SET status = ?, error = ?, finished_at = ?
            WHERE id = ?`,
      args: ['failed', data.error, data.finishedAt, id],
    })
  }

  /** Mark a row as cancelled. */
  async cancel(id: string, finishedAt: number): Promise<void> {
    await this.db.execute({
      sql: `UPDATE subagent_invocations
            SET status = ?, finished_at = ?
            WHERE id = ? AND status IN ('queued','running')`,
      args: ['cancelled', finishedAt, id],
    })
  }

  /** List invocations under one parent session, newest first. */
  async listByParent(parentSessionId: string, limit = 100): Promise<SubagentInvocation[]> {
    const result = await this.db.execute({
      sql: `SELECT id, parent_session_id, parent_message_id, graph_id,
                   agent_type, description, prompt,
                   adapter_name, node_id, allowed_files,
                   status, result_text, result_files, tokens_used,
                   started_at, finished_at, error
            FROM subagent_invocations
            WHERE parent_session_id = ?
            ORDER BY started_at DESC
            LIMIT ?`,
      args: [parentSessionId, limit],
    })
    return result.rows.map(toInvocation)
  }

  /** Fetch a single invocation by id. */
  async get(id: string): Promise<SubagentInvocation | null> {
    const result = await this.db.execute({
      sql: `SELECT id, parent_session_id, parent_message_id, graph_id,
                   agent_type, description, prompt,
                   adapter_name, node_id, allowed_files,
                   status, result_text, result_files, tokens_used,
                   started_at, finished_at, error
            FROM subagent_invocations WHERE id = ?`,
      args: [id],
    })
    return result.rows[0] ? toInvocation(result.rows[0]) : null
  }
}
```

> Note: `safeJsonParse<T>(raw, fallback)` already exists in `src/main/shared/db-utils.ts` (used by `node-repository.ts:11`). It returns `fallback` on parse failure.

- [ ] **Step 2: Run the repo test**

Run: `npx vitest run src/main/__tests__/subagent-invocation-repository.test.ts`
Expected: PASS.

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/repositories/subagent-invocation-repository.ts
git commit -m "feat(repo): SubagentInvocationRepository

Full lifecycle CRUD: create (queued), updateStatus, complete,
fail, cancel, listByParent, get. JSON-encodes allowed_files
and result_files; falls back to null on malformed JSON via
safeJsonParse.

Not yet wired — Phase 4 SubagentManager will consume this.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full test run**

Run: `npm run test`
Expected: All tests PASS.

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS with 0 warnings.

- [ ] **Step 4: Confirm no behavioural drift**

Manual check: open `src/main/agent/agent-manager.ts`, `src/main/ipc/agent.ts`, and `src/renderer/components/agent/AgentChatPanel.tsx`. Verify **none** of these files were touched in Phase 1. Runtime behaviour must be unchanged.

If any of these files contain Phase 1 modifications, revert them — Phase 2/3/4/5 own those files.

- [ ] **Step 5: Phase summary commit (no-op)**

If steps 1–4 all pass, the phase is complete. The five feature commits already cover all changes; no extra commit is needed.

---

## Self-review

**Spec coverage (against Module 1 of the spec):**

| Spec item | Task |
|---|---|
| Add `AdapterCapability` flags `NativeCompact / LlmCompact / SummaryRewrite / SwarmCoordinator` | Task 1 |
| `CompactStrategy`, `CompactTrigger`, `CompactResult` types | Task 1 |
| Extend `AgentSessionConfig` with `parentSessionId`, `swarmTaskId` | Task 1 |
| Extend `AgentThread` with `parentThreadId`, `contextTokensUsed`, `contextWindowMax`, `lastCompactedAt` | Task 1 |
| `src/shared/types/swarm.ts` left unchanged | Implicit — no task touches it |
| `AgentTypeDefinition`, `BUILT_IN_AGENT_TYPES` | Task 2 |
| `SubagentInvocation`, `SubagentResult`, `SubagentInvokeArgs` | Task 2 |
| Bump `CURRENT_SCHEMA_VERSION` to 4 | Task 4 |
| `ALTER chat_messages ADD token_count` | Task 4 |
| `ALTER chat_threads ADD parent_thread_id / context_tokens_used / context_window_max / last_compacted_at` | Task 4 |
| `CREATE TABLE compact_history` + indices | Task 4 |
| `CREATE TABLE subagent_invocations` + indices | Task 4 |
| New columns nullable / defaulted for v3 compatibility | Task 4 (`addColumnSafe` defaults) |
| CompactHistory repository | Tasks 5–6 |
| SubagentInvocation repository | Tasks 7–8 |
| No UI / no behaviour change | Task 9 step 4 |

**Type consistency:** `AdapterCapability` is the existing `as const` object — extended in place, not replaced. `CompactStrategy`, `CompactTrigger` strings match the values used in repo column CHECK constraints (`compact_history.strategy` has no CHECK to avoid coupling — adapter-driven). `SubagentStatus` strings match the `status TEXT NOT NULL CHECK(...)` constraint exactly: `queued | running | completed | failed | cancelled`. Repository method names (`insert / listByThread / create / updateStatus / complete / fail / cancel / listByParent / get`) are referenced verbatim in their respective tests.

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "similar to" — every step contains the actual code or command.

---

Plan complete and saved to `docs/superpowers/plans/2026-06-22-phase1-shared-types-and-db.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
