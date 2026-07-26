# Wiki 图计算 + LLM Ingest + Graph Lint · 任务跟踪

> 创建：2026-07-26
> 设计文档：[../superpowers/specs/2026-07-25-wiki-graph-compute-design.md](../superpowers/specs/2026-07-25-wiki-graph-compute-design.md)
> 实施计划：[../superpowers/plans/2026-07-25-wiki-graph-compute.md](../superpowers/plans/2026-07-25-wiki-graph-compute.md)
> 前置任务：[2026-07-23-wiki-link-ingest.md](2026-07-23-wiki-link-ingest.md)（wikilink 全链路 + 规则式 Ingest）

## 当前状态

**完成** — 全部 7 个任务已交付；最终整体审查发现的 ship-blocker（communityId 未持久化）已修复并复审通过。分支 `worktree-wiki-graph-compute`，待合并。

## 目标

在 wikilink 全链路之上叠加：Louvain 社区发现（写回 communityId + 规则生成社区页）、LLM 提炼式导入、Graph Lint 只读报告 + 前端面板。

## 任务清单

- [x] T1: 共享类型扩展（specialPage+community / communityId / IngestMode / Lint+Compute 类型 / 新 IPC 通道）— b7be2e2
- [x] T2: louvain.ts 纯函数（TDD）— c1c5b66 + 审查修复 acd9e90（LCG 除数 off-by-one + 收敛上限）
- [x] T3: graph-compute-service（TDD）— b15cdaf + 审查修复 f4d808d（communityId 稳定性 + 孤儿页清理）
- [x] T4: llm-ingest-service（TDD）— a998544 + 审查修复 b7f604b（fallback 正则过度截断 + 标题归一化）
- [x] T5: graph-lint-service（TDD）— da9218b
- [x] T6: IPC 接线（ingestFiles 加 mode + computeCommunities/lint 通道）— 5e2764f + 审查修复 d4ec9b2（agent 可用性 + projectPath 守卫 + 文件大小上限）
- [x] T7: 渲染层（graphStore + LintPanel + 画布入口）— 606c9db + 修复 d01b731（lintLoading 卡死）+ 4844507（IPC 失败补 catch）
- [x] 最终审查修复（ship-blocker）— 3cd02fa（communityId 持久化）+ 1be1157（specialPage 描述）

每个任务：实现子代理（串行）→ 规格审查 → 质量审查 → 修复 → 复审。

## 验证门槛（每个 commit 前）

- `npx tsc --noEmit` 零错误
- `npm run test` 全绿（当前 1833 tests / 174 files）
- `npm run lint` 零警告

## 关键决策

- 本阶段范围三件套全做：LLM Ingest + Louvain + Graph Lint
- Louvain 摘要不走 LLM，社区页规则化生成（`communitySummary` 留待后续 LLM 增强）
- Louvain 主进程同步计算，不开 Worker Thread（wiki 图规模小；IPC 批量上限约束）
- Louvain 自研纯函数 `louvain.ts`，不引第三方图库
- LLM Ingest 复用 `sendPromptViaAgent`（one-shot claude-code，MCP 自动回退），不新造 LLM 通路
- Graph Lint 全手动修复，不做自动修复按钮
- 社区页规则化生成，正文含成员 wikilink + 统计，同时反向补强图连通性

## 审查结论记录

- 2026-07-26（最终整体审查，opus）：发现 ship-blocker **C1：communityId 从未持久化**——`nodes` 表无 `community_id` 列、`NodeRepository` 四处映射缺失，导致 Louvain 写回与 Lint 社区异常检测在生产失效。所有测试用内存 fake repo 未暴露（违反设计文档「真实 better-sqlite3 内存库」要求）。修复：schema v6→v7 + `addColumnSafe('nodes','community_id','TEXT')` + repository 映射 + 真实库 round-trip 测试（3cd02fa）。复审确认：现有 v6 库升级路径无损（community_id 不在 requiredColumns → rebuildTableIfNeeded 提前返回不重建 → ALTER TABLE 增量加列）。
- 2026-07-26（最终审查次要项）：I1 真实库测试（随 C1 落地）、I2 lint/recompute IPC 失败补 catch（4844507）、M1 WikiNodeMeta 补 sourceFile/importedAt/ingestWarning（随 C1）、M2 specialPage 描述补 community（1be1157）、M3 oversized 消息改用代表标题（随 C1）——均已修。
- 2026-07-26（跨切关注点确认）：社区页反馈循环**非 bug**——computeCommunities 节点集排除 `specialPage='community'`，且社区页经 `nodeRepo.create` 直接创建绕过 IPC syncNodeLinks，其 `[[member]]` 链接不落边，不回流污染图（幂等测试证明）。

## 后续跟进（不阻塞合并）

- **M4**：社区页正文嵌入 `[[成员标题]]`，成员被重命名/删除后会在 Lint 报悬空链，但社区页标注「请勿手工编辑」——下次 `computeCommunities` 会重生成清除。可考虑：断链扫描排除特殊页，或在 hint 注明「重算社区可清除」。
- **M5**：设计文档写「WikiImportDialog 加 LLM 开关」，实现为画布右键菜单两个独立入口（规则/LLM），无 WikiImportDialog 组件。功能等价（mode 已暴露并透传），UX 形态不同。可更新设计文档或后续统一为 dialog。
- IPC `wiki:computeCommunities`/`wiki:lint` 的 happy-path 集成测试仍用 fake repo（设计文档要求真实库）。C1 已在 repository 层补了真实库 round-trip 测试，但 IPC 层可再补一组真实 DB 集成测试增强信心。
- Lint 报告在图变更后不自动刷新（需手动重开或点重算）——可后续加图变更订阅。
- LLM 提炼的 `existingTitles` 在批量循环开始前快照一次——同批先建的页面标题不会进入后续文件的 prompt。可后续每文件刷新。
- LintPanel 可点击行无 `role="button"`/`tabIndex`，键盘不可达——a11y 后续。

## 会话恢复指南

**如果会话中断，从这里继续：**

1. 读设计文档与实施计划（上方链接）了解全貌
2. 本阶段全部完成，分支 `worktree-wiki-graph-compute` 待合并到 main
3. 合并后下一阶段见记忆 `llm-wiki-stepwise-plan`（4-Signal 相关性 / Query Writeback / Deep Research 补缺口 / MCP Server 暴露 / LLM 社区摘要增强）
4. 上述「后续跟进」项可作为下一阶段的顺手修复

## 已知注意事项

- worktree 的 `node_modules` 是指向主仓库的符号链接（`npm install` 在 worktree 失败，改用 `ln -s /Users/zhumingchen/tiangong/node_modules node_modules`）。git 已忽略。
- 全量 `npx vitest run` 偶发 worker 并行 flake（28 失败一次性出现，连续重跑均 1833 全绿）——与 symlink node_modules 相关，非代码问题。
- 本阶段 schema 升级到 v7（新增 `nodes.community_id`）。
- macOS tmpdir 符号链接（/var→/private/var）注意事项沿用上一阶段。
