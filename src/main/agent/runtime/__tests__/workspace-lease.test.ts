/**
 * W5-A 定向：workspace lease。
 *
 * 验收点：
 * - lease 文件承载 workspace key + pid + env marker + heartbeat + TTL；
 * - stale（TTL 到期）可抢占；原子抢占不产生双持有者；
 * - 同进程重入按引用计数；
 * - 持有者存活时拒绝（真实双进程）；
 * - `kill -9` 后按 TTL 可抢占（真实子进程）；
 * - 灰度关闭时完全无 lease 行为。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_LEASE_TTL_MS,
  WORKSPACE_LEASE_ENV,
  WorkspaceLeaseRegistry,
  isWorkspaceLeaseEnabled,
  type WorkspaceLeaseFile,
} from '../locks/workspace-lease'
import { buildChildEntry, makeTempDir, waitForExit, waitForStdout } from './helpers/cross-process'

const LEASE_MODULE = path.resolve(process.cwd(), 'src/main/agent/runtime/locks/workspace-lease.ts')

/** 等待子进程输出 ACQUIRED 或 HELD 的早到者（两者都是合法结果）。 */
function firstLeaseSignal(child: ReturnType<typeof spawn>, timeoutMs = 8000): Promise<'ACQUIRED' | 'HELD'> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`lease child timeout: ${buffer.slice(-200)}`))
    }, timeoutMs)
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      if (/ACQUIRED/.test(buffer)) {
        cleanup()
        resolve('ACQUIRED')
      } else if (/HELD/.test(buffer)) {
        cleanup()
        resolve('HELD')
      }
    }
    const onExit = (code: number | null) => {
      cleanup()
      if (/ACQUIRED/.test(buffer)) resolve('ACQUIRED')
      else if (/HELD/.test(buffer)) resolve('HELD')
      else reject(new Error(`lease child exited early (code=${code}): ${buffer.slice(-200)}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout?.on('data', onData)
    child.on('exit', onExit)
  })
}

describe('WorkspaceLeaseRegistry (single process)', () => {
  const dirs: string[] = []
  let dir: string

  beforeEach(() => {
    dir = makeTempDir('w5-lease-')
    dirs.push(dir)
  })
  afterEach(() => {
    for (const item of dirs.splice(0)) fs.rmSync(item, { recursive: true, force: true })
  })

  it('is disabled unless the feature flag is explicitly on', () => {
    const previous = process.env[WORKSPACE_LEASE_ENV]
    delete process.env[WORKSPACE_LEASE_ENV]
    try {
      expect(isWorkspaceLeaseEnabled()).toBe(false)
      process.env[WORKSPACE_LEASE_ENV] = '1'
      expect(isWorkspaceLeaseEnabled()).toBe(true)
      process.env[WORKSPACE_LEASE_ENV] = '0'
      expect(isWorkspaceLeaseEnabled()).toBe(false)
    } finally {
      if (previous === undefined) delete process.env[WORKSPACE_LEASE_ENV]
      else process.env[WORKSPACE_LEASE_ENV] = previous
    }
  })

  it('disabled mode is a no-op and writes no file', () => {
    const registry = new WorkspaceLeaseRegistry({ enabled: false, dir, ttlMs: 1000 })
    const lease = registry.acquire('ws-a', { workspacePath: '/tmp/ws-a', envMarker: 'm1' })
    expect(lease.acquired).toBe(true)
    expect(lease.noop).toBe(true)
    expect(registry.inspect('ws-a')).toBeNull()
    expect(fs.existsSync(registry.leasePath('ws-a'))).toBe(false)
    lease.release()
    registry.stop()
  })

  it('writes workspace key, pid, env marker, heartbeat and TTL', () => {
    const registry = new WorkspaceLeaseRegistry({ enabled: true, dir, ttlMs: 2000 })
    const lease = registry.acquire('ws-a', { workspacePath: '/tmp/ws-a', envMarker: 'marker-1' })
    expect(lease.acquired).toBe(true)
    expect(lease.reentrant).toBe(false)

    const file = JSON.parse(fs.readFileSync(registry.leasePath('ws-a'), 'utf-8')) as WorkspaceLeaseFile
    expect(file.version).toBe(1)
    expect(file.workspaceKey).toBe('ws-a')
    expect(file.workspacePath).toBe('/tmp/ws-a')
    expect(file.pid).toBe(process.pid)
    expect(file.envMarker).toBe('marker-1')
    expect(file.ttlMs).toBe(2000)
    expect(file.heartbeatAt).toBeGreaterThan(0)
    expect(file.token.length).toBeGreaterThan(0)

    lease.release()
    expect(fs.existsSync(registry.leasePath('ws-a'))).toBe(false)
    registry.stop()
  })

  it('same registry re-entry is reference-counted', () => {
    const registry = new WorkspaceLeaseRegistry({ enabled: true, dir, ttlMs: 2000 })
    const first = registry.acquire('ws-a')
    const second = registry.acquire('ws-a')
    expect(second.reentrant).toBe(true)
    expect(second.acquired).toBe(true)

    first.release()
    expect(fs.existsSync(registry.leasePath('ws-a'))).toBe(true)
    second.release()
    expect(fs.existsSync(registry.leasePath('ws-a'))).toBe(false)
    registry.stop()
  })

  it('rejects a live holder (another registry in the same process)', () => {
    const holder = new WorkspaceLeaseRegistry({ enabled: true, dir, ttlMs: 2000 })
    const contender = new WorkspaceLeaseRegistry({ enabled: true, dir, ttlMs: 2000 })
    const lease = holder.acquire('ws-a')
    const rejected = contender.acquire('ws-a')
    expect(rejected.acquired).toBe(false)
    expect(rejected.reason).toBe('held')
    expect(rejected.holder?.pid).toBe(process.pid)
    lease.release()
    holder.stop()
    contender.stop()
  })

  it('takes over a stale lease atomically', () => {
    const registry = new WorkspaceLeaseRegistry({ enabled: true, dir, ttlMs: 1000 })
    const leasePath = registry.leasePath('ws-a')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      leasePath,
      JSON.stringify({
        version: 1,
        workspaceKey: 'ws-a',
        workspacePath: '/tmp/ws-a',
        pid: 999999,
        envMarker: 'dead-holder',
        host: 'other-host',
        heartbeatAt: Date.now() - 2000,
        ttlMs: 1000,
        acquiredAt: Date.now() - 3000,
        token: 'stale-token',
      } satisfies WorkspaceLeaseFile),
    )

    const lease = registry.acquire('ws-a', { workspacePath: '/tmp/ws-a', envMarker: 'new' })
    expect(lease.acquired).toBe(true)
    expect(lease.reason).toBe('acquired')
    const file = JSON.parse(fs.readFileSync(leasePath, 'utf-8')) as WorkspaceLeaseFile
    expect(file.pid).toBe(process.pid)
    expect(file.token).not.toBe('stale-token')
    lease.release()
    registry.stop()
  })

  it('keeps the default TTL stable', () => {
    expect(DEFAULT_WORKSPACE_LEASE_TTL_MS).toBe(30_000)
  })
})

describe('WorkspaceLeaseRegistry (cross process)', () => {
  let workDir = ''
  let childEntry = ''
  const cleanup: Array<() => void> = []

  beforeAll(() => {
    workDir = makeTempDir('w5-lease-cross-')
    childEntry = buildChildEntry(
      'lease-holder',
      `
import { WorkspaceLeaseRegistry } from ${JSON.stringify(LEASE_MODULE)}
const [dir, key, ttlRaw] = process.argv.slice(2)
const ttl = Number(ttlRaw)
const registry = new WorkspaceLeaseRegistry({
  enabled: true,
  dir,
  ttlMs: ttl,
  heartbeatIntervalMs: Math.max(20, Math.floor(ttl / 3)),
})
const lease = registry.acquire(key, { envMarker: 'child-holder' })
if (!lease.acquired) {
  console.log('HELD')
  process.exit(2)
}
console.log('ACQUIRED ' + process.pid)
setInterval(() => {}, 1000)
`,
      workDir,
    )
  })

  afterAll(() => {
    for (const fn of cleanup.splice(0)) fn()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('rejects a second process while the holder is alive', async () => {
    const dir = makeTempDir('w5-lease-holder-')
    const holder = spawn(process.execPath, [childEntry, dir, 'ws-cross', '400'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cleanup.push(() => {
      if (holder.exitCode === null) holder.kill('SIGKILL')
      fs.rmSync(dir, { recursive: true, force: true })
    })

    const output = await waitForStdout(holder, /ACQUIRED (\d+)/)
    const holderPid = Number(output.match(/ACQUIRED (\d+)/)![1])
    expect(holderPid).toBe(holder.pid)

    // 第二个真实进程：必须被拒绝（打印 HELD 后退出码 2）。
    const contender = spawn(process.execPath, [childEntry, dir, 'ws-cross', '400'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForStdout(contender, /HELD/)
    expect(await waitForExit(contender)).toBe(2)

    holder.kill('SIGKILL')
    await waitForExit(holder)
  })

  it('is atomic: exactly one of two fresh processes wins the first lease', async () => {
    const dir = makeTempDir('w5-lease-race-')
    const children = [
      spawn(process.execPath, [childEntry, dir, 'ws-race', '600'], { stdio: ['ignore', 'pipe', 'pipe'] }),
      spawn(process.execPath, [childEntry, dir, 'ws-race', '600'], { stdio: ['ignore', 'pipe', 'pipe'] }),
    ]
    cleanup.push(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
      fs.rmSync(dir, { recursive: true, force: true })
    })

    const outcomes = await Promise.all(children.map((child) => firstLeaseSignal(child)))
    expect(outcomes.filter((item) => item === 'ACQUIRED')).toHaveLength(1)
    expect(outcomes.filter((item) => item === 'HELD')).toHaveLength(1)
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  })

  it('allows takeover after kill -9 once the TTL expires', async () => {
    const dir = makeTempDir('w5-lease-kill9-')
    const ttl = 300
    const holder = spawn(process.execPath, [childEntry, dir, 'ws-kill', String(ttl)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cleanup.push(() => {
      if (holder.exitCode === null) holder.kill('SIGKILL')
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await waitForStdout(holder, /ACQUIRED \d+/)

    const survivor = new WorkspaceLeaseRegistry({ enabled: true, dir, ttlMs: ttl, heartbeatIntervalMs: 100 })
    const whileAlive = survivor.acquire('ws-kill', { envMarker: 'parent' })
    expect(whileAlive.acquired).toBe(false)

    holder.kill('SIGKILL')
    await waitForExit(holder)

    // kill -9 之后心跳停更；等 TTL 到期再抢。
    await new Promise((resolve) => setTimeout(resolve, ttl + 120))
    const afterTtl = survivor.acquire('ws-kill', { envMarker: 'parent' })
    expect(afterTtl.acquired).toBe(true)
    expect(afterTtl.reason).toBe('acquired')
    afterTtl.release()
    survivor.stop()
  })
})
