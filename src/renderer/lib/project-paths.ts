/**
 * 项目路径的相对 ↔ 绝对互转（渲染层，浏览器环境）。
 *
 * 渲染层用不了 `node:path`（浏览器上下文），所以这里是**词法**实现 ——
 * 只做「前缀剥离」与「前缀拼接」，不解析符号链接、不做文件系统访问。
 *
 * 为什么存相对路径：项目搬家 / 改名后，绝对路径会失效。相对路径跟着项目走。
 * 运行时再拼回绝对路径 —— 主进程的 `sanitizeAllowedFiles` 用
 * `path.resolve(workingDir, file)`，相对与绝对都吃。
 */

import { normalizeProjectPath } from './utils'

/**
 * 绝对路径 → 相对项目根的相对路径。
 *
 * 不在项目根之下时**原样返回绝对路径** —— 越界的文件本来就该被 ScopeGuard
 * 拒绝，转成 `../..` 反而更难读。
 */
export function toProjectRelative(projectPath: string, absolutePath: string): string {
  const root = normalizeProjectPath(projectPath)
  const file = normalizeProjectPath(absolutePath)
  if (!root || !file) return file
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (file.startsWith(prefix)) return file.slice(prefix.length)
  return file
}

/**
 * 相对项目根的相对路径 → 绝对路径。
 *
 * 已经是绝对路径的**原样返回**（项目级默认里可能存过越界的绝对路径）。
 */
export function fromProjectRelative(projectPath: string, relPath: string): string {
  const root = normalizeProjectPath(projectPath)
  if (!root) return relPath
  if (relPath.startsWith('/')) return relPath
  const prefix = root.endsWith('/') ? root : `${root}/`
  return `${prefix}${relPath}`
}
