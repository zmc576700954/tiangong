/**
 * 真实进程树工具：spawn 探针 → 等待 ready → 从 JSONL 日志取 pid → 清理。
 *
 * 只依赖 node 内置模块与被测代码的公开导出 `listProcesses`（读取 ps 身份）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listProcesses, type ProcIdentity } from '../../../src/main/agent/runtime/process/reaper'
import { alive, rawKill } from './kill-tap'

const PROBE_PATH = fileURLToPath(new URL('./probes/probe.mjs', import.meta.url))
const SUPERVISOR_PROBE_PATH = fileURLToPath(
  new URL('./probes/supervisor-probe.mjs', import.meta.url),
)

/** 创建本次运行专用的临时注册目录（不污染共享 /tmp/bizgraph-agent-proc）。 */
export function makeTempRegistryDir(): string {
  return mkdtempSync(join(tmpdir(), 'bizgraph-reaper-isolation-registry-'))
}

/**
 * 启动「监督 shim + 自有进程组 CLI」：shim 会把 CLI 的 ps 身份写入 registryDir。
 * 返回 shim 宿主进程，CLI pid 从注册文件读取。
 */
export function spawnRegistrySupervisor(
  marker: string,
  registryDir: string,
): ChildProcess {
  const child = spawn(process.execPath, [SUPERVISOR_PROBE_PATH, marker, registryDir, PROBE_PATH], {
    stdio: 'ignore',
    detached: true,
  })
  if (!child.pid) throw new Error('failed to spawn registry supervisor')
  return child
}

const RUN_DIR = join(tmpdir(), `bizgraph-reaper-isolation-${process.pid}-${Date.now()}`)

export interface LogEntry {
  type: string
  pid: number
  label: string
  at: number
  [key: string]: unknown
}

export interface ProbeTree {
  label: string
  logPath: string
  ownerPid: number
  owner: ChildProcess
  entries: () => LogEntry[]
  pidOf: (label: string) => number | undefined
  pids: () => number[]
}

export type ChildrenMode = 'none' | 'long' | 'long+short'

export interface SpawnOptions {
  children?: ChildrenMode
  /** true → 新进程组（setsid），用于验证「组可隔离」；false → 与测试进程同组（复刻生产 spawn） */
  detached?: boolean
  extraArgs?: string[]
  env?: Record<string, string>
}

export function readEntries(logPath: string): LogEntry[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogEntry]
      } catch {
        return []
      }
    })
}

export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await waitMs(20)
  }
  throw new Error(`waitFor timeout: ${label}`)
}

/** spawn 一个真实探针进程（可带真实子孙）并等待其 ready。 */
export async function spawnProbe(label: string, options: SpawnOptions = {}): Promise<ProbeTree> {
  const childrenMode = options.children ?? 'none'
  const detached = options.detached ?? true
  mkdirSync(RUN_DIR, { recursive: true })
  const logPath = join(RUN_DIR, `${label.replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}.jsonl`)
  writeFileSync(logPath, '')

  const child = spawn(
    process.execPath,
    [PROBE_PATH, childrenMode, ...(options.extraArgs ?? [])],
    {
      stdio: 'ignore',
      detached,
      env: {
        ...process.env,
        PROBE_LOG: logPath,
        PROBE_LABEL: label,
        ...(options.env ?? {}),
      },
    },
  )

  const ownerPid = child.pid
  if (!ownerPid) throw new Error(`spawn failed for ${label}`)

  const expectedLabels = [label]
  if (childrenMode === 'long' || childrenMode === 'long+short') expectedLabels.push(`${label}.long`)
  if (childrenMode === 'long+short') expectedLabels.push(`${label}.short`)

  await waitFor(
    () => {
      const ready = new Set(
        readEntries(logPath)
          .filter((entry) => entry.type === 'ready')
          .map((entry) => entry.label),
      )
      return expectedLabels.every((expected) => ready.has(expected))
    },
    8000,
    `${label} ready`,
  )

  const tree: ProbeTree = {
    label,
    logPath,
    ownerPid,
    owner: child,
    entries: () => readEntries(logPath),
    pidOf: (target) =>
      readEntries(logPath).find((entry) => entry.type === 'ready' && entry.label === target)?.pid,
    pids: () => {
      const pids = new Set<number>()
      for (const entry of readEntries(logPath)) {
        if (entry.type === 'ready') pids.add(entry.pid)
        if (entry.type === 'child-spawn' && typeof entry.childPid === 'number') {
          pids.add(entry.childPid)
        }
      }
      return [...pids]
    },
  }
  return tree
}

/** 从 ps 抓取进程身份（pid/pgid/command/startedAt），供归属证明使用。 */
export function identityOf(pid: number): ProcIdentity | undefined {
  const proc = listProcesses().find((item) => item.pid === pid)
  if (!proc) return undefined
  return {
    pid: proc.pid,
    pgid: proc.pgid,
    command: proc.command,
    startedAt: proc.startedAt,
  }
}

export async function waitDead(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await waitMs(25)
  }
  return false
}

/** 清理测试进程树：绕过 tap，用 SIGKILL 收尾，不计入契约统计。 */
export async function killTrees(...trees: ProbeTree[]): Promise<void> {
  const pids = new Set<number>()
  for (const tree of trees) {
    for (const pid of tree.pids()) pids.add(pid)
    pids.add(tree.ownerPid)
  }
  for (const pid of pids) rawKill(pid, 'SIGKILL')
  await waitMs(120)
  // 第二轮兜底：探针可能在被杀前刚 spawn 出新的后代
  for (const tree of trees) {
    for (const entry of tree.entries()) {
      if (entry.type === 'ready' || entry.type === 'child-spawn') {
        const pid = entry.type === 'ready' ? entry.pid : Number(entry.childPid)
        if (Number.isFinite(pid)) rawKill(pid, 'SIGKILL')
      }
    }
  }
  await waitMs(80)
}

/** 记录测试台原始证据（供 README 引用），按实现分文件。 */
const evidenceDirs = new Set<string>()

export function recordEvidence(clause: string, data: Record<string, unknown>): void {
  try {
    const dir = fileURLToPath(new URL('../.artifacts/', import.meta.url))
    mkdirSync(dir, { recursive: true })
    const impl = process.env.REAPER_IMPL ?? 'current'
    const fileName = join(
      dir,
      `evidence-${impl.replace(/[^a-zA-Z0-9-]/g, '_')}-${process.pid}.jsonl`,
    )
    if (!evidenceDirs.has(fileName)) {
      writeFileSync(fileName, '')
      evidenceDirs.add(fileName)
    }
    appendFileSync(
      fileName,
      `${JSON.stringify({ clause, impl, at: new Date().toISOString(), ...data })}\n`,
    )
  } catch {
    // 证据落盘失败不影响契约判定
  }
}
