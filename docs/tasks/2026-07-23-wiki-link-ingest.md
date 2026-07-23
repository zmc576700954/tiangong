# Wiki 链接全链路 + Ingest 管线 · 任务跟踪

> 创建：2026-07-23
> 设计文档：[../superpowers/specs/2026-07-23-wiki-link-ingest-design.md](../superpowers/specs/2026-07-23-wiki-link-ingest-design.md)

## 当前状态

**进行中** — 设计已确认，待进入实现计划阶段

## 目标

打通 wikilink 全链路（解析 → 落边 → 反向链接 → 断链检测），实现规则式文件导入管线，建立本任务跟踪机制。

## 任务清单

- [ ] T1: `npm rebuild better-sqlite3` + 本任务文档骨架提交（chore）
- [ ] T2: EdgeType 增加 `wiki-link` + WikiLinkService + syncNodeLinks 接入 GraphService（feat）
- [ ] T3: IPC 新通道（parseContent / getBacklinks / ingestFiles / findDangling）+ WikiPageEditor 重写（feat）
- [ ] T4: Ingest 管线 + 导入 UI 入口（feat）
- [ ] T5: 本任务文档收尾 + CLAUDE.md 补充 Wiki 机制说明（docs）

每个任务完成后：更新本文件 checkbox + 记录 commit hash → 运行验证门槛 → commit。

## 验证门槛（每个 commit 前）

- `npx tsc --noEmit` 零错误
- `npm run test` 全绿
- `npm run lint` 零警告

## 决策记录

- 2026-07-23：范围定为 A（wikilink 链路）+ B（wiki 边持久化）+ C（规则式 Ingest）+ D（任务文档）+ E（构建修复）。LLM 智能提炼留待下一阶段
- 2026-07-23：Ingest 采用规则式文件导入，不引入 LLM，保证确定性与可测试性
- 2026-07-23：架构选方案一（WikiLinkService 统一服务，复用 edges 表），而非独立 wiki_links 表——兼容后续 Louvain/4-Signal 图计算
- 2026-07-23：悬空链接不入库，由 parseContent 实时计算——避免脏数据修复问题
- 2026-07-23：同名页面导入采用追加策略（带来源分隔线），不覆盖不跳过
- 2026-07-23：导入节点初始 status: draft，走正常确认流程
- 2026-07-23：frontmatter 编辑从手写 YAML 改为后端解析结果的结构化展示，解析规则唯一化

## 会话恢复指南

**如果会话中断，从这里继续：**

1. 读设计文档（上方链接）了解全貌
2. 看本文件「任务清单」找到第一个未完成项
3. 看「决策记录」了解已定边界，不要重新讨论
4. 当前步骤：设计文档已写入并待提交，下一步是进入实现计划（writing-plans）或直接开始 T1

## 已知注意事项

- better-sqlite3 本地编译版本与 Node 失配（NODE_MODULE_VERSION 130 vs 115），T1 的 rebuild 会修复；若 CI 环境无此问题则跳过
- `wiki:resolveLink` 已存在但前端无调用方，T3 会接入并改由 WikiLinkService 实现
- WikiPageEditor 的手写 YAML 解析器与 js-yaml 行为不一致，T3 删除
