/**
 * 画布区（GraphCanvas / BizNode / BizEdge / 节点右键菜单 / 覆盖层）的界面文案。
 *
 * zh 是 key 的真值来源，en 必须覆盖每一个 zh key。
 * Wiki 特殊页（Graph Index / Graph Log）的**存储标题**仍是英文标识符，
 * 这里只翻译画布上显示它们用的按钮文案。
 */
export const canvasZh = {
  // ── 画布容器 ──
  'canvas.ariaLabel': '业务图谱画布',

  // ── 顶部工具栏 ──
  'canvas.search.button': '搜索',
  'canvas.search.tooltip': '搜索节点 (Ctrl+F)',
  'canvas.search.placeholder': '搜索节点…',
  'canvas.search.nextResult': '下一个结果',
  'canvas.search.close': '关闭 (Esc)',
  'canvas.graphIndex': '图索引',
  'canvas.graphIndex.create': '创建图索引',
  'canvas.graphLog': '图日志',
  'canvas.graphLog.create': '创建图日志',
  'canvas.recipes.tooltip': 'Recipes — 可分享的 YAML 工作流',
  'canvas.recipes.close': '关闭',
  'canvas.recipes.closeAria': '关闭 Recipes 面板',

  // ── 关联通知 ──
  'canvas.notification.newAssociations': '发现 {count} 条新关联',

  // ── 节点 ──
  'canvas.node.newTitle': '新建{type}',
  'canvas.node.previewConfirm': '确认',
  'canvas.node.previewClear': '清除',

  // ── 边 ──
  'canvas.edge.confirmAssociation': '确认关联',
  'canvas.edge.rejectAssociation': '拒绝关联',
} as const

export const canvasEn: Record<keyof typeof canvasZh, string> = {
  'canvas.ariaLabel': 'Business graph canvas',
  'canvas.search.button': 'Search',
  'canvas.search.tooltip': 'Search nodes (Ctrl+F)',
  'canvas.search.placeholder': 'Search nodes…',
  'canvas.search.nextResult': 'Next result',
  'canvas.search.close': 'Close (Esc)',
  'canvas.graphIndex': 'Graph Index',
  'canvas.graphIndex.create': 'Create Graph Index',
  'canvas.graphLog': 'Graph Log',
  'canvas.graphLog.create': 'Create Graph Log',
  'canvas.recipes.tooltip': 'Recipes — shareable YAML workflows',
  'canvas.recipes.close': 'Close',
  'canvas.recipes.closeAria': 'Close Recipes panel',
  'canvas.notification.newAssociations': 'Found {count} new association(s)',
  'canvas.node.newTitle': 'New {type}',
  'canvas.node.previewConfirm': 'Confirm',
  'canvas.node.previewClear': 'Clear',
  'canvas.edge.confirmAssociation': 'Confirm association',
  'canvas.edge.rejectAssociation': 'Reject association',
}
