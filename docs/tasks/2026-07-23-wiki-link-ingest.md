# Wiki 链接全链路 + Ingest 管线 · 任务跟踪

> 创建：2026-07-23
> 设计文档：[../superpowers/specs/2026-07-23-wiki-link-ingest-design.md](../superpowers/specs/2026-07-23-wiki-link-ingest-design.md)

## 当前状态

**完成** — 全部 5 个任务已交付（T3+T4 质量审查 6 项修复于 ca5830b 落地并复审通过）

## 目标

打通 wikilink 全链路（解析 → 落边 → 反向链接 → 断链检测），实现规则式文件导入管线，建立本任务跟踪机制。

## 任务清单

- [x] T1: `npm rebuild better-sqlite3` + 测试基线修复（chore）— 含 3 处存量缺陷修复，见决策记录
- [x] T2: EdgeType 增加 `wiki-link` + WikiLinkService + IPC 落边钩子（feat）
- [x] T3: IPC 新通道（parseContent / getBacklinks / ingestFiles / findDangling）+ WikiPageEditor 重写（feat）——wiki:ingestFiles 通道注册由 T4 实现接入
- [x] T4: Ingest 管线 + 导入 UI 入口（feat）
- [x] T5: 本任务文档收尾 + CLAUDE.md 补充 Wiki 机制说明（docs）

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
- 2026-07-23（T1）：rebuild better-sqlite3 后暴露 11 处存量测试失败，逐一修复：① DarwinProvider.isSystemPath 误拦 macOS tmpdir（/var 是符号链接，只应拦截 root/db/log/tmp 等真实系统子目录）；② chat_threads/chat_messages 缺少 token_count、waterline 等 5 列的增量迁移；③ safeRealpath 对不存在路径的 ENOENT 回退保留符号链接，导致嵌套路径 containment 校验误判——新增 resolveNearestExistingAncestor 逐级向上 realpath；④ cachedRealpath 测试断言与 macOS /var→/private/var 符号链接行为不兼容，改为与 fs.realpath 比较。T2 的落边钩子改挂 IPC 层（src/main/ipc/graph.ts）而非 GraphService——IPC handler 直接调用 nodeRepo，未走 GraphService
- 2026-07-23（T2）：WikiLinkService 落地——syncNodeLinks diff 落边（悬空链接不入库）、parseContent 实时解析、getBacklinks、findDanglingLinks；resolveWikiLink 改同步签名；IPC 层 node:create/createBatch/update 挂落边钩子，edge:create 拒绝手工 wiki-link 边
- 2026-07-23（T2 审查）：node:createBatch 逐节点 syncWikiLinks 为 O(N²) 全图扫描（每次 listByGraph）——单次数十节点可接受；T4 Ingest 批量导入若达数百节点需优化（批量同步接口或缓存 listByGraph），届时处理
- 2026-07-23（T3）：Wiki 类型上移 @shared/types/wiki（service re-export 保持导入兼容）；新增 wiki:parseContent/getBacklinks/findDangling + dialog:openFiles 通道；WikiPageEditor 重写——预览为 GFM 渲染 + 独立链接交互区（[[link]] 代码样式占位防 markdown 切碎），失焦保存同时落 frontmatter，特殊页禁止删除
- 2026-07-23（T4）：IngestService 落地——标题三级回退、同名追加（来源分隔线）、批量先建后链（同批互链可解析）、单文件失败不阻塞；IPC 批量上限 100（对应逐节点 sync 的 O(N²) 性能债）；graphStore 过滤 wiki-link 边不进画布；导入 UI 走画布右键菜单 + 结果横幅
- 2026-07-23（T3+T4 质量审查）：6 项 must-fix——①IngestService 第二遍落边缺容错（单节点失败会拖垮整批）；②WikiPageEditor 外部更新会覆盖未保存草稿；③handleCreatePage graphType 静默 fallback 'online' 有在 dev 图错建风险；④⑤补充 ingestFiles 成功路径 / importWikiFiles 重载测试；⑥ingest 同名匹配的大小写策略未注释化（已核实与 resolveWikiLink 一致：均 `normalizeWikiTitle(x).toLowerCase()`，必须保留）。另有 2 项 minor 顺带修复
- 2026-07-23（T3+T4 质量修复）：ca5830b 落地全部 6 项 must-fix + handleBlur sentDraft 防竞态；新增 3 测试（落边容错、大小写不敏感同名追加行为锁、ingestFiles 端到端），复审 ✅ 通过。全量 170 files / 1793 tests 全绿
- 2026-07-23：T5 完成，CLAUDE.md 补充 Wiki System 架构说明，本任务收尾

## 会话恢复指南

**如果会话中断，从这里继续：**

1. 读设计文档（上方链接）了解全貌
2. 看本文件「任务清单」找到第一个未完成项
3. 看「决策记录」了解已定边界，不要重新讨论
4. 当前步骤：全部完成。后续阶段（LLM Ingest、Louvain 图计算、Graph Lint）见记忆 [[llm-wiki-stepwise-plan]]

## 已知注意事项

- better-sqlite3 本地编译版本与 Node 失配（NODE_MODULE_VERSION 130 vs 115），已通过 `npm rebuild better-sqlite3` 修复；若 CI 环境无此问题可忽略
- macOS 上 `os.tmpdir()` 返回 /var/folders/...，fs.realpath 解析为 /private/var/folders/...——涉及 tmpdir 的路径断言一律与 realpath 结果比较，勿用 path.resolve
- `wiki:resolveLink` 已存在但前端无调用方，T3 会接入并改由 WikiLinkService 实现
- WikiPageEditor 的手写 YAML 解析器与 js-yaml 行为不一致，T3 删除
- T3/T4 并行派发导致 T4 的 wiki:ingestFiles handler + IPC 测试被 T3 的 commit 79ce623 吸收——教训：不可并行派发实现子代理（subagent-driven-development 明确禁止），后续任务串行执行
