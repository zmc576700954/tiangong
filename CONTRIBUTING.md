# Contributing to BizGraph

> 最后更新：2026-06-29

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
5. 创建 Pull Request 到 `main` 或 `develop`

### 代码规范

- 使用 TypeScript，严格模式开启
- 遵循现有的代码风格（参考 `.eslintrc` / `eslint.config`）
- 为新功能编写测试（单元测试或 E2E 测试）
- 确保 `npm run lint` 通过（max 0 warnings）
- 确保 `npx tsc --noEmit` 通过
- 不要创建带版本后缀的文档副本（如 `README-v2.md`）；直接原地更新

## 核心扩展点：添加 Agent 适配器

BizGraph 最重要的扩展点是 **Agent 适配器**。通过添加适配器，你可以让 BizGraph 支持新的 Agent CLI 工具。

### 快速指南

1. 在 `src/main/adapters/` 目录下创建新的适配器文件
2. 继承 `BaseAdapter` 类，实现 4 个核心方法
3. 在 `src/main/adapters/registry.ts` 的 `ADAPTER_REGISTRY` 中添加描述符
4. 同步更新 `src/main/settings.ts` 中的 `KNOWN_ADAPTER_NAMES`

详细文档请参阅：[Agent 适配器开发指南](src/main/adapters/README.md)

### 示例：为新的 Agent CLI 添加适配器

```typescript
import { BaseAdapter } from './base'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'

export class MyAgentAdapter extends BaseAdapter {
  readonly name = 'my-agent'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    // 检测是否安装
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    // 启动 Agent 进程
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    // 发送指令
  }

  protected async doTerminate(session: AgentSession): Promise<void> {
    // 终止进程
  }
}
```

### 注册到适配器市场

```typescript
// src/main/adapters/registry.ts
{
  name: 'my-agent',
  displayName: 'My Agent',
  description: '描述该 Agent 的能力',
  type: 'cli',
  detectCommand: 'my-agent',
  detectArgs: ['--version'],
  installMethods: [
    { type: 'npm', command: 'npm i -g my-agent', label: 'npm' },
  ],
  adapterClass: MyAgentAdapter,
  homepage: 'https://github.com/example/my-agent',
  capabilities: [AdapterCapability.Streaming, AdapterCapability.FileOps],
  fallbackTo: 'mcp',
  contextWindow: 128_000,
  defaultCompactStrategy: 'summary',
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
├── main/                    # Electron 主进程
│   ├── adapters/            # ⭐ Agent 适配器（核心扩展点）
│   ├── agent/               # AgentManager / SessionRouter / SubagentManager
│   ├── code-intelligence/   # AST 符号索引与智能上下文
│   ├── memory/              # 跨会话记忆管线
│   ├── ipc/                 # IPC 处理器（按领域拆分）
│   ├── ipc-handlers.ts      # IPC 处理器总装入口
│   ├── project-scanner/     # 项目扫描生成初始导图
│   ├── repositories/        # 数据访问层
│   ├── services/            # 业务逻辑层
│   ├── database.ts          # better-sqlite3 数据库与迁移
│   ├── settings.ts          # 配置与 API Key 管理
│   └── index.ts             # 主进程入口
├── preload/                 # contextBridge IPC 桥接
├── renderer/                # Electron 渲染进程（React）
│   ├── canvas/              # 思维导图画布组件
│   ├── components/          # UI 组件（agent / ui）
│   ├── panels/              # 左/右侧面板
│   ├── store/               # Zustand 状态管理
│   └── hooks/               # 自定义 React hooks
└── shared/                  # 共享类型与工具
    ├── types/               # 按领域拆分的类型定义
    ├── state-machine.ts     # 节点/Bug 状态机
    └── type-guards.ts       # 类型守卫
```

## 数据库迁移

修改 `src/main/database.ts` 中的表结构时：

1. 在 `TABLE_SCHEMAS` 中更新对应表的 `createSql` 和 `requiredColumns`
2. 在 `INDEX_SQLS` 中添加/更新索引（幂等，可重复执行）
3. 对仅新增列的变更，使用 `runIncrementalMigrations()` 中的 `addColumnSafe()`
4. 对破坏性变更，递增 `CURRENT_SCHEMA_VERSION`，`migrate()` 会自动重建表并恢复数据
5. 在 `restoreFromBackup()` 中处理枚举值迁移（如 `production → online`）

## 测试

- 单元测试：`npm run test`
- 单文件：`npx vitest run src/main/__tests__/xxx.test.ts`
- E2E 浏览器测试：`npm run test:e2e`
- E2E Electron 测试：`npm run test:e2e:electron`

## 沟通渠道

- GitHub Issues：Bug 报告、功能请求
- GitHub Discussions：一般性讨论、使用问题
- Pull Requests：代码贡献

## 行为准则

请保持友善和尊重。我们致力于打造一个开放、包容的社区。
