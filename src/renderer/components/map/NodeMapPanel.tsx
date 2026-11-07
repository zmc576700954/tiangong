/**
 * NodeMapPanel（L1 M1/M2 渲染层,session-map 蓝图 §9.4 职责）
 *
 * 选中节点的地图面板：派生态徽标 + 任务卡（人工单任务 M1）+ 会话时间线
 * （threadIds 全集,§9.5-3）+ 证据列表。派生态与人写状态并列展示、不互写（§3.1）。
 * 数据全部来自批量/按需通道（§9.2）,无按节点轮询。
 */

import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { useMapStore } from '../../store/mapStore'
import { useAgentStore } from '../../store/agentStore'
import type { ExecutionStateValue, WorkItemSummary } from '../../store/mapStore'

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

const TASK_STATUS_STYLE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  awaiting_confirm: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  queued: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/30',
  running: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  blocked: 'bg-orange-500/10 text-orange-600 border-orange-500/30',
  needs_input: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  needs_human: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  paused: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  interrupted: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  done: 'bg-green-500/10 text-green-600 border-green-500/30',
  failed: 'bg-red-500/10 text-red-600 border-red-500/30',
  cancelled: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  superseded: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
}

interface Props {
  graphId: string | null
  nodeEntityKey: string | null
  nodeId: string | null
  projectPath?: string | null
}

export function NodeMapPanel({ graphId, nodeEntityKey, nodeId, projectPath }: Props) {
  const overlay = useMapStore(useShallow((s) => (graphId ? s.overlayByGraph.get(graphId) : undefined)))
  const timeline = useMapStore((s) => s.nodeTimeline)
  const evidence = useMapStore((s) => s.nodeEvidence)
  const fetchOverlay = useMapStore((s) => s.fetchOverlay)
  const fetchNodeData = useMapStore((s) => s.fetchNodeData)
  const createWorkItem = useMapStore((s) => s.createWorkItem)
  const startWorkItem = useMapStore((s) => s.startWorkItem)
  const cancelWorkItem = useMapStore((s) => s.cancelWorkItem)
  const selectThread = useAgentStore((s) => s.selectThread)

  const [expanded, setExpanded] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!graphId) return
    void fetchOverlay(graphId)
  }, [graphId, fetchOverlay])

  useEffect(() => {
    if (!graphId || !nodeEntityKey) return
    void fetchNodeData(graphId, nodeEntityKey)
  }, [graphId, nodeEntityKey, fetchOverlay, fetchNodeData])

  if (!graphId || !nodeEntityKey) return null

  const exec = overlay?.executionStates.find((e) => e.node_entity_key === nodeEntityKey)
  const tasks: WorkItemSummary[] = (overlay?.workItems ?? []).filter((w) => w.anchor_entity_key === nodeEntityKey)
  const crossLinks = overlay?.workItems.filter((w) => w.anchor_entity_key !== nodeEntityKey) ?? []

  const onCreate = async (): Promise<void> => {
    if (!newTitle.trim() || busy) return
    setBusy(true)
    try {
      await createWorkItem({ graphId, anchorEntityKey: nodeEntityKey, anchorNodeId: nodeId ?? undefined, title: newTitle.trim(), projectPath: projectPath ?? undefined })
      setNewTitle('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="my-2 rounded-md border border-gray-200 bg-white/60 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900/40" data-testid="node-map-panel">
      <button
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        data-testid="node-map-toggle"
      >
        <span className="text-xs font-medium opacity-70">🗺️ 地图</span>
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
        <span className="flex-1" />
        <span className="text-[10px] opacity-50">
          {tasks.length} 任务 · {timeline.length} 会话 · {evidence.length} 证据 {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-3 border-t border-gray-200 pt-2 dark:border-gray-700">
          {/* 任务卡（M1 人工单任务） */}
          <section data-testid="node-map-tasks">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">任务</div>
            <div className="space-y-1">
              {tasks.map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5" data-testid={`task-${t.id}`}>
                  <Badge variant="secondary" className={`text-[10px] border ${TASK_STATUS_STYLE[t.status] ?? ''}`}>{t.status}</Badge>
                  <span className="flex-1 truncate text-xs">{t.title}</span>
                  <span className="text-[10px] opacity-50">r{t.revision} · gate={t.gate_status}</span>
                  {(t.status === 'draft' || t.status === 'awaiting_confirm') && (
                    <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" disabled={busy}
                      onClick={() => { void (async () => { setBusy(true); try { await startWorkItem(t.id) } finally { setBusy(false) } })() }}>
                      开始
                    </Button>
                  )}
                  {!['done', 'failed', 'cancelled', 'superseded'].includes(t.status) && (
                    <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" disabled={busy}
                      onClick={() => { void (async () => { setBusy(true); try { await cancelWorkItem(t.id) } finally { setBusy(false) } })() }}>
                      取消
                    </Button>
                  )}
                </div>
              ))}
              {tasks.length === 0 && <div className="px-2 text-[11px] opacity-50">暂无任务</div>}
            </div>
            <div className="mt-1 flex gap-1">
              <input
                value={newTitle}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewTitle(e.target.value)}
                placeholder="新任务标题（人工单任务）"
                className="h-6 flex-1 rounded border border-gray-300 bg-transparent px-2 text-xs dark:border-gray-600"
                data-testid="node-map-new-task"
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { void onCreate() } }}
              />
              <Button size="sm" variant="secondary" className="h-6 px-2 text-[10px]" disabled={busy || !newTitle.trim()} onClick={() => { void onCreate() }}>
                建任务
              </Button>
            </div>
          </section>

          {/* 会话时间线（threadIds 全集,§9.5-3） */}
          <section data-testid="node-map-timeline">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">会话时间线</div>
            <div className="space-y-1">
              {timeline.map((t) => (
                <div key={t.id} className="flex items-center gap-2 px-2 text-xs" data-testid={`timeline-${t.id}`}>
                  <span className="truncate">{t.thread_title ?? t.thread_id}</span>
                  <Badge variant="secondary" className="text-[10px]">{t.link_role}</Badge>
                  <span className="flex-1" />
                  <span className="text-[10px] opacity-50">{t.ended_at ? '已结束' : '活跃'} · {t.thread_adapter ?? '-'}</span>
                  {/* §9.5-3 收尾:时间线成为多会话的切换入口(单线程映射的展示源已换) */}
                  <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]"
                    data-testid={`timeline-switch-${t.thread_id}`}
                    onClick={() => selectThread(t.thread_id)}>
                    切换
                  </Button>
                </div>
              ))}
              {timeline.length === 0 && <div className="px-2 text-[11px] opacity-50">暂无会话</div>}
            </div>
          </section>

          {/* 证据列表 */}
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
              {evidence.length === 0 && <div className="px-2 text-[11px] opacity-50">暂无证据</div>}
            </div>
          </section>

          {crossLinks.length > 0 && (
            <section>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide opacity-50">其他节点任务（叠加层）</div>
              <div className="text-[11px] opacity-60">{crossLinks.length} 个（见各自节点）</div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
