/**
 * 真实子进程探针（不是 mock）。
 *
 * 作用：记录「自己实际收到了哪些信号」以及「自己 spawn 的后代以什么信号死亡」，
 * 追加写入 JSONL 日志。日志由测试进程读取，用于客观判定回收动作是否越界。
 *
 * 用法：node probe.mjs <none|long|long+short> [额外参数...]
 * 环境：PROBE_LOG（JSONL 路径）、PROBE_LABEL（标签）
 *
 * 注意：SIGKILL 无法被目标进程捕获，因此对 SIGKILL 的判定依赖
 *   a) 父探针的 child-exit(signal='SIGKILL') 记录；
 *   b) 测试进程发出的信号探针（tap）。
 */
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG = process.env.PROBE_LOG
const LABEL = process.env.PROBE_LABEL ?? 'unknown'
const MODE = process.argv[2] ?? 'none'
const here = dirname(fileURLToPath(import.meta.url))

function record(payload) {
  try {
    appendFileSync(
      LOG,
      `${JSON.stringify({ ...payload, pid: process.pid, label: LABEL, at: Date.now() })}\n`,
    )
  } catch {
    // 日志不可写不应改变进程行为
  }
}

record({ type: 'ready', role: 'probe' })

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => {
    record({ type: 'signal', signal })
    process.exit(0)
  })
}

const children = []

function spawnChild(script, label) {
  const child = spawn(process.execPath, [script], {
    stdio: 'ignore',
    // 不 detached：后代留在 owner 的进程组里，便于验证组边界
    env: { ...process.env, PROBE_LOG: LOG, PROBE_LABEL: label },
  })
  children.push(child)
  record({ type: 'child-spawn', childPid: child.pid, childLabel: label })
  child.on('exit', (code, signal) => {
    record({ type: 'child-exit', childPid: child.pid, childLabel: label, code, signal })
  })
  return child
}

if (MODE === 'long' || MODE === 'long+short') {
  spawnChild(join(here, 'probe.mjs'), `${LABEL}.long`)
}
if (MODE === 'long+short') {
  spawnChild(join(here, 'short-lived.mjs'), `${LABEL}.short`)
}

// 长驻：直到收到信号或被 SIGKILL
setInterval(() => {}, 1000)
