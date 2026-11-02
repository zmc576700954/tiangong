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
 * - mindmap-internal：本来就禁掉了写工具（`claude-runner.ts` 的 `--disallowedTools`）
 */
const READONLY_CAPABLE_ADAPTERS = new Set([
  'claude-code',
  'codex',
  'mcp',
  'mindmap-internal',
])

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
