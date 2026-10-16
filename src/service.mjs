// Finds or starts the opencode background service.
//
// Discovery is the registration file the CLI writes itself:
//   <XDG_STATE_HOME|~/.local/state>/opencode/service.json          (dev/beta/latest/next channels)
//   <XDG_STATE_HOME|~/.local/state>/opencode/service-<channel>.json (any other channel)
// It carries url, pid, version and the private password. Reading it is all a client needs.

import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROBE_TIMEOUT_MS = 5_000
const START_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 500

export function stateDirectory() {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode")
}

export function cliPath() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN

  const installed =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe")
      : undefined

  return installed && existsSync(installed) ? installed : "opencode"
}

/** The `Authorization` header a client uses for the local service. */
export function authorization(info) {
  return `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`
}

/** `/api/info` answers only an authorized caller, so a 200 proves url + password both work. */
export async function health(info) {
  try {
    const response = await fetch(`${info.url}/api/info`, {
      headers: { authorization: authorization(info) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  }
}

/** Registered services, newest registration first. */
export function registrations() {
  const directory = stateDirectory()
  if (!existsSync(directory)) return []

  return readdirSync(directory)
    .filter((name) => /^service(-[A-Za-z0-9._-]+)?\.json$/.test(name))
    .map((name) => join(directory, name))
    .sort((left, right) => modificationTime(right) - modificationTime(left))
    .map((file) => {
      try {
        const info = JSON.parse(readFileSync(file, "utf8"))
        return typeof info?.url === "string" && typeof info?.password === "string" ? info : undefined
      } catch {
        return undefined
      }
    })
    .filter((info) => info !== undefined)
}

/** An already-running, reachable service, or undefined. Never starts one. */
export async function discover() {
  for (const info of registrations()) {
    const infoResponse = await health(info)
    if (infoResponse) return { ...info, info: infoResponse }
  }
  return undefined
}

/** Discover a healthy service, starting the background service when none is running. */
export async function resolve({ onStart } = {}) {
  const found = await discover()
  if (found) return found

  onStart?.()
  await run([cliPath(), "service", "start"])

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const started = await discover()
    if (started) return started
    await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS))
  }

  throw new Error(`The opencode background service did not become reachable (${stateDirectory()})`)
}

export async function restart() {
  await run([cliPath(), "service", "restart"])
  return resolve()
}

function run(command) {
  const [file, ...args] = command
  return new Promise((done, fail) => {
    execFile(file, args, { windowsHide: true, timeout: START_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) return done(stdout.trim())
      fail(new Error(`${command.join(" ")} failed: ${stderr.trim() || error.message}`))
    })
  })
}

function modificationTime(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}
