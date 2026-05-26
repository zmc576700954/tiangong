/**
 * 目录结构扫描模块
 */

import fs from 'node:fs/promises'
import path from 'node:path'

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

export async function scanDirectory(projectPath: string): Promise<string[]> {
  const structure: string[] = []
  const visited = new Set<string>()

  const scan = async (dir: string, depth: number) => {
    if (depth > 4) return

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
          if (depth < 3) {
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
