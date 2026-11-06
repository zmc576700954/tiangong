/**
 * C3（macOS 首版）：执行面沙箱能力探测。
 *
 * 判据（用户口径）：**不要用系统版本号判断可用性**，必须真的在沙箱里跑一次 canary，
 * 确认「允许的写入成功 + 工作区外写入被拒 + 白名单外 exec 被拒」。任一不满足即不可用。
 *
 * 一致性：探测结果以模块级单例缓存，启动期 `initSandboxCapability()` 与每次 spawn
 * 前的 `getSandboxCapability()` 读取的是**同一个对象**，不会出现「启动判定可用、
 * 执行时降级」或反过来。测试用 `resetSandboxCapabilityForTests()` 清缓存。
 *
 * 失败语义：不可用不是异常，是降级信号；调用方负责把 allow 集整体退回 ask
 * （见 `evaluateBashPolicy` 的 `sandboxAvailable` 选项）。
 */

import { execFileSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger } from '../logger'
import { resolveRealPath } from '../../agent/runtime/approval/write-paths'

const logger = createLogger('Sandbox')

/** macOS 系统自带；不随包分发任何二进制，避免签名/公证新增成本。 */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

export interface SandboxCapability {
  platform: NodeJS.Platform
  available: boolean
  /**
   * `ok` 或失败分类：
   * - `platform-unsupported`：非 macOS（本轮只做 macOS 单平台）；
   * - `binary-missing`：sandbox-exec 不存在/不可执行；
   * - `canary-write-failed`：沙箱内允许的写入没有成功（profile 误拒）；
   * - `canary-write-not-denied`：工作区外写入没有被拒（沙箱未生效）；
   * - `canary-exec-not-denied`：白名单外 exec 没有被拒（exec 收敛未生效）；
   * - `canary-error`：canary 进程本身无法启动。
   */
  reason: string
  /** 诊断细节（stderr 摘要等），供日志/设置页使用。 */
  detail?: string
  probedAt: number
}

let cachedCapability: SandboxCapability | null = null

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** canary 用最小 profile，刻意不复用业务 profile，避免「profile 自身有 bug 时误判可用」。 */
function canaryProfile(workspace: string): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath ${sbplString(workspace)}))`,
    '(deny process-exec)',
    '(allow process-exec (subpath "/bin") (subpath "/usr/bin") (subpath "/usr/sbin") (subpath "/System/Library"))',
  ].join('\n')
}

function runCanary(profile: string, args: string[], sandboxExecPath: string): {
  ok: boolean
  stdout: string
  stderr: string
} {
  try {
    const stdout = execFileSync(sandboxExecPath, ['-p', profile, '--', ...args], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: stdout ?? '', stderr: '' }
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string | Buffer }
    return {
      ok: false,
      stdout: typeof detail.stdout === 'string' ? detail.stdout : '',
      stderr: Buffer.isBuffer(detail.stderr) ? detail.stderr.toString('utf-8') : (detail.stderr ?? ''),
    }
  }
}

/**
 * 真实 canary：在临时目录里建「工作区 + 工作区外」两处，跑三条命令。
 * - 正向：沙箱内写工作区并读回，必须成功（否则 profile 误拒，正常功能会被弄坏）；
 * - 写负向：写工作区外必须失败且文件不存在；
 * - exec 负向：执行白名单外的脚本必须失败且其写盘副作用不存在。
 */
export function probeSandboxCapability(options: { sandboxExecPath?: string } = {}): SandboxCapability {
  const sandboxExecPath = options.sandboxExecPath ?? SANDBOX_EXEC_PATH
  const probedAt = Date.now()
  const base: Omit<SandboxCapability, 'available' | 'reason' | 'detail'> = {
    platform: process.platform,
    probedAt,
  }

  if (process.platform !== 'darwin') {
    return { ...base, available: false, reason: 'platform-unsupported' }
  }
  try {
    accessSync(sandboxExecPath, fsConstants.X_OK)
  } catch {
    return { ...base, available: false, reason: 'binary-missing', detail: sandboxExecPath }
  }

  let root: string
  try {
    root = resolveRealPath(mkdtempSync(path.join(os.tmpdir(), 'bizgraph-sandbox-canary-')))
  } catch (error) {
    return {
      ...base,
      available: false,
      reason: 'canary-error',
      detail: String(error instanceof Error ? error.message : error),
    }
  }

  const workspace = path.join(root, 'ws')
  const outside = path.join(root, 'outside')
  const marker = path.join(outside, 'marker.txt')
  const execMarker = path.join(workspace, 'exec-marker.txt')
  const script = path.join(outside, 'probe.sh')

  try {
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(
      script,
      `#!/bin/sh\nprintf x > ${sbplString(execMarker)}\n`,
      { encoding: 'utf-8', mode: 0o700 },
    )
    chmodSync(script, 0o700)

    const profile = canaryProfile(workspace)

    const positive = runCanary(
      profile,
      ['/bin/sh', '-c', `printf ok > ${sbplString(path.join(workspace, 'inside.txt'))} && cat ${sbplString(path.join(workspace, 'inside.txt'))}`],
      sandboxExecPath,
    )
    if (!positive.ok || !positive.stdout.includes('ok')) {
      return {
        ...base,
        available: false,
        reason: 'canary-write-failed',
        detail: (positive.stderr || positive.stdout).slice(0, 300),
      }
    }

    runCanary(profile, ['/bin/sh', '-c', `printf x > ${sbplString(marker)}`], sandboxExecPath)
    if (existsSync(marker)) {
      return { ...base, available: false, reason: 'canary-write-not-denied', detail: marker }
    }

    runCanary(profile, [script], sandboxExecPath)
    if (existsSync(execMarker)) {
      return { ...base, available: false, reason: 'canary-exec-not-denied', detail: script }
    }

    return { ...base, available: true, reason: 'ok' }
  } catch (error) {
    return {
      ...base,
      available: false,
      reason: 'canary-error',
      detail: String(error instanceof Error ? error.message : error).slice(0, 300),
    }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* canary 临时目录清理失败不影响判定 */
    }
  }
}

/** 单例读取：启动探测与每次 spawn 前必须拿到同一结论。 */
export function getSandboxCapability(): SandboxCapability {
  if (!cachedCapability) cachedCapability = probeSandboxCapability()
  return cachedCapability
}

/** 仅供测试：清空缓存，下一次读取重新跑真实 canary。 */
export function resetSandboxCapabilityForTests(): void {
  cachedCapability = null
}

/**
 * 启动期调用一次：把结论写进日志（可回答「这台机器为什么在弹窗」）。
 * 返回同一单例对象，后续读取不会重新探测。
 */
export function initSandboxCapability(): SandboxCapability {
  const capability = getSandboxCapability()
  if (capability.available) {
    logger.info(`执行面沙箱可用（${capability.platform}），allow 集将在沙箱内执行`)
  } else {
    logger.warn(
      `执行面沙箱不可用（reason=${capability.reason}），只读命令的 allow 集整体退回 ask` +
        (capability.detail ? `：${capability.detail}` : ''),
    )
  }
  return capability
}
