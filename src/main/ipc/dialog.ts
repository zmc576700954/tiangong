/**
 * Dialog IPC Handlers
 * 系统对话框：目录选择等
 */

import { dialog } from 'electron'
import type { TypedHandle } from './utils'

export function registerDialogHandlers(typedHandle: TypedHandle): void {
  typedHandle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择项目目录',
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
}
