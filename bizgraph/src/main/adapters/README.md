# Agent 适配器开发指南

BizGraph 的核心扩展点就是 **Agent 适配器**。通过实现适配器接口，你可以将任何遵循 CLI 交互模式的 Agent 工具接入 BizGraph。

## 快速开始

为新的 Agent CLI 添加适配器只需 3 步：

### 1. 继承 BaseAdapter

```typescript
import { BaseAdapter } from './base'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'

export class MyAgentAdapter extends BaseAdapter {
  readonly name = 'my-agent'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    // 检测用户系统是否安装了该 Agent
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    // 启动 Agent 进程，注入范围上下文
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    // 向 Agent 进程发送指令
  }

  protected async doTerminate(session: AgentSession): Promise<void> {
    // 终止 Agent 进程
  }
}
```

### 2. 注册适配器

在 `src/main/ipc-handlers.ts` 的 `AgentManager` 中注册：

```typescript
import { MyAgentAdapter } from './adapters/my-agent'

// 在构造函数中添加
this.adapters.set('my-agent', new MyAgentAdapter())
```

### 3. 添加安装说明

在 README.md 中添加该 Agent 的安装命令：

```bash
npm install -g my-agent
```

## 核心方法说明

### checkInstalled()

检测用户系统是否已安装该 Agent CLI。建议通过执行 `--version` 命令来检测：

```typescript
async checkInstalled(): Promise<boolean> {
  try {
    await execAsync('my-agent --version')
    return true
  } catch {
    return false
  }
}
```

### startSession(config)

启动 Agent 进程并返回 `AgentSession` 对象：

```typescript
async startSession(config: AgentSessionConfig): Promise<AgentSession> {
  const sessionId = generateId()

  const proc = spawn('my-agent', args, {
    cwd: config.workingDirectory,
    env: { ...process.env, BIZGRAPH_CONTEXT: JSON.stringify(config) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const session: AgentSession = {
    id: sessionId,
    process: proc,
    adapterName: this.name,
    config,
    startTime: Date.now(),
  }

  this.registerSession(session)
  this.attachOutputHandlers(session)

  return session
}
```

**重要提示**：
- 使用 `this.buildScopePrompt(config)` 生成范围约束提示词
- 使用 `this.registerSession(session)` 注册会话
- 通过环境变量 `BIZGRAPH_CONTEXT` 向 Agent 传递结构化上下文

### doSendCommand(session, command)

向 Agent 的标准输入写入指令：

```typescript
protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
  session.process.stdin?.write(command.description + '\n')
}
```

### doTerminate(session)

优雅终止 Agent 进程（先 SIGTERM，超时后 SIGKILL）：

```typescript
protected async doTerminate(session: AgentSession): Promise<void> {
  const proc = session.process
  if (!proc.killed) {
    proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
        resolve()
      }, 5000)
      proc.on('exit', () => resolve())
    })
  }
}
```

## 输出解析

BaseAdapter 提供了 `emitOutput()` 方法用于向渲染进程发送输出。你需要在 `attachOutputHandlers` 中解析 Agent 的输出：

```typescript
private attachOutputHandlers(session: AgentSession): void {
  session.process.stdout?.on('data', (data: Buffer) => {
    const text = data.toString('utf-8')
    this.emitOutput({ type: 'stdout', data: text, timestamp: Date.now() })
    this.parseFileChanges(text) // 解析文件变更
  })
}
```

## 范围上下文

`AgentSessionConfig` 包含了 BizGraph 注入的所有约束信息：

| 字段 | 说明 |
|------|------|
| `workingDirectory` | 项目根目录 |
| `allowedFiles` | 白名单文件列表 |
| `forbiddenFiles` | 黑名单文件列表 |
| `invariantRules` | 业务不变量规则 |
| `upstreamContext` | 上游节点契约 |
| `downstreamContext` | 下游节点契约 |
| `nodeTitle` | 当前业务节点名称 |
| `acceptanceCriteria` | 验收标准 |
| `bugContext` | 待修复 Bug 列表（仅修复模式） |

使用 `this.buildScopePrompt(config)` 可以将这些约束转换为自然语言提示词。

## 提交 PR

完成适配器开发后：

1. 确保适配器遵循现有代码风格
2. 添加适配器的 README 说明
3. 更新根目录 README.md 的支持列表
4. 提交 PR，标题格式：`feat(adapter): add XXX adapter`
