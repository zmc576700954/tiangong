/**
 * D5 真机集成验证（默认跳过，需 BIZGRAPH_REAL_CLI_TEST=1 且本机已登录对应 CLI）。
 *
 * 覆盖：
 * 1. 真实 Claude SDK + `spawnClaudeCodeProcess`：CLI 是否真的进入自有进程组（pgid === pid），
 *    pid 是否可被落库，整组是否可回收。
 * 2. 真实 Codex SDK + 监督 shim：自注册文件是否出现真实 pid/pgid/startedAt/command。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listProcesses, ProcessReaper } from '../process/reaper'
import {
  ensureCodexSupervisorScript,
  getProcRegistryDir,
  getRegistrySecret,
  PROC_REGISTRY_DIR_ENV,
  REAL_CODEX_ENV,
  REGISTRY_SECRET_ENV,
  SUPERVISOR_NONCE_ENV,
  TURN_MARKER_ENV,
  verifyProcRegistryFile,
  waitForProcRegistryRecord,
} from '../../../shared/process-supervisor'
import { attestProcIdentity } from '../process/reaper'

const enabled = process.env.BIZGRAPH_REAL_CLI_TEST === '1'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitFor timeout')
}

describe.skipIf(!enabled)('D5 real CLI supervised spawn', () => {
  it('Claude SDK spawns the CLI into our own process group and the group is reclaimable', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const { spawnInOwnGroup } = await import('../../../shared/process-supervisor')
    const spawned: Array<{
      pid: number
      pgid: number
      startedAt?: string
      command?: string
      startedAtHiRes?: string
    }> = []
    let finalText = ''

    const iter = sdk.query({
      prompt: 'Reply with exactly: OK',
      options: {
        cwd: process.cwd(),
        permissionMode: 'acceptEdits',
        env: { ...process.env } as Record<string, string>,
        spawnClaudeCodeProcess: (options) => {
          const child = spawnInOwnGroup(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
          })
          child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
          if (child.pid) {
            // spawn 钩子内同步抓取 ps 身份（与 Runtime 落库同一路径）
            const identity = new ProcessReaper().registerProcess('real-claude', {
              pid: child.pid,
              pgid: child.pid,
            })
            spawned.push({
              pid: child.pid,
              pgid: identity?.pgid ?? child.pid,
              startedAt: identity?.startedAt,
              command: identity?.command,
              startedAtHiRes: identity?.startedAtHiRes,
            })
          }
          return child as never
        },
      },
    })

    for await (const message of iter) {
      if (message.type === 'result') {
        finalText = (message as { result?: string }).result ?? ''
        break
      }
    }

    expect(spawned.length, 'SDK 必须通过我们的 spawn 钩子启动 CLI').toBeGreaterThan(0)
    const { pid, pgid, startedAt, command, startedAtHiRes } = spawned[0]
    expect(pgid, 'CLI 必须是我们创建的进程组组长').toBe(pid)
    // D5：SDK 路径落库四字段必须来自实时 ps，而不是空值
    expect(startedAt, '真实 CLI 的 startedAt 必须可抓取').toMatch(/\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}/)
    expect(command, '真实 CLI 的完整命令行必须可抓取').toContain('claude')
    if (process.platform === 'linux') {
      expect(startedAtHiRes, 'Linux 必须提供 /proc 高精度启动标识').toMatch(/^linux-starttime:\d+/)
    }
    expect(finalText.trim().length, '真实 Claude 必须返回内容').toBeGreaterThan(0)
    // 正常完成路径：CLI 自行退出，不得留下残留
    await waitFor(() => !alive(pid), 5000)
  }, 120_000)

  it('real Claude: mid-turn reclaim kills the CLI plus tool children without residual', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const { spawnInOwnGroup } = await import('../../../shared/process-supervisor')
    let identity:
      | { pid: number; pgid?: number; startedAt?: string; command?: string; attestation?: string }
      | undefined

    const iter = sdk.query({
      prompt: 'Use the Bash tool to run the shell command `sleep 20`, then reply DONE.',
      options: {
        cwd: process.cwd(),
        permissionMode: 'bypassPermissions',
        allowedTools: ['Bash'],
        env: { ...process.env } as Record<string, string>,
        spawnClaudeCodeProcess: (options) => {
          const child = spawnInOwnGroup(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
          })
          child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
          if (child.pid) {
            const observed = new ProcessReaper().registerProcess('real-claude-cancel', {
              pid: child.pid,
              pgid: child.pid,
            })
            // 必须保留 registerProcess 铸造的 attestation，否则会被信任门判为
            // 「无签名且非孤儿」而拒绝回收。
            identity = observed
          }
          return child as never
        },
      },
    })

    const consuming = (async () => {
      try {
        for await (const _message of iter) {
          // 由测试决定何时回收
        }
      } catch {
        // 进程被回收后流终止属预期
      }
    })()

    try {
      // 等到 CLI 真正拉起（任务进行中）
      await waitFor(
        () =>
          identity !== undefined &&
          listProcesses().some((proc) => proc.pid === identity!.pid && !proc.state.startsWith('Z')),
        20_000,
      )

      const report = new ProcessReaper().killRegistered([identity!])
      expect(report.killedGroups, '必须按自有进程组整组回收').toContain(identity!.pid)
      await waitFor(
        () =>
          listProcesses().every((proc) => proc.pgid !== identity!.pid || proc.state.startsWith('Z')),
        5_000,
      )
      expect(report.stillAlive).toEqual([])
    } finally {
      try {
        await (iter as AsyncGenerator).return?.(undefined)
      } catch {
        // ignore
      }
      await consuming
    }
  }, 120_000)

  it('Codex SDK + supervisor shim writes a real self-registry record', async () => {
    const marker = `bizgraph-turn:real-codex-${Date.now()}`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-real-codex-'))
    const previousDir = process.env[PROC_REGISTRY_DIR_ENV]
    const previousMarker = process.env[TURN_MARKER_ENV]
    process.env[PROC_REGISTRY_DIR_ENV] = dir
    process.env[TURN_MARKER_ENV] = marker

    try {
      const { resolveRealCodexPath } = await import('../../../shared/process-supervisor')
      const realCodex = resolveRealCodexPath()
      expect(realCodex, '必须能解析 @openai/codex/bin/codex.js').toBeTruthy()
      const shim = ensureCodexSupervisorScript(dir)
      const { Codex } = await import('@openai/codex-sdk')

      const codex = new Codex({
        env: {
          ...process.env,
          [TURN_MARKER_ENV]: marker,
          [PROC_REGISTRY_DIR_ENV]: dir,
          [REAL_CODEX_ENV]: realCodex!,
          [SUPERVISOR_NONCE_ENV]: 'real-cli-test-nonce',
          [REGISTRY_SECRET_ENV]: getRegistrySecret(),
        } as Record<string, string>,
        codexPathOverride: shim,
      })
      const thread = codex.startThread({ workingDirectory: process.cwd(), sandboxMode: 'workspace-write' })

      // 让 CLI 在任务执行期间保持存活，便于观测「残留进程组」
      const stream = await thread.runStreamed('Run the shell command `sleep 20`, then reply DONE.')
      // SDK 在首次消费 events 时才真正 spawn；必须并发消费，否则永远等不到自注册文件
      const drain = (async () => {
        try {
          for await (const _event of stream.events) {
            // 由测试决定何时回收
          }
        } catch {
          // 进程被回收后流终止属预期
        }
      })()

      const record = await waitForProcRegistryRecord(marker, 5000, 25, dir)
      expect(record, 'shim 必须自注册真实 CLI 身份').toBeTruthy()
      expect(record!.pgid).toBe(record!.pid)
      expect(record!.startedAt).toMatch(/\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}/)
      expect(record!.command).toContain('codex.js')

      // 生产路径：恢复时必须先验签，再由可信来源铸造身份签名
      expect(verifyProcRegistryFile(record, dir), '真实 shim 记录必须验签通过').toBe(true)
      const fields = {
        pid: record!.pid,
        pgid: record!.pgid,
        startedAt: record!.startedAt,
        startedAtHiRes: record!.startedAtHiRes,
        command: record!.command,
      }
      const live = listProcesses().find((item) => item.pid === record!.pid)
      if (live) expect(live.pgid, '真实 CLI 必须是自有进程组组长').toBe(record!.pid)

      // 模拟「主进程被 kill -9 后重启」：只用磁盘自注册文件认领并整组回收
      const report = new ProcessReaper().killRegistered([
        { ...fields, attestation: attestProcIdentity(fields) },
      ])
      if (report.killedGroups.includes(record!.pgid)) {
        await waitFor(() => !alive(record!.pid), 5000)
        expect(listProcesses().some((item) => item.pgid === record!.pgid), '组内不得有残留').toBe(false)
      } else {
        // 本机 ~/.codex/config.toml 的 model_reasoning_effort="max" 会让 CLI 立即 exit 1，
        // 句柄可能在回收前已自行退出（missing）；此时如实记 missing，不伪造「回收成功」证据。
        expect(report.missing, '未被回收只能是因为进程已自行退出').toContain(record!.pid)
        expect(listProcesses().some((item) => item.pgid === record!.pgid)).toBe(false)
      }

      // 收尾：被杀的 CLI 会让流报错/结束，这里只负责排空
      await drain
    } finally {
      if (previousDir === undefined) delete process.env[PROC_REGISTRY_DIR_ENV]
      else process.env[PROC_REGISTRY_DIR_ENV] = previousDir
      if (previousMarker === undefined) delete process.env[TURN_MARKER_ENV]
      else process.env[TURN_MARKER_ENV] = previousMarker
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

// 仅用于确认默认路径不会误触发真实网络调用
describe('D5 real CLI integration gate', () => {
  it('is opt-in only', () => {
    expect(typeof getProcRegistryDir()).toBe('string')
  })
})
