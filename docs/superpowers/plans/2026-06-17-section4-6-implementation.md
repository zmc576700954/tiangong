# Section 4-6: 思维导图/适配器/前端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 BizGraph 全面打磨的最后3个领域 — 思维导图与知识图谱、Agent适配器系统、前端界面与用户体验

**Architecture:** 纵切优先，每个领域6个子任务全部实施。增量增强为主，消费 Section 1-3 已建立的基础设施（EmbeddingService, ContextPipeline, PromptOrchestrator, Store拆分, MessageQueue, SessionRecovery）

**Tech Stack:** TypeScript, LibSQL, @xenova/transformers, Zustand, React, @xyflow/react, Vitest

---

## File Structure

### New Files
- `src/main/memory/knowledge-associator.ts` — 多维度知识关联引擎
- `src/main/memory/node-schema-registry.ts` — per-NodeType 元数据 schema 验证
- `src/main/services/graph-sync-service.ts` — Canvas↔GraphMemory 双向同步
- `src/main/memory/query-cache.ts` — LRU 查询结果缓存
- `src/main/adapters/circuit-breaker.ts` — 独立 CircuitBreaker 类（从 McpAdapter 提取）
- `src/main/agent/request-queue.ts` — 适配器请求编排队列
- `src/main/memory/__tests__/knowledge-associator.test.ts`
- `src/main/memory/__tests__/node-schema-registry.test.ts`
- `src/main/services/__tests__/graph-sync-service.test.ts`
- `src/main/memory/__tests__/query-cache.test.ts`
- `src/main/adapters/__tests__/circuit-breaker.test.ts`
- `src/main/agent/__tests__/request-queue.test.ts`

### Modified Files
- `src/shared/types/graph.ts` — EdgeType 扩展, EdgeContent 增加 suggested
- `src/shared/types/agent.ts` — AdapterCapability 枚举
- `src/renderer/canvas/edge-utils.ts` — 新 edgeType 样式配置
- `src/renderer/canvas/BizEdge.tsx` — suggested 边虚线渲染, CSS hover
- `src/renderer/canvas/BizNode.tsx` — 预览节点样式, CSS transition, hex→CSS变量
- `src/renderer/canvas/GraphCanvas.tsx` — 进度叠加层, 拖拽/缩放优化, 消除 double-write
- `src/renderer/store/graphStore.ts` — 内部 Map 索引, preview 节点, suggested edges
- `src/renderer/store/eventBus.ts` — GENERATION_PROGRESS 事件
- `src/renderer/index.css` — 语义 token, 深色模式, 微交互 token, prefers-reduced-motion, 响应式断点
- `src/renderer/App.tsx` — React.lazy, 响应式断点, 面板折叠
- `src/renderer/hooks/useResizablePanel.ts` — localStorage 持久化
- `src/renderer/components/agent/AgentChatPanel.tsx` — 骨架屏, 错误友好化, 降级提示条, 底部抽屉
- `src/renderer/store/messageStore.ts` — seq 去重
- `src/renderer/store/adapterStore.ts` — forceAdapter
- `src/main/services/graph-service.ts` — suggestEdges 调用 KnowledgeAssociator
- `src/main/ipc/graph.ts` — node:update schema 校验, graph:suggestedEdges IPC
- `src/main/ipc/mindmap.ts` — GENERATION_PROGRESS 事件发送
- `src/main/memory/graph-memory.ts` — traverse 接入 QueryCache, traverseBatch
- `src/main/agent/adapter-registry.ts` — 并行检测+缓存
- `src/main/adapters/registry.ts` — capabilities, fallbackTo, 平台预过滤
- `src/main/adapters/base.ts` — 错误边界, 超时常量
- `src/main/adapters/mcp-adapter.ts` — 改用共享 CircuitBreaker
- `src/main/agent/agent-manager.ts` — SessionRecovery 接入, RequestQueue 接入, 动态降级
- `src/main/database.ts` — schema v4 迁移（如需新索引）
- `vite.config.ts` — manualChunks, rollup-plugin-visualizer

---

## Task 1: EdgeType 扩展与 EdgeContent.suggested

**Files:**
- Modify: `src/shared/types/graph.ts:47`
- Modify: `src/renderer/canvas/edge-utils.ts`

- [ ] **Step 1: 扩展 EdgeType 联合类型**

在 `src/shared/types/graph.ts` 中，修改 line 47:

```typescript
export type EdgeType = 'default' | 'success' | 'failure' | 'condition' | 'business-flow' | 'semantic' | 'dependency' | 'co-change'
```

修改 `EDGE_TYPE_VALUES` (line 323):

```typescript
export const EDGE_TYPE_VALUES = ['default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change'] as const
```

在 `EdgeContent` 接口 (line 126-133) 中增加 `suggested` 字段:

```typescript
export interface EdgeContent {
  condition?: string
  note?: string
  trigger?: 'auto' | 'manual' | 'scheduled'
  guard?: string
  timeout?: number
  retry?: { max: number; delay: number }
  suggested?: boolean  // 建议边标记，需用户确认后才变为正式边
}
```

- [ ] **Step 2: 更新 edge-utils.ts 样式配置**

在 `src/renderer/canvas/edge-utils.ts` 中增加新 edgeType 的样式:

```typescript
export const edgeTypeConfig: Record<EdgeType, { color: string; label: string; animated?: boolean; strokeDasharray?: string }> = {
  default: { color: '#94a3b8', label: '默认' },
  success: { color: '#22c55e', label: '成功' },
  failure: { color: '#ef4444', label: '失败' },
  condition: { color: '#f59e0b', label: '条件' },
  'business-flow': { color: '#3b82f6', label: '业务流程', animated: true, strokeDasharray: '8 4' },
  semantic: { color: '#3b82f6', label: '语义关联', strokeDasharray: '6 4' },
  dependency: { color: '#22c55e', label: '代码依赖' },
  'co-change': { color: '#f97316', label: '变更耦合', strokeDasharray: '2 4' },
}
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsc --noEmit 2>&1 | head -30`

Expected: 无新增类型错误（新 EdgeType 值在 switch/if 中需覆盖的地方会有 warning，后续任务修复）

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/graph.ts src/renderer/canvas/edge-utils.ts
git commit -m "feat(graph): extend EdgeType with semantic/dependency/co-change, add EdgeContent.suggested"
```

---

## Task 2: KnowledgeAssociator 知识关联引擎

**Files:**
- Create: `src/main/memory/knowledge-associator.ts`
- Create: `src/main/memory/__tests__/knowledge-associator.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, vi } from 'vitest'
import { KnowledgeAssociator } from '../knowledge-associator'
import type { GraphNode, GraphEdge } from '@shared/types'

describe('KnowledgeAssociator', () => {
  const associator = new KnowledgeAssociator()

  const makeNode = (id: string, type: string, title: string, description = ''): GraphNode => ({
    id, type: type as any, title, description,
    graphId: 'g1', x: 0, y: 0, parentId: null,
    status: 'confirmed', label: title,
    content: { fullDescription: description },
    metadata: {}, createdAt: '', updatedAt: ''
  })

  test('computeAssociationScore returns 0 for unrelated nodes', () => {
    const a = makeNode('n1', 'feature', 'User authentication')
    const b = makeNode('n2', 'feature', 'Database migration')
    const score = associator.computeAssociationScore(a, b, { dependencyEdges: [], coChangeFreq: 0 })
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  test('computeAssociationScore weights dependency highest', () => {
    const a = makeNode('n1', 'feature', 'Auth module')
    const b = makeNode('n2', 'feature', 'Token service')
    const noDep = associator.computeAssociationScore(a, b, { dependencyEdges: [], coChangeFreq: 0 })
    const withDep = associator.computeAssociationScore(a, b, { dependencyEdges: [{ sourceId: 'n1', targetId: 'n2' }], coChangeFreq: 0 })
    expect(withDep).toBeGreaterThan(noDep)
  })

  test('computeAssociationScore weights co-change', () => {
    const a = makeNode('n1', 'feature', 'Payment')
    const b = makeNode('n2', 'feature', 'Invoice')
    const noCoChange = associator.computeAssociationScore(a, b, { dependencyEdges: [], coChangeFreq: 0 })
    const withCoChange = associator.computeAssociationScore(a, b, { dependencyEdges: [], coChangeFreq: 5 })
    expect(withCoChange).toBeGreaterThan(noCoChange)
  })

  test('findAssociations filters by threshold 0.6', () => {
    const nodes = [
      makeNode('n1', 'feature', 'Auth'),
      makeNode('n2', 'feature', 'Unrelated topic XYZ'),
      makeNode('n3', 'feature', 'Token validation'),
    ]
    const results = associator.findAssociations(nodes, {
      dependencyEdges: [{ sourceId: 'n1', targetId: 'n3' }],
      coChangeFreqMap: new Map([['n1:n3', 3]]),
      threshold: 0.6
    })
    // n1→n3 should be associated (dependency + co-change), n1→n2 should not
    expect(results.some(r => r.sourceId === 'n1' && r.targetId === 'n3')).toBe(true)
    expect(results.some(r => r.sourceId === 'n1' && r.targetId === 'n2')).toBe(false)
  })

  test('findAssociations assigns correct edgeType', () => {
    const nodes = [makeNode('n1', 'feature', 'A'), makeNode('n2', 'feature', 'B')]
    const depOnly = associator.findAssociations(nodes, {
      dependencyEdges: [{ sourceId: 'n1', targetId: 'n2' }],
      coChangeFreqMap: new Map(), threshold: 0.3
    })
    if (depOnly.length > 0) {
      expect(depOnly[0].edgeType).toBe('dependency')
    }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/memory/__tests__/knowledge-associator.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: 实现 KnowledgeAssociator**

```typescript
import type { GraphNode } from '@shared/types'
import type { EdgeType } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('knowledge-associator')

export interface AssociationInput {
  dependencyEdges: Array<{ sourceId: string; targetId: string }>
  coChangeFreqMap: Map<string, number>
  threshold?: number
}

export interface AssociationResult {
  sourceId: string
  targetId: string
  score: number
  edgeType: EdgeType
  signals: { dependency: boolean; semantic: boolean; coChange: boolean }
}

const WEIGHTS = { dependency: 0.9, semantic: 0.7, coChange: 0.6 } as const

export class KnowledgeAssociator {
  private _embeddingService: any = null

  /** 设置 embedding 服务（延迟注入，避免循环依赖） */
  setEmbeddingService(service: { cosineSimilarity(a: number[], b: number[]): number; generateEmbedding(text: string): Promise<number[]> }): void {
    this._embeddingService = service
  }

  /** 计算两个节点间的关联分数 */
  computeAssociationScore(
    nodeA: GraphNode,
    nodeB: GraphNode,
    input: { dependencyEdges: Array<{ sourceId: string; targetId: string }>; coChangeFreq: number }
  ): number {
    const signals: { dependency: boolean; semantic: boolean; coChange: boolean } = {
      dependency: false, semantic: false, coChange: false
    }

    let weightedSum = 0
    let totalWeight = 0

    // 信号1: 代码依赖
    const hasDep = input.dependencyEdges.some(
      e => (e.sourceId === nodeA.id && e.targetId === nodeB.id) ||
           (e.sourceId === nodeB.id && e.targetId === nodeA.id)
    )
    if (hasDep) {
      weightedSum += WEIGHTS.dependency
      signals.dependency = true
    }
    totalWeight += WEIGHTS.dependency

    // 信号2: 语义相似（需要 embedding service，无则跳过）
    // 语义分数由 findAssociations 批量计算，此处仅占位
    totalWeight += WEIGHTS.semantic

    // 信号3: 变更耦合
    if (input.coChangeFreq > 0) {
      const coChangeScore = Math.min(1, input.coChangeFreq / 10)
      weightedSum += WEIGHTS.coChange * coChangeScore
      signals.coChange = true
    }
    totalWeight += WEIGHTS.coChange

    return totalWeight > 0 ? weightedSum / totalWeight : 0
  }

  /** 批量发现节点间关联 */
  async findAssociations(nodes: GraphNode[], input: AssociationInput): Promise<AssociationResult[]> {
    const threshold = input.threshold ?? 0.6
    const results: AssociationResult[] = []

    // 预计算 embedding（如果可用）
    const embeddings = new Map<string, number[]>()
    if (this._embeddingService) {
      for (const node of nodes) {
        try {
          const text = `${node.title} ${node.description}`
          const emb = await this._embeddingService.generateEmbedding(text)
          embeddings.set(node.id, emb)
        } catch {
          // embedding 生成失败，跳过该节点
        }
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]

        const pairKey = [a.id, b.id].sort().join(':')
        const coChangeFreq = input.coChangeFreqMap.get(pairKey) ?? 0
        const hasDep = input.dependencyEdges.some(
          e => (e.sourceId === a.id && e.targetId === b.id) ||
               (e.sourceId === b.id && e.targetId === a.id)
        )

        // 计算各信号分数
        let weightedSum = 0
        let totalWeight = 0
        const signals = { dependency: false, semantic: false, coChange: false }

        // 依赖
        if (hasDep) {
          weightedSum += WEIGHTS.dependency
          signals.dependency = true
        }
        totalWeight += WEIGHTS.dependency

        // 语义
        const embA = embeddings.get(a.id)
        const embB = embeddings.get(b.id)
        if (embA && embB) {
          const sim = this._embeddingService!.cosineSimilarity(embA, embB)
          if (sim > 0.6) {
            weightedSum += WEIGHTS.semantic * sim
            signals.semantic = true
          }
        }
        totalWeight += WEIGHTS.semantic

        // 变更耦合
        if (coChangeFreq > 0) {
          const coChangeScore = Math.min(1, coChangeFreq / 10)
          weightedSum += WEIGHTS.coChange * coChangeScore
          signals.coChange = true
        }
        totalWeight += WEIGHTS.coChange

        const score = totalWeight > 0 ? weightedSum / totalWeight : 0

        if (score >= threshold) {
          const edgeType = this._determineEdgeType(signals)
          results.push({ sourceId: a.id, targetId: b.id, score, edgeType, signals })
        }
      }
    }

    return results.sort((a, b) => b.score - a.score)
  }

  private _determineEdgeType(signals: { dependency: boolean; semantic: boolean; coChange: boolean }): EdgeType {
    if (signals.dependency) return 'dependency'
    if (signals.semantic) return 'semantic'
    if (signals.coChange) return 'co-change'
    return 'default'
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/knowledge-associator.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/knowledge-associator.ts src/main/memory/__tests__/knowledge-associator.test.ts
git commit -m "feat(memory): add KnowledgeAssociator for multi-signal knowledge association"
```

---

## Task 3: NodeSchemaRegistry 节点 Schema 验证

**Files:**
- Create: `src/main/memory/node-schema-registry.ts`
- Create: `src/main/memory/__tests__/node-schema-registry.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect } from 'vitest'
import { NodeSchemaRegistry, validateNodeMetadata } from '../node-schema-registry'

describe('NodeSchemaRegistry', () => {
  test('returns schema for each node type', () => {
    const moduleSchema = NodeSchemaRegistry.get('module')
    expect(moduleSchema).toBeDefined()
    expect(moduleSchema!.fields).toHaveProperty('frameworks')
    expect(moduleSchema!.fields).toHaveProperty('entryPoints')

    const processSchema = NodeSchemaRegistry.get('process')
    expect(processSchema).toBeDefined()
    expect(processSchema!.fields).toHaveProperty('apiEndpoints')

    const featureSchema = NodeSchemaRegistry.get('feature')
    expect(featureSchema).toBeDefined()
    expect(featureSchema!.fields).toHaveProperty('acceptanceCriteria')

    const bugSchema = NodeSchemaRegistry.get('bug')
    expect(bugSchema).toBeDefined()
    expect(bugSchema!.fields).toHaveProperty('severity')
  })

  test('validateNodeMetadata passes for valid module metadata', () => {
    const result = validateNodeMetadata('module', {
      frameworks: ['React', 'Electron'],
      entryPoints: ['src/main/index.ts'],
      keyFiles: ['package.json'],
      techStack: ['TypeScript', 'LibSQL']
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('validateNodeMetadata reports unknown fields', () => {
    const result = validateNodeMetadata('module', {
      frameworks: ['React'],
      unknownField: 'should be flagged'
    })
    expect(result.valid).toBe(true) // unknown fields are allowed but warned
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  test('validateNodeMetadata returns valid for empty metadata', () => {
    const result = validateNodeMetadata('feature', {})
    expect(result.valid).toBe(true)
  })

  test('validateNodeMetadata returns valid for project type (no schema)', () => {
    const result = validateNodeMetadata('project', { anything: 'goes' })
    expect(result.valid).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/memory/__tests__/node-schema-registry.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 NodeSchemaRegistry**

```typescript
import type { NodeType } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('node-schema-registry')

export interface FieldDef {
  type: 'string' | 'string[]' | 'number' | 'boolean'
  required?: boolean
  description: string
}

export interface NodeTypeSchema {
  fields: Record<string, FieldDef>
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

const SCHEMAS: Record<string, NodeTypeSchema> = {
  module: {
    fields: {
      frameworks: { type: 'string[]', description: '使用的框架列表' },
      entryPoints: { type: 'string[]', description: '入口文件路径' },
      keyFiles: { type: 'string[]', description: '关键文件列表' },
      techStack: { type: 'string[]', description: '技术栈' },
    }
  },
  process: {
    fields: {
      apiEndpoints: { type: 'string[]', description: 'API 端点列表' },
      dataFlow: { type: 'string', description: '数据流向描述' },
      stakeholders: { type: 'string[]', description: '相关干系人' },
      frequency: { type: 'string', description: '执行频率' },
    }
  },
  feature: {
    fields: {
      acceptanceCriteria: { type: 'string[]', description: '验收标准' },
      linkedFiles: { type: 'string[]', description: '关联文件' },
      testCoverage: { type: 'number', description: '测试覆盖率' },
      priority: { type: 'string', description: '优先级' },
    }
  },
  bug: {
    fields: {
      severity: { type: 'string', required: true, description: '严重程度' },
      reproduction: { type: 'string', description: '复现步骤' },
      affectedUsers: { type: 'string[]', description: '受影响用户群' },
      fixDeadline: { type: 'string', description: '修复截止日期' },
    }
  }
}

export const NodeSchemaRegistry = {
  get(nodeType: NodeType | string): NodeTypeSchema | undefined {
    return SCHEMAS[nodeType]
  },

  listTypes(): string[] {
    return Object.keys(SCHEMAS)
  },

  getFieldNames(nodeType: NodeType | string): string[] {
    return Object.keys(SCHEMAS[nodeType]?.fields ?? {})
  }
}

export function validateNodeMetadata(nodeType: NodeType | string, metadata: Record<string, unknown>): ValidationResult {
  const schema = SCHEMAS[nodeType]
  const errors: string[] = []
  const warnings: string[] = []

  if (!schema) {
    return { valid: true, errors, warnings }
  }

  const knownFields = new Set(Object.keys(schema.fields))

  for (const [key, value] of Object.entries(metadata)) {
    if (!knownFields.has(key)) {
      warnings.push(`Unknown field '${key}' for node type '${nodeType}'`)
      continue
    }

    const fieldDef = schema.fields[key]
    if (fieldDef.required && (value === undefined || value === null || value === '')) {
      errors.push(`Required field '${key}' is missing for node type '${nodeType}'`)
    }

    if (fieldDef.type === 'string[]' && !Array.isArray(value)) {
      errors.push(`Field '${key}' should be an array, got ${typeof value}`)
    }
    if (fieldDef.type === 'string' && typeof value !== 'string') {
      errors.push(`Field '${key}' should be a string, got ${typeof value}`)
    }
    if (fieldDef.type === 'number' && typeof value !== 'number') {
      errors.push(`Field '${key}' should be a number, got ${typeof value}`)
    }
  }

  for (const [key, def] of Object.entries(schema.fields)) {
    if (def.required && !(key in metadata)) {
      errors.push(`Required field '${key}' is missing for node type '${nodeType}'`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/node-schema-registry.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/node-schema-registry.ts src/main/memory/__tests__/node-schema-registry.test.ts
git commit -m "feat(memory): add NodeSchemaRegistry for per-type metadata validation"
```

---

## Task 4: QueryCache 查询缓存

**Files:**
- Create: `src/main/memory/query-cache.ts`
- Create: `src/main/memory/__tests__/query-cache.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, vi } from 'vitest'
import { QueryCache } from '../query-cache'

describe('QueryCache', () => {
  test('caches and retrieves results', () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60000 })
    cache.set('n1', { depth: 2 }, 'result1')
    expect(cache.get('n1', { depth: 2 })).toBe('result1')
  })

  test('returns undefined for cache miss', () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60000 })
    expect(cache.get('n1', { depth: 2 })).toBeUndefined()
  })

  test('returns undefined after TTL expires', () => {
    vi.useFakeTimers()
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 5000 })
    cache.set('n1', { depth: 2 }, 'result1')
    vi.advanceTimersByTime(6000)
    expect(cache.get('n1', { depth: 2 })).toBeUndefined()
    vi.useRealTimers()
  })

  test('evicts oldest entry when at capacity', () => {
    const cache = new QueryCache<string>({ maxSize: 2, ttlMs: 60000 })
    cache.set('n1', { depth: 1 }, 'r1')
    cache.set('n2', { depth: 1 }, 'r2')
    cache.set('n3', { depth: 1 }, 'r3')
    expect(cache.get('n1', { depth: 1 })).toBeUndefined()
    expect(cache.get('n3', { depth: 1 })).toBe('r3')
  })

  test('invalidate removes entries for a specific node', () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60000 })
    cache.set('n1', { depth: 1 }, 'r1')
    cache.set('n1', { depth: 2 }, 'r2')
    cache.set('n2', { depth: 1 }, 'r3')
    cache.invalidate('n1')
    expect(cache.get('n1', { depth: 1 })).toBeUndefined()
    expect(cache.get('n1', { depth: 2 })).toBeUndefined()
    expect(cache.get('n2', { depth: 1 })).toBe('r3')
  })

  test('different options produce different cache keys', () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60000 })
    cache.set('n1', { depth: 1 }, 'shallow')
    cache.set('n1', { depth: 3 }, 'deep')
    expect(cache.get('n1', { depth: 1 })).toBe('shallow')
    expect(cache.get('n1', { depth: 3 })).toBe('deep')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/memory/__tests__/query-cache.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 QueryCache**

```typescript
import { createLogger } from '../shared/logger'

const logger = createLogger('query-cache')

export interface QueryCacheOptions {
  maxSize?: number
  ttlMs?: number
}

interface CacheEntry<T> {
  value: T
  createdAt: number
}

export class QueryCache<T> {
  private _cache = new Map<string, CacheEntry<T>>()
  private _maxSize: number
  private _ttlMs: number

  constructor(options: QueryCacheOptions = {}) {
    this._maxSize = options.maxSize ?? 100
    this._ttlMs = options.ttlMs ?? 5 * 60 * 1000
  }

  private _makeKey(nodeId: string, options: { depth?: number; relationFilter?: string[] }): string {
    const depth = options.depth ?? 2
    const relations = (options.relationFilter ?? []).sort().join(',')
    return `${nodeId}:d${depth}:r[${relations}]`
  }

  get(nodeId: string, options: { depth?: number; relationFilter?: string[] }): T | undefined {
    const key = this._makeKey(nodeId, options)
    const entry = this._cache.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.createdAt > this._ttlMs) {
      this._cache.delete(key)
      return undefined
    }
    return entry.value
  }

  set(nodeId: string, options: { depth?: number; relationFilter?: string[] }, value: T): void {
    const key = this._makeKey(nodeId, options)
    if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
      const firstKey = this._cache.keys().next().value
      if (firstKey) this._cache.delete(firstKey)
    }
    this._cache.set(key, { value, createdAt: Date.now() })
  }

  invalidate(nodeId: string): void {
    for (const key of this._cache.keys()) {
      if (key.startsWith(`${nodeId}:`)) {
        this._cache.delete(key)
      }
    }
  }

  clear(): void {
    this._cache.clear()
  }

  get size(): number {
    return this._cache.size
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/query-cache.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/query-cache.ts src/main/memory/__tests__/query-cache.test.ts
git commit -m "feat(memory): add QueryCache LRU with TTL for graph traversal results"
```

---

## Task 5: GraphMemory 接入 QueryCache + traverseBatch

**Files:**
- Modify: `src/main/memory/graph-memory.ts`

- [ ] **Step 1: 在 GraphMemory 中注入 QueryCache**

在 `graph-memory.ts` 的 `GraphMemory` 类中增加缓存字段和 traverse 缓存逻辑:

```typescript
import { QueryCache } from './query-cache'
import type { GraphTraversalResult } from './graph-memory'  // self-reference handled below

// 在 GraphMemory 类中增加:
private _cache = new QueryCache<GraphTraversalResult>({ maxSize: 100, ttlMs: 5 * 60 * 1000 })
```

在 `traverse()` 方法开头增加缓存查找:

```typescript
async traverse(memoryId: number, options?: { depth?: number; relationFilter?: MemoryRelationType[] }): Promise<GraphTraversalResult | null> {
  // 缓存查找
  const cached = this._cache.get(String(memoryId), {
    depth: options?.depth,
    relationFilter: options?.relationFilter
  })
  if (cached) return cached

  // ... 现有 traverse 逻辑 ...

  // 结果写入缓存
  if (result) {
    this._cache.set(String(memoryId), {
      depth: options?.depth,
      relationFilter: options?.relationFilter
    }, result)
  }
  return result
}
```

- [ ] **Step 2: 增加 traverseBatch 方法**

```typescript
async traverseBatch(memoryIds: number[], options?: { depth?: number; relationFilter?: MemoryRelationType[] }): Promise<Map<number, GraphTraversalResult | null>> {
  const results = new Map<number, GraphTraversalResult | null>()
  await Promise.all(
    memoryIds.map(async (id) => {
      const result = await this.traverse(id, options)
      results.set(id, result)
    })
  )
  return results
}
```

- [ ] **Step 3: 在写入方法中失效缓存**

在 `inferRelations()` 等修改图谱结构的方法中，写入后失效相关缓存:

```typescript
// 在 inferRelations 末尾增加:
this._cache.invalidate(String(newMemory.id))
for (const existing of existingMemories) {
  this._cache.invalidate(String(existing.id))
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/graph-memory.ts
git commit -m "feat(memory): integrate QueryCache into GraphMemory.traverse, add traverseBatch"
```

---

## Task 6: GraphSyncService 双向同步

**Files:**
- Create: `src/main/services/graph-sync-service.ts`
- Create: `src/main/services/__tests__/graph-sync-service.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, vi } from 'vitest'
import { GraphSyncService } from '../graph-sync-service'

describe('GraphSyncService', () => {
  test('start begins periodic association scan', () => {
    const service = new GraphSyncService({
      graphService: {} as any,
      knowledgeAssociator: {} as any,
      pushSuggestedEdges: vi.fn(),
      scanIntervalMs: 1000
    })
    service.start('g1')
    expect(service.isRunning('g1')).toBe(true)
    service.stop('g1')
  })

  test('stop halts periodic scan', () => {
    const service = new GraphSyncService({
      graphService: {} as any,
      knowledgeAssociator: {} as any,
      pushSuggestedEdges: vi.fn(),
      scanIntervalMs: 1000
    })
    service.start('g1')
    service.stop('g1')
    expect(service.isRunning('g1')).toBe(false)
  })

  test('confirmSuggestedEdge clears suggested flag', () => {
    const updateEdge = vi.fn()
    const service = new GraphSyncService({
      graphService: {} as any,
      knowledgeAssociator: {} as any,
      pushSuggestedEdges: vi.fn(),
      updateEdge
    })
    service.confirmSuggestedEdge('e1')
    expect(updateEdge).toHaveBeenCalledWith('e1', expect.objectContaining({
      content: expect.objectContaining({ suggested: false })
    }))
  })

  test('rejectSuggestedEdge deletes the edge', () => {
    const deleteEdge = vi.fn()
    const service = new GraphSyncService({
      graphService: {} as any,
      knowledgeAssociator: {} as any,
      pushSuggestedEdges: vi.fn(),
      deleteEdge
    })
    service.rejectSuggestedEdge('e1')
    expect(deleteEdge).toHaveBeenCalledWith('e1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/services/__tests__/graph-sync-service.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 GraphSyncService**

```typescript
import type { GraphNode, GraphEdge } from '@shared/types'
import type { KnowledgeAssociator } from '../memory/knowledge-associator'
import { createLogger } from '../shared/logger'

const logger = createLogger('graph-sync-service')

export interface GraphSyncDeps {
  graphService: { getNodes(graphId: string): Promise<GraphNode[]>; getEdges(graphId: string): Promise<GraphEdge[]> }
  knowledgeAssociator: KnowledgeAssociator
  pushSuggestedEdges: (graphId: string, edges: Array<{ sourceId: string; targetId: string; edgeType: string; score: number }>) => void
  updateEdge?: (edgeId: string, data: Partial<GraphEdge>) => void
  deleteEdge?: (edgeId: string) => void
  scanIntervalMs?: number
}

export class GraphSyncService {
  private _deps: GraphSyncDeps
  private _timers = new Map<string, ReturnType<typeof setInterval>>()
  private _scanIntervalMs: number

  constructor(deps: GraphSyncDeps) {
    this._deps = deps
    this._scanIntervalMs = deps.scanIntervalMs ?? 30_000
  }

  start(graphId: string): void {
    if (this._timers.has(graphId)) return
    const timer = setInterval(() => this._runAssociationScan(graphId), this._scanIntervalMs)
    this._timers.set(graphId, timer)
    logger.info(`GraphSyncService started for graph ${graphId}`)
  }

  stop(graphId: string): void {
    const timer = this._timers.get(graphId)
    if (timer) {
      clearInterval(timer)
      this._timers.delete(graphId)
      logger.info(`GraphSyncService stopped for graph ${graphId}`)
    }
  }

  isRunning(graphId: string): boolean {
    return this._timers.has(graphId)
  }

  confirmSuggestedEdge(edgeId: string): void {
    this._deps.updateEdge?.(edgeId, { content: { suggested: false } } as Partial<GraphEdge>)
  }

  rejectSuggestedEdge(edgeId: string): void {
    this._deps.deleteEdge?.(edgeId)
  }

  private async _runAssociationScan(graphId: string): Promise<void> {
    try {
      const nodes = await this._deps.graphService.getNodes(graphId)
      const edges = await this._deps.graphService.getEdges(graphId)

      const dependencyEdges = edges
        .filter(e => e.edgeType === 'dependency' || e.edgeType === 'default')
        .map(e => ({ sourceId: e.source, targetId: e.target }))

      const coChangeFreqMap = new Map<string, number>()
      // 变更耦合频率由调用方注入，GraphSyncService 本身不直接访问 MemoryStore

      const associations = await this._deps.knowledgeAssociator.findAssociations(nodes, {
        dependencyEdges,
        coChangeFreqMap,
        threshold: 0.6
      })

      // 过滤已存在的边
      const existingPairs = new Set(edges.map(e => [e.source, e.target].sort().join(':')))
      const newAssociations = associations.filter(
        a => !existingPairs.has([a.sourceId, a.targetId].sort().join(':'))
      )

      if (newAssociations.length > 0) {
        this._deps.pushSuggestedEdges(graphId, newAssociations)
      }
    } catch (error) {
      logger.warn(`Association scan failed for graph ${graphId}:`, error)
    }
  }

  destroy(): void {
    for (const graphId of this._timers.keys()) {
      this.stop(graphId)
    }
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/services/__tests__/graph-sync-service.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/graph-sync-service.ts src/main/services/__tests__/graph-sync-service.test.ts
git commit -m "feat(graph): add GraphSyncService for bidirectional canvas-graph sync"
```

---

## Task 7: EventBus GENERATION_PROGRESS 事件 + graphStore suggested edges

**Files:**
- Modify: `src/renderer/store/eventBus.ts`
- Modify: `src/renderer/store/graphStore.ts`

- [ ] **Step 1: 增加 GENERATION_PROGRESS 事件**

在 `src/renderer/store/eventBus.ts` 的 `Events` 对象中增加:

```typescript
GENERATION_PROGRESS: 'generation:progress',
```

- [ ] **Step 2: graphStore 增加 suggested edges 处理**

在 `src/renderer/store/graphStore.ts` 中增加方法:

```typescript
addSuggestedEdges: (edges: Array<{ id: string; source: string; target: string; edgeType: EdgeType; strength: number; content: EdgeContent }>) => {
  set(state => {
    const newEdges = edges.filter(e => !state.edges.some(ex => ex.source === e.source && ex.target === e.target))
    return { edges: [...state.edges, ...newEdges.map(e => ({ ...e, graphId: state.currentGraphId ?? '', label: '', id: e.id }))] }
  })
},

confirmSuggestedEdge: (edgeId: string) => {
  set(state => ({
    edges: state.edges.map(e =>
      e.id === edgeId && e.content?.suggested
        ? { ...e, content: { ...e.content, suggested: false } }
        : e
    )
  }))
  const edge = get().edges.find(e => e.id === edgeId)
  if (edge) {
    window.api.updateEdge(edgeId, { content: { ...edge.content, suggested: false } })
  }
},

rejectSuggestedEdge: (edgeId: string) => {
  set(state => ({ edges: state.edges.filter(e => e.id !== edgeId) }))
  window.api.deleteEdge(edgeId)
},

clearPreviewNodes: () => {
  const previewIds = get().nodes.filter(n => n.metadata?.preview).map(n => n.id)
  previewIds.forEach(id => window.api.deleteNode(id))
  set(state => ({ nodes: state.nodes.filter(n => !n.metadata?.preview) }))
},
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/eventBus.ts src/renderer/store/graphStore.ts
git commit -m "feat(renderer): add GENERATION_PROGRESS event, suggested edges and preview nodes to graphStore"
```

---

## Task 8: AdapterCapability 枚举 + registry 扩展

**Files:**
- Modify: `src/shared/types/agent.ts`
- Modify: `src/main/adapters/registry.ts`

- [ ] **Step 1: 增加 AdapterCapability 枚举**

在 `src/shared/types/agent.ts` 中增加:

```typescript
export enum AdapterCapability {
  Resume = 'resume',
  Streaming = 'streaming',
  FileOps = 'fileOps',
  MultiTurn = 'multiTurn',
  ScopeGuard = 'scopeGuard',
  Tools = 'tools',
}
```

- [ ] **Step 2: 扩展 AdapterDescriptor**

在 `src/main/adapters/registry.ts` 的 `AdapterDescriptor` 接口中增加:

```typescript
export interface AdapterDescriptor {
  name: string
  displayName: string
  description: string
  type: 'cli' | 'sdk' | 'api'
  installMethods: InstallMethod[]
  detectCommand?: string
  detectArgs?: string[]
  sdkPackage?: string
  adapterClass: new () => BaseAdapter
  homepage: string
  hidden?: boolean
  capabilities?: AdapterCapability[]
  fallbackTo?: string
  platforms?: NodeJS.Platform[]
}
```

- [ ] **Step 3: 为现有适配器声明 capabilities 和 fallbackTo**

在 `ADAPTER_REGISTRY` 数组中为每个适配器增加 capabilities 和 fallbackTo:

```typescript
// claude-code
capabilities: [AdapterCapability.Resume, AdapterCapability.Streaming, AdapterCapability.FileOps, AdapterCapability.MultiTurn, AdapterCapability.ScopeGuard, AdapterCapability.Tools],
fallbackTo: 'mcp',

// codex
capabilities: [AdapterCapability.Streaming, AdapterCapability.FileOps, AdapterCapability.MultiTurn],
fallbackTo: 'mcp',

// opencode (cli)
capabilities: [AdapterCapability.Streaming, AdapterCapability.FileOps],
fallbackTo: 'mcp',

// mcp
capabilities: [AdapterCapability.Streaming, AdapterCapability.Tools],

// mindmap-internal
capabilities: [],
```

其他 CLI 适配器（cline, kilo-code, kimi-code, codebuddy, qoder, qwen-code, cursor）:
```typescript
capabilities: [AdapterCapability.Streaming, AdapterCapability.FileOps],
fallbackTo: 'mcp',
```

- [ ] **Step 4: 平台预过滤**

在 `ADAPTER_REGISTRY` 导出后增加过滤函数:

```typescript
export function getFilteredRegistry(): AdapterDescriptor[] {
  const platform = process.platform
  return ADAPTER_REGISTRY.filter(d => {
    if (!d.platforms) return true
    return d.platforms.includes(platform)
  })
}
```

- [ ] **Step 5: 运行类型检查**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/agent.ts src/main/adapters/registry.ts
git commit -m "feat(adapter): add AdapterCapability enum, capabilities/fallbackTo/platforms to descriptors"
```

---

## Task 9: AdapterCircuitBreaker 独立类

**Files:**
- Create: `src/main/adapters/circuit-breaker.ts`
- Create: `src/main/adapters/__tests__/circuit-breaker.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, vi } from 'vitest'
import { AdapterCircuitBreaker } from '../circuit-breaker'

describe('AdapterCircuitBreaker', () => {
  test('starts in closed state', () => {
    const cb = new AdapterCircuitBreaker()
    expect(cb.getState('test')).toBe('closed')
    expect(cb.isCircuitOpen('test')).toBe(false)
  })

  test('opens after failure threshold', () => {
    const cb = new AdapterCircuitBreaker({ failureThreshold: 3, openDurationMs: 30000 })
    cb.recordFailure('test')
    cb.recordFailure('test')
    cb.recordFailure('test')
    expect(cb.getState('test')).toBe('open')
    expect(cb.isCircuitOpen('test')).toBe(true)
  })

  test('transitions to half-open after cooldown', () => {
    vi.useFakeTimers()
    const cb = new AdapterCircuitBreaker({ failureThreshold: 2, openDurationMs: 5000 })
    cb.recordFailure('test')
    cb.recordFailure('test')
    expect(cb.getState('test')).toBe('open')
    vi.advanceTimersByTime(5001)
    expect(cb.getState('test')).toBe('half-open')
    expect(cb.isCircuitOpen('test')).toBe(false)
    vi.useRealTimers()
  })

  test('closes after success in half-open', () => {
    const cb = new AdapterCircuitBreaker({ failureThreshold: 2, openDurationMs: 1000 })
    cb.recordFailure('test')
    cb.recordFailure('test')
    // Force to half-open for test
    cb['_states'].get('test')!.state = 'half-open'
    cb.recordSuccess('test')
    expect(cb.getState('test')).toBe('closed')
  })

  test('re-opens on failure in half-open', () => {
    const cb = new AdapterCircuitBreaker({ failureThreshold: 2, openDurationMs: 1000 })
    cb.recordFailure('test')
    cb.recordFailure('test')
    cb['_states'].get('test')!.state = 'half-open'
    cb.recordFailure('test')
    expect(cb.getState('test')).toBe('open')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/adapters/__tests__/circuit-breaker.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 AdapterCircuitBreaker**

```typescript
import { createLogger } from '../shared/logger'

const logger = createLogger('circuit-breaker')

export interface CircuitBreakerConfig {
  failureThreshold?: number
  openDurationMs?: number
}

interface CircuitState {
  state: 'closed' | 'open' | 'half-open'
  failures: number
  lastFailureTime: number
}

export class AdapterCircuitBreaker {
  private _states = new Map<string, CircuitState>()
  private _failureThreshold: number
  private _openDurationMs: number

  constructor(config: CircuitBreakerConfig = {}) {
    this._failureThreshold = config.failureThreshold ?? 3
    this._openDurationMs = config.openDurationMs ?? 30_000
  }

  isCircuitOpen(key: string): boolean {
    const entry = this._getOrCreate(key)
    if (entry.state === 'open') {
      if (Date.now() - entry.lastFailureTime > this._openDurationMs) {
        entry.state = 'half-open'
        logger.info(`Circuit breaker for ${key} transitioned to half-open`)
        return false
      }
      return true
    }
    return false
  }

  getState(key: string): 'closed' | 'open' | 'half-open' {
    const entry = this._getOrCreate(key)
    if (entry.state === 'open' && Date.now() - entry.lastFailureTime > this._openDurationMs) {
      entry.state = 'half-open'
    }
    return entry.state
  }

  recordSuccess(key: string): void {
    const entry = this._getOrCreate(key)
    if (entry.state === 'half-open') {
      entry.state = 'closed'
      entry.failures = 0
      logger.info(`Circuit breaker for ${key} closed after successful half-open request`)
    } else if (entry.state === 'closed') {
      entry.failures = 0
    }
  }

  recordFailure(key: string): void {
    const entry = this._getOrCreate(key)
    entry.failures++
    entry.lastFailureTime = Date.now()

    if (entry.state === 'half-open') {
      entry.state = 'open'
      logger.warn(`Circuit breaker for ${key} re-opened after failure in half-open`)
    } else if (entry.failures >= this._failureThreshold) {
      entry.state = 'open'
      logger.warn(`Circuit breaker for ${key} opened after ${entry.failures} failures`)
    }
  }

  reset(key: string): void {
    this._states.delete(key)
  }

  private _getOrCreate(key: string): CircuitState {
    let entry = this._states.get(key)
    if (!entry) {
      entry = { state: 'closed', failures: 0, lastFailureTime: 0 }
      this._states.set(key, entry)
    }
    return entry
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/adapters/__tests__/circuit-breaker.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/circuit-breaker.ts src/main/adapters/__tests__/circuit-breaker.test.ts
git commit -m "feat(adapter): add AdapterCircuitBreaker as standalone reusable class"
```

---

## Task 10: RequestQueue 请求编排

**Files:**
- Create: `src/main/agent/request-queue.ts`
- Create: `src/main/agent/__tests__/request-queue.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, vi } from 'vitest'
import { RequestQueue, RequestPriority } from '../request-queue'

describe('RequestQueue', () => {
  test('enqueues and processes requests in order', async () => {
    const processed: string[] = []
    const queue = new RequestQueue({
      maxConcurrent: 1,
      executor: async (req) => { processed.push(req.id); return { success: true } }
    })
    queue.enqueue({ id: 'r1', adapterName: 'claude-code', command: 'cmd1', priority: RequestPriority.User })
    queue.enqueue({ id: 'r2', adapterName: 'claude-code', command: 'cmd2', priority: RequestPriority.User })
    await queue.drain()
    expect(processed).toEqual(['r1', 'r2'])
  })

  test('respects maxConcurrent per adapter', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const queue = new RequestQueue({
      maxConcurrent: 1,
      executor: async (req) => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise(r => setTimeout(r, 50))
        concurrent--
        return { success: true }
      }
    })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'c', priority: RequestPriority.User })
    queue.enqueue({ id: 'r2', adapterName: 'a', command: 'c', priority: RequestPriority.User })
    await queue.drain()
    expect(maxConcurrent).toBe(1)
  })

  test('deduplicates same nodeId+command within 30s', () => {
    const queue = new RequestQueue({ maxConcurrent: 1, executor: async () => ({ success: true }) })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'fix auth', nodeId: 'n1', priority: RequestPriority.User })
    const added = queue.enqueue({ id: 'r2', adapterName: 'a', command: 'fix auth', nodeId: 'n1', priority: RequestPriority.User })
    expect(added).toBe(false) // deduplicated
  })

  test('higher priority jumps ahead', () => {
    const queue = new RequestQueue({ maxConcurrent: 1, executor: async () => ({ success: true }) })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'c1', priority: RequestPriority.System })
    queue.enqueue({ id: 'r2', adapterName: 'a', command: 'c2', priority: RequestPriority.User })
    const next = queue.peekNext('a')
    expect(next?.id).toBe('r2') // User priority > System
  })

  test('cancel removes queued request', () => {
    const queue = new RequestQueue({ maxConcurrent: 1, executor: async () => ({ success: true }) })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'c', priority: RequestPriority.User })
    const cancelled = queue.cancel('r1')
    expect(cancelled).toBe(true)
    expect(queue.size()).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/agent/__tests__/request-queue.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 RequestQueue**

```typescript
import { createLogger } from '../shared/logger'

const logger = createLogger('request-queue')

export enum RequestPriority {
  System = 0,
  Retry = 1,
  User = 2,
}

export interface QueueRequest {
  id: string
  adapterName: string
  command: string
  nodeId?: string
  priority: RequestPriority
  enqueuedAt?: number
  abortController?: AbortController
}

export interface QueueResult {
  success: boolean
  error?: Error
}

export interface RequestQueueConfig {
  maxConcurrent: number
  executor: (req: QueueRequest) => Promise<QueueResult>
  dedupWindowMs?: number
}

interface QueuedItem {
  request: QueueRequest
  status: 'queued' | 'executing'
}

export class RequestQueue {
  private _queues = new Map<string, QueuedItem[]>()  // adapterName → items
  private _activeCount = new Map<string, number>()
  private _config: RequestQueueConfig
  private _dedupMap = new Map<string, number>()  // key → timestamp
  private _dedupWindowMs: number

  constructor(config: RequestQueueConfig) {
    this._config = config
    this._dedupWindowMs = config.dedupWindowMs ?? 30_000
  }

  enqueue(req: QueueRequest): boolean {
    // Dedup check
    if (req.nodeId) {
      const dedupKey = `${req.nodeId}:${req.command}`
      const lastTime = this._dedupMap.get(dedupKey)
      if (lastTime && Date.now() - lastTime < this._dedupWindowMs) {
        logger.debug(`Dedup: skipping ${req.id} (same nodeId+command within ${this._dedupWindowMs}ms)`)
        return false
      }
      this._dedupMap.set(dedupKey, Date.now())
    }

    const item: QueuedItem = {
      request: { ...req, enqueuedAt: Date.now(), abortController: req.abortController ?? new AbortController() },
      status: 'queued'
    }

    const queue = this._getQueue(req.adapterName)
    queue.push(item)
    // Sort by priority desc
    queue.sort((a, b) => b.request.priority - a.request.priority)

    return true
  }

  peekNext(adapterName: string): QueueRequest | undefined {
    const queue = this._getQueue(adapterName)
    return queue.find(i => i.status === 'queued')?.request
  }

  async drain(): Promise<void> {
    const allAdapters = Array.from(this._queues.keys())
    await Promise.all(allAdapters.map(a => this._drainAdapter(a)))
  }

  cancel(requestId: string): boolean {
    for (const [, queue] of this._queues) {
      const idx = queue.findIndex(i => i.request.id === requestId && i.status === 'queued')
      if (idx !== -1) {
        queue.splice(idx, 1)
        return true
      }
    }
    return false
  }

  size(): number {
    let total = 0
    for (const queue of this._queues.values()) {
      total += queue.filter(i => i.status === 'queued').length
    }
    return total
  }

  private _getQueue(adapterName: string): QueuedItem[] {
    let queue = this._queues.get(adapterName)
    if (!queue) {
      queue = []
      this._queues.set(adapterName, queue)
    }
    return queue
  }

  private async _drainAdapter(adapterName: string): Promise<void> {
    const queue = this._getQueue(adapterName)
    const maxConcurrent = this._config.maxConcurrent
    let active = 0

    while (queue.some(i => i.status === 'queued')) {
      if (active >= maxConcurrent) break

      const next = queue.find(i => i.status === 'queued')
      if (!next) break

      next.status = 'executing'
      active++

      try {
        await this._config.executor(next.request)
      } catch (error) {
        logger.warn(`Request ${next.request.id} failed:`, error)
      } finally {
        active--
        const idx = queue.indexOf(next)
        if (idx !== -1) queue.splice(idx, 1)
      }
    }
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/agent/__tests__/request-queue.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/request-queue.ts src/main/agent/__tests__/request-queue.test.ts
git commit -m "feat(agent): add RequestQueue with priority, dedup, and concurrency control"
```

---

## Task 11: AdapterRegistry 并行检测 + 缓存

**Files:**
- Modify: `src/main/agent/adapter-registry.ts`

- [ ] **Step 1: 改 checkAllInstalled 为并行 + 缓存**

替换 `src/main/agent/adapter-registry.ts` 中的 `checkAllInstalled` 方法:

```typescript
export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()
  private _installCache = new Map<string, { installed: boolean; checkedAt: number }>()
  private _cacheTtlMs = 5 * 60 * 1000  // 5 minutes

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.name)) {
      logger.warn(`Adapter '${adapter.name}' is already registered, overwriting with new instance`)
    }
    this.adapters.set(adapter.name, adapter)
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name)
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values())
  }

  async checkAllInstalled(): Promise<{ name: string; version: string; installed: boolean }[]> {
    const adapters = this.list()
    const now = Date.now()

    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const cached = this._installCache.get(adapter.name)
        if (cached && now - cached.checkedAt < this._cacheTtlMs) {
          return { name: adapter.name, version: adapter.version, installed: cached.installed }
        }
        const installed = await adapter.checkInstalled()
        this._installCache.set(adapter.name, { installed, checkedAt: now })
        return { name: adapter.name, version: adapter.version, installed }
      })
    )

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      return { name: adapters[i].name, version: adapters[i].version, installed: false }
    })
  }

  invalidateCache(adapterName?: string): void {
    if (adapterName) {
      this._installCache.delete(adapterName)
    } else {
      this._installCache.clear()
    }
  }
}
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/adapter-registry.ts
git commit -m "perf(adapter): parallel checkAllInstalled with 5-min result cache"
```

---

## Task 12: BaseAdapter 错误边界 + 超时常量

**Files:**
- Modify: `src/main/adapters/base.ts`

- [ ] **Step 1: 增加超时常量**

在 `src/main/adapters/base.ts` 的常量区域增加:

```typescript
static readonly CONNECTION_TIMEOUT_MS = 10_000
static readonly FIRST_BYTE_TIMEOUT_MS = 30_000
static readonly EXECUTION_TIMEOUT_MS = 5 * 60 * 1000
```

- [ ] **Step 2: doSendCommand 包裹错误边界**

在 `sendCommand` 公共方法中增加 try-catch（不是 doSendCommand，因为 doSendCommand 是 protected 且各 adapter 有自己的实现）:

```typescript
async sendCommand(sessionId: string, command: AgentCommand): Promise<void> {
  try {
    const session = this.sessions.get(sessionId)
    if (!session) throw new SessionNotFoundError(sessionId)
    await this.doSendCommand(session, command)
  } catch (error) {
    if (error instanceof SessionNotFoundError || error instanceof AdapterError) throw error
    const adapterError = new AdapterError(
      `Unexpected error in ${this.name}.sendCommand: ${(error as Error).message}`,
      { cause: error as Error }
    )
    this.emitOutput({ type: 'error', content: adapterError.message, timestamp: Date.now() })
    throw adapterError
  }
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/adapters/base.ts
git commit -m "feat(adapter): add error boundary to sendCommand and timeout constants"
```

---

## Task 13: AgentManager 接入 SessionRecovery + 动态降级 + RequestQueue

**Files:**
- Modify: `src/main/agent/agent-manager.ts`

- [ ] **Step 1: 在 sessionEnded 回调中接入 SessionRecoveryManager**

在 AgentManager 的 session 退出处理逻辑中，根据 exit code 分类处理:

```typescript
// 在 BaseAdapter createOutputHandlers.onExit 中已有 exit code 注释
// 在 AgentManager 中增加 sessionEnded 事件处理:
private async _handleSessionEnded(sessionId: string, exitCode: number | null, reason: string): Promise<void> {
  const state = this.sessionStates.get(sessionId)
  if (!state) return

  if (exitCode === 137 || exitCode === 143) {
    // 正常终止，不重试
    logger.info(`Session ${sessionId} terminated normally (exit ${exitCode})`)
    return
  }

  if (exitCode === 1 && reason === 'crash') {
    // 一般错误，尝试恢复
    const recovery = getSessionRecoveryManager()
    const outputs = this.sessionOutputBuffers.get(sessionId) ?? []
    const newSessionId = await recovery.attemptRecovery({
      sessionId,
      adapterName: state.adapterName,
      projectId: state.projectId,
      lastOutputs: outputs
    })
    if (newSessionId) {
      logger.info(`Session ${sessionId} recovered as ${newSessionId}`)
      // 通知 renderer
      this._statusChangeCallback?.(sessionId, 'running')
    }
    return
  }

  if (exitCode === 126 || exitCode === 127) {
    // 命令不可用，标记 adapter 不可用
    this.healthMonitor.recordCall(state.adapterName, false, 0, `Exit code ${exitCode}: adapter not available`)
    logger.warn(`Adapter ${state.adapterName} marked unavailable (exit ${exitCode})`)
    return
  }

  // 其他非零退出码
  logger.warn(`Session ${sessionId} exited with code ${exitCode}, reason: ${reason}`)
}
```

- [ ] **Step 2: startSession 中使用动态降级**

在 `startSession` 的 fallback 迭代中，优先使用 `getHealthiestAdapter`:

```typescript
// 在构建 fallback chain 后，尝试按健康度排序
const healthiest = this.healthMonitor.getHealthiestAdapter(chain)
if (healthiest && healthiest !== chain[0]) {
  // 将最健康的移到前面，但保留用户首选为第一（如果有 forceAdapter）
  if (!preferences.forceAdapter) {
    chain = [healthiest, ...chain.filter(n => n !== healthiest)]
  }
}
```

- [ ] **Step 3: 降级后自动恢复检测**

```typescript
private _startFallbackRecoveryCheck(preferredAdapter: string, intervalMs = 60_000): void {
  const timer = setInterval(async () => {
    const adapter = this.registry.get(preferredAdapter)
    if (!adapter) { clearInterval(timer); return }
    const installed = await adapter.checkInstalled()
    const health = this.healthMonitor.getHealth(preferredAdapter)
    if (installed && health && health.status === 'healthy') {
      logger.info(`Preferred adapter ${preferredAdapter} is healthy again`)
      clearInterval(timer)
      // 通知 renderer
      eventBus?.emit(Events.ADAPTER_HEALTH_CHANGE, { adapterName: preferredAdapter, status: 'healthy' })
    }
  }, intervalMs)
  // 最多检测5分钟
  setTimeout(() => clearInterval(timer), 5 * 60_000)
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/agent-manager.ts
git commit -m "feat(agent): integrate SessionRecovery, dynamic fallback, and health-based routing"
```

---

## Task 14: 前端 — CSS 变量统一 + 语义 token + 深色模式 + 微交互 token

**Files:**
- Modify: `src/renderer/index.css`
- Modify: `src/renderer/canvas/BizNode.tsx`
- Modify: `src/renderer/canvas/BizEdge.tsx`

- [ ] **Step 1: index.css 增加语义 token 和微交互 token**

在 `src/renderer/index.css` 的 `@theme` 块中增加:

```css
/* 语义 token */
--color-agent-running: hsl(var(--primary));
--color-bug-critical: hsl(0 84% 60%);
--color-node-placeholder: hsl(var(--muted));

/* 微交互 token */
--duration-fast: 100ms;
--duration-normal: 150ms;
--duration-slow: 200ms;

/* 主题切换过渡 */
transition: background-color var(--duration-slow), color var(--duration-slow);
```

在 `.dark` 选择器中增加 node status 颜色覆盖:

```css
.dark {
  /* ... 现有深色变量 ... */
  --color-bug-critical: hsl(0 72% 50%);
  --color-node-placeholder: hsl(var(--muted));
}
```

增加 `prefers-reduced-motion` 媒体查询:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 2: BizNode hex → CSS 变量**

在 `src/renderer/canvas/BizNode.tsx` 中，将硬编码的 `#94a3b8` 替换为 CSS 变量引用:

```typescript
// 替换 line 27:
const typeColor = NODE_TYPE_COLORS[data.type] ?? 'hsl(var(--muted-foreground))'
```

将 completed badge 的 setTimeout 改为 CSS transition:

```typescript
// 移除 showCompleted state + useEffect + setTimeout
// 改为 CSS class: completed 时加 class "animate-fade-out" (opacity 1→0, 3s delay)
```

在 `index.css` 中增加:

```css
@keyframes fade-out {
  from { opacity: 1 }
  to { opacity: 0 }
}
.animate-fade-out {
  animation: fade-out 0.3s ease-out 3s forwards;
}
```

- [ ] **Step 3: BizEdge hover 改 CSS-only**

在 `src/renderer/canvas/BizEdge.tsx` 中，移除 `useState(isHover)` 和 `onMouseEnter/onMouseLeave`，改为 CSS group hover:

```typescript
// 移除: const [isHover, setIsHover] = useState(false)
// 移除: onMouseEnter={() => setIsHover(true)} onMouseLeave={() => setIsHover(false)}
// 改为: 在外层 div 加 className="group"，hover 样式用 Tailwind group-hover: 伪类
```

- [ ] **Step 4: 运行类型检查**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.css src/renderer/canvas/BizNode.tsx src/renderer/canvas/BizEdge.tsx
git commit -m "feat(renderer): unify CSS variables, add semantic tokens, dark mode, prefers-reduced-motion"
```

---

## Task 15: 前端 — BizNode/BizEdge 动画 + GraphCanvas 拖拽/缩放优化

**Files:**
- Modify: `src/renderer/canvas/BizNode.tsx`
- Modify: `src/renderer/canvas/BizEdge.tsx`
- Modify: `src/renderer/canvas/GraphCanvas.tsx`

- [ ] **Step 1: BizNode 选中过渡**

在 BizNode 的外层 div style 中增加:

```typescript
style={{
  borderColor: selected ? typeColor : 'transparent',
  transition: `border-color var(--duration-normal), box-shadow var(--duration-normal), transform var(--duration-normal)`,
  transform: selected ? 'scale(1.02)' : 'scale(1)',
  boxShadow: selected ? `0 0 0 2px ${typeColor}40` : 'none',
}}
```

- [ ] **Step 2: BizEdge 连接线反馈**

在 BizEdge 中，当处于连接模式时（通过 ReactFlow 的 `connectionStatus` prop），目标节点加 `animate-pulse`:

```typescript
// 在 BizEdge 组件中，如果 data?.connecting 为 true，增加呼吸动画
const isConnecting = data?.connecting ?? false
// 在 BaseEdge style 中:
style={{
  stroke: strokeColor,
  strokeWidth: isConnecting ? strokeWidth + 1 : strokeWidth,
  transition: 'stroke 0.2s, stroke-width 0.2s',
  ...(isConnecting ? { animation: 'pulse 1.5s ease-in-out infinite' } : {})
}}
```

- [ ] **Step 3: GraphCanvas 拖拽/缩放优化**

在 `GraphCanvas.tsx` 中:

```typescript
// 拖拽中：给非选中节点加 pointer-events:none + opacity:0.6
// 通过 onNodesChange 回调检测 drag 事件
// 缩放中：viewport zoom < 0.5 时隐藏节点文本
// 通过 useOnViewportChange 追踪 zoom level
const [isZoomedOut, setIsZoomedOut] = useState(false)
useOnViewportChange({
  onChange: (viewport) => {
    setIsZoomedOut(viewport.zoom < 0.5)
  }
})
// 传递 isZoomedOut 到 BizNode，隐藏文本
```

- [ ] **Step 4: 运行类型检查**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/canvas/BizNode.tsx src/renderer/canvas/BizEdge.tsx src/renderer/canvas/GraphCanvas.tsx
git commit -m "feat(renderer): add node/edge animations, drag/zoom optimization"
```

---

## Task 16: 前端 — Chat 交互体验 (骨架屏 + 错误友好化 + seq 去重)

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`
- Modify: `src/renderer/store/messageStore.ts`

- [ ] **Step 1: messageStore seq 去重**

在 `src/renderer/store/messageStore.ts` 的 `appendStreamingMessage` 方法中增加序列号去重:

```typescript
// 增加 lastSeq Map
private _lastSeq = new Map<string, number>()

appendStreamingMessage(threadId: string, messageId: string, content: string, seq?: number): void {
  if (seq !== undefined) {
    const lastSeq = this._lastSeq.get(threadId) ?? -1
    if (seq <= lastSeq) return  // 丢弃乱序或重复
    this._lastSeq.set(threadId, seq)
  }
  // ... 现有逻辑
}
```

- [ ] **Step 2: AgentChatPanel 骨架屏**

在 `AgentChatPanel.tsx` 中，当 agent 状态为 running 时显示骨架动画:

```tsx
{isAgentRunning && (
  <div className="flex items-center gap-2 px-4 py-3">
    <div className="h-4 w-48 animate-pulse rounded bg-muted" />
    <span className="text-sm text-muted-foreground">Agent 正在思考...</span>
  </div>
)}
```

- [ ] **Step 3: 错误友好化映射**

增加错误消息映射函数:

```typescript
const FRIENDLY_ERROR_MESSAGES: Record<string, string> = {
  TIMEOUT: 'Agent 响应超时，请重试或检查网络连接',
  PERMISSION_DENIED: '当前适配器权限不足，请检查安装或切换适配器',
  AGENT_CRASH: 'Agent 进程异常退出，已自动保存进度',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  NOT_INSTALLED: '所选适配器未安装，请先完成安装配置',
}

function getFriendlyErrorMessage(errorCode?: string, rawMessage?: string): string {
  if (errorCode && FRIENDLY_ERROR_MESSAGES[errorCode]) {
    return FRIENDLY_ERROR_MESSAGES[errorCode]
  }
  return rawMessage ?? '发生未知错误'
}
```

- [ ] **Step 4: 降级提示条**

在 AgentChatPanel 中增加降级提示条:

```tsx
{isDegraded && (
  <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
    <AlertTriangle className="h-4 w-4" />
    <span>已从 {originalAdapter} 降级到 {currentAdapter}，部分功能不可用</span>
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx src/renderer/store/messageStore.ts
git commit -m "feat(renderer): add chat skeleton, friendly errors, seq dedup, degradation banner"
```

---

## Task 17: 前端 — React.lazy + manualChunks + 预加载

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `vite.config.ts`

- [ ] **Step 1: App.tsx React.lazy**

在 `src/renderer/App.tsx` 中，将重组件改为 lazy 加载:

```typescript
import { lazy, Suspense } from 'react'

const AgentChatPanel = lazy(() => import('./components/agent/AgentChatPanel').then(m => ({ default: m.AgentChatPanel })))
const DiffReviewPanel = lazy(() => import('./components/agent/DiffReviewPanel').then(m => ({ default: m.DiffReviewPanel })))
const VerificationPanel = lazy(() => import('./components/agent/VerificationPanel').then(m => ({ default: m.VerificationPanel })))

// Suspense fallback
const LazyFallback = () => (
  <div className="flex items-center justify-center p-4">
    <div className="h-6 w-48 animate-pulse rounded bg-muted" />
  </div>
)

// 使用:
<Suspense fallback={<LazyFallback />}>
  <AgentChatPanel ... />
</Suspense>
```

- [ ] **Step 2: vite.config.ts manualChunks**

在 `vite.config.ts` 的 build.rollupOptions 中增加:

```typescript
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'vendor-reactflow': ['@xyflow/react'],
        'vendor-lucide': ['lucide-react'],
        'vendor-xenova': ['@xenova/transformers'],
      }
    }
  }
}
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx vite.config.ts
git commit -m "perf(renderer): React.lazy for heavy components, vendor chunk splitting"
```

---

## Task 18: 前端 — 响应式布局 + 面板折叠 + localStorage 持久化

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/hooks/useResizablePanel.ts`
- Modify: `src/renderer/index.css`

- [ ] **Step 1: useResizablePanel localStorage 持久化**

在 `src/renderer/hooks/useResizablePanel.ts` 中增加 localStorage 持久化:

```typescript
const STORAGE_KEY_PREFIX = 'bizgraph:panel:'

export function useResizablePanel(options: UseResizablePanelOptions): UseResizablePanelResult {
  const storageKey = `${STORAGE_KEY_PREFIX}${options.direction}`
  const savedWidth = typeof window !== 'undefined'
    ? localStorage.getItem(storageKey)
    : null
  const initialWidth = savedWidth ? Number(savedWidth) : options.initialWidth

  // ... 现有逻辑 ...

  // 在 width 变化时保存
  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [width, storageKey])

  // ...
}
```

- [ ] **Step 2: index.css 响应式断点**

在 `src/renderer/index.css` 中增加断点变量:

```css
:root {
  --breakpoint-sm: 1024px;
  --breakpoint-md: 1280px;
  --breakpoint-lg: 1536px;
}
```

- [ ] **Step 3: App.tsx 响应式布局**

在 `src/renderer/App.tsx` 中增加窗口宽度检测和面板折叠:

```typescript
const [windowWidth, setWindowWidth] = useState(window.innerWidth)
useEffect(() => {
  const handler = () => setWindowWidth(window.innerWidth)
  window.addEventListener('resize', handler)
  return () => window.removeEventListener('resize', handler)
}, [])

const isSmallScreen = windowWidth < 1024
const isMediumScreen = windowWidth >= 1024 && windowWidth < 1280

// 小屏: Tab 式布局
// 中屏: 左面板折叠 + 右面板抽屉式
// 大屏: 三栏布局
```

- [ ] **Step 4: Resize divider 改进**

在 App.tsx 的 resize divider 中增加 grab cursor 和更宽的交互区域:

```tsx
<div
  className="group relative flex cursor-col-resize items-center justify-center"
  style={{ width: '3px' }}
  onMouseDown={startResize}
>
  <div className="h-full w-px bg-border group-hover:w-0.5 group-hover:bg-primary/50 transition-all" />
</div>
```

- [ ] **Step 5: 运行类型检查**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx src/renderer/hooks/useResizablePanel.ts src/renderer/index.css
git commit -m "feat(renderer): responsive layout with breakpoints, panel persistence, improved dividers"
```

---

## Task 19: graphStore 内部 Map 索引 + 消除 double-write

**Files:**
- Modify: `src/renderer/store/graphStore.ts`
- Modify: `src/renderer/canvas/GraphCanvas.tsx`

- [ ] **Step 1: graphStore 内部 Map 索引**

在 `src/renderer/store/graphStore.ts` 中增加内部索引:

```typescript
// 在 store 创建时增加计算索引
nodeIndex: () => new Map(get().nodes.map(n => [n.id, n])),
nodesByType: () => {
  const map = new Map<string, Set<string>>()
  for (const n of get().nodes) {
    let set = map.get(n.type)
    if (!set) { set = new Set(); map.set(n.type, set) }
    set.add(n.id)
  }
  return map
},
getNodeById: (id: string) => get().nodes.find(n => n.id === id),
getNodesByType: (type: string) => get().nodes.filter(n => n.type === type),
```

- [ ] **Step 2: 消除 GraphCanvas double-write**

在 `src/renderer/canvas/GraphCanvas.tsx` 中，将 `setRfNodes/setRfEdges` 从 useEffect 移到 useMemo 内直接返回:

```typescript
// 替换:
// const flowNodes = useMemo(...)
// useEffect(() => { setRfNodes(flowNodes) }, [flowNodes])

// 改为直接使用 flowNodes 作为 ReactFlow 的 nodes prop:
<ReactFlow
  nodes={flowNodes}
  edges={flowEdges}
  // ... 移除 useNodesState/useEdgesState，改用受控模式
/>
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/graphStore.ts src/renderer/canvas/GraphCanvas.tsx
git commit -m "perf(renderer): graphStore Map index, eliminate GraphCanvas double-write"
```

---

## Task 20: 最终验证

- [ ] **Step 1: 全量单元测试**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: 0 warnings, 0 errors

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "feat: complete Section 4-6 — knowledge graph, adapter system, frontend UX optimization"
```
