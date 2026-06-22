# Mind Map Performance & UX Optimization Design

## Problem Statement

With 50-200 nodes, the mind map canvas suffers from severe performance degradation:
- **Drag lag**: Nodes and cursor freeze during drag; node only appears after mouse release
- **CRUD delays**: Create/update/delete operations have noticeable latency
- **Cursor styling**: No custom cursors; default cursors are hard to see on complex backgrounds
- **Node→Chat association**: "Generate Dev Prompt" and "Add Context" in right-click menu produce no visible feedback
- **Context menu overflow**: Right-click menu can extend beyond viewport boundaries

## Root Cause Analysis

| Issue | Root Cause | Severity |
|-------|-----------|----------|
| Drag lag | `isZoomedOut` passed via `data` to all nodes triggers full re-render on every viewport change | Critical |
| Drag lag | Every BizNode subscribes to global `connectingFrom`/`flashedNodeId` — any connecting mode re-renders ALL nodes | Critical |
| CRUD delay | `batchUpdatePositions` uses O(n*m) lookup instead of Map index | High |
| CRUD delay | Position persistence uses individual `updateNode` IPC calls instead of batch | High |
| Thread lookup | `getThreadByNodeId` does linear scan per BizNode render — O(N*T) | High |
| Streaming | Each streaming chunk triggers `threads.map() → messages.map()` + agentStore sync | High |
| Context menu | Position clamped with hardcoded 280px height estimate; actual height varies | Medium |
| Node→Chat | `handleStartDev` has no loading feedback; `handleAddContext` opens popover instead of using `pendingContextRef` | Medium |

## Design

### 1. State Layering — Split graphStore into Data + Runtime

**Current**: Single `useGraphStore` holds everything — static node/edge data and high-frequency runtime state (`connectingFrom`, `flashedNodeId`, `isZoomedOut`, `zoomLevel`).

**Target**: Two stores with different update frequencies:

```
useGraphDataStore (low-frequency)
  - nodes, edges, bugs
  - selectedNodeId, selectedEdgeId
  - graphId, projectPath, graphType
  - CRUD methods (createNode, updateNode, deleteNode, etc.)

useGraphRuntimeStore (high-frequency)
  - connectingFrom, flashedNodeId
  - isZoomedOut, zoomLevel
  - isConnecting (derived boolean)
```

**Why**: When a user starts connecting nodes, `connectingFrom` changes once. Currently this triggers re-render of every BizNode because they all subscribe to it. With the split, only components that need runtime state subscribe to the runtime store. The data store doesn't change during drag/connection operations, so node content doesn't re-render.

**Migration**: `useGraphStore` becomes a facade that delegates to the two sub-stores, similar to the existing `agentStore` pattern. Existing code using `useGraphStore` continues to work during migration.

### 2. BizNode Data Injection — Remove Per-Node Store Subscriptions

**Current**: Each BizNode subscribes to 3 stores internally:
- `useAgentStore(useShallow(...))` for thread lookup
- `useGraphStore(s => s.connectingFrom)` — global broadcast
- `useGraphStore(s => s.flashedNodeId)` — global broadcast
- `useAgentOutputStore(s => s.threadOutputs[threadId])` — per-thread outputs

**Target**: BizNode receives all data via `data` prop from ReactFlow's node object:

```typescript
// Computed in flowNodes memo (GraphCanvas level)
interface BizNodeData {
  // ... existing fields ...
  isConnectingSource: boolean   // replaces connectingFrom subscription
  isFlashed: boolean            // replaces flashedNodeId subscription
  hasThread: boolean            // replaces getThreadByNodeId per-node lookup
  isDegraded: boolean           // replaces isZoomedOut propagation
}
```

These values are computed once in the `flowNodes` useMemo:
- `isConnectingSource`: `connectingFrom === node.id`
- `isFlashed`: `flashedNodeId === node.id`
- `hasThread`: `nodeThreadMap.has(node.id)` (O(1) with Map index)
- `isDegraded`: computed from zoom level at canvas level

**Why**: ReactFlow already reconciles node `data` changes efficiently — it only re-renders nodes whose `data` reference changed. By computing these values in a single memo at canvas level, we avoid N individual store subscriptions and get ReactFlow's built-in diffing for free.

### 3. Drag Performance Optimization

#### 3a. Use batchUpdatePositions for position persistence

**Current** (`useNodePositionPersistence.ts`):
```typescript
flush: for each node, call store.updateNode(nodeId, { position })
```

**Target**:
```typescript
flush: store.batchUpdatePositions(Array.from(pendingPositions.entries()).map(([id, pos]) => ({ id, position: pos })))
```

Single IPC call instead of N calls.

#### 3b. Fix batchUpdatePositions algorithm

**Current** (`graphStore.ts` line 222):
```typescript
nodes.map(n => {
  const u = updates.find(u => u.id === n.id) // O(n*m)
  ...
})
```

**Target**:
```typescript
const updateMap = new Map(updates.map(u => [u.id, u])) // O(m)
nodes.map(n => {
  const u = updateMap.get(n.id) // O(1)
  ...
})
```

#### 3c. Fix handleNodesChange to forward all change types

**Current**: Only processes `position` type changes. Other types (select, dimensions, remove) are silently dropped.

**Target**: Apply all changes via `applyNodeChanges`, then additionally trigger position persistence for position-type changes:

```typescript
const handleNodesChange = useCallback((changes: NodeChange[]) => {
  // Let ReactFlow handle all changes internally
  applyNodeChanges(changes)

  // Additionally persist position changes
  const positionChanges = changes.filter(c => c.type === 'position' && !c.dragging)
  if (positionChanges.length > 0) {
    onPositionChange(positionChanges)
  }
}, [onPositionChange])
```

#### 3d. Add nodeDragThreshold

Add `nodeDragThreshold={3}` to ReactFlow config. This prevents micro-movements from triggering position updates during drag.

### 4. ThreadStore Map Index

**Current** (`threadStore.ts` line 132-134):
```typescript
getThreadByNodeId: (nodeId) => get().threads.find(t => t.nodeBound === nodeId)
```

**Target**: Maintain a `nodeThreadMap: Map<string, AgentThread>` that is updated on every thread create/delete:

```typescript
// In createThread:
set(state => ({
  threads: [...state.threads, newThread],
  nodeThreadMap: nodeBound
    ? new Map(state.nodeThreadMap).set(nodeBound, newThread)
    : state.nodeThreadMap,
}))

// In deleteThread:
set(state => {
  const deleted = state.threads.find(t => t.id === threadId)
  const newNodeThreadMap = new Map(state.nodeThreadMap)
  if (deleted?.nodeBound) newNodeThreadMap.delete(deleted.nodeBound)
  return { threads: state.threads.filter(t => t.id !== threadId), nodeThreadMap: newNodeThreadMap }
})

// O(1) lookup:
getThreadByNodeId: (nodeId) => get().nodeThreadMap.get(nodeId)
```

### 5. Streaming Message Write Optimization

**Current** (`messageStore.ts`): `appendToStreamingMessage` does `threads.map() → messages.map()` on every chunk.

**Target**: Use index-based update:

```typescript
const threadIndex = threads.findIndex(t => t.id === threadId)
if (threadIndex === -1) return

const messageIndex = threads[threadIndex].messages.findIndex(m => m.id === messageId)
if (messageIndex === -1) return

// Direct array splice + new thread object (only the target thread is recreated)
const newMessages = [...threads[threadIndex].messages]
newMessages[messageIndex] = { ...newMessages[messageIndex], content }
const newThreads = [...threads]
newThreads[threadIndex] = { ...newThreads[threadIndex], messages: newMessages }

set({ threads: newThreads })
```

This avoids mapping over all threads and all messages — only the target thread and its messages array are recreated.

### 6. AgentStore Sync Simplification

**Current**: Every sub-store setState triggers `_originalSetState` on the agentStore facade, doubling setState calls.

**Target**: Remove the proactive subscriber-based sync. Instead, `useAgentStore.getState()` computes the merged state on demand by reading from sub-stores. Components that need reactive updates subscribe to specific sub-stores directly. The facade remains for backward compatibility but only syncs lazily.

**Migration path**: Components currently using `useAgentStore(s => s.threads)` should switch to `useThreadStore(s => s.threads)`. The facade's `getState()` will still return merged state for imperative access. This is a gradual migration — during transition, the facade can keep the subscriber but debounce it (e.g., 16ms RAF) to avoid double-firing on every streaming chunk.

### 7. Custom Cursor Styling

**Behavior**:
- Default canvas: white-fill black-stroke arrow cursor
- Hovering a node: white-fill black-stroke hand cursor
- Dragging a node: white-fill black-stroke hand cursor (stays as hand, no cursor flash)

**Implementation**:
- Create SVG cursor files: `cursor-arrow.svg`, `cursor-hand.svg` (32x32px, white fill, black 1.5px stroke)
- Place in `src/renderer/assets/cursors/`
- CSS in `index.css`:

```css
.react-flow__pane { cursor: url('@/assets/cursors/cursor-arrow.svg') 2 2, default; }
.react-flow__node { cursor: url('@/assets/cursors/cursor-hand.svg') 6 2, pointer; }
.react-flow__node.dragging { cursor: url('@/assets/cursors/cursor-hand.svg') 6 2, grabbing; }
```

- Hotspot coordinates: arrow tip for arrow cursor, index finger tip for hand cursor
- Fallback to standard `default`/`pointer` cursors

### 8. Right-Click Context Menu Overflow Fix

**Current**: Position clamped with hardcoded height estimate (280px for node menu, 140px for canvas menu).

**Target**: Render-then-measure approach:

```typescript
function useMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState({ x, y })

  useLayoutEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const padding = 8
    const maxX = window.innerWidth - rect.width - padding
    const maxY = window.innerHeight - rect.height - padding
    setAdjustedPos({
      x: Math.max(padding, Math.min(x, maxX)),
      y: Math.max(padding, Math.min(y, maxY)),
    })
  }, [x, y])

  return { ref, adjustedPos }
}
```

Consolidate the two duplicate clamping implementations (canvas menu and node menu) into this single hook.

### 9. Node→Chat Association Fix

#### 9a. "Generate Dev Prompt" feedback

**Current**: `handleStartDev` calls async IPC with no visual feedback. User sees nothing until the prompt appears in the chat.

**Target**:
1. Immediately switch to Agent panel: `setActiveRightPanel('agent')`
2. Show toast notification: "Generating dev prompt..."
3. The `pendingPrompt` mechanism already handles the rest (creates thread, fills input)

#### 9b. "Add Context" action

**Current**: `handleAddContext` opens a `contextPopover` for editing context references — not what users expect.

**Target**: Change to use `pendingContextRef` flow (same as file tree right-click → add to chat):
```typescript
const handleAddContext = useCallback((nodeId: string) => {
  const node = graphNodes.find(n => n.id === nodeId)
  if (!node) return
  useAppStore.getState().setPendingContextRef({
    type: 'node',
    id: nodeId,
    label: node.title,
  })
  useAppStore.getState().setActiveRightPanel('agent')
  setNodeContextMenu(null)
}, [graphNodes])
```

This immediately switches to the Agent panel and adds the node as context in the chat input — consistent with the file tree's "add context" behavior.

## Impact Scope

| File | Change Type |
|------|------------|
| `src/renderer/store/graphStore.ts` | Split into data + runtime stores |
| `src/renderer/store/threadStore.ts` | Add nodeThreadMap index |
| `src/renderer/store/messageStore.ts` | Index-based streaming update |
| `src/renderer/store/agentStore.ts` | Remove proactive sync |
| `src/renderer/canvas/GraphCanvas.tsx` | Flow nodes data injection, viewport optimization |
| `src/renderer/canvas/BizNode.tsx` | Remove store subscriptions, use data props |
| `src/renderer/canvas/hooks/useNodePositionPersistence.ts` | Use batchUpdatePositions |
| `src/renderer/canvas/NodeContextMenu.tsx` | useMenuPosition hook |
| `src/renderer/canvas/components/CanvasOverlay.tsx` | Unified menu positioning |
| `src/renderer/canvas/hooks/useNodeOperations.ts` | handleStartDev feedback + handleAddContext fix |
| `src/renderer/assets/cursors/` | New SVG cursor files |
| `src/renderer/index.css` | Custom cursor CSS rules |

## Future-Proofing

The state layering design supports scaling to 1000+ nodes:
- **Data store** only changes on user-initiated CRUD — infrequent, batched
- **Runtime store** changes during interactions but BizNode no longer subscribes to it
- **Map indexes** (nodeThreadMap, position update map) keep lookups O(1)
- If further optimization is needed, ReactFlow's `onlyRenderVisibleElements` already provides viewport culling, and the data injection pattern means adding virtualization is straightforward — just skip computing `flowNodes` for off-screen nodes
