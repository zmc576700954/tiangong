/**
 * 宿主能力探测（测试专用）。
 *
 * 背景：进程归属校验与 sandbox canary 这批用例依赖两项宿主能力——读进程表
 * （`ps`）和套限制性 sandbox profile（`sandbox-exec`）。在受限宿主机（容器、
 * 沙箱化 CI、企业管控终端）上这两项会返回 EPERM，测试因此假红；代码本身没有
 * 回归。这里用**独立于被测模块**的最小探测给出结论，测试按用例粒度 skip：
 * 只跳过真正需要该能力的用例，不整文件跳过（同一个文件里还有不依赖它的用例）。
 *
 * 注意：探测结论按模块缓存，避免每个用例都 fork 一次 `ps`。
 */

import { execFileSync } from 'node:child_process'

let psCache: boolean | null = null
let sandboxCache: boolean | null = null

/** 能否读取进程表（`ps -o pid=,pgid=,etime=,command= -p <self>`）。 */
export function canReadProcessTable(): boolean {
  if (psCache !== null) return psCache
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pid=,pgid=,etime=,command=', '-p', String(process.pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf8',
    })
    // 读得到表还不够：必须真的看到自己这一行，否则说明输出被裁剪/伪造。
    psCache = out.trim().length > 0
  } catch {
    psCache = false
  }
  return psCache
}

/**
 * 能否套用限制性 sandbox profile（仅 macOS）。
 *
 * 判据与生产 canary 同形：跑一个「放行默认、拒绝写文件」的 profile。只放行
 * `(allow default)` 的空壳不算可用——那证明不了限制真的生效。
 */
export function canApplySandboxProfile(): boolean {
  if (process.platform !== 'darwin') return false
  if (sandboxCache !== null) return sandboxCache
  try {
    execFileSync(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)(deny file-write*)', '--', '/bin/sh', '-c', 'exit 0'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
    )
    sandboxCache = true
  } catch {
    sandboxCache = false
  }
  return sandboxCache
}

/** 仅测试用：清空缓存（探测结论会变的环境里显式重算）。 */
export function resetHostProbeCacheForTests(): void {
  psCache = null
  sandboxCache = null
}
