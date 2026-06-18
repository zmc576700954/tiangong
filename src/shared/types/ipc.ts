/**
 * IPC 通信类型定义
 * 包含 IpcApi 接口和所有 IPC 通信相关类型
 */

import type {
  Graph, GraphType, GraphNode, GraphEdge, BugNode, GraphSnapshot,
  NodeStatus, ContextRef,
  ProjectScanResult, ScanModule, NodeEnrichment, NodeType,
} from './graph'
import type {
  AgentSessionConfig, AgentCommand, AgentOutput, AgentLog, AgentThread,
  ChatMessage, FileSearchResult, CliToolConfig, BizGraphSettings,
  VerificationReport, CodeIntelExecutionPlan, SymbolQueryResult,
  SymbolKind, ValidationResult, AdapterFallbackAttempt, AdapterPreferences,
  AgentMode, AgentModeConfig, AdapterMarketplaceItem, MemoryItem, MemoryKind,
} from './agent'

// ============================================
// IPC 通信类型
// ============================================

export interface IpcApi {
  // 图操作
  'graph:create': (data: { name: string; type: GraphType }) => Promise<Graph>
  'graph:list': () => Promise<Graph[]>
  'graph:get': (id: string) => Promise<{ graph: Graph; nodes: GraphNode[]; edges: GraphEdge[]; bugs: BugNode[] } | null>
  'graph:delete': (id: string) => Promise<boolean>
  'graph:derive': (sourceGraphId: string, name?: string) => Promise<Graph>

  // 节点操作
  'node:create': (data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<GraphNode>
  'node:createBatch': (nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => Promise<GraphNode[]>
  'node:update': (id: string, data: Partial<GraphNode>) => Promise<GraphNode & { warnings?: string[] }>
  'node:delete': (id: string) => Promise<boolean>
  'node:batchUpdatePositions': (updates: Array<{ id: string; x: number; y: number }>) => Promise<boolean>

  // 边操作
  'edge:create': (data: Omit<GraphEdge, 'id'>) => Promise<GraphEdge>
  'edge:update': (id: string, data: Partial<GraphEdge>) => Promise<GraphEdge>
  'edge:delete': (id: string) => Promise<boolean>

  // Bug 操作
  'bug:create': (data: Omit<BugNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<BugNode>
  'bug:update': (id: string, data: Partial<BugNode>) => Promise<BugNode>
  'bug:delete': (id: string) => Promise<boolean>
  'bug:listByNode': (nodeId: string) => Promise<BugNode[]>

  // 快照操作
  'snapshot:create': (graphId: string, name: string) => Promise<GraphSnapshot>
  'snapshot:list': (graphId: string) => Promise<Omit<GraphSnapshot, 'data'>[]>
  'snapshot:load': (id: string) => Promise<GraphSnapshot | null>
  'snapshot:delete': (id: string) => Promise<boolean>

  // Agent 操作
  'agent:checkInstalled': (adapterName: string) => Promise<boolean>
  'agent:startSession': (adapterName: string | null, config: AgentSessionConfig) => Promise<{ sessionId: string; fallback?: boolean; adapterUsed?: string; fallbackHistory?: AdapterFallbackAttempt[] }>
  'agent:sendCommand': (sessionId: string, command: AgentCommand) => Promise<void>
  'agent:resolveAndSendCommand': (sessionId: string, command: AgentCommand, contextRefs: ContextRef[], nodeIds: string[]) => Promise<void>
  'agent:terminateSession': (sessionId: string) => Promise<void>
  'agent:listAdapters': () => Promise<{ name: string; version: string; installed: boolean }[]>
  'agent:getAdapterMarketplace': () => Promise<AdapterMarketplaceItem[]>
  'agent:verify': (params: {
    nodeId: string
    acceptanceCriteria: string[]
    messages: ChatMessage[]
    fileChanges: AgentOutput[]
    workingDirectory?: string
  }) => Promise<VerificationReport>

  'agent:getLogsByNode': (nodeId: string) => Promise<AgentLog[]>
  'agent:getLogsByGraph': (graphId: string) => Promise<AgentLog[]>
  'agent:closeAllSessions': () => Promise<void>

  // Chat 会话记录
  'thread:list': (filters?: { nodeId?: string; graphId?: string }) => Promise<AgentThread[]>
  'thread:load': (threadId: string) => Promise<AgentThread | null>
  'thread:create': (data: { adapterName: string; nodeId?: string; graphId?: string }) => Promise<AgentThread>
  'thread:update': (threadId: string, data: { title?: string; status?: string; sessionId?: string }) => Promise<void>
  'thread:delete': (threadId: string) => Promise<void>
  'thread:search': (query: string) => Promise<AgentThread[]>

  'message:list': (threadId: string, limit?: number, offset?: number) => Promise<ChatMessage[]>
  'message:save': (threadId: string, message: ChatMessage) => Promise<void>
  'message:saveBatch': (threadId: string, messages: ChatMessage[]) => Promise<void>

  'chat:archiveStale': (projectId: string, staleDays?: number) => Promise<number>

  // Chat 归档清理
  'chat:cleanupArchived': () => Promise<number>

  // 文件系统
  'fs:readDir': (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
  'fs:readDirDetail': (path: string) => Promise<{ name: string; path: string; isDirectory: boolean; size: number; mtimeMs: number }[]>
  'fs:readFile': (path: string) => Promise<string>
  'fs:createFile': (filePath: string) => Promise<{ path: string; name: string }>
  'fs:createDir': (dirPath: string) => Promise<{ path: string; name: string }>
  'fs:delete': (targetPath: string, recursive?: boolean) => Promise<{ deleted: string }>
  'fs:rename': (oldPath: string, newName: string) => Promise<{ oldPath: string; newPath: string; newName: string }>
  'fs:move': (sourcePath: string, destDir: string) => Promise<{ sourcePath: string; destPath: string; name: string }>
  'fs:copy': (sourcePath: string, destDir: string) => Promise<{ sourcePath: string; destPath: string; name: string }>
  'fs:exists': (targetPath: string) => Promise<boolean>
  'fs:stat': (targetPath: string) => Promise<{ isDirectory: boolean; isFile: boolean; size: number; mtimeMs: number; ctimeMs: number }>
  'fs:registerProjectPaths': (paths: string[]) => Promise<void>
  'fs:searchFiles': (dirPath: string, query: string, limit?: number) => Promise<FileSearchResult[]>

  // Git 操作
  'git:status': (path: string) => Promise<{ modified: string[]; untracked: string[] }>
  'git:diff': (path: string) => Promise<string>
  'git:commit': (path: string, message: string, files: string[]) => Promise<void>

  // Dialog 操作
  'dialog:openDirectory': () => Promise<string | null>

  // 项目扫描
  'project:scan': (projectPath: string) => Promise<ProjectScanResult>

  // 从项目初始化图
  'graph:initFromProject': (data: { projectPath: string; projectName: string }) => Promise<{
    onlineGraph: Graph
    devGraph: Graph
    modules: ScanModule[]
  }>

  // 事件监听通道（push 模式，不通过 ipcRenderer.invoke 调用）
  // 这些仅用于类型文档，实际通过 preload 的 onAgentOutput/onAgentStatusChange 监听
  'agent:onOutput': (sessionId: string, output: AgentOutput) => void
  'agent:onStatusChange': (sessionId: string, nodeId: string, status: NodeStatus) => void

  // 配置管理
  'settings:read': () => Promise<BizGraphSettings>
  'settings:write': (settings: BizGraphSettings) => Promise<void>
  'settings:refreshCli': () => Promise<CliToolConfig[]>
  'settings:installCli': (name: string) => Promise<{ success: boolean; message: string }>
  'settings:setApiKey': (provider: string, key: string, baseUrl?: string | null) => Promise<void>
  'settings:getAdapterPreferences': () => Promise<AdapterPreferences>
  'settings:setAdapterPreferences': (prefs: AdapterPreferences) => Promise<void>

  // MindMap Agent 操作
  'mindmap:generate': (projectPath: string) => Promise<ScanModule[]>
  'mindmap:generateModule': (projectPath: string, parentNodeId: string, parentNodeTitle: string, parentNodeType: NodeType) => Promise<{ childType: NodeType; children: Array<{ title: string; description?: string }> }>
  'mindmap:enrichNode': (projectPath: string, nodeId: string, nodeType: NodeType, nodeTitle: string, relatedFiles?: string[], contextRefs?: ContextRef[]) => Promise<NodeEnrichment>
  'mindmap:refine': (projectPath: string, scope: 'project' | 'module' | 'node', targetId: string, feedback: string) => Promise<ScanModule[] | ScanModule | NodeEnrichment>
  'mindmap:buildDevPrompt': (nodeId: string, nodeTitle: string, nodeType: NodeType, taskType: 'feature' | 'bugfix' | 'refactor', graphId: string, contextRefs?: ContextRef[]) => Promise<string>

  // 代码智能操作
  'codeIntel:indexProject': (projectPath: string) => Promise<{ filesIndexed: number; symbolsFound: number; importsFound: number }>
  'codeIntel:querySymbols': (name: string, options?: { kind?: SymbolKind; fuzzy?: boolean; limit?: number }) => Promise<SymbolQueryResult[]>
  'codeIntel:getRelatedFiles': (filePath: string, depth?: number) => Promise<Array<{ filePath: string; distance: number }>>
  'codeIntel:generatePlan': (userQuery: string) => Promise<CodeIntelExecutionPlan>

  // Memory 记忆操作
  'memory:search': (query: string, options?: { projectId?: string; kind?: MemoryKind; limit?: number }) => Promise<MemoryItem[]>
  'memory:getRecent': (options?: { projectId?: string; nodeId?: string; limit?: number }) => Promise<MemoryItem[]>
  'memory:getByNode': (nodeId: string, limit?: number) => Promise<MemoryItem[]>
  'memory:getBySession': (sessionId: string, limit?: number) => Promise<MemoryItem[]>
  'memory:getStats': (projectId?: string) => Promise<Array<{ kind: string; count: number }>>
  'memory:getCrossAdapter': (projectId: string, excludeAdapter: string, limit?: number) => Promise<MemoryItem[]>
  /**
   * 删除会话记忆。必须同时提供 projectId 作为授权范围，
   * 防止仅凭 sessionId 跨项目删除——与 main 侧 deleteBySessionScoped 对齐。
   */
  'memory:delete': (sessionId: string, projectId: string) => Promise<number>
  'memory:prune': (daysThreshold?: number) => Promise<number>
  'memory:getEvolutionChain': (concept: string, projectId: string) => Promise<MemoryItem[]>
  'memory:backfillEmbeddings': (projectId: string) => Promise<number>
  'memory:pruneWithDecay': (projectId: string, config?: { baseHalfLife?: number; minConfidence?: number; maxItems?: number }) => Promise<number>

  // Agent 模式管理
  'mode:getCurrent': (projectId: string) => Promise<AgentMode>
  'mode:setCurrent': (projectId: string, mode: AgentMode) => Promise<void>
  'mode:getAvailable': () => Promise<AgentModeConfig[]>

  // ScopeGuard 操作
  'scopeGuard:rollbackFile': (sessionId: string, filePath: string) => Promise<boolean>
  'scopeGuard:commitSession': (sessionId: string) => Promise<ValidationResult>
  'scopeGuard:rollbackSession': (sessionId: string) => Promise<void>
}
