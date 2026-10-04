# D9: A2A 协议接入

## 会话元数据

- **ID**: D9
- **前置**: 基座 v1
- **工作分支**: `claude/phase-d9-a2a-protocol`
- **预估工作量**: 7-10 工作日
- **依赖**: 无

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d9-a2a-protocol`
- 路径：`.claude/worktrees/phase-d9`

## 上下文

A2A（Agent-to-Agent）是 Google 提出的跨进程 Agent 通信协议（2025）。允许 BizGraph 作为 A2A server 暴露自身能力，让外部 Agent 调用；同时作为 A2A client 调用远程 Agent。

D9 接入 A2A，让 BizGraph 不再是单进程孤岛，可纳入更大的多 Agent 系统。

## 任务清单

### D9-1：A2A 类型定义

- `src/shared/types/a2a.ts`
- A2A spec 关键消息：`SendMessage` / `StreamMessage` / `GetTask` / `ListTasks`
- 与基座版 AgentSessionConfig 双向映射

### D9-2：A2A Server 端

- `src/main/a2a/server.ts`
- HTTP + SSE endpoint（基座版无内置 HTTP — 引入 Express 或用 Node 原生 http）
- 消息接收 → 映射到 BizGraph Agent session
- 输出通过 SSE 流式回传

### D9-3：A2A Client 端

- `src/main/a2a/client.ts`
- 远程 A2A agent 配置（settings 增 `a2a.remoteAgents[]`）
- 在 SubagentManager 注册为 `a2a:<name>` 类型

### D9-4：认证与安全

- 远程 A2A agents 配 bearer token / mTLS
- 服务端：可选开启（默认关闭）+ 配 API key
- 路径安全：远程 agent 的 allowedFiles 受 BizGraph scope guard 保护

### D9-5：UI

- SettingsPanel 加「A2A 远程 Agents」tab
- 每个 agent 显示：name / endpoint / 状态（online / unreachable） / 测试连接按钮

### D9-6：测试

- `src/main/a2a/__tests__/server.test.ts` ≥ 8 个 case
- `src/main/a2a/__tests__/client.test.ts` ≥ 6 个 case
- 端到端：本地 server + 远程 client 调用 → 收到响应

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：开 server → 用 client 调 → 收到回执

## 关键参考

- A2A spec：https://github.com/google/A2A
- `src/main/agent/subagent-manager.ts`（派发集成点）
- `src/main/settings.ts`（配置 schema）

## 完成定义

- [ ] D9-1 ~ D9-6 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D9 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d9.md` 跟踪文档