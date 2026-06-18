import { AlertTriangle, Check, X } from 'lucide-react'
import { useMessageStore } from '@/store/messageStore'

export function ConfirmationDialog() {
  const pendingConfirmations = useMessageStore(s => s.pendingConfirmations)
  const confirmToolCall = useMessageStore(s => s.confirmToolCall)

  const entries = Array.from(pendingConfirmations.entries())
  if (entries.length === 0) return null

  return (
    <div className="space-y-2 mx-2 mb-2">
      {entries.map(([threadId, threadMap]) => {
        if (!threadMap || threadMap.size === 0) return null
        return [...threadMap.entries()].map(([toolCallId, pending]) => {
          if (!pending) return null
          const { toolCall } = pending
          const reason = toolCall.type === 'file_edit'
            ? 'Agent wants to edit a file'
            : toolCall.type === 'file_create'
              ? 'Agent wants to create a file'
              : toolCall.type === 'terminal'
                ? 'Agent wants to run a terminal command'
                : 'Agent requests confirmation'

          return (
            <div key={toolCallId} className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Confirmation Required</p>
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">{reason}</p>
                  {toolCall?.filePath && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 font-mono truncate">{toolCall.filePath}</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 mt-2 justify-end">
                <button
                  onClick={() => confirmToolCall(threadId, toolCallId, false)}
                  className="flex items-center gap-1 px-3 py-1 text-xs rounded-md border border-red-300 dark:border-red-600 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
                >
                  <X size={12} /> Reject
                </button>
                <button
                  onClick={() => confirmToolCall(threadId, toolCallId, true)}
                  className="flex items-center gap-1 px-3 py-1 text-xs rounded-md bg-amber-600 text-white hover:bg-amber-700"
                >
                  <Check size={12} /> Confirm
                </button>
              </div>
            </div>
          )
        })
      })}
    </div>
  )
}
