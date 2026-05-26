/**
 * File System IPC Handlers
 * 文件读写、目录浏览
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { TypedHandle } from './utils'

export type ValidateFsPath = (targetPath: string, operation: 'read' | 'write') => Promise<string>

export function registerFsHandlers(validateFsPath: ValidateFsPath, typedHandle: TypedHandle): void {
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

  typedHandle('fs:writeFile', async (_, filePath, content) => {
    const validPath = await validateFsPath(filePath, 'write')
    await fs.mkdir(path.dirname(validPath), { recursive: true })
    await fs.writeFile(validPath, content, 'utf-8')
  })
}
