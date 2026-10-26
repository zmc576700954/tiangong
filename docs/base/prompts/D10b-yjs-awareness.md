# D10b: Yjs Awareness（光标 / 选区）

## 会话元数据

- **ID**: D10b
- **前置**: D10a 已合并
- **工作分支**: `claude/phase-d10b-yjs-awareness`
- **预估工作量**: 3-5 工作日
- **依赖**: D10a

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d10b-yjs-awareness`
- 路径：`.claude/worktrees/phase-d10b`
- ⚠️ WebSocket server 端口：1235（D10a 用 1234，请避让）

## 上下文

D10a 实现 Yjs 文档 + WebSocket 同步。D10b 加 awareness — 多人协作时显示：
- 其他用户的光标（在画布上的位置）
- 其他用户当前选中的节点
- 其他用户的用户名 / 颜色

让协作"看得见"。

## 任务清单

### D10b-1：Awareness provider

- `src/main/realtime/awareness-server.ts`
- 复用 D10a 的 WebSocket，附加 awareness 通道
- 每 client 注册 `{ userId, userName, color, cursor: { x, y }, selectedNodeIds: string[] }`

### D10b-2：渲染端光标层

- `src/renderer/canvas/RemoteCursors.tsx`
- 监听 awareness 变化
- 在画布上画其他用户的光标（带名字标签 + 颜色）
- 选中节点高亮（边框颜色 = 该用户）

### D10b-3：用户识别

- 接入 settings（`settings.userId` / `settings.userName` / `settings.userColor`）
- 首次启动随机分配 UUID + 调色板（红/橙/黄/绿/蓝/紫 6 色循环）

### D10b-4：本地 awareness 状态

- 当前用户选中节点变化 → 更新 awareness（throttle 100ms）
- 光标 mousemove → 更新 awareness（throttle 50ms）

### D10b-5：测试

- `src/renderer/canvas/__tests__/RemoteCursors.test.tsx` ≥ 5 个 case
  - 多用户 awareness 渲染
  - 颜色分配正确
  - throttle 不爆炸

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：开两个浏览器窗口 → 各自移动光标 / 选中节点 → 互相可见

## 关键参考

- y-protocols/awareness：https://github.com/yjs/y-protocols/tree/master/awareness
- `@xyflow/react` 自定义层渲染
- `src/renderer/store/graphStore.ts`（选中状态）

## 完成定义

- [ ] D10b-1 ~ D10b-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D10b 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d10b.md` 跟踪文档