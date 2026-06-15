/**
 * 数据库迁移测试
 * 覆盖 migrate() 创建表、rebuildTableIfNeeded() 非破坏性迁移
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return path.join(os.tmpdir(), 'bizgraph-test-' + process.pid)
      return os.tmpdir()
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../database'

describe('Database Migration', () => {
  beforeAll(async () => {
    await initDatabase()
  })

  afterAll(async () => {
    await closeDatabase()
  })

  it('should create all 8 tables on fresh init', async () => {
    const client = getClient()
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    const tables = result.rows.map((r) => (r as { name: string }).name)

    expect(tables).toContain('graphs')
    expect(tables).toContain('nodes')
    expect(tables).toContain('edges')
    expect(tables).toContain('bug_nodes')
    expect(tables).toContain('snapshots')
    expect(tables).toContain('agent_logs')
    expect(tables).toContain('chat_threads')
    expect(tables).toContain('chat_messages')
    expect(tables.length).toBeGreaterThanOrEqual(8)
  })

  it('should have schema_version metadata', async () => {
    const client = getClient()
    const result = await client.execute("SELECT version FROM schema_version LIMIT 1")
    expect(result.rows.length).toBe(1)
    const version = Number((result.rows[0] as { version: number }).version)
    expect(version).toBeGreaterThan(0)
  })

  it('should have correct columns in graphs table', async () => {
    const client = getClient()
    const result = await client.execute("PRAGMA table_info(graphs)")
    const columns = result.rows.map((r) => (r as { name: string }).name)

    expect(columns).toContain('id')
    expect(columns).toContain('project_path')
    expect(columns).toContain('name')
    expect(columns).toContain('type')
    expect(columns).toContain('created_at')
    expect(columns).toContain('updated_at')
  })

  it('should have correct columns in nodes table', async () => {
    const client = getClient()
    const result = await client.execute("PRAGMA table_info(nodes)")
    const columns = result.rows.map((r) => (r as { name: string }).name)

    expect(columns).toContain('id')
    expect(columns).toContain('graph_id')
    expect(columns).toContain('parent_id')
    expect(columns).toContain('type')
    expect(columns).toContain('title')
    expect(columns).toContain('status')
  })

  it('should have correct columns in chat_threads table', async () => {
    const client = getClient()
    const result = await client.execute("PRAGMA table_info(chat_threads)")
    const columns = result.rows.map((r) => (r as { name: string }).name)

    expect(columns).toContain('id')
    expect(columns).toContain('adapter_name')
    expect(columns).toContain('node_id')
    expect(columns).toContain('title')
  })

  it('should have correct columns in chat_messages table', async () => {
    const client = getClient()
    const result = await client.execute("PRAGMA table_info(chat_messages)")
    const columns = result.rows.map((r) => (r as { name: string }).name)

    expect(columns).toContain('id')
    expect(columns).toContain('thread_id')
    expect(columns).toContain('role')
    expect(columns).toContain('content')
  })

  it('should be idempotent — calling initDatabase again does not throw', async () => {
    await expect(initDatabase()).resolves.not.toThrow()
  })
})
