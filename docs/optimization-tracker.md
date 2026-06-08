# BizGraph 代码库可优化项清单

> 审计日期：2026-06-05
> 范围：src/main + src/renderer + src/shared，排除 bizgraph/ 旧版目录
> 上下文：前序 12 项修复已完成（TS 0 errors, ESLint 0 warnings, 252 tests pass）

---

## P0 — 关键缺陷 / 性能瓶颈

### 1. AgentChatPanel 是 500+ 行的 God Component

**文件**: `src/renderer/components/agent/AgentChatPanel.tsx`

**问题**: 单组件承载 IPC 输出处理、验证流程、Diff 审查、上下文管理、线程切换、拖拽调整等 6 大职责。30+ useState、10+ useEffect，难以推理和测试。

**建议**: 拆分为：
- `useAgentOutputListener()` — IPC 输出 → store 的副作用 hook
- `useVerificationFlow()` — 验证/重试状态机 hook
- `useDiffReview()` — 提交/回滚/接受状态 hook
- `AgentChatPanel` — 仅组合上述 hooks + 渲染子组件

### 2. threadOutputs Map 无边界增长

**文件**: `src/renderer/store/agentStore.ts:60-73`

**问题**: `appendOutput` 对每个 thread 存储最多 1000 条 AgentOutput，但 thread 数量不限。50 个 thread × 1000 条 × ~1KB/条 = ~50MB。且 `slice(-1000)` 每次都创建新数组。

**建议**:
- 对非活跃 thread 的 outputs 做惰性清理（切换 thread 时裁剪到 100 条）
- 使用 RingBuffer 代替数组 slice
- 添加 `clearThreadOutputs(threadId)` action 供 terminate 时调用

### 3. stdout/stderr 拼接使用 `useAgentStore.setState` 直接替换整个 threads 数组

**文件**: `src/renderer/components/agent/AgentChatPanel.tsx:222-266`

**问题**: IPC 回调中直接调用 `useAgentStore.setState({ threads: ... })` 绕过了 store action，与 Zustand 中间件（devtools/persist）不兼容，且每次流式输出都创建完整的 threads 数组拷贝。

**建议**: 在 agentStore 中添加 `appendToStreamingMessage(threadId, content)` action，封装消息内容拼接逻辑。

---

## P1 — 重要问题

### 4. BizNode 3 次独立 `threads.find()` 查询

**文件**: `src/renderer/canvas/BizNode.tsx:27-38`

**问题**: `agentThreadId`、`agentStatus`、`agentSessionId` 各自独立调用 `s.threads.find(t => t.nodeBound === data.id)`。虽然每次返回标量值（引用稳定），但每次 selector 调用都遍历整个 threads 数组，N 个 BizNode × 3 次遍历 = 3N 次全量扫描。

**建议**: 合并为单次 selector：
```ts
const agentThreadInfo = useAgentStore((s) => {
  const t = s.threads.find(t => t.nodeBound === data.id)
  return t ? { id: t.id, status: t.status, sessionId: t.sessionId } : undefined
})
```

### 5. GraphCanvas graphNodes/graphEdges 整数组引用

**文件**: `src/renderer/canvas/GraphCanvas.tsx:56-57`

**问题**: `const graphNodes = useGraphStore((state) => state.nodes)` — 任何节点位置更新都导致整个 graphNodes 数组引用变化，触发 GraphCanvas 及所有子组件重渲染。

**建议**:
- 使用 `useShallow` 或选择特定节点子集
- 将 RF nodes/edges 同步逻辑放入 `useMemo`，仅在 graphNodes.length 或 ID 列表变化时重建

### 6. 验证服务每次创建新 Agent Session

**文件**: `src/main/ipc/agent.ts:60`

**问题**: `agent:verify` 每次调用 `agentManager.startSession()` 启动一个新的 Agent 会话，发送验证 prompt，等 60 秒超时。创建 session 会分配 sessionId、广播名、配置等资源，但验证完成后未调用 `terminateSession()`，导致 session 泄漏。

**建议**:
- 验证完成后调用 `agentManager.terminateSession(sessionId)`
- 或复用当前 thread 的已有 session（发送验证 prompt 作为普通命令）

### 7. ContextResolver 无文件读取缓存

**文件**: `src/main/context-resolver.ts:161-175`

**问题**: 每次 `resolveFile` 都执行 `readFile` 磁盘 IO。同一文件在多次 `resolveAndSendCommand` 中被重复读取（如用户反复附加上下文）。

**建议**: 添加简单的 TTL 缓存（Map<string, {content, timestamp}>），10 秒内命中缓存。

### 8. Database `SELECT *` 全表查询

**文件**: `src/main/repositories/chat-repository.ts:67-94`

**问题**: `getThread`、`listThreads`、`listMessages` 全部使用 `SELECT *`。`chat_messages` 表包含 `content`（可能很大）、`tool_calls`（JSON）等字段，`listThreads` 不需要消息内容。

**建议**:
- `listThreads` 使用 `SELECT id, title, adapter_name, node_id, graph_id, session_id, status, created_at, updated_at`
- `listMessages` 保持 `SELECT *`（确实需要所有字段）
- 添加索引：`CREATE INDEX IF NOT EXISTS idx_messages_thread ON chat_messages(thread_id, created_at)`

### 9. AgentChatPanel IPC 回调未清理 stale sessionId

**文件**: `src/renderer/components/agent/AgentChatPanel.tsx:128-267`

**问题**: `onAgentOutput` 回调通过 `_sessionId` 找到 thread 后操作 store。但 `useEffect` 依赖 `[currentThreadId]`，当切换 thread 时回调重新注册，但旧回调可能仍有 pending microtask 在执行。虽然 `streamingMsgIdRef` 是 ref 模式（安全），但存在理论上的竞态窗口。

**建议**: 在 IPC 回调开始处检查 `useAgentStore.getState().currentThreadId` 是否仍是目标 thread（对于 streaming 拼接场景）。

### 10. GraphCanvas 内联 onContextMenu 回调

**文件**: `src/renderer/canvas/GraphCanvas.tsx` (useCallback 依赖中的 context menu handler)

**问题**: 虽然 BizNodeComponent 已经 `memo`，但 `onContextMenu` 回调如果在父组件每次渲染时创建新引用，memo 会被击穿。

**建议**: 确保 `onContextMenu` 使用 `useCallback` 并稳定依赖。

---

## P2 — 改进项

### 11. Repository 层 `as unknown as` 类型断言

**文件**: `src/main/repositories/chat-repository.ts:71, 93, 132`

**问题**: `result.rows[0] as unknown as ChatThreadRow` — 双重类型断言绕过了类型检查。如果数据库 schema 变更（字段重命名/删除），编译不会报错。

**建议**: 添加运行时 schema 校验函数（`isChatThreadRow`），或使用 zod/io-ts 进行校验。

### 12. safeJsonParse 返回 `any`

**文件**: `src/main/shared/db-utils.ts` (由 chat-service.ts:7 引入)

**问题**: `safeJsonParse(row.error)`、`safeJsonParse(row.context_refs)` 等返回 `any`，绕过类型安全。

**建议**: 使用泛型 + 运行时校验：`safeJsonParse<T>(raw: string | null, fallback: T): T`

### 13. VerificationService.parseVerificationResponse 正则可优化

**文件**: `src/main/agent/verification-service.ts:56-63`

**问题**: 对每个 acceptance criterion 创建 3 个 RegExp。当 criteria 数量较多时（如 10+），正则匹配次数 = 10 × 3 × response.length，性能线性增长。

**建议**: 一次遍历 response，用单个正则 `CRITERION_(\d+):\s*(PASS|FAIL)` 提取所有结果，再遍历 justification。

### 14. OutputBroadcaster 无错误隔离

**文件**: `src/main/agent/output-broadcaster.ts:20-28`

**问题**: `broadcast()` 中任一 handler 抛出异常会中断后续 handler 的执行（虽然有 try/catch，但 catch 只记录日志不跳过）。实际已有 try/catch 包裹单个 handler，所以这不是真正的阻断问题。

**现状**: 代码已正确实现，此项降级为文档说明建议。

### 15. AgentManager 多 Map 管理 session 状态

**文件**: `src/main/agent/agent-manager.ts:28-40`

**问题**: 6 个独立 Map（outputHandlers, outputListeners, sandboxes, broadcastNames, sessionConfigs, sessionAdapterNames）+ 1 个 sessionEndedHandlers，生命周期分散在 startSession、terminateSession、cleanupSessionResources 中手动管理。

**建议**: 将 session 相关状态封装为 `SessionState` 类型：
```ts
interface SessionState {
  config: AgentSessionConfig
  broadcastName: string
  adapterName: string
  sandbox?: Sandbox
  sessionId: string
}
private sessionStates = new Map<string, SessionState>()
```

### 16. 缺少测试覆盖的模块

| 模块 | 文件 | 风险 |
|------|------|------|
| VerificationService | `src/main/agent/verification-service.ts` | 验证结果解析错误会导致误判通过/不通过 |
| ChatService | `src/main/services/chat-service.ts` | 消息持久化逻辑无测试 |
| ContextResolver | `src/main/context-resolver.ts` | Token 预算截断逻辑无测试 |
| BaseAdapter.parseFileChanges | `src/main/adapters/base.ts:482-529` | 文件变更解析错误会影响 DiffReview |

### 17. ScopeGuard 扫描锁竞态窗口

**文件**: `src/main/scope-guard.ts:477-508`

**问题**: `setInterval` 回调先检查 `this.scanTimers.get(sandboxId) !== timer`，再获取 sandbox。两个步骤之间 sandbox 可能被 cleanupSandbox 删除。虽然 `scanLocks` 防止了并发，但 timer 校验和 sandbox 获取不是原子操作。

**现状**: 实际影响很小（最多多扫描一次空目录），但设计不够严谨。

### 18. AgentChatPanel 拖拽调整高度未保存

**文件**: `src/renderer/components/agent/AgentChatPanel.tsx:63-78`

**问题**: `inputAreaHeight` 存储在组件 state 中，刷新后重置为默认值 120px。`hasResized` 状态仅用于 CSS 调整，未持久化到 localStorage。

**建议**: 使用 `localStorage.setItem('agentChatInputHeight', value)` 持久化用户偏好。

### 19. ChatBubble 复制功能的 fallback 路径

**文件**: `src/renderer/components/agent/ChatBubble.tsx:60-76`

**问题**: 使用已废弃的 `document.execCommand('copy')` 作为 fallback。在 Electron 环境中 `navigator.clipboard` 始终可用，fallback 是 dead code。

**建议**: 移除 fallback 路径，直接使用 `navigator.clipboard.writeText`。

### 20. `fs:registerProjectPaths` 信任客户端输入

**文件**: `src/main/ipc-handlers.ts:190-202`

**问题**: 渲染进程可以调用 `fs:registerProjectPaths` 将任意路径加入 session 允许列表。虽有 `validateFsPath` 校验，但该函数本身依赖 `graphService.getProjectPaths()` 作为允许根目录——如果数据库被注入恶意路径，攻击面扩大。

**现状**: 已有基本校验，但建议记录审计日志。

---

## 优化优先级总结

| 优先级 | 数量 | 建议执行顺序 |
|--------|------|-------------|
| P0 | 3 | 先修 #3（store action），再拆 #1（组件拆分），最后 #2（内存边界） |
| P1 | 7 | #6（session 泄漏）最紧急，#4（selector）最简单，#8（DB 索引）影响持久 |
| P2 | 10 | 按影响面排序：#16（测试）> #11（类型安全）> #18（UX） |

---

## 已完成的修复（前序 12 项）

| # | 内容 | 状态 |
|---|------|------|
| 1 | agent-manager config 提前删除导致状态变更失效 | Done |
| 2 | scopeGuard:rollbackSession 新增 IPC | Done |
| 3 | updateToolCallAccepted/updateAllToolCallsAccepted 不可变 store actions | Done |
| 4 | BizNode 按字段选择替代整对象引用 | Done |
| 5 | CodeBlock 提取到模块级 | Done |
| 6 | 验证重试流程 pendingRetryRef + effect 自动重触发 | Done |
| 7 | VerificationPanel error prop + commit 错误内联显示 | Done |
| 8 | currentOperation 透传到 RunningIndicator | Done |
| 9 | ToolCallRenderer stub 回调移除 | Done |
| 10 | NodeStatus 类型安全校验 | Done |
| 11 | Verification 使用项目路径替代空字符串 | Done |
| 12 | BizNode 仅选择当前线程的 outputs | Done |
