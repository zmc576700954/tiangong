#!/usr/bin/env node
/**
 * 会话地图蓝图（Part I 状态总账）机械核验。
 *
 * 存在的理由：这份文档的「数字」和「证据」反复腐烂——上上轮是行号错位，
 * 上轮是计数对不上（标题 102、表里 95）。靠人眼数表格不可靠，所以把可机械
 * 判定的部分全部固化成断言，每轮改完跑一次。
 *
 * 只做「可机械判定」的检查。语义类判断（状态词是否比事实乐观）不在这里，
 * 那需要读码，脚本只管「自相矛盾」与「引用失效」。
 *
 * 用法：
 *   node scripts/verify-session-map-blueprint.mjs
 *   node scripts/verify-session-map-blueprint.mjs --json
 *
 * 退出码：全部通过 0，有失败 1。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DOC = path.join(ROOT, 'docs/architecture/session-map-blueprint.md')
const CODE_ISSUES = path.join(ROOT, 'docs/architecture/code-issues-2026-11-11.md')

const text = fs.readFileSync(DOC, 'utf8')
const lines = text.split('\n')

const results = []
const record = (id, title, ok, detail) => results.push({ id, title, ok, detail })

/** 取两个标题之间的正文（1-based 行号，含头不含尾） */
function section(startMarker, endMarkers) {
  const s = lines.findIndex((t) => t.startsWith(startMarker))
  if (s < 0) return null
  let e = lines.length
  for (const em of endMarkers) {
    const i = lines.findIndex((t, idx) => idx > s && t.startsWith(em))
    if (i >= 0 && i < e) e = i
  }
  return { start: s, end: e, body: lines.slice(s, e) }
}

/** 全仓文件索引，用于解析裸文件名 */
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    // .claude/worktrees 是历史 worktree 副本，会把同一文件变成多个候选；不是本仓源码
    if (['node_modules', 'dist', 'dist-electron', 'release', '.git', '.workbuddy', '.claude', 'build', 'coverage'].includes(ent.name)) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const allFiles = walk(ROOT)
const relFiles = new Set(allFiles.map((f) => path.relative(ROOT, f)))
const byBasename = new Map()
for (const f of allFiles) {
  const b = path.basename(f)
  if (!byBasename.has(b)) byBasename.set(b, [])
  byBasename.get(b).push(path.relative(ROOT, f))
}

// ── 1. I.2 计数：标题数 = 分组括注数之和 = 表行数，且分组逐个闭合 ────────────
{
  const sec = section('## I.2 ', ['## I.3 '])
  if (!sec) {
    record('I2_COUNT', 'I.2 表行数与分组计数闭合', false, '找不到 ## I.2 小节')
  } else {
    const titleNum = Number(/## I\.2 已实施清单（(\d+) 条/.exec(sec.body[0])?.[1] ?? NaN)
    const groups = []
    let cur = null
    for (const t of sec.body) {
      const m = /^### (I\.2\.\d+) .*（(\d+)）/.exec(t)
      if (m) {
        cur = { id: m[1], declared: Number(m[2]), rows: 0, ids: [] }
        groups.push(cur)
        continue
      }
      if (t.startsWith('| G') && cur) {
        const id = t.split('|')[1].trim()
        if (/^G\d+-\d+/.test(id)) {
          cur.rows += 1
          cur.ids.push(id)
        }
      }
    }
    const total = groups.reduce((a, g) => a + g.rows, 0)
    const sumDeclared = groups.reduce((a, g) => a + g.declared, 0)
    const bad = groups.filter((g) => g.rows !== g.declared)
    // 期望值从 I.1 总账表的「已实施」行读，不写字面量——数字变了但脚本忘了改，
    // 会表现为「校验失败」，而不是「校验通过但数字错了」。
    const declaredTotal = Number(/\| 已实施 \| \*\*(\d+)\*\* \|/.exec(text)?.[1] ?? NaN)
    const ok = Number.isFinite(declaredTotal) && titleNum === declaredTotal && total === declaredTotal && sumDeclared === declaredTotal && bad.length === 0
    const detail = ok
      ? `标题 ${titleNum}，表行 ${total}，分组括注和 ${sumDeclared}，${groups.length} 个分组逐个闭合`
      : `I.1 声明 ${declaredTotal}；标题 ${titleNum}，表行 ${total}，分组括注和 ${sumDeclared}` +
        (bad.length ? `；不闭合：${bad.map((g) => `${g.id} 声明${g.declared}实有${g.rows}`).join('、')}` : '')
    record('I2_COUNT', `I.2 表行数与分组计数闭合（应 ${Number.isFinite(declaredTotal) ? declaredTotal : 'I.1 声明值'}）`, ok, detail)
    globalThis.__i2Groups = groups
  }
}

// ── 2. I.2 编号唯一，且每个编号都在 I.1 总账里出现过 ─────────────────────
// 单元格可能写多个编号（`G3-10 / G5-3`、`G1-9/G5-5`），也可能用范围（`G3-6～G3-9`）。
// 两种写法都要拆开比对，否则「内容没漏、格式不同」会被误报成缺失。
const expand = (s) => {
  const out = new Set()
  for (const m of s.matchAll(/G(\d{1,2})-(\d{1,2})\s*[～~-]\s*G\1-(\d{1,2})/g)) {
    for (let i = Number(m[2]); i <= Number(m[3]); i++) out.add(`G${m[1]}-${i}`)
  }
  for (const m of s.matchAll(/G(\d{1,2})-(\d{1,2})/g)) out.add(`G${m[1]}-${m[2]}`)
  return out
}
{
  const groups = globalThis.__i2Groups ?? []
  const i2ids = groups.flatMap((g) => [...expand(g.ids.join(' '))])
  const dup = i2ids.filter((x, i) => i2ids.indexOf(x) !== i)
  const i1 = section('## I.1 ', ['## I.2 '])
  const mentioned = expand((i1?.body ?? []).join('\n'))
  const notInI1 = [...new Set(i2ids)].filter((x) => !mentioned.has(x))
  const ok = dup.length === 0 && notInI1.length === 0
  record(
    'I2_IDS',
    'I.2 编号唯一，且每个编号都在 I.1 总账里出现',
    ok,
    ok
      ? `${new Set(i2ids).size} 个唯一编号，无重复；均能在 I.1 找到对应记录`
      : [
          dup.length ? `I.2 内重复：${[...new Set(dup)].join(', ')}` : '',
          notInI1.length ? `I.1 里没有：${notInI1.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('；'),
  )
}

// ── 3. 三条计数等式 ────────────────────────────────────────────────────
{
  const must = ['108 + 3 + 5 + 0 = **116', '116 + 23 = **139', '155 − 16']
  const missing = must.filter((m) => !text.includes(m))
  const table = /\| 已实施 \| \*\*108\*\* \|/.test(text) && /\| 已批准未实施 \| \*\*3\*\* \|/.test(text) && /\| 仅建议 \| \*\*5\*\* \|/.test(text)
  const ok = missing.length === 0 && table
  record(
    'EQUATIONS',
    '三条计数等式与 I.1 总账表一致（116 / 23 / 139）',
    ok,
    ok ? '等式 108+3+5+0=116、116+23=139、155−16 均在文中；I.1 表四类数字一致' : `缺：${missing.join(' / ') || '（无）'}${table ? '' : '；I.1 表数字与 108/3/5 不符'}`,
  )
}

// ── 4. 失效的旧数字 / 旧引用不得残留（变更记录里的「旧 → 新」除外）────────
{
  // 用数字边界匹配：`155 条` 不该被当成 `55 条`
  const forbidden = [
    [/(?<!\d)55 条/, '55 条'],
    [/(?<!\d)40 条/, '40 条'],
    [/out-run4/, 'out-run4'],
    [/c03ee87/, 'c03ee87'],
    [/9bb94e8/, '9bb94e8'],
    [/(?<!\d)5573(?!\d)/, '5573'],
    [/对齐到 36/, '对齐到 36'],
    [/当前为 \*\*37\*\*/, '当前为 37'],
    [/(?<!\d)11 条「已批准未实施」/, '11 条「已批准未实施」'],
    [/(?<!\d)32 条「仅建议」/, '32 条「仅建议」'],
  ]
  // 允许出现的语境：变更留痕、对旧值的说明、明确否定的句子
  const excused = (t) => /→|原写|旧快照|非当前口径|已腐烂|更正|原文|原引|不存在|改为/.test(t)
  const hits = []
  lines.forEach((t, i) => {
    if (excused(t)) return
    for (const [re, label] of forbidden) if (re.test(t)) hits.push(`L${i + 1} 「${label}」`)
  })
  record('STALE', '失效旧数字/旧引用零残留（变更留痕除外）', hits.length === 0, hits.length ? hits.slice(0, 12).join('；') : '未发现残留')
}

// ── 5. schema 版本号：文档声明与源码一致 ─────────────────────────────────
{
  const db = fs.readFileSync(path.join(ROOT, 'src/main/database.ts'), 'utf8')
  const real = Number(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/.exec(db)?.[1] ?? NaN)
  // 期望值从源码读、再回文档里找同一个数字——不写死字面量，
  // 否则每次合并升版都会表现为「校验失败」而不是「文档没跟上」。
  const docSaysSame =
    text.includes(`CURRENT_SCHEMA_VERSION = ${real}`) ||
    text.includes('`CURRENT_SCHEMA_VERSION` = ' + real) ||
    text.includes(`版本号对齐 **${real}**`)
  const ok = Number.isFinite(real) && docSaysSame
  record(
    'SCHEMA',
    `schema 版本号：文档声明的 ${Number.isFinite(real) ? real : '（读不到）'} 与 database.ts 一致`,
    ok,
    `database.ts CURRENT_SCHEMA_VERSION=${real}；文档写出同一数字：${docSaysSame ? '是' : '否'}`,
  )
}

// ── 6. 文档声明的行数与实测一致 ──────────────────────────────────────────
{
  const selfLines = lines.length - (lines[lines.length - 1] === '' ? 1 : 0)
  // 只校验「本文声明的行数 = 实测」，日期不参与判定（此前写死 2026-11-11，
  // 文档每升一版就要改脚本，属于断言比事实更硬）。必须锚定本文文件名，
  // 否则会把被引快照 map-orchestration-blueprint.md 的 398 也吃进来。
  const claims = [...text.matchAll(/wc -l docs\/architecture\/session-map-blueprint\.md` = \*\*(\d+)\*\*/g)].map((m) => Number(m[1]))
  const ok = claims.length > 0 && claims.every((c) => c === selfLines)
  record(
    'LINES',
    '本文行数声明与实测一致',
    ok,
    claims.length ? `实测 ${selfLines}，文档声明 ${[...new Set(claims)].join('/')}` : `实测 ${selfLines}，但未找到行数声明`,
  )

  const other = path.join(ROOT, 'docs/architecture/map-orchestration-blueprint.md')
  const otherLines = fs.readFileSync(other, 'utf8').split('\n').length - 1
  const claim398 = /map-orchestration-blueprint\.md`（v1\.2\.3，(\d+) 行）/.exec(text)?.[1]
  record(
    'LINES_OTHER',
    '被引快照 map-orchestration-blueprint.md 行数声明一致',
    Number(claim398) === otherLines,
    `实测 ${otherLines}，文档声明 ${claim398 ?? '（未找到）'}`,
  )
}

// ── 7. 文件引用必须可解析（全路径精确，或全仓唯一后缀）─────────────────────
{
  // 删除线里的内容是「已废弃的设计稿设想」，不该按现存引用要求
  const live = text.replace(/~~[^~]*~~/g, '')
  const refLines = new Map() // ref -> [行号]
  live.split('\n').forEach((t, i) => {
    for (const m of t.matchAll(/`([A-Za-z0-9_\-./]+\.(?:ts|tsx|js|mjs|cjs|json|yml|yaml|md))(?::[0-9,\-]+)?`/g)) {
      if (!refLines.has(m[1])) refLines.set(m[1], [])
      refLines.get(m[1]).push(i + 1)
    }
  })
  const unresolved = []
  const ambiguous = []
  const partial = []
  const excusedRefs = []
  // 第三方包内路径（asarUnpack 清单）不在本仓，按外部产物处理
  const EXTERNAL = /^(claude-agent-sdk|claude-agent-sdk-darwin|codex-sdk|codex-darwin|codex|better-sqlite3)\//;
  // 运行期生成物，不在仓内：schema-checksum.json 由数据库自检产出；
  // test-results/ 是 npm run test:eval（及 vitest）的输出目录，已被 .gitignore 忽略，
  // 因此在干净克隆（CI）里必然不存在——按产物执行，不当作失效引用。
  const RUNTIME_ARTIFACT = new Set(['schema-checksum.json'])
  const isRuntimeArtifact = (r) => RUNTIME_ARTIFACT.has(r) || r.startsWith('test-results/')
  // 已删除 / 从未创建的文件，只要文中写明就不算失效引用
  const REMOVED = /已删除|删除|未创建|从未|不存在|不成立|现已/
  const resolve = (r) => {
    if (relFiles.has(r)) return { kind: 'exact' }
    const cands = [...relFiles].filter((f) => f.endsWith('/' + r))
    if (cands.length === 1) return { kind: 'partial', to: cands[0] }
    if (cands.length > 1) return { kind: 'ambiguous', cands }
    return { kind: 'missing' }
  }
  for (const [r, at] of refLines) {
    if (EXTERNAL.test(r) || isRuntimeArtifact(r) || ['sdk.mjs', 'codex.js'].includes(r)) continue
    const hit = at.some((n) => REMOVED.test(lines[n - 1]))
    if (!r.includes('/')) {
      if (byBasename.has(r)) continue
      if (hit) excusedRefs.push(r)
      else unresolved.push(`${r}(L${at[0]})`)
      continue
    }
    const res = resolve(r)
    if (res.kind === 'exact') continue
    if (res.kind === 'partial') {
      partial.push(`${r} → ${res.to}`)
      continue
    }
    if (hit) excusedRefs.push(`${r}(L${at[0]})`)
    else if (res.kind === 'ambiguous') ambiguous.push(`${r}（L${at[0]}，${res.cands.length} 个候选：${res.cands.join(' / ')}）`)
    else unresolved.push(`${r}(L${at[0]})`)
  }
  const ok = unresolved.length === 0 && ambiguous.length === 0
  const parts = [`${refLines.size} 个引用`]
  if (unresolved.length) parts.push(`找不到：${unresolved.slice(0, 8).join(', ')}`)
  if (ambiguous.length) parts.push(`多义：${ambiguous.slice(0, 4).join(', ')}`)
  if (excusedRefs.length) parts.push(`文中标注「已删除/未创建」：${excusedRefs.length} 处`)
  if (partial.length) parts.push(`部分路径 ${partial.length} 处（可解析，建议补全）：${partial.slice(0, 5).join('、')}`)
  if (ok) parts.push('全部可解析')
  record('FILES', '文件引用全部可解析（全路径或唯一后缀）', ok, parts.join('；'))
}

// ── 8. 形如提交号的 token 必须能解析为真实提交 ────────────────────────────
{
  const tokens = new Map() // token -> [行号]
  lines.forEach((t, i) => {
    for (const m of t.matchAll(/`([0-9a-f]{7,8})`/g)) {
      if (!tokens.has(m[1])) tokens.set(m[1], [])
      tokens.get(m[1]).push(i + 1)
    }
  })
  const bad = []
  const documented = [] // 明确标注为失效的（属于「更正留痕」，不是伪造证据）
  for (const [t, at] of tokens) {
    try {
      execSync(`git cat-file -e ${t}^{commit}`, { cwd: ROOT, stdio: 'ignore' })
    } catch {
      const isCorrection = at.some((n) => /更正|失效|无法解析|不存在/.test(lines[n - 1]))
      if (isCorrection) documented.push(`${t}(L${at.join(',')})`)
      else bad.push(`${t}(L${at.join(',')})`)
    }
  }
  const ok = bad.length === 0
  record(
    'COMMITS',
    `${tokens.size} 个提交号均可解析（明确标注失效的除外）`,
    ok,
    [
      bad.length ? `无法解析且未标注：${bad.join(', ')}` : '全部为真实提交',
      documented.length ? `已标注失效：${documented.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('；'),
  )
}

// ── 9. 三件欠账在 I.0 与阅读指引里可见 ───────────────────────────────────
{
  const i0 = section('## I.0 ', ['## I.1 '])
  const has3 = i0 ? (i0.body.filter((t) => /^\| \*\*[123]\*\* \|/.test(t)).length === 3) : false
  const keywords = ['S7 起草入口', '手工连边交付不完整', 'CI 卡门需先 push']
  const kwOk = i0 ? keywords.every((k) => i0.body.some((t) => t.includes(k))) : false
  const guide = section('## 阅读指引', ['# Part I'])
  const guideOk = guide ? guide.body.some((t) => t.includes('I.0 三条决策前置')) : false
  const ok = has3 && kwOk && guideOk
  record(
    'DECISIONS',
    'I.0 三条决策前置存在且阅读指引可达',
    ok,
    `三行：${has3 ? '齐' : '缺'}；关键词：${kwOk ? '齐' : '缺'}；阅读指引有入口：${guideOk ? '是' : '否'}`,
  )
}

// ── 10. I.10 指向的代码问题文档存在 ─────────────────────────────────────
{
  const i10 = section('## I.10 ', ['# Part II'])
  const ok = !!i10 && fs.existsSync(CODE_ISSUES)
  const n = ok ? fs.readFileSync(CODE_ISSUES, 'utf8').split('\n').length - 1 : 0
  record('I10', 'I.10 存在且指向的代码问题清单存在', ok, ok ? `code-issues-2026-11-11.md 存在（${n} 行）` : 'I.10 缺失或目标文件不存在')
}

// ── 11. 状态词定义与证据口径不得自相矛盾 ─────────────────────────────────
{
  const bad = []
  lines.forEach((t, i) => {
    if (/必须带 `文件:行` 或提交号/.test(t)) bad.push(`L${i + 1} 仍要求「文件:行」`)
  })
  const hasNewRule = /完整相对路径 \+ 符号/.test(text)
  record('STATUS_RULE', '状态词/证据口径与 v3.19 新口径一致', bad.length === 0 && hasNewRule, bad.length ? bad.join('；') : hasNewRule ? '已改为「路径 + 符号」，无残留旧口径' : '未找到新口径说明')
}

// ── 12. 表格结构：I.2 每行至少 3 列；证据格式与本版口径一致 ────────────────
{
  const sec = section('## I.2 ', ['## I.3 '])
  const bad = []
  const badEvidence = []
  ;(sec?.body ?? []).forEach((t, i) => {
    if (t.startsWith('| G') && t.split('|').length < 5) bad.push(`I.2 段内第 ${i + 1} 行管道数 ${t.split('|').length - 1}`)
    // v3.19 起 I.2 不再用行号做证据；出现 `xxx.ts:123` 说明旧格式又混进来了
    for (const m of t.matchAll(/`[A-Za-z0-9_\-./]+\.(?:ts|tsx):[\d,.\-]+`/g)) badEvidence.push(m[0])
    // 「`a.ts`、`a.ts`」这种去行号后的机械重复，信息量为零
    for (const m of t.matchAll(/`([A-Za-z0-9_\-./]+)`、`\1`/g)) badEvidence.push(`重复引用 ${m[1]}`)
  })
  const ok = bad.length === 0 && badEvidence.length === 0
  record(
    'EVIDENCE_FMT',
    'I.2 表格结构完整、证据无行号残留/无重复引用',
    ok,
    ok ? '结构完整；证据均为「路径 + 符号」，无行号、无重复' : [...bad.slice(0, 5), ...badEvidence.slice(0, 5)].join('；'),
  )
}

// ── 输出 ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
} else {
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)))
  console.log('\n会话地图蓝图 · Part I 机械核验\n' + '─'.repeat(72))
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.id, 14)}${r.title}`)
    console.log(`      ${r.detail}`)
  }
  console.log('─'.repeat(72))
  console.log(`${results.length - failed.length} 通过 / ${failed.length} 失败`)
  if (failed.length) console.log(`\n失败项：${failed.map((f) => f.id).join(', ')}\n`)
}
process.exit(failed.length === 0 ? 0 : 1)
