# Reaper 跨会话隔离对抗测试台（spikes/reaper-isolation）

专门用来回答一个问题：**取消/崩溃/重启清扫一个会话时，会不会误杀另一个会话的进程？**

- 只读消费 `src/main/**`，不修改 `src/**`、不修改 `spikes/agent-core/`、不修改 `spikes/codex-stream/`、不 commit。
- 所有场景使用**真实子进程树**（含长驻后代、

- 短命后代），不是 mock。
- 测试台通过 `src/adapter.ts` 一个适配层依赖被测实现，D5 重写后只需改这一处即可复跑。

---

## 0. 快照说明（重要）

本次运行期间，**另一个会话正在重写 reaper 与进程归属**（任务背景中已说明）。快照事实：

| 项 | 值 |
| --- | --- |
| 运行时快照时间 | 2026-11-04 22:50 CST |
| `src/main/agent/runtime/process/reaper.ts` | `0cdc10c15a1ca3779e2b792d68b40d334b9fb69e547121337c3e55909fb07512`，mtime 22:41:08 |
| `src/main/agent/runtime/runtime.ts` | `4fe782af089bf25acac595f59731d34483cf3e782f4a539393475d99ecbbff8f`，mtime 22:44:06 |
| 首次跑（22:44） | 命中的还是旧版 reaper（单 pid 树回收，无整组） |
| 本报告结论 | 基于 **22:41 重写后的新版 reaper**（22:47 之后的所有运行） |

> 结论只代表上述时点的代码快照。若 D5 继续改动，请按第 5 节复跑；hash 变化即意味着需要重新判定。
>
> **最新一次复跑（D5 新机制落地后）见第 7 章**，其中记录了新 hash 与逐条数值；第 1–4 章保留 D5 前的旧快照。

### C5 口径修订记录

旧版 reaper 从不整组回收，所以最初的 C5 是「不得出现任何 `-pgid` 信号」。22:41 的重写版**在证明 `pgid === pid`（自有组长）后会整组回收**。按任务原文「同组才允许整组回收」，C5 已改为：

- 不同 session/turn 的组不得重叠；
- 整组信号只允许命中本 turn 的自有组；
- 若 `pgid !== pid`（共享组），必须退回进程树回收（新增 C5b 专门验证）。

---

## 1. 契约条款表

运行环境：macOS 26.1 / Node（vitest 4.1.11）；所有数字来自 `.artifacts/evidence-current-53821.jsonl` 与当次控制台输出。

| 编号 | 条款 | 判定方式 | 现状 | 失败意味着的风险 |
| --- | --- | --- | --- | --- |
| C1 | 正常完成只 `forget`，不向任何进程发信号 | kill tap 计数 = 0；A/B 存活 | **PASS**（sends=0，A/B alive） | 完成路径误触发回收，正在跑的会话被静默打断 |
| C2 | 取消 A 只回收本轮登记句柄与其后代，B 不受影响 | 对 B 的 pid 与组的信号数 = 0；A 树死亡；接收侧日志 | **PASS**（`signalsToB=0`、`signalsToBGroup=0`；A 的 owner 与 long 各收 1 次 SIGTERM；整组信号 `-54248` 仅 1 次） | 取消一个会话连坐另一个会话（第一轮 P0-1 形态） |
| C3 | A 主进程 `kill -9` 后重启清扫，不得误杀 B | 重启后 `killRegistered` 对 B/canary 信号数 = 0；`report.missing` 含 A；A 已死 | **PASS**（`killed=0`、`missing=[54105]`、B/canary 信号 0、B 存活）。已知边界：A 的孙进程成为孤儿仍存活（`orphanGrandchildAlive=true`），reaper 没有它的 pid，不承诺认领 | 重启清扫按陈旧记录误杀新会话；或把「找不到」当成「已回收」 |
| C4 | 上一轮 pid 被无关进程占用时不得 kill（裸 pid / 仅 marker / 陈旧 startedAt+command） | 三种输入 kill 计数 = 0；canary 存活；`unresolved.reason=insufficient-proof` | **PASS**（三例 `killed=0`、`unresolved=54149:insufficient-proof`、信号 0） | PID 复用导致杀掉无关进程（第二轮 P0-A 形态） |
| C5 | 不同 session/turn 组不重叠；整组回收只命中自有组 | 比对 `pgid`；负 pid 信号目标集合；`killedGroups` | **PASS**（pgidA=54248 ≠ pgidB=54250；唯一组信号 `-54248`；B 组信号 0；`killedGroups=[54248]`） | 共享组整组回收一次杀穿多个会话 |
| C5b | `pgid ≠ pid`（无法证明自有组）时必须退回进程树回收 | 负 pid 信号数 = 0；本 turn 死亡；宿主存活 | **PASS**（`observedPgid=53816 ≠ pid`；`groupSignals=[]`；`killedPids=[54337,54336]`） | 对宿主/共享组发 `-pgid`，可能杀掉 Electron 主进程或所有会话 |
| C6 | 无法证明归属时 kill 计数 = 0，且状态可落 `residual_risk` | kill 计数 = 0；`unresolved>0`；`reason=insufficient-proof` | **PASS**（`killed=0`、`unresolved=1`、信号 0）。映射说明：`runtime.classifyResidual` 未导出，此处以 `ReapReport.unresolved` 作为其判定输入（源码口径见 `runtime.ts` 的 residual 分类段） | 证据不足仍开杀；或静默当作「已回收」，丢失残留告警 |
| C7 | 已退出的短命子孙不参与回收、不接收信号 | 短命 pid 信号数 = 0；日志只有 `ready→natural-exit` | **PASS**（shortPid=54444 信号 0，无 `signal` 日志；owner 组回收正常） | 对已消失的 pid 发信号，可能在 PID 复用后误杀新进程 |
| C8 | SDK 不暴露 PID 的兜底：只有 marker 时不得 kill | `register()` 返回 undefined；`reap` discovered/killed=0；诊断扫描只计数 | **PASS**（`register=null`、`discovered=0`、`diagnosticCount=1`、`signals=0`、子进程存活） | 用 marker/正则扫描直接认领并杀掉同厂商其他会话 |
| C9 | 4 会话并发时，取消只影响被取消的两个 turn | 受保护会话的 pid+组信号 = 0；被取消会话 >0；存活断言 | **PASS**（protected=0；cancelled=2，`-54574/-54578`；A/C/canary 存活） | 并发上限附近互相踩踏，取消一个拖垮一批 |
| C10 | 上一轮 pid 即使仍存活也不得被下一轮回收 | `reap('turn-1')` discovered=0；stale 信号 0；`turn-2` 正常回收 | **PASS**（turn1 discovered=0；stale 信号 0；turn2 回收 owner） | 陈旧句柄跨轮误杀；step/turn 主键作用域缺失 |
| C11 | 永不向自身、`pid<=1`、负 pid（作为普通身份）发信号 | kill 计数 = 0；`unsafe-pid` × 3 | **PASS**（signal 0；`1/-1/self` 全部 `unsafe-pid`） | 自信号杀死宿主；对 pid 1 发信号 |

### 现状缺口（加强版契约，单独跑、预期为红）

| 编号 | 条款 | 判定方式 | 现状 | 说明 |
| --- | --- | --- | --- | --- |
| C4b | 「同可执行名 + 同秒 startedAt」不得单独凑成归属证据 | kill 计数 = 0 | **FAIL**（证据：`-54989 SIGTERM`，canary 死亡） | `commandMatches` 在整串不等时退化为只比可执行文件名；叠加 `ps` 秒级 `startedAt`，存在 PID 复用 + 同秒启动的理论窗口。属已知 P3，不在 C4 最小口径内 |

C4b 的复现条件很窄（需要上一轮 pid 被复用、且新进程与旧记录同一秒启动、且可执行文件名相同），但一旦命中就是整组误杀，建议 D5 一并改成**完整命令行精确匹配**或引入更细粒度凭证。

---

## 2. 测试台怎么跑

```bash
cd spikes/reaper-isolation

# 契约套件（C1–C11）+ 缺陷检出对照，期望全绿
../../node_modules/.bin/vitest run --config vitest.config.ts \
  tests/isolation.test.ts tests/sabotage-detection.test.ts
# 或：npm test

# 加强版归属证据（C4b；D5 后预期转绿）
npm run test:hardening

# D5 新机制攻击面（C12 伪造/篡改/重放、C13 目录与密钥、C13b shim 抢占、
# C14 同 uid 伪造、C15 孤儿门、C16 竞态）
npm run test:attack

# C17 异常退出路径回收（真实 AgentRuntime + 真实进程树 + :memory: 测试库）
npm run test:abnormal

# 对抗对照：换三个坏实现跑同一套契约，期望每个都变红
npm run sabotage

# 适配层的类型自检
npx tsc --noEmit -p spikes/reaper-isolation/tsconfig.json
```

环境变量：

- `REAPER_IMPL=current`（默认）→ `ProcessReaper`
- `REAPER_IMPL=sabotage:shared-registry | sabotage:bare-pid | sabotage:group-wide` → 故意破坏实现

产物：`.artifacts/evidence-<impl>-<pid>.jsonl`，每条契约一行 JSON（信号列表、存活、`unresolved`、`killedGroups` 等），README 中的数字即来自这些文件。

### 证据口径

| 证据 | 采集方式 | 能否覆盖 SIGKILL |
| --- | --- | --- |
| 发出侧 kill tap | 测试进程内包装 `process.kill`，原样调用后记账 | 是（在测试进程内调用即被记录） |
| 接收侧 probe 日志 | 子进程真实安装 `SIGTERM/SIGINT/SIGHUP/SIGQUIT` handler，命中后追加 JSONL | 否（SIGKILL 不可捕获） |
| 存活探测 | `kill(pid, 0)` | — |
| 后代死亡方式 | 父 probe 监听 `child.on('exit', code, signal)` | 是（`signal='SIGKILL'`） |

> 局限：kill tap 只能看到**本进程内**发出的信号。若将来 reaper 移到独立进程，发出侧会失效，此时需依赖 probe 日志 + `child-exit` 的 signal 字段；README 的判定项已尽量同时使用两侧证据。

---

## 3. 故意破坏对照结果（证明测试台不是摆设）

`npm run sabotage` 实际输出摘要（三个坏实现全部让契约套件变红）：

| 坏实现 | 注入的缺陷 | 被判红的契约 | 结果 |
| --- | --- | --- | --- |
| `sabotage:shared-registry` | 全局共享登记表，不按 turn 隔离 | C2、C4、C5、C6、C7、C9、C10、C11（8 failed / 4 passed） | **RED** ✅ |
| `sabotage:bare-pid` | 不做归属证明，直接按 pid 发信号 | C2、C4、C5、C6、C7、C9、C11（7 failed / 5 passed） | **RED** ✅ |
| `sabotage:group-wide` | 按 `-pgid` 整组回收，无自有组校验 | C3、C4、C5b、C6、C11（5 failed / 7 passed） | **RED** ✅ |

另外 `tests/sabotage-detection.test.ts`（3/3 绿）逐条断言「坏版本产生的越界信号确实被探针抓到」：共享登记表 → B 被打；裸 pid → canary 被杀；整组 → 出现 `-pgid` 信号。若探针失效，这 3 条会先红。

> 数据性质：坏实现是**故意编写的模拟缺陷代码**，但它们驱动的仍是真实进程树与真实信号；契约套件的现状数据全部来自真实运行，无任何 mock 结果。

---

## 4. 现状通过率

| 套件 | 结果 | 时间 |
| --- | --- | --- |
| `tests/isolation.test.ts`（C1–C11，12 条） | **12 / 12 PASS** | 22:50:36，13.27s |
| `tests/sabotage-detection.test.ts`（缺陷检出） | **3 / 3 PASS** | 同上，1.51s |
| `tests/known-gaps.test.ts`（加强版 C4b） | **0 / 1（1 FAIL，预期）** | 22:50:54，1.14s |
| 对抗对照（3 个坏实现） | **3 / 3 变红** | 22:48 与 22:50 各跑一次，结果一致 |

最小口径契约 **12/12 通过**；唯一的红是加强版 C4b（可执行名退化匹配的理论窗口），不阻塞 M0，但建议列为 P3。

---

## 5. D5 重写完成后必须重点复跑的 3 条

1. **C5b（最高危）**：`pgid !== pid` 时必须退回进程树。若重写版对任何组都敢发 `-pgid`，会直接打到 Electron 主进程/所有会话所在的共享组；这条失败等于「宿主被杀」，必须最先跑。
2. **C2（取消边界）**：取消 A 时对 B 的 pid **与其进程组**信号必须为 0，且 A 的后代确实死亡。组回收引入后，`killedPids` 只记组长，后代只能靠组信号或存活断言证明，务必保留 `signalsToBGroup` 与存活断言两侧证据。
3. **C3（崩溃重启清扫）**：`kill -9` 后重启，不得按陈旧记录误杀 B；同时确认「找不到 pid」落 `missing` 而非 `killed`，孤儿后代是否被认领要按 D5 的新承诺重新判定（当前快照下孤儿仍存活）。

> 次要但建议一并跑：C4/C6（归属证据与 `residual_risk` 映射）、C10（跨轮陈旧句柄）。若 D5 改了 `registerProcess/killRegistered` 的签名或返回值，先改 `src/adapter.ts` 再跑，测试断言不需要动。

---

## 6. 目录结构

```
spikes/reaper-isolation/
├── README.md                 # 本文
├── package.json
├── vitest.config.ts          # 串行执行：信号探针是进程级单例
├── tsconfig.json
├── scripts/sabotage.sh       # 对抗对照入口
├── src/
│   ├── adapter.ts            # 唯一依赖 src 的适配层（未来只改这里）
│   ├── sabotage.ts           # 三个故意破坏的实现
│   ├── harness.ts            # 真实进程树 spawn/清理/ps 身份/证据落盘
│   ├── kill-tap.ts           # 发出侧信号探针 + 存活探测
│   └── probes/
│       ├── probe.mjs         # 长驻探针：记录收到的信号与后代退出方式
│       ├── short-lived.mjs   # 短命后代：150ms 自然退出
│       ├── orphan-parent.mjs # 构造真实孤儿（父进程立刻退出，子进程 reparent 到 pid 1）
│       └── supervisor-probe.mjs  # D5 监督 shim 替代物：写进程自注册文件
└── tests/
    ├── isolation.test.ts     # C1–C11（C3 含 self-registration 路径）
    ├── sabotage-detection.test.ts
    ├── hardening.test.ts     # C4b（加强版归属证据）
    ├── attack-surface.test.ts # C12/C13/C13b/C14/C15/C16（D5 新攻击面）
    └── abnormal-exit.test.ts # C17（真实 AgentRuntime 异常退出回收）
```

---

## 7. D5 后复跑（2026-11-04 23:19–23:22 CST）

D5 已把机制换成「受控 spawn → 自有进程组 / 监督 shim」：Claude 走 `spawnClaudeCodeProcess`、Codex 走 `codexPathOverride`，并由 shim 写进程自注册文件；`reaper.ts` / `runtime.ts` / 新增的 `process-supervisor.ts` 均已大改。

### 7.1 本次结果对应的实现（hash 校验）

| 文件 | SHA-256 | mtime |
| --- | --- | --- |
| `src/main/agent/runtime/process/reaper.ts` | `95522aa1e89d4d5009aaa0ecbbe089c57b02faa1bdfe1ccd45a785101b0dea64` | 23:00:37 |
| `src/main/agent/runtime/runtime.ts` | `c82a9dfd6a418a810f814ae7a63b01387ded944570c5a9e6f0936aa8b94db771` | 23:01:02 |
| `src/main/shared/process-supervisor.ts` | `628dd1cfb06901281f591e9abab21c6c71f95a68bd6377a47305892ed46dca50` | 23:00:42 |

> 跑完再次校验 hash 未变化，以下数字对应上述版本。测试均为独立临时目录（`mkdtemp`），未触碰仓库开发库或共享 `/tmp/bizgraph-agent-proc`。

### 7.2 全套 12 条契约

**12 / 12 PASS**（23:19:30–23:19:44，14.2s，证据文件 `.artifacts/evidence-current-84454.jsonl`）。逐条证据摘要：

| 编号 | 关键数值 | 结论 |
| --- | --- | --- |
| C1 | `sends=0`，A/B alive | PASS |
| C2 | `killed=1`（owner 84487）、`killedGroups=[84487]`、按 pid 信号 1、按组信号 1（`-84487`）、**B pid 信号 0 / B 组信号 0**、短命 pid 信号 0；接收侧 A 与 A.long 各 1 次 SIGTERM | PASS |
| C3 legacy | `killed=0`、`missing=[84607]`、B/canary 信号 0、B 存活；旧路径无自注册文件的孤儿 `orphanGrandchildAlive=true`（不可认领，属旧路径边界） | PASS |
| C3 registry | shim 写入记录 → 宿主 `kill -9` → 新进程凭记录回收：`killed=1`、`killedGroups=[cliPid 84652]`、`killedPids=[84652]`、后代 84681 死亡、**B pid/组信号 0**、无其他组信号 **可认领 = 是** | PASS |
| C4 | 三例 `killed=0`、`unresolved=84780:insufficient-proof`、canary 信号 0 | PASS |
| C5 | `pgidA=84890 ≠ pgidB=84892`、唯一组信号 `-84890`、`killedGroups=[84890]`、B 组信号 0 | PASS |
| C5b | `observedPgid=84428 ≠ pid`（共享宿主组）、`groupSignals=[]`、`killedGroups=[]`、`killedPids=[84979,84978]`、宿主存活 | PASS |
| C6 | `killed=0`、`unresolved=85050:insufficient-proof`、信号 0 | PASS |
| C7 | `killedPids=[85083]`、`killedGroups=[85083]`、short 85085 信号 0、日志仅 `ready→natural-exit` | PASS |
| C8 | `register=null`、`discovered=0`、`killed=0`、`diagnosticCount=1`、`signals=0` | PASS |
| C9 | protected 信号 0、cancelled 信号 2（`-85229`/`-85233`）、A/C/canary 存活 | PASS |
| C10 | turn1 `discovered=0`、stale 信号 0、canary 信号 0、turn2 回收 85424 | PASS |
| C11 | 信号 0、`1/-1/84454` 全部 `unsafe-pid` | PASS |

### 7.3 重点复核项的具体数值

| 项 | 数值 | 判定 |
| --- | --- | --- |
| **C5 / C5b 自有组**（detached，`pgid===pid`） | 组信号 `-84890` ×1，`killedGroups=[84890]`，后代随组回收 | 允许 |
| **C5b 共享宿主组**（`pgid≠pid`） | `observedPgid=84428`、组信号 **0**、`killedGroups=[]`、按 pid 2 次（`84979/84978`）、宿主存活 | PASS（最高危项已收口） |
| **C2 按 pid / 按组** | 按 pid 1（owner 84487）、按组 1（`-84487`）；B 侧两项均 0 | PASS |
| **C3 崩溃后清扫** | legacy：`killed=0`、`missing=[84607]`；registry：`killedGroups=[84652]`、后代 84681 死亡、B 组 0；孤儿 CLI 可认领 | PASS |
| **C4b 加强版** | forged（同 exe 不同参数 + 同秒 startedAt）→ `matched=["startedAt"]`、`killed=0`、信号 0、canary 存活 | **PASS**（23:21 独立验证，非采信施工方） |

> C4b 转 PASS 的原因：D5 后 `commandMatches` 改为**完整命令行精确比较**，且归属证明要求「≥2 项证据且至少 1 项内容证据」；只有 `startedAt` 一项时判 `insufficient-proof`。

### 7.4 对抗对照（`npm run sabotage`）

| 坏实现 | 结果 |
| --- | --- |
| `sabotage:shared-registry` | **RED**：`9 failed / 3 passed`（C2、C3、C4、C5、C6、C7、C9、C10、C11） |
| `sabotage:bare-pid` | **RED**：`8 failed / 4 passed`（C2、C3、C4、C5、C6、C7、C9、C11） |
| `sabotage:group-wide` | **RED**：`5 failed / 7 passed`（C3、C4、**C5b**、C6、C11） |

三个坏实现仍全部变红，测试台未退化（23:22 复跑，与 23:16 结果一致）。

补充：`npm run test:hardening`（C4b）在 23:21 独立复跑 **PASS**（`matched=["startedAt"]`、`killed=0`、canary 86597 存活）；`npm run test:attack`（C12/C13）在 23:21 复跑仍 **2/2 FAIL**（证据见 7.5）。

### 7.5 新增攻击面契约（本次新增 2 条，实测为红）

D5 的自注册文件是新的信任边界：`runtime.reconcileOnStartup` 会**遍历注册目录中的所有 `*.json`**，把记录字段直接喂给 `killRegistered`，没有真实性校验。因此新增：

| 编号 | 条款 | 判定方式 | 现状 | 实测证据 |
| --- | --- | --- | --- | --- |
| **C12** | 伪造的自注册记录不得导致任何 kill | 伪造记录 → 恢复路径 → kill 计数 = 0 | **FAIL** | 第三方仅凭 `ps` 可读的 `pid/pgid/startedAt/command` 写文件；`readProcRegistryRecord` 直接信任 → `killed=1`、组信号 `-86524 SIGTERM`、canary 死亡 |
| **C13** | 注册目录必须属主独占（0700），不得复用抢注目录 | `stat` 目录/shim 权限 | **FAIL** | 预创建 `0777` 目录后 `ensureCodexSupervisorScript` 照常复用：`dirMode=777`、`shimMode=755`（组/其他可写目录 = true） |

> 说明：C12/C13 属于**模拟攻击者**（写文件/抢注目录，进程与信号均为真实），与第 1–4 章的真实运行数据分开标注。它们不代表并发回收逻辑有回归，而是 D5 引入的新信任边界缺口。

**未覆盖面**：组号竞态（`proveOwnership` 通过后到 `kill(-pgid)` 之间的 TOCTOU）需要精准 PID 复用才能确定性复现，本次未做；`kill(-pgid)` 失败后回退单 pid 的路径同理。建议 D5 在组杀前用同一份实时快照复核 `current.pgid === identity.pid`，并避免回退到裸 pid。

### 7.6 结论：「误杀是否已可判定为消除」

- **并发/取消/崩溃/PID 复用这些自发性误杀路径：已消除**。12 条契约全绿，C5b 证明共享宿主组不会整组回收，C3 证明崩溃后可按新机制认领孤儿且不波及 B，C4b 证明归属证据不再退化。
- **但「误杀」尚未总体消除**：C12 证明一份伪造的自注册文件就能驱动 runtime 误杀任意可观测进程（实测 canary 被 `-pgid` SIGTERM 杀死）；C13 证明注册目录可被抢注且不校验属主/权限。这两条属于本地攻击面，若不修复，「误杀」仍可被外部触发。
- **建议的最小修复**：注册目录 0700 + 拒绝非本人/已存在的宽松目录；记录增加不可伪造的绑定（如应用实例随机 nonce 写入 shim 与记录、启动时校验 `shimPid` 存活与文件属主）；恢复时只处理能映射到当前 DB 中已知 turn/marker 的记录，而不是遍历目录全信。

---

## 8. D5 修复后复跑（2026-11-04 23:48–23:56 CST）

施工方称 C12/C13 已修复（注册记录加 nonce + HMAC-SHA256、目录按 uid 隔离并强制 0700、只认 DB 已知 marker、回收后记录失效）。本章为**独立复跑 + 主动攻击**，第 1–7 章旧快照全部保留。

### 8.1 本次结果对应的实现（hash 校验）

| 文件 | SHA-256 | mtime |
| --- | --- | --- |
| `src/main/agent/runtime/process/reaper.ts` | `0795874c294c68025040fa8842c52172bc675c74cafd5cba100329b4c52bf37e` | 23:42:43 |
| `src/main/agent/runtime/runtime.ts` | `252f2612692ec7f96465c42233e93704312129d0fed2f94658126f62ae5a5d89` | 23:31:44 |
| `src/main/shared/process-supervisor.ts` | `051816fe6c13c9786dc19153727e298d19788d103b8ef0d64ad5cdc2cf7f3e2d` | 23:30:00 |

> 跑完再次校验 hash 未变化。测试全部在独立 `mkdtemp` 目录内运行；`os.tmpdir()` 被重定向到该目录，因此注册目录与安装密钥都不会碰到开发机真实文件（macOS 上 `os.tmpdir()` 是 `/var/folders/...`，不是 `/tmp`）。

### 8.2 全套 12 条契约 + C4b + sabotage

- **12/12 PASS**（23:48:51–23:49:06，14.6s；证据 `.artifacts/evidence-current-19340.jsonl`）。关键数值：C2 `killedGroups=[19373]`、B pid/组信号 0；C3 legacy `missing=[19501]`、无自注册文件孤儿仍不可认领；C3 registry `killedGroups=[19547]`、后代 19590 死、B 组 0；C4 三例 `insufficient-proof`；C5 `-19788` 唯一组信号；**C5b `observedPgid=19335`、组信号 0**；C6 `19950:insufficient-proof`；C7 short 19981 信号 0；C9 `-20122/-20126`；C10 turn2 回收 20303；C11 `1/self/-1` 全部 `unsafe-pid`。
- **C4b 加强版 PASS**（23:49:06；`matched=["startedAt"]`、`killed=0`、canary 20475 存活）。
- **sabotage 3/3 全红**（23:54 复跑）：shared-registry 9 failed / 3 passed；bare-pid 8 failed / 4 passed；group-wide 5 failed / 7 passed。

### 8.3 C12 / C13 原用例复跑 + 扩展攻击矩阵

证据 `.artifacts/evidence-current-24129.jsonl`（23:55）。所有变体均真实驱动 reaper 与真实 canary 进程。

| 变体 | 构造 | 验签结果 | kill 计数 | canary | 结论 |
| --- | --- | --- | --- | --- | --- |
| C12 无签名伪造 | 字段与 `ps` 完全一致，但无 `sig` | `verifyFile=false` | 0 | 存活 | **PASS**（攻击被挡） |
| C12 symlink | 记录路径指向另一普通文件 | `false` | 0 | 存活 | PASS |
| C12 权限过宽 | 合法签名 + 文件 0644 | `false` | 0 | 存活 | PASS |
| C12 字段篡改 | 先签名后改 `command` | `false` | 0 | 存活 | PASS |
| C12 重放陈旧身份 | 合法签名 + `startedAt=1970` | `true` | 0（`unresolved=command`） | 存活 | PASS（归属证据挡下） |
| C12 未知 marker | 合法签名 + 不在 DB 的 marker | `true` | 0（门控跳过） | 存活 | PASS（门控是唯一阻挡项，测试模拟 `isKnownMarker`） |
| C13 0777 目录 | 预创建 world-writable 后写 shim | — | — | — | **PASS**：`dirMode=700`、`shimMode=700` |
| C13 目录 symlink | 注册目录本身是 symlink | — | — | — | PASS（抛出拒绝） |
| C13 密钥 symlink | 密钥文件是 symlink | — | — | — | PASS（抛出拒绝） |
| C13 密钥 0644 | 密钥文件权限过宽 | — | — | — | PASS（抛出拒绝） |
| **C13b shim 同名 symlink** | 0700 目录内预置 `codex-supervisor.cjs -> victim` | — | — | — | **FAIL**：`victimOverwritten=true`、shim 仍是 symlink（同 uid 残余面） |

> C13b 说明：`ensureCodexSupervisorScript` 的 `writeFileSync` 会顺着已存在的同名 symlink 覆盖受害文件。目录 0700 + 文件属主校验只防**其他 uid**；能进这个目录的必然是同 uid，因此属**同 uid 威胁模型内**，不构成跨用户权限提升，但「目录内同名文件可被预置」这一面未被治理。

### 8.4 同 uid 密钥可读：C14 / C14b（主动攻击结论）

| 场景 | 实测 | 结论 |
| --- | --- | --- |
| **C14** 同 uid 读取 `0600` 安装密钥 → 用真实 `ps` 字段铸造合法记录 → 命中非孤儿 canary | `secretMode=600`、`secretOwner=501`、`secretReadBySameUid=true`、`verifyFile=true`、`killed=1`、组信号 `-24238 SIGTERM`、canary 死亡 | **可以伪造** |
| **C14b** 密钥文件被同名 `0600` 文件替换为攻击者已知值 | `getRegistrySecret()` 直接返回攻击者值、`verifyFile=true`、`killed=1`、组信号 `-24310`、canary 死亡 | **可以伪造** |

**威胁模型表述建议**（必须写进架构文档，不能声称「绝对不可伪造」）：

> 注册记录的 HMAC 用于**跨用户/跨会话隔离**：其他 uid 无法读取 0600 密钥，也无法在 0700 目录内写记录。**同 uid 攻击者本来就能直接 `kill` 同 uid 进程**，读取同一密钥后伪造记录不构成权限提升；因此承诺应表述为「在跨用户威胁模型下不可伪造、不可重放」，而不是「任何情况下都不可伪造」。若要防同 uid，需要引入进程外可信执行（如系统钥匙串 + 仅本应用可解的 ACL、或内核级 attestation），超出当前 HMAC 方案能力。

### 8.5 孤儿门：C15

真实构造：`orphan-parent.mjs` spawn 一个 detached 探针后立即退出，探针 `ppid=1`（launchd 收养）。

| 输入 | kill | 结果 |
| --- | --- | --- |
| unsigned + `command` 篡改（仅 `startedAt` 一项证据） | 0 | 存活 → 正确挡下 |
| unsigned + `startedAt` 篡改（仅 `command` 一项证据） | 0 | 存活 → 正确挡下 |
| unsigned + 完全真实的 `startedAt`+`command` | 1（`killedGroups=[24394]`） | 死亡 → **这是设计内放行** |

结论：孤儿门不会因为 `ppid===1` 就无条件放行，仍要求 ≥2 项证据且至少 1 项内容证据；但「完全真实的 unsigned 孤儿」会被回收（恢复承诺的本来意图）。风险点是**任何能调用 `killRegistered` 并拿到真实 `ps` 字段的调用方**都能借此回收孤儿；生产路径里 DB 行会先铸签名，unsigned 主要留给旧数据/legacy。

### 8.6 竞态：C16a–C16d

| 场景 | 关键数值 | 结论 |
| --- | --- | --- |
| C16a 归属证明通过后目标自行退出（注入 `list` 制造确定性窗口，已标注 simulated） | `killed=0`、`missing=[65535]`、`killedGroups=[]` | **不把空结果当成功** |
| C16b 组长先死、组员存活（真实进程） | `killed=0`、`missing=[24567]`、`signalsToLong=[]`、`longAlive=true` | 不对 `-pgid` 补刀，存活组员不受影响 |
| C16c 记录删除与扫描并发 | `listedBeforeDelete=1`、`verifiedAfterDelete=false`、`kills=0`、canary 存活 | 验签失败即跳过 |
| C16d 重复 kill（同一签名身份第二次） | 第一次 `killed=1`（`-24628`）；第二次 `killed=0`、信号 `[]`、`missing=[24628]` | 无重复 kill |

### 8.7 通过 / 失败清单

| 套件 | 结果 |
| --- | --- |
| C1–C11 + C5b（12 条） | **12/12 PASS** |
| C4b（加强版归属证据） | **PASS** |
| C12（无签名 / symlink / 0644 / 篡改 / 重放 / 未知 marker） | **6/6 PASS**（攻击全部被挡） |
| C13（0777 收紧 / 目录 symlink / 密钥 symlink / 密钥 0644 / 0600 可读） | **PASS** |
| C13b（shim 同名 symlink 抢占） | **FAIL（同 uid 残余面）** |
| C14 / C14b（同 uid 读密钥 / 替换密钥后伪造） | **PASS（攻击成功，记录事实）** |
| C15（孤儿门） | **PASS** |
| C16a–C16d（竞态） | **4/4 PASS** |
| sabotage 三坏实现 | **3/3 RED** |

### 8.8 结论：「跨会话误杀是否可判定为消除」

- **在「同 uid 可信、其他本地用户不可信」的威胁模型下：可以判定为消除。** 12 条契约 + C4b 全绿；C12 的六类伪造/篡改/重放全部 kill=0；C13 的目录/密钥抢占被收紧/拒绝；C15/C16 证明孤儿门与竞态都不会产生「空结果当成功」或重复 kill。
- **不能声称「绝对消除 / 绝对不可伪造」。** C14/C14b 证明同 uid 攻击者读取 0600 密钥即可铸造合法记录并触发整组回收（实测 canary 被 `-pgid` SIGTERM 杀死）；C13b 证明 0700 目录内的同名 shim symlink 会被顺链覆盖。这两条都在同 uid 威胁模型内，而该模型下攻击者本可直接 `kill` 同 uid 进程，**不构成权限提升**。
- 一句话口径：**跨会话自发性误杀（并发/取消/崩溃重启/PID 复用）已消除；对「同 uid 恶意进程」不承诺防伪造，对「其他 uid」承诺不可伪造。** 若验收要求防同 uid，则当前方案（用户态 HMAC + 0600 文件）不达标，需要系统级密钥/ACL 或内核 attestation。

> 注：以上是 23:55 快照。C13b 已在 00:02 修复（`writeFileNoFollow`），复跑结果见 §9.4；§8 保留原快照不改。

---

## 9. 复核补测：跨 uid 实测可行性 + C13b 修复复跑 + C17 异常退出（2026-11-05 00:05–00:11 CST）

本章回应文档复核暴露的两个「尚未实测」承诺，并并入施工方 C13b 修复的复跑。

### 9.1 本次结果对应的实现（hash 校验）

| 文件 | SHA-256 | mtime |
| --- | --- | --- |
| `src/main/agent/runtime/process/reaper.ts` | `3a018c186d69328e8f88866304b38953458e026f8a4b1c9d3c2f3c8f1f0b786b` | 2026-11-04 23:59:58 |
| `src/main/agent/runtime/runtime.ts` | `252f2612692ec7f96465c42233e93704312129d0fed2f94658126f62ae5a5d89` | 2026-11-04 23:31:44 |
| `src/main/shared/process-supervisor.ts` | `3d6e38ebec6252d258a0e58559d4bf2c1543fc990b1f4bc9277f2969715056a5` | 2026-11-05 00:02:34 |

> 跑完再次校验 hash 未变化。C17 使用真实 `AgentRuntime` + 真实 `better-sqlite3`（`:memory:`，通过 `spikes/agent-core` 的 Node-ABI 副本），driver 内真实 spawn 探针进程树并调用公开的 `context.registerProcess`；除 B 会话用「阻塞 driver」模拟并发外，无 mock 状态字段。

### 9.2 跨 uid 不可伪造：本次**不可实测**（不假装跑过）

环境探测（2026-11-05 00:10）：

| 探测项 | 结果 |
| --- | --- |
| 当前身份 | `uid=501(user=zhumingchen)` |
| 第二本地用户 `nobody` | 存在：`uid=4294967294(nobody)` |
| 第二本地用户 `daemon` | 存在：`uid=1(daemon)` |
| `sudo -n -u nobody id` | **失败**：`sudo: a password is required` |
| `su nobody -c id` | **失败**：`su: Sorry`（当前非 root，无免密切换） |
| `sudo -n -l` | **失败**：需要密码 |

结论：**本机存在第二 uid，但当前会话没有免密提权/切换手段，无法真实以第二 uid 发起攻击。** 因此「跨用户不可伪造」本次**未实测**，不能写成已验证。

该承诺精确依赖以下 OS 权限语义（建议按此验证）：

1. **文件属主**：`secret` 与注册目录/记录文件的所有者必须是应用运行 uid；`getRegistrySecret` / `verifyProcRegistryFile` / `ensureRegistryDir` 均比较 `stat.uid === process.getuid()`。
2. **密钥 0600**：`mode & 0o077 === 0`，且不得是 symlink；否则 `getRegistrySecret` 抛错，reaper 退化为 `unsigned`。
3. **目录 0700 且属主当前用户**：`ensureRegistryDir` 对已存在目录校验 `isDirectory` + 非 symlink + owner + `chmod 0700`；属主不符直接抛错。
4. **记录文件 0600 + 普通文件 + 非 symlink + 属主当前用户**，并用密钥验 HMAC；任一不满足 → `verifyProcRegistryFile=false`，`reconcileOnStartup` 跳过（不 kill）。
5. **信号权限**：跨 uid `kill` 返回 `EPERM`；应用只能回收本 uid 进程。
6. **管理员/root 不在威胁模型内**：root 或经密码授权的 sudo 可读取 0600，这是 OS 定义，不属于「普通跨用户」攻击。

建议的真实第二 uid 验证方式（任一即可）：

- 测试环境配 `sudoers` 的 `NOPASSWD: ALL` 给攻击用户，脚本以 `sudo -n -u attacker` 执行；
- 用 root 创建 `LaunchDaemon` 并设置 `UserName=attacker` 启动攻击脚本；
- 在 CI 中建两个系统用户（app 用户 + attacker 用户），用 `su`/容器 user namespace 切换；
- 若以上都不可用，至少在文档中保留「设计依赖 OS DAC，未实测」的限定语。

逐项预期（供第二 uid 环境直接判定，errno 以 POSIX 为准）：

| 攻击动作 | 预期 | errno |
| --- | --- | --- |
| `open(secret, O_RDONLY)` | 拒绝 | `EACCES (13)` |
| `opendir(registryDir)` / `readdir` | 拒绝 | `EACCES (13)` |
| `open(record, O_RDONLY)` | 拒绝 | `EACCES (13)` |
| `open(dir/.tmp, O_CREAT\|O_WRONLY)` | 拒绝 | `EACCES (13)` |
| `symlink(victim, dir/shim)` | 拒绝（目录 0700 不可写） | `EACCES (13)` |
| `kill(appPid, SIGTERM)` | 拒绝 | `EPERM (1)` |
| 伪造记录后触发 reconcile | 验签失败/无法写入 → kill=0 | — |

> 文档措辞建议：把「跨用户不可伪造」改为「**在普通本地用户（不含 root/管理员）威胁模型下，依赖 0600/0700 与 HMAC 阻止跨 uid 伪造；该结论本次未用第二 uid 实测**」。不要与已实测的 C13（权限位）混为一谈。

### 9.3 C17 异常退出路径回收（新契约）

**条款**：driver 抛错 / SDK 初始化失败 / 授权失败等异常退出，必须回收本轮已登记句柄与其进程组，且不得波及另一会话；正常完成（未抛错）不得触发回收。

**判定**：异常退出后本轮登记进程存活数应为 0；对 B 会话 pid/组信号数应为 0；`residual_risk`/`recovery_note` 与实际残留一致。

| 用例 | 关键数值 | 结论 |
| --- | --- | --- |
| **C17-a** driver spawn 后抛错 | A owner 41759 死、A.long 41760 死；A 信号 `-41759 SIGTERM`；B owner 41743 / B.long 41744 **存活**、B 信号 `[]`；`residualRisk=none`、`recoveryNote=null`、`recoveryKills=0` | **PASS**：本轮全部回收，B 零信号零影响 |
| **C17-b** 授权失败（未 spawn） | 存活数 0、kill 0；`residualRisk=unconfirmed`、`recoveryNote="turn failed reclaim: killed=0 unresolved=- missing=- residualRisk=unconfirmed"` | **PASS**：无句柄可回收，按 §6.5 如实标 unconfirmed |
| **C17-c** 正常完成（反向对照） | 信号 `[]`；owner 41919 / long 41920 **均存活**；`residualRisk=none`、`recoveryNote=null` | **PASS**：正常完成只 forget，不 reap |

**观察项（非契约失败）**：C17-a 实际 `killed=1`，但 `recoveryKills=0` 且 `recoveryNote=null`——因为 `classifyResidual(report, true)` 在 `discovered>0` 且无 unresolved/stillAlive 时返回 `none`，而只有非 `none` 才写 recovery。残留判定是如实的（确实无残留），但「本次回收动作」没有审计记录。建议：若验收要求可追溯，增加独立 audit 事件或在 note 中记录 kills；不影响 C17 的隔离结论。

### 9.4 C13b 修复复跑 + 自加变体

施工方改为 `writeFileNoFollow`：symlink 只删链接不动目标；临时文件 `O_CREAT|O_EXCL|O_NOFOLLOW` + `fchmod`；`rename` 前二次 `lstat`；已存在普通文件仅在「属主当前用户 + 权限不宽于 600/700 + 内容一致」时幂等复用。

证据 `.artifacts/evidence-current-41092.jsonl`（00:06:53）：

| 变体 | 受害者 | shim 终态 | 结论 |
| --- | --- | --- | --- |
| symlink → 普通文件 | 内容不变（`victimOverwritten=false`，mode 600） | 真实普通文件，mode **700**，内容为 shim | **PASS** |
| symlink → 只读文件 0444 | 内容不变、mode 仍 444 | 真实普通文件 700 | **PASS** |
| symlink → 目录 | `victimStillDir=true` | 真实普通文件 700 | **PASS** |
| 硬链接（同 inode，内容不同） | 内容不变；`hardLinkRefused=true`（安全拒绝） | 移除硬链后重建为 700 | **PASS** |
| 并发两次创建（前置 symlink） | 内容不变 | `fulfilled=2 / rejected=0`，最终 700 | **PASS** |
| rename 窗口内目标被持续替换为 symlink | 内容不变 | refusals=0，最终 700 | **PASS** |

> C13b 由上一轮的 FAIL **转为 PASS**。仍属「同 uid 可写目录内」的防护；同 uid 攻击者本可篡改，故不承诺防同 uid。

### 9.5 全量复跑与对抗对照（本次代码）

| 套件 | 结果 | 时间 |
| --- | --- | --- |
| C1–C11 + C5b | **12/12 PASS**（C2 killedGroups `[42003]`、B 信号 0；C5b `observedPgid=41965`、组信号 0；C9 `-42720/-42724`） | 00:07:22–00:07:37 |
| C4b | **PASS**（`matched=["startedAt"]`） | 00:07:37 |
| C12（6 类） | **6/6 PASS** | 00:06:52 |
| C13 | **PASS**（`dirMode=700`、`shimMode=700`，symlink/0644 均拒绝） | 00:06:53 |
| C13b（6 变体） | **PASS** | 00:06:53 |
| C14 / C14b（同 uid 伪造） | **攻击成功**（`killed=1`、`-41204/-41296 SIGTERM`、canary 死） | 00:06:54 |
| C15 孤儿门 | **PASS**（篡改 2 例 kill=0 存活；真实 unsigned 孤儿 kill=1） | 00:06:56 |
| C16a–d 竞态 | **4/4 PASS** | 00:06:5x |
| C17a–c 异常退出 | **3/3 PASS** | 00:07:13 |
| sabotage 三坏实现 | **3/3 RED**（shared-registry 9 failed、bare-pid 8 failed、group-wide 5 failed） | 00:08 复跑 |

### 9.6 结论与文档措辞

- **C17：异常退出回收可判定为 PASS**：本轮进程与进程组全部回收（存活 0），B 会话零信号零影响；反向对照证明正常完成不 reap。
- **C13b：修复有效，PASS**；六类抢占变体受害者内容均不变、shim 终态真实普通文件 0700。
- **跨 uid：仍未实测**。只有权限位层面的 C13 实测；「跨用户不可伪造」应标注为设计承诺/未实测，直到用第二 uid 跑一次 §9.2 的表格。
- **一句话口径**：在「同 uid 可信、root/管理员除外」的威胁模型下，跨会话误杀（含异常退出路径）可判定为消除；跨 uid 不可伪造为设计承诺、本次未实测；同 uid 不承诺防伪造（C14/C14b 实测可伪造）。

