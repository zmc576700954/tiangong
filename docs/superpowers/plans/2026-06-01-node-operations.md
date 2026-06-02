# Node Operations: AI Enrichment, Context, Sub-nodes, Dev Prompt

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four missing/exbroken node right-click menu features: AI supplement details (fix), add context (new), AI sub-node generation (new), and generate dev prompt (fix).

**Architecture:** Extend `ContextRef` type to support `'text'` alongside existing `'file'|'node'`. Add `contextRefs` field to `GraphNode` and persist in DB. Wire `enrichNode` through `sendPromptViaAgent` for streaming output. Fill generated dev prompt into ChatInput via a new `pendingPrompt` state in appStore. Implement `mindmap:generateModule` IPC handler that creates child nodes from AI output.

**Tech Stack:** TypeScript, Electron (main/renderer/preload), LibSQL, Zustand, React, Vitest

---

## Task 1: Extend ContextRef and GraphNode types + DB migration

**Files:**
- Modify: `src/shared/types.ts:210-216` (ContextRef interface)
- Modify: `src/shared/types.ts:69-98` (GraphNode interface)
- Modify: `src/main/database.ts:241-263` (nodes table schema)
- Modify: `src/main/repositories/node-repository.ts:13-44` (create)
- Modify: `src/main/repositories/node-repository.ts:46-95` (update)
- Modify: `src/main/repositories/graph-repository.ts:78-94` (get nodes)

- [ ] **Step 1: Extend ContextRef type to support 'text'**

In `src/shared/types.ts`, change the `ContextRef` interface (line 210-216):

```typescript
/** 上下文引用（节点、文件或自由文本） */
export interface ContextRef {
  type: 'node' | 'file' | 'text'
  id: string
  label: string
  /** 文本类型的内容（type='text' 时必填） */
  content?: string
  /** 上下文来源 */
  source?: 'user-attach' | 'right-click' | 'mention' | 'auto-scope'
}
```

- [ ] **Step 2: Add contextRefs field to GraphNode**

In `src/shared/types.ts`, add `contextRefs` to `GraphNode` (after `communityLevel` field, around line 93):

```typescript
  /** 节点关联的上下文（文件/文本/其他节点） */
  contextRefs?: ContextRef[]
```

- [ ] **Step 3: Add context_refs column to database schema**

In `src/main/database.ts`, modify the `nodes` CREATE TABLE (line 241-263). Add `context_refs TEXT,` after the `community_level INTEGER,` line (line 258):

```sql
      community_level INTEGER,
      context_refs TEXT,
      created_at TEXT NOT NULL,
```

- [ ] **Step 4: Update NodeRepository.create to persist contextRefs**

In `src/main/repositories/node-repository.ts`, modify the `create` method. Add `context_refs` to the INSERT SQL and args:

Change the SQL (line 18-22) to:
```typescript
      sql: `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, rules, metadata, owner_role,
        position_x, position_y, context_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```

Add to args array (after `data.position.y`):
```typescript
        data.contextRefs ? JSON.stringify(data.contextRefs) : null,
```

- [ ] **Step 5: Update NodeRepository.update to persist contextRefs**

In `src/main/repositories/node-repository.ts`, add a contextRefs case in the `update` method (after the `data.metadata` check, around line 59):

```typescript
    if (data.contextRefs !== undefined) { updates.push('context_refs = ?'); args.push(JSON.stringify(data.contextRefs)) }
```

Also add to the return object (after `metadata` line 89):
```typescript
      contextRefs: row.context_refs ? JSON.parse(row.context_refs as string) : undefined,
```

- [ ] **Step 6: Update GraphRepository.get to read contextRefs**

In `src/main/repositories/graph-repository.ts`, add to the nodes mapping (after the `metadata` line 89):

```typescript
        contextRefs: row.context_refs ? JSON.parse(rowStr(row, 'context_refs')) : undefined,
```

- [ ] **Step 7: Run type-check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/database.ts src/main/repositories/node-repository.ts src/main/repositories/graph-repository.ts
git commit -m "feat: extend ContextRef with text type, add contextRefs to GraphNode and DB schema"
```

---

## Task 2: Add Context UI — NodeContextMenu + NodeContextPopover

**Files:**
- Create: `src/renderer/canvas/NodeContextPopover.tsx` (new file)
- Modify: `src/renderer/canvas/NodeContextMenu.tsx` (add context button)
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx` (pass handler)
- Modify: `src/renderer/canvas/GraphCanvas.tsx` (add handler)

- [ ] **Step 1: Create NodeContextPopover component**

Create `src/renderer/canvas/NodeContextPopover.tsx`:

```typescript
import { useState, useEffect, useRef } from 'react'
import { X, FileText, Type, Search, Plus } from 'lucide-react'
import type { ContextRef } from '@shared/types'

interface NodeContextPopoverProps {
  x: number
  y: number
  existingContexts: ContextRef[]
  projectPath?: string
  onSave: (contexts: ContextRef[]) => void
  onClose: () => void
}

export function NodeContextPopover({ x, y, existingContexts, projectPath, onSave, onClose }: NodeContextPopoverProps) {
  const [contexts, setContexts] = useState<ContextRef[]>(existingContexts)
  const [mode, setMode] = useState<'file' | 'text'>('file')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ name: string; path: string }[]>([])
  const [textValue, setTextValue] = useState('')
  const [textLabel, setTextLabel] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Click outside to close
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as HTMLElement)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [onClose])

  // File search with debounce
  useEffect(() => {
    if (mode !== 'file' || !searchQuery.trim() || !projectPath) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(async () => {
      setIsSearching(true)
      try {
        const results = await window.electronAPI['fs:searchFiles'](projectPath, searchQuery)
        setSearchResults(results.slice(0, 10))
      } catch {
        setSearchResults([])
      }
      setIsSearching(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, mode, projectPath])

  const addFileContext = (file: { name: string; path: string }) => {
    const id = `ctx-file-${Date.now()}`
    const ref: ContextRef = { type: 'file', id, label: file.name, source: 'user-attach' }
    if (!contexts.some((c) => c.type === 'file' && c.label === file.name)) {
      setContexts([...contexts, ref])
    }
    setSearchQuery('')
    setSearchResults([])
  }

  const addTextContext = () => {
    if (!textValue.trim()) return
    const id = `ctx-text-${Date.now()}`
    const ref: ContextRef = {
      type: 'text',
      id,
      label: textLabel.trim() || textValue.trim().slice(0, 30),
      content: textValue.trim(),
      source: 'user-attach',
    }
    setContexts([...contexts, ref])
    setTextValue('')
    setTextLabel('')
  }

  const removeContext = (id: string) => {
    setContexts(contexts.filter((c) => c.id !== id))
  }

  return (
    <div
      ref={popoverRef}
      className="absolute z-50 bg-background border rounded-lg shadow-xl w-72"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-xs font-medium">添加上下文</span>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-muted">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Mode tabs */}
      <div className="flex border-b">
        <button
          onClick={() => setMode('file')}
          className={`flex-1 px-3 py-1.5 text-[11px] flex items-center justify-center gap-1 transition-colors ${
            mode === 'file' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          <FileText className="w-3 h-3" />
          文件
        </button>
        <button
          onClick={() => setMode('text')}
          className={`flex-1 px-3 py-1.5 text-[11px] flex items-center justify-center gap-1 transition-colors ${
            mode === 'text' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          <Type className="w-3 h-3" />
          文本
        </button>
      </div>

      <div className="p-2 space-y-2">
        {mode === 'file' ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 px-2 py-1 border rounded bg-background">
              <Search className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索项目文件..."
                className="flex-1 text-xs bg-transparent outline-none"
              />
            </div>
            {isSearching && <div className="text-[10px] text-muted-foreground px-2">搜索中...</div>}
            {searchResults.map((file) => (
              <button
                key={file.path}
                onClick={() => addFileContext(file)}
                className="w-full text-left px-2 py-1 text-xs rounded hover:bg-muted flex items-center gap-1.5 transition-colors"
              >
                <FileText className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <span className="truncate">{file.name}</span>
                <span className="text-[9px] text-muted-foreground truncate ml-auto">{file.path}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-1.5">
            <input
              type="text"
              value={textLabel}
              onChange={(e) => setTextLabel(e.target.value)}
              placeholder="标题（可选）"
              className="w-full px-2 py-1 text-xs border rounded bg-background"
            />
            <textarea
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder="输入业务约束、技术要求等..."
              rows={3}
              className="w-full px-2 py-1 text-xs border rounded bg-background resize-none"
            />
            <button
              onClick={addTextContext}
              disabled={!textValue.trim()}
              className="w-full px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
            >
              <Plus className="w-3 h-3" />
              添加文本
            </button>
          </div>
        )}

        {/* Existing contexts list */}
        {contexts.length > 0 && (
          <div className="border-t pt-2 space-y-1">
            <div className="text-[10px] text-muted-foreground px-1">已添加 ({contexts.length})</div>
            {contexts.map((ctx) => (
              <div key={ctx.id} className="flex items-center gap-1.5 px-2 py-1 text-xs bg-muted/50 rounded group">
                {ctx.type === 'file' ? (
                  <FileText className="w-3 h-3 text-blue-500 flex-shrink-0" />
                ) : ctx.type === 'text' ? (
                  <Type className="w-3 h-3 text-amber-500 flex-shrink-0" />
                ) : (
                  <FileText className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                )}
                <span className="truncate flex-1">{ctx.label}</span>
                <button
                  onClick={() => removeContext(ctx.id)}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-destructive transition-opacity"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save button */}
      <div className="border-t px-2 py-1.5 flex justify-end gap-1.5">
        <button
          onClick={onClose}
          className="px-2.5 py-1 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          取消
        </button>
        <button
          onClick={() => { onSave(contexts); onClose() }}
          className="px-2.5 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          保存
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add context button to NodeContextMenu**

In `src/renderer/canvas/NodeContextMenu.tsx`, add import for `Paperclip` icon (add to existing lucide import):

```typescript
import { Pencil, Trash2, Plus, Link, Sparkles, Play, Paperclip } from 'lucide-react'
```

Add new prop to `NodeContextMenuProps`:
```typescript
  onAddContext?: (nodeId: string) => void
```

Add `onAddContext` to destructured props in the component function signature.

Add the context button right before the AI 操作 section (before line 119 `/* AI 操作 */`):

```typescript
      {/* 添加上下文 */}
      {onAddContext && (
        <div className="px-2 pb-1">
          <button
            onClick={() => { onAddContext(nodeId); onClose() }}
            className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground"
          >
            <Paperclip className="w-3 h-3" />
            添加上下文
          </button>
        </div>
      )}
```

- [ ] **Step 3: Update CanvasOverlay to pass onAddContext**

In `src/renderer/canvas/components/CanvasOverlay.tsx`:

Add `onAddContext` to the `CanvasOverlayProps` interface (after `onStartConnect`):
```typescript
  onAddContext?: (nodeId: string) => void
```

Add to destructured props in the component.

Add to `NodeContextMenu` render (after `onStartConnect`):
```typescript
        onAddContext={onAddContext}
```

- [ ] **Step 4: Wire up context handler in GraphCanvas**

In `src/renderer/canvas/GraphCanvas.tsx`, add state for the context popover (after the `nodeContextMenu` state, around line 140):

```typescript
  const [contextPopover, setContextPopover] = useState<{ nodeId: string; x: number; y: number } | null>(null)
```

Add the handler (after `handleStartConnect`, around line 481):

```typescript
  /** 打开上下文编辑弹窗 */
  const handleAddContext = useCallback((nodeId: string) => {
    // Position popover near the center of the viewport
    setContextPopover({ nodeId, x: Math.round(window.innerWidth / 2 - 144), y: Math.round(window.innerHeight / 3) })
    setNodeContextMenu(null)
  }, [])

  /** 保存节点上下文 */
  const handleSaveContext = useCallback(async (nodeId: string, contexts: import('@shared/types').ContextRef[]) => {
    try {
      await updateNode(nodeId, { contextRefs: contexts })
    } catch (err) {
      console.error('[GraphCanvas] Failed to save context:', err)
    }
    setContextPopover(null)
  }, [updateNode])
```

Pass `onAddContext={handleAddContext}` to `CanvasOverlay`.

Add `NodeContextPopover` rendering after the `CanvasOverlay` component (before the closing `</div>`):

```typescript
      {contextPopover && (
        <NodeContextPopover
          x={contextPopover.x}
          y={contextPopover.y}
          existingContexts={graphNodes.find((n) => n.id === contextPopover.nodeId)?.contextRefs ?? []}
          projectPath={projectPath}
          onSave={(contexts) => handleSaveContext(contextPopover.nodeId, contexts)}
          onClose={() => setContextPopover(null)}
        />
      )}
```

Import `NodeContextPopover` at the top of the file.

- [ ] **Step 5: Add context display in RightPanel NodeEditor**

In `src/renderer/panels/RightPanel.tsx`, add a `ContextDisplay` component inside `NodeEditor` (after the description `EditableTextArea`, around line 201):

```typescript
      {/* Context refs display */}
      {node.contextRefs && node.contextRefs.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">关联上下文</label>
          <div className="flex flex-wrap gap-1">
            {node.contextRefs.map((ctx) => (
              <span
                key={ctx.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] bg-muted rounded-full"
              >
                {ctx.type === 'file' ? (
                  <FileText className="w-2.5 h-2.5 text-blue-500" />
                ) : ctx.type === 'text' ? (
                  <Type className="w-2.5 h-2.5 text-amber-500" />
                ) : null}
                <span className="max-w-[120px] truncate">{ctx.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
```

Add imports at the top of `RightPanel.tsx`:
```typescript
import { FileText, Type } from 'lucide-react'
```
(merge with existing lucide import)

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: No type errors

```bash
git add src/renderer/canvas/NodeContextPopover.tsx src/renderer/canvas/NodeContextMenu.tsx src/renderer/canvas/components/CanvasOverlay.tsx src/renderer/canvas/GraphCanvas.tsx src/renderer/panels/RightPanel.tsx
git commit -m "feat: add node context UI (file + text) with right-click menu and popover"
```

---

## Task 3: Fix AI Enrichment — stream via AgentChat

**Files:**
- Modify: `src/main/ipc/mindmap.ts:53-65` (enrichNode handler)
- Modify: `src/renderer/canvas/GraphCanvas.tsx:495-515` (handleEnrichNode)

- [ ] **Step 1: Fix enrichNode IPC to use sendPromptViaAgent**

In `src/main/ipc/mindmap.ts`, the `enrichNode` handler currently calls `agent.enrichNode()` which uses `runClaude()` directly (no streaming). Change it to use `sendPromptViaAgent` for streaming output.

Replace the handler body (lines 53-65) with:

```typescript
  typedHandle('mindmap:enrichNode', async (
    _,
    projectPath: string,
    _nodeId: string,
    nodeType: NodeType,
    nodeTitle: string,
    relatedFiles?: string[],
    contextRefs?: import('@shared/types').ContextRef[],
  ) => {
    // Build context string from contextRefs
    let contextBlock = ''
    if (contextRefs && contextRefs.length > 0) {
      const textContexts = contextRefs.filter((c) => c.type === 'text' && c.content)
      const fileContexts = contextRefs.filter((c) => c.type === 'file')
      if (textContexts.length > 0) {
        contextBlock += '\n\n用户提供的额外上下文：\n' + textContexts.map((c) => `- ${c.label}: ${c.content}`).join('\n')
      }
      if (fileContexts.length > 0) {
        contextBlock += '\n\n关联文件：\n' + fileContexts.map((c) => `- ${c.label}`).join('\n')
      }
    }

    const agent = new MindMapAgent(projectPath)
    const retrieved = await (agent as any)['directRetrieve']?.(projectPath, nodeTitle, nodeType, relatedFiles || []) ?? { nodeContent: '' }
    const prompt = buildEnrichmentPrompt(nodeTitle, nodeType, retrieved.nodeContent || '') + contextBlock

    // Stream through AgentChat
    const result = await sendPromptViaAgent(agentManager, projectPath, prompt, {
      nodeTitle: `补充详情: ${nodeTitle}`,
      timeoutMs: 120_000,
    })

    const { extractJson } = await import('../mindmap-agent/claude-runner')
    const { validateEnrichment } = await import('../mindmap-agent/schema-validator')
    return validateEnrichment(extractJson(result))
  })
```

Also add the import for `directRetrieve` and `buildEnrichmentPrompt` (or restructure to access them). The cleanest approach: import `directRetrieve` from `../mindmap-agent/retrieval/direct` at the top of the file:

```typescript
import { directRetrieve } from '../mindmap-agent/retrieval/direct'
```

And change the handler body to:

```typescript
  typedHandle('mindmap:enrichNode', async (
    _,
    projectPath: string,
    _nodeId: string,
    nodeType: NodeType,
    nodeTitle: string,
    relatedFiles?: string[],
    contextRefs?: import('@shared/types').ContextRef[],
  ) => {
    let contextBlock = ''
    if (contextRefs && contextRefs.length > 0) {
      const textContexts = contextRefs.filter((c) => c.type === 'text' && c.content)
      const fileContexts = contextRefs.filter((c) => c.type === 'file')
      if (textContexts.length > 0) {
        contextBlock += '\n\n用户提供的额外上下文：\n' + textContexts.map((c) => `- ${c.label}: ${c.content}`).join('\n')
      }
      if (fileContexts.length > 0) {
        contextBlock += '\n\n关联文件：\n' + fileContexts.map((c) => `- ${c.label}`).join('\n')
      }
    }

    const retrieved = await directRetrieve(projectPath, nodeTitle, nodeType, relatedFiles || [])
    const prompt = buildEnrichmentPrompt(nodeTitle, nodeType, retrieved.nodeContent || '') + contextBlock

    const result = await sendPromptViaAgent(agentManager, projectPath, prompt, {
      nodeTitle: `补充详情: ${nodeTitle}`,
      timeoutMs: 120_000,
    })

    const { extractJson } = await import('../mindmap-agent/claude-runner')
    const { validateEnrichment } = await import('../mindmap-agent/schema-validator')
    return validateEnrichment(extractJson(result))
  })
```

Also add the needed imports at the top of `mindmap.ts`:
```typescript
import { directRetrieve } from '../mindmap-agent/retrieval/direct'
import { buildEnrichmentPrompt } from '../mindmap-agent'  // or inline the prompt builder
```

Note: `buildEnrichmentPrompt` is a private function in `mindmap-agent/index.ts`. The cleanest fix is to either export it or inline the prompt in the handler. Since it's a simple template, inline it:

```typescript
function buildEnrichmentPromptLocal(nodeTitle: string, nodeType: NodeType, nodeContent: string): string {
  const labels: Record<string, string> = { module: '业务模块', process: '业务流程', feature: '功能点', bug: 'BUG点' }
  return `请为以下${labels[nodeType] || '节点'}补充详细内容。

节点：${nodeTitle}（${labels[nodeType] || nodeType}）
内容：
${nodeContent}

输出 JSON：
\`\`\`json
{"description":"详细业务描述","acceptanceCriteria":["验收标准"],"businessRules":[{"id":"r1","title":"规则","description":"描述","condition":"条件","action":"动作"}],"relatedFiles":["src/..."],"implementationHints":["要点"],"codeSignatures":["fn()"]}
\`\`\``
}
```

- [ ] **Step 2: Update handleEnrichNode in GraphCanvas to pass contextRefs**

In `src/renderer/canvas/GraphCanvas.tsx`, modify `handleEnrichNode` (line 495-515) to pass `contextRefs`:

```typescript
  const handleEnrichNode = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    setNodeContextMenu(null)
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
      console.error('[GraphCanvas] enrichNode failed:', err)
    }
  }, [graphNodes, projectPath, updateNode])
```

- [ ] **Step 3: Update IpcApi signature for enrichNode**

In `src/shared/types.ts`, update the `mindmap:enrichNode` signature to accept optional `contextRefs`:

```typescript
  'mindmap:enrichNode': (projectPath: string, nodeId: string, nodeType: NodeType, nodeTitle: string, relatedFiles?: string[], contextRefs?: ContextRef[]) => Promise<NodeEnrichment>
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/mindmap.ts src/renderer/canvas/GraphCanvas.tsx src/shared/types.ts
git commit -m "feat: stream enrichNode through AgentChat, pass contextRefs to enrichment prompt"
```

---

## Task 4: Fix Generate Dev Prompt — fill into ChatInput

**Files:**
- Modify: `src/renderer/store/appStore.ts` (add pendingPrompt state)
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx` (consume pendingPrompt)
- Modify: `src/renderer/components/agent/ChatInput.tsx` (accept initialPrompt)
- Modify: `src/renderer/canvas/GraphCanvas.tsx` (use store instead of CustomEvent)
- Modify: `src/main/ipc/mindmap.ts:86-107` (buildDevPrompt — pass contextRefs)

- [ ] **Step 1: Add pendingPrompt to appStore**

In `src/renderer/store/appStore.ts`, add `pendingPrompt` state:

```typescript
interface AppState {
  activeRightPanel: 'node' | 'agent'
  agentWorkingDirectory: string | null
  pendingContextRef: ContextRef | null
  pendingPrompt: string | null
  setActiveRightPanel: (tab: 'node' | 'agent') => void
  setAgentWorkingDirectory: (dir: string | null) => void
  setPendingContextRef: (ref: ContextRef | null) => void
  setPendingPrompt: (prompt: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeRightPanel: 'node',
  agentWorkingDirectory: null,
  pendingContextRef: null,
  pendingPrompt: null,
  setActiveRightPanel: (tab) => set({ activeRightPanel: tab }),
  setAgentWorkingDirectory: (dir) => set({ agentWorkingDirectory: dir }),
  setPendingContextRef: (ref) => set({ pendingContextRef: ref }),
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
}))
```

- [ ] **Step 2: Consume pendingPrompt in AgentChatPanel**

In `src/renderer/components/agent/AgentChatPanel.tsx`, add after the `pendingContextRef` effect (around line 238):

```typescript
  // Consume pendingPrompt from mindmap dev prompt generation
  const pendingPrompt = useAppStore((s) => s.pendingPrompt)
  const setPendingPrompt = useAppStore((s) => s.setPendingPrompt)

  useEffect(() => {
    if (!pendingPrompt) return
    // Pass to ChatInput via a local state ref
    pendingPromptRef.current = pendingPrompt
    setPendingPrompt(null)
    // Auto-switch to agent tab
    if (!currentThreadId) {
      createThread(selectedNode?.title || '新会话', selectedAdapter || 'claude-code')
    }
  }, [pendingPrompt, setPendingPrompt, currentThreadId, selectedAdapter, createThread, selectedNode])
```

Add a ref for the prompt:
```typescript
  const pendingPromptRef = useRef<string | null>(null)
```

Pass `initialPrompt` to `ChatInput`:
```typescript
  <ChatInput
    ...
    initialPrompt={pendingPromptRef.current}
    onPromptConsumed={() => { pendingPromptRef.current = null }}
  />
```

- [ ] **Step 3: Accept initialPrompt in ChatInput**

In `src/renderer/components/agent/ChatInput.tsx`, add props and useEffect:

Add to `ChatInputProps`:
```typescript
  initialPrompt?: string | null
  onPromptConsumed?: () => void
```

Add to destructured props. Add a useEffect after the existing state declarations:

```typescript
  // Consume initialPrompt (e.g., from mindmap dev prompt generation)
  useEffect(() => {
    if (initialPrompt) {
      setValue(initialPrompt)
      onPromptConsumed?.()
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [initialPrompt, onPromptConsumed])
```

- [ ] **Step 4: Fix handleStartDev to use appStore instead of CustomEvent**

In `src/renderer/canvas/GraphCanvas.tsx`, replace the `handleStartDev` callback (lines 518-535):

```typescript
  const handleStartDev = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    setNodeContextMenu(null)
    try {
      const prompt = await window.electronAPI['mindmap:buildDevPrompt'](
        nodeId, node.title, node.type, 'feature', graphId ?? '',
      )
      if (prompt) {
        // Fill prompt into AgentChat input via appStore
        useAppStore.getState().setPendingPrompt(prompt)
        useAppStore.getState().setActiveRightPanel('agent')
      }
    } catch (err) {
      console.error('[GraphCanvas] startDev failed:', err)
    }
  }, [graphNodes, projectPath, graphId])
```

Add import at top of GraphCanvas:
```typescript
import { useAppStore } from '../store/appStore'
```

- [ ] **Step 5: Update buildDevPrompt to include contextRefs**

In `src/main/ipc/mindmap.ts`, update the `mindmap:buildDevPrompt` handler to accept and include `contextRefs`:

```typescript
  typedHandle('mindmap:buildDevPrompt', async (
    _,
    nodeId: string,
    nodeTitle: string,
    nodeType: NodeType,
    taskType: 'feature' | 'bugfix' | 'refactor',
    graphId: string,
    contextRefs?: import('@shared/types').ContextRef[],
  ) => {
    const placeholderNode: GraphNode = {
      id: nodeId,
      type: nodeType,
      status: 'confirmed',
      title: nodeTitle,
      graphId,
      graphType: 'dev',
      position: { x: 0, y: 0 },
      contextRefs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return buildDevPrompt({ node: placeholderNode, taskType, allNodes: [], allEdges: [] })
  })
```

Update the IpcApi type in `src/shared/types.ts`:
```typescript
  'mindmap:buildDevPrompt': (nodeId: string, nodeTitle: string, nodeType: NodeType, taskType: 'feature' | 'bugfix' | 'refactor', graphId: string, contextRefs?: ContextRef[]) => Promise<string>
```

Update the frontend call in `GraphCanvas.handleStartDev` to pass `node.contextRefs`:
```typescript
      const prompt = await window.electronAPI['mindmap:buildDevPrompt'](
        nodeId, node.title, node.type, 'feature', graphId ?? '', node.contextRefs,
      )
```

- [ ] **Step 6: Verify buildDevPrompt uses contextRefs**

Check `src/main/mindmap-agent/synthesis/prompt-builder.ts` to verify it reads `node.contextRefs`. If it doesn't, append context block to the generated prompt in the handler before returning.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 8: Commit**

```bash
git add src/renderer/store/appStore.ts src/renderer/components/agent/AgentChatPanel.tsx src/renderer/components/agent/ChatInput.tsx src/renderer/canvas/GraphCanvas.tsx src/main/ipc/mindmap.ts src/shared/types.ts
git commit -m "feat: fill generated dev prompt into ChatInput via appStore, pass contextRefs"
```

---

## Task 5: Implement AI Sub-node Generation

**Files:**
- Modify: `src/main/ipc/mindmap.ts` (add mindmap:generateModule handler)
- Modify: `src/preload/index.ts` (already exposed, verify)
- Modify: `src/shared/types.ts` (update IpcApi signature)
- Modify: `src/renderer/canvas/NodeContextMenu.tsx` (add AI generate button)
- Modify: `src/renderer/canvas/GraphCanvas.tsx` (add handleGenerateChildren)
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx` (pass handler)

- [ ] **Step 1: Add mindmap:generateModule IPC handler**

In `src/main/ipc/mindmap.ts`, add the handler after the `buildDevPrompt` handler:

```typescript
  typedHandle('mindmap:generateModule', async (
    _,
    projectPath: string,
    parentNodeId: string,
    parentNodeTitle: string,
    parentNodeType: NodeType,
  ) => {
    // Build a prompt to generate child nodes for the given parent
    const labels: Record<string, string> = { module: '业务模块', process: '业务流程', feature: '功能点' }
    const childType = parentNodeType === 'module' ? 'process' : 'feature'

    const prompt = `请为以下${labels[parentNodeType]}生成子${labels[childType]}列表。

父节点：${parentNodeTitle}（${labels[parentNodeType]}）

要求：
1. 每个子节点要有明确的业务含义
2. 使用业务语言命名，不使用技术术语
3. 每个子节点包含简短描述

输出 JSON：
\`\`\`json
{"children":[{"title":"子节点名称","description":"简短业务描述"}]}
\`\`\`

只输出 JSON，不要其他内容。`

    const result = await sendPromptViaAgent(agentManager, projectPath, prompt, {
      nodeTitle: `AI 生成子节点: ${parentNodeTitle}`,
      timeoutMs: 60_000,
    })

    // Parse result
    const { extractJson } = await import('../mindmap-agent/claude-runner')
    const parsed = extractJson(result)
    if (!parsed || !Array.isArray(parsed.children)) {
      throw new Error('AI 返回格式错误')
    }

    return {
      childType,
      children: parsed.children as Array<{ title: string; description?: string }>,
    }
  })
```

- [ ] **Step 2: Update IpcApi type**

In `src/shared/types.ts`, update the `mindmap:generateModule` signature:

```typescript
  'mindmap:generateModule': (projectPath: string, parentNodeId: string, parentNodeTitle: string, parentNodeType: NodeType) => Promise<{ childType: NodeType; children: Array<{ title: string; description?: string }> }>
```

- [ ] **Step 3: Add AI generate button to NodeContextMenu**

In `src/renderer/canvas/NodeContextMenu.tsx`, add import for `Wand2` icon:
```typescript
import { Pencil, Trash2, Plus, Link, Sparkles, Play, Paperclip, Wand2 } from 'lucide-react'
```

Add new prop:
```typescript
  onGenerateChildren?: (nodeId: string) => void
```

Add `onGenerateChildren` to destructured props.

Add button inside the "添加子节点" section (after the manual child buttons, before the closing `</>`):

```typescript
            {onGenerateChildren && (node.type === 'module' || node.type === 'process') && (
              <button
                onClick={() => { onGenerateChildren(nodeId); onClose() }}
                className="px-2 py-1 text-[10px] rounded border border-dashed border-primary/40 text-primary hover:bg-primary/10 transition-colors flex items-center gap-1"
              >
                <Wand2 className="w-2.5 h-2.5" />
                AI 生成
              </button>
            )}
```

- [ ] **Step 4: Wire up handler in GraphCanvas**

In `src/renderer/canvas/GraphCanvas.tsx`, add the handler (after `handleSaveContext`):

```typescript
  /** AI 生成子节点 */
  const handleGenerateChildren = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    setNodeContextMenu(null)
    try {
      const result = await window.electronAPI['mindmap:generateModule'](
        projectPath, nodeId, node.title, node.type,
      )
      if (result && result.children.length > 0) {
        // Batch create child nodes
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
      console.error('[GraphCanvas] generateChildren failed:', err)
    }
  }, [graphNodes, projectPath, createNode, graphId])
```

Pass `onGenerateChildren={handleGenerateChildren}` to `CanvasOverlay`.

- [ ] **Step 5: Update CanvasOverlay props**

In `src/renderer/canvas/components/CanvasOverlay.tsx`:

Add to `CanvasOverlayProps`:
```typescript
  onGenerateChildren?: (nodeId: string) => void
```

Add to destructured props. Pass to `NodeContextMenu`:
```typescript
        onGenerateChildren={onGenerateChildren}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/mindmap.ts src/shared/types.ts src/renderer/canvas/NodeContextMenu.tsx src/renderer/canvas/GraphCanvas.tsx src/renderer/canvas/components/CanvasOverlay.tsx
git commit -m "feat: AI sub-node generation via right-click menu"
```

---

## Task 6: Wire contextRefs into buildDevPrompt via extraContext

**Files:**
- Modify: `src/main/ipc/mindmap.ts:86-107` (pass extraContext from contextRefs)

The `buildDevPrompt` function in `src/main/mindmap-agent/synthesis/prompt-builder.ts` already accepts `options.extraContext` which is injected into the prompt template. No changes to prompt-builder.ts needed — only the IPC handler needs to convert `contextRefs` into an `extraContext` string.

- [ ] **Step 1: Update mindmap:buildDevPrompt handler to build extraContext**

In `src/main/ipc/mindmap.ts`, update the `mindmap:buildDevPrompt` handler to convert `contextRefs` into `extraContext`:

```typescript
  typedHandle('mindmap:buildDevPrompt', async (
    _,
    nodeId: string,
    nodeTitle: string,
    nodeType: NodeType,
    taskType: 'feature' | 'bugfix' | 'refactor',
    graphId: string,
    contextRefs?: import('@shared/types').ContextRef[],
  ) => {
    // Build extraContext string from contextRefs
    let extraContext = ''
    if (contextRefs && contextRefs.length > 0) {
      const parts: string[] = []
      for (const ctx of contextRefs) {
        if (ctx.type === 'text' && ctx.content) {
          parts.push(`[${ctx.label}] ${ctx.content}`)
        } else if (ctx.type === 'file') {
          parts.push(`关联文件: ${ctx.label}`)
        }
      }
      if (parts.length > 0) {
        extraContext = '用户提供的额外上下文：\n' + parts.join('\n')
      }
    }

    const placeholderNode: GraphNode = {
      id: nodeId,
      type: nodeType,
      status: 'confirmed',
      title: nodeTitle,
      graphId,
      graphType: 'dev',
      position: { x: 0, y: 0 },
      contextRefs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return buildDevPrompt({ node: placeholderNode, taskType, allNodes: [], allEdges: [], extraContext: extraContext || undefined })
  })
```

- [ ] **Step 2: Verify prompt output**

Manually test by adding text context to a node and generating a dev prompt. Verify the extra context section appears in the generated prompt.

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/mindmap.ts
git commit -m "feat: pass node contextRefs as extraContext in buildDevPrompt"
```

---

## Task 7: Integration test — manual verification

- [ ] **Step 1: Run dev server**

Run: `npm run dev`
Expected: App starts without errors

- [ ] **Step 2: Test Add Context**

1. Right-click a node → click "添加上下文"
2. In the popover, switch to "文本" tab, enter a label and content, click "添加文本"
3. Click "保存"
4. Verify the context tag appears in the RightPanel node editor
5. Reload the page and verify contexts persist

- [ ] **Step 3: Test AI Enrichment**

1. Right-click a node → click "AI 补充详情"
2. Verify AgentChat shows the enrichment prompt streaming
3. Verify node description/rules are updated after completion

- [ ] **Step 4: Test Generate Dev Prompt**

1. Add some context to a node first
2. Right-click the node → click "生成开发 Prompt"
3. Verify the prompt appears in the ChatInput textarea (not sent automatically)
4. Verify the prompt includes context references

- [ ] **Step 5: Test AI Sub-node Generation**

1. Right-click a module or process node → click "AI 生成"
2. Verify child nodes appear on the canvas after generation
3. Verify child nodes are connected to parent via parentId

- [ ] **Step 6: Run tests**

Run: `npm run test`
Expected: All tests pass (or no regressions)

- [ ] **Step 7: Run type-check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 8: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration test fixes for node operations"
```
