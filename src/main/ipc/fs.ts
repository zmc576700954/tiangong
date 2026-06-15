/**
 * File System IPC Handlers
 * 文件读写、目录浏览、文件操作（增删改查、移动、复制）
 */

import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type { TypedHandle } from './utils'
import type { FileSearchResult } from '@shared/types'
import { IpcError, ErrorCode } from '../errors'

export type ValidateFsPath = (targetPath: string, operation: 'read' | 'write') => Promise<string>

async function throwIfExists(filePath: string, name: string): Promise<void> {
  try {
    await fs.access(filePath)
    throw new IpcError(`Already exists: ${name}`, ErrorCode.IPC_HANDLER_ERROR)
  } catch (err: unknown) {
    if (err instanceof IpcError && err.message.startsWith('Already exists')) throw err
  }
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '__pycache__', '.DS_Store', '.vscode', '.idea',
  'coverage', '.cache', '.turbo',
])

export async function searchFilesRecursive(
  dirPath: string,
  query: string,
  limit: number = 20,
  maxDepth: number = 10,
): Promise<FileSearchResult[]> {
  if (!query) return []
  const results: FileSearchResult[] = []
  const q = query.toLowerCase()

  async function walk(dir: string, depth: number) {
    if (results.length >= limit || depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // 跳过无权限目录
    }

    for (const entry of entries) {
      if (results.length >= limit) return
      if (SKIP_DIRS.has(entry.name)) continue

      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(dirPath, fullPath)

      if (entry.name.toLowerCase().includes(q)) {
        results.push({
          name: entry.name,
          relativePath,
          isDirectory: entry.isDirectory(),
        })
      }

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1)
      }
    }
  }

  await walk(dirPath, 0)
  return results
}

export function registerFsHandlers(validateFsPath: ValidateFsPath, typedHandle: TypedHandle): void {
  /** 危险路径模式：禁止写入系统/隐藏目录（同时匹配目录路径本身和子路径） */
  const DANGEROUS_PATH_PATTERNS = [
    /[\\/]node_modules([\\/]|$)/i,
    /[\\/]\.git([\\/]|$)/i,
    /[\\/]\.bizgraph([\\/]|$)/i,
    /[\\/]\.next([\\/]|$)/i,
    /[\\/]dist([\\/]|$)/i,
    /[\\/]dist-electron([\\/]|$)/i,
    /[\\/]release([\\/]|$)/i,
  ]

  /** 危险目录名（用于 basename 匹配） */
  const DANGEROUS_DIR_NAMES = new Set([
    'node_modules', '.git', '.bizgraph', '.next', 'dist', 'dist-electron', 'release',
  ])

  function assertNotDangerous(filePath: string): void {
    if (DANGEROUS_PATH_PATTERNS.some((pattern) => pattern.test(filePath))) {
      throw new IpcError(`Write rejected: cannot write to protected directory: ${path.basename(filePath)}`, ErrorCode.IPC_ACCESS_DENIED)
    }
    if (DANGEROUS_DIR_NAMES.has(path.basename(filePath))) {
      throw new IpcError(`Write rejected: cannot write to protected directory: ${path.basename(filePath)}`, ErrorCode.IPC_ACCESS_DENIED)
    }
  }

  /** 路径校验辅助函数（senderId 由 AsyncLocalStorage 自动提供） */
  const vRead = (targetPath: string) => validateFsPath(targetPath, 'read')
  const vWrite = (targetPath: string) => validateFsPath(targetPath, 'write')

  // ---- 只读 ----
  typedHandle('fs:readDir', async (_event, dirPath) => {
    const validPath = await vRead(dirPath)
    const entries = await fs.readdir(validPath, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
  })

  typedHandle('fs:readFile', async (_event, filePath) => {
    const validPath = await vRead(filePath)
    return fs.readFile(validPath, 'utf-8')
  })

  // ---- 文件/目录操作 ----

  /** 读取目录，返回含完整路径、大小、修改时间的信息 */
  typedHandle('fs:readDirDetail', async (_event, dirPath) => {
    const validPath = await vRead(dirPath)
    const entries = await fs.readdir(validPath, { withFileTypes: true })
    const results = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(validPath, entry.name)
        try {
          const stat = await fs.stat(fullPath)
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          }
        } catch {
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: 0,
            mtimeMs: 0,
          }
        }
      }),
    )
    return results
  })

  /** 创建文件 */
  typedHandle('fs:createFile', async (_event, filePath) => {
    const validPath = await vWrite(filePath)
    assertNotDangerous(validPath)
    await fs.mkdir(path.dirname(validPath), { recursive: true })
    // 使用 wx flag 原子性创建文件，避免 TOCTOU 竞态
    try {
      await fs.writeFile(validPath, '', { encoding: 'utf-8', flag: 'wx' })
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new IpcError(`File already exists: ${path.basename(validPath)}`, ErrorCode.IPC_HANDLER_ERROR)
      }
      throw err
    }
    return { path: validPath, name: path.basename(validPath) }
  })

  /** 创建目录 */
  typedHandle('fs:createDir', async (_event, dirPath) => {
    const validPath = await vWrite(dirPath)
    assertNotDangerous(validPath)
    await fs.mkdir(validPath, { recursive: true })
    return { path: validPath, name: path.basename(validPath) }
  })

  /** 删除文件或目录 */
  typedHandle('fs:delete', async (_event, targetPath, recursive = false) => {
    const validPath = await vWrite(targetPath)
    assertNotDangerous(validPath)
    // 使用 lstat 而非 stat，以检测符号链接，防止 TOCTOU 竞态
    const lstat = await fs.lstat(validPath)
    if (lstat.isSymbolicLink()) {
      throw new IpcError('Delete rejected: symbolic links are not allowed', ErrorCode.IPC_ACCESS_DENIED)
    }
    if (lstat.isDirectory()) {
      await fs.rm(validPath, { recursive: !!recursive, force: true })
    } else {
      await fs.unlink(validPath)
    }
    return { deleted: validPath }
  })

  /** 重命名 */
  typedHandle('fs:rename', async (_event, oldPath, newName) => {
    const validOldPath = await vWrite(oldPath)
    assertNotDangerous(validOldPath)
    const parentDir = path.dirname(validOldPath)
    const newPath = path.join(parentDir, newName)

    // 确保新路径不逃逸出父目录（防止路径遍历）
    const resolvedParent = path.resolve(parentDir)
    const resolvedNew = path.resolve(newPath)
    if (!resolvedNew.startsWith(resolvedParent + path.sep) && resolvedNew !== resolvedParent) {
      throw new IpcError('Rename target escapes parent directory', ErrorCode.IPC_ACCESS_DENIED)
    }

    const validNewPath = await vWrite(resolvedNew)
    assertNotDangerous(validNewPath)

    // 检查目标是否已存在
    await throwIfExists(validNewPath, newName)

    await fs.rename(validOldPath, validNewPath)
    return { oldPath: validOldPath, newPath: validNewPath, newName }
  })

  /** 移动文件/目录 */
  typedHandle('fs:move', async (_event, sourcePath, destDir) => {
    const validSource = await vWrite(sourcePath)
    const validDestDir = await vWrite(destDir)
    const fileName = path.basename(validSource)
    const destPath = path.join(validDestDir, fileName)
    const validDestPath = await vWrite(destPath)
    assertNotDangerous(validDestPath)

    // 检查目标是否已存在
    await throwIfExists(validDestPath, fileName)

    await fs.rename(validSource, validDestPath)
    return { sourcePath: validSource, destPath: validDestPath, name: fileName }
  })

  /** 复制文件/目录 */
  typedHandle('fs:copy', async (_event, sourcePath, destDir) => {
    const validSource = await vRead(sourcePath)
    const validDestDir = await vWrite(destDir)
    const fileName = path.basename(validSource)
    const destPath = path.join(validDestDir, fileName)
    const validDestPath = await vWrite(destPath)
    assertNotDangerous(validDestPath)

    // 检查目标是否已存在
    await throwIfExists(validDestPath, fileName)

    await fs.cp(validSource, validDestPath, { recursive: true })
    return { sourcePath: validSource, destPath: validDestPath, name: fileName }
  })

  /** 检查路径是否存在 */
  typedHandle('fs:exists', async (_event, targetPath) => {
    try {
      const validPath = await vRead(targetPath)
      await fs.access(validPath)
      return true
    } catch {
      return false
    }
  })

  /** 获取文件/目录 stat 信息 */
  typedHandle('fs:stat', async (_event, targetPath) => {
    const validPath = await vRead(targetPath)
    const stat = await fs.stat(validPath)
    return {
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    }
  })

  /** 递归搜索文件（用于 @ 提及文件） */
  typedHandle('fs:searchFiles', async (_event, dirPath, query, limit) => {
    const validPath = await vRead(dirPath)
    return searchFilesRecursive(validPath, query, limit)
  })
}
