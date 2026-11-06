/**
 * D1 仓储层验收：CRUD、事件 seq 连续、节点活跃 turn 唯一、usage 双层统计。
 */

import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AgentRepository } from '../db/repository'
import { AGENT_INDEX_SQLS, AGENT_TABLE_SCHEMAS } from '../db/schema'
import { rebuildTableIfNeeded } from '../../../database'
import type { NormalizedEventEnvelope } from '@shared/types/agent-runtime'
import { openTestDb } from './helpers/test-db'

// database.ts 依赖 electron app.getPath；与 database-migration.test.ts 相同的最小 mock
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

function envelope(
  turnId: string,
  runId: string,
  seq: number,
  type: NormalizedEventEnvelope['type'],
  stepId?: string,
  payload: Record<string, unknown> = {},
): NormalizedEventEnvelope {
  return {
    eventId: `evt_${turnId}_${seq}`,
    runId,
    turnId,
    seq,
    type,
    source: 'kernel',
    fidelity: 'turn',
    payloadVersion: 1,
    payload,
    timestamp: 1_760_000_000_000 + seq,
    ...(stepId ? { stepId } : {}),
  }
}

function seedRun(repo: AgentRepository, nodeId = 'node-1') {
  const run = repo.insertRun({ threadId: 'thread-1', nodeId, graphId: 'graph-1', executor: 'claude-code' })
  const session = repo.insertSession({
    graphId: 'graph-1',
    nodeId,
    threadId: 'thread-1',
    executor: 'claude-code',
    runtimeSessionId: 'adapter-session-1',
    status: 'active',
  })
  const turn = repo.insertTurn({
    runId: run.id,
    sessionId: session.id,
    graphId: 'graph-1',
    nodeId,
    resumeMode: 'native',
    idempotencyKey: `key-${run.id}`,
    input: { prompt: 'hello' },
  })
  return { run, session, turn }
}

describe('AgentRepository (D1)', () => {
  it('round-trips run/session/turn/step/artifact/snapshot', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const { run, session, turn } = seedRun(repo)

    expect(repo.getRun(run.id)?.status).toBe('created')
    expect(repo.getSession(session.id)?.runtime_session_id).toBe('adapter-session-1')

    const step = repo.upsertStep({ id: 'step-1', turnId: turn.id, kind: 'tool', toolName: 'Read', status: 'running', fidelity: 'token' })
    expect(step.seq).toBe(1)
    repo.updateStepStatus('step-1', 'done')
    expect(repo.listSteps(turn.id)[0].status).toBe('done')

    const artifactId = repo.insertArtifact({
      turnId: turn.id,
      nodeId: 'node-1',
      kind: 'diff',
      storage: 'inline',
      storageRef: 'diff --git a/x b/x',
    })
    expect(repo.listArtifacts(turn.id)).toHaveLength(1)
    expect(repo.listArtifacts(turn.id)[0].id).toBe(artifactId)

    repo.saveSnapshot(run.id, { status: 'running' })
    repo.saveSnapshot(run.id, { status: 'completed' })
    expect(repo.latestSnapshot(run.id)?.seq).toBe(2)
  })

  it('allocates run-level seq and keeps turn-local seq continuous across batches', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const { run, turn } = seedRun(repo)

    const first = Array.from({ length: 3 }, (_, index) => envelope(turn.id, run.id, index + 1, 'message.delta'))
    repo.appendEvents(first)
    const second = [envelope(turn.id, run.id, 4, 'run.completed')]
    repo.appendEvents(second)

    const events = repo.listEvents(run.id)
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(events.map((event) => event.turn_seq)).toEqual([1, 2, 3, 4])
  })

  it('按 step_id 落库，一次查询即可返回该步骤的完整事件序列', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const { run, turn } = seedRun(repo)
    const stepId = `${turn.id}:step-tool-9`

    repo.appendEvents([
      envelope(turn.id, run.id, 1, 'tool.requested', stepId, { toolName: 'Bash', input: { command: 'cat a | tee b' } }),
      envelope(turn.id, run.id, 2, 'bash.policy', stepId, { decision: 'ask', rule: 'pipe', risk: 'high' }),
      envelope(turn.id, run.id, 3, 'approval.required', stepId, { approvalId: 'appr-1', policyRule: 'pipe' }),
      envelope(turn.id, run.id, 4, 'approval.resolved', stepId, { approvalId: 'appr-1', decision: 'allow' }),
      envelope(turn.id, run.id, 5, 'tool.result', stepId, { toolCallId: 'tool-9', ok: true }),
      // 不属于任何步骤的事件（step_id 为 NULL）
      envelope(turn.id, run.id, 6, 'message.delta', undefined, { text: 'done' }),
    ])

    // 同一命令的 bash.policy 与 approval.resolved 用同一个 step_id，一次查询全部返回
    const stepEvents = repo.listStepEvents(stepId)
    expect(stepEvents.map((event) => event.type)).toEqual([
      'tool.requested',
      'bash.policy',
      'approval.required',
      'approval.resolved',
      'tool.result',
    ])
    expect(stepEvents.every((event) => event.step_id === stepId)).toBe(true)
    const policy = stepEvents.find((event) => event.type === 'bash.policy')!
    const resolved = stepEvents.find((event) => event.type === 'approval.resolved')!
    expect(policy.turn_id).toBe(turn.id)
    expect(policy.payload).toMatchObject({ decision: 'ask', rule: 'pipe' })
    expect(resolved.payload).toMatchObject({ approvalId: 'appr-1', decision: 'allow' })

    // 既有 run 级查询行为不变：无 step 的事件仍在序列中，step_id 为 NULL
    const runEvents = repo.listEvents(run.id)
    expect(runEvents).toHaveLength(6)
    expect(runEvents[5].step_id).toBeNull()
    expect(repo.listStepEvents('missing-step')).toEqual([])
  })

  it('迁移旧 agent_events：补 step_id 列，历史行 NULL 且既有查询/索引不变', () => {
    const db = openTestDb(false)
    // v21 及以前的旧表：没有 step_id
    db.exec(`
      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        turn_seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('backend','kernel','synthetic')),
        fidelity TEXT NOT NULL CHECK(fidelity IN ('token','turn','session')),
        payload_version INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(run_id, seq),
        UNIQUE(turn_id, turn_seq)
      )
    `)
    db.prepare(
      `INSERT INTO agent_events
         (id, run_id, turn_id, seq, turn_seq, type, source, fidelity, payload_version, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('legacy-1', 'run-legacy', 'turn-legacy', 1, 1, 'tool.requested', 'backend', 'token', 1, '{"toolName":"Bash"}', 100)
    db.prepare(
      `INSERT INTO agent_events
         (id, run_id, turn_id, seq, turn_seq, type, source, fidelity, payload_version, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('legacy-2', 'run-legacy', 'turn-legacy', 2, 2, 'tool.result', 'backend', 'token', 1, '{"ok":true}', 101)

    const schema = AGENT_TABLE_SCHEMAS.find((item) => item.name === 'agent_events')!
    rebuildTableIfNeeded(db, 'agent_events', schema.createSql, schema.requiredColumns)
    // 只应用与本表相关的索引（其余索引依赖其他 agent 表，本用例库未建）
    for (const sql of AGENT_INDEX_SQLS.filter((item) => item.includes('agent_events'))) db.exec(sql)

    const cols = (db.prepare('PRAGMA table_info(agent_events)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('step_id')

    const repo = new AgentRepository(db)
    const legacy = repo.listEvents('run-legacy')
    expect(legacy.map((event) => event.id)).toEqual(['legacy-1', 'legacy-2'])
    expect(legacy.every((event) => event.step_id === null)).toBe(true)
    // 历史行不属于任何步骤，不影响按 step 查询
    expect(repo.listStepEvents('turn-legacy:step-1')).toEqual([])
    // 既有索引仍在，新的 step 索引可用
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_events'").all() as Array<{ name: string }>)
      .map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining(['idx_agent_events_kind', 'idx_agent_events_step', 'idx_agent_events_turn_step']))
    db.close()
  })

  it('enforces one active turn per node/branch (ux_turns_active)', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const { run, session } = seedRun(repo)

    expect(() =>
      repo.insertTurn({
        runId: run.id,
        sessionId: session.id,
        nodeId: 'node-1',
        branchKey: '',
        resumeMode: 'native',
        idempotencyKey: 'second-active',
        input: {},
      }),
    ).toThrow(/NODE_BUSY/)
  })

  it('allows a new turn after the previous turn is terminal', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const { run, session, turn } = seedRun(repo)
    repo.updateTurnStatus(turn.id, 'completed')

    const next = repo.insertTurn({
      runId: run.id,
      sessionId: session.id,
      nodeId: 'node-1',
      branchKey: '',
      resumeMode: 'native',
      idempotencyKey: 'next-turn',
      input: {},
    })
    expect(next.status).toBe('running')
  })

  it('projects run status from turns', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const { run, turn } = seedRun(repo)
    repo.updateTurnStatus(turn.id, 'completed')
    expect(repo.projectRunStatus(run.id)).toBe('completed')
  })

  it('aggregates usage by graph and by graph × local day', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const { turn, session } = seedRun(repo)

    repo.recordUsage({ turnId: turn.id, sessionId: session.id, executor: 'claude-code', graphId: 'graph-1', costMicros: 120, inputTokens: 100, outputTokens: 20 })
    repo.recordUsage({ turnId: turn.id, sessionId: session.id, executor: 'claude-code', graphId: 'graph-1', costMicros: 80, inputTokens: 50 })
    repo.recordUsage({ turnId: turn.id, sessionId: session.id, executor: 'claude-code', graphId: 'graph-2', costMicros: 40 })

    expect(repo.sumCostMicrosForGraph('graph-1')).toBe(200)
    expect(repo.summarizeUsageByGraphDay('graph-1').knownCostMicros).toBe(200)
  })

  it('keeps approval decisions idempotent and persists timeout metadata', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const { run, turn } = seedRun(repo)

    const approval = repo.insertApproval({
      runId: run.id,
      turnId: turn.id,
      toolName: 'Write',
      argsJson: '{"path":"a.txt"}',
      argsHash: 'hash-1',
      risk: 'high',
      policyDecision: 'ask',
      expiresAt: 10,
      mode: 'interactive',
      timeoutMs: 120_000,
    })
    expect(approval.status).toBe('pending')

    const first = repo.decideApproval(approval.id, 'deny', 'timeout', 11)
    expect(first?.status).toBe('denied')
    expect(first?.decided_by).toBe('timeout')

    const second = repo.decideApproval(approval.id, 'allow', 'user', 12)
    expect(second?.status).toBe('denied')
    expect(second?.decided_by).toBe('timeout')
  })
})
