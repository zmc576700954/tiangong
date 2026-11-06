/**
 * M1 ②：长尾 CLI 的合成文件变更证据卡片。
 *
 * 诚实原则：
 * - 标题明确「依据工作区差分推断，非工具调用记录」；
 * - 不展示任何编造的工具名（没有 Edit / Write 之类）；
 * - 只证明「文件变了」，不证明「哪个工具改的」；
 * - 项目目录之外的写入不在证据范围；
 * - 截断/扫描不完整时如实标注，不把不完整证据说成完整。
 */

import { useMemo } from 'react'
import { FileDiff, FileMinus2, FilePenLine, FilePlus2 } from 'lucide-react'
import { useI18n } from '../../i18n/useI18n'
import type { FileChangeEvidence } from '@shared/types/agent'

interface Props {
  evidence: FileChangeEvidence
}

const CHANGE_META = {
  add: { icon: FilePlus2, className: 'text-emerald-600 dark:text-emerald-400' },
  modify: { icon: FilePenLine, className: 'text-amber-600 dark:text-amber-400' },
  delete: { icon: FileMinus2, className: 'text-rose-600 dark:text-rose-400' },
} as const

export function FileChangeEvidenceCard({ evidence }: Props) {
  const { t } = useI18n()

  const counts = useMemo(() => {
    const result = { add: 0, modify: 0, delete: 0 }
    for (const change of evidence.changes) {
      result[change.changeType] += 1
    }
    return result
  }, [evidence.changes])

  return (
    <div
      className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs"
      data-testid="file-change-evidence"
    >
      <div className="flex items-start gap-2">
        <FileDiff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{t('agent.evidence.title')}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground" data-testid="file-change-evidence-source">
            {t('agent.evidence.sourceLine')}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground" data-testid="file-change-evidence-counts">
            {t('agent.evidence.counts', {
              add: counts.add,
              modify: counts.modify,
              delete: counts.delete,
            })}
          </div>
        </div>
      </div>

      {evidence.changes.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto font-mono text-[11px]" data-testid="file-change-evidence-list">
          {evidence.changes.map((change) => {
            const meta = CHANGE_META[change.changeType]
            const Icon = meta.icon
            return (
              <li key={`${change.changeType}:${change.path}`} className="flex items-center gap-1.5">
                <Icon className={`h-3 w-3 shrink-0 ${meta.className}`} />
                <span className="truncate text-foreground">{change.path}</span>
              </li>
            )
          })}
        </ul>
      )}

      {evidence.truncated && (
        <div className="mt-2 text-[10px] text-amber-700 dark:text-amber-400" data-testid="file-change-evidence-truncated">
          {t('agent.evidence.truncated', {
            displayed: evidence.displayedCount,
            total: evidence.totalCount,
          })}
        </div>
      )}

      {evidence.scanTruncated && (
        <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-400" data-testid="file-change-evidence-scan-truncated">
          {t('agent.evidence.scanTruncated', {
            reason: evidence.scanTruncatedReason ?? 'unknown',
          })}
        </div>
      )}

      <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground" data-testid="file-change-evidence-limitation">
        {t('agent.evidence.limitation')}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={evidence.root}>
        {t('agent.evidence.pathScope', { root: evidence.root })}
      </div>
    </div>
  )
}
