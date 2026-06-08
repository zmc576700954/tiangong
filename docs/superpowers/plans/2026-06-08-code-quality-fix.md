# 代码质量统一修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复技术栈不足、代码规范不足、代码质量不足、关键缺失业务流四类问题，使项目在类型安全、错误处理、业务闭环等方面达到生产级标准。

**Architecture:** 按层推进 — 先修共享类型守卫（最底层依赖），再修仓库层运行时校验，再修错误处理/适配器一致性，再修 store/业务逻辑，最后修规范/清理。每层变更独立可验证。

**Tech Stack:** TypeScript 5.7, Vitest, ESLint, React 19, Zustand 5

---

## Task 1: 添加运行时类型守卫函数

**Files:**
- Create: `src/shared/type-guards.ts`
- Modify: `src/shared/types.ts` (添加常量数组，供守卫复用)
- Test: `src/shared/__tests__/type-guards.test.ts`

当前问题：`NodeStatus`、`NodeType`、`GraphType`、`EdgeType`、`BugSeverity`、`BugStatus` 等联合类型从 DB 读出后用 `as` 强转，无运行时校验。需添加守卫函数。

- [ ] **Step 1: 在 types.ts 中添加常量数组**

在 `src/shared/types.ts` 末尾（`}` 之后，最后一行之前）添加可用于运行时校验的常量数组：

```ts
// ============================================
// 运行时类型校验常量（供 type-guards.ts 复用）
// ============================================

export const NODE_STATUS_VALUES = ['draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder'] as const
export const NODE_TYPE_VALUES = ['project', 'module', 'process', 'feature', 'bug'] as const
export const GRAPH_TYPE_VALUES = ['online', 'dev'] as const
export const EDGE_TYPE_VALUES = ['default', 'success', 'failure', 'condition', 'business-flow'] as const
export const BUG_SEVERITY_VALUES = ['low', 'medium', 'high', 'critical'] as const
export const BUG_STATUS_VALUES = ['open', 'fixed', 'verified'] as const
```

- [ ] **Step 2: 创建 type-guards.ts**

创建 `src/shared/type-guards.ts`：

```ts
/**
 * 运行时类型守卫
 * 用于校验从 DB / 外部输入读取的值是否符合联合类型约束
 */

import {
  NODE_STATUS_VALUES, NODE_TYPE_VALUES, GRAPH_TYPE_VALUES,
  EDGE_TYPE_VALUES, BUG_SEVERITY_VALUES, BUG_STATUS_VALUES,
} from './types'
import type { NodeStatus, NodeType, GraphType, EdgeType, BugSeverity, BugStatus } from './types'

function makeGuard<T extends string>(values: readonly T[]) {
  const set = new Set<string>(values)
  return (value: string): value is T => set.has(value)
}

export const isNodeStatus = makeGuard<NodeStatus>(NODE_STATUS_VALUES)
export const isNodeType = makeGuard<NodeType>(NODE_TYPE_VALUES)
export const isGraphType = makeGuard<GraphType>(GRAPH_TYPE_VALUES)
export const isEdgeType = makeGuard<EdgeType>(EDGE_TYPE_VALUES)
export const isBugSeverity = makeGuard<BugSeverity>(BUG_SEVERITY_VALUES)
export const isBugStatus = makeGuard<BugStatus>(BUG_STATUS_VALUES)

/** 校验并返回合法值，否则抛出 TypeError */
export function assertNodeStatus(value: string, field = 'status'): NodeStatus {
  if (!isNodeStatus(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${NODE_STATUS_VALUES.join(', ')}`)
  return value
}

export function assertNodeType(value: string, field = 'type'): NodeType {
  if (!isNodeType(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${NODE_TYPE_VALUES.join(', ')}`)
  return value
}

export function assertGraphType(value: string, field = 'type'): GraphType {
  if (!isGraphType(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${GRAPH_TYPE_VALUES.join(', ')}`)
  return value
}

export function assertEdgeType(value: string, field = 'edgeType'): EdgeType {
  if (!isEdgeType(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${EDGE_TYPE_VALUES.join(', ')}`)
  return value
}

export function assertBugSeverity(value: string, field = 'severity'): BugSeverity {
  if (!isBugSeverity(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${BUG_SEVERITY_VALUES.join(', ')}`)
  return value
}

export function assertBugStatus(value: string, field = 'status'): BugStatus {
  if (!isBugStatus(value)) throw new TypeError(`Invalid ${field}: "${value}", expected one of: ${BUG_STATUS_VALUES.join(', ')}`)
  return value
}
```

- [ ] **Step 3: 创建测试文件**

创建 `src/shared/__tests__/type-guards.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import {
  isNodeStatus, isNodeType, isGraphType, isEdgeType, isBugSeverity, isBugStatus,
  assertNodeStatus, assertNodeType, assertGraphType, assertEdgeType, assertBugSeverity, assertBugStatus,
} from '../type-guards'

describe('type guards', () => {
  it('isNodeStatus accepts valid values', () => {
    expect(isNodeStatus('draft')).toBe(true)
    expect(isNodeStatus('published')).toBe(true)
    expect(isNodeStatus('invalid')).toBe(false)
    expect(isNodeStatus('')).toBe(false)
  })

  it('isNodeType accepts valid values', () => {
    expect(isNodeType('module')).toBe(true)
    expect(isNodeType('unknown')).toBe(false)
  })

  it('isGraphType accepts valid values', () => {
    expect(isGraphType('online')).toBe(true)
    expect(isGraphType('dev')).toBe(true)
    expect(isGraphType('staging')).toBe(false)
  })

  it('isEdgeType accepts valid values', () => {
    expect(isEdgeType('default')).toBe(true)
    expect(isEdgeType('business-flow')).toBe(true)
    expect(isEdgeType('random')).toBe(false)
  })

  it('isBugSeverity accepts valid values', () => {
    expect(isBugSeverity('critical')).toBe(true)
    expect(isBugSeverity('urgent')).toBe(false)
  })

  it('isBugStatus accepts valid values', () => {
    expect(isBugStatus('open')).toBe(true)
    expect(isBugStatus('closed')).toBe(false)
  })
})

describe('assert functions', () => {
  it('assertNodeStatus returns valid value', () => {
    expect(assertNodeStatus('draft')).toBe('draft')
  })

  it('assertNodeStatus throws on invalid value', () => {
    expect(() => assertNodeStatus('invalid')).toThrow(TypeError)
    expect(() => assertNodeStatus('invalid')).toThrow('Invalid status')
  })

  it('assertGraphType returns valid value', () => {
    expect(assertGraphType('online')).toBe('online')
  })

  it('assertGraphType throws on invalid value', () => {
    expect(() => assertGraphType('staging')).toThrow(TypeError)
  })

  it('assertBugSeverity includes field name in error', () => {
    expect(() => assertBugSeverity('urgent', 'severity')).toThrow('Invalid severity')
  })

  it('assertBugStatus throws on invalid value', () => {
    expect(() => assertBugStatus('closed')).toThrow(TypeError)
  })
})
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/shared/__tests__/type-guards.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/type-guards.ts src/shared/__tests__/type-guards.test.ts src/shared/types.ts
git commit -m "feat: add runtime type guards for discriminated union types"
```

---

## Task 2: 仓库层替换 `as` 强转为运行时校验

**Files:**
- Modify: `src/main/repositories/graph-repository.ts`
- Modify: `src/main/repositories/node-repository.ts`
- Modify: `src/main/repositories/edge-repository.ts`
- Modify: `src/main/repositories/bug-repository.ts`

当前问题：18 处 `as` 强转绕过编译检查，畸形 DB 值会穿透到业务层。用 Task 1 的 `assert*` 函数替换。

- [ ] **Step 1: 修改 graph-repository.ts**

在 `src/main/repositories/graph-repository.ts` 顶部添加导入：

```ts
import { assertGraphType, assertNodeType, assertNodeStatus, assertEdgeType, assertBugSeverity, assertBugStatus } from '@shared/type-guards'
```

替换所有 `as` 强转（6 处）：

| 行 | 原代码 | 新代码 |
|----|--------|--------|
| 50 | `rowStr(row, 'type') as GraphType` | `assertGraphType(rowStr(row, 'type'))` |
| 81 | `rowStr(graph, 'type') as GraphType` | `assertGraphType(rowStr(graph, 'type'))` |
| 88 | `rowStr(row, 'type') as GraphNode['type']` | `assertNodeType(rowStr(row, 'type'))` |
| 89 | `rowStr(row, 'status') as GraphNode['status']` | `assertNodeStatus(rowStr(row, 'status'))` |
| 94 | `rowStr(row, 'graph_type') as GraphNode['graphType']` | `assertGraphType(rowStr(row, 'graph_type'), 'graphType')` |
| 102 | `rowOptStr(row, 'owner_role') as GraphNode['ownerRole']` | 需特殊处理，见下 |

对于 `ownerRole`（可选字段），在守卫函数不支持可选值的情况下，保持 `as` 断言（因为 `ownerRole` 取值集很小，且是可选字段，风险低）。同理保留 `edgeType` 的可选断言（行 113）。

对行 113：`rowOptStr(row, 'edge_type') as GraphEdge['edgeType']` → 需要处理可选值：

```ts
edgeType: rowOptStr(row, 'edge_type') !== undefined ? assertEdgeType(rowOptStr(row, 'edge_type')!) : undefined,
```

但这样调用了两次 `rowOptStr`。更简洁的方案是使用局部变量：

```ts
const rawEdgeType = rowOptStr(row, 'edge_type')
// ...
edgeType: rawEdgeType ? assertEdgeType(rawEdgeType) : undefined,
```

同理对行 123-124 (bug severity/status)：

```ts
severity: assertBugSeverity(rowStr(row, 'severity')),
status: assertBugStatus(rowStr(row, 'status')),
```

对行 149 的 `row.project_path as string | null`，这是 `unknown → string | null` 的简单类型收窄，不是联合类型校验，保持不变。

- [ ] **Step 2: 修改 node-repository.ts**

在 `src/main/repositories/node-repository.ts` 顶部添加导入：

```ts
import { assertNodeType, assertNodeStatus, assertGraphType } from '@shared/type-guards'
```

替换行 85-102 中的 `as` 强转。当前代码使用 `row.field as T`（无 helper 函数），需要先确保值是 string 再断言：

```ts
return {
  id: row.id as string,
  type: assertNodeType(row.type as string),
  status: assertNodeStatus(row.status as string),
  title: row.title as string,
  description: row.description as string | undefined,
  acceptanceCriteria: safeJsonParse<GraphNode['acceptanceCriteria']>(row.acceptance_criteria as string | null, 'acceptance_criteria'),
  graphId: row.graph_id as string,
  graphType: assertGraphType(row.graph_type as string, 'graphType'),
  parentId: row.parent_id as string | undefined,
  rules: safeJsonParse<GraphNode['rules']>(row.rules as string | null, 'rules'),
  metadata: safeJsonParse<GraphNode['metadata']>(row.metadata as string | null, 'metadata'),
  contextRefs: safeJsonParse<GraphNode['contextRefs']>(row.context_refs as string | null, 'context_refs'),
  ownerRole: row.owner_role as GraphNode['ownerRole'],
  position: { x: row.position_x as number, y: row.position_y as number },
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
} as GraphNode
```

注意：`row.type as string` 仍然存在（将 `unknown` 收窄为 `string`），但随后的 `assertNodeType` 提供了运行时校验。这是分层校验：先 `unknown → string`，再 `string → NodeType`。

- [ ] **Step 3: 修改 edge-repository.ts**

在 `src/main/repositories/edge-repository.ts` 顶部添加导入：

```ts
import { assertEdgeType } from '@shared/type-guards'
```

替换行 27 的 `row.edge_type as GraphEdge['edgeType']`：

```ts
edgeType: row.edge_type ? assertEdgeType(row.edge_type as string) : undefined,
```

- [ ] **Step 4: 修改 bug-repository.ts**

在 `src/main/repositories/bug-repository.ts` 顶部添加导入：

```ts
import { assertBugSeverity, assertBugStatus } from '@shared/type-guards'
```

替换 `update` 方法中（行 55-56）和 `listByNode` 方法中（行 78-79）的 `as` 强转：

`update` 方法：
```ts
severity: assertBugSeverity(row.severity as string),
status: assertBugStatus(row.status as string),
```

`listByNode` 方法：
```ts
severity: assertBugSeverity(row.severity as string),
status: assertBugStatus(row.status as string),
```

- [ ] **Step 5: 运行测试确认无回归**

Run: `npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/repositories/graph-repository.ts src/main/repositories/node-repository.ts src/main/repositories/edge-repository.ts src/main/repositories/bug-repository.ts
git commit -m "fix: replace unsafe 'as' casts with runtime type assertions in repositories"
```

---

## Task 3: 修复静默 catch 块

**Files:**
- Modify: `src/main/scope-guard.ts`
- Modify: `src/main/database.ts`

当前问题：安全关键路径的错误被静默吞没，可能导致数据丢失或安全暴露。

- [ ] **Step 1: 修复 scope-guard.ts 中 cleanupSandbox 的备份删除静默 catch**

将 `src/main/scope-guard.ts` 行 413-417：

```ts
    try {
      await fs.rm(sandbox.backupDir, { recursive: true, force: true })
    } catch {
      // 忽略删除错误
    }
```

替换为：

```ts
    try {
      await fs.rm(sandbox.backupDir, { recursive: true, force: true })
    } catch (err) {
      this.logger.warn(`Failed to delete backup directory ${sandbox.backupDir}:`, err)
    }
```

注意：`scope-guard.ts` 已有 `this.logger` 实例（在构造函数中通过 `createLogger('ScopeGuard')` 创建），直接使用即可。

- [ ] **Step 2: 修复 database.ts 中 closeDatabase 的 WAL checkpoint 静默 catch**

将 `src/main/database.ts` 行 72-74：

```ts
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {})
    await client.execute('PRAGMA optimize').catch(() => {})
```

替换为：

```ts
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch((err) => {
      logger.warn('Final WAL checkpoint failed during close:', err)
    })
    await client.execute('PRAGMA optimize').catch((err) => {
      logger.warn('PRAGMA optimize failed during close:', err)
    })
```

注意：文件顶部已有 `const logger = createLogger('Database')`。

- [ ] **Step 3: 修复 database.ts 中 migrate 的 ROLLBACK 静默 catch**

将行 437：

```ts
.catch(() => {})
```

替换为：

```ts
.catch((err) => { logger.warn('ROLLBACK TO migrate_sp failed:', err) })
```

- [ ] **Step 4: 运行测试确认无回归**

Run: `npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/scope-guard.ts src/main/database.ts
git commit -m "fix: replace silent catch blocks with logged warnings in scope-guard and database"
```

---

## Task 4: 适配器一致性修复 — structuredClone + 日志统一

**Files:**
- Modify: `src/main/adapters/opencode.ts`
- Modify: `src/main/adapters/cursor.ts`
- Modify: `src/main/adapters/claude-code.ts`
- Modify: `src/main/adapters/codex.ts`

当前问题：(1) OpenCode/Cursor 适配器未使用 `structuredClone(config)`，与 ClaudeCode/Codex 不一致，存在对象变异风险；(2) ClaudeCode/Codex 使用 `console.warn` 而非 `createLogger`。

- [ ] **Step 1: 修复 opencode.ts — 添加 structuredClone**

在 `src/main/adapters/opencode.ts` 行 34 将：

```ts
      config,
```

替换为：

```ts
      config: structuredClone(config),
```

- [ ] **Step 2: 修复 cursor.ts — 添加 structuredClone**

在 `src/main/adapters/cursor.ts` 行 34 将：

```ts
      config,
```

替换为：

```ts
      config: structuredClone(config),
```

- [ ] **Step 3: 修复 claude-code.ts — 使用 createLogger**

在 `src/main/adapters/claude-code.ts` 中：

1. 添加导入（在文件顶部的 import 区域）：
```ts
import { createLogger } from '../shared/logger'
```

2. 在类定义后添加 logger 实例（在 `readonly version = '1.0.0'` 之后）：
```ts
  private logger = createLogger('ClaudeCodeAdapter')
```

3. 将行 61 的 `console.warn('[ClaudeCodeAdapter] @anthropic-ai/claude-agent-sdk not installed')` 替换为：
```ts
      this.logger.warn('@anthropic-ai/claude-agent-sdk not installed')
```

- [ ] **Step 4: 修复 codex.ts — 使用 createLogger**

在 `src/main/adapters/codex.ts` 中：

1. 添加导入：
```ts
import { createLogger } from '../shared/logger'
```

2. 在类定义后添加 logger 实例（在 `readonly version = '1.0.0'` 之后）：
```ts
  private logger = createLogger('CodexAdapter')
```

3. 将行 33 的 `console.warn('[CodexAdapter] @openai/codex-sdk not installed')` 替换为：
```ts
      this.logger.warn('@openai/codex-sdk not installed')
```

- [ ] **Step 5: 运行测试确认无回归**

Run: `npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/adapters/opencode.ts src/main/adapters/cursor.ts src/main/adapters/claude-code.ts src/main/adapters/codex.ts
git commit -m "fix: add structuredClone in opencode/cursor adapters and unify logger usage"
```

---

## Task 5: Store 乐观更新泛型抽取 + 消除 `as` 强转

**Files:**
- Modify: `src/renderer/store/graphStore.ts`

当前问题：node/edge/bug 三套乐观更新模式重复约 120 行代码，且乐观对象通过 `as` 强转跳过类型检查。

- [ ] **Step 1: 添加 optimisticUpdate 泛型辅助函数**

在 `src/renderer/store/graphStore.ts` 文件中，`useGraphStore` 定义之前（约行 37 之前），添加：

```ts
/**
 * 乐观更新辅助函数
 * 统一处理 "乐观设置 → IPC 调用 → 确认/回滚" 模式
 */
async function optimisticUpdate<T extends { id: string }>(
  items: T[],
  optimisticItem: T,
  ipcCall: () => Promise<T>,
  onSettle: (updated: T[]) => void,
): Promise<T> {
  const optimisticId = optimisticItem.id
  onSettle([...items, optimisticItem])

  try {
    const serverItem = await ipcCall()
    onSettle(items.map((item) => (item.id === optimisticId ? serverItem : item)))
    return serverItem
  } catch (err) {
    onSettle(items.filter((item) => item.id !== optimisticId))
    throw err
  }
}

async function optimisticDelete<T extends { id: string }>(
  items: T[],
  id: string,
  ipcCall: () => Promise<void>,
  onSettle: (updated: T[]) => void,
): Promise<void> {
  onSettle(items.filter((item) => item.id !== id))

  try {
    await ipcCall()
  } catch (err) {
    // 回滚：恢复原始列表
    onSettle(items)
    throw err
  }
}
```

- [ ] **Step 2: 重构 createNode / createEdge / createBug 使用 optimisticUpdate**

将 `createNode`（行 89-107）替换为：

```ts
  createNode: async (data) => {
    const optimisticId = generateId('node')
    const now = new Date().toISOString()
    // 构造完整的 GraphNode 对象（不再需要 as 强转）
    const optimisticNode: GraphNode = { ...data, id: optimisticId, createdAt: now, updatedAt: now }

    return optimisticUpdate(
      get().nodes,
      optimisticNode,
      () => window.electronAPI['node:create'](data),
      (nodes) => set({ nodes }),
    )
  },
```

将 `createEdge`（行 209-227）替换为：

```ts
  createEdge: async (data) => {
    const optimisticId = generateId('edge')
    const optimisticEdge: GraphEdge = { ...data, id: optimisticId }

    return optimisticUpdate(
      get().edges,
      optimisticEdge,
      () => window.electronAPI['edge:create'](data),
      (edges) => set({ edges }),
    )
  },
```

将 `createBug`（行 272-290）替换为：

```ts
  createBug: async (data) => {
    const optimisticId = generateId('bug')
    const now = new Date().toISOString()
    const optimisticBug: BugNode = { ...data, id: optimisticId, createdAt: now, updatedAt: now }

    return optimisticUpdate(
      get().bugs,
      optimisticBug,
      () => window.electronAPI['bug:create'](data),
      (bugs) => set({ bugs }),
    )
  },
```

关键变化：`as GraphNode` → `: GraphNode`，从类型断言变为类型注解。TypeScript 会检查 spread 后的对象是否满足 `GraphNode` 的所有字段。如果有缺失字段，编译报错而非运行时崩溃。

- [ ] **Step 3: 重构 createNodeBatch 使用同样模式**

将 `createNodeBatch`（行 110-138）替换为：

```ts
  createNodeBatch: async (nodesData) => {
    const optimisticIds = nodesData.map(() => generateId('node'))
    const now = new Date().toISOString()
    const optimisticNodes: GraphNode[] = nodesData.map((data, i) => ({
      ...data,
      id: optimisticIds[i],
      createdAt: now,
      updatedAt: now,
    }))

    set((state) => ({ nodes: [...state.nodes, ...optimisticNodes] }))

    try {
      const created = await Promise.all(
        nodesData.map((data) => window.electronAPI['node:create'](data)),
      )
      set((state) => ({
        nodes: state.nodes.map((n) => {
          const idx = optimisticIds.indexOf(n.id)
          return idx >= 0 ? created[idx] : n
        }),
      }))
      return created
    } catch (err) {
      set((state) => ({
        nodes: state.nodes.filter((n) => !optimisticIds.includes(n.id)),
      }))
      throw err
    }
  },
```

同样 `as GraphNode[]` → `: GraphNode[]`。

- [ ] **Step 4: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: Zero errors（类型注解会捕获任何缺失字段）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/graphStore.ts
git commit -m "refactor: extract optimistic update helpers and replace 'as' casts with type annotations in graphStore"
```

---

## Task 6: 节点状态转换校验

**Files:**
- Create: `src/shared/state-machine.ts`
- Test: `src/shared/__tests__/state-machine.test.ts`
- Modify: `src/main/ipc/graph.ts` (在 node:update 和 bug:update handler 中添加校验)

当前问题：节点和 Bug 的状态转换无任何校验，任何状态可以跳转到任意其他状态。

- [ ] **Step 1: 创建状态机模块**

创建 `src/shared/state-machine.ts`：

```ts
/**
 * 状态转换校验
 * 定义节点和 Bug 的合法状态转换路径
 */

import type { NodeStatus, BugStatus } from './types'

// 节点状态合法转换映射
const NODE_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  draft: ['confirmed', 'placeholder'],
  confirmed: ['developing', 'placeholder'],
  developing: ['testing', 'confirmed'],
  testing: ['review', 'developing'],
  review: ['published', 'testing'],
  published: ['review'],
  placeholder: ['developing', 'confirmed'],
}

// Bug 状态合法转换映射
const BUG_TRANSITIONS: Record<BugStatus, BugStatus[]> = {
  open: ['fixed'],
  fixed: ['verified', 'open'],
  verified: ['open'],
}

export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return NODE_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionBug(from: BugStatus, to: BugStatus): boolean {
  return BUG_TRANSITIONS[from]?.includes(to) ?? false
}

export function validateNodeTransition(from: NodeStatus, to: NodeStatus): void {
  if (!canTransitionNode(from, to)) {
    throw new Error(`Invalid node status transition: ${from} → ${to}. Allowed: ${NODE_TRANSITIONS[from]?.join(', ') ?? 'none'}`)
  }
}

export function validateBugTransition(from: BugStatus, to: BugStatus): void {
  if (!canTransitionBug(from, to)) {
    throw new Error(`Invalid bug status transition: ${from} → ${to}. Allowed: ${BUG_TRANSITIONS[from]?.join(', ') ?? 'none'}`)
  }
}
```

- [ ] **Step 2: 创建状态机测试**

创建 `src/shared/__tests__/state-machine.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { canTransitionNode, canTransitionBug, validateNodeTransition, validateBugTransition } from '../state-machine'

describe('Node state machine', () => {
  it('allows draft → confirmed', () => {
    expect(canTransitionNode('draft', 'confirmed')).toBe(true)
  })

  it('allows confirmed → developing', () => {
    expect(canTransitionNode('confirmed', 'developing')).toBe(true)
  })

  it('allows placeholder → developing', () => {
    expect(canTransitionNode('placeholder', 'developing')).toBe(true)
  })

  it('allows developing → testing', () => {
    expect(canTransitionNode('developing', 'testing')).toBe(true)
  })

  it('allows testing → review', () => {
    expect(canTransitionNode('testing', 'review')).toBe(true)
  })

  it('allows review → published', () => {
    expect(canTransitionNode('review', 'published')).toBe(true)
  })

  it('allows reverse transitions for corrections', () => {
    expect(canTransitionNode('published', 'review')).toBe(true)
    expect(canTransitionNode('review', 'testing')).toBe(true)
    expect(canTransitionNode('testing', 'developing')).toBe(true)
  })

  it('disallows draft → published (skip)', () => {
    expect(canTransitionNode('draft', 'published')).toBe(false)
  })

  it('disallows draft → testing (skip)', () => {
    expect(canTransitionNode('draft', 'testing')).toBe(false)
  })

  it('validateNodeTransition throws on invalid transition', () => {
    expect(() => validateNodeTransition('draft', 'published')).toThrow('Invalid node status transition')
  })

  it('validateNodeTransition does not throw on valid transition', () => {
    expect(() => validateNodeTransition('draft', 'confirmed')).not.toThrow()
  })
})

describe('Bug state machine', () => {
  it('allows open → fixed', () => {
    expect(canTransitionBug('open', 'fixed')).toBe(true)
  })

  it('allows fixed → verified', () => {
    expect(canTransitionBug('fixed', 'verified')).toBe(true)
  })

  it('allows fixed → open (regression)', () => {
    expect(canTransitionBug('fixed', 'open')).toBe(true)
  })

  it('allows verified → open (regression)', () => {
    expect(canTransitionBug('verified', 'open')).toBe(true)
  })

  it('disallows open → verified (skip)', () => {
    expect(canTransitionBug('open', 'verified')).toBe(false)
  })

  it('validateBugTransition throws on invalid transition', () => {
    expect(() => validateBugTransition('open', 'verified')).toThrow('Invalid bug status transition')
  })
})
```

- [ ] **Step 3: 在 IPC handler 中集成状态校验**

在 `src/main/ipc/graph.ts` 中添加导入：

```ts
import { validateNodeTransition, validateBugTransition } from '@shared/state-machine'
```

在 `node:update` handler（约行 48）中添加状态校验：

将原来的：
```ts
  registerTypedHandle('node:update', async (_event, id: string, data: Partial<GraphNode>) => {
    return nodeRepo.update(id, data)
  })
```

替换为：
```ts
  registerTypedHandle('node:update', async (_event, id: string, data: Partial<GraphNode>) => {
    if (data.status !== undefined) {
      const current = await nodeRepo.read(id)
      if (current && current.status !== data.status) {
        validateNodeTransition(current.status, data.status)
      }
    }
    return nodeRepo.update(id, data)
  })
```

注意：`NodeRepository` 当前没有 `read` 方法。需要先添加。在 `src/main/repositories/node-repository.ts` 中添加：

```ts
  async read(id: string): Promise<GraphNode | null> {
    const result = await this.db.execute({ sql: 'SELECT status FROM nodes WHERE id = ?', args: [id] })
    const row = result.rows[0]
    if (!row) return null
    return { status: row.status as GraphNode['status'] } as GraphNode
  }
```

但这样返回不完整的 `GraphNode`。更好的方案是只查询 status：

```ts
  async getStatus(id: string): Promise<NodeStatus | null> {
    const result = await this.db.execute({ sql: 'SELECT status FROM nodes WHERE id = ?', args: [id] })
    const row = result.rows[0]
    if (!row) return null
    return assertNodeStatus(row.status as string)
  }
```

在 node-repository.ts 顶部添加导入：
```ts
import { assertNodeStatus } from '@shared/type-guards'
```

然后在 IPC handler 中：
```ts
  registerTypedHandle('node:update', async (_event, id: string, data: Partial<GraphNode>) => {
    if (data.status !== undefined) {
      const currentStatus = await nodeRepo.getStatus(id)
      if (currentStatus && currentStatus !== data.status) {
        validateNodeTransition(currentStatus, currentStatus => data.status!)
      }
    }
    return nodeRepo.update(id, data)
  })
```

修正上面的语法错误，正确的 IPC handler：

```ts
  registerTypedHandle('node:update', async (_event, id: string, data: Partial<GraphNode>) => {
    if (data.status !== undefined) {
      const currentStatus = await nodeRepo.getStatus(id)
      if (currentStatus !== null && currentStatus !== data.status) {
        validateNodeTransition(currentStatus, data.status)
      }
    }
    return nodeRepo.update(id, data)
  })
```

对 `bug:update`（约行 81）做同样处理。先在 `BugRepository` 添加 `getStatus`：

```ts
  async getStatus(id: string): Promise<BugStatus | null> {
    const result = await this.db.execute({ sql: 'SELECT status FROM bug_nodes WHERE id = ?', args: [id] })
    const row = result.rows[0]
    if (!row) return null
    return assertBugStatus(row.status as string)
  }
```

在 bug-repository.ts 顶部添加导入（如果还没有的话）：
```ts
import { assertBugStatus } from '@shared/type-guards'
```

IPC handler：
```ts
  registerTypedHandle('bug:update', async (_event, id: string, data: Partial<BugNode>) => {
    if (data.status !== undefined) {
      const currentStatus = await bugRepo.getStatus(id)
      if (currentStatus !== null && currentStatus !== data.status) {
        validateBugTransition(currentStatus, data.status)
      }
    }
    return bugRepo.update(id, data)
  })
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/state-machine.ts src/shared/__tests__/state-machine.test.ts src/main/ipc/graph.ts src/main/repositories/node-repository.ts src/main/repositories/bug-repository.ts
git commit -m "feat: add node/bug status transition validation with state machine"
```

---

## Task 7: 图派生流程（online → dev）

**Files:**
- Modify: `src/main/services/graph-service.ts`
- Modify: `src/main/repositories/graph-repository.ts`
- Modify: `src/main/ipc/graph.ts`
- Modify: `src/shared/types.ts` (IpcApi 添加新通道)
- Modify: `src/preload/index.ts` (暴露新通道)
- Modify: `src/renderer/store/graphStore.ts` (实现 sourceGraphId 逻辑)
- Modify: `src/renderer/components/GraphTabs.tsx` (UI 添加派生选项)

当前问题：`sourceGraphId` 参数在 store 中存在但未实现，无法从已有 online 图派生 dev 图。

- [ ] **Step 1: 在 GraphRepository 中添加 cloneGraph 方法**

在 `src/main/repositories/graph-repository.ts` 的 `GraphRepository` 类中添加：

```ts
  /** 克隆在线图的所有节点和边到开发图 */
  async cloneGraphNodes(sourceGraphId: string, targetGraphId: string, targetGraphType: GraphType): Promise<void> {
    // 复制所有节点
    const nodes = await this.db.execute({
      sql: 'SELECT * FROM nodes WHERE graph_id = ?',
      args: [sourceGraphId],
    })

    for (const row of nodes.rows) {
      const originalId = rowStr(row, 'id')
      const newId = generateId('node')
      const status = rowStr(row, 'type') === 'feature' && targetGraphType === 'dev'
        ? 'placeholder'
        : rowStr(row, 'status')

      await this.db.execute({
        sql: `INSERT INTO nodes (
          id, type, status, title, description, acceptance_criteria,
          graph_id, graph_type, parent_id, rules, metadata, owner_role,
          position_x, position_y, context_refs, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId, rowStr(row, 'type'), status, rowStr(row, 'title'),
          rowOptStr(row, 'description'),
          row['acceptance_criteria'],
          targetGraphId, targetGraphType,
          row['parent_id'], // 保留原始 parent_id，后续映射
          row['rules'], row['metadata'], row['owner_role'],
          rowNum(row, 'position_x'), rowNum(row, 'position_y') + 20,
          row['context_refs'],
          rowStr(row, 'created_at'), new Date().toISOString(),
        ],
      })
    }

    // 复制所有边
    const edges = await this.db.execute({
      sql: 'SELECT * FROM edges WHERE graph_id = ?',
      args: [sourceGraphId],
    })

    for (const row of edges.rows) {
      const newId = generateId('edge')
      await this.db.execute({
        sql: `INSERT INTO edges (
          id, source, target, label, edge_type, content, graph_id, description, data_flow, strength
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId, rowStr(row, 'source'), rowStr(row, 'target'),
          rowOptStr(row, 'label'), row['edge_type'], row['content'],
          targetGraphId, row['description'], row['data_flow'], row['strength'],
        ],
      })
    }
  }
```

注意：这个简化版保留了原始 source/target node ID。由于节点 ID 在两张图中可能不同，更完整的方案需要 ID 映射表。但考虑到派生场景中节点会保留原始结构关系，且 dev 图的节点 ID 是新生成的，实际实现中需要将 source graph 的节点 ID 映射到新 ID。这里采用简化方案：直接复制节点但保持原始 parent_id 和 edge source/target 的引用关系不变，因为节点在两张图中保持相同的结构。

实际上，更正确的做法是生成新节点 ID 并建立映射。更新实现：

在 `cloneGraphNodes` 中，使用 tempIdMap 进行 ID 映射：

```ts
  async cloneGraphNodes(sourceGraphId: string, targetGraphId: string, targetGraphType: GraphType): Promise<void> {
    const nodes = await this.db.execute({
      sql: 'SELECT * FROM nodes WHERE graph_id = ?',
      args: [sourceGraphId],
    })

    // 原始 ID → 新 ID 映射
    const idMap = new Map<string, string>()

    // Pass 1: 插入节点（parent_id 暂时保留原值）
    for (const row of nodes.rows) {
      const originalId = rowStr(row, 'id')
      const newId = generateId('node')
      idMap.set(originalId, newId)

      const status = rowStr(row, 'type') === 'feature' && targetGraphType === 'dev'
        ? 'placeholder'
        : rowStr(row, 'status')

      await this.db.execute({
        sql: `INSERT INTO nodes (
          id, type, status, title, description, acceptance_criteria,
          graph_id, graph_type, parent_id, rules, metadata, owner_role,
          position_x, position_y, context_refs, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId, assertNodeType(rowStr(row, 'type')), assertNodeStatus(status), rowStr(row, 'title'),
          rowOptStr(row, 'description'),
          row['acceptance_criteria'],
          targetGraphId, assertGraphType(targetGraphType),
          row['parent_id'],
          row['rules'], row['metadata'], row['owner_role'],
          rowNum(row, 'position_x'), rowNum(row, 'position_y') + 20,
          row['context_refs'],
          rowStr(row, 'created_at'), new Date().toISOString(),
        ],
      })
    }

    // Pass 2: 更新 parent_id 映射
    for (const [oldId, newId] of idMap) {
      const row = nodes.rows.find(r => rowStr(r, 'id') === oldId)
      if (!row) continue
      const oldParentId = rowOptStr(row, 'parent_id')
      if (oldParentId && idMap.has(oldParentId)) {
        await this.db.execute({
          sql: 'UPDATE nodes SET parent_id = ? WHERE id = ?',
          args: [idMap.get(oldParentId)!, newId],
        })
      }
    }

    // Pass 3: 复制边（使用 ID 映射）
    const edges = await this.db.execute({
      sql: 'SELECT * FROM edges WHERE graph_id = ?',
      args: [sourceGraphId],
    })

    for (const row of edges.rows) {
      const newSourceId = idMap.get(rowStr(row, 'source'))
      const newTargetId = idMap.get(rowStr(row, 'target'))
      if (!newSourceId || !newTargetId) continue

      const newId = generateId('edge')
      await this.db.execute({
        sql: `INSERT INTO edges (
          id, source, target, label, edge_type, content, graph_id, description, data_flow, strength
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId, newSourceId, newTargetId,
          rowOptStr(row, 'label'), row['edge_type'], row['content'],
          targetGraphId, row['description'], row['data_flow'], row['strength'],
        ],
      })
    }
  }
```

- [ ] **Step 2: 在 GraphService 中添加 deriveGraph 方法**

在 `src/main/services/graph-service.ts` 的 `GraphService` 类中添加：

```ts
  /** 从已有在线图派生开发图 */
  async deriveGraph(sourceGraphId: string, name?: string): Promise<Graph> {
    const sourceGraph = await this.graphRepo.get(sourceGraphId)
    if (!sourceGraph) {
      throw new Error(`Source graph not found: ${sourceGraphId}`)
    }
    if (sourceGraph.graph.type !== 'online') {
      throw new Error('Can only derive dev graph from an online graph')
    }

    const devGraph = await this.graphRepo.create({
      name: name ?? `${sourceGraph.graph.name} - 开发场景`,
      type: 'dev',
      projectPath: sourceGraph.graph.projectPath,
    })

    await this.graphRepo.cloneGraphNodes(sourceGraphId, devGraph.id, 'dev')

    return devGraph
  }
```

- [ ] **Step 3: 添加 IPC 通道**

在 `src/shared/types.ts` 的 `IpcApi` 接口中，`graph:delete` 行后添加：

```ts
  'graph:derive': (sourceGraphId: string, name?: string) => Promise<Graph>
```

- [ ] **Step 4: 注册 IPC handler**

在 `src/main/ipc/graph.ts` 中添加：

```ts
  registerTypedHandle('graph:derive', async (_event, sourceGraphId: string, name?: string) => {
    return graphService.deriveGraph(sourceGraphId, name)
  })
```

- [ ] **Step 5: 在 preload 中暴露通道**

在 `src/preload/index.ts` 的 `exposedChannels` 数组中，`graph:delete` 行后添加：

```ts
  'graph:derive',
```

- [ ] **Step 6: 在 store 中实现 createGraph 的 sourceGraphId 参数**

修改 `src/renderer/store/graphStore.ts` 中 `createGraph` 的实现（行 65-68）：

```ts
  createGraph: async (name, type, sourceGraphId) => {
    if (sourceGraphId) {
      const graph = await window.electronAPI['graph:derive'](sourceGraphId, name)
      set((state) => ({ graphs: [graph, ...state.graphs] }))
      return graph
    }
    const graph = await window.electronAPI['graph:create']({ name, type })
    set((state) => ({ graphs: [graph, ...state.graphs] }))
    return graph
  },
```

- [ ] **Step 7: 在 GraphTabs UI 中添加派生选项**

在 `src/renderer/components/GraphTabs.tsx` 中，找到创建图的对话框/按钮区域。在创建新图的流程中，当选择 `dev` 类型时，显示一个可选的"从在线图派生"下拉框。

在 `handleCreate` 函数中（约行 18-23），修改为：

```ts
  const handleCreate = async () => {
    if (!newGraphName.trim()) return
    const sourceId = newGraphType === 'dev' && deriveFromGraphId ? deriveFromGraphId : undefined
    await createGraph(newGraphName.trim(), newGraphType, sourceId)
    setNewGraphName('')
    setDeriveFromGraphId(null)
    setShowCreate(false)
  }
```

添加状态：

```ts
  const [deriveFromGraphId, setDeriveFromGraphId] = useState<string | null>(null)
```

在创建对话框中，当 `newGraphType === 'dev'` 时渲染在线图选择下拉框：

```tsx
{newGraphType === 'dev' && (
  <select
    value={deriveFromGraphId ?? ''}
    onChange={(e) => setDeriveFromGraphId(e.target.value || null)}
    className="..."
  >
    <option value="">空白图</option>
    {graphs.filter(g => g.type === 'online').map(g => (
      <option key={g.id} value={g.id}>{g.name}</option>
    ))}
  </select>
)}
```

- [ ] **Step 8: 运行类型检查和测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: Zero type errors, all tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/shared/types.ts src/main/repositories/graph-repository.ts src/main/services/graph-service.ts src/main/ipc/graph.ts src/preload/index.ts src/renderer/store/graphStore.ts src/renderer/components/GraphTabs.tsx
git commit -m "feat: implement graph derive flow (online → dev)"
```

---

## Task 8: Preload 注释修复 + ESLint 配置优化

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `eslint.config.mjs`

当前问题：(1) Preload 注释声称不暴露文件写入操作，但实际暴露了 `fs:delete`/`fs:copy` 等变异操作；(2) ESLint `no-explicit-any: off` 放任 `any` 蔓延。

- [ ] **Step 1: 修复 preload 注释**

将 `src/preload/index.ts` 行 6-8 的注释：

```ts
 * - 文件写入操作通过 Agent 适配器代理执行，不直接暴露给渲染进程
 * - 路径验证、频率限制在 main 进程中完成
```

替换为：

```ts
 * - 文件操作通过 IPC 通道暴露给渲染进程，路径验证和频率限制在 main 进程中完成
 * - 敏感操作（如 Agent 执行范围外的文件修改）由 ScopeGuard 在 main 进程层拦截
```

- [ ] **Step 2: 修改 ESLint 配置 — 将 no-explicit-any 改为 warn**

在 `eslint.config.mjs` 中，将两处（行 17 和对应 renderer 配置中）：

```ts
'@typescript-eslint/no-explicit-any': 'off',
```

替换为：

```ts
'@typescript-eslint/no-explicit-any': 'warn',
```

- [ ] **Step 3: 运行 lint 检查当前 any 使用情况**

Run: `npm run lint 2>&1 | grep -c "no-explicit-any" || echo "0"`
Expected: 可能有一些警告，但不会阻止 lint 通过（warn 不阻塞 `--max-warnings 0` 之外的规则）

如果有阻塞，需要将现有 `any` 逐个替换为更精确的类型。此步只改配置为 warn，不强制修复所有现有 `any`。

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts eslint.config.mjs
git commit -m "fix: correct preload security comment and enable no-explicit-any as warning"
```

---

## Task 9: 常量去重 + 路径别名清理

**Files:**
- Modify: `src/shared/constants.ts` (删除重复注释)
- Modify: `src/main/ipc/graph.ts` (移除重复的 VALID_NODE_TYPES)
- Modify: `src/renderer/lib/utils.ts` (改用 crypto.randomUUID)
- Modify: `tsconfig.json` (保留但添加注释说明别名使用策略)
- Modify: `vite.config.ts` (同上)

当前问题：(1) `constants.ts` 行 96-98 有重复注释；(2) `VALID_NODE_TYPES` 在 graph.ts 和 graph-service.ts 中重复定义；(3) 渲染层 `generateId` 用 `Date.now()+Math.random` 不如 `crypto.randomUUID` 安全；(4) 路径别名未使用。

- [ ] **Step 1: 修复 constants.ts 重复注释**

在 `src/shared/constants.ts` 中，删除行 96 的多余重复注释行（保留行 98 的 `/** 支持的 Agent 适配器列表 */` 即可）。

- [ ] **Step 2: 消除 VALID_NODE_TYPES 重复**

在 `src/main/ipc/graph.ts` 中删除本地 `VALID_NODE_TYPES` 定义（行 15 附近），改为从 `graph-service.ts` 导入。

在 `src/main/services/graph-service.ts` 中，将 `VALID_NODE_TYPES`（约行 21）导出：

```ts
export const VALID_NODE_TYPES = ['project', 'module', 'process', 'feature', 'bug'] as const
```

在 `src/main/ipc/graph.ts` 中改为导入：

```ts
import { VALID_NODE_TYPES } from '../services/graph-service'
```

注意：如果 `graph.ts` 中没有其他从 `graph-service` 的导入，需要检查 `graphService` 的导入方式。当前 `graph.ts` 通过闭包访问 `graphService` 实例（在 `registerGraphHandlers` 函数参数中传入），因此可以安全添加这个导入。

- [ ] **Step 3: 改进渲染层 generateId 使用 crypto.randomUUID**

将 `src/renderer/lib/utils.ts` 行 14-16：

```ts
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
```

替换为：

```ts
export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`
}
```

`crypto.randomUUID()` 在现代浏览器和 Electron 渲染进程中均可用（Chromium 92+），碰撞概率远低于 `Date.now()+Math.random`。

- [ ] **Step 4: 为路径别名添加使用说明注释**

在 `tsconfig.json` 的 `paths` 配置上方添加注释：

```jsonc
    // 路径别名：@/ → renderer, @main/ → main, @shared/ → shared
    // 当前代码统一使用相对路径，别名保留供未来重构使用
    "paths": {
      "@/*": ["src/renderer/*"],
      "@main/*": ["src/main/*"],
      "@shared/*": ["src/shared/*"]
    }
```

- [ ] **Step 5: 运行测试确认无回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: Zero errors, all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants.ts src/main/ipc/graph.ts src/main/services/graph-service.ts src/renderer/lib/utils.ts tsconfig.json
git commit -m "fix: remove duplicate constants, improve generateId, document path alias policy"
```

---

## Task 10: 最终验证

**Files:** None (verification only)

- [ ] **Step 1: 运行完整类型检查**

Run: `npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 2: 运行完整测试套件**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: 运行 lint**

Run: `npm run lint`
Expected: Zero errors (可能有 no-explicit-any warnings，但 lint 不会因此失败)

- [ ] **Step 4: 运行开发服务器验证应用启动**

Run: `npm run dev`
Expected: 应用正常启动，无崩溃

- [ ] **Step 5: Commit（如有任何遗留修复）**

```bash
git add -A
git commit -m "chore: final verification and cleanup"
```
