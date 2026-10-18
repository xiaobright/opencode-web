import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { createHash } from "node:crypto"
import { overlayScripts, overlayStyles } from "../../src/ui-server.mjs"
import { fileURLToPath } from "node:url"
const overlay = fileURLToPath(new URL("../../webui", import.meta.url))
const enabled = process.env.OCW_ACTIVITY_MODE !== "baseline"
const scripts = overlayScripts(overlay).filter((path) => enabled || !basename(path).startsWith("activity-"))
const styles = overlayStyles(overlay).filter((path) => enabled || !basename(path).startsWith("activity-"))
const local = new Map([...scripts.map((path) => [`/scripts/${basename(path)}`, path]), ...styles.map((path) => [`/styles/${basename(path)}`, path])])
const cache = new Map()
createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost")
  const send = (status, type, body) => { response.writeHead(status, { "content-type": type, "cache-control": "no-store" }); response.end(body) }
  if (url.pathname === "/__test/status") return send(200, "application/json", JSON.stringify({ enabled, offline: true }))
  if (request.method !== "GET" || /^\/(api|auth)(\/|$)/.test(url.pathname)) return send(502, "text/plain", "Test fixture API only")
  if (["/sw.js", "/registerSW.js"].includes(url.pathname)) return send(404, "text/plain", "disabled")
  try {
    if (local.has(url.pathname)) return send(200, url.pathname.endsWith(".css") ? "text/css" : "text/javascript", await readFile(local.get(url.pathname)))
    const path = url.pathname.startsWith("/_assets/") || /\.(png|svg|ico|woff2?|webmanifest)$/.test(url.pathname) ? url.pathname : "/"
    if (!cache.has(path)) {
      const file = new URL(`../../research/turn-fold/.cache/assets/${createHash("sha256").update(path).digest("hex")}.json`, import.meta.url)
      const item = JSON.parse(await readFile(file, "utf8"))
      cache.set(path, { ...item, body: Buffer.from(item.body, "base64") })
    }
    const item = cache.get(path)
    const body = item.type.startsWith("text/html") ? item.body.toString("utf8").replace("</head>", styles.map((path) => `<link rel="stylesheet" href="/styles/${basename(path)}">`).join("") + "</head>").replace("</body>", scripts.map((path) => `<script src="/scripts/${basename(path)}"></script>`).join("") + "</body>") : item.body
    send(item.status, item.type, body)
  } catch (error) { send(502, "text/plain", error.message) }
}).listen(53128, "127.0.0.1")
