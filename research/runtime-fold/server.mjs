import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { discover, authorization } from "../../src/service.mjs"
import { patchTimeline } from "./patch.mjs"
import { foldProjection } from "./project.mjs"

const service = await discover()
if (!service) throw new Error("Experiment needs an existing service; it will never start one")
const manifest = JSON.parse(await readFile(new URL("./.cache/manifest.json", import.meta.url), "utf8"))
const mode = process.env.OCW_RESEARCH_MODE ?? "patched"
const runtime = (await readFile(new URL("./runtime.js", import.meta.url), "utf8")).replace("// PROJECT_FUNCTION", foldProjection.toString())
const assets = new Map()
const audit = { mode, version: service.version, applied: false, reason: "not-checked", apiRequestsBlocked: 0 }
async function asset(path) {
  if (assets.has(path)) return assets.get(path)
  const response = await fetch(new URL(path, service.url), { headers: { authorization: authorization(service) }, signal: AbortSignal.timeout(20000) })
  const body = Buffer.from(await response.arrayBuffer())
  const item = { status: response.status, type: response.headers.get("content-type") ?? "application/octet-stream", body }
  assets.set(path, item)
  return item
}
const original = await asset(manifest.asset)
const result = patchTimeline(original.body.toString("utf8") + (mode === "incompatible" ? "\n/* unknown build */" : ""), { eagerLimit: mode === "eager" ? 300 : 0 })
audit.applied = ["patched", "eager"].includes(mode) && result.applied
audit.reason = mode === "baseline" ? "disabled" : result.reason
if (mode !== "baseline") assets.set(manifest.asset, { ...original, body: Buffer.from(result.code) })

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost")
  const send = (status, type, body) => {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-length": Buffer.byteLength(body), "x-ocw-research": audit.applied ? "patched" : "original" })
    response.end(body)
  }
  if (url.pathname === "/__research/status") return send(200, "application/json", JSON.stringify(audit))
  if (url.pathname === "/__research/runtime.js") return send(200, "text/javascript", runtime)
  // All real API access is prohibited. The browser tests own fake API responses.
  if (!["GET", "HEAD"].includes(request.method) || /^\/(api|auth)(\/|$)/.test(url.pathname)) {
    audit.apiRequestsBlocked++
    return send(502, "text/plain", "API must be supplied by isolated fixture")
  }
  if (["/sw.js", "/registerSW.js"].includes(url.pathname)) return send(404, "text/plain", "disabled")
  const path = url.pathname.startsWith("/_assets/") || /\.(png|svg|ico|woff2?|webmanifest)$/.test(url.pathname) ? url.pathname : "/"
  try {
    const item = await asset(path)
    const body = item.type.startsWith("text/html") && audit.applied
      ? item.body.toString("utf8").replace("</body>", '<script src="/__research/runtime.js"></script></body>')
      : item.body
    send(item.status, item.type, body)
  } catch (error) {
    send(502, "text/plain", `Asset retrieval failed: ${error.message}`)
  }
})
server.listen(Number(process.env.OCW_RESEARCH_PORT ?? 53124), "127.0.0.1", () => console.log(JSON.stringify(audit)))
