# D5b: Recipe DAG Parallel + Delegate Tool

## 会话元数据

- **ID**: D5b
- **前置**: D5a 已合并
- **工作分支**: `claude/phase-d5b-recipe-dag-delegate`
- **预估工作量**: 7-10 工作日
- **依赖**: D5a

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d5b-recipe-dag-delegate`
- 路径：`.claude/worktrees/phase-d5b`

## 上下文

D5a 实现串行 DAG。D5b 扩展：
1. **并行执行**：sub_recipe 支持 `parallel: true` 分组
2. **delegate tool**：Recipe 运行时可调用另一个 Recipe 作为工具（无需预定义 DAG）

参考 Goose 的 `sub_recipe` parallel 与 `delegate_to` tool。

## 任务清单

### D5b-1：sub_recipe 并行分组

```typescript
interface SubRecipe {
  name: string
  recipe: string
  inputs?: Record<string, unknown>
  parallel?: boolean       // 同组并行（基于「上一次串行节点」分批）
}
```

实现：
- DAGRunner 按 `parallel` flag 分批
- 同批并行派发到 SubagentManager
- 错误处理：同批中一个失败 → 整个批失败（D5c 再加 on_failure 策略）

### D5b-2：delegate Recipe 工具

- Recipe 内声明可用 delegate 目标：
  ```yaml
  allowed_delegates: ["refactor-react-component", "add-tests"]
  ```
- 运行时注入 delegate_recipe 工具给子代理
- 工具签名（参考 dispatch_subagent）：
  ```typescript
  {
    name: 'delegate_recipe',
    description: '...',
    input_schema: {
      recipe_id: { type: 'string', enum: [...] },
      inputs: { type: 'object' },
    }
  }
  ```

### D5b-3：与 SubagentManager 集成

- delegate 调用复用 `SubagentManager.invoke(agentType='recipe:<id>')`
- 无需新建派发通道（基座版 design 是统一入口）
- 进度通过 `subagent:progress` 事件透传

### D5b-4：scope guard 复用

- delegate 写文件同样受 Recipe 的 `scopeStrategy` 约束
- 写冲突串行化沿用 SubagentManager 的 gate

### D5b-5：测试

- `src/main/recipes/__tests__/dag-parallel.test.ts` ≥ 5 个 case
  - 两步并行
  - 并行中一个失败 → 批失败
- `src/main/recipes/__tests__/dag-delegate.test.ts` ≥ 5 个 case
  - delegate 工具注册
  - 运行时调用 delegate_recipe
  - delegate 输入校验

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动验证：写一个 3-step DAG（1 串行 + 2 并行），跑通

## 关键参考

- `src/main/agent/subagent-manager.ts`（派发接口）
- `src/main/recipes/runner.ts`（D5a 后的 DAGRunner）
- `src/main/adapters/base.ts:1280`（`buildDispatchSubagentToolSchema` 工厂 → 同样的 dynamic enum 注入 delegate_recipe）
- Block Goose docs：sub_recipes parallel + subagents tool

## 完成定义

- [ ] D5b-1 ~ D5b-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D5b 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d5b.md` 跟踪文档