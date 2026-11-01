/**
 * GraphService.createGraph 的**真实库**测试：project_path 必须真的落库，
 * 并且真的进 getProjectPaths()（= IPC 路径白名单）。
 *
 * 为什么不能只靠 `src/main/__tests__/graph-service.test.ts` 那条 mock 版：
 * 那里 GraphRepository 是整体 mock 的、mock 自己把 projectPath 回显出来，
 * 于是「落库保留该路径」断言的其实是 mock 的回显行 —— 同义反复。
 * 仓库层的回归（INSERT 少写一列 / getProjectPaths 漏查非空列）在那条测试里**完全测不出来**，
 * 而这两件事恰恰是本任务要修的。
 *
 * 先例：`src/main/repositories/__tests__/graph-repository-clone.test.ts`（同样建真库）。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-graph-project-path-test-' + process.pid)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? TEST_USER_DATA : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { initDatabase, closeDatabase, getClient } from '../database'
import { GraphService } from '../services/graph-service'
import { GraphRepository } from '../repositories/graph-repository'

describe('GraphService.createGraph — project_path 真落库', () => {
  let db: ReturnType<typeof getClient>
  let service: GraphService
  let repo: GraphRepository

  beforeAll(() => {
    // 目录名带 pid：pid 复用时可能命中上一次的库 → 残留数据让断言不可靠。
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
    initDatabase()
    db = getClient()
    repo = new GraphRepository(db)
    service = new GraphService(db)
  })

  afterAll(() => { closeDatabase() })

  it('project_path 真的写进 graphs 表的 project_path 列', async () => {
    const graph = await service.createGraph({ name: 'G', type: 'dev', projectPath: '/tmp/proj' })

    // 直接查列 —— 这是「落库」的唯一权威证据
    const row = db
      .prepare('SELECT project_path FROM graphs WHERE id = ?')
      .get(graph.id) as { project_path: string | null }
    expect(row.project_path).toBe('/tmp/proj')

    // 读回路径也要带得上（AgentChatPanel 的 workingDirectory 走的就是它）
    expect(repo.get(graph.id)?.graph.projectPath).toBe('/tmp/proj')
    expect(repo.getProjectPath(graph.id)).toBe('/tmp/proj')
  })

  it('没给 projectPath 时落库为 NULL（不编造路径）', async () => {
    const graph = await service.createGraph({ name: 'G-no-project', type: 'dev' })
    const row = db
      .prepare('SELECT project_path FROM graphs WHERE id = ?')
      .get(graph.id) as { project_path: string | null }
    expect(row.project_path).toBeNull()
  })

  it('新建的图立刻进 getProjectPaths()（= IPC 路径白名单，不用等重启）', async () => {
    // 先取一次 → 把缓存打热，确保后面断言的是「缓存被正确失效」而不是「第一次查询」
    expect(service.getProjectPaths()).not.toContain('/tmp/white-list-proj')

    const graph = await service.createGraph({
      name: 'G-whitelist',
      type: 'dev',
      projectPath: '/tmp/white-list-proj',
    })

    expect(service.getProjectPaths()).toContain('/tmp/white-list-proj')
    expect(repo.getProjectPaths()).toContain('/tmp/white-list-proj')
    expect(graph.projectPath).toBe('/tmp/white-list-proj')
  })
})
