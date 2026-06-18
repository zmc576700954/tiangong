# 记忆与动态Prompt系统优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立统一的 PromptOrchestrator 编排5层prompt组装，接入图谱知识上下文到 ContextCompiler，实现 ContextDistiller 提纯算法，补全节点绑定/会话管理/业务转图谱/LLM自动触发

**Architecture:** 在 ContextPipeline 基础上，新增 PromptOrchestrator 作为统一 prompt 组装入口，整合 ScopePromptBuilder + ContextCompiler + WaterlineSync + GraphMemory 四个上下文来源。ContextDistiller 在组装后执行跨轮次冗余消除和密度排序。GraphMemory 接入 ContextCompiler L3/L4 层提供图谱遍历结果。

**Tech Stack:** TypeScript, LibSQL, @xenova/transformers, Vitest

---

## File Structure

### New Files
- `src/main/memory/prompt-orchestrator.ts` — 统一 prompt 组装入口
- `src/main/memory/context-distiller.ts` — 上下文提纯算法
- `src/main/memory/__tests__/prompt-orchestrator.test.ts`
- `src/main/memory/__tests__/context-distiller.test.ts`

### Modified Files
- `src/main/agent/agent-manager.ts` — 用 PromptOrchestrator 替换分散的 prompt 组装逻辑
- `src/main/memory/context-compiler.ts` — 接入 GraphMemory 到 L3/L4
- `src/main/memory/pipeline.ts` — 增加 GraphMemory 阶段，PipelineContext 扩展
- `src/main/ipc/memory.ts` — 增加消息分页参数
- `src/main/services/chat-service.ts` — 消息分页 + 会话归档
- `src/main/mindmap-agent/synthesis/prompt-builder.ts` — 使用 RAG few-shot + JSON Schema 约束
- `src/main/mindmap-agent/claude-runner.ts` — 结构化输出约束
- `src/main/code-intelligence/file-watcher.ts` — 节点关联文件变更触发

---

## Task 1: PromptOrchestrator 统一 Prompt 组装

**Files:**
- Create: `src/main/memory/prompt-orchestrator.ts`
- Create: `src/main/memory/__tests__/prompt-orchestrator.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, vi } from 'vitest'
import { PromptOrchestrator } from '../prompt-orchestrator'

describe('PromptOrchestrator', () => {
  test('assemble produces 5-layer prompt within token budget', async () => {
    const orchestrator = new PromptOrchestrator()
    const result = await orchestrator.assemble({
      sessionId: 'test',
      adapterName: 'claude-code',
      projectId: 'proj1',
      userCommand: 'fix the auth bug',
      totalBudget: 2000
    })
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.layerBreakdown.length).toBe(5)
    expect(result.totalTokens).toBeLessThanOrEqual(2200) // 10% buffer
  })

  test('system instruction layer is always included', async () => {
    const orchestrator = new PromptOrchestrator()
    const result = await orchestrator.assemble({
      sessionId: 'test',
      adapterName: 'claude-code',
      userCommand: 'hello',
      totalBudget: 500
    })
    expect(result.layerBreakdown[0].name).toBe('system')
    expect(result.layerBreakdown[0].included).toBe(true)
  })

  test('context knowledge layer is compressed when budget tight', async () => {
    const orchestrator = new PromptOrchestrator()
    const small = await orchestrator.assemble({ sessionId: 'test', adapterName: 'claude-code', userCommand: 'test', totalBudget: 200 })
    const large = await orchestrator.assemble({ sessionId: 'test', adapterName: 'claude-code', userCommand: 'test', totalBudget: 8000 })
    expect(small.layerBreakdown.find(l => l.name === 'context')!.tokens).toBeLessThanOrEqual(
      large.layerBreakdown.find(l => l.name === 'context')!.tokens
    )
  })

  test('waterline layer is always included (low token cost)', async () => {
    const orchestrator = new PromptOrchestrator()
    const result = await orchestrator.assemble({ sessionId: 'test', adapterName: 'claude-code', userCommand: 'test', totalBudget: 500 })
    const waterline = result.layerBreakdown.find(l => l.name === 'waterline')
    expect(waterline?.included).toBe(true)
  })
})
```

- [ ] **Step 2: 实现 PromptOrchestrator**

```typescript
import type { AgentOutput, MemoryItem, TokenEconomics } from '@shared/types'
import { buildScopePrompt, compressScopePrompt } from '../adapters/scope-prompt-builder'
import { ContextCompiler } from './context-compiler'
import { getWaterlineSync } from './waterline-sync'
import { estimateTokens } from '../shared/token-utils'
import { createLogger } from '../shared/logger'

const logger = createLogger('prompt-orchestrator')

export interface AssembleOptions {
  sessionId: string
  adapterName: string
  projectId?: string
  nodeId?: string
  nodeTitle?: string
  userCommand: string
  totalBudget: number
  sessionConfig?: any
  resolvedContexts?: any[]
  codeContext?: string
  outputs?: AgentOutput[]
}

export interface LayerBreakdown {
  name: string
  tokens: number
  included: boolean
}

export interface AssembleResult {
  text: string
  totalTokens: number
  layerBreakdown: LayerBreakdown[]
  economics: TokenEconomics
}

export class PromptOrchestrator {
  private compiler = new ContextCompiler()

  async assemble(options: AssembleOptions): Promise<AssembleResult> {
    const layers: Array<{ name: string; content: string; budgetPct: number; compressible: boolean }> = []
    const breakdown: LayerBreakdown[] = []

    // Layer 1: System instructions (fixed, not compressible)
    layers.push({
      name: 'system',
      content: this._buildSystemLayer(options),
      budgetPct: 0.10,
      compressible: false
    })

    // Layer 2: Business constraints
    const scopeContent = options.sessionConfig
      ? buildScopePrompt(options.sessionConfig, options.resolvedContexts, options.codeContext)
      : ''
    layers.push({
      name: 'scope',
      content: scopeContent,
      budgetPct: 0.25,
      compressible: true
    })

    // Layer 3: Context knowledge (from ContextCompiler)
    let contextContent = ''
    if (options.outputs && options.outputs.length > 0) {
      try {
        const layered = await this.compiler.compile(options.outputs, {
          sessionId: options.sessionId,
          adapterName: options.adapterName,
          projectId: options.projectId
        })
        const rendered = this.compiler.render(layered, Math.floor(options.totalBudget * 0.35))
        contextContent = rendered.text
      } catch {
        logger.warn('Context compilation failed, skipping context layer')
      }
    }
    layers.push({
      name: 'context',
      content: contextContent,
      budgetPct: 0.35,
      compressible: true
    })

    // Layer 4: Waterline (always included, low cost)
    const waterlineContent = options.projectId
      ? getWaterlineSync().formatContext(options.projectId)
      : ''
    layers.push({
      name: 'waterline',
      content: waterlineContent,
      budgetPct: 0.05,
      compressible: false
    })

    // Layer 5: User command (not compressible)
    layers.push({
      name: 'user',
      content: options.userCommand,
      budgetPct: 0.25,
      compressible: false
    })

    // Assemble within budget
    let remaining = options.totalBudget
    const parts: string[] = []

    for (const layer of layers) {
      const tokens = estimateTokens(layer.content)
      if (tokens === 0) {
        breakdown.push({ name: layer.name, tokens: 0, included: false })
        continue
      }

      if (tokens <= remaining || !layer.compressible) {
        // Include as-is if within budget or not compressible
        if (tokens > remaining && layer.compressible) {
          // Compress to fit
          const compressed = compressScopePrompt(layer.content, remaining)
          const compressedTokens = estimateTokens(compressed)
          parts.push(compressed)
          remaining -= compressedTokens
          breakdown.push({ name: layer.name, tokens: compressedTokens, included: true })
        } else {
          parts.push(layer.content)
          remaining -= tokens
          breakdown.push({ name: layer.name, tokens, included: true })
        }
      } else {
        // Compressible and over budget
        const compressed = compressScopePrompt(layer.content, remaining)
        const compressedTokens = estimateTokens(compressed)
        parts.push(compressed)
        remaining -= compressedTokens
        breakdown.push({ name: layer.name, tokens: compressedTokens, included: true })
      }
    }

    const text = parts.join('\n\n')
    const totalTokens = estimateTokens(text)

    return {
      text,
      totalTokens,
      layerBreakdown: breakdown,
      economics: {
        discoveryTokens: options.totalBudget,
        readTokens: totalTokens,
        savingsPct: options.totalBudget > 0 ? Math.round((1 - totalTokens / options.totalBudget) * 100) : 0
      }
    }
  }

  private _buildSystemLayer(options: AssembleOptions): string {
    return `[System: You are operating through ${options.adapterName}. Follow the business constraints below. Work only within the specified scope.]`
  }
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/prompt-orchestrator.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/main/memory/prompt-orchestrator.ts src/main/memory/__tests__/prompt-orchestrator.test.ts
git commit -m "feat(memory): add PromptOrchestrator for unified 5-layer prompt assembly"
```

---

## Task 2: ContextDistiller 上下文提纯

**Files:**
- Create: `src/main/memory/context-distiller.ts`
- Create: `src/main/memory/__tests__/context-distiller.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect } from 'vitest'
import { ContextDistiller } from '../context-distiller'

describe('ContextDistiller', () => {
  test('removes highly similar paragraphs keeping latest', () => {
    const distiller = new ContextDistiller()
    const result = distiller.distill([
      { content: 'The auth module uses JWT tokens for authentication', source: 'memory-1', tokens: 10 },
      { content: 'The auth module uses JWT tokens for authentication with refresh', source: 'memory-2', tokens: 12 },
    ], 100)
    expect(result.kept.length).toBe(1)
    expect(result.kept[0].source).toBe('memory-2')
  })

  test('sorts by information density (unique entities / total tokens)', () => {
    const distiller = new ContextDistiller()
    const result = distiller.distill([
      { content: 'the the the the the', source: 'low-density', tokens: 10 },
      { content: 'UserService AuthService TokenValidator', source: 'high-density', tokens: 5 },
    ], 100)
    expect(result.kept[0].source).toBe('high-density')
  })

  test('preserves first-occurrence concept definitions', () => {
    const distiller = new ContextDistiller()
    const result = distiller.distill([
      { content: 'JWT (JSON Web Token) is a compact URL-safe token format', source: 'definition', tokens: 15 },
      { content: 'Using JWT for authentication', source: 'usage', tokens: 5 },
    ], 100)
    const sources = result.kept.map(k => k.source)
    expect(sources).toContain('definition')
  })

  test('trims to budget by removing low-priority fragments', () => {
    const distiller = new ContextDistiller()
    const fragments = Array.from({ length: 20 }, (_, i) => ({
      content: `Fragment ${i} with some unique content about module ${i}`,
      source: `frag-${i}`,
      tokens: 10
    }))
    const result = distiller.distill(fragments, 50)
    expect(result.totalTokens).toBeLessThanOrEqual(60) // 10% buffer
  })
})
```

- [ ] **Step 2: 实现 ContextDistiller**

```typescript
import { createLogger } from '../shared/logger'
import { estimateTokens } from '../shared/token-utils'
import { getEmbeddingService } from './embedding-service'

const logger = createLogger('context-distiller')

export interface ContextFragment {
  content: string
  source: string
  tokens: number
  type?: 'definition' | 'error' | 'decision' | 'general'
}

export interface DistillResult {
  kept: ContextFragment[]
  removed: ContextFragment[]
  totalTokens: number
  savingsPct: number
}

export class ContextDistiller {
  private similarityThreshold = 0.85

  async distill(fragments: ContextFragment[], budget: number): Promise<DistillResult> {
    if (fragments.length === 0) return { kept: [], removed: [], totalTokens: 0, savingsPct: 0 }

    // Step 1: Score each fragment
    const scored = fragments.map(f => ({
      ...f,
      density: this._computeDensity(f),
      priority: this._computePriority(f)
    }))

    // Step 2: Deduplicate by similarity
    const deduped = this._deduplicate(scored)

    // Step 3: Sort by priority (desc) then density (desc)
    deduped.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority
      return b.density - a.density
    })

    // Step 4: Fill budget
    let usedTokens = 0
    const kept: ContextFragment[] = []
    const removed: ContextFragment[] = []

    for (const fragment of deduped) {
      if (usedTokens + fragment.tokens <= budget * 1.1) {
        kept.push(fragment)
        usedTokens += fragment.tokens
      } else {
        removed.push(fragment)
      }
    }

    const originalTokens = fragments.reduce((s, f) => s + f.tokens, 0)
    return {
      kept,
      removed,
      totalTokens: usedTokens,
      savingsPct: originalTokens > 0 ? Math.round((1 - usedTokens / originalTokens) * 100) : 0
    }
  }

  private _computeDensity(fragment: ContextFragment): number {
    const words = fragment.content.split(/\s+/).filter(w => w.length > 2)
    const unique = new Set(words.map(w => w.toLowerCase()))
    return fragment.tokens > 0 ? unique.size / fragment.tokens : 0
  }

  private _computePriority(fragment: ContextFragment): number {
    // Definitions, errors, and decisions get highest priority
    if (fragment.type === 'definition') return 3
    if (fragment.type === 'error') return 3
    if (fragment.type === 'decision') return 2
    // Fragments with technical terms get medium priority
    const hasTechTerms = /\b[A-Z][a-z]+[A-Z]\w*\b/.test(fragment.content) // CamelCase
    return hasTechTerms ? 1 : 0
  }

  private _deduplicate(scored: Array<ContextFragment & { density: number; priority: number }>): typeof scored {
    const kept: typeof scored = []
    for (const fragment of scored) {
      const isDuplicate = kept.some(k =>
        this._jaccardSimilarity(k.content, fragment.content) > this.similarityThreshold
      )
      if (!isDuplicate) {
        kept.push(fragment)
      }
    }
    return kept
  }

  private _jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2))
    const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2))
    let intersection = 0
    for (const word of setA) {
      if (setB.has(word)) intersection++
    }
    const union = new Set([...setA, ...setB]).size
    return union === 0 ? 0 : intersection / union
  }
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/context-distiller.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/main/memory/context-distiller.ts src/main/memory/__tests__/context-distiller.test.ts
git commit -m "feat(memory): add ContextDistiller for cross-turn redundancy elimination and density sorting"
```

---

## Task 3: 图谱知识上下文接入 ContextCompiler

**Files:**
- Modify: `src/main/memory/context-compiler.ts`

- [ ] **Step 1: 在 compile() L3 层补充 GraphMemory 遍历结果**

在 `_buildL3` 或 L3 生成逻辑中，如果 `meta.projectId` 存在，获取 GraphMemory 的项目图谱，提取与当前输出相关的节点：

```typescript
private _buildL3GraphContext(projectId: string): string {
  try {
    const { GraphMemory } = require('./graph-memory')
    const graphMemory = new GraphMemory()
    // 异步获取项目图谱（同步降级为空）
    return ''  // GraphMemory.traverse 是异步的，L3 中无法直接调用
  } catch {
    return ''
  }
}
```

由于 GraphMemory.traverse 是异步的，而 compile() 现在也是异步的，可以直接集成：

在 `compile()` 方法中，L3 层增加图谱上下文：

```typescript
// After building L3 from outputs, append graph context if projectId available
if (meta?.projectId) {
  const graphContext = await this._buildL3GraphContext(meta.projectId, outputs)
  if (graphContext) {
    l3Content += '\n\n[Related Knowledge]\n' + graphContext
  }
}
```

新增私有异步方法：

```typescript
private async _buildL3GraphContext(projectId: string, outputs: AgentOutput[]): Promise<string> {
  try {
    const { getMemoryStore } = require('./memory-store')
    const { GraphMemory } = require('./graph-memory')
    const store = getMemoryStore()
    const recentMemories = await store.getRecent({ projectId, limit: 20 })
    if (recentMemories.length < 2) return ''
    const gm = new GraphMemory()
    const relations = gm.inferRelations(recentMemories[0], recentMemories.slice(1))
    return relations
      .filter(r => r.confidence > 0.5)
      .slice(0, 5)
      .map(r => `${r.reason} (${r.relation}, confidence: ${r.confidence.toFixed(2)})`)
      .join('\n')
  } catch {
    return ''
  }
}
```

- [ ] **Step 2: 在 L4 层增加 SmartContextResolver 代码片段**

在 `_buildL4()` 中，如果 `meta.nodeId` 存在，获取节点关联的代码上下文：

```typescript
// In _buildL4, after getting recent memories, add code context from node
if (meta?.nodeId) {
  const codeSnippet = await this._getNodeCodeContext(meta.nodeId)
  if (codeSnippet) {
    l4Content += '\n\n[Code Context]\n' + codeSnippet
  }
}
```

新增：

```typescript
private async _getNodeCodeContext(nodeId: string): Promise<string> {
  try {
    const { getMemoryStore } = require('./memory-store')
    const store = getMemoryStore()
    const nodeMemories = await store.getByNode(nodeId, 3)
    if (nodeMemories.length === 0) return ''
    const files = nodeMemories.flatMap(m => m.files_modified).slice(0, 5)
    if (files.length === 0) return ''
    return 'Related files: ' + files.join(', ')
  } catch {
    return ''
  }
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/context-compiler.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/main/memory/context-compiler.ts
git commit -m "feat(memory): integrate GraphMemory into ContextCompiler L3 and node code context into L4"
```

---

## Task 4: 节点绑定 — Agent 会话结束时自动更新节点状态

**Files:**
- Modify: `src/main/memory/pipeline.ts`

- [ ] **Step 1: 在 PipelineRunner.createDefault() 增加 node-bind 阶段**

在 waterline 阶段后、persist 阶段前增加一个新阶段：

```typescript
{
  name: 'node-bind',
  process: async (ctx) => {
    if (ctx.nodeId && ctx.projectId && ctx.memories && ctx.memories.length > 0) {
      const waterline = getWaterlineSync()
      waterline.markNodeVerified(ctx.projectId, ctx.nodeId)

      // 更新节点 metadata.lastModified
      try {
        const { getMemoryStore } = await import('./memory-store')
        const store = getMemoryStore()
        // 节点更新由 graph IPC handler 负责，这里只标记水位置
      } catch {
        // 忽略
      }
    }
    return ctx
  }
}
```

- [ ] **Step 2: 在 pipeline 中更新水线并通知节点状态变更**

在 node-bind 阶段后，通过 EventBus 发送 NODE_STATUS_CHANGE 事件（如果 nodeId 存在）。

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/pipeline.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/main/memory/pipeline.ts
git commit -m "feat(memory): add node-bind stage to ContextPipeline for automatic node state updates"
```

---

## Task 5: 会话内容管理 — 消息分页与会话归档

**Files:**
- Modify: `src/main/services/chat-service.ts`
- Modify: `src/main/ipc/chat.ts`

- [ ] **Step 1: 消息分页**

在 `ChatService.listMessages()` 增加 `limit` (default 50) 和 `offset` (default 0) 参数：

```typescript
async listMessages(threadId: string, limit = 50, offset = 0): Promise<ChatMessage[]> {
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    args: [threadId, limit, offset]
  })
  return result.rows.map(row => this._rowToMessage(row))
}
```

更新 IPC handler `chat:listMessages` 传递 limit 和 offset 参数。

- [ ] **Step 2: 会话归档**

增加 `archiveStaleThreads(projectId: string, staleDays = 30): Promise<number>` 方法：

```typescript
async archiveStaleThreads(projectId: string, staleDays = 30): Promise<number> {
  const db = getClient()
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString()
  const result = await db.execute({
    sql: `UPDATE chat_threads SET status = 'archived' WHERE graph_id = ? AND status != 'archived' AND updated_at < ?`,
    args: [projectId, cutoff]
  })
  return Number(result.rowsAffected)
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`

- [ ] **Step 4: Commit**

```bash
git add src/main/services/chat-service.ts src/main/ipc/chat.ts
git commit -m "feat(chat): add message pagination and stale thread archival"
```

---

## Task 6: 业务逻辑转图谱 — RAG few-shot + JSON Schema 约束

**Files:**
- Modify: `src/main/mindmap-agent/synthesis/prompt-builder.ts`
- Modify: `src/main/mindmap-agent/claude-runner.ts`

- [ ] **Step 1: 在 buildDevPrompt 中注入 RAG few-shot 示例**

在 prompt 组装的检索增强部分，从 HybridSearchEngine 获取相似项目的图谱结构作为示例：

```typescript
// After building the main prompt, add RAG examples
const ragExamples = await this._getSimilarGraphExamples(node, allNodes, allEdges)
if (ragExamples) {
  prompt += '\n\n[Similar project structure for reference]\n' + ragExamples
}
```

新增私有方法 `_getSimilarGraphExamples()` 使用 HybridSearchEngine 搜索相似项目的记忆。

- [ ] **Step 2: 在 claude-runner 中增加结构化输出约束**

在 `runClaude()` 中，当 `outputFormat === 'json'` 时，在 prompt 末尾追加 JSON Schema 约束：

```typescript
if (outputFormat === 'json' && schema) {
  prompt += `\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}\nDo not include any text outside the JSON.`
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`

- [ ] **Step 4: Commit**

```bash
git add src/main/mindmap-agent/synthesis/prompt-builder.ts src/main/mindmap-agent/claude-runner.ts
git commit -m "feat(mindmap): add RAG few-shot examples and JSON Schema output constraints"
```

---

## Task 7: LLM自动触发 — 文件变更触发增量分析

**Files:**
- Modify: `src/main/code-intelligence/file-watcher.ts`

- [ ] **Step 1: 增加节点关联文件匹配逻辑**

在 `CodeFileWatcher` 的变更回调中，检查变更文件是否与图谱节点关联：

```typescript
private async _checkNodeFileAssociation(filePath: string): Promise<void> {
  if (!this._onNodeFileChange) return
  // 检查文件路径是否在任何节点的关联文件列表中
  // 通过 EventBus 发送 NODE_FILE_CHANGED 事件，包含 { filePath, changeType }
}
```

新增选项 `onNodeFileChange?: (filePath: string, changeType: 'add' | 'change' | 'unlink') => void`

- [ ] **Step 2: 变更分级**

```typescript
private _classifyChange(filePath: string, content?: string): 'minor' | 'medium' | 'major' {
  const ext = path.extname(filePath)
  // 格式化文件、注释文件 → minor
  if (['.css', '.scss', '.less', '.md'].includes(ext)) return 'minor'
  // 配置文件 → major
  if (['package.json', 'tsconfig.json', '.env'].some(f => filePath.endsWith(f))) return 'major'
  // 代码文件 → medium
  return 'medium'
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`

- [ ] **Step 4: Commit**

```bash
git add src/main/code-intelligence/file-watcher.ts
git commit -m "feat(code-intel): add file change classification and node file association triggering"
```

---

## Task 8: 集成 PromptOrchestrator 到 AgentManager

**Files:**
- Modify: `src/main/agent/agent-manager.ts`
- Modify: `src/main/memory/index.ts`

- [ ] **Step 1: 在 resolveAndSendCommand 中使用 PromptOrchestrator**

替换 `formatSessionHistoryContext` + `formatMemoryContext` + `formatCodeContext` 的分散调用：

```typescript
const orchestrator = new PromptOrchestrator()
const assembled = await orchestrator.assemble({
  sessionId,
  adapterName: session.adapterName,
  projectId: session.projectId,
  nodeId: session.nodeId,
  nodeTitle: session.nodeTitle,
  userCommand: command,
  totalBudget: this.getOptimalPromptBudget(commandType),
  sessionConfig: session.config,
  resolvedContexts,
  codeContext: codeCtx?.summary
})
```

将 `assembled.text` 作为最终 prompt 发送给 Agent。

- [ ] **Step 2: 更新 barrel exports**

在 `memory/index.ts` 中添加 PromptOrchestrator 和 ContextDistiller 导出。

- [ ] **Step 3: 运行全量测试**

Run: `npx vitest run`

- [ ] **Step 4: Commit**

```bash
git add src/main/agent/agent-manager.ts src/main/memory/index.ts
git commit -m "feat(memory): integrate PromptOrchestrator into AgentManager, replacing scattered prompt assembly"
```

---

## Task 9: 最终验证

- [ ] **Step 1: 全量单元测试** — `npx vitest run`
- [ ] **Step 2: 类型检查** — `npx tsc --noEmit`
- [ ] **Step 3: Lint** — `npm run lint` (0 new errors)
- [ ] **Step 4: 最终 Commit**
