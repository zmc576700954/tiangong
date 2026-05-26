# Contributing to BizGraph

感谢你对 BizGraph 的兴趣！我们欢迎各种形式的贡献。

## 如何贡献

### 报告 Bug

1. 搜索现有 Issues，确认该问题尚未被报告
2. 创建新 Issue，使用 Bug 报告模板
3. 提供详细的复现步骤、环境信息和截图

### 提交代码

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feat/your-feature`
3. 提交代码：`git commit -m "feat: add new feature"`
4. 推送到你的 Fork：`git push origin feat/your-feature`
5. 创建 Pull Request

### 代码规范

- 使用 TypeScript，严格模式开启
- 遵循现有的代码风格
- 为新功能编写测试
- 确保 `npm run lint` 通过

## 核心扩展点：添加 Agent 适配器

BizGraph 最重要的扩展点是 **Agent 适配器**。通过添加适配器，你可以让 BizGraph 支持新的 Agent CLI 工具。

### 快速指南

1. 在 `src/main/adapters/` 目录下创建新的适配器文件
2. 继承 `BaseAdapter` 类，实现 4 个核心方法
3. 在 `src/main/ipc-handlers.ts` 中注册适配器

详细文档请参阅：[Agent 适配器开发指南](src/main/adapters/README.md)

### 示例：为新的 Agent CLI 添加适配器（约 50 行代码）

```typescript
import { BaseAdapter } from './base'
import type { AgentSession, AgentSessionConfig } from '@shared/types'

export class MyAgentAdapter extends BaseAdapter {
  name = 'my-agent'
  version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    // 检测是否安装
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    // 启动 Agent 进程
  }

  protected async doSendCommand(session, command): Promise<void> {
    // 发送指令
  }

  protected async doTerminate(session): Promise<void> {
    // 终止进程
  }
}
```

## 开发环境搭建

```bash
# 克隆仓库
git clone https://github.com/yourusername/bizgraph.git
cd bizgraph

# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建
npm run build
```

## 项目结构

```
src/
├── main/           # Electron 主进程
│   ├── adapters/   # ⭐ Agent 适配器（核心扩展点）
│   ├── database.ts # LibSQL 数据库
│   └── ...
├── renderer/       # Electron 渲染进程（React）
│   ├── canvas/     # 思维导图画布
│   ├── panels/     # 左/右侧面板
│   └── store/      # Zustand 状态管理
└── shared/         # 共享类型定义
```

## 沟通渠道

- GitHub Issues：Bug 报告、功能请求
- GitHub Discussions：一般性讨论、使用问题
- Pull Requests：代码贡献

## 行为准则

请保持友善和尊重。我们致力于打造一个开放、包容的社区。
