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
      'node:batchUpdatePositions': async () => undefined,

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

      // Settings
      'settings:read': async () => ({ defaultModel: 'sonnet' }),
      'settings:getAdapterPreferences': async () => ({
        defaultAdapter: 'claude-code',
        fallbackOrder: ['codex', 'opencode', 'cline', 'kilo-code', 'kimi-code', 'qwen-code', 'codebuddy', 'qoder', 'cursor', 'mcp'],
      }),
      'settings:setAdapterPreferences': async () => undefined,

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
