# CI 基线报告（2026-11-13）

> 用途：Stage 1 · FR-S1-06「CI 单测门禁化」的施工前置基线。
> 结论先行：**本地三项门禁全绿，可以进入「删 `continue-on-error`」的候选流程；但 Linux runner 差异尚未验证，且 `gh` 未登录，无法触发/读取远端运行。**
>
> **⚠️ 17:30 补测后本条结论已被部分推翻**：`gh` 已登录，远端 CI **跑过且现在仍在跑**；Linux 上的 `unit` job **确实是红的**（首轮 3 个失败 → 现仅剩 1 个）。详见第七节。原文保留以留存修订痕迹。

---

## 一、环境与命令

| 项 | 值 |
|---|---|
| 宿主 | macOS（darwin），Node 22（本地），仓库 HEAD `4b0541b` |
| 分支状态 | `main` 领先 `origin/main` **6 个提交**（`git rev-list --left-right --count` → `0 6`）；最后 fetch 2026-11-13 16:00 |
| 环境处理 | `env -u NODE_OPTIONS -u BASH_ENV`（剥离宿主沙箱 shim，见项目长期约定） |
| lint | `npm run lint` → `npx tsc --noEmit` → `npm run verify:blueprint` |
| unit | `npx vitest run --reporter=default --reporter=json --outputFile.json=/tmp/vitest-baseline.json --maxWorkers=4` |

---

## 二、结果

### 2.1 lint job（三项硬门禁）

| 检查 | 结果 |
|---|---|
| eslint（`--max-warnings 0`） | **通过**，零告警 |
| `tsc --noEmit` | **通过**，零错误 |
| `verify:blueprint` | **13 通过 / 0 失败** |

蓝图断言明细（全部 PASS）：编号唯一性 111 条、计数等式（108+3+5+0=116 / 116+23=139 / 155−16）、旧数字零残留、schema 版本 50 与 `database.ts` 一致、行数声明 5996=实测、278 个文件引用可解析、39 个提交号可解析、I.0 决策前置齐、I.10 指向 code-issues 存在、状态词口径、I.2 表格结构。

### 2.2 unit job（全量单测）

| 指标 | 实测 |
|---|---|
| 测试文件 | **386 通过 / 7 整文件 skip（共 393）** |
| 用例 | **4611 通过 / 63 skip / 0 失败（共 4674）** |
| 耗时 | 26.66s（transform 3.90s / import 15.00s / tests 56.12s / env 11.26s） |
| 退出码 | 0 |
| worker 启动超时 | **0**（此前记录的「20 个 renderer 文件起不来」本轮未复现；剥离 shim + `--maxWorkers=4` 后消失） |

skip 的 7 个文件均为显式门控：迁移降级（p4/p7 各 1）、真机适配器（codex-app-server-real 4 / opencode-serve-real 4）、进程监督（4）、沙箱 harness（7）/ launch（3）。属于「宿主不具备条件」的既定 skip，不是掩盖失败。

---

## 三、与 `ci.yml` 注释的偏差（需修文档）

`ci.yml` 的 unit job 注释写着（2026-11-12 基线）：

```
384 文件（379 通过 / 5 整文件 skip）；4563 例（4517 通过 / 46 skip / 0 失败）
```

实测已是 **393 文件（386 / 7）、4674 例（4611 / 63 / 0）**。差 9 个文件、111 个用例。**注释陈旧本身会误导后续判断**（例如误以为 skip 从 5 涨到 7 是回归），属 FR-06 的必改动作之一。

---

## 四、尚未验证的部分（不得当作已通过）

| 项 | 状态 | 风险 |
|---|---|---|
| Linux runner 上的 unit | **未验证** | `sharp` 解析、Electron 二进制、`ps` 类用例、路径语义都可能只在 Linux 暴露 |
| `platform-paths`（Windows 真实 NTFS） | 未验证 | 需 Windows 宿主，本地无法替代 |
| `build` 六矩阵 | 未验证 | 打包与 asarUnpack 相关 |
| `e2e`（浏览器版） | 未跑本轮 | 与单测无关；上一轮记录为 28/28 |
| Actions 触发/读取 | **不可用** | `gh` 未登录（提示 `gh auth login`），无法 `workflow_dispatch` 或读运行记录 |

---

## 五、结论与动作

**结论**：本地基线为**绿**，且是干净绿（0 失败、0 负载型 worker 超时）。这满足删 `continue-on-error` 的**本地前置条件**，但不满足 E3 的「远端首轮全绿」。

**FR-06 的施工顺序（据基线修正）**：

1. 更新 `ci.yml` 注释中的基数（393 / 386 / 7；4674 / 4611 / 63），避免后续误判（0.5d）
2. `gh auth login` 后 `workflow_dispatch` 跑一次当前 main；**不要**先删 `continue-on-error`
3. 按 Linux 首轮结果三分类（真红 / 环境红 / 负载红）；真红修完再删开关
4. 删除开关的 PR 附远端绿链接，同时把 `maxWorkers=4` 的理由从「本地经验」改为「远端实测」

**若 `gh` 长期不可用**：E3 改为「本地全量绿 + 一条 Linux 容器复跑记录」，并在 Stage 2 补远端门禁——但这会让「门禁有效」这条退出条件降级，需你确认是否接受。

---

## 六、可复现命令

```bash
cd /Users/zhumingchen/tiangong
npm run lint && npx tsc --noEmit && npm run verify:blueprint
env -u NODE_OPTIONS -u BASH_ENV npx vitest run --maxWorkers=4 \
  --reporter=default --reporter=json --outputFile.json=/tmp/vitest-baseline.json
```

---

## 七、远端补测（2026-11-13 17:30，gh 登录后）

### 7.1 三处被推翻的结论

| 原结论 | 实测 | 影响 |
|---|---|---|
| 「CI 从未真跑过」 | **错**。11-12 的 run `43239843441` 就跑过，且整体 `conclusion=success` | 原判断基于 `gh` 不可用，属推断 |
| 「远端全绿」 | **错**。该 run 的 `unit` job 实为 `failure`，被 `continue-on-error: true` 吞成绿灯 | **这正是 FR-06 要解决的那个洞，现在有实证了** |
| 「本地绿 → 远端大概也绿」 | **错**。本地 393 文件 0 失败，Linux 上 `unit` 首轮 3 文件失败 | 平台差异真实存在，本地绿不能替代 |

### 7.2 Linux `unit` 失败三分类（首轮 11-12 / 复测 11-13）

| 用例 | 首轮 | 复测 | 根因 | 分类 |
|---|---|---|---|---|
| `database-migration.test.ts` | FAIL | **pass** | `beforeAll` 里 `initDatabase()` **Hook 超时 10s** → 25 例全 skip | 负载红（已被这 6 个提交解决） |
| `approval-gateway.test.ts` | FAIL | **pass** | 期望 `rule=gitdir-write-block`，实得 `gitdir-probe-failed`（Linux 探测失败走兜底，仍 deny） | 真红→已修 |
| `bash-readonly.test.ts` | FAIL | **仍 FAIL** | `git whatchanged -1 --format=%G?` 在 ubuntu-latest 上**不触发** gpg，而测试复用了 `log` 的能力断言 | **测试假设错**（非产品缺陷） |

复测 run `43401897405`（HEAD `4b0541b`）实测：`unit` = **1 failed / 386 passed / 6 skipped（共 393）**，仅剩上表第 3 项；`lint` / `platform-paths` / `e2e (ubuntu-latest)` / `build` 均 success。

### 7.3 第 3 项的修法（已改，待远端复验）

`bash-readonly.test.ts` 的 `GpgExecCapability` 原先把 `show` / `whatchanged` 都标成 `kind: 'log'`（「走同一条 format 路径」）。改为**逐命令探测**：新增 `show` / `whatchanged` 两个能力位，各跑一次真实 git 再断言。原则不变——「参数含 `%G` / `%(signature)` 必须 ask」仍然无条件断言，与 git 版本无关；只是「是否真调了 gpg」这一层改成按宿主实测解释。

### 7.4 FR-06 的施工顺序（据远端结果重排）

1. ✅ 更新 `ci.yml` 注释基数（本地 396 文件 / 4709 例，见下）
2. ✅ 远端首轮结果已拿到（7.2）
3. ⬜ 修掉第 3 项并推一次，确认 `unit` 全绿（**这一步才有资格删开关**）
4. ⬜ 删 `continue-on-error: true`，PR 附远端绿链接
5. ⬜ 把 `maxWorkers=4` 的理由从「本地经验」改成「远端实测」

### 7.5 本地复测（含 FR-S1-02 改动后）

396 文件（389 通过 / 7 skip）、4709 例（4646 通过 / 63 skip / **0 失败**）、26.24s、退出码 0。相比原基线 +3 文件 / +35 例，全部来自本次新增测试。
