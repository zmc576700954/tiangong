import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerGraphHandlers } from '../graph'
import type { GraphService } from '../../services/graph-service'
import type { SnapshotRepository } from '../../repositories/snapshot-repository'
import { nodeTypeRegistry } from '../../shared/node-type-registry'
import type { Client } from '@libsql/client'
import type { TypedHandle } from '../utils'

import { IpcError } from '../../errors'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('registerGraphHandlers', () => {
  let handlers: Record<string, (...args: any[]) => Promise<unknown>>
  let graphService: GraphService
  let snapshotRepo: SnapshotRepository
  let db: Client

  beforeEach(() => {
    handlers = {}
    graphService = {
      createGraph: vi.fn().mockResolvedValue({ id: 'graph-1' }),
      listGraphs: vi.fn().mockResolvedValue([]),
      getGraph: vi.fn().mockResolvedValue(null),
      deleteGraph: vi.fn().mockResolvedValue(undefined),
      deriveGraph: vi.fn().mockResolvedValue({ id: 'graph-2' }),
    } as unknown as GraphService
    snapshotRepo = {
      create: vi.fn().mockResolvedValue({ id: 'snapshot-1' }),
      listByGraph: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as SnapshotRepository
    db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      batch: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
    } as unknown as Client

    const typedHandle: TypedHandle = (channel, handler) => {
      handlers[channel] = handler as (...args: any[]) => Promise<unknown>
    }

    registerGraphHandlers(db, typedHandle, graphService, snapshotRepo)
  })

  describe('node:create', () => {
    it('rejects node without required fields', async () => {
      await expect(handlers['node:create']({}, { type: 'module' }))
        .rejects.toThrow(IpcError)
    })

    it('rejects node with invalid status', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'unknown',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      })).rejects.toThrow(IpcError)
    })

    it('rejects node with invalid graphType', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'invalid',
        position: { x: 0, y: 0 },
      })).rejects.toThrow(IpcError)
    })

    it('rejects node with missing position coordinates', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: '0' },
      })).rejects.toThrow(IpcError)
    })

    it('rejects node with overly long title', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'a'.repeat(201),
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      })).rejects.toThrow(IpcError)
    })

    it('creates a valid node', async () => {
      const data = {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      }
      await expect(handlers['node:create']({}, data)).resolves.not.toThrow()
    })

    it('accepts registered extension node types', async () => {
      nodeTypeRegistry.register({ type: 'custom-type', label: 'Custom' })
      const data = {
        type: 'custom-type',
        status: 'confirmed',
        title: 'Custom Node',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      }
      await expect(handlers['node:create']({}, data)).resolves.not.toThrow()
    })
  })

  describe('node:createBatch', () => {
    it('rejects non-array input', async () => {
      await expect(handlers['node:createBatch']({}, { type: 'module' }))
        .rejects.toThrow(IpcError)
    })

    it('rejects batch with invalid node', async () => {
      const nodes = [
        { type: 'module', status: 'confirmed', title: 'OK', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } },
        { type: 'invalid', status: 'confirmed', title: 'Bad', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } },
      ]
      await expect(handlers['node:createBatch']({}, nodes))
        .rejects.toThrow(IpcError)
    })
  })

  describe('node:update', () => {
    it('rejects empty title', async () => {
      await expect(handlers['node:update']({}, 'node-1', { title: '' }))
        .rejects.toThrow(IpcError)
    })

    it('rejects overly long description', async () => {
      await expect(handlers['node:update']({}, 'node-1', { description: 'a'.repeat(2001) }))
        .rejects.toThrow(IpcError)
    })

    it('rejects invalid status update', async () => {
      await expect(handlers['node:update']({}, 'node-1', { status: 'bad-status' }))
        .rejects.toThrow(IpcError)
    })
  })
})
