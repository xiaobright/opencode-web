import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as module from "../opencode.mjs"
import { createTools } from "../tools.mjs"
import { DelegationStore } from "../tasks.mjs"
import { fixtureApi, startFixture } from "./fixture.mjs"

const fixtures = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

async function setup(options = {}) {
  const fixture = await startFixture(options)
  fixtures.push(fixture)
  const statePath = join(mkdtempSync(join(tmpdir(), "ocw-mcp-")), "tasks.json")
  const store = new DelegationStore({ path: statePath })
  const tools = createTools({ api: fixtureApi(module, fixture.url), store, env: options.env ?? {}, cwd: process.cwd() })
  return { fixture, store, tools, statePath }
}

test("sync delegation creates a session, pre-approves tools, waits and returns the answer", async () => {
  const { fixture, store, tools } = await setup()
  const result = await tools.opencode_delegate.handler({ task: "say pong", timeout_ms: 5_000 })

  expect(result.structured.state).toBe("done")
  expect(result.structured.completed).toBe(true)
  expect(result.structured.model).toBe("opencode/deepseek-v4.1-flash-free")
  expect(result.structured.text).toBe("PONG.")
  expect(result.structured.sessionID).toStartWith("ses_")
  expect(result.text).toContain("Task task_")
  expect(result.text).toContain("PONG.")

  expect(fixture.state.created).toBe(1)
  expect(fixture.state.prompts).toBe(1)
  const session = [...fixture.sessions.values()][0]
  expect(session.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
  expect(store.find(result.structured.taskId)?.sessionID).toBe(result.structured.sessionID)
})

test("async delegation returns a handle; wait completes; delta output does not repeat the turn", async () => {
  const { tools } = await setup({ replyDelayMs: 60 })
  const started = await tools.opencode_delegate.handler({ task: "work", mode: "async" })
  expect(started.structured.state).toBe("running")
  expect(started.text).toContain('action="wait"')

  const waited = await tools.opencode_task.handler({ action: "wait", task_id: started.structured.taskId, wait_ms: 5_000 })
  expect(waited.structured.completed).toBe(true)
  expect(waited.structured.state).toBe("done")
  expect(waited.structured.text).toBe("PONG.")

  const delta = await tools.opencode_task.handler({ action: "output", task_id: started.structured.taskId })
  expect(delta.structured.text).toBe("")
  expect(delta.structured.nextCursor).toBeTruthy()

  const full = await tools.opencode_task.handler({ action: "output", task_id: started.structured.taskId, read_mode: "full" })
  expect(full.structured.text).toBe("PONG.")
})

test("status is honest while the loop runs, and uses the idle outcome after it settles", async () => {
  const { tools } = await setup({ replyDelayMs: 150 })
  const started = await tools.opencode_delegate.handler({ task: "work", mode: "async" })

  const running = await tools.opencode_task.handler({ action: "status", task_id: started.structured.taskId })
  expect(running.structured.state).toBe("running")

  await tools.opencode_task.handler({ action: "wait", task_id: started.structured.taskId, wait_ms: 5_000 })
  const done = await tools.opencode_task.handler({ action: "status", task_id: started.structured.taskId })
  expect(done.structured.state).toBe("done")
  expect(done.text).toContain("tokens 10 in / 2 out")
})

test("a follow-up message continues the same session and returns only the new turn", async () => {
  const { fixture, tools } = await setup({ replies: ["first answer", "second answer"] })
  const first = await tools.opencode_delegate.handler({ task: "one" })
  expect(first.structured.text).toBe("first answer")

  const second = await tools.opencode_task.handler({ action: "message", task_id: first.structured.taskId, text: "two" })
  expect(second.structured.text).toBe("second answer")
  expect(second.structured.sessionID).toBe(first.structured.sessionID)
  expect(fixture.state.created).toBe(1)
  expect(fixture.state.prompts).toBe(2)
})

test("cancel interrupts a running turn and reports cancelled", async () => {
  const { fixture, tools } = await setup({ replyDelayMs: 5_000 })
  const started = await tools.opencode_delegate.handler({ task: "long work", mode: "async" })

  const cancelled = await tools.opencode_task.handler({ action: "cancel", task_id: started.structured.taskId })
  expect(cancelled.structured.cancelled).toBe(true)
  expect(cancelled.structured.state).toBe("cancelled")
  expect(fixture.state.interrupts).toBe(1)
})

test("models lists free tool-capable models by default and marks the default", async () => {
  const { tools } = await setup()
  const free = await tools.opencode_models.handler({})
  expect(free.structured.models).toHaveLength(2)
  expect(free.structured.default).toEqual({ providerID: "opencode", id: "deepseek-v4.1-flash-free" })
  expect(free.text).toContain("* opencode/deepseek-v4.1-flash-free")
  expect(free.text).not.toContain("paid-model")

  const all = await tools.opencode_models.handler({ free_only: false })
  expect(all.structured.models).toHaveLength(3)
  expect(all.text).toContain("paid-model")
})

test("help topics answer without side effects and unknown parameters are rejected", async () => {
  const { fixture, tools } = await setup()
  const help = await tools.opencode_help.handler({ topic: "manage" })
  expect(help.text).toContain('action="wait"')

  await expect(tools.opencode_delegate.handler({ task: "x", nope: true })).rejects.toThrow(/unexpected parameter/)
  await expect(tools.opencode_task.handler({ action: "status", task_id: "task_missing" })).rejects.toThrow(/unknown task/)
  expect(fixture.state.created).toBe(0)
})

test("delegation rejects a missing directory and an unknown model before creating anything", async () => {
  const { fixture, tools } = await setup()
  await expect(
    tools.opencode_delegate.handler({ task: "x", directory: join(tmpdir(), "ocw-does-not-exist") }),
  ).rejects.toThrow(/directory does not exist/)
  await expect(tools.opencode_delegate.handler({ task: "x", model: "opencode/nope" })).rejects.toThrow(/unknown model/)
  expect(fixture.state.created).toBe(0)
})

test("the default model falls back to the first free model when it disappears from the catalog", async () => {
  const models = [
    {
      id: "replacement-free",
      modelID: "replacement-free",
      providerID: "opencode",
      name: "Replacement Free",
      limit: { context: 128_000 },
      capabilities: { tools: true },
      cost: [{ input: 0, output: 0 }],
      status: "active",
      enabled: true,
    },
  ]
  const { tools } = await setup({ models })
  const result = await tools.opencode_delegate.handler({ task: "hello" })
  expect(result.structured.model).toBe("opencode/replacement-free")
})

test("a wait budget that runs out leaves the task running, and on_timeout=interrupt stops it", async () => {
  const { fixture, tools } = await setup({ replyDelayMs: 2_000 })
  const timedOut = await tools.opencode_delegate.handler({ task: "slow", timeout_ms: 1_000 })
  expect(timedOut.structured.timedOut).toBe(true)
  expect(timedOut.structured.state).toBe("running")
  expect(timedOut.text).toContain("still running")

  const interrupted = await tools.opencode_delegate.handler({ task: "slow", timeout_ms: 1_000, on_timeout: "interrupt" })
  expect(interrupted.structured.state).toBe("cancelled")
  expect(fixture.state.interrupts).toBe(1)

  // The first delegation is still running: wait for it so the fixture can close cleanly.
  await tools.opencode_task.handler({ action: "wait", task_id: timedOut.structured.taskId, wait_ms: 5_000 })
}, 20_000)

test("the registry survives a restart: a new store lists the task and a session id addresses it", async () => {
  const { tools, statePath } = await setup()
  const result = await tools.opencode_delegate.handler({ task: "persisted" })

  const reloaded = new DelegationStore({ path: statePath })
  const records = reloaded.list()
  expect(records).toHaveLength(1)
  expect(records[0].sessionID).toBe(result.structured.sessionID)
  expect(reloaded.find(result.structured.sessionID)?.taskId).toBe(result.structured.taskId)

  const status = await tools.opencode_task.handler({ action: "status", session_id: result.structured.sessionID })
  expect(status.structured.state).toBe("done")
})
