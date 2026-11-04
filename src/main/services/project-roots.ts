/**
 * 受信任的项目根目录注册表（主进程侧）
 *
 * 背景：渲染层的项目列表存在 localStorage（bizgraph:projects），而
 * fs:registerProjectPaths 过去只认 graphs 表的 project_path —— 两条注册表互不相通：
 * 没生成过图（或图被删）的项目，fs 校验永远拒绝，文件树读不到任何子目录
 * （「打不开子目录」）。这里补上主进程自己的信任根注册表：用户在原生对话框里
 * 亲手选中的目录（menu「打开项目」与 dialog:openDirectory 两条入口都经过这里）
 * 落地持久化。fs 校验按「图路径 ∪ 信任根」放行。安全边界不变：渲染进程仍然
 * 无法凭空注册任意路径，只有物理对话框确认过的目录才进得来。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { validateProjectPath } from '../ipc/utils'

const ROOTS_FILE = 'trusted-project-roots.json'

function getRootsFilePath(): string {
  return path.join(app.getPath('userData'), ROOTS_FILE)
}

/** 校验并归一一个待注册目录；不合格（系统目录 / home 本身）返回 null。 */
function normalizeRoot(rawPath: string): string | null {
  try {
    return validateProjectPath(rawPath)
  } catch {
    return null
  }
}

/** 记录一个用户经原生对话框选中的项目目录。幂等；返回是否记录成功。 */
export async function addTrustedProjectRoot(rawPath: string): Promise<boolean> {
  const normalized = normalizeRoot(rawPath)
  if (!normalized) return false

  const roots = await readRoots()
  if (!roots.includes(normalized)) {
    roots.push(normalized)
    await writeRoots(roots)
  }
  return true
}

/** 信任根列表（文件缺失或损坏时返回空数组，不抛错）。 */
export async function getTrustedProjectRoots(): Promise<string[]> {
  return readRoots()
}

async function readRoots(): Promise<string[]> {
  try {
    const raw = await fs.readFile(getRootsFilePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string')
  } catch {
    return []
  }
}

async function writeRoots(roots: string[]): Promise<void> {
  await fs.mkdir(path.dirname(getRootsFilePath()), { recursive: true })
  await fs.writeFile(getRootsFilePath(), JSON.stringify(roots, null, 2), 'utf-8')
}
