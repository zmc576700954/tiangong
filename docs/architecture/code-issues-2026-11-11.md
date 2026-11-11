# 代码侧问题清单（2026-11-11 核验）

> **性质**：对 `docs/architecture/session-map-blueprint.md` 做进度核验时发现的**代码问题**。
> 首轮只登记、不动代码；**2026-11-11 三次处理已把 6 条全部收口**（§2/§3/§6 补了 UI / handler / DTO，§1/§4/§5 修的是测试与配置）。下面同时保留「当时的现象与证据」与「怎么修的」，方便回看。
>
> **基线**：`007f9d2`（核验时的 HEAD）。下面「实测」除特别注明外均为该提交上的读码/跑测结果。
> **核验方式**：读码 + 跑单测 + 机械统计（IPC 通道三数按护栏测试同口径重算）。
> **与蓝图的关系**：蓝图记录「做了什么/没做什么」，本文件记录「做出来的东西哪里不牢」。
> 两者不互相替代，也不合并——代码问题不该混进状态总账。

## 状态总览（2026-11-11 三次处理后）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 护栏测试负载敏感 flake | **已修**（该文件 describe 超时 30s） |
| 2 | 证据建议三通道无 renderer 入口 | **已修**（面板「证据建议」区：接受/驳回 + E1 输入） |
| 3 | `map:link:delete` 无 handler | **已修**（`LinkService.delete` + IPC + 列表/新建/删除 UI） |
| 4 | `better-sqlite3` ABI 不匹配 | **已处理**（`npm rebuild`，仅动 `node_modules`） |
| 5 | 全量测试不绿 | **已修**：26 例环境类改为按用例能力探测 skip（带原因），全量 0 失败 |
| 6 | `map:node:timeline` 无 DTO 约束 | **已修**（`TimelineEntryDTO` + 显式列映射） |

---

## 1. 护栏测试自身是负载敏感 flake —— 已修复

**现象**：`src/main/__tests__/ipc-preload-allowlist.test.ts` 单独跑 5/5 绿；全量并行跑时 `5000ms` 超时失败（同一提交、同一机器）。

**证据**：
- 单跑：`npx vitest run src/main/__tests__/ipc-preload-allowlist.test.ts` → 5 passed。
- 全量：`npx vitest run` 中该文件出现在 FAIL 列表；失败原因是超时，不是断言失败。
- 单独复测各例耗时：`521ms / 7503ms / 704ms / 703ms / 4516ms`——第五条（renderer 断头检测）独自就要 4.5s，只剩 0.5s 余量。

**成因**：该测试同步遍历 `src/main` 与 `src/renderer` 全量 `.ts/.tsx` 做正则扫描（无缓存、无并发上限），在满负载下 5s 不够。

**影响**：它是 IPC 面的唯一自动安全网。网本身在满载时会破，等于关键护栏在 CI 上不可靠——一旦 push 开卡门，这条会成为噪声失败源，掩盖真实回归。（v3.21 后该护栏覆盖 **204 注册 / 196 暴露 / 100 使用**，数字由测试动态统计，不写死在断言里。）

**处理（2026-11-11）**：给该 describe 单独放宽到 `{ timeout: 30_000 }`，并在文件里写明「宁可变慢，也不能在满载时假红」。**未改断言、未改遍历逻辑**。

**残留**：30s 是余量而非根治。彻底做法是按文件 mtime 缓存 `stripComments` 结果；当前耗时量级（<8s）不值得现在做。

---

## 2. 三条证据建议通道已暴露，但 renderer 零调用

**现象**：`map:evidence:suggestion:accept`、`map:evidence:suggestion:dismiss`、`map:evidence:e1:create` 均在 preload 白名单内，renderer 侧没有任何调用点。

**证据**：
- 三通道在 `src/preload/index.ts` 的 `exposedChannels` 内。
- 按 `electronAPI['<channel>']` 字面量统计 renderer 全部调用，93 条使用中不含上述三条（统计脚本与护栏测试同口径）。
- `NodeMapPanel` 只调 `map:evidence:suggestions:list`（只读列表）。

**影响**：这正是 C1 的同类问题——「agent 产出建议 → 人工接受/驳回」这条链在界面上走不通。建议会永远停在 `pending`，而文档把它记成已交付能力。用户可见价值为 0。

**建议（原）**：补两个按钮（接受/驳回）+ 一个 E1 手写入口，或从 preload 白名单移除并在文档登记「未开放」。

**处理（2026-11-11 三次处理）**：采用「补 UI」而不是「撤白名单」——通道本身是对的，缺的是消费方。
- `NodeMapPanel` 新增「证据建议（待裁决）」区：pending 列表（等级/类型/理由/置信度）+ 接受/驳回按钮，直连 `map:evidence:suggestion:accept` / `:dismiss`（`resolvedBy='local-user'`，与提案采纳同一口径）。
- 同一区底部加 E1 手动输入：`summary` 必填，`ref` 固定 `{kind:'node', graphId, nodeEntityKey}`，等级/写入方由主进程固定为 E1/human；写入成功才清空输入（失败不丢用户写的判断）。
- `mapStore` 增 `nodeSuggestions` 缓存与 4 个动作；读取失败**保留上一次列表**并显示错误，不把失败伪装成「没有建议」。
- 测试：面板 4 例（接受/驳回/空态/E1 ref 与清空）+ 既有 IPC 层用例继续覆盖服务端事务。

**残留**：建议列表只拉 `pending`（历史 accepted/dismissed 不在面板展示）；需要「裁决历史」时再加筛选，不改写通道。

---

## 3. `map:link:delete` 无 handler

**现象**：手工连边只交付了一半——`map:link:create` 有 handler、无 UI；`map:link:delete` 连 handler 都没有。

**证据**：
- `src/main/ipc/map.ts` 有 `map:link:create`（`links.create({ linkType: 'relates_to' ... })`），无任何 `map:link:delete`。
- 全仓检索 `link:delete` 零命中（含 preload、renderer、main）。
- `map:link:list` 无 renderer 消费。

**影响**：用户若通过任何途径建立了一条错误连边，没有任何撤销手段；数据只能靠直接改库清理。对「地图可信」这个目标来说是硬缺口。

**建议（原）**：最小闭环 = `link:delete`（校验 origin=human、写 orphan 或硬删）+ 列表 UI + 删除按钮。三件缺一不可。

**处理（2026-11-11 三次处理）**：三件全做，另补了新建入口（否则「删除」没有真实用户路径）。
- `LinkService.delete({ id, projectPath, reason? })`：校验 id / projectPath 必填 → 行存在 → `project_path` 与当前项目一致（`fs.realpath` 同 create 口径）→ `origin='human'`；然后**硬删**并写日志。`orphan` 语义是「端点不可解析」，不能拿来当墓碑。
- 新增错误码 `link_not_found` / `project_mismatch` / `not_human_origin`，IPC `map:link:delete` 已注册、已暴露、进结构化错误通道（renderer 能区分「不存在 / 不属于本项目 / 非人工来源」）。
- 面板「关联连边」区：列表（类型/方向/对方节点/来源）+ human 行删除按钮 + 同图节点下拉新建 `relates_to`；无项目路径时只解释原因，不给入口。
- 测试：link-service 4 例（硬删 / 派生拒绝 / 跨项目拒绝 / 空参与不存在）+ IPC 1 例 + 面板 4 例（删除 / derived 无入口 / 无项目路径 / 新建）。

**边界（未放开）**：L1 人工连边仍只允许 `relates_to`；开 `derives_from` 等其他类型需另开裁决。

---

## 4. 本机 `better-sqlite3` 预编译产物与 Node 版本不匹配 —— 已处理（仅动 `node_modules`）

**现象**：核验开始时所有碰 DB 的测试全红，报 `NODE_MODULE_VERSION` 不匹配。本机 Node 22（ABI 127），`node_modules/better-sqlite3/build/Release/` 是 ABI 115 的产物。

**处理**：为取证执行了 `npm rebuild better-sqlite3`，**只动 `node_modules`，未改任何源码**；重建后 DB 测试恢复正常。

**影响**：
- 不是代码缺陷，是本地依赖状态问题；但会让人误判"代码挂了"。
- 每次 `npm install` / 切换 Node 版本后都可能重现。

**建议**：
- 在 README 或 `CONTRIBUTING` 明确 Node 版本约束，并说明 `postinstall`（`electron-builder install-app-deps`）跑完后 vitest 仍需与 Electron ABI 对齐的注意事项。
- 或统一测试用 Node 版本，避免"测试跑在系统 Node、运行跑在 Electron"两套 ABI。

---

## 5. 全量测试不绿：14 文件 / 34 例 → 7 文件 / 26 例，且已逐条定性

**初始现象**：基线 `007f9d2` 上 `npx vitest run` 为 352 文件 / 4216 例，其中 14 文件 / 34 例失败。

**处理与复测（2026-11-11）**：
1. 14 个失败文件**逐个单跑**（一次只跑一个文件，排除并行负载），得到两类结果：
   - **单跑即绿 → 负载型**（6 文件 / 7 例）：`settings`、`claude-code-subagent`、`bash-readonly`、`pipeline-writeback`、`telemetry`、`SettingsPanel.locale`。
   - **单跑仍红 → 疑似环境/真实缺陷**（7 文件 / 26 例）：process-reaper 9、process-supervisor 4、run-node 7、registry-hardening 3、startup-reconciler 1、capability 1、agent-eval(U8) 1。
2. 负载型：全局 `testTimeout` 5s → 15s（只吸收并行排队），全部转绿。
3. 疑似环境类：逐条查错误类型，并**直接探测宿主能力**：

```
$ ps -o pid,pgid,etime,command -p $$
(eval):1: operation not permitted: ps

$ /usr/bin/sandbox-exec -p '(version 1)(allow default)' -- /bin/echo ok
ok
$ /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny file-write*)' -- /bin/sh -c 'echo x'
sandbox-exec: sandbox_apply: Operation not permitted
```

即：**`ps` 读不到进程表，`sandbox-exec` 套限制性 profile 被系统拒绝**（只放行 `(allow default)` 的空壳）。而 7 个文件全部依赖这两项——进程归属校验要读 pid/pgid/startedAt/command，canary 要真的跑限制性 profile。

**结论（定性，不是"修好了"）**：
| 类型 | 文件 | 判定 |
|---|---|---|
| `ps` 被禁用 | process-reaper、process-supervisor、run-node、registry-hardening、startup-reconciler、agent-eval(U8) | **宿主限制，非代码回归** |
| `sandbox_apply` 被禁用 | `src/main/shared/sandbox/__tests__/capability.test.ts`（canary 正向步骤直接失败） | **宿主限制，非代码回归** |
| 测试依赖宿主结论 | `claude-code.test.ts`（Bash 只读 allow） | **已修**：mock 能力位为 available，另补一条「不可用 → ask」用例反向覆盖 |
| 负载型 5s 超时 | settings / telemetry / pipeline-writeback / SettingsPanel.locale / claude-code-subagent / bash-readonly | **已修**：全局 `testTimeout` 15s |
| 内存护栏误红 | `src/main/__tests__/agent-manager-restore.test.ts`（2 例） | **已修**：并行跑时空闲内存跌破 darwin 的 64MB 下限，`isMemoryInsufficientForNewSession` 直接拒绝建会话；测试里钉住 `os.freemem`，护栏本身仍由 `agent-manager.test.ts` 单测覆盖 |

**影响**：v3.21 之前，push 开 CI 卡门在受限机器上会红；现在环境类 26 例按能力探测 skip（带原因），全量 **0 失败**。红的信号只剩真回归，不再是 "mixed noise"。

**原待决策（v3.21 已按「按用例探测」处理，见下）**：是否给这 7 个文件加**能力探测式 skip**（`describe.skipIf(!canUsePs())`）。注意代价：这 7 个文件里还有约 40 条**当前通过**的用例（如 registry-hardening 9 条），整文件 skip 会连带丢覆盖；更精细的做法是只 skip 环境相关的那几条。这件事影响面大于"修个 flake"，留给你拍板。

**处理（2026-11-11 三次处理）**：不做整文件 skip，改为**按用例能力探测**：
- 新增 `src/main/__tests__/helpers/host-probe.ts`：`canReadProcessTable()`（`ps -o pid=,pgid=,etime=,command= -p <self>` 能取到自己这一行）与 `canApplySandboxProfile()`（macOS 上真跑一次 `(allow default)(deny file-write*)`）。两者独立于被测模块、模块级缓存。
- 受影响用例逐条 `it.skipIf(!psAvailable)`（process-reaper 9 / run-node 7 / registry-hardening 3 / startup-reconciler 1 / agent-eval U8），`process-supervisor` 4 条全部依赖进程表故整组 `describe.skipIf`。**同文件里不依赖进程表的用例照跑**（如 registry-hardening 6 条权限位用例、process-reaper 2 条守卫用例）。
- `sandbox capability` 的 canary 用例改为**双向断言**：宿主可套限制性 profile 时必须判可用且 `reason='ok'`；宿主拒绝时必须判不可用且 `reason≠ok`。这样「环境不支持」与「探测撒谎」被区分开，而不是简单跳过。
- `agent-eval` U8 在 `ps` 不可读时返回 **SKIP + 缺什么**（harness 口径：缺条件记 SKIP，不把「没跑」写成 FAIL 结论）。
- 复跑：7 个文件 **45 通过 / 31 跳过 / 0 失败**；全量 `vitest run` **352 文件 / 4234 例，4188 通过、46 跳过、0 失败**。跳过项全部带原因（宿主能力 26 + 既有凭据/平台类 20）。

**代价**：受限宿主上「进程归属 / 沙箱 canary」这部分覆盖确实没跑到。它们不是被删除，而是在能力缺失时明确标为未验证——比假红或假绿都诚实。

---

## 6. `map:node:timeline` 的返回结构无编译期约束

**现象**：主进程 `SELECT l.*` 直接返回行，renderer 侧 `(timeline ?? []) as unknown as TimelineEntry[]` 强转。

**证据**：`src/main/ipc/map.ts` 的 `map:node:timeline` handler；`src/renderer/store/mapStore.ts` 的 `fetchNodeData`。

**影响**：`node_session_links` 增列/改名时，两端都不会报错，只会在运行时静默丢字段或读出 `undefined`。本轮 G8-2 时间线切换依赖该结构（`thread_id`/`ended_at`/`thread_title`），属于"能跑但无保护"。

**建议（原）**：给该通道定义显式 DTO（`TimelineEntryDTO`）并在 handler 内 map，不用 `SELECT *` 直出。

**处理（2026-11-11 三次处理）**：
- `src/shared/types/ipc.ts` 新增 `TimelineEntryDTO`（10 个显式字段），`map:node:timeline` 返回类型改为 `Promise<TimelineEntryDTO[]>`。
- `src/main/ipc/map.ts` 改成显式列别名 + 逐字段映射（`?? null` 处理 LEFT JOIN 缺行），不再 `SELECT l.*`。
- `src/renderer/store/mapStore.ts` 去掉 `as unknown as TimelineEntry[]`；`TimelineEntry` 与 DTO 字段一一对应。
- 测试：`map-read-ipc.test.ts` 断言出参键集合恰为 DTO 的 10 个键（加列/改名会在两端编译或断言期暴露），并断言 LEFT JOIN 不到线程时字段为 `null` 而非整个键消失。

---

## 附：本轮已顺手修掉的一条（不属于上述清单）

G8-2 的「时间线切换」原本只读、不可切；本轮在 `NodeMapPanel` 补了切换（见蓝图 I.2 的 G8-2 行）。
这不是"代码问题登记"，是补齐未完成项，故此处只作交代。
