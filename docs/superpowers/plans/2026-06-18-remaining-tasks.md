# Remaining Implementation Plan — Unfinished & Partial Tasks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the 16 unfinished and 16 partially-completed tasks from the comprehensive polish implementation plan.

**Architecture:** Tasks are organized by domain, grouped into parallelizable batches where no file-level conflicts exist. Each task is self-contained and can be implemented independently.

**Tech Stack:** TypeScript, React, Zustand, ReactFlow, Vitest, Tailwind CSS

---

## Batch A: Backend/Core (Domain 1, 5, 6) — No UI, can run in parallel

### Task 1: Entity-extractor position info (1.1.3)

**Files:**
- Modify: `src/main/code-intelligence/entity-extractor.ts`
- Test: `src/main/code-intelligence/__tests__/entity-extractor.test.ts` (new if not exists, otherwise extend)

- [ ] **Step 1: Add position fields to ExtractedEntity interface**

In `src/main/code-intelligence/entity-extractor.ts`, update the `ExtractedEntity` interface:

```typescript
export interface ExtractedEntity {
  name: string
  type: EntityType
  confidence: number
  position?: { start: number; end: number }
  line?: number
  endLine?: number
  column?: number
  endColumn?: number
}
```

- [ ] **Step 2: Add line/column computation helper**

Add a function after the interface:

```typescript
function computeLineInfo(text: string, start: number, end: number): { line: number; endLine: number; column: number; endColumn: number } {
  const beforeStart = text.slice(0, start)
  const beforeEnd = text.slice(0, end)
  const line = (beforeStart.match(/\n/g) || []).length + 1
  const endLine = (beforeEnd.match(/\n/g) || []).length + 1
  const column = start - beforeStart.lastIndexOf('\n') - 1
  const endColumn = end - beforeEnd.lastIndexOf('\n') - 1
  return { line, endLine, column, endColumn }
}
```

- [ ] **Step 3: Wire line info into entity extraction**

In each extraction pass that computes `position`, after creating the entity with `position: { start, end }`, add:

```typescript
const lineInfo = computeLineInfo(text, start, end)
// ... spread into entity: ...lineInfo
```

Specifically, in the regex passes (PascalCase, filePaths, techKeywords, dotNotation, chinesePattern), when a `position` is computed from `match.index`, call `computeLineInfo` and spread the result.

- [ ] **Step 4: Write test**

Create or extend test file with:

```typescript
import { describe, it, expect } from 'vitest'
import { extractEntities } from '../entity-extractor'

describe('entity-extractor position info', () => {
  it('computes line and column for extracted entities', () => {
    const text = 'class Foo {}\nfunction bar() {}\nconst baz = 1'
    const result = extractEntities(text)
    const fooEntity = result.entities.find(e => e.name === 'Foo')
    expect(fooEntity).toBeDefined()
    expect(fooEntity!.line).toBe(1)
    expect(fooEntity!.endLine).toBe(1)
    expect(fooEntity!.column).toBeGreaterThanOrEqual(0)

    const barEntity = result.entities.find(e => e.name === 'bar')
    expect(barEntity).toBeDefined()
    expect(barEntity!.line).toBe(2)
  })

  it('handles multi-line entities', () => {
    const text = 'class Foo {\n  method1() {}\n}'
    const result = extractEntities(text)
    const fooEntity = result.entities.find(e => e.name === 'Foo')
    expect(fooEntity).toBeDefined()
    expect(fooEntity!.line).toBe(1)
    expect(fooEntity!.endLine).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/main/code-intelligence/__tests__/entity-extractor.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/code-intelligence/entity-extractor.ts src/main/code-intelligence/__tests__/entity-extractor.test.ts
git commit -m "feat(ast): add line/column position info to entity extraction"
```

---

### Task 2: Scope layer dynamic compression (6.1.1)

**Files:**
- Modify: `src/main/memory/prompt-orchestrator.ts`

- [ ] **Step 1: Add compressionLevel to LayerBreakdown**

In `src/main/memory/prompt-orchestrator.ts`, update the `LayerBreakdown` interface:

```typescript
interface LayerBreakdown {
  name: string
  tokens: number
  included: boolean
  compressionLevel?: number
}
```

- [ ] **Step 2: Implement priority-ordered scope compression**

Replace the current `compressScopePrompt` import/usage with a local function that follows the priority order. Add a new function in the file (after the `assemble` function):

```typescript
function compressScopeByPriority(scopeText: string, maxTokens: number, estimateTokens: (t: string) => number): { text: string; compressionLevel: number } {
  const sections = scopeText.split(/\n{2,}/)
  const INVARIANT_MARKER = '## Invariant Rules'
  const UPSTREAM_MARKER = '## Upstream'
  const DOWNSTREAM_MARKER = '## Downstream'
  const FILES_MARKER = '## Allowed Files'

  const invariant = sections.filter(s => s.startsWith(INVARIANT_MARKER))
  const upstream = sections.filter(s => s.startsWith(UPSTREAM_MARKER))
  const downstream = sections.filter(s => s.startsWith(DOWNSTREAM_MARKER))
  const files = sections.filter(s => s.startsWith(FILES_MARKER))
  const other = sections.filter(s =>
    !s.startsWith(INVARIANT_MARKER) && !s.startsWith(UPSTREAM_MARKER) &&
    !s.startsWith(DOWNSTREAM_MARKER) && !s.startsWith(FILES_MARKER)
  )

  // Priority: other > files > upstream/downstream > invariant
  const ordered = [other, files, downstream, upstream, invariant]

  let level = 0
  let result = sections.join('\n\n')
  let tokens = estimateTokens(result)

  if (tokens <= maxTokens) return { text: result, compressionLevel: 0 }

  // Level 1: Remove invariant rules
  level = 1
  result = ordered.filter((_, i) => i !== 4).flat().join('\n\n')
  tokens = estimateTokens(result)
  if (tokens <= maxTokens) return { text: result, compressionLevel: level }

  // Level 2: Remove upstream/downstream
  level = 2
  result = ordered.filter((_, i) => i !== 4 && i !== 3 && i !== 2).flat().join('\n\n')
  tokens = estimateTokens(result)
  if (tokens <= maxTokens) return { text: result, compressionLevel: level }

  // Level 3: Compress allowed files to filenames only
  level = 3
  const compressedFiles = files.map(s => {
    const lines = s.split('\n')
    const header = lines[0]
    const paths = lines.slice(1).map(p => p.trim().split('/').pop() || p.trim())
    return header + '\n' + paths.join('\n')
  })
  result = [...other, ...compressedFiles].join('\n\n')
  tokens = estimateTokens(result)
  if (tokens <= maxTokens) return { text: result, compressionLevel: level }

  // Level 4: Hard truncate
  level = 4
  const words = result.split(' ')
  while (words.length > 0 && estimateTokens(words.join(' ')) > maxTokens) {
    words.pop()
  }
  return { text: words.join(' ') + '...', compressionLevel: level }
}
```

- [ ] **Step 3: Wire into assemble()**

In the `assemble()` method, where scope compression currently happens (the section that calls `compressScopePrompt`), replace with:

```typescript
const { text: scopeCompressed, compressionLevel } = compressScopeByPriority(scopeText, scopeBudget, estimateTokens)
```

And in the layerBreakdown construction for the scope layer, add:

```typescript
{ name: 'scope', tokens: scopeTokens, included: true, compressionLevel }
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/prompt-orchestrator.ts
git commit -m "feat(prompt): priority-ordered scope compression with compressionLevel tracking"
```

---

### Task 3: Health-driven auto-degradation (5.2.1)

**Files:**
- Modify: `src/main/agent/agent-manager.ts`

- [ ] **Step 1: Add consecutive timeout tracking to session state**

In `src/main/agent/agent-manager.ts`, add to the `SessionState` interface or the session state tracking:

```typescript
private adapterTimeoutCounts: Map<string, number> = new Map()
```

- [ ] **Step 2: Modify startSession to apply health-based timeout adjustment**

In the `startSession()` method, after selecting the adapter and before calling `adapter.startSession(config)`, add health-based logic:

```typescript
const health = this.healthMonitor.getAdapterHealth(adapterName)
const baseTimeout = config.timeoutMs ?? 120_000

if (health?.status === 'unhealthy') {
  this.logger.info(`Adapter ${adapterName} is unhealthy, skipping to fallback`)
  continue // skip to next adapter in the chain
}

let effectiveTimeout = baseTimeout
if (health?.status === 'degraded') {
  effectiveTimeout = Math.floor(baseTimeout * 0.5)
  this.logger.info(`Adapter ${adapterName} is degraded, using ${effectiveTimeout}ms timeout (50% of normal)`)
}
config.timeoutMs = effectiveTimeout
```

- [ ] **Step 3: Track consecutive timeouts and auto-fallback**

After a session attempt fails with a timeout, increment the counter:

```typescript
// In the catch block for adapter.startSession or session timeout handling:
const currentCount = this.adapterTimeoutCounts.get(adapterName) ?? 0
this.adapterTimeoutCounts.set(adapterName, currentCount + 1)

if (currentCount + 1 >= 2) {
  this.logger.warn(`Adapter ${adapterName} has ${currentCount + 1} consecutive timeouts, auto-switching to fallback`)
  this.adapterTimeoutCounts.delete(adapterName)
  continue // move to next adapter in chain
}
```

On success, reset the counter:

```typescript
this.adapterTimeoutCounts.delete(adapterName)
```

- [ ] **Step 4: Add background recovery check for unhealthy adapters**

Add a method:

```typescript
private startRecoveryCheck(adapterName: string): void {
  const interval = setInterval(async () => {
    const adapter = this.registry.getAdapter(adapterName)
    if (!adapter) { clearInterval(interval); return }
    const installed = await adapter.checkInstalled()
    if (installed) {
      this.healthMonitor.recordCall(adapterName, true, 0, 'recovery-check')
      this.logger.info(`Adapter ${adapterName} recovered, health score will improve`)
      clearInterval(interval)
    }
  }, 60_000)
}
```

Call it when an adapter is skipped due to unhealthy status.

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/agent-manager.ts
git commit -m "feat(agent): health-driven auto-degradation with shorter timeout and consecutive-timeout fallback"
```

---

## Batch B: Frontend Components (Domain 3, 4, 5, 7) — Independent UI tasks

### Task 4: Message status visualization (3.2.1)

**Files:**
- Modify: `src/renderer/components/agent/ChatBubble.tsx`
- Modify: `src/shared/types/agent.ts`

- [ ] **Step 1: Add queued and sending to MessageStatus**

In `src/shared/types/agent.ts`, update the `MessageStatus` type to include `queued` and `sending`:

```typescript
export type MessageStatus = 'pending' | 'queued' | 'sending' | 'streaming' | 'success' | 'error' | 'aborted' | 'permanently_failed'
```

- [ ] **Step 2: Add status icon mapping in ChatBubble**

In `src/renderer/components/agent/ChatBubble.tsx`, add a status icon component:

```tsx
const STATUS_ICONS: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
  queued: { icon: <Clock size={10} />, label: 'Queued', className: 'text-gray-400' },
  sending: { icon: <Send size={10} />, label: 'Sending', className: 'text-blue-400' },
  streaming: { icon: <Loader2 size={10} className="animate-spin" />, label: 'Streaming', className: 'text-blue-500' },
  success: { icon: <Check size={10} />, label: 'Sent', className: 'text-green-500' },
  error: { icon: <AlertTriangle size={10} />, label: 'Failed', className: 'text-red-500' },
  permanently_failed: { icon: <XCircle size={10} />, label: 'Failed', className: 'text-red-600' },
}
```

Import `Clock`, `Send`, `Loader2` from lucide-react.

- [ ] **Step 3: Render status icon in ChatBubble**

In the message header area (next to the timestamp), render the status icon:

```tsx
{message.status && STATUS_ICONS[message.status] && (
  <span className={`inline-flex items-center gap-0.5 text-[10px] ${STATUS_ICONS[message.status].className}`} title={STATUS_ICONS[message.status].label}>
    {STATUS_ICONS[message.status].icon}
  </span>
)}
```

- [ ] **Step 4: Run type check and dev server**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/agent.ts src/renderer/components/agent/ChatBubble.tsx
git commit -m "feat(chat): add message status icons for queued/sending/streaming/success/error"
```

---

### Task 5: Output folding for long stdout (5.1.2)

**Files:**
- Modify: `src/renderer/components/agent/ChatBubble.tsx`

- [ ] **Step 1: Create CollapsibleOutput component**

In `src/renderer/components/agent/ChatBubble.tsx`, add a component before the main `ChatBubble` component:

```tsx
function CollapsibleOutput({ content, maxLines = 20 }: { content: string; maxLines?: number }) {
  const lines = content.split('\n')
  const shouldFold = lines.length > maxLines
  const [expanded, setExpanded] = useState(false)

  if (!shouldFold) {
    return <pre className="text-xs whitespace-pre-wrap font-mono break-all">{content}</pre>
  }

  const displayed = expanded ? lines : lines.slice(0, 3)

  return (
    <div className="relative">
      <pre className="text-xs whitespace-pre-wrap font-mono break-all">{displayed.join('\n')}</pre>
      {!expanded && <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-background to-transparent" />}
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-muted-foreground hover:text-foreground mt-1"
      >
        {expanded ? 'Show less' : `Show all ${lines.length} lines`}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Use CollapsibleOutput for stdout/stderr in ChatBubble**

In the ChatBubble component, find where stdout content is rendered (the `pre` or `code` block for output type messages), replace with:

```tsx
<CollapsibleOutput content={outputText} />
```

Do NOT fold error messages or code blocks (those with language tags). Only fold plain stdout/stderr blocks.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/ChatBubble.tsx
git commit -m "feat(chat): auto-fold long stdout output with expand/collapse"
```

---

### Task 6: Confirmation dialog UI (3.4.2)

**Files:**
- Create: `src/renderer/components/agent/ConfirmationDialog.tsx`
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

- [ ] **Step 1: Create ConfirmationDialog component**

Create `src/renderer/components/agent/ConfirmationDialog.tsx`:

```tsx
import { AlertTriangle, Check, X } from 'lucide-react'
import { useMessageStore } from '@/store/messageStore'

export function ConfirmationDialog() {
  const pendingConfirmations = useMessageStore(s => s.pendingConfirmations)
  const confirmToolCall = useMessageStore(s => s.confirmToolCall)

  const entries = Array.from(pendingConfirmations.entries())
  if (entries.length === 0) return null

  const [threadId, confirmations] = entries[0]
  if (!confirmations || confirmations.length === 0) return null

  const pending = confirmations[0]
  const { messageId, toolCall, reason } = pending

  return (
    <div className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 rounded-lg p-3 mx-2 mb-2">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Confirmation Required</p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">{reason}</p>
          {toolCall?.filePath && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 font-mono truncate">{toolCall.filePath}</p>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-2 justify-end">
        <button
          onClick={() => confirmToolCall(threadId, messageId, false)}
          className="flex items-center gap-1 px-3 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X size={12} /> Reject
        </button>
        <button
          onClick={() => confirmToolCall(threadId, messageId, true)}
          className="flex items-center gap-1 px-3 py-1 text-xs rounded-md bg-amber-600 text-white hover:bg-amber-700"
        >
          <Check size={12} /> Confirm
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add ConfirmationDialog to AgentChatPanel**

In `src/renderer/components/agent/AgentChatPanel.tsx`, import and render the dialog above the message list:

```tsx
import { ConfirmationDialog } from './ConfirmationDialog'

// In the JSX, above the ChatMessageList or messages container:
<ConfirmationDialog />
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/ConfirmationDialog.tsx src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(chat): add confirmation dialog for high-risk operations"
```

---

### Task 7: Risk level refinement (3.4.1)

**Files:**
- Modify: `src/renderer/hooks/useAgentOutputListener.ts`

- [ ] **Step 1: Add medium and low risk classification**

In `src/renderer/hooks/useAgentOutputListener.ts`, replace `isHighRiskOperation` with a `classifyRiskLevel` function:

```typescript
type RiskLevel = 'high' | 'medium' | 'low'

function classifyRiskLevel(output: AgentOutput): { level: RiskLevel; reason: string } {
  // High risk: file deletion
  if (output.changeType === 'delete') {
    return { level: 'high', reason: `File deletion: ${output.filePath}` }
  }

  // Medium risk: config file modification
  if (CONFIG_PATTERNS.test(output.filePath ?? '')) {
    return { level: 'medium', reason: `Config file modification: ${output.filePath}` }
  }

  // Medium risk: format/comment only changes (heuristic)
  if (output.metadata?.isFormatOnly || output.metadata?.isCommentOnly) {
    return { level: 'low', reason: `Formatting/comment change: ${output.filePath}` }
  }

  // Low risk: all other file modifications
  return { level: 'low', reason: '' }
}
```

- [ ] **Step 2: Update the confirmation flow**

Replace the `isHighRiskOperation` call with `classifyRiskLevel`:

```typescript
const { level, reason } = classifyRiskLevel(output)

if (level === 'high') {
  // Must confirm
  emit(Events.CONFIRMATION_REQUIRED, { threadId, messageId, toolCall, reason })
} else if (level === 'medium') {
  // Non-blocking hint (auto-accept but log)
  store.appendToolCall(threadId, messageId, toolCall)
  // Could show a transient toast in future
} else {
  // Low risk: auto-accept
  store.appendToolCall(threadId, messageId, toolCall)
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/hooks/useAgentOutputListener.ts
git commit -m "feat(agent): refine risk levels to high/medium/low with appropriate handling"
```

---

### Task 8: Preview node visual rendering (4.3.2)

**Files:**
- Modify: `src/renderer/canvas/BizNode.tsx`

- [ ] **Step 1: Add preview node styling**

In `src/renderer/canvas/BizNode.tsx`, detect preview state and apply visual treatment. In the main node container div, add conditional classes:

```tsx
const isPreview = data.metadata?.preview === true
```

Then in the outer container className, add:

```tsx
${isPreview ? 'opacity-50 border-dashed border-2 border-gray-400 dark:border-gray-500' : ''}
```

- [ ] **Step 2: Add confirm/clear buttons for preview nodes**

Inside the node, after the status area, add preview action buttons:

```tsx
{isPreview && (
  <div className="flex gap-1 mt-1">
    <button
      onClick={(e) => { e.stopPropagation(); useGraphStore.getState().confirmPreviewNode(data.id) }}
      className="text-[9px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900 dark:text-green-300"
    >
      Confirm
    </button>
    <button
      onClick={(e) => { e.stopPropagation(); useGraphStore.getState().clearPreviewNodes() }}
      className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300"
    >
      Clear
    </button>
  </div>
)}
```

- [ ] **Step 3: Verify graphStore has the actions**

Check that `useGraphStore.getState().confirmPreviewNode` and `clearPreviewNodes` exist (they do per the verification report).

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/BizNode.tsx
git commit -m "feat(canvas): render preview nodes with opacity, dashed border, and confirm/clear actions"
```

---

### Task 9: Canvas progress overlay for generation (4.3.1)

**Files:**
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx`
- Modify: `src/renderer/canvas/GraphCanvas.tsx`

- [ ] **Step 1: Add generation progress state to CanvasOverlay props**

In `src/renderer/canvas/components/CanvasOverlay.tsx`, add to `CanvasOverlayProps`:

```typescript
generationProgress?: { stage: string; progress: number } | null
```

- [ ] **Step 2: Render progress overlay in CanvasOverlay**

Add the progress overlay JSX after the existing overlays:

```tsx
{generationProgress && (
  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-background/90 backdrop-blur-sm border border-border rounded-lg px-4 py-2 shadow-lg flex items-center gap-3 min-w-[200px]">
    <span className="text-xs text-muted-foreground whitespace-nowrap">{generationProgress.stage}</span>
    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
      <div
        className="h-full bg-primary rounded-full transition-all duration-300"
        style={{ width: `${Math.min(100, generationProgress.progress)}%` }}
      />
    </div>
    <span className="text-xs font-mono text-muted-foreground">{Math.round(generationProgress.progress)}%</span>
  </div>
)}
```

- [ ] **Step 3: Wire GENERATION_PROGRESS event in GraphCanvas**

In `src/renderer/canvas/GraphCanvas.tsx`, add state and event listener:

```tsx
const [genProgress, setGenProgress] = useState<{ stage: string; progress: number } | null>(null)

useEffect(() => {
  const unsub = eventBus.on(Events.GENERATION_PROGRESS, (data: { stage: string; progress: number }) => {
    setGenProgress(data)
    if (data.progress >= 100) {
      setTimeout(() => setGenProgress(null), 1500)
    }
  })
  return unsub
}, [])
```

Pass `generationProgress={genProgress}` to `CanvasOverlay`.

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/components/CanvasOverlay.tsx src/renderer/canvas/GraphCanvas.tsx
git commit -m "feat(canvas): add generation progress overlay with stage name and progress bar"
```

---

### Task 10: Association discovery notification (4.1.3)

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx`
- Modify: `src/renderer/store/graphStore.ts`

- [ ] **Step 1: Add notification state to graphStore**

In `src/renderer/store/graphStore.ts`, add to the store interface:

```typescript
associationNotifications: Array<{ id: string; count: number; timestamp: number }>
addAssociationNotification: (count: number) => void
dismissAssociationNotification: (id: string) => void
```

Implement:

```typescript
addAssociationNotification: (count) => set(s => ({
  associationNotifications: [...s.associationNotifications, { id: generateId(), count, timestamp: Date.now() }]
})),
dismissAssociationNotification: (id) => set(s => ({
  associationNotifications: s.associationNotifications.filter(n => n.id !== id)
})),
```

- [ ] **Step 2: Add floating notification in GraphCanvas**

In `src/renderer/canvas/GraphCanvas.tsx`, add after the zoom level indicator:

```tsx
const notifications = useGraphStore(s => s.associationNotifications)
const dismissNotification = useGraphStore(s => s.dismissAssociationNotification)

{notifications.length > 0 && (
  <Panel position="bottom-right">
    {notifications.map(n => (
      <div key={n.id} className="bg-primary/10 border border-primary/30 rounded-lg px-3 py-2 mb-2 flex items-center gap-2 cursor-pointer hover:bg-primary/20 transition-colors"
        onClick={() => dismissNotification(n.id)}>
        <GitBranch size={14} className="text-primary" />
        <span className="text-xs text-primary">Found {n.count} new association{n.count > 1 ? 's' : ''}</span>
        <X size={12} className="text-muted-foreground ml-2" />
      </div>
    ))}
  </Panel>
)}
```

Import `GitBranch` from lucide-react.

- [ ] **Step 3: Wire event in GraphSyncService**

In `src/main/services/graph-sync-service.ts`, when new suggested edges are created, emit an event. (This may already emit via EventBus — check and connect.)

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx src/renderer/store/graphStore.ts
git commit -m "feat(canvas): add floating association discovery notifications"
```

---

### Task 11: Suggested edge confirm button (4.1.1 partial)

**Files:**
- Modify: `src/renderer/canvas/BizEdge.tsx`

- [ ] **Step 1: Add confirm/reject buttons for suggested edges**

In `src/renderer/canvas/BizEdge.tsx`, after the edge label rendering, add buttons for suggested edges:

```tsx
const confirmSuggestedEdge = useGraphStore(s => s.confirmSuggestedEdge)
const rejectSuggestedEdge = useGraphStore(s => s.rejectSuggestedEdge)

// In the JSX, after the label:
{isSuggested && (
  <div className="nodrag nopan absolute -top-3 left-1/2 -translate-x-1/2 flex gap-0.5">
    <button
      onClick={(e) => { e.stopPropagation(); confirmSuggestedEdge?.(id) }}
      className="w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center hover:bg-green-600 shadow-sm"
      title="Confirm association"
    >
      <Plus size={10} />
    </button>
    <button
      onClick={(e) => { e.stopPropagation(); rejectSuggestedEdge?.(id) }}
      className="w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 shadow-sm"
      title="Reject association"
    >
      <X size={10} />
    </button>
  </div>
)}
```

Import `Plus` and `X` from lucide-react.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/canvas/BizEdge.tsx
git commit -m "feat(canvas): add confirm/reject buttons for suggested edges"
```

---

### Task 12: Schema validation in node:update IPC (4.2.2)

**Files:**
- Modify: `src/main/ipc/graph.ts`
- Modify: `src/main/memory/node-schema-registry.ts` (use existing)

- [ ] **Step 1: Add validateNodeMetadata import and call**

In `src/main/ipc/graph.ts`, in the `node:update` handler, before the database update, add:

```typescript
import { validateNodeMetadata } from '../memory/node-schema-registry'

// In node:update handler, before the update call:
let warnings: string[] = []
if (args.nodeType && args.metadata) {
  const validation = validateNodeMetadata(args.nodeType, args.metadata)
  warnings = validation.warnings ?? []
}

// After the update, include warnings in the response:
return { success: true, warnings }
```

- [ ] **Step 2: Ensure validateNodeMetadata returns warnings (not throws)**

Check that `validateNodeMetadata` in `node-schema-registry.ts` returns a result object with `warnings: string[]` instead of throwing. If it throws, wrap it:

```typescript
try {
  const validation = validateNodeMetadata(args.nodeType, args.metadata)
  warnings = validation.warnings ?? []
} catch (e) {
  warnings = [e instanceof Error ? e.message : String(e)]
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/graph.ts
git commit -m "feat(graph): add schema validation warnings to node:update IPC"
```

---

### Task 13: TreeView filter/sort (4.4.2)

**Files:**
- Modify: `src/renderer/panels/TreeView.tsx`

- [ ] **Step 1: Add filter and sort state**

In `src/renderer/panels/TreeView.tsx`, add state:

```tsx
import { useState, useMemo } from 'react'

const [statusFilter, setStatusFilter] = useState<string>('all')
const [typeFilter, setTypeFilter] = useState<string>('all')
const [sortBy, setSortBy] = useState<'name' | 'type' | 'status' | 'modified'>('name')
```

- [ ] **Step 2: Add filter/sort toolbar**

Add a toolbar above the tree:

```tsx
<div className="flex gap-1 px-2 py-1 border-b border-border text-[10px]">
  <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="bg-transparent border border-border rounded px-1 py-0.5">
    <option value="all">All Status</option>
    <option value="placeholder">Placeholder</option>
    <option value="developing">Developing</option>
    <option value="confirmed">Confirmed</option>
  </select>
  <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="bg-transparent border border-border rounded px-1 py-0.5">
    <option value="all">All Types</option>
    <option value="module">Module</option>
    <option value="process">Process</option>
    <option value="feature">Feature</option>
  </select>
  <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className="bg-transparent border border-border rounded px-1 py-0.5">
    <option value="name">Name</option>
    <option value="type">Type</option>
    <option value="status">Status</option>
    <option value="modified">Modified</option>
  </select>
</div>
```

- [ ] **Step 3: Apply filters and sort to tree data**

Use `useMemo` to filter and sort the tree nodes before rendering. This requires accessing the node data from the store (currently the tree is rendered via `useFileTreeStore` — may need to cross-reference with `useGraphStore` for status/type info).

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/panels/TreeView.tsx
git commit -m "feat(tree): add status/type filter and sort options to TreeView"
```

---

### Task 14: Request status tracking UI (5.3.2)

**Files:**
- Modify: `src/renderer/store/sessionStore.ts`
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

- [ ] **Step 1: Add requestStatuses to sessionStore**

In `src/renderer/store/sessionStore.ts`, add to the state:

```typescript
requestStatuses: Map<string, { requestId: string; status: 'queued' | 'executing' | 'done'; adapterName: string; enqueuedAt: number; startedAt?: number }>
```

And actions:

```typescript
addRequestStatus: (requestId, adapterName) => set(s => {
  const map = new Map(s.requestStatuses)
  map.set(requestId, { requestId, status: 'queued', adapterName, enqueuedAt: Date.now() })
  return { requestStatuses: map }
}),
updateRequestStatus: (requestId, status) => set(s => {
  const map = new Map(s.requestStatuses)
  const existing = map.get(requestId)
  if (existing) {
    map.set(requestId, { ...existing, status, startedAt: status === 'executing' ? Date.now() : existing.startedAt })
  }
  return { requestStatuses: map }
}),
removeRequestStatus: (requestId) => set(s => {
  const map = new Map(s.requestStatuses)
  map.delete(requestId)
  return { requestStatuses: map }
}),
```

- [ ] **Step 2: Add queue status indicator in AgentChatPanel**

In `AgentChatPanel.tsx`, add a small indicator above the chat input:

```tsx
const requestStatuses = useSessionStore(s => s.requestStatuses)
const queued = Array.from(requestStatuses.values()).filter(r => r.status === 'queued').length
const executing = Array.from(requestStatuses.values()).filter(r => r.status === 'executing').length

{(queued > 0 || executing > 0) && (
  <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-muted-foreground border-b border-border">
    {queued > 0 && <span>Queued: {queued}</span>}
    {executing > 0 && <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" />Executing: {executing}</span>}
  </div>
)}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/sessionStore.ts src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(agent): add request status tracking with queue indicator in chat panel"
```

---

### Task 15: Code block enhancements — language label + line numbers (7.3.1 partial)

**Files:**
- Modify: `src/renderer/components/agent/ChatBubble.tsx`

- [ ] **Step 1: Add language label and line numbers to CodeBlock**

In the `CodeBlock` component in `ChatBubble.tsx`, update:

```tsx
function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false)
  const lines = children.split('\n')
  const showLineNumbers = lines.length > 5

  return (
    <div className="relative group my-2 rounded-md overflow-hidden border border-border">
      <div className="flex items-center justify-between px-3 py-1 bg-muted/50 border-b border-border">
        <span className="text-[9px] text-muted-foreground font-mono">{language}</span>
        <button
          onClick={() => { navigator.clipboard.writeText(children); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
          className="text-[9px] text-muted-foreground hover:text-foreground"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div className="flex">
        {showLineNumbers && (
          <div className="select-none text-right pr-2 pl-2 text-[9px] text-muted-foreground/50 leading-[18px] bg-muted/30 border-r border-border">
            {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          </div>
        )}
        <SyntaxHighlighter language={language} PreTag="div" style={oneDark} customStyle={{ margin: 0, padding: '8px 12px', fontSize: '11px', background: 'transparent' }}>
          {children}
        </SyntaxHighlighter>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/ChatBubble.tsx
git commit -m "feat(chat): add language label, line numbers, and styled header to code blocks"
```

---

### Task 16: Chat input draft preservation (7.3.2)

**Files:**
- Modify: `src/renderer/components/agent/ChatInput.tsx`

- [ ] **Step 1: Add draft save/restore logic**

In `src/renderer/components/agent/ChatInput.tsx`, replace the simple `value` state with draft-aware logic:

```tsx
const DRAFT_KEY_PREFIX = 'bizgraph:draft:'

// Replace `const [value, setValue] = useState('')` with:
const [value, setValue] = useState(() => {
  if (threadId) {
    const saved = localStorage.getItem(`${DRAFT_KEY_PREFIX}${threadId}`)
    if (saved) return saved
  }
  return ''
})

// Add effect to save draft on change:
useEffect(() => {
  if (threadId && value) {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}${threadId}`, value)
  } else if (threadId && !value) {
    localStorage.removeItem(`${DRAFT_KEY_PREFIX}${threadId}`)
  }
}, [value, threadId])
```

- [ ] **Step 2: Clear draft on send**

In the `handleSend` function, after clearing the value, also clear localStorage:

```typescript
if (threadId) {
  localStorage.removeItem(`${DRAFT_KEY_PREFIX}${threadId}`)
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/ChatInput.tsx
git commit -m "feat(chat): preserve input drafts per thread in localStorage"
```

---

## Batch C: Polish & Animation (Domain 7) — Visual tasks

### Task 17: Connection feedback animation (7.2.2)

**Files:**
- Modify: `src/renderer/canvas/BizEdge.tsx`
- Modify: `src/renderer/index.css`

- [ ] **Step 1: Add breathing animation keyframe**

In `src/renderer/index.css`, add:

```css
@keyframes breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.animate-breathe {
  animation: breathe 1.5s ease-in-out infinite;
}

@keyframes flash-once {
  0% { filter: brightness(1); }
  50% { filter: brightness(1.8); }
  100% { filter: brightness(1); }
}
.animate-flash-once {
  animation: flash-once 100ms ease-out;
}
```

- [ ] **Step 2: Apply breathing to connection target**

This requires ReactFlow's `onConnectStart`/`onConnectEnd` events. In `GraphCanvas.tsx`, track connection mode state and pass a `isConnecting` flag to nodes. When a node is a connection target (being hovered during drag), add the `animate-breathe` class.

This is a cross-cutting change. The simplest approach: in `BizNode.tsx`, add a CSS class when the node is being connected to:

```tsx
// In BizNode, detect if we're in connection mode and this node is hovered:
const connectingTo = useGraphStore(s => s.connectingTo)
const isConnectionTarget = connectingTo === data.id
```

Add to the outer container:

```tsx
${isConnectionTarget ? 'animate-breathe' : ''}
```

For the flash-once, add a state that triggers on successful connection and auto-clears.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/BizEdge.tsx src/renderer/canvas/BizNode.tsx src/renderer/canvas/GraphCanvas.tsx src/renderer/index.css
git commit -m "feat(canvas): add breathing animation on connection target and flash on connect"
```

---

### Task 18: Dark mode contrast audit fix (7.4.1)

**Files:**
- Modify: `src/renderer/index.css`

- [ ] **Step 1: Audit and fix dark mode contrast**

In `src/renderer/index.css`, under `.dark`, ensure these key color pairs meet WCAG AA 4.5:1:

- Node text: `--foreground` vs `--card` background → verify `hsl(var(--foreground))` on `hsl(var(--card))`
- Edge labels: amber/dim text on dark canvas
- Code block text: `oneDark` theme contrast

Fix by adjusting the dark mode variables. Common fixes:

```css
.dark {
  --foreground: 0 0% 95%;        /* was maybe 0 0% 90% → increase to 95% */
  --muted-foreground: 0 0% 70%;  /* was maybe 0 0% 63% → increase to 70% */
  --card: 0 0% 12%;              /* keep dark enough for contrast */
}
```

Test with a contrast checker tool. This is a manual audit + fix step.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/index.css
git commit -m "fix(theme): improve dark mode contrast ratios to meet WCAG AA 4.5:1"
```

---

### Task 19: Degradation notification UI enhancement (5.2.2 partial)

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

- [ ] **Step 1: Add "Switch adapter" button and green flash**

In the degradation banner section of `AgentChatPanel.tsx`, add a switch button:

```tsx
{/* After existing degradation banner text */}
<button
  onClick={() => {/* Open adapter selector */}}
  className="text-[10px] px-2 py-0.5 rounded border border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
>
  Switch adapter
</button>
```

Add auto-recovery green flash:

```tsx
const [recoveredFlash, setRecoveredFlash] = useState(false)

// When adapter recovers (listen to adapter status changes):
useEffect(() => {
  if (/* adapter just recovered */) {
    setRecoveredFlash(true)
    setTimeout(() => setRecoveredFlash(false), 2000)
  }
}, [/* relevant state */])

{recoveredFlash && (
  <div className="bg-green-100 dark:bg-green-900 border border-green-300 dark:border-green-700 rounded px-3 py-1 text-xs text-green-700 dark:text-green-300 animate-fade-out-3s">
    Adapter recovered
  </div>
)}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(agent): add switch adapter button and auto-recovery flash to degradation banner"
```

---

### Task 20: Virtual scrolling for TreeView (7.1.1)

**Files:**
- Modify: `src/renderer/panels/TreeView.tsx`
- Modify: `package.json`

- [ ] **Step 1: Install @tanstack/react-virtual**

Run: `npm install @tanstack/react-virtual`

- [ ] **Step 2: Implement virtual scrolling in TreeView**

In `src/renderer/panels/TreeView.tsx`, use `useVirtualizer` for the tree when nodes exceed 100:

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'

// Inside the component:
const allNodes = useMemo(() => flattenTree(projects), [projects])
const shouldVirtualize = allNodes.length > 100

const parentRef = useRef<HTMLDivElement>(null)
const virtualizer = useVirtualizer({
  count: allNodes.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 32,
  enabled: shouldVirtualize,
})

// Render:
<div ref={parentRef} className="h-full overflow-auto">
  {shouldVirtualize ? (
    <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
      {virtualizer.getVirtualItems().map(vItem => {
        const node = allNodes[vItem.index]
        return (
          <div key={node.id} style={{ position: 'absolute', top: vItem.start, height: vItem.size, width: '100%' }}>
            <TreeNodeItem node={node} depth={node.depth} />
          </div>
        )
      })}
    </div>
  ) : (
    projects.map(p => <TreeNodeItem key={p.path} node={p} depth={0} />)
  )}
</div>
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/panels/TreeView.tsx package.json package-lock.json
git commit -m "feat(tree): add virtual scrolling for large trees using @tanstack/react-virtual"
```

---

### Task 21: Bundle analysis setup (7.1.4)

**Files:**
- Modify: `vite.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install rollup-plugin-visualizer**

Run: `npm install -D rollup-plugin-visualizer`

- [ ] **Step 2: Add conditional plugin to vite.config.ts**

In `vite.config.ts`, import and conditionally add:

```typescript
import { visualizer } from 'rollup-plugin-visualizer'

// In the plugins array:
...(process.env.BUILD_ANALYZE === 'true' ? [
  visualizer({
    open: true,
    filename: 'dist/stats.html',
    gzipSize: true,
    brotliSize: true,
  })
] : []),
```

- [ ] **Step 3: Test**

Run: `BUILD_ANALYZE=true npm run build`
Expected: Opens browser with bundle visualization

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts package.json package-lock.json
git commit -m "feat(build): add rollup-plugin-visualizer for bundle analysis (BUILD_ANALYZE=true)"
```

---

### Task 22: SELECT * optimization (8.3.3 partial)

**Files:**
- Modify: `src/main/repositories/chat-repository.ts`

- [ ] **Step 1: Replace SELECT * with column names in chat-repository**

In `src/main/repositories/chat-repository.ts`, find all `SELECT * FROM` queries and replace with explicit columns:

For `chat_threads`:
```sql
SELECT id, title, project_id, status, created_at, updated_at FROM chat_threads
```

For `chat_messages`:
```sql
SELECT id, thread_id, role, content, status, created_at FROM chat_messages
```

- [ ] **Step 2: Verify index exists**

The index `idx_chat_messages_thread_id` already exists. Verify by checking `database.ts`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/main/__tests__/chat-service.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/repositories/chat-repository.ts
git commit -m "perf(db): replace SELECT * with explicit column names in chat queries"
```

---

### Task 23: HistorySidebar setState cleanup (3.1.3 partial)

**Files:**
- Modify: `src/renderer/components/agent/HistorySidebar.tsx`

- [ ] **Step 1: Replace direct setState with store action**

In `src/renderer/components/agent/HistorySidebar.tsx`, find any `useAgentStore.setState(...)` calls and replace with the corresponding store action method.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/HistorySidebar.tsx
git commit -m "refactor: replace direct setState with store action in HistorySidebar"
```

---

### Task 24: NODE_STATUS_CHANGE event (2.4.1 partial)

**Files:**
- Modify: `src/main/agent/agent-manager.ts`
- Modify: `src/renderer/store/eventBus.ts`

- [ ] **Step 1: Add NODE_STATUS_CHANGE event**

In `src/renderer/store/eventBus.ts`, add to the events:

```typescript
NODE_STATUS_CHANGE: { nodeId: string; oldStatus: string; newStatus: string }
```

- [ ] **Step 2: Emit event in agent-manager**

In `src/main/agent/agent-manager.ts`, after the status update in `startSession()`, emit the event:

```typescript
if (currentStatus === 'placeholder') {
  await nodeRepo.update(config.nodeId, { status: 'developing' })
  // Emit event for renderer
  this.mainWindow?.webContents.send('event:NODE_STATUS_CHANGE', {
    nodeId: config.nodeId,
    oldStatus: 'placeholder',
    newStatus: 'developing'
  })
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/main/agent/agent-manager.ts src/renderer/store/eventBus.ts
git commit -m "feat(agent): emit NODE_STATUS_CHANGE event on placeholder→developing transition"
```

---

## Execution Order

**Parallel Batch A** (no file conflicts, backend-only):
- Task 1 (entity-extractor positions)
- Task 2 (scope compression)
- Task 3 (health-driven degradation)
- Task 22 (SELECT * optimization)
- Task 24 (NODE_STATUS_CHANGE event)

**Parallel Batch B** (frontend components, minimal file overlap):
- Task 4 (message status icons) — ChatBubble.tsx + agent.ts
- Task 5 (output folding) — ChatBubble.tsx (conflicts with Task 4, run sequentially after)
- Task 6 (confirmation dialog) — new file + AgentChatPanel.tsx
- Task 7 (risk level refinement) — useAgentOutputListener.ts
- Task 8 (preview node styling) — BizNode.tsx
- Task 9 (progress overlay) — CanvasOverlay.tsx + GraphCanvas.tsx
- Task 10 (association notification) — GraphCanvas.tsx + graphStore.ts
- Task 11 (suggested edge buttons) — BizEdge.tsx
- Task 12 (schema validation) — graph.ts
- Task 13 (TreeView filter) — TreeView.tsx
- Task 14 (request status UI) — sessionStore.ts + AgentChatPanel.tsx
- Task 15 (code block enhancements) — ChatBubble.tsx (after Task 5)
- Task 16 (draft preservation) — ChatInput.tsx
- Task 23 (HistorySidebar cleanup) — HistorySidebar.tsx

**Sequential Batch C** (visual/animation, test manually):
- Task 17 (connection animation)
- Task 18 (dark mode contrast)
- Task 19 (degradation UI)
- Task 20 (virtual scrolling — needs npm install)
- Task 21 (bundle analysis — needs npm install)
