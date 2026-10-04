# BizGraph 基座 v1 快速开始

> 5 分钟内跑通：画布 → 创建图/节点 → 启动 Agent 会话 → 运行内置 Recipe。

## 1. 安装

```bash
git clone <repo-url> bizgraph
cd bizgraph
npm install
```

## 2. 启动开发模式

```bash
npm run dev
```

> 默认监听 http://localhost:5173 。Electron 主进程会自动加载这个 URL。

启动成功后你会看到：
- 左侧：项目面板（含 **Recipes** 入口）
- 中央：思维导图画布
- 右侧：Agent 聊天面板

## 3. 创建第一个图

1. 左侧面板 → 顶部 `+` → 选择目录（建议先建一个空目录测试）
2. 双击画布空白处 → 创建 Module 节点
3. 双击 Module → 创建 Process / Feature 子节点

> 也可以 `文件 → 打开示例项目` → 选择 `examples/sample-react-app/` 直接加载预置图。

## 4. 启动第一个 Agent 会话

1. 选中一个 Feature 节点
2. 右侧 Agent 面板 → 选择适配器（Claude Code 推荐）
3. 输入任务 → 点发送

会话的输出会通过 `agent:onOutput` 事件实时回写到画布下方输出区。

## 5. 跑一个内置 Recipe

1. 左侧面板 → 顶部 **ChefHat** 图标 → 打开 Recipes
2. 在「内置」分组里点 `Refactor React Component`
3. 填入组件路径（相对项目根，例如 `src/App.tsx`）→ 点 Run
4. 等待 toast 提示「Recipe 完成」

每个 Recipe 都会通过 `SubagentManager.invoke(agentType='recipe:<id>')` 派发，
其行为与父代理的 `dispatch_subagent` 子代理一致 — 走相同的 scope guard + 写冲突串行化。

## 6. 加自定义 Recipe

把 YAML 文件放到以下任一目录，下次启动 BizGraph 时自动加载：

```
<userData>/recipes/*.yaml                       # 用户级（跨项目共享）
<projectRoot>/.bizgraph/recipes/*.yaml          # 项目级（覆盖用户级）
```

YAML schema 参考 [Recipe Schema](../src/shared/types/recipe.ts) 或
`src/main/resources/recipes/*.yaml` 的 3 个内置示例。

## 7. 验证基座健康

```bash
# 类型检查
npx tsc --noEmit

# 单元测试
npm run test

# Lint
npm run lint

# 生产构建（Windows）
npm run build:win
```

## 下一步

- 看 [Roadmap](./ROADMAP.md) 了解基座已完成项 + Phase D 远期清单
- 看 [Recipe 工作流说明](../../src/main/resources/recipes/) 学习内置 Recipe 用法
- 看 [边界与限制 (Boundaries)](../../.claude/CLAUDE.md#key-conventions) 了解 BizGraph 的设计哲学