# AgentChat Enhancement & Mind Map Closed-Loop Design

**Date**: 2026-06-05
**Status**: Approved
**Scope**: Enhance AgentChat rendering, establish bidirectional Agent-MindMap sync, add Diff review workflow, and close the acceptance verification loop.

## Goals

1. **Chat Rendering Enhancement** — Markdown formatting, streaming ToolCall parsing, structured status display
2. **Node-Agent Status Sync** — Bidirectional state synchronization, activity indicators, change file highlights
3. **Diff Review + Commit Workflow** — Per-file diff review, Accept/Reject, commit and status update
4. **Acceptance Criteria Verification** — Auto-verify against criteria, verification report, auto-retry

## Current State

### What Exists
- AgentChatPanel with thread management, streaming output, slash commands, @mentions, context references
- `handleStartDev`: generates dev prompt from node → pushes to AgentChat (one-way: Map → Chat)
- `AgentSessionConfig`: injects node title, rules, acceptance criteria, allowed files into Agent prompt
- `ScopeGuard`: file change boundary enforcement (sandbox, backup, rollback)
- `ToolCallRenderer`: basic file_edit/diff/terminal/file_create display (Accept/Reject buttons unwired)
- NDJSON protocol support in `JsonProtocolHandler` for structured Agent communication

### Key Gaps
- AgentChatPanel streams `AgentOutput` but treats `file_change` as plain text — no ToolCall construction
- No markdown rendering for Agent messages (plain `whitespace-pre-wrap`)
- Agent completion does not update node status on the mind map
- No visual indicator on nodes showing Agent activity
- Accept/Reject buttons in ToolCallRenderer are not connected to any logic
- No post-Agent verification against acceptance criteria
- No Diff review panel for aggregated file changes

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Renderer Process                       │
│                                                          │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────┐ │
│  │ GraphCanvas  │◄──►│  agentStore  │◄──►│ AgentChat   │ │
│  │ (ReactFlow)  │    │              │    │   Panel     │ │
│  │              │    │  - threads   │    │             │ │
│  │  BizNode     │    │  - outputs   │    │ ChatBubble  │ │
│  │  └ indicators│    │  - fileChanges│   │ ToolCallRdr │ │
│  │  └ changeBadge│   │              │    │ DiffReview  │ │
│  └──────┬───────┘    └──────┬───────┘    │ VerifyPanel │ │
│         │                   │            └──────┬──────┘ │
│         │    IPC: graph:nodeStatusUpdate        │        │
│         │    IPC: agent:statusChanged           │        │
│         │    IPC: agent:fileChanges             │        │
├─────────┼───────────────────┼────────────────────┼────────┤
│         │    Main Process   │                    │        │
│  ┌──────┴───────┐    ┌──────┴───────┐    ┌──────┴──────┐ │
│  │ NodeService  │    │ AgentManager │    │ ScopeGuard  │ │
│  │              │    │              │    │             │ │
│  │ updateStatus │    │ onStatusChg  │    │ commitChanges│ │
│  └──────────────┘    │ onFileChange │    │ rollback    │ │
│                      └──────────────┘    └─────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Phase 1: Chat Rendering Enhancement

### 1.1 Markdown Rendering

**Dependencies**: `react-markdown`, `remark-gfm`, `react-syntax-highlighter`

**Changes to `ChatBubble.tsx`**:
- Replace the plain text `<div className="whitespace-pre-wrap break-words">{message.content}</div>` with `<ReactMarkdown>` for Agent messages
- User messages remain plain text (no markdown rendering)
- Code blocks rendered via `react-syntax-highlighter` with a copy button overlay
- Support: headers (h1-h4), bold, italic, ordered/unordered lists, inline code, fenced code blocks, tables, links, blockquotes
- Streaming messages (status `streaming`) also render as markdown — ReactMarkdown handles incomplete input gracefully

**Code block rendering**:
```tsx
// Inside ReactMarkdown components override
code({ node, className, children, ...props }) {
  const match = /language-(\w+)/.exec(className || '')
  const isBlock = // detect block vs inline
  if (isBlock) {
    return (
      <div className="relative group">
        <SyntaxHighlighter language={match?.[1]} style={theme}>
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
        <CopyButton />
      </div>
    )
  }
  return <code className={className} {...props}>{children}</code>
}
```

### 1.2 Streaming ToolCall Parsing

**Current problem**: `AgentChatPanel.tsx` lines 151-188 handle `file_change` outputs by concatenating them as text into the streaming message content. ToolCallRenderer exists but `ChatMessage.toolCalls` is never populated during streaming.

**Solution**:

In `AgentChatPanel.tsx` output handler, when `output.type === 'file_change'`:
1. Construct a `ToolCallBlock` from the output:
   ```ts
   const toolCall: ToolCallBlock = {
     type: output.changeType === 'add' ? 'file_create' : 'file_edit',
     filePath: output.filePath,
     content: output.data,
     status: 'done',
   }
   ```
2. Append to the streaming message's `toolCalls` array (not to `content`)
3. When streaming completes, persist `toolCalls` with the message

When `output.type === 'stdout'` and content matches diff patterns (lines starting with `+`/`-`), attach to the most recent `file_edit` ToolCallBlock's content.

**Store changes** (`agentStore.ts`):
- Add `appendToolCall(threadId, messageId, toolCall)` action
- Modify `sendMessage` to initialize `toolCalls: []` on the streaming message

### 1.3 Structured Status Indicator

**Enhance `RunningIndicator`** in `ChatBubble.tsx`:
- Show current operation extracted from the latest `file_change` output
- Display as: `{adapterName} is editing {filename}...`
- When no file_change output yet, show generic: `{adapterName} is working...`

**New component `OperationStatus`**:
- Renders below the running indicator
- Shows a timeline of recent operations: "Edited UserService.ts → Running tests..."
- Data source: `agentStore.threadOutputs` filtered for `file_change` type

### Phase 1 File Changes

| File | Action |
|------|--------|
| `src/renderer/components/agent/ChatBubble.tsx` | Replace plain text with ReactMarkdown, enhance RunningIndicator |
| `src/renderer/components/agent/ToolCallRenderer.tsx` | Wire Accept/Reject buttons (stub handlers for now) |
| `src/renderer/components/agent/AgentChatPanel.tsx` | Parse file_change into ToolCallBlock, append to message |
| `src/renderer/store/agentStore.ts` | Add appendToolCall action |
| `src/shared/types.ts` | (no changes needed, ToolCallBlock already defined) |

### Phase 1 New Dependencies

```json
{
  "react-markdown": "^9.0.0",
  "remark-gfm": "^4.0.0",
  "react-syntax-highlighter": "^15.5.0",
  "@types/react-syntax-highlighter": "^15.5.0"
}
```

## Phase 2: Node-Agent Status Sync

### 2.1 Bidirectional State Synchronization

**Agent → Node mapping**:

| AgentThread.status | NodeStatus | Trigger |
|---|---|---|
| `running` | `developing` | AgentManager.startSession() |
| `idle` (after success) | `testing` | AgentManager.terminateSession() with ScopeGuard pass |
| `error` | `developing` (unchanged) | Agent crash/error exit |
| `idle` (after review) | `review` | Diff review all accepted (P3) |

**Implementation**:

1. **New IPC channel**: `graph:updateNodeStatus(nodeId: string, status: NodeStatus)`
   - Registered in `src/main/ipc/graph.ts`
   - Calls `NodeService.updateNode()` to persist

2. **AgentManager hooks**:
   - In `startSession()` (agent-manager.ts line 203): after session starts, if `config` has a node binding, call `graph:updateNodeStatus(nodeId, 'developing')`
   - In `terminateSession()` (line 275): after ScopeGuard commit, call `graph:updateNodeStatus(nodeId, 'testing')`
   - On abnormal exit (cleanupSessionResources): no status change (keep `developing` as anomaly marker)

3. **Renderer-side sync**:
   - `agentStore` listens for `agent:statusChanged` IPC events (new event emitted by AgentManager via OutputBroadcaster when node status changes)
   - On status change, calls `graphStore.updateNode()` to update the node's status
   - This triggers ReactFlow re-render, updating BizNode visual

**Node → Agent** (user-initiated):
- When user manually changes a node's status from `developing` to anything else via the node context menu, check if there's an active AgentThread bound to that node
- If yes, show confirmation: "This node has an active Agent session. Changing status will terminate it."
- On confirm: terminate the Agent session and update status

### 2.2 Node Activity Indicators

**Enhance `BizNodeComponent`** (`src/renderer/canvas/BizNode.tsx`):

1. **Running state**: When `agentStore.threads` has a thread with `nodeBound === node.id` and `status === 'running'`:
   - Node border: `border-2 border-orange-400 animate-pulse`
   - Top-right badge: small `Loader2` icon with spin animation
   - Hover tooltip: current operation from latest `file_change` output

2. **Error state**: When thread `status === 'error'`:
   - Node border: `border-2 border-red-400`
   - Top-right badge: `AlertTriangle` icon
   - Hover tooltip: error message

3. **Completed state**: When thread `status === 'idle'` and was recently running:
   - Node border: `border-2 border-green-400` (fades after 3s via CSS transition)
   - Top-right badge: `Check` icon (fades after 3s)

**Data flow**:
- `BizNodeComponent` reads `agentStore.threads` via selector
- Filter threads by `nodeBound === node.id` to find associated thread
- Derive visual state from thread status

### 2.3 Change Summary Badge

**New component `ChangeSummaryBadge`**:
- Positioned below the BizNode when there are associated file changes
- Shows: `{N} files changed` with expand/collapse
- Expanded: list of changed file paths, clickable to open in external editor
- Data source: `agentStore.threadOutputs` filtered for `file_change` by the node's bound thread

### Phase 2 File Changes

| File | Action |
|------|--------|
| `src/main/agent/agent-manager.ts` | Add status change hooks in startSession/terminateSession |
| `src/main/ipc/graph.ts` | Register `graph:updateNodeStatus` IPC handler |
| `src/renderer/canvas/BizNode.tsx` | Add activity indicators (pulse, badges, tooltips) |
| `src/renderer/store/agentStore.ts` | Add status change listener, derive thread-node mapping |
| `src/renderer/store/graphStore.ts` | Expose updateNodeStatus for IPC-triggered updates |
| `src/renderer/canvas/ChangeSummaryBadge.tsx` | New component for file change summary |

## Phase 3: Diff Review + Commit Workflow

### 3.1 Diff Review Panel

**New component `DiffReviewPanel`** (`src/renderer/components/agent/DiffReviewPanel.tsx`):

- Triggered by "Review Changes" button that appears in AgentChatPanel when:
  - Current thread has `file_change` outputs
  - Thread status is `idle` (Agent completed)
- Layout:
  - Header: "Changes ({N} files)" with Accept All / Reject All buttons
  - File list: each file shows name, +/- line count, accept/reject status
  - Clicking a file expands inline unified diff view
  - Bottom: "Commit" button (enabled only when all files reviewed)

**Diff rendering**:
- Use `react-diff-viewer-continued` or a custom unified diff renderer
- Parse `ToolCallBlock.content` (which contains diff text from Agent output)
- Color: green for additions, red for deletions, with syntax highlighting

### 3.2 Accept/Reject Logic

**Accept per file**:
```ts
handleAcceptFile(fileIndex: number) => {
  // Mark ToolCallBlock.accepted = true
  // Update DiffReviewPanel state
  // If all files accepted, enable Commit button
}
```

**Reject per file**:
```ts
handleRejectFile(fileIndex: number, filePath: string) => {
  // Call IPC: scopeGuard:rollbackFile(sessionId, filePath)
  // Main process restores file from backup
  // Mark ToolCallBlock.accepted = false
  // Update DiffReviewPanel state
}
```

**Accept All**:
- Mark all ToolCallBlocks as accepted
- Enable Commit button

**Reject All**:
- Rollback all files via ScopeGuard
- Mark all as rejected
- Node status stays `developing`
- Offer "Retry" to resend the task to Agent

### 3.3 Commit Flow

When "Commit" is clicked:
1. Call `ScopeGuard.commitChanges(sandbox)` to validate all changes are within scope
2. If validation passes:
   - Optionally `git add` + `git commit` with auto-generated message
   - Update node status: `developing` → `testing`
   - Mark AgentThread as `reviewed` (requires extending `AgentThread.status` type to include `'reviewed'` in `src/shared/types.ts`)
   - Close DiffReviewPanel
   - Show success toast
3. If validation fails (ScopeGuardError):
   - Show which files are out of bounds
   - Offer to review those files individually

### 3.4 New IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `scopeGuard:rollbackFile` | Renderer → Main | Rollback a single file from sandbox backup |
| `scopeGuard:commitSession` | Renderer → Main | Commit all changes for a session |
| `git:autoCommit` | Renderer → Main | Auto-commit accepted changes |

### Phase 3 File Changes

| File | Action |
|------|--------|
| `src/renderer/components/agent/DiffReviewPanel.tsx` | New: full diff review UI |
| `src/renderer/components/agent/AgentChatPanel.tsx` | Add "Review Changes" button, integrate DiffReviewPanel |
| `src/renderer/components/agent/ToolCallRenderer.tsx` | Wire Accept/Reject to DiffReviewPanel state |
| `src/main/ipc/scope-guard.ts` | New: rollbackFile, commitSession IPC handlers |
| `src/main/scope-guard.ts` | Add rollbackFile(filePath) method |
| `src/renderer/store/agentStore.ts` | Add review state tracking |
| `src/renderer/components/agent/ChatBubble.tsx` | Show "Review pending" badge when changes exist |

## Phase 4: Acceptance Criteria Verification

### 4.1 Auto-Verification Trigger

After Diff Review commit (Phase 3), if the node has `acceptanceCriteria`:
1. Collect verification inputs:
   - Node's `acceptanceCriteria` array
   - Agent's full conversation (messages from thread)
   - File change summary (which files changed, what type)
2. Construct verification prompt via `buildVerificationPrompt()`:
   ```
   You are a QA reviewer. Evaluate whether the implementation meets each acceptance criterion.

   ## Acceptance Criteria
   1. {criterion_1}
   2. {criterion_2}
   ...

   ## Implementation Summary
   {agent conversation summary}
   ## Changed Files
   {file change list}

   For each criterion, respond with:
   - PASS or FAIL
   - Brief justification (1-2 sentences)
   ```
3. Send via AgentManager using the same adapter (or MCP fallback)

### 4.2 Verification Report

**New component `VerificationPanel`** (`src/renderer/components/agent/VerificationPanel.tsx`):

- Triggered automatically after commit, or manually via "Verify" button
- Parses Agent's structured response to extract per-criterion results
- Display:
  - Header: "Verification Report — {N}/{M} passed"
  - Per criterion: ✅/❌ + criterion text + Agent's justification
  - Failed items: "Auto-fix" button + "Skip" button
- Bottom actions:
  - "Retry Failed" — send only failed criteria back to Agent
  - "Mark Complete" — manually approve despite failures
  - "Back to Edit" — return to chat for manual fixes

### 4.3 Auto-Retry Mechanism

When "Retry Failed" or per-criterion "Auto-fix" is clicked:
1. Collect only failed criteria + their justification
2. Construct retry prompt: "Fix the following unmet criteria: {criteria} with context: {justification}"
3. Send to Agent (reuses existing thread)
4. After Agent completes: re-run Diff Review (Phase 3) for the new changes
5. After commit: re-run verification
6. Max 2 retries per verification cycle; beyond that, prompt user for manual intervention

### 4.4 Final Status Update

- All criteria pass → Node status: `testing` → `review`
- User clicks "Mark Complete" → Node status: `testing` → `review`
- User manually confirms in node context menu → `review` → `published`
- Max retries exceeded with failures → Node stays `testing`, displays failure badge

### Phase 4 File Changes

| File | Action |
|------|--------|
| `src/renderer/components/agent/VerificationPanel.tsx` | New: verification report UI |
| `src/renderer/components/agent/AgentChatPanel.tsx` | Integrate VerificationPanel after commit |
| `src/main/agent/verification-service.ts` | New: build verification prompt, parse results |
| `src/main/ipc/agent.ts` | Add `agent:verify` IPC handler |
| `src/renderer/store/agentStore.ts` | Add verification state, retry logic |
| `src/renderer/canvas/BizNode.tsx` | Add verification status badges |

## Complete Closed-Loop Flow

```
User selects node on mind map
        │
        ▼
handleStartDev() generates prompt ──────────────┐
        │                                        │
        ▼                                        ▼
AgentChat receives prompt              NodeStatus → 'developing'
        │                              (Phase 2: agent-manager hook)
        ▼
Agent executes, streams output
  - stdout → ChatBubble (Markdown)     (Phase 1)
  - file_change → ToolCallBlocks        (Phase 1)
  - Node shows activity indicator       (Phase 2)
        │
        ▼
Agent completes
        │
        ▼
"Review Changes" button appears
        │
        ▼
DiffReviewPanel opens                  (Phase 3)
  - Per-file diff review
  - Accept / Reject each file
        │
        ▼
All accepted → "Commit" button
        │
        ▼
ScopeGuard validates → git commit      (Phase 3)
NodeStatus → 'testing'                 (Phase 2)
        │
        ▼
VerificationPanel auto-triggered       (Phase 4)
  - Compare against acceptance criteria
  - Show pass/fail per criterion
        │
        ├── All pass → NodeStatus → 'review'
        │
        └── Some fail → Auto-fix retry (max 2x)
                │
                ▼
            Re-execute Agent → Diff Review → Re-verify
```

## Shared Type Changes

No new types needed in `src/shared/types.ts` — all required types already exist:
- `ToolCallBlock` (with `accepted` field)
- `NodeStatus` (includes all needed states)
- `AgentOutput` (includes `file_change` type)
- `ChatMessage` (includes `toolCalls` field)

One optional addition for Phase 4:
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

## Testing Strategy

- **Unit tests**: Each new store action, each new IPC handler, verification prompt builder
- **Component tests**: ChatBubble markdown rendering, ToolCallRenderer accept/reject, DiffReviewPanel file list
- **Integration tests**: Full flow from handleStartDev through verification (mock Agent output)
- **E2E tests**: Manual verification of visual indicators on mind map

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Markdown rendering breaks streaming display | Use `skipHtml` option, test with incomplete markdown |
| ToolCall parsing produces false positives | Leverage existing `parseFileChanges` regex guards in BaseAdapter |
| ScopeGuard rollback fails for modified files | Keep original backup until explicit user confirmation |
| Verification prompt produces unparseable response | Use structured output format with regex fallback |
| Node status race conditions (user + Agent both updating) | Use optimistic locking with updatedAt timestamp |
