export const graphZh = {
  'graph.type.online': '已上线场景',
  'graph.type.dev': '开发场景',
  'graph.nameSuffix.online': '产品蓝图',
  'graph.nameSuffix.dev': '开发场景',
  'graph.tab.new': '新建图',
  'graph.tab.namePlaceholder': '图名称',
  'graph.tab.deriveFrom': '从在线图派生',
  'graph.tab.blank': '空白图',
  'graph.tab.cancel': '取消',
  'graph.tab.create': '创建',
  /** 新建图的默认名 —— 预填在名称输入框里，用户可改 */
  'graph.tab.defaultName': '新工作图 {n}',
  /** 名称为空时的提示（空名不再静默失败） */
  'graph.tab.nameRequired': '请输入图名称',
  'graph.tab.project': '项目',
  'graph.tab.noProject': '未绑定项目',
  /** 选了派生源 → 项目由源图决定，锁定并说明原因 */
  'graph.tab.deriveProjectLocked': '派生图继承源蓝图的所属项目，不能在此更改',
  'graph.tab.deriveNoProject': '源蓝图未绑定项目，派生图也不会有项目',
} as const

export const graphEn: Record<keyof typeof graphZh, string> = {
  'graph.type.online': 'Online Scenario',
  'graph.type.dev': 'Dev Scenario',
  'graph.nameSuffix.online': 'Product Blueprint',
  'graph.nameSuffix.dev': 'Dev Scenario',
  'graph.tab.new': 'New Graph',
  'graph.tab.namePlaceholder': 'Graph name',
  'graph.tab.deriveFrom': 'Derive from online graph',
  'graph.tab.blank': 'Blank graph',
  'graph.tab.cancel': 'Cancel',
  'graph.tab.create': 'Create',
  'graph.tab.defaultName': 'New Work Graph {n}',
  'graph.tab.nameRequired': 'Please enter a graph name',
  'graph.tab.project': 'Project',
  'graph.tab.noProject': 'No project',
  'graph.tab.deriveProjectLocked': 'The derived graph inherits the project of the source blueprint and cannot be changed here',
  'graph.tab.deriveNoProject': 'The source blueprint has no project, so the derived graph will not have one either',
}
