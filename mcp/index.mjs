#!/usr/bin/env node
// Stdio MCP server: delegates work to the local opencode background service and its
// free models. stdout carries the protocol; every diagnostic goes to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

import * as api from "./opencode.mjs"
import { createTools } from "./tools.mjs"
import { DelegationStore } from "./tasks.mjs"

const tools = createTools({
  api,
  store: new DelegationStore({ path: process.env.OPENCODE_MCP_STATE_PATH }),
})

const server = new Server(
  { name: "opencode-delegate", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Delegate work to the local opencode background service and its free models. " +
      "Start with opencode_delegate (mode=sync waits for the answer, async returns a task id); " +
      'manage with opencode_task action="list" | "status" | "wait" | "output" | "message" | "cancel". ' +
      "Free models: opencode_models. Help: opencode_help.",
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
console.error(`[opencode-delegate] ready (state ${process.env.OPENCODE_MCP_STATE_PATH ?? "default"})`)
