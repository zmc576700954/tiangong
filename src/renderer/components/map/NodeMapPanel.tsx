/**
 * NodeMapPanel（L1 M1/M2 渲染层,session-map 蓝图 §9.4 职责）
 *
 * 选中节点的只读详情：派生状态徽标 + 锚定该节点的 work item + 每个 item 的
 * 步骤/最近 runs + 会话时间线（threadIds 全集,§9.5-3）+ 证据级别与新鲜度。
 *
 * 唯一写操作：manual 验收确认按钮（workitem:acceptance:confirm）。确认只记录
 * 人工事实并重算验收，不触发 turn；其余仍为只读。
 * 空数据如实显示"无"，不生成占位内容。
 */

import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Badge } from '../ui/badge'
import { useMapStore } from '../../store/mapStore'
import type { ExecutionStateValue, WorkItemSummary } from '../../store/mapStore'

interface PendingAcceptanceEntry {
  id: string
  expected: string
  text?: string
}

/** 解析 `input_request_json`（kind=acceptance_manual_confirm）；非法/空返回 null。 */
function parseAcceptanceRequest(json: string | null): PendingAcceptanceEntry[] | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { kind?: unknown; entries?: unknown }
    if (parsed?.kind !== 'acceptance_manual_confirm' || !Array.isArray(parsed.entries)) return null
    const entries = parsed.entries.filter(
      (entry): entry is PendingAcceptanceEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as PendingAcceptanceEntry).id === 'string' &&
        typeof (entry as PendingAcceptanceEntry).expected === 'string',
    )
    return entries.length > 0 ? entries : null
  } catch {
    return null
  }
}

/** 派生态徽标配色（verified 与 signed_off 按可复现性分色,禁止混同 §3.5）。 */
const STATE_STYLE: Record<ExecutionStateValue, string> = {
  untouched: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  planned: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  in_progress: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  implemented: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30',
  verified: 'bg-green-500/10 text-green-600 border-green-500/30',
  signed_off: 'bg-teal-500/10 text-teal-700 border-teal-500/30',
  failed: 'bg-red-500/10 text-red-600 border-red-500/30',
  blocked: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  stale: 'bg-yellow-500/10 text-yellow-700 border-yellow-500/30',
}

/** item / step / run 状态共用配色（缺省值回落中性灰）。 */
const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  planning: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  pending: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  awaiting_confirm: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  queued: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30',
  running: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  waiting_approval: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  review: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  blocked: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  needs_input: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  needs_human: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  paused: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  interrupted: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  succeeded: 'bg-green-500/10 text-green-600 border-green-500/30',
  completed: 'bg-green-500/10 text-green-600 border-green-500/30',
  done: 'bg-green-500/10 text-green-600 border-green-500/30',
  failed: 'bg-red-500/10 text-red-600 border-red-500/30',
  timed_out: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  cancelled: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  skipped: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  superseded: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface Props {
  graphId: string | null
  nodeEntityKey: string | null
  nodeId: string | null
}

export function NodeMapPanel({ graphId, nodeEntityKey }: Props) {
  const overlay = useMapStore(useShallow((s) => (graphId ? s.overlayByGraph.get(graphId) : undefined)))
  const timeline = useMapStore((s) => s.nodeTimeline)
  const evidence = useMapStore((s) => s.nodeEvidence)
  const details = useMapStore((s) => s.workItemDetails)
  const fetchOverlay = useMapStore((s) => s.fetchOverlay)
  const fetchNodeData = useMapStore((s) => s.fetchNodeData)
  const fetchWorkItemDetail = useMapStore((s) => s.fetchWorkItemDetail)
  const confirmAcceptance = useMapStore((s) => s.confirmAcceptance)
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  async function handleConfirm(itemId: string, stepId: string, entryId: string): Promise<void> {
    if (!graphId) return
    const key = `${stepId}:${entryId}`
    setConfirmingKey(key)
    setConfirmError(null)
    try {
      await confirmAcceptance({ graphId, workItemId: itemId, stepId, entryIds: [entryId] })
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : String(error))
    } finally {
      setConfirmingKey(null)
    }
  }

  useEffect(() => {
    if (!graphId) return
    void fetchOverlay(graphId)
  }, [graphId, fetchOverlay])

  useEffect(() => {
    if (!graphId || !nodeEntityKey) return
    void fetchNodeData(graphId, nodeEntityKey)
  }, [graphId, nodeEntityKey, fetchNodeData])

  const tasks: WorkItemSummary[] = (overlay?.workItems ?? []).filter((w) => w.anchor_entity_key === nodeEntityKey)
  const taskIds = tasks.map((t) => t.id).join(',')

  useEffect(() => {
    if (!taskIds) return
    for (const id of taskIds.split(',')) void fetchWorkItemDetail(id)
  }, [taskIds, fetchWorkItemDetail])

  if (!graphId || !nodeEntityKey) return null

  const exec = overlay?.executionStates.find((e) => e.node_entity_key === nodeEntityKey)

  return (
    <div className="my-2 rounded-md border border-gray-200 bg-white/60 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900/40" data-testid="node-map-panel">
      <div className="flex flex-wrap items-center gap-2" data-testid="node-map-header">
        <span className="text-xs font-medium opacity-70">地图</span>
        {exec ? (
          <Badge variant="secondary" className={`text-[10px] border ${STATE_STYLE[exec.execution_state]}`} data-testid="node-exec-state">
            {exec.execution_state}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px] border bg-gray-500/10 text-gray-500 border-gray-500/30">无派生态</Badge>
        )}
        {exec && exec.stale_count > 0 && (
          <Badge variant="secondary" className="text-[10px] border bg-yellow-500/10 text-yellow-700 border-yellow-500/30">
            stale ×{exec.stale_count}
          </Badge>
        )}
        <span className="ml-auto text-[10px] opacity-50">
          {tasks.length} 任务 · {timeline.length} 会话 · {evidence.length} 证据
        </span>
      </div>

      <div className="mt-2 space-y-3 border-t border-gray-200 pt-2 dark:border-gray-700">
        {/* 锚定该节点的 work item（含 steps / 最近 runs） */}
        <section data-testid="node-map-tasks">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">任务</div>
          <div className="space-y-2">
            {tasks.map((t) => {
              const detail = details[t.id]
              const recentRuns = (detail?.runs ?? []).slice(-5).reverse()
              return (
                <div key={t.id} className="rounded px-2 py-1" data-testid={`task-${t.id}`}>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[t.status] ?? ''}`}>{t.status}</Badge>
                    <span className="flex-1 truncate text-xs">{t.title}</span>
                    <span className="text-[10px] opacity-50">r{t.revision} · gate={t.gate_status}</span>
                  </div>

                  <div className="mt-1 pl-2" data-testid={`task-${t.id}-steps`}>
                    <div className="text-[10px] opacity-50">步骤</div>
                    {(detail?.steps ?? []).length === 0 && (
                      <div className="text-[11px] opacity-50">无（该任务没有步骤）</div>
                    )}
                    {(detail?.steps ?? []).map((s) => {
                      const pending = s.status === 'needs_input' ? parseAcceptanceRequest(s.input_request_json) : null
                      return (
                        <div key={s.id} data-testid={`step-${s.id}`}>
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="w-5 text-right opacity-50">{s.seq}</span>
                            <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[s.status] ?? ''}`}>{s.status}</Badge>
                            <span className="flex-1 truncate">{s.title}</span>
                            <span className="text-[10px] opacity-50">
                              {s.step_kind} · #{s.attempt}
                              {s.skip_reason ? ` · skip=${s.skip_reason}` : ''}
                              {s.failure_class ? ` · ${s.failure_class}` : ''}
                            </span>
                          </div>
                          {pending && (
                            <div
                              className="ml-7 mt-1 space-y-1 rounded border border-purple-500/30 bg-purple-500/5 p-1.5"
                              data-testid={`acceptance-pending-${s.id}`}
                            >
                              <div className="text-[10px] opacity-60">待人工确认（确认后自动重算验收）</div>
                              {pending.map((entry) => {
                                const key = `${s.id}:${entry.id}`
                                return (
                                  <div key={entry.id} className="flex items-center gap-2 text-[11px]">
                                    <span className="flex-1">
                                      {entry.expected}
                                      {entry.text ? <span className="opacity-60"> · {entry.text}</span> : null}
                                    </span>
                                    <button
                                      type="button"
                                      className="rounded border border-purple-500/40 px-1.5 py-0.5 text-[10px] hover:bg-purple-500/10 disabled:opacity-50"
                                      disabled={confirmingKey === key}
                                      onClick={() => void handleConfirm(t.id, s.id, entry.id)}
                                    >
                                      {confirmingKey === key ? '确认中…' : '确认'}
                                    </button>
                                  </div>
                                )
                              })}
                              {confirmError && <div className="text-[10px] text-red-600">{confirmError}</div>}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  <div className="mt-1 pl-2" data-testid={`task-${t.id}-runs`}>
                    <div className="text-[10px] opacity-50">最近运行</div>
                    {recentRuns.length === 0 && <div className="text-[11px] opacity-50">无（尚无运行记录）</div>}
                    {recentRuns.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 text-[11px]" data-testid={`run-${r.id}`}>
                        <Badge variant="secondary" className={`text-[10px] border ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</Badge>
                        <span className="truncate">step {r.step_id ?? '-'}</span>
                        <span className="flex-1" />
                        <span className="text-[10px] opacity-50">
                          seq #{r.run_seq} · #{r.attempt}{r.failure_class ? ` · ${r.failure_class}` : ''} · {formatTs(r.created_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
            {tasks.length === 0 && <div className="px-2 text-[11px] opacity-50">无（该节点未被任何 work item 锚定）</div>}
          </div>
        </section>

        {/* 会话时间线（threadIds 全集,§9.5-3；只读展示,不提供切换操作） */}
        <section data-testid="node-map-timeline">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">会话时间线</div>
          <div className="space-y-1">
            {timeline.map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-2 text-xs" data-testid={`timeline-${t.id}`}>
                <span className="truncate">{t.thread_title ?? t.thread_id}</span>
                <Badge variant="secondary" className="text-[10px]">{t.link_role}</Badge>
                <span className="flex-1" />
                <span className="text-[10px] opacity-50">{t.ended_at ? '已结束' : '活跃'} · {t.thread_adapter ?? '-'}</span>
              </div>
            ))}
            {timeline.length === 0 && <div className="px-2 text-[11px] opacity-50">无（该节点没有关联会话）</div>}
          </div>
        </section>

        {/* 证据列表：级别 + 新鲜度 */}
        <section data-testid="node-map-evidence">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">证据</div>
          <div className="space-y-1">
            {evidence.map((e) => (
              <div key={e.id} className="flex items-center gap-2 px-2 text-xs" data-testid={`evidence-${e.id}`}>
                <Badge variant="secondary" className="text-[10px]">{e.evidence_level}</Badge>
                <span className="truncate">{e.summary ?? e.evidence_type}</span>
                <span className="flex-1" />
                <span className="text-[10px] opacity-50">
                  {e.freshness} · {e.produced_by}{e.revoked_at ? ' · 已撤销' : ''}
                </span>
              </div>
            ))}
            {evidence.length === 0 && <div className="px-2 text-[11px] opacity-50">无（该节点没有证据）</div>}
          </div>
        </section>
      </div>
    </div>
  )
}
