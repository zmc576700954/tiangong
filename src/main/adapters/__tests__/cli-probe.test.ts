import { describe, it, expect } from 'vitest'
import { probeCliInstalled, CLI_PROBE_TIMEOUT_MS } from '../cli-probe'

/**
 * CLI 安装探测的超时上界测试。
 *
 * 背景：8 个 CLI 适配器的 `checkInstalled()` 用 `execFile` 探测二进制，且
 * **没有超时**。`checkAllInstalled` 用 `Promise.allSettled` 包着它们 ——
 * 一个挂住的 CLI（首次运行要交互认证、安装损坏、往满管道写）会让整个
 * 探测永不 settle，进而让依赖它的界面（设置面板的适配器下拉、marketplace）
 * 一直转圈。
 *
 * `execFile` 的 `timeout` 选项到期会**终止子进程**，所以这里既解决等待时间，
 * 也解决挂住的子进程泄漏。
 */

describe('probeCliInstalled', () => {
  it('命令不存在时返回 false', async () => {
    expect(await probeCliInstalled('definitely-not-a-real-cli-xyz')).toBe(false)
  })

  it('命令存在时返回 true', async () => {
    expect(await probeCliInstalled('node', ['--version'])).toBe(true)
  })

  it('命令挂住时在超时上界内返回 false，不无限等待', async () => {
    const started = Date.now()
    expect(await probeCliInstalled('sh', ['-c', 'sleep 30'])).toBe(false)
    const elapsed = Date.now() - started
    // 留出余量：定时器不保证精确准时触发
    expect(elapsed).toBeLessThan(CLI_PROBE_TIMEOUT_MS * 2)
    // 探测必须**在超时上界内**返回，而不是一直挂着
    expect(elapsed).toBeGreaterThanOrEqual(CLI_PROBE_TIMEOUT_MS - 200)
  }, 15000)

  it('超时会终止子进程（不留孤儿）', async () => {
    // 子进程本该在超时（5s）之后才写标记 —— 若它没被杀掉，标记就会出现
    const marker = `/tmp/bizgraph-probe-${process.pid}-${Date.now()}`
    const started = Date.now()
    await probeCliInstalled('sh', ['-c', `sleep 6; touch ${marker}`])
    expect(Date.now() - started).toBeLessThan(CLI_PROBE_TIMEOUT_MS * 2)

    // 等过标记本该出现的时刻（t=6s）
    await new Promise((r) => setTimeout(r, 2500))
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  }, 15000)
})
