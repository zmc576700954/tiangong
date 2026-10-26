import type { MenuItemConstructorOptions } from 'electron'
import { t } from '@shared/i18n'

/**
 * Electron 原生菜单模板。
 *
 * 只做类型导入（`import type` 编译期擦除），运行时的 electron 依赖都放在
 * click 回调里动态取——这样本模块能在 vitest 的 node 环境里直接测。
 *
 * role 驱动的系统菜单项（copy / paste / undo / about …）**不设 label**：
 * macOS 上 Electron 会用系统语言给出这些文案，强行写死 label 反而压掉本地化。
 */
export function buildMenuTemplate(deps: {
  createWindow: () => void
  isMac: boolean
  quitApp?: () => void
}): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.openProject'),
          accelerator: 'CmdOrCtrl+O',
          click: async (_item, focusedWindow) => {
            const win = focusedWindow as Electron.BrowserWindow | null
            if (!win) return
            const { dialog } = await import('electron')
            const result = await dialog.showOpenDialog(win, {
              properties: ['openDirectory'],
              title: t('menu.selectProjectDir'),
            })
            if (result.canceled || result.filePaths.length === 0) return
            win.webContents.send('menu:openProject', result.filePaths[0])
          },
        },
        { type: 'separator' },
        {
          label: t('menu.newWindow'),
          accelerator: 'CmdOrCtrl+N',
          click: () => deps.createWindow(),
        },
        { type: 'separator' },
        {
          label: t('menu.closeWindow'),
          accelerator: deps.isMac ? 'Cmd+W' : 'Ctrl+W',
          click: (_item, focusedWindow) => {
            focusedWindow?.close()
          },
        },
        ...(deps.isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: t('menu.exit'),
                accelerator: 'Alt+F4',
                click: () => deps.quitApp?.(),
              },
            ]),
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'forceReload', label: t('menu.forceReload') },
        { role: 'toggleDevTools', label: t('menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.toggleFullScreen') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        ...(deps.isMac
          ? [
              { role: 'zoom', label: t('menu.zoom') } as const,
              { type: 'separator' as const },
              { role: 'front' } as const,
            ]
          : [{ role: 'close' } as const]),
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.about'),
          click: async () => {
            const { dialog } = await import('electron')
            dialog.showMessageBox({
              type: 'info',
              title: t('menu.about'),
              message: 'BizGraph v0.1.0',
              detail: t('menu.aboutDetail'),
            })
          },
        },
      ],
    },
  ]

  if (deps.isMac) {
    template.unshift({
      label: 'BizGraph',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  return template
}
