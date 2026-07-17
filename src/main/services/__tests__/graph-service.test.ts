import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphService } from '../graph-service'
import type { GraphType, ProjectScanResult } from '@shared/types'
import type { GraphRepository } from '../../repositories/graph-repository'
import type BetterSqlite3 from 'better-sqlite3'
import type { ChatService } from '../chat-service'
import type { AgentManager } from '../../agent/agent-manager'

function createMockDb() {
  const stmtMock = {
    run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
    get: vi.fn().mockReturnValue(null),
    all: vi.fn().mockReturnValue([]),
  }
  const db = {
    prepare: vi.fn().mockReturnValue(stmtMock),
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => fn(...args)),
    exec: vi.fn(),
    pragma: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as BetterSqlite3.Database
  return { db, stmt: stmtMock }
}

vi.mock('../../repositories/graph-repository', () => ({
  GraphRepository: vi.fn().mockImplementation(function (this: GraphRepository) {
    this.create = vi.fn((data: { name: string; type: GraphType }) => ({
      id: 'graph-id',
      name: data.name,
      type: data.type,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    }))
    this.list = vi.fn().mockReturnValue([])
    this.get = vi.fn().mockReturnValue(null)
    this.delete = vi.fn()
    this.getProjectPaths = vi.fn().mockReturnValue([])
    this.cloneGraphNodes = vi.fn()
  }),
}))

const mockScanResult: ProjectScanResult = {
  projectName: 'Test Project',
  projectPath: '/project',
  framework: 'react',
  packageJson: null,
  modules: [
    {
      name: 'M1',
      description: 'module one',
      processes: [
        {
          name: 'P1',
          description: 'process one',
          features: [{ name: 'F1', description: 'feature one', type: 'feature' }],
        },
      ],
    },
  ],
}

const mockGraphResult = {
  projectName: 'Test Project',
  projectPath: '/project',
  framework: 'react',
  nodes: [
    {
      tempId: 'root',
      type: 'project',
      status: 'confirmed',
      title: 'Test Project',
      description: 'test',
      graphId: '',
      graphType: 'online' as const,
      position: { x: 0, y: 0 },
      metadata: {},
      acceptanceCriteria: [],
      ownerRole: 'product' as const,
    },
    {
      tempId: 'module-0',
      type: 'module',
      status: 'confirmed',
      title: 'M1',
      description: 'module one',
      graphId: '',
      graphType: 'online' as const,
      position: { x: 0, y: 0 },
      metadata: {},
      acceptanceCriteria: [],
      ownerRole: 'product' as const,
    },
    {
      tempId: 'process-0',
      type: 'process',
      status: 'confirmed',
      title: 'P1',
      description: 'process one',
      graphId: '',
      graphType: 'online' as const,
      position: { x: 0, y: 0 },
      metadata: {},
      acceptanceCriteria: [],
      parentTempId: 'module-0',
      ownerRole: 'product' as const,
    },
    {
      tempId: 'feature-0',
      type: 'feature',
      status: 'draft',
      title: 'F1',
      description: 'feature one',
      graphId: '',
      graphType: 'dev' as const,
      position: { x: 0, y: 0 },
      metadata: {},
      acceptanceCriteria: [],
      parentTempId: 'process-0',
      ownerRole: 'developer' as const,
    },
  ],
  edges: [
    { sourceTempId: 'root', targetTempId: 'module-0', label: '包含', edgeType: 'default', graphId: '' },
    { sourceTempId: 'module-0', targetTempId: 'process-0', label: '', edgeType: 'default', graphId: '' },
    { sourceTempId: 'process-0', targetTempId: 'feature-0', label: '', edgeType: 'default', graphId: '' },
  ],
}

vi.mock('../../project-scanner', () => ({
  ProjectScanner: vi.fn().mockImplementation(function () {
    return { scan: vi.fn().mockResolvedValue(mockScanResult) }
  }),
}))

vi.mock('../../project-analyzer', () => ({
  ProjectAnalyzer: vi.fn().mockImplementation(function () {
    return { analyze: vi.fn().mockReturnValue(mockGraphResult) }
  }),
}))

vi.mock('../../mindmap-agent', () => ({
  MindMapAgent: vi.fn().mockImplementation(function () {
    return { parseGenerationResult: vi.fn().mockReturnValue([]) }
  }),
}))

vi.mock('../../mindmap-agent/context-collector', () => ({
  collectContext: vi.fn().mockResolvedValue({
    projectName: 'Test Project',
    projectPath: '/project',
    framework: 'react',
    directoryTree: '',
    packageJsonSummary: '',
    readmeContent: '',
    entryPointContent: '',
    memory: {
      projectId: 'test',
      projectPath: '/project',
      businessDomains: [],
      architecturePattern: '',
      coreUserFlows: [],
      techConstraints: [],
      refinements: [],
      preferences: {
        granularity: 'medium',
        namingStyle: 'business',
        maxModules: 5,
        avoidPatterns: [],
      },
      updatedAt: new Date().toISOString(),
    },
    keyFileSnippets: '',
  }),
}))

vi.mock('../../mindmap-agent/retrieval/global', () => ({
  buildGlobalPrompt: vi.fn().mockReturnValue('global prompt'),
}))

vi.mock('../../agent/send-and-wait', () => ({
  createAgentSessionForPrompt: vi.fn().mockResolvedValue('agent-session-1'),
}))

describe('GraphService.initFromProject Chat thread behavior', () => {
  let db: BetterSqlite3.Database
  let chatService: ChatService
  let agentManager: AgentManager

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    chatService = {
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1' }),
      updateThread: vi.fn().mockResolvedValue(undefined),
      saveMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatService
    agentManager = {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'agent-session-1' }),
      addSessionOutputListener: vi.fn(),
      removeSessionOutputListener: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue(undefined),
      terminateSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager
    vi.clearAllMocks()
  })

  it('creates thread and writes progress messages', async () => {
    const service = new GraphService(db, undefined, chatService)

    const result = await service.initFromProject({
      projectPath: '/project',
      projectName: 'Test Project',
    })

    expect(chatService.createThread).toHaveBeenCalledTimes(1)
    expect(chatService.createThread).toHaveBeenCalledWith({ adapterName: 'mindmap-internal' })

    expect(chatService.updateThread).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        title: '生成思维导图：Test Project',
        status: 'running',
      }),
    )

    const calls = (chatService.saveMessage as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, { structuredContent?: Array<{ type: string }> }]
    >
    const progressCalls = calls.filter(([, message]) =>
      message.structuredContent?.some((c) => c.type === 'progress'),
    )
    expect(progressCalls.length).toBeGreaterThanOrEqual(2)

    expect(result.threadId).toBe('thread-1')
    expect(result.onlineGraph).toBeDefined()
    expect(result.devGraph).toBeDefined()
    expect(result.modules).toHaveLength(1)
  })

  it('skips AI enhancement and still creates graphs when AgentManager is unavailable', async () => {
    const service = new GraphService(db, undefined, chatService)

    const result = await service.initFromProject({
      projectPath: '/project',
      projectName: 'Test Project',
    })

    expect(result.onlineGraph).toBeDefined()
    expect(result.devGraph).toBeDefined()
    expect(result.modules).toEqual(mockScanResult.modules)
  })

  it('writes error message when scanner fails', async () => {
    const { ProjectScanner } = await import('../../project-scanner')
    const scanMock = vi.fn().mockRejectedValueOnce(new Error('scan failed'))
    ;(ProjectScanner as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return { scan: scanMock }
    })

    const service = new GraphService(db, agentManager, chatService)

    await expect(
      service.initFromProject({ projectPath: '/project', projectName: 'Test Project' }),
    ).rejects.toThrow('scan failed')

    const calls = (chatService.saveMessage as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, { status: string; error?: { code: string } }]
    >
    const errorCalls = calls.filter(([, message]) =>
      message.status === 'error' && message.error?.code === 'MINDMAP_GENERATION_FAILED',
    )
    expect(errorCalls.length).toBe(1)

    expect(chatService.updateThread).toHaveBeenCalledWith('thread-1', { status: 'error' })
  })
})
