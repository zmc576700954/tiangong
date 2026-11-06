# Agent 体系全局一致性审查（2026-11-05）

- 审查对象：`docs/architecture/agent-architecture.md`（权威）、`agent-rollout.md`、`agent-decisions.md`、`agent-m0-report.md`、`agent-m0-verification.md`、`agent-realdevice-verification.md`
- 对照实现：`src/main/agent/runtime/**`、`src/main/agent/agent-manager.ts`、`src/main/adapters/claude-code.ts`、`src/main/adapters/base.ts`、`src/main/database.ts`、`src/renderer/components/agent/**`、`src/main/ipc/agent.ts`
- 方法：只读。把文档里的“已实现 / 已验证 / 已保证”逐条回落到代码或实测报告；本轮未运行测试与构建（见 §4）。
- 明确排除（按要求不重复报）：排队未做、额度熔断不做、长尾 CLI 无真实环境、Codex/OpenCode 无写前审批、better-sqlite3 ABI、真实 Electron 旧库升级、M1 文档收口。

> **先纠正两个过时候选**（本轮已核实，不再算问题）：
> 1. “Kernel 路径 UI 不可达”已不成立——`AgentManager.sendCommand` 现在对 claude 默认路由到 `runtime.runNode`（[agent-manager.ts L994-L1006](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L994-L1006)），第九轮真机已用普通 UI 回归通过。
> 2. “默认构建审批被 `acceptEdits` 绕过”已不成立——安装审批钩子时 `permissionMode='default'`（[claude-code.ts L286-L288](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L286-L288)），第九轮真机写类首写必弹窗。

---

## 1. 最该先补的三处

**① 回收与恢复：一处结论已经被真机反向，一处机制根本没实现。**
- 文档 §6.5 仍写“SDK 只 `spawn(..., {signal})`，不暴露 PID、不杀进程组”“SDK 无句柄路径（Claude/Codex）只标 `unconfirmed`”（L732、L758），§6.5 验收表也据此写“Claude/Codex 不承诺 0 残留”（L775）。但 Claude 现在由宿主受控 `spawn(..., { detached: true })`，`pid/pgid` 当场可知并落库（[claude-code.ts L278-L283、L506-L523](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L278-L283)）；真机报告 §3.3/§4.1 明确“多数真实取消 `residual_risk=none`、`recovery_kills=1`，`unconfirmed` 只出现在未登记句柄路径”。这是**承诺方向反了**，会让后来者按旧结论实现错误的监督逻辑。
- 文档 §9 L882-L884 承诺“每 N 个事件写 `agent_snapshots`、恢复取最后快照并 replay 其后事件”。代码里 `saveSnapshot` 只有仓储方法与单测调用，[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts) 没有任何写快照调用；恢复实际是“最后持久化事件 + `stepOutcomes` 对账”。同理 §8.3 L875 的“50ms/批，flush 时分配 seq”也不存在：`sink.ts` 没有批处理，seq 在 [runtime.ts L210-L234](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L210-L234) 逐事件同步分配。

**② 审批覆盖：会话级授权没进文档，且文档写的范围与代码相反；两处细节与实现冲突。**
- 代码已有“会话级授权”：同一会话内第二次写类工具自动放行并留痕（`grant_source`），只覆盖 Write/Edit/MultiEdit，**Bash 不覆盖**，内存保存、会话结束失效、重启不继承（真机报告 §10.3 L327-L337、§14.5）。但权威文档 §7 完全没有这一节；L808 还写 “`allow_session` 只在本 run 内复用”，与“会话级跨 turn 复用”正好相反。读者会以为每次写都弹窗，或以为授权覆盖 Bash。
- §7.3 L815 写 `PreToolUse` “只做硬 deny”“不要与人审同时装”，而实现是把 `PreToolUse` 的写类 `ask` 与 `canUseTool` 同时安装（§17.1 L1064 也这么写），两处自相矛盾。
- §7.4 L822 与 §13 L983 都写“超时默认 60s”，代码是交互 120s / 无人值守 30s（[gateway.ts L30-L31](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L30-L31)），真机 `timeout_ms=120000`。这是用户可见行为（1 分钟自动拒绝 vs 2 分钟）。

**③ 权威 schema 与成本口径：版本号停留 17→18，approvals DDL 少 5 个已上线列；产品决定“不熔断”的代码残留已清除。**
- 文档 L309 / L933 / L951 三处仍写 `CURRENT_SCHEMA_VERSION = 17`、迁移 `17→18`；实际 [database.ts L361-L366](file:///Users/zhumingchen/tiangong/src/main/database.ts#L361-L366) 是 **v23**（v21 成本账本、v22 `step_id`、v23 `cost_status/tokens_reported`），同一文档 L961 又写“v23 已交付”，M0 报告 L12 写 v20。三个版本号并存。
- 文档 §4.2 的 `agent_approvals` DDL 少了 `mode` / `timeout_ms` / `cwd` / `grant_source` / `decision_note`，`decided_by` 的 CHECK 也少了 `'startup'`（[schema.ts L176-L184](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L176-L184)）。这张表正是审批审计的核心表。
- §4.4.1 L477 已把“M1 只记账、不拒单”写成产品决定；原 `CostLimitExceededError` 预检（含 `ipc-handlers.ts` 的 limits 透传）已于 2026-11-05 删除，当前不存在任何成本准入拦截。

---

## 2. 分级清单

严重度口径：**P0** = 会让按文档实现的人做错表/迁移，或让用户对安全能力产生错误预期；**P1** = 重要事实失真或用户可见行为描述错误；**P2** = 局部机制/路径/编号漂移；**P3** = 文案与可读性问题。

### 2.1 偏差（文档说已实现/已保证，代码或实测不支持）

| ID | 严重度 | 文档位置 | 代码 / 实测证据 | 结论与建议 |
|---|---|---|---|---|
| A1 | **P1** | §4.1 L309、§11 L933、§12 L951 | [database.ts L361-L366](file:///Users/zhumingchen/tiangong/src/main/database.ts#L361-L366) `CURRENT_SCHEMA_VERSION = 23`；M0 报告 L12 写 v20 | 版本号落后 5 个版本，且文档内部 L961 已写 v23。**改文档**：统一写“当前 v23”，逐版列出 v20 归属证据链 / v21 成本账本 / v22 `step_id` / v23 可查分类，并保留“D1 当时中间版本 20”的历史说明。 |
| A2 | **P1** | §4.2 L383-L392（approvals DDL） | [schema.ts L176-L184](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L176-L184) | DDL 缺 `mode/timeout_ms/cwd/grant_source/decision_note`，`decided_by` 缺 `'startup'`。**改文档**：DDL 与 `schema.ts` 对齐；或删掉 §4.2 重复 DDL，只保留“以 `schema.ts` 为准”。 |
| A3 | **P1** | §9 L882-L884 | `saveSnapshot` 仅在 [repository.ts L1131](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L1131) 与单测；runtime 无调用 | “快照恢复”未实现。**改文档**（首选）：改为“M0 恢复 = 最后持久化事件 + `stepOutcomes` 对账；快照写入未实现”。若坚持写，就必须改代码补齐，并补崩溃丢尾用例。 |
| A4 | **P1** | §8.3 L875；§4.4 L531 | `sink.ts` 无 batch/flush；[runtime.ts L210-L234](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L210-L234) 同步分配 seq | “50ms 批写 + flush 时分配 seq”未实现，且与 L531“写事务内分配”直接冲突。**改文档**：删掉批处理段，或明确“Phase 2 设计，未实现”。 |
| A5 | **P1** | §6.5 L732、L758、L775 | [claude-code.ts L278-L283、L506-L523](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L278-L283)；真机报告 §3.3 L138-L142、§4.1 L149-L193 | “Claude/Codex 无 PID → 必 unconfirmed”已被实测推翻。**改文档**：Claude 受控 spawn 有真实句柄，取消多数 `none`；Codex 走 shim 自注册；只有 spawn 前取消 / 登记缺失才 `unconfirmed`。验收表同步改成“Claude 同进程可回收，跨重启按证据”。 |
| A6 | **P1** | §7.4 L822；§13 L983 | [gateway.ts L30-L31](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L30-L31) 120s/30s；真机 `timeout_ms=120000` | 文档两处写 60s。**改文档**：统一为交互 120s / 无人值守 30s，并写明按 `mode` 取值。 |
| A7 | **P1** | §7 L808 | 真机报告 §10.3 L327-L337；网关内存 `Map<sessionId, SessionGrantInfo>` | 文档说 `allow_session` 只在“本 run”内复用；实现是**会话级跨 turn 复用**（只写类、Bash 不覆盖、不落库）。**改文档**：改口径并新增 §7.6。 |
| A8 | **P2** | §7.3 L815 | [claude-code.ts L286-L344](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L286-L344)；§17.1 L1064 | 文档写 `PreToolUse`“只做硬 deny、不要与人审同时装”，实现是写类强制 `ask` + `canUseTool` 同装。**改文档**：删旧行，指向 §17.1。 |
| A9 | **P2** | §10 L896（Codex 行） | [feature-flags.ts L21](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/feature-flags.ts#L21) 白名单仅 claude；无 shim 时 SDK 不暴露 PID | “进程组回收由宿主兜底”默认不成立。**改文档**：加条件“仅 Kernel + shim 监督路径；旧路径不承诺”。 |
| A10 | **P2** | §2 L65-L71 | 实际目录是 `src/main/agent/runtime/{db,normalize,locks,approval,cost,evidence}`；`src/main/repositories/agent-*.ts` 不存在 | 分层图给的落地路径与仓库结构不符，按图找文件会找不到。**改文档**：路径改为实际目录。 |
| A11 | **P1** | §4.4.1 L477 | [runtime.ts L822-L831](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L822-L831)；[ipc-handlers.ts L294](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L294) | **已修复（2026-11-05）**：删除 `limits` / `assertCostAdmission` / `CostLimitExceededError` 与 settings 字段，旧配置被忽略；守护测试 `never rejects a turn for cost, even when a legacy limits config is injected`。 |
| A12 | **P3** | §4.4 出现两次（L451 成本账本、L524 锁序） | — | 编号重复，交叉引用会歧义。**改文档**：锁序改为 §4.5，后续顺延。 |
| A13 | **P3** | §0 L22 | §4.2 同文档已定义 `agent_sessions` | 把“DB 无 `agent_sessions`”写成现状，是 M0 前判断。**改文档**：标注“M0 前现状”。 |

### 2.2 缺失（已落地但没进权威文档）

| ID | 严重度 | 应写入位置 | 实现 / 证据 | 结论与建议 |
|---|---|---|---|---|
| M1 | **P1** | §7 新增 §7.6“会话级授权” | 真机报告 §10.3 L327-L337；网关 `grant_source`、`toolScope='write'` | 会话级授权的四个边界（只写类、Bash 不覆盖、内存不落库、`realpath` 归一、会话结束/重启失效、可撤销）只存在于真机报告。**改文档**（与 A7 一并修）。 |
| M2 | **P2** | §10 之后或 §12 M1 | [base.ts L253-L297](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L253-L297)、`runtime/evidence/workspace-snapshot.ts` | 长尾合成证据只有 §12 L969 一句“保留 `file_change_evidence` 合成通道”。应写清边界：文件级、无工具名、`postHoc`、`source=synthetic`、扫描截断如实标注、Claude/Codex 不走该路径、precision/recall 未实测。 |
| M3 | **P3** | §12 M1 L959-L961 | 代码注释使用“M1 ①/②” | 文档只有一段“已交付”，没有 ①②③ 编号；读者无法把代码里的 `M1 ②` 映射回文档。建议补编号与逐项状态。 |

> 说明：用量面板四类呈现、`cost_status/tokens_reported`、`step_id` 审计列、Bash 两档策略**已经**写进权威文档（§4.4.2、§4.2、§4.6），本轮不列为缺失；其中 approvals DDL 的缺列见 A2。

### 2.3 残留矛盾（同一概念在不同处说法冲突）

| ID | 严重度 | 冲突位置 | 事实 | 建议 |
|---|---|---|---|---|
| C1 | **P1** | §4.1 L309 / §11 L933 / §12 L951 “17→18” ↔ §4.4.3 L507-L512、L961 “v23” ↔ 代码 v23 | 三个版本号同处一份权威文档 | 与 A1 合并修：统一 v23，保留历史说明。 |
| C2 | **P1** | §4.4 L531 “seq 在写事务内分配” ↔ §8.3 L875 “flush 时分配 seq” | 代码没有批处理，只有同步分配 | 删 §8.3 批处理段，或标 Phase 2。 |
| C3 | **P1** | §7.4 L822、§13 L983 “60s” ↔ 决策文档 L16/L104 与代码 120/30 | 文档内部一致但对外错误 | 与 A6 合并修。 |
| C4 | **P1** | §7 L808 “仅本 run 复用” ↔ 真机 §10.3 “会话级跨 turn 复用” | 代码为会话级 | 与 A7/M1 合并修。 |
| C5 | **P2** | §7.3 L815 ↔ §17.1 L1064 | 同一机制两种描述 | 与 A8 合并修。 |
| C6 | **P2** | §17.4 L1105 “Bash 分级仍来自 SDK/CLI” ↔ §4.6 L551 “宿主 `bash-readonly.ts` 两档” | 内核路径由宿主规则决定（真机 7/7），旧路径才沿用 SDK | 改 §17.4：限定“旧路径”；内核路径写宿主规则。 |
| C7 | **P3** | §0 L22 ↔ §4.2 | 历史判断与当前设计并存 | 标注时间点。 |
| C8 | **P3** | §4.4 编号重复 L451/L524 | — | 与 A12 合并。 |

### 2.4 风险等级口径

结论：**R0/R1 体系仍在用，但“一级风险”的覆盖面已经落后于当前实际风险。**

- §14 L994 的 R0 仍准确（进程回收误杀/漏杀/伪造），三层承诺与代码一致，不需要降级。
- R1（“Claude `canUseTool` 与文档不符”）已基本失效：写类工具现在用 `PreToolUse` 强制 `ask`，第九轮真机证明 `ask` 不被 `permissions.allow` 短路。建议降为 R2，或改写为“`PreToolUse` 行为随 CLI 版本变化”。
- 建议补进风险表的用户可见项：
  1. **Legacy 路径（codex/opencode/长尾）没有写前审批**——§17 开头已如实说明，但 §14 风险表没收录，用户可能误以为“所有后端都受保护”。
  2. **会话级授权只覆盖写类，Bash/非写工具不覆盖**——只写在真机报告 §14，未进权威 §14。
  3. **长尾合成证据误报/漏报**——有 `scanTruncated` 标注，但无 precision/recall 实测。
  4. **残留成本熔断分支**（A11）——**已于 2026-11-05 移除**；当前不存在任何成本准入拦截。

---

## 3. 未验证项台账

> 已迁入可跟踪文件 [verification-ledger.md](file:///Users/zhumingchen/tiangong/docs/architecture/verification-ledger.md)，该表为当时的原始记录。

| # | 条目 | 现状 | 影响面 | 跟踪方式 |
|---|---|---|---|---|
| U1 | Codex **官方 provider** 下 `item.updated` / `reasoning` 是否出现 | 第三方 provider 实测 0，不能外推 | 内部（UI 粒度）/ 用户可见（时间线丰富度） | 换官方 key 录一次真实会话 |
| U2 | OpenCode 是否有结构化工具事件/权限协议 | 未验证 | **用户可见**（工具时间线与审批） | 真实 CLI 跑一次 |
| U3 | `better-sqlite3` 高事件量下主进程阻塞 | 未验证（且 50ms 批写未实现） | 用户可见（UI 卡顿） | 10k 事件回放 |
| U4 | 打包产物里 SDK/CLI 二进制可用性 | 未验证 | **用户可见 / 发布阻塞** | `electron-builder` 产物 smoke |
| U5 | Claude 开 `includePartialMessages` 的 token 增量稳定性 | 未验证 | 用户可见（打字机效果） | 可选实验 |
| U6 | Windows / Linux 进程组回收与孤儿行为 | 仅 macOS 实测；Windows Job Object 未实现 | **用户可见**（跨平台残留进程） | 目标平台跑取消用例 |
| U7 | 跨重启“可证明归属”证据能否稳定取到 | `ps lstart` + 完整命令行；`startedAtHiRes` 未持久化 | 用户可见（漏杀/残留） | 构造残留进程，断言 kill=0 或命中 |
| U8 | 真实第二 uid 的跨用户攻击 | 只断言 0600/0700 权限位与同 uid 行为 | 内部（安全） | 建测试用户跑一次 |
| U9 | 真实 Codex 长任务中途崩溃/取消后的孤儿回收 | 未验证（仅单元/夹具） | **用户可见**（命令继续跑） | 真实 codex 长任务 + kill -9 |
| U10 | 会话级授权“重启不继承” | 真机 §14.5 标“未验证（受阻）”：同会话 UI 发送失败，无法观察重新弹窗 | **用户可见**（以为授权还在） | 修 P1 后重跑 |
| U11 | 长尾合成证据 precision / recall ≥95% | 只有单测，无真实会话 ground truth | **用户可见**（diff 误报/漏报） | 每适配器 3 次真实会话对比 `git status` |
| U12 | 用户 `~/.claude/settings.json` 的 allow 规则对非写类工具的影响 | 写类已由强制 `ask` 封堵；非写工具未逐项验证 | 用户可见（审批覆盖范围） | 构造 allow 规则 + 非写工具 |
| U13 | 双路径 supervision（runtime / legacy）并发压测 | 未压测 | 内部（切换稳定性） | 20 turn 两路径混跑 |
| U14 | C13b 同名 symlink 抢占是否已修 | 文档 L756 写“修复中” | 内部（同 uid 残余面） | 看提交或补测 |
| U15 | 组长先死、组员仍存活 | 明确不承诺（只记 `missing`） | 用户可见（残留进程） | 保持“不承诺”文案即可 |
| U16 | 用量账本与供应商账单对账 | 未做 | 内部（成本准确性） | 按周比对 `sum(cost_micros)` |

> 不重复列入：排队（Phase 2）、额度熔断（产品决定不做）、长尾 CLI 真实环境缺失（已知）、Codex/OpenCode 写前审批（已知能力缺口）、better-sqlite3 ABI（环境问题）、旧库升级（进行中）、M1 文档收口（进行中）。

---

## 4. 这次我没能确认的部分

1. **没有运行任何测试/构建**（`tsc`、`vitest`、`eslint` 均未执行）。本报告的事实判断来自源码阅读与既有报告，不包含本轮新增的运行时证据。
2. **未逐条核对 `agent-decisions.md` 的决策是否仍然有效**。该文档写于 M0 之前（L7 明确“DB 仍是 v17、M0 未开工”），其中 D-A/D-B 的推荐值已被实现采纳，但“决策文档是否仍是权威”没有定义；本次只把它当作证据源。
3. **M1 ①②③ 的编号定义在权威文档里没有逐条列出**（只有 §12 L959-L961 一段“已交付”）。我按代码注释把 ② 对应为长尾合成证据、① 对应为成本账本/用量视图，但 ③ 的具体编号未能从文档确认。
4. **长尾合成证据与用量面板是否经过真实 Electron 验收**：用量面板有 §4.4.3 的迁移/截图证据；长尾合成证据我只看到单测与代码，没看到真实 Electron 证据。
5. **C13b（symlink 抢占）当前是否已修**未能确认：权威文档写“修复中”，代码侧只看到防御性检查，未看到对应测试结果或提交。
6. **`settings.json` allow 规则对非写类工具的实际影响**未实测；第九轮只证明了写类 `ask` 不被短路，不能推出所有工具都安全。
7. **旧库升级（正在做）与本报告的关系**：`database.ts` 的 v20→v23 迁移顺序我按注释与 schema 定义核对过，但没有在真实旧库副本上跑迁移，因此“迁移可执行”本身仍由旧库任务给出结论。

---

## 5. 已核对且一致（避免误报）

| 项 | 文档 | 代码 / 证据 |
|---|---|---|
| Kernel 默认矩阵 | §17.1-17.3 L1060-L1099 | [feature-flags.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/feature-flags.ts)：默认 on，白名单 `claude`，`UNSAFE` 降级，两条回退 |
| Bash 两档策略 | §4.6 L549-L578 | [bash-readonly.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/bash-readonly.ts)；内核路径由宿主规则决定（真机 7/7） |
| 审批 fail-closed | §7.2/§7.4 L800-L826 | [gateway.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts)：`argsHash`、幂等、超时 deny、重推 |
| 并发 fail-fast | §6（`SESSION_BUSY` / `NODE_BUSY`） | [runtime.ts L176-L180](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L176-L180)、[session-lock.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/locks/session-lock.ts) |
| 成本幂等升级 | §4.4 L469 | [ledger.ts L58-L88、L164-L191](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/cost/ledger.ts#L58-L88) |
| 用量四类呈现 | §4.4.2 L496-L505 | [UsagePanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/UsagePanel.tsx)、[usageFormat.ts](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/usageFormat.ts) |
| 三层进程回收 | §6.5 L734-L778 | [reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts)；M0 报告 §11 |
| `step_id` / `cost_status` / `tokens_reported` | §4.2 L384、L416-L417；§4.4.3 L509-L512 | [schema.ts L155-L160、L239-L249](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L155)；迁移证据 |

---

## 6. 文档修订记录（2026-11-05，按本报告结论）

| 报告条目 | 修改文件 | 章节 | 原文 → 新文（关键差异） |
|---|---|---|---|
| A1/C1 | `agent-architecture.md` | §4.1、§11、§12 D1 | `CURRENT_SCHEMA_VERSION = 17` / 迁移 `17→18` → **当前 v23**，并写明“M0 起点 v17 → D1 v20 → M1 v23”；代码引用行号更正为 `database.ts L366` |
| A1 | `agent-rollout.md` | M0 交付表 D1、第一个 PR 第 2 条 | `17→18` → `17→20（M1 再到 v23）` |
| A2 | `agent-architecture.md` | §4.2 `agent_approvals` DDL | 补 `mode` / `timeout_ms` / `cwd` / `grant_source` / `decision_note`，`decided_by` 补 `'startup'` |
| A3 | `agent-architecture.md` | §9 | “每 N 个事件写快照 + 从快照恢复” → **恢复只依赖事件回放 + `stepOutcomes`；`agent_snapshots` 无生产写入路径，列为 M2** |
| A4/C2 | `agent-architecture.md` | §8.3 | “50ms 批写、flush 时分配 seq” → **当前逐条写入、同步分配；批写未实现（M2）** |
| A5/C6 | `agent-architecture.md` | §6.5 开头、第 a 项、已知未修复面 3、验收表 | “SDK 不暴露 PID、Claude/Codex 无句柄” → **Claude 受控 spawn 有真实句柄；Codex SDK 无句柄、Kernel 依赖 shim；只有未登记句柄才 `unconfirmed`** |
| A6/C3 | `agent-architecture.md` | §7.4、§13 | “默认 60s” → **交互 120s / 无人值守 30s，按 `mode` 取值** |
| A7/C4 + M1 | `agent-architecture.md` | §7 第 3 条；新增 §7.6 | “`allow_session` 只在本 run 内复用” → **会话级授权**：只写类、Bash 不覆盖、每会话一次、`grant_source`/`cwd` 留痕、`realpath` 归一、重启不继承、可撤销、内存不落库 |
| A8/C5 | `agent-architecture.md` | §7.3 能力矩阵 | “`PreToolUse` 只做硬 deny、勿与人审同装” → **写类强制 `ask` → `canUseTool` → 网关同装；旧路径 `acceptEdits` 单列** |
| A9 | `agent-architecture.md` | §10 codex 行 | “进程组回收由宿主兜底” → **旧路径不承诺回收，Kernel + shim 才按登记句柄回收** |
| A10 | `agent-architecture.md` | §2 分层表、§11 新增文件列表 | 不存在的 `src/main/agent/{policy,normalize,lock}`、`src/main/repositories/agent-*` → **实际 `src/main/agent/runtime/{approval,normalize,locks,db,…}`** |
| A12/C8 | `agent-architecture.md` | §4.4 锁序小节 | 重号 `### 4.4` → **`### 4.4.4`** |
| A13/C7 | `agent-architecture.md` | §0 第 3 条 | “DB 无 `agent_sessions`” → 标注 **M0 前现状**，并说明 M0 已新增 |
| C6 | `agent-architecture.md`、`agent-rollout.md` | §17.4 已知风险、rollout 已知风险 | “Bash 分级仍来自 SDK/CLI” → **Kernel 路径由宿主 `bash-readonly.ts` 两档；旧路径才沿用 SDK/CLI** |
| 风险口径 | `agent-architecture.md` | §14 | R1 改写为“已加 `PreToolUse` 强制 ask（r9 验证），版本变化才降级”；R3 去掉“50ms 批量”；新增 R9（未具备写前审批的后端）、R10（会话级授权边界）、R11（合成证据误报/漏报）、R12（账本错记/缺价） |
| §3 台账 | 新建 `verification-ledger.md`；§16 加引用 | — | 16 项未验证项独立成表，标注 7 项用户可见；§16 声明冲突时以台账“未验证”为准 |
| A11 | **未改动**（按指示避开） | §4.4.1 | 另一会话已删除 `CostLimitExceededError` 预检并同步该句；本次未触碰该段 |

---

## 7. 必须改代码清单（文档已对齐，代码侧仍需处理）

| # | 事项 | 原因 | 建议动作 | 状态 |
|---|---|---|---|---|
| F1 | 成本准入残留在报告写作时仍存在 | 与产品“只记账不熔断”冲突 | 删除 `CostLimitExceededError` 预检与 `limits` 透传 | **已由另一会话完成**（本次按要求未改） |
| F2 | 会话恢复 P1：重启后同会话 UI 发送失败，导致“会话级授权重启不继承”无法验证（U10） | 用户可见：无法续聊，也无法确认授权已失效 | 修 `agent-manager` 重启恢复路径，再重跑真机 §14.5 | 待修 |
| F3 | C13b 同名 symlink 抢占防御 | 同 uid 残余攻击面；文档仍写“修复中” | 补测试确认现状；未修则补实现 | 待确认 |
| F4 | `agent_snapshots` 无生产写入、50ms 批写未实现 | 文档已降级为 M2；若产品要求“崩溃只丢尾部”或 UI 卡顿达标，则必须实现 | 先做 10k 事件回放（U3）再决定是否实现 | 非当前必须；M2 决策项 |
| F5 | 长尾合成证据 precision/recall 未测（U11） | 用户可见 diff 误报/漏报 | 每适配器 3 次真实会话对比 `git status`，不达标再改代码 | 待验证 |

