# D3: WikiPageEditor + SmartContextResolver 单测覆盖

## 会话元数据

- **ID**: D3
- **前置**: 基座 v1（Phase B 已实现 Wiki 系统 + SmartContextResolver）
- **工作分支**: `claude/phase-d3-wiki-coverage`
- **预估工作量**: 5-7 工作日
- **依赖**: 无
- **重要**: 这只是补测试覆盖，**不动产品代码**（除非发现 bug）

## Worktree 隔离（必读）

本会话必须在独立 git worktree 中运行，**禁止**直接在本目录修改代码（避免与其他 Phase D 任务冲突）。

完整工作流：见 [WORKTREE_GUIDE.md](../WORKTREE_GUIDE.md)（分支命名、创建命令、并行安全规则、端口冲突、清理流程）。

**本任务**：
- 分支：`claude/phase-d3-wiki-coverage`
- 路径：`.claude/worktrees/phase-d3`

## 上下文

基座 v1 现有 1914 → 1953 测试，但以下模块覆盖率低（vitest --coverage 显示 < 30%）：
- `src/renderer/components/wiki/WikiPageEditor.tsx`
- `src/main/code-intelligence/smart-context-resolver.ts`
- `src/main/wiki/ingest-service.ts`（部分路径）
- `src/main/wiki/wiki-link-service.ts`（反向链接 / 断链扫描）

D3 补齐测试，提升覆盖率到 ≥ 70%。

## 任务清单

### D3-1：WikiPageEditor 测试

- `src/renderer/components/wiki/__tests__/WikiPageEditor.test.tsx` ≥ 12 个 case
- 覆盖：
  - 编辑模式切换（view ↔ edit）
  - frontmatter 编辑（YAML 解析/序列化）
  - wikilink 自动补全（`[[` 触发下拉）
  - 保存 + 取消按钮
  - 错误提示（无效 wikilink、循环引用）
  - 大文档性能（mock 100KB 输入）

### D3-2：SmartContextResolver 测试

- `src/main/code-intelligence/__tests__/smart-context-resolver.test.ts` ≥ 15 个 case
- 覆盖：
  - 主符号解析（按 query 找最相关符号）
  - 相关符号展开（imports / exports）
  - 相关文件推断
  - 跨语言边界（TS 引 JS）
  - 模糊匹配（typo tolerance）
  - 性能：1000 符号项目 < 200ms

### D3-3：WikiLinkService 测试

- `src/main/services/__tests__/wiki-link-service.test.ts` ≥ 10 个 case
- 覆盖：
  - 反向链接（incoming）正确
  - 断链扫描（dangling）正确
  - 标题大小写不敏感
  - 跨命名空间（`wiki/foo` vs `project/foo`）

### D3-4：覆盖率报告

- `npm run test:coverage -- src/main/wiki src/main/code-intelligence src/renderer/components/wiki`
- 目标：上述目录 line coverage ≥ 70%、branch coverage ≥ 50%

## 验证门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run test` 全绿
- [ ] `npm run test:coverage` 上述目录覆盖率达标
- [ ] `npm run lint` 零警告
- [ ] 产品代码 diff 仅限 bug fix；不引入新功能

## 关键参考

- `src/renderer/components/wiki/WikiPageEditor.tsx`
- `src/main/code-intelligence/smart-context-resolver.ts`
- `src/main/wiki/ingest-service.ts`
- `src/main/services/wiki-link-service.ts`
- `vitest.config.ts`（覆盖率阈值配置）
- `src/main/wiki/__tests__/`（已有测试，可参考风格）

## 完成定义

- [ ] D3-1 ~ D3-4 全部完成
- [ ] 新增 ≥ 37 个测试 case
- [ ] PR 合并到 main
- [ ] 在 `docs/base/PHASE_D_TASKS.md` 把 D3 状态改为 ✅
- [ ] 创建 `docs/tasks/<DATE>-d3.md` 跟踪文档