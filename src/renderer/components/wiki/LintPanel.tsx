import { AlertTriangle, Info, RotateCw } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { FloatingPanel } from '../ui/FloatingPanel'
import type { LintReport, LintIssue } from '@shared/types/wiki'

interface LintPanelProps {
  report: LintReport
  onNavigate: (nodeId: string) => void
  onClose: () => void
  onRecompute: () => void
}

const KIND_LABELS: Record<LintIssue['kind'], string> = {
  'dangling-link': '断链',
  'orphan': '孤立页面',
  'community-singleton': '单节点社区',
  'community-oversized': '超大社区',
}

export function LintPanel({ report, onNavigate, onClose, onRecompute }: LintPanelProps) {
  const groups = report.issues.reduce((acc, issue) => {
    const list = acc.get(issue.kind) ?? []
    list.push(issue)
    acc.set(issue.kind, list)
    return acc
  }, new Map<LintIssue['kind'], LintIssue[]>())

  const orderedKinds: LintIssue['kind'][] = ['dangling-link', 'orphan', 'community-singleton', 'community-oversized']

  return (
    <FloatingPanel
      isOpen
      onClose={onClose}
      title="图检查"
      variant="corner"
      width="md"
      subtitle={
        <span>
          页面 {report.stats.nodeCount} · 链接 {report.stats.edgeCount} · 社区 {report.stats.communityCount}
        </span>
      }
      headerActions={
        <button
          type="button"
          onClick={onRecompute}
          title="重新计算社区"
          aria-label="重新计算社区"
          className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
        >
          <RotateCw className="w-3.5 h-3.5" />
        </button>
      }
    >
      <div className="h-full overflow-y-auto p-3 space-y-3">
        {report.issues.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">未发现异常</p>
        ) : (
          orderedKinds.map((kind) => {
            const issues = groups.get(kind)
            if (!issues || issues.length === 0) return null
            return (
              <div key={kind}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium">{KIND_LABELS[kind]}</span>
                  <span className="text-[10px] text-muted-foreground">{issues.length} 项</span>
                </div>
                <ul className="space-y-1.5">
                  {issues.map((issue, idx) => (
                    <li
                      key={`${kind}-${idx}`}
                      className={cn(
                        'p-2 rounded border text-xs',
                        issue.nodeId
                          ? 'bg-background hover:bg-muted cursor-pointer'
                          : 'bg-background',
                      )}
                      onClick={() => issue.nodeId && onNavigate(issue.nodeId)}
                      {...(issue.nodeId
                        ? {
                            role: 'button',
                            tabIndex: 0,
                            'aria-label': `定位到节点：${issue.message}`,
                            onKeyDown: (e: KeyboardEvent) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                onNavigate(issue.nodeId!)
                              }
                            },
                          }
                        : {})}
                    >
                      <div className="flex items-start gap-1.5">
                        <SeverityIcon severity={issue.severity} />
                        <span className="flex-1 leading-relaxed">{issue.message}</span>
                        <SeverityBadge severity={issue.severity} />
                      </div>
                      {issue.hint && (
                        <p className="mt-1 text-[10px] text-muted-foreground pl-5">{issue.hint}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })
        )}
      </div>
    </FloatingPanel>
  )
}

function SeverityIcon({ severity }: { severity: LintIssue['severity'] }) {
  if (severity === 'warning') {
    return <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
  }
  return <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
}

function SeverityBadge({ severity }: { severity: LintIssue['severity'] }) {
  return (
    <span
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full border',
        severity === 'warning'
          ? 'bg-amber-50 text-amber-700 border-amber-200'
          : 'bg-slate-50 text-slate-700 border-slate-200',
      )}
    >
      {severity === 'warning' ? 'warning' : 'info'}
    </span>
  )
}
