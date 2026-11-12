/**
 * 只读推导 —— **跨进程唯一实现**。
 *
 * 主进程（`src/main/agent/agent-manager.ts`）与渲染层
 * （`src/renderer/lib/scope.ts`）都用这一份。两边各写一遍「空即只读」的
 * 话，改了一边另一边不跟着变 —— 界面就会与实际会话不一致。
 */

/**
 * 这个会话是不是只读。
 *
 * 规则：
 * 1. **空的 allowedFiles ⇒ 只读**，**即使**调用方带了 `readOnly: false`。
 *    空范围 ⇒ 主进程**不建 ScopeGuard 沙箱**（沙箱只在 allowedFiles 非空时
 *    建，见 `session-lifecycle-manager.ts`）—— 所以放行「空范围 + 可写」
 *    等于给出一个**完全不受限**的可写会话。这个钳制必须在推导里，不能靠
 *    调用方自觉。
 * 2. 有文件范围时，`readOnly` 显式值优先，默认可写。
 * 3. `optOut`：该适配器/机制**自带**写保护（不靠 ScopeGuard），退出推导。
 *    例如 mindmap-internal 靠 CLI 的 `--disallowedTools`、verifyOnly 靠空名单
 *    沙箱。这个例外由**主进程**判定（它知道适配器名与机制），不接受渲染层指定。
 */
export function resolveReadonly(config: {
  allowedFiles: string[]
  readOnly?: boolean
  /** 该适配器/机制自带写保护 ⇒ 显式退出只读推导 */
  optOut?: boolean
}): boolean {
  if (config.optOut) return false
  if (config.allowedFiles.length === 0) return true
  return config.readOnly ?? false
}
