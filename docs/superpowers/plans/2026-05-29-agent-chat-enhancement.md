# Agent Chat 集成增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add message lifecycle status, stop/cancel, retry, and proper error display to the Agent Chat panel.

**Architecture:** Extend `ChatMessage` with a `status` field (pending/streaming/success/error/aborted) and an `error` field. Wire the store's existing `terminateSession` to a new Stop button in `ChatInput`. Rewrite the `onAgentOutput` handler to create/update agent messages with proper status transitions instead of silently swallowing errors. Add hover-visible action buttons (Retry/Copy) to each agent `ChatBubble`.

**Tech Stack:** React, Zustand, Tailwind CSS, lucide-react, Vitest

---

### Task 1: Extend shared types

**Files:**
- Modify: `src/shared/types.ts:168-216`

- [ ] **Step 1: Add MessageStatus and MessageError types, extend ChatMessage and AgentThread**

Open `src/shared/types.ts` and replace lines 168-216 with:

```typescript
/** Agent 输出 */
export interface AgentOutput {
  type: 'stdout' | 'stderr' | 'file_change' | 'error' | 'complete'
  data: string
  timestamp: number
  /** 如果是 file_change，记录变更的文件路径 */
  filePath?: string
  /** 如果是 file_change，记录变更类型 */
  changeType?: 'add' | 'modify' | 'delete'
  /** 错误分类码 */
  errorCode?: string
}

/** 上下文引用（节点或文件） */
export interface ContextRef {
  type: 'node' | 'file'
  id: string
  label: string
}

/** 工具调用块（嵌入 Agent 消息中） */
export interface ToolCallBlock {
  type: 'file_edit' | 'diff' | 'terminal' | 'file_create'
  filePath?: string
  content: string
  status: 'running' | 'done' | 'error'
  accepted?: boolean
}

/** 消息状态 */
export type MessageStatus =
  | 'pending'     // 用户消息刚发出，等待 agent 响应
  | 'streaming'   // agent 正在输出
  | 'success'     // agent 正常完成
  | 'error'       // 出错
  | 'aborted'     // 用户主动终止

/** 消息错误信息 */
export interface MessageError {
  code: string       // 错误码，如 AGENT_CRASH、SESSION_START_FAILED 等
  message: string    // 用户可读的错误描述
  raw?: string       // 原始错误数据（可选，用于调试）
}

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  timestamp: number
  adapterName?: string
  toolCalls?: ToolCallBlock[]
  contextRefs?: ContextRef[]
  status: MessageStatus
  error?: MessageError
  sessionId?: string
}

/** Agent 会话线程 */
export interface AgentThread {
  id: string
  title: string
  adapterName: string
  messages: ChatMessage[]
  contextRefs: ContextRef[]
  status: 'idle' | 'running' | 'error'
  createdAt: number
  nodeBound?: string
  sessionId?: string
}
```

- [ ] **Step 2: Run type check to verify no compilation errors**

Run: `npx tsc --noEmit`
Expected: The type check will fail because existing code creates `ChatMessage` objects without the new `status` field. This is expected — subsequent tasks fix each call site.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add MessageStatus, MessageError and extend ChatMessage/AgentThread"
```

---

### Task 2: Store — markMessageStatus and appendChatMessage defaults

**Files:**
- Modify: `src/renderer/store/agentStore.ts`
- Modify: `src/renderer/store/__tests__/agentStore.test.ts`

- [ ] **Step 1: Fix existing tests to supply the new required `status` field**

After Task 1, `ChatMessage` requires `status`. The existing test `appendChatMessage adds message to the correct thread` (line 63-73) creates a message without `status` and will fail TypeScript compilation. Fix it:

In `src/renderer/store/__tests__/agentStore.test.ts`, replace the `appendChatMessage` call at line 65-69:

```typescript
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'pending',
    })
```

- [ ] **Step 2: Write tests for markMessageStatus and appendChatMessage default status**

In `src/renderer/store/__tests__/agentStore.test.ts`, add the following tests **inside** the existing `describe('agentStore threads', ...)` block, after the last existing `it(...)`:

```typescript
  it('appendChatMessage sets status to pending for user messages', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-user',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'pending',
    })
    expect(useAgentStore.getState().threads[0].messages[0].status).toBe('pending')
  })

  it('appendChatMessage sets status to streaming for agent messages', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-agent',
      role: 'agent',
      content: 'Response',
      timestamp: Date.now(),
      status: 'streaming',
    })
    expect(useAgentStore.getState().threads[0].messages[0].status).toBe('streaming')
  })

  it('markMessageStatus updates a specific message status', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-1',
      role: 'agent',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useAgentStore.getState().markMessageStatus(id, 'msg-1', 'success')
    expect(useAgentStore.getState().threads[0].messages[0].status).toBe('success')
  })

  it('markMessageStatus sets error with MessageError object', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-err',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useAgentStore.getState().markMessageStatus(id, 'msg-err', 'error', {
      code: 'AGENT_CRASH',
      message: 'Process crashed',
    })
    const msg = useAgentStore.getState().threads[0].messages[0]
    expect(msg.status).toBe('error')
    expect(msg.error?.code).toBe('AGENT_CRASH')
    expect(msg.error?.message).toBe('Process crashed')
  })

  it('markMessageStatus is a no-op for non-existent message', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-1',
      role: 'agent',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useAgentStore.getState().markMessageStatus(id, 'non-existent', 'error')
    expect(useAgentStore.getState().threads[0].messages[0].status).toBe('streaming')
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/renderer/store/__tests__/agentStore.test.ts`
Expected: FAIL — `markMessageStatus` does not exist on the store.

- [ ] **Step 4: Add markMessageStatus to the store interface and implementation**

In `src/renderer/store/agentStore.ts`, add to the `AgentState` interface (after line 39, before the closing `}`):

```typescript
  markMessageStatus: (threadId: string, messageId: string, status: MessageStatus, error?: MessageError) => void
```

Add the import for the new types. Replace line 2:

```typescript
import type { AgentOutput, AgentSessionConfig, AgentCommand, ChatMessage, AgentThread, ContextRef, MessageStatus, MessageError } from '@shared/types'
```

Add the implementation after `updateThreadStatus` (after line 215):

```typescript
  markMessageStatus: (threadId, messageId, status, error) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? { ...m, status, ...(error ? { error } : { error: undefined }) }
                  : m,
              ),
            }
          : t,
      ),
    }))
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/store/__tests__/agentStore.test.ts`
Expected: All tests PASS (including existing tests — `appendChatMessage` tests pass because callers now supply `status` explicitly).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/agentStore.ts src/renderer/store/__tests__/agentStore.test.ts
git commit -m "feat(store): add markMessageStatus method"
```

---

### Task 3: Store — stopCurrentSession and retryMessage

**Files:**
- Modify: `src/renderer/store/agentStore.ts`
- Modify: `src/renderer/store/__tests__/agentStore.test.ts`

- [ ] **Step 1: Write tests for stopCurrentSession**

In `src/renderer/store/__tests__/agentStore.test.ts`, add inside the `describe` block:

```typescript
  it('stopCurrentSession terminates session and marks streaming message as aborted', async () => {
    const threadId = useAgentStore.getState().createThread('claude-code')
    // Simulate an active session
    useAgentStore.setState({
      sessions: [{
        id: 'sess-1',
        adapterName: 'claude-code',
        nodeId: 'node-1',
        status: 'running',
        outputs: [],
        startTime: Date.now(),
      }],
    })
    useAgentStore.getState().updateThreadStatus(threadId, 'running')
    // Record sessionId on thread
    useAgentStore.setState({
      threads: useAgentStore.getState().threads.map((t) =>
        t.id === threadId ? { ...t, sessionId: 'sess-1' } : t,
      ),
    })
    // Add a streaming agent message
    useAgentStore.getState().appendChatMessage(threadId, {
      id: 'agent-msg-1',
      role: 'agent',
      content: 'partial output',
      timestamp: Date.now(),
      status: 'streaming',
      sessionId: 'sess-1',
    })

    await useAgentStore.getState().stopCurrentSession(threadId)

    const thread = useAgentStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.status).toBe('idle')
    expect(thread.messages[0].status).toBe('aborted')
    expect(thread.messages[0].content).toBe('partial output') // content preserved
  })

  it('stopCurrentSession is a no-op when thread has no sessionId', async () => {
    const threadId = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().updateThreadStatus(threadId, 'running')

    await useAgentStore.getState().stopCurrentSession(threadId)

    expect(useAgentStore.getState().threads[0].status).toBe('running') // unchanged
  })
```

- [ ] **Step 2: Write tests for retryMessage**

Add in the same describe block:

```typescript
  it('retryMessage removes agent message and all subsequent messages, resends user message', async () => {
    const threadId = useAgentStore.getState().createThread('claude-code')
    // Add user message + agent message
    useAgentStore.getState().appendChatMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Implement login',
      timestamp: Date.now(),
      status: 'pending',
      contextRefs: [{ type: 'node', id: 'node-1', label: 'Login' }],
    })
    useAgentStore.getState().appendChatMessage(threadId, {
      id: 'agent-1',
      role: 'agent',
      content: 'Error occurred',
      timestamp: Date.now(),
      status: 'error',
      error: { code: 'AGENT_CRASH', message: 'crashed' },
    })

    await useAgentStore.getState().retryMessage(threadId, 'agent-1')

    const thread = useAgentStore.getState().threads.find((t) => t.id === threadId)!
    // The old agent message should be gone; a new user message + running status
    expect(thread.status).toBe('running')
    // The original user message content should have been resent
    const userMessages = thread.messages.filter((m) => m.role === 'user')
    expect(userMessages.some((m) => m.content === 'Implement login')).toBe(true)
  })

  it('retryMessage does nothing if target message has no preceding user message', async () => {
    const threadId = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(threadId, {
      id: 'agent-only',
      role: 'agent',
      content: 'orphan',
      timestamp: Date.now(),
      status: 'error',
      error: { code: 'UNKNOWN', message: 'unknown' },
    })

    await useAgentStore.getState().retryMessage(threadId, 'agent-only')

    // Should be a no-op — thread still idle
    expect(useAgentStore.getState().threads[0].status).toBe('idle')
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/renderer/store/__tests__/agentStore.test.ts`
Expected: FAIL — `stopCurrentSession` and `retryMessage` do not exist.

- [ ] **Step 4: Implement stopCurrentSession and retryMessage**

In `src/renderer/store/agentStore.ts`, add to the `AgentState` interface (after `markMessageStatus`):

```typescript
  stopCurrentSession: (threadId: string) => Promise<void>
  retryMessage: (threadId: string, agentMessageId: string) => Promise<void>
```

Add the implementations after `markMessageStatus`:

```typescript
  stopCurrentSession: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread?.sessionId) return

    await get().terminateSession(thread.sessionId)

    // Mark the last streaming agent message as aborted
    const lastStreaming = [...thread.messages].reverse().find((m) => m.role === 'agent' && m.status === 'streaming')
    if (lastStreaming) {
      get().markMessageStatus(threadId, lastStreaming.id, 'aborted')
    }

    get().updateThreadStatus(threadId, 'idle')
  },

  retryMessage: async (threadId, agentMessageId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return

    const agentIdx = thread.messages.findIndex((m) => m.id === agentMessageId)
    if (agentIdx < 0) return

    // Find the preceding user message
    const precedingUser = [...thread.messages.slice(0, agentIdx)].reverse().find((m) => m.role === 'user')
    if (!precedingUser) return

    // Remove the target agent message and everything after it
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: t.messages.slice(0, agentIdx) }
          : t,
      ),
    }))

    // Resend using the original user message content and context
    await get().sendMessage(threadId, precedingUser.content, precedingUser.contextRefs)
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/store/__tests__/agentStore.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/agentStore.ts src/renderer/store/__tests__/agentStore.test.ts
git commit -m "feat(store): add stopCurrentSession and retryMessage"
```

---

### Task 4: Store — sendMessage records sessionId and creates error message on failure

**Files:**
- Modify: `src/renderer/store/agentStore.ts`
- Modify: `src/renderer/store/__tests__/agentStore.test.ts`

- [ ] **Step 1: Write tests for sendMessage error handling**

Add inside the describe block:

```typescript
  it('sendMessage records sessionId on thread after successful start', async () => {
    vi.mocked(window.electronAPI['agent:startSession']).mockResolvedValueOnce({ sessionId: 'sess-abc' })
    const threadId = useAgentStore.getState().createThread('claude-code')
    await useAgentStore.getState().sendMessage(threadId, 'Hello')
    const thread = useAgentStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.sessionId).toBe('sess-abc')
    expect(thread.messages[0].status).toBe('pending') // user message
  })

  it('sendMessage creates an error message on session start failure', async () => {
    vi.mocked(window.electronAPI['agent:startSession']).mockRejectedValueOnce(new Error('spawn ENOENT'))
    const threadId = useAgentStore.getState().createThread('claude-code')
    await useAgentStore.getState().sendMessage(threadId, 'Hello')
    const thread = useAgentStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.status).toBe('error')
    // Should have user message + error agent message
    expect(thread.messages).toHaveLength(2)
    const errMsg = thread.messages[1]
    expect(errMsg.role).toBe('agent')
    expect(errMsg.status).toBe('error')
    expect(errMsg.error?.code).toBe('SESSION_START_FAILED')
    expect(errMsg.error?.raw).toContain('ENOENT')
  })
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx vitest run src/renderer/store/__tests__/agentStore.test.ts`
Expected: The new tests fail (sessionId not recorded, no error message created).

- [ ] **Step 3: Modify sendMessage in agentStore.ts**

Replace the `sendMessage` implementation (lines 125-176) with:

```typescript
  sendMessage: async (threadId, content, contextRefs, sessionConfig) => {
    const userMessage: ChatMessage = {
      id: generateId('msg'),
      role: 'user',
      content,
      timestamp: Date.now(),
      contextRefs,
      status: 'pending',
    }
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: [...t.messages, userMessage],
              title: t.title === 'New Thread' ? content.slice(0, 30) : t.title,
              status: 'running' as const,
            }
          : t,
      ),
    }))

    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return

    const config: AgentSessionConfig = sessionConfig ?? {
      workingDirectory: '',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: thread.nodeBound ?? '',
      acceptanceCriteria: [],
    }

    try {
      const result = await window.electronAPI['agent:startSession'](thread.adapterName, config)

      // Record sessionId on thread so stopCurrentSession can find it
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, sessionId: result.sessionId } : t,
        ),
      }))

      const command: AgentCommand = {
        type: 'implement',
        description: content,
        targetNodeId: thread.nodeBound ?? '',
      }
      await window.electronAPI['agent:sendCommand'](result.sessionId, command)
    } catch (err) {
      get().appendChatMessage(threadId, {
        id: generateId('msg'),
        role: 'agent',
        content: '',
        timestamp: Date.now(),
        status: 'error',
        error: {
          code: 'SESSION_START_FAILED',
          message: '无法启动 Agent 会话，请检查适配器是否可用。',
          raw: String(err),
        },
      })
      get().updateThreadStatus(threadId, 'error')
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/store/__tests__/agentStore.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/agentStore.ts src/renderer/store/__tests__/agentStore.test.ts
git commit -m "feat(store): sendMessage records sessionId and creates error message on failure"
```

---

### Task 5: ChatInput — Stop button

**Files:**
- Modify: `src/renderer/components/agent/ChatInput.tsx`

- [ ] **Step 1: Add onStop and isRunning props, render Stop button when running**

Replace the entire `ChatInput.tsx` with:

```typescript
import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '../../lib/utils'
import { SlashCommandMenu } from './SlashCommandMenu'
import type { SlashCommand } from './promptTemplates'
import { MentionSearchPopup } from './MentionSearchPopup'
import type { ContextRef } from '@shared/types'

interface ChatInputProps {
  onSend: (content: string, contextRefs: ContextRef[]) => void
  onStop?: () => void
  onMentionAdd?: (ref: ContextRef) => void
  disabled?: boolean
  isRunning?: boolean
  attachedContexts: ContextRef[]
}

export function ChatInput({ onSend, onStop, onMentionAdd, disabled, isRunning, attachedContexts }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [showSlash, setShowSlash] = useState(false)
  const [showMention, setShowMention] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [mentionFilter, setMentionFilter] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setValue(val)

    const slashMatch = val.match(/\/(\w*)$/)
    if (slashMatch) {
      setShowSlash(true)
      setSlashFilter('/' + slashMatch[1])
      setShowMention(false)
      return
    }
    setShowSlash(false)

    const mentionMatch = val.match(/@(\w*)$/)
    if (mentionMatch) {
      setShowMention(true)
      setMentionFilter(mentionMatch[1])
      return
    }
    setShowMention(false)
  }

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setValue((v) => v.replace(/\/\w*$/, ''))
    setShowSlash(false)
    onSend(cmd.name, attachedContexts)
  }, [onSend, attachedContexts])

  const handleMentionSelect = useCallback((ref: ContextRef) => {
    setValue((v) => v.replace(/@\w*$/, ''))
    setShowMention(false)
    if (onMentionAdd) onMentionAdd(ref)
  }, [onMentionAdd])

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed, attachedContexts)
    setValue('')
    setShowSlash(false)
    setShowMention(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlash || showMention) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    }
  }, [value])

  return (
    <div className="border-t border-border p-2.5 relative flex-shrink-0">
      {showSlash && (
        <SlashCommandMenu
          filter={slashFilter}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlash(false)}
        />
      )}
      {showMention && (
        <MentionSearchPopup
          filter={mentionFilter}
          onSelect={handleMentionSelect}
          onClose={() => setShowMention(false)}
          excludeIds={attachedContexts.filter((c) => c.type === 'node').map((c) => c.id)}
        />
      )}
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message, / for commands, @ to add context..."
          disabled={disabled && !isRunning}
          rows={1}
          className={cn(
            'flex-1 px-3 py-2 text-sm bg-background border border-border rounded-lg resize-none',
            'placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        />
        {isRunning ? (
          <button
            onClick={onStop}
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors bg-red-600 text-white hover:bg-red-700"
            title="Stop"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors',
              value.trim() && !disabled
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-muted text-muted-foreground cursor-not-allowed',
            )}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex justify-between mt-1.5">
        <span className="text-[9px] text-muted-foreground/50">Shift+Enter for newline</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: Type check passes for ChatInput (the parent AgentChatPanel will show errors until Task 8).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/ChatInput.tsx
git commit -m "feat(ChatInput): add Stop button when agent is running"
```

---

### Task 6: ChatBubble — error/aborted styling and action bar

**Files:**
- Modify: `src/renderer/components/agent/ChatBubble.tsx`

- [ ] **Step 1: Replace ChatBubble with status-aware version**

Replace the entire `ChatBubble.tsx` with:

```typescript
import { useState } from 'react'
import { User, Bot, Loader2, AlertTriangle, Copy, RefreshCw, Check, Ban } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ToolCallRenderer } from './ToolCallRenderer'
import type { ChatMessage } from '@shared/types'

interface ChatBubbleProps {
  message: ChatMessage
  onRetry?: (messageId: string) => void
}

export function ChatBubble({ message, onRetry }: ChatBubbleProps) {
  const isUser = message.role === 'user'
  const isError = message.status === 'error'
  const isAborted = message.status === 'aborted'
  const [copied, setCopied] = useState(false)
  const [showRawError, setShowRawError] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleRetry = () => {
    onRetry?.(message.id)
  }

  return (
    <div className="group flex gap-2 items-start">
      <div
        className={cn(
          'w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-semibold',
          isUser
            ? 'bg-blue-500/20 text-blue-400'
            : isError
              ? 'bg-red-500/20 text-red-400'
              : 'bg-purple-500/20 text-purple-400',
        )}
      >
        {isUser ? <User className="w-3 h-3" /> : isError ? <AlertTriangle className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-muted-foreground mb-1">
          {isUser ? 'You' : message.adapterName ?? 'Agent'}
          <span className="text-muted-foreground/50 ml-1">
            {formatTime(message.timestamp)}
          </span>
        </div>
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm leading-relaxed',
            isUser
              ? 'bg-blue-500/10 border border-blue-500/20'
              : isError
                ? 'bg-red-500/10 border border-red-500/40'
                : 'bg-muted/50 border border-border',
          )}
        >
          {/* Error state */}
          {isError && message.error && (
            <div className="mb-2">
              <div className="flex items-center gap-1.5 text-red-400 text-xs font-medium mb-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>{message.error.message}</span>
              </div>
              {message.error.raw && (
                <div>
                  <button
                    onClick={() => setShowRawError(!showRawError)}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline"
                  >
                    {showRawError ? '隐藏原始错误' : '查看原始错误'}
                  </button>
                  {showRawError && (
                    <pre className="mt-1 p-2 text-[10px] bg-red-950/30 rounded overflow-x-auto text-red-300">
                      {message.error.raw}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Message content */}
          {message.content ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : !isError ? null : null}

          {/* Tool calls */}
          {message.toolCalls?.map((block, i) => (
            <ToolCallRenderer key={i} block={block} />
          ))}
        </div>

        {/* Aborted label */}
        {isAborted && (
          <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground/70">
            <Ban className="w-3 h-3" />
            <span>已终止</span>
          </div>
        )}

        {/* Action bar — visible on hover for agent messages */}
        {!isUser && (message.content || isError) && (
          <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Copy"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {(isError || isAborted) && onRetry && (
              <button
                onClick={handleRetry}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Retry"
              >
                <RefreshCw className="w-3 h-3" />
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

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

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: ChatBubble compiles. AgentChatPanel/ChatMessageList will show errors until Tasks 7-8.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/ChatBubble.tsx
git commit -m "feat(ChatBubble): add error/aborted styling, Copy and Retry action bar"
```

---

### Task 7: ChatMessageList — pass onRetry to ChatBubble

**Files:**
- Modify: `src/renderer/components/agent/ChatMessageList.tsx`

- [ ] **Step 1: Update ChatMessageList to accept and pass onRetry**

Replace the entire `ChatMessageList.tsx` with:

```typescript
import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { ChatBubble, RunningIndicator } from './ChatBubble'
import type { ChatMessage } from '@shared/types'

interface ChatMessageListProps {
  messages: ChatMessage[]
  isRunning: boolean
  adapterName?: string
  onRetry?: (messageId: string) => void
}

export function ChatMessageList({ messages, isRunning, adapterName, onRetry }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, isRunning])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-6 py-12">
        <div>
          <MessageSquare className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Start a conversation</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Type a message, use / for commands, or @ to add context
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} onRetry={onRetry} />
      ))}
      {isRunning && <RunningIndicator adapterName={adapterName} />}
      <div ref={bottomRef} />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/agent/ChatMessageList.tsx
git commit -m "feat(ChatMessageList): pass onRetry callback to ChatBubble"
```

---

### Task 8: AgentChatPanel — wire up stop, retry, and error-aware output handler

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

- [ ] **Step 1: Rewrite AgentChatPanel with stop/stopCurrentSession, retryMessage, and new onAgentOutput logic**

Replace the entire `AgentChatPanel.tsx` with:

```typescript
import { useState, useEffect, useRef } from 'react'
import { Bot } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { useGraphStore } from '../../store/graphStore'
import { ChatHeader } from './ChatHeader'
import { ContextBar } from './ContextBar'
import { ChatMessageList } from './ChatMessageList'
import { ChatInput } from './ChatInput'
import { TerminalView } from './TerminalView'
import { ThreadListOverlay } from './ThreadListOverlay'
import type { ContextRef, AgentSessionConfig, AgentOutput } from '@shared/types'
import { generatePromptTemplate } from './promptTemplates'
import { generateId } from '../../lib/utils'

interface AgentChatPanelProps {
  expanded: boolean
  onToggleExpand: () => void
}

export function AgentChatPanel({ expanded, onToggleExpand }: AgentChatPanelProps) {
  const {
    adapters,
    threads,
    currentThreadId,
    sessions,
    loadAdapters,
    createThread,
    sendMessage,
    appendChatMessage,
    markMessageStatus,
    stopCurrentSession,
    retryMessage,
    renameThread,
    deleteThread,
    selectThread,
  } = useAgentStore()

  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>('chat')
  const [showThreadList, setShowThreadList] = useState(false)
  const [selectedAdapter, setSelectedAdapter] = useState('')
  const [attachedContexts, setAttachedContexts] = useState<ContextRef[]>([])

  const currentThread = threads.find((t) => t.id === currentThreadId)
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId)
  const nodes = useGraphStore((s) => s.nodes)
  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  // Track the current streaming agent message ID within this render cycle
  const streamingMsgIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      loadAdapters()
    }
  }, [loadAdapters])

  useEffect(() => {
    const installed = adapters.filter((a) => a.installed)
    if (installed.length > 0 && !selectedAdapter) {
      setSelectedAdapter(installed[0].name)
    }
  }, [adapters, selectedAdapter])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI?.onAgentOutput) {
      const cleanup = window.electronAPI.onAgentOutput((_sessionId: string, output: AgentOutput) => {
        useAgentStore.getState().appendOutput(_sessionId, output)
        const tid = useAgentStore.getState().currentThreadId
        if (!tid) return

        const store = useAgentStore.getState()
        const thread = store.threads.find((t) => t.id === tid)
        const adapterName = thread?.adapterName

        if (output.type === 'error') {
          // If there's a current streaming message, mark it as error
          if (streamingMsgIdRef.current) {
            store.markMessageStatus(tid, streamingMsgIdRef.current, 'error', {
              code: output.errorCode ?? 'UNKNOWN',
              message: output.data || 'Agent 异常退出',
            })
            streamingMsgIdRef.current = null
          } else {
            // No streaming message — create a new error message
            store.appendChatMessage(tid, {
              id: generateId('msg'),
              role: 'agent',
              content: '',
              timestamp: output.timestamp,
              adapterName,
              status: 'error',
              error: {
                code: output.errorCode ?? 'UNKNOWN',
                message: output.data || 'Agent 异常退出',
              },
            })
          }
          store.updateThreadStatus(tid, 'error')
          return
        }

        if (output.type === 'complete') {
          if (streamingMsgIdRef.current) {
            store.markMessageStatus(tid, streamingMsgIdRef.current, 'success')
            streamingMsgIdRef.current = null
          }
          store.updateThreadStatus(tid, 'idle')
          return
        }

        if (output.type === 'stdout' || output.type === 'file_change') {
          const text = output.data.trim()
          if (!text) return

          if (!streamingMsgIdRef.current) {
            // Create a new streaming agent message
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
            // Append content to existing streaming message by replacing it
            const thread = store.threads.find((t) => t.id === tid)
            const existingMsg = thread?.messages.find((m) => m.id === streamingMsgIdRef.current)
            if (existingMsg) {
              // Remove old and add updated (Zustand immutable pattern)
              useAgentStore.setState({
                threads: store.threads.map((t) =>
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

        if (output.type === 'stderr') {
          // Append stderr to current streaming message as warning text
          if (streamingMsgIdRef.current) {
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
                            ? { ...m, content: m.content + '\n[stderr] ' + output.data.trim() }
                            : m,
                        ),
                      }
                    : t,
                ),
              })
            }
          }
        }
      })
      return cleanup
    }
  }, [currentThreadId])

  // Reset streaming ref when thread changes
  useEffect(() => {
    streamingMsgIdRef.current = null
  }, [currentThreadId])

  const handleNewThread = () => {
    if (!selectedAdapter) return
    createThread(selectedAdapter, selectedNode?.id)
    if (selectedNode) {
      setAttachedContexts([
        { type: 'node', id: selectedNode.id, label: selectedNode.title },
      ])
    }
  }

  const handleSend = async (content: string, contextRefs: ContextRef[]) => {
    let threadId = currentThreadId
    if (!threadId) {
      threadId = createThread(selectedAdapter, selectedNode?.id)
    }

    const graphs = useGraphStore.getState().graphs
    const currentGraphId = useGraphStore.getState().currentGraphId
    const currentGraph = graphs.find((g) => g.id === currentGraphId)
    const sessionConfig: AgentSessionConfig = {
      workingDirectory: currentGraph?.projectPath ?? '',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: selectedNode?.rules?.map((r) => r.title) ?? [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: selectedNode?.title ?? '',
      acceptanceCriteria: selectedNode?.acceptanceCriteria ?? [],
    }

    if (content.startsWith('/')) {
      const template = generatePromptTemplate(content.trim(), selectedNode)
      if (template) {
        await sendMessage(threadId, template, contextRefs, sessionConfig)
        return
      }
    }

    streamingMsgIdRef.current = null
    await sendMessage(threadId, content, contextRefs, sessionConfig)
  }

  const handleStop = async () => {
    if (currentThreadId) {
      streamingMsgIdRef.current = null
      await stopCurrentSession(currentThreadId)
    }
  }

  const handleRetry = async (agentMessageId: string) => {
    if (currentThreadId) {
      streamingMsgIdRef.current = null
      await retryMessage(currentThreadId, agentMessageId)
    }
  }

  const handleMentionAdd = (ref: ContextRef) => {
    setAttachedContexts((prev) => {
      if (prev.some((c) => c.id === ref.id)) return prev
      return [...prev, ref]
    })
  }

  const handleRemoveContext = (id: string) => {
    setAttachedContexts((prev) => prev.filter((c) => c.id !== id))
  }

  const currentSession = sessions.find((s) => s.status === 'running')
  const rawOutputs = currentSession?.outputs ?? []
  const isRunning = currentThread?.status === 'running'

  return (
    <div className="h-full flex flex-col relative">
      <ChatHeader
        adapterName={selectedAdapter}
        adapters={adapters}
        threadTitle={currentThread?.title ?? 'New Thread'}
        viewMode={viewMode}
        expanded={expanded}
        onSelectAdapter={setSelectedAdapter}
        onNewThread={handleNewThread}
        onToggleThreads={() => setShowThreadList(!showThreadList)}
        onToggleView={setViewMode}
        onToggleExpand={onToggleExpand}
      />

      {showThreadList && (
        <ThreadListOverlay
          threads={threads}
          currentThreadId={currentThreadId}
          onSelect={(id) => { selectThread(id); setShowThreadList(false) }}
          onDelete={deleteThread}
          onRename={renameThread}
          onClose={() => setShowThreadList(false)}
        />
      )}

      {currentThread && (
        <ContextBar
          contexts={attachedContexts}
          onRemove={handleRemoveContext}
          onAdd={() => {}}
        />
      )}

      {!currentThread && threads.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <Bot className="w-10 h-10 mx-auto mb-3 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground mb-1">Welcome to Agent</p>
            <p className="text-xs text-muted-foreground/60">
              Type a message below to start a new conversation
            </p>
          </div>
        </div>
      ) : viewMode === 'chat' ? (
        <ChatMessageList
          messages={currentThread?.messages ?? []}
          isRunning={!!isRunning}
          adapterName={currentThread?.adapterName}
          onRetry={handleRetry}
        />
      ) : (
        <TerminalView outputs={rawOutputs} />
      )}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onMentionAdd={handleMentionAdd}
        disabled={!!isRunning}
        isRunning={!!isRunning}
        attachedContexts={attachedContexts}
      />
    </div>
  )
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS — all type errors resolved.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat(AgentChatPanel): wire up stop, retry, and error-aware output handler"
```

---

### Task 9: Base adapter — add errorCode to error output

**Files:**
- Modify: `src/main/adapters/base.ts:267-273`

- [ ] **Step 1: Add errorCode to the onError handler**

In `src/main/adapters/base.ts`, replace the `onError` handler (around line 267-273):

```typescript
    const onError = (err: Error) => {
      this.emitOutput({
        type: 'error',
        data: err.message,
        timestamp: Date.now(),
        errorCode: 'AGENT_CRASH',
      })
    }
```

- [ ] **Step 2: Also add errorCode to the onExit handler when exit code is non-zero**

Replace the `onExit` handler (around line 259-265):

```typescript
    const onExit = (code: number | null) => {
      if (code !== null && code !== 0) {
        this.emitOutput({
          type: 'error',
          data: `${this.name} exited with code ${code}`,
          timestamp: Date.now(),
          errorCode: 'AGENT_CRASH',
        })
      } else {
        this.emitOutput({
          type: 'complete',
          data: `${this.name} exited with code ${code ?? 'unknown'}`,
          timestamp: Date.now(),
        })
      }
    }
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/adapters/base.ts
git commit -m "feat(adapter): add errorCode to error output and distinguish non-zero exit codes"
```

---

### Task 10: Lint and final verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: 0 warnings, 0 errors.

- [ ] **Step 2: Run all tests**

Run: `npm run test`
Expected: All tests PASS.

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 4: Final commit if any lint fixes were needed**

```bash
git add -u
git commit -m "fix: lint fixes for chat enhancement"
```
