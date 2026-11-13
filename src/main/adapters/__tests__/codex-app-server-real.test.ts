/**
 * `codex app-server` 真机测试（默认 skip）。
 *
 *   BIZGRAPH_CODEX_REAL=1 \
 *   BIZGRAPH_CODEX_APP_SERVER_BIN=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
 *   npx vitest run src/main/adapters/__tests__/codex-app-server-real.test.ts
 *
 * 为什么必须真跑：G7-2 的关键结论是「通道存在」，这件事只能由真实回合证明 ——
 * 假进程能验证回执格式，但证明不了「回 `accept` 后命令真的执行」和
 * 「`cancel` 后文件真的不存在」。v3.29 就是靠 `exec` 的真实回合否掉了
 * 「只差 CLI 入口」，这一条同样是实机口径。
 *
 * 用 `sandbox: 'read-only'` 而不是 `workspace-write`：写文件在任何机器上都必须
 * 升级权限，因此审批请求是**必然发生**的，不依赖宿主 sandbox-exec 是否可用
 * （本机 sandbox-exec 直接 `Operation not permitted`，反而会让 workspace-write
 * 也误触发审批）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexAppServerClient, buildApprovalReply, type CodexApprovalRequest } from '../codex-app-server'

const REAL = process.env.BIZGRAPH_CODEX_REAL === '1'
const BIN = process.env.BIZGRAPH_CODEX_APP_SERVER_BIN

const describeReal = REAL && BIN ? describe : describe.skip

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makePlan(cwd: string) {
  const bin = BIN as string
  return bin.endsWith('.js')
    ? { command: process.execPath, args: [bin, 'app-server'], cwd, env: { ...process.env, NODE_OPTIONS: '' } }
    : { command: bin, args: ['app-server'], cwd, env: { ...process.env, NODE_OPTIONS: '' } }
}

/** 跑一轮，返回审批请求与回合事件；`decide` 决定放行还是拒绝。 */
async function runTurn(decision: 'accept' | 'deny') {
  const cwd = mkdtempSync(path.join(tmpdir(), 'codex-as-'))
  dirs.push(cwd)
  const approvals: CodexApprovalRequest[] = []
  const events: Array<{ type: string; usage?: { input_tokens?: number; output_tokens?: number } }> = []

  const client = await CodexAppServerClient.start({
    plan: makePlan(cwd),
    spawnImpl: spawn as never,
    onApproval: (request) => {
      approvals.push(request)
      client.replyApproval(request.requestId, buildApprovalReply(decision === 'deny' ? 'deny' : 'allow', request))
    },
  })

  try {
    client.onEvent((event) => events.push(event as { type: string }))
    const thread = await client.startThread({ cwd, sandbox: 'read-only', approvalPolicy: 'on-request' })
    await client.startTurn({
      threadId: thread.threadId,
      text: 'Use your shell tool to run exactly: echo CODEX-AS-REAL > marker.txt — then report the exit code.',
    })

    // 回合终态由 turn/completed 判定，不猜进程退出
    const completed = await new Promise<{ type: string; message?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ type: 'timeout' }), 240_000)
      const check = () => {
        const terminal = events.find((e) => e.type === 'turn.completed' || e.type === 'turn.failed')
        if (terminal) {
          clearTimeout(timer)
          resolve(terminal as { type: string })
        } else {
          setTimeout(check, 200)
        }
      }
      check()
    })
    return { cwd, approvals, events, completed, thread }
  } finally {
    await client.dispose()
  }
}

describeReal('codex app-server 真机：审批往返', () => {
  it('放行：命令真的执行，marker 文件落盘', async () => {
    const { cwd, approvals, events, completed } = await runTurn('accept')

    expect(approvals.length).toBeGreaterThanOrEqual(1)
    expect(approvals[0].command).toContain('marker.txt')
    expect(completed.type).toBe('turn.completed')

    const marker = path.join(cwd, 'marker.txt')
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf-8')).toContain('CODEX-AS-REAL')

    const usage = events.find((e) => e.type === 'turn.completed')?.usage
    expect(usage?.input_tokens ?? 0).toBeGreaterThan(0)
  }, 300_000)

  it('拒绝：命令不执行，marker 不存在；回合以 turn.failed 收尾（协议只能 cancel）', async () => {
    const { cwd, approvals, events, completed } = await runTurn('deny')

    expect(approvals.length).toBeGreaterThanOrEqual(1)
    // 命令审批的 availableDecisions 里没有 decline，拒绝只能回 cancel ——
    // 而 cancel 的语义是「拒绝并立即中断本回合」。所以这里**必然是 turn.failed**，
    // 不是「回合正常结束但工具被拒」。把它写成 turn.completed 就是在骗自己。
    expect(completed.type).toBe('turn.failed')
    // 拒绝原因要能落到事件流里，否则界面上只剩「失败」两个字
    const failed = events.find((e) => e.type === 'turn.failed') as { error?: { message?: string } } | undefined
    expect(failed?.error?.message).toBeTruthy()
    // 无论怎么收尾，命令都不能真的跑过
    expect(existsSync(path.join(cwd, 'marker.txt'))).toBe(false)
  }, 300_000)
})
