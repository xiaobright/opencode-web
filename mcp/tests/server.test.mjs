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

function fixtureClient(fixture, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocw-mcp-proto-"))
  const stateHome = join(root, "state")
  mkdirSync(join(stateHome, "opencode"), { recursive: true })
  writeFileSync(join(stateHome, "opencode", "service.json"), JSON.stringify({ url: fixture.url, password: "fixture", pid: 1 }))

  const transport = new StdioClientTransport({
    command: "node",
    args: [entry],
    env: {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      OPENCODE_BIN: join(root, "no-such-opencode.exe"),
      OPENCODE_MCP_DIRECTORY: process.cwd(),
      OPENCODE_WEB_STATE_DIR: root,
      OPENCODE_MCP_MODEL: "",
      OPENCODE_MCP_WAIT_MS: "",
      ...env,
    },
    stderr: "pipe",
  })

  const client = new Client({ name: "smoke", version: "0.0.0" })
  return { client, transport }
}

async function call(client, input) {
  const result = await client.callTool(input)
  if (result.isError || !result.structuredContent) throw new Error('MCP call failed: ' + JSON.stringify(result))
  return result
}

test("stdio server exposes two tools and delegates through a discovered service", async () => {
  // A dropped prompt response is retried with the same input id; a dropped create response
  // is not retried, because the service mints those ids.
  const fixture = await startFixture({ dropResponses: { prompt: 1 } })
  const { client, transport } = fixtureClient(fixture)
  try {
    await client.connect(transport)

    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["opencode_delegate", "opencode_session"])
    for (const tool of listed.tools) expect(tool.inputSchema.type).toBe("object")

    const delegated = await call(client, { name: "opencode_delegate", arguments: { task: "say pong" } })
    expect(delegated.isError).toBeFalsy()
    expect(delegated.structuredContent.state).toBe("done")
    expect(delegated.structuredContent.text).toBe("PONG.")
    expect(delegated.structuredContent.input_status).toBe("settled")
    expect(delegated.structuredContent.input_id).toStartWith("msg_")
    expect(fixture.state.created).toBe(1)
    expect(fixture.state.prompts).toBe(1)
    const sessionID = delegated.structuredContent.session_id

    const status = await call(client, { name: "opencode_session", arguments: { action: "status", session_id: sessionID } })
    expect(status.structuredContent.state).toBe("done")

    const followUp = await call(client, {
      name: "opencode_session",
      arguments: { action: "message", session_id: sessionID, text: "again" },
    })
    expect(followUp.structuredContent.state).toBe("done")

    const failed = await client.callTool({ name: "opencode_delegate", arguments: { task: "x", bogus: 1 } })
    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain("unexpected parameter")
  } finally {
    await client.close().catch(() => {})
    await fixture.close()
  }
}, 30_000)

test("the default wait returns a running result before the SDK request timeout", async () => {
  const fixture = await startFixture({ replyDelayMs: 120_000 })
  const { client, transport } = fixtureClient(fixture, { OPENCODE_MCP_DELEGATE_WAIT_MS: "25" })
  try {
    await client.connect(transport)
    const delegated = await call(client, { name: "opencode_delegate", arguments: { task: "long fixture task" } })
    const sessionID = delegated.structuredContent.session_id
    expect(delegated.structuredContent.state).toBe("running")
    const started = Date.now()
    // No client timeout override: this exercises the SDK's normal 60s limit.
    const waited = await call(client, { name: "opencode_session", arguments: { action: "wait", session_id: sessionID } })
    expect(Date.now() - started).toBeLessThan(55_000)
    expect(waited.isError).toBeFalsy()
    expect(waited.structuredContent.state).toBe("running")
    expect(waited.content[0].text).toContain('action="wait"')
    expect(fixture.sessions.get(sessionID).running).toBe(true)
    fixture.finish(sessionID, "failed")
    const finished = await call(client, { name: "opencode_session", arguments: { action: "wait", session_id: sessionID } })
    expect(finished.structuredContent.state).toBe("failed")
  } finally {
    await client.close().catch(() => {})
    await fixture.close()
  }
}, 70_000)

test("a timed-out message can be resumed through a new Node stdio process", async () => {
  const fixture = await startFixture({ replyDelayMs: 120_000, replies: ["first answer", "second answer"] })
  const env = { OPENCODE_MCP_DELEGATE_WAIT_MS: "25", OPENCODE_MCP_WAIT_MS: "25" }
  const first = fixtureClient(fixture, env)
  const second = fixtureClient(fixture, env)
  try {
    await first.client.connect(first.transport)
    const delegated = await call(first.client, { name: "opencode_delegate", arguments: { task: "one" } })
    const sessionID = delegated.structuredContent.session_id
    fixture.finish(sessionID)
    const message = await call(first.client, { name: "opencode_session", arguments: { action: "message", session_id: sessionID, text: "two" } })
    expect(message.structuredContent.state).toBe("running")
    await first.client.close()
    fixture.finish(sessionID)
    await second.client.connect(second.transport)
    const waited = await call(second.client, { name: "opencode_session", arguments: { action: "wait", session_id: sessionID } })
    expect(waited.structuredContent.state).toBe("done")
    expect(waited.structuredContent.text).toBe("second answer")
  } finally {
    await first.client.close().catch(() => {})
    await second.client.close().catch(() => {})
    await fixture.close()
  }
}, 20_000)

test("stdio cancellation preserves a queued input and a new client recovers its ID", async () => {
  const fixture = await startFixture({ deliveryDelayMs: 120_000 })
  const env = { OPENCODE_MCP_DELEGATE_WAIT_MS: "25" }
  const first = fixtureClient(fixture, env)
  const second = fixtureClient(fixture, env)
  try {
    await first.client.connect(first.transport)
    const delegated = await call(first.client, { name: "opencode_delegate", arguments: { task: "delayed" } })
    expect(delegated.structuredContent.input_status).toBe("queued")
    const sessionID = delegated.structuredContent.session_id
    const cancel = await call(first.client, { name: "opencode_session", arguments: { action: "cancel", session_id: sessionID } })
    expect(cancel.structuredContent.state).toBe("queued")
    expect(cancel.structuredContent.last_outcome).toBe("interrupted")
    await first.client.close()
    await second.client.connect(second.transport)
    const result = await call(second.client, { name: "opencode_session", arguments: { action: "wait", session_id: sessionID } })
    expect(result.structuredContent.input_id).toBe(delegated.structuredContent.input_id)
    expect(result.structuredContent.pending_inputs).toBe(1)
    expect(result.structuredContent.text).toBeUndefined()
  } finally {
    await first.client.close().catch(() => {})
    await second.client.close().catch(() => {})
    await fixture.close()
  }
}, 20_000)
