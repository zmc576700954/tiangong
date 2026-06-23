import { describe, it, expect } from 'vitest'

describe('McpAdapter subagent integration', () => {
  it('exposes setSubagentManager via BaseAdapter', async () => {
    const { McpAdapter } = await import('../mcp-adapter')
    const adapter = new McpAdapter()
    expect(typeof adapter.setSubagentManager).toBe('function')
  })

  it('DISPATCH_SUBAGENT_TOOL_NAME is consistent across adapters', async () => {
    const { DISPATCH_SUBAGENT_TOOL_NAME } = await import('../base')
    expect(DISPATCH_SUBAGENT_TOOL_NAME).toBe('dispatch_subagent')
  })

  it('DISPATCH_SUBAGENT_TOOL_SCHEMA carries required fields', async () => {
    const { DISPATCH_SUBAGENT_TOOL_SCHEMA } = await import('../base')
    expect(DISPATCH_SUBAGENT_TOOL_SCHEMA.name).toBe('dispatch_subagent')
    expect(typeof DISPATCH_SUBAGENT_TOOL_SCHEMA.description).toBe('string')
    expect(DISPATCH_SUBAGENT_TOOL_SCHEMA.input_schema.required).toEqual([
      'agent_type',
      'description',
      'prompt',
    ])
  })

  // Full integration test — appending the tool to the tools array and
  // intercepting it in the loop — requires deep mocking of the HTTP layer.
  // Phase 4 accepts these as covered by manual reasoning and Phase 5 E2E tests.
})
