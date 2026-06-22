# Mind Map Performance & UX Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate mind map drag lag, CRUD delays, and re-render storms for 50-200+ nodes; add custom cursors, fix context menu overflow, and fix node→Chat association feedback.

**Architecture:** Split graphStore into data + runtime layers to isolate high-frequency state changes. Move per-node store subscriptions into canvas-level data injection. Add Map indexes for O(1) lookups. Use batch IPC for position persistence. Add render-then-measure for context menus.

**Tech Stack:** React 18, Zustand, @xyflow/react v12, Tailwind CSS v4, SVG cursors

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/renderer/store/graphRuntimeStore.ts` | **NEW** — High-frequency runtime state (connectingFrom, flashedNodeId, isZoomedOut, zoomLevel) |
| `src/renderer/store/graphStore.ts` | **MODIFY** — Remove runtime state, keep data + CRUD only |
| `src/renderer/store/threadStore.ts` | **MODIFY** — Add nodeThreadMap index, O(1) getThreadByNodeId |
| `src/renderer/store/messageStore.ts` | **MODIFY** — Index-based streaming updates |
| `src/renderer/store/agentStore.ts` | **MODIFY** — Debounce sub-store sync |
| `src/renderer/canvas/BizNode.tsx` | **MODIFY** — Remove store subscriptions, use data props |
| `src/renderer/canvas/GraphCanvas.tsx` | **MODIFY** — Data injection in flowNodes memo, viewport optimization, handleNodesChange fix |
| `src/renderer/canvas/hooks/useNodePositionPersistence.ts` | **MODIFY** — Use batchUpdatePositions |
| `src/renderer/canvas/hooks/useMenuPosition.ts` | **NEW** — Render-then-measure menu positioning hook |
| `src/renderer/canvas/NodeContextMenu.tsx` | **MODIFY** — Use useMenuPosition |
| `src/renderer/canvas/components/CanvasOverlay.tsx` | **MODIFY** — Use useMenuPosition for canvas menu |
| `src/renderer/canvas/hooks/useNodeOperations.ts` | **MODIFY** — handleStartDev feedback + handleAddContext fix |
| `src/renderer/assets/cursors/cursor-arrow.svg` | **NEW** — White-fill black-stroke arrow cursor |
| `src/renderer/assets/cursors/cursor-hand.svg` | **NEW** — White-fill black-stroke hand cursor |
| `src/renderer/index.css` | **MODIFY** — Custom cursor CSS rules |

---

### Task 1: Create graphRuntimeStore

**Files:**
- Create: `src/renderer/store/graphRuntimeStore.ts`

- [ ] **Step 1: Create the runtime store file**

```typescript
// src/renderer/store/graphRuntimeStore.ts
import { create } from 'zustand'

interface GraphRuntimeState {
  connectingFrom: string | null
  flashedNodeId: string | null
  isZoomedOut: boolean
  zoomLevel: number

  setConnectingFrom: (id: string | null) => void
  flashNode: (id: string) => void
  setZoomLevel: (zoom: number) => void
  setIsZoomedOut: (isZoomedOut: boolean) => void
}

export const useGraphRuntimeStore = create<GraphRuntimeState>((set) => ({
  connectingFrom: null,
  flashedNodeId: null,
  isZoomedOut: false,
  zoomLevel: 1,

  setConnectingFrom: (id) => set({ connectingFrom: id }),
  flashNode: (id) => {
    set({ flashedNodeId: id })
    setTimeout(() => {
      set((s) => (s.flashedNodeId === id ? { flashedNodeId: null } : {}))
    }, 200)
  },
  setZoomLevel: (zoom) => set({ zoomLevel: zoom }),
  setIsZoomedOut: (isZoomedOut) => set({ isZoomedOut }),
}))
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/store/graphRuntimeStore.ts
git commit -m "feat: add graphRuntimeStore for high-frequency canvas state"
```

---

### Task 2: Remove runtime state from graphStore

**Files:**
- Modify: `src/renderer/store/graphStore.ts:62-66,84-85,492-500`

- [ ] **Step 1: Remove runtime state and methods from graphStore**

Remove from `GraphState` interface:
- `connectingFrom: string | null`
- `flashedNodeId: string | null`
- `setConnectingFrom: (id: string | null) => void`
- `flashNode: (id: string) => void`

Remove from store implementation:
- `connectingFrom: null,`
- `flashedNodeId: null,`
- `setConnectingFrom: (id) => set({ connectingFrom: id }),`
- The entire `flashNode` method

- [ ] **Step 2: Verify no compile errors from other files referencing removed fields**

Run: `npx tsc --noEmit 2>&1 | head -30`

Expected: Errors only in files that reference `connectingFrom`, `flashedNodeId`, `setConnectingFrom`, `flashNode` on `useGraphStore`. These will be fixed in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/graphStore.ts
git commit -m "refactor: remove runtime state from graphStore (moved to graphRuntimeStore)"
```

---

### Task 3: Update GraphCanvas to use graphRuntimeStore

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx:21,77-78,113-114,141-149,214-219,235-246`

- [ ] **Step 1: Add import and replace runtime state subscriptions**

Add import at top:
```typescript
import { useGraphRuntimeStore } from '../store/graphRuntimeStore'
```

Replace lines 77-78:
```typescript
// REMOVE:
const setConnectingFrom = useGraphStore((s) => s.setConnectingFrom)
const flashNode = useGraphStore((s) => s.flashNode)
// REPLACE WITH:
const setConnectingFrom = useGraphRuntimeStore((s) => s.setConnectingFrom)
const flashNode = useGraphRuntimeStore((s) => s.flashNode)
```

- [ ] **Step 2: Replace zoom state with runtime store**

Remove lines 113-114:
```typescript
const [zoomLevel, setZoomLevel] = useState(1)
const [isZoomedOut, setIsZoomedOut] = useState(false)
```

Replace with runtime store selectors:
```typescript
const zoomLevel = useGraphRuntimeStore((s) => s.zoomLevel)
const isZoomedOut = useGraphRuntimeStore((s) => s.isZoomedOut)
const setZoomLevel = useGraphRuntimeStore((s) => s.setZoomLevel)
const setIsZoomedOut = useGraphRuntimeStore((s) => s.setIsZoomedOut)
```

- [ ] **Step 3: Replace useOnViewportChange with runtime store writes**

Replace lines 214-219:
```typescript
useOnViewportChange({
  onChange: (viewport) => {
    setZoomLevel(viewport.zoom)
    setIsZoomedOut(viewport.zoom < 0.5)
  },
})
```

This stays the same functionally but now writes to the runtime store instead of local state.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx
git commit -m "refactor: GraphCanvas uses graphRuntimeStore for zoom and connection state"
```

---

### Task 4: BizNode data injection — remove per-node store subscriptions

**Files:**
- Modify: `src/renderer/canvas/BizNode.tsx`
- Modify: `src/renderer/canvas/GraphCanvas.tsx:43-44,235-246,273-276`

- [ ] **Step 1: Update BizNodeData interface in BizNode.tsx**

Replace the BizNodeProps interface:
```typescript
interface BizNodeProps {
  id: string
  data: GraphNode & {
    bugCount: number
    isZoomedOut?: boolean
    hideTextLabels?: boolean
    isConnectingSource?: boolean
    isFlashed?: boolean
    hasThread?: boolean
    agentThreadId?: string
    agentStatus?: string
    agentSessionId?: string
  }
  selected?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}
```

- [ ] **Step 2: Remove store subscriptions from BizNodeComponent**

Remove these lines from BizNodeComponent:
```typescript
// REMOVE: import { useAgentStore } from '../store/agentStore'
// REMOVE: import { useGraphStore } from '../store/graphStore'
// REMOVE: import { useShallow } from 'zustand/react/shallow'
```

Remove the agent store subscription block (lines 37-44):
```typescript
// REMOVE:
const { agentThreadId, agentStatus, agentSessionId } = useAgentStore(useShallow((s) => {
  const t = s.getThreadByNodeId(data.id)
  return {
    agentThreadId: t?.id,
    agentStatus: t?.status,
    agentSessionId: t?.sessionId,
  }
}))
```

Remove the graph store subscriptions (lines 47-50):
```typescript
// REMOVE:
const connectingFrom = useGraphStore((s) => s.connectingFrom)
const flashedNodeId = useGraphStore((s) => s.flashedNodeId)
const isPotentialTarget = !!connectingFrom && connectingFrom !== data.id
const isFlashing = flashedNodeId === data.id
```

Remove the agent output store subscription (lines 57-60):
```typescript
// REMOVE:
const agentOutputs = useAgentOutputStore((s) => {
  if (!agentThreadId) return EMPTY_OUTPUTS as AgentOutput[]
  return s.threadOutputs[agentThreadId] ?? EMPTY_OUTPUTS as AgentOutput[]
})
```

- [ ] **Step 3: Replace with data prop values**

Add after `const isPreview = ...`:
```typescript
const { isConnectingSource, isFlashed, hasThread, agentThreadId, agentStatus, agentSessionId } = data
const isPotentialTarget = !!isConnectingSource
const isFlashing = !!isFlashed
```

Keep the derived state:
```typescript
const isAgentRunning = agentStatus === 'running'
const isAgentError = agentStatus === 'error'
const isAgentCompleted = agentStatus === 'idle' && !!agentSessionId
```

For agentOutputs, keep the useAgentOutputStore subscription but guard it:
```typescript
const agentOutputs = useAgentOutputStore((s) => {
  if (!agentThreadId) return EMPTY_OUTPUTS as AgentOutput[]
  return s.threadOutputs[agentThreadId] ?? EMPTY_OUTPUTS as AgentOutput[]
})
```

This one subscription is acceptable because it's per-thread (only the node with an active thread subscribes to output changes).

- [ ] **Step 4: Update BizNodeWrapper in GraphCanvas.tsx to pass new data fields**

Replace the BizNodeWrapper function (line 43-45):
```typescript
function BizNodeWrapper({ id, data, selected }: {
  id: string
  data: GraphNode & {
    bugCount: number
    isZoomedOut?: boolean
    hideTextLabels?: boolean
    isConnectingSource?: boolean
    isFlashed?: boolean
    hasThread?: boolean
    agentThreadId?: string
    agentStatus?: string
    agentSessionId?: string
  }
  selected?: boolean
}) {
  return <BizNodeComponent id={id} data={data} selected={selected} />
}
```

- [ ] **Step 5: Compute injected data in flowNodes memo in GraphCanvas.tsx**

Add imports at top of GraphCanvas.tsx:
```typescript
import { useGraphRuntimeStore } from '../store/graphRuntimeStore'
import { useThreadStore } from '../store/threadStore'
```

Add runtime store selectors (after existing graphStore selectors):
```typescript
const connectingFrom = useGraphRuntimeStore((s) => s.connectingFrom)
const flashedNodeId = useGraphRuntimeStore((s) => s.flashedNodeId)
```

Add thread index computation:
```typescript
const nodeThreadMap = useMemo(() => {
  const map = new Map<string, { id: string; status?: string; sessionId?: string }>()
  for (const t of useThreadStore.getState().threads) {
    if (t.nodeBound) {
      map.set(t.nodeBound, { id: t.id, status: t.status, sessionId: t.sessionId })
    }
  }
  return map
}, [useThreadStore.getState().threads])
```

Note: For reactivity, subscribe to threads length + a version counter. A simpler approach that works with Zustand:
```typescript
const threads = useThreadStore((s) => s.threads)
const nodeThreadMap = useMemo(() => {
  const map = new Map<string, { id: string; status?: string; sessionId?: string }>()
  for (const t of threads) {
    if (t.nodeBound) {
      map.set(t.nodeBound, { id: t.id, status: t.status, sessionId: t.sessionId })
    }
  }
  return map
}, [threads])
```

Update `baseFlowNodes` memo to inject all data:
```typescript
const baseFlowNodes: Node[] = useMemo(() => graphNodes.map((node) => {
  const threadInfo = nodeThreadMap.get(node.id)
  return {
    id: node.id,
    type: 'bizNode',
    position: node.position,
    data: {
      ...node,
      bugCount: bugCountMap.get(node.id) ?? 0,
      isZoomedOut,
      hideTextLabels: degradation.hideNodeTextLabels,
      isConnectingSource: connectingFrom === node.id,
      isFlashed: flashedNodeId === node.id,
      hasThread: !!threadInfo,
      agentThreadId: threadInfo?.id,
      agentStatus: threadInfo?.status,
      agentSessionId: threadInfo?.sessionId,
    },
    draggable: node.type !== 'project',
  }
}), [graphNodes, bugCountMap, isZoomedOut, degradation.hideNodeTextLabels, connectingFrom, flashedNodeId, nodeThreadMap])
```

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

Expected: No errors related to BizNode or GraphCanvas

- [ ] **Step 7: Commit**

```bash
git add src/renderer/canvas/BizNode.tsx src/renderer/canvas/GraphCanvas.tsx
git commit -m "perf: BizNode data injection — remove per-node store subscriptions"
```

---

### Task 5: Fix handleNodesChange and add nodeDragThreshold

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx:99-104,462-495`

- [ ] **Step 1: Add applyNodeChanges import**

Add to the `@xyflow/react` import:
```typescript
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useReactFlow,
  useOnViewportChange,
  applyNodeChanges,
  type Edge,
  type Node,
  type OnNodesChange,
  type OnConnect,
  type OnConnectStart,
  type OnConnectEnd,
  Panel,
  MarkerType,
} from '@xyflow/react'
```

- [ ] **Step 2: Add useNodesState for controlled node management**

Add to the `@xyflow/react` import:
```typescript
import { useNodesState } from '@xyflow/react'
```

Add inside `GraphCanvasInner`, before `handleNodesChange`:
```typescript
const [rfNodes, setRfNodes, onRfNodesChange] = useNodesState<Node>([])

// Sync computed flowNodes into ReactFlow's internal state
useEffect(() => {
  setRfNodes(flowNodes)
}, [flowNodes, setRfNodes])
```

Replace the current handleNodesChange (lines 99-104):
```typescript
const handleNodesChange: OnNodesChange<Node> = useCallback(
  (changes) => {
    // Let ReactFlow handle all change types internally (select, dimensions, position, remove)
    onRfNodesChange(changes)
    // Additionally persist position changes to DB
    onPositionChange(changes)
  },
  [onRfNodesChange, onPositionChange],
)
```

Update the ReactFlow component to use `rfNodes` instead of `flowNodes`:
```tsx
<ReactFlow
  nodes={rfNodes}
  // ... rest of props
```

Also update the `handleNodesChange` callback reference in the ReactFlow component from `handleNodesChange` (already correct since we replaced it).

- [ ] **Step 3: Add nodeDragThreshold to ReactFlow**

Add to the ReactFlow component props (after `onlyRenderVisibleElements`):
```tsx
nodeDragThreshold={3}
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx
git commit -m "fix: handleNodesChange forwards all change types + add nodeDragThreshold"
```

---

### Task 6: Use batchUpdatePositions in useNodePositionPersistence

**Files:**
- Modify: `src/renderer/canvas/hooks/useNodePositionPersistence.ts:13-22`

- [ ] **Step 1: Replace individual updateNode calls with batchUpdatePositions**

Replace the `flushPositionUpdates` callback (lines 13-22):
```typescript
const flushPositionUpdates = useCallback(() => {
  const updates = pendingPositionUpdates.current
  if (updates.size === 0) return
  const batch = Array.from(updates.entries()).map(([id, pos]) => ({ id, x: pos.x, y: pos.y }))
  useGraphStore.getState().batchUpdatePositions(batch).catch((err) => {
    console.error('[useNodePositionPersistence] Failed to batch persist positions:', err)
  })
  pendingPositionUpdates.current = new Map()
}, [])
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/canvas/hooks/useNodePositionPersistence.ts
git commit -m "perf: use batchUpdatePositions for drag position persistence"
```

---

### Task 7: Fix batchUpdatePositions O(n*m) algorithm

**Files:**
- Modify: `src/renderer/store/graphStore.ts:217-233`

- [ ] **Step 1: Replace updates.find with Map index**

Replace the `batchUpdatePositions` method:
```typescript
batchUpdatePositions: async (updates) => {
  const prevNodes = get().nodes
  const updateMap = new Map(updates.map((u) => [u.id, u]))
  // 乐观更新
  set((state) => ({
    nodes: state.nodes.map((n) => {
      const u = updateMap.get(n.id)
      return u ? { ...n, position: { x: u.x, y: u.y } } : n
    }),
  }))

  try {
    await window.electronAPI['node:batchUpdatePositions'](updates)
  } catch (err) {
    set({ nodes: prevNodes })
    throw err
  }
},
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/store/graphStore.ts
git commit -m "perf: batchUpdatePositions uses Map index for O(n+m) lookup"
```

---

### Task 8: Add nodeThreadMap index to threadStore

**Files:**
- Modify: `src/renderer/store/threadStore.ts`

- [ ] **Step 1: Add nodeThreadMap to state interface and initial state**

Add to `ThreadState` interface:
```typescript
nodeThreadMap: Map<string, AgentThread>
```

Add to initial state:
```typescript
nodeThreadMap: new Map<string, AgentThread>(),
```

- [ ] **Step 2: Update createThread to maintain index**

Replace the `createThread` method's `set` call:
```typescript
createThread: (adapterName, nodeBound) => {
  const id = generateId('thread')
  const thread: AgentThread = {
    id,
    title: 'New Thread',
    adapterName,
    messages: [],
    contextRefs: [],
    status: 'idle',
    createdAt: Date.now(),
    nodeBound,
  }
  set((state) => {
    const newNodeThreadMap = nodeBound
      ? new Map(state.nodeThreadMap).set(nodeBound, thread)
      : state.nodeThreadMap
    return {
      threads: [...state.threads, thread],
      currentThreadId: id,
      nodeThreadMap: newNodeThreadMap,
    }
  })
  // Persist to DB — use returned DB ID if available
  window.electronAPI['thread:create']({ adapterName, nodeId: nodeBound }).then((dbThread) => {
    if (dbThread?.id && dbThread.id !== id) {
      set((state) => {
        const updatedThread = state.threads.find((t) => t.id === id)
        const newNodeThreadMap = nodeBound && updatedThread
          ? new Map(state.nodeThreadMap).set(nodeBound, { ...updatedThread, id: dbThread.id })
          : state.nodeThreadMap
        return {
          threads: state.threads.map((t) =>
            t.id === id ? { ...t, id: dbThread.id } : t
          ),
          currentThreadId: state.currentThreadId === id ? dbThread.id : state.currentThreadId,
          nodeThreadMap: newNodeThreadMap,
        }
      })
    }
  }).catch((err) => {
    console.error('[threadStore] Failed to persist new thread:', err)
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === id ? { ...t, status: 'error' as const } : t
      ),
    }))
  })
  return id
},
```

- [ ] **Step 3: Update deleteThread to maintain index**

Replace the `deleteThread` method:
```typescript
deleteThread: async (threadId) => {
  const thread = get().threads.find((t) => t.id === threadId)
  try {
    await window.electronAPI['thread:delete'](threadId)
  } catch (err) {
    console.error('[threadStore] Failed to delete thread from DB:', err)
    if (thread) {
      set((state) => ({
        threads: [...state.threads, thread],
        nodeThreadMap: thread.nodeBound
          ? new Map(state.nodeThreadMap).set(thread.nodeBound, thread)
          : state.nodeThreadMap,
      }))
    }
    return
  }
  set((state) => {
    const newNodeThreadMap = new Map(state.nodeThreadMap)
    if (thread?.nodeBound) newNodeThreadMap.delete(thread.nodeBound)
    return {
      threads: state.threads.filter((t) => t.id !== threadId),
      currentThreadId:
        state.currentThreadId === threadId
          ? state.threads.find((t) => t.id !== threadId)?.id ?? null
          : state.currentThreadId,
      nodeThreadMap: newNodeThreadMap,
    }
  })
},
```

- [ ] **Step 4: Replace getThreadByNodeId with Map lookup**

Replace:
```typescript
getThreadByNodeId: (nodeId) => {
  return get().threads.find((t) => t.nodeBound === nodeId)
},
```

With:
```typescript
getThreadByNodeId: (nodeId) => {
  return get().nodeThreadMap.get(nodeId)
},
```

- [ ] **Step 5: Update loadThreads to rebuild index**

Replace:
```typescript
loadThreads: async (filters) => {
  const threads = await window.electronAPI['thread:list'](filters)
  set({ threads })
},
```

With:
```typescript
loadThreads: async (filters) => {
  const threads = await window.electronAPI['thread:list'](filters)
  const nodeThreadMap = new Map<string, AgentThread>()
  for (const t of threads) {
    if (t.nodeBound) nodeThreadMap.set(t.nodeBound, t)
  }
  set({ threads, nodeThreadMap })
},
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/threadStore.ts
git commit -m "perf: threadStore nodeThreadMap index for O(1) getThreadByNodeId"
```

---

### Task 9: Optimize streaming message writes

**Files:**
- Modify: `src/renderer/store/messageStore.ts:103-131`

- [ ] **Step 1: Replace appendToStreamingMessage with index-based update**

Replace the `appendToStreamingMessage` method (lines 103-131):
```typescript
appendToStreamingMessage: (threadId, messageId, content, seq) => {
  // Seq-based chunk dedup
  if (seq !== undefined) {
    const key = `${threadId}:${messageId}`
    const last = get().lastSeq.get(key)
    if (last !== undefined && seq <= last) return
    set((state) => {
      const next = new Map(state.lastSeq)
      next.set(key, seq)
      return { lastSeq: next }
    })
  }

  // Index-based update: find thread and message by index, avoid full map
  const threads = useThreadStore.getState().threads
  const threadIndex = threads.findIndex((t) => t.id === threadId)
  if (threadIndex === -1) return

  const messages = threads[threadIndex].messages
  const messageIndex = messages.findIndex((m) => m.id === messageId)
  if (messageIndex === -1) return

  // Only recreate the target thread and its messages array
  const newMessages = [...messages]
  newMessages[messageIndex] = { ...newMessages[messageIndex], content: newMessages[messageIndex].content + content }
  const newThreads = [...threads]
  newThreads[threadIndex] = { ...newThreads[threadIndex], messages: newMessages }

  useThreadStore.setState({ threads: newThreads })
},
```

- [ ] **Step 2: Apply same pattern to appendToolCall**

Replace `appendToolCall` (lines 133-148):
```typescript
appendToolCall: (threadId, messageId, toolCall) => {
  const threads = useThreadStore.getState().threads
  const threadIndex = threads.findIndex((t) => t.id === threadId)
  if (threadIndex === -1) return

  const messages = threads[threadIndex].messages
  const messageIndex = messages.findIndex((m) => m.id === messageId)
  if (messageIndex === -1) return

  const newMessages = [...messages]
  newMessages[messageIndex] = { ...newMessages[messageIndex], toolCalls: [...(newMessages[messageIndex].toolCalls ?? []), toolCall] }
  const newThreads = [...threads]
  newThreads[threadIndex] = { ...newThreads[threadIndex], messages: newMessages }

  useThreadStore.setState({ threads: newThreads })
},
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/messageStore.ts
git commit -m "perf: index-based streaming message updates"
```

---

### Task 10: Debounce agentStore sub-store sync

**Files:**
- Modify: `src/renderer/store/agentStore.ts:76-106`

- [ ] **Step 1: Replace immediate sync with RAF-debounced sync**

Replace the `syncFromSubStores` function (lines 76-106):
```typescript
let _adapterRafId: number | null = null
let _threadRafId: number | null = null

function syncFromSubStores() {
  // Initial sync
  _originalSetState({
    adapters: useAdapterStore.getState().adapters,
    adapterPreferences: useAdapterStore.getState().adapterPreferences,
    lastFallbackHistory: useAdapterStore.getState().lastFallbackHistory,
    marketplaceItems: useAdapterStore.getState().marketplaceItems,
    openSettingsPanel: useAdapterStore.getState().openSettingsPanel,
    threads: useThreadStore.getState().threads,
    currentThreadId: useThreadStore.getState().currentThreadId,
  })

  // Subscribe to adapterStore changes — RAF-debounced to avoid double-firing during streaming
  useAdapterStore.subscribe((state) => {
    if (_adapterRafId !== null) cancelAnimationFrame(_adapterRafId)
    _adapterRafId = requestAnimationFrame(() => {
      _originalSetState({
        adapters: state.adapters,
        adapterPreferences: state.adapterPreferences,
        lastFallbackHistory: state.lastFallbackHistory,
        marketplaceItems: state.marketplaceItems,
        openSettingsPanel: state.openSettingsPanel,
      })
      _adapterRafId = null
    })
  })

  // Subscribe to threadStore changes — RAF-debounced
  useThreadStore.subscribe((state) => {
    if (_threadRafId !== null) cancelAnimationFrame(_threadRafId)
    _threadRafId = requestAnimationFrame(() => {
      _originalSetState({
        threads: state.threads,
        currentThreadId: state.currentThreadId,
      })
      _threadRafId = null
    })
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/store/agentStore.ts
git commit -m "perf: RAF-debounce agentStore sub-store sync"
```

---

### Task 11: Create custom cursor SVGs

**Files:**
- Create: `src/renderer/assets/cursors/cursor-arrow.svg`
- Create: `src/renderer/assets/cursors/cursor-hand.svg`

- [ ] **Step 1: Create arrow cursor SVG**

```svg
<!-- src/renderer/assets/cursors/cursor-arrow.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <path d="M4 2 L4 26 L11 19 L19 28 L23 24 L15 15 L24 15 Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
</svg>
```

- [ ] **Step 2: Create hand cursor SVG**

```svg
<!-- src/renderer/assets/cursors/cursor-hand.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <path d="M10 18 L10 8 Q10 6 12 6 Q14 6 14 8 L14 16 L16 6 Q16 4 18 4 Q20 4 20 6 L20 16 L22 8 Q22 6 24 6 Q26 6 26 8 L26 18 Q26 26 18 26 L14 26 Q10 26 10 18 Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
</svg>
```

- [ ] **Step 3: Add cursor CSS rules to index.css**

Add after the existing React Flow styles (after line 216):
```css
/* Custom cursors for mind map canvas */
.react-flow__pane {
  cursor: url('@/assets/cursors/cursor-arrow.svg') 4 2, default;
}

.react-flow__node {
  cursor: url('@/assets/cursors/cursor-hand.svg') 6 2, pointer;
}

.react-flow__node.dragging {
  cursor: url('@/assets/cursors/cursor-hand.svg') 6 2, pointer;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/assets/cursors/cursor-arrow.svg src/renderer/assets/cursors/cursor-hand.svg src/renderer/index.css
git commit -m "feat: custom white-fill black-stroke cursors for mind map canvas"
```

---

### Task 12: Create useMenuPosition hook for context menu overflow fix

**Files:**
- Create: `src/renderer/canvas/hooks/useMenuPosition.ts`

- [ ] **Step 1: Create the hook**

```typescript
// src/renderer/canvas/hooks/useMenuPosition.ts
import { useRef, useState, useLayoutEffect } from 'react'

/**
 * Render-then-measure menu positioning.
 * Places menu at (x, y), then adjusts if it overflows the viewport.
 */
export function useMenuPosition(x: number, y: number) {
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

- [ ] **Step 2: Commit**

```bash
git add src/renderer/canvas/hooks/useMenuPosition.ts
git commit -m "feat: useMenuPosition hook for render-then-measure menu positioning"
```

---

### Task 13: Apply useMenuPosition to NodeContextMenu

**Files:**
- Modify: `src/renderer/canvas/NodeContextMenu.tsx:82-86`

- [ ] **Step 1: Add import and use the hook**

Add import:
```typescript
import { useMenuPosition } from './hooks/useMenuPosition'
```

Inside the component, add hook usage (after line 66):
```typescript
const { ref: menuRef, adjustedPos } = useMenuPosition(x, y)
```

Replace the container div (line 83-86):
```tsx
<div
  ref={menuRef}
  className="absolute z-50 bg-background border rounded-lg shadow-lg py-1 w-52"
  style={{ left: adjustedPos.x, top: adjustedPos.y }}
  onClick={(e) => e.stopPropagation()}
>
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/canvas/NodeContextMenu.tsx
git commit -m "fix: NodeContextMenu uses render-then-measure positioning"
```

---

### Task 14: Apply useMenuPosition to CanvasOverlay canvas menu

**Files:**
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx`
- Modify: `src/renderer/canvas/GraphCanvas.tsx:332-370`

- [ ] **Step 1: Update CanvasOverlay to use useMenuPosition for canvas menu**

Add import to CanvasOverlay:
```typescript
import { useMenuPosition } from '../hooks/useMenuPosition'
```

Inside the component, for the canvas background menu (around line 100-118), replace the hardcoded position with useMenuPosition:

```typescript
const { ref: canvasMenuRef, adjustedPos: canvasMenuPos } = useMenuPosition(menuPosition.x, menuPosition.y)
```

Update the canvas menu div to use `canvasMenuRef` and `canvasMenuPos`:
```tsx
<div
  ref={canvasMenuRef}
  className="absolute z-50 bg-background border rounded-lg shadow-lg py-1 w-40"
  style={{ left: canvasMenuPos.x, top: canvasMenuPos.y }}
  ...
>
```

- [ ] **Step 2: Remove clampMenuPosition from GraphCanvas.tsx**

Remove the `clampMenuPosition` callback (lines 332-340) and update `onPaneContextMenu` to just pass the raw position:

```typescript
const onPaneContextMenu = useCallback(
  (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
    event.preventDefault()
    setMenuPosition({ x: event.clientX, y: event.clientY })
    setShowNodeMenu(true)
    setNodeContextMenu(null)
    selectNode(null)
    selectEdge(null)
  },
  [selectNode, selectEdge],
)
```

Also simplify `handleNodeContextMenu` — remove the inline clamping:
```typescript
const handleNodeContextMenu = useCallback(
  (event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    event.stopPropagation()
    setNodeContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
    setShowNodeMenu(false)
    cancelPendingConnection()
  },
  [cancelPendingConnection],
)
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/canvas/components/CanvasOverlay.tsx src/renderer/canvas/GraphCanvas.tsx
git commit -m "fix: context menus use render-then-measure positioning"
```

---

### Task 15: Fix handleStartDev feedback and handleAddContext

**Files:**
- Modify: `src/renderer/canvas/hooks/useNodeOperations.ts:92-112`
- Modify: `src/renderer/canvas/GraphCanvas.tsx:424-427`

- [ ] **Step 1: Add immediate feedback to handleStartDev**

Replace `handleStartDev` (lines 92-112):
```typescript
const handleStartDev = useCallback(async (nodeId: string) => {
  const node = graphNodes.find((n) => n.id === nodeId)
  if (!node || !projectPath) return

  // Immediately switch to Agent panel so user sees feedback
  useAppStore.getState().setActiveRightPanel('agent')

  try {
    // placeholder 节点自动切换到 developing 状态
    if (node.status === 'placeholder') {
      await updateNode(nodeId, { status: 'developing' })
    }

    const prompt = await window.electronAPI['mindmap:buildDevPrompt'](
      nodeId, node.title, node.type, 'feature', graphId ?? '', node.contextRefs,
    )
    if (prompt) {
      useAppStore.getState().setPendingPrompt(prompt)
    }
  } catch (err) {
    console.error('[useNodeOperations] startDev failed:', err)
  }
}, [graphNodes, projectPath, graphId, updateNode])
```

- [ ] **Step 2: Replace handleAddContext with pendingContextRef flow**

Replace `handleAddContext` in GraphCanvas.tsx (lines 424-427):
```typescript
const handleAddContext = useCallback((nodeId: string) => {
  const node = graphNodes.find((n) => n.id === nodeId)
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

- [ ] **Step 3: Commit**

```bash
git add src/renderer/canvas/hooks/useNodeOperations.ts src/renderer/canvas/GraphCanvas.tsx
git commit -m "fix: handleStartDev immediate panel switch + handleAddContext uses pendingContextRef"
```

---

### Task 16: Verify and test

- [ ] **Step 1: Run type check**

Run: `npx tsc --noEmit`

Expected: No errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: No errors (or fix any that appear)

- [ ] **Step 3: Run unit tests**

Run: `npm run test`

Expected: All tests pass

- [ ] **Step 4: Start dev server and manually verify**

Run: `npm run dev`

Verify:
1. Mind map loads with 50+ nodes without lag
2. Drag a node — should be smooth, no freezing
3. Right-click a node — menu stays within viewport
4. Right-click → "Generate Dev Prompt" — Agent panel opens immediately
5. Right-click → "Add Context" — Agent panel opens with node context
6. Cursor is white-fill black-stroke arrow on canvas, hand on nodes
7. Zoom in/out — nodes don't flicker or re-render excessively

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address any issues from manual verification"
```
