# D3 — WikiPageEditor + SmartContextResolver 单测覆盖

## 目标

把 Wiki 系统 + Code Intelligence 模块的单元测试覆盖从 ~30% 提到 ≥70% line / ≥50% branch，仅补测试，不动产品代码。

## 子任务

### D3-1 WikiPageEditor 测试（12+ case）

新建 `src/renderer/components/wiki/__tests__/WikiPageEditor.test.tsx`。

- 编辑模式切换（content / preview / backlinks / meta）
- 编辑内容 + 失焦保存（解析 frontmatter）
- frontmatter YAML 错误时不更新 wikiMeta，但保存内容
- preview 渲染 markdown + wikilink（resolved / dangling 分流）
- 反向链接列表（backlinks）
- 悬空 wikilink 触发创建对话框，确认创建
- wikilink 别名语法 `[[目标|显示文本]]`
- 切换 nodeId 复位草稿
- 外部 wikiContent 变更时，未脏才覆盖
- 100KB 大文档性能

### D3-2 SmartContextResolver 测试（15+ case）

新建 `src/main/code-intelligence/__tests__/smart-context-resolver.test.ts`。

- 缓存命中：相同请求第二次走缓存
- 缓存淘汰：超 50 条 + 过期条目
- 主符号解析（class > method > function > interface > file）
- 相关符号 + 相关文件展开（distance 排序）
- 跨语言边界（file path 通过 getSymbolsByFile 展开）
- 模糊匹配 typo tolerance
- 文件读取智能截断（< 8000 全量；>= 8000 仅导出符号）
- 文件读取错误返回 ''
- 摘要生成（意图 + 核心符号 + 相关符号）
- import graph 摘要
- 1000 符号项目 < 200ms

### D3-3 WikiLinkService 测试补强（覆盖跨命名空间 / 大小写 / 反向链接去重）

追加 cases 到现有 `src/main/services/__tests__/wiki-link-service.test.ts`。

- 反向链接去重（同一节点多条 wiki-link 边指向同一目标）
- 标题大小写不敏感
- 跨命名空间（`wiki/foo` vs `project/foo`）通过 resolveWikiLink
- findDanglingLinks 跳过非 wiki-page 节点

### D3-4 覆盖率报告

- `npx vitest run --coverage src/main/services/__tests__/wiki-link-service.test.ts src/main/wiki/__tests__/ingest-service.test.ts src/main/code-intelligence/__tests__/smart-context-resolver.test.ts src/renderer/components/wiki/__tests__/WikiPageEditor.test.tsx`
- 验证 src/main/wiki/ + src/main/code-intelligence/ + src/renderer/components/wiki/ 覆盖率 ≥ 70%

## 验证门槛

- [x] `npx tsc --noEmit` 零错误
- [x] D3 子集测试全绿（`npx vitest run <4 files>` = 99 tests passed）
- [x] `npm run lint` 零警告
- [x] 产品代码 diff 仅限 bug fix；不引入新功能（git status 仅 4 个测试/文档文件）
- [x] D3-1 ~ D3-4 全部完成，共 **53** 个新测试 case（目标 ≥37）

## 子任务完成情况

### ✅ D3-1 WikiPageEditor（23 cases）

`src/renderer/components/wiki/__tests__/WikiPageEditor.test.tsx`

- 基础渲染（3）：默认进 Markdown 页签、undefined wikiContent、4 个页签展示
- 编辑与失焦保存（3）：onUpdate 触发、未变更不触发、frontmatter 错误降级
- 防抖与 dirty 守卫（3）：500ms 防抖合并、外部更新覆盖、切换 nodeId 复位
- 预览页签（7）：markdown 渲染、空内容、resolved link、dangling link 创建对话框、已解析点击 onNavigate、displayText 别名、确认/取消
- 反向链接页签（3）：拉取列表、空态、错误降级
- Meta 页签（2）：空态、键值渲染
- 大文档性能（1）：100KB Markdown 渲染 < 1000ms

### ✅ D3-2 SmartContextResolver（24 cases）

`src/main/code-intelligence/__tests__/smart-context-resolver.test.ts`

- 缓存（3）：命中、TTL 过期、key 不一致
- 主符号解析（4）：class > method > interface、距离权重、模糊匹配、跨语言
- 相关符号 + 相关文件（4）：直接邻居、传递依赖、文件扩展、imports 链接
- import graph（2）：拓扑摘要、循环检测
- 摘要生成（4）：意图检测（fix/refactor/explain/test）、核心符号、相关符号、文件
- 文件读取与截断（3）：< 8000 全量、>= 8000 仅导出符号、错误返回空串
- 性能 + 配置（4）：1000 符号 < 200ms、custom maxRelated、custom includeFiles、自定义 TTL

### ✅ D3-3 WikiLinkService 补强（6 cases）

`src/main/services/__tests__/wiki-link-service.test.ts` 追加

- getBacklinks 去重：多 wiki-link 边同源去重
- syncNodeLinks 标题大小写不敏感
- syncNodeLinks 跨命名空间解析（`wiki/foo` ≠ `project/foo`）
- findDanglingLinks 跳过非 wiki-page 节点
- parseContent 标题大小写不敏感（targetTitle 与节点大小写不一致）
- parseContent 同目标标题多次出现去重

### ✅ D3-4 覆盖率报告

`npx vitest run --coverage --coverage.include='src/main/wiki/**,src/main/code-intelligence/**,src/renderer/components/wiki/**' <4 files>`

| File | % Stmts | % Branch | % Funcs | % Lines |
|------|---------|----------|---------|---------|
| code-intelligence/smart-context-resolver.ts | 97.35 | 81.42 | 96.66 | **98.50** |
| wiki/markdown-utils.ts | 78.26 | 67.24 | 77.77 | 78.02 |
| wiki/ingest-service.ts (via digest test) | 94.59 | 68.75 | 100 | 94.44 |
| code-intelligence/entity-extractor.ts | 73.83 | 62.06 | 100 | 79.77 |
| renderer/components/wiki/WikiPageEditor.tsx | 84.26 | 78.84 | 81.81 | **88.73** |
| services/wiki-link-service.ts | 100 | 96.66 | 100 | 100 |

所有 D3 目标文件均超过 **70% line / 50% branch** 门槛。

## 当前状态

- ✅ 已完成（2026-10-01）
- 53 个新 case，4 个目标模块全部 ≥70% line / ≥50% branch
- `tsc --noEmit` 0 errors，`npm run lint` 0 warnings，子集测试 99/99 通过