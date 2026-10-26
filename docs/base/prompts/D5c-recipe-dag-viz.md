# D5c: Recipe DAG 可视化与执行进度

## 会话元数据

- **ID**: D5c
- **前置**: D5b 已合并
- **工作分支**: `claude/phase-d5c-recipe-dag-viz`
- **预估工作量**: 5-7 工作日
- **依赖**: D5b

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d5c-recipe-dag-viz`
- 路径：`.claude/worktrees/phase-d5c`

## 上下文

D5a + D5b 实现 DAG 执行能力，但用户看不到 DAG 结构、不知道当前执行到哪一步。D5c 加：
1. DAG 静态可视化（DAG 视图，画布上展示节点关系）
2. 实时执行进度面板（每步状态、耗时、错误）

## 任务清单

### D5c-1：DAG 解析与展示数据

- `src/main/recipes/dag-graph.ts`
- 输入：RecipeDefinition（含 sub_recipes）
- 输出：`DagNode[]` + `DagEdge[]`（节点 = sub_recipe，边 = 依赖关系）
- 算法：基于 `{{ outputs.x.y }}` 引用关系推断边

### D5c-2：DAG 可视化组件

- `src/renderer/panels/RecipeDagView.tsx`
- 用 @xyflow/react（项目已有）画 sub_recipe DAG
- 节点颜色按 status（pending/running/completed/failed）
- 节点可点击查看详情

### D5c-3：执行进度面板

- `src/renderer/panels/RecipeRunProgress.tsx`
- 监听 `subagent:progress` 事件 + RecipeRun.subRuns 状态
- 实时更新 DAG 节点颜色
- 顶部显示总进度（X/Y steps completed）

### D5c-4：集成入口

- RecipesPanel 内 Recipe 详情下方加「DAG 视图」折叠面板
- 跑 Recipe 时右侧弹出进度面板（参考 WritebackPanel 模式）

### D5c-5：测试

- `src/main/recipes/__tests__/dag-graph.test.ts` ≥ 6 个 case
  - 线性 DAG 推断
  - 并行分组推断
  - 循环引用检测
- `src/renderer/panels/__tests__/RecipeRunProgress.test.tsx` ≥ 4 个 case
  - 进度更新
  - 错误显示
  - 折叠/展开

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动 `npm run dev`：
  - 加载 3-step DAG Recipe → DAG 视图正确
  - 跑 Recipe → 进度面板实时更新
  - 中间步骤失败 → DAG 节点变红 + toast 错误

## 关键参考

- `src/renderer/canvas/GraphCanvas.tsx`（@xyflow/react 用法）
- `src/main/agent/subagent-manager.ts`（progress 事件源）
- `src/renderer/components/wiki/WritebackPanel.tsx`（实时面板模式）
- `src/main/recipes/runner.ts`（DAGRunner）

## 完成定义

- [ ] D5c-1 ~ D5c-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D5c 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d5c.md` 跟踪文档