/**
 * W5-D 评测 harness：U1–U9 / R3 脚本化。
 *
 * 每条用例独立判 PASS / FAIL / SKIP：
 * - 能自动验证的（R3、U8、U4）真跑；
 * - 需要外部资源/平台的（U1/U2/U5/U7/U9）记 SKIP 并写明缺什么；
 * - U6 因 D-07 删除排队而不再适用。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterAll, describe } from 'vitest'
import { AgentRepository } from '../../src/main/agent/runtime/db/repository'
import { EventBatchWriter } from '../../src/main/agent/runtime/event-batch-writer'
import { openTestDb } from '../../src/main/agent/runtime/__tests__/helpers/test-db'
import {
  attestProcIdentity,
  captureHiResStart,
  listProcesses,
  proveOwnership,
  type ProcIdentity,
} from '../../src/main/agent/runtime/process/reaper'
import { itEval, writeEvalReport, type EvalResult } from './harness'
import { canReadProcessTable } from '../../src/main/__tests__/helpers/host-probe'

const requireRoot = createRequire(import.meta.url)

const R3_EVENT_COUNT = 10_000
/** 主进程单次阻塞上限（ms）：超过即视为可感知卡顿。 */
const R3_MAX_LAG_MS = 500
/** 10k 事件回放总时长上限（ms）。 */
const R3_MAX_TOTAL_MS = 20_000

function hasCommand(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function findPackagedApp(): string | null {
  const root = path.resolve('release')
  if (!fs.existsSync(root)) return null
  const candidates: string[] = []
  for (const dir of fs.readdirSync(root)) {
    const app = path.join(root, dir, 'BizGraph.app')
    if (fs.existsSync(app)) candidates.push(app)
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return candidates[0] ?? null
}

function findFile(root: string, predicate: (file: string) => boolean, depth = 0): string | null {
  if (depth > 8 || !fs.existsSync(root)) return null
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && predicate(full)) return full
    if (entry.isDirectory()) {
      const nested = findFile(full, predicate, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

function sqliteLoadProblem(): string | null {
  try {
    const Ctor = requireRoot('better-sqlite3') as new (file: string) => { close(): void }
    new Ctor(':memory:').close()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

let r3Result: Promise<EvalResult> | null = null

/** U3 与 R3 是同一测量（10k 事件回放），只跑一次。 */
function measureHighVolume(): Promise<EvalResult> {
  if (!r3Result) r3Result = runHighVolume()
  return r3Result
}

async function runHighVolume(): Promise<EvalResult> {
  // 先确认 ABI：Electron ABI 下 root better-sqlite3 在 Node 里加载会失败，
  // 这属于环境问题，必须 SKIP 而不是当作性能 FAIL。
  const abiProblem = sqliteLoadProblem()
  if (abiProblem) {
    return {
      status: 'SKIP',
      detail: `root better-sqlite3 无法在 Node ${process.versions.node}（NODE_MODULE_VERSION=${process.versions.modules}）加载，先 npm rebuild better-sqlite3 再测：${abiProblem.split('\n')[0]}`,
    }
  }

  const dbFile = path.join(os.tmpdir(), `bizgraph-eval-r3-${process.pid}-${Date.now()}.db`)
  const db = openTestDb(true, dbFile)
  // 与生产一致：WAL，避免用 :memory: 低估落盘成本。
  db.pragma('journal_mode = WAL')
  const repo = new AgentRepository(db)
  const latencies: number[] = []
  let maxLag = 0

  try {
    repo.insertSession({ id: 'eval-r3', executor: 'codex', status: 'active' })
    const run = repo.insertRun({ threadId: 'eval-r3-thread', nodeId: 'eval-node', graphId: 'eval-graph', executor: 'codex' })
    const turn = repo.insertTurn({
      runId: run.id,
      sessionId: 'eval-r3',
      nodeId: 'eval-node',
      graphId: 'eval-graph',
      resumeMode: 'native',
      idempotencyKey: 'eval-r3',
      input: {},
    })

    const writer = new EventBatchWriter({ repo, flushIntervalMs: 50, maxBatchEvents: 200 })
    let lastTick = performance.now()
    const ticker = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - lastTick - 10)
      lastTick = now
    }, 10)

    const startedAt = performance.now()
    try {
      for (let i = 1; i <= R3_EVENT_COUNT; i += 1) {
        const writeStart = performance.now()
        writer.write([
          {
            eventId: `eval-r3:${i}`,
            runId: run.id,
            turnId: turn.id,
            seq: i,
            type: 'message.delta',
            source: 'kernel',
            fidelity: 'token',
            payloadVersion: 1,
            payload: { i, text: 'x' },
            timestamp: Date.now(),
          },
        ])
        latencies.push(performance.now() - writeStart)
        // 每满一批让出事件循环，ticker 才能量到单批写入的阻塞。
        if (i % 200 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
    } finally {
      writer.shutdown()
      clearInterval(ticker)
    }
    const totalMs = performance.now() - startedAt

    const events = repo.listEvents(run.id)
    const seqOk = events.length === R3_EVENT_COUNT && events.every((event, index) => event.seq === index + 1)
    if (!seqOk) {
      return {
        status: 'FAIL',
        detail: `回放落库不完整：events=${events.length}/${R3_EVENT_COUNT}，seq 连续=${seqOk}`,
        metrics: { events: events.length, maxLagMs: Math.round(maxLag), totalMs: Math.round(totalMs) },
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
    const metrics = {
      events: events.length,
      totalMs: Math.round(totalMs),
      maxLagMs: Math.round(maxLag),
      p95WriteMs: Number(p95.toFixed(2)),
      maxWriteMs: Number(Math.max(...latencies).toFixed(2)),
      nodeModuleVersion: process.versions.modules,
    }

    if (maxLag > R3_MAX_LAG_MS || totalMs > R3_MAX_TOTAL_MS) {
      return {
        status: 'FAIL',
        detail: `超过阈值：maxLag=${metrics.maxLagMs}ms（上限 ${R3_MAX_LAG_MS}）/ total=${metrics.totalMs}ms（上限 ${R3_MAX_TOTAL_MS}）`,
        metrics,
      }
    }

    return {
      status: 'PASS',
      detail: `${R3_EVENT_COUNT} 条 message.delta 全部落库、seq 连续（WAL 文件库，Node ABI ${process.versions.modules}）；maxLag=${metrics.maxLagMs}ms、p95 写入=${metrics.p95WriteMs}ms、总时长=${metrics.totalMs}ms`,
      metrics,
    }
  } finally {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${dbFile}${suffix}`, { force: true })
    }
  }
}

describe('W5-D agent eval harness', () => {
  // U1：Codex 官方 provider 的事件差异
  itEval('U1', 'Codex 官方 provider 是否出现 item.updated / reasoning', () => {
    const hasCli = hasCommand('codex')
    const hasKey = Boolean(process.env.OPENAI_API_KEY)
    if (hasCli && hasKey) {
      return {
        status: 'SKIP',
        detail: '具备 codex CLI 与 OPENAI_API_KEY，但真实官方会话录制需单独授权（避免付费调用），本轮未执行',
      }
    }
    return {
      status: 'SKIP',
      detail: `缺官方 provider 条件：PATH codex CLI=${hasCli ? '有' : '无'}，OPENAI_API_KEY=${hasKey ? '有' : '无'}；不把第三方 provider 的 item.updated=0 写成结论`,
    }
  })

  // U2：OpenCode 工具事件/权限协议
  itEval('U2', 'OpenCode CLI 是否存在结构化工具事件或权限协议', () => {
    if (!hasCommand('opencode')) {
      return { status: 'SKIP', detail: 'PATH 无 opencode CLI（which opencode 未命中），无法验证工具事件/权限协议' }
    }
    return {
      status: 'SKIP',
      detail: 'opencode CLI 已安装，但结构化事件需要真实回合与权限交互录制，本轮未执行',
    }
  })

  // U3：高事件量主进程阻塞（与 R3 同一测量）
  itEval('U3', 'better-sqlite3 高事件量下主进程阻塞（10k 事件回放）', async () => {
    const result = await measureHighVolume()
    return { ...result, detail: `[U3/R3 同一测量] ${result.detail}` }
  })

  // U4：打包后 SDK/CLI 二进制可用性
  itEval('U4', '打包后 SDK/CLI 二进制可用性（app.asar + unpacked）', () => {
    const app = findPackagedApp()
    if (!app) {
      return {
        status: 'SKIP',
        detail: '脚本就位、待真机：release/ 下无 BizGraph.app，先执行 electron-builder --mac dir（或 npm run build:mac）',
      }
    }

    const resources = path.join(app, 'Contents', 'Resources')
    const asar = path.join(resources, 'app.asar')
    if (!fs.existsSync(asar)) {
      return { status: 'FAIL', detail: `产物缺 app.asar：${asar}` }
    }

    const asarList = execFileSync(path.resolve('node_modules/.bin/asar'), ['list', asar], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
    const hasClaudeSdk = asarList.includes('/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')
    const hasCodexSdk = asarList.includes('/node_modules/@openai/codex-sdk/dist/index.js')

    const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules')
    const claudeBin = findFile(path.join(unpacked, '@anthropic-ai'), (file) => path.basename(file) === 'claude')
    const codexBin = findFile(path.join(unpacked, '@openai'), (file) => path.basename(file) === 'codex')

    const problems: string[] = []
    if (!hasClaudeSdk) problems.push('asar 缺 claude-agent-sdk/sdk.mjs')
    if (!hasCodexSdk) problems.push('asar 缺 codex-sdk/dist/index.js')
    if (!claudeBin) problems.push('asar.unpacked 缺 claude 二进制')
    if (!codexBin) problems.push('asar.unpacked 缺 codex 二进制')

    const versions: Record<string, string> = {}
    for (const [name, bin] of [['claude', claudeBin], ['codex', codexBin]] as const) {
      if (!bin) continue
      try {
        versions[name] = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
      } catch (error) {
        problems.push(`${name} --version 执行失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (problems.length > 0) {
      return { status: 'FAIL', detail: problems.join('；'), metrics: versions }
    }
    return {
      status: 'PASS',
      detail: `claude=${versions.claude}；codex=${versions.codex}；asar 内 SDK 入口齐备（${path.basename(app)}）`,
      metrics: versions,
    }
  })

  // U5：Claude token 级增量
  itEval('U5', 'Claude includePartialMessages 是否稳定给出 token 级增量', () => {
    return {
      status: 'SKIP',
      detail: `需真实 Anthropic 凭据与成本授权；claude CLI=${hasCommand('claude') ? '有' : '无'}，本轮不发起付费回合（G6-14 未验证）`,
    }
  })

  // U6：排队晋升事务（已随 RequestQueue 删除而失效）
  itEval('U6', '排队 queueDepth=1 的晋升事务并发安全', () => {
    return {
      status: 'SKIP',
      detail: '不适用：D-07 已删除 RequestQueue（80075e7），queueDepth 晋升事务不存在',
    }
  })

  // U7：非 macOS / 打包环境的进程组回收
  itEval('U7', '进程组回收在非 macOS / 打包环境的行为', () => {
    if (process.platform === 'darwin') {
      return {
        status: 'SKIP',
        detail: '当前平台 darwin；需 Windows 或打包产物内跑取消用例，本轮未执行',
      }
    }
    return { status: 'SKIP', detail: `当前平台 ${process.platform}，但打包产物内取消用例未接入，本轮未执行` }
  })

  // U8：跨重启「可证明归属」证据
  itEval('U8', '跨重启回收的归属证据（pid + 启动时间 + 命令行）能否稳定取到', async () => {
    // 宿主 `ps` 不可读（受限 CI / 容器 EPERM）时这是「缺条件」，不是「取不到证据」的结论。
    if (!canReadProcessTable()) {
      return {
        status: 'SKIP',
        detail: '宿主 `ps` 不可读（EPERM），无法取 pid/pgid/startedAt/command；属宿主限制，不下结论',
      }
    }
    const marker = `bizgraph-eval-${process.pid}-${Date.now()}`
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', marker], { stdio: 'ignore' })
    try {
      if (!child.pid) return { status: 'FAIL', detail: '子进程未拿到 pid' }

      let current = listProcesses().find((proc) => proc.pid === child.pid)
      for (let attempt = 0; attempt < 50 && !current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        current = listProcesses().find((proc) => proc.pid === child.pid)
      }
      if (!current) {
        return { status: 'FAIL', detail: `2.5s 内 ps 未取到 pid=${child.pid} 的命令行/启动时间` }
      }

      const expected: ProcIdentity = {
        pid: current.pid,
        pgid: current.pgid,
        startedAt: current.startedAt,
        command: current.command,
        startedAtHiRes: captureHiResStart(current.pid),
      }
      expected.attestation = attestProcIdentity(expected)
      const proof = proveOwnership(expected, current, marker, captureHiResStart(current.pid))

      if (!proof.proved) {
        return {
          status: 'FAIL',
          detail: `归属证明未通过：reason=${proof.reason}，matched=${proof.matched.join('+') || '无'}`,
        }
      }
      return {
        status: 'PASS',
        detail: `pid=${current.pid}、startedAt=${current.startedAt}、command 可取（${current.command.length} 字符）；matched=${proof.matched.join('+')}；范围=macOS 非打包`,
      }
    } finally {
      child.kill('SIGKILL')
    }
  })

  // U9：真实第二 uid 攻击
  itEval('U9', '真实第二 uid 验证 0600 密钥不可读 / 0700 目录不可写', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (uid !== 0) {
      return {
        status: 'SKIP',
        detail: `需 root 建第二 uid 测试用户；当前 uid=${uid ?? 'n/a'}，只保留权限位与同 uid 断言`,
      }
    }
    return { status: 'SKIP', detail: '具备 root，但第二 uid 攻击用例未接入本轮执行' }
  })

  // R3：G6-12，与 U3 同一测量
  itEval('R3', 'better-sqlite3 高事件量阻塞（G6-12，10k 事件回放）', async () => {
    const result = await measureHighVolume()
    return { ...result, detail: `[R3/U3 同一测量] ${result.detail}` }
  })
})

afterAll(() => {
  writeEvalReport()
})
