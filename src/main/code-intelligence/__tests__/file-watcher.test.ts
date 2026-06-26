/**
 * CodeFileWatcher 单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CodeFileWatcher } from '../file-watcher'
import type { ProjectIndexer } from '../project-indexer'

// Mock chokidar
const mockOn = vi.fn()
const mockClose = vi.fn().mockResolvedValue(undefined)
const mockWatcher = {
  on: mockOn,
  close: mockClose,
}

vi.mock('chokidar', () => ({
  watch: vi.fn(() => mockWatcher),
}))

// Mock ast-cache
const mockInvalidate = vi.fn()
vi.mock('../ast-cache', () => ({
  getAstCache: vi.fn(() => ({
    invalidate: mockInvalidate,
  })),
}))

import type path from 'node:path'

// Mock path
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof path>('node:path')
  return {
    ...actual,
    resolve: vi.fn((_cwd: string, filePath: string) => `/project/${filePath}`),
    join: actual.join,
    extname: actual.extname,
    basename: actual.basename,
  }
})

describe('CodeFileWatcher', () => {
  let watcher: CodeFileWatcher
  let mockIndexer: ProjectIndexer
  let addHandler: ((filePath: string) => void) | null = null
  let changeHandler: ((filePath: string) => void) | null = null
  let unlinkHandler: ((filePath: string) => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    mockOn.mockClear()
    mockClose.mockClear()
    mockInvalidate.mockClear()

    // Capture the event handlers registered with chokidar
    mockOn.mockImplementation((event: string, handler: (filePath: string) => void) => {
      if (event === 'add') addHandler = handler
      if (event === 'change') changeHandler = handler
      if (event === 'unlink') unlinkHandler = handler
      return mockWatcher
    })

    mockIndexer = {
      reindexFile: vi.fn().mockResolvedValue({ symbolsFound: 3 }),
      clearFileIndex: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProjectIndexer

    watcher = new CodeFileWatcher({
      projectPath: '/project',
      indexer: mockIndexer,
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await watcher.stop().catch(() => {
      // ignore
    })
  })

  it('normal case: single change event fires handler after debounce', async () => {
    await watcher.start()
    expect(changeHandler).not.toBeNull()

    changeHandler!('test.ts')

    // Handler should not be called immediately
    expect(mockIndexer.reindexFile).not.toHaveBeenCalled()

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(400)

    expect(mockIndexer.reindexFile).toHaveBeenCalledTimes(1)
    expect(mockIndexer.reindexFile).toHaveBeenCalledWith('/project/test.ts')
  })

  it('unlink then re-add before debounce: old unlink timer is skipped, re-add handler runs', async () => {
    const onIndexUpdate = vi.fn()
    const onNodeFileChange = vi.fn()

    watcher = new CodeFileWatcher({
      projectPath: '/project',
      indexer: mockIndexer,
      onIndexUpdate,
      onNodeFileChange,
    })

    await watcher.start()
    expect(unlinkHandler).not.toBeNull()
    expect(addHandler).not.toBeNull()

    // 1. File is unlinked
    unlinkHandler!('test.ts')

    // 2. Before debounce fires, file is re-added
    await vi.advanceTimersByTimeAsync(100)
    addHandler!('test.ts')

    // 3. Advance past the original unlink debounce (300ms from start = 200ms from now)
    await vi.advanceTimersByTimeAsync(250)

    // The old unlink timer should have fired but been skipped due to generation mismatch
    // clearFileIndex should NOT have been called
    expect(mockIndexer.clearFileIndex).not.toHaveBeenCalled()
    expect(onIndexUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'unlink' }),
    )

    // 4. Advance past the re-add debounce (300ms from when add was called)
    await vi.advanceTimersByTimeAsync(100)

    // The re-add handler should run
    expect(mockIndexer.reindexFile).toHaveBeenCalledTimes(1)
    expect(mockIndexer.reindexFile).toHaveBeenCalledWith('/project/test.ts')
    expect(onIndexUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'add', filePath: '/project/test.ts', symbolsFound: 3 }),
    )
    expect(onNodeFileChange).toHaveBeenCalledWith('/project/test.ts', 'add')
  })

  it('stop() clears pending timers and generations', async () => {
    await watcher.start()

    // Queue up multiple events
    changeHandler!('a.ts')
    changeHandler!('b.ts')
    unlinkHandler!('c.ts')

    // Stop should clear everything
    await watcher.stop()

    // Advance timers — nothing should fire
    await vi.advanceTimersByTimeAsync(1000)

    expect(mockIndexer.reindexFile).not.toHaveBeenCalled()
    expect(mockIndexer.clearFileIndex).not.toHaveBeenCalled()
  })

  it('multiple rapid changes only execute the last one', async () => {
    await watcher.start()

    changeHandler!('test.ts')
    await vi.advanceTimersByTimeAsync(100)
    changeHandler!('test.ts')
    await vi.advanceTimersByTimeAsync(100)
    changeHandler!('test.ts')

    // Only the last timer should fire after full debounce from last call
    await vi.advanceTimersByTimeAsync(400)

    expect(mockIndexer.reindexFile).toHaveBeenCalledTimes(1)
  })

  it('interleaved events on different files each execute exactly once', async () => {
    await watcher.start()

    // Interleave changes on a.ts and b.ts
    changeHandler!('a.ts')
    await vi.advanceTimersByTimeAsync(50)
    changeHandler!('b.ts')
    await vi.advanceTimersByTimeAsync(50)
    changeHandler!('a.ts')
    await vi.advanceTimersByTimeAsync(50)
    changeHandler!('b.ts')

    // Advance past the last debounce for both files
    await vi.advanceTimersByTimeAsync(400)

    // Each file should have been reindexed exactly once
    expect(mockIndexer.reindexFile).toHaveBeenCalledTimes(2)
    expect(mockIndexer.reindexFile).toHaveBeenCalledWith('/project/a.ts')
    expect(mockIndexer.reindexFile).toHaveBeenCalledWith('/project/b.ts')
  })

  it('Map cleanup: both Maps are empty after all timers fire and stop() is called', async () => {
    await watcher.start()

    changeHandler!('a.ts')
    changeHandler!('b.ts')

    // Access private Maps via type assertion for verification
    const w = watcher as unknown as {
      debounceTimers: Map<string, unknown>
      debounceGenerations: Map<string, number>
    }

    // Maps should be populated while timers are pending
    expect(w.debounceTimers.size).toBe(2)
    expect(w.debounceGenerations.size).toBe(2)

    // Let all timers fire
    await vi.advanceTimersByTimeAsync(400)

    // debounceTimers should be empty after handlers run
    expect(w.debounceTimers.size).toBe(0)
    // debounceGenerations should also be cleaned up after successful execution
    expect(w.debounceGenerations.size).toBe(0)

    // Queue another event then stop
    changeHandler!('c.ts')
    await watcher.stop()

    // Both Maps must be empty after stop()
    expect(w.debounceTimers.size).toBe(0)
    expect(w.debounceGenerations.size).toBe(0)
  })
})
