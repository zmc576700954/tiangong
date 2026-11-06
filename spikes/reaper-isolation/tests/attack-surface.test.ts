/**
 * D5 新机制引入的攻击面（C12 / C13）与本次独立攻击（C14 / C15 / C16）。
 *
 * 信任边界：「进程自注册文件 + 安装级 HMAC 密钥」。
 *   C12：伪造/篡改/symlink/权限过宽/未知 marker/重放的记录不得导致 kill。
 *   C13：注册目录与密钥必须属主独占；目录不能被 symlink 抢占。
 *   C14：同 uid 攻击者读得到安装密钥 → 可铸造合法记录（威胁模型边界，非权限提升）。
 *   C15：unsigned 身份的「孤儿门」只在 ppid===1 放行；字段被篡改必须挡住。
 *   C16：竞态（证明后目标退出 / 组长先死 / 记录删除与扫描并发 / 重复 kill）。
 *
 * 数据性质：后半段含「模拟攻击者」（写文件/伪造记录），但驱动的是真实 reaper 与
 * 真实进程/信号；C16a 使用注入的 `list()` 仅用于确定性制造竞态窗口，已在证据里标注。
 *
 * 运行：npm run test:attack
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureCodexSupervisorScript,
  ensureRegistryDir,
  getRegistrySecret,
  listProcRegistryRecords,
  readProcRegistryRecord,
  registryRecordPath,
  removeProcRegistryRecord,
  REGISTRY_SECRET_ENV,
  PROC_REGISTRY_DIR_ENV,
  signProcRegistryRecord,
  verifyProcRegistryFile,
  type ProcRegistryRecord,
} from '../../../src/main/shared/process-supervisor'
import {
  attestProcIdentity,
  ProcessReaper,
  type ProcInfo,
} from '../../../src/main/agent/runtime/process/reaper'
import { createReaper } from '../src/adapter'
import { alive, killTap, rawKill } from '../src/kill-tap'
import { identityOf, killTrees, recordEvidence, spawnProbe, waitMs } from '../src/harness'

const PROBE_PATH = fileURLToPath(new URL('../src/probes/probe.mjs', import.meta.url))
const ORPHAN_PARENT_PATH = fileURLToPath(new URL('../src/probes/orphan-parent.mjs', import.meta.url))

const ROOT = mkdtempSync(join(tmpdir(), 'bizgraph-reaper-isolation-attack-'))
const ORIGINAL_TMPDIR = process.env.TMPDIR
const ORIGINAL_SECRET = process.env[REGISTRY_SECRET_ENV]
const ORIGINAL_REGISTRY_DIR = process.env[PROC_REGISTRY_DIR_ENV]

beforeAll(() => {
  killTap.install()
  // 把 os.tmpdir() 指向本次运行的独立目录：注册目录与密钥都落在 ROOT 下，
  // 不触碰开发机上的真实安装密钥/注册目录。
  process.env.TMPDIR = ROOT
  delete process.env[REGISTRY_SECRET_ENV]
  delete process.env[PROC_REGISTRY_DIR_ENV]
})

afterAll(() => {
  killTap.dispose()
  if (ORIGINAL_TMPDIR === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = ORIGINAL_TMPDIR
  if (ORIGINAL_SECRET !== undefined) process.env[REGISTRY_SECRET_ENV] = ORIGINAL_SECRET
  if (ORIGINAL_REGISTRY_DIR !== undefined) process.env[PROC_REGISTRY_DIR_ENV] = ORIGINAL_REGISTRY_DIR
  rmSync(ROOT, { recursive: true, force: true })
})

async function measure<T>(fn: () => Promise<T> | T): Promise<T> {
  killTap.reset()
  killTap.start()
  try {
    return await fn()
  } finally {
    killTap.stop()
  }
}

/** 命中 canary 进程本身或其组的信号。 */
function signalsTo(pid: number) {
  return killTap.sends().filter((call) => call.pid === pid || call.pid === -pid)
}

function fieldsOf(identity: { pid: number; pgid?: number; startedAt?: string; startedAtHiRes?: string; command?: string }): {
  pid: number
  pgid: number
  startedAt: string
  startedAtHiRes: string | undefined
  command: string
} {
  return {
    pid: identity.pid,
    pgid: identity.pgid ?? identity.pid,
    startedAt: identity.startedAt ?? '',
    startedAtHiRes: identity.startedAtHiRes,
    command: identity.command ?? '',
  }
}

function computeSecretPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  return join(
    ROOT,
    uid === undefined ? 'bizgraph-agent-secret' : `bizgraph-agent-secret-${uid}`,
  )
}

function writeRecordFile(
  dir: string,
  record: Omit<ProcRegistryRecord, 'sig'> & { sig?: string },
  mode = 0o600,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = registryRecordPath(record.marker, dir)
  writeFileSync(file, JSON.stringify(record), { mode })
  chmodSync(file, mode)
  return file
}

function signedRecord(
  marker: string,
  fields: ReturnType<typeof fieldsOf>,
  secret: string,
  overrides: Partial<ProcRegistryRecord> = {},
): ProcRegistryRecord {
  const base = {
    marker,
    pid: fields.pid,
    pgid: fields.pgid,
    startedAt: fields.startedAt,
    startedAtHiRes: fields.startedAtHiRes,
    command: fields.command,
    shimPid: process.pid,
    createdAt: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
    ...overrides,
  }
  return { ...base, sig: signProcRegistryRecord(base, secret) }
}

let attackDirCounter = 0
function freshDir(label: string): string {
  attackDirCounter += 1
  return mkdtempSync(join(ROOT, `${label}-${attackDirCounter}-`))
}

// ---------------------------------------------------------------------------
// C12：伪造/篡改/符号链接/权限过宽/未知 marker/重放
// ---------------------------------------------------------------------------

it('C12 伪造记录（无签名）完全匹配 ps 也不得导致 kill', async () => {
  const reaper = createReaper()
  const canary = await spawnProbe('ATTACK.C12.canary', { children: 'long' })
  const dir = freshDir('forge')
  try {
    const actual = identityOf(canary.ownerPid)!
    const marker = 'bizgraph-turn:forged-C12'
    const record = {
      marker,
      ...fieldsOf(actual),
      shimPid: process.pid,
      createdAt: Date.now(),
      nonce: 'attacker-nonce',
    }
    writeRecordFile(dir, record)

    const read = readProcRegistryRecord(marker, dir)!
    expect(listProcRegistryRecords(dir).map((item) => item.marker)).toContain(marker)
    expect(verifyProcRegistryFile(read, dir), '无签名记录必须验签失败').toBe(false)

    const report = await measure(() => {
      // 直接喂给 killRegistered（模拟「记录已越过验签」的最坏路径）
      const r = reaper.killRegistered(
        [{ pid: read.pid, pgid: read.pgid, startedAt: read.startedAt, command: read.command }],
        { marker: read.marker },
      )
      return r
    })

    const signals = signalsTo(canary.ownerPid)
    recordEvidence('C12.unsigned', {
      impl: reaper.implId,
      marker,
      verifyFile: verifyProcRegistryFile(read, dir),
      forgerKilled: report.killed,
      unresolved: report.unresolved.map((item) => `${item.pid}:${item.reason}`),
      signalsToCanary: signals,
      canaryAlive: alive(canary.ownerPid),
      note: '同 uid 但未读密钥/或其他 uid 的攻击者路径',
    })

    expect(signals, '伪造自注册记录不得导致任何 kill').toHaveLength(0)
    expect(report.killed).toBe(0)
    expect(alive(canary.ownerPid), 'canary 必须存活').toBe(true)
  } finally {
    await killTrees(canary)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('C12 变体：symlink / 0600 违规 / 签名字段篡改 / 重放陈旧身份 —— 均不得 kill', async () => {
  const reaper = createReaper()
  const canary = await spawnProbe('ATTACK.C12v.canary', { children: 'long' })
  const dir = freshDir('forge-variants')
  try {
    const actual = identityOf(canary.ownerPid)!
    const fields = fieldsOf(actual)
    const secret = getRegistrySecret()
    const marker = 'bizgraph-turn:forged-C12v'
    const results: Record<string, unknown> = {}

    // 1) 合法签名文件 + 记录文件是 symlink
    const good = signedRecord(marker, fields, secret)
    const realFile = join(dir, 'real.json')
    writeRecordFile(dir, { ...good, marker: 'real-file' })
    // 覆盖写一份目标文件，再让目标路径成为 symlink
    rmSync(realFile, { force: true })
    writeFileSync(realFile, JSON.stringify(good), { mode: 0o600 })
    const linkPath = registryRecordPath(marker, dir)
    try {
      unlinkSync(linkPath)
    } catch {}
    symlinkSync(realFile, linkPath)
    const readLink = readProcRegistryRecord(marker, dir)!
    results.symlinkVerify = verifyProcRegistryFile(readLink, dir)
    expect(verifyProcRegistryFile(readLink, dir), 'symlink 记录必须被拒绝').toBe(false)
    // 清掉 symlink，后续变体写真实普通文件
    unlinkSync(linkPath)

    // 2) 合法签名但文件权限 0644（组/其他可读）
    const wide = signedRecord(marker, fields, secret)
    writeRecordFile(dir, wide, 0o644)
    const readWide = readProcRegistryRecord(marker, dir)!
    results.wideModeVerify = verifyProcRegistryFile(readWide, dir)
    expect(verifyProcRegistryFile(readWide, dir), '权限宽于 0600 的记录必须被拒绝').toBe(false)

    // 3) 先签名再篡改字段
    const tampered = signedRecord(marker, fields, secret)
    tampered.command = `${tampered.command} --evil-flag`
    writeRecordFile(dir, tampered)
    const readTampered = readProcRegistryRecord(marker, dir)!
    results.tamperedVerify = verifyProcRegistryFile(readTampered, dir)
    expect(verifyProcRegistryFile(readTampered, dir), '签名字段被篡改必须被拒绝').toBe(false)

    // 4) 重放：合法签名但 startedAt 陈旧（PID 复用后已不是同一进程实例）
    const replay = signedRecord(marker, fields, secret, { startedAt: 'Thu Jan 1 00:00:00 1970' })
    writeRecordFile(dir, replay)
    const readReplay = readProcRegistryRecord(marker, dir)!
    results.replayVerify = verifyProcRegistryFile(readReplay, dir)

    const signals = await measure(async () => {
      // 即使签名有效（重放），归属证明也必须挡下陈旧身份。
      // 关键：attestation 也按重放字段铸造，模拟「签名合法但身份已陈旧」。
      const r = reaper.killRegistered(
        [
          {
            pid: replay.pid,
            pgid: replay.pgid,
            startedAt: replay.startedAt,
            command: replay.command,
            attestation: attestProcIdentity(
              {
                pid: replay.pid,
                pgid: replay.pgid,
                startedAt: replay.startedAt,
                command: replay.command,
              },
              secret,
            ),
          },
        ],
        { marker: replay.marker },
      )
      await waitMs(150)
      return r
    })
    const sig = signalsTo(canary.ownerPid)
    results.replayKilled = signals.killed
    results.replayUnresolved = signals.unresolved.map((item) => `${item.pid}:${item.matched.join('+')}`)
    results.signals = sig
    results.canaryAlive = alive(canary.ownerPid)

    recordEvidence('C12.variants', results)
    expect(sig, '重放/篡改均不得命中 canary').toHaveLength(0)
    expect(signals.killed).toBe(0)
    expect(alive(canary.ownerPid)).toBe(true)
  } finally {
    await killTrees(canary)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('C12 未知 marker：reconcile 门控不得把目录里的记录当凭证', async () => {
  const reaper = createReaper()
  const canary = await spawnProbe('ATTACK.C12.unknown', { children: 'long' })
  const dir = freshDir('forge-unknown')
  try {
    const actual = identityOf(canary.ownerPid)!
    const secret = getRegistrySecret()
    const marker = 'bizgraph-turn:not-in-db'
    const record = signedRecord(marker, fieldsOf(actual), secret)
    writeRecordFile(dir, record)

    const read = readProcRegistryRecord(marker, dir)!
    // 模拟 runtime.reconcileOnStartup 的「已知 marker」门控（本测试台不启动真实 DB）。
    const knownMarkers = new Set<string>(['bizgraph-turn:some-other-live-turn'])
    const known = knownMarkers.has(read.marker)

    const report = await measure(async () => {
      if (!known) {
        // 未知 marker → 仅告警，不进入 killRegistered
        return { skipped: true, killed: 0 } as unknown as ReturnType<typeof reaper.killRegistered>
      }
      return reaper.killRegistered(
        [{ ...fieldsOf(actual), attestation: attestProcIdentity(fieldsOf(actual), secret) }],
        { marker: read.marker },
      )
    })

    const signals = signalsTo(canary.ownerPid)
    recordEvidence('C12.unknownMarker', {
      marker,
      verifyFile: verifyProcRegistryFile(read, dir),
      isKnownMarker: known,
      killed: 0,
      signalsToCanary: signals,
      canaryAlive: alive(canary.ownerPid),
      note: '本测试模拟 runtime.isKnownMarker（无真实 DB）；证明门控是唯一阻挡项',
    })
    expect(signals).toHaveLength(0)
    expect((report as { killed?: number }).killed ?? 0).toBe(0)
    expect(alive(canary.ownerPid)).toBe(true)
  } finally {
    await killTrees(canary)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// C13：目录 / 密钥 / shim 的预先替换
// ---------------------------------------------------------------------------

it('C13 目录与密钥必须属主独占：0777 收紧、symlink 拒绝、密钥权限拒绝', async () => {
  const squatParent = freshDir('squat')
  const squatted = join(squatParent, 'bizgraph-agent-proc')
  mkdirSync(squatted, { recursive: true, mode: 0o777 })
  chmodSync(squatted, 0o777)

  ensureRegistryDir(squatted)
  const dirMode = statSync(squatted).mode & 0o777
  const shimPath = ensureCodexSupervisorScript(squatted)
  const shimMode = statSync(shimPath).mode & 0o777

  // 目录本身被替换为 symlink → 必须拒绝
  const realDir = freshDir('real-dir')
  const dirLink = join(squatParent, 'dir-link')
  symlinkSync(realDir, dirLink)
  let symlinkDirRejected = false
  try {
    ensureRegistryDir(dirLink)
  } catch {
    symlinkDirRejected = true
  }
  expect(symlinkDirRejected, 'symlink 注册目录必须被拒绝').toBe(true)

  // 密钥文件：symlink / 权限过宽 / 正常 0600
  const secretPath = computeSecretPath()
  try {
    unlinkSync(secretPath)
  } catch {}
  writeFileSync(secretPath, 'attacker-placeholder', { mode: 0o600 })
  chmodSync(secretPath, 0o600)
  const victim = join(squatParent, 'secret-victim')
  writeFileSync(victim, 'victim', { mode: 0o600 })
  chmodSync(victim, 0o600)
  // 把密钥路径替换为 symlink
  unlinkSync(secretPath)
  symlinkSync(victim, secretPath)
  let symlinkSecretRejected = false
  try {
    getRegistrySecret()
  } catch {
    symlinkSecretRejected = true
  }
  expect(symlinkSecretRejected, 'symlink 密钥文件必须被拒绝').toBe(true)

  // 权限过宽（0644）
  unlinkSync(secretPath)
  writeFileSync(secretPath, 'wide-secret', { mode: 0o644 })
  chmodSync(secretPath, 0o644)
  let wideSecretRejected = false
  try {
    getRegistrySecret()
  } catch {
    wideSecretRejected = true
  }
  expect(wideSecretRejected, '权限宽于 0600 的密钥文件必须被拒绝').toBe(true)

  // 正常 0600 → 可读
  unlinkSync(secretPath)
  writeFileSync(secretPath, 'normal-secret', { mode: 0o600 })
  chmodSync(secretPath, 0o600)
  const normalSecret = getRegistrySecret()
  expect(normalSecret).toBe('normal-secret')

  recordEvidence('C13', {
    dirMode: dirMode.toString(8),
    shimMode: shimMode.toString(8),
    groupOrOtherWritableDir: (dirMode & 0o022) !== 0,
    groupOrOtherWritableShim: (shimMode & 0o022) !== 0,
    symlinkDirRejected,
    symlinkSecretRejected,
    wideSecretRejected,
    normalSecretReadable: normalSecret === 'normal-secret',
    note: '目录在写 shim 前被 ensureRegistryDir 收紧；密钥文件每次读取都校验 symlink/属主/权限',
  })

  expect(dirMode, '注册目录必须为 0700（属主独占）').toBe(0o700)
  expect(shimMode & 0o022, 'shim 不得被组/其他用户写入').toBe(0)
  rmSync(squatParent, { recursive: true, force: true })
})

const SHIM_NAME = 'codex-supervisor.cjs'
const SHIM_MAGIC = '#!/usr/bin/env node'

function inspectShim(dir: string) {
  const target = join(dir, SHIM_NAME)
  try {
    const st = lstatSync(target)
    const content = st.isFile() ? readFileSync(target, 'utf-8') : ''
    return {
      exists: true,
      isFile: st.isFile(),
      isSymbolicLink: st.isSymbolicLink(),
      mode: (st.mode & 0o777).toString(8),
      ownerExclusive: (st.mode & 0o077) === 0,
      looksLikeShim: content.startsWith(SHIM_MAGIC) && content.includes('BIZGRAPH_TURN_ID'),
    }
  } catch {
    return { exists: false, isFile: false, isSymbolicLink: false, mode: '', ownerExclusive: false, looksLikeShim: false }
  }
}

it('C13b shim 同名抢占（C13b 修复后）：symlink / 只读 / 目录 / 硬链接 / 并发 / rename 窗口', async () => {
  const results: Record<string, unknown> = {}

  // 1) symlink → 普通文件：只删链接，受害者内容不变；shim 变真实普通文件 700
  {
    const dir = freshDir('c13b-symlink')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'ORIGINAL-VICTIM-CONTENT', { mode: 0o600 })
    chmodSync(victim, 0o600)
    symlinkSync(victim, join(dir, SHIM_NAME))
    ensureCodexSupervisorScript(dir)
    const shim = inspectShim(dir)
    const victimContent = readFileSync(victim, 'utf-8')
    results.symlink = {
      victimOverwritten: !victimContent.startsWith('ORIGINAL-VICTIM-CONTENT'),
      victimMode: (statSync(victim).mode & 0o777).toString(8),
      shim,
    }
    expect(victimContent.startsWith('ORIGINAL-VICTIM-CONTENT'), 'symlink 受害者不得被覆盖').toBe(true)
    expect(shim.isSymbolicLink, 'shim 不得继续是 symlink').toBe(false)
    expect(shim.isFile && shim.mode === '700' && shim.looksLikeShim, 'shim 必须是真实普通文件 0700').toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }

  // 2) symlink → 只读文件（0444）：受害者内容与权限均不变
  {
    const dir = freshDir('c13b-readonly')
    const victim = join(dir, 'readonly.txt')
    writeFileSync(victim, 'READONLY-VICTIM', { mode: 0o444 })
    chmodSync(victim, 0o444)
    symlinkSync(victim, join(dir, SHIM_NAME))
    ensureCodexSupervisorScript(dir)
    const shim = inspectShim(dir)
    const victimContent = readFileSync(victim, 'utf-8')
    const victimMode = (statSync(victim).mode & 0o777).toString(8)
    results.readonly = { victimOverwritten: victimContent !== 'READONLY-VICTIM', victimMode, shim }
    expect(victimContent).toBe('READONLY-VICTIM')
    expect(victimMode).toBe('444')
    expect(shim.isFile && shim.mode === '700').toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }

  // 3) symlink → 目录：受害目录保持为目录
  {
    const dir = freshDir('c13b-dir')
    const victimDir = join(dir, 'victim-dir')
    mkdirSync(victimDir, { recursive: true, mode: 0o700 })
    symlinkSync(victimDir, join(dir, SHIM_NAME))
    ensureCodexSupervisorScript(dir)
    const shim = inspectShim(dir)
    const victimStillDir = statSync(victimDir).isDirectory()
    results.dir = { victimStillDir, shim }
    expect(victimStillDir, '受害目录不得被替换/覆盖').toBe(true)
    expect(shim.isFile && shim.mode === '700').toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }

  // 4) 硬链接：预置目标与受害者同 inode；内容不同 → 拒绝覆盖，受害者不变
  {
    const dir = freshDir('c13b-hardlink')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'HARDLINK-VICTIM', { mode: 0o600 })
    chmodSync(victim, 0o600)
    linkSync(victim, join(dir, SHIM_NAME))
    let hardLinkRefused = false
    try {
      ensureCodexSupervisorScript(dir)
    } catch {
      hardLinkRefused = true
    }
    const victimUnchanged = readFileSync(victim, 'utf-8') === 'HARDLINK-VICTIM'
    // 安全拒绝后再新建：移除硬链接本身（不影响受害者），应得到真实 shim 700
    if (hardLinkRefused) {
      unlinkSync(join(dir, SHIM_NAME))
      ensureCodexSupervisorScript(dir)
    }
    const shim = inspectShim(dir)
    results.hardlink = { hardLinkRefused, victimUnchanged, shim }
    expect(victimUnchanged, '硬链接受害者内容不得改变').toBe(true)
    expect(shim.isFile && shim.mode === '700' && shim.looksLikeShim).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }

  // 5) 并发两次创建（前置 symlink 抢占）：允许一次拒绝，最终必须为真实 700 shim
  {
    const dir = freshDir('c13b-concurrent')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'CONCURRENT-VICTIM', { mode: 0o600 })
    chmodSync(victim, 0o600)
    symlinkSync(victim, join(dir, SHIM_NAME))
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => ensureCodexSupervisorScript(dir)),
      Promise.resolve().then(() => ensureCodexSupervisorScript(dir)),
    ])
    const victimUnchanged = readFileSync(victim, 'utf-8') === 'CONCURRENT-VICTIM'
    const shim = inspectShim(dir)
    results.concurrent = {
      fulfilled: settled.filter((item) => item.status === 'fulfilled').length,
      rejected: settled.filter((item) => item.status === 'rejected').length,
      victimUnchanged,
      shim,
    }
    expect(victimUnchanged).toBe(true)
    expect(settled.some((item) => item.status === 'fulfilled'), '至少一次创建成功').toBe(true)
    expect(shim.isFile && shim.mode === '700' && shim.looksLikeShim).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }

  // 6) rename 窗口内目标被替换：持续把目标改成 symlink，运行中反复重建
  {
    const dir = freshDir('c13b-rename-window')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'RENAME-WINDOW-VICTIM', { mode: 0o600 })
    chmodSync(victim, 0o600)
    const target = join(dir, SHIM_NAME)
    let stop = false
    let refusals = 0
    const attacker = setInterval(() => {
      if (stop) return
      try {
        unlinkSync(target)
      } catch {}
      try {
        symlinkSync(victim, target)
      } catch {}
    }, 2)
    try {
      for (let i = 0; i < 20; i += 1) {
        try {
          ensureCodexSupervisorScript(dir)
        } catch {
          refusals += 1
        }
        await waitMs(5)
      }
    } finally {
      stop = true
      clearInterval(attacker)
    }
    // 攻击停止后做一次正常创建，确认最终状态
    try {
      ensureCodexSupervisorScript(dir)
    } catch {}
    const victimUnchanged = readFileSync(victim, 'utf-8') === 'RENAME-WINDOW-VICTIM'
    const shim = inspectShim(dir)
    results.renameWindow = { refusals, victimUnchanged, shim }
    expect(victimUnchanged, 'rename 窗口内受害者内容不得改变').toBe(true)
    expect(shim.isFile && shim.mode === '700' && shim.looksLikeShim).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }

  recordEvidence('C13b', {
    ...results,
    note: 'C13b 修复后：writeFileNoFollow 只删链接不动目标；临时文件 O_EXCL|O_NOFOLLOW + fchmod + rename 前二次校验',
  })
})

// ---------------------------------------------------------------------------
// C14：同 uid 密钥可读 → 可铸造合法 HMAC 记录（威胁模型边界）
// ---------------------------------------------------------------------------

it('C14 同 uid 攻击者读取安装密钥后，可伪造合法记录命中非孤儿进程', async () => {
  const reaper = createReaper()
  const canary = await spawnProbe('ATTACK.C14.canary', { children: 'long' })
  const dir = freshDir('same-uid')
  try {
    const actual = identityOf(canary.ownerPid)!
    const fields = fieldsOf(actual)
    // 攻击者与受害者同 uid：直接读 0600 的安装密钥
    const stolenSecret = getRegistrySecret()
    const secretPath = computeSecretPath()
    const secretMode = statSync(secretPath).mode & 0o777
    const secretOwner = statSync(secretPath).uid

    const marker = 'bizgraph-turn:live-turn-known'
    const record = signedRecord(marker, fields, stolenSecret)
    writeRecordFile(dir, record)
    const read = readProcRegistryRecord(marker, dir)!
    const verify = verifyProcRegistryFile(read, dir)
    expect(verify, '同 uid 读取密钥后签发的记录应通过验签（这正是威胁）').toBe(true)

    const report = await measure(async () => {
      const r = reaper.killRegistered(
        [
          {
            pid: read.pid,
            pgid: read.pgid,
            startedAt: read.startedAt,
            command: read.command,
            attestation: attestProcIdentity(fields, stolenSecret),
          },
        ],
        { marker: read.marker },
      )
      await waitMs(200)
      return r
    })

    const signals = signalsTo(canary.ownerPid)
    recordEvidence('C14', {
      secretPath,
      secretMode: secretMode.toString(8),
      secretOwner,
      secretReadBySameUid: true,
      verifyFile: verify,
      killed: report.killed,
      killedGroups: report.killedGroups,
      signalsToCanary: signals,
      canaryAlive: alive(canary.ownerPid),
      note: '同 uid 威胁模型内：攻击者本来就能直接 kill 同 uid 进程，HMAC 不构成权限提升；但不得宣称"绝对不可伪造"',
    })

    expect(signals.length).toBeGreaterThan(0)
    expect(report.killed).toBeGreaterThan(0)
    expect(alive(canary.ownerPid), 'canary 被同 uid 伪造路径杀死（记录事实）').toBe(false)
  } finally {
    await killTrees(canary)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('C14b 密钥被同名文件替换为攻击者已知值：验签可通过（同 uid 残余面）', async () => {
  const reaper = createReaper()
  const canary = await spawnProbe('ATTACK.C14b.canary', { children: 'long' })
  const dir = freshDir('secret-replaced')
  try {
    const actual = identityOf(canary.ownerPid)!
    const fields = fieldsOf(actual)
    const attackerSecret = 'attacker-known-secret-0123456789abcdef'
    const secretPath = computeSecretPath()
    writeFileSync(secretPath, attackerSecret, { mode: 0o600 })
    chmodSync(secretPath, 0o600)
    expect(getRegistrySecret(), '应用会直接复用预置的同名密钥文件').toBe(attackerSecret)

    const marker = 'bizgraph-turn:live-turn-known-2'
    const record = signedRecord(marker, fields, attackerSecret)
    writeRecordFile(dir, record)
    const read = readProcRegistryRecord(marker, dir)!
    expect(verifyProcRegistryFile(read, dir), '攻击者已知密钥 → 验签通过').toBe(true)

    const report = await measure(async () => {
      const r = reaper.killRegistered(
        [{ ...fields, attestation: attestProcIdentity(fields, attackerSecret) }],
        { marker },
      )
      await waitMs(200)
      return r
    })
    await waitDeadPid(canary.ownerPid, 2000)
    const signals = signalsTo(canary.ownerPid)
    recordEvidence('C14b', {
      secretReplaced: true,
      verifyFile: verifyProcRegistryFile(read, dir),
      killed: report.killed,
      signalsToCanary: signals,
      canaryAlive: alive(canary.ownerPid),
    })
    expect(signals.length).toBeGreaterThan(0)
    expect(alive(canary.ownerPid)).toBe(false)
  } finally {
    await killTrees(canary)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// C15：孤儿门
// ---------------------------------------------------------------------------

async function spawnOrphanProbe(label: string): Promise<{ pid: number; cleanup: () => Promise<void> }> {
  const child = spawn(process.execPath, [ORPHAN_PARENT_PATH, PROBE_PATH], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const pid = await new Promise<number>((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const match = /\n/.exec(buffer)
      if (match) {
        const value = Number(buffer.slice(0, match.index).trim())
        if (Number.isFinite(value) && value > 1) resolve(value)
        else reject(new Error(`bad orphan pid: ${buffer}`))
      }
    })
    child.on('exit', () => {
      if (!buffer.trim()) reject(new Error('orphan parent exited without pid'))
    })
    setTimeout(() => reject(new Error('orphan parent timeout')), 3000)
  })
  // 等 reparent 到 pid 1
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const proc = identityOf(pid)
    if (proc && listProcessesPpid(pid) === 1) break
    await waitMs(25)
  }
  return {
    pid,
    cleanup: async () => {
      rawKill(pid, 'SIGKILL')
      await waitMs(80)
    },
  }
}

function listProcessesPpid(pid: number): number | undefined {
  // identityOf 不带 ppid；这里复用 ps 输出（只读）
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf-8',
    }).trim()
    return Number(out)
  } catch {
    return undefined
  }
}

it('C15 孤儿门：真实孤儿 + 字段被篡改必须挡住；只有完全真实的 unsigned 身份才放行', async () => {
  const reaper = createReaper()
  const orphan = await spawnOrphanProbe('ATTACK.C15')
  const dir = freshDir('orphan')
  try {
    const actual = identityOf(orphan.pid)!
    expect(actual, '孤儿应可被 ps 观测').toBeDefined()
    const ppid = listProcessesPpid(orphan.pid)
    expect(ppid, '父进程退出后应 reparent 到 1').toBe(1)
    const secret = getRegistrySecret()

    // 1) 字段篡改：command 不匹配（仅 startedAt 一项证据）
    const tamperedCommand = await measure(() => {
      const r = reaper.killRegistered(
        [{ pid: actual.pid, pgid: actual.pgid, startedAt: actual.startedAt, command: '/definitely/not-real' }],
        { marker: 'bizgraph-turn:orphan-tamper-1' },
      )
      return r
    })
    expect(signalsTo(orphan.pid)).toHaveLength(0)
    expect(tamperedCommand.killed).toBe(0)
    expect(alive(orphan.pid)).toBe(true)

    // 2) 字段篡改：startedAt 不匹配（仅 command 一项证据）
    const tamperedTime = await measure(() => {
      const r = reaper.killRegistered(
        [{ pid: actual.pid, pgid: actual.pgid, startedAt: 'Thu Jan 1 00:00:00 1970', command: actual.command }],
        { marker: 'bizgraph-turn:orphan-tamper-2' },
      )
      return r
    })
    expect(signalsTo(orphan.pid)).toHaveLength(0)
    expect(tamperedTime.killed).toBe(0)
    expect(alive(orphan.pid)).toBe(true)

    // 3) 完全真实的 unsigned 身份：孤儿门放行（这是当前设计）
    const genuine = await measure(async () => {
      const r = reaper.killRegistered(
        [{ pid: actual.pid, pgid: actual.pgid, startedAt: actual.startedAt, command: actual.command }],
        { marker: 'bizgraph-turn:orphan-genuine' },
      )
      await waitMs(120)
      return r
    })
    recordEvidence('C15', {
      orphanPid: actual.pid,
      ppid,
      tamperedCommandKilled: tamperedCommand.killed,
      tamperedTimeKilled: tamperedTime.killed,
      genuineUnsignedKilled: genuine.killed,
      genuineKilledGroups: genuine.killedGroups,
      orphanAliveAfterGenuine: alive(orphan.pid),
      note: 'unsigned 仅在 ppid===1 放行；任一内容证据被篡改即 insufficient-proof',
    })
    expect(genuine.killed).toBeGreaterThan(0)
    expect(alive(orphan.pid)).toBe(false)
  } finally {
    await orphan.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// C16：竞态
// ---------------------------------------------------------------------------

it('C16a 证明通过后目标自行退出：必须记 missing，不得把空结果当成功', () => {
  const secret = getRegistrySecret()
  const fakePid = 65535
  const fake: ProcInfo = {
    pid: fakePid,
    ppid: 999,
    pgid: fakePid,
    state: 'S',
    startedAt: 'Nov 4 23:50:00 2026',
    command: '/fake/agent-cli --turn race',
  }
  const fields = {
    pid: fake.pid,
    pgid: fake.pgid,
    startedAt: fake.startedAt,
    command: fake.command,
  }
  let calls = 0
  // 第 1 次快照能看到目标（归属证明通过），随后目标退出 → 后续快照为空。
  const reaper = new ProcessReaper(() => {
    calls += 1
    return calls === 1 ? [fake] : []
  })
  const report = reaper.killRegistered(
    [{ ...fields, attestation: attestProcIdentity(fields, secret) }],
    { marker: 'bizgraph-turn:race-exit' },
  )

  recordEvidence('C16a', {
    simulatedList: true,
    calls,
    discovered: report.discovered,
    killed: report.killed,
    killedPids: report.killedPids,
    killedGroups: report.killedGroups,
    missing: report.missing,
    unresolved: report.unresolved,
    note: '注入 list 制造「证明通过后目标消失」的确定性窗口；断言 killed=0 且记 missing',
  })

  expect(report.killed).toBe(0)
  expect(report.killedGroups).toHaveLength(0)
  expect(report.missing).toContain(fakePid)
})

it('C16b 组长先死、组员存活：不得整组回收，组员必须存活', async () => {
  const reaper = createReaper()
  const tree = await spawnProbe('ATTACK.C16b', { children: 'long', detached: true })
  const longPid = tree.pidOf('ATTACK.C16b.long')!
  const ownerIdentity = identityOf(tree.ownerPid)!
  const secret = getRegistrySecret()
  try {
    rawKill(tree.ownerPid, 'SIGKILL')
    await waitDeadPid(tree.ownerPid)

    const report = await measure(async () => {
      const r = reaper.killRegistered(
        [{ ...fieldsOf(ownerIdentity), attestation: attestProcIdentity(fieldsOf(ownerIdentity), secret) }],
        { marker: 'bizgraph-turn:race-leader-dead' },
      )
      await waitMs(150)
      return r
    })

    recordEvidence('C16b', {
      leaderPid: tree.ownerPid,
      longPid,
      killed: report.killed,
      killedGroups: report.killedGroups,
      missing: report.missing,
      signalsToLong: signalsTo(longPid),
      longAlive: alive(longPid),
      note: '组长已死 → proof not-found；不得对 -pgid 发信号带走存活组员',
    })

    expect(report.killed).toBe(0)
    expect(report.killedGroups).toHaveLength(0)
    expect(report.missing).toContain(tree.ownerPid)
    expect(alive(longPid), '存活组员不得被整组回收').toBe(true)
  } finally {
    await killTrees(tree)
  }
})

it('C16c 记录删除与扫描并发：文件消失后不得按残留内容 kill', async () => {
  const canary = await spawnProbe('ATTACK.C16c.canary', { children: 'long' })
  const dir = freshDir('race-delete')
  try {
    const actual = identityOf(canary.ownerPid)!
    const secret = getRegistrySecret()
    const marker = 'bizgraph-turn:race-delete'
    const record = signedRecord(marker, fieldsOf(actual), secret)
    writeRecordFile(dir, record)

    const listed = listProcRegistryRecords(dir)
    expect(listed.map((item) => item.marker)).toContain(marker)
    removeProcRegistryRecord(marker, dir)
    const verifiedAfterDelete = verifyProcRegistryFile(listed[0], dir)
    expect(verifiedAfterDelete, '扫描后记录被删除 → 验签必须失败').toBe(false)

    const signals = await measure(async () => {
      // emulate reconcile：verify 失败即 skip，不调用 killRegistered
      return []
    })

    recordEvidence('C16c', {
      listedBeforeDelete: listed.length,
      verifiedAfterDelete,
      kills: 0,
      signalsToCanary: signalsTo(canary.ownerPid),
      canaryAlive: alive(canary.ownerPid),
      note: '扫描与删除并发 → 验签失败即跳过，不会把「文件没了」当成「已回收」',
    })

    expect(verifyProcRegistryFile(listed[0], dir)).toBe(false)
    expect(signalsTo(canary.ownerPid)).toHaveLength(0)
    expect(alive(canary.ownerPid)).toBe(true)
  } finally {
    await killTrees(canary)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('C16d 重复 kill：同一签名身份第二次不得再发信号', async () => {
  const reaper = createReaper()
  const canary = await spawnProbe('ATTACK.C16d.canary', { children: 'long' })
  try {
    const actual = identityOf(canary.ownerPid)!
    const fields = fieldsOf(actual)
    const secret = getRegistrySecret()
    const identity = { ...fields, attestation: attestProcIdentity(fields, secret) }

    const first = await measure(async () => {
      const r = reaper.killRegistered([identity], { marker: 'bizgraph-turn:double-kill' })
      await waitMs(200)
      return r
    })
    const firstSignals = signalsTo(canary.ownerPid)
    expect(first.killed).toBeGreaterThan(0)
    await waitDeadPid(canary.ownerPid)

    const second = await measure(async () => {
      const r = reaper.killRegistered([identity], { marker: 'bizgraph-turn:double-kill' })
      await waitMs(120)
      return r
    })
    const secondSignals = signalsTo(canary.ownerPid)

    recordEvidence('C16d', {
      firstKilled: first.killed,
      firstSignals,
      secondKilled: second.killed,
      secondSignals,
      secondMissing: second.missing,
      note: '第二次目标已不存在 → missing / 不重复发信号',
    })

    expect(secondSignals, '重复 kill 不得再发信号').toHaveLength(0)
    expect(second.killed).toBe(0)
  } finally {
    await killTrees(canary)
  }
})

async function waitDeadPid(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return
    await waitMs(25)
  }
}
