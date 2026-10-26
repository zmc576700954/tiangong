export const graphZh = {
  'graph.type.online': '已上线场景',
  'graph.type.dev': '开发场景',
} as const

export const graphEn: Record<keyof typeof graphZh, string> = {
  'graph.type.online': 'Online Scenario',
  'graph.type.dev': 'Dev Scenario',
}
