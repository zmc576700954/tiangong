import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * 守卫：**渲染层用到的每个 IPC 通道，preload 都必须暴露。**
 *
 * 背景：这个 bug 真的发生过 —— 新增了 `project:getDefaults` /
 * `project:setDefaults` 两个通道，在主进程注册了、在 `IpcApi` 里声明了、
 * 在渲染层调用了，**唯独忘了加进 preload 的 `exposedChannels`**。
 *
 * 后果在渲染端是静默的：
 * - `window.electronAPI['project:getDefaults']` 是 `undefined` → 调用抛 TypeError；
 *   被 try/catch 吞掉 → 功能静默失效（范围记忆读不到）
 * - `saveProjectDefaults` 没有 catch → **unhandled rejection**
 *   —— 正是这个工作流要消灭的那类失败。
 *
 * 而单元测试**测不出来**：它们整体 mock 了 `window.electronAPI`，
 * 从不检查通道是否真被 preload 暴露。所以这里做**源码级**的交叉核对。
 */

const REPO_ROOT = path.resolve(__dirname, '../../..')
const PRELOAD_PATH = path.join(REPO_ROOT, 'src/preload/index.ts')
const RENDERER_DIR = path.join(REPO_ROOT, 'src/renderer')

/** 递归列出渲染层里所有非测试的 .ts / .tsx */
function collectRendererSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      // 测试目录跳过 —— 它们自带 mock，不反映真实通道使用
      if (entry === '__tests__' || entry === 'node_modules') continue
      collectRendererSources(full, acc)
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    acc.push(full)
  }
  return acc
}

describe('preload 的通道暴露', () => {
  const preloadSrc = readFileSync(PRELOAD_PATH, 'utf8')

  // exposedChannels 数组里的字面量
  const arrayMatch = preloadSrc.match(/const exposedChannels[^=]*=\s*\[([\s\S]*?)\n\]/)
  const exposedChannels = new Set<string>(
    (arrayMatch?.[1] ?? '').match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [],
  )

  // contextBridge.exposeInMainWorld 块里手动暴露的键（on* 监听器等）
  const manualBlock = preloadSrc.match(/exposeInMainWorld\('electronAPI',\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const manualKeys = new Set<string>(
    manualBlock.match(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)?.map((s) => s.trim().replace(':', '')) ?? [],
  )

  it('preload 的 exposedChannels 不是空的（解析没失效）', () => {
    expect(exposedChannels.size).toBeGreaterThan(20)
    expect(manualKeys.size).toBeGreaterThan(0)
  })

  it('渲染层用到的每个 IPC 通道都被 preload 暴露了', () => {
    const sources = collectRendererSources(RENDERER_DIR)
    expect(sources.length).toBeGreaterThan(20)

    const missing = new Map<string, string[]>()
    for (const file of sources) {
      const src = readFileSync(file, 'utf8')
      const relative = path.relative(REPO_ROOT, file)

      // 两种调用形态：electronAPI['channel'] 与 electronAPI.channel
      const bracket = src.match(/electronAPI\['([^']+)'\]/g) ?? []
      const dot = src.match(/electronAPI\.([A-Za-z_][A-Za-z0-9_]*)/g) ?? []

      for (const raw of [...bracket, ...dot]) {
        const channel = raw.startsWith('electronAPI[')
          ? raw.slice("electronAPI['".length, -2)
          : raw.slice('electronAPI.'.length)
        if (exposedChannels.has(channel) || manualKeys.has(channel)) continue
        const list = missing.get(channel) ?? []
        list.push(relative)
        missing.set(channel, list)
      }
    }

    // 漏暴露的通道 → renderer 调用时是 undefined → TypeError 或静默失效
    expect(
      [...missing.entries()].map(([ch, files]) => `${ch}（${files.join(', ')}）`),
    ).toEqual([])
  })

  it('本特性新增的两个通道确实被暴露了', () => {
    // 这两个是范围记忆功能的读写入口 —— 漏了会让功能静默失效
    expect(exposedChannels.has('project:getDefaults')).toBe(true)
    expect(exposedChannels.has('project:setDefaults')).toBe(true)
  })
})
