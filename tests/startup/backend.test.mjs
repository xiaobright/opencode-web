import { test, expect } from "bun:test"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
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

test("backend shares concurrent startup, clears failures, and discovers without starting", async () => {
  let calls = 0
  let release
  let fail = true
  const backend = createBackend({ service: {
    discover: async () => undefined,
    resolve: () => { calls++; return new Promise((done, reject) => { release = () => fail ? reject(new Error("fixture")) : done({ url: "fixture" }) }) },
  } })
  expect(await backend.discover()).toBeUndefined()
  expect(calls).toBe(0)
  const one = backend.start()
  const two = backend.start()
  expect(one).toBe(two)
  await Promise.resolve()
  expect(backend.phase).toBe("starting")
  release()
  await expect(one).rejects.toThrow("fixture")
  expect(backend.phase).toBe("error")
  fail = false
  const retry = backend.start()
  await Promise.resolve()
  release()
  expect(await retry).toEqual({ url: "fixture" })
  expect(calls).toBe(2)
  expect(backend.phase).toBe("ready")
})

test("lazy gateway probes and assets stay idle, same-origin activation is shared, and backend auth stays private", async () => {
  let calls = 0
  let started = false
  let release
  let authorization
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<!doctype html><html><head></head><body>Official fixture</body></html>")
  })
  const upstreamUrl = await listen(upstream)
  const info = { url: upstreamUrl, password: "fixture-private-password" }
  const backend = createBackend({ service: {
    discover: async () => started ? info : undefined,
    resolve: () => { calls++; return new Promise((done) => { release = () => { started = true; done(info) } }) },
  } })
  const server = createUiServer({ overlayDir, lazy: true, backend })
  const url = await listen(server)
  try {
    expect((await (await fetch(`${url}/__opencode-web`)).json()).mode).toBe("lazy")
    expect((await fetch(`${url}/__opencode-web/icon.ico`)).status).toBe(200)
    expect((await fetch(`${url}/__opencode-web/loading.js`)).status).toBe(200)
    expect((await fetch(`${url}/api/info`)).status).toBe(503)
    const loading = await (await fetch(`${url}/server/key/session/example?view=review`, { headers: { accept: "text/html" } })).text()
    expect(loading).toContain("正在加载")
    expect(calls).toBe(0)
    expect((await fetch(`${url}/__opencode-web/start`)).status).toBe(405)
    expect((await fetch(`${url}/__opencode-web/start`, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(403)
    expect(calls).toBe(0)
    const first = fetch(`${url}/__opencode-web/start`, { method: "POST", headers: { origin: url } })
    const second = fetch(`${url}/__opencode-web/start`, { method: "POST", headers: { origin: url } })
    while (!release) await new Promise((done) => setTimeout(done, 5))
    release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(calls).toBe(1)
    const official = await (await fetch(`${url}/server/key/session/example?view=review`, { headers: { accept: "text/html" } })).text()
    expect(official).toContain("Official fixture")
    expect(official).toContain("/scripts/codex-shell.js")
    expect(official).not.toContain(info.password)
    expect(authorization).toBe(`Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`)
    started = false
    expect(await (await fetch(`${url}/`, { headers: { accept: "text/html" } })).text()).toContain("正在加载")
  } finally { await close(server); await close(upstream) }
})

test("normal gateway still starts its backend on a proxy request", async () => {
  let calls = 0
  const upstream = createServer((_, response) => response.end("normal mode"))
  const upstreamUrl = await listen(upstream)
  const backend = createBackend({ service: { discover: async () => undefined, resolve: async () => { calls++; return { url: upstreamUrl, password: "fixture" } } } })
  const server = createUiServer({ overlayDir, backend })
  const url = await listen(server)
  try {
    expect(await (await fetch(url)).text()).toBe("normal mode")
    expect(calls).toBe(1)
  } finally { await close(server); await close(upstream) }
})
