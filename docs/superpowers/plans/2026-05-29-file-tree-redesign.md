# File Tree Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the left panel file tree with a full context menu (11 actions), expand/collapse with lazy-loading, and Agent integration for generating mind map nodes from file tree selections.

**Architecture:** LeftPanel becomes a thin shell delegating to TreeView/TreeNodeItem components backed by fileTreeStore. A new FileTreeContextMenu provides right-click actions that bridge to graphStore (node creation) and agentStore (Agent sessions). A new appStore enables cross-panel communication (switching RightPanel to Agent tab).

**Tech Stack:** React, Zustand + immer, Tailwind CSS, lucide-react icons, Vitest for store tests. No new npm packages.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/renderer/store/appStore.ts` | Create | Panel tab state, agent working directory |
| `src/renderer/store/__tests__/appStore.test.ts` | Create | Unit tests for appStore |
| `src/renderer/store/fileTreeStore.ts` | Modify | Fix toggleExpand lazy-load |
| `src/renderer/store/__tests__/fileTreeStore.test.ts` | Create | Unit tests for store actions |
| `src/renderer/store/graphStore.ts` | Modify | Add `createNodeBatch` |
| `src/renderer/panels/TreeNodeItem.tsx` | Create | Single tree node with click/right-click |
| `src/renderer/panels/TreeView.tsx` | Create | Recursive tree rendering |
| `src/renderer/panels/FileTreeContextMenu.tsx` | Create | Context menu with 11 actions |
| `src/renderer/panels/LeftPanel.tsx` | Rewrite | Thin shell using TreeView |
| `src/renderer/panels/RightPanel.tsx` | Modify | Read appStore for external tab switching |

---

### Task 1: Create appStore

**Files:**
- Create: `src/renderer/store/appStore.ts`
- Create: `src/renderer/store/__tests__/appStore.test.ts`

- [ ] **Step 1: Write failing test for appStore**

```typescript
// src/renderer/store/__tests__/appStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../appStore'

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeRightPanel: 'node',
      agentWorkingDirectory: null,
    })
  })

  it('should have default state', () => {
    const state = useAppStore.getState()
    expect(state.activeRightPanel).toBe('node')
    expect(state.agentWorkingDirectory).toBeNull()
  })

  it('setActiveRightPanel should switch tab', () => {
    useAppStore.getState().setActiveRightPanel('agent')
    expect(useAppStore.getState().activeRightPanel).toBe('agent')
  })

  it('setAgentWorkingDirectory should set path', () => {
    useAppStore.getState().setAgentWorkingDirectory('/project/src/auth')
    expect(useAppStore.getState().agentWorkingDirectory).toBe('/project/src/auth')
  })

  it('setAgentWorkingDirectory null should clear path', () => {
    useAppStore.getState().setAgentWorkingDirectory('/some/path')
    useAppStore.getState().setAgentWorkingDirectory(null)
    expect(useAppStore.getState().agentWorkingDirectory).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/store/__tests__/appStore.test.ts`
Expected: FAIL — module `../appStore` not found

- [ ] **Step 3: Create appStore**

```typescript
// src/renderer/store/appStore.ts
import { create } from 'zustand'

interface AppState {
  activeRightPanel: 'node' | 'agent'
  agentWorkingDirectory: string | null
  setActiveRightPanel: (tab: 'node' | 'agent') => void
  setAgentWorkingDirectory: (dir: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeRightPanel: 'node',
  agentWorkingDirectory: null,
  setActiveRightPanel: (tab) => set({ activeRightPanel: tab }),
  setAgentWorkingDirectory: (dir) => set({ agentWorkingDirectory: dir }),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/store/__tests__/appStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/appStore.ts src/renderer/store/__tests__/appStore.test.ts
git commit -m "feat: add appStore for cross-panel state (tab switching, agent working directory)"
```

---

### Task 2: Fix fileTreeStore toggleExpand lazy-load

**Files:**
- Modify: `src/renderer/store/fileTreeStore.ts`
- Create: `src/renderer/store/__tests__/fileTreeStore.test.ts`

The current `toggleExpand` already checks for empty children and calls `loadChildrenForNode`, but the mutation of `node.children` inside the async callback doesn't trigger a React re-render because it mutates the proxy outside of `set()`. The fix: wrap the children assignment in a `set()` call that replaces the project's root.

- [ ] **Step 1: Write failing test for lazy-load**

```typescript
// src/renderer/store/__tests__/fileTreeStore.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock window.electronAPI before importing store
const mockReadDirDetail = vi.fn()
Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      'fs:readDirDetail': mockReadDirDetail,
      'fs:registerProjectPaths': vi.fn().mockResolvedValue(undefined),
      'fs:copy': vi.fn(),
      'fs:move': vi.fn(),
      'fs:delete': vi.fn(),
      'fs:rename': vi.fn(),
      'fs:createFile': vi.fn(),
      'fs:createDir': vi.fn(),
    },
    localStorage: {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    },
  },
  writable: true,
})

import { useFileTreeStore } from '../fileTreeStore'

describe('fileTreeStore toggleExpand', () => {
  beforeEach(() => {
    useFileTreeStore.setState({
      projects: [],
      expandedPaths: new Set(),
      selectedPaths: new Set(),
      lastSelectedPath: null,
      clipboard: null,
      contextMenuPath: null,
      contextMenuPos: null,
      toast: null,
    })
    vi.clearAllMocks()
  })

  it('should toggle expand state for a directory path', () => {
    useFileTreeStore.setState({
      projects: [{
        id: 'proj-1',
        name: 'test-project',
        path: '/project',
        root: {
          name: 'test-project',
          path: '/project',
          isDirectory: true,
          children: [
            { name: 'src', path: '/project/src', isDirectory: true, children: [] },
          ],
        },
        loading: false,
      }],
    })

    useFileTreeStore.getState().toggleExpand('/project/src')
    expect(useFileTreeStore.getState().expandedPaths.has('/project/src')).toBe(true)

    useFileTreeStore.getState().toggleExpand('/project/src')
    expect(useFileTreeStore.getState().expandedPaths.has('/project/src')).toBe(false)
  })

  it('should trigger lazy-load when expanding a directory with empty children', async () => {
    mockReadDirDetail.mockResolvedValue([
      { name: 'index.ts', path: '/project/src/index.ts', isDirectory: false, size: 100, mtimeMs: 0 },
    ])

    useFileTreeStore.setState({
      projects: [{
        id: 'proj-1',
        name: 'test-project',
        path: '/project',
        root: {
          name: 'test-project',
          path: '/project',
          isDirectory: true,
          children: [
            { name: 'src', path: '/project/src', isDirectory: true, children: [] },
          ],
        },
        loading: false,
      }],
    })

    useFileTreeStore.getState().toggleExpand('/project/src')

    // Wait for async load
    await vi.waitFor(() => {
      const state = useFileTreeStore.getState()
      const proj = state.projects[0]
      const srcNode = proj.root?.children?.[0]
      expect(srcNode?.children?.length).toBeGreaterThan(0)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails (or passes with current buggy mutation)**

Run: `npx vitest run src/renderer/store/__tests__/fileTreeStore.test.ts`
Expected: The lazy-load test may fail because `loadChildrenForNode` mutates `node.children` outside of `set()`.

- [ ] **Step 3: Fix toggleExpand in fileTreeStore**

In `src/renderer/store/fileTreeStore.ts`, replace the `toggleExpand` action (around line 209-237). The fix wraps the children assignment inside `set()`:

```typescript
toggleExpand: (path: string) => {
  set((s) => {
    const newExpanded = new Set(s.expandedPaths)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    s.expandedPaths = newExpanded
    saveExpandedPaths(newExpanded)
  })

  // If expanding and children are empty, lazy-load
  const { expandedPaths, projects } = get()
  if (expandedPaths.has(path)) {
    const proj = projects.find((p) => {
      const node = findNodeByPath(p.root, path)
      return node !== null
    })
    if (proj) {
      const node = findNodeByPath(proj.root, path)
      if (node && node.isDirectory && node.children && node.children.length === 0) {
        loadChildrenForNode(node, get().expandedPaths).then(() => {
          // Trigger re-render by replacing project root in store
          set((s) => {
            const p = s.projects.find((pp) => pp.id === proj.id)
            if (p) {
              p.root = { ...p.root! }
            }
          })
        })
      }
    }
  }
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/store/__tests__/fileTreeStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/fileTreeStore.ts src/renderer/store/__tests__/fileTreeStore.test.ts
git commit -m "fix: fileTreeStore toggleExpand lazy-load triggers re-render after loading children"
```

---

### Task 3: Add createNodeBatch to graphStore

**Files:**
- Modify: `src/renderer/store/graphStore.ts`

- [ ] **Step 1: Add createNodeBatch method**

Add after the existing `createNode` method in `src/renderer/store/graphStore.ts` (around line 88):

```typescript
createNodeBatch: async (nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => {
  const created: GraphNode[] = []
  for (const data of nodesData) {
    const node = await window.electronAPI['node:create'](data)
    created.push(node)
  }
  set((state) => ({ nodes: [...state.nodes, ...created] }))
  return created
},
```

Also add to the `GraphState` interface:

```typescript
createNodeBatch: (nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => Promise<GraphNode[]>
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/graphStore.ts
git commit -m "feat: add createNodeBatch to graphStore for bulk node creation"
```

---

### Task 4: Create TreeNodeItem component

**Files:**
- Create: `src/renderer/panels/TreeNodeItem.tsx`

- [ ] **Step 1: Create TreeNodeItem**

```tsx
// src/renderer/panels/TreeNodeItem.tsx
import { memo, useCallback } from 'react'
import {
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Folder,
  FileCode,
  File,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useFileTreeStore } from '../store/fileTreeStore'
import type { TreeNode } from '../store/fileTreeStore'

function getFileIcon(name: string) {
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return FileCode
  if (name.endsWith('.js') || name.endsWith('.jsx')) return FileCode
  if (name.endsWith('.json')) return FileCode
  if (name.endsWith('.md')) return File
  return File
}

export const TreeNodeItem = memo(function TreeNodeItem({
  node,
  depth,
}: {
  node: TreeNode
  depth: number
}) {
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths)
  const selectedPaths = useFileTreeStore((s) => s.selectedPaths)
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand)
  const selectPath = useFileTreeStore((s) => s.selectPath)
  const setContextMenu = useFileTreeStore((s) => s.setContextMenu)

  const isExpanded = expandedPaths.has(node.path)
  const isSelected = selectedPaths.has(node.path)

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (node.isDirectory) {
        toggleExpand(node.path)
      }
      selectPath(node.path, e.ctrlKey || e.metaKey, e.shiftKey)
    },
    [node.isDirectory, node.path, toggleExpand, selectPath],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // Select the node if not already selected
      if (!selectedPaths.has(node.path)) {
        selectPath(node.path)
      }
      setContextMenu(node.path, { x: e.clientX, y: e.clientY })
    },
    [node.path, selectedPaths, selectPath, setContextMenu],
  )

  const Icon = node.isDirectory
    ? isExpanded
      ? FolderOpen
      : Folder
    : getFileIcon(node.name)

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded text-sm cursor-pointer transition-colors',
          'hover:bg-muted',
          isSelected && 'bg-primary/10 text-primary',
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {node.isDirectory ? (
          isExpanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          )
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <Icon
          className={cn(
            'w-3.5 h-3.5 flex-shrink-0',
            node.isDirectory ? 'text-primary' : 'text-muted-foreground',
          )}
        />
        <span className="truncate">{node.name}</span>
      </div>

      {node.isDirectory && isExpanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeNodeItem key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
})
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors (may have unrelated existing errors, focus on TreeNodeItem-related ones)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/panels/TreeNodeItem.tsx
git commit -m "feat: create TreeNodeItem component with click/expand/right-click handlers"
```

---

### Task 5: Create TreeView component

**Files:**
- Create: `src/renderer/panels/TreeView.tsx`

- [ ] **Step 1: Create TreeView**

```tsx
// src/renderer/panels/TreeView.tsx
import { useFileTreeStore } from '../store/fileTreeStore'
import { TreeNodeItem } from './TreeNodeItem'

export function TreeView() {
  const projects = useFileTreeStore((s) => s.projects)

  return (
    <div className="flex-1 overflow-y-auto">
      {projects.map((project) => (
        <div key={project.id} className="mb-1">
          {project.loading && (
            <div className="px-3 py-1 text-xs text-muted-foreground animate-pulse">
              Loading {project.name}...
            </div>
          )}
          {project.root && (
            <TreeNodeItem node={project.root} depth={0} />
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors related to TreeView

- [ ] **Step 3: Commit**

```bash
git add src/renderer/panels/TreeView.tsx
git commit -m "feat: create TreeView component for recursive tree rendering"
```

---

### Task 6: Create FileTreeContextMenu

**Files:**
- Create: `src/renderer/panels/FileTreeContextMenu.tsx`

- [ ] **Step 1: Create the context menu component**

```tsx
// src/renderer/panels/FileTreeContextMenu.tsx
import { useCallback, useRef, useEffect, useState } from 'react'
import {
  Terminal,
  Sparkles,
  Box,
  GitBranch,
  Code2,
  Bug,
  Plus,
  Copy,
  Scissors,
  Clipboard,
  Trash2,
  Loader2,
  X,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useFileTreeStore } from '../store/fileTreeStore'
import { useGraphStore } from '../store/graphStore'
import { useAppStore } from '../store/appStore'
import { useAgentStore } from '../store/agentStore'
import type { NodeType } from '@shared/types'

interface ContextMenuAction {
  id: string
  label: string
  icon: typeof Terminal
  group: 'agent' | 'generate' | 'file'
  color?: string
  disabled?: boolean
  nodeType?: NodeType
}

const TYPE_OPTIONS: { type: NodeType; label: string; color: string }[] = [
  { type: 'module', label: '业务模块', color: '#3b82f6' },
  { type: 'process', label: '业务流程', color: '#8b5cf6' },
  { type: 'feature', label: '功能点', color: '#22c55e' },
  { type: 'bug', label: 'BUG 点', color: '#ef4444' },
]

export function FileTreeContextMenu() {
  const contextMenuPath = useFileTreeStore((s) => s.contextMenuPath)
  const contextMenuPos = useFileTreeStore((s) => s.contextMenuPos)
  const setContextMenu = useFileTreeStore((s) => s.setContextMenu)
  const setClipboard = useFileTreeStore((s) => s.setClipboard)
  const clipboard = useFileTreeStore((s) => s.clipboard)
  const paste = useFileTreeStore((s) => s.paste)
  const deletePaths = useFileTreeStore((s) => s.deletePaths)
  const projects = useFileTreeStore((s) => s.projects)

  const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)
  const setAgentWorkingDirectory = useAppStore((s) => s.setAgentWorkingDirectory)

  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const [showTypePicker, setShowTypePicker] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!contextMenuPath) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
        setShowTypePicker(false)
        setConfirmDelete(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [contextMenuPath, setContextMenu])

  // Close on Escape
  useEffect(() => {
    if (!contextMenuPath) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setShowTypePicker(false)
        setConfirmDelete(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [contextMenuPath, setContextMenu])

  if (!contextMenuPath || !contextMenuPos) return null

  const nodeName = contextMenuPath.split(/[\\/]/).pop() || contextMenuPath
  const isDirectory = (() => {
    for (const proj of projects) {
      const node = findNodeByPath(proj.root, contextMenuPath)
      if (node) return node.isDirectory
    }
    return false
  })()

  const handleCopy = () => {
    setClipboard('copy', [contextMenuPath])
    setContextMenu(null)
  }

  const handleCut = () => {
    setClipboard('cut', [contextMenuPath])
    setContextMenu(null)
  }

  const handlePaste = async () => {
    const destDir = isDirectory ? contextMenuPath : contextMenuPath.replace(/[\\/][^\\/]+$/, '')
    await paste(destDir)
    setContextMenu(null)
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await deletePaths([contextMenuPath])
    setContextMenu(null)
    setConfirmDelete(false)
  }

  const handleAgentInput = () => {
    setAgentWorkingDirectory(contextMenuPath)
    setActiveRightPanel('agent')
    setContextMenu(null)
  }

  const handleGenerateNode = async (nodeType: NodeType) => {
    const graphs = useGraphStore.getState().graphs
    const onlineGraph = graphs.find((g) => g.type === 'online')
    if (!onlineGraph) {
      useFileTreeStore.getState().setToast({
        message: '请先创建或扫描项目生成在线图',
        type: 'error',
      })
      setContextMenu(null)
      return
    }

    setLoadingAction(`generate-${nodeType}`)

    try {
      const adapters = useAgentStore.getState().adapters.filter((a) => a.installed)
      if (adapters.length === 0) {
        throw new Error('没有已安装的 Agent')
      }

      // Create node directly with default content from path
      const scopeNote = `[Scope: ${contextMenuPath}]`
      const position = calculateNewNodePosition(onlineGraph.id)

      await useGraphStore.getState().createNode({
        type: nodeType,
        status: 'draft',
        title: nodeName,
        description: scopeNote,
        graphId: onlineGraph.id,
        graphType: 'online',
        position,
      })

      useFileTreeStore.getState().setToast({
        message: `已创建${nodeType}节点: ${nodeName}`,
        type: 'success',
      })
    } catch (err) {
      useFileTreeStore.getState().setToast({
        message: `创建节点失败: ${err}`,
        type: 'error',
      })
    } finally {
      setLoadingAction(null)
      setContextMenu(null)
    }
  }

  const handleDeduceMindMap = async () => {
    const graphs = useGraphStore.getState().graphs
    const onlineGraph = graphs.find((g) => g.type === 'online')
    if (!onlineGraph) {
      useFileTreeStore.getState().setToast({
        message: '请先创建或扫描项目生成在线图',
        type: 'error',
      })
      setContextMenu(null)
      return
    }

    setLoadingAction('deduce')

    try {
      const adapters = useAgentStore.getState().adapters.filter((a) => a.installed)
      if (adapters.length === 0) {
        throw new Error('没有已安装的 Agent')
      }

      // Start Agent session to analyze the path
      const config = {
        workingDirectory: '',
        allowedFiles: [contextMenuPath],
        forbiddenFiles: [],
        invariantRules: [],
        upstreamContext: '',
        downstreamContext: '',
        nodeTitle: `推演: ${nodeName}`,
        acceptanceCriteria: [],
      }

      const adapterName = adapters[0].name
      const result = await window.electronAPI['agent:startSession'](adapterName, config)

      const prompt = `分析 ${contextMenuPath} 的代码结构，生成业务模块/流程/功能点的节点层级。返回 JSON 格式：{"modules":[{"title":"模块名","description":"描述","processes":[{"title":"流程名","description":"描述","features":["功能点名"]}]}]}`

      await window.electronAPI['agent:sendCommand'](result.sessionId, {
        type: 'implement',
        description: prompt,
        targetNodeId: '',
      })

      useFileTreeStore.getState().setToast({
        message: 'Agent 推演已启动，请在 Agent 面板查看结果',
        type: 'success',
      })

      // Switch to agent panel to show progress
      setAgentWorkingDirectory(contextMenuPath)
      setActiveRightPanel('agent')
    } catch (err) {
      useFileTreeStore.getState().setToast({
        message: `推演失败: ${err}`,
        type: 'error',
      })
    } finally {
      setLoadingAction(null)
      setContextMenu(null)
    }
  }

  const handleAddIndependentNode = () => {
    setShowTypePicker(true)
  }

  const handleTypeSelected = async (nodeType: NodeType) => {
    const graphs = useGraphStore.getState().graphs
    const onlineGraph = graphs.find((g) => g.type === 'online')
    if (!onlineGraph) {
      useFileTreeStore.getState().setToast({
        message: '请先创建或扫描项目生成在线图',
        type: 'error',
      })
      setShowTypePicker(false)
      setContextMenu(null)
      return
    }

    const position = calculateNewNodePosition(onlineGraph.id)
    await useGraphStore.getState().createNode({
      type: nodeType,
      status: 'draft',
      title: nodeName,
      description: `[Scope: ${contextMenuPath}]`,
      graphId: onlineGraph.id,
      graphType: 'online',
      position,
    })

    setShowTypePicker(false)
    setContextMenu(null)
  }

  // Position menu within viewport
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(contextMenuPos.x, window.innerWidth - 240),
    top: Math.min(contextMenuPos.y, window.innerHeight - 400),
    zIndex: 100,
  }

  return (
    <div
      ref={menuRef}
      className="bg-background border rounded-lg shadow-lg py-1 w-56"
      style={menuStyle}
    >
      {/* Header */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1 flex items-center gap-1">
        <span className="truncate font-medium">{nodeName}</span>
      </div>

      {/* Group 1: Agent Operations */}
      <MenuGroup title="Agent">
        <MenuItem
          icon={Terminal}
          label="Agent 输入框"
          onClick={handleAgentInput}
        />
        <MenuItem
          icon={loadingAction === 'deduce' ? Loader2 : Sparkles}
          label="推演思维导图"
          onClick={handleDeduceMindMap}
          loading={loadingAction === 'deduce'}
        />
      </MenuGroup>

      {/* Group 2: Generate Nodes */}
      <MenuGroup title="生成节点">
        {[
          { type: 'module' as NodeType, label: '生成业务模块', icon: Box },
          { type: 'process' as NodeType, label: '生成业务流程', icon: GitBranch },
          { type: 'feature' as NodeType, label: '生成功能点', icon: Code2 },
          { type: 'bug' as NodeType, label: '生成 BUG 点', icon: Bug },
        ].map(({ type, label, icon }) => (
          <MenuItem
            key={type}
            icon={loadingAction === `generate-${type}` ? Loader2 : icon}
            label={label}
            onClick={() => handleGenerateNode(type)}
            loading={loadingAction === `generate-${type}`}
          />
        ))}
        <MenuItem
          icon={Plus}
          label="添加独立节点"
          onClick={handleAddIndependentNode}
        />
      </MenuGroup>

      {/* Type picker popup */}
      {showTypePicker && (
        <div className="px-2 py-1.5 border-t border-b">
          <div className="text-[10px] text-muted-foreground mb-1 px-1">选择节点类型</div>
          <div className="grid grid-cols-2 gap-1">
            {TYPE_OPTIONS.map(({ type, label, color }) => (
              <button
                key={type}
                onClick={() => handleTypeSelected(type)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              >
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Group 3: File Operations */}
      <MenuGroup title="文件操作">
        <MenuItem icon={Copy} label="复制" onClick={handleCopy} />
        <MenuItem icon={Scissors} label="剪切" onClick={handleCut} />
        <MenuItem
          icon={Clipboard}
          label="粘贴"
          onClick={handlePaste}
          disabled={!clipboard}
        />
        <MenuItem
          icon={confirmDelete ? X : Trash2}
          label={confirmDelete ? '确认删除？' : '删除'}
          onClick={handleDelete}
          danger
        />
      </MenuGroup>
    </div>
  )
}

// ---- Sub-components ----

function MenuGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="px-3 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wider">
        {title}
      </div>
      <div className="px-1 pb-1">{children}</div>
    </>
  )
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
  loading,
}: {
  icon: typeof Terminal
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  loading?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'w-full text-left px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-2',
        disabled
          ? 'text-muted-foreground/50 cursor-not-allowed'
          : danger
            ? 'text-destructive hover:bg-destructive/10'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <Icon className={cn('w-3 h-3', loading && 'animate-spin')} />
      {label}
    </button>
  )
}

// ---- Helpers ----

function findNodeByPath(root: import('../store/fileTreeStore').TreeNode | null, targetPath: string) {
  if (!root) return null
  if (root.path === targetPath) return root
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeByPath(child, targetPath)
      if (found) return found
    }
  }
  return null
}

function calculateNewNodePosition(_graphId: string) {
  const nodes = useGraphStore.getState().nodes
  if (nodes.length === 0) return { x: 250, y: 150 }
  // Place to the right of the rightmost node
  const maxX = Math.max(...nodes.map((n) => n.position.x))
  return { x: maxX + 300, y: 150 }
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors related to FileTreeContextMenu

- [ ] **Step 3: Commit**

```bash
git add src/renderer/panels/FileTreeContextMenu.tsx
git commit -m "feat: create FileTreeContextMenu with 11 actions (Agent, generate nodes, file ops)"
```

---

### Task 7: Rewrite LeftPanel

**Files:**
- Rewrite: `src/renderer/panels/LeftPanel.tsx`

- [ ] **Step 1: Rewrite LeftPanel**

Replace the entire content of `src/renderer/panels/LeftPanel.tsx`:

```tsx
// src/renderer/panels/LeftPanel.tsx
import { useEffect, useCallback, useRef } from 'react'
import {
  FolderOpen,
  Plus,
  Sparkles,
  Loader2,
  Settings,
  X,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useFileTreeStore } from '../store/fileTreeStore'
import { useGraphStore } from '../store/graphStore'
import { useFileTreeKeyboard } from '../store/fileTreeStore'
import { TreeView } from './TreeView'
import { FileTreeContextMenu } from './FileTreeContextMenu'
import { SettingsPanel } from './SettingsPanel'
import { useState } from 'react'

const ipc = typeof window !== 'undefined' && window.electronAPI
  ? window.electronAPI
  : null

export function LeftPanel() {
  const projects = useFileTreeStore((s) => s.projects)
  const addProject = useFileTreeStore((s) => s.addProject)
  const removeProject = useFileTreeStore((s) => s.removeProject)
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand)
  const toast = useFileTreeStore((s) => s.toast)
  const clearToast = useFileTreeStore((s) => s.clearToast)

  const { loadGraphs } = useGraphStore()

  const [isDragOver, setIsDragOver] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [scanningId, setScanningId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Keyboard shortcuts (Ctrl+C, Ctrl+V, Delete, Arrow keys, etc.)
  useFileTreeKeyboard(panelRef)

  // Load saved projects on mount
  useEffect(() => {
    const STORAGE_KEY = 'bizgraph:projects'
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const paths = JSON.parse(raw) as string[]
      if (paths.length > 0) {
        ipc?.['fs:registerProjectPaths'](paths).then(() => {
          for (const dirPath of paths) {
            useFileTreeStore.getState().addProject(dirPath)
          }
        })
      }
    } catch {
      // ignore
    }
  }, [])

  // Auto-clear toast
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(clearToast, 3000)
    return () => clearTimeout(timer)
  }, [toast, clearToast])

  const handleOpenDirectory = useCallback(async () => {
    if (!ipc) return
    try {
      const dirPath = await ipc['dialog:openDirectory']()
      if (!dirPath) return
      if (projects.some((p) => p.path === dirPath)) return
      await addProject(dirPath)
    } catch {
      // handled by store
    }
  }, [projects, addProject])

  const handleScanProject = useCallback(async (projectId: string) => {
    if (!ipc) return
    const project = projects.find((p) => p.id === projectId)
    if (!project) return

    setScanningId(projectId)
    try {
      const result = await ipc['graph:initFromProject']({
        projectPath: project.path,
        projectName: project.name,
      })

      const { setCurrentGraph } = useGraphStore.getState()
      setCurrentGraph(result.onlineGraph.id)
      await loadGraphs()
    } catch {
      // handled by store
    } finally {
      setScanningId(null)
    }
  }, [projects, loadGraphs])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      const items = Array.from(e.dataTransfer.items)
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.()
        if (entry?.isDirectory) {
          const path = e.dataTransfer.getData('text/plain') || (entry as any).path
          if (path) await addProject(path)
        }
      }
    },
    [addProject],
  )

  return (
    <div
      ref={panelRef}
      className={cn(
        'h-full flex flex-col border-r bg-background relative',
        isDragOver && 'ring-2 ring-primary/50',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="h-10 border-b flex items-center justify-between px-3 flex-shrink-0">
        <span className="text-sm font-semibold">Projects</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={handleOpenDirectory}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            title="Open directory"
          >
            <Plus className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            'px-3 py-1.5 text-xs border-b flex items-center gap-1',
            toast.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-green-50 text-green-700',
          )}
        >
          <X className="w-3 h-3 cursor-pointer" onClick={clearToast} />
          {toast.message}
        </div>
      )}

      {/* Empty state */}
      {projects.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-xs px-4">
          <FolderOpen className="w-6 h-6 mb-2 opacity-50" />
          <p>No projects yet</p>
          <p className="mt-1">Click + to open a directory</p>
        </div>
      )}

      {/* Project headers + Tree */}
      {projects.length > 0 && (
        <div className="flex-1 overflow-y-auto p-2">
          {projects.map((project) => (
            <div key={project.id} className="mb-2">
              {/* Project header */}
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-muted group">
                <button
                  onClick={() => toggleExpand(project.path)}
                  className="p-0.5 rounded hover:bg-muted-foreground/10"
                >
                  {useFileTreeStore.getState().expandedPaths.has(project.path) ? (
                    <svg className="w-3 h-3 text-muted-foreground" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3 text-muted-foreground" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                  )}
                </button>
                <Sparkles className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                <span className="text-sm font-medium truncate flex-1">{project.name}</span>
                <button
                  onClick={() => handleScanProject(project.id)}
                  disabled={scanningId === project.id}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-primary/10 text-primary transition-opacity"
                  title="Generate mind map"
                >
                  {scanningId === project.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Sparkles className="w-3 h-3" />
                  )}
                </button>
                <button
                  onClick={() => removeProject(project.id)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-destructive transition-opacity"
                  title="Remove"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>

              {/* Tree content — renders children of the project root */}
              {useFileTreeStore.getState().expandedPaths.has(project.path) && project.root && (
                <div className="ml-2">
                  {project.root.children?.map((child) => (
                    <TreeNodeItem key={child.path} node={child} depth={1} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Context Menu */}
      <FileTreeContextMenu />

      {/* Settings Overlay */}
      {showSettings && (
        <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur flex flex-col">
          <div className="h-10 border-b flex items-center justify-between px-3 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Settings</span>
            </div>
            <button
              onClick={() => setShowSettings(false)}
              className="p-1 rounded hover:bg-muted transition-colors"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <SettingsPanel />
          </div>
        </div>
      )}
    </div>
  )
}
```

**Note:** The project header's expand chevron uses `useFileTreeStore.getState()` directly for the expanded state check. The actual tree content below each project header is rendered by importing `TreeNodeItem` from `./TreeNodeItem` for recursive rendering. Add this import at the top of the file:

```tsx
import { TreeNodeItem } from './TreeNodeItem'
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors related to LeftPanel

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors (fix any unused import warnings)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/panels/LeftPanel.tsx
git commit -m "feat: rewrite LeftPanel using fileTreeStore with TreeView and context menu"
```

---

### Task 8: Update RightPanel for external tab switching

**Files:**
- Modify: `src/renderer/panels/RightPanel.tsx`

- [ ] **Step 1: Add appStore integration**

In `src/renderer/panels/RightPanel.tsx`, add import and subscription:

At the top, add import:
```tsx
import { useAppStore } from '../store/appStore'
```

Inside the `RightPanel` component, after the existing `activeTab` state, add an effect to sync from appStore:

```tsx
// After existing state declarations, around line 59
const activeRightPanel = useAppStore((s) => s.activeRightPanel)
const agentWorkingDirectory = useAppStore((s) => s.agentWorkingDirectory)

// Sync external tab switching
useEffect(() => {
  if (activeRightPanel === 'agent' && activeTab !== 'agent') {
    setActiveTab('agent')
  }
}, [activeRightPanel, activeTab])
```

In the `AgentPanel` component, pass the `agentWorkingDirectory` as the initial working directory. Find the `handleStartWithPrompt` function and update the config to use `agentWorkingDirectory` if available:

```tsx
// In handleStartWithPrompt, update config.workingDirectory
const config: AgentSessionConfig = {
  workingDirectory: useAppStore.getState().agentWorkingDirectory || '',
  // ... rest stays the same
}
```

Also update `handleStartAgent` similarly:
```tsx
const config: AgentSessionConfig = {
  workingDirectory: useAppStore.getState().agentWorkingDirectory || '',
  // ... rest stays the same
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/panels/RightPanel.tsx
git commit -m "feat: RightPanel reads appStore for external tab switching and agent working directory"
```

---

### Task 9: Integration smoke test

**Files:** None (manual testing)

- [ ] **Step 1: Start dev server**

Run: `npm run dev`
Expected: App loads without console errors

- [ ] **Step 2: Test expand/collapse**

1. Open a project directory
2. Click on a subdirectory → should expand and show children
3. Click again → should collapse
4. Reload page → expand state should persist

- [ ] **Step 3: Test right-click context menu**

1. Right-click a file → context menu appears with all 11 actions
2. Right-click a directory → same context menu
3. Click outside menu → menu closes
4. Press Escape → menu closes

- [ ] **Step 4: Test file operations**

1. Right-click file → Copy → right-click another directory → Paste → file appears in target
2. Right-click file → Cut → right-click target directory → Paste → file moved
3. Right-click file → Delete → confirmation appears → click again → file deleted
4. Verify tree refreshes after each operation

- [ ] **Step 5: Test Agent integration**

1. Right-click file → "Agent 输入框" → RightPanel switches to Agent tab
2. Right-click file → "添加独立节点" → type picker appears → select type → node created on canvas
3. Right-click file → "生成业务模块" → node created with default title from filename
4. Verify toast feedback for all operations

- [ ] **Step 6: Run all tests**

Run: `npm run test`
Expected: All existing + new tests pass

- [ ] **Step 7: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 8: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes from smoke testing"
```
