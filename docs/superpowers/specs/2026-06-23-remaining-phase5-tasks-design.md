# Phase 5 剩余项设计：CLI 子智能体 inline protocol + E2E 测试

**Date:** 2026-06-23  
**Scope:** 完成 Phase 5 遗留的两项真实剩余工作：
1. 让不支持原生工具注册的 CLI 适配器（OpenCode 为首）支持 `dispatch_subagent` 子智能体调用。
2. 补全 Phase 5 新增 UI 流程的 Playwright E2E 测试。

> 注：经代码核查，原始“剩余项”表格中的 contextWaterline 持久化、重叠写入串行化、画布多选视觉指示器三项已在近期 commit 中完成，不再属于本次工作范围。

---

## 1. 总体拆分

将工作拆分为两条独立工作流，可并行推进：

| 工作流 | 范围 | 核心文件 |
|---|---|---|
| **A. CLI 适配器 inline-protocol 子智能体** | 在单次执行的 CLI 适配器中实现 prompt-based 子智能体派发 | `src/main/adapters/base.ts`, `src/main/adapters/opencode.ts`, 新增单元测试 |
| **B. Phase 5 E2E Playwright 测试** | 用 mock IPC 覆盖 Fan-out、子智能体面板、多选高亮 | `tests/e2e/helpers/mock-ipc.ts`, 新增 `*.spec.ts` |

两条工作流仅在一个点交汇：OpenCode 的 `SubagentCapability` 标记从 `native-task` 更新为 `inline-protocol`。

---

## 2. 工作流 A：Prompt-based inline protocol

### 2.1 问题

当前只有两类适配器支持 `dispatch_subagent`：
- **Claude Code**：通过 `@anthropic-ai/claude-agent-sdk` 的 `createSdkMcpServer` 注册 in-process MCP 工具。
- **MCP**：通过 unified tools 数组把 `dispatch_subagent` 作为 API tool 暴露。

OpenCode、Cline、Kimi Code 等是**单次执行 CLI**：`spawn → 处理 prompt → stdout → 退出`。它们没有运行时工具注册能力，因此无法直接暴露 `dispatch_subagent`。

### 2.2 解决思路：适配器层工具感知循环

由 BizGraph 适配器驱动工具调用循环，而不是 CLI 本身：

1. 在发送给 CLI 的 prompt 中注入 `dispatch_subagent` 工具描述和固定 JSON 调用格式。
2. 运行 CLI 一次，收集完整 stdout。
3. 解析 stdout 中的 `<tool_call>{...}</tool_call>` 标记。
4. 对每一个 `dispatch_subagent` 调用，执行 `SubagentManager.invoke()`。
5. 把 tool results 追加到对话历史。
6. 重新 spawn CLI，传入更新后的 prompt（原始任务 + 已调用工具 + 结果）。
7. 重复 2–6，直到没有新 tool call，或达到最大轮数/总超时。

### 2.3 新增/修改组件

#### 2.3.1 `BaseAdapter` 通用基础设施

新增类型：

```typescript
interface InlineToolCall {
  tool: string
  args: Record<string, unknown>
}
```

新增常量（默认值）：

```typescript
const TOOL_CALL_TAG = 'tool_call'
const MAX_TOOL_ROUNDS = 5
const TOOL_AWARE_LOOP_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
```

> 复用 `src/main/adapters/base.ts` 中已定义的 `DISPATCH_SUBAGENT_TOOL_NAME` 与 `DISPATCH_SUBAGENT_TOOL_SCHEMA`。

新增方法：

- `protected buildSubagentToolPrompt(): string`
  - 生成工具描述和 JSON 调用格式说明。
  - 复用 `DISPATCH_SUBAGENT_TOOL_SCHEMA` 的字段信息，渲染为自然语言 + 示例 JSON。

- `protected parseToolCalls(text: string): InlineToolCall[]`
  - 用正则提取 `<tool_call>{...}</tool_call>`。
  - JSON 解析失败时记录 warn 并跳过该项，不影响其他输出。

- `protected async runToolAwareLoop(
    session: AgentSession,
    command: AgentCommand,
    spawnOnce: (fullPrompt: string) => Promise<string>
  ): Promise<void>`
  - 维护 `history: { role: 'assistant' | 'tool'; content: string }[]`。
  - 每轮调用 `spawnOnce(fullPrompt)` 得到 stdout。
  - 解析 tool calls；仅处理 `dispatch_subagent`，其他工具返回 `"unknown tool"` 错误。
  - 同一轮多个 tool call 使用 `Promise.all` 并行执行。
  - 应用最大轮数和总超时限制。
  - 循环结束后 emit 最终结果（stdout / complete / error）。

#### 2.3.2 `OpenCodeAdapter`

- `doSendCommand` 改为调用 `runToolAwareLoop`。
- 提供 `spawnOnce` 实现：
  - 构造完整 prompt：`scopePrompt + constraintSuffix + toolDescription + commandPrompt + history`。
  - spawn `opencode -q`。
  - 返回收集到的 stdout 字符串。
- 单次进程内无法回传中间结果 → 通过“重新 spawn + 历史拼接”解决。

#### 2.3.3 其他 CLI 适配器（后续复用）

Cline、Kimi Code、Qwen Code 等结构与 OpenCode 类似（单次 spawn CLI）。本次先聚焦 OpenCode 跑通通用机制，其余适配器在验证通过后通过重构复用 `runToolAwareLoop`。

### 2.4 Prompt 注入格式

```markdown
## 可用工具

你可以在回答中调用以下工具。调用时必须输出且仅输出如下格式：

<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "Find usages", "prompt": "Find all usages of Foo in src/.", "allowed_files": ["src/foo.ts"]}}</tool_call>

调用后我会执行工具并把结果返回给你，你可以继续思考。

可用 agent_type：explore, implement, review, fix, general。
allowed_files 仅在 agent_type 为 implement/fix/general 时有效，且必须是父会话白名单的子集。
```

### 2.5 数据流

```
用户发送 command
  ↓
OpenCodeAdapter.doSendCommand
  ↓
runToolAwareLoop
  ├─ 构建 prompt = scope + constraintSuffix + toolDesc + command + history
  ├─ spawnOnce(prompt) → stdout
  ├─ parseToolCalls(stdout) → calls
  ├─ for each dispatch_subagent call
  │    └─ subagentManager.invoke(args) → SubagentResult
  ├─ 把 assistant output + tool results 追加到 history
  └─ 循环直到无 tool call / 超时 / 达最大轮数
  ↓
emitOutput(stdout / complete / error)
```

### 2.6 错误处理

| 场景 | 行为 |
|---|---|
| stdout 无 tool call | 正常结束，emit 最后一轮 stdout + complete |
| tool call JSON 解析失败 | 记录 warn，把原始文本当作普通 stdout 输出，不中断循环 |
| 子智能体调用失败 | 把错误信息作为 tool result 返回给 LLM，让它决定如何继续 |
| 达到最大轮数（默认 5） | 终止循环，emit 最后一轮 stdout + 提示信息 |
| 总超时（默认 5min） | 终止所有进行中的子智能体，emit error |
| 同一轮多个 tool call | `Promise.all` 并行执行；若部分失败，失败的返回错误文本，成功的返回结果 |
| `subagentManager` 未注入 | 第一次进入 loop 时检查，若缺失直接 emit error |

### 2.7 测试策略

- `src/main/adapters/__tests__/base-tool-loop.test.ts`
  - `parseToolCalls`：正确解析、容错、忽略非 tool_call 内容。
  - `runToolAwareLoop`：单轮无 tool call、多轮 tool call、最大轮数截断、子智能体失败降级、超时处理。

- `src/main/adapters/__tests__/opencode-subagent.test.ts`
  - mock `child_process.spawn` 和 `SubagentManager`。
  - 验证 OpenCodeAdapter 能在 stdout 中识别 dispatch_subagent 并调用 `SubagentManager.invoke()`。
  - 验证子智能体结果会被回注到下一轮 prompt。
  - 验证无 tool call 时行为与改造前一致。

---

## 3. 工作流 B：Phase 5 E2E Playwright 测试

### 3.1 目标

在不依赖真实 LLM / 真实适配器的前提下，覆盖 Phase 5 新增的 UI 流程：
- Fan-out 子智能体派发对话框
- SubagentInvocationsPanel 状态流转
- 画布 Ctrl+click 多选与视觉指示器
- 从多选节点批量发起子智能体

### 3.2 核心机制：Mock IPC

沿用现有 `webServer: npm run dev` 的浏览器 E2E 模式。在页面加载前通过 `page.addInitScript()` 注入 mock 的 `window.electronAPI`，覆盖与子智能体、多选相关的 IPC 调用。

### 3.3 新增文件

#### 3.3.1 `tests/e2e/helpers/mock-ipc.ts`

- `setupMockIpc(page, handlers?)`: 注入 `window.electronAPI` mock。
- 提供默认 handlers：
  - 返回固定 graph、固定 node IDs。
  - 返回固定子智能体类型列表。
  - 返回固定 invocation 状态序列（queued → running → completed）。
- 提供辅助函数：
  - `pushAgentOutput(sessionId, output)`: 主动推送 agent 输出事件。
  - `advanceInvocationStatus(invocationId, status)`: 推进指定 invocation 状态。

#### 3.3.2 `tests/e2e/fan-out-dialog.spec.ts`

- 进入画布并创建模块节点。
- 右键节点打开上下文菜单，选择 Fan-out。
- 验证 Fan-out dialog 打开。
- 选择子智能体类型（如 explore）。
- 填写 prompt 并提交。
- 验证 mock 的 `subagent:invoke` 被正确调用，参数包含正确的 nodeId / agentType / prompt。

#### 3.3.3 `tests/e2e/subagent-invocations-panel.spec.ts`

- 进入画布。
- 触发一个子智能体调用（通过 Fan-out dialog）。
- 验证 SubagentInvocationsPanel（或 header badge）中出现 invocation 卡片。
- 验证状态从 `queued` → `running` → `completed` 依次显示。
- 验证 completed 后结果文本可见。
- 测试取消按钮触发 `subagent:cancel`。

#### 3.3.4 `tests/e2e/multi-select.spec.ts`

- 创建两个节点。
- 按住 Ctrl 点击第二个节点。
- 验证两个节点都带有紫色高亮样式（ring / border / shadow）。
- 验证工具栏或右键菜单出现“批量操作”入口。
- 验证 `selectedNodeIds` 状态包含两个节点 ID。

#### 3.3.5 `tests/e2e/subagent-dispatch-from-canvas.spec.ts`

- 创建两个节点并多选。
- 右键打开批量菜单，选择“派发子智能体”。
- 验证 Fan-out dialog 打开且 nodeId 字段预填充为多选节点。
- 提交后验证 `subagent:invoke` 被调用。

### 3.4 Mock 覆盖的 IPC 通道

- `graph:get`, `node:create`, `node:createBatch`
- `agent:startSession`, `agent:sendCommand`, `agent:terminateSession`
- `subagent:listTypes`, `subagent:listInvocations`, `subagent:invoke`, `subagent:cancel`
- `settings:read`
- 事件监听：`agent:onOutput`, `agent:onStatusChange`, `subagent:onProgress`

### 3.5 Mock 数据设计

- 固定 project path：`/tmp/bizgraph-e2e-project`
- 固定 graph ID：`graph_e2e_001`
- 固定 node IDs：`node_e2e_module_001`, `node_e2e_process_001`
- 固定 invocation ID：`inv_test_001`
- 状态序列：创建后立即 `queued`，测试通过 `advanceInvocationStatus` 推进到 `running` 再到 `completed`。
- 结果文本固定为 `"E2E subagent result"`。

### 3.6 稳定性策略

- 全部使用 `data-testid` 选择器。
- 不依赖真实异步时间：mock 状态切换通过 `page.evaluate` 触发。
- 每个测试 `beforeEach` 重置 mock 状态。
- 复用现有 `graph-helpers.ts` / `node-helpers.ts`。
- Playwright 自动等待断言（`toBeVisible`, `toHaveCount` 等）。

---

## 4. 接口与数据结构

### 4.1 新增共享类型（仅工作流 A 需要）

```typescript
// src/shared/types/subagent.ts 中 SubagentCapability 已有 'inline-protocol'，无需新增。

// 可能需要在 src/shared/types/agent.ts 中补充 AgentOutput 标记（可选）
// 当前 AgentOutput 已有 invocationId 字段，可直接复用。
```

### 4.2 BaseAdapter 新增内部类型

```typescript
interface InlineToolCall {
  tool: string
  args: Record<string, unknown>
}

type ToolHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; result: string }
```

### 4.3 OpenCode 能力标记更新

在 `src/main/adapters/registry.ts` 中为 OpenCode 添加 `Tools` 能力：

```typescript
{
  name: 'opencode',
  // ...
  capabilities: [
    AdapterCapability.Streaming,
    AdapterCapability.FileOps,
    AdapterCapability.SummaryRewrite,
    AdapterCapability.Tools, // 新增：支持 inline-protocol 子智能体工具
  ],
  // ...
}
```

Claude Code 与 MCP 适配器已经使用 `AdapterCapability.Tools` 表示原生工具支持；OpenCode 加入同一 capability，表示通过 inline protocol 支持 `dispatch_subagent`。

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| LLM 不遵循 `<tool_call>` 格式 | 高 | 在 prompt 中给出强约束 + 示例；解析失败时降级为普通 stdout |
| 重新 spawn 导致上下文丢失 | 中 | 通过 `history` 拼接维护上下文；OpenCode 本身无多轮能力，这是已知限制 |
| E2E mock IPC 与真实 preload 不同步 | 中 | mock 严格复用 `IpcApi` 签名；新增 IPC 时同步更新 mock |
| 多选视觉测试因 ReactFlow 渲染时机不稳定 | 低 | 使用 `waitForCanvas` 和 Playwright 自动等待；必要时增加 `data-testid` |

---

## 6. 不做范围

| 工作流 | 明确不做 |
|---|---|
| A | 不修改外部 CLI 二进制；不实现 `dispatch_subagent` 以外的 inline tool；其他 CLI 适配器（Cline/Kimi/Qwen 等）留到后续复用 |
| B | 不测试真实适配器；不启动 Electron 主进程；不覆盖聊天 thread 持久化流 |

---

## 7. 默认值与配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `MAX_TOOL_ROUNDS` | 5 | 单条 command 最多触发 5 轮 tool loop |
| `TOOL_AWARE_LOOP_TIMEOUT_MS` | 300,000 (5min) | 包含所有子智能体执行的总超时 |
| E2E mock invocation 状态延迟 | 0ms | 测试中手动推进，不依赖真实时间 |
| E2E 浏览器 | Chromium | 沿用现有 Playwright 配置 |

---

## 8. 验收标准

### 8.1 工作流 A

- [ ] `BaseAdapter` 新增 `buildSubagentToolPrompt`、`parseToolCalls`、`runToolAwareLoop`。
- [ ] `OpenCodeAdapter` 改造后，stdout 中出现 `<tool_call>dispatch_subagent</tool_call>` 时能正确触发 `SubagentManager.invoke()`。
- [ ] 子智能体结果能被回注到下一轮 prompt。
- [ ] 最大轮数和总超时被正确执行。
- [ ] 新增单元测试全部通过。

### 8.2 工作流 B

- [ ] 新增 `tests/e2e/helpers/mock-ipc.ts`，mock 覆盖 Phase 5 相关 IPC。
- [ ] 4 个新增 E2E 测试文件全部通过。
- [ ] 现有 E2E 测试不被破坏。
- [ ] CI 中 `npm run test:e2e` 通过。
