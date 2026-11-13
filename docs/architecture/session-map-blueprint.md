# 会话地图与任务编排蓝图（Session Map Blueprint）— 设计定稿 v2.3 / 状态账 v3.33

> 版本：**设计定稿 v2.3 + W5 阶段 A/B/C/D 成果回写；状态账已迭代至 v3.33**（变更记录见下方 `> v2.4` 起各条）
> 生成时间：**2026-11-09（Asia/Shanghai）；状态账最后核验 2026-11-13**
> 状态：设计定稿。v2.1 补齐 34 条「仅建议」施工级设计与 17 条待裁决细则；v2.2 回写 D-01…D-17 裁决并解除 13 条阻塞；**v2.3 把已落地的 W1–W5 成果同步进状态词（61 → 64 条已实施，25 → 22 条已批准未实施），并记录 `RequestQueue` 已删除、W5-D 评测 harness 与打包验证落地**。严格区分：裁决只定方向，**不产生施工授权**——32 条仍为「仅建议」，17 条仍为「未授权施工」，均不升格。
> v2.4（2026-11-10）：G9-10 worktree 定时清理、G2-14 明细视图、G2-13 published 软阻断三条仅建议项落地；已实施 75 → 78，仅建议 32 → 29。
> v2.5（2026-11-10）：G1-14 提案机制三层（含 G2-6/G2-19/G8-4）、G2-1 模式库 + `mode_id`、G7-5 MCP 写前审批、G11-10 `tree_hash` 落地；已实施 78 → 85，仅建议 29 → 23。实施中的暂时妥协登记在 I.9.3。
> v2.6（2026-11-10）：G1-9 E4 覆盖变化扫描（v43）落地；已实施 86，已批准未实施 9。E4 的「到期」与「覆盖变化」保持两条独立判据，变化统一 stale 并用 `stale_reason` 区分内容/范围。
> v2.7（2026-11-10）：G2-3 `memory_hits` 记录表（v44）落地（表 + 幂等唯一索引 + 180 天/单项目 20 万保留治理）；已实施 87，仅建议 22。写入方（Layer1）仍归 G2-2。
> v2.8（2026-11-10）：G2-2 进化 Layer1（v45）落地——五个 run 终态采集 step/evidence/deviation 引用并记录 `source_outcome`；已实施 88，仅建议 21。`context` 暂不产（I.9.3 妥协）。
> v2.9（2026-11-10）：G2-4 Layer2 派发精度归因（v46）落地——只读视图 `v_memory_attribution` 强制经 `node_session_links.session_origin='map_task'` 归因；已实施 89，仅建议 20。
> v3.0（2026-11-10）：G3-2 run 级跨进程项目写闸落地——复用 `AgentRuntime` 同一个 workspace lease registry（不新建 `project_locks` 表），claim 前抢占、settle 后释放、抢不到 fail-fast；逐 turn 互斥此前已存在。已实施 90，仅建议 19。
> v3.1（2026-11-10）：G7-7 C3 exec 面收敛——`/bin`、`/usr/bin`、`/usr/sbin`、`/usr/libexec` 改为 literal 级放行（shell/env/xcrun + 白名单命令 + node/npm/npx 的规范路径）；git 从「整根 CLT」收敛为 git-core（subpath）+ git 本体（literal）；删除无调用方的 `/usr/bin/arch`；网络类命令排除，名单快照与真实 harness 纳入测试；明确「审批放行 ≠ 沙箱可执行」。已实施 91，仅建议 18。
> v3.2（2026-11-10）：G6-17 同 uid 防御边界落地（**文档级**）——`agent-architecture.md` §6.5.1 成段写明跨 uid 承诺、同 uid 不承诺、攻击者门槛、不构成提权；不做运行时检测。已实施 92，仅建议 17。
> v3.3（2026-11-10）：G2-18 完整步状态机落地——`work_steps` **12 值**声明式迁移表（`WORK_STEP_TRANSITIONS` + 写库前 `assertDeclared`）、补 `waiting_approval → timed_out`、`review` 标注无生产写入方、步级 `work_step_changed` 事件在 5 处构造点全接；改正本文「13 值」笔误。已实施 93，仅建议 16。
> v3.4（2026-11-10）：G2-8 WaveExecutor、G2-17 多 Agent 交互记「**已裁决·不做**」——D-07 已定并发上限 1 / 不排队 / 串行多会话，实现形态与现状等价（II-10、II-19 自身已写明）；G2-9 黑板/fanout 保留「仅建议（暂不投）」，注明与 `memory_hits` 重叠及串行下 fanout 语义消失。已实施 93，仅建议 14，已裁决 20。
> v3.5（2026-11-10）：G3-1 Tier1 探测落地——`tier-probe.ts` 解析 `{tier, resume, approval_callback, structured_output, cancel, probe_error}` 并进程内缓存；tick 路由与写通道均只接受 Tier 1，其余落 `TIER_UNSUPPORTED`/`routing_failed`；`routing_decisions` 记能力票与缺项。已实施 94，仅建议 13。
> v3.6（2026-11-10）：G7-8 非 Claude 裸 spawn 落地「显式声明 + 能力位降级 + UI 说真话」——`map:execution:status` 返回 pinned adapter 的 Tier/缺项，非 Tier 1 直接置 `enabled=false` 并说明「只能裸 spawn（只读或人工排期）」；`agent-architecture.md` §17.5/§17.6 明确编排写路径与普通节点会话的边界。已实施 95，仅建议 12。
> v3.7（2026-11-10）：G5-10 项目进度查询落地——只读视图 `v_project_progress`（schema v47）+ `map:project:progress` 只读通道；按项目聚合节点/任务/证据分级，未知项目返回 `available=false`。已实施 96，仅建议 11。
> v3.8（2026-11-10）：G2-15 dirty diff 落地——`change_sets` 增 `dirty_files_count`（v48，`NULL`=无未提交改动或未采集、`-1`=采集失败），采集时算 `dirty_tree_hash` 指纹并去重；采集失败显式标 `-1`，不再把失败读成 0。已实施 97，仅建议 10。
> v3.9（2026-11-10）：G2-16 离线校准落地——`maybeRunCalibration` 按「新增 ≥20 run 或满 2 周」出 `map_migration_reports(kind='calibration')` 聚合报告（v49 扩 CHECK），样本 <20 不出报告；只写报告行，不改阈值/权重。已实施 98，仅建议 9。
> v3.10（2026-11-10）：G2-11 流程级测试最小版按**集成测试**收口（`flow-test-integration.test.ts`）：flow spec 两步全过/一步失败两条全链用例，覆盖 `test_results`/`test_runs` 聚合、E3/E2 回写、失败建 bug + 元数据回链。**不做** flow 计划生成与 `selected_by='flow'` CHECK 扩张（剩余 4–5 人日另计）。已实施 99，仅建议 8。
> v3.11（2026-11-10）：G8-5 任务卡深度落地（`TaskCardTree.tsx`）——「任务 → 步 → run → 证据」四层折叠，默认折叠到任务级，展开态只存内存不落库；证据按 `work_run_id` 归到 run、无 run 归属的留在任务级，其他任务证据不混入。**纯渲染派生**，未改数据模型、未新增表/列。已实施 100，仅建议 7。
> v3.12（2026-11-10）：G2-10 C1–C4 确认点落地（D-18/D-19/D-20 为 D-13 的补充）——确认闸只建在 `test`/`human` 步上，高风险线复用 G4 的 20 文件 / 800 行（`risk_level` 仍两档，不造第三档）；approve 落 `acceptance_confirmations`（`entry_id`=C3/C4），reject 走 `input_request_json`；C1/C2/C3/C4 必填展示项缺失即由服务层拒绝。**未新建表、未做 v50**；`agent_approvals` 不再承载人工确认（v35 已废止）。已实施 101，仅建议 6。
> v3.13（2026-11-10）：G8-3 C1–C4 渲染落地（`StepConfirmationPanel.tsx`）——任务卡内按步展示 C3「测试计划确认」/ C4「完成认定」：为什么要确认（trigger）、风险等级与**后端给出的**原因文本、必填展示项、以及已发生的决策（通过/驳回、决策人、备注）；低风险且无决策的步不渲染，任务级给「待确认」角标。**只读渲染，不复算风险等级、不改数据模型**；C1/C2 因 renderer 尚无计划草稿/修订界面，未做面板。已实施 102，仅建议 5。
> v3.14（2026-11-10）：G8-3 出口补齐——C3/C4 面板加「通过 / 驳回」按钮接 `map:confirmation:decide`（四个错误码全量中文化，成功后不改本地状态、靠 broadcast 重拉）；`map:confirmation:status` 增 `display` 服务端投影（C3 取 `test_plans`/`test_plan_items`/`test_specs.timeout_ms`，C4 取 `node_execution_state`/`node_evidence`/`acceptance_confirmations`/`evidence_suggestions`/`nodes.status`），必填展示项缺失则禁用按钮。**未改 schema、未新增表/通道**。C1/C2 界面仍未开工（前置见 I.8.F，8–12 人日，未排期）。已实施 102，仅建议 5。
> v3.15（2026-11-10）：I.8.F P1（C1 计划草稿确认）落地——`plan-draft-precheck.ts` 把草稿 item 投影为合成 `WorkItemRow` 后交给**生产同一个** `createGateEngine`（同一份 `readG4Config()` + `buildEstimateLines()`），G1/G2/G3/G4/G6 缺失码原样输出，G5 因草稿依赖是 plan key 显式跳过并登记原因；同时补齐 `candidateScore`（`boundary_candidates` 按 `derivation_run_id`）、`anchorStates`（join `node_execution_state`）、`excludedItems`（`rejected_boundaries_json`，该列当前无写入方，如实给空）；新增只读通道 `plan:draft:preview` / `plan:draft:list` 与写通道 `plan:draft:submit`（`createDraft` 落 `draft`、`confirm` 只接受 `awaiting_confirm`，此前无 submit 通道，新草稿永远确认不了），`PlanDraftPanel.tsx` 接 `plan:draft:submit` / `plan:draft:confirm` / `plan:draft:reject`（`display` 原样展示、原样回传，错误中文化，成功后重拉列表）。**未改 schema、未放宽 `assertConfirmationDisplay`、未改动 gate 判定逻辑**。P1 面板完成，P2（C2 修订 diff）仍未排期（v3.18 补注：C1 当前无数据源，定性见 I.8.F / I.8.2）。已实施 102，仅建议 5。
> v3.16（2026-11-10）：I.8.F P2（C2 修订 diff）落地——新增只读通道 `workitem:history`（按 lineage 读全部 revision，旧行本就保留，不改 `is_current` 语义）与 `workitem:diff`（`to` 对比历史两版；`proposed` 对旧 revision vs 拟修订内容）；字段级 before/after 与 `impact` 三项**全部服务端计算**，renderer 只渲染。`impact` 只做可推导部分：写域 `scope_files` 集合差、验收条目按 id 配对、依赖 `depends_on_json` 增删；「文件是否真会被改动 / 哪些 run 失效 / 哪些证据 stale」无数据来源，显式标 `missing`。`workitem:revise` 补 `reason` / `dependsOn` 入参并在 preload 补写通道白名单（此前 renderer 根本调不到该通道），`WorkItemRevisionPanel.tsx` 接同一写路径，不新造写路径。修订原因尝试落 `map_migration_reports(kind='workitem_revise')`，但该表 `kind` CHECK 值域不含此值，**未扩 CHECK、未做 v50**，界面如实显示「未留痕」。**C2 只能表达单任务字段级修订，表达不了蓝图定义的「新增/删除/合并/拆分」**；「run 失效 / 证据 stale」联动仍无数据来源（半实现），见 I.9.3。已实施 102，仅建议 5。
> v3.17（2026-11-11）：preload 白名单一致性护栏落地——新增 `ipc-preload-allowlist.test.ts`：以主进程 `typedHandle('<channel>')` 调用点为注册事实（并断言 `ipcMain.handle` 只出现在 `ipc/utils.ts`），与 preload `exposedChannels`（含 `MAP_READ_ONLY_CHANNELS` 展开）做集合断言；未暴露通道必须逐条进入显式豁免名单（读通道 / 写通道分两张表，均须写明原因），报错逐个列出通道名 + 注册位置；另加「renderer 实际调用的通道必须已暴露且已注册」断头检测。**本次未补任何白名单**：除已修三处（`map:confirmation:decide` / `plan:draft:submit` / `workitem:revise`）外另发现 9 个已注册未暴露通道（3 条 S7 延后 / 2 条刻意不暴露 / 4 条漏接线，均无 renderer 调用方、不存在活断头），作为已知缺口登记，等待逐条裁决。I.8 补记「下次 schema 变更机会」；I.9.3 补全 C2 边界四条。计数不变：**条目侧** 102 + 9 + 5 + 0 = **116**；**裁决侧** 23 条；**去重总量 139**（116 + 23，且与 155 − 16 对账）。
> v3.18（2026-11-11）：口径修正（只改文档）——I.8.F 的 C1 从「界面可用」改为「仅面板 + gate 预检投影，当前无数据源、用户可见价值为零」：`plan_drafts` 唯一 `INSERT` 在 `createDraft`，唯一调用方是未暴露的 `plan:draft:create`，agent 路径也不写这张表，`plan:draft:list` 无数据、C1 列表恒空；定性为 **S7 预案 UI，不是 L1 人工入口**（L1 手工建任务走 `workitem:create`）；`reject` 是终态、`revise` 是唯一回退路径，而 `plan:draft:create` / `plan:draft:revise` / `plan:derive-candidates` 均未暴露，界面「驳回」是单向死路。I.8.2 新增「手工连边交付不完整」（`map:link:create` 漏接线、`map:link:delete` 无 handler）与 9 条已知缺口完整分类（3 条 S7 延后 / 2 条刻意不暴露 / 4 条漏接线；均无 renderer 调用方，故不存在活断头）。**未改代码、未补白名单、未造写入方、未补 handler**；计数不变：条目侧 116 / 裁决侧 23 / 去重 139。同批清理 I.1 概述、I.1 G8-3 行、I.9.3 G8-3 行与 II-29 中「待计划草稿 UI」「C1/C2 待对应界面」「C1 可在面板内走通」等残留表述，统一改为「C1 面板已交付但无数据源，卡在 S7 起草入口」。
> v3.19（2026-11-11）：**对照代码与提交历史的全量核验**（不是文档自洽检查）。改了什么：
> ① **G8-2 补齐并转为完全实施**——核验发现「画布派生徽标」其实早已实现（`BizNode.tsx` 从 `mapStore.overlayByGraph` 取 `execution_state`，渲染 `canvas-exec-<id>` 徽标，`GraphCanvas.tsx` 接 `event:node-execution-state` 增量推送），此前本文用 `lifecycle_state` 作关键词检索 renderer 得 0 命中、误判为未做；真正缺的只有「时间线切换」。本轮在 `NodeMapPanel` 补上切换（先 `loadMessages` → 再 `selectThread` → 再切右侧面板，与 `HistorySidebar` 同路径），并加 4 例测试。G8-2 三件（面板 / 徽标 / 切换）现全部可复核。
> ② **I.2 补齐 7 条漏列**（G2-13/G2-14/G2-18/G6-5/G9-10/G10-2/G10-3），表行 95 → 102，与标题计数闭合。
> ③ **状态词纠偏**：G5-2 改为「E3 唯一写方；E2 另有 agent 回合直写」（`agent-step-runner.ts` 机器全过时 `produced_by='system'` 直写 E2，原文「唯一 E2/E3 写方」已不成立）；G3-14 的失效提交号 `c03ee87`/`4010` 更正为 `5cf3f81`；G6-19 标「文档级」；G1-10/G5-4/G5-8、G3-10/G5-3 补「服务端与 IPC 已交付，renderer 无入口，用户可见价值为 0」。
> ④ **证据口径变更**：`文件:行号` 系统性腐烂（抽样 30+ 条约半数不指向所声称符号），本版起 I.2 证据统一为「完整相对路径 + 符号/函数名」，行号仅在短文件保留；同时把文件名歧义（`link-service.ts` 在 `map-migration/`、`node-repository.ts` 在 `repositories/`、`yjs-realtime.ts` 在 `realtime/snapshot/`）改为完整路径。
> ⑤ **版本链统一 v49**（I.2.8 G9-11、§7 注、I.7 W11 三处旧数字 36/37 全部改 49；v50 仍未做，保持「未做」而非「待做」）；I.6 行数 → **5960**（v3.20 定稿实测；原写 5573 是 2026-11-09 的快照）。
> ⑥ **新增 I.0 三条决策前置**（S7 起草入口 / 手工连边不完整 / CI 卡门需先 push），放进阅读指引与 Part I 开头，避免被埋在附录。
> ⑦ **代码侧问题单独成文**：`docs/architecture/code-issues-2026-11-11.md`（护栏测试 flake、证据建议无 UI、`link:delete` 无 handler、ABI 不匹配、全量 14 文件/34 例不绿、timeline DTO 无约束），本文不再混装。
> 计数不变：**条目侧** 102 + 9 + 5 + 0 = **116**；**裁决侧** 23 条；**去重总量 139**（116 + 23，与 155 − 16 对账）。
> v3.20（2026-11-11）：**把「核验」变成可复跑的东西**。① 新增 `scripts/verify-session-map-blueprint.mjs`（`npm run verify:blueprint`），13 项机械断言：I.2 行数/分组闭合、编号唯一且能在 I.1 找到、三条计数等式、失效旧数字零残留、schema 版本 = 49、本文与快照行数、全部文件引用可解析、全部提交号可解析、I.0 三条决策前置可达、I.10 目标文件存在、状态词口径无自相矛盾、表格结构。本版在该脚本下**全绿**——以后「有没有退回老毛病」不用人眼数表。② 修掉三处**文档自相矛盾**：头部状态词定义仍写「必须带 `文件:行`」而正文已改「路径 + 符号」，两处统一为新口径并写明行号为何不作主证据；`src/main/realtime/yjs-realtime.ts` 少了 `snapshot/`；`db/repository.ts`、`approval/gateway.ts` 补全为 `src/main/agent/runtime/` 下的完整路径。③ 把「设计稿列过、但从未创建」的四个文件显式标注出来（`evidence-derivation.ts`、`wave-executor.ts`、`mediated-blackboard.ts`、`yjs-doc-registry.ts`），避免读者按图索骥找不到。④ 护栏测试 `ipc-preload-allowlist.test.ts` 的 describe 超时提到 30s：它同步遍历整个 `src/main` + `src/renderer`，满载时会被挤过 5s 默认值——那是负载，不是回归（单跑 5 例全绿，用时 0.5–7.5s 不等）。⑤ 全局 `testTimeout` 5s → 15s（只吸收并行排队），并修掉 `claude-code.test.ts` 里一条**依赖宿主沙箱可用**的用例（原断言「只读命令必 allow」，但 C3 的 fail-closed 会在沙箱不可用时正确降级为 ask；改为 mock 能力位，并新增一条「沙箱不可用 → ask」的用例反向覆盖）。全量失败从 **14 文件 / 34 例**降到 **7 文件 / 26 例**，剩余全部是 `ps` / `sandbox_apply` 被宿主拒绝所致。**计数不变**，未改任何状态词。
> v3.21（2026-11-11）：**把 v3.19/v3.20 登记的问题逐条修掉，并把环境类假红从「已知」变成「自动 quarantine」**。① **证据建议有了界面**：`NodeMapPanel` 新增「证据建议（待裁决）」区，接受/驳回直连 `map:evidence:suggestion:accept` / `:dismiss`，另加 E1 手动输入（`map:evidence:e1:create`，`ref` 固定指向当前节点，等级/写入方由主进程固定为 E1/human）；G1-10 / G3-10 的「用户可见价值 = 0」改为 **= 1**。② **手工连边闭环**：新增 `map:link:delete` handler + `LinkService.delete`（只删 `origin='human'`；派生/导入链接显式 `not_human_origin` 拒绝，避免「删了又被巡检重建」；跨项目 `project_mismatch`；硬删，删除事实写日志），面板内新增「关联连边」区（列表 + 删除按钮 + 同图节点下拉新建 `relates_to`）；I.0 第 2 条前置**闭环**。③ **timeline 不再 `SELECT *`**：`TimelineEntryDTO` 进 `src/shared/types/ipc.ts`，主进程改为显式列 + 显式映射，renderer 去掉 `as unknown as`；加列/改名会在两端编译期报错。④ **环境类失败改为按用例能力探测 skip**：`src/main/__tests__/helpers/host-probe.ts` 独立探测 `ps` 与 `sandbox-exec` 限制性 profile，26 条依赖宿主能力的用例改为 `it.skipIf`（同文件里不依赖的用例照跑），`process-supervisor` 整组 4 条全部依赖进程表故整组 skip；`agent-eval` U8 在 `ps` 不可读时记 **SKIP 并写明缺什么**（不写成 FAIL 结论）。⑤ **负载敏感 `telemetry/index.test.ts` 放宽到 60s**（真初始化 OTel SDK，满载时 import 链被挤过 15s；单跑 <1s，断言未改）。⑥ **IPC 三数变化**：注册 **204** / 暴露 **196** / renderer 使用 **100**（`map:link:create`、`map:link:delete` 新暴露；renderer 新增 7 处调用），护栏测试动态统计、无硬编码数字。全量 `vitest run`：**352 文件 / 4234 例，4188 通过、46 跳过、0 失败**（跳过全部带原因：宿主能力缺失 26 条 + 既有凭据/平台类 20 条）。**计数不变**：条目侧 102 + 9 + 5 + 0 = 116；裁决侧 23；去重 139。
> v3.22（2026-11-11）：**S7 起草入口落地，I.0 第 1 条前置闭环——C1 列表不再恒空**。① **通道**：`plan:draft:create` / `plan:draft:revise` 补进 preload 写白名单（此前「已注册未暴露」，`plan_drafts` 唯一 `INSERT` 因此永远无人可调）；`plan:draft:get` 进只读白名单（修订编辑器预填需要 `items_json` 原文——`plan:draft:preview` 只投影 display，`scopeFiles` 跨条目合并后无法逐条还原）；`plan:derive-candidates` **仍延后**（候选推导是 agent 辅助路径，无 renderer 消费方不扩写面，护栏豁免名单保留并改写原因）。② **起草 UI**：新增 `PlanDraftComposer.tsx`——多子任务编辑（key / 标题 / 目标 / 写域文件 / D1 结构化验收 / 依赖），客户端只做**形状级**校验（非空、键唯一、依赖可解析、环预检——环检测主进程另有一道），gate 缺失仍由服务端 `previewDraft` 在创建后如实投影，renderer 不复算；`NodeMapPanel` 计划草稿区改**常显**（此前无草稿时整区隐藏，起草入口没有落脚点）并加「起草计划」按钮；`PlanDraftPanel` 增「修订条目」出口（draft / awaiting_confirm 可修订，confirmed 由主进程拒绝），**驳回不再是单向死路**。③ **store**：`mapStore` 新增 `createPlanDraft` / `revisePlanDraft` / `getPlanDraftItems`，成功后重拉列表，失败写起草级/草稿级错误（不伪装空态）。④ **测试**：面板 +6 例（空态常显 / 起草提交 / 形状校验 / 修订预填原文 / 预填失败不打开 / 环预检），store +4 例；既有「无草稿不渲染区块」用例随语义变更改写——区块现在是起草入口的载体，藏起来等于回到「面板恒空」。⑤ **IPC 三数**：注册 **204** / 暴露 **199** / renderer 使用 **103**（新暴露 3 条全部有调用方，无半截通道）。⑥ **文档口径同步**：I.0 第 1 条标「已闭环」、I.8.2 已知缺口 8 → 5 条、I.8.F P1 的「无数据源」改「手工起草已交付」、G8-3 行与 II-29 同步。**计数不变**：条目侧 116；裁决侧 23；去重 139。
> v3.23（2026-11-12）：**CI 的第一道门修绿——`npm run lint` 此前是红的，一 push 会在 `lint` job 就断，`unit`/`build`/`e2e` 因 `needs: lint` 全都不会跑**。基线实测 **36 error / 8 warning**，分两类：①**28 个 `Parsing error` 是 eslint 配置缺口**——flat config 只在各 `files` 作用域里挂 typescript-eslint parser，`spikes/**` 与 `tests/eval/**` 落回默认 espree，于是把 TS 语法报成解析错（`spikes/` 本就自带 `package.json`/`node_modules`/`vitest.config`，且不在根 `tsconfig` 的 `include` 里；`tests/**` 在 `tsconfig` 内，但 eslint 只列了 `tests/migration`）；②**9 处真问题**——1 个 `prefer-const`、4 个 `no-explicit-any`、1 个 `consistent-type-imports`、3 个 `react-refresh/only-export-components`。修法：`spikes/**` 进 `ignores` 并写明原因；`tests/**` 整体纳入 TS 规则；`tests/eval` 单独关闭 `no-console`（该 harness 的产出方式就是往 stdout 打评测摘要）；`map.ts` 的 `let workItems` 保留并加 `prefer-const` 豁免（`onChanged` 闭包必须先于实例创建存在，合并成 `const` 会让闭包内引用落在 TDZ）；测试里的 `(runtime as any)` 换成最小面断言 `internalsOf()`（lint 仍有约束、签名写错仍有提示）；3 处 `react-refresh` 逐条豁免并写明只损失热更新粒度。结果：`eslint .` **0 error / 0 warning**（`--max-warnings 0` 下 exit 0）、`tsc --noEmit` 0，全量测试无变化。**计数不变**：条目侧 116；裁决侧 23；去重 139。
> v3.33（2026-11-13）：**G7-2 收口：Codex 的写前审批换成 `app-server` JSON-RPC，「问了再放行」成立；同时如实记下它有且仅有一种「拒绝」**。① **协议**：`codex app-server` 是 stdio 上的逐行 JSON-RPC，服务端会**反向请求客户端**：`initialize{clientInfo}` → `thread/start{cwd, approvalPolicy:'on-request', sandbox}` → `turn/start{threadId, input:[{type:'text',text}]}` → 工具执行前发 `item/commandExecution/requestApproval{id, command, cwd, reason, commandActions, availableDecisions}` → 客户端回 `{id, result:{decision:'accept'}}` → **命令真的执行**（实机：`aggregatedOutput` 里有 marker、exit 0、`turn/completed` 带 usage）。② **三处只有实机能发现的坑**：**服务端请求 id 从 0 开始**，与客户端 id 是两个独立空间 —— 判「请求还是响应」只能看有没有 `method`，不能看 id 大小；**`availableDecisions` 是按场景收窄的**，命令审批实测只有 `[accept, {acceptWithExecpolicyAmendment}, cancel]`，**没有 `decline`** —— 所以「拒绝」只能回 `cancel`，而 `cancel` 的语义是「拒绝并立即中断本回合」，真机确认回合因此以 `turn.failed` 收尾（把拒绝断言成 `turn.completed` 就是自欺）；**`thread/start` 会整份加载 `~/.codex/config.toml`**，版本不认识的字段让整次调用失败 —— 随包 `0.135.0` 遇到 `model_reasoning_effort = "max"`（用户 config 是给 0.162 写的）直接回 `-32600 failed to load configuration … unknown variant 'max'`，且 `-c` 覆盖救不回来（文件解析失败先于覆盖生效），这类错误必须原样抬给用户，否则表现为「回合没反应」。③ **fail-closed 与不降级**：钩子抛错 → 拒绝；装了钩子但 `app-server` 起不来 → 回合直接失败并显示原因，**绝不退回 `exec`**（那条路没有审批通道，退回等于把「有审批」偷换成「没审批」）；被拒与真崩分开记（`AGENT_DENIED` / `AGENT_CRASH`），界面上能看出是被拒了。④ **方言对齐**：v2 的 `item{type:'commandExecution', aggregatedOutput}` 翻成 SDK 的 `item{type:'command_execution', output}`，`turn/completed` 先判 `status`（`completed` 才算完成，`interrupted`/`failed` 一律 `turn.failed`），于是 `CodexStreamNormalizer` 与执行器一行都不用改。⑤ **用量**：服务端只给**线程累计** `total`（`last` 只覆盖最后一次模型调用、会严重低估），回合用量按「结束 − 开始」差分。⑥ **真机两条**（`codex-app-server-real.test.ts`，`BIZGRAPH_CODEX_REAL=1` 才跑，7.3s / 4.3s）：放行 → marker 文件落盘、`turn.completed`、input tokens > 0；拒绝 → `turn.failed`、失败原因非空、marker **不存在**（命令确实没跑）。⑦ **已知边界**：`item/permissions/requestApproval` 的回执只给最小集（放行 = 空增量 + 本回合）；`item/tool/requestUserInput`、`mcpServer/elicitation/request` 等反向请求**不接管**，回 `-32601` 而不是空结果 —— 「问了但没人答」比直接拒更危险；`app-server` 路径同样不注入内联子代理伪工具。计数：已实施 106 → **107**、已批准未实施 5 → **4**，条目侧 107 + 4 + 5 + 0 = 116 不变；G7-1 的三后端矩阵据此只剩「MCP 工具路径」与补测。
> v3.32（2026-11-12）：**G7-3 收口：OpenCode 的写前审批换成 `serve` 权限往返，「问了再放行」真的成立**。① **协议**：`opencode serve` 提供 `GET /event`（SSE）与 `POST /permission/{requestID}/reply {reply: once|always|reject}`；会话创建时下发 `permission` 规则集（`bash`/`edit`/`write`/`patch`/`webfetch`/`task` = ask，`read`/`glob`/`grep`/`list`/`ls`/`todoread` = allow，不用 `*` 兜底）。实机链路：建会话 → 发 prompt → SSE 收到 `permission.asked{patterns,metadata.command,tool.callID}` → 适配器把 `(permission, metadata)` 交给宿主审批钩子（与 claude-code 同一签名 `setTurnApprovalHooks`，由 `adapter-driver` 接线）→ 回 `once` 后工具**真的执行**（输出进 `message.part.updated.state.output`）。② **三处只有实机能发现的坑**：`/session` 的 `model` 是 `{id, providerID}` 而 `/session/{id}/message` 是 `{providerID, modelID}`，写错只回 `{"_tag":"BadRequest"}`；所有请求都必须带 `?directory=`，否则 `GET /session/{id}` 会解析到别的实例、token 读成 0；`tool_use.state.status=pending` 必须丢弃，否则归一化器会把「已经由 permission 桥处理过的审批」再记一遍。③ **fail-closed 三条**：没有钩子 → 拒绝、钩子抛错 → 拒绝并带原文、`always` 不用（会话级授权由宿主 approvals 记，这里再记一层会让撤销失效）。④ **不静默降级**：装了钩子但 `serve` 起不来时直接让回合失败，绝不退回不受审批的 `run`；事件被翻译成 `run --format json` 方言（`tool_use`/`text`/`error`），两条路径共用同一归一化器与执行器。已知边界：serve 路径不注入内联子代理伪工具（`dispatch_subagent`/`delegate_recipe`）。⑤ **真机两条**（`opencode-serve-real.test.ts`，`BIZGRAPH_OPENCODE_REAL=1` 才跑）：放行 → bash 输出含 marker、token 真实（input 505 / output 140）、无 error；拒绝 → bash 无 completed、`status=error` 且原因原话是钩子给的、`state.output` 不存在（命令确实没跑）。⑥ **e2e 补线**：新增 `opencode-settings.spec.ts`（2 例，验四档位一起发 + 关掉再开值回填），并修正 mock 的 `settings:read` 形状 —— 缺 `mcpServers` 时 `settings?.mcpServers.map` 会抛 TypeError、整个项目面板被错误边界接走（设置面板此前从未被 e2e 打开过，这条路径一直是没人走的）。⑦ **仓库清理**：drop 遗留 `stash@{0}`（内容是一份可重生成的 i18n 扫描报告）并清理 93 个不可达提交，`.git` 65M → 21M；清理前把全仓 + 不可达提交打成 bundle 放在仓外 `~/tiangong-git-backup-2026-11-12/`（可 `git clone` 恢复）。计数：已实施 105 → **106**、已批准未实施 6 → **5**，条目侧 106 + 5 + 5 + 0 = 116 不变。
> v3.31（2026-11-12）：**OpenCode 从「单测过」推到「零凭据真机跑通」，并修掉两处只在真机上才暴露的缺口**。① **免费档真的可用**：`opencode models` 列出 12 个模型，**全部**在 `opencode/` 下且都是 `-free`；`~/.local/share/opencode/auth.json` 里 0 条凭据时，`--model opencode/deepseek-v4.1-flash-free` 与**完全不带 `--model`**（CLI 自选默认）两条路径都跑通完整回合：回 `PONG`、`step_finish.tokens` 为真实值（input 6043 / output 4）、`cost 0`。这是国内「没有官方订阅」用户唯一开箱能用的组合，v3.30 只做了推断，本轮才有实测。② **口径纠正**：`--model` 必须是 `provider/model`，裸写 `deepseek-v4.1-flash-free` 会被判成 `…/.` 并抛 `ProviderModelNotFoundError`（只在 `--print-logs --log-level DEBUG` 下可见）；v3.30 记的 `deepseek-v4.1-flash` **少了 `opencode/` 前缀**，此处改正。③ **错误体是包了一层的**：`{"name":"UnknownError","data":{"message":"…","ref":"err_…"}}`，而 `errorTextOf` 只认顶层 `message` —— 结果归一化器把整块 JSON 塞进 message，`run.failed.summary` 更只有 `opencode exited with code 1`，用户拿不到任何线索。改为取 `data.message` 并把 `ref`（官方指定的查日志凭据）拼上、`summary` 直接显示原因、适配器在非零退出时把原文抬到输出流，且**只在确实传了 `--model` 时**附「必须 provider/model，用 `opencode models` 查清单」的提示（同一个 `Unexpected server error` 也可能是 key 无效，所以不把它写成结论）。退出码实测为 **1**，不存在 Codex 那种「被拒却报成功」。④ **顺手修掉一处会吃掉用户配置的真 bug**：设置页「默认模型」只有 `claudeCode`/`codex`/`mcp` 三档，而保存是**整体替换** `defaultModels`（`settings:write` 浅合并）—— opencode 档位因此成了「只能靠配置文件写、进一次设置面板点保存就被抹掉」的字段。补第四档 + 中英文案（占位符直接教 `provider/model`），两条守卫测试从「三个键」扩到「四个键」并断言 opencode 值保存后仍在。⑤ **新夹具**：`opencode-realmachine.test.ts` 用**逐字未改**的 CLI 原始 JSONL（读文件回合 + 错误回合）替代「按实机形状手写」，覆盖手写时想不到的 `metadata.display`、`time`、`chatcmpl-tool-` 形式 callID 与 `data.ref`。校验：全量 vitest **389 文件 / 4610 例，4554 通过、56 跳过、0 失败**；`eslint`、`tsc --noEmit`、`verify:blueprint` 均通过。**计数不变**：条目侧 105 + 6 + 5 + 0 = 116（G6-15 的交付修正，不新增 G 条目）；裁决侧 23；去重 139。
> v3.30（2026-11-12）：**G6-15 收口：OpenCode 从「纯文本执行器」变成「有轨迹的后端」；模型默认按国内现实来**。① 装上 `opencode-cli 1.19.5` 后第一个发现是**适配器早就死了**：它还发 1.0 时代的 `-q`，而 1.19 把这个参数当未知选项 —— CLI 打一页帮助然后 `exit 0`，宿主于是把帮助文本当模型输出返回（**静默的错误输出**，比崩溃更难查）。改为 `opencode run --format json`，prompt 走位置参数（`run` 模式不从 stdin 读消息）。② 新增 `OpenCodeStreamNormalizer`：把 `tool_use{part.state.status,input,output,error}` 还原成 `tool.requested` + `tool.result`/`tool.failed` + `file.change`，token 取 `step_finish.tokens`（不再是 `stdout.length/4` 的估算）；旧文本归一化只作降级保留 —— 它解析的 `[tool] …` 协议**真实 CLI 从不输出**，是基线自己假设的。③ **模型按「国内常态」设计**：不假设官方订阅，`opencode models` 自带的免费档就是 `deepseek-v4.1-flash` / `glm-5.3-flash` / `mimo-v2.6-flash`；设置里新增 `moonshot` / `zhipu` / `qwen` 三家国产 key（`ALLOWED_API_PROVIDERS` + `PROVIDER_CONFIGS` 同步），适配器把 key 拼成 `@ai-sdk/openai-compatible` 条目经 `OPENCODE_CONFIG_CONTENT` 传给子进程 —— 不写用户的 `~/.config/opencode`、不必再跑 `opencode auth login`；没配 key 时不设该变量，本地 Ollama / 自带免费模型 / 用户自己登录过的厂商都照旧。自建网关与本地端点（含 `http://127.0.0.1:<port>/v1`）实机验证通过：只给 `baseURL` + 任意 key 就能跑完整回合。④ **G7-3 被实机改口径**：无头 `run` 下 `permission.bash=ask` 会 `auto-rejecting` 并直接拒绝（JSON 里 `status=error`，原因原文保留），因此「默认拒绝」可做、「问了再放行」做不到 —— 真拦截须换 `opencode serve` 的权限回写或 `opencode acp`，口径由「装 CLI（2–4 人日）」改为「换常驻接口（3–5 人日）」。计数 105 + 6 + 5 + 0 = 116。
> v3.24（2026-11-12）：**S1 导入查重的用户出口落地——「重复导入」不再静默失败**。原状：`LeftPanel` 的「生成思维导图」只调 `graph:initFromProject`，从不传 `allowBranchVariant`，于是判定层 `3a-auto` 对分支/副本一律拒绝；`ImportRejectedError` 是裸 `Error`，`createTypedHandle` 只能包成 `IPC_HANDLER_ERROR`，命中证据（目录名/项目名/相似度/判定步）在 IPC 边界全丢；`catch {}` 空着，用户点完只看到转圈结束。三处一起修：①**结构化拒绝**——`ImportRejectedError` 改继承 `BizGraphError`，新增错误码 `IMPORT_REJECTED`，`toJSON().details.decision` 带 action/step/reason/signals；②**通道**——`project:import:preview`、`project:import:allowance:list` 进 preload 只读白名单（**不进 `MAP_READ_ONLY_CHANNELS`**：那张表是会话地图只读查询的集合，`map-read-ipc.test.ts` 逐条断言其中每个通道都由 map 域注册，导入查重不在那个域），`project:import:allowance:revoke` 进写白名单与结构化错误集合；preview 出口改为驼峰 DTO（`ImportPreviewResult`，含 `remembered`），不再把落库口径 `dir_name_same` 透给 renderer；③**界面**——新增 `ImportDedupDialog.tsx`（`reject` 只解释且不提供"强行导入" / `allow_with_warning` 可继续 / `allow_branch_variant` 必须勾选"这是分支或副本"才放行、可同时记住放行规则；框内含**放行规则列表与撤销**），`LeftPanel` 扫描前先 preview，判定收敛到 `decideImportGate`（`src/renderer/lib/import-gate.ts`）三分：proceed / confirm / blocked；失败不再静默，`readIpcError`（`src/renderer/lib/ipc-error.ts`）把 marker 里的结构化错误还原成人话再上屏。④**顺手修一处状态泄漏**：`GraphService.setImportOptions()` 是服务上的粘性状态，一次勾选「允许分支」会污染该进程后续所有导入（普通扫描也带 `interactive=true`），改为 `initFromProject(data, options)` 随调用传入。测试：对话框 6 例 + `decideImportGate` 7 例 + `ImportRejectedError` 载荷 2 例。**已知缺口 5 → 2**（只剩 `plan:derive-candidates` 延后、`admin:map:integrity-check` 刻意不暴露）。**计数不变**：条目侧 102+9+5+0=116；裁决侧 23；去重 139（本次是既有条目 G1-4 的交付修正，不新增 G 条目）。
> v3.25（2026-11-12）：**G6-14 从「批准未实施」转为实测通过，进化层三张表有了只读出口**。① **G6-14 改口径实测**（`tests/eval/agent-eval.test.ts` 的 U5）：默认 SKIP，显式 `BIZGRAPH_EVAL_REAL_CLAUDE=1` 才跑；本轮用 cc-switch GLM 代理（`ANTHROPIC_BASE_URL=http://127.0.0.1:15721`，`PROXY_MANAGED` 鉴权）跑**真实回合**，链路走产品代码四段——`claude -p --output-format stream-json` → `normalizeClaude` → `extractUsage`（本次导出，与跑 run 同一函数）→ `UsageLedger.record`；结果 **PASS**：`agent_usage` 落 `source=provider`、`tokens_reported=1`、input=9672 / output=30 / cacheRead=7168，`model=kimi-for-coding`（代理透传的上游真实名），`cost_status=missing_price`、`cost_micros=NULL`（价格表无该模型，**不编造金额**），重复上报 dedupe 后仍 1 行。**边界**：只验 token 统计链路，**不验 Anthropic 官方计费口径与价格**（仍缺付费额度，见 I.9.2）。② **进化层只读可见**（I.9.3 三条妥协的解除条件）：新增 `src/main/map/evolution-read.ts`（纯 SELECT）+ 三条通道 `map:memory:hits:list` / `map:memory:attribution:list` / `map:calibration:report:list` 进 `MAP_READ_ONLY_CHANNELS`（preload 自动暴露），新增 `EvolutionTab.tsx` 挂在设置页（命中明细 / 派发归因 / 校准报告三块），三种空态分开显示：**表不存在（迁移未跑）/ 表在但无数据 / 读取失败**。`memory_hits` / `v_memory_attribution` 缺失时返回 `available:false` 而不是抛错或伪装成空列表。③ **实测发现一处缺口**：`chat_messages.token_count` 全仓**没有生产写入方**（`ChatRepository.saveMessage` 支持 `tokenCount`，但没有任何调用点传值），该列恒为 0；权威 token 口径在 `agent_usage`。已登记 I.8.2，不为它造写入方。**计数**：条目侧 102+9+5 → **103+8+5 = 116**（G6-14 从「已批准未实施」移入「已实施」，总量不变）；裁决侧 23；去重 139。校验：`evolution-read` 8 例 + `EvolutionTab` 5 例，`verify:blueprint` 全绿。
> v3.29（2026-11-12）：**G9-13 收口 + Codex 侧两条实机结论**。① Windows 路径不再等机器：新增 CI `platform-paths` job（`windows-latest`，先断言宿主是 win32 再跑，防止整块 Windows 用例 skip 造成假绿），覆盖真实 NTFS 语义 —— 盘符前缀旁路（`C:\project-evil` 以 `C:\project` 开头）、大小写不敏感、跨盘 `path.relative` 返回绝对路径、`\` 归一；新增 `path-windows.test.ts`（POSIX 上 10 例 skip），并修掉 `path-utils.test.ts` 里两处 `fsSync.realpathSync('/tmp')` 无保护的平台假设（Windows 上 `/tmp` 不存在会直接抛 ENOENT，整文件红）。② 用 ChatGPT 内置 `codex-cli 0.162.0-alpha.17.2` 跑真实 `codex exec --json` 回合，**否掉 G7-2 的「只差 CLI 入口」**：随包 0.135.0 与 0.162 的 `exec` 都没有 `-a/--ask-for-approval`，唯一审批开关只能关（`--dangerously-bypass-approvals-and-sandbox`）；`approval_policy="on-request"` 下 MCP 调用仍被拒（`MCP tool call requires approval, but approval policy is never`）。要真拦截须改走 `codex app-server`，口径由「接线」改为「换协议」。③ 同时修掉该回合暴露的**假成功**：被拒的 `mcp_tool_call` 原本归一化成 `tool.result{ok:true}`（step 记 done、disposition 记 completed），现按 `status/error` 发 `tool.failed`，工具名带 `mcp:<server>/<tool>`；阻塞 `run()` 路径同改。
> v3.28（2026-11-12）：**e2e 的 24/26 失败不是平台差异，是 dev server 被 Electron 子进程带走**。root cause：`npm run dev` 经 `vite-plugin-electron` 在 dev server 起来后编译并 `spawn` 一个 Electron 子进程，而插件里写着 `process.electronApp.once("exit", process.exit)` —— 子进程一退出，**父进程（vite）跟着退出**。子进程在两种环境下必然退出：CI 用 `npm ci --ignore-scripts` 没下 Electron 二进制（`require('electron')` 直接抛），本机环境带 `ELECTRON_RUN_AS_NODE=1`（子进程以纯 Node 跑，`electron.app` 为 undefined → 主进程 `electron.app.commandLine` 即 TypeError）。表现是「前 2–4 例通过、之后全部 `page.goto: net::ERR_CONNECTION_REFUSED`」，通过数只取决于编译与启动的赛跑先后（Windows 2 例、macOS 本地 4 例）。修法：`vite.config.ts` 增加 `BIZGRAPH_BROWSER_E2E=1` 分支——浏览器 e2e 不挂 electron 插件（既不起子进程，也省掉 main/preload 两次 rollup 构建），由 `playwright.browser.config.ts` 的 `webServer.env` 注入。**另暴露三处被假红掩盖的真问题**：① `ThreadListSidebar.getLastUpdatedAt` 对 `thread.messages` 无保护，一条缺字段的记录就 `undefined.length` → ErrorBoundary 把整个 Agent 面板变错误页（现在缺字段退化为用 `createdAt` 排序）；② mock 只实现 37/177 个通道，`agent:getSessionRecovery` / `wiki:listWriteback*` / `locale` / 若干 `onXxx` 监听器缺失，前者让面板直接崩、后者在画布挂载期刷错；给 mock 加 Proxy 让缺失通道**自报名字**（只记 error 不抛，保留应用对可选监听器的 `?.` 探测语义）；③ `openNodeMenu` 用裸 `dispatchEvent('contextmenu')` 没有 `clientX/clientY`，菜单 `left/top` 为 `undefined`、浮层退回文档流落到视口下方（实测 `top=720`、删除项 `y=1113`），Playwright 报 `element is outside of the viewport`；改为在页面内手工构造 `MouseEvent` 带真实坐标。结果：本地 `CI=1` 全量 **26 例全过 / 34s**（修前 22 失败 / 2.2min，`--retries=0` 与默认重试各跑一次均绿）。
> v3.27（2026-11-12）：**CI 从「装不上依赖」推到「真跑出失败」，并修掉三类环境性误红**。① **锁文件里的 sharp 才是根因**：`overrides.sharp = file:./stubs/sharp` 让 npm 生成 `node_modules/sharp → node_modules/@xenova/transformers/stubs/sharp` 这种 `npm ci` 不会创建的链接（本地存在是早先 `npm install` 顺手建过），于是 build 的 `install-app-deps` 逐个 stat `node_modules/*` 时崩、unit 里 15 个文件整文件收集失败（`Cannot find package 'sharp'`）。改为普通直接依赖 `"sharp": "file:stubs/sharp"`，桩包名/版本对齐成 `sharp@0.32.0`，链接指向仓库内真实目录，`npm ci` 后即可解析。② **macOS runner 标签过期**：`macos-14` 已于 2026-11-02 退役（注解原文 `The configuration 'macos-14-arm64-us-default' is not supported`），`macos-13` 更早已下线（job 永远 queued），改用 `macos-15` / `macos-15-intel`。③ **e2e 的 Linux 步写的是 `npx xvfb-run …`**——xvfb-run 是系统程序，npx 会去 registry 找同名包，1 秒即红；headless chromium 不需要 X server，直接跑。④ **可观测性**：新增 `scripts/ci-annotate-failures.mjs`，把 vitest / playwright 的 json 报告按文件去重压成 ≤8 条注解 + 一条计数汇总（Actions 的 job 日志 API 需 admin，注解是匿名唯一可读通道）。⑤ **unit job 补 `node node_modules/electron/install.js`**：大量用例直接 import electron，`--ignore-scripts` 下没有 dist/ 会抛 `Electron failed to install correctly`。⑥ **测试侧两处环境依赖**：`NODE_SQLITE_FALLBACK` 在 CI 上指向不存在的 `spikes/agent-core/node_modules`（未纳入版本控制），退回根依赖并注明原因；`bash-readonly` 的「执行面」断言按**命令**分类探测——同一份伪造 gpgsig 仓库上，git 2.50 对 log/shortlog/rev-list/for-each-ref/branch 都会 spawn `gpg.program`，git 2.39/2.43 只有 log 会，因此「有没有执行」按宿主能力断言（不把版本差异当回归），而策略面（含 `%G` / `%(signature)` → ask）无条件断言。**计数不变**：条目侧 116；裁决侧 23；去重 139。
> v3.26（2026-11-12）：**`worktree-ux-defaults-2026-10-31` 合并入 main，schema 由 v49 升至 v50**。分支带来两组能力：①**只读会话**（`readOnly` 标志 + 只读推导唯一实现 `@shared/readonly-support`；claude-code 只读会话不下发任何写工具并 `strictMcpConfig`，codex 走 SDK `read-only` 档位，回退链只保留保证只读的适配器）；②**项目级默认（范围记忆）**——新表 `project_settings`（按 `project_path` 存 `defaults_json`，一个项目 online+dev 两张图不重复两份）+ `project:getDefaults` / `project:setDefaults` 两条通道 + 设置页「默认值」标签。**合并决策**（15 个冲突文件逐处合成，不简单选边）：`database.ts` 保留 main 的 v21–v49 迁移账本并追加 v50（分支的 `project_settings` 建表定义并入 `TABLE_SCHEMAS` 尾部）；`settings.ts` 取分支的**通用合并**（`{...defaults, ...defined}` 剔除显式 undefined，替代 main 的逐字段列举——后者会在每次 `readSettings()` 时悄悄丢掉未列举的新字段）；`graph-service.createGraph` 同时保留 main 的 S4 测试图闸门与分支的 `projectPath` 参数；`agent-manager` 同时保留 main 的平台感知内存闸门与分支的只读回退链裁剪；`claude-code` 的 options 合成：模型优先级「会话显式 > 适配器默认 > 全局默认 > sonnet」，env 用 main 的 `buildSessionEnv`（沙箱/进程组），`permissionMode` 在审批钩子或只读会话时均为 `default`；`codex` 取分支的 `threadOptions`（含 model 与只读 sandboxMode）但保留 main 的 `isTrustedNativeSessionId` 恢复守卫；`sessionStore` 合成「显式适配器优先 + `unwrapIpcResult` 结构化错误」，错误文案走 i18n 键且保留 `isRestoreFailed` 的原文透出。**验证**：`tsc`（main + renderer）0 错、`npm run lint` 0/0、`verify:blueprint` 13/13、全量 vitest **379 文件通过 / 5 跳过、4517 例通过 / 46 跳过 / 0 失败**（另修 4 处合并后口径漂移：迁移测试的版本字面量 49→50、节点指纹补 `test-suite`/`test-case` 两类、preload 暴露护栏补解析 `MAP_READ_ONLY_CHANNELS` 展开、LeftPanel 扫描失败用例补 `project:import:preview` mock 并把 toast 收敛为单点上报）。**边界**：分支的迁移是「schema v18」，与 main 的 v49 是同一文件的两个不同世代；合并后统一在 v50，分支侧若有按 v18 判断的老库假设，以 v50 账本为准。
> 权威声明：**本文是会话地图 / 多图编排 / 任务执行的唯一权威**。`docs/architecture/map-orchestration-blueprint.md`（v1.2.3，398 行）已并入本文 Part I 与 §2/§3/§5/§6，保留为历史快照，不再单独作为权威。
> ZCode 快照对应：用户上传件与仓库内 `map-orchestration-blueprint.md` 为同一份 v1.2.3（R10 勘误版），不是更新版；该文件当前实测 **398 行**（`wc -l`，2026-11-09 复核）。
> 范围：地图信息架构、字段级表结构、迁移顺序与回退、任务拆解机制、TestExecutor、IPC/渲染改动清单、状态与施工计划。
> 非范围：审批网关内部实现、Agent 内核/驱动协议、上下文水位线、成本账本 —— 见 `agent-architecture.md`。
> 状态词（严格四类，全文一致）：
> - **已实施**：必须带「完整相对路径 + 符号/函数名」（短文件可附行号）或提交号；复核不到不得使用。
>   行号不作为主证据——它是全文最先腐烂的东西（v3.19 抽样 30+ 处、约半数已错位到无关代码）。
> - **已批准未实施**：有裁决/定稿，但无对应代码。
> - **仅建议**：提案、候选、未决，不得进入验收口径。
> - **待裁决**：需要产品/架构选择；给出选项与建议。
> 数字纪律：行数、表数、版本号均须 `wc -l` / `git grep` / 源码复核；引用外部快照必须带版本与行数。

---

## 阅读指引（第一次打开从这里进）

**按目的选入口**

| 你想知道 | 先看 | 再看 |
|---|---|---|
| **只想知道「现在卡在哪、要我拍什么」** | **I.0 三条决策前置**（S7 起草入口 / 手工连边不完整 / CI 卡门需先 push；前两条已于 v3.21/v3.22 闭环，行位留对照） | I.8.2 已知缺口；`code-issues-2026-11-11.md`（代码侧问题，§1–§6 已收口） |
| **只想知道进度** | I.1 一页状态总账 | I.2 已实施清单（逐条代码证据）、I.3 未实施清单（W 包与可施工方案） |
| **要评估风险** | I.1.2 未实施、I.1.3 仅建议（重点看「不做会怎样」） | I.6 定稿自检；§4.5.1a（G7-10 已知限制）；Part II 对应条目的「边界 / 失败后果 / 验收」 |
| **要开工** | I.1.2 / I.3 定位条目 → I.7 施工顺序 | 条目正文的施工细则（§4.5.1、§5.9.8、§7.x、§8.x 等）；仅建议项读 Part II |

**Part I 各部分作用**：**I.1** 是唯一状态总账（计数与归类）；**I.2** 只列能从代码复核的已实施能力；**I.3** 是未实施项与按 12 个 W 包组织的可施工方案；**I.4** 是裁决记录；**I.5** 是 ZCode v1.2.3 设计吸收清单；**I.6** 是定稿自检（行数、计数、矛盾）；**I.7** 是建议施工顺序。**Part II** 是「仅建议」项的施工级设计（II-01…II-34，其中 II-32 已实施后保留为设计存档）；补设计不等于批准，状态仍以 I.1 为准。

**四类状态词口径（严格）**：**已实施** = 有「完整路径 + 符号」或提交号且复核得到；**已批准未实施** = 有裁决/定稿但无代码；**仅建议** = 提案/候选，不进入验收；**待裁决** = 需要产品/架构选择。**已裁决（方向）** 与 **已裁决（不做）** 只是修饰，不新增类别，也不产生施工授权。计数：明细 152 条 + 3 条施工级补充裁决（D-18/D-19/D-20）= 155 条、跨组重复 16 条、去重 139 条独立项；四类施工状态 116 + 裁决修饰 23 = 139（见 I.1 表）。

---

# Part I 状态总账与施工计划

> 本部分为定稿新增，回答“现在有什么、还缺什么、怎么施工、哪些要拍板”。原有 §0–§14 为设计规格，继续有效；两者冲突时，**状态以 Part I 为准，设计细节以原章节为准**。

## I.0 三条决策前置（先看这个）

这三件不是「待办」，是**当前最该被决策**的东西。它们挡住的是「已经写进代码、但用户拿不到价值」的部分，所以放在最前面。

> **v3.22 状态**：第 **1**、**2** 条均已闭环（S7 起草入口 + 手工连边，见下）；真正还需要你拍板的只剩第 **3** 条（CI 卡门 / push）。前两条保留行位是为了留对照：它们曾经断在哪、怎么补上的，下一轮不该再断同一处。

| # | 事项 | 现状（实测） | 不做会怎样 | 决策点 |
|---|---|---|---|---|
| **1** | **S7 起草入口（已于 v3.22 闭环）** | 已补齐：`plan:draft:create` / `plan:draft:revise` 写通道暴露 + `plan:draft:get` 只读暴露（修订预填），`PlanDraftComposer.tsx` 提供起草/修订编辑器（多子任务 + D1 结构化验收 + 依赖环客户端预检），`NodeMapPanel` 计划草稿区常显并给「起草计划」入口，`PlanDraftPanel` 给「修订条目」出口。测试覆盖：面板 6 例 + store 4 例。`plan:derive-candidates` 仍延后（agent 辅助路径，见 I.8.2） | 已不再发生。C1 列表有了唯一数据源；驳回后可修订，不再是单向死路。candidateScore / anchorStates 投影对无推导草稿如实给空（不伪造） | 无需决策；若将来要接「agent 按候选自动起草」，`plan:derive-candidates` 另开裁决 |
| **2** | **手工连边交付不完整（已于 v3.21 闭环）** | 已补齐：`map:link:create` 有 UI（面板内「选择同图节点 → 建立关联」，只开 `relates_to`）、`map:link:delete` 有 handler（`LinkService.delete`，只删 `origin='human'`）、`map:link:list` 有 renderer 消费（「关联连边」区）。测试覆盖：link-service 4 例 + IPC 1 例 + 面板 4 例 | 已不再发生。反向约束仍在：派生/导入链接人工删不掉（会被巡检重建），跨项目删除被拒 | 无需决策；若后续要开 `derives_from` 等人工连边类型，另开裁决（当前 L1 只允许 `relates_to`） |
| **3** | **CI 卡门需先 push** | 本地 `origin/main` 落后 **185 个提交**，`.github/workflows/ci.yml` 从未真正跑过；unit job 仍 `continue-on-error: true`。基线 `007f9d2` 上 **7 文件 / 26 例**环境类失败已改为**能力探测式 skip**（v3.21：`ps` / `sandbox_apply` 不可用时按用例跳过并写明原因），负载型误红已修；当前全量 **0 失败**。另：`lint` job（`unit`/`build`/`e2e` 的 `needs`）的第一条命令 `npm run lint` 在基线上**本身是红的**（36 error / 8 warning，v3.23 已修到 0），不修则一 push 就断在第一道门、后面三个 job 全不跑 | 「有 CI」只是文件存在。红的原因现在已能一眼分类（skip 带原因 / 真失败），但**还没在 CI 上真跑过**；且 Linux runner 上 `ps` 可用，那批进程归属用例会**首次真跑**（本地是 skip），这是首轮最可能的红点 | 先 push 让工作流真跑一次，确认绿，再摘 `continue-on-error`。**不要**长期靠容错挂绿 |

> 三条的共同点：代码/文档都「看起来完成了」，但用户路径上各断一环。这正是本轮核验要抓的那类问题（C1 是第一个被发现的样本）。


## I.1 一页状态总账

**计数口径**：明细共 **155 条**（152 条原明细 + 3 条施工级补充裁决 D-18/D-19/D-20），其中 **16 条为跨组重复**（已标注出处），去重后 **139 条独立项**。按去重口径：

| 类别 | 条数 | 说明 |
|---|---|---|
| 已实施 | **107** | 见 I.2，每条带代码证据（G6-14 于 v3.25 由「已批准未实施」移入，G9-13 于 v3.29 移入，G6-15 于 v3.30 移入，G7-3 于 v3.32 移入，G7-2 于 v3.33 移入） 见 I.2，每条带代码证据；W5-D 转入 G6-12/G6-13/G6-18，W2 补 G5-9、G1-10/G5-4/G5-8、G3-10/G5-3（E1 人工直写），W7 核账 G7-6/G7-9，W12 收 G10-2（A1/A2/A9 用例）与 G10-3（A3/A4 边界），G6-5 删除 unattended 分支（`gateway.ts`），G3-3/G8-6 renderer 执行入口落地（`NodeMapPanel` + `map:execution:status`），G9-10 worktree 定时清理落地（`test-executor.ts`），G2-14 明细视图落地（`schema.ts` v38），G2-13 published 软阻断落地（`published-guard.ts` v39），G1-14/G2-6/G2-19/G8-4 提案机制三层落地（v40），G2-1 模式库 + `routing_decisions.mode_id`（v41），G7-5 MCP 写工具写前审批（同一 gateway），G11-10 `node_evidence.tree_hash`（v42），G1-9 E4 覆盖变化扫描（v43），G2-3 `memory_hits` 记录表（v44），G2-2 Layer1 采集 + `source_outcome`（v45），G2-4 `v_memory_attribution` 归因视图（v46），G3-2 run 级跨进程项目写闸（复用 runtime workspace lease），G7-7 C3 exec 面 literal 收敛，G6-17 同 uid 边界（文档级），G2-18 12 值声明式步状态机 + 迁移事件，G3-1 Tier 探测（`tier-probe.ts`，写路径仅 Tier 1），G7-8 非 Tier 1 后端降级声明 + 执行状态说真话（UI/文档级），G5-10 项目进度只读视图（v47），G2-15 dirty diff 采集（v48，`dirty_files_count` + `dirty_tree_hash`），G2-16 离线校准报告（v49，`kind='calibration'`），G2-11 flow 集成测试（测试-only，`flow-test-integration.test.ts`），G8-5 任务卡四层折叠（`TaskCardTree.tsx`，纯渲染派生），G2-10 C1–C4 确认点（`confirmation-points.ts` + `step-confirmation-service.ts`：test/human 步逐点确认闸 + 必填展示项服务层校验），G8-3 确认点渲染与出口（`StepConfirmationPanel.tsx`：C3/C4 展示 why/风险原因/必填展示项/决策记录，只读后端判定；v3.14 起面板内可直接通过/驳回并按 `display` 契约回传） |
| 已批准未实施 | **4** | 见 I.3，均有可施工方案（W 包）；G6-14 已于 v3.25 实测通过、G9-13 已于 v3.29 用 Windows CI 收口、G6-15 已于 v3.30 用真实 CLI 收口、G7-3 已于 v3.32 用 `serve` 权限往返收口、G7-2 已于 v3.33 用 `app-server` JSON-RPC 收口，均移入「已实施」 |
| 仅建议 | **5** | 见 I.3 与 Part II，L3/未来能力，不进入本期验收；其中 3 条已解除裁决阻塞 |
| 待用户裁决 | **0** | 原 17 条已全部裁决，见 I.4 |
| **已裁决（方向/不做）** | **23** | 方向 20 条（D-01…D-20，其中 D-18/D-19/D-20 为 D-13 的施工级补充）+ 不做 3 条（G7-10、G2-8、G2-17）：仅定方向/边界，**不升格为已批准未实施**，也不进入验收 |

> **口径说明**：D-01…D-20 的裁决只回答“走哪条路”，不产生施工授权；G7-10 / G2-8 / G2-17 的「不做」是设计边界登记，同样不产生施工授权。D-18/D-19/D-20 是对 D-13 的**补充**（确认点落在哪类步、用什么风险线、事实存哪），不推翻 D-13 本体。四类施工状态加总 107 + 4 + 5 + 0 = **116（条目侧）**；**裁决侧**共 **23** 条（D-01…D-20 共 20 条 + G7-10 / G2-8 / G2-17 三条「不做」边界）；**去重总量** 116 + 23 = **139**，与 155 − 16 的去重结果一致（裁决只在四类之间平移，不新增施工类别）。

> 另有 16 条重复项：G1-9=G5-5（E4 扫描）、G1-10=G5-4（`evidence_suggestions`）、G1-12=G9-9=G11-11（Yjs，2 条重复）、G3-3=G8-6（renderer 入口）、G3-10=G5-3（E1 人工直写）、G4-5=G8-8（手工 E4 入口）、G4-7=G10-4（P1–P9）、G4-9=G10-11（CI）、G6-5=G7-12（unattended，G6-5 已删除分支）、G6-8=G11-5（排队）、G6-9=G11-6（runStreamed）、G6-10=G11-8（长尾 CLI）、G2-11=G4-1、G2-12=G4-2、G2-13=G4-3（流程测试三项）。

### I.1.1 已实施（107）

- **会话地图本体**：G1-1 `entity_key`、G1-2 `lifecycle_state`、G1-3 `node_links`、G1-4 导入查重、G1-5 双轨自动写关闭、G1-6 `needs_input` 回写、G1-7 输出/partial/文件变更回填、G1-8 子 work_item 聚合、G1-10 `evidence_suggestions`、G1-13 新建图 doc 池、G1-16 快照恢复不重算。
- **提案机制（v40）**：G1-14 提案服务 + 只读视图 `v_online_proposals` + `NodeMapPanel` 提案区（服务层/只读视图/UI 三层）；G2-6 冲突组串行、`weight` 展示降权、并发上限 3、24h 超时取消；G2-19 `proposal:list` / `proposal:diff` 只读通道与采纳/驳回；G8-4 复用 `NodeMapPanel` 做列表与 diff 可视化（只读、不批量）。
- **模式库（v41）**：G2-1 `mode-registry.ts` 代码常量（4 个模式，上限 32）+ `routing_decisions.mode_id` + `mode:list` 只读；执行前规则匹配，无匹配 `TIER_UNSUPPORTED` 不静默降级。
- **多图编排/归因**：G2-14 `v_plan_deviations_file_domain` 明细视图（v38，schema checksum 含 view）；G2-13 `published` 软阻断（v39，`nodes.published_waiver_json` + 只读徽标/统计）；G2-3 `memory_hits` 记录表（v44，幂等唯一索引 + 180 天/单项目 20 万保留治理）；G2-2 Layer1 采集（v45，五个 run 终态同步采集 step/evidence/deviation 引用 + `source_outcome`）；G2-4 `v_memory_attribution` 归因视图（v46，强制经 `node_session_links.session_origin='map_task'`，跨图不聚合、样本 <20 标 `insufficient_sample`）；G2-15 dirty diff 采集（v48，`change_sets.dirty_files_count` + `dirty_tree_hash`，采集失败显式 `-1`）；G2-16 离线校准报告（v49，`maybeRunCalibration` 按 20 run / 2 周触发，`kind='calibration'` 只写聚合报告）。
- **编排执行**：G3-4 `priority DESC`、G3-5 存量自由文本 acceptance、G3-6～G3-9 超时预算四键、G3-10/G5-3 E1 人工判断直写通道（服务 + IPC 写通道 + 幂等；renderer 入口归 G8）、G3-12 `GateRecheck`（含降级兜底）、G3-14 D2 验收执行器、G3-15 D1/D3/D7/D9、G3-2 run 级跨进程项目写闸（复用 runtime 同一 lease registry，fail-fast 跳过）、G3-1 Tier 探测（`tier-probe.ts`，四项能力位 + 进程内缓存；非 Tier 1 拒绝写入编排并在 `routing_decisions` 记能力票）、G2-18 12 值声明式步状态机（`WORK_STEP_TRANSITIONS` + `assertDeclared`，补 `waiting_approval → timed_out`，`work_step_changed` 5 处构造点全接）、G2-10 C1–C4 确认点（`confirmation-points.ts` + `step-confirmation-service.ts`：`test`/`human` 步高风险逐点确认闸、approve 落 `acceptance_confirmations`、reject 落 `input_request_json`、必填展示项服务层拒绝）。
- **测试体系**：G4-6 allow-list harness、G4-7 P1–P9 脚本、G4-8 P6 并行验证、G4-9 CI vitest、G4-10 S8 前置五表、G4-11 TestExecutor E2/E3 回写；G2-11 流程级集成测试（测试-only：flow spec 全过/失败两条全链，含 E3/E2 与 bug 回链）。
- **证据体系**：G1-9/G5-5 E4 覆盖变化扫描（v43：签收基线 + 独立扫描，变化置 stale 并区分 `stale_reason`）、G1-10/G5-4 `evidence_suggestions`（建表 + 接受同事务转证据）、G5-1 E1–E4 写方矩阵、G5-2 TestExecutor 写方、G5-6 E4 过期转 `stale`、G5-7 非 git E4 标记、G5-8 §3.4 事务/去重、G11-10 `node_evidence.tree_hash`（v42，E3 可选树绑定）。
- **Agent 运行时**：G6-1 M2 六项、G6-2 事件 50ms 批写、G6-3 turn 起始快照（恢复期不写库）、G6-4 三文件落地（`startup-reconciler` / `locks/workspace-lease` / `executors/acp-executor`，原「未建」）、G6-5 删除 unattended 30s 分支与仅供其存在的配置/UI/测试桩（`src/main/agent/runtime/approval/gateway.ts` 的 `:37`/`:183` 两处分支，统一交互 120s）、G6-6 重启 pending 按实际降级（统一 deny）、G6-12 R3 高事件量回放（`tests/eval/agent-eval.test.ts`）、G6-13 打包后 SDK/CLI 可用（arm64 实测）、G6-18 C13b 同名前缀 symlink 不跟随（`registry-hardening.test.ts`）、G6-19 五通道位置校正、G6-20 12 适配器能力矩阵。
- **审批与沙箱**：G7-4 legacy Claude 审批钩子、G7-5 MCP 写工具写前审批（同一 gateway）、G7-6 未知键 ask、G7-9 legacy `onBashPolicy`、G7-11 会话级授权边界、G7-13 交互审批 120s fail-closed、G7-14 重启陈旧审批 deny、G7-7 C3 exec 面 literal 收敛（`/bin`、`/usr/bin` 不再整目录放行，网络类不进名单）、G7-3 OpenCode 写前审批（`opencode-serve.ts`：`serve` 常驻 + `permission.asked` → 宿主钩子 → `/permission/{id}/reply`，`once` 后工具**真的执行**，`reject` 时命令不执行且原因回给模型；见 I.2.6）、G7-2 Codex 写前审批（`codex-app-server.ts`：`app-server` JSON-RPC + `item/commandExecution/requestApproval` → 宿主钩子 → `{decision:'accept'}`，命令真的执行；拒绝只能 `cancel` 且回合判 failed；见 I.2.6）。
- **界面与交互**：G8-1 `NodeMapPanel`、G8-2 画布派生徽标 + 会话时间线切换（徽标读 `execution_state`，切换走 `selectThread`）、G8-7 降级文案、G8-9 证据空态、G8-10 `ApprovalInbox`、G3-3/G8-6 renderer 执行入口（`NodeMapPanel` 接 `workitem:run:start` / `workitem:cancel` / `workitem:step:run` / `workitem:run:cancel`，只读 `map:execution:status`，gate 未通过只禁用不放行）、G8-5 任务卡四层折叠（`TaskCardTree.tsx`：任务→步→run→证据，默认折叠到任务级、展开态不落库、证据按 `work_run_id` 归属）、G8-3 确认点渲染（`StepConfirmationPanel.tsx`：C3/C4 展示 why / 后端风险原因 / 必填展示项 / 决策记录，只读后端判定、不复算风险；任务级给「待确认」角标）。
- **迁移与运维**：G9-1 S1/S2/S5a/S6a、G9-2 S3、G9-3 S7、G9-4 S8 前置表、G9-5 S4、G9-6 S4 不可逆（已接受）、G9-7 迁移续跑、G9-8 `RequestQueue` 删除、G9-10 worktree 定时清理（标记文件 + 启动/每 6h，`test-executor.ts`）、G9-11 schema 版本号对齐 **49**、G9-12 报告裁剪。
- **文档与验证**：G10-7/G10-8/G10-9/G10-12 本轮状态词/行数/矛盾校正、G10-2 A1/A2/A9 用例登记（§0.3.1，新增 A1 唯一性用例）、G10-3 A3/A4 边界（§0.3.2，新增并发串行与超时用例）；G11-7 成本只记账；G11-9 D12 本期不做。

### I.1.2 已批准未实施（4）

- **Agent 运行时**：G6-7 Codex 无句柄、G6-11 U1–U9（harness 已就位，U1/U2/U7/U9 待环境；U5 已按重判口径于 v3.25 实测通过，见 I.8.1）、G6-16 Codex provider 差异。~~G6-15 OpenCode 轨迹~~ **已于 v3.30 实施**（CLI 装为 1.19.5，`run --format json` 出结构化轨迹；见 I.2.5）。
- **审批与沙箱**：G7-1 写前审批覆盖边界（三后端矩阵未齐）。~~G7-2 Codex gateway~~ **已于 v3.33 实施**（`app-server` JSON-RPC：`item/commandExecution/requestApproval` → 宿主钩子 → `{decision:'accept'}`，命令真的执行；拒绝只能 `cancel`；见 I.2.6）。~~G7-3 OpenCode~~ **已于 v3.32 实施**（`serve` 权限往返：`permission.asked` → 宿主钩子 → 回写 `once`/`reject`；见 I.2.6）。G7-10 旧路径时间线**已裁决不做**（设计边界，见 §4.5.1a），不在此列。
- **迁移与运维**：~~G9-13 Windows 路径~~ **已于 v3.29 实施**（`platform-paths` job 在 windows-latest 上真跑路径语义；见 I.2.8）。
- **文档与验证**：G10-1 §13 审计表（102 行；原 66 节标“有框架缺细节”，截至 2026-11-09 A/B/C 组已收至 32 节、D 组再收 17 节、E 组再收 13 节、B3 再收 2 节至 **0 节**）、G10-11 CI（=G4-9）。

> **为什么本节列 10 个编号却标 4 条**（v3.19 补说明，v3.25 随 G6-14 移出再减 1，v3.29 随 G9-13 移出再减 1，v3.30 随 G6-15 移出再减 1，v3.32 随 G7-3 移出再减 1，v3.33 随 G7-2 移出再减 1）：`G10-11` 就是 `G4-9`，CI vitest 早已实施，按去重规则不重复计数；`G10-1` 的 §13 审计已收至「0 节缺细节」，无剩余施工，属账面遗留。10 − 6 = **4**。这两条保留在节内只为留痕，不构成待办。

### I.1.3 仅建议（5）

- **会话地图本体**：G1-11 `node_id` 放宽。
- **多图编排**：G2-5 Layer3 embedding、G2-7 Tier2、G2-9 黑板/fanout（**暂不投**：检索面与 `memory_hits` 重叠，串行下 fanout 语义消失）、G2-12 定向重测。
- **测试体系**：G4-2 定向重测（=G2-12）。
- **证据体系**：无（G5-10 项目进度查询已实施，见 v3.7）。
- **Agent 运行时**：无（G6-17 已转文档级实施）。
- **审批与沙箱**：无（G7-8 已按「显式声明 + 能力位降级 + UI 说真话」落地，完整审批桥仍不做）。
- **界面与交互**：**E1 人工判断入口**已随 v3.21 落地（面板内输入 + `map:evidence:e1:create`，等级/写入方由主进程固定），不再列为未做。G8-3 的 C3/C4 面板已实施（v3.13 展示，v3.14 补通过/驳回出口）；**C1 起草/修订入口已随 v3.22 交付**（`PlanDraftComposer.tsx` + `plan:draft:create` / `:revise` / `:get` 暴露，列表不再恒空）；C2 修订 diff 面板已实施（v3.16，**仅单任务字段级修订**，四条边界见 I.9.3）；证据建议裁决与人工连边（列表/新建/撤销）已随 v3.21 落地。
- **迁移与运维**：无（G9-10 worktree 清理已实施）。

> **索引（v2.1 补齐，v2.2 解阻塞，v2.3 核减，v2.5/v2.7/v2.8/v2.9/v3.0/v3.1/v3.2/v3.3/v3.4/v3.5/v3.6/v3.7/v3.8/v3.9/v3.10/v3.11/v3.12/v3.13/v3.14 再核减）**：以上 5 条（去重后；G4-2 等同 G2-12，G8-6 等同 G3-3）的施工级设计——目标与不做后果、数据/接口、流程与状态机、边界、验收、依赖顺序、成本估算——见 **Part II**，逐条编号 II-01…II-34（其中 II-12、II-15、II-16、II-17、II-18、II-20、II-22、II-23、II-24、II-25、II-26、II-27、II-28、II-29、II-31、II-32、II-33 已实施，保留为设计存档；II-02/03/04/05/06/08/13/21/30/34 于 2026-11-10 落地；II-10、II-19 已裁决不做，保留为设计存档）。状态保持「仅建议」，补设计不等于批准；原 13 条「阻塞于 D-xx」已于 **2026-11-08** 随 I.4 全部裁决解除，**解除阻塞不等于授权施工**。

> **G1-11 评估结论（2026-11-08，W1 盘点）**：真实库 `agent_turns` 为 **0 行**；历史证据库各 1 行，`node_id` 均指向存在的节点，未发现伪节点残留。结论：**维持「仅建议」**，不修改 `agent_turns.node_id TEXT NOT NULL`、不升 schema；D8 伪节点守卫（`isPseudoNodeId` + kernel 入口拒绝）继续有效。

### I.1.4 已裁决（方向 17 条 + 不做 3 条；仍未授权施工）

G1-12 Yjs 移除、G1-15 S1 `preview` 通道、G3-11 L2 通道未注册、G3-13 WorkScheduler 文档滞后、G4-4 bug 闭环边界、G4-5 手工 E4 入口、G6-8 排队 `queueDepth`、G6-9 Codex `runStreamed`、G6-10 长尾 CLI 工具事件、G8-8 手工 E4 入口（=G4-5）、G9-9 Yjs 拆除（=G1-12）、G10-5 L2 审查 P2 四项、G10-6 Zcode 两项、G10-10 agent §13 产品决策、G11-1 D1、G11-2 D4、G11-3 `turnMs` 配置键、G11-4 partial 截断、G11-5 排队（=G6-8）、G11-6 `runStreamed`（=G6-9）、G11-8 长尾（=G6-10）、G11-11 Yjs（=G1-12）、G11-12 Tier2；**G7-10 旧路径无 turn 时间线（已裁决不做，设计边界见 §4.5.1a）**；**G2-8 WaveExecutor、G2-17 多 Agent 交互（2026-11-10 已裁决不做：D-07 定并发上限 1 / 不排队 / 串行多会话，落地形态与现状等价，见 II-10 / II-19）**。

> 17 条方向裁决已于 **2026-11-08** 定案（`D-01…D-17`，见 I.4）；G7-10 于 **2026-11-09** 裁决不做并登记为设计边界；G2-8、G2-17 于 **2026-11-10** 裁决不做（D-07 并发上限 1，落地形态与现状等价）。三者均**不产生施工授权**，不计入「已批准未实施」。

> 注：I.1.4 列 26 个编号，去重后 20 条（17 方向 + 3 不做）；重复关系见上方清单。另有 D-18/D-19/D-20 三条**施工级补充裁决**（对应 G2-10，不新增 G 条目编号，故不计入上述 20 条），见 I.4.19–I.4.21。

## I.2 已实施清单（107 条，按主题）

> 复核口径：以下每条只写能从代码复核到的能力；文档声明但代码未复核的，一律降级到 I.3。
>
> **证据格式（v3.19 起变更）**：证据统一写「完整相对路径 + 符号/函数名」，**不再标行号**。原因：2026-11-11 核验抽样 30+ 条 `文件:行` 证据，约半数已不指向所声称的符号（源码每轮都在动，行号是最先腐烂的证据）。命名歧义一并消除：`link-service.ts` 实在 `map-migration/`、`node-repository.ts` 在 `repositories/`、`yjs-realtime.ts` 在 `realtime/snapshot/`。短文件（测试、单一职责模块）允许保留行号。
>
> **「已实施」的判定标准（三条同时满足）**：① 符号存在且被调用；② 入口可达（IPC 已注册且已暴露，或 UI 有挂载点）；③ 用户可见价值 > 0。「服务端有、renderer 无入口」的条目按要求保留在本表，但必须在「能力」列显式标注 `用户可见价值=0`，不得只写「已实施」。

### I.2.1 会话地图本体（12）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G1-1 | `nodes.entity_key` 列、唯一索引、一次性回填、克隆复制源键 | `database.ts`（列 / 唯一索引 / 回填）、`entity-key-backfill.ts` |
| G1-2 | `nodes/graphs.lifecycle_state`（active/archived/merged/split） | `database.ts`、`node-repository.ts` |
| G1-3 | `node_links` key-based 关系表 + 服务 + 回填 | `database.ts`、`link-service.ts` |
| G1-4 | 导入查重三表、判定顺序、拒绝留痕、90 天保留 | `database.ts`、`import-dedup.ts`、`graph-service.ts` |
| G1-5 | 两条自动写 `nodes.status` 路径关闭；只剩人工写 | `agent-manager.ts`（仅状态回调，不写库）、`ipc-handlers.ts`（只广播）、`execution-state.ts`（派生态不落库）；人工入口 `ipc/graph.ts` node:update、`useNodeOperations.ts`、`GraphCanvas.tsx` |
| G1-6 | `needs_input` 回写 + 人工确认恢复，不新开 attempt | `agent-step-runner.ts`（`finalizeNeedsInput`）、`work-item-service.ts`（`markNeedsInput`/`settleNeedsInput`）、`work-step-service.ts`（`settleNeedsInput`）、`acceptance-confirmation.ts` |
| G1-7 | `outputs/output_parse/partial` 落 `work_runs`；文件变更落 `change_sets`；usage 仍由 runtime 写 `agent_usage` | `agent-step-runner.ts`、`workspace-change-stats.ts`、`work-run-service.ts`、`runtime.ts` |
| G1-8 | 子 work_item 全终态后父链聚合（failed > cancelled > done），防环幂等 | `work-item-service.ts`（`convergeChildrenIfTerminal` / `convergeParentChain`）；触发点 `work-item-service.ts` |
| G1-13 | 新建图在 WS 连接时按需进 doc 池；不存在的图不造孤儿 doc | `yjs-realtime.ts`（WS `getDoc` → `getOrLoadDoc` + `graphExists`） |
| G1-16 | 快照恢复不写 SQLite、不重算 `entity_key` | `cc749ce`；`docs/architecture/session-map-blueprint.md` §2.2.1 |
| G1-10 | `evidence_suggestions` 建表（v37）；建议写入去重；接受与 `node_evidence` 同事务转写，重复接受幂等。**用户可见价值 = 1（v3.21 起）**：`NodeMapPanel` 的「证据建议（待裁决）」区展示 pending 建议（等级/类型/理由/置信度），接受与驳回直连 `map:evidence:suggestion:accept` / `:dismiss`，接受后同事务写入证据并重拉列表；此前通道已暴露但 renderer 零调用，建议永远停在 pending | `schema.ts`（`MAP_S6A_TABLE_SCHEMAS`）、`evidence-service.ts`（`EvidenceSuggestionService`）、`NodeMapPanel.tsx`、`mapStore.ts`（`fetchEvidenceSuggestions`）、`evidence-suggestions.test.ts`、`NodeMapPanel.test.tsx` |
| G2-15 | dirty diff 采集：`change_sets.dirty_files_count`（v48，`NULL`=无未提交改动或未采集、`-1`=采集失败）与 `dirty_tree_hash`；指纹 = `sha256(HEAD + 排序后的 porcelain)`；同 hash+count+head 去重不重复写；采集失败显式标 `-1`，不编造 0 变更 | `schema.ts`（`change_sets`）、`database.ts`（v48 `addColumnSafe`）、`workspace-change-stats.ts`（`dirtyFingerprint`/`MAX_RECORDED_FILES`）、`work-run-service.ts`（`captureHead`/`markDirtyCaptureFailed`）、`agent-step-runner.ts`（`recordChangeHead`）、`agent-step-runner.test.ts` |

### I.2.2 编排执行（15）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G3-4 | `work_items.priority` 加列 + 两处候选查询统一为 `queued` 优先、`priority DESC`、`created_at` 兜底 | `0df2234`、`database.ts`（v36 `addColumnSafe`）、`work-scheduler.ts`、`work-execution-service.ts` |
| G3-5 | 存量自由文本 acceptance 迁移为结构化 `acceptance_json`，原文逐行存 `map_acceptance_migration_archive` | `0df2234`、`legacy-acceptance.ts` |
| G3-6 | `agentRuntime.timeouts.turnMs` 生效于 kernel 派发 | `0df2234`、`timeout-config.ts` |
| G3-7 | `stepMs` 写 `work_runs.deadline_at` 并由 tick 收口 `timed_out`；`taskMs` 按最早 run 起算 | `0df2234`、`work-execution-service.ts` |
| G3-8 | `sendWaitMs` 生效且 clamp ≥ `turnMs + 30s` | `0df2234`、`send-and-wait.ts` |
| G3-9 | subagent 继承 `min(stepMs, 父 turn 剩余)` | `0df2234`、`subagent-manager.ts`、`agent-manager.ts` |
| G3-12 | `GateRecheck` 接入；引擎不可用时 `incomplete + gate_engine_unavailable` | `work-execution-service.ts`、`b6f3735` |
| G3-14 | D2 验收执行器 command / file_check / manual，逐条结果落 `map_migration_reports` | `acceptance-executor.ts`；引入提交 `5cf3f81`（**更正**：原文引的 `c03ee87` / `4010` 在全仓 39 个提交号中唯一失效，`git cat-file` 解析不到） |
| G3-15 | D1 计划确认、D3 按步骤调度、D7 重启对账、D9 人工确认 | `e4398e7`、`94125bd`、`work-execution-service.ts` |
| G3-10 / G5-3 | E1 人工判断直写：`createHumanJudgment` 固定 E1/human，`map:evidence:e1:create` IPC 写通道，`idempotencyKey` 落 `ref_json` 幂等；建议等级移除 E1、历史 E1 建议拒绝接受。**用户可见价值 = 1（v3.21 起）**：面板「证据建议」区底部有 E1 手动输入（`ref` 固定为 `{kind:'node', graphId, nodeEntityKey}`），写入成功才清空输入；界面不提供等级/写入方选择（主进程固定），仍不自报 `actor` | `evidence-service.ts`（`createHumanJudgment`、`SUGGESTION_LEVELS`）、`ipc/map.ts`、`NodeMapPanel.tsx`、`evidence-suggestions.test.ts` |
| G3-3 / G8-6 | renderer 执行入口：`NodeMapPanel` 接 `workitem:run:start` / `workitem:cancel` / `workitem:step:run` / `workitem:run:cancel` / `workitem:acceptance:confirm`；只读 `map:execution:status`；gate 未通过只禁用并列出缺项，不写 gate pass；有活跃 run 时只给 run 级取消 | `NodeMapPanel.tsx`、`mapStore.ts`、`preload/index.ts`、`ipc/map.ts`、`mapStore.test.ts`、`NodeMapPanel.test.tsx` |
| G3-2 | 跨进程项目写闸：`WorkExecutionService.tick` 在 claim 前以 `item.project_path` 抢占 **runtime 同一个** `WorkspaceLeaseRegistry`，`settle` 后 `finally` 释放；抢不到 fail-fast 跳过（不 claim、不消耗 attempt、`project_busy:<pid>` 事件）；默认关闭即 noop。逐 turn 互斥此前已由 `runtime.runNode` 提供 | `work-execution-service.ts`、`work-execution-runtime.ts`、`agent-manager.ts`（`getWorkspaceLease`）、`index.ts`、`work-execution.test.ts` |
| G3-1 | Tier 探测：`probeAdapterTier` 产出 `{tier, resume, approval_callback, structured_output, cancel, probe_error}`；写通道与 tick 路由均只接受 Tier 1，非 Tier 1 落 `TIER_UNSUPPORTED`/`routing_failed`；进程内按 `(adapter, adapterVersion)` 缓存，失败一律 Tier 3 | `tier-probe.ts`、`work-execution-service.ts`（`checkRouting`/`assertKernelReady`）、`agent-step-runner.ts`（`routing_decisions` 能力票）、`tier-probe.test.ts`、`work-execution.test.ts` |
| G2-10 | C1–C4 确认点：C3/C4 逐点确认闸只建在 `test`/`human` 步（agent 步继续走 runtime 逐工具审批）；风险两档，复用 G4 的 20 文件 / 800 行（`deriveStepRisk` 由写域文件数 + 行数代理派生，不改表、不新增字段）；approve 落 `acceptance_confirmations`（`entry_id`=C3/C4，`decision_note` 记风险与原因），reject 改写 `input_request_json`（C3 → `cancelled`、C4 → 返工 `pending`）；C1（计划确认）/C2（执行中修订）在 IPC 边界做必填展示项校验；新增 `map:confirmation:status`（只读）/ `map:confirmation:decide`（写） | `confirmation-points.ts`、`step-confirmation-service.ts`、`work-step-service.ts`（`waiting_approval → pending` / `returnToPending`）、`work-execution-service.ts`（tick 闸 + `confirmationGatedStepIds`）、`gate-engine.ts`（`G4_HIGH_RISK_FILES`/`G4_HIGH_RISK_LINES`）、`ipc/map.ts`、`confirmation-points.test.ts`、`step-confirmation-service.test.ts` |
| G2-18 | 完整步状态机：`work_steps` **12 值**声明式迁移表（`WORK_STEP_TRANSITIONS` + 写库前 `assertDeclared`），补 `waiting_approval → timed_out`；`review` 标注无生产写入方；步级 `work_step_changed` 事件在 5 处构造点全接 | `work-step-service.ts`（`WORK_STEP_TRANSITIONS`/`assertDeclared`）、`work-execution-service.ts`、`acceptance-confirmation.ts`、`work-step-service.test.ts` |

### I.2.3 测试体系（7）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G4-6 | allow-list harness（manifest + 测试） | `217fbbc`、`tests/migration/allow-list-harness.test.ts`、`allow-list.manifest.ts` |
| G4-7 | P1–P9 迁移验证脚本 | `217fbbc`、`tests/migration/p1-entity-key.test.ts` … `p9-evidence-separation.test.ts`（9 个） |
| G4-8 | P6 Yjs/SQLite 镜像并行验证 | `217fbbc`、`tests/migration/p6-yjs-sqlite-mirror.test.ts` |
| G4-9 | CI vitest job（含 P1–P9 与 G4-6；先 `continue-on-error` 观测） | `217fbbc`、`.github/workflows/ci.yml`；2026-11-12 修 CI 首次真跑暴露的三处：lint/unit 的 `npm ci` 改 `--ignore-scripts`（根 postinstall 按 Electron ABI 重编 `better-sqlite3` 要额外拉 headers，是纯网络性失败点）、lint job 加 `fetch-depth: 0`（`verify:blueprint` 用 `git cat-file` 核对历史提交号，浅克隆必红）、校验脚本把 `test-results/` 按运行期产物处理（`.gitignore` 已忽略，干净克隆里必然不存在） |
| G4-10 | S8 前置五表（`test_specs/plans/items/runs/results`） | `database.ts` |
| G4-11 | TestExecutor 逐条执行 + `evidence.create` E2/E3 | `test-executor.ts`、`test-plan-service.test.ts` |
| G2-11 | 流程级集成测试（测试-only）：flow spec（`kind='flow'` + `steps_json`）两步骤全过/一步失败两条全链；断言 `test_results`/`test_runs` 聚合、E3/E2 回写、失败建 bug + 元数据回链、worktree 清理/保留 | `src/main/__tests__/flow-test-integration.test.ts` |

### I.2.4 证据体系（12）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G5-1 | E1–E4 写方矩阵、端点校验、唯一性、E4 `coverage_json` | `evidence-service.ts` |
| G5-2 | **E3 的唯一写方**是 TestExecutor；**E2 有两个写方**——TestExecutor（测试驱动）与 agent 回合直写（机器全过时 `produced_by='system'`，走 C 口径）。原文「唯一 E2/E3 写方」已不成立 | `test-executor.ts`（E3/E2 回写）、`agent-step-runner.ts`（`recordTurnEvidence`）、`evidence-suggestions.test.ts` |
| G2-13 | `published` 软阻断（v39）：`nodes.published_waiver_json` 存发布豁免（`{by, at, reason, missing[]}`，与 work_items 的 gate waiver 是两套事实）；`computePassEvidence` 判通过记录、`assertPublishedUpdateAllowed` 在写路径拦截、`getPublishedStatus` 供只读徽标/统计。**软阻断**：不给豁免则拒绝，给了则放行并留痕 | `published-guard.ts`（`computePassEvidence`/`parsePublishedWaiver`/`assertPublishedUpdateAllowed`/`getPublishedStatus`）、`schema.ts`（v39）、`published-guard.test.ts` |
| G2-14 | `v_plan_deviations_file_domain` 明细视图（v38）：把偏差从「按数量」展开到「按文件域」，视图随启动 `DROP/CREATE` 重建，不落表、不做增量写；schema checksum 含 view | `schema.ts`（`MAP_VIEW_SCHEMAS`）、`database.ts`（v38）、`plan-deviation` 相关用例 |
| G5-6 | E4 过期（默认 30 天）自动转 `stale` | `evidence-service.ts`、U1 |
| G5-7 | 非 git E4 `reproducible=0`、`version_binding='none'` | `database.ts` |
| G5-9 | 等级字段组合校验：ref_json 必填、E1 必填 summary、E1/E2 拒 E3/E4 专属字段、E3 拒签收字段、E4 拒 code_version/code_dirty（`current_hash` 按代码事实作产物内容绑定放行） | `evidence-service.ts`、`evidence-derivation.test.ts`（G5-9 用例） |
| G5-4 | 建议转证据：`evidence_suggestions` → 人工接受 → `node_evidence`（`produced_by='agent'`、ref 追加 `suggestionId`）；机器全过则不经建议直写 E2（`produced_by='system'`） | `evidence-suggestions.test.ts`、`agent-step-runner.ts`（`recordTurnEvidence`） |
| G5-8 | §3.4 事务/去重：接受与证据写入同事务；同 node+kind+source_ref 只留一条 pending；驳回只改状态 | `evidence-service.ts`（`suggest/accept/dismiss`）、`evidence-suggestions.test.ts` |
| G11-10 | E3 可选树绑定：`node_evidence.tree_hash`（v42，可空、仅 E3 可写、不进 CHECK 与 gate）；TestExecutor 写 E3 时回填执行树 | `schema.ts`（`node_evidence`）、`database.ts`（v42 `addColumnSafe`）、`evidence-service.ts`（`treeHash`）、`test-executor.ts`（`treeHash: executed.treeHash`）、`evidence-derivation.test.ts`（G11-10 用例） |
| G1-9/G5-5 | E4 覆盖变化扫描（v43）：签收时 `captureCoverageBaseline` 记逐文件 `sha256` + 范围快照；`scanCoverageChangedE4All` 与到期扫描独立（`stage='e4_coverage'`、启动+每日、单轮 ≤500、只更新 fresh），变化置 stale 并用 `stale_reason` 区分内容/范围；不自动撤销 | `schema.ts`（`coverage_baseline_json`/`stale_reason`）、`database.ts`（v43 + 调用点）、`evidence-service.ts`（`captureCoverageBaseline`/`scanCoverageChangedE4All`）、`evidence-derivation.test.ts`（G1-9 用例） |
| G5-10 | §3.6 项目进度只读视图 `v_project_progress`（v47）：按项目聚合 `nodes_total`/`nodes_verified`（仅 E2/E3/E4）/`items_done`/`items_failed`/`evidence_by_level`；任务与证据缺 `project_path` 时回退图；撤销证据不计；IPC `map:project:progress` 只读，未知项目返回 `available=false` | `schema.ts`（`v_project_progress`）、`database.ts`（v47）、`project-progress.ts`、`ipc/map.ts`、`shared/types/ipc.ts`、`project-progress.test.ts` |

### I.2.5 Agent 运行时（13）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G6-1 | M2 六项：`executing_at` 三阶段（`approved_at → executing_at → ended_at`）、turn 起始快照、`stepOutcomes` 落库（含 aborted 兜底）、分层进程回收、planner 完整策略、事件批写 | `dc51b48`、`runtime.ts`、`event-batch-writer.ts`、`src/main/agent/runtime/recovery/planner.ts`、`src/main/agent/runtime/db/repository.ts` |
| G6-2 | 事件 50ms 批写 + shutdown flush + `BIZGRAPH_EVENT_BATCH_WRITER` 灰度 | `dc51b48`、`event-batch-writer.ts`（含真实进程测试） |
| G6-3 | `runNode` 生产写入 `agent_snapshots`（仅元数据 + promptHash）；恢复期只读、不写库 | `dc51b48`、`runtime.ts`（`writeTurnStartSnapshot`） |
| G6-4 | 三文件落地（原「未建」）：`startup-reconciler.ts`、`locks/workspace-lease.ts`、`executors/acp-executor.ts` | `dc51b48`、`80075e7` |
| G6-12 | R3 高事件量回放：10k `message.delta` 走 `EventBatchWriter` + WAL 文件库，断言全部落库、seq 连续、主进程阻塞有上限 | `tests/eval/agent-eval.test.ts`（2026-11-09 实测 PASS） |
| G6-13 | 打包后 SDK/CLI 可用：asar 内 SDK 入口齐备，asar.unpacked 的 `claude` / `codex` 二进制可执行 | `tests/eval/agent-eval.test.ts`（U4，arm64 dir 产物实测） |
| G6-18 | C13b：同名前缀 symlink 不跟随写入，已有普通文件不覆盖，只读目录拒绝 | `registry-hardening.test.ts`（4 条 C13b 用例，2026-11-09 12/12） |
| G6-6 | 重启后陈旧审批统一 deny（不再承诺重推 + replay） | `startup-reconcile` 路径；`agent-architecture.md` §7.4 |
| G6-19 | **文档级（无代码）**：「五通道 / 模式库 / 进化 / 提案」这四类的归属从 agent 文档校正到本文 Part I（I.2.10 提案、I.2.11 模式、I.2.12 进化）。原文引 `map-orchestration-blueprint.md` 的清单行作证据，但那行是**需求清单**不是完成记录，不足以支撑「已实施」——此处降为文档级动作，不主张代码能力 | 本文 I.2.10 / I.2.11 / I.2.12；`map-orchestration-blueprint.md`（历史快照，仅作需求来源） |
| G6-20 | 12 适配器能力矩阵；Claude 写前审批 | `agent-architecture.md` §10/§17.1；`claude-code.ts` |
| G6-17 | 同 uid 防御边界：跨 uid 承诺 / 同 uid 不承诺 / 攻击者门槛 / 不构成提权；**仅文档，无运行时检测** | `agent-architecture.md` §6.5.1；本文 §10 表 |
| G6-14 | Claude token 统计（重判口径）：真实回合的 usage 经 `normalizeClaude` → `extractUsage` → `UsageLedger.record` 落 `agent_usage`；实测 `source=provider`、`tokens_reported=1`、input=9672 / output=30 / cacheRead=7168、`cost_status=missing_price`（代理模型无牌价，不编造金额）、重复上报 dedupe 后仍 1 行；**不验 Anthropic 官方计费口径**（缺付费额度，见 I.9.2） | `tests/eval/agent-eval.test.ts`（U5，2026-11-12 实测 PASS，需 `BIZGRAPH_EVAL_REAL_CLAUDE=1`）、`src/main/agent/runtime/normalize/claude.ts`、`src/main/agent/runtime/executors/adapter-driver.ts`（`extractUsage`）、`src/main/agent/runtime/cost/ledger.ts` |
| G6-15 | OpenCode 轨迹（v3.30 收口）：适配器改走 `opencode run --format json`，stdout 是 JSONL 事件流；`OpenCodeStreamNormalizer` 把 `tool_use{state.status}` 还原成 `tool.requested` + `tool.result`/`tool.failed`，`step_finish.tokens` 给真实 token。**装 CLI 后实测**：write 工具产出 requested/result/file.change 三条，被权限拒绝的 bash 产出 `tool.failed`（输出即 CLI 的原始拒绝原因），不再是一条「成功但内容像错误」的假轨迹 | `src/main/adapters/opencode.ts`、`src/main/agent/runtime/normalize/opencode.ts`、`executors/adapter-driver.ts`、`opencode-stream.test.ts` / `opencode-adapter.test.ts`；实机 `opencode-cli 1.19.5` |

> **证据口径（2026-11-09）**：G6-1～G6-4 为**模块级已验证**（真实子进程/临时库单测 + 全量 vitest 绿 + `tsc --noEmit`），**端到端待真机**——「chat 走 kernel 且有写前审批」目前只在 `AgentManager.sendCommand` 路由与 `runNode` 单测层面验证，尚未在打包后的 Electron app 中跑通完整链路。写入 `agent_events` / `agent_steps` 的三阶段时间戳同理，均为单测断言，不是真机会话回放。
> **事实记录**：当前仓库**没有名为 `acp` 的 `AgentAdapter`**；ACP driver 仅在设置 `BIZGRAPH_ACP_COMMAND` 时注册生效，因此今天可证的 chat kernel 路径仍是 `claude`（`claude-code`）。

### I.2.6 审批与沙箱（12）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G7-4 | legacy Claude 审批钩子接线 | `2026-11-07` 修复；`agent-architecture.md` §17.5 |
| G7-5 | MCP 写工具纳入写前审批：`McpAdapter.setTurnApprovalHooks` 由 Runtime Driver 注入，与 CLI 写工具走同一 gateway；写类判定按工具名清单 | `mcp-adapter.ts`、`write-paths.ts`、`approval-mcp-write.test.ts` |
| G7-6 | 未知 git 配置键默认 ask（安全键族白名单外一律 `git-unknown-config-key`；`BIZGRAPH_GIT_CONFIG_STRICT_KEYS=off` 可回退，探针失败仍 fail-closed） | `bash-readonly.test.ts`、`agent-architecture.md` §7.3 B |
| G7-9 | legacy `onBashPolicy` 已接线：Bash 决策回调 Runtime 审计（命中规则/危险模式） | `claude-code.ts`、`claude-code.test.ts` |
| G7-11 | 会话级授权仅覆盖写类工具（设计边界） | `agent-architecture.md` §7.6 |
| G7-13 | 交互审批 120s fail-closed | `ApprovalGateway`；`agent-architecture.md` §7.4 |
| G7-14 | 重启陈旧审批 deny | `agent-architecture.md` §7.4 |
| G7-7 | C3 exec 面收敛为 literal：`/bin`、`/usr/bin`、`/usr/sbin`、`/usr/libexec` 不再整目录放行，只放 shell/env/xcrun + 白名单命令 + node/npm/npx 规范路径；git 只放 git-core（subpath）+ git 本体（literal），不再整根放行 CLT；`/usr/bin/arch` 已删（无调用方）；`/System/Library` 是唯一目录级放行；ssh/scp/curl/wget/nc 刻意排除。审批放行 ≠ 沙箱可执行，未枚举命令以 EPERM（`Operation not permitted`）失败而非静默 | `profile.ts`（`SYSTEM_EXEC_LITERALS`/`SYSTEM_EXEC_SUBPATHS`/`NETWORK_EXEC_COMMANDS`/`PRODUCT_EXEC_COMMANDS`）、`profile.test.ts`（收敛断言 + 名单快照）、`harness.test.ts`（真实 git 18 子命令 + node/npm/npx 可用 + curl/ssh/nc 被拒） |
| G7-3 | OpenCode 写步骤走写前审批（`serve` 权限往返）：会话建时下发规则集（bash/edit/write/patch/webfetch/task = ask，read/glob/grep/list/ls/todoread = allow），工具执行前 CLI 发 `permission.asked`，适配器交给宿主审批钩子，再按结果回写 `once`/`reject` —— `once` 后工具**真的执行**，`reject` 时命令不执行、拒绝原因原话回给模型。无钩子/钩子抛错一律按拒绝（fail-closed）；事件翻译成 `run --format json` 方言，两条路径共用同一归一化器 | `opencode-serve.ts`（`buildServePermissionRules` / `bridgePermission` / `toStreamEvent` / `OpencodeServeClient`）、`opencode.ts`（`setTurnApprovalHooks` + `runServeTurn`）、`opencode-serve.test.ts`（18 例）、`opencode-serve-real.test.ts`（真机放行/拒绝两条，默认 skip）、`src/main/__tests__/opencode.test.ts`（钩子路由两条） |
| G7-2 | Codex 写步骤走写前审批（`app-server` JSON-RPC）：`thread/start{approvalPolicy:'on-request'}` 后，工具执行前服务端**反向请求** `item/commandExecution/requestApproval`（带 `command`/`cwd`/`reason`/`availableDecisions`），适配器交给宿主审批钩子，回 `{decision:'accept'}` 后命令**真的执行**。**拒绝只有一种表达**：命令审批的 `availableDecisions` 没有 `decline`，只能回 `cancel`，而 `cancel` 会中断整轮 → 回合判 `turn.failed`（实机确认）。无钩子/钩子抛错一律按拒绝；`app-server` 起不来时回合直接失败，**不退回 `exec`**（那条路没有审批通道）。事件翻成 SDK 方言，`CodexStreamNormalizer` 零改动；用量按线程累计值差分；多轮用 `thread/resume` 续接（只接受可信 id，否则新开线程） | `codex-app-server.ts`（`toCodexStreamEvent` / `mapItem` / `approvalToToolCall` / `buildApprovalReply` / `CodexAppServerClient`）、`codex.ts`（`setTurnApprovalHooks` + `runAppServerTurn` / `resolveAppServerPlan`）、`codex-app-server.test.ts`（23 例）、`codex-app-server-real.test.ts`（真机放行/拒绝两条，默认 skip）、`src/main/__tests__/codex.test.ts`（钩子路由三条） |
| G7-8 | 非 Claude 裸 spawn 的降级声明：非 Tier 1（无写前审批）后端不进入编排写路径；`map:execution:status` 返回 `tier`/`tierMissing`，非 Tier 1 置 `enabled=false` 并说明「只能裸 spawn（只读或人工排期）」；普通节点会话仍保持裸 spawn（完整审批桥未做） | `tier-probe.ts`、`work-execution-service.ts`（`inspectRouting`）、`ipc/map.ts`（`map:execution:status`）、`map-read-ipc.test.ts`、`agent-architecture.md` §17.5/§17.6 |
| G6-5 | 删除 unattended 30s 分支，以及只为它存在的配置项、UI 开关与测试桩；审批统一走交互式 120s fail-closed（不再有"无人值守自动放行"这条路径）。冗余关系：G6-5 = G7-12 | `agent/runtime/approval/gateway.ts`（分支已移除）；全仓 `unattended` 残留检索为空 |

> **G7-5 做了什么 / 妥协在哪**：做了什么——MCP 适配器补 `setTurnApprovalHooks`（与 Claude 同形），Driver 自动注入后，写类 MCP 工具在执行前走同一 `ApprovalGateway`（PreToolUse 审计 + canUseTool 决策 + 会话级授权），被拒即不调用 `client.callTool`；`isWriteScopedTool` 扩展 MCP 命名（`mcp__server__tool` / `server.tool` / 裸 `create_issue`）。妥协在哪——只能按**工具名动词清单**判定写语义，无法识别名字不含写动词、但语义为写的未知 MCP 工具；名字含写动词的读工具会被保守误判为写类（多弹一次审批）；MCP 无路径参数时无法命中会话级授权，每次都要重新审批。

### I.2.7 界面与交互（7）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G8-1 | `NodeMapPanel` 三件：① 任务级「待确认」角标（`task-<id>-confirmation-pending`）；② 步级确认面板与「通过 / 驳回」按钮（`step-<stepId>-confirmation` / `-approve` / `-reject`）；③ 确认后终态收敛——全部条目通过则步/任务收口，未通过按 C3/C4 分别 `cancelled` / 返工 `pending` | `NodeMapPanel.tsx`（待确认角标 + `renderStepBody`）、`StepConfirmationPanel.tsx`（面板与按钮）、`acceptance-confirmation.ts`（`confirm` 返回 `stepStatus`/`itemStatus`，全部通过即收敛）、`NodeMapPanel.test.tsx`（确认点渲染 8 用例） |
| G8-2 | **三件全绿**：① `NodeMapPanel`（M1）——执行状态 / 任务卡 / 步与 run / 会话时间线 / 证据 / 提案 / 确认点 / 修订 / 计划草稿；② **画布派生徽标**——`BizNode` 从 `mapStore.overlayByGraph` 取 `execution_state`，渲染 `canvas-exec-<id>` 徽标（title 带派生态与证据级别），`GraphCanvas` 接 `event:node-execution-state` 增量推送；③ **时间线切换**——面板列 threadIds 全集，点一条先 `loadMessages` → 再 `selectThread` → 再切右侧面板（与 `HistorySidebar` 同路径），当前会话按钮禁用并标「当前」，已结束会话可切（只读历史） | `NodeMapPanel.tsx`（面板 + `switchTimelineThread`）、`BizNode.tsx`（`execState` 选择器 + 徽标）、`GraphCanvas.tsx`（事件增量）、`mapStore.ts`（`applyExecutionState`/`overlayByGraph`）、`NodeMapPanel.test.tsx`（时间线切换 4 用例） |
| G8-5 | 任务卡四层折叠（任务→步→run→证据），默认折叠到任务级 | `src/renderer/components/map/TaskCardTree.tsx`；`NodeMapPanel.tsx` 任务级展开键 `task:<id>`、级别 `step:<id>` / `run:<id>`；`NodeMapPanel.test.tsx`「G8-5 任务卡深度」3 用例 |
| G8-3 | C3/C4 确认点渲染与出口：按步展示「为什么要确认」、后端风险原因、必填展示项、已发生决策；低风险且无决策不渲染；任务级「待确认」角标；展示内容取 `map:confirmation:status` 的 `display` 投影，按钮写 `map:confirmation:decide`（错误码中文化，成功后靠 broadcast 重拉） | `src/renderer/components/map/StepConfirmationPanel.tsx`；`NodeMapPanel.tsx`（`confirmationsByItem` 注入 `renderStepBody`）；`mapStore.ts`（`fetchWorkItemDetail` 并行拉取 + `decideStepConfirmation`）；`step-confirmation-service.ts`（`display` 投影）；`NodeMapPanel.test.tsx`「G8-3 确认点渲染」8 用例；`mapStore.test.ts`「步级确认决策」4 用例 |
| G8-7 | 按能力位的降级文案 | `agent-architecture.md` §7.5 |
| G8-9 | 证据区空态：文案为「无（该节点没有证据）」（**注意：不是**早期演练稿写的「该节点没有关联证据」，以代码为准）；会话时间线、提案区各有同形空态，读取失败与"无数据"分开显示，不生成占位内容 | `NodeMapPanel.tsx`（`node-map-evidence` section 空态分支；同文件 `node-map-timeline` / 提案区空态）、`NodeMapPanel.test.tsx`（空态断言） |
| G8-10 | 全局 `ApprovalInbox`：App 根部挂载，折叠态显示待决议条数，展开逐条给来源与「允许 / 拒绝」，决议后条目移除、失败显示错误且不假装成功。**原文「15 条审批全部可见可决议」来自 `out-run4` 演练截图，该目录全仓不存在、git 历史中也从未提交，数字不可复核**——此处只保留可复核的能力，删掉不可复核的计数 | `components/agent/ApprovalInbox.tsx`（`approval-inbox` / `-toggle` / `-item` / `-source` / `-allow` / `-deny` / `-error`）、`App.tsx`（挂载点）、`ApprovalInbox.test.tsx` |

### I.2.8 迁移与运维（12）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G9-1 | S1/S2/S5a/S6a：v26–v29 | `database.ts` |
| G9-2 | S3 归档：v30 | `database.ts` |
| G9-3 | S7 推导/草稿/偏差：v31 | `database.ts`、`plan-derivation.ts` |
| G9-4 | S8 前置五表：v32 | `database.ts` |
| G9-5 | S4 CHECK 值域重建：v33 | `s4-verify.ts` |
| G9-6 | S4 不可逆，已接受；回退仅恢复备份 | `session-map-blueprint.md` §8.6 |
| G9-7 | 半迁移续跑 `--resume-migration` | `migration-state.ts` |
| G9-8 | `RequestQueue` 已删除（`request-queue.ts` 与测试一并移除，无兼容壳） | `80075e7`；`git grep -rn RequestQueue -- 'src/**'` 为空 |
| G9-11 | schema 版本号对齐到 **v50**（`CURRENT_SCHEMA_VERSION = 50`），v38–v49 十二项迁移与 §8.2 说明逐条一致；**v50 为合并带入**（`worktree-ux-defaults-2026-10-31` 的 `project_settings`，纯新增表、不重建既有表） | `src/main/database.ts`（`CURRENT_SCHEMA_VERSION` + v38–v50 迁移块）、本文 §8.2 |
| G9-10 | worktree 定时清理：保留标记文件 + 启动时扫一次 + 每 6h 扫一次，清理受控 worktree；不误删活跃 run 的目录 | `test-executor.ts`（`startWorktreeRetentionSweep`，6h 周期）、`test-executor.test.ts` |
| G9-12 | 报告裁剪与 `import_rejections` 90 天保留 | `database.ts`、`import-dedup.ts` |
| G9-13 | Windows 路径语义在真实 NTFS 上验证：盘符前缀旁路、大小写不敏感、跨盘 `path.relative` 返回绝对路径、`\` 归一，由 CI 的 `platform-paths` job 覆盖（`windows-latest` + 断言宿主是 win32，防止整块 Windows 用例 skip 造成假绿） | `.github/workflows/ci.yml`（`platform-paths`）、`src/main/__tests__/path-windows.test.ts`、`path-utils.test.ts`、`project-path.test.ts`、`project-paths.test.ts` |

### I.2.9 文档与裁决落地（8）

| 编号 | 能力 | 代码/文档证据 |
|---|---|---|
| G10-7 | 修正总账“已批准未实施=无” | 本轮 Part I + 原 §12.13 |
| G10-8 | 修正行数快照 | `wc -l` 复核；本轮写入 |
| G10-9 | 修正 `entity_key/lifecycle_state` 仅建议表述 | 本轮 §2.2.1 更正 |
| G10-12 | 修正 §8.15 自相矛盾 | 本轮 §8.15 更正 |
| G11-7 | 成本只记账、不做自动熔断 | `agent-architecture.md` §13 |
| G11-9 | D12 异步评估时限预算本期不做 | `session-map-blueprint.md` §14.5 |
| G10-2 | **文档级**：A1 唯一性用例、A2、A9 三条验收用例登记进 §0.3.1（A1 为新增：同一 `entity_key` 跨图唯一） | 本文 §0.3.1 |
| G10-3 | **文档级**：A3（并发串行）、A4（超时）两条边界登记进 §0.3.2 | 本文 §0.3.2 |

### I.2.10 提案机制（4）

| 编号 | 能力 | 代码/文档证据 |
|---|---|---|
| G1-14 | 提案服务 + 只读视图 + UI 三层：`ProposalService`（create/list/diff/accept/reject/expireStale）、`v_online_proposals`、`NodeMapPanel` 提案区；提案全程不写 online 图 | `src/main/map/proposal-service.ts`、`schema.ts`（v40）、`ipc/map.ts`、`NodeMapPanel.tsx` |
| G2-6 | 提案细节：`conflict_group` 串行（后者 blocked，前序终态后提升）、`weight` 0–1 仅影响展示排序、同实体并发上限 3、blocked 超 24h 自动取消 | `proposal-service.ts`、`database.ts`（启动 + 每日 `expireStale`） |
| G2-19 | 只读通道 `proposal:list` / `proposal:diff`；采纳/驳回写通道，驳回理由必填；列表 → diff → 采纳/驳回，不批量 | `shared/types/ipc.ts`（`MAP_READ_ONLY_CHANNELS`）、`preload/index.ts` |
| G8-4 | 复用 `NodeMapPanel` 弹层做提案列表与 diff 可视化（只读、不批量；采纳/驳回为人工确认动作） | `NodeMapPanel.tsx`、`mapStore.ts` |

### I.2.11 模式路由（1）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G2-1 | 模式库为代码常量（4 个模式、上限 32、id 唯一校验），`routing_decisions.mode_id` 落库，执行前按执行器 + policy 匹配，无匹配 `TIER_UNSUPPORTED`；`mode:list` 只读 | `src/main/map/mode-registry.ts`、`work-run-service.ts`（`record`）、`agent-step-runner.ts`（`ensureRouting`）、`schema.ts`（v41） |

### I.2.12 进化记录层（4）

| 编号 | 能力 | 代码证据 |
|---|---|---|
| G2-16 | 离线校准报告（v49）：`maybeRunCalibration` 按「距上次报告新增 ≥20 run 或满 2 周」触发，样本 <20 不出报告；按 `(derivation_version, observed_rule_version, task_type, agent_type)` 聚合实际/计划文件数与子任务数、replan 中位数、返工/测试失败/越界/边界变化；只写 `map_migration_reports(kind='calibration')` 一行，不改阈值/权重；启动 + 每日检查；报告可复算（纯聚合） | `src/main/map/plan-calibration.ts`（`aggregateCalibration` / `maybeRunCalibration`）、`src/main/database.ts`（v49 CHECK + 启动/每日调用）、`migration-state.ts`（`MapMigrationKind`）、`plan-calibration.test.ts` |
| G2-4 | Layer2 派发精度归因（v46）：只读视图 `v_memory_attribution`，强制经 `node_session_links.session_origin='map_task'`；输出 adapter/mode_id/outcome/hit_count/evidence_level，按 `(graph_id, adapter, mode_id)` 算 `sample_size`，<20 标 `insufficient_sample` | `src/main/map/schema.ts`（`MAP_VIEW_SCHEMAS` / v46） |
| G2-2 | Layer1 采集（v45）：五个 run 终态（completed/failed/timed_out/cancelled/interrupted）同步采集 step/evidence/deviation 引用，写 `source_outcome`；每 run ≤50 条、幂等；失败写 `map_migration_reports(kind='integrity_check', stage='memory:<runId>')` 且不回滚 run | `src/main/map/memory-evolution.ts`、`work-run-service.ts`（`recordMemoryForRun` + 五个终态调用）、`memory-hit-service.ts`（`source_outcome`）、`schema.ts`（v45） |
| G2-3 | `memory_hits` 记录表（v44）：只存引用不存全文；幂等唯一索引 `(run_id, hit_kind, source_ref)`；`hit_kind` 四值 CHECK、`score` 0–1 CHECK；保留治理 180 天 / 单项目 20 万（启动 + 每日 `pruneMemoryHits`） | `src/main/map/schema.ts`（`MAP_MEMORY_TABLE_SCHEMAS` / `MAP_MEMORY_INDEX_SQLS`）、`src/main/map/memory-hit-service.ts`、`src/main/database.ts`（v44 + 启动/每日 prune） |

---

## I.3 未实施清单与可施工方案（9 条未实施 → 12 个 W 包）

> 口径：**条目本身不合并**，每条保留 G 编号；下发施工时按 W 包排期，包内条目逐条验收。标记 `[批准]` 的进入本期/近期计划，标记 `[建议]` 的属 L3，不进入本期验收；标记 `[已实施]` 的是**包内复核记录**（保留在原 W 包里说明"这条已关"），不构成待办。
>
> **v3.19 计数更正**：标题原写「55 条」、W 包内仍有多条 `[建议]` 与 I.2 的「已实施」对撞（G5-10 / G7-8 / G2-16 / G2-15 四处）。现统一为：**未实施 9 条**（I.1.2）+ 仅建议 5 条（I.1.3），W 包只作为**施工组织方式**，不再充当计数单位。四处 `[建议]` 已改 `[已实施]`——照旧排期会把做完的四件事重做一遍。

### W1 地图对象与状态回写
- 覆盖条目：G1-5 `[已实施]` 双轨自动写路径关闭（本包复核，仅改文档）、G1-6 `[已实施]` `needs_input` 回写（本包复核，仅改文档）、G1-7 `[已实施]` `outputs/parse/partial/文件变更`、G1-8 `[已实施]` 子 work_item 聚合、G1-13 `[已实施]` 新建图进 doc 池、G1-11 `[建议]` `agent_turns.node_id` 放宽（评估无伪节点证据，维持仅建议、不改 schema）。
- 目标：让 `work_steps/work_runs` 的观测字段与真实 turn 完全对齐；`nodes.status` 只由人写；Yjs doc 池与新建图一致。
- 涉及文件与数据/接口变更：`src/main/map/work-execution-service.ts`、`src/main/map/agent-step-runner.ts`、`src/main/map/work-item-service.ts`、`src/main/agent/runtime/db/schema.ts`、`src/main/realtime/snapshot/yjs-realtime.ts`。新增 `needs_input` 信号到 `TurnOutcome`；`output_json` 增加 parse/partial/usage/fileChanges 四段；`parent_work_item_id` 聚合查询。
- 实施步骤：① 在 turn 完成回调写入 `needs_input`（`input_request_json`）；② 解析输出并写 `output_parse/partial/usage`；③ 文件变更从 ScopeGuard 结果落 `change_sets`；④ 子任务终态聚合到父任务；⑤ 关闭两条自动写 `nodes.status` 路径；⑥ 新建图时加入 doc 池。
- 验收标准：`needs_input` 在 turn 结束前可见且人工确认后可恢复；`output_parse` 三态齐全；父任务在全部子任务终态后才终态；`git grep "UPDATE nodes SET status"` 只剩人工路径；新建图在 WS 开启时可同步。
- 依赖与建议顺序：W1 → W2 → W3；`node_id` 放宽最后做（需先确认无伪节点）。
- 风险与回滚：新增写回可能与旧 `output_json` 消费者冲突 → 加字段不删字段；`node_id` 放宽会削弱约束 → 先加 D8 迁移脚本与回滚备份。
- **施工注记（2026-11-08，W1 完成）**：G1-5/G1-6 经代码复核**确已实施**，本包只纠正状态词、未改代码。G1-7 按 §5.9.7 **分散落点**接线：`outputs → work_runs.outputs_json`、`outputParse → work_runs.output_parse`、`partial → work_runs.partial_output_ref`、文件变更 → `change_sets.files_json`、`usage` 仍由 runtime 写 `agent_usage`；**不改** `agent_turns.output_json`，**不重复写** usage。生产端接在 `agent-step-runner.ts` 的 `complete/fail/timeout` 透传（`parseStepOutputs` L175、`runOutputData` L207、`buildPartial` L471、`recordChangeHead` L443），取基/取头经新增 `workspace-change-stats.ts`；无 schema 时不伪造 outputs、不写空对象。G1-8 采**方案 B**：父任务处于 `draft/awaiting_confirm/queued/running` 时可被子任务全终态带进终态，`needs_human/blocked/needs_input/paused/interrupted` 不覆盖；聚合口径 `failed > cancelled > done`（`superseded` 按 cancelled 计）；触发点为 `transition()` 终态后与 `convergeIfTerminal()` 收口后，均调用 `convergeParentChain` 向父链上推（`seen` 防环、条件 UPDATE 幂等）。**父任务 gate 被绕过是方案 B 的有意行为，不是缺陷**；G1-13 在 WS `getDoc` 走 `getOrLoadDoc`，装载前先校验 `graphs` 行存在，避免为不存在的图造孤儿 doc。G1-11 维持**仅建议**：真实库 `agent_turns` 0 行、历史证据库各自指存在节点，无伪节点证据，故不动 `node_id` 约束。本包**不升 schema**（`CURRENT_SCHEMA_VERSION` 仍为 35），**不提交 git**。

### W2 证据闭环
- 覆盖条目：G1-9 `[已实施（v43）]` E4 覆盖变化扫描、G1-10 `[已实施]` `evidence_suggestions`、G3-10/G5-3 `[已实施]` E1 人工判断直写通道、G5-8 `[已实施]` 建议转证据事务/去重、G5-9 `[已实施]` 等级字段组合校验、G5-10 `[已实施（v47）]` 项目进度只读查询。
- 目标：agent 回合产生的候选证据可被建议、可被人工接受、可复扫失效；E1 由人工直写、E4 有 IPC 写通道。
- 涉及文件与数据/接口变更：`src/main/map/evidence-service.ts`、`src/main/ipc/map.ts`（**设计稿原列的新文件 `src/main/map/evidence-derivation.ts` 实际未创建**，建议写入最终并入 `evidence-service.ts` 的 `EvidenceSuggestionService`）；新增 `evidence_suggestions` 表与迁移；新增 `evidence:suggest` / `evidence:accept` / `evidence:scan` 通道。
- 实施步骤：① 建 `evidence_suggestions` 表 + CHECK；② 建议写入去重键（node+kind+source_ref）；③ 接受时事务内转 `node_evidence` 并写审计；④ E4 增加内容哈希 `content_hash` 与复扫任务；⑤ IPC 补写通道与参数校验。
- 验收标准：同一建议重复写入不产生第二行；接受后证据可见且 E4 覆盖变化触发 `stale`；IPC 未授权调用失败并留痕。
- 依赖与建议顺序：依赖 W1 的 turn 输出；E4 扫描建议最后做（需要哈希基线字段）。
- 风险与回滚：E4 自动降级误伤人工签收 → 扫描只标 `stale` 不自动删除；新表迁移可安全保留。
- **施工注记（2026-11-08，W2 首批：`node_evidence` 写入面）**：已落两条写方——① agent 回合完成（机器验收通过或仅剩 manual 待确认）写 E2 `session_turn`，`current_hash` 取**执行后项目工作区**的 `HEAD^{tree}` + 未提交文件 sha256 聚合值，取不到指纹则不写（不写 null、不挪用别处哈希）；② 人工验收全部收口时写 E4 `human_confirm`，`current_hash` 对得上产物文件实际 sha256（单文件直接取该文件哈希；多文件取逐文件哈希清单的聚合值，逐文件 sha256 另落 `basis_ref_json`）。两条路径仍只经 `EvidenceService.create`；写入在 step/run 终态事务提交之后，失败只落 `map_migration_reports`（`kind='integrity_check'`、`stage='evidence_write:<stepId>'`）诊断，不回退已完成的 step，（2026-11-09 起按 C 口径分流：机器全过直写、manual 待确认走建议，见下条）因此**不新增表/列/索引，`CURRENT_SCHEMA_VERSION` 仍为 35**。
- **与设计的两处差异（按代码事实记录）**：①（**已按 C 口径收口，2026-11-09**）§3.7.1 曾要求 agent 候选一律经 `evidence_suggestions` 接受后转 `node_evidence`；现行口径按验收性质分流——**全部条目机器可判定且通过**（command/file_check，manual 0 条）时直接写 E2、`produced_by='system'`，因为此时结论来自机器实际执行而非 agent 自称，`ref_json.acceptance` 记录逐条结果可复核；**存在 manual 待确认**时只写建议，人工接受才转证据；② 本文档所称“E4 禁止代码 hash”在代码里仅指 `code_version`，`current_hash` 不在 E4 的禁止列内，故 E4 写产物哈希不违反约束。覆盖条目 G3-10/G5-3 已于 2026-11-09 按 E1 口径收口（见下条注记）。
- **施工注记（2026-11-09，G1-10/G5-4/G5-8 收口，schema v37）**：`evidence_suggestions` 按 §7.2 DDL **逐字**建表（`suggested_level` E1–E4 CHECK、`status` pending/accepted/dismissed CHECK、`confidence` DEFAULT 0.5），索引 `idx_evidence_suggestions_status(graph_id,status)`；状态域与列不增不减。服务层新增 `EvidenceSuggestionService`：① **去重**按「节点 + evidence_type + 来源」——有 run 用 `produced_by_run_id`，无 run 用 `ref_json`，只保留一条 `pending`（不新增蓝图外唯一索引）；② **接受**在 `db.transaction` 内先条件更新建议（`WHERE status='pending'`）再调用 `EvidenceService.create`，任一步失败整体回滚；证据 `produced_by='agent'`（来源是 agent 回合）、`actor='human'`（裁决人），`ref_json` 追加 `suggestionId`，重复接受按该字段反查既有证据返回 `reused=true`，不写第二行；③ **驳回**只改状态，重复驳回幂等；④ **E3 建议拒绝接受**（只能 TestExecutor 写，禁止人工点击洗成可复现证据）。Agent 回合按 **C 口径分流**（`agent-step-runner.ts` 的 `recordTurnEvidence`）：**机器全过**（`succeeded` 且每条均为 command/file_check、outcome=pass、manual 0 条）→ 直写 E2 `node_evidence`（`produced_by='system'`，`ref_json.acceptance` 记录逐条验收结果与执行指纹）；**含 manual 待确认**（`needs_input`）→ 只写 `pending` 建议，人工接受才转证据；**验收失败/未注入验收/缺节点或项目/取不到执行指纹** → 什么都不写。IPC 只开必要通道：只读 `map:evidence:suggestions:list`，写 `map:evidence:suggestion:accept` / `:dismiss`；幂等键均为建议 id，`resolvedBy` 必填作为审计主体，仅 preload 白名单内的本地 renderer 可调用；蓝图原列的 `evidence:suggest` 无真实调用方（唯一来源是 agent 回合内直写服务）、`evidence:scan` 归 G1-9 未实施，故**不开空壳通道**。迁移为纯建表（`CURRENT_SCHEMA_VERSION` 36 → 37，无数据迁移），由 `database-migration.test.ts` 的 v33 升链用例断言表/索引存在、版本为 37；链路证据见 `evidence-suggestions.test.ts` 与 `agent-step-runner.test.ts`。G3-10/G5-3 的 E1 口径见下条注记（2026-11-09 收口）。
- **施工注记（2026-11-09，G3-10/G5-3 收口，E1 口径裁决）**：用户裁决 E1 只能来自人，agent 不得起草 E1（判断走文本，不进证据/建议）。落地：① `SUGGESTION_LEVELS` 移除 E1，agent 路径只产 E2 建议（`agent-step-runner.ts` 本就只建议 E2）；② `accept()` 显式拒绝历史 E1 建议，避免人工点击把 agent 推断洗成 E1；`toEvidenceInput` 的 `produced_by='human'` 分支只保留 E4；③ 新增 `EvidenceService.createHumanJudgment`：等级固定 E1、`actor/produced_by='human'`，沿用既有校验（`ref_json` 非空、`summary` 必填），`ref_json` 指向被判断对象，不新增列；可选 `idempotencyKey` 存 `ref_json.idempotencyKey`，按 `json_extract` 反查同图同节点既有 E1 返回 `reused=true`；④ IPC 新增写通道 `map:evidence:e1:create`（`ipc/map.ts` + `shared/types/ipc.ts` + preload 白名单 + 结构化错误），只收 `graphId/nodeEntityKey/nodeId?/projectPath?/summary/ref/idempotencyKey?`，不接收 `actor/producedBy`，仅本地 renderer 可调；⑤ **renderer 入口（节点/证据面板手写 E1）归 G8**，本包不做，数据/服务侧已就绪；⑥ 库层 `suggested_level` CHECK 仍含 E1，仅用于兼容历史行，写入侧由服务层收口，不做 v38 迁移。测试：`evidence-suggestions.test.ts` 新增 4 例（拒绝建议 E1、历史 E1 建议拒绝接受、人工直写字段固定与必填、idempotencyKey 幂等）。G3-10/G5-3 状态改为「已实施」，计数 73/13。
- **施工注记（2026-11-09，G5-9 收口）**：`EvidenceService.create` 在库层 CHECK 之外补齐应用层组合校验：`ref_json` 缺失（含显式 `null`）拒绝；E1 必填 `summary`；E1/E2 拒绝混入 `code_version/code_dirty/signed_by/coverage`；E3 拒绝 `signed_by/coverage`；E4 拒绝 `code_version/code_dirty`（`current_hash` 仍作产物内容绑定放行，与 `acceptance-confirmation.ts:313` 一致）。**未做**：§3.7.1 的「ref_json 每个引用可解析」（文件/提交/测试存在性）与 E4 `acceptance_ids` 是否真实存在于 work_item acceptance——这两项需跨表解析口径，仍留在 W2 后续。G5-9 状态由「已批准未实施」改为「已实施」，计数 65/21。

- **施工注记（2026-11-10，G1-9 收口，schema v43）**：新增 `node_evidence.coverage_baseline_json` 与 `stale_reason`（均可空、仅 `addColumnSafe` 补列、不进 `requiredColumns`）。① **基线**：`captureCoverageBaseline` 在 `EvidenceService.create` 的 E4 分支内采集——对 `coverage[].files` 逐文件算 `sha256`（相对 `project_path`、只收仓库内普通文件、按 §3.5 不做整树 Merkle），并从锚定 `work_item` 抄 `scope_files` 与 `acceptance_json` 条目 id 作范围快照；既无文件也无范围时不写基线（NULL = 历史行，扫描跳过）。② **扫描**：`scanCoverageChangedE4All` 与 `scanExpiredE4All` **并列且独立**（独立 SQL、独立入口、`stage='e4_coverage'`，互不引用），启动后 + 每日一次，单轮 `LIMIT 500`，只更新 `freshness='fresh'` 行（幂等）；内容不一致或文件缺失 → `coverage_content_changed`，范围快照不一致 → `coverage_scope_changed`，内容优先；**统一置 stale，不自动撤销**（裁决：范围比对是启发式的，撤销几乎不可逆）。③ `current_hash` 只作预筛思路、不作基线（聚合值无法回答哪个文件变了，且手工 E4 无值）；`tree_hash` 只对 E3 开放、E4 不可复用。④ 到期扫描同步补写 `stale_reason='expires_at'`，两条判据从此都能从同一列区分。**已知妥协**：>200 文件 / 无 `project_path` / 采集异常只记 `skipped`，不改 `freshness`（I.9.3）；范围比对不比 revision 号（避免"仅换 revision"误报），也不会检测"文件被新增"（基线只覆盖签收时声明的文件）。回滚：列保留不读、扫描调用点摘除即回到只有时间过期。

### W3 执行守卫与入口
- 覆盖条目：G3-4 `[已实施]` `priority DESC`、G3-5 `[已实施]` 存量自由文本 acceptance、G3-6～G3-9 `[已实施]` 超时预算、G3-1 `[已实施]` Tier1 探测、G3-2 `[已实施]` 跨进程写闸、G3-3 `[已实施]` renderer 入口（=G8-6）。
- 目标：调度有优先级；跨进程不双写；预算键可配置且被消费。
- 涉及文件与数据/接口变更：`src/main/map/work-execution-service.ts`、`src/main/map/work-scheduler.ts`、`src/main/map/work-item-service.ts`、`src/main/map-migration/legacy-acceptance.ts`（新增）、`src/main/agent/agent-manager.ts`、`src/main/agent/subagent-manager.ts`、`src/main/agent/send-and-wait.ts`、`src/main/agent/timeout-config.ts`（新增）、`src/shared/types/agent-runtime.ts`；`work_items` 加 `priority`（可空、不进 requiredColumns）；`map_acceptance_migration_archive`（新增，迁移原文存档）；`agentRuntime.timeouts` 增加 `turnMs/stepMs/taskMs/sendWaitMs`。
- 实施步骤：① 迁移加列并按 `priority DESC NULLS LAST, created_at` 排序；② 迁移存量 acceptance 为结构化 `acceptance_json`（**不是** `items_json`：`items_json` 属于 `plan_drafts`）；③ 预算键接入 `work-execution-service`、`agent-manager`、subagent 与 send-and-wait；④ 跨进程写闸复用 runtime workspace lease（已实施，G3-2）；⑤ renderer 入口已实施（G3-3/G8-6）。
- 验收标准：优先级排序用例通过；预算到期产生 `timed_out` 终态；存量 acceptance 迁移后可过 gate 且 manual 仍需人工确认；Tier 探测、跨进程写闸与 renderer 入口已纳入验收（G3-1/G3-2/G3-3）。
- 依赖与建议顺序：W3 可在 W1 之后独立推进；Tier1 探测、跨进程写闸与 renderer 入口均已落地（G3-1/G3-2/G3-3）。
- 风险与回滚：改排序影响现有队列 → 先保持 `queued` 优先、`priority` 可空，NULL 行为等价旧序；加列不重建表。存量 acceptance 迁移可回滚（原文逐行存 `map_acceptance_migration_archive`，回滚 SQL 见该表建表注释与审计行）。
- **施工注记（2026-11-08，W3 完成，schema v36）**：G3-4 加 `work_items.priority INTEGER`（可空、不进 `requiredColumns`；存量库 `addColumnSafe` 纯加列，不重建表）。两处候选查询（`work-scheduler.ts` 预选、`work-execution-service.ts` tick 选候选）统一为 `CASE status WHEN 'queued' THEN 0 ELSE 1 END, CASE WHEN priority IS NULL THEN 1 ELSE 0 END, priority DESC, created_at ASC`：`queued` 优先不变，未设优先级的行仍按创建时间，等价旧序；因此现有队列不会被重排。回滚 = `priority` 全置 NULL（等价旧序）或保持列不用，无需重建表。
  G3-5 按 **方案 B** 自动迁移存量自由文本 acceptance（`[{id,text}]` / 纯字符串）：逐行判定，**非结构化行以外一律不动**；已是结构化（任一 entry 带 `type`）、非法 JSON、空数组、终态（`done/failed/cancelled/superseded`）、已归档、混合行（部分有 `type`）均不迁移。迁移条目为 `{id, type:'manual', expected:<原文>, text:<原文>, provenance:'legacy_free_text'}`；id 保留原值、缺失用 `acc_<序号>`、重复加 `_2/_3` 后缀；纯空白 text 丢弃，全部为空则该行不动。原文逐行写 `map_acceptance_migration_archive`（按 `work_item_id`+revision 精确定位，非 `*_backup` 命名以免被孤儿备份启发式误判）；迁移行数与各类跳过数、版本、时间、判定依据写入 `map_migration_reports(kind='derivation', stage='legacy_acceptance')`。全程在 v36 迁移的同一事务内完成（加列与数据迁移同版本：避免「列已加、数据未迁」成为可启动的中间态）。
  G3-6～G3-9 在 `settings.agentRuntime.timeouts` 增设四键，统一由 `timeout-config.ts` 解析（未配置 = `DEFAULT_AGENT_TIMEOUTS`，行为不变）：`turnMs` 消费于 `AgentManager.sendCommandThroughKernel`（无显式 deadline 时）；`stepMs` 写 `work_runs.deadline_at` 并由 tick 前置 `sweepDeadlines()` 收口为 `timed_out`；`taskMs` 以该任务最早一次 `work_runs.started_at` 起算（排队时间不计、不新增列），到期同样扫描收口并取消同 item 的 queued run；`sendWaitMs` 消费于 `send-and-wait.ts` 的等待上限，并 clamp ≥ `turnMs + 30s`。subagent 继承：`SubagentManager` 取 `min(stepMs, 父 turn 剩余)`，父 deadline 由 `AgentManager.getSessionTurnDeadline()` 提供（`AgentCommand.deadlineMs` 同步下发给子 turn）。配置在启动装配期读取，运行中修改需重启生效。G3-1/2/3 已于 2026-11-10 前分别落地（G3-1 见 v3.5）。

### W4 测试体系补全
- 覆盖条目：G4-6 `[已实施]` allow-list harness、G4-7 `[已实施]` P1–P9 脚本、G4-8 `[已实施]` P6 并行验证、G4-9 `[已实施]` CI vitest（`217fbbc`，2026-11-08）、G2-11 `[已实施·测试-only]` 流程测试最小版（v3.10 按集成测试收口）、G2-12 `[建议]` 定向重测、G2-13 `[已实施]` published 软阻断（v39，`published-guard.ts`）。
- 目标：测试资产从“单节点可执行”升级到“流程可验证”，迁移验收可自动跑。
- 涉及文件与数据/接口变更：`src/main/map/test-executor.ts`、`src/main/map/test-plan-service.ts`、`tests/migration/*`、`.github/workflows/ci.yml`。~~`src/main/map/flow-test-service.ts`（新增）~~ —— **设计稿遗留，已被 II-13 收窄取代**：不做 flow 计划生成，实际落地为 `src/main/__tests__/flow-test-integration.test.ts`。
- 实施步骤：① P1–P9 逐条脚本化并接入 CI；② 补 `vitest` job；③ 流程测试最小版：框选→拓扑→verify+shell→`test_report`；④ 定向重测按失败用例集合重跑；⑤ published 软阻断读取 `has_pass_evidence`。
- 验收标准：CI 上 P1–P9 全绿；流程测试能产出 `test_report`；定向重测只跑受影响用例；无通过证据的 published 节点出现阻断徽标。
- 依赖与建议顺序：P1–P9/CI 先做；流程测试与定向重测属 L3-a，本期只做设计确认。
- 风险与回滚：CI 增加单测可能暴露存量失败 → 先以 `continue-on-error` 观测一周再卡门。

### W5 Agent M2 核心
- 覆盖条目：G6-1 `[已实施]` M2 六项、G6-2 `[已实施]` 50ms 批写、G6-3 `[已实施]` 快照写入、G6-4 `[已实施]` 三文件落地（`dc51b48` / `80075e7`）、G6-11 `[批准]` U1–U9（harness 已就位）、G6-12/G6-13 `[已实施]` R3/打包、G6-14 `[已实施]` Claude token 统计（v3.25 实测）、G6-15 `[已实施]` OpenCode 轨迹（v3.30 实测）、G6-16 `[批准]` Codex provider、G6-18 `[已实施]` C13b。
- 目标：把 runtime 从“可用”推到“可恢复、可观测、可打包”。
- 涉及文件与数据/接口变更：`src/main/agent/runtime/` 下新增 `executors/acp-executor.ts`、`startup-reconciler.ts`、`locks/workspace-lease.ts`（**均已落地**）；`request-queue.ts` **已删除**；事件写入批处理；`agent_snapshots` 增加生产写入方。
- 实施步骤：① 先补 startup-reconciler 与 lease（已完成）；② 事件写 50ms 批处理并加 flush-on-exit（已完成）；③ 快照写入/读取（已完成）；④ chat 路径迁入 runtime（已完成，模块级验证）；⑤ 删 RequestQueue（已完成，`80075e7`）；⑥ 评测 harness（已完成，`tests/eval`）；⑦ 打包验证（arm64 已完成）与 Codex/OpenCode 真机矩阵（缺 CLI/凭据，未做）。
- 验收标准：崩溃恢复只依赖事件回放且可验证；批写不丢事件；快照可恢复一个 turn；打包后三后端可启动；U1–U9 有实测记录。
- 依赖与建议顺序：W5 与 W1 独立，建议在 W8 审批覆盖之前做。
- 风险与回滚：批写引入丢失窗口 → 保留同步 flush；`RequestQueue` 已于 2026-11-09 删除，无回滚对象（见下方 C2 注记）。
- **施工注记（2026-11-08，阶段 A+B，提交 `dc51b48`，19 文件 +2356/−220）**：① `startup-reconciler.ts` 增加 `proveOwnership` 预检——不可证明归属时 `killCalls=0`，并把 Codex 旧路径 / 已跑 turn 但无句柄无 marker 的 session 标 `residual_risk='unconfirmed'`；② `locks/workspace-lease.ts` 以 `wx` + rename 原子抢占、TTL/stale、同进程重入，灰度键 `BIZGRAPH_WORKSPACE_LEASE`；③ `event-batch-writer.ts` 关键事件同步、delta 50ms 批写、shutdown flush，灰度键 `BIZGRAPH_EVENT_BATCH_WRITER`；④ `executing_at` 三阶段落在归一化事件写入点（`tool.requested` 写 `executing_at`、`approval.resolved allow` 写 `approved_at`，等待审批阶段不写）；⑤ `runNode` 生产写 `agent_snapshots`（仅元数据 + `promptHash`），恢复期只读；⑥ `applyRecoveryPlan` 支持 `terminalStatus`，`aborted` step 全部进 `stepOutcomes` 并回填 `unknown-needs-rerun`；planner 补 turn 级 `queued/waiting_approval/running/cancelling` 判定，保持只读。**证据口径：模块级已验证，端到端待真机。**
- **施工注记（2026-11-09，阶段 C，提交 `80075e7`，11 文件 +1201/−330）**：① 新增 `runtime/executors/acp-executor.ts`，实现与 `adapter-driver.ts` 相同的 `BackendDriver` 契约（`initialize` / `session/new` / `session/prompt` / `session/cancel`），把 `session/update` 映射为归一化 `agent_events`，`session/request_permission` 交 `ApprovalGateway` 做写前强制审批；子进程同样 `context.registerProcess`，复用同一套回收链路，**没有第二套执行路径**。② chat 发送路径按能力集门控：`claude` / `acp` 走 kernel 并带写前审批；清单外后端、driver 未注册、Runtime 未装配、未挂载节点（D8 纯 thread）各自打显式 `[kernel-skip]` 日志回旧路径，**不静默降级**。③ 能力集 `KERNEL_APPROVAL_CAPABLE_BACKENDS = ['claude','acp']`。④ 删除 `request-queue.ts` 及其测试（D-07 fail-fast，无兼容壳）。**事实记录：当前仓库没有名为 `acp` 的 `AgentAdapter`，ACP driver 只在设置 `BIZGRAPH_ACP_COMMAND` 时注册生效；因此今天可证的 chat kernel 路径仍是 `claude`。** 证据口径：模块级已验证（真实子进程假 ACP agent + `AgentManager.sendCommand` 路由单测），**端到端待真机**。
- **修复注记（2026-11-09，阶段 C 真机演练收口，与本轮修复同一提交）**：① `AgentRuntime.markSessionClosed()` 在会话正常终止后把 `agent_sessions.status` 落为 `closed`（恢复账本无该会话行时 no-op，不凭空建行），由 `AgentManager.mirrorEnd` 统一调用，覆盖正常收尾/异常退出/批量终止；否则正常退出遗留的 `active` 行会被下一次启动 planner 兜底误判为 `orphaned`。② `planRecovery()` 的 `orphanedSessions` 改为按全部 `mark_session_orphaned` 计划去重计数，与 `applyRecoveryPlan` 实际落库数量一致；此前只统计「有非终态 turn 的会话」，漏计两个兜底循环标记的无 turn `active/starting` 会话。定向测试见 `src/main/agent/runtime/__tests__/recovery.test.ts`。**证据口径：模块级已验证 + 真机演练 C 复跑通过**（S1 退出前 `active` → 退出后 `closed`，下次启动不再判 orphaned；注入无 turn 的残留 `active` 会话 → `orphaned`；payload `orphanedSessions=1` / `reclaimedSessions.length=1` / `killCalls=0` / `residualRiskSessions=1`；事件 seq 无断裂、UNIQUE 错误 0；真实库 mtime/sha256 未变）。
- **施工注记（2026-11-09，阶段 D：评测 harness / 打包 / 后端矩阵）**：① **评测 harness 已就位**：`tests/eval/agent-eval.test.ts` + `harness.ts`，`npm run test:eval`，U1–U9 与 R3 各自判 PASS/FAIL/SKIP 并落 `test-results/agent-eval-report.json`。实测 **R3/U3 PASS**：先确认 root `better-sqlite3` 在 Node ABI 115 下可加载（Electron ABI 130 已切回，不把绑定错误当性能结论），WAL 文件库回放 10,000 条 `message.delta` → 全部落库、seq 连续，**maxLag=2ms、p95 写入≈0ms、总时长=70ms**（阈值 500ms / 20s）；**U8 PASS**：真实子进程取到 pid + startedAt + 命令行，`proveOwnership` 命中 `startedAt+command`（范围 macOS 非打包）；**U4 PASS**（见②）。**U1/U2/U5/U9 SKIP**：分别缺 Codex 官方 provider key、`opencode` CLI、Anthropic 付费凭据/成本授权、root 第二 uid；**U6 SKIP**：RequestQueue 已删，不适用；**U7 SKIP**：非 macOS/打包环境取消用例未接。② **打包验证（G6-13）**：`npx tsc && npx vite build && npx electron-builder --mac dir --arm64` 真实产出 `release/mac-arm64/BizGraph.app`（Electron 33.4.11，未签名）。**解包已改为显式声明**：`package.json` 的 `build.asar.smartUnpack=false` + `build.asarUnpack` 最小路径集（`claude-agent-sdk/sdk.mjs`、`claude-agent-sdk-darwin-*`、`codex-sdk/dist/index.js`、`codex/package.json`、`codex/bin/**`、`codex-darwin-*`、`better-sqlite3/build/Release/better_sqlite3.node`、`onnxruntime-node/bin/**`）；此前依赖 electron-builder `smartUnpack` 的「二进制/原生文件命中即整包解包」规则，自动解出 82 个文件 / 504MB（含 better-sqlite3 全量与 onnxruntime 全平台）。复验：`app.asar` 内 `sdk.mjs` / `codex-sdk/dist/index.js` / `codex.js` 入口仍在，`app.asar.unpacked` 的 `claude 2.1.286` / `codex-cli 0.135.0` 均可执行 `--version`；解包面 504→485MB、asar 935→959MB（总量持平），解包文件 82→23（新增 4 个显式项，减少 63 个冗余文件）；`ELECTRON_RUN_AS_NODE` 经 `app.asar` 加载 better-sqlite3（ABI 130）可查询。**限制：只验 arm64 dir；x64/Windows 未验。** 新增 SDK/CLI 时在 `build.asarUnpack` 补其源路径（匹配源树路径；平台包在打包后才被安置到嵌套 `node_modules`）。**构建后校验已脚本化并接入流水线**：`scripts/verify-packaged-agent-runtime.mjs`（`npm run verify:packaged`）自动发现 `release/*/BizGraph.app`，断言 ① `app.asar` 内 `sdk.mjs` / `codex-sdk/dist/index.js` 条目存在；② `app.asar.unpacked` 内 `claude` / `codex` 可执行且 `--version` 含期望版本（期望值优先取源码树同款二进制的输出，取不到才退回常量，避免 SDK 升级后误报）；③ `better_sqlite3.node` 与当前平台/架构的 `onnxruntime_binding.node` 存在；失败逐条打印「检查项 / 期望 / 实际」并 exit 1。落点选择：本地由 `npm run build:mac` 末尾自动串联（macOS 专属构建脚本，不会漏跑）；CI 挂在 `build` job 的 `npm run build` 之后，用 `if: runner.os == 'macOS'` 限定——该 job 是跨 OS 矩阵，通用 `npm run build` 在 Linux/Windows 上不产 mac 产物，条件步避免误跑。**该检查仅覆盖 macOS 构建；Windows/Linux 产物未覆盖。** 正例 8/8 PASS（2026-11-09 对 `release/mac-arm64` 实测），负例（`--app /tmp/nope/BizGraph.app`）按「产物目录 / 期望 / 实际」输出并 exit 1。 ③ **D-08 落地（Codex 默认流式）**：`CodexAdapter.defaultRawStreamMode()` 默认 true，新增回退开关 `BIZGRAPH_CODEX_STREAMING=0|false|no|off` 回到阻塞 `thread.run()`；`codex.test.ts` 14/14 覆盖默认流式与回退。④ **矩阵结论**：G6-14（Claude token）**已于 v3.25 用 cc-switch GLM 代理实测通过**（U5 由 SKIP 改为真实回合，见下条注记）——原判断「`src/` 无 `includePartialMessages` 开关」不再是阻塞：token 统计验的是 `result.usage` 落库，不需要 partial 流；仍未验的是 Anthropic 官方计费口径；G6-15（OpenCode 轨迹）**当时未验证**——PATH 无 `opencode`，适配器仍为 `-q` 纯文本单次执行（**v3.30 已收口**，见 I.2.5）；G6-16（Codex provider 差异）**未验证**——缺官方 provider 凭据，不把第三方 provider 的 `item.updated=0` 当结论。⑤ **G6-18（C13b）已验证**：`registry-hardening.test.ts` 12/12，含 4 条 symlink / 普通文件 / 只读目录用例。

### W6 Agent 恢复与旧路径
- 覆盖条目：G6-5 `[已实施]` unattended 分支已删除、G6-7 `[批准]` Codex 无句柄、G7-9 `[批准]` legacy `onBashPolicy`、G7-10 `[已裁决不做]` 旧路径无 turn 时间线（§4.5.1a）。
- 目标：残留进程风险可解释；旧路径审计不断链（无人值守分支已删除，不再作为施工目标）。
- 涉及文件与数据/接口变更：`src/main/agent/agent-manager.ts`、`src/main/adapters/*`、`src/main/agent/runtime/approval/*`；`residual_risk` 展示字段。
- 实施步骤：① 已完成：删除 unattended 分支及仅供其存在的 30s 配置/UI/测试桩（G6-5）；② Codex 旧路径记录 pid/pgid/startedAt；③ 接线 `onBashPolicy`；④ 旧路径补 turn 开始/结束事件——**G7-10 已裁决不做，④ 不施工**。
- 验收标准：Codex 残留会话 `residual_risk` 与 UI 一致；legacy 工具调用有审批记录；旧路径**不要求** turn 时间线（G7-10 已知限制）。
- 依赖与建议顺序：依赖 W5 的 runtime 事件模型。
- 风险与回滚：无人值守审批当前无实现；将来需要时重新设计并单独裁决，不从旧分支恢复。

### W7 审批覆盖扩展
- 覆盖条目：G7-1 `[批准]` 写前审批覆盖边界、G7-2 `[已实施]` Codex gateway（v3.33）、G7-3 `[已实施]` OpenCode（v3.32）、G7-5 `[已实施]` MCP 写工具（同一 gateway）、G7-6 `[已实施]` 未知键 ask、G7-9 `[已实施]` legacy `onBashPolicy`。
- 目标：所有写路径在“执行前”被拦截；无法拦截的后端显式降级。
- 涉及文件与数据/接口变更：`src/main/agent/runtime/approval/`、`src/main/adapters/codex.ts`、`opencode.ts`、`src/main/agent/mcp/*`；能力位 `approval` 与 UI 文案。
- 实施步骤：① MCP 写工具登记 D1；② Codex/OpenCode 接入 gateway；③ 未知配置键 ask；④ 覆盖矩阵测试。
- 验收标准：三后端写工具都产生 `agent_approvals`；无审批后端 UI 显示“不支持写前拦截”；未知键不静默放行。
- 依赖与建议顺序：依赖 W5 的 runtime；工作量 3–5 人日（Codex）+2–4 人日（OpenCode）。
- 风险与回滚：接入 gateway 可能改变现有行为 → 用能力位开关，默认保持现状。
- **核账注记（2026-11-09）**：G7-6 已在 `bash-readonly` 落地（白名单外 git 配置键一律 `git-unknown-config-key`，探针失败 fail-closed），G7-9 已在 legacy Claude 路径接线（`onBashPolicy` → Runtime 审计），两者由 `bash-readonly.test.ts` / `claude-code.test.ts` 覆盖，状态转「已实施」。**G7-1 仍开放**：Claude 侧网关边界（写类工具/路径作用域/会话授权）已具备，但三后端矩阵缺 Codex/OpenCode/MCP，不能按整体收口；G7-2/G7-3/G7-5 继续留在「已批准未实施」。W7 计数 67/19。

### W8 沙箱 C3（G7-7、G7-8 均已实施）
- 覆盖条目：G7-7 `[已实施]` C3 exec 面已收敛为 literal（见 II-27）、G7-8 `[已实施]` 非 Claude 裸 spawn（声明 + 降级 + UI 说真话）、G6-17 `[已实施·文档级]` 同 uid 边界已成段登记（§6.5.1）。
- 目标：把“已知风险 + 暂不处理”固化为可检索的风险登记，不伪装成已解决。
- 涉及文件与数据/接口变更：无代码变更；`docs/architecture/agent-architecture.md` §17.6 风险条目。
- 实施步骤：保持现状，发布前检查单引用。
- 验收标准：文档与 UI 均不声称“沙箱已收敛”。
- 依赖与建议顺序：待产品决定是否投入。
- 风险与回滚：不改代码即无回滚风险。

### W9 DAG 并行与确认点（L3）
- 覆盖条目：G2-8 `[已裁决·不做]` WaveExecutor、G2-9 `[建议·暂不投]` 黑板/fanout、G2-10 `[已实施]` C1–C4、G2-17 `[已裁决·不做]` 多 Agent、G8-3 `[已实施]` C1–C4 渲染与出口、G8-5 `[已实施]` 任务卡深度。
- 目标：从串行多步升级为受控并行（**G2-8/G2-17 已裁决不做，本包只剩确认点与任务卡深度两项**）。
- 涉及文件与数据/接口变更：~~新增 `wave-executor.ts`、`mediated-blackboard.ts`~~（**已裁决不做，两文件从未创建**，本条仅作设计存档）；`work_steps` 状态机扩展；渲染层新增确认点组件。
- 实施步骤：① DAG 环检测；② Wave 调度；③ 黑板读写契约；④ 确认点 UI；⑤ 多 Agent 路由。
- 验收标准：并行写同一节点被拒；fanout 结果可聚合；确认点可退回。
- 依赖与建议顺序：必须在 W7 审批覆盖完成后。
- 风险与回滚：并行引入竞态 → 默认关闭，按项目开启。

### W10 进化三层 / 提案 / Tier2（L3）
- 覆盖条目：G1-14 `[已实施]` 提案机制、G2-1 `[已实施]` 五通道/模式库、G2-2 `[已实施（v45）]` Layer1、G2-3 `[已实施（v44）]` `memory_hits`、G2-4 `[已实施（v46）]` Layer2、G2-5 `[建议]` Layer3、G2-6 `[已实施]` 提案细节、G2-7 `[建议]` Tier2、G2-16 `[已实施（v49）]` 离线校准、G2-19 `[已实施]` 提案 UI、G8-4 `[已实施]` 提案 UI、G11-10 `[已实施]` tree-hash。
- 目标：把“编排能力随项目进化”做成可审计的三层机制。
- 涉及文件与数据/接口变更：`memory_hits`、`task_embedding` 表；ContextBundle；提案表与 UI；Tier2 路由。
- 实施步骤：① 记录层先落 `memory_hits`；② 归因层接 `node_session_links`；③ 策略层做 embedding + 相似度；④ 提案生成/采纳/撤销；⑤ Tier2 升格；⑥ 每 20 run/2 周离线校准。
- 验收标准：每条建议可追溯来源；提案不直接改图；Tier2 只在能力探测通过后启用。
- 依赖与建议顺序：逐层上线，Layer1 可先做；Tier2 需先解决前置冲突。
- 风险与回滚：embedding 成本与误召回 → 默认关闭，按项目开启。

### W11 迁移与运维
- 覆盖条目：G9-8 `[已实施]` `RequestQueue` 删除、G9-11 `[已实施]` schema 版本号对齐到 **v50**（`CURRENT_SCHEMA_VERSION`，v50 = 合并带入的 `project_settings`）、G9-10 `[已实施]` worktree 定时清理、G9-13 `[已实施]` Windows 路径（`platform-paths` job）、G2-14 `[已实施]` `v_plan_deviations_file_domain`、G2-15 `[已实施（v48）]` dirty diff。
- 目标：清理死代码、补齐运维任务、修正文档版本口径。
- 涉及文件与数据/接口变更：`request-queue.ts` **已删除**（`80075e7`，无兼容壳）；新增 worktree 清理任务；`database.ts` 版本注释；视图 `v_plan_deviations_file_domain`。
- 实施步骤：① 文档版本改 36（已完成）；② 删死代码（`RequestQueue` 已完成）；③ 建视图；④ 加清理任务；⑤ Windows 仅登记不实现。
- 验收标准：`git grep -rn RequestQueue -- 'src/**'` 为空（已满足）；视图可查；清理任务有单测。
- 依赖与建议顺序：先做文档修正与死代码清理；视图/dirty diff 属 L3。
- 风险与回滚：删代码前确认无外部引用。

### W12 文档与验收补全
- 覆盖条目：G10-1 `[批准]` §13 审计表收尾（102 行 / 当前 0 节缺细节）、G10-2 `[实施]` A1/A2/A9 用例（§0.3.1）、G10-3 `[实施]` A3/A4 边界（§0.3.2）。
- 目标：把“有框架缺细节”的章节逐条补齐到可施工/可验收。
- 涉及文件与数据/接口变更：仅文档与测试用例；`docs/architecture/session-map-blueprint.md` 各节。
- 实施步骤：① 按 §13 表逐节补行为契约；② A1/A2/A9 转验收用例；③ A3/A4 落超时边界测试。
- 验收标准：§13 的 102 行（当前剩 0 节“有框架缺细节”）每行有“可施工/已实施/仅建议”终态；A1–A9 均有对应用例或明确不适用。
- 依赖与建议顺序：与 W4 的 P1–P9 联动。
- 风险与回滚：纯文档，无代码风险。

> **施工顺序建议**：W11（迁移/死代码/版本口径）+ W12（文档与验收）→ W4（P1–P9/CI）→ W1 → W2 → W3 → W5 → W6 → W7 → W11 视图项；L3 的 W9/W10 在 W7（审批覆盖）完成后另立里程碑。

## I.4 裁决记录（21 条：D-01…D-20 + G7-10 不做）

> **编号说明**：本表 `D-01…D-20`，与 §14.8 的 gate 裁决 `D1–D14` **不是同一体系**，引用时须带连字符。G7-10 不是 D 编号，单列在 I.4.18。**D-18/D-19/D-20 是对 D-13 的补充**（确认点落在哪类步、风险用什么线、确认事实存哪），不推翻 D-13 本体。
> **裁决时间**：D-01…D-17 为 2026-11-08；D-18…D-20 为 2026-11-10（G2-10 施工口径）；G7-10 为 2026-11-09（Asia/Shanghai）。**依据**：用户明确批准 D-01…D-17 全部按「建议与理由」逐条通过，未改动任何选项；D-18…D-20 为用户对 G2-10 实施前四项盲区的三条裁决；G7-10 明确裁决不做并登记为设计边界。
> **状态口径**：D-01…D-17 为 **已裁决（采纳 X）**；D-18…D-20 为 **已裁决（补充 D-13）**；G7-10 为 **已裁决（不做）**。裁决只定方向/边界，**不构成施工授权**——施工状态仍为「未授权」，不得据此改成「已批准未实施」。原选项与代价全部保留，供以后回看“为什么这么定”。
> **速览表**（“建议选项”列即最终裁决；详细论证见下方 D-01…D-20）：

| 决策号 | 原编号 | 议题 | 裁决结果 | 采纳代价（估算） |
|---|---|---|---|---|
| D-01 | G1-12 / G9-9 / G11-11 | Yjs 是否移除 | **B** 保持只读 + 默认不启动（C 留 L3） | 0 人日（现期） |
| D-02 | G1-15 | S1 是否有 `preview` 通道 | **先核实；无则 B 不做** | 0–4 人日 |
| D-03 | G3-11 | L2 通道（plan/test/evidence:suggestion） | **A** 本期注册，排 W4 之后 | 2–3 人日 |
| D-04 | G3-13 | WorkScheduler 文档与代码不一致 | **A** 改文档 | 0.5 人日 |
| D-05 | G4-4 | Bug 闭环边界 | **B** 仅建 bug + 链接 | 2–3 人日 |
| D-06 | G4-5 / G8-8 | 手工 E4 签收入口 | **A** 复用验收确认 UI | 2 人日 |
| D-07 | G6-8 / G11-5 | 排队 `queueDepth=1` | **A** 维持 fail-fast | 0 人日 |
| D-08 | G6-9 / G11-6 | Codex 默认 `runStreamed` | **A** 仅 Codex 默认流式 | 2–3 人日 |
| D-09 | G6-10 / G11-8 | 长尾 CLI 工具事件 | **B** 不投入 | 0 人日 |
| D-10 | G10-5 | L2 审查 P2 四项 | **B** 重新审查 | 3–5 人日 |
| D-11 | G10-6 | Zcode 两项待裁决 | **逐项拍板，不打包** | 0–2 人日 |
| D-12 | G10-10 | agent §13 五项产品决策 | **批量收口**（成本只记账、长尾不投入） | 0–3 人日 |
| D-13 | G11-1 | D1 计划确认强度 | **C** 仅高风险步确认 | 3–4 人日 |
| D-14 | G11-2 | D4 流程节点折叠 | **A** 折叠 | 2–3 人日 |
| D-15 | G11-3 | `agent.timeouts.turnMs` 配置键 | **A** 设键 | 1–2 人日 |
| D-16 | G11-4 | 两层 partial 截断是否统一 | **A** 统一 16KB | 0.5 人日 |
| D-17 | G11-12 | Tier2 升格前置冲突 | **A** 先解冲突再升格 | 5–8 人日 |
| D-18 | G2-10（补充 D-13） | 确认点落在哪类步 | **C** 只在 `test`/`human` 步建闸；`agent` 步继续走 runtime 逐工具审批 | 0 人日（不新增字段） |
| D-19 | G2-10（补充 D-13） | 步级风险如何分档 | **不新造档位**：复用 G4 的 20 文件 / 800 行，`risk_level` 两档，原因存文本 | 0 人日 |
| D-20 | G2-10（补充 D-13） | 确认事实落哪张表 | **复用 `acceptance_confirmations`**（`entry_id`=C1–C4），不新建表、不做 v50 | 0 人日 |

### I.4.1 D-01 · Yjs 是否移除（G1-12 / G9-9 / G11-11）— **已裁决（采纳 B）**

- **问题重述**：`cc749ce` 已把 Yjs 改成单向只读、`987c226` 已默认不监听 1236，写回危险已在代码层消除；但 doc 池、冲突子系统、依赖与 9 个测试文件仍在维护，既有"双写"误解与死代码成本，而彻底拆除又牵动快照数据与 P6 验收。
- **选项与代价**：A 立即拆除——8–12 人日（估算），改 9 个测试文件/119 个 `it(`、重做 P6、lockfile 与打包基线，风险高、返工面大；B 保持"只读 + 默认不启动"——0 人日，风险低，但保留死代码与依赖；C 冻结到 L3 再拆——现期 0 人日，后续一次性 8–12 人日。
- **与现有代码/设计的兼容性**：B 与当前代码完全一致（readonly-sync 测试即其验收）；A 必须同步改 §2.8 九类清单、§8.11 P6 与 `agent-architecture.md`；C 保留 §2.8 runbook 不动。
- **建议与理由**：**选 B**。拆除收益（少量依赖与死代码）低于风险（快照处置、测试重写、P6 验收重做）；C 作为 L3 的正式入口，待快照迁移方案齐备再启动。
- **不裁决会怎样**：§2.8 的九类清单与 runbook 无执行授权，L3 无法排期；但本期 L1/L2 不受影响。

### I.4.2 D-02 · S1 是否有 `preview` 通道（G1-15）— **已裁决（先核实；无则 B）**

- **问题重述**：导入前是否需要"只读预览（将导入多少节点/命中哪些查重）"的独立通道；现有代码未见独立 preview 入口，若已由导入流程覆盖则是伪需求。
- **选项与代价**：A 补只读预览——3–4 人日（估算），需新增 IPC + 只读汇总查询 + UI 空态；B 不做——0 人日，用户只能"导入后看结果"，失败需回滚。
- **与现有代码/设计的兼容性**：A 复用 `import-dedup.ts` 的判定顺序（三表、N=12 抽样）即可，不改写查重逻辑；B 与现流程完全一致。
- **建议与理由**：**先核实再定**：grep 确认无独立 preview 后选 B。查重结果已在导入报告里可见，独立预览属体验优化而非验收必需。
- **不裁决会怎样**：S1 验收清单少一项"导入前可预知"的判据，验收时会出现口径分歧。

### I.4.3 D-03 · L2 通道未注册（G3-11）— **已裁决（采纳 A，排 W4 之后）**

- **问题重述**：`src/main/ipc/map.ts:6-7` 只注册只读通道，`plan/test/evidence:suggestion` 写通道未注册，导致 TestExecutor 与建议机制无法从 renderer 验收。
- **选项与代价**：A 本期注册——2–3 人日（估算），含归属校验、错误码、幂等键；B 维持只读——0 人日，但 W2/W4 的验收只能走内部调用。
- **与现有代码/设计的兼容性**：A 必须与 `ApprovalGateway`、`subject ownership` 过滤同批落地（§6.8），否则重开跨项目越权面；B 不影响既有只读 UI。
- **建议与理由**：**选 A，但排在 W4（测试体系）之后**。没有写通道，测试计划与建议采纳无法形成端到端闭环，验收只能靠单测。
- **不裁决会怎样**：W2（证据闭环）与 W4（测试体系）长期停在"服务层可用、界面不可用"，验收口径分裂。

### I.4.4 D-04 · WorkScheduler 文档滞后（G3-13）— **已裁决（采纳 A）**

- **问题重述**：文档仍描述"无 GateRecheck"，而 `b6f3735` 已把 `GateRecheck` 注入执行装配；是文档滞后还是设计未落地，影响后续读者判断。
- **选项与代价**：A 改文档——0.5 人日（估算），零风险；B 改代码回退 GateRecheck——3–5 人日且引入执行回归，不可取。
- **与现有代码/设计的兼容性**：A 与代码事实一致（`work-execution-service.ts:463`）；B 与 §14 已实施结论冲突。
- **建议与理由**：**选 A**。属文档滞后，改文档即可，不应为迁就旧描述回退已实施能力。
- **不裁决会怎样**：后续施工会按旧文档重复实现 gate，产生第二套判定。

### I.4.5 D-05 · Bug 闭环边界（G4-4）— **已裁决（采纳 B）**

- **问题重述**：测试失败后是否自动"建 bug → 链接 → 修复 → 定向重测"全链；全链涉及测试资产、worktree 与 E3 回写，本期做会拉长 L2。
- **选项与代价**：A 全自动全链——5–8 人日（估算），测试与证据链路全动，返工风险高；B 仅建 bug 节点与链接——2–3 人日，定向重测留 L3。
- **与现有代码/设计的兼容性**：B 只需扩展 `test_results → bug_nodes` 映射与 `metadata`，不动 TestExecutor；A 需改 `test_plan_items.selected_by='targeted'` 与 worktree 清理。
- **建议与理由**：**选 B**。先让失败可见、可追溯；定向重测依赖并行与排队口径（D-07/D-17），不是本期能定的事。
- **不裁决会怎样**：**阻塞 Part II 的 II-13（G2-11）、II-14（G2-12）**，流程级测试与定向重测无法定稿；bug 闭环在"只记失败"处停住。

### I.4.6 D-06 · 手工 E4 签收入口（G4-5 / G8-8）— **已裁决（采纳 A）**

- **问题重述**：人工验收型测试需要 E4 签收，但当前只有验收确认 UI；再建独立表单会产生两套"确认"语义与两处状态写方。
- **选项与代价**：A 复用验收确认 UI——2 人日（估算），扩字段即可；B 独立 E4 表单——4–6 人日，双入口双维护。
- **与现有代码/设计的兼容性**：A 与 `acceptance-executor` / `NodeMapPanel` 的确认块兼容，签名与理由字段可复用；B 需新增审批 subject 与权限。
- **建议与理由**：**选 A**。确认语义必须单一写方，否则 C4 与 E4 会出现"同一事实两种签收"。
- **不裁决会怎样**：手工用例只能停在 `manual`，E4 证据无法从 UI 产生，W2 证据闭环缺一环。

### I.4.7 D-07 · 排队 `queueDepth=1`（G6-8 / G11-5）— **已裁决（采纳 A：维持 fail-fast）**

- **问题重述**：并发 turn 目前 fail-fast（`SESSION_BUSY`/`NODE_BUSY`）；是否引入队列把第二个 turn 排住，决定长 turn 期间的体验与可观测性。
- **选项与代价**：A 维持 fail-fast——0 人日；B 引入 `queueDepth=1`——4–6 人日（估算），会掩盖长 turn 占用，死锁与孤儿风险上升。
- **与现有代码/设计的兼容性**：A 与 `agent-architecture.md` §0.7 一致；B 需改 `AgentManager` 门面、IPC 与 UI 排队态，且与 §5.9.3 写闸叠加重叠。
- **建议与理由**：**选 A**。排队的收益是"不报错"，代价是"看不出卡住"；当前更需要可观测而非静默等待。
- **不裁决会怎样**：**阻塞 II-10（G2-8 WaveExecutor）、II-19（G2-17 多 Agent）、II-32（G9-8 RequestQueue 删除）**；并发策略与死代码去留都悬空。

### I.4.8 D-08 · Codex 默认 `runStreamed`（G6-9 / G11-6）— **已裁决（采纳 A）**

- **问题重述**：Codex SDK 支持流式与阻塞两种模式；默认值决定取消粒度与事件可见性，也影响"完成后 ~10s 关机开销"的处理。
- **选项与代价**：A 默认流式（仅 Codex）——2–3 人日（估算）+ 真机回归；B 默认阻塞——0 人日，取消与观测弱，且需等流结束。
- **与现有代码/设计的兼容性**：A 与 `agent-architecture.md` §0.9"完成信号以 `turn.completed` 为准"一致；B 与既有适配器默认一致，但违背观测目标。
- **建议与理由**：**选 A（仅 Codex，保留阻塞开关）**。流式是取消与审计的前提，阻塞只作为兼容开关保留。
- **不裁决会怎样**：Codex 路径的取消行为与事件粒度无定论，W6 的恢复与打包验收无法给出口径。
- **落地记录（2026-11-09）**：`CodexAdapter` 未显式设置时默认 `runStreamed()`；`BIZGRAPH_CODEX_STREAMING=0|false|no|off` 回退阻塞 `thread.run()`（保留 `finalResponse` 语义）。单测 `src/main/__tests__/codex.test.ts` 覆盖默认与回退；**真实 Codex 官方 provider 未验**（缺官方凭据，见 W5-D 注记）。

### I.4.9 D-09 · 长尾 CLI 工具事件（G6-10 / G11-8）— **已裁决（采纳 B）**

- **问题重述**：是否为使用频率极低的 CLI 适配器补齐工具级事件；补齐后可观测性提升，但维护面与适配器矩阵同步扩大。
- **选项与代价**：A 投入——6–10 人日（估算），每个适配器单独回归；B 不投入——0 人日，显式声明 `toolEvents='none'`。
- **与现有代码/设计的兼容性**：B 与能力矩阵（G6-20）兼容，只需在矩阵标注；A 需扩 `AgentCapabilities` 与事件归一化。
- **建议与理由**：**选 B**。长尾适配器的工具事件收益低、维护成本高；用显式能力位说真话，比补齐更稳。
- **不裁决会怎样**：能力矩阵留空档，UI 无法判断"没有事件"还是"不支持"。

### I.4.10 D-10 · L2 审查 P2 四项（G10-5）— **已裁决（采纳 B）**

- **问题重述**：上一轮 L2 审查的 P2 四项原文清单已不可得，只剩结论；要么找回原始清单，要么重新审查，否则这四项永远无法核对。
- **选项与代价**：A 找回原始清单——依赖旧会话/附件，可能不可得，成本不确定；B 重新审查——3–5 人日（估算），结论可能与前次不一致。
- **与现有代码/设计的兼容性**：B 只读复核，不动设计；A 若找回，需逐条比对当前代码。
- **建议与理由**：**选 B**。旧清单已不可得，重新审查虽可能得出不同结论，但可复核、可留痕，优于引用不可验证的旧结论。
- **不裁决会怎样**：§13 审计表中 4 行永久标"不可核对"，定稿的可信度打折。

### I.4.11 D-11 · Zcode 两项（G10-6）— **已裁决（逐项拍板，不打包）**

- **问题重述**：外部 Zcode v1.2 遗留两项（§12.5 第 6、7 项）需产品逐项拍板；打包默认会掩盖分歧。
- **选项与代价**：按 §12.5 逐项拍板——每项 0–2 人日（估算）；或整体不裁决——0 人日，但两项长期悬空。
- **与现有代码/设计的兼容性**：两项均为设计层选择，不涉及已实施代码。
- **建议与理由**：**逐项拍板，不打包**。两项性质不同，打包会让其中一项被另一项的结论带走。
- **不裁决会怎样**：L3 保留区两处标注长期为"待定"，无法进入施工排期。

### I.4.12 D-12 · agent §13 五项产品决策（G10-10）— **已裁决（批量收口）**

- **问题重述**：`agent-architecture.md` §13 的五项（排队、审批超时时长、Codex `runStreamed`、成本上限口径、长尾 CLI）长期未拍板，其中三项已被 D-07/D-08/D-09 覆盖。
- **选项与代价**：批量拍板——0–3 人日（估算），前三项沿用本表建议；成本上限建议"只记账、不自动熔断"；或逐项再议——0 人日但周期拉长。
- **与现有代码/设计的兼容性**：与 `agent-architecture.md` §13 完全对齐；成本只记账已有 G11-7 支撑。
- **建议与理由**：**批量拍板**，但明确"成本只记账"与"长尾不投入"两句为最终口径，避免以后再开。
- **不裁决会怎样**：**阻塞 II-07（G2-5 Layer3 embedding）**——embedding 是否引入外部成本取决于成本口径；同时 §13 的开放项无法关闭。

### I.4.13 D-13 · D1 计划确认强度（G11-1）— **已裁决（采纳 C）**

- **问题重述**：计划确认是"每计划一次"（现状）、"每步确认"还是"仅高风险步确认"，决定 C1–C4 的交互密度与误操作面。
- **选项与代价**：A 每计划一次——0 人日，风险最高（错误计划一次放行多步）；B 每步确认——6–8 人日（估算），吞吐显著下降；C 仅高风险步确认——3–4 人日，需定义"高风险"判据（G4 规模/写域/不可逆）。
- **与现有代码/设计的兼容性**：A 即当前实现；C 需在 `work_steps` 增 `risk_level` 派生（不改表结构，可由 gate 结果计算）。
- **建议与理由**：**选 C**。在安全与吞吐之间取中间值；"高风险"有现成判据（G4 阈值、跨图、不可逆迁移），不需要新概念。
- **不裁决会怎样**：**阻塞 II-12（G2-10 C1–C4）与 II-29（G8-3 C1–C4 渲染）**；确认 UI 无法定交互密度。

### I.4.14 D-14 · D4 流程节点折叠（G11-2）— **已裁决（采纳 A）**

- **问题重述**：流程节点在画布上是否折叠为聚合块，决定大图可读性与任务卡层级展示。
- **选项与代价**：A 折叠——2–3 人日（估算），需聚合视图与展开态；B 不折叠——0 人日，大图拥挤、任务卡平铺。
- **与现有代码/设计的兼容性**：A 只改渲染层派生，不动 `nodes` 表；与 `NodeMapPanel` 兼容。
- **建议与理由**：**选 A**。折叠是纯展示派生，不改数据；大图可读性收益明确。
- **不裁决会怎样**：**阻塞 II-31（G8-5 任务卡深度）**；任务卡与画布的层级口径无法统一。

### I.4.15 D-15 · `agent.timeouts.turnMs` 配置键（G11-3）— **已裁决（采纳 A）**

- **问题重述**：上一轮裁决曾定"配置键"，但代码事实是常量且无配置面；是补配置键，还是维持常量。
- **选项与代价**：A 设键——1–2 人日（估算），与 `stepMs/taskMs/sendWaitMs` 统一口径；B 保持常量——0 人日，分层默认无法按项目调整。
- **与现有代码/设计的兼容性**：A 需新增配置读取与默认值合并，不改变 `deadlineMs=0` 语义；B 与现状一致。
- **建议与理由**：**选 A**。三个预算键已规划，`turnMs` 单独留常量会造成第二套口径。
- **不裁决会怎样**：W3 的超时预算实现只能硬编码，`stepMs/taskMs/sendWaitMs` 的消费点也无统一来源。

### I.4.16 D-16 · 两层 partial 截断（G11-4）— **已裁决（采纳 A）**

- **问题重述**：F2 契约层 64KB 与 adapter 层 10KB 单条截断并存，是否统一。
- **选项与代价**：A 统一 16KB——0.5 人日（估算），与既有块上限一致；B 统一 64KB——0.5 人日，单条会被放大；C 保持两层——0 人日，行为契约留两套数。
- **与现有代码/设计的兼容性**：A 与 `BaseAdapter.MAX_OUTPUT_ENTRY_SIZE=10_000` 接近，改动小；B 需同步 adapter 常量。
- **建议与理由**：**选 A**。16KB 与块上限同量级，减少"单条与总量"两套口径。
- **不裁决会怎样**：§8.15 的行文与实现继续分叉，验收时无法给唯一阈值。

### I.4.17 D-17 · Tier2 升格前置冲突（G11-12）— **已裁决（采纳 A）**

- **问题重述**：Codex 等 Tier2 后端缺少 `approval_callback`，若要升格参与写编排，必须先解决"无写前审批"与路由冲突；直接升格等于开审批后门。
- **选项与代价**：A 先解冲突再升格——5–8 人日（估算），需补审批桥与降级路径；B 直接升格——2–3 人日，安全性倒退、返工风险高。
- **与现有代码/设计的兼容性**：A 与 §5.9.5/§5.9.10"写路径仅 Tier 1"一致；B 与该纪律直接冲突。
- **建议与理由**：**选 A**。审批是硬约束，不能为能力覆盖让步；先补桥再接升格。
- **不裁决会怎样**：**阻塞 II-09（G2-7 Tier2）与 II-22（G3-1 Tier1 探测）**；能力探测矩阵无法定版。

### I.4.18 G7-10 · 旧路径无 turn 时间线 — **已裁决（不做；登记为设计边界）**

- **问题重述**：非 kernel 旧路径（Codex/OpenCode 等未进 kernel 的后端、自由聊天）有审批记录但没有 `agent_turns` 行，因此没有 turn 起止、turn 内事件 seq 与按 turn 的快照/成本归属。
- **裁决**：**不做**。不新增伪 turn、不伪造 `agent_turns` 行、不为此放宽 `agent_turns.node_id NOT NULL`。
- **依据与冲突**：与 §4.5 D8「纯 thread 不进 kernel、取消 `thread:<id>` 伪节点」直接冲突——补齐 turn 时间线只能二选一：伪造 turn（违反 D8）或放宽 `node_id`（长期待办，未授权）。详见 §4.5.1a。
- **影响范围**：`KERNEL_APPROVAL_CAPABLE_BACKENDS = ['claude','acp']` 之外的后端（Codex/OpenCode/未注册 driver）、`BIZGRAPH_AGENT_KERNEL=0` 回旧路径、以及未挂节点的自由聊天。
- **重新评估条件**：见 §4.5.1a「触发重新评估的条件」；任一条件成立须重新裁决，不在本蓝图内自动开工。

### I.4.19 D-18 · G2-10 确认点落在哪类步（补充 D-13）— **已裁决（采纳 C：只在 test/human 步建闸）**

- **问题重述**：D-13 定了「仅高风险步确认」，但没定「哪些步的确认在计划期可判定」。G2-10 实施前发现三个盲区：跨图写入面未建模（gate-engine D5/D6）、`agent` 步是否不可逆没有计划期数据源、G4 只有阈值没有分档。若给所有步都加「不可逆」声明字段，计划期只能大面积落 `unknown`，按 fail-closed 会一律弹确认，把确认信号稀释成噪声。
- **选项与代价**：A 全步建确认点——0 人日，确认密度最高、几乎不可用；B 只按写域 + G4 规模判定、不可逆记 `unknown` 且不触发——0 人日，等于把已知盲区默认写成低风险；C 只在 `test`/`human` 步建确认点——约 2 人日（估算），`agent` 步继续依赖 runtime 的逐工具审批（`classifyToolRisk`），不为不存在的计划期数据造字段。
- **与现有代码/设计的兼容性**：**选 C**。`agent` 步的不可逆性在计划期不存在，真正的控制在 runtime 审批层已经存在，不在错误的层重复造。C3/C4 天然对应 `test`/`human`；`agent` 步保持既有链路不变，不新增声明字段、不改 `work_steps` 表。
- **建议与理由**：见上。**不走 B**——那等于把已知盲区默认写成低风险，比多问一次更危险。
- **不裁决会怎样**：G2-10 无法定「哪些步建闸」，只能退化成 A 或 B；II-29（G8-3 渲染）同样无法确定要展示哪些确认点。

### I.4.20 D-19 · G2-10 步级风险如何分档（补充 D-13）— **已裁决（不新造档位）**

- **问题重述**：步级确认需要「高风险」判据。可选项是引入三档量表（low/medium/high）或沿用 G4 既有阈值。
- **选项与代价**：A 三档量表 + 新枚举值——1–2 人日（估算），需要新的消费方与 UI 语义；B 复用 G4 的 20 文件 / 800 行作为唯一高风险线，`risk_level` 保持两档（low/high），原因存文本——0 人日。
- **与现有代码/设计的兼容性**：**选 B**。与 G2-11 否掉扩 CHECK 是同一条理由：没有消费方的量表就是下一个「schema 里有、没人用」。`deriveStepRisk` 只判「是否达到/超过 G4 两条线」，行数不可预估时只按文件数并在原因文本里写明限制。
- **建议与理由**：见上。两档足以表达「要不要确认」，不需要第三档来表达「有多危险」。
- **不裁决会怎样**：要么新增一套无消费方的枚举，要么把「不可逆」继续记成 `unknown` 触发噪声确认。

### I.4.21 D-20 · G2-10 确认事实落哪张表（补充 D-13）— **已裁决（复用 `acceptance_confirmations`）**

- **问题重述**：C1–C4 的确认结果需要可审计落点。II-12 旧稿写的是「落 `agent_approvals`（subject 扩展）」，但 `agent_approvals` 已由 v35 明文废止承载人工确认——那条描述已过期，继续沿用会出现「从没调用过工具却留下放行记录」。
- **选项与代价**：A 新建确认表（v50）——1–2 人日（估算），多一张与 `acceptance_confirmations` 语义高度重叠的表；B 复用 `acceptance_confirmations`，用 `entry_id` 承载确认点（C1–C4）、`decision_note` 承载风险与原因 JSON——0.5 人日；C 回到 `agent_approvals`——0 人日，但与 v35 冲突。
- **与现有代码/设计的兼容性**：**选 B**。`acceptance_confirmations` 已有 `(work_item_id, step_id, entry_id)` 唯一索引与 `source` 审计字段，加一个枚举维度即可承载 C1–C4；**不新建表、不做 v50**。C1/C2 的展示校验在 IPC 边界完成，不写该表；C3/C4 的 approve 写该表，reject 因唯一索引会占位而改写 `input_request_json`（同一行天然不允许两条决策）。
- **建议与理由**：见上。II-12 里「落 `agent_approvals`」一句随本次一并改掉。
- **不裁决会怎样**：确认事实要么继续落已废止的表，要么为同一语义再建一张表。

## I.5 ZCode（v1.2.3）设计吸收清单

> 说明：上传件与仓库件逐字节相同，故“吸收”即把 v1.2.3 中比本文更细、可施工的部分落到本文编号体系。**不整段搬运**，只落接口/算法/状态机/验收口径。

| 来源（map-orchestration v1.2.3） | 内容 | 落点 | 判定 |
|---|---|---|---|
| §3.1 R9-6 DeadlineReaper 规格 | 5s 扫描、部分索引、waiting_approval 跳过、CAS 防重复杀 | 本文 §8.15 / §12.9 | **采纳**：已有 F1–F3 实施记录，补为施工口径 |
| §3.1 R9-10 迁移完整性 | `CURRENT_SCHEMA_VERSION` 递增 + checksum 再生 | 本文 §8.2 / I.3 W11 | **采纳**：列为发布检查单 |
| §4.1 五通道/ContextBundle | `类型 × 执行器 × 作用域 × ContextBundle × IO 契约` | 本文 §5.9.8（L3） | **采纳为 L3 设计**：不进入本期 |
| §4.1 黑板/Phase B/fanout | 黑板数据结构与 Phase B 接口 | 本文 §5.9.8.1 | **采纳为 L3 设计** |
| §4.2 进化三层 | `memory_hits`、`node_session_links` 归因、`task_embedding` | 本文 §4.2（L3） | **采纳为 L3 设计**：表随层动工 |
| §4.3 提案机制 | 生成/冲突串行/降权 | 本文 §2.7（L3） | **采纳为 L3 设计** |
| §4.4 Tier2 估算 | codex 升格前置与成本 | 本文 §5.9.5（L3） | **采纳估算，不采纳先升格** |
| §4.5 Yjs 拆除 runbook | 备份/快照/表清单/回滚 | 本文 §2.8 | **采纳为 runbook**；**D-01 已裁决：保持只读 + 默认不启动，不执行拆除** |
| §7 L3-a～L3-g 保留区 | 流程测试、DAG、UI、证据面等 | Part I I.1.3 | **采纳为“仅建议”总表** |
| §6 勘误/行号校正 | 行数、版本、总账 | Part I I.1/I.2 | **采纳**：本轮已改 |
| “可复现 dirty tree-hash” | 另立等级 | — | **不采纳为主路径**：成本高、与 E3 现有 commit+dirty 重叠 |
| 立即 Yjs 拆除 | — | — | **不采纳**：见 G1-12 |
| 立即引入排队 | — | — | **不采纳**：见 G6-8 |

## I.6 定稿自检

- 行数复核：`wc -l docs/architecture/session-map-blueprint.md` = **5992**（2026-11-13 v3.33 定稿实测；`npm run verify:blueprint` 每次都会重算，数字不再靠人记）；`wc -l docs/architecture/map-orchestration-blueprint.md` = **398**（2026-11-09 起未变，仍是历史快照）。
- schema 复核：`src/main/database.ts` `CURRENT_SCHEMA_VERSION = 49`（v38–v49 依次为 G2-14/G2-13/G1-14/G2-1/G11-10/G1-9/G2-3/G2-2/G2-4/G5-10/G2-15/G2-16 引入；v50 未做）。
- “已实施”证据复核：I.2 自 v3.19 起统一为「完整相对路径 + 符号/函数名」，不再标行号（行号是最先腐烂的证据，见 I.2 头部的证据格式说明）；无代码证据的一律在 I.3/I.4 或标「文档级」。
- 计数复核（当前自检，v3.14 起生效；v3.30 更新）：**条目侧** 105 已实施 + 6 已批准未实施 + 5 仅建议 + 0 待裁决 = **116**；**裁决侧** 20 条方向裁决（D-01…D-20）+ 3 条「不做」边界（G7-10 / G2-8 / G2-17）= **23**；**对账** 116 + 23 = **139**，且 原始明细 155（152 + 3 条施工级补充裁决 D-18/D-19/D-20）− 16 条跨组重复 = **139**。两式必须同时成立。
- 计数增长规则：新增 G 条目 → 条目侧 +1（总数 +1）；把某 G 条目改判为「不做」→ 条目侧 −1、裁决侧 +1（**总数不变**）；新写一条**无对应 G 条目**的 D 裁决记录 → 裁决侧 +1（总数 +1）。旧稿的「去重总数恒为 136」只是 v2.3 时点的快照，**不是不变量，已废止**，不得再作为自检口径。
- v2.3 历史快照（2026-11-09，**非当前自检，仅存档**）：152 原始条目 / 16 重复 / 136 独立；75 已实施 / 11 已批准未实施 / 32 仅建议 / 0 待用户裁决 / 18 已裁决（17 方向 + 1 不做，未授权施工）。（当时点的收口记录：W1 收 G1-5/6/7/8/13；W3 `0df2234` 收 G3-4～G3-9；W4 `217fbbc` 收 G4-6～G4-9；W5 A/B `dc51b48` 与 C `80075e7` 收 G6-1～G6-4；W5-D 收 G6-12/G6-13/G6-18；W2 收 G1-10/G5-4/G5-8/G5-9 与 G3-10/G5-3；W7 核账收 G7-6/G7-9；W12 收 G10-2/G10-3；G9-8 由仅建议转入、G9-11 由已批准转入已实施；G6-5 删除 unattended 分支转入已实施；G3-3/G8-6 renderer 执行入口转入已实施；G7-10 由已批准未实施转为已裁决不做。）
- v2.2 复核：I.4 的 D 条目恰 17 条（D-01…D-17，全部「已裁决（采纳 X）」），另 I.4.18 为 G7-10 已裁决不做；Part II 恰 34 条（II-01…II-34，13 条阻塞已解除）；**除 II-24（G3-3/G8-6）与 II-32（G9-8）已于 2026-11-09 实施外，其余 32 条状态词仍为「仅建议」，17 条未升格为「已批准未实施」**。
- v2.3 历史快照复核（2026-11-09，**非当前口径**）：`wc -l` 实测 **5573**（本文）/ **398**（`map-orchestration-blueprint.md`）；`git grep -rn RequestQueue -- 'src/**'` 为空；四类计数 75 + 11 + 32 + 0 = 118，加 18 条裁决（17 方向 + 1 不做）= 136。
- v3.12 复核（2026-11-10）：四类计数 101 + 9 + 6 + 0 = 116；裁决侧 23 条（D-01…D-20 + G7-10/G2-8/G2-17 三条不做边界）；条目侧 116 + 裁决侧 23 = **去重总量 139**（D-18/D-19/D-20 为 D-13 的施工级补充）。G2-10 已实施（`confirmation-points.ts` + `step-confirmation-service.ts`），**未新建表、未做 v50**（`CURRENT_SCHEMA_VERSION` 仍为 v49）；II-12 中「落 `agent_approvals`（subject 扩展）」的过期描述已改写。
- v3.13 复核（2026-11-10）：四类计数 **102 + 9 + 5 + 0 = 116**；裁决侧 23 条，条目侧 116 + 23 = **去重总量 139**。G8-3 已实施（`StepConfirmationPanel.tsx`，C3/C4 只读渲染），**未改数据模型、未新增通道、未改 schema**；C1/C2 面板登记为「待计划草稿/修订界面」，不单列仅建议条目。
- v3.14 复核（2026-11-10）：四类计数 **102 + 9 + 5 + 0 = 116**；裁决侧 23 条，条目侧 116 + 23 = **去重总量 139**（未新增 D 记录，总数不变）。G8-3 补出口：C3/C4 面板可写 `map:confirmation:decide`，`map:confirmation:status` 增 `display` 投影；**未改 schema、未新增表/通道**。C1/C2 界面前置与估算登记在 I.8.F，**未排期**。
- v3.15 复核（2026-11-10）：四类计数 **102 + 9 + 5 + 0 = 116**；裁决侧 23 条，条目侧 116 + 23 = **去重总量 139**（未新增 D 记录）。I.8.F P1 已实施（`plan-draft-precheck.ts` + `PlanDraftPanel.tsx` + `plan:draft:preview/list/submit`）；**未改 schema、未放宽 `assertConfirmationDisplay`、未改 gate 判定**。`plan:draft:submit` 是补出口（`createDraft` 落 `draft`、`confirm` 只收 `awaiting_confirm`），不是新增功能。
- v3.16 复核（2026-11-10）：四类计数 **102 + 9 + 5 + 0 = 116**；裁决侧 23 条，条目侧 116 + 23 = **去重总量 139**（未新增 D 记录）。I.8.F P2 已实施（`work-item-revision.ts` + `WorkItemRevisionPanel.tsx` + `workitem:history/diff`）；`workitem:revise` 补 `reason`/`dependsOn` 入参与 preload 白名单；**未改 schema、未扩 CHECK、未做 v50、未改 `is_current` 语义**。C2 仍有边界（单任务字段级；run 失效/证据 stale 无数据来源），不读成「C2 完整交付」。
- v3.17 复核（2026-11-11）：四类计数 **102 + 9 + 5 + 0 = 116**；裁决侧 23 条，条目侧 116 + 23 = **去重总量 139**（未新增 D 记录）。新增 `ipc-preload-allowlist.test.ts` 护栏（注册事实 = `typedHandle` 调用点 203 条；preload 暴露 = 172 字面量 + 22 只读 = 194；renderer 实际调用 93 条，均已暴露且已注册）。**未补任何白名单**：已知缺口 9 条 = 3 条 S7 延后（`plan:derive-candidates` / `plan:draft:create` / `plan:draft:revise`）+ 2 条刻意不暴露且已被覆盖（`plan:draft:get` / `admin:map:integrity-check`）+ 4 条漏接线（`map:link:create` / `project:import:preview` / `project:import:allowance:list` / `project:import:allowance:revoke`），均无 renderer 调用方、不存在活断头，分类见 I.8.2，逐条登记在测试豁免表里等待裁决；**未改 schema、未改 preload 行为、未新增通道**。
- v3.18 复核（2026-11-11）：四类计数 **102 + 9 + 5 + 0 = 116**；裁决侧 23 条，条目侧 116 + 23 = **去重总量 139**。只改文档，**未改代码、未补白名单、未造写入方、未补 handler**。C1 定性修正为「面板已交付、无数据源」。
- **v3.19 复核（2026-11-11，对照代码与提交历史的全量核验）**：四类计数不变 **102 + 9 + 5 + 0 = 116**；裁决侧 23 条；去重 **139**。本轮不是文档自洽检查，而是逐条对码：
  - **I.2 表行 95 → 102**（补 G2-13/G2-14/G2-18/G6-5/G9-10/G10-2/G10-3），分组数字逐个核对无误差（12/15/7/12/11/10/7/11/8/4/1/4）。
  - **G8-2 由「证据不成立」转为「三件全绿」**：画布派生徽标原已实现（此前用 `lifecycle_state` 检索 renderer 得 0 命中，属检索关键词错误），时间线切换本轮补上（`NodeMapPanel.switchTimelineThread` + 4 例测试）；`tsc --noEmit` 通过，`NodeMapPanel.test.tsx` 31 例全绿。
  - **状态词纠偏 4 条**：G5-2（E3 唯一写方 / E2 两个写方）、G3-14（提交号改 `5cf3f81`）、G6-19（降为文档级）、G8-9（空态文案按代码写「无（该节点没有证据）」）。
  - **证据侧**：`文件:行` 系统性腐烂，已整体改为路径 + 符号（56 处）；G8-1/G8-9/G8-10 三条原引 `out-run4/` 演练截图——该目录全仓不存在、git 历史中也从未提交，已全部换成可复核的代码取样（`data-testid` 与空态分支）。
  - **版本链**：I.2.8 G9-11、§7 注、I.7 W11 三处旧数字（36/37）统一为 **49**；v50 三处均明确「未做」。
  - **实测环境说明（v3.20 已更新，v3.21 已 quarantine）**：该轮全量 `vitest run` 为 352 文件 / 4221 例，其中 **7 文件 / 26 例失败**，全部落在依赖宿主能力的两处：`ps` 读进程表（`operation not permitted`）与 `sandbox-exec` 套限制性 profile（`sandbox_apply: Operation not permitted`）。**不是代码回归**；逐文件证据见 `code-issues-2026-11-11.md` §5。v3.21 起这 26 例改为按用例能力探测 skip（见下条），「全量绿」重新成立且跳过项带原因，不再靠容错。
- **v3.21 复核（2026-11-11，修问题 + 环境类自动 quarantine）**：四类计数不变；裁决侧 23；去重 **139**。
  - **代码修复三处**（详见 `code-issues-2026-11-11.md` §2/§3/§6）：证据建议三通道 + E1 有了面板入口；`map:link:delete` 落地（`LinkService.delete` 只删 `origin='human'`）并补齐 create 的 UI 与列表消费；`map:node:timeline` 改显式 DTO（`TimelineEntryDTO`），两端不再 `as unknown as`。
  - **环境类失败改为能力探测 skip**：新增 `src/main/__tests__/helpers/host-probe.ts`（`canReadProcessTable` / `canApplySandboxProfile`，独立于被测模块、模块级缓存）。26 条依赖宿主能力的用例逐条 `it.skipIf`，`process-supervisor.test.ts` 4 条全部依赖进程表故整组 `describe.skipIf`；`agent-eval.test.ts` 的 U8 在 `ps` 不可读时记 **SKIP + 缺什么**，不再把宿主限制写成 FAIL 结论。`sandbox capability` 的 canary 用例改为**双向断言**：宿主可套限制性 profile 时必须判可用且 `reason='ok'`，宿主拒绝时必须判不可用且 `reason≠ok`（谎报可用会让 allow 集裸跑）。
  - **负载敏感**：`telemetry/index.test.ts` 放宽到 60s（真初始化 OTel SDK；满载时 import 链被挤过 15s，单跑 <1s，断言未改）。
  - **IPC 三数（与护栏同口径重算）**：注册 **204** / 暴露 **196** / renderer 使用 **100**；`map:link:create` 与 `map:link:delete` 均已暴露，`KNOWN_WRITE_WITHOUT_RENDERER_ENTRY` 移除 `map:link:create`（已有 UI）。护栏测试本就不硬编码数字，改的是文档。
  - **全量测试**：`352 文件 / 4234 例`，**4188 通过 / 46 跳过 / 0 失败**；`tsc --noEmit` 与 `eslint`（改动文件）均通过。
- **v3.20 复核（2026-11-11，把核验机械化 + 修掉误红）**：四类计数不变；裁决侧 23；去重 **139**。
  - **机械核验**：新增 `scripts/verify-session-map-blueprint.mjs`（`npm run verify:blueprint`），13 项断言覆盖「行数/分组闭合、编号唯一、三条等式、旧数字零残留、schema=49、引用可解析、提交号可解析、I.0 可达、I.10 目标存在、口径无矛盾、表格结构」。本文在该脚本下 **13/13 通过**。
  - **修掉 3 处文档自相矛盾**：头部状态词仍要求 `文件:行`（与 v3.19 新口径冲突）；`yjs-realtime.ts` 缺 `snapshot/`；`db/repository.ts`、`approval/gateway.ts` 缺 `src/main/agent/runtime/` 前缀。另把 4 个「设计稿列过、从未创建」的文件显式标注（`evidence-derivation.ts`、`wave-executor.ts`、`mediated-blackboard.ts`、`yjs-doc-registry.ts`）。
  - **测试误红**：`claude-code.test.ts` 的 Bash 策略用例依赖真实 `sandbox-exec` canary 结论，沙箱不可用时 allow 被正确降级为 ask 却判失败——改为 mock 能力位，并补「不可用 → ask」用例；全局 `testTimeout` 5s → 15s；`agent-manager-restore.test.ts` 并行跑时空闲内存跌破 darwin 64MB 下限、被内存护栏拒建会话，测试里钉住 `os.freemem`。全量 **14 文件 / 34 例 → 7 文件 / 26 例**，剩余均为宿主拒绝 `ps` / `sandbox_apply`。
- 端到端口径：W5 的 chat kernel 路由、三阶段 `executing_at`、`agent_snapshots` 生产写入均为**模块级已验证，端到端待真机**；W5-D 的 **R3/U8/C13b 已实测、arm64 打包产物已验**；Codex/OpenCode 真机矩阵因缺官方凭据/CLI 未做（**G6-15 已于 v3.30 用真实 CLI 收口**、G6-16 仍为「已批准未实施」；**G6-14 已于 v3.25 用 GLM 代理实测通过**，官方计费口径仍缺）。
- 本次 v2.3 文档修订未改地图产品代码；W5-D 仅按 D-08 改 Codex 默认流式（保留 `BIZGRAPH_CODEX_STREAMING=0` 回退）。W1–W5 的产品代码已分别提交（`0df2234` / `217fbbc` / `dc51b48` / `80075e7`），W5-D 改动随本轮「打包解包显式化 + 构建后校验 + W5-D 收口」提交，**未 push**。

## I.7 裁决后建议施工顺序（按 W 包）

> 口径：W 包对应 I.3 的 **9 条「已批准未实施」**，与 5 条「仅建议」不同批；G7-10 已裁决不做，不占 W 包名额。D-01…D-17 只影响其中的实现口径，不新增开工授权。W1（2026-11-08）、W2（G5-9 与 G3-10，2026-11-09）、W3（`0df2234`）、W4（`217fbbc`）、W5（`dc51b48` / `80075e7`）、W7 核账（G7-6/G7-9，2026-11-09）已完成，其条目已转入 I.2 已实施。

| W 包 | 覆盖 | 可否开工 | 依赖 | 一句话理由 |
|---|---|---|---|---|
| W1 地图对象与状态回写 | G1-5/6/7/8/13、G1-11 | **已完成（2026-11-08）** | 无 | 5 条已转入 I.2；G1-11 维持仅建议 |
| W3 执行守卫 | G3-4…G3-9（已实施）、G3-10 | **已完成主体（`0df2234`）** | 无 | 6 条已转入 I.2；G3-10 归 W2 证据写入面 |
| W4 测试体系 | G4-6…G4-9 | **已完成（`217fbbc`）** | 无 | 4 条已转入 I.2；流程测试三项仍为仅建议 |
| W12 文档验收 | G10-1/2/3/11 | **进行中（G10-2/3 已收口）** | 可与 W1 并行 | 纯文档与用例；A1–A4 已登记，剩 G10-1 |
| W2 证据闭环 | G1-9/10、G3-10、G5-8/9 | **完成** | 无（G5-10 归 W12 后续） | `evidence_suggestions` + 接受同事务 + E1 人工直写 + E4 覆盖变化扫描（v43）均已落 |
| W5 Agent M2 | G6-1…G6-4、G6-12/13/18 | **已完成（`dc51b48` / `80075e7` + W5-D），Codex/OpenCode 真机矩阵未做** | 无 | M2 六项 + ACP/chat 路由 + R3/打包/C13b 已闭环；G6-11/14/15/16 待环境（CLI/凭据/平台） |
| W6 Agent 恢复/旧路径 | G6-5（已实施删除）/7/11…G6-16；G7-10（不做） | 依赖 W5 | W5；Codex 口径按 D-08 | 恢复与旧路径建立在 M2 的持久化之上；G7-10 已登记为设计边界（§4.5.1a） |
| W7 审批覆盖 | G7-1…G7-6、G7-9（G7-10 不做） | 依赖 W5 | W5；手工 E4 按 D-06 复用确认 UI | 审批覆盖需要 M2 的会话/审批表先行 |
| W9 DAG/确认点 | G3-12（已实施）+ C1–C4 | 依赖 W3 | W3；确认强度 D-13、折叠 D-14 | 分层调度要有写闸与状态机才会安全 |
| W10 进化/提案/Tier2 | G1-14、G2-2…G2-7 | 依赖 W2 | W2；Tier2 按 D-17 先补审批桥；embedding 按 D-12 | 进化与提案都消费证据，Tier2 需桥 |
| W11 迁移运维 | G9-11/13、G9-8、G9-10 | **已完成（`80075e7` + v49 + v3.29）** | W1 | `RequestQueue` 已删、版本号已对齐 **v49**、worktree 定时清理已落地、G9-13 Windows 路径改由 `platform-paths` job 在 windows-latest 上验证 |
| W8 沙箱 C3 | G7-7（已实施）/ G7-8（已实施：声明 + 降级 + UI 说真话）/ G6-17（文档级） | **已完成** | 无 | exec 面已收敛；非 Tier 1 后端不再进编排写路径；完整审批桥仍不做（设计边界） |

**建议顺序**：`W1 ∥ W3 ∥ W4 ∥ W12` → `W2`（通道等 W4）→ `W5` → `W6 ∥ W7` → `W9` → `W10` → `W11`。W8 已收口；5 条仅建议维持不动，除非另行授权。

## I.8 剩余卡点（按「用户需做什么」重排，2026-11-10）

> **复核基线**：HEAD `007f9d2`（2026-11-11 v3.19 核验时的实际 HEAD；原写 `9bb94e8`，已落后 30 个提交）。工作区干净，`origin/main` 落后 **183 个提交**（从未 push）。
> **计数（v3.29 更新）**：本节的来源是 I.1.2（**7 条**已批准未实施）与 I.1.3（**5 条**仅建议），合计 **12 条**——原写「11 + 29 = 40」是旧快照，v3.25 前写「8 + 5 = 14」也把已移出的 G6-14 算在内。状态词与授权仍以 I.1 为准，本节只回答「卡在哪、用户做什么能解、大概多少活」。
> **计数说明**：I.1.2 里 G10-11（=G4-9，已实施）与 G10-1（§13 审计已收至 0 节缺细节）是账面遗留，不计入 12；I.1.3 的 E1 人工入口并入 G8 组，不单列。工作量均为**估算**，非承诺。
> **D 组的读法（v3.19 补）**：D 组是「已实施复核记录 + 少数可开工项」的混排表，**不是待办清单**。凡行内标「已实施」的，只作复核留痕；只有标「授权开工即可」的才是真待办。照旧把整张 D 表排期，会把已做完的事重做一遍。

### A. 需用户提供凭据或密钥（2 条；G6-14 已于 v3.25 实测移出、G7-2→B、G6-16→I.9.2）

| 编号 | 名称 | 卡点（一句话） | 用户需要做什么才能解 | 预估 |
|---|---|---|---|---|
| G6-11 | U1–U9 真机矩阵 | **重判后仅剩官方口径三条**：U1/U2 Codex 官方 provider、U5 Anthropic 付费回合；U9 第二 uid、U3/U4/U6/U7/U8 已 PASS/SKIP | 若要补齐 U1/U2/U5：提供官方 OpenAI provider key 与 Anthropic 付费额度；否则转 I.9.2 | 3–5 人日（多为实测） |
| G2-5 | Layer3 embedding | 需 embedding 模型来源（外部 API 或本地 onnx）与成本授权（D-12 只记账不熔断） | 指定模型来源，并确认是否允许外部调用与计费 | 5 人日 + 模型费 |

### B. 需用户提供环境（机器 / 系统 / CLI，2 条；表内另留 3 条已收口记录）　← 这 2 条 + A 的 G6-11 + I.9.2 的 G6-16 = I.1.2 的 **4** 条（G6-14 已于 v3.25 实测移出、G9-13 已于 v3.29 用 Windows CI 收口、G6-15 已于 v3.30 用真实 CLI 收口、G7-3 已于 v3.32 换 `serve` 收口、G7-2 已于 v3.33 换 `app-server` 收口）

| 编号 | 名称 | 卡点（一句话） | 用户需要做什么才能解 | 预估 |
|---|---|---|---|---|
| G6-7 | Codex 无句柄 | **CLI 已找到**（`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`，0.162.0-alpha.17.2）；只差一次「跑起来后杀死进程、重启看 `residual_risk` 与 UI 是否一致」的真机演练 | 无需再装 CLI；需允许跑一次真实 Codex 回合（耗模型额度） | 1 人日 |
| G6-15 | ~~OpenCode 轨迹~~ | **已于 v3.30 实施并移出本表**：CLI 装为 1.19.5，适配器改走 `run --format json`，工具轨迹由 CLI 自己产出（见 I.2.5） | — | — |
| G7-1 | 写前审批覆盖边界 | 三后端矩阵缺 Codex/OpenCode/MCP（Claude 侧已具备）；Codex 侧的本轮实测结论见 I.9.2 | 提供 `opencode` CLI；Codex 已可实测 | 3 人日 |
| G7-3 | ~~OpenCode 审批~~ | **已于 v3.32 实施并移出本表**：换到 `opencode serve`（`permission.asked` → 宿主钩子 → `/permission/{id}/reply`），真机验过 `once` 执行 / `reject` 不执行；见 I.2.6 | — | — |
| G7-2 | ~~Codex gateway~~ | **已于 v3.33 实施并移出本表**：换到 `codex app-server` JSON-RPC（`item/commandExecution/requestApproval` → 宿主钩子 → `{decision:'accept'}`），真机验过「放行后 marker 落盘」与「拒绝后文件不存在且回合判 `turn.failed`」；v3.29 否掉的是 `codex exec` 那条路，不是协议本身；见 I.2.6 | — | — |

### C. 曾需产品裁决、现已全部实施（4 条；保留裁决留痕，**不是待办**）

| 编号 | 名称 | 卡点（一句话） | 建议（用户回「按建议」即解） | 预估 |
|---|---|---|---|---|
| G1-14 | 提案机制（**已实施，v40，口径见 I.9.3**） | 是否本期引入 online 变更的提案留痕 | 建议：本期只做服务层 + 只读视图，不做 UI | 3 人日 |
| G2-1 | 五通道 / 模式库（**已实施，v41，口径见 I.9.3**） | 是否把「任务×执行器×作用域」固化成模式库 | 建议：先做代码常量 + `routing_decisions.mode_id` | 4 人日 |
| G7-5 | MCP 写工具（**已实施，同一 gateway，口径见 I.9.3**） | MCP 写工具是否纳入写前审批 | 建议：纳入，走同一 gateway | 2 人日 |
| G11-10 | tree-hash 等级（**已实施，v42，口径见 I.9.3**） | 是否为 E3 增加可选 `tree_hash` 绑定 | 建议：加可空列、不改 E3/E4 语义与 gate | 2 人日 |

### D. 已实施复核记录 + 可直接开工（混排；只有标「授权开工即可」的是待办）

| 编号 | 名称 | 卡点 | 用户需要做什么才能解 | 预估 |
|---|---|---|---|---|
| G1-9 | E4 覆盖扫描（**已实施，v43，口径见 I.9.3**） | 无外部依赖，只差 `content_hash` 基线 + 复扫 | 已完成：签收基线 + 独立扫描（≤500/轮） | — |
| G6-14 | Claude token 统计（**已实测通过，v3.25**） | 无（原卡点为「需 Anthropic 付费额度」，改口径后用 GLM 代理即可验 token 链路） | 已完成：U5 真实回合 PASS（`source=provider`、input=9672/output=30/cacheRead=7168、`cost_status=missing_price`）；**官方计费口径仍未验**（见 I.9.2） | — |
| G2-3 | `memory_hits` 表（**已实施，v44，口径见 I.9.3**） | 无 | 已完成：建表 + 幂等索引 + 180 天/单项目 20 万治理 | — |
| G2-2 | 进化 Layer1（**已实施，v45，口径见 I.9.3**） | 依赖 G2-3 建表 | 已完成：五终态同步采集 + `source_outcome` + 失败留痕 | — |
| G2-4 | Layer2 归因（**已实施，v46，口径见 I.9.3**） | 依赖 G2-2/G2-3 | 已完成：只读视图 + 强制 map_task 归因 + 样本阈值 | — |
| G2-16 | 离线校准 | 依赖 G2-14（已实施）/G2-15（已实施） | **已实施**（`maybeRunCalibration`：20 run / 2 周触发，`kind='calibration'` 只写报告；口径见 I.9.3） | 1.5 人日 |
| G2-15 | dirty diff | 无，口径与 G11-10 对齐 | **已实施**（`change_sets.dirty_files_count` v48 + `dirty_tree_hash` 指纹；失败显式 `-1`，口径见 I.9.3） | 2 人日 |
| G2-18 | 完整步状态机 | 无 | **已实施**（12 值声明式迁移表 + `waiting_approval → timed_out` + `work_step_changed`，口径见 I.9.3） | 3 人日 |
| G3-2 | 跨进程写闸 | 无 | **已实施**（复用 workspace lease，run 级 + fail-fast） | 3 人日 |
| G2-8 | WaveExecutor | D-07 已定：并发上限固定 1，落「分层串行」 | **已裁决不做**（2026-11-10：形态与现状等价） | 5 人日 |
| G2-9 | 黑板 / fanout | 无，L3 | 仅建议（暂不投：与 `memory_hits` 重叠、串行下 fanout 消失） | 6 人日 |
| G2-17 | 多 Agent 交互 | D-07 已定：串行多会话，上限 1 | **已裁决不做**（2026-11-10：形态与现状等价） | 7 人日 |
| G3-1 | Tier1 探测 | D-17 已定：先探测后升格 | **已实施**（`tier-probe.ts`：四项能力位 + 进程内缓存；写路径/tick 仅 Tier 1） | 3 人日 |
| G2-7 | Tier2 升格 | 依赖 G3-1 探测与审批桥（G7 系列） | 授权开工即可（前置完成后再做） | 3 人日 |
| G2-11 | 流程级测试最小版 | 依赖 W4 harness（已就位） | **已实施（测试-only）**：`flow-test-integration.test.ts` 全链两条；flow 计划生成/`selected_by='flow'` 明确不做（见 I.9.3） | 3 人日（剩余 4–5 人日另计） |
| G5-10 | 项目进度查询 | 无（D-03 已登记本期注册） | **已实施**（`v_project_progress` v47 + `map:project:progress` 只读通道） | 1.5 人日 |
| G6-17 | 同 uid 防御边界 | 无，文档为主 | **已实施（文档级）**（`agent-architecture.md` §6.5.1；无运行时检测） | 0.5 人日 |
| G7-7 | C3 exec 面 | 无 | **已实施**（literal 收敛 + 名单快照；env/cwd 不在本轮） | 3 人日 |
| G7-8 | 非 Claude 裸 spawn | 依赖 G3-1 探测 | **已实施（部分）**（声明 + 能力票降级 + 状态说真话；审批桥未做） | 0.5 + 5（完整桥）人日 |
| G2-10 | C1–C4 确认点 | 无（D-13 + D-18/D-19/D-20） | **已实施**（`confirmation-points.ts` + `step-confirmation-service.ts`：test/human 步逐点闸 + 必填展示项校验；approve 落 `acceptance_confirmations`、reject 落 `input_request_json`，口径见 I.9.3） | 4 人日 |
| G2-6 | 提案细节 | 依赖 G1-14 | **已实施**（v40，随提案机制：`conflict_group` 串行 / `weight` 仅展示 / 并发上限 3 / 24h 超时取消） | — |
| G2-19 | 提案只读通道 | 依赖 G1-14 | **已实施**（`proposal:list` / `proposal:diff` + 采纳/驳回写通道） | — |
| G8-3 | C1–C4 渲染 | 依赖 G2-10（**已实施**） | **已实施**（`StepConfirmationPanel.tsx`：C3/C4 展示 why/风险原因/必填展示项/决策记录，v3.14 起含通过/驳回出口与 `display` 投影，不复算风险；**C1 起草/修订入口已交付**——v3.15 面板 + gate 预检投影，v3.22 补 `PlanDraftComposer.tsx` 起草/修订编辑器与 `plan:draft:create` / `:revise` / `:get` 暴露，C1 列表有了数据源；**C2 修订 diff 面板已交付（v3.16）**，仅单任务字段级修订，四条边界见 I.9.3） | 5 人日 |
| G8-4 | 提案 UI（渲染） | 依赖 G2-19 | **已实施**（`NodeMapPanel` 列表 + diff 可视化，只读、不批量） | — |
| G8-5 | 任务卡深度 | 无（D-14 已定默认折叠） | **已实施**（`TaskCardTree.tsx` 四层折叠 + 证据按 `work_run_id` 归属；纯渲染派生，口径见 I.9.3） | 3 人日 |

### E. 建议不做 / 已登记不施工（2 条，另有 2 条账面遗留不计入 12）

| 编号 | 名称 | 卡点（一句话） | 用户需要做什么才能解 | 预估 |
|---|---|---|---|---|
| G1-11 | `agent_turns.node_id` 放宽 | 真实库 `agent_turns` 0 行、历史证据无伪节点，没有证据驱动改约束 | **建议不做**；除非出现伪节点污染证据再启动 | 1.5 人日 |
| G2-12 | 定向重测 | D-05 已裁决「只建 bug + 链接」，定向重测明确留 L3 | **建议不做**；保留设计，不排期 | 2.5 人日 |

> 账面遗留（不计入 12）：**G10-1** §13 审计表已收至 0 节缺细节（无剩余施工）；**G10-11** = G4-9，已实施，仅为重复引用。

### I.8.1 建议先解的三条（按用户解决难易度）

1. ~~**手工连边收尾（D，1–1.5 人日）**：补 `map:link:delete` handler + `map:link:create` 的 UI 入口 + 列表消费（I.0 第 2 条）。~~ **已于 v3.21 完成**：`LinkService.delete`（只删 `origin='human'`）+ 面板「关联连边」区（列表 / 新建 / 删除）+ 9 条测试（4 服务层 + 1 IPC + 4 面板）。「建错能撤」这条路径闭合。（原文此处推荐 G5-10，但它已于 v47 实施，属过期建议。）
2. ~~**G6-14 Claude token（A，0.5 人日）**~~ **已于 v3.25 完成**：U5 改为真实回合（`BIZGRAPH_EVAL_REAL_CLAUDE=1` 显式开关，默认 SKIP），走 cc-switch GLM 代理跑通 `claude -p` → `normalizeClaude` → `extractUsage` → `UsageLedger.record` → `agent_usage`，实测 PASS。**仍未解**：Anthropic 官方计费口径（缺付费额度，见 I.9.2），不影响本期验收。
3. ~~**G9-13 Windows 路径（B，1 人日）**~~ **已于 v3.29 完成**：没有等 Windows 机器，改用 CI 的 `platform-paths` job（`windows-latest`）跑真实 NTFS 语义——盘符前缀旁路、大小写不敏感、跨盘 `path.relative` 返回绝对路径、`\` 归一；并补了一条「断言宿主是 win32」的守卫，防止整块 Windows 用例 skip 后 job 假绿。打包侧原本就由 build 矩阵的 windows x64 / arm64 两项覆盖。

### I.8.2 已知缺口（如实登记，不构成待办、不造写入方）

- **`plan_drafts.rejected_boundaries_json` 无任何写入方**：全仓没有任何路径写这一列，只有 C1 的 `excludedItems` 投影在读它。因此 `excludedItems` 实际恒为空数组，界面显示「（空）」不是「没有排除项」，而是「这一列从来没有被写入」。**不要为它造写入方**；若将来确有推导侧要记录被排除的边界候选，再按真实消费方另立条目。
- **C2 修订原因未落库**：`map_migration_reports.kind` 的 CHECK 值域不含 `workitem_revise`，P2 未扩 CHECK、未开 v50，`workitem:revise` 返回 `audit.traced=false`，界面显示「未留痕」（见 I.9.3 G8-3 行⑧）。这不是「已留痕但没展示」，而是当前确实没有落点。**下次真有 schema 变更机会时**（任何需要扩该表 CHECK / 重建表 / 升 schema version 的改动），把 `workitem_revise` 加进 `map_migration_reports.kind` 值域即可——`probeReviseReasonSink` 的能力探测会在值域包含该值后自动开始写入，无需再改业务代码；在此之前不单独为它开迁移。
- **`chat_messages.token_count` 恒为 0（v3.25 实测发现）**：`ChatRepository.saveMessage` / `saveMessages` 都支持 `tokenCount` 入参，但全仓**没有任何调用点传它**（`src/main/agent`、`src/main/ipc`、renderer 三处均无 `tokenCount` 写入方），该列因此恒为默认 0。权威 token 口径在 `agent_usage`（G6-14 已实测 `source=provider` 真值）。**不要为它造写入方**：若将来界面要用「这条消息多少 token」做水位/估算，应先在 `message:save` 的调用方明确估算口径（估 `content` 还是用后端 usage 回填），再一并接上；现在写一个估算值只会让 0 变成「看起来精确的假数」。
- **进化层三张表只有读，没有管理动作（v3.25 边界）**：`memory_hits` / `v_memory_attribution` / 校准报告在设置页可见，但**不提供删除、重算、阈值调整**——这些表由 `WorkRunService` 终态采集与 `maybeRunCalibration` 自动写，界面只应观察。要「清理某项目命中」得走 `pruneMemoryHits` 的保留策略，不是界面点击。
- **手工连边交付不完整（v3.21 已闭环，保留为留痕）**：此前 `map:link:create` 有 handler 无 UI、`map:link:delete` 无 handler、`map:link:list` 无消费方。v3.21 补齐三件：`LinkService.delete`（只删 `origin='human'`，派生/导入显式 `not_human_origin` 拒绝；跨项目 `project_mismatch`；硬删并写日志）、IPC `map:link:delete`（已暴露，进结构化错误通道）、面板「关联连边」区（列表 + human 行删除按钮 + 同图节点下拉新建 `relates_to`）。注意边界：L1 仍只允许 `relates_to`，开其他类型需另开裁决。
- **证据建议的「接受 / 驳回」在界面上无入口（v3.21 已闭环，保留为留痕）**：三条通道（`accept` / `dismiss` / `e1:create`）此前 renderer 零调用。v3.21 在 `NodeMapPanel` 增加「证据建议（待裁决）」区：pending 列表 + 接受/驳回 + E1 手动输入（`ref` 指向当前节点，等级/写入方由主进程固定）。I.2 的 G1-10 / G3-10 已从「用户可见价值 = 0」改为 **= 1**。
- **preload 白名单 2 条已知缺口（v3.17 护栏登记，v3.21 / v3.22 / v3.24 逐批收紧）**：**1 条 S7 延后**——`plan:derive-candidates`（候选推导是 agent 辅助路径，无 renderer 消费方不扩写面；`plan:draft:create` / `plan:draft:revise` 已于 v3.22 暴露，`plan:draft:get` 同批进只读白名单供修订预填）；**1 条刻意不暴露且能力已被覆盖**——`admin:map:integrity-check`（启动 + 每日定时自动跑 `runLinkIntegrityCheck`）。**v3.24 已把 `project:import:preview` / `allowance:list` / `allowance:revoke` 三条接线并暴露**（导入确认框 + 放行规则管理；前两条是显式只读白名单条目、没进 `MAP_READ_ONLY_CHANNELS`，写通道 `allowance:revoke` 进结构化错误集合）；护栏豁免表里这三条已删除。**2 条当前无 renderer 调用方，故不存在活断头**，不是线上故障。补白名单 / 补 handler / 造写入方均需逐条裁决，本条目不构成授权。
  > **v3.24 订正一句旧判断**：上一版把这三条写成「判定逻辑已在 `graph:initFromProject` 内执行，缺导入前展示」，读起来像"只差一个展示"。实际后果更重：界面从不传 `allowBranchVariant`，判定层 `3a-auto` 对分支/副本**一律拒绝**，而拒绝路径的命中证据又在 IPC 边界被吞成 `IPC_HANDLER_ERROR`，且 `LeftPanel` 的 `catch` 是空的——用户点「生成思维导图」后**没有任何反馈**。这三条不是"锦上添花的展示"，是一条死掉的用户路径。
- **Codex 后端的工具调用没有宿主写前审批（v3.29 实机确认，不是推断）**：`codex exec` 的审批策略只能是 never —— 随包 `codex-cli 0.135.0` 与 ChatGPT 内置 `0.162.0-alpha.17.2` 的 `exec --help` 里，唯一与审批有关的开关是 `--dangerously-bypass-approvals-and-sandbox`（只能关、不能开），且 `-a/--ask-for-approval` 只存在于交互式顶层命令；`-c approval_policy="on-request"` 下真实回合的 MCP 调用仍返回 `MCP tool call requires approval, but approval policy is never`。SDK 的 `runStreamed` 又只透传 item 事件、没有审批回传通道，因此 Codex 会话里的写命令与 MCP 工具调用**都不经过 gateway**，只有 `workspace-write` 沙箱兜底；MCP server 由 CLI 按 `~/.codex/config.toml` 自行拉起，宿主既看不到也拦不住。**另有一条实测观察（v3.29，未修）**：`~/.codex/config.toml` 里配置了需要 OAuth 的 MCP server（本机为 `sentry`）时，`codex exec` 会在 `rmcp` 传输层反复重试 `AuthRequired`（stderr 可见 `worker quit with fatal: Transport channel closed`），回合在产出 20 个 item 后**挂住不返回**（实测 240s 未见 `turn.completed` 而被人为终止）。适配器沿用用户全局配置，因此同一份 config 会让 Codex 回合卡到超时；这是「回合卡住」而不是「工具失败」，现有超时兜底能收口但没有可读原因。**v3.29 只修掉了「假成功」**（见下条），真拦截仍待 I.8.B 的 G7-2 换协议。
- **被拒的 Codex 工具调用曾经报成功（v3.29 已修）**：`item.completed{type:'mcp_tool_call', status:'failed', error:{message:'… requires approval …'}}` 原先被归一化成 `tool.result{ok:true}`、output 写 `observed mcp_tool_call` —— 界面显示完成、step 记 `done`、disposition 记 `completed`，审计里完全看不到「被审批拒了」。现按 `status`/`error` 发 `tool.failed`（`ok:false`、output 为原始拒绝原因），工具名从 `mcp_tool_call` 改成 `mcp:<server>/<tool>`；阻塞 `run()` 路径同改，夹具取自真实 `codex exec --json` 输出。

## I.9 暂不开发队列（2026-11-10）

> **口径**：本节记录「用户指示暂不开发 / 当前环境无法验证 / 实施中的暂时妥协」。入队**不等于取消，也不改 I.1 状态词**。每条四项：**目的（想解决什么）/ 当前实现（做到哪）/ 差距（少了什么、后果是什么）/ 解除条件（什么情况下重新评估）**。任何暂时妥协必须在条目正文显式标注「**妥协**」，不得被读成已完成。
> **本机事实基线（2026-11-10 只读排查）**：Claude 走 cc-switch 代理 `http://127.0.0.1:15721`（`ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED`），模型映射为 `glm-5.3 / glm-5.3-flash / glm-5.1`（智谱），无 Anthropic 官方 token；Codex 配置 `model_provider="custom"` → `https://api.minimaxi.com/v1`（`wire_api="responses"`，`MiniMax-M3.1-Flash-Preview`），无官方 OpenAI 凭据；`codex` / `opencode` CLI 不在 PATH。

### I.9.1 用户指示暂不开发

| 编号 | 目的 | 当前实现 | 差距与后果 | 解除条件 |
|---|---|---|---|---|
| G6-15 | 验证 OpenCode 后端能否产出完整 turn 轨迹（工具事件） | **v3.30 已解除**：CLI 1.19.5 + `run --format json`，`OpenCodeStreamNormalizer` 产出 `tool.requested` / `tool.result` / `tool.failed` / `file.change`，token 取 `step_finish.tokens` | — （不再是缺口） | 已解除，移至 I.2.5 |
| G7-3 | OpenCode 写步骤走写前审批 | **v3.32 已解除**：换到 `opencode serve`，`permission.asked` → 宿主审批钩子 → `/permission/{id}/reply`；真机验证 `once` 后命令执行、`reject` 后命令不执行 | — （不再是缺口） | 已解除，移至 I.2.6 |
| G7-2 | Codex 写步骤走写前审批 | **v3.33 已解除**：换到 `codex app-server` JSON-RPC，`item/commandExecution/requestApproval` → 宿主审批钩子 → `{decision:'accept'}`；真机验证放行后命令执行（marker 落盘）、拒绝后文件不存在且回合判 `turn.failed` | — （不再是缺口） | 已解除，移至 I.2.6 |
| G7-1（矩阵部分） | 三后端写前审批覆盖矩阵 | Claude / OpenCode（G7-3 v3.32）/ Codex（G7-2 v3.33）三侧的写前审批都已具备，且批准与拒绝两半都有实机证据 | 仍缺 **MCP 工具路径**的矩阵（Codex/OpenCode 会话里由 CLI 自己拉起的 MCP server 尚未纳入同一网关），G7-1 不整体收口 | 把两后端的 MCP 工具路径接到同一 gateway 后再补测矩阵 |

### I.9.2 当前环境无法验证（凭据 / 官方协议）

| 编号 | 目的 | 当前实现 | 差距与后果 | 解除条件 |
|---|---|---|---|---|
| G6-16（官方侧） | 比较官方 OpenAI provider 与第三方 provider 的事件差异 | 本机 Codex 仅配置第三方 MiniMax provider | 缺官方 provider 样本，第三方 `item.updated=0` 不能代表官方行为；后果是无法给出 provider 差异结论 | 提供官方 OpenAI provider key，或明确不需要该结论 |
| G6-11（U1/U2/U5） | U1/U2 Codex 官方 provider、U5 Anthropic 付费回合的实测 | harness 已就位，R3/U3/U8/U4 已 PASS，U6/U7 SKIP | U1/U2/U5 依赖官方协议/计费，本机全为国内模型；后果是这三项无实测记录 | 提供 Anthropic 付费额度与官方 OpenAI provider key 后补测 |
| G6-14（官方计费口径） | 验证 Anthropic 官方付费回合下的 token 计费 | **已按改口径执行（v3.25）**：cc-switch 代理跑 GLM 回合，`claude -p` → `normalizeClaude` → `extractUsage` → `UsageLedger.record` → `agent_usage` 链路 PASS（input=9672 / output=30 / cacheRead=7168） | **妥协**：只验证了 token 统计链路；代理透传的模型名是上游真实名（`kimi-for-coding`），价格表无此条目 → `cost_status=missing_price`、`cost_micros=NULL`，**官方计费口径与价格仍未验** | 提供 Anthropic 付费额度后补官方口径（届时同一条 U5 会从 `missing_price` 变为 `priced`，可直接对照） |

### I.9.3 实施中的暂时妥协

> 随「按建议」条目落地逐条追加；每条必须写明妥协点与后果。

| 编号 | 目的 | 当前实现 | 差距与后果 | 解除条件 |
|---|---|---|---|---|
| G1-14 / G2-6 / G2-19 / G8-4 **（妥协）** | 提案机制的验收口径与交互完整度 | 服务层 + 只读视图 + 面板三层已落地；提案不写 online 图 | **妥协**：①采纳没有 E2 证据、无“已改 online”校验（仅 `acceptedBy`）；②`base_revision` 用节点 `updated_at`，同值重写不判 stale；③“降权”只排序未做 `low_weight` 徽标；④超时扫描依赖每日巡检，最坏晚约 24h；⑤无提案创建图形入口、图面不高亮被提案节点。后果：提案可审阅但采纳合规性仍靠人自觉 | 补 E2 采纳证据 + 内容 hash 基线 + 图面高亮后重新评估 |
| G2-1 / II-03 **（妥协）** | 执行模式可解释、可复盘 | 代码常量注册表 + `routing_decisions.mode_id` + `mode:list` 只读；无匹配 `TIER_UNSUPPORTED` | **妥协**：①模式不驱动参数/提示词/ContextBundle 装配，仅路由标签；②无模式库存储与可视化编辑，改模式须发版；③匹配键只有执行器 + policy + adapter 非空；④历史决策 `mode_id` 为 NULL 未回填。后果：能回答“这次走了哪个模式”，但不能“按模式调参” | 需要按模式调参/运营配置模式时重新评估 |
| G7-5 / II-审批 **（妥协）** | MCP 写工具不得绕过写前审批 | `McpAdapter.setTurnApprovalHooks` 接入 Driver，写类 MCP 工具执行前走同一 gateway；被拒不执行 | **妥协**：①只能按工具名动词清单判定写语义，名字不含写动词的未知写工具会漏判；②名字含写动词的读工具会被保守误判（多问一次）；③MCP 无路径参数时无法命中会话级授权，每次重新审批；④未覆盖 Codex/OpenCode 的 MCP 工具路径（G7-1/G7-2/G7-3 仍待办）。后果：已知写工具被兜住，未知写语义仍可能漏 | 拿到 MCP server 的 tools/list 注解或 schema 后按语义判定 |
| G11-10 / II-34 **（妥协）** | 为 E3 附上可复现的工作区树绑定 | `node_evidence.tree_hash`（v42 可空列）+ `EvidenceService` 仅 E3 接收 + TestExecutor 回填执行树 | **妥协**：①不参与 gate/完成度判定，仅可追溯；②不做 tree 级 diff、不能按 tree 回放历史现场；③E2 只写 `current_hash`/`ref_json.worktreeTree`，不写该列；④历史 E3 不回溯补值。后果：能比对“这次测试跑在哪棵树上”，不能据此改变验收结论 | 需要 tree 级 diff 或按树回放时（与 G2-15 合并）重新评估 |
| G1-9 / G5-5 **（妥协）** | E4 签收后覆盖内容/范围变化能被发现并降级 | `coverage_baseline_json` 基线（v43）+ `scanCoverageChangedE4All` 独立扫描（启动+每日、≤500/轮、幂等），变化置 stale 并区分 `stale_reason` | **妥协**：①**文件数 >200 / 无 `project_path` / 采集异常时只记 `skipped`，该签收不会因覆盖变化转 stale，只剩时间过期兜底**（已裁决，不阻断签收、不进 unknown）；②基线只覆盖签收时声明的文件，**签收后新增文件不会被发现**；③范围比对只比 `scope_files` 与 acceptance 条目 id，不比 revision 号、不比条目正文；④历史 E4 无基线不回溯；⑤扫描读盘成本随文件数线性增长（≤200/条、≤500 条/轮）。后果：能发现“签收过的文件被改/删”与“范围被改”，不能发现“新增文件”与超大覆盖集的变化 | 需要全量覆盖对账（含新增文件）或 >200 文件场景时，改增量快照（如 per-root tree hash）再评估 |
| G2-3 / II-05 **（妥协）** | 进化记录层有稳定、可裁剪、可幂等的落地表 | `memory_hits`（v44）+ `MemoryHitService`（幂等 record/list）+ `pruneMemoryHits`（180 天 / 单项目 20 万，启动 + 每日） | **妥协**：①写入方已随 G2-2（v45）接入，不再是空表；②归因视图已随 G2-4（v46）建好，**v3.25 起有只读 IPC 与界面**（`map:memory:hits:list` + 设置页「进化层」）；③保留治理是每日批处理，单项目可短暂超 20 万；④时间裁剪按 ISO 字符串比较，外部直写库的非常规时间格式不受保护；⑤`source_ref` 只校验非空，未强制 `表:id` 格式；⑥**界面只有最近 200 条（上限 1000）**，没有按 run/时间窗的翻页与导出。后果：记录层可查询、可裁剪、界面可见，但仍是诊断视图而非审计器 | 需要按 run 下钻、导出或长期审计时再补翻页与过滤面 |
| G2-2 / II-04 **（妥协）** | run 终态后把有效任务/步骤/证据/偏差沉淀为可归因记录 | `collectMemoryHitsForRun` 在 `WorkRunService` 五终态同步采集 step/evidence/deviation 引用；`source_outcome` 五值；每 run ≤50、幂等；失败写 `kind='integrity_check', stage='memory:<runId>'` 且不回滚 | **妥协**：①**`hit_kind='context'` 不产**（L1 无稳定上下文来源）；②证据 `score` 是固定等级权重（E1 0.6 / E2 0.8 / E3·E4 1），不是经验统计；③超 50 条静默截断（step→evidence→deviation），不额外留痕；④无 `project_path` 的 run 跳过，不产 hit；⑤采集与终态同线程同步执行，增加少量终态耗时；⑥记忆失败复用 `kind='integrity_check'`，需按 `stage='memory:*'` 区分。后果：Layer2 有数据可用，但 context 信号缺失、大 run 的尾部命中被丢 | **G2-4 / ContextBundle 有稳定上下文来源时补 `context`**；有证据表明 50 条上限丢关键命中时再评估 |
| G2-4 / II-06 **（妥协）** | 解释某类派发组合为何成功/失败，为策略层提供可复核数据 | 只读视图 `v_memory_attribution`（v46）：强制经 `node_session_links.session_origin='map_task'`，输出 adapter/mode_id/outcome/hit_count/evidence_level/sample_size/conclusion；跨图不聚合 | **妥协**：①**`tier` 维度不落库**，用 `mode_id` 代替，无法区分 Tier1/Tier2；②**v3.25 起有只读 IPC 与界面**（`map:memory:attribution:list` + 设置页「进化层」），但只展示行与汇总，不做分组重算；③`sample_size` 按 `(graph_id, adapter, mode_id)` 分区，未按 `step_kind` 细分；④`conclusion` 只有 `ok`/`insufficient_sample`，不算命中率数值、不给因果结论；⑤无命中的 run 也入视图（`hit_count=0`）；⑥视图每次查询实时算，无物化/缓存。后果：有可复核的样本量与终态分布、界面可见，但仍没有“哪条派发更好”的结论 | 需要因果结论或 Tier 维度时，补 `tier` 列与统计口径后重新评估 |
| G3-2 / II-23 **（妥协）** | 多进程/多窗口下同项目写任务互斥 | 复用 `WorkspaceLeaseRegistry`（文件租约）；`WorkExecutionService.tick` claim 前以 `item.project_path` 抢占，settle 后 `finally` 释放；抢不到 fail-fast 跳过（`project_busy`），不 claim/不消耗 attempt；默认关闭即 noop | **妥协**：①**无 `project_locks` 表**，状态落在 lease 文件（探测/排障是读文件不是查表）；②**无 `stale_lock_reclaimed` 事件**，过期回收只在下次 acquire 时静默发生；③TTL 默认 30s 可配，无 60s 上限钳制；④key 是 `project_path` 原串（trim），等价但拼写不同的路径不算同一项目；⑤**测试执行器未纳入**（临时 worktree 路径）；⑥**无 IPC/UI 状态**，`projectBusyItemIds` 只在 tick 返回与事件里可见。后果：单机多进程写互斥可用，但可观测性与路径归一化弱于原设计 | 需要审计锁历史/多窗口可视化，或测试执行器也要互斥时，再评估落表与事件 |
| G7-7 / II-27 **（妥协）** | 收敛沙箱可执行面，避免系统目录整目录放行 | `/bin`、`/usr/bin`、`/usr/sbin`、`/usr/libexec` 从 subpath 改为 literal；固定放行 shell/env/xcrun + 白名单命令解析路径 + node/npm/npx 的规范路径；git 只放行 `git-core` 子目录与 git 本体；`/System/Library` 仍是唯一目录级放行；网络类命令显式排除；名单快照进测试 | **妥协**：①**env 白名单与 cwd 未收敛**（本轮只做 exec 粒度）；②**`/System/Library` 仍整目录放行**（SIP 保护、不可枚举）；③未实现 `test_exec_profile` 常量，`evaluateBashPolicy` 未改；④**未枚举的写命令会失败**，只能得到内核 `EPERM`（`Operation not permitted`）由 CLI 转述，无法注入自定义可读文案；⑤审批与沙箱会故意互相打回，用户可能看到“已批准但执行失败”；⑥产品必需命令按 PATH 解析，PATH 变化会改变实际名单。后果：exec 面显著收窄、网络命令被挡，但可用命令集变小且失败文案依赖 CLI | 需要 env/cwd 收敛、自定义拒绝文案或更细的按命令策略时再评估 |
| G6-17 / II-26 **（妥协）** | 让用户/审计清楚“同 uid 不在防御范围” | 只写文档：`agent-architecture.md` §6.5.1 成段列跨 uid 承诺、同 uid 不承诺、攻击者门槛、不构成提权；本文 §10 增一致性行 | **妥协**：①**无运行时启动检测**，不扫描异常 marker、不校验密钥/目录属主权限、不对 symlink 条目告警；②异常只能靠 C13b 硬化与人工排障发现；③没有 UI 提示，用户需读文档才知道边界；④“已实施”仅指文档级，无代码证据。后果：边界可检索、可审计，但无法主动发现同 uid 攻击 | 需要启动自检/告警或 UI 边界提示时，再补代码并重估状态词 |
| G2-18 / II-20 **（妥协）** | 步状态迁移由声明式表约束、非法迁移可拒绝、迁移可观测 | `WORK_STEP_TRANSITIONS` 12 值 + `assertDeclared`（未声明抛 `INVALID_TRANSITION`）+ 5 处构造点 `onChanged` 发 `work_step_changed` | **妥协**：①**不新开 `event:work-step-changed` IPC 通道**，沿用 `event:work-item-changed`（payload 增 `stepId`），renderer 只能按 lineage 去抖重拉，无步级增量订阅；②`review` **当前无生产写入方**，`review → failed` 不实现（不为死状态加迁移）；③`work-run-service` 启动对账构造点未接 sink；④事件同步回调，`confirm` / `startStep` 事务内触发，不保证消费方在提交后收到；⑤`updateInputRequest` 不是状态迁移，事件按 `needs_input` 上报。后果：状态机可执行、可测试，但步级事件不是独立契约，`review` 分支仍无生产链路 | 需要步级订阅/独立通道，或接入 checker 生产写入方时，再补 IPC 与迁移 |
| G3-1 / II-22 **（妥协）** | 编排写路径只选能力齐全的后端，而不是按名字猜 | `tier-probe.ts` 四项能力位 + Tier 1–3 判定；写路径与 tick 只接受 Tier 1；进程内缓存 | **妥协**：①**`resume` / `structured_output` / `cancel` 是能力矩阵声明值，不是运行期实测**（无 `adapterVersion`、无 resume/结构化输出探测）；②缓存 key 的 `adapterVersion` 恒为 `unversioned`，升级适配器只能重启进程失效；③**无 5s 探测超时**（纯内存解析，无 I/O 可超），未来加真实探测时必须补；④`cancel` 只看接口存在即判真，不区分 abort/kill 语义；⑤Tier 2/3 只体现为拒绝写，不提供降级后的只读编排入口；⑥`routing_decisions` 的能力票是候选行 JSON，不进独立表、无查询 IPC。后果：能阻止缺能力后端写入，但“能力齐全”仍部分靠声明而非实测 | 拿到 adapterVersion 与运行期 resume/结构化输出探测手段后，补实测口径与超时 |
| G7-8 / II-28 **（妥协）** | 非 Claude（无审批回调）后端不得被误接进编排写路径，且 UI 要提前说清楚 | 复用 G3-1 能力票：Tier≠1 拒绝写入（`TIER_UNSUPPORTED`）；`map:execution:status` 返回 `tier`/`tierMissing`，非 Tier 1 置 `enabled=false` 并说明「只能裸 spawn」；`agent-architecture.md` §17.5/§17.6 写明边界 | **妥协**：①**没有搭审批桥**——普通节点会话 / 自由聊天 / 子代理仍裸 spawn、零宿主写前审批，完整修复量级等同 G7-2（≈5 人日，未授权）；②**没有只读裸 spawn 通道**，也没有 `unattended` 标注（G6-5 已删该分支，本轮不复活）；③**没有 `source=synthetic|backend` 输出标注**；④只覆盖编排写路径，不覆盖非编排链路；⑤`map:execution:status` 的 Tier 依赖运行期服务，服务缺失时只能退回环境变量口径。后果：编排侧被正确拦截并向用户解释，但非编排侧的安全洞原样保留 | 需要给非 Claude 后端补审批回调/网关（G7-2 级）时，才可能关闭“零审批”本身 |
| G5-10 / II-25 **（妥协）** | 项目进度可对账，但不想为只读聚合引入物化表/定时重算 | 只读视图 `v_project_progress`（v47）+ `map:project:progress` 通道；纯 SELECT，不写表、不触发派生 | **妥协**：①**`nodes_verified` 依赖派生缓存 `node_execution_state`**，缓存未算时数字偏低且不补算；②**无分页**（单项目一行）；③**未做 P95 < 100ms 基准**；④`evidence_by_level` 是 JSON 字符串，前端需自行解析（当前只暴露给调用方）；⑤项目归属靠 `project_path` 字符串精确匹配，不做路径归一（`/repo/a` 与 `/repo/a/` 视为两个项目）。后果：查询轻、无写放大，但数字可能滞后且路径口径需调用方自洽 | 派生缓存覆盖不全或项目数上千时，再评估物化/索引与基准 |
| G2-15 / II-17 **（妥协）** | 未提交改动进入 `change_sets`，避免证据只覆盖 commit | `change_sets.dirty_files_count`（v48）+ `dirty_tree_hash`；采集算 `sha256(HEAD + 排序 porcelain)`，同 `(head, hash, count)` 去重；失败写 `-1` | **妥协**：①**无独立 `dirty_capture_status` 列**，`-1` sentinel 兼表「未采集」，读方必须显式判负；②**指纹是 porcelain 文本 hash，不是真实 tree 对象 hash**，不跨机比较；③**文件路径与行数受 200 条截断**，超出只留计数；④二进制/超大文件按 0 行或读取失败计，无内容 hash；⑤**历史 `change_sets` 不回填**（v48 前为 `NULL`）；⑥dirty 与 commit **并列记录，不合并**，也不当 E3 代码 hash。后果：能回答「这个 run 有没有未提交改动、几个文件」，但不能当作可复现的树绑定 | 需要真实 tree 级 diff 或跨机比对时（与 G11-10 合并）再评估 |
| G2-16 / II-18 **（妥协）** | 用偏差数据回看推导规则，但不想引入自动调参 | `maybeRunCalibration`：20 run / 2 周触发，按四维归因聚合，写 `map_migration_reports(kind='calibration')`；不改阈值/权重 | **妥协**：①**按 `plan_deviations` 行数当 run 数**（假设 1 run 1 行）；②**不做 `file_domain` 分组**（II-16 视图 + `change_sets` 聚合成本未评估）；③**§5.7「连续 3 批 > 1.5」未做批次连续性**，只给单窗口信号；④**触发粒度为启动/每日检查**，不是第 20 个 run 落库瞬间；⑤**保留走每 `(kind,stage)` 20 行裁剪**，不是 1 年时间保留；⑥**v3.25 起有只读 IPC 与界面**（`map:calibration:report:list` + 设置页「进化层」），但只读最新 5 份、不做跨报告趋势对比；⑦窗口上限 5000 行，超出截断不额外留痕；⑧`kind` CHECK 扩容（v49）会让 `map_migration_reports` 启动时重建一次。后果：有可复算的聚合报告、界面可见，但离「自动校准」还差人工判断 | 需要自动调参、按 `file_domain` 归因或报告趋势对比时再评估 |
| G2-11 / II-13 **（妥协·范围收窄）** | 要端到端证明「计划→执行→测试→证据」可跑，但不想在本期做 flow 计划生成 | 新增 `flow-test-integration.test.ts`：flow spec 两步骤全过/一步失败两条全链，覆盖 `test_results`/`test_runs` 聚合、E3/E2 回写、失败建 bug + 元数据回链 | **三段差距（必须记住）**：①**flow 项标记**：`test_plan_items.selected_by='flow'` 未实现，项仍为 `'plan'`，**未扩 CHECK、未重建表、不做 v50**；②**`steps_json` 展开**：`test_specs.kind='flow'` 的有序步骤→plan items 只在测试内手工完成，**生产无此入口**；③**§6.5.1.1 完整 flow 计划生成**：子图框选 → 拓扑排序 → 每节点 verify+shell 两步 → `test_report` 落 `test_runs.report_ref` **全部未做**；另执行器失败后**不短路**后续步骤。**原因**：II-13（测试条目，3 人日）与 §6.5.1.1（flow 计划生成功能）定义不一致，本次按 II-13 的验收口径收口；剩余部分在真出现 flow 计划生成入口时按 **4–5 人日**重估，**不得把本条读成 flow 计划已可用** | 出现「框选子图生成 flow 计划」的真实需求时，按 4–5 人日重估并另立条目 |
| G8-5 / II-31 **（妥协）** | 任务卡按「任务→步→run→证据」分层，深层证据可定位 | `TaskCardTree.tsx` 纯渲染派生：用 `workitem:get` 已返回的 steps/runs + 节点证据（`node_evidence` 的 `work_item_id`/`work_run_id` 本就在行内）按 run 分组；任务/步/run 展开键只存组件内存；任务列表容器 `max-h-[60vh] overflow-y-auto` | **妥协**：①**未做虚拟滚动**——默认折叠到任务级时 100 条只渲染任务头，靠容器滚动；任务数远大于 100 **且全部展开**时没有窗口化，DOM 会线性增长；②**证据在树内与节点证据列表重复出现**（树内是归属视角，列表是全量视角），未做去重；③run→证据依赖 `node_evidence.work_run_id`，历史 E1 等无归属证据只能落在任务级「未绑定运行」；④`work_item_id` 为空的证据不进入任何任务卡；⑤展开态不落库（符合 D-14），代价是刷新/切节点即恢复默认，无法保留现场；⑥无「全部展开/收起」批量操作。后果：四层可展开、数据一致、默认视图轻，但超大任务集与展开态留存未解决 | 需要 >300 任务或全展开性能问题，或要求展开态跨刷新保留时，再评估虚拟滚动/持久化 |
| G2-10 / II-12 **（妥协）** | 高风险步才要人工确认，且确认事实可审计、不落已废止的表 | `confirmation-points.ts`（C1–C4 必填展示项 + `deriveStepRisk` 两档）+ `step-confirmation-service.ts`（`inspect`/`listForItem`/`maybeGate`/`decide`）；tick 对 `test`/`human` 高风险步建闸；approve 写 `acceptance_confirmations`（`entry_id`=C3/C4），reject 写 `input_request_json`；`map:confirmation:status` 只读 / `map:confirmation:decide` 写 | **妥协**：①**风险只有两档**，只按 G4 的 20 文件 / 800 行判定，无三档量表（D-19）；②**行数不可预估时只按文件数**并写明限制；③**C1/C2 的必填展示项校验在 IPC 边界**（校验 renderer 提交的 `display` 键），不在服务内部组装展示数据（C3/C4 于 v3.14、C1 于 v3.15、C2 于 v3.16 起由服务端 `display`/`workitem:diff` 投影提供内容，校验点不变；C2 仅单任务字段级）；④**reject 不写 `acceptance_confirmations`**（`(work_item_id, step_id, entry_id)` 唯一索引会占位），改由 `input_request_json` 承载，读「驳回过」只能查步的该列；⑤**C4 驳回后不自动再次建闸**（驳回标记视为已决策），返工推进需人工触发；⑥**两个服务实例**（tick / IPC）共用同一行数 estimator 与同一张表，不是单例；⑦**agent 步不建计划期确认点**（D-18），其不可逆性继续归 runtime 逐工具审批；⑧**无 `gated_at`/`decided_at` 独立列**，时间只存在 `decision_note` / `input_request_json` 的 JSON 里。后果：确认闸可用、事实可审计、不新增表，但没有三档风险语义，也不能按「被驳回过」单独索引查询 | 需要按风险等级做差异化交互（如 medium 只提示不阻断），或需要独立查询驳回历史时，再评估扩维度/加列 |
| G8-3 / II-29 **（妥协）** | 用户能看懂「这一步为什么要确认」以及风险来自哪里，且 UI 不自己发明风险等级 | `StepConfirmationPanel.tsx` 渲染 `map:confirmation:status` 的 point/trigger/risk/reasons/requiredDisplay/`display`/decision；低风险且无决策不渲染；任务级「待确认」角标；v3.14 起面板内「通过 / 驳回」写 `map:confirmation:decide`，`display` 原样回传；`mapStore` 在 `fetchWorkItemDetail` 里并行拉取 | **妥协**：①**C3/C4 面板 + C1 计划草稿区 + C2 修订 diff 面板**；C1 于 v3.15 补齐面板（`PlanDraftPanel.tsx`），**数据源（起草/修订入口）已于 v3.22 补齐**（`PlanDraftComposer.tsx` + `plan:draft:create` / `:revise` / `:get` 暴露，见 I.8.F），C2 于 v3.16 补齐（`WorkItemRevisionPanel.tsx`，入口在任务卡「修订（C2）」，**只做单任务字段级修订**，表达不了新增/删除/合并/拆分）；②**展示内容由服务端投影**（`display` / `workitem:diff`），renderer 不拼装、不复算，缺项即禁用按钮；③**每个任务一次额外只读请求**，任务多且全展开时请求数线性增长，未做批量/缓存通道；④**风险原因完全取自后端**，renderer 不推断、不排序、不合并；⑤**成功后不本地改状态**，只清错误、等 broadcast 重拉；⑥**错误码只在 store 翻中文**，面板不解析错误串；⑦**C3/C4 4+8 条、C1 起草/修订 6+4 条单元用例验收**，无 GUI 截图演练（本环境不具备）；⑧**C2 的 impact 只有三项可推导内容**，「文件是否真会被改动 / 哪些 run 失效 / 哪些证据 stale」标 `missing`；修订原因因审计表 CHECK 不含 `workitem_revise` 而显示「未留痕」；⑨**运行中任务受既有 §4.7.3 守卫拒绝**——`WorkItemService.revise` 在旧 revision 存在 `running` 的 work_run 时直接拒绝，不排队、不新造状态，执行中修订必须先等 run 结束。后果：C3/C4 可在面板内走通；**C1 起草 → 提交 → 确认/驳回 → 修订全链可走通**（v3.22 起，candidateScore / anchorStates 对手工草稿如实给空）；C2 可做单任务字段级修订但不覆盖蓝图定义的结构变更，核心联动仍缺数据来源，执行中修订被既有守卫挡回 | 需要 C2 覆盖新增/删除/合并/拆分或 run/证据失效联动时，另立通道与数据来源后重新评估；确认视图请求过多时再加批量通道 |
| G8-2 **（妥协）** | 画布能体现「任务的真实执行状态」并在多个历史会话间切换 | ① 派生徽标：`BizNode` 读 `mapStore.overlayByGraph.executionStates`，按 `node_entity_key` 匹配，渲染 `execution_state`（`untouched` 不渲染），title 带证据级别；`GraphCanvas` 靠 `event:node-execution-state` 增量更新。② 时间线切换：`NodeMapPanel` 列 `map:node:timeline` 返回的 threadIds 全集，点一条 → `loadMessages` → `selectThread` → 切右侧面板 | **妥协**：① **徽标只认 `entityKey`**，节点无 `entity_key` 时徽标静默不显示（旧数据/未回填）；② **徽标不区分证据级**，只给状态词，`E2` 与 `E3` 在视觉上同为「verified 的前提」需要点开面板才知道；③ **已结束会话切过去只能读历史**，输入框仍指向当前线程，UI 只用 title 提示，没有强制的只读态；④ **切换不改数据模型**、不写 `node_session_links`（`primary` 角色不随切换改变）；⑤ **面板内切换不关闭面板**，地图仍占主视区，右侧面板被切到 agent —— 用户可能没注意到视图已换；⑥ ~~`map:node:timeline` 仍 `SELECT *` 直出，`TimelineEntry` 靠 `as unknown as` 强转，无编译期约束~~ **已于 v3.21 修复**：`TimelineEntryDTO` 显式列 + 主进程逐字段映射，加列/改名两端编译期报错（原代码问题清单 §6 收口）。后果：三件都能用，但徽标是"状态词级"而非"证据级"，会话切换的只读语义靠文案而非机制 | 需要按证据级着色、或需要「多会话并排对照」时，再评估扩展示维度与只读态约束 |
| G1-4 / S1 导入查重 **（妥协）** | 重复导入不得生成第二套 lineage，且用户在有冲突时看得懂、有合法出口 | `ImportDedupService` 四信号判定（目录名/项目名/相似度/采样数）+ `import_rejections` 留痕；v3.24 补齐出口：`project:import:preview` 只读预判、`ImportDedupDialog.tsx` 按 action 三分（proceed / confirm / blocked）、`allow_branch_variant` 需显式勾选、`import_allowances` 可查看可撤销；`ImportRejectedError` 结构化（`IMPORT_REJECTED` + `details.decision`） | **妥协**：①**放行规则管理只在导入冲突对话框内**，没有独立设置页——不触发一次冲突就看不到规则列表；②**预览与导入是两次独立判定**，两次之间项目内容变化会让预览结论与最终判定不一致（导入那次以服务端为准，失败了会重新报错而不是静默）；③**硬拒绝无任何绕过入口**（1 / 2a / 3b / 4a）——这是有意的，界面只解释原因；④**相似度阈值仍是常量**（0.6 / 0.8），未做按 `import_rejections` 分布调参；⑤**`allow_with_warning` 的确认不落库**，`import_rejections` 只记 reject 与两类放行，用户"点过继续"没有独立审计行；⑥**无 GUI 截图演练**（本环境不具备），验收靠 6+7+2 条用例。后果：分支/副本导入这条路径从"死路"变成"需要明确同意"，但放行规则的可见性依赖冲突场景 | 需要独立管理页 / 阈值调参 / `allow_with_warning` 独立审计时，再评估加只读查询与配置面 |

### F. G8-3 剩余出口的前置（C1 已于 v3.22 交付起草入口与数据源，C2 已于 v3.16 实施但有边界）

> 只登记前置与估算，**不构成排期或施工授权**。C3/C4 出口已于 v3.14 打通（见 I.9.3）；C1 的 P1 已于 v3.15 实施面板与 gate 预检投影（`plan-draft-precheck.ts` + `PlanDraftPanel.tsx`），**并于 v3.22 补上数据源**：`plan:draft:create` / `plan:draft:revise` / `plan:draft:get` 三条通道暴露 + `PlanDraftComposer.tsx` 起草/修订编辑器（`NodeMapPanel` 计划草稿区常显 + 「起草计划」入口），C1 列表不再恒空，「驳回」不再是单向死路（draft / awaiting_confirm 均可修订，confirmed 由主进程拒绝）。手工起草是**人工单步计划**入口，不与 D1/D3 护栏的「不用模型自由生成」冲突；`plan:derive-candidates`（agent 按候选辅助起草）仍延后（I.8.2）。C2 的 P2 已于 v3.16 实施（`work-item-revision.ts` + `WorkItemRevisionPanel.tsx`），**但只覆盖单任务字段级修订**，见 I.9.3 的 C2 妥协行。

| 前置 | 现状（复核点） | 不做的后果 | 估算 |
|---|---|---|---|
| **P1. C1 草稿级 `gateMissing` 预检投影** | **已实施（v3.15 面板 + gate 预检投影；v3.22 数据源）**：草稿 item 投影为合成 `WorkItemRow` 后交给生产同一个 `createGateEngine`（同一份 `readG4Config()` + `buildEstimateLines()`），G1/G2/G3/G4/G6 缺失码原样输出；G5 因草稿依赖是 plan key 显式跳过并登记原因；`candidateScore` 取 `boundary_candidates`（蓝图称 `plan_candidates`）按 `derivation_run_id` 整批、`anchorStates` join `node_execution_state`、`excludedItems` 映射 `rejected_boundaries_json`（该列当前无写入方，如实给空）。v3.22 起 `plan_drafts` 有了写入路径：`plan:draft:create`（手工起草，落 draft 状态）、`plan:draft:revise`（新 revision，旧行 superseded）、`plan:draft:get`（修订预填原文），`PlanDraftComposer.tsx` 只做形状级校验（非空/键唯一/依赖可解析/环预检），gate 缺失由服务端投影在创建后展示、renderer 不复算。手工起草未关联推导批次，`candidateScore` / `anchorStates` 对这类草稿如实给空（不伪造）。agent 路径仍不写这张表；接「agent 按候选自动起草」要另开 `plan:derive-candidates` 裁决 | 计划草稿确认界面提交必被拒（必填展示项无内容，按钮只能禁用），等于没有出口 | 实际 **约 3 人日**：预检投影 + 4 项投影 1.5 / 通道与 UI 1 / 用例 0.5（v3.22 实际另加编辑器与三通道约 0.5 人日） |
| **P2. C2 历史读通道 + 字段级 diff 投影** | **已实施（v3.16）**：`workitem:history` 按 lineage 读全部 revision（不改 `is_current` 语义）；`workitem:diff` 服务端算字段级 before/after + `impact` 三项（写域集合差 / 验收按 id 配对 / 依赖增删），推不出的显式标 `missing`；`gateResult` 历史对比取落库 `gate_status`、拟修订走生产 gate 引擎预检。`WorkItemRevisionPanel.tsx` 接既有 `workitem:revise`（preload 补白名单），无新写路径。修订原因因审计表 `kind` CHECK 不含 `workitem_revise` 而**未留痕**（未扩 CHECK / 未开 v50），界面如实显示 | 修订 diff 界面只能展示单任务字段级变化；蓝图定义的「新增/删除/合并/拆分」与「run 失效 / 证据 stale」联动仍无通道/数据来源 | 实际 **约 2.5 人日**：历史读通道 + diff 0.75 / impact 与 gate 投影 0.75 / UI 0.75 / 用例 0.25 |

> P1 已交付面板、预检投影与数据源（v3.22 起草入口落地）；P2 已完成。**C2 仍有边界四条**：①结构变更（新增/删除/合并/拆分）不可用，`workitem:revise` 只接受单任务字段级修改；②`impact` 的「哪些 run 失效 / 哪些证据 stale」无数据来源，只能标 `missing`；③运行中任务（旧 revision 存在 `running` 的 work_run）受既有 §4.7.3 守卫直接拒绝，不排队；④修订原因不留痕（审计表 `kind` CHECK 不含 `workitem_revise`，界面显示「未留痕」）。上述边界登记在 I.9.3，不构成新的施工授权。

## I.10 代码侧问题清单（单独成文）

> **为什么不放进本文**：本文是「状态总账」——记录做了什么、没做什么、卡在哪。代码问题是另一类事实——「做出来的东西哪里不牢」。混在一起会让总账变成缺陷列表，两边都读不清。故单独成文。

**文件**：`docs/architecture/code-issues-2026-11-11.md`（基线 `007f9d2`）。**2026-11-11 三次处理**：§1–§6 全部收口（§1/§4/§5 修配置与测试，§2/§3/§6 补 UI / handler / DTO，产品逻辑只增不改）。状态以该文开头的总览表为准，下表只是索引。

| # | 问题 | 状态 |
|---|---|---|
| 1 | `ipc-preload-allowlist.test.ts` 是负载敏感 flake（单跑绿、全量 5s 超时） | **已修**：该 describe 超时 30s |
| 2 | 证据建议 accept/dismiss、E1 手写三条通道已暴露、renderer 零调用 | **已修（v3.21）**：面板建议区 + E1 输入，9 例测试 |
| 3 | `map:link:delete` 全仓无 handler | **已修（v3.21）**：`LinkService.delete` + IPC + 列表/新建/删除 UI |
| 4 | 本机 `better-sqlite3` 预编译 ABI 115 vs Node 22 的 ABI 127 | **已处理**：`npm rebuild`，仅动 `node_modules` |
| 5 | 全量测试不绿 | **已修（v3.21）**：26 例环境类改为按用例能力探测 skip（带原因），全量 **0 失败** |
| 6 | `map:node:timeline` 用 `SELECT *` 直出 + `as unknown as` 强转 | **已修（v3.21）**：`TimelineEntryDTO` + 显式列映射，两端编译期约束 |

> 上述 6 条均**不属于**「文档与代码不一致」，而是代码本身的健壮性问题。本文各条目的状态词不改动；§2/§3 闭环后 I.2 的 G1-10 / G3-10 已从「用户可见价值 = 0」改为 **= 1**。
> **注意**：§5 的「全量不绿」在本机已收口（环境类 skip 带原因）。CI 上尚未真跑过一次，故仍写成「待 CI 验证」而非「CI 已绿」。

# Part II 仅建议项施工级设计（5 条有效 + 已实施/不做项保留为设计存档）



> **口径**：本部分把 I.1.3 的 5 条**仅建议**补到可施工级别；状态词一律保持 **仅建议**，补设计不等于批准，不进入本期验收。**II-12/13/15/16/17/18/20/22/23/24/25/26/27/28/29/31/32/33 与 II-02/03/04/05/06/08/21/30/34 已实施；II-10、II-19 已裁决·不做——均保留为设计存档、不再计入「仅建议」**。每条给 7 项：目标与不做后果 / 数据与接口 / 流程与状态机 / 边界与约束 / 验收 / 前置依赖与顺序 / 成本（均为**估算**，非承诺）。原 13 条「阻塞于 D-xx」已于 **2026-11-08** 随 I.4 全部裁决而解除，相关留空处已按裁决结果补成定稿；**解除阻塞只代表方向可定，不代表获得施工授权**——其余 5 条仍为仅建议。
> **索引**（G4-1/2/3 分别等同 G2-11/12/13，G8-6 等同 G3-3，不重复设计）：

| II | G | 主题 | 落点章节 | 阻塞 |
|---|---|---|---|---|
| II-01 | G1-11 | `agent_turns.node_id` 放宽 | §4.5 / §7.2 | — |
| II-02 | G1-14 | 提案机制 | §2.7 | 已实施（v40） |
| II-03 | G2-1 | 五通道 / 模式库 | §5.9.8 | 已实施（v41） |
| II-04 | G2-2 | 进化 Layer1 记录 | §5.9 | 已实施（v45） |
| II-05 | G2-3 | `memory_hits` 表 | §4.2 | 已实施（v44） |
| II-06 | G2-4 | Layer2 归因 | §5.9 | 已实施（v46） |
| II-07 | G2-5 | Layer3 embedding | §4.2 | 已解除（D-12） |
| II-08 | G2-6 | 提案细节 | §2.7 | 已实施（v40） |
| II-09 | G2-7 | Tier2 升格 | §5.9.5 | 已解除（D-17） |
| II-10 | G2-8 | WaveExecutor | §5.5 | **已裁决·不做**（D-07） |
| II-11 | G2-9 | 黑板 / fanout | §5.9.8.1 | —（暂不投） |
| II-12 | G2-10 | C1–C4 确认点 | §5.6 | 已实施（v3.12） |
| II-13 | G2-11 | 流程级测试最小版 | §6.6 | 已实施（v3.10，测试-only） |
| II-14 | G2-12 | 定向重测 | §6.6 | 已解除（D-05：留 L3） |
| II-15 | G2-13 | published 软阻断 | §6.6 / §14 | — |
| II-16 | G2-14 | `v_plan_deviations_file_domain` | §5.7 | — |
| II-17 | G2-15 | dirty diff | §4.6 | 已实施（v3.8） |
| II-18 | G2-16 | 离线校准 | §5.7 | 已实施（v3.9） |
| II-19 | G2-17 | 多 Agent 交互 | §5.9.8.1 | **已裁决·不做**（D-07） |
| II-20 | G2-18 | 完整步状态机 | §5.9.8 | 已实施（12 值迁移表） |
| II-21 | G2-19 | 提案 UI | §9.4 | 已实施（v40） |
| II-22 | G3-1 | Tier1 探测 | §5.9.10 | 已实施（v3.5） |
| II-23 | G3-2 | 跨进程写闸 | §5.9.3 | 已实施 |
| II-24 | G3-3 | renderer 执行入口 | §9.2 | 已实施（本包） |
| II-25 | G5-10 | 项目进度查询 | §3.6 | 已实施（v3.7） |
| II-26 | G6-17 | 同 uid 防御边界 | §6.5 / §10 | 已实施（文档级） |
| II-27 | G7-7 | C3 exec 面 | §6.4 / §10 | 已实施 |
| II-28 | G7-8 | 非 Claude 裸 spawn | §5.9.5 / §10 | 已实施（部分，v3.6） |
| II-29 | G8-3 | C1–C4 渲染与出口 | §9.4 | 已实施（v3.13/v3.14） |
| II-30 | G8-4 | 提案 UI（渲染） | §9.4 | 已实施（v40） |
| II-31 | G8-5 | 任务卡深度 | §9.4 | 已实施（v3.11） |
| II-32 | G9-8 | RequestQueue 删除 | §4.5 | 已实施（`80075e7`） |
| II-33 | G9-10 | worktree 清理 | §8.10 | — |
| II-34 | G11-10 | tree-hash 等级 | §3.2 | 已实施（v42） |

## II.1 地图本体与提案

### II-01 · G1-11 `agent_turns.node_id` 放宽｜**仅建议**
- **目标与不做后果**：允许"不挂节点"的 turn（自由会话、工具回合）正常落账，不为记账伪造伪节点；不做则每条 turn 必须造节点或干脆不记，污染图与时间线。
- **数据/接口**：`agent_turns.node_id` 由 `NOT NULL` 改为可空（`schema.ts:90`），SQLite 重建表（v36，需 `_backup`）；新增部分索引 `idx_agent_turns_node ON agent_turns(node_id) WHERE node_id IS NOT NULL`；`node_session_links` 不改为可空。
- **流程/状态机**：写入时只在 turn 绑定节点时填 `node_id`；解绑或自由会话写 `NULL`；恢复规划遇到 `NULL` 跳过节点级聚合，仅按会话回放。
- **边界**：空串与 `NULL` 不等价，禁止写 `''`；所有节点聚合查询必须显式 `node_id IS NOT NULL`；D8 已取消伪节点，不新增映射表。
- **验收**：无 `node_id` 的 turn 可插入并完成；节点时间线、`work_steps` 关联与崩溃恢复测试不变；迁移重入两次结果一致；`PRAGMA foreign_key_check` 为空。
- **前置依赖与顺序**：依赖 W1 的 turn 写回稳定；在 W1 之后、W5 之前做。无裁决阻塞。
- **成本**：≈1.5 人日（估算），主要是重建表与回归。

### II-02 · G1-14 提案机制｜**已实施（v40，2026-11-10）**
> **做了什么**：`ProposalService`（create/list/diff/accept/reject/expireStale）复用 `work_items.metadata.proposal`（before/after 以 JSON 字符串存储，服务端可自动快照 before），只读视图 `v_online_proposals` 计算 `stale`，部分唯一索引 `ux_work_items_open_proposal` 保证同实体一个 open；提案不创建 steps、不进入执行调度、**任何路径都不写 nodes/edges**。v40 迁移：`metadata` 可空列 + 视图 + 索引。
> **妥协在哪**：①验收口径中的 “accepted” 用既有 `work_items.status='done'` 表达，没有新增枚举值；②采纳不产生 E2 证据，也没有独立的“采纳人已改 online”校验（只有 `acceptedBy` 审计字段）；③`base_revision` 取锚定节点 `updated_at`，不是节点内容 hash，节点被同值重写时不会判 stale；④提案区只提供列表/diff/采纳/驳回，不提供图形化创建表单（创建走 `proposal:create` 通道）。
- **目标与不做后果**：产品图（online）变更以提案留痕、人工采纳，不让实现细节自动污染产品事实；不做则 dev→online 只能靠口头约定。
- **数据/接口**：复用 `work_items`，新增 `metadata.proposal = {before, after, reason, evidence_refs, base_revision}`；新增只读视图 `v_online_proposals`；**不新增表**。
- **流程/状态机**：`draft → awaiting_confirm → accepted(人编辑 online 后 done) / rejected(cancelled+理由)`；同一实体只允许一个 open 提案（部分唯一索引 `WHERE status IN ('awaiting_confirm','queued')`）；采纳幂等键 `lineage_id + revision`。
- **边界**：提案不得自动应用、不得批量静默采纳、不做自动回滚（撤销=人工反向编辑）；`before/after` 超过 200KB 截断并标 `truncated`；`base_revision` 与 online 当前不一致 → 标 `stale`，需重提。
- **验收**：提案全程不触发 online 图写；同实体第二个 open 提案被拒；驳回必带理由；`v_online_proposals` 只读。
- **前置依赖与顺序**：II-08（提案细节）与 II-21/II-30（UI）在后；本身可先落服务层。
- **成本**：≈3 人日（估算）。

## II.2 多图编排、进化与计划

### II-03 · G2-1 五通道 / 模式库｜**已实施（v41，2026-11-10）**
> **做了什么**：新增代码常量 `mode-registry.ts`（4 个模式：`agent.implement` / `agent.fallback` / `test.verify` / `human.review`，上限 32，id 唯一与格式校验在模块加载时 fail-closed）；`routing_decisions` 增可空 `mode_id`（v41，仅 ALTER）；`ensureRouting` 按「执行器 + policy + adapter 非空」规则匹配，无命中抛 `TIER_UNSUPPORTED`；`RoutingDecisionRepository.record` 对未知 `mode_id` fail-closed；`mode:list` 只读通道返回注册表副本。
> **妥协在哪**：①模式只是路由标签，**不驱动执行器参数、提示词或 ContextBundle 装配**（`contextBundle` / `ioContract` 仅声明）；②没有模式库存储、可视化编辑或运行期增删（改模式必须改代码发版）；③匹配键仅执行器 + policy + adapter 是否为空，未使用任务类型/作用域做细分；④历史 `routing_decisions` 的 `mode_id` 为 NULL，不做回填。
- **目标与不做后果**：把"任务类型 × 执行器 × 作用域 × ContextBundle × IO 契约"固化成可路由的通道定义；不做则每次靠人拍脑袋选执行器，无法审计与复现。
- **数据/接口**：模式定义放在代码常量 `mode-registry.ts`（不建表）；`routing_decisions` 增加 `mode_id`（可空列，不进 `requiredColumns`）；读取接口 `listModes()` 只读。
- **流程/状态机**：任务 → 确定性规则匹配模式 → 能力票校验（II-22）→ 命中即写 `routing_decisions(mode_id, policy)`；无匹配 → `TIER_UNSUPPORTED`，不静默降级。
- **边界**：模式上限 32 条；未知/非法 `mode_id` fail-closed；运行期不可改模式定义（改则重启生效）；模式不得包含写步骤以外的隐式动作。
- **验收**：每条 run 的 `routing_decisions` 均有 `mode_id`；删除某模式后历史行仍可读；未知模式请求返回结构化错误而非默认 Tier1。
- **前置依赖与顺序**：与 II-22 能力探测同批；先常量后落库。
- **成本**：≈4 人日（估算）。

### II-04 · G2-2 进化 Layer1（记录层）｜**已实施（v45，2026-11-10）**
> **做了什么**：`collectMemoryHitsForRun` 在 `WorkRunService` 五个终态方法（`complete` / `fail` / `timeout` / `cancel` / `markInterrupted`）紧邻 `scheduleForRun` 同步采集：`step` → `work_step:<run.step_id>`、`evidence` → `node_evidence:<id>`（按 E1–E4 固定权重 0.6/0.8/1/1）、`deviation` → `plan_deviation:<id>`；每 run ≤50 条、幂等（唯一索引）；每条带 `source_outcome`（v45 列，五终态如实记录）。采集失败 `try/catch` 吞掉，写 `map_migration_reports(kind='integrity_check', stage='memory:<runId>', status='failed')`，run 终态不变。
> **妥协在哪**：①**`hit_kind='context'` 不产**——L1 没有稳定上下文来源，值为保留（I.9.3 已登记，解除条件：G2-4 / ContextBundle 有稳定来源）；②证据 `score` 是固定等级权重，不是经验统计值；③超过 50 条时**静默截断**（先 step、再 evidence、再 deviation），不额外留痕；④无 `project_path` 的 run 直接跳过（`memory_hits.project_path` 非空且不跨项目聚合）；⑤采集与 run 终态同线程同步执行，失败虽不回滚但会给终态写入增加少量耗时；⑥`map_migration_reports` 复用 `kind='integrity_check'`（不扩 CHECK、不重建表），无法只按 kind 区分记忆失败，需按 `stage='memory:*'` 查。
- **目标与不做后果**：记录"哪类任务/上下文/步骤组合有效"，为归因与策略层提供数据；不做则 Layer2/3 无输入，进化机制空转。
- **数据/接口**：写 `memory_hits`（见 II-05）；触发点从蓝图原设想的 `recomputeAfterRun(runId)` 改为 `WorkRunService` 五个终态方法（该接口在代码中不存在），只写引用不写全文。
- **流程/状态机**：run 终态 → 采集（step 结果、证据等级、偏差）→ 幂等写；采集失败只写 `map_migration_reports(kind='integrity_check', stage='memory:<runId>')`，不回滚 run。
- **边界**：每 run 最多 50 条 hit；不跨项目聚合；保留 180 天；不写用户原文与密钥；`source_outcome` 五值必填。
- **验收**：同一 run 重算两次不重复写；任意 hit 可回溯到 `run/step/evidence`；五终态均有 `source_outcome`；失败不改变 run 终态。
- **前置依赖与顺序**：II-05 建表先行；Layer1 可独立上线，不依赖裁决。
- **成本**：≈2 人日（估算）。

### II-05 · G2-3 `memory_hits` 表｜**已实施（v44，2026-11-10）**
> **做了什么**：`MAP_MEMORY_TABLE_SCHEMAS` 建 `memory_hits`（11 列，`hit_kind` 四值 CHECK、`score` 0–1 CHECK；v45 再增 `source_outcome` 可空列），索引 `idx_memory_hits_project_created` 与唯一 `ux_memory_hits_run_kind_ref`；`MemoryHitService` 提供幂等 `record`（重复键回读既有行）、`listForRun`、`countForProject`；`pruneMemoryHits` 做 180 天 + 单项目 20 万滚动删除，挂在启动与每日任务。纯建表 + 建索引，无数据迁移。
> **妥协在哪**：①写入方已由 G2-2（v45）接入（五终态同步采集）；②~~没有 IPC / UI 读取入口~~ **v3.25 已补**：`map:memory:hits:list` 只读通道 + 设置页「进化层」（最近 200 条、上限 1000，无翻页/导出）；③保留治理是启动 + 每日批处理，不是实时裁剪，因此单项目可短暂超过 20 万行；④`pruneMemoryHits` 按 ISO-8601 字符串比较时间，依赖写入方统一用 `toISOString()`（`record` 已保证），外部直接写库的时间格式不在保护范围；⑤`source_ref` 只校验非空，未强制 `表:id` 格式。后果：记录层可查询、可裁剪、可幂等，但尚无归因视图。
- **目标与不做后果**：给记录层一个稳定、可查询、可裁剪的落地表；不做则命中记录散落日志，无法归因。
- **数据/接口**：`memory_hits(id, project_path, graph_id, node_id, work_item_id, run_id, step_id, hit_kind, source_ref, score, created_at)`；索引 `(project_path, created_at)`、`(run_id, hit_kind, source_ref)` 唯一。
- **流程/状态机**：只插入不改写；`hit_kind ∈ ('context','step','evidence','deviation')`；去重键即唯一索引。
- **边界**：`score` 0–1；`source_ref` 必填且为稳定键（表:id）；单项目上限 20 万行，超限按最旧滚动删除；保留 180 天。
- **验收**：唯一索引拒绝重复；滚动删除不越界；查询 P95 < 50ms（10 万行本地库）。
- **前置依赖与顺序**：迁移一次建表 + 索引；先于 II-04/II-06。
- **成本**：≈1.5 人日（估算）。

### II-06 · G2-4 Layer2 归因｜**已实施（v46，2026-11-10）**
> **做了什么**：新增只读视图 `v_memory_attribution`（`schema.ts` / v46），列 `run_id, step_id, graph_id, adapter, mode_id, outcome, hit_count, evidence_level, sample_size, conclusion`。归因入口**强制** `JOIN node_session_links l ON l.work_run_id = r.id AND l.session_origin='map_task'`——手工面板/子代理/测试 run 即使有 hit 也不入视图；`outcome` 优先取 `memory_hits.source_outcome`、无命中时按 run 终态映射；`sample_size` 用窗口函数按 `(graph_id, adapter, mode_id)` 分区，<20 标 `insufficient_sample`；同 run 多条链接用 `SELECT DISTINCT` 收口。
> **妥协在哪**：①**`tier` 维度不存在**——`routing_decisions` 只有 `mode_id`（G2-1），视图用 `mode_id` 代替 `tier`，无法区分 Tier1/Tier2；②~~没有 IPC / UI 入口~~ **v3.25 已补**：`map:memory:attribution:list` 只读通道 + 设置页「进化层」（行 + 命中率/样本汇总，不做分组重算）；③`sample_size` 按 `(graph_id, adapter, mode_id)` 分区，未按 `step_kind` 细分，不同步骤类型混在同一分区；④`conclusion` 只有 `ok` / `insufficient_sample` 两值，**不计算命中率数值、不产出因果结论**；⑤无命中的 run 仍入视图（`hit_count=0`），依赖 `outcome` 区分成败；⑥无定时重算——视图是纯派生，每次查询实时计算。
- **目标与不做后果**：解释"为什么某类任务成功/失败"，把命中与 `node_session_links`、`work_steps` 关联；不做则只有原始记录没有结论。
- **数据/接口**：只读视图 `v_memory_attribution(run_id, step_id, graph_id, adapter, mode_id, outcome, hit_count, evidence_level, sample_size, conclusion)`；不新增写表。
- **流程/状态机**：视图按查询实时派生，可随时 `DROP/CREATE` 重建；不做增量写。
- **边界**：跨图不聚合；样本 < 20 标 `insufficient_sample`；不把相关性写成因果；必须经 `session_origin='map_task'` 归因，不绕过链接。
- **验收**：同一数据重建两次结果一致；样本不足显式标注；视图查询不影响 run 表；manual_panel / 无链接 run 不入视图；同 run 多链接不重复。
- **前置依赖与顺序**：II-04/II-05 之后；II-07 之前。
- **成本**：≈2 人日（估算）。

### II-07 · G2-5 Layer3 embedding｜**仅建议**（原阻塞 D-12 已解除）
- **目标与不做后果**：用向量检索相似任务/证据，支撑候选复用；不做则只能关键词匹配，召回低。
- **数据/接口**：`task_embedding(entity_key, model, dim, vector_blob, updated_at)`，主键 `(entity_key, model)`；检索接口 `similarTasks(queryVec, k=5)`。
- **流程/状态机**：离线批算（增量按 `updated_at`）→ 写 blob → 检索；模型不可用降级 `getRecent(3)`，不阻断编排。
- **边界**：维度上限 1024；单条向量 ≤ 4KB；外部调用成本按 **D-12 已裁决**「只记账、不自动熔断」处理；失败只降级不改任务状态。
- **验收**：top-k=5 返回且附相似度；模型缺失时走降级并留痕；重建索引可重入。
- **前置依赖与顺序**：II-04/II-06 之后；**D-12 已裁决**（成本只记账、长尾不投入），可直接动工。
- **成本**：≈5 人日（估算，不含外部模型费用）。

### II-08 · G2-6 提案细节｜**已实施（v40，随 II-02）**
> **做了什么**：`conflict_group` 同组串行（后者 `blocked`，前序 accept/reject 后自动提升为 `awaiting_confirm`）；`weight` 0–1 仅影响列表排序并在 UI 展示；同实体非终态上限 3；blocked 等待超 24h 由启动 + 每日 `expireStale` 自动 `cancelled`（`reject_reason='waiting_timeout'`）。
> **妥协在哪**：①冲突串行只按 `conflict_group` 单键，不检测同实体不同组的并发冲突；②“降权”只做展示排序，未实现 `low_weight` 徽标（UI 显示 `w=0.xx` 数值）；③超时扫描依赖每日巡检节奏，最坏晚约 24h 才收口，不是精确计时器。
- **目标与不做后果**：把提案的冲突、降权、撤销规则定死；不做则多人同时提案会互相覆盖。
- **数据/接口**：沿用 `metadata.proposal`，增加 `conflict_group`、`weight`（0–1）；冲突串行队列由服务层内存 + `work_items` 状态保证。
- **流程/状态机**：同 `conflict_group` 串行（后者 `blocked` 等前者终态）；被降权提案在 UI 标 `low_weight`；撤销 = `cancelled` + 反向编辑记录。
- **边界**：同实体并发提案上限 3；降权不改 `status`；串行等待超 24h 自动 `cancelled` 并留理由。
- **验收**：并发提案按串行顺序产生；超时自动取消有记录；降权仅影响展示排序。
- **前置依赖与顺序**：II-02 之后；II-21/II-30 之前。
- **成本**：≈2 人日（估算）。

### II-09 · G2-7 Tier2 升格｜**仅建议**（原阻塞 D-17 已解除）
- **目标与不做后果**：让 Tier2 后端在"只读 / 排队人工"之外有受控的升格路径；不做则 Codex 类后端永远不能参与写编排。
- **数据/接口**：`routing_decisions.policy` 增 `tier2_bridged`；能力票增加 `approval_bridge` 位；不新增表。
- **流程/状态机**：Tier2 → 只读；若 `approval_bridge=1` 且写前审批可拦截 → 可写；拦截缺失则拒绝升格。
- **边界**：升格必须 fail-closed；不得"先跑后补审批"；单次升格仅限单步，不跨任务。
- **验收**：无桥的 Tier2 写请求被拒并落 `routing_failed`；有桥的写步骤审批事件齐全。
- **前置依赖与顺序**：先做 II-22（探测）；**D-17 已裁决「先解冲突再升格」**，顺序为「审批桥 → 探测 → 升格」，未补桥不得动工升格。
- **成本**：≈3 人日（估算，含桥接）。

### II-10 · G2-8 WaveExecutor｜**已裁决·不做**（2026-11-10；保留为设计存档）

- **裁决（2026-11-10）**：**不做**。D-07 已定并发上限固定 1、不排队、fail-fast；本节「落地形态」本身就是「分层串行调度，保留层结构与并行开关但不启用真并发」，与现状的串行 tick 调度等价，投入 5 人日只换来一层不会被开启的抽象。记法同 G7-10：登记为设计边界，不升格为已批准未实施。若将来放开并发（需重开 D-07），本节可直接复用。
- **目标与不做后果**：按 Kahn 层并行执行同层任务，压缩总时长；不做则永远串行，层信息只用于排序。
- **数据/接口**：复用 `work_items.depends_on_json` 与层号；新增内存调度器 `WaveExecutor`，不新增表；并发上限读配置。
- **流程/状态机**：确认 → 分层 → 逐层 claim → 层内并发（受写闸与全局上限）→ 全部终态后进下一层；层内失败按 §5.5.1 聚合。
- **边界**：并发上限默认 1（即退化为串行）；同项目写闸互斥；不保证兄弟步互见（§5.9.8.1）。
- **验收**：并发上限=1 时行为与串行一致；上限=2 时两任务不共享写闸；层间顺序不可越过。
- **前置依赖与顺序**：II-20 状态机与 II-23 写闸先行；**D-07 已裁决维持 fail-fast**，并发上限固定为 1，本项落地形态为「分层串行调度」（保留层结构与并行开关，不启用真并发）。
- **成本**：≈5 人日（估算）。

### II-11 · G2-9 黑板 / fanout｜**仅建议（暂不投）**

- **暂不投理由（2026-11-10）**：①**检索面与 `memory_hits` 重叠**——G2-3/G2-4 已提供命中记录与归因视图，黑板的 top-k=5 检索会形成第二套记忆入口；②**串行下 fanout 语义消失**——D-07 并发上限 1，本节存在的首要理由（「为 L3 并行提供共享记忆」）不再成立，只剩串行跨步传递，可用 `work_runs.outputs_json` 直接承接。状态仍为仅建议，不进入本期验收；放开并发时再评估。
- **目标与不做后果**：为 L3 并行提供受约束的共享记忆；不做则并行后无跨步上下文，或被"记忆时序"绑架正确性。
- **数据/接口**：黑板键空间 `blackboard(project, task, key)`，存于内存 + 可选落 `work_runs.outputs_json` 引用；Phase B 接口 `extractAfterSession(sessionId)`。
- **流程/状态机**：步终态写入必须在 session terminate 与 Phase B 之后（§5.9.8.1）；Phase B 失败只影响可见性。
- **边界**：TTL 24h；单键 ≤ 8KB；不注入兄弟分支产物；检索预算 top-k=5；超限先裁片段再裁摘要。
- **验收**：Phase B 失败时 step 仍可终态；重启后黑板不承诺恢复（显式丢弃）；不出现"依赖黑板时序"的用例。
- **前置依赖与顺序**：II-10 之前或同批；不依赖裁决。
- **成本**：≈6 人日（估算）。

### II-12 · G2-10 C1–C4 确认点｜**已实施（v3.12，2026-11-10）**（原阻塞 D-13 已解除）
> **做了什么**：新增 `confirmation-points.ts`（C1–C4 的必填展示项、拒绝路径、`deriveStepRisk` 两档风险）与 `step-confirmation-service.ts`（`inspect` / `listForItem` / `maybeGate` / `decide`）。`test`/`human` 步在 tick 中被判为高风险时由 `waiting_approval` 建闸（`confirmationGatedStepIds` 回报）；approve 写 `acceptance_confirmations`（`entry_id`=C3/C4），reject 因唯一索引会占位而改写 `input_request_json`（C3 → `cancelled`，C4 → 返工 `pending`）；`work_steps` 补声明边 `waiting_approval → pending` + `returnToPending`。C1（`plan:draft:confirm`）与 C2（`workitem:revise`）在 IPC 边界做必填展示项校验，缺项即拒绝。新增 `map:confirmation:status`（只读）与 `map:confirmation:decide`（写）通道。**未新建表、未做 v50、未给 `work_steps` 加字段。**
> **妥协在哪**：①**风险只有两档**（low/high），只按 G4 的 20 文件 / 800 行判定，不引入三档量表（D-19）；②**行数不可预估时只按文件数**，原因文本显式写明限制，不默认 high；③**C1/C2 的展示校验在 IPC 边界**（校验 renderer 提交的 `display` 键完整性），不在 `PlanDraftService` / `WorkItemService` 内部；④**reject 不写 `acceptance_confirmations`**（唯一索引 `(work_item_id, step_id, entry_id)` 会占位，同一步无法再记第二次决策），改用 `input_request_json`，因此「这条步被驳回过」只能从步的 `input_request_json` 读；⑤**C4 驳回后不自动再次建闸**（驳回标记视为已决策，避免每次 tick 都弹回确认），返工完成后由人重新推进；⑥**确认视图与闸是两个服务实例**（tick 一处、IPC 一处），但共用同一个行数 estimator 与同一张表；⑦**agent 步不建计划期确认点**，继续依赖 runtime 逐工具审批（D-18）。详见 I.9.3。
- **目标与不做后果**：把四个人工确认点做成结构化契约（展示项、必填项、拒绝分支）；不做则确认退化为"是否同意"按钮。
- **数据/接口**：确认事实落 `acceptance_confirmations`（`entry_id` 承载 C1–C4，`decision_note` 承载 `{decision, point, risk, reasons, note}` JSON）；**不落 `agent_approvals`**——该表只承载工具调用审批，v35 已明文废止人工确认落该表。C1/C2 的展示数据由只读接口组装，服务层只校验必填项；不新增表。
- **流程/状态机**：C1 强制 → 生成 `work_items`；C2 强制 → 新 revision；C3 强制 → 测试计划哈希绑定（`plan_hash` 二次校验沿用 `test-plan-service`）；C4 强制 → 人工写 `nodes.status` 前。拒绝路径复用 12 值步状态机：C3 → `cancelled`，C4 → `pending`（返工），不新造状态。
- **边界**：C1/C2 不得合并；C3 不得"记住本次选择"永久授权；C4 不得默认勾选"已完成"；任一项缺失展示字段即拒绝确认。`agent` 步不建计划期确认点（D-18）。
- **验收**：每个确认点有独立 UI 与拒绝记录（UI 归 II-29）；缺字段的确认被服务层拒绝；审批到期 fail-closed。已由 `confirmation-points.test.ts`、`step-confirmation-service.test.ts` 覆盖。
- **前置依赖与顺序**：**D-13 已裁决「仅高风险步确认」**；D-18/D-19/D-20 为其实施级补充；II-29 渲染同批。
- **成本**：≈4 人日（估算）。

### II-13 · G2-11 流程级测试最小版｜**已实施（v3.10，测试-only）**
> **范围声明**：本条目按 **集成测试** 收口，不是 flow 计划生成。`test_plan_items.selected_by='flow'` 与 CHECK 扩张**明确不做**（保持 `'plan'`，不重建表、不做 v50）；`test_specs.kind='flow'` 的 `steps_json` → 有序 plan items 展开**不在生产实现**，由测试侧完成。
> **做了什么**：新增 `src/main/__tests__/flow-test-integration.test.ts`，用真实 `TestPlanService` + `TestExecutor` + `EvidenceService` + `ApprovalGateway`（假命令执行/worktree）跑两条 flow 用例：①两步全过 → 逐条 `test_results` 留痕（`plan_item_id`/`spec_id` 可回溯）、`test_runs` 聚合 `passed`、E3（`code_version`=baseCommit、`tree_hash`=worktree tree、`work_run_id` 绑定）、worktree 清理；②第二步失败 → `test_runs` 聚合 `failed`、失败项 `test_results` 可按 `plan_item_id` 定位（`failure_class='assertion'`）、只落 E2、自动建 bug 节点 + `bug_nodes(open)` + 修复 work_item，bug `metadata` 回链 `test_run_id`/`plan_id`/`plan_item_id`/`verifies_entity_key`，失败现场保留 worktree。
> **妥协在哪**：①**flow 项标记缺失**：plan items 仍为 `selected_by='plan'`，不能按「流程来源」在计划层筛选；②**`steps_json` 无生产展开入口**：测试内手工按顺序生成 items，真实使用时仍需预置 plan；③**§6.5.1.1 完整 flow 计划生成未做**：子图框选 → 拓扑排序 → 每节点 verify+shell 两步 → `test_report` 落 `test_runs.report_ref` 全部缺失；④执行器**不短路后续步骤**（失败后仍继续跑余下 item），flow 语义里的「任一步失败即停」未实现。四者均为剩余 4–5 人日范围，等真出现 flow 计划生成入口时按该量级重估，**不得把本条读成 flow 计划已可用**。
- **目标与不做后果**：用最小流程用例证明"计划→执行→测试→证据"整链可跑；不做则只有单测，端到端无人验证。
- **数据/接口**：`test_specs.kind='flow'`（实际列名，非 `scope`）+ `steps_json` 承载有序步骤；`test_plan_items` 仍用 `selected_by='plan'`；产出 E3 证据（命令 + commit + 代码 hash）。
- **流程/状态机**：确认测试计划 → worktree 执行 → 写 `test_results` → 汇总 `test_runs` → 回写证据；失败按 §6.6 建 bug + 链接（不接自动定向重测）。
- **边界**：流程用例数上限 10；单条超时 60 分钟；`env_fail` 不建 bug；不覆盖 manual；不扩 `selected_by` CHECK、不做 flow 计划生成。
- **验收**：一条流程用例从计划到 E3 全链留痕；失败可定位到 `test_result`；重复执行幂等。
- **前置依赖与顺序**：依赖 W4 harness（已就位）；**D-05 已裁决「仅建 bug + 链接」**，流程级测试只覆盖执行与证据链，不接自动定向重测闭环。
- **成本**：≈3 人日（估算；本次仅付测试部分，剩余 flow 计划生成另计 4–5 人日）。

### II-14 · G2-12 定向重测｜**仅建议**（原阻塞 D-05 已解除；裁决为留 L3）
- **目标与不做后果**：修复后只重跑失败用例与同 suite 相关用例；不做则每次全量重跑，慢且噪声大。
- **数据/接口**：`test_plan_items.selected_by='targeted'`，来源 `test_result` 失败集合；新增只读查询 `targetedCases(testRunId)`。
- **流程/状态机**：bug 修复 run 完成 → 生成定向计划 → C3 审批 → 执行 → 通过则新 E3 + `bug_nodes.retested_at`。
- **边界**：选取上限 20 条；找不到关联用例则回退全量并标注；不由系统自动关闭 bug。
- **验收**：定向计划只含失败+相关用例；通过后 bug 行可反查 `test_result`；全量重跑需人触发。
- **前置依赖与顺序**：**D-05 已裁决「B 仅建 bug + 链接」**，定向重测明确留 L3；本期仅保留设计，不排期。
- **成本**：≈2.5 人日（估算）。

### II-15 · G2-13 published 软阻断｜**已实施（采用 §6.5.2.1）**
- **口径裁决（2026-11-10）**：**作废**本节旧稿的「gate → `incomplete(published_requires_confirm)` → `waived` + `agent_approvals`」路线。published 软阻断统一按 §6.5.2.1「徽标 + 统计 + 发布豁免」实现，两套事实不得混用：
  - **G2 gate waiver**：`work_items.gate_status='waived'` + `gate_waived_by/at/reason`，管任务执行前的 gate；
  - **published waiver**：`nodes.published_waiver_json`，管测试资产发布，只影响徽标/统计，不写 `gate_status`、不阻断任务执行。
- **数据/接口**：`nodes.published_waiver_json`（v39 新增可空列）；`has_pass_evidence` 经 `test_specs.test_node_entity_key` → 执行记录（`test_results`/`test_runs`）→ 未撤销 E3；**不直接查 test-case 节点自身证据**；不新增表。
- **流程/状态机**：`node:update` 把节点置为 `published` 时检查；test 图 + `test-case` + 无通过记录 → 必须带完整 `{by, at, reason, missing[]}`，否则返回 `PUBLISHED_WAIVER_REQUIRED`；有通过记录直接放行。
- **边界**：只作用于 test 图 + `test-case` 节点；不改变 `gate_status`；不新增发布入口；UI 不做，只提供只读 `map:published:status`。
- **验收**：`published-guard.test.ts` 覆盖豁免解析、通过记录口径、E3 撤销/非 fresh、拦截与徽标统计；`database-migration.test.ts` 覆盖 v39 加列；`graph-node-update.test.ts` 覆盖 `publishedWaiverJson` 入参校验。
- **代码证据**：`src/main/map/published-guard.ts`、`src/main/ipc/graph.ts`（`node:update` 拦截）、`src/main/ipc/map.ts`（只读 `map:published:status`）、`src/main/database.ts`（v39）。
- **前置依赖与顺序**：已随 v39 落地。
- **成本**：≈1.5 人日（估算）。

### II-16 · G2-14 `v_plan_deviations_file_domain`｜**已实施**
- **目标与不做后果**：把偏差按"文件域"展开，作为回答"哪类文件最容易估错"的明细底座；不做则偏差只有单 run 维度、无法按目录定位。
- **数据/接口**：只读视图 `v_plan_deviations_file_domain(deviation_id, work_run_id, derivation_version, observed_rule_version, task_type, agent_type, file_path, file_domain)`，逐偏差/逐文件展开；`file_domain` 取路径第一个 `/` 之前的目录前缀（含尾斜杠）。
- **流程/状态机**：纯派生；启动时 `DROP VIEW IF EXISTS` + `CREATE VIEW` 对账；不写表、不改数据。
- **边界（本期口径）**：**只做 §7.2 明细视图**。不带 `project_path`；不做 `runs / avg_planned / avg_actual / rework_rate` 聚合列；不做域数上限 32、不做 `insufficient` 标注、不截断。上述聚合降级为"在明细视图之上按需聚合"，确有报表需求时再加，不在本视图内实现。
- **验收**：`plan-derivation.test.ts` 覆盖跨目录一行一域、无斜杠路径空域、无 change_set 占位行、8 列口径、重复对账幂等；`database-migration.test.ts` 覆盖 v38 启动补齐视图。
- **代码证据**：`src/main/map/schema.ts:788-817`（`MAP_VIEW_SCHEMAS` / `applyMapViews`）、`src/main/database.ts:766`（v38）、`src/main/database.ts:1324-1352`（checksum 含 views，快/慢路径对账）。
- **说明**：v38 将视图定义纳入 schema checksum；现有校验原先只管表与索引，本次补上 view 清单。回滚 `DROP VIEW IF EXISTS v_plan_deviations_file_domain`，无表/数据变更。
- **前置依赖与顺序**：`plan_deviations` 数据积累后启用。
- **成本**：≈1 人日（估算）。

### II-17 · G2-15 dirty diff｜**已实施（v3.8）**
> **做了什么**：`change_sets` 增 `dirty_files_count INTEGER`（v48，可空：`NULL` = 无未提交改动或未采集，`-1` = 采集失败）；`workspace-change-stats.ts` 的 `collectWorkspaceChanges` 在采集 commit 差异的同时算 `dirtyTreeHash = sha256(HEAD + "\n" + 排序后的 porcelain 行)` 与 `dirtyFileCount`（全量，不受 200 条截断）。`WorkRunService.captureHead` 接收 `dirtyFileCount`，同 `(head, hash, count)` 直接复用旧行（幂等/去重）；新增 `markDirtyCaptureFailed(workRunId)` 写 `dirty_files_count=-1, dirty_tree_hash=NULL`。`AgentStepRunner.recordChangeHead` 在快照为 null 或采集抛错时调用它，不再静默当作「无变更」。
> **妥协在哪**：①**无独立 `dirty_capture_status` 列**，用 `-1` sentinel 兼表「未采集」，读方必须显式判负，误判为 0 的风险靠注释与测试兜；②**指纹基于 `git status --porcelain` 文本**，不是真实 tree 对象 hash，同一改动在不同 git 版本/配置下文本可能不同（不跨机比较）；③**文件路径与行数都受 `MAX_RECORDED_FILES = 200` 截断**，超出只保留计数，`change_sets.files_json` 不完整；④**二进制/超大文件**按 0 行或读取失败计，不做内容 hash；⑤**history 不回填**：v48 之前的历史 `change_sets` 该列为 `NULL`（读作「未采集」），无迁移回填；⑥dirty 与 commit 维度**并列记录，不合并、不互斥**，也不把 dirty 当 E3 代码 hash（E3 仍认 commit / tree）。
- **目标与不做后果**：把"未提交改动"纳入 `change_sets`，避免证据只覆盖 commit；不做则 E3 与真实工作区不一致。
- **数据/接口**：`change_sets.dirty_files_count`（v48 可空 INTEGER）+ 既有 `dirty` / `dirty_tree_hash`；采集在 run 结束（`recordChangeHead`）时执行。
- **流程/状态机**：采集 → 去重（同 hash + 同 count + 同 head 不重复写）→ 与 commit 维度并列；采集失败写 `-1`「未采集」标记，不编造空集。
- **边界**：文件数 > 200 只记计数与前 200 路径；二进制/超大文件只记计数；不把 dirty 当 E3 代码 hash；`-1` 不等于 0。
- **验收**：有未提交改动时 `change_sets` 落 `dirty_files_count` 与 `dirty_tree_hash`；采集失败落 `-1` 且 `dirty_tree_hash` 为 NULL；同 run 重算幂等（`agent-step-runner.test.ts`、`database-migration.test.ts`）。
- **前置依赖与顺序**：与 G11-10（tree-hash 等级）同口径；G2-16 离线校准可在此基础上做。
- **成本**：≈2 人日（估算）。

### II-18 · G2-16 离线校准｜**已实施（v3.9）**
> **做了什么**：`map/plan-calibration.ts` 新增 `aggregateCalibration`（纯聚合）与 `maybeRunCalibration`（触发 + 写报告）。触发条件：距上次 `kind='calibration'` 报告新增 ≥20 个 `plan_deviations` 行，或距上次报告满 14 天（取先到者）；**样本 <20 run 一律不出报告**（2 周分支也只记日志）。报告按 `(derivation_version, observed_rule_version, task_type, agent_type)` 分组，输出实际/计划文件数与子任务数比值、`replan` 中位数、返工/测试失败计数、越界率、边界变化率，以及 §5.7 的两个单窗口信号（`file_growth_gt_1_5`、`replan_median_gt_2`），写入 `map_migration_reports(kind='calibration', stage='periodic')` 一行 `stats_json`。`map_migration_reports.kind` CHECK 扩为含 `'calibration'`（v49，由 `rebuildTableIfNeeded` 重建）；启动 + 每日各检查一次。全程**不改任何阈值/权重、不改 `plan_deviations`、不触发其他写路径**。
> **妥协在哪**：①**按偏差行数当 run 数**（假设 1 run 1 行），若未来一 run 多行会高估样本；②**不做 `file_domain` 分组**（II-16 视图依赖 `change_sets`，聚合成本未评估）；③**§5.7 的「连续 3 批 > 1.5」未做批次连续性判定**，只给单窗口信号；④**触发粒度是启动/每日检查**，不是「第 20 个 run 落库那一刻」；⑤**保留按 `pruneMapMigrationReports` 的每 `(kind,stage)` 20 行**，不是设计写的 1 年时间保留；⑥**无 IPC/UI 入口**，报告只能直接读库或看日志；⑦窗口上限 5000 行（`CALIBRATION_MAX_WINDOW_ROWS`），超出截断且不额外留痕。
- **目标与不做后果**：每 20 run / 2 周用偏差数据回看推导规则，输出报告而非自动改权重；不做则规则永远拍脑袋。
- **数据/接口**：读 `plan_deviations`，产出 `map_migration_reports(kind='calibration')`；不写权重表。
- **流程/状态机**：启动/每日检查 → 汇总 → 写报告行 → 人工确认后才改常量（无自动写）。
- **边界**：样本 < 20 run 不出报告；不自动调整任何阈值；报告保留走现有 20 行/组裁剪（不是 1 年）。
- **验收**：报告可复算（`aggregateCalibration` 幂等）；不产生自动写；触发条件可观测（日志 + 报告行）。
- **前置依赖与顺序**：II-16/II-17 之后（二者均已实施）。
- **成本**：≈1.5 人日（估算）。

### II-19 · G2-17 多 Agent 交互｜**已裁决·不做**（2026-11-10；保留为设计存档）

- **裁决（2026-11-10）**：**不做**。D-07 定并发上限 1、串行多会话、不排队；本节边界已写明「兄弟步不互见」且不引入排队，落地后与现有单会话串行推进在可观察行为上等价，7 人日买不到新能力。记法同 G7-10。若将来放开并发再评估。
- **目标与不做后果**：定义多会话协作的边界（谁能读谁、产物怎么合并）；不做则只能单 Agent 串行。
- **数据/接口**：复用 `node_session_links` 多对多 + `work_runs` 归属；新增 `collab_scope` 元数据；不新增表。
- **流程/状态机**：fanout → 子任务各自 run → 合并只认 `work_runs`/证据，不认黑板时序；冲突走 II-11 约束。
- **边界**：**D-07 已裁决维持 fail-fast**，多 Agent 并发上限=1（串行推进）；兄弟步不互见；跨项目禁止；合并冲突 fail-closed 转人工。
- **验收**：两个会话产物合并可追溯；冲突不静默覆盖；上限=1 时退化为串行。
- **前置依赖与顺序**：II-10/II-11 之后；**D-07 已裁决**，按「串行多会话」口径实现，不引入排队。
- **成本**：≈7 人日（估算）。

### II-20 · G2-18 完整步状态机｜**已实施（本包，保留为设计存档）**
> **做了什么**：`work-step-service.ts` 新增 **12 值**声明式迁移表 `WORK_STEP_TRANSITIONS`（终态零出边）与 `canTransitionStepStatus`；所有迁移方法写库前用 `assertDeclared` 复核来源集合，未声明即抛 `WorkStepConflictError('INVALID_TRANSITION: …')`，SQL 的 `WHERE status IN (...)` 由同一来源集合生成。补齐 `waiting_approval → timed_out`（审批等待同样受 run deadline 约束）；`blocked_by_dependency`（`failUnstarted`，来源于 `blockUnstartedDependents`）与 `settleNeedsInput`（`needs_input → succeeded/failed`，人工确认收口）两条已实现扩展写进表并注明写入方；`review` 当前无生产写入方，不为死状态补 `review → failed`。`WorkStepService` 新增可选 `onChanged`，5 处构造点（`work-scheduler` / `work-execution-service` / `acceptance-confirmation` / `agent-step-runner` / `work-item-service`）全接，发 `work_step_changed`。
> **妥协在哪**：①**不新开 `event:work-step-changed` IPC 通道**，`work_step_changed` 沿用既有 `event:work-item-changed` 下发（payload 增 `stepId`），renderer 仍按 lineage 去抖重拉，不做步级增量渲染；②`review` 无生产写入方（仓库内无调用方传 `status:'review'`），本轮只保留已实现出边，不为死状态加迁移；③`updateInputRequest` 只改 `input_request_json`、不是状态迁移，事件按当前 `needs_input` 上报；④事件在迁移成功后同步回调（消费方异常被吞、不影响已落库迁移），部分路径（`confirm` / `startStep` 事务内）在提交前触发，消费方不得依赖提交时序；⑤`work-run-service.ts` 的启动对账构造点未接 sink（不在裁决的 5 处名单内），该路径的步级变化不产事件。
- **目标与不做后果**：把 `work_steps` 的迁移表落成可执行约束（含非法迁移拒绝）；不做则状态靠约定，竞态下会写错终态。
- **数据/接口**：`work_steps.status` **12 值** CHECK 已定（`schema.ts`，无需迁移）；迁移表 `WORK_STEP_TRANSITIONS` + `assertDeclared` 在 `work-step-service.ts`；事件类型 `work_step_changed`（`{stepId, workItemId, revision, status, transition}`）。
- **流程/状态机**：严格按 §5.9.8 的 12 值表迁移；终态不可逆；`needs_input → pending` 必须 `attempt+1`；`planning` / `pending` 的级联阻断写 `failed + failure_class='blocked_by_dependency'`。
- **边界**：非法迁移返回 `INVALID_TRANSITION` 且不写库；终态写入前要求 session terminate；并发两个终态只有 CAS 胜者落库。
- **验收**：迁移表快照 + 12 值集合/终态零出边用例；合法/非法迁移用例（含 `waiting_approval → timed_out` 与 `review → failed` 拒绝）；并发终态唯一；事件与库一致（`work-step-service.test.ts`、`work-execution.test.ts`）。
- **前置依赖与顺序**：W1/W3 共用；先于 II-10。
- **成本**：≈3 人日（估算）。

### II-21 · G2-19 提案 UI｜**已实施（v40，随 II-02）**
> **做了什么**：只读通道 `proposal:list` / `proposal:diff` 进入 `MAP_READ_ONLY_CHANNELS`；新增写通道 `proposal:create` / `proposal:accept` / `proposal:reject`（驳回理由必填）；采纳/驳回只改提案自身状态。UI 侧列表 → diff → 采纳/驳回，不提供批量入口。
> **妥协在哪**：①验收要求“采纳后有 E2 证据”未实现——采纳没有写 `node_evidence`；②“采纳跳 online 人工编辑”是提示文案，不发生跳转/导航；③diff 超 200KB 时主进程已截断，UI 不再做二次折叠加载。
- **目标与不做后果**：让提案可看、可比、可采纳/驳回；不做则提案只能靠命令行或数据库操作。
- **数据/接口**：只读通道 `proposal:list` / `proposal:diff`；采纳走既有确认通道；不新增写通道。
- **流程/状态机**：列表 → diff（before/after）→ 采纳（跳 online 人工编辑）/驳回（填理由）。
- **边界**：只读展示；不提供批量采纳；diff 超 200KB 折叠加载。
- **验收**：提案可见且 diff 正确；采纳后状态为 `done` 且有 E2 证据；无批量入口。
- **前置依赖与顺序**：II-02/II-08 之后；与 II-30 合并实现。
- **成本**：≈2 人日（估算）。

## II.3 编排执行

### II-22 · G3-1 Tier1 探测｜**已实施**（原阻塞 D-17 已解除）

- **目标与不做后果**：把"哪些后端可参与写编排"变成可复核的探测结果；不做则按模型名硬编码，升级即失效。
- **实施说明**：新增 `src/main/map/tier-probe.ts`。探测输出 `{tier, resume, approval_callback, structured_output, cancel, probe_error}`，进程内按 `(adapter, adapterVersion)` 缓存。判定顺序：探测失败（缺 adapter / runtime 未装配 / driver 未注册）→ Tier 3；四项齐全 → Tier 1；缺写前审批但仍有续跑或结构化结果 → Tier 2；其余 → Tier 3。`WorkExecutionService.checkRouting` 与 `assertKernelReady` 均要求 Tier 1，非 Tier 1 在 tick 中落 `routing_failed:TIER_UNSUPPORTED`、写通道抛 `TIER_UNSUPPORTED`；`AgentStepRunner.ensureRouting` 把能力票与缺项写入 `routing_decisions.candidate_json`（不再写 `tier_probe_deferred`）。
- **能力位来源（如实）**：`approval_callback` = kernel 策略可用且未降级 + `DriverCapabilities.approval === 'pre-exec'`；`resume` 按 `agent-architecture.md` §10 的**声明值**（claude/codex native、acp/opencode/长尾 none、mcp replay）；`structured_output` = driver 提供结构化事件/结果（`toolEvents !== 'none'`），不是"只能抓 stdout"；`cancel` = `BackendDriver` 接口强制实现，全部为真。
- **代码证据**：`src/main/map/tier-probe.ts`、`src/main/map/work-execution-service.ts`（`checkRouting` / `assertKernelReady` / `probeTier`）、`src/main/map/agent-step-runner.ts`（`tierProbe` 选项与 `routing_decisions` 能力票）、`src/main/__tests__/tier-probe.test.ts`、`src/main/__tests__/work-execution.test.ts`。
- **边界**：禁止默认 Tier 1；缓存仅在进程内；探测失败 Tier 3（fail-closed）。能力位中的 `resume` / `structured_output` / `cancel` 目前是**能力矩阵声明**而非运行期实测（无 `adapterVersion`、无 resume 探测），已登记 I.9.3。`resume` 只认 `native`/`replay`，`none` 即缺项；因此有审批但无续跑的 ACP 落 Tier 3（它也没有 `session/load`）。
- **验收**：四种后端各有探测用例（claude-code → Tier 1；codex → Tier 2；opencode / cline → Tier 3；acp → Tier 3）；缺 adapter / 无 runtime / 无 driver 一律 Tier 3；非 Tier 1 后端在 tick 中不被 claim、写通道抛 `TIER_UNSUPPORTED`；探测失败落 `routing_failed`。
- **前置依赖与顺序**：**D-17 已裁决「先解冲突再升格」**：探测（本项）先做；升格（II-09）待审批桥完成后。
- **成本**：≈3 人日（估算）。

### II-23 · G3-2 跨进程写闸｜**已实施**（本包，保留为设计存档）

- **目标与不做后果**：多进程/多窗口下同项目写任务互斥；不做则两个进程同时改同一工作区。
- **实施说明**：**未新建 `project_locks` 表**。直接复用 W5-A 的 `WorkspaceLeaseRegistry`（落盘文件 + pid/token/heartbeat/TTL + 原子抢占 + 同 registry 重入计数）。关键事实：`AgentRuntime.runNode` 早已以 `workingDirectory` 为 key 逐 turn 抢占/释放，地图 agent 步的 `workingDirectory` 就是 `item.project_path`——**逐 turn 互斥不是本次新增**。本次补的是 run 级闸：`WorkExecutionService.tick` 在 claim 前用 `item.project_path` 抢同一 registry，`settle` 后 `finally` 释放；抢不到按 D-07 fail-fast 跳过（不 claim、不消耗 attempt、`project_busy:<pid>` 事件）。默认关闭（`BIZGRAPH_WORKSPACE_LEASE` 未设置）时 acquire 返回 noop，单实例单会话不读写文件、行为与引入前一致。
- **代码证据**：`src/main/map/work-execution-service.ts`（`lease` 选项、`projectBusyItemIds`、tick 内 acquire/finally release）、`src/main/map/work-execution-runtime.ts`（装配透传）、`src/main/agent/agent-manager.ts`（`getWorkspaceLease()` 只读暴露）、`src/main/index.ts`、`src/main/__tests__/work-execution.test.ts`（4 例：跨进程 held、同 registry 重入、run 级持有到 settle、默认关闭 noop）。
- **边界**：租约 30s TTL 可配（`BIZGRAPH_WORKSPACE_LEASE_TTL_MS`），心跳 ttl/3；同 pid 重入按同 registry 引用计数；**未做** `stale_lock_reclaimed` 事件；**未做** 租约上限 60s 的额外钳制（TTL 由 env/构造参数决定）；key 为 `project_path` 原串（trim 后），两条等价但拼写不同的路径不会被判为同一项目；**测试执行器未纳入**（它在临时 worktree 跑，本次不接）。
- **验收**：另一 registry 持有同 key 时 tick 报 `projectBusyItemIds`、无 run、step 仍 `pending`/`attempt=1`；持有者释放后下一轮正常；同 registry 预持有（模拟 runtime turn）不阻塞；执行中 lease 文件存在、settle 后删除；默认关闭不落任何文件。
- **前置依赖与顺序**：II-10 并行前必须完成；D-07 维持 fail-fast、不排队。

### II-24 · G3-3/G8-6 renderer 执行入口｜**已实施**（本包，保留为设计存档）
- **实施说明**：原设计假设的 `map:exec:start|stop|resume` 与真实通道不符，实现按已注册的 `workitem:run:start`（confirm 入队，不内联执行）、`workitem:cancel`（item 级取消，不终止进程）、`workitem:step:run`（单步入队）、`workitem:run:cancel`（run 级条件取消）落地；新增只读 `map:execution:status` 供入口解释「为什么入队后不会跑」。
- **代码证据**：`src/renderer/components/map/NodeMapPanel.tsx`（执行/取消/入队/run 取消、gate 缺项展示、未知 `needs_input` 兜底）、`src/renderer/store/mapStore.ts`（结构化错误解包、去抖刷新）、`src/preload/index.ts`（`workitem:run:start` / `workitem:cancel` 暴露 + `onWorkItemChanged`）、`src/main/ipc/map.ts`（`map:execution:status`）、`src/main/__tests__/map-read-ipc.test.ts`、`src/renderer/store/__tests__/mapStore.test.ts`、`src/renderer/components/map/__tests__/NodeMapPanel.test.tsx`。
- **边界**：gate 仅 `pass/waived` 才允许执行；未通过时按钮禁用并列出缺项，**不做前端放行**（人工 waiver 需落库并记录放行人，另行立项）。有非终态 run 时只给 run 级取消，任务级取消隐藏并提示先取消 run。
- **验证**：`tsc --noEmit`、全量 vitest（334 文件）、`vite build` 通过；tick 真实驱动 turn、`terminateSession` 真机行为、真实 adapter 执行均**未做真机验证**。
- **前置依赖与顺序**：D-03 已裁决；W4 通道后接 UI，本包已完成。

## II.4 证据与测试

### II-25 · G5-10 项目进度查询｜**已实施**（原阻塞 D-03 已解除）
- **目标与不做后果**：只读汇总"项目内节点/任务/证据完成度"；不做则进度只能人工数。
- **实施说明**：新增只读视图 `v_project_progress`（schema v47），项目归属取 `graphs.project_path` / `work_items.project_path` / `node_evidence.project_path` 并集；任务与证据缺 `project_path` 时回退图。`nodes_verified` 只认派生缓存 `E2/E3/E4`（E1 不算已验证）；任务只计 `is_current=1`；撤销证据不计入分级。IPC `map:project:progress(projectPath)` 只读，项目无数据返回 `available=false` + 零值，不报错。
- **代码证据**：`src/main/map/schema.ts`（`v_project_progress`）、`src/main/database.ts`（v47）、`src/main/map/project-progress.ts`、`src/main/ipc/map.ts`、`src/shared/types/ipc.ts`（`map:project:progress` + 只读白名单）、`src/main/__tests__/project-progress.test.ts`。
- **边界**：不做分页（单项目一行，按 `project_path` 精确取）；不做缓存、不触发派生重算；`nodes_verified` 用派生缓存行数而非"有任意证据"，`node_execution_state` 缺失时该数字会偏低（不补算）；**未基准 P95 < 100ms**（视图为标量子查询，项目数大时需实测）。
- **验收**：数字与明细一致（可对账）；跨项目不串数据；任务缺 `project_path` 回退图；非当前版本任务与撤销证据不计；未知项目 `available=false`。
- **前置依赖与顺序**：**D-03 已裁决本期注册**；通道已随只读白名单交付。
- **成本**：≈1.5 人日（估算）。

## II.5 Agent 与安全边界

### II-26 · G6-17 同 uid 防御边界｜**已实施（文档级）**（本包，保留为设计存档）

- **目标与不做后果**：明确“同 uid 恶意进程不在防御范围”的边界；不做则用户误以为系统能防本机同用户攻击。
- **实施说明**：**只写文档，不做运行时启动检测**。在 `agent-architecture.md` §6.5.1 新增成段边界：跨 uid 承诺面、同 uid 不承诺面（伪造 HMAC 记录触发 kill、直接 kill、替换/抢占文件、伪造 workspace lease 干扰写闸、读工作区/SQLite、改库绕过审批、TOCTOU）、攻击者门槛（只需同本地账号可执行代码，不需 root/句柄/网络）、为何不构成提权、跨 uid 保证不受影响。蓝图 §10 增加一致性行。
- **代码证据**：无代码变更；`docs/architecture/agent-architecture.md` §6.5.1（含 §6.5(c) 表）、本文 §10 表。
- **边界**：**不写“已防御同 uid”**；不承诺检测异常 marker、不校验密钥/目录属主权限、不对 symlink 条目告警；异常只能靠既有 C13b 硬化与人工排障发现。
- **验收**：文档同时出现“跨 uid 承诺”“同 uid 不承诺”“攻击者门槛”“不构成提权”四项；跨 uid 结论（C12/C13）未被改写。
- **前置依赖与顺序**：无；与 §5.9.5 / §10 同步。
- **成本**：≈0.5 人日（已完成，文档为主）。

### II-27 · G7-7 C3 exec 面｜**已实施**（本包，保留为设计存档）

- **目标与不做后果**：收敛沙箱 profile 的可执行面，避免 `/bin`、`/usr/bin` 整目录放行导致任意投放/新增二进制获得执行权；不做则 exec 白名单形同虚设。
- **实施说明**：**只收敛 exec 粒度**（env/cwd 不在本轮）。`SYSTEM_EXEC_SUBPATHS` 从 5 个目录缩为 `/System/Library`（SIP 保护、不可枚举）；`SYSTEM_EXEC_LITERALS` 固定放行 `/bin/sh`、`/bin/bash`、`/bin/zsh`、`/usr/bin/env`、`/usr/bin/xcrun`（`/usr/bin/arch` 因无调用方于 2026-11-10 删除，将来出现真实调用方再加回）；`TOOL_COMMANDS` 与 `node/npm/npx` 一律按 PATH 解析后的规范路径 `(literal)`；git 由「整根放行安装根」改为「git 的 exec 目录 `(subpath)` + 同版本 git 本体 `(literal)`」，不再放行 `/Library/Developer/CommandLineTools` 根。`NETWORK_EXEC_COMMANDS`（`ssh/scp/curl/wget/nc`）显式声明为**排除**，并有断言防止误入。`evaluateBashPolicy` 未改动，不新增 `test_exec_profile` 常量。
- **代码证据**：`src/main/shared/sandbox/profile.ts`（`SYSTEM_EXEC_LITERALS` / `SYSTEM_EXEC_SUBPATHS` / `NETWORK_EXEC_COMMANDS` / `PRODUCT_EXEC_COMMANDS` 与 exec 行生成）、`src/main/shared/sandbox/__tests__/profile.test.ts`（收敛断言 + 名单快照 + notes 断言）、`src/main/shared/sandbox/__tests__/harness.test.ts`（真实执行验收）。
- **边界（重要）**：**审批放行 ≠ 沙箱可执行**。策略层回答“允不允许”，profile 回答“能不能落”；未枚举的写命令会在 exec 时被内核以 EPERM 拒绝，由 CLI 转述为工具结果里的可读错误（`Operation not permitted`；脚本场景形如 `bad interpreter: Operation not permitted`），不是静默丢弃、也不是超时。这是有意的互相打回，不是缺陷：用户点了允许仍可能看到命令失败，失败原因必须指向沙箱。网络类命令即使被人工批准也不会放行。工作区脚本（fsmonitor/hook）仍不在名单。名单是安全边界：改动必撞 `profile.test.ts` 快照。
- **npm/npx 的口径（防回归）**：`bin/npm`、`bin/npx` 是指向 `lib/node_modules/npm/bin/{npm,npx}-cli.js` 的 symlink，这两条 `*-cli.js` literal **就是 npm/npx 的规范身份**，不是额外授权。2026-11-10 实测：删掉 → `npm --version` `rc=126` + `bad interpreter: Operation not permitted`；改放行 symlink 入口路径 → 同样 `126`（Seatbelt 匹配 vnode 规范路径而非调用路径）。**删掉等于禁用 npm/npx**，不是去掉冗余。
- **验收**：`/bin`、`/usr/bin`、`/usr/sbin`、`/usr/libexec` 不再以 subpath 出现；shell/env/白名单命令以 literal 出现；网络命令不在名单；`notes` 含 EPERM 说明；名单快照精确相等。真实执行（harness）：同一 profile 下 18 条只读 git 子命令 `exit 0`、工作区内外 marker 均不生成、`.git/config` 哈希不变、良性仓库 stdout 与不开沙箱逐字节一致；`node/npm/npx --version` 均 `rc=0`；`curl/ssh/nc` 非 0 且输出含 `not permitted|denied`。
- **前置依赖与顺序**：与 §6.8 网关同批；env 白名单与 cwd 收敛留待后续。
- **成本**：≈3 人日（估算），本轮已投入。

### II-28 · G7-8 非 Claude 裸 spawn｜**已实施（部分：声明 + 降级 + UI 说真话）**

- **目标与不做后果**：明确没有审批回调的后端只能"裸 spawn（只读或排队人工）"；不做则会被误接进写路径。
- **实施说明**：写路径侧已由 G3-1 的能力票覆盖——`checkRouting` / `assertKernelReady` 要求 Tier 1，非 Tier 1 返回 `TIER_UNSUPPORTED`（`inspectRouting` 供只读查询）；`map:execution:status` 增加 `tier` / `tierMissing`，非 Tier 1 时 `enabled=false` 并直接说明「该后端只能裸 spawn（只读或人工排期），写步骤会被拒绝」；`agent-architecture.md` §17.5/§17.6 明确「编排写路径拒绝」与「普通节点会话仍裸 spawn」的边界。
- **代码证据**：`src/main/map/tier-probe.ts`、`src/main/map/work-execution-service.ts`（`inspectRouting`）、`src/main/ipc/map.ts`、`src/shared/types/ipc.ts`、`src/renderer/store/mapStore.ts`、`src/main/__tests__/map-read-ipc.test.ts`、`src/main/__tests__/work-execution.test.ts`。
- **边界（本轮未做）**：**没有为裸 spawn 后端搭审批桥**（量级等同 G7-2）——普通节点会话 / 自由聊天 / 子代理链路仍无宿主写前审批；**没有实现"只读步骤允许裸 spawn 并标注 `unattended`"**（G6-5 已删除 unattended 分支，本轮不复活）；**没有实现 `source=synthetic|backend` 输出标注**。因此 G7-8 只关闭了「被误接进编排写路径」这一条，不关闭「非 Claude 节点会话零审批」。
- **验收**：非 Claude（Tier 2/3）写步骤被拒并有错误码；执行入口在 pinned adapter 非 Tier 1 时禁用且原因可见；完整审批桥与只读裸 spawn 仍为缺口（I.9.3）。
- **前置依赖与顺序**：II-22 之后（已完成）。
- **成本**：本轮 ≈0.5 人日；完整审批桥 ≈5 人日（估算，未授权）。

## II.6 界面

### II-29 · G8-3 C1–C4 渲染｜**已实施（v3.13 渲染 / v3.14 出口，2026-11-10）**（原阻塞 D-13 已解除）
> **做了什么**：新增 `StepConfirmationPanel.tsx`，在任务卡展开后的步体内渲染 C3「测试计划确认」/ C4「完成认定」：point 徽标、状态（需确认/待确认/已通过/已驳回）、「为什么要确认」（后端 `trigger`）、风险等级与**后端给出的** `reasons` 列表、必填展示项及其**服务端投影内容**（`display`）、已发生的决策（通过/驳回、决策人、时间、备注）与驳回后路径；任务级出现「待确认」角标。v3.14 起面板内提供「通过 / 驳回」，写 `map:confirmation:decide`（`display` 原样回传，错误码由 store 翻成中文，成功后等 broadcast 重拉）。`mapStore.fetchWorkItemDetail` 与 `workitem:get` 并行拉取 `map:confirmation:status`，随任务刷新一起更新；低风险且无决策的步不渲染面板。
> **妥协在哪**：①**C3/C4 先落地**——C1/C2 面板后补于 v3.15/v3.16：C1 面板 + gate 预检投影 v3.15 交付，**数据源（起草/修订入口）于 v3.22 补齐**（`PlanDraftComposer.tsx` + `plan:draft:create` / `:revise` / `:get` 暴露，见 I.8.F），C2 仅覆盖单任务字段级修订（四条边界见 I.9.3）；②**展示内容由服务端投影**，renderer 不拼装、不复算，缺项即禁用按钮（见 I.9.3）；③**风险原因逐字取自后端**，renderer 不做任何推断/排序/合并；④**确认视图随任务明细一起拉取**（每个任务一次），任务很多且全部展开时会多 N 次只读请求，未做批量通道；⑤**没有截图验收**（本环境无 GUI 演练），以 `NodeMapPanel.test.tsx` 与 `mapStore.test.ts` 用例覆盖（C3/C4 4+8 条、C1 起草/修订 6+4 条）；⑥**列表型展示项用 `{items, count}` / `{total, items}` 信封**（`commands` / `policies` / `affectedFiles` / `evidence` / `staleEvidence` / `unmetAcceptance` / `suggestions`）——**已知瑕疵**：根因是 `assertConfirmationDisplay` 分不清「键缺失」与「给了但为空」，「本来就没有 stale 证据」是有效信息却被判成展示缺失；信封让它通过校验，代价是把校验器的缺陷固化进传输格式。**待该校验器能区分 missing 与 empty 时，拆掉信封、恢复裸数组**；当前不影响行为（校验点、按钮可用态与回传内容都不变）。
- **目标与不做后果**：四个确认点在 UI 上各有独立展示与拒绝入口；不做则用户只能盲点"同意"。
- **数据/接口**：只读 `map:confirmation:status`（按 `workItemId` 取整组，含 `display` 投影）；组件 `StepConfirmationPanel`；决策写通道 `map:confirmation:decide`（C3/C4 已在面板内接入）。
- **流程/状态机**：C1 展示 9 项 → 确认/退回；C2 diff 视图；C3 命令与策略逐条；C4 证据与 stale 清单（C3/C4 已随 v3.13/v3.14 落地；C1/C2 面板已随 v3.15/v3.16 交付——C1 数据源（起草/修订入口）已随 v3.22 补齐，C2 仅单任务字段级修订，见 I.8.F / I.9.3）。
- **边界**：缺字段不可提交；不得合并 C1/C2；不得默认勾选完成；低风险步不弹确认。
- **验收**：C3/C4 渲染、展示投影、通过/驳回回传与错误中文化已由 `NodeMapPanel.test.tsx` / `mapStore.test.ts` 覆盖；缺字段提交被拒由 II-12 的服务层用例覆盖。
- **前置依赖与顺序**：**D-13 已裁决「仅高风险步确认」**：非高风险步不弹确认；**G2-10 已实施（v3.12）**，`map:confirmation:status` 提供 point/risk/reasons/required/requiredDisplay 与 `display`，渲染层不得复算风险；与 II-12 同批。
- **成本**：≈5 人日（估算）。

### II-30 · G8-4 提案 UI（渲染）｜**已实施（v40，随 II-02）**
> **做了什么**：`NodeMapPanel` 新增提案区（`data-testid="node-map-proposals"`）：状态/`stale`/`weight`/截断徽标、按需 diff（before/after 原文展示）、采纳与带理由驳回；`mapStore` 提供 `fetchProposals` / `fetchProposalDiff` / `acceptProposal` / `rejectProposal`。
> **妥协在哪**：①只读展示 + 人工采纳/驳回，没有批量勾选（与设计一致）；②不在图面上高亮“被提案节点”，仅面板内按 `anchorEntityKey` 拉取；③提案创建没有图形入口。
- **目标与不做后果**：提案的列表与 diff 可视化；不做则提案不可读。
- **数据/接口**：`proposal:list` / `proposal:diff` 只读；组件复用 `NodeMapPanel` 弹层。
- **流程/状态机**：列表 → 详情 → 采纳跳转 online 编辑 / 驳回填理由。
- **边界**：只读；不做批量；diff 大文件折叠。
- **验收**：diff 与 `metadata.proposal` 一致；采纳后状态正确；无批量入口。
- **前置依赖与顺序**：II-21 之后（可合并交付）。
- **成本**：≈2 人日（估算）。

### II-31 · G8-5 任务卡深度｜**已实施（v3.11，2026-11-10）**（原阻塞 D-14 已解除）
> **做了什么**：新增 `TaskCardTree.tsx`，把 `NodeMapPanel` 里平铺的步骤/最近运行改为「任务 → 步 → run → 证据」四层折叠；证据按 `node_evidence.work_run_id` 归到 run，无 run 归属的留在任务级，其他任务的证据不进本卡。展开键 `task:<id>` / `step:<id>` / `run:<id>` 只存组件内存，默认折叠到任务级；任务列表容器改为 `max-h-[60vh] overflow-y-auto`。**纯渲染派生**：未改 schema、未新增表/列、未新增 IPC（`workitem:get` 与 `map:node:evidence:list` 的返回行本就带归属字段，本次只补了 renderer 类型声明）。
> **妥协在哪**：①未做虚拟滚动（100 条默认折叠只渲染任务头，靠容器滚动；远大于 100 且全展开时 DOM 线性增长）；②树内证据与节点证据列表重复展示，未去重；③无归属证据（E1 等）只能落在任务级「未绑定运行」；④`work_item_id` 为空的证据不进入任何任务卡；⑤展开态不落库，刷新/切节点即恢复默认，也无法分享现场；⑥无批量展开/收起。详见 I.9.3。
- **目标与不做后果**：任务卡按"任务→步→run→证据"分层展开；不做则信息平铺，深层证据找不到。
- **数据/接口**：只读投影增加层级字段；组件 `TaskCardTree`；不新增表。
- **流程/状态机**：默认折叠到任务级 → 展开到步 → 展开到 run/证据；状态变化增量刷新。
- **边界**：层级深度上限 4；大列表虚拟滚动；折叠状态不落库。
- **验收**：四层可展开且数据一致；100 条任务下滚动流畅；折叠状态刷新后恢复默认。
- **前置依赖与顺序**：**D-14 已裁决「折叠」**：默认折叠到任务级；与 II-29 共享组件。
- **成本**：≈3 人日（估算）。

## II.7 迁移与运维

### II-32 · G9-8 RequestQueue 删除｜**已实施（2026-11-09，`80075e7`）**（原阻塞 D-07 已解除）
- **目标与不做后果**：清理已被废弃的 `RequestQueue`（仅测试引用），避免误接回写路径；不做则死代码长期存在。
- **数据/接口**：`request-queue.ts` 与其测试已删除，无表变更，无兼容壳/再导出。
- **流程/状态机**：已确认无生产引用 → 删代码 → 删测试 → 类型检查与全量测试通过。
- **边界**：**D-07 已裁决维持 fail-fast、不引入队列**；删除前 `git grep` 零生产引用已核。
- **验收**：`git grep -rn RequestQueue -- 'src/**'` 为空（已满足）；`tsc --noEmit` 与全量 vitest 通过（已满足）。
- **前置依赖与顺序**：**D-07 已裁决**（维持 fail-fast）；与 W11 同批。
- **成本**：≈0.5 人日（估算）；实际约 30 分钟。

### II-33 · G9-10 worktree 清理｜**已实施**
- **目标与不做后果**：测试 worktree 用完即清，异常退出也能回收；不做则磁盘膨胀、后续复用脏基线。
- **数据/接口**：`test_plans.worktree_path` + 定时清理任务。**原写 `test_runs.worktree_path` 为笔误**：`test_runs` 无该列，代码实际记录在 `test_plans.worktree_path`，以代码为准。频率：**启动后一次 + 每 6 小时一次**，单轮上限 50。
- **流程/状态机**：创建 → 写同级归属标记 `.marker` → 使用 → 结束清理（全过立即删；失败/取消现场保留 7 天）→ 启动/定时扫描回收；清理失败记日志，留待下一轮。
- **边界**：只清本应用根目录 + 已知 project-hash 下、严格 `wt-<13 位毫秒>-<6 位小写十六进制>` 命名的目录；无标记的历史目录按严格命名放行一次并记日志；不删用户目录；**排除 `test_plans.status IN ('running','approved')` 引用的活跃路径**；`worktree_path` 指向已不存在目录的行顺手清空该列。
- **保留期**：**沿用 7 天**。**不采用原文 24h**：失败现场需要可复盘窗口，24h 会与既有「保留 7 天」的实现和用户预期冲突；定时任务与创建时惰性回收共用同一保留期，避免两套口径。
- **验收**：`src/main/__tests__/test-executor.test.ts` 覆盖过期/新鲜/非托管/活跃/无标记/单轮上限/清空路径/幂等；`create` 用例校验标记文件写入与删除。
- **代码证据**：`src/main/map/test-executor.ts:284-415`（`sweepStaleWorktrees` / `startWorktreeRetentionSweep`）、`src/main/ipc-handlers.ts:366-372`（启动接线）。
- **前置依赖与顺序**：II-13/II-14 之后。
- **成本**：≈2 人日（估算）。

## II.8 证据等级

### II-34 · G11-10 tree-hash 等级｜**已实施（v42，2026-11-10）**
> **做了什么**：`node_evidence` 增可空列 `tree_hash`（v42，`addColumnSafe`，不进 `requiredColumns`，不触发重建）；`EvidenceService.create` 只在 E3 接收 `treeHash`（其他等级携带直接报错，不静默丢弃）；TestExecutor 写 E3 时回填被执行 worktree 的 `executed.treeHash`。
> **妥协在哪**：①**不参与 gate 与完成度判定**，只是可追溯的附加字段；②没有做 tree 级 diff（那是 G2-15 dirty diff 的范畴），也没有“按 tree 找回历史现场”的读取/回放能力；③E2 仍只写 `current_hash`/`ref_json.worktreeTree`，不写 `tree_hash`；④历史 E3 行不回溯补值（NULL = 未采集）。
- **目标与不做后果**：为"可复现工作区快照"提供可选的 tree-hash 绑定，而不新增 E 等级；不做则 dirty 工作区的证据只能靠 commit 说明。
- **数据/接口**：`node_evidence` 增可空列 `tree_hash`（不扩枚举）；计算用 git tree 对象哈希，不含未跟踪文件时显式标注。
- **流程/状态机**：写 E3 时可选带 `tree_hash`；无 git 或计算失败 → 留空（等级仍按 E3 的既有 CHECK 判定，不降级）。
- **边界**：不改变 E3/E4 语义与 gate 判定；不把 tree-hash 当 E4；E3 之外的等级拒收 `tree_hash`。
- **验收**：带 tree-hash 的 E3 可复现到同一树；无 tree-hash 的 E3 仍合法；gate 行为不变。
- **前置依赖与顺序**：II-17（dirty diff）口径统一后；不依赖裁决。
- **成本**：≈2 人日（估算）。

---

## 0. 定位、边界与默认假设

### 0.1 与既有文档的分工

| 文档 | 负责 |
|---|---|
| `agent-architecture.md` | Agent Runtime、审批网关、Bash 策略、会话恢复、能力矩阵、费用账本 |
| `agent-rollout.md` / `verification-ledger.md` | 交付顺序、默认矩阵、验证口径 |
| **本文** | 三真图信息架构、`entity_key` / `node_links`、状态双轨与证据、任务对象、拆解机制、TestExecutor、迁移与回退 |

本文不重复解释审批网关、驱动能力矩阵、会话恢复；需要时直接引用既有章节。`ContextBundle` 与尾块协议（tail-block）同样不在本文定义，以 `agent-architecture.md` 为准。

### 0.2 两个必须分开的问题

这两件事在实现上相关，在产品语义上**不能混为一谈**：

1. **链接准确性**（`entity_key` + `node_links`）：解决"这是不是同一件事"。
   - 用于：跨图对应（产品图 ↔ 开发图 ↔ 测试图）、克隆/拆分/合并后的身份延续、节点与会话/任务/证据的挂载。
2. **完成度真实性**（证据等级 E0–E4 + `evidence_refs`）：解决"到底做完没有"。
   - 用于：执行状态派生、验收判定、过期告警、人工确认时的事实依据。

> **只有链接会得到一张漂亮但会说谎的地图。**
>
> `node_links` 能让地图"连得上、看起来完整"，但它只证明"这两个节点是同/相关的一件事"，不证明"这件事做完了"。任何把链接存在性或链接数量当作完成度的展示、统计或自动化判断，都是错误的。完成度只允许来自 `node_evidence` 与派生 `execution_state`。

### 0.3 默认假设（影响结论处均已标注）

| 编号 | 假设 | 影响 |
|---|---|---|
| A1 | 同一项目**不允许产生第二套 lineage**：导入在写任何图数据之前按 §2.6 强制查重，命中即拒绝；**例外**是"同一仓库的不同分支/副本"（目录名不同），经用户显式勾选后允许并行导入，各自的 `entity_key` 独立 | 决定 `entity_key` 的唯一维度、回填算法与 S1 的导入幂等 |
| A2 | 被管理项目通常位于 git 仓库；**非 git 项目保留 E4 人工签收入口，证据等级最高 E4**，但必须标记 `reproducible=0`、`version_binding='none'`，不得与可复现证据混同（§3.5） | 决定 E3/E4 的可得性、展示口径与失效判据 |
| A3 | 本期测试命令本地串行执行，不并行、不跨机 | 决定 TestExecutor 并发模型 |
| A4 | TestExecutor 只执行计划内白名单命令，不支持交互式/长驻命令 | 决定审批粒度 |
| A5 | 会话内容继续存放在 `chat_threads` / `chat_messages`，不复制、不迁移 | 决定 `node_session_links` 只做引用 |
| A6 | 单机单用户，暂无团队协作；权限主体为本地用户 | 决定确认点与审批主体 |
| A7 | 不新增 `NodeType='task'`；测试资产使用独立 test 图节点 | 决定任务卡与测试资产的建模方式 |
| A8 | 允许一次较长的启动期迁移，无零停机要求 | 决定迁移采用表重建 + 启动期一次性执行 |
| A9 | 本期实现与验证以 POSIX（macOS / Linux）为范围；Windows 路径（盘符、反斜杠、大小写不敏感语义）不在本期验证范围 | 路径规范化按 POSIX 实现（§5.4.1）；遇到非 POSIX 根时 fail-closed，不猜测 Windows 路径规则 |

#### 0.3.1 A1/A2/A9 验收用例登记（G10-2，2026-11-09）

> 口径：只登记**能从代码与用例复核到**的覆盖；已有用例不重复写，缺口才补。A3/A4 的边界用例归 G10-3（另包），不在此表。

| 假设 | 验收判据 | 用例（文件 → 用例名） | 状态 |
|---|---|---|---|
| A1 查重先于写入、命中拒绝 | 拒绝路径 `graphs`/`nodes`/`chat_threads` 新增 0 | `src/main/__tests__/graph-service-import-reject.test.ts` →「TOCTOU 冲突被拒后删除生成阶段创建的 thread」；`import-dedup.test.ts` →「I5：拒绝路径不产生 graphs 行（检查在写入之前由调用顺序保证）」 | 已有覆盖（本次登记） |
| A1 分支/副本需显式勾选才可并行导入 | `interactive=false` 一律拒；`true` → `allow_branch_variant`；记住规则可复用 | `import-dedup.test.ts` →「Step 3a-remembered：异目录 + 相似度 ≥0.8 + 未撤销记住规则 → 放行并标明来源」「Step 3a：交互确认放行；自动导入一律拒绝（规则 5）」 | 已有覆盖（本次登记） |
| A1 分支/副本各自 `entity_key` 独立 | 唯一维度是 `(graph_id, entity_key)`：不同图同键可共存，同图重复被拒 | `database-migration.test.ts` →「A1：entity_key 唯一性按 graph 隔离（不同图同键可共存，同图重复被拒）」 | **本次新增** |
| A2 非 git 保留 E4 人工签收入口 | 非 git 根（`mkdtemp(tmpdir)`，未初始化 git）收口可落 E4 | `acceptance-confirmation.test.ts` →「收口 → E4 human_confirm，current_hash 与产物文件实际 sha256 一致」 | 已有覆盖（本次登记） |
| A2 E4 必须 `version_binding='none'`、`reproducible=0`、无代码 hash | 合法签收行的三字段值固定；携带 `code_version` 即拒；`current_hash` 仅作产物内容绑定 | 上一条用例（三字段断言）+ `evidence-derivation.test.ts` →「G5-9:ref 缺失 / E1 缺 summary / 跨级字段混入 一律拒绝」（E4 `code_version` → /代码 hash/） | 已有覆盖（本次登记） |
| A2 非 git 不得产出可复现证据 E3 | 无 HEAD → `e3.eligible=false`，理由含 `HEAD` | `test-plan-service.test.ts` →「E3 资格:全过+HEAD+非 dirty+worktree → eligible;dirty → 拒(§6.2.1)」内的「无 HEAD(非 git)→ 拒(§3.5:非 git 到不了 E3)」分支 | 已有覆盖（本次登记） |
| A9 非 POSIX 根 fail-closed | 盘符根 / 含反斜杠根 → `project_path_non_posix` | `gate-engine.test.ts` →「G1 · scope 非空且在项目根内（§5.4.1）」的「Windows 根（A9）」「含反斜杠的根（A9，无盘符）」两例 | 单测已覆盖；**真实 Windows 环境仅登记，无 Windows 环境** |

> G10-2 收口结论：A1/A2/A9 均已落到可复跑用例或明确不适用；A9 的「Windows 上真实路径语义」不在本期验证范围，只有字符串级 fail-closed 单测。

#### 0.3.2 A3/A4 边界用例登记（G10-3，2026-11-09）

> 口径同 §0.3.1：已有覆盖只登记；本次只补真正缺的边界（并发、超时），不重写既有策略门。

| 假设 | 验收判据 | 用例（文件 → 用例名） | 状态 |
|---|---|---|---|
| A3 测试命令本地串行、不并行 | 同一计划并发请求只放行一个；命令不重叠 | `src/main/__tests__/test-plan-service.test.ts` →「A3：同一计划并发执行只放行一个，命令仍按序串行」（`maxActive=1`、`test_runs` 仅 1 行） | **本次新增** |
| A3 单计划内命令按 seq 串行 | 前一条结束才执行下一条 | 同上用例（`order=['t1','t2']`）；既有 `for (const item of items)` 顺序执行 | 本次新增 + 既有实现 |
| A4 只执行计划内白名单命令 | 批准后篡改 item 命令 → `plan_hash` 不符即拒 | `test-plan-service.test.ts` →「P0-3:execute 校验 approval_id 与 plan_hash,不满足拒绝执行」（批准后把命令改成 `rm -rf /` → `/plan_hash/`） | 已有覆盖（本次登记） |
| A4 非白名单/危险命令被策略门拦 | `rm -rf .git` 等 critical 写 → `policy_decision='deny'`，后续默认停止、零执行不产证据 | `test-executor.test.ts` →「策略门 deny → 该条 skipped+denied 记录,后续默认停止(§6.8.2)」 | 已有覆盖（本次登记） |
| A4 不支持交互式/长驻命令 | 超时（默认 300s）→ item `timed_out`、run `failed`、E3 不 eligible | `test-plan-service.test.ts` →「A4：命令超时 → item timed_out、run failed、E3 不 eligible」 | **本次新增** |

> 已知文档-实现差异（不影响 A3 判定）：蓝图 IPC 表中 `test:plan:run` 的 `CONCURRENT_TEST` 错误码属于**尚未注册的通道规划**；当前串行由 `execute()` 进入时把 `plan.status` 从 `approved` 原子置为 `running` 实现，重复请求收到的错误文案是「未批准,不得执行」。本包不新增 IPC、不改产品逻辑。

### 0.4 状态词与事实纪律（硬性）

本文所有关于"代码现在做什么"的陈述，只允许三种状态词：

| 状态词 | 含义 | 判定规则 |
|---|---|---|
| **已实施** | 代码里能 `git grep` 到或实测到 | 必须带 commit 或 `文件:行`；复核不到不得使用 |
| **已批准未实施** | 有裁决/定稿，但无对应代码 | 可以写行为契约，但不得写成"现在会…" |
| **仅建议** | 提案、候选、未决 | 不得进入验收口径 |

- 数字类结论（行数、表数、测试数、上限）必须 `git grep` 或实测复核后才能写；不得沿用外部文档或旧快照的数值。
- 引用外部文档必须标"对方版本 + 快照行数"（如 `Zcode v1.2.1，302 行`）；未标版本与行数的不引用。
- 每次改文档时，凡新增/改写的代码行为陈述，必须在报告里说明复核命令或降级原因。

---

## 1. 已定方案

### 1.1 三张真图 + 会话叠加层

| 图 | `graphs.type` | 职责 | 允许的节点类型 |
|---|---|---|---|
| 产品图 | `online` | 业务模块、流程、需求指引；人写状态 | `project` / `module` / `process` / `feature` / `wiki-page` |
| 开发图 | `dev` | 开发节点、会话、任务卡、证据叠加层 | 同上 + `bug` |
| 测试图 | `test` | 测试资产（套件/用例）、测试结果锚点 | `test-suite` / `test-case` / `wiki-page` |

- **不做第四张"会话地图"图。** 会话地图 = 开发图 + 叠加层（任务卡、会话时间线、执行状态、证据徽标）。
- 三图之间没有跨图 edge：`edges.source/target` 带 `REFERENCES nodes(id)`，跨图边会破坏 FK 与 `graph_id` 语义。跨图关系一律走 `node_links`。

```
                 node_links (cross-graph, key-based)
   online  ───────────────────────────────────────►  dev
  (需求/流程)      derives_from / implements        (开发节点)
        ▲                                              ▲
        │ covers                                       │ verifies
        └──────────────── test ◄───────────────────────┘
                     (test-suite / test-case)
```

同图内仍用 `edges` 表达结构（层级、依赖、业务流）。跨图只用 `node_links`。

#### 1.1.1 施工细则（G10-1）：值域与跨图边拒绝

**数据（DDL 现状，全部可复核）**

- `graphs.type TEXT NOT NULL CHECK(type IN ('online','dev','test'))`（`database.ts:777`）。
- `nodes.type TEXT NOT NULL CHECK(type IN ('project','module','process','feature','bug','wiki-page','test-suite','test-case'))`（`database.ts:797`）。
- `nodes.graph_type TEXT NOT NULL CHECK(graph_type IN ('online','dev','test'))`（`database.ts:803`）。

**节点类型 × 图类型允许矩阵（写入校验的唯一口径）**

| 图类型 | 允许的 `nodes.type` | 说明 |
|---|---|---|
| `online` | `project` / `module` / `process` / `feature` / `wiki-page` | 业务结构，不允许 `bug`、测试资产 |
| `dev` | `project` / `module` / `process` / `feature` / `bug` / `wiki-page` | 开发叠加，唯一允许 `bug` 的图 |
| `test` | `test-suite` / `test-case` / `wiki-page` | 测试资产图；不允许业务/开发节点 |

**接口与校验**

1. 所有节点写入口（`GraphService.initFromProject` 导入、`NodeRepository.create`、图克隆、拆分、人工新建）在 INSERT 前解析目标 `graphs.type`，校验 `nodes.type` 在矩阵内；违规抛 `NODE_TYPE_NOT_ALLOWED`，不落行、不建连线。
2. `nodes.graph_type` 必须与所属 `graphs.type` 相同；导入与克隆由同一 `graphId` 推导，不得独立传入。
3. 所有 `edges` 写入口（`graph-service.ts` 的 `insertEdgeStmt`、层级写入、未来的边批量接口）在 INSERT 前解析 `source`/`target` 的 `nodes.graph_id`，三者必须全等；违规抛 `CROSS_GRAPH_EDGE`，不落行。端点解析失败抛 `EDGE_ENDPOINT_MISSING`。
4. 已实施对照：`HierarchyService.moveNode` 已按 `graph_id` 拒绝跨图移动（`hierarchy-service.ts:90-94`）；**通用 `edges` 写入路径尚未统一加该校验**，属本细则要求的实现缺口，登记为待施工，不记为已实施。
5. 跨图关系只能经 `node_links`（§2.3）；`relates_to` 不构成 `edges` 的跨图白名单。

**边界**

- 同一 `graph_id` 内允许同 `type` 任意数量节点；`project` 根节点每图至多一个（由 UI 与导入保证，不做 DB 唯一约束）。
- 删除图时 `edges` 随 `graph_id` 级联（既有行为）；`node_links` 不级联（§2.3 L6）。
- Yjs 写通道（显式开启时）拒绝写消息（§2.2.1），不参与节点/边写入校验。

**验收**

1. 向 `online` 图创建 `bug`、向 `test` 图创建 `module` → 均 `NODE_TYPE_NOT_ALLOWED`，`nodes` 新增 0 行。
2. 构造 `source` 属图 A、`target` 属图 B 的 `edges` 插入 → `CROSS_GRAPH_EDGE`，`edges` 新增 0 行；同图插入成功。
3. `nodes.graph_type` 与 `graphs.type` 不一致的导入样本 → 导入失败并回滚，无半行。


### 1.2 `entity_key`：项目内稳定身份

- 定义：UUID，标识"一个业务实体"，与 node id 解耦。
- 同一实体在 online 与 dev 两张图中**共享同一个 `entity_key`**，node id 各自独立。
- 克隆（online → dev、以及未来的 dev → test 资产复制）保留源 `entity_key`。
- 新节点（用户在 dev 图直接新建的 bug、拆分产生的新节点）生成新 `entity_key`。
- `entity_key` 只回答身份，不回答完成度。
- `entity_key` **只在一次导入的身份域内共享**：同一仓库的不同分支/副本经确认并行导入时，两套图的实体键各自独立；"可能是同一实体"用 `node_links(relates_to)` 表达（§2.6），不合并键。

> 施工细则（生成点、克隆/拆分/合并写入时机、回填事务与失败回滚）：**§2.2.2 S1-a/S1-c** 给出不变量、步骤表与逐条边界；本节不重复。

### 1.3 `node_links`：显式关系表

- key-based（`from_entity_key` / `to_entity_key`），`node_id` 仅作为可选快路径。
- 目的：抵抗克隆重生成 id、节点拆分、节点归档、图重建。
- 关系类型固定枚举，禁止自由文本关系。

> 施工细则（写入流程、方向矩阵、唯一/幂等、孤儿巡检、拆分/合并传播）：**§2.3.1** 给出不变量 L1–L6、矩阵、`LinkService.create` 六步与巡检口径；本节不重复。

### 1.4 状态双轨

| 轨道 | 存储 | 谁能写 | 语义 |
|---|---|---|---|
| 人工状态 | `nodes.status`（现有 7 值） | **只有人**（节点编辑、人工确认） | 人的判断与承诺 |
| 派生状态 | `node_execution_state`（缓存表）+ `node_evidence` | 系统按规则计算 | 系统观察到的事实 |

三条硬规则：

1. 证据可点开：每条 evidence 必须带可解析的 `ref_json`（文件路径/提交/会话 turn/测试输出），不允许只存一句"已完成"。
2. 证据带版本锚点：**E3 必须带代码 hash**（git commit sha，可含 dirty 标记），锚点变化后自动标 `stale`；**E4 是人工签收，明确无代码 hash、不可复现**，失效判据见 §3.5。
3. 自动推断只写建议：任何自动推断不得直接提高证据等级，只能写 `evidence_suggestions`，等人接受。

> 施工细则（写入校验、等级字段组合、派生输入/`inputs_hash`、重算触发与失败处理）：**§3.7.1–§3.7.5**；等级组合校验已实施（G5-9），派生重算见 §3.7.4/§3.7.5。本节只保留三条硬规则，不重复实现细节。

### 1.5 任务对象独立建表

- `work_items`（可嵌套、带 revision）+ `work_steps`（编排步）+ `work_runs`（执行记录）+ `node_session_links`。
- 地图上以**任务卡叠加层**呈现，不新增 `NodeType='task'`。
- 任务可以挂节点（`anchor_entity_key`），也可以挂在项目级（锚点为 NULL）。

> 施工细则（表间写入者、状态迁移、事务边界、取消/完成竞态）：**§4.7 S5a 施工细则**；状态值域见 §4.1.1，run 终态竞态见 §4.2。本节只声明对象边界，不重复字段级契约。

### 1.6 拆解机制：结构推导 + 人工确认 + 可修订计划

- 边界由**现有结构**推导，模型只做选择与组织，不发明边界。
- 未过准入条件的子任务不得进入执行队列。
- 计划本身是可修订对象：`revision` + `supersedes`，旧证据冻结。
- 详见第 5 章。

### 1.7 TestExecutor 独立

- 独立服务，计划级一次性审批，隔离 worktree，命令走既有 Bash 策略分类器。
- 不复用 Agent 会话来判定通过，不复用 `RecipeRunner` 的 shell 步骤。
- 测试资产存 test 图节点，与 dev 实体用 `verifies` / `covers` 链接。

### 1.8 本期范围（L1 + L2）

做：

- 任务对象与 revision
- 结构推导拆解 + 人工确认
- 单 Agent 路由（能力票见 §5.9.5，本期只允许 Tier 1）
- 节点会话时间线
- 顺序多步执行（失败分类、超时、重启对账见 §5.9）
- 节点级测试执行与结果回写
- 测试失败 → bug 闭环与定向重测（§6.6）
- 手工用例走 E4 人工签收（§6.7）

不做：

- 流程级 DAG 并行
- 并行写同一节点
- 自动 merge
- 全自动 planner（无人工确认的计划不执行）
- 多 Agent 并行编排
- dev→online 结构变更提案 UI（§2.7，L3）

---

## 2. 链接准确性：`entity_key` 与 `node_links`

### 2.1 唯一性维度

```sql
CREATE UNIQUE INDEX ux_nodes_graph_entity_key ON nodes(graph_id, entity_key);
CREATE INDEX idx_nodes_entity_key ON nodes(entity_key);
```

- 唯一约束按 `(graph_id, entity_key)`：同一图内不允许同键；online 与 dev 是不同 `graph_id`，因此同一实体可共享键。
- `entity_key` 在 DDL 中**必须可空**：旧库迁移要经历 "建列 → 回填 → 建唯一索引"。若 DDL 写成 `NOT NULL`，`rebuildTableIfNeeded` 的 `CREATE TABLE backup AS SELECT *` 恢复路径会因旧行缺值直接失败。
- `entity_key` **必须写进 `nodes.createSql`**（可空、不进 `requiredColumns`）。若只靠 `addColumnSafe` 补列，任何一次 `nodes` 表重建都会把该列值静默丢弃。

### 2.2 生成、保留与回填规则

| 场景 | 行为 |
|---|---|
| 新库首次导入（online + dev 同批生成） | 同一 `tempId` 的两个节点共享一个 `entity_key` |
| `graphs` 克隆（`cloneGraphNodes`） | 直接复制源行 `entity_key`；node id 仍重新生成 |
| 用户在 dev 图手工新建节点 | 新 UUID |
| 拆分（split） | 新节点各自新 UUID + `split_from` 链接指向旧键 |
| 合并（merge） | 目标节点保留自己的键；源节点写 `merged_into` 链接后归档 |
| 测试图资产 | 新 UUID（测试资产是独立实体，不做身份合并） |
| 图快照恢复 / Yjs 重建 | **已实施（cc749ce）**：恢复本身不写 SQLite；恢复之后 doc 变更也不再写回 `nodes`/`edges`，只更新 `yjs_snapshots`。权威仍是 SQLite 权威列，`entity_key` 不因快照恢复而重算（P6 验收见 §8.11） |

#### 2.2.1 Yjs 单向只读：已实施（cc749ce）

**状态：已实施（代码级，`cc749ce`）。** 2026-11-07 以 `git grep` / `sed` 复核 HEAD。

**（历史：`cc749ce` 之前，现已不成立）** 旧实现为双向：恢复路径先 `applyUpdate` 把快照应用到内存 doc，再在 `yjs-realtime.ts:208` 附近挂写回 observer（`attachDiffHandlers`，来自 `bidirectional-sync.ts`），把 doc 变更写回 SQLite `nodes`/`edges`；WS 端接受 `sync step2` / `sync update` 并应用。**因此"恢复之后可经 1236 写回 `nodes`/`edges`"只在 `cc749ce` 之前的旧代码成立**，HEAD 已不成立。下文"以 §2.2.1 已核实结论为准"一律指本节现状段，不再指向旧行为。

**（现状：`cc749ce` 起）**
- `src/main/realtime/snapshot/bidirectional-sync.ts` 已删除；`git grep "attachDiffHandlers|bidirectional-sync" -- src` 无命中。
- doc → SQLite 写回已断开：`applyUpdate` 在前、`attachSnapshotPersistence` 在后，只挂快照持久化，不挂 `nodes`/`edges` 写回 observer。
- **WS 写消息拒绝：已实施（`cc749ce`）**：客户端发 `sync update` / `sync step2` / 其他 sync 子类型 → `ws.close(1008, …)` 且不应用（`ws-server.ts:168`、`:189`、`:193`）；step1 只返回缺失增量，服务端直接下发 step2。
- **1236 默认不启动：已实施（`987c226`）**：`yjs-realtime.ts` 的 `disableWebSocket` 默认值改为按 `BIZGRAPH_YJS_WS` 判定（仅 `1` / `true` / `yes` / `on` 视为显式开启）；`ipc-handlers.ts:348` 仍为 `new YjsRealtime(db)`，未传 options，故默认不再监听 `127.0.0.1:1236`；显式开启后才启动 WS。
- `graphs` 无写回路径；doc 变更只更新 `yjs_snapshots`，不改 `nodes`/`edges`。
- `nodes.entity_key` / `lifecycle_state` **已实施**：`entity_key` 见 `database.ts:711-713`（v26）与 `entity-key-backfill.ts:329`；`lifecycle_state` 见 `database.ts:721-724`（v30）与 `node-repository.ts:384`。
- 已知缺陷（未修）：启动后新建图不进 doc 池（显式开启 WS 时连 `1236` 会被 `1008` 拒绝）；`node_id` 放宽仍是长期待办。

**验收口径（P6）**：默认启动下 `1236` 不监听；显式开启后写消息被拒；doc 变更后 `nodes`/`edges` 无新增/改写；旧快照可读；`entity_key` 不因恢复而重算。

**待裁决（L3）**：是否完全移除 Yjs（§2.8）；删依赖/表、改 schema 版本不在本期。外部"拆除"方案本文不背书也不反驳。

#### 旧库回填算法（一次性，幂等）

对每个 `project_path`，配对一张 `online` 图与一张 `dev` 图（A1）。对两侧节点计算**结构签名**：

```
sig(node) = sha256(
  type + '|' +
  title_normalized + '|' +
  parent_signature_chain + '|' +
  sibling_ordinal            -- 按 (parent_id, COALESCE(sort_index, 大数), created_at, id) 排序后的序号
)
```

- `parent_signature_chain` 从根递归拼接；根为空。
- `title_normalized`：去首尾空白、连续空白折叠、大小写保持不变（中文标题不做大小写处理）。
- `sibling_ordinal` 抵消"同名兄弟"歧义。
- 匹配顺序：先精确签名；未命中的再退化为 `(type, title, parent_chain)` 唯一匹配；仍冲突则**不匹配**，各自分配新键。
- 幂等：仅对 `entity_key IS NULL` 的行执行；已有键一律不覆盖。
- 结果落 `map_migration_reports`（见 §7.2），记录 matched / unmatched / ambiguous 计数，供迁移验收。

**重复导入的已知局限**：新图与旧图的节点没有结构证据可以自动证明"同名即同一实体"，因此不做自动归一；且同项目重复导入本身会在入口被拒绝。指纹查重与放行规则见 **§2.6** —— 这是 S1 的硬前置，不是 S2 的增强项。

#### 2.2.2 S1 施工细则（B1）

> 本小节回答"S1 每一步谁写、什么时候写、写失败怎么办、怎么验收"。字段级 DDL 见 §7.2；判定顺序见 §2.6。S1 必须把 `entity_key` 回填与导入查重**放在同一个迁移批次上线**，不允许拆成两次发布。

**S1-a 不变量（先写死，后实现）**

| 编号 | 不变量 | 违反时 |
|---|---|---|
| I1 | `nodes.entity_key` 在 `createSql` 中且可空；不进 `requiredColumns` | 任何 `nodes` 重建都会丢键；拒绝发布 |
| I2 | S1 完成后，所有非删除节点的 `entity_key` 非空；同 `(graph_id, entity_key)` 唯一 | 回填报告 `null_after > 0` 或唯一索引建不起来 → S1 `failed` |
| I3 | 已有非空 `entity_key` 永不改写；回填只处理 `entity_key IS NULL` | 二次启动行数变化 → 回填不幂等，阻断 |
| I4 | 新节点创建必须写 `entity_key`（UUID v4）；克隆复制源键；测试资产新键 | 新行出现 NULL → 应用层 bug，写失败并回滚事务 |
| I5 | 导入查重在任何 graph/node 写入之前；拒绝时 `graphs`/`nodes`/`chat_threads` 新增行数为 0 | 拒绝后出现任一行 → P8 失败 |
| I6 | 允许导入时，`project_fingerprints` 与图创建在同一个事务提交 | 只落指纹不落图 / 只落图不落指纹 → P8 失败 |

**S1-b 迁移步骤（每步一个 `map_migration_reports` 行）**

| 步骤 | `stage` | 操作 | 事务边界 | 失败处理 |
|---|---|---|---|---|
| S1.1 | `S1.tables` | 建 `project_fingerprints` / `import_rejections` / `import_allowances` | 单事务，`CREATE TABLE` + 索引 + report `ok` | 回滚；数据库保持 v24；启动阻断，修 DDL 后重跑 |
| S1.2 | `S1.column` | `addColumnSafe('nodes','entity_key','TEXT')`，再核验 `createSql` 已含该列 | 单事务；只加列，不重建 `nodes` | 回滚；列不存在则下次重试；`createSql` 未含 → 拒绝继续 |
| S1.3 | `S1.backfill` | 按 §2.2 对每个项目回填；**只写 `entity_key IS NULL`** | 一个项目一个事务；项目内全成功才提交 | 项目失败 → 该项目回滚、report `failed`、整体 S1 阻断；已提交项目保留，可续跑 |
| S1.4 | `S1.indexes` | `CREATE UNIQUE INDEX ux_nodes_graph_entity_key` + `idx_nodes_entity_key` | 单事务 | 唯一冲突 → 回退到 S1.3 定位冲突行；不得用 `DROP INDEX` 掩盖冲突后继续 |
| S1.5 | `S1.import_path` | 导入流程改为"扫描 → 指纹 → 查重 → 允许才建图"（§2.6） | 代码路径，无 schema 变更 | 旧导入路径未关闭 → 拒绝发版；这是"重导丢会话"的唯一入口 |
| S1.6 | `S1.report` | 写回填统计与历史重复 lineage 报告（只报告，不自动删除/合并） | 单事务 | 报告失败不阻断数据，但 S1 记 `partial`，必须人工确认 |
| S1.7 | `S1.verify` | 计数、唯一性、二次启动、P1/P8 样本 | 只读 | 任一失败 → S1 `failed`，恢复 S0 备份或修复后重跑 |

**S1-c 回填精确规则（补齐 §2.2 未定的边界）**

1. **项目 → 图配对**：同一 `project_path` 下取 `online` 与 `dev` 各一张。若存在多张，按 `(created_at ASC, id ASC)` 取第一张为基准，其余写入 `details_json.duplicate_graphs`，**不参与回填、不自动归档**。
2. **签名输入**：`type` 用节点当前 `type`；`title_normalized` 按 §2.2 规则；`parent_signature_chain` 递归到根；`sibling_ordinal` 按父节点下 `(COALESCE(sort_index, 2147483647), created_at, id)` 升序从 0 开始。
3. **候选集**：同一 `project_path` 的 online/dev 两侧节点各自计算签名。先按签名精确分组；跨图同签名且**组内各只有 1 个节点**才配对。组内多节点 → 记为 `ambiguous`，不配对。
4. **退化匹配**：精确签名未配对的节点，按 `(type, title_normalized, parent_signature_chain)` 匹配；仅当两侧各只有 1 个候选时成立，否则 `ambiguous`。
5. **新键**：未配对节点（含 online 侧无 dev 对应、dev 侧新增）生成新 UUID v4；同一节点只生成一次。**不允许用标题/路径哈希代替 UUID**，避免改名后键漂移。
6. **占位节点**：`title` 为空、`type` 为 `project` 的根节点不参与跨图配对，各自新键；避免把一个项目的根误配到另一个项目。
7. **执行方式**：单项目事务内先 `SELECT id, ... FROM nodes WHERE entity_key IS NULL ORDER BY id`，再批量 `UPDATE nodes SET entity_key=? WHERE id=? AND entity_key IS NULL`。任何一条 `changes=0`（被并发写入）→ 该项目回滚并重试一次；仍失败则 `failed`。
8. **统计**：`stats_json` 至少含 `matched_exact` / `matched_fallback` / `unmatched` / `ambiguous` / `null_before` / `null_after` / `duplicate_graphs`；`details_json` 含每个未匹配节点的 `id/type/title/parent_id/reason`，用于人工复核。

**S1-d 导入查重精确规则（补齐 §2.6 的实现边界）**

- **指纹采集顺序**：`realpath(root)` → 名称/目录名规范化 → 受管文件枚举（忽略 `.git`、`node_modules`、`dist`、`build`、`.next`、`target`、`coverage`；锁文件**不忽略**，作为依赖内容信号）→ `max(mtime)` → 抽样 → 逐文件 `sha256`。
- **抽样算法**：文件按**项目根相对 POSIX 路径**排序；设可用文件数 `M`，目标 `N=12`：
  - `M ≥ N`：取索引 `floor(i*(M-1)/(N-1))`（`i=0..N-1`），重复索引去重；
  - `M < N`：全部取，`sample_count=M`；相似度分母用 `M`，不把缺失当"不匹配"。
  - 单文件读失败：记入 `errors_json` 并从可用集剔除；若可用集为空 → 走 §2.6 Step 4 抽样失败分支。
  - 二进制判定：前 4KB 含 NUL 或扩展名在黑名单（图片/压缩/可执行/字体）→ 跳过；不因跳过而降低分母。
- **相似度**：`similarity = 相同 sha256 的文件数 / sample_count`，保留 4 位小数写入 `matched_signals_json`；判定用未舍入值，展示用舍入值。
- **目录名规范化**：`basename(realpath(root))` 去首尾空白、转小写；比较用规范化值，落库保留原值。
- **mtime**：只写 `last_modified_at` 并在证据面板显示；**不参与拒绝/放行**（§2.6 规则 4）。
- **事务与并发**：指纹计算在事务外；得到结果后 `BEGIN IMMEDIATE`，重新读取 `project_fingerprints` 与 `import_allowances` 再判定（防止 TOCTOU）；允许时同一事务插入指纹与 `graphs`/`nodes`。`UNIQUE(root_path)` 冲突 → 回滚并按"同路径重复导入"拒绝，不重试覆盖。
- **拒绝记录**：拒绝时写 `import_rejections`，`matched_fingerprint_id` 可空（抽样失败/新项目无匹配时为空），`matched_signals_json` 必含 `dir_name_same`、`similarity`、`sample_count`、`mtime_used=false`、`decision_step`（如 `3b`）。
- **记住规则**：`import_allowances` 只在用户显式勾选时插入；命中时 `allowance_source='remembered_rule'`，并校验 `revoked_at IS NULL`。撤销是更新 `revoked_at/revoked_by`，不物理删除。
- **清理任务**：启动期 + 每日一次删除 `import_rejections.created_at < now-90d`（可配置）；删除前把计数汇总写入 `map_migration_reports(kind='import_dedup', stage='retention')`，聚合永久保留。`import_allowances` 不受 90 天影响。

**S1-e 回滚**

| 回滚点 | 动作 | 数据影响 |
|---|---|---|
| 刚建表、未接导入 | `DROP TABLE import_allowances/import_rejections/project_fingerprints`；`entity_key` 列保留 | 无业务数据丢失 |
| 已接导入、未产生放行 | 关闭查重开关，恢复旧导入路径（需书面确认，会重新暴露"重导丢会话"） | 已拒绝记录保留可查 |
| 已产生放行/回填 | 保留表与键；只回退读路径到 node id；不 `DROP INDEX` 除非唯一冲突已定位 | 键保留无害；不可回退已建图 |
| 唯一索引冲突 | 先定位冲突行并人工处置；禁止直接删索引长期运行 | 删索引 = 放弃唯一性，必须记风险 |

**S1-f 验收判据**

1. 真实库副本：回填两次，`null_after=0`、`matched/ambiguous` 与报告一致、第二次运行 0 行变化。
2. 构造 6 类导入样本：决策与 §2.6 完全一致；拒绝时三表新增 0 行；允许时指纹与图同事务。
3. 并发：两个导入同时指向同一 root，只有一个成功；另一个得到 REJECT 且无半行。
4. 故障注入：S1.1 后崩溃 → 重启可续跑；S1.3 中途崩溃 → 已提交项目不重写、未提交项目重跑；S1.4 冲突 → S1 `failed`，启动阻断。
5. 90 天清理：明细删除、聚合保留；`import_allowances` 保留。

### 2.3 `node_links` 设计要点

| 设计选择 | 理由 |
|---|---|
| 存 `entity_key` 而不是 node id | node id 在克隆/删除/重建后会变；键不会 |
| 不建到 `nodes` 的外键 | 外键会让"节点归档/图删除"直接抹掉关系历史；损坏应表现为 `status='orphan'` 而不是静默消失 |
| `node_id` 冗余保留 | 常用查询走 id 快路径；解析失败再回落到键 |
| `link_type` 固定枚举 | 防止自由文本导致语义漂移 |
| `UNIQUE(from_graph_id, to_graph_id, from_entity_key, to_entity_key, link_type)` | 同一图组合下同一语义的关系只允许一条；`entity_key` 跨图共享，不带 graph_id 会复用别图的端点图信息 |

语义约定：

| `link_type` | 方向 | 典型用途 |
|---|---|---|
| `derives_from` | dev/test → online | 开发节点源自哪个业务节点 |
| `implements` | dev → online | 开发节点在实现哪个需求 |
| `verifies` | test → dev | 用例验证哪个开发节点 |
| `covers` | test → online | 用例覆盖哪个业务流程 |
| `depends_on` | 任意 | 跨图依赖（图内依赖仍用 `edges`） |
| `split_from` | 新 → 旧 | 拆分来源 |
| `merged_into` | 源 → 目标 | 合并去向 |
| `supersedes` | 新 → 旧 | 版本替代 |
| `relates_to` | 对称 | 无更强语义的关联 |

#### 2.3.1 S2 施工细则（B1）

**不变量**

| 编号 | 不变量 | 违反时 |
|---|---|---|
| L1 | 新写入的 `node_links` 必须带 `project_path`（规范化 realpath）；跨项目链接一律拒绝 | 写失败并返回校验错误 |
| L2 | `from_entity_key` / `to_entity_key` 必须非空；不允许自链接 | 拒绝写入 |
| L3 | 每条链接的两端必须能在 `nodes(graph_id, entity_key)` 解析；解析失败只能落 `status='orphan'` 并在巡检报告里出现 | 创建接口拒绝；回填/拆分等系统路径可落 orphan |
| L4 | `(from_entity_key, to_entity_key, link_type)` 唯一；`relates_to` 按字典序规范化端点，避免 A→B 与 B→A 重复 | 冲突返回既有行，不新建 |
| L5 | `link_type` 的图类型方向必须符合矩阵（下表）；不合法组合拒绝，不靠语义约定 | 写失败 |
| L6 | 不建到 `nodes` 的外键；节点/图删除不得级联删除链接 | 任何 `ON DELETE CASCADE` 都驳回 |

**link_type × 图类型矩阵**

| `link_type` | from 允许 | to 允许 | 说明 |
|---|---|---|---|
| `derives_from` | dev / test | online | 开发/测试节点源自业务节点 |
| `implements` | dev | online | 开发节点实现需求 |
| `verifies` | test | dev | 用例验证开发节点 |
| `covers` | test | online | 用例覆盖业务流程 |
| `depends_on` | 任意 | 任意 | 跨图依赖；同图依赖仍用 `edges` |
| `split_from` | 任意 | 任意 | 必须同 `project_path`，建议同图类型 |
| `merged_into` | 任意 | 任意 | 必须同 `project_path` |
| `supersedes` | 任意 | 任意 | 版本替代，方向为新→旧 |
| `relates_to` | 任意 | 任意 | 对称；写入前按端点键字典序排序 |

**写入流程（`LinkService.create`）**

1. 规范化 `project_path`；校验 from/to 的 `graph_id` 属于该项目。
2. 解析 from/to 节点：`SELECT id, graph_type, lifecycle_state FROM nodes WHERE graph_id=? AND entity_key=?`。任一缺失 → 拒绝（系统回填路径例外，落 `orphan` 并写报告）。
3. 校验 link_type 矩阵、自链接、方向；`relates_to` 交换端点使 `from_entity_key <= to_entity_key`。
4. `BEGIN IMMEDIATE`；按唯一键查既有行：存在且 `status='active'` → 返回既有 id（幂等）；存在但 `status IN ('orphan','stale')` → 复活为 active 并更新 `updated_at/reason`，不新建。
5. 插入行：`id` 用 UUID v4；`origin` 按调用方 `human/derived/import`；`confidence` 默认 1.0；`from_node_id/to_node_id` 写解析到的当前 id；`created_at/updated_at` 同值。
6. 提交后发 `event:map-link-changed`；事务失败则回滚且不广播。

**孤儿与失效**

- **orphan**：任一端 `(graph_id, entity_key)` 在 `nodes` 不可解析，或图已删除。只由巡检/删除路径写，不由创建接口写。
- **stale**：端点仍可解析，但语义已过期（例如 `verifies` 的目标节点被新 revision 取代且链接未重建）。标记 stale 不删除，UI 显示"需复核"。
- **巡检**：启动后一次 + 每日一次 + `admin:map:integrity-check` 手动触发。SQL 逐条解析两端；对 `status='active'` 但解析失败的置 `orphan` 并计数；对不再满足 link_type 矩阵的置 `stale`。每轮写 `map_migration_reports(kind='integrity_check', stage='node_links')`，只报告、不自动删除。
- 巡检幂等：同一轮重复执行不改变行数；`updated_at` 只在状态真正变化时更新。

**拆分 / 合并传播（补齐 §2.4 的算法）**

- **拆分**：
  1. 旧节点 `lifecycle_state='split'`，保留原键与原行。
  2. 对每个新节点写 `split_from`（新→旧，`origin='derived'`）。
  3. 复制旧节点的出边类型 `derives_from` / `implements` / `covers` 到每个新节点；`verifies` 只在测试资产明确覆盖新节点时复制，不默认复制。
  4. `depends_on` / `relates_to` 不自动复制；需要时由人或派生规则显式创建。
  5. 旧节点的入边保持 active（历史仍指向旧节点）；不搬移、不改写。
- **合并**：
  1. 源节点 `lifecycle_state='merged'`，写 `merged_into`（源→目标）。
  2. 对源节点每条 active 链接（无论入边/出边），在目标节点补齐对应链接；`relates_to` 先规范化；已存在同键则跳过。
  3. 新链接 `origin='derived'`，`reason='merged_from:<source_key>'`；旧链接保留 active，用于追溯。
  4. 目标节点自身键不变；不把源键合并进目标键。
- 传播在一个事务内完成；任一步失败 → 回滚，节点生命周期不变。

**S2 回填（与 S1 同批上线后的只读阶段）**

1. 对每个项目，取 online/dev 基准图（与 S1 的配对规则一致）。
2. 对每个 online 节点，查同 `entity_key` 的 dev 节点；存在则插 `derives_from`（from=dev, to=online, `origin='import'`）。
3. 测试图未上线前不回填 `verifies/covers`；S4 后由测试资产创建流程补。
4. 回填按项目事务；重复执行按唯一键幂等；冲突行不覆盖人工链接。
5. 回填报告写 `map_migration_reports(kind='link_backfill', stage='S2')`，统计 inserted/skipped/orphan。

**回滚与验收**

- 回滚：关闭读写路径即回到"无链接"；表可保留空置。已人工写入的 `relates_to` 保留（无副作用）。
- 验收：P5 四场景（删/拆/并/删图）+ 重复链接 + 自链接 + 方向非法 + 对称重复 + 并发创建同一链接；孤儿扫描 0 误报；拆分/合并后旧链接仍可追溯、新链接可解析。

### 2.4 生命周期与完整性

**总原则：有历史的节点不硬删。** 节点一旦有 link / work_item / evidence / session，删除语义降级为归档。

| 场景 | 处理 |
|---|---|
| 普通删除（无依赖） | 允许硬删；删后其 `node_links` 行由巡检标记 `status='orphan'` |
| 有依赖删除 | `lifecycle_state='archived'`；节点行保留；叠加层默认隐藏；链接保持 `active`（仍可解析） |
| 拆分 | 旧节点 `lifecycle_state='split'`，新建 `split_from` 链接；下游 `derives_from`/`verifies` 由新节点**新建一份**（`origin='derived'`），不搬移旧链接 |
| 合并 | 源节点 `lifecycle_state='merged'` + `merged_into`；目标节点为源节点的每条 active 链接补建一条新链接，旧链接保留 |
| 图删除 | 前置校验：存在 `running` 的 `work_run` 或未完成 `work_item` 时**拒绝删除**；允许时把该图相关链接标记 `orphan`，并把该图节点的证据标 `stale`，不物理删除证据 |
| 孤儿清理 | `map_integrity_check` 任务：`status='active'` 但任一端 `(graph_id, entity_key)` 在 `nodes` 中不可解析 → 置 `orphan` 并写报告；不自动删除 |

#### 2.4.1 施工细则（G10-1）：生命周期状态机与巡检

**数据**

- `nodes.lifecycle_state` / `graphs.lifecycle_state` 均为 `TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_state IN ('active','archived','merged','split'))`（`database.ts:721-724`、`:779-780`）。
- `node_links.status CHECK(status IN ('active','orphan','stale'))`（§7.2 DDL）；`node_evidence` 不物理删除，失效用 `freshness='stale'` + `stale_at`。

**状态机（节点）**

| 迁移 | 触发 | 写入者 | 前置条件 | 副作用（同事务） |
|---|---|---|---|---|
| `active → archived` | 删除有依赖节点 | 人工 `node:delete` | 存在 link / work_item / evidence / session 任一 | 节点行保留；不删链接、不删证据 |
| `active → split` | 拆分 | 拆分操作 | 至少产出 2 个新节点 | 新节点新键 + `split_from`（§2.3.1） |
| `active → merged` | 合并 | 合并操作 | 目标节点存在且同项目 | 写 `merged_into` 并为目标补链（§2.3.1） |
| `archived → active` | 恢复 | 人工 | 无 | 仅恢复叠加层可见性 |
| `merged / split → *` | — | — | **禁止回退**；纠错走新建节点 + `supersedes` 链接 | — |

**状态机（图）**

- `active → archived`：人工归档；图节点、链接、证据全部保留。
- 删除（非归档）前置：该图存在 `work_runs.status IN ('queued','running')` 或 `work_items.status NOT IN ('done','failed','cancelled','superseded')` → 拒绝，错误码 `GRAPH_BUSY`。
- 允许删除时：删除 `graphs`/`nodes`/`edges`；`node_links` 置 `orphan`；`node_evidence` 置 `stale`（保留行）；写 `map_migration_reports(kind='integrity_check', stage='graph_delete')`。

**巡检（`map_integrity_check`）**

| 项 | 口径 |
|---|---|
| 触发 | 启动后一次 + 每 24h 一次 + `admin:map:integrity-check` 手动 |
| 范围 | 全部 `node_links.status='active'`；不扫已 orphan/stale 行 |
| 判定 | 任一端不可解析 → `orphan`；矩阵不再合法 → `stale`；两者同时命中按 `orphan` |
| 写报告 | 每轮一行 `map_migration_reports(kind='integrity_check', stage='node_links')`，含 scanned/orphaned/staled/duration_ms |
| 幂等 | 状态未变化不更新 `updated_at`；同轮重复执行行数不变 |
| 失败 | 单图解析异常记入报告并继续其它图；整轮失败不改变任何链接状态 |

**验收**

1. 有证据/链接的节点执行删除 → `lifecycle_state='archived'`，行数不变，链接仍 `active`。
2. 图内存在 running run 时删除图 → `GRAPH_BUSY`，三表行数不变。
3. 删除图后：其链接 `orphan`、证据 `stale` 且行仍在；巡检报告出现对应计数。
4. 巡检连跑两轮 → 第二轮 `orphaned=0/staled=0`（幂等）；手动触发与定时触发写同一 `kind/stage`。

### 2.5 再次强调

`node_links` 保证的是"同一件事"的连续性。一张图可以 100% 链接完整、0 孤儿，同时大部分节点实际没做完 —— 这正是必须有 §3 的原因。

### 2.6 重复导入：导入期强制查重（拒绝，不合并）

#### 已定规则

重复导入**不允许生成第二套 lineage**。导入流程在**写任何 graph/node 数据之前**做指纹查重，命中即拒绝，并展示"哪几项对上了"。不做静默合并，也不提供"关联/合并"入口。

理由：一旦允许并存，"同一实体多个 `entity_key`"就不可避免，之后所有跨图链接、时间线、证据都要处理二义性。在入口拒绝，比事后合并便宜一个数量级。

#### 指纹组成（4 项，全部可解释）

| 信号 | 计算方式 | 角色 |
|---|---|---|
| 项目名称 | 导入时的显示名；有 `package.json` 时用其 `name`，否则用目录名 | 证据 |
| 目录名 | `path.basename(realpath(projectRoot))` 规范化（小写、去首尾空白） | **主判据** |
| 最后修改时间 | 项目根下受管文件的 `max(mtime)`（忽略 `.git`、`node_modules`、构建产物） | 辅助证据，**不参与拒绝** |
| 内容抽样 | 确定性抽取 N=12 个文件（按路径排序后等距取样，跳过二进制/超大文件），逐文件 `sha256` 比对；`similarity = 相同文件数 / 抽样文件数` | **主判据** |

- 抽样清单必须随首次导入存入 `project_fingerprints.sample_files_json`（`path/size/sha256`），否则跨次无法比较。
- 缺失信号记 `null`，并在证据面板标注"未采到"，不得当成"不匹配"。

**已定参数**（写入配置，不硬编码）：`sampleSize=12`、`similarityReject=0.6`、`similarityBranchVariant=0.8`。先按默认值上线，后续按 `import_rejections` 的真实分布调整。

#### 可执行判定顺序（命中即停）

```
Step 0 规范化：root = realpath(projectRoot)；dirName = basename(root)；name = 项目名

Step 1 同路径：
  存在 fingerprint.root_path == root
    → REJECT（同一工作区重复导入）

Step 2 目录名相同：
  2a dirName 相同 且 content_similarity ≥ 0.6
        → REJECT（同一项目重导；mtime 只作证据展示）
  2b dirName 相同 且 content_similarity < 0.6
        → ALLOW_WITH_WARNING（同名目录但内容差异大，可能是另一个项目）

Step 3 目录名不同：
  3a content_similarity ≥ 0.8
        → 若存在 import_allowances(fingerprint_id, dirName) 且未撤销：
             ALLOW_AS_BRANCH_VARIANT，allowance_source='remembered_rule'（记录来源，不静默）
        → 否则交互导入：ALLOW_AS_BRANCH_VARIANT（同一仓库的不同分支/副本）
             用户在导入确认框显式勾选"这是不同分支/副本，允许并行导入"
             可再勾选"对同一指纹记住" → 写 import_allowances
             → 记录 decision='allowed_branch'，allowance_source='this_time'
        → 自动导入（无交互）：REJECT_BY_SIMILARITY（不得默认放行）
  3b 0.6 ≤ content_similarity < 0.8
        → REJECT_BY_SIMILARITY（按重复处理；证据列明相似度与命中项）
  3c content_similarity < 0.6
        → ALLOW（不同项目）

Step 4 抽样失败（无可采文件 / 全是二进制）：
  4a dirName 相同 且 name 相同 → REJECT（退回"名称 + 目录名"判据）
  4b 否则 → ALLOW_WITH_WARNING（提示"未能完成内容比对"，要求用户确认）
```

**明确规则**：

1. **同一仓库的不同分支允许并行导入**。不同分支在本地通常落在不同目录名，目录名是区分依据。
2. **"目录名不同 + 内容几乎一致"判为允许（分支/副本），不判拒绝**。这是同一仓库不同分支/本地副本的典型形态；但必须由用户显式勾选确认，避免把"复制一份继续做"当成新项目。
3. **"目录名相同 + 内容相似度高"判为拒绝**。不同分支不会落在同一个目录（同一目录只会是同一工作区，Step 1 会先命中）。
4. `mtime` 只作为证据展示（"上次导入时间"），不参与拒绝 —— 切换分支、格式化、`touch` 都会改变它。
5. 自动导入（无交互）不允许 `allowed_branch`：拿不准一律拒绝，防止无人值守产生副本。
6. **图被删除后允许"重建"，不算重复导入**：判据是"指纹在且图在"才拒绝。若 `project_fingerprints.graph_ids_json` 指向的图均已不存在，导入走"重建同一项目"路径（复用原指纹、更新 `graph_ids_json`），不新建 lineage；删除项目本身时指纹一并删除，下次按新项目处理。
7. **分支/副本放行默认只对本次导入有效**。用户可在确认框额外勾选"对同一指纹记住"；只有主动勾选才长期生效。
   - 记住的规则落 `import_allowances`，必须**可查看、可撤销**（对应 IPC `project:import:allowance:list` / `revoke`）。
   - 命中记住规则时，`import_rejections.allowance_source='remembered_rule'`，导入记录与证据展示必须标明"本次放行来自记住的规则"，**不允许静默豁免**。
   - 记住规则的最小粒度是 `(fingerprint_id, dir_name)`：只自动放行同一目录名，其它新目录仍逐次确认。

#### 执行位置与原子性

```
扫描目录 → 读取元数据 → 计算指纹 → 查重 → [拒绝：写记录并返回] → [允许：创建 graphs/nodes]
```

- 查重在**任何写操作之前**；拒绝时 `graphs` / `nodes` / `chat_threads` 均不产生任何行。
- 允许时，指纹行与图创建在**同一事务**内提交；事务失败则指纹不落库，下次可重试。
- 生成阶段需要实时写进度的 `chat_thread` 在长耗时任务前创建、不在图事务内；TOCTOU 冲突或拒绝时必须显式删除该 thread（含消息），否则事务回滚会留下孤儿行（已实施：`GraphService.initFromProject` 冲突分支 `deleteThread`）。

#### 数据结构

三张表的 DDL 见 **§7.2**（`project_fingerprints` / `import_rejections` / `import_allowances`），此处不重复，避免两处定义漂移。

- 拒绝/放行明细留存 **90 天**（可配置），由启动期清理任务删除；聚合计数写 `map_migration_reports.kind='import_dedup'`，**永久保留**。
- `import_allowances`（用户主动记住的分支/副本规则）不随 90 天清理，保留至撤销。
- `project_fingerprints` 随项目删除而删除；图被删但项目仍在时保留（继续拦截重复导入）。

#### 与 S1 的关系

- 查重表与导入流程属于 **S1**，与 `entity_key` 同批上线（`entity_key` 在 S1 只是加列，真正防漂移的是查重）。
- 缺这一步的后果：重导生成新图 → 节点换新 `entity_key` → 打开新节点时间线为空 → 用户判断"会话丢了"（数据仍在旧图）。
- 不做合并入口：入口拒绝后不会产生需要合并的第二套 lineage，因此 `lineage_links` 表取消、`graphs.project_lineage_id` 取消（§7 已移除）。

### 2.7 产品图 ↔ 开发图：不做自动回写（缺口补齐）

外部蓝图指出一个我们此前未明确的场景：**开发过程中发现产品图结构本身需要调整**（模块该拆、流程该改、需求该合并）。我们的默认口径是：

- `online` 图是产品事实来源，**任何 dev 侧推导都不得直接写 online 图**。
- L1/L2 只允许**人在 online 图手工修改**；系统不提供"自动同步"开关。
- 违反时后果是什么：若不设此规则，模型很容易把"代码里长这样"当成"产品应该这样"，产品图会被实现细节反向污染，且无法区分"需求变更"与"实现偏差"。

**后续（L3，非本期）提案机制**（采纳外部蓝图的"提案 → 人工采纳"方向，但不新增表）：

- 提案 = 一个 `work_item`（`origin='human'` 或 `derived_plan`），`anchor_entity_key` 指向待变更的 online 实体；
- 变更内容放 `metadata.proposal`：`{before, after, reason, evidence_refs}`；
- 采纳时由人在 online 图执行真实编辑，并写 `work_items.status='done'` + `node_evidence(E2)`；驳回写 `cancelled` + 理由；
- 提案不自动应用、不可批量静默采纳；撤销 = 人工反向编辑，不做自动回滚。

本期只记录规则，不实现提案 UI；L1/L2 的 online 图仍只接受人工编辑。

### 2.8 Yjs 完全拆除清单（L3，非本期）

> **前置：本期已实施的是"单向只读、SQLite 权威"（§2.2.1，`cc749ce`），不是拆除。** 本节只把"如果 L3 决定完全移除 Yjs"需要覆盖的范围记全，避免漏项；不改变 L1/L2 的实现，也不替任何外部方案背书。完全拆除必须单独决策、单独施工。

| 类别 | 范围 | 关键点 |
|---|---|---|
| 1. schema / 迁移 | Yjs 相关表与列、`snapshots` 表、schema 版本与 checksum | **`snapshots` 是另一张表，不能和迁移 `_backup` 一起删**；S0 备份按表清单逐表迭代，不假设只有 `nodes`/`edges` |
| 2. 启动装配 | `YjsManager` / `YjsDocRegistry`、doc 池初始化、恢复入口 | 只删生产装配与调用；测试替身另行处理 |
| 3. shutdown flush 与 debounce | 关停写回、flush 定时器、debounce 队列 | 拆除后必须确认没有遗留定时器阻止退出 |
| 4. 冲突子系统 | `conflict-docs` + `conflict-rules` + `lamport` + `conflict-reporter`（约 946 行） | 冲突报告/审计的去留要单独决定；不能只删入口留死代码 |
| 5. 测试 | **9 个测试文件、119 个 `it(`**（2026-11-07 `rg -c "\bit\("` 复核：`src/main/realtime/__tests__` 8 个 + `src/main/services/__tests__/conflict-reporter.test.ts`；数字随代码变化，拆除前重测） | 按文件清单逐个处置：删除 / 改写成只读契约测试 / 保留为回归 |
| 6. 依赖 | `yjs` / `y-protocols` / `lib0` + lockfile + bundle 体积 | 需重新生成 lockfile 与打包产物体积基线；不手改 lockfile |
| 7. 旧快照数据处置 | 已有快照文件/DB 行 | 只读保留、归档或删除三选一；删除必须可恢复且有报告 |
| 8. 远端 / 边界清理 | `127.0.0.1:1236` WS、update/sync step2 拒绝逻辑、无鉴权端点 | 已实施"写消息 1008 拒绝"（`cc749ce`）与"默认不监听"（`987c226`）；L3 彻底移除时再删端点代码 |
| 9. 文档同步 | `agent-architecture.md`、本文 §2.2 / §8.11 / P6、运维说明 | 拆除后 P6 改为"已无 WS 端点"；当前验收是"默认启动下 `1236` 不监听、doc 变更不落库"（§8.11） |

**L3 拆除 runbook（8 步，顺序不可换）**

| 步 | 动作 | 验证项 |
|---|---|---|
| 1 | 前置确认：备份、快照导出、schema 版本、`snapshots` 表清单 | 恢复演练通过；快照可读 |
| 2 | 删接线：确认 `attachDiffHandlers` 已不存在；关闭 WS 端点 | 启动无写回；默认 `1236` 不监听（`987c226`）；显式开启后写消息仍 1008 拒绝 |
| 3 | 删代码：`YjsManager` / `YjsDocRegistry` / conflict 子系统 | 类型检查通过；无死代码引用 |
| 4 | drop 迁移：Yjs 表/列 + schema 版本 | 迁移可重入；`_backup` 报告齐全 |
| 5 | 删依赖：`yjs` / `y-protocols` / `lib0` + lockfile | lockfile 由包管理器重生成；bundle 体积基线更新 |
| 6 | 删测试：9 个文件、119 个 `it(` 逐项处置 | 只读契约测试保留；无 `skip` 遗留 |
| 7 | 文档：`agent-architecture.md`、本文 §2.2 / §8.11 / P6 | P6 改为"写回路径已不存在" |
| 8 | 全量验证：启动、恢复、图编辑、导入、测试、打包 | 无 WS 写回；无残留定时器阻止退出 |

> **拒绝口径**："drop 迁移单提交 revert 即可"不成立 —— 代码可回退，已删除的行/列数据回不来。第 4 步必须先备份并演练恢复，不能把 revert 当数据回滚。

**明确不能删（拆除时也必须保留）**

- `ws` 依赖与 awareness 那套：`settings.realtime` 的 `1234`、`ipc/realtime.ts`、`awareness-server.ts`；它们不是 Yjs 写回路径。
- `edges.updated_at` 的写入方是 `edge-repository`，**不是 Yjs**；拆除 Yjs 不得顺带删掉或改写该列语义。
- `snapshots` 表不能按 `%_backup` / `%_new` 规则清理；它是业务数据表，不是迁移临时表。

**判定**：以上 9 类未全部有处置结论前，L3 不得进入"拆除施工"；L1/L2 按 §2.2.1 的单向只读继续。

#### 2.8.1 逐文件/依赖/测试清单与 L3 决策记录（B3 施工）

**逐文件清单**（拆除前用 `git ls-files` 复核，以下为 2026-11-09 基线）：

- 装配/入口：`src/main/realtime/yjs-manager.ts`、~~`yjs-doc-registry.ts`~~（**历史设计中的文件名，仓内从未存在**，实际模块名以 `yjs-manager.ts` 为准）、`ipc/realtime.ts` 的 Yjs 分支、`main/index.ts` 的 `attachDiffHandlers` 与 shutdown flush 调用。
- 冲突子系统：`src/main/realtime/conflict-docs.ts`、`conflict-rules.ts`、`lamport.ts`、`src/main/services/conflict-reporter.ts`。
- 测试：`src/main/realtime/__tests__/` 下 8 个 Yjs 测试文件 + `src/main/services/__tests__/conflict-reporter.test.ts`；拆除前重跑 `rg -c "\bit\("` 更新计数。
- 依赖：`package.json` 的 `yjs`、`y-protocols`、`lib0`；lockfile 与打包体积基线由包管理器重生成，不手改。

**弃用声明**（先声明、后拆除）：在 `docs/architecture/agent-architecture.md` 与相关模块头注释标注 `@deprecated L3 计划移除；当前仅保留单向只读`，保留期至少一个 minor；期间新增代码不得引用这些模块，CI 加一条 `rg` 检查。

**L3 决策记录模板**（写入本文附录或 §12）：`决策日期 / 决策人 / 快照处置（保留|归档|删除）/ 冲突报告去留 / 依赖移除批次 / 回滚演练记录 / 验收人`。9 类未全部有结论时记录状态保持 `pending`，不得进入施工。

---

## 3. 完成度真实性：状态双轨与证据

### 3.1 双轨边界（谁能写）

| 写入方 | 允许写 | 禁止 |
|---|---|---|
| 用户（节点编辑/人工确认） | `nodes.status` | — |
| Agent 会话 | `work_runs` / `agent_*` / 证据候选 | `nodes.status` |
| TestExecutor | `test_*` / E3 证据（测试通过 + 代码 hash） | `nodes.status` |
| 派生计算 | `node_execution_state` / `evidence_suggestions` | 直接提高 evidence 等级 |

**必须收敛的现状缺口**：会话启动自动广播 `developing`、渲染层 `agent:onStatusChange` 直接落 `nodes.status` —— 这两条路径本期必须改成"派生状态 + 不写 `nodes.status`"。

#### 3.1.1 两条自动写路径的关闭与验收（D 组施工）

| 路径 | 改造 | 验收断言 |
|---|---|---|
| `agent-manager` 会话启动广播 `developing` | 删除广播；只写 `work_runs`，派生层把 `running` 映射为 `in_progress` | 启动会话后 `nodes.status` 不变；`node_execution_state.execution_state='in_progress'`；发出 `event:node-execution-state` |
| `graphStore` 订阅 `agent:onStatusChange` 写 `nodes.status` | 删除写库调用，事件仅用于提示 | 单测断言 `graphStore` 不再调用 `node:update`；冲突时叠加层并列展示，不自动纠正 |
| 人工编辑 `nodes.status` | 保留；IPC 入参必须 `actor='human'` | agent/system 经 `node:update` 改 `status` 一律拒绝 |

边界：人工写优先于派生写，派生不得覆盖 `nodes.status`；同一节点 500ms 内多次派生只重算一次。验收用例落在 `graphStore`/派生测试；`tsc` 保证 `agent:onStatusChange` 无写库引用。

### 3.2 证据等级

| 等级 | 含义 | 典型来源 | 版本锚点 |
|---|---|---|---|
| E0 | 无证据 | — | — |
| E1 | 意图证据 | 计划、会话陈述、人工备注 | 否 |
| E2 | 产出证据 | 变更文件清单、产物文件 | 否（可带文件 hash） |
| E3 | 测试通过 + 代码 hash 绑定 | 测试通过，且 `code_version` 与当前代码 hash 一致 | **必须** git commit sha（`version_binding='commit'`） |
| E4 | 人工签收（无 hash、不可复现） | 人工验收并签收 | **必须** `version_binding='none'` |

规则：

- **E3 = 测试通过 + 代码 hash 绑定，可复现。** 缺代码 hash 的测试通过只能记为测试事实，**降级为 E2**，不得称为 E3。
- **E4 = 人工签收，无代码 hash、不可复现。** 必须显式标注"人工签收 · 无代码 hash · 不可复现核验"。
- **E3 与 E4 不是同一标尺上的高低**：E3 可复现，E4 不可复现；任何统计、排序、导出必须按"可复现 / 不可复现"分组，不得把 E4 排在 E3 之上/之下当作等价序列。
- stale 判定：E3 → HEAD 与 `code_version` 不一致即 `stale`；E4 → 按 §3.5 的覆盖文件哈希 / 过期 / 覆盖范围变化判定。
- 任一锚点不一致 → `freshness='stale'`，等级保留（用于追溯），派生状态按 stale 处理。
- 非 git 项目（A2）无 git 代码 hash，**结构上到不了 E3，只能到 E4 人工签收**（§3.5）。

#### 3.2.1 等级字段组合校验与禁止降级（D 组施工）

| 等级 | 必填 | 禁止 |
|---|---|---|
| E1 | `ref_json`、`summary`；`produced_by='human'` | `code_version`/`current_hash`/`work_run_id` |
| E2 | `ref_json`、`evidence_type`；内容绑定用 `version_binding='content_hash'` + `current_hash` | `version_binding='commit'`、`code_version`、冒充 E3 |
| E3 | `code_version`、`code_dirty=0`、`version_binding='commit'`、`reproducible=1`、`work_run_id`、`ref.testRunId` | `signed_by`/`coverage_json`；dirty 工作区 |
| E4 | `signed_by`、`signed_at`、`coverage_json`（含≥1 条 `acceptance_ids`）、`version_binding='none'`、`code_version=NULL`、`reproducible=0` | agent/后台代签；带代码 hash |

写入顺序固定为「校验 → 解析节点 → INSERT → 标记重算」，**不提供 UPDATE 降低等级的路径**；需要降级时只能撤销旧行（`revoke_reason`）并写新行，历史保留。验收：表驱动用例对每个等级的每个必填/禁止字段各一条；E3 dirty、E2 带 commit 锚点、E4 无覆盖范围均抛 `EvidenceValidationError`。

### 3.3 派生 `execution_state` 优先级

取值：`untouched` / `planned` / `in_progress` / `implemented` / `verified` / `signed_off` / `failed` / `blocked` / `stale`

判定顺序（自顶向下，命中即止）：

1. 最近一次绑定当前 revision 的测试结果为 `failed`/`error` → `failed`
2. 存在 `running` 的 `work_run` → `in_progress`
3. 未完成 `work_item` 的 `gate_status='incomplete'`，或依赖未满足 → `blocked`
4. 存在 E3 且 `freshness='fresh'` → `verified`（测试通过 + 代码 hash，可复现）
5. 存在 E4 且未撤销/未过期 → `signed_off`（人工签收，不可复现）
6. 存在 E3 且 `freshness='stale'`，或存在已失效的 E4 → `stale`
7. 存在 E2 → `implemented`
8. 存在 E1 或存在 `draft/queued` 的 `work_item` → `planned`
9. 否则 → `untouched`

`verified` 与 `signed_off` **不是同一个状态**：任何计数、排序、导出、看板都必须分别统计，禁止合并为"已验证"。

`nodes.status` 与 `execution_state` 冲突时**不做自动纠正**，只在叠加层并列展示，并在人工确认点提示差异。

#### 3.3.1 输入集合、tie-break 与 `inputs_hash`（D 组施工）

**输入集合**（全部按 `graph_id + node_entity_key` 过滤）：当前 revision 的 `work_items.status/gate_status`；未终态 `work_runs.status`；`test_results`（经 `test_runs.plan_id` 关联当前 revision，按 `ended_at DESC, id DESC` 取第一条）；未撤销 `node_evidence` 的 `evidence_level/freshness/created_at`；`node_links` 中 `depends_on` 的目标节点是否 `verified/signed_off`。

**tie-break**：① 固定按 §3.3 的 1→9 顺序，命中即止；② 同等级多行时取 `created_at DESC, id ASC` 的第一条；③ 多条测试结果只看最近一次绑定当前 revision 的 run，旧 run 不参与；④ `verified` 与 `signed_off` 各自独立，不互相压制。

**`inputs_hash`**：`sha256(canonicalJson({revision, evidence:[{id,level,freshness}], runs:[{id,status}], gateStatus, deps:[{key,state}]}))`，写入 `node_execution_state.inputs_hash`；哈希未变则不写行、不发事件。验收：同一输入重复重算结果与哈希一致；输入顺序打乱哈希不变；任一输入变化触发一次重算。

### 3.4 建议机制

`evidence_suggestions` 只承载系统推断：

- 来源：变更文件命中节点 `fileAssociations` / `relatedFiles`、测试结果关联、会话产物。
- 内容：建议等级、证据类型、引用、理由、置信度。
- 状态：`pending` → `accepted`（转 `node_evidence`）/ `dismissed`。
- 自动推断不得直接写 `node_evidence`。

#### 3.4.1 转证据事务、去重与裁决字段（D 组施工）

`accept(id, resolvedBy)` 单事务：`BEGIN IMMEDIATE` → 读建议并要求 `status='pending'` → 拒绝 `suggested_level IN ('E1','E3')` → `UPDATE evidence_suggestions SET status='accepted', resolved_by=?, resolved_at=?`（`changes=1` 才继续）→ `INSERT node_evidence`（`ref_json.suggestionId=id`）→ `COMMIT`；事件在提交后广播。任一步失败整体回滚，建议保持 `pending`。

- 去重键：`ref_json.suggestionId`；对已接受建议再次调用返回既有证据（`reused=true`），不产生第二行。
- 裁决字段：`resolved_by` 必填非空、`resolved_at` 为 ISO 时间；`dismiss` 同样要求，且只改状态不写证据。
- 并发：两个接受请求只有一个 `changes=1`，另一个读回已接受并复用；已驳回/不存在抛错，不做静默降级。
- 边界：端点不可解析、E1/E3 建议、缺 `resolved_by` 均拒绝。验收：接受→证据 1 行、二次接受 `reused=true`、并发仅 1 行、驳回不写证据。

### 3.5 非 git 项目：E4 人工签收（已定方案）

产品方已决定：**E3 = 测试通过 + 代码 hash 绑定（可复现）；E4 = 人工签收（无 hash、不可复现）。** 非 git 项目没有 git 代码 hash，**结构上到不了 E3，最高只能到 E4**；不做"封顶 E2"。

#### 硬约束

1. E4 必须 `version_binding='none'` 且 `reproducible=0`，`code_version` 为空。
2. 展示、导出、看板必须使用**独立状态** `signed_off`（人工签收），不得计入 `verified` 数量，不得与之同列或等价排序。
3. 任何"完成度/验收率"统计必须按 `(execution_state, reproducibility)` 分组；禁止把 `signed_off` 与 `verified` 合并成"已验证"。
4. E4 只能由人写入（`produced_by='human'`）；非 git 的测试通过只记 `test_run` 事实（最高 E2），不自动升 E3/E4。
5. 排序与导出必须**分两组**：可复现组（E3 / `verified`）与不可复现组（E4 / `signed_off`）；组间不比较大小、不混排。

#### E4 签收记录字段

在 `node_evidence` 上增加：

```sql
signed_by               TEXT,   -- 本地用户标识（必填）
signed_by_display_name  TEXT,   -- 可选显示名；不强制真实姓名/角色
signed_at               TEXT,   -- 签收时间
coverage_json           TEXT,   -- 覆盖范围：[{node_entity_key, files[], acceptance_ids[]}]
basis_ref_json          TEXT,   -- 依据/附件：[{kind:'screenshot'|'log'|'external_report'|'note', ref, hash}]
reproducible            INTEGER, -- 冗余派生字段：E3=1，E4=0；用于分组统计
expires_at              TEXT,   -- 过期时间（统一 30 天，可配置）
renewed_from_evidence_id TEXT,  -- 一键续签时引用原 E4 证据；不替代原行
revoked_at              TEXT,
revoked_by              TEXT,
revoke_reason           TEXT
```

- `signed_by` 使用本地用户标识；显示名可选，不强制填写真实姓名/角色。
- `coverage_json` 必须非空，且至少覆盖一条 `acceptance_json` 条目；否则不允许写 E4。
- `basis_ref_json` 的每个引用必须可点开（文件/截图/日志路径 + hash）；只有口头说明时只能记 `kind='note'`，并计入"弱依据"，UI 需提示。
- 签收界面必须展示：覆盖范围、当前 `execution_state`、已有证据列表、与上次签收的差异。

#### 撤销与过期（非 git 无 hash 时的失效判据）

| 判据 | 触发 | 结果 |
|---|---|---|
| 覆盖文件内容变化 | 签收时对 `coverage_json.files` 逐文件记录 `sha256`；请求状态时重算，任一不一致（文件缺失也算变化） | `freshness='stale'`、`stale_reason='coverage_content_changed'`，状态从 `signed_off` 降为 `stale` |
| 覆盖范围变化 | 锚定 `work_item` 的 `scope_files` / `acceptance_json` 条目 id 与签收基线不一致 | `freshness='stale'`、`stale_reason='coverage_scope_changed'`，状态降为 `stale`。**不自动撤销**（已裁决 2026-11-10：范围比对是启发式的，正常拆分/新增子节点也会变，自动撤销一次误判即不可逆；stale 可恢复） |
| 时间过期 | `expires_at` 到期（**统一 30 天，可配置**；不按项目风险/类型区分，留作后续可选扩展，不进 L1） | 视为过期（`freshness='stale'`、`stale_reason='expires_at'`），派生状态为 **`stale`**，不降为 `implemented`。理由：过期签收是"曾经可信、现在不可信"，`implemented` 只能由新签收或新证据产生；**提供"一键续签"方向**：以原 `coverage_json` 为默认值生成新签收记录，并引用原证据（`renewed_from_evidence_id`），减少重复填写；但签收人与覆盖范围仍须显式确认，不允许静默续期 |
| 人工撤销 | 用户显式撤销，必填 `revoke_reason` | 状态降为 `implemented` |
| 无法计算内容哈希 | 文件不可读 / 超过阈值（默认 200 个文件） | **已裁决 2026-11-10**：只在 `coverage_baseline_json.skipped` 记原因（`too_many_files` / `no_project_path` / `capture_failed`），**不改 `freshness`、不进 `unknown`、不阻断签收**；这类签收只剩时间过期兜底（I.9.3 妥协） |

- **不允许"完全不检测"**：至少要有"覆盖文件内容哈希"或"时间过期"之一。两者都不可用时，E4 只能保留 30 天并要求人工续签。
- 内容哈希按文件独立记录（不是整树 Merkle），能精确回答"哪个文件变了"，也避免一次全量扫描。
- 撤销/过期不删除证据行：保留 `revoked_at` / `freshness` 作为历史；派生状态只采信未撤销、未过期的 E4。

**实施状态（2026-11-10 更新）**：

- **时间过期扫描——已实施**：`scanExpiredE4All` 在启动后与每日各跑一次，把到期 E4 置
  `freshness='stale'` + `stale_reason='expires_at'`，落
  `map_migration_reports(kind='derivation', stage='e4_expiry')`；判定只认 `expires_at`，与 E3 的
  HEAD/`code_version` 判定完全分离。
- **覆盖变化扫描——已实施（v43，G1-9）**：`scanCoverageChangedE4All` 与到期扫描**并列但独立**
  （独立 SQL、独立入口、独立 `stage='e4_coverage'`，互不引用）。签收时 `captureCoverageBaseline`
  把逐文件 `sha256` 与范围快照写入 `node_evidence.coverage_baseline_json`（可空、不进
  `requiredColumns`）；扫描每轮 ≤500 条，只更新 `freshness='fresh'` 行（幂等），变化置 stale 并用
  `stale_reason` 区分内容/范围。`current_hash` 只作预筛思路、**不作基线**（聚合值无法回答哪个文件变了，
  且手工 E4 无值）；`tree_hash` 只对 E3 开放，E4 不可复用。历史行无基线 → 不扫描（NULL）。
- **已知妥协**：>200 文件 / 无 `project_path` / 采集异常时基线只记 `skipped`，该签收**不会被覆盖
  变化转为 stale**，只剩时间过期兜底；范围比对未比较 `work_item` revision 号，只比 `scope_files` 与
  acceptance 条目 id（减少"仅换 revision"的误报）。见 I.9.3。

#### E3 与 E4 的关系（按可复现性分组）

| 维度 | E3（可复现） | E4（不可复现） |
|---|---|---|
| 触发条件 | 测试通过 + 代码 hash 绑定 | 人工签收 |
| 版本锚点 | git commit sha | 无 |
| 派生状态 | `verified` | `signed_off` |
| 是否可复现 | 是 | **否** |
| 统计分组 | 可复现组 | 不可复现组 |
| stale 判据 | HEAD 与 `code_version` 不一致 | 覆盖文件 hash / 过期 / 覆盖范围变化 |

> 统计、排序、导出、看板一律按"**可复现 / 不可复现**"分组；E4 不得与 E3 混排，也不得用"等级高低"的线性顺序解释两者。

#### 非 git 为什么到不了 E3

E3 的"代码 hash"指 git commit sha；非 git 项目没有。`content_hash`（节点 `scope_files` 的逐文件 sha256 聚合值）可以作为 E2 的文件级证据，并用于 E4 的 stale 判据，但**不构成 E3 的代码 hash**。因此非 git 项目的最高证据等级是 E4 人工签收。

#### 3.5.1 写入校验、扫描任务与续签语义（D 组施工）

**写入校验**：`signed_by` 非空、`coverage_json` 至少一条含 `acceptance_ids`、`version_binding='none'`、`code_version IS NULL`、`reproducible=0`、`expires_at` 缺省 `now + 30d`；任一不满足拒绝。

**过期扫描**：任务 `e4_expiry_scan` 启动后跑一次 + 每日一次；`UPDATE ... WHERE expires_at < now AND revoked_at IS NULL AND freshness <> 'stale'`（批量 ≤500），落 `map_migration_reports(kind='derivation', stage='e4_expiry')`；重复执行结果一致（幂等），只改 `freshness='stale'`，不删行、不改等级。

**覆盖变化任务（已实施，v43 / G1-9）**：签收时 `captureCoverageBaseline` 把逐文件 `sha256` 与范围快照写入 `node_evidence.coverage_baseline_json`；`scanCoverageChangedE4All` 启动后 + 每日一次独立扫描（批量 ≤500，只更新 `freshness='fresh'`，幂等），任一文件内容不一致或缺失 → `stale` + `stale_reason='coverage_content_changed'`；范围快照不一致 → `stale` + `stale_reason='coverage_scope_changed'`；**不自动撤销**。文件数 >200 / 无 `project_path` / 采集异常 → 基线只记 `skipped`，不改 `freshness`（I.9.3 妥协）。

**续签**：以 `renewed_from_evidence_id` 指向原 E4 生成**新行**，原行不修改；`renewed_from_evidence_id + signed_by` 作为幂等键，重复提交返回既有续签行；覆盖范围与签收人必须显式确认，禁止静默延期。验收：过期→`stale` 非 `implemented`；续签产生新行且原行保留；重复续签不增行；覆盖内容/范围变化→`stale` 且 `stale_reason` 可区分（不自动撤销）。

### 3.6 项目进度：派生视图，不落库（采纳，但更严格）

外部蓝图提出"项目进度 = 派生视图，不落库；节点状态加权（published 100 / in_progress 70 …）"。方向可采纳，但必须加两条约束，否则会重演"漂亮但说谎"：

- 进度**只按人工状态加权**，叫"发布进度（publish progress）"，**不叫完成度**；不得作为验收依据。
- 证据维度**单独展示**：`verified_count`（E3）与 `signed_off_count`（E4）分别计数，**不进入同一个百分比**。把 `signed_off` 折算进发布进度会被误读为"测试通过"。
- 公式：`publishProgress = Σ(node_status_weight) / Σ(max_weight)`，权重表写配置；`stale` / `failed` 不计入分子，但单列。
- 不落库、不写 `nodes`、不触发任何证据变更；只读查询，缓存必须带 `computed_at` 与所用权重版本。

### 3.7 S6a 施工细则（B1）：证据写入与派生

> 本小节把 §3.2–§3.5 的规则变成"谁在什么时机写、写失败怎么办"。E3 的测试前置条件在 L1 尚未接通时，只有 TestExecutor 上线后才能产生；L1 只需保证写入校验与字段约束先就位。

#### 3.7.1 写入路径与字段校验

| 等级 | 唯一合法写入方 | 必填字段 | 禁止 |
|---|---|---|---|
| E1 | 人（节点/证据面板手写判断）；**agent 不得起草 E1**（判断走文本，不进证据） | `ref_json`、`summary` | Agent 写 E1 / 建议 E1 |
| E2 | Agent（产物/变更清单候选，经接受）；TestExecutor（无 hash 测试事实）；编排层（本回合验收**全部条目机器可判定且通过**时直写，`produced_by='system'`） | `ref_json`、`evidence_type` | 冒充 E3；把无 hash 测试通过写成 E3 |
| E3 | TestExecutor | `code_version`、`code_dirty=0`、`version_binding='commit'`、`reproducible=1`、`work_run_id`、`test_run_id` | 工作区 dirty 时产出 E3；无 `test_run_id` |
| E4 | 本地用户 | `signed_by`、`signed_at`、`coverage_json`（非空且含 acceptance）、`version_binding='none'`、`code_version=NULL`、`reproducible=0` | Agent/后台任务代签；无覆盖范围；带代码 hash |

- 写入前统一校验：等级合法、类型合法、`graph_id + node_entity_key` 可解析、`ref_json` 每个引用可解析（文件路径存在/提交存在/测试存在）、E4 覆盖至少一条 `acceptance_json`。
- 写入事务：校验 → 解析节点 → 插入 `node_evidence` → 触发该节点派生重算（同一事务只做标记，重算在提交后异步执行）。
- 唯一性：同一 `work_run_id + evidence_type + node_entity_key` 的 E2/E3 只允许一条（部分唯一索引 §7.2）；重复写入返回既有 id，不新增。
- 写入失败：E3 测试已完成但证据写入失败 → 测试结果保留，`work_run` 记 `evidence_write_failed`，由重试任务补写；在补写成功前不得把该节点展示为 `verified`。
- 会话/任务产生的证据候选按验收性质分流：验收**全部条目机器可判定且通过**（command 退出码 0 / file_check 命中，manual 条目数为 0）→ 直接写 `node_evidence`（`produced_by='system'`，结论由机器验收驱动，不是 agent 自称）；存在 manual 待确认 → 只写 `evidence_suggestions`，接受时才转 `node_evidence`；拒绝只更新建议状态，不写证据。

#### 3.7.2 E3 的写入前置（与 §6.2.1 一致）

1. 测试结果 `status='passed'`，且 `test_run.worktree` 非空。
2. `code_version` = 该 worktree 的 `HEAD` commit；`code_dirty=0`（工作区 dirty 时**不得**产出 E3）。
3. 当前项目仍在 git 仓库内，`git rev-parse HEAD` 成功。
4. 任一条不成立 → 只能落 E2 或 `test_run` 事实，不写 E3；`dirty_tree_hash` 只用于变更面留痕，不用于把 dirty 状态洗成 E3。

#### 3.7.3 E4 过期与派生（U1，已裁决）

**裁决：过期 E4 派生为 `stale`，不派生 `implemented`。**

| 输入 | 派生结果 |
|---|---|
| `expires_at` 到期、未撤销的 E4 | `stale`；UI 显示"签收已过期，需续签" |
| 未过期、未撤销的 E4 | `signed_off` |
| 已撤销的 E4 | 不参与 `signed_off`，按 §3.5 落回 `implemented` |
| 覆盖内容/范围变化（未撤销）的 E4 | `stale`，`stale_reason` 区分 `coverage_content_changed` / `coverage_scope_changed`；**不自动撤销**（见 §3.5 裁决） |

理由：过期签收是"曾经可信、现在不可信"，与 `stale` 的"曾验证但当前锚点失效"语义一致。对**过期**这一情形，`implemented` 只能由新签收或新证据产生，不能因为时间流逝自动变成"已实现"；**人工撤销**是主动结果，仍按 §3.5 落回 `implemented`；**覆盖变化**是启发式判定（正常拆分/新增子节点也会让 scope 变），统一置 `stale` 并用 `stale_reason` 留痕，保留可恢复性且不撤销人工签收。§3.5 原"时间过期降为 `implemented`"的表述按本条裁决修正为 `stale`。`30 天` 口径不变；"一键续签 + `renewed_from_evidence_id`"只作为减轻操作负担的方向，不改变过期判据。

#### 3.7.4 派生算法（可执行定义）

输入（同一 `project_path + graph_id + node_entity_key`）：

- `node_evidence`：未撤销行，按 `evidence_level`、`freshness`、`verified_at`、`id` 排序；
- `work_items`：该节点 `anchor_entity_key` 的全部当前 revision（同一 anchor 允许多条 lineage 并存，§4.1）；判定按**活跃集**（非终态）聚合；
- `work_runs`：活跃集 item 的 `status IN ('queued','running')`；
- 测试结果：L1 无 `test_*` 表，`test_fail` 恒为 false；S8 后接入。

判定顺序严格按 §3.3，并补充确定性 tie-break：

1. `test_fail=true` → `failed`。
2. 存在 `work_run.status='running'` → `in_progress`。
3. 活跃集中任一 item 为在途状态且 `gate_status='incomplete'` 或依赖未满足 → `blocked`。
4. 存在 `evidence_level='E3' AND freshness='fresh' AND revoked_at IS NULL` → `verified`；多条取 `verified_at DESC, id ASC` 第一条。
5. 存在 `evidence_level='E4' AND freshness='fresh' AND revoked_at IS NULL` → `signed_off`；多条取 `signed_at DESC, id ASC` 第一条。
6. 存在 `E3 freshness='stale'` → `stale`；存在已过期（`expires_at` 到期）或覆盖内容/范围变化且未撤销的 E4 → `stale`（U1 + G1-9 裁决），`stale_reason` 区分 `expires_at` / `coverage_content_changed` / `coverage_scope_changed`。**已撤销**的 E4 不参与规则 5（`signed_off`），按 §3.5 落回 `implemented`；覆盖变化**不自动撤销**。
7. 存在 `E2`（未撤销）→ `implemented`。
8. 存在 `E1` 或活跃集中任一 item 为 `draft/queued` → `planned`。
9. 否则 → `untouched`。

- **多 lineage 聚合（`derivation_version=2`）**：只取 `created_at DESC LIMIT 1` 会吞掉其他 lineage 的 `running/blocked/test_fail`。v2 取该 anchor 全部 `is_current=1`，先剔除终态（`done/failed/cancelled/superseded`）得到活跃集，再按上面顺序折叠；活跃集为空时回退到最新一条（`created_at DESC, id ASC`），保持单 lineage 语义。`test_fail` 只从活跃集 item 推导——终态失败不会永久压住后续成功；若唯一 lineage 已失败，走终态回退仍可呈现 `failed`。
- `evidence_level` 取当前参与判定的最高有效等级；`is_reproducible`：E3=1，E4=0，其余 NULL。
- `inputs_hash = sha256(canonical_json({derivation_version, evidence_ids+levels+freshness, work_items: 排序后的 (item_id,status,gate_status,deps_satisfied) 列表, running_run_ids, test_fail}))`。哈希未变则跳过写入；`derivation_version` 参与哈希，保证版本升级后首次重算必写。
- 写入 `node_execution_state` 时同步写 `inputs_hash` / `computed_at` / `derivation_version`；状态变更后发 `event:map-execution-state-changed`。
- `nodes.status` 永不参与派生、也不被派生结果回写。

#### 3.7.5 重算触发、失败与重建

| 触发 | 时机 | 合并策略 |
|---|---|---|
| 证据插入/撤销/失效 | 事务提交后 | 按节点去重，500ms 内合并 |
| `work_item` / `work_run` 状态、gate、revision 变更 | 事务提交后 | 按节点去重；范围仅限「该 item 锚定节点 + 直接依赖它的当前节点」 |
| 节点 `scope_files` / `acceptance_json` 变更 | 保存后 | 立即重算 |
| E3 stale 扫描 | 启动后 + 每小时 | 批量按 `project_path` |
| E4 到期扫描 | 启动后 + 每日 | 已实施：批量置 `freshness='stale'` 并派生 `stale`，落 `kind='derivation', stage='e4_expiry'` |
| E4 覆盖变化扫描 | — | **已批准未实施**：缺逐文件内容哈希基线，见 §3.7.3 |
| 手动 `admin:map:recompute` | 用户触发 | 可全量或单节点 |

- **触发范围（已实施）**：`work_item` 的 `createDraft/transition/setGateResult/convergeIfTerminal/revise` 与 `work_run` 的 `enqueue/claim/complete/fail/timeout/cancel/markInterrupted` 都会调 `scheduleRecomputeForWorkItem`，只重算该 item 锚定节点 + 当前 revision 中把该 item 列为直接依赖的节点；不做全图扫描、不全量重算。`work_step` 本身不改变派生输入，不单独触发（步终态经 `convergeIfTerminal` 落到 item 状态后触发）。每节点仍 500ms 合并 + `inputs_hash` 未变跳过。
- **`test_fail` 的生产来源**：该 item 最近一次 `work_runs`（按 `run_seq`）为 `failed` 且 `failure_class='test_fail'`；重试已入队/正在跑或新 run 成功即解除。由派生时从库读取，不依赖调用方传瞬态 flag（避免 500ms 合并丢失）。
- **读缓存一致性**：`map:overlay:get` 返回 `node_execution_state` 前调用 `flushPendingRecomputes(db, graphId)`，立即兑现挂起重算；随后 `refreshStaleDerivationsForGraph(db, graphId)` 把 `derivation_version < CURRENT` 的行逐节点重算。选择读侧惰性刷新而非启动全盘扫描：缓存唯一消费路径是 `overlay:get`，成本按被查看图有界，且不拖慢启动。
- 重算失败：保留上一行 `node_execution_state` 与原 `computed_at`，另写 `map_migration_reports(kind='derivation', stage='recompute')` 记失败；UI 显示"派生可能过期"。无上一行时宁可不写，不伪造 `untouched`。
- 重建：`DELETE FROM node_execution_state` 后按项目批量重算；重算结果必须与增量结果一致（同一 `inputs_hash` 同一状态）。
- 验收：E0–E4 样本各一条；同一输入两次重算状态一致；证据撤销后 `verified` 消失；E3 换 HEAD 后 `stale`；E4 过期后派生 `stale`（不得出现 `implemented`）；工作区无证据时不写 `untouched` 假行。

---

## 4. 任务对象与执行记录

### 4.1 `work_items` 与 revision 语义

- 每个 revision 是**一行不可变记录**，用 `lineage_id` 归组。
- 计划确认时生成 revision 1；执行中增删合并产生 revision N+1 行，`supersedes_id` 指向上一行。
- `is_current=1` 的行是当前有效计划；其它行只读保留。
- 旧 run 与旧 evidence 冻结在旧 revision 上，不迁移、不删除。

拆分/合并/删除在计划中的语义：

| 操作 | 结果 |
|---|---|
| 新增子任务 | 新 lineage，parent 指向当前 revision 的父项 |
| 删除子任务 | 当前 revision 该项标 `cancelled`，新 revision 中不再出现在执行队列 |
| 合并两个子任务 | 新 lineage 一项，`merged_from` 关系记录在 `metadata`；旧两项标 `cancelled` |
| 拆分一项 | 新 revision 中该项 `cancelled`，两个新 lineage 项 `split_from` 记录在 `metadata` |

#### 4.1.1 `work_items.status` 值域（S5 一次建齐）

| 值 | 含义 | 谁能写 |
|---|---|---|
| `draft` / `awaiting_confirm` | 计划草稿、等待人工确认 | 计划流程 |
| `queued` / `running` | 已入队、正在执行 | 调度器 |
| `blocked` | 依赖未满足或 gate 未通过 | 调度器 / gate |
| `needs_input` | 等待用户补充信息（问题卡，见 §5.9.8） | 执行器 |
| `needs_human` | 需要人工介入（环境/不可自动恢复失败） | 执行器 / 调度器 |
| `paused` | 人工或基础设施原因暂停，可恢复 | 用户 / 调度器（`infra`） |
| `interrupted` | 进程重启导致中断，等待启动对账 | 启动对账 |
| `done` / `failed` / `cancelled` | 终态；父任务全叶子终态且 ≥1 failed 时为 `failed`（§5.5.1） | 调度器 / 用户 |
| `superseded` | 被新 revision 取代，只读 | 计划流程 |

**这四个新增值（`needs_input` / `needs_human` / `paused` / `interrupted`）与既有值一起写进 S5 的 `CREATE TABLE` DDL（§7.2、§8.7），不得留到后续 `ALTER` 或表重建。**

> **一次性修正（已接受）**：为满足 §5.5.1 的父任务终态聚合（≥1 叶子 failed → 父 failed），`work_items.status` 同时补入 `failed`；否则父任务无法表达失败终态。这是状态集的一次性修正，**不是放宽约束**：值域仍为封闭枚举，迁移与写入校验不变。D2 的四个新增值不受影响，状态总数由 12 调整为 13。

#### 4.1.2 编排步独立建表：`work_steps`

编排步（step）是计划内的一次可执行单元，一个 `work_item` 的一个 revision 可以有 1..N 个步。**步专属字段不放进 `work_items`**，统一放 `work_steps`：

- `output_schema_json`（结构化输出契约）、`consults_json`（需要咨询的上游/评审项）、`checker_work_item_id`（maker-checker 审查项）；
- `deadline_at`（步级截止时间）、`attempt`（步级尝试次数）、`invocation_id`（执行器调用号）。

`work_items` 只保留任务级字段（标题、目标、`scope_files`、`acceptance_json`、`depends_on_json`、revision/supersedes 等）。`work_runs` 是执行事实（一次尝试一行），通过 `step_id` 引用所属步；run 级的 `attempt` 是"该步第几次尝试"，与 `work_steps.attempt` 对应，`work_steps` 为准。

步级状态机与落库要求见 §5.9.8。

### 4.2 `work_runs`

- 一次执行尝试一行；`executor_kind` 区分 agent / test / human；`step_id` 引用所属 `work_steps`。
- `status` 与 `agent_runs.status` 不共用：`work_runs` 是任务视角，`agent_runs` 是执行器视角。
- `work_item_revision` 固化"这次执行用的是哪一版计划"，用于偏差度量与证据归属。
- `attempt` 每次真实重试递增；幂等键 `work_item_lineage_id:work_item_revision:attempt`，与 runtime 现有幂等机制对齐。
- `deadline_at` 由调度器写入，到期强杀子会话并落 `timed_out`；不允许只有 schema 列、没有写入方。
- **失败保留部分产出**：`partial_output_ref` 记录已收 stdout / file_change / 失败原因；失败不等于丢弃。
- **启动对账**：启动时把所有 `running` 的 run 置为 `interrupted`，再由规则决定回 `queued` 或 `cancelled`；不自动重放需要审批的步骤。
- **节点忙**（`SESSION_BUSY` / `NODE_BUSY`）→ 回 `queued` 重新排队，**不消耗 attempt**。
- **结构化输出解析链**：① 取最后一个围栏块（```json / ```）→ ② 平衡 `{...}` 扫描（从首个 `{` 起按括号计数，字符串与转义内不计）→ ③ 仍失败则 `output_parse='fallback'`。块上限 16KB，超限截断并标 `truncated`。schema 外字段**丢弃**并记 `output_extra_keys`（JSON 数组）；不因多余字段判失败。`verdict` 缺失默认 `FIX`（保守，要求返工）。
- **`needs_input` 输出格式**：`INPUT_REQUIRED` —— `{type:'INPUT_REQUIRED', question, options?, default?, blocks[]}`；解析到即转 `needs_input`。**原会话不复活**，回答后开新 attempt（§5.9.8）。
- **依赖失败传播**：上游 `failed` / `timed_out` → 下游 `blocked` 不执行；上游 `cancelled` → 下游落 `cancelled(reason='upstream_cancelled')`，**不得记为 `blocked`**；无关分支继续跑完（失败不掩盖已发生事实）。
- **取消落库**：取消时先持久化已产出的 `partial_output_ref`（stdout / 文件变更 / 失败原因），再写终态；取消原因写 `cancel_reason ∈ ('user','upstream_cancelled','deadline','shutdown','approval_denied')`。

### 4.3 `node_session_links`

- 会话本体仍在 `chat_threads`；此表只做"会话 ↔ 节点 ↔ 任务"的多对多引用。
- `link_role` 区分主会话、辅助会话、评审会话、测试会话、调查会话。
- 一个节点可有多个会话；一个会话也可挂多个节点（多节点会话）。
- 现有 `threadStore` 只保留"最后一个 thread"的做法必须由时间线查询取代。

### 4.4 `change_sets` 与 `routing_decisions`

- `change_sets`：一次执行前后的变更面快照（base/head commit、文件清单、增删行数）。用途：偏差度量、证据 `code_version` 来源、变更面推导信号。
- `routing_decisions`：单 Agent 路由的决策记录（候选、得分、能力缺口、最终选择）。用途：可解释、可复盘，不做自动重路由。

### 4.5 与现有 `agent_*` 表的关系

| 现有表 | 保留 | 新增关联 |
|---|---|---|
| `agent_runs` / `agent_sessions` | 是 | 通过 `work_runs.agent_run_id` / `session_id` 挂到任务 |
| `agent_turns` | 是 | `node_session_links.turn_id` 可选指向首轮 |
| `agent_artifacts` | 是 | 本期不作为测试结果载体；测试输出走 `test_results.output_ref` |
| `agent_approvals` | 是 | 扩展 subject（测试计划级审批），见 §6.3；v35 起只放工具调用审批，人工验收确认另见 `acceptance_confirmations`（§M5.12） |
| `chat_threads` / `chat_messages` | 是 | 时间线读取来源 |

已知限制与修订（D8）：

- **取消 `thread:<id>` 伪节点：已实施（`5938001`）**：kernel 派发前必须解析到真实 `node_id`（命令目标 / 会话配置 / `chat_threads` / 持久化 `agent_sessions` 或最近 turn），未挂载节点的自由聊天保持纯 `chat_threads` / `chat_messages`，不产生 `agent_turns` 行；`sendCommandThroughKernel` 在缺节点时 fail-closed 并记录原因，写入侧不再生成 `thread:${state.threadId}` / `session:${sessionId}`。
- **未挂载节点的自由聊天不进 kernel turn 路径（已按此落地，`5938001`）**：只保留纯 `chat_threads` / `chat_messages` 会话，不产生 `agent_turns` 行；会话挂载到节点后才创建带 `node_id` 的会话与 turn。
- `agent_turns.node_id NOT NULL` 列约束本期保留，**列为"长期放宽"待办**：待 `node_id` 可空后再允许未挂载会话进入 turn 路径；在此之前，需要 turn 但又无节点的功能按 fail-closed 处理（不启用），不得回退到伪节点方案。
- 落地时确认的直接后果（`5938001`）：自由聊天走旧路径，不经过 kernel 的写前审批（`claude-code` 旧路径为 `acceptEdits`）；重启后自由聊天没有 `agent_sessions` 记录，CLI 原生会话不可续（按既有恢复失败流程新建会话），`chat_threads` / `chat_messages` 历史仍在。
- **审批缺口已补**：自由聊天的旧路径同样走 `ApprovalGateway`，写类工具由适配器既有 PreToolUse 强制 `ask` 后进入 `canUseTool`（与 kernel 同一套 `bashPolicyForTool` / `targetPathsOf` 规则与会话授权语义），审批落 `agent_approvals`；无 turn 时用可反解的 `legacy-run-*` / `legacy-turn-*` 标识，不伪造 turn 行、不改表结构。无法在宿主侧拦截写类工具的旧路径适配器对自由聊天 fail-closed；有节点会话仍优先走 kernel。
- **内部会话同样不能裸跑（P0-3）**：无 `threadId` 的子代理子会话与 `sendAndWait` 一次性会话只要落到 `claude-code` 旧路径，也注入同一套 `canUseTool` 审批钩子，不再使用 `acceptEdits`；子代理无 `allowed_files` 时强制降级为只读工具（禁写类与 Bash），且禁止从有宿主审批的后端通过 `adapter_name` 降级到无审批后端。
- `node_session_links.node_entity_key` 可空只表达"项目级引用"与历史数据兼容，不代表仍在生成伪节点。

#### 4.5.1 施工细则（G10-1）：turn 路径与无伪节点验收

**数据**

- `agent_turns.node_id TEXT NOT NULL`（本期不改）；`agent_sessions` 的节点绑定以真实 `nodes.id` 为准。
- `node_session_links` 是"会话挂到节点"的唯一事实；`node_entity_key` 可空只表示项目级引用。
- 允许的 node 解析来源（按优先级）：命令目标 → 会话配置 → `chat_threads` 关联 → 持久化 `agent_sessions` → 最近一条 `agent_turns`。

**接口**

1. `AgentManager.sendCommandThroughKernel`：解析不到真实 `node_id` → fail-closed（现实现直接返回错误；统一错误码 `NODE_REQUIRED_FOR_TURN` 为本节施工契约），不写 `agent_turns`，诊断记 `reason='node_unresolved'`。
2. `isPseudoNodeId(value)`（`agent-manager.ts:143`）：`thread:` / `session:` 前缀与空串一律视为伪节点；出现在候选解析链中直接跳过。
3. 自由聊天（未挂节点）：只写 `chat_threads` / `chat_messages`，走 legacy 路径；审批仍经 `ApprovalGateway`，无 turn 时用可反解的 `legacy-run-*` / `legacy-turn-*` 标识。
4. 会话挂载：首次挂到节点时幂等插入 `node_session_links`；之后再进入 kernel turn 路径。

**状态机（会话）**

| 当前 | 事件 | 下一状态 | 副作用 |
|---|---|---|---|
| `free` | 挂载到节点 | `mounted` | 插 `node_session_links`（幂等） |
| `mounted` | 发送命令 | `mounted` | 走 kernel；`agent_turns.node_id` 为真实节点 |
| `free` | 发送命令 | `free` | 走 legacy；不写 `agent_turns` |
| `mounted` | 节点归档 | `mounted`（只读） | turn 路径仍可用；UI 标记归档 |

**边界**

- `node_id` 列约束保留；不允许用 `thread:` / `session:` 伪节点绕过。
- 重启后自由聊天无 `agent_sessions`，CLI 原生会话不可续；按既有恢复失败流程新建会话，`chat_messages` 历史保留。
- `node_session_links.node_entity_key=NULL` 只允许项目级引用，不产生 turn。
- 无宿主审批能力的旧路径适配器对自由聊天 fail-closed；不得通过 `adapter_name` 从有审批后端降级。

**验收**

1. 自由聊天发送一条 → `agent_turns` 新增 0 行，`chat_messages` 新增 1 行，`nodes` 无 `thread:*` / `session:*` 行。
2. 已挂载会话发送 → `agent_turns.node_id` 等于真实 `nodes.id`；`node_session_links` 仅一行。
3. 构造只含伪节点/空串的解析链 → `NODE_REQUIRED_FOR_TURN`，零 turn 行。
4. 重启后自由聊天发送 → 新建 CLI 会话成功或按既有失败流程报错；不产生 `agent_sessions` 伪记录。

#### 4.5.1a G7-10：旧路径无 turn 时间线（已裁决不做，登记为已知限制）

**状态**：**已裁决（不做）**，2026-11-09。不是「已批准未实施」——不排期、不设验收；若条件变化必须重新裁决后再施工。

**限制内容**：非 kernel 后端与未挂节点的自由聊天走 legacy 路径，审批有 `agent_approvals` 行（`legacy-run-*` / `legacy-turn-*` 可反解标识），但没有 `agent_turns` 行，因此：

- 没有 turn 的开始/结束时间、`turn_seq`、turn 内工具/文件变更的完整序列；
- 不能用 turn 级快照做恢复/回放，不能按 turn 归集 token 与成本；
- UI 只能看到 `chat_messages` 时间线与逐条审批，无法回答「这一轮跑了多久、用了哪些工具、改了哪些文件」。

**与 D8 冲突的具体点**（§4.5）：

1. D8 要求未挂载会话保持纯 `chat_threads` / `chat_messages`，**不产生 `agent_turns` 行**；G7-10 要时间线，最低要求是 turn 起止记录。
2. D8 取消 `thread:<id>` / `session:<id>` 伪节点，kernel 入口对伪节点 fail-closed；用伪节点补 turn 时间线会被现有守卫直接拒绝。
3. `agent_turns.node_id` 仍为 `NOT NULL`（本期保留，长期放宽属未授权待办）；无节点的自由聊天无法合法落 turn。

结论：在 D8 不变的前提下，G7-10 只能靠伪造 turn 或放宽 `node_id` 实现，二者都越界，故不做。

**影响范围**：

- **非 kernel 后端**：`KERNEL_APPROVAL_CAPABLE_BACKENDS = ['claude','acp']` 之外的后端（当前默认 `codex`、`opencode`、未注册 driver 的适配器）只要走旧路径，就没有 turn 时间线。**注意**：`claude` 在未挂节点自由聊天 / `BIZGRAPH_AGENT_KERNEL=0` 时同样走旧路径，也不产生 turn。
- **`BIZGRAPH_AGENT_KERNEL=0`**：全局回旧路径，所有后端都没有 turn 时间线。
- **无 turn 时间线意味着什么**：审批与消息仍可审计（`agent_approvals` + `chat_messages`），但无法做 turn 级恢复、成本归集、工具序列回放与延迟度量；这些能力只对 kernel 路径成立。
- **可接受的原因**：旧路径定位是兜底与兼容，不是编排主路径；D8 已明确其边界（§4.5）。

**触发重新评估的条件**（任一成立即重新裁决，不在本蓝图内自动开工）：

1. `agent_turns.node_id` 长期放宽方案获批（允许无节点 turn）；或
2. 某非 kernel 后端补齐 kernel driver 与写前审批能力并迁入 kernel（届时它自然获得时间线，G7-10 对其失效）；或
3. 产品要求对自由聊天/旧路径提供 turn 级成本或审计（需先给出不违反 D8 的存储方案，例如独立 sidecar 时间线表，而非复用 `agent_turns`）；或
4. `node_session_links` 的项目级引用（`node_entity_key=NULL`）被允许承载 turn（需先改 D8 与列约束）。

**不做的验收口径**：`agent_turns` 中不出现 `thread:*` / `session:*`；自由聊天发送后 `agent_turns` 新增 0 行；审批仍落 `agent_approvals` 且 `legacy-run-*` / `legacy-turn-*` 可反解。

### 4.6 节点活动流与 ExecutionRecord（采纳为派生视图，不新增表）

外部蓝图把"执行记录（ExecutionRecord）"作为绑定原子单元。我们不新增 `execution_records` 表，而是**用现有表合成同构视图**：

| ExecutionRecord 字段 | 本设计的来源 |
|---|---|
| `nodeId` / `graphId` | `work_items.anchor_node_id` / `node_session_links` |
| `kind` | `work_runs.executor_kind` + `work_items.origin` + run 的上下文 |
| `sessionId` / `workItemId` / `stepId` | `work_runs.session_id` / `work_items.id` / `work_steps.id` |
| `filesTouched` | **只来自确定性证据**：`change_sets.files_json`（file_change 事件 + ScopeGuard 工作区差分），不做推断 |
| `diffRef` / `artifactRefs` | `change_sets` 的 base/head 与 `test_runs.report_ref` / `agent_artifacts` |
| `status` / `startedAt` / `endedAt` | `work_runs.status` / `started_at` / `ended_at` |

规则：

- 节点活动流 = 以 `work_runs` 为主轴、按 `node_session_links` 折叠会话、附证据/测试/bug 链接的**只读视图**；不落新表，不产生第二套事实。
- `filesTouched` **不得**由模型自述或摘要推导；没有 `change_set` 就是空，宁可显示"未采集"。
- **`change_sets` 进 L1 最小集**（§8.12）：既然 `filesTouched` 只认 `change_sets`，L1 就不能既承诺展示文件、又不建该表；二选一后选择"建 `change_sets`"，而不是把活动流降级为"不展示文件"。
- 一个节点有多个会话时，UI 必须展示 `{activeThreadId, threadIds[]}`，不得只保留最后一个（当前 `threadStore` 的问题）。
- 父节点活动流聚合其子树的所有 run；聚合是查询，不是写入。

### 4.7 S5a 施工细则（B1）：任务对象、步骤与执行记录

> 本小节补齐 `work_items` / `work_steps` / `work_runs` / `node_session_links` / `change_sets` / `routing_decisions` 的写入者、状态迁移、事务与失败处理。字段 DDL 见 §7.2；编排执行行为见 §5.9（B2）。

#### 4.7.1 写入权与事务边界

| 表 | 唯一写入方 | 写入时机 | 事务要求 |
|---|---|---|---|
| `work_items` | `WorkItemService`（UI/planner 只能发命令） | 创建 revision、确认、状态迁移、取消 | 每次迁移一条 `UPDATE ... WHERE status=?`，受影响行数必须为 1 |
| `work_steps` | `WorkItemService` + 执行器回调 | 计划落库、审批、启动、完成、失败、中断 | 状态迁移与 `attempt` 自增同事务 |
| `work_runs` | `WorkRunService` | 入队、claim、完成/失败/取消、重启对账 | 入队与 `run_seq` 分配同事务；完成用条件更新 |
| `node_session_links` | 会话挂载/结束路径 | 会话首次挂到节点、会话结束 | 幂等插入；结束只写 `ended_at` |
| `change_sets` | 执行器/ScopeGuard | run 开始记录 base，结束记录 head + 文件面 | 与 run 终态同事务或紧随其后；失败留"未采集" |
| `routing_decisions` | 路由服务 | run 创建时一次 | 同一 run 只写一条 |

- 任何状态迁移先 `BEGIN IMMEDIATE`，再条件更新，再插事件 outbox（同事务），提交后广播。广播失败不回滚数据。
- 事件 outbox 行必须带 `aggregate_id` + `aggregate_version`，消费者按版本去重；这是"状态变更即落库"的最小实现。

#### 4.7.2 `work_items` 状态迁移表

状态值：`draft` / `awaiting_confirm` / `queued` / `running` / `done` / `failed` / `blocked` / `needs_input` / `needs_human` / `paused` / `interrupted` / `cancelled` / `superseded`（`done/failed/cancelled/superseded` 为终态）。

| 当前 | 事件 | 下一状态 | 写入方 | 守卫条件 |
|---|---|---|---|---|
| `draft` | 提交计划确认 | `awaiting_confirm` | 用户/planner | 至少 1 个 step；计划快照可序列化 |
| `awaiting_confirm` | 确认通过 | `queued` | 用户 | gate=`pass` 或 G2 `waived`；无环；父/子 revision 一致 |
| `awaiting_confirm` | 退回修改 | `draft` | 用户 | 生成新 revision，旧行 `superseded` |
| `draft`/`awaiting_confirm` | 取消 | `cancelled` | 用户 | 无 running run |
| `queued` | 调度 claim | `running` | 调度器 | 所有依赖终态且成功；无其他 running 写冲突 |
| `queued` | 门禁失效/依赖失败 | `blocked` | 调度器 | 写 `gate_missing_json` |
| `blocked` | 门禁通过/依赖完成 | `queued` | 调度器 | 重新跑 gate，不信任旧结果 |
| `blocked` | 取消 | `cancelled` | 用户 | — |
| `running` | 全部叶子成功 | `done` | 调度器 | 所有叶子终态且 ≥0 failed；无 needs_* |
| `running` | 至少一个叶子失败且全部叶子终态 | `failed` | 调度器 | 聚合规则见 §5.5.1 |
| `running` | 任一步 needs_input | `needs_input` | 执行器 | 写 `work_steps.input_request_json`，同事务 |
| `running` | 任一步 needs_human/审批超时 | `needs_human` | 执行器 | 记录待人工项 |
| `running` | 基础设施暂停 | `paused` | 执行器 | 记 `pause_reason`（如 adapter 不可用） |
| `running` | 进程重启/租约丢失 | `interrupted` | 启动对账 | 只由启动对账写，不由心跳写 |
| `needs_input` | 回答提交 | `queued` | 用户 | 新 attempt；清空当前 step 的待答状态前先落历史 |
| `needs_human` | 人工放行/拒绝 | `queued` / `cancelled` | 用户 | 审批记录先落库 |
| `paused` | 恢复 | `queued` | 用户/调度器 | 重跑 gate；不自动续跑旧 attempt |
| `interrupted` | 恢复 | `queued` | 用户/启动策略 | 旧 run 对账为 `interrupted`；新 attempt |
| 任一非终态 | 用户取消 | `cancelled` | 用户 | 见 §5.9.7；下游级联规则不变 |
| 任一非终态 | 新 revision 生效 | `superseded` | WorkItemService | 旧 revision 无 running run；否则拒绝修订 |
| 终态 | 任何事件 | 不变 | — | 条件更新 `WHERE status=?` 失败 → 返回冲突，不重试写 |

- **取消与完成竞态**：两者都用 `UPDATE ... WHERE id=? AND status IN ('queued','running','needs_input','needs_human','paused','interrupted')`；只有一个能成功，失败方返回 `CONFLICT` 而不是覆盖。
- **父任务聚合**：叶子全终态后由父 revision 聚合；全成功→`done`，≥1 `failed`→`failed`，全 `cancelled`→`cancelled`，混合成功/取消→`cancelled`（`reason='partial_cancel'`）。聚合不改变叶子状态。
- **`done` 不自动等于验收**：`done` 只表示所有步骤完成；节点完成度仍由证据派生（§3）。

#### 4.7.3 revision 与 gate

- 修订事务：`BEGIN IMMEDIATE` → 校验旧 revision 无 `running` run → 旧行 `is_current=0, status='superseded'` → 插入新行 `revision+1, supersedes_id=旧id, is_current=1, lineage_id=旧lineage` → 复制 steps（`status='pending'`，清 `invocation_id/deadline_at`）→ 提交。
- 同一 `lineage_id` 只允许一行 `is_current=1`（部分唯一索引）；插入冲突 → 回滚并提示重试。
- gate 在 `awaiting_confirm → queued` 与 `blocked → queued` 时强制执行；G2 manual 允许 `waived`，必须同时写 `gate_waived_by / gate_waived_at / gate_waive_reason`，缺一即 `gate='incomplete'`。
- gate 结果只存 `pass/incomplete/waived`；具体缺项写 `gate_missing_json`，不得用空数组表示"通过"。

#### 4.7.4 `work_steps` 状态迁移表

| 当前 | 事件 | 下一状态 | 写入方 | 说明 |
|---|---|---|---|---|
| `planning` | 计划确认 | `pending` | WorkItemService | 只存在于计划 revision 内；确认后不再回 `planning` |
| `pending` | 依赖未满足/上游失败 | 保持 `pending` | 调度器 | 不 claim；由父 `work_item` 的 `blocked/failed` 聚合表达，不新增步级 `blocked` 状态 |
| `pending` | 基础设施前置失败（尚未产生 run） | `paused` | 调度器 | 记 `pause_reason`；恢复后新 attempt |
| `pending` | 需审批 | `waiting_approval` | 执行器 | 必须先落 `agent_approvals` 再置状态 |
| `pending` | 可执行 | `running` | 执行器 | 写 `started_at`、`invocation_id`、`deadline_at` |
| `waiting_approval` | 批准 | `running` | 审批回调 | 条件更新；重复回调幂等 |
| `waiting_approval` | 拒绝/超时 | `cancelled` / `timed_out` | 审批回调 | 记原因；不自动重试 |
| `running` | 有 checker | `review` | 执行器 | 只检查结果，不重复执行 |
| `running` | 无 checker 且成功 | `succeeded` | 执行器 | **会话 terminate 完成后才写** |
| `running` | 失败 | `failed` | 执行器 | 写 `failure_class`；不得写 `succeeded` |
| `running` | 超时 | `timed_out` | 超时控制器 | 杀进程组后写；partial 先落库 |
| `running` | 用户取消 | `cancelled` | 用户/调度器 | 与完成竞态用条件更新 |
| `running` | 需要输入 | `needs_input` | 执行器 | 写 `input_request_json`；会话保留或挂起按 B2 |
| `running` | 基础设施错误且当前 run 已终止 | `paused` | 执行器 | 旧 run 先落 `failed(infra)` 或 `interrupted`；恢复走新 attempt |
| `review` | 检查通过 | `succeeded` | 执行器 | — |
| `review` | 检查失败 | `failed` | 执行器 | 写 review 结论 |
| `review` | 需要输入 | `needs_input` | 执行器 | — |
| `needs_input` | 回答提交 | `pending` | WorkItemService | `attempt+1`；旧 run 已是终态 |
| `paused` | 恢复 | `pending` | 调度器 | `attempt+1`；无论暂停发生在 run 前还是 run 后，旧 run 必须已是终态，恢复不得复用旧 run id |
| `pending` | 可选步条件不满足 | `skipped` | 调度器 | 终态；写 `skip_reason`，不得伪装成 `succeeded` |
| 任一非终态 | 上游取消 | `cancelled` | 调度器 | `reason='upstream_cancelled'`，不是 `blocked` |

- 每次进入 `pending` 且由失败/输入/暂停恢复而来，`attempt = attempt + 1`；首次为 1。`work_runs.attempt` 必须等于同次 step attempt。
- **步终态写入必须在 session terminate 之后**：`succeeded/failed/cancelled/timed_out` 的 DB 更新发生在执行器确认会话结束、Phase B 已执行或已明确失败之后；否则下一步可能早于 Phase B 启动。
- `work_steps` 的终态不可回退；重试是新 attempt，不是改旧行状态。

#### 4.7.5 `work_runs` 生命周期与幂等

- **入队**：`BEGIN IMMEDIATE` → `SELECT COALESCE(MAX(run_seq),0)+1` → 插入 `status='queued'`，`idempotency_key = lineage:revision:step_seq:attempt`。唯一冲突 → 返回既有 run（幂等），不新建。
- **入队守卫（入口必查）**：`is_current=1`（被修订/替代的 revision 拒绝，`REVISION_SUPERSEDED`）；状态非终态（`done/failed/cancelled/superseded` 拒绝）；带 `stepId` 时该 step 必须属于该 item 的**当前 revision**（防止旧 revision 的 step 复用错位幂等键）。违反抛 `WorkRunConflictError`，不得静默入队。
- **claim**：`UPDATE work_runs SET status='running', started_at=? WHERE id=? AND status='queued'`；`changes=0` → 已被取消/其他 worker claim，直接返回。
- **终态**：`UPDATE ... SET status=?, ended_at=?, failure_class=?, ... WHERE id=? AND status='running'`；取消先行成功时，完成更新 `changes=0`，保留 `cancelled` 与 partial 输出。
- `run_seq` 按 `work_item_id` 单调递增；并发由 `BEGIN IMMEDIATE` + `UNIQUE(work_item_id, run_seq)` 兜底。
- `partial_output_ref` 统一 JSON：`{stdout_tail, stderr_tail, file_changes[], errors[], artifact_refs[], captured_at, truncated}`；上限为**代码常量**（非配置项）：`PARTIAL_FIELD_MAX_BYTES = 16KB` / `PARTIAL_TOTAL_MAX_BYTES = 64KB`（`work-run-service.ts:66-67`），超限截断并置 `truncated=true`。F2 的 subagent partial 直接映射到此结构；子代理侧另有常量 `MAX_OUTPUT_ENTRY_SIZE = 10_000` 单条截断（`base.ts:40`），两层值不一致，是否统一见 §12.5 第 4 项。
- `failure_class` 取值至少 `agent_error / timeout / cancelled / infra / approval_denied / upstream_cancelled`；`failed` 与 `cancelled` 不得混写。
- 重启对账（**已实施**，`WorkRunService.reconcileOnStartup`，启动时机在 `ipc-handlers.ts`）：
  - `running` → `interrupted`：重启后这些 run 必为僵尸，保留 partial，不自动重跑；
  - 结构性僵尸 `queued` → `cancelled(shutdown)`：item 不存在 / `is_current=0`（已被修订替代）/ item 已终态——永远不会再被合法 claim；
  - 时间性兜底 `queued` → `cancelled(shutdown)`：`created_at < now - 24h`（`QUEUED_STALE_MS`）。L1/L2 单进程串行、队列即排即取，单用户场景不存在 24h 仍合法的排队等待；结构性判定优先，阈值只兜底合法积压；
  - item 收敛：受影响 item 仍为 `running` 且已无 `queued/running` run → `interrupted`；
  - 每次启动写一行 `map_migration_reports(kind='cleanup', stage='work_runs_reconcile')`（stats: interruptedRunning / cancelledStaleQueued / interruptedItems / queuedStaleMs）。
  - 目的：`in_progress` 只由 `queued/running` run 触发；没有对账时任何僵尸 run 都会把节点永久钉在 `in_progress`（多 lineage 并存会放大该风险）。
- 导入 thread 孤儿清扫（**已实施**，`reconcileOrphanImportThreads`，同一启动段）：
  - 判定：`adapter_name='mindmap-internal' AND graph_id IS NULL AND status='running' AND created_at < now-24h`。正常导入完成会把 thread 置 `idle`、失败置 `error`，只有崩溃会停在 `running`；因此再加 `running` 才不会误删成功/失败的历史 thread（导入 thread 本身从不回填 `graph_id`）。
  - 阈值 24h（`ORPHAN_IMPORT_THREAD_STALE_MS`）与 `queued` 兜底一致：单次导入生成是分钟级，单机单实例下不存在 24h 仍合法的导入会话。
  - 留痕：每次启动写一行 `map_migration_reports(kind='cleanup', stage='chat_threads_orphan')`（stats: deletedThreads / deletedThreadIds / staleMs / cutoffMs），不静默删除。

#### 4.7.6 `node_session_links` 与会话时间线

- 创建：会话首次挂到节点时插入 `link_role='primary'`；同一 `(thread_id,node_entity_key,link_role)` 已存在 → 返回既有行。
- 项目级会话 `node_entity_key IS NULL` 使用部分唯一索引（§7.2），同一 thread + role 只一条。
- `started_at` 写会话开始；`ended_at` 只在会话结束时更新，不删除行。会话切换节点新增 link，不覆盖旧 link。
- 时间线查询：`node_session_links.created_at` + `chat_messages`；一个节点多个会话时返回 `threadIds[]`，由 UI 保留全部。

#### 4.7.7 `change_sets` 采集

- **base**：run claim 时记录项目 `HEAD` commit 与 `git status --porcelain`（dirty 标记）；**head**：run 终态时再记录。
- **文件清单**：来自 ScopeGuard 工作区差分 + `file_change` 事件；路径统一按 §5.4.1 规范化；只收录项目根内文件。
- `files_json` 元素：`{path, change:'added'|'modified'|'deleted'|'renamed', old_path?, additions, deletions}`；`file_count` 与 `additions/deletions` 为派生摘要。
- `dirty_tree_hash`：对 run 结束时所有 dirty/untracked 文件按规范化路径排序，拼接 `path + '\0' + sha256(content)` 后取 sha256；计算失败置 NULL 并 `dirty=1`，E3 不得使用。
- 采集失败/超时：不写空行假装"无变更"；`work_run` 标 `change_capture_failed`，活动流显示"未采集"。
- 一个 run 默认一条 `change_sets`；`UNIQUE(work_run_id)` 保证重试不重复插入；多次快照需求留到 B2。

#### 4.7.8 `routing_decisions`

- 每次 run 创建时写一条：`candidate_json` 为候选数组（`{adapter, score, capabilities, gaps}`），`chosen_adapter` 必填，`policy` 必填（取值见 §7.2）。
- 路由失败（无候选/能力不足）：run 不创建；`routing_decisions` 不写半条行（`chosen_adapter` 不允许空串）。失败原因写 `work_item.gate_missing_json` 或事件 `routing_failed`，并保留被拒候选清单。
- 不做自动重路由；重路由必须新 run（新 `attempt`/新 `run_seq`），旧决策保留。

#### 4.7.9 验收判据

1. 13 个 `work_items` 状态逐条构造；非法迁移全部返回 `CONFLICT`，数据不变。
2. 修订并发：两个修订同时提交，只有一个 `is_current=1`；另一个失败且旧行不变。
3. gate：G1–G6 各一条反例；`waived` 缺 `gate_waived_*` 任一字段 → 拒绝。
4. 取消 vs 完成：同一 run 并发触发，终态唯一；下游步骤 `cancelled(reason='upstream_cancelled')`。
5. 重启对账：kill 进程后启动，`running` 全部 `interrupted`，partial 保留，无自动重跑。
6. 幂等：同一 `idempotency_key` 入队两次只产生一条 run。
7. `change_sets`：正常/失败/未采集三态；dirty 下 E3 被拒。
8. 会话：同 thread 同节点重复挂载只一条；项目级 NULL 不重复；结束不删行。

---

## 5. 复杂任务拆解机制（结构推导 + 人工确认 + 可修订计划）

### 5.1 总览：不存在零人工方案

产品方问的是"有没有一劳永逸的办法"。结论：**没有零人工方案**。原因是任务边界本质上是语义判断，而现有结构数据只能提供证据，不能提供意图。本机制的目标不是消灭人工，而是把人工介入收敛为 **2–4 次高信息量决策**，并让每次决策都可被后续数据校准。

```
锚点节点
   │
   ├─[1] 结构信号提取 ── 层级 / fileAssociations / relatedFiles / 依赖边 / 变更面
   │
   ├─[2] 候选边界生成（确定性算法，可复现）
   │        └─ boundary_candidates（含得分、信号、理由）
   │
   ├─[3] 模型选择与组织（只能从候选集中选，不得发明边界）
   │        └─ plan_drafts（含被剔除的越界项，留审计）
   │
   ├─[4] 人工确认点 C1（计划批准）
   │
   ├─[5] 落 work_items + 准入校验（gate）
   │
   ├─[6] 执行 → work_runs → 证据 / 测试
   │
   ├─[7] 偏差度量 → plan_deviations
   │
   └─[8] 规则校准（离线，改阈值/权重，不自动改计划）
```

### 5.2 候选边界推导（算法与数据来源）

#### 数据来源

| 信号 | 来源字段 | 说明 |
|---|---|---|
| 层级 | `nodes.parent_id`、`sort_index` | 子树、兄弟序 |
| 文件关联 | `nodes.metadata.fileAssociations[].path`（`type` 为 `file`/`directory`/`method`） | 结构化关联，优先级最高 |
| 内容关联文件 | `nodes.content.relatedFiles[]` | 分析产物，可能为空 |
| 上下文文件引用 | `nodes.context_refs` 中 `type='file'` 的 `id` | 手工附加，可信 |
| 依赖边 | `edges` 中 `edge_type IN ('dependency','co-change')` | 图内依赖 |
| 变更面 | `change_sets.files_json` / git diff | 与当前工作区相关度 |
| 历史 | 已完成 `work_items` 的 scope_files 与实际变更文件 | 校准用，不参与首次排序权重（冷启动无数据） |

#### 算法（确定性、可复现）

```
输入：anchor（node_entity_key 或项目级）、graph、maxCandidates=20、depthLimit=3

Step 1 锚定
  S0 = {anchor} ∪ descendants(anchor, depth ≤ depthLimit)
  若 anchor 为 wiki-page / project，或子树为空 → 直接进入退化路径 D5/D1

Step 2 文件集提取
  对每个 n ∈ S0:
    F(n) = { fileAssociations[path] (file/directory 展开为前缀) }
         ∪ { content.relatedFiles[] }
         ∪ { contextRefs(type=file).id }
  若所有 F(n) 为空 → 退化 D1

Step 3 依赖闭包
  S1 = S0 ∪ { m : 存在 dependency/co-change 边从 n∈S0 出发或指向 n，depth ≤ 1 }
  依赖边缺失 → 跳过该信号并记 signal_missing，置信度下调（不阻断）

Step 4 变更面加权
  C = change_set.files（当前 worktree 或最近一次提交）
  对每个 n: change_hit(n) = |F(n) ∩ C| / max(1, |F(n)|)

Step 5 候选生成
  以"文件重叠 + 层级邻近"做确定性聚类：
    若 Jaccard(F(a), F(b)) ≥ 0.3 且层级同父或父子 → 归入同一候选
  每个候选 c = { node_keys, files, boundaries_reason }
  打分：
    score(c) = 0.35*hierarchy_proximity
             + 0.25*file_cohesion
             + 0.20*dependency_closure
             + 0.15*change_surface
             + 0.05*history_hit          -- 无历史时为 0，权重归一化
  其中：
    hierarchy_proximity = 1 - (min_depth(c) - depth(anchor)) / depthLimit
    file_cohesion       = 候选内文件对平均 Jaccard
    dependency_closure  = min(1, 内部依赖边数 / max(1, |c|-1))
    change_surface      = mean(change_hit(n))
  阈值：
    score ≥ 0.75 → 建议采纳
    0.50–0.75   → 需人工选择
    < 0.50      → 丢弃，但保留在候选集里供人工查看

Step 6 约束
  候选数 ≤ 20；单候选文件数 ≤ 20；超过 → 按模块层截断并提示（D4）
  重叠候选（同文件被多个候选覆盖 > 30%）→ 标 conflict，C1 必须人工裁决
```

#### 存储

- 一次推导 = 一个 `boundary_candidates.derivation_run_id` 批次。
- 每个候选存 `node_keys_json`（**键，不是 node id**）、`files_json`、`signals_json`、`score`、`confidence`、`reason`。
- 候选一旦被采纳，`status='chosen'` 并写 `plan_drafts` 引用。

### 5.3 模型只做选择与组织

模型输入只包含：候选列表（id、节点标题、文件清单、得分、理由）+ 锚点摘要 + 已确认验收条件。

模型输出只允许：选择候选、组织成层级、为每个子任务写标题/目标/验收条件草案/文件范围草案。

**输出校验（补外部审查项）**：模型的选择结果仍必须经过 schema 校验；校验失败允许**修复 1 轮**，仍不合规则走 §5.8 D7 的纯人工路径。不得把"模型已选择"当作"已通过准入"。

**分层（D3）**：复杂任务固定走"确定性候选推导 → 模型只在候选集内选择、不发明边界 → 越界项剔除并写审计 → gates"；简单任务跳过候选推导，直接生成单步计划（判据见 §5.9.1）。两层都不允许无人工确认直接执行。

强制约束：

- 模型输出中出现候选集之外的节点或文件 → **剔除并记入 `plan_drafts.rejected_boundaries_json`**，用于后续审计与规则改进。
- 模型不得修改 `files_json` 的父级目录前缀，不得把范围扩大到候选并集之外。
- 模型不得自行降低验收条件，只能补充。
- 模型不得生成超过 `maxCandidates` 的子任务。

模型失败或输出不合规 → 保留候选集，进入**纯人工确认**路径（候选卡片直接给用户选），不阻塞流程。

#### 5.3.1 施工细则（G10-1）：模型输出 schema 与校验

**数据（输出 JSON，强制）**

```json
{
  "selected_candidate_ids": ["bc_..."],
  "items": [
    {
      "client_item_id": "it_1",
      "title": "string",
      "goal": "string",
      "parent_client_item_id": null,
      "scope_files": ["src/a.ts"],
      "acceptance": [
        { "id": "ac_1", "type": "command", "expected": "exit=0", "command": "npm test -- a" },
        { "id": "ac_2", "type": "file_check", "expected": "contains", "path": "src/a.ts" }
      ],
      "depends_on": []
    }
  ]
}
```

**校验规则（顺序执行，全部通过才进入候选确认）**

1. `selected_candidate_ids` 必须是本次 `derivation_run_id` 候选的子集，且非空。
2. 每个 `scope_files` 非空、已按 §5.4.1 规范化，且是 `selected_candidate_ids` 文件并集的子集；不得扩到候选并集之外。
3. `items.length ≤ maxCandidates`；`client_item_id` 唯一；`parent_client_item_id` / `depends_on` 只能引用已定义 id；`depends_on` 无自引用、无环。
4. 每条 `acceptance` 必须含 `id`/`type`/`expected`；`type='command'` 必带 `command`，`type='file_check'` 必带 `path`；至少 1 条；不得删除或弱化锚点已确认的验收条件。
5. 越界节点/文件、超限子任务 → 从结果中剔除，原样写入 `plan_drafts.rejected_boundaries_json`（含 `reason`），不静默丢弃。

**失败分支**

- 首次校验失败 → 附逐条错误修复 1 轮；修复后仍失败 → D7 纯人工路径。
- 模型输出非 JSON / 超时 → 不重试第二次，直接 D7；候选集保留。

**验收**

1. 模型给出候选外文件 → 该项被剔除、`rejected_boundaries_json` 有记录、计划可继续确认。
2. `scope_files` 为空或越界 → 修复 1 轮内可改；仍错 → 进入 D7，不产生 `work_items`。
3. 合法输出 → 生成 `plan_drafts` 一行，`status='awaiting_confirm'`，C1 可展示全部子任务。

### 5.4 准入条件（gate）

子任务进入执行队列前必须全部满足：

| 编号 | 条件 | 判定 |
|---|---|---|
| G1 | `scope_files` 非空，且全部位于项目根下（realpath 校验，含符号链接） | 自动 |
| G2 | `acceptance_json` 至少 1 条**结构化可判定**项（`type` ∈ `command`/`manual`/`file_check`，带 `expected`） | 自动 |
| G3 | 目标节点在 dev 图（`nodes.graph_type='dev'`），不包含跨图写 | 自动 |
| G4 | 规模上限：文件数 ≤ 20 且预估行数 ≤ 800（可配置） | 自动 |
| G5 | 依赖闭包内无未完成前置；或显式标 `blocked` 并给出依赖 id | 自动 |
| G6 | 与其它 `running` 任务的 `scope_files` 无交集（写冲突预检） | 自动 |

- 未过 → `gate_status='incomplete'`，`gate_missing_json` 写具体缺失项，**不进队列**。
- 只有 G2 的 `manual` 类型允许人工豁免（`gate_status='waived'` 需记录豁免人与理由）；G1/G3/G4 不允许豁免。
- 准入校验是纯确定性代码，模型输出不能覆盖。

#### 5.4.1 路径规范化（统一用于 G1 / G6 / scope_files / fileAssociations / change_sets / node_links）

所有路径比较前必须经过同一条规范化管线，禁止各调用点自行拼接字符串：

1. `realpath` 解析符号链接；路径尚不存在时，对最近的已存在父目录做 `realpath` 再拼回剩余段。
2. Unicode **NFC** 归一（macOS 文件系统常见 NFD，直接比较会误判"同名不同串"）。
3. 分隔符统一为 `/`，去掉末尾 `/`（根除外）。
4. 大小写折叠：macOS 默认大小写不敏感文件系统用 `caseFold`（`toLocaleLowerCase`）；Linux 保持原大小写。折叠结果只用于**比较键**，展示与落库保留原值。
5. 规范化后必须落在项目根之下；越界（`..`、外部绝对路径、指向根外的符号链接）→ G1 直接失败，不允许豁免。

应用范围：G1 的"位于项目根下"、G6 的写冲突预检、`work_items.scope_files`、节点 `metadata.fileAssociations[].path`、`content.relatedFiles[]`、`change_sets.files_json`、`node_links` 的文件级关联。任一表存了未规范化路径，都必须在使用点重新规范化后比较，不得直接字符串相等。

Windows 路径规则不在本期验证范围（A9）；遇到非 POSIX 根 fail-closed，不做猜测性兼容。

### 5.5 可修订计划

状态机：

```
draft ──► awaiting_confirm ──► confirmed ──► (生成 work_items, 计划行只读)
   ▲              │
   └──── revise ◄─┘
任意状态 ──► superseded（被新 revision 取代,只读）
任意状态 ──► rejected
```

规则：

- `revision` 单调递增；`lineage_id` 不变；`supersedes_id` 指向上一行。
- 只有 `is_current=1` 的行参与执行、统计、UI 默认展示。
- **`confirmed` 是计划草稿的终态**：确认后不可 `revise`；同一 lineage 也只允许一次 `confirm`。理由：`confirm` 已按 items 生成 work_items，再修订会把计划行退回 `awaiting_confirm` 并再次确认，产生第二套 parent+children，而旧一套仍是 `draft`（既不 supersede 也不继承）。若确认后要调整，走 work_item 层修订（`WorkItemService.revise`：running-run 守卫 + 旧行 `superseded` + 新 revision 继承/复制 steps），或新建计划草稿（新 lineage）。旧计划行保持 `confirmed`/`is_current=1` 作为"当时确认了什么"的事实；已生成的 work_items 不因计划层操作被 supersede。
- 执行中修订：新 revision 继承未完成项；已完成项默认不重跑，除非显式 `rework`（此时新增 run，旧 run 证据保留并标 `superseded_by_revision`）。
- 旧 revision 的 evidence 不迁移，`plan_deviations` 仍按旧 revision 统计，避免"改计划后看起来偏差变小"。

#### 5.5.1 DAG 正确性（环检测、分层、依赖优先级、父任务聚合）

**环检测（硬性）**：计划确认（C1）时对 `depends_on_json` 建图并做环检测；存在环 → 拒绝确认，写入拒绝原因，**不得进入队列**（否则相关项会永久 `queued`）。执行中不得引入新环。

**分层（Kahn）**：确认后按入度做 Kahn 拓扑分层，层内保持稳定顺序；本期串行执行，层号用于排序与并发上限判断，不代表并行放行。

**依赖优先级**：`显式 depends_on_json` > `隐式引用`（共享 `scope_files` / `verifies` 目标 / 同锚点）> `数组顺序`。某任务一旦有显式依赖，就不再为其推断隐式依赖；完全无依赖时按数组顺序兜底。推断来源写入 `metadata.dependency_source ∈ ('explicit','implicit','order')`，供复盘。

**父任务终态聚合**：父任务只有在**全部叶子后代进入终态**后才进入终态；聚合规则：

| 叶子情况 | 父任务终态 |
|---|---|
| ≥1 `failed` / `timed_out` | `failed` |
| 全部 `cancelled` | `cancelled` |
| 有 `needs_human` / `paused` / `needs_input` | 保持非终态（对应状态） |
| 全部 `done` / `skipped` | `done` |

父任务不得因为"部分子任务完成"而提前标 `done`；聚合只在叶子全部终态时计算一次并落库。

#### 5.5.2 施工细则（G10-1）：Kahn 分层与聚合验收

**算法（确认时执行一次，结果落 `plan_drafts.layers_json`）**

```
indeg[v] = |{u : u depends_on v 的显式边}|   // 去重后的显式依赖
ready = [v : indeg[v] == 0]（按数组顺序稳定排序）
layers = []
while ready 非空:
  layers.push(ready)
  next = []
  for v in ready:
    for w in successors(v):
      indeg[w] -= 1
      if indeg[w] == 0: next.push(w)（按数组顺序）
  ready = next
if 处理数 < 节点数: 存在环 → 拒绝确认
```

**依赖优先级冲突**

- 同一对节点既有显式 `depends_on` 又有隐式推断 → 只保留显式边，`dependency_source='explicit'`；隐式边不重复计数。
- 自依赖、重复依赖、引用不存在 id → 视为非法计划，拒绝确认。
- 完全无依赖时按数组顺序兜底，`dependency_source='order'`。

**验收**

1. 三层 DAG → `layers_json` 为 3 层且层内顺序稳定；重复确认结果一致。
2. 含环计划 → 拒绝确认（错误含环上的节点 id），`work_items` 新增 0 行。
3. 父任务 3 个叶子：2 done + 1 running → 父保持 `running`；全部终态后才按 §5.5.1 表落终态。
4. 聚合函数重复调用 → 父状态与 `updated_at` 不变（幂等）。

### 5.6 人工确认点

| 编号 | 时机 | 是否强制 | 必须展示 |
|---|---|---|---|
| C1 | 计划批准（`plan_draft` → `work_items`） | 强制 | ①每个子任务的标题/目标；②`scope_files` 完整清单与越界提示；③验收条件逐条；④依赖关系；⑤候选得分与"为什么这样切"；⑥未通过 G1–G6 的项与补齐建议；⑦被模型剔除的越界项；⑧不可推导项（退化标记）；⑨每个锚点节点当前 `execution_state` 与最高证据等级 |
| C2 | 执行中修订（新增/删除/合并/拆分） | 强制 | ①与上一 revision 的 diff（按子任务/文件）；②影响面（哪些 run 会失效、哪些证据会 stale）；③修订原因；④新 revision 的 gate 结果 |
| C3 | 测试计划审批（`test_plan`） | 强制 | ①命令清单与其 `cwd`；②worktree 路径与基线 commit；③影响文件；④策略判定结果（allow/ask/deny 逐条）；⑤计划哈希；⑥预计时长上限 |
| C4 | 完成认定（人工写 `nodes.status` 前） | 强制 | ①当前 `execution_state` 与证据列表（可点开）；②stale 证据清单与原因；③未满足的验收条件；④建议（若有）及其来源；⑤与上次人工状态的差异 |

反例（明确禁止）：只显示"是否同意？"的确认按钮；把 C1/C2 合并成一次；把 C3 的审批做成"记住本次选择"的永久授权；C4 用模态框默认勾选"已完成"。

#### 5.6.1 施工细则（G10-1）：确认接口与状态

**接口（全部人工发起；agent 不得调用）**

| 确认点 | 通道 | 入参 | 出参 / 错误 |
|---|---|---|---|
| C1 | `map:plan:draft:confirm` | `{ planDraftId, revision, viewedItems[] }` | `{ planId, workItemIds[] }`；`C1_GATE_INCOMPLETE { missing[] }` / `C1_STALE_REVISION` |
| C2 | `map:plan:revise` | `{ lineageId, baseRevision, items[] }` | `{ newRevision, gate: {missing[]} }`；`C2_CONFIRM_ONCE` |
| C3 | `map:test-plan:approve` | `{ planId, planHash }` | `{ approvalId, runId }`；`PLAN_HASH_MISMATCH` / `APPROVAL_DENIED` |
| C4 | `map:node:complete` | `{ graphId, entityKey, status, evidenceIds[], note }` | `{ nodeId, status }`；`C4_EVIDENCE_MISSING` / `C4_STALE_EVIDENCE` |

**状态迁移**

- C1：`plan_drafts.awaiting_confirm → confirmed`；退回走 `revise` 生成新 revision，旧行 `superseded`；`rejected` 为终态。
- C2：`running → awaiting_confirm(new revision) → confirmed | superseded`；执行中禁止直接改已确认计划行。
- C3：`test_plans.draft → approved | denied`；`approved` 绑定 `plan_hash` + `approval_id`，执行时二次校验。
- C4：`nodes.status` 只在人工确认后写；写前必须展示证据与 stale 清单，缺证据拒绝。

**幂等与边界**

- C1 以 `(lineage_id, revision)` 幂等：重复确认返回同一批 `workItemIds`，不重复建任务。
- C3 重复审批同一 `plan_hash` 返回既有 `approvalId`；`plan_hash` 变化必须重新审批。
- 四个确认点均不得被 agent、定时任务或后台重试自动触发；缺任一确认点即停在对应非终态。

**验收**

1. C1 未确认 → `work_items` 0 行；确认一次 → 任务集与 items 一一对应；再次确认 → 行数不变。
2. C2 在 `confirmed` 后直接修订 → `C2_CONFIRM_ONCE`；走 `revise` 则旧 revision `superseded`。
3. C3 `plan_hash` 不符 → `PLAN_HASH_MISMATCH`，0 执行。
4. C4 无证据或仅 stale 证据 → 拒绝写 `nodes.status`，节点状态不变。

### 5.7 偏差度量

采集字段（`plan_deviations`，一次 `work_run` 结束写一行）：

| 字段 | 含义 | 主要用途 |
|---|---|---|
| `planned_file_count` / `actual_file_count` | 计划文件数 vs 实际变更文件数 | 判断文件范围推导是否过窄/过宽 |
| `planned_subtask_count` / `actual_subtask_count` | 计划子任务数 vs 实际执行子任务数 | 判断拆分粒度 |
| `turns_used` / `tool_calls` | 该 run 的轮次与工具调用数 | 判断任务复杂度估计 |
| `rework_count` | 同一子任务重复执行次数 | 判断验收条件质量 |
| `test_failures` | 测试失败次数 | 判断边界是否把耦合拆散 |
| `replan_count` | 该 lineage 的 revision 次数 | 判断初始计划质量 |
| `scope_violation` | 是否出现范围外写（0/1） | 判断模型是否越界 |
| `boundary_changed` | 实际边界与计划是否不同（0/1） | 判断推导规则是否有效 |
| `duration_ms` | 执行时长 | 辅助评估 |
| `derivation_version` | 生成计划时固定的计划规则版本 | **归因维度**（计划生成后不可变） |
| `observed_rule_version` | 记录时的配置哈希（阈值/权重快照） | **归因维度**；一批内配置不可变时可删 |
| `task_type` | 记录时快照（锚点类型 / 任务来源分类） | **归因维度** |
| `agent_type` | 记录时快照（实际执行 adapter） | **归因维度**；Tier 1 下通常为单值 |

- `file_domain`（目录前缀）**不存单值**：一次 run 可跨多个目录，由视图 `v_plan_deviations_file_domain` 从 `change_sets.files_json` 展开（§7.2）；路径先按 §5.4.1 规范化再取前缀。v38 已实施明细视图（不带 `project_path`）；聚合一期不做，需要时在明细之上按需聚合。
- `observed_rule_version` 保留：阈值/权重允许人工在 run 之间修改，记录时哈希才能对齐配置。若后续锁定"一批内配置不可变"，则删除该列。

用途（三条，不超过这三条）：

1. **阈值校准**（离线）：按 `derivation_version` + `observed_rule_version` + `task_type` / `agent_type` / `file_domain` 聚合，若 `actual/planned` 文件数连续 3 批 > 1.5，则下调 `file_cohesion` 阈值或提高拆分粒度；若 `replan_count` 中位数 > 2，则提高候选数上限并强化 C1 展示。
2. **退化检测**：`scope_violation` 或 `rework_count` 高频的锚点类型（如 wiki-page、跨模块流程）标记为"结构不可推导"，下次直接进退化路径。
3. **确认强度自适应**：`replan_count` 高的项目在 C1 增加"必须逐条勾选验收条件"，低风险项目可折叠次要信息 —— 但**不允许跳过确认**。

校准是离线分析 + 人工改配置，不做在线自动学习、不自动修改历史计划。

**冷启动与回顾口径（D3）**：权重冷启动直接采用 §5.2 的默认值（0.35 / 0.25 / 0.20 / 0.15 / 0.05），不等待历史数据；`history_hit` 无历史时为 0 并归一化。校准只使用 `plan_deviations` 的以下字段：`planned_file_count` / `actual_file_count`、`planned_subtask_count` / `actual_subtask_count`、`rework_count`、`scope_violation`、`boundary_changed`、`replan_count`、`test_failures`，并按 `derivation_version` / `observed_rule_version` / `task_type` / `agent_type` / `file_domain` 分组。**聚合窗口只保留一套：每 20 个 run 或每 2 周（取先到者）一次离线回顾；只调配置阈值/权重，不改历史计划、不做在线学习。**

> **归因（已定）**：`plan_deviations` 的统一归因为 `derivation_version`（计划生成时固定）+ `observed_rule_version`（记录时配置哈希）+ `task_type` / `agent_type` / `file_domain`（目录前缀，视图派生）。**`boundary_changed` / `scope_violation` 只作为路由特征**（退化判定与确认强度自适应），**不进成功率分母**；成功率分母只含正常完成/失败的 run，不含边界变更与范围越界这两个特征位。

**采集时点**：run 终态事务提交后写入；字段取自 `work_items` / `work_runs` / `change_sets`；`change_sets` 未采集时 `actual_file_count=NULL`，不写 0。派生重算失败只记 `map_migration_reports(kind='derivation')`，不阻塞任务终态。

### 5.8 退化与兜底

| 编号 | 触发条件 | 退化策略 |
|---|---|---|
| D1 | 所有节点的 `fileAssociations` + `relatedFiles` + `contextRefs(file)` 为空 | **单任务模式**：整个锚点子树作为一个 `work_item`；文件范围由用户在 C1 手工框选（必须非空才过 G1）；不自动拆解 |
| D2 | 变更面为空（无 git、无未提交变更） | 仅用结构信号，`change_surface` 权重归零并重新归一化；C1 强制展开候选明细 |
| D3 | 依赖边缺失 | 跳过依赖闭包；用目录前缀邻近替代；`confidence` 上限 0.7 |
| D4 | 子树深度 > 3 或跨模块 | 截断到模块层生成候选；提示"更细粒度需人工拆分" |
| D5 | 锚点是 `wiki-page` / `project` | 拒绝自动拆解，只提供"人工新建子任务"入口 |
| D6 | 候选重叠不可分（Jaccard > 0.8 且无法按依赖切分） | 合并为单候选，C1 提示"该范围强耦合，建议作为一个任务" |
| D7 | 模型不可用/输出不合规 | 候选卡片直接人工选择；所有 C1 展示项改为纯数据展示 |

兜底优先级：结构推导 → 候选人工选择 → 单任务模式 → 纯人工拆解。**任何一级兜底都不产出"未经人确认的执行计划"。**

#### 5.8.1 施工细则（G10-1）：退化落点与验收

| 编号 | 执行落点 | 写入 | 验收 |
|---|---|---|---|
| D1 | `deriveCandidates` 返回 `{mode:'single_task'}` | `plan_drafts.reason='D1'`；`scope_files` 留空待 C1 | 无文件信号 → 1 个任务、0 自动拆分；C1 框选为空 → G1 不过 |
| D2 | 权重表把 `change_surface` 置 0 后归一化 | `derivation_reports.signals_json.change_surface=0` | 权重和 = 1；C1 强制展开候选 |
| D3 | 跳过依赖闭包，目录前缀替代 | `confidence = min(score, 0.7)` | `confidence ≤ 0.7`，无依赖边时仍可出候选 |
| D4 | 截断到模块层 | `plan_drafts.truncated_at_depth=3` | 子任务不含文件级叶子；C1 提示人工细分 |
| D5 | 不调模型 | `plan_drafts.mode='manual_only'` | `wiki-page`/`project` 锚点 → 0 自动候选，仅人工新建入口 |
| D6 | 合并候选 | `candidates[].conflict=true` | 重叠 > 0.8 → 单候选；C1 展示强耦合提示 |
| D7 | 跳过模型 | `plan_drafts.reason='D7'` | 模型失败/二次修复失败 → 仅人工卡片，`work_items` 0 行直到 C1 |

通用：每次退化都在 `map_migration_reports(kind='derivation', stage='Dx')` 留一行（含输入摘要与耗时）；退化不得跳过 C1。

---

### 5.9 执行编排机制（采纳自外部蓝图，补我们此前的空白）

我们此前只定义了"计划怎么来、怎么确认"，没有定义"确认之后怎么跑"。以下机制整体采纳，并受本设计的双轨/证据规则约束。

#### 5.9.1 单步与多步的分流

- `simple`：单文件、无跨节点依赖、`scope_files` 只落在一个节点 → 生成单步计划；仍需一次人工确认（C1/C2 合并为一次点击），**不跳过确认**。
- `complex`：多文件/多节点/存在依赖 → 走结构推导 → 人工确认 C1–C4 → 执行。
- 判据取并集保守判定：任一信号为 complex 即走 complex；不允许模型自称 simple。

#### 5.9.2 失败分类与策略

| `failure_class` | 含义 | 策略 |
|---|---|---|
| `infra` | 解析/本地工具/存储异常 | 同 turn 重试 ≤2，退避 1s/4s；仍失败 → `needs_human` |
| `busy` | 节点或会话忙 | 回 `queued`，**不计 attempt**，按优先级重排 |
| `turn_fail` | 单轮校验失败 | 同 task 重试 ≤2，提示带失败原因 |
| `verify_fail` | 验收未过 | 回 `running` 再产出一轮；仍失败 → `needs_human` |
| `test_fail` | 测试失败 | 进 bug 闭环（§6.6），不重试同一命令 |
| `env_fail` | 依赖/端口/编译环境 | `needs_human`，**不建 bug** |
| `timeout` / `cancel` / `denied` | 超时/取消/审批拒绝 | 落对应终态；`denied` 不改写计划 |

- 每个失败必须写 `failure_class` + `attempt` + 可读原因；没有分类的失败不允许进入重试。
- 重试上限与退避写配置，不硬编码在调用点。

#### 5.9.3 调度、并发与写冲突

- **全局写闸 `WorkspaceWriteGate`**：agent 编排阶段的写操作按项目串行（同一工作区同一时刻只允许一个写者）；测试执行仍走 §6 的隔离 worktree，两者不共用锁。
- 并发上限：全局 2、单图 1、单节点 1；超限任务保持 `queued`，按 `priority DESC, created_at ASC` 出队。
- **节点忙不重试**：`SESSION_BUSY` → 重新排队；`NODE_BUSY` → 等待当前 run 结束再出队。
- **不做自动回滚**：已通过人工审批的 diff 不自动 revert；回滚是新的 work_item。
- 取消语义：`cancel(work_item)` → 当前 run 落 `cancelled`，下游依赖项落 `cancelled(reason='upstream_cancelled')`（**不是 `blocked`**）；已完成的 run 不回滚。完整迁移与进程杀灭见 §5.9.7。

#### 5.9.4 超时与重启

- 单步 `deadline_at` 默认 10 分钟（测试命令默认 60 分钟），由调度器写入并强杀；**不允许出现"有 deadline 但没有写入者"**。
- **任务总 wall clock**：单个 `work_item` 的所有 step / attempt / 重试累计默认 60 分钟（可配置）；到期不再重试，直接落 `timed_out`（`failure_class='timeout'`），已产出部分按 §4.2 保留。
- **队列重排**：出队键 `priority DESC, created_at ASC`；每 60 秒重算一次。等待超过 10 分钟的项按"每 10 分钟 +1 优先级"做轻度 aging，避免长任务持续插队导致饥饿；aging 只影响排序，不改 `priority` 的持久值。
- 启动对账：`running` → `interrupted` → 按"是否需要审批 / 是否幂等"决定 `queued` 或 `cancelled`；不自动重放需审批步骤。
- 幂等键 `work_item_lineage_id:work_item_revision:attempt` 透传到 runtime；同一键重复提交必须幂等。

#### 5.9.5 能力票（Tier）与降级

| Tier | 能力 | 本期策略 |
|---|---|---|
| Tier 1 | 单轮 + 会话续跑 + 审批事件 + 结构化输出 | **唯一允许参与编排（读 + 写）** |
| Tier 2 | 部分事件/续跑不稳；**无写前审批回调**（如 Codex SDK） | **只允许只读编排**（分析、评审、候选推导）；任何写步骤不得由编排器直接执行，只能排队等用户手动开会话处理 |
| Tier 3 | 无事件/无恢复 | 禁止编排，只能人工在会话中手动使用 |

- Tier 由能力探测结果决定并写 `routing_decisions`；不允许按模型名硬编码。
- **编排写路径仅 Tier 1**。Tier 2 不能"降级执行写步骤"：没有写前审批回调就无法满足"不绕过审批网关"，降级等于开后门。
- `degraded` 状态只用于用户手动打开的会话（UI 明示"降级执行，不保证中断恢复"），**不用于编排器**；编排器不得静默换 adapter。
- **MVP 范围（已定）**：仅 Tier 1 参与编排（读 + 写）；Tier 2 只读或排队等人工会话，Tier 3 不参与编排。
- **审计票与审批票分离**：`KERNEL_AUDIT_CAPABLE_BACKENDS` 只决定能否执行只读审计/分析，**不**等于写前审批能力；写步骤仍只认 `approval_callback=1` 的 Tier 1。
- 能力策略统一返回 `{allowed, tier, degraded}`：`allowed` 是本次 step 是否可执行，`tier` 是能力票，`degraded` 只允许手动会话置 1。
- Tier 2 执行只读审计时，`routing_decisions.policy='tier2_audit'`，且该 run 不得包含写步骤；探测失败一律落 Tier 3，禁止按"未知"放行。
- **禁止静默换 adapter**：换 adapter 必须新 run + 新 `routing_decisions`；不得在同一个 run 内改写 `chosen_adapter`。

#### 5.9.6 明确不采纳的部分

- **不采纳"由 LLM planner 直接产出并执行 TaskDAG"**：我们的分解必须来自结构推导 + 人工确认（§5.1–5.6），模型只做选择与组织。
- **不采纳"节点状态由任务完成事件自动推进"**：`nodes.status` 仍只允许人写（§1.4），任务完成只影响 `work_runs` / `work_item` 与派生 `node_execution_state`。
- **不采纳"MVP 不做 worktree"**：TestExecutor 仍用隔离 worktree；全局写闸只覆盖 agent 编排的共享工作区。

#### 5.9.7 取消语义：真杀进程、竞态与下游传播

取消必须作用于真实进程，不只是改数据库状态。

| 起点状态 | 取消动作 | 落点 |
|---|---|---|
| `queued` | 从队列移除，不启动进程 | `cancelled(reason='user')` |
| `awaiting_approval` | 撤销待审批项（标记 `expired` / `cancelled`），从待办列表移除 | `cancelled(reason='user')` |
| `running` | 先写 `cancel_requested_at`，对**进程组**发 `SIGTERM`（含子进程），宽限 10 秒后 `SIGKILL`；等待进程退出 | `cancelled`（或按竞态规则） |
| `blocked` / `needs_input` / `paused` | 无进程，直接落库 | `cancelled(reason='user')` |
| 已终态（`completed` / `failed` / `timed_out` / `cancelled` / `superseded`） | 幂等返回，不改写结果 | 保持原终态 |

硬规则：

1. **进程组杀灭**：执行器以独立进程组启动；取消与超时都杀整组，避免只杀父进程留下子进程。
2. **取消与完成竞态**：终态写入使用条件更新 `WHERE status IN ('queued','running','awaiting_approval','blocked','needs_input','paused')`；若 `completed` 已先落库，取消不覆盖，返回 `already_completed`。`cancel_requested_at` 只作审计，不改变已完成事实。
3. **部分产出先落库**：取消前把已收到的 stdout / 文件变更 / 失败原因写入 `partial_output_ref`，再写 `cancelled`；不允许"取消即丢产出"。
4. **下游传播**：下游未执行项落 `cancelled(reason='upstream_cancelled')`，**不得写 `blocked`**；无关分支继续执行。
5. **worktree 清理**：取消的测试运行不保留失败现场（失败现场只针对 `test_fail`）；先抓取日志，再立即删除 worktree，避免残留。

#### 5.9.8 步级状态机与 `needs_input`

`work_steps.status` 取值与迁移（**12 值**；括号内为写入方，与 `WORK_STEP_TRANSITIONS` 一一对应）：

| 状态 | 含义 | 允许的下一步（写入方） |
|---|---|---|
| `planning` | 计划生成中 | `pending`（`activatePlanningSteps`）/ `failed`（`failUnstarted` → `blocked_by_dependency`）/ `cancelled`（`cancel`） |
| `pending` | 已就绪待调度 | `waiting_approval`（`awaitApproval`）/ `running`（`start`）/ `skipped`（`skip`）/ `failed`（`blockUnstartedDependents` → `failUnstarted`）/ `paused`（`pause`）/ `cancelled`（`cancel`） |
| `waiting_approval` | 等待审批 | `running`（`start`）/ `timed_out`（`fail`，deadline 扫描）/ `cancelled`（`cancel`） |
| `running` | 执行中 | `review` / `succeeded` / `needs_input`（`complete`）/ `failed` / `timed_out`（`fail`）/ `paused`（`pause`）/ `cancelled`（`cancel`） |
| `review` | 产出待评审/checker（**当前无生产写入方**） | `succeeded` / `needs_input`（`complete`）/ `paused`（`pause`）/ `cancelled`（`cancel`）；`failed` 未实现（无写入方，不为死状态加迁移） |
| `needs_input` | 等待用户回答 | `pending`（`resume`，`attempt+1`）/ `succeeded` / `failed`（`settleNeedsInput` 人工确认收口）/ `cancelled`（`cancel`） |
| `paused` | `infra` 等原因暂停 | `pending`（`resume`，`attempt+1`）/ `cancelled`（`cancel`） |
| `succeeded` / `failed` / `timed_out` / `cancelled` / `skipped` | 终态 | — |

> `blocked_by_dependency` 是 `failure_class` 归因值，不是第 13 个状态；`settleNeedsInput` 是已实现扩展（`needs_input` 直接收口到终态，不新开 attempt）。

- **状态变更即落库**：每次迁移立即 `UPDATE work_steps`，并通过 `WorkStepService` 的 `onChanged` 发出 `work_step_changed`；主进程沿用 `event:work-item-changed` 通道下发（不新开 `event:work-step-changed`，payload 增 `stepId`），renderer 按 lineage 去抖重拉。5 处构造点（`work-scheduler` / `work-execution-service` / `acceptance-confirmation` / `agent-step-runner` / `work-item-service`）全接；禁止只在内存中维护状态、结束才写库。
- **`needs_input` 问题卡**：写 `input_request_json`（问题、可选项、默认值、影响范围、阻塞的后续步）；同步把 `work_items.status` 置 `needs_input`。
- **回答后开新 attempt**：用户回答 → `attempt+1` → 状态回 `pending`；上一个 run 的产出与 `partial_output_ref` 保留，**不把等待时间计入失败**，也不消耗重试上限之外的额外次数。
- `review` 与 `checker_work_item_id` 绑定：checker 不通过时**不得**直接 `succeeded`，按下条 maker-checker 规则处理。
- **maker-checker 循环（B2）**：`PASS` → step `succeeded` 并解锁下游；`FIX` → 新 attempt（`attempt+1`），checker 的 `comments` 放进下一 attempt 的 `attemptContext.comments`；`INPUT_REQUIRED` → `needs_input`。`fixRounds` 默认 2（可配置），超限 → 父任务 `needs_human`，不得无限循环。
- checker 用**独立会话**：上下文只含 `scope + diff + acceptance`，不含 maker 的推理轨迹与兄弟分支产物；只读，不占全局写闸。checker 自身 `infra` 失败按新 attempt 重试一次，不得记 maker 失败。
- checker 的 `PASS` 只证明"产物满足 acceptance"，**不等于 E3**；证据仍按 §3 / §6 的测试与 worktree 规则产生。

#### 5.9.8.1 黑板 / Phase B / L3 fanout 的边界约束

> 以下约束是 L3 黑板与 fanout 的前置条件；L1/L2 不实现黑板，但执行器与状态机必须先满足，否则后续并行化会把"记忆"当成正确性依赖。

1. **步终态写入必须在 session terminate 之后**：`work_steps` 的 `succeeded/failed/cancelled/timed_out` 只能在执行器确认会话结束、Phase B（会话结束后的记忆提取/写回）已执行或明确失败后落库。否则下一步可能在 Phase B 之前启动，读到未写完的记忆。
2. **Phase B 失败只影响记忆可见性，不影响正确性**：证据与验收只来自 `work_runs` + `node_evidence`；黑板/记忆写入失败不得回滚已完成的 run，也不得把 step 改回 `running`。UI 可提示"记忆未同步"，但状态机继续。
3. **L3 fanout 只保证任务边界快照，不保证兄弟步互见**：fanout 时每个子任务拿到的是边界时刻的任务快照（scope/acceptance/依赖）；兄弟步并发产生的中间黑板内容不承诺可见、也不作为合并依据。需要跨步共享的内容必须显式落 `work_runs` / 证据，而不是依赖黑板时序。
4. **上下文最小化**：不注入兄弟分支产物，不注入全图；`depsOutputs` 只含 step 声明引用的输出，按 `work_runs.outputs_json` 的引用解析，不复制全文。声明引用缺失 → `DEP_OUTPUT_MISSING`，step `failed(failure_class='infra')`，不得注入空对象冒充依赖。
5. **检索预算**：`HybridSearchEngine` top-k=5；不可用时降级 `getRecent(3)`；检索片段计入 waterline。
6. **水位线增量**：单步上下文增量 ≤800 tokens；超限先裁检索片段，再裁历史摘要，**不裁 scope / acceptance / 依赖声明**。

#### 5.9.8.2 黑板数据结构与 Phase B 接口（B3 施工）

**黑板（仅 L3 内存态，不落 SQLite）**：

```ts
interface BlackboardSnapshot {
  v: 1
  runId: string
  stepId: string
  boundaryAt: string   // fanout 边界时刻
  facts: Array<{ key: string; value: unknown; source: 'run' | 'evidence'; refId: string }>
  depsOutputs: Record<string, { outputRef: string; hash: string }>
  budget: { tokensUsed: number; maxTokens: 800 }
}
```

写入只允许 `PhaseBWriter.append(snapshot)`，同一 `runId+stepId` 幂等覆盖；跨进程不共享。

**Phase B 接口**：

```ts
interface PhaseB {
  extract(runId: string, stepId: string): Promise<{ facts: Fact[]; tokens: number }>
  write(snapshot: BlackboardSnapshot): Promise<{ ok: boolean; reason?: string }>
}
```

调用顺序：session terminate → `PhaseB.extract` → `PhaseB.write` → `completeStep` 落终态。`write` 失败只记 `memory_sync_failed`，不回滚 run、不改 step 状态。

**fanout 边界**：父任务按 §5.9.3 拆分后，每个子任务只读边界快照；兄弟产物不可见，合并只经 `work_runs.outputs_json` 与证据。`budget.maxTokens` 超限先裁 `facts`，不裁 `depsOutputs`；`depsOutputs` 引用缺失 → `DEP_OUTPUT_MISSING`。验收：Phase B 失败时 run 仍成功；兄弟分支互不可见；同一快照重复写入只保留 1 份。

#### 5.9.9 编排接口契约（B2）

所有编排动作只经 `WorkItemService` / `WorkRunService`；renderer 只能发命令（§9.2）。接口返回结构化错误码，不抛裸异常。

| 接口 | 输入 | 成功输出 | 失败分支 |
|---|---|---|---|
| `enqueue(workItemId, revision)` | 任务 id、目标 revision | `{runId, runSeq}` 或 `{queued:true, position}` | `GATE_INCOMPLETE`（写 `gate_missing_json`）；`DAG_CYCLE`（确认后计划被改坏，拒绝）；`REVISION_SUPERSEDED`（revision 已非 current）；`ALREADY_RUNNING`（同 lineage 已有 running）；`TIER_UNSUPPORTED`（无 Tier 1 候选） |
| `claimNext(projectPath)` | 项目根 | `{runId, stepId}` 或 `null` | `BUSY`：保持 `queued`，**不消耗 attempt**；`GATE_REVOKED`：转 `blocked`；`TIER_LOST`：转 `needs_human` |
| `startStep(runId, stepId)` | run、step | `{invocationId, sessionId?, threadId?}` | `APPROVAL_REQUIRED`：step 先落 `waiting_approval`；`ADAPTER_UNAVAILABLE`：step `paused(infra)`、run `failed(infra)`；`IDEMPOTENCY_CONFLICT`：返回既有 run |
| `completeStep(stepId, result)` | `{status, outputsJson?, partialOutputRef?, failureClass?}` | 迁移后的 step | `SESSION_NOT_TERMINATED`：拒绝写终态，保持 `running`；`OUTPUT_SCHEMA_INVALID`：降级 `output_parse='fallback'`，成功与否以真实结果为准 |
| `failStep(stepId, failureClass, error)` | 分类、可读原因、partial | `failed` step，并触发父任务聚合 | `INVALID_FAILURE_CLASS`（缺分类不落失败态）；partial 超限 → 截断并标 `truncated` |
| `cancelWorkItem(workItemId, reason)` | `user` / `deadline` / `shutdown` / `approval_denied` | `{cancelledRunIds[], downstreamCancelledIds[]}` | `ALREADY_TERMINAL`：幂等返回原终态；`PROCESS_KILL_FAILED`：**不写 `cancelled`**，写 `failed(failure_class='infra')` 并转 `needs_human` |
| `resumeWorkItem(workItemId, mode)` | `mode ∈ ('input','infra','retry')` | `{newRunId, attempt}` | `NOT_PAUSED` / `NOT_INTERRUPTED`；`GATE_INCOMPLETE`（恢复前重跑 gate）；`RUN_NOT_TERMINAL`（旧 run 未终态） |
| `recomputeAfterRun(runId)` | run | 无（内部） | 派生重算失败只写 `map_migration_reports(kind='derivation')`，不回滚 run |

**调度 tick（每 1 秒，单实例）**

1. 取 `queued` 项：`ORDER BY priority DESC, created_at ASC LIMIT 1`。
2. 重跑 gate（不信任确认时的结果）；不通过 → `blocked` + `gate_missing_json`。
3. 校验依赖：全部上游终态且成功；否则保持 `queued`，不 claim。
4. 路由：只接受 Tier 1；无候选 → `TIER_UNSUPPORTED`，保持 `queued`，写 `routing_failed` 事件。
5. 取写闸：项目被占用 → 本轮跳过，**不写 run、不加 attempt**。
6. 创建/claim run（走幂等键）→ `startStep`；失败按 §5.9.2 分类。

- 同一时刻只允许一个 tick 处理一个项目；并发上限按 §5.9.3。
- tick 内不得留下 `running` 孤儿：run 已 claim 但 step 未启动时，用条件更新 `running → queued`，不计 attempt。
- 所有错误码必须落 `work_runs.failure_class` 或 `work_item.gate_missing_json`，不得只写日志。

#### 5.9.10 路由与 Tier 能力票（B2）

**能力探测**

输入 `{adapter, adapterVersion}`；输出：

| 字段 | 取值 | 用途 |
|---|---|---|
| `tier` | 1 / 2 / 3 | 编排准入 |
| `resume` / `approval_callback` / `structured_output` / `cancel` | 0/1 | 能力明细 |
| `probe_error` | 可空 | 探测失败原因 |

判定：四项齐全 → Tier 1；缺 `approval_callback`（其余可用）→ Tier 2；其余 → Tier 3。**探测失败按 Tier 3 处理（fail-closed）**，不得默认 Tier 1。探测结果只在进程内按 `(adapter, adapterVersion)` 缓存；adapter 升级或探测失败即重探。

**路由算法（单 Agent，不做并行）**

1. 候选 = 已注册 adapter ∩ 满足 step 要求（写步骤要求 Tier 1 且 `approval_callback=1`）。
2. Tier 2 只允许只读步骤（分析、评审、候选推导）；Tier 3 不进候选。
3. 打分：`tier` 优先，其次历史成功率（无历史用默认值），平局按 `adapter` 名稳定排序。
4. 单候选也写 `routing_decisions`（`policy='single_agent'`）；人工指定 adapter 时 `policy='manual_override'`；Tier 2 只读审计时 `policy='tier2_audit'`。
5. 选中后先写一行 `routing_decisions`（`candidate_json` 含每个候选的 tier / gaps），再创建 run。

**失败分支**

| 情况 | 落点 |
|---|---|
| 无 Tier 1 候选 | 不建 run；`event:work-item-changed(reason='manual_session_required')`；任务保持 `queued` |
| 写步骤只有 Tier 2 可用 | 同上；**不得降级执行** |
| 探测失败 | 按 Tier 3；写 `routing_failed`，提示检查 adapter |
| run 中 adapter 不可用 | 当前 step `failed(failure_class='infra')`；不静默换 adapter；恢复走新 attempt |
| 人工覆盖到 Tier 2 的写步骤 | 直接拒绝 `TIER_UNSUPPORTED` |

#### 5.9.11 StepInput / StepResult 字段级契约（B2）

命名对齐：`taskId` → `work_item_id`；`stepId` → `work_steps.id`。

**StepInput**

```ts
interface StepInput {
  workItemId: string;            // 原 taskId
  revision: number;
  stepId: string;                // work_steps.id
  attempt: number;
  scope: { files: string[]; symbols: string[] };
  acceptance: string[];
  depsOutputRefs: Array<{ stepId: string; outputRef: string; summary: string }>; // 只注入声明引用
  attemptContext: {
    lastFailureClass?: string;
    lastPartialRef?: string;
    comments?: string[];         // checker FIX 评论
    userAnswer?: string;         // needs_input 回答
  };
  adapter: { name: string; tier: 1 | 2 | 3 };
  deadlineAt: number;
  outputSchemaRef: string;
}
```

- `depsOutputRefs` 只注入引用，不注入全文；解析失败 → `DEP_OUTPUT_MISSING`（§5.9.8.1）。
- `attemptContext` 只带上一 attempt 的结论，不回放历史对话。

**StepResult**

```ts
interface StepResult {
  status: 'succeeded' | 'failed' | 'needs_input' | 'timed_out' | 'cancelled';
  outputs?: Record<string, unknown>;
  outputParse: 'ok' | 'fallback';
  outputExtraKeys?: string[];
  partial?: {
    resultText?: string; resultFiles?: string[];
    fileChanges?: string[]; tokensUsed?: number; truncated?: boolean;
  };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  failureClass?: 'infra'|'busy'|'turn_fail'|'verify_fail'|'test_fail'|'env_fail'|'timeout'|'cancel'|'denied';
  verdict?: 'PASS' | 'FIX' | 'INPUT_REQUIRED';
  inputRequest?: { question: string; options?: string[]; default?: string; blocks: string[] };
}
```

**落库映射**

| 结果字段 | 落点 |
|---|---|
| `outputs` | `work_runs.outputs_json` |
| `outputExtraKeys` | `work_runs.output_extra_keys` |
| `partial` | `work_runs.partial_output_ref`（统一 JSON） |
| 文件变更 | `change_sets.files_json`（**不是** `outputs`） |
| `usage` | 既有 `agent_usage` 成本账本 |
| `failureClass` | `work_runs.failure_class` |
| `inputRequest` | `work_steps.input_request_json` |

- `outputs` 不得塞文件清单；文件一律走 `change_sets`，避免同一事实两套口径。
- `usage` 缺失写 NULL 并可计费告警，不得用 0 冒充"未消耗"。
- `status='failed'` 必须带 `failureClass`，缺失即 `INVALID_FAILURE_CLASS`；`status='cancelled'` 必须带 `cancel_reason`。

**M3 实施状态（2026-11-07）**

| 项 | 状态 | 说明 |
|---|---|---|
| 驱动真实 Agent turn 并落 run/step 终态（`completed` / `failed` / `cancelled` / `timeout`） | 已实施 | `src/main/map/agent-step-runner.ts`；终态写入在会话 terminate 之后、同一事务内条件更新 |
| `failureClass → work_runs.failure_class` | 已实施 | `agent_turns.failure_class` 经 `TurnOutcome.failureClass` 透出；v34 起同步写 `work_steps.failure_class`（同值域），步级失败不再只能 join 最近 run |
| deadline 路径 | 已实施 | `work_runs.deadline_at`（绝对）→ `AgentCommand.deadlineMs`（相对）；开跑前已过期直接 `timed_out`，不启动会话 |
| `needs_input` 回写 | 已实施 | `TurnOutcome` 已带 `needs_input` 信号；`agent-step-runner.ts:689` `finalizeNeedsInput` 写 `work_steps.input_request_json`，`work-item-service.ts:556` `markNeedsInput` / `:571` `settleNeedsInput` 与 `work-step-service.ts:306` `settleNeedsInput` 配合，人工确认后恢复。**更正（2026-11-08，W1）**：原标「未实施」属文档滞后 |
| `outputs` / `outputParse` / `partial` / `usage` / 文件变更 | 已实施 | 按 §5.9.7 分散落：`outputs→work_runs.outputs_json`、`outputParse→work_runs.output_parse`、`partial→work_runs.partial_output_ref`、文件变更→`change_sets.files_json`、`usage` 仍由 runtime 写 `agent_usage`（不重复写）。生产端 `agent-step-runner.ts` 的 `complete/fail/timeout` 透传（`parseStepOutputs:175`、`runOutputData:207`、`recordChangeHead:443`）；**未改** `agent_turns.output_json`；无 schema 不伪造空对象 |
| §5.9.10 Tier 能力探测与完整路由 | **明确偏离** | 仅 pinned adapter + `policy='manual_override'` 写 `routing_decisions`；Tier 探测推迟 |
| IPC / 外部触发入口 | 未接 | 执行器无可达入口，保持不可达 |
| kernel-only 发送契约 | 已实施 | `AgentManager.sendCommandKernelOnly`：runtime 缺失/执行器不在白名单/节点未挂载/driver 缺失一律抛错，不回落 legacy |
| item 级终态聚合（当前 revision 的步级） | 已实施 | `WorkItemService.convergeIfTerminal` + `WorkScheduler.claimNext`：无就绪步且全部步终态时收敛；仍有非终态步则等待。≥1 failed/timed_out → failed；否则有 cancelled → cancelled；全 succeeded/skipped → done |
| 依赖阻断级联 | 已实施 | `WorkStepService.blockUnstartedDependents`：上游 failed/timed_out/cancelled → 下游未开始步（仅 planning/pending）置 **failed + failure_class='blocked_by_dependency'**，沿依赖链 fixpoint 传递。v34 后已能区分人工跳过（`skip_reason`）与连带判负（`failure_class`），但仍不改回 skipped：`DEP_SATISFIED={succeeded,skipped}` 会把 skipped 当满足、聚合还会把全 skipped 收敛为 done，两处语义都得改才算等价。running/waiting_approval/review/needs_input/paused 一律不改 |
| 子 work_item（`parent_work_item_id`）聚合 | 已实施 | `work-item-service.ts:501` `convergeChildrenIfTerminal` + `:540` `convergeParentChain`：父任务在 `draft/awaiting_confirm/queued/running` 时可被子任务全终态带入终态，`needs_human/blocked/needs_input/paused/interrupted` 不覆盖；`failed > cancelled > done`（`superseded` 按 cancelled）；触发点 `transition:362` 与 `convergeIfTerminal:480`，`seen` 防环 + 条件 UPDATE 幂等。**绕过父任务 gate 为有意行为** |
| `partial_cancel` 取消原因落库 | 已实施（v34） | `work_items.cancel_reason`：聚合收敛为 cancelled 时写 `partial_cancel`；人工 `cancel()` / `resolveHuman(cancel)` 写 `user` |


---

## 6. TestExecutor

### 6.1 边界与复用声明

| 声明 | 原因 |
|---|---|
| 不复用 Agent 会话判定通过 | Agent 的"我认为通过了"不是执行证据；判定必须来自真实进程退出码与输出 |
| 不复用 `RecipeRunner` 的 shell 步骤 | `recipe-runner` 直接 `child_process.spawn`，绕过审批网关与 Bash 策略；复用等于开后门 |
| 复用 `evaluateBashPolicy` | 命令分级（只读/ask/deny）必须与 Agent 工具一致 |
| 复用 `evaluateGitDirWriteGuard` | 写 `.git` 一律 deny，fail-closed |
| 复用 `ApprovalGateway` | 审批事实、超时、审计、重启重推都已在网关内实现 |
| 新 worktree | 测试不在主工作区执行，避免污染与并发写 |

### 6.2 执行流程

```
1. 依据 work_item / test_specs 生成 test_plan（命令清单 + cwd + 基线 commit）
   - 基线 commit = 创建 worktree 时的 HEAD；
   - 主工作区的 dirty 状态只作诊断信息，**不进入执行集、不参与任何通过/证据判定**
2. 计算 plan_hash = sha256(规范化命令清单 + cwd + 基线 + 计划内容)
3. 走 ApprovalGateway 提交 subject_type='test_plan' 的一次性审批
4. 批准后由主进程受控 git 能力创建 worktree（不通过 Bash 工具）
   - worktree 固定 `git worktree add --detach <base_commit>`；**不应用主工作区 diff**
5. 逐条执行 test_plan_items：
     - evaluateBashPolicy 判定
     - evaluateGitDirWriteGuard 判定（命中即 deny）
     - cwd 固定为 worktree；超时 kill
6. 结果写 test_results；聚合写 test_runs
7. 执行结束后采集 worktree 的真实内容指纹（`HEAD^{tree}` + worktree 内未提交文件），证据回写按 §6.2.1：
   **执行后仍干净 + worktree 等于 base_commit + 全部命令通过 + 关联 work_run** 才写 E3；
   已真实执行但执行后 worktree 被改脏（或未关联 work_run）→ 只写 E2（内容绑定到实际执行内容）；
   零执行或取不到执行内容 → 不写任何证据（宁缺勿假）
8. 清理 worktree（保留失败现场 N 天，可配置）
```

#### 6.2.1 E3 判据与 E2 内容绑定（修复"假 E3"与"假 E2"）

**两类假证据**：

1. **假 E3**：worktree 从基线 commit 创建、`code_version` 也记基线 commit，而主工作区未提交改动不在 worktree 里，测试通过却被写成"可复现 E3"。
2. **假 E2（2026-11-07 修复）**：E2 内容绑定拿**主工作区脏文件哈希**当代理，但主工作区改动从未进入 worktree；且失败分支无论是否真的执行过都写 E2。结果"从未被执行到的代码"被绑定成 E2，节点被派生成 `implemented`。

**L1 执行集（已实施）**：worktree 固定 `git worktree add --detach <base_commit>`，**不应用主工作区 diff**；主工作区是否 dirty 与本次执行无关，不参与任何判定。

| 执行后状态 | 证据 |
|---|---|
| worktree 干净（`git status --porcelain -uall` 为空）+ 全部命令通过 + 关联 `work_run_id` | E3：`version_binding='commit'`、`code_version=base_commit`、`code_dirty=0`、`reproducible=1`；`ref_json.worktreeTree` = `HEAD^{tree}` |
| 已真实执行，但 worktree 内出现未提交文件（命令自己改出来的改动），或未关联 `work_run_id`，或测试未全过 | 只写 E2：`version_binding='content_hash'`、`current_hash=executedContentHash`、`code_dirty` 留空；`ref_json` 记录 `worktreeCommit`、`worktreeTree`、`executedContentHash`、`worktreeDirtyFiles`、`workspaceChangesIncluded=false` |
| 零执行（全 deny / 全 skip / 仅有 infra error） | **不写任何证据** |
| 取不到执行内容指纹（worktree 已删 / git 异常） | **不写任何证据** |

E2 的 `executedContentHash` 定义：worktree 干净时 = `HEAD^{tree}`；执行后 worktree 有未提交改动时 = `sha256(treeHash + "\n" + sorted(path + ':' + sha256(content)))`，其中 `path` 为规范化相对路径、删除/重命名旧路径按 `absent` 计入。这样 `current_hash` 描述的是**真正被执行的那份内容**，而不是主工作区或猜测值。

E3 必须同时满足：

1. 执行结束后 worktree `git status --porcelain` 为空（含未跟踪文件；`.gitignore` 忽略项不算）；
2. `worktree_commit == code_version`，且 worktree 中无额外未提交改动；
3. test_plan 内所有命令退出码为 0，无 `timed_out` / `error`；
4. 测试结果由本次 run 产生，未复用历史输出；
5. 计划关联了 `work_run_id`（E3 的 `work_run_id` 必填来源）。

任一条件不满足 → 不得写 E3；**确实执行过**时写 E2 `test_run` 事实，并保留失败分类与输出引用；零执行不写。**不允许"先记 E3、事后降级"来掩盖判据缺失。**

##### 6.2.1.1 历史错误 E2 的处理

旧口径写入的错误 E2 特征：`evidence_level='E2' AND evidence_type='test_run'`，`summary` 以 `测试事实(dirty 工作区` 开头（固定文案"不可复现"），`ref_json` 不含 `worktreeCommit`，`current_hash` 常为 NULL 或主工作区脏文件哈希。可用如下查询识别：

```sql
SELECT id, project_path, graph_id, node_entity_key, work_run_id, current_hash, created_at
  FROM node_evidence
 WHERE evidence_level = 'E2' AND evidence_type = 'test_run'
   AND revoked_at IS NULL
   AND ref_json NOT LIKE '%worktreeCommit%'
   AND summary LIKE '测试事实(dirty 工作区%';
```

**本轮决定：可识别，但不自动标记/改写。** 原因：

- 事后无法重建"当时真正被执行的内容"（worktree 失败现场最多保留 7 天，多数已删除；主工作区内容也已变化），任何自动重写都是新的猜测；
- 直接撤销会丢失一条真实的"测试跑过+结果"事实，并影响历史执行态审计；
- 仅改 `freshness` 不会改变派生规则（E2 未撤销即 `implemented`），反而制造"已标记但仍派生"的假象。

处理路径：把上述查询结果作为人工审计清单；对仍依赖这些 E2 的节点，用当前代码**重跑测试计划**产出正确 E2/E3（新证据 `ref_json` 带 `worktreeCommit`）。若确认某条旧 E2 完全不可信，由人通过 `EvidenceService.revoke(id, …, revoke_reason='legacy_dirty_proxy_evidence')` 显式撤销，撤销会自动触发派生重算。

> 说明：`§3.7.1` 中的 `content_hash` 对测试事实 (E2 `test_run`) 指本节的 git 内容指纹；对"变更清单/文件面"类 E2 仍指 `scope_files` 逐文件 sha256 聚合。两者都是内容绑定，但描述的物件不同。

#### 6.2.2 执行步骤接口、worktree 生命周期与失败分支（D 组施工）

| 接口 | 输入 | 输出 | 失败 |
|---|---|---|---|
| `createWorktree` | `{projectPath, baseCommit}` | `{worktreePath, baseCommit}` | `WORKTREE_FAILED`（`env_fail`，不建 bug） |
| `runStep` | `{planItemId, command, cwd, timeoutMs, envAllowlist}` | `{status, exitCode, durationMs, outputRef, failureClass}` | 超时 `timed_out`；spawn 异常 `error/infra`；策略 `denied` |
| `collectExecutionFingerprint` | `{worktreePath}` | `{worktreeCommit, worktreeTree, executedContentHash, dirtyFiles[]}` | 取不到 → 不写证据 |
| `cleanupWorktree` | `{worktreePath, keepOnFailure}` | `void` | 失败现场保留 7 天 |

状态机：`pending → running → (passed|failed|error|timed_out|cancelled)`；每个 item 独立超时（默认 60 分钟，可配置），超时 kill 进程组；`continue_on_failure=false` 时首败后其余 `skipped`。worktree 在 `finally` 清理，主工作区零写入。验收：A3/A4 用例 + 断言主工作区 `git status` 无变化、成功路径 worktree 目录最终不存在。

### 6.3 审批 subject 扩展

现状：`agent_approvals.run_id` / `turn_id` 为 `NOT NULL`，只表达"某个 turn 的工具调用"。

扩展方案：

```sql
run_id    TEXT,   -- 由 NOT NULL 放宽为可空
turn_id   TEXT,   -- 同上
subject_type TEXT NOT NULL DEFAULT 'agent_turn'
  CHECK(subject_type IN ('agent_turn','test_plan','work_item')),
subject_id   TEXT
```

- 一次性计划审批：`subject_type='test_plan'`，`subject_id=plan_id`，`tool_name='test.execute_plan'`，`args_json` 存规范化命令清单，`args_hash=plan_hash`。
- 重复使用条件：任何一条命令变更都会改变 `args_hash`；`args_hash` 不匹配即视为未审批，必须重新提交。
- 单条命令执行**逐条经过策略门**；`policy_decision='deny'` 的命令即使计划已批准也不执行（计划审批不能豁免 `deny`）。
- **`ask` 不因计划批准而免审（P0-3 行为变更，2026-11-07）**：计划审批只批准"计划本身"（命令清单 + `plan_hash`），不等于逐条命令已获批准。测试执行时，`evaluateBashPolicy` 判为 `ask` 的命令必须逐条经 `ApprovalGateway`（`subject_type='test_plan'`）放行；未获批准按 `deny` 处理（该条 `skipped` + 后续默认停止）。原口径"计划审批把 `ask` 提升为 `allow`"已废止。
- `execute()` 必须校验 `approval_id` 存在且指向 `subject_type='test_plan'`、`status='allowed'` 的审批行，并复算当前命令清单的 `plan_hash` 与批准时一致；不一致拒绝执行。
- 影响面：任何读取 `agent_approvals` 的查询需处理 `run_id/turn_id` 为空；重启重推逻辑需按 `subject_type` 分流，`test_plan` 未批准则计划作废（`expired`），不自动重放。
- 迁移方式见 §8 S8（该表需要重建，`NOT NULL` 无法用 `ALTER` 放宽）。

**不设独立 `test_approvals` 表（D6）**：测试计划审批统一写入 `agent_approvals`（`subject_type='test_plan'`），不另建一张审批表。理由：**两套审批事实会破坏审计单一来源** —— 一旦 `agent_approvals` 与 `test_approvals` 并存，"这次测试到底批准了没有"就要跨表对账，超时/撤销/重启重推也会出现两边状态不一致。审批只有一个入口、一张表、一套超时与撤销语义。

#### 6.3.1 建表迁移、subject 取值与回调幂等（D 组施工）

迁移（S8 内）：`BEGIN IMMEDIATE` → 建 `agent_approvals_new`（`run_id/turn_id` 可空、`subject_type` 默认 `agent_turn`）→ 全量拷贝并回填 `subject_id=COALESCE(turn_id,'')` → 校验行数一致 → drop 旧表/rename → 重建索引 → `COMMIT`；失败整体回滚，保留 `_backup` 与 `map_migration_reports`。重启时 `test_plan` 未批准一律置 `expired`，不自动重放。

幂等：`test:plan:approve` 以 `plan_id + args_hash` 为键，已存在 `pending/allowed` 返回既有 `approvalId`；同 `approvalId` 重复 `allow/deny` 返回首次结果，不同决策抛 `APPROVAL_CONFLICT`；超时后一律 deny。验收：迁移前后行数一致且旧行 `subject_id` 正确；重复批准不增行；`args_hash` 变化 → `HASH_MISMATCH`。

### 6.4 安全约束

- `evaluateBashPolicy` 与 `evaluateGitDirWriteGuard` 在 TestExecutor 内**逐条调用**，不可批处理跳过。
- worktree 创建走主进程 git 能力（既有受控路径），不暴露给模型，也不由 Bash 工具执行。
- 测试命令环境变量白名单化，不注入 session grants（会话级授权是内存态，重启即失，不可复用为测试授权）。
- 不启用 `unattended` 分支；计划级审批超时即作废。
- 测试输出可能含敏感信息：落盘时按现有 artifact 策略处理，`output_ref` 只存路径与 hash。

#### 6.4.1 执行前检查与 fail-closed 验收（D 组施工）

逐条命令在 spawn 前执行：① `cwd` realpath 必须位于 worktree 内且不含 `..` 逃逸，否则 `deny`；② `evaluateGitDirWriteGuard` 对命令、参数、重定向目标全量匹配，命中 `.git` 写即 `deny`，不因计划已批准豁免；③ 环境变量仅注入白名单 `PATH/HOME/TMPDIR/NODE_ENV/CI`，剔除 `*_TOKEN/*_KEY/AWS_*/GITHUB_*`；④ 输出落盘前按 `sk-|ghp_|AKIA|Bearer ` 正则脱敏，`output_ref` 只存路径+hash；⑤ 不使用 `unattended`，审批超时作废。任一检查异常按 deny 处理（fail-closed）。验收：`../` 逃逸、`.git` 写、注入 token、超时未批四类各一条拒绝用例；输出文件不含密钥。

### 6.5 测试资产与结果回写

- 测试资产 = test 图节点（`test-suite` / `test-case`），通过 `node_links` 的 `verifies`（→ dev）与 `covers`（→ online）建立关联。
- `test_specs` 绑定 `test-case` 节点，一个节点可有多个 spec（不同命令/环境）。
- 结果回写：`test_results` → 命中 `verifies` 目标节点的 **E3** 证据（测试通过 + 代码 hash）；`test_runs` 聚合 → `node_execution_state` 重算。
- 写证据的前提是**有真实执行**：零执行（全 deny / 全 skip / 仅有 infra error）或取不到执行内容指纹时不写 E2/E3；证据内容一律绑定 worktree 实际执行内容，主工作区 dirty 不作代理（§6.2.1）。
- 失败的测试产生 E3 的反向事实（`status='failed'`），派生状态为 `failed`，但**不自动把 `nodes.status` 打回**。

#### 6.5.1 流程级测试（flow）的可执行定义

`test_specs.kind='flow'` 不是"一段描述"，而是**可执行序列**：

- 一个 flow spec 由有序的 `steps_json` 组成，每步引用一个 `test-case` 节点/子 spec，且有明确的命令、`cwd`、超时；
- 每步单独写一条 `test_results`；flow 聚合结果写 `test_runs`，**全部步骤通过才算 flow 通过**，任一步失败/超时则失败，后续步骤默认 `skipped`（可选 `continue_on_failure=false`）；
- flow 内不允许 `manual` / `llm_acceptance` 步骤（人工与 LLM 判定不能混进自动化通过链）；这类步骤必须作为独立用例走 E4/E2；
- flow 的 `plan_hash` 包含步骤顺序与每步命令，顺序变化即视为未审批；
- **范围（已定）**：流程级测试从 **L2 起做最小版**：框选子图 → 每个节点生成一个验证步 + 一个 shell 测试步 → 产出 `test_report`。**不做可视化编排**（拖拽排序、分支/并行编辑器属 L3）；L1 仍只做节点级测试。

##### 6.5.1.1 flow 最小版执行契约（B2）

**输入**：框选子图 `{graphId, nodeEntityKeys[]}`，节点必须属于 dev 图；每个节点读取 `verifies` 链接到 test-case。

**生成**

1. 校验选择集连通且无环；有环 → `SUBTREE_CYCLE`，拒绝生成计划。
2. 按 `edges` 依赖做拓扑排序；无依赖时按框选顺序。
3. 每个节点生成两步：`verify`（运行其 `verifies` 的 test-case spec）+ `shell`（该节点绑定的测试命令；无绑定 → `MISSING_TEST_COMMAND`）。
4. 写入 `test_specs(kind='flow')`，`steps_json` 固化顺序与命令；`plan_hash` 走 §6.3 审批。

**执行与产物**

- 一个 `test_runs(kind='flow')`；每步一条 `test_results`。
- 任一步 `failed` / `timed_out` / `denied` → flow `failed`，后续 `skipped`；`continue_on_failure` 默认 false；不自动重跑。
- 产出 `test_report`（JSON）：`{flow_run_id, overall, nodes:[{node_entity_key, verify:{status,result_ids[]}, shell:{status,result_ids[]}}]}`，落 `test_runs.report_ref`。
- 执行后 worktree 仍干净且命令通过（且有 `work_run_id`）→ 对目标节点写 E3；已真实执行但执行后被改脏/未关联 run → 只写 E2；零执行不写证据（§6.2.1）。
- `manual` / `llm_acceptance` 不得进 flow（§6.5.1）。

**不做**：拖拽排序、分支/并行编辑、可视化 DAG；改顺序 = 重新生成计划并重新审批。

#### 6.5.2 `published` 软阻断（测试资产）

test 图节点允许 `draft → confirmed → published`。`published` 增加一条**软阻断**：

- 没有任何通过记录（E3 或至少一条 `test_runs.status='passed'`）时，默认按钮不得是"发布"；
- 用户仍可显式确认发布，但必须填写理由并落库（`nodes.published_waiver_json`，v39 可空列：`{by, at, reason, missing}`）；
- 这是**软阻断，不是硬拒绝**：不阻止人工标记 `published`，只影响徽标与统计口径 —— 无通过记录的发布在叠加层显示"未验证发布"徽标，并计入 `published_without_evidence`（单列，不计入"已验证资产"）；不采用强制测试或二次确认。

**与 G2 gate waiver 的区别（不得混用）**：本节的发布豁免只写 `nodes.published_waiver_json`，不写 `work_items.gate_status/gate_waived_*`，也不改变任务 gate 判定；gate waiver 仍由 `agent_approvals` 与 `work_items` 侧独立管理。II-15 旧稿的 gate 软阻断路线已作废。

##### 6.5.2.1 `published` 判定、徽标与回滚（B2）

- `has_pass_evidence`：test-case 节点经 `test_specs.test_node_entity_key` 关联执行记录（`test_results`/`test_runs`），存在未撤销 E3 或至少一条 passed；**不能直接查 test-case 节点自身证据**。
- `published` 且 `has_pass_evidence=0` → `published_without_evidence` 计数 +1，叠加层显示"未验证发布"；不计入"已验证资产"。
- 人工发布必须写 `published_waiver_json={by, at, reason, missing[]}`；缺任一字段 → `node:update` 拒绝写入并返回 `PUBLISHED_WAIVER_REQUIRED`。
- 不做强制测试、不做二次确认；默认按钮可以是"先测试"，但**不得隐藏"仍然发布"入口**。
- 已实施（v39）：`src/main/map/published-guard.ts`；只读统计 `map:published:status`。
- 回滚：`published → confirmed` 只改 `nodes.status` 与徽标；**不删除** `test_results` / 证据行。再次发布重新计算 `has_pass_evidence`。
- 发布后测试失败：`nodes.status` 保持 `published`（人工状态不被自动改写），徽标追加"最近测试失败"；`published_without_evidence` 按当前证据重算。

#### 6.5.3 资产创建/更新、回写事务与失败重试（D 组施工）

- 资产：仅 `test-case` 节点可建 `test_specs`；`kind IN ('unit','integration','e2e','flow')`，`command/cwd/timeout_ms` 必填；更新 spec 生成新 revision 并使既有 `plan_hash` 失效（需重新审批）。
- 回写事务：`INSERT test_results` → 聚合 `test_runs`（计数/终态）→ 按 §6.2.1 写 E3/E2 → 标记派生重算，单事务提交；证据写入失败不回滚测试结果，`test_runs` 记 `evidence_write_failed`。
- 重试：仅重试证据写入，键 `(test_run_id, target_node_entity_key, evidence_type)`，最多 3 次、指数退避；命令本身不自动重跑。验收：零执行不写证据；重复回写只 1 行；证据失败后重试成功可补写且不重复。

### 6.6 Bug 闭环与定向重测（采纳）

外部蓝图给出了完整的失败→bug→修复→定向重测链路，我们此前只到"回写失败"为止。补齐如下：

1. **测试失败 → 自动建 bug**：在 dev 图 `bug_nodes` 新建一条，`title` = 失败用例名，`severity` 映射：阻断性失败 → `critical`；普通断言失败 → `major`；非功能性/文案 → `minor`。`metadata` 记录 `{test_run_id, test_case_ref, verifies_entity_key, failure_class}`。
2. **不建 bug 的例外**：`env_fail`（缺依赖/端口占用/编译环境）只记 `test_runs.failure_class`，不建 bug；否则会污染缺陷统计。
3. **bug → 修复任务**：bug 节点自动生成一个 `work_item`（`anchor_entity_key` = 被验证的 dev 实体，`origin='derived_plan'`），仍需 C2 确认后执行。
4. **定向重测**：修复完成后只重跑失败用例与同 suite 的相关用例（`test_plan_items.selected_by='targeted'`），不全量重跑；全量重跑是独立动作，需人触发。
5. **回写闭环**：定向重测通过 → 新 E3 证据（新 commit）→ bug 节点 `retested_at` + `verified_by_run_id`；bug 的关闭仍由人确认（`bug_nodes.status` 人工写），系统只给建议。
6. **证据链**：bug 行必须能反查到 `test_run` → `test_result` → 失败输出；缺任一环不允许标"已修复"。

#### 6.6.1 bug 创建、定向重测与回写契约（D 组施工）

| 步骤 | 接口/落点 | 幂等与边界 |
|---|---|---|
| 失败建 bug | `bug_nodes` + `metadata.source_result_id`；`critical/major/minor` 映射 | 同一 `source_result_id` 只建一次；`env_fail` 不建 |
| bug→修复任务 | `work_item(origin='derived_plan', anchor=dev 实体)` | 仍需 C2 确认，不自动执行 |
| 定向重测 | `test_plan_items.selected_by='targeted'`，含失败用例 + 同 suite | 不全量重跑；全量需人触发 |
| 回写 | 新 E3 → `bug_nodes.retested_at/verified_by_run_id`；`verifies` 链接 | 缺 `run→result→output` 任一环不得标“已修复” |
| 关闭 | `bug_nodes.status` 仅人工写 | 系统只给建议 |

验收：断言失败建 1 条 bug、`env_fail` 不建；定向计划只含目标用例；重测通过后 bug 仍待人工关闭。

### 6.7 手工用例与"人工验收型测试"（采纳，归 E4）

- `test-case` 节点 `metadata.case_kind` 取：`unit` / `integration` / `e2e` / `manual` / `llm_acceptance`（放在 `metadata` 里，不新增 `nodes` 列，避免再次触发 CHECK 重建）。
- `unit/integration/e2e` → 可产生 E3（命令 + 退出码 + 代码 hash）。
- `manual` → **不产生 E3**；执行时创建 `work_run(executor_kind='human')`，完成后进入 E4 签收流程（§3.5），标注"人工验收，无代码 hash、不可复现"。
- `llm_acceptance` → 只产生 E2 或 `evidence_suggestion`；**LLM 判定不得直接成为 E3/E4**，必须有人工确认或真实测试命令。
- 外部蓝图的"review gate（LLM 验收 + diff 接受 + 人工确认）"因此**降级映射**：LLM 部分 → E2 建议；人工确认部分 → E4；只有测试命令通过 + 代码 hash 才是 E3。

#### 6.7.1 手工执行记录与 E4 签收入口（D 组施工）

- `metadata.case_kind` 读取时校验枚举；`manual` 执行创建 `work_run(executor_kind='human')`，状态 `running → awaiting_confirm`，完成后必须走 E4（`coverage_json` 覆盖该用例 `acceptance_ids`），**不得写 E3**。
- `llm_acceptance` 只产 E2 或建议，`produced_by='system'`；LLM 结论不得直接写 E3/E4。
- 边界：`manual` 缺覆盖范围拒绝签收；`llm_acceptance` 试图写 E3/E4 拒绝；手工记录不参与 `verified` 统计。验收：三类 `case_kind` 各一条写入路径用例 + 对应拒绝用例。

### 6.8 测试命令网关与归属校验（采纳）

- 统一命名 `TestCommandGateway`：所有测试相关 shell 步骤必须经过它；**禁止复用 `RecipeRunner` 的 shell 步骤**，禁止任何旁路 `child_process.spawn`。
- 每次执行前校验：`work_item.graph_id` 与目标节点所属图一致；`test_specs.project_path` 与当前项目根一致；不属于当前会话/图的计划一律拒绝。
- 跨会话的 `pending approvals` 必须按 `subject ownership` 过滤，不能把 A 项目的测试计划审批展示给 B 项目。
- `recipes:run` 的 IPC 入口必须补归属校验（现有实现可被任意工程触发）。

#### 6.8.1 allow-list 纪律（新增规则）

每扩展一条 allow 类测试命令，必须同时补一条测试，断言"该命令消费了哪些配置键"，并写进本网关的测试清单：

- 例：`npm test` 必须断言读取了 `package.json`（`scripts`、`workspaces`）、`.npmrc`（registry/鉴权）、`NODE_ENV`、`tsconfig`（若命令走 `tsc`）；`pytest` 必须断言 `pytest.ini` / `pyproject.toml` / 环境变量白名单。
- 测试要能在"配置键清单变化"时失败（例如新增读取 `.env` 或 `~/.npmrc` 未列入白名单），而不是只验证命令能跑通。
- 未补该测试的 allow 命令不得合入；这防止测试命令在无人注意时读取配置中的凭据或改变行为。

#### 6.8.2 测试执行网关接口契约（B2）

| 接口 | 输入 | 输出 | 失败分支 |
|---|---|---|---|
| `test:plan:create` | `{workItemId, graphId, projectPath, specIds[]}` | `{planId, planHash, items[]}` | `OWNERSHIP_MISMATCH`；`SPEC_NOT_EXECUTABLE`（含 manual 步骤）；`NO_COMMANDS` |
| `test:plan:approve` | `{planId}` | `{approvalId, expiresAt}` | `HASH_MISMATCH`；`APPROVAL_PENDING`（幂等返回既有） |
| `test:plan:run` | `{planId}` | `{testRunId}` | `NOT_APPROVED` / `APPROVAL_EXPIRED`；`HASH_MISMATCH`；`CONCURRENT_TEST`（A3 串行）；`WORKTREE_FAILED`（`env_fail`，不建 bug） |
| `test:run:get` | `{testRunId}` | 结果与步骤状态 | 只读，无失败分支 |

执行顺序：逐条 `evaluateBashPolicy` → `evaluateGitDirWriteGuard` → `ask` 命令经 `ApprovalGateway` 逐条放行 → 以 worktree 为 `cwd` 执行 → 写 `test_results` → 聚合 `test_runs`。`policy_decision='deny'` 的命令即使计划已批准也不执行，写 `denied` 结果；`ask` 命令未获网关批准同样按 `deny` 处理（P0-3：计划审批不提升 `ask`）。计划其余命令默认停止（`continue_on_failure=false`，后续 `skipped`）。每条命令超时独立（默认 60 分钟，可配置），超时即 `timed_out`。

---

## 7. 字段级表结构

> 所有新增表使用 TEXT 时间戳（ISO）以与既有表一致；`agent_*` 相关表使用 INTEGER 毫秒时间戳以与既有 Agent Runtime 一致。以下按各自归属标注。

### 7.1 既有表变更（DDL diff）

#### `graphs`

```sql
type TEXT NOT NULL CHECK(type IN ('online','dev','test'))
-- v24 已补进 createSql（否则表重建会重置用户"关闭写回"设置）：
writeback_disabled INTEGER DEFAULT 0
```

S1 不新增图列：重复导入靠 `project_fingerprints` 在写图之前拦截，不需要 lineage 分组列。

#### `nodes`

```sql
type TEXT NOT NULL CHECK(type IN (
  'project','module','process','feature','bug','wiki-page',
  'test-suite','test-case'))
graph_type TEXT NOT NULL CHECK(graph_type IN ('online','dev','test'))
entity_key TEXT                      -- 可空；不进 requiredColumns
lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK(lifecycle_state IN ('active','archived','merged','split'))
published_waiver_json TEXT           -- v39 / G2-13：测试资产发布豁免；可空，不进 requiredColumns
```

#### `edges`

```sql
edge_type TEXT CHECK(edge_type IN (
  'default','success','failure','condition','business-flow','semantic',
  'dependency','co-change','wiki-link','hierarchical',
  'verifies','covers'))
updated_at TEXT                      -- 补进 createSql，避免重建丢值
```

#### `agent_approvals`

```sql
run_id TEXT                          -- 原 NOT NULL → 可空
turn_id TEXT                         -- 原 NOT NULL → 可空
subject_type TEXT NOT NULL DEFAULT 'agent_turn'
  CHECK(subject_type IN ('agent_turn','test_plan','work_item'))
subject_id TEXT
-- 回填：UPDATE agent_approvals SET subject_id = turn_id WHERE subject_id IS NULL
```

**不新增 `test_approvals` 表（D6）**：测试计划审批复用本表的 `subject_type='test_plan'`；独立审批表会造成两套审批事实与审计分裂，理由见 §6.3。

**语义边界（v35）**：本表只承载**工具的调用审批**（一次 `tool_name` + `args_json` 的放行/拒绝），不得写入“人工验收确认”这类非工具事实。后者落 `acceptance_confirmations`（§M5.12）；`9852b77` 的 `tool_name='acceptance_manual_confirm'` 写法已废止，存量行由 v35 迁移搬走。

### 7.2 新增表

#### `node_links`

```sql
CREATE TABLE node_links (
  id              TEXT PRIMARY KEY,
  project_path    TEXT NOT NULL,
  from_entity_key TEXT NOT NULL,
  from_graph_id   TEXT NOT NULL,
  from_graph_type TEXT NOT NULL CHECK(from_graph_type IN ('online','dev','test')),
  from_node_id    TEXT,
  to_entity_key   TEXT NOT NULL,
  to_graph_id     TEXT NOT NULL,
  to_graph_type   TEXT NOT NULL CHECK(to_graph_type IN ('online','dev','test')),
  to_node_id      TEXT,
  link_type       TEXT NOT NULL CHECK(link_type IN (
    'derives_from','implements','verifies','covers','depends_on',
    'split_from','merged_into','supersedes','relates_to')),
  direction       TEXT NOT NULL DEFAULT 'directed'
                  CHECK(direction IN ('directed','symmetric')),
  confidence      REAL NOT NULL DEFAULT 1.0,
  origin          TEXT NOT NULL CHECK(origin IN ('human','derived','import')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','stale','orphan')),
  reason          TEXT,
  metadata        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(from_graph_id, to_graph_id, from_entity_key, to_entity_key, link_type)
);

CREATE INDEX idx_node_links_from     ON node_links(from_entity_key);
CREATE INDEX idx_node_links_to       ON node_links(to_entity_key);
CREATE INDEX idx_node_links_project  ON node_links(project_path, status);
CREATE INDEX idx_node_links_from_node ON node_links(from_node_id);
CREATE INDEX idx_node_links_to_node   ON node_links(to_node_id);
```

#### `project_fingerprints`（S1，导入查重）

```sql
CREATE TABLE project_fingerprints (
  id                TEXT PRIMARY KEY,
  project_name      TEXT,
  dir_name          TEXT NOT NULL,
  root_path         TEXT NOT NULL,
  last_modified_at  INTEGER,
  sample_files_json TEXT NOT NULL,
  sample_count      INTEGER NOT NULL,
  signature_hash    TEXT,
  graph_ids_json    TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  UNIQUE(root_path)
);

CREATE INDEX idx_project_fingerprints_dir ON project_fingerprints(dir_name);
```

#### `import_rejections`（S1，导入决策记录）

> 表名沿用"拒绝"语义，但同时记录 `allowed_branch` / `allowed_with_warning` 两类放行决策，便于审计"为什么这次允许了"。

```sql
CREATE TABLE import_rejections (
  id                     TEXT PRIMARY KEY,
  attempted_root_path    TEXT NOT NULL,
  attempted_name         TEXT,
  attempted_dir_name     TEXT,
  matched_fingerprint_id TEXT,
  matched_signals_json   TEXT NOT NULL,
  decision               TEXT NOT NULL CHECK(decision IN (
    'rejected','allowed_branch','allowed_with_warning')),
  allowance_source       TEXT CHECK(allowance_source IN ('this_time','remembered_rule')),
  reason                 TEXT,
  created_at             TEXT NOT NULL
);

CREATE INDEX idx_import_rejections_time ON import_rejections(created_at);

-- 记住的分支/副本放行规则（默认不产生；仅用户主动勾选"对同一指纹记住"时写入）
CREATE TABLE import_allowances (
  id              TEXT PRIMARY KEY,
  fingerprint_id  TEXT NOT NULL REFERENCES project_fingerprints(id) ON DELETE CASCADE,
  dir_name        TEXT NOT NULL,
  granted_by      TEXT NOT NULL,
  granted_at      TEXT NOT NULL,
  note            TEXT,
  revoked_at      TEXT,
  revoked_by      TEXT,
  UNIQUE(fingerprint_id, dir_name)
);

CREATE INDEX idx_import_allowances_fp ON import_allowances(fingerprint_id);
```

- 拒绝/放行明细留存 **90 天**；聚合计数写 `map_migration_reports.kind='import_dedup'`，**永久保留**。
- `import_allowances` 不随 90 天清理，保留至用户撤销；撤销后保留 `revoked_at` 审计痕迹。
- 命中记住规则时，`import_rejections.allowance_source='remembered_rule'`，证据面板必须显示"本次放行来自记住的规则"。

#### `node_evidence`

```sql
CREATE TABLE node_evidence (
  id               TEXT PRIMARY KEY,
  project_path     TEXT,
  graph_id         TEXT NOT NULL,
  graph_type       TEXT NOT NULL CHECK(graph_type IN ('online','dev','test')),
  node_entity_key  TEXT NOT NULL,
  node_id          TEXT,
  evidence_level   TEXT NOT NULL CHECK(evidence_level IN ('E1','E2','E3','E4')),
  evidence_type    TEXT NOT NULL CHECK(evidence_type IN (
    'changed_files','commit','test_run','session_turn',
    'artifact','human_confirm','runtime_observation')),
  ref_json         TEXT NOT NULL,
  summary          TEXT,
  version_binding  TEXT NOT NULL DEFAULT 'commit'
                   CHECK(version_binding IN ('commit','content_hash','snapshot','none')),
                   -- E3 只认 'commit'（git 代码 hash）；E4 必须 'none'
                   -- 'content_hash'/'snapshot' 仅用于 E2 文件级证据与 stale 辅助，不构成 E3
  code_version     TEXT,
  code_dirty       INTEGER,
  base_hash        TEXT,
  current_hash     TEXT,
  freshness        TEXT NOT NULL DEFAULT 'fresh'
                   CHECK(freshness IN ('fresh','stale','unknown')),
  produced_by      TEXT NOT NULL
                   CHECK(produced_by IN ('human','agent','test_executor','system')),
  work_item_id     TEXT,
  work_run_id      TEXT,
  session_id       TEXT,
  turn_id          TEXT,
  created_at       TEXT NOT NULL,
  verified_at      TEXT,
  stale_at         TEXT,
  -- E4 人工签收（§3.5）：无代码 hash、不可复现
  signed_by               TEXT,   -- 本地用户标识
  signed_by_display_name  TEXT,   -- 可选显示名
  signed_at               TEXT,
  coverage_json           TEXT,
  basis_ref_json          TEXT,
  reproducible            INTEGER, -- 冗余派生：E3=1；E4=0（用于分组统计）
  expires_at       TEXT,
  renewed_from_evidence_id TEXT, -- 一键续签引用的原 E4 证据
  revoked_at       TEXT,
  revoked_by       TEXT,
  revoke_reason    TEXT,
  -- E3 的字段级硬约束：缺任一条件都不能落成 E3（应用层还要校验测试与工作区状态）
  CHECK (evidence_level <> 'E3' OR (
    version_binding = 'commit'
    AND code_version IS NOT NULL
    AND code_dirty = 0
    AND reproducible = 1
  )),
  -- E4 的字段级硬约束：人工签收、无代码 hash、不可复现
  CHECK (evidence_level <> 'E4' OR (
    version_binding = 'none'
    AND code_version IS NULL
    AND reproducible = 0
    AND signed_by IS NOT NULL
    AND signed_at IS NOT NULL
    AND coverage_json IS NOT NULL
  ))
);

CREATE INDEX idx_node_evidence_node    ON node_evidence(graph_id, node_entity_key);
CREATE INDEX idx_node_evidence_level   ON node_evidence(evidence_level, freshness);
CREATE INDEX idx_node_evidence_run     ON node_evidence(work_run_id);
-- 同一 run 对同一节点产出的同类证据只落一条（重试幂等）；E4 人工签收不在此约束内
CREATE UNIQUE INDEX ux_node_evidence_run_type
  ON node_evidence(graph_id, work_run_id, evidence_type, node_entity_key)
  WHERE work_run_id IS NOT NULL AND evidence_level IN ('E2','E3');
```

未存 E0：证据缺失即 E0。

#### `evidence_suggestions`

```sql
CREATE TABLE evidence_suggestions (
  id               TEXT PRIMARY KEY,
  project_path     TEXT,
  graph_id         TEXT NOT NULL,
  node_entity_key  TEXT NOT NULL,
  node_id          TEXT,
  suggested_level  TEXT NOT NULL CHECK(suggested_level IN ('E1','E2','E3','E4')),
  evidence_type    TEXT NOT NULL,
  ref_json         TEXT NOT NULL,
  rationale        TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 0.5,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','accepted','dismissed')),
  produced_by_run_id TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  resolved_by      TEXT
);

CREATE INDEX idx_evidence_suggestions_status ON evidence_suggestions(graph_id, status);
```

#### `node_execution_state`（派生缓存，可整表重建）

```sql
CREATE TABLE node_execution_state (
  graph_id           TEXT NOT NULL,
  node_entity_key    TEXT NOT NULL,
  execution_state    TEXT NOT NULL CHECK(execution_state IN (
    'untouched','planned','in_progress','implemented',
    'verified','signed_off','failed','blocked','stale')),
  evidence_level     TEXT NOT NULL CHECK(evidence_level IN ('E0','E1','E2','E3','E4')),
  is_reproducible    INTEGER,  -- E3=1；E4=0；E0/E1/E2=NULL（不写 0，§3.7.4）
  evidence_count     INTEGER NOT NULL DEFAULT 0,
  stale_count        INTEGER NOT NULL DEFAULT 0,
  derivation_version INTEGER NOT NULL DEFAULT 1,
  inputs_hash        TEXT,
  computed_at        INTEGER NOT NULL,
  PRIMARY KEY (graph_id, node_entity_key)
);

CREATE INDEX idx_node_execution_state_value ON node_execution_state(execution_state);
```

#### `work_items`

```sql
CREATE TABLE work_items (
  id                   TEXT PRIMARY KEY,
  lineage_id           TEXT NOT NULL,
  revision             INTEGER NOT NULL DEFAULT 1,
  supersedes_id        TEXT,
  is_current           INTEGER NOT NULL DEFAULT 1,
  project_path         TEXT,
  graph_id             TEXT NOT NULL,
  anchor_entity_key    TEXT,
  anchor_node_id       TEXT,
  parent_work_item_id  TEXT REFERENCES work_items(id),
  depth                INTEGER NOT NULL DEFAULT 0,
  title                TEXT NOT NULL,
  goal                 TEXT,
  scope_files          TEXT NOT NULL DEFAULT '[]',
  out_of_scope_files   TEXT,
  acceptance_json      TEXT NOT NULL DEFAULT '[]',
  verification_hint    TEXT,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
    'draft','awaiting_confirm','queued','running','blocked',
    'needs_input','needs_human','paused','interrupted',
    'done','failed','cancelled','superseded')),
  cancel_reason        TEXT,                          -- v34: user | partial_cancel
  gate_status          TEXT NOT NULL DEFAULT 'incomplete'
                       CHECK(gate_status IN ('incomplete','pass','waived')),
  gate_missing_json    TEXT,
  gate_waived_by       TEXT,                          -- G2 manual 豁免人（仅 waived 时有值）
  gate_waived_at       INTEGER,
  gate_waive_reason    TEXT,                          -- 豁免理由，必填于 waived
  depends_on_json      TEXT NOT NULL DEFAULT '[]',   -- 上游 work_item id 列表
  origin               TEXT NOT NULL CHECK(origin IN ('human','derived_plan','imported')),
  plan_id              TEXT,
  candidate_id         TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  archived_at          TEXT,
  UNIQUE(lineage_id, revision)
);

CREATE UNIQUE INDEX ux_work_items_current ON work_items(lineage_id) WHERE is_current = 1;
CREATE INDEX idx_work_items_graph  ON work_items(graph_id, status);
CREATE INDEX idx_work_items_anchor ON work_items(graph_id, anchor_entity_key);
CREATE INDEX idx_work_items_parent ON work_items(parent_work_item_id);
```

#### `work_steps`

```sql
CREATE TABLE work_steps (
  id                   TEXT PRIMARY KEY,
  work_item_id         TEXT NOT NULL REFERENCES work_items(id),
  work_item_revision   INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,
  title                TEXT NOT NULL,
  step_kind            TEXT NOT NULL CHECK(step_kind IN ('agent','test','human')),
  scope_files_json     TEXT NOT NULL DEFAULT '[]',
  depends_on_step_ids_json TEXT,
  output_schema_json   TEXT,              -- 结构化输出契约（步级）
  consults_json        TEXT,              -- 需要咨询/评审的上游项
  checker_work_item_id TEXT REFERENCES work_items(id), -- maker-checker 审查项
  deadline_at          INTEGER,           -- 步级截止时间（调度器写入）
  attempt              INTEGER NOT NULL DEFAULT 1,
  invocation_id        TEXT,              -- 执行器调用号
  input_request_json   TEXT,              -- needs_input 问题卡
  status               TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'planning','pending','waiting_approval','running','review',
    'needs_input','paused','succeeded','failed','timed_out',
    'cancelled','skipped')),
  skip_reason          TEXT,              -- v34: condition_unmet | optional_not_required | human
  failure_class        TEXT,              -- v34: work_runs 同值域 + blocked_by_dependency
  started_at           INTEGER,
  ended_at             INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(work_item_id, work_item_revision, seq)
);

CREATE INDEX idx_work_steps_item   ON work_steps(work_item_id, work_item_revision, seq);
CREATE INDEX idx_work_steps_status ON work_steps(status);
```

- 编排步专属字段只在此表；`work_items` 不复制这些列。
- S5 建表时一次写死全部 `status` 值，避免后续重建。
- v34 的 `skip_reason` / `failure_class` / `cancel_reason` 是**纯加列**：写在 `createSql` 但不进 `requiredColumns`，存量库由 `runIncrementalMigrations` 用 `ALTER TABLE ADD COLUMN` 补齐，不触发表重建。

#### `work_runs`

```sql
CREATE TABLE work_runs (
  id                   TEXT PRIMARY KEY,
  work_item_id         TEXT NOT NULL REFERENCES work_items(id),
  work_item_lineage_id TEXT NOT NULL,
  work_item_revision   INTEGER NOT NULL,
  step_id              TEXT REFERENCES work_steps(id),
  run_seq              INTEGER NOT NULL,
  attempt              INTEGER NOT NULL DEFAULT 1,
  idempotency_key      TEXT NOT NULL,   -- lineage:revision:step_seq:attempt
  executor_kind        TEXT NOT NULL CHECK(executor_kind IN ('agent','test','human')),
  adapter_name         TEXT,
  route_decision_id    TEXT,
  status               TEXT NOT NULL CHECK(status IN (
    'queued','running','awaiting_approval','blocked',
    'completed','failed','cancelled','superseded',
    'interrupted','timed_out')),
  session_id           TEXT,
  thread_id            TEXT,
  agent_run_id         TEXT,
  invocation_id        TEXT,
  started_at           INTEGER,
  deadline_at          INTEGER,
  ended_at             INTEGER,
  result_summary       TEXT,
  outputs_json         TEXT,
  output_parse         TEXT CHECK(output_parse IN ('ok','fallback')),
  output_extra_keys    TEXT,            -- schema 外被丢弃的键（JSON 数组）
  partial_output_ref   TEXT,
  failure_class        TEXT CHECK(failure_class IN (
    'infra','busy','turn_fail','verify_fail','test_fail',
    'env_fail','timeout','cancel','denied')),
  cancel_requested_at  INTEGER,
  cancel_reason        TEXT CHECK(cancel_reason IN (
    'user','upstream_cancelled','deadline','shutdown','approval_denied')),
  created_at           INTEGER NOT NULL,
  UNIQUE(work_item_id, run_seq),
  UNIQUE(idempotency_key)
);

CREATE INDEX idx_work_runs_lineage ON work_runs(work_item_lineage_id, run_seq);
CREATE INDEX idx_work_runs_status  ON work_runs(status);
CREATE INDEX idx_work_runs_session ON work_runs(session_id);
```

#### `node_session_links`

```sql
CREATE TABLE node_session_links (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  graph_id         TEXT NOT NULL,
  node_entity_key  TEXT,
  node_id          TEXT,
  work_item_id     TEXT,
  work_run_id      TEXT,
  thread_id        TEXT NOT NULL,
  session_id       TEXT,
  agent_run_id     TEXT,
  turn_id          TEXT,
  link_role        TEXT NOT NULL CHECK(link_role IN (
    'primary','supporting','review','test','investigation')),
  session_origin   TEXT NOT NULL CHECK(session_origin IN (
    'map_task','manual_panel','subagent','test')),
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL
);

-- 节点级链接：同一 thread + 节点 + 角色只允许一条
CREATE UNIQUE INDEX ux_node_session_links_node
  ON node_session_links(thread_id, node_entity_key, link_role)
  WHERE node_entity_key IS NOT NULL;
-- 项目级链接：同一 thread + 角色只允许一条（NULL 不参与普通 UNIQUE，必须用部分索引）
CREATE UNIQUE INDEX ux_node_session_links_project
  ON node_session_links(thread_id, link_role)
  WHERE node_entity_key IS NULL;

CREATE INDEX idx_node_session_links_node    ON node_session_links(graph_id, node_entity_key, created_at);
CREATE INDEX idx_node_session_links_work    ON node_session_links(work_item_id);
CREATE INDEX idx_node_session_links_thread  ON node_session_links(thread_id);
```

#### `change_sets`

```sql
CREATE TABLE change_sets (
  id              TEXT PRIMARY KEY,
  project_path    TEXT NOT NULL,
  graph_id        TEXT,
  work_run_id     TEXT,
  session_id      TEXT,
  base_commit     TEXT,
  head_commit     TEXT,
  dirty           INTEGER NOT NULL DEFAULT 0,
  dirty_tree_hash TEXT,
  files_json      TEXT NOT NULL,
  file_count      INTEGER NOT NULL DEFAULT 0,
  line_additions  INTEGER NOT NULL DEFAULT 0,
  line_deletions  INTEGER NOT NULL DEFAULT 0,
  captured_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_change_sets_run ON change_sets(work_run_id) WHERE work_run_id IS NOT NULL;
CREATE INDEX idx_change_sets_project ON change_sets(project_path, captured_at DESC);
```

#### `routing_decisions`

```sql
CREATE TABLE routing_decisions (
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT,
  work_run_id       TEXT,
  chosen_adapter    TEXT NOT NULL,
  candidate_json    TEXT NOT NULL,
  reason            TEXT,
  policy            TEXT NOT NULL CHECK(policy IN ('single_agent','manual_override','fallback')),
  confidence        REAL,
  created_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_routing_decisions_run ON routing_decisions(work_run_id) WHERE work_run_id IS NOT NULL;
CREATE INDEX idx_routing_decisions_item ON routing_decisions(work_item_id, created_at DESC);
```

#### `boundary_candidates`

```sql
CREATE TABLE boundary_candidates (
  id                 TEXT PRIMARY KEY,
  derivation_run_id  TEXT NOT NULL,
  derivation_version TEXT NOT NULL,
  project_path       TEXT,
  graph_id           TEXT NOT NULL,
  anchor_entity_key  TEXT,
  anchor_node_id     TEXT,
  node_keys_json     TEXT NOT NULL,
  files_json         TEXT NOT NULL,
  signals_json       TEXT,
  score              REAL NOT NULL,
  confidence         REAL,
  reason             TEXT,
  status             TEXT NOT NULL DEFAULT 'proposed'
                     CHECK(status IN ('proposed','chosen','rejected','merged')),
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_boundary_candidates_run  ON boundary_candidates(derivation_run_id);
CREATE INDEX idx_boundary_candidates_anchor ON boundary_candidates(graph_id, anchor_entity_key);
```

#### `plan_drafts`

```sql
CREATE TABLE plan_drafts (
  id                     TEXT PRIMARY KEY,
  lineage_id             TEXT NOT NULL,
  revision               INTEGER NOT NULL DEFAULT 1,
  supersedes_id          TEXT,
  is_current             INTEGER NOT NULL DEFAULT 1,
  project_path           TEXT,
  graph_id               TEXT NOT NULL,
  anchor_entity_key      TEXT,
  anchor_node_id         TEXT,
  derivation_run_id      TEXT,
  items_json             TEXT NOT NULL,
  model_choice_json      TEXT,
  rejected_boundaries_json TEXT,
  status                 TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
    'draft','awaiting_confirm','confirmed','rejected','superseded')),
  confirmed_by           TEXT,
  confirmed_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE(lineage_id, revision)
);

CREATE UNIQUE INDEX ux_plan_drafts_current ON plan_drafts(lineage_id) WHERE is_current = 1;
CREATE INDEX idx_plan_drafts_anchor ON plan_drafts(graph_id, anchor_entity_key, is_current);
```

#### `plan_deviations`

```sql
CREATE TABLE plan_deviations (
  id                    TEXT PRIMARY KEY,
  work_item_id          TEXT,
  work_item_lineage_id  TEXT,
  work_item_revision    INTEGER,
  work_run_id           TEXT,
  derivation_version    TEXT NOT NULL,   -- 计划生成时固定
  observed_rule_version TEXT NOT NULL,   -- 记录时配置哈希
  task_type             TEXT NOT NULL,   -- 记录时快照（锚点类型/任务来源）
  agent_type            TEXT,            -- 记录时快照（实际 adapter）
  planned_file_count    INTEGER,
  actual_file_count     INTEGER,
  planned_subtask_count INTEGER,
  actual_subtask_count  INTEGER,
  turns_used            INTEGER,
  tool_calls            INTEGER,
  rework_count          INTEGER NOT NULL DEFAULT 0,
  test_failures         INTEGER NOT NULL DEFAULT 0,
  replan_count          INTEGER NOT NULL DEFAULT 0,
  scope_violation       INTEGER NOT NULL DEFAULT 0,
  boundary_changed      INTEGER NOT NULL DEFAULT 0,
  duration_ms           INTEGER,
  computed_at           INTEGER NOT NULL
);

CREATE INDEX idx_plan_deviations_rule ON plan_deviations(derivation_version, observed_rule_version);
CREATE INDEX idx_plan_deviations_item ON plan_deviations(work_item_lineage_id);

-- 目录前缀维度：一次 run 可跨多个目录，展开为一行一域；不把 file_domain 存成单值
-- v38 已实施（G2-14）：只做明细展开，不带 project_path；聚合列（runs/avg_*/rework_rate）、
-- insufficient 与 32 域上限在明细之上按需做，不进入本视图。
CREATE VIEW v_plan_deviations_file_domain AS
SELECT d.id AS deviation_id,
       d.work_run_id,
       d.derivation_version,
       d.observed_rule_version,
       d.task_type,
       d.agent_type,
       json_extract(je.value, '$.path') AS file_path,
       CASE
         WHEN instr(json_extract(je.value, '$.path'), '/') > 0
           THEN substr(json_extract(je.value, '$.path'), 1, instr(json_extract(je.value, '$.path'), '/'))
         ELSE ''
       END AS file_domain
FROM plan_deviations d
LEFT JOIN change_sets cs ON cs.work_run_id = d.work_run_id
LEFT JOIN json_each(cs.files_json) je;
```

#### `test_specs`

```sql
CREATE TABLE test_specs (
  id                 TEXT PRIMARY KEY,
  project_path       TEXT NOT NULL,
  graph_id           TEXT,
  test_node_entity_key TEXT NOT NULL,
  test_node_id       TEXT,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK(kind IN ('unit','integration','e2e','flow')),
  command            TEXT NOT NULL,
  cwd                TEXT,
  env_json           TEXT,
  timeout_ms         INTEGER NOT NULL DEFAULT 300000,
  runner             TEXT,
  file_globs_json    TEXT,
  steps_json         TEXT,                      -- kind='flow' 时的有序步骤定义
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_test_specs_node ON test_specs(graph_id, test_node_entity_key);
```

#### `test_plans`

```sql
CREATE TABLE test_plans (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  graph_id         TEXT,
  work_item_id     TEXT,
  work_run_id      TEXT,
  node_keys_json   TEXT NOT NULL,
  base_commit      TEXT,
  worktree_path    TEXT,
  plan_hash        TEXT NOT NULL,
  approval_id      TEXT,
  status           TEXT NOT NULL CHECK(status IN (
    'draft','awaiting_approval','approved','running',
    'completed','failed','cancelled','expired')),
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  approved_at      INTEGER,
  started_at       INTEGER,
  ended_at         INTEGER
);

CREATE INDEX idx_test_plans_status ON test_plans(status);
CREATE INDEX idx_test_plans_item   ON test_plans(work_item_id);
```

#### `test_plan_items`

```sql
CREATE TABLE test_plan_items (
  id                TEXT PRIMARY KEY,
  plan_id           TEXT NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  spec_id           TEXT,
  seq               INTEGER NOT NULL,
  command           TEXT NOT NULL,
  cwd               TEXT,
  selected_by       TEXT NOT NULL DEFAULT 'plan'
                    CHECK(selected_by IN ('plan','targeted','rerun')),
  targeted_reason   TEXT,
  policy_decision   TEXT CHECK(policy_decision IN ('allow','deny','ask')),
  status            TEXT NOT NULL CHECK(status IN (
    'pending','running','passed','failed','skipped','error','timed_out')),
  exit_code         INTEGER,
  duration_ms       INTEGER,
  output_ref        TEXT,
  started_at        INTEGER,
  ended_at          INTEGER,
  UNIQUE(plan_id, seq)
);
```

#### `test_runs`

```sql
CREATE TABLE test_runs (
  id               TEXT PRIMARY KEY,
  plan_id          TEXT NOT NULL,
  project_path     TEXT NOT NULL,
  graph_id         TEXT,
  work_item_id     TEXT,
  work_run_id      TEXT,
  base_commit      TEXT,
  head_commit      TEXT,
  worktree_commit  TEXT,
  dirty            INTEGER NOT NULL DEFAULT 0,
  dirty_tree_hash  TEXT,
  status           TEXT NOT NULL CHECK(status IN (
    'pending','running','passed','failed','error','cancelled','stale')),
  total            INTEGER NOT NULL DEFAULT 0,
  passed           INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  report_ref       TEXT,
  started_at       INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_test_runs_plan ON test_runs(plan_id);
CREATE INDEX idx_test_runs_item ON test_runs(work_item_id);
```

#### `test_results`

```sql
CREATE TABLE test_results (
  id                     TEXT PRIMARY KEY,
  test_run_id            TEXT NOT NULL,
  plan_item_id           TEXT,
  spec_id                TEXT,
  test_node_entity_key   TEXT,
  target_node_entity_key TEXT,
  status                 TEXT NOT NULL CHECK(status IN (
    'passed','failed','skipped','error','timed_out')),
  exit_code              INTEGER,
  duration_ms            INTEGER,
  failure_summary        TEXT,
  failure_class          TEXT CHECK(failure_class IN (
    'assertion','timeout','env_fail','infra','cancelled')),
  output_ref             TEXT,
  created_at             INTEGER NOT NULL
);

CREATE INDEX idx_test_results_run    ON test_results(test_run_id);
CREATE INDEX idx_test_results_target ON test_results(target_node_entity_key, status);
```

#### `map_migration_reports`

```sql
CREATE TABLE map_migration_reports (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN (
    'entity_key_backfill','link_backfill','integrity_check','import_dedup',
    'derivation','cleanup')),
  stage         TEXT,                       -- S1..S8 或具体子步骤
  schema_version INTEGER,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  heartbeat_at  TEXT,
  owner_pid     INTEGER,                    -- 执行迁移的进程；用于区分"另一实例在迁移"
  status        TEXT NOT NULL CHECK(status IN ('running','ok','partial','failed')),
  stats_json    TEXT,
  details_json  TEXT,
  error_json    TEXT
);
```

#### 7.2.1 B2 表生命周期与建表顺序（D 组施工）

建表顺序：`node_links → project_fingerprints → import_rejections → boundary_candidates → plan_drafts → plan_deviations → test_specs → test_plans → test_plan_items → test_runs → test_results → map_migration_reports`，同一迁移事务内完成，失败整体回滚。

| 表 | 创建态 | 更新/终态 | 保留/清理 |
|---|---|---|---|
| `plan_drafts` | `draft` | `confirmed` 生成 work_items / `rejected` | 终态保留，不硬删 |
| `boundary_candidates` | 派生 run 生成 | `accepted/rejected` | 按 run 保留 |
| `test_specs` | 绑定 test-case | 更新即新 revision | 随 test 图节点 |
| `test_plans` | `pending_approval` | `approved/expired/cancelled` | 90 天 |
| `test_plan_items` | 随 plan | `pending/running/passed/failed/skipped/denied/timed_out` | 随 plan |
| `test_runs` | `pending` | `running→passed/failed/error/cancelled/stale` | 90 天 |
| `test_results` | 随 run | 终态不可变 | 90 天，被证据引用的行保留 id |

边界：无外键，级联由服务层保证；清理任务只删 90 天前终态 `test_results/test_runs`，被 `node_evidence.ref_json` 引用的行保留。验收：全新库一键建齐本节全部表；重复迁移幂等；回滚后无半表。

### 7.3 值域汇总（类型层需同步扩展）

| 类型 | 新增值 |
|---|---|
| `GraphType` | `test` |
| `NodeType` | `test-suite`、`test-case` |
| `EdgeType` | `verifies`、`covers` |
| `NodeStatus` | 不变（7 值） |
| 新增 `WorkItemStatus` | 13 值（见 §4.1.1；四个新值 + 为父任务失败聚合补入 `failed`，均在 S5 DDL 一次写死） |
| 新增 `WorkStepStatus` | 12 值（见 §5.9.8） |
| 新增 `ExecutionState` | 9 值（见 §3.3，含 `signed_off`） |
| 新增 `EvidenceLevel` | `E0`–`E4` |

注意：`NODE_STATUS_TRANSITIONS` 是 `Record<NodeType, ...>`，新增 NodeType 必须补矩阵，否则类型检查失败；test 节点建议只允许 `draft → confirmed → published`（`developing/testing/review` 对测试资产无意义，作为默认假设）。`published` 采用软阻断（无通过记录时显示徽标并计入 `published_without_evidence`，不阻止人工标记），见 §6.5.2。

---

## 8. 迁移与实施顺序

> 本节写就时 `CURRENT_SCHEMA_VERSION = 24`（当前为 **49**，见 §8.2.1；原写 37 是旧快照）。**v24 是既有缺陷修复**（把增量列正式写进 `createSql`，见 §8.13），不属于蓝图增量。
> 下列 S1–S8 对应 v25–v32。
> **通用前置**：S0 备份完成且校验通过；迁移默认在启动期单事务内执行；`foreign_key_check` 必须为 0。
>
> **B1 例外（可续跑回填）**：`S1.backfill` 与 `S2` 按项目分批事务提交，便于中断后续跑；其余阶段仍按单事务执行。分批阶段必须在 `map_migration_reports` 记录进度与 `resume_from`；启动预检对这批幂等阶段自动续跑，非白名单阶段仍按 §8.14.1 fail-closed。

### 8.1 总览

| 步骤 | 内容 | 版本 | 前置条件 | 可独立上线边界 | 回退方式 |
|---|---|---|---|---|---|
| S0 | 停写备份 + 预检 | — | 无 | 否（运维动作） | 用备份覆盖 DB |
| S1 | 身份：`entity_key` 列 + 回填 + 唯一索引；**导入期查重**（`project_fingerprints` / `import_rejections` / `import_allowances`）+ 拒绝与放行决策 | v25 | 验证项 P1/P6/P8 通过 | 是（读写路径可后置，旧代码忽略列） | 停用读取；查重表可清空；列可保留无害 |
| S2 | `node_links` + 跨图回填（只读展示优先） | v26 | S1 完成 | 是（先只读展示） | 停用写入；表可保留空置 |
| S3 | `lifecycle_state`（nodes/graphs）+ 删除路径改造 + 巡检 | v27 | S2 完成 | 是（先写后读） | 停用归档路径，回退到硬删（接受孤儿） |
| S4 | CHECK 扩展（test 图/节点/边） | v28 | **S1 必须已上线**；验证项 P2/P3/P4 通过 | 是（test 图功能开关关闭时不可见） | **只能恢复 S0 备份**（旧二进制无法兼容新值域） |
| S5 | 任务对象表 | v29 | S2 完成（**不依赖 test 图**） | 是（任务卡叠加层开关） | 关闭开关；表保留 |
| S6 | 证据与派生状态表 | v30 | S5 完成（证据可挂任务） | 是（叠加层状态徽标） | 关闭开关；缓存表可整表重建 |
| S7 | 推导/计划/偏差表 | v31 | S5 完成 | 是（C1 计划确认流） | 关闭开关；草稿表只读保留 |
| S8 | 测试表 + 审批 subject 扩展 | v32 | S4 + S6 完成；验证项 P5 通过 | 是（TestExecutor 开关） | 关闭开关；测试表保留，审批回退到 `agent_turn` 语义（`run_id` 可空但不再使用） |

#### 8.1.1 交付节奏（D5）

> 注意：本小节的 **P1–P4 是交付阶段编号**（沿用外部蓝图口径），与 §8.11 的**验证项 P1–P9** 不是同一套编号；下文引用验证项时会写"验证项 Pn"。

S 编号是**迁移批次编号**，不是发布顺序。交付顺序按下列交付阶段：

| 阶段 | 内容 | 包含 S | 护栏 |
|---|---|---|---|
| P1 | **身份层优先**：`entity_key` + 导入查重 + `node_links` | S1、S2 | 先解决"同一实体是谁"，后续编排才有稳定锚点 |
| P2 | **编排脊柱**：任务对象、步、执行记录、证据与派生状态 | S5（含 `work_steps`）、S6 | 内置 D1/D3 护栏：候选推导只做确定性生成、模型只选择不发明边界、计划不跳过确认、gate 不过不进队列 |
| P3 | 归档语义 + test 图值域 | S3、S4 | S4 不可逆，单独发布 |
| P4 | 推导/计划表 + TestExecutor | S7、S8 | 只读先上线，再开写入 |

- **L1 = P1 + P2**，因此 L1 先落身份层（S1/S2），编排脊柱在 P2 落地；L1 仍**不建 S7/S8**。
- P2 的"内置 D1/D3 护栏"指：`plan_drafts`/`boundary_candidates` 未上线前，编排脊柱只接受**人工单步计划**，不得用模型自由生成替代；S7 上线后再接候选推导，且仍受 §5.3 的越界剔除与 §5.6 的确认约束。

#### 8.1.2 阶段验收门、回滚演练与发布检查单（E 组施工）

| 阶段 | 入口条件 | 退出验收门（全过才进下一阶段） | 回滚方式 |
|---|---|---|---|
| P1 身份层 | S0 备份可读；验证项 P1/P6/P8 通过 | 键覆盖率 100%、错配 0、二次启动 0 变化；导入拒绝时 `graphs`/`nodes` 0 新增；`node_links` 孤儿 0 | 关导入查重→旧行为（需书面确认）；删索引；列保留 |
| P2 编排脊柱 | P1 退出；验证项 P5 通过 | 13 个 item 状态与步级全值在建表 SQL；run 终态齐全；E1–E4 样本派生正确；叠加层只读可用 | 关开关；表保留；不删任务/证据 |
| P3 归档+test 值域 | P2 退出；S0 恢复演练通过；验证项 P2/P3/P4 通过 | 归档/硬删分支符合 §8.5；CHECK 重建后行数/hash 全等；`foreign_key_check` 空 | **只能恢复 S0 备份**（S4 不可逆） |
| P4 推导+TestExecutor | P3 退出；验证项 P5 通过；审批重建评审完成 | 草稿状态机完整；`test_*` 生命周期符合 §7.2.1；审批 subject 回填正确；E3 五条件生效 | 关开关；计划置 `expired`；表保留 |

发布检查单（每次发版逐项勾）：① `schema_version` 与 `TABLE_SCHEMAS` checksum 已更新；② S0 备份存在且可打开；③ 迁移状态表无遗留 `running`；④ 新旧库各跑一次启动；⑤ 回滚演练记录附发布单；⑥ 功能开关默认关闭（S4 单独发布，不与其他阶段同批）。

### 8.2 S0：备份与预检（不是代码变更）

1. 退出应用，确认无残留执行器进程。
2. `PRAGMA wal_checkpoint(TRUNCATE)` 后复制 `data/bizgraph.db` 到 `data/backups/bizgraph-v24-<ts>.db`（v24 为 §8.13 修复后的基线）。
3. 记录基准指标：`graphs`/`nodes`/`edges` 行数、`foreign_key_check` 结果、`graphs.writeback_disabled=1` 的项目数、`edges.updated_at` 非空行数。
4. 记录 `schema-checksum.json` 内容：回退必须配合恢复 DB，不能只回退二进制；库里记录的 schema 版本高于旧二进制上限时，旧二进制现在会**拒绝打开**（§8.2.1），不再按旧 `createSql` 重建。

回退：停应用 → 用备份覆盖 `bizgraph.db` 及 `-wal`/`-shm` → 删除 `schema-checksum.json` → 启动旧版本。

#### 8.2.1 版本守卫：库版本高于代码上限时 fail-closed

**状态：已实施（`database.ts` `migrate()`，2026-11-07 复核 HEAD）。**

- 判定：`schema_version` 表记录值 `> CURRENT_SCHEMA_VERSION`（当前 **37**，`database.ts`）时，在**任何重建/增量迁移之前**抛 `DB_SCHEMA_TOO_NEW`，消息包含记录版本、支持上限、库文件路径与处置建议；连接随关闭，不进入预检/回填。
- 动机：旧代码的慢路径会用当前版本的 `createSql` 重建表，`restoreFromBackup` 只恢复**共有列**，新版本写入的列/约束会被静默丢弃，随后 `schema_version` 被回写成更低版本——不可逆退化。v33 的 CHECK 曾因 `test` 行恢复失败偶然挡住，不能作为防线。
- 不做启动期自动"降级"：降级不是默认行为；如确需把更高版本的库交给旧版本使用，必须人工恢复备份并留下可查询记录（本版本不提供降级入口）。
- 结构检测维度（2026-11-07，`rebuildTableIfNeeded` + `reconcileSchemaIndexes`）：慢路径重建判定比较列集合/类型/CHECK/**内联 UNIQUE**；独立 `CREATE UNIQUE INDEX` 定义由索引对账比对，变化时先 `DROP INDEX` 再建。两类 UNIQUE 都进入 `schema-checksum`（内联随 `createSql`、独立随 `INDEX_SQLS`），因此**不升 `CURRENT_SCHEMA_VERSION` 也不会漏掉已有库**——任一 DDL 变化都会让 checksum 失配并强制走慢路径。
- 唯一键 fail-closed：重建表或创建/替换唯一索引前，先只读统计目标键的重复组数（按 SQLite 语义忽略含 NULL 的键行）；存在重复即抛 `DB_MIGRATION_FAILED`，消息含表名、`UNIQUE(...)` 列清单、组数与样例，拒绝重建以避免静默丢行。
- `node_links` 去重约束已带两端图：`UNIQUE(from_graph_id, to_graph_id, from_entity_key, to_entity_key, link_type)`（§7.2）；`entity_key` 跨图共享，旧的三列约束会让不同图组合的链接互相复用端点图信息。
- 版本标记边界：`schema_version` 表是唯一权威的库结构版本；`PRAGMA user_version`（memory FTS 触发器版本，`memory-store.ts`）与 `yjs_snapshots.schema_version`（单图快照写入规则版本，`snapshot-store.ts`）是独立域，不参与本守卫，也不会被 `migrate()` 回写。
- `schema-checksum.json` 是同一版本域的缓存标记：其记录版本高于代码上限时同样触发 `DB_SCHEMA_TOO_NEW`（否则快路径失配会进入按旧 `createSql` 重建的慢路径）。库 `schema_version` 表仍是权威判定；处理不可信缓存属于显式动作。
- v34 取证边界：v34 只对 `work_items` / `work_steps` 做 `ALTER TABLE ADD COLUMN`，**不重建任何表**，因此不进入 S4（`graphs/nodes/edges` 重建前后基线）的取证范围；S4 基线也只在 `currentVersion < 33` 时拍摄。v34 的「新列存在 + 旧行不丢 + 无 `work_*_backup` 残留」由 `database-migration.test.ts` 的 v33→v34 用例直接断言。

### 8.3 S1：身份（`entity_key` + 导入期查重）

前置：

- `nodes.createSql` 增加 `entity_key TEXT`（可空），且**不加入** `requiredColumns`（加进去会让旧库无条件重建）。
- 导入查重表（`project_fingerprints` / `import_rejections` / `import_allowances`）与查重逻辑必须在**建图之前**接入（§2.6）。
- 回填算法落地为独立迁移函数，幂等。
- P1、P6 验证通过。

顺序：

1. 建 `project_fingerprints` / `import_rejections` / `import_allowances` + 索引（v25）
2. `rebuildTableIfNeeded`（本次通常不重建，因为 CHECK/类型未变）
3. `addColumnSafe('nodes','entity_key','TEXT')` 兜底
4. 回填（按 §2.2）
5. `CREATE UNIQUE INDEX ux_nodes_graph_entity_key`
6. **导入流程改为"先指纹查重、再建图"**（§2.6 Step 0–4）；命中即拒绝并写 `import_rejections`，不产生任何 graph/node 行
7. 为历史已有的重复导入数据（S1 之前产生的并行 lineage）生成 `map_migration_reports(kind='import_dedup')` 报告：只报告，不自动删除、不自动合并；由用户决定保留哪一套
8. 写 `map_migration_reports`（`entity_key_backfill`）

上线边界：

- 可先只写不读（新节点写键、克隆复制键）。
- **导入查重必须与本次一起上线**：若只加列不改导入，重复导入仍会新建图，"会话不见了"照旧发生。
- 读取能力（跨图跳转、时间线）在 S2 上线。

回退：

- 读取路径回退到 node id，`entity_key` 列保留（无害）。
- 唯一索引若导致写入冲突，`DROP INDEX ux_nodes_graph_entity_key` 后可继续运行（降级为无唯一约束）。
- 导入查重回退到"总是新建"（会重新暴露会话黑洞），回退前必须书面确认。
- 不重建 `nodes`，因此无数据丢失风险。

#### 8.3.1 S1 验收门与失败处置（E 组施工）

- 结构：`ux_nodes_graph_entity_key` 存在；`nodes.createSql` 含 `entity_key`；`entity_key` **未**加入 `requiredColumns`（避免旧库无条件重建）。
- 数据：`null_after=0`；二次启动 `updated=0`；唯一索引冲突 0；历史重复导入只生成 `import_dedup` 报告，不删、不合并。
- 行为：命中查重时 `graphs`/`nodes` 新增行数均 0，拒绝原因落 `import_rejections`；放行时指纹与建图同事务。
- 失败处置：回填错配 >0 → 停止上线，按 `details_json` 定位项目重跑；索引冲突 → 先出报告再由人工决定保留哪套，**禁止自动删节点**。

### 8.4 S2：`node_links` + 跨图对应

前置：S1 完成；跨图回填样本人工抽检 20 条一致。

顺序：

1. 建 `node_links` + 索引
2. 按 `entity_key` 回填 `derives_from`（online → dev，`origin='import'`）
3. 叠加层只读展示"跨图对应关系"（不提供关联/合并入口 —— 合并入口已被 §2.6 的导入期拒绝替代）

上线边界：只读展示；`map:link:create` 仅允许 `relates_to`（用于已确认的分支/副本），不提供"合并 lineage"。

回退：关闭读取即回到"无链接"状态；表可保留空置。已手工写入的 `relates_to` 链接保留（无副作用）。

#### 8.4.1 S2 验收门（E 组施工）

- `derives_from` 回填数量 = online/dev 同键配对数；抽样 20 条 `from→to` 与人工判断一致。
- `node_links` 唯一键（project+type+from+to）无重复；孤儿（端点键不存在）计数为 0 或全部有解释。
- `map:link:create` 仅 `relates_to` 成功，其他类型返回 `MATRIX_VIOLATION`；重复链接被唯一索引拦住。
- 失败处置：孤儿 >0 → 先补建缺失图/节点，不删链接；重复 → 保留最早行，其余标 `duplicate` 并报告。

### 8.5 S3：归档语义

前置：S2 完成；删除路径改造已评审（`NodeRepository.delete` / `GraphRepository.delete`）。

顺序：

1. `lifecycle_state` 进 createSql（NOT NULL + DEFAULT，重建可安全补默认值）
2. 删除路径改造：有依赖 → 归档；无依赖 → 硬删
3. 图删除前置校验（running run / 未完成 work_item 拒绝）
4. `map_integrity_check`（孤儿巡检）

上线边界：先写不读（叠加层默认仍显示归档节点，只是标记）；后读（默认隐藏归档）。

回退：停用归档路径（回到硬删）。此时会产生孤儿链接，由巡检标记 `orphan`，不阻断。

#### 8.5.1 S3 生命周期状态机与验收门（E 组施工）

状态机：`active → archived`（有依赖删除时）/ `active → deleted`（无依赖硬删）；`archived → active`（人工恢复）；`archived → deleted`（人工确认后清理）。禁止 `deleted → *`。

- 删除路径：有 `work_items`/`runs`/证据/链接任一依赖 → `archived`；无依赖 → 硬删；图删除前存在 running run 或未完成 item → `GRAPH_BUSY`。
- 验收：四场景（删节点/拆父子/并图/删图）后孤儿 0；归档节点默认隐藏但可检索；`map_integrity_check` 报告可解释。
- 失败处置：删除路径未改造完成 → 关闭删除入口，只给归档；巡检只标 `orphan`，不自动删。

### 8.6 S4：CHECK 扩展（最危险一步）

前置（**硬性**）：

1. S1 已上线且 `entity_key` 在 `nodes.createSql` 中 —— 否则本次 `nodes` 重建会丢键。
2. `graphs.createSql` / `edges.createSql` 的缺失列**已由 v24 补齐**（`writeback_disabled`、`updated_at`，见 §8.13）；S4 前只需复核 v24 已应用，无需重复修改。
3. P2（耗时）与 P4（不可回退）已书面确认。
4. 备份可恢复演练通过。

顺序：`graphs` 重建 → `edges` 重建 → `nodes` 重建 → 索引 → `foreign_key_check`。

- 重建期间 `foreign_keys` 关闭（既有 `migrate()` 已处理），`DROP TABLE` 不会级联清空 `edges`/`bug_nodes`。
- 重建后逐项校验：行数、内容 hash（对 JSON 列做规范化后比对）、`entity_key` 保留、`writeback_disabled` 保留。
- 若任一项失败：回滚事务 → 抛错 → 用 S0 备份恢复（不要尝试部分修复后再启动）。

上线边界：先发版但测试图功能开关关闭；确认稳定后再开。

回退：**只能恢复 S0 备份**。理由：旧二进制的 `createSql` CHECK 不含 `test`，启动时会判定 CHECK 不一致并重建 `nodes`，restore 时插入 `type='test'` 会违反旧 CHECK，导致迁移失败甚至启动失败。

#### 8.6.1 S4 校验清单与中止条件（E 组施工）

重建后逐项校验（任一失败即回滚事务并恢复 S0）：① 四表行数与重建前一致；② JSON 列规范化 hash 全等；③ `nodes.entity_key`、`graphs.writeback_disabled`、`edges.updated_at` 保留；④ `PRAGMA foreign_key_check` 为空；⑤ 新 CHECK 接受 `test`，旧值不触发违规；⑥ 备份表存在且行数一致。

中止条件：S1 未上线、`createSql` 缺 `entity_key`、备份不可恢复、验证项 P2/P4 未书面确认——任一成立**不得开始重建**。回退只允许恢复 S0 备份，禁止“修一半再启动”。

### 8.7 S5：任务对象

顺序：`work_items` → `work_steps` → `work_runs` → `node_session_links` → `change_sets` → `routing_decisions` → 索引。

**DDL 一次建齐（D2）**：`work_items.status` 的 `needs_input` / `needs_human` / `paused` / `interrupted` 与其它值必须在**本次建表 SQL 中一次写死**，不得留到后续 `ALTER` 或表重建；`work_steps.status` 的全部步级状态同理。建表后修改状态值域只能走重建，成本远高于一次写对。

上线边界：先支持"人工创建单任务 + 手工会话挂载"（M1），再开"任务卡叠加层"（M2）。此步不依赖 TestExecutor。

回退：关闭开关；表保留（无数据破坏）。

#### 8.7.1 S5 值域与验收门（E 组施工）

- `work_items.status` 建表即含 13 值（含 `needs_input`/`needs_human`/`paused`/`interrupted`/`failed`）；`work_steps.status` 全值一次写死；`work_runs.status` 终态含 `passed/failed/error/cancelled/stale`。
- 验收：每个合法值 `INSERT` 成功、非法值被 CHECK 拒；状态迁移只走 `WorkItemService`；重启后未终态 run 按 D7 对账（`running → interrupted` 或按 pid 存活判定）。
- 失败处置：值域缺项只能重建表，故 S5 建表 SQL 评审时逐值对照 §5.5.1/§5.9.8，缺一发版即阻断。

### 8.8 S6：证据与派生状态

顺序：`node_evidence` → `evidence_suggestions` → `node_execution_state` → 索引 → 首次全量派生。

上线边界：先只读（叠加层显示状态与证据列表），再开"证据建议"。

回退：关闭开关；`node_execution_state` 可整表 `DELETE` 后重算；不影响 `nodes.status`。

#### 8.8.1 S6 验收与开关（E 组施工）

- 结构：`node_evidence` 的 E1–E4 组合校验、`evidence_suggestions` 状态 CHECK、`node_execution_state` 唯一键（graph+entity_key）与索引齐全。
- 行为：E1 人工直写、E2/E3/E4 按 §3.2 写入；建议 accept 同事务转证据；首次全量派生与 §3.3 tie-break 一致。
- 验收：E1–E4 各一条样本；`inputs_hash` 重复计算稳定；关闭开关时写通道显式拒绝而非静默成功。
- 回退：`DELETE FROM node_execution_state` 后重算；证据保留；不触碰 `nodes.status`。

### 8.9 S7：推导与计划

顺序：`boundary_candidates` → `plan_drafts` → `plan_deviations` → 索引。

上线边界：先只做"候选展示 + 人工选"（不接模型），再开"模型组织"。

回退：关闭开关；已确认的计划保持只读。

#### 8.9.1 S7 状态机与验收门（E 组施工）

`boundary_candidates`: `candidate → accepted|rejected`；`plan_drafts`: `draft → confirmed|rejected`，`confirmed` 才生成 `work_items`；`plan_deviations`: 生成即只读、永久保留。

- 验收：候选只能由确定性规则生成（模型只选择不发明）；草稿确认幂等（重复确认返回同一批 item）；偏差可追溯到 `revision` 与来源 run。
- 失败处置：确认失败整体回滚，草稿保持 `draft`；已生成 item 不重复生成。

### 8.10 S8：TestExecutor

前置：S4（test 图可用）+ S6（证据回写可用）+ 验证项 P5 通过；`agent_approvals` 重建方案已评审。

顺序：

1. `test_specs` → `test_plans` → `test_plan_items` → `test_runs` → `test_results`
2. `agent_approvals` 重建（放宽 `run_id`/`turn_id`，加 `subject_type`/`subject_id`，把这两列加入 `requiredColumns` 以强制重建）
3. 回填 `subject_type='agent_turn'`，`subject_id=turn_id`
4. 索引 `idx_agent_approvals_subject`

**不建独立 `test_approvals` 表（D6）**：本步只重建 `agent_approvals`，测试计划审批写 `subject_type='test_plan'`。理由见 §6.3（两套审批事实会破坏审计单一来源）。

上线边界：TestExecutor 开关关闭时表存在但不可调用；先支持"单节点单 spec"，再支持"计划级多命令"。

回退：关闭开关；计划作废（`expired`）。`agent_approvals` 的 `subject_type` 默认值保证旧写入路径继续工作；不能把列改回 `NOT NULL`（SQLite 无此能力），但空值只出现在关闭 TestExecutor 后的历史行，读路径需能处理。

#### 8.10.1 S8 验收与回退细节（E 组施工）

- 结构：`test_*` 5 张表 + `agent_approvals` 新列（`subject_type` 默认 `agent_turn`、`subject_id`、`run_id/turn_id` 可空）＋ `idx_agent_approvals_subject`。
- 回填：旧行 `subject_type='agent_turn'`、`subject_id=COALESCE(turn_id,'')`；行数一致；旧写入路径不传 subject 仍可工作。
- 验收：`test:plan:approve` 写 `subject_type='test_plan'`；重启后未批准计划 `expired` 不重放；E3 五条件缺一即拒；测试表生命周期符合 §7.2.1。
- 回退：关开关；计划 `expired`；表保留；`agent_approvals` 不回改 NOT NULL。

### 8.11 迁移前置条件验证清单

> 口径：这是**迁移前置条件**。任何一项失败，改的是做法（回填方式、重建顺序、链接维护策略），不是推翻 A+ 方案。

| 编号 | 验证目标 | 方法 | 通过判据 | 失败时的替代做法 |
|---|---|---|---|---|
| P1 | `entity_key` 回填正确且幂等 | 真实 DB 副本跑两次启动；构造空 parent / 同名兄弟 / placeholder / 跨项目同名 | 覆盖率 100%；匹配率 ≥ 99%；**错配 0**；二次启动 0 变化；唯一索引存在 | 索引冲突 → partial index + 去重（保留最早 `created_at`）；匹配率低 → 不强求同键，改 graph 内唯一键 + `derives_from`（`confidence` 标注）；重建丢键 → 确认键已进 `createSql` 后重跑 |
| P2 | 重建耗时与数据量 | 生产级副本计时；比对行数、规范化 hash | 单表 < 2s（1 万节点量级）；hash 全等；FK 违规 0 | 超时 → 分表重建 + 首次启动进度提示；hash 不等 → 阻断发布，先修 `restoreFromBackup` 列映射 |
| P3 | 重建不丢非 `createSql` 列 | 重建前置 `writeback_disabled=1`、写 `edges.updated_at`，重建后校验 | 值保留 | **已由 v24 修复**（4 表 8 列补进 `createSql`，见 §8.13）；若仍失败 → 检查 `restoreFromBackup` 列映射是否遗漏，而非再补 `createSql` |
| P4 | 升级后能否降级 | 旧二进制打开新库 | 预期**不能** | 接受"不可逆"，回退统一走备份恢复；发布流程把 S4 标为不可逆里程碑 |
| P5 | `node_links` 完整性 | 四场景（删/拆/并/删图）脚本演练 + 孤儿扫描 | 孤儿 0；软删后会话/证据可查；重复链接被拦 | 删除路径不可改 → IPC 层删除前拦截 + 巡检报告；解析走 `node_id` 快路径 + 定时按键修复 |
| P6 | Yjs 只读处置 / 快照 / SQLite 镜像 / IPC / 渲染兼容 | **已实施（`cc749ce` + `987c226`）**：默认启动下 `1236` 不监听；显式开启后写消息被拒；doc 变更后 `nodes`/`edges` 无新增/改写，只更新 `yjs_snapshots`；旧快照可读；`entity_key` 不因恢复重算。**并行保留** SQLite 权威列 ↔ 镜像一致性：repo 显式写入后查键、镜像恢复后查键、比对镜像与权威列。另测 `graph:get` 返回 `entityKey` | 默认端口无监听；显式开启后写消息被拒；doc 变更不落库；键不丢不重置；旧快照可读；**镜像与权威列一致**；未知 `graphType` 不崩 | 仍能写 `nodes`/`edges` → 阻断发布；写消息未被拒 → 阻断发布；快照重建 id → 快照 v2 恢复后按签名回填；镜像不一致 → 阻断发布；渲染拒新值 → 放宽共享类型 + 未知类型降级展示 |
| P7 | 渲染底座是否需要推翻 | 叠加层原型在 1000 节点图上跑批量 IPC | 不改 React Flow 数据模型；帧率/内存劣化 < 20%；单次批量 IPC | 超出性能预算 → 叠加层改为按视口分页拉取；仍不足则改为独立只读视图（仍不推翻底座） |
| P8 | 导入查重判定正确（§2.6） | 构造 6 类样本：同路径 / 同目录名+高相似 / 不同目录名+高相似 / 不同目录名+中相似 / 抽样失败 / 不同项目 | 每个样本决策与 §2.6 Step 表一致；拒绝时 `graphs`/`nodes` 新增行数为 0；放行时指纹与建图同事务 | 误拒率高 → 调阈值或改为"总是展示证据 + 人工确认"；误放高 → 提高相似度阈值并强制人工确认；抽样失败率高 → 增加 N 或改用目录树结构指纹 |
| P9 | 非 git E4 不混同（§3.5） | 构造 E3（`verified`）+ E4（`signed_off`）混合数据，逐项检查地图徽标/列表/导出/看板 | 按"可复现 / 不可复现"分组；E4 标注"无代码 hash、不可复现"；无同列合并、无等价排序 | 数据层已隔离，先在导出/看板层强制分组；若仍做不到，暂时只允许 UI 展示、关闭该维度导出 |

> **Yjs 处置（已实施，`cc749ce` + `987c226`，见 §2.2.1）**：单向只读、SQLite 权威 —— doc → `nodes`/`edges` 写回已断开，WS 写消息 1008 拒绝，快照持久化、`applyUpdate` 恢复与 shutdown flush 保留；不删依赖/表、不改 schema 版本。**完全移除 Yjs 不在本期**。验收为"默认启动下 `1236` 不监听、doc 变更不落库"；SQLite 镜像一致性验证并行。已知缺陷：启动后新建图不进 doc 池（显式开启 WS 时连 `1236` 被 `1008` 拒绝），挂待办。

**结论**：在满足 P1–P9 的前提下，**可以按 A+ 走**。无任何一项要求推翻渲染底座或重建图数据模型。

#### 8.11.1 验证项执行记录与 go/no-go（E 组施工）

每项 P1–P9 在 `map_migration_reports(kind='integrity_check', stage='P<n>')` 留一行：`status`、`stats_json`（样本数/匹配率/耗时）、`details_json`（失败项与替代做法）、`finished_at`。

go 条件：P1/P2/P3/P4/P5/P8 全通过，P6/P7/P9 无阻断项；任一硬性项失败 → no-go，按表内“失败时的替代做法”改方案，不改 A+ 方向。发布单必须附 9 行记录 id。

### 8.12 阶段 × 表矩阵与 L1 最小集

先对齐规模事实：全量是 **22 张新建表**（原设计 18 张 + §2.6 查重相关 3 张：`project_fingerprints` / `import_rejections` / `import_allowances` + D2 编排步 `work_steps` 1 张），另有 **4 张既有表**被改列或重建（`nodes`、`graphs`、`edges`、`agent_approvals`）。

图例：`建` = 新建，`改` = 加列，`重` = 表重建（改 CHECK/类型），`—` = 本步不涉及。

| 表 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 |
|---|---|---|---|---|---|---|---|---|
| `nodes` | 改 `entity_key` | — | 改 `lifecycle_state` | 重（NodeType CHECK） | — | — | — | — |
| `graphs` | — | — | 改 `lifecycle_state` | 重（GraphType CHECK） | — | — | — | — |
| `edges` | — | — | — | 重（EdgeType CHECK） | — | — | — | — |
| `agent_approvals` | — | — | — | — | — | — | — | 重（subject 扩展） |
| `project_fingerprints` | 建 | | | | | | | |
| `import_rejections` | 建 | | | | | | | |
| `import_allowances` | 建 | | | | | | | |
| `map_migration_reports` | 建 | | | | | | | |
| `node_links` | — | 建 | | | | | | |
| `work_items` | — | — | — | — | 建 | | | |
| `work_steps` | — | — | — | — | 建 | | | |
| `work_runs` | — | — | — | — | 建 | | | |
| `node_session_links` | — | — | — | — | 建 | | | |
| `change_sets` | — | — | — | — | 建 | | | |
| `routing_decisions` | — | — | — | — | 建 | | | |
| `node_evidence` | — | — | — | — | — | 建 | | |
| `evidence_suggestions` | — | — | — | — | — | 建 | | |
| `node_execution_state` | — | — | — | — | — | 建 | | |
| `boundary_candidates` | — | — | — | — | — | — | 建 | |
| `plan_drafts` | — | — | — | — | — | — | 建 | |
| `plan_deviations` | — | — | — | — | — | — | 建 | |
| `test_specs` | — | — | — | — | — | — | — | 建 |
| `test_plans` | — | — | — | — | — | — | — | 建 |
| `test_plan_items` | — | — | — | — | — | — | — | 建 |
| `test_runs` | — | — | — | — | — | — | — | 建 |
| `test_results` | — | — | — | — | — | — | — | 建 |

> 版本号按**实际发布顺序**递增。若 L1 跳过 S3/S4，则后续步骤顺延取号，**不预留空号**；§8.1 的 v25–v32 是全量路径的示意，不是必须照抄的号段。

#### L1 最小表集

L1 定义 = 任务路由 + 会话时间线 + 证据展示（不含测试执行、不含计划推导）。

| 类别 | 表 | 说明 |
|---|---|---|
| 改列 | `nodes` + `entity_key` | 身份必需；不建索引则无法支撑跨图对应 |
| 建 | `project_fingerprints`、`import_rejections`、`import_allowances`、`map_migration_reports` | 导入查重 + 记住规则 + 迁移报告（S1 一并上线，否则"重导即丢会话"照旧） |
| 建 | `node_links` | 跨图对应与时间线聚合的解析基础 |
| 建 | `work_items`、`work_steps`、`work_runs`、`node_session_links`、`change_sets`、`routing_decisions` | 任务对象、编排步、执行记录与变更面（S5 的前半）；`change_sets` 是 §4.6 `filesTouched` 的唯一来源，不能延后 |
| 建 | `node_evidence`、`node_execution_state` | 证据展示与派生状态（S6 的前半） |

**L1 共需 13 张新表 + 1 次改列**，对应迁移批次：S1 → S2 → S5a（`work_items`/`work_steps`/`work_runs`/`node_session_links`/`change_sets`/`routing_decisions`）→ S6a（`node_evidence`/`node_execution_state`）。交付顺序遵循 §8.1.1：**P1（S1/S2）先落身份层，P2（S5a/S6a）再落编排脊柱**。

**L1 明确不建**（避免提前建空表）：

| 延后项 | 归属 | 延后理由 |
|---|---|---|
| `evidence_suggestions` | S6b | L1 只展示人工已写入的证据，不做自动推断 |
| `graphs.lifecycle_state` / `nodes.lifecycle_state` | S3 | L1 期间**不开放删除节点**（只做隐藏/禁用），不存在归档需求 |
| test 图 CHECK 扩展 | S4 | 无 TestExecutor 时不需要 `test` 值域 |
| `boundary_candidates` / `plan_drafts` / `plan_deviations` | S7 | L1 不做自动拆分，只支持手工建任务 |
| `test_*` 5 张表 + `agent_approvals` 重建 | S8 | 不含测试执行 |

**L1 的边界**：L1 期间**不开放删除节点/图**，只提供隐藏/禁用；因此不需要 S3 的归档语义，S3 不提前。隐藏/禁用只改展示与可选状态，不删除行，时间线不会变成孤儿。删除能力与 S3 一起在 L2 上线。

**为什么不一次建全**：空表本身不产生数据风险，但会诱使代码提前依赖尚未验证的结构；且每张表都要进 `TABLE_SCHEMAS` / checksum / 备份 / 回滚验证，提前建会放大每次迁移的失败面。

#### 8.12.1 L1 交付验收清单（E 组施工）

- 表：13 张新表 + `nodes.entity_key` 改列全部存在；`TABLE_SCHEMAS`/checksum 同步；L1 不建的表确实未建（`evidence_suggestions`、S3/S4/S7/S8 表）。
- 功能：导入查重拒绝时 0 新行；跨图对应只读可见；任务创建/会话挂载/证据展示可用；删除入口关闭（仅隐藏/禁用）。
- 性能：1000 节点图 `map:overlay:get` 只返回视口；时间线/证据分页生效。
- 回退：关开关后不写新表；已写数据保留；重启不触发 S3–S8 迁移。

### 8.13 v24 既有缺陷修复记录（与蓝图解耦）

#### 缺陷确认

`rebuildTableIfNeeded` 的实际路径是：

```
CREATE TABLE <t>_backup AS SELECT * FROM <t>
  → 按新 createSql 建 <t>_new
  → INSERT INTO <t>_new (<公共列>) SELECT <公共列> FROM <t>_backup
```

"公共列" = 旧表列 ∩ 新 `createSql` 列。因此，**只在 `runIncrementalMigrations` 里用 `addColumnSafe` 补出、却没写进 `createSql` 的列**，在一次重建后会连列带值一起消失。不是"列还在、值为 NULL"，而是列本身不存在。

#### 全表逐字段对照结果（4 张表 / 8 列）

| 表 | 缺失列 | 来源 | 重建后后果 |
|---|---|---|---|
| `graphs` | `writeback_disabled INTEGER DEFAULT 0` | `addColumnSafe('graphs','writeback_disabled','INTEGER','0')` | 用户"关闭写回"设置被重置为 0 |
| `edges` | `updated_at TEXT` | `addColumnSafe('edges','updated_at','TEXT')` | 边的更新时间全部丢失 |
| `chat_threads` | `parent_thread_id TEXT` | `addColumnSafe` | 父子线程关系丢失 |
| `chat_threads` | `context_tokens_used INTEGER DEFAULT 0` | `addColumnSafe` | 上下文水位丢失 |
| `chat_threads` | `context_window_max INTEGER DEFAULT 0` | `addColumnSafe` | 上下文窗口上限丢失 |
| `chat_threads` | `last_compacted_at INTEGER` | `addColumnSafe` | 最近压缩时间丢失 |
| `chat_threads` | `metadata TEXT DEFAULT '{}'` | `addColumnSafe` | `metadata.task_kind` 丢失 → A2A 任务过滤失效 |
| `chat_messages` | `token_count INTEGER DEFAULT 0` | `addColumnSafe('chat_messages','token_count','INTEGER','0')` | token 计数清零 |

其余 `TABLE_SCHEMAS` 表逐字段核对**无缺失**：`nodes`、`bug_nodes`、`recipes`、`recipe_runs`、`yjs_snapshots`、`memory_items`、`compact_history`、`subagent_invocations`、`writeback_items`，以及 9 张 `agent_*`（DDL 单一来源在 `agent/runtime/db/schema.ts`，本身没有"增量列不在 createSql"的路径）。`code-intelligence` 的 `CREATE TABLE IF NOT EXISTS` 独立建表、不走重建框架，不属同类风险。

#### 会命中这两张表的既有重建路径

1. 任何改 `graphs` / `edges` / `chat_threads` / `chat_messages` 的 CHECK 或列类型的迁移 —— 包括未来扩展 `chat_threads.status`、`chat_messages.status` 的 CHECK。
2. 本蓝图 **S4**：重建 `graphs` → `nodes` → `edges`，必然先命中 `graphs.writeback_disabled` 与 `edges.updated_at`。
3. P2/P3 演练（人为触发重建）同样命中。
4. 任何手工/运维触发的表重建。

#### 最小修复（已完成，v24）

- 8 列写进各自 `createSql`；**不加入 `requiredColumns`** → 旧库不会因此无条件重建，只保证未来重建时这些列进入"公共列"。
- 新增列一律**可空或带 DEFAULT**，与现网 `ALTER TABLE` 产生的列形态一致（`writeback_disabled` 刻意不加 `NOT NULL`，避免恢复时失败）。
- `CURRENT_SCHEMA_VERSION` 23 → 24；v24 只做 schema 对齐，**不触发重建**。
- **无需一次性回填**：现网这些列已由 `addColumnSafe` 存在；本修复只保证未来重建不丢。若个别库确实缺列，`runIncrementalMigrations` 仍会补。

#### 验证

1. 真实库副本上模拟四表重建：行数不变、缺失列集合为空、`foreign_key_check` 无输出。
2. 合成数据验证：`writeback_disabled=1`、`edges.updated_at` 在重建后保留。
3. 未使用 vitest：`better-sqlite3` 的 ABI 与当前 Node 不匹配（Electron NODE_MODULE_VERSION 130 vs 系统 Node 115），`npm rebuild` 会破坏 Electron 运行时；改用 Python `sqlite3` 在副本上复现同一建表/恢复序列。

#### 提交

`587e25e fix(db): 补齐 createSql 缺失列，避免表重建丢值与设置重置`（只含 `src/main/database.ts`）。

### 8.14 迁移状态机与半迁移恢复（补充审查项）

`map_migration_reports` 承担迁移阶段状态（§7.2 已加 `stage` / `schema_version` / `heartbeat_at` / `error_json`）：

| 阶段状态 | 写入时机 | 启动期行为 |
|---|---|---|
| `running` | 阶段开始，写 `stage` + `schema_version` + `started_at` + `heartbeat_at` | 心跳每 30 秒更新；心跳超过 10 分钟未更新视为"半迁移" |
| `ok` | 阶段完成且校验通过（行数 / FK / hash） | 允许进入下一阶段 |
| `partial` | 阶段部分完成（仅限声明为可续跑的幂等阶段） | 允许续跑该阶段，不重跑已 `ok` 的阶段 |
| `failed` | 校验失败或异常 | 幂等白名单阶段（每次启动重跑）自动重试；其余阶段阻断启动，必须恢复 S0 备份或人工修复 |

`entity_key_backfill` 项目级失败**不再记为阶段 failed**：失败项目的事务回滚，其节点保持
`entity_key IS NULL`（可直接查询），报告行置 `partial`，`details_json.failed_projects` 记录项目路径、
online/dev 图 id 与错误；应用照常启动，下次启动自动对 NULL 行重试（幂等）。

硬规则：

1. **半迁移按幂等白名单自动续跑**：启动预检发现阶段 `running` 且心跳过期时，白名单内的幂等阶段（每次启动重跑的回填/建索引类）自动续跑并记录告警；非白名单阶段拒绝启动并提示恢复备份。不得带着不可证明安全的半迁移库继续读写。
2. **并发迁移互斥**：心跳仍在更新 → 说明另一个进程在迁移，当前进程拒绝启动（或只读），避免双写。
3. **孤儿 `*_backup` 检测**：启动预检扫描 `sqlite_master` 中的 `%_backup` / `%_new` 表；若原表与备份表同时存在，视为中断的重建：**不自动删除任何一张**，先写 `map_migration_reports(kind='integrity_check')`，按"原表行数 / 备份行数 / 是否含新列"决定续跑或恢复；无法判定时只提示人工处理。
4. **续跑边界**：只有 `addColumnSafe`、回填、`CREATE INDEX` 等幂等操作允许续跑；S4 的 CHECK 重建、`agent_approvals` 重建等不可逆步骤一旦 `failed`，只能恢复 S0 备份，不做"部分修复后再启动"。
5. **不静默清理**：任何 `_backup` 表的删除都必须有报告与显式动作，防止把唯一可恢复副本删掉。
6. **报告行保留策略（已实施）**：启动与每日任务都会追加 `map_migration_reports` 行，故按 `(kind, stage)` 每组只保留最近 20 行（`pruneMapMigrationReports`，启动后与每日各执行一次）；`running` 行永不裁剪（半迁移现场不可被掩盖）；有删除时追加 `kind='cleanup', stage='reports'` 行，`stats_json` 记录 deleted / keep_per_stage，不做静默清理。

#### 8.14.1 B1 迁移状态机施工细则

> 本小节把 §8.14 的硬规则展开为可执行的阶段表。所有记录复用 `map_migration_reports`，**不新增表**。

**阶段与状态映射**

| 语义 | `status` 值 | 写入时机 | 备注 |
|---|---|---|---|
| started | `running` | 阶段开始前先提交一行 | `owner_pid` 必填；`started_at` 与 `heartbeat_at` 同值 |
| completed | `ok` | 阶段事务提交且校验通过后 | `finished_at` 必填；`stats_json` 必填 |
| retryable partial | `partial` | 声明为可续跑的阶段只完成一部分 | 只允许 S1.3 / S2 回填；必须留 `details_json.resume_from` |
| failed | `failed` | 校验失败、异常、或不可续跑阶段中断 | `error_json` + `finished_at`；启动阻断 |

- 每个阶段独立一行；重跑同一阶段**新建一行**，不覆盖历史。查询"最新状态"按 `started_at DESC, id DESC`。
- `heartbeat_at` 每 30 秒更新一次；只更新 `status='running'` 的最新行。心跳写失败不阻断阶段，但必须在 `error_json` 记 `heartbeat_lost`。
- 阶段事务与报告：先插入 `running` 并提交；再执行阶段工作；成功后更新该行 `ok`。阶段工作与 `schema_version` 更新放在同一事务提交；崩溃后 `running` 行保留，由启动预检裁决。

**B1 阶段目录**

| 阶段 | 可续跑 | 校验 |
|---|---|---|
| `S1.tables` / `S1.column` / `S1.indexes` | 是（幂等 DDL） | 表/列/索引存在；`nodes.createSql` 含 `entity_key` |
| `S1.backfill` | 是（只写 NULL 行） | `null_after=0`；二次运行 0 变化；唯一索引无冲突 |
| `S1.import_path` | 否（代码路径） | 旧路径已关闭；拒绝时三表 0 新增 |
| `S1.report` / `S1.verify` | 是（只读/可重算） | 报告计数与真实库一致 |
| `S2.tables` / `S2.backfill` | 是 | 链接唯一键无重复；孤儿计数可解释 |
| `S5a.tables` | 是（`CREATE TABLE IF NOT EXISTS`） | 13/12 状态值齐全；索引存在 |
| `S6a.tables` | 是 | 证据 CHECK 约束存在；派生表索引存在 |
| `S6a.verify` | 是（只读） | E0–E4 样本；过期 E4 派生为 `stale`（U1 裁决） |

**启动预检顺序（fail-closed）**

1. `PRAGMA integrity_check` 必须返回 `ok`；否则拒绝启动，提示恢复 S0 备份。
2. `PRAGMA foreign_key_check` 必须为空；否则拒绝启动。
3. 读取每个阶段最新行：
   - `failed` → 幂等白名单阶段自动重试；非白名单阶段拒绝启动，提示恢复 S0 或人工修复；
   - `running` 且 `owner_pid` 是其他仍存活进程 → 拒绝启动（另一实例在迁移）；
   - `running` 且心跳超过 10 分钟或 `owner_pid` 已不存在 → 判定"半迁移"：幂等白名单阶段自动续跑（无需 argv），非白名单阶段拒绝启动，仅允许显式 `--resume-migration` 或恢复备份；
   - `partial` → 只允许续跑声明为可续跑的阶段；不可续跑阶段一律拒绝。
4. 扫描 `sqlite_master` 中 `%_backup` / `%_new`（见下表）；存在歧义即拒绝启动。
5. 校验 `schema_version`、迁移脚本 checksum、S0 备份存在且可读。
6. 全部通过后才进入正常读写；任何一步失败都不降级为只读继续跑业务。

**孤儿 `_backup` / `_new` 判定**

| 现场 | 判定 | 动作 |
|---|---|---|
| 原表 + backup + new 同时存在 | 重建中断在 rename 前后，状态歧义 | 拒绝启动；写 `integrity_check` 报告；人工选择恢复/继续 |
| 仅 backup + new，无原表 | 原表可能已被 rename 走 | 拒绝启动；先校验 backup 行数与 hash，人工恢复 |
| 原表 + backup，无 new | 可能是上次重建完成但未清理 | 若原表校验通过且行数/关键列与 backup 可解释 → 写报告并允许启动；**不自动删 backup** |
| 仅 new，无原表/backup | 严重半迁移 | 拒绝启动；不允许把 `_new` 当正式表 |
| 仅 backup，无原表/new | 原表丢失 | 拒绝启动；提示从 backup 恢复 |

- 上述判定只针对迁移重建产生的 `%_backup` / `%_new`；**Yjs 的 `snapshots` 是另一张表，不得按 `_backup` 规则一起删**（见 §2.8）。
- 删除 backup 必须是显式管理动作，并在 `map_migration_reports(kind='cleanup')` 留痕。

**回滚边界**

| 阶段 | 失败回滚 | 已产生业务数据后 |
|---|---|---|
| S1 | 删新建表/索引；`entity_key` 列可保留 | 不回退键；只回退读路径，禁删唯一索引 |
| S2 | 删表/索引即可 | 保留链接；关闭写入路径 |
| S5a | 删新表（未产生任务时） | 保留任务/run；禁用功能，不 `DROP` |
| S6a | 删新表（未产生证据时） | 保留证据；禁用派生，不删历史 |

**验收（故障注入）**

1. 在每个阶段"插入 running 后、工作提交前"杀进程 → 重启时幂等白名单阶段自动续跑，非白名单阶段拒绝启动；`--resume-migration` 仅作为非白名单阶段的显式人工旁路。
2. 在 S1.3 中途杀进程 → 已提交项目不重写、未提交项目续跑；`entity_key` 无重复。
3. 在 S1.4 建唯一索引时制造冲突 → `failed`，启动阻断，错误指向冲突行。
4. 手工构造四种 `_backup` 现场 → 判定与上表一致；无自动删除。
5. `integrity_check` / `foreign_key_check` 任一失败 → 拒绝启动。
6. `owner_pid` 为存活的其他进程 → 当前进程拒绝启动。

#### 8.14.2 发布检查单与回滚演练（E 组施工）

发布前：① 每个阶段最新行非 `running/failed`；② `owner_pid` 无存活外部进程；③ `sqlite_master` 无歧义 `_backup/_new`；④ `integrity_check`/`foreign_key_check` 通过；⑤ S0 备份可打开且行数匹配。

演练（每次迁移发版必做）：在副本上对 S1、S5a、S6a 各做一次“`running` 后杀进程”注入，确认启动预检按 §8.14.1 表判定；对 S4/S8 重建各做一次备份恢复演练。演练结果附发布单；未演练不得发 S4。

### 8.15 F1–F3 前置修复（B1）

> **状态：已实施（2026-11-07，main）：F1 `231c724`、F2 `2425f0c`、F3-A `e921977`、审批冻结 `7e6e63f`；以上提交均经 `git merge-base --is-ancestor <commit> main` 核实。** 这三项是 S5a / S6a 的前置源码修复，不属于本文档的施工范围；此处只写行为契约、判据与验收，供后续实现与评审对照。**F1 与 F2 先于 F3**；三项都不得改动 Yjs 的只读处置（该处置已实施，见 §2.2.1）。

#### F1 子代理拒绝路径未终止会话

**修复前现状（缺陷；2026-11-07 复核 `subagent-manager.ts`）**：不是"仅成功路径杀会话"。成功路径、`cancel()`、`sendCommand` 失败路径都会 terminate；真正的洞是 **timeout、子 agent error、取消 abort 三条 settle 拒绝分支**跳过 `terminateSession`（`subagent-manager.ts` 约 L580–590 / L546–551 / L564–574，跳过 L623–642）。

**修复契约（已实施：`231c724`；P-F1 级联/计时起点随 `71518ed` 整合）**

1. 只在**拒绝路径**补 terminate，不改成功路径与既有 `cancel()` 行为。
2. **先存输出，再 terminate**：在调用 `terminateSession` 前，把当前 `outputBuffer` / `fileChanges` / tokens 写入 invocation（见 F2），确保 terminate 触发的回调不会清空待保存数据。
3. `terminateSession` 必须**幂等**，并覆盖非 `cancel()` 触发的 abort（timeout / error / shutdown）；重复调用不抛错、不重复发事件。
4. 父会话终止必须级联取消其子代理；`startSession` 的耗时计入超时计时（不能等会话建好才开始计时）。
5. 失败路径也必须执行 Phase B / 记忆提取（若产品要求"失败也提取"）；否则不得在下游把"未执行 Phase B"当成成功。
6. **`terminateSession` 自身失败只记 warn**：不覆写已定终态；不得因清理失败把 `succeeded` 改成 `failed`。
7. **terminate 收尾触发 ScopeGuard 事后校验**：越界改动按 §6.4 回滚；不可回滚时标 `scope_violation` 并保留现场，不得静默通过。

**验收**：timeout / 子 agent error / abort 三条拒绝分支各一条用例，断言 terminate 被调用、invocation 已落 partial、Phase B 执行或明确标记失败、**进程树确死且 proc-registry 已清空**、无孤儿会话。

#### F2 失败路径丢失部分产出与 token

**修复前现状（缺陷；2026-11-07 复核 `subagent-manager.ts` / `src/shared/types/subagent.ts`）**：失败时 `outputBuffer` / `fileChanges` 是局部变量，异常即丢；`tokensUsed` 也只在失败路径才读取、同时丢。仅修 `repo.fail(error)` 不够。

**修复契约（已实施：`2425f0c`；P-F2 计时起点随 `71518ed` 整合）**

1. `SubagentResult` 增加 `status: 'completed'|'failed'|'cancelled'`、`error?`、`partial?`；`partial` 至少含 `resultText` / `resultFiles` / `tokensUsed` / `fileChanges`。
2. **同步 IPC 消费方**：renderer / 主进程所有读取 `SubagentResult` 的地方必须处理 `failed/cancelled`，不得把 `partial` 当完整结果。
3. 失败也落 `subagent_invocations`：写 `status`、`error`、`result_text`、`result_files`、`tokens_used`；不新增表。
4. 截断与大小上限（**代码事实，2026-11-07 复核**）：子代理侧按 `MAX_OUTPUT_ENTRY_SIZE = 10_000`（`base.ts:40`）单条截断并标 `truncated`（`subagent-manager.ts:220-229`）；地图侧 partial 用常量 `PARTIAL_FIELD_MAX_BYTES = 16KB` / `PARTIAL_TOTAL_MAX_BYTES = 64KB`（`work-run-service.ts:66-67`）。**两套值不一致，且均非配置项**；是否统一、统一到哪个值列为待定（§12.5 第 4 项），当前不擅自统一。
5. 明确区分 `failed` 与 `cancelled`：用户取消写 `cancelled`，执行错误写 `failed`；两者都保留 partial，但不得混写。
6. 失败路径必须计 token；`tokensUsed` 在异常包装时一并带出，不能只在成功分支读取。
7. `repo.fail(error, partial?)`：增加可选 `partial` 参数，落 `result_text` / `result_files`；不新增表。
8. 进度事件 `failed` 携带 `partialSummary:{resultTextChars, resultFilesCount, truncated}`；**不使用 `[partial]` 文本前缀**，partial 一律走结构化字段。

**验收**：制造子 agent error + 已产生 stdout/fileChange；断言 invocation 行存在、`status='failed'`、`result_text/result_files` 非空、`tokensUsed>0`；取消路径 `status='cancelled'` 且 partial 保留；IPC 消费方不崩溃。

#### F3 turn 截止时间没有执行者

**修复前现状（缺陷；2026-11-07 复核 `runtime.ts` / `repository.ts`）**：修复前代码中不存在 `agentTurnTimeoutScanner`，也没有每分钟扫描器；"现有 scan 每分钟跑并 0 命中"是对旧代码的错误描述。修复前有五处事实（现均已按 F3-A 处理）：

- `agent_turns.status` 的 CHECK **没有 `timed_out`**（仍如此；F3-A 以 `failed` + `failure_type='timeout'` 映射，不重建表）；
- `attempt` 恒为 1，退避没有意义（仍不实现 turn 级退避，见下）；
- `deadline_at` 没有索引 → 已补部分索引 `idx_agent_turns_deadline`（`schema.ts:298`）；
- 重启时已过期 deadline 的处置未定义 → 已实现 `DEADLINE_EXPIRED_ON_RESTART`（`runtime.ts:997-1010`）；
- 超时值有三套：subagent `timeoutMs` / send-and-wait 300s / 文档 10min + 60min（subagent 仍为 5 分钟独立常量，见下文代码事实）。

**统一来源（设计口径 + 代码事实，2026-11-07 复核）**

| 超时 | 设计键名（**当前未实现**） | 设计默认 | 适用 |
|---|---|---|---|
| turn 执行截止 | `agent.timeouts.turnMs` | 10 分钟 | 单个 `agent_turn`，从 `startSession` 开始计时 |
| step 执行截止 | `agent.timeouts.stepMs` | 10 分钟 | `work_steps.deadline_at`，覆盖整个 step |
| task 总墙钟 | `agent.timeouts.taskMs` | 60 分钟 | `work_items` 的总时长，排队时间不计入 |
| send-and-wait 客户端等待 | `agent.timeouts.sendWaitMs` | `turnMs + 30s` | 只是 IPC 等待，不得早于 turn deadline 触发 |

**代码事实（HEAD 复核）**：`git grep "agent.timeouts" -- src` **无命中**（无配置面）；`turnMs` 现为代码常量 `DEFAULT_AGENT_TIMEOUTS.turnMs` 且已被消费（`agent-runtime.ts:374`、`agent-manager.ts:1386`）；`stepMs/taskMs` 有常量但无消费点；`sendWaitMs` 无实现。

- **turn**：唯一生效值是代码常量 `DEFAULT_AGENT_TIMEOUTS.turnMs = 10 分钟`（`src/shared/types/agent-runtime.ts:368-369`），由 `agent-manager.ts:1386` 以 `command.deadlineMs ?? DEFAULT_AGENT_TIMEOUTS.turnMs` 消费；`deadlineMs=0`/缺省表示不启用。
- **step / task**：常量已声明 `stepMs = 10 分钟` / `taskMs = 60 分钟`（同文件 `:370-371`），但**无消费点**（`git grep "stepMs|taskMs" -- src` 仅命中定义处）；L2 编排层尚未实现。
- **send-and-wait**：未实现，无 `sendWaitMs` 常量。
- **subagent**：**仍独立配置**，`SubagentManager` 常量 `DEFAULT_TIMEOUT_MS = 5 分钟`（`subagent-manager.ts:53`），构造参数可覆盖（`:128`），`ipc-handlers.ts:504` 实例化时未传值。"不再独立配置、继承 step/turn 预算"**未实施**。
- 是否引入 `agent.timeouts.turnMs` 配置键属**产品选择**，当前未实现，列 §12.5 第 3 项待定。

- `attempt` 恒为 1：**不实现 turn 级退避**；重试只发生在 `work_steps.attempt` / 新 `work_run`，避免"退避但永不递增"的假机制。
- `agent_turns.status` 无 `timed_out`：**采用 F3-A（已定；与 `Zcode v1.2.1，302 行` 一致）** —— 映射 `status='failed'` + `failure_type='timeout'` + `error_code='DEADLINE_EXCEEDED'`；**不重建 `agent_turns`**。理由：重建表是 S4 级不可逆操作，为一个状态值不值得；UI 需要区分时在展示层由 `failure_type` 派生（"超时失败"徽标与筛选），不新增库内状态。
- **F3-B（已否决）**：重建 `agent_turns` 并把 `timed_out` 加进 CHECK。否决原因：表重建、备份/恢复与迁移窗口成本高，且会与 S1–S6 迁移叠加；收益仅为状态枚举更干净。除用户重新裁决外不再提起。
- 增加索引：`CREATE INDEX idx_agent_turns_deadline ON agent_turns(deadline_at) WHERE status='running'`（只索引运行中行，避免全表）。
- **写入点与禁止复用（F3-A）**：`sendCommandThroughKernel` 透传 `deadlineMs`；`insertTurn` 的 `deadlineAt ?? null` 参数位已存在，写入 `0` 表示**不启用** deadline（不是"立即超时"）。超时路径**不得复用 `cancelTurn`**：后者通过 `finalizeTurnStatus('cancelled', …)` 做终态 CAS，随后再写 `failed` 会因状态已非 `running` 返回 `false`，导致超时永远落不了 `failed`。正确路径：
  1. 超时控制器先杀进程组并 terminate 会话（满足 §5.9.8.1 的"终态在 terminate 之后"）；
  2. 按 F2 落 partial（`result_text` / `result_files` / `tokensUsed`）；
  3. 单次终态 CAS：`UPDATE agent_turns SET status='failed', failure_class='timeout', error_code='DEADLINE_EXCEEDED' WHERE id=? AND status='running'`（列名按代码实况为 `failure_class`，无 CHECK 约束，扩展无需迁移放宽）；
  4. `changes=0` → 已被完成/取消抢先，读取实际终态并保留，不覆盖；
  5. 不调用 `cancelTurn` 的终态分支，不先写 `cancelled`。
- **已裁决方向、当前未实现配置面（2026-11-07）**：超时默认值**目前是代码常量** `DEFAULT_AGENT_TIMEOUTS.turnMs`（10 分钟，`src/shared/types/agent-runtime.ts:368`；消费点 `agent-manager.ts:1337`），**不存在 `agent.timeouts.*` 配置键**。"默认值放配置键、kernel 层不设默认值"是产品选择方向，当前未实现；`260df58` 不在 main（`git merge-base --is-ancestor 260df58 main` 为否），不作为证据。是否引入该配置键列 §12.5 第 3 项待定。
- **已裁决并已实施（2026-11-07，`7e6e63f`）：候选 A（冻结重算）**——审批等待期不计入超时。实现为**运行时内存**：`runtime.ts:844-882` 的 `freezeDeadlineForApproval` / `resumeDeadlineAfterApproval` 维护 `approvalWaitDepth` 与 `approvalFrozenRemaining`，恢复时 `deadline_at = now + remaining`；配合 `repository.ts:630-652` 的 `freezeTurnForApproval` / `resumeTurnFromApproval` 条件更新。**`agent_turns` 没有 `paused_at` 列**（`git grep "paused_at" -- src` 无命中）；扫描器跳过 `waiting_approval` 已随 `e921977` 实施（`deadline-reaper.ts:16-17`）。
- 重启：扫描 `status='running' AND deadline_at <= now`，无存活进程 → 写 `failed` + `failure_type='timeout'` + `error_code='DEADLINE_EXPIRED_ON_RESTART'`；**不自动重跑**。不把过期 deadline 留在 `running`。
- 与 F1 的边界：F3 只负责"到期杀"; 取消/错误仍走 F1 的拒绝路径 terminate。

**验收**：turn 到期被杀、进程组无残留、DB 终态为 `failed/failure_type=timeout`、partial 非空；`waiting_approval` 期间不误杀；重启后过期行不再 `running`；send-and-wait 不早于 turn deadline。

#### F1–F3 同类漏项（一并列入前置清单）

| 编号 | 漏项 | 处理 |
|---|---|---|
| P-F1 | 父会话终止不级联取消子代理 | 父 cancel/shutdown 显式向子会话传播 `cancelled`，子 invocation 保留 partial |
| P-F2 | `startSession` 不在超时计时内 | 计时起点前移到 `startSession` 调用前；建会话耗时计入 |
| P-F3 | 失败不 terminate 导致 Phase B 不执行 | F1 的 `finally` 终止 + 失败也执行 Phase B，或显式标记 `phase_b_skipped` |
| P-F4 | 失败路径不计 token | F2 的 `tokensUsed` 随 partial 一并写入 |

---

## 9. IPC 与渲染层改动清单（只列职责，不设计 UI）

### 9.1 主进程新增服务

| 服务 | 职责 |
|---|---|
| `EntityKeyService` | 生成/保留/回填 `entity_key`；提供键解析；不参与完成度判断 |
| `ImportDedupService` | 扫描后、建图前计算指纹并查重（§2.6 Step 0–4）；返回命中信号与决策；拒绝记录写 `import_rejections`；管理 `import_allowances`（记住/查看/撤销）；允许时与建图同事务写 `project_fingerprints` |
| `LinkService` | `node_links` 读写、去重、孤儿巡检、拆分/合并链接策略 |
| `EvidenceService` | 证据写入/查询/stale 重算/建议接受；**只能由人工接受建议** |
| `ExecutionStateService` | 按 §3.3 规则重算 `node_execution_state`（批量、可重入） |
| `WorkItemService` | 任务 CRUD、revision/supersedes、gate 校验、队列推进 |
| `WorkStepService` | 编排步状态机（§5.9.8）、`needs_input` 问题卡、步级 attempt/deadline/invocation |
| `SessionTimelineService` | 按节点聚合会话/run/证据，供时间线查询 |
| `PlanDerivationService` | 候选边界推导（确定性算法）、`plan_drafts` 生成与越界剔除 |
| `RoutingService` | 单 Agent 选择与 `routing_decisions` 记录（不做并行） |
| `TestExecutor` | 计划审批提交、worktree 管理、逐条命令执行与结果回写 |
| `MapIntegrityService` | 孤儿链接、键缺失、派生状态漂移的巡检与报告 |

`WorkItemService` / `WorkRunService` / `RoutingService` 的接口签名与错误码见 §5.9.9–§5.9.10；StepInput / StepResult 与落库映射见 §5.9.11。所有编排接口返回结构化错误码，调用方不得依赖异常文本分支。

### 9.2 IPC 通道（renderer → main）

| 通道 | 职责 | 备注 |
|---|---|---|
| `map:overlay:get` | 一次返回某图的：任务卡摘要、各节点 `execution_state` + 最高证据等级、stale 计数 | **必须批量**，禁止按节点轮询 |
| `map:link:list` | 按图或节点列链接 | 只读 |
| `map:link:create` / `map:link:delete` | 人工维护链接 | 需权限校验；写 `origin='human'`；**只允许 `relates_to`**，不提供 lineage 合并 |
| `project:import:preview` | 导入前返回指纹命中证据（哪些信号对上、相似度、判定结果、是否命中记住规则） | 不写库；供确认框展示 |
| `project:import:confirm` | 用户确认导入；`allowed_branch` 与 `remember_for_fingerprint` 由用户显式勾选传入 | 自动导入不允许 `allowed_branch`；写入 `allowance_source` |
| `project:import:allowance:list` / `revoke` | 查看/撤销"记住的分支/副本放行"规则 | 必须可查看、可撤销；撤销留 `revoked_at` |
| `map:node:timeline` | 节点会话时间线（分页） | 替代 `threadStore.nodeThreadMap` |
| `map:node:evidence:list` | 节点证据列表（可点开引用） | 只读 |
| `evidence:suggestion:list` / `accept` / `dismiss` | 证据建议处理 | `accept` 才写 `node_evidence`；实际通道名见 `map:evidence:suggestions:list` / `map:evidence:suggestion:accept` / `:dismiss` |
| `map:evidence:e1:create` | E1 人工判断直写（G3-10） | 等级/写入方由主进程固定 E1/human；`summary`/`ref` 必填；`idempotencyKey` 幂等；renderer 入口归 G8 |
| `workitem:list` / `get` | 任务与 revision 查询 | 默认只返回 `is_current=1` |
| `workitem:create` | 人工建任务（含单任务模式） | 走 gate 校验 |
| `workitem:revise` | 执行中修订（增删合并拆分） | 强制产生新 revision |
| `workitem:run:start` / `cancel` | 进队/撤销 | `start` 前必须 gate=pass/waived |
| `plan:derive-candidates` | 生成候选边界 | 返回 `derivation_run_id` |
| `plan:draft:create` / `get` / `revise` / `confirm` / `reject` | 计划草稿生命周期 | `confirm` 生成 `work_items` |
| `test:spec:list` / `create` / `update` | 测试资产绑定 | 写 test 图节点关联 |
| `test:plan:create` | 生成计划并返回待审批信息 | 不直接执行 |
| `test:plan:approve` | 提交审批（走 `ApprovalGateway`） | 不允许直接写 `agent_approvals` 绕过网关 |
| `test:plan:run` | 执行已批准计划 | 校验 `args_hash` |
| `test:run:get` | 运行状态与结果 | 只读 |
| `admin:map:integrity-check` | 触发巡检 + 取报告 | 运维入口 |

#### 9.2.1 写通道契约、错误码与幂等（D 组施工）

| 通道 | 入参（* 为必填） | 出参 | 错误码 | 幂等键 |
|---|---|---|---|---|
| `map:evidence:e1:create` | `graphId* nodeEntityKey* summary* ref*` | `{evidenceId,reused,row}` | `VALIDATION_FAILED` `ENDPOINT_UNRESOLVED` | `idempotencyKey` |
| `map:evidence:suggestion:accept` | `id* resolvedBy*` | `{suggestion,evidenceId,reused}` | `NOT_FOUND` `ALREADY_DISMISSED` `LEVEL_FORBIDDEN` | 建议 id |
| `map:evidence:suggestion:dismiss` | `id* resolvedBy*` | `row` | `NOT_FOUND` `ALREADY_ACCEPTED` | 建议 id |
| `map:link:create` | `projectPath* from*/to*` | `link` | `MATRIX_VIOLATION` `DUPLICATE` | 唯一索引 |
| `workitem:run:start` | `id*` | `run` | `GATE_NOT_PASSED` `CONCURRENT_RUN` | item+revision |
| `test:plan:approve` | `planId*` | `{approvalId,expiresAt}` | `HASH_MISMATCH` `APPROVAL_PENDING` | `planId+args_hash` |
| `test:plan:run` | `planId*` | `{testRunId}` | `NOT_APPROVED` `CONCURRENT_TEST` `WORKTREE_FAILED` | `planId` |

统一约定：入参显式类型校验后才进服务层；错误走既有结构化错误，禁止内部异常文本直出；写通道仅本地 renderer 白名单可调，不接收 `actor` 自报。验收：每通道至少一条成功 + 一条必填缺失/越权用例；幂等键重复调用不增行。

### 9.3 事件通道（main → renderer）

| 事件 | 触发 | 载荷 |
|---|---|---|
| `event:node-execution-state` | 派生状态变化 | `{graphId, nodeEntityKey, executionState, evidenceLevel, staleCount}` |
| `event:work-item-changed` | revision / status 变化；**步级迁移（G2-18）也复用本通道** | `{lineageId, revision, status, stepId?, reason?}` |
| `event:work-step-changed` | **G2-18 未新开**：`work_step_changed` 事件类型复用 `event:work-item-changed` 下发（见 I.9.3） | — |
| `event:work-step-partial` | 失败/取消时已收 partial | `{workStepId, attempt, resultTextChars, resultFilesCount, truncated}`（结构化，不用 `[partial]` 文本前缀） |
| `event:test-run-updated` | 测试计划/运行变化 | `{planId, runId, status, passed, failed}` |
| `event:map-link-changed` | 链接增删/孤儿化 | `{graphId, fromEntityKey, toEntityKey, linkType, status}` |

#### 9.3.1 事件信封、版本与去重（D 组施工）

统一信封：`{v:1, event, ts, graphId, seq, payload}`；`seq` 按图单调递增（主进程内存计数，重启从 0 起，渲染端按 `ts+seq` 去重）；未知 `v` 或未知 `event` 直接丢弃并计数，不抛错。载荷只放 id 与状态，不放命令输出/密钥；`event:work-step-partial` 用结构字段表达截断，禁止 `[partial]` 文本前缀。验收：同一事件重放两次渲染端只处理一次；`v=2` 事件被安全忽略。

### 9.4 渲染层职责

| 位置 | 改动职责 |
|---|---|
| `GraphCanvas` | 增加**叠加层**：任务卡、状态徽标、证据徽标、时间线入口；不修改节点/边数据模型 |
| 证据徽标展示规则 | **E3** 徽标 = "可复现验证（测试通过 + 代码 hash）"；**E4** 徽标 = "人工签收 · 无代码 hash · 不可复现"，使用独立样式；两组**不得合并排序、不得同色**；`signed_off` 不得显示为"已验证" |
| 导入确认框 | 展示 `project:import:preview` 命中证据；拒绝时展示"哪几项对上了"；允许分支/副本时必须用户显式勾选；可另勾选"对同一指纹记住"；命中记住规则时明确标注"本次放行来自记住的规则" |
| 新增 `sessionMapStore` | 批量拉取 `map:overlay:get`；订阅 4 个事件；本地缓存按图失效 |
| 新增 `workItemStore` | 任务列表、revision 切换、run 状态 |
| 新增 `evidenceStore` | 证据列表、建议处理、stale 展示 |
| `threadStore` | 移除 `nodeThreadMap`"只保留最后一个 thread"语义；改为委托 `map:node:timeline` |
| `AgentChatPanel` | 创建 thread 时必须带 `graphId`（现状缺失，导致会话无法正确挂图） |
| `HistorySidebar` | 支持按 graph/node 过滤（现状全量列表，无法定位节点会话） |
| `graphStore` | **删除** `agent:onStatusChange` → 写 `nodes.status='developing'` 的逻辑（违反双轨） |

#### 9.4.1 组件状态来源与空/错态（D 组施工）

| 组件 | 状态来源 | 空态 | 错态 |
|---|---|---|---|
| `sessionMapStore` | `map:overlay:get` 批量 + 4 类事件 | “暂无叠加信息” | 保留上次缓存并标记“数据可能过期” |
| `workItemStore` | `workitem:list/get` + `event:work-item-changed` | “该图暂无任务” | revision 冲突提示刷新，不静默覆盖 |
| `evidenceStore` | `map:node:evidence:list` + `event:node-execution-state` | “暂无证据” | 引用不可解析显示“引用失效”，不隐藏行 |
| `GraphCanvas` | store 只读投影 | 无徽标 | 派生缺失不阻塞画布，只提示 |
| `threadStore` | `map:node:timeline` 分页 | “暂无会话” | 分页失败保留已加载页 |

边界：组件不得自行拼写证据等级文案，统一走徽标组件；E3/E4 不得同色同列。验收：每个组件有空态与错态快照；主进程异常时不白屏。

### 9.5 必须修复的既有缺口（与本设计直接相关）

1. `event:NODE_STATUS_CHANGE` **有转发链（preload 与 sessionStore 均 re-emit），但没有 `node:statusChange` 订阅者**（`src/preload/index.ts:315`、`src/renderer/store/sessionStore.ts:190`、`src/renderer/store/eventBus.ts:34`；2026-11-07 复核）→ `testing` 自动推进丢失。本期改为：该事件只更新派生状态提示，不再承担 `nodes.status` 写入。
2. `agent-manager` 会话启动自动广播 `developing` → 改为写 `work_runs`/派生状态。
3. `threadStore` 单 thread 映射 → 时间线查询。
4. `AgentChatPanel` 少传 `graphId` → 必须补。
5. `graphStore` 自动写 `developing` → 删除。

#### 9.5.1 两条 `nodes.status` 写入路径的修复与验收（D 组施工）

| 缺口 | 修复 | 验收 |
|---|---|---|
| `event:NODE_STATUS_CHANGE` 有转发无订阅者 | 订阅者只更新派生提示，不写 `nodes.status`；`testing` 推进改由派生状态表达 | 发事件后 `nodes.status` 不变；派生状态/徽标更新 |
| `agent-manager` 启动广播 `developing` | 删除广播，写 `work_runs` | 启动后无 `developing` 写入；`in_progress` 来自派生 |
| `threadStore` 单 thread 映射 | 改 `map:node:timeline` | 同节点多会话全部可见 |
| `AgentChatPanel` 少传 `graphId` | 创建 thread 必填 `graphId` | 缺参拒绝创建 |
| `graphStore` 自动写 `developing` | 删除写库 | 单测断言无 `node:update` 调用 |

统一断言：`nodes.status` 只允许人工 IPC 修改；派生与事件路径零写入。

---

## 10. 与既有安全模型的一致性

| 约束 | 本设计如何满足 |
|---|---|
| 不绕过审批网关 | TestExecutor 的每条 `ask` 类命令在执行时逐条经 `ApprovalGateway` 放行，审批事实写 `agent_approvals`；计划审批不提升 `ask`，不新增旁路 API |
| 不绕过 Bash 策略 | 逐条调用 `evaluateBashPolicy`；`deny` 不可被计划审批豁免 |
| 不绕过 gitdir 写保护 | 逐条调用 `evaluateGitDirWriteGuard`，命中即 deny（fail-closed）；worktree 创建走主进程受控 git 能力，不经 Bash |
| 不复用 `RecipeRunner` shell | 明确不复用；TestExecutor 自带执行循环 |
| 不复用会话授权 | `session grants` 为内存态，测试执行不读取、不继承 |
| 不使用 `unattended` | 计划审批超时即作废（`expired`），不自动重放 |
| 审计可追溯 | 审批、路由、偏差、证据、迁移都有独立表与报告 |
| 归属校验（采纳） | 测试计划与 bug 修复必须校验"图/项目/会话归属"；`recipes:run` 等既有 IPC 补同样校验，防止跨工程触发 |
| 审批不串场（采纳） | 跨会话 `pending approvals` 必须按 subject ownership 过滤；不得把 A 项目的待审批计划展示到 B 项目 |
| 编排写路径仅 Tier 1（采纳） | 无写前审批回调的 adapter（Tier 2）只读或排队，不得降级执行写步骤；`degraded` 只用于手动会话（§5.9.5） |
| allow 命令的配置键测试（采纳） | 每条新增 allow 命令必须附"消费了哪些配置键"的测试，未附不得合入（§6.8.1） |
| E3/E2 证据不造假（采纳） | 只有执行后 worktree 仍干净 + worktree=base commit + 有 work_run 才能写 E3；否则确实执行过时写 E2，内容绑定 worktree 执行内容（tree + 实际改动）；零执行不写证据（§6.2.1） |
| 同 uid 威胁边界（G6-17） | 只承诺**跨 uid** 不可伪造/不可重放（HMAC + 0600 密钥 + 0700 目录 + DB marker）；**同 uid 恶意进程不在防御范围**，可读密钥伪造记录、直接 kill、替换文件、伪造 workspace lease 干扰写闸、读工作区/DB、TOCTOU。攻击者只需同本地账号可执行代码，不需 root；不构成提权。详见 `agent-architecture.md` §6.5.1；本文不写“已防御同 uid” |

需扩展的唯一安全相关结构：`agent_approvals` 的 `subject_type` / `subject_id` 与 `run_id`/`turn_id` 可空。改法见 §6.3 / §8.10；影响面为所有读取该表的查询与重启重推逻辑（测试计划审批不自动重放）。

#### 10.1 执行检查矩阵与 fail-closed（D 组施工）

| 阶段 | 检查 | 失败行为 |
|---|---|---|
| 计划创建 | 图/项目/会话归属、命令非空、无 `manual` 步骤 | 拒绝，不落 plan |
| 计划审批 | `args_hash` 一致、`subject_type='test_plan'`、未过期 | 拒绝/作废，不执行 |
| 单条执行 | `evaluateBashPolicy`、`evaluateGitDirWriteGuard`、cwd 限定、env 白名单 | 任一项 deny → 该条 `denied`，后续 `skipped` |
| 输出落盘 | 密钥正则脱敏、只存路径+hash | 脱敏失败 → 不落盘，run `error` |
| 证据写入 | §3.2 组合校验 + §6.2.1 E3 五条件 | 不满足 → 写 E2 或不写，绝不写假 E3 |
| 审批展示 | subject ownership 过滤 | 跨项目审批不展示、不可决策 |

总原则：所有检查默认拒绝（fail-closed），不得因“计划已批准”跳过单条策略门，不得复用会话授权，不得启用 `unattended`。验收：上表每行至少一条拒绝用例；已批准计划中的 `deny` 命令仍不执行。

---

## 11. 风险与开放问题

### 11.1 需要产品方知晓的三个风险

1. **重复导入导致身份漂移 —— 已在入口拦截。** 导入在写任何图数据之前做指纹查重，命中即拒绝（§2.6），不静默合并、不生成第二套 lineage。残余风险是**误判**：把"内容高度相似的不同项目"当成重复而拒绝（可申诉/换目录重试），或把"内容差异大的同一项目"放行（`ALLOW_WITH_WARNING` 会明确提示）。指纹只做"是否同一工作区/副本"的判定，**不证明业务实体同一**。分支/副本的"记住规则"必须可查看、可撤销，且每次命中都要标明来源，避免变成静默豁免。
2. **非 git 项目无法产生 E3（可复现验证）。** E3 要求"测试通过 + 代码 hash 绑定"，非 git 没有 git commit sha，最高只能到 E4 人工签收，永远不会有自动 `verified`。硬约束是展示/导出/看板必须按"可复现 / 不可复现"分组，E4 不得与 E3 混排；失效判据改为"覆盖文件内容哈希 + 覆盖范围 + 30 天过期"（§3.5），代码变更后只能判"覆盖内容是否变"。
3. **S4 是不可逆里程碑。** CHECK 扩展后旧二进制无法读取新库，回退只能恢复备份；且迁移期间重建 `graphs`/`nodes`/`edges` 三张大表，一旦中途失败必须整体回滚。缓解：发布前完成 P2/P3 演练与备份恢复演练；把 S4 单独作为一次发布，不与功能开关一起上线。

### 11.2 其他开放问题（有默认假设，不阻塞）

| 问题 | 默认假设 |
|---|---|
| 一个项目是否会出现多张 dev 图 | 默认不会（导入期查重）；唯一例外是用户显式确认（可"对同一指纹记住"）的不同分支/副本，各自独立 `entity_key` |
| test 图的节点是否需要人工状态 | 是，但只允许 `draft/confirmed/published` |
| 人工验收是否允许无 `code_version` 的 E4 | **允许**（产品方已定，§3.5）；E4 统一为人工签收、`reproducible=0`、显式标注"无代码 hash、不可复现" |
| E4 过期策略 | 统一 30 天、可配置；不按项目风险/类型区分（后续可选扩展，不进 L1） |
| `signed_by` 口径 | 本地用户标识；显示名可选，不强制真实姓名/角色 |
| 查重阈值（N=12、0.6/0.8） | **已定**：接受默认值，保持可配置，先按默认值上线 |
| `import_rejections` 留存期 | **已定**：明细 90 天，聚合计数永久 |
| 偏差校准的周期 | 按批次（每 20 个 run）或每 2 周（取先到者）离线统计，人工改配置（§5.7） |
| worktree 残留清理周期 | 失败现场保留 7 天，其余即时清理（可配置） |
| 平台范围 | 本期只验证 POSIX（macOS / Linux）；Windows 路径规则不承诺（A9） |
| 编排 MVP 的 Tier 范围 | **已定**：仅 Tier 1 参与编排（读 + 写）；Tier 2 只读或排队等人工会话，Tier 3 不参与 |
| 任务总 wall clock | 单个 `work_item` 累计 60 分钟（可配置），到期落 `timed_out`（§5.9.4） |
| `published` 软阻断 | **已定：软阻断**。不阻止人工标记 `published`，只影响徽标与统计口径（`published_without_evidence` 单列）；不做强制测试/二次确认（§6.5.2） |
| 流程级测试范围 | **已定：L2 起做最小版**。框选子图 → 每节点验证步 + shell 测试步 → `test_report`；不做可视化编排（§6.5.1） |

### 11.3 规模与保留策略（补充审查项）

| 对象 | 默认阈值 / 策略 | 说明 |
|---|---|---|
| 节点会话时间线 | 每页 50 条，按 `created_at DESC` 分页；不一次拉全量 | `map:node:timeline` 必须分页 |
| 节点证据列表 | 每页 50 条；超过 200 条时默认只展示最近 200 条 + "加载更多" | 不因证据多而拖慢叠加层 |
| `node_links` | 单节点 active 链接软上限 500（超过告警，不自动删除）；查询必须走键索引 | 链接是历史，不硬删 |
| `node_session_links` | 单节点软上限 200；超过提示"会话过多，建议归档旧会话引用" | 不删除会话本体 |
| `work_runs` | 按 lineage 分页；单任务展示最近 50 次尝试 | 历史保留，UI 分页 |
| 叠加层批量 | 每图单次 `map:overlay:get` 最多返回视口内节点；全图统计走独立聚合接口 | 避免 1000 节点全量 IPC |
| 测试输出 / 失败现场 | 失败现场保留 7 天；`test_results.output_ref` 指向的产物保留 90 天（可配置） | 超期清理只删产物，不删结果行 |
| `evidence_suggestions` | `dismissed` / `accepted` 保留 90 天后清理（可配置） | 审计需要可查一段时间 |
| `routing_decisions` | 保留 180 天（可配置） | 用于复盘，不是永久账本 |
| `plan_deviations` | **永久保留** | 阈值校准依赖长时间序列；只做归档不做删除 |
| `map_migration_reports` | **永久保留** | 迁移与回退审计 |

- 上述软上限只触发告警与 UI 提示，**不自动删除业务事实**；任何清理都必须有配置项与报告。
- 分页与批量接口的阈值写入配置，不硬编码在渲染层。

#### 11.3.1 清理任务、上限执行与验收（E 组施工）

| 任务 | 频率 | 选择条件 | 幂等/边界 |
|---|---|---|---|
| `evidence_suggestions` 清理 | 每日 | `status IN ('accepted','dismissed') AND resolved_at < now-90d` | 每批 ≤500；`pending` 永不删 |
| `routing_decisions` 清理 | 每日 | `created_at < now-180d` | 每批 ≤500；有报告行 |
| `test_results`/`test_runs` 清理 | 每日 | 终态且 `ended_at < now-90d` | 被 `node_evidence.ref_json` 引用的保留 |
| 失败现场/产物 | 每日 | 产物 mtime > 7d / 90d | 只删产物，不删结果行 |
| `map_migration_reports` 裁剪 | 启动+每日 | 每 `(kind,stage)` 保留最近 20 行 | `running` 永不裁；删除写 `cleanup` 行 |

上限执行：`node_links` >500/节点、`node_session_links` >200/节点只告警不删；分页默认 50、上限 500，非法值落默认。验收：每个清理任务重复执行不重复删；`pending` 建议与 `running` 报告行数量不变；配额告警可在 UI 查询。

---

## 12. 外部蓝图交叉验证记录（2026-11-07）

**来源**：`map-orchestration-blueprint.md`（**Zcode v1.2，364 行**，以附件形式提供，未入库）。本节的逐层对照基于该附件；§12.10–12.13 另行引用本地 **Zcode v1.2.1（勘误版，302 行）**，两者版本与行数不同，不混用。
**方法**：逐层对照；每层给结论；只采纳"补了缺失场景"或"把含糊处变可执行"的内容；已定口径不得被改写。

### 12.1 逐层对照结论

| # | 层 | 结论 | 依据与说明 |
|---|---|---|---|
| 1 | 概念模型 | 各有所长 | 对方以 `ExecutionRecord` 为绑定原子单元、强调节点活动流；我们以 `work_items` + `work_runs` + `node_links` + 证据为主线。已采纳其"执行记录视图"概念，但落到现有表上（§4.6），不新增表 |
| 2 | 表结构与主键/外键 | 我们更完整 | 我们有 **22 张新表**、revision/supersedes、key-based `node_links`；对方 test-case 用 `targets:[{graphId,nodeId}]`，node id 在克隆/重导后失效。采纳 `work_items`/`work_runs` 的依赖、结构化输出、attempt、deadline、`failure_class` 字段（§7.2）；**采纳 D2：步专属字段另立 `work_steps`**；驳回 `targets` |
| 3 | 迁移与版本 | 我们更完整 | 我们有 v24–v32、schema checksum、备份与回滚演练；对方无迁移/回退方案。不采纳 |
| 4 | 任务拆解与编排 | 各有长短 | 对方的**串行**执行机制（失败分类、超时、重启对账）完整且可执行；波次/并行/fanout 属 L3。我们的"结构推导 + 人工确认 + 可修订计划"更严。采纳**串行**执行机制（§5.9）；驳回"LLM planner 直接产出并执行 DAG" |
| 5 | 路由与执行 | 对方更完整 | Tier 1/2/3 能力票比"按能力矩阵选 adapter"更可执行；节点忙排队、幂等键、deadline 写入方都是缺口。采纳（§5.9.4–5.9.5） |
| 6 | 测试闭环 | 对方更完整 | 我们只到"回写失败"，对方补了 bug 闭环、定向重测、manual/LLM 用例分级、测试命令网关。采纳（§6.6–6.8）；但节点类型与跨图引用方式坚持我们的设计 |
| 7 | 多图与 `entity_key` | 我们更完整 | `entity_key`、`node_links`、导入查重是我们的核心，对方没有身份层。仅采纳其"dev→online 结构变更走提案"的方向（§2.7，L3 实现） |
| 8 | 状态机 | **直接冲突** | 对方主张"节点状态由任务完成事件自动推进"，与我们的状态双轨冲突。保持原设计：`nodes.status` 只由人写，任务完成只影响 `work_runs` 与派生状态。采纳其任务级 `failure_class` / `needs_human` / `interrupted`，并按 D2 在 S5 一次补齐 `needs_input` / `needs_human` / `paused` / `interrupted`；步级状态机见 §5.9.8 |
| 9 | 并发与冲突 | 各有长短 | 对方有全局写闸、并发上限、优先级队列；我们有隔离 worktree 与"同节点不并行"。按场景分工：agent 编排用写闸，测试执行用 worktree（§5.9.3） |
| 10 | 权限与安全边界 | 部分一致 | 都复用审批网关/Bash 策略/gitdir 保护。对方补了归属校验与"审批不串场"，这是我们的缺口。采纳（§6.8、§10） |
| 11 | 性能与规模 | 各有长短 | 对方有并发上限、波次调度、运行记录不入图；我们有索引设计、视口分页、批量 IPC。采纳上限，保留索引方案 |
| 12 | 交付节奏 | 不可直接映射 | 对方 P0–P4，我们 S1–S8/v24–v32。**采纳 D5：交付阶段 P1 先身份层（S1/S2），P2 编排脊柱（S5/S6，内置 D1/D3 护栏）**（§8.1.1）；P0 的源码缺陷不属本文；Yjs 已实施单向只读（`cc749ce`，§2.2.1），完全移除不在本期 |

### 12.2 采纳清单（已写入正文）

| 补充内容 | 对方为什么更好 | 落到章节 |
|---|---|---|
| ExecutionRecord 作为派生视图 + 节点活动流 | 补了"一次执行"作为产品可见单元，且明确 filesTouched 必须是确定性证据 | §4.6 |
| `depends_on_json` / `output_schema_json` / `checker_work_item_id` | 把 DAG 依赖、结构化输出、maker-checker 变成表结构可执行 | §7.2 |
| `attempt` / `deadline_at` / `interrupted` / `timed_out` / `partial_output_ref` / `output_parse` | 补了重试、超时、重启、失败保留部分产出 | §4.2、§7.2 |
| 单步/多步分流 | 避免小任务被过度拆解，同时不跳过人工确认 | §5.9.1 |
| `failure_class` 与重试策略 | 把"失败了怎么办"从含糊变成可执行表 | §5.9.2 |
| 全局写闸、并发上限、优先级队列、节点忙不重试 | 补了多任务并发时的写冲突与饥饿问题 | §5.9.3 |
| 启动对账、幂等键、取消传播 | 补了崩溃恢复语义 | §5.9.4 |
| Tier 1/2/3 能力票与降级明示 | 把"能力矩阵"从概念变成可判定规则 | §5.9.5 |
| Bug 闭环 + 定向重测 + 环境失败不建 bug | 补了测试失败后的完整链路 | §6.6 |
| `case_kind`（manual / llm_acceptance）分级 | 明确"人工验收型测试"只能到 E4，LLM 判定不能成为证据 | §6.7 |
| `TestCommandGateway` + 归属校验 + 审批不串场 | 补了安全边界，且指出 `recipes:run` 的既有缺口 | §6.8、§10 |
| dev→online 结构变更提案 | 补了"开发中发现产品结构要改"的缺失场景 | §2.7（L3） |
| 发布进度派生视图 | 补了项目级汇总，但我们加严为"不落库、不叫完成度、证据分组" | §3.6 |
| D2：`work_items` / `work_runs` 命名统一 + 步专属字段独立 `work_steps` | 把"任务"与"编排步"分层，避免把 `outputSchema` / `consults` / `checker` / `deadline` / `attempt` / `invocation_id` 塞进任务表导致身份与执行耦合 | §4.1.2、§7.2；表数 21→22 |
| D2：`work_items.status` 四值一次建齐 | 避免上线后再 `ALTER` / 重建；`needs_input` / `needs_human` / `paused` / `interrupted` 是编排必需状态 | §4.1.1、§7.2、§8.7 |
| D3：planner 分层与权重冷启动 | 复杂任务"候选推导 → 模型只选择 → 越界剔除入审计 → gates"，简单任务直接单步；默认权重 + `plan_deviations` 校准，避免在线学习 | §5.3、§5.7 |
| D5：交付阶段 P1 身份层 / P2 编排脊柱 | 先稳定身份与链接，再上编排；P2 内置 D1/D3 护栏 | §8.1.1 |
| D6：统一 `agent_approvals`，不设 `test_approvals` | 审批事实单一来源，避免两套状态与跨表对账 | §6.3、§7.1、§8.10 |
| D8：取消 `thread:<id>` 伪节点 | 未挂载会话保持纯 thread，挂载后才建会话；`node_id` 放宽列为长期待办 | §4.5；**已实施（`5938001`）** |
| DAG 正确性（环检测、Kahn 分层、依赖优先级、父任务聚合） | 补了"环会让队列永久 queued"这一致命缺口，并把聚合规则写死 | §5.5.1 |
| 取消语义（进程组杀灭、审批中/排队中可取消、竞态、下游传播、worktree 清理） | 把"取消"从改状态变成真杀进程，并定义竞态与部分产出 | §5.9.7 |
| 步级状态机 + `needs_input` 问题卡 | 状态变更即落库，等待用户输入不计失败、回答后开新 attempt | §5.9.8 |
| 流程级测试的可执行定义 | 把 flow 从描述变成有序可执行步骤，禁止人工/LLM 混入自动通过链 | §6.5.1 |
| `published` 软阻断 | 无通过记录时默认不发布，允许显式豁免并落库 | §6.5.2 |
| 任务总 wall clock 60 分钟 + 队列重排/aging | 防单任务无限重试与长任务饥饿 | §5.9.4、§11.2 |
| 路径规范化（realpath + NFC + 大小写 + 分隔符） | 统一 G1/G6/scope_files/fileAssociations/change_sets/node_links，消除"同名不同串"误判 | §5.4.1 |
| 迁移状态机与半迁移恢复 | 逐阶段 started/completed/failed、心跳、孤儿 `_backup` 检测与续跑边界 | §8.14 |
| 规模与保留策略 | 分页阈值、软上限、产物/建议/路由的保留期，避免叠加层被历史拖垮 | §11.3 |
| 假 E3/假 E2 修复 | 把"worktree 只含基线 commit 却记 E3"和"拿主工作区 dirty 当执行内容绑定"两类假证据堵死；E2 绑定 worktree 实际执行内容，零执行不写 | §6.2.1 |
| `change_sets` 进 L1 | 解决 §4.6 与 §8.12 的矛盾：既然 `filesTouched` 只认它，L1 必须建 | §4.6、§8.12 |
| allow-list 配置键测试 | 防止测试命令悄悄读取凭据/改变行为而不被发现 | §6.8.1 |

### 12.3 驳回清单与理由

| 对方主张 | 驳回理由 |
|---|---|
| LLM planner 直接产出 TaskDAG 并执行 | 与已定的"结构推导 + 人工确认 + 可修订计划"冲突；无人工确认的自动 DAG 会把模型猜测当成分解事实 |
| 节点状态由任务完成事件自动推进 | 与状态双轨冲突；"任务完成"不等于"节点完成"，正是"漂亮但说谎"的来源 |
| test-case `targets` 用 `graphId + nodeId` | node id 在克隆、重导、重建后都会变；必须坚持 `entity_key` + `node_links` |
| 新增 `test-flow` 节点类型 | 与现有 `test-suite` 语义重叠，且会再次触发 `nodes.type` CHECK 重建；用 suite 表达 flow |
| MVP 不做 worktree | 与 TestExecutor 隔离执行原则冲突；只在 agent 编排阶段采纳共享工作区 + 写闸 |
| review gate 直接计入"已验证" | LLM 验收 + 人工确认不能等价于"测试通过 + 代码 hash"；按 §6.7 降级映射到 E2/E4 |
| 以"已拆除 Yjs"为前提裁剪 P6 / 改 RequestQueue | **Yjs 已实施单向只读（`cc749ce`）**：写回已断开、WS 写消息 1008 拒绝、doc 变更不落库；SQLite 权威列不变（§2.2.1）。完全移除不在本期。P6 验收改为"默认启动下写消息被拒、doc 变更不落库"，SQLite 镜像验证并行。外部拆除方案本文不背书也不反驳。`RequestQueue` 已删除（`80075e7`），派发由 `WorkItemService` 队列承担（§12.7） |
| Tier 2 降级执行写步骤 | 无写前审批回调就无法满足"不绕过审批网关"；Tier 2 只能只读或排队等人工会话，`degraded` 只用于手动会话（§5.9.5） |
| 运行记录只放 artifacts、不进图 | 我们本就没有把 run 做成图节点（`test_runs`/`test_results` 是表），方向一致，无需改 |

### 12.4 对已定八条口径的冲突检查

| 已定口径 | 外部文档是否触及 | 结论 |
|---|---|---|
| 查重阈值与判定顺序 | 未触及 | 保持 |
| 拒绝明细 90 天 + 聚合永久 | 未触及 | 保持 |
| E4 统一 30 天过期 | 未触及 | 保持 |
| 分支/副本"记住放行" | 未触及 | 保持 |
| 图删除后重建判据 | 未触及 | 保持 |
| L1 不开放删除节点 | 未定义删除语义 | 保持 |
| E3 / E4 的"可复现 / 不可复现"语义 | **触及**（review gate、published gate 把 LLM 验收/人工确认计入进度） | **不采纳其混同**，按 §6.7 降级映射；原口径不变 |
| `signed_by` 取值 | 未触及 | 保持 |

**结论：本次交叉验证未改写任何一条已定口径，不需要重新审批。**

### 12.5 原待拍板项（现已全部裁决）

> 五条裁决（U1、F3、`plan_deviations` 归因、`work_items.status`、Tier1/`published`/流程级测试）已落入正文。R7 覆盖项（F1–F3 修复授权、发布进度仅内部展示、dev→online 提案 UI 留 L3）已拍板，从待定移除；E4 过期不延后也已定。Yjs 单向只读已由 `cc749ce` 在代码层实施。**本节四条于 2026-11-08 由 D-13…D-16 裁决；方向已定，施工仍未授权。**

1. **D1 计划确认强度**：简单单步内联 mini-C1 vs 全量 C1 对话框。**D-13 已裁决：C 仅高风险步确认**（方向已定，未授权施工）。
2. **D4 流程折叠**：suite/case + `test_specs.kind='flow'`；折叠层级与默认展开方式。**D-14 已裁决：A 折叠**（方向已定，未授权施工）。
3. **F3 超时默认值来源**：是否引入配置键 `agent.timeouts.turnMs`（现状是代码常量 `DEFAULT_AGENT_TIMEOUTS.turnMs`）。**D-15 已裁决：A 设配置键**（方向已定，未授权施工）。
4. **两层 partial 截断是否统一**：地图侧常量 `PARTIAL_FIELD_MAX_BYTES = 16KB` / `PARTIAL_TOTAL_MAX_BYTES = 64KB`（`work-run-service.ts:66-67`）vs 子代理侧常量 `MAX_OUTPUT_ENTRY_SIZE = 10_000` 单条（`base.ts:40`）。**D-16 已裁决：A 统一 16KB**；两套值仍待施工改造（方向已定，未授权施工）。

### 12.6 第二轮独立审查：六项必须改的改法

| # | 问题 | 选定改法 | 落点 |
|---|---|---|---|
| 1 | 假 E3 / 假 E2：worktree 从基线 commit 创建，主工作区未提交改动不在 worktree，测试却记 E3；失败分支又拿主工作区脏哈希当 E2 内容绑定 | **fail-closed**：L1 的 worktree 固定 detach 在 `base_commit`，不应用工作区 diff；E3 五条判据写死（执行后 worktree 仍干净 + 全过 + work_run），否则真实执行过只写 E2，`current_hash` = 执行内容指纹（tree + worktree 内实际改动），零执行不写。禁止"先记 E3 再降级" | §6.2、§6.2.1；`ref_json.worktreeCommit` / `worktreeTree` / `executedContentHash` / `worktreeDirtyFiles` |
| 2 | L1 的 `change_sets` 矛盾（§4.6 只认它，§8.12 不建） | 二选一后选择 **`change_sets` 进 L1**；活动流保留文件展示，不降级为"不展示文件" | §4.6、§8.12；L1 表数 11→13 |
| 3 | 取消只改状态，没杀进程；排队/审批中不可取消；下游错记 `blocked` | 补真杀**进程组**（TERM→10s→KILL）、`awaiting_approval` 可撤销、取消/完成竞态用条件更新、下游 `cancelled(reason='upstream_cancelled')`、partial 先落库、取消即清 worktree；给出迁移表 | §5.9.7；`work_runs.cancel_requested_at` / `cancel_reason` |
| 4 | DAG 无环检测，环会让队列永久 `queued`；依赖顺序与父任务聚合未定义 | 计划确认时环检测拒绝；Kahn 分层；`显式 depends_on > 隐式引用 > 数组顺序`；父任务"全部叶子终态 ∧ ≥1 failed → failed" | §5.5.1 |
| 5 | Tier 2 降级执行写步骤与"不绕过审批网关"冲突（无写前审批回调） | **编排写路径仅 Tier 1**；Tier 2 只读或排队等人工会话；`degraded` 只用于手动会话；MVP 仅 Tier 1（已定） | §5.9.5、§10、§11.2 |
| 6 | allow 命令扩展无"消费哪些配置键"的测试 | 新增纪律：每条 allow 命令必须附配置键消费测试，未附不得合入 | §6.8.1、§10 |

### 12.7 第二轮审查：八项建议落点

| 建议 | 落点 |
|---|---|
| 步级状态机（`planning` / `review` / `paused(infra)` / `needs_input` + `waiting_approval` / `succeeded` / `timed_out`），状态变更即落库 | §5.9.8；`work_steps.status` |
| 流程级测试的可执行定义 | §6.5.1 |
| `published` 加"测试通过"软阻断 | §6.5.2 |
| `needs_input` 问题卡与下一 attempt | §5.9.8；`work_steps.input_request_json` |
| 任务总 wall clock 60 分钟与队列重排 | §5.9.4、§11.2 |
| 路径规范化（realpath + 大小写折叠 + NFC + 分隔符），统一 G1/G6/`scope_files`/`fileAssociations`/`change_sets`/`node_links` | §5.4.1；`change_sets.dirty_tree_hash`（文件面证据） |
| 迁移状态机（逐阶段 started/completed/failed、半迁移拒绝启动、孤儿 `_backup` 检测与续跑） | §8.14；`map_migration_reports.stage` / `heartbeat_at` |
| 规模与保留策略（每节点上限、分页阈值、retention） | §11.3 |

### 12.8 记录不改（六项）

| 项 | 结论 | 说明 |
|---|---|---|
| Yjs | 依赖/表/schema **不删不改**；单向只读 | **已实施（`cc749ce` + `987c226`）**：写回模块删除、WS 写消息 1008 拒绝、doc 变更只落 `yjs_snapshots`；**1236 默认不监听已实施（`987c226`）**（`yjs-realtime.ts` 按 `BIZGRAPH_YJS_WS` 判定，`ipc-handlers.ts:348` 无 options，§2.2.1）。完全移除不在本期；P6 验收＝"默认启动下 `1236` 不监听、doc 变更不落库"，SQLite 镜像并行 |
| RequestQueue 删除 | 记录不改；由 `WorkItemService` 队列取代 | **已删除**（2026-11-09，`80075e7`）；D-07 维持 fail-fast，不引入队列 |
| 进化三层与 `review_queue` | L3+ 非本期 | 不写入 L1/L2 范围 |
| `ContextBundle` 与尾块协议 | 不在本文定义 | 交叉引用 `agent-architecture.md`（§0.1） |
| planner 主路径 | 保持现有路径 | 但明确：模型做候选选择时输出仍需 schema 校验 + 修复 1 轮（§5.3） |
| Windows 路径 | 明确平台范围 | 本期只验证 POSIX；Windows 规则不承诺（A9、§5.4.1） |

### 12.9 待回传外部方案的异议清单

> 以下只记录我方异议与依据，不把外部文档提交进仓库；等对方确认后再改其记录。

| # | 外部记录 | 我方异议 | 依据 |
|---|---|---|---|
| Q3 | "执行期机制全采纳" | 应为 **"串行执行机制全采纳"** | 本文 L1/L2 明确不做流程级 DAG 并行、不做并行写同一节点、不做多 Agent 并行编排（§1.8）；并行/fanout 属 L3 |
| Q6 | 章节引用错误 | 流程级测试的可执行定义在 **§6.5.1**，不是 suite 本身 | §6.5.1 定义 `test_specs.kind='flow'` 的执行口径；`test-suite` 只是资产容器 |
| Q11 | 载体是 suite | 应为 **`test_specs.kind='flow'`** | 流程级测试要绑定多节点与步骤序列，suite 本身不承载 flow 语义 |
| 表数 | 仍写"21 张表" | 我们已是 **22 张**；L1 最小集 **13 张** | §8.12 与 §7.2；D2 新增 `work_steps` 后总数 22 |
| P6 / 伪节点 | 仍标"不可用" | **Yjs 写消息拒绝：已实施（`cc749ce`）**；**1236 默认不监听：已实施（`987c226`）**；**伪节点取消：已实施（`5938001`）**，写入侧不再生成 `thread:<id>`（§4.5 D8） | §4.5、§2.2.1、§8.11；完全拆除才属 L3（§2.8） |
| R5 汇总 | "24 可用 / 8 待商议 / 2 不可用" | 应为 **24 可用 / 5 已裁决落地（D2/D3/D5/D6/D8）、2 待拍板（D1、D4）/ 0 不可用（2 项已处置）** | §12.5；D1/D4 仍待拍板 |
| `NODE_STATUS_CHANGE` | "无消费者" | 精确为"**有转发链（preload 与 sessionStore 均 re-emit），无 `node:statusChange` 订阅者**" | `src/preload/index.ts:315`、`src/renderer/store/sessionStore.ts:190`、`src/renderer/store/eventBus.ts:34`；2026-11-07 复核 |

### 12.10 Zcode v1.2.1（302 行，本地快照）逐节评估：明确不采纳

| 主张 | 不采纳理由 |
|---|---|
| Tier 2 以 `workspace-write` 执行写步骤 | 推翻"编排写路径仅 Tier 1"，等于给无写前审批的后端开后门（§5.9.5） |
| "drop 迁移单提交 revert 即可" | 代码可回退，已删除的行/列数据回不来；必须先备份并演练恢复（§2.8） |
| 纯百分比上下文预算 | 无总预算与 tokenizer 口径，是伪精度；按 §5.9.8.1 的固定增量 + 裁剪顺序 |
| embedding ≥0.85 与"路径转 glob" | 无数据模型、无算法、无验证方式；不落表也不落规则 |
| 整表术语对照 | 含错误映射（把 `task_steps` → `work_runs`，应为 `work_steps`）与陈旧主张；只按 §5.9.11 / §4.2 的字段对齐，不做整表搬运 |
| `needs_input` 未入值域 | 已定 13 个 `work_items.status`，不重开；`needs_input` 早在 D2 建齐 |
| 伪节点本期保留 | D8 裁决要求取消，**已实施（`5938001`）**；不回收该主张 |
| 其 L1/L2 表切分 | 与我们 L1 13 表冲突；`change_sets` / `work_steps` 必须在 L1 |
| `StageOverride.replace('extract')` | `pipeline.ts` 是字段映射而非方法调用，照写编译失败 |
| "turn 事件流监控点" | 没说是谁跑、多久一次、如何防并发重复杀；按 F3 的单一 deadline 执行者 |

### 12.11 Zcode v1.2.1（302 行）的事实性提醒

- **引用口径**：`Zcode v1.2`（被审附件，**364 行**）与本地 `Zcode v1.2.1`（勘误版，**302 行**）是两个不同版本；`1809` / `2051` / `3209` 分别是对本文 R5 / R6 / v1.2 写作时的**不同时点**行数，不混用。本文 v2.3 当前 **5574 行**（2026-11-09 `wc -l` 复核；随改动继续变化）。凡与本文冲突处，以本文当前版本为准。
- 其关于 Yjs WS 缓解、输出上限的具体数字**不采用**；Yjs 事实只以 §2.2.1 的 `cc749ce` 复核结论为准，测试范围只以 §2.8 的 **9 个测试文件 / 119 个 `it(`**（2026-11-07 复核）为准。
- 该版本把 "E4 在有真实测试时由 E3 替代" 写进方案，与我们"可复现 / 不可复现分离、不互相替代"冲突，不采纳（§3 / §6.7）。

### 12.12 Zcode v1.2.1 同步项（已落正文）

> 引用版本：**Zcode v1.2.1，302 行（本地快照）**。以下均已按三态词标注。

| 事项 | 状态 | 落点 |
|---|---|---|
| D2/D3/D5/D6/D8 在对方侧已落定：`work_steps` 独立表、伪节点取消（D8）、`work_items.status` 13 值含 `needs_input` | **全部已实施**：D8（`5938001`）；D2/D5a（`work_steps` 表）/D6（subject 扩展）/D3（推导冷启动权重）随 **v28/v31/v32 批次落地**（Zcode L1/L2，见其蓝图 §9 总账）；D1/D4 已裁决（D-13/D-14），但施工未授权 | §4.1.1、§4.5、§4.7、§12.5 |
| U1：过期 E4 → `stale` | **已实施**（v29 派生引擎,Zcode L1 S6a 批次） | §3.5、§3.7.3 |
| Yjs 单向只读（写回删除、WS 写消息 1008、1236 默认不监听） | **已实施**（`cc749ce` + `987c226`） | §2.2.1、§8.11 |
| F3-A：`failed` + `failure_type='timeout'`，不碰 `cancelTurn` | **已实施**（`e921977`） | §8.15 |
| D1 计划确认强度、D4 流程折叠 | **已裁决（方向）**：D-13 → C 仅高风险步确认；D-14 → A 折叠；**仍未授权施工** | §12.5、I.4 |
| F3 默认值来源、审批期 deadline 暂停机制 | **F3 默认值：D-15 已裁决 A 设配置键**（`agent.timeouts.turnMs`，仍未授权施工）；**审批期=候选 A 冻结重算，已实施**（`7e6e63f`） | §8.15、§12.5 |

### 12.13 勘误清单（供 Zcode 按 R9 逐条修正）

> 引用口径：被审附件 **Zcode v1.2，364 行**（行号逐条核自该附件）；对方现行勘误版 **Zcode v1.2.1，302 行（本地快照）**。A 表只收**事实错误**；C 表收"不采纳 / 不可执行"，不混排。B 表只记行号偏移。

**A. 事实错误 8 条**

| # | 对方位置（v1.2，364 行） | 原句 | 我方证据 | 判定 |
|---|---|---|---|---|
| A1 | L280（另 L56、L125） | "WS server（1236）…前置缓解已上" | 复核时（2026-11-07）`BIZGRAPH_YJS_WS` 全库无命中；`yjs-realtime.ts:70` 为 `disableWebSocket ?? false`；`:107` 未禁用即启动；`ipc-handlers.ts:348` `new YjsRealtime(db)` 无 options（现已在 `987c226` 实施默认不监听） | 事实错误：该缓解从未实施；`cc749ce` 已以单向只读取代，`987c226` 补上默认关闭 |
| A2 | L107 | "截断上限 1MB，与现有输出上限一致" | `BaseAdapter.MAX_OUTPUT_ENTRY_SIZE=10_000`（`base.ts:40`，单条 10KB）；1MB 属 `recipe-runner.ts:189,196` 的 shell stdout/stderr | 事实错误：现有 subagent 截断不是 1MB |
| A3 | L285 | "`realtime/snapshot/`（约 1070 行）" | `git ls-files 'src/main/realtime/snapshot/**' \| grep -v __tests__ \| xargs wc -l` → **1208 行**（5 个非测试文件：`snapshot-persistence.ts` 93、`snapshot-store.ts` 209、`ws-server.ts` 263、`yjs-document.ts` 414、`yjs-realtime.ts` 229） | 事实错误：少报 138 行 |
| A4 | L29 | "通读 1809 行" | 1809 是 `a60355a` 之前时点；本文当前 **5574 行**（2026-11-09 `wc -l` 复核） | 事实错误：R5 结论建立在过期快照上，须按现文本复审 |
| A5 | L288 | "约 86 个 Yjs 专测" | `rg -c "\bit\("`：**9 文件 / 119 个 `it(` 声明**（`src/main/realtime` 8 文件 = 112 + `services/__tests__/conflict-reporter.test.ts` 7）；`git grep -c "it("` 子串法 8 个 realtime 文件为 116（含 4 行非声明匹配） | 事实错误：86 无对应口径 |
| A6 | L360 | "`needs_input` 未入 status 值域（delta，待确认）" | 本文 §7.2 / §5.9.8：`work_items.status` **13 值**已含 `needs_input`（D2 一次建齐） | 事实错误：已入值域 |
| A7 | L348 | 术语映射 "tasks / task_steps → work_items / work_runs" | D2：步专属字段落 **`work_steps`**；`work_runs` 是执行记录 | 事实错误：错误映射 |
| A8 | L134–L135 | L1 只列 `work_items` / `work_runs` / `node_session_links` / `routing_decisions` 4 表；`change_sets` 放 L2（S5b） | 本文 §8.12：L1 **13 张**，含 `work_steps`、`change_sets`（`5b26715` 裁决） | 事实错误：L1 切分冲突 |

**B. 仅行号偏移的 4 条（结论不变）**

| # | 对方位置（v1.2.1 行） | 原句 | 我方事实 | 判定 |
|---|---|---|---|---|
| B1 | L30 | "通读 1809 行"作为现况 | 1809 是 `a60355a` 之前时点；本文当前 **5574 行**（2026-11-09 `wc -l` 复核） | 仅快照过期（同 A4；A4 按事实错误判定，B1 只记行号面） |
| B2 | L279 | "基于 1809/2051 行时点快照" | `1809` / `2051` / `3209` 是不同时点，不混用 | 仅行号偏移 |
| B3 | L5、L21 | "当前 3209 行" | 3209 是 v1.2 写作时点；本文当前 **5574 行**（2026-11-09 复核） | 仅行号偏移 |
| B4 | L279 | 章节号引用（§12.2 / §12.3 等） | 章节内容未变，行号随增删移动 | 仅行号偏移；引用应以章节标题定位 |

**C. 属"不采纳 / 不可执行"，非事实错误（仅供其内部修订参考）**

| # | 对方位置（v1.2，364 行） | 原句 | 我方结论 | 性质 |
|---|---|---|---|---|
| C1 | L119 | "调 runtime 现有 `cancelTurn` → `finalizeTurnStatus` … `status='failed'`" | `runtime.ts:766-771`：`cancelTurn` 内部已做终态 CAS 写 `cancelled`/`aborted`，二次 CAS 返回 false，超时永远落不了 `failed`；已改 F3-A 专用超时路径 | 执行方案缺陷（我方已纠正），非对方事实写错 |
| C2 | L245 | "数据源 … 全部现成，聚合查询新造" | `agent_logs` 无 `work_item_id`（`database.ts:484`）；`subagent_invocations` 无任务连接（`database.ts:592`）；必须经 `node_session_links` 归因 | 表面具体但不可执行 |
| C3 | L229 | "E4 仅有真实测试时由 E3 替代" | 与本文 §3.5 / §6.7"可复现（E3）与不可复现（E4）分离、不互相替代"冲突 | 口径冲突，不采纳 |
| C4 | L291 | "单提交 revert 即可" | revert 只回代码，不回已 DROP 的行/列数据；须备份 + 演练恢复 | 错误承诺，不采纳 |

## 13. 覆盖审计（2026-11-07）

> 审计基线：本文件 B1 补齐前的 2045 行版本；本轮新增/改写的 §2.2.2、§2.3.1、§2.8、§3.7、§4.7、§5.7、§5.9.x、§6.5.x、§6.8.x、§8.14.1、§8.15 按补齐后形态一并列出。逐节复核后按"可施工 / 有框架缺细节 / 只有结论 / 空挂"四类判定。判定标准从严格：**只有能回答"每个字段类型、约束、谁写、何时写、写失败怎么办、怎么验收"才算可施工**。B1/B2 补丁已把大部分"有框架缺细节"推进到可施工；本表同时标注缺口归属。

**汇总**：共 102 行；可施工 **59 节**；**已实施 20 节（2026-11-08 按代码把 16 行更正为已实施；2026-11-09 E 组把 §8.3/§8.4/§8.7/§8.8 的 DDL/服务级实现补登为已实施）**；有框架缺细节 **0 节**；只有结论 23 节；空挂 0 节。2026-11-09 D 组已把 §3.1–§3.5、§6.2–§6.7、§7.2（B2 表）、§9.2–§9.5、§10 共 17 节补到可施工（见各节末「D 组施工」小节）；E 组已把 §8.1.1、§8.3–§8.12、§8.14、§11.3 共 13 节补齐（见各节末「E 组施工」小节）；B3 已补齐 §2.8、§5.9.8.1（§2.8.1/§5.9.8.2），**审计表已无「有框架缺细节」残留**。B1 相关缺口已落到 §2.2.2、§2.3.1、§3.7、§4.7、§8.14.1、§8.15；B2 已落到 §5.7、§5.9.x、§6.5.x、§6.8.x；五条裁决已定案，相关行不再标待定。

> **状态列更正（2026-11-08，以代码为准）**：以下 15 行原标“有框架缺细节”，与代码事实不符，现按 **已实施（DDL/服务级）** 读；其行为验收/边界用例转入 Part I I.3（W2/W4/W12）。**2026-11-09 G10-1 各主题组已完成落表**（A/B/C/D/E/B3 组）。
> §1.1（`NodeType` CHECK `database.ts:781`；跨图拒绝 `hierarchy-service.ts:90-96`）、§1.2（v26）、§1.3（v27）、§2.1、§2.2（生成/回填两行）、§2.3（`link-service.ts:216`）、§5.4（`b6f3735`）、§7.1（v26–v35）、§7.2（B1 表）、§8.3（S1）、§8.4（S2）、§8.7（S5）、§8.8（S6）、§8.15（F1–F3）。另 §7.3 值域 CHECK 已落地（`database.ts:1184-1190`），一并更正；合计 16 行。

| 章节 | 现有内容形态 | 缺什么 | 属于哪一批 |
|---|---|---|---|
| §0.1 文档分工 | 只有结论 | 无施工内容；只需保持与 `agent-architecture.md` 的引用一致 | — |
| §0.2 链接 vs 完成度 | 只有结论 | 无；原则已可直接约束实现 | — |
| §0.3 默认假设 | 只有结论 | A1/A2/A9 已转验收用例（§0.3.1，G10-2 收口）；A3/A4 边界已登记并补并发/超时用例（§0.3.2，G10-3 收口） | B1 / B2 |
| §1.1 三图 | 已实施（DDL）+ 契约补齐 | 值域与节点类型矩阵已落 CHECK（§1.1.1 复核）；**通用 `edges` 写入的跨图校验待编码**（§1.1.1 第 4 条） | B1（复用现状），S4 在 B2 |
| §1.2 `entity_key` | 已实施（v26） | 无；§2.2.2 S1-a/S1-c 已给生成点、写入时机与回滚 | B1 |
| §1.3 `node_links` | 已实施（v27） | 无；§2.3.1 已给写入流程、矩阵与巡检 | B1 |
| §1.4 状态双轨 | 可施工（§3.7.1–§3.7.5） | 无；等级组合校验已实施（G5-9），派生算法/重算触发已定 | B1 |
| §1.5 任务对象 | 可施工（§4.7 S5a） | 无；写入权、状态迁移、事务边界、竞态已齐 | B1 |
| §1.6 拆解机制 | 只有结论 | 候选算法、模型输出 schema、确认接口、gate 失败分支 | B2 |
| §1.7 TestExecutor | 只有结论 | 执行接口、审批 subject、worktree 生命周期、失败分支 | B2 |
| §1.8 本期范围 | 只有结论 | 无；范围声明本身不需施工 | — |
| §2.1 唯一性维度 | 已实施（v26） | 无；迁移与回滚见 §2.2.2 S1 | B1 |
| §2.2 生成/保留/回填 | 已实施（v26） | 无；配对/占位/冲突/幂等见 §2.2.2 S1-c | B1 |
| §2.2.1 Yjs 写回事实 | 只有结论 | 无施工内容；**已实施（`cc749ce`）**，验收口径已改为"写消息被拒、doc 变更不落库" | — |
| §2.2 旧库回填算法 | 已实施（v25/v26） | 无；项目事务/并发冲突/ambiguous 报告/续跑见 §2.2.2 S1-d | B1 |
| §2.2.2 S1 施工细则 | 可施工 | 无；导入路径仍需代码，但字段/事务/回滚/验收已齐 | B1 |
| §2.3 `node_links` 设计 | 已实施（v27） | 无；`link-service.ts:216` 落写入矩阵与唯一性 | B1 |
| §2.3.1 S2 施工细则 | 可施工 | 无；拆分/合并传播与回填判据已齐 | B1 |
| §2.4 生命周期 | 可施工（§2.4.1） | 无；节点/图状态机、图删除拒绝、巡检频率与报告已给 | B1 / B2 |
| §2.5 链接不等于完成度 | 只有结论 | 无 | — |
| §2.6 重复导入 | 已实施（G1-4） | 无；抽样、读失败、TOCTOU、事务与拒绝留痕见 `import-dedup.ts:442,491,517,548` | B1 |
| §2.6 已定规则 | 只有结论 | 无；拒绝不合并是已定口径 | B1 |
| §2.6 指纹组成 | 已实施（G1-4） | 无；N=12 抽样索引、二进制/超大文件、缺失信号已落 | B1 |
| §2.6 判定顺序 | 已实施（G1-4） | 无；并发重查、错误分支、`matched_signals_json` 已落 | B1 |
| §2.6 执行位置/原子性 | 已实施（G1-4） | 无；`BEGIN IMMEDIATE`、同事务建图、冲突回滚已落 | B1 |
| §2.6 数据结构 | 只有结论 | DDL 指向 §7.2；无独立施工内容 | B1 |
| §2.6 与 S1 关系 | 只有结论 | 无；硬前置已明确 | B1 |
| §2.7 提案机制 | 只有结论 | 提案 UI、采纳/驳回状态、撤销语义 | B3 |
| §2.8 Yjs 拆除清单 | 可施工 | 无；逐文件/依赖/测试清单、弃用声明、L3 决策记录见 §2.8.1；拆除决策仍待 L3 单独立项 | B3 |
| §3.1 双轨边界 | 可施工 | 无；两条写入路径的关闭方案与验收断言见 §3.1.1 | B1 |
| §3.2 证据等级 | 可施工 | 无；等级字段组合校验、禁止降级见 §3.2.1 | B1 |
| §3.3 派生优先级 | 可施工 | 无；输入集合、tie-break、`inputs_hash` 见 §3.3.1 | B1 |
| §3.4 建议机制 | 可施工 | 无；转证据事务、去重、裁决字段见 §3.4.1 | B1 |
| §3.5 非 git E4 | 可施工 | 无；写入校验、到期扫描、续签语义见 §3.5.1；覆盖哈希扫描仍待实施 | B1 |
| §3.5 硬约束/字段/撤销/关系/非 git | 只有结论 | 规则本身完整；缺执行检查与任务调度落点 | B1 |
| §3.6 项目进度 | 只有结论 | 权重配置、只读查询、缓存与 `computed_at` | B2 |
| §3.7 S6a 施工细则 | 可施工 | 无；U1 定案、字段/校验/重算/验收已齐 | B1 |
| §4.1 `work_items`/revision | 可施工（§4.7.2–§4.7.3） | 无；revision 事务、`is_current` 唯一、修订与 running 冲突已给 | B1 |
| §4.1.1 状态值域 | 可施工（§4.7.2） | 无；13 状态迁入/迁出、条件更新、父任务聚合已给 | B1 |
| §4.1.2 `work_steps` | 可施工（§4.7.4） | 无；字段默认值、步级唯一、attempt/invocation 写入方已给 | B1 |
| §4.2 `work_runs` | 可施工（§4.7.5） | 无；run_seq、幂等键、终态竞态、partial 结构已给 | B1 |
| §4.3 `node_session_links` | 可施工（§4.7.6） | 无；NULL 唯一、挂载/结束时机、多会话时间线已给 | B1 |
| §4.4 `change_sets`/`routing_decisions` | 可施工（§4.7.7–§4.7.8） | 无；采集算法、dirty hash、未采集留空、路由失败不写半条已给 | B1 |
| §4.5 与 `agent_*` 关系 | 可施工（§4.5.1） | 无；turn 解析链、伪节点守卫、自由聊天边界与验收已给 | B1 |
| §4.6 活动流 | 可施工（§4.6 + §4.7.7） | 无；`change_sets` 字段/采集、未采集展示、多 thread 聚合已给 | B1 |
| §4.7 S5a 施工细则 | 可施工 | 无；写入权、13 个任务状态、12 个步状态、幂等与验收已齐 | B1 |
| §5.1 总览 | 只有结论 | 无 | — |
| §5.2 候选推导 | 可施工 | 候选存储、算法伪代码、权重默认值、边界失败已给（§5.2） | B2 |
| §5.3 模型只选择 | 可施工（§5.3.1） | 输出 schema、越界剔除、修复 1 轮与 D7 兜底已给 | B2 |
| §5.4 准入 gate | **已实施**（`b6f3735`；G1–G6 引擎 + 逐道诊断落库） | 仅剩 G3 跨图扩展、异步时限预算、版本精确归因（L3） | B2 |
| §5.4.1 路径规范化 | 可施工 | POSIX 边界、`realpath` 失败回退、NFC/大小写折叠已给 | B2 |
| §5.5 可修订计划 | 可施工（§5.5.2） | revision 状态、DAG 环检测、父子聚合的实现已给 | B2 |
| §5.5.1 DAG 正确性 | 可施工（§5.5.2） | Kahn 伪代码、依赖优先级冲突、终态聚合验收已给 | B2 |
| §5.6 确认点 | 可施工（§5.6.1） | C1–C4 接口、计划快照、确认/退回状态已给 | B2 |
| §5.7 偏差度量 | 可施工 | 归因口径、单一聚合窗口、字段/视图与采集时点已齐 | B2 |
| §5.8 退化兜底 | 可施工（§5.8.1） | D1–D7 触发判据、执行落点、报告写入与验收已给 | B2 |
| §5.9 执行编排 | 可施工 | 调度 tick、接口输入输出、错误码与失败分支已齐（§5.9.9） | B2 |
| §5.9.1–5.9.8 子节 | 可施工 | 单步/多步、失败分类、忙重排、deadline、Tier 票、取消竞态、步状态迁移已齐 | B2 |
| §5.9.8.1 黑板/Phase B/fanout | 可施工 | 无；黑板数据结构、Phase B 接口与 fanout 边界见 §5.9.8.2 | B3 |
| §6.1 边界与复用 | 只有结论 | 无；复用声明本身不需施工 | B2 |
| §6.2 执行流程 | 可施工 | 无；步骤接口、worktree 生命周期、超时与失败分支见 §6.2.2 | B2 |
| §6.2.1 E3 判据 | 可施工 | 无；五条判据与 dirty 降级已可执行 | B2 |
| §6.3 审批 subject | 可施工 | 无；重建迁移、subject 取值、回调幂等见 §6.3.1 | B2 |
| §6.4 安全约束 | 可施工 | 无；执行前检查与 fail-closed 验收见 §6.4.1 | B2 |
| §6.5 测试资产与回写 | 可施工 | 无；资产创建/更新、回写事务、证据重试见 §6.5.3 | B2 |
| §6.5.1 流程级测试 | 可施工 | **测试-only**：flow spec 的拓扑序、失败判定与 `test_report` 聚合已由集成测试覆盖（§6.5.1.1）；**flow 计划生成未做**，`selected_by='flow'` 与 CHECK 扩张按 II-13 明确不做 | B2 |
| §6.5.2 `published` 软阻断 | 可施工 | 判定、徽标、豁免与回滚已齐（§6.5.2.1） | B2 |
| §6.6 Bug 闭环 | 可施工 | 无；bug 创建、定向重测、回写契约见 §6.6.1 | B2 |
| §6.7 手工用例/E4 | 可施工 | 无；手工执行记录、E4 签收与边界见 §6.7.1 | B2 |
| §6.8 测试命令网关 | 可施工 | 计划创建/审批/执行接口、错误码与失败分支已齐（§6.8.2） | B2 |
| §6.8.1 allow-list 纪律 | 只有结论 | "配置键消费测试"的 harness、覆盖清单、CI 门禁 | B2 |
| §7.1 既有表变更 | 已实施（v26–v35） | 无；列迁移、回填、索引、旧库兼容已落 | B1 |
| §7.2 新增表（B1 13 张） | 已实施（DDL） | 无 DDL 缺口；行为契约见 §4.7/§5.7/§6.5 | B1 |
| §7.2 新增表（B2 表） | 可施工 | 无；建表顺序与生命周期见 §7.2.1 | B2 |
| §7.3 值域汇总 | 已实施（`database.ts:1184-1190`） | 无；类型层已同步，CHECK 已落 | B1 / B2 |
| §8.1 迁移总览 | 只有结论 | 无；顺序声明本身不需施工 | — |
| §8.1.1 交付节奏 | 可施工 | 无；阶段验收门、回滚演练、发布检查单见 §8.1.2 | B1 / B2 |
| §8.2 S0 备份预检 | 可施工 | 无；备份/预检步骤可执行 | B1 |
| §8.3 S1 | 已实施（DDL/服务级） | 行为验收见 §8.3.1 | B1 |
| §8.4 S2 | 已实施（DDL/服务级） | 行为验收见 §8.4.1 | B1 |
| §8.5 S3 归档 | 可施工 | 无；状态机、删除路径、验收见 §8.5.1 | B2 |
| §8.6 S4 CHECK 扩展 | 可施工 | 无；校验清单、中止条件、回退见 §8.6.1 | B2 |
| §8.7 S5 任务对象 | 已实施（DDL/服务级） | 行为验收见 §8.7.1 | B1 |
| §8.8 S6 证据派生 | 已实施（DDL/服务级） | 行为验收见 §8.8.1 | B1 |
| §8.9 S7 推导/计划 | 可施工 | 无；状态机与验收门见 §8.9.1 | B2 |
| §8.10 S8 TestExecutor | 可施工 | 无；验收与回退细节见 §8.10.1 | B2 |
| §8.11 验证清单 | 可施工 | 无；执行记录与 go/no-go 见 §8.11.1 | B1 / B2 |
| §8.12 阶段×表矩阵 | 可施工 | 无；L1 交付验收清单见 §8.12.1 | B1 / B2 |
| §8.13 v24 修复记录 | 只有结论 | 无；已完成记录 | — |
| §8.14 迁移状态机 | 可施工 | 无；发布检查单与回滚演练见 §8.14.2 | B1 |
| §8.14.1 B1 迁移细则 | 可施工 | 无；状态映射、预检、回滚、故障注入已齐 | B1 |
| §8.15 F1–F3 | **已实施** | **已实施**（2026-11-07，main：F1 `231c724`、F2 `2425f0c`、F3-A `e921977`、审批冻结 `7e6e63f`，均经 `git merge-base --is-ancestor` 核实；P-F1/P-F2 随 `71518ed` 整合）。剩余失真已按代码对齐：超时默认值是常量、无配置键；partial 两层常量不一致（§12.5 待定） | B1 |
| §9.1 主进程服务 | 只有结论 | 服务接口签名、依赖注入、错误类型 | B1 / B2 |
| §9.2 IPC 通道 | 可施工 | 无；写通道契约、错误码、幂等见 §9.2.1 | B1 / B2 |
| §9.3 事件通道 | 可施工 | 无；事件信封、版本、去重见 §9.3.1 | B2 |
| §9.4 渲染层 | 可施工 | 无；组件状态来源与空/错态见 §9.4.1 | B2 |
| §9.5 既有缺口 | 可施工 | 无；两条 `nodes.status` 路径修复与验收见 §9.5.1 | B1 |
| §10 安全模型 | 可施工 | 无；执行检查矩阵与 fail-closed 见 §10.1 | B2 |
| §11.1 三个风险 | 只有结论 | 无 | — |
| §11.2 开放问题 | 只有结论 | 无；默认假设已给 | — |
| §11.3 规模与保留 | 可施工 | 无；清理任务、上限执行与验收见 §11.3.1 | B1 / B2 |
| §12.1–12.11 对照/审查记录 | 只有结论 | 无；记录性质 | — |

**审计结论**

- **空挂 0**：没有"标题在、内容缺"的章节；`ContextBundle` / 尾块协议有明确外部指向，不算空挂。
- **B1 可施工边界（裁决后）**：S1、S2、S5a、S6a、迁移状态机、F1–F3 行为契约已细化；U1 与 F3 选型已定案（过期 E4 → `stale`；F3-A），F1–F3 已实施（2026-11-07，见 §8.15）。
- **B1 一次性修正（已接受）**：`work_items.status` 补 `failed`（13 值），否则 §5.5.1 的父任务失败聚合无法落库；表总数不变（22），L1 仍 13 张。
- **B2 可施工边界**：§5.9 及子节、§5.9.9–5.9.11、§5.7、§6.5.1/§6.5.2、§6.8 已细化到接口级输入输出与失败分支；黑板/Phase B/fanout 仍属 B3。
- **Zcode v1.2 处理**：采纳 9 项落 §2.8 / §4.2 / §5.9.5 / §5.9.8 / §5.9.8.1 / §5.9.11 / §8.15 / §9.3；不采纳 10 项与事实性错误见 §12.10 / §12.11；两项待裁决见 §12.5 第 6、7 项。
- **B1 不动的口径**：查重 N=12 / 0.6 / 0.8、90 天、E4 30 天、记住放行、重建判据、L1 不删节点、E3/E4 可复现语义、`signed_by`、Tier2 只读、单向 Yjs 均未改写。

---

## 14. G1–G6 准入 gate 规格（引擎已实施；D1–D14 已全部裁决）

> **状态（按 §0 三态口径，逐项区分，不合并表述）：**
> - **已实施（`b6f3735`）**：G1–G6 评估引擎 `src/main/map/gate-engine.ts`；生产装配在 `work-execution-runtime.ts` 以 `GateRecheck` 注入，受 `BIZGRAPH_MAP_EXECUTION` 开关控制（默认关闭，关闭时写通道仍显式拒绝）。引擎单元测试 56 例、执行触发测试 12 例，已随 `b6f3735` 落地。
> - **已批准已实施（`e4398e7`，D1/D7）**：D1 acceptance 冻结为 `{id,type,expected,text?}`，系统边界强制结构化；**存量 `[{id,text}]` 不自动迁移**，人工重新确认计划前任务保持 `blocked`（显式代价）。D7 G4 预估行数采用「Σ scope 文件行数」的**过渡代理指标，不是变更行数**：已存在文件计实际行数，新建文件计 0，目录/读取失败 fail-closed；阈值 env `BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES` / `_LINES`（默认 20/800）。该代理只用于准入规模守卫，不得当作"预计变更行数"的验收事实；真实改动行数属执行后 evidence 对比。
> - **已全部裁决（2026-11-07，整批采纳推荐值表）**：D2–D6、D8–D14 逐条裁决见 §14.8。其中 D3/D4/D5/D6/D8/D9/D10/D11/D13/D14 与现有引擎保守默认一致（零代码改动，`b6f3735` 即实现）；**D2 已于 2026-11-08 实施**（`acceptance-executor.ts` + `agent-step-runner` 接线，最小闭环：`command` 退出码 / `file_check` 存在性，可选 `stdout_contains`、`content_contains`、`timeout_ms`；判定不出含 manual 待确认一律 `verify_fail`）；**D12 裁决为本期不做**。
> - **仅建议（本节未实施）**：依赖未来能力出现的扩展条款——跨图写入面出现时的 G3 链接矩阵、异步评估器的时限预算、评估器版本精确归因的 schema 变更。对应能力出现前不实施。
>
> 本节正文仍是规格定义来源；实际行为以 `gate-engine.ts` 与 `work-execution-runtime.ts` 为准，完整实施记录见 §M5.7 / §M5.8。本节不改 §M5 或其他小节。

### 14.1 适用范围与调用时机

- 判定对象是**单个 `work_item` 的单个 revision**（`id + revision`），不是节点、不是 run、不是整个计划。
- 同一评估器必须在以下时点复用，禁止各入口自行解释条件（§4.7.3）：
  1. `awaiting_confirm → queued`：确认入队前强制评估（§4.7.2）。
  2. 调度 tick 第 2 步：对 `queued` 项重跑评估，不信任确认时的旧结果（§5.9「调度 tick」第 2 步）。
  3. `blocked → queued`：解除阻塞前重跑（§4.7.2；现有 `unblock` 只校验非 `incomplete`，不等于重跑）。
  4. `resumeWorkItem` 的恢复路径：蓝图 §5.9.9 明确 `GATE_INCOMPLETE`（恢复前重跑 gate）。
- 评估器**只读**：不写 `work_items` / `work_steps` / `work_runs` / `node_evidence`。结果落库与状态迁移由调度器/`WorkItemService` 完成（§4.7.1 写入权）。
- 评估器不创建 run、不增加 `attempt`、不占用写闸；未通过时"不进队列"（§5.4）。

### 14.2 通用输入契约

评估输入必须是一次调用内**同源、同一时点**的只读快照；禁止评估过程中分多次读库再拼接（避免 scope 读旧值、running 集合读新值）。形状草案（类型声明，不含实现）：

```text
GateRecheckInput {
  item: {
    id, revision, lineageId, isCurrent,
    projectPath, graphId, anchorNodeId, anchorEntityKey,
    scopeFilesJson, acceptanceJson, dependsOnJson,
    status, gateStatus, origin
  }
  project: { projectPathRealpath | null, pathPlatform: 'posix' | 'non_posix' }
  graph: {
    graphId,
    anchorNode: { id, graphType, lifecycleState } | null,
    referencedNodes: Array<{ id, graphType, entityKey, lifecycleState }>,
    nodeLinks: Array<{ id, linkType, fromEntityKey, toEntityKey, fromGraphType, toGraphType, status }>
  }
  dependencies: Array<{ id, lineageId, revision, isCurrent, status, supersedesId }>
  runningItems: Array<{ id, lineageId, projectPath, scopeFilesJson }>
  policy: { g4MaxFiles, g4MaxLines, evaluatorVersion, pathPlatform }
  waiver: { waivedBy, waivedAt, waiveReason } | null   // 人工豁免意图，不是评估结论
}
```

| 输入 | 来源 | 用途 | 依据 |
|---|---|---|---|
| `scope_files` | `work_items.scope_files`（JSON 数组） | G1 非空与根内校验；G4 计数；G6 交集 | §5.4、§5.4.1、§7.2 |
| `acceptance_json` | `work_items.acceptance_json` | G2 结构化可判定项 | §5.4 G2 |
| `depends_on_json` | `work_items.depends_on_json` | G5 依赖闭包 | §5.4 G5、§5.5.1 |
| `anchor_node_id` / `graph_id` | `work_items`；`nodes.graph_type` | G3 目标节点在 dev 图 | §5.4 G3、§7.2 |
| 图节点与链接 | `nodes`、`node_links`、同图 `edges` | G3 跨图写判定 | §1.2、§2.3、§5.4 G3 |
| 运行中任务集合 | `work_items WHERE status='running' AND is_current=1` | G6 写冲突预检 | §5.4 G6 |
| 项目根 | `work_items.project_path`（realpath） | G1/G6 路径规范化边界 | §5.4.1 |
| 规模阈值 | 配置（D7 已实施：env 阈值 + Σ scope 行数代理） | G4 | §5.4 G4 |
| 证据 | `node_evidence` / `execution_state` | **不参与 G1–G6 判定** | §5.4；见 §14.3 末条 |

- `scope_files`、`acceptance_json`、`depends_on_json` 都是 TEXT 存 JSON。解析失败一律 fail-closed，不得当作空数组"看起来通过"。
- 路径比较必须走 §5.4.1 的统一规范化管线；任一表存了未规范化路径，都在使用点重新规范化，不做字符串直接相等（§5.4.1）。
- 非 POSIX 根（Windows 路径）按 §5.4.1 A9 直接 fail-closed，不做猜测性兼容。

### 14.3 结果、落库与三态纪律

`gate_status` 只允许三值（`work_items.gate_status` CHECK，§7.2）：`pass` / `incomplete` / `waived`。`gate_missing_json` 是**字符串数组**（现有 `setGateResult(id, result, { missing: string[] })` 即此形状），只写缺失项代码，不写自由文本对象。

| 结论 | 落库 | 后续动作 | 约束 |
|---|---|---|---|
| `pass` | `gate_status='pass'`，`gate_missing_json=NULL` | 允许继续依赖校验/tick 后续步 | **不得**用 `[]` 表示通过（§4.7.3） |
| `incomplete` | `gate_status='incomplete'`，`gate_missing_json=JSON(missing[])` | 不 claim、不建 run；tick 内 `queued → blocked` 并写缺失项（§4.7.2） | `missing` 至少 1 条；无缺失项时写 `gate_missing_unclassified` |
| `waived` | `gate_status='waived'` 且 `gate_waived_by / gate_waived_at / gate_waive_reason` 三者齐全 | 视同通过（§4.7.2） | 缺任一字段 → 回落 `incomplete`（§4.7.3，现有 `setGateResult` 已是该行为） |

- 只有 **G2 的 `manual` 类型**允许豁免；G1/G3/G4 明确不允许（§5.4）。G5/G6 已裁决**不可豁免**（D9，§14.8）。
- 评估器不写库；调度器一次写入 `gate_status + gate_missing_json`（以及 waived 三字段），写入失败按 tick 失败处理，不能保留旧 `pass` 放行。
- **证据不参与准入**：G1–G6 是执行前条件，`node_evidence` / `execution_state` 是执行后事实（§3、§5.4）。用 stale/缺失证据阻断执行属于另一条策略；若产品需要，应新增 gate 或独立策略，不得塞进 G1–G6（D13 已裁决：不参与，§14.8）。

### 14.4 逐条 gate 规格

每条给出：判定、输入、`pass` 条件、`incomplete` 代码（命名已冻结，见 D11）、可豁免性与不确定时行为。依据均指向 §5.4 与相关章节。

#### G1 · scope 非空且都在项目根内

- **判定**：`scope_files` 解析为数组、去重后至少 1 项；每一项按 §5.4.1 规范化后，必须落在 `project_path` 的 realpath 之下；越界、`..`、外部绝对路径、指向根外的符号链接一律失败（§5.4、§5.4.1）。
- **输入**：`work_items.scope_files`、`work_items.project_path`。
- **pass**：全部条目通过规范化与根内校验，且无空串。
- **incomplete 代码（建议）**：`scope_files_empty`、`scope_files_invalid_json`、`project_path_missing`、`scope_file_empty:<index>`、`scope_file_escape:<index>`、`scope_file_unresolvable:<index>`。
- **可豁免**：否（§5.4 明确 G1 不允许豁免）。
- **不确定即失败**：`project_path` 为空（schema 允许 NULL）、realpath/权限/父目录解析失败、非 POSIX 根 → `incomplete`。理由：无法证明"在根内"就不能放行（§5.4.1 第 5 条）。

#### G2 · acceptance 至少 1 条结构化可判定项

- **判定**：`acceptance_json` 解析为数组，且至少 1 条满足：`type ∈ ('command','manual','file_check')`，并带非空 `expected`（§5.4 G2）。
- **输入**：`work_items.acceptance_json`。
- **pass**：存在上述结构化条目；其余条目可以是非结构化补充，但不得让判定变成"有文字就行"。
- **incomplete 代码（建议）**：`acceptance_json_empty`、`acceptance_json_invalid`、`acceptance_item_not_structured:<index>`、`acceptance_type_unknown:<index>`、`acceptance_expected_missing:<index>`。
- **可豁免**：仅 `manual` 类型可人工豁免，且必须三字段齐全（§5.4、§4.7.3）；manual 豁免为**整条任务粒度**，不得覆盖 command/file_check 失败（D3 已裁决，§14.8）。
- **不确定即失败**：类型不认识、`expected` 为空/无法解释、数组解析失败 → `incomplete`。
- **历史差距（D1 已解决，`e4398e7`）**：现有写入与执行路径曾把 `acceptance_json` 当作 `[{ id, text }]` 使用——IPC 入参是 `Array<Record<string, unknown>>`（`src/main/ipc/map.ts`），步骤提示词按字符串数组拼接（`src/main/map/agent-step-runner.ts`）。已裁决（D1）：系统边界强制结构化，存量不自动迁移（保持 `blocked` 待人工重新确认）。

#### G3 · 目标节点在 dev 图、无跨图写

- **判定**：`anchor_node_id` 可解析到 `nodes` 中的真实行；该节点 `graph_type='dev'`；本任务不包含跨图写（§5.4 G3）。
- **输入**：`work_items.anchor_node_id`、`work_items.graph_id`、`nodes(id, graph_id, graph_type, lifecycle_state)`、`node_links`（及同图 `edges`）。
- **pass**：锚点存在、其 `graph_type='dev'`、`graph_id` 一致；且按 D5 裁决口径未命中跨图写（本期仅锚点判定，见 §14.8）。
- **incomplete 代码（建议）**：`anchor_node_missing`、`anchor_node_graph_mismatch`、`anchor_node_not_dev:<graph_type>`、`cross_graph_write:<link_id|entity_key>`（最后这个本期不产出，D5）。
- **可豁免**：否（§5.4）。
- **不确定即失败**：锚点为空、解析到多行/零行、节点生命周期不可用、链接解析失败 → `incomplete`。
- **口径已裁决（D5）**：采纳收敛口径 c)——本期仅看锚点（存在 + dev + `graph_id` 一致）；a/b 候选与 `node_links` 链接矩阵不入本期准入，理由与未来约束见 §14.8。

#### G4 · 规模上限

- **判定**：`scope_files` 去重后的文件数 ≤ 配置上限（默认 20）；预估变更行数 ≤ 配置上限（默认 800）（§5.4 G4）。
- **输入**：G1 规范化后的文件集合；预估行数；阈值配置。
- **pass**：两项都在阈值内。
- **incomplete 代码（建议）**：`scope_file_count_exceeded:<n>/<max>`、`estimated_lines_exceeded:<n>/<max>`、`line_estimate_unavailable`、`gate_policy_missing`。
- **可豁免**：否（§5.4）。
- **不确定即失败**：拿不到预估行数时不能 pass（D7 已实施：目录/读取失败 → `line_estimate_unavailable`）；阈值非法回退默认并告警，不得回落到"无上限"。
- **现状（D7 已实施，`e4398e7`）**：`work_items` / `work_steps` / `plan_drafts` 仍无"预估行数"字段；生产来源是 `work-execution-runtime` 的 Σ scope 文件行数**过渡代理指标，不是变更行数**——已存在文件按实际行数，新建文件计 0（规模由 G4 文件数上限约束），目录/读取失败 fail-closed。阈值由 env 配置（默认 20/800，非法回退默认）。该代理只用于准入规模守卫，不能当作"预计变更行数"的验收事实。

#### G5 · 依赖闭包无未完成前置

- **判定**：沿 `depends_on_json` 做传递闭包；闭包内所有上游的**当前 revision**都处于终态成功（`status='done'`）；闭包内无环（§5.4 G5、§5.5.1 环检测）。
- **输入**：`work_items.depends_on_json`、闭包内 `work_items(id, lineage_id, revision, is_current, status, supersedes_id)`。
- **pass**：闭包完整可解析、无环、所有上游 `done`。
- **incomplete 代码（建议）**：`dep_missing:<id>`、`dep_not_done:<id>:<status>`、`dep_cycle:<id>`、`dep_revision_stale:<id>`、`dep_cross_project:<id>`。
- **可豁免**：不可（D9 已裁决，§14.8）。
- **"或显式标 blocked 并给出依赖 id"的含义**：已裁决为**失败分支**（D8）——依赖未完成时不放行，把依赖 id 写入 `gate_missing_json` 并转 `blocked`（§4.7.2 `queued → blocked`），"标了 blocked"不视为满足。
- **不确定即失败**：依赖 id 不存在、指向非当前 revision、存在环、上游为 `failed/cancelled/superseded/blocked` 等非 `done` 终态 → `incomplete`。
- **已裁决（D8）**：只看 `depends_on_json` 显式声明，隐式依赖（共享 `scope_files` / `verifies` / 同锚点）不入 G5 闭包，应由计划确认阶段落成显式声明；上游 `superseded` 按非当前 revision 判 `dep_revision_stale`，不自动代替。

#### G6 · 与 running 任务 scope 无交集

- **判定**：本任务规范化后的 `scope_files` 与所有 `status='running' AND is_current=1` 任务的 `scope_files` 逐条求交集；为空才通过（§5.4 G6）。只比较同一 `project_path` 下的任务，跨项目不比较（D10 已裁决）。
- **输入**：本任务 `scope_files`；running 集合的 `id / lineage_id / project_path / scope_files`。
- **pass**：无任何规范化后路径相同。
- **incomplete 代码（建议）**：`scope_conflict:<work_item_id>:<path>`、`scope_invalid:<index>`。
- **可豁免**：不可（D9 已裁决，§14.8）。
- **不确定即失败**：任一 running 行 scope 解析失败、或本任务路径无法规范化 → `incomplete`（不能"跳过坏行"当作无冲突）。
- **必须说明的边界**：G6 是**准入快照**，不是写锁；真正的互斥仍由 tick 第 5 步的写闸保证（§5.9「调度 tick」第 5 步）。G6 通过不代表运行期不会冲突，运行期冲突由调度与 ScopeGuard 处理（§6）。
- **已裁决（D10）**：不排除同 lineage 父/子任务（本期单 turn 串行 + 写闸在先，父子同时 `running` 的窗口极小；未来放开并行编排必须重裁）；`queued` 不纳入冲突面；跨项目不比较。

### 14.5 fail-closed 通则（适用于全部 gate）

按以下顺序，任何一条成立即 `incomplete`，不允许"跳过该项继续评估后判 pass"：

1. 输入缺字段/JSON 解析失败/类型不认识/枚举越界。
2. 只读快照构建失败（含查询异常、权限错误、超时）。
3. 规范化管线拒绝（非 POSIX 根、realpath 失败、越界）。
4. 评估器未注入、抛异常、超出时限、或返回结构不合规。
5. 结果自相矛盾（如 `pass` 却带 `missing` 非空、`waived` 缺三字段）。

生产默认实现即第 4 条的静态版本：不做任何判定，固定返回 `incomplete + ['gate_engine_unavailable']`。这条默认值本身就是"未实施"的显式表达，不得被解释为暂时放行。

### 14.6 `GateRecheck` 对接形状

- 调用点：调度 tick 第 2 步（§5.9）。调用前由调度器在**同一只读事务/同一快照**内装载 §14.2 输入；调用内不再自行跨表多次读库。
- 输出契约（类型声明，不含实现）：

```text
GateRecheckResult {
  gateStatus: 'pass' | 'incomplete' | 'waived'
  missing: string[]              // pass 时必须为空；incomplete 时至少 1 条
  waiver: { waivedBy, waivedAt, waiveReason } | null   // 仅 waived 时非空，且三字段齐全
  evaluatorVersion: string       // 归因用；配置/规则变更必须变版本
  evaluatedAt: number
}
```

- 调度器对结果的处置：

| 结果 | tick 动作 | 库写入 |
|---|---|---|
| `pass` | 继续第 3 步（依赖校验） | `gate_status='pass'`，`gate_missing_json=NULL` |
| `waived` | 视同通过继续 | `waived` + 三字段 |
| `incomplete` | 不 claim、不建 run；`queued → blocked` | `gate_status='incomplete'` + `gate_missing_json=missing` |
| 抛异常/超时/未知返回 | 与生产默认实现同路径 | 同上，missing 至少含 `gate_engine_unavailable` |

- 评估器返回 `waived` 时，调度器仍须校验三字段与"仅 G2 manual 可豁免"；不合法则改判 `incomplete`（沿用 `setGateResult` 现有守卫）。
- 幂等性要求：同一 `item.id + revision + evaluatorVersion + 快照` 应得到相同结论；评估本身不产生 run、不递增 attempt。
- 可观测性：拒绝原因只进 `gate_missing_json` 代码与结构化日志/事件；不把自由文本塞进 `gate_missing_json`，避免下游按字符串数组解析崩坏。

### 14.7 与现有代码/状态机的衔接点（仅指认，不改文件）

- `WorkItemService.setGateResult`：已实现三态与 waived 三字段守卫，可作为落库唯一入口（`src/main/map/work-item-service.ts`）。
- `WorkItemService.markBlocked`：已实现 `incomplete + missing[]` 与 `queued → blocked`，tick 失败分支可复用。
- `WorkScheduler`：tick 第 2 步目前只复核已落库值，且第 116 行对非 `pass/waived` 抛 `GATE_NOT_PASSED`；这是"引擎未实现"的临时形态，`GateRecheck` 接入后应替换为"先评估、再按结果转移"。
- `unblock`：目前只保证"不是 incomplete"，不保证"刚刚重跑过"；规格要求 blocked → queued 必须触发一次真实评估（§4.7.2）。
- `work_items.gate_missing_json` 已是字符串数组，保持形状兼容，避免为了 gate 规格改表。

### 14.8 裁决记录（D1–D14 已全部裁决，2026-11-07）

> 裁决来源：D1–D14 推荐值表于 2026-11-07 获用户**整批采纳**（「按此方案推进」）。状态词按 §0 三态口径：裁决与现有引擎行为一致且代码已存在 → **已批准已实施**；裁决定义契约但执行侧组件尚未存在 → **已批准未实施**；裁决为「不做」→ 终态裁决。

| 编号 | 裁决 | 状态 | 关联 |
|---|---|---|---|
| D1 | acceptance 冻结为 `{id,type,expected,text?}`；`createDraft` / `revise` 在系统边界强制结构化（缺 type/expected 或未知 type 拒绝，不静默降级）；**存量不自动迁移**，人工重新确认计划前保持 `blocked` | 已批准已实施（`e4398e7`） | §5.4 G2、`work-item-service` |
| D2 | `expected` 判定语义：`command` = 退出码 0（可选用 `stdout_contains` 匹配标准输出、`timeout_ms` 限制超时）；`file_check` = 相对 `project_path` 的路径存在性（可选用 `content_contains` 匹配文件内容）；`manual` = `expected` 为人工判定描述（非空字符串），由人确认。**确定性验收执行器已实施（2026-11-08）**：`acceptance-executor.ts` 只读评估，`agent-step-runner` 在 turn `completed` 后、terminate 之后调用；**非 manual 硬失败或执行器异常 → `verify_fail`（fail-closed）；仅 manual 待确认 → 步/item `needs_input`、run `completed`，待确认条目写入 `input_request_json`**。`BIZGRAPH_MAP_EXECUTION` 仍默认关闭。人工确认入口见 §M5.11；内容哈希匹配仍属后续 | 已批准已实施（`acceptance-executor.ts`，2026-11-08） | §5.4 G2、`agent-step-runner` |
| D3 | G2 豁免为**整条任务粒度**：仅当全部缺失码来自 G2 且失败条目全为 `manual` 时三字段豁免成立；manual 豁免不得覆盖 command/file_check 失败 | 已批准已实施（`b6f3735`） | §5.4、§4.7.3 |
| D4 | `project_path` 为空 → 直接 fail-closed（`project_path_missing`），不从图/项目根兜底 | 已批准已实施（`b6f3735`） | §5.4.1 |
| D5 | 「跨图写」采纳收敛口径：本期准入只判锚点存在 + `graph_type='dev'` + `graph_id` 一致；`node_links` 链接矩阵不入本期准入——写入面仅 `scope_files` 且已被 G1 限定在单一项目根内，跨图写在现有字段上不可表达。**若未来出现跨图写入面（如允许改 test 图资产），必须新增 gate 或扩展 G3 并重新裁决，不得静默放宽** | 已批准已实施（`b6f3735`） | §1.2、§2.3、§5.4 G3 |
| D6 | 准入一律要求 dev 锚点；test 图锚点任务不设准入特例（fail-closed `anchor_node_not_dev`）；test 只读派生留待未来能力出现时再议 | 已批准已实施（`b6f3735`） | §5.4 G3 |
| D7 | G4 预估行数 = Σ scope 文件行数的**过渡代理指标，不是变更行数**：已存在文件按实际行数、新建文件计 0、目录/读取失败 fail-closed；阈值 env `BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES` / `_LINES`（默认 20/800，非法回退） | 已批准已实施（`e4398e7`） | §5.4 G4、§7.2 |
| D8 | G5 只看 `depends_on_json` 显式声明，隐式依赖不入闭包（由计划确认阶段落成显式）；上游 `superseded` 按非当前 revision 判 `dep_revision_stale`（不自动代替）；`cancelled/failed/blocked` 等非 `done` → `dep_not_done`；「显式标 blocked 并给出依赖 id」= 失败分支（不放行、写缺失码、转 `blocked`） | 已批准已实施（`b6f3735`） | §5.4 G5、§5.5.1 |
| D9 | G5/G6 **不允许**人工豁免（本期）；失败只能修数据（依赖完成 / scope 调整）后重跑评估 | 已批准已实施（`b6f3735`） | §5.4 |
| D10 | G6 只比较同 `project_path` 且 `status='running' AND is_current=1` 的任务；不排除同 lineage 父/子（单 turn 串行 + 写闸在先，窗口极小；**放开并行编排必须重裁**）；`queued` 不纳入冲突面；跨项目不比较 | 已批准已实施（`b6f3735`） | §5.4 G6、§5.9 |
| D11 | `gate_missing_json` 冻结为当前引擎产出的稳定码集，形状保持字符串数组；**新增码只追加、不得改名**；UI 对未知码按「未知原因」兜底展示 | 已批准已实施（`b6f3735`，契约冻结） | §4.7.3、`setGateResult` |
| D12 | 评估器版本 / G4 阈值快照**本期不落库**；归因靠引擎所在 git commit + 现有事件日志。未来需要精确归因再走 schema 变更流程（蓝图 `observed_rule_version` 思路保留为候选） | **2026-11-08 修订为已实施**：改为每次评估落逐道诊断（复用 `map_migration_reports`，无 schema 变更，见 M5.14） | §5.7 |
| D13 | 证据 stale/缺失**不参与**准入（维持 §3 / §5.4 分层）；产品如需该策略，新增独立 gate 或策略，不塞进 G1–G6 | 已批准已实施（负向口径，`b6f3735`） | §3、§5.4 |
| D14 | `GateRecheck` 本期**不设时限预算**：引擎全同步（better-sqlite3 同步 API），无异步超时面；评估器抛异常由 tick 按 `gate_engine_unavailable` fail-closed 收口（已实现）。**未来引入异步评估器必须带预算 + 超时 fail-closed** | 已批准已实施（含未来约束，`b6f3735`） | §5.9 |

### 14.9 建议的验收断言（实施时使用）

以下只描述断言，不写实现：

1. 每条 gate 至少一组正例与一组反例；反例断言 `gate_status='incomplete'` 且 `gate_missing_json` 含对应代码，并且**没有创建 run、`attempt` 未变**。
2. G1/G6 各补一组符号链接与 NFC/大小写样本（§5.4.1 第 1–4 条），断言使用点重新规范化后比较。
3. G2 补 `manual` 豁免：三字段齐全 → `waived`；缺任一 → `incomplete`；G1/G3/G4 即使人工豁免也仍 `incomplete`。
4. G3 补锚点缺失、锚点非 dev、跨图链接三种反例。
5. G5 补依赖缺失、依赖非 `done`、环三种反例；`superseded` 判 `dep_revision_stale`（D8 已裁决）；隐式依赖不入闭包（D8，无需样本）。
6. G6 补同路径冲突与"路径写法不同但规范化后相同"两种冲突样本，断言只作为准入快照、不写写闸状态。
7. 注入生产默认 `GateRecheck`：所有任务均为 `incomplete + ['gate_engine_unavailable']`，tick 不 claim、不建 run。
8. 注入抛异常/超时的评估器：结果与第 7 条一致（fail-closed）。
9. 评估前后对 `work_items / work_steps / work_runs / node_evidence` 做快照对比，断言评估器自身零写入。
10. 同一输入重复评估两次，断言 `gateStatus` 与 `missing` 完全一致。

### 14.10 依据索引

- §5.4（G1–G6 条件表、豁免限制、不进队列）
- §5.4.1（路径规范化：realpath / NFC / 分隔符 / 大小写折叠 / 根内校验 / A9）
- §4.7.2（`awaiting_confirm → queued`、`queued → blocked`、`blocked → queued` 的 gate 守卫）
- §4.7.3（gate 三态、`gate_missing_json`、waived 三字段、`blocked → queued` 必须重跑）
- §5.5.1（环检测、依赖优先级、父任务聚合）
- §5.9「调度 tick」第 2、5 步（重跑 gate、写闸）
- §5.9.9（`enqueue` / `resumeWorkItem` 的 `GATE_INCOMPLETE` 与 `claimNext` 的 `GATE_REVOKED`）
- §7.2 `work_items` / `work_steps` / `work_runs` 字段（`scope_files`、`acceptance_json`、`depends_on_json`、`anchor_node_id`、`gate_*`、`status`）
- §1.2 / §2.3（`entity_key` 与 `node_links`；跨图只走链接、不建跨图 edge）
- §3、§3.7（证据等级与写入权；用于说明证据为何不作为准入输入）
- 现有代码：`src/main/map/work-item-service.ts`（`setGateResult` / `markBlocked` / `unblock`）、`src/main/map/work-scheduler.ts`（tick gate 复核现状）、`src/main/ipc/map.ts`、`src/main/map/agent-step-runner.ts`（acceptance 现有用法）

## §M5 执行触发段实施记录

> 本小节只记录 L2「执行触发」段的实施事实与已知偏离；其他章节的规格含义未改动。
> 状态词严格区分「已实施 / 已批准未实施 / 仅建议」。

### M5.1 状态总览

- **已实施**：主进程单实例异步 tick（§5.9.9 六步骨架）、`GateRecheck` 可插拔端口、G1–G6 准入 gate 评估引擎（§14 草案的实现子集 + §14.8 各待决项的 fail-closed 默认，见 M5.7）、孤儿回收（`running → queued`，不计 `attempt`）、`workitem:step:run`（只入队）与 `workitem:run:cancel`（条件更新 + 执行器真结束会话）。
- **已批准未实施**：§14.8 其余待决项（D2、D4–D6、D8、D10–D14）。
- **仅建议（本段未实施）**：Tier 1 自动路由探测（当前只接受 pinned adapter）、跨进程项目写闸（当前只有进程内单 turn 守卫）、renderer 执行入口 UI（归另一条线）。

**重要事实（M5.8 后更新）**：D1/D7 已裁决并实施——acceptance 结构化条目 + scope 指向已存在文件的任务，G1–G6 可全绿并真实进入执行；存量自由文本 acceptance 任务仍被 G2 挡在 `blocked`（D1 不自动迁移的显式代价），直到人工重新确认计划。

### M5.2 tick 六步映射

1. **取候选**：`work_items.status IN ('queued','running')`，`queued` 优先，`created_at ASC`；`work_items` 无 `priority` 列，故未实现蓝图中的 `priority DESC`（已知偏离）。
2. **重跑 gate**：每轮调用 `GateRecheck.recheck(item)`（生产 = G1–G6 引擎），不读取/不信任 `work_items.gate_status`；不通过时 `queued → blocked` 并写 `gate_missing_json`，running item 仅落 gate 失效（不改状态机）。评估器抛异常按 §14.6 与不可用同路径收口（`gate_engine_unavailable`）。重跑通过但库中仍是 `incomplete` 时，把重跑结论落为 `pass`；结论为「人工豁免视同通过」（仅 G2 manual 条目 + 三字段齐全）时保留库内 `waived` 三字段，不改写为 `pass`。
3. **依赖校验**：先 `blockUnstartedDependents`，再用 `peekNextReadyStep`（只读）选第一个就绪步；无就绪步且全部终态时触发 item 收敛。
4. **路由**：只接受 pinned adapter（`BIZGRAPH_MAP_EXECUTION_ADAPTER` 或写入时传入），并做 kernel/审批/驱动三项探测；不满足时保持 `queued`、发 `routing_failed` 事件、不建 run。
5. **写闸**：进程内 `inflightRunId` 守卫，同一时刻只允许一个 turn；busy 时本轮跳过，不写 run、不加 attempt。跨进程写闸属「仅建议」。
6. **claim → 执行**：`startStep`（幂等复用 queued run）→ `AgentStepRunner.run` → 终态 → `blockUnstartedDependents` + `convergeIfTerminal`。执行器异常且 run 未落终态时按 `infra` 兜底收口，确保 tick 内不留 `running` 孤儿。

每轮 tick 开始前执行孤儿回收：`work_runs.status='running' AND work_steps.status='pending'` → `running → queued`（条件更新，`attempt` 不变）。

### M5.3 写通道与开关

- 开关：`BIZGRAPH_MAP_EXECUTION`（显式 truthy 才开启，默认关闭）。关闭时 `workitem:step:run` / `workitem:run:cancel` 仍然存在，但 `WorkExecutionError('EXECUTION_DISABLED')` 明确拒绝，不静默降级。
- `workitem:step:run`：只做 `scheduler.enqueueStep`（建/复用 `queued` run），**不在 IPC handler 内联跑 turn**。
- `workitem:run:cancel`：`work_runs.cancel` 条件更新；若该 run 正在本进程执行，先 `terminateSession` 结束会话（真取消），再由 tick 按终态收敛；完成与取消竞态时失败方保留既有事实。下游未开始的依赖步落 `cancelled`（非 blocked），item 按 §5.5.1 收敛。
- 只读白名单：两个写通道均不在 `MAP_READ_ONLY_CHANNELS` 中；`map-read-ipc.test.ts` 同时断言「白名单不含写通道」与「写通道不在白名单」两个方向。

### M5.4 硬约束落实情况

| 约束 | 落实 |
| --- | --- |
| 只走 kernel-only 发送 | `AgentManagerTurnRunner` 仅调用 `sendCommandKernelOnly`；执行服务不持有 legacy 发送入口 |
| 审批经网关、不可用即 fail-closed | 开跑前探测 `kernel`/`runtime`/`driver`，任一不满足拒绝；`degraded`（UNSAFE 免审）视为不可编排 |
| 写通道默认关闭 | `BIZGRAPH_MAP_EXECUTION` 未开启时明确拒绝 |
| 写通道与只读白名单互斥 | 双向断言（见 M5.3） |
| 单进程串行、不加 schema 版本 | 无新迁移；沿用 v34；tick 为单实例串行 |

### M5.5 验证

- 新增 `src/main/__tests__/work-execution.test.ts`：12 个用例，覆盖 gate 重跑、默认 fail-closed、引擎抛异常收口、豁免视同通过且保留三字段、正常链路、孤儿回收、五类写通道拒绝、只入队、in-flight/queued 取消收敛、kernel-only 结构断言。
- 新增 `src/main/__tests__/gate-engine.test.ts`：53 个用例（§14.9 实现子集，见 M5.7）。
- `map-read-ipc.test.ts` 扩展写通道清单。
- 全量：`310` 个测试文件、`3815` 通过、`3` 跳过、`0` 失败（连续两轮全绿；首轮有一例与本段改动无关的偶发失败，未再复现）。`tsc --noEmit` 干净。
- 已知环境事实：本机 `node_modules/better-sqlite3` 默认按 Electron ABI 构建；跑 vitest 需临时按 Node 20 重建绑定，验证后已恢复为 Electron 绑定（sha256 校验一致）。

### M5.6 遗留风险

1. 存量自由文本 acceptance 任务不可执行（D1 不自动迁移的显式代价）：G2 判 `acceptance_item_not_structured`，需人工重新确认计划结构化后入队。scope 指向目录的任务被 G4 判 `line_estimate_unavailable`（fail-closed）。
2. 路由未实现 Tier 1 探测；pinned adapter 缺失时 run 不会被 claim。
3. 跨进程项目写闸未实现，只有进程内单 turn 守卫。
4. renderer 执行入口与运行态展示未接入（面板归另一条线）。

### M5.7 G1–G6 gate 引擎实施记录（2026-11-07）

**已实施**（`src/main/map/gate-engine.ts` + `src/main/map/gate-recheck.ts` 端口扩展；生产装配在 `work-execution-runtime.ts`）：

- 判定范围：G1（scope 非空且经 §5.4.1 realpath/NFC/大小折叠管线校验在项目根内）、G2（≥1 条 `{type ∈ command|manual|file_check, expected 非空}` 结构化条目）、G3 可判定子集（锚点存在 + `graph_type='dev'` + `graph_id` 一致）、G4（去重后文件数与预估行数上限，默认 20/800）、G5（`depends_on_json` 传递闭包全 `done` + 当前 revision + 无环）、G6（与 `running AND is_current` 任务 scope 规范化后无交集）。
- 豁免（§14.6/§14.9-3）：仅当全部缺失码来自 G2 且失败条目均为 `manual` 类型、三字段（`gate_waived_by/at/reason`）齐全时判 `waived` 视同通过；G1/G3/G4 不可豁免（§5.4），G5/G6 不可豁免（D9 已裁决）；manual 豁免不覆盖 command/file_check 失败（D3 已裁决：任务级粒度）。tick 对 waived 结论保留库内三字段，不改写为 `pass`。
- fail-closed（§14.5）：JSON 解析失败/查询异常/非 POSIX 根/阈值非法/预估来源缺失一律 `incomplete` + 具体缺失码；评估器抛异常由 tick 按 `gate_engine_unavailable` 同路径收口。
- 只读与幂等：recheck 全程同步读（better-sqlite3 单线程，一次调用等价同一时点快照），不写四张表（测试做前后快照对比）；同输入两次评估结果一致。
- 测试：`gate-engine.test.ts` 全量用例（含 `94125bd` 新增的 G6+豁免反向断言）+ `work-execution.test.ts` 12 用例，覆盖 §14.9 断言 1–10 的实现子集（含 symlink 逃逸、NFC、darwin 大小写折叠、`./` 前缀规范化等价、零写入、幂等、生产默认注入、抛异常注入）。

**采纳说明**：引擎最初来自另一条线留下的未跟踪实现；本次经逐条对照 §14 复核后采纳，并修正/补齐三处——G2 的 pass 语义（有结构化条目即通过，坏补充条目不再判 incomplete）、G4 按去重后文件数计数（§5.4）、豁免判定与 tick 的异常/waived 处理。

**与 §14.6 建议形状的已知偏离**：`GateRecheckResult` 沿用 M5 已落地的 `{ ok, missing, waived? }`，未采用草案建议的 `gateStatus/evaluatorVersion/evaluatedAt` 完整形状；D12 已裁决本期不落库（评估器归因靠引擎所在提交 hash）。→ **2026-11-08 修订**：D12 改为落可查诊断（见 M5.14），`GateRecheckResult` 追加可选 `diagnostics`（逐道 + 评估器版本 + 阈值快照），准入字段不变。

**已裁决并实施的行为**：D5/D6（G3 跨图写）已裁决为收敛口径——本期只判锚点存在 + `graph_type='dev'` + `graph_id` 一致，跨图写矩阵不建模（§14.8）；D1/D7 见 M5.8；D3/D9 见 M5.9。

### M5.8 D1/D7 裁决实施记录（2026-11-07，已批准已实施）

**D1（acceptance 结构化格式与迁移）**：
- 格式冻结为 `{ id, type: 'command'|'manual'|'file_check', expected 非空, text? }`；判定只看 `type + expected`，`text` 是人读补充（`work-item-service.ts` 导出 `StructuredAcceptanceEntry`/`normalizeAcceptanceInput`/`normalizeAcceptanceJson`）。
- 写入路径同批收紧：`createDraft` 与 `revise` 在系统边界强制结构化，缺 `type`/`expected`、未知 type、非数组/非法 JSON 一律 `WorkItemGuardError` 拒绝，不静默降级；IPC `workitem:create`/`workitem:revise` 传入的数组经同一校验（服务边界覆盖）。
- 存量 `[{id,text}]` **不自动迁移**：仍判 G2 incomplete（`acceptance_item_not_structured`），由人工重新确认计划时结构化（复用 `awaiting_confirm → queued` gate 守卫）。显式代价：存量任务重新确认前保持 `blocked`。
- 执行面：`agent-step-runner` 的步骤提示词与会话 `acceptance` 按结构化条目渲染为 `- [type] expected（text）`；无法识别的形状防御性跳过，不猜语义。

**D7（G4 预估行数来源）**：
- 算法定为确定性代理：`estimateLines = Σ scope 文件行数`——已存在文件按实际行数（mtime+size 缓存），将新建的文件计 0（新建规模由 G4 文件数上限约束）；scope 指向目录或读取失败 → null → 引擎 `line_estimate_unavailable`（fail-closed）。
- 配置：`BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES` / `BIZGRAPH_MAP_EXECUTION_G4_MAX_LINES`，默认 20/800；非法 env 值回退默认并告警。
- 落点：仅生产装配处（`work-execution-runtime.ts` 导出 `readG4Config`/`buildEstimateLines`）；引擎不改。写明定位：这是**准入代理指标**，真实改动行数由执行后 evidence 对比（超限属执行后审计，不归准入）。

**裁决后的可达性事实**：结构化 acceptance + scope 指向已存在文件的任务，G1–G6 可全绿并通过 tick claim 进入 kernel-only 执行；存量自由文本任务与 scope 指向目录的任务仍按上表 fail-closed。

**测试**：`work-item-service.test.ts` +4（结构化落库/旧格式拒绝/缺 expected/revise 校验）、`work-execution-runtime.test.ts` 新增（env 阈值、Σ 行数、目录 fail-closed、缓存）、`agent-step-runner.test.ts` 断言结构化渲染。

### M5.9 D3/D9 裁决实施记录（2026-11-07，已批准已实施）

**D3（G2 豁免粒度）**：裁决为**任务级粒度**——豁免即现有三字段（`gate_waived_by/at/reason`），作用于整条任务，不引入逐条目豁免（逐条目需新增豁免字段，与「不加 schema 版本」硬约束冲突，明确排除）。生效条件维持「全部缺失码来自 G2、且每个失败条目 type 均为 manual」；**混合 manual+command 时豁免不生效**——command 条目缺 `expected` 属于该补的判定标准，正确路径是人工 `revise` 补全（补全后 G2 自然通过）或改标 manual，豁免只留给「只能人判」的任务形态。

**D9（G5/G6 可豁免性）**：裁决为**永久不可豁免**，三字段豁免对这两道 gate 永不生效，也不为其增加豁免审计字段（不存在合法豁免路径）。理由：G5 放行即允许乱序执行，与 §1.6「未过准入不得入队」及串行语义冲突（正常路径：等上游 done / cancel 上游 / revise 改 `depends_on`）；G6 放行等于在准入时放过已知写冲突，真互斥在 tick 第 5 步写闸，放行只是把冲突推迟到运行期（正常路径：先 `workitem:run:cancel` running 任务，自带 run 级审计）。

**行为变化**：无——两项裁决均确认引擎现状行为，本次仅更新状态词与断言：`gate-engine.ts` 文件头措辞从「D9 裁决前/D3 保守读法」改为「已裁决」；`gate-engine.test.ts` 测试名对齐并**新增 G6+豁免 → incomplete 断言**（此前只有 G5+豁免，G6 无豁免反向断言）。

**边界**：§14.8 表中 D3/D9 行的状态词已在 2026-11-08 单轨收口时更新（文件所有权合并，见文末「单轨分工与文件所有权」）。

### M5.10 D2 裁决实施记录（2026-11-08，已批准已实施）

**范围（最小闭环）**：`src/main/map/acceptance-executor.ts` 只读评估结构化 acceptance。

- `command`：成功判退出码 0；可选 `stdout_contains`（标准输出包含）与 `timeout_ms`（默认 120s，上限 600s）；超时、非 0 退出、启动失败均不通过。
- `file_check`：`expected` 必须是相对路径且经 `isPathInside` 校验落在 `project_path` 内；存在且为普通文件才通过；可选 `content_contains`（UTF-8 内容包含）。
- `manual`：不自动通过，只产出 `acceptance_manual_pending:<i>`；**仅 manual 待确认（其余条目全部通过）时，步落 `needs_input`，run 仍 `completed`，不判负**。待确认条目 id/expected/text 写入 `work_steps.input_request_json`（`kind='acceptance_manual_confirm'`），item 同事务迁到 `needs_input`。
- 非法/空 JSON、存量 `[{id,text}]`、未知 type、`expected` 缺失、manual 缺 id、`project_path` 缺失/不可解析/非目录，一律 `ok=false` 并带具体缺失码。

**接线**：`AgentStepRunner.run` 在 turn `completed` 且 session terminate 之后调用 `verifyAcceptance`：存在非 manual 硬失败 → `run/step failed(verify_fail)`（异常 reason `ACCEPTANCE_VERIFIER_ERROR`）；仅 manual 待确认 → step/item `needs_input`、run `completed`；全部通过 → `succeeded`。`turnStatus` 始终记 `completed`。`WorkExecutionService` 透传，`work-execution-runtime` 装配 `evaluateAcceptance`。`BIZGRAPH_MAP_EXECUTION` 仍默认关闭。

**测试**：`acceptance-executor.test.ts` 20 例（退出码/stdout/超时/启动失败/路径存在与内容/绝对路径与逃逸/目录/不可读/非法 JSON/存量形状/manual 待确认与缺 id/已确认视为通过/混合）；`agent-step-runner.test.ts` 19 例（含通过、硬失败、manual 等待、等待不掩盖硬失败、执行器异常、非 completed 不触发）。相关主测试文件 112 例全绿（含 §M5.11 的 5 例），`tsc --noEmit` 0 error。

**边界**：内容哈希匹配、异步评估时限预算（D14 未来约束）不在本期；`manual` 的人工确认入口已由 §M5.11 补齐。

### M5.11 manual 验收人工确认入口（2026-11-08，已实施）

**写通道**：`workitem:acceptance:confirm`（`ipc/map.ts` → preload 白名单 → `IpcApi` → 面板按钮）。入参 `stepId` 或 `workItemId`（至少一个）+ `entryIds[]`，支持部分确认。

**确认事实存储**：v35 起写入独立表 `acceptance_confirmations`（每条目一行，`batch_id` 分组；字段见 §M5.12）。`9852b77` 曾复用 `agent_approvals`（`tool_name='acceptance_manual_confirm'`）的做法**已废止**——`agent_approvals` 只承载工具调用审批，不得出现从未调用过工具的放行记录。

**重算与收口**：`AcceptanceConfirmationService.confirm` 读 `input_request_json` 校验条目归属，把历史 + 本次确认的 manual id 传给 `evaluateAcceptance` 视为通过：

- 存在非 manual 硬失败 → item `needs_input` → `queued`，step `failed(verify_fail)`，再收敛 item；
- 仍有未确认 manual → 仅更新 `input_request_json`，step/item 保持 `needs_input`；
- 全部通过 → step `succeeded`，item 收敛（全部步终态则 done）。

**显式偏差**（§4.7.4）：manual 确认不新开 attempt、不重跑 agent——原 turn 已完成，人工只补验收事实；“补充信息后重跑”的原 needs_input→pending 路径仍保留，二者不混用。并发确认由 `input_request_json` 版本比对守卫（`STEP_STATE_CHANGED`），重复确认只允许一次。

**面板**：`NodeMapPanel` 在 `needs_input` 步下渲染待确认条目与“确认”按钮（`workitem:acceptance:confirm`），这是面板的唯一写操作；其余仍只读。

**测试**：`acceptance-confirmation.test.ts` 5 例（确认通过、部分确认继续等待、确认后硬失败、仅 itemId 定位、未知条目/重复确认）。

### M5.12 验收确认事实独立建表（v35，2026-11-08，已实施）

**动机**：`9852b77` 把人工验收确认写成 `agent_approvals` 行（`tool_name='acceptance_manual_confirm'`、直接 `status='allowed'`），绕过了 `ApprovalGateway`。后果是“哪些工具调用被放行”的审计里出现从未调用过工具的记录，语义被混。

**语义边界**：`agent_approvals` 只承载**一次工具调用的审批**（`subject_type='agent_turn'|'test_plan'`，`tool_name` 必须对应真实工具）。人工验收确认不是工具审批，不得写入该表。

**新表** `acceptance_confirmations`（schema v35）：

| 列 | 含义 |
|---|---|
| `id` | 事实行 id |
| `batch_id` | 一次确认调用分组（`acb_*`；历史迁移为 `legacy:<approvalId>`） |
| `work_item_id` / `step_id` | 所属任务与等待步 |
| `entry_id` | 被确认的验收条目 id（每行一个） |
| `decided_by` / `decided_at` | 谁在什么时候确认 |
| `decision_note` | 可选备注 |
| `source` | `user`（新写入）或 `legacy_agent_approval`（迁移来源） |
| `legacy_approval_id` | 迁移前 `agent_approvals.id`（可追溯，迁移不静默删） |
| `created_at` | 写入时间 |

唯一索引 `ux_acceptance_confirmations_entry(work_item_id, step_id, entry_id)` 保证同一步同一入口只确认一次；部分确认重试仍由 `STEP_NOT_WAITING` 挡住。

**迁移（v34→v35）**：新建表；`runIncrementalMigrations` 扫描 `agent_approvals.tool_name='acceptance_manual_confirm'` 的行，按 `args_json.entryIds` 逐条搬入新表后删除旧行。解析不了（缺 `step_id`/`subject_id`/`entryIds`）的历史行**保留并告警**，不静默丢失。实库核查（2026-11-08）：历史行 **0 条**。

**读取路径**：`listConfirmedEntryIds(stepId)` 改为查 `acceptance_confirmations.entry_id`；重复确认、批次确认、半批确认行为不变。

**测试**：迁移用例覆盖新表建成、旧行迁入且 `legacy_approval_id` 可追溯、信息不全行保留、非验收审批行原样保留、无 `_backup` 残留、`version=35`；确认用例断言 `agent_approvals` 不再出现验收行。

### M5.13 全局审批入口（方案一，2026-11-08，已实施）

**动机**：`ApprovalRequestDialog` 只挂在 `AgentChatPanel` 的「`currentThread` 存在」分支。编排 runtime 的 kernel turn 由主进程发起，不在 renderer 建线程，审批请求虽已广播到 renderer（`pending=1`），却没有任何组件挂载，最终 120s 交互超时 fail-closed 落 `denied`。真机演练据此断在「工具调用审批真的弹了」这一环。

**形态**：应用级 `ApprovalInbox`（固定于窗口右上、任何页面可见，可折叠，显示条数徽标）。展开后逐条展示：工具名、风险等级、命令/参数原文、来源三元组（任务 `workItemId` / 步骤 `stepId` / 会话 `sessionId`）、剩余秒数，并提供 allow(once) / deny。

**单一事实源**：新增渲染端 `approvalStore`，由 `attachApprovalListener()`（`App` 启动时挂一次）负责 `hydrate`（`agent:getPendingApprovals`）+ `onApprovalRequest` 增量 + `onApprovalResolved` 移除。聊天内弹窗改为投影同一 store，不再自持队列；聊天场景行为（倒计时、陈旧审批 `APPROVAL_STALE` 横幅、会话授权按钮、脱敏提示）保持不变。

**不重复网关语义**：120s 交互超时、deadline 冻结、归属校验（`sessionId/turnId`）、`argsHash` 防 TOCTOU 全部仍在主进程 `ApprovalGateway`；队列里的倒计时只是展示，决议仍走 `agent:resolveApproval`。

**来源字段**：`ApprovalRequestPayload` 新增可选 `workItemId`（由 `agent_approvals.step_id` 反查 `work_steps.work_item_id`，只读、查不到即不展示），仅用于展示，不参与判定。

**测试**：`ApprovalInbox.test.tsx` 3 例（无 pending 不渲染、编排 turn 审批可见工具名/命令/来源、允许后队列即时减少且归属字段回传）；`ApprovalRequestDialog.test.tsx` 8 例保持全绿。

### M5.14 gate 逐道诊断（D12 修订，2026-11-08，已实施）

**动机**：tick 第 2 步每次都会重跑 G1–G6，但库里只留最终 `gate_status` + 聚合 `gate_missing_json`。排查者无法回答「gates 第 3 道为什么没过」——尤其 G2 豁免通过时（整体 ok 但 G2 实际失败）现场完全丢失。

**职责边界**：`gate-engine.ts` 保持**只读纯引擎**（仍不写任何表，零写入测试不变），只把逐道结果作为返回值附加：`GateRecheckResult.diagnostics = { evaluatorVersion, thresholds, gates[] }`，`gates` 恒为 G1..G6 六项，每项 `{ gate, ok, missing[] }`。落库由 tick 调用方完成。

**载体（无 schema 变更）**：复用既有报告表 `map_migration_reports`（§8.14.1 本身即「所有阶段记录复用本表」）：
- `kind='integrity_check'`（G1–G6 是准入完整性判定，取语义最近的既有枚举值）；
- `stage='gate_eval:<workItemId>'`：按任务分组，保留最近 20 次评估；启动预检只关心 `failed/running/partial`，本模块只写 `status='ok'` 且为单条插入，不产生 running 行，因此不影响迁移与 preflight；
- `stats_json`：`verdict`（pass / waived / incomplete）、`missing_count`、`evaluator_version`（`gate-engine@1`，语义变化须同步更新）、`thresholds`（G4 实际取值）、`engine_error`；
- `details_json`：`gate_status_before`、逐道 `gates`、聚合 `missing`、`waived`。

**纯诊断**：不写 `work_items/work_steps/work_runs/node_evidence`，不进入用户可见状态；写失败仅 `logger.warn`，绝不阻断 tick（`recordGateEvaluation` 内部兜底，表缺失即跳过）。

**排查查法**：

```sql
SELECT started_at, stats_json, details_json
FROM map_migration_reports
WHERE kind = 'integrity_check' AND stage = 'gate_eval:<workItemId>'
ORDER BY started_at DESC, id DESC
LIMIT 1;
```

`details_json.gates` 里找 `gate='G3'` 的 `ok/missing` 即可定位；`stats_json.evaluator_version` + `thresholds` 用于复算归因。

**测试**：`gate-engine.test.ts` 新增 3 例（六道齐全 + 失败道定位、阈值快照随参数、豁免时保留 G2 失败现场）；`work-execution.test.ts` 新增 2 例（blocked 时六道写入且用户可见状态不受影响、引擎异常留行并标注 `engine_error`）。两文件 73 例全绿。

## 单轨分工与文件所有权（2026-11-08）

> 用户裁决：只保留**蓝图/编排线**单轨继续；其余三条线冻结。状态词按 §0 三态口径。

### 冻结线

| 线 | 状态 | 依据与收尾 |
|---|---|---|
| L2 审查修复 | **已实施，冻结** | P0 3/3（`2ce268b`）；P1 8/8 有对应修复提交（`88ab019`/`6e472de`/`c7a04a9`/`f65935d`/`9493fde`/`d8ace71`/`b53b82c`/`13321fc`）；P2 8 项中 4 项可核对（`1fd91fe`/`ed22fd8`/`f2f2882`/`dcf5af2`），其余 4 项需取回原始审查清单、按复现决定，本轮不改代码 |
| 启动与退出诊断 | **已实施，冻结** | `9b220ab`/`6e472de`/`4eb95b5`/`c7a04a9`/`13321fc`/`d8ace71`；无已知挂账 |
| L2 执行触发 | **已实施，冻结** | `7d9ef7e`（tick/写通道）、`b6f3735`（G1–G6）、`e4398e7`（D1/D7）、`94125bd`（D3/D9）；D2 原为已批准未实施，2026-11-08 由本单轨实施（`acceptance-executor.ts`） |

### 文件所有权（自 2026-11-08 起统一）

`src/main/map/gate-engine.ts`、`gate-recheck.ts`、`work-execution-service.ts`、`work-execution-runtime.ts`、`work-scheduler.ts`、`agent-step-runner.ts`、`execution-flags.ts`、`src/main/ipc/map.ts` 及对应测试，归蓝图/编排线。冻结线不再修改这些文件；发现并行改动时先停下报告。

### 三态总账

- **已实施**：S1–S8、L1、M1–M5、G1–G6、D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D13/D14。
- **已批准未实施**：① §3.7.3 E4 覆盖内容/范围变化扫描；② §M5.6 四条（存量自由文本 acceptance、Tier1 探测、跨进程写闸、renderer 执行入口）；③ §12.9 的 `stepMs`/`taskMs`/`sendWaitMs`（`turnMs` 已实施）。
- **仅建议**：未来跨图写入面出现时的 G3 扩展、异步评估器的时限预算与版本精确归因（D12 已裁决本期不做）；L3 全部条目见 Part I I.1.3。
- **待裁决**：Yjs 是否完全移除（§2.8）；以及 Part I I.4 的 17 项。
