/**
 * 短命子孙探针：启动后 150ms 自然退出，用于验证「已退出的后代不应再收到信号」。
 */
import { appendFileSync } from 'node:fs'

const LOG = process.env.PROBE_LOG
const LABEL = process.env.PROBE_LABEL ?? 'short'

function record(payload) {
  try {
    appendFileSync(
      LOG,
      `${JSON.stringify({ ...payload, pid: process.pid, label: LABEL, at: Date.now() })}\n`,
    )
  } catch {
    // 忽略
  }
}

record({ type: 'ready', role: 'short' })

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => {
    record({ type: 'signal', signal })
    process.exit(0)
  })
}

setTimeout(() => {
  record({ type: 'natural-exit' })
  process.exit(0)
}, 150)
