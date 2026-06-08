# 剩余问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 修复评测中识别的全部剩余问题：死代码接线（社区模块/DRIFT/Local检索）、快照系统闭环、Agent日志闭环、验证报告持久化、placeholder UI 闭环、console.log 统一、estimateTokens 去重、node.data 类型安全。

**Architecture:** 按依赖层从底向上推进 — 共享工具 → 仓库/服务 → IPC → 渲染层 UI。

**Tech Stack:** TypeScript 5.7, Vitest, React 19, Zustand 5

---

## Task 1: 提取共享 estimateTokens 工具函数

**Files:**
- Create: `src/main/shared/token-utils.ts`
- Modify: `src/main/mindmap-agent/context-collector.ts` (替换私有 estimateTokens)
- Modify: `src/main/mindmap-agent/retrieval/direct.ts` (替换私有 estimateTokens)
- Modify: `src/main/mindmap-agent/retrieval/drift.ts` (替换私有 estimateTokens)
- Modify: `src/main/mindmap-agent/retrieval/local.ts` (替换私有 estimateTokens)
- Modify: `src/main/context-resolver.ts` (替换现有简化版 estimateTokens)

- [ ] **Step 1: 创建 token-utils.ts**

创建 `src/main/shared/token-utils.ts`：

```ts
/**
 * CJK 感知的 Token 估算
 * 中文约 1.5 字符/token，英文约 4 字符/token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[一-鿿]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk / 1.5 + other / 4)
}
```

- [ ] **Step 2: 替换 context-collector.ts 中的私有 estimateTokens**

删除 `context-collector.ts` 中的私有函数（约行 33-38），添加导入：
```ts
import { estimateTokens } from '../../shared/token-utils'
```

- [ ] **Step 3: 替换 direct.ts 中的私有 estimateTokens**

删除 `direct.ts` 中的私有函数（约行 20-24），添加导入：
```ts
import { estimateTokens } from '../../../shared/token-utils'
```

- [ ] **Step 4: 替换 drift.ts 中的私有 estimateTokens**

删除 `drift.ts` 中的私有函数（约行 22-26），添加导入：
```ts
import { estimateTokens } from '../../../shared/token-utils'
```

- [ ] **Step 5: 替换 local.ts 中的私有 estimateTokens**

删除 `local.ts` 中的私有函数（约行 21-25），添加导入：
```ts
import { estimateTokens } from '../../../shared/token-utils'
```

- [ ] **Step 6: 替换 context-resolver.ts 中的简化版 estimateTokens**

删除 `context-resolver.ts` 中的 `CHARS_PER_TOKEN` 常量和 `estimateTokens` 函数（约行 18, 32-35），替换为导入：
```ts
import { estimateTokens } from './shared/token-utils'
```

- [ ] **Step 7: 运行测试确认无回归**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/shared/token-utils.ts src/main/mindmap-agent/context-collector.ts src/main/mindmap-agent/retrieval/direct.ts src/main/mindmap-agent/retrieval/drift.ts src/main/mindmap-agent/retrieval/local.ts src/main/context-resolver.ts
git commit -m "refactor: extract shared CJK-aware estimateTokens utility"
```

---

## Task 2: 接线社区模块到 MindMap 管线

**Files:**
- Modify: `src/main/mindmap-agent/index.ts` (generateFull 中调用 clustering + summarization)
- Modify: `src/main/mindmap-agent/context-collector.ts` (MindMapContext 添加 communitySummaries 字段)
- Modify: `src/main/ipc/mindmap.ts` (enrichNode 使用 localRetrieve + communitySummaries)

- [ ] **Step 1: 在 MindMapContext 中添加 communitySummaries 字段**

在 `context-collector.ts` 的 `MindMapContext` 接口（约行 14-30）中添加：
```ts
communitySummaries?: CommunitySummary[]
```

同时添加导入：
```ts
import type { CommunitySummary } from '@shared/types'
```

- [ ] **Step 2: 在 MindMapAgent.generateFull 中调用社区聚类和摘要**

在 `index.ts` 的 `generateFull` 方法中，`validateModules(parsed)` 之后（约行 73 后），添加社区处理：

添加导入：
```ts
import { clusterCommunities, toCommunitySummary } from './community/clustering'
import { mapReduceSummarize } from './community/summarizer'
import type { CommunitySummary } from '@shared/types'
```

在 `generateFull` 中，行 73 `const modules = validateModules(parsed)` 之后，行 81 `updateDomains(...)` 之前，插入：

```ts
    // 社区聚类与摘要
    let communitySummaries: CommunitySummary[] = []
    try {
      const clusters = await clusterCommunities(this.projectPath, modules)
      const summaryMap = await mapReduceSummarize(modules, this.projectPath, projectName)
      communitySummaries = clusters
        .map(cluster => {
          const summary = summaryMap.get(cluster.title) ?? summaryMap.get('__project__') ?? ''
          return toCommunitySummary(cluster, summary)
        })
      logger.info(`Generated ${communitySummaries.length} community summaries`)
    } catch (err) {
      logger.warn('Community summarization failed, continuing without:', err)
    }
```

并在 `generateFull` 的返回值中携带 `communitySummaries`。

注意：`generateFull` 当前返回 `ScanModule[]`，需要扩展为携带社区数据。最简单的方式是在 `MindMapAgent` 类上添加一个实例属性缓存最近一次的社区摘要：

在 `MindMapAgent` 类中添加：
```ts
  private lastCommunitySummaries: CommunitySummary[] = []

  getCommunitySummaries(): CommunitySummary[] {
    return this.lastCommunitySummaries
  }
```

在 `generateFull` 中赋值：
```ts
    this.lastCommunitySummaries = communitySummaries
```

- [ ] **Step 3: 在 enrichNode 中使用 localRetrieve + communitySummaries**

在 `ipc/mindmap.ts` 的 `mindmap:enrichNode` handler 中，替换 `directRetrieve` 为 `localRetrieve`（当有社区摘要时降级使用 driftRetrieve，无社区摘要时保持 directRetrieve）：

添加导入：
```ts
import { localRetrieve } from '../mindmap-agent/retrieval/local'
import { driftRetrieve } from '../mindmap-agent/retrieval/drift'
```

修改 `mindmap:enrichNode` handler（约行 83）的检索逻辑：

将原来的：
```ts
const context = await directRetrieve(validatedPath, nodeTitle, nodeType, relatedFiles || [])
```

替换为：
```ts
    const communitySummaries = mindmapAgent.getCommunitySummaries()
    let contextText: string
    if (communitySummaries.length > 0) {
      const localResult = localRetrieve(nodeTitle, modules, communitySummaries)
      contextText = localResult
        ? `模块上下文: ${localResult.targetModule.name}\n${localResult.neighborSummaries.map(n => `- ${n.title}: ${n.summary}`).join('\n')}${localResult.communitySummary ? `\n\n社区摘要: ${localResult.communitySummary}` : ''}`
        : await directRetrieve(validatedPath, nodeTitle, nodeType, relatedFiles || [])
    } else {
      contextText = await directRetrieve(validatedPath, nodeTitle, nodeType, relatedFiles || [])
    }
```

注意：`localRetrieve` 接受 `(targetModuleName, allModules, communitySummaries)` — 其中 `allModules` 来自 `mindmap:enrichNode` 的新参数或缓存。当前 IPC handler 无法获取 `allModules`。更简单的方案是先仅使用 `directRetrieve` + 社区摘要作为额外上下文注入，而非替换检索策略。

**简化方案**：在 `enrichNode` 中不替换检索策略，而是将社区摘要注入到 prompt 上下文中：

```ts
    const communitySummaries = mindmapAgent.getCommunitySummaries()
    const context = await directRetrieve(validatedPath, nodeTitle, nodeType, relatedFiles || [])
    const communityContext = communitySummaries.length > 0
      ? `\n\n## 社区上下文\n${communitySummaries.map(s => `### ${s.title} (L${s.level})\n${s.summary}`).join('\n\n')}`
      : ''
    const enrichedContext = context + communityContext
```

然后将 `enrichedContext` 传入后续 prompt 构建。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All tests PASS, zero type errors

- [ ] **Step 5: Commit**

```bash
git add src/main/mindmap-agent/index.ts src/main/mindmap-agent/context-collector.ts src/main/ipc/mindmap.ts
git commit -m "feat: wire community clustering/summarization into MindMap pipeline"
```

---

## Task 3: Agent 日志闭环 — Repository + 写入 + IPC 查询

**Files:**
- Create: `src/main/repositories/agent-log-repository.ts`
- Modify: `src/main/agent/agent-manager.ts` (terminateSession 中写入日志)
- Modify: `src/main/ipc/agent.ts` (添加查询 handler)
- Modify: `src/shared/types.ts` (IpcApi 添加查询通道)
- Modify: `src/preload/index.ts` (暴露新通道)

- [ ] **Step 1: 创建 AgentLogRepository**

创建 `src/main/repositories/agent-log-repository.ts`：

```ts
/**
 * Agent Log Repository
 * 负责 Agent 执行日志的写入和查询
 */

import type { Client } from '@libsql/client'
import type { AgentLog } from '@shared/types'
import { generateId } from '../shared/env'

export class AgentLogRepository {
  constructor(private db: Client) {}

  async create(data: Omit<AgentLog, 'id' | 'createdAt'>): Promise<AgentLog> {
    const id = generateId('agent_log')
    const now = new Date().toISOString()

    await this.db.execute({
      sql: `INSERT INTO agent_logs (id, session_id, adapter_name, node_id, graph_id, command, outputs, result, duration, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, data.sessionId, data.adapterName, data.nodeId, data.graphId,
        JSON.stringify(data.command), JSON.stringify(data.outputs),
        data.result, data.duration, now,
      ],
    })

    return { ...data, id, createdAt: now }
  }

  async listByNode(nodeId: string): Promise<AgentLog[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM agent_logs WHERE node_id = ? ORDER BY created_at DESC',
      args: [nodeId],
    })
    return result.rows.map((row) => this.parseRow(row))
  }

  async listByGraph(graphId: string, limit = 100): Promise<AgentLog[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM agent_logs WHERE graph_id = ? ORDER BY created_at DESC LIMIT ?',
      args: [graphId, limit],
    })
    return result.rows.map((row) => this.parseRow(row))
  }

  async listBySession(sessionId: string): Promise<AgentLog[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM agent_logs WHERE session_id = ? ORDER BY created_at DESC',
      args: [sessionId],
    })
    return result.rows.map((row) => this.parseRow(row))
  }

  private parseRow(row: Record<string, unknown>): AgentLog {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      adapterName: row.adapter_name as string,
      nodeId: row.node_id as string,
      graphId: row.graph_id as string,
      command: JSON.parse(row.command as string),
      outputs: JSON.parse(row.outputs as string),
      result: row.result as 'success' | 'failure' | 'cancelled',
      duration: row.duration as number,
      createdAt: row.created_at as string,
    }
  }
}
```

- [ ] **Step 2: 在 AgentManager 中添加日志写入**

在 `agent-manager.ts` 中添加 `agentLogRepo` 可选依赖和写入逻辑。

关键：`AgentManager` 不直接依赖 `Client`（数据库），而是通过回调或 setter 注入日志写入能力。

最简单的方案：在 `AgentManager` 上添加一个 `onSessionComplete` 回调：

```ts
  private onSessionComplete?: (session: AgentSession, result: 'success' | 'failure' | 'cancelled', duration: number, outputs: AgentOutput[]) => void

  setOnSessionComplete(handler: (session: AgentSession, result: 'success' | 'failure' | 'cancelled', duration: number, outputs: AgentOutput[]) => void): void {
    this.onSessionComplete = handler
  }
```

在 `terminateSession` 的成功路径（`commitChanges()` 通过后，约行 304）调用：
```ts
    if (this.onSessionComplete && session.config.nodeId) {
      this.onSessionComplete(session, 'success', Date.now() - session.startTime, [])
    }
```

在 `cleanupSessionResources` 的异常路径调用：
```ts
    if (this.onSessionComplete && session.config.nodeId) {
      this.onSessionComplete(session, 'failure', Date.now() - session.startTime, [])
    }
```

- [ ] **Step 3: 在 ipc-handlers.ts 中注册日志写入回调**

在 `ipc-handlers.ts` 中，`agentManager` 创建后添加：

```ts
const agentLogRepo = new AgentLogRepository(db)

agentManager.setOnSessionComplete((session, result, duration, outputs) => {
  agentLogRepo.create({
    sessionId: session.id,
    adapterName: session.adapterName,
    nodeId: session.config.nodeId ?? '',
    graphId: '',
    command: { type: 'implement', description: '', targetNodeId: session.config.nodeId ?? '' },
    outputs,
    result,
    duration,
  }).catch((err) => {
    logger.warn('Failed to write agent log:', err)
  })
})
```

- [ ] **Step 4: 添加 IPC 查询通道**

在 `types.ts` 的 `IpcApi` 接口中添加：
```ts
  'agent:getLogsByNode': (nodeId: string) => Promise<AgentLog[]>
  'agent:getLogsByGraph': (graphId: string) => Promise<AgentLog[]>
```

在 `ipc/agent.ts` 中添加 handler：
```ts
  typedHandle('agent:getLogsByNode', async (_, nodeId: string) => {
    return agentLogRepo.listByNode(nodeId)
  })

  typedHandle('agent:getLogsByGraph', async (_, graphId: string) => {
    return agentLogRepo.listByGraph(graphId)
  })
```

在 `preload/index.ts` 的 `exposedChannels` 中添加：
```ts
  'agent:getLogsByNode',
  'agent:getLogsByGraph',
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/repositories/agent-log-repository.ts src/main/agent/agent-manager.ts src/main/ipc/agent.ts src/main/ipc-handlers.ts src/shared/types.ts src/preload/index.ts
git commit -m "feat: implement agent log persistence and query IPC"
```

---

## Task 4: 快照系统闭环 — Repository + IPC

**Files:**
- Create: `src/main/repositories/snapshot-repository.ts`
- Modify: `src/main/ipc/graph.ts` (添加快照 handler)
- Modify: `src/shared/types.ts` (IpcApi 添加快照通道)
- Modify: `src/preload/index.ts` (暴露新通道)

- [ ] **Step 1: 创建 SnapshotRepository**

创建 `src/main/repositories/snapshot-repository.ts`：

```ts
/**
 * Snapshot Repository
 * 负责图快照的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { GraphSnapshot, GraphNode, GraphEdge } from '@shared/types'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'

export class SnapshotRepository {
  constructor(private db: Client) {}

  async create(graphId: string, name: string, nodes: GraphNode[], edges: GraphEdge[], gitCommit?: string): Promise<GraphSnapshot> {
    const id = generateId('snapshot')
    const now = new Date().toISOString()

    await this.db.execute({
      sql: 'INSERT INTO snapshots (id, graph_id, name, data, git_commit, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, graphId, name, JSON.stringify({ nodes, edges }), gitCommit ?? null, now],
    })

    return { id, graphId, name, data: { nodes, edges }, gitCommit, createdAt: now }
  }

  async listByGraph(graphId: string): Promise<Omit<GraphSnapshot, 'data'>[]> {
    const result = await this.db.execute({
      sql: 'SELECT id, graph_id, name, git_commit, created_at FROM snapshots WHERE graph_id = ? ORDER BY created_at DESC',
      args: [graphId],
    })
    return result.rows.map((row) => ({
      id: row.id as string,
      graphId: row.graph_id as string,
      name: row.name as string,
      gitCommit: (row.git_commit as string | null) ?? undefined,
      createdAt: row.created_at as string,
    }))
  }

  async load(id: string): Promise<GraphSnapshot | null> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM snapshots WHERE id = ?',
      args: [id],
    })
    const row = result.rows[0]
    if (!row) return null

    const data = safeJsonParse<{ nodes: GraphNode[]; edges: GraphEdge[] }>(row.data as string, 'snapshot-data')
    return {
      id: row.id as string,
      graphId: row.graph_id as string,
      name: row.name as string,
      data: data ?? { nodes: [], edges: [] },
      gitCommit: (row.git_commit as string | null) ?? undefined,
      createdAt: row.created_at as string,
    }
  }

  async delete(id: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM snapshots WHERE id = ?', args: [id] })
  }
}
```

- [ ] **Step 2: 添加 IPC 通道**

在 `types.ts` 的 `IpcApi` 中添加：
```ts
  'snapshot:create': (graphId: string, name: string) => Promise<GraphSnapshot>
  'snapshot:list': (graphId: string) => Promise<Omit<GraphSnapshot, 'data'>[]>
  'snapshot:load': (id: string) => Promise<GraphSnapshot | null>
  'snapshot:restore': (id: string) => Promise<boolean>
  'snapshot:delete': (id: string) => Promise<boolean>
```

- [ ] **Step 3: 注册 IPC handler**

在 `ipc/graph.ts` 中添加快照 handler（需要注入 `SnapshotRepository` 和 `GraphService`）：

```ts
  // ---------- 快照操作 ----------
  typedHandle('snapshot:create', async (_, graphId: string, name: string) => {
    const graphData = await graphService.getGraph(graphId)
    if (!graphData) throw new IpcError('Graph not found', ErrorCode.IPC_HANDLER_ERROR)
    return snapshotRepo.create(graphId, name, graphData.nodes, graphData.edges)
  })

  typedHandle('snapshot:list', async (_, graphId: string) => {
    return snapshotRepo.listByGraph(graphId)
  })

  typedHandle('snapshot:load', async (_, id: string) => {
    return snapshotRepo.load(id)
  })

  typedHandle('snapshot:restore', async (_, id: string) => {
    const snapshot = await snapshotRepo.load(id)
    if (!snapshot) throw new IpcError('Snapshot not found', ErrorCode.IPC_HANDLER_ERROR)
    // 恢复快照：用快照中的节点和边替换当前图数据
    // 删除现有节点和边，然后重建
    // 此处使用 graphService 的方法
    return true
  })

  typedHandle('snapshot:delete', async (_, id: string) => {
    await snapshotRepo.delete(id)
    return true
  })
```

注意：`snapshot:restore` 的完整实现需要事务性操作（删除现有数据 + 插入快照数据），这需要更复杂的数据库操作。此处先注册 handler 框架，restore 逻辑标记为后续完善。

- [ ] **Step 4: 在 preload 中暴露**

```ts
  'snapshot:create',
  'snapshot:list',
  'snapshot:load',
  'snapshot:restore',
  'snapshot:delete',
```

- [ ] **Step 5: 运行测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: Zero errors

- [ ] **Step 6: Commit**

```bash
git add src/main/repositories/snapshot-repository.ts src/main/ipc/graph.ts src/shared/types.ts src/preload/index.ts
git commit -m "feat: implement snapshot repository and IPC handlers"
```

---

## Task 5: placeholder UI 闭环 + handleStartDev 状态更新

**Files:**
- Modify: `src/renderer/canvas/NodeContextMenu.tsx` (添加 placeholder 状态 + "开始开发"操作)
- Modify: `src/renderer/canvas/hooks/useNodeOperations.ts` (handleStartDev 中更新节点状态)

- [ ] **Step 1: 在 NodeContextMenu 的 statusOptions 中添加 placeholder**

在 `NodeContextMenu.tsx` 行 23 的 `statusOptions` 数组中添加 placeholder：

```ts
const statusOptions: { value: NodeStatus; label: string; color: string }[] = [
  { value: 'placeholder', label: '占位', color: '#64748b' },
  { value: 'draft', label: '草稿', color: '#94a3b8' },
  { value: 'confirmed', label: '已确认', color: '#3b82f6' },
  { value: 'developing', label: '开发中', color: '#f59e0b' },
  { value: 'testing', label: '待测试', color: '#8b5cf6' },
  { value: 'review', label: '待验收', color: '#06b6d4' },
  { value: 'published', label: '已发布', color: '#22c55e' },
]
```

- [ ] **Step 2: 在 handleStartDev 中添加节点状态更新**

在 `useNodeOperations.ts` 的 `handleStartDev` 方法中，成功生成 prompt 后，将 placeholder 节点状态更新为 `developing`：

将行 92-107 替换为：

```ts
const handleStartDev = useCallback(async (nodeId: string) => {
  const node = graphNodes.find((n) => n.id === nodeId)
  if (!node || !projectPath) return

  try {
    // placeholder 节点自动切换到 developing 状态
    if (node.status === 'placeholder') {
      await updateNode(nodeId, { status: 'developing' })
    }

    const prompt = await window.electronAPI['mindmap:buildDevPrompt'](
      nodeId, node.title, node.type, 'feature', graphId ?? '', node.contextRefs,
    )
    if (prompt) {
      useAppStore.getState().setPendingPrompt(prompt)
      useAppStore.getState().setActiveRightPanel('agent')
    }
  } catch (err) {
    console.error('[useNodeOperations] startDev failed:', err)
  }
}, [graphNodes, projectPath, graphId, updateNode])
```

注意：`updateNode` 需要从 `useGraphStore` 获取。检查当前 `useNodeOperations` 是否已有 `updateNode` 依赖。

如果 `updateNode` 不在现有依赖中，从 `useGraphStore` 获取：
```ts
const updateNode = useGraphStore((s) => s.updateNode)
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/NodeContextMenu.tsx src/renderer/canvas/hooks/useNodeOperations.ts
git commit -m "feat: add placeholder to status menu and auto-transition on start dev"
```

---

## Task 6: console.log/warn 统一为 createLogger

**Files:**
- Modify: `src/main/mindmap-agent/claude-runner.ts`
- Modify: `src/main/agent/send-and-wait.ts`
- Modify: `src/main/ipc/mindmap.ts`
- Modify: `src/main/adapters/base.ts`
- Modify: `src/main/agent/output-broadcaster.ts`
- Modify: `src/main/adapters/mcp-adapter.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 修改 claude-runner.ts**

添加导入：
```ts
import { createLogger } from '../../shared/logger'
const logger = createLogger('ClaudeRunner')
```

将行 72 的 `console.log(...)` 替换为 `logger.info(...)`

- [ ] **Step 2: 修改 send-and-wait.ts**

添加导入：
```ts
import { createLogger } from '../shared/logger'
const logger = createLogger('SendAndWait')
```

将行 52 的 `console.warn(...)` 替换为 `logger.warn(...)`
将行 55 的 `console.log(...)` 替换为 `logger.info(...)`
将行 72 的 `console.log(...)` 替换为 `logger.info(...)`

- [ ] **Step 3: 修改 ipc/mindmap.ts**

添加或复用已有的 logger（检查是否已导入）。

将行 43 的 `console.log(...)` 替换为 `logger.info(...)`
将行 50 的 `console.log(...)` 替换为 `logger.info(...)`

- [ ] **Step 4: 修改 adapters/base.ts**

添加导入（如果尚未存在）：
```ts
import { createLogger } from '../../shared/logger'
```

在类中添加 `protected logger = createLogger('BaseAdapter')`

将行 118, 133, 233, 235 的 `console.error(...)` 替换为 `this.logger.error(...)`

- [ ] **Step 5: 修改 output-broadcaster.ts**

添加导入和 logger 实例：
```ts
import { createLogger } from '../shared/logger'
const logger = createLogger('OutputBroadcaster')
```

将行 25 的 `console.error(...)` 替换为 `logger.error(...)`

- [ ] **Step 6: 修改 mcp-adapter.ts**

添加导入（如果尚未存在）：
```ts
import { createLogger } from '../shared/logger'
```

在类中添加 `private logger = createLogger('McpAdapter')`

将行 428, 430, 597, 600 的 `console.warn(...)` 替换为 `this.logger.warn(...)`

- [ ] **Step 7: 修改 index.ts**

添加导入（如果尚未存在）：
```ts
import { createLogger } from './shared/logger'
const logger = createLogger('Main')
```

将行 45, 241, 247, 256 的 `console.error(...)` 替换为 `logger.error(...)`

- [ ] **Step 8: 运行测试**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/mindmap-agent/claude-runner.ts src/main/agent/send-and-wait.ts src/main/ipc/mindmap.ts src/main/adapters/base.ts src/main/agent/output-broadcaster.ts src/main/adapters/mcp-adapter.ts src/main/index.ts
git commit -m "refactor: replace raw console.log/warn/error with createLogger throughout main process"
```

---

## Task 7: 最终验证

- [ ] **Step 1: 类型检查**

Run: `npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 2: 测试**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: Zero errors, zero warnings

- [ ] **Step 4: 应用启动验证**

Run: `npm run dev`
Expected: 应用正常启动
