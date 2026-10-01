import { AlertTriangle, Info, X, RotateCw, Wrench, CheckCircle2 } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import type { LintReport, LintIssue, LintSeverity, LintFixAction } from '@shared/types/wiki'

interface LintPanelProps {
  report: LintReport
  onNavigate: (nodeId: string) => void
  onClose: () => void
  onRecompute: () => void
  onApplyFix?: (issue: LintIssue) => Promise<void> | void
}

const KIND_LABELS: Record<LintIssue['kind'], string> = {
  'dangling-link': '断链',
  'orphan': '孤立页面',
  'community-singleton': '单节点社区',
  'community-oversized': '超大社区',
  'missing-frontmatter': '缺 frontmatter',
  'inconsistent-case': '标题大小写不规范',
}

const SEVERITY_LABELS: Record<LintSeverity, string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
}

/** 严重度排序：error > warning > info（数值越小越靠前） */
const SEVERITY_ORDER: Record<LintSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
}

/** 在每组内仍按 kind 聚合显示以减少重复 */
const KIND_ORDER: LintIssue['kind'][] = [
  'dangling-link',
  'missing-frontmatter',
  'inconsistent-case',
  'orphan',
  'community-singleton',
  'community-oversized',
]

export function LintPanel({
  report,
  onNavigate,
  onClose,
  onRecompute,
  onApplyFix,
}: LintPanelProps) {
  // 维护一个本地 issue 列表，修复后立刻移除以提供即时反馈
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [fixing, setFixing] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  const visible = report.issues.filter((issue) => {
    const key = issueKey(issue)
    return !dismissed.has(key)
  })

  // 严重度 → 组
  const bySeverity = new Map<LintSeverity, LintIssue[]>()
  for (const issue of visible) {
    const list = bySeverity.get(issue.severity) ?? []
    list.push(issue)
    bySeverity.set(issue.severity, list)
  }

  // 在每组内再按 kind 聚合
  const groupedByKind = (issues: LintIssue[]): Map<LintIssue['kind'], LintIssue[]> => {
    const m = new Map<LintIssue['kind'], LintIssue[]>()
    for (const issue of issues) {
      const list = m.get(issue.kind) ?? []
      list.push(issue)
      m.set(issue.kind, list)
    }
    return m
  }

  const orderedSeverities: LintSeverity[] = (['error', 'warning', 'info'] as LintSeverity[])
    .filter((s) => bySeverity.has(s))
    .sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])

  async function handleFix(issue: LintIssue) {
    if (!onApplyFix || !issue.fix || fixing.has(issueKey(issue))) return
    setFixing((prev) => new Set(prev).add(issueKey(issue)))
    setToast(null)
    try {
      await onApplyFix(issue)
      setDismissed((prev) => new Set(prev).add(issueKey(issue)))
      setToast({ kind: 'success', message: `已修复：${issue.message}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setToast({ kind: 'error', message: `修复失败：${msg}` })
    } finally {
      setFixing((prev) => {
        const next = new Set(prev)
        next.delete(issueKey(issue))
        return next
      })
    }
  }

  return (
    <div className="absolute top-16 right-4 z-50 w-80 max-h-[70vh] flex flex-col bg-background/95 backdrop-blur border rounded-lg shadow-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">图检查</span>
          <span className="text-[10px] text-muted-foreground">
            页面 {report.stats.nodeCount} · 链接 {report.stats.edgeCount} · 社区 {report.stats.communityCount}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRecompute}
            title="重新计算社区"
            className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {visible.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">未发现异常</p>
        ) : (
          orderedSeverities.map((severity) => {
            const issues = bySeverity.get(severity) ?? []
            const groups = groupedByKind(issues)
            return (
              <div key={severity}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <SeverityBadge severity={severity} />
                  <span className="text-[10px] text-muted-foreground">{issues.length} 项</span>
                </div>
                <div className="space-y-2">
                  {KIND_ORDER.filter((k) => groups.has(k)).map((kind) => {
                    const list = groups.get(kind) ?? []
                    return (
                      <div key={kind}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium">{KIND_LABELS[kind]}</span>
                          <span className="text-[10px] text-muted-foreground">{list.length} 项</span>
                        </div>
                        <ul className="space-y-1.5">
                          {list.map((issue, idx) => {
                            const key = `${kind}-${severity}-${idx}-${issue.nodeId ?? ''}-${issue.message}`
                            return (
                              <IssueRow
                                key={key}
                                issue={issue}
                                isFixing={fixing.has(issueKey(issue))}
                                onNavigate={onNavigate}
                                onFix={onApplyFix ? () => handleFix(issue) : undefined}
                              />
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>

      {toast && (
        <div
          role="status"
          className={cn(
            'border-t px-3 py-2 text-xs flex items-start gap-1.5',
            toast.kind === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800',
          )}
        >
          {toast.kind === 'success' ? (
            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          )}
          <span className="leading-relaxed flex-1">{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="p-0.5 rounded hover:bg-black/5 shrink-0"
            title="关闭提示"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  )
}

function IssueRow({
  issue,
  isFixing,
  onNavigate,
  onFix,
}: {
  issue: LintIssue
  isFixing: boolean
  onNavigate: (nodeId: string) => void
  onFix?: () => void
}) {
  const navigable = Boolean(issue.nodeId)
  return (
    <li
      className={cn(
        'p-2 rounded border text-xs',
        navigable ? 'bg-background hover:bg-muted cursor-pointer' : 'bg-background',
      )}
      onClick={() => navigable && onNavigate(issue.nodeId!)}
      {...(navigable
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
        {issue.fixable && issue.fix && onFix && (
          <button
            type="button"
            disabled={isFixing}
            onClick={(e) => {
              e.stopPropagation()
              onFix()
            }}
            title={fixTooltip(issue.fix)}
            aria-label={`一键修复：${issue.message}`}
            className={cn(
              'shrink-0 p-1 rounded border transition-colors',
              isFixing
                ? 'bg-muted text-muted-foreground cursor-wait'
                : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100',
            )}
          >
            <Wrench className="w-3 h-3" />
          </button>
        )}
      </div>
      {issue.hint && (
        <p className="mt-1 text-[10px] text-muted-foreground pl-5">{issue.hint}</p>
      )}
    </li>
  )
}

function SeverityIcon({ severity }: { severity: LintSeverity }) {
  if (severity === 'error') {
    return <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
  }
  if (severity === 'warning') {
    return <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
  }
  return <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
}

function SeverityBadge({ severity }: { severity: LintSeverity }) {
  return (
    <span
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full border',
        severity === 'error'
          ? 'bg-red-50 text-red-700 border-red-200'
          : severity === 'warning'
            ? 'bg-amber-50 text-amber-700 border-amber-200'
            : 'bg-slate-50 text-slate-700 border-slate-200',
      )}
    >
      {SEVERITY_LABELS[severity]}
    </span>
  )
}

/** 稳定的 issue key，用于 dismissed / fixing 状态关联 */
function issueKey(issue: LintIssue): string {
  return `${issue.code}:${issue.nodeId ?? ''}:${issue.message}`
}

/** 修复按钮 tooltip，根据 fix.kind 描述动作 */
function fixTooltip(fix: LintFixAction): string {
  switch (fix.kind) {
    case 'create-stub-page':
      return '一键创建目标 stub 页面'
    case 'add-frontmatter':
      return '一键补 frontmatter（title / createdAt）'
    case 'normalize-case':
      return '一键归一化标题为小写'
    default:
      return '一键修复'
  }
}
