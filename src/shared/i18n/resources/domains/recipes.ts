/**
 * Recipes 域（Recipe 面板：列表 / 详情 / 参数表单 / 步骤预览 / 运行历史）。
 *
 * zh 是 key 的真值来源，en 必须逐条覆盖。
 *
 * 注意：recipe 的名称、描述、inputs_schema[].label 是用户自己写的内容，
 * 不进这里；面板只翻译界面自有的骨架文案。
 */
export const recipesZh = {
  'recipes.title': 'Recipes',
  'recipes.refresh': '重新扫描',
  'recipes.apiUnavailable': 'electronAPI 不可用',
  'recipes.emptyPrefix': '尚未加载任何 Recipe。请在',
  'recipes.emptyConnector': '或',
  'recipes.emptySuffix': ' 下创建 YAML 文件，然后点击 ↻ 重新扫描。',
  'recipes.stepCount': '{count} 个步骤',
  'recipes.subRecipeCount': '{count} 个子 Recipe',
  'recipes.source.user': '用户级',
  'recipes.source.project': '项目级',
  'recipes.inputs': '参数',
  'recipes.run': '运行 Recipe',
  'recipes.running': '运行中…',
  'recipes.steps': '步骤（{count}）',
  'recipes.runHistory': '运行历史（{count}）',
  'recipes.noRuns': '暂无运行记录',
  'recipes.cancel': '取消',
  'recipes.selectHint': '请在左侧选择一个 Recipe',
  'recipes.status.pending': '待运行',
  'recipes.status.running': '运行中',
  'recipes.status.succeeded': '成功',
  'recipes.status.failed': '失败',
  'recipes.status.cancelled': '已取消',
} as const

export const recipesEn: Record<keyof typeof recipesZh, string> = {
  'recipes.title': 'Recipes',
  'recipes.refresh': 'Rescan',
  'recipes.apiUnavailable': 'electronAPI is not available',
  'recipes.emptyPrefix': 'No recipes loaded. Create YAML files in',
  'recipes.emptyConnector': 'or',
  'recipes.emptySuffix': ', then click ↻ to rescan.',
  'recipes.stepCount': '{count} step(s)',
  'recipes.subRecipeCount': '{count} sub-recipe(s)',
  'recipes.source.user': 'User',
  'recipes.source.project': 'Project',
  'recipes.inputs': 'Inputs',
  'recipes.run': 'Run Recipe',
  'recipes.running': 'Running…',
  'recipes.steps': 'Steps ({count})',
  'recipes.runHistory': 'Run History ({count})',
  'recipes.noRuns': 'No runs yet.',
  'recipes.cancel': 'Cancel',
  'recipes.selectHint': 'Select a recipe on the left',
  'recipes.status.pending': 'pending',
  'recipes.status.running': 'running',
  'recipes.status.succeeded': 'succeeded',
  'recipes.status.failed': 'failed',
  'recipes.status.cancelled': 'cancelled',
}
