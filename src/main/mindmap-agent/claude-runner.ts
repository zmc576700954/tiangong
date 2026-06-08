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
import { AgentError, ErrorCode } from '../errors'

export interface ClaudeRunOptions {
  cwd: string
  timeoutMs?: number
  outputFormat?: 'json' | 'text'
  model?: string
}

export interface ClaudeRunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

const ALLOWED_MODELS = new Set(['sonnet', 'opus', 'haiku', 'sonnet-4', 'claude-sonnet-4-6'])

const logger = createLogger('ClaudeRunner')

export async function runClaude(prompt: string, options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const { cwd, timeoutMs = 300_000, outputFormat = 'text', model = 'sonnet' } = options

  // 验证参数，防止注入
  const safeModel = ALLOWED_MODELS.has(model) ? model : 'sonnet'
  const safeFormat = outputFormat === 'json' ? 'json' : 'text'

  // 使用不可预测的临时文件名
  const tmpFile = path.join(os.tmpdir(), `bizgraph-prompt-${randomUUID().replace(/-/g, '')}.txt`)
  await fs.promises.writeFile(tmpFile, prompt, 'utf-8')

  const args = ['-p', '--model', safeModel]
  if (safeFormat === 'json') {
    args.push('--output-format', 'json')
  }

  // 通过文件描述符重定向 stdin，避免 shell 字符串拼接
  const stdinFd = fs.openSync(tmpFile, 'r')

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cleanedUp = false

    const proc = spawn('claude', args, {
      cwd,
      env: buildSafeEnv(),
      shell: false,
      stdio: [stdinFd, 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
    }, timeoutMs)

    // 进度日志：每 15 秒输出一次状态
    const progressTimer = setInterval(() => {
      logger.info(`运行中... 已收到 ${stdout.length} 字节, 已等待 ${Math.round((Date.now() - startTime) / 1000)}s`)
    }, 15_000)
    const startTime = Date.now()

    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearTimeout(timer)
      clearInterval(progressTimer)
      try { fs.closeSync(stdinFd) } catch { /* ignore */ }
      fs.promises.unlink(tmpFile).catch(() => { /* ignore */ })
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', () => {
      cleanup()
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: -1, timedOut: false })
    })

    proc.on('close', (code) => {
      cleanup()
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
        timedOut,
      })
    })
  })
}

/**
 * 从 Claude 输出中提取 JSON
 */
export function extractJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { /* continue */ }

  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()) } catch { /* continue */ }
  }

  const jsonStart = raw.search(/[[{]/)
  const jsonEnd = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'))
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try { return JSON.parse(raw.substring(jsonStart, jsonEnd + 1)) } catch { /* give up */ }
  }

  throw new AgentError('Failed to extract JSON from Claude output', ErrorCode.AGENT_PROCESS_ERROR)
}
