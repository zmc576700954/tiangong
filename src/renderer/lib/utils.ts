import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { normalizeProjectPath } from '@shared/project-path'

/**
 * 合并 Tailwind CSS 类名
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 解析路径片段：去掉空片段与 `.`，并按词法消掉 `..`。
 * （与 node 的 `path.resolve` 一样是**词法**解析，不碰符号链接。）
 */

/**
 * 归一化项目路径 —— **只用来比较/去重**，不用来改写真正存库的路径。
 *
 * 实现放在 `@shared/project-path` —— **主进程与渲染层必须用同一份**。
 * 曾经两边各有一份同名函数而语义不同（渲染层把 `\` 换成 `/`、主进程不换），
 * 于是在 POSIX 上 `/work/my\dir` 与 `/work/my/dir` 落到同一行 → A 项目的范围
 * 默认值出现在 B 项目上。
 *
 * 为什么它**不能**被拿去改写要发出去的路径：它不可能和 `path.resolve` 完全等价，
 * 而「归一化错了」的后果是**图绑到一个错的目录**（Agent 在错误的目录里干活），
 * 比「同一个目录列两次」严重得多。真正发出去的路径始终是**原始路径**，
 * 由主进程的 `path.resolve` 还原。
 */
export { normalizeProjectPath } from '@shared/project-path'

/**
 * 从路径取项目名（末段）。项目已从侧边栏移除时的兜底显示名。
 */
export function projectNameFromPath(projectPath: string): string {
  const segments = normalizeProjectPath(projectPath).split(/[/\\]/).filter(Boolean)
  return segments[segments.length - 1] ?? projectPath
}

/**
 * 生成唯一 ID（使用 crypto.randomUUID 保证低碰撞概率）
 */
export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`
}

/**
 * 格式化日期
 */
export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 格式化时间
 */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * 防抖函数
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

/**
 * 获取节点状态对应的 CSS 类名
 */
export function getNodeStatusClass(status: string): string {
  const map: Record<string, string> = {
    draft: 'node-status-draft',
    confirmed: 'node-status-confirmed',
    developing: 'node-status-developing',
    testing: 'node-status-testing',
    review: 'node-status-review',
    published: 'node-status-published',
    placeholder: 'node-status-placeholder',
  }
  return map[status] ?? 'node-status-draft'
}
