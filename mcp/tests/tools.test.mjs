import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as module from "../opencode.mjs"
import { createTools, DEFAULT_WAIT_MS } from "../tools.mjs"
import { fixtureApi, startFixture } from "./fixture.mjs"
import { readSnapshot, readOutput } from "../tasks.mjs"

test("the default wait budget leaves headroom under the client request timeout", () => {
  // MCP clients commonly give up at 60s; a longer default wait would surface as a
  // client-side timeout instead of a running result.
  expect(DEFAULT_WAIT_MS).toBeLessThanOrEqual(45_000)
})

const fixtures = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

async function setup(options = {}) {
  const fixture = await startFixture(options)
  fixtures.push(fixture)
  const stateDir = mkdtempSync(join(tmpdir(), "ocw-mcp-state-"))
  const env = { OPENCODE_MCP_DIRECTORY: process.cwd(), OPENCODE_WEB_STATE_DIR: stateDir, ...(options.env ?? {}) }
  if (options.ranking) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, "model-ranking.json"), JSON.stringify({ ranking: options.ranking }))
  }
  const api = fixtureApi(module, fixture.url)
  const tools = createTools({ api, env })
  return { fixture, tools, stateDir, api, env }
}

test("delegate hands over a task and returns the answer, pre-approved and stamped for the UI", async () => {
  const { fixture, tools } = await setup()
  const result = await tools.opencode_delegate.handler({ task: "say pong" })

  expect(result.structured.state).toBe("done")
  expect(result.structured.text).toBe("PONG.")
  expect(result.structured.session_id).toStartWith("ses_")
  expect(result.structured.input_status).toBe("settled")
  expect(result.structured.pending_inputs).toBe(0)

  const session = [...fixture.sessions.values()][0]
  expect(session.title).toBe("say pong")
  expect(session.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
  expect(session.metadata).toEqual({ origin: "opencode-delegate", caller: "mcp" })
})

test("nothing about the wiring is a parameter: model, caller, mode and task handles are rejected", async () => {
  const { tools } = await setup()
  await expect(tools.opencode_delegate.handler({ task: "x", model: "opencode/big-pickle" })).rejects.toThrow(/unexpected parameter/)
  await expect(tools.opencode_delegate.handler({ task: "x", caller: "me" })).rejects.toThrow(/unexpected parameter/)
  await expect(tools.opencode_delegate.handler({ task: "x", mode: "async" })).rejects.toThrow(/unexpected parameter/)
  await expect(tools.opencode_session.handler({ action: "list" })).rejects.toThrow(/must be one of/)
  await expect(tools.opencode_session.handler({ action: "status", task_id: "task_x" })).rejects.toThrow(/unexpected parameter/)
})

test("a task that outlasts the short first wait comes back as a running session to talk to", async () => {
  const { tools } = await setup({ replyDelayMs: 600, env: { OPENCODE_MCP_DELEGATE_WAIT_MS: "200" } })
  const started = await tools.opencode_delegate.handler({ task: "slow" })
  expect(started.structured.state).toBe("running")
  expect(started.structured.session_id).toStartWith("ses_")
  expect(started.text).toContain('action="wait"')

  const waited = await tools.opencode_session.handler({ action: "wait", session_id: started.structured.session_id })
  expect(waited.structured.state).toBe("done")
  expect(waited.structured.text).toBe("PONG.")
})

test("status reports running, then the last answer; wait reports a timeout honestly", async () => {
  const { tools } = await setup({ replyDelayMs: 600, env: { OPENCODE_MCP_DELEGATE_WAIT_MS: "200", OPENCODE_MCP_WAIT_MS: "150" } })
  const started = await tools.opencode_delegate.handler({ task: "slow" })
  const sessionID = started.structured.session_id

  const running = await tools.opencode_session.handler({ action: "status", session_id: sessionID })
  expect(running.structured.state).toBe("running")

  const timeout = await tools.opencode_session.handler({ action: "wait", session_id: sessionID })
  expect(timeout.structured.state).toBe("running")
  expect(timeout.text).toContain("Still running")

  await Bun.sleep(650)
  const done = await tools.opencode_session.handler({ action: "wait", session_id: sessionID })
  expect(done.structured.state).toBe("done")
  expect(done.structured.text).toBe("PONG.")
})

test("a follow-up message continues the session and returns only the new turn", async () => {
  const { fixture, tools } = await setup({ replies: ["first answer", "second answer"] })
  const first = await tools.opencode_delegate.handler({ task: "one" })
  expect(first.structured.text).toBe("first answer")

  const second = await tools.opencode_session.handler({
    action: "message",
    session_id: first.structured.session_id,
    text: "two",
  })
  expect(second.structured.text).toBe("second answer")
  expect(fixture.state.created).toBe(1)
  expect(fixture.state.prompts).toBe(2)
})

test("cancel interrupts the running turn and reports cancelled", async () => {
  const { fixture, tools } = await setup({ replyDelayMs: 5_000, env: { OPENCODE_MCP_DELEGATE_WAIT_MS: "100" } })
  const started = await tools.opencode_delegate.handler({ task: "long work" })

  const cancelled = await tools.opencode_session.handler({ action: "cancel", session_id: started.structured.session_id })
  expect(cancelled.structured.state).toBe("cancelled")
  expect(fixture.state.interrupts).toBe(1)
  const waited = await tools.opencode_session.handler({ action: "wait", session_id: started.structured.session_id })
  expect(waited.structured.state).toBe("cancelled")
})

for (const [outcome, expected] of [["failed", "failed"], ["interrupted", "cancelled"]]) {
  test(`${outcome} is preserved by delegate, status, wait and message`, async () => {
    const { tools } = await setup({ outcomes: [outcome] })
    const result = await tools.opencode_delegate.handler({ task: "cannot finish" })
    expect(result.structured.state).toBe(expected)
    expect(result.text).toContain(` · ${expected} · `)
    for (const action of ["status", "wait", "message"]) {
      const reply = await tools.opencode_session.handler({ action, session_id: result.structured.session_id, ...(action === "message" ? { text: "try again" } : {}) })
      expect(reply.structured.state).toBe(expected)
      expect(reply.structured.text ?? "").not.toContain("PONG.")
    }
  })
}

test("a turn that settles just after the wait timeout is reported as finished", async () => {
  const { api, env } = await setup({ outcomes: ["failed"] })
  const tools = createTools({ env, api: { ...api, wait: async (id, ms) => ({ ...await api.wait(id, ms), completed: false }) } })
  const result = await tools.opencode_delegate.handler({ task: "fails at timeout" })
  expect(result.structured.state).toBe("failed")
  expect(result.text).not.toContain("Still running")
})

test("a timed-out follow-up retains its output boundary through a new MCP instance", async () => {
  const { api, env, tools, fixture } = await setup({ replies: ["first answer", "second answer"], replyDelayMs: 60_000, env: { OPENCODE_MCP_DELEGATE_WAIT_MS: "30", OPENCODE_MCP_WAIT_MS: "30" } })
  const first = await tools.opencode_delegate.handler({ task: "one" })
  const sessionID = first.structured.session_id
  fixture.finish(sessionID)
  const firstReply = await tools.opencode_session.handler({ action: "wait", session_id: sessionID })
  expect(firstReply.structured.text).toBe("first answer")

  const followUp = await tools.opencode_session.handler({ action: "message", session_id: sessionID, text: "two" })
  expect(followUp.structured.state).toBe("running")
  fixture.finish(sessionID)
  const reconnected = createTools({ api, env })
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await reconnected.opencode_session.handler({ action: "wait", session_id: sessionID })
    expect(result.structured.text).toBe("second answer")
  }
})

test("a lost prompt response keeps the created session handle in the error", async () => {
  const { api, env, fixture } = await setup()
  const tools = createTools({ env, api: { ...api, prompt: async () => { throw new Error("connection lost; request was not retried") } } })
  await expect(tools.opencode_delegate.handler({ task: "one" })).rejects.toThrow(/Session ses_.*Check this session before sending the task again/)
  expect(fixture.state.created).toBe(1)
})

test("the model is the operator's call: env pin, else the web ranking, else the first free one", async () => {
  const ranked = await setup({ ranking: ["opencode/big-pickle", "opencode/deepseek-v4.1-flash-free"] })
  await ranked.tools.opencode_delegate.handler({ task: "hello" })
  expect([...ranked.fixture.sessions.values()][0].model.id).toBe("big-pickle")

  const pinned = await setup({
    ranking: ["opencode/big-pickle"],
    env: { OPENCODE_MCP_MODEL: "opencode/deepseek-v4.1-flash-free" },
  })
  await pinned.tools.opencode_delegate.handler({ task: "hello" })
  expect([...pinned.fixture.sessions.values()][0].model.id).toBe("deepseek-v4.1-flash-free")

  const stale = await setup({ env: { OPENCODE_MCP_MODEL: "opencode/retired-model" } })
  await stale.tools.opencode_delegate.handler({ task: "hello" })
  expect([...stale.fixture.sessions.values()][0].model.id).toBe("deepseek-v4.1-flash-free")
})

test("a missing working directory fails clearly; an explicit one is used", async () => {
  const { fixture, tools } = await setup({ env: { OPENCODE_MCP_DIRECTORY: "" } })
  await expect(tools.opencode_delegate.handler({ task: "x" })).rejects.toThrow(/explicit working directory/)
  await expect(tools.opencode_delegate.handler({ task: "x", directory: join(tmpdir(), "ocw-missing-dir") })).rejects.toThrow(
    /directory does not exist/,
  )
  expect(fixture.state.created).toBe(0)

  await tools.opencode_delegate.handler({ task: "x", directory: process.cwd() })
  expect([...fixture.sessions.values()][0].location.directory).toBe(process.cwd())
})

test("relative or invalid directories cannot silently use the MCP launch directory", async () => {
  const { tools, fixture, api, env } = await setup()
  const relative = [".", "..", "mcp", ...(process.platform === "win32" ? ["C:project", "\\project"] : [])]
  for (const directory of relative)
    await expect(tools.opencode_delegate.handler({ task: "x", directory })).rejects.toThrow(/absolute path/)
  for (const directory of ["", "   ", null, 123, {}])
    await expect(tools.opencode_delegate.handler({ task: "x", directory })).rejects.toThrow(/non-empty string/)
  const relativeDefault = createTools({ api, env: { ...env, OPENCODE_MCP_DIRECTORY: "." } })
  await expect(relativeDefault.opencode_delegate.handler({ task: "x" })).rejects.toThrow(/absolute path/)
  expect(fixture.state.created).toBe(0)
})

test("long answers are bounded and marked as truncated", async () => {
  const { tools } = await setup({ replies: ["y".repeat(5_000)], env: { OPENCODE_MCP_MAX_CHARS: "1000" } })
  const result = await tools.opencode_delegate.handler({ task: "long answer" })
  expect(result.structured.truncated).toBe(true)
  expect(result.structured.text.length).toBe(1_000)
  expect(result.text).toContain("[output truncated]")
})

test("delegation carries the working agreement, and OPENCODE_MCP_PROTOCOL=off removes it", async () => {
  const withProtocol = await setup()
  await withProtocol.tools.opencode_delegate.handler({ task: "do it" })
  expect(withProtocol.fixture.state.promptTexts).toEqual(["do it"])
  expect([...withProtocol.fixture.sessions.values()][0].instructions["delegation-protocol"]).toContain("plan:")
  expect(withProtocol.fixture.state.instructionWrites).toBe(1)

  const fallback = await setup({ instructions: false })
  await fallback.tools.opencode_delegate.handler({ task: "do it" })
  expect(fallback.fixture.state.promptTexts[0]).toStartWith("[Delegation protocol]")
  expect(fallback.fixture.state.instructionWrites).toBe(0)

  const without = await setup({ env: { OPENCODE_MCP_PROTOCOL: "off" } })
  await without.tools.opencode_delegate.handler({ task: "do it" })
  expect(without.fixture.state.promptTexts).toEqual(["do it"])
  expect(without.fixture.state.instructionWrites).toBe(0)
})

test("status reports the plan, the running step, the progress line and the diff", async () => {
  const { tools } = await setup({
    progressMode: true,
    replyDelayMs: 4_000,
    diffFiles: [
      { file: "a.js", additions: 20, deletions: 4, status: "modified", patch: "" },
      { file: "b.js", additions: 11, deletions: 0, status: "added", patch: "" },
    ],
    env: { OPENCODE_MCP_DELEGATE_WAIT_MS: "100" },
  })
  const started = await tools.opencode_delegate.handler({ task: "build it" })
  expect(started.structured.state).toBe("running")
  expect(started.text).toContain("Plan: 1) 读代码")

  const status = await tools.opencode_session.handler({ action: "status", session_id: started.structured.session_id })
  expect(status.text).toContain("Plan: 1) 读代码 · 2) 改代码 · 3) 跑测试")
  expect(status.text).toContain('Now: shell "npm test" (running)')
  expect(status.text).toContain("Progress: 1/3 读完入口 -> 修改实现")
  expect(status.text).toContain("Files: 2 changed +31 −4")
})

test("plan and progress lines stay out of the final answer", async () => {
  const { tools } = await setup({ replies: ["plan: 1) a 2) b\nprogress: 1/2 a done -> b\nREAL ANSWER"] })
  const result = await tools.opencode_delegate.handler({ task: "x" })
  expect(result.structured.text).toBe("REAL ANSWER")
})

test("durable admission precedes delivery; cancelled execution retains Inbox across reconnect", async () => {
  const { tools, api, env, fixture } = await setup({ deliveryDelayMs: 60_000, env: { OPENCODE_MCP_DELEGATE_WAIT_MS: "20" } })
  const result = await tools.opencode_delegate.handler({ task: "not delivered yet" })
  expect(result.structured.input_status).toBe("queued")
  expect(result.structured.state).toBe("running")
  const id = result.structured.session_id
  expect(fixture.sessions.get(id).messages).toEqual([])
  const cancelled = await tools.opencode_session.handler({ action: "cancel", session_id: id })
  expect(cancelled.structured.state).toBe("queued")
  expect(cancelled.structured.last_outcome).toBe("interrupted")
  expect(cancelled.structured.pending_inputs).toBe(1)
  expect(cancelled.text).toContain("1 pending input(s) retained")
  const reconnected = createTools({ api, env })
  const waited = await reconnected.opencode_session.handler({ action: "wait", session_id: id })
  expect(waited.structured.input_id).toBe(result.structured.input_id)
  expect(waited.structured.input_status).toBe("queued")
  expect(waited.structured.text).toBeUndefined()
})

test("parked input never inherits the previous success, and wait does not resume it", async () => {
  const { tools, api, fixture } = await setup()
  const first = await tools.opencode_delegate.handler({ task: "one" })
  const id = first.structured.session_id
  const parked = await api.prompt(id, "two", { resume: false, delivery: "queue" })
  const result = await tools.opencode_session.handler({ action: "wait", session_id: id })
  expect(result.structured.input_id).toBe(parked.id)
  expect(result.structured.state).toBe("queued")
  expect(result.structured.last_outcome).toBe("succeeded")
  expect(fixture.sessions.get(id).running).toBe(false)
  expect(result.structured.text).toBeUndefined()
})

for (const resume of [false, true]) {
  test(`settled input returns its answer while another input is ${resume ? "running" : "parked"}`, async () => {
    const { api, env, fixture } = await setup({ replies: ["COMPLETED_ANSWER"], replyDelayMs: 60_000 })
    const tools = createTools({ env, api: { ...api, wait: async (id, ms) => {
      fixture.deliver(id)
      fixture.finish(id)
      const waited = await api.wait(id, ms)
      await api.prompt(id, "another input", { delivery: "queue", resume })
      return waited
    } } })
    const result = await tools.opencode_delegate.handler({ task: "first input" })
    expect(result.structured.state).toBe(resume ? "running" : "queued")
    expect(result.structured.input_status).toBe("settled")
    expect(result.structured.input_outcome).toBe("succeeded")
    expect(result.structured.text).toBe("COMPLETED_ANSWER")
    expect(result.text).toContain("COMPLETED_ANSWER")
  })
}

test("failed inputs expose bounded diagnostics in delegate, status and wait without leaking response bodies", async () => {
  const error = { type: "provider.auth", status: 403, message: "AUTH_DENIED " + "x".repeat(1500), response: { body: "PRIVATE_PROVIDER_BODY" } }
  const { tools } = await setup({ outcomes: ["failed", "succeeded"], errors: [error] })
  const first = await tools.opencode_delegate.handler({ task: "first input" })
  const args = { session_id: first.structured.session_id }
  for (const result of [first, await tools.opencode_session.handler({ ...args, action: "status" }), await tools.opencode_session.handler({ ...args, action: "wait" })]) {
    expect(result.structured.input_error.type).toBe("provider.auth")
    expect(result.structured.input_error.status).toBe(403)
    expect(result.structured.input_error.message.length).toBe(1000)
    expect(result.text).toContain("Error: provider.auth (403): AUTH_DENIED")
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_BODY")
  }
  const next = await tools.opencode_session.handler({ ...args, action: "message", text: "next input" })
  expect(next.structured.state).toBe("done")
  expect(next.structured.input_error).toBeUndefined()
  expect(next.text).not.toContain("AUTH_DENIED")
})

test("concurrent steers share the next idle boundary and exclude earlier or later execution output", async () => {
  const { tools, api, fixture } = await setup({ replyDelayMs: 60_000, env: { OPENCODE_MCP_DELEGATE_WAIT_MS: "20", OPENCODE_MCP_WAIT_MS: "20" } })
  const first = await tools.opencode_delegate.handler({ task: "one" })
  const id = first.structured.session_id
  const second = await tools.opencode_session.handler({ action: "message", session_id: id, text: "steer" })
  expect(fixture.state.deliveries).toEqual(["steer", "steer"])
  fixture.finish(id)
  const left = await readSnapshot(api, id, first.structured.input_id)
  const right = await readSnapshot(api, id, second.structured.input_id)
  expect(left.inputStatus).toBe("settled")
  expect(right.inputStatus).toBe("settled")
  const messages = fixture.sessions.get(id).messages
  expect(messages.filter((item) => item.type === "idle")).toHaveLength(1)
  messages.push({ id: "msg_other", type: "user" }, { id: "msg_unrelated", type: "assistant", content: [{ type: "text", text: "unrelated answer" }] })
  expect(readOutput([...messages].reverse(), { inputID: first.structured.input_id }).text).toBe("PONG.")
  messages.push({ id: "msg_later_idle", type: "idle", outcome: "failed" })
  const original = await readSnapshot(api, id, first.structured.input_id)
  expect(original.state).toBe("done")
  expect(original.inputOutcome).toBe("succeeded")
  expect(original.lastOutcome).toBe("failed")
})

test("stable admission IDs adopt the first payload, including after delivery", async () => {
  const { api, fixture } = await setup({ replyDelayMs: 60_000 })
  const { id } = await api.createSession({ title: "stable", directory: process.cwd() })
  const [first, retry] = await Promise.all([
    api.prompt(id, "first", { id: "msg_stable", metadata: { origin: "first" }, delivery: "queue", resume: false }),
    api.prompt(id, "second", { id: "msg_stable", metadata: { origin: "second" }, delivery: "steer", resume: false }),
  ])
  expect(first).toEqual(retry)
  expect(first.payload.text).toBe("first")
  expect(first.delivery).toBe("queue")
  expect(first.payload.metadata).toEqual({ origin: "first" })
  fixture.deliver(id)
  const afterDelivery = await api.prompt(id, "third", { id: "msg_stable", resume: false })
  expect(afterDelivery.id).toBe(first.id)
  expect(afterDelivery.payload).toEqual(first.payload)
  expect(await api.inbox(id)).toEqual([])
  expect(fixture.state.created).toBe(1)
  expect(fixture.state.prompts).toBe(1)
  const another = await api.createSession({ directory: process.cwd() })
  await expect(api.prompt(another.id, "conflict", { id: "msg_stable", resume: false })).rejects.toThrow("409")
})

test("the service mints session ids, and a lost create response is reported instead of retried", async () => {
  const { api, fixture } = await setup({ dropResponses: { create: 1 } })
  await expect(api.createSession({ title: "lost", directory: process.cwd() })).rejects.toThrow(/list sessions before creating another/)
  // The dropped response still left one session behind: retrying would have made two.
  expect([...fixture.sessions.keys()]).toHaveLength(1)
  expect(fixture.state.created).toBe(1)
})

test("a long execution pages back to its input; missing history returns unknown, never another answer", async () => {
  const { tools, api, fixture } = await setup()
  const first = await tools.opencode_delegate.handler({ task: "long history" })
  const id = first.structured.session_id
  const messages = fixture.sessions.get(id).messages
  const idle = messages.pop()
  for (let index = 0; index < 420; index++) messages.push({ id: `msg_step${index}`, type: "assistant", content: [{ type: "text", text: `step ${index}` }] })
  messages.push(idle)
  const readBefore = fixture.state.messageReads
  const result = await tools.opencode_session.handler({ action: "wait", session_id: id })
  expect(result.structured.input_id).toBe(first.structured.input_id)
  expect(result.structured.state).toBe("done")
  expect(result.structured.text).toContain("step 419")
  expect(fixture.state.messageReads - readBefore).toBe(4) // user lookup + three pages
  for (let index = 0; index < 650; index++) messages.push({ id: `msg_noise${index}`, type: "assistant", content: [{ type: "text", text: "unrelated" }] })
  const unknown = await tools.opencode_session.handler({ action: "wait", session_id: id })
  expect(unknown.structured.state).toBe("unknown")
  expect(unknown.structured.history_truncated).toBe(true)
  expect(unknown.structured.text).toBeUndefined()
  const absent = await readSnapshot(api, id, "msg_missing")
  expect(absent.inputStatus).toBe("unknown")
})

test("shutdown without idle and failed active probes cannot report success", async () => {
  const { tools, fixture, api, env } = await setup({ replyDelayMs: 60_000, env: { OPENCODE_MCP_DELEGATE_WAIT_MS: "20" } })
  const first = await tools.opencode_delegate.handler({ task: "one" })
  fixture.sessions.get(first.structured.session_id).running = false
  const result = await tools.opencode_session.handler({ action: "status", session_id: first.structured.session_id })
  expect(result.structured.state).toBe("unknown")
  expect(result.structured.input_status).toBe("delivered")
  const broken = createTools({ env, api: { ...api, activeSessions: async () => { throw new Error("active unavailable") } } })
  await expect(broken.opencode_delegate.handler({ task: "two" })).rejects.toThrow(/Session ses_.*input msg_.*active unavailable/)
})

test("disabled protocol preserves plan-like output and enabled protocol preserves code fences", async () => {
  const off = await setup({ replies: ["plan: literal data"], env: { OPENCODE_MCP_PROTOCOL: "off" } })
  expect((await off.tools.opencode_delegate.handler({ task: "one" })).structured.text).toBe("plan: literal data")
  const on = await setup({ replies: ["plan: 1) do it\n```yaml\nplan: literal data\n```"] })
  expect((await on.tools.opencode_delegate.handler({ task: "one" })).structured.text).toBe("```yaml\nplan: literal data\n```")
})

