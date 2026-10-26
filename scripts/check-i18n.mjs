#!/usr/bin/env node
/**
 * 扫描渲染进程里残留的可见英文文案。
 *
 * 只报告不阻断——退出码恒为 0。当前阶段用它做两件事：
 *   1. 生成基线，看清还有多少英文没译
 *   2. 每完成一批翻译后重跑，与基线 diff 确认残留条目在减少
 *
 * 用法：
 *   node scripts/check-i18n.mjs            扫描并打印清单
 *   node scripts/check-i18n.mjs --json     输出 JSON（便于程序比对）
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src/renderer')

/** 完全匹配的放行项——这些是保留英文的术语或技术标识 */
const WHITELIST_EXACT = new Set([
  'Agent',
  'Subagent',
  'Agent CLI',
  'Wiki',
  'MCP',
  'API Key',
  'JSON',
  'YAML',
  'Shift+Enter',
  'Shift + Enter',
  'Claude Code',
  'Codex',
  'OpenCode',
  'Cline',
  'Kilo Code',
  'Kimi Code',
  'CodeBuddy',
  'Qoder',
  'Qwen Code',
  'Cursor',
  'BizGraph',
  'Recipes',
  // Wiki 特殊页标题——按设计保留英文
  'Graph Index',
  'Graph Log',
  // 非界面文案
  'react',
  'use strict',
  'development',
  'production',
  'text/html',
  'text/plain',
  'application/json',
])

/** 包含即放行的词——产品名常与其他文字混排 */
const WHITELIST_CONTAINS = [
  'Claude Code',
  'Kilo Code',
  'Kimi Code',
  'CodeBuddy',
  'Qwen Code',
  'Agent CLI',
  'Shift+Enter',
  'API Key',
  'mcp.json',
  'MCP',
]

/**
 * 中英混排时允许出现的英文词。
 * 一条文案里若所有英文词都在这里 → 视为「已中文化，仅保留术语」，不报。
 */
const ALLOWED_TOKENS = new Set([
  'agent', 'subagent', 'wiki', 'mcp', 'api', 'key', 'json', 'yaml', 'llm', 'ui', 'ux',
  'id', 'ok', 'ctrl', 'cmd', 'shift', 'enter', 'escape', 'esc', 'tab', 'space',
  'bizgraph', 'claude', 'code', 'codex', 'opencode', 'cline', 'kilo', 'kimi',
  'codebuddy', 'qoder', 'qwen', 'cursor', 'recipes', 'npm', 'pnpm', 'yarn',
  'github', 'http', 'https', 'url', 'api', 'sdk', 'cli', 'readme', 'bug', 'prompt',
])

/** 以这些词开头的行是代码，不是界面文案 */
const CODE_LINE_PREFIXES = [
  'import', 'export', 'const', 'let', 'var', 'function', 'class', 'type', 'interface',
  'enum', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'void',
  'await', 'async', 'yield', 'default', 'public', 'private', 'protected', 'readonly',
  'static', 'extends', 'implements', 'this', 'super', 'true', 'false', 'null',
  'undefined', 'describe', 'it(', 'expect(', 'test(', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'vi.', 'console.',
]

/** 这些 JSX 属性值是界面文案 */
const UI_ATTRS = ['placeholder', 'title', 'aria-label', 'label', 'alt']

/** 这些函数的第一个字符串参数是界面文案 */
const TOAST_FNS = ['pushToast', 'toastError', 'toastInfo', 'toastSuccess', 'toastWarning', 'toast']

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      out.push(...walk(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/** 去掉 HTML 实体与首尾空白 */
function clean(s) {
  return s.replace(/&[a-z]+;/gi, '').trim()
}

function isWhitelisted(text) {
  if (!text) return true
  if (WHITELIST_EXACT.has(text)) return true
  return WHITELIST_CONTAINS.some((w) => text.includes(w))
}

/** 至少含两个连续拉丁字母 */
function hasLatin(text) {
  return /[A-Za-z]{2,}/.test(text)
}

/** 纯代码字符的行不算界面文案 */
function looksLikeCode(line) {
  return /[=;(){}\[\]<>|&?!/*"'`$:#]/.test(line)
}

/** 逗号分隔的标识符列表——函数实参，不是界面文案 */
function isIdentifierList(line) {
  return /^[\w$.]+(\s*,\s*[\w$.]+)+,?$/.test(line)
}

/** 三元表达式的分支，别当作文案 */
function isTernaryFragment(value) {
  return value.includes('?') || /^\s*:/.test(value) || /:\s*$/.test(value)
}

/** 夹带代码符号的片段——是表达式，不是文案 */
function hasCodeMarkers(value) {
  return /[()\[\];,=&|]/.test(value)
}

/**
 * 一条文案里所有英文词都允许 → 视为「已中文化，仅保留术语」。
 * 纯英文文案（没有中文）时不做这个判断——那正是要抓的残留。
 */
function isAllEnglishAllowed(text) {
  if (!/[一-鿿]/.test(text)) return false
  const tokens = text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []
  if (tokens.length === 0) return true
  return tokens.every((tok) => {
    if (ALLOWED_TOKENS.has(tok.toLowerCase())) return true
    // 两字母以内的大写缩写（AI / LLM / UI / OK）视为术语
    return tok.length <= 2 && tok === tok.toUpperCase()
  })
}

function isProseLine(trimmed) {
  if (!trimmed) return false
  if (CODE_LINE_PREFIXES.some((p) => trimmed.startsWith(p))) return false
  if (looksLikeCode(trimmed)) return false
  if (isIdentifierList(trimmed)) return false
  if (!/\s/.test(trimmed)) return false // 单个词多半是标识符
  return hasLatin(trimmed)
}

/**
 * 裸词所在行是否落在 JSX 开启标签内部。
 * 标签内部 → 是属性名（fitView / autoFocus）；标签之间 → 是文案（Confirm / Search）。
 * 判据：从该行往后找第一个 `>`——它是 `</…>` 的闭合符则说明后面是文本内容，
 * 否则说明还在一个属性列表里。
 */
function isInsideJsxTag(lines, idx) {
  for (let j = idx; j < lines.length; j++) {
    const line = lines[j]
    for (let k = 0; k < line.length; k++) {
      if (line[k] !== '>') continue
      if (k > 0 && line[k - 1] === '=') continue // `=>` 不是标签闭合符
      const before = line.slice(0, k)
      const lt = before.lastIndexOf('<')
      if (lt < 0) return true // 标签开启符在更早的行
      if (/^\s*\//.test(before.slice(lt + 1))) return false // 闭合标签 → 文本
      return true // 开启标签 → 属性名
    }
  }
  return false
}

function scanFile(absPath) {
  const rel = path.relative(ROOT, absPath)
  const isTsx = absPath.endsWith('.tsx')
  const lines = fs.readFileSync(absPath, 'utf8').split('\n')
  const findings = []
  let prevNonEmpty = ''

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
      if (line) prevNonEmpty = line
      return
    }

    // ① 独立成行的 JSX 文案
    if (isProseLine(line)) {
      findings.push({ file: rel, line: lineNo, kind: 'text', value: line })
    } else if (
      isTsx &&
      /^[A-Za-z][A-Za-z ]{1,30}$/.test(line) &&
      !CODE_LINE_PREFIXES.some((p) => line.startsWith(p)) &&
      !isTernaryFragment(line) &&
      !/[<,]$/.test(prevNonEmpty) && // 泛型参数列表：React.forwardRef<…,\n  SomeProps\n>
      !isInsideJsxTag(lines, idx) // 落在 JSX 开启标签内 → 是属性名
    ) {
      // ② 单个英文词的 JSX 文案（多行标签里的 "Auto" 这类）
      findings.push({ file: rel, line: lineNo, kind: 'text', value: line })
    }

    // ③ JSX 文本节点：>Some Text<
    //    `(?<![=<])` 排除 `=>` 与 `>=`——否则 `=> Promise<T>` 会被误判成文本
    for (const m of raw.matchAll(/(?<![=<])>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g)) {
      const value = clean(m[1])
      if (value && hasLatin(value) && !isTernaryFragment(value) && !hasCodeMarkers(value)) {
        findings.push({ file: rel, line: lineNo, kind: 'jsx-text', value })
      }
    }

    // ④ 界面属性值
    for (const attr of UI_ATTRS) {
      // 负向后顾：避免 `label` 规则重复命中 `aria-label`
      const prefix = attr === 'label' ? '(?<![-\\w])' : '\\b'
      const re = new RegExp(`${prefix}${attr}\\s*=\\s*"([^"]*)"`, 'g')
      for (const m of raw.matchAll(re)) {
        const value = clean(m[1])
        if (value && hasLatin(value)) {
          findings.push({ file: rel, line: lineNo, kind: `attr:${attr}`, value })
        }
      }
    }

    // ⑤ toast 调用的第一个字符串参数
    for (const fn of TOAST_FNS) {
      const re = new RegExp(`\\b${fn}\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g')
      for (const m of raw.matchAll(re)) {
        const value = clean(m[1])
        if (value && hasLatin(value)) {
          findings.push({ file: rel, line: lineNo, kind: `toast:${fn}`, value })
        }
      }
    }

    prevNonEmpty = line
  })

  return findings
}

const files = walk(SRC_DIR)
const all = files
  .flatMap(scanFile)
  .filter((f) => !isWhitelisted(f.value))
  .filter((f) => !isAllEnglishAllowed(f.value))

// 同一个文件同一行同一值只报一次
const seen = new Set()
const findings = all.filter((f) => {
  const key = `${f.file}:${f.line}:${f.kind}:${f.value}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
})

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(findings, null, 2))
} else {
  if (findings.length === 0) {
    console.log('✓ no untranslated strings found')
  } else {
    console.log(`发现 ${findings.length} 处疑似未翻译文案：\n`)
    for (const f of findings) {
      console.log(`${f.file}:${f.line}  [${f.kind}]  ${f.value}`)
    }
  }
}

// 只报告不阻断
process.exit(0)
