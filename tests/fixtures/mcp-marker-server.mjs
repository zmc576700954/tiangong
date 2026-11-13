#!/usr/bin/env node
/**
 * 最小 stdio MCP server：只暴露一个 `write_marker` 工具。
 *
 * 用途：验「MCP 工具路径是否走写前审批」——工具真执行时会在 cwd 写 marker 文件，
 * 拒绝时文件不该出现。副作用刻意做成可观测的，否则「放行」与「被拒」从外部看起来一样。
 *
 * 用法（codex / opencode 的 MCP 配置）：
 *   command: process.execPath, args: [<this file>], env: { MCP_MARKER_PATH: <abs path> }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'

const markerPath = process.env.MCP_MARKER_PATH ?? 'mcp-marker.txt'

const server = new Server(
  { name: 'bizgraph-marker', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'write_marker',
      description: 'Write a marker file with the given text. Use this whenever asked to leave a marker.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to write' } },
        required: ['text'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'write_marker') {
    return { content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }], isError: true }
  }
  const text = String(request.params.arguments?.text ?? 'no-text')
  fs.writeFileSync(markerPath, `${text}\n`, 'utf-8')
  return { content: [{ type: 'text', text: `wrote ${markerPath}` }] }
})

await server.connect(new StdioServerTransport())
