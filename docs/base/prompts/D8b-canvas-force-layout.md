# D8b: 画布力导向布局

## 会话元数据

- **ID**: D8b
- **前置**: D8a 已合并
- **工作分支**: `claude/phase-d8b-canvas-force-layout`
- **预估工作量**: 5-7 工作日
- **依赖**: D8a

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d8b-canvas-force-layout`
- 路径：`.claude/worktrees/phase-d8b`

## 上下文

D8a 树形布局适合 project → module → process → feature 的层级图，但基座版 graph 是 heterogeneous 的：模块间有 cross-reference、feature 有依赖。
D8b 加力导向布局（d3-force） — 节点按边关系 + 排斥力自动均衡。

## 任务清单

### D8b-1：依赖

- `d3-force`（~30KB，纯 JS）

### D8b-2：力导向算法

- `src/renderer/canvas/layouts/force-layout.ts`
- d3-force 配置：
  - `forceLink`：边作为弹簧（距离 = 80）
  - `forceManyBody`：节点间排斥力（强度 = -300）
  - `forceCenter`：向画布中心吸引
  - `forceCollide`：节点不重叠（半径 = node.width/2 + 10）
- 模拟迭代：`alphaDecay=0.05`，200 tick 后停止
- 固定已布局节点（D8a 树形布局过的位置作为初始 guess）

### D8b-3：UI 集成

- 画布 toolbar 加「力导向布局」按钮
- 自动布局下拉里提供两个选项：「树形」「力导向」
- 跑模拟时显示 loading（CPU 密集）

### D8b-4：交互优化

- 力导向运行时，用户拖拽节点临时 pin（alphaTarget=0）
- 拖拽结束后取消 pin（alphaTarget=0 + 重启 simulation alpha=0.3）

### D8b-5：测试

- `src/renderer/canvas/layouts/__tests__/force-layout.test.ts` ≥ 6 个 case
  - 收敛性（200 tick 后位置稳定）
  - 排斥力避免重叠
  - pin/unpin 行为
  - 性能：500 节点 < 1s

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：跨模块 graph → 力导向 → 节点均匀分布

## 关键参考

- `src/renderer/canvas/layouts/tree-layout.ts`（D8a）
- `d3-force` 文档：https://d3js.org/d3-force
- `@xyflow/react` 节点 API

## 完成定义

- [ ] D8b-1 ~ D8b-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D8b 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d8b.md` 跟踪文档