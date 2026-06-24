/**
 * Path sandbox helpers — centralised, traversal-safe path containment checks.
 *
 * These helpers fix Windows prefix-bypass vulnerabilities (e.g. `C:\project-evil`)
 * and symlink escapes that simple `startsWith` checks cannot catch.
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

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

  // Any traversal upward escapes the parent.
  if (normalizedRel.startsWith('..')) return false

  // An absolute relative result means the paths are on different Windows
  // drives or otherwise unrelated.
  if (path.isAbsolute(normalizedRel)) return false

  return true
}

/**
 * Return true if `child` is contained within `parent` after both paths are
 * resolved to their real (symlink-free) locations.
 *
 * Falls back to `path.resolve` when `realpath` fails, so the check still works
 * for not-yet-created files.
 */
export async function isPathWithin(parent: string, child: string): Promise<boolean> {
  const [resolvedParent, resolvedChild] = await Promise.all([
    fs.realpath(parent).catch(() => path.resolve(parent)),
    fs.realpath(child).catch(() => path.resolve(child)),
  ])

  return checkRelativeContainment(normalizeForCompare(resolvedParent), normalizeForCompare(resolvedChild))
}

/**
 * Synchronous variant of `isPathWithin` for callers that cannot await.
 */
export function isPathWithinSync(parent: string, child: string): boolean {
  const resolve = (p: string): string => {
    try {
      return fsSync.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }

  return checkRelativeContainment(
    normalizeForCompare(resolve(parent)),
    normalizeForCompare(resolve(child)),
  )
}
