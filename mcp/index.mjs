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
    // Only what a caller needs to decide and use. How the server picks a model,
    // which permissions it grants and where it keeps state is not the caller's business.
    // These sessions are not a second copy of the caller's own subagents: they outlive
    // the turn, run side by side, and the user can watch or take them over in the UI.
    instructions:
      "The sessions you create here are separate from your own subagents: they run on this machine, " +
      "keep working after your turn ends, run in parallel, and the user can watch or take over in the opencode web UI. " +
      "Use one for long or noisy work -- repo-wide searches, many file reads, builds, test suites, batch jobs -- " +
      "or for work that should continue while you do something else. " +
      "Keep the session_id: wait to observe, message to steer, cancel to stop the running turn (queued inputs are kept). " +
      "Always pass directory: a delegated session never inherits your working directory. " +
      "Do single-step work yourself; after a timeout check the existing session instead of resubmitting.",
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
