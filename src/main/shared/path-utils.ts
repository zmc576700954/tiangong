/**
 * Path sandbox helpers — centralised, traversal-safe path containment checks.
 *
 * These helpers fix Windows prefix-bypass vulnerabilities (e.g. `C:\project-evil`)
 * and symlink escapes that simple `startsWith` checks cannot catch.
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

function isMissingError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENAMETOOLONG')
}

async function readLinkTarget(p: string): Promise<string | undefined> {
  try {
    const stats = await fs.lstat(p)
    if (stats.isSymbolicLink()) {
      return await fs.readlink(p)
    }
  } catch {
    // Not a symlink or not accessible — ignore.
  }
  return undefined
}

function readLinkTargetSync(p: string): string | undefined {
  try {
    const stats = fsSync.lstatSync(p)
    if (stats.isSymbolicLink()) {
      return fsSync.readlinkSync(p)
    }
  } catch {
    // Not a symlink or not accessible — ignore.
  }
  return undefined
}

/**
 * Resolve a path to its real (symlink-free) location.
 *
 - On ENOENT/ENAMETOOLONG, fall back to `path.resolve` so the check still works
 *   for not-yet-created files.
 * - On other errors, if the path is a symlink, resolve the link target manually
 *   so symlink-escape detection is not weakened.
 * - Otherwise re-throw the original error.
 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch (err) {
    if (isMissingError(err)) {
      return path.resolve(p)
    }
    const target = await readLinkTarget(p)
    if (target !== undefined) {
      return path.resolve(path.dirname(p), target)
    }
    throw err
  }
}

function safeRealpathSync(p: string): string {
  try {
    return fsSync.realpathSync(p)
  } catch (err) {
    if (isMissingError(err)) {
      return path.resolve(p)
    }
    const target = readLinkTargetSync(p)
    if (target !== undefined) {
      return path.resolve(path.dirname(p), target)
    }
    throw err
  }
}

/**
 * Normalize a path for comparison on the current platform.
 * On Windows this lowercases the path and converts backslashes to forward
 * slashes so that case and separator differences cannot bypass containment.
 */
function normalizeForCompare(p: string): string {
  const normalized = path.normalize(p)
  if (process.platform === 'win32') {
    return normalized.replace(/\\/g, '/').toLowerCase()
  }
  return normalized
}

function checkRelativeContainment(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  const normalizedRel = process.platform === 'win32' ? rel.replace(/\\/g, '/') : rel

  // Empty string means the paths are equal.
  if (normalizedRel === '') return true

  // Reject explicit upward traversal (`..` or `../...`).
  if (normalizedRel === '..' || normalizedRel.startsWith('../')) return false

  // An absolute relative result means the paths are on different Windows
  // drives or otherwise unrelated.
  if (path.isAbsolute(normalizedRel)) return false

  return true
}

/**
 * Return true if `child` is contained within `parent` after both paths are
 * resolved to their real (symlink-free) locations.
 */
export async function isPathWithin(parent: string, child: string): Promise<boolean> {
  const [resolvedParent, resolvedChild] = await Promise.all([
    safeRealpath(parent),
    safeRealpath(child),
  ])

  return checkRelativeContainment(normalizeForCompare(resolvedParent), normalizeForCompare(resolvedChild))
}

/**
 * Synchronous variant of `isPathWithin` for callers that cannot await.
 */
export function isPathWithinSync(parent: string, child: string): boolean {
  return checkRelativeContainment(
    normalizeForCompare(safeRealpathSync(parent)),
    normalizeForCompare(safeRealpathSync(child)),
  )
}

/**
 * Optimised variant for callers that have already resolved both paths to their
 * real locations and only need the containment comparison.
 */
export function isPathWithinResolved(parent: string, child: string): boolean {
  return checkRelativeContainment(normalizeForCompare(parent), normalizeForCompare(child))
}
