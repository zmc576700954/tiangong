/**
 * A2A（Agent-to-Agent）协议 — 共享类型定义
 *
 * 基于 Google A2A spec v0.3.0（2025-Q3）。本文件定义 BizGraph 作为
 * A2A server / client 时所需的全部 wire 类型。**必须**保持纯类型 +
 * 常量定义，不引入 Node 依赖（CLAUDE.md：shared/types 不引入 Node）。
 *
 * 关键 RPC：
 *   - SendMessage  (POST /v1/message:send)
 *   - StreamMessage (POST /v1/message:stream, SSE)
 *   - GetTask (GET /v1/tasks/:id)
 *   - ListTasks (GET /v1/tasks)
 *
 * 资源模型：
 *   Task { id, contextId, status, artifacts[], history[] }
 *   Message { role, parts[] }
 *   Part = TextPart | FilePart | DataPart
 *   Artifact { name, parts[], metadata? }
 *
 * BizGraph 内部 AgentSessionConfig ↔ A2AAgentCard 双向映射见
 * `toAgentSessionConfig` / `fromAgentSessionConfig` 函数。
 */

// ============================================
// 基础 Part 类型
// ============================================

/** TextPart — UTF-8 文本片段 */
export interface A2ATextPart {
  type: 'text'
  text: string
}

/** FilePart — 文件载荷（base64 编码或外部 URI） */
export interface A2AFilePart {
  type: 'file'
  /** 原始文件名（仅展示） */
  name?: string
  /** MIME 类型 */
  mimeType: string
  /** base64 编码内容（与 uri 二选一） */
  bytes?: string
  /** 外部可访问 URI（与 bytes 二选一） */
  uri?: string
}

/** DataPart — 结构化 JSON 数据（与 TextPart/FilePart 互斥） */
export interface A2ADataPart {
  type: 'data'
  /** 任意可 JSON 序列化的对象 */
  data: Record<string, unknown>
}

export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart

// ============================================
// Message
// ============================================

/** 消息发送方角色 */
export type A2AMessageRole = 'user' | 'agent'

export interface A2AMessage {
  role: A2AMessageRole
  parts: A2APart[]
  /** 会话上下文 ID（跨多个 Task 共享） */
  contextId?: string
  /** 任务 ID（仅 agent 消息带） */
  taskId?: string
  /** 业务元数据（透传，不被协议消费） */
  metadata?: Record<string, unknown>
}

// ============================================
// Artifact（agent 输出）
// ============================================

export interface A2AArtifact {
  /** 展示名 */
  name: string
  /** 文件名（若 Artifact 表示文件） */
  fileName?: string
  /** MIME 类型 */
  mimeType?: string
  parts: A2APart[]
  metadata?: Record<string, unknown>
  /** 索引（同一 Artifact 分多次推送时递增） */
  index?: number
  /** 是否为最后一个分片 */
  lastChunk?: boolean
}

// ============================================
// Status（任务状态）
// ============================================

export type A2AStatusState =
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'input-required'

export interface A2AStatus {
  state: A2AStatusState
  /** 伴随状态消息（如失败原因、待补全追问） */
  message?: A2AMessage
  /** 业务元数据 */
  metadata?: Record<string, unknown>
}

// ============================================
// Task（任务）
// ============================================

export interface A2ATask {
  id: string
  contextId: string
  status: A2AStatus
  artifacts: A2AArtifact[]
  /** 完整对话历史（含 user / agent 消息） */
  history: A2AMessage[]
  /** 任务创建时间（epoch ms） */
  createdAt?: number
  /** 任务最后更新时间（epoch ms） */
  updatedAt?: number
  metadata?: Record<string, unknown>
}

// ============================================
// AgentCard（能力自描述）
// ============================================

export type A2ACapability = 'streaming' | 'push-notifications' | 'state-transition-history'

export interface A2AAgentSkill {
  id: string
  name: string
  description?: string
  /** 输入模式（自由文本 / 结构化表单 JSON Schema） */
  inputModes?: A2APart['type'][]
  /** 输出模式 */
  outputModes?: A2APart['type'][]
  /** 关联 BizGraph 节点 ID（内部路由） */
  nodeId?: string
}

export interface A2AAgentCard {
  /** 协议版本（v0.3.0） */
  a2aVersion: string
  /** Agent 唯一名（kebab-case） */
  name: string
  /** 人类可读描述 */
  description: string
  /** 服务可达 URL（含 scheme） */
  url: string
  /** 协议版本（agent 自身版本） */
  version?: string
  /** 支持的能力 */
  capabilities: A2ACapability[]
  /** 默认输入模式 */
  defaultInputModes: A2APart['type'][]
  /** 默认输出模式 */
  defaultOutputModes: A2APart['type'][]
  /** 提供的技能清单 */
  skills: A2AAgentSkill[]
  /** 文档 URL */
  documentationUrl?: string
  /** 图标 URL */
  iconUrl?: string
  metadata?: Record<string, unknown>
}

// ============================================
// RPC 请求 / 响应
// ============================================

export interface A2ASendMessageRequest {
  message: A2AMessage
  contextId?: string
  /** 已有 Task 的 ID（继续执行） */
  taskId?: string
  /** 业务元数据 */
  metadata?: Record<string, unknown>
}

/** StreamMessage 请求结构同 SendMessage */
export type A2AStreamMessageRequest = A2ASendMessageRequest

export interface A2ASendMessageResponse {
  task: A2ATask
}

export interface A2ATaskListResponse {
  tasks: A2ATask[]
  /** 下一页 token（base64 编码的 cursor） */
  nextPageToken?: string
}

// ============================================
// BizGraph 配置类型（与 wire types 解耦）
// ============================================

export type A2ABindAddress = '127.0.0.1' | '0.0.0.0'

/** A2A Server 配置（持久化到 settings.json） */
export interface A2AServerConfig {
  /** 是否启用（默认 false；变更后热重启） */
  enabled: boolean
  /** 监听端口（默认 8089） */
  port: number
  /** 监听地址（默认 '127.0.0.1'） */
  bindAddress: A2ABindAddress
  /** Bearer Token（加密存储；最少 16 位） */
  apiKey: string
  /** TLS 证书路径（可选；启用 mTLS） */
  tlsCertPath?: string
  /** TLS 私钥路径（与 tlsCertPath 配套） */
  tlsKeyPath?: string
  /** 自描述 AgentCard（用户可编辑后同步对外暴露） */
  agentCard: A2AAgentCard
}

/** A2A Remote Agent 配置（持久化到 settings.json） */
export interface A2ARemoteAgent {
  /** 唯一名（kebab-case）。SubagentManager 注册为 `a2a:<name>` */
  name: string
  /** 远端服务 URL（含 scheme） */
  endpoint: string
  /** Bearer Token（加密存储） */
  apiKey?: string
  /** 是否校验 TLS 证书（默认 true） */
  tlsVerify?: boolean
  /** 单次调用超时（ms；默认 30000） */
  timeoutMs?: number
  /** 缓存的远端能力（首次连接后写入） */
  capabilities?: A2ACapability[]
  /** 缓存的远端 AgentCard（首次连接后写入） */
  agentCard?: A2AAgentCard
  /** 开发者显式允许连接 loopback（仅 http://127.0.0.1） */
  devAllowLocalhost?: boolean
  /** 启用状态（false 时不参与 SubagentManager 注册） */
  enabled?: boolean
}

/** settings.a2a.remoteAgents 的 wrapper 类型 */
export interface A2ASettings {
  remoteAgents: A2ARemoteAgent[]
}

// ============================================
// 内部类型（main 进程专用，不暴露 renderer）
// ============================================

/** task-store 中的内部记录（包含运行时状态） */
export interface A2ATaskRecord {
  taskId: string
  contextId: string
  /** BizGraph AgentSession id（用于 SSE cancel） */
  sessionId: string
  status: A2AStatusState
  startedAt: number
  lastActivityAt: number
  /** 累积的 artifact 列表（用于 GET /v1/tasks/:id 内存 fallback） */
  artifacts: A2AArtifact[]
  /** 完整历史 */
  history: A2AMessage[]
}

/** A2A Server 状态（用于 a2a:getServerStatus IPC） */
export interface A2AServerStatus {
  running: boolean
  port?: number
  bindAddress?: A2ABindAddress
  tls?: boolean
  activeTasks: number
  completedTasks: number
  failedTasks: number
}

// ============================================
// 常量
// ============================================

/** SSE event 名称常量（避免字符串散落） */
export const SSE_EVENT_ARTIFACT = 'artifact'
export const SSE_EVENT_STATUS = 'status'
export const SSE_EVENT_MESSAGE = 'message'

/** A2A 协议版本 */
export const A2A_PROTOCOL_VERSION = '0.3.0'

/** 默认监听端口 */
export const A2A_DEFAULT_PORT = 8089

/** 默认监听地址（安全默认值，避免 Windows Firewall 弹窗） */
export const A2A_DEFAULT_BIND_ADDRESS: A2ABindAddress = '127.0.0.1'

/** Bearer Token 最小长度（防误配短 key） */
export const A2A_MIN_API_KEY_LENGTH = 16

/** 默认调用超时（ms） */
export const A2A_DEFAULT_TIMEOUT_MS = 30_000

/** SSE keepalive 间隔（ms） */
export const A2A_SSE_KEEPALIVE_MS = 15_000

/** task-store 已完成任务 TTL（ms；1 小时） */
export const A2A_TASK_TTL_MS = 60 * 60 * 1_000

/** task-store 主动清理间隔（ms） */
export const A2A_TASK_SWEEP_MS = 60_000

/** dns.lookup 结果缓存（ms；防 DNS rebinding） */
export const A2A_DNS_CACHE_MS = 60_000

/**
 * SubagentManager.invoke 的 agentType 合法值正则。
 *
 * 三种合法形式：
 *   recipe:<id>  — Phase C Recipe 派发
 *   a2a:<name>   — Phase D A2A 远程 Agent 派发
 *   <type>       — 内置或用户自定义子代理
 *
 * **必须**在两处同步使用（详见 `src/main/adapters/base.ts:1280` 的
 * `DISPATCH_SUBAGENT_TOOL_SCHEMA` 与 `src/main/adapters/claude-code.ts:136`
 * 的 Zod schema），保证 agent 看到的工具 schema 与 SubagentManager 实际
 * 接受的 agentType 一致。
 */
export const SUBAGENT_AGENT_TYPE_PATTERN =
  '^recipe:[a-z][a-z0-9-]*$|^a2a:[a-z][a-z0-9-]*$|^[a-z][a-z0-9-]*$'

// ============================================
// BizGraph AgentSessionConfig ↔ A2AAgentCard 映射
// ============================================

/**
 * 由 A2AAgentCard 构造 BizGraph AgentSessionConfig 草案。
 * 不直接用作 dispatch；调用方应按需补充 workingDirectory / allowedFiles 等。
 */
export function toAgentSessionConfig(
  card: A2AAgentCard,
  message: A2AMessage,
): {
  prompt: string
  description: string
  agentName: string
} {
  const textPart = message.parts.find((p): p is A2ATextPart => p.type === 'text')
  const prompt = textPart?.text ?? ''
  const description = `${card.name}: ${message.role}`
  return {
    prompt,
    description,
    agentName: card.name,
  }
}

/**
 * 由 BizGraph AgentSessionConfig 草案构造对外 A2AAgentCard。
 * 提供默认值；调用方应按需覆盖 url / version / skills。
 */
export function fromAgentSessionConfig(
  agentName: string,
  description: string,
  url: string,
): A2AAgentCard {
  return {
    a2aVersion: A2A_PROTOCOL_VERSION,
    name: agentName,
    description,
    url,
    capabilities: ['streaming'],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  }
}

// ============================================
// Wire format 守卫（运行时类型校验）
// ============================================

/** 判断 unknown 是否为合法 A2AMessage。返回类型守卫。 */
export function isA2AMessage(value: unknown): value is A2AMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  if (m.role !== 'user' && m.role !== 'agent') return false
  if (!Array.isArray(m.parts)) return false
  return m.parts.every(isA2APart)
}

/** 判断 unknown 是否为合法 A2APart。返回类型守卫。 */
export function isA2APart(value: unknown): value is A2APart {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  if (p.type === 'text') return typeof p.text === 'string'
  if (p.type === 'file') return typeof p.mimeType === 'string'
  if (p.type === 'data') return typeof p.data === 'object' && p.data !== null
  return false
}

/** 判断 unknown 是否为合法 A2AAgentCard。返回类型守卫。 */
export function isA2AAgentCard(value: unknown): value is A2AAgentCard {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  if (typeof c.name !== 'string' || typeof c.url !== 'string') return false
  if (typeof c.a2aVersion !== 'string') return false
  if (!Array.isArray(c.capabilities)) return false
  if (!Array.isArray(c.defaultInputModes) || !Array.isArray(c.defaultOutputModes)) return false
  if (!Array.isArray(c.skills)) return false
  return true
}
