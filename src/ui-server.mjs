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
import { authorization, resolve as resolveService } from "./service.mjs"

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

export function createUiServer({ overlayDir, log = () => {} }) {
  const overlay = resolve(overlayDir)

  return createServer((request, response) => {
    const url = new URL(request.url, "http://localhost")

    // Lets a second invocation of `bun run start` notice this server instead of starting another.
    if (url.pathname === "/__opencode-web")
      return void end(
        response,
        200,
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        JSON.stringify({ ok: true, pid: process.pid }),
      )

    const isApi = PROXY_PATHS.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix))
    const shell = isApi ? undefined : overlayShell(overlay)
    const inject = shell ? { styles: [], scripts: [] } : { styles: overlayStyles(overlay), scripts: overlayScripts(overlay) }

    if (!isApi && (request.method === "GET" || request.method === "HEAD")) {
      const file = overlayFile(overlay, url.pathname)
      if (file) return void sendFile(request, response, file)

      // No service worker unless the overlay ships one: a precache would keep serving the official
      // assets after an overlay file replaces one of them.
      if (url.pathname === "/sw.js" || url.pathname === "/registerSW.js")
        return void end(response, 404, { "cache-control": "no-store" })
    }

    return void proxy(request, response, log, shell, inject)
  })
}

async function proxy(request, response, log, shell, overlay) {
  let service
  try {
    service = await resolveService({ onStart: () => log("starting the opencode background service") })
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
