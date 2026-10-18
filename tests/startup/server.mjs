import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { createBackend } from "../../src/backend.mjs"
import { createUiServer } from "../../src/ui-server.mjs"
let calls = 0
let ready = false
let pending
const upstream = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" })
  response.end(`<!doctype html><html><head></head><body><h1>Official OpenCode fixture</h1><div id="route"></div><script>document.getElementById('route').textContent=location.pathname+location.search+location.hash</script></body></html>`)
})
await new Promise((done) => upstream.listen(0, "127.0.0.1", done))
const info = { url: `http://127.0.0.1:${upstream.address().port}`, password: "fixture" }
const backend = createBackend({ service: {
  discover: async () => ready ? info : undefined,
  resolve: () => { calls++; return new Promise((done, fail) => { pending = { done: () => { ready = true; done(info) }, fail: () => fail(new Error("fixture failure")) } }) },
} })
const server = createUiServer({ overlayDir: fileURLToPath(new URL("../../webui", import.meta.url)), lazy: true, backend })
const handler = server.listeners("request").at(-1)
server.removeListener("request", handler)
server.on("request", (request, response) => {
  // Do not execute the real overlay on a synthetic upstream page.
  if (request.url.startsWith("/scripts/")) { response.writeHead(200, { "content-type": "text/javascript" }); return response.end("") }
  if (request.url === "/__test/state") { response.writeHead(200, { "content-type": "application/json" }); return response.end(JSON.stringify({ calls, ready })) }
  if (request.url === "/__test/reset") { ready = false; calls = 0; pending = undefined; return response.end("ok") }
  if (request.url === "/__test/release") { pending?.done(); return response.end("ok") }
  if (request.url === "/__test/fail") { pending?.fail(); return response.end("ok") }
  return handler(request, response)
})
server.listen(53130, "127.0.0.1")
