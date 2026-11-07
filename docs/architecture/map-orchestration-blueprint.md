# BizGraph 三图与任务编排蓝图 v1.2.3（R10 勘误版）

> **状态**：v1.2.3 = v1.2.2 + **R10 勘误**（对方 §12.13 全清单 8A+4B+4C 收到并逐条复核，见 §6 R10：**A3 行数 / A5 测试计数为新增修正**——R9-4 本侧改的"130"亦无口径，一并再勘误；其余 6A/4C 均已在 R9/v1.2.2 修正，4B 行号偏移更新）。
> v1.2.2 = v1.2.1 + **F1-F3 已实施**（四提交：`9ce519c` F1 / `f73abd8` F2 / `260df58` F3-A / `fb19e07` 契约补齐，分支 `worktree-blueprint-f1-f3`，2026-11-07）+ F3 超时默认值裁决（配置键 `agent.timeouts.turnMs`）+ 审批期 deadline 裁决（候选 A 冻结重算）。
> **本文角色**：① 双向收敛记录（R5-R10）；② L3 设计保留区；③ 前置实施记录与裁决档案。
> **L1/L2 实现以 `session-map-blueprint.md` 为唯一权威**（**当前 3441 行** @ `f411837`，2026-11-07 `wc -l` 实测；本侧 §8.15 状态同步后行数不变，含逐章覆盖审计表）。两文冲突时：L1/L2 以对方为准，L3 以本文为准，收敛史与勘误以本文 §2/§6 为准。
> **可信度声明**：v1.2 曾把"已批准"误写为"已实施"、数字未复核。R9 起，本文状态词严格三态：**已实施 / 已批准未实施 / 仅建议**；一切数字与行号引用必须经 grep 复核后才可写入。

---

## 0. 收敛终态（一句话）

**L1/L2 走 Trae 骨架**（entity_key 身份层 + 证据双轨 + work_items/work_steps/work_runs + 结构推导拆解 + TestExecutor + S0-S8 迁移），**注入本侧的执行机制**（失败分类/写闸/超时对账/能力票，已并入对方 §5.9，F3-A 已落定），**L3 保留本侧的交互与进化设计**（mediated blackboard、三层进化、提案机制）。v1 完成定义 = **L1 + L2**。

---

## 1. 文档关系

| 文档 | 权威范围 | 备注 |
|---|---|---|
| `agent-architecture.md` | turn 级执行面（审批网关/Bash 策略/会话恢复/能力矩阵/账本） | 不变 |
| `session-map-blueprint.md`（当前 3441 行 @ `f411837`） | **L1/L2 单一权威**：三真图、entity_key/node_links、状态双轨与证据 E0-E4、work_items/work_steps/work_runs、结构推导拆解、执行编排机制（§5.9，含 §5.9.8 needs_input）、TestExecutor、迁移 S0-S8、**逐章覆盖审计表**（可施工/缺细节判定） | a60355a 后提交：`71eade8`/`5b26715`（D1-D8 落定）/`b898358`+`cc749ce`（Yjs 单向只读，**代码级**）/`5836262`（B1 施工细则+覆盖审计）/`5db986e`（五条裁决落定）/`f411837`（**§12.13 勘误清单**，R10 已处理） |
| **本文** | 收敛记录（§2）+ 主计划（§3）+ L3 设计保留区（§4）+ 前置授权与修复方案（§3.1）+ 勘误（§6 R9） | P0-P4 已退役 |

---

## 2. 收敛记录

### 2.1 R5 —— 本侧对 Trae 蓝图的交叉验证

- **快照标注（R9 修正、R10 更新行数）**：R5 基于该文档 **1809 行时点快照**（a60355a 之前）。当前文档 **3441 行**（@ `f411837`，2026-11-07 `wc -l` 实测）——**R5 的章节引用与个别结论需按现文本复审后方可继续引用**（列入 §7 交审项）。
- 6 项事实核验当时全部属实；"Yjs 专测 86 个"为**错误计数**（R9-4）。**R10 再勘误（A5）**：R9-4 本侧改的"130"同样无口径——实测（2026-11-07）：声明口径 `grep -rEc "\bit\(" --include='*.test.ts' src/main/realtime` = **8 文件 112**；加 `conflict-reporter.test.ts`（7）= **119**；子串口径 `grep -rc "it("` realtime = **116**。三个数字（86/130/119）分属不同时点与口径，引用一律附命令。

### 2.2 R6 —— Trae 回审（`a60355a`，+242/−5）与用户裁决

**Trae 采纳本侧 4 大块**：①执行编排机制（§5.9）；②测试闭环（§6.6/6.7）；③ExecutionRecord 派生视图（§4.6，不新增表）；④dev→online 不自动回写（§2.7）。

**Trae 驳回 7 项**：LLM 直产 TaskDAG（用户认可驳回）、节点状态自动推进（认可）、graphId+nodeId targets（认可）、test-flow 节点、MVP 无 worktree、review gate 计已验证、拆 Yjs/改 Queue。

**用户四条拍板**：Yjs/Queue 延 L3；三缺陷逐条裁决；发布进度仅内部；提案 UI 留 L3。

### 2.3 R6 后续 —— 对方 5 个新提交的裁决（本侧已核验摘要）

| 提交 | 内容 | 对本文的影响 |
|---|---|---|
| `5b26715` | **D1-D8 全部落定**：D2 采纳 work_steps 独立表（表数 21→22，L1 13 张）；D3/D5 planner 分层与权重校准口径；D6 统一 agent_approvals 不建 test_approvals；**D8 取消伪节点**（未挂载会话保持纯 thread，本侧建议被采纳）；A 六项（假 E3 fail-closed、**change_sets 进 L1**、取消/环检测/Tier2 写路径/allow-list 纪律）；B 八项（步级状态机、flow 可执行定义、published 软阻断、路径规范化、迁移状态机） | §2.4 归宿表、§5、§8 多处更新 |
| `cc749ce` | **Yjs 单向只读（代码已落地）**：移除 attachDiffHandlers、doc→SQLite 写回切断、WS 端点只读（step2/update 一律 1008 拒绝） | §3.1 WS 缓解项**被更彻底方案取代并关闭**；§4.5 事实基线更新 |
| `5836262` | B1 施工细则 + **逐章覆盖审计表**；F1-F3 行为契约；黑板/Phase B 约束记录；Yjs L3 拆除九类清单；Zcode 异议清单 | 本文 §4 各节实现须与其施工细则对齐 |
| `5db986e` | **五条裁决**：U1 过期 E4→`stale`（不降 implemented）；**F3 采用 F3-A**（`failed`+`failure_type='timeout'`，F3-B 重建表已否决）；plan_deviations 归因统一 `derivation_version`+`observed_rule_version`；work_items.status 补 `failed` 共 **13 值**（含 needs_input，§5.9.8/INPUT_REQUIRED）；MVP 仅 Tier 1、published 软阻断、流程级测试 L2 最小版 | §3.1 F3、§4.2.2、§7、§8 更新 |

### 2.4 原始决策 Q1-Q16 归宿表（v1.2.1 修订）

| 原决策 | 归宿 |
|---|---|
| Q1 节点↔会话 1:N+活跃指针 | **存活**——node_session_links 多对多；UI `{activeThreadId, threadIds[]}`；threadStore 修复（对方 §9.5） |
| Q2 一等任务实体 | **修改存活**——统一 work_items/work_runs；**D2 裁决后编排步独立为 work_steps 表**（22 张表，L1 13 张）；本侧步字段全部落位 |
| Q3 混合编排 | **修改**——LLM 自由 TaskDAG 驳回；结构推导候选+模型只选+人工确认 |
| Q4 第三 GraphType='test' | **存活**——S4 CHECK 扩展（不可逆里程碑） |
| Q5 提案式单向回写 | **存活**——§2.7；提案 UI 留 L3（R7） |
| Q6 流程闭环测试 | **存活**——§6.6/6.7；flow 用 suite 表达；流程级测试 L2 最小版（5db986e 裁决） |
| Q7a 拆 Yjs | **改判**——延 L3（§4.5）；**写回危险已被 `cc749ce` 单向只读消除（代码已落地）** |
| Q7b 并行+两铁律 | **存活**——TestCommandGateway 采纳（§6.8） |
| Q7c 能力票三档 | **存活**——§5.9.5；MVP 仅 Tier 1（5db986e 裁决确认） |
| Q8 ExecutionRecord | **修改存活**——活动流派生视图不新增表；**编排步数据落 work_steps**（D2） |
| Q9 任务排队+删 RequestQueue | **修改**——排队/写闸/优先级采纳（§5.9.3）；RequestQueue 删除延 L3 |
| Q10 编排底层 | **部分存活**——错误策略表/状态机/结构化输出协议采纳；**F3 按 F3-A 落定**（对方与 R9 核验结论一致）；多 Agent 交互全案留 L3（§4.1） |
| Q11 测试图模型 | **修改**——test-flow 节点驳回；case_kind 入 metadata |
| Q12 bug 闭环 | **存活**——§6.6 全案 |
| Q13 进展语义 | **修改**——review gate 降级映射；published 软阻断存活（5db986e 确认）；**U1 裁决：过期 E4→stale** |
| Q14/Q15 P0-P4 | **退役**——L1/L2/L3 取代；F1-F3 转逐项授权（R7 已批，待同步对方清单） |
| Q16 单一权威文档 | **修改**——L1/L2 权威在对方文档；本文=收敛记录+L3 保留区 |

---

## 3. 主计划（L1 / L2 / L3）

### 3.1 开工前置（R7 已逐项批准）——修复方案细则（v1.2.1 勘误后）

> 授权原则：逐项列示后批准，不打包；后续增补同样逐条过目。以下方案已与对方 §8.15/B1 行为契约对齐；冲突时以对方施工细则为准并回改本文。

#### F1 子代理超时/失败路径补 terminateSession

> **状态：已实施**（`9ce519c` + 契约补齐 `fb19e07`，含 P-F1 级联取消与 P-F2 计时起点前移，对齐对方 §8.15 契约 4）。

- **现状**：超时 reject 在 `subagent-manager.ts:580-590`；finally（:615-621）只清 timer；terminateSession 仅成功路径（:631-636）与 sendCommand 失败路径（:601-613）。
- **方案**：catch 路径（失败/超时，非 cancel）补 `terminateSession`，沿"取消方置终态、执行方检测 aborted 不覆盖"既有契约（:429-436）；超时与取消竞态保留 cancelled；terminate 自身失败容忍（warn）；确认沙箱收尾钩子触发。方案与对方 B1 行为契约一致。
- **实施补充（fb19e07）**：P-F1 = AgentManager 新增 `onSessionEnded` 注册 API（onSessionCleanedUp 触发），父会话收尾级联 cancel 子代理（partial 保留）；P-F2 = settle/计时起点前移到 startSession 之前，建会话期间超时→terminate 刚建会话并传播原始错误；顺修 settlePromise 等待窗口的 unhandledRejection 隐患。
- **验收**：慢响应子会话超时后进程树确死；取消竞态无终态覆盖。（专测 4+3 例覆盖）

#### F2 失败保留部分产出（partial output）

> **状态：已实施**（`f73abd8` + 契约补齐 `fb19e07`，对齐对方 §8.15 F2 契约 1/5/8：结构化摘要、无文本前缀、cancelled 同样保留 partial、SubagentResult 增加 status/error）。

- **现状**：`subagent-manager.ts:536-541` 已收集 outputBuffer/fileChanges；`:623` resultText 仅成功路径拼接。
- **⚠️ 勘误（R9-2）**：v1.2 称"截断上限 1MB 与现有一致"是**错的**——1MB 是 recipe-runner 的 shell stdout/stderr 上限（`recipe-runner.ts:189,196`）；subagent 输出链路的既有截断是 **`BaseAdapter.MAX_OUTPUT_ENTRY_SIZE = 10_000`（`base.ts:90`，单条 10KB）**。
- **方案（修正后）**：①既有单条 10KB 截断保持不动；②`SubagentResult` 增加 `partial: boolean`；③partial resultText 拼接**总量上限显式新设 64KB**（新常量，配置化），超出截断加 `[truncated]` 标记；④`repo.fail` 写入带 `[partial]` 前缀；⑤emitProgress('failed') 携带 partial 摘要。
- **⚠️ 契约修正（fb19e07，④⑤按对方细则改）**：细则 §8.15 F2 契约 8 明确**不使用 `[partial]` 文本前缀**，partial 一律结构化——`repo.fail` 存原始部分输出；emitProgress 携带 `{resultTextChars, resultFilesCount, truncated}`；`SubagentResult` 另加 `status`/`error` 字段；cancelled 行经 `repo.mergePartialResult` 同样保留 partial（契约 5）。
- **验收**：中途失败子会话的 invocation 行含部分输出与 fileChanges；64KB 截断生效。（专测 6 例 + repo 4 例 + IPC 3 例覆盖）

#### F3 deadline 写入方与到期强杀（采用 F3-A，与对方 5db986e 裁决一致）

> **状态：已实施**（`260df58`）。超时默认值单一来源**已裁决（2026-11-07）：配置键 `agent.timeouts.turnMs`**（单步 10min/测试 60min 由 L2 编排层消费该键给出，kernel 层不设默认值）；审批等待期 deadline 处置**已裁决：候选 A（冻结重算）**——进入 `waiting_approval` 记 `paused_at`，批准恢复时 `deadline_at += 等待时长`，代码随 L2 编排层实现。

- **⚠️ 勘误（R9-5）**：v1.2 的"调 cancelTurn → finalizeTurnStatus(failed, timeout)"**逻辑不成立**——`cancelTurn` 内部已做终态 CAS 写入 `cancelled`+failureClass='aborted'（`runtime.ts:766-771`），`finalizeTurnStatus` 是终态 CAS，二次写 `failed` 返回 false，超时会被永远记成"用户取消"。
- **方案（F3-A）**：
  1. **写入点**：`sendCommandThroughKernel` 透传 `deadlineMs`；`insertTurn` 的 `deadlineAt ?? null` 参数位已存在；**写 0 = 不启用**（不是立即超时）。F3 不设默认值，L2 编排层给默认（单步 10min/测试 60min，`agent.timeouts.turnMs` 配置键 vs 常量由用户裁决，单一来源）。
  2. **超时路径不复用 cancelTurn**，专用顺序：①超时控制器先杀进程组并 terminate 会话（终态在 terminate 之后）；②按 F2 落 partial；③**单次终态 CAS**：`UPDATE agent_turns SET status='failed', failure_type='timeout', error_code='DEADLINE_EXCEEDED' WHERE id=? AND status='running'`；④changes=0 → 已被完成/取消抢先，读实际终态保留，不覆盖。
  3. **DeadlineReaper 规格（R9-6 补）**：归属 AgentManager（持 runtime 句柄，随 runtime 启停）；`setInterval` 5s；扫描 `status='running' AND deadline_at>0 AND deadline_at<now`（部分索引 `idx_agent_turns_deadline ... WHERE status='running'`，对方已定）；**waiting_approval 跳过**；进程内 in-flight 去重集合 + 终态 CAS 双保险防重复杀。
  4. `agent_turns` 无 `timed_out` 状态值：**不重建表**（S4 级不可逆操作，不值得），UI 由 failure_type 派生"超时失败"徽标；`failure_class` 枚举扩展 'timeout' 需核对无 CHECK 约束或随迁移放宽。
- **实施记录（260df58）**：①写入链 `AgentCommand.deadlineMs → sendCommandThroughKernel → RunNodeRequest → insertTurn`，0/undefined=不启用，kernel 层无默认值 ✓；②Reaper 归属 AgentManager 随 setRuntime 启动、5s、部分索引（CURRENT_SCHEMA_VERSION 24→25）✓；③**实施顺序差异**：`expireTimedOutTurn` 为 同步 reap → **同 tick 终态 CAS**（列名按代码实况为 `failure_class`，无 CHECK 无需放宽）→ 之后 abort/driver.cancel/会话级 terminate——CAS 与 reap 间无 await，被杀 driver 死亡事件最早下一轮事件循环才可达，CAS 稳赢；若按②字面顺序在 await driver.cancel 之后才 CAS，死亡事件可抢写 cancelled/非 timeout 失败，违反验收。终态唯一性由 CAS 守卫保证，②③④语义不变；④waiting_approval 双重拒门（扫描过滤 + expire 二次校验含未到期拒门）✓。真库 10 例 + reaper 单测 6 例 + 透传 1 例。
- **验收**：卡死 turn 到期后 status='failed'/failure_type='timeout'/DEADLINE_EXCEEDED；waiting_approval 不触发；deadline=0 无感；与用户取消竞态时终态唯一。

#### ~~过渡缓解：Yjs WS server 默认关闭~~ —— **已关闭，被更彻底方案取代**

- **⚠️ 勘误（R9-1）**：v1.2 称"前置缓解已上"是**错的**——核验 `BIZGRAPH_YJS_WS` 全库不存在、`new YjsRealtime(db)` 无 options（`ipc-handlers.ts:348`）、`disableWebSocket ?? false` 默认启动。该缓解**从未实施**。
- **最终状态**：对方 `cc749ce` 以更强方案落地——Yjs 改单向只读（doc→SQLite 写回切断 + WS step2/update 一律 1008 拒绝），"陈旧快照覆盖 SQLite"危险路径已在**代码层消除**。本文缓解项关闭；验收改为确认 cc749ce 行为（readonly-sync 测试已有）。

### 3.2 阶段定义（v1.2.1：change_sets 移入 L1，沿对方裁决）

| 阶段 | 内容（迁移批次） | 验收要点 |
|---|---|---|
| **L1**（13 张表） | S1（entity_key+导入查重+回填）、S2（node_links）、S5a（work_items/**work_steps**/work_runs/node_session_links/routing_decisions）、S6a（node_evidence/node_execution_state）、**change_sets 进 L1（5b26715 裁决）**；功能：时间线/叠加层、活动流派生视图、双轨收敛（§9.5 五缺口）、L1 不开放删除 | 重导不丢会话；跨图可跳转；多会话历史完整；派生态与人写状态并列不互写 |
| **L2** | S3（归档）、S4（CHECK 扩展，**不可逆**）、S7（结构推导/计划/偏差）、S8（测试表+审批 subject 扩展）；功能：C1-C4、G1-G6、§5.9 编排机制（顺序多步、Tier1-only）、TestExecutor、bug 闭环+定向重测、发布进度内部视图 | 单节点任务全链跑通；测试失败自动建 bug 且定向重测可关；S4 前完成演练 |
| **L3** | DAG 并行、候选推导调优、提案 UI、多 Agent 交互全案（§4.1）、进化三层（§4.2）、codex Tier2（§4.4）、Yjs/RequestQueue 处置（§4.5）、`agent_turns.node_id` 放宽（D8 已取消伪节点，放宽列为长期待办） | 按 §4 各节验收 |

### 3.3 与已退役 P0-P4 的映射

拆 Yjs/删 RequestQueue → L3（§4.5）；三缺陷 → 前置 F1-F3；§9.5 五缺口 → L1。P1 → L1。P2 → L2（planner 改候选制）。P3 → L2。P4 → L3。

---

## 4. L3 设计保留区（对方未吸收部分，实现前按此执行；实现须对齐对方 B1 施工细则）

### 4.1 多 Agent 交互全案（mediated blackboard）

**核心原则：agent 之间不直接对话。** 一切交互经调度器中介、经持久化制品承载。DAG 并行开启时生效；L1/L2 顺序执行只用其子集（结构化输出协议 + checker_work_item_id，已入对方 §7.2）。

#### 4.1.1 Agent 运行时单元

```
AgentRuntime = 角色定义(AgentTypeDefinition) × 执行器(按能力票; 短命,一步一会话)
             × 作用域(allowedFiles + isWriteCapable; inherit/subset/fresh)
             × 上下文束(ContextBundle) × IO 契约(StepInput → StepResult + outputSchema)
```

#### 4.1.2 IO 契约（字段级）

```ts
StepInput {
  stepId; taskId; attempt;
  commandPrompt: string;
  scope: { allowedFiles; forbiddenFiles; invariantRules; acceptanceCriteria };
  depsOutputs: Record<stepId, unknown>;   // 仅声明引用的上游（按 output_schema 校验）
  memoryDelta: { lessons: string[]; waterline: string; retrieved: MemoryRef[] };
  deadlineAt?: number;                    // 0=不限（F3-A 口径）
  attemptContext?: { lastFailureClass?; lastPartialRef?; comments?: string[]; userAnswer?: string };
}
StepResult {
  stepId; attempt;
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out(展示层,由 failure_type 派生)';
  resultText: string;
  parsedOutputs?: unknown;  outputParse: 'ok' | 'fallback';
  fileChanges: { path; kind }[];          // 确定性：file_change / 工作区差分 → change_sets
  artifactRefs: string[];
  usage: { inputTokens; outputTokens; costMicros?; durationMs };
  failureClass?; error?; partialOutputRef?;
}
```

存储映射：parsedOutputs/outputParse → work_runs.outputs_json；fileChanges/diff → change_sets；usage → agent_usage；步级状态以 work_steps 为准（对方 §4.1.2：run 级 attempt 与 work_steps.attempt 对应，以 work_steps 为准）。

#### 4.1.3 尾块协议（约定标记解析）

- **outputs 块**：```` ```bizgraph-outputs ```` 围栏 JSON；解析链=最后一个围栏 → JSON.parse → 兜底最后一个平衡 `{...}` 对象 → 仍失败 `output_parse='fallback'`。块 ≤16KB；schema 外字段丢弃记 `output_extra_keys`。
- **verdict 块**：`VERDICT: PASS|FIX` + `COMMENT_N:`；**缺失默认 FIX**（保守）。
- **consult 块**：`CONSULT: [{role,question}]` → 只读子步（explore/inherit，独立额度 3，不占业务额度）→ `CONSULT_RESULT_N:` 注入下一 attempt。
- **needs_input 块**：**沿对方 §5.9.8 已定格式 `INPUT_REQUIRED {type,question,options?,default?,blocks[]}`**（本文早先草案作废）；转 needs_input 状态、写 `work_steps.input_request_json` 同事务；**原会话不复活**，回答后开新 attempt。

#### 4.1.4 ContextBundle 装配与预算（v1.2.1 补总口径）

- **总预算口径（R9-7 补）**：总 token 预算 = PromptOrchestrator 现有基线——`PROMPT_BUDGET_MIN=4000 / PROMPT_BUDGET_MAX=16000`（`prompt-formatter.ts:30-31`），按 commandType 基线 fix_bug/add_test=6000、refactor=10000、implement=12000，自适应 `getOptimalPromptBudget`（成功样本均值×1.2）；**tokenizer 口径 = `estimateTokens`（`src/shared/token-utils`，字符近似估算，与 Waterline 同源）**。五层配比（system 10/scope 25/context 35/memory 5/user 25）是对上述总量的划分，超预算走 scope 四级压缩阶梯。
- memory 段细则：waterline 增量 ≤800 tokens；HybridSearchEngine top-k=5（embedding 可用），降级 `getRecent(3)`。数据最小化铁律：不注入兄弟分支产物/全图，depsOutputs 只含声明引用项。

#### 4.1.5 maker-checker 控制器

checker 经 `checker_work_item_id` 挂接；verdict=FIX → 主 item 新 attempt（comments 注入），fix 轮上限 2（`orchestration.fixRounds`）→ 超限 needs_human。checker 与主 item **不同会话无共享上下文**（只看 scope+change_sets diff+acceptanceCriteria，防自己验自己）；checker 只读不占写闸；checker 自身 infra 失败走 §5.9.2。

#### 4.1.6 顺序 → 并行（DAG WaveExecutor 扩展）

分波复用 `recipe-dag.ts`；就绪集 = 波内 ∧ gate 过 ∧ 写闸可进 ∧ 额度未满。额度：全局 2/单图 1/单节点 1（L3 起可配），consult/checker 独立额度 3。同波写型步骤 allowedFiles 交集非空→写闸串行；无交集→真并行；高冲突场景 L3 评估 worktree-per-branch（非默认）。取消：AbortController 链级联，已完成 run 不回滚。对账：interrupted 按 wave 重算就绪集，已完成 keep、非终态按对方五行处置、queued 重排、需审批步骤不自动重放。

#### 4.1.7 端到端时序示例

（三步任务含一次 fix 循环的逐事件表，见 v1.2 版本；状态列按对方 13 值状态机与 work_steps 校正后继续有效，此处不重复。）

### 4.2 进化机制三层（只产建议，全部过人工评审，零静默自改）

#### 4.2.1 Layer 1 记忆进化

语义检索接线（HybridSearchEngine 进主链，top-k=5，降级 getRecent）；**失败会话 LLM 提取**（outcome∈{failure,abnormal} 或 scopeGuardError 触发，StageOverride.replace('extract')，输出 lesson JSON，confidence 0.6 起，幻觉过滤沿用）；置信度动态校准（注入+success +0.05 cap 0.95；注入+failed −0.1；90 天未命中展示层降权）；命中率持久化倾向新表 `memory_hits`，随层动工时建（建表纪律）。

#### 4.2.2 Layer 2 派发精度进化（v1.2.1 修正数据源 claim）

- **⚠️ 勘误（R9-8）**：v1.2 称"数据源全部现成"**不成立**——`agent_logs` 无 `work_item_id` 列、`subagent_invocations` 无任务连接（两者仅有 session/node/graph 维度）。
- **修正后的关联路径**：一切聚合必须经 **`node_session_links`（session_id ↔ work_item_id）** 关联；因此新增 **L2 硬约束：编排产生的每个会话（agent/test/human）必须登记 node_session_links（session_origin='map_task'），未登记的会话不纳入派发精度归因**。
- 归因记录：routing_decisions.metadata.decision_context（taskType/fileDomains/特征/落选原因）。聚合：每 20 个终态任务离线跑（沿对方 5db986e 裁决的单一窗口：20 run/2 周）；维度归因统一 `derivation_version` + `observed_rule_version`（对方已定）。
- 修订建议：LLM 输入=类型清单（补 `base.ts:1535-1542` 注入缺口）+成功率表+最差 3 案例 → `{edit|create|deprecate, target, patch, rationale}` → work_item(proposal) 评审 → registerType 热注册生效。

#### 4.2.3 Layer 3 技能沉淀（v1.2.1 补数据模型与算法）

- **相似度数据模型（R9-9 补）**：任务终态（done）时计算 `task_embedding`（384 维，embedding-service all-MiniLM-L6-v2，文本=title+description+goal，与 memory persist 同源），存 `work_items.metadata_json.task_embedding`；触发判定=与历史 done 任务（走过结构推导）余弦相似度 ≥ `orchestration.recipe.similarity`（**默认 0.85，配置化，先默认上线按真实分布校准**——沿对方查重阈值同哲学）。无 embedding 服务时不触发（降级，不猜）。
- **路径→glob 归纳算法（确定性，草稿仍过人工评审）**：对 N(≥3) 个成功任务中同一步骤的 allowed_files 求并集 → ①计算最长公共目录前缀（LCP）；若前缀深度 ≥2 级且前缀下项目内文件数 ≤50 → 归纳为 `前缀/**`；②否则按扩展名分组归纳 `前缀/*.ext`（同规则）；③剩余零散文件保留显式清单；④归纳结果标注 `generalized: true` 供 C1/评审时重点核对。禁止把归纳范围扩大到 N 个任务并集之外。
- **消费**：planner prompt 注入候选（相似度 ≥0.8）；planner 可输出 `{useRecipe, inputBindings}` 直接 compile（仍过 C1 展示）。版本与反哺：消费失败率超阈值 → 修订/下架建议走评审。

### 4.3 dev→online 提案机制细节（对对方 §2.7 补充）

生成时机（任务 done 后结构对账，确定性信号优先）：①dev 新增节点无 derives_from；②online 节点 dev 侧无活跃后裔；③依赖边拓扑变化涉 online；④acceptance 与实现摘要冲突（LLM 判，加权）。生成器=单 LLM 调用 → work_item(anchor=online, metadata.proposal)。冲突串行：同实体活跃提案 >1 → 后到 blocked('conflict')。降权：同信号被驳回 ≥2 → confidence 阈值上调。UI 在 L3（R7 已拍板不提前）。

### 4.4 codex Tier2 升格路径（M 档）

注意：**Tier2 写路径与审批网关冲突已被对方二轮审查认定**（5b26715 A 六项/Tier2 写路径；5db986e 裁决 MVP 仅 Tier 1）——升格前必须先解决该冲突。路径：feature-flags 双票拆分（`KERNEL_AUDIT_CAPABLE_BACKENDS`）；codex 静态策略闸 `sandboxMode='workspace-write'`+`approvalPolicy='untrusted'`；ScopeGuard 全量沙箱+事后差分兜底；`routing_decisions.policy='tier2_audit'` + 降级明示文案；探测失败自动 Tier3，不允许静默换 adapter。

### 4.5 Yjs / RequestQueue 处置评估（v1.2.1 事实基线更新）

- **⚠️ 勘误（R9-1/3/4）**：v1.2 的"缓解已上""1809 行""专测 86 个"均错；且 `cc749ce` 已将 Yjs 改为**单向只读**（代码已落地：attachDiffHandlers 移除、doc 变更只落快照、WS step2/update 1008 拒绝）。
- **更新后的事实基线**：写回危险已消除；读路径上启动仍 eager 建每图 Y.Doc（内存）、快照恢复路径保留（但 doc 无生产写入者，永不更新=永久陈旧且无消费）。awareness 独立保留。
- **L3 拆除评估论点（R10 数字勘误后）**：拆除论点=依赖体积（yjs/lib0/y-protocols 约 11.6MB）、每图 eager Y.Doc 内存、**专测 8 文件 112 个 it 声明（realtime，A5 口径）**、**非测试源码 `realtime/snapshot/` 5 文件 1208 行（A3 实测，`git ls-files 'src/main/realtime/snapshot/**' | grep -v __tests__ | xargs wc -l`）**、影子系统心智负担；保留论点=未来协作重启省一次选型。**写回安全已不再是拆除的必要理由**（对方已消除）——决策纯属性能/维护权衡，且对方 §2.2.1 已落定"单向只读处置"并将拆除九类清单列入 L3（5836262）。
- **runbook（若 L3 批准，v1.2.1 修正版）**：
  1. S0 备份；确认 readonly-sync 行为回归通过。
  2. 删接线（`ipc-handlers.ts:343-355`、`index.ts:219-226`）与 `realtime/snapshot/`、`yjs-doc.ts`/`yjs-manager.ts`/旧 `ws-server.ts`；保留 awareness 全套。
  3. **删除 `yjs_snapshots` 前：BLOB 数据导出备份**（表内是历史图快照数据，虽无消费仍是数据）——或首版 `RENAME TO yjs_snapshots_retired` 保留一个版本周期后再 DROP。
  4. **迁移完整性（R9-10 补）**：`CURRENT_SCHEMA_VERSION` 递增 + `schema-checksum.json` 再生——漏掉任一项会启动即失败（checksum 不匹配触发旧二进制重建判定）。
  5. 删依赖 yjs/y-protocols；删 `src/main/realtime` 8 个测试文件（**112 个 it 声明**，A5 口径；awareness 专测实际位于 `src/main/__tests__/realtime/awareness-server.test.ts`，**14 个 it**，2026-11-07 实测——v1.2.1 的"保留 awareness 17"同样无独立口径，一并勘误，最终保留数以拆除时实测为准）；文档联动（对方 §2.2.1/§8 表述同步）。
  6. **回退语义（R9-10 修正）**："单提交 revert"**只对代码成立**——DROP 后的行不可恢复，数据恢复仅走第 3 步的备份/RENAME；RENAME 方案下回退最干净。
- **RequestQueue**：零引用死代码，随 L3 清理批删除（无数据语义，直接删）。

---

## 5. 约束与非目标（v1.2.1）

| 项 | 口径 |
|---|---|
| 团队协作 | 冻结；单机单人；awareness 保留 |
| 节点状态 | 双轨：nodes.status 只人写；auto-developing 双违规 L1 移除 |
| 证据上限 | LLM 判定到不了 E3/E4；**U1 已裁决：过期 E4→stale（不降 implemented）** |
| 发布进度 | 仅内部（R7）；E3/E4 分开计数 |
| dev→online | 不自动回写；提案 UI 留 L3（R7） |
| 编排后端 | MVP 仅 Tier 1（5db986e 确认）；Tier2 升格前置=解决写路径与审批网关冲突 |
| 工作区 | 测试=worktree 隔离；agent 编排=共享工作区+写闸；回滚=新 work_item |
| Agent 交互 | 永不做直连/群聊；dispatch_subagent 仅手动 |
| 图合并 | 不自动双向合并；跨图一律 node_links |
| 框架 / 自修改 | 不引入 LangGraph；进化只产建议过评审 |
| 伪节点 | **已取消（D8 裁决采纳本侧建议）**：未挂载会话保持纯 thread；`node_id` 放宽列为长期待办 |
| 建表纪律 | 不提前建空表；memory_hits/聚合快照随层动工建 |
| 状态词纪律 | 本文所有实施状态严格三态：已实施 / 已批准未实施 / 仅建议（R9 起强制） |

---

## 6. 决策记录

**R1-R7**：见 v1.2 版本（R1-R4 四轮追问收敛 Q1-Q16；R5 本侧交叉验证；R6 Trae 回审 a60355a 与用户四拍板；R7 F1-F3/Q-A/Q-B/WS 缓解/文档分工批准）。

**R8**：细则补充（v1.2）。

**R9（2026-11-07，勘误）**：Trae 对 v1.2 的审计发现 8 处事实错误 + 1 处逻辑错误 + 5 处不可执行，**经本侧逐条代码核验全部属实**：

| # | v1.2 错误 | 核验证据 | 修正 |
|---|---|---|---|
| 1 | WS 缓解"已上" | `BIZGRAPH_YJS_WS` 全库不存在；`disableWebSocket ?? false` 默认启动（`yjs-realtime.ts:70,107`）；`new YjsRealtime(db)` 无 options（`ipc-handlers.ts:348`） | §3.1 改"从未实施"；且被 `cc749ce` 单向只读取代，缓解项关闭 |
| 2 | "1MB 与现有一致" | `BaseAdapter.MAX_OUTPUT_ENTRY_SIZE=10_000`（`base.ts:90`）；1MB 属 recipe-runner（`:189,196`） | F2 改两层限制：单条 10KB 既有 + partial 总量 64KB 新设 |
| 3 | "通读 1809 行"作为现况 | 当前 3441 行（@ `f411837`，2026-11-07 实测） | R5 加快照标注；§7 增复审项 |
| 4 | Yjs 专测 86 个 | `src/main/realtime` 实测 130 个 it/test（**R10 再勘误：130 亦无口径**，正确口径见 R10-A5） | 全文改 130（→R10 改 112/119 并附命令） |
| 5 | F3 cancelTurn→finalize(failed) 逻辑不成立 | `cancelTurn` 内部终态 CAS 写 `cancelled`/aborted（`runtime.ts:766-771`），二次 CAS 返回 false | 采用 F3-A（与对方 5db986e 一致）：专用超时路径单次 CAS failed+failure_type='timeout' |
| 6 | 超时"事件流监控点"未定义 | — | 补 DeadlineReaper 规格（归属/周期/去重/CAS） |
| 7 | 预算 10/25/35/5/25 无总口径 | — | 补 4000-16000 基线 + estimateTokens 口径 |
| 8 | "数据源全部现成" | `agent_logs` 无 work_item_id；`subagent_invocations` 无任务连接 | 补 node_session_links 关联路径 + 编排会话强制登记为 L2 硬约束 |
| 9 | embedding 阈值/glob 无算法；drop 迁移缺版本与 checksum；revert 语义错误 | schema-checksum 机制（对方 §8.2） | 补 task_embedding 数据模型、LCP+cap glob 算法、版本递增+checksum+数据备份、revert 语义修正 |

**根因与教训**：①把"已批准"写成"已实施"（状态三态纪律，本表起强制）；②数字与计数未 grep 复核；③引用文档未标注快照版本，对方持续演进而本侧未跟进（a60355a 后 5 提交 +1220 行未纳入 R5/R6 结论）。

**R10（2026-11-07，勘误闭环）**：对方送达 §12.13 全清单（8 事实错误 A 表 + 4 行号偏移 B 表 + 4 不采纳/不可执行 C 表），本侧按同口径命令逐条复核。**全部属实，无一条提出异议**：

| # | 判定 | 本侧处置 |
|---|---|---|
| A1 WS 缓解"已上" | 属实 | **R9-1 已修正**（§3.1 缓解项关闭，被 `cc749ce` 单向只读取代） |
| A2 "1MB 与现有一致" | 属实 | **R9-2 已修正**（10KB 既有 + 64KB 新设，已实施） |
| A3 `realtime/snapshot/` 1070 行 | **属实（新增修正）** | 实测 1208 行（93+209+263+414+229，5 文件）——§4.5 拆除论点已改精确口径 |
| A4 "通读 1809 行"过期 | 属实 | **R9-3 已修正**（快照标注 + 复审项）；现文本 3441 行已更新 |
| A5 专测 86 个 | 属实，**且本侧 R9-4 的"130"亦无口径** | 再勘误：声明口径 112（realtime 8 文件）/119（含 conflict-reporter 7）/子串口径 116；awareness 专测实为 `__tests__/realtime/awareness-server.test.ts` 14 个 it（"保留 17"一并勘误）。全文改并附命令 |
| A6 needs_input 未入值域 | 属实（v1.2 时点） | **v1.2.1 已修正**（§8：已入 13 值状态机） |
| A7 tasks/task_steps→work_items/work_runs 误映射 | 属实（v1.2 时点） | **v1.2.1 已修正**（§8：work_steps 独立表，D2） |
| A8 L1 只 4 表、change_sets 在 L2 | 属实（v1.2 时点） | **v1.2.1 已修正**（§3.2：L1 13 张含 work_steps/change_sets，5b26715 裁决） |
| B1-B4 行号偏移 | 属实 | 3209→**3441**（@ `f411837`）全文更新；1809/2051 保留为**历史时点标注**不混用；章节引用以标题定位 |
| C1 cancelTurn 逻辑缺陷 | 属实 | **已采 F3-A 并实施**（`260df58`；列名实况 `failure_class` 已双向记录） |
| C2 数据源"全部现成" | 属实 | **R9-8 已修正**（node_session_links 关联路径 + L2 硬约束） |
| C3 "E4 由 E3 替代" | 属实（v1.2 时点） | **v1.2.1 已修正**——现行 §8 review gate 映射为"LLM→E2 / 人工→E4 / 真实测试+hash→E3"，无替代语义；E3/E4 按可复现性分组（§3.5） |
| C4 "单提交 revert" | 属实 | **R9-10 已修正**（§4.5 runbook 第 6 步：revert 只回代码,数据走备份/RENAME） |

**R10 教训（追加）**：勘误自身的数字也要复核——R9-4 在驳斥"86"时给出的"130"同样未经口径固定的 grep 复核；此后一切计数必须**附命令与时点**（`grep -rEc "\bit\(" …` @ commit），否则视为未复核。

---

## 7. 交审说明（供 Trae 复核，v1.2.1 更新）

原六项复核项的裁决状态：③黑板/Phase B 约束（已记录，5836262）、④归因维度（已统一 derivation_version+observed_rule_version）、⑤Yjs 拆除联动（已列九类清单）、⑥work_items.status 13 值/needs_input（已落定）——**四项已被对方裁决关闭**。当前真实待办：

1. **同步信息差**：对方待拍板清单第 1 条（F1-F3 源码修复授权）已被本侧 R7 覆盖（F1/F2/F3 逐项批准，F3 按 F3-A）；第 2/3 条（进度仅内部、提案 UI 留 L3）已被 R7 拍板。请对方将 R7 三项同步进其文档，清除待定标记。
2. **真待拍板**：D1 计划确认强度、D4 流程节点折叠（对方保持现状）；~~F3 超时默认值放配置键还是常量~~ **已裁决（2026-11-07）：配置键 `agent.timeouts.turnMs`**（单一来源，L2 编排层消费）；审批期 deadline 处置**已裁决：候选 A（冻结重算，代码随 L2）**。F1-F3 实施状态同步：四提交在分支 `worktree-blueprint-f1-f3`（未合 main，待 review），含对方 §8.15 契约补齐（P-F1/P-F2/F2 契约 1/5/8）。
3. **复审请求**：R5/R6 引用的章节号与结论基于 1809/2051 行时点快照，请对方确认在 3441 行现文本（@ `f411837`）下是否仍然成立（尤其 §12.2/12.3 引用）。
4. ~~**勘误补全**~~：**已闭环（R10）**——对方 §12.13 送达全清单（8A+4B+4C），本侧逐条复核全部属实并已修正/标注（见 §6 R10），无异议项。
5. **本文独有部分**（§4.1 五通道/模式库、§4.2 进化、§4.3 提案补充）按对方覆盖审计口径判定等级后，缺细节处按 §4 细则补齐或回改本文。

---

## 8. 术语与概念对照（v1.2.1 修订）

| 本方 v1.0 用语 | session-map 术语 | 状态 |
|---|---|---|
| tasks / task_steps | work_items / work_runs / **work_steps**（D2：步专属字段独立建表） | 已统一 |
| ExecutionRecord（新表） | 节点活动流派生视图（§4.6） | 已统一 |
| TaskDAG（planner 产出） | plan_drafts.items_json + depends_on_json（候选制） | 已统一 |
| 节点状态自动推进 | 双轨派生态 | 已统一（驳回） |
| published/review 门 | 人写状态 + E0-E4 + published 软阻断（已落定） | 已统一 |
| review gate | LLM→E2 / 人工→E4 / 真实测试+hash→E3（§6.7） | 已统一 |
| 错误策略表 / failure_class | §5.9.2（+R9 后 failure_type='timeout'，F3-A） | 已统一 |
| WorkspaceWriteGate / Tier 票 / 命令网关 | §5.9.3 / §5.9.5 / §6.8 | 已统一 |
| 发布进度视图 | §3.6（仅内部，R7） | 已统一 |
| needs_input | **已入 13 值状态机（§5.9.8，INPUT_REQUIRED 契约）** | 已统一 |
| 伪节点 thread:id | **已取消（D8 采纳）** | 已统一 |
| mediated blackboard 五通道/模式库 | 本文 §4.1（L3） | 本文独有 |
| 进化三层 / 语义归属建议 | 本文 §4.2（L3） | 本文独有 |
| F1/F2/F3、D1-D8、R5-R10 | 本文内部编号 | 仅本文 |
