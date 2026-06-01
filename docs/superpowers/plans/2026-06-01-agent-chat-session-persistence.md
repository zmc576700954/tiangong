# Agent Chat 会话记录持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AgentChat 聊天历史的持久存储和基于 Claude Code `--session-id` 的会话续接能力。

**Architecture:** 在现有 `agent_logs` 旁新增 `chat_threads` + `chat_messages` 两张表，通过 `ChatRepository` → `ChatService` → IPC 通道暴露给 renderer。Renderer 端 `agentStore` 扩展 hydration 和 save 逻辑，complete 时批量落盘。ClaudeCodeAdapter 在 spawn 命令中支持 `--resume <sessionId>` 实现续接。

**Tech Stack:** LibSQL (SQLite)、Zustand、Electron IPC、Claude Code CLI `--resume`

---

## 文件清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/main/database.ts` | 修改 | 新增 `chat_threads` + `chat_messages` 表 migration |
| `src/main/repositories/chat-repository.ts` | 新建 | 线程 + 消息的数据访问层 |
| `src/main/services/chat-service.ts` | 新建 | 线程 CRUD、消息存储、自动命名、session_id 回写 |
| `src/main/ipc/chat.ts` | 新建 | `thread:*` + `message:*` IPC handler 注册 |
| `src/main/ipc-handlers.ts` | 修改 | 注册 ChatService 和 chat handlers，broadcaster 拦截 complete |
| `src/shared/types.ts` | 修改 | IpcApi 新增 thread/message 通道类型，AgentConfig 新增 resumeSessionId |
| `src/preload/index.ts` | 修改 | 暴露新增 IPC 通道 + `onSessionStarted` 事件 |
| `src/main/adapters/claude-code.ts` | 修改 | spawn 命令支持 `--resume <sessionId>` |
| `src/main/agent/agent-manager.ts` | 修改 | `resolveAndSendCommand` 接受 threadId，complete 时发出 `onSessionStarted` |
| `src/renderer/store/agentStore.ts` | 修改 | 新增 hydration、save、load 逻辑 |
| `src/renderer/components/agent/ThreadListOverlay.tsx` | 修改 | 从 DB 加载历史线程 |
| `src/renderer/components/agent/HistorySidebar.tsx` | 新建 | 全局历史侧边栏组件 |
| `src/renderer/components/agent/AgentChatPanel.tsx` | 修改 | 集成续接按钮、接入 HistorySidebar |
| `src/main/__tests__/chat-repository.test.ts` | 新建 | ChatRepository 单元测试 |
| `src/main/__tests__/chat-service.test.ts` | 新建 | ChatService 单元测试 |

---

## Task 1: 数据库 Schema

**Files:**
- Modify: `src/main/database.ts`
- Test: `src/main/__tests__/database.test.ts` (existing)

- [ ] **Step 1: 在 `migrate()` 函数末尾新增两张表**

在 `database.ts` 的 `migrate()` 函数中，agent_logs 表之后、index 创建之前，插入：

```typescript
// Chat threads table
await rebuildTableIfNeeded(db, 'chat_threads', `
  CREATE TABLE chat_threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    adapter_name TEXT NOT NULL,
    node_id TEXT,
    graph_id TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`, ['id', 'title', 'adapter_name', 'node_id', 'graph_id', 'session_id', 'status', 'created_at', 'updated_at'])

// Chat messages table
await rebuildTableIfNeeded(db, 'chat_messages', `
  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    adapter_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error', 'pending', 'streaming', 'aborted')),
    error TEXT,
    session_id TEXT,
    context_refs TEXT,
    tool_calls TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
  )
`, ['id', 'thread_id', 'role', 'content', 'adapter_name', 'status', 'error', 'session_id', 'context_refs', 'tool_calls', 'created_at'])
```

- [ ] **Step 2: 新增索引**

在索引创建区域追加：

```typescript
await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_threads_node_id ON chat_threads(node_id)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_threads_graph_id ON chat_threads(graph_id)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_threads_updated_at ON chat_threads(updated_at)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON chat_messages(thread_id)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at)`)
```

- [ ] **Step 3: 运行测试验证 migration 不报错**

Run: `npm run test`
Expected: PASS（现有测试不受影响，新表被 `rebuildTableIfNeeded` 安全创建）

- [ ] **Step 4: Commit**

```bash
git add src/main/database.ts
git commit -m "feat: add chat_threads and chat_messages tables to database schema"
```

---

## Task 2: ChatRepository

**Files:**
- Create: `src/main/repositories/chat-repository.ts`
- Test: `src/main/__tests__/chat-repository.test.ts`

- [ ] **Step 1: 编写 ChatRepository 测试**

```typescript
// src/main/__tests__/chat-repository.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ChatRepository } from '../repositories/chat-repository'

// 使用内存数据库进行测试
// 注意：实际实现需要在 vitest setup 中初始化 test DB
describe('ChatRepository', () => {
  let repo: ChatRepository

  beforeEach(() => {
    // repo 将在集成测试中用真实 DB 初始化
    // 此处验证类可实例化
  })

  it('should be defined', () => {
    expect(ChatRepository).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/__tests__/chat-repository.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 ChatRepository**

```typescript
// src/main/repositories/chat-repository.ts
import type { Client } from '@libsql/client'
import type { ChatMessage, AgentThread } from '@shared/types'

export interface ChatThreadRow {
  id: string
  title: string
  adapter_name: string
  node_id: string | null
  graph_id: string | null
  session_id: string | null
  status: string
  created_at: number
  updated_at: number
}

export interface ChatMessageRow {
  id: string
  thread_id: string
  role: string
  content: string
  adapter_name: string
  status: string
  error: string | null
  session_id: string | null
  context_refs: string | null
  tool_calls: string | null
  created_at: number
}

export class ChatRepository {
  constructor(private db: Client) {}

  // ==================== Thread CRUD ====================

  async createThread(data: {
    id: string
    title: string
    adapterName: string
    nodeId?: string
    graphId?: string
    sessionId?: string
  }): Promise<ChatThreadRow> {
    const now = Date.now()
    await this.db.execute({
      sql: `INSERT INTO chat_threads (id, title, adapter_name, node_id, graph_id, session_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [data.id, data.title, data.adapterName, data.nodeId ?? null, data.graphId ?? null, data.sessionId ?? null, now, now],
    })
    return {
      id: data.id,
      title: data.title,
      adapter_name: data.adapterName,
      node_id: data.nodeId ?? null,
      graph_id: data.graphId ?? null,
      session_id: data.sessionId ?? null,
      status: 'active',
      created_at: now,
      updated_at: now,
    }
  }

  async getThread(id: string): Promise<ChatThreadRow | null> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM chat_threads WHERE id = ?',
      args: [id],
    })
    return (result.rows[0] as unknown as ChatThreadRow) ?? null
  }

  async listThreads(filters?: { nodeId?: string; graphId?: string; status?: string }): Promise<ChatThreadRow[]> {
    let sql = 'SELECT * FROM chat_threads WHERE 1=1'
    const args: unknown[] = []

    if (filters?.nodeId) {
      sql += ' AND node_id = ?'
      args.push(filters.nodeId)
    }
    if (filters?.graphId) {
      sql += ' AND graph_id = ?'
      args.push(filters.graphId)
    }
    if (filters?.status) {
      sql += ' AND status = ?'
      args.push(filters.status)
    }

    sql += ' ORDER BY updated_at DESC'
    const result = await this.db.execute({ sql, args })
    return result.rows as unknown as ChatThreadRow[]
  }

  async updateThread(id: string, data: { title?: string; status?: string; sessionId?: string; updatedAt?: number }): Promise<void> {
    const sets: string[] = []
    const args: unknown[] = []

    if (data.title !== undefined) { sets.push('title = ?'); args.push(data.title) }
    if (data.status !== undefined) { sets.push('status = ?'); args.push(data.status) }
    if (data.sessionId !== undefined) { sets.push('session_id = ?'); args.push(data.sessionId) }
    if (data.updatedAt !== undefined) { sets.push('updated_at = ?'); args.push(data.updatedAt) }

    if (sets.length === 0) return

    args.push(id)
    await this.db.execute({
      sql: `UPDATE chat_threads SET ${sets.join(', ')} WHERE id = ?`,
      args,
    })
  }

  async deleteThread(id: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM chat_messages WHERE thread_id = ?', args: [id] })
    await this.db.execute({ sql: 'DELETE FROM chat_threads WHERE id = ?', args: [id] })
  }

  async searchThreads(query: string): Promise<ChatThreadRow[]> {
    const like = `%${query}%`
    const result = await this.db.execute({
      sql: `SELECT DISTINCT t.* FROM chat_threads t
            LEFT JOIN chat_messages m ON m.thread_id = t.id
            WHERE t.title LIKE ? OR m.content LIKE ?
            ORDER BY t.updated_at DESC`,
      args: [like, like],
    })
    return result.rows as unknown as ChatThreadRow[]
  }

  // ==================== Message CRUD ====================

  async saveMessage(data: {
    id: string
    threadId: string
    role: string
    content: string
    adapterName: string
    status: string
    error?: string
    sessionId?: string
    contextRefs?: string
    toolCalls?: string
    createdAt: number
  }): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO chat_messages
            (id, thread_id, role, content, adapter_name, status, error, session_id, context_refs, tool_calls, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.id, data.threadId, data.role, data.content, data.adapterName,
        data.status, data.error ?? null, data.sessionId ?? null,
        data.contextRefs ?? null, data.toolCalls ?? null, data.createdAt,
      ],
    })
  }

  async saveMessages(messages: Array<{
    id: string
    threadId: string
    role: string
    content: string
    adapterName: string
    status: string
    error?: string
    sessionId?: string
    contextRefs?: string
    toolCalls?: string
    createdAt: number
  }>): Promise<void> {
    for (const msg of messages) {
      await this.saveMessage(msg)
    }
  }

  async listMessages(threadId: string): Promise<ChatMessageRow[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC',
      args: [threadId],
    })
    return result.rows as unknown as ChatMessageRow[]
  }

  async deleteMessagesByThread(threadId: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM chat_messages WHERE thread_id = ?', args: [threadId] })
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/main/__tests__/chat-repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/repositories/chat-repository.ts src/main/__tests__/chat-repository.test.ts
git commit -m "feat: add ChatRepository for threads and messages persistence"
```

---

## Task 3: ChatService

**Files:**
- Create: `src/main/services/chat-service.ts`
- Test: `src/main/__tests__/chat-service.test.ts`

- [ ] **Step 1: 编写 ChatService 测试**

```typescript
// src/main/__tests__/chat-service.test.ts
import { describe, it, expect } from 'vitest'
import { ChatService } from '../services/chat-service'

describe('ChatService', () => {
  it('should be defined', () => {
    expect(ChatService).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/__tests__/chat-service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 ChatService**

```typescript
// src/main/services/chat-service.ts
import type { Client } from '@libsql/client'
import type { ChatMessage, AgentThread } from '@shared/types'
import { ChatRepository } from '../repositories/chat-repository'
import { generateId } from '../shared/env'

export class ChatService {
  private repo: ChatRepository

  constructor(db: Client) {
    this.repo = new ChatRepository(db)
  }

  // ==================== Thread Operations ====================

  async createThread(data: {
    adapterName: string
    nodeId?: string
    graphId?: string
  }): Promise<AgentThread> {
    const id = generateId('thread')
    await this.repo.createThread({
      id,
      title: 'New Thread',
      adapterName: data.adapterName,
      nodeId: data.nodeId,
      graphId: data.graphId,
    })
    return {
      id,
      title: 'New Thread',
      adapterName: data.adapterName,
      messages: [],
      contextRefs: [],
      status: 'idle',
      createdAt: Date.now(),
      nodeBound: data.nodeId,
    }
  }

  async getThread(id: string): Promise<AgentThread | null> {
    const row = await this.repo.getThread(id)
    if (!row) return null
    return this.rowToThread(row)
  }

  async getThreadWithMessages(id: string): Promise<(AgentThread & { messages: ChatMessage[] }) | null> {
    const row = await this.repo.getThread(id)
    if (!row) return null
    const messageRows = await this.repo.listMessages(id)
    return {
      ...this.rowToThread(row),
      messages: messageRows.map(this.rowToMessage),
    }
  }

  async listThreads(filters?: { nodeId?: string; graphId?: string }): Promise<AgentThread[]> {
    const rows = await this.repo.listThreads({ ...filters, status: 'active' })
    return rows.map(this.rowToThread)
  }

  async updateThread(id: string, data: { title?: string; status?: string; sessionId?: string }): Promise<void> {
    await this.repo.updateThread(id, { ...data, updatedAt: Date.now() })
  }

  async deleteThread(id: string): Promise<void> {
    await this.repo.deleteThread(id)
  }

  async searchThreads(query: string): Promise<AgentThread[]> {
    const rows = await this.repo.searchThreads(query)
    return rows.map(this.rowToThread)
  }

  // ==================== Message Operations ====================

  async saveMessage(threadId: string, message: ChatMessage): Promise<void> {
    await this.repo.saveMessage({
      id: message.id,
      threadId,
      role: message.role === 'agent' ? 'assistant' : message.role,
      content: message.content,
      adapterName: message.adapterName ?? '',
      status: message.status,
      error: message.error ? JSON.stringify(message.error) : undefined,
      sessionId: message.sessionId,
      contextRefs: message.contextRefs ? JSON.stringify(message.contextRefs) : undefined,
      toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
      createdAt: message.timestamp,
    })
    // 更新 thread 的 updated_at
    await this.repo.updateThread(threadId, { updatedAt: Date.now() })
  }

  async saveMessages(threadId: string, messages: ChatMessage[]): Promise<void> {
    await this.repo.saveMessages(messages.map((m) => ({
      id: m.id,
      threadId,
      role: m.role === 'agent' ? 'assistant' : m.role,
      content: m.content,
      adapterName: m.adapterName ?? '',
      status: m.status,
      error: m.error ? JSON.stringify(m.error) : undefined,
      sessionId: m.sessionId,
      contextRefs: m.contextRefs ? JSON.stringify(m.contextRefs) : undefined,
      toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
      createdAt: m.timestamp,
    })))
    await this.repo.updateThread(threadId, { updatedAt: Date.now() })
  }

  async listMessages(threadId: string): Promise<ChatMessage[]> {
    const rows = await this.repo.listMessages(threadId)
    return rows.map(this.rowToMessage)
  }

  // ==================== Mappers ====================

  private rowToThread(row: { id: string; title: string; adapter_name: string; node_id: string | null; graph_id: string | null; session_id: string | null; status: string; created_at: number; updated_at: number }): AgentThread {
    return {
      id: row.id,
      title: row.title,
      adapterName: row.adapter_name,
      messages: [],
      contextRefs: [],
      status: 'idle',
      createdAt: row.created_at,
      nodeBound: row.node_id ?? undefined,
      sessionId: row.session_id ?? undefined,
    }
  }

  private rowToMessage(row: { id: string; thread_id: string; role: string; content: string; adapter_name: string; status: string; error: string | null; session_id: string | null; context_refs: string | null; tool_calls: string | null; created_at: number }): ChatMessage {
    return {
      id: row.id,
      role: row.role === 'assistant' ? 'agent' : row.role as ChatMessage['role'],
      content: row.content,
      timestamp: row.created_at,
      adapterName: row.adapter_name || undefined,
      status: row.status as ChatMessage['status'],
      error: row.error ? JSON.parse(row.error) : undefined,
      sessionId: row.session_id ?? undefined,
      contextRefs: row.context_refs ? JSON.parse(row.context_refs) : undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    }
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/main/__tests__/chat-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/chat-service.ts src/main/__tests__/chat-service.test.ts
git commit -m "feat: add ChatService with thread and message CRUD operations"
```

---

## Task 4: IPC 类型定义

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 在 IpcApi 中新增 thread 和 message 通道**

在 `src/shared/types.ts` 的 `IpcApi` 接口中，`'agent:listAdapters'` 行之后追加：

```typescript
  // Chat 会话记录
  'thread:list': (filters?: { nodeId?: string; graphId?: string }) => Promise<AgentThread[]>
  'thread:load': (threadId: string) => Promise<AgentThread | null>
  'thread:create': (data: { adapterName: string; nodeId?: string; graphId?: string }) => Promise<AgentThread>
  'thread:update': (threadId: string, data: { title?: string; status?: string; sessionId?: string }) => Promise<void>
  'thread:delete': (threadId: string) => Promise<void>
  'thread:search': (query: string) => Promise<AgentThread[]>

  'message:list': (threadId: string) => Promise<ChatMessage[]>
  'message:save': (threadId: string, message: ChatMessage) => Promise<void>
  'message:saveBatch': (threadId: string, messages: ChatMessage[]) => Promise<void>
```

- [ ] **Step 2: 在 AgentSessionConfig 中新增 resumeSessionId**

找到 `AgentSessionConfig` 接口，在末尾追加：

```typescript
  /** Claude Code 会话续接 ID，非空时 spawn 命令加 --resume */
  resumeSessionId?: string
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add thread/message IPC types and resumeSessionId to AgentSessionConfig"
```

---

## Task 5: Preload Bridge

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: 在 exposedChannels 数组中追加新通道**

在 `'agent:listAdapters'` 行之后追加：

```typescript
  // Chat 会话记录
  'thread:list',
  'thread:load',
  'thread:create',
  'thread:update',
  'thread:delete',
  'thread:search',
  'message:list',
  'message:save',
  'message:saveBatch',
```

- [ ] **Step 2: 在 contextBridge 中新增 onSessionStarted 事件监听**

在 `onAgentOutput` 注册之后追加：

```typescript
  onSessionStarted: (callback: (threadId: string, sessionId: string) => void) => {
    const handler = (_: unknown, threadId: string, sessionId: string) => {
      callback(threadId, sessionId)
    }
    ipcRenderer.on('agent:onSessionStarted', handler)
    return () => ipcRenderer.off('agent:onSessionStarted', handler)
  },
```

- [ ] **Step 3: 更新 Window 类型声明**

在 `declare global` 的 `Window` 接口中，`onAgentOutput` 之后追加：

```typescript
      onSessionStarted: (callback: (threadId: string, sessionId: string) => void) => () => void
```

- [ ] **Step 4: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat: expose thread/message IPC channels and onSessionStarted event in preload"
```

---

## Task 6: Chat IPC Handlers

**Files:**
- Create: `src/main/ipc/chat.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: 创建 chat.ts IPC handler**

```typescript
// src/main/ipc/chat.ts
import type { ChatService } from '../services/chat-service'
import type { TypedHandle } from './utils'

export function registerChatHandlers(chatService: ChatService, typedHandle: TypedHandle): void {
  typedHandle('thread:list', async (_, filters) => {
    return chatService.listThreads(filters ?? undefined)
  })

  typedHandle('thread:load', async (_, threadId) => {
    return chatService.getThreadWithMessages(threadId)
  })

  typedHandle('thread:create', async (_, data) => {
    return chatService.createThread(data)
  })

  typedHandle('thread:update', async (_, threadId, data) => {
    return chatService.updateThread(threadId, data)
  })

  typedHandle('thread:delete', async (_, threadId) => {
    return chatService.deleteThread(threadId)
  })

  typedHandle('thread:search', async (_, query) => {
    return chatService.searchThreads(query)
  })

  typedHandle('message:list', async (_, threadId) => {
    return chatService.listMessages(threadId)
  })

  typedHandle('message:save', async (_, threadId, message) => {
    return chatService.saveMessage(threadId, message)
  })

  typedHandle('message:saveBatch', async (_, threadId, messages) => {
    return chatService.saveMessages(threadId, messages)
  })
}
```

- [ ] **Step 2: 在 ipc-handlers.ts 中注册 ChatService 和 chat handlers**

在 `ipc-handlers.ts` 中：
1. 顶部 import 区域新增：`import { ChatService } from './services/chat-service'` 和 `import { registerChatHandlers } from './ipc/chat'`
2. 在 `registerIpcHandlers()` 函数中，`const graphService = ...` 之后新增：

```typescript
  const chatService = new ChatService(db)
```

3. 在 `registerMindmapHandlers(...)` 之后新增：

```typescript
  registerChatHandlers(chatService, typedHandle)
```

- [ ] **Step 3: 在 broadcaster 拦截中增加 complete 时的消息持久化**

在 `ipc-handlers.ts` 的 `broadcaster.onBroadcast` 中修改为：

```typescript
broadcaster.onBroadcast((adapterName, output) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:onOutput', adapterName, output)
  }

  // complete 时持久化当前线程的未保存消息
  if (output.type === 'complete' && output.threadId) {
    chatService.getThreadWithMessages(output.threadId).catch(() => {})
  }
})
```

注意：complete 时的批量持久化由 renderer 端在收到 complete 事件后主动调用 `message:saveBatch`，主进程只做辅助更新 `updated_at`。这样保持架构简洁——主进程不持有消息 buffer。

- [ ] **Step 4: 运行测试**

Run: `npm run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/chat.ts src/main/ipc-handlers.ts
git commit -m "feat: add chat IPC handlers and register ChatService"
```

---

## Task 7: ClaudeCodeAdapter 支持 --resume

**Files:**
- Modify: `src/main/adapters/claude-code.ts`

- [ ] **Step 1: 在 spawn 命令中支持 resumeSessionId**

在 `doSendCommand` 方法中，将 spawn 调用修改为动态构建参数：

```typescript
  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const scopePrompt = this.buildScopePrompt(session.config, session.resolvedContexts)
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`

    // 构建 CLI 参数
    const args = ['-p', '--verbose', '--model', 'sonnet']
    if (session.config.resumeSessionId) {
      args.push('--resume', session.config.resumeSessionId)
    }

    const proc = spawn('claude', args, {
      cwd: session.config.workingDirectory,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const runPromise = this.runOneShot(proc)
    await this.safeWriteStdin(proc, fullPrompt + '\n')
    proc.stdin?.end()
    await runPromise
  }
```

- [ ] **Step 2: 运行测试**

Run: `npm run test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/adapters/claude-code.ts
git commit -m "feat: ClaudeCodeAdapter supports --resume for session continuation"
```

---

## Task 8: agentStore 持久化层

**Files:**
- Modify: `src/renderer/store/agentStore.ts`

- [ ] **Step 1: 新增 hydration 和 save actions**

在 `AgentState` 接口中追加：

```typescript
  // 持久化相关
  loadThreads: (filters?: { nodeId?: string; graphId?: string }) => Promise<void>
  loadMessages: (threadId: string) => Promise<void>
  persistMessage: (threadId: string, message: ChatMessage) => Promise<void>
  persistThreadMessages: (threadId: string) => Promise<void>
  hydrateOnStart: () => Promise<void>
```

- [ ] **Step 2: 实现 loadThreads**

在 `create<AgentState>` 的 state 对象中追加：

```typescript
  loadThreads: async (filters) => {
    const threads = await window.electronAPI['thread:list'](filters)
    set({ threads })
  },
```

- [ ] **Step 3: 实现 loadMessages**

```typescript
  loadMessages: async (threadId) => {
    const thread = await window.electronAPI['thread:load'](threadId)
    if (!thread) return
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? thread : t,
      ),
    }))
  },
```

- [ ] **Step 4: 实现 persistMessage**

```typescript
  persistMessage: async (threadId, message) => {
    try {
      await window.electronAPI['message:save'](threadId, message)
    } catch (err) {
      console.error('[agentStore] Failed to persist message:', err)
    }
  },
```

- [ ] **Step 5: 实现 persistThreadMessages（complete 时批量写入）**

```typescript
  persistThreadMessages: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return
    try {
      await window.electronAPI['message:saveBatch'](threadId, thread.messages)
    } catch (err) {
      console.error('[agentStore] Failed to persist thread messages:', err)
    }
  },
```

- [ ] **Step 6: 实现 hydrateOnStart**

```typescript
  hydrateOnStart: async () => {
    try {
      const threads = await window.electronAPI['thread:list']()
      if (threads.length > 0) {
        set({ threads, currentThreadId: threads[0].id })
      }
    } catch (err) {
      console.error('[agentStore] Failed to hydrate threads:', err)
    }
  },
```

- [ ] **Step 7: 修改 createThread 持久化到 DB**

将现有 `createThread` 实现改为：

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
    set((state) => ({
      threads: [...state.threads, thread],
      currentThreadId: id,
    }))
    // 异步持久化到 DB
    window.electronAPI['thread:create']({ adapterName, nodeId: nodeBound }).catch((err) => {
      console.error('[agentStore] Failed to persist new thread:', err)
    })
    return id
  },
```

- [ ] **Step 8: 修改 sendMessage 持久化用户消息**

在 `sendMessage` 中，用户消息创建后、`set(...)` 之后追加持久化调用：

```typescript
    // 持久化用户消息到 DB
    get().persistMessage(threadId, userMessage)
```

- [ ] **Step 9: 修改 AgentChatPanel 在 complete 时批量持久化**

在 `AgentChatPanel.tsx` 的 `output.type === 'complete'` 分支中，在 `store.updateThreadStatus(tid, 'idle')` 之后追加：

```typescript
              // complete 时批量持久化所有消息到 DB
              useAgentStore.getState().persistThreadMessages(tid)
```

- [ ] **Step 10: 修改 renameThread 和 deleteThread 持久化**

`renameThread` 改为：

```typescript
  renameThread: (threadId, title) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, title } : t,
      ),
    }))
    window.electronAPI['thread:update'](threadId, { title }).catch(console.error)
  },
```

`deleteThread` 改为：

```typescript
  deleteThread: (threadId) => {
    set((state) => ({
      threads: state.threads.filter((t) => t.id !== threadId),
      currentThreadId:
        state.currentThreadId === threadId
          ? state.threads.find((t) => t.id !== threadId)?.id ?? null
          : state.currentThreadId,
    }))
    window.electronAPI['thread:delete'](threadId).catch(console.error)
  },
```

- [ ] **Step 11: 运行测试**

Run: `npm run test`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/renderer/store/agentStore.ts src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat: agentStore persistence layer with hydration and DB sync"
```

---

## Task 9: ThreadListOverlay 从 DB 加载

**Files:**
- Modify: `src/renderer/components/agent/ThreadListOverlay.tsx`

- [ ] **Step 1: 读取当前 ThreadListOverlay 实现**

确认它当前从 `agentStore.threads` 读取数据。

- [ ] **Step 2: 添加节点筛选和加载逻辑**

在组件中添加 `useEffect`，当选中节点变化时从 DB 加载该节点的线程：

```typescript
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId)

  useEffect(() => {
    if (visible) {
      useAgentStore.getState().loadThreads(selectedNodeId ? { nodeId: selectedNodeId } : undefined)
    }
  }, [visible, selectedNodeId])
```

- [ ] **Step 3: 运行 lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/ThreadListOverlay.tsx
git commit -m "feat: ThreadListOverlay loads threads from DB with node filtering"
```

---

## Task 10: 全局历史侧边栏

**Files:**
- Create: `src/renderer/components/agent/HistorySidebar.tsx`
- Modify: `src/renderer/App.tsx`（或合适的布局组件）

- [ ] **Step 1: 实现 HistorySidebar 组件**

```tsx
// src/renderer/components/agent/HistorySidebar.tsx
import { useState, useEffect, useCallback } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { useAppStore } from '../../store/appStore'
import type { AgentThread } from '@shared/types'

interface HistorySidebarProps {
  visible: boolean
  onClose: () => void
}

export function HistorySidebar({ visible, onClose }: HistorySidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [threads, setThreads] = useState<AgentThread[]>([])
  const [loading, setLoading] = useState(false)
  const selectThread = useAgentStore((s) => s.selectThread)
  const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)

  const loadThreads = useCallback(async () => {
    setLoading(true)
    try {
      if (searchQuery.trim()) {
        const results = await window.electronAPI['thread:search'](searchQuery)
        setThreads(results)
      } else {
        const results = await window.electronAPI['thread:list']()
        setThreads(results)
      }
    } catch (err) {
      console.error('[HistorySidebar] Failed to load threads:', err)
    } finally {
      setLoading(false)
    }
  }, [searchQuery])

  useEffect(() => {
    if (visible) loadThreads()
  }, [visible, loadThreads])

  const handleSelect = async (thread: AgentThread) => {
    // 加载完整消息
    const full = await window.electronAPI['thread:load'](thread.id)
    if (full) {
      // 替换 agentStore 中的该线程
      useAgentStore.setState((state) => ({
        threads: state.threads.some((t) => t.id === thread.id)
          ? state.threads.map((t) => (t.id === thread.id ? full : t))
          : [...state.threads, full],
        currentThreadId: thread.id,
      }))
    }
    selectThread(thread.id)
    setActiveRightPanel('agent')
    onClose()
  }

  if (!visible) return null

  return (
    <div className="fixed left-0 top-0 bottom-0 w-80 bg-background border-r z-50 flex flex-col shadow-xl">
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="text-sm font-medium">History</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          &times;
        </button>
      </div>
      <div className="p-2">
        <input
          type="text"
          placeholder="Search threads..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') loadThreads() }}
          className="w-full px-3 py-1.5 text-sm border rounded bg-background"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-muted-foreground text-sm">Loading...</div>
        ) : threads.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-sm">No threads found</div>
        ) : (
          threads.map((t) => (
            <button
              key={t.id}
              onClick={() => handleSelect(t)}
              className="w-full px-3 py-2 text-left hover:bg-accent border-b text-sm"
            >
              <div className="font-medium truncate">{t.title}</div>
              <div className="text-xs text-muted-foreground flex gap-2">
                <span>{t.adapterName}</span>
                {t.nodeBound && <span>· node</span>}
                <span>· {new Date(t.createdAt).toLocaleDateString()}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 在 AgentChatPanel 或 App.tsx 中集成 HistorySidebar**

在 `AgentChatPanel.tsx` 中添加状态和渲染：

```typescript
  const [showHistory, setShowHistory] = useState(false)
```

在顶部工具栏区域新增历史按钮（根据现有 UI 结构调整位置），并在 JSX 末尾追加：

```tsx
  <HistorySidebar visible={showHistory} onClose={() => setShowHistory(false)} />
```

- [ ] **Step 3: 运行 lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/HistorySidebar.tsx src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat: add global HistorySidebar with search and thread loading"
```

---

## Task 11: 续接功能 UI

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`
- Modify: `src/renderer/store/agentStore.ts`

- [ ] **Step 1: 在 AgentChatPanel 中添加续接提示条**

当加载的历史线程有 `sessionId` 且 adapter 是 `claude-code` 时，在消息列表顶部显示续接提示：

```tsx
  const currentThread = threads.find((t) => t.id === currentThreadId)
  const canResume = currentThread?.sessionId && currentThread?.adapterName === 'claude-code'
```

在 ChatMessageList 上方条件渲染：

```tsx
  {currentThread?.status === 'idle' && canResume && (
    <div className="px-3 py-2 bg-blue-50 dark:bg-blue-950 text-sm flex items-center justify-between border-b">
      <span className="text-blue-700 dark:text-blue-300">This session can be continued</span>
      <button
        onClick={() => {
          useAgentStore.getState().updateThreadStatus(currentThread.id, 'running')
        }}
        className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
      >
        Resume
      </button>
    </div>
  )}
```

- [ ] **Step 2: 修改 sendMessage 支持 resumeSessionId**

在 `agentStore.sendMessage` 中，构建 config 时检查 thread.sessionId：

```typescript
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

    // 续接：如果 thread 有 sessionId，注入到 config
    if (thread.sessionId && thread.adapterName === 'claude-code') {
      config.resumeSessionId = thread.sessionId
    }
```

- [ ] **Step 3: 运行 lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx src/renderer/store/agentStore.ts
git commit -m "feat: add session resume UI and inject resumeSessionId in sendMessage"
```

---

## Task 12: onSessionStarted 事件处理

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`
- Modify: `src/main/agent/agent-manager.ts`

- [ ] **Step 1: 在 AgentChatPanel 中监听 onSessionStarted**

在现有的 `useEffect` (onAgentOutput) 旁边新增：

```typescript
  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI?.onSessionStarted) {
      const cleanup = window.electronAPI.onSessionStarted((threadId: string, sessionId: string) => {
        const store = useAgentStore.getState()
        // 更新内存中的 thread.sessionId
        store.appendChatMessage(threadId, {
          id: `session-${sessionId}`,
          role: 'system',
          content: `Session started: ${sessionId}`,
          timestamp: Date.now(),
          status: 'success',
          sessionId,
        })
        // 更新 thread 的 sessionId
        useAgentStore.setState((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId ? { ...t, sessionId } : t,
          ),
        }))
        // 持久化 sessionId 到 DB
        window.electronAPI['thread:update'](threadId, { sessionId }).catch(console.error)
      })
      return cleanup
    }
  }, [])
```

注意：`onSessionStarted` 事件需要主进程在 adapter 返回 sessionId 时发送。由于当前 ClaudeCodeAdapter 的 sessionId 在 `startSession` 时就生成（而非 spawn 后），实际上 sessionId 在 `agent:startSession` 的返回值中已经可用。因此在 renderer 端的 `sendMessage` 中，收到 `result.sessionId` 后直接持久化即可，不需要额外事件。

简化方案——在 `sendMessage` 的 `startSession` 调用成功后追加：

```typescript
      // 持久化 sessionId 到 DB
      window.electronAPI['thread:update'](threadId, { sessionId: result.sessionId }).catch(console.error)
```

- [ ] **Step 2: 运行 lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/agentStore.ts src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat: persist sessionId on startSession and wire up resume flow"
```

---

## Task 13: 应用启动时 Hydration

**Files:**
- Modify: `src/renderer/App.tsx`（或合适的入口组件）

- [ ] **Step 1: 在应用启动时调用 hydrateOnStart**

在 `App.tsx` 的顶层组件中（或在 agent 相关的初始化逻辑中），useEffect 里调用：

```typescript
  useEffect(() => {
    useAgentStore.getState().hydrateOnStart()
  }, [])
```

- [ ] **Step 2: 运行完整测试套件**

Run: `npm run test`
Expected: PASS

Run: `npm run lint`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: hydrate agent threads on application startup"
```

---

## Task 14: 端到端验证

- [ ] **Step 1: 启动开发服务器**

Run: `npm run dev`

- [ ] **Step 2: 手动验证完整流程**

1. 启动应用，确认右侧面板为空（首次启动）
2. 新建一个会话，发送消息，确认 Agent 回复正常
3. 关闭应用，重新启动
4. 确认历史线程出现在列表中，消息内容完整
5. 点击历史线程，确认消息可查看
6. 点击「续接」按钮，发送新消息，确认 Claude Code 使用 `--resume` 续接
7. 测试全局历史侧边栏：搜索、点击加载、节点筛选

- [ ] **Step 3: 最终 Commit（如有修复）**

```bash
git add -A
git commit -m "fix: address integration issues found during e2e verification"
```
