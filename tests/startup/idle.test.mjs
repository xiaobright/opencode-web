import { test, expect } from "bun:test"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { autoSleep, idleVerdict } from "../../src/idle.mjs"
import { createBackend } from "../../src/backend.mjs"
import { createUiServer } from "../../src/ui-server.mjs"

const overlayDir = fileURLToPath(new URL("../../webui", import.meta.url))
async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}

test("autoSleep defaults to 15 minutes and honours the escape hatches", () => {
  expect(autoSleep({})).toEqual({ enabled: true, minutes: 15, ms: 900_000 })
  expect(autoSleep({ OPENCODE_WEB_IDLE_MINUTES: "2" })).toEqual({ enabled: true, minutes: 2, ms: 120_000 })
  expect(autoSleep({ OPENCODE_WEB_IDLE_MINUTES: "0.5" }).ms).toBe(30_000)
  expect(autoSleep({ OPENCODE_WEB_SLEEP: "0" }).enabled).toBe(false)
  expect(autoSleep({ OPENCODE_WEB_IDLE_MINUTES: "nonsense" }).enabled).toBe(false)
  expect(autoSleep({ OPENCODE_WEB_IDLE_MINUTES: "-3" }).enabled).toBe(false)
})

test("verdict keeps the service while any signal is alive and sleeps once all are quiet", () => {
  const ms = 60_000
  expect(idleVerdict({ streams: 1, idleFor: 10 * ms, sessionAge: 10 * ms, ms }).action).toBe("keep")
  expect(idleVerdict({ streams: 0, idleFor: 10, sessionAge: 10 * ms, ms }).reason).toBe("the web UI was used recently")
  expect(idleVerdict({ streams: 0, idleFor: 10 * ms, sessionAge: 10, ms }).reason).toBe("a session was used recently")
  expect(idleVerdict({ streams: 0, idleFor: 10 * ms, sessionAge: 10 * ms, ms })).toEqual({
    action: "sleep",
    reason: "no web use, no event stream and no session activity for 1 minutes",
  })
})

// The service fixture answers /api/session the way the real one does; `updated` drives the
// shared-with-TUI guard, and `stop` is the CLI call the sweep makes when it decides to sleep.
// "now" answers with the current time on every request, the way an actively used TUI does.
function serviceFixture({ updated } = {}) {
  const state = { started: false, stopped: 0, sessionRequests: 0 }
  const upstream = createServer((request, response) => {
    if (request.url.startsWith("/api/session")) {
      state.sessionRequests++
      response.writeHead(200, { "content-type": "application/json" })
      const stamp = updated === "now" ? Date.now() : updated
      response.end(JSON.stringify({ data: stamp === undefined ? [] : [{ time: { updated: stamp } }] }))
      return
    }
    response.writeHead(404, { "content-type": "text/plain" })
    response.end("fixture")
  })
  const backend = createBackend({
    service: {
      discover: async () => (state.started ? info : undefined),
      resolve: async () => { state.started = true; return info },
      stop: async () => { state.stopped++; state.started = false },
    },
  })
  const info = { url: "", password: "fixture" }
  return { state, backend, upstream, info }
}

test("idle sweep stops the service, retires the backend, and a later request starts it again", async () => {
  const fixture = serviceFixture({ updated: 0 })
  fixture.info.url = await listen(fixture.upstream)
  const server = createUiServer({ overlayDir, backend: fixture.backend, idleMs: 60, sweepMs: 20 })
  const url = await listen(server)
  try {
    expect((await (await fetch(`${url}/__opencode-web`)).json()).autoSleep.minutes).toBeCloseTo(0.001, 5)
    await fixture.backend.start()
    expect(fixture.backend.phase).toBe("ready")
    await Bun.sleep(250)
    expect(fixture.state.stopped).toBe(1)
    expect(fixture.backend.phase).toBe("idle")

    // A page open after the sleep starts the service again, the way a fresh cold open does.
    expect(await (await fetch(`${url}/anything`)).text()).toBe("fixture")
    expect(fixture.backend.phase).toBe("ready")
    expect(fixture.state.stopped).toBe(1)
  } finally { await close(server); await close(fixture.upstream) }
}, 5000)

test("a session used inside the window keeps the shared service alive", async () => {
  const fixture = serviceFixture({ updated: "now" })
  fixture.info.url = await listen(fixture.upstream)
  const server = createUiServer({ overlayDir, backend: fixture.backend, idleMs: 60, sweepMs: 20 })
  const url = await listen(server)
  try {
    await fixture.backend.start()
    await Bun.sleep(250)
    expect(fixture.state.stopped).toBe(0)
    expect(fixture.state.sessionRequests).toBeGreaterThan(0)
    expect((await (await fetch(`${url}/__opencode-web`)).json()).backend).toBe("ready")
  } finally { await close(server); await close(fixture.upstream) }
}, 5000)

test("a gateway request inside the window keeps the service awake, the tray probe does not", async () => {
  const fixture = serviceFixture({ updated: 0 })
  fixture.info.url = await listen(fixture.upstream)
  const server = createUiServer({ overlayDir, backend: fixture.backend, idleMs: 90, sweepMs: 15 })
  const url = await listen(server)
  try {
    await fixture.backend.start()
    for (let i = 0; i < 12; i++) {
      // The tray polls exactly this path every 2s: it must not count as activity.
      expect((await fetch(`${url}/__opencode-web`)).status).toBe(200)
      // Any other request is somebody using the UI.
      expect((await fetch(`${url}/some-asset`)).status).toBe(404)
      await Bun.sleep(10)
    }
    expect(fixture.state.stopped).toBe(0)
  } finally { await close(server); await close(fixture.upstream) }
}, 5000)

test("disabled auto-sleep never stops the service and reports nothing in the metadata", async () => {
  const fixture = serviceFixture({ updated: 0 })
  fixture.info.url = await listen(fixture.upstream)
  const server = createUiServer({ overlayDir, backend: fixture.backend, idleMs: 0 })
  const url = await listen(server)
  try {
    await fixture.backend.start()
    await Bun.sleep(150)
    expect(fixture.state.stopped).toBe(0)
    const meta = await (await fetch(`${url}/__opencode-web`)).json()
    expect(meta.autoSleep).toBeUndefined()
    expect(meta.backend).toBe("ready")
  } finally { await close(server); await close(fixture.upstream) }
}, 5000)
