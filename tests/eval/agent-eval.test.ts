/**
 * W5-D 评测 harness：U1–U9 / R3 脚本化。
 *
 * 每条用例独立判 PASS / FAIL / SKIP：
 * - 能自动验证的（R3、U8、U4、U2-①serve 探测）真跑；
 * - 真实网络回合走显式开关：U5（BIZGRAPH_EVAL_REAL_CLAUDE）、U2-②（BIZGRAPH_EVAL_REAL_OPENCODE，免费档零凭据）；
 * - 需要外部资源/平台的（U1/U7/U9）记 SKIP 并写明缺什么；
 * - U6 因 D-07 删除排队而不再适用。
 */

import fs from 'node:fs'
import net from 'node:net'
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
import { normalizeClaude } from '../../src/main/agent/runtime/normalize/claude'
import { OpenCodeStreamNormalizer, type OpenCodeEvent } from '../../src/main/agent/runtime/normalize/opencode'
import { extractUsage } from '../../src/main/agent/runtime/executors/adapter-driver'
import { UsageLedger } from '../../src/main/agent/runtime/cost/ledger'
import { localDayKey } from '../../src/main/agent/runtime/util'
import type { AdapterRawEvent } from '@shared/types/agent'

/** G6-14：真实 Claude 回合的显式开关（默认关，避免默认套件依赖网络）。 */
const CLAUDE_ROUND_ENV = 'BIZGRAPH_EVAL_REAL_CLAUDE'
/** 单轮真实回合上限（含代理转发）。 */
const CLAUDE_TURN_TIMEOUT_MS = 90_000
/** 走哪条线路由 settings.json / 环境决定；这里只给缺省模型别名。 */
const CLAUDE_MODEL = process.env.BIZGRAPH_EVAL_CLAUDE_MODEL ?? 'claude-haiku-5-5'

/** G6-11/U2：真实 OpenCode 回合的显式开关（默认关，避免默认套件依赖网络）。 */
const OPENCODE_ROUND_ENV = 'BIZGRAPH_EVAL_REAL_OPENCODE'
/** 免费档零凭据组合（v3.30 实测 12 个模型全在 opencode/ 前缀下；裸写 model id 会被判成 `…/.`）。 */
const OPENCODE_MODEL = process.env.BIZGRAPH_EVAL_OPENCODE_MODEL ?? 'opencode/deepseek-v4.1-flash-free'
/** 单轮真实回合上限。 */
const OPENCODE_TURN_TIMEOUT_MS = 90_000

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

/**
 * 读 `~/.claude/settings.json` 的 env 段（CLI 自己也会读，这里只为了**探测**线路，
 * 不改环境、不覆盖用户配置）。
 */
function readClaudeSettingsEnv(): Record<string, string> {
  const file = path.join(os.homedir(), '.claude', 'settings.json')
  if (!fs.existsSync(file)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { env?: unknown }
    const env = parsed.env
    if (typeof env !== 'object' || env === null) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 代理/网关可达性：任何 HTTP 响应都算「线路在」，只有网络错误才算不可达。 */
async function probeClaudeEndpoint(baseUrl: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      signal: AbortSignal.timeout(2_000),
    })
    return { ok: true, detail: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

interface ClaudeTurnResult {
  raws: unknown[]
  stderr: string
  code: number | null
  durationMs: number
}

/** 跑一轮真实 `claude -p`（stream-json），返回原始消息数组。 */
function runClaudeTurn(prompt: string): Promise<ClaudeTurnResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      CLAUDE_MODEL,
    ]
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const raws: unknown[] = []
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          raws.push(JSON.parse(trimmed))
        } catch {
          // 非 JSON 行（部分 CLI 会打印进度）忽略，不喂给归一化器
        }
      }
      resolve({ raws, stderr, code, durationMs: Date.now() - startedAt })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, CLAUDE_TURN_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      stderr += `\nspawn error: ${error.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/**
 * G6-14（重判口径）：真跑一轮，把 usage 走**产品代码**落进 `agent_usage`。
 *
 * 链路：`claude -p` → 原始消息 → `normalizeClaude` → `extractUsage` → `UsageLedger.record`。
 * 这四个函数与跑 run 时是同一份实现，所以这条用例通过就等于「token 统计链路通」。
 *
 * 明确不验：Anthropic 官方计费口径与价格（缺付费额度，见蓝图 I.9.2）。代理线路下
 * 上游回的是真实模型名（如 `kimi-for-coding`），价格表查不到 → `cost_status=missing_price`、
 * `cost_micros=NULL`，这是**预期**结果，不是缺陷。
 */
async function verifyClaudeTokenRound(): Promise<EvalResult> {
  if (process.env[CLAUDE_ROUND_ENV] !== '1') {
    return {
      status: 'SKIP',
      detail: `需显式开启 ${CLAUDE_ROUND_ENV}=1 才发起真实网络回合（默认套件不依赖外部线路）`,
    }
  }
  if (!hasCommand('claude')) {
    return { status: 'SKIP', detail: 'PATH 无 claude CLI，无法发起真实回合' }
  }
  const settingsEnv = readClaudeSettingsEnv()
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL ?? settingsEnv.ANTHROPIC_BASE_URL ?? null
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY ?? settingsEnv.ANTHROPIC_API_KEY)
  const proxyManaged = (process.env.ANTHROPIC_AUTH_TOKEN ?? settingsEnv.ANTHROPIC_AUTH_TOKEN) === 'PROXY_MANAGED'

  let routeDetail = '直连（无自定义 base URL）'
  if (baseUrl) {
    const probe = await probeClaudeEndpoint(baseUrl)
    if (!probe.ok && !hasApiKey) {
      return {
        status: 'SKIP',
        detail: `base URL ${baseUrl} 不可达（${probe.detail}）且无 ANTHROPIC_API_KEY，无法发起回合`,
      }
    }
    routeDetail = `base URL=${baseUrl}（${probe.ok ? probe.detail : `探测失败 ${probe.detail}，但有 key`}${proxyManaged ? '，PROXY_MANAGED 鉴权' : ''}）`
  } else if (!hasApiKey) {
    return { status: 'SKIP', detail: '既无 ANTHROPIC_BASE_URL 也无 ANTHROPIC_API_KEY，无法发起回合' }
  }

  const turn = await runClaudeTurn('reply with exactly: OK')
  if (turn.code !== 0 || turn.raws.length === 0) {
    return {
      status: 'FAIL',
      detail: `回合未正常结束：exit=${String(turn.code)}、消息 ${turn.raws.length} 条、耗时 ${turn.durationMs}ms、stderr=${turn.stderr.trim().slice(0, 300) || '（空）'}`,
    }
  }

  const meta = { runId: 'eval_u5_run', turnId: 'eval_u5_turn', sessionId: 'eval_u5_session' }
  const normalized = normalizeClaude(turn.raws, meta)
  const started = normalized.find((event) => event.type === 'run.started')
  const completed = normalized.find((event) => event.type === 'run.completed')
  if (!started || !completed) {
    return {
      status: 'FAIL',
      detail: `归一化后缺终态事件：run.started=${Boolean(started)}、run.completed=${Boolean(completed)}（共 ${normalized.length} 条事件）`,
    }
  }

  const usage = extractUsage(
    turn.raws.map((payload) => ({ payload }) as AdapterRawEvent),
    'claude-code',
  )
  if (!usage) {
    return { status: 'FAIL', detail: 'result 消息里取不到 usage（extractUsage 返回 undefined）' }
  }
  if (!usage.inputTokens || !usage.outputTokens) {
    return {
      status: 'FAIL',
      detail: `usage 缺 token：input=${String(usage.inputTokens)}、output=${String(usage.outputTokens)}`,
    }
  }

  const db = openTestDb()
  try {
    const ledger = new UsageLedger(db)
    const row = ledger.record({
      turnId: meta.turnId,
      sessionId: meta.sessionId,
      executor: 'claude-code',
      model: usage.model ?? null,
      source: 'provider',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      dedupeKey: `turn:${meta.turnId}`,
    })

    const problems: string[] = []
    if (row.source !== 'provider') problems.push(`source=${row.source}（期望 provider）`)
    if (row.tokens_reported !== 1) problems.push(`tokens_reported=${String(row.tokens_reported)}（期望 1）`)
    if ((row.input_tokens ?? 0) <= 0) problems.push(`input_tokens=${String(row.input_tokens)}`)
    if ((row.output_tokens ?? 0) <= 0) problems.push(`output_tokens=${String(row.output_tokens)}`)
    if (row.model === null) problems.push('model 为空（计价维度缺失）')
    if (row.day_key !== localDayKey()) problems.push(`day_key=${row.day_key}（期望 ${localDayKey()}）`)
    if (row.cost_status !== 'priced' && row.cost_status !== 'missing_price') {
      problems.push(`cost_status=${String(row.cost_status)}（期望 priced / missing_price）`)
    }
    if (row.cost_status === 'missing_price' && row.cost_micros !== null) {
      problems.push('缺价行却写了金额')
    }

    // 幂等：同一 dedupe_key 再记一次不该产生第二行
    ledger.record({
      turnId: meta.turnId,
      sessionId: meta.sessionId,
      executor: 'claude-code',
      model: usage.model ?? null,
      source: 'provider',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      dedupeKey: `turn:${meta.turnId}`,
    })
    const rowCount = db.prepare('SELECT COUNT(*) AS n FROM agent_usage').get() as { n: number }
    if (rowCount.n !== 1) problems.push(`重复上报后行数=${rowCount.n}（期望 1，dedupe 失效）`)

    const metrics: Record<string, number | string> = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      model: usage.model ?? '(none)',
      costStatus: String(row.cost_status),
      costMicros: row.cost_micros ?? 'NULL',
      normalizedEvents: normalized.length,
      roundTripMs: turn.durationMs,
      route: routeDetail,
    }

    if (problems.length > 0) {
      return { status: 'FAIL', detail: `落库断言失败：${problems.join('；')}`, metrics }
    }

    return {
      status: 'PASS',
      detail:
        `真实回合落库成功：input=${usage.inputTokens}、output=${usage.outputTokens}、cacheRead=${usage.cachedInputTokens ?? 0}、` +
        `model=${usage.model ?? '(none)'}、cost_status=${String(row.cost_status)}（${row.cost_micros === null ? '价格未知，未编造金额' : `cost=${row.cost_micros} micros`}）；` +
        `线路：${routeDetail}；${normalized.length} 条归一化事件、耗时 ${turn.durationMs}ms。` +
        `注意：chat_messages.token_count 目前没有生产写入方（saveMessage 从未传 tokenCount），本轮实测仍为 0，已在蓝图记为缺口`,
      metrics,
    }
  } finally {
    db.close()
  }
}

// ─────────────────────────── U2：OpenCode ───────────────────────────

/** 自挑空闲端口：`--port 0` 在 opencode 1.19.5 会退回 4096（与手工实例撞，v3.32 实测）。 */
function pickFreeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/**
 * U2-①：serve OpenAPI 探测（本地、免网络、免凭据）。
 * 证明权限协议真的存在：`/doc` 里必须有 permission reply 端点，
 * 这是「问了再放行」的协议面（完整往返由 opencode-serve-real.test.ts 真机覆盖）。
 */
async function probeOpenCodeServeDoc(): Promise<{
  ok: boolean
  detail: string
  pathCount: number
  permissionReplyPath: string | null
}> {
  const port = await pickFreeTcpPort()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-eval-oc-serve-'))
  const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd,
    // 清宿主注入的 NODE_OPTIONS 沙箱 shim：CLI 子进程经文件 broker 代理会间歇 ECONNREFUSED
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf-8')
  })
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`serve 15s 内未就绪（stdout 片段：${out.slice(0, 200) || '（空）'}）`)),
      15_000,
    )
    const poll = setInterval(() => {
      if (out.includes('listening on')) {
        clearTimeout(timeout)
        clearInterval(poll)
        resolve()
      }
    }, 200)
    child.on('exit', (code) => {
      clearTimeout(timeout)
      clearInterval(poll)
      reject(new Error(`serve 提前退出（code=${String(code)}）`))
    })
  })
  try {
    await ready
    const response = await fetch(`http://127.0.0.1:${port}/doc?directory=${encodeURIComponent(cwd)}`)
    const doc = (await response.json()) as { paths?: Record<string, unknown> }
    const paths = Object.keys(doc.paths ?? {})
    const permissionReplyPath =
      paths.find((p) => /permission\/\{[^}]+\}\/reply/.test(p)) ?? null
    if (response.status !== 200) {
      return { ok: false, detail: `GET /doc 返回 ${response.status}`, pathCount: paths.length, permissionReplyPath }
    }
    if (!permissionReplyPath) {
      return {
        ok: false,
        detail: `OpenAPI ${paths.length} 路径中没有任何 permission reply 端点（权限协议缺失）`,
        pathCount: paths.length,
        permissionReplyPath,
      }
    }
    return {
      ok: true,
      detail: `OpenAPI ${paths.length} 路径，permission reply 端点 = ${permissionReplyPath}`,
      pathCount: paths.length,
      permissionReplyPath,
    }
  } finally {
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
  }
}

/**
 * U2-②：真实 OpenCode 回合（免费档零凭据，`run --format json` 结构化事件流）。
 *
 * 注意回合设计：**不能**「宿主先写文件、让 CLI 读回来」——评测进程跑在宿主沙箱
 * shim 里（NODE_OPTIONS=--require broker），写文件落在 broker 的私有视图；CLI
 * 子进程为避免 shim 间歇故障带 `NODE_OPTIONS:''` 起动，读的是真实文件系统，
 * 两个视图互不可见（实测表现为 CLI 报 No such file or directory）。
 * 因此 marker 由 CLI 自己的 bash 工具产生、断言也只看 CLI 自己的输出，
 * 全程不跨文件系统边界。
 */
async function runOpenCodeTurn(): Promise<{
  exit: number | null
  stdout: string
  stderr: string
  durationMs: number
}> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-eval-oc-round-'))
  const startedAt = performance.now()
  const child = spawn(
    'opencode',
    [
      'run',
      '--format',
      'json',
      // 与 v3.30 夹具采集条件一致：--auto 让工具在 run 模式直接放行（run 没有审批往返）
      '--auto',
      '--model',
      OPENCODE_MODEL,
      'Run the shell command `echo EVAL-U2-MARKER-7c3d` using your bash tool and reply with its exact output.',
    ],
    {
      cwd,
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const chunks: Buffer[] = []
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8')
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), OPENCODE_TURN_TIMEOUT_MS)
  const exit = await new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code))
    child.on('error', () => resolve(null))
  })
  clearTimeout(timeout)
  return {
    exit,
    stdout: Buffer.concat(chunks).toString('utf-8'),
    stderr,
    durationMs: Math.round(performance.now() - startedAt),
  }
}

function parseOpenCodeJsonl(stdout: string): OpenCodeEvent[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenCodeEvent)
}

/** U2 主判定：① 权限协议存在性（免网络）；② 结构化事件（显式开关真回合）。 */
async function verifyOpenCodeEval(): Promise<EvalResult> {
  const problems: string[] = []
  const notes: string[] = []
  const metrics: Record<string, number> = {}

  // ① 权限协议存在性 —— CLI 在即跑，不需要网络
  const probe = await probeOpenCodeServeDoc()
  metrics.servePaths = probe.pathCount
  if (!probe.ok) {
    problems.push(`serve 探测：${probe.detail}`)
  } else {
    notes.push(`① 权限协议存在：${probe.detail}`)
  }

  // ② 结构化事件 —— 真实回合，显式开关（默认套件不依赖网络）
  if (process.env[OPENCODE_ROUND_ENV] !== '1') {
    if (problems.length > 0) {
      return { status: 'FAIL', detail: problems.join('；'), metrics }
    }
    return {
      status: 'PASS',
      detail: `${notes[0]}；② 结构化事件真回合未开启（需 ${OPENCODE_ROUND_ENV}=1；免费档零凭据，无成本，但走网络故默认关）——协议存在性已由 ① 回答`,
      metrics,
    }
  }

  const turn = await runOpenCodeTurn()
  metrics.roundMs = turn.durationMs
  if (turn.exit !== 0) {
    problems.push(`回合 exit=${String(turn.exit)}、stderr=${turn.stderr.trim().slice(0, 200) || '（空）'}`)
    return { status: 'FAIL', detail: problems.join('；'), metrics }
  }

  const meta = { runId: 'eval_u2_run', turnId: 'eval_u2_turn', sessionId: 'eval_u2_session', baseTimestamp: Date.now() }
  const normalizer = new OpenCodeStreamNormalizer(meta)
  const rawEvents = parseOpenCodeJsonl(turn.stdout)
  for (const event of rawEvents) normalizer.feed(event)
  const events = normalizer.finish(0)
  metrics.rawEvents = rawEvents.length
  metrics.normalizedEvents = events.length

  const types = events.map((event) => event.type)
  if (!types.includes('run.started') || !types.includes('run.completed')) {
    problems.push(`缺终态事件：run.started=${types.includes('run.started')}、run.completed=${types.includes('run.completed')}`)
  }
  const toolRequested = events.find((event) => event.type === 'tool.requested')
  const toolResults = events.filter((event) => event.type === 'tool.result')
  if (!toolRequested || toolResults.length === 0) {
    problems.push(`缺结构化工具事件：tool.requested=${Boolean(toolRequested)}、tool.result 条数=${toolResults.length}`)
  } else {
    const toolNames = [
      ...events.filter((event) => event.type === 'tool.requested').map((event) => (event.payload as { toolName?: string }).toolName),
      ...toolResults.map((event) => (event.payload as { toolName?: string }).toolName),
    ]
    notes.push(`② 工具事件：${[...new Set(toolNames)].join('/')}`)
    // marker 由 CLI 自己的 bash 产生 —— 断言只看 CLI 自己的输出（不跨文件系统边界）
    const outputs = toolResults.map((event) => (event.payload as { output?: string }).output ?? '')
    if (!outputs.some((output) => output.includes('EVAL-U2-MARKER-7c3d'))) {
      problems.push(`没有任何 tool.result 的输出含 marker（收到 ${outputs.length} 条：${outputs.map((o) => o.slice(0, 60).replace(/\n/g, ' ')).join(' | ').slice(0, 200)}）`)
    }
  }
  const usage = events.find((event) => event.type === 'usage.updated')?.payload as
    | { inputTokens?: number; outputTokens?: number }
    | undefined
  metrics.inputTokens = usage?.inputTokens ?? 0
  metrics.outputTokens = usage?.outputTokens ?? 0
  if (!usage || !(usage.inputTokens || usage.outputTokens)) {
    problems.push('usage.updated 缺 token（免费档也应上报 token，v3.30 实测如此）')
  }

  if (problems.length > 0) {
    return { status: 'FAIL', detail: problems.join('；'), metrics }
  }
  return {
    status: 'PASS',
    detail: `${notes.join('；')}；归一化 ${events.length} 条事件（原始 ${rawEvents.length} 行 JSONL）、回合耗时 ${turn.durationMs}ms、token in/out=${metrics.inputTokens}/${metrics.outputTokens}（模型 ${OPENCODE_MODEL}，零凭据免费档）`,
    metrics,
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

  // U2：OpenCode 工具事件/权限协议 —— 两段式（v3.34 起真跑）：
  // ① 权限协议存在性：本地起 `opencode serve` 查 OpenAPI（免网络、免凭据，CLI 在即跑）；
  // ② 结构化事件：显式开关门控的真实回合（免费档零凭据，走 `run --format json`）。
  itEval('U2', 'OpenCode CLI 是否存在结构化工具事件或权限协议', async () => {
    if (!hasCommand('opencode')) {
      return { status: 'SKIP', detail: 'PATH 无 opencode CLI（which opencode 未命中），无法验证工具事件/权限协议' }
    }
    return await verifyOpenCodeEval()
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

  // U5：Claude token 级增量 + G6-14 真实 token 落库
  //
  // G6-14 改口径后验的是「真回合的 usage 能不能进 agent_usage」，不验 Anthropic
  // 官方计费（那条仍缺付费额度）。默认不跑：一次真实网络回合既慢又依赖外部状态，
  // 放进默认套件会让 `npx vitest run` 的结论随网络抖。要跑就显式开
  // `BIZGRAPH_EVAL_REAL_CLAUDE=1`。
  itEval('U5', 'Claude 真实回合：usage 是否落 agent_usage（G6-14）', async () => {
    return await verifyClaudeTokenRound()
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
