// One local process. It reverse-proxies the opencode background service, serves the webui/ overlay on
// top of the UI that service already ships, and opens the browser. Nothing else: no Electron, no
// dependencies, no daemon of its own.
//
//   bun run start                      start and open the browser
//   bun run start -- --port 8080       another port
//   bun run start -- --host 0.0.0.0    also listen on the LAN (no authentication; see README)
//   bun run start -- --no-open         do not open a browser
//   bun run start -- --lazy            gateway only; backend starts on page open
//   bun run start -- --lazy --open     show the loading page and start on demand
//
// Running it twice does not start a second server: the second run opens the browser and exits.

import { spawn } from "node:child_process"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createUiServer, overlayScripts, overlayStyles } from "./ui-server.mjs"
import { createBackend } from "./backend.mjs"
import { autoSleep } from "./idle.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const overlayDir = join(root, "webui")
const pidFile = join(root, ".opencode-web.pid")
const log = (message) => console.log(`[opencode-web] ${message}`)

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const port = Number(option("port", process.env.OPENCODE_WEB_PORT ?? 53123))
const host = option("host", process.env.OPENCODE_WEB_HOST ?? "127.0.0.1")
const lazy = args.includes("--lazy")
const shouldOpen = !args.includes("--no-open") && (!lazy || args.includes("--open"))

// A wildcard bind answers on loopback as well, so the local probe and the browser keep using
// 127.0.0.1 whatever the listening address is.
const loopback = { "0.0.0.0": "127.0.0.1", "::": "127.0.0.1" }[host] ?? host
const exposed = !["127.0.0.1", "localhost", "::1"].includes(host)

const running = await probe(httpUrl(loopback, port) + "__opencode-web")
if (running) {
  log(`already running on ${httpUrl(loopback, port)} (pid ${running.pid})`)
  if (shouldOpen) openBrowser(httpUrl(loopback, port))
  process.exit(0)
}

const backend = createBackend({ log })
const server = createUiServer({ overlayDir, log, lazy, backend })
const address = await listen(server, port, host)
const url = httpUrl("127.0.0.1", address)

writeFileSync(pidFile, String(process.pid))
log(`web UI on ${url}`)

// Binding beyond loopback is opt-in and carries no login: opencode can run tools, so everyone on
// the network who reaches this port runs them as this user. Say so, every start.
if (exposed) {
  for (const { name, url: lan } of lanUrls(host, address)) log(`LAN (${name}): ${lan}`)
  log("no authentication: anyone who can reach that address can use opencode and its tools")
}
const styles = overlayStyles(overlayDir)
const scripts = overlayScripts(overlayDir)
const injected = [
  styles.length > 0 ? `styles ${styles.map((file) => basename(file)).join(", ")}` : undefined,
  scripts.length > 0 ? `scripts ${scripts.map((file) => basename(file)).join(", ")}` : undefined,
].filter(Boolean)

log(
  existsSync(join(overlayDir, "index.html"))
    ? "webui/index.html replaces the official page shell"
    : injected.length > 0
      ? `webui/ injects ${injected.join(" and ")} into the official page shell`
      : "webui/ has nothing to apply; serving the UI as the opencode service ships it",
)

if (lazy) {
  log("standby: the gateway is ready; OpenCode starts when the web UI is opened")
} else {
  try {
    const service = await backend.start()
    log(`opencode ${service.info?.version ?? service.version} at ${service.url}`)
  } catch (error) {
    log(`no background service yet: ${error.message}`)
    log("the UI will connect as soon as one is available")
  }
}

const sleep = autoSleep()
if (sleep.enabled)
  log(`auto-sleep: the background service stops after ${sleep.minutes} idle minutes (OPENCODE_WEB_IDLE_MINUTES to tune, OPENCODE_WEB_SLEEP=0 to disable)`)

if (shouldOpen) openBrowser(url)
log("press Ctrl+C to stop")

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown)

function shutdown() {
  server.close()
  rmSync(pidFile, { force: true })
  process.exit(0)
}

async function listen(target, requested, hostname) {
  for (const candidate of [requested, ...Array.from({ length: 9 }, (_, index) => requested + index + 1), 0]) {
    const bound = await bind(target, candidate, hostname).catch(() => undefined)
    if (bound !== undefined) return bound
  }
  throw new Error(`No free port near ${requested}`)
}

function bind(target, candidate, hostname) {
  return new Promise((done, fail) => {
    const failed = (error) => {
      target.off("listening", listening)
      fail(error)
    }
    const listening = () => {
      target.off("error", failed)
      done(target.address().port)
    }
    target.once("error", failed)
    target.once("listening", listening)
    target.listen(candidate, hostname)
  })
}

function httpUrl(hostname, port) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}/`
}

// Every IPv4 address a client on another device can type. A wildcard bind listens on all of them,
// including virtual adapters (VMware, WSL), which is why they are named in the log.
function lanUrls(hostname, port) {
  if (hostname !== "0.0.0.0" && hostname !== "::") return [{ name: "bound address", url: httpUrl(hostname, port) }]

  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => ({ name, url: httpUrl(address.address, port) })),
  )
}

function openBrowser(url) {
  const [file, argv] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]]

  spawn(file, argv, { detached: true, stdio: "ignore", windowsHide: true }).unref()
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}
