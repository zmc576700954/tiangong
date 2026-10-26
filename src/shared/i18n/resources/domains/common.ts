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
}
