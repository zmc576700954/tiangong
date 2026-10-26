# D1b: AgentManager 回退 / 恢复拆解

## 会话元数据

- **ID**: D1b
- **前置**: D1a 已合并
- **工作分支**: `claude/phase-d1b-fallback-recovery`
- **预估工作量**: 5-7 工作日
- **依赖**: D1a

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d1b-fallback-recovery`
- 路径：`.claude/worktrees/phase-d1b`

## 上下文

D1a 拆出 SessionLifecycleManager 后，agent-manager.ts 仍有大量代码处理：
- AdapterHealthMonitor 集成
- 回退链（fallback chain）解析
- 会话恢复（SessionRecoveryManager）

D1b 把它们抽到独立模块，让 agent-manager.ts 只剩 facade。

## 任务清单

### D1b-1：抽取 `FallbackRouter`

- 新文件 `src/main/agent/fallback-router.ts`
- 职责：给定 primary adapter name + adapterRegistry，返回最终选中的 adapter name（健康度优先）
- 公开 API：
  ```typescript
  class FallbackRouter {
    resolve(primary: string, descriptors: AdapterDescriptor[], allowMcpFallback: boolean): string
    recordCall(adapterName: string, success: boolean, ...): void  // 委托给 AdapterHealthMonitor
  }
  ```

### D1b-2：抽取 `RecoveryOrchestrator`

- 新文件 `src/main/agent/recovery-orchestrator.ts`
- 职责：封装 SessionRecoveryManager 的调用、retry budget 跟踪、circuit breaker
- 公开 API：
  ```typescript
  class RecoveryOrchestrator {
    handleSessionExit(sessionId, exitInfo): Promise<RecoveryDecision>
    shouldRecover(adapterName): boolean
    recordRecoveryOutcome(adapterName, success): void
  }
  ```

### D1b-3：缩减 AgentManager

- 调用方改为：`fallbackRouter.resolve(...)` + `recoveryOrchestrator.handleSessionExit(...)`
- agent-manager.ts 目标：行数 < 500

### D1b-4：保持行为

- 17 个 `src/main/__tests__/agent-manager.test.ts` 的 session/recovery 相关测试零修改通过
- 单独跑 `agent-manager.test.ts`：除已知 Windows 路径 fail 外，全部通过

### D1b-5：新增测试

- `src/main/agent/__tests__/fallback-router.test.ts` ≥ 12 个 case
- `src/main/agent/__tests__/recovery-orchestrator.test.ts` ≥ 10 个 case

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run src/main/agent` 全绿
- [ ] `npm run lint` 零警告
- [ ] `git diff --stat src/main/agent/agent-manager.ts` 累计（与 D1a 一起）行数减少 ≥ 1500
- [ ] 手动验证：杀掉 claude-code 进程 → AgentManager 触发 recovery → 子任务继续

## 关键参考

- `src/main/agent/agent-manager.ts`（D1a 后的状态）
- `src/main/agent/session-recovery-manager.ts`（现文件）
- `src/main/agent/adapter-health-monitor.ts`（依赖）
- `src/main/adapters/registry.ts`（AdapterDescriptor 定义）
- `src/main/__tests__/agent-manager.test.ts`（行为回归基线）

## 完成定义

- [ ] D1b-1 ~ D1b-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D1b 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d1b.md` 跟踪文档