# 文件树与 Chat 输入框关联 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `@` 提及支持文件搜索，修复文件树右键"Agent 输入框"使其自动注入文件引用到 Chat 上下文。

**Architecture:** 新增 `fs:searchFiles` IPC 通道（主进程递归扫描），扩展 `MentionSearchPopup` 为 Nodes + Files 混合 Tab 搜索，通过 `appStore.pendingContextRef` 实现右键菜单到 Chat 输入框的桥接。

**Tech Stack:** Electron IPC, Zustand, React, Vitest, TypeScript strict mode

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/shared/types.ts` | 新增 `FileSearchResult` 类型 + `IpcApi` 签名 |
| `src/main/ipc/fs.ts` | 新增 `fs:searchFiles` handler（递归目录扫描） |
| `src/main/__tests__/fs-search.test.ts` | 递归搜索逻辑单元测试 |
| `src/preload/index.ts` | 暴露 `fs:searchFiles` 到渲染进程 |
| `src/renderer/store/appStore.ts` | 新增 `pendingContextRef` 状态 |
| `src/renderer/store/__tests__/appStore.test.ts` | 补充 `pendingContextRef` 测试 |
| `src/renderer/components/agent/MentionSearchPopup.tsx` | 重构：Tab + 文件搜索 + debounce |
| `src/renderer/components/agent/ChatInput.tsx` | 传递 `projectPath`，文件选中插入文本 |
| `src/renderer/components/agent/AgentChatPanel.tsx` | 传递 `projectPath`，消费 `pendingContextRef` |
| `src/renderer/panels/FileTreeContextMenu.tsx` | 修复 `handleAgentInput` |

---

### Task 1: Add `FileSearchResult` type and `IpcApi` signature

**Files:**
- Modify: `src/shared/types.ts:407-420`

- [ ] **Step 1: Add `FileSearchResult` interface**

在 `src/shared/types.ts` 的 `ContextRef` 接口之后（约第 186 行）添加：

```typescript
/** 文件搜索结果（用于 @ 提及文件） */
export interface FileSearchResult {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
}
```

- [ ] **Step 2: Add `fs:searchFiles` to `IpcApi`**

在 `src/shared/types.ts` 的 `IpcApi` 中，`'fs:registerProjectPaths'` 之后（约第 420 行）添加：

```typescript
'fs:searchFiles': (dirPath: string, query: string, limit?: number) => Promise<FileSearchResult[]>
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add FileSearchResult and fs:searchFiles IPC signature"
```

---

### Task 2: Implement `fs:searchFiles` IPC handler

**Files:**
- Modify: `src/main/ipc/fs.ts`
- Create: `src/main/__tests__/fs-search.test.ts`

- [ ] **Step 1: Write the failing test**

创建 `src/main/__tests__/fs-search.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}))

import fs from 'node:fs/promises'
import { searchFilesRecursive } from '../ipc/fs'

const mockedReaddir = vi.mocked(fs.readdir)
const mockedStat = vi.mocked(fs.stat)

function makeDirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir }
}

describe('searchFilesRecursive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should find files matching query by name', async () => {
    // /project has src/ (dir) and README.md (file)
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('src', true),
      makeDirent('README.md', false),
    ] as Awaited<ReturnType<typeof fs.readdir>>)

    // /project/src has App.tsx
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('App.tsx', false),
    ] as Awaited<ReturnType<typeof fs.readdir>>)

    const results = await searchFilesRecursive('/project', 'app', 20)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('App.tsx')
    expect(results[0].relativePath).toBe(path.join('src', 'App.tsx'))
    expect(results[0].path).toBe(path.join('/project', 'src', 'App.tsx'))
  })

  it('should skip node_modules and .git', async () => {
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('node_modules', true),
      makeDirent('.git', true),
      makeDirent('index.ts', false),
    ] as Awaited<ReturnType<typeof fs.readdir>>)

    const results = await searchFilesRecursive('/project', 'index', 20)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('index.ts')
    // node_modules and .git should not be read
    expect(mockedReaddir).toHaveBeenCalledTimes(1)
  })

  it('should respect limit', async () => {
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('a.ts', false),
      makeDirent('b.ts', false),
      makeDirent('c.ts', false),
    ] as Awaited<ReturnType<typeof fs.readdir>>)

    const results = await searchFilesRecursive('/project', '.ts', 2)
    expect(results).toHaveLength(2)
  })

  it('should return empty array for empty query', async () => {
    const results = await searchFilesRecursive('/project', '', 20)
    expect(results).toHaveLength(0)
  })

  it('should be case insensitive', async () => {
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('README.md', false),
    ] as Awaited<ReturnType<typeof fs.readdir>>)

    const results = await searchFilesRecursive('/project', 'readme', 20)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('README.md')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/fs-search.test.ts`
Expected: FAIL — `searchFilesRecursive` not exported from `../ipc/fs`

- [ ] **Step 3: Implement `searchFilesRecursive` and IPC handler**

在 `src/main/ipc/fs.ts` 顶部添加 import 和导出函数：

```typescript
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TypedHandle } from './utils'
import type { FileSearchResult } from '@shared/types'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '__pycache__', '.DS_Store', '.vscode', '.idea',
  'coverage', '.cache', '.turbo',
])

export async function searchFilesRecursive(
  dirPath: string,
  query: string,
  limit: number = 20,
): Promise<FileSearchResult[]> {
  if (!query) return []
  const results: FileSearchResult[] = []
  const q = query.toLowerCase()

  async function walk(dir: string) {
    if (results.length >= limit) return
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // 跳过无权限目录
    }

    for (const entry of entries) {
      if (results.length >= limit) return
      if (SKIP_DIRS.has(entry.name)) continue

      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(dirPath, fullPath)

      if (entry.name.toLowerCase().includes(q)) {
        results.push({
          name: entry.name,
          path: fullPath,
          relativePath,
          isDirectory: entry.isDirectory(),
        })
      }

      if (entry.isDirectory()) {
        await walk(fullPath)
      }
    }
  }

  await walk(dirPath)
  return results
}
```

在 `registerFsHandlers` 函数末尾（`fs:stat` handler 之后）添加：

```typescript
typedHandle('fs:searchFiles', async (_, dirPath, query, limit) => {
  const validPath = await validateFsPath(dirPath, 'read')
  return searchFilesRecursive(validPath, query, limit)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/fs-search.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run full test suite**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/fs.ts src/main/__tests__/fs-search.test.ts
git commit -m "feat(ipc): add fs:searchFiles recursive file search handler"
```

---

### Task 3: Expose `fs:searchFiles` in preload

**Files:**
- Modify: `src/preload/index.ts:44-56`

- [ ] **Step 1: Add channel to exposedChannels**

在 `src/preload/index.ts` 的 `exposedChannels` 数组中，`'fs:registerProjectPaths'` 之后添加：

```typescript
'fs:searchFiles',
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose fs:searchFiles to renderer"
```

---

### Task 4: Add `pendingContextRef` to appStore

**Files:**
- Modify: `src/renderer/store/appStore.ts`
- Modify: `src/renderer/store/__tests__/appStore.test.ts`

- [ ] **Step 1: Write the failing test**

在 `src/renderer/store/__tests__/appStore.test.ts` 中追加：

```typescript
import type { ContextRef } from '@shared/types'

// ... inside describe block, add:

it('should have default pendingContextRef as null', () => {
  expect(useAppStore.getState().pendingContextRef).toBeNull()
})

it('setPendingContextRef should set ref', () => {
  const ref: ContextRef = { type: 'file', id: '/path/to/file.ts', label: 'file.ts' }
  useAppStore.getState().setPendingContextRef(ref)
  expect(useAppStore.getState().pendingContextRef).toEqual(ref)
})

it('setPendingContextRef null should clear ref', () => {
  useAppStore.getState().setPendingContextRef({ type: 'file', id: '/x', label: 'x' })
  useAppStore.getState().setPendingContextRef(null)
  expect(useAppStore.getState().pendingContextRef).toBeNull()
})
```

同时在 `beforeEach` 中重置 `pendingContextRef`：

```typescript
beforeEach(() => {
  useAppStore.setState({
    activeRightPanel: 'node',
    agentWorkingDirectory: null,
    pendingContextRef: null,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/store/__tests__/appStore.test.ts`
Expected: FAIL — `pendingContextRef` does not exist on type

- [ ] **Step 3: Implement pendingContextRef in appStore**

替换 `src/renderer/store/appStore.ts` 全部内容为：

```typescript
import { create } from 'zustand'
import type { ContextRef } from '@shared/types'

interface AppState {
  activeRightPanel: 'node' | 'agent'
  agentWorkingDirectory: string | null
  pendingContextRef: ContextRef | null
  setActiveRightPanel: (tab: 'node' | 'agent') => void
  setAgentWorkingDirectory: (dir: string | null) => void
  setPendingContextRef: (ref: ContextRef | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeRightPanel: 'node',
  agentWorkingDirectory: null,
  pendingContextRef: null,
  setActiveRightPanel: (tab) => set({ activeRightPanel: tab }),
  setAgentWorkingDirectory: (dir) => set({ agentWorkingDirectory: dir }),
  setPendingContextRef: (ref) => set({ pendingContextRef: ref }),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/store/__tests__/appStore.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/appStore.ts src/renderer/store/__tests__/appStore.test.ts
git commit -m "feat(store): add pendingContextRef to appStore"
```

---

### Task 5: Extend MentionSearchPopup with Tab + file search

**Files:**
- Modify: `src/renderer/components/agent/MentionSearchPopup.tsx`

- [ ] **Step 1: Rewrite MentionSearchPopup**

替换 `src/renderer/components/agent/MentionSearchPopup.tsx` 全部内容为：

```typescript
import { useState, useEffect, useCallback, useRef } from 'react'
import { Circle, FileText, Folder } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useGraphStore } from '../../store/graphStore'
import type { ContextRef, FileSearchResult } from '@shared/types'

interface MentionSearchPopupProps {
  filter: string
  onSelect: (ref: ContextRef) => void
  onClose: () => void
  excludeIds: string[]
  projectPath?: string
}

type Tab = 'nodes' | 'files'

export function MentionSearchPopup({ filter, onSelect, onClose, excludeIds, projectPath }: MentionSearchPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [tab, setTab] = useState<Tab>('nodes')
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // --- Node results (existing logic) ---
  const nodes = useGraphStore((s) => s.nodes)
  const nodeResults: ContextRef[] = nodes
    .filter((n) => n.title.toLowerCase().includes(filter.toLowerCase()))
    .filter((n) => !excludeIds.includes(n.id))
    .slice(0, 8)
    .map((n) => ({ type: 'node', id: n.id, label: n.title }))

  // --- File results (new: debounced IPC call) ---
  useEffect(() => {
    if (tab !== 'files' || !projectPath || !filter) {
      setFileResults([])
      return
    }

    setFileLoading(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await window.electronAPI['fs:searchFiles'](projectPath, filter, 12)
        setFileResults(results.filter((r) => !r.isDirectory && !excludeIds.includes(r.path)))
      } catch {
        setFileResults([])
      } finally {
        setFileLoading(false)
      }
    }, 300)

    return () => clearTimeout(debounceRef.current)
  }, [tab, projectPath, filter, excludeIds])

  // --- Combined results ---
  const results: ContextRef[] = tab === 'nodes'
    ? nodeResults
    : fileResults.map((f) => ({
        type: 'file' as const,
        id: f.path,
        label: f.relativePath,
      }))

  useEffect(() => {
    setSelectedIndex(0)
  }, [tab, filter])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (results[selectedIndex]) onSelect(results[selectedIndex])
      } else if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        setTab((t) => (t === 'nodes' ? 'files' : 'nodes'))
      }
    },
    [results, selectedIndex, onSelect, onClose],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const showEmpty = results.length === 0 && (tab === 'nodes' || !fileLoading)

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-background border border-border rounded-lg shadow-lg overflow-hidden z-50">
      {/* Tab bar */}
      <div className="flex border-b border-border">
        <button
          onMouseDown={(e) => { e.preventDefault(); setTab('nodes') }}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] transition-colors',
            tab === 'nodes'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Circle className="w-3 h-3" />
          Nodes
        </button>
        <button
          onMouseDown={(e) => { e.preventDefault(); setTab('files') }}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] transition-colors',
            tab === 'files'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Folder className="w-3 h-3" />
          Files
        </button>
      </div>

      {/* Results */}
      <div className="max-h-[180px] overflow-y-auto">
        {showEmpty ? (
          <div className="px-3 py-3 text-center">
            <p className="text-[10px] text-muted-foreground">
              {filter ? `No ${tab} found for "${filter}"` : `Type to search ${tab}`}
            </p>
          </div>
        ) : fileLoading && tab === 'files' ? (
          <div className="px-3 py-3 text-center">
            <p className="text-[10px] text-muted-foreground animate-pulse">Searching...</p>
          </div>
        ) : (
          results.map((item, i) => (
            <button
              key={item.id}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(item)
              }}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors',
                i === selectedIndex ? 'bg-muted' : 'hover:bg-muted/50',
              )}
            >
              {item.type === 'node' ? (
                <Circle className="w-3 h-3 text-blue-400 flex-shrink-0" />
              ) : (
                <FileText className="w-3 h-3 text-green-400 flex-shrink-0" />
              )}
              <span className="text-xs truncate">{item.label}</span>
              <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                {item.type}
              </span>
            </button>
          ))
        )}
      </div>

      {/* Hint */}
      <div className="flex items-center justify-between px-2.5 py-1 border-t border-border bg-muted/30">
        <span className="text-[9px] text-muted-foreground/60">
          Tab switch · ↑↓ navigate · Enter select · Esc close
        </span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/MentionSearchPopup.tsx
git commit -m "feat(mention): add Tab + file search to MentionSearchPopup"
```

---

### Task 6: Pass `projectPath` through ChatInput

**Files:**
- Modify: `src/renderer/components/agent/ChatInput.tsx:9-16, 94-101`

- [ ] **Step 1: Add `projectPath` prop to ChatInput**

在 `src/renderer/components/agent/ChatInput.tsx` 的 `ChatInputProps` 接口中添加：

```typescript
interface ChatInputProps {
  onSend: (content: string, contextRefs: ContextRef[]) => void
  onStop?: () => void
  onMentionAdd?: (ref: ContextRef) => void
  disabled?: boolean
  isRunning?: boolean
  attachedContexts: ContextRef[]
  projectPath?: string  // 新增
}
```

在函数参数解构中添加 `projectPath`：

```typescript
export function ChatInput({ onSend, onStop, onMentionAdd, disabled, isRunning, attachedContexts, projectPath }: ChatInputProps) {
```

- [ ] **Step 2: Pass `projectPath` to MentionSearchPopup**

找到 `MentionSearchPopup` 的 JSX 使用（约第 94-101 行），添加 `projectPath` prop：

```typescript
{showMention && (
  <MentionSearchPopup
    filter={mentionFilter}
    onSelect={handleMentionSelect}
    onClose={() => setShowMention(false)}
    excludeIds={attachedContexts.filter((c) => c.type === 'node').map((c) => c.id)}
    projectPath={projectPath}
  />
)}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/ChatInput.tsx
git commit -m "feat(chat-input): pass projectPath to MentionSearchPopup"
```

---

### Task 7: Wire up AgentChatPanel with projectPath + pendingContextRef

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

- [ ] **Step 1: Import `useAppStore` and read `projectPath`**

在 `AgentChatPanel.tsx` 的 import 区域确保有：

```typescript
import { useAppStore } from '../../store/appStore'
```

在组件函数体中，现有的 `selectedNode` 声明之后添加：

```typescript
const pendingContextRef = useAppStore((s) => s.pendingContextRef)
const setPendingContextRef = useAppStore((s) => s.setPendingContextRef)

const graphs = useGraphStore((s) => s.graphs)
const currentGraphId = useGraphStore((s) => s.currentGraphId)
const currentGraph = graphs.find((g) => g.id === currentGraphId)
const projectPath = currentGraph?.projectPath
```

注意：组件内部已有一个 `useGraphStore.getState()` 调用在 `handleSend` 中（第 203-204 行），这里改为响应式读取以避免重复。

- [ ] **Step 2: Add `useEffect` to consume `pendingContextRef`**

在现有的 `useEffect` 块之后添加：

```typescript
// Consume pendingContextRef from file tree right-click
useEffect(() => {
  if (pendingContextRef) {
    setAttachedContexts((prev) => {
      if (prev.some((c) => c.id === pendingContextRef.id)) return prev
      return [...prev, pendingContextRef]
    })
    setPendingContextRef(null)
  }
}, [pendingContextRef, setPendingContextRef])
```

- [ ] **Step 3: Pass `projectPath` to `ChatInput`**

找到 `<ChatInput` JSX（约第 332-339 行），添加 `projectPath`：

```typescript
<ChatInput
  onSend={handleSend}
  onStop={handleStop}
  onMentionAdd={handleMentionAdd}
  disabled={!!isRunning}
  isRunning={!!isRunning}
  attachedContexts={attachedContexts}
  projectPath={projectPath}
/>
```

- [ ] **Step 4: Inject file context refs into `sessionConfig.allowedFiles`**

在 `handleSend` 函数中，找到 `sessionConfig` 构建（约第 206-215 行），修改 `allowedFiles`：

```typescript
const sessionConfig: AgentSessionConfig = {
  workingDirectory: currentGraph?.projectPath ?? '',
  allowedFiles: contextRefs.filter((r) => r.type === 'file').map((r) => r.id),
  forbiddenFiles: [],
  invariantRules: selectedNode?.rules?.map((r) => r.title) ?? [],
  upstreamContext: '',
  downstreamContext: '',
  nodeTitle: selectedNode?.title ?? '',
  acceptanceCriteria: selectedNode?.acceptanceCriteria ?? [],
}
```

同时移除 `handleSend` 内部已有的 `useGraphStore.getState()` 调用（第 203-205 行），改为使用组件顶部的响应式 `currentGraph`：

```typescript
// 删除这三行：
// const graphs = useGraphStore.getState().graphs
// const currentGraphId = useGraphStore.getState().currentGraphId
// const currentGraph = graphs.find((g) => g.id === currentGraphId)
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(agent-panel): wire projectPath and pendingContextRef"
```

---

### Task 8: Fix FileTreeContextMenu handleAgentInput

**Files:**
- Modify: `src/renderer/panels/FileTreeContextMenu.tsx:115-119`

- [ ] **Step 1: Import `useAppStore` setter for `pendingContextRef`**

在 `FileTreeContextMenu.tsx` 组件内部，确保 `useAppStore` 的选择器包含 `setPendingContextRef`：

找到现有的 appStore 选择器（约第 42-43 行）：

```typescript
const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)
const setAgentWorkingDirectory = useAppStore((s) => s.setAgentWorkingDirectory)
```

在其后添加：

```typescript
const setPendingContextRef = useAppStore((s) => s.setPendingContextRef)
```

- [ ] **Step 2: Update `handleAgentInput`**

替换现有的 `handleAgentInput` 函数（约第 115-119 行）：

```typescript
const handleAgentInput = () => {
  setAgentWorkingDirectory(contextMenuPath)
  setPendingContextRef({
    type: 'file',
    id: contextMenuPath,
    label: nodeName,
  })
  setActiveRightPanel('agent')
  setContextMenu(null)
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/renderer/panels/FileTreeContextMenu.tsx
git commit -m "feat(file-tree): fix handleAgentInput to inject file context"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Run all checks**

```bash
npm run lint
npx tsc --noEmit
npm run test
```

Expected: All pass with 0 errors, 0 warnings.

- [ ] **Step 2: Manual verification**

1. `npm run dev` 启动应用
2. 打开一个项目，确认文件树加载
3. 在 Chat 输入框输入 `@`，确认 Nodes tab 默认显示节点列表
4. 按 `Tab` 切换到 Files tab，输入文件名片段（如 `app`），确认出现文件搜索结果（显示相对路径）
5. 用 `↑↓` 导航，`Enter` 选中一个文件，确认：
   - 输入框插入了 `@src/.../App.tsx ` 文本
   - ContextBar 显示了绿色文件引用卡片
6. 右键文件树中的一个文件 → "Agent 输入框"，确认：
   - 切换到 Agent 面板
   - ContextBar 自动显示该文件的引用卡片

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: polish file-tree-to-chat integration"
```
