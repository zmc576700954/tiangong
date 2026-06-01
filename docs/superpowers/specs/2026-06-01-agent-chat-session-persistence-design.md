# Agent Chat 会话记录持久化设计

日期：2026-06-01

## 目标

为 BizGraph 的 AgentChat 功能添加完整的会话记录持久化能力，实现：
1. 聊天历史持久存储，关闭应用后不丢失
2. 基于 Claude Code 原生 `--session-id` / `--resume` 的会话续接
3. 按思维导图节点绑定 + 全局搜索的历史管理

## 背景

当前状态：
- `ChatMessage`、`AgentThread` 类型已定义（`src/shared/types.ts`）
- Zustand `agentStore` 在运行时持有所有 threads 和 messages
- 关闭应用后所有聊天记录丢失
- `agent_logs` 表只记录执行级元数据，不是面向用户的聊天历史
- Claude Code adapter 是 one-shot 模式，但 CLI 原生支持 `--session-id`、`--resume`、`--continue` 续接

Claude Code CLI 已验证支持的续接标志：
- `--session-id <uuid>`：指定 session ID
- `--resume <id-or-name>`：续接指定会话
- `--continue`：续接当前目录最近会话

## 方案

利用 Claude Code 原生 `--session-id` 能力，在 BizGraph DB 中存储线程元数据和消息快照，续接时将 sessionId 传回 CLI。其他 adapter（Codex/OpenCode）先做纯记录，后续渐进增强。

---

## 数据模型

### chat_threads 表

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `generateId('thread_')` |
| `title` | TEXT | 线程标题（自动取首条用户消息前 20 字符，或用户手动重命名） |
| `adapter_name` | TEXT | `'claude-code'` / `'codex'` 等 |
| `node_id` | TEXT nullable | 绑定的思维导图节点 ID |
| `graph_id` | TEXT nullable | 所属图 ID |
| `session_id` | TEXT nullable | Claude Code 原生 sessionId，用于 `--resume` |
| `status` | TEXT | `'active'` / `'archived'` |
| `created_at` | INTEGER | unix timestamp |
| `updated_at` | INTEGER | unix timestamp（最后一条消息时间） |

### chat_messages 表

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `generateId('msg_')` |
| `thread_id` | TEXT FK | 关联 thread（ON DELETE CASCADE） |
| `role` | TEXT | `'user'` / `'assistant'` / `'system'` |
| `content` | TEXT | 消息正文（markdown） |
| `adapter_name` | TEXT | 冗余存储，便于不 join 直接查询 |
| `status` | TEXT | `'success'` / `'error'` / `'pending'` |
| `error` | TEXT nullable | 错误信息 |
| `session_id` | TEXT nullable | 该消息对应的 Agent session ID |
| `context_refs` | TEXT nullable | JSON，`ContextRef[]` 序列化 |
| `tool_calls` | TEXT nullable | JSON，工具调用详情（预留） |
| `created_at` | INTEGER | unix timestamp |

### 与 agent_logs 的关系

`agent_logs` 保持不变，是执行级日志（命令、耗时、结果）。`chat_messages` 是面向用户的聊天记录。两者可通过 `session_id` 关联查询。

---

## IPC 层

### 现有 IPC 通道改动

```
agent:startSession(adapterName, config)         // config 新增可选 resumeSessionId
agent:resolveAndSendCommand(sessionId, command, contextRefs, nodeIds, threadId?)  // 新增可选 threadId
agent:onSessionStarted(threadId, sessionId)     // 新增事件通道，主进程 → renderer
```

### 新增 IPC 通道（加入 IpcApi）

```
thread:list(filters?)          → ChatThread[]      // 按 node/graph 筛选，或全量
thread:load(threadId)          → ChatThread & messages
thread:create(data)            → ChatThread
thread:update(threadId, data)  → void
thread:delete(threadId)        → void
thread:search(query)           → ChatThread[]       // 全局全文搜索

message:list(threadId)         → ChatMessage[]
message:save(message)          → void
message:saveBatch(messages)    → void
```

### 服务层：ChatService

新建 `src/main/services/chat-service.ts`：
- 线程 CRUD
- 消息存储
- 自动命名（取首条用户消息前 20 字符）
- session_id 回写

### 持久化触发点

在 `ipc-handlers.ts` 的 `broadcaster.onBroadcast` 中，除转发 BrowserWindow 外同时调用 ChatService：

- **`stdout` 时不写 DB**：流式输出只存 renderer 内存，保证性能
- **`complete` 时**：将当前 thread 中所有未保存消息批量写入 `chat_messages`，更新 `chat_threads.updated_at`
- **用户发消息时**：renderer 端立即调用 `message:save`（防崩溃丢失）

### session_id 回写流程

```
用户发送消息 → AgentChatPanel 调用 agent:resolveAndSendCommand(sessionId, command, contextRefs, nodeIds, threadId)
  → AgentManager 将 threadId 挂在 session 上，传给 adapter
  → ClaudeCodeAdapter.sendCommand() 执行完毕后在 output 中返回 sessionId
  → AgentManager 在 broadcast 前检查：若 threadId 存在且 sessionId 是新值，
    额外发出 "agent:onSessionStarted" 事件（threadId, sessionId）
  → renderer 收到后更新 thread.sessionId（内存 + DB via ChatService）
```

### sessionId 传入 adapter 的方式

ClaudeCodeAdapter 现有 `startSession(config)` 的 config 中扩展一个可选字段：
```typescript
interface AgentConfig {
  // ...现有字段
  resumeSessionId?: string  // 非空时 spawn 命令加 --resume <id>
}
```

续接时 renderer 调用 `agent:startSession(adapterName, { ...config, resumeSessionId: thread.sessionId })`，adapter 据此在 spawn 命令中拼接 `--resume` 标志。

---

## UI 层

### 右侧面板（AgentChatPanel 扩展）

- ThreadListOverlay 改造：从 DB 加载历史线程，显示标题、更新时间、绑定节点名、adapter 图标
- 点击历史线程 → 只读模式加载消息（`thread:load`）
- 有 `sessionId` 且 adapter 是 `claude-code` → 显示「续接」按钮
- 新建线程时自动绑定当前选中节点

### 全局历史侧边栏

- 顶部工具栏新增「历史记录」图标按钮
- 左侧滑出侧边栏，含搜索框 + 节点筛选
- 搜索调用 `thread:search(query)`，全文匹配标题和消息内容
- 点击线程 → 右侧面板切换到 agent 模式加载该线程
- 右键菜单：重命名、归档、删除

### 状态管理（agentStore 扩展）

```typescript
loadThreads(nodeId?: string)     // 从 DB 加载
loadMessages(threadId: string)   // 按需加载消息
saveMessage(message: ChatMessage) // 写入 DB
hydrateOnStart()                  // 启动时加载最近 N 条线程
```

---

## 数据流

### 续接场景

1. 用户在历史侧边栏点击线程 → `agentStore.loadMessages(threadId)`
2. 右侧面板显示历史消息（只读），顶部提示「此会话可续接」
3. 用户点击「续接」→ thread 切换为 active
4. 用户输入 → 检查 `thread.sessionId`，config 注入 `--resume <sessionId>`
5. 用户消息立即 `message:save`
6. Agent 返回 stdout → 流式追加到内存（现有逻辑不变）
7. complete → `message:saveBatch`，更新 `thread.updated_at`

### 新建场景

1. 用户点击「新建会话」→ `thread:create({ nodeId, adapterName })`
2. thread 立即写入 DB
3. `agent:startSession` → adapter 返回 sessionId → `agent:onSessionStarted`
4. `ChatService.updateThread(threadId, { sessionId })`
5. 后续消息流同现有逻辑，complete 时批量落盘

---

## 错误处理

| 场景 | 处理方式 |
|---|---|
| DB 写入失败 | catch 后 console.error，不阻断用户操作 |
| `--resume` 时 session 文件已清理 | Claude Code 启动新 session，adapter 清空 thread.sessionId，降级为新会话 |
| 应用中途崩溃 | 已 save 的用户消息不丢失；未 complete 的 assistant 消息标记为 `pending`，重启后显示灰色 |
| 线程删除 | ON DELETE CASCADE 级联删除 messages，清理内存 |

---

## 不做的事

- 不改造现有 adapter 核心逻辑，ClaudeCodeAdapter 仅新增 sessionId 参数支持
- 不改变流式输出行为，DB 只在 complete 时写入 assistant 消息
- 不改变 `agent_logs` 表结构和逻辑
- 不在第一版支持跨 adapter 的 session 续接（Codex/OpenCode 先做纯记录）
