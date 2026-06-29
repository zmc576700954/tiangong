# CLAUDE.md

> 最后更新：2026-06-29

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BizGraph is an Electron desktop application that orchestrates Agent CLI tools (Claude Code, Codex, OpenCode, Cline, Kilo Code, Kimi Code, CodeBuddy, Qoder, Qwen Code, Cursor) through a visual mind map interface. It defines business scope boundaries ("where to change, how to change") so that agents work within constraints rather than modifying arbitrary files.

The core principle: BizGraph does not generate code — it makes Agent tools more controllable, collaborative, and reviewable.

## Common Commands

```bash
# Development (hot-reload Electron app at localhost:5173)
npm run dev

# Type-check (renderer + shared only; main uses tsconfig.main.json)
npx tsc --noEmit

# Lint (ESLint, max 0 warnings)
npm run lint

# Unit tests (Vitest, runs src/**/*.test.ts)
npm run test
npm run test:watch   # watch mode

# E2E tests (Playwright)
npm run test:e2e
npm run test:e2e:electron

# Production builds
npm run build        # all-in-one: tsc + vite + electron-builder
npm run build:win    # Windows NSIS / appx
npm run build:mac    # macOS DMG (arm64 + x64)
npm run build:linux  # Linux AppImage
```

## Architecture

BizGraph is a three-process Electron app:

**Main process** (`src/main/`) — Node.js runtime, owns the database, Agent adapters, file system watchers, code intelligence, memory pipeline, and all IPC handlers. Entry point: `src/main/index.ts`.

**Preload** (`src/preload/`) — Bridge between main and renderer via `contextBridge`. Exposes typed IPC channels defined in `IpcApi`.

**Renderer** (`src/renderer/`) — React SPA using @xyflow/react for the mind map canvas, Zustand for state, Tailwind CSS + shadcn/ui for styling.

### Key Architectural Layers

**Agent Adapters** (`src/main/adapters/`) — The primary extension point. Adapters are registered declaratively in `ADAPTER_REGISTRY` (`src/main/adapters/registry.ts`) via `AdapterDescriptor` objects. Each descriptor declares capabilities (`AdapterCapability`), fallback chain (`fallbackTo`), context window, and default compaction strategy. Runtime classes extend `BaseAdapter` and implement `checkInstalled()`, `startSession()`, `doSendCommand()`, `doTerminate()`.

- Supported adapters: claude-code, codex, opencode, cline, kilo-code, kimi-code, codebuddy, qoder, qwen-code, cursor, mcp (API fallback), mindmap-internal.
- **Session model**: CLI adapters use a one-shot process model — each command spawns a new child process. ClaudeCode supports multi-turn continuity via `--resume <sessionId>`. SDK-based adapters use `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk`.
- **MCP auto-fallback**: When a requested CLI adapter is not installed, `AgentManager` automatically falls back to `McpAdapter` (API-based, no CLI required).
- **Health monitoring**: `AdapterHealthMonitor` tracks success/failure/timeout per adapter and dynamically reorders fallback chains.
- **Session recovery**: `SessionRecoveryManager` attempts native resume or replacement-session recovery on crash/error/timeout.
- **NDJSON protocol**: `JsonProtocolHandler` (`src/main/adapters/json-protocol.ts`) provides optional structured stdin/stdout communication with handshake detection.
- **Context compaction**: Adapters implement `compactContext()` with strategies `native` / `llm` / `summary`.
- **Subagent dispatch**: Adapters can expose a `dispatch_subagent` tool routed through `SubagentManager`.

**Agent Runtime** (`src/main/agent/`) — `AgentManager` composes `AdapterRegistry`, `SessionRouter`, and `OutputBroadcaster`. It prepares sandboxes, resolves contexts, sends commands, handles session lifecycle, and routes outputs to renderer windows.

- Injects `SmartContextResolver` (code intelligence), project memory (`readMemory`), session history memory (`MemoryStore`), and assembled prompts (`PromptOrchestrator`).
- Binds `ContextWaterline` for token economics and auto-compaction.
- Wires `SubagentManager` for child-agent dispatch.

**Scope Guard** (`src/main/scope-guard.ts`) — Enforces file change boundaries at the OS level. Before an Agent session starts, it backs up allowed files and starts a chokidar watcher. Out-of-bounds writes trigger automatic rollback. Validates that allowed files don't escape the working directory (path traversal protection). **Integrated into Agent execution flow**: `AgentManager.startSession()` prepares the sandbox, `terminateSession()` runs post-execution validation via `commitChanges()`, and abnormal process exits trigger automatic rollback via `cleanupSessionResources()`.

**IPC Handlers** (`src/main/ipc-handlers.ts`) — Central assembly point that instantiates all services and registers domain-specific handlers split across `src/main/ipc/*.ts`. Handler groups include: agent, graph, mindmap, chat, fs, git, project, settings, dialog, context-waterline, scope-guard, code-intelligence, memory, mode, subagent. The `registerIpcHandlers()` function is the main entry. Path security validation blocks access to system directories and validates paths against registered project roots and session allowed paths.

**Database** (`src/main/database.ts`) — better-sqlite3 stored in the user's app data directory. Schema is defined inline in `migrate()` with `rebuildTableIfNeeded()` for non-destructive migrations and `runIncrementalMigrations()` for additive changes. Uses WAL mode and a schema checksum cache for fast startup.

Eleven tables:
- `graphs` — online/dev graphs per project
- `nodes` — graph nodes with type, status, position, metadata
- `edges` — node relationships
- `bug_nodes` — bug metadata linked to nodes
- `snapshots` — graph snapshots with optional git commit
- `agent_logs` — session completion logs
- `chat_threads` — chat sessions bound to adapters/nodes
- `chat_messages` — chat messages with streaming status and token counts
- `memory_items` — extracted session memories
- `compact_history` — context compaction events
- `subagent_invocations` — child agent invocations

**Dual Graph Model** — Each project has exactly two graphs: `online` (the product/business blueprint) and `dev` (a developer working copy derived from the online graph). Nodes form a hierarchy: project → module → process → feature/bug. Bug nodes have severity levels (low/medium/high/critical) and status (open/fixed/verified). Dev-graph feature nodes are auto-set to `placeholder` on init; starting implementation auto-advances `placeholder → developing`.

**State Machine** (`src/shared/state-machine.ts`) — Enforces legal `NodeStatus` transitions (`draft → confirmed → developing → testing → review → published`) and `BugStatus` transitions (`open → fixed → verified`). `validateTransitionConsistency()` runs at app startup to catch mismatches between `TRANSITION_RULES` and `NODE_STATUS_TRANSITIONS`.

**Project Scanner** (`src/main/project-scanner/`) — Analyzes a project directory to auto-generate an initial mind map. Detects frameworks, parses routes and entities, and builds module/process/feature structures.

**Code Intelligence** (`src/main/code-intelligence/`) — AST-based symbol indexing and context resolution for Agent prompts.
- `SymbolIndex` / `ProjectIndexer` / `AstParser` — parse TypeScript/JS and build symbol/import graphs.
- `SmartContextResolver` — given a user query, resolves primary symbols, related symbols, related files, and import edges.
- `ExecutionPlanner` / `PromptAssembler` — plan and assemble code-aware prompts.
- Wired into `AgentManager` and `GraphService` via `setSymbolIndex()`.

**Memory System** (`src/main/memory/`) — Cross-session memory pipeline inspired by claude-mem.
- `MemoryStore`, `MemoryExtractor`, `ObserverCompressor`, `HallucinationChecker`
- `ContextCompiler`, `ContextDistiller`, `PromptOrchestrator`
- `HybridSearchEngine`, `EmbeddingService`, `GraphMemory`
- `PipelineRunner` runs normalize → compress → extract → verify → compile → waterline → persist on session end.

**Context Waterline** (`src/main/memory/context-waterline.ts`) — Token economics for long chat threads.
- Tracks per-thread token usage and adapter context windows.
- Auto-compaction triggered by `AgentManager` when `shouldAutoCompact()` returns true.
- Persists waterline metadata to `chat_threads` via `CompactHistoryRepository` and `ChatRepository`.

**Subagent Manager** (`src/main/agent/subagent-manager.ts`) — Spawns ephemeral child agent sessions from a parent session's `dispatch_subagent` tool call. Supports built-in agent types (explore, implement, review, fix, general) and user-defined types from settings. Enforces scope strategies (`inherit`, `subset`, `fresh`) and write-intent serialization for overlapping allowed files.

**Repositories** (`src/main/repositories/`) — Data access layer for graphs, nodes, edges, bugs, chat, agent logs, compact history, and subagent invocations.

**Services** (`src/main/services/`) — Wrap repositories with business logic. `GraphService` orchestrates graph/node operations and project paths; `ChatService` handles thread/message streaming.

**Settings** (`src/main/settings.ts`) — JSON-based settings stored in `userData/settings.json`. Manages CLI tool configs, API keys (encrypted via `safeStorage` or AES fallback), MCP servers, adapter preferences, and custom agent types.

**Error Types** (`src/main/errors.ts`) — All errors extend `BizGraphError` with typed `ErrorCode` constants. Domain-specific subclasses: `DatabaseError`, `IpcError`, `AgentError`, `SessionNotFoundError`, `AdapterError`, `ScopeGuardError`.

### Path Aliases

Defined in both `tsconfig.json` and `vite.config.ts`:

| Alias | Resolves to |
|-------|-------------|
| `@/*` | `src/renderer/*` |
| `@main/*` | `src/main/*` |
| `@shared/*` | `src/shared/*` |

### Shared Types (`src/shared/types.ts`)

This file is the single source of truth for all types shared between main and renderer processes. It must NOT import Node.js-specific types (ChildProcess, etc.) since it is loaded in the renderer. The `IpcApi` interface defines all IPC channel signatures. Domain types are split into `src/shared/types/graph.ts`, `src/shared/types/agent.ts`, `src/shared/types/ipc.ts`, and `src/shared/types/subagent.ts`.

## Testing

- **Unit tests**: Vitest with `globals: true`, environment `node`, files in `src/**/*.test.ts`. Tests live alongside source in `__tests__/` directories. Coverage targets `src/main/**/*.ts`.
- **E2E tests**: Playwright configs in `tests/e2e/playwright.browser.config.ts` and `tests/e2e/playwright.electron.config.ts`.
- Run a single test file: `npx vitest run src/main/__tests__/scope-guard.test.ts`

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main` and `develop`:
- `lint` (ubuntu) — `npm run lint` + `npx tsc --noEmit`
- `build` (macOS/Windows/Linux, x64 + arm64 matrix) — production build with artifact upload
- `e2e` (ubuntu/windows/macos) — Playwright browser E2E tests

## Key Conventions

- TypeScript strict mode is enabled. `@typescript-eslint/no-explicit-any` is turned off in ESLint.
- Node IDs use prefixed format (e.g., `node_xxx`, `sandbox_xxx`) generated by `generateId()` in `src/main/shared/env.ts`.
- The IPC layer uses a typed handler wrapper (`createTypedHandle`) for type-safe channel registration.
- Environment variables are sanitized via `buildSafeEnv()` before spawning Agent child processes to prevent leaking sensitive config.
- Adapter metadata lives in `ADAPTER_REGISTRY` (`src/main/adapters/registry.ts`); keep `KNOWN_ADAPTER_NAMES` in `src/main/settings.ts` synchronized when adding adapters.
- Database schema changes require bumping `CURRENT_SCHEMA_VERSION` in `src/main/database.ts`.
- State machine transitions are defined in `src/shared/types/graph.ts` (`NODE_STATUS_TRANSITIONS`) and enforced in `src/shared/state-machine.ts` (`TRANSITION_RULES`). Keep them consistent.
