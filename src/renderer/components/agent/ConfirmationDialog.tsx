/**
 * 事后提示（不是审批）。
 *
 * 该数据源来自 PostToolUse 之后的工具结果，此时文件已经被修改、命令已经执行。
 * 因此这里**不提供**「确认/拒绝」语义——拒绝也无法撤销，只会误导用户以为存在写前拦截。
 * 真正的写前审批见 ApprovalRequestDialog（D4）。
 */
import { AlertTriangle } from 'lucide-react'
import { useMessageStore } from '@/store/messageStore'
import { useI18n } from '../../i18n/useI18n'

export function ConfirmationDialog() {
  const { t } = useI18n()
  const pendingConfirmations = useMessageStore((s) => s.pendingConfirmations)
  const confirmToolCall = useMessageStore((s) => s.confirmToolCall)

  const entries = Array.from(pendingConfirmations.entries())
  if (entries.length === 0) return null

  return (
    <div className="space-y-2 mx-2 mb-2">
      {entries.map(([threadId, threadMap]) => {
        if (!threadMap || threadMap.size === 0) return null
        return [...threadMap.entries()].map(([toolCallId, pending]) => {
          if (!pending) return null
          const { toolCall } = pending
          const reason =
            toolCall.type === 'file_edit'
              ? t('agent.confirm.editFile')
              : toolCall.type === 'file_create'
                ? t('agent.confirm.createFile')
                : toolCall.type === 'terminal'
                  ? t('agent.confirm.terminal')
                  : t('agent.confirm.generic')

          return (
            <div
              key={toolCallId}
              className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 rounded-lg p-3"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {t('agent.confirm.title')}
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">{reason}</p>
                  {toolCall?.filePath && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 font-mono truncate">
                      {toolCall.filePath}
                    </p>
                  )}
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{t('agent.confirm.notUndoable')}</p>
                </div>
              </div>
              <div className="flex gap-2 mt-2 justify-end">
                <button
                  onClick={() => confirmToolCall(threadId, toolCallId, true)}
                  className="px-3 py-1 text-xs rounded-md border border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900"
                >
                  {t('agent.confirm.acknowledge')}
                </button>
              </div>
            </div>
          )
        })
      })}
    </div>
  )
}
