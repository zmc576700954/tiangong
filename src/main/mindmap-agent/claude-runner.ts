/**
 * Claude 子进程封装
 *
 * 使用临时文件 + shell 重定向方式传入 prompt（避免 stdin 管道对长 prompt 的兼容性问题）。
 * Windows: cmd /c claude -p --model sonnet < tmpFile
 * Unix:    sh -c 'claude -p --model sonnet < tmpFile'
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildSafeEnv } from '../shared/env'
import { createLogger } from '../shared/logger'
import { getPlatformProvider } from '../platform'
import { AgentError, ErrorCode } from '../errors'
import { supportsDisallowedTools } from './cli-capabilities'

export interface ClaudeRunOptions {
  cwd: string
  timeoutMs?: number
  outputFormat?: 'json' | 'text'
  model?: string
  /** JSON Schema to enforce structured output when outputFormat is 'json' */
  jsonSchema?: object
  /** Cancels the run: the child process is killed and the promise settles. */
  signal?: AbortSignal
  /**
   * 允许 CLI 写文件。默认禁止。
   *
   * runClaude 的所有调用方（思维导图生成、节点细化、社区摘要）都是
   * 「读项目 → 输出 JSON」的流程，从不需要写盘。但 `claude` CLI 默认带着
   * Write/Edit 工具：项目里被扫描到的注入文本（README 里的「顺手把配置写到
   * ~/.ssh/authorized_keys」）能借模型的写工具真的落到磁盘上。显式禁掉写工具，
   * 把「只能读」变成 CLI 层面的硬约束，而不是指望权限弹窗 —— print 模式下
   * 没有人应答弹窗，用户全局 settings 里的权限模式还会改变结果。
   */
  allowWrites?: boolean
}

export interface ClaudeRunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /** True when the run was cancelled through `signal`. */
  aborted?: boolean
}

const ALLOWED_MODELS = new Set(['sonnet', 'opus', 'haiku', 'sonnet-4', 'claude-sonnet-4-6'])

/** 生成类流程用不到的工具：写文件与改文件 */
const WRITE_TOOLS = 'Write Edit NotebookEdit'

const logger = createLogger('ClaudeRunner')

/**
 * 组装 CLI 参数。
 *
 * 导出是为了能直接断言「生成流程不会带写工具」—— 这是一条安全边界，
 * 不该只能靠跑一次真实生成来验证。
 */
export function buildClaudeArgs(options: ClaudeRunOptions): string[] {
  const model = options.model ?? 'sonnet'
  // 验证参数，防止注入
  const safeModel = ALLOWED_MODELS.has(model) ? model : 'sonnet'
  const safeFormat = options.outputFormat === 'json' ? 'json' : 'text'

  const args = ['-p', '--model', safeModel]
  if (safeFormat === 'json') {
    args.push('--output-format', 'json')
  }
  if (!options.allowWrites && supportsDisallowedTools()) {
    args.push('--disallowedTools', WRITE_TOOLS)
  }
  return args
}

export async function runClaude(prompt: string, options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const { cwd, timeoutMs = 300_000, outputFormat = 'text', jsonSchema } = options

  // 验证参数，防止注入
  const safeFormat = outputFormat === 'json' ? 'json' : 'text'

  // 当 outputFormat 为 json 且提供了 jsonSchema 时，追加结构化输出约束
  let finalPrompt = prompt
  if (safeFormat === 'json' && jsonSchema) {
    finalPrompt = `${prompt}\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}\nDo not include any text outside the JSON.`
  }

  // 使用不可预测的临时文件名
  const tmpFile = path.join(os.tmpdir(), `bizgraph-prompt-${randomUUID().replace(/-/g, '')}.txt`)
  await fs.promises.writeFile(tmpFile, finalPrompt, { encoding: 'utf-8', mode: 0o600 })

  const args = buildClaudeArgs(options)

  // 通过文件描述符重定向 stdin，避免 shell 字符串拼接
  const stdinFd = fs.openSync(tmpFile, 'r')

  // 已经取消的 signal：'abort' 事件早已触发，addEventListener 不会再回调它，
  // 不提前检查的话这次调用会一路跑到超时才结束。写文件是一次 await，取消正好
  // 可能落在这段窗口里 —— 所以查两次：写之前（由调用方传入）与写之后。
  if (options.signal?.aborted) {
    try { fs.closeSync(stdinFd) } catch { /* ignore */ }
    await fs.promises.unlink(tmpFile).catch(() => { /* ignore */ })
    return { stdout: '', stderr: 'Run aborted before start', exitCode: -1, timedOut: false, aborted: true }
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let cleanedUp = false
    let killTimer: NodeJS.Timeout | undefined

    // Windows: `claude` is an npm .cmd shim, which CreateProcess cannot resolve
    // on its own; other platforms spawn the binary directly.
    const proc = spawn('claude', args, {
      cwd,
      env: buildSafeEnv('claude-code'),
      ...getPlatformProvider().getShellConfig(),
      stdio: [stdinFd, 'pipe', 'pipe'],
    })

    const killChild = (signal: NodeJS.Signals) => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal)
      } catch { /* ignore */ }
    }

    /** SIGTERM first, SIGKILL if the child ignores it — otherwise the promise never settles. */
    const terminateChild = () => {
      killChild('SIGTERM')
      killTimer = setTimeout(() => killChild('SIGKILL'), 5000)
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminateChild()
    }, timeoutMs)

    const onAbort = () => {
      // 子进程已经自己退出了（Node 先发 'exit' 再发 'close'，close 还要等 stdio
      // 排空，可能被孙进程拖住）：这次取消根本没送到进程，产物是完整的。
      // 此时若仍标 aborted，适配器会把已经生成好的结果当成取消丢掉。
      if (proc.exitCode === null && proc.signalCode === null) {
        aborted = true
        terminateChild()
      }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // 进度日志：每 15 秒输出一次状态
    const progressTimer = setInterval(() => {
      logger.info(`运行中... 已收到 ${stdout.length} 字节, 已等待 ${Math.round((Date.now() - startTime) / 1000)}s`)
    }, 15_000)
    const startTime = Date.now()

    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      clearInterval(progressTimer)
      options.signal?.removeEventListener('abort', onAbort)
      try { fs.closeSync(stdinFd) } catch { /* ignore */ }
      fs.promises.unlink(tmpFile).catch(() => { /* ignore */ })
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', (err) => {
      cleanup()
      resolve({
        stdout: stdout.trim(),
        stderr: `${stderr}\n${err.message}`.trim(),
        exitCode: -1,
        timedOut,
        aborted,
      })
    })

    proc.on('close', (code) => {
      cleanup()
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
        timedOut,
        aborted,
      })
    })
  })
}

/**
 * 找到 text[start] 处括号对应的闭合位置（忽略字符串内的括号），找不到返回 -1。
 */
function findMatchingEnd(text: string, start: number): number {
  const open = text[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 兜底扫描时最多尝试的起始位置数，避免病态输入下的 O(n²) 开销。 */
const MAX_JSON_CANDIDATES = 100

/**
 * 从 Claude 输出中提取 JSON
 */
export function extractJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { /* continue */ }

  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()) } catch { /* continue */ }
  }

  // 兜底：扫描所有 '[' / '{' 起点逐个尝试。
  // 不能「第一个能 parse 的就是答案」—— 模型输出里到处是合法 JSON 碎片：
  // 工作目录里的 `[1]`、进度里的 `[2]`、`[0]`。它们同样能 parse，会抢在真正
  // 的载荷前面被选中，随后 validateModules([1]) 返回空数组，表现为「AI 没返回
  // 有效模块」这种没法定位的失败。
  // 规则：取源码最长的候选（真正的载荷一定比碎片长），长度相同时优先普通对象。
  let best: { value: unknown; length: number; isObject: boolean } | null = null
  let scanned = 0
  for (let i = 0; i < raw.length && scanned < MAX_JSON_CANDIDATES; i++) {
    const ch = raw[i]
    if (ch !== '[' && ch !== '{') continue
    scanned++
    const end = findMatchingEnd(raw, i)
    if (end < 0) continue
    const slice = raw.slice(i, end + 1)
    let value: unknown
    try {
      value = JSON.parse(slice)
    } catch {
      continue
    }
    const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
    const length = slice.length
    if (
      !best ||
      length > best.length ||
      (length === best.length && isObject && !best.isObject)
    ) {
      best = { value, length, isObject }
    }
  }
  if (best) return best.value

  throw new AgentError('Failed to extract JSON from Claude output', ErrorCode.AGENT_PROCESS_ERROR)
}
