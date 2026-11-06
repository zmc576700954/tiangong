/**
 * D5：受控 spawn / 自有进程组 / 进程自注册的验收测试（真实进程，不使用 mock）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listProcesses, ProcessReaper } from '../process/reaper'
import {
  ensureCodexSupervisorScript,
  PROC_REGISTRY_DIR_ENV,
  REAL_CODEX_ENV,
  getRegistrySecret,
  readProcRegistryRecord,
  REGISTRY_SECRET_ENV,
  removeProcRegistryRecord,
  spawnInOwnGroup,
  SUPERVISOR_NONCE_ENV,
  TURN_MARKER_ENV,
  waitForProcRegistryRecord,
  type ProcRegistryRecord,
} from '../../../shared/process-supervisor'

const cleanup: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    try {
      fn()
    } catch {
      // 已退出
    }
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitFor timeout')
}

function killIfAlive(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
    else process.kill(pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-proc-test-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 模拟真实 Codex CLI 的父子进程形态：自身永生，并派生两个孙进程。 */
function writeFakeCodex(dir: string): string {
  const target = path.join(dir, 'fake-codex.cjs')
  fs.writeFileSync(
    target,
    [
      "'use strict'",
      "const { spawn } = require('node:child_process')",
      "for (let i = 0; i < 2; i += 1) {",
      "  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      '}',
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )
  return target
}

describe('D5 supervised process group', () => {
  it('spawnInOwnGroup makes the child a process-group leader (pgid === pid)', async () => {
    const child = spawnInOwnGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    cleanup.push(() => killIfAlive(child.pid))
    expect(child.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))
    const proc = listProcesses().find((item) => item.pid === child.pid)!
    expect(proc.pgid, 'detached spawn 必须形成自有进程组').toBe(child.pid)
  })

  it('Codex shim self-registers a real pid/pgid/startedAt/command and the whole group is reclaimable after the shim dies', async () => {
    const dir = tmpDir()
    const realCodex = writeFakeCodex(dir)
    const marker = `bizgraph-turn:supervisor-${Date.now()}`
    const shim = ensureCodexSupervisorScript(dir)

    const shimProc = spawn(shim, [], {
      env: {
        ...process.env,
        [TURN_MARKER_ENV]: marker,
        [PROC_REGISTRY_DIR_ENV]: dir,
        [REAL_CODEX_ENV]: realCodex,
        [SUPERVISOR_NONCE_ENV]: 'test-nonce-shim-1',
        [REGISTRY_SECRET_ENV]: getRegistrySecret(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanup.push(() => {
      killIfAlive(shimProc.pid)
      removeProcRegistryRecord(marker, dir)
    })
    shimProc.stderr?.on('data', () => undefined)

    const record = await waitForProcRegistryRecord(marker, 5000, 25, dir)
    expect(record, 'shim 必须在 spawn 后写自注册文件').toBeTruthy()
    expect(record!.pid).toBeGreaterThan(1)
    expect(record!.pgid).toBe(record!.pid)
    expect(record!.startedAt, 'startedAt 必须与 ps 归一化格式一致').toMatch(/\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}/)
    expect(record!.command).toContain('fake-codex.cjs')

    await waitFor(() => listProcesses().some((proc) => proc.pid === record!.pid))
    const live = listProcesses().find((proc) => proc.pid === record!.pid)!
    expect(live.pgid, '真实 CLI 必须是自有进程组组长').toBe(record!.pid)

    // 另起一个无关的自有进程组，用于验证不误杀
    const bystander = spawnInOwnGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    cleanup.push(() => killIfAlive(bystander.pid))

    // 模拟主进程被 kill -9：shim 直接消失，真实 CLI 与其孙进程成为残留
    shimProc.kill('SIGKILL')
    await waitFor(() => !alive(shimProc.pid!))
    await waitFor(() => listProcesses().some((proc) => proc.pgid === record!.pgid))

    const identity = {
      pid: record!.pid,
      pgid: record!.pgid,
      startedAt: record!.startedAt,
      command: record!.command,
    }
    const report = new ProcessReaper().killRegistered([identity])
    expect(report.killed, '必须按自注册身份回收组长').toBe(1)
    expect(report.killedGroups).toContain(record!.pgid)
    expect(report.stillAlive).toEqual([])
    await waitFor(() => !listProcesses().some((proc) => proc.pgid === record!.pgid))
    expect(alive(bystander.pid!), '无关进程组绝不能被整组带走').toBe(true)
  })

  it('refuses group reclaim when the recorded pgid does not identify the live leader (PID reuse)', async () => {
    const bystander = spawnInOwnGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    cleanup.push(() => killIfAlive(bystander.pid))
    await waitFor(() => listProcesses().some((proc) => proc.pid === bystander.pid))

    // 伪造「pgid === pid」但不提供匹配证据：必须拒绝
    const report = new ProcessReaper().killRegistered([
      { pid: bystander.pid!, pgid: bystander.pid!, startedAt: 'Jan 1 00:00:00 2020', command: 'other-binary' },
    ])
    expect(report.killed).toBe(0)
    expect(report.unresolved[0]?.reason).toBe('insufficient-proof')
    expect(alive(bystander.pid!), '证据不足时不得杀').toBe(true)
  })

  it('cross-restart registry sweep kills a residual group recorded on disk', async () => {
    const dir = tmpDir()
    const realCodex = writeFakeCodex(dir)
    const marker = `bizgraph-turn:restart-${Date.now()}`
    const shim = ensureCodexSupervisorScript(dir)
    const shimProc = spawn(shim, [], {
      env: {
        ...process.env,
        [TURN_MARKER_ENV]: marker,
        [PROC_REGISTRY_DIR_ENV]: dir,
        [REAL_CODEX_ENV]: realCodex,
        [SUPERVISOR_NONCE_ENV]: 'test-nonce-shim-2',
        [REGISTRY_SECRET_ENV]: getRegistrySecret(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanup.push(() => killIfAlive(shimProc.pid))
    const record = await waitForProcRegistryRecord(marker, 5000, 25, dir)
    expect(record).toBeTruthy()

    shimProc.kill('SIGKILL')
    await waitFor(() => !alive(shimProc.pid!))

    // 启动清扫只拿到磁盘上的自注册文件（DB 里没有句柄）
    const onDisk: ProcRegistryRecord = readProcRegistryRecord(marker, dir)!
    const report = new ProcessReaper().killRegistered([onDisk])
    expect(report.killedGroups).toContain(onDisk.pgid)
    await waitFor(() => !listProcesses().some((proc) => proc.pgid === onDisk.pgid))
  })
})
