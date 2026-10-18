import { createServer } from "node:http"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { discover, authorization } from "../../src/service.mjs"
import { patch } from "./patch.mjs"
import { createGroups } from "./groups.mjs"

// After capture, benchmarks run offline from the identical asset snapshot.
const service = process.env.OCW_FETCH_MISSING === "1" ? await discover() : undefined
const manifest = JSON.parse(await readFile(new URL("../runtime-fold/.cache/manifest.json", import.meta.url)))
const mode = process.env.OCW_GROUP_MODE ?? "grouped"
const runtime = (await readFile(new URL("./runtime.js", import.meta.url), "utf8")).replace("// GROUP_ENGINE", createGroups.toString()).replace("__GROUP_ENABLED__", String(mode === "grouped"))
const assets = new Map()
const cache = new URL("./.cache/assets/", import.meta.url)
await mkdir(cache, { recursive: true })
async function asset(path) {
  if (assets.has(path)) return assets.get(path)
  const file = new URL(createHash("sha256").update(path).digest("hex") + ".json", cache)
  let item
  try { item = JSON.parse(await readFile(file, "utf8")); item.body = Buffer.from(item.body, "base64") } catch (error) {
    if (error.code !== "ENOENT") throw error
    if (!service) throw new Error(`Asset missing from offline snapshot: ${path}`)
    const response = await fetch(new URL(path, service.url), { headers: { authorization: authorization(service) }, signal: AbortSignal.timeout(30000) })
    item = { status: response.status, type: response.headers.get("content-type") ?? "application/octet-stream", body: Buffer.from(await response.arrayBuffer()) }
    if (response.ok) await writeFile(file, JSON.stringify({ ...item, body: item.body.toString("base64") }))
  }
  assets.set(path, item)
  return item
}
const official = await asset(manifest.asset)
const result = patch(official.body.toString("utf8"), mode)
if (!result.applied) throw new Error(`Unsupported release: ${result.hash}`)
assets.set(manifest.asset, { ...official, body: Buffer.from(result.code) })
const audit = { mode, version: manifest.version, offline: !service, hash: result.hash, blocked: 0 }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost")
  const send = (status, type, body) => { response.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-length": Buffer.byteLength(body) }); response.end(body) }
  if (url.pathname === "/__research/status") return send(200, "application/json", JSON.stringify(audit))
  if (url.pathname === "/__research/runtime.js") return send(200, "text/javascript", runtime)
  if (!["GET", "HEAD"].includes(request.method) || /^\/(api|auth)(\/|$)/.test(url.pathname)) { audit.blocked++; return send(502, "text/plain", "Only isolated fixture API traffic is allowed") }
  if (["/sw.js", "/registerSW.js"].includes(url.pathname)) return send(404, "text/plain", "disabled")
  const path = url.pathname.startsWith("/_assets/") || /\.(png|svg|ico|woff2?|webmanifest)$/.test(url.pathname) ? url.pathname : "/"
  try {
    const item = await asset(path)
    const body = item.type.startsWith("text/html") ? item.body.toString("utf8").replace("</body>", '<script src="/__research/runtime.js"></script></body>') : item.body
    send(item.status, item.type, body)
  } catch (error) { send(502, "text/plain", error.message) }
})
server.listen(Number(process.env.OCW_GROUP_PORT ?? 53127), "127.0.0.1", () => console.log(JSON.stringify(audit)))
