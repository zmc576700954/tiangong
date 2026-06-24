# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BizGraph is an Electron desktop application that orchestrates Agent CLI tools (Claude Code, Codex, OpenCode) through a visual mind map interface. It defines business scope boundaries ("where to change, how to change") so that agents work within constraints rather than modifying arbitrary files.

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

# Production builds
npm run build        # all-in-one: tsc + vite + electron-builder
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS DMG (arm64 + x64)
npm run build:linux  # Linux AppImage
```

## Architecture

BizGraph is a three-process Electron app:

**Main process** (`src/main/`) — Node.js runtime, owns the database, Agent adapters, file system watchers, and all IPC handlers. Entry point: `src/main/index.ts`.

**Preload** (`src/preload/`) — Bridge between main and renderer via `contextBridge`. Exposes typed IPC channels defined in `IpcApi`.

**Renderer** (`src/renderer/`) — React SPA using @xyflow/react for the mind map canvas, Zustand for state, Tailwind CSS + shadcn/ui for styling.

### Key Architectural Layers

**Agent Adapters** (`src/main/adapters/`) — The primary extension point. Each adapter (claude-code, codex, opencode, mcp-adapter) extends `BaseAdapter` and implements `checkInstalled()`, `startSession()`, `doSendCommand()`, `doTerminate()`. Adapters are registered in `AdapterRegistry` and managed by `AgentManager` → `SessionRouter` → `OutputBroadcaster`.

- **Session model**: All CLI adapters use a one-shot process model — each command spawns a new child process. ClaudeCode adapter supports multi-turn continuity via `--resume <sessionId>`, which tells the CLI to reload prior conversation context. Codex and OpenCode have no resume mechanism.
- **MCP auto-fallback**: When a requested CLI adapter is not installed, `AgentManager` automatically falls back to `McpAdapter` (API-based, no CLI required).
- **NDJSON protocol**: `JsonProtocolHandler` (`src/main/adapters/json-protocol.ts`) provides optional structured stdin/stdout communication with handshake detection. Used for parsing Agent output into typed `AgentOutput` events.
- **Chat system**: Separate from agent sessions. `chat_threads` and `chat_messages` DB tables persist conversation history. The `chat` IPC module (`src/main/ipc/chat.ts`) handles thread management and SSE streaming. `AgentChatPanel` in the renderer renders messages with streaming support.

**Scope Guard** (`src/main/scope-guard.ts`) — Enforces file change boundaries at the OS level. Before an Agent session starts, it backs up allowed files and starts a chokidar watcher. Out-of-bounds writes trigger automatic rollback. Validates that allowed files don't escape the working directory (path traversal protection). **Integrated into Agent execution flow**: `AgentManager.startSession()` prepares the sandbox, `terminateSession()` runs post-execution validation via `commitChanges()`, and abnormal process exits trigger automatic rollback via `cleanupSessionResources()`.

**IPC Handlers** (`src/main/ipc-handlers.ts`) — Central assembly point that instantiates all services and registers domain-specific handlers split across `src/main/ipc/*.ts`. Nine handler groups: agent, graph, mindmap, chat, fs, git, project, settings, dialog. The `registerIpcHandlers()` function is the main entry. Path security validation blocks access to system directories.

**Database** (`src/main/database.ts`) — LibSQL (SQLite superset) stored in the user's app data directory. Schema is defined inline in `migrate()` with `rebuildTableIfNeeded()` for non-destructive migrations. Eight tables: graphs, nodes, edges, bug_nodes, snapshots, agent_logs, chat_threads, chat_messages.

**Dual Graph Model** — Each project has exactly two graphs: `online` (the product/business blueprint) and `dev` (a developer working copy derived from the online graph). Nodes form a hierarchy: module → process → feature/bug. Bug nodes have severity levels (low/medium/high/critical) and status (open/fixed/verified); the `pruned` terminal state from the original design is not yet implemented, and there is no state transition enforcement. Placeholder node status exists and dev-graph feature nodes are auto-set to placeholder on init, but the "start development" derive flow (placeholder → developing) is not yet implemented.

**Project Scanner** (`src/main/project-scanner/`) — Analyzes a project directory to auto-generate an initial mind map. Detects frameworks, parses routes and entities, and builds module/process/feature structures.

**Repositories** (`src/main/repositories/`) — Data access layer for graphs, nodes, edges, and bugs. Services (`src/main/services/`) wrap repositories with business logic.

**Error Types** (`src/main/errors.ts`) — All errors extend `BizGraphError` with typed `ErrorCode` constants. Domain-specific subclasses: `DatabaseError`, `IpcError`, `AgentError`, `SessionNotFoundError`, `AdapterError`, `ScopeGuardError`.

### Path Aliases

Defined in both `tsconfig.json` and `vite.config.ts`:

| Alias | Resolves to |
|-------|-------------|
| `@/*` | `src/renderer/*` |
| `@main/*` | `src/main/*` |
| `@shared/*` | `src/shared/*` |

### Shared Types (`src/shared/types.ts`)

This file is the single source of truth for all types shared between main and renderer processes. It must NOT import Node.js-specific types (ChildProcess, etc.) since it is loaded in the renderer. The `IpcApi` interface defines all IPC channel signatures.

## Testing

- **Unit tests**: Vitest with `globals: true`, environment `node`, files in `src/**/*.test.ts`. Tests live alongside source in `__tests__/` directories. Coverage targets `src/main/**/*.ts`.
- **E2E tests**: Playwright config in `tests/e2e/`.
- Run a single test file: `npx vitest run src/main/__tests__/scope-guard.test.ts`

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main` and `develop`: lint (ubuntu), build (ubuntu/windows/macos matrix), test:e2e (ubuntu with Playwright deps).

## Key Conventions

- TypeScript strict mode is enabled. `@typescript-eslint/no-explicit-any` is turned off in ESLint.
- Node IDs use prefixed format (e.g., `node_xxx`, `sandbox_xxx`) generated by `generateId()` in `src/main/shared/env.ts`.
- The IPC layer uses a typed handler wrapper (`createTypedHandle`) for type-safe channel registration.
- Environment variables are sanitized via `buildSafeEnv()` before spawning Agent child processes to prevent leaking sensitive config.
