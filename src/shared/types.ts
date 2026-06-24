/**
 * BizGraph 核心类型定义（统一导出入口）
 * 共享于主进程与渲染进程之间
 *
 * 类型按领域拆分为：
 * - ./types/graph.ts  — 图谱、节点、边、快照、项目扫描、MindMap Agent
 * - ./types/agent.ts  — 适配器、会话、范围守卫、日志、验证、代码智能
 * - ./types/ipc.ts    — IPC 通信接口
 *
 * Note: Do NOT import Node.js-specific types here.
 * This file is shared between main and renderer processes.
 */

// Re-export all domain types for backward compatibility
export type {
  // Graph domain
  NodeStatus, NodeType, GraphType, EdgeType,
  BusinessRule, FileAssociation, NodeMetadata, NodeContent, GraphNode,
  EdgeContent, GraphEdge, Graph,
  BugSeverity, BugStatus, BugNode,
  GraphSnapshot,
  ScanFeature, ScanProcess, ScanModule, PackageJsonInfo, ProjectScanResult,
  CommunitySummary, NodeEnrichment, RefinementRecord, ProjectMemory,
  ContextRef,
  NodeTypeConfig,
  NodeStatusTransition,
} from './types/graph'

export {
  NODE_STATUS_VALUES, NODE_TYPE_VALUES, GRAPH_TYPE_VALUES,
  EDGE_TYPE_VALUES, BUG_SEVERITY_VALUES, BUG_STATUS_VALUES,
  NODE_STATUS_TRANSITIONS,
} from './types/graph'

export type {
  // Agent domain
  AgentSessionConfig, BugContext,
  AgentCommandType, AgentCommand, AgentOutput,
  ResolvedContext, FileSearchResult, ToolCallBlock,
  MessageStatus, MessageError, ChatMessage, AgentThread, AgentSession,
  AgentAdapter,
  Sandbox, ValidationResult,
  AgentLog,
  VerificationResult, VerificationReport,
  CliToolConfig, ApiKeyConfig, McpServerConfig, BizGraphSettings,
  AdapterFallbackAttempt, AdapterPreferences,
  InstallMethod, AdapterMarketplaceItem,
  SymbolKind, SymbolInfo, ImportEdge, SymbolReference, SymbolQueryResult,
  CodeIntelExecutionPlan,
  MemoryKind, MemoryItem, ContextLayer, LayeredContext,
  TokenEconomics, AgentMode, AgentModeConfig, OutputHealth,
  CompactStrategy, CompactTrigger, CompactResult, CompactHistoryEntry,
  ContextState, TerminationReason,
} from './types/agent'

export {
  DEFAULT_MODE_CONFIGS,
  AdapterCapability,
} from './types/agent'

export type {
  // Swarm domain
  SwarmTaskType, SwarmTaskStatus, SwarmTask,
  SwarmStrategy, SwarmConfig,
  SwarmExecutionResult,
} from './types/swarm'

export type {
  // IPC domain
  IpcApi,
} from './types/ipc'

export * from './types/subagent'
