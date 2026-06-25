import { describe, test, expect, vi } from 'vitest'
import { RequestQueue, RequestPriority } from '../request-queue'

describe('RequestQueue', () => {
  test('enqueues and processes requests in order', async () => {
    const processed: string[] = []
    const queue = new RequestQueue({
      maxConcurrent: 1,
      executor: async (_req) => { processed.push(_req.id); return { success: true } }
    })
    queue.enqueue({ id: 'r1', adapterName: 'claude-code', command: 'cmd1', priority: RequestPriority.User })
    queue.enqueue({ id: 'r2', adapterName: 'claude-code', command: 'cmd2', priority: RequestPriority.User })
    await queue.drain()
    expect(processed).toEqual(['r1', 'r2'])
  })

  test('respects maxConcurrent per adapter', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const queue = new RequestQueue({
      maxConcurrent: 1,
      executor: async (_req) => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise(r => setTimeout(r, 50))
        concurrent--
        return { success: true }
      }
    })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'c', priority: RequestPriority.User })
    queue.enqueue({ id: 'r2', adapterName: 'a', command: 'c', priority: RequestPriority.User })
    await queue.drain()
    expect(maxConcurrent).toBe(1)
  })

  test('deduplicates same nodeId+command within 30s', () => {
    const queue = new RequestQueue({ maxConcurrent: 1, executor: async () => ({ success: true }) })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'fix auth', nodeId: 'n1', priority: RequestPriority.User })
    const added = queue.enqueue({ id: 'r2', adapterName: 'a', command: 'fix auth', nodeId: 'n1', priority: RequestPriority.User })
    expect(added).toBe(false)
  })

  test('higher priority jumps ahead', () => {
    const queue = new RequestQueue({ maxConcurrent: 1, executor: async () => ({ success: true }) })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'c1', priority: RequestPriority.System })
    queue.enqueue({ id: 'r2', adapterName: 'a', command: 'c2', priority: RequestPriority.User })
    const next = queue.peekNext('a')
    expect(next?.id).toBe('r2')
  })

  test('cancel removes queued request', () => {
    const queue = new RequestQueue({ maxConcurrent: 1, executor: async () => ({ success: true }) })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'c', priority: RequestPriority.User })
    const cancelled = queue.cancel('r1')
    expect(cancelled).toBe(true)
    expect(queue.size()).toBe(0)
  })

  test('cancel aborts and cleans up executing request', async () => {
    let started = false
    let aborted = false
    const queue = new RequestQueue({
      maxConcurrent: 1,
      executor: async (req) => {
        started = true
        return new Promise((resolve) => {
          const check = () => {
            if (req.abortController?.signal.aborted) {
              aborted = true
              resolve({ success: false })
            } else {
              setTimeout(check, 10)
            }
          }
          check()
        })
      },
    })
    queue.enqueue({ id: 'r1', adapterName: 'a', command: 'c', priority: RequestPriority.User })
    const drainPromise = queue.drain()

    await vi.waitFor(() => started)
    const cancelled = queue.cancel('r1')
    expect(cancelled).toBe(true)

    await drainPromise
    expect(aborted).toBe(true)
    expect(queue.size()).toBe(0)
  })
})
