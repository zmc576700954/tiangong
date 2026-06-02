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

function validateProjectPath(projectPath: string): void {
  const resolved = path.resolve(projectPath)
  const blockedPrefixes = process.platform === 'win32'
    ? [
        path.resolve(process.env.SystemRoot || 'C:\\Windows'),
        path.resolve('C:\\Program Files'),
        path.resolve('C:\\Program Files (x86)'),
      ]
    : [
        '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
        '/sys', '/proc', '/dev',
      ]
  const sep = path.sep
  for (const blocked of blockedPrefixes) {
    const normBlocked = path.normalize(blocked)
    const isBlocked = process.platform === 'win32'
      ? resolved.toLowerCase().startsWith(normBlocked.toLowerCase() + sep) ||
        resolved.toLowerCase() === normBlocked.toLowerCase()
      : resolved.startsWith(normBlocked + sep) || resolved === normBlocked
    if (isBlocked) {
      throw new Error(`Invalid project path: ${projectPath} is a system directory`)
    }
  }
}

export async function scanDirectory(projectPath: string): Promise<string[]> {
  validateProjectPath(projectPath)

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
