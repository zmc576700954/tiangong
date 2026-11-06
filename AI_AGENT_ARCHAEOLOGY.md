# BizGraph AI / Agent 体系代码考古报告（只读）

- 仓库：`/Users/zhumingchen/tiangong`（包名 `bizgraph`，版本 `0.1.0`）
- 日期：2026-11-04
- 性质：只读考古。除本报告文件外，未修改任何源码。
- 证据约定：每条结论后附 `file:///` 绝对路径与行号；行号为本次读取时的实际行号。

---

## 0. 结论先行

1. **AI 链路是「Electron 主进程内多适配器编排」**：渲染层 `AgentChatPanel` → preload `agent:*` IPC → 主进程 `AgentManager` → `AdapterRegistry` → 具体 `BaseAdapter` 子类。三种主要后端分别走 Claude Agent SDK、Codex SDK、OpenCode CLI；不是统一的子进程协议层。
2. **「会话地图」实际上是「节点 ↔ thread 的一对一投影」**：DB 有 `nodes` / `chat_threads` / `chat_messages`，但**没有 `agent_sessions` 表**；Agent 运行时状态只存在于主进程内存。节点本身没有「多分支历史」，`nodeThreadMap` 每个节点只保留最后一个 thread。
3. **没有运行时工具审批通道**。Claude 适配器用 `permissionMode: 'acceptEdits'` 自动接受编辑；渲染层 `ConfirmationDialog` 只是对已发生 `file_change` 的本地确认记账，不回传主进程、不阻断执行；IPC 契约里不存在 `agent:approveToolCall` 之类的 channel。
4. **会话恢复只在「进程还活着」的语义内成立**：`SessionRecoveryManager` 依赖内存中的 session 与适配器内存里的 CLI conversation id；应用重启后 `thread.sessionId` 仍从 DB 读回，但对应 session 已不存在，继续发送会命中 `SessionNotFoundError`。无法恢复到任意历史节点。
5. **并发控制是全局资源上限，不是会话级串行**：`MAX_SESSIONS` / `MAX_PROCESSES` 控制总量；`BaseAdapter.sendCommand` 没有同一 session 的在途锁；仓库里存在 `RequestQueue`，但**从未接入 Agent 派发路径**（仅测试引用），属于未使用代码。代码注释自己承认并发下 `lastCommandType` 归属不精确。
6. **三个后端的流式能力不对等**：Claude SDK 有逐消息流但代码只消费 `system/init`、`assistant.text`、`result`，忽略 `tool_use/tool_result/thinking`；Codex SDK 的 `thread.run()` 阻塞到结束，只有最终结果；OpenCode 是 one-shot 进程，stdout 缓冲到退出才输出。这直接决定 Agent 循环能否成立。
7. **文档与代码有明显代差**：`docs/architecture/overview.md` 同时出现 `better-sqlite3` 与 `LibSQL`，同一文件自相矛盾；并称 Claude 适配器是 "stdin/stdout 通信"，而代码已是 SDK `query()`。`AgentSessionConfig.resumeSessionId` 的注释仍写 "spawn 命令加 --resume"，与实现不符。
8. **最关键的硬约束**：Agent 层必须跨进程（renderer 不能持有运行时会话）、必须自己实现可恢复的执行日志（不能依赖适配器内存）、必须抽象出统一的「事件流 + 可取消 + 可审批」协议，否则三个 SDK 的差异会渗透到上层。

---

## 1. 现有 AI 链路

### 1.1 入口与调用链

**渲染层入口**

- 聊天面板组件：[AgentChatPanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/AgentChatPanel.tsx)。它负责把节点、上下文引用、项目路径组装成 `AgentSessionConfig`，并在新 thread 上绑定节点。
- 发送逻辑在 store：[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L250-L334)。有上下文引用时走 `agent:resolveAndSendCommand`，否则走 `agent:sendCommand`。
- 输出消费：[useAgentOutputListener.ts](file:///Users/zhumingchen/tiangong/src/renderer/hooks/useAgentOutputListener.ts#L140-L160)，挂载在 `agent:onOutput` 事件上。

**主进程装配**

- 所有适配器在 [ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L116-L131) 中通过 `ADAPTER_REGISTRY` 反射式注册：`registry.register(new desc.adapterClass())`，随后构造 `SessionRouter`、`OutputBroadcaster`、`AgentManager`。
- Agent IPC handler 是薄封装：[ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L25-L53)。`agent:startSession` 直接把 `adapterName` 与 `config` 透传给 `AgentManager.startSession`，主进程侧只做参数透传（对 config 的细粒度校验未能确认）。

**完整调用链**

```
AgentChatPanel / sessionStore.sendMessage
  └─ IPC agent:startSession | agent:resolveAndSendCommand | agent:sendCommand
      └─ AgentManager.startSession / resolveAndSendCommand / sendCommand
          ├─ FallbackRouter.resolveSession（选择适配器，失败回退）
          ├─ SessionLifecycleManager.start（建 sandbox、登记 SessionState）
          ├─ SessionRouter.bind（sessionId → adapterName）
          ├─ ContextAssembler.assemble（组装 PromptContext）
          └─ Adapter.sendCommand
              └─ BaseAdapter.buildCommandPrompt / runToolAwareLoop
                  └─ Claude SDK query() | Codex thread.run() | OpenCode spawn()
```

证据：[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L424-L442)、[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L555-L613)、[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L184-L224)。

**旁路 AI 入口（非聊天）**

- 思维导图生成 / 图谱初始化也复用 AgentManager：[send-and-wait.ts](file:///Users/zhumingchen/tiangong/src/main/agent/send-and-wait.ts#L27-L61)。它创建默认 `claude-code` 会话、`allowedFiles: []`（不建沙箱），由调用方自行监听输出。这条链路与聊天链路共用适配器，但不经过渲染层聊天 UI。

### 1.2 三种后端如何被调用

| 后端 | 依赖与版本（实际安装） | 启动/调用方式 | 流式消费 | 取消 | 原生 resume | 工具审批 |
|---|---|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` **0.3.286**（package.json 声明 `^0.3.160`） | `query({ prompt, options })` | 逐条 async message | `AbortController` | 有，依赖内存里的 SDK `session_id` | 无，`permissionMode: 'acceptEdits'` |
| Codex | `@openai/codex-sdk` **0.135.0**（声明 `^0.135.0`） | `startThread()` / `resumeThread()` + `thread.run()` | 仅最终结果，非 token 级 | 语义不完整，关闭仅清 Map | `resumeThread(threadId)`，thread id 仅内存 | 无，`sandboxMode: 'workspace-write'` |
| OpenCode | 无 npm SDK；系统 `opencode` CLI | `spawn('opencode', ['-q'])`，prompt 走 stdin | stdout 缓冲到进程退出 | 杀进程 | 无 | 无 |

证据：

- Claude：SDK 调用与选项 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L219-L240)；`permissionMode` [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L229)；`resume` 注入 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L233)；事件消费 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L272-L337)；取消 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L338-L346)。
- Codex：`startThread`/`resumeThread`/`run` 与 sandbox [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L96-L109)；线程仅存内存 Map [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L34-L34)；关闭语义 [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L179-L179)。
- OpenCode：`spawn` 与 stdin/stdout [opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L49-L76)。
- 版本：`package.json` [package.json](file:///Users/zhumingchen/tiangong/package.json#L28-L48)；实际安装版本来自 `node_modules/@anthropic-ai/claude-agent-sdk/package.json` `"version": "0.3.286"`、`node_modules/@openai/codex-sdk/package.json` `"version": "0.135.0"`。

**关键差异（对 Agent 体系最重要）**

- Claude SDK 的 `assistant.message.content` 中，代码**只提取 `block.type === 'text'`**，见 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L281-L293)。也就是说 SDK 明明提供了 `tool_use` / `tool_result` / `thinking`，上层完全拿不到。
- Codex 的 `thread.run()` 是阻塞调用，返回后一次性 emit 结果，见 [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L109-L109)。没有中间事件可供 Agent 循环使用。
- OpenCode 每条命令一个新进程，stdout 收集在 `chunks`，退出时才发出，见 [opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L49-L76)。

### 1.3 提示词在哪里组装、上下文如何拼

**两段式 PromptContext（stable / turn）**

核心类型：

```ts
export interface PromptContext {
  /** 稳定前缀：系统指令 + 会话摘要 + scope 约束 + 项目记忆。跨轮不变，可被 KV-cache 复用。 */
  stable: string
  /** 每轮上下文：代码上下文 + 编译上下文 + 水位线 + 会话历史记忆。每轮随请求变化。 */
  turn: string
}
```

[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L214-L219)。

**组装路径**

1. `AgentManager.resolveAndSendCommand` 先做上下文水位线判断，必要时自动压缩；然后取 adapter 实时 config，调用 `ContextAssembler.assemble`；把结果 `assembled.context` 通过 `adapter.setPromptContext(sessionId, ctx)` 注入；最后 `sendCommand`。[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L615-L676)。
2. `ContextAssembler.assemble` 并行解析 `resolvedContexts`、代码上下文、项目记忆、会话历史记忆，再交给 `PromptOrchestrator` 合并。[context-assembler.ts](file:///Users/zhumingchen/tiangong/src/main/agent/context-assembler.ts#L59-L140)。
3. `PromptOrchestrator` 负责 stable/turn 分段、项目记忆、会话历史记忆、水位线摘要。[prompt-orchestrator.ts](file:///Users/zhumingchen/tiangong/src/main/memory/prompt-orchestrator.ts)。
4. 适配器侧 `BaseAdapter` 用 `buildCommandPrompt` / `buildScopePromptForSession` / `buildTurnContext` 拼最终 prompt；`runToolAwareLoop` 把 scope、工具说明、turn 上下文、用户命令拼在一起。[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L1049-L1065)。
5. 任何投递路径都有兜底装配：`ensurePromptContext`，避免绕过 `resolveAndSendCommand` 时丢 scope；`transparentForward` 时跳过。[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L678-L720)。

**scope 约束进 prompt**

`ScopePromptBuilder` 把 allowedFiles / forbiddenFiles / invariantRules / 上下游契约 / 验收标准写成提示词。[scope-prompt-builder.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/scope-prompt-builder.ts)。

### 1.4 工具与权限如何暴露 / 限制

**工具暴露**

- Claude 适配器：通过 SDK options 传 `allowedTools` / `disallowedTools` / `tools` / `mcpServers`。子代理工具 `dispatch_subagent` 以 in-process MCP server 暴露；子代理时用 `subagentAllowedTools` 收窄 `tools`。[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L123-L240)。
- 通用适配器：`BaseAdapter` 用**提示词内联协议**暴露工具，要求模型输出 `<tool_call>{...}</tool_call>`；目前支持 `dispatch_subagent` 与 `delegate_recipe`。[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L955-L1010)。解析后由 `runToolAwareLoop` 执行，最多 5 轮。[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L1012-L1070)。
- 工具名常量：[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L1349-L1352)。

**权限限制**

- 文件范围：`ScopeGuard` 建备份目录、做白名单/黑名单校验、事后 `validateChanges` 与 `rollback` / `commitChanges`。[scope-guard.ts](file:///Users/zhumingchen/tiangong/src/main/scope-guard.ts#L276-L288)、[scope-guard.ts](file:///Users/zhumingchen/tiangong/src/main/scope-guard.ts#L480-L511)、[scope-guard.ts](file:///Users/zhumingchen/tiangong/src/main/scope-guard.ts#L586-L592)。
- Claude：`permissionMode: 'acceptEdits'`，即**自动接受编辑**，没有逐工具询问。[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L229-L229)。
- Codex：`sandboxMode: 'workspace-write'`，是工作区级写权限，不是逐文件白名单。[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L96-L103)。
- OpenCode：CLI 自身权限模型，宿主未注入审批回调（未能确认 CLI 侧细节）。
- 黑名单：主要靠 prompt 声明；没有 OS 级强制（`scope-prompt-builder` 只生成文本）。这是扩展 Agent 体系时的重要风险点。

**结论**：现有「权限」是**范围约束 + 事后回滚**，不是**执行前审批门**。

### 1.5 错误处理、重试、取消

**错误分类**

- 会话层错误类型：[errors.ts](file:///Users/zhumingchen/tiangong/src/main/errors.ts)（`IpcError` / `ErrorCode` / `AgentError`）。
- Claude SDK 有两层失败信号：`subtype` 与 `is_error`，代码两者都检查。[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L296-L336)。
- 渲染层把错误码落到消息：`NO_PROJECT`、`NO_ADAPTER_AVAILABLE`、`SESSION_START_FAILED`。[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L251-L262)、[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L335-L352)。

**重试 / 恢复**

- `SessionRecoveryManager`：`maxRetries = 3`；Claude 仅在拿到 `ctx.resumeSessionId`（CLI 级 id）时 `canResume: true`，否则返回 null；MCP 无状态，改为注入最近消息。[session-recovery.ts](file:///Users/zhumingchen/tiangong/src/main/agent/session-recovery.ts#L51-L113)。
- `RecoveryOrchestrator.handleSessionExit`：exit 137/143 视为正常；仅 crash/error/timeout 且非 126/127 可恢复；native 恢复后重绑并重发 `lastCommand`；replacement 则写谱系根并重发。[recovery-orchestrator.ts](file:///Users/zhumingchen/tiangong/src/main/agent/recovery-orchestrator.ts#L139-L208)。
- 适配器选择失败时 `FallbackRouter` 按 `defaultAdapter: 'claude-code'` + `fallbackOrder: ['codex','opencode','mcp']` 逐级尝试。[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L555-L555)、[fallback-router.ts](file:///Users/zhumingchen/tiangong/src/main/agent/fallback-router.ts#L94-L230)。

**取消**

- Claude：`AbortController.abort()`，循环中检查 `signal.aborted`。[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L272-L273)、[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L340-L346)。
- Codex：`doCloseQuery` 只清理 Map，不中断在途 `run()`。[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L179-L179)。**取消语义不完整**。
- OpenCode：杀进程，进程退出后结束。
- 渲染层 `stopCurrentSession`：保存快照 → `agent:terminateSession` → 把最后一个 streaming 消息标 aborted → **清除 thread.sessionId**。[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L125-L155)。

### 1.6 相关依赖实际版本

| 依赖 | package.json 声明 | node_modules 实际 |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `^0.3.160` | `0.3.286` |
| `@openai/codex-sdk` | `^0.135.0` | `0.135.0` |
| `better-sqlite3` | `^12.11.1` | 未单独核对（构建依赖） |
| `@xyflow/react` | `^12.4.0` | 未单独核对 |
| `@dagrejs/dagre` | `^3.0.0` | 未单独核对 |
| `d3-force` | `^3.0.0` | 未单独核对 |
| `zustand` | `^5.0.0` | 未单独核对 |
| `electron`（dev） | `^33.0.0` | 未单独核对 |

证据：[package.json](file:///Users/zhumingchen/tiangong/package.json#L28-L65)、[package.json](file:///Users/zhumingchen/tiangong/package.json#L66-L100)。

---

## 2. 会话地图与节点模型

### 2.1 核心类型定义（原文摘录）

**上下文引用**

```ts
export interface ContextRef {
  type: 'node' | 'file' | 'text'
  id: string
  label: string
  content?: string
  source?: 'user-attach' | 'right-click' | 'mention' | 'auto-scope'
  kind?: 'project' | 'snippet'
  tokenEstimate?: number
}
```

[graph.ts](file:///Users/zhumingchen/tiangong/src/shared/types/graph.ts#L11-L23)。

**节点状态与类型**

```ts
export type NodeStatus =
  | 'draft'        // 草稿（灰色）
  | 'confirmed'    // 已确认（蓝色）
  | 'developing'   // 开发中（橙色）
  | 'testing'      // 待测试（紫色）
  | 'review'       // 待验收（青色）
  | 'published'    // 已发布（绿色）
  | 'placeholder'  // 占位节点（虚线灰色）

export type NodeType =
  | 'project'
  | 'module'
  | 'process'
  | 'feature'
  | 'bug'
  | 'wiki-page'
```

[graph.ts](file:///Users/zhumingchen/tiangong/src/shared/types/graph.ts#L30-L46)。`GraphNode` 定义在 [graph.ts](file:///Users/zhumingchen/tiangong/src/shared/types/graph.ts#L115-L169)。

**Agent 会话配置**

```ts
export interface AgentSessionConfig {
  workingDirectory: string
  allowedFiles: string[]
  forbiddenFiles: string[]
  invariantRules: string[]
  upstreamContext: string
  downstreamContext: string
  nodeTitle: string
  acceptanceCriteria: string[]
  bugContext?: BugContext[]
  contextSummary?: string
  /** Claude Code 会话续接 ID，非空时 spawn 命令加 --resume */
  resumeSessionId?: string
  nodeId?: string
  commandType?: AgentCommandType
  timeoutMs?: number
  parentSessionId?: string
  swarmTaskId?: string
  threadId?: string
  subagentAllowedTools?: string[] | '*'
  verifyOnly?: boolean
  transparentForward?: boolean
  allowedDelegates?: string[]
}
```

[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L20-L71)。注意 `resumeSessionId` 的注释仍描述 CLI `--resume`，与当前 Claude SDK 实现不一致（见 §6）。

**Agent 输出（事件模型）**

```ts
export interface AgentOutput {
  type: 'stdout' | 'stderr' | 'file_change' | 'error' | 'complete'
      | 'system' | 'progress' | 'thinking' | 'tool_call' | 'context_injection'
  data: string
  timestamp: number
  filePath?: string
  changeType?: 'add' | 'modify' | 'delete'
  errorCode?: string
  pattern?: string
  invocationId?: string
  stage?: string
  progress?: { current: number; total: number; label: string }
  toolCall?: ToolCallBlock
  contextRefs?: ContextRef[]
  tokenEstimate?: number
}
```

[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L93-L116)。

**工具调用块 / 消息状态 / 消息**

```ts
export interface ToolCallBlock {
  type: 'file_edit' | 'diff' | 'terminal' | 'file_create'
  filePath?: string
  content: string
  status: 'running' | 'done' | 'error'
  accepted?: boolean
  changeType?: 'add' | 'modify' | 'delete'
}

export type MessageStatus =
  | 'pending' | 'queued' | 'sending' | 'streaming'
  | 'success' | 'error' | 'aborted' | 'permanently_failed'
```

[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L136-L162)。`ChatMessage` 在 [agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L165-L185)。

**Thread（会话线程）**

```ts
export interface AgentThread {
  id: string
  title: string
  adapterName: string
  messages: ChatMessage[]
  contextRefs: ContextRef[]
  status: 'idle' | 'running' | 'error' | 'reviewed'
  createdAt: number
  nodeBound?: string
  sessionId?: string
  fallbackInfo?: { originalAdapter: string; fallbackReason: string }
  /** 父 thread 引用（reserved；Phase 1 仅占位，subagent flow 不使用） */
  parentThreadId?: string
  contextTokensUsed?: number
  contextWindowMax?: number
  lastCompactedAt?: number
}
```

[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L188-L207)。**没有 `graphId` 字段**。

**Agent 会话与适配器接口**

- `AgentSession`：[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L222-L236)（含 `id`、`pid?`、`adapterName`、`config`、`startTime`、`promptContext?`、`fallbackInfo?`）。
- `AgentAdapter`：[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L239-L286)。关键方法：`checkInstalled`、`startSession`、`sendCommand`、`onOutput/offOutput`、`terminateSession`、`resolveOutputSession?`、`setPromptContext`、`getSessionConfig?`、`getResumeSessionId?`、`on/off('sessionEnded')`、`onUsage?`。

### 2.2 持久化方式

**数据库**：`better-sqlite3` 单文件 SQLite（[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L1-L60) 导入；schema 在 [database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L367-L680)）。

核心表（原文）：

```sql
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  adapter_name TEXT NOT NULL,
  node_id TEXT,
  graph_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK(status IN ('idle','running','error','reviewed','active','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','agent','system')),
  content TEXT NOT NULL,
  adapter_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success'
    CHECK(status IN ('success','error','pending','streaming','aborted','queued','sending','permanently_failed')),
  error TEXT,
  session_id TEXT,
  context_refs TEXT,
  tool_calls TEXT,
  created_at INTEGER NOT NULL
)
```

[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L481-L511)。

节点表 `nodes` 状态约束：[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L381-L409)（`status CHECK (... 'placeholder')` 在 L384）。执行日志表 `agent_logs`：[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L463-L476)。

迁移补齐：`chat_messages.token_count`、`chat_threads.parent_thread_id`、`context_tokens_used`、`context_window_max`、`last_compacted_at`、`metadata`。[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L905-L913)。

**没有 `agent_sessions` 表**：本次对 `src/main/database.ts` 检索 `agent_sessions` 无命中；会话运行时状态在 [session-lifecycle-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/session-lifecycle-manager.ts) 的内存 `Map` 中。

**Thread 映射缺陷**

- `ChatService.createThread` 返回对象硬编码 `status: 'idle'`，而仓库层插入 `'active'`。[chat-service.ts](file:///Users/zhumingchen/tiangong/src/main/services/chat-service.ts#L38-L53)。
- `listThreads` 过滤 `status: 'active'`，但 `rowToThread` 又把结果硬编码成 `'idle'`，并且**不映射 `graphId` / `parentThreadId` / `metadata`**。[chat-service.ts](file:///Users/zhumingchen/tiangong/src/main/services/chat-service.ts#L72-L75)、[chat-service.ts](file:///Users/zhumingchen/tiangong/src/main/services/chat-service.ts#L158-L173)。
- `thread:update` 的 DB 契约只接受 `{title?, status?, sessionId?}`，不能更新 nodeId/graphId/metadata/parent_thread_id。[ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L134-L134)、[chat-repository.ts](file:///Users/zhumingchen/tiangong/src/main/repositories/chat-repository.ts)。

### 2.3 状态如何流转

**节点状态**

- `draft → confirmed → developing → testing → review → published`，另有 `placeholder`。
- Agent 启动时会触发 `statusChangeCallback(nodeId, 'developing')`，并把 `placeholder` 自动推进到 `developing`。[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L494-L519)。
- 节点状态广播为 `event:NODE_STATUS_CHANGE`。[ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L166-L168)。

**Thread / 消息状态**

- 渲染层 `threadStore.updateThreadStatus` **只改本地 Zustand，不落库**。[threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts#L176-L182)。
- 消息状态由输出事件驱动：`streaming → success/error/aborted`；`file_change` 输出会追加 `ToolCallBlock`。[useAgentOutputListener.ts](file:///Users/zhumingchen/tiangong/src/renderer/hooks/useAgentOutputListener.ts#L120-L185)。
- 会话运行时状态（`starting/active/terminated/crashed`）只在 `sessionStore.activeSessions` 内存里。[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L22-L38)。

**节点 ↔ thread ↔ session ↔ message 关系**

```
GraphNode 1 ── 0..1（渲染层只保留最后一个） AgentThread
AgentThread 1 ── 0..* ChatMessage
AgentThread 0..1 ── 1 AgentSession（sessionId 存在 DB 的 chat_threads.session_id）
AgentSession 1 ── 1 Adapter 内部会话（Claude SDK session_id / Codex thread.id，仅内存）
```

- 一个节点多个 thread 在 DB 可以存在（`chat_threads.node_id` 非唯一），但渲染层 `nodeThreadMap` 是 `Map<nodeId, AgentThread>`，**后写覆盖**。[threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts#L10-L10)、[threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts#L56-L62)、[threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts#L169-L173)。
- `thread:create` 先用本地 id 建 thread，再异步换 DB id。[threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts#L80-L107)。
- `AgentThread.parentThreadId` 明确标注 "Phase 1 仅占位"。[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L201-L203)。

### 2.4 渲染层如何呈现

- 画布：React Flow（`@xyflow/react`）。`GraphCanvas` 读取节点并构建 `nodeThreadMap`，在节点上展示 thread 信息。[GraphCanvas.tsx](file:///Users/zhumingchen/tiangong/src/renderer/canvas/GraphCanvas.tsx)。
- 自动布局：dagre 树形布局。`useAutoLayout` 调用 `computeTreeLayout`，再批量持久化位置。[useAutoLayout.ts](file:///Users/zhumingchen/tiangong/src/renderer/canvas/hooks/useAutoLayout.ts#L3-L45)、[tree-layout.ts](file:///Users/zhumingchen/tiangong/src/renderer/canvas/layouts/tree-layout.ts#L1-L11)、[tree-layout.ts](file:///Users/zhumingchen/tiangong/src/renderer/canvas/layouts/tree-layout.ts#L261-L314)。
- 布局细节：默认 `direction: 'LR'`，先找回边再跑 dagre，多连通分量分别布局后横向并排。[tree-layout.ts](file:///Users/zhumingchen/tiangong/src/renderer/canvas/layouts/tree-layout.ts#L59-L59)、[tree-layout.ts](file:///Users/zhumingchen/tiangong/src/renderer/canvas/layouts/tree-layout.ts#L114-L114)、[tree-layout.ts](file:///Users/zhumingchen/tiangong/src/renderer/canvas/layouts/tree-layout.ts#L251-L261)。
- 另有 `d3-force` 依赖（`package.json`），是否还有力导向布局未被本报告确认为主路径；当前自动布局主路径是 dagre。

**已知渲染层问题（只读发现，未修）**

- `AgentChatPanel.tsx` 在 L657-L658 已关闭根 `div` 后，L660 `HistorySidebar`、L662 `SubagentInvocationsPanel`、L667 又出现 `</div>`，JSX 呈现多根节点且多余闭合标签，疑似半重构产物/编译错误。[AgentChatPanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/AgentChatPanel.tsx#L657-L668)。

---

## 3. 架构边界与 IPC 契约

### 3.1 四层职责

| 层 | 职责 | 证据 |
|---|---|---|
| `src/main` | Node 主进程：数据库、Agent 编排、适配器、ScopeGuard、IPC handler、文件系统、项目扫描、A2A、Recipe、Yjs、遥测。**不得 import React**（CLAUDE.md 约束）。 | [ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L116-L131)；[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L48-L48) |
| `src/preload` | contextBridge 最小暴露：按白名单生成 `invoke` API，并为事件挂 `ipcRenderer.on` 包装。 | [preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L23-L230) |
| `src/renderer` | React + Zustand：画布、聊天面板、thread/session/message store、输出监听、确认 UI。 | [threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts)、[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts) |
| `src/shared` | 跨进程类型与常量：`agent.ts`、`graph.ts`、`ipc.ts`、`subagent.ts`、`a2a.ts`、`recipe.ts` 等。 | [agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts)、[ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts) |

### 3.2 与 AI / 会话 / 节点相关的 IPC 契约

**Invoke（请求/响应）**

| Channel | 参数 | 返回 | 证据 |
|---|---|---|---|
| `agent:startSession` | `adapterName: string \| null`, `config: AgentSessionConfig` | `{ sessionId, fallback?, adapterUsed?, fallbackHistory? }` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L110-L110) |
| `agent:sendCommand` | `sessionId: string`, `command: AgentCommand` | `void` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L111-L111) |
| `agent:resolveAndSendCommand` | `sessionId`, `command`, `contextRefs: ContextRef[]`, `nodeIds: string[]` | `void` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L112-L112)；参数校验 [ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L34-L49) |
| `agent:terminateSession` | `sessionId: string` | `void`（内部固定 reason `'user'`） | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L113-L113)；[ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L51-L53) |
| `agent:checkInstalled` | `adapterName: string` | `boolean` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L109-L109) |
| `agent:listAdapters` | 无 | `{name, version, installed}[]` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L114-L114) |
| `agent:getHealth` | 无 | `AdapterHealthScore[]` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L117-L117) |
| `agent:closeAllSessions` | 无 | `void` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L128-L128) |
| `agent:verify` | 验证参数 | 验证结果 | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L118-L125) |
| `thread:list` | `{nodeId?, graphId?}` | `AgentThread[]` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L131-L131) |
| `thread:load` | `threadId` | `AgentThread \| null` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L132-L132) |
| `thread:create` | `{adapterName, nodeId?, graphId?}` | `AgentThread` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L133-L133) |
| `thread:update` | `threadId`, `{title?, status?, sessionId?}` | `void` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L134-L134) |
| `thread:delete` | `threadId` | `void` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L135-L135) |
| `thread:search` | `query` | `AgentThread[]` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L136-L136) |
| `message:list` | `threadId`, `limit?`, `offset?` | `ChatMessage[]` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L138-L138) |
| `message:save` | `threadId`, `message` | `void` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L139-L139) |
| `message:saveBatch` | `threadId`, `messages[]` | `void` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L140-L140) |
| `context:getWaterline` | `threadId` | `ContextState \| null` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L148-L148) |
| `context:listHistory` | `threadId` | `CompactHistoryEntry[]` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L149-L149) |
| `context:compactNow` | `sessionId`, `strategy?` | `CompactResult` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L150-L150) |
| `subagent:listTypes` | 无 | `AgentTypeDefinition[]` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L240-L240) |
| `subagent:listInvocations` | `parentSessionId` | `SubagentInvocation[]` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L241-L241) |
| `subagent:cancel` | `invocationId` | `void` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L242-L242) |
| `subagent:getResult` | `invocationId` | `SubagentResult \| null` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L243-L243) |

**事件（main → renderer）**

| Channel | Payload | 证据 |
|---|---|---|
| `agent:onOutput` | `(sessionId, AgentOutput)` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L291-L291)；广播接线 [ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L154-L156) |
| `agent:onStatusChange` | `(sessionId, nodeId, status: NodeStatus)` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L292-L292) |
| `agent:onSessionStarted` | `(threadId, sessionId)` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L293-L293) |
| `event:NODE_STATUS_CHANGE` | `(nodeId, oldStatus, newStatus)` | [ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L166-L168)；preload [index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L246-L253) |
| `session:recovered` | `(sessionId, newSessionId)` | [preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L265-L275) |
| `session:recoveryFailed` | `(sessionId, reason)` | [preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L277-L287) |
| `waterline:change` | `ContextState` | [preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L289-L299) |
| `subagent:progress` | `{invocationId, status, error?}` | [ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L298-L298) |
| `recipe:run:progress` | `RecipeRunProgressEvent` | [preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L306-L315) |

**关键缺口**

- **不存在任何工具审批 channel**：对 `src/` 检索 `approveToolCall` / `canUseTool` / `approval`，只命中渲染层 `pendingConfirmations` 与 `ConfirmationDialog`，无 IPC 定义。
- 不存在「恢复到指定节点/指定消息」的 channel；`context:compactNow` 只是压缩，不是回滚。

---

## 4. 文档中的设计意图与历史包袱

### 4.1 `CLAUDE.md`

- 产品定位：Electron 桌面编排器，连接 Claude Code / Codex / OpenCode / Cline / Kilo Code / Kimi Code / CodeBuddy / Qoder / Qwen Code / Cursor，通过可视化思维导图定义业务范围（"where to change, how to change"）。[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L9-L9)。
- Renderer 职责：React + `@xyflow/react` + Zustand + Tailwind/shadcn。[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L48-L48)。
- 会话模型：CLI 适配器 one-shot；ClaudeCode 通过 `--resume <sessionId>` 多轮续接；SDK 适配器使用 Claude/Codex SDK。[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L55-L55)。
- 恢复：`SessionRecoveryManager` 在 crash/error/timeout 时 native resume 或 replacement。[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L58-L58)。
- 边界：不改写 system prompt / user request / model request headers / tool schema / provider routing / approval context；BizGraph 只在调用边界之上组装 scope/memory/项目上下文。[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L144-L144)。
- A2A 透明转发：不注入本地 memory / scope 状态。[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L150-L150)。
- 子代理：`SubagentManager` 从父会话的 `dispatch_subagent` 工具调用派生临时子会话，支持 explore/implement/review/fix/general 及用户自定义类型，执行 scope 策略与写意图串行化。[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L123-L123)。

**提炼出的已定决策**

1. scope 约束必须随任何投递路径（包括旁路），所以有 `ensurePromptContext` 兜底。
2. A2A 入站必须透明转发，不夹带内部状态（`transparentForward`）。
3. 不在 provider 层改写工具 schema / 审批上下文，只在调用边界组装上下文。
4. CLI 适配器 one-shot、SDK 适配器流式，是两种不同生命周期模型。

### 4.2 `docs/architecture/overview.md`

- 架构图声称数据层 `better-sqlite3 (SQLite)`（[overview.md](file:///Users/zhumingchen/tiangong/docs/architecture/overview.md#L28-L28)），但后文又写「主进程操作 LibSQL 数据库」（[overview.md](file:///Users/zhumingchen/tiangong/docs/architecture/overview.md#L82-L82)）。**同文件自相矛盾，LibSQL 说法与代码不符**。
- 声称 `ClaudeCodeAdapter` 是 "stdin/stdout 通信"（[overview.md](file:///Users/zhumingchen/tiangong/docs/architecture/overview.md#L53-L53)），与代码的 SDK `query()` 不符。
- 数据层清单只列了部分表（`chat_messages` 等），未覆盖 `chat_threads` / `agent_logs` / `subagent_invocations` / `recipes` 全量（详见 §6）。

### 4.3 `docs/base/ROADMAP.md`

- `D4 claude-code 补齐会话终止与恢复契约`：发射 `sessionEnded`；「原生恢复需真实 CLI 会话 id；原生恢复重发上一条命令」。[ROADMAP.md](file:///Users/zhumingchen/tiangong/docs/base/ROADMAP.md#L55-L55)。
- 与代码对照：`sessionEnded` 已补；native resume 依赖 `resumeSessionId` 已实现；但「真实 CLI 会话 id」只在内存，**跨重启仍不成立**。
- Phase D 其余：D5b/D5c recipe 委派、D3 子代理工具暴露与 MCP、D5a 并发切换等，见 [ROADMAP.md](file:///Users/zhumingchen/tiangong/docs/base/ROADMAP.md#L17-L17)。

### 4.4 `docs/base/PHASE_D_TASKS.md`

- 该文件是 Phase D 任务索引（D1-D11），把 D1 拆为 D1a（session lifecycle）/ D1b（fallback recovery），D5 拆为 D5a/b/c。[PHASE_D_TASKS.md](file:///Users/zhumingchen/tiangong/docs/base/PHASE_D_TASKS.md#L9-L54)。
- 细节不在该文件，而在 `docs/base/prompts/*`。例如 D5b 明确要求 `delegate_recipe` 工具、`allowed_delegates` 白名单、复用 `SubagentManager.invoke(agentType='recipe:<id>')`、写文件受 `scopeStrategy` 约束。[D5b-recipe-dag-delegate.md](file:///Users/zhumingchen/tiangong/docs/base/prompts/D5b-recipe-dag-delegate.md#L47-L74)。
- D1b prompt 明确要求会话恢复由 `SessionRecoveryManager` 承担，并强调 worktree 隔离运行。[D1b-agent-manager-fallback-recovery.md](file:///Users/zhumingchen/tiangong/docs/base/prompts/D1b-agent-manager-fallback-recovery.md#L13-L26)。

### 4.5 `RESCUE_NOTES.md`

- 与 AI/Agent 无关。本次检索 `agent|Agent|session|workflow` 无命中；内容主要是 d7b writeback 分支的 git 救援笔记。

---

## 5. 扩展点评估：在此之上叠一层 Agent 体系

### 5.1 已经够用的抽象

| 抽象 | 为什么够用 | 证据 |
|---|---|---|
| `AgentAdapter` 接口 | 已有 `startSession` / `sendCommand` / 输出流 / `terminate` / `setPromptContext` / `getResumeSessionId` / `sessionEnded`，可作为多后端统一入口。 | [agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L239-L286) |
| `AdapterRegistry` + 描述符 | 声明式能力位（Resume / Streaming / FileOps / MultiTurn / ScopeGuard / Tools / NativeCompact / SummaryRewrite），可驱动能力路由。 | [registry.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/registry.ts#L59-L282) |
| `FallbackRouter` | 已实现按安装状态与健康度逐级回退，返回 fallbackHistory。 | [fallback-router.ts](file:///Users/zhumingchen/tiangong/src/main/agent/fallback-router.ts#L94-L230) |
| `PromptContext { stable, turn }` | 天然适配 KV-cache 与每轮上下文分离，Agent 循环可复用。 | [agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L214-L219) |
| `AgentOutput` 事件枚举 | 已含 `progress/thinking/tool_call/context_injection`，语义上可承载 Agent 步骤。 | [agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L93-L116) |
| `SubagentManager` + `dispatch_subagent` | 已有父子会话、作用域策略、写意图串行化的雏形。 | [CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L123-L123)；[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L1349-L1352) |
| `ScopeGuard` | 有备份、校验、回滚、提交，可作为 Agent 工具的副作用安全网（但不是审批门）。 | [scope-guard.ts](file:///Users/zhumingchen/tiangong/src/main/scope-guard.ts#L276-L288) |

### 5.2 缺失的抽象

1. **统一的工具调用生命周期协议**
   - 现状：`AgentOutput.tool_call` 只是展示块；Claude SDK 的 `tool_use/tool_result` 被丢弃；Codex 无中间事件；OpenCode 无工具事件。
   - 缺失：`tool_call_requested → approval_required → approved/denied → executing → result` 的跨后端统一状态机。
2. **执行日志 / 事件溯源（event sourcing）**
   - 现状：`agent_logs` 只记录会话级结果与 outputs，不能重放到任意步骤。[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L463-L476)。
   - 缺失：持久化的 step/event 表、游标、幂等键。
3. **可恢复的 Agent 状态机**
   - 现状：`SessionState` 只在内存；DB 无 `agent_sessions`；`AgentThread` 无状态历史。
   - 缺失：会话快照（当前步骤、待审批项、工具结果、token 预算）。
4. **工具审批通道**
   - 现状：无 IPC；`ConfirmationDialog` 仅前端记账。[messageStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/messageStore.ts#L390-L452)。
   - 缺失：main ↔ renderer 的双向审批 RPC，以及适配器层的 `canUseTool` / `pause/resume`。
5. **会话级并发控制**
   - 现状：只有全局 `MAX_SESSIONS` / `MAX_PROCESSES`；`RequestQueue` 未接入。[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L115-L117)、[request-queue.ts](file:///Users/zhumingchen/tiangong/src/main/agent/request-queue.ts#L40-L219)。
   - 缺失：per-session 串行锁、per-thread 队列、跨进程取消令牌。
6. **统一的取消语义**
   - 现状：Claude 可 abort；Codex 不可中断；OpenCode 杀进程。代码/模型层没有统一 `cancel(sessionId, stepId)` 契约。
7. **Agent 循环所需的结构化步骤**
   - 现状：`runToolAwareLoop` 最多 5 轮，只支持固定工具名，靠正则解析 `<tool_call>`。[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L1012-L1070)。
   - 缺失：循环终止条件、最大步数/预算、失败重规划、工具结果回填标准格式（目前仅 `dispatch_subagent` 有）。

### 5.3 会挡路的地方

1. **`BaseAdapter.sendCommand` 无在途检查**：同一 session 的两次调用会交错，`sessionOutputStack` 只能"尽量"关联输出。[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L184-L224)。Agent 体系若并发派发，输出归属会错。
2. **`lastCommandType` 单值字段**：恢复时重发"上一条命令"在并发下不精确，代码注释自己承认。[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L590-L598)。
3. **Claude SDK 事件被截断**：忽略 `tool_use/tool_result/thinking`，上层无法做工具级审计或审批。[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L281-L293)。
4. **Codex 阻塞式 run**：无法在步骤间插入审批或取消。[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L109-L109)。
5. **OpenCode one-shot 进程**：无会话状态、无 resume、无中间事件。[opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L49-L76)。
6. **thread 与 session 绑定在 DB 但 session 不在 DB**：重启后 `thread.sessionId` 是悬空引用。[chat-service.ts](file:///Users/zhumingchen/tiangong/src/main/services/chat-service.ts#L158-L173)、[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L264-L278)。
7. **`resumeSessionId` 语义混用**：配置注释说 CLI `--resume`，实际存的是 SDK `session_id`；渲染层又把 BizGraph `thread.sessionId` 赋给它。[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L40-L40)、[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L264-L267)。
8. **thread 状态不落库**：`updateThreadStatus` 只改本地，主进程与 DB 不知道 running/idle。[threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts#L176-L182)。

**逐项回答用户特别关注的问题**

- **SDK 事件模型是否足以支撑 Agent 循环？**
  - Claude：事件**丰富度足够**（SDK 有 tool_use/tool_result），但**当前消费层不足**（只取文本/结果）。
  - Codex：**不足**（阻塞单结果）。
  - OpenCode：**不足**（one-shot）。
  - 结论：不能用现有 `AgentOutput` 直接支撑通用 Agent 循环，需要新增结构化 `AgentStepEvent` 并改造适配器消费层。
- **会话状态能否恢复到任意节点？**
  - **不能**。DB 只存 thread/message 快照，不存 step/工具状态；恢复仅在进程存活且适配器能 native resume 时发生。[session-recovery.ts](file:///Users/zhumingchen/tiangong/src/main/agent/session-recovery.ts#L57-L81)。
- **是否存在工具调用审批通道？**
  - **不存在**。Claude 自动 `acceptEdits`；渲染层确认是事后 UI 记账。[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L229-L229)、[useAgentOutputListener.ts](file:///Users/zhumingchen/tiangong/src/renderer/hooks/useAgentOutputListener.ts#L140-L156)。
- **并发与会话隔离是否安全？**
  - **部分安全，整体不足**。全局容量有上限、`SessionRouter` 按 session 隔离、ScopeGuard 按 sandbox 隔离；但**同一 session 无串行锁**、恢复重发归属不精确、thread 状态不持久化。代码注释承认并发下 `lastCommandType` 不精确。[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L590-L598)。

---

## 6. 文档声称但代码未实现 / 已过期

| # | 文档说法 | 代码事实 | 证据 |
|---|---|---|---|
| 1 | 数据层用 **LibSQL** | 实际 `better-sqlite3`；同文件 L28 也写 better-sqlite3 | [overview.md](file:///Users/zhumingchen/tiangong/docs/architecture/overview.md#L82-L82)、[overview.md](file:///Users/zhumingchen/tiangong/docs/architecture/overview.md#L28-L28)、[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L1-L60) |
| 2 | `ClaudeCodeAdapter` 是 **stdin/stdout 通信** | 实际 `@anthropic-ai/claude-agent-sdk` 的 `query()` | [overview.md](file:///Users/zhumingchen/tiangong/docs/architecture/overview.md#L53-L53)、[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L219-L240) |
| 3 | Claude 多轮续接走 **`--resume <sessionId>` CLI 参数** | 实际 SDK options `resume`；`resumeSessionId` 存的是 SDK session_id | [CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L55-L55)、[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L233-L277) |
| 4 | D4「原生恢复需真实 CLI 会话 id」 | 已实现，但 id 仅在内存；重启后无法恢复 | [ROADMAP.md](file:///Users/zhumingchen/tiangong/docs/base/ROADMAP.md#L55-L55)、[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L275-L278) |
| 5 | 渲染层 `resumeSession` 能恢复会话 | 空实现：只把 session 重新塞进 `activeSessions`，不调用后端 | [sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L96-L108) |
| 6 | `thread:update` 可持久化状态 | 渲染层 `updateThreadStatus` 不落库；DB mapper 又把状态硬编码 `idle` | [threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts#L176-L182)、[chat-service.ts](file:///Users/zhumingchen/tiangong/src/main/services/chat-service.ts#L158-L173) |
| 7 | `AgentThread.parentThreadId` 支撑 subagent 谱系 | 类型注释明确 "Phase 1 仅占位"，DB `rowToThread` 不映射 | [agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L201-L203)、[chat-service.ts](file:///Users/zhumingchen/tiangong/src/main/services/chat-service.ts#L158-L173) |
| 8 | 存在会话请求队列 / 并发排队 | `RequestQueue` 类存在但主进程无任何调用（grep 仅命中定义与测试） | [request-queue.ts](file:///Users/zhumingchen/tiangong/src/main/agent/request-queue.ts#L40-L219) |
| 9 | `AgentThread.status` 与 DB 状态一致 | 类型枚举 `idle/running/error/reviewed`，DB CHECK 还含 `active/archived`，两套语义并存 | [agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L188-L207)、[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L481-L491) |
| 10 | 工具审批由 ConfirmationDialog 把关 | 仅前端 UI 记账；`file_change` 来自 Claude 的 **PostToolUse** hook，审批发生在写之后 | [ConfirmationDialog.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ConfirmationDialog.tsx#L7-L10)、[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L241-L268) |

`RESCUE_NOTES.md` 不包含 AI/Agent 内容，不属于"过期"而是"无关"。

---

## 7. 未能确认

1. **`agent:startSession` 的 config 校验强度**：handler 直接透传，`AgentManager` 内部是否逐字段校验 `allowedFiles` 路径/绝对路径越界，本次未完整追踪（未能确认）。
2. **`AgentManager.startSession` 的内存阈值具体数值**：只确认存在内存检查与 `MAX_SESSIONS`/`MAX_PROCESSES` 上限，阈值常量位置未逐行核对（未能确认）。
3. **Codex `doCloseQuery` 之外是否还有底层进程/HTTP 中断手段**：未确认 SDK 是否暴露 abort（未能确认）。
4. **OpenCode CLI 的权限/工具事件协议**：仅确认宿主侧 spawn 与 stdin/stdout，CLI 自身的审批能力未确认（未能确认）。
5. **`d3-force` 力导向布局是否仍是活跃 UI 路径**：仅确认依赖存在与 dagre 主路径（未能确认）。
6. **`messageStore` 的重试次数与 `permanently_failed` 触发阈值**：只看到状态枚举与错误处理，具体重试策略未逐行确认（未能确认）。
7. **`AgentChatPanel.tsx` 的 JSX 多根是否已被构建流程容忍**：静态阅读疑似编译错误；未运行 `tsc` 验证（未能确认）。

---

## 8. 对 Agent 体系设计的硬约束清单

> 仅列有代码证据支撑的约束。

1. **必须跨进程**：所有 Agent 运行时对象（进程、SDK client、AbortController、MCP server）都在 `src/main`；renderer 只能通过 preload 白名单 IPC 访问。[preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L23-L230)、[ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L116-L131)。
2. **必须自带持久化执行状态**：DB 无 `agent_sessions` 表，`SessionState` 只在内存；Agent 步骤、待审批项、工具结果必须新建持久化模型，不能依赖适配器内存。[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L367-L680)、[session-lifecycle-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/session-lifecycle-manager.ts)。
3. **必须区分三种「会话 id」**：BizGraph sessionId、thread.sessionId（DB）、适配器 CLI/SDK conversation id（内存）。当前已混用，Agent 层必须显式建模。[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L264-L278)、[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L275-L278)。
4. **必须兼容多后端 SDK 差异**：统一事件模型要同时覆盖「逐消息流」（Claude）、「阻塞单结果」（Codex）、「one-shot 进程」（OpenCode），否则上层循环只能按最弱能力设计。[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L272-L337)、[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L109-L109)、[opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L49-L76)。
5. **必须新增工具审批 RPC**：现有 IPC 无审批 channel，且 Claude 自动接受编辑；若 Agent 要"人在环"，必须新增 main↔renderer 双向请求/响应，并在适配器层提供暂停/恢复能力。[ipc.ts](file:///Users/zhumingchen/tiangong/src/shared/types/ipc.ts#L109-L150)、[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L229-L229)。
6. **必须实现 per-session 串行 / per-thread 队列**：`BaseAdapter.sendCommand` 无在途锁，`RequestQueue` 未接入；并发派发会导致输出归属与恢复重发错误。[base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L184-L224)、[request-queue.ts](file:///Users/zhumingchen/tiangong/src/main/agent/request-queue.ts#L40-L219)、[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L590-L598)。
7. **必须把 scope 约束绑定到每一条投递路径**：包括旁路 `send-and-wait` 与未来 Agent 工具调用；否则会绕过白名单。[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L678-L720)、[send-and-wait.ts](file:///Users/zhumingchen/tiangong/src/main/agent/send-and-wait.ts#L27-L61)。
8. **必须保留 A2A 透明转发语义**：入站会话不得注入本地 memory/scope；Agent 层若统一加上下文，必须为 `transparentForward` 留旁路。[agent.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent.ts#L55-L62)、[CLAUDE.md](file:///Users/zhumingchen/tiangong/CLAUDE.md#L150-L150)。
9. **必须把「恢复」限定在可证明的语义内**：当前仅支持进程存活时的 native resume（Claude）或无状态注入（MCP），3 次上限；Agent 层不能承诺「重启后恢复到任意节点」而不新建持久化 step 存储。[session-recovery.ts](file:///Users/zhumingchen/tiangong/src/main/agent/session-recovery.ts#L51-L113)、[recovery-orchestrator.ts](file:///Users/zhumingchen/tiangong/src/main/agent/recovery-orchestrator.ts#L139-L208)。
10. **必须把 thread 状态做成权威数据**：渲染层当前只改本地状态，主进程/DB 不可见；Agent 层若依赖 thread 状态做调度，必须先落库并统一枚举。[threadStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/threadStore.ts#L176-L182)、[database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L481-L491)。
