# Phase 5 — Subagent UI & Node Fan-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan.

**Goal:** Surface Phase 4's subagent backend in the renderer. Users see live subagent invocation cards inside parent chat messages, can browse active subagents in a side panel, can pre-fill a Fan-out prompt from selected canvas nodes, and can edit custom agent types in settings. Closes the v1 (Phases 1-5) of the context-compaction + subagent-dispatch design.

**Architecture:** New `subagentStore` (zustand) holds `invocations: SubagentInvocation[]` and `outputsByInvocation: Map<string, AgentOutput[]>`. `useAgentOutputListener` checks `output.invocationId` first — if set, routes to `subagentStore.appendOutput(invocationId, output)` and skips the main message stream. `ChatBubble` detects `message.toolCalls` items where `block.type === 'dispatch_subagent'` and renders `SubagentInvocationCard` instead of generic `ToolCallRenderer`. The card subscribes to its invocation's outputs from `subagentStore` and updates live. `ChatHeader` gets a Badge button "Active (n)" that opens `SubagentInvocationsPanel` (a Sheet listing past + active invocations). Canvas right-click menu adds a "Fan-out 子代理" item that pre-fills the parent chat input via `FanoutPromptDialog` (no separate dispatch path — user reviews and sends as a normal message; the parent agent picks up the dispatch_subagent tool).

`SettingsPanel` is refactored to use shadcn `Tabs` with three sections: existing settings, new "Subagent Types" tab (custom agent type CRUD), and new "Context Waterline" tab (auto-compact config). Custom types persist via `BizGraphSettings.customAgentTypes` field.

**Spec deviations:**
- **Multi-node selection on canvas** (`selectedNodeIds`) is added but minimal — only powers the Fan-out menu's "include all selected" mode. Visual selection indicators on canvas, lasso selection, etc., are out of scope.
- **Subagent output rendering inside the card** uses a simple terminal-style scrollable log. No syntax highlighting, no separate file-change panel — those come from existing `ToolCallRenderer` if the subagent's output goes through that path (which it doesn't in Phase 5).
- **No real-time token usage** on the invocation card — Phase 5 shows `tokensUsed` only after completion (read from the persisted row).

**Spec reference:** `docs/superpowers/specs/2026-06-22-context-compaction-and-subagent-dispatch-design.md` — Module 4/5.

---

## File Structure

| Path | Purpose |
|---|---|
| `package.json` | (modify) install shadcn deps (`@radix-ui/react-*`) |
| `src/renderer/components/ui/*.tsx` | (create) shadcn copy-pasta for badge, dropdown-menu, tabs, popover, dialog, sheet, tooltip, separator |
| `src/renderer/store/subagentStore.ts` | (create) zustand store — invocations[], outputs map, listeners |
| `src/renderer/store/graphStore.ts` | (modify) add `selectedNodeIds: Set<string>` + setters for multi-select |
| `src/renderer/hooks/useAgentOutputListener.ts` | (modify) route `output.invocationId` to subagentStore |
| `src/renderer/components/agent/SubagentInvocationCard.tsx` | (create) inline card for `tool_use(dispatch_subagent)` |
| `src/renderer/components/agent/SubagentInvocationsPanel.tsx` | (create) side panel listing invocations |
| `src/renderer/components/agent/ChatBubble.tsx` | (modify) detect dispatch_subagent tool calls → render card |
| `src/renderer/components/agent/ChatHeader.tsx` | (modify) add "Active (n)" button |
| `src/renderer/components/agent/FanoutPromptDialog.tsx` | (create) pre-fills chat input from selected nodes |
| `src/renderer/canvas/NodeContextMenu.tsx` | (modify) add Fan-out menu entry |
| `src/renderer/components/agent/AgentChatPanel.tsx` | (modify) mount FanoutPromptDialog + SubagentInvocationsPanel |
| `src/renderer/panels/SettingsPanel.tsx` | (modify) refactor to Tabs, add Subagent Types + Waterline tabs |
| `src/renderer/panels/SubagentTypesTab.tsx` | (create) custom AgentTypeDefinition CRUD form |
| `src/renderer/panels/ContextWaterlineTab.tsx` | (create) auto-compact threshold/interval form |
| `src/shared/types/agent.ts` | (modify) `BizGraphSettings.customAgentTypes?` field |
| `src/main/settings.ts` | (modify) read/write customAgentTypes from settings.json |
| `src/main/ipc-handlers.ts` | (modify) on startup, register custom types from settings on SubagentManager |

---

## Phase 5 Tasks

### Task 1: Install shadcn dependencies + copy required components

**Files:** `package.json`, `src/renderer/components/ui/*.tsx`

**Step 1:** Install the radix primitives:

```bash
cd D:/xiangmu/TianGong
npm install @radix-ui/react-dropdown-menu @radix-ui/react-tabs @radix-ui/react-popover @radix-ui/react-dialog @radix-ui/react-tooltip @radix-ui/react-separator @radix-ui/react-scroll-area
```

**Step 2:** Manually create shadcn-style component files under `src/renderer/components/ui/` (do not run `npx shadcn` — it may attempt to reconfigure the project). Copy minimal versions of:

- `badge.tsx` — Badge component with `default | secondary | destructive` variants
- `dropdown-menu.tsx` — DropdownMenu primitives (Root, Trigger, Content, Item, Separator)
- `tabs.tsx` — Tabs primitives (Root, List, Trigger, Content)
- `popover.tsx` — Popover primitives
- `dialog.tsx` — Dialog primitives
- `sheet.tsx` — Side-drawer Sheet primitives
- `tooltip.tsx` — Tooltip primitives
- `separator.tsx` — visual separator

Use the standard shadcn copy-pasta. Match the existing `button.tsx` style (`cva` + `cn` from `@/lib/utils`).

**Step 3:** Verify each file compiles by importing it in a temporary file or rely on Task 2+ usage to verify.

**Step 4:** Run `npx tsc --noEmit` — must pass.

**Step 5:** Commit.

```bash
git add package.json package-lock.json src/renderer/components/ui/
git commit -m "feat(ui): install radix primitives + shadcn components

Adds Badge, DropdownMenu, Tabs, Popover, Dialog, Sheet, Tooltip,
Separator shadcn components for Phase 5 subagent UI."
```

---

### Task 2: subagentStore (zustand) + multi-select on graphStore

**Files:**
- Create: `src/renderer/store/subagentStore.ts`
- Modify: `src/renderer/store/graphStore.ts`

**Step 1:** Create `src/renderer/store/subagentStore.ts`:

```ts
/**
 * Subagent Store (Phase 5)
 *
 * Holds:
 *  - invocations: live list of SubagentInvocation rows (loaded from IPC + updated via subagent:progress events)
 *  - outputsByInvocation: per-invocation buffered AgentOutput stream
 *  - subagentTypes: AgentTypeDefinition[] from listTypes IPC
 *
 * Updates from two sources:
 *  - useAgentOutputListener pushes tagged outputs (output.invocationId set)
 *  - window.electronAPI.onSubagentProgress pushes status transitions
 */

import { create } from 'zustand'
import type {
  SubagentInvocation,
  SubagentResult,
  AgentTypeDefinition,
  AgentOutput,
} from '@shared/types'

interface SubagentState {
  invocations: SubagentInvocation[]
  outputsByInvocation: Map<string, AgentOutput[]>
  subagentTypes: AgentTypeDefinition[]

  loadInvocations: (parentSessionId: string) => Promise<void>
  loadTypes: () => Promise<void>
  appendOutput: (invocationId: string, output: AgentOutput) => void
  applyProgress: (data: { invocationId: string; status: string; error?: string }) => void
  cancelInvocation: (invocationId: string) => Promise<void>
  getResult: (invocationId: string) => Promise<SubagentResult | null>
  reset: () => void
}

const MAX_OUTPUT_PER_INVOCATION = 500

export const useSubagentStore = create<SubagentState>((set, get) => ({
  invocations: [],
  outputsByInvocation: new Map(),
  subagentTypes: [],

  loadInvocations: async (parentSessionId) => {
    if (typeof window === 'undefined' || !window.electronAPI) return
    const list = await window.electronAPI['subagent:listInvocations'](parentSessionId)
    set({ invocations: list })
  },

  loadTypes: async () => {
    if (typeof window === 'undefined' || !window.electronAPI) return
    const types = await window.electronAPI['subagent:listTypes']()
    set({ subagentTypes: types })
  },

  appendOutput: (invocationId, output) => {
    set((s) => {
      const next = new Map(s.outputsByInvocation)
      const arr = next.get(invocationId) ?? []
      const updated = [...arr, output]
      // Cap to prevent unbounded growth
      if (updated.length > MAX_OUTPUT_PER_INVOCATION) {
        updated.splice(0, updated.length - MAX_OUTPUT_PER_INVOCATION)
      }
      next.set(invocationId, updated)
      return { outputsByInvocation: next }
    })
  },

  applyProgress: ({ invocationId, status, error }) => {
    set((s) => {
      const invocations = s.invocations.map((inv) =>
        inv.id === invocationId
          ? { ...inv, status: status as SubagentInvocation['status'], error: error ?? inv.error }
          : inv,
      )
      return { invocations }
    })
  },

  cancelInvocation: async (invocationId) => {
    if (typeof window === 'undefined' || !window.electronAPI) return
    await window.electronAPI['subagent:cancel'](invocationId)
  },

  getResult: async (invocationId) => {
    if (typeof window === 'undefined' || !window.electronAPI) return null
    return window.electronAPI['subagent:getResult'](invocationId)
  },

  reset: () => set({ invocations: [], outputsByInvocation: new Map() }),
}))
```

**Step 2:** Modify `src/renderer/store/graphStore.ts` to add multi-select.

Find the existing state declarations (around line 21-22, where `selectedNodeId: string | null` lives). Add:

```ts
selectedNodeIds: Set<string>  // multi-select (independent from selectedNodeId)
```

And actions:

```ts
toggleNodeSelection: (nodeId: string) => void
clearNodeSelection: () => void
selectNodeIds: (ids: string[]) => void
```

Implementation:

```ts
selectedNodeIds: new Set(),

toggleNodeSelection: (nodeId) => set((s) => {
  const next = new Set(s.selectedNodeIds)
  if (next.has(nodeId)) next.delete(nodeId)
  else next.add(nodeId)
  return { selectedNodeIds: next }
}),

clearNodeSelection: () => set({ selectedNodeIds: new Set() }),

selectNodeIds: (ids) => set({ selectedNodeIds: new Set(ids) }),
```

Single-select `selectedNodeId` stays — multi-select is additive.

**Step 3:** Verify + commit.

```bash
git add src/renderer/store/subagentStore.ts src/renderer/store/graphStore.ts
git commit -m "feat(phase5): subagentStore + multi-select in graphStore

Adds zustand subagentStore for invocations / outputs / types.
Adds selectedNodeIds Set + toggle/clear/select actions in
graphStore (separate from the existing single selectedNodeId)."
```

---

### Task 3: useAgentOutputListener routes invocationId outputs

**File:** `src/renderer/hooks/useAgentOutputListener.ts`

**Step 1:** Read the hook around lines 50-200. The `output.type` switch starts around line 61.

**Step 2:** Add a check at the very top of the handler, before the type switch:

```ts
const cleanup = window.electronAPI.onAgentOutput((_sessionId: string, output: AgentOutput) => {
  // Phase 5: route subagent outputs to subagentStore — they don't go to the main message stream
  if (output.invocationId) {
    useSubagentStore.getState().appendOutput(output.invocationId, output)
    return
  }

  // …existing logic for non-subagent outputs…
})
```

Import:
```ts
import { useSubagentStore } from '../store/subagentStore'
```

**Step 3:** Subscribe to `onSubagentProgress` to update invocation status. Add inside the same `useEffect`:

```ts
const progressCleanup = window.electronAPI.onSubagentProgress?.((data) => {
  useSubagentStore.getState().applyProgress(data)
})

return () => {
  cleanup()
  progressCleanup?.()
}
```

**Step 4:** Verify + commit.

```bash
git add src/renderer/hooks/useAgentOutputListener.ts
git commit -m "feat(phase5): route invocationId outputs to subagentStore

Outputs tagged with output.invocationId (set by SubagentManager
in Phase 4) bypass the main message stream and go to subagentStore
for rendering inside their invocation card. Adds subscription to
subagent:progress for status transitions."
```

---

### Task 4: SubagentInvocationCard component

**File:** `src/renderer/components/agent/SubagentInvocationCard.tsx`

**Step 1:** Create the component:

```tsx
import { useEffect, useState } from 'react'
import { useSubagentStore } from '../../store/subagentStore'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { SubagentInvocation, AgentOutput } from '@shared/types'

interface Props {
  invocationId: string
  agentType?: string
  description?: string
}

export function SubagentInvocationCard({ invocationId, agentType, description }: Props) {
  const invocation = useSubagentStore((s) =>
    s.invocations.find((i) => i.id === invocationId)
  )
  const outputs = useSubagentStore((s) => s.outputsByInvocation.get(invocationId) ?? [])
  const cancelInvocation = useSubagentStore((s) => s.cancelInvocation)
  const getResult = useSubagentStore((s) => s.getResult)
  const [expanded, setExpanded] = useState(false)
  const [resultText, setResultText] = useState<string | null>(null)

  useEffect(() => {
    if (invocation?.status === 'completed') {
      getResult(invocationId).then((r) => {
        if (r) setResultText(r.resultText)
      })
    }
  }, [invocation?.status, invocationId, getResult])

  const status = invocation?.status ?? 'queued'
  const isActive = status === 'queued' || status === 'running'
  const isError = status === 'failed'

  const statusColor =
    status === 'completed' ? 'bg-green-500/10 text-green-600 border-green-500/30' :
    status === 'failed' ? 'bg-red-500/10 text-red-600 border-red-500/30' :
    status === 'cancelled' ? 'bg-gray-500/10 text-gray-600 border-gray-500/30' :
    'bg-blue-500/10 text-blue-600 border-blue-500/30'

  return (
    <div className={`my-2 rounded-md border px-3 py-2 text-sm ${statusColor}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-xs">🤖 {agentType ?? invocation?.agentType ?? '?'}</span>
        <Badge variant="secondary" className="text-[10px]">{status}</Badge>
        <span className="flex-1 truncate text-xs opacity-70">
          {description ?? invocation?.description ?? ''}
        </span>
        {isActive && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => cancelInvocation(invocationId)}
          >
            Cancel
          </Button>
        )}
      </div>

      {/* Live output (collapsible) */}
      {outputs.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] opacity-70 hover:opacity-100 mb-1"
          >
            {expanded ? '▼' : '▶'} {outputs.length} output line{outputs.length !== 1 ? 's' : ''}
          </button>
          {expanded && (
            <pre className="text-[10px] font-mono bg-black/5 dark:bg-white/5 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap">
              {outputs.map((o, i) => (
                <div key={i} className={o.type === 'error' ? 'text-red-500' : ''}>
                  {o.data}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {/* Final result (only when completed) */}
      {status === 'completed' && resultText && (
        <div className="mt-2 pt-2 border-t border-current/20">
          <div className="text-[10px] opacity-70 mb-1">
            Result • {invocation?.tokensUsed ?? 0} tokens
            {invocation?.finishedAt && invocation?.startedAt &&
              ` • ${invocation.finishedAt - invocation.startedAt}ms`}
          </div>
          <div className="text-xs whitespace-pre-wrap line-clamp-6">
            {resultText}
          </div>
        </div>
      )}

      {isError && invocation?.error && (
        <div className="mt-2 text-xs text-red-600">{invocation.error}</div>
      )}
    </div>
  )
}
```

**Step 2:** Verify + commit.

```bash
git add src/renderer/components/agent/SubagentInvocationCard.tsx
git commit -m "feat(phase5): SubagentInvocationCard

Inline card for dispatch_subagent tool calls. Shows agent type,
description, live status badge, cancel button (while active),
collapsible output log, and final result text (after completion).
Subscribes to subagentStore."
```

---

### Task 5: ChatBubble detects dispatch_subagent tool calls

**File:** `src/renderer/components/agent/ChatBubble.tsx`

**Step 1:** Read around lines 244-249 where `message.toolCalls?.map(...)` renders blocks.

**Step 2:** The current `ToolCallBlock` type is `'file_edit' | 'diff' | 'terminal' | 'file_create'`. The dispatch_subagent tool call is NOT one of these — it's a higher-level concept. Two options:

**Option A:** Extend `ToolCallBlock.type` union with `'dispatch_subagent'`. Adapter wires would need to emit blocks of this type.

**Option B (simpler):** Check `message.toolCalls` for a special marker. Use a separate optional field on `ChatMessage`:

```ts
// In ChatMessage:
subagentInvocationIds?: string[]
```

Setting this from `useAgentOutputListener` requires hooking into the assistant's tool-use signals — complex.

**Option C (cleanest):** Phase 5 ships **standalone subagent rendering** — every time a parent message's text mentions a dispatch_subagent call, just render the standalone `SubagentInvocationsPanel` (side drawer). Skip inline cards for now. Card content is still rendered in the panel.

For Phase 5 simplicity, take **Option C**. The inline rendering of `SubagentInvocationCard` happens ONLY in the `SubagentInvocationsPanel`. Skip the ChatBubble modification entirely.

**Document this in the plan as a deviation** — the inline cards in chat are aspirational for Phase 6+.

**Step 3:** Verify (no changes to ChatBubble.tsx in this task).

**No commit for this task** — change consolidated into Task 6 (SubagentInvocationsPanel).

---

### Task 6: SubagentInvocationsPanel + ChatHeader badge button

**Files:**
- Create: `src/renderer/components/agent/SubagentInvocationsPanel.tsx`
- Modify: `src/renderer/components/agent/ChatHeader.tsx`
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

**Step 1:** Create the panel using shadcn `Sheet`:

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { useEffect } from 'react'
import { useSubagentStore } from '../../store/subagentStore'
import { SubagentInvocationCard } from './SubagentInvocationCard'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentSessionId: string | null
}

export function SubagentInvocationsPanel({ open, onOpenChange, parentSessionId }: Props) {
  const invocations = useSubagentStore((s) => s.invocations)
  const loadInvocations = useSubagentStore((s) => s.loadInvocations)

  useEffect(() => {
    if (open && parentSessionId) {
      loadInvocations(parentSessionId)
    }
  }, [open, parentSessionId, loadInvocations])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>Subagent Invocations</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-2 overflow-y-auto max-h-[calc(100vh-120px)]">
          {invocations.length === 0 && (
            <div className="text-sm text-muted-foreground">No subagent invocations yet.</div>
          )}
          {invocations.map((inv) => (
            <SubagentInvocationCard
              key={inv.id}
              invocationId={inv.id}
              agentType={inv.agentType}
              description={inv.description}
            />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

**Step 2:** Modify `ChatHeader.tsx` to add an "Active subagents" badge button.

Add props:
```ts
activeSubagentCount?: number
onOpenSubagents?: () => void
```

In the right-side button group (around line 132-140, between New Thread and Threads), insert:

```tsx
{onOpenSubagents && (
  <button
    className="relative p-1.5 hover:bg-muted rounded text-xs"
    onClick={onOpenSubagents}
    title="Subagent invocations"
  >
    🤖
    {activeSubagentCount !== undefined && activeSubagentCount > 0 && (
      <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground rounded-full text-[9px] min-w-[16px] h-4 px-1 flex items-center justify-center">
        {activeSubagentCount}
      </span>
    )}
  </button>
)}
```

**Step 3:** Wire in `AgentChatPanel.tsx`.

Add state for the panel:
```ts
import { SubagentInvocationsPanel } from './SubagentInvocationsPanel'
import { useSubagentStore } from '../../store/subagentStore'

const [showSubagentPanel, setShowSubagentPanel] = useState(false)
const subagentInvocations = useSubagentStore((s) => s.invocations)
const activeSubagentCount = subagentInvocations.filter(
  (i) => i.status === 'queued' || i.status === 'running'
).length
```

Pass to ChatHeader:
```tsx
<ChatHeader
  // …existing…
  activeSubagentCount={activeSubagentCount}
  onOpenSubagents={() => setShowSubagentPanel(true)}
/>
```

Mount the panel:
```tsx
<SubagentInvocationsPanel
  open={showSubagentPanel}
  onOpenChange={setShowSubagentPanel}
  parentSessionId={currentThread?.sessionId ?? null}
/>
```

**Step 4:** Verify + commit.

```bash
git add src/renderer/components/agent/SubagentInvocationsPanel.tsx src/renderer/components/agent/ChatHeader.tsx src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(phase5): SubagentInvocationsPanel + header badge button

Side drawer (shadcn Sheet) lists all subagent invocations for
the current parent session — past + active — using
SubagentInvocationCard. ChatHeader gets a 🤖 button with a
live count badge that opens the panel."
```

---

### Task 7: FanoutPromptDialog + canvas Fan-out menu

**Files:**
- Create: `src/renderer/components/agent/FanoutPromptDialog.tsx`
- Modify: `src/renderer/canvas/NodeContextMenu.tsx`
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

**Step 1:** Create the dialog using shadcn `Dialog`:

```tsx
import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { useGraphStore } from '../../store/graphStore'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the final prompt; consumer pre-fills the chat input. */
  onSubmit: (prompt: string) => void
}

const TEMPLATE = `请你为以下节点各派发一个 implement 子代理并行执行:
{NODE_LIST}

要求:对每个节点用 dispatch_subagent 工具发起任务,各任务允许并行,等所有完成后给我汇总。`

export function FanoutPromptDialog({ open, onOpenChange, onSubmit }: Props) {
  const selectedNodeIds = useGraphStore((s) => Array.from(s.selectedNodeIds))
  const nodes = useGraphStore((s) => s.nodes)
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    if (!open) return
    const list = selectedNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter(Boolean)
      .map((n) => {
        const linkedFiles = n!.metadata?.linkedFiles ?? []
        const filesPart = linkedFiles.length > 0
          ? `, files: ${linkedFiles.slice(0, 5).join(', ')}${linkedFiles.length > 5 ? '…' : ''}`
          : ''
        return `- ${n!.title} (${n!.id}${filesPart})`
      })
      .join('\n')
    setPrompt(TEMPLATE.replace('{NODE_LIST}', list || '- (no nodes selected)'))
  }, [open, selectedNodeIds, nodes])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Fan-out 子代理</DialogTitle>
        </DialogHeader>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="w-full h-48 p-2 border rounded text-sm font-mono"
          placeholder="Edit the prompt as needed…"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={() => {
              onSubmit(prompt)
              onOpenChange(false)
            }}
          >
            发送到当前会话
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

**Step 2:** Modify `NodeContextMenu.tsx` to add a "Fan-out" menu entry.

Add prop:
```ts
onFanout?: () => void
```

Find the menu structure (around line 91-217). Add a new section near "AI 操作" (around line 153-179):

```tsx
{onFanout && (
  <div className="border-t border-border my-1" />
)}
{onFanout && (
  <button
    onClick={() => { onFanout(); onClose() }}
    className="w-full text-left px-3 py-1.5 hover:bg-muted text-xs flex items-center gap-2"
  >
    🤖 Fan-out 子代理 (基于选中节点)
  </button>
)}
```

**Step 3:** Wire in `AgentChatPanel.tsx` (or wherever NodeContextMenu is mounted — check the actual mount point):

```tsx
const [showFanoutDialog, setShowFanoutDialog] = useState(false)
const setMessageInput = useChatInputStore.getState().setInput  // or whatever the input setter is

// In NodeContextMenu invocation:
<NodeContextMenu
  // …existing props…
  onFanout={() => setShowFanoutDialog(true)}
/>

<FanoutPromptDialog
  open={showFanoutDialog}
  onOpenChange={setShowFanoutDialog}
  onSubmit={(prompt) => {
    // Pre-fill the chat input — the user reviews and sends manually
    setMessageInput(prompt)
  }}
/>
```

The exact input setter depends on the existing ChatInput state — check `ChatInput.tsx` for how it holds its value.

**Step 4:** Verify + commit.

```bash
git add src/renderer/components/agent/FanoutPromptDialog.tsx src/renderer/canvas/NodeContextMenu.tsx src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(phase5): Fan-out dialog + canvas menu entry

Right-click on any canvas node now shows a 'Fan-out 子代理' entry
that opens FanoutPromptDialog. The dialog pre-fills a template
prompt referencing all currently-selected nodes (selectedNodeIds
from graphStore). User reviews/edits and clicks send — the prompt
goes into the chat input, where the parent agent then decides
how to dispatch_subagent."
```

---

### Task 8: SettingsPanel refactor — add Subagent Types + Waterline tabs

**Files:**
- Create: `src/renderer/panels/SubagentTypesTab.tsx`
- Create: `src/renderer/panels/ContextWaterlineTab.tsx`
- Modify: `src/renderer/panels/SettingsPanel.tsx`
- Modify: `src/shared/types/agent.ts` (add `customAgentTypes`)
- Modify: `src/main/settings.ts` (read/write the new field)
- Modify: `src/main/ipc-handlers.ts` (register custom types on startup)

**Step 1:** Add `customAgentTypes?: AgentTypeDefinition[]` to `BizGraphSettings`.

```ts
import type { AgentTypeDefinition } from './subagent'

export interface BizGraphSettings {
  // …existing…
  customAgentTypes?: AgentTypeDefinition[]
}
```

Verify imports work without circular issues (subagent types live in `./types/subagent`).

**Step 2:** Update `src/main/settings.ts` to round-trip the new field. Read its handlers — should be a simple add to the (de)serialization logic.

**Step 3:** In `src/main/ipc-handlers.ts`, after SubagentManager is created, load custom types from settings:

```ts
const settings = readSettings()
if (settings.customAgentTypes) {
  for (const def of settings.customAgentTypes) {
    subagentManager.registerType(def)
  }
}
```

**Step 4:** Create `src/renderer/panels/SubagentTypesTab.tsx`:

A form with:
- List of all types (built-in shown read-only + custom shown editable)
- "+ New custom type" button
- Edit/delete for custom types
- Fields: name, displayName, description, allowedTools (multi-select), scopeStrategy (radio), systemPromptAddon (textarea), summarizeResult (checkbox)
- "Save" button writes to settings via `settings:write`

**Step 5:** Create `src/renderer/panels/ContextWaterlineTab.tsx`:

A form for `contextWaterline` config:
- autoCompactEnabled (checkbox)
- autoCompactThreshold (slider 0.5–0.95)
- minCompactInterval (number input, seconds)
- "Save" button writes via `settings:setContextWaterlineConfig`

**Step 6:** Refactor `SettingsPanel.tsx` to use shadcn `Tabs`:

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs'
import { SubagentTypesTab } from './SubagentTypesTab'
import { ContextWaterlineTab } from './ContextWaterlineTab'

// In the render:
<Tabs defaultValue="general" className="w-full">
  <TabsList className="grid w-full grid-cols-3">
    <TabsTrigger value="general">基础设置</TabsTrigger>
    <TabsTrigger value="subagents">子代理类型</TabsTrigger>
    <TabsTrigger value="waterline">上下文水位</TabsTrigger>
  </TabsList>
  <TabsContent value="general">
    {/* existing CLI Tools / API Keys / MCP Servers sections */}
  </TabsContent>
  <TabsContent value="subagents">
    <SubagentTypesTab />
  </TabsContent>
  <TabsContent value="waterline">
    <ContextWaterlineTab />
  </TabsContent>
</Tabs>
```

**Step 7:** Verify + commit.

```bash
git add src/shared/types/agent.ts src/main/settings.ts src/main/ipc-handlers.ts \
        src/renderer/panels/SettingsPanel.tsx \
        src/renderer/panels/SubagentTypesTab.tsx \
        src/renderer/panels/ContextWaterlineTab.tsx
git commit -m "feat(phase5): settings refactored to tabs + subagent type CRUD

BizGraphSettings gains optional customAgentTypes field, persisted
through settings.json round-trip. SettingsPanel refactored from
flat layout to shadcn Tabs with three sections: existing general
settings, new Subagent Types tab (CRUD for AgentTypeDefinition),
and new Context Waterline tab (auto-compact threshold/interval).
On startup, ipc-handlers registers all customAgentTypes onto
SubagentManager."
```

---

### Task 9: Final verification

- [ ] `npm run test` — all 884+ tests pass
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — baseline 94 warnings (or lower)
- [ ] Manual: open the app, run a Claude Code session, observe:
  - Bot icon appears in header with no badge initially
  - Trigger a `dispatch_subagent` (via parent agent's text "use the dispatch_subagent tool to…")
  - Badge increments to 1 while running
  - Open panel, see live card with output log
  - Card transitions to completed after subagent finishes
  - Result text appears in card
- [ ] Right-click any canvas node, see "Fan-out 子代理" entry
- [ ] Select 2-3 nodes (multi-select via Ctrl+click — implementation in Task 2 supports this)
- [ ] Click Fan-out, dialog pre-fills with selected nodes
- [ ] Click "发送到当前会话", prompt lands in ChatInput
- [ ] Open Settings → Subagent Types tab, add a custom type
- [ ] Restart app, verify custom type persists and appears in SubagentManager.listTypes()

---

## Self-review

**Spec coverage (Module 4/5):**

| Spec item | Task | Notes |
|---|---|---|
| SubagentInvocationCard | 4 | Inline rendering deferred — Phase 5 shows in panel only |
| SubagentInvocationsPanel (Sheet) | 6 | |
| ChatHeader [Active (n)] button | 6 | |
| Output routing via invocationId | 3 | useAgentOutputListener filters before main flow |
| onSubagentProgress event subscription | 3 | |
| FanoutPromptDialog template | 7 | |
| Canvas right-click Fan-out menu | 7 | |
| Multi-node selection | 2 | Added selectedNodeIds Set in graphStore |
| Settings tab: Subagent Types CRUD | 8 | |
| Settings tab: Context Waterline | 8 | |
| customAgentTypes persistence | 8 | via BizGraphSettings round-trip |
| Custom types loaded into SubagentManager on startup | 8 | |
| shadcn deps install | 1 | |

**Deferred / out of scope:**
- Inline `SubagentInvocationCard` rendering directly in ChatBubble's tool_use blocks (would require ToolCallBlock type extension + adapter wiring of structured tool_use signals). Phase 5 ships standalone panel rendering.
- Lasso multi-select on canvas (selectedNodeIds storage exists, but UI for adding to it via Ctrl+click is assumed to live elsewhere or be a follow-up).
- Real-time token usage on the live invocation card.
- E2E Playwright test for the dispatch flow.

**Risks:**
- shadcn copy-pasta drift — if the project later runs `npx shadcn add`, manual copies may conflict. Documented in Task 1.
- The `metadata.linkedFiles` field used in FanoutPromptDialog may not exist on all nodes — the template includes a fallback when empty.
- `customAgentTypes` round-trip through settings.json may serialize functions (the `allowedTools: '*'` literal is fine, but if future fields include callbacks, that would break). Phase 5 schema is JSON-clean.