# D7a Wiki Lint 面板增强（一键修复）· 任务跟踪

> 创建：2026-10-01
> 范围：Phase D — D7a Wiki Lint 面板增强（修复指引）
> 工作分支：`claude/phase-d7a-wiki-lint-fix-actions`
> 计划来源：[D7a prompt](../../.claude/worktrees/bizgraph-improvement-plan-c1ff78/docs/base/prompts/D7a-wiki-lint-fix-actions.md)

## 当前状态

**全部 5 个子任务已落地，lint 从只读诊断升级为「可执行的修复入口」。**
`npx tsc --noEmit` 零错误，`npm run lint` 零警告，D7a 相关测试 38 例全部通过
（LintPanel 12 / graph-lint-service 13 / lint-fix-service 13）。

## 目标

基座版 Wiki LintPanel 只展示 lint 结果（断链 / orphan / frontmatter 等），
用户看到问题后无法一键修复。本任务把 lint 从只读诊断扩展为「可执行的修复入口」：
- 每条 issue 携带 `code` / `severity` / `fixable` / `fix` / `location` 字段
- 新增三种可一键修复的 issue 类型（dangling-link / missing-frontmatter / inconsistent-case）
- LintPanel 按严重度分组渲染，fixable=true 时显示「修复」按钮
- 修复走新 IPC `wiki:applyFix`，由后端 `LintFixService` 统一执行

## 任务清单

- [x] **D7a-1**：`src/shared/types/wiki.ts` 扩展 `LintIssue` 增加
  `code` / `location` / `fixable` / `fix` 字段；`severity` 由 `info|warning`
  扩展为 `error|warning|info`；新增 `LintFixAction` / `LintFixResult` 类型。
- [x] **D7a-2**：`src/main/wiki/graph-lint-service.ts` 把三种可一键修复的 issue
  标记 `fixable=true` 并附 `fix` 描述：
  - `dangling-link` → `create-stub-page`
  - `missing-frontmatter` → `add-frontmatter`（新增检测：wiki 页正文存在但
    `wikiMeta.frontmatter` 缺失 / 为空对象）
  - `inconsistent-case` → `normalize-case`（新增检测：标题与归一化
    `lower-case + trim + 合并空白` 后形态不同）
  - `orphan` / `community-singleton` / `community-oversized` 保持 `fixable=false`
- [x] **D7a-3**：新增 IPC `wiki:applyFix(graphId, fix)` →
  `LintFixResult`，由 `LintFixService` 派发到具体 fix 实现。
  `src/main/ipc/graph.ts` 内校验 `fix.kind` 必须在白名单内（防注入）。
- [x] **D7a-4**：`src/renderer/components/wiki/LintPanel.tsx` 改为按严重度分组
  （错误 → 警告 → 提示），每组内仍按 kind 聚合；fixable=true 显示「修复」
  按钮（点击停止事件冒泡，避免误触「跳转到节点」）；成功 toast / 失败 toast。
- [x] **D7a-5**：测试 ≥ 8 例 — 实际 38 例。
  - LintPanel.test.tsx：12 例（严重度分组 / 跳转 / 键盘 / 修复按钮 /
    修复成功 → 移除 + toast / 修复失败 → 错误 toast + 保留）
  - graph-lint-service.test.ts：13 例（含新增的 missing-frontmatter /
    inconsistent-case / fixable / location 场景）
  - lint-fix-service.test.ts：13 例（3 种 fix 的正反向 + 错误路径 +
    正则元字符边界）

## 关键设计决策

### 修复走 Subagent 之外的写入口

`LintFixService` 直接使用 `NodeRepository.create` / `update` 与
`WikiLinkService.syncNodeLinks`，不走 Subagent / Agent。这与 CLAUDE.md Boundaries
中「修复写动作仍由 BizGraph 维护，不污染 Agent CLI 调用边界」的立场一致
——lint 是图谱内一致性维护，不是代码生成任务。

### `normalize-case` 的全图替换

归一化标题时不仅改本节点 title，还扫描全图 `wikiContent`，把所有
`[[OldTitle]]` / `[[OldTitle|显示]]` 替换为 `[[NewTitle]]`，并对每个受影响节点
重跑 `syncNodeLinks`。正则对 `OldTitle` 做 `escapeRegex`，避免括号、点号等元字符
误触发灾难性回溯。测试覆盖了 `Foo (v1.0)` 这类典型元字符标题。

### create-stub-page 的去重

如果 `targetTitle` 与已有页面（大小写不敏感）重名，直接返回已有节点 ID 并同步
源节点出边，不会创建重复 stub。`WikiIndexService.resolveWikiLink` 的解析策略与
重命名检测一致，不会出现「stub 已建但 wikilink 仍断链」的中间态。

### 严重度升级为 'error'

保留 `info` / `warning` 不变，新增 `error` 留作后续可能出现的「必须立即修复」
类问题。当前 D7a 没有 issue 用 `error`——主要是给未来扩展（如 yaml 解析错误）
留位；UI 已支持三档渲染（红 / 琥珀 / 灰）。

## 验证门槛

- [x] `npx tsc --noEmit` 零错误
- [x] `npm run lint` 零警告（整库）
- [x] D7a 相关 38 个测试全部通过
- [x] 手动验证：「断链 → 创建 stub」场景通过 store action
      `applyLintFix` → IPC `wiki:applyFix` → `LintFixService.createStubPage` →
      `WikiLinkService.syncNodeLinks` 链路联调

未在本次 commit：
- ~~`wiki:applyFix` 集成到 `community-oversized` / `orphan` 等结构性问题的
  修复入口~~ → 当前 D7a 范围内不需要（属于「调 Louvain resolution」「加链接」
  等用户操作，无法自动一键修复）

## 与并行任务的关系

- D7b（writeback rollback）走的是 `writeback_items` 表，与 D7a 修复走的
  `nodes` / `edges` 表不冲突。
- D7a 不修改 `community-*` 类 issue 的修复策略，避免与 D3（wiki-coverage）、
  D8（canvas layout）的图谱结构假设冲突。

## 文件清单

### 新增
- `src/main/wiki/lint-fix-service.ts` — 修复服务
- `src/main/wiki/__tests__/lint-fix-service.test.ts` — 13 例

### 修改
- `src/shared/types/wiki.ts` — `LintIssue` / `LintFixAction` / `LintFixResult`
- `src/shared/types/ipc.ts` — `IpcApi['wiki:applyFix']`
- `src/main/wiki/graph-lint-service.ts` — 新检测 + fixable / fix 字段
- `src/main/wiki/__tests__/graph-lint-service.test.ts` — 7 例新增
- `src/main/ipc/graph.ts` — `wiki:applyFix` 处理器
- `src/preload/index.ts` — `wiki:applyFix` 加入白名单
- `src/renderer/store/graphStore.ts` — `applyLintFix` action
- `src/renderer/components/wiki/LintPanel.tsx` — 严重度分组 + 修复按钮
- `src/renderer/components/wiki/__tests__/LintPanel.test.tsx` — 6 例新增
- `src/renderer/canvas/GraphCanvas.tsx` — `handleLintApplyFix` 接入
