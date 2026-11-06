/**
 * Codex 监督 shim 的**真实替代物**：spawn 一个 detached 的真实 CLI 探针，
 * 抓取它的 ps 身份（pid/pgid/startedAt/command），写入进程自注册文件。
 *
 * 这复刻了 `src/main/shared/process-supervisor.ts` 中 shim 的关键行为，
 * 用于验证「宿主被 kill -9 后，新进程能否凭自注册文件认领残留 CLI 进程组」。
 *
 * 用法：node supervisor-probe.mjs <marker> <registryDir> <cliScript>
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [marker, registryDir, cliScript] = process.argv.slice(2)
if (!marker || !registryDir || !cliScript) {
  process.stderr.write('usage: supervisor-probe <marker> <registryDir> <cliScript>\n')
  process.exit(2)
}

const child = spawn(process.execPath, [cliScript, 'long'], {
  // 与 D5 机制一致：CLI 是自有进程组的组长（pgid === pid）
  detached: true,
  stdio: 'ignore',
  env: process.env,
})
if (!child.pid) process.exit(1)

function psField(flag) {
  try {
    return execFileSync('ps', ['-o', flag, '-p', String(child.pid)], {
      encoding: 'utf-8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim()
  } catch {
    return ''
  }
}

function normalizeStartedAt(raw) {
  const parts = raw.split(/\s+/).filter(Boolean)
  return parts.length >= 5 ? parts.slice(-4).join(' ') : raw
}

const startedAt = normalizeStartedAt(psField('lstart='))
const command = psField('command=')

try {
  mkdirSync(registryDir, { recursive: true })
  const finalPath = path.join(registryDir, `${encodeURIComponent(marker)}.json`)
  const tmpPath = `${finalPath}.${process.pid}.tmp`
  const record = {
    marker,
    pid: child.pid,
    pgid: child.pid,
    startedAt,
    command,
    shimPid: process.pid,
    createdAt: Date.now(),
  }
  writeFileSync(tmpPath, JSON.stringify(record))
  renameSync(tmpPath, finalPath)
} catch (error) {
  process.stderr.write(`supervisor-probe registry write failed: ${error}\n`)
}

// 宿主保持存活，等待被测试进程 kill -9（模拟会话宿主崩溃）
setInterval(() => {}, 1000)
