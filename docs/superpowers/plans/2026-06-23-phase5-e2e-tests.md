# Phase 5 E2E Playwright 测试

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Phase 5 新增的 UI 流程（Fan-out 子代理、子智能体面板、画布多选）补全 Playwright E2E 测试，使用 mock IPC 替代真实 LLM/适配器。

**Architecture:** 沿用现有 `webServer: npm run dev` 浏览器测试模式。新增 `tests/e2e/helpers/mock-ipc.ts` 在页面加载前通过 `page.addInitScript()` 注入 `window.electronAPI` mock，覆盖 graph/node/agent/subagent 相关 IPC。测试通过 `data-testid` 选择器驱动 UI，断言页面状态和 mock 调用。

**Tech Stack:** Playwright, TypeScript, Vite dev server

---

## File Structure

| File | Responsibility |
|---|---|
| `src/renderer/components/agent/FanoutPromptDialog.tsx` | 添加 dialog 内部 `data-testid` |
| `src/renderer/components/agent/SubagentInvocationsPanel.tsx` | 添加 panel 内部 `data-testid` |
| `src/renderer/components/agent/SubagentInvocationCard.tsx` | 添加 card 内部 `data-testid` |
| `src/renderer/components/agent/ChatHeader.tsx` | 为 robot 按钮添加 `data-testid` |
| `tests/e2e/helpers/mock-ipc.ts` | Mock IPC API 与状态推进辅助函数 |
| `tests/e2e/fan-out-dialog.spec.ts` | Fan-out dialog 打开、prompt 生成、提交 |
| `tests/e2e/multi-select.spec.ts` | Ctrl+click 多选与视觉高亮 |
| `tests/e2e/subagent-invocations-panel.spec.ts` | 子智能体面板状态流转 |
| `tests/e2e/subagent-dispatch-from-canvas.spec.ts` | 多选节点批量派发 |

---

## Task 1: Add `data-testid` Attributes to Phase 5 Components

**Files:**
- Modify: `src/renderer/components/agent/FanoutPromptDialog.tsx`
- Modify: `src/renderer/components/agent/SubagentInvocationsPanel.tsx`
- Modify: `src/renderer/components/agent/SubagentInvocationCard.tsx`
- Modify: `src/renderer/components/agent/ChatHeader.tsx`

- [ ] **Step 1: FanoutPromptDialog**

```tsx
// DialogContent
data-testid="fanout-dialog"

// textarea
data-testid="fanout-prompt-input"

// Cancel button
data-testid="fanout-cancel-btn"

// Submit button
data-testid="fanout-submit-btn"
```

Apply to the JSX elements in `FanoutPromptDialog.tsx`.

- [ ] **Step 2: SubagentInvocationsPanel**

```tsx
// SheetContent
data-testid="subagent-panel"

// empty state div
data-testid="subagent-empty"

// invocation list container
data-testid="subagent-list"
```

- [ ] **Step 3: SubagentInvocationCard**

```tsx
// root div
data-testid={`subagent-card-${invocationId}`}

// status badge
data-testid="subagent-card-status"

// cancel button (only when active)
data-testid="subagent-card-cancel"

// result container (when completed)
data-testid="subagent-card-result"
```

- [ ] **Step 4: ChatHeader robot button**

```tsx
// in ChatHeader.tsx, around the onOpenSubagents button:
data-testid="chat-header-subagents-btn"
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/agent/FanoutPromptDialog.tsx \
  src/renderer/components/agent/SubagentInvocationsPanel.tsx \
  src/renderer/components/agent/SubagentInvocationCard.tsx \
  src/renderer/components/agent/ChatHeader.tsx
git commit -m "test(e2e): add data-testid to Phase 5 UI components"
```

---

## Task 2: Create `mock-ipc.ts` Helper

**Files:**
- Create: `tests/e2e/helpers/mock-ipc.ts`

- [ ] **Step 1: Implement helper**

```typescript
import type { Page } from '@playwright/test'

export const MOCK_GRAPH_ID = 'graph_e2e_001'
export const MOCK_NODE_MODULE_ID = 'node_e2e_module_001'
export const MOCK_NODE_PROCESS_ID = 'node_e2e_process_001'
export const MOCK_INVOCATION_ID = 'inv_test_001'
export const MOCK_SESSION_ID = 'session_e2e_001'

type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export async function setupMockIpc(page: Page, options?: { initialStatus?: SubagentStatus }) {
  await page.addInitScript((opts: { initialStatus: SubagentStatus }) => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

    function emit(channel: string, ...args: unknown[]) {
      for (const cb of listeners[channel] ?? []) {
        cb(...args)
      }
    }

    const mockGraph = {
      id: 'graph_e2e_001',
      name: 'E2E Test Graph',
      type: 'dev',
      projectPath: '/tmp/bizgraph-e2e-project',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const mockNodes = [
      {
        id: 'node_e2e_module_001',
        graphId: 'graph_e2e_001',
        type: 'module',
        title: 'E2E Module',
        description: 'Test module node',
        x: 200,
        y: 300,
        status: 'placeholder',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
        content: {},
      },
      {
        id: 'node_e2e_process_001',
        graphId: 'graph_e2e_001',
        type: 'process',
        title: 'E2E Process',
        description: 'Test process node',
        x: 500,
        y: 300,
        status: 'placeholder',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
        content: {},
      },
    ]

    const mockSubagentTypes = [
      { name: 'explore', displayName: '探索者', description: 'Read-only search', allowedTools: ['Read', 'Glob', 'Grep'], scopeStrategy: 'inherit' },
      { name: 'implement', displayName: '实现者', description: 'Implement feature', allowedTools: '*', scopeStrategy: 'subset' },
    ]

    const mockState = {
      invocationStatus: opts.initialStatus ?? 'queued',
      invocationResultText: null as string | null,
    }

    // Expose mutable state and emit helper for test scripts
    const w = window as unknown as {
      __bizgraphMockState?: typeof mockState
      __bizgraphMockEmit?: typeof emit
    }
    w.__bizgraphMockState = mockState
    w.__bizgraphMockEmit = emit

    const mockApi: Record<string, unknown> = {
      // Graph
      'graph:get': async () => ({ graph: mockGraph, nodes: mockNodes, edges: [], bugs: [] }),
      'graph:list': async () => [mockGraph],
      'graph:create': async ({ name, type }: { name: string; type: string }) => ({ ...mockGraph, name, type }),

      // Node
      'node:create': async (data: Record<string, unknown>) => ({
        ...data,
        id: `node_${Date.now()}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      'node:createBatch': async (items: Record<string, unknown>[]) =>
        items.map((data) => ({ ...data, id: `node_${Date.now()}_${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), updatedAt: Date.now() })),
      'node:update': async (id: string, data: Record<string, unknown>) => ({ ...mockNodes.find((n) => n.id === id), ...data }),
      'node:delete': async () => true,

      // Edge
      'edge:create': async (data: Record<string, unknown>) => ({ ...data, id: `edge_${Date.now()}` }),
      'edge:delete': async () => true,

      // Thread
      'thread:list': async () => [
        {
          id: 'thread_e2e_001',
          adapterName: 'claude-code',
          sessionId: 'session_e2e_001',
          title: 'E2E Thread',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      'thread:create': async ({ adapterName }: { adapterName: string }) => ({
        id: 'thread_e2e_001',
        adapterName,
        sessionId: 'session_e2e_001',
        title: 'E2E Thread',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      'message:list': async () => [],

      // Agent
      'agent:startSession': async () => ({ sessionId: 'session_e2e_001' }),
      'agent:sendCommand': async (_sessionId: string, command: { description: string }) => {
        if (command.description.includes('dispatch_subagent')) {
          setTimeout(() => emit('subagent:progress', { invocationId: 'inv_test_001', status: 'running' }), 50)
          setTimeout(() => {
            emit('subagent:progress', { invocationId: 'inv_test_001', status: 'completed' })
            emit('agent:onOutput', 'session_e2e_001', { type: 'stdout', data: 'E2E subagent result', timestamp: Date.now(), invocationId: 'inv_test_001' })
          }, 100)
        }
      },
      'agent:terminateSession': async () => undefined,
      'agent:listAdapters': async () => [
        { name: 'claude-code', version: '2.0.0', installed: true },
        { name: 'opencode', version: '1.0.0', installed: true },
      ],

      // Subagent
      'subagent:listTypes': async () => mockSubagentTypes,
      'subagent:listInvocations': async () => [
        {
          id: 'inv_test_001',
          parentSessionId: 'session_e2e_001',
          parentMessageId: null,
          graphId: 'graph_e2e_001',
          agentType: 'explore',
          description: 'E2E exploration',
          prompt: 'Explore',
          adapterName: null,
          nodeId: 'node_e2e_module_001',
          allowedFiles: null,
          status: mockState.invocationStatus,
          resultText: mockState.invocationResultText,
          resultFiles: [],
          tokensUsed: 0,
          startedAt: Date.now(),
          finishedAt: mockState.invocationStatus === 'completed' ? Date.now() : null,
          error: null,
        },
      ],
      'subagent:cancel': async () => {
        mockState.invocationStatus = 'cancelled'
        emit('subagent:progress', { invocationId: 'inv_test_001', status: 'cancelled' })
      },
      'subagent:getResult': async () =>
        mockState.invocationStatus === 'completed'
          ? { invocationId: 'inv_test_001', resultText: mockState.invocationResultText ?? 'E2E subagent result', resultFiles: [], tokensUsed: 0, durationMs: 100 }
          : null,

      // Settings
      'settings:read': async () => ({ defaultModel: 'sonnet' }),

      // Event listeners
      onAgentOutput: (cb: (sessionId: string, output: unknown) => void) => {
        listeners['agent:onOutput'] = listeners['agent:onOutput'] ?? []
        listeners['agent:onOutput'].push(cb)
        return () => {
          listeners['agent:onOutput'] = listeners['agent:onOutput'].filter((fn) => fn !== cb)
        }
      },
      onAgentStatusChange: () => () => {},
      onNodeStatusChange: () => () => {},
      onSessionStarted: () => () => {},
      onSessionRecovered: () => () => {},
      onSessionRecoveryFailed: () => () => {},
      onWaterlineChange: () => () => {},
      onSubagentProgress: (cb: (data: unknown) => void) => {
        listeners['subagent:progress'] = listeners['subagent:progress'] ?? []
        listeners['subagent:progress'].push(cb)
        return () => {
          listeners['subagent:progress'] = listeners['subagent:progress'].filter((fn) => fn !== cb)
        }
      },
      onMenuOpenProject: () => () => {},
      platform: 'win32',
    }

    window.electronAPI = mockApi as Window['electronAPI']
  }, { initialStatus: options?.initialStatus ?? 'queued' })
}

export async function setMockInvocationStatus(page: Page, status: SubagentStatus, resultText?: string) {
  await page.evaluate((opts) => {
    const state = (window as unknown as { __bizgraphMockState?: { invocationStatus: SubagentStatus; invocationResultText: string | null } }).__bizgraphMockState
    if (state) {
      state.invocationStatus = opts.status
      if (opts.resultText !== undefined) state.invocationResultText = opts.resultText
    }
  }, { status, resultText })
}

export async function emitSubagentProgress(page: Page, status: SubagentStatus, error?: string) {
  await page.evaluate((opts) => {
    const w = window as unknown as {
      __bizgraphMockState?: { invocationStatus: SubagentStatus; invocationResultText: string | null }
      __bizgraphMockEmit?: (channel: string, ...args: unknown[]) => void
    }
    if (w.__bizgraphMockState) w.__bizgraphMockState.invocationStatus = opts.status
    if (w.__bizgraphMockEmit) {
      w.__bizgraphMockEmit('subagent:progress', { invocationId: 'inv_test_001', status: opts.status, error: opts.error })
    }
  }, { status, error })
}
```

> Note: The mock runs entirely inside the browser page context. Dynamic state changes after `page.goto()` are done through `setMockInvocationStatus` (mutates `window.__bizgraphMockState`) and `emitSubagentProgress` (calls `window.__bizgraphMockEmit`). If the renderer polls `subagent:listInvocations` on panel open, simply mutating the state is enough; if it relies on `onSubagentProgress` events, use `emitSubagentProgress`.

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/helpers/mock-ipc.ts
git commit -m "test(e2e): add mock-ipc helper for Phase 5 tests"
```

---

## Task 3: Write `fan-out-dialog.spec.ts`

**Files:**
- Create: `tests/e2e/fan-out-dialog.spec.ts`

- [ ] **Step 1: Create test file**

```typescript
import { test, expect } from '@playwright/test'
import { waitForCanvas, createNodeViaMenu } from './helpers/graph-helpers'
import { getNodeIds } from './helpers/node-helpers'
import { setupMockIpc, MOCK_NODE_MODULE_ID } from './helpers/mock-ipc'

test.describe('Fan-out Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page)
    await page.goto('http://localhost:5173')
    await waitForCanvas(page)
  })

  test('opens fan-out dialog from node context menu and pre-fills prompt', async ({ page }) => {
    await createNodeViaMenu(page, 'module', { x: 400, y: 300 })
    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(1, { timeout: 5_000 })

    const nodeIds = await getNodeIds(page)
    const node = page.locator(`[data-id="${nodeIds[0]}"]`)
    await node.click({ button: 'right' })
    await page.click('[data-testid="node-menu-fanout"]')

    await expect(page.locator('[data-testid="fanout-dialog"]')).toBeVisible({ timeout: 5_000 })

    const promptInput = page.locator('[data-testid="fanout-prompt-input"]')
    await expect(promptInput).toContainText(MOCK_NODE_MODULE_ID, { timeout: 5_000 })
  })

  test('submits prompt and closes dialog', async ({ page }) => {
    await createNodeViaMenu(page, 'module', { x: 400, y: 300 })
    const nodeIds = await getNodeIds(page)
    const node = page.locator(`[data-id="${nodeIds[0]}"]`)
    await node.click({ button: 'right' })
    await page.click('[data-testid="node-menu-fanout"]')

    await expect(page.locator('[data-testid="fanout-dialog"]')).toBeVisible()

    await page.click('[data-testid="fanout-submit-btn"]')
    await expect(page.locator('[data-testid="fanout-dialog"]')).not.toBeVisible()
  })
})
```

- [ ] **Step 2: Run test**

```bash
npx playwright test tests/e2e/fan-out-dialog.spec.ts
```

Expected: PASS (assuming data-testid added in Task 1 and mock works).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/fan-out-dialog.spec.ts
git commit -m "test(e2e): fan-out dialog flow"
```

---

## Task 4: Write `multi-select.spec.ts`

**Files:**
- Create: `tests/e2e/multi-select.spec.ts`

- [ ] **Step 1: Create test file**

```typescript
import { test, expect } from '@playwright/test'
import { waitForCanvas, createNodeViaMenu } from './helpers/graph-helpers'
import { getNodeIds } from './helpers/node-helpers'
import { setupMockIpc } from './helpers/mock-ipc'

test.describe('Canvas Multi-Select', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page)
    await page.goto('http://localhost:5173')
    await waitForCanvas(page)
  })

  test('Ctrl+click selects multiple nodes and shows purple highlight', async ({ page }) => {
    await createNodeViaMenu(page, 'module', { x: 200, y: 300 })
    await createNodeViaMenu(page, 'process', { x: 500, y: 300 })

    const nodes = page.locator('[data-id].react-flow__node')
    await expect(nodes).toHaveCount(2, { timeout: 5_000 })

    const nodeIds = await getNodeIds(page)
    const first = page.locator(`[data-id="${nodeIds[0]}"]`)
    const second = page.locator(`[data-id="${nodeIds[1]}"]`)

    await first.click()
    await second.click({ modifiers: ['Control'] })

    // Verify both nodes have the multi-select purple ring class
    await expect(first).toHaveClass(/ring-purple-400/)
    await expect(second).toHaveClass(/ring-purple-400/)
  })

  test('fan-out from multi-selected nodes includes both in prompt', async ({ page }) => {
    await createNodeViaMenu(page, 'module', { x: 200, y: 300 })
    await createNodeViaMenu(page, 'process', { x: 500, y: 300 })

    const nodeIds = await getNodeIds(page)
    const first = page.locator(`[data-id="${nodeIds[0]}"]`)
    const second = page.locator(`[data-id="${nodeIds[1]}"]`)

    await first.click()
    await second.click({ modifiers: ['Control'] })

    await first.click({ button: 'right' })
    await page.click('[data-testid="node-menu-fanout"]')

    await expect(page.locator('[data-testid="fanout-dialog"]')).toBeVisible()

    const promptInput = page.locator('[data-testid="fanout-prompt-input"]')
    await expect(promptInput).toContainText(nodeIds[0])
    await expect(promptInput).toContainText(nodeIds[1])
  })
})
```

- [ ] **Step 2: Run test**

```bash
npx playwright test tests/e2e/multi-select.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/multi-select.spec.ts
git commit -m "test(e2e): canvas multi-select and fan-out"
```

---

## Task 5: Write `subagent-invocations-panel.spec.ts`

**Files:**
- Create: `tests/e2e/subagent-invocations-panel.spec.ts`

This test assumes the app can be put into a state where `AgentChatPanel` is visible and has a `currentThread.sessionId`. The simplest path is:
1. Mock `thread:create` and `thread:list` to return a thread bound to `MOCK_SESSION_ID`.
2. Open the agent chat panel if not already visible.
3. Click the robot button to open `SubagentInvocationsPanel`.
4. Assert the mock invocation card renders with the expected status.

- [ ] **Step 1: Extend mock-ipc with thread handlers**

Add to `mockApi` inside `tests/e2e/helpers/mock-ipc.ts`:

```typescript
'thread:list': async () => [
  {
    id: 'thread_e2e_001',
    adapterName: 'claude-code',
    sessionId: MOCK_SESSION_ID,
    title: 'E2E Thread',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
],
'thread:create': async ({ adapterName }: { adapterName: string }) => ({
  id: 'thread_e2e_001',
  adapterName,
  sessionId: MOCK_SESSION_ID,
  title: 'E2E Thread',
  status: 'active',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}),
'message:list': async () => [],
```

- [ ] **Step 2: Create test file**

```typescript
import { test, expect } from '@playwright/test'
import { waitForCanvas } from './helpers/graph-helpers'
import { setupMockIpc, MOCK_INVOCATION_ID, setMockInvocationStatus, emitSubagentProgress } from './helpers/mock-ipc'

test.describe('Subagent Invocations Panel', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page, { initialStatus: 'queued' })
    await page.goto('http://localhost:5173')
    await waitForCanvas(page)
  })

  test('opens panel and shows invocation card', async ({ page }) => {
    // Open the agent chat panel via the UI (assuming a toggle exists)
    // If the panel is already visible, skip this.
    const agentPanelToggle = page.locator('[data-testid="toggle-agent-panel"]')
    if (await agentPanelToggle.isVisible().catch(() => false)) {
      await agentPanelToggle.click()
    }

    // Click the robot button in ChatHeader
    await page.click('[data-testid="chat-header-subagents-btn"]')

    await expect(page.locator('[data-testid="subagent-panel"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator(`[data-testid="subagent-card-${MOCK_INVOCATION_ID}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="subagent-card-${MOCK_INVOCATION_ID}"] [data-testid="subagent-card-status"]`)).toContainText('queued')
  })

  test('updates card status on progress event', async ({ page }) => {
    const agentPanelToggle = page.locator('[data-testid="toggle-agent-panel"]')
    if (await agentPanelToggle.isVisible().catch(() => false)) {
      await agentPanelToggle.click()
    }

    await page.click('[data-testid="chat-header-subagents-btn"]')
    await expect(page.locator(`[data-testid="subagent-card-${MOCK_INVOCATION_ID}"] [data-testid="subagent-card-status"]`)).toContainText('queued')

    await setMockInvocationStatus(page, 'running')
    await emitSubagentProgress(page, 'running')
    await expect(page.locator(`[data-testid="subagent-card-${MOCK_INVOCATION_ID}"] [data-testid="subagent-card-status"]`)).toContainText('running')
  })
})
```

> Note: If the app layout does not expose `chat-header-subagents-btn` without first creating/selecting a thread, the test may need an extra step to select the mocked thread from the thread list. Adjust based on actual UI behavior.

- [ ] **Step 3: Run test**

```bash
npx playwright test tests/e2e/subagent-invocations-panel.spec.ts
```

Expected: PASS after any UI-flow adjustments.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/helpers/mock-ipc.ts tests/e2e/subagent-invocations-panel.spec.ts
git commit -m "test(e2e): subagent invocations panel"
```

---

## Task 6: Write `subagent-dispatch-from-canvas.spec.ts`

**Files:**
- Create: `tests/e2e/subagent-dispatch-from-canvas.spec.ts`

- [ ] **Step 1: Create test file**

```typescript
import { test, expect } from '@playwright/test'
import { waitForCanvas, createNodeViaMenu } from './helpers/graph-helpers'
import { getNodeIds } from './helpers/node-helpers'
import { setupMockIpc } from './helpers/mock-ipc'

test.describe('Subagent Dispatch from Canvas', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIpc(page)
    await page.goto('http://localhost:5173')
    await waitForCanvas(page)
  })

  test('dispatches fan-out for multi-selected nodes', async ({ page }) => {
    await createNodeViaMenu(page, 'module', { x: 200, y: 300 })
    await createNodeViaMenu(page, 'process', { x: 500, y: 300 })

    const nodeIds = await getNodeIds(page)
    const first = page.locator(`[data-id="${nodeIds[0]}"]`)
    const second = page.locator(`[data-id="${nodeIds[1]}"]`)

    await first.click()
    await second.click({ modifiers: ['Control'] })

    await first.click({ button: 'right' })
    await page.click('[data-testid="node-menu-fanout"]')

    await expect(page.locator('[data-testid="fanout-dialog"]')).toBeVisible()
    const promptInput = page.locator('[data-testid="fanout-prompt-input"]')
    await expect(promptInput).toContainText(nodeIds[0])
    await expect(promptInput).toContainText(nodeIds[1])

    await page.click('[data-testid="fanout-submit-btn"]')
    await expect(page.locator('[data-testid="fanout-dialog"]')).not.toBeVisible()
  })
})
```

- [ ] **Step 2: Run test**

```bash
npx playwright test tests/e2e/subagent-dispatch-from-canvas.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/subagent-dispatch-from-canvas.spec.ts
git commit -m "test(e2e): subagent dispatch from multi-selected canvas nodes"
```

---

## Task 7: Run Full E2E Suite

- [ ] **Step 1: Run all E2E tests**

```bash
npm run test:e2e
```

Expected: All existing + new tests PASS.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: no warnings/errors.

- [ ] **Step 3: Final commit if any fixes**

```bash
git add -A
git commit -m "test(e2e): complete Phase 5 E2E coverage" || echo "No changes to commit"
```

---

## Self-Review Checklist

- [ ] All required `data-testid` attributes added.
- [ ] `mock-ipc.ts` covers graph/node/edge/agent/subagent/thread/settings IPC used by Phase 5 UI.
- [ ] 4 new E2E spec files created.
- [ ] Existing E2E tests still pass.
- [ ] Lint passes.
