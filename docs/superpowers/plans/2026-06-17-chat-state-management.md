# Chat会话状态管理优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 拆分573行agentStore为4个专注store，重写MessageQueue替代朴素流式拼接，实现SessionRecoveryManager，增加确认项管理和中断恢复

**Architecture:** 将agentStore按职责拆分为adapterStore/threadStore/sessionStore/messageStore，通过EventBus解耦通信。MessageQueue作为消息发送的中间层实现并发控制和去重。SessionRecoveryManager在主进程监听进程异常并自动恢复。

**Tech Stack:** TypeScript, Zustand, Electron IPC, Vitest

---

## File Structure

### New Files
- `src/renderer/store/adapterStore.ts` — 适配器管理
- `src/renderer/store/threadStore.ts` — 线程CRUD+选择
- `src/renderer/store/sessionStore.ts` — 会话生命周期
- `src/renderer/store/messageStore.ts` — 消息发送+流式处理
- `src/renderer/store/__tests__/adapterStore.test.ts`
- `src/renderer/store/__tests__/threadStore.test.ts`
- `src/renderer/store/__tests__/sessionStore.test.ts`
- `src/renderer/store/__tests__/messageStore.test.ts`
- `src/main/agent/session-recovery.ts` — SessionRecoveryManager

### Modified Files
- `src/renderer/store/agentStore.ts` — 重写为从4个新store re-export（向后兼容过渡）
- `src/renderer/store/eventBus.ts` — 增加新事件类型
- `src/renderer/hooks/useAgentOutputListener.ts` — 接入MessageQueue
- `src/main/agent/agent-manager.ts` — 接入SessionRecoveryManager
- `src/main/adapters/base.ts` — 进程exit code分类处理

---

## Task 1: EventBus 事件扩展

**Files:**
- Modify: `src/renderer/store/eventBus.ts`

增加新事件：

```typescript
SESSION_STARTED: 'session:started'
SESSION_TERMINATED: 'session:terminated'
SESSION_CRASHED: 'session:crashed'
STREAMING_CHUNK: 'streaming:chunk'
MESSAGE_SENT: 'message:sent'
MESSAGE_FAILED: 'message:failed'
ADAPTER_HEALTH_CHANGE: 'adapter:healthChange'
CONFIRMATION_REQUIRED: 'confirmation:required'
CONFIRMATION_RESPONDED: 'confirmation:responded'
```

运行测试后 commit。

---

## Task 2: adapterStore 提取

**Files:**
- Create: `src/renderer/store/adapterStore.ts`
- Create: `src/renderer/store/__tests__/adapterStore.test.ts`

从 agentStore 提取所有适配器相关状态和方法：

**State:** adapters[], adapterPreferences, marketplaceItems, openSettingsPanel
**Methods:** loadAdapters, loadAdapterPreferences, setAdapterPreferences, loadMarketplaceItems, setOpenSettingsPanel

测试：initial state、loadAdapters、setAdapterPreferences

---

## Task 3: threadStore 提取

**Files:**
- Create: `src/renderer/store/threadStore.ts`
- Create: `src/renderer/store/__tests__/threadStore.test.ts`

从 agentStore 提取所有线程相关状态和方法：

**State:** threads[], currentThreadId
**Methods:** createThread, deleteThread, selectThread, renameThread, loadThreads, updateThreadStatus, findThreadBySessionId, getThreadByNodeId, loadMessages

测试：createThread adds to list、selectThread updates currentThreadId、deleteThread removes from list

---

## Task 4: messageStore 提取（含MessageQueue）

**Files:**
- Create: `src/renderer/store/messageStore.ts`
- Create: `src/renderer/store/__tests__/messageStore.test.ts`

从 agentStore 提取所有消息相关状态和方法，并实现MessageQueue：

**State:** streamingStates (Map<threadId, {messageId, seq}>), sendQueue (Map<threadId, {status, command, abortController}>), pendingConfirmations (Map<messageId, {toolCall, accepted}[]>)

**Methods:**
- sendMessage(threadId, content, contextRefs?, sessionConfig?) — 入队，设状态为 queued
- processQueue() — 每适配器最多1个活跃请求，从队列取下一个执行
- appendStreamingMessage(threadId, messageId, content, seq) — chunk去重：相同seq丢弃
- markMessageStatus(threadId, messageId, status, error?)
- appendToolCall / updateToolCallAccepted / updateAllToolCallsAccepted
- retryMessage(threadId, agentMessageId)
- cancelQueued(threadId) — 取消排队中的消息
- confirmToolCall(messageId, toolCallIndex, accepted)

**MessageQueue 逻辑：**
- sendMessage 时入队 {status:'queued', command, abortController}
- processQueue 检查：当前适配器是否已有活跃请求
- 如果没有活跃请求，出队执行，status → 'sending'
- 执行完成 status → 'completed'，触发 processQueue 处理下一个
- 相同 threadId + 相同 content 5秒内去重

---

## Task 5: sessionStore 提取

**Files:**
- Create: `src/renderer/store/sessionStore.ts`
- Create: `src/renderer/store/__tests__/sessionStore.test.ts`

从 agentStore 提取所有会话生命周期相关状态和方法：

**State:** activeSessions (Map<threadId, {sessionId, adapterName, startTime, status}>)

**Methods:**
- startSession(threadId, adapterName, config) — IPC调用，注册session
- resumeSession(threadId, sessionId, adapterName) — 注入resumeSessionId重连
- terminateSession(threadId) — IPC调用，清理session
- getSessionStatus(threadId)
- listenForStatusChanges() — IPC onAgentStatusChange → 更新session状态 + emit EventBus事件

---

## Task 6: agentStore 重写为过渡层

**Files:**
- Modify: `src/renderer/store/agentStore.ts`

将agentStore重写为从4个新store re-export，保持向后兼容：

```typescript
import { useAdapterStore } from './adapterStore'
import { useThreadStore } from './threadStore'
import { useSessionStore } from './sessionStore'
import { useMessageStore } from './messageStore'

// 向后兼容：将4个store的方法合并到一个接口
export const useAgentStore = create<AgentState>((set, get) => ({
  // 代理到各子store
  adapters: useAdapterStore.getState().adapters,
  threads: useThreadStore.getState().threads,
  // ... 各方法代理
}))
```

这是过渡方案——后续可以逐步替换组件中的直接import。所有现有组件无需修改。

---

## Task 7: SessionRecoveryManager

**Files:**
- Create: `src/main/agent/session-recovery.ts`
- Modify: `src/main/agent/agent-manager.ts`
- Modify: `src/main/adapters/base.ts`

**SessionRecoveryManager 类：**

```typescript
interface RecoveryStrategy {
  adapterName: string
  canResume: boolean
  resume(sessionId: string, context: string): Promise<string> // returns new sessionId
}

class SessionRecoveryManager {
  private strategies: Map<string, RecoveryStrategy>
  private recoveryAttempts: Map<string, number> // sessionId -> attempt count
  private maxRetries = 3

  registerStrategy(strategy: RecoveryStrategy): void
  async attemptRecovery(sessionId: string, adapterName: string, lastOutputs: AgentOutput[]): Promise<string | null>
}
```

策略：
- **claude-code**: 自动 --resume <sessionId>
- **mcp-adapter**: 创建新会话，注入最近3条消息作为上下文
- **其他CLI**: 新建会话，通知用户确认

在 AgentManager 中：
- `onSessionEnded` 回调中，如果 reason='crash' 且 recoveryAttempts < 3，调用 attemptRecovery
- 恢复后发送 SESSION_RECOVERED 事件到renderer

在 BaseAdapter 中：
- exit code 分类处理：137/143 不重试，1 自动重试1次（需ScopeGuard回滚），126/127 标记不可用

---

## Task 8: 确认项管理

**Files:**
- Modify: `src/renderer/store/messageStore.ts`
- Modify: `src/renderer/hooks/useAgentOutputListener.ts`
- Modify: `src/renderer/store/eventBus.ts`

实现：
1. 在 useAgentOutputListener 中，当收到 file_change 输出时，检查是否为高风险操作（删除文件、修改配置、变更>5文件）
2. 高风险操作触发时，emit CONFIRMATION_REQUIRED 事件
3. messageStore 中 pendingConfirmations 存储待确认项
4. 组件监听 CONFIRMATION_REQUIRED 显示确认对话框
5. 用户确认/拒绝后 emit CONFIRMATION_RESPONDED
6. 确认后继续执行，拒绝则调用 ScopeGuard.rollbackFile

---

## Task 9: 临时中断恢复

**Files:**
- Modify: `src/renderer/store/sessionStore.ts`
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

实现：
1. sessionStore 增加 sessionSnapshots (Map<threadId, {messages, outputs, filesChanged}>)
2. 每次 Agent 返回结果后，自动保存快照
3. stopCurrentSession 时保留sessionId（不立即清除）
4. 重新打开已中断线程时，检查是否有快照
5. 如果有快照，显示"继续上次会话"提示条
6. 用户选择继续时，调用 resumeSession 注入上下文

---

## Task 10: 最终验证

- [ ] 全量单元测试 — `npx vitest run`
- [ ] 类型检查 — `npx tsc --noEmit`
- [ ] Lint — `npm run lint`
- [ ] 最终 Commit
