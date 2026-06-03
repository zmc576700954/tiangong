/**
 * File System IPC Handlers
 * 文件读写、目录浏览、文件操作（增删改查、移动、复制）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { TypedHandle } from './utils'
import type { FileSearchResult } from '@shared/types'

export type ValidateFsPath = (targetPath: string, operation: 'read' | 'write') => Promise<string>

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '__pycache__', '.DS_Store', '.vscode', '.idea',
  'coverage', '.cache', '.turbo',
])

export async function searchFilesRecursive(
  dirPath: string,
  query: string,
  limit: number = 20,
): Promise<FileSearchResult[]> {
  if (!query) return []
  const results: FileSearchResult[] = []
  const q = query.toLowerCase()

  async function walk(dir: string) {
    if (results.length >= limit) return
    let entries: any[]
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
          path: fullPath,
          relativePath,
          isDirectory: entry.isDirectory(),
        })
      }

      if (entry.isDirectory()) {
        await walk(fullPath)
      }
    }
  }

  await walk(dirPath)
  return results
}

export function registerFsHandlers(validateFsPath: ValidateFsPath, typedHandle: TypedHandle): void {
  // ---- 只读 ----
  typedHandle('fs:readDir', async (_, dirPath) => {
    const validPath = await validateFsPath(dirPath, 'read')
    const entries = await fs.readdir(validPath, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
  })

  typedHandle('fs:readFile', async (_, filePath) => {
    const validPath = await validateFsPath(filePath, 'read')
    return fs.readFile(validPath, 'utf-8')
  })

  /** 危险路径模式：禁止写入系统/隐藏目录 */
  const DANGEROUS_PATH_PATTERNS = [
    /[\\/]node_modules[\\/]/i,
    /[\\/]\.git[\\/]/i,
    /[\\/]\.bizgraph[\\/]/i,
    /[\\/]\.next[\\/]/i,
    /[\\/]dist[\\/]/i,
    /[\\/]dist-electron[\\/]/i,
    /[\\/]release[\\/]/i,
  ]

  function isDangerousPath(filePath: string): boolean {
    return DANGEROUS_PATH_PATTERNS.some((pattern) => pattern.test(filePath))
  }

  typedHandle('fs:writeFile', async (_, filePath, content) => {
    const validPath = await validateFsPath(filePath, 'write')
    if (isDangerousPath(validPath)) {
      throw new Error(`Write rejected: cannot write to protected directory: ${path.basename(validPath)}`)
    }
    await fs.mkdir(path.dirname(validPath), { recursive: true })
    await fs.writeFile(validPath, content, 'utf-8')
  })

  // ---- 文件/目录操作 ----

  /** 读取目录，返回含完整路径、大小、修改时间的信息 */
  typedHandle('fs:readDirDetail', async (_, dirPath) => {
    const validPath = await validateFsPath(dirPath, 'read')
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
  typedHandle('fs:createFile', async (_, filePath) => {
    const validPath = await validateFsPath(filePath, 'write')
    await fs.mkdir(path.dirname(validPath), { recursive: true })
    // 仅在文件不存在时创建，不覆盖
    try {
      await fs.access(validPath)
      throw new Error(`File already exists: ${path.basename(validPath)}`)
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('File already exists')) throw err
      // 文件不存在，可以创建
    }
    await fs.writeFile(validPath, '', 'utf-8')
    return { path: validPath, name: path.basename(validPath) }
  })

  /** 创建目录 */
  typedHandle('fs:createDir', async (_, dirPath) => {
    const validPath = await validateFsPath(dirPath, 'write')
    await fs.mkdir(validPath, { recursive: true })
    return { path: validPath, name: path.basename(validPath) }
  })

  /** 删除文件或目录 */
  typedHandle('fs:delete', async (_, targetPath, recursive = false) => {
    const validPath = await validateFsPath(targetPath, 'write')
    const stat = await fs.stat(validPath)
    if (stat.isDirectory()) {
      await fs.rm(validPath, { recursive: !!recursive, force: true })
    } else {
      await fs.unlink(validPath)
    }
    return { deleted: validPath }
  })

  /** 重命名 */
  typedHandle('fs:rename', async (_, oldPath, newName) => {
    const validOldPath = await validateFsPath(oldPath, 'write')
    const parentDir = path.dirname(validOldPath)
    const newPath = path.join(parentDir, newName)
    const validNewPath = await validateFsPath(newPath, 'write')

    // 检查目标是否已存在
    try {
      await fs.access(validNewPath)
      throw new Error(`Already exists: ${newName}`)
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Already exists')) throw err
    }

    await fs.rename(validOldPath, validNewPath)
    return { oldPath: validOldPath, newPath: validNewPath, newName }
  })

  /** 移动文件/目录 */
  typedHandle('fs:move', async (_, sourcePath, destDir) => {
    const validSource = await validateFsPath(sourcePath, 'write')
    const validDestDir = await validateFsPath(destDir, 'write')
    const fileName = path.basename(validSource)
    const destPath = path.join(validDestDir, fileName)
    const validDestPath = await validateFsPath(destPath, 'write')

    // 检查目标是否已存在
    try {
      await fs.access(validDestPath)
      throw new Error(`Already exists: ${fileName}`)
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Already exists')) throw err
    }

    await fs.rename(validSource, validDestPath)
    return { sourcePath: validSource, destPath: validDestPath, name: fileName }
  })

  /** 复制文件/目录 */
  typedHandle('fs:copy', async (_, sourcePath, destDir) => {
    const validSource = await validateFsPath(sourcePath, 'read')
    const validDestDir = await validateFsPath(destDir, 'write')
    const fileName = path.basename(validSource)
    const destPath = path.join(validDestDir, fileName)
    const validDestPath = await validateFsPath(destPath, 'write')

    // 检查目标是否已存在
    try {
      await fs.access(validDestPath)
      throw new Error(`Already exists: ${fileName}`)
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Already exists')) throw err
    }

    await fs.cp(validSource, validDestPath, { recursive: true })
    return { sourcePath: validSource, destPath: validDestPath, name: fileName }
  })

  /** 检查路径是否存在 */
  typedHandle('fs:exists', async (_, targetPath) => {
    try {
      const validPath = await validateFsPath(targetPath, 'read')
      await fs.access(validPath)
      return true
    } catch {
      return false
    }
  })

  /** 获取文件/目录 stat 信息 */
  typedHandle('fs:stat', async (_, targetPath) => {
    const validPath = await validateFsPath(targetPath, 'read')
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
  typedHandle('fs:searchFiles', async (_, dirPath, query, limit) => {
    const validPath = await validateFsPath(dirPath, 'read')
    return searchFilesRecursive(validPath, query, limit)
  })
}
