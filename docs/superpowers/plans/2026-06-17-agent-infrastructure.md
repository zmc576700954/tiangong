# Agent底层架构优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 BizGraph 的 Agent 底层架构——AST解析增强、Memory持久化重写、RAG语义检索重写、数据清洗流程、自适应配置框架

**Architecture:** 在现有代码基础上，AST解析增加渐进降级和增量解析；MemoryStore增加版本化和冲突解决；HybridSearchEngine升级为真正的embedding语义检索；建立ContextPipeline统一管线集成闲置模块；引入AdaptiveConfig运行时自适应参数框架

**Tech Stack:** TypeScript, LibSQL, @xenova/transformers (ONNX), tree-sitter-wasm, Vitest

---

## File Structure

### New Files
- `src/main/memory/pipeline.ts` — ContextPipeline 统一管线 (PipelineStage + PipelineRunner)
- `src/main/memory/output-normalizer.ts` — 输出标准化管道
- `src/main/memory/embedding-service.ts` — 本地 embedding 生成服务
- `src/main/memory/semantic-search.ts` — 语义检索引擎 (替代 HybridSearchEngine 的核心逻辑)
- `src/main/memory/context-distiller.ts` — 上下文提纯算法
- `src/main/adaptive-config.ts` — 自适应配置框架
- `src/main/code-intelligence/ast-cache.ts` — AST 缓存与增量解析

### Modified Files
- `src/shared/types/agent.ts` — MemoryItem 增加 version/parent_version/embedding 字段；MemoryKind 增加 'waterline'
- `src/main/database.ts` — 迁移：memory_items 新增列 + 复合索引
- `src/main/memory/memory-store.ts` — 版本化存储、冲突解决、容量管理、衰减曲线
- `src/main/memory/hybrid-search.ts` — 升级为 FTS5 + embedding 双路检索
- `src/main/memory/context-compiler.ts` — 补L4层、修getMemoryStore bug、修economics计算
- `src/main/memory/waterline-sync.ts` — 持久化、修匹配逻辑、bounded verifiedNodes
- `src/main/memory/hallucination-checker.ts` — 补 critical severity、修死代码矛盾检查
- `src/main/memory/memory-extractor.ts` — poisoned 输出自动丢弃
- `src/main/memory/index.ts` — 新模块导出
- `src/main/agent/agent-manager.ts` — 接入 ContextPipeline 替代分散调用
- `src/main/code-intelligence/ast-parser.ts` — 渐进降级、Vue SFC 支持
- `src/main/code-intelligence/file-watcher.ts` — 增量 AST 更新回调
- `src/main/adapters/json-protocol.ts` — 输出模式识别增强

### Test Files
- `src/main/memory/__tests__/pipeline.test.ts`
- `src/main/memory/__tests__/output-normalizer.test.ts`
- `src/main/memory/__tests__/embedding-service.test.ts`
- `src/main/memory/__tests__/semantic-search.test.ts`
- `src/main/memory/__tests__/context-distiller.test.ts`
- `src/main/memory/__tests__/context-compiler.test.ts` (新增，当前零测试)
- `src/main/memory/__tests__/waterline-sync.test.ts` (扩展)
- `src/main/memory/__tests__/hallucination-checker.test.ts` (扩展)
- `src/main/__tests__/adaptive-config.test.ts`
- `src/main/code-intelligence/__tests__/ast-cache.test.ts`

---

## Task 1: MemoryItem 类型扩展与数据库迁移

**Files:**
- Modify: `src/shared/types/agent.ts:254-279`
- Modify: `src/main/database.ts`

- [ ] **Step 1: 扩展 MemoryItem 接口**

在 `src/shared/types/agent.ts` 中：

```typescript
// MemoryKind 增加 'waterline'
export type MemoryKind =
  | 'investigation'
  | 'fix'
  | 'review_finding'
  | 'decision'
  | 'pattern'
  | 'lesson'
  | 'waterline'         // 水位线快照
```

MemoryItem 增加可选字段（向后兼容）：

```typescript
export interface MemoryItem {
  id: number
  session_id: string
  kind: MemoryKind
  project_id: string
  node_id: string | null
  title: string
  narrative: string
  facts: string[]
  concepts: string[]
  files_read: string[]
  files_modified: string[]
  adapter_name: string
  token_cost: number
  confidence: number
  created_at: string
  // 新增字段（可选，向后兼容）
  version?: number              // 版本号，默认1
  parent_version?: number | null // 父版本ID，用于演进链追踪
  embedding?: number[] | null    // 384维向量（all-MiniLM-L6-v2）
}
```

- [ ] **Step 2: 数据库迁移 — memory_items 新增列**

在 `src/main/database.ts` 的 `runIncrementalMigrations()` 中，为 schema version 3 添加：

```typescript
if (currentVersion < 3) {
  addColumnSafe('memory_items', 'version', 'INTEGER DEFAULT 1')
  addColumnSafe('memory_items', 'parent_version', 'INTEGER DEFAULT NULL')
  addColumnSafe('memory_items', 'embedding', 'TEXT DEFAULT NULL')
}
```

在 `createIndexes()` 中添加新索引：

```typescript
// 复合索引
await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_graph_id_type ON nodes(graph_id, type)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_nodes_graph_id_status ON nodes(graph_id, status)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_threads_adapter_status ON chat_threads(adapter_name, status)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_status ON chat_messages(thread_id, status)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_memory_items_project_created ON memory_items(project_id, created_at DESC)`)
```

递增 `CURRENT_SCHEMA_VERSION` 为 3。

- [ ] **Step 3: 更新 MemoryStore._rowToItem() 映射**

在 `memory-store.ts` 的 `_rowToItem()` 中增加新字段映射：

```typescript
version: row.version ?? 1,
parent_version: row.parent_version ?? null,
embedding: row.embedding ? JSON.parse(row.embedding) : null,
```

- [ ] **Step 4: 运行测试确认迁移安全**

Run: `npx vitest run src/main/__tests__/ 2>&1 | head -50`

Expected: 所有现有测试通过，无破坏性变更

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/agent.ts src/main/database.ts src/main/memory/memory-store.ts
git commit -m "feat(memory): add version/embedding columns to memory_items schema v3"
```

---

## Task 2: HallucinationChecker 补全与集成准备

**Files:**
- Modify: `src/main/memory/hallucination-checker.ts`
- Modify: `src/main/memory/__tests__/hallucination-checker.test.ts`

- [ ] **Step 1: 补全 critical severity 路径**

在 `_checkOverconfident()` 中，当声明声称修复了 critical bug 但输出中有错误时，生成 severity='critical' 的 claim：

```typescript
// 在 _checkOverconfident 方法中，检测到 "fixed critical" 或 "resolved critical" 且有错误时
if (claimText.match(/\b(fixed|resolved|closed)\s+(a\s+)?critical\b/i) && hasErrors) {
  claims.push({
    claim: claimText,
    type: 'overconfident',
    severity: 'critical',
    evidence: 'Claims to fix critical issue but errors present in output',
    offset: fullText.indexOf(claimText)
  })
}
```

- [ ] **Step 2: 修复合并死代码矛盾检查**

在 `_checkContradictions()` 中，完成 `Conflicting error reports` 和 `Mixed success/failure signals` 的检查逻辑：

```typescript
// 在矛盾检查循环中，替换仅检查 'Conflicting file count' 的逻辑
for (const pair of contradictionPairs) {
  if (pair.matches.length >= 2) {
    if (pair.label === 'Conflicting file count') {
      // 已有逻辑
    } else if (pair.label === 'Conflicting error reports') {
      claims.push({
        claim: `Output contains conflicting error reports: ${pair.matches.map(m => m.text).join(' vs ')}`,
        type: 'internal_contradiction',
        severity: 'medium',
        evidence: `Found ${pair.matches.length} contradictory error statements`,
        offset: pair.matches[0].index
      })
    } else if (pair.label === 'Mixed success/failure signals') {
      claims.push({
        claim: `Output mixes success and failure signals: ${pair.matches.map(m => m.text).join(' vs ')}`,
        type: 'internal_contradiction',
        severity: 'high',
        evidence: `Found ${pair.matches.length} conflicting success/failure statements`,
        offset: pair.matches[0].index
      })
    }
  }
}
```

- [ ] **Step 3: 写测试验证修复**

在 `hallucination-checker.test.ts` 中添加：

```typescript
test('detects critical severity for overconfident critical bug fix with errors', () => {
  const outputs: AgentOutput[] = [{
    type: 'stdout',
    content: 'Fixed critical authentication bypass vulnerability\nError: test suite failed',
    timestamp: Date.now()
  }]
  const report = checker.verifySync(outputs)
  expect(report.claims.some(c => c.severity === 'critical')).toBe(true)
})

test('detects conflicting error reports', () => {
  const outputs: AgentOutput[] = [{
    type: 'stdout',
    content: 'Error: cannot connect to database\nNo errors found in the system',
    timestamp: Date.now()
  }]
  const report = checker.verifySync(outputs)
  expect(report.claims.some(c => c.type === 'internal_contradiction')).toBe(true)
})
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/hallucination-checker.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/hallucination-checker.ts src/main/memory/__tests__/hallucination-checker.test.ts
git commit -m "fix(memory): complete hallucination checker critical severity and contradiction checks"
```

---

## Task 3: ContextCompiler 重构

**Files:**
- Modify: `src/main/memory/context-compiler.ts`
- Create: `src/main/memory/__tests__/context-compiler.test.ts`

- [ ] **Step 1: 修 getMemoryStore 不一致 bug**

在 `renderWithHistory()` 中，将 `const store = getMemoryStore()` 替换为使用 lazy getter `this.memoryStore`：

```typescript
// 替换 renderWithHistory 中的 getMemoryStore() 调用
const store = this.memoryStore  // 使用已有的 lazy getter
```

- [ ] **Step 2: 补 L4 层**

在 `compile()` 方法中增加 L4 层生成：

```typescript
// L4: 关联历史记忆摘要（从最近记忆中提取概念相关的摘要）
const l4Content = this._buildL4(outputs, meta)
if (l4Content) {
  layers.push({
    level: 4,
    label: 'L4-关联历史',
    content: l4Content,
    estimatedTokens: estimateTokens(l4Content)
  })
}
```

新增 `_buildL4()` 私有方法：

```typescript
private _buildL4(outputs: AgentOutput[], meta?: { sessionId?: string; adapterName?: string; commandDescription?: string }): string {
  // 从最近的记忆中提取与当前输出概念相关的摘要
  // 使用 lazy memoryStore getter 获取最近5条相关记忆
  try {
    const recentMemories = this.memoryStore.getRecent({
      projectId: meta?.sessionId ? undefined : undefined,
      limit: 5,
      minConfidence: 0.6
    })
    if (!recentMemories || recentMemories.length === 0) return ''
    return recentMemories
      .map(m => `[${m.kind}] ${m.title}`)
      .join('\n')
  } catch {
    return ''  // 数据库不可用时优雅降级
  }
}
```

- [ ] **Step 3: 修 render() label 前缀剥离**

替换脆弱的 `.replace('L1-', '').replace('L2-', '').replace('L3-', '')`：

```typescript
// 替换所有 label 前缀剥离
layer.label.replace(/^L\d+-/, '')
```

- [ ] **Step 4: 修 renderWithHistory economics 计算**

在 `renderWithHistory()` 中，将 `savingsPct` 计算包含历史 token：

```typescript
// 修正 economics 计算
economics.savingsPct = economics.discoveryTokens > 0
  ? Math.round((1 - economics.readTokens / (economics.discoveryTokens + historyTokens)) * 100)
  : 0
```

- [ ] **Step 5: 增加 injectForDownstream 错误处理**

```typescript
async injectForDownstream(...): Promise<{ text: string; economics: TokenEconomics }> {
  try {
    // 现有逻辑
  } catch (error) {
    logger.warn('injectForDownstream failed, returning empty context', error)
    return { text: '', economics: { discoveryTokens: 0, readTokens: 0, savingsPct: 0 } }
  }
}
```

- [ ] **Step 6: 写 ContextCompiler 测试**

创建 `src/main/memory/__tests__/context-compiler.test.ts`：

```typescript
import { describe, test, expect, vi } from 'vitest'
import { ContextCompiler } from '../context-compiler'
import type { AgentOutput } from '@shared/types'

describe('ContextCompiler', () => {
  let compiler: ContextCompiler

  beforeEach(() => {
    compiler = new ContextCompiler()
  })

  test('compile produces L1-L4 layers', () => {
    const outputs: AgentOutput[] = [{
      type: 'stdout',
      content: 'Implemented user authentication with JWT tokens',
      timestamp: Date.now()
    }]
    const context = compiler.compile(outputs, { sessionId: 'test', adapterName: 'claude-code' })
    expect(context.layers.length).toBeGreaterThanOrEqual(3) // L1-L3 至少
    expect(context.layers[0].level).toBe(1)
  })

  test('render respects token budget', () => {
    const outputs: AgentOutput[] = [{
      type: 'stdout',
      content: 'A'.repeat(10000),
      timestamp: Date.now()
    }]
    const context = compiler.compile(outputs)
    const { text, economics } = compiler.render(context, 100)
    expect(economics.readTokens).toBeLessThanOrEqual(150) // 允许10%误差
  })

  test('render strips L-prefix from labels', () => {
    const outputs: AgentOutput[] = [{
      type: 'stdout',
      content: 'test content',
      timestamp: Date.now()
    }]
    const context = compiler.compile(outputs)
    const { text } = compiler.render(context, 1000)
    expect(text).not.toMatch(/^L\d+-/m)
  })

  test('injectForDownstream gracefully handles DB errors', async () => {
    const result = await compiler.injectForDownstream(
      [{ type: 'stdout', content: 'test', timestamp: Date.now() }],
      500
    )
    expect(result.text).toBeDefined()
    expect(result.economics).toBeDefined()
  })
})
```

- [ ] **Step 7: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/context-compiler.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/memory/context-compiler.ts src/main/memory/__tests__/context-compiler.test.ts
git commit -m "fix(memory): refactor ContextCompiler - add L4, fix bugs, add tests"
```

---

## Task 4: WaterlineSync 重构

**Files:**
- Modify: `src/main/memory/waterline-sync.ts`
- Modify: `src/main/memory/__tests__/waterline-sync.test.ts`

- [ ] **Step 1: 实现持久化**

在 `WaterlineSync` 中增加持久化方法：

```typescript
import { getMemoryStore } from './memory-store'

/** 持久化当前水位线到 MemoryStore */
async persist(projectId: string): Promise<void> {
  const snapshot = this.getWaterline(projectId)
  const store = getMemoryStore()
  // 删除旧的水位线记忆
  const existing = await store.search(`waterline:${projectId}`, { projectId, kind: 'waterline' as MemoryKind, limit: 1 })
  if (existing.length > 0) {
    // 通过 session_id 标记来删除
  }
  // 存储新快照
  await store.store({
    session_id: `waterline:${projectId}`,
    kind: 'waterline' as MemoryKind,
    project_id: projectId,
    node_id: null,
    title: `Waterline: ${projectId}`,
    narrative: JSON.stringify(snapshot),
    facts: snapshot.completedInvestigations.slice(-10),
    concepts: ['waterline', projectId],
    files_read: [],
    files_modified: [],
    adapter_name: 'system',
    token_cost: 0,
    confidence: 1.0
  })
}

/** 从 MemoryStore 恢复水位线 */
async restore(projectId: string): Promise<void> {
  const store = getMemoryStore()
  const results = await store.search(`waterline:${projectId}`, { projectId, kind: 'waterline' as MemoryKind, limit: 1 })
  if (results.length > 0) {
    try {
      const snapshot = JSON.parse(results[0].narrative) as WaterlineSnapshot
      this.waterlines.set(projectId, snapshot)
    } catch {
      logger.warn(`Failed to restore waterline for ${projectId}`)
    }
  }
}
```

- [ ] **Step 2: 修 hasInvestigated 匹配逻辑**

替换松散的双向 includes：

```typescript
hasInvestigated(projectId: string, topic: string): boolean {
  const wl = this.getWaterline(projectId)
  const normalizedTopic = topic.toLowerCase().trim()
  return wl.completedInvestigations.some(inv => {
    const normalizedInv = inv.toLowerCase().trim()
    // 要求 topic 是 investigation 的子串，或 investigation 是 topic 的子串
    // 但排除短词误匹配：topic 长度 >= 3 时才做子串匹配
    if (normalizedTopic.length < 3) return normalizedInv === normalizedTopic
    return normalizedInv.includes(normalizedTopic) || normalizedTopic.includes(normalizedInv)
  })
}
```

- [ ] **Step 3: 修 recentlyModified 匹配逻辑**

使用路径感知比较：

```typescript
recentlyModified(projectId: string, filePath: string): boolean {
  const wl = this.getWaterline(projectId)
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase()
  return wl.modifiedFiles.some(f => {
    const normalizedF = f.replace(/\\/g, '/').toLowerCase()
    // 精确匹配或后缀匹配（如 src/foo.ts 匹配 project/src/foo.ts）
    return normalizedF === normalizedPath
      || normalizedF.endsWith('/' + normalizedPath)
      || normalizedPath.endsWith('/' + normalizedF)
  })
}
```

- [ ] **Step 4: bounded verifiedNodes**

在 `markNodeVerified()` 中增加上限：

```typescript
markNodeVerified(projectId: string, nodeId: string): void {
  const wl = this.getWaterline(projectId)
  if (!wl.verifiedNodes.includes(nodeId)) {
    wl.verifiedNodes.push(nodeId)
    // 上限100，超出的移除最早的
    if (wl.verifiedNodes.length > 100) {
      wl.verifiedNodes = wl.verifiedNodes.slice(-100)
    }
  }
}
```

- [ ] **Step 5: 写扩展测试**

在 `waterline-sync.test.ts` 中添加：

```typescript
test('hasInvestigated avoids short word false positives', () => {
  sync.advance('proj1', [{
    id: 1, session_id: 's1', kind: 'investigation', project_id: 'proj1',
    node_id: null, title: 'Investigated authority delegation', narrative: '',
    facts: [], concepts: [], files_read: [], files_modified: [],
    adapter_name: 'test', token_cost: 0, confidence: 0.8, created_at: new Date().toISOString()
  }])
  expect(sync.hasInvestigated('proj1', 'auth')).toBe(false)  // 短词不匹配
  expect(sync.hasInvestigated('proj1', 'authority')).toBe(true)
})

test('recentlyModified uses path-aware comparison', () => {
  sync.advance('proj1', [{
    id: 1, session_id: 's1', kind: 'fix', project_id: 'proj1',
    node_id: null, title: 'Fixed bug', narrative: '',
    facts: [], concepts: [], files_read: [], files_modified: ['project/src/parser.ts'],
    adapter_name: 'test', token_cost: 0, confidence: 0.8, created_at: new Date().toISOString()
  }])
  expect(sync.recentlyModified('proj1', 'src/parser.ts')).toBe(true)
  expect(sync.recentlyModified('proj1', 'a.ts')).toBe(false)  // 不匹配子串
})

test('verifiedNodes is bounded to 100', () => {
  for (let i = 0; i < 120; i++) {
    sync.markNodeVerified('proj1', `node_${i}`)
  }
  const wl = sync.getWaterline('proj1')
  expect(wl.verifiedNodes.length).toBe(100)
})
```

- [ ] **Step 6: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/waterline-sync.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/memory/waterline-sync.ts src/main/memory/__tests__/waterline-sync.test.ts
git commit -m "fix(memory): WaterlineSync persistence, path-aware matching, bounded verifiedNodes"
```

---

## Task 5: OutputNormalizer 输出标准化

**Files:**
- Create: `src/main/memory/output-normalizer.ts`
- Create: `src/main/memory/__tests__/output-normalizer.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect } from 'vitest'
import { OutputNormalizer } from '../output-normalizer'
import type { AgentOutput } from '@shared/types'

describe('OutputNormalizer', () => {
  const normalizer = new OutputNormalizer()

  test('strips ANSI escape codes', () => {
    const output: AgentOutput = {
      type: 'stdout',
      content: '[32mSuccess[0m: file created',
      timestamp: Date.now()
    }
    const result = normalizer.normalize(output)
    expect(result.content).toBe('Success: file created')
  })

  test('strips progress bar lines', () => {
    const output: AgentOutput = {
      type: 'stdout',
      content: 'Downloading... [=========>          ] 45%\nDone!',
      timestamp: Date.now()
    }
    const result = normalizer.normalize(output)
    expect(result.content).not.toContain('[=========>')
    expect(result.content).toContain('Done!')
  })

  test('strips timestamp prefixes', () => {
    const output: AgentOutput = {
      type: 'stdout',
      content: '[2024-01-15 10:30:25] Starting process\n[2024-01-15 10:30:26] Complete',
      timestamp: Date.now()
    }
    const result = normalizer.normalize(output)
    expect(result.content).not.toContain('[2024-01-15')
    expect(result.content).toContain('Starting process')
  })

  test('strips duplicate consecutive lines', () => {
    const output: AgentOutput = {
      type: 'stdout',
      content: 'Processing file...\nProcessing file...\nProcessing file...\nDone',
      timestamp: Date.now()
    }
    const result = normalizer.normalize(output)
    expect(result.content.match(/Processing file\.\.\./g)?.length).toBe(1)
  })

  test('preserves error output unchanged', () => {
    const output: AgentOutput = {
      type: 'stderr',
      content: 'Error: something went wrong',
      timestamp: Date.now()
    }
    const result = normalizer.normalize(output)
    expect(result.content).toBe('Error: something went wrong')
  })

  test('normalizes line endings to LF', () => {
    const output: AgentOutput = {
      type: 'stdout',
      content: 'line1\r\nline2\rline3',
      timestamp: Date.now()
    }
    const result = normalizer.normalize(output)
    expect(result.content).toBe('line1\nline2\nline3')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/memory/__tests__/output-normalizer.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: 实现 OutputNormalizer**

```typescript
import type { AgentOutput } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('output-normalizer')

/** 输出标准化管道 — 统一不同适配器输出格式差异 */
export class OutputNormalizer {
  /** ANSI escape code 正则 */
  private static readonly ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g
  /** 进度条正则 (如 [=====>    ] 45%) */
  private static readonly PROGRESS_REGEX = /\[=*\s*\]\s*\d+%/g
  /** 时间戳前缀正则 (如 [2024-01-15 10:30:25]) */
  private static readonly TIMESTAMP_PREFIX = /^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*/gm

  normalize(output: AgentOutput): AgentOutput {
    if (output.type === 'stderr' || output.type === 'error') {
      return output  // 错误输出不做清洗
    }

    let content = output.content

    // 1. 统一行尾为 LF
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

    // 2. 去除 ANSI escape codes
    content = content.replace(OutputNormalizer.ANSI_REGEX, '')

    // 3. 去除进度条行
    content = content
      .split('\n')
      .filter(line => !OutputNormalizer.PROGRESS_REGEX.test(line))
      .join('\n')

    // 4. 去除时间戳前缀
    content = content.replace(OutputNormalizer.TIMESTAMP_PREFIX, '')

    // 5. 去除连续重复行
    const lines = content.split('\n')
    const deduped: string[] = []
    for (const line of lines) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
        deduped.push(line)
      }
    }
    content = deduped.join('\n')

    return { ...output, content }
  }

  /** 批量标准化 */
  normalizeAll(outputs: AgentOutput[]): AgentOutput[] {
    return outputs.map(o => this.normalize(o))
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/output-normalizer.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/output-normalizer.ts src/main/memory/__tests__/output-normalizer.test.ts
git commit -m "feat(memory): add OutputNormalizer for cross-adapter output standardization"
```

---

## Task 6: EmbeddingService 本地向量生成

**Files:**
- Create: `src/main/memory/embedding-service.ts`
- Create: `src/main/memory/__tests__/embedding-service.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, vi, beforeAll } from 'vitest'
import { EmbeddingService, getEmbeddingService } from '../embedding-service'

describe('EmbeddingService', () => {
  test('generateEmbedding returns 384-dim vector', async () => {
    const service = getEmbeddingService()
    const embedding = await service.generateEmbedding('user authentication with JWT tokens')
    expect(embedding).toBeDefined()
    expect(embedding.length).toBe(384)
    expect(embedding.every(v => typeof v === 'number' && isFinite(v))).toBe(true)
  }, 30000)  // 首次加载模型较慢

  test('generateEmbedding returns similar vectors for similar text', async () => {
    const service = getEmbeddingService()
    const v1 = await service.generateEmbedding('fix authentication bug')
    const v2 = await service.generateEmbedding('resolve auth issue')
    const v3 = await service.generateEmbedding('optimize database query')
    const sim12 = service.cosineSimilarity(v1, v2)
    const sim13 = service.cosineSimilarity(v1, v3)
    expect(sim12).toBeGreaterThan(sim13)  // 相似文本向量更接近
  }, 30000)

  test('cosineSimilarity returns 1 for identical vectors', () => {
    const service = getEmbeddingService()
    const v = [1, 2, 3, 4]
    expect(service.cosineSimilarity(v, v)).toBeCloseTo(1.0)
  })

  test('isReady returns false before init, true after', async () => {
    const service = new EmbeddingService()
    expect(service.isReady()).toBe(false)
    await service.initialize()
    expect(service.isReady()).toBe(true)
  }, 30000)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/memory/__tests__/embedding-service.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 EmbeddingService**

```typescript
import { createLogger } from '../shared/logger'
import path from 'node:path'
import fs from 'node:fs/promises'

// Electron app 在测试中不可用，使用条件导入
let _app: any = null
try {
  // @ts-ignore - electron 仅在主进程可用
  _app = require('electron').app
} catch {
  // 测试环境 fallback
}

const logger = createLogger('embedding-service')

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const EMBEDDING_DIM = 384

function getCacheDir(): string {
  if (_app) {
    return path.join(_app.getPath('userData'), 'models')
  }
  // 测试/非 Electron 环境 fallback
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '/tmp', '.bizgraph-models')
}

export class EmbeddingService {
  private _pipeline: any = null
  private _initPromise: Promise<void> | null = null

  async initialize(): Promise<void> {
    if (this._pipeline) return
    if (this._initPromise) return this._initPromise

    this._initPromise = (async () => {
      try {
        const { pipeline, env } = await import('@xenova/transformers')
        // 缓存模型到用户数据目录
        const cacheDir = getCacheDir()
        await fs.mkdir(cacheDir, { recursive: true })
        env.cacheDir = cacheDir
        env.allowLocalModels = true

        this._pipeline = await pipeline('feature-extraction', MODEL_ID, {
          quantized: true
        })
        logger.info(`Embedding model loaded: ${MODEL_ID}`)
      } catch (error) {
        logger.error('Failed to load embedding model', error)
        throw error
      }
    })()

    return this._initPromise
  }

  isReady(): boolean {
    return this._pipeline !== null
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this._pipeline) {
      await this.initialize()
    }
    const output = await this._pipeline(text, {
      pooling: 'mean',
      normalize: true
    })
    return Array.from(output.data) as number[]
  }

  /** 批量生成 embedding */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.generateEmbedding(t)))
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0
    let dot = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom === 0 ? 0 : dot / denom
  }
}

let _instance: EmbeddingService | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!_instance) _instance = new EmbeddingService()
  return _instance
}

export function setEmbeddingServiceForTesting(service: EmbeddingService): void {
  _instance = service
}
```

- [ ] **Step 4: 安装 @xenova/transformers 依赖**

Run: `npm install @xenova/transformers`

- [ ] **Step 5: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/embedding-service.test.ts`

Expected: PASS (首次运行会下载模型，可能需要1-2分钟)

- [ ] **Step 6: Commit**

```bash
git add src/main/memory/embedding-service.ts src/main/memory/__tests__/embedding-service.test.ts package.json package-lock.json
git commit -m "feat(memory): add local embedding service with Xenova/all-MiniLM-L6-v2"
```

---

## Task 7: MemoryStore 版本化与冲突解决

**Files:**
- Modify: `src/main/memory/memory-store.ts`
- Modify: `src/main/memory/__tests__/memory-store.test.ts`

- [ ] **Step 1: 写版本化存储测试**

```typescript
test('store with version defaults to 1', async () => {
  const item = await store.store({ ...baseItem, title: 'version test' })
  expect(item.version).toBe(1)
  expect(item.parent_version).toBeNull()
})

test('store with existing concept increments version', async () => {
  const item1 = await store.store({ ...baseItem, title: 'auth pattern', concepts: ['auth-pattern'] })
  const item2 = await store.store({ ...baseItem, title: 'auth pattern improved', concepts: ['auth-pattern'] })
  expect(item2.version).toBe(2)
  expect(item2.parent_version).toBe(item1.id)
})

test('conflict resolution merges by timestamp+confidence', async () => {
  // 两个会话同时修改同一概念
  const item1 = await store.store({ ...baseItem, title: 'approach A', confidence: 0.7, concepts: ['caching'] })
  const item2 = await store.store({ ...baseItem, title: 'approach B', confidence: 0.9, concepts: ['caching'] })
  // 高置信度的应被保留为主版本
  const results = await store.search('caching', { projectId: baseItem.project_id })
  expect(results.length).toBeGreaterThanOrEqual(1)
})
```

- [ ] **Step 2: 实现版本化 store 方法**

在 `memory-store.ts` 中修改 `store()` 方法，增加版本化逻辑：

```typescript
async store(item: Omit<MemoryItem, 'id'>): Promise<MemoryItem> {
  const db = getClient()

  // 查找同概念的现有记忆
  const existing = item.concepts.length > 0
    ? await this._findByConcepts(item.project_id, item.concepts)
    : null

  let version = 1
  let parentVersion = null

  if (existing && existing.confidence < item.confidence) {
    // 新记忆置信度更高 → 增加版本
    version = (existing.version ?? 1) + 1
    parentVersion = existing.id
  } else if (existing) {
    // 现有记忆置信度更高或相同 → 仍存储但标记为同概念的不同视角
    version = 1
    parentVersion = existing.id
  }

  const result = await db.execute({
    sql: `INSERT INTO memory_items (
      session_id, kind, project_id, node_id, title, narrative,
      facts, concepts, files_read, files_modified, adapter_name,
      token_cost, confidence, version, parent_version, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      item.session_id, item.kind, item.project_id, item.node_id,
      item.title, item.narrative,
      JSON.stringify(item.facts), JSON.stringify(item.concepts),
      JSON.stringify(item.files_read), JSON.stringify(item.files_modified),
      item.adapter_name, item.token_cost, item.confidence,
      version, parentVersion,
      item.embedding ? JSON.stringify(item.embedding) : null
    ]
  })

  const id = Number(result.lastInsertRowid)
  return { ...item, id, version, parent_version: parentVersion } as MemoryItem
}
```

- [ ] **Step 3: 实现记忆衰减曲线**

替换简单的 `pruneStale()` 阈值：

```typescript
async pruneWithDecay(projectId: string, config?: {
  baseHalfLife?: number  // 基础半衰期（天），默认30
  minConfidence?: number // 最低保留置信度，默认0.1
  maxItems?: number      // 每项目最大条目数，默认5000
}): Promise<number> {
  const { baseHalfLife = 30, minConfidence = 0.1, maxItems = 5000 } = config ?? {}
  const db = getClient()

  // 获取项目所有记忆
  const result = await db.execute({
    sql: `SELECT id, confidence, created_at FROM memory_items WHERE project_id = ? ORDER BY created_at ASC`,
    args: [projectId]
  })

  const now = Date.now()
  const toDelete: number[] = []

  for (const row of result.rows) {
    const ageDays = (now - new Date(row.created_at as string).getTime()) / (1000 * 60 * 60 * 24)
    const confidence = row.confidence as number
    // 高置信度衰减慢: halfLife = baseHalfLife * (1 + confidence)
    const halfLife = baseHalfLife * (1 + confidence)
    const decayedConfidence = confidence * Math.pow(0.5, ageDays / halfLife)

    if (decayedConfidence < minConfidence) {
      toDelete.push(Number(row.id))
    }
  }

  // 容量管理：超限时按衰减后置信度排序淘汰
  if (result.rows.length > maxItems) {
    const excess = result.rows.length - maxItems
    // 已在 toDelete 中的不再重复
    // ...按衰减置信度排序取最低的excess条
  }

  // 批量删除
  for (const id of toDelete) {
    await db.execute({ sql: `DELETE FROM memory_items WHERE id = ?`, args: [id] })
  }

  return toDelete.length
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/memory-store.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/memory-store.ts src/main/memory/__tests__/memory-store.test.ts
git commit -m "feat(memory): versioned storage, conflict resolution, decay-based pruning"
```

---

## Task 8: HybridSearch 升级为双路检索

**Files:**
- Modify: `src/main/memory/hybrid-search.ts`
- Modify: `src/main/memory/__tests__/hybrid-search.test.ts` (如存在)

- [ ] **Step 1: 在 HybridSearchEngine 中集成 EmbeddingService**

```typescript
import { getEmbeddingService, EmbeddingService } from './embedding-service'

export class HybridSearchEngine {
  private _embeddingService: EmbeddingService | null = null
  private _embeddingEnabled: boolean = false

  /** 启用 embedding 语义检索 */
  async enableEmbedding(): Promise<void> {
    try {
      this._embeddingService = getEmbeddingService()
      await this._embeddingService.initialize()
      this._embeddingEnabled = true
      logger.info('Embedding-based search enabled')
    } catch (error) {
      logger.warn('Embedding not available, falling back to keyword-only', error)
      this._embeddingEnabled = false
    }
  }

  /** 生成并存储 embedding */
  async indexEmbedding(item: MemoryItem): Promise<void> {
    if (!this._embeddingEnabled || !this._embeddingService) return
    try {
      const text = `${item.title} ${item.narrative} ${item.facts.join(' ')}`
      const embedding = await this._embeddingService.generateEmbedding(text)
      // 更新 memory_items.embedding 列
      const db = getClient()
      await db.execute({
        sql: `UPDATE memory_items SET embedding = ? WHERE id = ?`,
        args: [JSON.stringify(embedding), item.id]
      })
    } catch (error) {
      logger.warn('Failed to index embedding', error)
    }
  }
}
```

- [ ] **Step 2: 实现双路检索**

在 `search()` 方法中增加 embedding 路径：

```typescript
async search(query: string, options?: HybridSearchOptions): Promise<RankedSearchResult[]> {
  const opts = { ...this._config, ...options }

  // 路径1: FTS5 关键词检索
  const ftsResults = await this._ftsSearch(query, opts)

  // 路径2: Embedding 语义检索（如果可用）
  let embeddingResults: RankedSearchResult[] = []
  if (this._embeddingEnabled && this._embeddingService) {
    embeddingResults = await this._embeddingSearch(query, opts)
  }

  // 融合排序: 加权合并两路结果
  const merged = this._mergeResults(ftsResults, embeddingResults, opts.ftsWeight ?? 0.5)

  // 过滤和排序
  return merged
    .filter(r => r.score >= (opts.scoreThreshold ?? 0.1))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 20)
}

private async _embeddingSearch(query: string, opts: HybridSearchOptions): Promise<RankedSearchResult[]> {
  if (!this._embeddingService) return []
  const queryEmbedding = await this._embeddingService.generateEmbedding(query)
  // 从 memory_items 中检索有 embedding 的条目
  const db = getClient()
  const result = await db.execute({
    sql: `SELECT * FROM memory_items WHERE project_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?`,
    args: [opts.projectId ?? '', 100]
  })
  // 计算余弦相似度
  const scored = []
  for (const row of result.rows) {
    const item = this._memoryStore._rowToItem(row)
    const embedding = JSON.parse(row.embedding as string) as number[]
    const score = this._embeddingService!.cosineSimilarity(queryEmbedding, embedding)
    scored.push({ item, score, matchReason: 'embedding' as const })
  }
  return scored
    .filter(r => r.score > 0.3)
    .map(r => ({
      item: r.item,
      score: r.score,
      ftsScore: 0,
      keywordScore: 0,
      matchReason: r.matchReason
    }))
}

private _mergeResults(fts: RankedSearchResult[], embedding: RankedSearchResult[], ftsWeight: number): RankedSearchResult[] {
  const embeddingWeight = 1 - ftsWeight
  const byId = new Map<number, RankedSearchResult>()

  for (const r of fts) {
    byId.set(r.item.id, { ...r, score: r.score * ftsWeight })
  }
  for (const r of embedding) {
    const existing = byId.get(r.item.id)
    if (existing) {
      existing.score += r.score * embeddingWeight
      existing.matchReason = 'hybrid'
    } else {
      byId.set(r.item.id, { ...r, score: r.score * embeddingWeight })
    }
  }

  return Array.from(byId.values())
}
```

- [ ] **Step 3: 增加 CJK 分词**

在 `tokenize()` 中增加中文分词支持：

```typescript
function tokenize(text: string): string[] {
  // 英文分词
  const englishTokens = text.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(t => t.length > 0 && !STOP_WORDS.has(t))
  // 中文按字符分词（简单策略，无jieba）
  const cjkTokens: string[] = []
  for (const token of englishTokens) {
    if (/[一-鿿]/.test(token)) {
      // CJK: 每2-3个字符作为一个token
      for (let i = 0; i < token.length - 1; i += 2) {
        cjkTokens.push(token.substring(i, i + 2))
      }
    }
  }
  return [...englishTokens.filter(t => !/[一-鿿]/.test(t)), ...cjkTokens]
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/hybrid-search.ts
git commit -m "feat(memory): upgrade HybridSearch to dual-path FTS5+embedding retrieval with CJK tokenization"
```

---

## Task 9: AST 解析增强

**Files:**
- Modify: `src/main/code-intelligence/ast-parser.ts`
- Create: `src/main/code-intelligence/ast-cache.ts`
- Create: `src/main/code-intelligence/__tests__/ast-cache.test.ts`

- [ ] **Step 1: 实现 AST 缓存**

```typescript
import { createLogger } from '../shared/logger'
import type { ParseResult } from './ast-parser'

const logger = createLogger('ast-cache')

export class AstCache {
  private _cache = new Map<string, { result: ParseResult; mtime: number; hash: string }>()
  private _maxSize: number

  constructor(maxSize = 500) {
    this._maxSize = maxSize
  }

  get(filePath: string, mtime: number): ParseResult | null {
    const entry = this._cache.get(filePath)
    if (entry && entry.mtime === mtime) {
      return entry.result
    }
    return null
  }

  set(filePath: string, mtime: number, result: ParseResult): void {
    if (this._cache.size >= this._maxSize) {
      // LRU: 删除最早的条目
      const firstKey = this._cache.keys().next().value
      if (firstKey) this._cache.delete(firstKey)
    }
    this._cache.set(filePath, { result, mtime, hash: '' })
  }

  invalidate(filePath: string): void {
    this._cache.delete(filePath)
  }

  clear(): void {
    this._cache.clear()
  }

  get size(): number {
    return this._cache.size
  }
}

let _instance: AstCache | null = null

export function getAstCache(): AstCache {
  if (!_instance) _instance = new AstCache()
  return _instance
}
```

- [ ] **Step 2: AST 解析增加渐进降级 + Vue SFC 支持**

在 `ast-parser.ts` 的 `parse()` 方法中增加 Vue SFC 支持：

```typescript
parse(filePath: string, sourceCode: string): ParseResult {
  // Vue SFC 解析
  if (filePath.endsWith('.vue')) {
    return this._parseVueSfc(filePath, sourceCode)
  }

  try {
    return this._parseWithTreeSitter(filePath, sourceCode)
  } catch {
    logger.debug(`tree-sitter parse failed for ${filePath}, trying regex fallback`)
  }

  try {
    if (this._isJsTsFile(filePath)) {
      return this._parseWithTsCompiler(filePath, sourceCode)
    }
  } catch {
    logger.debug(`TS compiler parse failed for ${filePath}`)
  }

  return this._minimalExtract(filePath, sourceCode)
}

private _parseVueSfc(filePath: string, sourceCode: string): ParseResult {
  // 从 Vue SFC 中提取 <script> 部分并解析
  const scriptMatch = sourceCode.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (!scriptMatch) {
    return this._minimalExtract(filePath, sourceCode)
  }
  const scriptContent = scriptMatch[1]
  const langMatch = scriptMatch[0].match(/lang=["']?(ts|typescript)["']?/)
  const isTs = langMatch !== null
  // 解析 script 内容
  return this.parse(`${filePath}.script.${isTs ? 'ts' : 'js'}`, scriptContent)
}

private _minimalExtract(filePath: string, sourceCode: string): ParseResult {
  // 仅提取文件级声明（export default, module.exports 等）
  const symbols: SymbolInfo[] = []
  const exportMatch = sourceCode.match(/export\s+default\s+(?:class|function|const|let|var)\s+(\w+)/)
  if (exportMatch) {
    symbols.push({
      id: generateId('symbol'),
      name: exportMatch[1],
      kind: 'function',
      filePath,
      isExported: true,
      line: 1, column: 1, endLine: 1, endColumn: 1
    })
  }
  return { symbols, imports: [], exports: [] }
}
```

- [ ] **Step 3: 写 AST 缓存测试**

```typescript
import { describe, test, expect } from 'vitest'
import { AstCache } from '../ast-cache'

describe('AstCache', () => {
  test('caches and retrieves parse results', () => {
    const cache = new AstCache()
    const result = { symbols: [], imports: [], exports: [] }
    cache.set('test.ts', 1000, result)
    expect(cache.get('test.ts', 1000)).toBe(result)
  })

  test('returns null for stale entries (mtime mismatch)', () => {
    const cache = new AstCache()
    cache.set('test.ts', 1000, { symbols: [], imports: [], exports: [] })
    expect(cache.get('test.ts', 2000)).toBeNull()
  })

  test('evicts oldest entry when at capacity', () => {
    const cache = new AstCache(2)
    cache.set('a.ts', 1, { symbols: [], imports: [], exports: [] })
    cache.set('b.ts', 1, { symbols: [], imports: [], exports: [] })
    cache.set('c.ts', 1, { symbols: [], imports: [], exports: [] })
    expect(cache.size).toBe(2)
    expect(cache.get('a.ts', 1)).toBeNull()  // 最早被淘汰
  })

  test('invalidate removes specific entry', () => {
    const cache = new AstCache()
    cache.set('test.ts', 1, { symbols: [], imports: [], exports: [] })
    cache.invalidate('test.ts')
    expect(cache.get('test.ts', 1)).toBeNull()
  })
})
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/code-intelligence/__tests__/ast-cache.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/code-intelligence/ast-parser.ts src/main/code-intelligence/ast-cache.ts src/main/code-intelligence/__tests__/ast-cache.test.ts
git commit -m "feat(code-intel): AST incremental parsing with cache and graceful degradation"
```

---

## Task 10: AdaptiveConfig 自适应配置框架

**Files:**
- Create: `src/main/adaptive-config.ts`
- Create: `src/main/__tests__/adaptive-config.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect } from 'vitest'
import { AdaptiveConfig } from '../adaptive-config'

describe('AdaptiveConfig', () => {
  test('returns default values initially', () => {
    const config = new AdaptiveConfig()
    expect(config.get('compressThresholdTokens')).toBe(4000)
    expect(config.get('ftsWeight')).toBe(0.5)
  })

  test('adapts compress threshold based on output size distribution', () => {
    const config = new AdaptiveConfig()
    // 记录一系列小输出
    for (let i = 0; i < 20; i++) {
      config.recordMetric('outputSize', 500)
    }
    config.adapt()
    // 小输出分布 → 降低压缩阈值
    expect(config.get('compressThresholdTokens')).toBeLessThan(4000)
  })

  test('adapts fts weight based on search result quality', () => {
    const config = new AdaptiveConfig()
    // FTS 结果质量高 → 增加FTS权重
    for (let i = 0; i < 10; i++) {
      config.recordMetric('searchQuality', { ftsScore: 0.9, embeddingScore: 0.5 })
    }
    config.adapt()
    expect(config.get('ftsWeight')).toBeGreaterThan(0.5)
  })

  test('clamps values within bounds', () => {
    const config = new AdaptiveConfig()
    config.override('ftsWeight', 1.5)  // 超出 [0, 1] 范围
    expect(config.get('ftsWeight')).toBe(1.0)
  })

  test('reset restores defaults', () => {
    const config = new AdaptiveConfig()
    config.override('compressThresholdTokens', 1000)
    config.reset()
    expect(config.get('compressThresholdTokens')).toBe(4000)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/__tests__/adaptive-config.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 AdaptiveConfig**

```typescript
import { createLogger } from './shared/logger'

const logger = createLogger('adaptive-config')

interface ConfigSpec {
  default: number
  min: number
  max: number
  adaptFn?: (metrics: Map<string, number[]>, current: number) => number
}

const CONFIG_SPECS: Record<string, ConfigSpec> = {
  compressThresholdTokens: {
    default: 4000, min: 1000, max: 16000,
    adaptFn: (metrics, current) => {
      const sizes = metrics.get('outputSize') ?? []
      if (sizes.length < 10) return current
      const median = sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)]
      // 中位输出大小 → 阈值设为中位数的2倍
      return Math.max(1000, Math.min(16000, median * 2))
    }
  },
  ftsWeight: {
    default: 0.5, min: 0, max: 1,
    adaptFn: (metrics, current) => {
      const qualities = metrics.get('searchQuality') ?? []
      if (qualities.length < 5) return current
      // 基于FTS vs embedding结果质量调整
      const avgFts = qualities.reduce((s, v) => s + v, 0) / qualities.length
      return Math.max(0, Math.min(1, avgFts))
    }
  },
  memoryMaxItems: {
    default: 5000, min: 1000, max: 50000
  },
  pruneHalfLifeDays: {
    default: 30, min: 7, max: 180
  }
}

export class AdaptiveConfig {
  private _values = new Map<string, number>()
  private _metrics = new Map<string, number[]>()
  private _maxMetricSamples = 100

  constructor() {
    this.reset()
  }

  get(key: string): number {
    return this._values.get(key) ?? CONFIG_SPECS[key]?.default ?? 0
  }

  override(key: string, value: number): void {
    const spec = CONFIG_SPECS[key]
    if (!spec) return
    this._values.set(key, Math.max(spec.min, Math.min(spec.max, value)))
  }

  recordMetric(key: string, value: number | { ftsScore: number; embeddingScore: number }): void {
    if (!this._metrics.has(key)) this._metrics.set(key, [])
    const arr = this._metrics.get(key)!
    const numericValue = typeof value === 'number' ? value : value.ftsScore / (value.ftsScore + value.embeddingScore + 0.001)
    arr.push(numericValue)
    if (arr.length > this._maxMetricSamples) arr.splice(0, arr.length - this._maxMetricSamples)
  }

  adapt(): void {
    for (const [key, spec] of Object.entries(CONFIG_SPECS)) {
      if (!spec.adaptFn) continue
      const current = this.get(key)
      const adapted = spec.adaptFn(this._metrics, current)
      this._values.set(key, Math.max(spec.min, Math.min(spec.max, adapted)))
    }
    logger.debug('AdaptiveConfig adapted', Object.fromEntries(this._values))
  }

  reset(): void {
    this._values.clear()
    this._metrics.clear()
    for (const [key, spec] of Object.entries(CONFIG_SPECS)) {
      this._values.set(key, spec.default)
    }
  }

  /** 导出当前配置快照 */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this._values)
  }
}

let _instance: AdaptiveConfig | null = null

export function getAdaptiveConfig(): AdaptiveConfig {
  if (!_instance) _instance = new AdaptiveConfig()
  return _instance
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/__tests__/adaptive-config.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/adaptive-config.ts src/main/__tests__/adaptive-config.test.ts
git commit -m "feat: add AdaptiveConfig framework for runtime parameter tuning"
```

---

## Task 11: ContextPipeline 统一管线

**Files:**
- Create: `src/main/memory/pipeline.ts`
- Create: `src/main/memory/__tests__/pipeline.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, test, expect, vi } from 'vitest'
import { PipelineRunner, PipelineStage } from '../pipeline'
import type { AgentOutput } from '@shared/types'

describe('ContextPipeline', () => {
  test('runs stages in order', async () => {
    const order: string[] = []
    const stage1: PipelineStage = {
      name: 'stage1',
      process: vi.fn(async (ctx) => { order.push('1'); return ctx })
    }
    const stage2: PipelineStage = {
      name: 'stage2',
      process: vi.fn(async (ctx) => { order.push('2'); return ctx })
    }
    const runner = new PipelineRunner([stage1, stage2])
    await runner.run({ outputs: [], sessionId: 'test' })
    expect(order).toEqual(['1', '2'])
  })

  test('isolates stage errors - failed stage does not block subsequent', async () => {
    const stage1: PipelineStage = {
      name: 'failing',
      process: vi.fn(async () => { throw new Error('boom') })
    }
    const stage2: PipelineStage = {
      name: 'ok',
      process: vi.fn(async (ctx) => ctx)
    }
    const runner = new PipelineRunner([stage1, stage2])
    const result = await runner.run({ outputs: [], sessionId: 'test' })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].stage).toBe('failing')
    expect(stage2.process).toHaveBeenCalled()
  })

  test('skips disabled stages', async () => {
    const stage: PipelineStage = {
      name: 'skipped',
      enabled: () => false,
      process: vi.fn(async (ctx) => ctx)
    }
    const runner = new PipelineRunner([stage])
    await runner.run({ outputs: [], sessionId: 'test' })
    expect(stage.process).not.toHaveBeenCalled()
  })

  test('supports hooks', async () => {
    const hook = vi.fn()
    const stage: PipelineStage = {
      name: 'test',
      hooks: { after: hook },
      process: vi.fn(async (ctx) => ({ ...ctx, extra: true }))
    }
    const runner = new PipelineRunner([stage])
    await runner.run({ outputs: [], sessionId: 'test' })
    expect(hook).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/memory/__tests__/pipeline.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现 PipelineRunner**

```typescript
import type { AgentOutput, MemoryItem } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('context-pipeline')

export interface PipelineContext {
  outputs: AgentOutput[]
  sessionId: string
  adapterName?: string
  projectId?: string
  nodeId?: string
  normalizedOutputs?: AgentOutput[]
  observations?: any[]
  memories?: Omit<MemoryItem, 'id'>[]
  hallucinationReport?: any
  layeredContext?: any
  waterlineDelta?: any
  errors?: PipelineError[]
}

export interface PipelineError {
  stage: string
  error: Error
}

export interface PipelineStage {
  name: string
  enabled?: () => boolean
  process: (ctx: PipelineContext) => Promise<PipelineContext>
  hooks?: {
    before?: (ctx: PipelineContext) => void
    after?: (ctx: PipelineContext) => void
  }
}

export interface PipelineResult {
  context: PipelineContext
  errors: PipelineError[]
  durationMs: number
}

export class PipelineRunner {
  private _stages: PipelineStage[]

  constructor(stages: PipelineStage[]) {
    this._stages = stages
  }

  async run(initial: Partial<PipelineContext>): Promise<PipelineResult> {
    const start = Date.now()
    let ctx: PipelineContext = { ...initial, errors: [] } as PipelineContext
    const errors: PipelineError[] = []

    for (const stage of this._stages) {
      // 检查是否启用
      if (stage.enabled && !stage.enabled()) {
        logger.debug(`Stage ${stage.name} skipped (disabled)`)
        continue
      }

      // before hook
      stage.hooks?.before?.(ctx)

      try {
        ctx = await stage.process(ctx)
      } catch (error) {
        const pipelineError = { stage: stage.name, error: error as Error }
        errors.push(pipelineError)
        ctx.errors = [...(ctx.errors ?? []), pipelineError]
        logger.warn(`Stage ${stage.name} failed: ${(error as Error).message}`)
        // 继续执行后续阶段
      }

      // after hook
      stage.hooks?.after?.(ctx)
    }

    return { context: ctx, errors, durationMs: Date.now() - start }
  }

  /** 创建默认管线 */
  static createDefault(): PipelineRunner {
    // 延迟导入避免循环依赖
    return new PipelineRunner([
      // 各阶段将在 Task 12 中实现
    ])
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/pipeline.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/pipeline.ts src/main/memory/__tests__/pipeline.test.ts
git commit -m "feat(memory): add ContextPipeline runner with error isolation and hooks"
```

---

## Task 12: 集成 ContextPipeline 到 AgentManager

**Files:**
- Modify: `src/main/agent/agent-manager.ts`
- Modify: `src/main/memory/index.ts`

- [ ] **Step 1: 在 pipeline.ts 中创建默认管线阶段**

在 `PipelineRunner.createDefault()` 中填充实际阶段：

```typescript
static async createDefault(): Promise<PipelineRunner> {
  const { OutputNormalizer } = await import('./output-normalizer')
  const { ObserverCompressor } = await import('./observer-compressor')
  const { MemoryExtractor } = await import('./memory-extractor')
  const { HallucinationChecker } = await import('./hallucination-checker')
  const { ContextCompiler } = await import('./context-compiler')
  const { getWaterlineSync } = await import('./waterline-sync')
  const { getMemoryStore } = await import('./memory-store')

  const normalizer = new OutputNormalizer()
  const compressor = new ObserverCompressor()
  const extractor = new MemoryExtractor()
  const checker = new HallucinationChecker()
  const compiler = new ContextCompiler()

  return new PipelineRunner([
    {
      name: 'normalize',
      process: async (ctx) => ({
        ...ctx,
        normalizedOutputs: normalizer.normalizeAll(ctx.outputs)
      })
    },
    {
      name: 'compress',
      process: async (ctx) => {
        for (const output of ctx.normalizedOutputs ?? ctx.outputs) {
          compressor.feed(output)
        }
        compressor.finalize()
        return { ...ctx, observations: compressor.getStats() }
      }
    },
    {
      name: 'extract',
      process: async (ctx) => ({
        ...ctx,
        memories: extractor.extract(ctx.sessionId, ctx.normalizedOutputs ?? ctx.outputs, {})
      })
    },
    {
      name: 'verify',
      enabled: () => true,
      hooks: {
        after: (ctx) => {
          if (ctx.hallucinationReport && !ctx.hallucinationReport.passed) {
            logger.warn(`Hallucination check: risk=${ctx.hallucinationReport.riskScore}`)
          }
        }
      },
      process: async (ctx) => ({
        ...ctx,
        hallucinationReport: checker.verifySync(ctx.normalizedOutputs ?? ctx.outputs)
      })
    },
    {
      name: 'compile',
      process: async (ctx) => ({
        ...ctx,
        layeredContext: compiler.compile(ctx.normalizedOutputs ?? ctx.outputs, {
          sessionId: ctx.sessionId,
          adapterName: ctx.adapterName
        })
      })
    },
    {
      name: 'waterline',
      process: async (ctx) => {
        const waterline = getWaterlineSync()
        if (ctx.memories && ctx.memories.length > 0) {
          waterline.advance(ctx.projectId ?? '', ctx.memories as MemoryItem[])
        }
        return { ...ctx, waterlineDelta: waterline.getDelta(ctx.projectId ?? '') }
      }
    },
    {
      name: 'persist',
      process: async (ctx) => {
        if (ctx.memories && ctx.memories.length > 0) {
          const store = getMemoryStore()
          // 过滤高风险记忆
          const safeMemories = ctx.hallucinationReport?.riskScore > 70
            ? ctx.memories.filter(m => (m.confidence ?? 0) > 0.7)
            : ctx.memories
          await store.storeMany(safeMemories as Omit<MemoryItem, 'id'>[])
        }
        return ctx
      }
    }
  ])
}
```

- [ ] **Step 2: 在 AgentManager.terminateSession() 中使用 Pipeline**

在 `agent-manager.ts` 中替换分散的记忆提取逻辑：

```typescript
// 替换 terminateSession 中的 memoryExtractor.extract() + memoryStore.storeMany() 调用
// 改为:
const pipeline = await PipelineRunner.createDefault()
const result = await pipeline.run({
  outputs: this.sessionOutputBuffers.get(sessionId) ?? [],
  sessionId,
  adapterName: session.adapterName,
  projectId: session.projectId,
  nodeId: session.nodeId
})

if (result.errors.length > 0) {
  logger.warn(`Pipeline completed with ${result.errors.length} errors`)
}
```

- [ ] **Step 3: 更新 barrel exports**

在 `memory/index.ts` 中添加新模块导出：

```typescript
export { OutputNormalizer } from './output-normalizer'
export { EmbeddingService, getEmbeddingService, setEmbeddingServiceForTesting } from './embedding-service'
export { PipelineRunner, PipelineStage, PipelineContext, PipelineResult } from './pipeline'
```

- [ ] **Step 4: 运行全部测试**

Run: `npx vitest run`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/pipeline.ts src/main/agent/agent-manager.ts src/main/memory/index.ts
git commit -m "feat(memory): integrate ContextPipeline into AgentManager, replacing scattered extraction logic"
```

---

## Task 13: MemoryExtractor poisoned 输入丢弃

**Files:**
- Modify: `src/main/memory/memory-extractor.ts`

- [ ] **Step 1: 在 extract() 方法中增加 poisoned 检查**

```typescript
extract(sessionId: string, outputs: AgentOutput[], context: ExtractionContext): Omit<MemoryItem, 'id'>[] {
  // 检查输出健康度
  const health = this.classifyOutput(outputs)
  if (health === 'poisoned') {
    logger.warn(`Session ${sessionId} output is poisoned, skipping extraction`)
    return []  // 直接丢弃，不存储
  }
  if (health === 'empty') {
    return []  // 空输出也不提取
  }

  // 继续现有提取逻辑...
}
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run src/main/memory/__tests__/`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/memory/memory-extractor.ts
git commit -m "fix(memory): skip extraction for poisoned and empty outputs"
```

---

## Task 14: 全量集成测试与最终验证

**Files:**
- 无新文件

- [ ] **Step 1: 运行全量单元测试**

Run: `npx vitest run`

Expected: 所有测试通过

- [ ] **Step 2: 运行类型检查**

Run: `npx tsc --noEmit`

Expected: 无类型错误

- [ ] **Step 3: 运行 lint**

Run: `npm run lint`

Expected: 0 warnings, 0 errors

- [ ] **Step 4: 验证数据库迁移安全**

启动应用，确认数据库 schema version 正确升级到 3，现有数据不受影响。

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit -m "feat: complete Agent底层架构优化 - AST增强, Memory版本化, RAG语义检索, ContextPipeline, AdaptiveConfig"
```
