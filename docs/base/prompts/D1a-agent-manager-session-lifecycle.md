# D1a: AgentManager 会话生命周期拆解

## 会话元数据

- **ID**: D1a
- **前置**: 基座 v1（Phase A/B/C）已合并
- **工作分支**: `claude/phase-d1a-session-lifecycle`
- **预估工作量**: 5-7 工作日
- **依赖**: 无（Phase D 阶段 1 第一个任务）
- **会阻塞**: 所有 Phase D 后续任务（推荐先做）

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d1a-session-lifecycle`
- 路径：`.claude/worktrees/phase-d1a`

## 上下文

`src/main/agent/agent-manager.ts` 当前是 god file（2400+ 行），包含：
- 会话启动 / 终止 / 状态管理
- 适配器健康度评分 + 路由
- 回退链（fallback chain）
- 会话恢复（recovery）
- Compact History 持久化
- SubagentManager 注入
- Code Intelligence 注入
- ChatRepo 注入

D1a 把"会话生命周期管理"独立出来，D1b 把"回退/恢复"独立出来，后续任务从这两个 manager 取接口。

## 任务清单

### D1a-1：抽取 `SessionLifecycleManager`

- 新文件 `src/main/agent/session-lifecycle-manager.ts`
- 公开 API：
  ```typescript
  class SessionLifecycleManager {
    start(adapterName, config): Promise<{ sessionId, ... }>
    terminate(sessionId): Promise<void>
    terminateAll(): Promise<void>
    getSessionState(sessionId): SessionState | undefined
    listActive(): string[]
    onStateChange(cb): unsubscribe
  }
  ```
- 内部持有 SessionRouter / OutputBroadcaster 的引用

### D1a-2：抽取 `SessionState` 类型

- 从 `agent-manager.ts` 内联类型移到 `src/main/agent/types.ts`
- 公共导出供 SubagentManager / RecipeRunner 复用

### D1a-3：缩减 AgentManager

- `agent-manager.ts` 留下：构造 + 依赖注入 + 顶层 facade（start/terminate/sendCommand）
- 委托给 SessionLifecycleManager
- 目标：行数 < 1000

### D1a-4：保持 IPC 兼容

- `agent:startSession` / `agent:terminateSession` / `agent:closeAllSessions` / `agent:getSessionState` 必须保持现状
- 现有 1953 测试零回归（除基座已知的 Windows 路径兼容问题）

### D1a-5：新增测试

- `src/main/agent/__tests__/session-lifecycle-manager.test.ts` 至少 15 个 case
- 覆盖：start/terminate/getState/listActive/onStateChange 全部路径

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run src/main/agent` 全绿（不含已知 Windows 路径 fail）
- [ ] `npm run lint` 零警告
- [ ] 手动 `npm run dev`：启动一个会话 → 终止 → 重新启动，无异常
- [ ] `git diff --stat src/main/agent/agent-manager.ts` 行数减少 ≥ 800

## 关键参考

- `src/main/agent/agent-manager.ts`（现 god file，2475+ 行）
- `src/main/agent/subagent-manager.ts`（参考抽取风格）
- `src/main/agent/session-router.ts`（依赖）
- `src/main/agent/output-broadcaster.ts`（依赖）
- 基座 task 跟踪：`docs/tasks/2026-09-30-base-foundation.md`

## 完成定义

- [ ] D1a-1 ~ D1a-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D1a 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d1a.md` 跟踪文档