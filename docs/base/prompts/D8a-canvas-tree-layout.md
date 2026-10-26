# D8a: 画布树形自动布局

## 会话元数据

- **ID**: D8a
- **前置**: 基座 v1（@xyflow/react 已集成）
- **工作分支**: `claude/phase-d8a-canvas-tree-layout`
- **预估工作量**: 3-5 工作日
- **依赖**: 无
- **后续**: D8b（力导向布局）

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d8a-canvas-tree-layout`
- 路径：`.claude/worktrees/phase-d8a`

## 上下文

基座版节点位置由用户手动拖拽保存。新建节点时位置默认在中心 + 随机偏移，节点一多就重叠混乱。
D8a 加 dagre / elk 自动布局（按 NodeType 树形排列）。

## 任务清单

### D8a-1：依赖选型

- 推荐：`dagre`（轻量，无渲染依赖，~50KB）
- 或：`@kamilkisiela/graphql-js-tree` 风格的 tree 库
- 备选：`elkjs`（功能强但 ~200KB + WASM 复杂）

**决策记录**：先用 dagre，满足基座需求；elk 留 Phase D 后续。

### D8a-2：布局算法

- `src/renderer/canvas/layouts/tree-layout.ts`
- 输入：`{ nodes: Node[], edges: Edge[] }`（含 type / parent / projectRoot）
- 输出：每个节点的 `{ x, y }`
- 算法：
  - 找出根节点（无入边的 project 节点）
  - 按 NodeType 分层：project > module > process > feature/bug
  - 同层水平等距，垂直方向 rank sep
  - 跨层从左到右（LR）布局

### D8a-3：UI 集成

- 画布顶部 toolbar 加「自动布局」按钮（图标 `Layout` from lucide-react）
- 点击后弹确认：「将覆盖当前节点位置，确定？」→ 确认后调用布局算法 + 持久化到 DB

### D8a-4：边界

- 仅对当前 graph（online / dev 独立布局）
- 保留用户自定义的「拖拽锁定」节点（基座版无此概念，D8a 不引入；D8b 再考虑）

### D8a-5：测试

- `src/renderer/canvas/layouts/__tests__/tree-layout.test.ts` ≥ 8 个 case
  - 线性链
  - 多叉树
  - 多个 project 根
  - cycle 防御（断开回边）
  - 性能：500 节点 < 500ms

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：导入示例项目 → 点自动布局 → 节点整齐排列 → 刷新页面位置持久化

## 关键参考

- `@xyflow/react`（项目已用）
- `src/renderer/canvas/GraphCanvas.tsx`（节点渲染）
- `src/renderer/store/graphStore.ts`（节点状态）
- dagre 文档：https://github.com/dagrejs/dagre

## 完成定义

- [ ] D8a-1 ~ D8a-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D8a 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d8a.md` 跟踪文档