import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

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
function resolvePathSegments(segments: string[]): string[] {
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out
}

/**
 * 归一化项目路径 —— **只用来比较/去重**，不用来改写真正存库的路径。
 *
 * 为什么需要它：主进程存的是 `validateProjectPath` 里 `path.resolve()` 过的路径，
 * 侧边栏存的是用户挑目录时的原始路径（`/work/alpha/`、`C:\work\alpha`…）——
 * 文本不同就会被当成两个目录。
 *
 * 为什么它**不能**被拿去改写要发出去的路径：它不可能和 `path.resolve` 完全等价，
 * 而「归一化错了」的后果是**图绑到一个错的目录**（Agent 在错误的目录里干活），
 * 比「同一个目录列两次」严重得多。真正发出去的路径始终是**原始路径**，
 * 由主进程的 `path.resolve` 还原。
 *
 * 规则（与 `path.resolve` 对同一目录给出一致的指向）：
 *   - POSIX 绝对路径（`/work/my\dir`）：反斜杠在 Linux/macOS 上是**合法文件名字符**，
 *     一个都不能碰；只做尾斜杠与 `.`/`..` 的词法归一。
 *   - Windows 盘符（`C:\work\alpha`）：统一分隔符但**保留盘符根**（`C:\` → `C:/`）。
 *   - Windows UNC（`\\server\share\dir`）：统一分隔符但**保留根前缀**
 *     （→ `//server/share/dir`）。
 *   - 绝对路径**绝不能**被归一化成相对路径（相对路径会被主进程按 cwd 解析 → 绑错地方）。
 */
export function normalizeProjectPath(projectPath: string): string {
  // UNC：'\\server\share\dir' → '//server/share/dir'
  if (projectPath.startsWith('\\\\')) {
    const parts = projectPath.slice(2).replace(/\\/g, '/').split('/')
    // server + share 是根，不能被 '..' 吃掉
    const root = parts.slice(0, 2).filter(Boolean)
    const rest = resolvePathSegments(parts.slice(2))
    return '//' + [...root, ...rest].join('/')
  }
  // 盘符：'C:\work\alpha' → 'C:/work/alpha'；'C:\' → 'C:/'（根必须留住）
  const drive = /^([A-Za-z]:)([\\/].*)?$/.exec(projectPath)
  if (drive) {
    const rest = resolvePathSegments((drive[2] ?? '').replace(/\\/g, '/').split('/'))
    return drive[1] + '/' + rest.join('/')
  }
  // POSIX 绝对路径：反斜杠是合法文件名字符 —— 只按 '/' 切分，绝不替换 '\'
  if (projectPath.startsWith('/')) {
    return '/' + resolvePathSegments(projectPath.split('/')).join('/')
  }
  // 相对路径：原样返回（不擅自变成绝对，也不擅自解析成别的目录）
  return projectPath
}

/**
 * 从路径取项目名（末段）。项目已从侧边栏移除时的兜底显示名。
 */
export function projectNameFromPath(projectPath: string): string {
  const segments = normalizeProjectPath(projectPath).split('/').filter(Boolean)
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
