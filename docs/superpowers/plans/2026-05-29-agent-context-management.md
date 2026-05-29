# Agent Context Management System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "Agent 输入框" right-click bug and build a context management system that resolves `ContextRef` into actual content injected into Agent prompts, with token budget control.

**Architecture:** A new `ContextResolver` (main process) takes `ContextRef[]` and resolves them to content strings — node metadata from DB, file contents from fs. The resolved context is injected into `BaseAdapter.buildScopePrompt()`. On the renderer side, `appStore` carries an `initialAgentContext` from the file tree right-click to pre-attach it in `AgentChatPanel`.

**Tech Stack:** TypeScript, Vitest, Node.js `fs/promises`, existing Zustand stores, existing BaseAdapter/IPC layer.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | Add `source` field to `ContextRef`, add `ResolvedContext` interface |
| `src/main/context-resolver.ts` | Create | Resolve `ContextRef[]` → `ResolvedContext[]` with token budget |
| `src/main/__tests__/context-resolver.test.ts` | Create | Unit tests for ContextResolver |
| `src/main/adapters/base.ts` | Modify | Accept `ResolvedContext[]` in `buildScopePrompt` |
| `src/main/agent/agent-manager.ts` | Modify | Call ContextResolver before adapter.sendCommand |
| `src/main/ipc-handlers.ts` | Modify | Pass GraphRepository to AgentManager |
| `src/renderer/store/appStore.ts` | Modify | Add `initialAgentContext` + setter/clearer |
| `src/renderer/panels/FileTreeContextMenu.tsx` | Modify | Fix `handleAgentInput` to set `initialAgentContext` |
| `src/renderer/components/agent/AgentChatPanel.tsx` | Modify | Consume `initialAgentContext` on mount/panel switch |

---

### Task 1: Extend shared types — `ContextRef.source` + `ResolvedContext`

**Files:**
- Modify: `src/shared/types.ts:182-186`

- [ ] **Step 1: Add `source` to `ContextRef` and new `ResolvedContext` interface**

In `src/shared/types.ts`, replace the existing `ContextRef` interface (lines 182-186) and add `ResolvedContext` right after it:

```ts
/** 上下文引用（节点或文件） */
export interface ContextRef {
  type: 'node' | 'file'
  id: string
  label: string
  /** 上下文来源 */
  source?: 'user-attach' | 'right-click' | 'mention' | 'auto-scope'
}

/** 已解析的上下文（含实际内容，用于注入 prompt） */
export interface ResolvedContext {
  type: 'node' | 'file'
  id: string
  label: string
  content: string
  tokenEstimate: number
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: extend ContextRef with source field, add ResolvedContext type"
```

---

### Task 2: ContextResolver — core resolution logic

**Files:**
- Create: `src/main/context-resolver.ts`
- Test: `src/main/__tests__/context-resolver.test.ts`

- [ ] **Step 1: Write failing tests for ContextResolver**

Create `src/main/__tests__/context-resolver.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContextResolver, estimateTokens, truncateToBudget } from '../context-resolver'
import type { ContextRef, GraphNode } from '@shared/types'

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { readFile } from 'node:fs/promises'

describe('estimateTokens', () => {
  it('estimates ~4 chars per token for mixed content', () => {
    const text = 'a'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('truncateToBudget', () => {
  it('returns full text if within budget', () => {
    const text = 'short text'
    expect(truncateToBudget(text, 1000)).toBe(text)
  })

  it('truncates and appends marker when over budget', () => {
    const text = 'a'.repeat(1000)
    const result = truncateToBudget(text, 100) // 100 tokens = 400 chars
    expect(result.length).toBeLessThan(text.length)
    expect(result).toContain('[truncated]')
  })
})

describe('ContextResolver', () => {
  let resolver: ContextResolver

  beforeEach(() => {
    resolver = new ContextResolver()
    vi.clearAllMocks()
  })

  it('returns empty array for empty refs', async () => {
    const result = await resolver.resolve([], 8000)
    expect(result).toEqual([])
  })

  it('resolves node ref by loading from provided node map', async () => {
    const nodes: GraphNode[] = [
      {
        id: 'node_1',
        type: 'feature',
        status: 'draft',
        title: 'Login Feature',
        description: 'User login flow',
        acceptanceCriteria: ['User can login with email'],
        graphId: 'graph_1',
        graphType: 'online',
        rules: [{ id: 'r1', title: 'Must validate email', description: '', condition: '', action: '' }],
        position: { x: 0, y: 0 },
        createdAt: '',
        updatedAt: '',
      },
    ]

    const refs: ContextRef[] = [{ type: 'node', id: 'node_1', label: 'Login Feature' }]
    const result = await resolver.resolve(refs, 8000, { nodes })

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('node')
    expect(result[0].content).toContain('Login Feature')
    expect(result[0].content).toContain('User login flow')
    expect(result[0].content).toContain('Must validate email')
    expect(result[0].content).toContain('User can login with email')
    expect(result[0].tokenEstimate).toBeGreaterThan(0)
  })

  it('resolves file ref by reading file content', async () => {
    vi.mocked(readFile).mockResolvedValue('const x = 1\nconsole.log(x)')

    const refs: ContextRef[] = [{ type: 'file', id: '/src/main.ts', label: 'main.ts' }]
    const result = await resolver.resolve(refs, 8000, { basePath: '/project' })

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('file')
    expect(result[0].content).toContain('const x = 1')
    expect(readFile).toHaveBeenCalledWith('/src/main.ts', 'utf-8')
  })

  it('handles file read errors gracefully', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'))

    const refs: ContextRef[] = [{ type: 'file', id: '/missing.ts', label: 'missing.ts' }]
    const result = await resolver.resolve(refs, 8000, { basePath: '/project' })

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('无法读取')
  })

  it('truncates file content to respect token budget', async () => {
    const bigContent = 'x'.repeat(40000) // ~10000 tokens
    vi.mocked(readFile).mockResolvedValue(bigContent)

    const refs: ContextRef[] = [{ type: 'file', id: '/big.ts', label: 'big.ts' }]
    const result = await resolver.resolve(refs, 500, { basePath: '/project' }) // 500 tokens budget

    expect(result[0].tokenEstimate).toBeLessThanOrEqual(500)
    expect(result[0].content.length).toBeLessThan(bigContent.length)
  })

  it('skips unknown node id gracefully', async () => {
    const refs: ContextRef[] = [{ type: 'node', id: 'nonexistent', label: 'Ghost' }]
    const result = await resolver.resolve(refs, 8000, { nodes: [] })

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('节点未找到')
  })

  it('respects priority: nodes before files when budget is tight', async () => {
    vi.mocked(readFile).mockResolvedValue('file content here')
    const nodes: GraphNode[] = [
      {
        id: 'node_1', type: 'feature', status: 'draft', title: 'Important',
        description: 'Critical context', graphId: 'g1', graphType: 'online',
        position: { x: 0, y: 0 }, createdAt: '', updatedAt: '',
      },
    ]

    const refs: ContextRef[] = [
      { type: 'file', id: '/a.ts', label: 'a.ts' },
      { type: 'node', id: 'node_1', label: 'Important' },
    ]

    const result = await resolver.resolve(refs, 8000, { nodes, basePath: '/project' })
    expect(result).toHaveLength(2)
    // Node should be first (higher priority)
    expect(result[0].type).toBe('node')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/context-resolver.test.ts`
Expected: FAIL — module `../context-resolver` not found.

- [ ] **Step 3: Implement ContextResolver**

Create `src/main/context-resolver.ts`:

```ts
/**
 * Context Resolver
 *
 * 将轻量 ContextRef 解析为包含实际内容的 ResolvedContext。
 * 用于注入到 Agent prompt 中，提供业务上下文。
 *
 * 设计原则：
 * - 节点上下文优先级高于文件（业务语义 > 代码片段）
 * - Token 预算机制防止 context window 溢出
 * - 文件内容截取前 N 行，而非全量读取
 */

import { readFile } from 'node:fs/promises'
import type { ContextRef, ResolvedContext, GraphNode } from '@shared/types'

/** 每个 token 约 4 个字符（中英混合估算） */
const CHARS_PER_TOKEN = 4

/** 文件内容最大读取行数 */
const MAX_FILE_LINES = 100

/** 文件内容最大字符数 */
const MAX_FILE_CHARS = 16000

/**
 * 粗估文本的 token 数
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 截断文本到指定 token 预算
 */
export function truncateToBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n[truncated — content exceeds context budget]'
}

export interface ResolveOptions {
  /** 用于解析 node refs 的节点列表（从 DB 或 store 获取） */
  nodes?: GraphNode[]
  /** 文件路径解析的基准目录 */
  basePath?: string
}

export class ContextResolver {
  /**
   * 解析 ContextRef[] 为 ResolvedContext[]
   * @param refs - 上下文引用列表
   * @param budget - token 预算上限
   * @param options - 解析选项
   */
  async resolve(
    refs: ContextRef[],
    budget: number,
    options: ResolveOptions = {},
  ): Promise<ResolvedContext[]> {
    if (refs.length === 0) return []

    // 按优先级排序：node > file
    const sorted = [...refs].sort((a, b) => {
      const priority = { node: 0, file: 1 }
      return (priority[a.type] ?? 2) - (priority[b.type] ?? 2)
    })

    const results: ResolvedContext[] = []
    let remaining = budget

    for (const ref of sorted) {
      if (remaining <= 0) break

      const rawContent = ref.type === 'node'
        ? this.resolveNode(ref, options.nodes ?? [])
        : await this.resolveFile(ref)

      const content = truncateToBudget(rawContent, remaining)
      const tokenEstimate = estimateTokens(content)

      results.push({
        type: ref.type,
        id: ref.id,
        label: ref.label,
        content,
        tokenEstimate,
      })

      remaining -= tokenEstimate
    }

    return results
  }

  private resolveNode(ref: ContextRef, nodes: GraphNode[]): string {
    const node = nodes.find((n) => n.id === ref.id)
    if (!node) return `[节点未找到: ${ref.label}]`

    const lines: string[] = []

    lines.push(`节点: ${node.title} (${node.type})`)
    if (node.description) lines.push(`描述: ${node.description}`)

    if (node.rules && node.rules.length > 0) {
      lines.push('业务规则:')
      for (const rule of node.rules) {
        lines.push(`  - ${rule.title}`)
        if (rule.condition) lines.push(`    条件: ${rule.condition}`)
        if (rule.action) lines.push(`    动作: ${rule.action}`)
      }
    }

    if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
      lines.push('验收标准:')
      for (const criteria of node.acceptanceCriteria) {
        lines.push(`  - ${criteria}`)
      }
    }

    if (node.metadata) {
      if (node.metadata.apis && node.metadata.apis.length > 0) {
        lines.push('APIs: ' + node.metadata.apis.map((a) => a.name).join(', '))
      }
      if (node.metadata.services && node.metadata.services.length > 0) {
        lines.push('Services: ' + node.metadata.services.map((s) => s.name).join(', '))
      }
      if (node.metadata.entities && node.metadata.entities.length > 0) {
        lines.push('Entities: ' + node.metadata.entities.map((e) => e.name).join(', '))
      }
    }

    return lines.join('\n')
  }

  private async resolveFile(ref: ContextRef): Promise<string> {
    try {
      const content = await readFile(ref.id, 'utf-8')
      const lines = content.split('\n')

      if (lines.length > MAX_FILE_LINES) {
        const truncated = lines.slice(0, MAX_FILE_LINES).join('\n')
        return `${truncated}\n\n[文件共 ${lines.length} 行，仅显示前 ${MAX_FILE_LINES} 行]`
      }

      if (content.length > MAX_FILE_CHARS) {
        return content.slice(0, MAX_FILE_CHARS) + `\n\n[文件内容过长，已截断]`
      }

      return content
    } catch {
      return `[无法读取文件: ${ref.label} (${ref.id})]`
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/context-resolver.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/context-resolver.ts src/main/__tests__/context-resolver.test.ts
git commit -m "feat: add ContextResolver with token budget and file/node resolution"
```

---

### Task 3: Inject ResolvedContext into BaseAdapter.buildScopePrompt

**Files:**
- Modify: `src/main/adapters/base.ts:472-532`
- Test: `src/main/__tests__/adapter.test.ts`

- [ ] **Step 1: Add test for buildScopePrompt with ResolvedContext**

Append to `src/main/__tests__/adapter.test.ts` (at the end of the file, before any closing brackets):

```ts
describe('buildScopePrompt with resolved contexts', () => {
  let adapter: TestAdapter

  beforeEach(() => {
    adapter = new TestAdapter()
  })

  it('appends resolved contexts to scope prompt', () => {
    const config: AgentSessionConfig = {
      workingDirectory: '/test',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test Node',
      acceptanceCriteria: [],
    }

    const resolved = [
      {
        type: 'node' as const,
        id: 'n1',
        label: 'Login',
        content: '节点: Login (feature)\n描述: Login flow',
        tokenEstimate: 10,
      },
      {
        type: 'file' as const,
        id: '/src/auth.ts',
        label: 'auth.ts',
        content: 'export function login() {}',
        tokenEstimate: 5,
      },
    ]

    const prompt = adapter.testBuildScopePrompt(config, resolved)

    expect(prompt).toContain('# 业务节点：Test Node')
    expect(prompt).toContain('## 附加上下文')
    expect(prompt).toContain('### Login (node)')
    expect(prompt).toContain('Login flow')
    expect(prompt).toContain('### auth.ts (file)')
    expect(prompt).toContain('export function login')
  })

  it('does not add context section when resolved is empty', () => {
    const config: AgentSessionConfig = {
      workingDirectory: '/test',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test Node',
      acceptanceCriteria: [],
    }

    const prompt = adapter.testBuildScopePrompt(config, [])
    expect(prompt).not.toContain('## 附加上下文')
  })
})
```

Also update the `TestAdapter` class to expose `buildScopePrompt`:

Add this method inside the `TestAdapter` class body (after the existing `getScp` method):

```ts
testBuildScopePrompt(
  config: import('@shared/types').AgentSessionConfig,
  resolvedContexts?: import('@shared/types').ResolvedContext[],
): string {
  return this.buildScopePrompt(config, resolvedContexts)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/adapter.test.ts`
Expected: FAIL — `buildScopePrompt` does not accept second argument.

- [ ] **Step 3: Update BaseAdapter.buildScopePrompt**

In `src/main/adapters/base.ts`, modify `buildScopePrompt` (line 472). Add the import for `ResolvedContext` at the top of the file (add to existing import from `@shared/types`):

```ts
import type {
  AgentAdapter,
  AgentSession,
  AgentSessionConfig,
  AgentCommand,
  AgentOutput,
  ResolvedContext,
} from '@shared/types'
```

Then update the method signature and add context injection at the end:

```ts
protected buildScopePrompt(config: AgentSessionConfig, resolvedContexts?: ResolvedContext[]): string {
    const lines: string[] = []

    lines.push(`# 业务节点：${config.nodeTitle}`)
    lines.push('')

    if (config.acceptanceCriteria.length > 0) {
      lines.push('## 验收标准')
      for (const criteria of config.acceptanceCriteria) {
        lines.push(`- ${criteria}`)
      }
      lines.push('')
    }

    if (config.allowedFiles.length > 0) {
      lines.push('## 允许修改的文件（白名单）')
      for (const file of config.allowedFiles) {
        lines.push(`- ${file}`)
      }
      lines.push('')
    }

    if (config.forbiddenFiles.length > 0) {
      lines.push('## 禁止修改的文件（黑名单）')
      for (const file of config.forbiddenFiles) {
        lines.push(`- ${file}`)
      }
      lines.push('')
    }

    if (config.invariantRules.length > 0) {
      lines.push('## 业务不变量')
      for (const rule of config.invariantRules) {
        lines.push(`- ${rule}`)
      }
      lines.push('')
    }

    if (config.upstreamContext) {
      lines.push('## 上游契约')
      lines.push(config.upstreamContext)
      lines.push('')
    }

    if (config.downstreamContext) {
      lines.push('## 下游契约')
      lines.push(config.downstreamContext)
      lines.push('')
    }

    if (config.bugContext && config.bugContext.length > 0) {
      lines.push('## 待修复 Bug')
      for (const bug of config.bugContext) {
        lines.push(`### ${bug.title} [${bug.severity}]`)
        lines.push(bug.description)
        lines.push('')
      }
    }

    // 注入已解析的上下文
    if (resolvedContexts && resolvedContexts.length > 0) {
      lines.push('## 附加上下文')
      for (const ctx of resolvedContexts) {
        lines.push(`### ${ctx.label} (${ctx.type})`)
        lines.push(ctx.content)
        lines.push('')
      }
    }

    return lines.join('\n')
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/adapter.test.ts`
Expected: All tests PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/base.ts src/main/__tests__/adapter.test.ts
git commit -m "feat: inject ResolvedContext into buildScopePrompt"
```

---

### Task 4: Integrate ContextResolver into AgentManager

**Files:**
- Modify: `src/main/agent/agent-manager.ts`

- [ ] **Step 1: Read AgentManager to understand its structure**

Read `src/main/agent/agent-manager.ts` and identify:
- The `sendCommand` method
- The `startSession` method
- Constructor and dependencies

- [ ] **Step 2: Add ContextResolver dependency and resolve before sendCommand**

In `src/main/agent/agent-manager.ts`:

1. Add import at top:
```ts
import { ContextResolver } from '../context-resolver'
import type { ContextRef, ResolvedContext } from '@shared/types'
```

2. Add `contextResolver` as a class field and initialize in constructor:
```ts
private contextResolver = new ContextResolver()
```

3. Add a new method `resolveAndSendCommand` that resolves context then delegates to the existing `sendCommand`:

```ts
/**
 * 解析上下文并发送指令
 * 在发送前将 ContextRef[] 解析为 ResolvedContext[]，
 * 注入到 adapter 的 scope prompt 中。
 */
async resolveAndSendCommand(
  sessionId: string,
  command: import('@shared/types').AgentCommand,
  contextRefs?: ContextRef[],
  nodes?: import('@shared/types').GraphNode[],
): Promise<void> {
  let resolvedContexts: ResolvedContext[] = []

  if (contextRefs && contextRefs.length > 0) {
    resolvedContexts = await this.contextResolver.resolve(contextRefs, 8000, {
      nodes: nodes ?? [],
    })
  }

  // Store resolved contexts on the session so adapter can access them
  const session = this.getSession(sessionId)
  if (session) {
    session.resolvedContexts = resolvedContexts
  }

  await this.sendCommand(sessionId, command)
}
```

4. Modify the `sendCommand` method to pass resolved contexts to the adapter:

```ts
async sendCommand(sessionId: string, command: AgentCommand): Promise<void> {
  const adapter = this.findAdapterForSession(sessionId)
  if (!adapter) throw new SessionNotFoundError(sessionId)
  // ResolvedContexts are stored on the session object
  await adapter.sendCommand(sessionId, command)
}
```

Note: The actual injection happens in the adapter's `doSendCommand` via `buildScopePrompt(config, resolvedContexts)`. We need the adapter to access `resolvedContexts` from the session. See Task 5.

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/agent-manager.ts
git commit -m "feat: add resolveAndSendCommand to AgentManager with ContextResolver"
```

---

### Task 5: Update ClaudeCodeAdapter to pass resolved contexts

**Files:**
- Modify: `src/main/adapters/claude-code.ts:50-53`

- [ ] **Step 1: Update doSendCommand to use resolved contexts**

In `src/main/adapters/claude-code.ts`, update the `doSendCommand` method:

```ts
protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const scopePrompt = this.buildScopePrompt(session.config, session.resolvedContexts)
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`

    // ... rest unchanged
```

Also add `ResolvedContext` to the import from `@shared/types`:

```ts
import type { AgentSession, AgentSessionConfig, AgentCommand, ResolvedContext } from '@shared/types'
```

- [ ] **Step 2: Add `resolvedContexts` to AgentSession type**

In `src/shared/types.ts`, add to the `AgentSession` interface (around line 240):

```ts
export interface AgentSession {
  id: string
  pid?: number
  adapterName: string
  config: AgentSessionConfig
  startTime: number
  /** 运行时注入的已解析上下文（不持久化） */
  resolvedContexts?: ResolvedContext[]
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/adapters/claude-code.ts src/shared/types.ts
git commit -m "feat: pass resolved contexts through session to buildScopePrompt"
```

---

### Task 6: Wire IPC — expose `agent:resolveAndSendCommand`

**Files:**
- Modify: `src/main/ipc/agent.ts`
- Modify: `src/main/services/agent-service.ts`
- Modify: `src/shared/types.ts` (IpcApi)

- [ ] **Step 1: Add IPC channel signature to IpcApi**

In `src/shared/types.ts`, find the `IpcApi` interface and add:

```ts
'agent:resolveAndSendCommand': (sessionId: string, command: AgentCommand, contextRefs: ContextRef[], nodeIds: string[]) => Promise<void>
```

- [ ] **Step 2: Add method to AgentService**

In `src/main/services/agent-service.ts`, add:

```ts
async resolveAndSendCommand(
  sessionId: string,
  command: import('@shared/types').AgentCommand,
  contextRefs: import('@shared/types').ContextRef[],
  nodeIds: string[],
): Promise<void> {
  // Resolve node IDs to GraphNode objects
  // For now, pass empty nodes — node content comes from ContextRef label
  // Full node resolution happens when GraphRepository is available
  return this.agentManager.resolveAndSendCommand(sessionId, command, contextRefs)
}
```

- [ ] **Step 3: Register IPC handler**

In `src/main/ipc/agent.ts`, add:

```ts
typedHandle('agent:resolveAndSendCommand', async (_, sessionId, command, contextRefs, nodeIds) => {
  return agentService.resolveAndSendCommand(sessionId, command, contextRefs, nodeIds)
})
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/services/agent-service.ts src/main/ipc/agent.ts
git commit -m "feat: wire IPC for agent:resolveAndSendCommand"
```

---

### Task 7: Fix "Agent 输入框" — appStore + FileTreeContextMenu

**Files:**
- Modify: `src/renderer/store/appStore.ts`
- Modify: `src/renderer/panels/FileTreeContextMenu.tsx:115-119`

- [ ] **Step 1: Add `initialAgentContext` to appStore**

Replace `src/renderer/store/appStore.ts` entirely:

```ts
import { create } from 'zustand'
import type { ContextRef } from '@shared/types'

interface AppState {
  activeRightPanel: 'node' | 'agent'
  agentWorkingDirectory: string | null
  /** 从文件树右键注入的初始上下文 */
  initialAgentContext: ContextRef | null
  setActiveRightPanel: (tab: 'node' | 'agent') => void
  setAgentWorkingDirectory: (dir: string | null) => void
  setInitialAgentContext: (ctx: ContextRef | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeRightPanel: 'node',
  agentWorkingDirectory: null,
  initialAgentContext: null,
  setActiveRightPanel: (tab) => set({ activeRightPanel: tab }),
  setAgentWorkingDirectory: (dir) => set({ agentWorkingDirectory: dir }),
  setInitialAgentContext: (ctx) => set({ initialAgentContext: ctx }),
}))
```

- [ ] **Step 2: Update handleAgentInput in FileTreeContextMenu**

In `src/renderer/panels/FileTreeContextMenu.tsx`, replace the `handleAgentInput` function (lines 115-119):

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

Add `setInitialAgentContext` to the destructured store selectors at the top of the component (around line 42-43):

```ts
const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)
const setAgentWorkingDirectory = useAppStore((s) => s.setAgentWorkingDirectory)
const setInitialAgentContext = useAppStore((s) => s.setInitialAgentContext)
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/appStore.ts src/renderer/panels/FileTreeContextMenu.tsx
git commit -m "fix: wire right-click 'Agent 输入框' to inject file context into AgentChatPanel"
```

---

### Task 8: AgentChatPanel — consume initialAgentContext

**Files:**
- Modify: `src/renderer/components/agent/AgentChatPanel.tsx`

- [ ] **Step 1: Add effect to consume initialAgentContext and auto-create thread if needed**

In `src/renderer/components/agent/AgentChatPanel.tsx`, add the import and effect:

Add to imports at top of file:

```ts
import { useAppStore } from '../../store/appStore'
```

Inside the `AgentChatPanel` function, after the existing `useEffect` hooks (after the `streamingMsgIdRef` reset effect around line 184), add:

```ts
// Consume initialAgentContext from file tree right-click
const initialAgentContext = useAppStore((s) => s.initialAgentContext)
const setInitialAgentContext = useAppStore((s) => s.setInitialAgentContext)

useEffect(() => {
  if (!initialAgentContext) return

  setAttachedContexts((prev) => {
    if (prev.some((c) => c.id === initialAgentContext.id)) return prev
    return [...prev, initialAgentContext]
  })

  // Auto-create a thread if none exists — ContextBar only renders when currentThread is set
  if (!currentThreadId && selectedAdapter) {
    createThread(selectedAdapter, selectedNode?.id)
  }

  setInitialAgentContext(null) // consume and clear
}, [initialAgentContext, setInitialAgentContext, currentThreadId, selectedAdapter, createThread, selectedNode])
```

**Why auto-create thread:** The `ContextBar` component only renders when `currentThread` exists (line 291: `{currentThread && ( <ContextBar ... /> )}`). Without a thread, the context chip is invisible — the user sees no feedback. Auto-creating the thread ensures the ContextBar renders and the green file chip is visible immediately.

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/agent/AgentChatPanel.tsx
git commit -m "feat: AgentChatPanel consumes initialAgentContext from file tree right-click"
```

---

### Task 9: Update sendMessage to use resolveAndSendCommand

**Files:**
- Modify: `src/renderer/store/agentStore.ts:128-196`

- [ ] **Step 1: Update sendMessage to pass contextRefs to IPC**

In `src/renderer/store/agentStore.ts`, update the `sendMessage` method. Replace the IPC call section (around lines 165-180):

```ts
    try {
      const result = await window.electronAPI['agent:startSession'](thread.adapterName, config)

      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, sessionId: result.sessionId } : t,
        ),
      }))

      const command: AgentCommand = {
        type: 'implement',
        description: content,
        targetNodeId: thread.nodeBound ?? '',
      }

      // Use resolveAndSendCommand if contextRefs exist, otherwise fall back to sendCommand
      if (contextRefs && contextRefs.length > 0) {
        const nodeIds = contextRefs.filter((r) => r.type === 'node').map((r) => r.id)
        await window.electronAPI['agent:resolveAndSendCommand'](
          result.sessionId,
          command,
          contextRefs,
          nodeIds,
        )
      } else {
        await window.electronAPI['agent:sendCommand'](result.sessionId, command)
      }
    } catch (err) {
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/store/agentStore.ts
git commit -m "feat: sendMessage passes contextRefs to resolveAndSendCommand IPC"
```

---

### Task 10: End-to-end verification + lint

**Files:**
- No new files

- [ ] **Step 1: Run all unit tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: 0 warnings, 0 errors.

- [ ] **Step 4: Manual smoke test**

1. `npm run dev`
2. Open a project with a mind map
3. Right-click a file in the file tree → "Agent 输入框"
4. Verify: Agent panel opens, file appears as a green chip in ContextBar
5. Type a message and send
6. Verify: Agent prompt includes the file content under "## 附加上下文"

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete Agent context management system with right-click fix"
```
