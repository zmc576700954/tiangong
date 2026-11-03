import { useState } from 'react'
import { Lock, FileCode2, X, Trash2, Plus, AlertTriangle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useI18n } from '../../i18n/useI18n'

/**
 * 会话的文件范围编辑器。
 *
 * 三态：
 * - **只读**（范围为空）—— 说清「Agent 改不了文件」，并给一个「放开范围」的入口
 * - **可写**（范围非空）—— 列出范围文件，可单个删、可整体清空
 * - **适配器不保证只读** —— 警告条：这个适配器无法保证只读
 *
 * 范围为空 ⇒ 只读。这是本项目的默认语义：「用户没圈定可改范围 ⇒ 别乱改」。
 */
export function ScopeEditor({
  effectiveFiles,
  readonly,
  adapterSupportsReadonly,
  frozen = false,
  onAddFile,
  onRemoveFile,
  onClearAll,
}: {
  effectiveFiles: string[]
  readonly: boolean
  adapterSupportsReadonly: boolean
  /**
   * 会话已在运行 —— 范围在 startSession 时就被主进程**冻结**了，
   * 此时编辑对在跑的会话不生效（改动对下一次会话生效）。
   */
  frozen?: boolean
  onAddFile: (relPath: string) => void
  onRemoveFile: (relPath: string) => void
  onClearAll: () => void
}) {
  const { t } = useI18n()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const submitAdd = () => {
    const path = draft.trim()
    if (!path) return
    onAddFile(path)
    setDraft('')
    setAdding(false)
  }

  return (
    <div
      data-testid="scope-editor"
      className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground"
    >
      {!adapterSupportsReadonly && (
        <div
          data-testid="scope-editor-adapter-warning"
          className="flex items-start gap-1.5 mb-1.5 p-1.5 rounded bg-amber-50 text-amber-700"
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{t('agent.scope.adapterUnsupported')}</span>
        </div>
      )}

      {frozen && (
        <div
          data-testid="scope-editor-frozen"
          className="flex items-start gap-1.5 mb-1.5 p-1.5 rounded bg-muted text-muted-foreground"
        >
          <Lock className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{t('agent.scope.frozenHint')}</span>
        </div>
      )}

      {readonly ? (
        <div className="flex items-center gap-1.5">
          <Lock className="w-3 h-3 shrink-0" />
          <span data-testid="scope-editor-readonly" className="flex-1">
            {t('agent.scope.readonlyHint')}
          </span>
          {!frozen && (
            <button
              data-testid="scope-editor-open-scope"
              onClick={() => setAdding((v) => !v)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-muted transition-colors"
            >
              <Plus className="w-3 h-3" />
              {t('agent.scope.openScope')}
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <FileCode2 className="w-3 h-3 shrink-0" />
          <span data-testid="scope-editor-writable" className="flex-1">
            {t('agent.scope.writableHint', { count: effectiveFiles.length })}
          </span>
          {!frozen && (
            <button
              data-testid="scope-editor-open-scope"
              onClick={() => setAdding((v) => !v)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-muted transition-colors"
            >
              <Plus className="w-3 h-3" />
              {t('agent.scope.addFile')}
            </button>
          )}
          {!frozen && (
            <button
              data-testid="scope-editor-clear-all"
              onClick={onClearAll}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-destructive/10 text-destructive transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              {t('agent.scope.clearAll')}
            </button>
          )}
        </div>
      )}

      {adding && (
        <div className="flex items-center gap-1 mt-1.5">
          <input
            data-testid="scope-editor-add-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAdd()
              if (e.key === 'Escape') {
                setAdding(false)
                setDraft('')
              }
            }}
            placeholder={t('agent.scope.addPlaceholder')}
            className="flex-1 px-1.5 py-0.5 rounded border bg-background text-[11px]"
          />
          <button
            data-testid="scope-editor-add-confirm"
            onClick={submitAdd}
            className="px-1.5 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {t('agent.scope.addConfirm')}
          </button>
        </div>
      )}

      {effectiveFiles.length > 0 && (
        <ul data-testid="scope-editor-files" className="mt-1 space-y-0.5">
          {effectiveFiles.map((file) => (
            <li key={file} className="flex items-center gap-1 group">
              <span className="truncate flex-1" title={file}>
                {file}
              </span>
              <button
                data-testid={`scope-editor-remove-${file}`}
                onClick={() => onRemoveFile(file)}
                className={cn(
                  'p-0.5 rounded hover:bg-destructive/10 text-destructive',
                  'opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity',
                )}
                title={t('agent.scope.removeFile')}
              >
                <X className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
