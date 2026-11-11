/**
 * S7 起草入口（I.0 第 1 条，v3.22）：手工多子任务计划的编辑器。
 *
 * 这是 C1 的唯一数据源——agent 路径不写 `plan_drafts`，`plan:draft:create`
 * 此前「已注册未暴露」，导致 C1 面板列表恒空。本组件只负责收集输入并做
 * **形状级**校验（非空、键唯一、依赖可解析、无环）；gate 缺失（G1–G6）由
 * 服务端 `previewDraft` 的 `gateMissing` 投影在创建后如实展示，这里不复算。
 *
 * 起草与修订共用此编辑器：
 * - create：`plan:draft:create` 落 draft 状态新草稿；
 * - revise：`plan:draft:revise` 产生新 revision 并置旧行 superseded（confirmed
 *   不可修订，主进程拒绝）。修订预填的条目原文来自只读 `plan:draft:get`。
 */

import { useMemo, useState } from 'react'
import type { PlanItemInput } from '../../store/mapStore'

/** D1 裁决：acceptance 条目冻结为 {type, expected}，type 只有三值。 */
const ACCEPTANCE_TYPES = ['command', 'manual', 'file_check'] as const
type ComposerAcceptanceType = (typeof ACCEPTANCE_TYPES)[number]

const ACCEPTANCE_TYPE_TEXT: Record<ComposerAcceptanceType, string> = {
  command: '命令',
  manual: '人工核对',
  file_check: '文件判据',
}

interface ComposerAcceptance {
  type: ComposerAcceptanceType
  expected: string
}

/** 编辑器内的一条子任务草稿（文本域未拆分，提交时才解析）。 */
interface ComposerItem {
  key: string
  title: string
  goal: string
  scopeFilesText: string
  acceptance: ComposerAcceptance[]
  dependsOnText: string
}

const INPUT_CLASS =
  'min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-1 py-0.5 text-[11px] dark:border-gray-600'
const BUTTON_CLASS =
  'rounded border px-1.5 py-0.5 text-[10px] hover:bg-gray-500/10 disabled:cursor-not-allowed disabled:opacity-40'

/** 服务端原文 → 编辑器行（revise 预填用）。 */
function toComposerItem(item: PlanItemInput, index: number): ComposerItem {
  const acceptance = Array.isArray(item.acceptance)
    ? item.acceptance
        .map((entry) => {
          const type = ACCEPTANCE_TYPES.find((t) => entry['type'] === t) ?? 'manual'
          const expected = typeof entry['expected'] === 'string' ? entry['expected'] : ''
          return { type, expected }
        })
        .filter((entry) => entry.expected !== '')
    : []
  return {
    key: item.key ?? `item-${index + 1}`,
    title: item.title ?? '',
    goal: item.goal ?? '',
    scopeFilesText: (item.scopeFiles ?? []).join('\n'),
    acceptance,
    dependsOnText: (item.dependsOn ?? []).join(', '),
  }
}

function emptyItem(index: number): ComposerItem {
  return { key: `item-${index + 1}`, title: '', goal: '', scopeFilesText: '', acceptance: [], dependsOnText: '' }
}

/** 依赖环检测（镜像主进程 `detectCycle` 的 DFS，只在提交前预检，不替代服务端）。 */
function findCycle(keys: string[], depends: Map<string, string[]>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  let cycle: string[] | null = null
  const visit = (k: string): void => {
    if (cycle) return
    state.set(k, 1)
    stack.push(k)
    for (const d of depends.get(k) ?? []) {
      const st = state.get(d) ?? 0
      if (st === 1) {
        cycle = [...stack.slice(stack.indexOf(d)), d]
        return
      }
      if (st === 0) visit(d)
    }
    stack.pop()
    state.set(k, 2)
  }
  for (const k of keys) if ((state.get(k) ?? 0) === 0) visit(k)
  return cycle
}

/** 把文本输入解析成主进程 `PlanItem`：trim、拆分、过滤空值。 */
function buildItems(items: ComposerItem[]): PlanItemInput[] {
  return items.map((item, index) => {
    const scopeFiles = item.scopeFilesText
      .split(/[\n,，;；]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const dependsOn = item.dependsOnText
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
    return {
      key: item.key.trim() !== '' ? item.key.trim() : `item-${index + 1}`,
      title: item.title.trim(),
      goal: item.goal.trim() !== '' ? item.goal.trim() : undefined,
      ...(scopeFiles.length > 0 ? { scopeFiles } : {}),
      ...(item.acceptance.length > 0
        ? {
            acceptance: item.acceptance.map((entry, i) => ({
              id: `acc_${i + 1}`,
              type: entry.type,
              expected: entry.expected.trim(),
            })),
          }
        : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    }
  })
}

interface Props {
  mode: 'create' | 'revise'
  /** revise：待修订草稿 id（仅用于展示）；条目原文由父组件预填进 initialItems。 */
  reviseOf?: { id: string; revision: number } | null
  initialItems?: PlanItemInput[]
  busy?: boolean
  /** 服务端错误（store 翻好的中文）；与本地校验分开显示。 */
  error?: string | null
  onSubmit: (items: PlanItemInput[]) => void
  onCancel: () => void
}

export function PlanDraftComposer({
  mode,
  reviseOf = null,
  initialItems,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: Props) {
  const [items, setItems] = useState<ComposerItem[]>(() =>
    initialItems && initialItems.length > 0 ? initialItems.map(toComposerItem) : [emptyItem(0)],
  )

  function updateItem(index: number, patch: Partial<ComposerItem>): void {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  function updateAcceptance(index: number, accIndex: number, patch: Partial<ComposerAcceptance>): void {
    setItems((prev) =>
      prev.map((item, i) =>
        i === index
          ? {
              ...item,
              acceptance: item.acceptance.map((entry, j) => (j === accIndex ? { ...entry, ...patch } : entry)),
            }
          : item,
      ),
    )
  }

  /** 提交前的形状级校验；返回错误列表（中文，逐条可直接展示）。 */
  const problems = useMemo<string[]>(() => {
    const list: string[] = []
    if (items.length === 0) {
      list.push('计划至少需要 1 个子任务')
      return list
    }
    const keys: string[] = []
    items.forEach((item, index) => {
      const key = item.key.trim() !== '' ? item.key.trim() : `item-${index + 1}`
      if (item.title.trim() === '') list.push(`第 ${index + 1} 条子任务缺标题`)
      keys.push(key)
      item.acceptance.forEach((entry, accIndex) => {
        if (entry.expected.trim() === '') {
          list.push(`第 ${index + 1} 条的第 ${accIndex + 1} 个验收条件缺内容`)
        }
      })
    })
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i)
    if (dup.length > 0) list.push(`子任务键重复：${[...new Set(dup)].join('、')}`)
    const keySet = new Set(keys)
    items.forEach((item, index) => {
      const deps = item.dependsOnText.split(/[\s,，;；]+/).map((s) => s.trim()).filter((s) => s !== '')
      const unknown = deps.filter((d) => !keySet.has(d))
      if (unknown.length > 0) list.push(`第 ${index + 1} 条依赖了不存在的键：${unknown.join('、')}`)
    })
    const depends = new Map<string, string[]>()
    items.forEach((item, index) => {
      const key = keys[index]
      const deps = item.dependsOnText.split(/[\s,，;；]+/).map((s) => s.trim()).filter((s) => s !== '')
      depends.set(key, deps)
    })
    const cycle = findCycle(keys, depends)
    if (cycle) list.push(`依赖存在环：${cycle.join(' → ')}（主进程也会拒绝）`)
    return list
  }, [items])

  const canSubmit = !busy && problems.length === 0

  return (
    <div
      className="mt-1 space-y-1.5 rounded border border-blue-500/40 bg-blue-500/5 p-1.5 text-[11px]"
      data-testid={`plan-draft-composer-${mode}`}
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-medium text-blue-700">
          {mode === 'create' ? '起草计划（C1 数据源）' : `修订计划草稿（r${reviseOf?.revision ?? '?'} → 新 revision）`}
        </span>
        <span className="text-[10px] opacity-60">
          确认后按条目生成 1 个父任务 + N 个子任务，不可原地回退；gate 缺失在创建后由服务端预检展示
        </span>
      </div>

      {items.map((item, index) => (
        <div
          key={index}
          className="space-y-1 rounded border border-gray-300/60 p-1.5 dark:border-gray-600/60"
          data-testid={`composer-item-${index}`}
        >
          <div className="flex flex-wrap items-center gap-1">
            <input
              className="w-20 rounded border border-gray-300 bg-transparent px-1 py-0.5 text-[10px] dark:border-gray-600"
              data-testid={`composer-item-${index}-key`}
              value={item.key}
              title="子任务键（dependsOn 引用它；留空自动按 item-N 编号）"
              onChange={(e) => updateItem(index, { key: e.target.value })}
            />
            <input
              className={INPUT_CLASS}
              data-testid={`composer-item-${index}-title`}
              placeholder={`子任务 ${index + 1} 标题（必填）`}
              value={item.title}
              onChange={(e) => updateItem(index, { title: e.target.value })}
            />
            <button
              type="button"
              className={`${BUTTON_CLASS} shrink-0 border-red-500/40`}
              data-testid={`composer-item-${index}-remove`}
              disabled={items.length === 1}
              title={items.length === 1 ? '至少保留 1 个子任务' : '删除这条子任务'}
              onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
            >
              删除
            </button>
          </div>
          <input
            className={INPUT_CLASS}
            data-testid={`composer-item-${index}-goal`}
            placeholder="目标（可选）"
            value={item.goal}
            onChange={(e) => updateItem(index, { goal: e.target.value })}
          />
          <textarea
            className={`${INPUT_CLASS} h-12 resize-y`}
            data-testid={`composer-item-${index}-scope`}
            placeholder="写域文件（可选，每行一个）"
            value={item.scopeFilesText}
            onChange={(e) => updateItem(index, { scopeFilesText: e.target.value })}
          />
          <div className="space-y-0.5 pl-1">
            <div className="text-[10px] opacity-60">验收条件（D1 结构化：类型 + 判据）</div>
            {item.acceptance.map((entry, accIndex) => (
              <div key={accIndex} className="flex items-center gap-1" data-testid={`composer-item-${index}-acc-${accIndex}`}>
                <select
                  className="shrink-0 rounded border border-gray-300 bg-transparent px-1 py-0.5 text-[10px] dark:border-gray-600"
                  data-testid={`composer-item-${index}-acc-${accIndex}-type`}
                  value={entry.type}
                  onChange={(e) =>
                    updateAcceptance(index, accIndex, { type: e.target.value as ComposerAcceptanceType })
                  }
                >
                  {ACCEPTANCE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {ACCEPTANCE_TYPE_TEXT[type]}
                    </option>
                  ))}
                </select>
                <input
                  className={INPUT_CLASS}
                  data-testid={`composer-item-${index}-acc-${accIndex}-expected`}
                  placeholder={entry.type === 'command' ? '如：npm test -- --run' : '判据（必填）'}
                  value={entry.expected}
                  onChange={(e) => updateAcceptance(index, accIndex, { expected: e.target.value })}
                />
                <button
                  type="button"
                  className={`${BUTTON_CLASS} shrink-0 border-red-500/40`}
                  data-testid={`composer-item-${index}-acc-${accIndex}-remove`}
                  onClick={() =>
                    updateItem(index, {
                      acceptance: item.acceptance.filter((_, j) => j !== accIndex),
                    })
                  }
                >
                  删
                </button>
              </div>
            ))}
            <button
              type="button"
              className={`${BUTTON_CLASS} border-blue-500/40`}
              data-testid={`composer-item-${index}-acc-add`}
              onClick={() =>
                updateItem(index, { acceptance: [...item.acceptance, { type: 'manual', expected: '' }] })
              }
            >
              添加验收条件
            </button>
          </div>
          <input
            className={INPUT_CLASS}
            data-testid={`composer-item-${index}-depends`}
            placeholder="依赖（可选，逗号分隔的其他子任务键）"
            value={item.dependsOnText}
            onChange={(e) => updateItem(index, { dependsOnText: e.target.value })}
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={`${BUTTON_CLASS} border-blue-500/40`}
          data-testid="composer-add-item"
          onClick={() => setItems((prev) => [...prev, emptyItem(prev.length)])}
        >
          添加子任务
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className={BUTTON_CLASS}
          data-testid="composer-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className={`${BUTTON_CLASS} border-blue-500/60 font-medium text-blue-700`}
          data-testid="composer-submit"
          disabled={!canSubmit}
          title={problems.length > 0 ? '先解决上面的校验问题' : busy ? '提交中…' : undefined}
          onClick={() => onSubmit(buildItems(items))}
        >
          {busy ? '提交中…' : mode === 'create' ? '生成草稿' : '保存修订'}
        </button>
      </div>

      {problems.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-amber-700" data-testid="composer-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-[10px] text-red-600" data-testid="composer-error">
          {error}
        </p>
      )}
    </div>
  )
}
