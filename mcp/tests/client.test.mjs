import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startFixture } from "./fixture.mjs"

test("Node retries stable-ID admission, reads and waits, but never replays interrupt", async () => {
  const fixture = await startFixture({ dropResponses: { create: 1, prompt: 1, messages: 1, wait: 1, interrupt: 1 } })
  const stateHome = mkdtempSync(join(tmpdir(), "ocw-mcp-client-"))
  mkdirSync(join(stateHome, "opencode"))
  writeFileSync(join(stateHome, "opencode", "service.json"), JSON.stringify({ url: fixture.url, password: "fixture" }))
  const source = `
    import assert from "node:assert/strict";
    import * as api from ${JSON.stringify(new URL("../opencode.mjs", import.meta.url).href)};
    const session = await api.createSession({ title: "lost response", directory: process.cwd() });
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
    expect(fixture.state.created).toBe(1)
    expect(fixture.state.prompts).toBe(1)
    expect(fixture.state.messageReads).toBe(2)
    expect(fixture.state.waits).toBe(2)
    expect(fixture.state.interrupts).toBe(1)
  } finally {
    await fixture.close()
  }
}, 20_000)
