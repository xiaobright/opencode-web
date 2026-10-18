import { test, expect } from "bun:test"
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

test("real --lazy entry listens without starting backend, opens no browser, and second launch exits", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url))
  const cache = join(root, "tests/startup/.cache")
  mkdirSync(cache, { recursive: true })
  const fixture = mkdtempSync(join(cache, "cli-"))
  cpSync(join(root, "src"), join(fixture, "src"), { recursive: true })
  mkdirSync(join(fixture, "webui"))
  // Any accidental backend start fails immediately and appears in the output.
  const env = { ...process.env, OPENCODE_BIN: join(fixture, "no-backend.exe"), XDG_STATE_HOME: join(fixture, "state") }
  const child = spawn(process.execPath, [join(fixture, "src/start.mjs"), "--lazy", "--port", "0"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  const exited = new Promise((done) => child.on("exit", done))
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  try {
    const deadline = Date.now() + 5000
    while (!output.includes("standby:") && Date.now() < deadline) await Bun.sleep(10)
    const url = /web UI on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)?.[1]
    expect(url).toBeDefined()
    expect((await (await fetch(`${url}__opencode-web`)).json()).backend).toBe("idle")
    expect(readFileSync(join(fixture, ".opencode-web.pid"), "utf8")).toBe(String(child.pid))
    const second = spawn(process.execPath, [join(fixture, "src/start.mjs"), "--lazy", "--port", new URL(url).port], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let secondOutput = ""
    second.stdout.on("data", (chunk) => { secondOutput += chunk })
    const code = await new Promise((done) => second.on("exit", done))
    expect(code).toBe(0)
    expect(secondOutput).toContain("already running")
    expect(output).not.toContain("starting the opencode background service")
    expect(output).not.toContain("no background service")
    expect((await (await fetch(`${url}__opencode-web`)).json()).backend).toBe("idle")
  } finally { child.kill(); await exited }
}, 10000)
