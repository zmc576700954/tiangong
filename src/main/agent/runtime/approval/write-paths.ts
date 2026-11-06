/**
 * 写类工具的目标路径解析（审批与 gitdir 守卫共用）。
 *
 * 单独成文件是为了让 gateway 与 gitdir-write-guard 都依赖它而不互相依赖：
 * 作用域判断与会话授权、D1 的 git 元数据拦截必须使用同一套 realpath 口径，
 * 否则两条防线会在 symlink / 大小写 / 相对路径上得出不同结论。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 会话级授权只覆盖「写类工具」，绝不覆盖 Bash/Shell/网络类工具。
 * 这是产品边界：一次会话授权不能退化成任意命令免审。
 */
const WRITE_TOOL_PATTERN =
  /^(write|edit|multiedit|notebookedit|create|delete|remove|move|rename|patch|apply_patch|str_replace|str_replace_editor)$/i

export function isWriteScopedTool(toolName: string): boolean {
  return WRITE_TOOL_PATTERN.test(toolName.trim())
}

/** 单个路径字段（Claude 用 file_path；其他适配器可能用 path/notebook_path）。 */
const SINGLE_PATH_KEYS = ['file_path', 'notebook_path', 'path', 'target_file', 'targetPath']
/** 多路径字段：一次调用写多个目标时，任一越界都必须重新弹窗。 */
const MULTI_PATH_KEYS = ['paths', 'files', 'file_paths', 'targets', 'edits']

function pushPath(targets: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    targets.push(value)
    return
  }
  // edits 等数组元素可能是对象：继续按路径字段取
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    collectPaths(value as Record<string, unknown>, targets)
  }
}

function collectPaths(args: Record<string, unknown>, targets: string[]): void {
  for (const key of SINGLE_PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) targets.push(value)
  }
  for (const key of MULTI_PATH_KEYS) {
    const value = args[key]
    if (Array.isArray(value)) {
      for (const item of value) pushPath(targets, item)
    }
  }
}

/**
 * 收集一次调用里的**全部**目标路径。写类工具没有可解析路径时返回空数组，
 * 调用方必须视为「不可验证」→ 回到审批（不得静默放行）。
 */
export function targetPathsOf(args: Record<string, unknown>): string[] {
  const targets: string[] = []
  collectPaths(args, targets)
  return [...new Set(targets)]
}

/** realpath 归一，解析 symlink 别名（macOS 的 /tmp → /private/tmp 是最常见的例子）。 */
function tryRealpath(input: string): string | null {
  try {
    return fs.realpathSync(input)
  } catch {
    return null
  }
}

/**
 * 解析「真实路径」：目标常常尚不存在（写新文件），因此自底向上寻找最近的
 * 已存在祖先并 realpath 归一，再把缺失后缀拼回去。
 *
 * 这样能识别**中间目录是 symlink** 的逃逸：`root/link -> /outside` 时，
 * `root/link/new.txt` 即使文件不存在也会落到 `/outside/new.txt`。
 * 注意这是调用时的快照，不跨调用缓存（两次调用之间文件系统可能变化）。
 */
export function resolveRealPath(input: string): string {
  const abs = path.resolve(input)
  const direct = tryRealpath(abs)
  if (direct) return direct
  let current = abs
  const missing: string[] = []
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) return abs
    missing.unshift(path.basename(current))
    const realParent = tryRealpath(parent)
    if (realParent) return path.join(realParent, ...missing)
    current = parent
  }
}

/** macOS 默认大小写不敏感：比较前统一小写，避免大小写变体绕过作用域。 */
export function comparablePath(value: string): string {
  return process.platform === 'darwin' ? value.toLowerCase() : value
}

/**
 * 作用域判断：root 与目标路径都做 realpath 归一（每次调用重新计算）。
 * 尾部分隔符、大小写变体与 symlink 别名都在这里统一。
 */
export function isPathInside(root: string, candidate: string): boolean {
  if (root.length === 0 || candidate.length === 0) return false
  const rootAbs = path.resolve(root)
  const rootReal = comparablePath(resolveRealPath(rootAbs))
  const targetAbs = path.resolve(rootAbs, candidate)
  const targetReal = comparablePath(resolveRealPath(targetAbs))
  const rel = path.relative(rootReal, targetReal)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
