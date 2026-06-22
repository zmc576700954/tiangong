import { useState, useEffect } from 'react'
import type { ContextState } from '@shared/types'

/**
 * Subscribes to waterline:change events for a specific thread.
 * Returns the latest ContextState or null if not available.
 */
export function useWaterline(threadId: string | null): ContextState | null {
  const [state, setState] = useState<ContextState | null>(null)

  useEffect(() => {
    if (!threadId) {
      setState(null)
      return
    }

    if (typeof window === 'undefined' || !window.electronAPI) return

    // Load initial state
    window.electronAPI['context:getWaterline'](threadId).then((s) => {
      setState(s)
    })

    // Subscribe to push updates
    if (!window.electronAPI.onWaterlineChange) return

    const cleanup = window.electronAPI.onWaterlineChange((newState: ContextState) => {
      if (newState.threadId === threadId) {
        setState(newState)
      }
    })

    return cleanup
  }, [threadId])

  return state
}
