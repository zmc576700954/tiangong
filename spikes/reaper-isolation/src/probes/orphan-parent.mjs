/**
 * 构造「真实孤儿」：以 detached 方式拉起一个长驻探针，打印其 pid 后立即退出。
 * 父进程退出后，子进程会被 reparent 到 pid 1（launchd），用于测试孤儿门。
 *
 * 用法：node orphan-parent.mjs <cliScript>
 */
import { spawn } from 'node:child_process'

const cliScript = process.argv[2]
if (!cliScript) {
  process.stderr.write('usage: orphan-parent <cliScript>\n')
  process.exit(2)
}

const child = spawn(process.execPath, [cliScript, 'long'], {
  detached: true,
  stdio: 'ignore',
  env: process.env,
})
if (!child.pid) process.exit(1)
process.stdout.write(`${child.pid}\n`)
child.unref()
process.exit(0)
