# 文件树与 Chat 输入框关联设计

> 日期: 2026-05-29
> 状态: 已批准
> 方案: A — 扩展现有 MentionSearchPopup

## 背景

当前文件树右键菜单的"Agent 输入框"选项仅切换面板并设置工作目录，未将文件路径注入到 Chat 输入框。Chat 输入框的 `@` 提及系统只搜索 Graph 节点，不搜索文件。两者之间缺乏有效关联。

## 设计目标

1. `@` 提及支持文件搜索（与节点混合列表 + Tab 切换）
2. 文件引用显示相对路径
3. 全项目递归扫描搜索范围
4. 选中文件后插入文本 + 添加上下文引用
5. FileTree 右键"Agent 输入框"修复为自动注入文件引用

## 架构设计

### 1. 主进程 — `fs:searchFiles` IPC

**新增 IPC 通道**：`fs:searchFiles(dirPath: string, query: string, limit?: number)`

**实现位置**：`src/main/ipc/fs.ts`

**行为**：
- 递归遍历 `dirPath`，跳过 `node_modules`、`.git`、`.next`、`dist`、`__pycache__`、`.DS_Store` 等
- 按文件名模糊匹配 `query`（大小写不敏感的 `includes`）
- 返回结果限制 `limit` 条（默认 20）
- 复用已有 `validateFsPath` 做路径安全校验

**返回类型**：
```typescript
interface FileSearchResult {
  name: string           // 文件名
  path: string           // 绝对路径
  relativePath: string   // 相对于 dirPath 的路径
  isDirectory: boolean
}
```

**类型声明**：在 `src/shared/types.ts` 的 `IpcApi` 中新增签名：
```typescript
'fs:searchFiles': (dirPath: string, query: string, limit?: number) => Promise<FileSearchResult[]>
```

### 2. 渲染进程 — MentionSearchPopup 扩展

**修改文件**：`src/renderer/components/agent/MentionSearchPopup.tsx`

**UI 结构**：
```
┌─────────────────────────────────┐
│  [Nodes] [Files]     ← Tab 栏   │
├─────────────────────────────────┤
│  ○ MyNode              node     │  ← 搜索结果
│  ◉ src/components/App  file     │
├─────────────────────────────────┤
│  Tab switch · ↑↓ nav · Enter    │
└─────────────────────────────────┘
```

**新增 props**：
```typescript
interface MentionSearchPopupProps {
  filter: string
  onSelect: (ref: ContextRef) => void
  onClose: () => void
  excludeIds: string[]
  projectPath?: string   // 新增：用于文件搜索的项目根路径
}
```

**内部逻辑变化**：
- 新增 `tab` 状态：`'nodes' | 'files'`，默认 `'nodes'`
- **Nodes tab**：复用现有逻辑（从 `useGraphStore` 搜索节点）
- **Files tab**：当 `projectPath` 存在且 `filter` 非空时，调用 `fs:searchFiles` IPC
  - 使用 debounce（300ms）避免频繁调用
  - 结果显示相对路径（截断 `projectPath` 前缀）
- 键盘：`Tab` 键切换分类，`↑↓` 导航，`Enter` 选中，`Esc` 关闭

**选中行为**：
- 生成 `ContextRef { type: 'file', id: absolutePath, label: relativePath }`
- 调用 `onSelect(ref)`

### 3. 渲染进程 — ChatInput 改动

**修改文件**：`src/renderer/components/agent/ChatInput.tsx`

**新增 props**：
```typescript
interface ChatInputProps {
  // ...existing...
  projectPath?: string   // 新增：传递给 MentionSearchPopup
}
```

**选中 file 后的行为**：
1. 替换输入框中的 `@query` 为 `@relativePath `（带空格，方便继续输入）
2. 调用 `onMentionAdd(ref)` 将引用添加到 ContextBar

### 4. 渲染进程 — AgentChatPanel 改动

**修改文件**：`src/renderer/components/agent/AgentChatPanel.tsx`

**改动点**：
- 从 `useGraphStore` 获取当前项目的 `projectPath`
- 传递 `projectPath` 给 `ChatInput`
- `handleSend` 中，将 `contextRefs` 中的 file 类型路径注入到 `sessionConfig.allowedFiles`

### 5. 渲染进程 — FileTreeContextMenu 修复

**修改文件**：`src/renderer/panels/FileTreeContextMenu.tsx`

**当前行为** (`handleAgentInput`)：
```typescript
setAgentWorkingDirectory(contextMenuPath)
setActiveRightPanel('agent')
```

**修复后行为**（保留原有 `agentWorkingDirectory` 设置）：
```typescript
// 保留原有：设置 Agent 工作目录
setAgentWorkingDirectory(contextMenuPath)
// 新增：设置待注入的上下文引用
setPendingContextRef({
  type: 'file',
  id: contextMenuPath,
  label: nodeName,
})
setActiveRightPanel('agent')
```

### 6. 渲染进程 — appStore 新增 pendingContextRef

**修改文件**：`src/renderer/store/appStore.ts`

**新增字段**：
```typescript
interface AppState {
  // ...existing...
  pendingContextRef: ContextRef | null
  setPendingContextRef: (ref: ContextRef | null) => void
}
```

**消费方**：`AgentChatPanel` 的 `useEffect` 监听 `pendingContextRef`，自动添加到 `attachedContexts` 并清除。

## 数据流

### @ 提及文件流
```
用户输入 @app
  → ChatInput.handleChange 检测到 @app
  → 渲染 MentionSearchPopup(filter="app")
  → 用户切换到 Files tab
  → MentionSearchPopup 调用 fs:searchFiles(projectPath, "app")
  → 主进程递归搜索，返回 [{name:"App.tsx", path:".../App.tsx", relativePath:"src/App.tsx"}]
  → 用户按 Enter 选中
  → ChatInput 在输入框插入 "@src/App.tsx "
  → ChatInput 调用 onMentionAdd({type:'file', id:'.../App.tsx', label:'src/App.tsx'})
  → AgentChatPanel.handleMentionAdd 更新 attachedContexts
  → ContextBar 显示文件引用卡片
```

### 右键菜单注入流
```
用户右键文件 → "Agent 输入框"
  → FileTreeContextMenu.handleAgentInput()
  → appStore.setPendingContextRef({type:'file', id:path, label:name})
  → appStore.setActiveRightPanel('agent')
  → AgentChatPanel useEffect 检测到 pendingContextRef
  → setAttachedContexts(prev => [...prev, ref])
  → appStore.setPendingContextRef(null)
  → ContextBar 显示文件引用卡片
```

### 发送消息流
```
用户点击发送
  → AgentChatPanel.handleSend(content, contextRefs)
  → sessionConfig.allowedFiles = contextRefs.filter(r => r.type === 'file').map(r => r.id)
  → sendMessage(threadId, content, contextRefs, sessionConfig)
```

## 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/ipc/fs.ts` | 新增 handler | `fs:searchFiles` 递归搜索 |
| `src/shared/types.ts` | 新增类型 | `FileSearchResult` + IpcApi 签名 |
| `src/preload/index.ts` | 新增通道 | 暴露 `fs:searchFiles` 到渲染进程 |
| `src/renderer/components/agent/MentionSearchPopup.tsx` | 重构 | 增加 Tab、文件搜索、debounce |
| `src/renderer/components/agent/ChatInput.tsx` | 小改 | 传递 projectPath，处理 file 选中文本插入 |
| `src/renderer/components/agent/AgentChatPanel.tsx` | 小改 | 传递 projectPath，处理 pendingContextRef |
| `src/renderer/panels/FileTreeContextMenu.tsx` | 小改 | handleAgentInput 使用 pendingContextRef |
| `src/renderer/store/appStore.ts` | 小改 | 新增 pendingContextRef 字段 |

## 不在范围内

- 拖拽文件到输入框（后续迭代）
- CLI 命令行输入框的文件注入（后续迭代）
- 文件内容预览/嵌入（后续迭代）
- 多文件批量选择注入（后续迭代）
