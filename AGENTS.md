# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## Project Overview

BizGraph is an Electron desktop application that orchestrates Agent CLI tools (Claude Code, Codex, OpenCode) through a visual mind map interface. It defines business scope boundaries ("where to change, how to change") so that agents work within constraints rather than modifying arbitrary files. BizGraph does not generate code — it makes Agent tools more controllable, collaborative, and reviewable.

## Common Commands

```bash
# Development (hot-reload Electron app at localhost:5173)
npm run dev

# Type-check (all sources including main, renderer, shared)
npx tsc --noEmit

# Lint (ESLint flat config, max 0 warnings)
npm run lint

# Unit tests (Vitest, runs src/**/*.test.ts)
npm run test
npm run test:watch

# Run a single test file
npx vitest run src/main/__tests__/scope-guard.test.ts

# E2E tests (Playwright)
npm run test:e2e

# Production builds
npm run build        # all-in-one: tsc + vite + electron-builder
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS DMG (arm64 + x64)
npm run build:linux  # Linux AppImage
```

## Architecture

BizGraph is a three-process Electron app:

**Main process** (`src/main/`) — Node.js runtime. Owns the database, Agent adapters, file system watchers, scope guard, and all IPC handlers. Entry point: `src/main/index.ts`. The main process boot sequence is: `initDatabase()` → `registerIpcHandlers()` → `createWindow()`.

**Preload** (`src/preload/`) — Bridge between main and renderer via `contextBridge`. Exposes typed IPC channels defined in `IpcApi`.

**Renderer** (`src/renderer/`) — React SPA. Uses @xyflow/react for the mind map canvas, Zustand for state management (7 stores), Tailwind CSS 4 + shadcn/ui for styling. Layout is a three-column design: left file tree panel, center graph canvas, right agent panel — all connected by resizable dividers.

### Agent Adapter System (Primary Extension Point)

The adapter system follows a layered architecture:

1. **BaseAdapter** (`src/main/adapters/base.ts`) — Abstract base class. Subclasses implement 4 methods: `checkInstalled()`, `startSession()`, `doSendCommand()`, `doTerminate()`. Base class handles output emission, process lifecycle, NDJSON protocol, session summaries, and kill timers.
2. **AdapterRegistry** (`src/main/agent/adapter-registry.ts`) — Registration center for all adapters.
3. **SessionRouter** (`src/main/agent/session-router.ts`) — Routes session IDs to their owning adapters, with TTL expiration.
4. **OutputBroadcaster** (`src/main/agent/output-broadcaster.ts`) — Broadcasts agent output to listeners by adapter name.
5. **AgentManager** (`src/main/agent/agent-manager.ts`) — Top-level orchestrator composing the above three. Manages session lifecycle, scope guard integration, memory extraction, health monitoring, and adapter fallback chains.

Registered adapters: `ClaudeCodeAdapter`, `CodexAdapter`, `OpenCodeAdapter`, `McpAdapter`, `CursorAdapter`, `MindMapAdapter`. When a CLI adapter is not installed, `AgentManager` falls back to `McpAdapter` (API-based).

**Session model**: All CLI adapters use a one-shot process model — each command spawns a new child process. ClaudeCode supports multi-turn via `--resume <sessionId>`. For adapters without native resume, `BaseAdapter` generates context summaries from output buffers for pseudo-continuity.

**NDJSON protocol**: `JsonProtocolHandler` (`src/main/adapters/json-protocol.ts`) provides optional structured stdin/stdout communication with handshake detection.

### Scope Guard (File Change Enforcement)

`src/main/scope-guard.ts` — Three-layer defense:
1. **Pre-execution**: File backup before agent session starts
2. **During execution**: chokidar watcher + periodic active scanning for out-of-bounds writes
3. **Post-execution**: Snapshot comparison + enhanced rollback (deletes unauthorized new files)

Integrated into `AgentManager`: `startSession()` prepares sandbox, `terminateSession()` runs `commitChanges()` validation, abnormal exits trigger automatic `rollback()`.

### IPC Architecture

`src/main/ipc-handlers.ts` — Central assembly point. Instantiates all services and registers domain-specific handlers split across `src/main/ipc/*.ts`. Handler groups: agent, graph, mindmap, chat, fs, fs-search, git, project, settings, dialog, scope-guard, code-intelligence, memory, mode.

Path security: `validateFsPath()` blocks system directories, maintains per-window session allowed paths with LRU eviction, and uses realpath cache (TTL 10s, max 500 entries) for symlink resolution.

Uses `createTypedHandle()` wrapper for type-safe channel registration.

### Database

`src/main/database.ts` — LibSQL (SQLite superset) stored in user's app data directory. WAL mode with periodic checkpoints. Schema defined in `migrate()` with `rebuildTableIfNeeded()` for non-destructive migrations using SAVEPOINTs. Tables: graphs, nodes, edges, bug_nodes, snapshots, agent_logs, chat_threads, chat_messages, memory_items, schema_version.

### Dual Graph Model

Each project has exactly two graphs: `online` (product/business blueprint) and `dev` (developer working copy). Node hierarchy: module → process → feature/bug. Bug nodes have severity (low/medium/high/critical) and status (open/fixed/verified).

### Code Intelligence

`src/main/code-intelligence/` — AST parsing, symbol indexing, entity extraction, smart context resolution, and prompt assembly. `SmartContextResolver` provides dependency-aware code context injection into agent prompts.

### Memory System

`src/main/memory/` — Session memory extraction and persistence (inspired by claude-mem). `MemoryExtractor` extracts structured memories from agent output. `MemoryStore` persists to `memory_items` DB table. Cross-adapter memory sharing allows Agent B to reuse Agent A's findings. Mode-aware filtering via `ModeManager`.

### Chat System

Separate from agent sessions. `chat_threads` and `chat_messages` tables persist conversation history. `ChatService` (`src/main/services/chat-service.ts`) handles business logic. The `chat` IPC module handles thread management and SSE streaming.

### Path Aliases

Defined in both `tsconfig.json` and `vite.config.ts`:

| Alias | Resolves to |
|-------|-------------|
| `@/*` | `src/renderer/*` |
| `@main/*` | `src/main/*` |
| `@shared/*` | `src/shared/*` |

### Shared Types (`src/shared/types.ts`)

Single source of truth for all types shared between main and renderer. Split into domain files: `types/graph.ts`, `types/agent.ts`, `types/ipc.ts`, `types/swarm.ts`. Must NOT import Node.js-specific types.

### Error Handling

All errors extend `BizGraphError` (`src/main/errors.ts`) with typed `ErrorCode` constants. Domain subclasses: `DatabaseError`, `IpcError`, `AgentError`, `SessionNotFoundError`, `AdapterError`, `ScopeGuardError`.

## Key Conventions

- TypeScript strict mode enabled. `noUnusedLocals` and `noUnusedParameters` are on; prefix unused vars with `_`.
- ESLint uses flat config (`eslint.config.mjs`). `@typescript-eslint/no-explicit-any` is warn-only. `consistent-type-imports` enforced.
- `no-console` is warn-only, allowing `console.warn`, `console.error`, `console.info`.
- Node IDs use prefixed format (e.g., `node_xxx`, `sandbox_xxx`) generated by `generateId()` in `src/main/shared/env.ts`.
- Environment variables are sanitized via `buildSafeEnv()` before spawning Agent child processes.
- Unit tests live in `__tests__/` directories alongside source code, using Vitest with `globals: true` and `node` environment.
- Coverage targets `src/main/**/*.ts` excluding `index.ts` and `ipc-handlers.ts`.

## Adding a New Agent Adapter

1. Create adapter file in `src/main/adapters/` extending `BaseAdapter`
2. Implement `checkInstalled()`, `startSession()`, `doSendCommand()`, `doTerminate()`
3. Register in `createCoreDependencies()` in `src/main/ipc-handlers.ts`
4. See `src/main/adapters/README.md` for detailed guide

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main` and `develop`: lint (ubuntu), build (ubuntu/windows/macos matrix), test:e2e (ubuntu with Playwright deps).
