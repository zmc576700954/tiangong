# 思维导图增强实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让思维导图的节点和边承载真实业务逻辑——节点关联文件/方法，边承载判断条件和业务备注，新增 project 根节点，完善模块/流程/功能点/BUG 点层级。

**Architecture:** 自底向上扩展数据层（类型 → 数据库 → 仓库），再逐层更新 UI（边工具 → 节点组件 → 菜单 → 编辑器 → Agent 集成）。所有变更向后兼容，`rebuildTableIfNeeded` 会自动处理 schema 迁移。

**Tech Stack:** TypeScript, Zustand, @xyflow/react, LibSQL, Vitest

**Spec:** `docs/superpowers/specs/2026-05-29-mindmap-enhancement-design.md`

---

## 文件变更总览

| 操作 | 文件 | 职责 |
|------|------|------|
| Modify | `src/shared/types.ts` | 新增 FileAssociation, EdgeContent 类型，扩展 NodeType, EdgeType, NodeMetadata, GraphEdge |
| Modify | `src/shared/constants.ts` | 新增 project/business-flow 常量 |
| Modify | `src/main/database.ts` | schema 迁移：nodes CHECK 加 project，edges 加 content 列和 business-flow |
| Modify | `src/main/repositories/edge-repository.ts` | create/update 支持 content 字段 |
| Modify | `src/main/repositories/graph-repository.ts` | get() 边映射加 content 字段 |
| Modify | `src/renderer/canvas/edge-utils.ts` | business-flow 配置 |
| Modify | `src/renderer/canvas/BizNode.tsx` | project 节点样式 |
| Modify | `src/renderer/canvas/BizEdge.tsx` | business-flow 样式和 tooltip |
| Modify | `src/renderer/canvas/NodeContextMenu.tsx` | project 类型菜单调整 |
| Modify | `src/renderer/canvas/components/CanvasOverlay.tsx` | 节点创建菜单/边类型菜单调整 |
| Modify | `src/renderer/canvas/GraphCanvas.tsx` | project 自动创建、边渲染 content |
| Modify | `src/renderer/panels/RightPanel.tsx` | NodeEditor 加 fileAssociations，EdgeEditor 加 edgeContent |
| Modify | `src/renderer/components/agent/promptTemplates.ts` | Agent 上下文注入 |
| Create | `src/renderer/canvas/agent-context-builder.ts` | Agent 上下文构建工具函数 |
| Create | `src/renderer/canvas/__tests__/agent-context-builder.test.ts` | Agent 上下文构建测试 |

---

### Task 1: 类型定义扩展

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`

- [ ] **Step 1: 在 types.ts 中新增 FileAssociation 接口**

在 `NodeMetadata` 接口之前插入：

```typescript
/** 文件/方法关联 */
export interface FileAssociation {
  path: string
  type: 'file' | 'directory' | 'method'
  methodName?: string
  description?: string
}
```

- [ ] **Step 2: 扩展 NodeMetadata 添加 fileAssociations**

在 `NodeMetadata` 接口中添加：

```typescript
export interface NodeMetadata {
  apis?: { name: string; method?: string; path?: string; description?: string }[]
  services?: { name: string; description?: string }[]
  entities?: { name: string; fields?: string; description?: string }[]
  fileAssociations?: FileAssociation[]
}
```

- [ ] **Step 3: 新增 EdgeContent 接口**

在 `GraphEdge` 接口之前插入：

```typescript
/** 边的业务内容 */
export interface EdgeContent {
  condition?: string
  note?: string
}
```

- [ ] **Step 4: 扩展 GraphEdge 添加 content 字段**

```typescript
export interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
  graphId: string
  edgeType?: EdgeType
  content?: EdgeContent
}
```

- [ ] **Step 5: 扩展 NodeType 和 EdgeType**

```typescript
export type NodeType = 'project' | 'module' | 'process' | 'feature' | 'bug'

export type EdgeType = 'default' | 'success' | 'failure' | 'condition' | 'business-flow'
```

- [ ] **Step 6: 在 constants.ts 中新增 project 常量**

更新 `NODE_TYPE_LABELS`：

```typescript
export const NODE_TYPE_LABELS: Record<string, string> = {
  project: '项目',
  module: '业务模块',
  process: '业务流程',
  feature: '功能点',
  bug: 'BUG点',
}
```

更新 `NODE_TYPE_COLORS`：

```typescript
export const NODE_TYPE_COLORS: Record<string, string> = {
  project: '#6366f1',
  module: '#3b82f6',
  process: '#8b5cf6',
  feature: '#22c55e',
  bug: '#ef4444',
}
```

更新 `CANVAS_NODE_TYPES`：

```typescript
export const CANVAS_NODE_TYPES = [
  { type: 'project', label: '项目', color: '#6366f1' },
  { type: 'module', label: '业务模块', color: '#3b82f6' },
  { type: 'process', label: '业务流程', color: '#8b5cf6' },
  { type: 'feature', label: '功能点', color: '#22c55e' },
  { type: 'bug', label: 'BUG点', color: '#ef4444' },
] as const
```

更新 `EDGE_TYPE_OPTIONS`：

```typescript
export const EDGE_TYPE_OPTIONS: { type: EdgeType; label: string; color: string; description: string }[] = [
  { type: 'default', label: '默认流程', color: '#94a3b8', description: '标准流程连接' },
  { type: 'success', label: '成功分支', color: '#22c55e', description: '成功后的流程分支' },
  { type: 'failure', label: '失败分支', color: '#ef4444', description: '失败后的异常分支' },
  { type: 'condition', label: '条件分支', color: '#f59e0b', description: '条件判断分支' },
  { type: 'business-flow', label: '业务流程', color: '#3b82f6', description: '跨模块业务关联' },
]
```

- [ ] **Step 7: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增类型错误（现有代码中引用旧类型值的地方会在后续 task 修复）

- [ ] **Step 8: 提交**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat: extend types for project node, edgeContent, fileAssociations"
```

---

### Task 2: 数据库 Schema 迁移

**Files:**
- Modify: `src/main/database.ts`

- [ ] **Step 1: 更新 nodes 表的 CHECK 约束**

在 `migrate()` 函数中，找到 nodes 表的 `rebuildTableIfNeeded` 调用（约第 241 行），将：

```
type TEXT NOT NULL CHECK(type IN ('module', 'process', 'feature', 'bug'))
```

改为：

```
type TEXT NOT NULL CHECK(type IN ('project', 'module', 'process', 'feature', 'bug'))
```

- [ ] **Step 2: 更新 edges 表 schema**

找到 edges 表的 `rebuildTableIfNeeded` 调用（约第 263 行），将：

```sql
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT,
  edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition')),
  graph_id TEXT NOT NULL
)
```

改为：

```sql
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT,
  edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition', 'business-flow')),
  content TEXT,
  graph_id TEXT NOT NULL
)
```

- [ ] **Step 3: 运行测试确认 schema 迁移不破坏现有测试**

Run: `npx vitest run src/main/__tests__/database.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/main/database.ts
git commit -m "feat: migrate database schema for project nodes and edge content"
```

---

### Task 3: Edge Repository 支持 content 字段

**Files:**
- Modify: `src/main/repositories/edge-repository.ts`
- Modify: `src/main/repositories/graph-repository.ts`

- [ ] **Step 1: 更新 EdgeRepository.create 方法**

将 `create` 方法中的 INSERT SQL 和返回值更新：

```typescript
async create(data: Omit<GraphEdge, 'id'>): Promise<GraphEdge> {
  const id = generateId('edge')

  await this.db.execute({
    sql: 'INSERT INTO edges (id, source, target, label, edge_type, content, graph_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [
      id,
      data.source,
      data.target,
      data.label ?? null,
      data.edgeType ?? null,
      data.content ? JSON.stringify(data.content) : null,
      data.graphId,
    ],
  })

  return { ...data, id }
}
```

- [ ] **Step 2: 更新 EdgeRepository.update 方法**

在 `update` 方法中，找到字段检查部分（约第 28-29 行），在 `edgeType` 检查之后添加：

```typescript
if (data.content !== undefined) {
  updates.push('content = ?')
  args.push(data.content ? JSON.stringify(data.content) : null)
}
```

在 update 方法的两个 SELECT 返回映射中（约第 36-41 行和第 56-62 行），添加 content 字段：

```typescript
content: row.content ? JSON.parse(row.content as string) : undefined,
```

- [ ] **Step 3: 更新 GraphRepository.get 的边映射**

在 `graph-repository.ts` 的 `get` 方法中，找到 edges 映射（约第 95-102 行），添加 content 字段：

```typescript
edges: edgesResult.rows.map((row) => ({
  id: rowStr(row, 'id'),
  source: rowStr(row, 'source'),
  target: rowStr(row, 'target'),
  label: rowOptStr(row, 'label'),
  graphId: rowStr(row, 'graph_id'),
  edgeType: rowOptStr(row, 'edge_type') as GraphEdge['edgeType'],
  content: row.content ? JSON.parse(rowStr(row, 'content')) : undefined,
})),
```

- [ ] **Step 4: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add src/main/repositories/edge-repository.ts src/main/repositories/graph-repository.ts
git commit -m "feat: add content field support to edge repositories"
```

---

### Task 4: edge-utils 扩展

**Files:**
- Modify: `src/renderer/canvas/edge-utils.ts`

- [ ] **Step 1: 添加 business-flow 配置**

```typescript
export const edgeTypeConfig: Record<EdgeType, { color: string; label: string; animated?: boolean; strokeDasharray?: string }> = {
  default: { color: '#94a3b8', label: '默认' },
  success: { color: '#22c55e', label: '成功' },
  failure: { color: '#ef4444', label: '失败' },
  condition: { color: '#f59e0b', label: '条件' },
  'business-flow': { color: '#3b82f6', label: '业务流程', animated: true, strokeDasharray: '8 4' },
}
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/canvas/edge-utils.ts
git commit -m "feat: add business-flow edge type config"
```

---

### Task 5: Project 节点自动创建与画布行为

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx`

- [ ] **Step 1: 添加 project 节点自动创建逻辑**

在 `GraphCanvasInner` 组件中，找到 `useEffect` 中 `loadGraph(graphId)` 的调用（约第 150-158 行），在其后添加 project 节点自动创建逻辑：

```typescript
useEffect(() => {
  loadGraph(graphId)
  // 切换图时清空待保存的位置队列
  pendingPositionUpdates.current = new Map()
  if (debounceTimerRef.current) {
    clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = null
  }
}, [graphId, loadGraph])

// 自动创建 project 根节点
useEffect(() => {
  if (graphNodes.length === 0) return
  const hasProject = graphNodes.some((n) => n.type === 'project')
  if (!hasProject) {
    // 延迟一帧，确保图数据已加载完毕
    const graphs = useGraphStore.getState().graphs
    const currentGraph = graphs.find((g) => g.id === graphId)
    const title = currentGraph?.name ?? '项目'
    createNode({
      type: 'project',
      status: 'confirmed',
      title,
      graphId,
      graphType: 'online',
      position: { x: 0, y: 0 },
      acceptanceCriteria: [],
    }).catch((err) => {
      console.error('[GraphCanvas] Failed to create project node:', err)
    })
  }
}, [graphNodes, graphId, createNode])
```

- [ ] **Step 2: 阻止 project 节点的拖拽**

在 `useEffect` 中构建 `flowNodes` 的位置（约第 175-184 行），为 project 节点设置 `draggable: false`：

```typescript
const flowNodes: Node[] = graphNodes.map((node) => ({
  id: node.id,
  type: 'bizNode',
  position: node.position,
  data: {
    ...node,
    bugCount: bugCountMap.get(node.id) ?? 0,
  },
  selected: node.id === selectedNodeId || node.id === connectingSourceId,
  draggable: node.type !== 'project',
}))
```

- [ ] **Step 3: 阻止 project 节点的删除**

在 `handleNodeDelete` 函数（约第 466-470 行）中添加拦截：

```typescript
const handleNodeDelete = async (nodeId: string) => {
  const node = graphNodes.find((n) => n.id === nodeId)
  if (node?.type === 'project') return
  await deleteNode(nodeId)
  selectNode(null)
  setNodeContextMenu(null)
}
```

- [ ] **Step 4: 更新边渲染以支持 content 和 business-flow**

在构建 `flowEdges` 的 `useEffect`（约第 186-207 行）中，更新边的 label 优先级和 business-flow 样式：

```typescript
const flowEdges: Edge[] = graphEdges.map((edge) => {
  const edgeType = edge.edgeType || 'default'
  const config = edgeTypeConfig[edgeType]
  const displayLabel = edge.content?.condition
    ? (edge.content.condition.length > 20 ? edge.content.condition.slice(0, 20) + '…' : edge.content.condition)
    : edge.label

  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: displayLabel,
    type: 'bizEdge',
    data: { edgeType, content: edge.content },
    markerEnd: getEdgeMarkerEnd(edgeType),
    selected: edge.id === selectedEdgeId,
    animated: edgeType === 'failure' || edgeType === 'business-flow',
    style: {
      stroke: config.color,
      strokeWidth: edge.id === selectedEdgeId ? 3 : 2,
      strokeDasharray: config.strokeDasharray,
    },
  }
})
```

需要在文件顶部导入 `edgeTypeConfig`：

```typescript
import { getEdgeMarkerEnd, edgeTypeConfig } from './edge-utils'
```

- [ ] **Step 5: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 6: 提交**

```bash
git add src/renderer/canvas/GraphCanvas.tsx
git commit -m "feat: auto-create project node and support business-flow edges"
```

---

### Task 6: BizNode Project 类型样式

**Files:**
- Modify: `src/renderer/canvas/BizNode.tsx`

- [ ] **Step 1: 为 project 节点添加特殊渲染**

在 `BizNodeComponent` 中，根据 `data.type` 判断是否为 project 节点，使用不同的样式：

```tsx
export function BizNodeComponent({
  id: _id,
  data,
  selected: _selected,
  onContextMenu,
}: BizNodeProps) {
  const statusClass = getNodeStatusClass(data.status)
  const typeColor = NODE_TYPE_COLORS[data.type] ?? '#94a3b8'
  const isProject = data.type === 'project'

  if (isProject) {
    return (
      <div
        className="group px-6 py-4 rounded-xl border-2 min-w-[180px] shadow-md cursor-default"
        style={{
          borderColor: typeColor,
          background: `linear-gradient(135deg, ${typeColor}08, ${typeColor}15)`,
        }}
        onContextMenu={onContextMenu}
      >
        <Handle
          type="source"
          position={Position.Bottom}
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-bottom-[5px] transition-all"
        />
        <Handle
          type="source"
          position={Position.Right}
          id="right"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-right-[5px] transition-all"
        />
        <div className="flex items-center gap-1.5 mb-1">
          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor }} />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {NODE_TYPE_LABELS[data.type]}
          </span>
        </div>
        <div className="font-bold text-lg truncate">{data.title}</div>
      </div>
    )
  }

  // ... 原有的非 project 节点渲染保持不变
  return (
    <div
      className={cn(
        'group px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-sm transition-all hover:shadow-md cursor-pointer',
        statusClass,
      )}
      onContextMenu={onContextMenu}
    >
      {/* ... 原有内容不变 ... */}
    </div>
  )
}
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/canvas/BizNode.tsx
git commit -m "feat: add project node visual styling"
```

---

### Task 7: 节点右键菜单调整

**Files:**
- Modify: `src/renderer/canvas/NodeContextMenu.tsx`

- [ ] **Step 1: 更新 getChildTypeOptions 支持 project 类型**

```typescript
function getChildTypeOptions(parentType: NodeType): NodeType[] {
  switch (parentType) {
    case 'project':
      return ['module']
    case 'module':
      return ['process', 'feature', 'bug']
    case 'process':
      return ['feature', 'bug']
    case 'feature':
      return ['bug']
    case 'bug':
      return []
    default:
      return ['feature']
  }
}
```

- [ ] **Step 2: 隐藏 project 节点的状态切换和删除按钮**

在 `NodeContextMenu` 组件的 JSX 中，将状态切换区域和删除按钮用 `node.type !== 'project'` 包裹：

```tsx
{/* 状态切换 */}
{node.type !== 'project' && (
  <div className="border-t mt-1 pt-1">
    <div className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">状态</div>
    <div className="px-2 pb-1 grid grid-cols-3 gap-1">
      {statusOptions.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onStatusChange(nodeId, opt.value)}
          className={cn(
            'px-1.5 py-1 text-[10px] rounded border transition-colors',
            node.status === opt.value
              ? 'border-transparent text-white'
              : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
          )}
          style={node.status === opt.value ? { backgroundColor: opt.color } : undefined}
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>
)}

{/* 删除节点 */}
{node.type !== 'project' && (
  <div className="border-t mt-1 pt-1">
    <button
      onClick={() => onDelete(nodeId)}
      className="w-full text-left px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-2"
    >
      <Trash2 className="w-3.5 h-3.5" />
      删除节点
    </button>
  </div>
)}
```

- [ ] **Step 3: 提交**

```bash
git add src/renderer/canvas/NodeContextMenu.tsx
git commit -m "feat: adjust context menu for project node type"
```

---

### Task 8: 画布覆盖层菜单调整

**Files:**
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx`

- [ ] **Step 1: 节点创建菜单隐藏已存在的 project 类型**

更新 `CanvasOverlay` 接口，新增 `hasProjectNode` 属性：

```typescript
interface CanvasOverlayProps {
  isEmpty: boolean
  showNodeMenu: boolean
  menuPosition: { x: number; y: number }
  onCreateNode: (type: NodeType) => void
  showEdgeTypeMenu: boolean
  edgeMenuPosition: { x: number; y: number }
  pendingConnection: Connection | null
  onCreateEdge: (type: EdgeType, content?: { condition?: string; note?: string }) => void
  nodeContextMenu: { nodeId: string; x: number; y: number } | null
  nodes: GraphNode[]
  onNodeStatusChange: (nodeId: string, status: NodeStatus) => void
  onNodeDelete: (nodeId: string) => void
  onCloseNodeContextMenu: () => void
  onAddChild: (parentId: string, childType: NodeType) => void
  onStartConnect: (sourceId: string) => void
  hasProjectNode?: boolean
}
```

在节点创建菜单中过滤掉已存在的 project：

```tsx
{(['module', 'process', 'feature', 'bug'] satisfies NodeType[])
  .map((type) => (
    <button
      key={type}
      onClick={() => onCreateNode(type)}
      className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
    >
      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: NODE_TYPE_COLORS[type] }} />
      {NODE_TYPE_LABELS[type]}
    </button>
  ))}
```

- [ ] **Step 2: 边类型选择菜单添加 business-flow 内联输入**

在边类型选择菜单中，为 `business-flow` 添加内联的条件和备注输入框。引入 `useState` 管理选中的类型和输入值：

```tsx
import { useState } from 'react'

// 在 EdgeTypeMenu 部分：
const [selectedEdgeType, setSelectedEdgeType] = useState<EdgeType | null>(null)
const [edgeCondition, setEdgeCondition] = useState('')
const [edgeNote, setEdgeNote] = useState('')
```

更新边类型菜单渲染逻辑：

```tsx
{showEdgeTypeMenu && pendingConnection && (
  <div
    className="absolute z-50 bg-background border rounded-lg shadow-lg py-2 w-56"
    style={{ left: edgeMenuPosition.x, top: edgeMenuPosition.y }}
  >
    <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1 flex items-center gap-1">
      <GitBranch className="w-3 h-3" />
      选择连接类型
    </div>
    {EDGE_TYPE_OPTIONS.map((opt) => (
      <button
        key={opt.type}
        onClick={() => {
          if (opt.type === 'business-flow') {
            setSelectedEdgeType('business-flow')
          } else {
            onCreateEdge(opt.type)
            setSelectedEdgeType(null)
            setEdgeCondition('')
            setEdgeNote('')
          }
        }}
        className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center gap-2"
      >
        <div
          className="w-3 h-3 rounded-full flex-shrink-0 border"
          style={{ backgroundColor: opt.color, borderColor: opt.color }}
        />
        <div className="flex flex-col">
          <span>{opt.label}</span>
          <span className="text-[10px] text-muted-foreground">{opt.description}</span>
        </div>
      </button>
    ))}
    {selectedEdgeType === 'business-flow' && (
      <div className="px-3 pt-2 pb-1 border-t mt-1 space-y-2">
        <div>
          <label className="text-[10px] text-muted-foreground">判断条件</label>
          <input
            type="text"
            value={edgeCondition}
            onChange={(e) => setEdgeCondition(e.target.value)}
            placeholder="如：退款申请通过"
            className="w-full mt-0.5 px-2 py-1 text-xs border rounded bg-background"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground">备注说明</label>
          <textarea
            value={edgeNote}
            onChange={(e) => setEdgeNote(e.target.value)}
            placeholder="如：需同步回滚库存"
            rows={2}
            className="w-full mt-0.5 px-2 py-1 text-xs border rounded bg-background resize-none"
          />
        </div>
        <button
          onClick={() => {
            const content = {
              ...(edgeCondition.trim() && { condition: edgeCondition.trim() }),
              ...(edgeNote.trim() && { note: edgeNote.trim() }),
            }
            onCreateEdge('business-flow', Object.keys(content).length > 0 ? content : undefined)
            setSelectedEdgeType(null)
            setEdgeCondition('')
            setEdgeNote('')
          }}
          className="w-full py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
        >
          确认创建
        </button>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 3: 更新 GraphCanvas 中传递 hasProjectNode 和 onCreateEdge 签名**

在 `GraphCanvas.tsx` 中更新 `CanvasOverlay` 的 props：

```tsx
<CanvasOverlay
  // ... existing props
  hasProjectNode={graphNodes.some((n) => n.type === 'project')}
/>
```

更新 `handleCreateEdge` 签名以接受可选 content：

```typescript
const handleCreateEdge = useCallback(
  async (edgeType: EdgeType, content?: { condition?: string; note?: string }) => {
    if (!pendingConnection?.source || !pendingConnection?.target) return
    const edge = await createEdge({
      source: pendingConnection.source,
      target: pendingConnection.target,
      label: '',
      graphId,
      edgeType,
      content,
    })
    // ... rest stays the same
  },
  [pendingConnection, createEdge, graphId, setRfEdges],
)
```

- [ ] **Step 4: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add src/renderer/canvas/components/CanvasOverlay.tsx src/renderer/canvas/GraphCanvas.tsx
git commit -m "feat: update canvas menus for project node and business-flow edge creation"
```

---

### Task 9: BizEdge business-flow 样式和 tooltip

**Files:**
- Modify: `src/renderer/canvas/BizEdge.tsx`

- [ ] **Step 1: 添加 content 到 edge data 类型**

更新 `BizEdgeType` 的泛型参数：

```typescript
import type { EdgeContent } from '@shared/types'

type BizEdgeType = Edge<{ edgeType?: EdgeType; content?: EdgeContent }, 'bizEdge'>
```

- [ ] **Step 2: 添加 business-flow 样式和 tooltip**

在 `BizEdge` 组件中，获取 content 并在悬停时显示 note tooltip：

```typescript
const content = data?.content
const isBusinessFlow = edgeType === 'business-flow'
```

在 `EdgeLabelRenderer` 的标签 div 中，当悬停且有 `content.note` 时，添加 tooltip：

```tsx
<div
  className={cn(
    'nodrag nopan pointer-events-auto flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium shadow-sm transition-all',
    isBusinessFlow
      ? 'border-blue-300 bg-blue-50 text-blue-700'
      : selected
        ? 'border-blue-300 bg-blue-50 text-blue-700'
        : 'border-slate-200 bg-white text-slate-600',
  )}
  // ... existing style/position props
  title={content?.note || undefined}
>
```

- [ ] **Step 3: 提交**

```bash
git add src/renderer/canvas/BizEdge.tsx
git commit -m "feat: add business-flow edge styling and note tooltip"
```

---

### Task 10: NodeEditor 文件关联面板

**Files:**
- Modify: `src/renderer/panels/RightPanel.tsx`

- [ ] **Step 1: 在 NodeEditor 中添加 FileAssociationsEditor 区域**

在 NodeEditor 的 Description 下方、StatusSelector 下方，添加文件关联编辑区域。在 `NodeEditor` 函数组件内，Description 之后插入：

```tsx
{/* File Associations */}
<FileAssociationsEditor
  associations={node.metadata?.fileAssociations ?? []}
  onUpdate={(fileAssociations) =>
    onUpdate({ metadata: { ...node.metadata, fileAssociations } })
  }
/>
```

- [ ] **Step 2: 实现 FileAssociationsEditor 子组件**

在 `RightPanel.tsx` 文件末尾（`EdgeEditor` 之后）添加：

```tsx
function FileAssociationsEditor({
  associations,
  onUpdate,
}: {
  associations: import('@shared/types').FileAssociation[]
  onUpdate: (v: import('@shared/types').FileAssociation[]) => void
}) {
  const [isAdding, setIsAdding] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newType, setNewType] = useState<'file' | 'directory' | 'method'>('file')
  const [newMethod, setNewMethod] = useState('')
  const [newDesc, setNewDesc] = useState('')

  const handleAdd = () => {
    if (!newPath.trim()) return
    const assoc: import('@shared/types').FileAssociation = {
      path: newPath.trim(),
      type: newType,
      ...(newType === 'method' && newMethod.trim() && { methodName: newMethod.trim() }),
      ...(newDesc.trim() && { description: newDesc.trim() }),
    }
    onUpdate([...associations, assoc])
    setNewPath('')
    setNewMethod('')
    setNewDesc('')
    setIsAdding(false)
  }

  const handleRemove = (index: number) => {
    onUpdate(associations.filter((_, i) => i !== index))
  }

  const typeIcons: Record<string, string> = {
    file: '📄',
    directory: '📁',
    method: '⚡',
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">关联文件</label>
      {associations.length > 0 && (
        <div className="space-y-1">
          {associations.map((assoc, i) => (
            <div key={i} className="flex items-center gap-1.5 px-2 py-1 text-sm bg-muted/50 rounded group">
              <span className="text-xs">{typeIcons[assoc.type]}</span>
              <span className="truncate flex-1 font-mono text-xs">
                {assoc.path}
                {assoc.methodName && <span className="text-muted-foreground"> :: {assoc.methodName}</span>}
              </span>
              <button
                onClick={() => handleRemove(i)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-destructive transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {isAdding ? (
        <div className="space-y-1.5 p-2 border rounded-md">
          <div className="flex gap-1">
            {(['file', 'directory', 'method'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setNewType(t)}
                className={cn(
                  'px-2 py-0.5 text-[10px] rounded border transition-colors',
                  newType === t
                    ? 'bg-primary text-primary-foreground border-transparent'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'file' ? '文件' : t === 'directory' ? '目录' : '方法'}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="相对路径，如 src/order/service.ts"
            className="w-full px-2 py-1 text-xs border rounded bg-background"
            autoFocus
          />
          {newType === 'method' && (
            <input
              type="text"
              value={newMethod}
              onChange={(e) => setNewMethod(e.target.value)}
              placeholder="方法名，如 refund"
              className="w-full px-2 py-1 text-xs border rounded bg-background"
            />
          )}
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="简要说明（可选）"
            className="w-full px-2 py-1 text-xs border rounded bg-background"
          />
          <div className="flex gap-1">
            <button onClick={handleAdd} className="flex-1 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90">
              添加
            </button>
            <button onClick={() => setIsAdding(false)} className="flex-1 py-1 text-xs border rounded hover:bg-muted">
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="w-full py-1.5 text-xs border border-dashed rounded text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          + 添加关联
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 提交**

```bash
git add src/renderer/panels/RightPanel.tsx
git commit -m "feat: add file associations editor to node panel"
```

---

### Task 11: EdgeEditor edgeContent 字段

**Files:**
- Modify: `src/renderer/panels/RightPanel.tsx`

- [ ] **Step 1: 在 EdgeEditor 中添加 business-flow 类型选项**

更新 `edgeTypeOptions` 数组：

```typescript
const edgeTypeOptions = [
  { value: 'default' as const, label: '默认流程', color: '#94a3b8' },
  { value: 'success' as const, label: '成功分支', color: '#22c55e' },
  { value: 'failure' as const, label: '失败分支', color: '#ef4444' },
  { value: 'condition' as const, label: '条件分支', color: '#f59e0b' },
  { value: 'business-flow' as const, label: '业务流程', color: '#3b82f6' },
]
```

- [ ] **Step 2: 在 EdgeEditor 的 Label 区域之后添加 edgeContent 编辑区**

```tsx
{/* Edge Content (business logic) */}
{(edge.edgeType === 'business-flow' || edge.content) && (
  <div className="space-y-1.5">
    <label className="text-xs font-medium text-muted-foreground">业务逻辑</label>
    <div className="space-y-1.5">
      <div>
        <label className="text-[10px] text-muted-foreground">判断条件</label>
        <input
          type="text"
          value={edge.content?.condition || ''}
          onChange={(e) =>
            onUpdate({
              content: { ...edge.content, condition: e.target.value || undefined },
            })
          }
          placeholder="如：库存 > 0"
          className="w-full mt-0.5 px-2 py-1.5 text-sm border rounded-md bg-background"
        />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground">备注说明</label>
        <textarea
          value={edge.content?.note || ''}
          onChange={(e) =>
            onUpdate({
              content: { ...edge.content, note: e.target.value || undefined },
            })
          }
          placeholder="如：退款时需同步回滚库存"
          rows={3}
          className="w-full mt-0.5 px-2 py-1.5 text-sm border rounded-md bg-background resize-none"
        />
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 3: 提交**

```bash
git add src/renderer/panels/RightPanel.tsx
git commit -m "feat: add edge content editor for business-flow edges"
```

---

### Task 12: Agent Prompt 模板扩展

**Files:**
- Modify: `src/renderer/components/agent/promptTemplates.ts`
- Create: `src/renderer/canvas/__tests__/agent-context-builder.test.ts`

- [ ] **Step 1: 创建 agent-context-builder 工具函数**

在 `src/renderer/canvas/` 目录下创建 `agent-context-builder.ts`：

```typescript
import type { GraphNode, GraphEdge, FileAssociation } from '@shared/types'

/** 递归收集节点及其祖先的 fileAssociations */
export function collectFileAssociations(
  nodeId: string,
  nodes: GraphNode[],
): FileAssociation[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const result: FileAssociation[] = []
  const visited = new Set<string>()

  let current: GraphNode | undefined = nodeMap.get(nodeId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    if (current.metadata?.fileAssociations) {
      result.push(...current.metadata.fileAssociations)
    }
    current = current.parentId ? nodeMap.get(current.parentId) : undefined
  }
  return result
}

/** 收集节点通过 business-flow 边连接的上下游约束 */
export function collectCrossModuleConstraints(
  nodeId: string,
  edges: GraphEdge[],
  nodes: GraphNode[],
): string[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const constraints: string[] = []

  for (const edge of edges) {
    if (edge.edgeType !== 'business-flow') continue
    if (!edge.content?.note) continue

    if (edge.source === nodeId) {
      const targetNode = nodeMap.get(edge.target)
      const targetLabel = targetNode?.title ?? '未知节点'
      const condition = edge.content.condition ? ` (条件: ${edge.content.condition})` : ''
      constraints.push(`连接至「${targetLabel}」: ${edge.content.note}${condition}`)
    } else if (edge.target === nodeId) {
      const sourceNode = nodeMap.get(edge.source)
      const sourceLabel = sourceNode?.title ?? '未知节点'
      const condition = edge.content.condition ? ` (条件: ${edge.content.condition})` : ''
      constraints.push(`来自「${sourceLabel}」: ${edge.content.note}${condition}`)
    }
  }
  return constraints
}
```

- [ ] **Step 2: 编写 agent-context-builder 测试**

创建 `src/renderer/canvas/__tests__/agent-context-builder.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { collectFileAssociations, collectCrossModuleConstraints } from '../agent-context-builder'
import type { GraphNode, GraphEdge } from '@shared/types'

function makeNode(overrides: Partial<GraphNode> & { id: string; type: GraphNode['type'] }): GraphNode {
  return {
    status: 'draft',
    title: overrides.id,
    graphId: 'g1',
    graphType: 'online',
    position: { x: 0, y: 0 },
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as GraphNode
}

describe('collectFileAssociations', () => {
  it('returns empty array when node has no fileAssociations', () => {
    const nodes = [makeNode({ id: 'n1', type: 'feature' })]
    expect(collectFileAssociations('n1', nodes)).toEqual([])
  })

  it('returns direct fileAssociations', () => {
    const nodes = [
      makeNode({
        id: 'n1',
        type: 'feature',
        metadata: {
          fileAssociations: [{ path: 'src/a.ts', type: 'file' }],
        },
      }),
    ]
    expect(collectFileAssociations('n1', nodes)).toEqual([
      { path: 'src/a.ts', type: 'file' },
    ])
  })

  it('collects from ancestors', () => {
    const nodes = [
      makeNode({
        id: 'module1',
        type: 'module',
        metadata: { fileAssociations: [{ path: 'src/module/', type: 'directory' }] },
      }),
      makeNode({
        id: 'feature1',
        type: 'feature',
        parentId: 'module1',
        metadata: { fileAssociations: [{ path: 'src/module/feature.ts', type: 'file' }] },
      }),
    ]
    const result = collectFileAssociations('feature1', nodes)
    expect(result).toHaveLength(2)
    expect(result.map((a) => a.path)).toContain('src/module/')
    expect(result.map((a) => a.path)).toContain('src/module/feature.ts')
  })
})

describe('collectCrossModuleConstraints', () => {
  it('returns empty when no business-flow edges', () => {
    const edges: GraphEdge[] = [
      { id: 'e1', source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'default' },
    ]
    expect(collectCrossModuleConstraints('n1', edges, [])).toEqual([])
  })

  it('collects constraints from outgoing business-flow edges', () => {
    const nodes = [
      makeNode({ id: 'n1', type: 'module' }),
      makeNode({ id: 'n2', type: 'module' }),
    ]
    const edges: GraphEdge[] = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        graphId: 'g1',
        edgeType: 'business-flow',
        content: { condition: '退款申请通过', note: '需同步回滚库存' },
      },
    ]
    const result = collectCrossModuleConstraints('n1', edges, nodes)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('n2')
    expect(result[0]).toContain('需同步回滚库存')
    expect(result[0]).toContain('退款申请通过')
  })

  it('collects constraints from incoming business-flow edges', () => {
    const nodes = [
      makeNode({ id: 'n1', type: 'module' }),
      makeNode({ id: 'n2', type: 'module' }),
    ]
    const edges: GraphEdge[] = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        graphId: 'g1',
        edgeType: 'business-flow',
        content: { note: '库存联动' },
      },
    ]
    const result = collectCrossModuleConstraints('n2', edges, nodes)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('n1')
    expect(result[0]).toContain('库存联动')
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/renderer/canvas/__tests__/agent-context-builder.test.ts`
Expected: PASS

- [ ] **Step 4: 扩展 promptTemplates.ts 的 generatePromptTemplate**

更新函数签名以接收可选的 `allNodes` 和 `allEdges`，在 switch 结束后追加文件关联和跨模块约束。文件顶部新增导入：

```typescript
import type { GraphNode, GraphEdge } from '@shared/types'
import { collectFileAssociations, collectCrossModuleConstraints } from '../canvas/agent-context-builder'
```

更新函数签名（第 25 行）：

```typescript
export function generatePromptTemplate(
  slashCommand: string,
  node: GraphNode | undefined,
  allNodes?: GraphNode[],
  allEdges?: GraphEdge[],
): string | null {
```

在函数末尾 `return lines.join('\n')` 之前插入：

```typescript
  // Append file associations and cross-module constraints
  if (allNodes && allEdges) {
    const fileAssocs = collectFileAssociations(node.id, allNodes)
    if (fileAssocs.length > 0) {
      lines.push('### 关联文件')
      fileAssocs.forEach((a) => {
        const suffix = a.type === 'method' && a.methodName ? ` (方法: ${a.methodName})` : a.type === 'directory' ? ' (目录)' : ''
        lines.push(`- ${a.path}${suffix}`)
      })
      lines.push('')
    }

    const constraints = collectCrossModuleConstraints(node.id, allEdges, allNodes)
    if (constraints.length > 0) {
      lines.push('### 跨模块业务约束')
      constraints.forEach((c) => lines.push(`- ${c}`))
      lines.push('')
    }
  }
```

- [ ] **Step 5: 更新 AgentChatPanel 中对 generatePromptTemplate 的调用**

在 `src/renderer/components/agent/AgentChatPanel.tsx` 中，找到第 109 行的调用：

```typescript
const template = generatePromptTemplate(content.trim(), selectedNode)
```

改为传入 nodes 和 edges：

```typescript
const template = generatePromptTemplate(content.trim(), selectedNode, nodes, edges)
```

需要在文件顶部已有 `useGraphStore` 导入的基础上，在组件内获取 nodes 和 edges（约第 30-40 行区域）：

```typescript
const nodes = useGraphStore((s) => s.nodes)
const edges = useGraphStore((s) => s.edges)
```

- [ ] **Step 6: 运行测试**

Run: `npx vitest run src/renderer/canvas/__tests__/agent-context-builder.test.ts`
Expected: PASS

- [ ] **Step 7: 运行完整测试套件**

Run: `npm run test`
Expected: 全部 PASS

- [ ] **Step 8: 运行 lint**

Run: `npm run lint`
Expected: 0 warnings

- [ ] **Step 9: 提交**

```bash
git add src/renderer/canvas/agent-context-builder.ts src/renderer/canvas/__tests__/agent-context-builder.test.ts src/renderer/components/agent/promptTemplates.ts src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat: integrate file associations and cross-module constraints into Agent prompts"
```

---

### Task 13: 全局验证

- [ ] **Step 1: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 2: Lint 检查**

Run: `npm run lint`
Expected: 0 warnings

- [ ] **Step 3: 全部测试**

Run: `npm run test`
Expected: 全部 PASS

- [ ] **Step 4: 手动验证**

启动开发服务器 `npm run dev`，验证：
1. 加载图后自动出现 project 根节点（居中，不可拖拽）
2. 右键 project 节点可添加 module 子节点
3. 右键画布创建菜单中无 project 选项（已存在时）
4. 创建边时选择 business-flow 可输入条件和备注
5. 选中 business-flow 边时 EdgeEditor 显示业务逻辑编辑区
6. 选中节点时 NodeEditor 显示关联文件编辑区
7. business-flow 边显示为蓝色虚线

- [ ] **Step 5: 最终提交（如有修复）**

```bash
git add -A
git commit -m "fix: address verification issues from mind map enhancement"
```
