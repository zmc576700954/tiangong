# Phase D 多 Worktree 并行开发工作流

> 适用范围：Phase D 全部 11 个任务（19 个 session）

## 为什么需要多 Worktree

Phase D 各任务之间大多互不依赖（D1a / D2 / D3 / D4 / D6 / D8a / D9 / D11 之间无依赖），单一 worktree 会强制串行 — 完成一个再开下一个，浪费并行性。

每个 Phase D session 跑在**独立 worktree** 里：
- 不污染主 worktree 状态
- 多 session 同时进行（每个 Claude Desktop 实例一个 worktree）
- 各自独立 PR、独立 review、独立 merge

## 工作分支命名规范

```
claude/phase-d<id>-<short-name>
```

`<short-name>` 与 prompt 文件名一致。完整 ID → 短名映射：

| ID | 分支 | Worktree 路径 |
|----|------|--------------|
| D1a | `claude/phase-d1a-session-lifecycle` | `.claude/worktrees/phase-d1a` |
| D1b | `claude/phase-d1b-fallback-recovery` | `.claude/worktrees/phase-d1b` |
| D2  | `claude/phase-d2-floating-panel`    | `.claude/worktrees/phase-d2`  |
| D3  | `claude/phase-d3-wiki-coverage`     | `.claude/worktrees/phase-d3`  |
| D4  | `claude/phase-d4-mcp-health-panel`  | `.claude/worktrees/phase-d4`  |
| D5a | `claude/phase-d5a-recipe-dag-schema`| `.claude/worktrees/phase-d5a` |
| D5b | `claude/phase-d5b-recipe-dag-delegate` | `.claude/worktrees/phase-d5b` |
| D5c | `claude/phase-d5c-recipe-dag-viz`    | `.claude/worktrees/phase-d5c` |
| D6  | `claude/phase-d6-opentelemetry`     | `.claude/worktrees/phase-d6`  |
| D7a | `claude/phase-d7a-wiki-lint-fix-actions` | `.claude/worktrees/phase-d7a` |
| D7b | `claude/phase-d7b-writeback-rollback` | `.claude/worktrees/phase-d7b` |
| D8a | `claude/phase-d8a-canvas-tree-layout` | `.claude/worktrees/phase-d8a` |
| D8b | `claude/phase-d8b-canvas-force-layout` | `.claude/worktrees/phase-d8b` |
| D9  | `claude/phase-d9-a2a-protocol`      | `.claude/worktrees/phase-d9`  |
| D10a | `claude/phase-d10a-yjs-doc-sync`   | `.claude/worktrees/phase-d10a` |
| D10b | `claude/phase-d10b-yjs-awareness`  | `.claude/worktrees/phase-d10b` |
| D10c | `claude/phase-d10c-yjs-persistence`| `.claude/worktrees/phase-d10c` |
| D10d | `claude/phase-d10d-yjs-conflict`    | `.claude/worktrees/phase-d10d` |
| D11 | `claude/phase-d11-tauri-eval`       | `.claude/worktrees/phase-d11` |

## 创建 Worktree

在主仓库根目录运行（**不是** worktree 内部）：

```bash
git worktree add .claude/worktrees/phase-d<id> -b claude/phase-d<id>-<short-name> main
cd .claude/worktrees/phase-d<id>
npm install
```

**强制要求**：
- 每个 worktree 独立 `npm install`（`node_modules` 不能跨 worktree 共享或 symlink — Electron native 模块会破坏）
- 路径放 `.claude/worktrees/` 沿用项目约定
- 不要在主 worktree 用 `git checkout <branch>`（与 worktree 冲突）

## 并行安全规则

### 1. 不修改其他 worktree 的文件

所有命令路径以**当前 worktree 的 cwd 为基准**。绝对路径用 `${PWD}/src/main/...` 表达，不要引用其他 worktree 路径。

### 2. 不与主 worktree 共享 git 状态

每个 worktree 独立执行：
- `git status` / `git add` / `git commit` / `git push`
- 本 worktree 的 branch 与其他 worktree 完全隔离

### 3. Stash 共享警告（CLAUDE.md 已强调）

`git stash` 跨 worktree 共享栈。**禁止**裸 `git stash` / `git stash pop`。

```bash
# 正确姿势
git stash push -u -m "phase-d<id>-<unique-tag>"
SHA=$(git stash list --format='%H %gs' | grep "phase-d<id>-<unique-tag>" | awk '{print $1}')
# 恢复时
git stash apply $SHA
git stash drop
```

### 4. 分支隔离

本会话只：
- `git push origin claude/phase-d<id>-<short-name>`
- `gh pr create --base main`
- 绝不动其他分支（main / develop / 其他 phase-d 分支）

### 5. 端口冲突（D10 任务）

D10（Yjs WebSocket server）默认端口 1234。多 worktree 同时跑 `npm run dev`：

| 任务 | 推荐 dev 端口 |
|------|--------------|
| D10a | WebSocket: 1234 |
| D10b | WebSocket: 1235 |
| D10c | WebSocket: 1236 |
| D10d | WebSocket: 1237 |

启动参数（具体见各 prompt）：`WS_PORT=1234 npm run dev`。

### 6. 数据库冲突

每个 worktree 启动 dev 时用独立 `userData` 目录：

```bash
BIZGRAPH_USER_DATA_DIR=.claude/worktrees/phase-d<id>/.userdata npm run dev
```

或在 `electron-dev.json` 配 `userData` 路径（具体见各 prompt）。

## 完成清理

PR merge 到 main 后：

```bash
# 回到主仓库根
cd <主仓库根>

# 关闭该 worktree 的 dev server / 关闭 Claude Desktop session
# 然后清理
git worktree remove .claude/worktrees/phase-d<id> --force
git branch -d claude/phase-d<id>-<short-name>
```

## 禁止做法

- ❌ 在主 worktree 直接改 Phase D 任务代码
- ❌ 一个 worktree 跑 dev server 同时另一个 worktree 跑同一任务代码
- ❌ 把 Phase D 分支 merge 进非 main（只 merge 到 main）
- ❌ 用 `git cherry-pick` 把另一个 worktree 的 commit 搬过来
- ❌ 在多个 worktree 间 `npm link` / symlink `node_modules`
- ❌ 共享 `~/.config/bizgraph/` 内的数据库 / settings（除非用户明确知道）

## 推荐并行窗口

按依赖分组（详见 `PHASE_D_TASKS.md` 的「推荐执行顺序」）：

| 第一波（无依赖） | 第二波（依赖第一波） | 第三波（依赖第二波） |
|----------------|--------------------|--------------------|
| D1a, D2, D3, D4, D5a, D6, D7a, D7b, D8a, D9, D11 | D1b, D5b, D8b, D10a | D5c, D10b, D10c, D10d |

第一波全部互不阻塞，可同时开最多 11 个 Claude Desktop session + worktree。

## 与 session prompt 配合使用

每个 session prompt 顶部「会话元数据」已标注：
- **工作分支**：本任务分支名（与本指南一致）
- **依赖**：阻塞本任务的前置 ID（必须在主分支已合并）

session 开始前：
1. 读本指南（本文件）
2. 创建 worktree
3. 用 session prompt 作为首次输入
4. 跑 `npm install`
5. 实施

session 结束：
1. `git push origin <branch>`
2. `gh pr create --base main`
3. 等 PR merge
4. 按上面「完成清理」清理 worktree + 分支

## 更新本指南

如发现新约束 / 改进实践 → 改 `docs/base/WORKTREE_GUIDE.md` 并在 `PHASE_D_TASKS.md` 引用。