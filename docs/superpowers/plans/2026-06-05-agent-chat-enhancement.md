# AgentChat Enhancement & Mind Map Closed-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance AgentChat rendering (Markdown, ToolCall streaming), establish bidirectional Agent-MindMap status sync, add Diff review workflow, and close the acceptance verification loop.

**Architecture:** Four-phase bottom-up approach. Phase 1 enhances Chat rendering (Markdown + ToolCall parsing). Phase 2 adds node-Agent status synchronization and activity indicators. Phase 3 builds the Diff review panel with Accept/Reject workflow. Phase 4 closes the loop with acceptance criteria verification and auto-retry.

**Tech Stack:** React, Zustand, react-markdown, remark-gfm, react-syntax-highlighter, Electron IPC, LibSQL

**Spec:** `docs/superpowers/specs/2026-06-05-agent-chat-enhancement-design.md`

---

## Phase 1: Chat Rendering Enhancement

### Task 1: Install Markdown Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install react-markdown and related packages**

```bash
npm install react-markdown remark-gfm react-syntax-highlighter
npm install -D @types/react-syntax-highlighter
```

- [ ] **Step 2: Verify installation**

```bash
npm ls react-markdown remark-gfm react-syntax-highlighter
```

Expected: All three packages listed without errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add react-markdown, remark-gfm, react-syntax-highlighter for AgentChat markdown rendering"
```

---

### Task 2: Extend AgentThread Status Type

**Files:**
- Modify: `src/shared/types.ts:303`
- Modify: `src/renderer/store/agentStore.ts` (updateStatus type annotation)

- [ ] **Step 1: Add 'reviewed' status to AgentThread**

In `src/shared/types.ts`, change line 303:
```ts
// Before:
status: 'idle' | 'running' | 'error'
// After:
status: 'idle' | 'running' | 'error' | 'reviewed'
```

- [ ] **Step 2: Update agentStore updateStatus signature**

In `src/renderer/store/agentStore.ts`, update the `updateThreadStatus` type in the interface (around line 26):
```ts
// Before:
updateThreadStatus: (threadId: string, status: 'idle' | 'running' | 'error') => void
// After:
updateThreadStatus: (threadId: string, status: 'idle' | 'running' | 'error' | 'reviewed') => void
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/renderer/store/agentStore.ts
git commit -m "types: add 'reviewed' status to AgentThread for Diff review workflow"
```

---

### Task 3: Add appendToolCall Action to agentStore

**Files:**
- Modify: `src/renderer/store/agentStore.ts`

- [ ] **Step 1: Add appendToolCall to the interface**

In `src/renderer/store/agentStore.ts`, add after the `appendOutput` declaration (around line 18):
```ts
appendToolCall: (threadId: string, messageId: string, toolCall: import('@shared/types').ToolCallBlock) => void
```

- [ ] **Step 2: Implement appendToolCall in the store**

Add the implementation inside `create<AgentState>((set, get) => ({...}))`, after the `appendOutput` implementation:
```ts
appendToolCall: (threadId, messageId, toolCall) => {
  set((state) => ({
    threads: state.threads.map((t) =>
      t.id === threadId
        ? {
            ...t,
            messages: t.messages.map((m) =>
              m.id === messageId
                ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
                : m,
            ),
          }
        : t,
    ),
  }))
},
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/agentStore.ts
git commit -m "feat(agentStore): add appendToolCall action for streaming ToolCall construction"
```

---

### Task 4: Parse file_change Outputs into ToolCallBlocks in AgentChatPanel

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx:151-188`

- [ ] **Step 1: Update the file_change handler to construct ToolCallBlocks**

In `src/renderer/components/agent/AgentChatPanel.tsx`, find the block handling `output.type === 'file_change'` (inside the `onAgentOutput` callback, around line 151). Replace the existing `file_change` handling:

```ts
// Before (lines 151-188 combined file_change with stdout):
if (output.type === 'stdout' || output.type === 'file_change') {
  const text = output.data.trim()
  if (!text) return
  // ... plain text concatenation
}

// After — split file_change from stdout:
if (output.type === 'file_change') {
  const filePath = output.filePath
  if (!filePath) return

  // Ensure streaming message exists
  if (!streamingMsgIdRef.current) {
    const msgId = `output-${output.timestamp}`
    streamingMsgIdRef.current = msgId
    store.appendChatMessage(tid, {
      id: msgId,
      role: 'agent',
      content: '',
      timestamp: output.timestamp,
      adapterName,
      status: 'streaming',
      toolCalls: [],
    })
  }

  // Construct ToolCallBlock
  const toolCall: import('@shared/types').ToolCallBlock = {
    type: output.changeType === 'add' ? 'file_create' : 'file_edit',
    filePath,
    content: output.data,
    status: 'done',
  }

  store.appendToolCall(tid, streamingMsgIdRef.current!, toolCall)
  store.updateThreadStatus(tid, 'running')
  return
}

if (output.type === 'stdout') {
  const text = output.data.trim()
  if (!text) return

  if (!streamingMsgIdRef.current) {
    const msgId = `output-${output.timestamp}`
    streamingMsgIdRef.current = msgId
    store.appendChatMessage(tid, {
      id: msgId,
      role: 'agent',
      content: text,
      timestamp: output.timestamp,
      adapterName,
      status: 'streaming',
    })
  } else {
    const thread = useAgentStore.getState().threads.find((t) => t.id === tid)
    const existingMsg = thread?.messages.find((m) => m.id === streamingMsgIdRef.current)
    if (existingMsg) {
      useAgentStore.setState({
        threads: useAgentStore.getState().threads.map((t) =>
          t.id === tid
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === streamingMsgIdRef.current
                    ? { ...m, content: m.content + '\n' + text }
                    : m,
                ),
              }
            : t,
        ),
      })
    }
  }
  store.updateThreadStatus(tid, 'running')
  return
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(AgentChatPanel): parse file_change outputs into ToolCallBlocks instead of plain text"
```

---

### Task 5: Add Markdown Rendering to ChatBubble

**Files:**
- Modify: `src/renderer/components/agent/ChatBubble.tsx`

- [ ] **Step 1: Add imports**

At the top of `src/renderer/components/agent/ChatBubble.tsx`, add:
```ts
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useState as useStateCopy } from 'react' // already imported
```

- [ ] **Step 2: Replace plain text rendering with ReactMarkdown for Agent messages**

Find the message content rendering block (around line 98-99):
```tsx
// Before:
{message.content ? (
  <div className="whitespace-pre-wrap break-words">{message.content}</div>
) : null}
```

Replace with:
```tsx
{message.content ? (
  isUser ? (
    <div className="whitespace-pre-wrap break-words">{message.content}</div>
  ) : (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words
      prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1
      prose-ul:my-1 prose-ol:my-1 prose-li:my-0
      prose-pre:my-2 prose-pre:p-0 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const codeStr = String(children).replace(/\n$/, '')
            const isBlock = codeStr.includes('\n') || !!match
            if (isBlock) {
              return (
                <div className="relative group">
                  <SyntaxHighlighter
                    style={oneDark}
                    language={match?.[1] ?? 'text'}
                    PreTag="div"
                    customStyle={{ margin: 0, borderRadius: '0.375rem', fontSize: '11px' }}
                  >
                    {codeStr}
                  </SyntaxHighlighter>
                  <button
                    onClick={() => navigator.clipboard?.writeText(codeStr)}
                    className="absolute top-1 right-1 px-1.5 py-0.5 text-[9px] bg-muted/80 rounded
                      opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground"
                  >
                    Copy
                  </button>
                </div>
              )
            }
            return (
              <code className="bg-muted/50 px-1 py-0.5 rounded text-[11px]" {...props}>
                {children}
              </code>
            )
          },
        }}
      />
    </div>
  )
) : null}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/ChatBubble.tsx
git commit -m "feat(ChatBubble): render Agent messages as Markdown with syntax-highlighted code blocks"
```

---

### Task 6: Enhance RunningIndicator with Operation Status

**Files:**
- Modify: `src/renderer/components/agent/ChatBubble.tsx` (RunningIndicator component at bottom)

- [ ] **Step 1: Update RunningIndicator to accept and display current operation**

Replace the `RunningIndicator` component (at the bottom of ChatBubble.tsx, around line 144):
```tsx
// Before:
export function RunningIndicator({ adapterName }: { adapterName?: string }) {
  return (
    <div className="flex gap-2 items-center py-1">
      <div className="w-5 h-5 rounded-full bg-purple-500/20 flex items-center justify-center">
        <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />
      </div>
      <span className="text-xs text-amber-400">{adapterName ?? 'Agent'} is working...</span>
    </div>
  )
}

// After:
export function RunningIndicator({
  adapterName,
  currentOperation,
}: {
  adapterName?: string
  currentOperation?: string
}) {
  return (
    <div className="flex gap-2 items-center py-1">
      <div className="w-5 h-5 rounded-full bg-purple-500/20 flex items-center justify-center">
        <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />
      </div>
      <span className="text-xs text-amber-400">
        {currentOperation
          ? `${adapterName ?? 'Agent'} ${currentOperation}`
          : `${adapterName ?? 'Agent'} is working...`}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Update ChatMessageList to pass currentOperation**

In `src/renderer/components/agent/ChatMessageList.tsx`, find where `<RunningIndicator>` is rendered. Update it to extract the latest file_change from threadOutputs:

```tsx
// Add import at top:
import { useAgentStore } from '../../store/agentStore'

// Inside the component, before the return:
const threadOutputs = useAgentStore((s) => s.threadOutputs)
const latestFileChange = useMemo(() => {
  const outputs = threadOutputs.get(/* current thread id */) ?? []
  const fileChanges = outputs.filter((o) => o.type === 'file_change')
  return fileChanges.length > 0
    ? `is editing ${fileChanges[fileChanges.length - 1].filePath?.split('/').pop() ?? 'files'}...`
    : undefined
}, [threadOutputs, /* thread id dependency */])

// Update RunningIndicator usage:
<RunningIndicator adapterName={adapterName} currentOperation={latestFileChange} />
```

Note: The exact integration depends on how `ChatMessageList` receives the threadId. Pass it as a prop if not already available.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/ChatBubble.tsx src/renderer/components/agent/ChatMessageList.tsx
git commit -m "feat(ChatBubble): show current file operation in RunningIndicator"
```

---

### Task 7: Wire ToolCallRenderer Accept/Reject as Stubs

**Files:**
- Modify: `src/renderer/components/agent/ToolCallRenderer.tsx`

- [ ] **Step 1: Add onAccept/onReject callback props**

Update the `ToolCallRenderer` component to accept callbacks:
```tsx
// Before:
export function ToolCallRenderer({ block }: { block: ToolCallBlock }) {

// After:
export function ToolCallRenderer({
  block,
  onAccept,
  onReject,
}: {
  block: ToolCallBlock
  onAccept?: () => void
  onReject?: () => void
}) {
```

- [ ] **Step 2: Wire the Accept/Reject buttons**

Find the Accept/Reject buttons (around line 38-49). Add onClick handlers:
```tsx
// Before:
<button
  onClick={(e) => { e.stopPropagation() }}
  className="text-[9px] text-green-400 border border-green-800 rounded px-1.5 py-0.5 hover:bg-green-900/30"
>
  <Check className="w-2.5 h-2.5 inline mr-0.5" />Accept
</button>
<button
  onClick={(e) => { e.stopPropagation() }}
  className="text-[9px] text-red-400 border border-red-800 rounded px-1.5 py-0.5 hover:bg-red-900/30"
>
  <X className="w-2.5 h-2.5 inline mr-0.5" />Reject
</button>

// After:
<button
  onClick={(e) => { e.stopPropagation(); onAccept?.() }}
  className="text-[9px] text-green-400 border border-green-800 rounded px-1.5 py-0.5 hover:bg-green-900/30"
>
  <Check className="w-2.5 h-2.5 inline mr-0.5" />Accept
</button>
<button
  onClick={(e) => { e.stopPropagation(); onReject?.() }}
  className="text-[9px] text-red-400 border border-red-800 rounded px-1.5 py-0.5 hover:bg-red-900/30"
>
  <X className="w-2.5 h-2.5 inline mr-0.5" />Reject
</button>
```

- [ ] **Step 3: Update ChatBubble to pass callbacks to ToolCallRenderer**

In `ChatBubble.tsx`, update the ToolCallRenderer usage (around line 103):
```tsx
// Before:
{message.toolCalls?.map((block, i) => (
  <ToolCallRenderer key={i} block={block} />
))}

// After:
{message.toolCalls?.map((block, i) => (
  <ToolCallRenderer
    key={i}
    block={block}
    onAccept={() => {
      // Stub: Phase 3 will wire this to DiffReviewPanel
      console.log('[ToolCall] Accept:', block.filePath)
    }}
    onReject={() => {
      // Stub: Phase 3 will wire this to ScopeGuard rollback
      console.log('[ToolCall] Reject:', block.filePath)
    }}
  />
))}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/agent/ToolCallRenderer.tsx src/renderer/components/agent/ChatBubble.tsx
git commit -m "feat(ToolCallRenderer): wire Accept/Reject buttons with stub handlers"
```

---

### Task 8: Verify Phase 1 End-to-End

- [ ] **Step 1: Start dev server and verify manually**

```bash
npm run dev
```

Open the app, select a node, start an Agent session, and verify:
1. Agent messages render with Markdown formatting (headers, bold, code blocks)
2. Code blocks have syntax highlighting and a Copy button
3. User messages remain plain text
4. When Agent produces file changes, they appear as ToolCallBlock cards (not plain text)
5. ToolCallBlock cards show Accept/Reject buttons
6. RunningIndicator shows the current file being edited

- [ ] **Step 2: Run existing tests**

```bash
npm run test
```

Expected: All tests pass (no regressions).

- [ ] **Step 3: Run type check**

```bash
npx tsc --noEmit
```

Expected: No errors.

---

## Phase 2: Node-Agent Status Sync

### Task 9: Add Agent Status Change IPC Channel

**Files:**
- Modify: `src/shared/types.ts` (IpcApi interface)
- Modify: `src/main/ipc/agent.ts`
- Modify: `src/renderer/store/agentStore.ts`

- [ ] **Step 1: Add IPC channel to IpcApi**

In `src/shared/types.ts`, add to the `IpcApi` interface (after the agent operations section, around line 571):
```ts
'agent:onStatusChange': (sessionId: string, nodeId: string, status: NodeStatus) => void
```

- [ ] **Step 2: Add IPC listener in agentStore**

In `src/renderer/store/agentStore.ts`, add a new method to the store interface:
```ts
listenForStatusChanges: () => () => void
```

Implement it:
```ts
listenForStatusChanges: () => {
  if (typeof window === 'undefined' || !window.electronAPI?.onAgentStatusChange) return () => {}

  const cleanup = window.electronAPI.onAgentStatusChange(
    (_sessionId: string, nodeId: string, status: import('@shared/types').NodeStatus) => {
      // Update the node's status in graphStore
      const graphStore = useGraphStore.getState()
      graphStore.updateNode(nodeId, { status })
    },
  )
  return cleanup
},
```

- [ ] **Step 3: Register the listener in AgentChatPanel**

In `src/renderer/components/agent/AgentChatPanel.tsx`, add inside the component:
```ts
// Listen for agent status changes to sync node status
useEffect(() => {
  const cleanup = useAgentStore.getState().listenForStatusChanges()
  return cleanup
}, [])
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/renderer/store/agentStore.ts src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat: add agent:statusChange IPC channel for node status sync"
```

---

### Task 10: Emit Status Changes from AgentManager

**Files:**
- Modify: `src/main/agent/agent-manager.ts`

- [ ] **Step 1: Add status change callback to AgentManager**

In `src/main/agent/agent-manager.ts`, add a new field and method:
```ts
// Add field (after broadcastNames, around line 37):
private statusChangeCallback?: (sessionId: string, nodeId: string, status: string) => void

// Add method:
setStatusChangeCallback(cb: (sessionId: string, nodeId: string, status: string) => void): void {
  this.statusChangeCallback = cb
}
```

- [ ] **Step 2: Emit status change in startSession**

In `startSession()` (around line 210), after `this.router.bind(session.id, adapterName)`, add:
```ts
// Emit status change: node → developing
const nodeTitle = config.nodeTitle
if (nodeTitle) {
  this.statusChangeCallback?.(session.id, nodeTitle, 'developing')
}
```

Note: `config.nodeTitle` is the node title, not the node ID. We need the actual nodeId. Let me check how it flows.

Actually, looking at the code, `AgentSessionConfig` doesn't have a `nodeId` field — it has `nodeTitle`. The nodeId is available through the thread's `nodeBound` field in the renderer. We need to pass nodeId through the config.

- [ ] **Step 3: Add nodeId to AgentSessionConfig**

In `src/shared/types.ts`, add to `AgentSessionConfig` (around line 191):
```ts
/** 关联的节点 ID（用于状态同步） */
nodeId?: string
```

- [ ] **Step 4: Populate nodeId when sending message**

In `src/renderer/store/agentStore.ts`, in `sendMessage()` (around line 136), update the config construction:
```ts
const config: AgentSessionConfig = sessionConfig ?? {
  workingDirectory: currentGraph?.projectPath ?? '',
  allowedFiles: [],
  forbiddenFiles: [],
  invariantRules: [],
  upstreamContext: '',
  downstreamContext: '',
  nodeTitle: thread.nodeBound ?? '',
  nodeId: thread.nodeBound,  // <-- add this
  acceptanceCriteria: [],
}
```

Also in `AgentChatPanel.tsx` `handleSend()` (around line 271):
```ts
const sessionConfig: AgentSessionConfig = {
  // ... existing fields ...
  nodeId: selectedNode?.id,  // <-- add this
}
```

- [ ] **Step 5: Update AgentManager.startSession to use nodeId**

In `src/main/agent/agent-manager.ts`, update the status change emission:
```ts
// After router.bind (line ~219):
if (config.nodeId) {
  this.statusChangeCallback?.(session.id, config.nodeId, 'developing')
}
```

- [ ] **Step 6: Emit status change in terminateSession**

In `terminateSession()` (around line 283), after `await this.scopeGuard.commitChanges(sandbox)`, add:
```ts
const config = this.sessionConfigs.get(sessionId)
if (config?.nodeId) {
  this.statusChangeCallback?.(sessionId, config.nodeId, 'testing')
}
```

- [ ] **Step 7: Wire the callback in ipc-handlers.ts**

In `src/main/ipc-handlers.ts`, after creating the AgentManager (around line 52), add:
```ts
agentManager.setStatusChangeCallback((sessionId, nodeId, status) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:onStatusChange', sessionId, nodeId, status)
  }
})
```

- [ ] **Step 8: Register the IPC listener in preload**

Check `src/preload/index.ts` for the pattern used by `onAgentOutput` and add a similar `onAgentStatusChange` listener:
```ts
onAgentStatusChange: (callback: (sessionId: string, nodeId: string, status: string) => void) => {
  const handler = (_event: any, sessionId: string, nodeId: string, status: string) => callback(sessionId, nodeId, status)
  ipcRenderer.on('agent:onStatusChange', handler)
  return () => ipcRenderer.removeListener('agent:onStatusChange', handler)
},
```

- [ ] **Step 9: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 10: Commit**

```bash
git add src/shared/types.ts src/main/agent/agent-manager.ts src/main/ipc-handlers.ts src/preload/index.ts src/renderer/store/agentStore.ts src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(AgentManager): emit node status changes on session start/terminate"
```

---

### Task 11: Add Activity Indicators to BizNode

**Files:**
- Modify: `src/renderer/canvas/BizNode.tsx`

- [ ] **Step 1: Import agentStore and icons**

At the top of `src/renderer/canvas/BizNode.tsx`, add:
```ts
import { useAgentStore } from '../store/agentStore'
import { Loader2, AlertTriangle, Check } from 'lucide-react'
import { useState, useEffect } from 'react'
```

- [ ] **Step 2: Add agent state derivation inside BizNodeComponent**

Inside `BizNodeComponent`, after `const isProject = data.type === 'project'`, add:
```ts
// Agent activity state
const agentThread = useAgentStore((s) =>
  s.threads.find((t) => t.nodeBound === data.id)
)
const agentStatus = agentThread?.status
const isAgentRunning = agentStatus === 'running'
const isAgentError = agentStatus === 'error'
const isAgentCompleted = agentStatus === 'idle' && !!agentThread?.sessionId

// Fade-out for completed state
const [showCompleted, setShowCompleted] = useState(false)
useEffect(() => {
  if (isAgentCompleted) {
    setShowCompleted(true)
    const timer = setTimeout(() => setShowCompleted(false), 3000)
    return () => clearTimeout(timer)
  }
  setShowCompleted(false)
}, [isAgentCompleted])
```

- [ ] **Step 3: Add visual indicators to non-project nodes**

In the non-project node's outer `<div>` (around line 74), update the className:
```tsx
// Before:
className={cn(
  'group px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-sm transition-all hover:shadow-md cursor-pointer',
  statusClass,
  selected && 'ring-2 ring-blue-400 ring-offset-1',
)}

// After:
className={cn(
  'group px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-sm transition-all hover:shadow-md cursor-pointer',
  statusClass,
  selected && 'ring-2 ring-blue-400 ring-offset-1',
  isAgentRunning && 'border-orange-400 animate-pulse',
  isAgentError && 'border-red-400',
  showCompleted && 'border-green-400',
)}
```

- [ ] **Step 4: Add status badge overlay**

After the `<div className="flex items-center justify-between mt-1.5">` block (around line 122), add the agent badge:
```tsx
{/* Agent activity badge */}
{(isAgentRunning || isAgentError || showCompleted) && (
  <div className={cn(
    'absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center shadow-sm',
    isAgentRunning && 'bg-orange-400',
    isAgentError && 'bg-red-400',
    showCompleted && 'bg-green-400',
  )}>
    {isAgentRunning && <Loader2 className="w-3 h-3 text-white animate-spin" />}
    {isAgentError && <AlertTriangle className="w-3 h-3 text-white" />}
    {showCompleted && <Check className="w-3 h-3 text-white" />}
  </div>
)}
```

Add `relative` to the outer div's className to position the badge correctly.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/canvas/BizNode.tsx
git commit -m "feat(BizNode): add Agent activity indicators (pulse, error, completed badges)"
```

---

### Task 12: Add ChangeSummaryBadge Component

**Files:**
- Create: `src/renderer/canvas/ChangeSummaryBadge.tsx`
- Modify: `src/renderer/canvas/BizNode.tsx`

- [ ] **Step 1: Create ChangeSummaryBadge component**

Create `src/renderer/canvas/ChangeSummaryBadge.tsx`:
```tsx
import { useState } from 'react'
import { FileEdit, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../lib/utils'
import type { AgentOutput } from '@shared/types'

interface ChangeSummaryBadgeProps {
  outputs: AgentOutput[]
  className?: string
}

export function ChangeSummaryBadge({ outputs, className }: ChangeSummaryBadgeProps) {
  const [expanded, setExpanded] = useState(false)
  const fileChanges = outputs.filter((o) => o.type === 'file_change')
  if (fileChanges.length === 0) return null

  const uniqueFiles = [...new Set(fileChanges.map((o) => o.filePath).filter(Boolean))]

  return (
    <div className={cn('mt-1', className)}>
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
        className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
        <FileEdit className="w-2.5 h-2.5" />
        <span>{uniqueFiles.length} files changed</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 pl-3">
          {uniqueFiles.map((fp) => (
            <div key={fp} className="text-[8px] text-blue-400 font-mono truncate" title={fp}>
              {fp}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Integrate ChangeSummaryBadge into BizNode**

In `BizNode.tsx`, import and render the badge inside the non-project node:
```tsx
import { ChangeSummaryBadge } from './ChangeSummaryBadge'

// Inside the component, get outputs:
const threadOutputs = useAgentStore((s) => s.threadOutputs)
const agentOutputs = agentThread ? (threadOutputs.get(agentThread.id) ?? []) : []

// Render after the status row:
{agentOutputs.length > 0 && (
  <ChangeSummaryBadge outputs={agentOutputs} />
)}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/ChangeSummaryBadge.tsx src/renderer/canvas/BizNode.tsx
git commit -m "feat(ChangeSummaryBadge): show file change summary below nodes with Agent activity"
```

---

### Task 13: Verify Phase 2 End-to-End

- [ ] **Step 1: Start dev server and verify manually**

```bash
npm run dev
```

Verify:
1. When Agent starts on a node, the node border pulses orange with a Loader2 badge
2. When Agent completes, the node border turns green briefly (3s) with a Check badge
3. If Agent errors, the node border turns red with an AlertTriangle badge
4. ChangeSummaryBadge appears below the node showing changed files
5. Node status text updates to 'developing' during Agent execution

- [ ] **Step 2: Run existing tests**

```bash
npm run test
```

Expected: All tests pass.

---

## Phase 3: Diff Review + Commit Workflow

### Task 14: Add ScopeGuard rollbackFile Method

**Files:**
- Modify: `src/main/scope-guard.ts`

- [ ] **Step 1: Add rollbackFile method to ScopeGuard**

In `src/main/scope-guard.ts`, add after the `rollback()` method (around line 342):
```ts
/**
 * 回滚单个文件到备份状态
 */
async rollbackFile(sandbox: Sandbox, filePath: string): Promise<boolean> {
  const relativePath = path.relative(sandbox.workingDir, filePath)
  const backupPath = path.join(sandbox.backupDir, relativePath)

  try {
    const content = await fs.readFile(backupPath, 'utf-8')
    await fs.writeFile(filePath, content, 'utf-8')
    console.log(`[ScopeGuard] Rolled back file: ${relativePath}`)
    return true
  } catch {
    // File may not have existed before (new file) — delete it
    try {
      await fs.unlink(filePath)
      console.log(`[ScopeGuard] Deleted new file: ${relativePath}`)
      return true
    } catch {
      console.warn(`[ScopeGuard] Failed to rollback ${relativePath}`)
      return false
    }
  }
}
```

- [ ] **Step 2: Add getSandbox accessor**

Add a public method to access sandboxes (needed for IPC handler):
```ts
/**
 * 获取指定 ID 的沙箱（供 IPC handler 调用）
 */
getSandbox(sandboxId: string): Sandbox | undefined {
  return this.sandboxes.get(sandboxId)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/scope-guard.ts
git commit -m "feat(ScopeGuard): add rollbackFile method for per-file Diff rejection"
```

---

### Task 15: Add ScopeGuard IPC Handlers

**Files:**
- Create: `src/main/ipc/scope-guard.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Create ScopeGuard IPC handler file**

Create `src/main/ipc/scope-guard.ts`:
```ts
/**
 * ScopeGuard IPC Handlers
 * 文件回滚和提交操作
 */

import type { ScopeGuard } from '../scope-guard'
import type { AgentManager } from '../agent/agent-manager'
import type { TypedHandle } from './utils'

export function registerScopeGuardHandlers(
  scopeGuard: ScopeGuard,
  agentManager: AgentManager,
  typedHandle: TypedHandle,
): void {
  typedHandle('scopeGuard:rollbackFile', async (_, sessionId: string, filePath: string) => {
    const sandbox = agentManager.getSandbox(sessionId)
    if (!sandbox) {
      throw new Error(`No sandbox found for session ${sessionId}`)
    }
    return scopeGuard.rollbackFile(sandbox, filePath)
  })

  typedHandle('scopeGuard:commitSession', async (_, sessionId: string) => {
    const sandbox = agentManager.getSandbox(sessionId)
    if (!sandbox) {
      throw new Error(`No sandbox found for session ${sessionId}`)
    }
    return scopeGuard.commitChanges(sandbox)
  })
}
```

Note: We need to expose AgentManager's sandboxes map. Add a public getter in AgentManager:

In `src/main/agent/agent-manager.ts`, add:
```ts
getSandbox(sessionId: string): import('@shared/types').Sandbox | undefined {
  return this.sandboxes.get(sessionId)
}
```

- [ ] **Step 2: Register handlers in ipc-handlers.ts**

In `src/main/ipc-handlers.ts`, import and register:
```ts
import { registerScopeGuardHandlers } from './ipc/scope-guard'

// Inside registerIpcHandlers(), after other handler registrations:
const scopeGuard = (agentManager as any).scopeGuard as import('./scope-guard').ScopeGuard
registerScopeGuardHandlers(scopeGuard, agentManager, typedHandle)
```

Actually, `scopeGuard` is private in AgentManager. We need to expose it or pass it differently.

Better approach: Pass the ScopeGuard instance through the AgentManager. Add a public getter:

In `src/main/agent/agent-manager.ts`:
```ts
get scopeGuardInstance(): ScopeGuard {
  return this.scopeGuard
}
```

Then in `ipc-handlers.ts`:
```ts
registerScopeGuardHandlers(agentManager.scopeGuardInstance, agentManager, typedHandle)
```

- [ ] **Step 3: Add IPC types to IpcApi**

In `src/shared/types.ts`, add to `IpcApi`:
```ts
'scopeGuard:rollbackFile': (sessionId: string, filePath: string) => Promise<boolean>
'scopeGuard:commitSession': (sessionId: string) => Promise<ValidationResult>
```

- [ ] **Step 4: Add preload bindings**

In `src/preload/index.ts`, add the two new IPC invoke bindings following the existing pattern.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/scope-guard.ts src/main/ipc-handlers.ts src/main/agent/agent-manager.ts src/shared/types.ts src/preload/index.ts
git commit -m "feat: add ScopeGuard IPC handlers for per-file rollback and session commit"
```

---

### Task 16: Create DiffReviewPanel Component

**Files:**
- Create: `src/renderer/components/agent/DiffReviewPanel.tsx`

- [ ] **Step 1: Create the DiffReviewPanel component**

Create `src/renderer/components/agent/DiffReviewPanel.tsx`:
```tsx
import { useState, useMemo } from 'react'
import { Check, X, FileEdit, FilePlus, GitBranch, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ToolCallBlock, AgentOutput } from '@shared/types'

interface FileChangeState {
  filePath: string
  toolCallIndex: number
  status: 'pending' | 'accepted' | 'rejected'
  changeType: 'add' | 'modify' | 'delete'
}

interface DiffReviewPanelProps {
  toolCalls: ToolCallBlock[]
  sessionId?: string
  onCommit: () => void
  onAcceptFile: (index: number) => void
  onRejectFile: (index: number, filePath: string) => void
  onAcceptAll: () => void
  onRejectAll: () => void
  committing?: boolean
}

export function DiffReviewPanel({
  toolCalls,
  onCommit,
  onAcceptFile,
  onRejectFile,
  onAcceptAll,
  onRejectAll,
  committing,
}: DiffReviewPanelProps) {
  const [expandedFile, setExpandedFile] = useState<number | null>(null)

  const fileChanges: FileChangeState[] = useMemo(() =>
    toolCalls
      .map((tc, i) => ({
        filePath: tc.filePath ?? 'unknown',
        toolCallIndex: i,
        status: tc.accepted === true ? 'accepted' as const
          : tc.accepted === false ? 'rejected' as const
          : 'pending' as const,
        changeType: tc.type === 'file_create' ? 'add' as const : 'modify' as const,
      }))
      .filter((fc) => fc.filePath !== 'unknown'),
    [toolCalls],
  )

  const allReviewed = fileChanges.every((fc) => fc.status !== 'pending')
  const acceptedCount = fileChanges.filter((fc) => fc.status === 'accepted').length

  const getChangeIcon = (changeType: string) => {
    switch (changeType) {
      case 'add': return <FilePlus className="w-3 h-3 text-purple-400" />
      case 'delete': return <X className="w-3 h-3 text-red-400" />
      default: return <FileEdit className="w-3 h-3 text-green-400" />
    }
  }

  const getStatusIcon = (status: FileChangeState['status']) => {
    switch (status) {
      case 'accepted': return <Check className="w-3 h-3 text-green-400" />
      case 'rejected': return <X className="w-3 h-3 text-red-400" />
      default: return <div className="w-3 h-3 rounded-full border border-muted-foreground/30" />
    }
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border">
        <div className="flex items-center gap-2">
          <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Changes ({fileChanges.length} files)</span>
          <span className="text-[10px] text-muted-foreground">
            {acceptedCount}/{fileChanges.length} accepted
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onAcceptAll}
            className="text-[10px] px-2 py-0.5 rounded bg-green-600/10 text-green-400 hover:bg-green-600/20 transition-colors"
          >
            Accept All
          </button>
          <button
            onClick={onRejectAll}
            className="text-[10px] px-2 py-0.5 rounded bg-red-600/10 text-red-400 hover:bg-red-600/20 transition-colors"
          >
            Reject All
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="max-h-60 overflow-y-auto">
        {fileChanges.map((fc, i) => (
          <div key={fc.filePath} className="border-b border-border/50 last:border-0">
            <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/30 transition-colors">
              <button
                onClick={() => setExpandedFile(expandedFile === i ? null : i)}
                className="flex-shrink-0"
              >
                {expandedFile === i
                  ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                  : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
              </button>
              {getChangeIcon(fc.changeType)}
              <span className="flex-1 text-[11px] font-mono truncate">{fc.filePath}</span>
              {getStatusIcon(fc.status)}
              {fc.status === 'pending' && (
                <div className="flex gap-1 ml-1">
                  <button
                    onClick={() => onAcceptFile(fc.toolCallIndex)}
                    className="text-[9px] text-green-400 border border-green-800 rounded px-1.5 py-0.5 hover:bg-green-900/30"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => onRejectFile(fc.toolCallIndex, fc.filePath)}
                    className="text-[9px] text-red-400 border border-red-800 rounded px-1.5 py-0.5 hover:bg-red-900/30"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
            {expandedFile === i && (
              <div className="px-3 py-2 bg-background font-mono text-[10px] leading-relaxed overflow-x-auto max-h-32 overflow-y-auto">
                {toolCalls[fc.toolCallIndex]?.content.split('\n').map((line, li) => (
                  <div
                    key={li}
                    className={cn(
                      line.startsWith('+') && 'text-green-400 bg-green-500/5',
                      line.startsWith('-') && 'text-red-400 bg-red-500/5',
                    )}
                  >
                    <span className="text-muted-foreground/40 select-none w-6 inline-block text-right mr-2">
                      {li + 1}
                    </span>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end px-3 py-2 border-t border-border bg-muted/20">
        <button
          onClick={onCommit}
          disabled={!allReviewed || committing}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors',
            allReviewed && !committing
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          {committing && <Loader2 className="w-3 h-3 animate-spin" />}
          Commit
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/DiffReviewPanel.tsx
git commit -m "feat(DiffReviewPanel): create Diff review UI with per-file Accept/Reject and Commit"
```

---

### Task 17: Integrate DiffReviewPanel into AgentChatPanel

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

- [ ] **Step 1: Add state and imports**

In `AgentChatPanel.tsx`, add:
```ts
import { DiffReviewPanel } from './DiffReviewPanel'

// Inside the component, add state:
const [showDiffReview, setShowDiffReview] = useState(false)
const [committing, setCommitting] = useState(false)
```

- [ ] **Step 2: Add "Review Changes" button**

After the ChatMessageList/TerminalView section (around line 408), before the resize handle, add:
```tsx
{/* Review Changes button */}
{currentThread?.status === 'idle' &&
  rawOutputs.some((o) => o.type === 'file_change') &&
  !showDiffReview && (
    <div className="px-3 py-2 flex-shrink-0">
      <button
        onClick={() => setShowDiffReview(true)}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600/10 border border-blue-600/30
          rounded-lg text-sm text-blue-400 hover:bg-blue-600/20 transition-colors"
      >
        <GitBranch className="w-4 h-4" />
        Review Changes
      </button>
    </div>
)}
```

Add `GitBranch` to the lucide-react imports at the top.

- [ ] **Step 3: Add DiffReviewPanel rendering**

When `showDiffReview` is true, render the panel between the message area and the resize handle:
```tsx
{showDiffReview && currentThread && (
  <div className="flex-shrink-0 px-3 py-2">
    <DiffReviewPanel
      toolCalls={
        currentThread.messages
          .filter((m) => m.role === 'agent')
          .flatMap((m) => m.toolCalls ?? [])
      }
      sessionId={currentThread.sessionId}
      committing={committing}
      onAcceptFile={(index) => {
        // Update toolCall.accepted = true in store
        const allToolCalls = currentThread.messages
          .filter((m) => m.role === 'agent')
          .flatMap((m) => m.toolCalls ?? [])
        const tc = allToolCalls[index]
        if (tc) tc.accepted = true
        // Force re-render by updating thread
        useAgentStore.setState({ threads: [...useAgentStore.getState().threads] })
      }}
      onRejectFile={async (index, filePath) => {
        const allToolCalls = currentThread.messages
          .filter((m) => m.role === 'agent')
          .flatMap((m) => m.toolCalls ?? [])
        const tc = allToolCalls[index]
        if (tc) tc.accepted = false
        // Rollback file via IPC
        if (currentThread.sessionId) {
          try {
            await window.electronAPI['scopeGuard:rollbackFile'](currentThread.sessionId, filePath)
          } catch (err) {
            console.error('[DiffReview] Failed to rollback file:', err)
          }
        }
        useAgentStore.setState({ threads: [...useAgentStore.getState().threads] })
      }}
      onAcceptAll={() => {
        currentThread.messages
          .filter((m) => m.role === 'agent')
          .forEach((m) => m.toolCalls?.forEach((tc) => { tc.accepted = true }))
        useAgentStore.setState({ threads: [...useAgentStore.getState().threads] })
      }}
      onRejectAll={async () => {
        currentThread.messages
          .filter((m) => m.role === 'agent')
          .forEach((m) => m.toolCalls?.forEach((tc) => { tc.accepted = false }))
        // Rollback all files
        if (currentThread.sessionId) {
          try {
            await window.electronAPI['scopeGuard:commitSession'](currentThread.sessionId)
          } catch (err) {
            console.error('[DiffReview] Failed to reject all:', err)
          }
        }
        useAgentStore.setState({ threads: [...useAgentStore.getState().threads] })
      }}
      onCommit={async () => {
        setCommitting(true)
        try {
          if (currentThread.sessionId) {
            await window.electronAPI['scopeGuard:commitSession'](currentThread.sessionId)
          }
          // Update thread status
          useAgentStore.getState().updateThreadStatus(currentThread.id, 'reviewed')
          setShowDiffReview(false)
        } catch (err) {
          console.error('[DiffReview] Commit failed:', err)
        } finally {
          setCommitting(false)
        }
      }}
    />
  </div>
)}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(AgentChatPanel): integrate DiffReviewPanel with Accept/Reject/Commit workflow"
```

---

### Task 18: Verify Phase 3 End-to-End

- [ ] **Step 1: Start dev server and verify manually**

```bash
npm run dev
```

Verify:
1. After Agent completes with file changes, "Review Changes" button appears
2. Clicking it opens the DiffReviewPanel showing all changed files
3. Each file can be expanded to show inline diff
4. Accept/Reject per file works
5. Accept All / Reject All works
6. Commit button is enabled only when all files reviewed
7. Committing updates node status

- [ ] **Step 2: Run existing tests**

```bash
npm run test
```

Expected: All tests pass.

---

## Phase 4: Acceptance Criteria Verification

### Task 19: Create Verification Service

**Files:**
- Create: `src/main/agent/verification-service.ts`

- [ ] **Step 1: Create the verification service**

Create `src/main/agent/verification-service.ts`:
```ts
/**
 * Verification Service
 * Builds verification prompts and parses Agent responses for acceptance criteria checking
 */

import type { ChatMessage, AgentOutput, VerificationResult, VerificationReport } from '@shared/types'

export class VerificationService {
  /**
   * Build a verification prompt from acceptance criteria and agent output
   */
  buildVerificationPrompt(
    nodeId: string,
    acceptanceCriteria: string[],
    messages: ChatMessage[],
    fileChanges: AgentOutput[],
  ): string {
    const lines: string[] = []

    lines.push('You are a QA reviewer. Evaluate whether the implementation meets each acceptance criterion.')
    lines.push('')
    lines.push('## Acceptance Criteria')
    acceptanceCriteria.forEach((c, i) => {
      lines.push(`${i + 1}. ${c}`)
    })
    lines.push('')

    lines.push('## Implementation Summary')
    const agentMessages = messages.filter((m) => m.role === 'agent')
    const summary = agentMessages
      .map((m) => m.content)
      .join('\n')
      .slice(0, 3000)
    lines.push(summary)
    lines.push('')

    lines.push('## Changed Files')
    const uniqueFiles = [...new Set(fileChanges.map((o) => o.filePath).filter(Boolean))]
    uniqueFiles.forEach((fp) => {
      const change = fileChanges.find((o) => o.filePath === fp)
      lines.push(`- ${change?.changeType ?? 'modify'}: ${fp}`)
    })
    lines.push('')

    lines.push('For each criterion, respond with exactly this format:')
    lines.push('CRITERION_N: PASS or FAIL')
    lines.push('JUSTIFICATION_N: Brief justification (1-2 sentences)')
    lines.push('')

    lines.push('Where N is the criterion number (1, 2, 3, ...).')
    lines.push('Do not include any other text between criterion responses.')

    return lines.join('\n')
  }

  /**
   * Parse Agent's verification response into structured results
   */
  parseVerificationResponse(
    response: string,
    acceptanceCriteria: string[],
  ): VerificationResult[] {
    const results: VerificationResult[] = []

    for (let i = 0; i < acceptanceCriteria.length; i++) {
      const n = i + 1
      const passPattern = new RegExp(`CRITERION_${n}:\\s*PASS`, 'i')
      const failPattern = new RegExp(`CRITERION_${n}:\\s*FAIL`, 'i')
      const justificationPattern = new RegExp(`JUSTIFICATION_${n}:\\s*(.+?)(?=\\nCRITERION_|$)`, 'is')

      const passed = passPattern.test(response)
      const failed = failPattern.test(response)
      const justificationMatch = response.match(justificationPattern)

      results.push({
        criterion: acceptanceCriteria[i],
        passed: passed && !failed,
        justification: justificationMatch?.[1]?.trim() ?? 'No justification provided',
      })
    }

    return results
  }

  /**
   * Build a retry prompt for failed criteria
   */
  buildRetryPrompt(
    failedResults: VerificationResult[],
  ): string {
    const lines: string[] = []

    lines.push('The following acceptance criteria were not met. Please fix the implementation:')
    lines.push('')

    failedResults.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.criterion}`)
      lines.push(`   Issue: ${r.justification}`)
      lines.push('')
    })

    lines.push('Please address each issue and ensure all criteria are met.')

    return lines.join('\n')
  }
}
```

- [ ] **Step 2: Add VerificationResult and VerificationReport types to shared types**

In `src/shared/types.ts`, add before the IPC section:
```ts
/** Verification result for a single acceptance criterion */
export interface VerificationResult {
  criterion: string
  passed: boolean
  justification: string
}

/** Verification report for a node */
export interface VerificationReport {
  nodeId: string
  results: VerificationResult[]
  passedCount: number
  totalCount: number
  timestamp: number
}
```

- [ ] **Step 3: Add agent:verify IPC channel**

In `src/shared/types.ts` `IpcApi` interface, add:
```ts
'agent:verify': (params: {
  nodeId: string
  acceptanceCriteria: string[]
  messages: ChatMessage[]
  fileChanges: AgentOutput[]
}) => Promise<VerificationReport>
```

- [ ] **Step 4: Register the IPC handler**

In `src/main/ipc/agent.ts`, add:
```ts
import { VerificationService } from '../agent/verification-service'

// Inside registerAgentHandlers:
const verificationService = new VerificationService()

typedHandle('agent:verify', async (_, params) => {
  const { nodeId, acceptanceCriteria, messages, fileChanges } = params
  const prompt = verificationService.buildVerificationPrompt(nodeId, acceptanceCriteria, messages, fileChanges)

  // Use the same adapter as the current session (or MCP fallback)
  // For now, use the first available adapter
  const adapters = await agentManager.listAdapters()
  const installed = adapters.find((a) => a.installed)
  if (!installed) {
    throw new Error('No agent adapter available for verification')
  }

  // Create a verification session
  const config = {
    workingDirectory: '',
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: 'Verification',
    acceptanceCriteria: [],
  }

  // Send the verification prompt and collect response
  // This is a simplified version — in production, collect the streamed response
  const result = await new Promise<string>((resolve, reject) => {
    let response = ''
    const handler = (output: any) => {
      if (output.type === 'stdout') {
        response += output.data
      }
      if (output.type === 'complete') {
        resolve(response)
      }
      if (output.type === 'error') {
        reject(new Error(output.data))
      }
    }
    agentManager.addOutputListener(handler)

    agentManager.startSession(installed.name, config).then(({ sessionId }) => {
      agentManager.sendCommand(sessionId, {
        type: 'implement',
        description: prompt,
        targetNodeId: nodeId,
      })
    }).catch(reject)

    // Cleanup after 60s timeout
    setTimeout(() => {
      agentManager.removeOutputListener(handler)
      resolve(response)
    }, 60000)
  })

  agentManager.removeOutputListener(() => {})

  const verificationResults = verificationService.parseVerificationResponse(result, acceptanceCriteria)

  return {
    nodeId,
    results: verificationResults,
    passedCount: verificationResults.filter((r) => r.passed).length,
    totalCount: verificationResults.length,
    timestamp: Date.now(),
  }
})
```

Note: This is a simplified implementation. The actual production version should properly track the verification session and clean up listeners.

- [ ] **Step 5: Add preload binding**

In `src/preload/index.ts`, add the `agent:verify` invoke binding.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/agent/verification-service.ts src/shared/types.ts src/main/ipc/agent.ts src/preload/index.ts
git commit -m "feat(VerificationService): build verification prompts and parse acceptance criteria results"
```

---

### Task 20: Create VerificationPanel Component

**Files:**
- Create: `src/renderer/components/agent/VerificationPanel.tsx`

- [ ] **Step 1: Create VerificationPanel**

Create `src/renderer/components/agent/VerificationPanel.tsx`:
```tsx
import { useState } from 'react'
import { CheckCircle, XCircle, Loader2, Wrench, SkipForward, ArrowLeft } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { VerificationReport, VerificationResult } from '@shared/types'

interface VerificationPanelProps {
  report: VerificationReport | null
  loading: boolean
  onRetryFailed: () => void
  onMarkComplete: () => void
  onBackToEdit: () => void
  maxRetries?: number
  currentRetry?: number
}

export function VerificationPanel({
  report,
  loading,
  onRetryFailed,
  onMarkComplete,
  onBackToEdit,
  maxRetries = 2,
  currentRetry = 0,
}: VerificationPanelProps) {
  if (loading) {
    return (
      <div className="border border-border rounded-lg p-6 bg-background flex flex-col items-center gap-3">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
        <span className="text-sm text-muted-foreground">Verifying acceptance criteria...</span>
      </div>
    )
  }

  if (!report) return null

  const allPassed = report.passedCount === report.totalCount
  const canRetry = currentRetry < maxRetries && !allPassed

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background">
      {/* Header */}
      <div className={cn(
        'flex items-center justify-between px-3 py-2 border-b border-border',
        allPassed ? 'bg-green-500/10' : 'bg-red-500/10',
      )}>
        <div className="flex items-center gap-2">
          {allPassed
            ? <CheckCircle className="w-4 h-4 text-green-400" />
            : <XCircle className="w-4 h-4 text-red-400" />}
          <span className="text-sm font-medium">
            Verification Report — {report.passedCount}/{report.totalCount} passed
          </span>
        </div>
        {currentRetry > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Retry {currentRetry}/{maxRetries}
          </span>
        )}
      </div>

      {/* Results */}
      <div className="divide-y divide-border/50">
        {report.results.map((result, i) => (
          <div key={i} className="px-3 py-2 flex items-start gap-2">
            {result.passed
              ? <CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 flex-shrink-0" />
              : <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-xs">{result.criterion}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{result.justification}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/20">
        <button
          onClick={onBackToEdit}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to Edit
        </button>
        <div className="flex items-center gap-1.5">
          {canRetry && (
            <button
              onClick={onRetryFailed}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-orange-600/10 text-orange-400
                rounded hover:bg-orange-600/20 transition-colors"
            >
              <Wrench className="w-3 h-3" />
              Retry Failed
            </button>
          )}
          <button
            onClick={onMarkComplete}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-blue-600 text-white
              rounded hover:bg-blue-700 transition-colors"
          >
            <SkipForward className="w-3 h-3" />
            Mark Complete
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/VerificationPanel.tsx
git commit -m "feat(VerificationPanel): create verification report UI with retry and mark complete actions"
```

---

### Task 21: Integrate VerificationPanel into AgentChatPanel

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

- [ ] **Step 1: Add verification state and imports**

In `AgentChatPanel.tsx`, add:
```ts
import { VerificationPanel } from './VerificationPanel'
import type { VerificationReport } from '@shared/types'

// Inside the component, add state:
const [showVerification, setShowVerification] = useState(false)
const [verificationReport, setVerificationReport] = useState<VerificationReport | null>(null)
const [verifying, setVerifying] = useState(false)
const [retryCount, setRetryCount] = useState(0)
```

- [ ] **Step 2: Add auto-verification after commit**

In the `onCommit` handler of the DiffReviewPanel integration, add verification trigger after successful commit:
```ts
// After setShowDiffReview(false) in onCommit:
// Auto-trigger verification if node has acceptance criteria
if (selectedNode?.acceptanceCriteria && selectedNode.acceptanceCriteria.length > 0) {
  setShowVerification(true)
  setVerifying(true)
  try {
    const report = await window.electronAPI['agent:verify']({
      nodeId: selectedNode.id,
      acceptanceCriteria: selectedNode.acceptanceCriteria,
      messages: currentThread.messages,
      fileChanges: rawOutputs.filter((o) => o.type === 'file_change'),
    })
    setVerificationReport(report)
  } catch (err) {
    console.error('[Verification] Failed:', err)
  } finally {
    setVerifying(false)
  }
}
```

- [ ] **Step 3: Add verification panel rendering**

After the DiffReviewPanel section, add:
```tsx
{showVerification && (
  <div className="flex-shrink-0 px-3 py-2">
    <VerificationPanel
      report={verificationReport}
      loading={verifying}
      currentRetry={retryCount}
      onRetryFailed={async () => {
        if (!verificationReport) return
        const failedResults = verificationReport.results.filter((r) => !r.passed)
        setRetryCount((c) => c + 1)
        setVerifying(true)

        // Send retry prompt via existing thread
        const retryPrompt = `Fix the following unmet criteria:\n${failedResults.map((r, i) => `${i + 1}. ${r.criterion}\n   Issue: ${r.justification}`).join('\n')}`
        await handleSend(retryPrompt, attachedContexts)

        // Re-verify after agent completes (will be triggered by the commit flow)
        setVerifying(false)
      }}
      onMarkComplete={() => {
        if (selectedNode) {
          useGraphStore.getState().updateNode(selectedNode.id, { status: 'review' })
        }
        setShowVerification(false)
        setVerificationReport(null)
        setRetryCount(0)
      }}
      onBackToEdit={() => {
        setShowVerification(false)
        setVerificationReport(null)
      }}
    />
  </div>
)}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(AgentChatPanel): integrate VerificationPanel with auto-trigger after Diff commit"
```

---

### Task 22: Verify Full Closed-Loop End-to-End

- [ ] **Step 1: Start dev server and verify the complete flow**

```bash
npm run dev
```

Test the full closed-loop:
1. Select a node with acceptance criteria
2. Start Agent via `handleStartDev` or `/implement` slash command
3. Verify: node shows orange pulse indicator during execution
4. Verify: Agent messages render as Markdown with code highlighting
5. Verify: file changes appear as ToolCallBlocks
6. After Agent completes: "Review Changes" button appears
7. Click "Review Changes": DiffReviewPanel opens with file list
8. Accept all files, click Commit
9. VerificationPanel auto-appears with acceptance criteria check
10. If all pass: node status → 'review'
11. If some fail: "Retry Failed" available (max 2 retries)
12. "Mark Complete" manually approves

- [ ] **Step 2: Run all tests**

```bash
npm run test
npm run lint
npx tsc --noEmit
```

Expected: All pass.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete AgentChat enhancement and Mind Map closed-loop integration

Phase 1: Markdown rendering, ToolCall streaming, status indicators
Phase 2: Node-Agent status sync, activity indicators, change badges
Phase 3: Diff review panel, Accept/Reject, commit workflow
Phase 4: Acceptance criteria verification, auto-retry, final status update"
```
