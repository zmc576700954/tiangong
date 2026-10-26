/**
 * 通用域（通用按钮 / 应用外壳 / 文件树反馈 / Toast）。
 *
 * zh 是 key 的真值来源，en 必须逐条覆盖。
 */
export const commonZh = {
  'common.save': '保存',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.confirm': '确认',
  'common.close': '关闭',
  'common.loading': '加载中…',
  'common.retry': '重试',
  'common.back': '返回',
  'common.next': '下一步',
  'common.empty': '暂无内容',
  'common.greeting': '你好，{name}',

  // ---- 应用外壳（App.tsx） ----
  'app.welcome.title': '欢迎使用 BizGraph',
  'app.welcome.hint': '创建或选择一个图开始工作',
  'app.showProjectPanel': '显示项目面板',
  'app.showFileTree': '显示文件树',
  'app.showFileTreeShortcut': '显示文件树（Ctrl+B）',
  'app.showRightPanel': '显示右侧面板',
  'app.showRightPanelShortcut': '显示右侧面板（Ctrl+J）',

  // ---- 错误边界（ErrorBoundary，类组件用模块级 t()） ----
  'app.errorBoundary.defaultLabel': '应用',
  'app.errorBoundary.message': '{label}发生错误',
  'app.errorBoundary.unknown': '未知错误',
  'app.errorBoundary.retry': '重试',
  'app.errorBoundary.retryLabel': '重试{label}',
  'app.errorBoundary.reload': '重新加载页面',
  'app.errorBoundary.panel.projects': '项目面板',
  'app.errorBoundary.panel.canvas': '画布',
  'app.errorBoundary.panel.agent': 'Agent 面板',

  // ---- 文件树操作反馈（fileTreeStore，模块级 t()） ----
  'fileTree.pasteSuccess': '粘贴成功',
  'fileTree.pasteFailed': '粘贴失败：{error}',
  'fileTree.renameSuccess': '重命名成功',
  'fileTree.renameFailed': '重命名失败：{error}',
  'fileTree.createFileSuccess': '已创建文件：{name}',
  'fileTree.createFileFailed': '创建文件失败：{error}',
  'fileTree.createFolderSuccess': '已创建文件夹：{name}',
  'fileTree.createFolderFailed': '创建文件夹失败：{error}',
  'fileTree.deleteSuccess': '已删除 {count} 项',
  'fileTree.deleteFailed': '删除失败：{error}',
  'fileTree.moveSuccess': '移动成功',
  'fileTree.moveFailed': '移动失败：{error}',

  // ---- Toast ----
  'toast.close': '关闭通知',
  'toast.closeTitle': '关闭',
} as const

export const commonEn: Record<keyof typeof commonZh, string> = {
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.confirm': 'Confirm',
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.empty': 'Nothing here',
  'common.greeting': 'Hello, {name}',

  'app.welcome.title': 'Welcome to BizGraph',
  'app.welcome.hint': 'Create or select a graph to get started',
  'app.showProjectPanel': 'Show project panel',
  'app.showFileTree': 'Show file tree',
  'app.showFileTreeShortcut': 'Show file tree (Ctrl+B)',
  'app.showRightPanel': 'Show right panel',
  'app.showRightPanelShortcut': 'Show right panel (Ctrl+J)',

  'app.errorBoundary.defaultLabel': 'App',
  'app.errorBoundary.message': '{label} encountered an error',
  'app.errorBoundary.unknown': 'Unknown error',
  'app.errorBoundary.retry': 'Retry',
  'app.errorBoundary.retryLabel': 'Retry {label}',
  'app.errorBoundary.reload': 'Reload page',
  'app.errorBoundary.panel.projects': 'Project panel',
  'app.errorBoundary.panel.canvas': 'Canvas',
  'app.errorBoundary.panel.agent': 'Agent panel',

  'fileTree.pasteSuccess': 'Pasted successfully',
  'fileTree.pasteFailed': 'Paste failed: {error}',
  'fileTree.renameSuccess': 'Renamed successfully',
  'fileTree.renameFailed': 'Rename failed: {error}',
  'fileTree.createFileSuccess': 'Created file: {name}',
  'fileTree.createFileFailed': 'Create file failed: {error}',
  'fileTree.createFolderSuccess': 'Created folder: {name}',
  'fileTree.createFolderFailed': 'Create folder failed: {error}',
  'fileTree.deleteSuccess': 'Deleted {count} item(s)',
  'fileTree.deleteFailed': 'Delete failed: {error}',
  'fileTree.moveSuccess': 'Moved successfully',
  'fileTree.moveFailed': 'Move failed: {error}',

  'toast.close': 'Dismiss notification',
  'toast.closeTitle': 'Close',
}
