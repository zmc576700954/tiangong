#!/usr/bin/env node
/**
 * 打包后校验：确认 agent 运行时依赖的 JS 入口、CLI 与原生模块都真的在产物里。
 *
 * 用法：
 *   node scripts/verify-packaged-agent-runtime.mjs                 # 自动找 release/*\/BizGraph.app
 *   node scripts/verify-packaged-agent-runtime.mjs --app <path>    # 指定 .app（可多次）
 *
 * 失败时逐条打印「检查项 / 期望路径 / 实际路径」，退出码 1。
 * 期望 CLI 版本优先取本机 node_modules 里的同款二进制输出，避免升级 SDK 后硬编码版本过期。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { listPackage } = require('@electron/asar')

const REQUIRED_ASAR_ENTRIES = [
  '/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  '/node_modules/@openai/codex-sdk/dist/index.js',
]

const FALLBACK_VERSIONS = {
  claude: process.env.EXPECTED_CLAUDE_VERSION ?? '2.1.286',
  codex: process.env.EXPECTED_CODEX_VERSION ?? '0.135.0',
}

function findFile(root, predicate, depth = 0, maxDepth = 8) {
  if (depth > maxDepth || !fs.existsSync(root)) return null
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && predicate(full)) return full
    if (entry.isDirectory()) {
      const nested = findFile(full, predicate, depth + 1, maxDepth)
      if (nested) return nested
    }
  }
  return null
}

function runVersion(binary) {
  return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim().split('\n')[0]
}

/** 期望版本：取源码树里同款二进制的输出；拿不到再退回常量。 */
function expectedVersion(kind) {
  const root = path.resolve(kind === 'claude' ? 'node_modules/@anthropic-ai' : 'node_modules/@openai')
  const sourceBinary = findFile(root, (file) => path.basename(file) === kind)
  if (sourceBinary) {
    try {
      return { value: runVersion(sourceBinary), from: sourceBinary }
    } catch {
      // 源码二进制不可执行时退回常量，不把它当产物失败。
    }
  }
  return { value: FALLBACK_VERSIONS[kind], from: '(fallback 常量)' }
}

function findApps(explicit) {
  if (explicit.length > 0) return explicit.map((item) => path.resolve(item))
  const release = path.resolve('release')
  if (!fs.existsSync(release)) return []
  return fs
    .readdirSync(release)
    .map((dir) => path.join(release, dir, 'BizGraph.app'))
    .filter((app) => fs.existsSync(app))
    .sort()
}

function verifyApp(app) {
  const failures = []
  const passes = []
  const fail = (check, expected, actual) => failures.push({ check, expected, actual })

  if (!fs.existsSync(app)) {
    fail('产物目录', app, '不存在')
    return { failures, passes }
  }

  const resources = path.join(app, 'Contents', 'Resources')
  const asar = path.join(resources, 'app.asar')
  const unpacked = path.join(resources, 'app.asar.unpacked')

  if (!fs.existsSync(asar)) {
    fail('app.asar', asar, '不存在')
    return { failures, passes }
  } else {
    passes.push(`app.asar 存在：${asar}`)
  }

  // 1) asar 内必需 JS 入口
  let entries = []
  try {
    entries = listPackage(asar)
    passes.push(`app.asar 条目可读：${entries.length} 条`)
  } catch (error) {
    fail('app.asar 可读', 'listPackage 成功', error instanceof Error ? error.message : String(error))
  }
  for (const entry of REQUIRED_ASAR_ENTRIES) {
    if (entries.includes(entry)) {
      passes.push(`asar 入口存在：${entry}`)
    } else {
      fail('asar JS 入口', `${asar} 内含 ${entry}`, `未找到（条目数 ${entries.length}）`)
    }
  }

  // 2) unpacked 内 CLI 可执行且版本匹配
  for (const kind of ['claude', 'codex']) {
    const expected = expectedVersion(kind)
    const binary = findFile(path.join(unpacked, 'node_modules'), (file) => path.basename(file) === kind)
    if (!binary) {
      fail(`${kind} 可执行文件`, `${unpacked}/node_modules/**/${kind}`, '未找到')
      continue
    }
    try {
      fs.accessSync(binary, fs.constants.X_OK)
    } catch {
      fail(`${kind} 可执行权限`, `${binary} 可执行`, '不可执行')
      continue
    }
    try {
      const actual = runVersion(binary)
      if (actual.includes(expected.value)) {
        passes.push(`${kind} --version：${actual}（期望含 ${expected.value}，来源 ${expected.from}）`)
      } else {
        fail(`${kind} --version`, `输出含 ${expected.value}（来源 ${expected.from}）`, actual)
      }
    } catch (error) {
      fail(`${kind} --version`, '退出码 0', error instanceof Error ? error.message : String(error))
    }
  }

  // 3) 关键原生模块
  const nativeChecks = [
    {
      check: 'better-sqlite3 原生模块',
      file: path.join(unpacked, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    },
    {
      check: 'onnxruntime 原生模块（当前平台/架构）',
      file: path.join(
        unpacked,
        'node_modules/onnxruntime-node/bin/napi-v3',
        process.platform,
        process.arch,
        'onnxruntime_binding.node',
      ),
    },
  ]
  for (const item of nativeChecks) {
    if (fs.existsSync(item.file)) {
      passes.push(`${item.check}存在：${item.file}`)
    } else {
      fail(item.check, item.file, '未找到')
    }
  }

  return { failures, passes }
}

const argv = process.argv.slice(2)
const explicitApps = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--app') {
    const value = argv[i + 1]
    if (!value) {
      console.error('[verify-packaged] --app 缺少路径参数')
      process.exit(1)
    }
    explicitApps.push(value)
    i += 1
  } else {
    explicitApps.push(argv[i])
  }
}

const apps = findApps(explicitApps)
if (apps.length === 0) {
  console.error('[verify-packaged] FAIL 未找到待校验产物')
  console.error(`  检查项: 打包产物目录`)
  console.error(`  期望: ${path.resolve('release')}/<platform-arch>/BizGraph.app 或通过 --app 指定`)
  console.error('  实际: 未找到')
  process.exit(1)
}

let failed = false
for (const app of apps) {
  const { failures, passes } = verifyApp(app)
  console.log(`\n[verify-packaged] ${app}`)
  for (const line of passes) console.log(`  PASS ${line}`)
  if (failures.length > 0) {
    failed = true
    console.error(`  FAIL ${failures.length} 项`)
    failures.forEach((item, index) => {
      console.error(`  ${index + 1}) ${item.check}`)
      console.error(`     期望: ${item.expected}`)
      console.error(`     实际: ${item.actual}`)
    })
  } else {
    console.log(`  OK ${passes.length} 项检查全部通过`)
  }
}

if (failed) process.exit(1)
