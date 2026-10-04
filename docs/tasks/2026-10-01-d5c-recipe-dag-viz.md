# D5c: Recipe DAG 可视化与执行进度 — 实施记录

## 元数据

- **日期**: 2026-10-01
- **分支**: `claude/d5c-recipe-dag-viz-ad92ce`
- **前置**: D5b 已合并（Recipe 基础 + RecipeRunner）

## 实施范围

### 1. DAG 静态可视化（D5c-1 + D5c-2）

- 新增 `src/shared/recipe-dag.ts`：纯函数 `buildRecipeDag(def)` 把 `RecipeDefinition.steps` 转成 `RecipeDag`，含节点 / 边 / 拓扑层级 / 循环检测 / 缺失依赖。
  - 边来源：`depends_on` 显式声明 → `${outputs.X.Y}` 模板引用（单花括号 + 双花括号 Mustache）→ 数组顺序兜底。
  - 拓扑排序用 Kahn 算法；同一 level 内的节点视为可并行。
  - 配套辅助函数：`dagToFlowNodes` / `dagToFlowEdges` 把 DAG 映射为 @xyflow/react 节点 / 边（含位置布局）。
- IPC：`recipes:dag`（已在 `IpcApi` + preload 注册）。
- UI：`src/renderer/panels/RecipeDagView.tsx` —— 用 @xyflow/react 画 DAG，节点颜色按 `RecipeDagNodeStatus` 着色（pending / running / completed / failed / cancelled / skipped）。
  - 选中节点展示步骤详情（agent prompt / shell command）。
  - 顶部统计条 + 循环 / 缺失依赖 warning。
  - 接收 `liveStatus` prop，外部（RecipeRunProgress）推送实时状态。

> 注：dag-graph 文件位置
>
> 任务规范建议放在 `src/main/recipes/dag-graph.ts`。但实现需要 renderer 直接复用 `dagToFlowNodes` / `dagToFlowEdges`（避免双 IPC 序列化），且 `buildRecipeDag` 不依赖 Node API。最终放在 `src/shared/recipe-dag.ts`，**main 与 renderer 都可 import**。这与 ESLint `no-restricted-imports`（renderer 禁止 import `../main/*`）一致。

### 2. 执行进度面板（D5c-3）

- `RecipeRunner` 新增 `setProgressListener(listener)` 方法（与 `SubagentManager.onProgress` 模式对齐）。
- 在 `executeSteps` 每个步骤的 start / complete / fail / cancel 时刻 `emitProgress()`。
- IPC 事件：`recipe:run:progress`（payload: `RecipeRunProgressEvent`）。
- UI：`src/renderer/panels/RecipeRunProgress.tsx`
  - 订阅 IPC + 初始从 `recipes:getRun` 拉取。
  - 顶部进度条 + 状态徽标 + 取消按钮。
  - 步骤列表（每行：图标 + 序号 + 名称 + 耗时）。
  - 错误条（dismissible）。
  - 折叠 / 展开按钮（参考 WritebackPanel 模式）。
  - `onStepUpdate` 回调把状态推到父组件 → RecipeDagView 上色。

### 3. 集成入口（D5c-4）

- `RecipesPanel.tsx` 在详情页顶部新增「DAG 视图」折叠面板（Network icon + 步骤 / 边统计）。
- Run Recipe 后弹出 `RecipeRunProgress` 浮层（绝对定位 `top-16 right-4 z-50`，与 WritebackPanel 同款 shell）。
- 浮层关闭时清空 `liveStepStatus`。

### 4. 测试（D5c-5）

- `src/main/recipes/__tests__/dag-graph.test.ts` — **24 cases**（≥ 6）
  - resolveStepId / resolveStepLabel 派生规则
  - extractOutputRefs 模板引用解析（含双花括号）
  - 线性 DAG 推断（数组顺序兜底）
  - 并行分组推断（depends_on 共享依赖）
  - depends_on 按 name / id 解析
  - `${outputs.X.Y}` 隐式引用 + depends_on 显式声明的合并（去重）
  - 2-node / 3-node 循环检测
  - 缺失依赖（depends_on 引用不存在 step + output-ref 引用不存在 step）
  - dagToFlowNodes 列布局验证
  - dagToFlowEdges 数据载荷 + 动画标记
  - 节点元数据（agent_type / shellCommand[0] / status / index）
- `src/renderer/panels/__tests__/RecipeRunProgress.test.tsx` — **7 cases**（≥ 4）
  - 初始全部 pending 状态
  - 进度事件流：running → completed → running → failed（计数 + 状态同步 + onStepUpdate 回调）
  - 错误条显示 + dismiss
  - 折叠 / 展开
  - 取消按钮触发 recipes:cancel
  - 关闭按钮触发 onClose
  - 过滤其他 runId 的事件

### 5. 测试基础设施

- 新增 `vitest.setup.js`（js 而非 ts 以规避顶层 ESLint parser 配置）：mock `ResizeObserver` + `matchMedia`，解决 jsdom 缺失导致的 @xyflow/react ReferenceError。
- `vitest.config.ts` 注册 `setupFiles`。
- `eslint.config.mjs` 未改动（renderer 仍禁止 import `../main/*`）。

## 验证结果

| 项目 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | ✅ 0 错误 |
| `npm run lint` | ✅ 0 警告 |
| `npm run test` | ✅ 81/81 recipe + 321/321 renderer 测试通过 |
| 手动验证 | 待 `npm run dev` 验证 DAG 渲染 + 进度推送 |

## 设计取舍

1. **DAG 拓扑布局**：用 Kahn + 朴素列网格（`level * xGap` / `row * yGap`），不引入 dagre。Recipe 通常 ≤ 20 步，复杂度足够。
2. **进度事件粒度**：步骤级（start + complete + fail + cancel），不分 token / streaming 增量。Subagent 已经发 streaming，但 Recipe 层只需「整步完成」语义。
3. **取消按钮双源**：progress 面板 + run history 都有按钮；功能等价于 `runner.cancel(runId)`。
4. **错误展示**：步骤行下挂 detail + 顶部 banner。两处展示同一 `error` 字段，便于扫读。

## 与 CLAUDE.md「Boundaries with Agent CLI」的对齐

- **不替换 Agent CLI 的认证 / 权限检查**：进度事件从 RecipeRunner 推送，不修改 subagent 的 emitProgress 时机。
- **不修改 prompt / model request headers**：DAG 视图只读取 RecipeDefinition；不写 prompt、不注入 context。
- **不污染 KV-cache prefix**：RecipeRunner 新增的进度事件不入 prompt，纯 renderer-side 展示。
- **不写入项目工作目录之外的文件**：无文件写入。
- **IPC 路径校验不替代 OS 级沙箱**：dag-graph 是纯计算，与 sandbox / ScopeGuard 解耦。

## 后续可能扩展（不在本次范围）

- DAG 自动布局（dagre）— 当 recipe > 30 步时考虑。
- 实时 streaming subagent 输出到进度面板（目前只到步骤级）。
- Recipe 步骤级别 retry / fallback 策略（当前没有重试机制）。
