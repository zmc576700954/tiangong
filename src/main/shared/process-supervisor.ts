/**
 * D5 恢复承诺修复：受控 spawn + 自有进程组 + 进程自注册。
 *
 * 背景：`@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` 不暴露 CLI 子进程 PID，
 * 且 macOS 的 `ps` 读不到环境变量，无法靠 env marker 跨重启认领进程。
 *
 * 方案 A（受控 spawn / 监督进程）：
 * - Claude：通过 SDK 的 `spawnClaudeCodeProcess` 钩子由**我们** spawn，`detached: true`
 *   创建独立进程组（pgid = 子进程 pid），PID/PGID 当场可知。
 * - Codex：SDK 只接受 `codexPathOverride`，因此注入一个自有 shim。shim 以
 *   `detached: true` 拉起真实 CLI，成为进程组组长，并把 `pid/pgid/startedAt/cmd`
 *   写进**进程自注册文件**。该文件由我们启动的进程自己写，marker 只存在于本轮 env，
 *   属于真实归属证据，而非启发式推断。
 *
 * 注意：这里不读取 `ps` 的 env（macOS 不可见）；注册文件 + 落库后的
 * startedAt/command 才是跨重启的认领依据。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TURN_MARKER_ENV = 'BIZGRAPH_TURN_ID'
export const PROC_REGISTRY_DIR_ENV = 'BIZGRAPH_PROC_REGISTRY_DIR'
export const REAL_CODEX_ENV = 'BIZGRAPH_REAL_CODEX'
export const CODEX_SUPERVISOR_FILE = 'codex-supervisor.cjs'
/** 监督 shim 的签名密钥（只经 env 注入，macOS `ps` 不可见）。 */
export const REGISTRY_SECRET_ENV = 'BIZGRAPH_REGISTRY_SECRET'
/** 每次 spawn 的随机 nonce，同时写入 shim env 与注册记录，绑定「记录 ↔ 本次运行」。 */
export const SUPERVISOR_NONCE_ENV = 'BIZGRAPH_SUPERVISOR_NONCE'

export interface ProcRegistryRecord {
  marker: string
  /** 真实 CLI 进程（进程组组长）。 */
  pid: number
  pgid: number
  /** `ps -o lstart=` 归一化后的格式：`Nov 4 11:56:10 2026`。 */
  startedAt: string
  /** Linux `/proc/<pid>/stat` starttime ticks；其他平台为空（不允许单独凑项）。 */
  startedAtHiRes?: string
  command: string
  /** shim 自身 pid，仅用于排障。 */
  shimPid?: number
  createdAt: number
  /** 本次 spawn 的随机 nonce（同时经 env 注入 shim）。 */
  nonce?: string
  /** HMAC-SHA256(installSecret, canonical record)；无签名 = 不可信。 */
  sig?: string
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

/** 不同用户必须使用不同目录；目录名带 uid，避免跨用户共享。 */
export function getProcRegistryDir(): string {
  const override = process.env[PROC_REGISTRY_DIR_ENV]
  if (override) return override
  const uid = currentUid()
  return path.join(os.tmpdir(), uid === undefined ? 'bizgraph-agent-proc' : `bizgraph-agent-proc-${uid}`)
}

/**
 * 确保注册目录属主独占（0700）。
 * - 新建时强制 0700；
 * - 已存在时校验「不是 symlink、属主是当前用户」；
 * - 权限过宽（group/other 有任何位）时只允许属主本人收紧到 0700，收紧失败则拒绝；
 * - 属主不符或 symlink 一律抛错，绝不沿用（C13）。
 */
export function ensureRegistryDir(dir = getProcRegistryDir()): string {
  const uid = currentUid()
  let stat: fs.Stats | undefined
  try {
    stat = fs.lstatSync(dir)
  } catch {
    stat = undefined
  }
  if (!stat) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    stat = fs.lstatSync(dir)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`registry dir is not a real directory: ${dir}`)
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`registry dir owner is not the current user: ${dir}`)
  }
  if ((stat.mode & 0o077) !== 0) {
    if (uid !== undefined && fs.lstatSync(dir).uid !== uid) {
      throw new Error(`refusing pre-owned registry dir: ${dir}`)
    }
    try {
      fs.chmodSync(dir, 0o700)
    } catch (error) {
      throw new Error(`cannot tighten registry dir permissions: ${dir}: ${String(error)}`)
    }
    const after = fs.lstatSync(dir)
    if ((after.mode & 0o077) !== 0) {
      throw new Error(`registry dir is not owner-exclusive: ${dir}`)
    }
  }
  return dir
}

function lstatIfExists(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 原子写文件且**不跟随 symlink**（C13b）：
 * - 目标已存在 → 只允许「普通文件 + 属主当前用户 + 权限不宽于 0600/0700 +
 *   内容与期望完全一致」的幂等复用，否则拒绝覆盖；
 * - 新建走同目录随机临时名 + `O_CREAT|O_EXCL|O_NOFOLLOW`，写后用 `fchmod`；
 * - `rename` 前再次 `lstat` 校验临时文件与目标，目标被并发创建则拒绝。
 */
function writeFileNoFollow(
  target: string,
  data: string,
  mode: 0o600 | 0o700,
  options: { allowExistingIdentical?: boolean } = {},
): void {
  let existing = lstatIfExists(target)
  if (existing?.isSymbolicLink()) {
    // C13b：绝不顺着链接写。只删除链接本身（不影响其目标文件），
    // 随后用原子临时文件重建 shim；受害者内容保持原样。
    fs.unlinkSync(target)
    existing = undefined
  }
  if (existing) {
    if (!existing.isFile()) {
      throw new Error(`refusing non-regular shim target: ${target}`)
    }
    const uid = currentUid()
    if (uid !== undefined && existing.uid !== uid) {
      throw new Error(`refusing shim target owned by another user: ${target}`)
    }
    if ((existing.mode & 0o077) !== 0) {
      throw new Error(`refusing group/other-accessible shim target: ${target}`)
    }
    if (options.allowExistingIdentical) {
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
          throw new Error(`refusing unsafe shim target: ${target}`)
        }
        if (fs.readFileSync(fd, 'utf-8') === data) return
      } finally {
        fs.closeSync(fd)
      }
    }
    // 已存在但内容不同/不可复用：拒绝覆盖，避免顺着预置文件写入受害者路径。
    throw new Error(`refusing to overwrite existing file: ${target}`)
  }

  const dir = path.dirname(target)
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  const flags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW ?? 0)
  let fd: number | undefined
  try {
    fd = fs.openSync(tmp, flags, mode)
    fs.writeFileSync(fd, data, 'utf-8')
    fs.fchmodSync(fd, mode)
    fs.closeSync(fd)
    fd = undefined

    const tmpStat = fs.lstatSync(tmp)
    if (tmpStat.isSymbolicLink() || !tmpStat.isFile()) {
      throw new Error(`refusing non-regular temporary file: ${tmp}`)
    }
    const uid = currentUid()
    if (uid !== undefined && tmpStat.uid !== uid) {
      throw new Error(`refusing temporary file owned by another user: ${tmp}`)
    }
    if ((tmpStat.mode & 0o077) !== 0) {
      throw new Error(`temporary file is not owner-exclusive: ${tmp}`)
    }
    // rename 前再校验目标，堵住「校验后、rename 前」被抢占的窗口。
    if (lstatIfExists(target)) {
      throw new Error(`refusing to overwrite file created concurrently: ${target}`)
    }
    fs.renameSync(tmp, target)
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // 已关闭
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 未创建/已清理
    }
    throw error
  }
}

function installSecretPath(): string {
  const uid = currentUid()
  return path.join(
    os.tmpdir(),
    uid === undefined ? 'bizgraph-agent-secret' : `bizgraph-agent-secret-${uid}`,
  )
}

/**
 * 安装级签名密钥：0600、属主当前用户。首次使用时原子创建；
 * 已存在但权限过宽或属主不符 → 拒绝（不复用）。
 */
export function getRegistrySecret(): string {
  const fromEnv = process.env[REGISTRY_SECRET_ENV]
  if (fromEnv) return fromEnv
  const file = installSecretPath()
  const uid = currentUid()
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error(`unsafe registry secret file: ${file}`)
    }
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`registry secret owner mismatch: ${file}`)
    }
    const value = fs.readFileSync(file, 'utf-8').trim()
    if (value) return value
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('unsafe')) throw error
    if (error instanceof Error && error.message.startsWith('registry secret')) throw error
    // 文件不存在 → 创建
  }
  const secret = crypto.randomBytes(32).toString('hex')
  try {
    writeFileNoFollow(file, secret, 0o600)
    return secret
  } catch (error) {
    // 并发首次创建：另一个进程可能刚写好合法密钥，重读一次即可。
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isSymbolicLink() && (stat.mode & 0o077) === 0) {
        const value = fs.readFileSync(file, 'utf-8').trim()
        if (value) return value
      }
    } catch {
      // 忽略，抛原始错误
    }
    throw error
  }
}

function canonicalJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort()
  return keys.map((key) => `${key}=${String(value[key] ?? '')}`).join('\n')
}

/** 注册记录的规范化串（参与 HMAC，任何字段被改动都会导致验签失败）。 */
export function canonicalRegistryRecord(
  record: Omit<ProcRegistryRecord, 'sig'>,
): string {
  return canonicalJson({
    marker: record.marker,
    pid: record.pid,
    pgid: record.pgid,
    startedAt: record.startedAt,
    startedAtHiRes: record.startedAtHiRes,
    command: record.command,
    shimPid: record.shimPid,
    createdAt: record.createdAt,
    nonce: record.nonce,
  })
}

export function signProcRegistryRecord(
  record: Omit<ProcRegistryRecord, 'sig'>,
  secret = getRegistrySecret(),
): string {
  return crypto.createHmac('sha256', secret).update(canonicalRegistryRecord(record)).digest('hex')
}

/** 校验记录签名（nonce 必须存在且参与签名）。 */
export function verifyProcRegistryRecord(
  record: ProcRegistryRecord | undefined,
  secret = getRegistrySecret(),
): boolean {
  if (!record || typeof record.nonce !== 'string' || record.nonce.length === 0) return false
  if (typeof record.sig !== 'string' || record.sig.length === 0) return false
  const expected = signProcRegistryRecord(record, secret)
  if (expected.length !== record.sig.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.sig, 'hex'))
  } catch {
    return false
  }
}

/**
 * 文件级校验：记录文件必须是普通文件（非 symlink）、属主当前用户、权限不得宽于 0600，
 * 且签名有效。任一不满足 → 不可信（C12）。
 */
export function verifyProcRegistryFile(
  record: ProcRegistryRecord | undefined,
  dir = getProcRegistryDir(),
  secret = getRegistrySecret(),
): boolean {
  if (!record) return false
  const file = registryRecordPath(record.marker, dir)
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
    const uid = currentUid()
    if (uid !== undefined && stat.uid !== uid) return false
    if ((stat.mode & 0o077) !== 0) return false
  } catch {
    return false
  }
  return verifyProcRegistryRecord(record, secret)
}

export function registryRecordPath(marker: string, dir = getProcRegistryDir()): string {
  return path.join(dir, `${encodeURIComponent(marker)}.json`)
}

/**
 * 以「自有进程组」方式 spawn：POSIX 下 `detached` 等价 setsid，
 * 子进程成为会话/进程组组长，pgid === pid，整组可被安全回收。
 * Windows 下 `detached` 建立独立进程组语义，回收走 `taskkill /T`。
 */
export function spawnInOwnGroup(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  } = {},
): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 关键：独立进程组，主进程退出/被杀后不会带走 CLI，也不会被误组杀
    detached: true,
    signal: options.signal,
  })
}

/** 解析真实 Codex CLI（`@openai/codex` 的 node 入口），供 shim 拉起。 */
export function resolveRealCodexPath(): string | undefined {
  try {
    const requireFromCwd = createRequire(path.join(process.cwd(), 'package.json'))
    return requireFromCwd.resolve('@openai/codex/bin/codex.js')
  } catch {
    return undefined
  }
}

/**
 * 生成 Codex 监督 shim，返回其绝对路径。
 * 目录先过 `ensureRegistryDir`（0700 / 属主独占）；shim 本身 0700。
 * 写入走不跟随 symlink 的原子路径（C13b）：同名 symlink / 预置普通文件 /
 * 只读目录一律拒绝，绝不覆盖受害者文件。
 * 已存在且内容完全一致（且属主/权限合规）时幂等复用，避免每次 spawn 重写。
 */
export function ensureCodexSupervisorScript(dir = getProcRegistryDir()): string {
  ensureRegistryDir(dir)
  const target = path.join(dir, CODEX_SUPERVISOR_FILE)
  writeFileNoFollow(target, CODEX_SUPERVISOR_SOURCE, 0o700, { allowExistingIdentical: true })
  return target
}

export function readProcRegistryRecord(
  marker: string,
  dir = getProcRegistryDir(),
): ProcRegistryRecord | undefined {
  try {
    const raw = fs.readFileSync(registryRecordPath(marker, dir), 'utf-8')
    const parsed = JSON.parse(raw) as ProcRegistryRecord
    if (!parsed || typeof parsed.pid !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function listProcRegistryRecords(dir = getProcRegistryDir()): ProcRegistryRecord[] {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const records: ProcRegistryRecord[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as ProcRegistryRecord
      if (parsed && typeof parsed.pid === 'number') records.push(parsed)
    } catch {
      // 未写完/损坏文件忽略
    }
  }
  return records
}

export function removeProcRegistryRecord(marker: string, dir = getProcRegistryDir()): void {
  try {
    fs.unlinkSync(registryRecordPath(marker, dir))
  } catch {
    // 已不存在
  }
}

/** 轮询等待 shim 完成自注册（Codex 路径拿 PID 的唯一时机）。 */
export async function waitForProcRegistryRecord(
  marker: string,
  timeoutMs = 3000,
  intervalMs = 25,
  dir = getProcRegistryDir(),
): Promise<ProcRegistryRecord | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = readProcRegistryRecord(marker, dir)
    if (record) return record
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return readProcRegistryRecord(marker, dir)
}

/**
 * Codex 监督 shim 源码。由 SDK 以 `spawn(shimPath, args, { env })` 启动：
 * 1. 读取本轮 marker / 注册目录 / 真实 CLI 路径；
 * 2. `detached: true` 拉起真实 CLI，成为其进程组组长；
 * 3. 从 `ps` 抓取 pid 的 startedAt + command，写入自注册文件（原子写）；
 * 4. 透传 stdin/stdout/stderr 与信号，退出码与子进程一致。
 */
const CODEX_SUPERVISOR_SOURCE = [
  '#!/usr/bin/env node',
  "'use strict'",
  "const { spawn, execFileSync } = require('node:child_process')",
  "const crypto = require('node:crypto')",
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  '',
  "const marker = process.env.BIZGRAPH_TURN_ID || ''",
  "const registryDir = process.env.BIZGRAPH_PROC_REGISTRY_DIR || ''",
  "const realCodex = process.env.BIZGRAPH_REAL_CODEX || ''",
  "const nonce = process.env.BIZGRAPH_SUPERVISOR_NONCE || ''",
  "const secret = process.env.BIZGRAPH_REGISTRY_SECRET || ''",
  '',
  'function fail(message) {',
  "  process.stderr.write('[bizgraph-codex-supervisor] ' + message + '\\n')",
  '  process.exit(127)',
  '}',
  '',
  "if (!marker || !registryDir) fail('missing marker or registry dir')",
  "if (!realCodex) fail('missing real codex path')",
  "if (!nonce || !secret) fail('missing supervisor nonce or registry secret')",
  '',
  'const args = process.argv.slice(2)',
  'const child = spawn(process.execPath, [realCodex, ...args], {',
  '  detached: true,',
  "  stdio: ['pipe', 'pipe', 'pipe'],",
  '  env: process.env,',
  '})',
  '',
  'if (!child.pid) fail(\'failed to spawn codex child\')',
  '',
  'function psField(flag) {',
  '  try {',
  "    return execFileSync('ps', ['-o', flag, '-p', String(child.pid)], {",
  "      encoding: 'utf-8',",
  "      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },",
  '    }).trim()',
  '  } catch {',
  "    return ''",
  '  }',
  '}',
  '',
  'function normalizeStartedAt(raw) {',
  "  const parts = raw.split(/\\s+/).filter(Boolean)",
  '  return parts.length >= 5 ? parts.slice(-4).join(\' \') : raw',
  '}',
  '',
  "const startedAt = normalizeStartedAt(psField('lstart='))",
  "const command = psField('command=')",
  'let startedAtHiRes',
  'if (process.platform === \'linux\') {',
  '  try {',
  "    const raw = require('node:fs').readFileSync('/proc/' + child.pid + '/stat', 'utf-8')",
  '    const rparen = raw.lastIndexOf(\')\')',
  "    const ticks = raw.slice(rparen + 2).trim().split(/\\s+/)[19]",
  '    if (ticks) startedAtHiRes = \'linux-starttime:\' + ticks',
  '  } catch {}',
  '}',
  'const record = {',
  '  marker,',
  '  pid: child.pid,',
  '  pgid: child.pid,',
  '  startedAt,',
  '  startedAtHiRes,',
  '  command,',
  '  shimPid: process.pid,',
  '  createdAt: Date.now(),',
  '  nonce,',
  '}',
  '',
  '// 与 process-supervisor.ts 的 canonicalRegistryRecord 保持同构（键名排序 + k=v）',
  'function canonical(record) {',
  '  return Object.keys(record)',
  '    .sort()',
  '    .map((key) => key + "=" + String(record[key] === undefined ? "" : record[key]))',
  '    .join("\\n")',
  '}',
  "record.sig = crypto.createHmac('sha256', secret).update(canonical(record)).digest('hex')",
  '',
  'function pathExists(target) {',
  '  try {',
  '    fs.lstatSync(target)',
  '    return true',
  '  } catch (error) {',
  "    if (error && error.code === 'ENOENT') return false",
  '    throw error',
  '  }',
  '}',
  '',
  '// C13b：记录文件同样原子写且不跟随 symlink；目标已存在一律拒绝覆盖。',
  'function writeRecordNoFollow(finalPath, payload) {',
  "  if (pathExists(finalPath)) throw new Error('registry target already exists: ' + finalPath)",
  "  const tmpPath = path.join(path.dirname(finalPath), '.' + path.basename(finalPath) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp')",
  '  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)',
  '  let fd',
  '  try {',
  '    fd = fs.openSync(tmpPath, flags, 0o600)',
  '    fs.writeFileSync(fd, payload)',
  '    fs.fchmodSync(fd, 0o600)',
  '    fs.closeSync(fd)',
  '    fd = undefined',
  '    const stat = fs.lstatSync(tmpPath)',
  "    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('temporary record is not a regular file')",
  "    if ((stat.mode & 0o077) !== 0) throw new Error('temporary record is not owner-exclusive')",
  "    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('temporary record owner mismatch')",
  "    if (pathExists(finalPath)) throw new Error('registry target appeared concurrently: ' + finalPath)",
  '    fs.renameSync(tmpPath, finalPath)',
  '  } catch (error) {',
  '    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }',
  '    try { fs.unlinkSync(tmpPath) } catch {}',
  '    throw error',
  '  }',
  '}',
  '',
  'try {',
  '  fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 })',
  '  const dirStat = fs.lstatSync(registryDir)',
  "  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('registry dir is not a real directory')",
  "  if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) throw new Error('registry dir owner mismatch')",
  '  try { fs.chmodSync(registryDir, 0o700) } catch {}',
  "  const finalPath = path.join(registryDir, encodeURIComponent(marker) + '.json')",
  '  writeRecordNoFollow(finalPath, JSON.stringify(record))',
  '} catch (error) {',
  "  process.stderr.write('[bizgraph-codex-supervisor] registry write failed: ' + error + '\\n')",
  '}',
  '',
  'function killChild(signal) {',
  '  try {',
  '    if (process.platform !== \'win32\') process.kill(-child.pid, signal)',
  '    else child.kill(signal)',
  '  } catch {',
  '    try { child.kill(signal) } catch {}',
  '  }',
  '}',
  '',
  "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {",
  '  process.on(signal, () => {',
  '    killChild(signal)',
  '    setTimeout(() => process.exit(128), 200)',
  '  })',
  '}',
  '',
  "process.stdin.on('error', () => {})",
  "child.stdin.on('error', () => {})",
  'process.stdin.pipe(child.stdin)',
  'child.stdout.on(\'error\', () => {})',
  'child.stdout.pipe(process.stdout)',
  'child.stderr.pipe(process.stderr)',
  '',
  'child.on(\'error\', (error) => {',
  "  process.stderr.write('[bizgraph-codex-supervisor] child error: ' + error + '\\n')",
  '  process.exit(1)',
  '})',
  'child.on(\'exit\', (code) => {',
  '  process.exit(code === null ? 1 : code)',
  '})',
  '',
].join('\n')
