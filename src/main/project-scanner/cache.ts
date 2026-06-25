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
  rootMtimeMs: number
  cachedAt: string
  result: ProjectScanResult
}

function getCacheDir(): string {
  return path.join(app.getPath('userData'), 'cache', 'project-scans')
}

function getCacheKey(projectPath: string, rootMtimeMs: number): string {
  return crypto.createHash('sha256').update(`${projectPath}|${rootMtimeMs}`).digest('hex')
}

function getCacheFilePath(cacheKey: string): string {
  return path.join(getCacheDir(), `${cacheKey}.json`)
}

async function getRootMtime(projectPath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(projectPath)
    return stat.mtimeMs
  } catch (err) {
    logger.warn(`Failed to stat project path for cache key: ${projectPath}`, err)
    return null
  }
}

export async function readProjectScanCache(projectPath: string): Promise<ProjectScanResult | null> {
  try {
    const rootMtimeMs = await getRootMtime(projectPath)
    if (rootMtimeMs == null) return null

    const cacheKey = getCacheKey(projectPath, rootMtimeMs)
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
    if (parsed.projectPath !== projectPath || parsed.rootMtimeMs !== rootMtimeMs) {
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
    const rootMtimeMs = await getRootMtime(projectPath)
    if (rootMtimeMs == null) return

    const cacheKey = getCacheKey(projectPath, rootMtimeMs)
    const cachePath = getCacheFilePath(cacheKey)

    await fs.mkdir(path.dirname(cachePath), { recursive: true })

    const entry: CacheEntry = {
      projectPath,
      rootMtimeMs,
      cachedAt: new Date().toISOString(),
      result,
    }

    await fs.writeFile(cachePath, JSON.stringify(entry), 'utf-8')
    logger.debug(`Project scan cache written for ${projectPath}`)
  } catch (err) {
    logger.warn(`Failed to write project scan cache for ${projectPath}`, err)
  }
}
