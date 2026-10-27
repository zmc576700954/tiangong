import type { Page } from '@playwright/test'

export const MOCK_GRAPH_ID = 'graph_e2e_001'
export const MOCK_NODE_MODULE_ID = 'node_e2e_module_001'
export const MOCK_NODE_PROCESS_ID = 'node_e2e_process_001'
export const MOCK_INVOCATION_ID = 'inv_test_001'
export const MOCK_SESSION_ID = 'session_e2e_001'

type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

const defaultMockGraph = {
  id: 'graph_e2e_001',
  name: 'E2E Test Graph',
  type: 'dev',
  projectPath: '/tmp/bizgraph-e2e-project',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

const defaultMockNodes = [
  {
    id: 'node_e2e_module_001',
    graphId: 'graph_e2e_001',
    graphType: 'dev',
    type: 'module',
    title: 'E2E Module',
    description: 'Test module node',
    position: { x: 200, y: 300 },
    status: 'placeholder',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    content: {},
  },
  {
    id: 'node_e2e_process_001',
    graphId: 'graph_e2e_001',
    graphType: 'dev',
    type: 'process',
    title: 'E2E Process',
    description: 'Test process node',
    position: { x: 500, y: 300 },
    status: 'placeholder',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    content: {},
  },
]

/**
 * mock 节点的形状 —— 默认节点 + 可选的 `parentId`。
 *
 * 层级边由 `nodes.parent_id` 派生（不读 `edges` 表），所以结构编辑类用例
 * 需要能传带 `parentId` 的节点。默认数组是**字面量数组** → 元素类型里没有
 * `parentId` → 直接传会触发 TypeScript 的多余属性检查，因此这里显式放宽。
 */
export type MockNode = typeof defaultMockNodes[number] & { parentId?: string }

/**
 * mock 边的形状 —— 只带画布需要的字段。
 *
 * 结构编辑用例要能造出「存储里的层级边」：父子关系的事实来源是 `parent_id`，
 * 存储里的层级边在渲染时必须被丢弃。不给 mock 这个能力，
 * 「父子之间只画一条线」就退化成「什么都没画也只有一条线」—— 那道断言等于没写。
 */
export type MockEdge = {
  id: string
  source: string
  target: string
  graphId?: string
  edgeType?: string
  label?: string
}

export async function setupMockIpc(page: Page, options?: { initialStatus?: SubagentStatus; graphs?: typeof defaultMockGraph[]; nodes?: MockNode[]; edges?: MockEdge[] }) {
  const mockGraphs = options?.graphs ?? [defaultMockGraph]
  const mockNodes = options?.nodes ?? defaultMockNodes
  const mockEdges = options?.edges ?? []
  await page.addInitScript((opts: { initialStatus: SubagentStatus; graphs: typeof defaultMockGraph[]; nodes: MockNode[]; edges: MockEdge[] }) => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

    function emit(channel: string, ...args: unknown[]) {
      for (const cb of listeners[channel] ?? []) {
        cb(...args)
      }
    }

    const mockGraphs = opts.graphs
    const mockGraph = mockGraphs[0]
    const mockNodes = opts.nodes
    const mockEdges = opts.edges

    const mockSubagentTypes = [
      { name: 'explore', displayName: '探索者', description: 'Read-only search', allowedTools: ['Read', 'Glob', 'Grep'], scopeStrategy: 'inherit' },
      { name: 'implement', displayName: '实现者', description: 'Implement feature', allowedTools: '*', scopeStrategy: 'subset' },
    ]

    const mockState = {
      invocationStatus: opts.initialStatus ?? 'queued',
      invocationResultText: null as string | null,
      /**
       * `graph:reparent` 的调用记录。
       *
       * **拒绝类用例靠它断言「IPC 根本没被调用」** —— 只断言「连线没变」是不够的：
       * 落点被默默接受、而 mock 返回空的 movedPositions 时，连线同样不会变。
       */
      reparentCalls: [] as Array<{ nodeId: string; newParentId: string }>,
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
      'graph:get': async () => ({ graph: mockGraph, nodes: mockNodes, edges: mockEdges, bugs: [] }),
      'graph:list': async () => mockGraphs,
      'graph:create': async ({ name, type }: { name: string; type: string }) => ({ ...mockGraph, name, type }),
      /**
       * 拖拽重挂 —— 父子关系变更的唯一入口。
       *
       * mock 是**无状态**的（不回写 nodes），但它**记录调用**：
       * 测试要能断言「IPC 有没有被调用过」。合法落点时渲染端会照抄
       * `newParentId` 更新 store 里的 parentId → 派生边随之改画。
       */
      'graph:reparent': async (nodeId: string, newParentId: string) => {
        mockState.reparentCalls.push({ nodeId, newParentId })
        return { nodeId, oldParentId: null, newParentId, movedPositions: [] }
      },

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
      'node:batchUpdatePositions': async () => undefined,

      // Node type rules — mirrors the real nodeType:listConfigs payload
      // (type / allowedChildTypes / allowedParentTypes, no behavior).
      'nodeType:listConfigs': async () => [
        { type: 'project', allowedChildTypes: ['module'] },
        { type: 'module', allowedParentTypes: ['project'], allowedChildTypes: ['process', 'wiki-page'] },
        { type: 'process', allowedParentTypes: ['module'], allowedChildTypes: ['feature', 'bug', 'wiki-page'] },
        { type: 'feature', allowedParentTypes: ['process'], allowedChildTypes: ['bug'] },
        { type: 'bug', allowedParentTypes: ['process', 'feature'], allowedChildTypes: [] },
        { type: 'wiki-page', allowedParentTypes: ['project', 'module', 'process', 'wiki-page'], allowedChildTypes: ['wiki-page'] },
      ],

      // Edge
      'edge:create': async (data: Record<string, unknown>) => ({ ...data, id: `edge_${Date.now()}` }),
      'edge:update': async () => undefined,
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

      // Realtime (Yjs awareness) —— GraphCanvas 挂载时**必调**这两个通道。
      // 缺通道不是「少个功能」：`window.electronAPI['realtime:getIdentity']` 是 undefined，
      // 调用它会**同步**抛 TypeError（`.catch()` 接不住同步 throw）→ React 卸载整棵树
      // → 画布白屏 → 所有等 `[data-testid="graph-canvas"]` 的用例全部超时。
      // 这两个通道是 `73700b3`（Yjs Awareness）引入的，mock 当时没跟上，
      // 于是浏览器 e2e 从那以后就一直是坏的 —— 与结构编辑批次无关。
      // `started: false` = 主进程没起 awareness server → 渲染端不建连接，e2e 不需要它。
      'realtime:getIdentity': async () => ({ userId: 'e2e-user', userName: 'E2E User', colorIndex: 0 }),
      'realtime:getConnectionInfo': async () => ({ wsUrl: '', port: 0, started: false }),

      // Settings
      'settings:read': async () => ({ defaultModel: 'sonnet' }),
      'settings:getAdapterPreferences': async () => ({
        defaultAdapter: 'claude-code',
        fallbackOrder: ['codex', 'opencode', 'cline', 'kilo-code', 'kimi-code', 'qwen-code', 'codebuddy', 'qoder', 'cursor', 'mcp'],
      }),
      'settings:setAdapterPreferences': async () => undefined,

      // Context waterline
      'context:getWaterline': async () => null,

      // Marketplace
      'agent:getAdapterMarketplace': async () => [],

      // Event listeners
      onAgentOutput: (cb: (sessionId: string, output: unknown) => void) => {
        listeners['agent:onOutput'] = listeners['agent:onOutput'] ?? []
        listeners['agent:onOutput'].push(cb as (...args: unknown[]) => void)
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
        listeners['subagent:progress'].push(cb as (...args: unknown[]) => void)
        return () => {
          listeners['subagent:progress'] = listeners['subagent:progress'].filter((fn) => fn !== cb)
        }
      },
      onMenuOpenProject: () => () => {},
      platform: 'win32',
    }

    window.electronAPI = mockApi as Window['electronAPI']
  }, { initialStatus: options?.initialStatus ?? 'queued', graphs: mockGraphs, nodes: mockNodes, edges: mockEdges })
}

/**
 * 读 `graph:reparent` 的调用记录。
 *
 * 拒绝类用例靠它断言「IPC 根本没被调用」—— 只断言「连线没变」是不够的：
 * 落点被默默接受、而 mock 返回空的 movedPositions 时，连线同样不会变。
 */
export async function getReparentCalls(page: Page): Promise<Array<{ nodeId: string; newParentId: string }>> {
  return page.evaluate(() => {
    const state = (window as unknown as {
      __bizgraphMockState?: { reparentCalls?: Array<{ nodeId: string; newParentId: string }> }
    }).__bizgraphMockState
    return state?.reparentCalls ?? []
  })
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
