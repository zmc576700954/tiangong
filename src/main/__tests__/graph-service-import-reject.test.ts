/**
 * S1-d / I5 回归：TOCTOU 并发导入被拒时不得留下孤儿 chat_thread。
 *
 * 场景：check() 通过后、图事务提交前，另一个导入抢先写入 project_fingerprints
 * 同一 root_path；本事务在指纹 UNIQUE 上落败 → 整事务回滚 → 拒绝。
 * thread 是在长耗时生成阶段之前创建的（不在事务内），必须显式删除。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'

const conflictMessage = 'UNIQUE constraint failed: project_fingerprints.root_path'

vi.mock('../map-migration/import-dedup', () => ({
  ImportDedupService: class {
    async check() {
      return {
        decision: { action: 'allow', step: '3c', matchedFingerprintId: null, signals: {}, reason: 'ok' },
        plan: {
          action: 'allow',
          matchedFingerprintId: null,
          commitFingerprint: () => {
            throw new Error(conflictMessage)
          },
        },
      }
    }
  },
  ImportRejectedError: class extends Error {
    decision: unknown
    constructor(decision: unknown) {
      super('import rejected')
      this.name = 'ImportRejectedError'
      this.decision = decision
    }
  },
  isRootPathConflict: (err: unknown) =>
    /UNIQUE constraint failed: project_fingerprints\.root_path/.test(
      err instanceof Error ? err.message : String(err),
    ),
}))

vi.mock('../project-scanner', () => ({
  ProjectScanner: class {
    async scan() {
      return { framework: 'unknown', modules: [] }
    }
  },
}))

vi.mock('../project-analyzer', () => ({
  ProjectAnalyzer: class {
    analyze() {
      return { nodes: [], edges: [] }
    }
  },
}))

import { GraphService } from '../services/graph-service'

describe('initFromProject 拒绝路径零新增（I5）', () => {
  let db: BetterSqlite3.Database
  let deletedThreads: string[]
  let chatService: Record<string, unknown>

  beforeEach(() => {
    db = new Database(':memory:') as unknown as BetterSqlite3.Database
    deletedThreads = []
    chatService = {
      createThread: vi.fn(async () => ({ id: 't-reject' })),
      updateThread: vi.fn(async () => undefined),
      saveMessage: vi.fn(async () => undefined),
      deleteThread: vi.fn(async (id: string) => {
        deletedThreads.push(id)
      }),
    }
  })

  it('TOCTOU 冲突被拒后删除生成阶段创建的 thread', async () => {
    const service = new GraphService(db, undefined, chatService as never)
    await expect(
      service.initFromProject({ projectPath: '/tmp/project-x', projectName: 'x' }),
    ).rejects.toMatchObject({ name: 'ImportRejectedError' })

    expect(deletedThreads).toEqual(['t-reject'])
    // 外层 catch 不再向已删除的 thread 写错误消息
    const saveMessage = chatService.saveMessage as ReturnType<typeof vi.fn>
    const lastCall = saveMessage.mock.calls.at(-1)
    expect(String(lastCall?.[1]?.content ?? '')).not.toContain('生成思维导图失败')
  })
})
