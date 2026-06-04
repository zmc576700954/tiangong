# Batch 4 Refactoring Design

**Date**: 2026-06-04
**Status**: Approved
**Scope**: GraphCanvas decomposition, AsyncLocalStorage IPC context, E2E test expansion

---

## 1. GraphCanvas Hook Extraction

### Problem

`GraphCanvasInner` is ~400 lines mixing 5 concerns: node position persistence, AI/business node operations, edge connection flow, selection state, and ReactFlow rendering. Three hooks already exist (`useCanvasKeyboard`, `useAutoLayout`, `useConnectionMode`), but significant logic remains inline.

### Solution

Extract 3 additional hooks. After extraction, `GraphCanvasInner` drops to ~200 lines focused on graph loading, selection state, rendering, and overlay composition.

### Hook: `useNodePositionPersistence(graphId: string)`

**File**: `src/renderer/canvas/hooks/useNodePositionPersistence.ts`

**Extracted from GraphCanvas** (lines 89-124):
- `pendingPositionUpdates` ref (`Map<string, {x, y}>`)
- `debounceTimerRef` ref
- `flushPositionUpdates` callback
- `handleNodesChange` callback (wraps ReactFlow's `onNodesChange`, intercepts `position` changes where `!change.dragging`)

**Interface**:
```ts
function useNodePositionPersistence(graphId: string): {
  handleNodesChange: (changes: NodeChange[]) => void
}
```

**Behavior**:
- On drag end (`change.type === 'position' && !change.dragging`), queues position to `pendingPositionUpdates`
- After 300ms idle, batch-writes positions to `graphStore.updateNode()`
- On unmount or `graphId` change: flushes pending updates, clears timer
- Calls `onNodesChange` (ReactFlow's handler) first for visual update

### Hook: `useNodeOperations(graphId: string, projectPath?: string)`

**File**: `src/renderer/canvas/hooks/useNodeOperations.ts`

**Extracted from GraphCanvas** (lines 410-541):
- `handleAddChild` — creates child node at offset from parent
- `handleGenerateChildren` — AI generates sub-nodes via `mindmap:generateModule`
- `handleEnrichNode` — AI fills description/acceptanceCriteria/rules via `mindmap:enrichNode`
- `handleStartDev` — builds dev prompt via `mindmap:buildDevPrompt`, switches to agent panel

**Interface**:
```ts
function useNodeOperations(graphId: string, projectPath?: string): {
  handleAddChild: (parentId: string, childType: NodeType) => Promise<void>
  handleGenerateChildren: (nodeId: string) => Promise<void>
  handleEnrichNode: (nodeId: string) => Promise<void>
  handleStartDev: (nodeId: string) => Promise<void>
}
```

**Dependencies**: `useGraphStore` (createNode, updateNode, nodes, graphs), `useAppStore` (setPendingPrompt, setActiveRightPanel), `useReactFlow` (screenToFlowPosition).

### Hook: `useEdgeConnection(graphId: string)`

**File**: `src/renderer/canvas/hooks/useEdgeConnection.ts`

**Extracted from GraphCanvas** (lines 129-131, 248-292):
- `pendingConnection` state
- `showEdgeTypeMenu` / `edgeMenuPosition` state
- `validateConnection` callback (checks self-loop, duplicate edges)
- `onConnect` callback (calculates menu position from source/target midpoint, shows edge type menu)
- `handleCreateEdge` callback (creates edge via graphStore, resets state)

**Interface**:
```ts
function useEdgeConnection(graphId: string): {
  pendingConnection: Connection | null
  showEdgeTypeMenu: boolean
  edgeMenuPosition: { x: number; y: number }
  onConnect: (connection: Connection) => void
  handleCreateEdge: (edgeType: EdgeType, content?: EdgeContent) => Promise<void>
  cancelPendingConnection: () => void
}
```

**Dependencies**: `useGraphStore` (createEdge, edges, nodes).

### What Remains in GraphCanvasInner (~200 lines)

- Graph loading effect (`loadGraph(graphId)`)
- Auto-create project node effect
- `bugCountMap` memo
- `rfNodes`/`rfEdges` sync effect (graphNodes → ReactFlow nodes)
- Selection state (`selectedNodeId`, `selectedEdgeId`, `selectNode`, `selectEdge`)
- Canvas click/context menu handlers (onPaneClick, onPaneContextMenu, handleNodeContextMenu)
- Node click handler (delegates to selectNode or connection mode)
- `applyLayout` and initial layout effect
- ReactFlow render + CanvasOverlay composition + NodeContextPopover

---

## 2. AsyncLocalStorage for IPC Context

### Problem

`validateFsPath` in `ipc-handlers.ts` requires `senderId` (webContentsId) to look up per-window session allowed paths. This parameter is manually threaded through the call chain:
- Every handler extracts `event.sender.id`
- Passes it to functions that need sender context
- `ValidateFsPath` type includes `senderId` parameter

### Solution

Create an `AsyncLocalStorage<IpcContext>` that `createTypedHandle` populates automatically before calling the handler. Downstream code reads context via `getIpcContext()`.

### New File: `src/main/ipc/context.ts`

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

export interface IpcContext {
  senderId: number
}

export const ipcContext = new AsyncLocalStorage<IpcContext>()

export function getIpcContext(): IpcContext {
  const ctx = ipcContext.getStore()
  if (!ctx) throw new Error('IpcContext not available outside an IPC handler')
  return ctx
}
```

### Modified: `src/main/ipc/utils.ts`

`createTypedHandle` wraps each handler invocation in `ipcContext.run()`:

```ts
import { ipcContext } from './context'

export function createTypedHandle(ipcMain: Electron.IpcMain): TypedHandle {
  return (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        checkRateLimit(channel, event.sender.id)
        return await ipcContext.run({ senderId: event.sender.id }, () =>
          handler(event, ...args)
        )
      } catch (err) {
        if (err instanceof IpcError) throw err
        throw new IpcError(
          err instanceof Error ? err.message : String(err),
          ErrorCode.IPC_HANDLER_ERROR,
        )
      }
    })
  }
}
```

### Modified: `src/main/ipc-handlers.ts`

`validateFsPath` signature simplifies:

```ts
import { getIpcContext } from './ipc/context'

// Before:  validateFsPath: ValidateFsPath = async (targetPath, operation, senderId) => {
// After:
const validateFsPath: ValidateFsPath = async (targetPath, operation) => {
  const { senderId } = getIpcContext()
  // rest of logic unchanged
}
```

### Modified: `src/shared/types.ts` or `src/main/ipc/fs.ts`

Update `ValidateFsPath` type to remove `senderId`:

```ts
// Before: type ValidateFsPath = (path: string, operation: 'read' | 'write', senderId: number) => Promise<string>
// After:
type ValidateFsPath = (targetPath: string, operation: 'read' | 'write') => Promise<string>
```

### Modified: `src/main/ipc/fs.ts`

All handler calls to `validateFsPath` drop the third argument:

```ts
// Before: const validatedPath = await validateFsPath(targetPath, 'read', event.sender.id)
// After:
const validatedPath = await validateFsPath(targetPath, 'read')
```

### Thread Safety

Node.js `AsyncLocalStorage` creates an isolated store per async context. Each `ipcMain.handle` invocation gets its own store via `ipcContext.run()`. Multiple concurrent IPC calls are safe — each has its own `senderId`.

### Migration Steps

1. Create `src/main/ipc/context.ts`
2. Update `createTypedHandle` in `utils.ts` to wrap in `ipcContext.run()`
3. Update `validateFsPath` signature in `ipc-handlers.ts`
4. Update `ValidateFsPath` type
5. Update all callers in `fs.ts` to drop senderId argument

---

## 3. E2E Test Expansion

### Current State

Only 2 tests in `tests/e2e/app.spec.ts`. No real feature coverage.

### Test Scenarios

**File: `tests/e2e/graph-crud.spec.ts`**
1. Create a new graph via project settings dialog
2. Switch between online and dev graphs
3. Delete a graph

**File: `tests/e2e/node-interactions.spec.ts`**
1. Create a node via right-click canvas context menu
2. Edit node title inline (double-click or inline edit)
3. Change node status via node context menu
4. Delete a node via node context menu
5. Drag to reposition a node (verify position persisted)

**File: `tests/e2e/edge-creation.spec.ts`**
1. Create two nodes, then connect them via drag handle
2. Select edge type from the popup menu
3. Verify edge renders with correct label/style

### Test Infrastructure

**New file: `tests/e2e/helpers/graph-helpers.ts`**
- `createNewGraph(page, name)` — navigate UI to create graph
- `switchToGraph(page, graphName)` — switch graph in sidebar

**New file: `tests/e2e/helpers/node-helpers.ts`**
- `createNodeViaContextMenu(page, type, position)` — right-click canvas, select type
- `editNodeTitle(page, nodeId, newTitle)` — double-click, type, confirm
- `deleteNodeViaContextMenu(page, nodeId)` — right-click node, select delete

### Required data-testid Attributes

Add to existing components:
- `[data-testid="graph-canvas"]` — main ReactFlow container
- `[data-testid="empty-canvas"]` — empty state overlay
- `[data-testid="canvas-menu-create-{type}"]` — canvas context menu items
- `[data-testid="node-menu-{action}"]` — node context menu items
- `[data-testid="edge-type-menu"]` — edge type selection popup
- `[data-testid="edge-type-{type}"]` — edge type options

### Scope Boundaries

**In scope**: Graph CRUD, node CRUD, edge creation, canvas menus.
**Out of scope**: Agent integration (needs CLI mock), chat panel, settings, AI operations. Future batch.

---

## Implementation Order

1. **AsyncLocalStorage** (standalone, no dependencies) — smallest change, highest architectural value
2. **GraphCanvas hooks** (independent of AsyncLocalStorage) — pure frontend refactor
3. **E2E tests** (benefits from data-testid attributes added during hook extraction)

Each item can be implemented and tested independently.
