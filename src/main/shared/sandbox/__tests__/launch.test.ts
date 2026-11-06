/**
 * C3 spawn 接入口径：`sandboxLaunch()` 的 argv 形态就是 Claude/OpenCode/MCP 实际使用的形态；
 * Codex 走 shim 的 env profile 分支。这里用真实 sandbox-exec + 真实 shim 验证两条接入。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureCodexSandboxWrapperScript, ensureCodexSupervisorScript } from '../../process-supervisor'
import { getSandboxCapability } from '../capability'
import { sandboxLaunch, sandboxProfileText } from '../index'

const available = process.platform === 'darwin' && getSandboxCapability().available

function makeWorkspace(): { root: string; repo: string; outside: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bizgraph-sbx-launch-')))
  const repo = join(root, 'repo')
  const outside = join(root, 'outside')
  mkdirSync(repo)
  mkdirSync(outside)
  return { root, repo, outside }
}

describe.skipIf(!available)('sandbox launch plan', () => {
  it('sandboxLaunch 产出 sandbox-exec argv，工作区内写成功、工作区外写被拒', () => {
    const { repo, outside } = makeWorkspace()
    const inside = join(repo, 'inside.txt')
    const outsideFile = join(outside, 'outside.txt')

    const plan = sandboxLaunch('claude', {
      workspaceDir: repo,
      command: '/bin/sh',
      args: ['-c', `printf ok > "${inside}"`],
    })
    expect(plan.sandboxed).toBe(true)
    expect(plan.command).toBe('/usr/bin/sandbox-exec')
    expect(plan.args.slice(0, 3)).toEqual(['-p', plan.profile?.text, '--'])

    const ok = spawnSync(plan.command, plan.args, { cwd: repo, encoding: 'utf-8' })
    expect(ok.status).toBe(0)
    expect(existsSync(inside)).toBe(true)

    const denied = spawnSync(plan.command, [
      ...plan.args.slice(0, -1),
      `printf evil > "${outsideFile}"`,
    ], { cwd: repo, encoding: 'utf-8' })
    expect(denied.status).not.toBe(0)
    expect(existsSync(outsideFile)).toBe(false)
  })

  it('Codex shim：profile 经 env 注入后，真实 CLI 的越界写入被拒；未注入时对照写入成功', () => {
    const { root, repo, outside } = makeWorkspace()
    const registry = join(root, 'registry')
    const marker = join(outside, 'codex-marker')
    const fakeCodex = join(root, 'fake-codex.js')
    writeFileSync(
      fakeCodex,
      `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(marker)}, 'x')\n`,
    )
    const shim = ensureCodexSupervisorScript(registry)

    const envBase: NodeJS.ProcessEnv = {
      ...process.env,
      BIZGRAPH_TURN_ID: 'c3-turn',
      BIZGRAPH_PROC_REGISTRY_DIR: registry,
      BIZGRAPH_REAL_CODEX: fakeCodex,
      BIZGRAPH_SUPERVISOR_NONCE: 'nonce',
      BIZGRAPH_REGISTRY_SECRET: 'secret',
      BIZGRAPH_SANDBOX_PROFILE: '',
    }

    // 对照：不注入 profile → 真实 CLI 能写工作区外（证明 marker 断言有效）。
    const control = spawnSync(process.execPath, [shim], { env: envBase, encoding: 'utf-8' })
    expect(control.status).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(join(registry, 'c3-turn.json'))).toBe(true)

    // 注入 profile → 子进程被 sandbox-exec 包住，越界写失败。
    const profile = sandboxProfileText('codex', {
      workspaceDir: repo,
      extraExecutables: [process.execPath],
    })
    expect(profile).toBeTruthy()
    rmSync(marker, { force: true })
    const guarded = spawnSync(process.execPath, [shim], {
      env: { ...envBase, BIZGRAPH_SANDBOX_PROFILE: profile },
      encoding: 'utf-8',
    })
    expect(existsSync(marker)).toBe(false)
    expect(guarded.status).not.toBe(0)
  })

  it('Codex legacy wrapper：profile 经 env 注入后，真实 CLI 的越界写入被拒', () => {
    const { root, repo, outside } = makeWorkspace()
    const registry = join(root, 'registry')
    const marker = join(outside, 'legacy-marker')
    const fakeCodex = join(root, 'fake-codex.js')
    writeFileSync(
      fakeCodex,
      `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(marker)}, 'x')\n`,
    )
    const wrapper = ensureCodexSandboxWrapperScript(registry)
    const envBase: NodeJS.ProcessEnv = {
      ...process.env,
      BIZGRAPH_REAL_CODEX: fakeCodex,
      BIZGRAPH_SANDBOX_NODE: process.execPath,
      BIZGRAPH_SANDBOX_PROFILE: '',
    }

    // 对照：不注入 profile → 真实 CLI 能写工作区外（证明 marker 断言有效）。
    const control = spawnSync(wrapper, [], { env: envBase, encoding: 'utf-8' })
    expect(control.status).toBe(0)
    expect(existsSync(marker)).toBe(true)

    // 注入 profile → sandbox-exec 套壳，越界写失败。
    const profile = sandboxProfileText('codex', {
      workspaceDir: repo,
      extraExecutables: [process.execPath],
    })
    expect(profile).toBeTruthy()
    rmSync(marker, { force: true })
    const guarded = spawnSync(wrapper, [], {
      env: { ...envBase, BIZGRAPH_SANDBOX_PROFILE: profile },
      encoding: 'utf-8',
    })
    expect(existsSync(marker)).toBe(false)
    expect(guarded.status).not.toBe(0)
  })
})
