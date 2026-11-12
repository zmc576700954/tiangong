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
import { errorTextOf } from '../agent/runtime/normalize/opencode'
import {
  OpencodeServeClient,
  bridgePermission,
  toStreamEvent,
  type ServePermissionAsked,
} from './opencode-serve'
import type { AgentSession, AgentSessionConfig, AgentCommand, ApiKeyConfig, BizGraphSettings } from '@shared/types'
import { createLogger } from '../shared/logger'
import { probeCliInstalled } from './cli-probe'

/**
 * 执行器装进来的审批钩子，与 claude-code 的 `setTurnApprovalHooks` 同形 ——
 * `adapter-driver` 只认方法名，不认适配器类型，所以照这个签名实现即可被接线。
 */
export interface OpencodeApprovalHooks {
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message?: string }>
}

export class OpenCodeAdapter extends BaseAdapter {
  readonly name = 'opencode'
  readonly version = '1.0.0'

  protected logger = createLogger('OpenCodeAdapter')

  /**
   * 宿主安装的审批钩子（按会话）。G7-3 的分叉点：**有它**才走 `serve`。
   *
   * 反向也成立且同样重要：没有钩子时不要假装有拦截能力 —— `run` 模式里
   * 工具越界只能由 CLI 自己拒，宿主连「谁要跑什么」都来不及看。
   */
  private readonly approvalHooks = new Map<string, OpencodeApprovalHooks>()

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
    const hooks = this.approvalHooks.get(session.id)
    const settings = await this.readSettingsSafe()
    const model = this.resolveModel(session, settings)

    // G7-3：有审批网关时走 `serve`（能真的「问了再放行」），没有时保持 `run`。
    // 两个方向都不静默降级：run 模式下工具一旦越界只能被 CLI 直接拒掉，
    // 而 serve 起不来时**照样报错**，绝不退回不被审批的通道。
    if (hooks?.canUseTool) {
      await this.runServeTurn(session, command, constraintSuffix, settings, model, hooks.canUseTool)
      return
    }

    await this.runToolAwareLoop(session, command, async (fullPrompt) => {
      const finalPrompt = constraintSuffix ? `${fullPrompt}\n${constraintSuffix}` : fullPrompt
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

          // 非零退出时把 CLI 给的那句话抬到输出流。退出码本身不解释原因，
          // 而实机错误体（`error.data.message` + `ref`）只有这里读得到 ——
          // 不抬上去，用户就只能看到「exit code 1」加一句「查 server 日志」。
          if (code !== null && code !== 0) {
            const reason = events
              .filter((event) => event.type === 'error')
              .map((event) => errorTextOf(event.error))
              .filter((text): text is string => Boolean(text))
              .at(-1)
            this.emitOutput({
              type: 'error',
              data: formatRunFailure(reason ?? `opencode 以退出码 ${code} 结束`, model),
              timestamp: Date.now(),
            })
          }

          for (const event of events) {
            this.emitRawEvent(session.id, 'opencode', { kind: 'json', event })
          }          // D3：one-shot stdout 整体透传（只读旁路）。结构化消费方取 kind:'json'，
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
   * 装/卸本回合的审批钩子。执行器按会话调用，回合结束传 `null`。
   *
   * 存在性本身就是开关：装上 → 走 `serve`（每次工具调用先问宿主）；
   * 卸掉 → 回到 `run`（工具由 CLI 自己按规则拒/放）。
   */
  setTurnApprovalHooks(sessionId: string, hooks: OpencodeApprovalHooks | null): void {
    if (hooks?.canUseTool) this.approvalHooks.set(sessionId, hooks)
    else this.approvalHooks.delete(sessionId)
  }

  /**
   * G7-3：`serve` 回合 —— 唯一能「问了再放行」的路径。
   *
   * 与 `run` 模式的差别不是实现细节，而是能力：
   * - `run`：CLI 自己判权限，`ask` 等于直接拒（`auto-rejecting`），宿主只能看结果；
   * - `serve`：CLI 通过 `permission.asked` 把「要跑什么」交出来，宿主决定后
   *   用 `/permission/{id}/reply` 回 `once`，工具**真的会执行**（v3.31 实测）。
   *
   * 事件在发出去之前被翻译成 `run --format json` 的方言（`tool_use` / `text` /
   * `error`），所以下游归一化器、执行器、审计都不用为这条路径写第二套实现。
   *
   * 已知边界：serve 路径**不注入内联子代理工具提示**（`dispatch_subagent` /
   * `delegate_recipe`）。那两个是 run 模式下由宿主在文本里约定的伪工具，
   * serve 里模型用的是 opencode 自己的工具集；要接子代理得走它的 `task` 工具，
   * 与宿主的 SubagentManager 目前没有映射关系。
   */
  private async runServeTurn(
    session: AgentSession,
    command: AgentCommand,
    constraintSuffix: string,
    settings: OpencodeSettingsView,
    model: string | undefined,
    decide: NonNullable<OpencodeApprovalHooks['canUseTool']>,
  ): Promise<void> {
    const cwd = session.config.workingDirectory
    const prompt = [
      this.buildScopePromptForSession(session),
      this.buildTurnContext(session),
      this.buildCommandPromptForSession(session, command),
      constraintSuffix,
    ]
      .filter((part) => Boolean(part && part.trim()))
      .join('\n\n')

    const env = this.buildOpencodeEnv(session, settings, model)
    const args = ['serve', '--port', '0', '--hostname', '127.0.0.1']
    // serve 与 run 同属我们自己 spawn 的 CLI 进程，沙箱边界一致
    const launch = sandboxLaunch('opencode', { workspaceDir: cwd, command: 'opencode', args })

    const client = await OpencodeServeClient.start({
      plan: { command: launch.command, args: launch.args, cwd, env },
      log: (message) => this.logger.info(message),
    })
    if (client.pid) {
      this.processes.set(session.id, client.childRef)
      this.emitProcessSpawn(session.id, { pid: client.pid })
    }
    // 审批钩子需要 signal：回合结束时，还卡在「等用户点按钮」的决策要一起结束
    const turnAbort = new AbortController()

    try {
      const { id } = await client.createSession({ directory: cwd, model, title: 'bizgraph turn' })
      const pendingDecisions: Promise<void>[] = []

      const unsubscribe = client.subscribe((event) => {
        if (event.type === 'permission.asked') {
          const asked = event.properties as unknown as ServePermissionAsked
          this.emitOutput({
            type: 'stderr',
            data: `[opencode] 请求审批：${asked.permission} ${(asked.patterns ?? []).join(' ')}`.trim(),
            timestamp: Date.now(),
          })
          // 决策不能阻塞 SSE 读取：钩子内部要等用户点按钮，可能几十秒
          pendingDecisions.push(
            (async () => {
              const decision = await bridgePermission(asked, decide, turnAbort.signal)
              await client.replyPermission(asked.id, decision.reply, decision.message)
            })().catch((error: unknown) => {
              this.logger.warn(`permission reply failed: ${(error as Error).message}`)
            }),
          )
          return
        }
        const translated = toStreamEvent(event)
        if (translated) {
          this.emitRawEvent(session.id, 'opencode', { kind: 'json', event: translated })
        }
      })

      try {
        await client.prompt(id, prompt, model)
      } finally {
        unsubscribe()
        // 收尾还没回完的审批：宁可多等一会儿，也不要留下「问了但没答」的悬挂请求
        await Promise.allSettled(pendingDecisions)
      }

      // serve 流里没有 `step_finish`：token 从会话终态取，别用字符数估。
      // 字段名要对齐归一化器的读法（`tokens.input` / `tokens.output`）——
      // 写成 inputTokens 不会报错，只会让用量静静地变成 0。
      const usage = await client.readSessionUsage(id).catch(() => null)
      if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
        this.emitRawEvent(session.id, 'opencode', {
          kind: 'json',
          event: { type: 'step_finish', part: { tokens: { input: usage.inputTokens, output: usage.outputTokens }, cost: 0 } },
        })
      }
      this.emitRawEvent(session.id, 'opencode', { kind: 'stdout', text: '', exitCode: 0 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emitRawEvent(session.id, 'opencode', {
        kind: 'json',
        event: { type: 'error', error: { name: 'ServeTurnFailed', data: { message } } },
      })
      this.emitRawEvent(session.id, 'opencode', { kind: 'stdout', text: '', exitCode: 1 })
      throw error
    } finally {
      turnAbort.abort()
      this.processes.delete(session.id)
      await client.dispose()
    }
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

/**
 * 失败文案：CLI 原文 + 「只在确实传了 --model 时」给模型 id 的格式提示。
 *
 * 为什么不直接下结论说「模型名错了」：实机里同一条 `Unexpected server error`
 * 既可能是模型名不存在（必须先有 `provider/` 前缀 —— 裸写 `deepseek-v4.1-flash-free`
 * 会被判成 `…/.` 而失败），也可能是那家 provider 的 key 无效。提示到格式与
 * 排查入口为止，把判断留给用户。
 */
export function formatRunFailure(reason: string, model?: string): string {
  if (!model || !reason.trim()) return reason
  return [
    reason,
    `若原因是模型不可用：--model 必须是 provider/model 形式（如 opencode/deepseek-v4.1-flash-free），` +
      `当前为 ${model}；可用 \`opencode models\` 列出全部可用 id。`,
  ].join('\n')
}

function assistantTextOf(event: { type?: string; part?: unknown }): string {
  if (event.type !== 'text') return ''
  const part = event.part as { text?: unknown } | undefined
  return typeof part?.text === 'string' ? part.text : ''
}
