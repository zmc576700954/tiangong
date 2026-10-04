# D7a: Wiki Lint 面板增强（修复指引）

## 会话元数据

- **ID**: D7a
- **前置**: 基座 v1（Wiki LintPanel 已存在，参考 `src/renderer/components/wiki/`）
- **工作分支**: `claude/phase-d7a-wiki-lint-fix-actions`
- **预估工作量**: 3-5 工作日
- **依赖**: 无
- **并行**: D7b

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d7a-wiki-lint-fix-actions`
- 路径：`.claude/worktrees/phase-d7a`

## 上下文

基座版 Wiki LintPanel 只展示 lint 结果（断链 / orphan / frontmatter 错误）。用户看到问题后无法一键修复。D7a 加：
- 每个 issue 可点击 → 跳转到编辑器对应位置
- 一键修复按钮（仅限可自动修复的 issue，如：缺失 frontmatter 自动补默认字段）
- Issue 按严重度分组

## 任务清单

### D7a-1：扩展 LintReport 类型

- `src/shared/types/wiki.ts` 的 `LintReport` 加：
  ```typescript
  interface LintIssue {
    severity: 'error' | 'warning' | 'info'
    code: string                  // 'dangling-link' / 'missing-frontmatter' / ...
    location?: { file: string; line?: number; column?: number }
    message: string
    fixable: boolean              // 是否可一键修复
    fix?: { kind: string; payload: unknown }  // 修复动作描述
  }
  ```

### D7a-2：可一键修复的 issue 类型

- `dangling-link` → 创建 stub 页面（标题占位 + 链接）
- `missing-frontmatter` → 自动补 `title` / `createdAt`
- `inconsistent-case` → 统一为小写

### D7a-3：IPC 加批量修复通道

- `wiki:applyFix(issueCode, location)` → 返回修复后的内容或动作结果
- 受 scope guard 保护（仅限项目目录内文件）

### D7a-4：LintPanel UI 增强

- 按严重度分组（错误 / 警告 / 提示）
- 每条 issue 有「跳转」 + 「修复」（fixable=true 时）两个按钮
- 修复后 issue 从列表移除 + toast 成功

### D7a-5：测试

- `src/renderer/components/wiki/__tests__/LintPanel.test.tsx` ≥ 8 个 case
  - 严重度分组
  - 跳转按钮
  - 修复按钮触发 IPC
  - 修复成功后 issue 消失

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run lint` 零警告
- [ ] 手动：故意写断链 → LintPanel 显示 → 点修复 → 文件被创建

## 关键参考

- `src/renderer/components/wiki/LintPanel.tsx`（现有面板）
- `src/main/wiki/markdown-utils.ts`（lint 实现）
- `src/main/services/wiki-link-service.ts`（dangling 扫描）
- `src/main/ipc/wiki.ts`（IPC 扩展点）

## 完成定义

- [ ] D7a-1 ~ D7a-5 全部完成
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D7a 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d7a.md` 跟踪文档