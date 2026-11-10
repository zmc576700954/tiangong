/**
 * Mode Registry（G2-1 五通道/模式库,session-map 蓝图 §5.5 / II-03）
 *
 * 模式 = 「任务类型 × 执行器 × 作用域 × ContextBundle × IO 契约」的固化定义。
 * 本期只做**代码常量**，不建表、不提供写入接口——模式库的增删改随代码评审走，
 * 避免运行期被数据改写成不可复现的路由。
 *
 * fail-closed：
 *  - 注册表超过 32 个模式、或 id 重复 → 模块加载即抛错，应用拒绝启动；
 *  - `assertKnownMode` 对未知 mode_id 抛错（写 `routing_decisions.mode_id` 前校验）；
 *  - `matchMode` 无命中返回 null，调用方必须转 `TIER_UNSUPPORTED`，不得静默降级。
 *
 * 妥协（已登记 I.9.3）：模式目前只是路由标签，**不参与执行器参数/提示词调参**，
 * 也没有真正的模式库存储与可视化编辑。
 */

export const MODE_REGISTRY_LIMIT = 32

export type ModeTaskType = 'code_change' | 'test' | 'review' | 'investigation' | 'human_review'
export type ModeExecutorKind = 'agent' | 'test' | 'human'
export type ModeScope = 'file' | 'node' | 'graph' | 'repo'
export type ModePolicy = 'single_agent' | 'manual_override' | 'fallback'

export interface ModeDefinition {
  /** 稳定标识：写进 `routing_decisions.mode_id`，不得随文案变化。 */
  id: string
  label: string
  taskType: ModeTaskType
  executorKind: ModeExecutorKind
  scope: ModeScope
  /** ContextBundle：执行时允许装配的上下文来源（只做声明，本期不驱动装配）。 */
  contextBundle: string[]
  /** IO 契约：输入/输出的最小形状声明（只做声明，本期不做 schema 校验）。 */
  ioContract: { input: string; output: string }
  /** 该模式默认的路由 policy；落库前由调用方显式选择。 */
  policy: ModePolicy
}

const MODES: readonly ModeDefinition[] = [
  {
    id: 'agent.implement',
    label: 'Agent 实现（pinned adapter）',
    taskType: 'code_change',
    executorKind: 'agent',
    scope: 'file',
    contextBundle: ['work_item', 'plan_steps', 'scope_files', 'repo_conventions'],
    ioContract: { input: 'work_item + steps', output: 'agent_turn' },
    policy: 'manual_override',
  },
  {
    id: 'agent.fallback',
    label: 'Agent 实现（降级候选）',
    taskType: 'code_change',
    executorKind: 'agent',
    scope: 'file',
    contextBundle: ['work_item', 'plan_steps', 'scope_files'],
    ioContract: { input: 'work_item + steps', output: 'agent_turn' },
    policy: 'fallback',
  },
  {
    id: 'test.verify',
    label: '测试执行/校验',
    taskType: 'test',
    executorKind: 'test',
    scope: 'repo',
    contextBundle: ['work_item', 'test_plan', 'change_set'],
    ioContract: { input: 'test_plan + worktree', output: 'test_run + evidence' },
    policy: 'single_agent',
  },
  {
    id: 'human.review',
    label: '人工确认/判断',
    taskType: 'human_review',
    executorKind: 'human',
    scope: 'node',
    contextBundle: ['work_item', 'acceptance', 'node_context'],
    ioContract: { input: 'work_item + acceptance', output: 'human_confirm' },
    policy: 'manual_override',
  },
]

function validateRegistry(modes: readonly ModeDefinition[]): void {
  if (modes.length > MODE_REGISTRY_LIMIT) {
    throw new Error(`mode registry 超上限 ${MODE_REGISTRY_LIMIT}（当前 ${modes.length}）`)
  }
  const seen = new Set<string>()
  for (const mode of modes) {
    if (!mode.id || !/^[a-z][a-z0-9_.]*$/.test(mode.id)) {
      throw new Error(`mode id 非法：${mode.id}`)
    }
    if (seen.has(mode.id)) throw new Error(`mode id 重复：${mode.id}`)
    seen.add(mode.id)
  }
}

validateRegistry(MODES)

/** 只读列表（返回副本，调用方不能改注册表）。 */
export function listModes(): ModeDefinition[] {
  return MODES.map((mode) => ({ ...mode, contextBundle: [...mode.contextBundle], ioContract: { ...mode.ioContract } }))
}

/** 未知 mode_id fail-closed（写 `routing_decisions.mode_id` 前调用）。 */
export function assertKnownMode(modeId: string): ModeDefinition {
  const mode = MODES.find((m) => m.id === modeId)
  if (!mode) throw new Error(`未知 mode_id：${modeId}（mode registry fail-closed）`)
  return mode
}

export interface ModeMatchInput {
  executorKind: ModeExecutorKind
  policy: ModePolicy
  adapterName?: string | null
}

/**
 * 确定性规则匹配：执行器 + policy 决定模式，不看模型名（模型名升级不应改变路由）。
 * 无命中返回 null，调用方必须转 `TIER_UNSUPPORTED`。
 */
export function matchMode(input: ModeMatchInput): ModeDefinition | null {
  if (input.executorKind === 'human') return MODES.find((m) => m.id === 'human.review') ?? null
  if (input.executorKind === 'test') return MODES.find((m) => m.id === 'test.verify') ?? null
  if (input.executorKind === 'agent') {
    if (!input.adapterName || input.adapterName.trim() === '') return null
    if (input.policy === 'fallback') return MODES.find((m) => m.id === 'agent.fallback') ?? null
    return MODES.find((m) => m.id === 'agent.implement') ?? null
  }
  return null
}
