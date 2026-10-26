# D2: FloatingPanel 共享 Shell 抽取

## 会话元数据

- **ID**: D2
- **前置**: 基座 v1（Phase C 完成 RecipesPanel 后已 2 个浮层）
- **工作分支**: `claude/phase-d2-floating-panel`
- **预估工作量**: 3-5 工作日
- **依赖**: 无
- **触发条件**: 加第 3 个浮层前必做；否则每加一个就重复一次 boilerplate

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d2-floating-panel`
- 路径：`.claude/worktrees/phase-d2`

## 上下文

基座版 LeftPanel.tsx 内含 2 个浮层 overlay：
- Settings overlay（`showSettings` state + 顶栏 + 关闭按钮 + SettingsPanel 渲染）
- Recipes overlay（`showRecipes` state + 顶栏 + 关闭按钮 + RecipesPanel 渲染）

两份代码高度相似：状态、顶栏样式、关闭逻辑、动画。未来加 WikiPageEditor 浮层时再写第三遍不优雅。

D2 抽取 FloatingPanel 共享 shell。

## 任务清单

### D2-1：设计 FloatingPanel API

```typescript
// src/renderer/components/ui/FloatingPanel.tsx
interface FloatingPanelProps {
  isOpen: boolean
  onClose: () => void
  title: string
  icon?: React.ReactNode
  width?: string  // 默认 '100%'（绝对定位 inset-0）
  children: React.ReactNode
}
```

行为：
- 全屏覆盖（`absolute inset-0`）
- 顶栏：图标 + 标题 + 关闭按钮
- 背景模糊（`bg-background/95 backdrop-blur`）
- Esc 键关闭（焦点在面板内时）
- `aria-modal="true"` + `role="dialog"`

### D2-2：迁移 LeftPanel

- 移除 inline overlay 渲染（约 80 行）
- 替换为 `<FloatingPanel isOpen={showSettings} onClose={...} title="Settings" icon={<Settings />}><SettingsPanel /></FloatingPanel>`

### D2-3：迁移第二个浮层（同上）

- Recipes overlay 同样替换
- 视觉差异（如果有）通过 `icon` / `title` 传递

### D2-4：新增测试

- `src/renderer/components/ui/__tests__/FloatingPanel.test.tsx` ≥ 6 个 case
  - 渲染开关
  - Esc 键关闭
  - 点击关闭按钮
  - icon 与 title 正确显示
  - aria 属性正确

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run src/renderer` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动 `npm run dev`：打开 Settings → 关闭 → 打开 Recipes → 关闭 → Esc 键均能关闭
- [ ] `git diff --stat src/renderer/panels/LeftPanel.tsx` 行数减少 ≥ 40

## 关键参考

- `src/renderer/panels/LeftPanel.tsx`（现含两份 inline overlay）
- `src/renderer/components/ui/ToastContainer.tsx`（参考绝对定位 + z-index 风格）
- `src/renderer/components/ui/ErrorBoundary.tsx`（参考 class 组件模式）

## 完成定义

- [ ] D2-1 ~ D2-4 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D2 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d2.md` 跟踪文档