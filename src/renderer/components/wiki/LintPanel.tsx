import { AlertTriangle, Info, X, RotateCw } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { useI18n } from '../../i18n/useI18n'
import type { TranslationKey } from '@shared/i18n'
import type { LintReport, LintIssue } from '@shared/types/wiki'

interface LintPanelProps {
  report: LintReport
  onNavigate: (nodeId: string) => void
  onClose: () => void
  onRecompute: () => void
}

/** 检查项分类标签——按 kind 查 i18n key */
const KIND_LABEL_KEYS: Record<LintIssue['kind'], TranslationKey> = {
  'dangling-link': 'wiki.lint.kind.danglingLink',
  'orphan': 'wiki.lint.kind.orphan',
  'community-singleton': 'wiki.lint.kind.communitySingleton',
  'community-oversized': 'wiki.lint.kind.communityOversized',
  'realtime-conflict': 'wiki.lint.kind.realtimeConflict',
}

export function LintPanel({ report, onNavigate, onClose, onRecompute }: LintPanelProps) {
  const { t } = useI18n()
  const groups = report.issues.reduce((acc, issue) => {
    const list = acc.get(issue.kind) ?? []
    list.push(issue)
    acc.set(issue.kind, list)
    return acc
  }, new Map<LintIssue['kind'], LintIssue[]>())

  const orderedKinds: LintIssue['kind'][] = ['dangling-link', 'orphan', 'community-singleton', 'community-oversized', 'realtime-conflict']

  return (
    <div className="absolute top-16 right-4 z-50 w-80 max-h-[70vh] flex flex-col bg-background/95 backdrop-blur border rounded-lg shadow-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t('wiki.lint.title')}</span>
          <span className="text-[10px] text-muted-foreground">
            {t('wiki.lint.stats', {
              pages: report.stats.nodeCount,
              links: report.stats.edgeCount,
              communities: report.stats.communityCount,
            })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRecompute}
            title={t('wiki.lint.recompute')}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('wiki.lint.close')}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {report.issues.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">{t('wiki.lint.noIssues')}</p>
        ) : (
          orderedKinds.map((kind) => {
            const issues = groups.get(kind)
            if (!issues || issues.length === 0) return null
            return (
              <div key={kind}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium">{t(KIND_LABEL_KEYS[kind])}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {t('wiki.lint.issueCount', { count: issues.length })}
                  </span>
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
                            'aria-label': t('wiki.lint.locateNode', { message: issue.message }),
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
    </div>
  )
}

function SeverityIcon({ severity }: { severity: LintIssue['severity'] }) {
  if (severity === 'warning') {
    return <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
  }
  return <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
}

function SeverityBadge({ severity }: { severity: LintIssue['severity'] }) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full border',
        severity === 'warning'
          ? 'bg-amber-50 text-amber-700 border-amber-200'
          : 'bg-slate-50 text-slate-700 border-slate-200',
      )}
    >
      {severity === 'warning' ? t('wiki.lint.severity.warning') : t('wiki.lint.severity.info')}
    </span>
  )
}
