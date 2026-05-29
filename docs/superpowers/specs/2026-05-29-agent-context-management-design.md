# Agent 上下文管理系统设计

**日期**: 2026-05-29  
**分支**: feat/agent-chat-enhancement  
**状态**: 待实现

---

## 1. 问题陈述

### Bug: 右键"Agent 输入框"无效果

`FileTreeContextMenu.handleAgentInput` 将路径存入 `appStore.agentWorkingDirectory`，但 `AgentChatPanel` 从未读取该值。用户只看到 Tab 切换，无上下文注入。

### 上下文管理缺陷

| 问题 | 影响 |
|------|------|
| `ContextRef` 仅含 `{type, id, label}` | Adapter 无法基于此构建有效 prompt |
| `sendMessage` 接收 `contextRefs` 但 Adapter 不消费 | 上下文传递链路断裂 |
| 无 token 预算控制 | 上下文可无限膨胀，可能溢出 context window |
| 文件上下文无内容加载 | 用户 attach 了文件但 Agent 看不到内容 |

## 2. 设计目标

1. 右键"Agent 输入框" → 自动挂载为 file ContextRef 到 Agent 面板
2. ContextRef 在发送时被解析为实际内容，注入到 Agent 的 scope prompt
3. Token 预算机制防止 context 溢出
4. 保持向后兼容：不改变现有 AgentSessionConfig 结构

## 3. 架构设计

### 3.1 数据流

```
[右键菜单 / @-mention / ContextBar 添加]
              │
              ▼
        ContextRef[] (轻量引用，存储在 UI state)
              │
         sendMessage()
              │
              ▼
    ContextResolver.resolve()  ← main process 新增
              │  ├─ node refs → GraphRepo 读元数据
              │  ├─ file refs → fs.readFile 截取前 N 行
              │  └─ token 预算截断
              ▼
      ResolvedContext[] (带 content 的完整上下文)
              │
              ▼
    buildScopePrompt(config) + 追加上下文段
              │
              ▼
      Claude SDK / Adapter
```

### 3.2 ContextRef 扩展

**文件**: `src/shared/types.ts`

```ts
export interface ContextRef {
  type: 'node' | 'file'
  id: string
  label: string
  source?: 'user-attach' | 'right-click' | 'mention'
}
```

仅增加可选 `source` 字段用于来源追踪，不破坏现有结构。

### 3.3 ContextResolver（核心新增）

**文件**: `src/main/context-resolver.ts`

职责：将轻量 `ContextRef[]` 解析为带内容的 `ResolvedContext[]`。

```ts
interface ResolvedContext {
  type: 'node' | 'file'
  id: string
  label: string
  content: string        // 注入 prompt 的文本
  tokenEstimate: number  // 粗估 token 数（字符数 / 4）
}

class ContextResolver {
  // 依赖注入：GraphRepository + fs.readFile
  constructor(graphRepo: GraphRepository)

  async resolve(refs: ContextRef[], budget?: number): Promise<ResolvedContext[]>

  // 优先级排序：node 元数据 > 文件内容
  private sortByPriority(refs: ContextRef[]): ContextRef[]

  // 加载单个 ref 的内容
  private async loadNodeContent(id: string): Promise<string>
  private async loadFileContent(filePath: string, maxLines?: number): Promise<string>

  // Token 估算：中文字符 /1.5，英文单词 /4
  private estimateTokens(text: string): number
}
```

**解析策略**:
- **Node ref**: 读取 `title + description + rules + acceptanceCriteria + 上下游 edges 的 title`，拼成结构化文本
- **File ref**: `fs.readFile` → 取前 100 行，超出则截断并标注 `[truncated]`
- **Token 预算**: 默认 8000 tokens（约占 200K context 的 4%），按优先级依次填充，超额截断

### 3.4 注入到 buildScopePrompt

**文件**: `src/main/adapters/base.ts` — `buildScopePrompt` 方法

在现有逻辑末尾追加：

```ts
if (resolvedContexts && resolvedContexts.length > 0) {
  lines.push('## 附加上下文')
  for (const ctx of resolvedContexts) {
    lines.push(`### ${ctx.label} (${ctx.type})`)
    lines.push('```')
    lines.push(ctx.content)
    lines.push('```')
    lines.push('')
  }
}
```

### 3.5 IPC 通道

**文件**: `src/main/ipc-handlers.ts` 或新建 `src/main/ipc/context.ts`

新增 IPC handler: `context:resolve`

```ts
'context:resolve': (refs: ContextRef[]) => Promise<ResolvedContext[]>
```

供 renderer 端在 sendMessage 前预览上下文（可选），或直接在 main 端的 agent:sendCommand 流程中内联调用。

### 3.6 右键"Agent 输入框"修复

**方案**: 通过 appStore 传递初始上下文

**appStore.ts** 新增:
```ts
initialAgentContext: ContextRef | null
setInitialAgentContext: (ref: ContextRef | null) => void
```

**FileTreeContextMenu.tsx** — `handleAgentInput`:
```ts
const handleAgentInput = () => {
  const ref: ContextRef = {
    type: 'file',
    id: contextMenuPath,
    label: nodeName,
    source: 'right-click',
  }
  setInitialAgentContext(ref)
  setActiveRightPanel('agent')
  setContextMenu(null)
}
```

**AgentChatPanel.tsx** — 消费:
```ts
const initialCtx = useAppStore((s) => s.initialAgentContext)
useEffect(() => {
  if (initialCtx) {
    setAttachedContexts((prev) =>
      prev.some((c) => c.id === initialCtx.id) ? prev : [...prev, initialCtx]
    }
    useAppStore.getState().setInitialAgentContext(null)
  }
}, [initialCtx])
```

## 4. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/shared/types.ts` | 修改 | ContextRef 增加 source 字段 |
| `src/main/context-resolver.ts` | **新建** | ContextResolver 核心类 |
| `src/main/adapters/base.ts` | 修改 | buildScopePrompt 接收 ResolvedContext[] |
| `src/main/adapters/claude-code.ts` | 修改 | doSendCommand 调用 ContextResolver |
| `src/main/ipc-handlers.ts` | 修改 | 注册 context:resolve handler（可选） |
| `src/renderer/store/appStore.ts` | 修改 | 新增 initialAgentContext 字段 |
| `src/renderer/panels/FileTreeContextMenu.tsx` | 修改 | handleAgentInput 注入 ContextRef |
| `src/renderer/components/agent/AgentChatPanel.tsx` | 修改 | 消费 initialAgentContext |
| `src/main/__tests__/context-resolver.test.ts` | **新建** | ContextResolver 单元测试 |

## 5. 不做的事情

- 不做 embedding 向量索引（重量级，BizGraph 不需要语义搜索）
- 不做自动文件索引（由用户显式 attach 或右键注入）
- 不改变 AgentSessionConfig 结构（ResolvedContext 转为 config 字段注入）
- 不做跨会话上下文持久化（ContextRef 随 thread 生命周期）

## 6. 测试策略

1. **ContextResolver 单元测试**: mock GraphRepo + fs，验证 node/file 解析、token 截断、优先级排序
2. **集成验证**: 右键文件 → Agent 面板出现 ContextRef → 发送消息 → 检查 prompt 包含文件内容
3. **边界测试**: 空 refs、超大文件、token 溢出截断
