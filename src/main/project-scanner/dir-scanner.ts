/**
 * 目录结构扫描模块
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { ScopeGuardError, ErrorCode } from '../errors'
import { getPlatformProvider } from '../platform'

const IGNORED_DIRS = new Set([
  'node_modules',
  'vendor',
  'target',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
])

/** 最大扫描深度 */
const MAX_SCAN_DEPTH = 4
/** 目录递归深度限制（略小于最大扫描深度，避免过深递归） */
const MAX_RECURSE_DEPTH = 3

function validateProjectPath(projectPath: string): void {
  const provider = getPlatformProvider()
  const resolved = path.resolve(projectPath)
  if (provider.isSystemPath(resolved)) {
    throw new ScopeGuardError(`Invalid project path: ${projectPath} is a system directory`, ErrorCode.SCOPE_PATH_TRAVERSAL)
  }
}

export async function scanDirectory(projectPath: string): Promise<string[]> {
  validateProjectPath(projectPath)

  const structure: string[] = []
  const visited = new Set<string>()

  const scan = async (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (IGNORED_DIRS.has(entry.name)) continue

        const fullPath = path.join(dir, entry.name)
        const relPath = path.relative(projectPath, fullPath)

        if (visited.has(relPath)) continue
        visited.add(relPath)

        if (entry.isDirectory()) {
          structure.push(relPath + '/')
          if (depth < MAX_RECURSE_DEPTH) {
            await scan(fullPath, depth + 1)
          }
        } else {
          structure.push(relPath)
        }
      }
    } catch {
      // ignore permission errors
    }
  }

  await scan(projectPath, 0)
  return structure
}
