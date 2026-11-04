/**
 * Dialog IPC Handlers
 * 系统对话框：目录选择等
 */

import { dialog } from 'electron'
import type { TypedHandle } from './utils'
import { addTrustedProjectRoot } from '../services/project-roots'

export function registerDialogHandlers(typedHandle: TypedHandle): void {
  typedHandle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择项目目录',
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const picked = result.filePaths[0]
    // 用户亲手选中的目录 → 记入主进程信任根（fs 白名单校验基准之一）
    await addTrustedProjectRoot(picked).catch(() => {})
    return picked
  })

  typedHandle('dialog:openFiles', async (_, options?: { extensions?: string[] }) => {
    const extensions = options?.extensions ?? ['md', 'markdown', 'txt']
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择要导入的文件',
      filters: [{ name: 'Documents', extensions }],
    })
    if (result.canceled) return []
    return result.filePaths
  })
}
