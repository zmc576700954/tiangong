# Batch 4 Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose GraphCanvas into focused hooks, replace manual senderId threading with AsyncLocalStorage, and add E2E tests for core canvas flows.

**Architecture:** Three independent work streams: (1) AsyncLocalStorage wraps `createTypedHandle` to inject IPC context, (2) three new hooks extract node position persistence, node operations, and edge connection logic from GraphCanvas, (3) Playwright E2E tests cover graph/node/edge CRUD with helper utilities.

**Tech Stack:** TypeScript, React hooks, Node.js AsyncLocalStorage, Playwright, Vitest

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/main/ipc/context.ts` | AsyncLocalStorage for IPC sender context |
| `src/renderer/canvas/hooks/useNodePositionPersistence.ts` | Debounced node drag position persistence |
| `src/renderer/canvas/hooks/useNodeOperations.ts` | AI-assisted and child node operations |
| `src/renderer/canvas/hooks/useEdgeConnection.ts` | Edge creation flow with type selection |
| `tests/e2e/helpers/graph-helpers.ts` | Graph CRUD E2E helper functions |
| `tests/e2e/helpers/node-helpers.ts` | Node interaction E2E helper functions |
| `tests/e2e/graph-crud.spec.ts` | Graph creation/switching/deletion E2E tests |
| `tests/e2e/node-interactions.spec.ts` | Node create/edit/delete E2E tests |
| `tests/e2e/edge-creation.spec.ts` | Edge connection E2E tests |

### Modified Files
| File | Change |
|------|--------|
| `src/main/ipc/utils.ts` | Wrap handler in `ipcContext.run()` |
| `src/main/ipc/fs.ts` | Remove senderId from vRead/vWrite calls |
| `src/main/ipc-handlers.ts` | Simplify validateFsPath signature |
| `src/renderer/canvas/GraphCanvas.tsx` | Replace inline logic with hook calls |
| `src/renderer/canvas/components/CanvasOverlay.tsx` | Add data-testid attributes |
| `src/renderer/canvas/NodeContextMenu.tsx` | Add data-testid attributes |

---

## Task 1: AsyncLocalStorage IPC Context

**Files:**
- Create: `src/main/ipc/context.ts`
- Modify: `src/main/ipc/utils.ts`
- Modify: `src/main/ipc/fs.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Create the AsyncLocalStorage context module**

Create `src/main/ipc/context.ts`:

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

- [ ] **Step 2: Update createTypedHandle to inject context**

In `src/main/ipc/utils.ts`, add the import and wrap the handler call:

Add import at top:
```ts
import { ipcContext } from './context'
```

Replace the `createTypedHandle` function body (lines 136-153):

```ts
export function createTypedHandle(
  ipcMain: Electron.IpcMain,
): TypedHandle {
  return (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        checkRateLimit(channel, event.sender.id)
        return await ipcContext.run({ senderId: event.sender.id }, () =>
          handler(event, ...args),
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

- [ ] **Step 3: Update ValidateFsPath type**

In `src/main/ipc/fs.ts`, change the type on line 12:

```ts
// Before:
export type ValidateFsPath = (targetPath: string, operation: 'read' | 'write', senderId: number) => Promise<string>

// After:
export type ValidateFsPath = (targetPath: string, operation: 'read' | 'write') => Promise<string>
```

- [ ] **Step 4: Update validateFsPath implementation to use getIpcContext**

In `src/main/ipc-handlers.ts`, add import:

```ts
import { getIpcContext } from './ipc/context'
```

Change the validateFsPath implementation (line 112). Replace:

```ts
const validateFsPath: ValidateFsPath = async (targetPath, operation, senderId) => {
```

With:

```ts
const validateFsPath: ValidateFsPath = async (targetPath, operation) => {
  const { senderId } = getIpcContext()
```

- [ ] **Step 5: Update fs.ts vRead/vWrite helpers**

In `src/main/ipc/fs.ts`, replace the vRead/vWrite helpers (lines 82-83):

```ts
// Before:
const vRead = (senderId: number, targetPath: string) => validateFsPath(targetPath, 'read', senderId)
const vWrite = (senderId: number, targetPath: string) => validateFsPath(targetPath, 'write', senderId)

// After:
const vRead = (targetPath: string) => validateFsPath(targetPath, 'read')
const vWrite = (targetPath: string) => validateFsPath(targetPath, 'write')
```

- [ ] **Step 6: Update all fs.ts handler calls to drop senderId**

In `src/main/ipc/fs.ts`, update every `vRead(event.sender.id, ...)` to `vRead(...)` and `vWrite(event.sender.id, ...)` to `vWrite(...)`.

These are the affected lines (showing before → after):

Line 87: `await vRead(event.sender.id, dirPath)` → `await vRead(dirPath)`
Line 96: `await vRead(event.sender.id, filePath)` → `await vRead(filePath)`
Line 104: `await vRead(event.sender.id, dirPath)` → `await vRead(dirPath)`
Line 134: `await vWrite(event.sender.id, filePath)` → `await vWrite(filePath)`
Line 151: `await vWrite(event.sender.id, dirPath)` → `await vWrite(dirPath)`
Line 159: `await vWrite(event.sender.id, targetPath)` → `await vWrite(targetPath)`
Line 172: `await vWrite(event.sender.id, oldPath)` → `await vWrite(oldPath)`
Line 176: `await vWrite(event.sender.id, newPath)` → `await vWrite(newPath)`
Line 193: `await vWrite(event.sender.id, sourcePath)` → `await vWrite(sourcePath)`
Line 194: `await vWrite(event.sender.id, destDir)` → `await vWrite(destDir)`
Line 197: `await vWrite(event.sender.id, destPath)` → `await vWrite(destPath)`
Line 214: `await vRead(event.sender.id, sourcePath)` → `await vRead(sourcePath)`
Line 215: `await vWrite(event.sender.id, destDir)` → `await vWrite(destDir)`
Line 218: `await vWrite(event.sender.id, destPath)` → `await vWrite(destPath)`
Line 236: `await vRead(event.sender.id, targetPath)` → `await vRead(targetPath)`
Line 246: `await vRead(event.sender.id, targetPath)` → `await vRead(targetPath)`
Line 259: `await vRead(event.sender.id, dirPath)` → `await vRead(dirPath)`

- [ ] **Step 7: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Run existing tests**

Run: `npm run test`
Expected: all tests pass

- [ ] **Step 9: Commit**

```bash
git add src/main/ipc/context.ts src/main/ipc/utils.ts src/main/ipc/fs.ts src/main/ipc-handlers.ts
git commit -m "refactor(ipc): replace manual senderId threading with AsyncLocalStorage"
```

---

## Task 2: Extract useNodePositionPersistence Hook

**Files:**
- Create: `src/renderer/canvas/hooks/useNodePositionPersistence.ts`
- Modify: `src/renderer/canvas/GraphCanvas.tsx`

- [ ] **Step 1: Create the hook file**

Create `src/renderer/canvas/hooks/useNodePositionPersistence.ts`:

```ts
import { useCallback, useEffect, useRef } from 'react'
import type { NodeChange } from '@xyflow/react'
import { useGraphStore } from '../../store/graphStore'

/**
 * 管理节点拖拽位置的防抖持久化。
 * 拖拽结束时记录位置，300ms 内无新变化后批量写入数据库。
 */
export function useNodePositionPersistence(graphId: string) {
  const pendingPositionUpdates = useRef<Map<string, { x: number; y: number }>>(new Map())
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPositionUpdates = useCallback(() => {
    const updates = pendingPositionUpdates.current
    if (updates.size === 0) return
    const store = useGraphStore.getState()
    updates.forEach((position, nodeId) => {
      store.updateNode(nodeId, { position }).catch((err) => {
        console.error('[useNodePositionPersistence] Failed to persist node position:', err)
      })
    })
    pendingPositionUpdates.current = new Map()
  }, [])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // 检测拖拽结束相关的 position 变化
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          pendingPositionUpdates.current.set(change.id, { ...change.position })
        }
      }

      // 防抖：300ms 内没有新的位置变化则批量保存
      if (pendingPositionUpdates.current.size > 0) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = setTimeout(flushPositionUpdates, 300)
      }
    },
    [flushPositionUpdates],
  )

  // 切换图时清空待保存的位置队列
  useEffect(() => {
    pendingPositionUpdates.current = new Map()
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [graphId])

  // 组件卸载时刷入最后的位置更新
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        flushPositionUpdates()
      }
    }
  }, [flushPositionUpdates])

  return { handleNodesChange }
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors (hook is standalone, not yet wired up)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/canvas/hooks/useNodePositionPersistence.ts
git commit -m "refactor(canvas): extract useNodePositionPersistence hook"
```

---

## Task 3: Extract useNodeOperations Hook

**Files:**
- Create: `src/renderer/canvas/hooks/useNodeOperations.ts`
- Modify: `src/renderer/canvas/GraphCanvas.tsx`

- [ ] **Step 1: Create the hook file**

Create `src/renderer/canvas/hooks/useNodeOperations.ts`:

```ts
import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import { NODE_TYPE_LABELS } from '@shared/constants'
import type { NodeType } from '@shared/types'
import { useGraphStore } from '../../store/graphStore'
import { useAppStore } from '../../store/appStore'

/**
 * 封装节点相关的业务操作：添加子节点、AI 生成、AI 补充详情、生成开发 Prompt。
 */
export function useNodeOperations(graphId: string, projectPath?: string) {
  const graphNodes = useGraphStore((state) => state.nodes)
  const graphs = useGraphStore((state) => state.graphs)
  const createNode = useGraphStore((state) => state.createNode)
  const updateNode = useGraphStore((state) => state.updateNode)

  const { screenToFlowPosition } = useReactFlow()

  const handleAddChild = useCallback(async (parentId: string, childType: NodeType) => {
    const parent = graphNodes.find((n) => n.id === parentId)
    const offsetX = parent ? 280 : 100
    const offsetY = parent ? 60 : 60
    const position = parent
      ? { x: parent.position.x + offsetX, y: parent.position.y + offsetY }
      : screenToFlowPosition({ x: 400, y: 300 })

    await createNode({
      type: childType,
      status: 'draft',
      title: `新建${NODE_TYPE_LABELS[childType]}`,
      graphId,
      graphType: childType === 'feature' || childType === 'bug' ? 'dev' : 'online',
      parentId,
      position,
      acceptanceCriteria: [],
    })
  }, [graphNodes, createNode, graphId, screenToFlowPosition])

  const handleGenerateChildren = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    try {
      const result = await window.electronAPI['mindmap:generateModule'](
        projectPath, nodeId, node.title, node.type,
      )
      if (result && result.children.length > 0) {
        const parent = graphNodes.find((n) => n.id === nodeId)
        const baseX = parent ? parent.position.x + 280 : 100
        const baseY = parent ? parent.position.y : 0

        for (let i = 0; i < result.children.length; i++) {
          const child = result.children[i]
          await createNode({
            type: result.childType,
            status: 'draft',
            title: child.title,
            description: child.description,
            graphId,
            graphType: result.childType === 'feature' ? 'dev' : 'online',
            parentId: nodeId,
            position: { x: baseX, y: baseY + i * 80 },
            acceptanceCriteria: [],
          })
        }
      }
    } catch (err) {
      console.error('[useNodeOperations] generateChildren failed:', err)
    }
  }, [graphNodes, projectPath, createNode, graphId])

  const handleEnrichNode = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    try {
      const result = await window.electronAPI['mindmap:enrichNode'](
        projectPath, nodeId, node.type, node.title, undefined, node.contextRefs,
      )
      if (result) {
        await updateNode(nodeId, {
          description: result.description,
          acceptanceCriteria: result.acceptanceCriteria,
          rules: result.businessRules,
          metadata: result.metadata,
        })
      }
    } catch (err) {
      console.error('[useNodeOperations] enrichNode failed:', err instanceof Error ? err.message : err)
    }
  }, [graphNodes, projectPath, updateNode])

  const handleStartDev = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    try {
      const prompt = await window.electronAPI['mindmap:buildDevPrompt'](
        nodeId, node.title, node.type, 'feature', graphId ?? '', node.contextRefs,
      )
      if (prompt) {
        useAppStore.getState().setPendingPrompt(prompt)
        useAppStore.getState().setActiveRightPanel('agent')
      }
    } catch (err) {
      console.error('[useNodeOperations] startDev failed:', err)
    }
  }, [graphNodes, projectPath, graphId])

  return {
    handleAddChild,
    handleGenerateChildren,
    handleEnrichNode,
    handleStartDev,
  }
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/canvas/hooks/useNodeOperations.ts
git commit -m "refactor(canvas): extract useNodeOperations hook"
```

---

## Task 4: Extract useEdgeConnection Hook

**Files:**
- Create: `src/renderer/canvas/hooks/useEdgeConnection.ts`
- Modify: `src/renderer/canvas/GraphCanvas.tsx`

- [ ] **Step 1: Create the hook file**

Create `src/renderer/canvas/hooks/useEdgeConnection.ts`:

```ts
import { useState, useCallback } from 'react'
import type { Connection } from '@xyflow/react'
import type { EdgeType, EdgeContent } from '@shared/types'
import { useGraphStore } from '../../store/graphStore'

/**
 * 管理边创建流程：验证连接、弹出边类型菜单、创建边。
 */
export function useEdgeConnection(graphId: string) {
  const graphNodes = useGraphStore((state) => state.nodes)
  const graphEdges = useGraphStore((state) => state.edges)
  const createEdge = useGraphStore((state) => state.createEdge)

  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null)
  const [showEdgeTypeMenu, setShowEdgeTypeMenu] = useState(false)
  const [edgeMenuPosition, setEdgeMenuPosition] = useState({ x: 0, y: 0 })

  const validateConnection = useCallback((connection: Connection): boolean => {
    if (!connection.source || !connection.target) return false
    if (connection.source === connection.target) return false
    const existingEdge = graphEdges.find(
      (e) => e.source === connection.source && e.target === connection.target,
    )
    if (existingEdge) return false
    return true
  }, [graphEdges])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!validateConnection(connection)) return
      if (connection.source && connection.target) {
        const sourceNode = graphNodes.find((n) => n.id === connection.source)
        const targetNode = graphNodes.find((n) => n.id === connection.target)
        if (sourceNode && targetNode) {
          const midX = (sourceNode.position.x + targetNode.position.x) / 2 + 100
          const midY = (sourceNode.position.y + targetNode.position.y) / 2
          setEdgeMenuPosition({ x: midX, y: midY })
        }
      }
      setPendingConnection(connection)
      setShowEdgeTypeMenu(true)
    },
    [validateConnection, graphNodes],
  )

  const handleCreateEdge = useCallback(
    async (edgeType: EdgeType, content?: EdgeContent) => {
      if (!pendingConnection?.source || !pendingConnection?.target) return
      await createEdge({
        source: pendingConnection.source,
        target: pendingConnection.target,
        label: content?.condition || '',
        graphId,
        edgeType,
        content,
      })
      setPendingConnection(null)
      setShowEdgeTypeMenu(false)
    },
    [pendingConnection, createEdge, graphId],
  )

  const cancelPendingConnection = useCallback(() => {
    setPendingConnection(null)
    setShowEdgeTypeMenu(false)
  }, [])

  return {
    pendingConnection,
    showEdgeTypeMenu,
    edgeMenuPosition,
    onConnect,
    handleCreateEdge,
    cancelPendingConnection,
  }
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/canvas/hooks/useEdgeConnection.ts
git commit -m "refactor(canvas): extract useEdgeConnection hook"
```

---

## Task 5: Wire Hooks into GraphCanvasInner

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx`

- [ ] **Step 1: Add imports for new hooks**

Add these imports at the top of `GraphCanvas.tsx` (after the existing hook imports around line 29):

```ts
import { useNodePositionPersistence } from './hooks/useNodePositionPersistence'
import { useNodeOperations } from './hooks/useNodeOperations'
import { useEdgeConnection } from './hooks/useEdgeConnection'
```

- [ ] **Step 2: Replace inline logic with hook calls**

In `GraphCanvasInner`, replace the block of inline state/refs/callbacks with hook calls. The following sections are removed and replaced:

**Remove** (lines 89-124): `pendingPositionUpdates`, `debounceTimerRef`, `flushPositionUpdates`, `handleNodesChange` — replaced by:

```ts
const { handleNodesChange: onPositionChange } = useNodePositionPersistence(graphId)
```

**Remove** (lines 129-131): `pendingConnection`, `showEdgeTypeMenu`, `edgeMenuPosition` state — replaced by edgeConnection hook below.

**Remove** (lines 248-292): `validateConnection`, `onConnect`, `handleCreateEdge` — replaced by:

```ts
const {
  pendingConnection,
  showEdgeTypeMenu,
  edgeMenuPosition,
  onConnect,
  handleCreateEdge,
  cancelPendingConnection,
} = useEdgeConnection(graphId)
```

**Remove** (lines 410-429): `handleAddChild` — replaced by nodeOperations hook.

**Remove** (lines 454-541): `handleGenerateChildren`, `handleEnrichNode`, `handleStartDev` — replaced by:

```ts
const {
  handleAddChild,
  handleGenerateChildren,
  handleEnrichNode,
  handleStartDev,
} = useNodeOperations(graphId, projectPath)
```

- [ ] **Step 3: Update handleNodesChange to use the hook**

Replace the current `handleNodesChange` usage. In the `onPaneClick` callback and the `useEffect` cleanup, the old inline refs are gone. The new `onPositionChange` from `useNodePositionPersistence` replaces `handleNodesChange`.

The `ReactFlow` component's `onNodesChange` prop changes from `handleNodesChange` to a new combined handler:

```ts
const handleNodesChange = useCallback(
  (changes: Parameters<typeof onNodesChange>[0]) => {
    onNodesChange(changes) // ReactFlow visual update
    onPositionChange(changes) // position persistence
  },
  [onNodesChange, onPositionChange],
)
```

- [ ] **Step 4: Update onPaneClick to use cancelPendingConnection**

Replace `setPendingConnection(null)` and `setShowEdgeTypeMenu(false)` in `onPaneClick` with:

```ts
cancelPendingConnection()
```

- [ ] **Step 5: Remove unused imports from GraphCanvas**

After the refactor, these imports are no longer needed in GraphCanvas.tsx:
- Remove `Connection` from `@xyflow/react` import (only used in useEdgeConnection now)
- Remove `EdgeType`, `EdgeContent` from `@shared/types` import (only used in useEdgeConnection)

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Run existing tests**

Run: `npm run test`
Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx
git commit -m "refactor(canvas): wire extracted hooks into GraphCanvasInner"
```

---

## Task 6: Add data-testid Attributes for E2E Tests

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx`
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx`
- Modify: `src/renderer/canvas/NodeContextMenu.tsx`

- [ ] **Step 1: Add data-testid to ReactFlow container**

In `GraphCanvas.tsx`, add `data-testid="graph-canvas"` to the outer div:

```tsx
<div className="w-full h-full relative" data-testid="graph-canvas">
```

- [ ] **Step 2: Add data-testid to empty canvas overlay**

In `CanvasOverlay.tsx`, add `data-testid="empty-canvas"` to the empty state div (line 74):

```tsx
<div className="absolute inset-0 flex items-center justify-center pointer-events-none" data-testid="empty-canvas">
```

- [ ] **Step 3: Add data-testid to canvas menu items**

In `CanvasOverlay.tsx`, add testid to each canvas menu node type button (line 108):

```tsx
<button
  key={type}
  onClick={() => onCreateNode(type)}
  data-testid={`canvas-menu-create-${type}`}
  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
>
```

- [ ] **Step 4: Add data-testid to edge type menu**

In `CanvasOverlay.tsx`, add testid to the edge type menu container (line 119) and each option button (line 128):

Container:
```tsx
<div
  className="absolute z-50 bg-background border rounded-lg shadow-lg py-2 w-56"
  style={{ left: edgeMenuPosition.x, top: edgeMenuPosition.y }}
  data-testid="edge-type-menu"
>
```

Option button:
```tsx
<button
  key={opt.type}
  onClick={() => { /* ... */ }}
  data-testid={`edge-type-${opt.type}`}
  className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center gap-2"
>
```

- [ ] **Step 5: Add data-testid to node context menu items**

In `NodeContextMenu.tsx`, add testid to key action buttons:

Delete button (line 203):
```tsx
<button
  onClick={() => onDelete(nodeId)}
  data-testid="node-menu-delete"
  className="w-full text-left px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-2"
>
```

Connect button (line 127):
```tsx
<button
  onClick={() => onStartConnect(nodeId)}
  data-testid="node-menu-connect"
  className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground"
>
```

Enrich button (line 157):
```tsx
<button
  onClick={() => { onEnrichNode(nodeId); onClose() }}
  data-testid="node-menu-enrich"
  className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground"
>
```

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx src/renderer/canvas/components/CanvasOverlay.tsx src/renderer/canvas/NodeContextMenu.tsx
git commit -m "test(e2e): add data-testid attributes to canvas components"
```

---

## Task 7: E2E Test Helpers

**Files:**
- Create: `tests/e2e/helpers/graph-helpers.ts`
- Create: `tests/e2e/helpers/node-helpers.ts`

- [ ] **Step 1: Create graph helpers**

Create `tests/e2e/helpers/graph-helpers.ts`:

```ts
import type { Page } from '@playwright/test'

/**
 * 等待画布加载完成（ReactFlow 渲染就绪）
 */
export async function waitForCanvas(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="graph-canvas"]', { timeout: 10_000 })
}

/**
 * 在画布空白处右键，打开节点创建菜单
 */
export async function openCanvasMenu(page: Page, position: { x: number; y: number }): Promise<void> {
  const canvas = page.locator('[data-testid="graph-canvas"]')
  await canvas.click({ button: 'right', position })
}

/**
 * 通过右键菜单创建指定类型的节点
 */
export async function createNodeViaMenu(
  page: Page,
  nodeType: string,
  position: { x: number; y: number },
): Promise<void> {
  await openCanvasMenu(page, position)
  await page.click(`[data-testid="canvas-menu-create-${nodeType}"]`)
}
```

- [ ] **Step 2: Create node helpers**

Create `tests/e2e/helpers/node-helpers.ts`:

```ts
import type { Page } from '@playwright/test'

/**
 * 右键点击节点，打开上下文菜单
 */
export async function openNodeMenu(page: Page, nodeId: string): Promise<void> {
  const node = page.locator(`[data-id="${nodeId}"]`)
  await node.click({ button: 'right' })
}

/**
 * 通过节点右键菜单删除节点
 */
export async function deleteNodeViaMenu(page: Page, nodeId: string): Promise<void> {
  await openNodeMenu(page, nodeId)
  await page.click('[data-testid="node-menu-delete"]')
}

/**
 * 获取画布上所有节点的 data-id 列表
 */
export async function getNodeIds(page: Page): Promise<string[]> {
  const nodes = page.locator('[data-id].react-flow__node')
  const count = await nodes.count()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = await nodes.nth(i).getAttribute('data-id')
    if (id) ids.push(id)
  }
  return ids
}
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/helpers/
git commit -m "test(e2e): add graph and node interaction helpers"
```

---

## Task 8: E2E Tests for Node Interactions

**Files:**
- Create: `tests/e2e/node-interactions.spec.ts`

- [ ] **Step 1: Write node interaction E2E tests**

Create `tests/e2e/node-interactions.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { waitForCanvas, createNodeViaMenu } from './helpers/graph-helpers'
import { getNodeIds, deleteNodeViaMenu } from './helpers/node-helpers'

test.describe('Node Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173')
    await waitForCanvas(page)
  })

  test('should create a module node via canvas context menu', async ({ page }) => {
    // Right-click canvas to open menu
    await createNodeViaMenu(page, 'module', { x: 400, y: 300 })

    // Verify a new node appears on canvas
    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(1, { timeout: 5_000 })
  })

  test('should delete a node via context menu', async ({ page }) => {
    // Create a node first
    await createNodeViaMenu(page, 'module', { x: 400, y: 300 })
    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(1, { timeout: 5_000 })

    // Get the node ID and delete it
    const nodeIds = await getNodeIds(page)
    expect(nodeIds.length).toBe(1)

    await deleteNodeViaMenu(page, nodeIds[0])

    // Verify node is removed
    await expect(nodes).toHaveCount(0, { timeout: 5_000 })
  })
})
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/node-interactions.spec.ts
git commit -m "test(e2e): add node creation and deletion E2E tests"
```

---

## Task 9: E2E Tests for Edge Creation

**Files:**
- Create: `tests/e2e/edge-creation.spec.ts`

- [ ] **Step 1: Write edge creation E2E tests**

Create `tests/e2e/edge-creation.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { waitForCanvas, createNodeViaMenu } from './helpers/graph-helpers'
import { getNodeIds } from './helpers/node-helpers'

test.describe('Edge Creation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173')
    await waitForCanvas(page)
  })

  test('should connect two nodes and show edge type menu', async ({ page }) => {
    // Create two nodes
    await createNodeViaMenu(page, 'module', { x: 200, y: 300 })
    await createNodeViaMenu(page, 'process', { x: 500, y: 300 })

    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(2, { timeout: 5_000 })

    // Right-click first node and select connect
    const nodeIds = await getNodeIds(page)
    const sourceNode = page.locator(`[data-id="${nodeIds[0]}"]`)
    await sourceNode.click({ button: 'right' })
    await page.click('[data-testid="node-menu-connect"]')

    // Click second node to trigger connection
    const targetNode = page.locator(`[data-id="${nodeIds[1]}"]`)
    await targetNode.click()

    // Verify edge type menu appears
    await expect(page.locator('[data-testid="edge-type-menu"]')).toBeVisible({ timeout: 5_000 })
  })

  test('should create an edge after selecting type', async ({ page }) => {
    // Create two nodes
    await createNodeViaMenu(page, 'module', { x: 200, y: 300 })
    await createNodeViaMenu(page, 'process', { x: 500, y: 300 })

    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(2, { timeout: 5_000 })

    // Connect via right-click
    const nodeIds = await getNodeIds(page)
    const sourceNode = page.locator(`[data-id="${nodeIds[0]}"]`)
    await sourceNode.click({ button: 'right' })
    await page.click('[data-testid="node-menu-connect"]')

    const targetNode = page.locator(`[data-id="${nodeIds[1]}"]`)
    await targetNode.click()

    // Select default edge type
    await page.click('[data-testid="edge-type-default"]')

    // Verify edge appears
    const edges = page.locator('.react-flow__edge')
    await expect(edges).toHaveCount(1, { timeout: 5_000 })
  })
})
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/edge-creation.spec.ts
git commit -m "test(e2e): add edge creation E2E tests"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Run full type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Run unit tests**

Run: `npm run test`
Expected: all tests pass

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors

- [ ] **Step 4: Verify GraphCanvas line count reduction**

Check `src/renderer/canvas/GraphCanvas.tsx` line count. Target: ~350 lines (down from 682).

Run: `wc -l src/renderer/canvas/GraphCanvas.tsx`
