/**
 * Agent / 会话区文案
 *
 * 约定：Agent、Subagent、Wiki、CLI、MCP、API Key 及各适配器产品名保留英文；
 * 用户自己写的内容（消息正文、代码片段、文件路径）不进入本表。
 */
export const agentZh = {
  // —— 适配器选择 ——
  'agent.adapter.auto': '自动',
  'agent.adapter.select': '选择 Agent',
  'agent.adapter.default': '默认',
  'agent.adapter.notInstalled': '未安装',
  'agent.adapter.ready': '就绪',
  'agent.adapter.recovered': '✓ 适配器已恢复',

  // —— 顶部工具栏 ——
  'agent.header.threads': '会话',
  'agent.header.subagents': 'Subagent 调用记录',
  'agent.header.history': '历史记录',
  'agent.header.openInCli': '在 CLI 中打开',
  'agent.header.expand': '展开',
  'agent.header.collapse': '收起',

  // —— 通用动作 ——
  'agent.action.copy': '复制',
  'agent.action.copied': '已复制',
  'agent.action.refresh': '刷新',
  'agent.action.settings': '设置',
  'agent.action.stop': '停止',
  'agent.action.accept': '采纳',
  'agent.action.acceptAll': '全部采纳',
  'agent.action.reject': '拒绝',
  'agent.action.rejectAll': '全部拒绝',
  'agent.action.commit': '提交',

  // —— 输入框 ——
  'agent.input.placeholder': '输入消息，/ 触发命令，@ 引用上下文…',
  'agent.input.shiftEnterHint': 'Shift+Enter 换行',

  // —— 会话列表 / 历史 ——
  'agent.sidebar.expand': '展开侧栏',
  'agent.sidebar.collapse': '收起侧栏',
  'agent.search.threads': '搜索会话…',
  'agent.search.noMatches': '没有匹配的会话',
  'agent.thread.deleteConfirm': '确定要删除该会话吗？',
  'agent.history.empty': '未找到会话',
  'agent.history.boundNode': '节点',

  // —— 空状态 ——
  'agent.welcome.title': '欢迎使用 Agent',
  'agent.welcome.hint': '在下方输入消息，开始新的对话',
  'agent.chat.startConversation': '开始一段对话',
  'agent.chat.startHint': '输入消息，使用 / 调用命令，或用 @ 添加上下文',
  'agent.terminal.empty': '暂无输出',
  'agent.terminal.hint': 'Agent 的输出会显示在这里',

  // —— 消息气泡 ——
  'agent.message.you': '我',
  'agent.message.thinking': '思考中…',
  'agent.message.aborted': '已终止',
  'agent.output.showLess': '收起',
  'agent.output.showAllLines': '展开全部 {count} 行',
  'agent.output.copied': '已复制！',
  'agent.status.queued': '排队中',
  'agent.status.sending': '发送中',
  'agent.status.streaming': '接收中',
  'agent.status.sent': '已发送',
  'agent.status.failed': '失败',
  'agent.status.permanentlyFailed': '永久失败',
  'agent.progress.running': '执行中',
  'agent.details.show': '查看详情',
  'agent.details.hide': '隐藏详情',
  'agent.error.showRaw': '查看原始错误',
  'agent.error.hideRaw': '隐藏原始错误',

  // —— 上下文 ——
  'agent.context.label': '上下文',
  'agent.context.injected': '已注入上下文',
  'agent.context.tokens': '约 {count} tokens',
  'agent.refType.node': '节点',
  'agent.refType.file': '文件',
  'agent.refType.text': '文本',

  // —— 运行状态 ——
  'agent.running.working': '{agent} 正在工作…',
  'agent.running.editingVerb': '正在编辑',
  'agent.thinkingBanner': 'Agent 正在思考…',
  'agent.queue.queued': '排队中：{count}',
  'agent.queue.executing': '执行中：{count}',

  // —— 续跑 / 降级 ——
  'agent.resume.canContinue': '该会话可以继续',
  'agent.resume.action': '继续',
  'agent.resume.interrupted': '会话被中断，是否从中断处继续？',
  'agent.resume.dismiss': '忽略',
  'agent.degraded.notice': '已从 {from} 降级到 {to}，部分功能不可用',
  'agent.degraded.switchAdapter': '切换适配器',

  // —— 变更审查 ——
  'agent.review.changes': '审查变更',
  'agent.diff.changesTitle': '变更（{count} 个文件）',
  'agent.diff.acceptedCount': '已采纳 {accepted}/{total}',
  'agent.commit.failed': '提交失败',

  // —— 验收 ——
  'agent.verify.checking': '正在校验验收标准…',
  'agent.verify.backToEdit': '返回编辑',
  'agent.verify.reportTitle': '验收报告 — 通过 {passed}/{total}',
  'agent.verify.retryCount': '重试 {current}/{max}',
  'agent.verify.retryFailed': '重试失败项',
  'agent.verify.markComplete': '标记完成',

  // —— 上下文选择 / @ 引用 ——
  'agent.contextPicker.placeholder': '搜索节点…',
  'agent.contextPicker.noResults': '没有与「{filter}」匹配的结果',
  'agent.contextPicker.noNodes': '暂无可用节点',
  'agent.mention.tabNodes': '节点',
  'agent.mention.tabFiles': '文件',
  'agent.mention.noResults': '没有找到与「{filter}」匹配的{tab}',
  'agent.mention.typeToSearch': '输入内容以搜索{tab}',
  'agent.mention.searching': '搜索中…',
  'agent.mention.hint': 'Tab 切换 · ↑↓ 选择 · Enter 确认 · Esc 关闭',

  // —— 上下文水位 ——
  'agent.waterline.usage': '上下文占用：{used} / {max} tokens',
  'agent.waterline.compact': '压缩',
  'agent.waterline.compactNow': '立即压缩上下文',
  'agent.waterline.justNow': '刚刚',
  'agent.waterline.minutes': '{count} 分钟',
  'agent.waterline.hours': '{count} 小时',
  'agent.waterline.days': '{count} 天',

  // —— 工具调用确认 ——
  'agent.confirm.title': '需要确认',
  'agent.confirm.editFile': 'Agent 想要编辑文件',
  'agent.confirm.createFile': 'Agent 想要新建文件',
  'agent.confirm.terminal': 'Agent 想要执行终端命令',
  'agent.confirm.generic': 'Agent 请求确认',

  // —— Subagent ——
  'agent.subagent.invocations': 'Subagent 调用记录',
  'agent.subagent.empty': '暂无 Subagent 调用记录。',
  'agent.subagent.status.queued': '排队中',
  'agent.subagent.status.running': '执行中',
  'agent.subagent.status.completed': '已完成',
  'agent.subagent.status.failed': '失败',
  'agent.subagent.status.cancelled': '已取消',
  'agent.subagent.outputLine': '{count} 行输出',
  'agent.subagent.outputLines': '{count} 行输出',
  'agent.subagent.resultTokens': '结果 · {count} tokens',

  // —— 安装引导 ——
  'agent.install.recommended': '推荐方式',
  'agent.install.otherMethods': '其他方式',
  'agent.install.installing': '安装中…',
  'agent.install.viaNpm': '通过 npm 安装',
  'agent.install.none': '没有可用的安装方式',
  'agent.install.docs': '查看文档',
  'agent.install.readyHint': '该适配器已可使用。',
  'agent.install.unavailable': '不可用',
  'agent.setup.tools': 'Agent 工具',
  'agent.setup.chooseTools': '选择你的 Agent 工具',
  'agent.setup.installedCount': '已安装 {installed}/{total} 个适配器',
  'agent.setup.hint': '安装至少一个 Agent 工具，即可开始用 AI 编码',

  // —— 斜杠命令 ——
  'agent.commands.title': '命令',
  'agent.command.implementDescription': '按节点需求实现功能',
  'agent.command.fixBugDescription': '结合节点上下文修复缺陷',
  'agent.command.refactorDescription': '按节点约束完成重构',
  'agent.command.addTestDescription': '依据验收标准补充测试',

  // —— Fan-out ——
  'agent.fanout.title': '批量派发 Subagent',
  'agent.fanout.placeholder': '按需编辑提示词…',
  'agent.fanout.submit': '发送到当前会话',
} as const

export const agentEn: Record<keyof typeof agentZh, string> = {
  'agent.adapter.auto': 'Auto',
  'agent.adapter.select': 'Select Agent',
  'agent.adapter.default': 'default',
  'agent.adapter.notInstalled': 'not installed',
  'agent.adapter.ready': 'Ready',
  'agent.adapter.recovered': '✓ Adapter recovered',

  'agent.header.threads': 'Threads',
  'agent.header.subagents': 'Subagent invocations',
  'agent.header.history': 'History',
  'agent.header.openInCli': 'Open in CLI',
  'agent.header.expand': 'Expand',
  'agent.header.collapse': 'Collapse',

  'agent.action.copy': 'Copy',
  'agent.action.copied': 'Copied',
  'agent.action.refresh': 'Refresh',
  'agent.action.settings': 'Settings',
  'agent.action.stop': 'Stop',
  'agent.action.accept': 'Accept',
  'agent.action.acceptAll': 'Accept All',
  'agent.action.reject': 'Reject',
  'agent.action.rejectAll': 'Reject All',
  'agent.action.commit': 'Commit',

  'agent.input.placeholder': 'Type a message, / for commands, @ to add context...',
  'agent.input.shiftEnterHint': 'Shift+Enter for newline',

  'agent.sidebar.expand': 'Expand sidebar',
  'agent.sidebar.collapse': 'Collapse sidebar',
  'agent.search.threads': 'Search threads...',
  'agent.search.noMatches': 'No matching threads',
  'agent.thread.deleteConfirm': 'Are you sure you want to delete this thread?',
  'agent.history.empty': 'No threads found',
  'agent.history.boundNode': 'node',

  'agent.welcome.title': 'Welcome to Agent',
  'agent.welcome.hint': 'Type a message below to start a new conversation',
  'agent.chat.startConversation': 'Start a conversation',
  'agent.chat.startHint': 'Type a message, use / for commands, or @ to add context',
  'agent.terminal.empty': 'No output yet',
  'agent.terminal.hint': 'Agent output will appear here',

  'agent.message.you': 'You',
  'agent.message.thinking': 'Thinking...',
  'agent.message.aborted': 'Aborted',
  'agent.output.showLess': 'Show less',
  'agent.output.showAllLines': 'Show all {count} lines',
  'agent.output.copied': 'Copied!',
  'agent.status.queued': 'Queued',
  'agent.status.sending': 'Sending',
  'agent.status.streaming': 'Streaming',
  'agent.status.sent': 'Sent',
  'agent.status.failed': 'Failed',
  'agent.status.permanentlyFailed': 'Permanently failed',
  'agent.progress.running': 'running',
  'agent.details.show': 'Show details',
  'agent.details.hide': 'Hide details',
  'agent.error.showRaw': 'Show raw error',
  'agent.error.hideRaw': 'Hide raw error',

  'agent.context.label': 'Context',
  'agent.context.injected': 'Context injected',
  'agent.context.tokens': '~{count} tokens',
  'agent.refType.node': 'node',
  'agent.refType.file': 'file',
  'agent.refType.text': 'text',

  'agent.running.working': '{agent} is working...',
  'agent.running.editingVerb': 'is editing',
  'agent.thinkingBanner': 'Agent is thinking...',
  'agent.queue.queued': 'Queued: {count}',
  'agent.queue.executing': 'Executing: {count}',

  'agent.resume.canContinue': 'This session can be continued',
  'agent.resume.action': 'Resume',
  'agent.resume.interrupted': 'Session was interrupted. Continue from where you left off?',
  'agent.resume.dismiss': 'Dismiss',
  'agent.degraded.notice': 'Degraded from {from} to {to}; some features are unavailable',
  'agent.degraded.switchAdapter': 'Switch adapter',

  'agent.review.changes': 'Review Changes',
  'agent.diff.changesTitle': 'Changes ({count} files)',
  'agent.diff.acceptedCount': '{accepted}/{total} accepted',
  'agent.commit.failed': 'Commit failed',

  'agent.verify.checking': 'Verifying acceptance criteria...',
  'agent.verify.backToEdit': 'Back to Edit',
  'agent.verify.reportTitle': 'Verification Report — {passed}/{total} passed',
  'agent.verify.retryCount': 'Retry {current}/{max}',
  'agent.verify.retryFailed': 'Retry Failed',
  'agent.verify.markComplete': 'Mark Complete',

  'agent.contextPicker.placeholder': 'Search nodes...',
  'agent.contextPicker.noResults': 'No results for "{filter}"',
  'agent.contextPicker.noNodes': 'No available nodes',
  'agent.mention.tabNodes': 'Nodes',
  'agent.mention.tabFiles': 'Files',
  'agent.mention.noResults': 'No {tab} found for "{filter}"',
  'agent.mention.typeToSearch': 'Type to search {tab}',
  'agent.mention.searching': 'Searching...',
  'agent.mention.hint': 'Tab switch · ↑↓ navigate · Enter select · Esc close',

  'agent.waterline.usage': 'Context usage: {used} / {max} tokens',
  'agent.waterline.compact': 'Compact',
  'agent.waterline.compactNow': 'Compact context now',
  'agent.waterline.justNow': 'just now',
  'agent.waterline.minutes': '{count}m',
  'agent.waterline.hours': '{count}h',
  'agent.waterline.days': '{count}d',

  'agent.confirm.title': 'Confirmation Required',
  'agent.confirm.editFile': 'Agent wants to edit a file',
  'agent.confirm.createFile': 'Agent wants to create a file',
  'agent.confirm.terminal': 'Agent wants to run a terminal command',
  'agent.confirm.generic': 'Agent requests confirmation',

  'agent.subagent.invocations': 'Subagent Invocations',
  'agent.subagent.empty': 'No subagent invocations yet.',
  'agent.subagent.status.queued': 'queued',
  'agent.subagent.status.running': 'running',
  'agent.subagent.status.completed': 'completed',
  'agent.subagent.status.failed': 'failed',
  'agent.subagent.status.cancelled': 'cancelled',
  'agent.subagent.outputLine': '{count} output line',
  'agent.subagent.outputLines': '{count} output lines',
  'agent.subagent.resultTokens': 'Result · {count} tokens',

  'agent.install.recommended': 'Recommended',
  'agent.install.otherMethods': 'Other methods',
  'agent.install.installing': 'Installing...',
  'agent.install.viaNpm': 'Install via npm',
  'agent.install.none': 'No installation methods available',
  'agent.install.docs': 'View documentation',
  'agent.install.readyHint': 'This adapter is ready to use.',
  'agent.install.unavailable': 'Not available',
  'agent.setup.tools': 'Agent Tools',
  'agent.setup.chooseTools': 'Choose Your Agent Tools',
  'agent.setup.installedCount': '{installed} of {total} adapters installed',
  'agent.setup.hint': 'Install at least one agent tool to start coding with AI',

  'agent.commands.title': 'Commands',
  'agent.command.implementDescription': 'Implement a feature from node requirements',
  'agent.command.fixBugDescription': 'Fix a bug with context from node',
  'agent.command.refactorDescription': 'Refactor with constraints from node',
  'agent.command.addTestDescription': 'Add tests based on acceptance criteria',

  'agent.fanout.title': 'Fan-out Subagents',
  'agent.fanout.placeholder': 'Edit the prompt as needed…',
  'agent.fanout.submit': 'Send to current session',
}
