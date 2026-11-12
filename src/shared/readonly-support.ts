/**
 * 哪些适配器支持只读，以及只读是怎么实现的。
 *
 * 这里是**唯一**的事实源：只读会话的回退链裁剪（fallback-router）与
 * 各适配器的只读实现都查这张表。
 *
 * 背景：只读**不能**靠 ScopeGuard 实现 —— 空白名单沙箱的 watcher 监听整棵
 * 项目树，分不清「Agent 写的」和「用户写的」，在真实项目目录上会把用户
 * 自己改的文件判为越界并回滚删除（见 src/main/agent/send-and-wait.ts 的注释）。
 * 所以只读必须做在**适配器层**：让 Agent 物理上拿不到写工具。
 */

/** 适配器能否保证只读 */
export type ReadonlySupportLevel =
  /** 该适配器保证 Agent 物理上写不了文件 */
  | 'enforced'
  /** 该适配器无法保证只读 —— 只读会话不应回退到它 */
  | 'unsupported'

/**
 * 支持只读的适配器。
 *
 * - claude-code：SDK 的 `tools` 白名单（不含 Write/Edit/NotebookEdit/Bash）
 * - codex：SDK 的 `sandboxMode: 'read-only'`
 * - mcp：工具集置空（与它的 transparent 分支同一手法）
 *
 * **mindmap-internal 不在此列**：它 spawn 的是 `claude` CLI，写工具靠 CLI 的
 * `--disallowedTools` 挡（见 mindmap-agent/claude-runner.ts 的 buildClaudeArgs），
 * 而那个黑名单既漏了 Bash / MultiEdit，探测失败时还会**一个禁用参数都不加**
 * （fail-open）。它保证不了只读，就不能进这份保证名单。
 */
const READONLY_CAPABLE_ADAPTERS = new Set([
  'claude-code',
  'codex',
  'mcp',
])

/**
 * 内部一次性生成适配器 —— 它们的写保护由**自己的 CLI 层**负责
 * （mindmap-internal 的 `--disallowedTools`），因此**不保证**只读。
 *
 * 用它们起会话时必须**显式**退出只读推导（`resolveReadonly`）：
 * 「空的 allowedFiles」会被推成只读，而 AgentManager 会因为适配器
 * 不保证只读而直接拒绝启动（ADAPTER_READONLY_UNSUPPORTED）
 * → 思维导图生成整个起不来。
 */
const READONLY_OPT_OUT_ADAPTERS = new Set(['mindmap-internal'])

/**
 * 该适配器是否需要**显式**退出只读推导。
 *
 * 只读推导（空 allowedFiles ⇒ 只读）是给**用户会话**的语义：
 * 「用户没圈定可改范围 ⇒ 别乱改」。内部一次性生成流程不是用户会话 ——
 * 它的写保护由适配器自己负责，所以必须显式声明，别让它从
 * 「空的 allowedFiles」偶然推导出只读。
 */
export function isReadonlyOptOutAdapter(adapterName: string): boolean {
  return READONLY_OPT_OUT_ADAPTERS.has(adapterName)
}

/**
 * 该适配器是否保证只读。
 *
 * 未注册的适配器一律视为**不支持** —— 未知适配器不能被信任为只读。
 */
export function getReadonlySupport(adapterName: string): ReadonlySupportLevel {
  return READONLY_CAPABLE_ADAPTERS.has(adapterName) ? 'enforced' : 'unsupported'
}

/** 从候选列表里挑出支持只读的那些（保持原顺序） */
export function listReadonlyCapableAdapters(adapterNames: string[]): string[] {
  return adapterNames.filter((name) => READONLY_CAPABLE_ADAPTERS.has(name))
}
