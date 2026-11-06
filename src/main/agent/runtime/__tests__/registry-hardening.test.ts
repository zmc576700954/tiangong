/**
 * C12 / C13 回归：自注册记录的信任边界。
 *
 * - 伪造记录（字段来自 ps，无 nonce/签名）不得导致 kill；
 * - 注册目录必须是属主独占 0700；已存在的 0777 目录只允许属主收紧后使用，symlink 一律拒绝；
 * - 记录文件必须 0600、属主当前用户、非 symlink，且 HMAC 验签通过；
 * - 同一身份重放不得产生第二次 kill。
 *
 * 全部使用真实进程与真实 ps，不 mock 进程表。
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attestProcIdentity, listProcesses, ProcessReaper } from '../process/reaper'
import {
  CODEX_SUPERVISOR_FILE,
  ensureCodexSupervisorScript,
  ensureRegistryDir,
  getRegistrySecret,
  PROC_REGISTRY_DIR_ENV,
  REAL_CODEX_ENV,
  readProcRegistryRecord,
  registryRecordPath,
  REGISTRY_SECRET_ENV,
  signProcRegistryRecord,
  SUPERVISOR_NONCE_ENV,
  TURN_MARKER_ENV,
  verifyProcRegistryFile,
  verifyProcRegistryRecord,
  waitForProcRegistryRecord,
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

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-registry-hardening-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function spawnDetached(): { pid: number } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  cleanup.push(() => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  })
  return { pid: child.pid! }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timeout')
}

function writeFakeCodex(dir: string): string {
  const target = path.join(dir, 'fake-codex.cjs')
  fs.writeFileSync(
    target,
    [
      "'use strict'",
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )
  return target
}

const PID_FILE_ENV = 'BIZGRAPH_TEST_PID_FILE'

function writeFakeCodexWithPidFile(dir: string): string {
  const target = path.join(dir, 'fake-codex-pidfile.cjs')
  fs.writeFileSync(
    target,
    [
      "'use strict'",
      "const fs = require('node:fs')",
      "if (process.env.BIZGRAPH_TEST_PID_FILE) fs.writeFileSync(process.env.BIZGRAPH_TEST_PID_FILE, String(process.pid))",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )
  return target
}

function signedRecord(
  marker: string,
  dir: string,
  identity: { pid: number; pgid?: number; startedAt?: string; command?: string },
  mutate: (record: Record<string, unknown>) => void = () => undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    marker,
    pid: identity.pid,
    pgid: identity.pgid,
    startedAt: identity.startedAt,
    command: identity.command,
    createdAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  }
  const sig = signProcRegistryRecord(base as never)
  const record = { ...base, sig }
  mutate(record)
  fs.writeFileSync(registryRecordPath(marker, dir), JSON.stringify(record), { mode: 0o600 })
  return record
}

describe('registry trust boundary (C12/C13)', () => {
  it('C12: a forged record with real ps fields but no nonce/signature must not kill', async () => {
    const canary = spawnDetached()
    await waitFor(() => listProcesses().some((proc) => proc.pid === canary.pid))
    const live = listProcesses().find((proc) => proc.pid === canary.pid)!
    const dir = tmpDir()
    const marker = `bizgraph-turn:forged-${Date.now()}`

    // 攻击者能写该目录：字段全部来自 ps，但没有 nonce / 签名
    const forged = {
      marker,
      pid: live.pid,
      pgid: live.pgid,
      startedAt: live.startedAt,
      command: live.command,
      createdAt: Date.now(),
    }
    fs.writeFileSync(registryRecordPath(marker, dir), JSON.stringify(forged), { mode: 0o600 })

    const read = readProcRegistryRecord(marker, dir)
    expect(read, '文件本身可被读取（读取不等于信任）').toBeTruthy()
    expect(verifyProcRegistryFile(read, dir), '无签名记录必须验签失败').toBe(false)

    const report = new ProcessReaper().killRegistered(
      [{ pid: read!.pid, pgid: read!.pgid, startedAt: read!.startedAt, command: read!.command }],
      { marker },
    )
    expect(report.killed, '伪造记录不得产生 kill').toBe(0)
    expect(report.killedGroups).toHaveLength(0)
    expect(alive(canary.pid), 'canary 必须存活').toBe(true)
  })

  it('C13: a pre-created 0777 registry dir is tightened to 0700 and the shim is not group/other writable', () => {
    const parent = tmpDir()
    const squatted = path.join(parent, 'squatted')
    fs.mkdirSync(squatted, { recursive: true, mode: 0o777 })
    fs.chmodSync(squatted, 0o777)
    expect(fs.statSync(squatted).mode & 0o777).toBe(0o777)

    const shim = ensureCodexSupervisorScript(squatted)
    expect(fs.statSync(squatted).mode & 0o777, '目录必须收紧为 0700').toBe(0o700)
    expect(fs.statSync(shim).mode & 0o022, 'shim 不得组/其他可写').toBe(0)
  })

  it('C13: a symlinked registry dir is rejected instead of reused', () => {
    const parent = tmpDir()
    const real = path.join(parent, 'real')
    const link = path.join(parent, 'link')
    fs.mkdirSync(real, { recursive: true })
    fs.symlinkSync(real, link)
    expect(() => ensureRegistryDir(link)).toThrow(/not a real directory/)
  })

  it('a symlinked record file is rejected even if its target is signed', () => {
    const dir = tmpDir()
    const canary = spawnDetached()
    const identity = new ProcessReaper().registerProcess('seed', { pid: canary.pid })!
    const marker = `bizgraph-turn:symlink-${Date.now()}`
    const target = path.join(dir, 'outside.json')
    const record = signedRecord(marker, dir, identity)
    fs.renameSync(registryRecordPath(marker, dir), target)
    fs.symlinkSync(target, registryRecordPath(marker, dir))
    expect(verifyProcRegistryRecord(record as never), '签名本身有效').toBe(true)
    expect(verifyProcRegistryFile(record as never, dir), 'symlink 必须整体拒绝').toBe(false)
  })

  it('a signed record readable by group/other is rejected (must be 0600)', () => {
    const dir = tmpDir()
    const canary = spawnDetached()
    const marker = `bizgraph-turn:wide-mode-${Date.now()}`
    const identity = new ProcessReaper().registerProcess('seed', { pid: canary.pid })!
    const record = signedRecord(marker, dir, identity)
    fs.chmodSync(registryRecordPath(marker, dir), 0o644)
    expect(verifyProcRegistryRecord(record as never), '签名本身有效').toBe(true)
    expect(verifyProcRegistryFile(record as never, dir), '权限宽于 0600 必须整体拒绝').toBe(false)
  })

  it('C13b: a pre-placed same-name symlink is replaced without touching the victim', () => {
    const parent = tmpDir()
    const dir = path.join(parent, 'registry')
    fs.mkdirSync(dir, { mode: 0o700 })
    const victim = path.join(parent, 'victim.txt')
    fs.writeFileSync(victim, 'ORIGINAL')
    const target = path.join(dir, CODEX_SUPERVISOR_FILE)
    fs.symlinkSync(victim, target)

    expect(() => ensureCodexSupervisorScript(dir), '不得顺着 symlink 写入').not.toThrow()
    expect(fs.readFileSync(victim, 'utf-8'), '受害者文件不得被覆盖').toBe('ORIGINAL')
    expect(fs.lstatSync(target).isSymbolicLink(), '链接本身被原子替换为真实 shim').toBe(false)
    expect(fs.statSync(target).mode & 0o777, 'shim 必须 0700').toBe(0o700)
  })

  it('C13b: a pre-placed same-name regular file is rejected without overwrite', () => {
    const parent = tmpDir()
    const dir = path.join(parent, 'registry')
    fs.mkdirSync(dir, { mode: 0o700 })
    const target = path.join(dir, CODEX_SUPERVISOR_FILE)
    fs.writeFileSync(target, 'PRE-EXISTING', { mode: 0o600 })

    expect(() => ensureCodexSupervisorScript(dir), '预置普通文件必须拒绝').toThrow(/overwrite existing/)
    expect(fs.readFileSync(target, 'utf-8'), '预置文件内容不得被覆盖').toBe('PRE-EXISTING')
  })

  it('C13b: a read-only registry dir is rejected and existing content is untouched', () => {
    const parent = tmpDir()
    const dir = path.join(parent, 'registry')
    fs.mkdirSync(dir, { mode: 0o700 })
    const victim = path.join(dir, 'victim.txt')
    fs.writeFileSync(victim, 'ORIGINAL')
    fs.chmodSync(dir, 0o500)
    try {
      expect(() => ensureCodexSupervisorScript(dir), '只读目录必须拒绝').toThrow()
      expect(fs.readFileSync(victim, 'utf-8'), '目录内已有文件不得被覆盖').toBe('ORIGINAL')
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  })

  it('C13b control: a clean registry dir creates the shim atomically and is idempotent', () => {
    const dir = path.join(tmpDir(), 'registry')
    fs.mkdirSync(dir, { mode: 0o700 })
    const shim = ensureCodexSupervisorScript(dir)
    expect(fs.statSync(shim).mode & 0o777, 'shim 必须 0700').toBe(0o700)
    expect(fs.readFileSync(shim, 'utf-8')).toContain('bizgraph-codex-supervisor')
    expect(ensureCodexSupervisorScript(dir), '内容一致的重复调用应幂等').toBe(shim)
  })

  it('C13b: a pre-placed record symlink is rejected by the shim without touching the victim', async () => {
    const dir = path.join(tmpDir(), 'registry')
    fs.mkdirSync(dir, { mode: 0o700 })
    const victim = path.join(dir, 'victim.txt')
    fs.writeFileSync(victim, 'ORIGINAL')
    const marker = `bizgraph-turn:record-symlink-${Date.now()}`
    const recordPath = registryRecordPath(marker, dir)
    fs.symlinkSync(victim, recordPath)
    const pidFile = path.join(dir, 'fake-child.pid')
    const fakeCodex = writeFakeCodexWithPidFile(dir)
    const shim = ensureCodexSupervisorScript(dir)

    const shimProc = spawn(shim, [], {
      env: {
        ...process.env,
        [TURN_MARKER_ENV]: marker,
        [PROC_REGISTRY_DIR_ENV]: dir,
        [REAL_CODEX_ENV]: fakeCodex,
        [SUPERVISOR_NONCE_ENV]: 'record-symlink-nonce',
        [REGISTRY_SECRET_ENV]: getRegistrySecret(),
        [PID_FILE_ENV]: pidFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    shimProc.stderr?.on('data', () => undefined)
    cleanup.push(() => {
      try {
        process.kill(shimProc.pid!, 'SIGKILL')
      } catch {
        // 已退出
      }
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf-8'))
        if (pid > 1) process.kill(-pid, 'SIGKILL')
      } catch {
        // 子进程未启动/已退出
      }
    })

    await waitFor(() => fs.existsSync(pidFile))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fs.readFileSync(victim, 'utf-8'), '受害者文件不得被记录写入覆盖').toBe('ORIGINAL')
    expect(fs.lstatSync(recordPath).isSymbolicLink(), '记录路径仍是攻击者的 symlink').toBe(true)
  })

  it('a tampered signed record fails verification and never kills', async () => {
    const canary = spawnDetached()
    await waitFor(() => listProcesses().some((proc) => proc.pid === canary.pid))
    const identity = new ProcessReaper().registerProcess('seed', { pid: canary.pid })!
    const dir = tmpDir()
    const marker = `bizgraph-turn:tampered-${Date.now()}`
    const record = signedRecord(marker, dir, identity, (item) => {
      ;(item as { command: string }).command = `${identity.command} --injected`
    })
    expect(verifyProcRegistryFile(record as never, dir), '字段被改后签名必须失效').toBe(false)

    const report = new ProcessReaper().killRegistered(
      [{ pid: canary.pid, pgid: identity.pgid, startedAt: identity.startedAt, command: `${identity.command} --injected` }],
      { marker },
    )
    expect(report.killed).toBe(0)
    expect(alive(canary.pid)).toBe(true)
  })

  it('replaying an already reclaimed identity produces no second kill', async () => {
    // 正向对照：真实 shim 写下的签名记录仍能被回收
    const dir = tmpDir()
    const realCodex = writeFakeCodex(dir)
    const marker = `bizgraph-turn:replay-${Date.now()}`
    const shim = ensureCodexSupervisorScript(dir)
    const shimProc = spawn(shim, [], {
      env: {
        ...process.env,
        [TURN_MARKER_ENV]: marker,
        [PROC_REGISTRY_DIR_ENV]: dir,
        [REAL_CODEX_ENV]: realCodex,
        [SUPERVISOR_NONCE_ENV]: 'replay-nonce',
        [REGISTRY_SECRET_ENV]: getRegistrySecret(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanup.push(() => {
      try {
        process.kill(shimProc.pid!, 'SIGKILL')
      } catch {
        // 已退出
      }
    })
    shimProc.stderr?.on('data', () => undefined)
    const record = await waitForProcRegistryRecord(marker, 5000, 25, dir)
    expect(record, '真实 shim 必须自注册').toBeTruthy()
    expect(verifyProcRegistryFile(record, dir), '真实记录必须验签通过').toBe(true)

    shimProc.kill('SIGKILL')
    await waitFor(() => !alive(shimProc.pid!))
    await waitFor(() => listProcesses().some((proc) => proc.pgid === record!.pgid))

    const fields = {
      pid: record!.pid,
      pgid: record!.pgid,
      startedAt: record!.startedAt,
      startedAtHiRes: record!.startedAtHiRes,
      command: record!.command,
    }
    const first = new ProcessReaper().killRegistered(
      [{ ...fields, attestation: attestProcIdentity(fields) }],
      { marker },
    )
    expect(first.killed, '正向对照：真实残留必须被回收').toBeGreaterThanOrEqual(1)
    expect(first.killedGroups).toContain(record!.pgid)
    await waitFor(() => !listProcesses().some((proc) => proc.pgid === record!.pgid))

    // 重放同一份已回收的身份：进程已消失，不得再产生 kill
    const replay = new ProcessReaper().killRegistered(
      [{ ...fields, attestation: attestProcIdentity(fields) }],
      { marker },
    )
    expect(replay.killed, '重放不得产生第二次 kill').toBe(0)
    expect(replay.missing).toContain(record!.pid)
  })
})
