/**
 * preload 白名单一致性护栏。
 *
 * 背景：`workitem:create` / `run:start` / `cancel`、`map:confirmation:decide`、
 * `plan:draft:submit`、`workitem:revise` 都出现过同一类缺陷——主进程已经注册了
 * handler，但 preload 的 `exposedChannels` 没暴露，renderer 永远调不到。
 * 根因是「主进程注册」与「preload 白名单」两处手工维护、没有一致性校验。
 *
 * 本测试以主进程 `typedHandle('<channel>', ...)` 调用点为注册事实（全仓
 * `ipcMain.handle` 只允许出现在 `ipc/utils.ts`，下面有单独断言），与 preload
 * `exposedChannels`（含 `MAP_READ_ONLY_CHANNELS` 展开）做集合断言：
 *
 * - 注册了但没暴露：必须逐条进入显式豁免名单并写明原因；漏一条就红，报错信息
 *   逐个列出通道名 + 注册位置，不允许只报「集合不相等」。
 * - 写通道一律进 `KNOWN_WRITE_WITHOUT_RENDERER_ENTRY`（已知缺口，等待逐条裁决），
 *   不允许混进「读通道刻意不暴露」的豁免里。
 * - renderer 真有调用方的通道必须已暴露：这是上述缺陷的直接形态，出现即红。
 * - preload 暴露了但主进程没注册（孤儿通道）同样红。
 *
 * 注意：本文件刻意不补任何白名单。扩大暴露面需要逐条说明用途后单独裁决。
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { MAP_READ_ONLY_CHANNELS } from '@shared/types/ipc'

const ROOT = process.cwd()
const MAIN_IPC_DIR = path.join(ROOT, 'src/main/ipc')
const MAIN_ENTRY = path.join(ROOT, 'src/main/ipc-handlers.ts')
const PRELOAD_FILE = path.join(ROOT, 'src/preload/index.ts')
const RENDERER_DIR = path.join(ROOT, 'src/renderer')

/**
 * 读通道：确实刻意不暴露给 renderer。每条写明用途 + 不暴露的原因。
 * 只允许放只读通道；写通道请放下面那张表。
 */
const INTENTIONALLY_UNEXPOSED_READ: Record<string, string> = {
  'plan:draft:get':
    '按 id 读单条草稿原文。renderer 走 plan:draft:preview / plan:draft:list 拿服务端投影后的展示项，不用原文 get。',
  'project:import:preview':
    '导入前只读预判指纹命中（preview: true，不写库）。导入确认框尚未接线，没有 renderer 调用方。',
  'project:import:allowance:list':
    '查看已记住的导入放行规则（只读）。放行规则管理界面尚未接线。',
}

/**
 * 写通道：主进程已注册、但 renderer 目前没有任何入口。
 *
 * 这些不是「刻意不暴露」，而是「还没接线」——属于已知缺口，等待逐条裁决是否
 * 开放（开放即扩大攻击面，必须先说明用途）。新出现的写通道漏暴露不在这张表里
 * 就一定红；补进来也必须写清用途。
 */
const KNOWN_WRITE_WITHOUT_RENDERER_ENTRY: Record<string, string> = {
  'admin:map:integrity-check':
    '写：巡检手动触发，会把 node_links 置 orphan/stale 并写 map_migration_reports。管理动作，无 renderer 入口。',
  'map:link:create':
    '写：创建 node_links 行。renderer 目前只有 map:link:list 只读列表，没有建链入口。',
  'plan:derive-candidates':
    '写：落派生 run / candidates。C1 走 plan:draft:*，没有直接调用派生候选的 renderer 入口。',
  'plan:draft:create':
    '写：创建计划草稿。renderer 目前只读/提交/确认既有草稿，没有「新建草稿」入口。',
  'plan:draft:revise':
    '写：修改草稿条目。renderer 未接线；注意它与 C2 的 work_item 修订不是同一条路径。',
  'project:import:allowance:revoke':
    '写：撤销导入放行规则。放行规则管理界面尚未接线。',
}

interface RegisteredChannel {
  channel: string
  /** 注册位置：`相对路径:行号`，用于报错时直接定位。 */
  sites: string[]
}

/**
 * 去掉注释但保留换行，保证行号不漂移。
 * 同时跳过字符串字面量，避免把字符串里的 `//` 当注释。
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let inBlock = false
  let inLine = false
  let quote: string | null = null

  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]

    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      } else {
        out += ' '
      }
      i += 1
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        out += '  '
        i += 2
      } else {
        out += ch === '\n' ? '\n' : ' '
        i += 1
      }
      continue
    }
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += source[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      out += '  '
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      out += '  '
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    out += ch
    i += 1
  }

  return out
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1
  }
  return line
}

function walkFiles(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, accept, out)
    } else if (accept(full)) {
      out.push(full)
    }
  }
  return out
}

/**
 * 主进程注册事实：扫描 `typedHandle('<channel>', ...)` 调用点。
 *
 * 通道名必须是字符串字面量——写成变量或模板串会让静态断言失效，所以这里
 * 把「无法解析的调用点」也作为失败返回，而不是静默跳过。
 */
function collectRegisteredChannels(): {
  channels: Map<string, RegisteredChannel>
  unparsable: string[]
} {
  const files = [
    ...fs
      .readdirSync(MAIN_IPC_DIR)
      .filter((name) => name.endsWith('.ts') && name !== 'utils.ts')
      .map((name) => path.join(MAIN_IPC_DIR, name)),
    MAIN_ENTRY,
  ]

  const channels = new Map<string, RegisteredChannel>()
  const unparsable: string[] = []

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8')
    const source = stripComments(raw)
    const relative = path.relative(ROOT, file)
    const callRe = /\btypedHandle\b\s*(?:<[^>]*>)?\s*\(/g
    let match: RegExpExecArray | null

    while ((match = callRe.exec(source)) !== null) {
      const after = source.slice(match.index + match[0].length)
      const literal = /^\s*(['"])([^'"]+)\1/.exec(after)
      const site = `${relative}:${lineOf(source, match.index)}`
      if (!literal) {
        unparsable.push(site)
        continue
      }
      const channel = literal[2]
      const existing = channels.get(channel)
      if (existing) {
        existing.sites.push(site)
      } else {
        channels.set(channel, { channel, sites: [site] })
      }
    }
  }

  return { channels, unparsable }
}

/** preload 白名单事实：解析 `exposedChannels = [...]`，含 `...MAP_READ_ONLY_CHANNELS` 展开。 */
function collectPreloadChannels(): {
  channels: Set<string>
  unknownEntries: string[]
  spreadsReadOnly: boolean
} {
  const raw = fs.readFileSync(PRELOAD_FILE, 'utf8')
  const source = stripComments(raw)
  const declaration = source.indexOf('const exposedChannels')
  expect(declaration, 'preload 里找不到 exposedChannels 声明').toBeGreaterThanOrEqual(0)
  const arrayStart = source.indexOf('= [', declaration) + 2
  expect(arrayStart, 'exposedChannels 不是数组字面量').toBeGreaterThan(1)

  let depth = 0
  let arrayEnd = -1
  for (let i = arrayStart; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1
    else if (source[i] === ']') {
      depth -= 1
      if (depth === 0) {
        arrayEnd = i
        break
      }
    }
  }
  expect(arrayEnd, 'exposedChannels 数组没有闭合').toBeGreaterThan(arrayStart)

  const body = source.slice(arrayStart + 1, arrayEnd)
  const channels = new Set<string>()
  const unknownEntries: string[] = []
  let spreadsReadOnly = false

  for (const rawEntry of body.split(',')) {
    const entry = rawEntry.replace(/\s+/g, ' ').trim()
    if (entry === '') continue
    if (entry === '...MAP_READ_ONLY_CHANNELS') {
      spreadsReadOnly = true
      for (const channel of MAP_READ_ONLY_CHANNELS) channels.add(channel)
      continue
    }
    const literal = /^(['"])([^'"]+)\1$/.exec(entry)
    if (literal) channels.add(literal[2])
    else unknownEntries.push(entry)
  }

  return { channels, unknownEntries, spreadsReadOnly }
}

/** renderer 实际调用点：`window.electronAPI['<channel>'](...)`。测试文件不计。 */
function collectRendererChannels(): Map<string, string[]> {
  const files = walkFiles(
    RENDERER_DIR,
    (file) =>
      /\.(ts|tsx)$/.test(file) &&
      !file.includes('__tests__') &&
      !/\.test\.(ts|tsx)$/.test(file),
  )
  const channels = new Map<string, string[]>()
  for (const file of files) {
    const source = stripComments(fs.readFileSync(file, 'utf8'))
    for (const match of source.matchAll(/electronAPI\s*\[\s*(['"])([^'"]+)\1\s*\]/g)) {
      const channel = match[2]
      const relative = path.relative(ROOT, file)
      const sites = channels.get(channel)
      if (sites) sites.push(relative)
      else channels.set(channel, [relative])
    }
  }
  return channels
}

function describeChannels(entries: Array<{ channel: string; detail: string }>): string {
  return entries.map((entry) => `  - ${entry.channel}（${entry.detail}）`).join('\n')
}

describe('preload 白名单一致性护栏', () => {
  it('typedHandle 通道名必须是字符串字面量（否则静态断言失效）', () => {
    const { unparsable } = collectRegisteredChannels()
    expect(
      unparsable,
      `以下 typedHandle 调用无法解析出字符串字面量通道名，请改成字面量：\n${unparsable
        .map((site) => `  - ${site}`)
        .join('\n')}`,
    ).toEqual([])
  })

  it('ipcMain.handle 只允许出现在 ipc/utils.ts（防止绕过 typedHandle 登记）', () => {
    const files = walkFiles(
      path.join(ROOT, 'src/main'),
      (file) => file.endsWith('.ts') && !file.includes('__tests__') && !file.endsWith('.test.ts'),
    )
    const offenders: string[] = []
    for (const file of files) {
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      if (/ipcMain\.handle\s*\(/.test(source)) {
        const relative = path.relative(ROOT, file)
        if (relative !== path.join('src/main/ipc/utils.ts')) offenders.push(relative)
      }
    }
    expect(
      offenders,
      `ipcMain.handle 绕过 typedHandle，注册事实将与白名单断言脱节：\n${offenders
        .map((file) => `  - ${file}`)
        .join('\n')}`,
    ).toEqual([])
  })

  it('主进程注册的通道必须已暴露，或逐条进入显式豁免名单', () => {
    const { channels: registered } = collectRegisteredChannels()
    const { channels: exposed, unknownEntries, spreadsReadOnly } = collectPreloadChannels()

    expect(
      unknownEntries,
      `preload exposedChannels 存在无法识别的条目（只允许字符串字面量或 ...MAP_READ_ONLY_CHANNELS）：\n${unknownEntries
        .map((entry) => `  - ${entry}`)
        .join('\n')}`,
    ).toEqual([])
    expect(spreadsReadOnly, 'exposedChannels 丢失了 ...MAP_READ_ONLY_CHANNELS 展开').toBe(true)

    const exemptions = {
      ...INTENTIONALLY_UNEXPOSED_READ,
      ...KNOWN_WRITE_WITHOUT_RENDERER_ENTRY,
    }

    const uncovered = [...registered.values()]
      .filter((entry) => !exposed.has(entry.channel))
      .sort((a, b) => a.channel.localeCompare(b.channel))

    const unexpected = uncovered.filter((entry) => !(entry.channel in exemptions))
    expect(
      unexpected,
      `以下 ${unexpected.length} 个通道已在主进程注册，但 preload 没有暴露，也没有显式豁免：\n` +
        describeChannels(
          unexpected.map((entry) => ({ channel: entry.channel, detail: entry.sites.join(', ') })),
        ) +
        '\n写通道漏暴露会让 renderer 永远调不到（历史缺陷形态）。若确属刻意不暴露，' +
        '加入 INTENTIONALLY_UNEXPOSED_READ 并写明原因；写通道加入 ' +
        'KNOWN_WRITE_WITHOUT_RENDERER_ENTRY 并写明用途。',
    ).toEqual([])

    // 反向：白名单里的通道必须在主进程真的注册了，否则 renderer 调用会得到
    // “No handler registered for ...” 的运行时错误。
    const orphans = [...exposed].filter((channel) => !registered.has(channel)).sort()
    expect(
      orphans,
      `preload 暴露了主进程没有注册的通道：\n${orphans.map((channel) => `  - ${channel}`).join('\n')}`,
    ).toEqual([])
  })

  it('豁免名单不得过期（通道仍注册、仍未暴露、原因非空）', () => {
    const { channels: registered } = collectRegisteredChannels()
    const { channels: exposed } = collectPreloadChannels()

    const stale: string[] = []
    const badReason: string[] = []
    for (const [channel, reason] of [
      ...Object.entries(INTENTIONALLY_UNEXPOSED_READ),
      ...Object.entries(KNOWN_WRITE_WITHOUT_RENDERER_ENTRY),
    ]) {
      if (!registered.has(channel)) stale.push(`${channel}（主进程已无此 handler）`)
      if (exposed.has(channel)) stale.push(`${channel}（已在 preload 暴露，应从豁免名单删除）`)
      if (reason.trim() === '') badReason.push(channel)
    }

    expect(
      stale,
      `豁免名单过期，请逐条更新：\n${stale.map((entry) => `  - ${entry}`).join('\n')}`,
    ).toEqual([])
    expect(
      badReason,
      `豁免必须写明原因：\n${badReason.map((entry) => `  - ${entry}`).join('\n')}`,
    ).toEqual([])
  })

  it('renderer 实际调用的通道必须已暴露且已注册（断头检测）', () => {
    const { channels: registered } = collectRegisteredChannels()
    const { channels: exposed } = collectPreloadChannels()
    const used = collectRendererChannels()

    const blocked = [...used.entries()]
      .filter(([channel]) => !exposed.has(channel))
      .sort(([a], [b]) => a.localeCompare(b))
    expect(
      blocked,
      `renderer 有调用方、preload 却没暴露（renderer 永远调不到）：\n${describeChannels(
        blocked.map(([channel, files]) => ({ channel, detail: files.join(', ') })),
      )}`,
    ).toEqual([])

    const unregistered = [...used.entries()]
      .filter(([channel]) => !registered.has(channel))
      .sort(([a], [b]) => a.localeCompare(b))
    expect(
      unregistered,
      `renderer 调用了主进程未注册的通道：\n${describeChannels(
        unregistered.map(([channel, files]) => ({ channel, detail: files.join(', ') })),
      )}`,
    ).toEqual([])
  })
})
