/**
 * Agent Runtime M0 公共契约（D1–D5）
 *
 * 这些类型是主进程运行时与渲染层之间唯一共享的「事实」形状。
 * 权威设计见 docs/architecture/agent-architecture.md §3–§5。
 */

export type ExecutorVendor = 'claude' | 'codex' | 'opencode'

export type EventSource = 'backend' | 'kernel' | 'synthetic'
export type Fidelity = 'token' | 'turn' | 'session'

export type NormalizedEventType =
  | 'run.created'
  | 'run.started'
  | 'run.failed'
  | 'run.interrupted'
  | 'run.completed'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'message.delta'
  | 'message.completed'
  | 'reasoning.delta'
  | 'tool.requested'
  | 'tool.executing'
  | 'tool.result'
  | 'tool.failed'
  | 'tool.aborted'
  /** C2：无法证明工具是否执行/成功的如实标记，不伪装成 failed */
  | 'tool.unknown'
  | 'approval.required'
  | 'approval.resolved'
  /** P0-1：会话级授权未命中（记录因工具/路径/撤销/会话哪一项不满足而回到审批） */
  | 'approval.grant_miss'
  /** P3：Bash 只读白名单决策审计（命中白名单 / 待审 / 被危险模式拦下） */
  | 'bash.policy'
  | 'file.change'
  /** M1 ②：工作区快照差分得到的合成文件变更证据（非工具调用记录） */
  | 'evidence.file_change'
  | 'usage.snapshot'
  | 'usage.updated'
  | 'session.metadata'
  /** D5 审计：进程回收动作（独立于 residualRisk，action 发生即留痕） */
  | 'process.reclaimed'
  /** P0-2：事件保留策略每次执行的留痕（无对应 turn 行，因此自身永不被清理） */
  | 'retention.cleanup'
  | 'error'

/** 归一化事件信封（落库前 seq 由 EventSink 分配；落库时 run 级 seq 可能被重排） */
export interface NormalizedEventEnvelope {
  eventId: string
  runId: string
  turnId: string
  /** turn 内局部序号，从 1 连续递增 */
  seq: number
  type: NormalizedEventType
  source: EventSource
  fidelity: Fidelity
  payloadVersion: 1
  payload: Record<string, unknown>
  timestamp: number
  /** 工具类事件的步骤关联 id（与 agent_steps.id 对齐） */
  stepId?: string
}

export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'

export type StepStatus =
  | 'requested'
  | 'awaiting_approval'
  | 'approved'
  | 'denied'
  | 'running'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'unknown'

export type RunStatus =
  | 'created'
  | 'running'
  | 'awaiting_approval'
  | 'cancelling'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'superseded'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type PolicyDecision = 'allow' | 'deny' | 'ask'
export type DecidedBy = 'user' | 'policy' | 'timeout' | 'system' | 'startup'
export type ApprovalMode = 'interactive' | 'unattended'

export interface ApprovalRequestInput {
  runId: string
  turnId: string
  stepId?: string
  toolName: string
  args: Record<string, unknown>
  risk?: RiskLevel
  policyDecision?: PolicyDecision
  mode?: ApprovalMode
  /** 所属 agent_sessions.id（会话级授权的作用域键） */
  sessionId?: string
  /** 会话工作目录；会话级授权只覆盖该目录下的写路径 */
  cwd?: string
}

export interface ApprovalRequestPayload {
  approvalId: string
  runId: string
  turnId: string
  /** 所属 agent_sessions.id；决议时回传用于归属校验 */
  sessionId?: string
  stepId?: string
  toolName: string
  argsJson: string
  argsHash: string
  /**
   * true 表示这是**重启重放**的历史审批：argsJson 已脱敏，不是完整原文。
   * UI 必须提示「历史审批记录中的敏感内容已脱敏」，不得声称展示的是完整命令。
   */
  argsRedacted?: boolean
  risk: RiskLevel
  /** Bash 等宿主策略命中的危险规则名（如 pipe/redirect/shell-escape/not-in-whitelist） */
  policyRule?: string
  /** 该规则的可读说明；与 policyRule 一起说清「在批什么」 */
  policyReason?: string
  status: 'pending'
  expiresAt: number
  createdAt: number
  mode: ApprovalMode
  /** 本次审批的超时上限（毫秒），供 UI 首帧 clamp，避免出现 > timeout 的倒计时 */
  timeoutMs: number
  /**
   * 是否允许「允许本会话」。
   *
   * 只有写类工具可以为 true：会话级授权的语义是「会话工作目录内的写操作免审」。
   * Bash/Shell/网络等非写类工具的会话授权会退化成写权限（人批的是命令，拿到的是改文件），
   * 因此这类工具只能逐次允许（false），UI 不得展示「允许本会话」。
   * 缺省视为 true（仅兼容旧 payload；生产 payload 一律显式下发）。
   */
  sessionGrantable?: boolean
}

export interface ApprovalResolutionPayload {
  approvalId: string
  runId: string
  turnId: string
  decision: 'allow' | 'deny'
  decidedBy: DecidedBy
  argsHash: string
  decidedAt: number
  /** 本次决议是否建立了会话级授权（用户选择「允许本次会话」） */
  sessionGranted?: boolean
  /** 会话级授权的来源 approval id（首次弹窗那一次的决定） */
  grantSourceApprovalId?: string
}

export interface ApprovalDecisionInput {
  approvalId: string
  decision: 'allow' | 'deny'
  decidedBy?: Exclude<DecidedBy, 'timeout'>
  /** 必须回传请求时下发的 argsHash，防止 TOCTOU */
  argsHash: string
  /** 仅 decision=allow 时有效：once（默认）或 session（本次会话记住） */
  scope?: 'once' | 'session'
  /**
   * 归属校验（IPC 层必填）：决策方声明的会话/轮次/run 必须与被审批行一致。
   * 只校验 argsHash 会让其它窗口/会话对同一 approval id 下单，必须显式拒绝。
   */
  sessionId?: string
  turnId?: string
  runId?: string
  /** 发起方（webContents.id）：与会话的窗口绑定时校验，无绑定（重启恢复）则跳过 */
  senderId?: number
}

export interface ApprovalOutcome {
  approvalId: string
  decision: 'allow' | 'deny'
  decidedBy: DecidedBy
  argsHash: string
  decidedAt: number
  /** 本次决议建立了会话级授权（来源即本 approvalId） */
  sessionGranted?: boolean
  /** 本次允许来自既有的会话级授权，值为首次授权的 approval id */
  grantSourceApprovalId?: string
  /** 沿用会话级授权、未弹窗的自动放行 */
  autoGranted?: boolean
}

/** 会话级授权（内存态，进程重启不继承；session 结束即失效） */
export interface SessionGrantInfo {
  sessionId: string
  /** 首次授权对应的 approval id */
  approvalId: string
  grantedAt: number
  /** 被批准的原始工具名（授权只能来自写类工具的批准） */
  toolName: string
  /** 作用工具类别：仅写类工具 */
  toolScope: 'write'
  /** 路径作用域根（会话工作目录）；空字符串表示无路径作用域（此时不自动放行） */
  cwd: string
}

/** 运行时特性开关（渲染层只读，权威在主进程环境变量） */
export interface AgentRuntimeFlags {
  /** 总开关：默认 true；BIZGRAPH_AGENT_KERNEL=0 时 false（全部回旧路径） */
  kernelPath: boolean
  /** 实际走 kernel 的后端家族白名单（默认 ['claude']） */
  kernelBackends?: string[]
  /** 是否通过 UNSAFE 逃生口强制未具备审批的后端走 kernel（降级运行） */
  kernelUnsafeOverride?: boolean
}

export interface DriverCapabilities {
  toolEvents: 'exact' | 'none'
  toolArgs: 'raw' | 'none'
  toolLifecycle: 'exact' | 'cli-status' | 'none'
  approval: 'pre-exec' | 'pre-exec-synthetic' | 'policy-only' | 'none'
  fileChanges: 'diff' | 'hook' | 'synthetic-snapshot' | 'none'
  usage: 'token-snapshot' | 'turn-aggregate' | 'none'
  completion: 'iterator-end' | 'backend-turn-completed'
}

export interface DriverUsage {
  inputTokens?: number
  outputTokens?: number
  /** 命中缓存读取的输入 token（Claude cache_read_input_tokens / Codex cached_input_tokens） */
  cachedInputTokens?: number
  /**
   * 写入缓存（cache creation）的输入 token，账本单列不合并：
   * Claude 的 `cache_creation_input_tokens` 与读取缓存计费口径不同，合并会丢信息。
   */
  cacheCreationInputTokens?: number
  /** 后端报告用量所用的模型（计价维度；取不到则按缺价处理，cost=NULL） */
  model?: string
  isEstimate?: boolean
  /** provider=后端真实用量 / estimated=估算 */
  source?: 'provider' | 'estimated'
}

export interface DriverExecuteRequest {
  runId: string
  turnId: string
  graphId?: string
  nodeId: string
  /** 适配器层的 session id（runtime session 内的 runtime_session_id） */
  agentSessionId: string
  prompt: string
  commandType: string
  workingDirectory: string
}

export interface DriverExecuteResult {
  status: 'completed' | 'failed' | 'cancelled'
  finalText?: string
  usage?: DriverUsage
  errorCode?: string
  errorMessage?: string
  completionSignal: DriverCapabilities['completion']
}

export interface DriverExecuteContext {
  /** 追加归一化事件（driver 内部按产生顺序调用） */
  record: (events: NormalizedEventEnvelope[]) => void
  /** D4 审批桥：写前拦截 */
  approvals: {
    request: (input: Omit<ApprovalRequestInput, 'runId' | 'turnId'>) => Promise<ApprovalOutcome>
    /**
     * 只读预判：当前请求是否会命中会话级授权（命中则不产生 approval.required，
     * 由 request 直接落一条 grant_source 记录的 allowed 审批）。
     */
    peek?: (input: Omit<ApprovalRequestInput, 'runId' | 'turnId'>) => { grantSourceApprovalId: string } | null
  }
  /** 步骤状态落库（before-tool 写 executing_at，after-tool 写终态） */
  step: {
    ensure: (stepId: string, input: { kind: string; toolName?: string; argsHash?: string; fidelity: Fidelity; status: StepStatus }) => void
    update: (stepId: string, status: StepStatus, extra?: { resultRef?: string; executingAt?: number; approvedAt?: number }) => void
  }
  signal: AbortSignal
  /** 进程回收标记（落库到 agent_sessions.executor_env_marker） */
  envMarker: string
  /**
   * 登记本轮真正 spawn 的子进程句柄。
   * 取消与启动清扫只按这里登记（或落库）的 pid/pgid 回收，不做厂商正则认领。
   */
  registerProcess: (proc: {
    pid?: number
    pgid?: number
    envMarker?: string
    /** 进程自注册得到的启动时间（可跳过实时 ps 抓取） */
    startedAt?: string
    /** 进程自注册得到的命令行 */
    command?: string
    /** 进程自注册得到的 Linux 高精度启动标识（其他平台为空） */
    startedAtHiRes?: string
  }) => void
}

export interface BackendDriver {
  readonly name: ExecutorVendor
  readonly capabilities: DriverCapabilities
  execute(request: DriverExecuteRequest, context: DriverExecuteContext): Promise<DriverExecuteResult>
  cancel(request: DriverExecuteRequest): Promise<void>
}

export interface RunNodeRequest {
  runId?: string
  graphId?: string
  nodeId: string
  threadId?: string
  executor: string
  /** Runtime 会话行 id（agent_sessions.id） */
  agentSessionId: string
  /** 适配器层 session id；缺省时与 agentSessionId 相同 */
  adapterSessionId?: string
  prompt: string
  commandType?: string
  workingDirectory: string
  branchKey?: string
  attempt?: number
  idempotencyKey?: string
  resumeMode?: 'native' | 'replay' | 'fresh'
  mode?: ApprovalMode
}

export interface TurnOutcome {
  runId: string
  turnId: string
  status: Exclude<TurnStatus, 'queued' | 'running' | 'waiting_approval' | 'cancelling'>
  finalText?: string
  reused: boolean
  errorCode?: string
}

/** §5.5 五行判定：每条 step 都必须落到这三种处置之一。 */
export type StepDisposition = 'completed' | 'unknown-needs-rerun' | 'needs-human'

export interface StepOutcome {
  stepId: string
  disposition: StepDisposition
  action: 'keep' | 'replay' | 'needs-human'
  reason: string
}

export interface RecoveryPlan {
  runId: string
  turnId?: string
  sessionId?: string
  action:
    | 'project_run_completed'
    | 'abort_turn'
    | 'mark_session_orphaned'
    | 'mark_run_interrupted'
    | 'keep_pending_approval'
  reason: string
  /** abort_turn 时逐 step 的确定处置，并写入 agent_steps.test_disposition */
  stepOutcomes?: StepOutcome[]
}

/**
 * 「残留无法确认」的可见状态（session 级，不是 turn 状态）。
 * - none：无迹象
 * - possible：归属可证明，但未能确认已退出
 * - unconfirmed：有线索（pid/marker），但证据不足以证明归属，按「只告警不杀」处理
 */
export type ResidualRisk = 'none' | 'possible' | 'unconfirmed'

export interface ReclaimedSession {
  sessionId: string
  marker: string | null
  killed: number
  killedPids: number[]
  killedGroups: number[]
  /** 无法证明归属而放弃回收时的显式状态（none 表示无需告警） */
  residualRisk: ResidualRisk
  note: string
}

export interface RecoveryReport {
  plans: RecoveryPlan[]
  interruptedRuns: number
  abortedTurns: number
  orphanedSessions: number
  pendingApprovals: number
  /** 启动对账时被置为 denied 的陈旧审批数（decided_by='startup'，不再推 UI） */
  deniedStaleApprovals?: number
  reactiveKills: number
  /** 来自进程自注册文件（Codex 监督 shim）的回收数，已计入 reactiveKills */
  registryKills?: number
  /** 启动清扫的逐会话结果（已落库到 agent_sessions.recovery_*） */
  reclaimedSessions: ReclaimedSession[]
  /** 残留状态非 none 的会话数（恢复摘要投影用） */
  residualRiskSessions: number
}

/** IPC：会话恢复/残留状态投影（渲染层头部徽标用）。 */
export interface SessionRecoveryInfo {
  sessionId: string
  residualRisk: ResidualRisk
  recoveryNote: string | null
  recoveryKills: number
  lastRecoveryAt: number | null
}

/** settings 里按 (executor, model) 指定的一条单价（单位：currency / 百万 token）。 */
export interface CostRateModel {
  /** 后端名（claude-code / codex / ...），'*' 表示所有后端 */
  executor: string
  /** 模型名，'*' 表示该后端全部模型 */
  model: string
  inputPerMillion?: number
  outputPerMillion?: number
  cachedInputPerMillion?: number
  currency?: string
}

/**
 * 用户配置的单价（settings.agentRuntime.costRates）。
 *
 * 优先级：本配置 > 内置价格表；未配置的 (executor, model) 回落内置表；
 * 两层都没有 → 缺价（cost_micros=NULL, cost_status='missing_price'），不猜价。
 */
export interface CostRates {
  currency?: string
  /** 每百万输入 token 的成本（不做任何内置汇率/单价） */
  inputPerMillion?: number
  /** 每百万输出 token 的成本 */
  outputPerMillion?: number
  /** 每百万缓存命中输入 token 的成本（不填按 0） */
  cachedInputPerMillion?: number
  /** 按模型覆盖的单价，优先于上面的全局单价 */
  models?: CostRateModel[]
}

/**
 * 定价分类（agent_usage.cost_status 的取值）。
 * NULL（历史行未标注）不在此列：它既不是「已定价」，也不等于「缺价」。
 */
export type UsageCostStatus = 'priced' | 'missing_price' | 'not_reported'

/**
 * M1 用量可视化：一个聚合口径（图×日 / 会话 / turn 共用）。
 * `knownCostMicros` 只累计有价格的行；缺价行单独计入 `unknownCostRows`，绝不按 0 混入金额。
 * `pricedRows/missingPriceRows/notReportedRows` 直接来自 cost_status 列；
 * `costStatusUnknownRows` 是迁移后未标注的历史行（UI 必须单独显示，不能当作已定价）。
 */
export interface UsageSummary {
  /** 聚合到的原始行数；为 0 表示「没有记录」，而不是「花了 0」 */
  totalRows: number
  /** 已成功计价部分的 micros 合计（1 USD = 1_000_000 micros） */
  knownCostMicros: number
  /** cost_micros IS NULL 的行数（含 unknown 行：这些行没有任何金额可用） */
  unknownCostRows: number
  /** cost_micros IS NULL 且 source != 'unknown' 的行数（旧口径「缺价」，保留做回归比对） */
  unpricedRows: number
  /** source=provider 的行数（后端真实上报） */
  providerRows: number
  /** source=estimated 的行数（本地估算） */
  estimatedRows: number
  /** source=unknown 的行数（后端未上报用量） */
  unknownRows: number
  /** cost_status='priced' 的行数（列驱动，UI 以此为准） */
  pricedRows: number
  /** cost_status='missing_price' 的行数（列驱动） */
  missingPriceRows: number
  /** cost_status='not_reported' 的行数（列驱动） */
  notReportedRows: number
  /** cost_status IS NULL 的行数（迁移前写入的历史行，未标注定价状态） */
  costStatusUnknownRows: number
  /** input_tokens IS NULL 的行数（token 数据缺失，合计只含有数据的行） */
  unknownTokenRows: number
  /** tokens_reported=1 的行数（后端确实上报了 token） */
  tokensReportedRows: number
  /** tokens_reported=0 的行数（该调用有 token 概念但后端未上报） */
  tokensNotReportedRows: number
  /** tokens_reported IS NULL 的行数（无 token 概念，或迁移前历史行未标注） */
  tokensReportedUnknownRows: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** 缓存写入 token；与 cachedInputTokens（缓存读取）分开统计 */
  cacheCreationInputTokens: number
}

/** 图 × 本地日（day_key 由主进程按 Asia/Shanghai 切日，渲染层不得二次切日）。 */
export interface GraphDayUsageSummary extends UsageSummary {
  graphId: string
  dayKey: string
}

/** agent_usage 的明细行（IPC 只读投影）。 */
export interface AgentUsageRecord {
  id: string
  turn_id: string | null
  session_id: string
  executor: string
  graph_id: string | null
  node_id: string | null
  model: string | null
  /** Asia/Shanghai 本地日；渲染层原样展示 */
  day_key: string
  input_tokens: number | null
  output_tokens: number | null
  cached_input_tokens: number | null
  /** 缓存写入 token（Claude cache_creation_input_tokens），与读取缓存分列 */
  cache_creation_input_tokens: number | null
  currency: string
  cost_usd: number
  /** NULL = 缺价（展示「价格未知」，不得显示 $0.00） */
  cost_micros: number | null
  price_version: string | null
  is_estimate: number
  source: 'provider' | 'estimated' | 'unknown'
  /** 定价分类；NULL = 迁移前历史行未标注（不得显示为「已定价」） */
  cost_status: UsageCostStatus | null
  /** 1=后端上报 token / 0=未上报 / NULL=无 token 概念或历史行未标注（不得显示为 0 token） */
  tokens_reported: number | null
  /** 人类可读的归属/缺价说明；分类判断不得依赖此文本 */
  attribution_note: string | null
  dedupe_key: string | null
  recorded_at: number
}

/** 会话级用量视图：汇总 + 最近明细。 */
export interface SessionUsageView {
  sessionId: string
  summary: UsageSummary
  rows: AgentUsageRecord[]
}

/** 图级按日视图（days 按 day_key 倒序）。 */
export interface GraphUsageView {
  graphId: string
  days: GraphDayUsageSummary[]
}

/**
 * agent_events 存储统计（P0-2）。
 * 只做观测，不触发 VACUUM：SQLite 会复用空闲页，VACUUM 会长时间锁库。
 */
export interface AgentStorageStats {
  eventRows: number
  /** agent_events 占用估算（字节） */
  estimatedBytes: number
  /** dbstat=SQLite 页统计；payload=序列化字节 + 行开销估算 */
  estimation: 'dbstat' | 'payload'
  oldestEventAt: number | null
  newestEventAt: number | null
  retentionDays: number
  batchSize: number
}
