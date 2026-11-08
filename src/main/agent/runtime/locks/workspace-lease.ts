/**
 * W5-A：workspace lease（跨进程工作区租约）。
 *
 * 目的：两个进程同时操作同一工作区时，用一份落盘 lease 做「谁在持有」的判定，
 * 避免第二个进程在持有者仍存活时抢写。它**不替代**进程内 SessionLock：
 * - 进程内串行仍由 SessionLockRegistry 负责；
 * - lease 只回答「这个 workspace 现在是否被另一个活着的进程持有」。
 *
 * 文件内容（JSON）承载：workspace key、pid、env marker、heartbeat、TTL。
 * stale 判定：`now - heartbeatAt >= ttlMs`（kill -9 后心跳停更，TTL 到期即可抢占）。
 * 抢占是原子的：先把 stale 文件 rename 走（同一路径只有一个进程能成功），
 * 再用 `wx` 独占创建；两个进程不会同时成为持有者。
 * 同进程重入按 key 引用计数，release 只释放最外层。
 *
 * 灰度：默认关闭（`BIZGRAPH_WORKSPACE_LEASE` 未设置 = 关闭）。
 * 关闭时 acquire 返回 noop lease，不读写任何文件，行为与引入前完全一致。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const WORKSPACE_LEASE_ENV = 'BIZGRAPH_WORKSPACE_LEASE'
export const WORKSPACE_LEASE_TTL_MS_ENV = 'BIZGRAPH_WORKSPACE_LEASE_TTL_MS'
export const WORKSPACE_LEASE_DIR_ENV = 'BIZGRAPH_WORKSPACE_LEASE_DIR'

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/** 灰度开关：只有显式开启值才返回 true，绝不做默认开启。 */
export function isWorkspaceLeaseEnabled(raw = process.env[WORKSPACE_LEASE_ENV]): boolean {
  if (raw === undefined || raw.trim() === '') return false
  return TRUTHY.has(raw.trim().toLowerCase())
}

export const DEFAULT_WORKSPACE_LEASE_TTL_MS = 30_000

export interface WorkspaceLeaseFile {
  version: 1
  workspaceKey: string
  workspacePath: string
  pid: number
  envMarker: string
  host: string
  heartbeatAt: number
  ttlMs: number
  acquiredAt: number
  /** 本次抢占的随机标识，release 只删除自己持有的文件。 */
  token: string
}

export type WorkspaceLeaseReason = 'disabled' | 'acquired' | 'reentrant' | 'held'

export interface WorkspaceLease {
  readonly acquired: boolean
  readonly reentrant: boolean
  readonly noop: boolean
  readonly workspaceKey: string
  readonly reason: WorkspaceLeaseReason
  /** 被拒绝时的持有者信息（诊断/日志用）。 */
  readonly holder?: WorkspaceLeaseFile
  release(): void
}

export interface WorkspaceLeaseOptions {
  /** 覆盖环境变量；测试与灰度注入用。 */
  enabled?: boolean
  /** lease 文件目录；默认按 uid 隔离的临时目录。 */
  dir?: string
  /** 缺省 TTL（毫秒）；默认 30s。 */
  ttlMs?: number
  /** 心跳间隔；默认 ttl/3（不小于 20ms）。 */
  heartbeatIntervalMs?: number
  now?: () => number
  host?: string
}

interface HeldLease {
  key: string
  path: string
  token: string
  count: number
  timer: NodeJS.Timeout | null
}

function defaultLeaseDir(): string {
  const override = process.env[WORKSPACE_LEASE_DIR_ENV]
  if (override) return override
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid'
  return path.join(os.tmpdir(), `bizgraph-workspace-leases-${uid}`)
}

function normalizeKey(key: string, workspacePath?: string): string {
  const trimmed = key?.trim()
  if (trimmed) return trimmed
  if (workspacePath) return path.resolve(workspacePath)
  throw new Error('workspace lease requires a non-empty workspace key')
}

export class WorkspaceLeaseRegistry {
  private readonly enabled: boolean
  private readonly dir: string
  private readonly ttlMs: number
  private readonly heartbeatIntervalMs: number
  private readonly now: () => number
  private readonly host: string
  private readonly held = new Map<string, HeldLease>()

  constructor(options: WorkspaceLeaseOptions = {}) {
    this.enabled = options.enabled ?? isWorkspaceLeaseEnabled()
    this.dir = options.dir ?? defaultLeaseDir()
    const envTtl = Number(process.env[WORKSPACE_LEASE_TTL_MS_ENV])
    const ttl =
      typeof options.ttlMs === 'number' && options.ttlMs > 0
        ? options.ttlMs
        : Number.isFinite(envTtl) && envTtl > 0
          ? envTtl
          : DEFAULT_WORKSPACE_LEASE_TTL_MS
    this.ttlMs = Math.floor(ttl)
    this.heartbeatIntervalMs = Math.max(
      20,
      Math.floor(options.heartbeatIntervalMs ?? this.ttlMs / 3),
    )
    this.now = options.now ?? Date.now
    this.host = options.host ?? os.hostname()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** lease 文件路径（测试/诊断可读）。 */
  leasePath(workspaceKey: string, workspacePath?: string): string {
    const key = normalizeKey(workspaceKey, workspacePath)
    const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
    return path.join(this.dir, `${digest}.lease.json`)
  }

  /**
   * 尝试获取 workspace lease。
   * - 关闭：noop（acquired=true, noop=true）；
   * - 本 registry 已持有：重入（引用计数 +1）；
   * - 文件不存在：独占创建即成功；
   * - 文件存在且未 stale：held（acquired=false）；
   * - 文件 stale：原子抢占。
   */
  acquire(
    workspaceKey: string,
    options: { workspacePath?: string; envMarker?: string } = {},
  ): WorkspaceLease {
    const key = normalizeKey(workspaceKey, options.workspacePath)
    if (!this.enabled) {
      return {
        acquired: true,
        reentrant: false,
        noop: true,
        workspaceKey: key,
        reason: 'disabled',
        release: () => undefined,
      }
    }

    const existing = this.held.get(key)
    if (existing) {
      existing.count += 1
      return {
        acquired: true,
        reentrant: true,
        noop: false,
        workspaceKey: key,
        reason: 'reentrant',
        release: () => this.releaseKey(key),
      }
    }

    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const leasePath = this.leasePath(key)
    const token = crypto.randomUUID()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = readLeaseFile(leasePath)
      if (!current) {
        if (this.tryCreate(leasePath, key, options, token)) {
          return this.installHeld(key, leasePath, token)
        }
        continue
      }
      if (!this.isStale(current)) {
        return {
          acquired: false,
          reentrant: false,
          noop: false,
          workspaceKey: key,
          reason: 'held',
          holder: current,
          release: () => undefined,
        }
      }
      // stale：先用 rename 原子摘走旧文件，成功者才进入创建阶段。
      const takeoverPath = `${leasePath}.stale-${token}-${attempt}`
      try {
        fs.renameSync(leasePath, takeoverPath)
      } catch (error) {
        if (isEnoent(error)) continue
        throw error
      }
      try {
        if (this.tryCreate(leasePath, key, options, token)) {
          return this.installHeld(key, leasePath, token)
        }
      } finally {
        safeUnlink(takeoverPath)
      }
      // 创建失败说明另一个进程先创建了；重新读一次再判定。
      const after = readLeaseFile(leasePath)
      if (after && !this.isStale(after)) {
        return {
          acquired: false,
          reentrant: false,
          noop: false,
          workspaceKey: key,
          reason: 'held',
          holder: after,
          release: () => undefined,
        }
      }
    }

    const holder = readLeaseFile(leasePath) ?? undefined
    return {
      acquired: false,
      reentrant: false,
      noop: false,
      workspaceKey: key,
      reason: 'held',
      holder,
      release: () => undefined,
    }
  }

  /** 诊断：读取当前落盘 lease（不修改）。 */
  inspect(workspaceKey: string, workspacePath?: string): WorkspaceLeaseFile | null {
    if (!this.enabled) return null
    return readLeaseFile(this.leasePath(workspaceKey, workspacePath))
  }

  /** 释放本 registry 持有的全部 lease（退出路径）。 */
  stop(): void {
    for (const key of [...this.held.keys()]) {
      const entry = this.held.get(key)
      if (!entry) continue
      entry.count = 1
      this.releaseKey(key)
    }
  }

  private installHeld(key: string, leasePath: string, token: string): WorkspaceLease {
    const entry: HeldLease = { key, path: leasePath, token, count: 1, timer: null }
    entry.timer = setInterval(() => this.heartbeat(key, token), this.heartbeatIntervalMs)
    entry.timer.unref?.()
    this.held.set(key, entry)
    return {
      acquired: true,
      reentrant: false,
      noop: false,
      workspaceKey: key,
      reason: 'acquired',
      release: () => this.releaseKey(key),
    }
  }

  private releaseKey(key: string): void {
    const entry = this.held.get(key)
    if (!entry) return
    entry.count -= 1
    if (entry.count > 0) return
    if (entry.timer) {
      clearInterval(entry.timer)
      entry.timer = null
    }
    this.held.delete(key)
    const current = readLeaseFile(entry.path)
    // 只删除仍然属于自己的 lease；被 TTL 抢占后绝不误删新持有者。
    if (current && current.token === entry.token) safeUnlink(entry.path)
  }

  private heartbeat(key: string, token: string): void {
    const entry = this.held.get(key)
    if (!entry || entry.token !== token) return
    const current = readLeaseFile(entry.path)
    if (!current || current.token !== token) {
      // 文件被删除/被抢占：停止心跳，下一次 release 不误删他人文件。
      if (entry.timer) clearInterval(entry.timer)
      return
    }
    const next: WorkspaceLeaseFile = { ...current, heartbeatAt: this.now() }
    try {
      writeJsonAtomic(entry.path, next)
    } catch {
      // 心跳写失败不改变已持有事实；下一次 tick 再试。
    }
  }

  private tryCreate(
    leasePath: string,
    key: string,
    options: { workspacePath?: string; envMarker?: string },
    token: string,
  ): boolean {
    const at = this.now()
    const file: WorkspaceLeaseFile = {
      version: 1,
      workspaceKey: key,
      workspacePath: options.workspacePath ?? key,
      pid: process.pid,
      envMarker: options.envMarker ?? '',
      host: this.host,
      heartbeatAt: at,
      ttlMs: this.ttlMs,
      acquiredAt: at,
      token,
    }
    try {
      fs.writeFileSync(leasePath, JSON.stringify(file), { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if (isEexist(error)) return false
      throw error
    }
  }

  private isStale(file: WorkspaceLeaseFile): boolean {
    return this.now() - file.heartbeatAt >= file.ttlMs
  }
}

function readLeaseFile(leasePath: string): WorkspaceLeaseFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(leasePath, 'utf-8')) as Partial<WorkspaceLeaseFile>
    if (parsed.version !== 1) return null
    if (typeof parsed.workspaceKey !== 'string') return null
    if (typeof parsed.pid !== 'number') return null
    if (typeof parsed.heartbeatAt !== 'number') return null
    if (typeof parsed.ttlMs !== 'number') return null
    if (typeof parsed.token !== 'string') return null
    return parsed as WorkspaceLeaseFile
  } catch {
    return null
  }
}

function writeJsonAtomic(target: string, value: unknown): void {
  const temp = `${target}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temp, target)
}

function safeUnlink(target: string): void {
  try {
    fs.unlinkSync(target)
  } catch {
    // 已不存在
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}

function isEexist(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST')
}
