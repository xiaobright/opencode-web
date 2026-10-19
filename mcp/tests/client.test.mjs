import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startFixture } from "./fixture.mjs"

test("the Node HTTP client never replays accepted writes but retries safe reads and waits", async () => {
  const fixture = await startFixture({ dropResponses: { create: 1, prompt: 1, messages: 1, wait: 1 } })
  const stateHome = mkdtempSync(join(tmpdir(), "ocw-mcp-client-"))
  mkdirSync(join(stateHome, "opencode"))
  writeFileSync(join(stateHome, "opencode", "service.json"), JSON.stringify({ url: fixture.url, password: "fixture" }))
  const source = `
    import assert from "node:assert/strict";
    import * as api from ${JSON.stringify(new URL("../opencode.mjs", import.meta.url).href)};
    await assert.rejects(api.createSession({ title: "lost response", directory: process.cwd() }), /not retried/);
    const session = await api.createSession({ title: "another task", directory: process.cwd() });
    await assert.rejects(api.prompt(session.id, "execute once"), /not retried/);
    await api.wait(session.id, 5000);
    const messages = await api.messages(session.id);
    assert.equal(messages.filter(message => message.type === "user").length, 1);
    assert.equal(messages[0].outcome, "succeeded");
    console.log("safe retry policy passed");
  `
  try {
    const result = await promisify(execFile)("node", ["--input-type=module", "--eval", source], {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, XDG_STATE_HOME: stateHome, OPENCODE_BIN: join(stateHome, "missing-opencode.exe") },
    })
    expect(result.stdout).toContain("safe retry policy passed")
    expect(fixture.state.created).toBe(2)
    expect(fixture.state.prompts).toBe(1)
    expect(fixture.state.messageReads).toBe(2)
    expect(fixture.state.waits).toBe(2)
  } finally {
    await fixture.close()
  }
}, 20_000)
