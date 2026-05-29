# Agent Chat 集成增强设计

日期：2026-05-29

## 背景

当前 Agent Chat 功能存在以下问题：

1. **无终止能力** — Agent 运行时整个输入框被 disabled，用户无法取消
2. **无重试/撤回** — 消息发出后不可操作，失败只能新建 Thread
3. **错误被吞掉** — `onAgentOutput` 收到 `type='error'` 时只更新 thread status，不创建可见消息
4. **ChatMessage 无状态字段** — 每条消息没有 pending/error/aborted 等生命周期状态

参考 Vercel AI SDK `useChat` hook 的状态模型和 Open WebUI 的消息操作模式，提出以下设计方案。

---

## 一、消息生命周期模型

### 类型定义

```typescript
/** 消息状态 */
type MessageStatus =
  | 'pending'     // 用户消息刚发出，等待 agent 响应
  | 'streaming'   // agent 正在输出
  | 'success'     // agent 正常完成
  | 'error'       // 出错
  | 'aborted'     // 用户主动终止

/** 消息错误信息 */
interface MessageError {
  code: string       // 错误码
  message: string    // 用户可读描述
  raw?: string       // 原始错误数据（可选）
}

/** ChatMessage 扩展 */
interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  timestamp: number
  adapterName?: string
  toolCalls?: ToolCallBlock[]
  contextRefs?: ContextRef[]
  status: MessageStatus      // 新增
  error?: MessageError       // 新增
  sessionId?: string         // 新增，关联 agent session
}
```

### 状态流转

```
user 消息:  pending ──────────────────→ (隐式完成，收到 agent 输出后无需更新)

agent 消息: streaming → success        (正常完成)
            streaming → error          (agent 返回 error/异常)
            streaming → aborted        (用户主动终止)
            pending   → error          (session 启动失败)
```

---

## 二、UI 交互设计

### 2.1 输入栏（ChatInput）

Agent 运行时 Send 按钮变为 Stop 按钮：

- **Send 状态**：绿色，`<Send />` 图标，点击发送消息
- **Stop 状态**：红色，`<Square />` 图标，点击终止当前 session
- Stop 后 textarea 立即可用，用户可继续输入

### 2.2 消息操作栏（ChatBubble）

每条 agent 消息底部增加操作按钮组，hover 时显示：

- **Retry** — 重新发送该消息对应的用户消息（找前一条 user 消息重新 `sendMessage`）
- **Copy** — 复制消息内容到剪贴板

用户消息不显示操作栏。

### 2.3 错误状态渲染

`message.status === 'error'` 时：

- 红色边框 + 浅红背景
- 错误图标 + 用户可读描述
- 原始错误可折叠查看（`<details>` 或展开按钮）
- 保留 Retry 按钮

### 2.4 aborted 状态渲染

用户主动终止时：

- 保留已输出的部分内容（不丢失）
- 灰色 "已终止" 标签
- 仍然可以 Retry

---

## 三、错误捕获与数据流

### 3.1 错误分类码

| errorCode | 含义 | 可重试 |
|-----------|------|--------|
| `AGENT_CRASH` | 进程异常退出 | 是 |
| `AGENT_NOT_FOUND` | CLI 工具未安装 | 否 |
| `TIMEOUT` | 执行超时 | 是 |
| `SCOPE_VIOLATION` | 范围越界被 ScopeGuard 拦截 | 否 |
| `CONFIG_ERROR` | 配置错误 | 否 |
| `SESSION_START_FAILED` | 会话启动失败 | 是 |
| `UNKNOWN` | 未分类 | 是 |

### 3.2 onAgentOutput 改造

当前逻辑（AgentChatPanel 第 58-90 行）：

```typescript
// 错误：只更新 thread status，不创建消息
if (output.type === 'complete' || output.type === 'error') {
  updateThreadStatus(currentThreadId, output.type === 'error' ? 'error' : 'idle')
  return
}
```

改造为：

```
收到 output
  ├─ type === 'error'
  │    ├─ 创建/更新最后一条 agent 消息：status='error', error={code, message}
  │    └─ 更新 thread status = 'error'
  │
  ├─ type === 'complete'
  │    ├─ 最后一条 agent 消息 status = 'success'
  │    └─ 更新 thread status = 'idle'
  │
  ├─ type === 'stdout' | 'file_change'
  │    ├─ 如果当前无 streaming agent 消息 → 创建 status='streaming'
  │    ├─ 追加内容到该消息
  │    └─ thread status = 'running'
  │
  └─ type === 'stderr'
       ├─ 追加到当前 agent 消息（带警告样式）
       └─ 不改变 status
```

### 3.3 sendMessage 改造

- 成功启动 session 后，记录 `sessionId` 到 thread
- catch 块创建错误消息（而非只设 thread status）：

```typescript
catch (err) {
  appendChatMessage(threadId, {
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
  updateThreadStatus(threadId, 'error')
}
```

### 3.4 Stop 流程

```
用户点击 Stop
  ├─ terminateSession(sessionId)
  ├─ 找到 thread 中最后一条 status='streaming' 的 agent 消息
  ├─ 设为 status='aborted'（保留已输出内容）
  └─ thread status = 'idle'，输入框恢复可用
```

### 3.5 Retry 流程

```
用户点击 Retry（在某条 agent 消息上）
  ├─ 找到该消息的前一条 user 消息
  ├─ 删除该 agent 消息及之后的所有消息
  ├─ 重新调用 sendMessage(threadId, userMessage.content, userMessage.contextRefs)
  └─ thread status = 'running'
```

---

## 四、变更文件清单

### 类型层

| 文件 | 变更 |
|------|------|
| `src/shared/types.ts` | 新增 `MessageStatus`、`MessageError`；扩展 `ChatMessage`（+status, error, sessionId）；扩展 `AgentOutput`（+errorCode）；扩展 `AgentThread`（+sessionId） |

### Store 层

| 文件 | 变更 |
|------|------|
| `src/renderer/store/agentStore.ts` | `sendMessage` 改造（sessionId 记录 + catch 创建错误消息）；新增 `stopCurrentSession`、`retryMessage`、`markMessageStatus` 方法 |

### UI 层

| 文件 | 变更 |
|------|------|
| `src/renderer/components/agent/ChatInput.tsx` | 运行时显示 Stop 按钮；新增 `onStop` / `isRunning` props |
| `src/renderer/components/agent/ChatBubble.tsx` | 按 status 渲染不同样式；错误内联展示；新增操作栏（Retry/Copy） |
| `src/renderer/components/agent/ChatMessageList.tsx` | 透传 `onRetry` 回调给 ChatBubble |
| `src/renderer/components/agent/AgentChatPanel.tsx` | onAgentOutput 改造；接入 stopCurrentSession / retryMessage |

### Main 进程侧

| 文件 | 变更 |
|------|------|
| `src/main/adapters/*.ts` | error 输出携带 errorCode |
| `src/main/ipc/agent.ts` | 无需改动（terminate 通道已有） |
| `src/main/services/agent-service.ts` | 无需改动 |

### 不改动

- 数据库 schema（ChatMessage 存内存不持久化）
- ScopeGuard 逻辑
- TerminalView / ThreadListOverlay

---

## 五、参考来源

- [Vercel AI SDK `useChat` hook](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) — 消息状态模型（submitted/streaming/ready/error）、stop/regenerate/clearError API
- [Open WebUI Messages.svelte](https://github.com/open-webui/open-webui) — 树状消息结构、regenerateResponse、editMessage、deleteMessage 的实现模式
- Continue.dev GUI — 消息操作按钮组（Copy/Regenerate/Delete）的 UI 模式
