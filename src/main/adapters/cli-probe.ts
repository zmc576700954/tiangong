import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * CLI 探测的超时上界。
 *
 * 与 `src/main/adapters/mindmap-adapter.ts` 里 `execFileSync(..., { timeout: 5000 })`
 * 保持一致 —— 那是同一层里已有的先例。
 */
export const CLI_PROBE_TIMEOUT_MS = 5000

/**
 * 探测一个 CLI 是否已安装。
 *
 * 带超时上界：探测挂住（首次运行要交互认证、安装损坏、往满管道写）时，
 * 到点返回 false，而不是让整个探测链永远挂着。`execFile` 的 `timeout`
 * 选项到期会**终止子进程**，所以这同时解决了挂住子进程的泄漏。
 */
export async function probeCliInstalled(
  command: string,
  args: string[] = ['--version'],
): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: CLI_PROBE_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}
