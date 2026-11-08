# 受控演练失败记录：审批弹窗未挂载（2026-11-08）

> 三态口径：**实测**＝本次真机跑出来的观测；**推断**＝由代码/条件推出的解释，未直接观测；**未验证**＝本轮未跑到或未核对的环节。
> 本记录只记录失败，不在本文语境里修任何东西；修复见 `535479d`（全局审批入口）与 `b55048e`（gate 逐道诊断），重跑结论另行记录。

## 1. 演练目标与方式

用 `c602ee7`（schema v35 验收确认独立存储）之后的构建，在完全隔离环境跑一次受控闭环，验证：

gate 六道 → tick 领取 → kernel turn → **工具调用时的写前审批** → 验收执行器 → `manual` 落 `needs_input` → 面板确认收口 → 证据绑定 → 退出无残留。

方式：

- 构建：仓库内 `npx vite build`（2026-11-08 15:33 产物）。
- 项目目录：`/tmp/bizgraph-drill-20261108/project`（空目录，仅放演练目标文件）。
- userData：`/tmp/bizgraph-drill-20261108/userData`（通过 `--user-data-dir` 隔离，实测 `app.getPath('userData')` 随之改变）。
- 真实库：`~/Library/Application Support/bizgraph/data/bizgraph.db`，演练前后只读核对 mtime，**未被打开**。
- 两阶段启动：先不带开关启动一次建 schema（v0 → v35）；再由脚本直连 sqlite3 落种子数据；再带 `BIZGRAPH_MAP_EXECUTION=1`、`BIZGRAPH_MAP_EXECUTION_ADAPTER=claude-code` 启动演练进程。
- 种子：`g_drill` / `n_drill`(dev) / `wi_drill`（`status=queued`、`gate_status=pass`、scope 一个文件）/ `ws_drill`（`status=pending`），`acceptance_json` 含 1 条 `command` + 1 条 `manual`。

## 2. 结果：断在「审批可见可决议」

| 环节 | 结论 | 三态 | 依据 |
|---|---|---|---|
| gate 六道判定 | 未逐道可查（tick 内评估，只留最终判定） | 推断（通过） | item 进入 running + 后续 claim/run 成立，说明未走 waived/blocked 分支；无逐道日志 |
| tick 领取 | 通过 | 实测 | `workitem:step:run` 返回 `STEP_NOT_PENDING "step status=running"`；`work_runs` 出现 `wr_1794124243679_…` |
| kernel turn 真实启动 | 通过 | 实测 | `[MapExecutionRuntime] 执行触发已启动：adapter=claude-code`；`[prompt-orchestrator] Assembled prompt … 245 tokens` |
| **工具调用审批真的弹了** | **失败** | 实测 | 主进程侧审批真实生成（`agent_approvals` 两条 Bash 行），事件也到达 renderer（`pending=1`），但 **DOM 中始终没有审批卡片**；180s 后超时被 fail-closed 拒绝 |
| 验收执行器跑并给结果 | 未达 | 未验证 | step 停在 running，无验收结果 |
| `manual` 落 `needs_input` | 未达 | 未验证 | `input_request_json` 为空 |
| 面板确认按钮点击收口 | 未达 | 未验证 | — |
| 证据绑定实际执行内容 | 未达 | 未验证 | `node_evidence` 无行 |
| 退出正常无残留 | 通过 | 实测 | `APP_CLOSED`；`LEFTOVER_CHECK exit=1 output=[]`（`pgrep -fl <project>` 无匹配） |

## 3. 断点与根因

### 3.1 断点（实测）

审批卡片没有出现在界面上：

- `DIAG_APPROVAL` 每 5s 一条，持续 180s，均为 `pending:1`、`domHasApprovalText:false`；
- 等待 `button.bg-orange-600`（允许按钮）180s 超时，落 `APPROVAL_DIALOG_NOT_VISIBLE_IN_180S`；
- 失败截图里右栏 Agent tab 显示「欢迎使用 Agent」空态，没有任何审批卡片。

### 3.2 根因（推断，已由代码位置确认）

`ApprovalRequestDialog` 只挂在 `AgentChatPanel` 的「存在 UI 会话线程」分支：

```
{!currentThread && threads.length === 0
  ? 空态「欢迎使用 Agent」
  : (<ChatHeader/> … <ApprovalRequestDialog/> …)}
```

编排 runtime 的 kernel turn 由主进程发起，不写入 renderer 的 `threads`/`currentThread`。
因此 `currentThread` 为空 → 走空态 → 对话框从未挂载 → 请求虽到达 renderer 但无组件渲染。
120s 交互超时后 `ApprovalGateway` 按 fail-closed 落 `denied`。

**这是产品侧缺口，不是驱动/构建问题**（实测：构建产物含 `getPendingApprovals` 与 `bg-orange-600`；renderer 收到事件、`getPendingApprovals` 返回 1 条）。

## 4. 证据清单

留档目录：`/tmp/bizgraph-drill-20261108/`（临时、易失；条目随环境清理会消失）。

| 文件 | 内容 |
|---|---|
| `drill.mjs` | 演练脚本（两阶段启动、种子、断言、诊断、收尾） |
| `out/drill.log` | 逐行观测（`SCHEMA_READY version=35`、`SEED_OK`、`ENQUEUE_PROBE`、`DIAG_APPROVAL`、`APPROVAL_DIALOG_NOT_VISIBLE_IN_180S`） |
| `out/main-process.log` | 主进程日志（默认关闭行、开关启动行、prompt 组装行） |
| `out/99-failure.png` | 失败时整屏截图（右栏空态，无审批卡片） |
| `out/bizgraph-final.db(+wal/shm)` | 演练库退出后快照 |
| `out/db-query.log` | 快照查询结果 |
| `out/leftover-processes.log` | 残留进程检查 |

关键日志原文：

```
[Database] Migrating schema from v0 to v35...
[Database] 历史人工验收确认行 0 条（agent_approvals 无需迁移）
[Database] Schema migrated to v35
[MapExecutionRuntime] 执行触发未开启（默认关闭）：tick 不启动，写通道将拒绝调用
[MapExecutionRuntime] 执行触发已启动：adapter=claude-code interval=1000ms
[prompt-orchestrator] Assembled prompt for session claude-…: 245 tokens …
ENQUEUE_PROBE {"ok":false,"error":{"code":"STEP_NOT_PENDING","message":"step status=running"}}
DIAG_APPROVAL {"events":["appr_143f0ed9-…"],"pending":1,"domHasApprovalText":false}
APPROVAL_DIALOG_NOT_VISIBLE_IN_180S
```

库快照（退出时）：

```
schema_version|35
work_items | wi_drill | running | pass
work_steps | ws_drill | running | 1 | (input_request_json 空)
work_runs  | wr_1794124243679_ff228049 | running | | claude-…
agent_approvals | appr_143f0ed9-… | Bash | denied | timeout
agent_approvals | appr_ab6c6783-… | Bash | pending |
```

## 5. 环境核对（实测）

- 真实库 mtime 基线 `1794051235`（`2026-11-07 19:33:55`），演练后复核同为 `1794051235`，未被触碰。
- 演练库 `schema_version=35`（本次构建的当前版本）。
- `BIZGRAPH_MAP_EXECUTION` 默认值：首次启动日志明确「执行触发未开启（默认关闭）」，代码 `isMapExecutionEnabled()` 未设置即 false——演练只在第二进程注入，开关未落任何持久配置。
- 演练结束 `app.close()` 后无残留进程；临时 `project` 与 `userData` 已删除，仅保留证据目录。

## 6. 为什么单测发现不了

1. **测试环境从不「无线程」**：`ApprovalRequestDialog.test.tsx` 直接渲染对话框组件本身，断言「有 pending 就出现卡片」。它验证的是组件内逻辑，而断点在**父组件的挂载条件**——单测绕过了 `AgentChatPanel` 的条件分支。
2. **组件测试不覆盖编排来源**：既有用例投递的都是「聊天 turn」形状的请求，`sessionId/turnId` 均在 UI 线程里；编排 runtime 发起的 turn 不会进入 `threads`，这一差异只在真机集成里出现。
3. **IPC 与渲染分层各自为绿**：主进程测试证明网关会广播、会超时；renderer 测试证明组件能渲染。两段都对，但中间「审批入口挂在哪」没有断言，属于集成层契约缺口。
4. **类型系统帮不上**：「对话框必须在有线程时才能挂载」不是类型错误，而是 UI 结构假设；只有把审批入口改成应用级（与线程无关）并在非 Agent 页面也能看到的集成断言，才能覆盖。
5. **演练才有的时序**：tick 在 `createWindow()` 之前启动并自动领取，窗口出现时审批往往已在进行——单测按「先有界面、再有请求」构造，恰好掩盖了「界面无挂载点」的情形。

## 7. 后续（仅指向，不含修复细节）

- 审批入口改为应用级、与聊天线程解耦：`535479d`（`approvalStore` + 全局 `ApprovalInbox`，聊天弹窗投影同一事实源）。
- gate 逐道诊断：`b55048e`（引擎只读、tick 落 `map_migration_reports`）。
- 重跑演练：标准提高为「非 Agent 页面可见并决议 + 六道 gate 各自可查 + 全链路收口 done」。

## 8. 第二轮重跑：断在 ScopeGuard 误判越界

> 本节承接上文，记录 `535479d` + `b55048e` 之后的同一套受控演练。仍然只记录失败与断点，修复提交见 §9。

### 8.1 方式与环境

- 构建：`npx vite build`（2026-11-08 18:09 产物）。
- 隔离路径：项目 `/tmp/bizgraph-drill-20261108-r2/project`，userData 同目录 `userData`，产物 `out/`。
- 开关：第二进程注入 `BIZGRAPH_MAP_EXECUTION=1`、`BIZGRAPH_MAP_EXECUTION_ADAPTER=claude-code`；首启默认关闭行为不变。
- 真实库 mtime 基线 `1794051235643`，演练前后一致，未被打开。

### 8.2 逐环结果

| 环节 | 结论 | 三态 | 依据 |
|---|---|---|---|
| **非 Agent 页面全局审批可见可决议** | 通过 | 实测 | 未切 Agent tab（`agentChatVisible:false`），`[data-testid="approval-inbox"]` 出现；3 条审批（Bash×2、Write×1）逐条展示来源并成功 allow；`agent_approvals` 三行 `allowed`/`decided_by=user` |
| allow 之后 turn 继续 | 通过 | 实测 | 第 1、2 次 allow 后 turn 继续推进到下一次工具调用（第 2、3 条审批依次出现） |
| gate 六道逐道可查 | 通过 | 实测 | 运行中查得 `map_migration_reports`：`stage='gate_eval:wi_drill'`、`kind='integrity_check'`、`stats.verdict='pass'`、`evaluator_version='gate-engine@1'`、`G1..G6` 均 `ok`、`thresholds={g4MaxFiles:20,g4MaxLines:80}`（演练策略值） |
| **第 3 次 allow 后的写盘** | **失败** | 实测 | watcher 判越界并回滚，turn 被 reclaim，step/item 一并 `failed` |
| 验收执行器跑出结果 | 未达 | 未验证 | step 已 `failed`，未进入验收 |
| `manual` 落 `needs_input` | 未达 | 未验证 | `input_request_json` 为空 |
| 面板确认收口 `done` | 未达 | 未验证 | — |
| 证据绑定实际内容 | 未达 | 未验证 | `node_evidence` 0 行 |
| 退出无残留 | 通过 | 实测 | `APP_CLOSED`；`LEFTOVER_CHECK exit=1 output=[]` |

### 8.3 断点（实测）

第三次 allow 是一条 `Write` 到 `artifacts/ok.txt`（白名单内、项目根为 `/tmp/...`），主进程日志依次出现：

```
[ScopeGuard] Out-of-bounds write detected by watcher: /tmp/.../project/artifacts/ok.txt
[ScopeGuard] Commit rejected: post-execution validation failed, rolling back...
[ScopeGuard] Deleted out-of-bounds new file: /private/tmp/.../project/artifacts/ok.txt
[AgentRuntime] turn failed reclaim: killed=1 …
[WorkItemService] work_item wi_drill: 全部步终态 → failed
```

库内结果：`work_steps` = `failed`（`failure_class=infra`）、`work_runs` = `failed/infra`、`node_evidence` = 0 行。

### 8.4 根因（实测 + 代码定位）

macOS 上 `/tmp` 是指向 `/private/tmp` 的符号链接。两侧解析口径不一致：

- 白名单侧：`sanitizeAllowedFiles` 在文件**尚未创建**时调用同步 `safeRealpathSync`；其 ENOENT 分支直接退化为 `path.resolve`，得到 `/tmp/...`。
- watcher 侧：事件到达时文件**已存在**，`realpathSync` 得到 `/private/tmp/...`。
- `allowedSet.has(resolved)` 因此永不命中 → 判越界 → 回滚。

实测佐证：

```
realpath(/tmp)            = /private/tmp
path.resolve(/tmp/x/y)    = /tmp/x/y        # 未创建路径的旧退化结果
realpathSync(/tmp/x/y/z)  = /private/tmp/x/y/z  # 创建后（若存在）
```

代码定位：`src/main/shared/path-utils.ts` 的 `safeRealpathSync` 缺「最近已存在祖先」解析，而异步版 `safeRealpath` 已有该逻辑（但见 §8.5）。

### 8.5 同时发现：异步版累积顺序缺陷（实测）

补同步版测试时发现，异步 `resolveNearestExistingAncestor` 最终使用 `missingParts.reverse()`，而该数组是逐层 `unshift` 累积的**从上到下**顺序，翻转后拼出的路径段序颠倒（例如 `/tmp/a/b/c` → `/private/tmp/c/b/a`）。此前单测未覆盖「不存在路径 + 符号链接祖先」，因此没有暴露。同步版对齐时不应照抄，须与异步版一起修正。

### 8.6 为什么单测发现不了

1. **路径测试只用了已存在路径**：`path-utils.test.ts` 的用例都是 `mkdtemp` 后真实存在的目录/文件，`safeRealpathSync` 永远走 `realpathSync` 成功分支，ENOENT 退化分支从未被触发。
2. **ScopeGuard 测试整体 mock 了 realpath**：`scope-guard.test.ts` 用 `realpathSyncMap` 替换 `safeRealpathSync`，符号链接场景靠手工映射，不经过真实文件系统，天然绕开「祖先解析」。
3. **没有断言「创建前解析 == 创建后 realpath」**：现有用例分别验证「存在文件在/不在白名单」，没有验证同一路径在文件生命周期两端的规范形式一致性；这正是演练断点的本质。
4. **平台差异只在真机路径上出现**：`/tmp` 符号链接是 macOS 运行时事实，单测的临时目录（`os.tmpdir()`）下创建与解析两步都走真实路径，不产生两侧不一致。
5. **错误被 fail-closed 掩盖**：白名单不命中时 ScopeGuard 正确回滚（保守方向），单测看到的是「越界被拦截」的正面行为，不会把它当成缺陷。

### 8.7 证据清单

留档目录：`/tmp/bizgraph-drill-20261108-r2/`（临时、易失）。

| 文件 | 内容 |
|---|---|
| `drill.mjs` | 第二轮演练脚本（隔离路径、两阶段启动、种子、全局审批断言、诊断查询） |
| `out/drill.log` | 逐行观测与最后一条 `APPROVAL_INBOX_NOT_VISIBLE attempt=4` 超时（等待已不会再出现的第 4 条审批） |
| `out/main-process.log` | ScopeGuard 越界/回滚/reclaim 原始行 |
| `out/0{1,2,3}-inbox-approval.png` | 非 Agent 页面下全局审批入口与三次 allow |
| `out/99-failure.png` | 回滚后失败态整屏 |
| `out/bizgraph-final.db(+wal/shm)` / `db-query.log` | 退出快照：审批 3 行 allowed、step/run failed、evidence 0 |
| `out/leftover-processes.log` | 残留进程检查 |

## 9. 修复（a03fbfd）与覆盖面说明

修复内容：同步 `safeRealpathSync` 的 ENOENT 分支改为「最近已存在祖先」realpath 后拼接剩余路径段；修正同步/异步两版累积段序被反转的缺陷；`sanitizeAllowedFiles` 与 `prepareSandbox` 的工作目录统一按同一 realpath 口径使用（备份相对路径、监控目录、快照键、`sandbox.workingDir`）。**未扩大白名单、未把解析失败当放行**：解析不到祖先仍退化为 `path.resolve`，越界判定逻辑不变。

现在能过的场景：

- 项目根位于符号链接目录（`/tmp`、macOS `/var` → `/private/var`）且白名单文件尚未创建：白名单规范形式与创建后 watcher/snapshot 的 realpath 一致。
- 同一项目内明细路径逐级不存在（多级待创建目录）：按最近已存在祖先解析，创建前后一致。
- 白名单文件所在目录被单独监控、备份相对路径计算：不再出现由 `/tmp` 与 `/private/tmp` 混用产生的假 `../`。

仍会失败/不在本次覆盖内的场景（保守失败，不放行）：

- 祖先路径 `EACCES`/其他不可解析错误：回退 `path.resolve`，仍可能与 realpath 不一致（fail-closed，可能误报越界，不会放过越界）。
- 工作目录内的符号链接指向外部：指向目标的真实路径不在工作目录时依旧判越界（新增反向往例锁定，含「目标文件尚未创建」）。
- Windows junction/大小写折叠、WSL/网络文件系统：本轮未在对应平台实测。

