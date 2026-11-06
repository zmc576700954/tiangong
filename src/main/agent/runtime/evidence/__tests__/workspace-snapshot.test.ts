/**
 * M1 ②：工作区快照差分的真实目录测试（不依赖 git）。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
} from '../workspace-snapshot'

let root = ''

async function write(relative: string, content: string): Promise<void> {
  const absolute = path.join(root, relative)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, content)
}

async function remove(relative: string): Promise<void> {
  await fs.unlink(path.join(root, relative))
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bizgraph-evidence-'))
  await write('existing.txt', 'before')
  await write('to-delete.txt', 'delete me')
  await write('src/app.ts', 'export const x = 1\n')
  await write('node_modules/pkg/index.js', 'module.exports = 1\n')
  await write('.git/objects/aa', 'git object\n')
  await write('dist/bundle.js', 'bundle\n')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('workspace snapshot diff (M1② evidence)', () => {
  it('detects add / modify / delete with explicit change types', async () => {
    const before = await captureWorkspaceSnapshot(root)
    await write('added.txt', 'brand new')
    await write('existing.txt', 'after but longer')
    await remove('to-delete.txt')
    const after = await captureWorkspaceSnapshot(root)

    const evidence = diffWorkspaceSnapshots(before, after)

    expect(evidence.kind).toBe('workspace-snapshot-diff')
    expect(evidence.toolAttribution).toBe('unknown')
    expect(evidence.outOfWorkspaceChanges).toBe('not-included')
    expect(evidence.totalCount).toBe(3)
    expect(evidence.truncated).toBe(false)
    expect(evidence.changes).toEqual(
      expect.arrayContaining([
        { path: 'added.txt', changeType: 'add' },
        { path: 'existing.txt', changeType: 'modify' },
        { path: 'to-delete.txt', changeType: 'delete' },
      ]),
    )
  })

  it('ignores node_modules / .git internals / build output', async () => {
    const before = await captureWorkspaceSnapshot(root)
    await write('node_modules/pkg/index.js', 'module.exports = 2\n')
    await write('.git/objects/aa', 'changed git object\n')
    await write('dist/bundle.js', 'new bundle\n')
    await write('src/app.ts', 'export const x = 2\n')
    const after = await captureWorkspaceSnapshot(root)

    const evidence = diffWorkspaceSnapshots(before, after)

    expect(evidence.changes).toEqual([{ path: 'src/app.ts', changeType: 'modify' }])
    expect(evidence.changes.some((c) => c.path.includes('node_modules'))).toBe(false)
    expect(evidence.changes.some((c) => c.path.startsWith('.git/'))).toBe(false)
    expect(evidence.changes.some((c) => c.path.startsWith('dist/'))).toBe(false)
  })

  it('works in a non-git directory (no .git present)', async () => {
    const noGitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bizgraph-evidence-nogit-'))
    try {
      await fs.writeFile(path.join(noGitRoot, 'a.txt'), 'a')
      const before = await captureWorkspaceSnapshot(noGitRoot)
      await fs.writeFile(path.join(noGitRoot, 'b.txt'), 'b')
      const after = await captureWorkspaceSnapshot(noGitRoot)
      const evidence = diffWorkspaceSnapshots(before, after)
      expect(evidence.totalCount).toBe(1)
      expect(evidence.changes[0]).toEqual({ path: 'b.txt', changeType: 'add' })
      expect(evidence.scanTruncated).toBe(false)
    } finally {
      await fs.rm(noGitRoot, { recursive: true, force: true })
    }
  })

  it('truncates the change list over the limit and keeps the true total', async () => {
    const before = await captureWorkspaceSnapshot(root)
    for (let i = 0; i < 60; i += 1) {
      await write(`bulk/file-${String(i).padStart(2, '0')}.txt`, `content ${i}`)
    }
    const after = await captureWorkspaceSnapshot(root)

    const evidence = diffWorkspaceSnapshots(before, after, { maxChanges: 50 })

    expect(evidence.totalCount).toBe(60)
    expect(evidence.changes).toHaveLength(50)
    expect(evidence.displayedCount).toBe(50)
    expect(evidence.truncated).toBe(true)
    expect(evidence.limit).toBe(50)
    // 前 50 条按路径排序，截断标记不影响 turn 完成
    expect(evidence.changes[0].path).toBe('bulk/file-00.txt')
    expect(evidence.changes[49].path).toBe('bulk/file-49.txt')
  })

  it('records large files without hashing them and still detects the change', async () => {
    const before = await captureWorkspaceSnapshot(root)
    await write('large.bin', 'x'.repeat(600 * 1024))
    const after = await captureWorkspaceSnapshot(root)

    const evidence = diffWorkspaceSnapshots(before, after)
    expect(evidence.unhashedFiles).toBeGreaterThanOrEqual(1)
    expect(evidence.changes).toEqual([{ path: 'large.bin', changeType: 'add' }])
    expect(after.files.get('large.bin')?.hash).toBeUndefined()
  })

  it('marks the evidence as incomplete when the file-count limit is hit', async () => {
    for (let i = 0; i < 10; i += 1) {
      await write(`many/f-${i}.txt`, `x${i}`)
    }
    const snapshot = await captureWorkspaceSnapshot(root, { maxFiles: 3 })
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.truncatedReason).toBe('file_limit')
    expect(snapshot.scannedFiles).toBeLessThanOrEqual(3)
  })

  it('returns an honest unreadable marker instead of throwing when the root is missing', async () => {
    const missing = path.join(root, 'does-not-exist')
    const snapshot = await captureWorkspaceSnapshot(missing)
    expect(snapshot.files.size).toBe(0)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.truncatedReason).toBe('root_unreadable')
  })
})
