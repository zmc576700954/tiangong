/**
 * 跨进程测试辅助：用 esbuild 把真实 TS 模块打成 CJS，再交给 Node 子进程执行。
 * 目的：lease / SIGKILL 这类验收必须由真实进程完成，不用 mock 假装。
 */

import { execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PROJECT_ROOT = process.cwd()
export const ESBUILD_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'esbuild')
export const NODE_SQLITE_FALLBACK = path.join(
  PROJECT_ROOT,
  'spikes',
  'agent-core',
  'node_modules',
  'better-sqlite3',
)

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * 把一段 TS 入口源码打进 CJS。入口里的 import 路径必须是绝对路径，
 * 这样打包产物不依赖测试文件的相对位置。
 */
export function buildChildEntry(name: string, source: string, dir = makeTempDir('w5-child-')): string {
  const entry = path.join(dir, `${name}.ts`)
  const outfile = path.join(dir, `${name}.cjs`)
  fs.writeFileSync(entry, source)
  execFileSync(
    ESBUILD_BIN,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${outfile}`,
      '--log-level=error',
    ],
    { cwd: PROJECT_ROOT, stdio: 'pipe' },
  )
  return outfile
}

/** 等待子进程 stdout 出现匹配文本；超时或提前退出时 reject。 */
export function waitForStdout(child: ChildProcess, matcher: RegExp, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`child stdout timeout; received: ${buffer.slice(-200)}`))
    }, timeoutMs)
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      if (matcher.test(buffer)) {
        cleanup()
        resolve(buffer)
      }
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`child exited before match (code=${code}, signal=${signal}); output: ${buffer.slice(-200)}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout?.on('data', onData)
    child.on('exit', onExit)
  })
}

export function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    const timer = setTimeout(() => reject(new Error('child exit timeout')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}
