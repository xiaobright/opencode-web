#!/usr/bin/env node
// Stdio MCP server: delegates work to the local opencode background service.
// stdout carries the protocol; every diagnostic goes to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

import * as api from "./opencode.mjs"
import { createTools } from "./tools.mjs"

const tools = createTools({ api })

const server = new Server(
  { name: "opencode-delegate", version: "0.2.0" },
  {
    capabilities: { tools: {} },
    // Only what a caller needs to use the server. How it picks a model, which
    // permissions it grants and where it keeps state is not the caller's business.
    instructions:
      "Run tasks on the local opencode service and talk to them like a subagent. " +
      'opencode_delegate { task, directory? } starts one and returns its answer, or its session id while running. ' +
      'opencode_session { action: status | wait | message | cancel, session_id } checks it, waits, sends follow-ups or stops it.',
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(tools).map(([name, tool]) => ({
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const tool = tools[name]
  if (!tool)
    return {
      content: [{ type: "text", text: `Error: unknown tool "${name}". Available: ${Object.keys(tools).join(", ")}.` }],
      isError: true,
    }

  try {
    const result = await tool.handler(args ?? {})
    return {
      content: [{ type: "text", text: result.text }],
      ...(result.structured ? { structuredContent: result.structured } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Tool-level failures are answers, not crashes: report them without a stack trace.
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error("[opencode-delegate] ready")
