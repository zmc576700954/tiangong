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
  'canvas.node.wikiContentTemplate': '# {title}\n\n',

  // ── 边 ──
  'canvas.edge.confirmAssociation': '确认关联',
  'canvas.edge.rejectAssociation': '拒绝关联',

  // ── 工具栏 / 布局 ──
  'canvas.layout.arrange': '整理布局',
  'canvas.layout.menuTooltip': '自动布局（树形 / 力导向）',
  'canvas.layout.modeTree': '· 树形',
  'canvas.layout.modeForce': '· 力导向',
  'canvas.layout.label': '自动布局',
  'canvas.layout.tree': '树形布局',
  'canvas.layout.treeDesc': 'dagre 层级布局，适合 project → module → feature',
  'canvas.layout.force': '力导向布局',
  'canvas.layout.forceDesc': 'd3-force，按边关系 + 排斥力均衡，跨模块图更均匀',

  // ── 连线模式 ──
  'canvas.connecting.hint': '连线模式：点击目标节点完成连线',
  'canvas.connecting.cancel': '取消 (Esc)',

  // ── 删除确认 ──
  'canvas.delete.confirm': '确认删除？此操作不可撤销',
  'canvas.delete.confirmButton': '确认删除',
  'canvas.delete.now': '立即删除',
  'canvas.delete.nodeHint': '按 Delete 删除节点',
  'canvas.delete.edgeHint': '按 Delete 删除连接线',

  // ── Wiki 导入 ──
  'canvas.import.summary': '导入完成：新建 {created}，更新 {updated}，失败 {failed}',

  // ── 空白画布引导 ──
  'canvas.overlay.emptyTitle': '画布为空',
  'canvas.overlay.emptyHint': '右键点击画布创建第一个节点',
  'canvas.overlay.rightClickCreate': '右键创建',
  'canvas.overlay.dragConnect': '拖拽连线',
  'canvas.overlay.addNode': '添加节点',
  'canvas.overlay.importWiki': '导入 Wiki 页面…',
  'canvas.overlay.llmImportWiki': 'LLM 提炼导入 Wiki 页面…',
  'canvas.overlay.selectEdgeType': '选择连接类型',
  'canvas.overlay.createEdge': '确认创建',

  // ── 节点右键菜单 ──
  'canvas.contextMenu.addChild': '添加子节点',
  'canvas.contextMenu.aiGenerate': 'AI 生成',
  'canvas.contextMenu.addRelation': '添加关联连线',
  'canvas.contextMenu.addContext': '添加上下文',
  'canvas.contextMenu.aiActions': 'AI 操作',
  'canvas.contextMenu.aiFillDetails': 'AI 补充详情',
  'canvas.contextMenu.generatePrompt': '生成开发 Prompt',
  'canvas.contextMenu.fanout': 'Fan-out 子代理 (基于选中节点)',
  'canvas.contextMenu.status': '状态',
  'canvas.contextMenu.deleteNode': '删除节点',

  // ── 拖拽重挂 ──
  // 前三条是**落点非法时的原因提示**（红框旁的说明文字），不是 toast ——
  // 非法落点的行为是「退化成普通移动」，不是报错。
  'canvas.reparent.invalidType': '类型不允许此父子关系',
  'canvas.reparent.cycle': '不能挂到自己的子节点下',
  'canvas.reparent.crossGraph': '不能跨图移动节点',
  'canvas.reparent.success': '已移动到 {parent}',
  'canvas.reparent.failed': '移动失败，已回到原位',

  // ── 子树折叠 ──
  'canvas.collapse.toggle': '折叠/展开子树',
  // ⚠️ 徽标上的数字是**全部后代**（传递闭包），不是直接子节点数 ——
  //    文案必须说「节点」，说「子节点」会跟数字对不上。
  'canvas.collapse.hiddenCount': '{count} 个节点已折叠',

  // ── 添加上下文浮层 ──
  'canvas.contextPopover.title': '添加上下文',
  'canvas.contextPopover.searchPlaceholder': '搜索项目文件...',
  'canvas.contextPopover.searching': '搜索中...',
  'canvas.contextPopover.labelPlaceholder': '标题（可选）',
  'canvas.contextPopover.bodyPlaceholder': '输入业务约束、技术要求等...',
  'canvas.contextPopover.addText': '添加文本',
  'canvas.contextPopover.added': '已添加 ({count})',
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
  'canvas.node.wikiContentTemplate': '# {title}\n\n',
  'canvas.edge.confirmAssociation': 'Confirm association',
  'canvas.edge.rejectAssociation': 'Reject association',

  'canvas.layout.arrange': 'Arrange layout',
  'canvas.layout.menuTooltip': 'Auto layout (tree / force-directed)',
  'canvas.layout.modeTree': '· Tree',
  'canvas.layout.modeForce': '· Force',
  'canvas.layout.label': 'Auto layout',
  'canvas.layout.tree': 'Tree layout',
  'canvas.layout.treeDesc': 'Dagre hierarchical layout, for project → module → feature',
  'canvas.layout.force': 'Force-directed layout',
  'canvas.layout.forceDesc': 'd3-force, balanced by edge relations and repulsion; even across modules',

  'canvas.connecting.hint': 'Connection mode: click a target node to finish',
  'canvas.connecting.cancel': 'Cancel (Esc)',

  'canvas.delete.confirm': 'Delete? This action cannot be undone',
  'canvas.delete.confirmButton': 'Delete',
  'canvas.delete.now': 'Delete now',
  'canvas.delete.nodeHint': 'Press Delete to delete the node',
  'canvas.delete.edgeHint': 'Press Delete to delete the edge',

  'canvas.import.summary': 'Import finished: {created} created, {updated} updated, {failed} failed',

  'canvas.overlay.emptyTitle': 'Canvas is empty',
  'canvas.overlay.emptyHint': 'Right-click the canvas to create the first node',
  'canvas.overlay.rightClickCreate': 'Right-click to create',
  'canvas.overlay.dragConnect': 'Drag to connect',
  'canvas.overlay.addNode': 'Add node',
  'canvas.overlay.importWiki': 'Import Wiki page…',
  'canvas.overlay.llmImportWiki': 'Distill with LLM into a Wiki page…',
  'canvas.overlay.selectEdgeType': 'Select connection type',
  'canvas.overlay.createEdge': 'Create',

  'canvas.contextMenu.addChild': 'Add child node',
  'canvas.contextMenu.aiGenerate': 'AI generate',
  'canvas.contextMenu.addRelation': 'Add related edge',
  'canvas.contextMenu.addContext': 'Add context',
  'canvas.contextMenu.aiActions': 'AI actions',
  'canvas.contextMenu.aiFillDetails': 'Fill details with AI',
  'canvas.contextMenu.generatePrompt': 'Generate dev prompt',
  'canvas.contextMenu.fanout': 'Fan-out subagents (from selected node)',
  'canvas.contextMenu.status': 'Status',
  'canvas.contextMenu.deleteNode': 'Delete node',

  'canvas.reparent.invalidType': 'This parent/child type is not allowed',
  'canvas.reparent.cycle': 'Cannot move a node under its own child',
  'canvas.reparent.crossGraph': 'Cannot move nodes across graphs',
  'canvas.reparent.success': 'Moved under {parent}',
  'canvas.reparent.failed': 'Move failed, the node went back to its original spot',

  'canvas.collapse.toggle': 'Collapse/expand subtree',
  'canvas.collapse.hiddenCount': '{count} collapsed nodes',

  'canvas.contextPopover.title': 'Add context',
  'canvas.contextPopover.searchPlaceholder': 'Search project files...',
  'canvas.contextPopover.searching': 'Searching...',
  'canvas.contextPopover.labelPlaceholder': 'Title (optional)',
  'canvas.contextPopover.bodyPlaceholder': 'Enter business constraints, technical requirements...',
  'canvas.contextPopover.addText': 'Add text',
  'canvas.contextPopover.added': 'Added ({count})',
}
