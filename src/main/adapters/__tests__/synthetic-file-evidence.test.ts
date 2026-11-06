/**
 * M1 ②：长尾 CLI 的合成文件变更证据。
 *
 * 覆盖：
 * - 真实目录增/删/改 → AgentOutput.file_change_evidence（source=synthetic / fidelity=turn）；
 * - 长尾能力声明 toolEvents 仍为 none，且没有伪造的工具名事件；
 * - Claude（有真实工具事件）不产生合成证据；
 * - Driver 把合成证据映射为独立事件 evidence.file_change。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentOutput, AgentSession, AgentSessionConfig } from '@shared/types'
import type { DriverExecuteContext } from '@shared/types/agent-runtime'
import { BaseAdapter } from '../base'
import { AdapterBackendDriver } from '../../agent/runtime/executors/adapter-driver'
import { getExecutorCapabilities } from '../../agent/runtime/capabilities'

let root = ''

async function write(relative: string, content: string): Promise<void> {
  await fs.mkdir(path.join(root, path.dirname(relative)), { recursive: true })
  await fs.writeFile(path.join(root, relative), content)
}

function config(): AgentSessionConfig {
  return {
    workingDirectory: root,
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: 'test',
    acceptanceCriteria: [],
  }
}

async function mutateWorkspace(target: string): Promise<void> {
  await fs.writeFile(path.join(target, 'added.txt'), 'new file')
  await fs.writeFile(path.join(target, 'existing.txt'), 'modified and longer')
  await fs.unlink(path.join(target, 'to-delete.txt'))
}

class FakeCliAdapter extends BaseAdapter {
  readonly version = '0.0.1'
  readonly name: string
  constructor(name: string) {
    super()
    this.name = name
  }

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(sessionConfig: AgentSessionConfig): Promise<AgentSession> {
    const session: AgentSession = {
      id: 'sess-evidence',
      adapterName: this.name,
      config: sessionConfig,
      startTime: Date.now(),
    }
    this.registerSession(session)
    return session
  }

  protected async doSendCommand(session: AgentSession): Promise<void> {
    await mutateWorkspace(session.config.workingDirectory)
    this.emitOutput({ type: 'stdout', data: 'done', timestamp: Date.now() })
  }
}

function makeContext() {
  const events: Array<{ type: string; source: string; fidelity: string; payload: Record<string, unknown> }> = []
  const context = {
    record: (batch: Array<{ type: string; source: string; fidelity: string; payload: Record<string, unknown> }>) => {
      events.push(...batch)
    },
    approvals: {
      request: async () => ({ approvalId: 'a', decision: 'allow', decidedBy: 'policy', argsHash: '', decidedAt: Date.now() }),
    },
    step: { ensure: () => undefined, update: () => undefined },
    signal: new AbortController().signal,
    envMarker: 'marker',
    registerProcess: () => undefined,
  } as unknown as DriverExecuteContext
  return { events, context }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bizgraph-synthetic-evidence-'))
  await write('existing.txt', 'before')
  await write('to-delete.txt', 'delete me')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('synthetic file change evidence (M1②)', () => {
  it('emits add/modify/delete evidence with source=synthetic and fidelity=turn', async () => {
    const adapter = new FakeCliAdapter('qoder')
    const outputs: AgentOutput[] = []
    adapter.onOutput((output) => outputs.push(output))
    const session = await adapter.startSession(config())

    await adapter.sendCommand(session.id, { type: 'implement', description: 'edit', targetNodeId: 'node' })

    const evidenceOutputs = outputs.filter((o) => o.type === 'file_change_evidence')
    expect(evidenceOutputs).toHaveLength(1)
    const evidence = evidenceOutputs[0].fileChangeEvidence
    expect(evidenceOutputs[0].evidenceSource).toBe('synthetic')
    expect(evidenceOutputs[0].evidenceFidelity).toBe('turn')
    expect(evidence?.toolAttribution).toBe('unknown')
    expect(evidence?.outOfWorkspaceChanges).toBe('not-included')
    expect(evidence?.changes).toEqual(
      expect.arrayContaining([
        { path: 'added.txt', changeType: 'add' },
        { path: 'existing.txt', changeType: 'modify' },
        { path: 'to-delete.txt', changeType: 'delete' },
      ]),
    )
  })

  it('keeps long-tail toolEvents = none and never fakes a tool name', async () => {
    expect(getExecutorCapabilities('qoder').toolEvents).toBe('none')
    expect(getExecutorCapabilities('qoder').fileChanges).toBe('synthetic-snapshot')
    expect(getExecutorCapabilities('cline').toolEvents).toBe('none')

    const adapter = new FakeCliAdapter('qwen-code')
    const outputs: AgentOutput[] = []
    adapter.onOutput((output) => outputs.push(output))
    const session = await adapter.startSession(config())
    await adapter.sendCommand(session.id, { type: 'implement', description: 'edit', targetNodeId: 'node' })

    // 证据是独立输出类型，不带 toolCall / 工具名
    const evidenceOutput = outputs.find((o) => o.type === 'file_change_evidence')
    expect(evidenceOutput).toBeDefined()
    expect(evidenceOutput?.toolCall).toBeUndefined()
    expect(evidenceOutput?.data).not.toMatch(/Edit|Write|Bash|Read/)
    expect(outputs.some((o) => o.type === 'tool_call')).toBe(false)
  })

  it('does not emit synthetic evidence for Claude (which has real tool events)', async () => {
    expect(getExecutorCapabilities('claude-code').toolEvents).toBe('exact')

    const adapter = new FakeCliAdapter('claude-code')
    const outputs: AgentOutput[] = []
    adapter.onOutput((output) => outputs.push(output))
    const session = await adapter.startSession(config())
    await adapter.sendCommand(session.id, { type: 'implement', description: 'edit', targetNodeId: 'node' })

    expect(outputs.some((o) => o.type === 'file_change_evidence')).toBe(false)
  })

  it('maps synthetic evidence to a standalone evidence.file_change event in the driver', async () => {
    const adapter = new FakeCliAdapter('qoder')
    const session = await adapter.startSession(config())
    const driver = new AdapterBackendDriver({ adapter, executor: 'qoder', skipHealthCheck: true })
    const { events, context } = makeContext()

    await driver.execute(
      {
        runId: 'run-1',
        turnId: 'turn-1',
        nodeId: 'node-1',
        agentSessionId: session.id,
        prompt: 'edit',
        commandType: 'implement',
        workingDirectory: root,
      },
      context,
    )

    const evidenceEvent = events.find((e) => e.type === 'evidence.file_change')
    expect(evidenceEvent).toBeDefined()
    expect(evidenceEvent?.source).toBe('synthetic')
    expect(evidenceEvent?.fidelity).toBe('turn')
    expect(evidenceEvent?.payload.origin).toBe('workspace-diff')
    expect(evidenceEvent?.payload.proves).toBe('files_changed_not_tool')

    // 不得因为有了文件证据就凭空产生 tool.* 事件
    expect(events.some((e) => e.type.startsWith('tool.'))).toBe(false)
  })
})
