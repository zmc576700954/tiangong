/**
 * OpenCode 适配器（单次执行模式）
 *
 * OpenCode CLI 是单次执行工具：启动、处理 prompt、输出结果、退出。
 * 每次 sendCommand() 启动新进程，传入完整 prompt。
 *
 * v3.30 起走 `opencode run --format json`：stdout 是 JSONL 事件流，
 * 工具轨迹（tool_use + state.status/output/error）由 CLI 自己给出，
 * 归一化在 runtime/normalize/opencode.ts 的 OpenCodeStreamNormalizer。
 */

import { spawn } from 'node:child_process'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import { sandboxLaunch } from '../shared/sandbox'
import { resolveModelForAdapter } from './model-selection'
import { buildOpencodeConfigContent, resolveDefaultOpencodeModel } from './opencode-providers'
import type { AgentSession, AgentSessionConfig, AgentCommand, ApiKeyConfig, BizGraphSettings } from '@shared/types'
import { createLogger } from '../shared/logger'
import { probeCliInstalled } from './cli-probe'

export class OpenCodeAdapter extends BaseAdapter {
  readonly name = 'opencode'
  readonly version = '1.0.0'

  protected logger = createLogger('OpenCodeAdapter')

  async checkInstalled(): Promise<boolean> {
    if (await probeCliInstalled('opencode', ['--version'])) return true
    this.logger.warn('opencode CLI not found')
    return false
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('opencode')
    const session: AgentSession = {
      id: sessionId,
      adapterName: this.name,
      config: structuredClone(config),
      startTime: Date.now(),
    }
    this.registerSession(session)
    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const constraintSuffix = this.buildConstraintSuffix(session.config)

    await this.runToolAwareLoop(session, command, async (fullPrompt) => {
      const finalPrompt = constraintSuffix ? `${fullPrompt}\n${constraintSuffix}` : fullPrompt
      const settings = await this.readSettingsSafe()
      const model = this.resolveModel(session, settings)
      const env = this.buildOpencodeEnv(session, settings, model)

      // `run --format json` 是 1.x 的唯一可用接口：
      // - 1.0 时代的 `-q` 在 1.19 上会被当成未知参数 → 打一页帮助然后 exit 0，
      //   宿主拿到的是帮助文本（**静默的错误输出**，比崩溃更难查）。
      // - `--format json` 给的是 JSONL 事件流，工具轨迹由 CLI 自己产出，
      //   不再需要从人读文本里猜。
      const args: string[] = ['run', '--format', 'json']
      if (model) args.push('--model', model)
      // prompt 走位置参数：stdin 在 run 模式下不是消息入口（1.19 实测）
      args.push(finalPrompt)

      // C3：整个 CLI 进程（含它执行的工具）进入沙箱；不可用时原样 spawn。
      const launch = sandboxLaunch('opencode', {
        workspaceDir: session.config.workingDirectory,
        command: 'opencode',
        args,
      })

      const proc = spawn(launch.command, launch.args, {
        cwd: session.config.workingDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      this.processes.set(session.id, proc)
      // P0-1：只上报自己真正 spawn 的句柄，Runtime 落库后取消时按它精确回收
      if (proc.pid) this.emitProcessSpawn(session.id, { pid: proc.pid })

      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        proc.stdout?.on('data', (chunk) => chunks.push(chunk))
        proc.stderr?.on('data', (chunk) => {
          this.emitOutput({ type: 'stderr', data: chunk.toString('utf-8'), timestamp: Date.now() })
        })
        proc.on('error', reject)
        proc.on('exit', (code) => {
          if (code !== null && code !== 0) {
            this.logger.warn(`opencode exited with code ${code}`)
          }
          const stdout = Buffer.concat(chunks).toString('utf-8')
          const events = parseEventStream(stdout)

          // 参数被拒时 CLI 会打帮助页并 exit 0；把它当成功会让上层显示「完成」。
          // 这条检查是为 `-q` 那次事故留的护栏：宁可报错，也不要静默的错误输出。
          if (events.length === 0 && looksLikeHelpPage(stdout)) {
            this.emitOutput({
              type: 'error',
              data: 'opencode 没有识别启动参数（stdout 是帮助页而不是事件流）。请确认 CLI 版本 ≥ 1.0',
              timestamp: Date.now(),
            })
          }

          for (const event of events) {
            this.emitRawEvent(session.id, 'opencode', { kind: 'json', event })
          }
          // D3：one-shot stdout 整体透传（只读旁路）。结构化消费方取 kind:'json'，
          // 这条只给旧路径与排障用。
          this.emitRawEvent(session.id, 'opencode', { kind: 'stdout', text: stdout, exitCode: code })
          resolve(events.map(assistantTextOf).filter(Boolean).join('\n') || stdout)
        })
      })
    })
  }

  /**
   * 读设置，读不到就当「什么都没配」。
   *
   * `readSettings()` 依赖 Electron 的 `app.getPath('userData')`：在单测、CLI
   * 自检、以及主进程早期都可能还没有 app 对象。模型解析不该把一次会话搞挂 ——
   * 没有设置时退回 opencode 自己的配置，本来就是合法状态。
   */
  private async readSettingsSafe(): Promise<OpencodeSettingsView> {
    try {
      const { readSettings } = await import('../settings')
      const settings = await readSettings()
      return {
        defaultModels: settings.defaultModels,
        defaultModel: settings.defaultModel,
        apiKeys: settings.apiKeys ?? [],
      }
    } catch (error) {
      this.logger.warn(`readSettings unavailable, falling back to opencode defaults: ${(error as Error).message}`)
      return { apiKeys: [] }
    }
  }

  /**
   * 模型解析：会话显式指定 > 设置里的 opencode 档位 > 「有哪家国内 key 就用哪家默认」。
   *
   * 刻意**不**回落到 `settings.defaultModel`：那个字段里通常是 claude 模型名，
   * opencode 拿到 `claude-3-7-sonnet` 这种不带 provider 前缀的值只会在启动时报错。
   */
  private resolveModel(session: AgentSession, settings: OpencodeSettingsView): string | undefined {
    if (session.config.model) return session.config.model
    return resolveModelForAdapter(settings, 'opencode') ?? resolveDefaultOpencodeModel(settings.apiKeys)
  }

  /**
   * 把设置里的国内 key 注入成 opencode 的 provider 配置。
   *
   * 走 `OPENCODE_CONFIG_CONTENT`（内联 JSON）而不是写文件：用户的
   * `~/.config/opencode/opencode.json` 是他自己的东西，宿主不该改；
   * 而且这样「填了 key 就能用」，不必再去跑一遍 `opencode auth login`。
   * 没配任何兼容 key 时不设这个变量，让 opencode 用自身配置（本地 Ollama、
   * 自带免费模型、或用户自己登录过的厂商都照旧）。
   */
  private buildOpencodeEnv(
    session: AgentSession,
    settings: OpencodeSettingsView,
    model: string | undefined,
  ): NodeJS.ProcessEnv {
    const env = this.buildSessionEnv(session.id)
    const content = buildOpencodeConfigContent(settings.apiKeys, model)
    if (!content) return env
    return { ...env, OPENCODE_CONFIG_CONTENT: content }
  }

  /**
   * 构建强制约束后缀
   * 在白名单模式下追加明确的禁止指令，增强 prompt 约束力
   */
  private buildConstraintSuffix(config: AgentSessionConfig): string {
    if (config.allowedFiles.length === 0) return ''

    return [
      '## ⚠️ 强制约束',
      `- 只能修改白名单中的文件：${config.allowedFiles.join(', ')}`,
      '- 禁止使用 Bash 命令修改白名单外的文件（如 mv、cp、sed、echo 重定向等）',
      '- 如果需要修改白名单外的文件，先向用户说明原因并请求授权',
      '',
    ].join('\n')
  }
}

/**
 * 适配器真正用到的那几个设置字段。读不到设置时也能构造一个空壳。
 */
type OpencodeSettingsView = Pick<BizGraphSettings, 'defaultModels' | 'defaultModel'> & {
  apiKeys: ApiKeyConfig[]
}

/**
 * 把 stdout 解析成事件数组。
 *
 * 容忍混杂输出：CLI 偶尔会在 JSON 之外打提示行（升级提醒之类），
 * 非 JSON 行直接丢弃 —— 宁可少一条事件，也不要因为一行噪声让整个回合失败。
 */
export function parseEventStream(stdout: string): Array<Record<string, unknown> & { type?: string }> {
  const events: Array<Record<string, unknown> & { type?: string }> = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') {
        events.push(parsed as Record<string, unknown> & { type?: string })
      }
    } catch {
      // 半行 JSON（进程被杀时常见）—— 丢弃
    }
  }
  return events
}

/** 参数被拒时 CLI 打的是帮助页：有 Commands: 段、但没有一行事件。 */
export function looksLikeHelpPage(stdout: string): boolean {
  return /^\s*Commands:/m.test(stdout) && /opencode\s+(run|\[project\])/m.test(stdout)
}

function assistantTextOf(event: { type?: string; part?: unknown }): string {
  if (event.type !== 'text') return ''
  const part = event.part as { text?: unknown } | undefined
  return typeof part?.text === 'string' ? part.text : ''
}
