import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startFixture } from "./fixture.mjs"

test("Node uses service-minted sessions, never retries create/interrupt, and retries input admission once", async () => {
  const fixture = await startFixture({ dropResponses: { create: 1, prompt: 1, messages: 1, wait: 1, interrupt: 1 } })
  const stateHome = mkdtempSync(join(tmpdir(), "ocw-mcp-client-"))
  mkdirSync(join(stateHome, "opencode"))
  writeFileSync(join(stateHome, "opencode", "service.json"), JSON.stringify({ url: fixture.url, password: "fixture" }))
  const source = `
    import assert from "node:assert/strict";
    import * as api from ${JSON.stringify(new URL("../opencode.mjs", import.meta.url).href)};
    await assert.rejects(api.createSession({ title: "lost response", directory: process.cwd() }), /list sessions before creating another/);
    const session = await api.createSession({ id: "ses_must_not_be_sent", title: "next request", directory: process.cwd() });
    const input = await api.prompt(session.id, "execute once");
    assert.match(input.id, /^msg_/);
    await api.wait(session.id, 5000);
    const messages = await api.messages(session.id);
    assert.equal(messages.filter(message => message.type === "user").length, 1);
    assert.equal(messages[0].outcome, "succeeded");
    await assert.rejects(api.interrupt(session.id), /not retried/);
    console.log("safe retry policy passed");
  `
  const script = join(stateHome, "client-check.mjs")
  writeFileSync(script, source)
  try {
    const result = await promisify(execFile)("node", [script], {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, XDG_STATE_HOME: stateHome, OPENCODE_BIN: join(stateHome, "missing-opencode.exe") },
    })
    expect(result.stdout).toContain("safe retry policy passed")
    expect(fixture.state.created).toBe(2)
    expect(fixture.state.createBodies).toHaveLength(2)
    for (const body of fixture.state.createBodies) expect(Object.hasOwn(body, "id")).toBe(false)
    expect(fixture.state.prompts).toBe(1)
    expect(fixture.state.messageReads).toBe(2)
    expect(fixture.state.waits).toBe(2)
    expect(fixture.state.interrupts).toBe(1)
  } finally {
    await fixture.close()
  }
}, 20_000)

test("Node capability and write checks share one cache beyond the connection TTL", async () => {
  const fixture = await startFixture()
  const stateHome = mkdtempSync(join(tmpdir(), "ocw-mcp-cache-"))
  mkdirSync(join(stateHome, "opencode"))
  writeFileSync(join(stateHome, "opencode", "service.json"), JSON.stringify({ url: fixture.url, password: "fixture" }))
  const script = join(stateHome, "cache-check.mjs")
  writeFileSync(script, `
    import * as api from ${JSON.stringify(new URL("../opencode.mjs", import.meta.url).href)};
    await Promise.all([api.capabilities(), api.capabilities(), api.capabilities()]);
    const session = await api.createSession({ title: "cached", directory: process.cwd() });
    const clock = Date.now;
    Date.now = () => clock() + 6000;
    await api.capabilities();
    await api.prompt(session.id, "one");
    await api.wait(session.id, 5000);
  `)
  try {
    await promisify(execFile)("node", [script], { windowsHide: true, timeout: 15_000, env: { ...process.env, XDG_STATE_HOME: stateHome, OPENCODE_BIN: join(stateHome, "missing-opencode.exe") } })
    expect(fixture.state.openapiReads).toBe(1)
  } finally { await fixture.close() }
}, 20_000)

test("Node retries a lost contract read before creating a service-minted session", async () => {
  const fixture = await startFixture({ dropResponses: { openapi: 1 } })
  const stateHome = mkdtempSync(join(tmpdir(), "ocw-mcp-probe-"))
  mkdirSync(join(stateHome, "opencode"))
  writeFileSync(join(stateHome, "opencode", "service.json"), JSON.stringify({ url: fixture.url, password: "fixture" }))
  const script = join(stateHome, "probe-check.mjs")
  writeFileSync(script, `
    import * as api from ${JSON.stringify(new URL("../opencode.mjs", import.meta.url).href)};
    await api.createSession({ title: "recovered probe", directory: process.cwd() });
  `)
  try {
    await promisify(execFile)("node", [script], { windowsHide: true, timeout: 15_000, env: { ...process.env, XDG_STATE_HOME: stateHome, OPENCODE_BIN: join(stateHome, "missing-opencode.exe") } })
    expect(fixture.state.openapiReads).toBe(2)
    expect(fixture.state.created).toBe(1)
  } finally { await fixture.close() }
}, 20_000)
