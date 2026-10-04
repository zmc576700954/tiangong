# D5b: Recipe DAG Parallel + Delegate Tool · 任务跟踪

> 创建：2026-10-01
> 范围：Phase D5b — Recipe DAG 并行分组 + delegate_recipe 工具
> 计划来源：[D5b Prompt](../../../bizgraph-improvement-plan-c1ff78/docs/base/prompts/D5b-recipe-dag-delegate.md)
> 前置：D5a 已合并（commit `a831777`）

## 当前状态

**实施完成 + 测试通过** — D5b-1 ~ D5b-5 全部落地。`npx tsc --noEmit` 零错误，`npm run lint` 零警告，D5b 新增测试 24 个全绿（dag-parallel: 10 / dag-delegate: 14）。原有 Phase C 74 个 + Phase D5b 24 个 = 98 个相关测试全绿。修改跨 7 个文件，净增 ~750 行（含测试 + 文档）。

## 目标

D5a 实现串行 DAG。D5b 扩展：
1. **并行执行**：sub_recipe 支持 `parallel: true` 分组
2. **delegate tool**：Recipe 运行时可调用另一个 Recipe 作为工具（无需预定义 DAG）

## 任务清单

- [x] D5b-1：sub_recipe 并行分组
  - `src/shared/types/recipe.ts`：`RecipeAgentStep.parallel` 已在 D5a 落地，D5b 真正使用
  - `src/main/recipes/recipe-runner.ts`：导出 `computeWaves(steps)` 和 `batchWave(indices, steps)`
    - `computeWaves` 用 Kahn 风格 BFS 分层；环检测 → `BizGraphError(RECIPE_INVALID_STEP)`
    - `batchWave` 在 wave 内把连续 `parallel=true` 步合并为一个并行批
  - `executeBatch` 用 `Promise.allSettled` 确保所有并发步都有机会完成并写入 step 记录
  - 「同批中一个失败 → 整批失败」语义：collect 首个 rejection 抛出
- [x] D5b-2：delegate Recipe 工具
  - `src/shared/types/recipe.ts`：`RecipeDefinition.allowed_delegates?: string[]`
  - `src/main/recipes/yaml-loader.ts`：校验 kebab-case + 自引用守卫（recipe 不能 delegate 给自身）
  - `src/main/adapters/base.ts`：`DELEGATE_RECIPE_TOOL_NAME` + `buildDelegateRecipeToolSchema(allowedDelegates)` 工厂
- [x] D5b-3：与 SubagentManager 集成
  - `src/shared/types/subagent.ts`：`SubagentInvokeArgs` 加 `inputs?` + `allowedDelegates?`
  - `src/main/agent/subagent-manager.ts`：
    - `mergeRecipeInputs(args)` 把显式 `inputs` 与 `prompt` 合并（向后兼容：缺省时 fallback 到 `{prompt}`)
    - `_runInvocation` 把 `args.allowedDelegates` 写入 child session config
- [x] D5b-4：scope guard 复用
  - `src/shared/types/agent.ts`：`AgentSessionConfig.allowedDelegates?`
  - `src/main/adapters/base.ts runToolAwareLoop`：检测 `delegate_recipe` 工具调用
    - 校验 `session.config.allowedDelegates` 包含 `recipe_id` → 否则返回错误文本
    - 路由 `subagentManager.invoke({ agentType: 'recipe:<id>', inputs, allowedDelegates: undefined })`
    - **delegate 不向下传递 allowedDelegates**：避免 delegate→delegate 链任意扩张
  - `src/main/adapters/mcp-adapter.ts`：在 tools 数组里同样 prepend `delegate_recipe` schema
- [x] D5b-5：测试
  - `src/main/recipes/__tests__/dag-parallel.test.ts`（10 cases）
    - computeWaves: 单 wave / 多层 / 环检测
    - batchWave: parallel 合并 / 串行分裂 / 混合顺序
    - RecipeRunner.run: 两步并行 / 并行中一失败 → 批失败 / 跨 wave 顺序 / 混合 wave 顺序
  - `src/main/recipes/__tests__/dag-delegate.test.ts`（14 cases）
    - YAML 解析: 合法 / 缺省 / 非数组 / 非 kebab-case / 自引用拒绝
    - `buildDelegateRecipeToolSchema` 工厂: 空数组 → null / 正常注入 enum
    - RecipeRunner 透传 `allowedDelegates` 到 SubagentManager
    - SubagentManager.invoke 透传 `inputs` 到 RecipeRunner
    - BaseAdapter inline tool prompt 包含 / 不包含 delegate_recipe
    - delegate_recipe 路由: 合法调用 / 未授权 id 拒绝

## 验证门槛

- [x] `npx tsc --noEmit` 零错误
- [x] `npm run lint` 零警告
- [x] 新增测试 24 个全绿（dag-parallel 10 + dag-delegate 14）
- [x] 全量 `npm run test` 通过 Phase C + D5b 相关文件（其它失败属于 pre-existing，详见 PHASE_D_TASKS.md）
- [ ] 手动验证：写一个 3-step DAG（1 串行 + 2 并行），跑通（UI 验证依赖 main 合并后回归）

## 关键决策

- **DAG 拓扑 vs 数组顺序**：D5a 「数组顺序 + depends_on 仅校验」；D5b 升级为真 DAG：用 `computeWaves` 把依赖分层后再按 wave 内数组顺序执行。DAG 环检测抛 `RECIPE_INVALID_STEP`。
- **批内并发 vs 整批并发**：「同批中一个失败 → 整批失败」用 `Promise.allSettled` 而非 `Promise.all`：前者保证所有 sibling 都有机会标记自己的 step 记录为 failed/succeeded，再 collect 首个 rejection 抛出。这样下游审计/UI 看到的 step 记录是一致的（不会出现某步卡在 running）。
- **delegate_recipe 工具 vs dispatch_subagent**：保持两条独立的工具入口，enum 不同：
  - `dispatch_subagent` 仍保留 generic dispatch（kebab-case `recipe:<id>` regex），用于 LLM 自由调度
  - `delegate_recipe` 是 sibling recipe 专用，enum 来自 `allowed_delegates`，更严格的静态约束
- **delegate 不递归传递 allowedDelegates**：避免 delegate → delegate → ... 链任意扩张 recipe 嵌套图（D5c 评估是否提供 per-step override）
- **allowed_delegates 自引用守卫**：yaml-loader 解析时拒绝 recipe `allowed_delegates` 包含自身 id（直接递归即环）

## 边界（与 CLAUDE.md Boundaries 一致）

- **不污染 LLM prompt 之外的入口**：delegate_recipe 仅在 session 显式声明 `allowedDelegates` 时被注入。session config 是注入点，LLM 看到的 tool 列表才变；SubagentManager / RecipeRunner 不感知 tool schema 变化。
- **写文件仍受 SubagentManager 串行化**：delegate 调用的 `recipe:<id>` 子步骤走 SubagentManager 既有 invoke 路径，写冲突仍由 `activeInvocations` 的 gate 兜底（D5b-4 复用）。未引入新的执行通道。
- **不归一多 Recipe 协议**：YAML 格式仍由 `yaml-loader.ts` 单一解析；delegate 路径不引入新的协议层。

## 修改的文件

| 文件 | 改动 |
|------|------|
| `src/shared/types/recipe.ts` | `RecipeDefinition.allowed_delegates?: string[]` |
| `src/shared/types/subagent.ts` | `SubagentInvokeArgs.inputs?` + `allowedDelegates?` |
| `src/shared/types/agent.ts` | `AgentSessionConfig.allowedDelegates?` |
| `src/main/recipes/yaml-loader.ts` | `validateAllowedDelegates` + 自引用守卫 + `stringifyRecipe` 序列化 |
| `src/main/recipes/recipe-runner.ts` | `computeWaves` + `batchWave` + DAG 执行 + inputs/allowedDelegates 透传 |
| `src/main/agent/subagent-manager.ts` | `mergeRecipeInputs` + `allowedDelegates` 写入 child config |
| `src/main/adapters/base.ts` | `DELEGATE_RECIPE_TOOL_NAME` + 工厂 + inline tool prompt + 路由 |
| `src/main/adapters/mcp-adapter.ts` | `delegate_recipe` 注入 tools 数组 |
| `src/main/recipes/__tests__/dag-parallel.test.ts` | 新增 10 cases |
| `src/main/recipes/__tests__/dag-delegate.test.ts` | 新增 14 cases |

## 审查结论记录

- `executeBatch` 最初用 `Promise.all` 导致 fail-fast：失败时只有一个 sibling 的 step 记录被标记为 failed，其它可能仍在 running。修复：`Promise.allSettled` + collect 首个 rejection，UI 看到的 step 记录始终一致。
- `RecipeRunner.runAgentStep` 透传 `inputs` 时最初误用 type cast；改为显式构造 `Parameters<typeof deps.subagentManager.invoke>[0]`，让 TS 检查完整字段。
- yaml-loader `allowed_delegates` 校验最初只校验 kebab-case，漏掉自引用检查。补：解析时抛 `BizGraphError(RECIPE_INVALID_STEP)`。
- dag-delegate.test.ts 中第三个测试最初用 Proxy 包装 SubagentManager 反向引用，过度设计。简化：直接持有 `captured` 引用 + `onProgress` 监听。

## 后续跟进（不阻塞合并）

- **D5c**：Recipe DAG 可视化（画布节点展示 step 关系）；`on_failure` 策略（retry / skip / continue）；并行度限制
- **delegate 链路复用**：当前 delegate 不向下传 `allowedDelegates`；D5c 评估是否让 delegate 自动继承父 recipe 的 delegate 白名单（受限于环检测）
- **RecipesPanel UI 适配**：allowed_delegates 字段需要在 UI 上可视化（多选）+ 错误反馈（未授权 id 时工具返回的 error 文本应被解析成结构化错误）。当前 Phase C 的 RecipesPanel 只展示基础字段
- **delegate 工具结果格式**：当前 inline tool loop 把 `resultText` 塞回 history；delegate_recipe 返回的是 recipe steps 的格式化文本（见 `formatRecipeResult`）。D5c 评估是否需要把 steps 结构化展开

## 会话恢复指南

**如果会话中断，从这里继续：**

1. 读本文件了解 D5b 现状
2. 读 `src/main/recipes/recipe-runner.ts` 看 `computeWaves` / `batchWave` / DAG 执行
3. 读 `src/main/adapters/base.ts` 看 `DELEGATE_RECIPE_TOOL_NAME` + 路由
4. 跑 `npx vitest run src/main/recipes/__tests__/dag-parallel src/main/recipes/__tests__/dag-delegate` 验证

## 已知注意事项

- `allowed_delegates` 静态校验仅拒绝 recipe 自引用；嵌套环（recipe A → recipe B → recipe A）由运行期 `getOrThrow` 失败暴露（recipe B 找不到自身 delegate A 时不暴露，因为 A 是 B 的输入）。完整环检测在 D5c 实施
- Phase D5b 改动跨 7 个文件（types / runner / subagent-manager / adapters / yaml-loader / 2 个测试），建议单 commit 而非按子任务拆分
- `RecipeRunner.runAgentStep` 在 `agentType=recipe:<id>` 时才透传 `inputs`；其它路径忽略此字段（保留向后兼容）
