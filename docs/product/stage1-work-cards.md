# Stage 1 施工需求卡 · 可信交付闭环（v1.0）

> 文档性质：**可施工需求卡**（非 PRD，范围仅覆盖 Stage 1）
> 上游依据：`docs/product/2026-11-13-market-research-and-direction.md` §6 Stage 1
> 状态账：落地后回写 `docs/architecture/session-map-blueprint.md`
> 版本：v1.0 / 2026-11-13 / 作者：产品（司南）
> 排期口径：10 个工作日（不含 CI 首轮修红的外部等待）

---

## 0. 本阶段目标与退出条件

**目标**：让一次 Agent 交付从「点了就跑」变成「跑完有据、可判通过与否」。

**退出条件（三条全绿才算完成，缺一不得进入 Stage 2）**：

| # | 退出条件 | 验证方式 |
|---|---|---|
| E1 | 新用户 10 分钟内完成「建节点 → 派发 → 看证据 → 判验收」 | 录屏 + 3 人可用性测试 |
| E2 | 任一 run 都能回答四问：改了什么 / 越界没有 / 测了没有 / 没覆盖什么 | 抽查 5 个 run 的证据面板 |
| E3 | CI 单测为硬门禁且远端首轮全绿 | Actions 运行链接 |

**范围外（本阶段不做）**：记忆检索面板、相关文件推荐 UI、onboarding、证据包导出、自动更新、i18n 全量清扫、新适配器。

---

## 1. 需求卡总览

| 编号 | 名称 | 优先级 | 预估 | 依赖 | 主要落点 |
|---|---|---|---|---|---|
| FR-S1-01 | 占位节点一键派发（走 workitem 通道） | Must | 3d | 无 | renderer hook + map IPC |
| FR-S1-02 | 节点验收项结构化 | Must | 2d | 无 | shared types + node repo + 迁移 |
| FR-S1-03 | 证据面板 v1（四问） | Must | 3d | FR-02、SG-1 | renderer + evidence 服务 |
| FR-S1-04 | 验收判定与「验收失败节点」 | Must | 3d | FR-02、FR-03 | map IPC + bug repo |
| FR-S1-05 | 口径修正 + 适配器能力矩阵 | Must | 1d | 无 | registry + 文档校验脚本 |
| FR-S1-06 | CI 单测门禁化 | Must | 2d（含修红） | 无 | .github/workflows |

> 关键前提（勘察结论，写卡时已核对代码）：**地图层已具备 `workitem:create` / `workitem:run:start` / `workitem:acceptance:confirm` / `map:node:evidence:list` 全套通道**（`src/main/ipc/map.ts:488/589/670/235`），`acceptance-executor.ts` 已实现 `command` / `file_check` / `manual` 三类确定性判定且 fail-closed。**本阶段是接线与出口，不是重造。**

---

## 2. FR-S1-01 占位节点一键派发

| 项 | 内容 |
|---|---|
| 优先级 | Must |
| 现状 | `handleStartDev`（`src/renderer/canvas/hooks/useNodeOperations.ts:138-168`）只做三件事：切到 Agent 面板、把节点改成 `developing`、`mindmap:buildDevPrompt` 后 `setPendingPrompt()`。**不创建 work item、不启动 run、不自动发送** |
| 问题 | ①README 承诺「点击即启动」不成立；②先改状态后建任务，建任务失败会留下脏状态；③这条路径完全绕过 run/evidence 账本，导致后续证据面板无数据 |

**功能规则**

| # | 规则 |
|---|---|
| R1 | 点击「开始开发」→ 调 `workitem:create`（`anchor_node_id`/`anchor_entity_key` 取当前节点，`acceptance` 取节点验收项）→ `workitem:run:start` → 面板切到该 run |
| R2 | 节点 `placeholder → developing` 只在 run 创建成功后执行；失败保持原状态 |
| R3 | 幂等：同一节点已有 active run 时不新建，提示「已有进行中任务」并定位到该 run |
| R4 | 节点无验收项时允许启动，但 run 标记 `acceptance_source=none`，证据面板显示「无验收项」而非「通过」 |
| R5 | 通道不可用（旧库/开发环境）时降级为现有 `setPendingPrompt`，并 toast 明示「已预填提示词，需手动发送」 |

**验收标准（GWT）**

- **AC-01-1** Given 占位节点含 2 条验收项，When 点击开始开发，Then 500ms 内右侧面板显示该 run 卡片，节点状态为 `developing`，库中新增 1 work_item + 1 work_run
- **AC-01-2** Given 该节点已有 running 状态 run，When 再次点击，Then 不新建 work_run，提示并定位已有 run
- **AC-01-3** Given `workitem:create` 抛错，When 点击，Then 节点仍为 `placeholder`，展示错误 toast，库中无新增记录
- **AC-01-4** Given 节点无验收项，When 派发成功，Then 证据面板显示「无验收项」空态，不显示「验收通过」
- **AC-01-5** Given 通道不可用，When 点击，Then 走降级路径且 toast 文案含「需手动发送」

**接口/数据**：仅消费既有 IPC，无 schema 变更。新增 renderer 侧 `dispatchToAgent(nodeId)` 统一入口，`handleStartDev` 改为其薄封装。

**测试要求**：hook 单测（断言 IPC 调用序列与失败回滚）、e2e 1 条（真实点击 → 断言 run 卡片出现）。

**风险与回退**：若 `workitem:run:start` 在某些适配器下不可用，R5 降级保证可用性；回退开关 `settings.dispatch.useWorkItem = false`。

---

## 3. FR-S1-02 节点验收项结构化

| 项 | 内容 |
|---|---|
| 优先级 | Must |
| 现状 | `GraphNode.acceptanceCriteria?: string[]`（`src/shared/types/graph.ts:91`），持久化为 `nodes.acceptance_criteria` JSON 字符串数组；`work_items.acceptance_json` 已是结构化 + 有迁移先例（`src/main/map-migration/legacy-acceptance.ts`，含 original/migrated 双写与 schema_version）；`acceptance-executor.ts` 支持 `command` / `file_check` / `manual`，超时上限 `MAX_TIMEOUT_MS=600000` |
| 问题 | 节点侧验收项是自由文本，无法被机器判定；与 work_item 的结构化验收不同构，派发时需要临时转换或直接丢弃 |

**数据结构（Schema v1）**

```ts
type AcceptanceItem = {
  id: string
  type: 'command' | 'file_check' | 'manual'
  text: string                    // 人读描述，必填
  required: boolean               // 默认 true
  command?: string                // type=command
  expected?: string               // 期望 stdout 包含（可选）
  timeout_ms?: number             // ≤ 600000
  path?: string                   // type=file_check，必须项目根内
  content_contains?: string       // type=file_check 可选
}
```

**功能规则**

| # | 规则 |
|---|---|
| R1 | 读取兼容：旧 `string[]` 逐条映射为 `{type:'manual', required:true, text:原文}`，**原文本不得改写** |
| R2 | 写入升级：结构化条目写**新列** `nodes.acceptance_items`（JSON 数组）；`nodes.acceptance_criteria` 保持 `string[]` 不变，由 `deriveAcceptanceTexts` 派生人读摘要。**不得**把对象写进 `acceptance_criteria` |
| R3 | 数量上限 20 条；`text` 非空且 ≤ 500 字；`command` ≤ 500 字 |
| R4 | 校验 fail-closed：任一条非法 → 整次保存拒绝，错误信息定位到第 N 条与字段名 |
| R5 | 派发时若节点为结构化验收，直接作为 work_item `acceptance` 传入，不再二次转换 |

**验收标准（GWT）**

- **AC-02-1** Given 旧节点含 3 条字符串验收，When 读取节点，Then 归一化为 3 条 manual 条目，`expected` 与 `text` 均为原文、逐字一致（含前后空白）
- **AC-02-2** Given 用户把第 1 条改为 `command` 并填 `npm test`，When 保存，Then `nodes.acceptance_items` 存结构化 JSON，且该条目被真实执行器判为 pass（互通测试）
- **AC-02-3** Given 第 2 条 `expected` 为空，When 保存，Then 拒绝并提示「第 2 条：命令不能为空」（command）/「期望结果不能为空」（manual），库中数据不变
- **AC-02-4** Given 21 条验收项，When 保存，Then 拒绝并提示上限
- **AC-02-5** Given 结构化节点，When 派发，Then work_item `acceptance` 条目数与节点一致（含 required 标记）
- **AC-02-4** Given 21 条验收项，When 保存，Then 拒绝并提示上限
- **AC-02-5** Given 结构化节点，When 派发，Then work_item `acceptance` 条目数与节点一致（含 required 标记）

**接口/数据**：`acceptanceCriteria` 读法不变（`string[]`）；**新增** `nodes.acceptance_items TEXT`（进 `createSql` + `addColumnSafe`，**不进** `requiredColumns`）。`acceptance_migrations` 表**不需要**——旧数据不迁移，读取时按需归一化。

> **2026-11-13 修订（施工时证伪原方案）**：原计划「`nodes.acceptance_criteria` 存结构化数组」会**丢数据**。
> `graph-repository.ts:116` / `node-repository.ts:75` 用 `safeJsonParse(..., [], isStringArray)` 读取该列，
> 而 `isStringArray`（`shared/type-guards.ts:72`）要求**每个元素都是字符串**：写入对象 →
> 校验失败 → **整个数组退回 `[]`**，验收项在重载后全部消失。另 `isNodeContent`
> （`type-guards.ts:161`）也会连带拒绝整个 content。
> 故改为「双列并存」：`acceptance_items` 是判定依据，`acceptance_criteria` 是派生投影，
> 既有消费方（提示词拼装、画布、导出）零改动。
>
> 存储层的真实成本也修正了：加列会让**手写 `CREATE TABLE nodes` 的测试 fixture 缺列**，
> 本次共 5 个文件受影响（`node-repository / graph / yjs-doc / writeback-rollback / writeback-service-accept`），
> 另 `node-repository.test.ts` 有按**位置下标**断言 INSERT 参数的用例需同步位移。

**风险与回退**：格式双写期保留 `original`，回退脚本可按迁移表还原；回退开关 `settings.acceptance.schemaVersion = 0`。

---

## 4. FR-S1-03 证据面板 v1（四问）

| 项 | 内容 |
|---|---|
| 优先级 | Must |
| 现状 | `FileChangeEvidenceCard.tsx`、`NodeMapPanel.tsx` 已有证据展示；`map:node:evidence:list`、`workitem:evidence:list` 可用；`node_evidence` 表含 `evidence_level/type/ref_json/produced_by`。**但**：越界拦截只经 `violationHandlers` 事件 + `logger.warn`（`scope-guard.ts:265-268`），**未落库**，因此「越界没有」这一问目前无数据源 |
| 问题 | 四问分散在四个面板；空态不诚实（无数据显示「0 失败」）；证据不可追溯到原始 ref |

**功能规则**

| # | 规则 |
|---|---|
| R1 | 四问四区块固定顺序：改了什么 / 越界没有 / 测了没有 / 没覆盖什么；不可折叠隐藏 |
| R2 | 每区块空态必须写「未采集」并说明缺哪个数据源，**禁止用 0 或「无」冒充** |
| R3 | 每条证据可点开到原始 ref（文件行 / 命令输出 / 事件 id / 截图） |
| R4 | 证据与 run 绑定；默认最近一次 run，可切换历史 run；跨 run 不聚合 |
| R5 | 越界区块显示：拦截次数、路径、处置（已回滚 / 已放行 / 未处置） |
| R6 | 「没覆盖什么」= 验收条目中无对应证据的 required 项，逐条列出 |

**新增依赖 SG-1（已就绪，2026-11-13）**：ScopeGuard 拦截记录持久化 → 新建表 `node_scope_violations`（schema v51）。**原方案「写 `node_evidence`（`evidence_type='scope_violation'`）」已证伪并弃用**：① 该表 `evidence_type` 的 CHECK 值域没有这个值，扩值域要重建表；② 更关键，`execution-state.ts` 的 `deriveFromInputs` 里 `has('E2') → state='implemented'`，越界记录落成 E2 会把「越界」读成「已交付」。现方案：独立表只记事实、不参与派生/gate，读取通道 `map:node:violations:list` 返回 `violations[]`（路径列表）+ `disposition`（`pending`/`rolled_back`/`released`）+ `created_at`，R5 的「拦截次数/路径/处置」三项齐备。

**验收标准（GWT）**

- **AC-03-1** Given 一次 run 改了 3 个文件、越界拦截 1 次、执行 2 个测试、验收 2 条中 1 条未覆盖，When 打开证据面板，Then 四区块分别显示 3 / 1 / 2 / 1
- **AC-03-2** Given 该 run 无测试记录，When 打开面板，Then 显示「未采集（缺少测试执行记录）」，不出现「0 失败」
- **AC-03-3** Given 点击某条证据，Then 打开对应文件行或原始输出，且 ref 与库中记录一致
- **AC-03-4** Given 切换历史 run，Then 四区块数字随 run 变化，不混算
- **AC-03-5** Given 越界记录已落库 1 条且处置为「已回滚」，Then 越界区块显示路径与「已回滚」

**测试要求**：组件测试覆盖四空态（无证据/无测试/无越界记录/无验收项）+ 1 条屏幕级 e2e。

**风险与回退**：SG-1 未就绪时面板仍可上线（越界区块显示未采集），不阻塞 FR-01/02 验收。

---

## 5. FR-S1-04 验收判定与「验收失败节点」

| 项 | 内容 |
|---|---|
| 优先级 | Must |
| 现状 | `workitem:acceptance:confirm`（`src/main/ipc/map.ts:670`）+ `AcceptanceConfirmationService` 已存在；`acceptance-executor` 能确定性判 command/file_check；`bug_nodes` + `BugRepository` 可建节点；`test-executor.ts` 已能在测试失败时自动建 bug。**缺**：节点级判定入口、判定三态口径、失败节点由判定驱动、人工覆盖留痕 |
| 问题 | 验收结果停在 work item 内部，图上无反馈；Bug 与「验收未过」语义混同 |

**判定口径（必须唯一，不许各处自算）**

| 判定 | 条件 |
|---|---|
| 通过 | 全部 `required` 条目 ok（manual 条目需人工勾选，未勾选不算通过） |
| 部分通过 | 至少 1 条 required ok，且至少 1 条未过或未覆盖 |
| 不通过 | required 全部未过 / 证据缺失 / 执行器 fail-closed 失败 |

**功能规则**

| # | 规则 |
|---|---|
| R1 | 判定入口在证据面板底部，三按钮；判定前必须已加载该 run 证据 |
| R2 | 判定为部分/不通过时，在图上创建子节点：`type=bug`，`title=验收未过：<节点标题>`，`parentId=原节点` |
| R3 | severity 映射：所在图为资金/安全域 → `critical`；其余 required 失败 → `high`；仅可选条目未过 → `medium` |
| R4 | 幂等：同一 work_item 同一 revision 只建 1 个失败节点（唯一约束 `graph_id + entity_key + revision`） |
| R5 | 人工覆盖（把不通过改为通过）必须填理由 ≥ 10 字，写入证据账本，可在审计视图查到 |
| R6 | **禁止无证据判通过**：证据缺失时「通过」按钮禁用并说明缺什么 |

**验收标准（GWT）**

- **AC-04-1** Given 2 条 required，1 通过 1 失败，When 点「不通过」，Then work_item 状态为 partial，图上新增 1 个 bug 子节点且 `severity=high`
- **AC-04-2** Given 同一 work_item 已判定过一次，When 再次判定，Then 不新增第二个失败节点（库中该 revision 仍为 1 条）
- **AC-04-3** Given 证据缺失，When 查看面板，Then「通过」按钮禁用并显示缺失项清单
- **AC-04-4** Given 人工把不通过改判通过但理由为空，When 提交，Then 拒绝并提示
- **AC-04-5** Given 改判成功，When 打开审计视图，Then 可见判定人、时间、理由、原判定

**接口/数据**：新增 `workitem:verdict:set`（或复用 `acceptance:confirm` 扩展 `verdict` 字段）+ `bug:create` 调用；失败节点唯一约束需 migration。

**风险与回退**：避免与 `test-executor` 自动建 bug 重复——同一 `entity_key + revision` 下若已存在 bug 节点则复用不新建。

---

## 6. FR-S1-05 口径修正 + 适配器能力矩阵

| 项 | 内容 |
|---|---|
| 优先级 | Must |
| 现状 | `src/main/adapters/registry.ts` 有描述符与市场数据；深度能力实际只覆盖 claude-code / codex / opencode / mcp 四个，其余 6 个是 one-shot 薄封装（63 行级） |
| 问题 | README 与 UI 均未标注能力差异，「支持 11 种」造成预期落差；团队采购第一件事就是核对能力边界 |

**功能规则**

| # | 规则 |
|---|---|
| R1 | 描述符新增 `capabilities: { streaming, approval, resume, diffEvidence, subagent, compact }`（布尔） |
| R2 | 能力矩阵面板**读 registry**，不允许前端硬编码 |
| R3 | README 能力表与 registry 一致，由 `scripts/verify-adapter-capabilities.mjs` 断言，进 lint job |
| R4 | 文案纪律：不得出现「全部支持写前审批」「均可回滚」等全称表述；薄适配器卡片必须有「能力受限」标记 |
| R5 | 能力矩阵每条给出判据一句话（如 approval：有真实拦截通道，非写后记账） |

**验收标准（GWT）**

- **AC-05-1** Given 打开设置 → 适配器页，Then 每个适配器显示 6 项能力，达标绿 / 未达标灰
- **AC-05-2** Given 把 registry 中某适配器 `approval` 改为 false 而 README 未改，When 跑 `npm run verify:capabilities`，Then 失败并指出不一致行
- **AC-05-3** Given 阅读 README，Then 无「均/全部/都」类全称能力表述（脚本正则断言）

---

## 7. FR-S1-06 CI 单测门禁化

| 项 | 内容 |
|---|---|
| 优先级 | Must |
| 现状 | `.github/workflows/ci.yml`：`unit` job `continue-on-error: true`，注释写明「观测一轮全绿后删除」；`lint` job 已是硬门禁（eslint / tsc / verify:blueprint） |
| 问题 | 单测红不阻断合并；当前 HEAD 领先 origin/main **6 个提交**（`git rev-list --left-right --count`，2026-11-13 实测），这 6 个提交从未在远端跑过 CI；`gh` 未登录，本阶段基线只能先在本地复刻 |

**功能规则**

| # | 规则 |
|---|---|
| R1 | 先 `workflow_dispatch` 跑一次完整 unit，产出基线报告 |
| R2 | 红灯必须三分类：**真红**（代码问题，必修）/ **环境红**（宿主/依赖，修环境或显式 skip + 理由）/ **负载红**（worker 超时，降并发） |
| R3 | 真红全修；环境红 skip 必须带 `// reason:` 注释并在基线报告登记；负载红把 `maxWorkers` 固定为 4 |
| R4 | 基线全绿后才删除 `continue-on-error`；删除 PR 附远端绿运行链接 |
| R5 | 门禁后新增规则：PR 中单测新增失败不得合并（由 CI 自然保证） |

**验收标准（GWT）**

- **AC-06-1** Given 一个故意让单测失败的 PR，When 推送，Then CI 红且 PR 不可合并
- **AC-06-2** Given main 分支最新提交，Then unit job 绿且无 skip 未登记
- **AC-06-3** Given 基线报告，Then 每条红灯都有分类与处置结论（无「待定」）

**风险**：首次真跑可能大面积红（Linux 上 `ps`/路径类用例），需预留 2 天。修不完时**不得**先删 `continue-on-error`，宁可延后 Stage 1 退出。

---

## 8. 依赖就绪度

| 依赖 | 所属 | 状态 | 分级 | 最晚就绪 | 缺失影响与替代 |
|---|---|---|---|---|---|
| workitem/evidence/acceptance IPC | map 层 | 已就绪 | — | — | — |
| acceptance-executor 三类判定 | map 层 | 已就绪 | — | — | — |
| **SG-1 越界记录落库** | ScopeGuard | **已就绪（2026-11-13，schema v51）** | 已解除（FR-03 R5 可直接施工） | D5 | 回退：`DROP TABLE node_scope_violations` + 面板降级「未采集」 |
| registry 能力字段 | adapters | 未就绪（改动小） | 并行 | D7 | 可先用静态 JSON 表兜底，但 R2 不满足 |
| CI 远端运行权限 | GitHub | 可用 | 并行 | D9 | 不可用则 Stage 1 退出条件 E3 无法达成，需改为本地全量绿 + 下一阶段补 |

---

## 9. 排期（10 个工作日）

| 日 | 事项 | 产出 |
|---|---|---|
| D1 | FR-02 数据结构与迁移（先做，因 01/03/04 都依赖） | types + repo + migration 单测 |
| D2–D3 | FR-01 派发接线 + 失败回滚 | hook 单测 + e2e |
| D3–D4 | ~~SG-1 越界落库~~（已完成 2026-11-13） | 独立表 `node_scope_violations` + 生命周期钩子 + IPC 只读通道 + 13 例单测 |
| D4–D6 | FR-03 证据面板四问 | 组件测试 + 空态四例 |
| D6–D8 | FR-04 判定与失败节点 | 判定口径单测 + 幂等测试 |
| D8 | FR-05 能力矩阵 + 校验脚本 | README 同步 |
| D9 | FR-06 CI 基线首跑 + 分诊 | 基线报告 |
| D10 | 修红 + 删 `continue-on-error` + 退出评审 | 绿链接 + 评审记录 |

---

## 10. 需求追踪矩阵（RTM）

| 需求 | 卡片 | 验收 | 指标 | 状态 |
|---|---|---|---|---|
| 占位节点真派发 | FR-S1-01 | AC-01-1..5 | 闭环时长 | 待开发 |
| 验收可机器判定 | FR-S1-02 | AC-02-1..5 | 证据覆盖率 | 待开发 |
| 四问可回答 | FR-S1-03 | AC-03-1..5 | 证据覆盖率 ≥90% | 待开发 |
| 判定可追溯 | FR-S1-04 | AC-04-1..5 | 无证据判通过 = 0 | 待开发 |
| 能力不虚标 | FR-S1-05 | AC-05-1..3 | 口径一致性 | 待开发 |
| 门禁有效 | FR-S1-06 | AC-06-1..3 | 远端首轮绿 | 待开发 |

**两个反向指标（红线）**：越界拦截后仍被合并 = 0；无证据却被标「已验收」= 0。

---

## 11. 变更控制与评审

- 本阶段**不接受新增需求**；新想法一律进「Stage 2+ 候选池」，由下一轮排序。
- 单条需求若预估超 1.5 倍，先剪范围（例：FR-03 可先砍「历史 run 切换」到 Stage 2）。
- 评审按 `assets/review-roles.md` 三视角：产品（可测性）、研发（接口契约与迁移风险）、测试（边界与资金/安全域用例）。

**出稿自检**：本文件 6 张卡均含「现状证据 / 规则 / GWT / 测试 / 风险回退」五要素；每条 AC 可被测试用例直接引用；无「尽快/优化/友好」类模糊词。

---

> 声明：本文件为产品设计参考，具体实施请结合公司合规与法务要求确认；竞品与市场数据见上游调研文档，引用日期 2026-11-13。
