/**
 * 项目路径的规范化 —— **跨进程唯一事实源**。
 *
 * 主进程（`src/main/repositories/project-settings-repository.ts`）与渲染层
 * （`src/renderer/lib/utils.ts`）曾各有一份同名函数，语义却不同：渲染层把 `\`
 * 换成 `/`、主进程无条件换。于是：
 * - POSIX 上 `/work/my\dir`（`\` 是**合法文件名字符**）与 `/work/my/dir`
 *   落到同一行 → A 项目的范围默认值出现在 B 项目上；
 * - Windows 上 `C:\work\proj`（主进程 `path.resolve` 的输出）与
 *   `C:/work/proj`（侧栏原始路径）文本不同 → 相对路径算不出来。
 *
 * ## 规则
 *
 * **分隔符按平台定**：
 * - Windows（`\` 是分隔符）：`\` 与 `/` 都当分隔符，输出统一用 `/`
 * - POSIX（`\` 是普通文件名字符）：**只**把 `/` 当分隔符，`\` 一个都不碰
 *
 * 解析 `.` / `..` 段时**保护根**（POSIX 的 `/`、Windows 的 `C:/`、UNC 的
 * `//server/share`），不让 `..` 吃掉根。
 */

/**
 * 当前环境是否 Windows。main 用 process.platform，renderer 用 UA 嗅探。
 */
function detectWindows(): boolean {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'win32'
  }
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    return /Windows/i.test(navigator.userAgent)
  }
  return false
}

/**
 * 这个路径**长得像** Windows 路径吗？
 *
 * 比「当前平台是不是 Windows」更可靠 —— 路径自己就说明了它是什么：
 * - `C:\work` / `C:/work` → 盘符 → Windows
 * - `\\server\share` / `//server/share` → UNC → Windows
 * - `/work/proj` → POSIX 绝对路径
 *
 * 这样**主进程与渲染层对同一个字符串给出同一个答案**，不需要两边都知道
 * 对方跑在什么平台上。
 */
function looksLikeWindowsPath(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  if (path.startsWith('\\\\')) return true
  // '//server/share' 既可能是 UNC，也可能是 POSIX 上恰好有两个斜杠 ——
  // 后者极罕见，按 UNC 处理更安全（UNC 的根前缀不能被 '..' 吃掉）
  if (path.startsWith('//')) return true
  return false
}

/**
 * 把路径规范化成「统一分隔符 + 解析 . 与 .. 段 + 保留根前缀」的形式。
 *
 * @param windows 强制按 Windows 语义处理；不传则**按路径形状**判断
 */
export function normalizeProjectPath(path: string, windows?: boolean): string {
  if (!path) return ''
  const isWin = windows ?? (looksLikeWindowsPath(path) || detectWindows())

  const isUnc = path.startsWith('//') || path.startsWith('\\\\')
  // UNC：server/share 是根，不能被 '..' 吃掉
  const uncBody = isUnc ? path.slice(2) : ''

  // 分隔符：Windows 下 '\' 与 '/' 都算；POSIX 下只有 '/' 算
  const split = (s: string): string[] =>
    (isWin ? s.split(/[/\\]/) : s.split('/'))

  let root = ''
  let rest = path

  if (isUnc) {
    const segs = split(uncBody)
    root = `//${segs[0] ?? ''}/${segs[1] ?? ''}`
    rest = segs.slice(2).join('/')
  } else {
    const driveMatch = isWin ? /^[A-Za-z]:(?=[/\\]|$)/.exec(path) : null
    if (driveMatch) {
      root = `${driveMatch[0].slice(0, 2)}/`
      rest = split(path.slice(2)).join('/')
    } else if (path.startsWith('/')) {
      root = '/'
      rest = split(path).join('/')
    } else {
      // 相对路径 —— 同样按平台切分
      rest = split(path).join('/')
    }
  }

  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // 不能吃掉根
      if (out.length > 0) out.pop()
      continue
    }
    out.push(seg)
  }

  const resolved = out.join('/')
  if (isUnc) {
    const serverShare = root.replace(/\/$/, '')
    return resolved ? `${serverShare}/${resolved}` : serverShare
  }
  if (root === '/') return resolved ? `/${resolved}` : '/'
  if (root) return resolved ? `${root}${resolved}` : root
  return resolved || '/'
}

/**
 * 判断 `relPath` 是否**安全地落在** `projectPath` 之内。
 *
 * 用于「用户往范围里加了一条越界路径」的场景 —— 那条路径会让主进程的
 * ScopeGuard 拒绝**整个会话**（每个候选适配器都失败），错误信息是
 * 「session-start hook failed: Path traversal detected」而不是
 * 「你加的范围里有非法路径」。所以**要在入库前拦下来并说清楚**。
 *
 * @returns 落在项目内时返回规范化后的相对路径；越界/非法时返回 null
 */
export function toSafeRelativePath(projectPath: string, relPath: string): string | null {
  const root = normalizeProjectPath(projectPath)
  if (!root || !relPath) return null

  const trimmed = relPath.trim()
  if (!trimmed) return null

  // 绝对路径（含 Windows 盘符）不是「相对项目根的路径」
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null

  const segments: string[] = []
  for (const seg of trimmed.split(/[/\\]/)) {
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
