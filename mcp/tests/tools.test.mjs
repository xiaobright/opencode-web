import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as module from "../opencode.mjs"
import { createTools } from "../tools.mjs"
import { fixtureApi, startFixture } from "./fixture.mjs"

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
  expect(result.text).toBe(`Session ${result.structured.session_id} · done · 0.0s\n\nPONG.`)

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
  expect(withProtocol.fixture.state.promptTexts[0]).toStartWith("[Delegation protocol]")
  expect(withProtocol.fixture.state.promptTexts[0]).toContain("do it")
  expect(withProtocol.fixture.state.promptTexts[0]).toContain("plan:")

  const without = await setup({ env: { OPENCODE_MCP_PROTOCOL: "off" } })
  await without.tools.opencode_delegate.handler({ task: "do it" })
  expect(without.fixture.state.promptTexts).toEqual(["do it"])
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

