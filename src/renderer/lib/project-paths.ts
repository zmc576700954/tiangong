/**
 * 项目范围路径的互转与校验（渲染层）。
 *
 * ## 规范形态
 *
 * 范围的**规范形态是相对项目根的相对路径**（`src/app.ts`）。存储、显示、
 * 删除比对**全都用这个形态** —— 之前三者各用各的（存用户原样输入、显示绝对
 * 路径、删除时反推相对），导致 `./src/app.ts` 这类非规范写法**删不掉**，
 * 每次新会话又复活 —— 正是「我关了它，它又自己开了」的机制。
 *
 * 为什么存相对：项目搬家 / 改名后，绝对路径会失效。
 *
 * ## 校验
 *
 * 范围里的路径**必须落在项目根之内**。一条越界路径会让主进程的 ScopeGuard
 * 拒绝**整个会话**（每个候选适配器都失败），错误信息是「session-start hook
 * failed: Path traversal detected」而不是「你加的范围里有非法路径」——
 * 所以在入库前就拦下来并说清楚。
 *
 * @shared/project-path 的 `normalizeProjectPath` 是**跨进程唯一**的路径规范化
 * 实现 —— 主进程与渲染层必须用同一份，否则同一个目录会落到两行。
 */

import { normalizeProjectPath } from '@shared/project-path'

export { normalizeProjectPath }

/**
 * 项目根用哪种分隔符 —— **由根自己决定**，不靠平台嗅探。
 *
 * 相对路径的分隔符风格必须与根一致：
 * - 根是 POSIX（`/work/proj`）→ `src\app.ts` 是一个**文件名**（反斜杠是合法字符）
 * - 根是 Windows（`C:/work/proj`）→ `src\app.ts` 是 `src/app.ts`
 */
function rootUsesWindows(projectPath: string): boolean {
  const root = normalizeProjectPath(projectPath)
  return /^[A-Za-z]:\//.test(root) || root.startsWith('//')
}

/** 按项目根的风格切分路径 */
function splitPath(p: string, windows: boolean): string[] {
  return windows ? p.split(/[/\\]/) : p.split('/')
}

/**
 * 把用户输入变成规范形态的相对路径。
 *
 * @returns 落在项目内的相对路径（'/' 分隔）；越界 / 非法 / 绝对路径时返回 null
 */
export function toSafeRelative(projectPath: string, input: string): string | null {
  const root = normalizeProjectPath(projectPath)
  if (!root) return null

  const trimmed = input.trim()
  if (!trimmed) return null

  // 绝对路径不是「相对项目根的路径」
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null

  const windows = rootUsesWindows(projectPath)
  const segments: string[] = []
  for (const seg of splitPath(trimmed, windows)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // 逃出项目根 —— 拒绝
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(seg)
  }
  if (segments.length === 0) return null
  return segments.join('/')
}

/** 相对项目根的相对路径 → 绝对路径（沿用项目根的分隔符风格） */
export function fromRelative(projectPath: string, relPath: string): string {
  const root = normalizeProjectPath(projectPath)
  if (!root) return relPath
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return relPath
  const separator = rootUsesWindows(projectPath) ? '\\' : '/'
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`
  return `${prefix}${relPath}`
}

/**
 * 绝对路径 → 相对项目根的相对路径。
 *
 * 不在项目根之下时返回 null —— 那条路径本来就该被拒绝，转成 `../..` 反而更难读。
 *
 * 根与文件各自按**形状**归一（Windows 盘符/UNC → Windows 语义，POSIX 绝对路径
 * → POSIX 语义），所以同一个目录的两种写法能匹配上 —— 主进程给的是
 * `path.resolve` 过的路径（Windows 上是反斜杠），而渲染层的文件树用侧栏原始
 * 路径（可能是正斜杠）。
 */
export function toRelative(projectPath: string, absolutePath: string): string | null {
  const root = normalizeProjectPath(projectPath)
  const file = normalizeProjectPath(absolutePath)
  if (!root || !file) return null

  const windows = rootUsesWindows(projectPath)
  const separator = windows ? '\\' : '/'
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`
  if (!file.startsWith(prefix)) return null
  const rel = file.slice(prefix.length)
  if (!rel) return null
  return splitPath(rel, windows).join('/')
}
