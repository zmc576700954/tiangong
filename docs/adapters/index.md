# Agent 适配器

BizGraph 通过适配器模式连接各种 Agent CLI 工具。当前支持：

| 适配器 | 状态 | 安装命令 |
|--------|------|----------|
| Claude Code | ✅ 已实现 | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | ✅ 已实现 | `npm install -g @openai/codex` |
| OpenCode | ✅ 已实现 | `npm install -g opencode` |

## 适配器工作原理

1. **检测安装**: 通过执行 `--version` 命令检测 Agent 是否已安装
2. **启动会话**: 以非交互模式启动 Agent 子进程，注入范围上下文
3. **发送指令**: 通过 stdin 向 Agent 发送自然语言指令
4. **捕获输出**: 通过 stdout/stderr 捕获 Agent 的输出和文件变更
5. **范围守卫**: 监控文件系统，越界写入自动拦截回滚

## 范围上下文

BizGraph 向每个 Agent 注入的结构化上下文包括：

- **白名单**: 允许修改的文件列表
- **黑名单**: 禁止修改的文件列表
- **业务不变量**: 必须遵守的业务规则
- **上下游契约**: 与相邻节点的接口约定
- **验收标准**: 完成的标准
- **Bug 上下文**: 待修复的 Bug 详情（仅修复模式）

## 添加新适配器

请参阅 [Agent 适配器开发指南](../../src/main/adapters/README.md)。
