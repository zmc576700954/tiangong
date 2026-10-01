#!/usr/bin/env bash
# Open the D6 PR via the GitHub web URL (no auth required).
#
# After `git push` succeeds, this is the simplest way to create the PR.
# Run from the phase-d6 worktree:
#   cd /d/tiangong/.claude/worktrees/phase-d6
#   ./open-d6-pr.sh
#
# The script opens the GitHub "Create Pull Request" page with both base + head
# pre-filled and a draft title. Add the body below into the PR description.

set -e

BRANCH="claude/phase-d6-opentelemetry"
REPO="zmc576700954/tiangong"

# Pre-filled PR title + base/head
URL="https://github.com/${REPO}/compare/main...${BRANCH}?expand=1&title=feat(telemetry):+Phase+D6+%E2%80%94+OpenTelemetry+OTLP+export"

echo "Opening: $URL"
start "$URL" 2>/dev/null || open "$URL" 2>/dev/null || echo "Open this URL manually: $URL"

cat <<'PRBODY'

## Phase D6 — OpenTelemetry OTLP export

为 BizGraph 主进程添加 best-effort OTLP/HTTP trace 导出，默认 OFF（零开销），覆盖 Agent / Subagent / MCP / Recipe 关键事件。

### 改动
- `src/main/telemetry/index.ts` — `initTelemetry / shutdownTelemetry / withSpan / recordAdapterCall / startChildSpan`
- 5 instrumentation 接入点：
  - `agent-manager.ts` — `bizgraph.agent.start`, `bizgraph.agent.command`
  - `subagent-manager.ts` — `bizgraph.subagent.invoke`
  - `mcp/client.ts` — `bizgraph.mcp.connect`, `bizgraph.mcp.call`
  - `recipes/recipe-runner.ts` — `bizgraph.recipe.run`
  - `adapter-health-monitor.ts` — `bizgraph.adapter.call{service, success, response_time_ms}` 零时长 span
- `main/index.ts` — `initTelemetry()` 紧跟 `initDatabase()`，在 `before-quit` 调 `shutdownTelemetry()`
- `shared/types/agent.ts` + `settings.ts` — `settings.telemetry.{otlpEndpoint, serviceName, serviceVersion}`
- 测试：`src/main/telemetry/__tests__/index.test.ts` — 16 个 case

### 边界合规（CLAUDE.md "Boundaries with Agent CLI"）
- 不修改 Agent CLI 任何输入
- 任何 telemetry 失败一律静默吞掉
- MCP `callTool` span 不携带 args 内容（避免 PII + 不污染 OTLP KV-cache）

### 验证
- `npx tsc --noEmit` — 0 错误
- `npm run lint` — 0 警告
- `npx vitest run src/main/telemetry/__tests__/index.test.ts` — 16/16
- 关联模块回归（adapter-health-monitor / recipe-runner / mcp/client）— 48/48 全绿
- 全量 `vitest run`：2035/2062 通过；27 个 fail 全部是预先存在的 Windows sandbox 兼容性问题（与本 PR 无关，已 `git stash` 对比验证）

Refs: `docs/base/prompts/D6-opentelemetry.md`
Tracking: `docs/tasks/2026-10-01-d6.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PRBODY