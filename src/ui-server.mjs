// One local HTTP server that belongs to this app:
//   /api/*, /auth/*, /openapi.json  -> the opencode background service, with credentials injected
//   everything else                 -> webui/<path> when that file exists, else the service's own UI
//
// The background service already serves the web UI at its own origin, so this app ships no copy of it:
// proxying `/` and `/_assets/*` keeps the UI exactly in step with the installed opencode version.
//
// webui/ is an overlay, so replacing the UI is "put a file there": webui/index.html replaces the page
// shell, webui/_assets/app.js replaces one asset, and anything you do not put there still comes from the
// official build.
//
// webui/styles/*.css is the third shape: a stylesheet that is linked into the official page shell
// instead of replacing it. That matters because the shell names its assets with content hashes, so a
// copied shell starts pointing at files that no longer exist on the next opencode upgrade, while an
// injected stylesheet keeps working. An overlay shell, when one exists, wins and gets no injection:
// it links whatever it wants itself.
//
// Because the UI is served from the origin it calls, the app's `origin` server mode needs no
// configuration, no CORS, and no sign-in: the proxied request arrives already authorized.

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { basename, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { authorization } from "./service.mjs"
import { autoSleep, idleVerdict } from "./idle.mjs"
import { createBackend } from "./backend.mjs"
import { modelRef, normalizeModel, rankModels, readRanking, selectModel, usableModels, writeRanking } from "./models.mjs"

const sourceDir = fileURLToPath(new URL(".", import.meta.url))
const loadingFiles = new Map([
  ["/__opencode-web/loading.js", join(sourceDir, "loading.js")],
  ["/__opencode-web/icon.ico", join(sourceDir, "../icons/opencode.ico")],
])

const PROXY_PATHS = ["/api", "/auth/", "/openapi.json"]

// Where injected stylesheets and scripts live inside the overlay, and the URL prefixes they are served under.
const STYLE_DIR = "styles"
const SCRIPT_DIR = "scripts"

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

// Stylesheets linked into the official page shell, in filename order so a numeric prefix controls the
// cascade. Looked up per request, like the rest of the overlay, so dropping a file in needs no restart.
export function overlayStyles(overlayDir) {
  const dir = join(resolve(overlayDir), STYLE_DIR)
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".css"))
    .sort()
    .map((name) => join(dir, name))
}

// Scripts injected into the official page shell, in filename order for the same reason. This is the layer
// that can do what a stylesheet cannot: build a rail and a sidebar as real elements around the official
// UI, and read the same `/api/*` the page itself is served from.
export function overlayScripts(overlayDir) {
  const dir = join(resolve(overlayDir), SCRIPT_DIR)
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".js"))
    .sort()
    .map((name) => join(dir, name))
}

export function createUiServer({ overlayDir, log = () => {}, lazy = false, backend = createBackend({ log }), idleMs, sweepMs }) {
  const overlay = resolve(overlayDir)

  // Auto-sleep state: the last request that was not the tray's own probe, the live event
  // streams (one per open browser tab), and how many times the service has been stopped.
  const sleep = autoSleep()
  const idleLimit = idleMs ?? sleep.ms
  const sweepEvery = sweepMs ?? Math.min(60_000, Math.max(5_000, idleLimit / 2))
  let lastTouch = Date.now()
  let streams = 0
  let sleeps = 0
  let sweeping = false
  let closed = false
  let sweepTimer

  if (idleLimit > 0) {
    sweepTimer = setInterval(() => void sweep(), sweepEvery)
    sweepTimer.unref?.()
  }

  async function sweep() {
    if (closed || sweeping || backend.phase !== "ready") return
    sweeping = true
    try {
      const verdict = idleVerdict({
        streams,
        idleFor: Date.now() - lastTouch,
        sessionAge: await newestSessionAge(),
        ms: idleLimit,
      })
      if (verdict.action === "keep") return

      try {
        // Recheck immediately before stopping: a silent tool can be busy for hours.
        // A failed/unsupported probe cannot establish that this shared service is idle.
        const found = await backend.discover()
        if (!found) return
        const response = await fetch(`${found.url}/api/session/active`, {
          headers: { authorization: authorization(found) },
          signal: AbortSignal.timeout(5_000),
        })
        if (!response.ok) return
        const body = await response.json()
        if (!body?.data || Array.isArray(body.data) || typeof body.data !== "object") return
        const latest = idleVerdict({ streams, active: Object.keys(body.data).length, idleFor: Date.now() - lastTouch, ms: idleLimit })
        if (closed || backend.phase !== "ready" || latest.action !== "sleep") return
        await backend.stop()
        backend.retire()
        sleeps++
        log(`auto-sleep: stopped the opencode background service (${verdict.reason})`)
      } catch (error) {
        log(`auto-sleep failed: ${error.message}`)
      }
    } finally {
      sweeping = false
    }
  }

  // The service is shared with the TUI and the desktop app, which never pass through this
  // gateway, so their activity is read from the service itself. An unknown answer (probe
  // failed, no sessions) counts as "quiet", while a failed probe counts as "recently used":
  // a flaky network must never stop a service somebody is on.
  async function newestSessionAge() {
    try {
      const found = await backend.discover()
      if (!found) return 0
      const response = await fetch(`${found.url}/api/session?order=desc`, {
        headers: { authorization: authorization(found) },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return 0
      const sessions = await response.json()
      const updated = Array.isArray(sessions?.data) ? sessions.data[0]?.time?.updated : undefined
      return typeof updated === "number" ? Date.now() - updated : Infinity
    } catch {
      return 0
    }
  }

  function json(response, status, body) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
    response.end(JSON.stringify(body))
  }

  // Which free model delegations use is an operator setting, edited in the web UI. This
  // endpoint reads the live catalog and the stored ranking; the MCP server reads the same
  // file, so the first row in the page is what the next delegation actually picks.
  async function models(response) {
    const ranking = readRanking()
    const models = await catalog()
    const ranked = rankModels(usableModels(models), ranking)
    const selected = selectModel(models, ranking)
    json(response, 200, {
      ok: true,
      available: models.length > 0,
      models: ranked,
      ranking,
      selected: selected ? modelRef(selected) : null,
    })
  }

  async function catalog() {
    try {
      const found = await backend.discover()
      if (!found) return []
      const response = await fetch(`${found.url}/api/model`, {
        headers: { authorization: authorization(found) },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return []
      const body = await response.json()
      return Array.isArray(body?.data) ? body.data.map(normalizeModel) : []
    } catch {
      return []
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost")

    // Everything except the tray's own metadata probe counts as "somebody is here". The
    // probe runs every 2s for as long as the icon lives, so counting it would defeat the
    // whole feature; the start POST and the loading page are real user actions and count.
    if (url.pathname !== "/__opencode-web") lastTouch = Date.now()

    // Lets a second invocation of `bun run start` notice this server instead of starting another.
    if (url.pathname === "/__opencode-web")
      return void end(
        response,
        200,
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        JSON.stringify({
          ok: true,
          pid: process.pid,
          mode: lazy ? "lazy" : "normal",
          backend: backend.phase,
          ...(idleLimit > 0
            ? { autoSleep: { minutes: idleLimit / 60_000, streams, idleForMs: Date.now() - lastTouch, sleeps } }
            : {}),
        }),
      )

    // The web UI's model ranking: read the live catalog + stored order, or save an order.
    // The MCP server reads the same file, so this page and the next delegation agree.
    if (url.pathname === "/__opencode-web/models") {
      if (request.method === "GET") return void (await models(response))
      if (request.method === "POST") {
        if (request.headers.origin !== `http://${request.headers.host}` || request.headers["sec-fetch-site"] === "cross-site")
          return void end(response, 403)
        let body
        try {
          body = JSON.parse(await readBody(request, 64 * 1024))
        } catch {
          return void end(response, 400)
        }
        if (!Array.isArray(body?.ranking) || body.ranking.some((ref) => typeof ref !== "string"))
          return void end(response, 400)
        return void json(response, 200, { ok: true, ranking: writeRanking(body.ranking) })
      }
      return void end(response, 405, { allow: "GET, POST" })
    }

    // Opening a page is the activation step; probes, icons and assets cannot
    // start OpenCode. A same-origin POST from the loading page shares startup.
    if (url.pathname === "/__opencode-web/start") {
      if (request.method !== "POST") return void end(response, 405, { allow: "POST" })
      if (request.headers.origin !== `http://${request.headers.host}` || request.headers["sec-fetch-site"] === "cross-site")
        return void end(response, 403)
      try {
        await backend.start()
        return void end(response, 200, { "content-type": "application/json", "cache-control": "no-store" }, JSON.stringify({ ready: true }))
      } catch (error) {
        log(`no background service: ${error.message}`)
        return void end(response, 503, { "content-type": "application/json", "cache-control": "no-store" }, JSON.stringify({ ready: false }))
      }
    }

    if (loadingFiles.has(url.pathname) && ["GET", "HEAD"].includes(request.method))
      return void sendFile(request, response, loadingFiles.get(url.pathname))

    const isApi = PROXY_PATHS.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix))
    const shell = isApi ? undefined : overlayShell(overlay)
    const inject = shell ? { styles: [], scripts: [] } : { styles: overlayStyles(overlay), scripts: overlayScripts(overlay) }

    if (lazy && !isApi && request.method === "GET" && (request.headers.accept ?? "").includes("text/html")) {
      // Paint immediately on a cold open, before even probing stale backend
      // registrations. The loading page performs discovery/start in its POST.
      if (backend.phase !== "ready") return void sendFile(request, response, join(sourceDir, "loading.html"))
      const found = await backend.discover()
      if (!found) return void sendFile(request, response, join(sourceDir, "loading.html"))
      return void proxy(request, response, log, shell, inject, () => Promise.resolve(found))
    }

    if (!isApi && (request.method === "GET" || request.method === "HEAD")) {
      const file = overlayFile(overlay, url.pathname)
      if (file) return void sendFile(request, response, file)

      // No service worker unless the overlay ships one: a precache would keep serving the official
      // assets after an overlay file replaces one of them.
      if (url.pathname === "/sw.js" || url.pathname === "/registerSW.js")
        return void end(response, 404, { "cache-control": "no-store" })
    }

    // A live /api/event stream means a browser tab has the UI open: it holds one for as
    // long as the tab lives, and the connection ends when the tab (or the UI) goes away.
    if (url.pathname === "/api/event") {
      streams++
      response.on("close", () => { streams-- })
    }

    return void proxy(request, response, log, shell, inject, () => lazy ? backend.discover() : backend.start())
  })
  server.on("close", () => { closed = true; clearInterval(sweepTimer) })
  return server
}

async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error("request body too large")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function proxy(request, response, log, shell, overlay, resolveBackend) {
  let service
  try {
    service = await resolveBackend()
    if (!service) return void end(response, 503, { "content-type": "text/plain; charset=utf-8", "retry-after": "1" }, "OpenCode is not running. Open the web UI to start it.\n")
  } catch (error) {
    log(`no background service: ${error.message}`)

    return void end(response, 502, { "content-type": "text/plain; charset=utf-8" }, `opencode service unavailable\n`)
  }

  const target = new URL(service.url)
  const headers = { ...request.headers, host: target.host }
  if (headers.authorization === undefined) headers.authorization = authorization(service)

  // Injection rewrites the response body, so that response has to arrive uncompressed. Only navigations
  // are asked for identity: they are what carries a page shell, and this hop is loopback, so giving up
  // compression on them costs nothing while `_assets/*` keeps its encoding.
  const wantsShell =
    (overlay.styles.length > 0 || overlay.scripts.length > 0) &&
    request.method !== "HEAD" &&
    (request.headers.accept ?? "").includes("text/html")
  if (wantsShell) delete headers["accept-encoding"]

  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      // The service answers every unknown route with its own html shell. When the overlay has a shell of
      // its own, that shell owns deep links too, otherwise a client-side route would quietly load the
      // official page instead of the replaced one.
      if (shell && isHtml(upstreamResponse)) {
        upstreamResponse.resume()
        return void sendFile(request, response, shell)
      }

      if (wantsShell && isHtml(upstreamResponse) && upstreamResponse.headers["content-encoding"] === undefined)
        return void injectOverlay(response, upstreamResponse, overlay)

      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    },
  )

  upstream.on("error", (error) => {
    log(`proxy to ${target.origin} failed: ${error.message}`)
    if (!response.headersSent) end(response, 502, { "content-type": "text/plain; charset=utf-8" }, "proxy failed\n")
    else response.destroy()
  })

  request.pipe(upstream)
}

// webui/<path> mirrors the URL path, so /_assets/app.js is replaced by webui/_assets/app.js and / by
// webui/index.html. A path with no overlay file falls through to the service, which is what makes
// partial replacement work: replace index.html alone and every asset still comes from the official build.
function overlayFile(overlay, pathname) {
  const key = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html"
  const candidate = resolve(overlay, key)
  if (candidate !== overlay && !candidate.startsWith(overlay + sep)) return undefined
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined
}

// Looked up per request so dropping the file in takes effect without a restart.
function overlayShell(overlay) {
  const shell = join(overlay, "index.html")
  return existsSync(shell) ? shell : undefined
}

// The shell's asset names carry content hashes, so styles and scripts are injected into the official
// shell rather than a copy of it being kept around: the markup is still the one the installed opencode
// ships, so nothing here can go stale on an upgrade. Stylesheet links go last in the head, which is what
// lets an unlayered stylesheet beat the app's own `@layer theme` tokens without out-specifying anything.
// Scripts go last in the body as classic scripts, so they run before the app's deferred module bundle
// and can therefore act on the page before the app mounts.
function injectOverlay(response, upstreamResponse, overlay) {
  const chunks = []
  upstreamResponse.on("data", (chunk) => chunks.push(chunk))
  upstreamResponse.on("error", () => response.destroy())

  upstreamResponse.on("end", () => {
    const raw = Buffer.concat(chunks)
    const patched = rewriteShell(raw.toString("utf8"), overlay)

    // Nothing to rewrite means this is not the app shell; hand back exactly what was received.
    if (patched === undefined) {
      response.writeHead(upstreamResponse.statusCode ?? 200, upstreamResponse.headers)
      return void response.end(raw)
    }

    // The upstream answer is chunked, so its framing headers have to go before the rewritten body can
    // carry a length of its own; leaving both on makes a response no client will parse.
    const headers = { ...upstreamResponse.headers }
    delete headers["transfer-encoding"]
    delete headers["content-encoding"]
    headers["content-length"] = String(Buffer.byteLength(patched))

    response.writeHead(upstreamResponse.statusCode ?? 200, headers)
    response.end(patched)
  })
}

function rewriteShell(html, overlay) {
  const links = overlay.styles.map((file) => `<link rel="stylesheet" href="/${STYLE_DIR}/${basename(file)}">`).join("")
  const tags = overlay.scripts.map((file) => `<script src="/${SCRIPT_DIR}/${basename(file)}"></script>`).join("")

  const head = links && html.includes("</head>") ? html.replace("</head>", `${links}</head>`) : html
  const body = tags && head.includes("</body>") ? head.replace("</body>", `${tags}</body>`) : head

  return head === html && body === html ? undefined : body
}

function isHtml(upstreamResponse) {
  return (upstreamResponse.headers["content-type"] ?? "").startsWith("text/html")
}

function sendFile(request, response, file) {
  // Overlay files are written by hand and usually edited while the server runs, so they are never cached.
  const headers = {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  }

  if (request.method === "HEAD") return void end(response, 200, headers)

  response.writeHead(200, headers)
  createReadStream(file).pipe(response)
}

function end(response, status, headers = {}, body = "") {
  response.writeHead(status, headers)
  response.end(body)
}
