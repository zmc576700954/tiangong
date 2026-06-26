/**
 * Project scanner disk cache
 * Avoids re-analyzing large projects on every scan by caching the result keyed to project path + root mtime.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import type { ProjectScanResult } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('ProjectScannerCache')

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface CacheEntry {
  projectPath: string
  projectHash: string
  cachedAt: string
  result: ProjectScanResult
}

function getCacheDir(): string {
  return path.join(app.getPath('userData'), 'cache', 'project-scans')
}

function getCacheKey(projectPath: string, projectHash: string): string {
  return crypto.createHash('sha256').update(`${projectPath}|${projectHash}`).digest('hex')
}

function getCacheFilePath(cacheKey: string): string {
  return path.join(getCacheDir(), `${cacheKey}.json`)
}

async function computeProjectHash(projectPath: string): Promise<string | null> {
  const hash = crypto.createHash('sha256')
  hash.update(projectPath)

  async function walk(dir: string, depth: number): Promise<void> {
    // Limit walk depth to avoid excessive I/O on deeply nested dependency trees.
    // node_modules is already skipped, so this bounds legitimate source depth.
    if (depth > 5) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch { return }

    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'out', 'release'])

    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath)
          hash.update(`${fullPath}|${stat.mtimeMs}|${stat.size}`)
        } catch { /* skip */ }
      }
    }
  }

  try {
    await walk(projectPath, 0)
    return hash.digest('hex')
  } catch { return null }
}

export async function readProjectScanCache(projectPath: string): Promise<ProjectScanResult | null> {
  try {
    const projectHash = await computeProjectHash(projectPath)
    if (projectHash == null) return null

    const cacheKey = getCacheKey(projectPath, projectHash)
    const cachePath = getCacheFilePath(cacheKey)

    let raw: string
    try {
      raw = await fs.readFile(cachePath, 'utf-8')
    } catch {
      return null
    }

    const stat = await fs.stat(cachePath)
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
      logger.debug(`Project scan cache expired for ${projectPath}`)
      return null
    }

    const parsed = JSON.parse(raw) as CacheEntry
    if (parsed.projectPath !== projectPath || parsed.projectHash !== projectHash) {
      return null
    }

    logger.debug(`Project scan cache hit for ${projectPath}`)
    return parsed.result
  } catch (err) {
    logger.warn(`Failed to read project scan cache for ${projectPath}`, err)
    return null
  }
}

export async function writeProjectScanCache(
  projectPath: string,
  result: ProjectScanResult,
): Promise<void> {
  try {
    const projectHash = await computeProjectHash(projectPath)
    if (projectHash == null) return

    const cacheKey = getCacheKey(projectPath, projectHash)
    const cachePath = getCacheFilePath(cacheKey)

    await fs.mkdir(path.dirname(cachePath), { recursive: true })

    const entry: CacheEntry = {
      projectPath,
      projectHash,
      cachedAt: new Date().toISOString(),
      result,
    }

    await fs.writeFile(cachePath, JSON.stringify(entry), 'utf-8')
    logger.debug(`Project scan cache written for ${projectPath}`)
  } catch (err) {
    logger.warn(`Failed to write project scan cache for ${projectPath}`, err)
  }
}
