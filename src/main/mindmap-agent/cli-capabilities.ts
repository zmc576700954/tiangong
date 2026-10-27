/**
 * claude CLI 能力探测
 *
 * 不同版本的 CLI 支持的 flag 不一样，传了不认识的 flag，CLI 会直接退出 ——
 * 整条生成流程失败，而且失败原因看起来像模型问题，很难定位。
 * 所以用到的 flag 都要先探测一次，并把结果缓存住。
 */

import { execFileSync } from 'node:child_process'
import { getPlatformProvider } from '../platform'
import { createLogger } from '../shared/logger'

const logger = createLogger('CliCapabilities')

/** null = 尚未探测 */
let disallowedToolsSupported: boolean | null = null

/**
 * CLI 是否支持 --disallowedTools / --disallowed-tools。
 *
 * 没有这个 flag 时调用方只能退回「不传」：CLI 自身的权限检查仍然是默认开启的，
 * 只是不能再额外把写工具列成显式拒绝。
 */
export function supportsDisallowedTools(): boolean {
  if (disallowedToolsSupported !== null) return disallowedToolsSupported
  try {
    const help = execFileSync('claude', ['--help'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
      ...getPlatformProvider().getShellConfig(),
      windowsHide: true,
    })
    disallowedToolsSupported = /disallowed-?[Tt]ools/.test(help)
  } catch {
    // 没装 CLI / 探测失败 → 不传该 flag（CLI 不可用时另有更明确的报错）
    disallowedToolsSupported = false
  }
  logger.info(`claude CLI supports --disallowedTools: ${disallowedToolsSupported}`)
  return disallowedToolsSupported
}

/** 仅供测试重置缓存 */
export function resetCliCapabilitiesCache(): void {
  disallowedToolsSupported = null
}
