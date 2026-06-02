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

export async function runClaude(prompt: string, options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const { cwd, timeoutMs = 300_000, outputFormat = 'text', model = 'sonnet' } = options

  // 写入临时文件
  const tmpFile = path.join(os.tmpdir(), `bizgraph-prompt-${Date.now()}.txt`)
  fs.writeFileSync(tmpFile, prompt, 'utf-8')

  const args = ['-p', '--model', model]
  if (outputFormat === 'json') {
    args.push('--output-format', 'json')
  }

  // 构建 shell 命令: claude -p --model sonnet < tmpFile
  const isWin = process.platform === 'win32'
  const claudeCmd = `claude ${args.join(' ')} < "${tmpFile}"`

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cleanedUp = false

    const proc = isWin
      ? spawn('cmd', ['/c', claudeCmd], {
          cwd,
          env: process.env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('sh', ['-c', claudeCmd], {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
    }, timeoutMs)

    // 进度日志：每 15 秒输出一次状态
    const progressTimer = setInterval(() => {
      console.log(`[ClaudeRunner] 运行中... 已收到 ${stdout.length} 字节, 已等待 ${Math.round((Date.now() - startTime) / 1000)}s`)
    }, 15_000)
    const startTime = Date.now()

    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearTimeout(timer)
      clearInterval(progressTimer)
      try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr.on('data', (chunk: Buffer) => {
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

  throw new Error('Failed to extract JSON from Claude output')
}
