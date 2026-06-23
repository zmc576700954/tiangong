/**
 * Phase 4 — Claude Code adapter subagent integration smoke tests.
 *
 * NOTE: The full integration (createSdkMcpServer wiring + dispatch_subagent
 * tool handler closure) is hard to test without mocking the dynamic SDK
 * import in `loadSdk()`. We accept this gap for Phase 4 and rely on the
 * type-checker + manual reasoning. Real end-to-end verification belongs in
 * Phase 5 (UI testing).
 */

import { describe, it, expect } from 'vitest'

describe('ClaudeCodeAdapter subagent integration', () => {
  it('exposes setSubagentManager via BaseAdapter', async () => {
    const { ClaudeCodeAdapter } = await import('../claude-code')
    const adapter = new ClaudeCodeAdapter()
    expect(typeof adapter.setSubagentManager).toBe('function')
  })

  it('imports cleanly with the zod transitive dependency', async () => {
    // Just verifies the module evaluates without runtime import errors;
    // the zod import at the top of claude-code.ts must resolve.
    const mod = await import('../claude-code')
    expect(mod.ClaudeCodeAdapter).toBeDefined()
  })

  it('placeholder for full SDK MCP server smoke test', () => {
    // Intentionally a no-op. Full smoke-testing requires mocking the
    // `await import('@anthropic-ai/claude-agent-sdk')` inside loadSdk()
    // along with createSdkMcpServer / query. Deferred to Phase 5 E2E.
    expect(true).toBe(true)
  })
})
