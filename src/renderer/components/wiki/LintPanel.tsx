import { AlertTriangle, Info, RotateCw, Wrench } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { useI18n } from '../../i18n/useI18n'
import type { TranslationKey } from '@shared/i18n'
import { FloatingPanel } from '../ui/FloatingPanel'
import { toastError, toastSuccess } from '../../lib/toast'
import type { LintReport, LintIssue, LintSeverity, LintFixAction } from '@shared/types/wiki'

interface LintPanelProps {
  report: LintReport
  onNavigate: (nodeId: string) => void
  onClose: () => void
  onRecompute: () => void
  onApplyFix?: (issue: LintIssue) => Promise<void> | void
}

/** 检查项分类标签——按 kind 查 i18n key */
const KIND_LABEL_KEYS: Record<LintIssue['kind'], TranslationKey> = {
  'dangling-link': 'wiki.lint.kind.danglingLink',
  'orphan': 'wiki.lint.kind.orphan',
  'community-singleton': 'wiki.lint.kind.communitySingleton',
  'community-oversized': 'wiki.lint.kind.communityOversized',
  'missing-frontmatter': 'wiki.lint.kind.missingFrontmatter',
  'inconsistent-case': 'wiki.lint.kind.inconsistentCase',
  'realtime-conflict': 'wiki.lint.kind.realtimeConflict',
}

/** 严重度标签——按 severity 查 i18n key */
const SEVERITY_LABEL_KEYS: Record<LintSeverity, TranslationKey> = {
  error: 'wiki.lint.severity.error',
  warning: 'wiki.lint.severity.warning',
  info: 'wiki.lint.severity.info',
}

/** 修复按钮 tooltip——按 fix.kind 查 i18n key */
const FIX_TOOLTIP_KEYS: Record<LintFixAction['kind'], TranslationKey> = {
  'create-stub-page': 'wiki.lint.fix.createStubPage',
  'add-frontmatter': 'wiki.lint.fix.addFrontmatter',
  'normalize-case': 'wiki.lint.fix.normalizeCase',
}

/** 严重度排序：error > warning > info（数值越小越靠前） */
const SEVERITY_ORDER: Record<LintSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
}

/** 组内 kind 的展示顺序 */
const KIND_ORDER: LintIssue['kind'][] = [
  'dangling-link',
  'missing-frontmatter',
  'inconsistent-case',
  'orphan',
  'community-singleton',
  'community-oversized',
  'realtime-conflict',
]

export function LintPanel({
  report,
  onNavigate,
  onClose,
  onRecompute,
  onApplyFix,
}: LintPanelProps) {
  const { t } = useI18n()
  // 维护一个本地 issue 列表，修复后立刻移除以提供即时反馈
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [fixing, setFixing] = useState<Set<string>>(new Set())

  const visible = report.issues.filter((issue) => !dismissed.has(issueKey(issue)))

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
    try {
      await onApplyFix(issue)
      setDismissed((prev) => new Set(prev).add(issueKey(issue)))
      toastSuccess(t('wiki.lint.fixed', { message: issue.message }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('wiki.lint.fixFailed', { message: msg }))
    } finally {
      setFixing((prev) => {
        const next = new Set(prev)
        next.delete(issueKey(issue))
        return next
      })
    }
  }

  return (
    <FloatingPanel
      isOpen
      onClose={onClose}
      title={t('wiki.lint.title')}
      variant="corner"
      width="md"
      subtitle={
        <span>
          {t('wiki.lint.stats', {
            pages: report.stats.nodeCount,
            links: report.stats.edgeCount,
            communities: report.stats.communityCount,
          })}
        </span>
      }
      headerActions={
        <button
          type="button"
          onClick={onRecompute}
          title={t('wiki.lint.recompute')}
          aria-label={t('wiki.lint.recompute')}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
        >
          <RotateCw className="w-3.5 h-3.5" />
        </button>
      }
    >
      <div className="h-full overflow-y-auto p-3 space-y-3">
        {visible.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">{t('wiki.lint.noIssues')}</p>
        ) : (
          orderedSeverities.map((severity) => {
            const issues = bySeverity.get(severity) ?? []
            const groups = groupedByKind(issues)
            return (
              <div key={severity}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <SeverityBadge severity={severity} />
                  <span className="text-[10px] text-muted-foreground">
                    {t('wiki.lint.issueCount', { count: issues.length })}
                  </span>
                </div>
                <div className="space-y-2">
                  {KIND_ORDER.filter((k) => groups.has(k)).map((kind) => {
                    const list = groups.get(kind) ?? []
                    return (
                      <div key={kind}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium">{t(KIND_LABEL_KEYS[kind])}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {t('wiki.lint.issueCount', { count: list.length })}
                          </span>
                        </div>
                        <ul className="space-y-1.5">
                          {list.map((issue, idx) => (
                            <IssueRow
                              key={`${kind}-${severity}-${idx}-${issue.nodeId ?? ''}-${issue.message}`}
                              issue={issue}
                              isFixing={fixing.has(issueKey(issue))}
                              onNavigate={onNavigate}
                              onFix={onApplyFix ? () => handleFix(issue) : undefined}
                            />
                          ))}
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
    </FloatingPanel>
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
  const { t } = useI18n()
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
        {issue.fixable && issue.fix && onFix && (
          <button
            type="button"
            disabled={isFixing}
            onClick={(e) => {
              e.stopPropagation()
              onFix()
            }}
            title={t(FIX_TOOLTIP_KEYS[issue.fix.kind])}
            aria-label={t('wiki.lint.fix.action', { message: issue.message })}
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
  const { t } = useI18n()
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
      {t(SEVERITY_LABEL_KEYS[severity])}
    </span>
  )
}

/** 稳定的 issue key，用于 dismissed / fixing 状态关联 */
function issueKey(issue: LintIssue): string {
  return `${issue.code}:${issue.nodeId ?? ''}:${issue.message}`
}
