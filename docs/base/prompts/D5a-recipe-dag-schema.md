# D5a: Recipe DAG Schema 与序列执行

## 会话元数据

- **ID**: D5a
- **前置**: 基座 v1（Phase C Recipe 系统已交付）
- **工作分支**: `claude/phase-d5a-recipe-dag-schema`
- **预估工作量**: 5-7 工作日
- **依赖**: 无
- **后续**: D5b（delegate tool）、D5c（可视化）依赖本任务

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d5a-recipe-dag-schema`
- 路径：`.claude/worktrees/phase-d5a`

## 上下文

基座版 Recipe 是单步顺序：`prompt` + `instructions` 直接派发到 SubagentManager。
D5a 引入 Block Goose 的 `sub_recipes` 概念 — Recipe 可以引用其他 Recipe，按顺序串行执行。

参考 Goose Recipe spec：https://block.github.io/goose/docs/tutorials/recipes/sub-recipes

## 任务清单

### D5a-1：扩展 RecipeDefinition schema

```typescript
interface RecipeDefinition {
  // ... existing fields
  sub_recipes?: SubRecipe[]   // 序列执行
  response?: {
    success_condition?: string  // LLM 判断表达式（基座版只支持 string equality）
    failure_condition?: string
  }
}

interface SubRecipe {
  name: string                // 局部名，输出参数前缀
  recipe: string              // 引用另一个 Recipe（id 或 title slug）
  inputs?: Record<string, unknown>
  // 阶段 2（D5b）再加 parallel / on_failure
}
```

### D5a-2：Zod schema 扩展

- `src/main/recipes/yaml-loader.ts` 的 `RecipeDefinitionSchema` 加 sub_recipes 字段
- 错误信息清晰（哪个 sub_recipe、哪个 input 错）

### D5a-3：RecipeRunner 支持 DAG 执行

- `src/main/recipes/runner.ts` 加 `runDAG(args, options)` 方法
- 算法：拓扑排序（基座版只支持无环串行）→ 顺序执行每个 sub_recipe
- 每个 sub_recipe 的输出存入 `dagOutputs: Record<string, unknown>`，供后续 sub_recipe 引用 `{{ outputs.<name>.field }}`

### D5a-4：保留向后兼容

- 没有 sub_recipes 的 Recipe 走原 `run()` 路径（不破坏基座测试）
- `RecipeRun` 加新字段（可选）：
  ```typescript
  interface RecipeRun {
    // ... existing
    subRuns?: RecipeRun[]  // 当 runDAG 时填充
  }
  ```

### D5a-5：测试

- `src/main/recipes/__tests__/dag-schema.test.ts` ≥ 8 个 case
  - 合法 2-step DAG
  - 引用不存在的 sub_recipe
  - 循环引用检测
  - 拓扑排序正确性
- `src/main/recipes/__tests__/dag-runner.test.ts` ≥ 6 个 case
  - 顺序执行
  - 前置输出作为后续输入
  - 中间步骤失败 → 整个 DAG 失败

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿（基座版 Recipe 测试零回归）
- [ ] `npm run lint` 零警告
- [ ] 手动验证：写一个 2-step YAML，跑通

## 关键参考

- `src/shared/types/recipe.ts`（扩展点）
- `src/main/recipes/yaml-loader.ts`（Zod schema）
- `src/main/recipes/runner.ts`（run 方法）
- `src/main/recipes/template.ts`（`{{ outputs.x.y }}` 渲染）
- Block Goose docs：https://block.github.io/goose/docs/tutorials/recipes/sub-recipes

## 完成定义

- [ ] D5a-1 ~ D5a-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D5a 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d5a.md` 跟踪文档