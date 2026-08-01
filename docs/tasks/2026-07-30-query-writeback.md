# Query Writeback（Agent 会话产物回写 Wiki 图）· 任务跟踪

> 创建：2026-07-30
> 设计文档：[../superpowers/specs/2026-07-30-query-writeback-design.md](../superpowers/specs/2026-07-30-query-writeback-design.md)
> 实施计划：[../superpowers/plans/2026-07-30-query-writeback.md](../superpowers/plans/2026-07-30-query-writeback.md)
> 前置任务：[2026-07-26-wiki-graph-compute.md](2026-07-26-wiki-graph-compute.md)（图计算 + LLM Ingest + Graph Lint）

## 当前状态

**完成并已合并** — 全部 8 个任务 + 最终整体审查修复已交付，分支 `worktree-query-writeback` 已合并 main（@ 1183729），worktree 与分支已删除。

## 目标

Agent 会话结束后，PipelineRunner 末尾新增 writeback 阶段，从会话 MemoryItem 规则式提炼回写项（追加到现有节点的「## 会话日志」小节 / 概念聚类提炼新 Wiki 页面），入 `writeback_items` 审核队列，用户在画布面板采纳/丢弃后回写进图。

## 任务清单

- [x] T1: 共享类型 + schema v8（writeback_items + 2 索引 + graphs.writeback_disabled）+ WritebackRepository — b2983c5 + 审查修复 7883c31
- [x] T2: WritebackService 规则模板生成（top-5 置信度 + 概念聚类 ≥2 + 按会话去重）— 6b0761a + 审查修复 00eac79（confidence 复用 + markdown 转义 + 确定性时间戳）
- [x] T3: WritebackService.accept 采纳落点（append-log 幂等追加 + new-page 建页连边，真实库）— 5499a95 + 审查修复 e756beb（标题级幂等 + syncNodeLinks 错误隔离 + 事务原子性）
- [x] T4: 管线接 writeback 阶段 + 全局/项目开关 — 6f54e1b + 审查修复 3780f63（mergeSettings 保留 writeback + 阶段错误入 result.errors + isWritebackDisabled 收敛 + skip 测试控制组）
- [x] T5: IPC 4 通道 + preload 白名单 + GraphRepository.delete 清理 — 1a1d1b9 + 审查修复 00665ba（discard 收进服务层 + **edges CHECK 约束补全修潜伏生产 bug** + IPC 测试 DDL 对齐）
- [x] T6: graphStore 4 action + WritebackPanel — b4186d7 + 审查修复 1ef096a（confidence NaN 守卫 + targetNodeId 防御 + vitest 补 .tsx include）
- [x] T7: 画布菜单「审核队列(N)」入口 + 接线 — 12a7145 + 审查修复 705298f（图切换重置面板状态）
- [x] T8: 顺手修复三项（M4 社区页断链噪音 + IPC 真实库集成测试 + LintPanel a11y）— b51feb9 + 审查修复 3e27c03（orphan 排除自环边 + aria-label）
- [x] 最终整体审查修复 — 1183729（2 Critical + 3 Important + 2 Minor）

每个任务：实现子代理（串行）→ 规格审查 → 质量审查 → 修复 → 复审。

## 验证门槛（每个 commit 前）

- `npx tsc --noEmit` 零错误
- `npm run test` 全绿（当前 1914 tests / 180 files）
- `npm run lint` 零警告

## 关键决策

- 回写内容两类：append-log（追加到现有节点）+ new-page（MemoryItem 概念聚类 ≥2 提炼新页）；不做第三类「MemoryItem 转 Wiki 页」独立通道（并入 new-page）
- 审核队列：新表 `writeback_items`（schema v8），**不直接写图**——采纳/丢弃由用户决策
- 规则提炼，不走 LLM（成本/确定性）
- UI 入口：画布右键菜单「审核队列(N)」+ WritebackPanel（不做独立页面）
- append-log 采纳追加 `## 会话日志 · 日期` 小节，幂等按「## 标题」行匹配
- 按会话去重：`findBySession` 含 discarded——「丢弃」语义是「不想要」，不是「重新生成」
- 开关语义：**全局默认开 + 项目单向覆盖**（全局开时项目可关，全局关时项目不可开）；`graphs.writeback_disabled` 列
- 丢弃只出队（状态 pending→discarded），不删记录
- writeback 阶段嵌入 PipelineRunner 末尾（方案 A），accept 走 GraphService/repo 标准路径（syncNodeLinks 免费获得）

## 审查结论记录

- 2026-07-30（T5 审查，顺带发现**潜伏生产 bug**）：`edges` 表 CHECK 约束（database.ts:294）漏 'wiki-link'/'semantic'——fresh install 拒绝这两类边插入且 IPC syncWikiLinks 静默吞错，wiki-link 落边自阶段二起在新装环境实际失效。旧库经 rebuildTableIfNeeded CHECK 比对无损重建。修复：生产 + 全部测试 fixture DDL 对齐 9 值全集（00665ba）。
- 2026-07-30（最终整体审查，sonnet）：
  - Critical ×2：new-page frontmatter `title:` 未转义（concept 含 `[`/引号破坏 YAML）；源节点标题含 `|` 生成 wikilink 被解析成显示文本导致断链。修复：YAML 双引号包裹 + `sanitizeLinkTitle`（1183729）。
  - Important ×4：findBySession 去重漏 discarded（全部丢弃后重复生成）→ 已修；append-log 幂等子串匹配（正文提到日期字符串误跳过）→ 改小节标题行匹配；同源节点多 new-page 坐标重叠 → **接受为已知限制**（修需跨层读实时位置，见跟进项）；confidence 均值 NaN 落库 → `Number.isFinite` 守卫。
  - Minor ×3：settings 校验补 writeback 布尔（已修）；WritebackPanel 测试真空断言（已修）；details 块 HTML 注入 → **审查误报**（narrative 已经 escMd 转义 `<>`）。
- 2026-07-30（T8 审查）：orphan 判定把自环边当连通性（测试靠种自环边规避）→ orphan 排除自环 + 测试改真实第三页连接 + LintPanel focusable 行补 aria-label（3e27c03）。

## 后续跟进（不阻塞合并）

- **多 new-page 节点位置重叠**：同一源节点连续采纳多个 new-page 时固定偏移 +280/+120 堆叠。修需从 GraphService/前端读实时节点位置找空位，或后续自动布局统一解决。
- **FloatingPanel 共享外壳**：LintPanel/WritebackPanel 已是第 2-3 个浮层，到位 3 个时抽共享 shell。
- **writeback 计数跨窗口刷新**：采纳/丢弃后其他窗口的「审核队列(N)」计数不自动更新，需事件总线推送。
- **快速连点采纳的 in-flight 守卫**：UI 层防重复点击的 UX 优化。
- **WikiImportDialog 与菜单漂移**（M5，阶段三遗留）：设计写 dialog 加 LLM 开关，实现为画布菜单两入口。功能等价，UX 形态可后续统一。
- renderer coverage include 未配（测试在跑但覆盖率统计不含渲染层）。

## 会话恢复指南

**如果会话中断，从这里继续：**

1. 读设计文档与实施计划（上方链接）了解全貌
2. 本阶段全部完成并已合并 main（@ 1183729），worktree/分支已删除，无待办
3. 下一阶段候选见记忆 `llm-wiki-stepwise-plan`（4-Signal 相关性 / Deep Research 补缺口 / MCP Server 暴露 / LLM 社区摘要增强）
4. 上述「后续跟进」项可作为下一阶段的顺手修复

## 已知注意事项

- worktree 的 `node_modules` 是指向主仓库的符号链接（`npm install` 在 worktree 失败，改用 `ln -s`）——本阶段 worktree 已删除，下阶段新建时沿用。
- 全量 `npx vitest run` 偶发 worker 并行 flake（agent-manager.test.ts 1~28 失败不定，单独跑 34/34 绿）——symlink node_modules + worker 并行所致，非代码问题。
- 本阶段 schema 升级到 v8（`writeback_items` 表 + `graphs.writeback_disabled` 列）；edges CHECK 修正为 9 值全集，旧库 rebuild 无损。
- 实现子代理曾把 T1 修复提交到游离 HEAD（7883c31 孤儿提交），后续所有代理提示词均带「留在分支上 + 提交前 `git branch --show-current` 验证」。
