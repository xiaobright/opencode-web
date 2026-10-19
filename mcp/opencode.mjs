// HTTP client for the local opencode background service.
//
// Discovery and start/stop reuse the gateway's service module: the MCP server shares one
// background service with the TUI, the desktop app and the web UI. The service may be
// asleep (the web gateway stops it when idle), so every call resolves it first and a
// dropped connection gets one retry with a fresh discovery.

import { existsSync, statSync } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"
import { resolve } from "../src/service.mjs"
import { normalizeModel } from "../src/models.mjs"

export { normalizeModel }

const CONNECTION_TTL_MS = 5_000

let cached
let cachedAt = 0

export async function connection({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CONNECTION_TTL_MS) return cached

  const found = await resolve()
  cached = {
    url: found.url,
    authorization: `Basic ${Buffer.from(`opencode:${found.password}`).toString("base64")}`,
  }
  cachedAt = Date.now()
  return cached
}

function isConnectionError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return false
  return error instanceof TypeError || error?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED"
}

async function fetchOnce(target, path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const response = await fetch(target.url + path, {
    method,
    headers: {
      authorization: target.authorization,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const error = new Error(`${method} ${path} returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`)
    error.status = response.status
    throw error
  }

  if (response.status === 204) return undefined
  const type = response.headers.get("content-type") ?? ""
  return type.includes("application/json") ? response.json() : response.text()
}

export async function request(path, options = {}) {
  const first = await connection()
  try {
    return await fetchOnce(first, path, options)
  } catch (error) {
    if (!isConnectionError(error) || options.retry === false) throw error
    // The service was restarted or auto-slept between calls; resolve once more.
    return await fetchOnce(await connection({ force: true }), path, options)
  }
}

const sessionPath = (sessionID, suffix = "") => `/api/session/${encodeURIComponent(sessionID)}${suffix}`

export async function createSession({ title, directory, model, agent, permissions, metadata }) {
  const body = await request("/api/session", {
    method: "POST",
    body: {
      title,
      location: { directory },
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      ...(permissions ? { permissions } : {}),
      ...(metadata ? { metadata } : {}),
    },
  })
  return body.data
}

export async function prompt(sessionID, text, { delivery } = {}) {
  const body = await request(sessionPath(sessionID, "/prompt"), {
    method: "POST",
    body: { text, ...(delivery ? { delivery } : {}) },
  })
  return body.data
}

/** Newest first, like the endpoint itself. */
export async function messages(sessionID, limit = 100) {
  const body = await request(sessionPath(sessionID, `/message?limit=${limit}`))
  return Array.isArray(body?.data) ? body.data : []
}

export async function sessionInfo(sessionID) {
  const body = await request(sessionPath(sessionID))
  return body.data
}

/** One-line summary of a session diff, shared with the test fixture. */
export function summarizeDiff(files) {
  const list = Array.isArray(files) ? files : []
  const additions = list.reduce((sum, file) => sum + (Number(file.additions) || 0), 0)
  const deletions = list.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0)
  const names = list
    .slice(0, 3)
    .map((file) => String(file.file ?? "").replaceAll("\\", "/").split("/").pop())
    .filter(Boolean)
    .join(", ")
  return { count: list.length, additions, deletions, names }
}

/** Files this session changed so far, as a one-line summary for progress reports. */
export async function diff(sessionID) {
  const body = await request(sessionPath(sessionID, "/diff"))
  return summarizeDiff(Array.isArray(body?.data) ? body.data : [])
}

export async function activeSessions() {
  const body = await request("/api/session/active")
  return new Set(Object.keys(body?.data ?? {}))
}

export async function interrupt(sessionID) {
  return request(sessionPath(sessionID, "/interrupt"), { method: "POST" })
}

/** Resolves when the session agent loop is idle; never throws on timeout. */
export async function wait(sessionID, timeoutMs) {
  const started = Date.now()
  try {
    await request(`/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, {
      method: "POST",
      timeoutMs,
    })
    return { completed: true, waitedMs: Date.now() - started }
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError")
      return { completed: false, waitedMs: Date.now() - started }
    // A loop that has not registered yet cannot be awaited; treat it as still starting.
    if (error?.status === 503) return { completed: false, waitedMs: Date.now() - started }
    throw error
  }
}

export async function catalog() {
  const body = await request("/api/model")
  return Array.isArray(body?.data) ? body.data.map(normalizeModel) : []
}

export function normalizeDirectory(directory) {
  const text = String(directory ?? "").trim()
  if (!text) throw new Error("directory must not be empty")
  const absolute = isAbsolute(text) ? resolvePath(text) : resolvePath(process.cwd(), text)
  if (!existsSync(absolute)) throw new Error(`directory does not exist: ${absolute}`)
  if (!statSync(absolute).isDirectory()) throw new Error(`not a directory: ${absolute}`)
  return absolute
}
