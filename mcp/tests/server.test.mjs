// Protocol-level smoke test: spawns the real stdio server and talks to it with the
// official client, while a fixture service stands in for opencode (via XDG_STATE_HOME).

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { startFixture } from "./fixture.mjs"

const entry = fileURLToPath(new URL("../index.mjs", import.meta.url))

test("stdio server exposes four tools and delegates through a discovered service", async () => {
  const fixture = await startFixture()
  const root = mkdtempSync(join(tmpdir(), "ocw-mcp-proto-"))
  const stateHome = join(root, "state")
  mkdirSync(join(stateHome, "opencode"), { recursive: true })
  writeFileSync(join(stateHome, "opencode", "service.json"), JSON.stringify({ url: fixture.url, password: "fixture", pid: 1 }))

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      OPENCODE_BIN: join(root, "no-such-opencode.exe"),
      OPENCODE_MCP_STATE_PATH: join(root, "tasks.json"),
      OPENCODE_MCP_DIRECTORY: process.cwd(),
    },
    stderr: "pipe",
  })

  const client = new Client({ name: "smoke", version: "0.0.0" })
  try {
    await client.connect(transport)

    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "opencode_delegate",
      "opencode_help",
      "opencode_models",
      "opencode_task",
    ])
    for (const tool of listed.tools) expect(tool.inputSchema.type).toBe("object")

    const models = await client.callTool({ name: "opencode_models", arguments: {} })
    expect(models.content[0].text).toContain("deepseek-v4.1-flash-free")

    const delegated = await client.callTool({
      name: "opencode_delegate",
      arguments: { task: "say pong", timeout_ms: 5_000 },
    })
    expect(delegated.isError).toBeFalsy()
    expect(delegated.structuredContent.state).toBe("done")
    expect(delegated.structuredContent.text).toBe("PONG.")

    const status = await client.callTool({
      name: "opencode_task",
      arguments: { action: "status", session_id: delegated.structuredContent.sessionID },
    })
    expect(status.structuredContent.state).toBe("done")

    const failed = await client.callTool({ name: "opencode_delegate", arguments: { task: "x", bogus: 1 } })
    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain("unexpected parameter")
  } finally {
    await client.close().catch(() => {})
    await fixture.close()
  }
}, 30_000)
